const env = require('../config/env')
const { failure } = require('../utils/response')

//404 for unmatched routes
function notFound(req, res) {
  return failure(res, `Route not found: ${req.method} ${req.originalUrl}`, 404)
}

 
function errorHandler(err, req, res, next) {
   
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

  
  if (err.stripeType || err.stripeCode) {
    const status = err.stripeType === 'card_error' ? 402 : 400
    console.error(`[stripe] ${err.stripeType || 'error'} ${err.stripeCode || ''}: ${err.message}`)
    return failure(res, err.message, status)
  }
  if (err.stripeUnconfigured) {
    return failure(res, 'Online payments are not switched on yet.', 503)
  }

  // Multer upload errors — say what the limit actually is.
  if (err.code === 'LIMIT_FILE_SIZE') {
    const maxMb = Math.round(env.upload.maxBytes / 1024 / 1024)
    return failure(res, `That image is too large. Each file must be ${maxMb}MB or smaller.`, 413, {
      images: `Each image must be ${maxMb}MB or smaller`,
    })
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return failure(res, 'Too many files in one upload. Please add up to 10 images at a time.', 400)
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
