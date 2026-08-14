// Throw this from any controller/service; errorHandler turns it into the
// standard failure envelope.
//
//   throw new ApiError(404, 'Artist not found')
//   throw ApiError.validation({ email: 'Email already registered' })

class ApiError extends Error {
  constructor(status, message, errors = undefined) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.errors = errors
    this.isApiError = true
    Error.captureStackTrace(this, ApiError)
  }

  static badRequest(message = 'Bad request', errors) {
    return new ApiError(400, message, errors)
  }

  static validation(errors, message = 'Validation failed') {
    return new ApiError(422, message, errors)
  }

  static unauthorized(message = 'Not authenticated') {
    return new ApiError(401, message)
  }

  static forbidden(message = 'You do not have access to this resource') {
    return new ApiError(403, message)
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, message)
  }

  static conflict(message = 'Resource already exists') {
    return new ApiError(409, message)
  }
}

module.exports = ApiError
