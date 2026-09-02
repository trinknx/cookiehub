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

describe('ipc', () => {
  it('registers every channel the preload uses', () => {
    const ipcMain = fakeIpcMain()
    registerIpc({ ipcMain, store: store(), checkJob: { start: () => ({ started: true, total: 1 }), status: () => ({ running: false }), cancel: () => true }, connectManager: { connect: async () => ({ ok: true }), disconnect: async () => ({ ok: true }), status: () => ({ state: 'idle' }) }, ctlAvailable: true, connectionState: async () => 'Disconnected', send: () => {} })
    expect(ipcMain.channels().sort()).toEqual(['accounts:delete', 'accounts:export', 'accounts:import', 'accounts:list', 'check:cancel', 'check:start', 'check:status', 'connect:connect', 'connect:disconnect', 'connect:status', 'ctl:available'])
  })

  it('accounts:list returns rows', async () => {
    const ipcMain = fakeIpcMain()
    registerIpc({ ipcMain, store: store(), checkJob: { start: () => {}, status: () => ({}), cancel: () => true }, connectManager: { connect: async () => {}, disconnect: async () => {}, status: () => ({}) }, ctlAvailable: true, connectionState: async () => 'Disconnected', send: () => {} })
    expect(await ipcMain.invoke('accounts:list')).toEqual([{ license: 'L1', email: 'a@b.c' }])
  })

  it('check:start guards: ctl missing → ctl_missing; vpn active → vpn_active', async () => {
    const ipcMain = fakeIpcMain()
    const reg = (ctlOk, st) => registerIpc({ ipcMain, store: store(), checkJob: { start: () => ({ started: true, total: 1 }), status: () => ({ running: false }), cancel: () => true }, connectManager: { connect: async () => {}, disconnect: async () => {}, status: () => ({}) }, ctlAvailable: ctlOk, connectionState: async () => st, send: () => {} })
    reg(false, 'Disconnected')
    await expect(ipcMain.invoke('check:start', 'all')).rejects.toMatchObject({ code: 'ctl_missing' })
    reg(true, 'Connected')
    await expect(ipcMain.invoke('check:start', 'all')).rejects.toMatchObject({ code: 'vpn_active' })
  })

  it('errors from deps surface as { code, message } rejections', async () => {
    const ipcMain = fakeIpcMain()
    registerIpc({ ipcMain, store: store(), checkJob: { start: () => { const e = new Error('a check job is already running'); e.code = 'job_running'; throw e }, status: () => ({ running: false }), cancel: () => true }, connectManager: { connect: async () => {}, disconnect: async () => {}, status: () => ({}) }, ctlAvailable: true, connectionState: async () => 'Disconnected', send: () => {} })
    await expect(ipcMain.invoke('check:start', 'all')).rejects.toMatchObject({ code: 'job_running' })
  })
})
