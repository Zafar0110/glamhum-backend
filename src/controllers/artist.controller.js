// Artist-side onboarding: submitting the finished profile for admin review.
// (The dashboard endpoints — appointments, schedule, payments, messages —
// still live as stubs in routes/artist.routes.js.)

const { query, queryOne } = require('../config/db')
const env = require('../config/env')
const ApiError = require('../utils/ApiError')
const { success, paginated } = require('../utils/response')
const { serializeUser } = require('../utils/serializers')
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
 * Ends onboarding step 3. Moves the artist into the admin queue and emails
 * them a confirmation.
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

  // Sent back so the UI can say exactly what is missing rather than
  // "something went wrong".
  if (missing.length) {
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
    { user: serializeUser(updated), approvalStatus: 'pending', submittedAt: now },
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

  if (status === 'completed') {
    const paid = appointment.payment_status === 'paid'
    await query(
      `UPDATE appointments
          SET status = 'completed',
              artist_payout_status = CASE WHEN payment_status = 'paid' THEN 'released' ELSE artist_payout_status END
        WHERE id = ?`,
      [appointment.id]
    )

    if (paid && appointment.artist_payout_status !== 'released') {
      const { v4: uuid } = require('uuid')
      await query(
        `INSERT INTO transactions (id, artist_id, appointment_id, type, status, amount, currency, description)
         VALUES (?, ?, ?, 'payout', 'completed', ?, ?, ?)`,
        [
          uuid(),
          appointment.artist_id,
          appointment.id,
          appointment.artist_payout_amount || 0,
          appointment.currency,
          'Payout released for completed appointment',
        ]
      )
    }
  } else if (status === 'cancelled') {
    await query(
      `UPDATE appointments
          SET status = 'cancelled', cancelled_at = NOW(),
              cancellation_reason = ?,
              artist_payout_status = CASE WHEN payment_status = 'paid' THEN 'refunded' ELSE 'not_applicable' END
        WHERE id = ?`,
      [String(req.body?.cancellationReason || 'Cancelled by artist').trim(), appointment.id]
    )
  } else {
    await query('UPDATE appointments SET status = ? WHERE id = ?', [status, appointment.id])
  }

  const [updated] = await hydrateAppointments(
    await query('SELECT * FROM appointments WHERE id = ?', [appointment.id])
  )

  return success(res, { appointment: updated }, `Appointment ${status}`)
}
