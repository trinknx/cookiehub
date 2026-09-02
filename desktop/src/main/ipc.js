// Thin wiring: every preload invoke maps to one handler here. Guards that
// need the ctl (availability, VPN state) live here, not in the modules, so
// store/checkJob/connectManager stay electron-free.
// Handlers never throw across the IPC boundary: ipcMain.handle rejections are
// re-created renderer-side and lose custom properties (err.code), so wrap()
// answers with a plain envelope — { ok:true, data } | { ok:false, code,
// message } — which the preload unwraps into a real Error carrying .code.
const wrap = fn => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) } }
  catch (err) { return { ok: false, code: err.code || 'internal', message: err.message || String(err) } }
}

const coded = (code, message) => Object.assign(new Error(message), { code })

export function registerIpc({ ipcMain, store, checkJob, connectManager, ctlAvailable, connectionState, saveExport }) {
  ipcMain.handle('ctl:available', wrap(async () => ctlAvailable))
  ipcMain.handle('accounts:list', wrap(async () => store.list()))
  ipcMain.handle('accounts:import', wrap(async (text) => store.importText(text)))
  ipcMain.handle('accounts:delete', wrap(async (license) => ({ deleted: store.remove(license) })))
  ipcMain.handle('accounts:export', wrap(async () => store.exportLines()))
  ipcMain.handle('accounts:exportFile', wrap(async () => saveExport(await store.exportLines())))

  ipcMain.handle('check:start', wrap(async (filter = 'all') => {
    if (checkJob.status().running) throw coded('job_running', 'a check job is already running')
    if (!ctlAvailable) throw coded('ctl_missing', `expressvpnctl not found — install the ExpressVPN app`)
    const st = await connectionState()
    if (st !== 'Disconnected') throw coded('vpn_active', `VPN state is "${st}" — disconnect before checking`)
    if (connectManager.status().state !== 'idle') throw coded('connect_active', 'a connect flow is active')
    return checkJob.start(filter)
  }))
  ipcMain.handle('check:status', wrap(async () => checkJob.status()))
  ipcMain.handle('check:cancel', wrap(async () => ({ cancelled: checkJob.cancel() })))

  ipcMain.handle('connect:connect', wrap(async (license) => {
    if (!ctlAvailable) throw coded('ctl_missing', `expressvpnctl not found — install the ExpressVPN app`)
    const row = store.get(license)
    if (!row) throw coded('not_found', 'no such license')
    return connectManager.connect(license, row.email)
  }))
  ipcMain.handle('connect:disconnect', wrap(async () => connectManager.disconnect()))
  ipcMain.handle('connect:status', wrap(async () => connectManager.status()))
}
