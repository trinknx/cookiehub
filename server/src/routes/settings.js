import { Router } from 'express'
export function settingsRoutes() { const r = Router(); r.all('*', (req, res) => res.status(501).json({ error: { code: 'not_implemented', message: 'pending' } })); return r }
