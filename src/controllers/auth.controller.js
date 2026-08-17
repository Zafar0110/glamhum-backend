const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')
const { v4: uuid } = require('uuid')
const env = require('../config/env')
const { uploadRoot, publicUrl } = require('../middleware/upload')
const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success } = require('../utils/response')
const { signToken } = require('../utils/jwt')
const { serializeUser } = require('../utils/serializers')
const otpService = require('../services/otp.service')
const sms = require('../services/sms.service')
const { buildArtistSlug } = require('../utils/slug')

/**
 * Give an artist the readable slug their public profile is served under, e.g.
 * zafar-iqbal-hevanef820. Call it whenever the name or username changes.
 *
 * Two artists genuinely can share a name — the username keeps the slug unique —
 * but a counter is appended anyway so a clash can never break a save.
 */
async function refreshArtistSlug(userId) {
  const user = await queryOne(
    'SELECT id, role, first_name, last_name, username FROM users WHERE id = ? LIMIT 1',
    [userId]
  )
  if (!user || user.role !== 'artist') return null

  const base = buildArtistSlug({
    firstName: user.first_name,
    lastName: user.last_name,
    username: user.username,
  })
  if (!base) return null

  let slug = base
  for (let counter = 2; ; counter += 1) {
    const clash = await queryOne('SELECT id FROM users WHERE slug = ? AND id <> ? LIMIT 1', [
      slug,
      userId,
    ])
    if (!clash) break
    slug = `${base}-${counter}`
  }

  await query('UPDATE users SET slug = ? WHERE id = ?', [slug, userId])
  return slug
}

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

/**
 * Reject a username that belongs to somebody else.
 * `exceptUserId` lets an unverified account keep (or change) its own username.
 */
async function assertUsernameFree(username, exceptUserId = null) {
  const clash = await queryOne(
    'SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1',
    [username, exceptUserId || '']
  )
  if (clash) throw ApiError.validation({ username: 'This username is already taken' })
}

async function register(req, res, role) {
  const { firstName, lastName, username, email, password, agreeToPrivacyPolicy } = req.body
  validateRegistration({ firstName, lastName, username, email, password })

  const cleanEmail = email.trim().toLowerCase()
  const cleanUsername = username.trim().toLowerCase()

  const existing = await queryOne(
    'SELECT id, is_email_verified, is_phone_verified FROM users WHERE email = ? LIMIT 1',
    [cleanEmail]
  )

  /**
   * A CONFIRMED account owns the address — nobody else can take it.
   *
   * "Confirmed" means EITHER channel. Sign-up verifies by SMS when
   * OTP_CHANNEL=phone, which never sets is_email_verified, so checking only
   * that flag left every phone-verified account re-registerable: the branch
   * below reuses the same user row and overwrites its name, username, password
   * and role, handing the account to whoever typed the address.
   */
  if (existing && (existing.is_email_verified || existing.is_phone_verified)) {
    throw ApiError.validation({ email: 'This email is already registered' })
  }

  const passwordHash = await bcrypt.hash(password, env.bcryptRounds)
  const now = new Date()
  const approvalStatus = role === 'artist' ? 'pending' : null

  let id

  if (existing) {
    // Started sign-up before but never confirmed the code — that account is not
    // really theirs yet, so let them go through again rather than locking the
    // address away forever. The details are overwritten with what was just
    // submitted and a fresh code goes out.
    id = existing.id
    await assertUsernameFree(cleanUsername, id)

    await query(
      `UPDATE users
          SET first_name = ?, last_name = ?, username = ?, password_hash = ?,
              role = ?, agreed_to_privacy = ?, approval_status = ?, updated_at = ?
        WHERE id = ?`,
      [
        firstName.trim(),
        lastName.trim(),
        cleanUsername,
        passwordHash,
        role,
        agreeToPrivacyPolicy ? 1 : 0,
        approvalStatus,
        now,
        id,
      ]
    )
  } else {
    id = uuid()
    await assertUsernameFree(cleanUsername)

    await query(
      `INSERT INTO users
         (id, first_name, last_name, username, email, password_hash, role,
          agreed_to_privacy, approval_status, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AED', ?, ?)`,
      [
        id,
        firstName.trim(),
        lastName.trim(),
        cleanUsername,
        cleanEmail,
        passwordHash,
        role,
        agreeToPrivacyPolicy ? 1 : 0,
        approvalStatus,
        now,
        now,
      ]
    )
  }

  // Artists are browsable at /explore/<slug>, so they need one from the start.
  const slug = role === 'artist' ? await refreshArtistSlug(id) : null

  // SPEED: build the response from what we just wrote instead of re-selecting
  // the row — one less round trip on the sign-up path.
  const user = {
    id,
    slug,
    first_name: firstName.trim(),
    last_name: lastName.trim(),
    username: cleanUsername,
    email: cleanEmail,
    phone: null,
    avatar: null,
    role,
    is_email_verified: 0,
    is_phone_verified: 0,
    approval_status: approvalStatus,
    currency: 'AED',
    created_at: now,
    updated_at: now,
  }

  const token = signToken(user)

  // With OTP_CHANNEL=phone the code goes out from /otp/send-phone once the
  // user enters their number on the next screen — there is nothing to send
  // yet here. With OTP_CHANNEL=email it is issued immediately.
  if (env.otp.channel === 'phone') {
    return success(
      res,
      {
        user: serializeUser(user),
        token,
        verificationChannel: 'phone',
        requiresPhoneVerification: true,
        email: cleanEmail,
        otpLength: env.otp.lengthFor('phone'),
      },
      'Account created. Enter your phone number to receive a verification code.',
      201,
      { token }
    )
  }

  // Email is queued in the background (mail.service never blocks the response).
  const otp = await otpService.issue({
    identifier: cleanEmail,
    type: 'email',
    purpose: 'signup',
    userId: id,
    firstName: user.first_name,
  })

  return success(
    res,
    {
      user: serializeUser(user),
      token,
      verificationChannel: 'email',
      requiresEmailVerification: true,
      email: cleanEmail,
      otpLength: otp.length,
      expiresAt: otp.expiresAt,
      debugCode: otp.debugCode,
    },
    'Account created. Check your email for the confirmation code.',
    201,
    { token }
  )
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

  // SPEED: pick the column so the query uses ONE unique index instead of
  // forcing an index merge across uq_users_email + uq_users_username.
  const column = identifier.includes('@') ? 'email' : 'username'
  const user = await queryOne(`SELECT * FROM users WHERE ${column} = ? LIMIT 1`, [identifier])
  if (!user) throw ApiError.unauthorized('Invalid credentials')

  const matches = await bcrypt.compare(password, user.password_hash)
  if (!matches) throw ApiError.unauthorized('Invalid credentials')
  // Deactivated by an admin — refuse the sign-in outright.
  if (!user.is_active) {
    throw ApiError.forbidden(
      'This account has been deactivated by an administrator. Please contact support.'
    )
  }

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
    yearsOfExperience: 'years_of_experience',
  }

  const sets = []
  const values = []

  for (const [field, column] of Object.entries(allowed)) {
    if (req.body[field] === undefined) continue
    let value = req.body[field]
    if (field === 'email') value = String(value).trim().toLowerCase()
    if (field === 'username') value = String(value).trim().toLowerCase()
    if (field === 'hasStudio') value = value ? 1 : 0
    if (field === 'phone' && String(value).trim()) {
      /**
       * Store E.164, the same form sendPhoneOTP writes.
       *
       * Saving the raw input here meant the same number could live as
       * '971554082607' on one account and '+971554082607' on another. The
       * "one phone per account" check compares strings, so the two never
       * matched and a number could be reused — which is how two live accounts
       * ended up sharing one mobile.
       */
      const e164 = sms.toE164(value, req.body.countryCode || req.user.country_code || '')
      if (!sms.isValidPhone(e164)) {
        throw ApiError.validation({ phone: 'Enter a valid phone number, including the country code' })
      }

      const taken = await queryOne(
        'SELECT id FROM users WHERE phone = ? AND id <> ? LIMIT 1',
        [e164, req.user.id]
      )
      if (taken) {
        throw ApiError.validation({ phone: 'This phone number is already used by another account' })
      }

      value = e164
    }
    if (field === 'avatar') {
      // `avatar` is a VARCHAR(255) path, not the picture itself. A base64 data
      // URL would be silently truncated to 255 characters of garbage and the
      // image would break everywhere it is shown — send the file to
      // POST /auth/avatar instead.
      if (String(value).startsWith('data:')) {
        throw ApiError.validation({
          avatar: 'Upload the image file to /auth/avatar rather than sending image data',
        })
      }
      if (String(value).length > 255) {
        throw ApiError.validation({ avatar: 'Avatar path is too long' })
      }
    }
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

  // The profile URL is built from the name and username, so it has to follow
  // them. The old slug stops resolving, which is why /explore/<id> still works.
  if (
    req.body.firstName !== undefined ||
    req.body.lastName !== undefined ||
    req.body.username !== undefined
  ) {
    await refreshArtistSlug(req.user.id)
  }

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id])
  return success(res, { user: serializeUser(user) }, 'Profile updated successfully')
}

/**
 * POST /auth/avatar   (multipart, field name: `avatar`)
 *
 * Stores the picture on disk and keeps only its path in the database, so the
 * same URL can be served to every screen that shows the user — header,
 * dashboards, artist cards, reviews, bookings.
 */
exports.uploadAvatar = async (req, res) => {
  if (!req.file) throw ApiError.validation({ avatar: 'Choose an image to upload' })

  const url = publicUrl(req.file.filename)
  const previous = req.user.avatar

  await query('UPDATE users SET avatar = ? WHERE id = ?', [url, req.user.id])

  // Remove the file this one replaced — but never a bundled /images/... asset.
  if (previous && previous.startsWith('/uploads/')) {
    fs.promises
      .unlink(path.join(uploadRoot, path.basename(previous)))
      .catch(() => {})
  }

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id])
  return success(res, { user: serializeUser(user), avatar: url }, 'Profile photo updated')
}

/** DELETE /auth/avatar — go back to the default picture. */
exports.removeAvatar = async (req, res) => {
  const previous = req.user.avatar

  await query('UPDATE users SET avatar = NULL WHERE id = ?', [req.user.id])

  if (previous && previous.startsWith('/uploads/')) {
    fs.promises
      .unlink(path.join(uploadRoot, path.basename(previous)))
      .catch(() => {})
  }

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id])
  return success(res, { user: serializeUser(user) }, 'Profile photo removed')
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

  const user = await queryOne('SELECT id, first_name FROM users WHERE email = ? LIMIT 1', [email])

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
    firstName: user.first_name,
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
