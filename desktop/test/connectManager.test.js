import { describe, it, expect } from 'vitest'
import { createConnectManager } from '../src/main/connectManager.js'

function harness({ loginRes = { activationCode: 'L1', loggedIn: true }, states = {} } = {}) {
  // states: map of call-sequence → connectionState value; default Disconnected
  const calls = []
  let stateSeq = ['Disconnected']
  let login = async () => loginRes
  const mgr = createConnectManager({
    login: (...a) => login(...a),
    ctl: async (cmd) => { calls.push(cmd[0]); return { code: 0, out: '', err: '' } },
    state: async () => stateSeq.length > 1 ? stateSeq.shift() : stateSeq[0],
    isBusy: () => false,
    connectTimeoutMs: 300, disconnectTimeoutMs: 300, pollMs: 1,
  })
  return { mgr, calls, setLogin: fn => (login = fn), setState: seq => (stateSeq = seq) }
}

describe('connectManager', () => {
  it('happy path: login → connect → poll to Connected', async () => {
    const h = harness()
    h.setState(['Disconnected', 'Connecting', 'Connected'])
    const r = await h.mgr.connect('L1', 'a@b.c')
    expect(r).toEqual({ ok: true })
    expect(h.mgr.status()).toMatchObject({ state: 'connected', license: 'L1', email: 'a@b.c' })
    expect(h.calls).toEqual(['connect'])
  })

  it('throws vpn_active when not Disconnected', async () => {
    const h = harness()
    h.setState(['Connected'])
    await expect(h.mgr.connect('L1', 'a@b.c')).rejects.toMatchObject({ code: 'vpn_active' })
    expect(h.mgr.status().state).toBe('idle')
  })

  it('throws job_running when the check job is busy', async () => {
    const h = harness()
    // re-create with busy isBusy
    const mgr = createConnectManager({ login: async () => ({}), ctl: async () => ({ code: 0, out: '', err: '' }), state: async () => 'Disconnected', isBusy: () => true, pollMs: 1 })
    await expect(mgr.connect('L1', 'a@b.c')).rejects.toMatchObject({ code: 'job_running' })
  })

  it('login rejected → cleanup (disconnect+logout) and back to idle', async () => {
    const h = harness()
    h.setLogin(async () => null)
    await expect(h.mgr.connect('L1', 'a@b.c')).rejects.toMatchObject({ code: 'login_rejected' })
    expect(h.calls).toEqual(['disconnect', 'logout'])
    expect(h.mgr.status().state).toBe('idle')
  })

  it('connect timeout → cleanup and idle', async () => {
    const h = harness()
    h.setState(['Disconnected', 'Connecting', 'Connecting', 'Connecting', 'Connecting'])
    await expect(h.mgr.connect('L1', 'a@b.c')).rejects.toMatchObject({ code: 'connect_timeout' })
    expect(h.calls).toEqual(['connect', 'disconnect', 'logout'])
    expect(h.mgr.status().state).toBe('idle')
  })

  it('login_failed propagates the code with cleanup', async () => {
    const h = harness()
    const e = new Error('ctl boom'); e.code = 'login_failed'
    h.setLogin(async () => { throw e })
    await expect(h.mgr.connect('L1', 'a@b.c')).rejects.toMatchObject({ code: 'login_failed' })
    expect(h.mgr.status().state).toBe('idle')
  })

  it('disconnect: waits for Disconnected then logs out', async () => {
    const h = harness()
    h.setState(['Disconnected', 'Connected', 'Disconnecting', 'Disconnected'])
    await h.mgr.connect('L1', 'a@b.c')
    h.setState(['Disconnecting', 'Disconnected'])
    const r = await h.mgr.disconnect()
    expect(r).toEqual({ ok: true })
    expect(h.calls).toEqual(['connect', 'disconnect', 'logout'])
    expect(h.mgr.status()).toMatchObject({ state: 'idle', license: null })
  })

  it('connect while manager busy → busy error', async () => {
    const h = harness()
    h.setState(['Disconnected', 'Connected'])
    const p = h.mgr.connect('L1', 'a@b.c')
    await expect(h.mgr.connect('L2', 'x@y.z')).rejects.toMatchObject({ code: 'busy' })
    await p
  })

  it('disconnect finalizes to idle when state polling rejects', async () => {
    const calls = []
    let stateCalls = 0
    let rejectState = false
    const mgr = createConnectManager({
      login: async () => ({ activationCode: 'L1', loggedIn: true }),
      ctl: async (cmd) => { calls.push(cmd[0]); return { code: 0, out: '', err: '' } },
      state: async () => {
        if (rejectState) throw new Error('state boom')
        stateCalls += 1
        return stateCalls === 1 ? 'Disconnected' : 'Connected'
      },
      isBusy: () => false,
      pollMs: 1,
    })
    await mgr.connect('L1', 'a@b.c')
    rejectState = true

    await expect(mgr.disconnect()).rejects.toThrow('state boom')
    expect(calls).toEqual(['connect', 'disconnect', 'logout'])
    expect(mgr.status()).toEqual({ state: 'idle', license: null, email: null })
  })

  it('disconnect during connect preflight throws busy', async () => {
    let releaseProbe
    let stateCalls = 0
    const mgr = createConnectManager({
      login: async () => ({ activationCode: 'L1', loggedIn: true }),
      ctl: async () => ({ code: 0, out: '', err: '' }),
      state: async () => {
        stateCalls += 1
        if (stateCalls === 1) return new Promise(resolve => { releaseProbe = resolve })
        return 'Connected'
      },
      isBusy: () => false,
      pollMs: 1,
    })

    const connecting = mgr.connect('L1', 'a@b.c')
    await expect(mgr.disconnect()).rejects.toMatchObject({ code: 'busy' })
    releaseProbe('Disconnected')
    await connecting
    expect(mgr.status().state).toBe('connected')
  })

  it('connecting event failure cleans up and returns to idle', async () => {
    const calls = []
    const eventError = new Error('event sink boom')
    const mgr = createConnectManager({
      login: async () => ({ activationCode: 'L1', loggedIn: true }),
      ctl: async (cmd) => { calls.push(cmd[0]); return { code: 0, out: '', err: '' } },
      state: async () => 'Disconnected',
      isBusy: () => false,
      onEvent: () => { throw eventError },
    })

    await expect(mgr.connect('L1', 'a@b.c')).rejects.toBe(eventError)
    expect(calls).toEqual(['disconnect', 'logout'])
    expect(mgr.status()).toEqual({ state: 'idle', license: null, email: null })
  })

  it('disconnecting event failure cleans up and returns to idle', async () => {
    const calls = []
    const eventError = new Error('event sink boom')
    const mgr = createConnectManager({
      login: async () => ({ activationCode: 'L1', loggedIn: true }),
      ctl: async (cmd) => { calls.push(cmd[0]); return { code: 0, out: '', err: '' } },
      state: async () => calls.includes('connect') ? 'Connected' : 'Disconnected',
      isBusy: () => false,
      onEvent: event => {
        if (event.state === 'disconnecting') throw eventError
      },
    })
    await mgr.connect('L1', 'a@b.c')

    await expect(mgr.disconnect()).rejects.toBe(eventError)
    expect(calls).toEqual(['connect', 'disconnect', 'logout'])
    expect(mgr.status()).toEqual({ state: 'idle', license: null, email: null })
  })
})
