import { Router } from 'express'
import { encryptJSON, decryptJSON } from '../crypto.js'
import { aw } from '../asyncHandler.js'
import { splitBulk, detectFormat, parseNetscape, parseHeader, parseJsonArray, toHeaderString, toNetscape, MAX_CHUNK_BYTES, MAX_CHUNKS } from '../cookieFormat.js'

const err = (res, code, message, status) => res.status(status).json({ error: { code, message } })
const PUBLIC_COLS = 'id, service_key, label, source_format, status, account_info, last_checked_at, notes, created_at, updated_at'

export function cookieRoutes({ db, engine, adapters }) {
  const r = Router()

  r.get('/', (req, res) => {
    const { service, status, q, page: p } = req.query
    const where = []; const params = []
    if (service) { where.push('service_key = ?'); params.push(service) }
    if (status) { where.push('status = ?'); params.push(status) }
    if (q) {
      const esc = String(q).replace(/[\\%_]/g, m => '\\' + m)
      where.push("(label LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR account_info LIKE ? ESCAPE '\\')")
      params.push(`%${esc}%`, `%${esc}%`, `%${esc}%`)
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM cookies ${clause}`).get(...params).c
    const rawPage = Number(req.query.page)
    const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1; const limit = 50
    const items = db.prepare(`SELECT ${PUBLIC_COLS} FROM cookies ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, (page - 1) * limit)
      .map(row => ({ ...row, account_info: row.account_info ? JSON.parse(row.account_info) : null }))
    res.json({ items, total, page })
  })

  r.post('/', (req, res) => {
    const { service, content, label = '', notes = '' } = req.body || {}
    const adapter = adapters.get(service)
    if (!service || !adapter) return err(res, 'unknown_service', `unknown service: ${service}`, 400)
    if (typeof content !== 'string' || !content.trim()) return err(res, 'invalid_content', 'content is required', 400)
    const chunks = splitBulk(content)
    if (chunks.length > MAX_CHUNKS) return err(res, 'too_many', `max ${MAX_CHUNKS} chunks per import`, 400)
    const created = []; const failed = []
    const now = Date.now()
    const insert = db.prepare(`INSERT INTO cookies(service_key,label,content_enc,source_format,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      try {
        if (Buffer.byteLength(chunk) > MAX_CHUNK_BYTES) throw new Error('chunk exceeds 100KB')
        const format = detectFormat(chunk)
        if (!format) throw new Error('unrecognized cookie format')
        const cookies = format === 'netscape' ? parseNetscape(chunk, adapter.defaultDomain) : format === 'json' ? parseJsonArray(chunk, adapter.defaultDomain) : parseHeader(chunk, adapter.defaultDomain)
        const info = insert.run(service, label, encryptJSON(cookies), format, notes, now, now)
        const row = db.prepare(`SELECT ${PUBLIC_COLS} FROM cookies WHERE id=?`).get(info.lastInsertRowid)
        created.push({ ...row, account_info: row.account_info ? JSON.parse(row.account_info) : null })
      } catch (e) { failed.push({ index: i, error: e.message }) }
    }
    res.json({ created, failed })
  })

  r.patch('/:id', (req, res) => {
    const { label, notes, service } = req.body || {}
    const row = db.prepare('SELECT id FROM cookies WHERE id=?').get(req.params.id)
    if (!row) return err(res, 'not_found', 'cookie not found', 404)
    if (service !== undefined && !adapters.has(service)) return err(res, 'unknown_service', `unknown service: ${service}`, 400)
    db.prepare('UPDATE cookies SET label=COALESCE(?, label), notes=COALESCE(?, notes), service_key=COALESCE(?, service_key), updated_at=? WHERE id=?')
      .run(label ?? null, notes ?? null, service ?? null, Date.now(), row.id)
    const updated = db.prepare(`SELECT ${PUBLIC_COLS} FROM cookies WHERE id=?`).get(row.id)
    updated.account_info = updated.account_info ? JSON.parse(updated.account_info) : null
    res.json(updated)
  })

  r.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM cookies WHERE id=?').run(req.params.id)
    res.json({ ok: true })
  })

  r.get('/:id/export', (req, res) => {
    const row = db.prepare('SELECT * FROM cookies WHERE id=?').get(req.params.id)
    if (!row) return err(res, 'not_found', 'cookie not found', 404)
    const format = req.query.format === 'netscape' ? 'netscape' : 'header'
    const cookies = decryptJSON(row.content_enc)
    res.json({ content: format === 'netscape' ? toNetscape(cookies) : toHeaderString(cookies) })
  })

  r.get('/:id/logs', (req, res) => {
    const raw = Number(req.query.limit)
    const limit = Number.isInteger(raw) && raw >= 1 && raw <= 200 ? raw : 50
    const items = db.prepare('SELECT * FROM check_logs WHERE cookie_id=? ORDER BY id DESC LIMIT ?').all(req.params.id, limit)
    res.json({ items })
  })

  r.post('/:id/check', aw(async (req, res) => {
    try {
      const status = await engine.runCheck(Number(req.params.id))
      res.json({ status })
    } catch (e) { err(res, e.code || 'check_failed', e.message, e.status || 500) }
  }))

  r.post('/:id/nftoken', aw(async (req, res) => {
    try {
      res.json(await engine.getNftoken(Number(req.params.id)))
    } catch (e) { err(res, e.code || 'nftoken_failed', e.message, e.status || 500) }
  }))

  r.post('/check-all', (req, res) => {
    try {
      res.json(engine.startCheckAll(req.body?.service || undefined))
    } catch (e) { err(res, e.code || 'check_failed', e.message, e.status || 500) }
  })

  r.get('/check-all', (req, res) => res.json(engine.jobStatus()))

  return r
}
