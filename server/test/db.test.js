import { describe, it, expect } from 'vitest'
import { openDb, getSetting, setSetting } from '../src/db.js'

describe('db', () => {
  it('creates all tables', () => {
    const db = openDb()
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    for (const t of ['cookies', 'check_logs', 'settings', 'service_settings', 'sessions'])
      expect(names).toContain(t)
  })
  it('settings upsert + get', () => {
    const db = openDb()
    expect(getSetting(db, 'password_hash')).toBeUndefined()
    setSetting(db, 'password_hash', 'h1'); setSetting(db, 'password_hash', 'h2')
    expect(getSetting(db, 'password_hash')).toBe('h2')
  })
  it('deleting a cookie cascades to check_logs', () => {
    const db = openDb()
    const now = Date.now()
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO cookies(service_key,label,content_enc,source_format,created_at,updated_at) VALUES(?,?,?,?,?,?)'
    ).run('netflix', 'x', Buffer.alloc(10), 'header', now, now)
    db.prepare('INSERT INTO check_logs(cookie_id,status,created_at) VALUES(?,?,?)').run(lastInsertRowid, 'live', now)
    db.prepare('DELETE FROM cookies WHERE id=?').run(lastInsertRowid)
    expect(db.prepare('SELECT COUNT(*) c FROM check_logs').get().c).toBe(0)
  })
})
