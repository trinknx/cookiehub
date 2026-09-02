import { describe, it, expect } from 'vitest'
import { openStore } from '../src/main/store.js'
import { parseAccountLine } from '../../tools/expressvpn/xvpnChecker.js'

const LINE = 'mn2927958@gmail.com:pa:ss@1 | OVPNUser=9frg | OVPNPass=bejp | Plan=1mo | Expire=2026-08-30 | Days=6 | AutoRenew=true | Payment=UNKNOWN | Gateway=UNKNOWN | Status=ACTIVE | License=EV5GA3G2E7GLIWTARBWWODF | PPTP=acdtk3/1l1y133g'
const LINE2 = LINE.replace('EV5GA3G2E7GLIWTARBWWODF', 'EXPIREDDD00000000000000A')

describe('store', () => {
  it('imports vault lines, skips junk, counts imported/updated/lines', () => {
    const s = openStore()
    const junk = 'JOIN FOR MORE : https://t.me/x\n——————\n'
    expect(s.importText(junk + LINE)).toEqual({ imported: 1, updated: 0, lines: 1 })
    expect(s.importText(LINE.replace('Days=6', 'Days=5'))).toEqual({ imported: 0, updated: 1, lines: 1 })
    expect(s.importText(`${LINE}\n${LINE}`)).toEqual({ imported: 0, updated: 1, lines: 1 }) // in-paste duplicate: first wins, single upsert
    expect(s.count()).toBe(1)
  })

  it('round-trips export through parseAccountLine with identical license set', () => {
    const s = openStore()
    s.importText(`${LINE}\n${LINE2}`)
    const out = s.exportLines()
    const parsed = out.split(/\r?\n/).filter(Boolean).map(parseAccountLine)
    expect(new Set(parsed.map(p => p.license))).toEqual(new Set(['EV5GA3G2E7GLIWTARBWWODF', 'EXPIREDDD00000000000000A']))
    expect(parsed[0].password).toBe('pa:ss@1')
    expect(parsed[0].extras.Plan).toBe('1mo')
    expect(parsed[0].extras.PPTP).toBe('acdtk3/1l1y133g')
  })

  it('lists sorted by state rank then live_days desc', () => {
    const s = openStore()
    s.importText(`${LINE}\n${LINE2}`)
    s.applyResult('EV5GA3G2E7GLIWTARBWWODF', { state: 'valid', detail: '', live: { daysRemaining: 10, expireIso: '2026-09-12', payment: 'card' } })
    s.applyResult('EXPIREDDD00000000000000A', { state: 'expired', detail: 'no days remaining', live: null })
    const rows = s.list()
    expect(rows.map(r => r.state)).toEqual(['valid', 'expired'])
    expect(rows[0].live_days).toBe(10)
    expect(rows[0].checked_at).toBeGreaterThan(0)
  })

  it('selectLicenses honors filter', () => {
    const s = openStore()
    s.importText(`${LINE}\n${LINE2}`)
    expect(s.selectLicenses('all')).toHaveLength(2)
    expect(s.selectLicenses('unknown')).toHaveLength(2)
    s.applyResult('EXPIREDDD00000000000000A', { state: 'valid', detail: '', live: null })
    expect(s.selectLicenses('unknown')).toEqual(['EV5GA3G2E7GLIWTARBWWODF'])
  })

  it('get + remove', () => {
    const s = openStore()
    s.importText(LINE)
    expect(s.get('EV5GA3G2E7GLIWTARBWWODF').email).toBe('mn2927958@gmail.com')
    expect(s.remove('EV5GA3G2E7GLIWTARBWWODF')).toBe(true)
    expect(s.remove('EV5GA3G2E7GLIWTARBWWODF')).toBe(false)
    expect(s.count()).toBe(0)
  })
})
