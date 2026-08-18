 

const { v4: uuid } = require('uuid')
const env = require('../config/env')
const { query, queryOne } = require('../config/db') 
const ApiError = require('../utils/ApiError')
const { success, paginated } = require('../utils/response')
const stripe = require('../services/stripe.service')
const { checkSlot } = require('../services/availability.service')
const { parseAppointmentTime } = require('../services/appointments.service')

const { getServiceFee } = require('../services/settings.service')

//Platform commission on a booking, in major units
function commissionFor(amount) {
  return Math.round(Number(amount) * (env.stripe.commissionPercent / 100) * 100) / 100
}

//POST /api/client/payments/prepare
exports.preparePayment = async (req, res) => {
  if (!env.stripe.configured) {
    throw ApiError.badRequest('Online payment is not available yet. Please choose pay at venue.')
  }

  const { artistId, serviceIds } = req.body || {}
  if (!artistId) throw ApiError.validation({ artistId: 'Choose an artist' })
  if (!Array.isArray(serviceIds) || !serviceIds.length) {
    throw ApiError.validation({ serviceIds: 'Choose at least one service' })
  }

  const artist = await queryOne(
    "SELECT * FROM users WHERE id = ? AND role = 'artist' AND approval_status = 'approved' AND is_active = 1 LIMIT 1",
    [artistId]
  )
  if (!artist) throw ApiError.notFound('This artist is not available for bookings')

  const placeholders = serviceIds.map(() => '?').join(',')
  const services = await query(
    `SELECT * FROM services WHERE id IN (${placeholders}) AND artist_id = ? AND is_active = 1`,
    [...serviceIds, artistId]
  )
  if (services.length !== serviceIds.length) {
    throw ApiError.validation({ serviceIds: 'One or more of those services is no longer offered' })
  }

  const servicesTotal = services.reduce((sum, service) => sum + Number(service.price), 0)
   
  const serviceFee = await getServiceFee()
  const total = servicesTotal + serviceFee
  const currency = artist.currency || 'AED'

   
  if (req.body.appointmentDate) {
    const totalMinutes =
      services.reduce((sum, service) => sum + (Number(service.duration_minutes) || 60), 0) || 60
    const { startTime, endTime } = parseAppointmentTime(req.body.appointmentTime, totalMinutes)

    const slot = await checkSlot(artistId, req.body.appointmentDate, startTime, endTime)
    if (!slot.available) throw ApiError.conflict(slot.reason)
  }

   
  const intent = await stripe.createPaymentIntent({
    amount: total,
    currency,
    metadata: {
      clientId: req.user.id,
      artistId,
      serviceIds: serviceIds.join(','),
    },
  })

  return success(res, {
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    amount: total,
    currency,
    publishableKey: env.stripe.publishableKey,
  })
}

//POST /api/client/payments/prepare-booking


exports.prepareBookingPayment = async (req, res) => {
  if (!env.stripe.configured) {
    throw ApiError.badRequest('Online payment is not available yet. Please pay at the venue.')
  }

  const { appointmentId } = req.body || {}
  if (!appointmentId) throw ApiError.validation({ appointmentId: 'Booking is required' })

  const appointment = await queryOne('SELECT * FROM appointments WHERE id = ? LIMIT 1', [appointmentId])
  if (!appointment) throw ApiError.notFound('Booking not found')
  if (appointment.client_id !== req.user.id) throw ApiError.forbidden('This booking is not yours')
  if (appointment.payment_status === 'paid') throw ApiError.badRequest('This booking is already paid')
  if (appointment.payment_status === 'refunded') {
    throw ApiError.badRequest('This booking has been refunded and cannot be paid again')
  }
  if (appointment.status === 'cancelled') throw ApiError.badRequest('This booking was cancelled')
  if (appointment.status === 'completed') {
    throw ApiError.badRequest('This appointment is already finished — settle it with your artist directly')
  }

  const amount = Number(appointment.total_price)
  if (amount <= 0) throw ApiError.badRequest('There is nothing to pay on this booking')

   
  const intent = await stripe.createPaymentIntent({
    amount,
    currency: appointment.currency || 'AED',
    metadata: {
      clientId: req.user.id,
      artistId: appointment.artist_id,
      appointmentId: appointment.id,
    },
  })

  return success(res, {
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    amount,
    currency: appointment.currency || 'AED',
    publishableKey: env.stripe.publishableKey,
  })
}

//POST /api/client/payments/confirm

exports.confirmPayment = async (req, res) => {
  const { paymentIntentId } = req.body || {}
  if (!paymentIntentId) throw ApiError.validation({ paymentIntentId: 'Payment reference is required' })

  const intent = await stripe.retrievePaymentIntent(paymentIntentId)
  if (intent.status !== 'succeeded') {
    throw ApiError.badRequest(`Payment has not completed (status: ${intent.status})`)
  }

  // The booking is created by the client controller, which owns that logic.
  const { createPaidBooking } = require('./client.controller')
  const booking = await createPaidBooking(req, {
    paymentIntentId, 
    chargeId: intent.latest_charge || null,
    amountPaid: stripe.fromMinorUnits(intent.amount_received || intent.amount, intent.currency),
  })

  return success(res, { booking, appointment: booking }, 'Payment received and booking confirmed', 201)
}

//POST /api/client/payments/process

exports.processPayment = async (req, res) => {
  const { appointmentId, paymentIntentId } = req.body || {}
  if (!appointmentId) throw ApiError.validation({ appointmentId: 'Booking is required' })
  if (!paymentIntentId) throw ApiError.validation({ paymentIntentId: 'Payment reference is required' })

  const appointment = await queryOne('SELECT * FROM appointments WHERE id = ? LIMIT 1', [appointmentId])
  if (!appointment) throw ApiError.notFound('Booking not found')
  if (appointment.client_id !== req.user.id) throw ApiError.forbidden('This booking is not yours')
  if (appointment.payment_status === 'paid') throw ApiError.badRequest('This booking is already paid')

  const intent = await stripe.retrievePaymentIntent(paymentIntentId)
  if (intent.status !== 'succeeded') {
    throw ApiError.badRequest(`Payment has not completed (status: ${intent.status})`)
  }

   
  const servicesTotal = Number(appointment.total_price) - Number(appointment.service_fee || 0)
  const payout = servicesTotal - commissionFor(servicesTotal)

  await query(
    `UPDATE appointments
        SET payment_status = 'paid', payment_method = 'pay_now', payment_intent_id = ?,
            stripe_charge_id = ?, artist_payout_status = 'pending', artist_payout_amount = ?
      WHERE id = ?`,
    [paymentIntentId, intent.latest_charge || null, payout, appointment.id]
  )

  await recordTransaction({
    artistId: appointment.artist_id,
    clientId: appointment.client_id,
    appointmentId: appointment.id,
    type: 'deposit', 
    status: 'pending',
    amount: payout,
    currency: appointment.currency,
    description: `Payment for appointment ${appointment.id}`,
    reference: paymentIntentId,
  })

  return success(res, {}, 'Payment processed successfully')
}

//GET /api/client/payments/:paymentIntentId/status
exports.getPaymentIntentStatus = async (req, res) => {
  const intent = await stripe.retrievePaymentIntent(req.params.paymentIntentId)
  return success(res, {
    status: intent.status,
    paymentIntentId: intent.id,
    amount: stripe.fromMinorUnits(intent.amount, intent.currency),
    currency: String(intent.currency).toUpperCase(),
  })
}

//POST /api/client/payments/refund

exports.refundPayment = async (req, res) => {
  const { appointmentId, reason } = req.body || {}
  if (!appointmentId) throw ApiError.validation({ appointmentId: 'Booking is required' })

  const appointment = await queryOne('SELECT * FROM appointments WHERE id = ? LIMIT 1', [appointmentId])
  if (!appointment) throw ApiError.notFound('Booking not found')
  if (appointment.client_id !== req.user.id) throw ApiError.forbidden('This booking is not yours')
  if (appointment.payment_status !== 'paid') throw ApiError.badRequest('There is no payment to refund')
  if (!appointment.payment_intent_id) throw ApiError.badRequest('No payment reference on this booking')

  // Hours until the appointment decides how much comes back.
  const startsAt = new Date(`${appointment.appointment_date}T${appointment.start_time}`)
  const hoursUntil = (startsAt.getTime() - Date.now()) / 36e5
  const isLate = hoursUntil < env.stripe.cancellationCutoffHours

  const refundPercent = isLate ? env.stripe.lateCancellationRefundPercent : 100
  const refundAmount = Math.round(Number(appointment.total_price) * (refundPercent / 100) * 100) / 100

  if (refundAmount <= 0) {
    return success(
      res,
      { refundAmount: 0, refundPercent: 0, currency: appointment.currency },
      `Cancelled within ${env.stripe.cancellationCutoffHours} hours of the appointment — no refund is due.`
    )
  }

  await issueRefund(appointment, { amount: refundAmount, reason })

  return success(
    res,
    { refundAmount, refundPercent, currency: appointment.currency },
    `Refunded ${refundAmount} ${appointment.currency}`
  )
}

 
async function issueRefund(appointment, { amount, reason } = {}) {
  if (appointment.payment_status !== 'paid' || !appointment.payment_intent_id) {
    return { refunded: false, reason: 'nothing_to_refund' }
  }

  const refundAmount = amount === undefined ? Number(appointment.total_price) : Number(amount)
  if (refundAmount <= 0) return { refunded: false, reason: 'nothing_to_refund' } 
  if (appointment.stripe_transfer_id) {
    await stripe.reverseTransfer(appointment.stripe_transfer_id, undefined, appointment.currency)
    await query(
      "UPDATE transactions SET status = 'failed' WHERE appointment_id = ? AND type = 'payout'",
      [appointment.id]
    )
  }

  const refund = await stripe.createRefund({
    paymentIntentId: appointment.payment_intent_id,
    amount: refundAmount,
    currency: appointment.currency,
    reason: 'requested_by_customer',
  })

  await query(
    `UPDATE appointments
        SET payment_status = 'refunded', artist_payout_status = 'refunded'
      WHERE id = ?`,
    [appointment.id]
  )

  // The artist earned nothing on a refunded booking.
  await query(
    "UPDATE transactions SET status = 'failed' WHERE appointment_id = ? AND type = 'deposit'",
    [appointment.id]
  )

  await recordTransaction({
    artistId: appointment.artist_id,
    clientId: appointment.client_id,
    appointmentId: appointment.id,
    type: 'refund',
    status: 'succeeded',
    amount: refundAmount,
    currency: appointment.currency,
    description: `Refund for appointment ${appointment.id}. Reason: ${reason || 'Not provided'}`,
    reference: refund.id,
  })

  return { refunded: true, amount: refundAmount, refundId: refund.id }
}


//One ledger row
exports.issueRefund = issueRefund

 
async function recordTransaction({ artistId, clientId, appointmentId, type, status, amount, currency, description, reference, bankDetails }) {
  await query(
    `INSERT INTO transactions
       (id, artist_id, client_id, appointment_id, type, status, amount, currency, description, reference, bank_details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid(),
      artistId,
      clientId || null,
      appointmentId || null,
      type,
      status,
      amount,
      currency || 'AED',
      description || null,
      reference || null,
      bankDetails ? JSON.stringify(bankDetails) : null,
    ]
  )
}

//GET /api/artist/payments/stats
exports.getPaymentStats = async (req, res) => {
  const { period } = req.query
  const since =
    period === 'week'
      ? 'AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
      : period === 'month'
        ? 'AND created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)'
        : ''

  // One round trip for every figure on the page.
  const totals = await queryOne(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'deposit'    AND status = 'succeeded' THEN amount END), 0) AS earned,
       COALESCE(SUM(CASE WHEN type = 'deposit'    AND status = 'pending'   THEN amount END), 0) AS held,
       COALESCE(SUM(CASE WHEN type = 'withdrawal' AND status = 'succeeded' THEN amount END), 0) AS withdrawn,
       COALESCE(SUM(CASE WHEN type = 'withdrawal' AND status IN ('in_transit','pending') THEN amount END), 0) AS withdrawalsInTransit,
       COALESCE(SUM(CASE WHEN type = 'payout'     AND status IN ('succeeded','completed','in_transit','pending') THEN amount END), 0) AS paidOut,
       COALESCE(SUM(CASE WHEN type = 'payout'     AND status IN ('in_transit','pending') THEN amount END), 0) AS payoutsInTransit,
       COALESCE(SUM(CASE WHEN type = 'refund'     AND status = 'succeeded' THEN amount END), 0) AS refunded
     FROM transactions
     WHERE artist_id = ? ${since}`,
    [req.user.id]
  )

  const earned = Number(totals.earned)
  const withdrawn = Number(totals.withdrawn)
  const paidOut = Number(totals.paidOut)
  const withdrawalsInTransit = Number(totals.withdrawalsInTransit) 
  const inTransit = withdrawalsInTransit + Number(totals.payoutsInTransit)
  const round = (value) => Math.round(value * 100) / 100

  return success(res, { 
    availableBalance: round(Math.max(0, earned - paidOut - withdrawn - withdrawalsInTransit)),
    totalEarned: round(earned),
    heldInEscrow: round(Number(totals.held)),
    payoutsInTransit: round(inTransit),
    totalWithdrawal: round(withdrawn + paidOut),
    totalRefunded: round(Number(totals.refunded)),
    currency: 'AED',
    growthPercentage: 0,
  })
}

/** GET /api/artist/payments/transactions */
exports.getAllTransactions = async (req, res) => {
  const { type, status, startDate, endDate } = req.query
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
  const offset = (page - 1) * limit

  const where = ['t.artist_id = ?']
  const params = [req.user.id]

  if (type && type !== 'all') {
    where.push('t.type = ?')
    params.push(type)
  }
  if (status && status !== 'all') {
    where.push('t.status = ?')
    params.push(status)
  }
  if (startDate) {
    where.push('t.created_at >= ?')
    params.push(startDate)
  }
  if (endDate) { 
    where.push('DATE(t.created_at) <= ?')
    params.push(endDate)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM transactions t ${whereSql}`, params)

  const rows = await query(
    `SELECT t.*, u.first_name, u.last_name, u.avatar
       FROM transactions t
       LEFT JOIN users u ON u.id = t.client_id
       ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )

  const transactions = rows.map((row) => ({
    _id: row.id,
    id: row.id,
    // The tab reads `date`, not createdAt.
    date: row.created_at,
    createdAt: row.created_at,
    type: row.type,
    status: row.status,
    amount: Number(row.amount),
    currency: row.currency,
    description: row.description || '',
    reference: row.reference,
    client: row.first_name
      ? {
          fullName: [row.first_name, row.last_name].filter(Boolean).join(' '),
          firstName: row.first_name,
          lastName: row.last_name,
        }
      : undefined,
  }))

  const totals = await queryOne(
    `SELECT
       COALESCE(SUM(CASE WHEN type='deposit'    AND status='succeeded' THEN amount END),0) AS earned,
       COALESCE(SUM(CASE WHEN type='withdrawal' AND status='succeeded' THEN amount END),0) AS withdrawn
     FROM transactions WHERE artist_id = ?`,
    [req.user.id]
  )

  return paginated(
    res,
    {
      transactions,
      totalEarned: Number(totals.earned),
      totalWithdrawal: Number(totals.withdrawn),
      totalPayout: Number(totals.withdrawn),
    },
    { total, page, limit }
  )
}

/** POST /api/artist/payments/withdrawals */
exports.requestWithdrawal = async (req, res) => {
  const { amount, bankDetails, description } = req.body || {}
  const value = Number(amount)

  if (!value || value <= 0) throw ApiError.validation({ amount: 'Enter a valid withdrawal amount' }) 
  const totals = await queryOne(
    `SELECT
       COALESCE(SUM(CASE WHEN type='deposit'    AND status='succeeded' THEN amount END),0) AS earned,
       COALESCE(SUM(CASE WHEN type='withdrawal' AND status IN ('succeeded','in_transit','pending') THEN amount END),0) AS withdrawn,
       COALESCE(SUM(CASE WHEN type='payout'     AND status IN ('succeeded','completed','in_transit','pending') THEN amount END),0) AS paidOut
     FROM transactions WHERE artist_id = ?`,
    [req.user.id]
  )

  const available =
    Math.round((Number(totals.earned) - Number(totals.withdrawn) - Number(totals.paidOut)) * 100) / 100

  if (value > available) {
    throw ApiError.validation({
      amount: `Insufficient balance. You can withdraw up to ${available} AED.`,
    })
  }

  await recordTransaction({
    artistId: req.user.id,
    type: 'withdrawal', 
    status: 'in_transit',
    amount: value,
    currency: 'AED',
    description: description || 'Withdrawal request to bank account',
    bankDetails,
  })

  return success(res, { amount: value, available: available - value }, 'Withdrawal request submitted successfully')
}

exports.recordTransaction = recordTransaction
exports.commissionFor = commissionFor
exports.getServiceFee = getServiceFee
 
//GET /api/artist/stripe/status
exports.getStripeConnectStatus = async (req, res) => {
  if (!env.stripe.configured) {
    return success(res, {
      stripeConfigured: false,
      hasConnectAccount: false,
      onboardingComplete: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsDue: [],
      message: 'Online payments are not switched on yet.',
    })
  }

  const row = await queryOne('SELECT * FROM stripe_accounts WHERE artist_id = ? LIMIT 1', [req.user.id])

  if (!row) {
    return success(res, {
      stripeConfigured: true,
      hasConnectAccount: false,
      onboardingComplete: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsDue: [],
      message: 'Connect a payout account to accept online payments.',
    })
  }
 
  try {
    const account = await stripe.retrieveAccount(row.stripe_account_id)
    const requirementsDue = account.requirements?.currently_due || []
    const transfersEnabled = account.capabilities?.transfers === 'active'
    const onboardingComplete = Boolean(account.details_submitted && account.payouts_enabled)

    await query(
      `UPDATE stripe_accounts
          SET charges_enabled = ?, payouts_enabled = ?, transfers_enabled = ?,
              onboarding_complete = ?, requirements_due = ?
        WHERE artist_id = ?`,
      [
        account.charges_enabled ? 1 : 0,
        account.payouts_enabled ? 1 : 0,
        transfersEnabled ? 1 : 0,
        onboardingComplete ? 1 : 0,
        JSON.stringify(requirementsDue),
        req.user.id,
      ]
    )

    return success(res, {
      stripeConfigured: true,
      hasConnectAccount: true,
      onboardingComplete, 
      chargesEnabled: Boolean(account.charges_enabled || transfersEnabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      transfersEnabled,
      requirementsDue,
      accountId: row.stripe_account_id,
      message: onboardingComplete ? '' : 'Finish your payout setup to receive online payments.',
    })
  } catch (error) {
    console.error('[stripe] could not read connected account:', error.message)
     
    return success(res, {
      stripeConfigured: true,
      hasConnectAccount: true,
      onboardingComplete: Boolean(row.onboarding_complete),
      chargesEnabled: Boolean(row.charges_enabled),
      payoutsEnabled: Boolean(row.payouts_enabled),
      requirementsDue: [],
      accountId: row.stripe_account_id,
      message: 'Could not reach Stripe just now; showing the last known status.',
    })
  }
}

//POST /api/artist/stripe/connect-link
exports.createStripeConnectLink = async (req, res) => {
  if (!env.stripe.configured) {
    throw ApiError.badRequest('Online payments are not switched on yet.')
  }

  const { returnUrl, refreshUrl } = req.body || {}
  if (!returnUrl || !refreshUrl) {
    throw ApiError.validation({ returnUrl: 'returnUrl and refreshUrl are required' })
  }

  let row = await queryOne('SELECT * FROM stripe_accounts WHERE artist_id = ? LIMIT 1', [req.user.id])

  if (!row) {
    const account = await stripe.createConnectAccount({ email: req.user.email })
    await query(
      `INSERT INTO stripe_accounts (id, artist_id, stripe_account_id, requirements_due)
       VALUES (?, ?, ?, ?)`,
      [uuid(), req.user.id, account.id, JSON.stringify(account.requirements?.currently_due || [])]
    )
    row = { stripe_account_id: account.id }
  }

  const link = await stripe.createAccountLink({
    accountId: row.stripe_account_id,
    returnUrl,
    refreshUrl,
  })

  return success(res, { url: link.url, accountId: row.stripe_account_id }, 'Continue on Stripe to finish setup')
}

//GET /api/artist/stripe/dashboard-link
exports.getStripeDashboardLink = async (req, res) => {
  const row = await queryOne('SELECT * FROM stripe_accounts WHERE artist_id = ? LIMIT 1', [req.user.id])
  if (!row) throw ApiError.badRequest('Connect a payout account first')

  const link = await stripe.createLoginLink(row.stripe_account_id)
  return success(res, { url: link.url })
}
 
async function releaseEscrow(appointment) {
  // Nothing to release for cash-at-venue bookings.
  if (appointment.payment_status !== 'paid') {
    return { released: false, reason: 'not_paid' }
  }
  if (appointment.artist_payout_status === 'released' || appointment.stripe_transfer_id) {
    return { released: false, reason: 'already_released' }
  }

  const payout = Number(appointment.artist_payout_amount || 0)
  if (payout <= 0) return { released: false, reason: 'nothing_to_pay' }

   const commission = commissionFor(Number(appointment.total_price) - Number(appointment.service_fee || 0))

  const connect = await queryOne(
    'SELECT stripe_account_id, transfers_enabled, payouts_enabled FROM stripe_accounts WHERE artist_id = ? LIMIT 1',
    [appointment.artist_id]
  )

  // No connected account yet: the job is still done and earned, so unlock the
   
  if (!connect || !(connect.transfers_enabled || connect.payouts_enabled)) {
    await settleDeposit(appointment.id)
    await query(
      "UPDATE appointments SET artist_payout_status = 'pending' WHERE id = ?",
      [appointment.id]
    )
    return { released: false, reason: 'artist_not_onboarded', amount: payout, commission }
  }

  const transfer = await stripe.createTransfer({
    amount: payout,
    currency: appointment.currency || 'AED',
    destination: connect.stripe_account_id, 
    sourceTransaction: appointment.stripe_charge_id || undefined,
    metadata: { appointmentId: appointment.id, artistId: appointment.artist_id }, 
    idempotencyKey: `payout_${appointment.id}`,
  })

  await query(
    `UPDATE appointments
        SET artist_payout_status = 'released', stripe_transfer_id = ?
      WHERE id = ?`,
    [transfer.id, appointment.id]
  )

   
  await settleDeposit(appointment.id) 
  await recordTransaction({
    artistId: appointment.artist_id,
    clientId: appointment.client_id,
    appointmentId: appointment.id,
    type: 'payout',
    status: 'in_transit',
    amount: payout,
    currency: appointment.currency || 'AED',
    description: `Payout released for completed appointment ${appointment.id}`,
    reference: transfer.id,
  })

  return { released: true, transferId: transfer.id, amount: payout, commission }
}

 
async function settleDeposit(appointmentId) {
  await query(
    "UPDATE transactions SET status = 'succeeded' WHERE appointment_id = ? AND type = 'deposit' AND status = 'pending'",
    [appointmentId]
  )
}

exports.releaseEscrow = releaseEscrow
