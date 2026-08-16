// The artist's own calendar: their client list, appointments they add
// themselves, time they block out, and holidays.
//
// Anything written here goes through checkSlot first — the artist's schedule
// and the public booking page are two doors into the same calendar, and only
// one of them used to be guarded.

const { v4: uuid } = require('uuid')
const { query, queryOne, transaction } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success } = require('../utils/response')
const { serializeUser } = require('../utils/serializers')
const { hydrateAppointments, parseAppointmentTime, addMinutes } = require('../services/appointments.service')
const { checkSlot, toMinutes } = require('../services/availability.service')

function serializeBlockedTime(row) {
  if (!row) return null
  return {
    id: row.id,
    _id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: String(row.start_time || '').slice(0, 5),
    endTime: String(row.end_time || '').slice(0, 5),
    duration: row.duration || '',
    reason: row.reason || '',
    createdAt: row.created_at,
  }
}

function serializeVacation(row) {
  if (!row) return null
  return {
    id: row.id,
    _id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    reason: row.reason || '',
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/**
 * GET /api/artist/clients?search=
 * Everyone who has booked this artist, with a little history so the schedule's
 * client picker is useful rather than just a list of names.
 */
exports.getAllClients = async (req, res) => {
  const search = String(req.query.search || '').trim()
  const params = [req.user.id]

  let searchSql = ''
  if (search) {
    searchSql = `AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?
                      OR CONCAT(u.first_name, ' ', u.last_name) LIKE ?)`
    const like = `%${search}%`
    params.push(like, like, like, like)
  }

  const rows = await query(
    `SELECT u.*, COUNT(a.id) AS total_bookings, MAX(a.appointment_date) AS last_booking
       FROM appointments a
       JOIN users u ON u.id = a.client_id
      WHERE a.artist_id = ? ${searchSql}
      GROUP BY u.id
      ORDER BY last_booking DESC`,
    params
  )

  const clients = rows.map((row) => ({
    ...serializeUser(row),
    totalBookings: Number(row.total_bookings),
    lastBooking: row.last_booking,
  }))

  return success(res, { clients }, 'OK', 200, { total: clients.length })
}

/** GET /api/artist/clients/:clientId — one client plus their history here. */
exports.getClientById = async (req, res) => {
  const row = await queryOne(
    `SELECT u.*, COUNT(a.id) AS total_bookings, MAX(a.appointment_date) AS last_booking
       FROM appointments a
       JOIN users u ON u.id = a.client_id
      WHERE a.artist_id = ? AND u.id = ?
      GROUP BY u.id`,
    [req.user.id, req.params.clientId]
  )

  if (!row) throw ApiError.notFound('That client has never booked with you')

  const bookings = await hydrateAppointments(
    await query(
      `SELECT * FROM appointments WHERE artist_id = ? AND client_id = ?
        ORDER BY appointment_date DESC LIMIT 20`,
      [req.user.id, req.params.clientId]
    )
  )

  return success(res, {
    client: {
      ...serializeUser(row),
      totalBookings: Number(row.total_bookings),
      lastBooking: row.last_booking,
    },
    bookings,
  })
}

// ---------------------------------------------------------------------------
// Appointments the artist adds themselves
// ---------------------------------------------------------------------------

/**
 * POST /api/artist/appointments
 *
 * A walk-in, a phone booking, a repeat client. It goes in as confirmed — the
 * artist is the one accepting it — and unpaid, since money changes hands at
 * the venue.
 */
exports.createAppointment = async (req, res) => {
  const {
    clientId,
    serviceIds,
    appointmentDate,
    appointmentTime,
    endTime,
    venue,
    venueDetails = {},
    notes,
  } = req.body || {}

  const errors = {}
  if (!clientId) errors.clientId = 'Choose a client'
  if (!Array.isArray(serviceIds) || !serviceIds.length) errors.serviceIds = 'Choose at least one service'
  if (!appointmentDate) errors.appointmentDate = 'Choose a date'
  if (!appointmentTime) errors.appointmentTime = 'Choose a start time'
  if (Object.keys(errors).length) throw ApiError.validation(errors)

  const client = await queryOne("SELECT * FROM users WHERE id = ? AND role = 'client' LIMIT 1", [
    clientId,
  ])
  if (!client) throw ApiError.validation({ clientId: 'That client no longer exists' })

  const placeholders = serviceIds.map(() => '?').join(',')
  const services = await query(
    `SELECT * FROM services WHERE id IN (${placeholders}) AND artist_id = ? AND is_active = 1`,
    [...serviceIds, req.user.id]
  )
  if (services.length !== serviceIds.length) {
    throw ApiError.validation({ serviceIds: 'One or more of those services is no longer available' })
  }

  const totalMinutes =
    services.reduce((sum, service) => sum + (Number(service.duration_minutes) || 60), 0) || 60

  // The form may send a single time, a range, or a named slot.
  const parsed = parseAppointmentTime(appointmentTime, totalMinutes)
  const startTime = parsed.startTime
  const finishTime = endTime ? `${String(endTime).slice(0, 5)}:00` : addMinutes(startTime, totalMinutes)

  // Never write over something already in the calendar.
  const slot = await checkSlot(req.user.id, appointmentDate, startTime, finishTime)
  if (!slot.available) throw ApiError.conflict(slot.reason)

  const servicesTotal = services.reduce((sum, service) => sum + Number(service.price), 0)
  const id = uuid()

  await transaction(async (connection) => {
    await connection.execute(
      `INSERT INTO appointments
         (id, client_id, artist_id, appointment_date, start_time, end_time, duration_minutes,
          venue, venue_name, venue_street, venue_city, venue_state,
          status, currency, total_price, service_fee, payment_method, payment_status,
          artist_payout_status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, 0, 'pay_at_venue', 'unpaid',
               'not_applicable', ?)`,
      [
        id,
        clientId,
        req.user.id,
        appointmentDate,
        startTime,
        finishTime,
        totalMinutes,
        venue || 'client_venue',
        venueDetails.venueName || null,
        venueDetails.street || null,
        venueDetails.city || null,
        venueDetails.state || null,
        req.user.currency || 'AED',
        servicesTotal,
        notes || null,
      ]
    )

    for (const service of services) {
      await connection.execute(
        `INSERT INTO appointment_services (id, appointment_id, service_id, service_name, service_type, price)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuid(), id, service.id, service.service_name, service.service_type, service.price]
      )
    }
  })

  const [appointment] = await hydrateAppointments(
    await query('SELECT * FROM appointments WHERE id = ?', [id])
  )

  return success(res, { appointment }, 'Appointment added to your schedule', 201)
}

// ---------------------------------------------------------------------------
// Blocked time
// ---------------------------------------------------------------------------

/** GET /api/artist/blocked-time */
exports.getBlockedTime = async (req, res) => {
  const where = ['artist_id = ?']
  const params = [req.user.id]

  if (req.query.startDate) {
    where.push('end_date >= ?')
    params.push(req.query.startDate)
  }
  if (req.query.endDate) {
    where.push('start_date <= ?')
    params.push(req.query.endDate)
  }

  const rows = await query(
    `SELECT * FROM blocked_times WHERE ${where.join(' AND ')} ORDER BY start_date DESC, start_time`,
    params
  )

  const blockedTimes = rows.map(serializeBlockedTime)
  return success(res, { blockedTimes }, 'OK', 200, { total: blockedTimes.length })
}

/** POST /api/artist/blocked-time */
exports.createBlockedTime = async (req, res) => {
  const { startDate, endDate, startTime, endTime, duration, reason } = req.body || {}

  const errors = {}
  if (!startDate) errors.startDate = 'Choose a start date'
  if (!startTime) errors.startTime = 'Choose a start time'
  if (!endTime && !duration) errors.duration = 'Choose how long to block'
  if (Object.keys(errors).length) throw ApiError.validation(errors)

  const from = `${String(startTime).slice(0, 5)}:00`
  // '3 hours' is what the form sends when no explicit end time is picked.
  const hours = /(\d+)\s*hour/i.exec(String(duration || ''))
  const to = endTime
    ? `${String(endTime).slice(0, 5)}:00`
    : addMinutes(from, hours ? parseInt(hours[1], 10) * 60 : 60)

  const id = uuid()
  await query(
    `INSERT INTO blocked_times (id, artist_id, start_date, end_date, start_time, end_time, duration, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, req.user.id, startDate, endDate || startDate, from, to, duration || null, reason || null]
  )

  const row = await queryOne('SELECT * FROM blocked_times WHERE id = ?', [id])
  return success(res, { blockedTime: serializeBlockedTime(row) }, 'Time blocked', 201)
}

/** DELETE /api/artist/blocked-time/:blockedTimeId */
exports.deleteBlockedTime = async (req, res) => {
  const row = await queryOne('SELECT * FROM blocked_times WHERE id = ? LIMIT 1', [
    req.params.blockedTimeId,
  ])
  if (!row) throw ApiError.notFound('That blocked time no longer exists')
  if (row.artist_id !== req.user.id) throw ApiError.forbidden('That blocked time is not yours')

  await query('DELETE FROM blocked_times WHERE id = ?', [row.id])
  return success(res, {}, 'Blocked time removed')
}

// ---------------------------------------------------------------------------
// Vacations
// ---------------------------------------------------------------------------

/** GET /api/artist/vacations */
exports.getVacations = async (req, res) => {
  const where = ['artist_id = ?']
  const params = [req.user.id]

  if (req.query.startDate) {
    where.push('end_date >= ?')
    params.push(req.query.startDate)
  }
  if (req.query.endDate) {
    where.push('start_date <= ?')
    params.push(req.query.endDate)
  }

  const rows = await query(
    `SELECT * FROM vacations WHERE ${where.join(' AND ')} ORDER BY start_date DESC`,
    params
  )

  const vacations = rows.map(serializeVacation)
  return success(res, { vacations }, 'OK', 200, { total: vacations.length })
}

/** POST /api/artist/vacations */
exports.createVacation = async (req, res) => {
  const { startDate, endDate, reason } = req.body || {}

  const errors = {}
  if (!startDate) errors.startDate = 'Choose a start date'
  if (!endDate) errors.endDate = 'Choose an end date'
  if (startDate && endDate && endDate < startDate) {
    errors.endDate = 'The end date cannot be before the start date'
  }
  if (Object.keys(errors).length) throw ApiError.validation(errors)

  // Warn rather than block: the artist may well intend to cancel these.
  const [{ clashes }] = await query(
    `SELECT COUNT(*) AS clashes FROM appointments
      WHERE artist_id = ? AND status IN ('pending','confirmed')
        AND appointment_date BETWEEN ? AND ?`,
    [req.user.id, startDate, endDate]
  )

  const id = uuid()
  await query(
    'INSERT INTO vacations (id, artist_id, start_date, end_date, reason) VALUES (?, ?, ?, ?, ?)',
    [id, req.user.id, startDate, endDate, reason || null]
  )

  const row = await queryOne('SELECT * FROM vacations WHERE id = ?', [id])
  return success(
    res,
    { vacation: serializeVacation(row), existingAppointments: Number(clashes) },
    Number(clashes)
      ? `Vacation saved. You still have ${clashes} appointment(s) booked in that period.`
      : 'Vacation saved',
    201
  )
}

/** DELETE /api/artist/vacations/:vacationId */
exports.deleteVacation = async (req, res) => {
  const row = await queryOne('SELECT * FROM vacations WHERE id = ? LIMIT 1', [req.params.vacationId])
  if (!row) throw ApiError.notFound('That vacation no longer exists')
  if (row.artist_id !== req.user.id) throw ApiError.forbidden('That vacation is not yours')

  await query('DELETE FROM vacations WHERE id = ?', [row.id])
  return success(res, {}, 'Vacation removed')
}

/**
 * PATCH /api/artist/appointments/:appointmentId/reschedule
 *
 * Move an appointment to a new date/time. The new slot is checked against the
 * rest of the calendar — excluding this appointment, or it would always clash
 * with the slot it currently occupies.
 */
exports.rescheduleAppointment = async (req, res) => {
  const { appointmentDate, appointmentTime, endTime } = req.body || {}

  const errors = {}
  if (!appointmentDate || !/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)) {
    errors.appointmentDate = 'Choose a valid date'
  }
  if (!appointmentTime) errors.appointmentTime = 'Choose a start time'
  if (Object.keys(errors).length) throw ApiError.validation(errors)

  const appointment = await queryOne('SELECT * FROM appointments WHERE id = ? LIMIT 1', [
    req.params.appointmentId,
  ])
  if (!appointment) throw ApiError.notFound('Appointment not found')
  if (appointment.artist_id !== req.user.id) {
    throw ApiError.forbidden('This appointment belongs to another artist')
  }
  if (['completed', 'cancelled'].includes(appointment.status)) {
    throw ApiError.badRequest(`A ${appointment.status} appointment cannot be rescheduled.`)
  }

  const totalMinutes = Number(appointment.duration_minutes) || 60
  const parsed = parseAppointmentTime(appointmentTime, totalMinutes)
  const startTime = parsed.startTime
  const finishTime = endTime ? `${String(endTime).slice(0, 5)}:00` : addMinutes(startTime, totalMinutes)

  const slot = await checkSlot(req.user.id, appointmentDate, startTime, finishTime, {
    excludeAppointmentId: appointment.id,
  })
  if (!slot.available) throw ApiError.conflict(slot.reason)

  await query(
    `UPDATE appointments
        SET appointment_date = ?, start_time = ?, end_time = ?,
            duration_minutes = ?
      WHERE id = ?`,
    [
      appointmentDate,
      startTime,
      finishTime,
      Math.max(15, Math.round((toMinutes(finishTime) - toMinutes(startTime)) || totalMinutes)),
      appointment.id,
    ]
  )

  const [updated] = await hydrateAppointments(
    await query('SELECT * FROM appointments WHERE id = ?', [appointment.id])
  )

  return success(res, { appointment: updated }, 'Appointment rescheduled')
}
