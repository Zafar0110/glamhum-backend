const env = require('../config/env')
const { failure } = require('../utils/response')

/** 404 for unmatched routes. */
function notFound(req, res) {
  return failure(res, `Route not found: ${req.method} ${req.originalUrl}`, 404)
}

/** Final error middleware — every thrown error lands here. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Known, deliberate errors
  if (err.isApiError) {
    return failure(res, err.message, err.status, err.errors)
  }

  // MySQL errors worth translating
  if (err.code === 'ER_DUP_ENTRY') {
    return failure(res, 'That record already exists', 409)
  }
  if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_ROW_IS_REFERENCED_2') {
    return failure(res, 'Related record missing or still in use', 409)
  }
  if (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST') {
    return failure(res, 'Database connection failed', 503)
  }

  // Multer upload errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return failure(res, 'File is too large', 413)
  }

  // Anything else is a bug
  console.error('[error]', err)
  return failure(
    res,
    env.isProduction ? 'Internal server error' : err.message || 'Internal server error',
    err.status || 500,
    env.isProduction ? undefined : { stack: err.stack }
  )
}

module.exports = { notFound, errorHandler }
