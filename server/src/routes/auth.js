import { Router } from 'express'
import { randomBytes, createHash } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import { getSetting } from '../db.js'
import { aw } from '../asyncHandler.js'

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
const attempts = new Map() // ip → { count, until }

const sha256 = s => createHash('sha256').update(s).digest('hex')
const err = (res, code, message, status) => res.status(status).json({ error: { code, message } })

function createSession(db, res) {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  db.prepare('INSERT INTO sessions(token_hash, expires_at, created_at) VALUES(?,?,?)').run(sha256(token), now + SESSION_TTL_MS, now)
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_TTL_MS })
}

export function authRoutes(db) {
  const r = Router()
  r.get('/session', (req, res) => {
    const hasPw = !!getSetting(db, 'password_hash')
    res.json({ authenticated: !!(req.cookies?.sid && validSession(db, req.cookies.sid)), needsSetup: !hasPw })
  })
  r.post('/setup', aw(async (req, res) => {
    if (getSetting(db, 'password_hash')) return err(res, 'already_setup', 'password already set', 409)
    const pw = req.body?.password
    if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) return err(res, 'invalid_password', 'password must be 8-128 chars', 400)
    const info = db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('password_hash',?)").run(await hash(pw))
    if (info.changes === 0) return err(res, 'already_setup', 'password already set', 409)
    createSession(db, res)
    res.json({ ok: true })
  }))
  r.post('/login', aw(async (req, res) => {
    const a = attempts.get(req.ip) || { count: 0, until: 0 }
    if (Date.now() < a.until) return err(res, 'rate_limited', 'too many attempts, try later', 429)
    const pw = req.body?.password
    const stored = getSetting(db, 'password_hash')
    if (!stored || typeof pw !== 'string' || !(await verify(stored, pw))) {
      a.count++
      if (a.count >= 5) { a.until = Date.now() + 15 * 60 * 1000; a.count = 0 }
      attempts.set(req.ip, a)
      return err(res, 'bad_credentials', 'invalid password', 401)
    }
    attempts.delete(req.ip)
    createSession(db, res)
    res.json({ ok: true })
  }))
  r.post('/logout', (req, res) => {
    if (req.cookies?.sid) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(req.cookies.sid))
    res.clearCookie('sid')
    res.json({ ok: true })
  })
  r.use((req, res) => err(res, 'not_found', 'unknown auth route', 404))
  return r
}

function validSession(db, token) {
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(sha256(token))
  return !!row && row.expires_at > Date.now()
}

export function requireAuth(db) {
  return (req, res, next) => {
    if (req.cookies?.sid && validSession(db, req.cookies.sid)) return next()
    err(res, 'unauthenticated', 'login required', 401)
  }
}

export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (req.get('x-requested-with') === 'XMLHttpRequest') return next()
  err(res, 'csrf', 'missing X-Requested-With header', 403)
}
