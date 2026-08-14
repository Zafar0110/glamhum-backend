// Email OTP: what sign-up uses today.
// Phone/SMS is intentionally parked (see sendPhoneOTP at the bottom).

const env = require('../config/env')
const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success } = require('../utils/response')
const { signToken } = require('../utils/jwt')
const { serializeUser } = require('../utils/serializers')
const otpService = require('../services/otp.service')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * POST /api/otp/send-email
 * Body: { email }
 * Sends (or re-sends) the sign-up confirmation code.
 */
exports.sendEmailOTP = async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  if (!email || !EMAIL_RE.test(email)) {
    throw ApiError.validation({ email: 'Enter a valid email address' })
  }

  // Single narrow lookup on the unique email index.
  const user = await queryOne(
    'SELECT id, first_name, is_email_verified FROM users WHERE email = ? LIMIT 1',
    [email]
  )
  if (!user) throw ApiError.validation({ email: 'No account found for this email address' })
  if (user.is_email_verified) {
    return success(res, { email, alreadyVerified: true }, 'This email is already verified')
  }

  const result = await otpService.issue({
    identifier: email,
    type: 'email',
    purpose: 'signup',
    userId: user.id,
    firstName: user.first_name,
  })

  return success(
    res,
    { email, expiresAt: result.expiresAt, debugCode: result.debugCode },
    'Confirmation code sent to your email'
  )
}

/**
 * POST /api/otp/verify-email
 * Body: { email, otp }
 * Marks the email verified and returns a fresh token + user so the frontend
 * can log the person straight in.
 */
exports.verifyEmailOTP = async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  const otp = String(req.body.otp || '').trim()

  const length = env.otp.length
  if (!email) throw ApiError.validation({ email: 'Email address is required' })
  if (!otp) throw ApiError.validation({ otp: `Please enter the ${length}-digit code` })
  if (!new RegExp(`^\\d{${length}}$`).test(otp)) {
    throw ApiError.validation({ otp: `The code must be ${length} digits` })
  }

  await otpService.verify({ identifier: email, code: otp, purpose: 'signup' })

  const user = await queryOne('SELECT * FROM users WHERE email = ? LIMIT 1', [email])
  if (!user) throw ApiError.notFound('Account not found')

  if (!user.is_email_verified) {
    await query('UPDATE users SET is_email_verified = 1 WHERE id = ?', [user.id])
    user.is_email_verified = 1
  }

  const token = signToken(user)
  return success(
    res,
    { verified: true, user: serializeUser(user), token },
    'Email verified successfully',
    200,
    { token }
  )
}

/**
 * POST /api/otp/resend
 * Body: { email, purpose? }  purpose: 'signup' (default) | 'forgot_password'
 */
exports.resendOTP = async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  const purpose = req.body.purpose === 'forgot_password' ? 'forgot_password' : 'signup'

  if (!email || !EMAIL_RE.test(email)) {
    throw ApiError.validation({ email: 'Enter a valid email address' })
  }

  const user = await queryOne('SELECT id, first_name FROM users WHERE email = ? LIMIT 1', [email])
  if (!user) throw ApiError.validation({ email: 'No account found for this email address' })

  const result = await otpService.issue({
    identifier: email,
    type: 'email',
    purpose,
    userId: user.id,
    firstName: user.first_name,
  })

  return success(res, { email, expiresAt: result.expiresAt, debugCode: result.debugCode }, 'A new code has been sent')
}

/**
 * POST /api/otp/send-phone — parked until SMS is switched on.
 * The phone number is still saved so the number entered during onboarding
 * is not lost.
 */
exports.sendPhoneOTP = async (req, res) => {
  const { phone, countryCode } = req.body
  if (!phone) throw ApiError.validation({ phone: 'Phone number is required' })

  if (req.user) {
    await query('UPDATE users SET phone = ?, country_code = ? WHERE id = ?', [
      String(phone).trim(),
      countryCode || null,
      req.user.id,
    ])
  }

  throw new ApiError(501, 'Phone verification is not enabled yet — verify by email instead')
}
