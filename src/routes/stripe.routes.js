const express = require('express')
const env = require('../config/env')
const { success } = require('../utils/response')
const notImplemented = require('../utils/notImplemented')

const router = express.Router()

/**
 * GET /api/stripe/config
 * The booking page calls this before offering "pay now" — it only shows the
 * card option when stripeConfigured is true and a publishable key comes back.
 */
router.get('/config', (req, res) =>
  success(res, {
    stripeConfigured: env.stripe.configured,
    publishableKey: env.stripe.publishableKey || null,
  })
)

// Stripe -> server callbacks (payment_intent.succeeded, account.updated, ...).
// Note: this needs the RAW body, which app.js already preserves for this path.
router.post('/webhook', notImplemented('stripe webhook handler'))

module.exports = router
