// Artist dashboard — everything under /dashboard/artist.
// Every route requires a signed-in user with role = 'artist'.

const express = require('express')
const asyncHandler = require('../utils/asyncHandler')
const { authenticate, authorize, requireApprovedArtist } = require('../middleware/auth')
const notImplemented = require('../utils/notImplemented')
const controller = require('../controllers/artist.controller')
const messages = require('../controllers/messages.controller')
const payments = require('../controllers/payments.controller')
const schedule = require('../controllers/schedule.controller')

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
router.get('/clients', asyncHandler(schedule.getAllClients))
router.get('/clients/:clientId', asyncHandler(schedule.getClientById))

// --- appointments --------------------------------------------------------
router.get('/appointments', asyncHandler(controller.getAllAppointments))
router.post('/appointments', asyncHandler(schedule.createAppointment))
router.get('/appointments/:appointmentId', asyncHandler(controller.getAppointmentById))
router.patch('/appointments/:appointmentId/status', asyncHandler(controller.updateAppointmentStatus))

// --- schedule: blocked time & vacations ----------------------------------
router.get('/blocked-time', asyncHandler(schedule.getBlockedTime))
router.post('/blocked-time', asyncHandler(schedule.createBlockedTime))
router.delete('/blocked-time/:blockedTimeId', asyncHandler(schedule.deleteBlockedTime))

router.get('/vacations', asyncHandler(schedule.getVacations))
router.post('/vacations', asyncHandler(schedule.createVacation))
router.delete('/vacations/:vacationId', asyncHandler(schedule.deleteVacation))

// --- payments ------------------------------------------------------------
router.get('/payments/stats', asyncHandler(payments.getPaymentStats))
router.get('/payments/transactions', asyncHandler(payments.getAllTransactions))
router.post('/payments/withdrawals', asyncHandler(payments.requestWithdrawal))

// --- reviews -------------------------------------------------------------
router.get('/reviews', asyncHandler(controller.getArtistReviews))
router.get('/reviews/:reviewId', notImplemented('artistAPI.getReviewById'))

// --- messages ------------------------------------------------------------
router.get('/messages/conversations', asyncHandler(messages.getConversations))
router.get('/messages/:appointmentId', asyncHandler(messages.getMessages))
router.post('/messages', asyncHandler(messages.sendMessage))
router.patch('/messages/:appointmentId/read', asyncHandler(messages.markAsRead))

// --- stripe connect ------------------------------------------------------
router.get('/stripe/status', asyncHandler(payments.getStripeConnectStatus))
router.post('/stripe/connect-link', asyncHandler(payments.createStripeConnectLink))
router.get('/stripe/dashboard-link', asyncHandler(payments.getStripeDashboardLink))

module.exports = router
