import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loginOnly, checkLicense } from '../../tools/expressvpn/xvpnChecker.js'

const LICENSE = 'ETESTLICENSE00000000000A'

function fakeAccountJson(dir) {
  const p = path.join(dir, 'account.json')
  writeFileSync(p, JSON.stringify({ loggedIn: false }), 'utf8') // start logged out
  return {
    path: p,
    set: (obj) => writeFileSync(p, JSON.stringify(obj), 'utf8'),
  }
}

// ctl stub: records commands, lets the test drive account.json on login
function fakeCtl(account) {
  const calls = []
  const ctl = async (cmd) => {
    calls.push(cmd[0])
    if (cmd[0] === 'login') account.set({ activationCode: LICENSE, loggedIn: true, daysRemaining: 12, expirationTime: '2026-09-20T00:00:00Z', paymentMethod: 'chargeBeeCreditCard' })
    return { code: 0, out: '', err: '' }
  }
  ctl.calls = calls
  return ctl
}

describe('loginOnly', () => {
  it('logs in and resolves the confirmed account frame', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lo-'))
    const account = fakeAccountJson(dir)
    const ctl = fakeCtl(account)
    const acc = await loginOnly(LICENSE, { ctl, accountJsonPath: account.path, settleMs: 1, confirmTimeoutMs: 1000, tmpDir: dir })
    expect(acc.activationCode).toBe(LICENSE)
    expect(acc.loggedIn).toBe(true)
    expect(ctl.calls[0]).toBe('logout')
    expect(ctl.calls[1]).toBe('login')
  })

  it('resolves null when the server never confirms (rejected code)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lo-'))
    const account = fakeAccountJson(dir)
    const ctl = async (cmd) => { if (cmd[0] === 'login') account.set({ activationCode: LICENSE, loggedIn: false }); return { code: 0, out: '', err: '' } }
    const acc = await loginOnly(LICENSE, { ctl, accountJsonPath: account.path, settleMs: 1, confirmTimeoutMs: 500, tmpDir: dir })
    expect(acc).toBeNull()
  })

  it('throws login_failed when ctl login exits non-zero', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lo-'))
    const account = fakeAccountJson(dir)
    const ctl = async (cmd) => (cmd[0] === 'login' ? { code: 3, out: '', err: 'boom' } : { code: 0, out: '', err: '' })
    await expect(loginOnly(LICENSE, { ctl, accountJsonPath: account.path, settleMs: 1, confirmTimeoutMs: 500, tmpDir: dir }))
      .rejects.toMatchObject({ code: 'login_failed', message: 'boom' })
  })

  it('checkLicense still classifies via the shared sequence', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lo-'))
    const account = fakeAccountJson(dir)
    const ctl = fakeCtl(account)
    const r = await checkLicense(LICENSE, { ctl, accountJsonPath: account.path, settleMs: 1, confirmTimeoutMs: 1000, tmpDir: dir })
    expect(r.state).toBe('valid')
    expect(r.live.daysRemaining).toBe(12)
    expect(r.live.payment).toBe('chargeBeeCreditCard')
  })

  it('checkLicense propagates non-login failures instead of classifying them invalid', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lo-'))
    const account = fakeAccountJson(dir)
    const ctl = async () => { throw new Error('disk full') }
    await expect(checkLicense(LICENSE, { ctl, accountJsonPath: account.path, settleMs: 1, confirmTimeoutMs: 500, tmpDir: dir }))
      .rejects.toMatchObject({ message: 'disk full' })
  })
})
