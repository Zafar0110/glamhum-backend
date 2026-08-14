// Mounts every route group under the API prefix (default /api).

const express = require('express')
const { testConnection } = require('../config/db')
const { success } = require('../utils/response')

const router = express.Router()

/** GET /api/health — liveness + database ping. */
router.get('/health', async (req, res) => {
  let database = 'up'
  try {
    await testConnection()
  } catch (error) {
    database = `down (${error.code || error.message})`
  }

  const data = {
    status: database === 'up' ? 'ok' : 'degraded',
    database,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }

  return database === 'up'
    ? success(res, data)
    : res.status(503).json({ success: false, message: 'Database unreachable', data })
})

router.use('/auth', require('./auth.routes'))
router.use('/otp', require('./otp.routes'))
router.use('/artists', require('./artists.routes')) // public directory
router.use('/artist', require('./artist.routes')) // artist dashboard
router.use('/client', require('./client.routes'))
router.use('/services', require('./services.routes'))
router.use('/portfolio', require('./portfolio.routes'))
router.use('/admin', require('./admin.routes'))
router.use('/stripe', require('./stripe.routes'))

module.exports = router
