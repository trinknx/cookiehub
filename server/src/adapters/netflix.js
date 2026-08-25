const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

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
    const res = await fetch('https://www.netflix.com/browse', {
      redirect: 'manual',
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || 'unknown'
      // only a login redirect proves the session is dead — locale/canonical/maintenance
      // redirects must not mass-flip valid cookies to die
      if (loc.toLowerCase().includes('login')) return { status: 'die', reason: `redirected to ${loc}` }
      throw new Error(`transient redirect to ${loc}`) // engine records 'error', status unchanged
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
      // /account embeds TWO data sources (verified against a live page, 2026-08-25):
      // 1) a form-render model as ESCAPED JSON inside a JS string — raw bytes look
      //    like \"fieldType\":\"String\",\"value\":\"Basic\" — hence the \\" in the
      //    regexes; capture stops at the closing backslash.
      // 2) plain reactContext JSON with unescaped quotes (emailAddress, memberSince).
      // The old data-uia="plan-name" / "planName" / next-bill-date / "email" regexes
      // never matched the real page and are gone.
      const plan = html.match(/localizedPlanName\\":{\\"fieldType\\":\\"String\\",\\"value\\":\\"([^\\]+)/)
      if (plan) info.plan = plan[1]
      const streams = html.match(/maxStreams\\":{\\"fieldType\\":\\"Numeric\\",\\"value\\":(\d+)/)
      const quality = html.match(/videoQuality\\":{\\"fieldType\\":\\"String\\",\\"value\\":\\"([^\\]+)/)
      if (streams || quality) {
        info.extra = {}
        if (streams) info.extra.maxStreams = Number(streams[1])
        if (quality) info.extra.videoQuality = quality[1]
      }
      const email = html.match(/"emailAddress":"([^"]+)"/)
      if (email) info.email = email[1]
      const since = html.match(/"memberSince":"([^"]+)"/)
      if (since) info.memberSince = since[1]
    } catch (e) { log(`account info fetch failed: ${e.message}`) }
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
    return { link: 'https://netflix.com/?nftoken=' + encodeURIComponent(token), expires: j.value.account.token.default.expires }
  }
}
