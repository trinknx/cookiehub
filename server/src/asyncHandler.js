// Express 4 does not catch rejected promises from async route handlers — without
// this wrapper a rejection leaves the request hanging until the client times out.
export const aw = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
