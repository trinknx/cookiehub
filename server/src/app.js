import express from 'express'
import cookieParser from 'cookie-parser'
import { authRoutes, requireAuth, csrfGuard } from './routes/auth.js'
import { cookieRoutes } from './routes/cookies.js'
import { serviceRoutes } from './routes/services.js'
import { settingsRoutes } from './routes/settings.js'

export function buildApp({ db, adapters, engine, scheduler }) {
  const app = express()
  // behind Caddy every client is 127.0.0.1; trust one proxy hop so req.ip (rate limiting)
  // honors X-Forwarded-For instead of sharing one global bucket
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1)
  app.use(express.json({ limit: '12mb' })) // spec bulk import: up to 500 × 100KB chunks; theoretical 50MB max exceeds this cap — oversized payloads are rejected here, real bulk files run ~1-2MB
  app.use(cookieParser())
  // csrfGuard before authRoutes: login/setup/logout are state-changing and must not be CSRF-able
  app.use('/api/auth', csrfGuard, authRoutes(db))
  app.use('/api', requireAuth(db), csrfGuard)
  app.use('/api/cookies', cookieRoutes({ db, engine, adapters }))
  app.use('/api/services', serviceRoutes({ db, adapters }))
  app.use('/api/settings', settingsRoutes({ db, scheduler }))
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'unknown api route' } }))
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(err.status || 500).json({ error: { code: err.code || 'internal', message: err.message || 'internal error' } })
  })
  return app
}
