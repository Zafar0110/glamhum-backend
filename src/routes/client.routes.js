// Client dashboard + booking flow. Requires role = 'client'.

const express = require('express')
const asyncHandler = require('../utils/asyncHandler')
const { authenticate, authorize } = require('../middleware/auth')
const notImplemented = require('../utils/notImplemented')
const controller = require('../controllers/client.controller')
const messages = require('../controllers/messages.controller')
const payments = require('../controllers/payments.controller')

const router = express.Router()

router.use(authenticate, authorize('client'))

// --- bookings ------------------------------------------------------------
router.post('/bookings', asyncHandler(controller.createBooking))
router.get('/bookings', asyncHandler(controller.getMyBookings))
router.get('/bookings/artist/:artistId', asyncHandler(controller.getMyBookingsByArtist))
router.patch('/bookings/:bookingId/cancel', asyncHandler(controller.cancelBooking))

// --- payments ------------------------------------------------------------
router.post('/payments/prepare', asyncHandler(payments.preparePayment))
router.post('/payments/prepare-booking', asyncHandler(payments.prepareBookingPayment))
router.post('/payments/confirm', asyncHandler(payments.confirmPayment))
router.post('/payments/process', asyncHandler(payments.processPayment))
router.get('/payments/:paymentIntentId/status', asyncHandler(payments.getPaymentIntentStatus))
router.post('/payments/refund', asyncHandler(payments.refundPayment))

// --- reviews -------------------------------------------------------------
router.get('/reviews', asyncHandler(controller.getMyReviews))
router.post('/reviews', asyncHandler(controller.createReview))
router.patch('/reviews/:reviewId', asyncHandler(controller.updateReview))
router.delete('/reviews/:reviewId', asyncHandler(controller.deleteReview))

// --- messages ------------------------------------------------------------
router.get('/messages/conversations', asyncHandler(messages.getConversations))
// Registered before /messages/:appointmentId so the param route cannot swallow it.
router.get('/messages/unread-count', asyncHandler(messages.getUnreadCount))
router.get('/messages/:appointmentId', asyncHandler(messages.getMessages))
router.post('/messages', asyncHandler(messages.sendMessage))
router.patch('/messages/:appointmentId/read', asyncHandler(messages.markAsRead))

// --- favourites (client dashboard "Favorites" tab) -----------------------
router.get('/favorites', asyncHandler(controller.getFavorites))
// Registered before the :artistId routes so it cannot be swallowed by them.
router.get('/favorites/:artistId/status', asyncHandler(controller.getFavoriteStatus))
router.post('/favorites/:artistId', asyncHandler(controller.addFavorite))
router.delete('/favorites/:artistId', asyncHandler(controller.removeFavorite))

module.exports = router
