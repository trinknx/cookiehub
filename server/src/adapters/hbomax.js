const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// Verified live 2026-08-25: api.hbomax.com itself is decommissioned (no DNS),
// but the beam platform serves default.any-any.prd.api.hbomax.com (plain TLS —
// no Cloudflare). GET /v2_token?realm=bolt with the stored `st` cookie:
//   live session   → 200 {data:{attributes:{anonymous:false, token:<JWT with
//                    the SAME user sub + subdivision>}}} (server mints a fresh
//                    access token only for valid sessions)
//   dead/revoked st → 200 {…{anonymous:true, token:<NEW ephemeral user>}}
// (verified both sides against real Premium cookies + dead controls).
// The st cookie is a JWT itself: exp/anonymous claims give offline signals.
const V2_TOKEN_URL = 'https://default.any-any.prd.api.hbomax.com/v2_token?realm=bolt'
const APP_HEADERS = {
  'user-agent': UA,
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/json',
  origin: 'https://www.hbomax.com',
  referer: 'https://www.hbomax.com/',
  // captured verbatim from the dotcom-hbomax 7.10.0 web client
  'x-disco-client': 'WEB:10:dotcom-hbomax:7.10.0',
  'x-disco-params': 'realm=bolt,bid=beam,features=ar',
  'x-device-info': 'dotcom-hbomax/7.10.0 (desktop/desktop; Windows/10; 7a56647c-d091-4c3b-9460-df06dd2c375c/da0cdd94-5a39-42ef-aa68-54cbc1b852c3)',
  'x-wbd-time-zone': 'Asia/Bangkok',
  'x-wbd-preferred-language': 'en-US,en',
  'x-wbd-device-consent': 'gpc=0'
}
const REGION_LABEL = { beam_latam: 'LATAM', beam_emea: 'EMEA', beam_apac: 'APAC', beam_us: 'US', beam_amer: 'US' }

// payload-only decode (no signature check — the server validates via v2_token)
const jwtPayload = token => {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) } catch { return null }
}
const err400 = message => { const e = new Error(message); e.status = 400; return e }

// Exchange the stored st cookie for a fresh access token via v2_token.
// Returns the minted token string; throws err400 when the session is dead.
async function mintSession(fetch, st) {
  const res = await fetch(V2_TOKEN_URL, { headers: { ...APP_HEADERS, cookie: `st=${st}` } })
  if (res.status === 429 || res.status >= 500) throw new Error(`v2_token HTTP ${res.status}`)
  if (res.status !== 200) throw err400(`v2_token HTTP ${res.status}`)
  let j = null
  try { j = await res.json() } catch { /* fall through */ }
  const attrs = j?.data?.attributes
  if (!attrs || typeof attrs.anonymous !== 'boolean') throw new Error('unexpected v2_token response')
  if (attrs.anonymous !== false) throw err400('session invalid (token rotated out)')
  return attrs.token
}

export default {
  key: 'hbomax',
  name: 'HBO Max',
  defaultDomain: '.hbomax.com',
  async check({ cookies, fetch }) {
    const st = cookies.find(c => c.name === 'st')?.value
    if (!st) return { status: 'die', reason: 'st cookie missing' }
    const claims = jwtPayload(st)
    if (claims?.exp && claims.exp * 1000 < Date.now()) return { status: 'die', reason: 'token expired' }
    if (claims?.anonymous === true) return { status: 'die', reason: 'anonymous token' }
    let mintedStr
    try {
      mintedStr = await mintSession(fetch, st)
    } catch (e) {
      if (e.status === 400) return { status: 'die', reason: e.message } // dead session is a check verdict, not an error
      throw e
    }
    const minted = jwtPayload(mintedStr) || {}
    const info = {}
    const region = REGION_LABEL[minted.subdivision] || minted.subdivision
    if (region) info.country = region
    if (minted.sub) info.extra = { userId: minted.sub }
    return { status: 'live', reason: 'logged in', accountInfo: Object.keys(info).length ? info : undefined }
  },
  // Link a TV by entering the code it displays. Verified live 2026-08-25:
  // POST {homeMarket host}/authentication/linkDevice/connect with body
  // {"linkingCode": CODE} + the minted v2 token as Bearer. Wrong field name
  // or bad code answer 400 {"errors":[{"code":"invalid.code"|"invalid.payload"}]}
  // ("Linking code required" / "linkingCode required to validate.").
  async linkTv({ cookies, fetch, log }, code) {
    const clean = String(code || '').trim().toUpperCase().replace(/\s+/g, '')
    if (!/^[A-Z0-9]{4,8}$/.test(clean)) throw err400('invalid code format (4-8 letters/digits)')
    const st = cookies.find(c => c.name === 'st')?.value
    if (!st) throw err400('st cookie missing')
    const minted = await mintSession(fetch, st)
    const auth = { ...APP_HEADERS, authorization: 'Bearer ' + minted, cookie: `st=${minted}` }
    // home market decides the connect host (bolt-any-homemarket apiGroup)
    let home = 'latam'
    try {
      const b = await fetch('https://default.any-any.prd.api.hbomax.com/session-context/headwaiter/v1/bootstrap', { method: 'POST', headers: auth, body: '{}' })
      if (b.status === 200) home = (await b.json())?.routing?.homeMarket || home
      else log(`bootstrap HTTP ${b.status} — using default home market`)
    } catch (e) { log(`bootstrap failed (${e.message}) — using default home market`) }
    const res = await fetch(`https://default.any-${home}.prd.api.hbomax.com/authentication/linkDevice/connect`, {
      method: 'POST', headers: auth, body: JSON.stringify({ linkingCode: clean })
    })
    let j = null
    try { j = await res.json() } catch { /* fall through */ }
    if (res.status >= 200 && res.status < 300) return { ok: true, message: 'TV linked — check your TV' } // 204 No Content = linked, no body (verified with a real TV code)
    const code_ = j?.errors?.[0]?.code
    const detail = j?.errors?.[0]?.detail
    if (code_ === 'invalid.code') throw err400('invalid or expired TV code')
    if (code_ === 'forbidden') throw err400(detail || 'account not allowed to link devices')
    throw err400(detail || `linkDevice HTTP ${res.status}${code_ ? ` (${code_})` : ''}`)
  }
}
