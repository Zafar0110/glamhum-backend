// Artist dashboard — everything under /dashboard/artist.
// Every route requires a signed-in user with role = 'artist'.

const express = require('express')
const asyncHandler = require('../utils/asyncHandler')
const { authenticate, authorize, requireApprovedArtist } = require('../middleware/auth')
const notImplemented = require('../utils/notImplemented')
const controller = require('../controllers/artist.controller')
const messages = require('../controllers/messages.controller')

const router = express.Router()

router.use(authenticate, authorize('artist'))

// --- onboarding / approval ----------------------------------------------
// Reachable while pending: the artist has to be able to finish and resubmit
// the very profile that is under review.
router.get('/profile-status', asyncHandler(controller.getProfileStatus))
router.post('/submit-profile', asyncHandler(controller.submitProfile))

// ---------------------------------------------------------------------------
// Everything below is real dashboard data and stays closed until an admin
// approves the account.
// ---------------------------------------------------------------------------
router.use(requireApprovedArtist)

// --- clients -------------------------------------------------------------
router.get('/clients', notImplemented('artistAPI.getAllClients'))
router.get('/clients/:clientId', notImplemented('artistAPI.getClientById'))

// --- appointments --------------------------------------------------------
router.get('/appointments', asyncHandler(controller.getAllAppointments))
router.post('/appointments', notImplemented('artistAPI.createAppointment'))
router.patch('/appointments/:appointmentId/status', asyncHandler(controller.updateAppointmentStatus))

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
router.get('/messages/conversations', asyncHandler(messages.getConversations))
router.get('/messages/:appointmentId', asyncHandler(messages.getMessages))
router.post('/messages', asyncHandler(messages.sendMessage))
router.patch('/messages/:appointmentId/read', asyncHandler(messages.markAsRead))

// --- stripe connect ------------------------------------------------------
router.get('/stripe/status', notImplemented('artistAPI.getStripeConnectStatus'))
router.post('/stripe/connect-link', notImplemented('artistAPI.createStripeConnectLink'))
router.get('/stripe/dashboard-link', notImplemented('artistAPI.getStripeDashboardLink'))

module.exports = router
