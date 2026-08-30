import { Router, raw } from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { decryptJSON } from '../crypto.js'
import { aw } from '../asyncHandler.js'

const err = (res, code, message, status) => res.status(status).json({ error: { code, message } })
// child (check_logs) before parent (cookies) so plain FK constraints hold even
// without cascades; sessions is deliberately NOT restored — the restoring
// browser keeps its own session regardless of the backup's origin
const TABLES = ['check_logs', 'cookies', 'settings', 'service_settings']

export function backupRoutes({ db }) {
  const r = Router()

  // GET /api/backup → consistent SQLite snapshot download (online backup API —
  // includes WAL content, safe while checks are running)
  r.get('/', aw(async (req, res) => {
    const tmp = path.join(os.tmpdir(), `cookiehub-backup-${randomBytes(6).toString('hex')}.db`)
    await db.backup(tmp)
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('content-disposition', `attachment; filename="cookiehub-backup-${stamp}.db"`)
    const stream = fs.createReadStream(tmp)
    stream.pipe(res)
    stream.on('close', () => fs.unlink(tmp, () => {}))
    stream.on('error', () => { fs.unlink(tmp, () => {}); if (!res.headersSent) err(res, 'backup_failed', 'snapshot stream failed', 500) })
  }))

  // POST /api/backup → restore from raw .db bytes. The live file is never
  // swapped (it's held open by the server); the upload is attached and each
  // table copied inside one transaction.
  r.post('/', raw({ type: 'application/octet-stream', limit: '512mb' }), aw(async (req, res) => {
    const buf = req.body
    if (!Buffer.isBuffer(buf) || buf.length < 16) return err(res, 'invalid_backup', 'upload a CookieHub backup file (.db bytes)', 400)
    const tmp = path.join(os.tmpdir(), `cookiehub-restore-${randomBytes(6).toString('hex')}.db`)
    fs.writeFileSync(tmp, buf)
    try {
      // validate BEFORE touching live data: is it sqlite, is it ours, same columns
      let srcTables, srcCookieCols
      try {
        const probe = new Database(tmp, { readonly: true })
        try {
          srcTables = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name))
          srcCookieCols = probe.prepare('PRAGMA table_info(cookies)').all().map(c => c.name).join()
        } finally { probe.close() }
      } catch {
        return err(res, 'invalid_backup', 'not a SQLite database', 400)
      }
      if (!srcTables.has('cookies')) return err(res, 'invalid_backup', 'not a CookieHub backup (no cookies table)', 400)
      const liveCols = db.prepare('PRAGMA table_info(cookies)').all().map(c => c.name).join()
      if (srcCookieCols !== liveCols) return err(res, 'incompatible_backup', 'cookies table schema mismatch — backup from a different version', 400)
      // key compatibility: one decrypt probe (contents are AES-GCM under ENCRYPTION_KEY)
      const probe2 = new Database(tmp, { readonly: true })
      try {
        const sample = probe2.prepare('SELECT content_enc FROM cookies WHERE content_enc IS NOT NULL LIMIT 1').get()
        if (sample) { try { decryptJSON(sample.content_enc) } catch { return err(res, 'backup_key_mismatch', 'backup was encrypted with a different ENCRYPTION_KEY', 409) } }
      } finally { probe2.close() }

      db.prepare('ATTACH DATABASE ? AS src').run(tmp)
      let restored
      try {
        db.transaction(() => {
          restored = {}
          for (const t of TABLES) {
            if (!srcTables.has(t)) continue
            db.prepare(`DELETE FROM main."${t}"`).run()
            restored[t] = db.prepare(`INSERT INTO main."${t}" SELECT * FROM src."${t}"`).run().changes
          }
        })()
      } finally {
        db.exec('DETACH DATABASE src')
      }
      res.json({ ok: true, restored })
    } catch (e) {
      err(res, 'restore_failed', e.message, 500)
    } finally {
      fs.unlink(tmp, () => {})
    }
  }))

  return r
}
