// OTP generation / verification.
//
// There is no SMS or email provider wired up yet: the code is stored in the
// `otps` table and, when OTP_DEBUG_RETURN=true (development only), returned in
// the API response so you can test the flow. Plug Twilio / SendGrid into
// `deliver()` when you are ready.

const { v4: uuid } = require('uuid')
const env = require('../config/env')
const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')

const CODE_LENGTH = 6

function generateCode() {
  return String(Math.floor(Math.random() * 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
}

// TODO: send via SMS/email provider.
async function deliver(identifier, code, type) {
  console.log(`[otp] ${type} code for ${identifier}: ${code}`)
}

/**
 * Create (and "send") a code. Any previous unconsumed code for the same
 * identifier + purpose is invalidated first.
 */
async function issue({ identifier, type = 'phone', purpose = 'signup', userId = null }) {
  if (!identifier) throw ApiError.badRequest('Phone number or email is required')

  await query(
    `UPDATE otps SET consumed_at = NOW()
      WHERE identifier = ? AND purpose = ? AND consumed_at IS NULL`,
    [identifier, purpose]
  )

  const code = generateCode()
  const expiresAt = new Date(Date.now() + env.otp.expiresMinutes * 60 * 1000)

  await query(
    `INSERT INTO otps (id, user_id, identifier, code, type, purpose, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), userId, identifier, code, type, purpose, expiresAt]
  )

  await deliver(identifier, code, type)

  return {
    identifier,
    expiresAt,
    // Only ever populated in development.
    debugCode: env.otp.debugReturn ? code : undefined,
  }
}

/** Verify a code and mark it consumed. Throws when invalid/expired. */
async function verify({ identifier, code, purpose = 'signup' }) {
  const row = await queryOne(
    `SELECT * FROM otps
      WHERE identifier = ? AND purpose = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [identifier, purpose]
  )

  if (!row) throw ApiError.badRequest('No verification code was requested for this account')
  if (new Date(row.expires_at) < new Date()) throw ApiError.badRequest('This code has expired, request a new one')

  if (row.code !== String(code)) {
    await query('UPDATE otps SET attempts = attempts + 1 WHERE id = ?', [row.id])
    throw ApiError.badRequest('The code you entered is incorrect')
  }

  await query('UPDATE otps SET consumed_at = NOW() WHERE id = ?', [row.id])
  return row
}

module.exports = { issue, verify }
