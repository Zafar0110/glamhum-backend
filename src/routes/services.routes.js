// The signed-in artist's own service catalogue.

const express = require('express')
const { authenticate, authorize } = require('../middleware/auth')
const notImplemented = require('../utils/notImplemented')

const router = express.Router()

router.use(authenticate, authorize('artist'))

router.get('/', notImplemented('servicesAPI.getMyServices'))
router.post('/', notImplemented('servicesAPI.createService'))
router.get('/:id', notImplemented('servicesAPI.getServiceById'))
router.patch('/:id', notImplemented('servicesAPI.updateService'))
router.delete('/:id', notImplemented('servicesAPI.deleteService'))

module.exports = router
