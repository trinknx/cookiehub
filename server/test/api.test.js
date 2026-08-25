import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { openDb } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createEngine } from '../src/engine.js'
import { initEncryption, generateKeyB64 } from '../src/crypto.js'

const NET = '.netflix.com\tTRUE\t/\tTRUE\t1790000000\tNetflixId\tv-2'
const HDR = 'NetflixId=v-2; SecureSessionId=x'
const adapter = { key: 'netflix', name: 'Netflix', defaultDomain: '.netflix.com', check: async () => ({ status: 'live', reason: 'ok' }), nftoken: async () => ({ link: 'https://netflix.com/?nftoken=abc%3D', expires: 1790000000000 }) }
let ctx
const build = () => {
  initEncryption(generateKeyB64())
  const db = openDb()
  const adapters = new Map([['netflix', adapter]])
  const engine = createEngine({ db, adapters })
  ctx = { app: buildApp({ db, adapters, engine, scheduler: { reschedule: () => {} } }), db, adapters, engine }
  return ctx
}

const login = async () => {
  build()
  const agent = request.agent(ctx.app)
  agent.set('X-Requested-With', 'XMLHttpRequest')
  await agent.post('/api/auth/setup').send({ password: 'hunter2hunter2' })
  return agent
}

describe('cookies api', () => {
  let agent
  beforeEach(async () => { agent = await login() })

  it('imports single netscape + header with detection', async () => {
    const a1 = await agent.post('/api/cookies').send({ service: 'netflix', content: NET, label: 'NF1' }).expect(200)
    expect(a1.body.created).toHaveLength(1)
    expect(a1.body.created[0].source_format).toBe('netscape')
    expect(a1.body.created[0]).toHaveProperty('account_info', null)
    expect(a1.body.created[0]).toHaveProperty('last_checked_at', null)
    const a2 = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR }).expect(200)
    expect(a2.body.created[0].source_format).toBe('header')
  })
  it('bulk import: junk chunks are skipped, not failed', async () => {
    const res = await agent.post('/api/cookies').send({ service: 'netflix', content: `${NET}\n\nnot a cookie` }).expect(200)
    expect(res.body.created).toHaveLength(1)
    expect(res.body.failed).toEqual([])
    expect(res.body.skipped).toBe(1)
  })
  it('bulk import: folder of ULPfile-style txt payloads — one import, junk headers skipped', async () => {
    const file = banner => `\uFEFF${banner}\nt.me/ULPfile\nâ€“ Email: buyer@example.com\n\n${NET}`
    const content = [file('Valid Cookie / Every day!'), file('âœ” NETFLIX #2'), file('seller banner #3')].join('\n\n')
    const res = await agent.post('/api/cookies').send({ service: 'netflix', content }).expect(200)
    expect(res.body.created).toHaveLength(3)
    expect(res.body.created.every(c => c.source_format === 'netscape')).toBe(true)
    expect(res.body.failed).toEqual([])
    expect(res.body.skipped).toBe(3)
  })
  it('bulk import: cookie-editor json arrays mixed with junk text', async () => {
    const json1 = '[{"name":"NetflixId","value":"syn-1","domain":".netflix.com","path":"/","secure":true,"httpOnly":false,"hostOnly":false,"sameSite":"no_restriction","session":false,"expirationDate":1790000000}]'
    const json2 = '[{"name":"SecureSessionId","value":"syn-2","domain":".netflix.com","path":"/","secure":true,"httpOnly":false,"hostOnly":false,"sameSite":"no_restriction","session":false,"expirationDate":1807091768}]'
    const content = `NETFLIX ACCOUNT DETAILS  ::  #1 of 298\n– Email: tester1@example.com\n${json1}\n═════════════════════════════════\n\n${json2}\n═════════════════════════════════`
    const res = await agent.post('/api/cookies').send({ service: 'netflix', content }).expect(200)
    expect(res.body.created).toHaveLength(2)
    expect(res.body.created.every(c => c.source_format === 'json')).toBe(true)
    expect(res.body.skipped).toBe(3) // junk around both arrays, now counted
    const h = await agent.get(`/api/cookies/${res.body.created[0].id}/export?format=header`).expect(200)
    expect(h.body.content).toContain('NetflixId=syn-1')
  })
  it('bulk import: mixed selection — json file + netscape file import both', async () => {
    const json = '[{"name":"NetflixId","value":"mix-1","domain":".netflix.com","path":"/","secure":true,"httpOnly":false,"hostOnly":false,"sameSite":"no_restriction","session":false,"expirationDate":1790000000}]'
    const content = `\uFEFFValid Cookie / Every day!\nt.me/ULPfile\n${json}\n\n${NET}`
    const res = await agent.post('/api/cookies').send({ service: 'netflix', content }).expect(200)
    expect(res.body.created.map(c => c.source_format).sort()).toEqual(['json', 'netscape'])
    expect(res.body.failed).toEqual([])
    expect(res.body.skipped).toBeGreaterThanOrEqual(1)
  })
  it('pure legacy bulk payload still splits on blank lines', async () => {
    const res = await agent.post('/api/cookies').send({ service: 'netflix', content: `${HDR}\n\nNetflixId=hdr-2` }).expect(200)
    expect(res.body.created).toHaveLength(2)
    expect(res.body.created.map(c => c.source_format)).toEqual(['header', 'header'])
    expect(res.body.skipped).toBe(0)
  })
  it('unknown service → 400', async () => {
    await agent.post('/api/cookies').send({ service: 'nope', content: HDR }).expect(400)
  })
  it('q treats LIKE metacharacters literally', async () => {
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR, label: '100%_off' })
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR, label: 'plain' })
    expect((await agent.get('/api/cookies').query({ q: '100%' })).body.total).toBe(1)
    expect((await agent.get('/api/cookies').query({ q: '%' })).body.total).toBe(1)
    expect((await agent.get('/api/cookies').query({ q: '_' })).body.total).toBe(1)
  })
  it('fractional/non-finite page normalizes to 1', async () => {
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const res = await agent.get('/api/cookies').query({ page: '1.5' }).expect(200)
    expect(res.body.page).toBe(1)
    await agent.get('/api/cookies').query({ page: 'Infinity' }).expect(200)
  })
  it('logs limit invalid values fall back to default', async () => {
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const insLog = ctx.db.prepare('INSERT INTO check_logs(cookie_id,status,reason,detail,proxy_used,duration_ms,created_at) VALUES(?,?,?,?,?,?,?)')
    for (let i = 0; i < 55; i++) insLog.run(created[0].id, 'live', 'ok', null, null, 1, Date.now())
    const over = await agent.get(`/api/cookies/${created[0].id}/logs`).query({ limit: '201' }).expect(200)
    expect(over.body.items).toHaveLength(50)
    await agent.get(`/api/cookies/${created[0].id}/logs`).query({ limit: '-1' }).expect(200)
    await agent.get(`/api/cookies/${created[0].id}/logs`).query({ limit: '2.5' }).expect(200)
  })
  it('list hides content, filters by service+status', async () => {
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const list = await agent.get('/api/cookies').expect(200)
    expect(list.body.total).toBe(1)
    expect(list.body.items[0]).not.toHaveProperty('content_enc')
    expect((await agent.get('/api/cookies?status=live')).body.total).toBe(0)
  })
  it('export header + netscape round-trip', async () => {
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const h = await agent.get(`/api/cookies/${created[0].id}/export?format=header`).expect(200)
    expect(h.body.content).toBe(HDR)
    const n = await agent.get(`/api/cookies/${created[0].id}/export?format=netscape`).expect(200)
    expect(n.body.content).toContain('.netflix.com\t')
  })
  it('check runs engine and updates status; logs endpoint returns history', async () => {
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const chk = await agent.post(`/api/cookies/${created[0].id}/check`).expect(200)
    expect(chk.body.status).toBe('live')
    const logs = await agent.get(`/api/cookies/${created[0].id}/logs`).expect(200)
    expect(logs.body.items[0]).toMatchObject({ status: 'live', reason: 'ok' })
  })
  it('check-all POST + GET status', async () => {
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const start = await agent.post('/api/cookies/check-all').send({}).expect(200)
    expect(start.body.queued).toBeGreaterThanOrEqual(1)
    const st = await agent.get('/api/cookies/check-all').expect(200)
    expect(st.body).toHaveProperty('running')
  })

  it('remove-die deletes all die cookies across services; live/unknown untouched', async () => {
    const seed = async (status, service = 'netflix') => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      ctx.db.prepare('UPDATE cookies SET status=?, service_key=? WHERE id=?').run(status, service, created[0].id)
    }
    await seed('die'); await seed('die'); await seed('live'); await seed('unknown'); await seed('die', 'spotify')
    const r = await agent.post('/api/cookies/remove-die').send({}).expect(200)
    expect(r.body).toEqual({ removed: 3 })
    const list = await agent.get('/api/cookies').expect(200)
    expect(list.body.total).toBe(2)
    expect(list.body.items.map(i => i.status).sort()).toEqual(['live', 'unknown'])
  })
  it('remove-die scoped to one service only', async () => {
    const seed = async (status, service) => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      ctx.db.prepare('UPDATE cookies SET status=?, service_key=? WHERE id=?').run(status, service, created[0].id)
    }
    await seed('die', 'netflix'); await seed('die', 'spotify')
    const r = await agent.post('/api/cookies/remove-die').send({ service: 'netflix' }).expect(200)
    expect(r.body).toEqual({ removed: 1 })
    expect((await agent.get('/api/cookies?service=spotify&status=die')).body.total).toBe(1)
    expect((await agent.get('/api/cookies?service=netflix')).body.total).toBe(0)
  })
  it('remove-die unknown service → 400', async () => {
    await agent.post('/api/cookies/remove-die').send({ service: 'nope' }).expect(400)
  })

  it('remove-duplicates keeps live first then newest, case-insensitive; rows without email untouched', async () => {
    const seed = async (email, status, service = 'netflix') => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      ctx.db.prepare('UPDATE cookies SET status=?, service_key=?, account_info=? WHERE id=?')
        .run(status, service, email ? JSON.stringify({ email }) : null, created[0].id)
      return created[0].id
    }
    const a1 = await seed('a@x', 'die')
    const a2 = await seed('a@x', 'live')
    const a3 = await seed('A@X', 'unknown') // case-insensitive: groups with a@x
    const b1 = await seed('b@y', 'die')
    const c1 = await seed('c@z', 'die')
    const c2 = await seed('c@z', 'die') // both die → keep newest (highest id)
    const noEmail = await seed(null, 'die') // no email → never touched

    const r = await agent.post('/api/cookies/remove-duplicates').send({}).expect(200)
    expect(r.body).toEqual({ removed: 3, kept: 2, groups: 2 })
    const list = await agent.get('/api/cookies').expect(200)
    const byId = Object.fromEntries(list.body.items.map(i => [i.id, i]))
    expect(Object.keys(byId).map(Number).sort((x, y) => x - y)).toEqual([b1, a2, c2, noEmail].sort((x, y) => x - y))
    expect(byId[a2].status).toBe('live') // live beats newer id (a3)
    expect(byId[c2]).toBeTruthy() // newest of the die pair
    expect(byId[c1]).toBeUndefined()
    expect(byId[noEmail].account_info).toBeNull() // no-email row survived
    // after removal nothing is a duplicate anymore
    expect(list.body.items.every(i => i.dup === false)).toBe(true)
  })

  it('remove-duplicates scoped: other service survives; unknown service → 400; dup flag marks groups', async () => {
    const seed = async (email, status, service = 'netflix') => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      ctx.db.prepare('UPDATE cookies SET status=?, service_key=?, account_info=? WHERE id=?')
        .run(status, service, JSON.stringify({ email }), created[0].id)
      return created[0].id
    }
    const n1 = await seed('a@x', 'die')
    const n2 = await seed('a@x', 'live')
    const sp = await seed('a@x', 'die', 'spotify')
    await seed('b@y', 'live')

    const before = await agent.get('/api/cookies').expect(200)
    const dupFlags = Object.fromEntries(before.body.items.filter(i => i.account_info?.email === 'a@x').map(i => [i.id, i.dup]))
    expect(dupFlags).toEqual({ [n1]: true, [n2]: true, [sp]: true })
    expect(before.body.items.find(i => i.account_info?.email === 'b@y').dup).toBe(false)

    const r = await agent.post('/api/cookies/remove-duplicates').send({ service: 'netflix' }).expect(200)
    expect(r.body).toEqual({ removed: 1, kept: 1, groups: 1 })
    const after = await agent.get('/api/cookies').expect(200)
    expect(after.body.items.find(i => i.id === sp)).toBeTruthy() // spotify a@x survives
    expect(after.body.items.find(i => i.id === n2).status).toBe('live')
    // scoped dup set: within netflix only one a@x remains → not dup
    const nf = await agent.get('/api/cookies?service=netflix').expect(200)
    expect(nf.body.items.every(i => i.dup === false)).toBe(true)

    await agent.post('/api/cookies/remove-duplicates').send({ service: 'nope' }).expect(400)
  })

  it('POST /:id/nftoken returns link+expires; unknown id → 404', async () => {
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const r = await agent.post(`/api/cookies/${created[0].id}/nftoken`).expect(200)
    expect(r.body).toEqual({ link: 'https://netflix.com/?nftoken=abc%3D', expires: 1790000000000 })
    await agent.post('/api/cookies/99999/nftoken').expect(404)
  })
  it('PATCH label, DELETE removes', async () => {
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    await agent.patch(`/api/cookies/${created[0].id}`).send({ label: 'renamed' }).expect(200)
    await agent.delete(`/api/cookies/${created[0].id}`).expect(200)
    expect((await agent.get('/api/cookies')).body.total).toBe(0)
  })
})

describe('services + settings api', () => {
  let agent
  beforeEach(async () => { agent = await login() })
  it('lists services with counts incl liveCount; patch proxy/disabled', async () => {
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const list = await agent.get('/api/services').expect(200)
    expect(list.body).toEqual([{ key: 'netflix', name: 'Netflix', disabled: 0, cookieCount: 1, liveCount: 0, proxy: null }])
    ctx.db.prepare("UPDATE cookies SET status='live'").run()
    expect((await agent.get('/api/services').expect(200)).body[0]).toMatchObject({ liveCount: 1, cookieCount: 1 })
    await agent.patch('/api/services/netflix').send({ proxy: 'http://127.0.0.1:8080', disabled: true }).expect(200)
    const after = await agent.get('/api/services').expect(200)
    expect(after.body[0]).toMatchObject({ disabled: 1, cookieCount: 1, liveCount: 1, proxy: 'http://127.0.0.1:8080' })
    const row = await agent.get('/api/cookies/check-all').expect(200) // disabled excluded is engine-level; route must accept GET
    expect(row.body).toHaveProperty('running')
  })
  it('settings get/put with validation', async () => {
    const s0 = await agent.get('/api/settings').expect(200)
    expect(s0.body).toEqual({ autoCheckEnabled: false, autoCheckIntervalHours: 6, proxyGlobal: null })
    await agent.put('/api/settings').send({ autoCheckEnabled: true, autoCheckIntervalHours: 12, proxyGlobal: 'socks5://127.0.0.1:1080' }).expect(200)
    expect((await agent.get('/api/settings')).body.autoCheckIntervalHours).toBe(12)
    await agent.put('/api/settings').send({ autoCheckIntervalHours: 500 }).expect(400)
    await agent.put('/api/settings').send({ proxyGlobal: 'ftp://x' }).expect(400)
    await agent.put('/api/settings').send({ autoCheckEnabled: 'false' }).expect(400)
    await agent.put('/api/settings').send({ autoCheckIntervalHours: '12' }).expect(400)
    await agent.put('/api/settings').send({ proxyGlobal: 123 }).expect(400)
  })
  it('password change verifies current', async () => {
    await agent.post('/api/settings/password').send({ currentPassword: 'wrong12345', newPassword: 'newpass12345' }).expect(401)
    await agent.post('/api/settings/password').send({ currentPassword: 'hunter2hunter2', newPassword: 'newpass12345' }).expect(200)
    const agent2 = request.agent(ctx.app)
    await agent2.post('/api/auth/login').set('X-Requested-With', 'XMLHttpRequest').send({ password: 'newpass12345' }).expect(200)
  })
  it('PATCH service proxy rejects invalid scheme', async () => {
    await agent.patch('/api/services/netflix').send({ proxy: 'ftp://x' }).expect(400)
    await agent.patch('/api/services/netflix').send({ proxy: 'not a url' }).expect(400)
    await agent.patch('/api/services/netflix').send({ proxy: 'socks5h://1.2.3.4:1080' }).expect(200)
  })
})
