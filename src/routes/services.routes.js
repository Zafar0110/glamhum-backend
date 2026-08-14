// The signed-in artist's own service catalogue.

const express = require('express')
const asyncHandler = require('../utils/asyncHandler')
const { authenticate, authorize } = require('../middleware/auth')
const controller = require('../controllers/services.controller')

const router = express.Router()

router.use(authenticate, authorize('artist'))

router.get('/', asyncHandler(controller.getMyServices))
router.post('/', asyncHandler(controller.createService))
router.post('/:id/duplicate', asyncHandler(controller.duplicateService))
router.patch('/:id/archive', asyncHandler(controller.archiveService))

router.get('/:id', asyncHandler(controller.getServiceById))
router.patch('/:id', asyncHandler(controller.updateService))
router.put('/:id', asyncHandler(controller.updateService))
router.delete('/:id', asyncHandler(controller.deleteService))

module.exports = router
