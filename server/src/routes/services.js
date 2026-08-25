import { Router } from 'express'
import { PROXY_RE } from '../validators.js'
const err = (res, code, message, status) => res.status(status).json({ error: { code, message } })

export function serviceRoutes({ db, adapters }) {
  const r = Router()
  r.get('/', (req, res) => {
    const counts = db.prepare("SELECT service_key, COUNT(*) c, SUM(status='live') live FROM cookies GROUP BY service_key").all()
    const countMap = new Map(counts.map(x => [x.service_key, x.c]))
    const liveMap = new Map(counts.map(x => [x.service_key, x.live ?? 0]))
    const settings = db.prepare('SELECT service_key, proxy, disabled FROM service_settings').all()
    const disabledMap = new Map(settings.map(x => [x.service_key, x.disabled]))
    const proxyMap = new Map(settings.map(x => [x.service_key, x.proxy]))
    res.json([...adapters.values()].map(a => ({
      key: a.key, name: a.name, disabled: disabledMap.get(a.key) ?? 0, cookieCount: countMap.get(a.key) ?? 0,
      liveCount: liveMap.get(a.key) ?? 0, proxy: proxyMap.get(a.key) ?? null
    })))
  })
  r.patch('/:key', (req, res) => {
    const { proxy, disabled } = req.body || {}
    if (!adapters.has(req.params.key)) return err(res, 'unknown_service', 'unknown service', 400)
    if (proxy !== undefined && proxy !== null && typeof proxy !== 'string') return err(res, 'invalid_proxy', 'proxy must be string or null', 400)
    if (proxy !== undefined && proxy !== null) {
      const trimmed = proxy.trim()
      if (trimmed && !PROXY_RE.test(trimmed)) return err(res, 'invalid_proxy', 'proxy must be http(s):// or socks5(h):// URL', 400)
    }
    if (disabled !== undefined && typeof disabled !== 'boolean') return err(res, 'invalid_disabled', 'disabled must be boolean', 400)
    const current = db.prepare('SELECT proxy, disabled FROM service_settings WHERE service_key=?').get(req.params.key) || { proxy: null, disabled: 0 }
    const next = {
      proxy: proxy === undefined ? current.proxy : (proxy && proxy.trim() ? proxy.trim() : null),
      disabled: disabled === undefined ? current.disabled : (disabled ? 1 : 0)
    }
    db.prepare('INSERT INTO service_settings(service_key, proxy, disabled) VALUES(?,?,?) ON CONFLICT(service_key) DO UPDATE SET proxy=excluded.proxy, disabled=excluded.disabled')
      .run(req.params.key, next.proxy, next.disabled)
    res.json({ ok: true })
  })
  return r
}
