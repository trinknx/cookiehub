import { Router } from 'express'
import { encryptJSON, decryptJSON } from '../crypto.js'
import { aw } from '../asyncHandler.js'
import { splitBulkCounted, detectFormat, parseNetscape, parseHeader, parseJsonArray, toHeaderString, toNetscape, toCookieEditor, MAX_CHUNK_BYTES, MAX_CHUNKS } from '../cookieFormat.js'

const err = (res, code, message, status) => res.status(status).json({ error: { code, message } })
const PUBLIC_COLS = 'id, service_key, label, source_format, status, account_info, last_checked_at, notes, created_at, updated_at'
// Tag sorting: whitelisted SQL fragments only — the client's ?sort= value is a
// KEY into this map, never interpolated text. json_valid guards every extract
// (malformed legacy account_info rows must not 500 the list). Quality rank
// mirrors the client's qualityTag precedence: 4K/UHD > 1080/HD > 720 > SD.
const QQUAL = "json_extract(account_info,'$.extra.videoQuality')"
const SORTS = {
  plan: "json_extract(account_info,'$.plan')",
  country: "json_extract(account_info,'$.country')",
  billing: "json_extract(account_info,'$.nextBillingIso')",
  quality: `CASE WHEN json_valid(account_info) THEN (CASE
    WHEN lower(${QQUAL}) LIKE '%4k%' OR lower(${QQUAL}) LIKE '%uhd%' THEN 4
    WHEN lower(${QQUAL}) LIKE '%720%' THEN 2
    WHEN lower(${QQUAL}) LIKE '%hd%' OR lower(${QQUAL}) LIKE '%1080%' THEN 3
    WHEN lower(${QQUAL}) LIKE '%sd%' THEN 1 END) END` // no rank / invalid JSON → NULL → NULLS LAST
}
const sortExpr = raw => {
  if (typeof raw !== 'string' || !raw) return null
  const desc = raw.startsWith('-')
  const expr = SORTS[desc ? raw.slice(1) : raw]
  return expr ? `${expr} ${desc ? 'DESC' : 'ASC'} NULLS LAST, id DESC` : null
}
// match SQL lower() (ASCII-only) when comparing item emails against dup-set keys
const asciiLower = s => String(s).replace(/[A-Z]/g, c => c.toLowerCase())
const parseAccountInfo = raw => { if (!raw) return null; try { return JSON.parse(raw) } catch { return null } } // malformed text → null, not a 500

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
    const dupCond = "json_valid(account_info) AND json_extract(account_info,'$.email') IS NOT NULL"
    const dupWhere = service ? `WHERE service_key = ? AND ${dupCond}` : `WHERE ${dupCond}` // service filter only — badge must reflect removal scope, not list filters
    const dupSet = new Set(db.prepare(`SELECT lower(json_extract(account_info,'$.email')) e FROM cookies ${dupWhere} GROUP BY e HAVING COUNT(*)>1`).all(...(service ? [service] : [])).map(r => r.e))
    const total = db.prepare(`SELECT COUNT(*) c FROM cookies ${clause}`).get(...params).c
    const rawPage = Number(req.query.page)
    const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1; const limit = 50
    const items = db.prepare(`SELECT ${PUBLIC_COLS} FROM cookies ${clause} ORDER BY ${sortExpr(req.query.sort) || 'id DESC'} LIMIT ? OFFSET ?`)
      .all(...params, limit, (page - 1) * limit)
      .map(row => {
        const account_info = parseAccountInfo(row.account_info)
        const email = account_info?.email != null ? asciiLower(account_info.email) : null
        return { ...row, account_info, dup: email ? dupSet.has(email) : false }
      })
    res.json({ items, total, page })
  })

  r.post('/', (req, res) => {
    const { service, content, label = '', notes = '' } = req.body || {}
    const adapter = adapters.get(service)
    if (!service || !adapter) return err(res, 'unknown_service', `unknown service: ${service}`, 400)
    if (typeof content !== 'string' || !content.trim()) return err(res, 'invalid_content', 'content is required', 400)
    const { chunks, skipped } = splitBulkCounted(content)
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
    res.json({ created, failed, skipped })
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
    const format = ['netscape', 'json'].includes(req.query.format) ? req.query.format : 'header'
    const cookies = decryptJSON(row.content_enc)
    const content = format === 'netscape' ? toNetscape(cookies) : format === 'json' ? toCookieEditor(cookies) : toHeaderString(cookies)
    res.json({ content })
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

  r.post('/:id/linktv', aw(async (req, res) => {
    const { code } = req.body || {}
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{4,12}$/.test(code.trim())) {
      return err(res, 'invalid_code', 'code must be 4-12 letters/digits', 400)
    }
    try {
      res.json(await engine.linkTv(Number(req.params.id), code.trim()))
    } catch (e) { err(res, e.code || 'linktv_failed', e.message, e.status || 500) }
  }))

  r.post('/:id/family', aw(async (req, res) => {
    try {
      res.json(await engine.getFamily(Number(req.params.id)))
    } catch (e) { err(res, e.code || 'family_failed', e.message, e.status || 500) }
  }))

  r.post('/remove-die', (req, res) => {
    const { service } = req.body || {}
    if (service !== undefined && !adapters.has(service)) return err(res, 'unknown_service', `unknown service: ${service}`, 400)
    const info = service
      ? db.prepare("DELETE FROM cookies WHERE status='die' AND service_key=?").run(service)
      : db.prepare("DELETE FROM cookies WHERE status='die'").run()
    res.json({ removed: info.changes })
  })

  r.post('/remove-duplicates', (req, res) => {
    const { service } = req.body || {}
    if (service !== undefined && !adapters.has(service)) return err(res, 'unknown_service', `unknown service: ${service}`, 400)
    const select = db.prepare(`SELECT id, status, lower(json_extract(account_info,'$.email')) e FROM cookies WHERE json_valid(account_info) AND json_extract(account_info,'$.email') IS NOT NULL${service ? ' AND service_key=?' : ''}`)
    const run = db.transaction(() => {
      const rows = select.all(...(service ? [service] : []))
      const groups = new Map()
      for (const row of rows) {
        if (!groups.has(row.e)) groups.set(row.e, [])
        groups.get(row.e).push(row)
      }
      const delIds = []
      let groupCount = 0
      for (const list of groups.values()) {
        if (list.length < 2) continue
        groupCount++
        const ranked = list.sort((a, b) => (a.status === 'live' ? 0 : 1) - (b.status === 'live' ? 0 : 1) || b.id - a.id)
        delIds.push(...ranked.slice(1).map(r => r.id))
      }
      // json_each: one bind param regardless of id count
      const removed = delIds.length ? db.prepare('DELETE FROM cookies WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(delIds)).changes : 0
      return { removed, groupCount }
    })
    const { removed, groupCount } = run()
    res.json({ removed, kept: groupCount, groups: groupCount })
  })

  r.post('/check-all', (req, res) => {
    const { service, status } = req.body || {}
    if (status !== undefined && (typeof status !== 'string' || !/^(unknown|live|die)$/.test(status))) {
      return err(res, 'invalid_status', `invalid status filter: ${status}`, 400)
    }
    try {
      res.json(engine.startCheckAll(service || undefined, status))
    } catch (e) { err(res, e.code || 'check_failed', e.message, e.status || 500) }
  })

  r.get('/check-all', (req, res) => res.json(engine.jobStatus()))

  return r
}
