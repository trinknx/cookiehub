import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createEngine } from '../src/engine.js'
import { initEncryption, generateKeyB64, encryptJSON } from '../src/crypto.js'

const NET = '.netflix.com\tTRUE\t/\tTRUE\t1790000000\tNetflixId\tv-2'
const HDR = 'NetflixId=v-2; SecureSessionId=x'
const adapter = { key: 'netflix', name: 'Netflix', defaultDomain: '.netflix.com', check: async () => ({ status: 'live', reason: 'ok' }), nftoken: async () => ({ link: 'https://netflix.com/?nftoken=abc%3D', linkApp: 'https://netflix.com/val?nftoken=abc%3D', expires: 1790000000000 }), linkTv: async (_ctx, code) => { if (code === 'DEADCODE') { const e = new Error('invalid or expired TV code'); e.status = 400; throw e } return { ok: true, message: 'TV linked — check your TV' } } }
// spotify fixture is registered per-test via ctx.adapters.set — adding it to the
// shared map would break the exact services-list assertion further down
const spotifyFamily = (familyImpl = async () => ({
  address: 'Parko g. 36, Vilnius', inviteLink: 'https://www.spotify.com/us/family/join/invite/T0K3N/',
  isManager: true, addressUpdateRequired: false,
  members: [{ name: 'mgr', username: 'mgr', country: 'LT', isManager: true, isYou: true }],
  usedSeats: 1, maxCapacity: 6
})) => ({ key: 'spotify', name: 'Spotify', defaultDomain: '.spotify.com', check: async () => ({ status: 'live', reason: 'ok' }), family: familyImpl })
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
  it('sort=quality ranks SD < 1080 < 4K, missing quality last in both directions', async () => {
    const seed = async info => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      if (info !== null) ctx.db.prepare('UPDATE cookies SET account_info=? WHERE id=?').run(JSON.stringify(info), created[0].id)
      return created[0].id
    }
    const none = await seed(null)
    const sd = await seed({ extra: { videoQuality: 'Good (SD)' } })
    const hd = await seed({ extra: { videoQuality: '1080p (Full HD)' } })
    const uhd = await seed({ extra: { videoQuality: '4K (Ultra HD)' } })
    const ids = r => r.body.items.map(i => i.id)
    expect(ids(await agent.get('/api/cookies?sort=quality').expect(200))).toEqual([sd, hd, uhd, none])
    expect(ids(await agent.get('/api/cookies?sort=-quality').expect(200))).toEqual([uhd, hd, sd, none])
  })
  it('sort=billing orders ISO dates, not display strings; unknown key falls back to id DESC', async () => {
    const seed = async iso => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      const info = iso ? { nextBilling: 'x ' + iso, nextBillingIso: iso } : { plan: 'Standard' } // ISO-less: parse failed at capture time
      ctx.db.prepare('UPDATE cookies SET account_info=? WHERE id=?').run(JSON.stringify(info), created[0].id)
      return created[0].id
    }
    const late = await seed('2027-01-05')
    const soon = await seed('2026-09-24')
    const noDate = await seed(null) // row without nextBillingIso must land last, not sort by display junk
    const ids = r => r.body.items.map(i => i.id)
    expect(ids(await agent.get('/api/cookies?sort=billing').expect(200))).toEqual([soon, late, noDate])
    expect(ids(await agent.get('/api/cookies?sort=-billing').expect(200))).toEqual([late, soon, noDate])
    expect(ids(await agent.get('/api/cookies?sort=evil;DROP').expect(200))).toEqual([noDate, soon, late]) // id DESC, unknown sort ignored
  })
  it('export header + netscape + Cookie-Editor json', async () => {
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const h = await agent.get(`/api/cookies/${created[0].id}/export?format=header`).expect(200)
    expect(h.body.content).toBe(HDR)
    const n = await agent.get(`/api/cookies/${created[0].id}/export?format=netscape`).expect(200)
    expect(n.body.content).toContain('.netflix.com\t')
    const j = await agent.get(`/api/cookies/${created[0].id}/export?format=json`).expect(200)
    const arr = JSON.parse(j.body.content)
    expect(arr).toHaveLength(2)
    expect(arr[0]).toMatchObject({ name: 'NetflixId', domain: '.netflix.com', path: '/' })
    // __Secure- prefix forces secure:true even when stored false — Chrome drops these silently otherwise
    ctx.db.prepare('UPDATE cookies SET content_enc=? WHERE id=?').run(encryptJSON([{ name: '__Secure-x', value: '1', domain: '.a.com', path: '/', secure: false, httpOnly: false, expiration: null }]), created[0].id)
    const j2 = await agent.get(`/api/cookies/${created[0].id}/export?format=json`).expect(200)
    expect(JSON.parse(j2.body.content)[0].secure).toBe(true)
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
  it('check-all status filter: {status:"unknown"} queues only unknowns; invalid status → 400', async () => {
    const seed = async status => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      if (status !== 'unknown') ctx.db.prepare('UPDATE cookies SET status=? WHERE id=?').run(status, created[0].id)
      return created[0].id
    }
    await seed('unknown'); await seed('unknown'); await seed('live'); await seed('die')
    const r = await agent.post('/api/cookies/check-all').send({ status: 'unknown' }).expect(200)
    expect(r.body.queued).toBe(2)
    // adapter resolves immediately (fake live) — wait for the job to land, then check accounting
    await new Promise(res => setTimeout(res, 100))
    const st = await agent.get('/api/cookies/check-all').expect(200)
    expect(st.body).toMatchObject({ running: false, done: 2, failed: 0 })
    await agent.post('/api/cookies/check-all').send({ status: 'banana' }).expect(400)
  })
  it('check-all status filter: non-string status → 400 invalid_status', async () => {
    const r = await agent.post('/api/cookies/check-all').send({ status: ['unknown'] }).expect(400)
    expect(r.body.error.code).toBe('invalid_status')
  })
  it('check-all accepts on_hold and queues only held accounts', async () => {
    const create = async status => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      ctx.db.prepare('UPDATE cookies SET status=? WHERE id=?').run(status, created[0].id)
    }
    await create('on_hold')
    await create('live')
    const r = await agent.post('/api/cookies/check-all').send({ status: 'on_hold' }).expect(200)
    expect(r.body.queued).toBe(1)
  })

  it('remove-die deletes all die cookies across services; live/unknown untouched', async () => {
    const seed = async (status, service = 'netflix') => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      ctx.db.prepare('UPDATE cookies SET status=?, service_key=? WHERE id=?').run(status, service, created[0].id)
    }
    await seed('die'); await seed('die'); await seed('live'); await seed('unknown'); await seed('on_hold'); await seed('die', 'spotify')
    const r = await agent.post('/api/cookies/remove-die').send({}).expect(200)
    expect(r.body).toEqual({ removed: 3 })
    const list = await agent.get('/api/cookies').expect(200)
    expect(list.body.total).toBe(3)
    expect(list.body.items.map(i => i.status).sort()).toEqual(['live', 'on_hold', 'unknown'])
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
  it('remove-on-hold deletes only held accounts in the requested service', async () => {
    const seed = async (status, service = 'netflix') => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      ctx.db.prepare('UPDATE cookies SET status=?, service_key=? WHERE id=?').run(status, service, created[0].id)
    }
    await seed('on_hold')
    await seed('on_hold')
    await seed('live')
    await seed('die')
    await seed('unknown')
    await seed('on_hold', 'spotify')
    const r = await agent.post('/api/cookies/remove-on-hold').send({ service: 'netflix' }).expect(200)
    expect(r.body).toEqual({ removed: 2 })
    expect((await agent.get('/api/cookies?service=netflix')).body.items.map(i => i.status).sort())
      .toEqual(['die', 'live', 'unknown'])
    expect((await agent.get('/api/cookies?service=spotify&status=on_hold')).body.total).toBe(1)
  })
  it('remove-on-hold rejects an unknown service', async () => {
    const r = await agent.post('/api/cookies/remove-on-hold').send({ service: 'nope' }).expect(400)
    expect(r.body.error.code).toBe('unknown_service')
  })
  it('remove-on-hold requires an explicit service scope', async () => {
    const r = await agent.post('/api/cookies/remove-on-hold').send({}).expect(400)
    expect(r.body.error.code).toBe('service_required')
  })

  it('remove-duplicates keeps live then on_hold before falling back to newest', async () => {
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
    const dHold = await seed('d@h', 'on_hold')
    const dDie = await seed('d@h', 'die') // newer, but authenticated held cookie must win
    const noEmail = await seed(null, 'die') // no email → never touched

    const r = await agent.post('/api/cookies/remove-duplicates').send({}).expect(200)
    expect(r.body).toEqual({ removed: 4, kept: 3, groups: 3 })
    const list = await agent.get('/api/cookies').expect(200)
    const byId = Object.fromEntries(list.body.items.map(i => [i.id, i]))
    expect(Object.keys(byId).map(Number).sort((x, y) => x - y)).toEqual([b1, a2, c2, dHold, noEmail].sort((x, y) => x - y))
    expect(byId[a2].status).toBe('live') // live beats newer id (a3)
    expect(byId[c2]).toBeTruthy() // newest of the die pair
    expect(byId[c1]).toBeUndefined()
    expect(byId[dHold]?.status).toBe('on_hold')
    expect(byId[dDie]).toBeUndefined()
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

  it('dup flag ignores status/q filters (matches removal scope): live row stays dup:true under status=live filter', async () => {
    const seed = async (email, status) => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      ctx.db.prepare('UPDATE cookies SET status=?, account_info=? WHERE id=?').run(status, JSON.stringify({ email }), created[0].id)
      return created[0].id
    }
    await seed('a@x', 'die')
    const live = await seed('a@x', 'live')
    await seed('b@y', 'live')
    const filtered = await agent.get('/api/cookies?status=live').expect(200)
    expect(filtered.body.items).toHaveLength(2) // live a@x + live b@y
    const liveDup = filtered.body.items.find(i => i.id === live)
    expect(liveDup.dup).toBe(true) // its die twin exists → duplicate, even though filtered out here
    expect(filtered.body.items.find(i => i.account_info?.email === 'b@y').dup).toBe(false)
  })

  it('malformed account_info row does not break list or remove-duplicates', async () => {
    const seed = async (accountInfo, status) => {
      const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
      ctx.db.prepare('UPDATE cookies SET status=?, account_info=? WHERE id=?').run(status, accountInfo, created[0].id)
      return created[0].id
    }
    const a1 = await seed(JSON.stringify({ email: 'a@x' }), 'die')
    const a2 = await seed(JSON.stringify({ email: 'a@x' }), 'live')
    const bad = await seed('not json', 'die')
    const list = await agent.get('/api/cookies').expect(200) // no 500 despite malformed row
    expect(list.body.items.find(i => i.id === bad).dup).toBe(false)
    const r = await agent.post('/api/cookies/remove-duplicates').send({}).expect(200)
    expect(r.body).toEqual({ removed: 1, kept: 1, groups: 1 })
    const after = await agent.get('/api/cookies').expect(200)
    expect(after.body.items.map(i => i.id).sort((x, y) => x - y)).toEqual([a2, bad].sort((x, y) => x - y)) // malformed row untouched
  })

  it('remove-duplicates handles 1201-row duplicate group (bind-limit regression)', async () => {
    const insert = ctx.db.prepare('INSERT INTO cookies(service_key,label,content_enc,source_format,notes,created_at,updated_at,status,account_info) VALUES(?,?,?,?,?,?,?,?,?)')
    ctx.db.transaction(() => {
      for (let i = 0; i < 1201; i++) insert.run('netflix', '', 'x', 'header', '', Date.now(), Date.now(), i === 0 ? 'live' : 'die', JSON.stringify({ email: 'bulk@x' }))
    })()
    const r = await agent.post('/api/cookies/remove-duplicates').send({}).expect(200)
    expect(r.body).toEqual({ removed: 1200, kept: 1, groups: 1 })
    const list = await agent.get('/api/cookies').expect(200)
    expect(list.body.items).toHaveLength(1)
    expect(list.body.items[0].status).toBe('live')
  })

  it('POST /:id/nftoken returns web+app links+expires; unknown id → 404', async () => {
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const r = await agent.post(`/api/cookies/${created[0].id}/nftoken`).expect(200)
    expect(r.body).toEqual({ link: 'https://netflix.com/?nftoken=abc%3D', linkApp: 'https://netflix.com/val?nftoken=abc%3D', expires: 1790000000000 })
    await agent.post('/api/cookies/99999/nftoken').expect(404)
  })

  it('POST /:id/linktv: valid code passes through; invalid formats and adapter rejections map to 400', async () => {
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const ok = await agent.post(`/api/cookies/${created[0].id}/linktv`).send({ code: 'A1B2C3D4' }).expect(200)
    expect(ok.body).toEqual({ ok: true, message: 'TV linked — check your TV' })
    await agent.post(`/api/cookies/${created[0].id}/linktv`).send({ code: 'ab' }).expect(400) // too short
    await agent.post(`/api/cookies/${created[0].id}/linktv`).send({}).expect(400) // missing
    await agent.post(`/api/cookies/${created[0].id}/linktv`).send({ code: 'DEADCODE' }).expect(400) // adapter verdict
    await agent.post('/api/cookies/99999/linktv').send({ code: 'A1B2C3D4' }).expect(404)
  })
  it('POST /:id/family: spotify cookie returns payload; netflix cookie → 422 (spotify-only); unknown id → 404', async () => {
    ctx.adapters.set('spotify', spotifyFamily())
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'spotify', content: 'sp_dc=x; sp_key=y' })
    const r = await agent.post(`/api/cookies/${created[0].id}/family`).expect(200)
    expect(r.body).toMatchObject({ address: 'Parko g. 36, Vilnius', inviteLink: 'https://www.spotify.com/us/family/join/invite/T0K3N/', isManager: true })
    const nf = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    await agent.post(`/api/cookies/${nf.body.created[0].id}/family`).expect(422)
    await agent.post('/api/cookies/99999/family').expect(404)
  })
  it('POST /:id/family: adapter verdict (dead session / non-family) → 400 family_failed', async () => {
    ctx.adapters.set('spotify', spotifyFamily(async () => { const e = new Error('account is not on a Family plan'); e.status = 400; throw e }))
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'spotify', content: 'sp_dc=x' })
    const r = await agent.post(`/api/cookies/${created[0].id}/family`).expect(400)
    expect(r.body.error).toMatchObject({ code: 'family_failed', message: 'account is not on a Family plan' })
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
    await agent.patch('/api/services/netflix').send({ proxy: 'direct' }).expect(200)
    expect((await agent.get('/api/services')).body[0].proxy).toBe('direct')
  })
})

describe('backup + restore api', () => {
  let agent
  const binary = (res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))) }
  beforeEach(async () => { agent = await login() })

  it('GET /api/backup → valid sqlite snapshot; POST restores a wiped db', async () => {
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR, label: 'keep-me' })
    const dl = await agent.get('/api/backup').buffer().parse(binary).expect(200)
    expect(dl.headers['content-type']).toContain('application/octet-stream')
    expect(dl.headers['content-disposition']).toMatch(/cookiehub-backup-.*\.db/)
    expect(dl.body.subarray(0, 15).toString()).toBe('SQLite format 3')
    const snap = new Database(dl.body) // snapshot is a real, queryable db
    expect(snap.prepare('SELECT COUNT(*) c FROM cookies').get().c).toBe(1)
    snap.close()
    ctx.db.prepare('DELETE FROM cookies').run() // wipe live, then restore
    expect((await agent.get('/api/cookies')).body.total).toBe(0)
    const r = await agent.post('/api/backup').set('content-type', 'application/octet-stream').send(dl.body).expect(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.restored.cookies).toBe(1)
    const after = await agent.get('/api/cookies')
    expect(after.body.total).toBe(1)
    expect(after.body.items[0].label).toBe('keep-me')
  })
  it('restore inserts parents before FK children — snapshot logs reference ids absent from live db', async () => {
    const add = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR, label: 'snap' }).expect(200)
    ctx.db.prepare('INSERT INTO check_logs(cookie_id,status,reason,created_at) VALUES(?,?,?,?)')
      .run(add.body.created[0].id, 'live', 'test log', Date.now())
    const dl = await agent.get('/api/backup').buffer().parse(binary).expect(200)
    // live db now diverges: wipe (cascades logs) and let a NEW cookie take the
    // next autoincrement id — the snapshot's log id no longer exists live
    ctx.db.prepare('DELETE FROM cookies').run()
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR, label: 'other' }).expect(200)
    const r = await agent.post('/api/backup').set('content-type', 'application/octet-stream').send(dl.body).expect(200)
    expect(r.body.restored.cookies).toBe(1)
    expect(r.body.restored.check_logs).toBe(1)
    expect((await agent.get('/api/cookies')).body.items[0].label).toBe('snap')
  })
  it('restore rejects garbage and wrong-key backups without touching data', async () => {
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR, label: 'survivor' })
    await agent.post('/api/backup').set('content-type', 'application/octet-stream').send('this is not a database').expect(400)
    // same schema, content_enc undecryptable under the current key (== backup
    // from an install with a different ENCRYPTION_KEY) → 409, live data intact
    const foreignPath = path.join(os.tmpdir(), `foreign-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    const cols = ctx.db.prepare('PRAGMA table_info(cookies)').all().map(c => c.name)
    const foreign = new Database(foreignPath)
    foreign.exec(`CREATE TABLE cookies (${cols.map(c => `"${c}" TEXT`).join(',')})`)
    foreign.prepare(`INSERT INTO cookies (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...cols.map(c => (c === 'content_enc' ? randomBytes(72) : c === 'service_key' ? 'netflix' : null)))
    foreign.close()
    await agent.post('/api/backup').set('content-type', 'application/octet-stream').send(fs.readFileSync(foreignPath)).expect(409)
    fs.unlinkSync(foreignPath)
    expect((await agent.get('/api/cookies')).body.total).toBe(1) // untouched
  })
})
