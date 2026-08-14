// Wraps an async route handler so rejected promises reach the error middleware
// instead of hanging the request.
//
//   router.get('/', asyncHandler(async (req, res) => { ... }))

module.exports = function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}
