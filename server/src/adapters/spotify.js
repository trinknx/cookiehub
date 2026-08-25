const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const HEADERS = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }

// Verified against live pages 2026-08-25 (direct VN IP and US proxy):
// - logged in: /account/overview/ 302s to the locale page (/vn-vi/, /us/…) which
//   answers 200; the page embeds __NEXT_DATA__ with props.username,
//   props.isAnonymous=false and a PlanCard carrying planName ("Spotify Free",
//   "Basic Family", "Premium Individual", "Premium Family"…). The account email
//   is NOT rendered on this page — the old email regex never matched anything.
// - dead sp_dc: the redirect chain ends at accounts.spotify.com/en/login (200
//   login page, never a 401) — a Location (or final URL) containing 'login' is
//   the death signal; a parsed page without any planName means the same.

// Shared www.spotify.com walker: follows locale redirects (max 4 hops), treats
// any 'login' Location/landing as a dead session, and parses __NEXT_DATA__.
// Returns { dead } for dead sessions and { j } (parsed payload) on success;
// throws on transient conditions. Message text is load-bearing — check()
// reasons and the adapter tests pin it.
async function loadPage(fetch, startUrl) {
  let url = startUrl
  let res = await fetch(url, { redirect: 'manual', headers: HEADERS })
  // a 'login' Location at any hop proves the session is dead — die without fetching it
  for (let hop = 0; hop < 4 && res.status >= 300 && res.status < 400; hop++) {
    const loc = res.headers.get('location')
    if (!loc) break
    if (loc.toLowerCase().includes('login')) return { dead: `redirected to ${loc}` }
    url = new URL(loc, url).href
    res = await fetch(url, { redirect: 'manual', headers: HEADERS })
  }
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location')
    if (loc && loc.toLowerCase().includes('login')) return { dead: `redirected to ${loc}` }
    throw new Error(`transient redirect to ${loc || 'loop'}`)
  }
  if (res.status === 200 && url.toLowerCase().includes('login')) return { dead: `landed on ${url}` }
  if (res.status === 401 || res.status === 403) return { dead: `HTTP ${res.status}` }
  if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`) // transient (outage) — engine records 'error' without flipping status
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!nd) throw new Error('no __NEXT_DATA__ on page (unexpected page?)') // Spotify overview is always a Next.js app — anything else is transient
  try { return { j: JSON.parse(nd[1]) } } catch { throw new Error('malformed __NEXT_DATA__') }
}

export default {
  key: 'spotify',
  name: 'Spotify',
  defaultDomain: '.spotify.com',
  async check({ fetch }) {
    const { dead, j } = await loadPage(fetch, 'https://www.spotify.com/account/overview/')
    if (dead) return { status: 'die', reason: dead }
    const planNames = []
    const dig = o => {
      if (!o || typeof o !== 'object') return
      if (Array.isArray(o)) { o.forEach(dig); return }
      if (typeof o.planName === 'string') planNames.push(o.planName)
      Object.values(o).forEach(dig)
    }
    dig(j?.props?.pageProps)
    if (!planNames.length) return { status: 'die', reason: 'no session' } // login/anonymous page parses to no plan
    const info = { plan: planNames[0] }
    if (typeof j.props?.username === 'string' && j.props.username) info.extra = { username: j.props.username }
    return { status: 'live', reason: 'logged in', accountInfo: info }
  },

  // Family-plan info — strictly read-only (verified live 2026-08-25 with stored
  // cookies, direct VN IP). /us/family/home-hub/ is the app iframed by
  // /account/family/ and serves its whole state via SSR __NEXT_DATA__ →
  // props.pageProps.homeHubData { address, inviteToken, homeId, members[],
  // maxCapacity, permissions }. No POST exists in this flow.
  // - plan manager: address is the exact string the manage UI renders and
  //   inviteToken is the persistent token behind the join link the UI shows —
  //   https://www.spotify.com/us/family/join/invite/<token>/
  // - plain member: address "" and inviteToken "" — Spotify hides both from
  //   non-managers (verified: member cookies get the members list only).
  // - non-family plan: homeHubData {} with a pageProps.error key.
  async family({ fetch }) {
    const { dead, j } = await loadPage(fetch, 'https://www.spotify.com/us/family/home-hub/')
    if (dead) { const e = new Error(`session dead (${dead}) — recheck this cookie`); e.status = 400; throw e }
    const hd = j?.props?.pageProps?.homeHubData
    if (!hd || typeof hd !== 'object' || !Array.isArray(hd.members) || !hd.homeId) {
      const e = new Error('account is not on a Family plan'); e.status = 400; throw e
    }
    return {
      address: typeof hd.address === 'string' ? hd.address : '',
      inviteLink: hd.inviteToken ? `https://www.spotify.com/us/family/join/invite/${hd.inviteToken}/` : null,
      isManager: !!hd.members.find(m => m.isLoggedInUser)?.isMaster,
      addressUpdateRequired: !!hd.permissions?.addressUpdateRequired,
      members: hd.members.map(m => ({
        name: m.name ?? m.username, username: m.username, country: m.country ?? null,
        isManager: !!m.isMaster, isYou: !!m.isLoggedInUser
      })),
      usedSeats: hd.members.length,
      maxCapacity: hd.maxCapacity ?? null
    }
  }
}
