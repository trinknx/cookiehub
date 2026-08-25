import { loadAdapters } from '../src/adapters/index.js'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import netflix from '../src/adapters/netflix.js'
import spotify from '../src/adapters/spotify.js'
import chatgpt from '../src/adapters/chatgpt.js'
import claude from '../src/adapters/claude.js'
import hbomax from '../src/adapters/hbomax.js'
import { impFetch } from '../src/impersonate.js'

vi.mock('../src/impersonate.js', () => ({ impFetch: vi.fn() }))

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
  it('3xx to non-login non-homepage (maintenance) → throws transient, not die', async () => {
    await expect(netflix.check(ctxOf([
      res(302, '', { location: '/maintenance' }),
      res(200, '<html>maintenance page</html>')
    ]))).rejects.toThrow('transient redirect to https://www.netflix.com/maintenance')
  })
  // Controller-verified live probe (2026-08-25, real dead cookie): a dead
  // session /browse hops / → /vn-en/ → 200 marketing homepage. A chain that
  // settles on the root or a locale homepage means NOT authenticated → die.
  it('homepage chain /browse → / → /vn-en/ → 200 → die', async () => {
    const r = await netflix.check(ctxOf([
      res(302, '', { location: 'https://www.netflix.com/' }),
      res(302, '', { location: '/vn-en/' }),
      res(200, '<html>marketing homepage</html>')
    ]))
    expect(r).toMatchObject({ status: 'die' })
    expect(r.reason).toContain('not authenticated')
  })
  it('single-hop redirect to root homepage → die', async () => {
    const r = await netflix.check(ctxOf([
      res(302, '', { location: 'https://www.netflix.com/' }),
      res(200, '<html>homepage</html>')
    ]))
    expect(r).toMatchObject({ status: 'die' })
    expect(r.reason).toContain('not authenticated')
  })
  it('locale-root redirect (/en-us/) → die', async () => {
    const r = await netflix.check(ctxOf([
      res(302, '', { location: '/en-us/' }),
      res(200, '<html>homepage</html>')
    ]))
    expect(r).toMatchObject({ status: 'die' })
    expect(r.reason).toContain('not authenticated')
  })
  it('relative Location resolves against the issuing URL, not a fixed base', async () => {
    let i = 0
    const calls = []
    const responses = [
      res(302, '', { location: '/a/' }),
      res(302, '', { location: 'next' }), // 'next' relative to /a/ → https://www.netflix.com/a/next
      res(200, '<html>some page</html>')
    ]
    const ctx = { cookieHeader: 'a=1', cookies: [], log: () => {}, fetch: async u => { calls.push(u); return responses[i++] } }
    // /a/next is not a homepage path → transient, and the message proves the base used
    await expect(netflix.check(ctx)).rejects.toThrow('transient redirect to https://www.netflix.com/a/next')
    expect(calls[2]).toBe('https://www.netflix.com/a/next')
  })
  it('relative Location climbing to the homepage → die', async () => {
    const r = await netflix.check(ctxOf([
      res(302, '', { location: '/a/' }),
      res(302, '', { location: '..' }), // resolves to https://www.netflix.com/
      res(200, '<html>homepage</html>')
    ]))
    expect(r).toMatchObject({ status: 'die' })
    expect(r.reason).toContain('not authenticated')
  })
  it('4-hop budget exhausted on a terminal login redirect → die without a 5th fetch', async () => {
    let i = 0
    const calls = []
    const responses = ['a1', 'a2', 'a3', 'a4'].map(l => res(302, '', { location: l }))
      .concat(res(302, '', { location: 'https://www.netflix.com/login' }))
    const ctx = { cookieHeader: 'a=1', cookies: [], log: () => {}, fetch: async u => { calls.push(u); return responses[i++] } }
    const r = await netflix.check(ctx)
    expect(r).toMatchObject({ status: 'die' })
    expect(r.reason).toContain('/login')
    expect(calls.length).toBe(5) // /browse + 4 hops; the terminal login Location is inspected, not fetched
  })
  it('final 200 at path // is not a homepage → transient', async () => {
    await expect(netflix.check(ctxOf([
      res(302, '', { location: 'https://www.netflix.com//' }),
      res(200, '<html>odd page</html>')
    ]))).rejects.toThrow('transient redirect to https://www.netflix.com//')
  })
  it('3xx login detection is case-insensitive', async () => {
    const r = await netflix.check(ctxOf([res(302, '', { location: 'https://www.netflix.com/vi/Login' })]))
    expect(r).toMatchObject({ status: 'die' })
    expect(r.reason).toContain('/vi/Login')
  })
  // Real /account bytes (verified char-by-char against a live US page, 2026-08-25):
  // the form-render model is embedded as PLAIN-quote JSON — no backslash escapes
  // anywhere. reactContext string values DO carry JS hex escapes (\x40 = @,
  // \x20 = space) that must be unescaped before storing; String.raw keeps them.
  const FORM_MODEL = '"currentPlan":{"fieldType":"Group","fieldGroup":"MemberPlan","fields":{"localizedPlanName":{"fieldType":"String","value":"Standard"},"maxStreams":{"fieldType":"Numeric","value":2},"videoQuality":{"fieldType":"String","value":"HD"},"planId":{"fieldType":"String","value":"10341"},"hasAds":{"fieldType":"Boolean","value":false}},"memberSince":{"fieldType":"Numeric","value":1701993600000}'
  const REACT_CONTEXT = String.raw`"name":"Himachandan","emailAddress":"mikekugler1\x40gmail.com","currentCountry":"US","memberSince":"December\x202023"`
  const ACCOUNT_HTML = [
    `<script>reactContext = {"userInfo":{"data":{${REACT_CONTEXT}}}};</script>`,
    `<script type="application/json">${FORM_MODEL}</script>`,
    // decoys: marketing copy + the old (dead) data-uia hooks must not leak in
    '<div data-uia="plan-name"><div>Premium</div></div>',
    '<div data-uia="next-bill-date">August 30, 2026</div>',
    '<section>Get Premium on any device — Standard with ads from $2.99</section>',
    '"planName":"Mobile"'
  ].join('\n')
  it('200 → live with account info from verified /account structure', async () => {
    const r = await netflix.check(ctxOf([
      res(200, '<html><body>browse page — no reactContext here</body></html>'), // country must come from /account
      res(200, ACCOUNT_HTML)
    ]))
    expect(r.status).toBe('live')
    expect(r.accountInfo).toEqual({
      plan: 'Standard',
      email: 'mikekugler1@gmail.com',
      country: 'US',
      memberSince: 'December 2023',
      extra: { maxStreams: 2, videoQuality: 'HD' }
    })
  })
  it('account fetch failure still → live, browse country must not leak', async () => {
    let call = 0
    const ctx = { cookieHeader: 'a=1', cookies: [], log: () => {}, fetch: async () => { if (call++ === 0) return res(200, '{"currentCountry":"US"}'); throw new Error('boom') } }
    const r = await netflix.check(ctx)
    expect(r.status).toBe('live')
    expect(r.accountInfo).toBeUndefined()
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

// tv8 form fields verified against the live page 2026-08-25: hidden inputs
// flow + authURL (page token), POST to the same URL with flowMode
// enterTvLoginRendezvousCode, code + tvLoginRendezvousCode, action=nextAction.
// Bad code re-renders the entry page with "Something went wrong. Try again.".
describe('netflix linkTv', () => {
  const TV8 = '<form method="post"><input name="flow" value="websiteSignUp"><input name="authURL" value="c1.1787660026665.AgiMlOvcAxIgn9HJoNwPuMo"></form>'
  const seq = responses => { let i = 0; const calls = []; return { calls, fetch: async (url, init) => { calls.push({ url, init }); return responses[i++] } } }

  it('GETs tv8 for authURL, POSTs the form with the uppercased code → ok', async () => {
    const { calls, fetch } = seq([
      res(200, TV8),
      res(200, '<html>Signing in to your TV…</html>')
    ])
    const r = await netflix.linkTv({ fetch, log: () => {} }, 'a1b2c3d4')
    expect(r).toEqual({ ok: true, message: 'TV linked — check your TV' })
    expect(calls[0].url).toBe('https://www.netflix.com/tv8')
    expect(calls[1].init.method).toBe('POST')
    expect(calls[1].init.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(calls[1].init.body).toContain('code=A1B2C3D4')
    expect(calls[1].init.body).toContain('tvLoginRendezvousCode=A1B2C3D4')
    expect(calls[1].init.body).toContain('authURL=c1.1787660026665.AgiMlOvcAxIgn9HJoNwPuMo')
    expect(calls[1].init.body).toContain('flowMode=enterTvLoginRendezvousCode')
    expect(calls[1].init.body).toContain('action=nextAction')
  })
  it('re-rendered entry page (Something went wrong) → invalid code error, status 400', async () => {
    const { fetch } = seq([res(200, TV8), res(200, TV8 + '<p class="error">Something went wrong. Try again.</p>')])
    const err = await netflix.linkTv({ fetch, log: () => {} }, 'A1B2C3D4').catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('invalid or expired TV code')
    expect(err.status).toBe(400)
  })
  it('bad code format → throws before any request', async () => {
    let called = false
    await expect(netflix.linkTv({ fetch: async () => { called = true; return res(200, '') }, log: () => {} }, 'A1!')).rejects.toThrow('invalid code format')
    expect(called).toBe(false)
  })
  it('tv8 page without authURL → session suspect', async () => {
    await expect(netflix.linkTv({ fetch: async () => res(200, '<html>login page</html>'), log: () => {} }, 'A1B2C3D4'))
      .rejects.toThrow('tv8 page has no authURL')
  })
})

describe('hbomax linkTv', () => {
  const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const jwt = (claims = {}) => `x.${b64url(claims)}.y`
  const jres = (status, obj) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(obj), json: async () => obj })
  const v2 = (anon, claims) => jres(200, { data: { attributes: { realm: 'bolt', anonymous: anon, token: jwt(claims) } } })
  const COOKIES = [{ name: 'st', value: jwt({ sub: 'USERID:bolt:u1', exp: 2082049205, anonymous: false }) }]
  const seq = responses => { let i = 0; const calls = []; return { calls, fetch: async (url, init) => { calls.push({ url, init }); return responses[i++] } } }

  it('mints token, resolves home market, POSTs linkingCode to connect → ok', async () => {
    const { calls, fetch } = seq([
      v2(false, { sub: 'USERID:bolt:u1', anonymous: false, subdivision: 'beam_latam' }),
      jres(200, { routing: { homeMarket: 'latam' } }),
      jres(200, {})
    ])
    const r = await hbomax.linkTv({ cookies: COOKIES, fetch, log: () => {} }, 'wx9yz')
    expect(r).toEqual({ ok: true, message: 'TV linked — check your TV' })
    expect(calls[2].url).toBe('https://default.any-latam.prd.api.hbomax.com/authentication/linkDevice/connect')
    expect(calls[2].init.body).toBe('{"linkingCode":"WX9YZ"}') // uppercased
    expect(calls[2].init.headers.authorization).toMatch(/^Bearer x\./)
  })
  it('connect invalid.code → invalid TV code, status 400', async () => {
    const { fetch } = seq([
      v2(false, { anonymous: false }),
      jres(200, { routing: { homeMarket: 'latam' } }),
      jres(400, { errors: [{ status: '400', code: 'invalid.code', detail: 'linkingCode required to validate.' }] })
    ])
    const err = await hbomax.linkTv({ cookies: COOKIES, fetch, log: () => {} }, 'ZZZZ').catch(e => e)
    expect(err.message).toBe('invalid or expired TV code')
    expect(err.status).toBe(400)
  })

  it('connect 204 No Content (verified real-TV-code shape) → ok', async () => {
    const noContent = { status: 204, headers: { get: () => null }, text: async () => '', json: async () => { throw new Error('no body') } }
    const { fetch } = seq([
      v2(false, { anonymous: false }),
      jres(200, { routing: { homeMarket: 'latam' } }),
      noContent
    ])
    const r = await hbomax.linkTv({ cookies: COOKIES, fetch, log: () => {} }, '030520')
    expect(r).toEqual({ ok: true, message: 'TV linked — check your TV' })
  })
  it('dead session (anonymous mint) → 400 before any connect call', async () => {
    const { calls, fetch } = seq([v2(true, { anonymous: true })])
    const err = await hbomax.linkTv({ cookies: COOKIES, fetch, log: () => {} }, 'ZZZZ').catch(e => e)
    expect(err.message).toContain('session invalid')
    expect(err.status).toBe(400)
    expect(calls).toHaveLength(1)
  })
  it('bad code format → throws before any request', async () => {
    let called = false
    await expect(hbomax.linkTv({ cookies: COOKIES, fetch: async () => { called = true; return res(200, '{}') }, log: () => {} }, 'ABC')).rejects.toThrow('invalid code format')
    expect(called).toBe(false)
  })
})

describe('spotify adapter', () => {
  // page shapes verified live 2026-08-25: __NEXT_DATA__ → props.username,
  // props.isAnonymous, pageProps…PlanCard planName; death = login redirect chain
  const page = (planName, username) => '<script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({ props: { username, isAnonymous: false, pageProps: { dynamicWidgets: { PlanCard: [{ props: { planName, addons: [] } }] } } } }) +
    '</script>'

  it('302 to login location → die without fetching it', async () => {
    let calls = 0
    const ctx = { cookieHeader: 'a=1', cookies: [], log: () => {}, fetch: async () => { calls++; return res(302, '', { location: 'https://accounts.spotify.com/en/login?continue=x' }) } }
    const r = await spotify.check(ctx)
    expect(r).toMatchObject({ status: 'die' })
    expect(calls).toBe(1)
  })
  it('locale redirect then 200 → live with plan + username (verified Premium shape)', async () => {
    const r = await spotify.check(ctxOf([
      res(302, '', { location: '/vn-vi/account/overview/' }),
      res(200, page('Premium Individual', 'emile_heskey_'))
    ]))
    expect(r).toMatchObject({ status: 'live', reason: 'logged in' })
    expect(r.accountInfo).toEqual({ plan: 'Premium Individual', extra: { username: 'emile_heskey_' } })
  })
  it('chained locale redirects → live; Locations resolve against the issuing URL', async () => {
    let i = 0
    const urls = []
    const responses = [
      res(302, '', { location: '/us/account/overview/' }),
      res(302, '', { location: '/vn-vi/account/overview/' }),
      res(200, page('Spotify Free', 'didikong59'))
    ]
    const ctx = { cookieHeader: 'a=1', cookies: [], log: () => {}, fetch: async u => { urls.push(u); return responses[i++] } }
    const r = await spotify.check(ctx)
    expect(r.status).toBe('live')
    expect(r.accountInfo.plan).toBe('Spotify Free')
    expect(urls).toEqual([
      'https://www.spotify.com/account/overview/',
      'https://www.spotify.com/us/account/overview/',
      'https://www.spotify.com/vn-vi/account/overview/'
    ])
  })
  it('hop budget exhausted on non-login redirects → throws transient, not die', async () => {
    // initial fetch + 4 hop fetches, all non-login 3xx → terminal a4 inspected, not fetched
    const responses = ['a0', 'a1', 'a2', 'a3', 'a4'].map(l => res(302, '', { location: l }))
    await expect(spotify.check(ctxOf(responses))).rejects.toThrow('transient redirect to a4')
  })
  it('hop budget exhausted on terminal login redirect → die without a 6th fetch', async () => {
    const responses = ['a1', 'a2', 'a3', 'a4'].map(l => res(302, '', { location: l }))
      .concat(res(302, '', { location: '/en/login' }))
    let calls = 0
    const ctx = { cookieHeader: 'a=1', cookies: [], log: () => {}, fetch: async () => { calls++; return responses[calls - 1] } }
    const r = await spotify.check(ctx)
    expect(r).toMatchObject({ status: 'die' })
    expect(calls).toBe(5) // initial + 4 hops; terminal Location inspected, not fetched
  })
  it('200 landing on a login URL (verified dead sp_dc shape) → die', async () => {
    let i = 0
    const responses = [
      res(302, '', { location: '/vn-vi/account/overview/' }),
      res(302, '', { location: 'https://accounts.spotify.com/en/login?continue=x' }),
      res(200, '<html>login page without next data structure</html>')
    ]
    const ctx = { cookieHeader: 'a=1', cookies: [], log: () => {}, fetch: async () => responses[i++] }
    // hop loop dies on the login Location before fetching the 200 — verified flow
    const r = await spotify.check(ctx)
    expect(r.status).toBe('die')
  })
  it('401/403 → die', async () => {
    expect(await spotify.check(ctxOf([res(401)]))).toMatchObject({ status: 'die', reason: 'HTTP 401' })
    expect(await spotify.check(ctxOf([res(403)]))).toMatchObject({ status: 'die', reason: 'HTTP 403' })
  })
  it('200 without __NEXT_DATA__ → throws transient (unexpected page)', async () => {
    await expect(spotify.check(ctxOf([res(200, '<html>maintenance</html>')]))).rejects.toThrow('no __NEXT_DATA__')
  })
  it('200 with __NEXT_DATA__ but no planName (anonymous) → die no session', async () => {
    const body = '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { username: null, isAnonymous: true, pageProps: {} } }) + '</script>'
    const r = await spotify.check(ctxOf([res(200, body)]))
    expect(r).toEqual({ status: 'die', reason: 'no session' })
  })
  it('429/500 → throws (transient, not die)', async () => {
    await expect(spotify.check(ctxOf([res(429)]))).rejects.toThrow('HTTP 429')
    await expect(spotify.check(ctxOf([res(500)]))).rejects.toThrow('HTTP 500')
  })
})

describe('spotify family', () => {
  // home-hub shapes verified live 2026-08-25 with stored cookies: manager (#2501)
  // = full address + persistent inviteToken; member (#2518) = both empty strings
  // (Spotify hides them from non-managers); Premium Individual (#2441) =
  // homeHubData {} with pageProps.error set; dead sp_dc = login redirect chain.
  // Join-link shape lifted verbatim from the manage UI DOM (invite input value).
  const hub = (hd, props = {}) => '<script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({ props: { pageProps: { homeHubData: hd, ...props } } }) + '</script>'
  const MGR = {
    address: 'Parko g. 36, Vilnius, 11216 Vilniaus m. sav., Lithuania',
    inviteToken: 'Z7x75zBaC1caZ9y', homeId: 'e61c04d1-a485-4d98-b6e6-43a2eb2ac7d0', maxCapacity: 6,
    permissions: { planHasFreeSlots: true, addressUpdateRequired: false },
    members: [
      { username: 'afd694e36oss64ou7bcx8sumx', name: 'l1nx', country: 'LT', isLoggedInUser: true, isMaster: true },
      { username: 'didikong59', name: 'didikong59', country: 'FR', isLoggedInUser: false, isMaster: false }
    ]
  }
  const MEMBER = {
    address: '', inviteToken: '', homeId: 'ebaeaab8-a18b-440a-8d90-e333478ce6b3', maxCapacity: 6,
    permissions: { planHasFreeSlots: true, addressUpdateRequired: true },
    members: [
      { username: 'didikong59', name: 'didikong59', country: 'FR', isLoggedInUser: true, isMaster: false },
      { username: 'gcg0532fj4mik2gbr6nrjqm20', name: 'fanny', country: 'FR', isLoggedInUser: false, isMaster: true }
    ]
  }

  it('manager → address + join link from the persistent token, members mapped with roles', async () => {
    const r = await spotify.family(ctxOf([res(200, hub(MGR))]))
    expect(r).toEqual({
      address: 'Parko g. 36, Vilnius, 11216 Vilniaus m. sav., Lithuania',
      inviteLink: 'https://www.spotify.com/us/family/join/invite/Z7x75zBaC1caZ9y/',
      isManager: true, addressUpdateRequired: false,
      members: [
        { name: 'l1nx', username: 'afd694e36oss64ou7bcx8sumx', country: 'LT', isManager: true, isYou: true },
        { name: 'didikong59', username: 'didikong59', country: 'FR', isManager: false, isYou: false }
      ],
      usedSeats: 2, maxCapacity: 6
    })
  })
  it('member → address/link hidden (empty → null link), isManager false, addressUpdateRequired surfaces', async () => {
    const r = await spotify.family(ctxOf([res(200, hub(MEMBER))]))
    expect(r.address).toBe('')
    expect(r.inviteLink).toBeNull()
    expect(r.isManager).toBe(false)
    expect(r.addressUpdateRequired).toBe(true)
    expect(r.usedSeats).toBe(2)
  })
  it('locale redirect before the hub → followed', async () => {
    const r = await spotify.family(ctxOf([
      res(302, '', { location: '/vn-vi/family/home-hub/' }),
      res(200, hub(MGR))
    ]))
    expect(r.isManager).toBe(true)
  })
  it('dead sp_dc (login redirect) → 400 with recheck hint', async () => {
    await expect(spotify.family(ctxOf([
      res(302, '', { location: '/vn-vi/family/home-hub/' }),
      res(302, '', { location: 'https://accounts.spotify.com/en/login?continue=x' })
    ]))).rejects.toMatchObject({ status: 400, message: expect.stringContaining('session dead') })
  })
  it('non-family plan: homeHubData {} + error key → 400 not on a Family plan', async () => {
    await expect(spotify.family(ctxOf([res(200, hub({}, { error: 'HOME_NOT_FOUND' }))])))
      .rejects.toMatchObject({ status: 400, message: 'account is not on a Family plan' })
  })
  it('429/500 → throws transient (not a verdict)', async () => {
    await expect(spotify.family(ctxOf([res(429)]))).rejects.toThrow('HTTP 429')
    await expect(spotify.family(ctxOf([res(500)]))).rejects.toThrow('HTTP 500')
  })
})

// Session payload shapes verified against live responses 2026-08-25 (chrome-
// impersonated GET of chatgpt.com/api/auth/session): live = {user, account:
// {planType,...}, expires, ...}; dead session-token = 200 with ONLY a
// WARNING_BANNER key — no `user`.
describe('chatgpt adapter', () => {
  const PLUS_SESSION = JSON.stringify({
    WARNING_BANNER: '!!!', user: { id: 'user-AaZIY3fH1J3ts57mXqfXxWPm', name: 'ChatGPT Plus', email: 'ChatGPTplus49@sodobe.com', idp: 'auth0', mfa: false },
    expires: '2026-11-23T10:42:35.208Z',
    account: { id: '22266c99-040d-435d-bce4-ab4a4babfa06', planType: 'plus', structure: 'personal', isDelinquent: false },
    accessToken: 'x'.repeat(64)
  })
  const logs = []
  const ctx = extra => ({ cookieHeader: '__Secure-next-auth.session-token=tok', cookies: [], fetch: vi.fn(), proxy: 'socks5://127.0.0.1:1080', log: m => logs.push(m), ...extra })
  beforeEach(() => { impFetch.mockReset(); logs.length = 0 })

  it('live plus session → live with plan/email/expires from the session payload', async () => {
    impFetch.mockResolvedValue({ status: 200, body: PLUS_SESSION })
    const r = await chatgpt.check(ctx())
    expect(r).toMatchObject({ status: 'live', reason: 'logged in' })
    expect(r.accountInfo).toEqual({ plan: 'Plus', email: 'ChatGPTplus49@sodobe.com', expiresAt: '2026-11-23T10:42:35.208Z' })
    // impersonated transport gets the session URL, cookie header and the service proxy
    expect(impFetch).toHaveBeenCalledWith('https://chatgpt.com/api/auth/session',
      expect.objectContaining({ proxy: 'socks5://127.0.0.1:1080' }))
    expect(impFetch.mock.calls[0][1].headers.cookie).toBe('__Secure-next-auth.session-token=tok')
  })
  it('live session with null email (workspace-invited user) → live, no email key', async () => {
    const body = JSON.stringify({ WARNING_BANNER: 'x', user: { id: 'u', name: 'PRINCE', email: null }, account: { planType: 'free', isDelinquent: false }, expires: '2026-11-23T10:43:47.551Z' })
    impFetch.mockResolvedValue({ status: 200, body })
    const r = await chatgpt.check(ctx())
    expect(r.status).toBe('live')
    expect(r.accountInfo).toEqual({ plan: 'Free', expiresAt: '2026-11-23T10:43:47.551Z' })
  })
  it('delinquent account surfaces the flag in extra', async () => {
    const j = JSON.parse(PLUS_SESSION); j.account.isDelinquent = true
    impFetch.mockResolvedValue({ status: 200, body: JSON.stringify(j) })
    const r = await chatgpt.check(ctx())
    expect(r.accountInfo.extra).toEqual({ delinquent: true })
  })
  it('dead session-token → 200 WARNING_BANNER-only body → die', async () => {
    impFetch.mockResolvedValue({ status: 200, body: JSON.stringify({ WARNING_BANNER: '!!!' }) })
    const r = await chatgpt.check(ctx())
    expect(r).toEqual({ status: 'die', reason: 'no session' })
  })
  it('403 → throws transient with install hint, never die', async () => {
    impFetch.mockResolvedValue({ status: 403, body: '<html>challenge</html>' })
    await expect(chatgpt.check(ctx())).rejects.toThrow('Cloudflare challenge')
  })
  it('429/500/unexpected statuses → throws transient', async () => {
    for (const s of [401, 429, 500, 302]) {
      impFetch.mockResolvedValue({ status: s, body: '' })
      await expect(chatgpt.check(ctx())).rejects.toThrow(`HTTP ${s}`)
    }
  })
  it('200 non-JSON body (challenge HTML) → throws transient', async () => {
    impFetch.mockResolvedValue({ status: 200, body: '<html>just a minute</html>' })
    await expect(chatgpt.check(ctx())).rejects.toThrow('non-JSON')
  })
  it('impFetch unavailable → falls back to the engine fetch and parses its body', async () => {
    impFetch.mockRejectedValue(new Error('impersonation unavailable: python with curl_cffi not installed'))
    const fetch = vi.fn().mockResolvedValue({ status: 200, text: async () => PLUS_SESSION })
    const r = await chatgpt.check(ctx({ fetch }))
    expect(fetch).toHaveBeenCalledWith('https://chatgpt.com/api/auth/session', expect.objectContaining({ headers: expect.any(Object) }))
    expect(r.status).toBe('live')
    expect(logs.some(m => m.includes('falling back'))).toBe(true)
  })
  it('impFetch unavailable + fallback 403 → throws challenge hint', async () => {
    impFetch.mockRejectedValue(new Error('boom'))
    const fetch = vi.fn().mockResolvedValue({ status: 403, text: async () => '<html>' })
    await expect(chatgpt.check(ctx({ fetch }))).rejects.toThrow('Cloudflare challenge')
  })
})

// Bootstrap payload verified live 2026-08-25 (chrome-impersonated GET of
// claude.ai/api/bootstrap): live = {account:{email_address, display_name,
// memberships:[{organization:{rate_limit_tier}}]}}; dead sessionKey = 200 with
// account:null, or app 403 {"error":{"details":{"error_code":"account_session_invalid"}}}.
describe('claude adapter', () => {
  const boot = (account, tier = 'default_claude_ai') => JSON.stringify({
    account: account === null ? null : {
      email_address: 'chinmay.rwrk@gmail.com', display_name: 'chinmay', full_name: 'chinmay',
      memberships: [{ organization: { name: "chinmay.rwrk@gmail.com's Organization", rate_limit_tier: tier } }]
    },
    statsig: {}, feature_flags: {}
  })
  const ctx = extra => ({ cookieHeader: 'sessionKey=sk-ant-x', cookies: [], fetch: vi.fn(), proxy: null, log: () => {}, ...extra })
  beforeEach(() => { impFetch.mockReset() })

  it('live session → live with email + Free plan from rate_limit_tier + name in extra', async () => {
    impFetch.mockResolvedValue({ status: 200, body: boot(true) })
    const r = await claude.check(ctx())
    expect(r).toMatchObject({ status: 'live', reason: 'logged in' })
    expect(r.accountInfo).toEqual({ plan: 'Free', email: 'chinmay.rwrk@gmail.com', extra: { name: 'chinmay' } })
    expect(impFetch.mock.calls[0][0]).toBe('https://claude.ai/api/bootstrap')
    expect(impFetch.mock.calls[0][1].headers.cookie).toBe('sessionKey=sk-ant-x')
  })
  it('unknown rate_limit_tier passes through raw', async () => {
    impFetch.mockResolvedValue({ status: 200, body: boot(true, 'claude_ai_max_20x_2025') })
    const r = await claude.check(ctx())
    expect(r.accountInfo.plan).toBe('Max 20x')
    impFetch.mockResolvedValue({ status: 200, body: boot(true, 'some_new_tier_v9') })
    expect((await claude.check(ctx())).accountInfo.plan).toBe('some_new_tier_v9')
  })
  it('200 with account:null (verified dead shape) → die', async () => {
    impFetch.mockResolvedValue({ status: 200, body: boot(null) })
    const r = await claude.check(ctx())
    expect(r).toEqual({ status: 'die', reason: 'no session' })
  })
  it('app-level 403 account_session_invalid → die', async () => {
    impFetch.mockResolvedValue({ status: 403, body: JSON.stringify({ error: { type: 'permission_error', details: { error_code: 'account_session_invalid' } } }) })
    const r = await claude.check(ctx())
    expect(r).toEqual({ status: 'die', reason: 'account session invalid' })
  })
  it('403 without app error code (Cloudflare) → throws transient with hint', async () => {
    impFetch.mockResolvedValue({ status: 403, body: '<html>challenge</html>' })
    await expect(claude.check(ctx())).rejects.toThrow('Cloudflare challenge')
  })
  it('429/500 → throws transient', async () => {
    for (const s of [429, 500]) {
      impFetch.mockResolvedValue({ status: s, body: '' })
      await expect(claude.check(ctx())).rejects.toThrow(`HTTP ${s}`)
    }
  })
  it('200 non-JSON → throws transient', async () => {
    impFetch.mockResolvedValue({ status: 200, body: '<html>just a moment</html>' })
    await expect(claude.check(ctx())).rejects.toThrow('non-JSON')
  })
  it('impFetch unavailable → falls back to engine fetch', async () => {
    impFetch.mockRejectedValue(new Error('impersonation unavailable'))
    const fetch = vi.fn().mockResolvedValue({ status: 200, text: async () => boot(true) })
    const r = await claude.check(ctx({ fetch }))
    expect(r.status).toBe('live')
    expect(fetch).toHaveBeenCalledWith('https://claude.ai/api/bootstrap', expect.objectContaining({ headers: expect.any(Object) }))
  })
})


// v2_token behavior verified live 2026-08-25: live st → anonymous:false +
// minted JWT carrying the same user; dead st → anonymous:true with a NEW
// ephemeral user. The stored st is itself a JWT with offline exp/anonymous
// signals (expired st → die without any request).
describe('hbomax adapter', () => {
  const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const jwt = (claims = {}) => `x.${b64url(claims)}.y`
  const v2body = (anonymous, mintedClaims) => JSON.stringify({ data: { id: 't', type: 'token', attributes: { realm: 'bolt', anonymous, token: jwt(mintedClaims) } } })
  const LIVE_ST = jwt({ sub: 'USERID:bolt:orig-1', exp: 2082049205, anonymous: false, subdivision: 'beam_latam' })
  const ctx = st => ({ cookieHeader: 'a=1', cookies: st ? [{ name: 'st', value: st }] : [], fetch: vi.fn(), log: () => {} })

  it('missing st cookie → die without fetching', async () => {
    let called = false
    const r = await hbomax.check({ cookieHeader: '', cookies: [], fetch: async () => { called = true; return res(200, '{}') }, log: () => {} })
    expect(r).toEqual({ status: 'die', reason: 'st cookie missing' })
    expect(called).toBe(false)
  })
  it('expired st JWT → die offline, no request', async () => {
    let called = false
    const r = await hbomax.check(ctx(jwt({ exp: 1000, anonymous: false })))
    expect(r).toEqual({ status: 'die', reason: 'token expired' })
    expect(called).toBe(false)
  })
  it('anonymous st JWT → die offline', async () => {
    const r = await hbomax.check(ctx(jwt({ exp: 2082049205, anonymous: true })))
    expect(r).toEqual({ status: 'die', reason: 'anonymous token' })
  })
  it('v2_token anonymous:false → live with region from the minted token', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => JSON.parse(v2body(false, { sub: 'USERID:bolt:orig-1', anonymous: false, subdivision: 'beam_latam' })) })
    const r = await hbomax.check({ ...ctx(LIVE_ST), fetch })
    expect(r).toEqual({ status: 'live', reason: 'logged in', accountInfo: { country: 'LATAM', extra: { userId: 'USERID:bolt:orig-1' } } })
    expect(fetch.mock.calls[0][0]).toBe('https://default.any-any.prd.api.hbomax.com/v2_token?realm=bolt')
    expect(fetch.mock.calls[0][1].headers.cookie).toBe(`st=${LIVE_ST}`)
    expect(fetch.mock.calls[0][1].headers['x-disco-client']).toBe('WEB:10:dotcom-hbomax:7.10.0')
  })
  it('v2_token anonymous:true (dead st, verified shape) → die', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => JSON.parse(v2body(true, { sub: 'USERID:bolt:new-ephemeral', anonymous: true })) })
    const r = await hbomax.check({ ...ctx(LIVE_ST), fetch })
    expect(r).toEqual({ status: 'die', reason: 'session invalid (token rotated out)' })
  })
  it('unknown subdivision passes through raw', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => JSON.parse(v2body(false, { sub: 'u', anonymous: false, subdivision: 'beam_mars' })) })
    const r = await hbomax.check({ ...ctx(LIVE_ST), fetch })
    expect(r.accountInfo.country).toBe('beam_mars')
  })
  it('v2_token 429/500 → throws transient', async () => {
    for (const s of [429, 503]) {
      const fetch = vi.fn().mockResolvedValue({ status: s, json: async () => ({}) })
      await expect(hbomax.check({ ...ctx(LIVE_ST), fetch })).rejects.toThrow(`v2_token HTTP ${s}`)
    }
  })
  it('v2_token unexpected status → die; malformed JSON → throws', async () => {
    const fetch403 = vi.fn().mockResolvedValue({ status: 403, json: async () => ({}) })
    expect(await hbomax.check({ ...ctx(LIVE_ST), fetch: fetch403 })).toEqual({ status: 'die', reason: 'v2_token HTTP 403' })
    const fetchBad = vi.fn().mockResolvedValue({ status: 200, json: async () => { throw new Error('bad json') } })
    await expect(hbomax.check({ ...ctx(LIVE_ST), fetch: fetchBad })).rejects.toThrow('unexpected v2_token response')
  })
})
describe('registry', () => {
  it('loads all five adapters with unique keys', async () => {
    const map = await loadAdapters(path.resolve('src/adapters'))
    expect([...map.keys()].sort()).toEqual(['chatgpt', 'claude', 'hbomax', 'netflix', 'spotify'])
    expect(map.get('hbomax').defaultDomain).toBe('.hbomax.com')
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
