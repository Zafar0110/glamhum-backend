// Response envelope.
//
// The Next.js frontend (see frontend/lib/api.ts) reads every response as
//   { success, message, data: { ... }, ...extra }
// where `extra` carries pagination fields (total, count, page, pages,
// totalPages). Keep this shape for every endpoint or the UI stops parsing.

/** 200/201 success envelope. */
function success(res, data = {}, message = 'OK', status = 200, extra = {}) {
  return res.status(status).json({ success: true, message, data, ...extra })
}

/** Success envelope for a paginated list. */
function paginated(res, data, { total = 0, page = 1, limit = 10 }, message = 'OK') {
  const pages = Math.max(1, Math.ceil(total / limit))
  return res.status(200).json({
    success: true,
    message,
    data,
    total,
    count: Array.isArray(data) ? data.length : total,
    page,
    pages,
    totalPages: pages,
  })
}

/** Error envelope. `errors` holds per-field validation messages. */
function failure(res, message = 'Something went wrong', status = 400, errors = undefined) {
  const body = { success: false, message }
  if (errors) body.errors = errors
  return res.status(status).json(body)
}

module.exports = { success, paginated, failure }
