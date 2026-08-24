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
  try { fs.chmodSync('.env', 0o600) } catch { /* best-effort (not supported on Windows) */ }
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
const host = process.env.HOST || '127.0.0.1' // loopback by default: TLS should terminate at the reverse proxy
app.listen(port, host, () => console.log(`[cookiehub] listening on ${host}:${port}`))
