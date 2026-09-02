# ExpressVPN Desktop Manager — Design

Date: 2026-09-02
Branch: `feat/xvpn-desktop` (from `master`; repo keeps cookiehub + tools + docker intact)

## Goal

A Windows desktop application to manage all ExpressVPN licenses: import, list, live-check, export, delete — plus a one-click **Connect** button that logs the local ExpressVPN app into any chosen license and connects (smart location). Feature parity with the removed web feature (`/api/expressvpn`) and the existing CLI (`tools/expressvpn/check-licenses.mjs`), plus Connect.

Decisions already made with the user:

- Scope = old web feature parity (import/check/manage/export) + Connect button
- Connect = 1-click smart connect; disconnect = disconnect + logout
- New branch from `master`, desktop app added as a new workspace folder
- No password gate, no at-rest encryption (personal machine); SQLite in OS user data dir
- Framework: **Electron** (reuse `xvpnChecker.js` unchanged in behavior, `better-sqlite3`, React/Tailwind stack)

## Architecture

npm workspace `desktop/` with two halves:

```
desktop/
  src/main/            # Electron main process (Node)
    index.js           # app lifecycle, BrowserWindow, dev/prod load
    ipc.js             # contextBridge-safe handler wiring (ipcMain.handle / webContents.send)
    store.js           # better-sqlite3 open/init/CRUD (userData/xvpn-manager.db)
    checkJob.js        # serial license-check background job
    connectManager.js  # connect/disconnect state machine
  src/ui/              # React renderer (Vite + Tailwind, same toolchain as client/)
    main.jsx, App.jsx, components/…
  electron-builder.yml # NSIS + portable targets
  package.json         # workspace: electron, electron-builder, react, vite, tailwind, vitest
```

- `tools/expressvpn/xvpnChecker.js` is imported directly by main-process modules — single source of truth shared with the CLI. No copy.
- First run: if DB is empty and `tools/expressvpn/accounts.txt` exists, auto-import it (current vault: 86 licenses). Afterwards the DB is the source of truth; Export writes vault lines back out.
- Dev: `npm run dev -w desktop` runs Vite + Electron together. Prod build: Vite builds the renderer, electron-builder packages.

## Data model

Table `licenses` (mirrors the old `xvpn_accounts` table, creds unencrypted per user decision):

| column | notes |
|---|---|
| `license TEXT PRIMARY KEY` | the activation key (was UNIQUE AI row id; the license itself is the natural key) |
| `email TEXT NOT NULL DEFAULT ''` | |
| `meta TEXT NOT NULL DEFAULT '{}'` | JSON: `plan, expire, days, autoRenew, payment, gateway, status` (claimed vault metadata) |
| `password, ovpn_user, ovpn_pass, pptp TEXT` | credentials from the vault line |
| `state TEXT NOT NULL DEFAULT 'unknown'` | `valid | expired | canceled | invalid | unknown` |
| `live_days INTEGER, live_expire TEXT, live_payment TEXT` | last live-check results |
| `detail TEXT NOT NULL DEFAULT ''` | last check detail/error |
| `checked_at INTEGER, created_at INTEGER, updated_at INTEGER` | epoch ms |

Store API (dependency-injected `db`):

- `importText(text) → { imported, updated, lines }` — parse each line with `parseAccountLine`; skip lines without `License=`; first license wins on duplicates within one paste; upsert by license.
- `list() → rows[]` sorted by `state` (valid→expired→canceled→invalid→unknown), `live_days DESC`, `updated_at DESC`.
- `remove(license) → boolean`
- `exportLines() → string` — reconstruct vault lines: `email:password | OVPNUser=… | OVPNPass=… | Plan=… | … | License=… | PPTP=…` (inverse of `credsOf`/`metaOf`; round-trips through `parseAccountLine`).
- `get(license) → row`

## Check job (`checkJob.js`)

Serial background job over selected rows (one ExpressVPN daemon ⇒ no concurrency):

- `start({ filter })` — `filter: 'all' | 'unknown'`. Guards: not already running; `existsSync(ctlPath)`; `connectionState(ctl) === 'Disconnected'` (a connected VPN blocks checking).
- Per license: `checkLicense(license, { ctl })` (logout → settle → login → poll `account.json`), persist result row, emit `check:progress` event `{ running, total, done, failed, current, error }` to the renderer after each license. 1500 ms delay between licenses.
- `cancel()` — stop after the current license finishes.
- Leaves the ExpressVPN app logged out at completion (same as CLI).
- Single job instance; `status()` for late subscribers (renderer asks on load).

## Connect flow (`connectManager.js`) — new capability

State machine `idle → connecting → connected → disconnecting → idle`.

- `connect(license)`:
  1. Guards: ctl exists; store has license; check job not running (mutual exclusion both ways); `connectionState === 'Disconnected'`.
  2. `loginOnly(license)` — the login half of `checkLicense` (no classification, no final logout).
  3. `ctl('connect')` — smart location.
  4. Poll `connectionState` until `Connected` (timeout 30 s → error surfaced to the UI, cleanup back to idle).
  5. Record `currentLicense`; emit `connect:state` events.
- `disconnect()`: `ctl('disconnect')` → wait `Disconnected` (timeout 15 s) → `ctl('logout')` → clear `currentLicense`.
- Refactor in `xvpnChecker.js`: extract the shared login sequence (`waitForLoginResult`, settle/logout helpers) into exported functions used by both `checkLicense` and `connectManager`. CLI behavior unchanged.

## IPC contract

`ipcMain.handle` (request/response):

- `accounts:list` → rows
- `accounts:import` (text) → counts
- `accounts:delete` (license) → boolean
- `accounts:export` → vault-line string (renderer triggers save dialog)
- `check:start` ({filter}) → `{ started, total }` or typed error (`job_running`, `ctl_missing`, `vpn_active`)
- `check:status` → job status
- `check:cancel` → boolean
- `connect:connect` (license) → `{ ok }` or typed error
- `connect:disconnect` → `{ ok }`
- `connect:status` → `{ state, license, email }`
- `ctl:available` → boolean (banner)

Events (main → renderer): `check:progress`, `connect:state`.

Context isolation on; renderer reaches main only through the exposed bridge.

## UI

Single window, dark slate theme matching cookiehub. No login screen.

- Toolbar: state-count pills (valid/expired/canceled/invalid/unknown), Import (paste dialog), Export (save dialog), Check All + filter toggle (all | unknown).
- Table rows: state pill · email · plan · claimed expire/days · live days/expire · payment · checked_at · actions: Copy license, Connect, Delete.
- Connect banner (when active): email + license tail + `Connecting… / Connected` + Disconnect button.
- Warning banner when `ctl:available` is false: import/export/list work; Check + Connect disabled with tooltip.
- Job progress: bar + current license + Cancel.

## Error handling

- Ctl missing (ExpressVPN app not installed / path override wrong): feature-degraded banner, never a crash.
- VPN connected when starting a check: block with message (mirrors old web behavior).
- Login rejected during check → `state='invalid'`, detail recorded; during connect → error surfaced in banner, manager returns to idle after cleanup.
- SQLite in WAL mode; killing the app mid-job loses nothing committed.
- Path override: settings-free v1 — `DEFAULT_CTL` from `xvpnChecker.js` only (YAGNI; CLI already has the same constraint).

## Testing

Vitest, same pattern as `server/test/`. Main-process modules take `(db, ctl)` dependencies → testable without Electron:

- store: parse round-trip of import/export (import accounts.txt fixture → export → identical license set), dedupe/first-wins, upsert counts, sort order.
- checkJob: with a mock `ctl` and mock `checkLicense` — serial order, progress events, filter=unknown, cancel semantics, guard errors.
- connectManager: mock ctl — happy path, login-reject, connect timeout, mutual exclusion with a running job, disconnect cleanup.
- ipc wiring: thin — verified by smoke run.
- Manual smoke: `npm run dev -w desktop` on the real machine (ExpressVPN installed) — seed import, list, one-license check, connect + disconnect against the real daemon.

## Packaging

- electron-builder, Windows targets: NSIS installer + portable exe.
- `better-sqlite3` needs an Electron-ABI rebuild: `electron-rebuild` in `desktop/` postinstall (workspace-scoped, does not touch server's build).
- Output artifacts excluded from git (`.gitignore` addition).

## Non-goals

- Location picker before connect (smart only).
- Encryption/password gate.
- Auto-check scheduling, statistics dashboard, tags/notes.
- macOS/Linux builds (ExpressVPN desktop paths in `xvpnChecker.js` are Windows-first).
- Changes to cookiehub web app or the CLI's behavior.
