// Artist portfolio gallery. Uploads are multipart/form-data under the
// field name "images" (the frontend sends several files at once).

const express = require('express')
const asyncHandler = require('../utils/asyncHandler')
const { authenticate, authorize } = require('../middleware/auth')
const { upload } = require('../middleware/upload')
const controller = require('../controllers/portfolio.controller')

const router = express.Router()

// Artist-only. Declared before /:artistId so "portfolio" is not read as an id.
router.get('/', authenticate, authorize('artist'), asyncHandler(controller.getMyPortfolio))
router.post(
  '/',
  authenticate,
  authorize('artist'),
  upload.array('images', 10),
  asyncHandler(controller.uploadPortfolioImages)
)
router.delete('/', authenticate, authorize('artist'), asyncHandler(controller.deletePortfolioImage))

// Public: anyone viewing an artist profile can see the gallery.
router.get('/:artistId', asyncHandler(controller.getPortfolioImages))

module.exports = router
