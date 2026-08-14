// Public artist directory — powers /explore, /explore/[artistId] and the home page.

const express = require('express')
const notImplemented = require('../utils/notImplemented')

const router = express.Router()

// GET /api/artists?page&limit&city&serviceType&minPrice&maxPrice&search&sortBy
router.get('/', notImplemented('artistsAPI.getArtists'))

// GET /api/artists/:artistId  -> { artist, services, reviews }
router.get('/:artistId', notImplemented('artistsAPI.getArtistById'))

// GET /api/artists/:artistId/availability?date&time
router.get('/:artistId/availability', notImplemented('artistsAPI.checkAvailability'))

module.exports = router
