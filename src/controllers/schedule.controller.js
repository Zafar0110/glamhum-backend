 

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

 
async function appointmentsInRange(artistId, startDate, endDate, window = null) {
  const where = [
    'a.artist_id = ?',
    "a.status IN ('pending','confirmed')",
    'a.appointment_date BETWEEN ? AND ?',
  ]
  const params = [artistId, startDate, endDate]

  if (window && window.startTime && window.endTime) {
     
    where.push("a.start_time < ? AND COALESCE(a.end_time, ADDTIME(a.start_time, '01:00:00')) > ?")
    params.push(`${String(window.endTime).slice(0, 5)}:00`, `${String(window.startTime).slice(0, 5)}:00`)
  }

  const rows = await query(
    `SELECT a.id, a.appointment_date, a.start_time, a.end_time, a.status,
            u.first_name, u.last_name
       FROM appointments a
       LEFT JOIN users u ON u.id = a.client_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.appointment_date, a.start_time`,
    params
  )

  return rows.map((row) => ({
    id: row.id,
    date:
      row.appointment_date instanceof Date
        ? `${row.appointment_date.getFullYear()}-${String(row.appointment_date.getMonth() + 1).padStart(2, '0')}-${String(row.appointment_date.getDate()).padStart(2, '0')}`
        : String(row.appointment_date || '').slice(0, 10),
    startTime: String(row.start_time || '').slice(0, 5),
    endTime: String(row.end_time || '').slice(0, 5),
    status: row.status,
    clientName: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Client',
  }))
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

//GET /api/artist/clients?search
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

//GET /api/artist/clients/:clientId
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

//POST /api/artist/appointments
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
//GET /api/artist/blocked-time
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

  
  const blockedTimes = []
  for (const row of rows) {
    const blocked = serializeBlockedTime(row)
    blocked.conflictingAppointments = await appointmentsInRange(
      req.user.id,
      blocked.startDate,
      blocked.endDate,
      { startTime: blocked.startTime, endTime: blocked.endTime }
    )
    blockedTimes.push(blocked)
  }

  return success(res, { blockedTimes }, 'OK', 200, { total: blockedTimes.length })
}

//POST /api/artist/blocked-time
exports.createBlockedTime = async (req, res) => {
  const { startDate, endDate, startTime, endTime, duration, reason } = req.body || {}

  const errors = {}
  if (!startDate) errors.startDate = 'Choose a start date'
  if (!startTime) errors.startTime = 'Choose a start time'
  if (!endTime && !duration) errors.duration = 'Choose how long to block'
  if (Object.keys(errors).length) throw ApiError.validation(errors)

  const from = `${String(startTime).slice(0, 5)}:00`
   
  const hours = /(\d+)\s*hour/i.exec(String(duration || ''))
  const to = endTime
    ? `${String(endTime).slice(0, 5)}:00`
    : addMinutes(from, hours ? parseInt(hours[1], 10) * 60 : 60)

  
  const conflicts = await appointmentsInRange(
    req.user.id,
    startDate,
    endDate || startDate,
    { startTime: from, endTime: to }
  )

  const id = uuid()
  await query(
    `INSERT INTO blocked_times (id, artist_id, start_date, end_date, start_time, end_time, duration, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, req.user.id, startDate, endDate || startDate, from, to, duration || null, reason || null]
  )

  const row = await queryOne('SELECT * FROM blocked_times WHERE id = ?', [id])
  const blockedTime = serializeBlockedTime(row)
  blockedTime.conflictingAppointments = conflicts

  return success(
    res,
    { blockedTime, existingAppointments: conflicts.length, conflictingAppointments: conflicts },
    conflicts.length
      ? `Time blocked, but you have ${conflicts.length} appointment(s) booked in that window. Reschedule or cancel them so clients are not left waiting.`
      : 'Time blocked',
    201
  )
}

//PATCH /api/artist/blocked-time/:blockedTimeId

exports.updateBlockedTime = async (req, res) => {
  const row = await queryOne('SELECT * FROM blocked_times WHERE id = ? LIMIT 1', [
    req.params.blockedTimeId,
  ])
  if (!row) throw ApiError.notFound('That blocked time no longer exists')
  if (row.artist_id !== req.user.id) throw ApiError.forbidden('That blocked time is not yours')

  const { startDate, endDate, startTime, endTime, duration, reason } = req.body || {}

  const nextStartDate = startDate || row.start_date
  const nextEndDate = endDate || startDate || row.end_date
  const nextStart = startTime ? `${String(startTime).slice(0, 5)}:00` : row.start_time
  const nextDuration = duration !== undefined ? duration : row.duration

   
  let nextEnd
  if (endTime) {
    nextEnd = `${String(endTime).slice(0, 5)}:00`
  } else if (startTime || duration !== undefined) {
    const hours = /(\d+)\s*hour/i.exec(String(nextDuration || ''))
    nextEnd = addMinutes(nextStart, hours ? parseInt(hours[1], 10) * 60 : 60)
  } else {
    nextEnd = row.end_time
  }

  if (String(nextEndDate) < String(nextStartDate)) {
    throw ApiError.validation({ endDate: 'The end date cannot be before the start date' })
  }
  if (toMinutes(String(nextEnd).slice(0, 5)) <= toMinutes(String(nextStart).slice(0, 5))) {
    throw ApiError.validation({ endTime: 'The end time must be after the start time' })
  }

  await query(
    `UPDATE blocked_times
        SET start_date = ?, end_date = ?, start_time = ?, end_time = ?, duration = ?, reason = ?
      WHERE id = ?`,
    [
      nextStartDate,
      nextEndDate,
      nextStart,
      nextEnd,
      nextDuration || null,
      reason !== undefined ? reason || null : row.reason,
      row.id,
    ]
  )

  // Same warning as on create: the window may have moved onto booked work.
  const conflicts = await appointmentsInRange(req.user.id, nextStartDate, nextEndDate, {
    startTime: nextStart,
    endTime: nextEnd,
  })

  const updated = await queryOne('SELECT * FROM blocked_times WHERE id = ?', [row.id])
  const blockedTime = serializeBlockedTime(updated)
  blockedTime.conflictingAppointments = conflicts

  return success(
    res,
    { blockedTime, existingAppointments: conflicts.length, conflictingAppointments: conflicts },
    conflicts.length
      ? `Blocked time updated, but you have ${conflicts.length} appointment(s) booked in that window. Reschedule or cancel them so clients are not left waiting.`
      : 'Blocked time updated'
  )
}

//DELETE /api/artist/blocked-time/:blockedTimeId
exports.deleteBlockedTime = async (req, res) => {
  const row = await queryOne('SELECT * FROM blocked_times WHERE id = ? LIMIT 1', [
    req.params.blockedTimeId,
  ])
  if (!row) throw ApiError.notFound('That blocked time no longer exists')
  if (row.artist_id !== req.user.id) throw ApiError.forbidden('That blocked time is not yours')

  await query('DELETE FROM blocked_times WHERE id = ?', [row.id])
  return success(res, {}, 'Blocked time removed')
}

 
//GET /api/artist/vacations
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

  
  const vacations = []
  for (const row of rows) {
    const vacation = serializeVacation(row)
    vacation.conflictingAppointments = await appointmentsInRange(
      req.user.id,
      vacation.startDate,
      vacation.endDate
    )
    vacations.push(vacation)
  }

  return success(res, { vacations }, 'OK', 200, { total: vacations.length })
}

//POST /api/artist/vacations
exports.createVacation = async (req, res) => {
  const { startDate, endDate, reason } = req.body || {}

  const errors = {}
  if (!startDate) errors.startDate = 'Choose a start date'
  if (!endDate) errors.endDate = 'Choose an end date'
  if (startDate && endDate && endDate < startDate) {
    errors.endDate = 'The end date cannot be before the start date'
  }
  if (Object.keys(errors).length) throw ApiError.validation(errors)

  
  const conflicts = await appointmentsInRange(req.user.id, startDate, endDate)

  const id = uuid()
  await query(
    'INSERT INTO vacations (id, artist_id, start_date, end_date, reason) VALUES (?, ?, ?, ?, ?)',
    [id, req.user.id, startDate, endDate, reason || null]
  )

  const row = await queryOne('SELECT * FROM vacations WHERE id = ?', [id])
  const vacation = serializeVacation(row)
  vacation.conflictingAppointments = conflicts

  return success(
    res,
    { vacation, existingAppointments: conflicts.length, conflictingAppointments: conflicts },
    conflicts.length
      ? `Vacation saved, but you have ${conflicts.length} appointment(s) booked in that period. Reschedule or cancel them so clients are not left waiting.`
      : 'Vacation saved',
    201
  )
}

//PATCH /api/artist/vacations/:vacationId
exports.updateVacation = async (req, res) => {
  const row = await queryOne('SELECT * FROM vacations WHERE id = ? LIMIT 1', [req.params.vacationId])
  if (!row) throw ApiError.notFound('That vacation no longer exists')
  if (row.artist_id !== req.user.id) throw ApiError.forbidden('That vacation is not yours')

  const { startDate, endDate, reason } = req.body || {}

  const nextStartDate = startDate || row.start_date
  const nextEndDate = endDate || row.end_date
  if (String(nextEndDate) < String(nextStartDate)) {
    throw ApiError.validation({ endDate: 'The end date cannot be before the start date' })
  }

  await query('UPDATE vacations SET start_date = ?, end_date = ?, reason = ? WHERE id = ?', [
    nextStartDate,
    nextEndDate,
    reason !== undefined ? reason || null : row.reason,
    row.id,
  ])

  // Same warning as on create: the artist may still have bookings in the period.
  const conflicts = await appointmentsInRange(req.user.id, nextStartDate, nextEndDate)

  const updated = await queryOne('SELECT * FROM vacations WHERE id = ?', [row.id])
  const vacation = serializeVacation(updated)
  vacation.conflictingAppointments = conflicts

  return success(
    res,
    { vacation, existingAppointments: conflicts.length, conflictingAppointments: conflicts },
    conflicts.length
      ? `Vacation updated, but you have ${conflicts.length} appointment(s) booked in that period. Reschedule or cancel them so clients are not left waiting.`
      : 'Vacation updated'
  )
}

//DELETE /api/artist/vacations/:vacationId
exports.deleteVacation = async (req, res) => {
  const row = await queryOne('SELECT * FROM vacations WHERE id = ? LIMIT 1', [req.params.vacationId])
  if (!row) throw ApiError.notFound('That vacation no longer exists')
  if (row.artist_id !== req.user.id) throw ApiError.forbidden('That vacation is not yours')

  await query('DELETE FROM vacations WHERE id = ?', [row.id])
  return success(res, {}, 'Vacation removed')
}

//PATCH /api/artist/appointments/:appointmentId/reschedule

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
