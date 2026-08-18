 

const crypto = require('crypto')
const { v4: uuid } = require('uuid')
const env = require('../config/env')
const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { sendOtpEmail } = require('./mail.service')
const sms = require('./sms.service')
const { sendOtpSms } = require('./sms.service')

 
const MAX_ATTEMPTS = 5

//Cryptographically random code
function generateCode(length) {
  return String(crypto.randomInt(0, 10 ** length)).padStart(length, '0')
}

 
async function issue({
  identifier,
  type = 'email',
  purpose = 'signup',
  userId = null,
  firstName = '', 
  fallbackEmail = '',
}) {
  if (!identifier) {
    throw ApiError.badRequest(type === 'phone' ? 'A phone number is required' : 'An email address is required')
  }

  // Phone numbers keep their  
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

  
  const emailTheCodeInstead = async (why) => {
    if (!fallbackEmail) {
      console.error(`[otp] SMS to ${target} failed and no email is on file — user is stuck.`)
      return false
    }

    console.warn(`[otp] SMS to ${target} failed (${why}); emailing the code to ${fallbackEmail} instead.`)
    sendOtpEmail({ to: fallbackEmail, firstName, code, purpose })

     
    try {
      await query("UPDATE otps SET delivered_via = 'email' WHERE id = ?", [otpId])
    } catch (error) {
      console.error('[otp] could not record the email fallback:', error.message)
    }
    return true
  }

  let deliveredVia = type

  if (type === 'email') {
    
    sendOtpEmail({ to: target, firstName, code, purpose })
  } else {
    
    const submitted = await sms.trySendSms({ to: target, body: sms.otpMessage(code) })

    if (submitted.ok) {
      sms.watchDelivery({
        to: target,
        sid: submitted.sid,
        
        onFailure: (outcome) => emailTheCodeInstead(outcome.errorCode || outcome.status),
      })
    } else if (submitted.reason === 'not_configured') {
       
      deliveredVia = 'console'
    } else if (await emailTheCodeInstead(submitted.errorCode || submitted.errorMessage)) {
      deliveredVia = 'email'
    }
  }

  
  if (!env.isProduction) console.log(`[otp] ${purpose} ${type} code for ${target}: ${code}`)

  return {
    identifier: target,
    expiresAt,
    length, 
    deliveredVia,
    debugCode: env.otp.debugReturn ? code : undefined,
  }
}

//Verify a code and consume it. Throws
async function verify({ identifier, code, purpose = 'signup' }) {
  
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
