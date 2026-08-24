import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { openDb } from '../src/db.js'
import { buildApp } from '../src/app.js'

const build = () => buildApp({ db: openDb(), adapters: new Map(), engine: null, scheduler: null })

describe('auth flow', () => {
  it('GET /api/auth/session → needsSetup true initially', async () => {
    const res = await request(build()).get('/api/auth/session')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ authenticated: false, needsSetup: true })
  })

  it('setup → session → logout', async () => {
    const app = build()
    const agent = request.agent(app)
    await agent.post('/api/auth/setup').send({ password: 'hunter2hunter2' }).expect(200)
    expect((await agent.get('/api/auth/session')).body).toEqual({ authenticated: true, needsSetup: false })
    await agent.post('/api/auth/logout').expect(200)
    expect((await agent.get('/api/auth/session')).body.authenticated).toBe(false)
  })

  it('setup twice → 409; login wrong password → 401; login right → 200', async () => {
    const app = build()
    const agent = request.agent(app)
    await agent.post('/api/auth/setup').send({ password: 'hunter2hunter2' }).expect(200)
    await request(app).post('/api/auth/setup').send({ password: 'other12345' }).expect(409)
    await request(app).post('/api/auth/login').send({ password: 'wrongwrong1' }).expect(401)
    await agent.post('/api/auth/login').send({ password: 'hunter2hunter2' }).expect(200)
  })

  it('short password → 400', async () => {
    await request(build()).post('/api/auth/setup').send({ password: 'short' }).expect(400)
  })

  it('unknown /api route without session → 401; with session but no CSRF header → 403', async () => {
    const app = build()
    await request(app).get('/api/cookies').expect(401)
    const agent = request.agent(app)
    await agent.post('/api/auth/setup').send({ password: 'hunter2hunter2' })
    await agent.post('/api/cookies').send({}).expect(403)
  })

  it('5 bad logins → 429', async () => {
    const app = build()
    await request(app).post('/api/auth/setup').send({ password: 'hunter2hunter2' })
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ password: 'bad' + i }).expect(401)
    await request(app).post('/api/auth/login').send({ password: 'bad6' }).expect(429)
  })

  it('concurrent setups → exactly one 200, one 409', async () => {
    const app = build()
    const [a, b] = await Promise.all([
      request(app).post('/api/auth/setup').send({ password: 'hunter2hunter2' }),
      request(app).post('/api/auth/setup').send({ password: 'other123456' })
    ])
    expect([a.status, b.status]).toContain(200)
    expect([a.status, b.status]).toContain(409)
  })

  it('unknown /api/auth route without session → 404 with error shape', async () => {
    const res = await request(build()).get('/api/auth/unknown')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'unknown auth route' } })
  })
})
