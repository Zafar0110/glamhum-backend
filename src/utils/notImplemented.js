// Placeholder for endpoints that are declared but not built yet.
// Every route the frontend calls is registered so the API surface is visible
// in one place; swap the handler for a real controller as you build each one.

const { failure } = require('./response')

module.exports = function notImplemented(name) {
  return function handler(req, res) {
    return failure(res, `Not implemented yet: ${name} (${req.method} ${req.originalUrl})`, 501)
  }
}
