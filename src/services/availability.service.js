// Is an artist free at a given moment?
//
// One implementation for both sides of the marketplace: the client booking a
// slot from the artist's public page, and the artist adding an appointment from
// their own schedule. Two routes into the same calendar means two chances to
// double-book, so neither writes an appointment without asking this first.

const { query, queryOne } = require('../config/db')

/** '14:30' | '14:30:00' -> 870 */
function toMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number)
  return (hours || 0) * 60 + (minutes || 0)
}

/**
 * Everything already occupying `date` between `startTime` and `endTime`.
 *
 * Returns { available, reason, conflicts: { appointments, blockedTime, vacations } }.
 * `excludeAppointmentId` lets an appointment be moved without clashing with
 * its own current slot.
 */
async function checkSlot(artistId, date, startTime, endTime, { excludeAppointmentId } = {}) {
  const from = toMinutes(startTime)
  const to = toMinutes(endTime)

  const [vacation, appointments, blocked] = await Promise.all([
    queryOne(
      'SELECT id, reason FROM vacations WHERE artist_id = ? AND ? BETWEEN start_date AND end_date LIMIT 1',
      [artistId, date]
    ),
    query(
      `SELECT id, start_time, end_time FROM appointments
        WHERE artist_id = ? AND appointment_date = ?
          AND status IN ('pending','confirmed')
          AND (? IS NULL OR id <> ?)`,
      [artistId, date, excludeAppointmentId || null, excludeAppointmentId || '']
    ),
    query(
      `SELECT id, start_time, end_time FROM blocked_times
        WHERE artist_id = ? AND ? BETWEEN start_date AND end_date`,
      [artistId, date]
    ),
  ])

  if (vacation) {
    return {
      available: false,
      reason: vacation.reason
        ? `The artist is away on this date (${vacation.reason})`
        : 'The artist is away on this date',
      conflicts: { appointments: 0, blockedTime: 0, vacations: 1 },
    }
  }

  // Two periods overlap when each starts before the other ends.
  const overlaps = (row) => from < toMinutes(row.end_time || row.start_time) && to > toMinutes(row.start_time)

  const clashingAppointments = appointments.filter(overlaps)
  const clashingBlocks = blocked.filter(overlaps)

  if (clashingAppointments.length || clashingBlocks.length) {
    return {
      available: false,
      reason: clashingAppointments.length
        ? 'That time is already booked. Please choose another slot.'
        : 'The artist has blocked that time. Please choose another slot.',
      conflicts: {
        appointments: clashingAppointments.length,
        blockedTime: clashingBlocks.length,
        vacations: 0,
      },
    }
  }

  return {
    available: true,
    reason: null,
    conflicts: { appointments: 0, blockedTime: 0, vacations: 0 },
  }
}

module.exports = { checkSlot, toMinutes }
