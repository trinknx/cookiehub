import { Router } from 'express'
export function serviceRoutes() { const r = Router(); r.all('*', (req, res) => res.status(501).json({ error: { code: 'not_implemented', message: 'pending' } })); return r }
