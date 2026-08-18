 

const { v4: uuid } = require('uuid')
const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success } = require('../utils/response')
const { serializeMessage, absoluteUpload } = require('../utils/serializers')
const sockets = require('../sockets')

//Column names for the viewer and the person they are talking to
function sidesFor(role) {
  return role === 'artist'
    ? { me: 'artist_id', other: 'client_id' }
    : { me: 'client_id', other: 'artist_id' }
}

//GET /api/{client|artist}/messages/conversations
exports.getConversations = async (req, res) => {
  const { me, other } = sidesFor(req.user.role)

  //Every booking with this user, plus who it is with
  const appointments = await query(
    `SELECT a.id, a.appointment_date, a.status, a.${other} AS other_id,
            u.first_name, u.last_name, u.avatar, u.city, u.specialty
       FROM appointments a
       JOIN users u ON u.id = a.${other}
      WHERE a.${me} = ?
      ORDER BY a.appointment_date DESC, a.created_at DESC`,
    [req.user.id]
  )

  if (!appointments.length) return success(res, { conversations: [] }, 'OK', 200, { total: 0 })

  const appointmentIds = appointments.map((row) => row.id)
  const placeholders = appointmentIds.map(() => '?').join(',')

  // Unread counts + 3. the latest message per thread — two grouped queries
  const [unreadRows, latestRows] = await Promise.all([
    query(
      `SELECT appointment_id, COUNT(*) AS unread
         FROM messages
        WHERE appointment_id IN (${placeholders}) AND receiver_id = ? AND is_read = 0
        GROUP BY appointment_id`,
      [...appointmentIds, req.user.id]
    ),
    
    query(
      `SELECT * FROM messages
        WHERE appointment_id IN (${placeholders})
        ORDER BY created_at DESC, id DESC`,
      appointmentIds
    ),
  ])

  const unreadByAppointment = new Map(unreadRows.map((row) => [row.appointment_id, Number(row.unread)]))

  // Rows arrive newest-first, so the first one seen per thread is the latest.
  const latestByAppointment = new Map()
  for (const row of latestRows) {
    if (!latestByAppointment.has(row.appointment_id)) latestByAppointment.set(row.appointment_id, row)
  }

  // Group the bookings by counterparty.
  const byPerson = new Map()

  for (const row of appointments) {
    if (!byPerson.has(row.other_id)) {
      byPerson.set(row.other_id, {
         
        userId: row.other_id,
         
        _id: null,
        id: null,
        appointmentId: null,
        firstName: row.first_name,
        lastName: row.last_name,
        fullName: [row.first_name, row.last_name].filter(Boolean).join(' '),
        avatar: absoluteUpload(row.avatar || ''),
        city: row.city || '',
        specialty: row.specialty || '',
        appointments: [],
        lastMessage: null,
        lastMessageTime: null,
        unreadCount: 0,
      })
    }

    const person = byPerson.get(row.other_id)
    person.appointments.push({
      _id: row.id,
      id: row.id,
      appointmentDate: row.appointment_date,
      status: row.status,
    })
    person.unreadCount += unreadByAppointment.get(row.id) || 0

    // Appointments arrive newest-first, so the first one is the active thread.
    if (!person.appointmentId) {
      person.appointmentId = row.id
      person._id = row.id
      person.id = row.id
    }

    const latest = latestByAppointment.get(row.id)
    if (latest && (!person.lastMessageTime || new Date(latest.created_at) > new Date(person.lastMessageTime))) {
      person.lastMessage = {
        message: latest.message,
        text: latest.message,
        createdAt: latest.created_at,
        isRead: Boolean(latest.is_read),
        senderId: latest.sender_id,
      }
      person.lastMessageTime = latest.created_at
    }
  }

  // Threads with recent chatter first; brand-new bookings still appear.
  const conversations = [...byPerson.values()].sort((a, b) => {
    const timeA = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0
    const timeB = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0
    return timeB - timeA
  })

  return success(res, { conversations }, 'OK', 200, { total: conversations.length })
}

//The caller must be one of the two people on the appointment
async function assertThreadAccess(appointmentId, user) {
  const appointment = await queryOne(
    'SELECT id, client_id, artist_id FROM appointments WHERE id = ? LIMIT 1',
    [appointmentId]
  )
  if (!appointment) throw ApiError.notFound('Conversation not found')

  const isParticipant = appointment.client_id === user.id || appointment.artist_id === user.id
  if (!isParticipant) throw ApiError.forbidden('This conversation is not yours')

  return appointment
}

//GET /api/{client|artist}/messages/:appointmentId
exports.getMessages = async (req, res) => {
  const appointment = await assertThreadAccess(req.params.appointmentId, req.user)
  const otherId =
    appointment.client_id === req.user.id ? appointment.artist_id : appointment.client_id

  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100))

  // `id` breaks ties so the order is stable even for messages that land in
  // the same millisecond.
  const rows = await query(
    `SELECT * FROM messages
      WHERE (sender_id = ? AND receiver_id = ?)
         OR (sender_id = ? AND receiver_id = ?)
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
    [req.user.id, otherId, otherId, req.user.id, String(limit)]
  )

  return success(res, { messages: rows.map(serializeMessage) }, 'OK', 200, { total: rows.length })
}

//POST /api/{client|artist}/messages
exports.sendMessage = async (req, res) => {
  const { appointmentId, message } = req.body || {}

  if (!appointmentId) throw ApiError.validation({ appointmentId: 'Conversation is required' })
  if (!String(message || '').trim()) throw ApiError.validation({ message: 'Type a message first' })
  if (String(message).length > 2000) {
    throw ApiError.validation({ message: 'Messages are limited to 2000 characters' })
  }

  const appointment = await assertThreadAccess(appointmentId, req.user)
  const receiverId =
    appointment.client_id === req.user.id ? appointment.artist_id : appointment.client_id

  const id = uuid()
  await query(
    `INSERT INTO messages (id, appointment_id, sender_id, receiver_id, message)
     VALUES (?, ?, ?, ?, ?)`,
    [id, appointmentId, req.user.id, receiverId, String(message).trim()]
  )

  const row = await queryOne('SELECT * FROM messages WHERE id = ?', [id])
  const payload = serializeMessage(row)

  // Push to the receiver so their UI updates without waiting for a poll.
  sockets.emitNewMessage(payload)

  // Returned in full so the sender can render it without a second request.
  return success(res, { message: payload }, 'Message sent', 201)
}

//PATCH /api/{client|artist}/messages/:appointmentId/read
exports.markAsRead = async (req, res) => {
  const appointment = await assertThreadAccess(req.params.appointmentId, req.user)
  const otherId =
    appointment.client_id === req.user.id ? appointment.artist_id : appointment.client_id

  const result = await query(
    `UPDATE messages SET is_read = 1, read_at = NOW()
      WHERE receiver_id = ? AND sender_id = ? AND is_read = 0`,
    [req.user.id, otherId]
  )

  return success(res, { updated: result.affectedRows || 0 }, 'Messages marked as read')
}

//GET /api/{client|artist}/messages/unread-count
exports.getUnreadCount = async (req, res) => {
  const row = await queryOne(
    'SELECT COUNT(*) AS unread FROM messages WHERE receiver_id = ? AND is_read = 0',
    [req.user.id]
  )

  return success(res, { unreadCount: Number(row?.unread || 0) })
}
