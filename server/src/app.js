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
