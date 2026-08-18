const express = require('express')
const env = require('../config/env')
const { success } = require('../utils/response')
const notImplemented = require('../utils/notImplemented')

const router = express.Router()

//GET /api/stripe/config
router.get('/config', (req, res) =>
  success(res, {
    stripeConfigured: env.stripe.configured,
    publishableKey: env.stripe.publishableKey || null,
  })
)

 
router.post('/webhook', notImplemented('stripe webhook handler'))

module.exports = router
