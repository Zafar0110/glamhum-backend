const path = require('path')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const compression = require('compression')
const rateLimit = require('express-rate-limit')

const env = require('./config/env')
const routes = require('./routes')
const { notFound, errorHandler } = require('./middleware/errorHandler')
const { uploadRoot } = require('./middleware/upload')

const app = express()

app.set('trust proxy', 1)
 
app.set('etag', false)
app.use(compression({ threshold: 1024 }))

 
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))

app.use(
  cors({
    origin(origin, callback) { 
      if (!origin || env.clientUrls.includes(origin)) return callback(null, true)
      return callback(new Error(`Origin not allowed by CORS: ${origin}`))
    },
    credentials: true,
  })
)

if (!env.isProduction) app.use(morgan('dev'))
 
app.use((req, res, next) => {
  if (req.originalUrl === `${env.apiPrefix}/stripe/webhook`) return next()
  return express.json({ limit: '2mb' })(req, res, next)
})
app.use(express.urlencoded({ extended: true }))

 
app.use(
  `${env.apiPrefix}/auth`,
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many attempts, please try again later' },
  })
)

 
app.use('/uploads', express.static(uploadRoot, { maxAge: '7d' }))

// API
app.use(env.apiPrefix, routes)

app.get('/', (req, res) =>
  res.json({ success: true, message: `GlamHub API — see ${env.apiPrefix}/health` })
)

app.use(notFound)
app.use(errorHandler)

module.exports = app
