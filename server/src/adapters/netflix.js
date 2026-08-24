const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export default {
  key: 'netflix',
  name: 'Netflix',
  defaultDomain: '.netflix.com',
  async check({ fetch, log }) {
    const res = await fetch('https://www.netflix.com/browse', {
      redirect: 'manual',
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || 'unknown'
      return { status: 'die', reason: `redirected to ${loc}` }
    }
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`) // transient (outage) — engine records 'error' without flipping status
    if (res.status !== 200) return { status: 'die', reason: `HTTP ${res.status}` }
    const info = {}
    const home = await res.text().catch(() => '')
    const country = home.match(/"currentCountry":"([A-Z]{2})"/)
    if (country) info.country = country[1]
    try {
      const acc = await fetch('https://www.netflix.com/account', { headers: { 'user-agent': UA } })
      const html = await acc.text()
      const plan = html.match(/data-uia="plan-name"[^>]*>\s*(?:<[^>]*>)*([^<]+)/) || html.match(/"planName":"([^"]+)"/)
      if (plan) info.plan = plan[1].trim()
      const next = html.match(/data-uia="next-bill-date"[^>]*>([^<]+)/)
      if (next) info.expiresAt = next[1].trim()
      const email = html.match(/"email":"([^"]+)"/)
      if (email) info.email = email[1]
    } catch (e) { log(`account info fetch failed: ${e.message}`) }
    return { status: 'live', reason: 'logged in', accountInfo: Object.keys(info).length ? info : undefined }
  }
}
