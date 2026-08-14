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

// Code length comes from OTP_LENGTH (default 4). The frontend reads the same
// number from NEXT_PUBLIC_OTP_LENGTH, so keep the two in step if you change it.
const CODE_LENGTH = env.otp.length
const MAX_ATTEMPTS = 5

/** Cryptographically random code, zero-padded to CODE_LENGTH digits. */
function generateCode() {
  return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
}

// TODO(phone): plug Twilio in here when SMS is switched back on.
function deliverSms(identifier, code) {
  console.log(`[otp] (sms not configured) code for ${identifier}: ${code}`)
}

/**
 * Create and deliver a code.
 * Any previous unconsumed code for the same identifier + purpose is voided.
 */
async function issue({ identifier, type = 'email', purpose = 'signup', userId = null, firstName = '' }) {
  if (!identifier) throw ApiError.badRequest('An email address is required')

  const target = String(identifier).trim().toLowerCase()
  const code = generateCode()
  const expiresAt = new Date(Date.now() + env.otp.expiresMinutes * 60 * 1000)

  await query(
    `UPDATE otps SET consumed_at = NOW()
      WHERE identifier = ? AND purpose = ? AND consumed_at IS NULL`,
    [target, purpose]
  )

  await query(
    `INSERT INTO otps (id, user_id, identifier, code, type, purpose, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), userId, target, code, type, purpose, expiresAt]
  )

  // Fire-and-forget delivery.
  if (type === 'email') {
    sendOtpEmail({ to: target, firstName, code, purpose })
  } else {
    deliverSms(target, code)
  }

  // Always visible in the server console during development.
  if (!env.isProduction) console.log(`[otp] ${purpose} code for ${target}: ${code}`)

  return {
    identifier: target,
    expiresAt,
    debugCode: env.otp.debugReturn ? code : undefined,
  }
}

/** Verify a code and consume it. Throws a field-level error when invalid. */
async function verify({ identifier, code, purpose = 'signup' }) {
  const target = String(identifier || '').trim().toLowerCase()

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
