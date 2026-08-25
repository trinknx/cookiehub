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
  it('3xx to non-login (locale/canonical/maintenance) → throws transient, not die', async () => {
    await expect(netflix.check(ctxOf([res(302, '', { location: '/vi/' })]))).rejects.toThrow('transient redirect to /vi/')
    await expect(netflix.check(ctxOf([res(301, '', { location: '/maintenance' })]))).rejects.toThrow('transient redirect to /maintenance')
  })
  it('3xx login detection is case-insensitive', async () => {
    const r = await netflix.check(ctxOf([res(302, '', { location: 'https://www.netflix.com/vi/Login' })]))
    expect(r).toMatchObject({ status: 'die' })
    expect(r.reason).toContain('/vi/Login')
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

describe('netflix nftoken', () => {
  const COOKIES = [
    { name: 'cl', value: 'h', domain: '.netflix.com' },
    { name: 'NetflixId', value: 'v%3D-1', domain: '.netflix.com' },
    { name: 'SecureNetflixId', value: 'v-2', domain: '.netflix.com' },
    { name: 'nfvdid', value: 'd-1', domain: '.netflix.com' },
    { name: 'rememberMe', value: 'x', domain: '.netflix.com' }
  ]
  const okBody = token => ({ ok: true, status: 200, json: async () => ({ value: { account: { token: { default: { token, expires: 1790000000000 } } } } }) })

  it('requests the Argo endpoint and returns link+expires', async () => {
    const calls = []
    const fetch = async (url, init) => { calls.push({ url, init }); return okBody('tök=en&+') }
    const r = await netflix.nftoken({ cookies: COOKIES, fetch, log: () => {} })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('https://ios.prod.ftl.netflix.com/iosui/user/15.48?')
    expect(calls[0].url).toContain('account%22%2C%22token')
    expect(calls[0].url).toContain('esn=NFAPPL-02-IPHONE8%3D1-')
    expect(calls[0].url).toContain('pathFormat=graph')
    // Argo headers win over the engine's browser defaults
    expect(calls[0].init.headers['user-agent']).toContain('Argo/15.48.1')
    expect(calls[0].init.headers['x-netflix.client.type']).toBe('argo')
    // only the three auth cookies go out
    expect(calls[0].init.headers.cookie).toBe('NetflixId=v%3D-1; SecureNetflixId=v-2; nfvdid=d-1')
    expect(r).toEqual({ link: 'https://netflix.com/?nftoken=' + encodeURIComponent('tök=en&+'), expires: 1790000000000 })
  })
  it('missing NetflixId → throws before any fetch', async () => {
    const calls = []
    const fetch = async (url, init) => { calls.push({ url, init }); return okBody('t') }
    await expect(netflix.nftoken({ cookies: [{ name: 'nfvdid', value: 'x' }], fetch, log: () => {} }))
      .rejects.toThrow('NetflixId cookie missing')
    expect(calls).toHaveLength(0)
  })
  it('empty cookies → throws before any fetch', async () => {
    let called = false
    const fetch = async () => { called = true; return okBody('t') }
    await expect(netflix.nftoken({ cookies: [], fetch, log: () => {} })).rejects.toThrow('NetflixId cookie missing')
    expect(called).toBe(false)
  })
  it('non-ok HTTP → throws with status', async () => {
    const fetch = async () => ({ ok: false, status: 403, json: async () => ({}) })
    await expect(netflix.nftoken({ cookies: COOKIES, fetch, log: () => {} })).rejects.toThrow('nftoken HTTP 403')
  })
  it('response without token → throws (dead cookie)', async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ value: { account: {} } }) })
    await expect(netflix.nftoken({ cookies: COOKIES, fetch, log: () => {} }))
      .rejects.toThrow('no nftoken in response')
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
  it('3xx to non-login (accounts redirect elsewhere) → throws transient, not die', async () => {
    await expect(spotify.check(ctxOf([res(302, '', { location: '/maintenance' })]))).rejects.toThrow('transient redirect to /maintenance')
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
