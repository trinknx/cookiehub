export const MAX_CHUNK_BYTES = 100 * 1024
export const MAX_CHUNKS = 100

export function splitBulk(text) {
  return String(text).split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
}

export function detectFormat(chunk) {
  for (let line of chunk.split('\n')) {
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (line.split('\t').length >= 6) return 'netscape'
  }
  const flat = chunk.replace(/\s*\n\s*/g, '; ').trim()
  if (/^[^=;\s][^;=]*=[^;]*(\s*;\s*[^=;\s][^;=]*=[^;]*)*$/.test(flat)) return 'header'
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
    if (!name) continue
    cookies.push({ domain: defaultDomain, path: '/', secure: true, httpOnly: false, expiration: null, name, value })
  }
  if (!cookies.length) throw new Error('no cookie pairs found')
  return cookies
}

export function toHeaderString(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

const FAR = 2147483647
export function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of cookies) {
    const exp = c.expiration ? Math.min(Math.floor(c.expiration / 1000), FAR) : FAR
    lines.push([c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t'))
  }
  return lines.join('\n') + '\n'
}
