 

const { failure } = require('./response')

module.exports = function notImplemented(name) {
  return function handler(req, res) {
    return failure(res, `Not implemented yet: ${name} (${req.method} ${req.originalUrl})`, 501)
  }
}
