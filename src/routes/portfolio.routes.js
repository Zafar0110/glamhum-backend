// Artist portfolio gallery. Uploads are multipart/form-data under the
// field name "images" (the frontend sends up to several files at once).

const express = require('express')
const { authenticate, authorize } = require('../middleware/auth')
const { upload } = require('../middleware/upload')
const notImplemented = require('../utils/notImplemented')

const router = express.Router()

// Public: anyone viewing an artist profile can see the gallery.
router.get('/:artistId', notImplemented('portfolioAPI.getPortfolioImages'))

// Artist-only
router.get('/', authenticate, authorize('artist'), notImplemented('portfolioAPI.getMyPortfolio'))
router.post(
  '/',
  authenticate,
  authorize('artist'),
  upload.array('images', 10),
  notImplemented('portfolioAPI.uploadPortfolioImages')
)
router.delete('/', authenticate, authorize('artist'), notImplemented('portfolioAPI.deletePortfolioImage'))

module.exports = router
