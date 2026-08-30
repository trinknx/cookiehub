import path from 'node:path'
import express from 'express'
import cookieParser from 'cookie-parser'
import { authRoutes, requireAuth, csrfGuard } from './routes/auth.js'
import { cookieRoutes } from './routes/cookies.js'
import { serviceRoutes } from './routes/services.js'
import { settingsRoutes } from './routes/settings.js'
import { backupRoutes } from './routes/backup.js'

export function buildApp({ db, adapters, engine, scheduler }) {
  const app = express()
  // behind Caddy every client is 127.0.0.1; trust one proxy hop so req.ip (rate limiting)
  // honors X-Forwarded-For instead of sharing one global bucket
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1)
  app.use(express.json({ limit: '12mb' })) // bulk import: up to 5000 × 100KB chunks; theoretical max far exceeds this cap — oversized payloads are rejected here, real bulk folders (2000+ files) run well under it
  app.use(cookieParser())
  // csrfGuard before authRoutes: login/setup/logout are state-changing and must not be CSRF-able
  app.use('/api/auth', csrfGuard, authRoutes(db))
  app.use('/api', requireAuth(db), csrfGuard)
  app.use('/api/cookies', cookieRoutes({ db, engine, adapters }))
  app.use('/api/services', serviceRoutes({ db, adapters }))
  app.use('/api/settings', settingsRoutes({ db, scheduler }))
  app.use('/api/backup', backupRoutes({ db }))
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'unknown api route' } }))
  // Single-port mode: serve the built client alongside the API (vite dev with
  // its proxy is for development only). Resolved from this file so the server
  // cwd doesn't matter; a missing dist just falls through to the SPA 404s.
  const dist = path.resolve(import.meta.dirname, '../../client/dist')
  app.use(express.static(dist))
  app.use((req, res, next) => { // SPA fallback — client-side routes like /login
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
    res.sendFile(path.join(dist, 'index.html'))
  })
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(err.status || 500).json({ error: { code: err.code || 'internal', message: err.message || 'internal error' } })
  })
  return app
}
