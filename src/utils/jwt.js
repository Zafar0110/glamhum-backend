const jwt = require('jsonwebtoken')
const env = require('../config/env')

//Sign an access token
function signToken(user, rememberMe = false) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    env.jwt.secret,
    { expiresIn: rememberMe ? env.jwt.rememberMeExpiresIn : env.jwt.expiresIn }
  )
}

//Verify a token; throws when invalid/expired
function verifyToken(token) {
  return jwt.verify(token, env.jwt.secret)
}

module.exports = { signToken, verifyToken }
