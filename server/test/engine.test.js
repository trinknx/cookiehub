import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, setSetting } from '../src/db.js'
import { createEngine } from '../src/engine.js'
import { initEncryption, generateKeyB64, encryptJSON } from '../src/crypto.js'

const fakeAdapter = (result) => ({ key: 'fake', name: 'Fake', defaultDomain: '.fake.com', check: async () => result })
const throwingAdapter = { key: 'boom', name: 'Boom', defaultDomain: '.b.com', check: async () => { throw new Error('proxy unreachable') } }

function seed(db, service, n = 1) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const info = { i }
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO cookies(service_key,label,content_enc,source_format,created_at,updated_at) VALUES(?,?,?,?,?,?)'
    ).run(service, 'c' + i, encryptJSON([{ domain: '.x.com', path: '/', secure: true, httpOnly: false, expiration: null, name: 'sid', value: 'v' + i }]), 'header', Date.now(), Date.now())
    ids.push(Number(lastInsertRowid))
  }
  return ids
}

describe('engine', () => {
  beforeEach(() => initEncryption(generateKeyB64()))
  it('live result updates cookie + writes log', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    const engine = createEngine({ db, adapters: new Map([['fake', fakeAdapter({ status: 'live', reason: 'ok', accountInfo: { email: 'a@b.c' } })]]) })
    expect(await engine.runCheck(id)).toBe('live')
    const row = db.prepare('SELECT * FROM cookies WHERE id=?').get(id)
    expect(row.status).toBe('live')
    expect(JSON.parse(row.account_info)).toEqual({ email: 'a@b.c' })
    expect(db.prepare('SELECT * FROM check_logs WHERE cookie_id=?').get(id)).toMatchObject({ status: 'live', reason: 'ok' })
  })
  it('die keeps old account_info; error keeps status untouched', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    db.prepare('UPDATE cookies SET status=?, account_info=? WHERE id=?').run('live', '{"email":"old@x"}', id)
    let engine = createEngine({ db, adapters: new Map([['fake', fakeAdapter({ status: 'die', reason: 'redirected' })]]) })
    await engine.runCheck(id)
    let row = db.prepare('SELECT status, account_info FROM cookies WHERE id=?').get(id)
    expect(row.status).toBe('die')
    expect(row.account_info).toBe('{"email":"old@x"}')
    engine = createEngine({ db, adapters: new Map([['boom', throwingAdapter]]) })
    db.prepare('UPDATE cookies SET service_key=?, status=? WHERE id=?').run('boom', 'die', id)
    expect(await engine.runCheck(id)).toBe('error')
    row = db.prepare('SELECT status FROM cookies WHERE id=?').get(id)
    expect(row.status).toBe('die') // unchanged
    const log = db.prepare('SELECT * FROM check_logs WHERE cookie_id=? ORDER BY id DESC LIMIT 1').get(id)
    expect(log.status).toBe('error')
    expect(log.reason).toContain('proxy unreachable')
  })
  it('double check of same cookie → 409', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    let release
    const slow = { key: 'fake', name: 'Fake', defaultDomain: '.f.com', check: () => new Promise(r => { release = r }) }
    const engine = createEngine({ db, adapters: new Map([['fake', slow]]) })
    const p = engine.runCheck(id)
    await expect(engine.runCheck(id)).rejects.toMatchObject({ status: 409 })
    release({ status: 'live', reason: '' })
    expect(await p).toBe('live')
  })
  it('check-all: queues, completes, second start while running → 409', async () => {
    const db = openDb()
    seed(db, 'fake', 4)
    // NOTE: deviation from brief — the brief's `let release` + synchronous release loop cannot work:
    // adapter.check() (which captures the resolver) runs one microtask after `await acquire()` inside
    // runCheck, and with concurrency 3 a single overwritten `release` reference loses resolvers.
    // Collect resolvers FIFO and yield a macrotask before each release; assertions unchanged.
    const resolvers = []
    const slow = { key: 'fake', name: 'F', defaultDomain: '.f.com', check: () => new Promise(r => { resolvers.push(r) }) }
    const engine = createEngine({ db, adapters: new Map([['fake', slow]]) })
    const { queued } = engine.startCheckAll()
    expect(queued).toBe(4)
    expect(() => engine.startCheckAll()).toThrow()
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 10))
      resolvers.shift()({ status: 'live', reason: '' })
    }
    await new Promise(r => setTimeout(r, 50))
    expect(engine.jobStatus()).toMatchObject({ running: false, done: 4, failed: 0 })
  })
  it('check-all skips disabled services', () => {
    const db = openDb()
    seed(db, 'fake', 2); seed(db, 'off', 2)
    db.prepare('INSERT INTO service_settings(service_key,disabled) VALUES(?,?)').run('off', 1)
    const engine = createEngine({ db, adapters: new Map([['fake', fakeAdapter({ status: 'live', reason: '' })], ['off', fakeAdapter({ status: 'live', reason: '' })]]) })
    expect(engine.startCheckAll().queued).toBe(2)
  })
  it('buildDispatcher rejects unsupported protocol', () => {
    const engine = createEngine({ db: openDb(), adapters: new Map() })
    expect(() => engine.buildDispatcher('ftp://x:21')).toThrow(/unsupported/)
  })
  it('throttles concurrent same-service requests at least ~1s apart', async () => {
    const db = openDb()
    const ids = seed(db, 'fake', 3)
    const starts = []
    const rec = { key: 'fake', name: 'F', defaultDomain: '.f.com', check: async ({ fetch }) => { try { await fetch('http://127.0.0.1:1/') } catch {} starts.push(Date.now()) } }
    const engine = createEngine({ db, adapters: new Map([['fake', rec]]) })
    await engine.runCheck(ids[0]) // prime the service throttle
    starts.length = 0
    await Promise.all(ids.slice(1).map(id => engine.runCheck(id)))
    expect(starts.length).toBe(2)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(900)
  })
  it('buildDispatcher returns a dispatcher for socks5 without connecting (smoke)', () => {
    const engine = createEngine({ db: openDb(), adapters: new Map() })
    const d = engine.buildDispatcher('socks5://127.0.0.1:1080')
    expect(d).toBeTruthy()
    expect(engine.buildDispatcher('socks5://127.0.0.1:1080')).toBe(d)
  })
  it('check-all completes when one cookie is already being checked directly (409 path)', async () => {
    const db = openDb()
    const ids = seed(db, 'fake', 3)
    const resolvers = []
    const slow = { key: 'fake', name: 'F', defaultDomain: '.f.com', check: () => new Promise(r => { resolvers.push(r) }) }
    const engine = createEngine({ db, adapters: new Map([['fake', slow]]) })
    const direct = engine.runCheck(ids[0])
    await new Promise(r => setTimeout(r, 20))
    const { queued } = engine.startCheckAll()
    expect(queued).toBe(3)
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 10))
      resolvers.shift()({ status: 'live', reason: '' })
    }
    await direct
    await new Promise(r => setTimeout(r, 50))
    const js = engine.jobStatus()
    expect(js.running).toBe(false)
    expect(js.failed + js.done).toBe(3)
    expect(js.failed).toBe(1)
  })
})
