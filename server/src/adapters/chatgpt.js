import { impFetch } from '../impersonate.js'

const SESSION_URL = 'https://chatgpt.com/api/auth/session'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const HEADERS = { 'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9', referer: 'https://chatgpt.com/' }

// Verified against live responses 2026-08-25 (chrome-impersonated TLS):
// live session = { user:{id,name,email|null,idp,iat,amr,mfa}, account:{id,planType,
// structure:'personal'|'workspace', isDelinquent,...}, expires, accessToken, ... } —
// planType is already in the session payload, no backend-api call needed (that
// endpoint is challenge-protected anyway).
// dead session-token = HTTP 200 with ONLY a WARNING_BANNER key — no `user`.
const cap = s => (typeof s === 'string' && s ? s[0].toUpperCase() + s.slice(1) : null)

export default {
  key: 'chatgpt',
  name: 'ChatGPT',
  defaultDomain: '.chatgpt.com',
  async check({ cookieHeader, fetch, proxy, log }) {
    // chatgpt.com sits behind a Cloudflare browser challenge that 403s Node TLS
    // fingerprints (verified: undici and node:http2 both challenged, curl_cffi
    // chrome passes). Prefer the impersonated transport; the engine fetch is the
    // fallback for environments where it is unavailable or the IP is trusted.
    let status, body
    try {
      ({ status, body } = await impFetch(SESSION_URL, { headers: { ...HEADERS, cookie: cookieHeader }, proxy }))
    } catch (e) {
      log(`impersonated fetch failed (${e.message}); falling back to engine fetch`)
      const res = await fetch(SESSION_URL, { headers: HEADERS })
      status = res.status
      body = await res.text()
    }
    // Dead cookies still answer 200 — only statuses that cannot say anything
    // about the cookie are left; every one of them is environmental (challenge,
    // rate limit, outage) so they stay transient to never mass-flip statuses.
    if (status === 403) throw new Error('HTTP 403 (Cloudflare challenge) — install python + curl_cffi (pip install curl_cffi) or set a proxy for this service')
    if (status !== 200) throw new Error(`HTTP ${status}`)
    let j = null
    try { j = JSON.parse(body) } catch { /* fall through */ }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('non-JSON response (challenge page?)')
    if (!j.user) return { status: 'die', reason: 'no session' }
    const info = {}
    const plan = cap(j.account?.planType)
    if (plan) info.plan = plan
    if (j.user.email) info.email = j.user.email
    if (j.expires) info.expiresAt = j.expires
    if (j.account?.isDelinquent === true) info.extra = { delinquent: true }
    return { status: 'live', reason: 'logged in', accountInfo: Object.keys(info).length ? info : undefined }
  }
}
