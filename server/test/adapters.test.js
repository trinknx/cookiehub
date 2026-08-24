import { loadAdapters } from '../src/adapters/index.js'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { describe, it, expect } from 'vitest'
import netflix from '../src/adapters/netflix.js'
import spotify from '../src/adapters/spotify.js'

const res = (status, body = '', headers = {}) => ({
  status, headers: { get: k => headers[k.toLowerCase()] ?? null }, text: async () => body
})
const ctxOf = responses => {
  let i = 0
  return { cookieHeader: 'a=1', cookies: [], log: () => {}, fetch: async () => responses[i++] }
}

describe('netflix adapter', () => {
  it('3xx to /login → die', async () => {
    const r = await netflix.check(ctxOf([res(302, '', { location: 'https://www.netflix.com/login' })]))
    expect(r).toMatchObject({ status: 'die' })
    expect(r.reason).toContain('/login')
  })
  it('200 → live with country from body', async () => {
    const r = await netflix.check(ctxOf([
      res(200, '{"currentCountry":"VN"}'),
      res(200, '<b data-uia="plan-name"><div>Premium</div></b><div data-uia="next-bill-date">August 30, 2026</div>"email":"a@gmail.com"')
    ]))
    expect(r.status).toBe('live')
    expect(r.accountInfo).toMatchObject({ country: 'VN', plan: 'Premium', email: 'a@gmail.com', expiresAt: 'August 30, 2026' })
  })
  it('account fetch failure still → live', async () => {
    let call = 0
    const ctx = { cookieHeader: 'a=1', cookies: [], log: () => {}, fetch: async () => { if (call++ === 0) return res(200, ''); throw new Error('boom') } }
    const r = await netflix.check(ctx)
    expect(r.status).toBe('live')
  })
  it('429 → throws (transient, not die)', async () => {
    await expect(netflix.check(ctxOf([res(429)]))).rejects.toThrow('HTTP 429')
  })
  it('500 → throws (transient, not die)', async () => {
    await expect(netflix.check(ctxOf([res(500)]))).rejects.toThrow('HTTP 500')
  })
})

describe('spotify adapter', () => {
  it('401 → die', async () => {
    const r = await spotify.check(ctxOf([res(401)]))
    expect(r).toMatchObject({ status: 'die', reason: 'HTTP 401' })
  })
  it('3xx → die', async () => {
    const r = await spotify.check(ctxOf([res(302, '', { location: '/login' })]))
    expect(r.status).toBe('die')
  })
  it('200 → live with parsed email/plan', async () => {
    const r = await spotify.check(ctxOf([res(200, '"email":"me@gmail.com","plan":"Premium","renewalDate":"2026-09-01"')]))
    expect(r).toMatchObject({ status: 'live' })
    expect(r.accountInfo).toMatchObject({ email: 'me@gmail.com', plan: 'Premium' })
  })
  it('429 → throws (transient, not die)', async () => {
    await expect(spotify.check(ctxOf([res(429)]))).rejects.toThrow('HTTP 429')
  })
  it('500 → throws (transient, not die)', async () => {
    await expect(spotify.check(ctxOf([res(500)]))).rejects.toThrow('HTTP 500')
  })
})

describe('registry', () => {
  it('loads netflix + spotify with unique keys', async () => {
    const map = await loadAdapters(path.resolve('src/adapters'))
    expect([...map.keys()].sort()).toEqual(['netflix', 'spotify'])
    expect(map.get('netflix').defaultDomain).toBe('.netflix.com')
  })
  it('rejects adapter with non-string metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookiehub-adapters-'))
    try {
      fs.writeFileSync(path.join(dir, 'bad.js'), 'export default { key: {}, name: 1, defaultDomain: [], check() {} }\n')
      await expect(loadAdapters(dir)).rejects.toThrow(/invalid adapter bad\.js/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
