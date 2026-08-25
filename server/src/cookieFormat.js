export const MAX_CHUNK_BYTES = 100 * 1024
export const MAX_CHUNKS = 5000

const isPlainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)

// Shared predicate for Cookie-Editor arrays: ≥1 member is an object with a truthy string name.
const isValidCookieItem = it => isPlainObject(it) && typeof it.name === 'string' && it.name
const hasNamedCookie = arr => Array.isArray(arr) && arr.some(isValidCookieItem)

function tryParseArray(span) {
  try {
    const v = JSON.parse(span)
    return Array.isArray(v) ? v : null
  } catch { return null }
}

// Bulk split. Extraction mode: balanced JSON arrays (Cookie-Editor exports,
// possibly pretty-printed inside seller files full of header junk) are the ONLY
// thing that matters — when ≥1 array is found the surrounding text is discarded
// entirely (skipped = 0: it is never chunked). With zero arrays, input falls
// back to legacy blank-line splitting, which silently DROPS chunks that
// detectFormat rejects (seller banners, t.me lines, header text) — junk must
// not surface as per-chunk import failures in a 2000-file folder import.
// splitBulkCounted exposes the drop count; splitBulk keeps the plain-array
// shape for existing callers.
//
// Single pass, O(n): candidate '[' positions stack up while string-aware
// scanning (quotes/escapes only tracked inside a candidate, so junk-level
// quotes can't desync the scan); a ']' pops its candidate and tests the span
// with the same predicate detectFormat uses. An unmatched '[' costs one stack
// push — never a rescan. On emit, enclosing candidates (which start in what is
// now junk) are dropped so nested arrays are never double-extracted.
export function splitBulkCounted(text) {
  const src = String(text)
  const spans = []
  const candidates = []
  let inString = false
  let escaped = false
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (!candidates.length) {
      if (c === '[') candidates.push(i)
      i++
      continue
    }
    if (inString) {
      if (c === '\n' || c === '\r') {
        // raw newline inside a JSON string = malformed candidate; abort it and
        // resync so later '[' positions are reconsidered (no masking)
        candidates.pop()
        inString = false
        escaped = false
      }
      else if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') inString = true
    else if (c === '[') candidates.push(i)
    else if (c === ']') {
      const start = candidates.pop()
      const span = src.slice(start, i + 1)
      if (hasNamedCookie(tryParseArray(span))) {
        spans.push(span)
        if (spans.length > MAX_CHUNKS) return { chunks: spans, skipped: 0 } // cap: route rejects > MAX_CHUNKS as too_many
        candidates.length = 0
      }
    }
    i++
  }
  if (spans.length) return { chunks: spans, skipped: 0 }
  const parts = src.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
  const chunks = parts.filter(p => detectFormat(p))
  return { chunks, skipped: parts.length - chunks.length }
}

export function splitBulk(text) {
  return splitBulkCounted(text).chunks
}

export function detectFormat(chunk) {
  const trimmed = chunk.trim()
  if (trimmed.startsWith('[') && hasNamedCookie(tryParseArray(trimmed))) return 'json'
  for (let line of chunk.split('\n')) {
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    if (!line.trim() || line.trim().startsWith('#')) continue
    const fields = line.split('\t')
    if (fields.length >= 6 && /^\d*$/.test(fields[4])) return 'netscape'
  }
  const flat = chunk.replace(/\s*\n\s*/g, '; ').trim()
  if (/^[^=;\s]+=[^;]*(\s*;\s*[^=;\s]+=[^;]*)*$/.test(flat)) return 'header'
  return null
}

export function parseNetscape(chunk, defaultDomain) {
  const cookies = []
  for (let line of chunk.split('\n')) {
    line = line.replace(/\r$/, '')
    if (!line.trim()) continue
    let httpOnly = false
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice('#HttpOnly_'.length) }
    else if (line.trim().startsWith('#')) continue
    const f = line.split('\t')
    if (f.length < 6) continue
    const [domain, , path, secure, expires, name, ...rest] = f
    if (!name) continue
    cookies.push({
      domain: domain || defaultDomain,
      path: path || '/',
      secure: String(secure).toUpperCase() === 'TRUE',
      httpOnly,
      expiration: Number(expires) > 0 ? Number(expires) * 1000 : null,
      name,
      value: rest.join('\t')
    })
  }
  if (!cookies.length) throw new Error('no valid netscape cookie lines')
  return cookies
}

export function parseHeader(chunk, defaultDomain) {
  const flat = chunk.replace(/\s*\n\s*/g, '; ')
  const cookies = []
  for (const pair of flat.split(';')) {
    const i = pair.indexOf('=')
    if (i <= 0) continue
    const name = pair.slice(0, i).trim()
    const value = pair.slice(i + 1).trim()
    if (!/^[^=;\s]+$/.test(name)) continue
    cookies.push({ domain: defaultDomain, path: '/', secure: true, httpOnly: false, expiration: null, name, value })
  }
  if (!cookies.length) throw new Error('no cookie pairs found')
  return cookies
}

export function parseJsonArray(chunk, defaultDomain) {
  let arr
  try { arr = JSON.parse(String(chunk).trim()) } catch { throw new Error('invalid JSON array') }
  if (!Array.isArray(arr)) throw new Error('not a JSON array')
  const cookies = []
  for (const item of arr) {
    if (!isValidCookieItem(item)) continue
    cookies.push({
      domain: item.domain || defaultDomain,
      path: item.path || '/',
      secure: !!item.secure,
      httpOnly: !!item.httpOnly,
      expiration: Number.isFinite(item.expirationDate) ? Math.round(item.expirationDate * 1000) : null,
      name: item.name,
      value: String(item.value ?? '')
    })
  }
  if (!cookies.length) throw new Error('no valid cookies in JSON array')
  return cookies
}

export function toHeaderString(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

const FAR = 2147483647
export function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of cookies) {
    const exp = c.expiration != null ? Math.min(Math.floor(c.expiration / 1000), FAR) : FAR
    const domain = c.httpOnly ? `#HttpOnly_${c.domain}` : c.domain
    lines.push([domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t'))
  }
  return lines.join('\n') + '\n'
}
