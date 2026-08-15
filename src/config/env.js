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

  /**
   * Where THIS API is reachable from a browser. Stored image paths are turned
   * into absolute URLs against it, so the frontend never has to know where
   * uploads live. Set PUBLIC_URL to the real domain on cPanel.
   */
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${int(process.env.PORT, 5000)}`).replace(/\/+$/, ''),

  otp: {
    /** Which channel sign-up verification uses: 'phone' or 'email'. */
    channel: (process.env.OTP_CHANNEL || 'phone').toLowerCase() === 'email' ? 'email' : 'phone',
    /** Fallback length; the per-channel values below are what actually apply. */
    length: int(process.env.OTP_LENGTH, 4),
    /** SMS codes are 6 digits by convention; email codes stay at 4. */
    phoneLength: int(process.env.OTP_PHONE_LENGTH || process.env.OTP_LENGTH, 6),
    emailLength: int(process.env.OTP_EMAIL_LENGTH || process.env.OTP_LENGTH, 4),
    expiresMinutes: int(process.env.OTP_EXPIRES_MINUTES, 10),
    debugReturn: bool(process.env.OTP_DEBUG_RETURN, false),
    /** Digits for a given channel. */
    lengthFor(type) {
      return type === 'phone' ? this.phoneLength : this.emailLength
    },
  },

  /**
   * Twilio. Leave empty and codes are printed to the server console instead.
   *
   * Two ways to authenticate:
   *   1. API key (recommended) — TWILIO_API_KEY_SID (SK…) + TWILIO_API_KEY_SECRET.
   *      Revocable on its own, so a leak doesn't mean rotating the whole account.
   *   2. Account auth token — TWILIO_AUTH_TOKEN.
   *
   * TWILIO_ACCOUNT_SID (AC…) is required either way: it identifies the account
   * in the request URL. An API key authenticates but does not identify it.
   */
  sms: (() => {
    const accountSid = unquote(process.env.TWILIO_ACCOUNT_SID || '')
    const apiKeySid = unquote(process.env.TWILIO_API_KEY_SID || '')
    const apiKeySecret = unquote(process.env.TWILIO_API_KEY_SECRET || '')
    const authToken = unquote(process.env.TWILIO_AUTH_TOKEN || '')

    // API key takes precedence when both are present.
    const username = apiKeySid || accountSid
    const password = apiKeySid ? apiKeySecret : authToken

    return {
      accountSid,
      apiKeySid,
      username,
      password,
      authMode: apiKeySid ? 'api_key' : 'auth_token',
      from: unquote(process.env.TWILIO_PHONE_NUMBER || ''),
      messagingServiceSid: unquote(process.env.TWILIO_MESSAGING_SERVICE_SID || ''),
      /**
       * Verify service SID (VA…). When set, phone codes go through Twilio
       * Verify — which uses Twilio's own global routes and sender IDs — rather
       * than a raw SMS from our number. Required to reach the UAE.
       */
      verifyServiceSid: unquote(process.env.TWILIO_VERIFY_SERVICE_SID || ''),
      useVerify: Boolean(
        process.env.TWILIO_VERIFY_SERVICE_SID && accountSid && username && password
      ),
      // Verify needs no sender of our own, so it counts as configured on its own.
      configured: Boolean(
        accountSid &&
          username &&
          password &&
          (process.env.TWILIO_PHONE_NUMBER ||
            process.env.TWILIO_MESSAGING_SERVICE_SID ||
            process.env.TWILIO_VERIFY_SERVICE_SID)
      ),
    }
  })(),

  // Both naming styles are accepted: SMTP_* and the Laravel-style MAIL_*.
  mail: mailConfig(),

  stripe: {
    secretKey: unquote(process.env.STRIPE_SECRET_KEY || ''),
    publishableKey: unquote(process.env.STRIPE_PUBLISHABLE_KEY || ''),
    webhookSecret: unquote(process.env.STRIPE_WEBHOOK_SECRET || ''),
    /** Platform cut of each booking, taken as a Stripe application fee. */
    commissionPercent: int(process.env.PLATFORM_COMMISSION_PERCENT, 10),
    /** Country new Express accounts are opened in. */
    connectCountry: unquote(process.env.STRIPE_CONNECT_DEFAULT_COUNTRY || 'AE'),
    /** Cancellations later than this get the reduced refund below. */
    cancellationCutoffHours: int(process.env.CANCELLATION_CUTOFF_HOURS, 24),
    lateCancellationRefundPercent: int(process.env.LATE_CANCELLATION_REFUND_PERCENT, 0),
    get configured() {
      return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY)
    },
  },
}

module.exports = env
