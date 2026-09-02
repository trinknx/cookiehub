import { describe, it, expect } from 'vitest'
import { registerIpc } from '../src/main/ipc.js'

function fakeIpcMain() {
  const handlers = new Map()
  return {
    handle: (ch, fn) => handlers.set(ch, fn),
    invoke: (ch, ...args) => { const fn = handlers.get(ch); if (!fn) throw new Error(`no handler for ${ch}`); return fn({}, ...args) },
    channels: () => [...handlers.keys()],
  }
}

const store = () => {
  const rows = [{ license: 'L1', email: 'a@b.c' }]
  return {
    list: () => rows,
    get: l => rows.find(r => r.license === l),
    remove: () => true,
    importText: () => ({ imported: 1, updated: 0, lines: 1 }),
    exportLines: () => 'a:b | License=L1\n',
    selectLicenses: () => ['L1'],
    applyResult: () => {},
  }
}

const deps = over => ({
  store: store(),
  checkJob: { start: () => ({ started: true, total: 1 }), status: () => ({ running: false }), cancel: () => true },
  connectManager: { connect: async () => ({ connected: true }), disconnect: async () => ({ ok: true }), status: () => ({ state: 'idle' }) },
  ctlAvailable: true,
  connectionState: async () => 'Disconnected',
  saveExport: async () => ({ path: 'C:/out/accounts-export.txt' }),
  ...over,
})

describe('ipc', () => {
  it('registers every channel the preload uses', () => {
    const ipcMain = fakeIpcMain()
    registerIpc(deps({ ipcMain }))
    expect(ipcMain.channels().sort()).toEqual(['accounts:delete', 'accounts:export', 'accounts:exportFile', 'accounts:import', 'accounts:list', 'check:cancel', 'check:start', 'check:status', 'connect:connect', 'connect:disconnect', 'connect:status', 'ctl:available'])
  })

  it('success answers with the { ok, data } envelope', async () => {
    const ipcMain = fakeIpcMain()
    registerIpc(deps({ ipcMain }))
    expect(await ipcMain.invoke('accounts:list')).toEqual({ ok: true, data: [{ license: 'L1', email: 'a@b.c' }] })
  })

  it('check:start guards: ctl missing → ctl_missing; vpn active → vpn_active (as envelope, never a throw)', async () => {
    const ipcMain = fakeIpcMain()
    registerIpc(deps({ ipcMain, ctlAvailable: false }))
    const missing = await ipcMain.invoke('check:start', 'all')
    expect(missing).toMatchObject({ ok: false, code: 'ctl_missing' })
    expect(missing.message).toEqual(expect.any(String))

    registerIpc(deps({ ipcMain, connectionState: async () => 'Connected' }))
    const active = await ipcMain.invoke('check:start', 'all')
    expect(active).toMatchObject({ ok: false, code: 'vpn_active' })
    expect(Object.keys(active).sort()).toEqual(['code', 'message', 'ok'])
  })

  it('errors from deps surface as { ok:false, code, message } envelopes', async () => {
    const ipcMain = fakeIpcMain()
    registerIpc(deps({ ipcMain, checkJob: { start: () => { const e = new Error('a check job is already running'); e.code = 'job_running'; throw e }, status: () => ({ running: false }), cancel: () => true } }))
    const r = await ipcMain.invoke('check:start', 'all')
    expect(r).toEqual({ ok: false, code: 'job_running', message: 'a check job is already running' })
  })

  it('check:start rejects connect_active while a connect flow is active', async () => {
    const ipcMain = fakeIpcMain()
    registerIpc(deps({ ipcMain, connectManager: { connect: async () => ({}), disconnect: async () => ({}), status: () => ({ state: 'connecting' }) } }))
    const r = await ipcMain.invoke('check:start', 'all')
    expect(r).toEqual({ ok: false, code: 'connect_active', message: 'a connect flow is active' })
  })

  it('accounts:exportFile pipes store.exportLines through saveExport', async () => {
    const ipcMain = fakeIpcMain()
    const seen = []
    registerIpc(deps({ ipcMain, saveExport: async text => { seen.push(text); return { path: 'C:/tmp/accounts-export.txt' } } }))
    const r = await ipcMain.invoke('accounts:exportFile')
    expect(seen).toEqual(['a:b | License=L1\n'])
    expect(r).toEqual({ ok: true, data: { path: 'C:/tmp/accounts-export.txt' } })
  })
})
