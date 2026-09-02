import { describe, it, expect } from 'vitest'
import { openStore } from '../src/main/store.js'
import { parseAccountLine } from '../../tools/expressvpn/xvpnChecker.js'

const LINE = 'fixture@example.invalid:pa:ss@1 | OVPNUser=testu1 | OVPNPass=testp1 | Plan=1mo | Expire=2026-08-30 | Days=6 | AutoRenew=true | Payment=UNKNOWN | Gateway=UNKNOWN | Status=ACTIVE | License=ETESTLICENSE00000000000A | PPTP=testpp/te5tpa55'
const LINE2 = LINE.replace('ETESTLICENSE00000000000A', 'EXPIREDDD00000000000000A')

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
    expect(new Set(parsed.map(p => p.license))).toEqual(new Set(['ETESTLICENSE00000000000A', 'EXPIREDDD00000000000000A']))
    expect(parsed[0].password).toBe('pa:ss@1')
    expect(parsed[0].extras.Plan).toBe('1mo')
    expect(parsed[0].extras.PPTP).toBe('testpp/te5tpa55')
  })

  it('lists sorted by state rank then live_days desc', () => {
    const s = openStore()
    s.importText(`${LINE}\n${LINE2}`)
    s.applyResult('ETESTLICENSE00000000000A', { state: 'valid', detail: '', live: { daysRemaining: 10, expireIso: '2026-09-12', payment: 'card' } })
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
    expect(s.selectLicenses('unknown')).toEqual(['ETESTLICENSE00000000000A'])
  })

  it('get + remove', () => {
    const s = openStore()
    s.importText(LINE)
    expect(s.get('ETESTLICENSE00000000000A').email).toBe('fixture@example.invalid')
    expect(s.remove('ETESTLICENSE00000000000A')).toBe(true)
    expect(s.remove('ETESTLICENSE00000000000A')).toBe(false)
    expect(s.count()).toBe(0)
  })
})
