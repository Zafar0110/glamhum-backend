 

const { query } = require('../config/db')
const { serializeAppointment } = require('../utils/serializers')

 
const NAMED_SLOTS = {
  morning: ['08:00:00', '12:00:00'],
  afternoon: ['12:00:00', '16:00:00'],
  evening: ['16:00:00', '20:00:00'],
  night: ['20:00:00', '23:00:00'],
}

function to24h(value) {
  const match = String(value)
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!match) return null

  let hours = parseInt(match[1], 10)
  const minutes = match[2] ? parseInt(match[2], 10) : 0
  const meridiem = match[3] ? match[3].toLowerCase() : null

  if (meridiem === 'pm' && hours < 12) hours += 12
  if (meridiem === 'am' && hours === 12) hours = 0
  if (hours > 23 || minutes > 59) return null

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`
}

function parseAppointmentTime(input, fallbackDurationMinutes = 60) {
  const raw = String(input || '').trim()

  // Named part of the day, with or without the bracketed hint.
  const named = Object.keys(NAMED_SLOTS).find((key) => raw.toLowerCase().startsWith(key))
  if (named) {
    const [startTime, endTime] = NAMED_SLOTS[named]
    return { startTime, endTime }
  }

  // Explicit range, e.g. '14:00 - 15:30' or '2PM - 4PM'
  if (raw.includes('-')) {
    const [from, to] = raw.split('-').map((part) => part.trim())
    const startTime = to24h(from)
    const endTime = to24h(to)
    if (startTime && endTime) return { startTime, endTime }
    if (startTime) return { startTime, endTime: addMinutes(startTime, fallbackDurationMinutes) }
  }

  // Single time  
  const startTime = to24h(raw)
  if (startTime) return { startTime, endTime: addMinutes(startTime, fallbackDurationMinutes) }

  // Nothing usable: 
  return { startTime: NAMED_SLOTS.morning[0], endTime: NAMED_SLOTS.morning[1] }
}

function addMinutes(time, minutes) {
  const [hours, mins] = time.split(':').map(Number)
  const total = Math.min(23 * 60 + 59, hours * 60 + mins + minutes)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`
}

 
function durationToMinutes(duration = '') {
  const hours = /(\d+)\s*h/i.exec(duration)
  const minutes = /(\d+)\s*m/i.exec(duration)
  return (hours ? parseInt(hours[1], 10) * 60 : 0) + (minutes ? parseInt(minutes[1], 10) : 0)
}

 
async function hydrateAppointments(rows) {
  if (!rows.length) return []

  const ids = rows.map((row) => row.id)
  const userIds = [...new Set(rows.flatMap((row) => [row.client_id, row.artist_id]))]

  const [lineItems, users] = await Promise.all([
    query(
      `SELECT * FROM appointment_services WHERE appointment_id IN (${ids.map(() => '?').join(',')})`,
      ids
    ),
    query(`SELECT * FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`, userIds),
  ])

  const servicesByAppointment = new Map()
  for (const item of lineItems) {
    if (!servicesByAppointment.has(item.appointment_id)) servicesByAppointment.set(item.appointment_id, [])
    servicesByAppointment.get(item.appointment_id).push(item)
  }

  const userById = new Map(users.map((user) => [user.id, user]))

  return rows.map((row) =>
    serializeAppointment(
      row,
      servicesByAppointment.get(row.id) || [],
      userById.get(row.client_id) || null,
      userById.get(row.artist_id) || null
    )
  )
}

module.exports = { parseAppointmentTime, durationToMinutes, addMinutes, hydrateAppointments }
