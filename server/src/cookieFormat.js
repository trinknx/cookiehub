export const MAX_CHUNK_BYTES = 100 * 1024
export const MAX_CHUNKS = 500

const isPlainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)

// End index of the balanced array span starting at src[start] ('['), or -1.
// Brackets inside JSON string literals (with backslash escapes) don't count.
function arraySpanEnd(src, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) return i }
  }
  return -1
}

function tryParseArray(span) {
  try {
    const v = JSON.parse(span)
    return Array.isArray(v) ? v : null
  } catch { return null }
}

// Bulk split. Extraction mode: balanced JSON arrays (Cookie-Editor exports,
// possibly pretty-printed inside seller files full of header junk) are the ONLY
// thing that matters — when ≥1 array is found the surrounding text is discarded
// entirely. With zero arrays, input falls back to legacy blank-line splitting.
export function splitBulk(text) {
  const src = String(text)
  const spans = []
  let i = 0
  while (i < src.length) {
    if (src[i] === '[') {
      const end = arraySpanEnd(src, i)
      if (end !== -1) {
        const span = src.slice(i, end + 1)
        const parsed = tryParseArray(span)
        if (parsed && isPlainObject(parsed[0])) {
          spans.push(span)
          i = end + 1
          continue
        }
      }
    }
    i++
  }
  if (spans.length) return spans
  return src.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
}

export function detectFormat(chunk) {
  const trimmed = chunk.trim()
  if (trimmed.startsWith('[')) {
    const arr = tryParseArray(trimmed)
    if (arr && arr.some(it => isPlainObject(it) && typeof it.name === 'string' && it.name)) return 'json'
  }
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
    if (!isPlainObject(item)) continue
    if (typeof item.name !== 'string' || !item.name) continue
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
