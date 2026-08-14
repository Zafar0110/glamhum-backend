// Public artist directory — powers /, /explore and /explore/[artistId].
// No authentication: these pages are browsable by anyone.

const express = require('express')
const asyncHandler = require('../utils/asyncHandler')
const controller = require('../controllers/artists.controller')

const router = express.Router()

router.get('/', asyncHandler(controller.getArtists))
router.get('/:artistId/availability', asyncHandler(controller.checkAvailability))
router.get('/:artistId', asyncHandler(controller.getArtistById))

module.exports = router
