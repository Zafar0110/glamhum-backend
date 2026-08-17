// Artist-side onboarding: submitting the finished profile for admin review.
// (The dashboard endpoints — appointments, schedule, payments, messages —
// still live as stubs in routes/artist.routes.js.)

const { query, queryOne } = require('../config/db')
const env = require('../config/env')
const ApiError = require('../utils/ApiError')
const { success, paginated } = require('../utils/response')
const { serializeUser, serializeReview } = require('../utils/serializers')
const { hydrateAppointments } = require('../services/appointments.service')
const mail = require('../services/mail.service')

/** What still has to be filled in before a profile can be reviewed. */
async function missingRequirements(artistId, user) {
  const missing = []

  if (!user.city || !String(user.city).trim()) missing.push('city')
  if (!user.description || !String(user.description).trim()) missing.push('description')
  if (user.has_studio && !(user.address || '').trim()) missing.push('address')

  const [{ services }] = await query(
    'SELECT COUNT(*) AS services FROM services WHERE artist_id = ? AND is_active = 1',
    [artistId]
  )
  if (!services) missing.push('services')

  const [{ images }] = await query(
    'SELECT COUNT(*) AS images FROM portfolio_images WHERE artist_id = ?',
    [artistId]
  )
  if (!images) missing.push('portfolio')

  return missing
}

/**
 * GET /api/artist/profile-status
 * Drives the onboarding success screen and the dashboard banner.
 */
exports.getProfileStatus = async (req, res) => {
  const user = req.user
  const missing = await missingRequirements(user.id, user)

  return success(res, {
    approvalStatus: user.approval_status || 'pending',
    submittedAt: user.submitted_at || null,
    approvedAt: user.approved_at || null,
    rejectionReason: user.rejection_reason || null,
    isComplete: missing.length === 0,
    missing,
  })
}

/**
 * POST /api/artist/submit-profile
 * Body: { allowIncomplete?: boolean }
 *
 * Ends onboarding. Moves the artist into the admin queue and emails them a
 * confirmation.
 *
 * "Continue" on step 3 sends nothing and is held to the full checklist, so the
 * artist is told exactly what is missing. "Skip This Step" / "Set Up Later"
 * send allowIncomplete, which still queues the account for review — an artist
 * who wants to be reviewed without services or portfolio images can be. The
 * admin sees what is missing in `missing` and decides.
 */
exports.submitProfile = async (req, res) => {
  const user = req.user

  if (user.approval_status === 'approved') {
    return success(
      res,
      { approvalStatus: 'approved', alreadyApproved: true },
      'Your profile is already approved'
    )
  }

  const missing = await missingRequirements(user.id, user)
  const allowIncomplete = Boolean(req.body && req.body.allowIncomplete)

  // Sent back so the UI can say exactly what is missing rather than
  // "something went wrong".
  if (missing.length && !allowIncomplete) {
    throw ApiError.validation(
      {
        city: missing.includes('city') ? 'Add the city you work in' : undefined,
        description: missing.includes('description') ? 'Add a short description about you' : undefined,
        address: missing.includes('address') ? 'Add your studio address' : undefined,
        services: missing.includes('services') ? 'Add at least one service' : undefined,
        portfolio: missing.includes('portfolio') ? 'Add at least one portfolio image' : undefined,
      },
      'Please finish your profile before submitting it for review'
    )
  }

  const now = new Date()
  await query(
    `UPDATE users
        SET approval_status = 'pending', submitted_at = ?, rejection_reason = NULL, updated_at = ?
      WHERE id = ?`,
    [now, now, user.id]
  )

  mail.sendArtistSubmittedEmail({ to: user.email, firstName: user.first_name })

  const updated = await queryOne('SELECT * FROM users WHERE id = ?', [user.id])
  return success(
    res,
    {
      user: serializeUser(updated),
      approvalStatus: 'pending',
      submittedAt: now,
      // Empty unless they skipped ahead; the status screen lists these.
      missing,
    },
    'Profile submitted for review'
  )
}

// ---------------------------------------------------------------------------
// Appointments (artist dashboard: "Upcoming Appointments" + Schedule)
// ---------------------------------------------------------------------------

/**
 * GET /api/artist/appointments
 * ?status &serviceType &startDate &endDate &page &limit
 */
exports.getAllAppointments = async (req, res) => {
  const { status, serviceType, startDate, endDate } = req.query
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100))
  const offset = (page - 1) * limit

  const where = ['a.artist_id = ?']
  const params = [req.user.id]

  if (status && status !== 'all') {
    where.push('a.status = ?')
    params.push(status)
  }
  if (startDate) {
    where.push('a.appointment_date >= ?')
    params.push(startDate)
  }
  if (endDate) {
    where.push('a.appointment_date <= ?')
    params.push(endDate)
  }
  // Filter by the type of service actually booked, not the artist's specialty.
  if (serviceType && serviceType !== 'all') {
    where.push(
      `EXISTS (SELECT 1 FROM appointment_services s
                WHERE s.appointment_id = a.id AND LOWER(s.service_type) = LOWER(?))`
    )
    params.push(serviceType)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`

  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM appointments a ${whereSql}`, params)

  const rows = await query(
    `SELECT a.* FROM appointments a ${whereSql}
      ORDER BY a.appointment_date ASC, a.start_time ASC
      LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )

  const appointments = await hydrateAppointments(rows)
  return paginated(res, { appointments }, { total, page, limit })
}

/**
 * GET /api/artist/appointments/:appointmentId
 * Everything the booking detail page shows: the appointment itself, the
 * payout breakdown, and the client's review once they have left one.
 */
exports.getAppointmentById = async (req, res) => {
  const row = await queryOne('SELECT * FROM appointments WHERE id = ? LIMIT 1', [
    req.params.appointmentId,
  ])

  if (!row) throw ApiError.notFound('Appointment not found')
  if (row.artist_id !== req.user.id) {
    throw ApiError.forbidden('This appointment belongs to another artist')
  }

  const [[appointment], reviewRow, transactions] = await Promise.all([
    hydrateAppointments([row]),
    queryOne(
      `SELECT r.*, u.first_name AS client_first_name, u.last_name AS client_last_name,
              u.avatar AS client_avatar
         FROM reviews r
         JOIN users u ON u.id = r.client_id
        WHERE r.appointment_id = ? LIMIT 1`,
      [row.id]
    ),
    query(
      'SELECT * FROM transactions WHERE appointment_id = ? ORDER BY created_at ASC',
      [row.id]
    ),
  ])

  const servicesTotal = Number(row.total_price) - Number(row.service_fee || 0)
  const { commissionFor } = require('./payments.controller')

  return success(res, {
    appointment,
    review: reviewRow ? serializeReview(reviewRow) : null,
    // Where the client's money went — the same figures the payout uses.
    payout: {
      currency: row.currency,
      servicesTotal,
      serviceFee: Number(row.service_fee || 0),
      commission: commissionFor(servicesTotal),
      artistEarning: row.artist_payout_amount === null ? null : Number(row.artist_payout_amount),
      total: Number(row.total_price),
      status: row.artist_payout_status,
      transferId: row.stripe_transfer_id || null,
    },
    transactions: transactions.map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      status: transaction.status,
      amount: Number(transaction.amount),
      currency: transaction.currency,
      description: transaction.description || '',
      createdAt: transaction.created_at,
    })),
  })
}

/**
 * GET /api/artist/reviews?rating=&sort=&startDate=&endDate=&page=&limit=
 *
 * Feedback clients left after their appointments completed.
 *
 * Sorting and date filtering happen here, over every review, rather than in the
 * browser over the page already fetched — sorting one page of six by "highest
 * rating" only reorders those six and hides the actual best reviews on page 2.
 */
const REVIEW_SORTS = {
  highest: 'r.rating DESC, r.created_at DESC',
  lowest: 'r.rating ASC, r.created_at DESC',
  newest: 'r.created_at DESC',
  oldest: 'r.created_at ASC',
}

exports.getArtistReviews = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10))
  const offset = (page - 1) * limit

  const where = ['r.artist_id = ?']
  const params = [req.user.id]

  const rating = parseInt(req.query.rating, 10)
  if (rating >= 1 && rating <= 5) {
    where.push('r.rating = ?')
    params.push(rating)
  }

  if (req.query.startDate) {
    where.push('r.created_at >= ?')
    params.push(`${req.query.startDate} 00:00:00`)
  }
  if (req.query.endDate) {
    where.push('r.created_at <= ?')
    params.push(`${req.query.endDate} 23:59:59`)
  }

  // Whitelisted: the value is interpolated into the query.
  const orderBy = REVIEW_SORTS[req.query.sort] || REVIEW_SORTS.newest

  const whereSql = `WHERE ${where.join(' AND ')}`

  // Count, page of rows and the rating breakdown together — the summary always
  // covers every review, not just the page being shown.
  const [[{ total }], rows, summary] = await Promise.all([
    query(`SELECT COUNT(*) AS total FROM reviews r ${whereSql}`, params),
    query(
      `SELECT r.*, u.first_name AS client_first_name, u.last_name AS client_last_name,
              u.avatar AS client_avatar,
              a.appointment_date, a.start_time
         FROM reviews r
         JOIN users u ON u.id = r.client_id
         LEFT JOIN appointments a ON a.id = r.appointment_id
         ${whereSql}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [...params, String(limit), String(offset)]
    ),
    queryOne(
      `SELECT COUNT(*) AS count, COALESCE(AVG(rating), 0) AS average,
              SUM(rating = 5) AS five, SUM(rating = 4) AS four, SUM(rating = 3) AS three,
              SUM(rating = 2) AS two, SUM(rating = 1) AS one
         FROM reviews WHERE artist_id = ?`,
      [req.user.id]
    ),
  ])

  const reviews = rows.map((row) => ({
    ...serializeReview(row),
    appointmentDate: row.appointment_date || null,
  }))

  return paginated(
    res,
    {
      reviews,
      summary: {
        total: Number(summary.count),
        averageRating: Math.round(Number(summary.average) * 10) / 10,
        breakdown: {
          5: Number(summary.five || 0),
          4: Number(summary.four || 0),
          3: Number(summary.three || 0),
          2: Number(summary.two || 0),
          1: Number(summary.one || 0),
        },
      },
    },
    { total, page, limit }
  )
}

const ALLOWED_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

/**
 * PATCH /api/artist/appointments/:appointmentId/status
 * Body: { status: 'confirmed' | 'completed' | 'cancelled' }
 *
 * Completing a paid appointment releases the artist's payout and writes the
 * matching transaction rows, so the Payments tab reflects reality.
 */
exports.updateAppointmentStatus = async (req, res) => {
  const { status } = req.body || {}
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = ? LIMIT 1', [
    req.params.appointmentId,
  ])

  if (!appointment) throw ApiError.notFound('Appointment not found')
  if (appointment.artist_id !== req.user.id) {
    throw ApiError.forbidden('This appointment belongs to another artist')
  }

  const allowed = ALLOWED_TRANSITIONS[appointment.status] || []
  if (!allowed.includes(status)) {
    throw ApiError.badRequest(
      `A ${appointment.status} appointment cannot be marked as ${status}.`
    )
  }

  let payoutNote = ''

  if (status === 'completed') {
    // Completing the job is what releases the escrow: the artist's share is
    // transferred to their connected Stripe account and the platform keeps the
    // service fee plus its commission. Done BEFORE the status flips so a Stripe
    // failure cannot leave a completed booking silently unpaid.
    const { releaseEscrow } = require('./payments.controller')
    const result = await releaseEscrow(appointment).catch((error) => {
      console.error('[escrow] release failed for', appointment.id, '-', error.message)
      return { released: false, reason: 'transfer_failed', error: error.message }
    })

    await query("UPDATE appointments SET status = 'completed' WHERE id = ?", [appointment.id])

    if (result.released) {
      payoutNote = ` ${appointment.currency} ${result.amount} released to your Stripe account (commission ${appointment.currency} ${result.commission}).`
    } else if (result.reason === 'artist_not_onboarded') {
      payoutNote = ' Your earnings are in your balance — finish payout setup to receive them.'
    } else if (result.reason === 'transfer_failed') {
      payoutNote = ' The payout could not be sent yet and will be retried.'
    }
  } else if (status === 'cancelled') {
    // The artist is declining, so the client keeps the whole amount — the
    // late-cancellation penalty only applies when the CLIENT pulls out. Refund
    // first: cancelling a paid booking without returning the money would leave
    // the client charged for a service nobody is going to perform.
    const { issueRefund } = require('./payments.controller')
    const refund = await issueRefund(appointment, {
      reason: String(req.body?.cancellationReason || 'Declined by artist').trim(),
    }).catch((error) => {
      console.error('[refund] failed for', appointment.id, '-', error.message)
      return { refunded: false, reason: 'refund_failed', error: error.message }
    })

    await query(
      `UPDATE appointments
          SET status = 'cancelled', cancelled_at = NOW(),
              cancellation_reason = ?,
              artist_payout_status = CASE WHEN payment_status = 'paid' THEN 'refunded' ELSE 'not_applicable' END
        WHERE id = ?`,
      [String(req.body?.cancellationReason || 'Cancelled by artist').trim(), appointment.id]
    )

    // A cancelled booking earns nothing, so the held deposit never settles.
    await query(
      "UPDATE transactions SET status = 'failed' WHERE appointment_id = ? AND type = 'deposit' AND status = 'pending'",
      [appointment.id]
    )

    if (refund.refunded) {
      payoutNote = ` ${appointment.currency} ${refund.amount} has been refunded to the client in full.`
    } else if (refund.reason === 'refund_failed') {
      payoutNote = ' The client refund could not be sent — please contact support.'
    }
  } else {
    await query('UPDATE appointments SET status = ? WHERE id = ?', [status, appointment.id])
  }

  const [updated] = await hydrateAppointments(
    await query('SELECT * FROM appointments WHERE id = ?', [appointment.id])
  )

  return success(res, { appointment: updated }, `Appointment ${status}.${payoutNote}`)
}
