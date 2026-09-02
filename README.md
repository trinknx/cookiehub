# CookieHub

Personal single-user cookie manager (Netscape + header string) with live/die checks, plus Netflix payment-hold detection, for Netflix, Spotify, and any service you add an adapter for. Not for public use.

## Features

- Import/export cookies as Netscape or header string (auto-detected, bulk import via blank-line separation)
- Import Cookie-Editor JSON array files (bulk files with mixed text — JSON arrays auto-extracted)
- LIVE/DIE checks with account info (email, plan, expiry, country where available); Netflix payment holds use a separate ON HOLD status and cleanup action
- Manual per-cookie / check-all + scheduled auto-check (interval-based, 1-168h)
- Per-service or global proxy support (http/https/socks5)
- Cookies encrypted at rest (AES-256-GCM); single-password login (argon2id); login rate limiting
- Add a service: drop an adapter file in `server/src/adapters/` and restart

## Requirements

- Node.js ≥ 20
- Python 3 with `curl_cffi` (`pip install curl_cffi`) — required for ChatGPT checks: chatgpt.com sits behind a Cloudflare browser challenge that blocks Node TLS fingerprints; checks route through a Chrome-impersonated curl and record `error` (not `die`) when it is unavailable
- A reverse proxy with TLS (Caddy config in `deploy/`)

## Run

```bash
npm install
npm run build     # build client
npm start         # serves API + client on :3000
```
The server binds loopback only (`127.0.0.1`) so TLS terminates at the reverse proxy; set `HOST=0.0.0.0` to expose it directly at your own risk.

First run generates `.env` with `ENCRYPTION_KEY` (keep it safe — losing it loses all stored cookies) and asks you to create the admin password in the UI.

### Docker (Linux)

```bash
# server/.env must carry ENCRYPTION_KEY before first start (generate: openssl rand -base64 32)
docker compose up -d --build   # app on :3000, SQLite data persisted in ./server/data
```

The image bundles python3 + `curl_cffi` (ChatGPT/Claude checks work out of the box). `ENCRYPTION_KEY`/`PORT` may also be passed as plain env vars — env vars win over the `.env` file. A key generated *inside* a container is ephemeral and would make every stored cookie unreadable after recreation, so always provide one. Do not set `NODE_ENV=production` unless the container runs behind a trusted reverse proxy (it enables `trust proxy`).

## ExpressVPN license checker (local CLI)

The ExpressVPN vault is managed outside the app. `tools/expressvpn/` is a self-contained CLI that drives the local ExpressVPN desktop app (`expressvpnctl`) — live checks need the app installed at its default path, i.e. Windows:

```bash
node tools/expressvpn/check-licenses.mjs [--file accounts.txt] [--delay 1500]
```

Reads `tools/expressvpn/accounts.txt`, writes `report.csv`/`report.json` next to it. The former in-app vault was exported there.

> **Note (fresh clones):** npm may block install scripts for native modules (`better-sqlite3`, `esbuild`). If `npm install` output mentions blocked scripts, run `npm approve-scripts` (or configure allowed scripts per your npm version) and re-run `npm install` / `npm rebuild better-sqlite3 esbuild`.

## Deploy (Linux VPS)

```bash
# 1. install app to /opt/cookiehub (the path the systemd unit expects)
sudo install -d -o "$USER" -g "$USER" /opt/cookiehub
git clone <your-repo-url> /opt/cookiehub
cd /opt/cookiehub && npm install && npm run build

# 2. systemd unit
sudo cp deploy/cookiehub.service /etc/systemd/system/
sudo systemctl enable --now cookiehub

# 3. Caddy (automatic HTTPS)
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Point your domain in `deploy/Caddyfile` first.
If npm blocks the native module install scripts on the VPS, see the note in [Run](#run) and rebuild there.

## Dev

Run each in its own terminal:

```bash
npm run dev -w server   # terminal 1: API server (node --watch)
npm run dev -w client   # terminal 2: vite dev server with /api proxy
npm test                # vitest suite
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
