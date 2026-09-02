const sleep = ms => new Promise(r => setTimeout(r, ms))
const coded = (code, message) => { const e = new Error(message); e.code = code; return e }

// One-click connect: login with a license (loginOnly), `expressvpnctl
// connect` (smart location), poll until Connected. Disconnect leaves the
// daemon clean: disconnect + logout. Mutually exclusive with the check job
// (isBusy) and with itself.
export function createConnectManager({ login, ctl, state, isBusy, connectTimeoutMs = 30000, disconnectTimeoutMs = 15000, pollMs = 300, onEvent = () => {} }) {
  let st = 'idle'
  let current = null // { license, email }
  let starting = false
  const emit = () => onEvent({ state: st, license: current?.license ?? null, email: current?.email ?? null })
  const cleanup = async () => { try { await ctl(['disconnect'], 90000) } catch { /* best-effort */ } }

  async function connect(license, email) {
    if (st !== 'idle' || starting) throw coded('busy', `connect manager is ${starting ? 'connecting' : st}`)
    if (isBusy()) throw coded('job_running', 'a check job is running')
    starting = true
    let s
    try { s = await state() } finally { starting = false }
    if (s !== 'Disconnected') throw coded('vpn_active', `VPN state is "${s}" — disconnect first`)
    st = 'connecting'; current = { license, email }; emit()
    try {
      const acc = await login(license)
      if (!acc) throw coded('login_rejected', 'server rejected the activation code')
      const r = await ctl(['connect'], 90000)
      if (r.code !== 0) throw coded('connect_failed', (r.err || r.out || `exit ${r.code}`).slice(0, 200))
      const deadline = Date.now() + connectTimeoutMs
      for (;;) {
        const cur = await state()
        if (cur === 'Connected') break
        if (Date.now() > deadline) throw coded('connect_timeout', 'connect timed out waiting for Connected')
        await sleep(pollMs)
      }
      st = 'connected'; emit()
      return { ok: true }
    } catch (e) {
      await cleanup()
      try { await ctl(['logout'], 30000) } catch { /* best-effort */ }
      st = 'idle'; current = null; emit()
      throw e
    }
  }

  async function disconnect() {
    if (st === 'idle') return { ok: true }
    if (st !== 'connected') throw coded('busy', `connect manager is ${st}`)
    st = 'disconnecting'; emit()
    try { await ctl(['disconnect'], 90000) } catch { /* best-effort */ }
    const deadline = Date.now() + disconnectTimeoutMs
    for (;;) {
      const cur = await state()
      if (cur === 'Disconnected' || Date.now() > deadline) break
      await sleep(pollMs)
    }
    try { await ctl(['logout'], 30000) } catch { /* best-effort */ }
    st = 'idle'; current = null; emit()
    return { ok: true }
  }

  return { connect, disconnect, status: () => ({ state: st, license: current?.license ?? null, email: current?.email ?? null }) }
}
