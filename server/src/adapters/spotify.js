const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export default {
  key: 'spotify',
  name: 'Spotify',
  defaultDomain: '.spotify.com',
  async check({ fetch }) {
    const res = await fetch('https://www.spotify.com/account/overview/', {
      redirect: 'manual', headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }
    })
    if (res.status === 401 || res.status === 403) return { status: 'die', reason: `HTTP ${res.status}` }
    if (res.status >= 300 && res.status < 400) return { status: 'die', reason: `redirected to ${res.headers.get('location') || 'unknown'}` }
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`) // transient (outage) — engine records 'error' without flipping status
    if (res.status !== 200) return { status: 'die', reason: `HTTP ${res.status}` }
    const html = await res.text().catch(() => '')
    const info = {}
    const email = html.match(/"email"\s*:\s*"([^"]+)"/)
    if (email) info.email = email[1]
    const plan = html.match(/"(?:plan|planName)"\s*:\s*"([^"]+)"/)
    if (plan) info.plan = plan[1]
    const renew = html.match(/"(?:renewalDate|renew_date|expiry)"\s*:\s*"([^"]+)"/)
    if (renew) info.expiresAt = renew[1]
    return { status: 'live', reason: 'logged in', accountInfo: Object.keys(info).length ? info : undefined }
  }
}
