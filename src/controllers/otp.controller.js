 

const env = require('../config/env')
const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success } = require('../utils/response')
const { signToken } = require('../utils/jwt')
const { serializeUser } = require('../utils/serializers')
const otpService = require('../services/otp.service')
const sms = require('../services/sms.service')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

//POST /api/otp/send-email
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

//POST /api/otp/verify-email
exports.verifyEmailOTP = async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  const otp = String(req.body.otp || '').trim()

  const length = env.otp.lengthFor('email')
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

//POST /api/otp/resend
exports.resendOTP = async (req, res) => {
  const purpose = req.body?.purpose === 'forgot_password' ? 'forgot_password' : 'signup'
 
  const wantsSms = Boolean(req.body?.phone) && purpose === 'signup'

  if (wantsSms) {
    const e164 = sms.toE164(req.body.phone, req.body.countryCode)
    if (!sms.isValidPhone(e164)) throw ApiError.validation({ phone: 'Enter a valid phone number' })

    
    const user = await queryOne('SELECT id, first_name, email FROM users WHERE phone = ? LIMIT 1', [e164])
    if (!user) throw ApiError.validation({ phone: 'No account found for this phone number' })

     
    const sent = await sendPhoneCode({ e164, user })

    return success(
      res,
      {
        phone: e164,
        otpLength: sent.otpLength,
        provider: sent.provider,
        expiresAt: sent.expiresAt,
        deliveredVia: sent.deliveredVia || 'phone',
        fallbackEmail: user.email,
        debugCode: sent.debugCode,
      },
      deliveryMessage(sent, { phone: e164, email: user.email })
    )
  }

  const email = String(req.body?.email || '').trim().toLowerCase()
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

  return success(
    res,
    { email, otpLength: result.length, expiresAt: result.expiresAt, debugCode: result.debugCode },
    'A new code has been sent'
  )
}

//Twilio Verify when configured
async function sendPhoneCode({ e164, user, purpose = 'signup' }) {
  if (env.sms.useVerify) {
    try {
      await sms.startVerification(e164, 'sms')
      return { provider: 'twilio_verify', otpLength: 6 }
    } catch (error) {
      console.error(
        `[otp] Twilio Verify failed for ${e164} (${error.twilioCode}): ${error.message} — falling back to direct SMS`
      )
    }
  }

  const result = await otpService.issue({
    identifier: e164,
    type: 'phone',
    purpose,
    userId: user.id,
    firstName: user.first_name, 
    fallbackEmail: user.email,
  })

  return {
    provider: 'direct_sms',
    otpLength: result.length,
    expiresAt: result.expiresAt, 
    deliveredVia: result.deliveredVia,
    debugCode: result.debugCode,
  }
}

//The message the verify screen shows, matched to the channel actually used
function deliveryMessage(sent, { phone, email }) {
  if (sent.deliveredVia === 'email') {
    return `We couldn't deliver a text to ${phone}, so your code was emailed to ${email} instead.`
  }
  if (sent.deliveredVia === 'console') {
    return 'Verification code generated. SMS is not configured yet — check the server console for the code.'
  }
  return `Verification code sent to ${phone}`
}

//POST /api/otp/send-phone
exports.sendPhoneOTP = async (req, res) => {
  const { phone, countryCode } = req.body || {}
  if (!phone || !String(phone).trim()) {
    throw ApiError.validation({ phone: 'Phone number is required' })
  }

  const e164 = sms.toE164(phone, countryCode)
  if (!sms.isValidPhone(e164)) {
    throw ApiError.validation({ phone: 'Enter a valid phone number, including the country code' })
  }

  const user = await resolveUser(req)
  if (!user) {
    throw ApiError.validation({ phone: 'We could not find your account. Please sign up again.' })
  }

  // One phone number per account.
  const taken = await queryOne('SELECT id FROM users WHERE phone = ? AND id <> ? LIMIT 1', [
    e164,
    user.id,
  ])
  if (taken) {
    throw ApiError.validation({ phone: 'This phone number is already used by another account' })
  }

  await query('UPDATE users SET phone = ?, country_code = ? WHERE id = ?', [
    e164,
    countryCode || null,
    user.id,
  ])

  const sent = await sendPhoneCode({ e164, user })

  return success(
    res,
    {
      phone: e164, 
      otpLength: sent.otpLength,
      provider: sent.provider,
      expiresAt: sent.expiresAt,
      smsConfigured: env.sms.configured, 
      deliveredVia: sent.deliveredVia || 'phone', 
      fallbackEmail: user.email,
      debugCode: sent.debugCode,
    },
    deliveryMessage(sent, { phone: e164, email: user.email })
  )
}

//GET /api/otp/delivery-status?phone=+9715
exports.getDeliveryStatus = async (req, res) => {
  const e164 = sms.toE164(req.query.phone, req.query.countryCode)
  if (!sms.isValidPhone(e164)) throw ApiError.validation({ phone: 'Enter a valid phone number' })

  const row = await queryOne(
    `SELECT o.delivered_via, u.email
       FROM otps o
       LEFT JOIN users u ON u.id = o.user_id
      WHERE o.identifier = ? AND o.consumed_at IS NULL
      ORDER BY o.created_at DESC LIMIT 1`,
    [e164]
  )

  const deliveredVia = row?.delivered_via || 'phone'
  return success(res, {
    phone: e164,
    deliveredVia,
    fallbackEmail: row?.email || null,
    message:
      deliveredVia === 'email'
        ? `We couldn't deliver a text to ${e164}, so your code was emailed to ${row?.email} instead.`
        : null,
  })
}

//POST /api/otp/verify-phone
exports.verifyPhoneOTP = async (req, res) => {
  const { phone, countryCode } = req.body || {}
  const otp = String(req.body?.otp || '').trim()
  const length = env.otp.lengthFor('phone')

  const e164 = sms.toE164(phone, countryCode)
  if (!sms.isValidPhone(e164)) throw ApiError.validation({ phone: 'Phone number is required' })
  if (!otp) throw ApiError.validation({ otp: `Please enter the ${length}-digit code` })
  if (!new RegExp(`^\\d{${length}}$`).test(otp)) {
    throw ApiError.validation({ otp: `The code must be ${length} digits` })
  }

 
  let checkedByVerify = false
  if (env.sms.useVerify) {
    try {
      const outcome = await sms.checkVerification(e164, otp)
      if (outcome.approved) {
        checkedByVerify = true
      } else if (outcome.reason !== 'expired') {
        throw ApiError.validation({ otp: 'The code you entered is incorrect.' })
      }
    } catch (error) {
      if (error.isApiError) throw error
      console.error(`[otp] Twilio Verify check failed for ${e164}: ${error.message}`)
    }
  }

  if (!checkedByVerify) {
    await otpService.verify({ identifier: e164, code: otp, purpose: 'signup' })
  }

  const user = await queryOne('SELECT * FROM users WHERE phone = ? LIMIT 1', [e164])
  if (!user) throw ApiError.notFound('Account not found for that number')

  if (!user.is_phone_verified) {
    await query('UPDATE users SET is_phone_verified = 1 WHERE id = ?', [user.id])
    user.is_phone_verified = 1
  }

  const token = signToken(user)
  return success(
    res,
    { verified: true, user: serializeUser(user), token },
    'Phone number verified successfully',
    200,
    { token }
  )
}

 
async function resolveUser(req) {
  if (req.user) return req.user

  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!email) return null
  return queryOne('SELECT * FROM users WHERE email = ? LIMIT 1', [email])
}
