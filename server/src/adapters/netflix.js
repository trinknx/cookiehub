import { parseBillingIso } from '../billingDate.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// reactContext string values embed JS hex escapes — \xNN (verified on a live
// US page: "mikekugler1\x40gmail.com") AND \uNNNN for chars above U+00FF
// (verified on a live VN page: "Cao c\u1EA5p") — unescape before storing.
const unhex = s => s.replace(/\\x([0-9A-Fa-f]{2})|\\u([0-9A-Fa-f]{4})/g, (_, x, u) => String.fromCharCode(parseInt(x || u, 16)))
// Canonical plan tier from machine-readable fields — immune to UI language.
export const planTier = extra => {
  if (!extra) return null
  if (extra.hasAds) return 'Standard with ads'
  const q = String(extra.videoQuality || '').toLowerCase()
  if (q.includes('uhd') || q.includes('4k')) return 'Premium'
  if (q.includes('1080') || q.includes('full hd')) return 'Standard'
  if (q.includes('720') || q.includes('sd')) return 'Basic'
  if (q.includes('hd')) return extra.maxStreams === 1 ? 'Basic' : 'Standard'
  return null
}

// Profile names arrive HTML-entity-escaped Netflix-style: Latin-1 chars as
// named entities (&ccedil;), anything above U+00FF as numeric (&#x1F970;,
// &#x1EBB;) — verified on live pages ("Crian&ccedil;a", "Tr&#x1EBB; em",
// "Saris&#x1F970;"). The HTML 4 Latin-1 named table below covers the named
// half; unknown names stay verbatim.
const NAMED_ENTITIES = ('nbsp 00A0 iexcl 00A1 cent 00A2 pound 00A3 curren 00A4 yen 00A5 brvbar 00A6 sect 00A7 uml 00A8 copy 00A9 ordf 00AA laquo 00AB not 00AC shy 00AD reg 00AE macr 00AF deg 00B0 plusmn 00B1 sup2 00B2 sup3 00B3 acute 00B4 micro 00B5 para 00B6 middot 00B7 cedil 00B8 sup1 00B9 ordm 00BA raquo 00BB frac14 00BC frac12 00BD frac34 00BE iquest 00BF Agrave 00C0 Aacute 00C1 Acirc 00C2 Atilde 00C3 Auml 00C4 Aring 00C5 AElig 00C6 Ccedil 00C7 Egrave 00C8 Eacute 00C9 Ecirc 00CA Euml 00CB Igrave 00CC Iacute 00CD Icirc 00CE Iuml 00CF ETH 00D0 Ntilde 00D1 Ograve 00D2 Oacute 00D3 Ocirc 00D4 Otilde 00D5 Ouml 00D6 times 00D7 Oslash 00D8 Ugrave 00D9 Uacute 00DA Ucirc 00DB Uuml 00DC Yacute 00DD THORN 00DE szlig 00DF agrave 00E0 aacute 00E1 acirc 00E2 atilde 00E3 auml 00E4 aring 00E5 aelig 00E6 ccedil 00E7 egrave 00E8 eacute 00E9 ecirc 00EA euml 00EB igrave 00EC iacute 00ED icirc 00EE iuml 00EF eth 00F0 ntilde 00F1 ograve 00F2 oacute 00F3 ocirc 00F4 otilde 00F5 ouml 00F6 divide 00F7 oslash 00F8 ugrave 00F9 uacute 00FA ucirc 00FB uuml 00FC yacute 00FD thorn 00FE yuml 00FF quot 0022 amp 0026 apos 0027 lt 003C gt 003E'
  .split(' ').reduce((a, p, i, arr) => { if (i % 2 === 0) a[p] = String.fromCharCode(parseInt(arr[i + 1], 16)); return a }, {}))
const decodeEntities = s => s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
  if (body[0] === '#') {
    const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
  }
  return NAMED_ENTITIES[body] || m
})

// Profile list from a logged-in page. /browse (and /profiles/manage, the
// fallback) ship `netflix.falcorCache = {…};` — a falcor model whose
// profilesList holds refs into a profiles map; each summary carries
// profileName, isKids, maturityLevel… (verified on 30 live cookies, 2026-08-29:
// 29/30 parsed from /browse alone; trailing numeric slots are placeholder
// atoms, so the walk stops at the first non-ref).
export function parseNetflixProfiles(html) {
  const marker = html.indexOf('netflix.falcorCache')
  const start = marker === -1 ? -1 : html.indexOf('{', marker)
  if (start === -1) return null
  // brace-walk the JS-assigned JSON literal (string/escape aware) — it is NOT
  // wrapped in quotes, so a plain indexOf/regex cut cannot find its end
  let depth = 0, inStr = false, esc = false, end = -1
  for (let k = start; k < html.length; k++) {
    const c = html[k]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) { end = k + 1; break }
  }
  if (end === -1) return null
  let fc
  try { fc = JSON.parse(unhex(html.slice(start, end))) } catch { return null }
  const list = []
  for (let n = 0; ; n++) {
    const e = fc.profilesList?.[String(n)]
    if (!e || e.$type !== 'ref') break
    const s = fc.profiles?.[e.value?.[1]]?.summary?.value
    if (s && s.profileName !== undefined) list.push({ name: decodeEntities(String(s.profileName)), isKids: !!s.isKids })
  }
  if (!list.length) return null
  return { count: list.length, kidsCount: list.filter(p => p.isKids).length, list }
}

// Netflix iOS app (Argo) shakti call that mints a short-lived (~1h) nftoken;
// https://netflix.com/?nftoken=… logs the session straight in. Values captured
// verbatim from a live Argo 15.48.1 request — the server is picky about them.
// NOTE: esn holds the DECODED form ('…IPHONE8=1-…'); URLSearchParams re-encodes
// the '=' as %3D, matching the wire format of the app.
const NFTOKEN_QUERY = {
  appVersion: '15.48.1',
  config: '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
  device_type: 'NFAPPL-02-',
  esn: 'NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200',
  idiom: 'phone',
  iosVersion: '15.8.5',
  isTablet: 'false',
  languages: 'en-US',
  locale: 'en-US',
  maxDeviceWidth: '375',
  model: 'saget',
  modelType: 'IPHONE8-1',
  odpAware: 'true',
  path: '["account","token","default"]',
  pathFormat: 'graph',
  pixelDensity: '2.0',
  progressive: 'false',
  responseFormat: 'json'
}

const NFTOKEN_HEADERS = {
  'user-agent': 'Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)',
  'x-netflix.request.attempt': '1',
  'x-netflix.request.client.user.guid': 'A4CS633D7VCBPE2GPK2HL4EKOE',
  'x-netflix.context.profile-guid': 'A4CS633D7VCBPE2GPK2HL4EKOE',
  'x-netflix.request.routing': '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
  'x-netflix.context.app-version': '15.48.1',
  'x-netflix.argo.translated': 'true',
  'x-netflix.context.form-factor': 'phone',
  'x-netflix.context.sdk-version': '2012.4',
  'x-netflix.client.appversion': '15.48.1',
  'x-netflix.context.max-device-width': '375',
  'x-netflix.context.ab-tests': '',
  'x-netflix.tracing.cl.useractionid': '4DC655F2-9C3C-4343-8229-CA1B003C3053',
  'x-netflix.client.type': 'argo',
  'x-netflix.client.ftl.esn': 'NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200',
  'x-netflix.context.locales': 'en-US',
  'x-netflix.context.top-level-uuid': '90AFE39F-ADF1-4D8A-B33E-528730990FE3',
  'x-netflix.client.iosversion': '15.8.5',
  'accept-language': 'en-US;q=1',
  'x-netflix.argo.abtests': '',
  'x-netflix.context.os-version': '15.8.5',
  'x-netflix.request.client.context': '{"appState":"foreground"}',
  'x-netflix.context.ui-flavor': 'argo',
  'x-netflix.argo.nfnsm': '9',
  'x-netflix.context.pixel-density': '2.0',
  'x-netflix.request.toplevel.uuid': '90AFE39F-ADF1-4D8A-B33E-528730990FE3',
  'x-netflix.request.client.timezoneid': 'Asia/Dhaka'
}

export default {
  key: 'netflix',
  name: 'Netflix',
  defaultDomain: '.netflix.com',
  async check({ fetch, log }) {
    const HEADERS = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }
    // Root '/' or a locale root like /vn-en/, /vi/, /en-us/ — written as two
    // alternatives so '//' (empty locale + trailing slash) cannot match.
    const homepage = p => p === '/' || /^\/[a-z]{2}(-[a-z]{2})?\/?$/.test(p)
    let currentUrl = 'https://www.netflix.com/browse'
    let res = await fetch(currentUrl, { redirect: 'manual', headers: HEADERS })
    if (res.status >= 300 && res.status < 400) {
      // A logged-in /browse returns 200 directly (controller-verified live
      // probe, 2026-08-25). Follow the chain manually: a 'login' location at
      // any hop proves the session is dead, and a chain that settles on the
      // root or a locale homepage (/, /vn-en/, /vi/) means the session is NOT
      // authenticated — both are die. Anything else (maintenance page, loop,
      // hop exhaustion) stays transient so valid cookies aren't mass-flipped.
      // Each hop's Location is resolved against the URL that ISSUED it.
      let lastLoc = null
      for (let hop = 0; hop < 4 && res.status >= 300 && res.status < 400; hop++) {
        const loc = res.headers.get('location')
        if (!loc) break
        if (loc.toLowerCase().includes('login')) return { status: 'die', reason: `redirected to ${loc}` }
        lastLoc = new URL(loc, currentUrl).href
        currentUrl = lastLoc
        res = await fetch(lastLoc, { redirect: 'manual', headers: HEADERS })
      }
      // Hop budget spent (or a Location-less 3xx): a terminal 3xx pointing at
      // login still proves a dead session — die without a 5th fetch.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (loc && loc.toLowerCase().includes('login')) return { status: 'die', reason: `redirected to ${loc}` }
      }
      if (res.status === 200 && lastLoc && homepage(new URL(lastLoc).pathname)) {
        return { status: 'die', reason: `redirected to ${lastLoc} (not authenticated)` }
      }
      throw new Error(`transient redirect to ${lastLoc || 'loop'}`) // engine records 'error', status unchanged
    }
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`) // transient (outage) — engine records 'error' without flipping status
    if (res.status !== 200) return { status: 'die', reason: `HTTP ${res.status}` }
    // The browse page itself carries the profile list (falcorCache embeds
    // profilesList + profiles). Capture the body before /account — 29/30 live
    // sessions parse from here with zero extra requests.
    let browseHtml = ''
    try { browseHtml = await res.text() } catch (e) { log(`browse body read failed: ${e.message}`) }
    const info = {}
    try {
      const acc = await fetch('https://www.netflix.com/account', { headers: { 'user-agent': UA } })
      const html = await acc.text()
      // /account embeds TWO data sources (verified char-by-char against a live
      // US page, 2026-08-25):
      // 1) a form-render model as PLAIN-quote JSON — raw bytes look like
      //    "localizedPlanName":{"fieldType":"String","value":"Standard"} — no
      //    backslash escaping (earlier regexes assumed \" bytes and never matched).
      // 2) reactContext JSON whose string values may contain \xNN hex escapes,
      //    unescaped via unhex() (emailAddress, currentCountry, memberSince).
      // The old data-uia="plan-name" / "planName" / next-bill-date / "email" regexes
      // never matched the real page and are gone.
      // Plan: canonical English tier derived from machine-readable fields
      // (quality/streams/ads) — localizedPlanName renders as "Cao cấp",
      // "Estándar", "المميزة"… which breaks pill colors and plan sorting.
      // The localized name survives in planLocalized for the tooltip.
      const streams = html.match(/maxStreams":{"fieldType":"Numeric","value":(\d+)/)
      const quality = html.match(/videoQuality":{"fieldType":"String","value":"([^"]+)"/)
      const ads = html.match(/hasAds":\{"fieldType":"Boolean",value:(true|false)/)
      const plan = html.match(/localizedPlanName":{"fieldType":"String","value":"([^"]+)"/)
      if (streams || quality || ads) {
        info.extra = {}
        if (streams) info.extra.maxStreams = Number(streams[1])
        if (quality) info.extra.videoQuality = unhex(quality[1])
        if (ads) info.extra.hasAds = ads[1] === 'true'
      }
      const tier = planTier(info.extra)
      if (plan) {
        const localized = unhex(plan[1])
        info.plan = tier || localized
        if (tier && localized.toLowerCase() !== tier.toLowerCase()) info.planLocalized = localized
      } else if (tier) info.plan = tier
      const country = html.match(/"currentCountry":"([A-Z]{2})"/)
      const email = html.match(/"emailAddress":"([^"]+)"/)
      if (country) info.country = country[1]
      if (email) info.email = unhex(email[1])
      const since = html.match(/"memberSince":"([^"]+)"/)
      if (since) info.memberSince = unhex(since[1])
      // Same form-model blob carries the renewal date ("Next payment: …" on
      // the page). ISO twin nextBillingIso is for SQL sorting — display text
      // sorts wrong and is often localized, so parseBillingIso handles the
      // languages Netflix serves (incl. Arabic-Indic digits, VI numeric).
      const billing = html.match(/nextBillingDate":\{"fieldType":"String","value":"([^"]+)"/)
      if (billing) {
        info.nextBilling = unhex(billing[1])
        info.nextBillingIso = parseBillingIso(info.nextBilling) || undefined
      }
    } catch (e) { log(`account info fetch failed: ${e.message}`) }
    // Profiles: prefer the browse body already in hand; the rare session that
    // lands without a falcorCache (profile-gate edge) gets one best-effort
    // fetch of /profiles/manage, which embeds the identical model. Runs after
    // the /account block so its failures can't starve plan/email parsing.
    let profiles = parseNetflixProfiles(browseHtml)
    if (!profiles) {
      try {
        const pm = await fetch('https://www.netflix.com/profiles/manage', { headers: HEADERS })
        if (pm.status === 200) profiles = parseNetflixProfiles(await pm.text())
      } catch (e) { log(`profiles fetch failed: ${e.message}`) }
    }
    if (profiles) info.profiles = profiles
    return { status: 'live', reason: 'logged in', accountInfo: Object.keys(info).length ? info : undefined }
  },

  // Mint an nftoken login link from the stored session. Only the three auth
  // cookies travel to the FTL endpoint — everything else is stripped so the
  // request looks exactly like the stock iOS app's.
  async nftoken({ cookies, fetch, log }) {
    if (!cookies.some(c => c.name === 'NetflixId')) throw new Error('NetflixId cookie missing')
    const keep = new Set(['NetflixId', 'SecureNetflixId', 'nfvdid'])
    const cookie = cookies.filter(c => keep.has(c.name)).map(c => `${c.name}=${c.value}`).join('; ')
    const url = 'https://ios.prod.ftl.netflix.com/iosui/user/15.48?' + new URLSearchParams(NFTOKEN_QUERY).toString()
    const res = await fetch(url, { headers: { ...NFTOKEN_HEADERS, cookie } })
    if (!res.ok) throw new Error(`nftoken HTTP ${res.status}`)
    const j = await res.json()
    const token = j?.value?.account?.token?.default?.token
    if (!token) { log('nftoken response had no token — cookie may be dead'); throw new Error('no nftoken in response (cookie may be dead)') }
    // One mint, two wrappers: the bare root URL logs the browser straight in;
    // /val is Netflix's app-handoff interstitial — open it in Safari/Chrome on
    // the phone and tap "Open in Netflix" to log the app in (same token).
    const q = encodeURIComponent(token)
    return {
      link: `https://netflix.com/?nftoken=${q}`,
      linkApp: `https://netflix.com/val?nftoken=${q}`,
      expires: j.value.account.token.default.expires
    }
  },
  // Link a TV by entering the code it displays (netflix.com/tv8 flow).
  // Verified against the live tv8 page 2026-08-25: the code entry form is a
  // classic server-rendered POST to the same URL with hidden fields flow,
  // authURL (page-scoped token), flowMode=enterTvLoginRendezvousCode,
  // withFields=tvLoginRendezvousCode,isTvUrl2, code + tvLoginRendezvousCode
  // (same value) and action=nextAction. A bad code re-renders the entry page
  // with "Something went wrong. Try again."; success leaves the entry flow.
  async linkTv({ fetch, log }, code) {
    const clean = String(code || '').trim().toUpperCase().replace(/\s+/g, '')
    if (!/^[A-Z0-9]{4,12}$/.test(clean)) { const e = new Error('invalid code format (4-12 letters/digits)'); e.status = 400; throw e }
    const HEADERS = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }
    const pageRes = await fetch('https://www.netflix.com/tv8', { headers: HEADERS })
    if (pageRes.status !== 200) throw new Error(`tv8 page HTTP ${pageRes.status}`)
    const html = await pageRes.text()
    const authURL = html.match(/name="authURL" value="([^"]+)"/)?.[1]
    const flow = html.match(/name="flow" value="([^"]+)"/)?.[1] || 'websiteSignUp'
    if (!authURL) { const e = new Error('tv8 page has no authURL — session may be dead, recheck this cookie'); e.status = 400; throw e }
    const form = new URLSearchParams({ flow, authURL, flowMode: 'enterTvLoginRendezvousCode', withFields: 'tvLoginRendezvousCode,isTvUrl2', code: clean, tvLoginRendezvousCode: clean, action: 'nextAction' })
    const res = await fetch('https://www.netflix.com/tv8', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    })
    if (res.status !== 200) throw new Error(`code submit HTTP ${res.status}`)
    const out = await res.text()
    log(`tv8 submit responded ${out.length} bytes`)
    if (/something went wrong|incorrect code|enterTvLoginRendezvousCode/i.test(out)) {
      const e = new Error('invalid or expired TV code'); e.status = 400; throw e
    }
    return { ok: true, message: 'TV linked — check your TV' }
  }
}
