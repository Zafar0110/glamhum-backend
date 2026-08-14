// Admin console — artist approvals and platform stats. Requires role = 'admin'.

const express = require('express')
const { authenticate, authorize } = require('../middleware/auth')
const notImplemented = require('../utils/notImplemented')

const router = express.Router()

router.use(authenticate, authorize('admin'))

router.get('/stats', notImplemented('adminAPI.getDashboardStats'))

router.get('/artists', notImplemented('adminAPI.getAllArtists'))
router.get('/artists/:artistId', notImplemented('adminAPI.getArtistDetails'))
router.patch('/artists/:artistId/approve', notImplemented('adminAPI.approveArtist'))
router.patch('/artists/:artistId/reject', notImplemented('adminAPI.rejectArtist'))

module.exports = router
