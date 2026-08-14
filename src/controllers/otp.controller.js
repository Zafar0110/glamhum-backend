const { query } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success } = require('../utils/response')
const { signToken } = require('../utils/jwt')
const otpService = require('../services/otp.service')

/** POST /otp/send — phone verification during sign-up. */
exports.sendPhoneOTP = async (req, res) => {
  const { phone, countryCode } = req.body
  if (!phone) throw ApiError.validation({ phone: 'Phone number is required' })

  const identifier = `${countryCode || ''}${String(phone).replace(/\s+/g, '')}`

  if (req.user) {
    await query('UPDATE users SET phone = ?, country_code = ? WHERE id = ?', [
      phone,
      countryCode || null,
      req.user.id,
    ])
  }

  const result = await otpService.issue({
    identifier,
    type: 'phone',
    purpose: 'signup',
    userId: req.user ? req.user.id : null,
  })

  return success(
    res,
    { phone: identifier, expiresAt: result.expiresAt, debugCode: result.debugCode },
    'Verification code sent'
  )
}

/** POST /otp/verify */
exports.verifyOTP = async (req, res) => {
  const { otp, type = 'phone', phone, email } = req.body
  if (!otp) throw ApiError.validation({ otp: 'Verification code is required' })

  const identifier = type === 'email' ? email : phone
  if (!identifier) {
    throw ApiError.validation({ [type]: `The ${type} the code was sent to is required` })
  }

  await otpService.verify({ identifier, code: otp, purpose: 'signup' })

  if (req.user) {
    const column = type === 'email' ? 'is_email_verified' : 'is_phone_verified'
    await query(`UPDATE users SET ${column} = 1 WHERE id = ?`, [req.user.id])
  }

  const token = req.user ? signToken(req.user) : undefined
  return success(res, { verified: true, token }, 'Code verified', 200, token ? { token } : {})
}

/** POST /otp/resend */
exports.resendOTP = async (req, res) => {
  const { type = 'phone', phone, email } = req.body
  const identifier = type === 'email' ? email : phone
  if (!identifier) {
    throw ApiError.validation({ [type]: `The ${type} to resend the code to is required` })
  }

  const result = await otpService.issue({
    identifier,
    type,
    purpose: 'signup',
    userId: req.user ? req.user.id : null,
  })

  return success(res, { expiresAt: result.expiresAt, debugCode: result.debugCode }, 'Verification code resent')
}
