// Central place where every environment variable is read and defaulted.
// Nothing else in the codebase should touch process.env directly.

const path = require('path')
const dotenv = require('dotenv')

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') })

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback
  return String(value).toLowerCase() === 'true'
}

const int = (value, fallback) => {
  const parsed = parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

/** Strip surrounding quotes that .env files often carry, e.g. MAIL_FROM_NAME="GlamHub". */
const unquote = (value = '') => String(value).trim().replace(/^["']|["']$/g, '')

/**
 * SMTP settings.
 *
 * Accepts either naming convention so an existing Laravel-style .env works
 * unchanged:
 *   SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASSWORD / MAIL_FROM
 *   MAIL_HOST / MAIL_PORT / MAIL_ENCRYPTION / MAIL_USERNAME / MAIL_PASSWORD /
 *   MAIL_FROM_ADDRESS + MAIL_FROM_NAME
 */
function mailConfig() {
  const host = unquote(process.env.SMTP_HOST || process.env.MAIL_HOST || '')
  const port = int(process.env.SMTP_PORT || process.env.MAIL_PORT, 587)
  const user = unquote(process.env.SMTP_USER || process.env.MAIL_USERNAME || '')
  const password = unquote(process.env.SMTP_PASSWORD || process.env.MAIL_PASSWORD || '')
  const encryption = unquote(process.env.MAIL_ENCRYPTION || '').toLowerCase()

  // Implicit TLS only on 465 / ssl. Port 587 uses STARTTLS, which nodemailer
  // negotiates itself when secure is false — setting secure:true there hangs.
  const secure =
    process.env.SMTP_SECURE !== undefined && process.env.SMTP_SECURE !== ''
      ? bool(process.env.SMTP_SECURE, false)
      : port === 465 || encryption === 'ssl'

  const fromAddress = unquote(process.env.MAIL_FROM_ADDRESS || '') || user
  const fromName = unquote(process.env.MAIL_FROM_NAME || 'GlamHub')
  const from =
    unquote(process.env.MAIL_FROM || '') ||
    (fromAddress ? `"${fromName}" <${fromAddress}>` : 'GlamHub <no-reply@glamhub.local>')

  return {
    host,
    port,
    secure,
    user,
    password,
    from,
    fromName,
    configured: Boolean(host && user && password),
  }
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
  port: int(process.env.PORT, 5000),
  apiPrefix: process.env.API_PREFIX || '/api',

  // Comma separated list of allowed origins
  clientUrls: (process.env.CLIENT_URL || 'http://localhost:3000')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean),

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'glamhub',
    connectionLimit: int(process.env.DB_CONNECTION_LIMIT, 10),
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'insecure-dev-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    rememberMeExpiresIn: process.env.JWT_REMEMBER_ME_EXPIRES_IN || '30d',
  },

  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),

  upload: {
    dir: process.env.UPLOAD_DIR || 'uploads',
    maxBytes: int(process.env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
  },

  otp: {
    length: int(process.env.OTP_LENGTH, 4),
    expiresMinutes: int(process.env.OTP_EXPIRES_MINUTES, 10),
    debugReturn: bool(process.env.OTP_DEBUG_RETURN, false),
  },

  // Both naming styles are accepted: SMTP_* and the Laravel-style MAIL_*.
  mail: mailConfig(),

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    commissionPercent: int(process.env.PLATFORM_COMMISSION_PERCENT, 10),
    get configured() {
      return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY)
    },
  },
}

module.exports = env
