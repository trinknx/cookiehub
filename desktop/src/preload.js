const { contextBridge, ipcRenderer } = require('electron')

// subscribe helper: returns an unsubscribe function
const sub = (ch, cb) => {
  const fn = (_e, v) => cb(v)
  ipcRenderer.on(ch, fn)
  return () => ipcRenderer.removeListener(ch, fn)
}

// Main handlers answer with a plain envelope — { ok:true, data } |
// { ok:false, code, message } — because ipcMain.handle rejections are
// re-created renderer-side and lose custom properties (err.code). contextBridge
// likewise reconstructs thrown Errors with `message` only, so unwrap() embeds
// the code in the message itself: '[<code>] <message>' (plain '<message>' when
// there is no code) — the only shape that survives both boundaries intact.
const unwrap = p => p.then(r => {
  if (r && r.ok === false) throw new Error(r.code ? `[${r.code}] ${r.message}` : r.message)
  return r.data
})
contextBridge.exposeInMainWorld('xvpn', {
  ctlAvailable: () => unwrap(ipcRenderer.invoke('ctl:available')),
  accountsList: () => unwrap(ipcRenderer.invoke('accounts:list')),
  accountsImport: (text) => unwrap(ipcRenderer.invoke('accounts:import', text)),
  accountsDelete: (license) => unwrap(ipcRenderer.invoke('accounts:delete', license)),
  accountsExport: () => unwrap(ipcRenderer.invoke('accounts:export')),
  checkStart: (filter) => unwrap(ipcRenderer.invoke('check:start', filter)),
  checkStatus: () => unwrap(ipcRenderer.invoke('check:status')),
  checkCancel: () => unwrap(ipcRenderer.invoke('check:cancel')),
  connectConnect: (license) => unwrap(ipcRenderer.invoke('connect:connect', license)),
  connectDisconnect: () => unwrap(ipcRenderer.invoke('connect:disconnect')),
  connectStatus: () => unwrap(ipcRenderer.invoke('connect:status')),
  onCheckProgress: (cb) => sub('check:progress', cb),
  onConnectState: (cb) => sub('connect:state', cb),
})
