# CookieHub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Personal single-user webapp on a VPS to store, export, and live/die-check Netscape & header-string cookies for Netflix, Spotify, and future services via adapter files.

**Architecture:** One Node.js process: Express API + SQLite (better-sqlite3) + check engine (undici fetch with http/socks5 proxy support) + node-cron scheduler, serving a built React/Vite/Tailwind SPA. Each service is a JS adapter file implementing `check(ctx)`; adding a service = drop a file, restart.

**Tech Stack:** Node.js ≥ 20 (ESM), Express 4, better-sqlite3, @node-rs/argon2, undici, socks, node-cron, cookie-parser, Vitest + supertest, React 18 + Vite 5 + Tailwind 3 + react-router-dom 6.

**Spec:** `docs/superpowers/specs/2026-08-25-cookie-manager-design.md`

## Global Constraints

- Node ≥ 20; server is ESM (`"type": "module"`); all server code under `server/`, client under `client/`
- npm workspaces; single `npm install` at root
- Cookie content is stored ONLY as AES-256-GCM ciphertext (`content_enc`); never returned by `GET /api/cookies`, only via `GET /api/cookies/:id/export`
- All `/api/*` routes except `/api/auth/*` require a valid session; all mutating requests require header `X-Requested-With: XMLHttpRequest`
- Check `error` (network/proxy/timeout) must NOT change `cookies.status`; only adapter `live`/`die` does
- Engine: global concurrency 3, min 1000ms gap between requests to the same service, 15s per-request timeout
- Proxy resolution order per check: `service_settings.proxy` → `settings.proxy_global` → direct
- Import limits: chunk ≤ 100 KB, ≤ 100 chunks per request
- Error response shape everywhere: `{"error":{"code":"...","message":"..."}}`
- Time values stored as ms epoch integers
- Tests: Vitest, run via `npm test -w server`; each task commits after tests pass

## File Structure

```
package.json                  root: workspaces + scripts
server/
  package.json                deps + vitest
  vitest.config.js
  src/
    env.js                    tiny .env loader (no dotenv dep)
    crypto.js                 AES-256-GCM encrypt/decrypt JSON
    db.js                     openDb + migrations + settings helpers
    cookieFormat.js           detect/parse/convert netscape|header
    adapters/
      index.js                loadAdapters(dir) → Map<key, adapter>
      netflix.js
      spotify.js
    engine.js                 createEngine: queue, throttle, proxy, check-all job
    scheduler.js              hoursToPattern + createScheduler
    app.js                    buildApp({db, adapters, engine, scheduler}) — testable factory
    routes/auth.js            setup/login/logout/session + requireAuth + csrf + rate limit
    routes/cookies.js         CRUD, bulk import, export, logs, check, check-all
    routes/services.js        list + patch service settings
    routes/settings.js        get/put settings, change password
    index.js                  boot: env, key, db, adapters, engine, scheduler, static, listen
  test/
    crypto.test.js
    db.test.js
    cookieFormat.test.js
    auth.test.js
    adapters.test.js
    engine.test.js
    api.test.js
client/
  package.json  vite.config.js  tailwind.config.js  postcss.config.js  index.html
  src/main.jsx  src/index.css  src/api.js  src/App.jsx
  src/pages/Login.jsx  src/pages/Dashboard.jsx  src/pages/Settings.jsx
docs/superpowers/plans/2026-08-25-cookie-manager.md   (this file)
README.md  deploy/Caddyfile  deploy/cookiehub.service
```

---

### Task 1: Scaffold monorepo

**Files:**
- Create: `package.json`, `server/package.json`, `server/vitest.config.js`, `.gitignore`, `client/package.json`, `client/vite.config.js`, `client/tailwind.config.js`, `client/postcss.config.js`, `client/index.html`, `client/src/main.jsx`, `client/src/index.css`, `client/src/App.jsx`

**Interfaces:**
- Consumes: nothing
- Produces: `npm install` / `npm run build` / `npm test` work at root; empty Vitest suite runs green; `client/dist/` builds

- [ ] **Step 1: Root package.json**

```json
{
  "name": "cookiehub",
  "private": true,
  "workspaces": ["server", "client"],
  "scripts": {
    "build": "npm run build -w client",
    "start": "npm run start -w server",
    "dev": "npm run dev -w server & npm run dev -w client",
    "test": "npm test -w server"
  }
}
```

- [ ] **Step 2: Server package.json + vitest config**

`server/package.json`:

```json
{
  "name": "cookiehub-server",
  "type": "module",
  "main": "src/index.js",
  "scripts": { "start": "node src/index.js", "test": "vitest run" },
  "dependencies": {
    "@node-rs/argon2": "^2.0.0",
    "better-sqlite3": "^11.3.0",
    "cookie-parser": "^1.4.6",
    "express": "^4.19.2",
    "node-cron": "^3.0.3",
    "socks": "^2.8.1",
    "undici": "^6.19.0"
  },
  "devDependencies": { "supertest": "^7.0.0", "vitest": "^2.0.5" }
}
```

`server/vitest.config.js`:

```js
export default { test: { include: ['test/**/*.test.js'], environment: 'node' } }
```

- [ ] **Step 3: .gitignore**

```
node_modules/
server/data/
.env
client/dist/
```

- [ ] **Step 4: Client scaffold**

`client/package.json`:

```json
{
  "name": "cookiehub-client",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1", "react-router-dom": "^6.26.0" },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.38",
    "tailwindcss": "^3.4.10",
    "vite": "^5.4.0"
  }
}
```

`client/vite.config.js`:

```js
import react from '@vitejs/plugin-react'
export default {
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } }
}
```

`client/tailwind.config.js`:

```js
export default { content: ['./index.html', './src/**/*.{js,jsx}'], theme: { extend: {} }, plugins: [] }
```

`client/postcss.config.js`:

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

`client/index.html`:

```html
<!doctype html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>CookieHub</title></head>
<body class="bg-slate-900 text-slate-100"><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>
</html>
```

`client/src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`client/src/main.jsx`:

```jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>)
```

`client/src/App.jsx` (placeholder for later tasks):

```jsx
export default function App() { return <div className="p-8 text-lg">CookieHub</div> }
```

- [ ] **Step 5: Install + verify builds**

Run: `npm install && npm run build && npm test`
Expected: install succeeds, `client/dist/` produced, vitest reports "no test files found" exit code 0 (add `--passWithNoTests` if it errors).

If vitest exits non-zero with no tests, change server test script to `"test": "vitest run --passWithNoTests"`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold cookiehub monorepo"
```

---

### Task 2: env loader + AES-256-GCM crypto util

**Files:**
- Create: `server/src/env.js`, `server/src/crypto.js`, `server/test/crypto.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `readEnv(path = '.env')` → object of KEY→string (missing file → `{}`)
  - `initEncryption(keyB64)` → void; throws if key doesn't decode to 32 bytes
  - `generateKeyB64()` → 32-byte random as base64 string
  - `encryptJSON(obj)` → Buffer `[iv(12) | tag(16) | ciphertext]`
  - `decryptJSON(buf)` → parsed object; throws on tamper/wrong key

- [ ] **Step 1: Write failing tests** (`server/test/crypto.test.js`)

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { initEncryption, generateKeyB64, encryptJSON, decryptJSON } from '../src/crypto.js'

describe('crypto', () => {
  beforeEach(() => initEncryption(generateKeyB64()))
  it('round-trips an object', () => {
    const data = [{ name: 'SecureSessionId', value: 'v1', domain: '.netflix.com' }]
    expect(decryptJSON(encryptJSON(data))).toEqual(data)
  })
  it('uses a fresh IV per call (different ciphertexts)', () => {
    expect(encryptJSON({ a: 1 }).equals(encryptJSON({ a: 1 }))).toBe(false)
  })
  it('rejects tampered ciphertext', () => {
    const buf = encryptJSON({ a: 1 }); buf[buf.length - 1] ^= 0xff
    expect(() => decryptJSON(buf)).toThrow()
  })
  it('rejects wrong key size', () => {
    expect(() => initEncryption(Buffer.alloc(8).toString('base64'))).toThrow(/32 bytes/)
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w server`
Expected: FAIL — cannot resolve `../src/crypto.js`

- [ ] **Step 3: Implement** `server/src/crypto.js`

```js
import crypto from 'node:crypto'

let KEY = null

export function initEncryption(keyB64) {
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes')
  KEY = key
}

export function generateKeyB64() {
  return crypto.randomBytes(32).toString('base64')
}

export function encryptJSON(obj) {
  if (!KEY) throw new Error('encryption not initialized')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj))), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct])
}

export function decryptJSON(buf) {
  if (!KEY) throw new Error('encryption not initialized')
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28)
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv)
  d.setAuthTag(tag)
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString())
}
```

`server/src/env.js`:

```js
import fs from 'node:fs'

export function readEnv(file = '.env') {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -w server`
Expected: PASS (4 crypto tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/crypto.js server/src/env.js server/test/crypto.test.js
git commit -m "feat(server): env loader + AES-256-GCM cookie encryption"
```

---

### Task 3: DB layer + settings helpers

**Files:**
- Create: `server/src/db.js`, `server/test/db.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `openDb(file = ':memory:')` → better-sqlite3 Database with WAL, FK on, all 5 tables created (`cookies`, `check_logs`, `settings`, `service_settings`, `sessions` — columns exactly per spec §3)
  - `getSetting(db, key)` → string | undefined
  - `setSetting(db, key, value)` → void (upsert)

- [ ] **Step 1: Write failing tests** (`server/test/db.test.js`)

```js
import { describe, it, expect } from 'vitest'
import { openDb, getSetting, setSetting } from '../src/db.js'

describe('db', () => {
  it('creates all tables', () => {
    const db = openDb()
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    for (const t of ['cookies', 'check_logs', 'settings', 'service_settings', 'sessions'])
      expect(names).toContain(t)
  })
  it('settings upsert + get', () => {
    const db = openDb()
    expect(getSetting(db, 'password_hash')).toBeUndefined()
    setSetting(db, 'password_hash', 'h1'); setSetting(db, 'password_hash', 'h2')
    expect(getSetting(db, 'password_hash')).toBe('h2')
  })
  it('deleting a cookie cascades to check_logs', () => {
    const db = openDb()
    const now = Date.now()
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO cookies(service_key,label,content_enc,source_format,created_at,updated_at) VALUES(?,?,?,?,?,?)'
    ).run('netflix', 'x', Buffer.alloc(10), 'header', now, now)
    db.prepare('INSERT INTO check_logs(cookie_id,status,created_at) VALUES(?,?,?)').run(lastInsertRowid, 'live', now)
    db.prepare('DELETE FROM cookies WHERE id=?').run(lastInsertRowid)
    expect(db.prepare('SELECT COUNT(*) c FROM check_logs').get().c).toBe(0)
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w server`
Expected: FAIL — cannot resolve `../src/db.js`

- [ ] **Step 3: Implement** `server/src/db.js`

```js
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cookies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  content_enc BLOB NOT NULL,
  source_format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  account_info TEXT,
  last_checked_at INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cookies_service ON cookies(service_key);
CREATE TABLE IF NOT EXISTS check_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cookie_id INTEGER NOT NULL REFERENCES cookies(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  detail TEXT,
  proxy_used TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_cookie ON check_logs(cookie_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS service_settings (
  service_key TEXT PRIMARY KEY,
  proxy TEXT,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`

export function openDb(file = ':memory:') {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

export const getSetting = (db, key) =>
  db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value

export const setSetting = (db, key, value) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value))
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -w server`
Expected: PASS (db + crypto suites)

- [ ] **Step 5: Commit**

```bash
git add server/src/db.js server/test/db.test.js
git commit -m "feat(server): sqlite schema + settings helpers"
```

---

### Task 4: Cookie format module

**Files:**
- Create: `server/src/cookieFormat.js`, `server/test/cookieFormat.test.js`

**Interfaces:**
- Consumes: nothing
- Produces (CanonicalCookie = `{domain, path, secure, httpOnly, expiration(ms|null), name, value}`):
  - `splitBulk(text)` → string[] (split on blank lines, trimmed, non-empty)
  - `detectFormat(chunk)` → `'netscape' | 'header' | null`
  - `parseNetscape(chunk, defaultDomain)` → CanonicalCookie[] (throws if no valid lines; handles `#HttpOnly_` prefix; skips `#` comments; value may contain tabs)
  - `parseHeader(chunk, defaultDomain)` → CanonicalCookie[] (throws if no pairs; multi-line normalized)
  - `toHeaderString(cookies)` → `'name=value; name2=value2'`
  - `toNetscape(cookies)` → full Netscape file text (header line + 7 tab-separated columns; missing expiration → epoch 2147483647 capped)
  - `MAX_CHUNK_BYTES = 102400`, `MAX_CHUNKS = 100`

- [ ] **Step 1: Write failing tests** (`server/test/cookieFormat.test.js`)

```js
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
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w server`
Expected: FAIL — cannot resolve `../src/cookieFormat.js`

- [ ] **Step 3: Implement** `server/src/cookieFormat.js`

```js
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
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -w server`
Expected: PASS (all cookieFormat tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/cookieFormat.js server/test/cookieFormat.test.js
git commit -m "feat(server): cookie format detect/parse/convert"
```

---

### Task 5: Auth routes + app factory

**Files:**
- Create: `server/src/routes/auth.js`, `server/src/app.js`, `server/test/auth.test.js`

**Interfaces:**
- Consumes: `openDb/getSetting/setSetting` (Task 3)
- Produces:
  - `authRoutes(db)` → express.Router mounted at `/api/auth`: `POST /setup {password}`, `POST /login {password}`, `POST /logout`, `GET /session`
  - `requireAuth(db)` → middleware (401 `{"error":{code:"unauthenticated",...}}` when cookie `sid` missing/expired)
  - `csrfGuard` → middleware (403 `{"error":{code:"csrf",...}}` when method is mutating and header `x-requested-with !== 'XMLHttpRequest'`)
  - `buildApp({ db, adapters, engine, scheduler })` → express app: json body (2mb), cookieParser, auth routes, then `/api` behind `requireAuth` + `csrfGuard`, 404 JSON for unknown `/api/*`, error handler returning `{"error":{"code":"internal","message"}}`
  - Login rate limit: 5 failed attempts per IP → 429 `rate_limited` for 15 min
  - Passwords: 8–128 chars, hashed `@node-rs/argon2` default params, stored in `settings.password_hash`
  - Sessions: token = 32 random bytes base64url in cookie `sid` (httpOnly, sameSite=lax; `secure` when `NODE_ENV=production`); sha256(token) stored in `sessions`, TTL 7 days

- [ ] **Step 1: Write failing tests** (`server/test/auth.test.js`)

```js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { openDb } from '../src/db.js'
import { buildApp } from '../src/app.js'

const build = () => buildApp({ db: openDb(), adapters: new Map(), engine: null, scheduler: null })

describe('auth flow', () => {
  it('GET /api/auth/session → needsSetup true initially', async () => {
    const res = await request(build()).get('/api/auth/session')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ authenticated: false, needsSetup: true })
  })

  it('setup → session → logout', async () => {
    const app = build()
    const agent = request.agent(app)
    await agent.post('/api/auth/setup').send({ password: 'hunter2hunter2' }).expect(200)
    expect((await agent.get('/api/auth/session')).body).toEqual({ authenticated: true, needsSetup: false })
    await agent.post('/api/auth/logout').expect(200)
    expect((await agent.get('/api/auth/session')).body.authenticated).toBe(false)
  })

  it('setup twice → 409; login wrong password → 401; login right → 200', async () => {
    const app = build()
    const agent = request.agent(app)
    await agent.post('/api/auth/setup').send({ password: 'hunter2hunter2' }).expect(200)
    await request(app).post('/api/auth/setup').send({ password: 'other12345' }).expect(409)
    await request(app).post('/api/auth/login').send({ password: 'wrongwrong1' }).expect(401)
    await agent.post('/api/auth/login').send({ password: 'hunter2hunter2' }).expect(200)
  })

  it('short password → 400', async () => {
    await request(build()).post('/api/auth/setup').send({ password: 'short' }).expect(400)
  })

  it('unknown /api route without session → 401; with session but no CSRF header → 403', async () => {
    const app = build()
    await request(app).get('/api/cookies').expect(401)
    const agent = request.agent(app)
    await agent.post('/api/auth/setup').send({ password: 'hunter2hunter2' })
    await agent.post('/api/cookies').send({}).expect(403)
  })

  it('5 bad logins → 429', async () => {
    const app = build()
    await request(app).post('/api/auth/setup').send({ password: 'hunter2hunter2' })
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ password: 'bad' + i }).expect(401)
    await request(app).post('/api/auth/login').send({ password: 'bad6' }).expect(429)
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w server`
Expected: FAIL — cannot resolve `../src/app.js`

- [ ] **Step 3: Implement** `server/src/routes/auth.js`

```js
import { Router } from 'express'
import { randomBytes, createHash } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import { getSetting, setSetting } from '../db.js'

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
const attempts = new Map() // ip → { count, until }

const sha256 = s => createHash('sha256').update(s).digest('hex')
const err = (res, code, message, status) => res.status(status).json({ error: { code, message } })

function createSession(db, res) {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  db.prepare('INSERT INTO sessions(token_hash, expires_at, created_at) VALUES(?,?,?)').run(sha256(token), now + SESSION_TTL_MS, now)
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_TTL_MS })
}

export function authRoutes(db) {
  const r = Router()
  r.get('/session', (req, res) => {
    const hasPw = !!getSetting(db, 'password_hash')
    res.json({ authenticated: !!(req.cookies?.sid && validSession(db, req.cookies.sid)), needsSetup: !hasPw })
  })
  r.post('/setup', async (req, res) => {
    if (getSetting(db, 'password_hash')) return err(res, 'already_setup', 'password already set', 409)
    const pw = req.body?.password
    if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) return err(res, 'invalid_password', 'password must be 8-128 chars', 400)
    setSetting(db, 'password_hash', await hash(pw))
    createSession(db, res)
    res.json({ ok: true })
  })
  r.post('/login', async (req, res) => {
    const a = attempts.get(req.ip) || { count: 0, until: 0 }
    if (Date.now() < a.until) return err(res, 'rate_limited', 'too many attempts, try later', 429)
    const pw = req.body?.password
    const stored = getSetting(db, 'password_hash')
    if (!stored || typeof pw !== 'string' || !(await verify(stored, pw))) {
      a.count++
      if (a.count >= 5) { a.until = Date.now() + 15 * 60 * 1000; a.count = 0 }
      attempts.set(req.ip, a)
      return err(res, 'bad_credentials', 'invalid password', 401)
    }
    attempts.delete(req.ip)
    createSession(db, res)
    res.json({ ok: true })
  })
  r.post('/logout', (req, res) => {
    if (req.cookies?.sid) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(req.cookies.sid))
    res.clearCookie('sid')
    res.json({ ok: true })
  })
  return r
}

function validSession(db, token) {
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(sha256(token))
  return !!row && row.expires_at > Date.now()
}

export function requireAuth(db) {
  return (req, res, next) => {
    if (req.cookies?.sid && validSession(db, req.cookies.sid)) return next()
    err(res, 'unauthenticated', 'login required', 401)
  }
}

export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (req.get('x-requested-with') === 'XMLHttpRequest') return next()
  err(res, 'csrf', 'missing X-Requested-With header', 403)
}
```

`server/src/app.js`:

```js
import express from 'express'
import cookieParser from 'cookie-parser'
import { authRoutes, requireAuth, csrfGuard } from './routes/auth.js'
import { cookieRoutes } from './routes/cookies.js'
import { serviceRoutes } from './routes/services.js'
import { settingsRoutes } from './routes/settings.js'

export function buildApp({ db, adapters, engine, scheduler }) {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use(cookieParser())
  app.use('/api/auth', authRoutes(db))
  app.use('/api', requireAuth(db), csrfGuard)
  app.use('/api/cookies', cookieRoutes({ db, engine }))
  app.use('/api/services', serviceRoutes({ db, adapters }))
  app.use('/api/settings', settingsRoutes({ db, scheduler }))
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'unknown api route' } }))
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(err.status || 500).json({ error: { code: err.code || 'internal', message: err.message || 'internal error' } })
  })
  return app
}
```

Note: `routes/cookies.js`, `routes/services.js`, `routes/settings.js` do not exist yet — create minimal stub routers NOW that only throw 501, to be replaced by Tasks 6–8. Stub content (all three files same shape):

```js
import { Router } from 'express'
export function cookieRoutes() { const r = Router(); r.all('*', (req, res) => res.status(501).json({ error: { code: 'not_implemented', message: 'pending' } })); return r }
```

(`services.js` exports `serviceRoutes`, `settings.js` exports `settingsRoutes`, same body.)

- [ ] **Step 4: Run, verify pass**

Run: `npm test -w server`
Expected: PASS (auth suite: 6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes server/src/app.js server/test/auth.test.js
git commit -m "feat(server): auth setup/login/session + csrf + app factory"
```

---

### Task 6: Netflix + Spotify adapters + registry

**Files:**
- Create: `server/src/adapters/index.js`, `server/src/adapters/netflix.js`, `server/src/adapters/spotify.js`, `server/test/adapters.test.js`

**Interfaces:**
- Consumes: nothing (pure modules)
- Produces:
  - `loadAdapters(dir)` → async → `Map<key, adapter>`; validates each adapter has string `key`/`name`/`defaultDomain` and function `check`; duplicate key → throw
  - Adapter shape: `{ key, name, defaultDomain, check(ctx) }` where `ctx = { cookieHeader: string, cookies: CanonicalCookie[], fetch(url, init): Promise<Response>, log(msg) }` and check resolves `{ status: 'live'|'die', reason: string, accountInfo?: { email?, plan?, expiresAt?, country?, extra? } }`
  - Netflix check: GET `https://www.netflix.com/browse` redirect-manual; 3xx → die with location; non-200 → die; 200 → live, then best-effort GET `/account` for plan/email/next-bill
  - Spotify check: GET `https://www.spotify.com/account/overview/` redirect-manual; 401/403 → die; 3xx → die; 200 → live + best-effort email/plan parse

- [ ] **Step 1: Write failing tests** (`server/test/adapters.test.js`)

```js
import { describe, it, expect } from 'vitest'
import netflix from '../src/adapters/netflix.js'
import spotify from '../src/adapters/spotify.js'

const res = (status, body = '', headers = {}) => ({
  status, headers: { get: k => headers[k.toLowerCase()] ?? null }, text: async () => body
})
const ctxOf = responses => {
  let i = 0
  return { cookieHeader: 'a=1', cookies: [], log: () => {}, fetch: async () => responses[i++] }
}

describe('netflix adapter', () => {
  it('3xx to /login → die', async () => {
    const r = await netflix.check(ctxOf([res(302, '', { location: 'https://www.netflix.com/login' })]))
    expect(r).toMatchObject({ status: 'die' })
    expect(r.reason).toContain('/login')
  })
  it('200 → live with country from body', async () => {
    const r = await netflix.check(ctxOf([
      res(200, '{"currentCountry":"VN"}'),
      res(200, '<b data-uia="plan-name"><div>Premium</div></b><div data-uia="next-bill-date">August 30, 2026</div>"email":"a@gmail.com"')
    ]))
    expect(r.status).toBe('live')
    expect(r.accountInfo).toMatchObject({ country: 'VN', plan: 'Premium', email: 'a@gmail.com', expiresAt: 'August 30, 2026' })
  })
  it('account fetch failure still → live', async () => {
    let call = 0
    const ctx = { cookieHeader: 'a=1', cookies: [], log: () => {}, fetch: async () => { if (call++ === 0) return res(200, ''); throw new Error('boom') } }
    const r = await netflix.check(ctx)
    expect(r.status).toBe('live')
  })
})

describe('spotify adapter', () => {
  it('401 → die', async () => {
    const r = await spotify.check(ctxOf([res(401)]))
    expect(r).toMatchObject({ status: 'die', reason: 'HTTP 401' })
  })
  it('3xx → die', async () => {
    const r = await spotify.check(ctxOf([res(302, '', { location: '/login' })]))
    expect(r.status).toBe('die')
  })
  it('200 → live with parsed email/plan', async () => {
    const r = await spotify.check(ctxOf([res(200, '"email":"me@gmail.com","plan":"Premium","renewalDate":"2026-09-01"')]))
    expect(r).toMatchObject({ status: 'live' })
    expect(r.accountInfo).toMatchObject({ email: 'me@gmail.com', plan: 'Premium' })
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w server`
Expected: FAIL — cannot resolve adapter modules

- [ ] **Step 3: Implement**

`server/src/adapters/netflix.js`:

```js
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
```

`server/src/adapters/spotify.js`:

```js
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
```

`server/src/adapters/index.js`:

```js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function loadAdapters(dir = fileURLToPath(new URL('.', import.meta.url))) {
  const map = new Map()
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.js') || f === 'index.js') continue
    const mod = await import(pathToFileURL(path.join(dir, f)).href)
    const a = mod.default ?? mod
    if (!a?.key || !a?.name || !a?.defaultDomain || typeof a.check !== 'function') {
      throw new Error(`invalid adapter ${f}: needs key, name, defaultDomain, check()`)
    }
    if (map.has(a.key)) throw new Error(`duplicate adapter key ${a.key} (${f})`)
    map.set(a.key, a)
  }
  return map
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -w server`
Expected: PASS (adapters suite). Also add registry test to `adapters.test.js`:

```js
import { loadAdapters } from '../src/adapters/index.js'
import path from 'node:path'
describe('registry', () => {
  it('loads netflix + spotify with unique keys', async () => {
    const map = await loadAdapters(path.resolve('src/adapters'))
    expect([...map.keys()].sort()).toEqual(['netflix', 'spotify'])
    expect(map.get('netflix').defaultDomain).toBe('.netflix.com')
  })
})
```

- [ ] **Step 5: Commit**

```bash
git add server/src/adapters server/test/adapters.test.js
git commit -m "feat(server): netflix/spotify adapters + adapter registry"
```

---

### Task 7: Check engine + proxy dispatchers

**Files:**
- Create: `server/src/engine.js`, `server/test/engine.test.js`

**Interfaces:**
- Consumes: `toHeaderString` (Task 4), `decryptJSON` (Task 2), adapters map (Task 6)
- Produces: `createEngine({ db, adapters })` →
  - `runCheck(cookieId)` → Promise<'live'|'die'|'error'>; throws `{ status: 409 }` if that cookie is already being checked; row's service must exist in adapters (else `{ status: 422 }` error object)
  - `startCheckAll(serviceKey?)` → `{ queued: n }`; throws `{ status: 409 }` if a job is running; excludes services disabled in `service_settings`
  - Note: direct `runCheck` on a cookie whose service is disabled is allowed (deliberate relaxation of spec §10's 423 — disabled only excludes from check-all/scheduler)
  - `jobStatus()` → `{ running, pending, done, failed }`
  - Proxy: `proxyFor(serviceKey)` = `service_settings.proxy ?? settings.proxy_global`; `buildDispatcher(proxyUrl)` → undici dispatcher (cached): `http(s)://` → `ProxyAgent`, `socks5(h)://` → custom `Agent` with `SocksClient` connect; unsupported protocol → throw
  - Per-request: 15s AbortController timeout; ≥1000ms gap between requests of same service; global concurrency 3
  - On adapter result `live`: update `status`, `account_info` (only if provided), `last_checked_at`; `die`: update `status`, `last_checked_at` (keep old account_info); always insert `check_logs` row (`live|die|error`, reason, detail, proxy_used, duration_ms); `error` never touches `cookies.status`

- [ ] **Step 1: Write failing tests** (`server/test/engine.test.js`)

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, setSetting } from '../src/db.js'
import { createEngine } from '../src/engine.js'
import { initEncryption, generateKeyB64, encryptJSON } from '../src/crypto.js'

const fakeAdapter = (result) => ({ key: 'fake', name: 'Fake', defaultDomain: '.fake.com', check: async () => result })
const throwingAdapter = { key: 'boom', name: 'Boom', defaultDomain: '.b.com', check: async () => { throw new Error('proxy unreachable') } }

function seed(db, service, n = 1) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const info = { i }
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO cookies(service_key,label,content_enc,source_format,created_at,updated_at) VALUES(?,?,?,?,?,?)'
    ).run(service, 'c' + i, encryptJSON([{ domain: '.x.com', path: '/', secure: true, httpOnly: false, expiration: null, name: 'sid', value: 'v' + i }]), 'header', Date.now(), Date.now())
    ids.push(Number(lastInsertRowid))
  }
  return ids
}

describe('engine', () => {
  beforeEach(() => initEncryption(generateKeyB64()))
  it('live result updates cookie + writes log', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    const engine = createEngine({ db, adapters: new Map([['fake', fakeAdapter({ status: 'live', reason: 'ok', accountInfo: { email: 'a@b.c' } })]]) })
    expect(await engine.runCheck(id)).toBe('live')
    const row = db.prepare('SELECT * FROM cookies WHERE id=?').get(id)
    expect(row.status).toBe('live')
    expect(JSON.parse(row.account_info)).toEqual({ email: 'a@b.c' })
    expect(db.prepare('SELECT * FROM check_logs WHERE cookie_id=?').get(id)).toMatchObject({ status: 'live', reason: 'ok' })
  })
  it('die keeps old account_info; error keeps status untouched', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    db.prepare('UPDATE cookies SET status=?, account_info=? WHERE id=?').run('live', '{"email":"old@x"}', id)
    let engine = createEngine({ db, adapters: new Map([['fake', fakeAdapter({ status: 'die', reason: 'redirected' })]]) })
    await engine.runCheck(id)
    let row = db.prepare('SELECT status, account_info FROM cookies WHERE id=?').get(id)
    expect(row.status).toBe('die')
    expect(row.account_info).toBe('{"email":"old@x"}')
    engine = createEngine({ db, adapters: new Map([['boom', throwingAdapter]]) })
    db.prepare('UPDATE cookies SET service_key=?, status=? WHERE id=?').run('boom', 'die', id)
    expect(await engine.runCheck(id)).toBe('error')
    row = db.prepare('SELECT status FROM cookies WHERE id=?').get(id)
    expect(row.status).toBe('die') // unchanged
    const log = db.prepare('SELECT * FROM check_logs WHERE cookie_id=? ORDER BY id DESC LIMIT 1').get(id)
    expect(log.status).toBe('error')
    expect(log.reason).toContain('proxy unreachable')
  })
  it('double check of same cookie → 409', async () => {
    const db = openDb()
    const [id] = seed(db, 'fake')
    let release
    const slow = { key: 'fake', name: 'Fake', defaultDomain: '.f.com', check: () => new Promise(r => { release = r }) }
    const engine = createEngine({ db, adapters: new Map([['fake', slow]]) })
    const p = engine.runCheck(id)
    await expect(engine.runCheck(id)).rejects.toMatchObject({ status: 409 })
    release({ status: 'live', reason: '' })
    expect(await p).toBe('live')
  })
  it('check-all: queues, completes, second start while running → 409', async () => {
    const db = openDb()
    seed(db, 'fake', 4)
    let release
    const slow = { key: 'fake', name: 'F', defaultDomain: '.f.com', check: () => new Promise(r => { release = r }) }
    const engine = createEngine({ db, adapters: new Map([['fake', slow]]) })
    const { queued } = engine.startCheckAll()
    expect(queued).toBe(4)
    expect(() => engine.startCheckAll()).toThrow()
    for (let i = 0; i < 4; i++) release({ status: 'live', reason: '' })
    await new Promise(r => setTimeout(r, 50))
    expect(engine.jobStatus()).toMatchObject({ running: false, done: 4, failed: 0 })
  })
  it('check-all skips disabled services', () => {
    const db = openDb()
    seed(db, 'fake', 2); seed(db, 'off', 2)
    db.prepare('INSERT INTO service_settings(service_key,disabled) VALUES(?,?)').run('off', 1)
    const engine = createEngine({ db, adapters: new Map([['fake', fakeAdapter({ status: 'live', reason: '' })], ['off', fakeAdapter({ status: 'live', reason: '' })]]) })
    expect(engine.startCheckAll().queued).toBe(2)
  })
  it('buildDispatcher rejects unsupported protocol', () => {
    const engine = createEngine({ db: openDb(), adapters: new Map() })
    expect(() => engine.buildDispatcher('ftp://x:21')).toThrow(/unsupported/)
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w server`
Expected: FAIL — cannot resolve `../src/engine.js`

- [ ] **Step 3: Implement** `server/src/engine.js`

```js
import { fetch as undiciFetch, ProxyAgent, Agent } from 'undici'
import { SocksClient } from 'socks'
import { getSetting } from './db.js'
import { decryptJSON } from './crypto.js'
import { toHeaderString } from './cookieFormat.js'

const CONCURRENCY = 3
const SERVICE_GAP_MS = 1000
const TIMEOUT_MS = 15000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

export function createEngine({ db, adapters }) {
  const lastReq = new Map()
  const dispatchers = new Map()
  const inflight = new Set()
  const job = { running: false, pending: 0, done: 0, failed: 0 }

  const getServiceSetting = key =>
    db.prepare('SELECT proxy, disabled FROM service_settings WHERE service_key=?').get(key)

  function buildDispatcher(proxyUrl) {
    if (!proxyUrl) return undefined
    if (dispatchers.has(proxyUrl)) return dispatchers.get(proxyUrl)
    const u = new URL(proxyUrl)
    let d
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      d = new ProxyAgent({ uri: proxyUrl })
    } else if (u.protocol === 'socks5:' || u.protocol === 'socks5h:') {
      d = new Agent({
        connect: async ({ hostname, port }, callback) => {
          try {
            const { socket } = await SocksClient.createConnection({
              proxy: {
                host: u.hostname, port: Number(u.port || 1080), type: 5,
                userId: decodeURIComponent(u.username || ''),
                password: decodeURIComponent(u.password || '')
              },
              command: 'connect',
              destination: { host: hostname, port: Number(port) }
            })
            callback(null, { socket })
          } catch (e) { callback(e, null) }
        }
      })
    } else {
      throw new Error(`unsupported proxy protocol: ${u.protocol}`)
    }
    dispatchers.set(proxyUrl, d)
    return d
  }

  const proxyFor = serviceKey =>
    getServiceSetting(serviceKey)?.proxy ?? getSetting(db, 'proxy_global') ?? null

  async function runCheck(cookieId) {
    if (inflight.has(cookieId)) { const e = new Error('already checking'); e.status = 409; throw e }
    const row = db.prepare('SELECT * FROM cookies WHERE id=?').get(cookieId)
    if (!row) { const e = new Error('cookie not found'); e.status = 404; throw e }
    const adapter = adapters.get(row.service_key)
    if (!adapter) { const e = new Error('unknown service'); e.status = 422; throw e }
    inflight.add(cookieId)
    await acquire()
    const proxy = proxyFor(row.service_key)
    const start = Date.now()
    try {
      const cookies = decryptJSON(row.content_enc)
      const cookieHeader = toHeaderString(cookies)
      const dispatcher = buildDispatcher(proxy)
      const boundFetch = async (url, init = {}) => {
        const wait = lastReq.get(row.service_key) + SERVICE_GAP_MS - Date.now()
        if (wait > 0) await sleep(wait)
        lastReq.set(row.service_key, Date.now())
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
        try {
          return await undiciFetch(url, { ...init, dispatcher, signal: ctrl.signal, headers: { 'user-agent': UA, ...(init.headers || {}) } })
        } finally { clearTimeout(t) }
      }
      const result = await adapter.check({ cookieHeader, cookies, fetch: boundFetch, log: () => {} })
      const status = result.status === 'live' ? 'live' : 'die'
      const now = Date.now()
      if (status === 'live') {
        db.prepare('UPDATE cookies SET status=?, account_info=COALESCE(?, account_info), last_checked_at=?, updated_at=? WHERE id=?')
          .run(status, result.accountInfo ? JSON.stringify(result.accountInfo) : null, now, now, cookieId)
      } else {
        db.prepare('UPDATE cookies SET status=?, last_checked_at=?, updated_at=? WHERE id=?')
          .run(status, now, now, cookieId)
      }
      log(cookieId, status, result.reason || '', result.accountInfo || null, proxy, Date.now() - start)
      return status
    } catch (e) {
      log(cookieId, 'error', e.message, null, proxy, Date.now() - start)
      return 'error'
    } finally {
      releaseSlot()
      inflight.delete(cookieId)
    }
  }

  const log = (cookieId, status, reason, detail, proxy, duration) =>
    db.prepare('INSERT INTO check_logs(cookie_id,status,reason,detail,proxy_used,duration_ms,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(cookieId, status, reason, detail ? JSON.stringify(detail) : null, proxy, duration, Date.now())

  // simple semaphore
  let active = 0
  const waiting = []
  const acquire = () => {
    if (active < CONCURRENCY) { active++; return Promise.resolve() }
    return new Promise(r => waiting.push(r)).then(() => {})
  }
  const releaseSlot = () => {
    if (waiting.length) waiting.shift()()
    else active--
  }

  function startCheckAll(serviceKey) {
    if (job.running) { const e = new Error('check-all already running'); e.status = 409; throw e }
    let sql = 'SELECT c.id, c.service_key FROM cookies c LEFT JOIN service_settings s ON s.service_key = c.service_key WHERE COALESCE(s.disabled, 0) = 0'
    const params = []
    if (serviceKey) { sql += ' AND c.service_key = ?'; params.push(serviceKey) }
    const rows = db.prepare(sql).all(...params)
    job.running = true; job.pending = rows.length; job.done = 0; job.failed = 0
    ;(async () => {
      await Promise.all(rows.map(async r => {
        const st = await runCheck(r.id)
        job.pending--
        if (st === 'error') job.failed++; else job.done++
      }))
      job.running = false
    })()
    return { queued: rows.length }
  }

  const jobStatus = () => ({ ...job })

  return { runCheck, startCheckAll, jobStatus, buildDispatcher, proxyFor }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -w server`
Expected: PASS (engine suite).

- [ ] **Step 5: Commit**

```bash
git add server/src/engine.js server/test/engine.test.js
git commit -m "feat(server): check engine with queue/throttle/proxy + check-all job"
```

---

### Task 8: Cookies / services / settings routes (replace stubs)

**Files:**
- Modify: `server/src/routes/cookies.js` (replace stub), `server/src/routes/services.js` (replace stub), `server/src/routes/settings.js` (replace stub)
- Create: `server/test/api.test.js`

**Interfaces:**
- Consumes: `buildApp` (Task 5), `createEngine` (Task 7), adapters (Task 6), cookieFormat (Task 4)
- Produces (all behind auth+csrf from Task 5; error shape `{"error":{code,message}}`):
  - `GET /api/cookies?service=&status=&q=&page=` → `{items: [{id, service_key, label, source_format, status, account_info(parsed|null), last_checked_at, notes, created_at, updated_at}], total, page}` — never includes cookie content
  - `POST /api/cookies {service, content, label?, notes?}` → `{created: [publicRows], failed: [{index, error}]}`; validates service exists, chunk size/count limits; unknown service → 400 `unknown_service`
  - `PATCH /api/cookies/:id {label?, notes?, service?}` → public row (service must exist in adapters); `DELETE /api/cookies/:id` → `{ok:true}`
  - `GET /api/cookies/:id/export?format=header|netscape` → `{content}` (decrypt + convert)
  - `GET /api/cookies/:id/logs?limit=50` → `{items: [...check_logs rows newest-first]}`
  - `POST /api/cookies/:id/check` → engine.runCheck result `{status}`; 409/404/422 propagated
  - `POST /api/cookies/check-all {service?}` → `{queued}`; `GET /api/cookies/check-all` → jobStatus
  - `GET /api/services` → `[{key, name, disabled, cookieCount}]` from adapters + LEFT JOIN counts
  - `PATCH /api/services/:key {proxy?: string|null, disabled?: boolean}` → upsert `service_settings`; unknown key → 400
  - `GET /api/settings` → `{autoCheckEnabled, autoCheckIntervalHours, proxyGlobal}` (defaults `false`, `6`, `null`)
  - `PUT /api/settings` same fields optional; interval must be int 1–168; proxy must be `http(s)://` or `socks5(h)://` URL; calls `scheduler.reschedule()`; returns new state
  - `POST /api/settings/password {currentPassword, newPassword}` → verifies current (401 `bad_credentials`), sets new, keeps session

- [ ] **Step 1: Write failing tests** (`server/test/api.test.js`)

```js
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { openDb } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createEngine } from '../src/engine.js'
import { initEncryption, generateKeyB64 } from '../src/crypto.js'

const NET = '.netflix.com\tTRUE\t/\tTRUE\t1790000000\tNetflixId\tv-2'
const HDR = 'NetflixId=v-2; SecureSessionId=x'
const adapter = { key: 'netflix', name: 'Netflix', defaultDomain: '.netflix.com', check: async () => ({ status: 'live', reason: 'ok' }) }

let ctx
const build = () => {
  const db = openDb()
  const adapters = new Map([['netflix', adapter]])
  const engine = createEngine({ db, adapters })
  ctx = { app: buildApp({ db, adapters, engine, scheduler: { reschedule: () => {} } }), db, adapters, engine }
  return ctx
}

const login = async () => {
  build()
  const agent = request.agent(ctx.app)
  await agent.post('/api/auth/setup').send({ password: 'hunter2hunter2' })
  return agent
}

describe('cookies api', () => {
  let agent
  beforeEach(async () => { agent = await login() })

  it('imports single netscape + header with detection', async () => {
    const a1 = await agent.post('/api/cookies').send({ service: 'netflix', content: NET, label: 'NF1' }).expect(200)
    expect(a1.body.created).toHaveLength(1)
    expect(a1.body.created[0].source_format).toBe('netscape')
    const a2 = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR }).expect(200)
    expect(a2.body.created[0].source_format).toBe('header')
  })
  it('bulk import: mixed valid + invalid chunks reported separately', async () => {
    const res = await agent.post('/api/cookies').send({ service: 'netflix', content: `${NET}\n\nnot a cookie` }).expect(200)
    expect(res.body.created).toHaveLength(1)
    expect(res.body.failed).toEqual([{ index: 1, error: expect.stringContaining('format') }])
  })
  it('unknown service → 400', async () => {
    await agent.post('/api/cookies').send({ service: 'nope', content: HDR }).expect(400)
  })
  it('list hides content, filters by service+status', async () => {
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const list = await agent.get('/api/cookies').expect(200)
    expect(list.body.total).toBe(1)
    expect(list.body.items[0]).not.toHaveProperty('content_enc')
    expect((await agent.get('/api/cookies?status=live')).body.total).toBe(0)
  })
  it('export header + netscape round-trip', async () => {
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const h = await agent.get(`/api/cookies/${created[0].id}/export?format=header`).expect(200)
    expect(h.body.content).toBe(HDR)
    const n = await agent.get(`/api/cookies/${created[0].id}/export?format=netscape`).expect(200)
    expect(n.body.content).toContain('.netflix.com\t')
  })
  it('check runs engine and updates status; logs endpoint returns history', async () => {
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const chk = await agent.post(`/api/cookies/${created[0].id}/check`).expect(200)
    expect(chk.body.status).toBe('live')
    const logs = await agent.get(`/api/cookies/${created[0].id}/logs`).expect(200)
    expect(logs.body.items[0]).toMatchObject({ status: 'live', reason: 'ok' })
  })
  it('check-all POST + GET status', async () => {
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const start = await agent.post('/api/cookies/check-all').send({}).expect(200)
    expect(start.body.queued).toBeGreaterThanOrEqual(1)
    const st = await agent.get('/api/cookies/check-all').expect(200)
    expect(st.body).toHaveProperty('running')
  })
  it('PATCH label, DELETE removes', async () => {
    const { body: { created } } = await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    await agent.patch(`/api/cookies/${created[0].id}`).send({ label: 'renamed' }).expect(200)
    await agent.delete(`/api/cookies/${created[0].id}`).expect(200)
    expect((await agent.get('/api/cookies')).body.total).toBe(0)
  })
})

describe('services + settings api', () => {
  let agent
  beforeEach(async () => { agent = await login() })
  it('lists services with counts; patch proxy/disabled', async () => {
    await agent.post('/api/cookies').send({ service: 'netflix', content: HDR })
    const list = await agent.get('/api/services').expect(200)
    expect(list.body).toEqual([{ key: 'netflix', name: 'Netflix', disabled: 0, cookieCount: 1 }])
    await agent.patch('/api/services/netflix').send({ proxy: 'http://127.0.0.1:8080', disabled: true }).expect(200)
    const after = await agent.get('/api/services').expect(200)
    expect(after.body[0]).toMatchObject({ disabled: 1, cookieCount: 1 })
    const row = await agent.get('/api/cookies/check-all').expect(200) // disabled excluded is engine-level; route must accept GET
    expect(row.body).toHaveProperty('running')
  })
  it('settings get/put with validation', async () => {
    const s0 = await agent.get('/api/settings').expect(200)
    expect(s0.body).toEqual({ autoCheckEnabled: false, autoCheckIntervalHours: 6, proxyGlobal: null })
    await agent.put('/api/settings').send({ autoCheckEnabled: true, autoCheckIntervalHours: 12, proxyGlobal: 'socks5://127.0.0.1:1080' }).expect(200)
    expect((await agent.get('/api/settings')).body.autoCheckIntervalHours).toBe(12)
    await agent.put('/api/settings').send({ autoCheckIntervalHours: 500 }).expect(400)
    await agent.put('/api/settings').send({ proxyGlobal: 'ftp://x' }).expect(400)
  })
  it('password change verifies current', async () => {
    await agent.post('/api/settings/password').send({ currentPassword: 'wrong12345', newPassword: 'newpass12345' }).expect(401)
    const agent2 = request.agent(ctx.app)
    await agent2.post('/api/auth/login').send({ password: 'newpass12345' }).expect(200)
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w server`
Expected: FAIL — 501 from stub routes

- [ ] **Step 3: Implement** `server/src/routes/cookies.js`

```js
import { Router } from 'express'
import { encryptJSON, decryptJSON } from '../crypto.js'
import { splitBulk, detectFormat, parseNetscape, parseHeader, toHeaderString, toNetscape, MAX_CHUNK_BYTES, MAX_CHUNKS } from '../cookieFormat.js'

const err = (res, code, message, status) => res.status(status).json({ error: { code, message } })
const PUBLIC_COLS = 'id, service_key, label, source_format, status, account_info, last_checked_at, notes, created_at, updated_at'

export function cookieRoutes({ db, engine, adapters }) {
  const r = Router()

  r.get('/', (req, res) => {
    const { service, status, q, page: p } = req.query
    const where = []; const params = []
    if (service) { where.push('service_key = ?'); params.push(service) }
    if (status) { where.push('status = ?'); params.push(status) }
    if (q) { where.push('(label LIKE ? OR notes LIKE ? OR account_info LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM cookies ${clause}`).get(...params).c
    const page = Math.max(1, Number(p) || 1); const limit = 50
    const items = db.prepare(`SELECT ${PUBLIC_COLS} FROM cookies ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, (page - 1) * limit)
      .map(row => ({ ...row, account_info: row.account_info ? JSON.parse(row.account_info) : null }))
    res.json({ items, total, page })
  })

  r.post('/', (req, res) => {
    const { service, content, label = '', notes = '' } = req.body || {}
    const adapter = adapters.get(service)
    if (!service || !adapter) return err(res, 'unknown_service', `unknown service: ${service}`, 400)
    if (typeof content !== 'string' || !content.trim()) return err(res, 'invalid_content', 'content is required', 400)
    const chunks = splitBulk(content)
    if (chunks.length > MAX_CHUNKS) return err(res, 'too_many', `max ${MAX_CHUNKS} chunks per import`, 400)
    const created = []; const failed = []
    const now = Date.now()
    const insert = db.prepare(`INSERT INTO cookies(service_key,label,content_enc,source_format,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      try {
        if (Buffer.byteLength(chunk) > MAX_CHUNK_BYTES) throw new Error('chunk exceeds 100KB')
        const format = detectFormat(chunk)
        if (!format) throw new Error('unrecognized cookie format')
        const cookies = format === 'netscape' ? parseNetscape(chunk, adapter.defaultDomain) : parseHeader(chunk, adapter.defaultDomain)
        const info = insert.run(service, label, encryptJSON(cookies), format, notes, now, now)
        created.push({ id: Number(info.lastInsertRowid), service_key: service, label, source_format: format, status: 'unknown', notes, created_at: now, updated_at: now })
      } catch (e) { failed.push({ index: i, error: e.message }) }
    }
    res.json({ created, failed })
  })

  r.patch('/:id', (req, res) => {
    const { label, notes, service } = req.body || {}
    const row = db.prepare('SELECT id FROM cookies WHERE id=?').get(req.params.id)
    if (!row) return err(res, 'not_found', 'cookie not found', 404)
    if (service !== undefined && !adapters.has(service)) return err(res, 'unknown_service', `unknown service: ${service}`, 400)
    db.prepare('UPDATE cookies SET label=COALESCE(?, label), notes=COALESCE(?, notes), service_key=COALESCE(?, service_key), updated_at=? WHERE id=?')
      .run(label ?? null, notes ?? null, service ?? null, Date.now(), row.id)
    const updated = db.prepare(`SELECT ${PUBLIC_COLS} FROM cookies WHERE id=?`).get(row.id)
    updated.account_info = updated.account_info ? JSON.parse(updated.account_info) : null
    res.json(updated)
  })

  r.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM cookies WHERE id=?').run(req.params.id)
    res.json({ ok: true })
  })

  r.get('/:id/export', (req, res) => {
    const row = db.prepare('SELECT * FROM cookies WHERE id=?').get(req.params.id)
    if (!row) return err(res, 'not_found', 'cookie not found', 404)
    const format = req.query.format === 'netscape' ? 'netscape' : 'header'
    const cookies = decryptJSON(row.content_enc)
    res.json({ content: format === 'netscape' ? toNetscape(cookies) : toHeaderString(cookies) })
  })

  r.get('/:id/logs', (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50)
    const items = db.prepare('SELECT * FROM check_logs WHERE cookie_id=? ORDER BY id DESC LIMIT ?').all(req.params.id, limit)
    res.json({ items })
  })

  r.post('/:id/check', async (req, res) => {
    try {
      const status = await engine.runCheck(Number(req.params.id))
      res.json({ status })
    } catch (e) { err(res, e.code || 'check_failed', e.message, e.status || 500) }
  })

  r.post('/check-all', (req, res) => {
    try {
      res.json(engine.startCheckAll(req.body?.service || undefined))
    } catch (e) { err(res, e.code || 'check_failed', e.message, e.status || 500) }
  })

  r.get('/check-all', (req, res) => res.json(engine.jobStatus()))

  return r
}
```

Update the call site in `server/src/app.js` (Task 5 stub): `app.use('/api/cookies', cookieRoutes({ db, engine, adapters }))`.


`server/src/routes/services.js`:

```js
import { Router } from 'express'
const err = (res, code, message, status) => res.status(status).json({ error: { code, message } })

export function serviceRoutes({ db, adapters }) {
  const r = Router()
  r.get('/', (req, res) => {
    const counts = db.prepare('SELECT service_key, COUNT(*) c FROM cookies GROUP BY service_key').all()
    const countMap = new Map(counts.map(x => [x.service_key, x.c]))
    const settings = db.prepare('SELECT service_key, disabled FROM service_settings').all()
    const disabledMap = new Map(settings.map(x => [x.service_key, x.disabled]))
    res.json([...adapters.values()].map(a => ({
      key: a.key, name: a.name, disabled: disabledMap.get(a.key) ?? 0, cookieCount: countMap.get(a.key) ?? 0
    })))
  })
  r.patch('/:key', (req, res) => {
    const { proxy, disabled } = req.body || {}
    if (!adapters.has(req.params.key)) return err(res, 'unknown_service', 'unknown service', 400)
    if (proxy !== undefined && proxy !== null && typeof proxy !== 'string') return err(res, 'invalid_proxy', 'proxy must be string or null', 400)
    if (disabled !== undefined && typeof disabled !== 'boolean') return err(res, 'invalid_disabled', 'disabled must be boolean', 400)
    const current = db.prepare('SELECT proxy, disabled FROM service_settings WHERE service_key=?').get(req.params.key) || { proxy: null, disabled: 0 }
    const next = {
      proxy: proxy === undefined ? current.proxy : (proxy && proxy.trim() ? proxy.trim() : null),
      disabled: disabled === undefined ? current.disabled : (disabled ? 1 : 0)
    }
    db.prepare('INSERT INTO service_settings(service_key, proxy, disabled) VALUES(?,?,?) ON CONFLICT(service_key) DO UPDATE SET proxy=excluded.proxy, disabled=excluded.disabled')
      .run(req.params.key, next.proxy, next.disabled)
    res.json({ ok: true })
  })
  return r
}
```

`server/src/routes/settings.js`:

```js
import { Router } from 'express'
import { hash, verify } from '@node-rs/argon2'
import { getSetting, setSetting } from '../db.js'
const err = (res, code, message, status) => res.status(status).json({ error: { code, message } })
const PROXY_RE = /^(https?|socks5h?):\/\/.+/


export function settingsRoutes({ db, scheduler }) {
  const r = Router()
  const read = () => ({
    autoCheckEnabled: getSetting(db, 'auto_check_enabled') === 'true',
    autoCheckIntervalHours: Number(getSetting(db, 'auto_check_interval_hours')) || 6,
    proxyGlobal: getSetting(db, 'proxy_global') || null
  })

  r.get('/', (req, res) => res.json(read()))

  r.put('/', (req, res) => {
    const b = req.body || {}
    if (b.autoCheckIntervalHours !== undefined) {
      const h = Number(b.autoCheckIntervalHours)
      if (!Number.isInteger(h) || h < 1 || h > 168) return err(res, 'invalid_interval', 'interval must be integer 1-168 hours', 400)
    }
    if (b.proxyGlobal !== undefined && b.proxyGlobal !== null && !PROXY_RE.test(b.proxyGlobal)) {
      return err(res, 'invalid_proxy', 'proxy must be http(s):// or socks5(h):// URL', 400)
    }
    if (b.autoCheckEnabled !== undefined) setSetting(db, 'auto_check_enabled', !!b.autoCheckEnabled)
    if (b.autoCheckIntervalHours !== undefined) setSetting(db, 'auto_check_interval_hours', Number(b.autoCheckIntervalHours))
    if (b.proxyGlobal !== undefined) setSetting(db, 'proxy_global', b.proxyGlobal === null ? '' : String(b.proxyGlobal))
    scheduler?.reschedule?.()
    res.json(read())
  })

  r.post('/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body || {}
    const stored = getSetting(db, 'password_hash')
    if (!stored || typeof currentPassword !== 'string' || !(await verify(stored, currentPassword))) {
      return err(res, 'bad_credentials', 'current password incorrect', 401)
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return err(res, 'invalid_password', 'new password must be 8-128 chars', 400)
    }
    setSetting(db, 'password_hash', await hash(newPassword))
    res.json({ ok: true })
  })
  return r
}
```

Note: `proxyGlobal: null` is stored as empty string `''`; `read()` maps `''` → `null`. `PUT` with `proxyGlobal: null` clears it.

- [ ] **Step 4: Run, verify pass**

Run: `npm test -w server`
Expected: PASS (all suites). If the `check-all POST + GET status` test is flaky because the fake adapter resolves instantly, assert `typeof st.body.running === 'boolean'` instead of a specific value.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes server/test/api.test.js server/src/app.js
git commit -m "feat(server): cookies/services/settings routes with bulk import + export + checks"
```

---

### Task 9: Scheduler + server entry (index.js)

**Files:**
- Create: `server/src/scheduler.js`, `server/src/index.js`, `server/test/scheduler.test.js`

**Interfaces:**
- Consumes: `createEngine` (Task 7), `loadAdapters` (Task 6), `readEnv` (Task 2), `openDb` (Task 3)
- Produces:
  - `hoursToPattern(h)` → cron string (`24` → `'0 0 * * *'`, else `'0 */h * * *'`)
  - `createScheduler({ db, getSetting: gs, startCheckAll })` → `{ reschedule() }` — stops previous task, no-op when disabled, cron-schedules `startCheckAll()`
  - `index.js` boot sequence: read `.env` → ensure `ENCRYPTION_KEY` (generate + append to `.env` + console warn) → `initEncryption` → `openDb('data/cookiehub.db')` (mkdir `data/`) → `loadAdapters()` → engine → scheduler.reschedule() → `buildApp` → serve `client/dist` static + SPA fallback (skip paths starting `/api`) → listen on `PORT` (default 3000)

- [ ] **Step 1: Write failing tests** (`server/test/scheduler.test.js`)

```js
import { describe, it, expect } from 'vitest'
import { hoursToPattern } from '../src/scheduler.js'

describe('hoursToPattern', () => {
  it('24h → daily midnight', () => expect(hoursToPattern(24)).toBe('0 0 * * *'))
  it('6h → every 6 hours', () => expect(hoursToPattern(6)).toBe('0 */6 * * *'))
  it('clamps weird input at call sites (pattern still valid cron)', () => {
    expect(hoursToPattern(1)).toBe('0 */1 * * *')
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w server`
Expected: FAIL — cannot resolve scheduler

- [ ] **Step 3: Implement** `server/src/scheduler.js`

```js
import cron from 'node-cron'

export function hoursToPattern(h) {
  return h === 24 ? '0 0 * * *' : `0 */${h} * * *`
}

export function createScheduler({ getSetting, startCheckAll }) {
  let task = null
  return {
    reschedule() {
      if (task) { task.stop(); task = null }
      if (getSetting('auto_check_enabled') !== 'true') return
      const h = Math.min(168, Math.max(1, Number(getSetting('auto_check_interval_hours')) || 6))
      task = cron.schedule(hoursToPattern(h), () => { try { startCheckAll() } catch { /* already running */ } })
    }
  }
}
```

`server/src/index.js`:

```js
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { readEnv } from './env.js'
import { initEncryption, generateKeyB64 } from './crypto.js'
import { openDb, getSetting } from './db.js'
import { loadAdapters } from './adapters/index.js'
import { createEngine } from './engine.js'
import { createScheduler } from './scheduler.js'
import { buildApp } from './app.js'

const env = readEnv('.env')
if (!env.ENCRYPTION_KEY) {
  const key = generateKeyB64()
  fs.appendFileSync('.env', `${fs.existsSync('.env') ? '\n' : ''}ENCRYPTION_KEY=${key}\n`)
  console.warn('[cookiehub] generated ENCRYPTION_KEY and wrote it to .env — keep this file safe')
  env.ENCRYPTION_KEY = key
}
initEncryption(env.ENCRYPTION_KEY)

fs.mkdirSync('data', { recursive: true })
const db = openDb('data/cookiehub.db')
const adapters = await loadAdapters()
const engine = createEngine({ db, adapters })
const scheduler = createScheduler({ getSetting: k => getSetting(db, k), startCheckAll: () => engine.startCheckAll() })
scheduler.reschedule()

const app = buildApp({ db, adapters, engine, scheduler })

const dist = path.resolve('../client/dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')))
}

const port = Number(env.PORT) || 3000
app.listen(port, () => console.log(`[cookiehub] listening on :${port}`))
```

Note: `index.js` is executed with cwd `server/` (`npm start -w server` sets cwd to the workspace dir), so `.env`, `data/`, and `../client/dist` resolve correctly.

- [ ] **Step 4: Run tests + boot smoke**

Run: `npm test -w server`
Expected: PASS.

Run (separate terminal, from repo root): `npm run build && npm start`, then `curl http://localhost:3000/api/auth/session`
Expected: `{"authenticated":false,"needsSetup":true}`; `server/data/cookiehub.db` and `.env` with `ENCRYPTION_KEY` created. Stop the server after.

- [ ] **Step 5: Commit**

```bash
git add server/src/scheduler.js server/src/index.js server/test/scheduler.test.js
git commit -m "feat(server): cron scheduler + boot entry with static serving"
```

---

### Task 10: Client — api wrapper + Login page

**Files:**
- Create: `client/src/api.js`, `client/src/pages/Login.jsx`
- Modify: `client/src/App.jsx`

**Interfaces:**
- Consumes: API from Tasks 5–8
- Produces:
  - `api(path, { method, body })` → parsed JSON; sends `content-type: application/json` + `x-requested-with: XMLHttpRequest`; on 401 (outside /login) redirects to `/login`; throws `Error(message)` with server `error.message`
  - `/login` route: if `needsSetup` shows setup form (password + confirm), else login form; on success navigate to `/`
  - `App.jsx`: routes `/login`, `/` (Dashboard), `/settings` (Settings) — Dashboard/Settings imported lazily in Tasks 11–12; for now `/` and `/settings` render a placeholder `<div>coming soon</div>`

- [ ] **Step 1: api wrapper** (`client/src/api.js`)

```js
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = '/login'
    throw new Error('unauthenticated')
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`)
  return json
}
```

- [ ] **Step 2: Login page** (`client/src/pages/Login.jsx`)

```jsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'

export default function Login() {
  const [session, setSession] = useState(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()

  useEffect(() => { api('/auth/session').then(setSession).catch(e => setError(e.message)) }, [])

  const submit = async e => {
    e.preventDefault(); setError('')
    if (!session) return
    if (session.needsSetup && pw !== pw2) return setError('passwords do not match')
    setBusy(true)
    try {
      await api(`/auth/${session.needsSetup ? 'setup' : 'login'}`, { method: 'POST', body: { password: pw } })
      nav('/')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  if (!session) return <div className="min-h-screen grid place-items-center text-slate-400">loading…</div>
  return (
    <div className="min-h-screen grid place-items-center">
      <form onSubmit={submit} className="w-80 space-y-4 bg-slate-800 p-8 rounded-xl shadow-lg">
        <h1 className="text-2xl font-bold text-center">CookieHub</h1>
        <p className="text-sm text-slate-400 text-center">{session.needsSetup ? 'First run — create your password' : 'Sign in'}</p>
        <input type="password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)}
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 focus:outline-none focus:border-sky-500" required minLength={8} />
        {session.needsSetup && (
          <input type="password" placeholder="Confirm password" value={pw2} onChange={e => setPw2(e.target.value)}
            className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 focus:outline-none focus:border-sky-500" required minLength={8} />
        )}
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button disabled={busy} className="w-full rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-50 py-2 font-semibold">
          {busy ? '…' : session.needsSetup ? 'Create password' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
```

- [ ] **Step 3: App routes** (`client/src/App.jsx`)

```jsx
import { Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<div className="p-8">dashboard coming soon</div>} />
      <Route path="/settings" element={<div className="p-8">settings coming soon</div>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
```

- [ ] **Step 4: Build + manual smoke**

Run: `npm run build && npm start` (root), open `http://localhost:3000/login`
Expected: setup form on first run; create password → redirects to `/` placeholder; reload → login form; wrong password shows error; correct password enters.

- [ ] **Step 5: Commit**

```bash
git add client/src
git commit -m "feat(client): api wrapper + login/setup page + routes"
```

---

### Task 11: Client — Dashboard

**Files:**
- Create: `client/src/pages/Dashboard.jsx`
- Modify: `client/src/App.jsx` (import Dashboard for `/`)

**Interfaces:**
- Consumes: `api` (Task 10); endpoints `GET/POST/PATCH/DELETE /api/cookies`, `POST /api/cookies/:id/check`, `POST|GET /api/cookies/check-all`, `GET /api/cookies/:id/export`, `GET /api/cookies/:id/logs`, `GET /api/services`
- Produces: full cookie management UI per spec §7: table with label/service/status badge/account info/last checked + row actions (Check, Copy header, Copy Netscape, Edit label/notes, Delete), toolbar (search input, service filter, status filter, Add button, Check All button with progress), Add modal with bulk paste + per-item result, detail drawer with check history, 2s polling while check-all job runs

Deviation from spec §7 (documented, reviewable): the Add modal shows per-item detected format/import results AFTER submit instead of a pre-import chunk preview — the server is the single source of truth for format detection; duplicating detection client-side would drift.

- [ ] **Step 1: Dashboard component** (`client/src/pages/Dashboard.jsx`)

```jsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

const STATUS_STYLE = { live: 'bg-emerald-600', die: 'bg-red-600', unknown: 'bg-slate-600' }

export default function Dashboard() {
  const [items, setItems] = useState([])
  const [services, setServices] = useState([])
  const [fService, setFService] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [q, setQ] = useState('')
  const [job, setJob] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [toast, setToast] = useState('')
  const pollRef = useRef(null)
  const showToast = msg => { setToast(msg); setTimeout(() => setToast(''), 2500) }

  const load = useCallback(async () => {
    const p = new URLSearchParams()
    if (fService) p.set('service', fService)
    if (fStatus) p.set('status', fStatus)
    if (q) p.set('q', q)
    const list = await api(`/cookies?${p}`)
    setItems(list.items)
  }, [fService, fStatus, q])

  useEffect(() => { load().catch(e => showToast(e.message)) }, [load])
  useEffect(() => { api('/services').then(setServices).catch(() => {}) }, [])

  useEffect(() => {
    if (!job?.running) { clearInterval(pollRef.current); return }
    pollRef.current = setInterval(async () => {
      const st = await api('/cookies/check-all')
      setJob(st)
      if (!st.running) { load().catch(() => {}); showToast(`Check all done: ${st.done} ok, ${st.failed} failed`) }
    }, 2000)
    return () => clearInterval(pollRef.current)
  }, [job?.running, load])

  const checkOne = async id => {
    try { const r = await api(`/cookies/${id}/check`, { method: 'POST' }); showToast(`check: ${r.status}`); await load() }
    catch (e) { showToast(e.message) }
  }
  const checkAll = async () => {
    try { const r = await api('/cookies/check-all', { method: 'POST', body: fService ? { service: fService } : {} }); setJob({ running: true, ...r }) }
    catch (e) { showToast(e.message) }
  }
  const copy = async (id, format) => {
    try {
      const { content } = await api(`/cookies/${id}/export?format=${format}`)
      await navigator.clipboard.writeText(content)
      showToast(`copied as ${format}`)
    } catch (e) { showToast(e.message) }
  }
  const remove = async id => {
    if (!confirm('Delete this cookie?')) return
    await api(`/cookies/${id}`, { method: 'DELETE' }).catch(e => showToast(e.message))
    load().catch(() => {})
  }
  const saveEdit = async (id, body) => {
    await api(`/cookies/${id}`, { method: 'PATCH', body }).catch(e => showToast(e.message))
    setDetail(null); load().catch(() => {})
  }

  return (
    <div className="min-h-screen p-6 space-y-4">
      <header className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold mr-auto">CookieHub</h1>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search label/notes…"
          className="rounded bg-slate-800 border border-slate-700 px-3 py-1.5" />
        <select value={fService} onChange={e => setFService(e.target.value)} className="rounded bg-slate-800 border border-slate-700 px-3 py-1.5">
          <option value="">all services</option>
          {services.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <select value={fStatus} onChange={e => setFStatus(e.target.value)} className="rounded bg-slate-800 border border-slate-700 px-3 py-1.5">
          <option value="">all status</option>
          <option value="live">live</option><option value="die">die</option><option value="unknown">unknown</option>
        </select>
        <button onClick={() => setAddOpen(true)} className="rounded bg-sky-600 hover:bg-sky-500 px-4 py-1.5 font-semibold">+ Add</button>
        <button onClick={checkAll} className="rounded bg-violet-600 hover:bg-violet-500 px-4 py-1.5 font-semibold">
          {job?.running ? `Checking… (${job.done + job.failed}/${job.done + job.failed + job.pending})` : 'Check All'}
        </button>
        <a href="/settings" className="text-slate-400 hover:text-slate-200 text-sm underline">settings</a>
      </header>

      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-slate-400 text-left">
            <tr><th className="p-3">Label</th><th className="p-3">Service</th><th className="p-3">Status</th><th className="p-3">Account</th><th className="p-3">Checked</th><th className="p-3">Actions</th></tr>
          </thead>
          <tbody>
            {items.map(c => (
              <tr key={c.id} className="border-t border-slate-800 hover:bg-slate-800/40">
                <td className="p-3 cursor-pointer" onClick={() => setDetail(c)}>{c.label || <span className="text-slate-500">#{c.id}</span>}</td>
                <td className="p-3">{c.service_key}</td>
                <td className="p-3"><span className={`${STATUS_STYLE[c.status]} text-white text-xs font-bold rounded px-2 py-0.5 uppercase`}>{c.status}</span></td>
                <td className="p-3 text-slate-300">
                  {c.account_info ? [c.account_info.email, c.account_info.plan, c.account_info.country, c.account_info.expiresAt].filter(Boolean).join(' · ') : '—'}
                </td>
                <td className="p-3 text-slate-400">{c.last_checked_at ? new Date(c.last_checked_at).toLocaleString() : 'never'}</td>
                <td className="p-3 space-x-1 whitespace-nowrap">
                  <button onClick={() => checkOne(c.id)} className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1">check</button>
                  <button onClick={() => copy(c.id, 'header')} className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1">copy hdr</button>
                  <button onClick={() => copy(c.id, 'netscape')} className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1">copy net</button>
                  <button onClick={() => remove(c.id)} className="rounded bg-red-900/60 hover:bg-red-800 px-2 py-1">del</button>
                </td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan="6" className="p-6 text-center text-slate-500">no cookies — add one</td></tr>}
          </tbody>
        </table>
      </div>

      {addOpen && <AddModal services={services} onClose={() => setAddOpen(false)} onDone={() => { setAddOpen(false); load() }} showToast={showToast} />}
      {detail && <DetailDrawer cookie={detail} onClose={() => setDetail(null)} onSave={saveEdit} showToast={showToast} />}
      {toast && <div className="fixed bottom-6 right-6 rounded bg-slate-700 px-4 py-2 shadow-lg">{toast}</div>}
    </div>
  )
}

function AddModal({ services, onClose, onDone, showToast }) {
  const [service, setService] = useState(services[0]?.key || '')
  const [label, setLabel] = useState('')
  const [content, setContent] = useState('')
  const [result, setResult] = useState(null)
  const submit = async e => {
    e.preventDefault()
    try {
      const r = await api('/cookies', { method: 'POST', body: { service, content, label } })
      setResult(r)
      showToast(`imported ${r.created.length}, failed ${r.failed.length}`)
      if (r.created.length && !r.failed.length) onDone()
    } catch (err) { showToast(err.message) }
  }
  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center p-4" onClick={onClose}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit} className="bg-slate-800 rounded-xl p-6 w-full max-w-2xl space-y-3">
        <h2 className="text-lg font-bold">Add cookies</h2>
        <div className="flex gap-3">
          <select value={service} onChange={e => setService(e.target.value)} className="rounded bg-slate-900 border border-slate-700 px-3 py-2">
            {services.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="label (optional)"
            className="flex-1 rounded bg-slate-900 border border-slate-700 px-3 py-2" />
        </div>
        <textarea value={content} onChange={e => setContent(e.target.value)} rows={10} required
          placeholder="Paste cookie (Netscape or header string). Bulk: separate cookies with a blank line."
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 font-mono text-xs" />
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="rounded bg-slate-700 px-4 py-2">close</button>
          <button className="rounded bg-sky-600 hover:bg-sky-500 px-4 py-2 font-semibold">import</button>
        </div>
        {result && (
          <div className="text-xs space-y-1 max-h-40 overflow-auto">
            {result.created.map(c => <div key={c.id} className="text-emerald-400">#{c.id} imported ({c.source_format})</div>)}
            {result.failed.map(f => <div key={f.index} className="text-red-400">chunk {f.index}: {f.error}</div>)}
          </div>
        )}
      </form>
    </div>
  )
}

function DetailDrawer({ cookie, onClose, onSave, showToast }) {
  const [label, setLabel] = useState(cookie.label)
  const [notes, setNotes] = useState(cookie.notes || '')
  const [logs, setLogs] = useState([])
  useEffect(() => { api(`/cookies/${cookie.id}/logs`).then(r => setLogs(r.items)).catch(() => {}) }, [cookie.id])
  return (
    <div className="fixed inset-0 bg-black/60 flex justify-end" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-slate-800 w-full max-w-md h-full p-6 space-y-4 overflow-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">#{cookie.id} · {cookie.service_key}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
        </div>
        <input value={label} onChange={e => setLabel(e.target.value)} className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2" />
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="notes"
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2" />
        <button onClick={() => onSave(cookie.id, { label, notes })} className="rounded bg-sky-600 px-4 py-2 font-semibold">save</button>
        <div>
          <h3 className="font-semibold mb-2 text-slate-400">Check history</h3>
          <div className="space-y-1 text-xs">
            {logs.map(l => (
              <div key={l.id} className="flex gap-2">
                <span className={l.status === 'live' ? 'text-emerald-400' : l.status === 'die' ? 'text-red-400' : 'text-amber-400'}>{l.status}</span>
                <span className="text-slate-500">{new Date(l.created_at).toLocaleString()}</span>
                <span className="text-slate-400 truncate">{l.reason}</span>
              </div>
            ))}
            {!logs.length && <p className="text-slate-500">never checked</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire route** — in `client/src/App.jsx` replace the `/` placeholder with `import Dashboard from './pages/Dashboard'` and `<Route path="/" element={<Dashboard />} />`.

- [ ] **Step 3: Build + browser smoke**

Run: `npm run build && npm start`, open `http://localhost:3000/`
Expected: login → dashboard with toolbar + empty table; Add modal imports a pasted dummy header cookie for netflix (`a=1; b=2` — engine check will fail gracefully with `error` log, which is correct behavior); row actions visible; label click opens drawer with history; copy buttons toast.

Verify in the browser that: import result lines appear, check on the dummy cookie adds an `error` log row (network to netflix.com from dev machine may work or fail — either way a log row must appear), delete works.

- [ ] **Step 4: Commit**

```bash
git add client/src
git commit -m "feat(client): dashboard with table/filters/bulk import/check-all/copy"
```

---

### Task 12: Client — Settings page

**Files:**
- Create: `client/src/pages/Settings.jsx`
- Modify: `client/src/App.jsx` (route `/settings`)

**Interfaces:**
- Consumes: `api`; `GET/PUT /api/settings`, `POST /api/settings/password`, `GET/PATCH /api/services`
- Produces: settings form (proxy global, auto-check enable + interval hours, change password) + per-service cards (name, cookie count, proxy override, disable toggle), with save feedback

- [ ] **Step 1: Settings page** (`client/src/pages/Settings.jsx`)

```jsx
import { useEffect, useState } from 'react'
import { api } from '../api'

export default function Settings() {
  const [s, setS] = useState(null)
  const [services, setServices] = useState([])
  const [msg, setMsg] = useState('')
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' })
  const flash = m => { setMsg(m); setTimeout(() => setMsg(''), 2500) }

  const reload = async () => {
    setS(await api('/settings'))
    setServices(await api('/services'))
  }
  useEffect(() => { reload().catch(e => flash(e.message)) }, [])

  const save = async e => {
    e.preventDefault()
    try { await api('/settings', { method: 'PUT', body: s }); flash('saved') }
    catch (err) { flash(err.message) }
  }
  const changePw = async e => {
    e.preventDefault()
    try { await api('/settings/password', { method: 'POST', body: pw }); setPw({ currentPassword: '', newPassword: '' }); flash('password changed') }
    catch (err) { flash(err.message) }
  }
  const patchService = async (key, body) => {
    try { await api(`/services/${key}`, { method: 'PATCH', body }); reload() }
    catch (err) { flash(err.message) }
  }

  if (!s) return <div className="p-8 text-slate-400">loading…</div>
  return (
    <div className="min-h-screen p-6 max-w-3xl space-y-8">
      <header className="flex items-center">
        <h1 className="text-2xl font-bold mr-auto">Settings</h1>
        <a href="/" className="text-slate-400 hover:text-slate-200 underline text-sm">← dashboard</a>
      </header>
      {msg && <div className="rounded bg-slate-700 px-4 py-2">{msg}</div>}

      <form onSubmit={save} className="bg-slate-800 rounded-xl p-6 space-y-4">
        <h2 className="font-bold">General</h2>
        <label className="block text-sm">
          Global proxy (http://, https://, socks5:// — empty = direct)
          <input value={s.proxyGlobal || ''} onChange={e => setS({ ...s, proxyGlobal: e.target.value || null })}
            placeholder="socks5://user:pass@1.2.3.4:1080"
            className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 font-mono text-xs" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.autoCheckEnabled} onChange={e => setS({ ...s, autoCheckEnabled: e.target.checked })} />
          Auto-check every
          <input type="number" min="1" max="168" value={s.autoCheckIntervalHours}
            onChange={e => setS({ ...s, autoCheckIntervalHours: Number(e.target.value) })}
            className="w-20 rounded bg-slate-900 border border-slate-700 px-2 py-1" />
          hours
        </label>
        <button className="rounded bg-sky-600 hover:bg-sky-500 px-4 py-2 font-semibold">save</button>
      </form>

      <div className="bg-slate-800 rounded-xl p-6 space-y-4">
        <h2 className="font-bold">Services</h2>
        {services.map(sv => (
          <div key={sv.key} className="flex flex-wrap items-center gap-3 border-t border-slate-700 pt-3 first:border-0 first:pt-0">
            <span className="font-semibold">{sv.name}</span>
            <span className="text-xs text-slate-400">{sv.cookieCount} cookies · {sv.disabled ? 'disabled' : 'enabled'}</span>
            <input placeholder={`proxy override for ${sv.key} (empty = global)`}
              defaultValue=""
              id={`proxy-${sv.key}`}
              className="flex-1 min-w-48 rounded bg-slate-900 border border-slate-700 px-3 py-1.5 font-mono text-xs" />
            <button onClick={() => patchService(sv.key, { proxy: document.getElementById(`proxy-${sv.key}`).value || null })}
              className="rounded bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-sm">set proxy</button>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" defaultChecked={!sv.disabled}
                onChange={e => patchService(sv.key, { disabled: !e.target.checked })} /> enabled
            </label>
          </div>
        ))}
      </div>

      <form onSubmit={changePw} className="bg-slate-800 rounded-xl p-6 space-y-4">
        <h2 className="font-bold">Change password</h2>
        <input type="password" placeholder="current password" value={pw.currentPassword}
          onChange={e => setPw({ ...pw, currentPassword: e.target.value })}
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2" required />
        <input type="password" placeholder="new password (8+ chars)" value={pw.newPassword} minLength={8}
          onChange={e => setPw({ ...pw, newPassword: e.target.value })}
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2" required />
        <button className="rounded bg-sky-600 hover:bg-sky-500 px-4 py-2 font-semibold">change</button>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Wire route** — `client/src/App.jsx`: `import Settings from './pages/Settings'`, `<Route path="/settings" element={<Settings />} />`.

- [ ] **Step 3: Build + browser smoke**

Run: `npm run build && npm start`; open `/settings`
Expected: save proxy `socks5://127.0.0.1:1080` → toast "saved", reload shows value; invalid proxy `ftp://x` → 400 error message shown; toggle service disable persists; password change flow works (verify by logging out/in with new password).

- [ ] **Step 4: Commit**

```bash
git add client/src
git commit -m "feat(client): settings page (proxy/scheduler/password/services)"
```

---

### Task 13: README + deploy artifacts + full verification

**Files:**
- Create: `README.md`, `deploy/Caddyfile`, `deploy/cookiehub.service`

**Interfaces:**
- Consumes: everything
- Produces: docs to run/deploy; final green build + test run

- [ ] **Step 1: README.md**

````markdown
# CookieHub

Personal single-user cookie manager (Netscape + header string) with live/die checks for Netflix, Spotify, and any service you add an adapter for. Not for public use.

## Features

- Import/export cookies as Netscape or header string (auto-detected, bulk import via blank-line separation)
- LIVE/DIE checks with account info (email, plan, expiry, country where available)
- Manual per-cookie / check-all + scheduled auto-check (cron)
- Per-service or global proxy support (http/https/socks5)
- Cookies encrypted at rest (AES-256-GCM); single-password login (argon2id); login rate limiting
- Add a service: drop an adapter file in `server/src/adapters/` and restart

## Requirements

- Node.js ≥ 20
- A reverse proxy with TLS (Caddy config in `deploy/`)

## Run

```bash
npm install
npm run build     # build client
npm start         # serves API + client on :3000
```

First run generates `.env` with `ENCRYPTION_KEY` (keep it safe — losing it loses all stored cookies) and asks you to create the admin password in the UI.

## Deploy (Linux VPS)

```bash
# systemd unit
sudo cp deploy/cookiehub.service /etc/systemd/system/
sudo systemctl enable --now cookiehub

# Caddy (automatic HTTPS)
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Point your domain in `deploy/Caddyfile` first.

## Dev

```bash
npm run dev       # server (watch manually) + vite dev server with /api proxy
npm test          # vitest suite
```

## Adding a service adapter

Create `server/src/adapters/<key>.js`:

```js
export default {
  key: 'example', name: 'Example', defaultDomain: '.example.com',
  async check({ cookieHeader, fetch, log }) {
    const res = await fetch('https://www.example.com/account', { redirect: 'manual' })
    if (res.status !== 200) return { status: 'die', reason: `HTTP ${res.status}` }
    return { status: 'live', reason: 'logged in' }
  }
}
```

Restart the server — the service appears in the UI automatically.
````

- [ ] **Step 2: deploy files**

`deploy/Caddyfile`:

```
cookiehub.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

`deploy/cookiehub.service`:

```
[Unit]
Description=CookieHub
After=network.target

[Service]
WorkingDirectory=/opt/cookiehub/server
ExecStart=/usr/bin/node src/index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Full verification**

Run from repo root: `npm test && npm run build && npm start &` then:
- `curl -s http://localhost:3000/api/auth/session` → `{"authenticated":false,"needsSetup":false}` (DB already initialized from earlier smokes; if fresh, `needsSetup:true`)
- Browser: login → dashboard renders with previously imported dummy cookie → settings page renders
- Stop server. Clean throwaway artifacts if any were created for testing (dummy cookie rows may be deleted via UI).

Expected: all tests pass, build succeeds, UI usable end-to-end.

- [ ] **Step 4: Commit**

```bash
git add README.md deploy
git commit -m "docs: readme + deploy artifacts"
```

---

## Real-service verification (post-deploy, manual)

The Netflix/Spotify adapters' extraction regexes are based on expected page shapes and MUST be verified against live responses: run one check with a real (preferably expendable) Netflix cookie and one Spotify cookie on the VPS, open the check log, and adjust the regexes in `server/src/adapters/*.js` if fields are missing. This is a verification step for the implementer with real credentials — not automatable in CI.
