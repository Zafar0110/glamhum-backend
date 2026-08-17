// Admin console — artist approvals and platform stats. Requires role = 'admin'.

const express = require('express')
const asyncHandler = require('../utils/asyncHandler')
const { authenticate, authorize } = require('../middleware/auth')
const controller = require('../controllers/admin.controller')

const router = express.Router()

router.use(authenticate, authorize('admin'))

router.get('/stats', asyncHandler(controller.getDashboardStats))

router.get('/artists', asyncHandler(controller.getAllArtists))
router.get('/artists/:artistId', asyncHandler(controller.getArtistDetails))
router.patch('/artists/:artistId/approve', asyncHandler(controller.approveArtist))
router.patch('/artists/:artistId/reject', asyncHandler(controller.rejectArtist))
router.patch('/artists/:artistId/status', asyncHandler(controller.setArtistStatus))
router.delete('/artists/:artistId', asyncHandler(controller.deleteArtist))

// --- platform settings ----------------------------------------------------
router.get('/settings', asyncHandler(controller.getSettings))
router.patch('/settings', asyncHandler(controller.updateSettings))

module.exports = router
