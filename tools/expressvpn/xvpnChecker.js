import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const DEFAULT_CTL = 'C:\\Program Files\\ExpressVPN\\expressvpnctl.exe'
export const DEFAULT_ACCOUNT_JSON = 'C:\\Program Files\\ExpressVPN\\data\\account.json'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// One vault line:
//   email:password | OVPNUser=... | OVPNPass=... | Plan=1mo | Expire=2026-08-30 |
//   Days=6 | AutoRenew=true | Payment=... | Gateway=... | Status=ACTIVE |
//   License=EXXXX... | PPTP=user/pass | By: whatever
// Fields after the first segment are Key=Value, order-free; unknown keys are
// kept in extras. Returns null when the line carries no License= (headers,
// banners, junk). The password may itself contain ':' — split on the first.
export function parseAccountLine(line) {
  const raw = String(line).trim()
  if (!raw || !raw.includes('License=')) return null
  const parts = raw.split('|').map(p => p.trim())
  const [email, ...pw] = (parts.shift() || '').split(':')
  const acc = { email: (email || '').trim(), password: pw.join(':').trim(), extras: {} }
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) acc.extras[k] = v
  }
  const license = acc.extras.License
  if (!license) return null
  acc.license = license
  return acc
}

// credential blob for at-rest encryption: everything sensitive, nothing the
// list/sort queries need
export function credsOf(acc) {
  return {
    password: acc.password,
    ovpnUser: acc.extras.OVPNUser || '',
    ovpnPass: acc.extras.OVPNPass || '',
    pptp: acc.extras.PPTP || '',
  }
}

// non-sensitive claimed metadata straight from the vault line
export function metaOf(acc) {
  return {
    plan: acc.extras.Plan || '',
    expire: acc.extras.Expire || '',
    days: acc.extras.Days || '',
    autoRenew: acc.extras.AutoRenew || '',
    payment: acc.extras.Payment || '',
    gateway: acc.extras.Gateway || '',
    status: acc.extras.Status || '',
  }
}

export function makeCtl(ctlPath = DEFAULT_CTL) {
  return (cmd, timeoutMs = 60000) => new Promise(resolve => {
    const p = spawn(ctlPath, cmd, { windowsHide: true })
    let out = '', err = ''
    const t = setTimeout(() => p.kill(), timeoutMs)
    p.stdout.on('data', d => (out += d))
    p.stderr.on('data', d => (err += d))
    p.on('close', code => { clearTimeout(t); resolve({ code: code ?? -1, out: out.trim(), err: err.trim() }) })
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, out: '', err: String(e) }) })
  })
}

export async function connectionState(ctl) {
  const r = await ctl(['get', 'connectionstate'], 15000)
  return r.out.split('\n')[0].trim()
}

async function readAccountJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

// The daemon persists account.json in stages: activationCode lands first,
// loggedIn=true only after the server confirms. A frame with activationCode
// set but loggedIn=false is intermediate OR a genuine rejection — only time
// separates them, so wait for loggedIn; classify as rejected on timeout.
async function waitForLoginResult(license, accountJsonPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const acc = await readAccountJson(accountJsonPath)
    if (acc && acc.activationCode === license && acc.loggedIn) return acc
    if (Date.now() > deadline) return null
    await sleep(300)
  }
}

// Login sequence shared by checkLicense (probe) and the desktop app's
// connectManager: logout + settle, login, poll for server confirmation.
// Returns the confirmed account frame, or null when the server rejected the
// code (loggedIn never turned true in time). Throws Error{code:'login_failed'}
// when the ctl login itself exits non-zero.
export async function loginOnly(license, {
  ctl = makeCtl(),
  accountJsonPath = DEFAULT_ACCOUNT_JSON,
  settleMs = 1500,
  confirmTimeoutMs = 20000,
  tmpDir,
} = {}) {
  const dir = tmpDir || mkdtempSync(path.join(tmpdir(), 'xvpn-'))
  const keyFile = path.join(dir, 'key.txt')
  writeFileSync(keyFile, license, { flag: 'w' })
  try {
    await ctl(['logout'], 30000)
    const logoutDeadline = Date.now() + 10000
    for (;;) {
      const a = await readAccountJson(accountJsonPath)
      if (!a || !a.loggedIn) break
      if (Date.now() > logoutDeadline) break
      await sleep(300)
    }
    await sleep(settleMs)

    const login = await ctl(['login', keyFile], 90000)
    if (login.code !== 0) {
      const e = new Error((login.err || login.out || `exit ${login.code}`).slice(0, 200))
      e.code = 'login_failed'
      throw e
    }
    return await waitForLoginResult(license, accountJsonPath, confirmTimeoutMs)
  } finally {
    try { unlinkSync(keyFile) } catch { /* already gone */ }
    if (tmpDir === undefined) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ } }
  }
}

// Full login probe for one license: login via loginOnly, then classify the
// account frame. Same sequence and detail strings as before the extraction.
export async function checkLicense(license, opts = {}) {
  const result = { state: 'invalid', detail: '', live: null }
  let acc
  try {
    acc = await loginOnly(license, opts)
  } catch (e) {
    result.detail = e.message
    return result
  }
  if (!acc) {
    result.detail = 'server rejected the activation code (no confirmation in time)'
    return result
  }
  result.state = 'valid'
  result.live = {
    active: acc.active,
    expired: acc.expired,
    canceled: acc.canceled,
    daysRemaining: acc.daysRemaining,
    expireIso: acc.expirationTime ? new Date(acc.expirationTime).toISOString().slice(0, 10) : '',
    payment: acc.paymentMethod || '',
    recurring: !!acc.recurring,
    isTrial: !!acc.isTrial,
  }
  if (acc.canceled) { result.state = 'canceled'; result.detail = 'subscription canceled' }
  else if (acc.expired || (acc.daysRemaining ?? 0) <= 0) { result.state = 'expired'; result.detail = 'no days remaining' }
  return result
}
