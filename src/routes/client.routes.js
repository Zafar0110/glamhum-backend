// Client dashboard + booking flow. Requires role = 'client'.

const express = require('express')
const { authenticate, authorize } = require('../middleware/auth')
const notImplemented = require('../utils/notImplemented')

const router = express.Router()

router.use(authenticate, authorize('client'))

// --- bookings ------------------------------------------------------------
router.post('/bookings', notImplemented('clientAPI.createBooking'))
router.get('/bookings', notImplemented('clientAPI.getMyBookings'))
router.get('/bookings/artist/:artistId', notImplemented('clientAPI.getMyBookingsByArtist'))
router.patch('/bookings/:bookingId/cancel', notImplemented('clientAPI.cancelBooking'))

// --- payments ------------------------------------------------------------
router.post('/payments/prepare', notImplemented('clientAPI.preparePayment'))
router.post('/payments/confirm', notImplemented('clientAPI.confirmPayment'))
router.post('/payments/process', notImplemented('clientAPI.processPayment'))
router.get('/payments/:paymentIntentId/status', notImplemented('clientAPI.getPaymentIntentStatus'))
router.post('/payments/refund', notImplemented('clientAPI.refundPayment'))

// --- reviews -------------------------------------------------------------
router.get('/reviews', notImplemented('clientAPI.getMyReviews'))
router.post('/reviews', notImplemented('clientAPI.createReview'))
router.patch('/reviews/:reviewId', notImplemented('clientAPI.updateReview'))

// --- messages ------------------------------------------------------------
router.get('/messages/conversations', notImplemented('clientAPI.getConversations'))
router.get('/messages/:appointmentId', notImplemented('clientAPI.getMessages'))
router.post('/messages', notImplemented('clientAPI.sendMessage'))
router.patch('/messages/:appointmentId/read', notImplemented('clientAPI.markMessagesAsRead'))

// --- favourites (client dashboard "Favorites" tab) -----------------------
router.get('/favorites', notImplemented('clientAPI.getFavorites'))
router.post('/favorites/:artistId', notImplemented('clientAPI.addFavorite'))
router.delete('/favorites/:artistId', notImplemented('clientAPI.removeFavorite'))

module.exports = router
