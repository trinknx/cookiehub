import { describe, it, expect } from 'vitest'
import { splitBulk, detectFormat, parseNetscape, parseHeader, toHeaderString, toNetscape } from '../src/cookieFormat.js'

const NET = '.netflix.com\tTRUE\t/\tTRUE\t1790000000\tSecureSessionId\tabc123'
const NET_HTTPONLY = '#HttpOnly_.netflix.com\tTRUE\t/\tTRUE\t1790000000\tNetflixId\tv-2'
const HDR = 'SecureSessionId=abc123; NetflixId=v-2'

describe('splitBulk', () => {
  it('splits on blank lines and drops empties', () => {
    expect(splitBulk('a\n\n\nb\n   \nc')).toEqual(['a', 'b', 'c'])
  })
})

describe('detectFormat', () => {
  it('detects netscape', () => expect(detectFormat(NET)).toBe('netscape'))
  it('detects netscape with #HttpOnly_ lines', () => expect(detectFormat(NET_HTTPONLY)).toBe('netscape'))
  it('detects header', () => expect(detectFormat(HDR)).toBe('header'))
  it('detects garbage', () => expect(detectFormat('random text here')).toBe(null))
  it('detects invalid header names as garbage', () => expect(detectFormat('not a cookie=garbage')).toBe(null))
  it('does not misdetect tab-containing headers as netscape', () => {
    const h = 'a=1;\tb=2;\tc=3;\td=4;\te=5;\tf=6'
    expect(detectFormat(h)).not.toBe('netscape')
    expect(detectFormat(h)).toBe('header')
  })
})

describe('parseNetscape', () => {
  it('parses fields', () => {
    const c = parseNetscape(`${NET_HTTPONLY}\n${NET}`, '.netflix.com')
    expect(c).toHaveLength(2)
    expect(c[0]).toMatchObject({ domain: '.netflix.com', path: '/', secure: true, httpOnly: true, expiration: 1790000000000, name: 'NetflixId', value: 'v-2' })
    expect(c[1].httpOnly).toBe(false)
  })
  it('skips comments and empty lines', () => {
    const c = parseNetscape(`# comment\n\n${NET}`, '.x.com')
    expect(c).toHaveLength(1)
  })
  it('throws when nothing valid', () => {
    expect(() => parseNetscape('# only comments', '.x.com')).toThrow()
  })
})

describe('parseHeader', () => {
  it('parses pairs with default domain', () => {
    const c = parseHeader(HDR, '.spotify.com')
    expect(c).toHaveLength(2)
    expect(c[0]).toMatchObject({ domain: '.spotify.com', path: '/', secure: true, httpOnly: false, expiration: null, name: 'SecureSessionId', value: 'abc123' })
  })
  it('normalizes newlines to separators', () => {
    expect(parseHeader('a=1\nb=2', '.x.com')).toHaveLength(2)
  })
  it('throws when names are invalid tokens', () => {
    expect(() => parseHeader('not a cookie=garbage', '.x.com')).toThrow()
  })
})

describe('converters', () => {
  it('header string round-trips', () => {
    expect(toHeaderString(parseHeader(HDR, '.x.com'))).toBe(HDR)
  })
  it('netscape round-trips through header import', () => {
    const parsed = parseNetscape(NET, '.x.com')
    expect(toHeaderString(parsed)).toBe('SecureSessionId=abc123')
    const out = toNetscape(parsed)
    expect(detectFormat(out)).toBe('netscape')
    expect(parseNetscape(out, '.x.com')[0]).toEqual(parsed[0])
  })
  it('header-imported cookies export as netscape with far expiry', () => {
    const out = toNetscape(parseHeader('a=1', '.x.com'))
    const cols = out.split('\n')[1].split('\t')
    expect(Number(cols[4])).toBe(2147483647)
    expect(cols[0]).toBe('.x.com')
  })
  it('httpOnly round-trips through netscape export', () => {
    const parsed = parseNetscape(NET_HTTPONLY, '.netflix.com')
    const out = toNetscape(parsed)
    expect(out.split('\n')[1].startsWith('#HttpOnly_.netflix.com')).toBe(true)
    expect(parseNetscape(out, '.netflix.com')[0].httpOnly).toBe(true)
  })
  it('exports expiration 0 as epoch 0', () => {
    const out = toNetscape([{ domain: '.x.com', path: '/', secure: true, httpOnly: false, expiration: 0, name: 'a', value: '1' }])
    expect(Number(out.split('\n')[1].split('\t')[4])).toBe(0)
  })
})
