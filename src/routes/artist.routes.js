// Artist dashboard — everything under /dashboard/artist.
// Every route requires a signed-in user with role = 'artist'.

const express = require('express')
const { authenticate, authorize } = require('../middleware/auth')
const notImplemented = require('../utils/notImplemented')

const router = express.Router()

router.use(authenticate, authorize('artist'))

// --- clients -------------------------------------------------------------
router.get('/clients', notImplemented('artistAPI.getAllClients'))
router.get('/clients/:clientId', notImplemented('artistAPI.getClientById'))

// --- appointments --------------------------------------------------------
router.get('/appointments', notImplemented('artistAPI.getAllAppointments'))
router.post('/appointments', notImplemented('artistAPI.createAppointment'))
router.patch('/appointments/:appointmentId/status', notImplemented('artistAPI.updateAppointmentStatus'))

// --- schedule: blocked time & vacations ----------------------------------
router.get('/blocked-time', notImplemented('artistAPI.getBlockedTime'))
router.post('/blocked-time', notImplemented('artistAPI.createBlockedTime'))
router.delete('/blocked-time/:blockedTimeId', notImplemented('artistAPI.deleteBlockedTime'))

router.get('/vacations', notImplemented('artistAPI.getVacations'))
router.post('/vacations', notImplemented('artistAPI.createVacation'))
router.delete('/vacations/:vacationId', notImplemented('artistAPI.deleteVacation'))

// --- payments ------------------------------------------------------------
router.get('/payments/stats', notImplemented('artistAPI.getPaymentStats'))
router.get('/payments/transactions', notImplemented('artistAPI.getAllTransactions'))
router.post('/payments/withdrawals', notImplemented('artistAPI.requestWithdrawal'))

// --- reviews -------------------------------------------------------------
router.get('/reviews', notImplemented('artistAPI.getArtistReviews'))
router.get('/reviews/:reviewId', notImplemented('artistAPI.getReviewById'))

// --- messages ------------------------------------------------------------
router.get('/messages/conversations', notImplemented('artistAPI.getConversations'))
router.get('/messages/:appointmentId', notImplemented('artistAPI.getMessages'))
router.post('/messages', notImplemented('artistAPI.sendMessage'))
router.patch('/messages/:appointmentId/read', notImplemented('artistAPI.markMessagesAsRead'))

// --- stripe connect ------------------------------------------------------
router.get('/stripe/status', notImplemented('artistAPI.getStripeConnectStatus'))
router.post('/stripe/connect-link', notImplemented('artistAPI.createStripeConnectLink'))
router.get('/stripe/dashboard-link', notImplemented('artistAPI.getStripeDashboardLink'))

module.exports = router
