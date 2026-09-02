# ExpressVPN Desktop Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Electron desktop app (workspace `desktop/`) managing ExpressVPN licenses: import/list/check/export/delete + one-click Connect, seeded from the existing 86-license vault.

**Architecture:** Electron main process (Node) imports `tools/expressvpn/xvpnChecker.js` directly; store (better-sqlite3), checkJob and connectManager are dependency-injected plain modules (testable without Electron); React renderer talks only through a contextBridge preload.

**Tech Stack:** Electron, React 18, Vite 5, Tailwind 3, better-sqlite3, vitest, electron-builder (NSIS + portable).

**Spec:** `docs/superpowers/specs/2026-09-02-xvpn-desktop-manager-design.md`

## Global Constraints

- Branch `feat/xvpn-desktop` from `master`; cookiehub/tools/docker untouched in behavior.
- `tools/expressvpn/xvpnChecker.js` stays the single source of checker logic — refactor only to export the login sequence; CLI (`check-licenses.mjs`) behavior unchanged.
- `license` string is the primary key of the licenses table.
- No password gate, no at-rest encryption.
- Check job and Connect are mutually exclusive (one ExpressVPN daemon).
- Vite dev port `5174` (client uses 5173).
- All new files under `desktop/` except: `xvpnChecker.js` refactor, `.gitignore` additions, README section.
- Commit after every task (conventional commits).

---

### Task 1: Workspace scaffold + Electron shell

**Files:**
- Create: `desktop/package.json`, `desktop/vite.config.js`, `desktop/tailwind.config.js`, `desktop/postcss.config.js`, `desktop/index.html`, `desktop/src/ui/main.jsx`, `desktop/src/ui/index.css`, `desktop/src/ui/App.jsx`, `desktop/src/main/index.js`, `desktop/src/preload.js`
- Modify: `package.json` (root, workspaces array), `.gitignore`
- Test: manual — electron window launches and renders

**Interfaces:**
- Consumes: nothing
- Produces: `desktop` npm workspace; `npm run dev -w desktop` launches Electron + Vite; `window.xvpn` bridge placeholder; preload exposes `on(channel, cb)` used by later UI tasks.

- [ ] **Step 1: Create branch**

```bash
git checkout -b feat/xvpn-desktop master
```

- [ ] **Step 2: Root package.json — add workspace**

In root `package.json`, change:

```json
  "workspaces": [
    "server",
    "client",
    "desktop"
  ],
```

- [ ] **Step 3: desktop/package.json**

```json
{
  "name": "xvpn-manager",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -k \"vite\" \"wait-on tcp:5174 && cross-env VITE_DEV=1 electron .\"",
    "build:ui": "vite build",
    "dist": "npm run build:ui && electron-builder",
    "test": "vitest run --passWithNoTests",
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  },
  "dependencies": {
    "better-sqlite3": "^12.10.0",
    "lucide-react": "^1.34.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@electron/rebuild": "^3.7.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "concurrently": "^9.0.0",
    "cross-env": "^7.0.3",
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "postcss": "^8.4.38",
    "tailwindcss": "^3.4.10",
    "vite": "^5.4.0",
    "vitest": "^2.0.5",
    "wait-on": "^8.0.0"
  }
}
```

- [ ] **Step 4: Config files**

`desktop/vite.config.js`:

```js
import react from '@vitejs/plugin-react'
export default {
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  build: { outDir: 'dist' },
}
```

`desktop/tailwind.config.js`:

```js
export default { content: ['./index.html', './src/ui/**/*.{js,jsx}'], theme: { extend: {} }, plugins: [] }
```

`desktop/postcss.config.js`:

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
```
`desktop/index.html`:

```html
<!doctype html>
<html lang="en">
<head><meta charset="UTF-8" /><title>XVPN Manager</title></head>
<body class="bg-slate-900"><div id="root"></div><script type="module" src="/src/ui/main.jsx"></script></body>
</html>
```

`desktop/src/ui/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`desktop/src/ui/main.jsx`:

```jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>)
```

`desktop/src/ui/App.jsx` (placeholder until Task 7):

```jsx
export default function App() {
  return <div className="min-h-screen bg-slate-900 text-slate-100 p-8">XVPN Manager — scaffold OK</div>
}
```

- [ ] **Step 5: Electron main + preload**

`desktop/src/main/index.js`:

```js
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.env.VITE_DEV) win.loadURL('http://127.0.0.1:5174')
  else win.loadFile(path.join(dirname, '../../dist/index.html'))
  return win
}

app.whenReady().then(() => {
  const win = createWindow()
  win.on('closed', () => {}) // window registry if needed later
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

`desktop/src/preload.js` (bridge; methods grow in later tasks — full set listed here once):

```js
import { contextBridge, ipcRenderer } from 'electron'

// subscribe helper: returns an unsubscribe function
const sub = (ch, cb) => {
  const fn = (_e, v) => cb(v)
  ipcRenderer.on(ch, fn)
  return () => ipcRenderer.removeListener(ch, fn)
}

contextBridge.exposeInMainWorld('xvpn', {
  ctlAvailable: () => ipcRenderer.invoke('ctl:available'),
  accountsList: () => ipcRenderer.invoke('accounts:list'),
  accountsImport: (text) => ipcRenderer.invoke('accounts:import', text),
  accountsDelete: (license) => ipcRenderer.invoke('accounts:delete', license),
  accountsExport: () => ipcRenderer.invoke('accounts:export'),
  checkStart: (filter) => ipcRenderer.invoke('check:start', filter),
  checkStatus: () => ipcRenderer.invoke('check:status'),
  checkCancel: () => ipcRenderer.invoke('check:cancel'),
  connectConnect: (license) => ipcRenderer.invoke('connect:connect', license),
  connectDisconnect: () => ipcRenderer.invoke('connect:disconnect'),
  connectStatus: () => ipcRenderer.invoke('connect:status'),
  onCheckProgress: (cb) => sub('check:progress', cb),
  onConnectState: (cb) => sub('connect:state', cb),
})
```

- [ ] **Step 6: .gitignore additions**

Append to `.gitignore`:

```
desktop/dist/
desktop/release/
```

- [ ] **Step 7: Install, verify dev + build**

```bash
npm install
npm run dev -w desktop
```

Expected: Electron window opens showing "XVPN Manager — scaffold OK" (live-reloading from Vite). Close it. Then:

```bash
npm run build:ui -w desktop
```

Expected: `desktop/dist/index.html` + hashed assets. Commit pending Task 1 files.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore desktop
git commit -m "feat(desktop): electron + vite workspace scaffold"
```

---

### Task 2: Store (SQLite CRUD + import/export)

**Files:**
- Create: `desktop/src/main/store.js`
- Test: `desktop/test/store.test.js`

**Interfaces:**
- Consumes: `parseAccountLine` from `tools/expressvpn/xvpnChecker.js`
- Produces: `openStore(file = ':memory:')` → `{ importText(text) → {imported, updated, lines}, list() → rows[], get(license) → row | undefined, remove(license) → boolean, exportLines() → string, selectLicenses(filter) → string[], applyResult(license, result) → void, count() → number }`. Row shape: `{ license, email, meta (JSON string), password, ovpn_user, ovpn_pass, pptp, state, live_days, live_expire, live_payment, detail, checked_at, created_at, updated_at }`.

- [ ] **Step 1: Write failing tests**

`desktop/test/store.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { openStore } from '../src/main/store.js'
import { parseAccountLine } from '../../tools/expressvpn/xvpnChecker.js'

const LINE = 'mn2927958@gmail.com:pa:ss@1 | OVPNUser=9frg | OVPNPass=bejp | Plan=1mo | Expire=2026-08-30 | Days=6 | AutoRenew=true | Payment=UNKNOWN | Gateway=UNKNOWN | Status=ACTIVE | License=EV5GA3G2E7GLIWTARBWWODF | PPTP=acdtk3/1l1y133g'
const LINE2 = LINE.replace('EV5GA3G2E7GLIWTARBWWODF', 'EXPIREDDD00000000000000A')

describe('store', () => {
  it('imports vault lines, skips junk, counts imported/updated/lines', () => {
    const s = openStore()
    const junk = 'JOIN FOR MORE : https://t.me/x\n——————\n'
    expect(s.importText(junk + LINE)).toEqual({ imported: 1, updated: 0, lines: 1 })
    expect(s.importText(LINE.replace('Days=6', 'Days=5'))).toEqual({ imported: 0, updated: 1, lines: 1 })
    expect(s.importText(`${LINE}\n${LINE}`)).toEqual({ imported: 0, updated: 1, lines: 1 }) // in-paste duplicate: first wins, single upsert
    expect(s.count()).toBe(1)
  })

  it('round-trips export through parseAccountLine with identical license set', () => {
    const s = openStore()
    s.importText(`${LINE}\n${LINE2}`)
    const out = s.exportLines()
    const parsed = out.split(/\r?\n/).filter(Boolean).map(parseAccountLine)
    expect(new Set(parsed.map(p => p.license))).toEqual(new Set(['EV5GA3G2E7GLIWTARBWWODF', 'EXPIREDDD00000000000000A']))
    expect(parsed[0].password).toBe('pa:ss@1')
    expect(parsed[0].extras.Plan).toBe('1mo')
    expect(parsed[0].extras.PPTP).toBe('acdtk3/1l1y133g')
  })

  it('lists sorted by state rank then live_days desc', () => {
    const s = openStore()
    s.importText(`${LINE}\n${LINE2}`)
    s.applyResult('EV5GA3G2E7GLIWTARBWWODF', { state: 'valid', detail: '', live: { daysRemaining: 10, expireIso: '2026-09-12', payment: 'card' } })
    s.applyResult('EXPIREDDD00000000000000A', { state: 'expired', detail: 'no days remaining', live: null })
    const rows = s.list()
    expect(rows.map(r => r.state)).toEqual(['valid', 'expired'])
    expect(rows[0].live_days).toBe(10)
    expect(rows[0].checked_at).toBeGreaterThan(0)
  })

  it('selectLicenses honors filter', () => {
    const s = openStore()
    s.importText(`${LINE}\n${LINE2}`)
    expect(s.selectLicenses('all')).toHaveLength(2)
    expect(s.selectLicenses('unknown')).toHaveLength(2)
    s.applyResult('EXPIREDDD00000000000000A', { state: 'valid', detail: '', live: null })
    expect(s.selectLicenses('unknown')).toEqual(['EV5GA3G2E7GLIWTARBWWODF'])
  })

  it('get + remove', () => {
    const s = openStore()
    s.importText(LINE)
    expect(s.get('EV5GA3G2E7GLIWTARBWWODF').email).toBe('mn2927958@gmail.com')
    expect(s.remove('EV5GA3G2E7GLIWTARBWWODF')).toBe(true)
    expect(s.remove('EV5GA3G2E7GLIWTARBWWODF')).toBe(false)
    expect(s.count()).toBe(0)
  })
})
```

- [ ] **Step 2: Run, expect failure**

```bash
npm test -w desktop
```

Expected: FAIL — cannot resolve `../src/main/store.js`.

- [ ] **Step 3: Implement store.js**

`desktop/src/main/store.js`:

```js
import Database from 'better-sqlite3'
import { parseAccountLine } from '../../../tools/expressvpn/xvpnChecker.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS licenses (
  license TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  password TEXT NOT NULL DEFAULT '',
  ovpn_user TEXT NOT NULL DEFAULT '',
  ovpn_pass TEXT NOT NULL DEFAULT '',
  pptp TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'unknown',
  live_days INTEGER,
  live_expire TEXT,
  live_payment TEXT,
  detail TEXT NOT NULL DEFAULT '',
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_state ON licenses(state);
`

const RANK = `CASE state WHEN 'valid' THEN 0 WHEN 'expired' THEN 1 WHEN 'canceled' THEN 2 WHEN 'invalid' THEN 3 ELSE 4 END`

export function openStore(file = ':memory:') {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)

  const upsert = db.prepare(`
    INSERT INTO licenses(license,email,meta,password,ovpn_user,ovpn_pass,pptp,created_at,updated_at)
    VALUES(@license,@email,@meta,@password,@ovpn_user,@ovpn_pass,@pptp,@now,@now)
    ON CONFLICT(license) DO UPDATE SET
      email=excluded.email, meta=excluded.meta, password=excluded.password,
      ovpn_user=excluded.ovpn_user, ovpn_pass=excluded.ovpn_pass, pptp=excluded.pptp,
      updated_at=excluded.updated_at`)
  const exists = db.prepare('SELECT 1 FROM licenses WHERE license=?')
  const now = () => Date.now()

  function importText(text) {
    let imported = 0, updated = 0
    const seen = new Set()
    const seenLines = new Set()
    const run = db.transaction(() => {
      for (const line of text.split(/\r?\n/)) {
        const acc = parseAccountLine(line)
        if (!acc) continue
        seenLines.add(line.trim())
        if (seen.has(acc.license)) continue // duplicate within one paste: first wins
        seen.add(acc.license)
        const isUpdate = !!exists.get(acc.license)
        upsert.run({
          license: acc.license, email: acc.email,
          meta: JSON.stringify({
            plan: acc.extras.Plan || '', expire: acc.extras.Expire || '', days: acc.extras.Days || '',
            autoRenew: acc.extras.AutoRenew || '', payment: acc.extras.Payment || '',
            gateway: acc.extras.Gateway || '', status: acc.extras.Status || '',
          }),
          password: acc.password || '',
          ovpn_user: acc.extras.OVPNUser || '', ovpn_pass: acc.extras.OVPNPass || '', pptp: acc.extras.PPTP || '',
          now: now(),
        })
        isUpdate ? updated++ : imported++
      }
    })
    run()
    return { imported, updated, lines: seenLines.size }
  }

  const row = r => r && { ...r }

  return {
    importText,
    list: () => db.prepare(`SELECT * FROM licenses ORDER BY ${RANK}, live_days DESC, updated_at DESC`).all().map(row),
    get: (license) => row(db.prepare('SELECT * FROM licenses WHERE license=?').get(license)),
    remove: (license) => db.prepare('DELETE FROM licenses WHERE license=?').run(license).changes > 0,
    count: () => db.prepare('SELECT COUNT(*) c FROM licenses').get().c,
    selectLicenses: (filter) =>
      (filter === 'unknown'
        ? db.prepare("SELECT license FROM licenses WHERE state='unknown' ORDER BY created_at").all()
        : db.prepare('SELECT license FROM licenses ORDER BY created_at').all()
      ).map(r => r.license),
    applyResult: (license, result) => db.prepare(`
      UPDATE licenses SET state=?, live_days=?, live_expire=?, live_payment=?, detail=?, checked_at=?, updated_at=? WHERE license=?`)
      .run(result.state ?? 'unknown', result.live?.daysRemaining ?? null, result.live?.expireIso ?? null,
        result.live?.payment ?? null, result.detail ?? '', now(), license),
    exportLines: () => db.prepare('SELECT * FROM licenses').all().map(r => {
      const m = JSON.parse(r.meta || '{}')
      const segs = [`${r.email}:${r.password || ''}`]
      if (r.ovpn_user) segs.push(`OVPNUser=${r.ovpn_user}`)
      if (r.ovpn_pass) segs.push(`OVPNPass=${r.ovpn_pass}`)
      for (const [k, v] of Object.entries({ Plan: m.plan, Expire: m.expire, Days: m.days, AutoRenew: m.autoRenew, Payment: m.payment, Gateway: m.gateway, Status: m.status })) if (v) segs.push(`${k}=${v}`)
      segs.push(`License=${r.license}`)
      if (r.pptp) segs.push(`PPTP=${r.pptp}`)
      return segs.join(' | ')
    }).join('\n') + '\n',
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -w desktop
```

Expected: PASS (5 store tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/store.js desktop/test/store.test.js
git commit -m "feat(desktop): licenses store with vault round-trip"
```

---

### Task 3: xvpnChecker refactor — export `loginOnly`

**Files:**
- Modify: `tools/expressvpn/xvpnChecker.js` (extract login sequence; `checkLicense` delegates)
- Test: `desktop/test/loginOnly.test.js`

**Interfaces:**
- Consumes: existing private `waitForLoginResult`, `readAccountJson`
- Produces: `loginOnly(license, { ctl, accountJsonPath, settleMs, confirmTimeoutMs, tmpDir })` → Promise<accountFrame | null>; throws `Error` with `.code = 'login_failed'` when ctl login exits non-zero. `checkLicense(license, opts)` keeps its exact signature/return shape.

- [ ] **Step 1: Write failing tests**

`desktop/test/loginOnly.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loginOnly, checkLicense } from '../../tools/expressvpn/xvpnChecker.js'

const LICENSE = 'ETESTLICENSE00000000000A'

function fakeAccountJson(dir) {
  const p = path.join(dir, 'account.json')
  writeFileSync(p, JSON.stringify({ loggedIn: false }), 'utf8') // start logged out
  return {
    path: p,
    set: (obj) => writeFileSync(p, JSON.stringify(obj), 'utf8'),
  }
}

// ctl stub: records commands, lets the test drive account.json on login
function fakeCtl(account) {
  const calls = []
  const ctl = async (cmd) => {
    calls.push(cmd[0])
    if (cmd[0] === 'login') account.set({ activationCode: LICENSE, loggedIn: true, daysRemaining: 12, expirationTime: '2026-09-20T00:00:00Z', paymentMethod: 'chargeBeeCreditCard' })
    return { code: 0, out: '', err: '' }
  }
  ctl.calls = calls
  return ctl
}

describe('loginOnly', () => {
  it('logs in and resolves the confirmed account frame', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lo-'))
    const account = fakeAccountJson(dir)
    const ctl = fakeCtl(account)
    const acc = await loginOnly(LICENSE, { ctl, accountJsonPath: account.path, settleMs: 1, confirmTimeoutMs: 1000, tmpDir: dir })
    expect(acc.activationCode).toBe(LICENSE)
    expect(acc.loggedIn).toBe(true)
    expect(ctl.calls[0]).toBe('logout')
    expect(ctl.calls[1]).toBe('login')
  })

  it('resolves null when the server never confirms (rejected code)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lo-'))
    const account = fakeAccountJson(dir)
    const ctl = async (cmd) => { if (cmd[0] === 'login') account.set({ activationCode: LICENSE, loggedIn: false }); return { code: 0, out: '', err: '' } }
    const acc = await loginOnly(LICENSE, { ctl, accountJsonPath: account.path, settleMs: 1, confirmTimeoutMs: 500, tmpDir: dir })
    expect(acc).toBeNull()
  })

  it('throws login_failed when ctl login exits non-zero', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lo-'))
    const account = fakeAccountJson(dir)
    const ctl = async (cmd) => (cmd[0] === 'login' ? { code: 3, out: '', err: 'boom' } : { code: 0, out: '', err: '' })
    await expect(loginOnly(LICENSE, { ctl, accountJsonPath: account.path, settleMs: 1, confirmTimeoutMs: 500, tmpDir: dir }))
      .rejects.toMatchObject({ code: 'login_failed', message: 'boom' })
  })

  it('checkLicense still classifies via the shared sequence', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lo-'))
    const account = fakeAccountJson(dir)
    const ctl = fakeCtl(account)
    const r = await checkLicense(LICENSE, { ctl, accountJsonPath: account.path, settleMs: 1, confirmTimeoutMs: 1000, tmpDir: dir })
    expect(r.state).toBe('valid')
    expect(r.live.daysRemaining).toBe(12)
    expect(r.live.payment).toBe('chargeBeeCreditCard')
  })
})
```

- [ ] **Step 2: Run, expect failure**

```bash
npm test -w desktop
```

Expected: FAIL — `loginOnly` is not exported.

- [ ] **Step 3: Refactor xvpnChecker.js**

Replace the body of `checkLicense` (everything from `const result = ...` through the end of the function) with an extracted `loginOnly` plus a slim `checkLicense`. Full new code for the region starting at the `// Full login probe...` comment:

```js
// Login sequence shared by checkLicense (probe) and the desktop app's
// connectManager: logout + settle, login, poll for server confirmation.
// Returns the confirmed account frame, or null when the server rejected the
// code (loggedIn never turned true in time). Throws Error{code:'login_failed'}
// when the ctl login itself exits non-zero.
export async function loginOnly(license, {
  ctl = makeCtl(),
  accountJsonPath = DEFAULT_ACCOUNT_JSON,
  settleMs = 1500,
  confirmTimeoutMs = 20000,
  tmpDir,
} = {}) {
  const dir = tmpDir || mkdtempSync(path.join(tmpdir(), 'xvpn-'))
  const keyFile = path.join(dir, 'key.txt')
  writeFileSync(keyFile, license, { flag: 'w' })
  try {
    await ctl(['logout'], 30000)
    const logoutDeadline = Date.now() + 10000
    for (;;) {
      const a = await readAccountJson(accountJsonPath)
      if (!a || !a.loggedIn) break
      if (Date.now() > logoutDeadline) break
      await sleep(300)
    }
    await sleep(settleMs)

    const login = await ctl(['login', keyFile], 90000)
    if (login.code !== 0) {
      const e = new Error((login.err || login.out || `exit ${login.code}`).slice(0, 200))
      e.code = 'login_failed'
      throw e
    }
    return await waitForLoginResult(license, accountJsonPath, confirmTimeoutMs)
  } finally {
    try { unlinkSync(keyFile) } catch { /* already gone */ }
    if (tmpDir === undefined) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ } }
  }
}

// Full login probe for one license: login via loginOnly, then classify the
// account frame. Same sequence and detail strings as before the extraction.
export async function checkLicense(license, opts = {}) {
  const result = { state: 'invalid', detail: '', live: null }
  let acc
  try {
    acc = await loginOnly(license, opts)
  } catch (e) {
    result.detail = e.message
    return result
  }
  if (!acc) {
    result.detail = 'server rejected the activation code (no confirmation in time)'
    return result
  }
  result.state = 'valid'
  result.live = {
    active: acc.active,
    expired: acc.expired,
    canceled: acc.canceled,
    daysRemaining: acc.daysRemaining,
    expireIso: acc.expirationTime ? new Date(acc.expirationTime).toISOString().slice(0, 10) : '',
    payment: acc.paymentMethod || '',
    recurring: !!acc.recurring,
    isTrial: !!acc.isTrial,
  }
  if (acc.canceled) { result.state = 'canceled'; result.detail = 'subscription canceled' }
  else if (acc.expired || (acc.daysRemaining ?? 0) <= 0) { result.state = 'expired'; result.detail = 'no days remaining' }
  return result
}
```

Note: this deletes the old `result.detail = (login.err …)` branch (now the thrown `login_failed` message) and the old `finally` (now inside `loginOnly`). Behavior-equivalent for the CLI: identical sequence, identical detail strings.

- [ ] **Step 4: Run desktop tests AND the CLI's consumers**

```bash
npm test -w desktop
node --check tools/expressvpn/check-licenses.mjs && node -e "import('./tools/expressvpn/xvpnChecker.js').then(m => console.log(Object.keys(m).join(', ')))"
```

Expected: all tests PASS (loginOnly suite + store suite); exports include `loginOnly`.

- [ ] **Step 5: Commit**

```bash
git add tools/expressvpn/xvpnChecker.js desktop/test/loginOnly.test.js
git commit -m "refactor(xvpn): extract shared loginOnly sequence"
```

---

### Task 4: checkJob (serial background check)

**Files:**
- Create: `desktop/src/main/checkJob.js`
- Test: `desktop/test/checkJob.test.js`

**Interfaces:**
- Consumes: nothing (pure orchestration)
- Produces: `createCheckJob({ selectLicenses, applyResult, check, delayMs = 1500, onEvent = () => {} })` → `{ start(filter) → { started, total } | throws {code:'job_running'|'no_accounts'}, cancel() → boolean, status() → { running, total, done, failed, current, error } }`

- [ ] **Step 1: Write failing tests**

`desktop/test/checkJob.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { createCheckJob } from '../src/main/checkJob.js'

const setup = (licenses, checkImpl) => {
  const applied = []
  const events = []
  const job = createCheckJob({
    selectLicenses: () => licenses,
    applyResult: (l, r) => applied.push([l, r]),
    check: checkImpl || (async l => ({ state: 'valid', detail: '', live: null })),
    delayMs: 0,
    onEvent: s => events.push(s),
  })
  return { job, applied, events }
}
const idle = j => { for (let i = 0; i < 200; i++) { if (!j.status().running) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) } }

describe('checkJob', () => {
  it('runs serially over all licenses, applying results and emitting progress', async () => {
    const order = []
    const { job, applied, events } = setup(['A', 'B', 'C'], async l => { order.push(l); return { state: 'valid', detail: '', live: null } })
    const r = job.start('all')
    expect(r).toEqual({ started: true, total: 3 })
    await idle(job)
    expect(order).toEqual(['A', 'B', 'C'])
    expect(applied).toHaveLength(3)
    expect(events.at(-1)).toMatchObject({ running: false, done: 3, failed: 0 })
  })

  it('counts failures and records error detail without stopping', async () => {
    const { job, applied } = setup(['A', 'B'], async l => { if (l === 'A') throw new Error('boom'); return { state: 'valid', detail: '', live: null } })
    job.start('all')
    await idle(job)
    expect(job.status().failed).toBe(1)
    expect(job.status().done).toBe(1)
    expect(applied[0][1].detail).toBe('boom')
    expect(applied[0][1].state).toBe('unknown')
  })

  it('start throws job_running while busy, no_accounts when empty', async () => {
    const { job } = setup(['A'], async () => { await new Promise(r => setTimeout(r, 50)); return { state: 'valid', detail: '', live: null } })
    job.start('all')
    expect(() => job.start('all')).toThrowError(/\balready running\b/)
    await idle(job)
    const empty = setup([])
    expect(() => empty.job.start('all')).toThrowError(/\bnothing to check\b/)
  })

  it('cancel stops after the current license', async () => {
    const seen = []
    const { job } = setup(['A', 'B', 'C'], async l => { seen.push(l); return { state: 'valid', detail: '', live: null } })
    job.start('all')
    job.cancel()
    await idle(job)
    expect(seen.length).toBeLessThanOrEqual(2) // current one finishes, rest skipped
    expect(job.status().running).toBe(false)
  })
})
```

- [ ] **Step 2: Run, expect failure**

```bash
npm test -w desktop
```

Expected: FAIL — cannot resolve `../src/main/checkJob.js`.

- [ ] **Step 3: Implement checkJob.js**

`desktop/src/main/checkJob.js`:

```js
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Serial license-check job. One ExpressVPN daemon ⇒ no concurrency; one job
// at a time. Errors from individual checks are recorded (state stays
// 'unknown' — a failed probe is not a dead license).
export function createCheckJob({ selectLicenses, applyResult, check, delayMs = 1500, onEvent = () => {} }) {
  const job = { running: false, total: 0, done: 0, failed: 0, current: null, error: '', cancelRequested: false }
  const emit = () => onEvent({ ...job })

  async function run(licenses) {
    job.running = true; job.total = licenses.length; job.done = 0; job.failed = 0
    job.current = null; job.error = ''; job.cancelRequested = false
    emit()
    try {
      for (let i = 0; i < licenses.length; i++) {
        if (job.cancelRequested) break
        job.current = licenses[i]; emit()
        try {
          applyResult(licenses[i], await check(licenses[i]))
          job.done++
        } catch (e) {
          job.failed++; job.error = e.message
          applyResult(licenses[i], { state: 'unknown', detail: e.message, live: null })
        }
        emit()
        if (i < licenses.length - 1 && !job.cancelRequested) await sleep(delayMs)
      }
    } finally {
      job.running = false; job.current = null; emit()
    }
  }

  return {
    start(filter) {
      if (job.running) { const e = new Error('a check job is already running'); e.code = 'job_running'; throw e }
      const licenses = selectLicenses(filter)
      if (!licenses.length) { const e = new Error('nothing to check'); e.code = 'no_accounts'; throw e }
      run(licenses).catch(e => { job.error = e.message })
      return { started: true, total: licenses.length }
    },
    cancel: () => { if (job.running) job.cancelRequested = true; return job.cancelRequested },
    status: () => ({ ...job }),
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -w desktop
```

Expected: PASS (4 checkJob tests + previous).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/checkJob.js desktop/test/checkJob.test.js
git commit -m "feat(desktop): serial check job with progress and cancel"
```

---

### Task 5: connectManager (1-click connect state machine)

**Files:**
- Create: `desktop/src/main/connectManager.js`
- Test: `desktop/test/connectManager.test.js`

**Interfaces:**
- Consumes: `loginOnly` (Task 3), a `ctl(cmd, timeout)` function, a `state()` → Promise<string> (connectionState), `isBusy()` → boolean
- Produces: `createConnectManager({ login, ctl, state, isBusy, connectTimeoutMs = 30000, disconnectTimeoutMs = 15000, pollMs = 300, onEvent = () => {} })` → `{ connect(license, email) → Promise<{ok:true}> | throws {code}, disconnect() → Promise<{ok:true}>, status() → { state: 'idle'|'connecting'|'connected'|'disconnecting', license, email } }`. Error codes: `busy` (manager active), `job_running` (check busy), `vpn_active` (not Disconnected), `login_failed`, `login_rejected`, `connect_timeout`.

- [ ] **Step 1: Write failing tests**

`desktop/test/connectManager.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { createConnectManager } from '../src/main/connectManager.js'

function harness({ loginRes = { activationCode: 'L1', loggedIn: true }, states = {} } = {}) {
  // states: map of call-sequence → connectionState value; default Disconnected
  const calls = []
  let stateSeq = ['Disconnected']
  let login = async () => loginRes
  const mgr = createConnectManager({
    login: (...a) => login(...a),
    ctl: async (cmd) => { calls.push(cmd[0]); return { code: 0, out: '', err: '' } },
    state: async () => stateSeq.length > 1 ? stateSeq.shift() : stateSeq[0],
    isBusy: () => false,
    connectTimeoutMs: 300, disconnectTimeoutMs: 300, pollMs: 1,
  })
  return { mgr, calls, setLogin: fn => (login = fn), setState: seq => (stateSeq = seq) }
}

describe('connectManager', () => {
  it('happy path: login → connect → poll to Connected', async () => {
    const h = harness()
    h.setState(['Disconnected', 'Connecting', 'Connected'])
    const r = await h.mgr.connect('L1', 'a@b.c')
    expect(r).toEqual({ ok: true })
    expect(h.mgr.status()).toMatchObject({ state: 'connected', license: 'L1', email: 'a@b.c' })
    expect(h.calls).toEqual(['connect'])
  })

  it('throws vpn_active when not Disconnected', async () => {
    const h = harness()
    h.setState(['Connected'])
    await expect(h.mgr.connect('L1', 'a@b.c')).rejects.toMatchObject({ code: 'vpn_active' })
    expect(h.mgr.status().state).toBe('idle')
  })

  it('throws job_running when the check job is busy', async () => {
    const h = harness()
    // re-create with busy isBusy
    const mgr = createConnectManager({ login: async () => ({}), ctl: async () => ({ code: 0, out: '', err: '' }), state: async () => 'Disconnected', isBusy: () => true, pollMs: 1 })
    await expect(mgr.connect('L1', 'a@b.c')).rejects.toMatchObject({ code: 'job_running' })
  })

  it('login rejected → cleanup (disconnect+logout) and back to idle', async () => {
    const h = harness()
    h.setLogin(async () => null)
    await expect(h.mgr.connect('L1', 'a@b.c')).rejects.toMatchObject({ code: 'login_rejected' })
    expect(h.calls).toEqual(['disconnect', 'logout'])
    expect(h.mgr.status().state).toBe('idle')
  })

  it('connect timeout → cleanup and idle', async () => {
    const h = harness()
    h.setState(['Disconnected', 'Connecting', 'Connecting', 'Connecting', 'Connecting'])
    await expect(h.mgr.connect('L1', 'a@b.c')).rejects.toMatchObject({ code: 'connect_timeout' })
    expect(h.calls).toEqual(['connect', 'disconnect', 'logout'])
    expect(h.mgr.status().state).toBe('idle')
  })

  it('login_failed propagates the code with cleanup', async () => {
    const h = harness()
    const e = new Error('ctl boom'); e.code = 'login_failed'
    h.setLogin(async () => { throw e })
    await expect(h.mgr.connect('L1', 'a@b.c')).rejects.toMatchObject({ code: 'login_failed' })
    expect(h.mgr.status().state).toBe('idle')
  })

  it('disconnect: waits for Disconnected then logs out', async () => {
    const h = harness()
    h.setState(['Disconnected', 'Connected', 'Disconnecting', 'Disconnected'])
    await h.mgr.connect('L1', 'a@b.c')
    h.setState(['Disconnecting', 'Disconnected'])
    const r = await h.mgr.disconnect()
    expect(r).toEqual({ ok: true })
    expect(h.calls).toEqual(['connect', 'disconnect', 'logout'])
    expect(h.mgr.status()).toMatchObject({ state: 'idle', license: null })
  })

  it('connect while manager busy → busy error', async () => {
    const h = harness()
    h.setState(['Disconnected', 'Connected'])
    const p = h.mgr.connect('L1', 'a@b.c')
    await expect(h.mgr.connect('L2', 'x@y.z')).rejects.toMatchObject({ code: 'busy' })
    await p
  })
})
```

- [ ] **Step 2: Run, expect failure**

```bash
npm test -w desktop
```

Expected: FAIL — cannot resolve `../src/main/connectManager.js`.

- [ ] **Step 3: Implement connectManager.js**

`desktop/src/main/connectManager.js`:

```js
const sleep = ms => new Promise(r => setTimeout(r, ms))
const coded = (code, message) => { const e = new Error(message); e.code = code; return e }

// One-click connect: login with a license (loginOnly), `expressvpnctl
// connect` (smart location), poll until Connected. Disconnect leaves the
// daemon clean: disconnect + logout. Mutually exclusive with the check job
// (isBusy) and with itself.
export function createConnectManager({ login, ctl, state, isBusy, connectTimeoutMs = 30000, disconnectTimeoutMs = 15000, pollMs = 300, onEvent = () => {} }) {
  let st = 'idle'
  let current = null // { license, email }
  const emit = () => onEvent({ state: st, license: current?.license ?? null, email: current?.email ?? null })
  const cleanup = async () => { try { await ctl(['disconnect'], 90000) } catch { /* best-effort */ } }

  async function connect(license, email) {
    if (st !== 'idle') throw coded('busy', `connect manager is ${st}`)
    if (isBusy()) throw coded('job_running', 'a check job is running')
    const s = await state()
    if (s !== 'Disconnected') throw coded('vpn_active', `VPN state is "${s}" — disconnect first`)
    st = 'connecting'; current = { license, email }; emit()
    try {
      const acc = await login(license)
      if (!acc) throw coded('login_rejected', 'server rejected the activation code')
      const r = await ctl(['connect'], 90000)
      if (r.code !== 0) throw coded('connect_failed', (r.err || r.out || `exit ${r.code}`).slice(0, 200))
      const deadline = Date.now() + connectTimeoutMs
      for (;;) {
        const cur = await state()
        if (cur === 'Connected') break
        if (Date.now() > deadline) throw coded('connect_timeout', 'connect timed out waiting for Connected')
        await sleep(pollMs)
      }
      st = 'connected'; emit()
      return { ok: true }
    } catch (e) {
      await cleanup()
      try { await ctl(['logout'], 30000) } catch { /* best-effort */ }
      st = 'idle'; current = null; emit()
      throw e
    }
  }

  async function disconnect() {
    if (st === 'idle') return { ok: true }
    if (st !== 'connected') throw coded('busy', `connect manager is ${st}`)
    st = 'disconnecting'; emit()
    try { await ctl(['disconnect'], 90000) } catch { /* best-effort */ }
    const deadline = Date.now() + disconnectTimeoutMs
    for (;;) {
      const cur = await state()
      if (cur === 'Disconnected' || Date.now() > deadline) break
      await sleep(pollMs)
    }
    try { await ctl(['logout'], 30000) } catch { /* best-effort */ }
    st = 'idle'; current = null; emit()
    return { ok: true }
  }

  return { connect, disconnect, status: () => ({ state: st, license: current?.license ?? null, email: current?.email ?? null }) }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -w desktop
```

Expected: PASS (8 connectManager tests + previous suites).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/connectManager.js desktop/test/connectManager.test.js
git commit -m "feat(desktop): connect manager state machine"
```

---

### Task 6: IPC wiring + main composition + seed

**Files:**
- Create: `desktop/src/main/ipc.js`
- Modify: `desktop/src/main/index.js` (compose store/job/manager, seed, register IPC)
- Test: `desktop/test/ipc.test.js`

**Interfaces:**
- Consumes: `openStore`, `createCheckJob`, `createConnectManager`, `makeCtl`, `connectionState`, `checkLicense`, `loginOnly`, `DEFAULT_CTL` from previous tasks
- Produces: `registerIpc({ ipcMain, store, checkJob, connectManager, ctlAvailable, connectionState, send })` registering exactly the channels the preload invokes (Task 1 lists them). Thrown errors surface as `{ message, code }` rejections via a wrapped handler.

- [ ] **Step 1: Write failing tests**

`desktop/test/ipc.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { registerIpc } from '../src/main/ipc.js'

function fakeIpcMain() {
  const handlers = new Map()
  return {
    handle: (ch, fn) => handlers.set(ch, fn),
    invoke: (ch, ...args) => { const fn = handlers.get(ch); if (!fn) throw new Error(`no handler for ${ch}`); return fn({}, ...args) },
    channels: () => [...handlers.keys()],
  }
}

const store = () => {
  const rows = [{ license: 'L1', email: 'a@b.c' }]
  return {
    list: () => rows,
    get: l => rows.find(r => r.license === l),
    remove: () => true,
    importText: () => ({ imported: 1, updated: 0, lines: 1 }),
    exportLines: () => 'a:b | License=L1\n',
    selectLicenses: () => ['L1'],
    applyResult: () => {},
  }
}

describe('ipc', () => {
  it('registers every channel the preload uses', () => {
    const ipcMain = fakeIpcMain()
    registerIpc({ ipcMain, store: store(), checkJob: { start: () => ({ started: true, total: 1 }), status: () => ({ running: false }), cancel: () => true }, connectManager: { connect: async () => ({ ok: true }), disconnect: async () => ({ ok: true }), status: () => ({ state: 'idle' }) }, ctlAvailable: true, connectionState: async () => 'Disconnected', send: () => {} })
    expect(ipcMain.channels().sort()).toEqual(['accounts:delete', 'accounts:export', 'accounts:import', 'accounts:list', 'check:cancel', 'check:start', 'check:status', 'connect:connect', 'connect:disconnect', 'connect:status', 'ctl:available'])
  })

  it('accounts:list returns rows', async () => {
    const ipcMain = fakeIpcMain()
    registerIpc({ ipcMain, store: store(), checkJob: { start: () => {}, status: () => ({}), cancel: () => true }, connectManager: { connect: async () => {}, disconnect: async () => {}, status: () => ({}) }, ctlAvailable: true, connectionState: async () => 'Disconnected', send: () => {} })
    expect(await ipcMain.invoke('accounts:list')).toEqual([{ license: 'L1', email: 'a@b.c' }])
  })

  it('check:start guards: ctl missing → ctl_missing; vpn active → vpn_active', async () => {
    const ipcMain = fakeIpcMain()
    const reg = (ctlOk, st) => registerIpc({ ipcMain, store: store(), checkJob: { start: () => ({ started: true, total: 1 }), status: () => ({ running: false }), cancel: () => true }, connectManager: { connect: async () => {}, disconnect: async () => {}, status: () => ({}) }, ctlAvailable: ctlOk, connectionState: async () => st, send: () => {} })
    reg(false, 'Disconnected')
    await expect(ipcMain.invoke('check:start', 'all')).rejects.toMatchObject({ code: 'ctl_missing' })
    reg(true, 'Connected')
    await expect(ipcMain.invoke('check:start', 'all')).rejects.toMatchObject({ code: 'vpn_active' })
  })

  it('errors from deps surface as { code, message } rejections', async () => {
    const ipcMain = fakeIpcMain()
    registerIpc({ ipcMain, store: store(), checkJob: { start: () => { const e = new Error('a check job is already running'); e.code = 'job_running'; throw e }, status: () => ({ running: false }), cancel: () => true }, connectManager: { connect: async () => {}, disconnect: async () => {}, status: () => ({}) }, ctlAvailable: true, connectionState: async () => 'Disconnected', send: () => {} })
    await expect(ipcMain.invoke('check:start', 'all')).rejects.toMatchObject({ code: 'job_running' })
  })
})
```

- [ ] **Step 2: Run, expect failure**

```bash
npm test -w desktop
```

Expected: FAIL — cannot resolve `../src/main/ipc.js`.

- [ ] **Step 3: Implement ipc.js**

`desktop/src/main/ipc.js`:

```js
// Thin wiring: every preload invoke maps to one handler here. Guards that
// need the ctl (availability, VPN state) live here, not in the modules, so
// store/checkJob/connectManager stay electron-free.
const wrap = fn => async (_e, ...args) => {
  try { return await fn(...args) }
  catch (err) { throw { code: err.code || 'internal', message: err.message || String(err) } }
}

const coded = (code, message) => Object.assign(new Error(message), { code })

export function registerIpc({ ipcMain, store, checkJob, connectManager, ctlAvailable, connectionState, send }) {
  ipcMain.handle('ctl:available', wrap(async () => ctlAvailable))
  ipcMain.handle('accounts:list', wrap(async () => store.list()))
  ipcMain.handle('accounts:import', wrap(async (text) => store.importText(text)))
  ipcMain.handle('accounts:delete', wrap(async (license) => ({ deleted: store.remove(license) })))
  ipcMain.handle('accounts:export', wrap(async () => store.exportLines()))

  ipcMain.handle('check:start', wrap(async (filter = 'all') => {
    if (checkJob.status().running) throw coded('job_running', 'a check job is already running')
    if (!ctlAvailable) throw coded('ctl_missing', `expressvpnctl not found — install the ExpressVPN app`)
    const st = await connectionState()
    if (st !== 'Disconnected') throw coded('vpn_active', `VPN state is "${st}" — disconnect before checking`)
    return checkJob.start(filter)
  }))
  ipcMain.handle('check:status', wrap(async () => checkJob.status()))
  ipcMain.handle('check:cancel', wrap(async () => ({ cancelled: checkJob.cancel() })))

  ipcMain.handle('connect:connect', wrap(async (license) => {
    if (!ctlAvailable) throw coded('ctl_missing', `expressvpnctl not found — install the ExpressVPN app`)
    const row = store.get(license)
    if (!row) throw coded('not_found', 'no such license')
    return connectManager.connect(license, row.email)
  }))
  ipcMain.handle('connect:disconnect', wrap(async () => connectManager.disconnect()))
  ipcMain.handle('connect:status', wrap(async () => connectManager.status()))
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -w desktop
```

Expected: PASS (4 ipc tests + all previous).

- [ ] **Step 5: Compose in main/index.js**

Replace `desktop/src/main/index.js` with:

```js
import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from './store.js'
import { createCheckJob } from './checkJob.js'
import { createConnectManager } from './connectManager.js'
import { registerIpc } from './ipc.js'
import { makeCtl, connectionState, checkLicense, loginOnly, DEFAULT_CTL } from '../../../tools/expressvpn/xvpnChecker.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
let mainWindow = null
const send = (channel, payload) => mainWindow?.webContents?.send(channel, payload)

function bootstrap() {
  const store = openStore(path.join(app.getPath('userData'), 'xvpn-manager.db'))

  // first run: seed from the vault next to the CLI (dev tree) or from the
  // packaged extra resource
  if (!store.count()) {
    const candidates = [
      path.resolve(app.getAppPath(), '..', 'tools', 'expressvpn', 'accounts.txt'),
      process.resourcesPath ? path.join(process.resourcesPath, 'accounts.txt') : '',
    ].filter(Boolean)
    for (const p of candidates) {
      if (existsSync(p)) { const r = store.importText(readFileSync(p, 'utf8')); console.log(`[xvpn] seeded from ${p}: ${r.imported} imported`); break }
    }
  }

  const ctl = makeCtl(DEFAULT_CTL)
  const ctlAvailable = existsSync(DEFAULT_CTL)
  const checkJob = createCheckJob({
    selectLicenses: f => store.selectLicenses(f),
    applyResult: (l, r) => store.applyResult(l, r),
    check: license => checkLicense(license, { ctl }),
    delayMs: 1500,
    onEvent: s => send('check:progress', s),
  })
  const connectManager = createConnectManager({
    login: license => loginOnly(license, { ctl }),
    ctl,
    state: () => connectionState(ctl),
    isBusy: () => checkJob.status().running,
    onEvent: s => send('connect:state', s),
  })
  registerIpc({ ipcMain, store, checkJob, connectManager, ctlAvailable, connectionState: () => connectionState(ctl), send })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.env.VITE_DEV) mainWindow.loadURL('http://127.0.0.1:5174')
  else mainWindow.loadFile(path.join(dirname, '../../dist/index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  bootstrap()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

(The dev script and `cross-env` devDependency were already set up in Task 1.)

- [ ] **Step 6: Smoke run**

```bash
npm run dev -w desktop
```

Expected: window opens; DevTools console `await window.xvpn.accountsList()` returns the seeded 86 licenses (from `tools/expressvpn/accounts.txt`); `await window.xvpn.ctlAvailable()` returns true/false per machine. Close window.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/main desktop/package.json desktop/test/ipc.test.js package-lock.json
git commit -m "feat(desktop): ipc wiring, seed, main composition"
```

---

### Task 7: UI (toolbar, table, import dialog, job bar, connect banner)

**Files:**
- Modify: `desktop/src/ui/App.jsx` (full implementation)
- Create: `desktop/src/ui/ImportDialog.jsx`, `desktop/src/ui/ConnectBanner.jsx`, `desktop/src/ui/JobBar.jsx`
- Test: manual smoke via dev run

**Interfaces:**
- Consumes: the full `window.xvpn` bridge (Task 1 preload), `onCheckProgress`, `onConnectState` events
- Produces: the complete visible app

- [ ] **Step 1: App.jsx**

```jsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardCopy, PlayCircle, Plus, ShieldOff, Trash2, Upload } from 'lucide-react'
import ImportDialog from './ImportDialog.jsx'
import ConnectBanner from './ConnectBanner.jsx'
import JobBar from './JobBar.jsx'

const PILL = 'rounded px-1.5 py-0.5 text-[11px] font-semibold'
const STATE_STYLE = {
  valid: 'bg-emerald-600/30 text-emerald-300',
  expired: 'bg-amber-500/30 text-amber-300',
  canceled: 'bg-orange-600/30 text-orange-300',
  invalid: 'bg-red-600/30 text-red-300',
  unknown: 'bg-slate-600/40 text-slate-300',
}
const fmtDate = ts => (ts ? new Date(ts).toLocaleString() : '—')
const err = e => e?.message || String(e)

export default function App() {
  const [items, setItems] = useState([])
  const [ctlOk, setCtlOk] = useState(true)
  const [job, setJob] = useState(null)
  const [conn, setConn] = useState({ state: 'idle' })
  const [importOpen, setImportOpen] = useState(false)
  const [filter, setFilter] = useState('all')
  const [toast, setToast] = useState('')
  const flash = msg => { setToast(msg); setTimeout(() => setToast(''), 3500) }

  const load = useCallback(async () => {
    try { setItems(await window.xvpn.accountsList()) } catch (e) { flash(err(e)) }
  }, [])

  useEffect(() => {
    load().catch(() => {})
    window.xvpn.ctlAvailable().then(setCtlOk).catch(() => {})
    window.xvpn.checkStatus().then(setJob).catch(() => {})
    window.xvpn.connectStatus().then(setConn).catch(() => {})
    const offP = window.xvpn.onCheckProgress(s => { setJob(s); if (!s.running && s.total) load().catch(() => {}) })
    const offC = window.xvpn.onConnectState(setConn)
    return () => { offP(); offC() }
  }, [load])

  const counts = useMemo(() => items.reduce((m, a) => ((m[a.state] = (m[a.state] || 0) + 1), m), {}), [items])

  const checkAll = async () => {
    try {
      const r = await window.xvpn.checkStart(filter)
      setJob({ running: true, total: r.total, done: 0, failed: 0, current: null })
    } catch (e) { flash(err(e)) }
  }
  const cancel = async () => { await window.xvpn.checkCancel().catch(() => {}) }
  const remove = async license => {
    try { await window.xvpn.accountsDelete(license); load().catch(() => {}) } catch (e) { flash(err(e)) }
  }
  const connect = async license => {
    try { await window.xvpn.connectConnect(license) } catch (e) { flash(err(e)) }
  }
  const doExport = async () => {
    try {
      const text = await window.xvpn.accountsExport()
      await navigator.clipboard.writeText(text)
      flash(`${items.length} licenses copied to clipboard`)
    } catch (e) { flash(err(e)) }
  }
  const copy = (v, what) => navigator.clipboard.writeText(v).then(() => flash(`${what} copied`), () => {})

  const busy = job?.running

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      {!ctlOk && (
        <div className="bg-amber-900/40 border-b border-amber-800 text-amber-200 px-4 py-2 text-sm flex items-center gap-2">
          <ShieldOff className="w-4 h-4" /> expressvpnctl not found — import/export/list work, check/connect disabled.
        </div>
      )}
      <ConnectBanner conn={conn} onDisconnect={async () => { try { await window.xvpn.connectDisconnect() } catch (e) { flash(err(e)) } }} disabled={!ctlOk} />

      <header className="flex items-center gap-2 px-4 py-3 border-b border-slate-800 flex-wrap">
        <h1 className="font-bold text-lg mr-2">XVPN Manager</h1>
        {Object.entries(counts).map(([s, n]) => (
          <span key={s} className={`${PILL} ${STATE_STYLE[s] || STATE_STYLE.unknown}`}>{s}: {n}</span>
        ))}
        <div className="flex-1" />
        <button onClick={() => setImportOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 px-3 py-2 font-semibold text-sm">
          <Plus className="w-4 h-4" /> Import
        </button>
        <button onClick={doExport} className="flex items-center gap-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 px-3 py-2 font-semibold text-sm">
          <Upload className="w-4 h-4" /> Export
        </button>
        <button onClick={checkAll} disabled={!ctlOk || busy}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 font-semibold text-sm text-white ${!ctlOk || busy ? 'bg-violet-900/50 cursor-not-allowed' : 'bg-violet-600 hover:bg-violet-500'}`}>
          <PlayCircle className="w-4 h-4" /> {busy ? `Checking… (${(job.done + job.failed)}/${job.total})` : `Check ${filter === 'unknown' ? 'Unknown' : 'All'}`}
        </button>
        <button onClick={() => setFilter(f => (f === 'all' ? 'unknown' : 'all'))} title="toggle check filter"
          className="rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 px-3 py-2 text-xs font-mono">
          filter: {filter}
        </button>
      </header>

      {busy && <JobBar job={job} onCancel={cancel} />}

      <main className="p-4">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-400 border-b border-slate-800">
            <tr>
              <th className="py-2">State</th><th>Email</th><th>Plan</th><th>Expire</th>
              <th>Live</th><th>Payment</th><th>Checked</th><th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(a => {
              const m = a.meta ? JSON.parse(a.meta) : {}
              return (
                <tr key={a.license} className="border-b border-slate-800/60 hover:bg-slate-800/40">
                  <td className="py-2"><span className={`${PILL} ${STATE_STYLE[a.state] || STATE_STYLE.unknown}`}>{a.state}</span></td>
                  <td className="font-mono text-xs">{a.email}</td>
                  <td>{m.plan || '—'}</td>
                  <td className="text-xs">{m.expire || '—'}{m.days ? ` (${m.days}d)` : ''}</td>
                  <td className="text-xs">{a.live_days != null ? `${a.live_days}d · ${a.live_expire || '?'}` : '—'}</td>
                  <td className="text-xs">{a.live_payment || m.payment || '—'}</td>
                  <td className="text-xs text-slate-400">{fmtDate(a.checked_at)}</td>
                  <td className="text-right whitespace-nowrap">
                    <button title="Copy license" onClick={() => copy(a.license, 'License')} className="rounded p-1.5 hover:bg-slate-700 text-slate-300"><ClipboardCopy className="w-4 h-4" /></button>
                    <button title="Connect" disabled={!ctlOk || conn.state !== 'idle' || busy} onClick={() => connect(a.license)}
                      className="rounded p-1.5 hover:bg-slate-700 text-emerald-400 disabled:opacity-30"><PlayCircle className="w-4 h-4" /></button>
                    <button title="Delete" onClick={() => remove(a.license)} className="rounded p-1.5 hover:bg-slate-700 text-red-400"><Trash2 className="w-4 h-4" /></button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!items.length && <p className="text-slate-500 text-sm mt-8 text-center">No licenses — Import to start.</p>}
      </main>

      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onDone={r => { flash(`Imported ${r.imported}, updated ${r.updated} (${r.lines} lines)`); load().catch(() => {}) }} />}
      {toast && <div className="fixed bottom-4 right-4 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm shadow-lg">{toast}</div>}
    </div>
  )
}
```

- [ ] **Step 2: ImportDialog.jsx**

```jsx
import { useState } from 'react'
import { X } from 'lucide-react'

export default function ImportDialog({ onClose, onDone }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setBusy(true); setError('')
    try {
      const r = await window.xvpn.accountsImport(text)
      onDone(r)
      onClose()
    } catch (e) { setError(e?.message || String(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-slate-800 rounded-xl p-5 w-full max-w-2xl space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Import licenses</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-slate-700"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-slate-400">Paste vault lines (email:password | … | License=…). Junk lines are skipped; duplicates by license update in place.</p>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={12} autoFocus
          className="w-full rounded-lg bg-slate-900 border border-slate-700 p-3 font-mono text-xs" placeholder="email:password | Plan=1mo | License=EXXXX…" />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-4 py-2 text-sm hover:bg-slate-700">Cancel</button>
          <button onClick={submit} disabled={busy || !text.trim()} className="rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white">
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: ConnectBanner.jsx + JobBar.jsx**

`desktop/src/ui/ConnectBanner.jsx`:

```jsx
import { Plug, PlugZap } from 'lucide-react'

export default function ConnectBanner({ conn, onDisconnect, disabled }) {
  if (conn.state === 'idle') return null
  const label = conn.state === 'connected' ? 'Connected' : conn.state === 'disconnecting' ? 'Disconnecting…' : 'Connecting…'
  const tone = conn.state === 'connected' ? 'bg-emerald-900/40 border-emerald-800 text-emerald-200' : 'bg-sky-900/40 border-sky-800 text-sky-200'
  return (
    <div className={`flex items-center gap-2 px-4 py-2 text-sm border-b ${tone}`}>
      {conn.state === 'connected' ? <PlugZap className="w-4 h-4" /> : <Plug className="w-4 h-4 animate-pulse" />}
      <span className="font-semibold">{label}</span>
      <span className="font-mono text-xs">{conn.email} · {conn.license ? conn.license.slice(0, 8) + '…' : ''}</span>
      <div className="flex-1" />
      <button onClick={onDisconnect} disabled={disabled || conn.state !== 'connected'}
        className="rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 px-3 py-1 text-xs font-semibold">Disconnect</button>
    </div>
  )
}
```

`desktop/src/ui/JobBar.jsx`:

```jsx
import { Ban } from 'lucide-react'

export default function JobBar({ job, onCancel }) {
  const done = job.done + job.failed
  const pct = job.total ? Math.round((done / job.total) * 100) : 0
  return (
    <div className="px-4 py-2 bg-slate-800/60 border-b border-slate-800 flex items-center gap-3 text-sm">
      <div className="flex-1 h-2 rounded bg-slate-700 overflow-hidden">
        <div className="h-full bg-violet-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-400 font-mono">
        {done}/{job.total}{job.failed ? ` · ${job.failed} errors` : ''}{job.current ? ` · ${job.current.slice(0, 8)}…` : ''}
      </span>
      <button onClick={onCancel} className="flex items-center gap-1 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 px-2 py-1 text-xs">
        <Ban className="w-3 h-3" /> Cancel
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Smoke run**

```bash
npm run build:ui -w desktop && npm run dev -w desktop
```

Expected (walk the UI): seeded table with state pills and counts; Import dialog pasting a vault line updates counts; Copy license flashes toast; Check button disabled when ctl missing; connect button per row; Export copies N lines to clipboard; DevTools shows no errors.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/ui
git commit -m "feat(desktop): manager ui — table, import, job bar, connect banner"
```

---

### Task 8: Packaging + README

**Files:**
- Create: `desktop/electron-builder.yml`
- Modify: `README.md` (desktop section), `.gitignore` (release outputs — already added in Task 1)

**Interfaces:**
- Consumes: everything
- Produces: installable artifacts + docs

- [ ] **Step 1: electron-builder.yml**

```yaml
appId: com.trinknx.xvpnmanager
productName: XVPN Manager
directories: { output: release }
files:
  - src/main/**
  - src/preload.js
  - dist/**
  - package.json
extraResources:
  - from: ../tools/expressvpn/accounts.txt
    to: accounts.txt
    optional: true
win:
  target: [nsis, portable]
asar: true
```

- [ ] **Step 2: Build distributables**

```bash
npm run dist -w desktop
```

Expected: `desktop/release/` contains an NSIS installer and a portable `.exe`. If better-sqlite3 ABI errors appear on launch of the packaged app, run `npx @electron/rebuild -f -w better-sqlite3` in `desktop/` and re-run dist.

- [ ] **Step 3: Smoke the portable exe**

Run the portable exe. Expected: same seeded window as dev (seed via `process.resourcesPath/accounts.txt`), import/export work; check/connect require ExpressVPN installed.

- [ ] **Step 4: README section**

Append to `README.md` (after the ExpressVPN CLI section):

```markdown
## XVPN Manager (desktop)

Electron app for the ExpressVPN license vault — import/list/check/export plus one-click Connect. Lives in `desktop/`:

```bash
npm install            # postinstall rebuilds better-sqlite3 for Electron
npm run dev -w desktop     # dev: vite (5174) + electron
npm run dist -w desktop    # NSIS installer + portable exe in desktop/release/
```

First run seeds from `tools/expressvpn/accounts.txt`. Check/Connect need the ExpressVPN desktop app installed (default `expressvpnctl` path). Data: `%APPDATA%/xvpn-manager/xvpn-manager.db` (plain SQLite, no encryption — personal machine assumption).
```

- [ ] **Step 5: Final verification + commit**

```bash
npm test -w server && npm test -w desktop
```

Expected: server 222 tests + desktop suites all PASS.

```bash
git add desktop/electron-builder.yml README.md
git commit -m "feat(desktop): packaging (nsis + portable) and docs"
```
