const { contextBridge, ipcRenderer } = require('electron')

// subscribe helper: returns an unsubscribe function
const sub = (ch, cb) => {
  const fn = (_e, v) => cb(v)
  ipcRenderer.on(ch, fn)
  return () => ipcRenderer.removeListener(ch, fn)
}

contextBridge.exposeInMainWorld('xvpn', {
  ctlAvailable: () => ipcRenderer.invoke('ctl:available'),
  accountsList: () => ipcRenderer.invoke('accounts:list'),
  accountsImport: (text) => ipcRenderer.invoke('accounts:import', text),
  accountsDelete: (license) => ipcRenderer.invoke('accounts:delete', license),
  accountsExport: () => ipcRenderer.invoke('accounts:export'),
  checkStart: (filter) => ipcRenderer.invoke('check:start', filter),
  checkStatus: () => ipcRenderer.invoke('check:status'),
  checkCancel: () => ipcRenderer.invoke('check:cancel'),
  connectConnect: (license) => ipcRenderer.invoke('connect:connect', license),
  connectDisconnect: () => ipcRenderer.invoke('connect:disconnect'),
  connectStatus: () => ipcRenderer.invoke('connect:status'),
  onCheckProgress: (cb) => sub('check:progress', cb),
  onConnectState: (cb) => sub('connect:state', cb),
})
