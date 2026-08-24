# CookieHub

Personal single-user cookie manager (Netscape + header string) with live/die checks for Netflix, Spotify, and any service you add an adapter for. Not for public use.

## Features

- Import/export cookies as Netscape or header string (auto-detected, bulk import via blank-line separation)
- LIVE/DIE checks with account info (email, plan, expiry, country where available)
- Manual per-cookie / check-all + scheduled auto-check (interval-based, 1-168h)
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
