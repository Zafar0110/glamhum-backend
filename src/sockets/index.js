// Socket.IO layer for chat.
//
// The frontend (frontend/docs/BACKEND_CHAT_REQUIREMENTS.md) expects the server
// to emit `new_message` to the RECEIVER right after a message is saved, with a
// payload matching serializeMessage(). Each user joins a room named after their
// own id, so emitting is just: emitNewMessage(payload).

const { Server } = require('socket.io')
const env = require('../config/env')
const { verifyToken } = require('../utils/jwt')

let io = null

function init(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientUrls, credentials: true },
  })

  // Authenticate the socket with the same JWT used for REST calls.
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      (socket.handshake.headers.authorization || '').replace('Bearer ', '')

    if (!token) return next(new Error('Authentication token missing'))

    try {
      const payload = verifyToken(token)
      socket.userId = payload.sub
      socket.userRole = payload.role
      return next()
    } catch (error) {
      return next(new Error('Invalid token'))
    }
  })

  io.on('connection', (socket) => {
    socket.join(socket.userId)
    if (!env.isProduction) console.log(`[socket] connected ${socket.userId}`)

    // Optional per-thread rooms if you later want typing indicators etc.
    socket.on('join_conversation', (appointmentId) => socket.join(`appointment:${appointmentId}`))
    socket.on('leave_conversation', (appointmentId) => socket.leave(`appointment:${appointmentId}`))

    socket.on('disconnect', () => {
      if (!env.isProduction) console.log(`[socket] disconnected ${socket.userId}`)
    })
  })

  return io
}

/** Push a saved message to its receiver. Call this from the send-message controller. */
function emitNewMessage(message) {
  if (!io || !message) return
  io.to(message.receiverId).emit('new_message', message)
}

function getIO() {
  return io
}

module.exports = { init, emitNewMessage, getIO }
