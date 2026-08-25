import { impFetch } from '../impersonate.js'

// Verified against live sessions 2026-08-25 (chrome-impersonated GET of
// claude.ai/api/bootstrap): logged in = 200 {account:{email_address,
// display_name, memberships:[{organization:{rate_limit_tier,…}}],…},…};
// dead sessionKey = 200 {account:null} (and app-level 403 {"error":{…
// "error_code":"account_session_invalid"}} on /api/organizations).
// rate_limit_tier 'default_claude_ai' = Free; paid-tier strings below are
// best-effort labels — unknown values pass through raw.
const BOOTSTRAP_URL = 'https://claude.ai/api/bootstrap'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const TIER_LABEL = {
  default_claude_ai: 'Free',
  claude_ai_pro_2024: 'Pro',
  claude_pro: 'Pro',
  claude_ai_max_5x_2025: 'Max 5x',
  claude_ai_max_20x_2025: 'Max 20x',
  team_claude_ai: 'Team'
}

export default {
  key: 'claude',
  name: 'Claude',
  defaultDomain: '.claude.ai',
  async check({ cookieHeader, fetch, log }) {
    // claude.ai is Cloudflare-fronted like chatgpt.com — plain Node TLS gets
    // challenged; prefer the impersonated transport, fall back to engine fetch.
    const headers = { 'user-agent': UA, accept: 'application/json', 'accept-language': 'en-US,en;q=0.9', referer: 'https://claude.ai/chat' }
    let status, body
    try {
      ({ status, body } = await impFetch(BOOTSTRAP_URL, { headers: { ...headers, cookie: cookieHeader } }))
    } catch (e) {
      log(`impersonated fetch failed (${e.message}); falling back to engine fetch`)
      const res = await fetch(BOOTSTRAP_URL, { headers })
      status = res.status
      body = await res.text()
    }
    let j = null
    try { j = JSON.parse(body) } catch { /* fall through */ }
    // app-level auth rejection (verified shape: {"error":{"details":{"error_code":"account_session_invalid"}}})
    if (status === 403 && j?.error?.details?.error_code === 'account_session_invalid') return { status: 'die', reason: 'account session invalid' }
    if (status === 403) throw new Error('HTTP 403 (Cloudflare challenge) — install python + curl_cffi (pip install curl_cffi) or set a proxy for this service')
    if (status === 429 || status >= 500) throw new Error(`HTTP ${status}`)
    if (status !== 200) throw new Error(`HTTP ${status}`)
    if (!j || typeof j !== 'object') throw new Error('non-JSON response (challenge page?)')
    const acc = j.account
    if (!acc || typeof acc !== 'object') return { status: 'die', reason: 'no session' }
    const info = {}
    if (acc.email_address) info.email = acc.email_address
    const org = acc.memberships?.[0]?.organization
    const tier = org?.rate_limit_tier
    if (typeof tier === 'string' && tier) info.plan = TIER_LABEL[tier] || tier
    if (acc.display_name || acc.full_name) info.extra = { name: acc.display_name || acc.full_name }
    return { status: 'live', reason: 'logged in', accountInfo: Object.keys(info).length ? info : undefined }
  }
}
