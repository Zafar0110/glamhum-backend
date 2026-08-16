// OTP generation / verification.
//
// Codes are currently delivered by EMAIL (see mail.service.js). Phone/SMS is
// wired for later: pass type:'phone' and implement deliverSms().
//
// SPEED NOTES
//  - Delivery never blocks the response: sendOtpEmail() queues and returns.
//  - Lookups hit idx_otps_lookup (identifier, purpose, consumed_at).
//  - Old codes are invalidated with one UPDATE rather than a SELECT+UPDATE.

const crypto = require('crypto')
const { v4: uuid } = require('uuid')
const env = require('../config/env')
const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { sendOtpEmail } = require('./mail.service')
const sms = require('./sms.service')
const { sendOtpSms } = require('./sms.service')

// Length depends on the channel: 6 digits for SMS (the convention people
// expect from a text), 4 for email. Both are configurable — see config/env.js.
const MAX_ATTEMPTS = 5

/** Cryptographically random code, zero-padded to `length` digits. */
function generateCode(length) {
  return String(crypto.randomInt(0, 10 ** length)).padStart(length, '0')
}

/**
 * Create and deliver a code.
 * Any previous unconsumed code for the same identifier + purpose is voided.
 */
async function issue({
  identifier,
  type = 'email',
  purpose = 'signup',
  userId = null,
  firstName = '',
  /** Where to send the code if SMS cannot reach the number (see onFailure). */
  fallbackEmail = '',
}) {
  if (!identifier) {
    throw ApiError.badRequest(type === 'phone' ? 'A phone number is required' : 'An email address is required')
  }

  // Phone numbers keep their case-sensitive '+'; emails are normalised.
  const target = type === 'phone' ? String(identifier).trim() : String(identifier).trim().toLowerCase()
  const length = env.otp.lengthFor(type)
  const code = generateCode(length)
  const expiresAt = new Date(Date.now() + env.otp.expiresMinutes * 60 * 1000)
  const otpId = uuid()

  await query(
    `UPDATE otps SET consumed_at = NOW()
      WHERE identifier = ? AND purpose = ? AND consumed_at IS NULL`,
    [target, purpose]
  )

  await query(
    `INSERT INTO otps (id, user_id, identifier, code, type, purpose, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [otpId, userId, target, code, type, purpose, expiresAt]
  )

  /**
   * Send the SAME code by email when SMS cannot reach the number, so the user
   * can finish signing up instead of waiting for a text that will never come.
   */
  const emailTheCodeInstead = async (why) => {
    if (!fallbackEmail) {
      console.error(`[otp] SMS to ${target} failed and no email is on file — user is stuck.`)
      return false
    }

    console.warn(`[otp] SMS to ${target} failed (${why}); emailing the code to ${fallbackEmail} instead.`)
    sendOtpEmail({ to: fallbackEmail, firstName, code, purpose })

    // Record it so support (and the verify screen) can see why it came by email.
    try {
      await query("UPDATE otps SET delivered_via = 'email' WHERE id = ?", [otpId])
    } catch (error) {
      console.error('[otp] could not record the email fallback:', error.message)
    }
    return true
  }

  let deliveredVia = type

  if (type === 'email') {
    // Fire-and-forget: the mailer never blocks the response.
    sendOtpEmail({ to: target, firstName, code, purpose })
  } else {
    // Awaited, but only the SUBMIT step — a single Twilio call. An impossible
    // route (US long code -> UAE, 21612) is rejected right here, so the caller
    // can tell the user the code went to their email instead of claiming a text
    // is on its way. Confirming final delivery stays in the background.
    const submitted = await sms.trySendSms({ to: target, body: sms.otpMessage(code) })

    if (submitted.ok) {
      sms.watchDelivery({
        to: target,
        sid: submitted.sid,
        // A late failure still falls back; the verify screen picks it up from
        // the delivery-status endpoint.
        onFailure: (outcome) => emailTheCodeInstead(outcome.errorCode || outcome.status),
      })
    } else if (submitted.reason === 'not_configured') {
      // Nothing to send with — the code is in the server log for development.
      deliveredVia = 'console'
    } else if (await emailTheCodeInstead(submitted.errorCode || submitted.errorMessage)) {
      deliveredVia = 'email'
    }
  }

  // Always visible in the server console during development.
  if (!env.isProduction) console.log(`[otp] ${purpose} ${type} code for ${target}: ${code}`)

  return {
    identifier: target,
    expiresAt,
    length,
    /** 'phone' | 'email' | 'console' — where the code actually went. */
    deliveredVia,
    debugCode: env.otp.debugReturn ? code : undefined,
  }
}

/** Verify a code and consume it. Throws a field-level error when invalid. */
async function verify({ identifier, code, purpose = 'signup' }) {
  // Phone numbers must not be lower-cased into a different string than the one
  // stored at issue time; emails are case-insensitive.
  const raw = String(identifier || '').trim()
  const target = raw.startsWith('+') ? raw : raw.toLowerCase()

  const row = await queryOne(
    `SELECT id, user_id, code, expires_at, attempts FROM otps
      WHERE identifier = ? AND purpose = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [target, purpose]
  )

  if (!row) {
    throw ApiError.validation({ otp: 'No active code for this account. Please request a new one.' })
  }

  if (new Date(row.expires_at) < new Date()) {
    throw ApiError.validation({ otp: 'This code has expired. Please request a new one.' })
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    throw ApiError.validation({ otp: 'Too many incorrect attempts. Please request a new code.' })
  }

  if (row.code !== String(code).trim()) {
    await query('UPDATE otps SET attempts = attempts + 1 WHERE id = ?', [row.id])
    throw ApiError.validation({ otp: 'The code you entered is incorrect.' })
  }

  await query('UPDATE otps SET consumed_at = NOW() WHERE id = ?', [row.id])
  return row
}

module.exports = { issue, verify }
