import { describe, it, expect } from 'vitest'
import { splitBulk, detectFormat, parseNetscape, parseHeader, parseJsonArray, toHeaderString, toNetscape, MAX_CHUNKS } from '../src/cookieFormat.js'

const NET = '.netflix.com\tTRUE\t/\tTRUE\t1790000000\tSecureSessionId\tabc123'
const NET_HTTPONLY = '#HttpOnly_.netflix.com\tTRUE\t/\tTRUE\t1790000000\tNetflixId\tv-2'
const HDR = 'SecureSessionId=abc123; NetflixId=v-2'

describe('splitBulk', () => {
  it('splits on blank lines and drops empties', () => {
    expect(splitBulk('a\n\n\nb\n   \nc')).toEqual(['a', 'b', 'c'])
  })
})

const JSON_ARR_1 = `[
  {
    "name": "NetflixId",
    "value": "synthetic-v-2",
    "domain": ".netflix.com",
    "hostOnly": false,
    "path": "/",
    "secure": true,
    "httpOnly": true,
    "sameSite": "no_restriction",
    "session": false,
    "expirationDate": 1790000000.5
  },
  {
    "name": "SecureSessionId",
    "value": "synthetic-abc123",
    "domain": ".netflix.com",
    "hostOnly": false,
    "path": "/",
    "secure": true,
    "httpOnly": false,
    "sameSite": "unspecified",
    "session": false,
    "expirationDate": 1807091768
  }
]`
const JSON_ARR_2 = `[
  {
    "name": "dsca",
    "value": "synthetic-2",
    "domain": ".netflix.com",
    "hostOnly": false,
    "path": "/",
    "secure": true,
    "httpOnly": false,
    "sameSite": "no_restriction",
    "session": false,
    "expirationDate": 1817141125
  }
]`
const MIXED_FILE = [
  '═════════════════════════════════',
  'NETFLIX ACCOUNT DETAILS  ::  #1 of 298',
  'BY: synthetic.example',
  '– Name: Tester One',
  '– Email: tester1@example.com',
  '– Plan: Basic',
  '',
  'COOKIE (browser import — paste into the Cookie-Editor extension):',
  JSON_ARR_1,
  '═════════════════════════════════',
  '',
  '████████████████████████████████',
  '',
  '═════════════════════════════════',
  'NETFLIX ACCOUNT DETAILS  ::  #2 of 298',
  '– Email: tester2@example.com',
  JSON_ARR_2,
  '═════════════════════════════════',
  '',
  'NetflixId=hdr-synthetic; SecureSessionId=hdr-synthetic-2'
].join('\n')

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

describe('splitBulk JSON array extraction', () => {
  it('extracts 2 JSON arrays from a mixed seller file, discarding surrounding text', () => {
    const chunks = splitBulk(MIXED_FILE)
    expect(chunks).toEqual([JSON_ARR_1, JSON_ARR_2])
    expect(chunks.every(c => detectFormat(c) === 'json')).toBe(true)
  })
  it('brackets inside JSON string values do not break span extraction', () => {
    const span = '[{"name": "a", "value": "a]b"}, {"name": "q", "value": "esc\\"aped]"}]'
    const chunks = splitBulk(`junk line\n${span}\nmore junk`)
    expect(chunks).toEqual([span])
    const parsed = parseJsonArray(chunks[0], '.x.com')
    expect(parsed[0].value).toBe('a]b')
    expect(parsed[1].value).toBe('esc"aped]')
  })
  it('extraction predicate matches detection: valid cookie need not be element 0', () => {
    const span = '[null,{"name":"a","value":"1"}]'
    expect(splitBulk(`junk\n${span}`)).toEqual([span])
    expect(detectFormat(span)).toBe('json')
  })
  it('nested spans are not double-extracted', () => {
    expect(splitBulk('[[{"name":"a","value":"1"}],{"name":"b","value":"2"}]')).toEqual(['[{"name":"a","value":"1"}]'])
  })
  it('stops extracting after MAX_CHUNKS + 1 spans', () => {
    const span = '[{"name":"a","value":"1"}]'
    const text = Array(MAX_CHUNKS + 2).fill(span).join('\njunk\n')
    const chunks = splitBulk(text)
    expect(chunks).toHaveLength(MAX_CHUNKS + 1)
    expect(chunks.every(c => c === span)).toBe(true)
  })
  it('200KB of unmatched brackets stays linear (perf regression)', () => {
    const hostile = `${'['.repeat(200000)}\n\n${NET}`
    const chunks = splitBulk(hostile)
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toBe(NET)
  })
  it('pure legacy text with no JSON spans still splits on blank lines', () => {
    expect(splitBulk('NetflixId=a\n\nNetflixId=b; SecureSessionId=c')).toEqual(['NetflixId=a', 'NetflixId=b; SecureSessionId=c'])
  })
  it('non-extractable brackets keep the full text in legacy splitting', () => {
    expect(splitBulk('[]')).toEqual(['[]'])
    expect(splitBulk('before [1,2] after')).toEqual(['before [1,2] after'])
  })
  it('unbalanced bracket leaves text exactly as today', () => {
    expect(splitBulk('a=1\n[not json')).toEqual(['a=1\n[not json'])
  })
})

describe('detectFormat json', () => {
  it('detects cookie-editor json arrays', () => {
    expect(detectFormat('[{"name":"a","value":"1"}]')).toBe('json')
    expect(detectFormat(JSON_ARR_1)).toBe('json')
  })
  it('empty or scalar arrays are not json', () => {
    expect(detectFormat('[]')).toBe(null)
    expect(detectFormat('[1,2]')).toBe(null)
  })
})

describe('parseJsonArray', () => {
  it('maps cookie-editor fields to canonical cookies', () => {
    const c = parseJsonArray(JSON_ARR_1, '.netflix.com')
    expect(c).toHaveLength(2)
    expect(c[0]).toEqual({
      domain: '.netflix.com', path: '/', secure: true, httpOnly: true,
      expiration: 1790000000500, name: 'NetflixId', value: 'synthetic-v-2'
    })
    expect(c[0]).not.toHaveProperty('hostOnly')
    expect(c[0]).not.toHaveProperty('sameSite')
    expect(c[0]).not.toHaveProperty('session')
    expect(c[1].httpOnly).toBe(false)
  })
  it('defaults missing domain and missing expiration', () => {
    const c = parseJsonArray('[{"name":"a","value":"1","path":"/deep"}]', '.x.com')
    expect(c[0]).toEqual({ domain: '.x.com', path: '/deep', secure: false, httpOnly: false, expiration: null, name: 'a', value: '1' })
  })
  it('skips nameless items and throws when none survive', () => {
    expect(parseJsonArray('[{"value":"1"},5,"x",{"name":"keep","value":"v"}]', '.x.com')).toHaveLength(1)
    expect(() => parseJsonArray('[{"value":"1"},5]', '.x.com')).toThrow('no valid cookies in JSON array')
  })
  it('round-trips through toHeaderString', () => {
    expect(toHeaderString(parseJsonArray('[{"name":"a","value":"1"},{"name":"b","value":"2"}]', '.x.com'))).toBe('a=1; b=2')
  })
})
