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
        result.live?.payment ?? null, result.detail ?? '', now(), now(), license),
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
