import { Router } from 'express'
import { hash, verify } from '@node-rs/argon2'
import { getSetting, setSetting } from '../db.js'
import { aw } from '../asyncHandler.js'
import { PROXY_RE } from '../validators.js'
const err = (res, code, message, status) => res.status(status).json({ error: { code, message } })

export function settingsRoutes({ db, scheduler }) {
  const r = Router()
  const read = () => ({
    autoCheckEnabled: getSetting(db, 'auto_check_enabled') === 'true',
    autoCheckIntervalHours: Number(getSetting(db, 'auto_check_interval_hours')) || 6,
    proxyGlobal: getSetting(db, 'proxy_global') || null
  })

  r.get('/', (req, res) => res.json(read()))

  r.put('/', (req, res) => {
    const b = req.body || {}
    if (b.autoCheckEnabled !== undefined && typeof b.autoCheckEnabled !== 'boolean') {
      return err(res, 'invalid_enabled', 'autoCheckEnabled must be boolean', 400)
    }
    if (b.autoCheckIntervalHours !== undefined && (typeof b.autoCheckIntervalHours !== 'number' || !Number.isInteger(b.autoCheckIntervalHours))) {
      return err(res, 'invalid_interval', 'interval must be integer 1-168 hours', 400)
    }
    if (b.proxyGlobal !== undefined && b.proxyGlobal !== null && typeof b.proxyGlobal !== 'string') {
      return err(res, 'invalid_proxy', 'proxy must be string or null', 400)
    }
    if (b.autoCheckIntervalHours !== undefined) {
      const h = Number(b.autoCheckIntervalHours)
      if (h < 1 || h > 168) return err(res, 'invalid_interval', 'interval must be integer 1-168 hours', 400)
    }
    if (b.proxyGlobal !== undefined && b.proxyGlobal !== null && !PROXY_RE.test(b.proxyGlobal)) {
      return err(res, 'invalid_proxy', 'proxy must be http(s):// or socks5(h):// URL', 400)
    }
    if (b.autoCheckEnabled !== undefined) setSetting(db, 'auto_check_enabled', !!b.autoCheckEnabled)
    if (b.autoCheckIntervalHours !== undefined) setSetting(db, 'auto_check_interval_hours', Number(b.autoCheckIntervalHours))
    if (b.proxyGlobal !== undefined) setSetting(db, 'proxy_global', b.proxyGlobal === null ? '' : String(b.proxyGlobal))
    scheduler?.reschedule?.()
    res.json(read())
  })

  r.post('/password', aw(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {}
    const stored = getSetting(db, 'password_hash')
    if (!stored || typeof currentPassword !== 'string' || !(await verify(stored, currentPassword))) {
      return err(res, 'bad_credentials', 'current password incorrect', 401)
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return err(res, 'invalid_password', 'new password must be 8-128 chars', 400)
    }
    setSetting(db, 'password_hash', await hash(newPassword))
    res.json({ ok: true })
  }))
  return r
}
