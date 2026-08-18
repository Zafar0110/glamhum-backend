 

const express = require('express')
const asyncHandler = require('../utils/asyncHandler')
const { authenticate, authorize } = require('../middleware/auth')
const { upload } = require('../middleware/upload')
const controller = require('../controllers/portfolio.controller')

const router = express.Router()

// Artist-only.  
router.get('/', authenticate, authorize('artist'), asyncHandler(controller.getMyPortfolio))
router.post(
  '/',
  authenticate,
  authorize('artist'),
  upload.array('images', 10),
  asyncHandler(controller.uploadPortfolioImages)
)
router.delete('/', authenticate, authorize('artist'), asyncHandler(controller.deletePortfolioImage))

// Public 
router.get('/:artistId', asyncHandler(controller.getPortfolioImages))

module.exports = router
