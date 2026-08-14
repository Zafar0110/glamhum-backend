// Authentication + role guards.
//
//   router.get('/me', authenticate, handler)
//   router.get('/admin/stats', authenticate, authorize('admin'), handler)

const ApiError = require('../utils/ApiError')
const { verifyToken } = require('../utils/jwt')
const { queryOne } = require('../config/db')

function extractToken(req) {
  const header = req.headers.authorization || ''
  if (header.startsWith('Bearer ')) return header.slice(7).trim()
  return null
}

/** Requires a valid token; loads the user row onto req.user. */
async function authenticate(req, res, next) {
  try {
    const token = extractToken(req)
    if (!token) throw ApiError.unauthorized('Authentication token missing')

    let payload
    try {
      payload = verifyToken(token)
    } catch (error) {
      throw ApiError.unauthorized(
        error.name === 'TokenExpiredError' ? 'Session expired, please sign in again' : 'Invalid token'
      )
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ? LIMIT 1', [payload.sub])
    if (!user) throw ApiError.unauthorized('Account no longer exists')
    if (user.is_active === 0) throw ApiError.forbidden('Account is disabled')

    req.user = user
    req.token = token
    next()
  } catch (error) {
    next(error)
  }
}

/** Restricts a route to one or more roles. Use after authenticate. */
function authorize(...roles) {
  return function guard(req, res, next) {
    if (!req.user) return next(ApiError.unauthorized())
    if (roles.length && !roles.includes(req.user.role)) {
      return next(ApiError.forbidden(`This route is restricted to: ${roles.join(', ')}`))
    }
    next()
  }
}

/** Attaches req.user when a valid token is present, but never rejects. */
async function optionalAuth(req, res, next) {
  const token = extractToken(req)
  if (!token) return next()
  try {
    const payload = verifyToken(token)
    req.user = await queryOne('SELECT * FROM users WHERE id = ? LIMIT 1', [payload.sub])
  } catch (error) {
    // ignore — route stays public
  }
  next()
}

module.exports = { authenticate, authorize, optionalAuth }
