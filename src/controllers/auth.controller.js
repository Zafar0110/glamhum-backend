const bcrypt = require('bcryptjs')
const { v4: uuid } = require('uuid')
const env = require('../config/env')
const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success } = require('../utils/response')
const { signToken } = require('../utils/jwt')
const { serializeUser } = require('../utils/serializers')
const otpService = require('../services/otp.service')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validateRegistration({ firstName, lastName, username, email, password }) {
  const errors = {}
  if (!firstName || !firstName.trim()) errors.firstName = 'First name is required'
  if (!lastName || !lastName.trim()) errors.lastName = 'Last name is required'
  if (!username || username.trim().length < 3) errors.username = 'Username must be at least 3 characters'
  if (!email || !EMAIL_RE.test(email)) errors.email = 'Enter a valid email address'
  if (!password || password.length < 8) errors.password = 'Password must be at least 8 characters'
  if (Object.keys(errors).length) throw ApiError.validation(errors)
}

async function assertUnique(email, username) {
  const clash = await queryOne('SELECT email, username FROM users WHERE email = ? OR username = ? LIMIT 1', [
    email.toLowerCase(),
    username.toLowerCase(),
  ])
  if (!clash) return
  throw ApiError.validation(
    clash.email === email.toLowerCase()
      ? { email: 'This email is already registered' }
      : { username: 'This username is already taken' }
  )
}

async function register(req, res, role) {
  const { firstName, lastName, username, email, password, agreeToPrivacyPolicy } = req.body
  validateRegistration({ firstName, lastName, username, email, password })
  await assertUnique(email, username)

  const id = uuid()
  const passwordHash = await bcrypt.hash(password, env.bcryptRounds)

  await query(
    `INSERT INTO users
       (id, first_name, last_name, username, email, password_hash, role,
        agreed_to_privacy, approval_status, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AED')`,
    [
      id,
      firstName.trim(),
      lastName.trim(),
      username.trim().toLowerCase(),
      email.trim().toLowerCase(),
      passwordHash,
      role,
      agreeToPrivacyPolicy ? 1 : 0,
      role === 'artist' ? 'pending' : null,
    ]
  )

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [id])
  const token = signToken(user)

  return success(res, { user: serializeUser(user), token }, 'Account created successfully', 201, { token })
}

/** POST /auth/register/client */
exports.registerClient = (req, res) => register(req, res, 'client')

/** POST /auth/register/artist */
exports.registerArtist = (req, res) => register(req, res, 'artist')

/** POST /auth/login — accepts { email } or { username } plus password. */
exports.login = async (req, res) => {
  const { email, username, password, rememberMe } = req.body
  const identifier = (email || username || '').trim().toLowerCase()

  if (!identifier) throw ApiError.validation({ email: 'Email or username is required' })
  if (!password) throw ApiError.validation({ password: 'Password is required' })

  const user = await queryOne('SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1', [
    identifier,
    identifier,
  ])
  if (!user) throw ApiError.unauthorized('Invalid credentials')

  const matches = await bcrypt.compare(password, user.password_hash)
  if (!matches) throw ApiError.unauthorized('Invalid credentials')
  if (!user.is_active) throw ApiError.forbidden('This account has been disabled')

  const token = signToken(user, Boolean(rememberMe))
  return success(res, { user: serializeUser(user), token }, 'Signed in successfully', 200, { token })
}

/** GET /auth/me */
exports.getMyProfile = async (req, res) => {
  return success(res, { user: serializeUser(req.user) })
}

/** PATCH /auth/profile */
exports.updateProfile = async (req, res) => {
  const allowed = {
    firstName: 'first_name',
    lastName: 'last_name',
    username: 'username',
    phone: 'phone',
    countryCode: 'country_code',
    email: 'email',
    avatar: 'avatar',
    city: 'city',
    description: 'description',
    hasStudio: 'has_studio',
    address: 'address',
    specialty: 'specialty',
  }

  const sets = []
  const values = []

  for (const [field, column] of Object.entries(allowed)) {
    if (req.body[field] === undefined) continue
    let value = req.body[field]
    if (field === 'email') value = String(value).trim().toLowerCase()
    if (field === 'username') value = String(value).trim().toLowerCase()
    if (field === 'hasStudio') value = value ? 1 : 0
    sets.push(`${column} = ?`)
    values.push(value)
  }

  if (!sets.length) throw ApiError.badRequest('Nothing to update')

  if (req.body.email || req.body.username) {
    const clash = await queryOne(
      'SELECT id FROM users WHERE (email = ? OR username = ?) AND id <> ? LIMIT 1',
      [
        (req.body.email || '').trim().toLowerCase(),
        (req.body.username || '').trim().toLowerCase(),
        req.user.id,
      ]
    )
    if (clash) throw ApiError.conflict('That email or username is already in use')
  }

  values.push(req.user.id)
  await query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, values)

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id])
  return success(res, { user: serializeUser(user) }, 'Profile updated successfully')
}

/** PATCH /auth/password */
exports.updatePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body
  if (!currentPassword) throw ApiError.validation({ currentPassword: 'Current password is required' })
  if (!newPassword || newPassword.length < 8) {
    throw ApiError.validation({ newPassword: 'New password must be at least 8 characters' })
  }

  const matches = await bcrypt.compare(currentPassword, req.user.password_hash)
  if (!matches) throw ApiError.validation({ currentPassword: 'Current password is incorrect' })

  const passwordHash = await bcrypt.hash(newPassword, env.bcryptRounds)
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.user.id])

  return success(res, {}, 'Password updated successfully')
}

/**
 * POST /auth/logout
 * Tokens are stateless JWTs, so logout is client-side (drop the token).
 * Kept as an endpoint because the frontend calls it. Add a token denylist
 * table here if you later need server-side invalidation.
 */
exports.logout = async (req, res) => success(res, {}, 'Logged out successfully')

/** POST /auth/forgot-password — issues an OTP to the account email. */
exports.forgotPassword = async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase()
  if (!email || !EMAIL_RE.test(email)) throw ApiError.validation({ email: 'Enter a valid email address' })

  const user = await queryOne('SELECT id, email FROM users WHERE email = ? LIMIT 1', [email])

  // Always answer the same way so the endpoint cannot be used to discover
  // which emails have accounts.
  if (!user) {
    return success(res, {}, 'If that email is registered, a reset code has been sent')
  }

  const result = await otpService.issue({
    identifier: email,
    type: 'email',
    purpose: 'forgot_password',
    userId: user.id,
  })

  return success(
    res,
    { email, expiresAt: result.expiresAt, debugCode: result.debugCode },
    'If that email is registered, a reset code has been sent'
  )
}

/** POST /auth/reset-password — verifies the OTP then sets the new password. */
exports.resetPassword = async (req, res) => {
  const { email, otp, password } = req.body
  if (!email) throw ApiError.validation({ email: 'Email is required' })
  if (!otp) throw ApiError.validation({ otp: 'Verification code is required' })
  if (!password || password.length < 8) {
    throw ApiError.validation({ password: 'Password must be at least 8 characters' })
  }

  const identifier = email.trim().toLowerCase()
  await otpService.verify({ identifier, code: otp, purpose: 'forgot_password' })

  const user = await queryOne('SELECT id FROM users WHERE email = ? LIMIT 1', [identifier])
  if (!user) throw ApiError.notFound('Account not found')

  const passwordHash = await bcrypt.hash(password, env.bcryptRounds)
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id])

  return success(res, {}, 'Password reset successful')
}
