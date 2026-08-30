import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb, setSetting } from '../src/db.js'
import { createEngine, mergeRequestHeaders } from '../src/engine.js'
import { initEncryption, generateKeyB64, encryptJSON, decryptJSON } from '../src/crypto.js'
import { toHeaderString } from '../src/cookieFormat.js'

// capture the (url, init) undici fetch was called with — engine tests never do real HTTP
const fetchCalls = vi.hoisted(() => [])
const failQueue = vi.hoisted(() => []) // queued errors thrown before recording a successful call
vi.mock('undici', () => ({
  fetch: async (url, init) => {
    fetchCalls.push({ url, init })
    if (failQueue.length) throw failQueue.shift()
    return { status: 200, headers: { get: () => null }, text: async () => '' }
  },
  ProxyAgent: class {},
  Agent: class {}
}))

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
  it('boundFetch sends stored cookies as cookie header; adapter-supplied cookie wins', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    const captureAdapter = {
      key: 'fake', name: 'Fake', defaultDomain: '.fake.com',
      check: async ({ fetch }) => {
        await fetch('https://x.test/default')
        await fetch('https://x.test/explicit', { headers: { Cookie: 'custom=1' } })
        await fetch('https://x.test/headers-inst', { headers: new Headers({ cookie: 'explicit=1' }) })
        return { status: 'live', reason: 'ok' }
      }
    }
    const engine = createEngine({ db, adapters: new Map([['fake', captureAdapter]]) })
    await engine.runCheck(id)
    const expected = toHeaderString(decryptJSON(db.prepare('SELECT content_enc FROM cookies WHERE id=?').get(id).content_enc))
    const [def, explicit, inst] = fetchCalls.slice(-3)
    expect(def.init.headers.get('cookie')).toBe(expected)
    expect(def.init.headers.get('user-agent')).toBeTruthy()
    expect(explicit.init.headers.get('cookie')).toBe('custom=1')
    expect(inst.init.headers.get('cookie')).toBe('explicit=1')
  })
  it('boundFetch retries a transient GET failure once (proxy rotation blip) and succeeds', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    failQueue.push(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    fetchCalls.length = 0
    const probeAdapter = {
      key: 'fake', name: 'Fake', defaultDomain: '.fake.com',
      check: async ({ fetch }) => ({ status: 'live', reason: 'status ' + (await fetch('https://x.test/flaky')).status })
    }
    const engine = createEngine({ db, adapters: new Map([['fake', probeAdapter]]) })
    expect(await engine.runCheck(id)).toBe('live')
    expect(fetchCalls.filter(c => c.url === 'https://x.test/flaky')).toHaveLength(2) // first attempt threw, retry landed
  })
  it('boundFetch does NOT retry POSTs or non-transient errors', async () => {
    const db = openDb()
    const postAdapter = {
      key: 'fake', name: 'Fake', defaultDomain: '.fake.com',
      check: ({ fetch }) => fetch('https://x.test/submit', { method: 'POST' })
    }
    failQueue.push(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    fetchCalls.length = 0
    const engine = createEngine({ db, adapters: new Map([['fake', postAdapter]]) })
    const [id] = seed(db, 'fake')
    expect(await engine.runCheck(id)).toBe('error') // thrown through — side-effectful POST must not replay
    expect(fetchCalls.filter(c => c.url === 'https://x.test/submit')).toHaveLength(1)
    failQueue.push(new Error('boom')) // non-transient GET error
    fetchCalls.length = 0
    const getAdapter = {
      key: 'fake', name: 'Fake', defaultDomain: '.fake.com',
      check: ({ fetch }) => fetch('https://x.test/get')
    }
    const engine2 = createEngine({ db, adapters: new Map([['fake', getAdapter]]) })
    const [id2] = seed(db, 'fake')
    expect(await engine2.runCheck(id2)).toBe('error')
    expect(fetchCalls.filter(c => c.url === 'https://x.test/get')).toHaveLength(1)
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
    row = db.prepare('SELECT status, last_checked_at FROM cookies WHERE id=?').get(id)
    expect(row.status).toBe('die') // unchanged
    expect(row.last_checked_at).toBeGreaterThan(0) // error attempt still records a check time
    const log = db.prepare('SELECT * FROM check_logs WHERE cookie_id=? ORDER BY id DESC LIMIT 1').get(id)
    expect(log.status).toBe('error')
    expect(log.reason).toContain('proxy unreachable')
  })
  it("proxyFor: 'direct' escapes the global proxy; service URL wins; else global", () => {
    const db = openDb()
    setSetting(db, 'proxy_global', 'socks5://global:1')
    const engine = createEngine({ db, adapters: new Map() })
    expect(engine.proxyFor('unset-svc')).toBe('socks5://global:1') // no row → global
    db.prepare("INSERT INTO service_settings(service_key,proxy) VALUES('direct-svc','direct')").run()
    db.prepare("INSERT INTO service_settings(service_key,proxy) VALUES('proxied','http://p:2')").run()
    expect(engine.proxyFor('direct-svc')).toBeNull()
    expect(engine.proxyFor('proxied')).toBe('http://p:2')
    expect(engine.proxyFor('unset-svc')).toBe('socks5://global:1')
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
  it('check-all processes NEWEST cookies first (queue order matches dashboard id DESC sort)', async () => {
    const db = openDb()
    seed(db, 'fake', 3) // seeded values 'v0','v1','v2' — 'v2' is the newest (largest id)
    const resolvers = []
    const started = []
    const slow = {
      key: 'fake', name: 'F', defaultDomain: '.f.com',
      check: ({ cookieHeader }) => { started.push(cookieHeader); return new Promise(r => { resolvers.push(r) }) }
    }
    const engine = createEngine({ db, adapters: new Map([['fake', slow]]) })
    engine.startCheckAll()
    await new Promise(r => setTimeout(r, 20))
    expect(started).toHaveLength(3) // CONCURRENCY (8) ≥ 3 → all start immediately, in queue order
    expect(started[0]).toBe('sid=v2') // first checked must be the NEWEST cookie
    for (let i = 0; i < 3; i++) resolvers.shift()({ status: 'live', reason: '' })
    await new Promise(r => setTimeout(r, 50))
    expect(engine.jobStatus().running).toBe(false)
  })
  it('check-all skips disabled services', () => {
    const db = openDb()
    seed(db, 'fake', 2); seed(db, 'off', 2)
    db.prepare('INSERT INTO service_settings(service_key,disabled) VALUES(?,?)').run('off', 1)
    const engine = createEngine({ db, adapters: new Map([['fake', fakeAdapter({ status: 'live', reason: '' })], ['off', fakeAdapter({ status: 'live', reason: '' })]]) })
    expect(engine.startCheckAll().queued).toBe(2)
  })
  it('check-all status filter: startCheckAll(null, "unknown") queues exactly the unknown cookies', async () => {
    const db = openDb()
    const ids = seed(db, 'fake', 4)
    const upd = db.prepare('UPDATE cookies SET status=? WHERE id=?')
    upd.run('unknown', ids[0]); upd.run('unknown', ids[1]); upd.run('live', ids[2]); upd.run('die', ids[3])
    const started = []
    const resolvers = []
    const slow = {
      key: 'fake', name: 'F', defaultDomain: '.f.com',
      check: ({ cookieHeader }) => { started.push(cookieHeader); return new Promise(r => { resolvers.push(r) }) }
    }
    const engine = createEngine({ db, adapters: new Map([['fake', slow]]) })
    const { queued } = engine.startCheckAll(null, 'unknown')
    expect(queued).toBe(2)
    await new Promise(r => setTimeout(r, 20))
    expect([...started].sort()).toEqual(['sid=v0', 'sid=v1']) // only the two unknowns started
    for (let i = 0; i < 2; i++) resolvers.shift()({ status: 'live', reason: '' })
    await new Promise(r => setTimeout(r, 50))
    expect(engine.jobStatus()).toMatchObject({ running: false, done: 2, failed: 0 })
  })
  it('check-all status filter: invalid value is ignored (no filter applied)', () => {
    const db = openDb()
    const ids = seed(db, 'fake', 2)
    db.prepare('UPDATE cookies SET status=? WHERE id=?').run('live', ids[0])
    const engine = createEngine({ db, adapters: new Map([['fake', fakeAdapter({ status: 'live', reason: '' })]]) })
    expect(engine.startCheckAll(null, 'bogus').queued).toBe(2)
  })
  it('check-all status filter: non-string value is ignored (no filter applied)', () => {
    const db = openDb()
    const ids = seed(db, 'fake', 2)
    db.prepare('UPDATE cookies SET status=? WHERE id=?').run('live', ids[0])
    const engine = createEngine({ db, adapters: new Map([['fake', fakeAdapter({ status: 'live', reason: '' })]]) })
    // regex .test() coerces ['unknown'] → 'unknown'; without a type guard this
    // reaches SQL as an array bind and throws
    expect(engine.startCheckAll(null, ['unknown']).queued).toBe(2)
  })
  it('buildDispatcher rejects unsupported protocol', () => {
    const engine = createEngine({ db: openDb(), adapters: new Map() })
    expect(() => engine.buildDispatcher('ftp://x:21')).toThrow(/unsupported/)
  })
  it('throttles concurrent same-service requests at least ~400ms apart', async () => {
    const db = openDb()
    const ids = seed(db, 'fake', 3)
    const starts = []
    const rec = { key: 'fake', name: 'F', defaultDomain: '.f.com', check: async ({ fetch }) => { try { await fetch('http://127.0.0.1:1/') } catch {} starts.push(Date.now()) } }
    const engine = createEngine({ db, adapters: new Map([['fake', rec]]) })
    await engine.runCheck(ids[0]) // prime the service throttle
    starts.length = 0
    await Promise.all(ids.slice(1).map(id => engine.runCheck(id)))
    expect(starts.length).toBe(2)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(300) // SERVICE_GAP_MS (400) minus 100ms tolerance
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
  it('getNftoken returns adapter result and writes NOTHING to cookies/check_logs', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    const rowBefore = db.prepare('SELECT * FROM cookies WHERE id=?').get(id)
    const nf = {
      key: 'fake', name: 'Fake', defaultDomain: '.fake.com',
      check: async () => ({ status: 'live', reason: '' }),
      nftoken: async ({ cookies, cookieHeader, fetch, log }) => ({ link: `https://netflix.com/?nftoken=${cookies.length}:${cookieHeader}:${typeof fetch}:${typeof log}`, expires: 42 })
    }
    const engine = createEngine({ db, adapters: new Map([['fake', nf]]) })
    const r = await engine.getNftoken(id)
    expect(r.expires).toBe(42)
    expect(r.link).toContain(':sid=v0:') // decrypted cookies + header + bound fetch passed through
    expect(db.prepare('SELECT COUNT(*) c FROM cookies').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM check_logs').get().c).toBe(0)
    expect(db.prepare('SELECT * FROM cookies WHERE id=?').get(id)).toEqual(rowBefore) // status/last_checked_at/updated_at untouched
  })
  it('getNftoken: adapter without nftoken → 422; unknown id → 404; unknown service → 422', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    const engine = createEngine({ db, adapters: new Map([['fake', fakeAdapter({ status: 'live', reason: '' })]]) })
    await expect(engine.getNftoken(id)).rejects.toMatchObject({ status: 422 })
    await expect(engine.getNftoken(99999)).rejects.toMatchObject({ status: 404 })
    db.prepare('UPDATE cookies SET service_key=? WHERE id=?').run('ghost', id)
    await expect(engine.getNftoken(id)).rejects.toMatchObject({ status: 422, message: 'unknown service' })
  })

  it('linkTv passes the code through, returns adapter result, writes NOTHING', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    const rowBefore = db.prepare('SELECT * FROM cookies WHERE id=?').get(id)
    const calls = []
    const linky = {
      key: 'fake', name: 'Fake', defaultDomain: '.fake.com',
      check: async () => ({ status: 'live', reason: '' }),
      linkTv: async (ctx, code) => { calls.push({ hasFetch: typeof ctx.fetch, header: ctx.cookieHeader, code }); return { ok: true, message: 'TV linked' } }
    }
    const engine = createEngine({ db, adapters: new Map([['fake', linky]]) })
    const r = await engine.linkTv(id, 'A1B2C3D4')
    expect(r).toEqual({ ok: true, message: 'TV linked' })
    expect(calls).toEqual([{ hasFetch: 'function', header: 'sid=v0', code: 'A1B2C3D4' }])
    expect(db.prepare('SELECT COUNT(*) c FROM check_logs').get().c).toBe(0)
    expect(db.prepare('SELECT * FROM cookies WHERE id=?').get(id)).toEqual(rowBefore)
  })
  it('linkTv: adapter without linkTv → 422; unknown id → 404', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    const engine = createEngine({ db, adapters: new Map([['fake', fakeAdapter({ status: 'live', reason: '' })]]) })
    await expect(engine.linkTv(id, 'A1B2C3D4')).rejects.toMatchObject({ status: 422 })
    await expect(engine.linkTv(99999, 'A1B2C3D4')).rejects.toMatchObject({ status: 404 })
  })
  it('jobStatus exposes activeIds of in-flight checks', async () => {
    const db = openDb()
    const ids = seed(db, 'fake', 2)
    const resolvers = []
    const slow = { key: 'fake', name: 'F', defaultDomain: '.f.com', check: () => new Promise(r => { resolvers.push(r) }) }
    const engine = createEngine({ db, adapters: new Map([['fake', slow]]) })
    const p = engine.runCheck(ids[0])
    await new Promise(r => setTimeout(r, 10))
    expect(engine.jobStatus().activeIds).toEqual([ids[0]])
    resolvers.shift()({ status: 'live', reason: '' })
    await p
    expect(engine.jobStatus().activeIds).toEqual([])
  })

  it('cookie deleted mid-check: success path resolves, no update, no log row', async () => {
    const db = openDb()
    const [id] = seed(db, 'slow')
    let release
    const gate = new Promise(r => { release = r })
    const slow = {
      key: 'slow', name: 'Slow', defaultDomain: '.s.com',
      check: async () => { await gate; return { status: 'live', reason: 'ok' } }
    }
    const engine = createEngine({ db, adapters: new Map([['slow', slow]]) })
    const p = engine.runCheck(id)
    db.prepare('DELETE FROM cookies WHERE id=?').run(id)
    release()
    await expect(p).resolves.toBe('live')
    expect(db.prepare('SELECT * FROM cookies WHERE id=?').get(id)).toBeUndefined()
    expect(db.prepare('SELECT * FROM check_logs WHERE cookie_id=?').all(id)).toHaveLength(0)
  })
  it('cookie deleted mid-check: error path resolves "error", no log row', async () => {
    const db = openDb()
    const [id] = seed(db, 'slow')
    let release
    const gate = new Promise(r => { release = r })
    const slow = {
      key: 'slow', name: 'Slow', defaultDomain: '.s.com',
      check: async () => { await gate; throw new Error('proxy unreachable') }
    }
    const engine = createEngine({ db, adapters: new Map([['slow', slow]]) })
    const p = engine.runCheck(id)
    db.prepare('DELETE FROM cookies WHERE id=?').run(id)
    release()
    await expect(p).resolves.toBe('error')
    expect(db.prepare('SELECT * FROM check_logs WHERE cookie_id=?').all(id)).toHaveLength(0)
  })
})

describe('mergeRequestHeaders', () => {
  const stored = 'sid=stored'
  it('plain object: absent cookie → stored cookie + default UA, other keys survive', () => {
    const h = mergeRequestHeaders({ 'accept-language': 'en-US' }, stored, 'UA-X')
    expect(h.get('cookie')).toBe(stored)
    expect(h.get('user-agent')).toBe('UA-X')
    expect(h.get('accept-language')).toBe('en-US')
  })
  it('plain object: explicit cookie (any case) wins; own UA kept', () => {
    const h = mergeRequestHeaders({ Cookie: 'explicit=1', 'User-Agent': 'MyUA' }, stored, 'UA-X')
    expect(h.get('cookie')).toBe('explicit=1')
    expect(h.get('user-agent')).toBe('MyUA')
  })
  it('Headers instance: explicit cookie wins instead of being silently dropped/overridden', () => {
    const h = mergeRequestHeaders(new Headers({ cookie: 'explicit=1' }), stored, 'UA-X')
    expect(h.get('cookie')).toBe('explicit=1')
    expect(h.get('user-agent')).toBe('UA-X')
  })
  it('entries array: explicit cookie wins, other entries survive', () => {
    const h = mergeRequestHeaders([['cookie', 'explicit=1'], ['x-custom', 'yes']], stored, 'UA-X')
    expect(h.get('cookie')).toBe('explicit=1')
    expect(h.get('x-custom')).toBe('yes')
  })
  it('undefined headers → stored cookie + default UA', () => {
    const h = mergeRequestHeaders(undefined, stored, 'UA-X')
    expect(h.get('cookie')).toBe(stored)
    expect(h.get('user-agent')).toBe('UA-X')
  })
})
