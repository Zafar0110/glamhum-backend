// Client side: creating a booking and managing it afterwards.

const { v4: uuid } = require('uuid')
const env = require('../config/env')
const { query, queryOne, transaction } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success, paginated } = require('../utils/response')
const { serializeReview } = require('../utils/serializers')
const {
  parseAppointmentTime,
  durationToMinutes,
  hydrateAppointments,
} = require('../services/appointments.service')
const { checkSlot } = require('../services/availability.service')

const SERVICE_FEE = 150 // matches SERVICE_FEE on the booking screen

/** Validate the payload and load the artist + services it refers to. */
async function resolveBooking(body, clientId) {
  const errors = {}

  if (!body.artistId) errors.artistId = 'Choose an artist'
  if (!Array.isArray(body.serviceIds) || body.serviceIds.length === 0) {
    errors.serviceIds = 'Choose at least one service'
  }
  if (!body.appointmentDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.appointmentDate)) {
    errors.appointmentDate = 'Choose a valid event date'
  }

  const venue = body.venue === 'artist_studio' ? 'artist_studio' : 'venue'
  const details = body.venueDetails || {}

  if (venue === 'venue') {
    if (!String(details.street || '').trim()) errors['venueDetails.street'] = 'Enter the venue street and number'
    if (!String(details.city || '').trim()) errors['venueDetails.city'] = 'Enter the venue city and state'
  }

  if (Object.keys(errors).length) throw ApiError.validation(errors)

  // The date must not be in the past (compare as plain dates, no timezone drift).
  const today = new Date().toISOString().slice(0, 10)
  if (body.appointmentDate < today) {
    throw ApiError.validation({ appointmentDate: 'Pick a date in the future' })
  }

  const artist = await queryOne(
    "SELECT * FROM users WHERE id = ? AND role = 'artist' AND approval_status = 'approved' AND is_active = 1 LIMIT 1",
    [body.artistId]
  )
  if (!artist) throw ApiError.notFound('This artist is not available for bookings')

  const placeholders = body.serviceIds.map(() => '?').join(',')
  const services = await query(
    `SELECT * FROM services WHERE id IN (${placeholders}) AND artist_id = ? AND is_active = 1`,
    [...body.serviceIds, artist.id]
  )

  if (services.length !== body.serviceIds.length) {
    throw ApiError.validation({
      serviceIds: 'One or more of those services is no longer offered by this artist',
    })
  }

  // The artist must actually be free then. One shared check covers existing
  // appointments, time the artist has blocked out, and holidays — the same one
  // the artist's own schedule uses, so the two cannot disagree.
  const totalMinutes = services.reduce((sum, s) => sum + (s.duration_minutes || durationToMinutes(s.duration) || 60), 0)
  const { startTime, endTime } = parseAppointmentTime(body.appointmentTime, totalMinutes)

  const slot = await checkSlot(artist.id, body.appointmentDate, startTime, endTime)
  if (!slot.available) throw ApiError.conflict(slot.reason)

  const servicesTotal = services.reduce((sum, s) => sum + Number(s.price), 0)

  return {
    artist,
    services,
    venue,
    details,
    appointmentDate: body.appointmentDate,
    startTime,
    endTime,
    totalMinutes,
    servicesTotal,
    total: servicesTotal + SERVICE_FEE,
    clientId,
  }
}

/** Insert the appointment and its line items in one transaction. */
async function createAppointment(resolved, { paymentMethod, paid, paymentIntentId = null, chargeId = null, notes }) {
  const id = uuid()
  const commission = env.stripe.commissionPercent / 100
  const payoutAmount = paid ? Math.round(resolved.servicesTotal * (1 - commission) * 100) / 100 : null

  await transaction(async (connection) => {
    await connection.execute(
      `INSERT INTO appointments
         (id, client_id, artist_id, appointment_date, start_time, end_time, duration_minutes,
          venue, venue_name, venue_street, venue_city, venue_state,
          status, currency, total_price, service_fee, payment_method, payment_status,
          payment_intent_id, stripe_charge_id, artist_payout_status, artist_payout_amount, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        resolved.clientId,
        resolved.artist.id,
        resolved.appointmentDate,
        resolved.startTime,
        resolved.endTime,
        resolved.totalMinutes,
        resolved.venue,
        resolved.details.venueName || null,
        resolved.details.street || null,
        resolved.details.city || null,
        resolved.details.state || null,
        // Every booking waits for the artist, paid or not. Paying reserves the
        // money in escrow; it does not commit the artist's time for them.
        'pending',
        resolved.artist.currency || 'AED',
        resolved.total,
        SERVICE_FEE,
        paymentMethod,
        paid ? 'paid' : 'unpaid',
        paymentIntentId,
        chargeId,
        paid ? 'pending' : 'not_applicable',
        payoutAmount,
        notes || null,
      ]
    )

    for (const service of resolved.services) {
      await connection.execute(
        `INSERT INTO appointment_services (id, appointment_id, service_id, service_name, service_type, price)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuid(), id, service.id, service.service_name, service.service_type, service.price]
      )
    }
  })

  return id
}

/** POST /api/client/bookings */
exports.createBooking = async (req, res) => {
  const resolved = await resolveBooking(req.body, req.user.id)

  const payNow = req.body.paymentMethod === 'pay_now'
  if (payNow && !env.stripe.configured) {
    throw ApiError.badRequest('Online payment is not available yet. Please choose pay at venue.')
  }

  const id = await createAppointment(resolved, {
    paymentMethod: payNow ? 'pay_now' : 'pay_at_venue',
    paid: false,
    notes: req.body.notes,
  })

  const [booking] = await hydrateAppointments(
    await query('SELECT * FROM appointments WHERE id = ?', [id])
  )

  return success(res, { booking, appointment: booking }, 'Booking confirmed', 201)
}

/**
 * Create a booking that has already been paid for.
 * Called by payments.confirmPayment once Stripe has confirmed the charge, so
 * no appointment exists until the money is actually taken.
 */
exports.createPaidBooking = async (req, { paymentIntentId, chargeId = null }) => {
  const resolved = await resolveBooking(req.body, req.user.id)

  const id = await createAppointment(resolved, {
    paymentMethod: 'pay_now',
    paid: true,
    paymentIntentId,
    // The charge the escrow payout will later be drawn from.
    chargeId,
    notes: req.body.notes,
  })

  const [booking] = await hydrateAppointments(
    await query('SELECT * FROM appointments WHERE id = ?', [id])
  )

  // Ledger entry so the artist's Payments tab reflects the earning.
  const { recordTransaction, commissionFor } = require('./payments.controller')
  const payout = resolved.servicesTotal - commissionFor(resolved.servicesTotal)

  await recordTransaction({
    artistId: resolved.artist.id,
    clientId: req.user.id,
    appointmentId: id,
    type: 'deposit',
    // Held in escrow until the artist completes the appointment.
    status: 'pending',
    amount: payout,
    currency: resolved.artist.currency || 'AED',
    description: `Payment for appointment ${id}`,
    reference: paymentIntentId,
  })

  return booking
}

/** GET /api/client/bookings?status=all|pending|confirmed|cancelled|completed */
exports.getMyBookings = async (req, res) => {
  const status = req.query.status
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10))
  const offset = (page - 1) * limit

  const where = ['client_id = ?']
  const params = [req.user.id]

  if (status && status !== 'all') {
    where.push('status = ?')
    params.push(status)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM appointments ${whereSql}`, params)

  const rows = await query(
    `SELECT * FROM appointments ${whereSql}
      ORDER BY appointment_date DESC, start_time DESC LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )

  const bookings = await hydrateAppointments(rows)
  const pages = Math.max(1, Math.ceil(total / limit))

  return paginated(res, { bookings, pagination: { totalPages: pages } }, { total, page, limit })
}

/** GET /api/client/bookings/artist/:artistId */
exports.getMyBookingsByArtist = async (req, res) => {
  const where = ['client_id = ?', 'artist_id = ?']
  const params = [req.user.id, req.params.artistId]

  if (req.query.status && req.query.status !== 'all') {
    where.push('status = ?')
    params.push(req.query.status)
  }

  const rows = await query(
    `SELECT * FROM appointments WHERE ${where.join(' AND ')} ORDER BY appointment_date DESC`,
    params
  )

  const bookings = await hydrateAppointments(rows)
  return success(res, { bookings }, 'OK', 200, { total: bookings.length })
}

/** PATCH /api/client/bookings/:bookingId/cancel */
exports.cancelBooking = async (req, res) => {
  const booking = await queryOne('SELECT * FROM appointments WHERE id = ? LIMIT 1', [
    req.params.bookingId,
  ])
  if (!booking) throw ApiError.notFound('Booking not found')
  if (booking.client_id !== req.user.id) throw ApiError.forbidden('This booking is not yours')

  if (booking.status === 'cancelled') throw ApiError.badRequest('This booking is already cancelled')
  if (booking.status === 'completed') throw ApiError.badRequest('A completed booking cannot be cancelled')

  const reason = String(req.body?.cancellationReason || 'Cancelled by client').trim()

  await query(
    `UPDATE appointments
        SET status = 'cancelled', cancellation_reason = ?, cancelled_at = NOW(),
            artist_payout_status = CASE WHEN payment_status = 'paid' THEN 'refunded' ELSE 'not_applicable' END
      WHERE id = ?`,
    [reason, booking.id]
  )

  // A cancelled booking earns nothing, so the held deposit never settles.
  await query(
    "UPDATE transactions SET status = 'failed' WHERE appointment_id = ? AND type = 'deposit' AND status = 'pending'",
    [booking.id]
  )

  const [updated] = await hydrateAppointments(
    await query('SELECT * FROM appointments WHERE id = ?', [booking.id])
  )

  return success(res, { booking: updated, appointment: updated }, 'Booking cancelled')
}

// ---------------------------------------------------------------------------
// Reviews (artist profile page + the client's Reviews tab)
// ---------------------------------------------------------------------------

const CATEGORY_KEYS = ['professionalism', 'communication', 'punctuality', 'value']

function validateReview(body) {
  const errors = {}
  const rating = Number(body.rating)

  if (!rating || rating < 1 || rating > 5) errors.rating = 'Give an overall rating from 1 to 5'

  const categories = body.categories || {}
  for (const key of CATEGORY_KEYS) {
    const value = Number(categories[key])
    if (!value || value < 1 || value > 5) errors[key] = `Rate ${key} from 1 to 5`
  }

  if (!String(body.comment || '').trim()) errors.comment = 'Write a few words about your experience'

  if (Object.keys(errors).length) throw ApiError.validation(errors)

  return {
    rating,
    professionalism: Number(categories.professionalism),
    communication: Number(categories.communication),
    punctuality: Number(categories.punctuality),
    value: Number(categories.value),
    comment: String(body.comment).trim(),
  }
}

/**
 * Keep users.rating / total_reviews in step with the reviews table, so the
 * directory and cards never have to aggregate on read.
 */
async function refreshArtistRating(artistId) {
  await query(
    `UPDATE users u
        SET u.rating = COALESCE((SELECT AVG(rating) FROM reviews WHERE artist_id = ?), 0),
            u.total_reviews = (SELECT COUNT(*) FROM reviews WHERE artist_id = ?)
      WHERE u.id = ?`,
    [artistId, artistId, artistId]
  )
}

/** POST /api/client/reviews */
exports.createReview = async (req, res) => {
  const data = validateReview(req.body)

  if (!req.body.appointmentId) {
    throw ApiError.validation({ appointmentId: 'Choose which booking you are reviewing' })
  }

  const appointment = await queryOne('SELECT * FROM appointments WHERE id = ? LIMIT 1', [
    req.body.appointmentId,
  ])

  if (!appointment) throw ApiError.notFound('Booking not found')
  if (appointment.client_id !== req.user.id) throw ApiError.forbidden('That booking is not yours')
  if (appointment.status !== 'completed') {
    throw ApiError.badRequest('You can review a booking once it has been completed')
  }

  const existing = await queryOne('SELECT id FROM reviews WHERE appointment_id = ? LIMIT 1', [
    appointment.id,
  ])
  if (existing) throw ApiError.conflict('You have already reviewed this booking')

  const id = uuid()
  await query(
    `INSERT INTO reviews
       (id, appointment_id, client_id, artist_id, rating,
        professionalism, communication, punctuality, value_rating, comment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      appointment.id,
      req.user.id,
      appointment.artist_id,
      data.rating,
      data.professionalism,
      data.communication,
      data.punctuality,
      data.value,
      data.comment,
    ]
  )

  await refreshArtistRating(appointment.artist_id)

  const review = await queryOne(
    `SELECT r.*, u.first_name AS client_first_name, u.last_name AS client_last_name,
            u.avatar AS client_avatar
       FROM reviews r JOIN users u ON u.id = r.client_id WHERE r.id = ?`,
    [id]
  )

  return success(res, { review: serializeReview(review) }, 'Thanks! Your review has been posted.', 201)
}

/** PATCH /api/client/reviews/:reviewId */
exports.updateReview = async (req, res) => {
  const data = validateReview(req.body)

  const review = await queryOne('SELECT * FROM reviews WHERE id = ? LIMIT 1', [req.params.reviewId])
  if (!review) throw ApiError.notFound('Review not found')
  if (review.client_id !== req.user.id) throw ApiError.forbidden('That review is not yours')

  await query(
    `UPDATE reviews
        SET rating = ?, professionalism = ?, communication = ?, punctuality = ?,
            value_rating = ?, comment = ?
      WHERE id = ?`,
    [
      data.rating,
      data.professionalism,
      data.communication,
      data.punctuality,
      data.value,
      data.comment,
      review.id,
    ]
  )

  await refreshArtistRating(review.artist_id)

  const updated = await queryOne(
    `SELECT r.*, u.first_name AS client_first_name, u.last_name AS client_last_name,
            u.avatar AS client_avatar
       FROM reviews r JOIN users u ON u.id = r.client_id WHERE r.id = ?`,
    [review.id]
  )

  return success(res, { review: serializeReview(updated) }, 'Review updated')
}

/** GET /api/client/reviews */
exports.getMyReviews = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10))
  const offset = (page - 1) * limit

  const [{ total }] = await query('SELECT COUNT(*) AS total FROM reviews WHERE client_id = ?', [
    req.user.id,
  ])

  const rows = await query(
    `SELECT r.*, u.first_name AS client_first_name, u.last_name AS client_last_name,
            u.avatar AS client_avatar,
            a.first_name AS artist_first_name, a.last_name AS artist_last_name,
            a.avatar AS artist_avatar
       FROM reviews r
       JOIN users u ON u.id = r.client_id
       JOIN users a ON a.id = r.artist_id
      WHERE r.client_id = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?`,
    [req.user.id, String(limit), String(offset)]
  )

  const reviews = rows.map((row) => ({
    ...serializeReview(row),
    artist: {
      _id: row.artist_id,
      fullName: [row.artist_first_name, row.artist_last_name].filter(Boolean).join(' '),
      avatar: row.artist_avatar || '',
    },
  }))

  return paginated(res, { reviews }, { total, page, limit })
}

/**
 * DELETE /api/client/reviews/:reviewId
 *
 * Removing a review frees the booking to be reviewed again, and the artist's
 * cached rating is recomputed so it never counts a review that is gone.
 */
exports.deleteReview = async (req, res) => {
  const review = await queryOne('SELECT * FROM reviews WHERE id = ? LIMIT 1', [req.params.reviewId])
  if (!review) throw ApiError.notFound('Review not found')
  if (review.client_id !== req.user.id) throw ApiError.forbidden('That review is not yours')

  await query('DELETE FROM reviews WHERE id = ?', [review.id])
  await refreshArtistRating(review.artist_id)

  return success(res, {}, 'Review deleted')
}

// ---------------------------------------------------------------------------
// Favourites — artists the client has saved
// ---------------------------------------------------------------------------

/**
 * GET /api/client/favorites
 *
 * Returns the saved artists in the SAME shape as the public directory, so the
 * Favourites tab can reuse the artist card without a second mapper.
 */
exports.getFavorites = async (req, res) => {
  const { serializePublicArtist, portfolioImagesFor } = require('./artists.controller')

  const rows = await query(
    `SELECT u.*, f.created_at AS favorited_at
       FROM favorites f
       JOIN users u ON u.id = f.artist_id
      WHERE f.client_id = ?
        AND u.role = 'artist' AND u.approval_status = 'approved' AND u.is_active = 1
      ORDER BY f.created_at DESC`,
    [req.user.id]
  )

  const images = await portfolioImagesFor(rows.map((row) => row.id))
  const favorites = rows.map((row) => ({
    ...serializePublicArtist(row, images.get(row.id) || []),
    favoritedAt: row.favorited_at,
    isFavorite: true,
  }))

  return success(res, { favorites, artists: favorites }, 'OK', 200, { total: favorites.length })
}

/**
 * POST /api/client/favorites/:artistId
 * Saving twice is not an error — the unique key makes this idempotent.
 */
exports.addFavorite = async (req, res) => {
  const artist = await queryOne(
    "SELECT id FROM users WHERE id = ? AND role = 'artist' AND approval_status = 'approved' AND is_active = 1 LIMIT 1",
    [req.params.artistId]
  )
  if (!artist) throw ApiError.notFound('Artist not found')

  await query(
    'INSERT IGNORE INTO favorites (id, client_id, artist_id) VALUES (?, ?, ?)',
    [uuid(), req.user.id, artist.id]
  )

  return success(res, { artistId: artist.id, isFavorite: true }, 'Saved to your favourites')
}

/** DELETE /api/client/favorites/:artistId */
exports.removeFavorite = async (req, res) => {
  await query('DELETE FROM favorites WHERE client_id = ? AND artist_id = ?', [
    req.user.id,
    req.params.artistId,
  ])

  return success(res, { artistId: req.params.artistId, isFavorite: false }, 'Removed from your favourites')
}

/**
 * GET /api/client/favorites/:artistId/status
 * Lets the artist profile page show the heart in the right state on load.
 */
exports.getFavoriteStatus = async (req, res) => {
  const row = await queryOne(
    'SELECT id FROM favorites WHERE client_id = ? AND artist_id = ? LIMIT 1',
    [req.user.id, req.params.artistId]
  )

  return success(res, { artistId: req.params.artistId, isFavorite: Boolean(row) })
}
