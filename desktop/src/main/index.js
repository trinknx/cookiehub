import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from './store.js'
import { createCheckJob } from './checkJob.js'
import { createConnectManager } from './connectManager.js'
import { registerIpc } from './ipc.js'
import { makeCtl, connectionState, checkLicense, loginOnly, DEFAULT_CTL } from '../../../tools/expressvpn/xvpnChecker.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
let mainWindow = null
const send = (channel, payload) => mainWindow?.webContents?.send(channel, payload)

// Export = save dialog (Ruling 17): pick a path next to the user's files, never clipboard
async function saveExport(text) {
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: 'accounts-export.txt', filters: [{ name: 'Text', extensions: ['txt'] }] })
  if (r.canceled) return { canceled: true }
  writeFileSync(r.filePath, text)
  return { path: r.filePath }
}

function bootstrap() {
  const store = openStore(path.join(app.getPath('userData'), 'xvpn-manager.db'))

  // first run: seed from the vault next to the CLI (dev tree) or from the
  // packaged extra resource
  if (!store.count()) {
    const candidates = [
      path.resolve(app.getAppPath(), '..', 'tools', 'expressvpn', 'accounts.txt'),
      process.resourcesPath ? path.join(process.resourcesPath, 'accounts.txt') : '',
    ].filter(Boolean)
    for (const p of candidates) {
      if (existsSync(p)) { const r = store.importText(readFileSync(p, 'utf8')); console.log(`[xvpn] seeded from ${p}: ${r.imported} imported`); break }
    }
  }

  const ctl = makeCtl(DEFAULT_CTL)
  const ctlAvailable = existsSync(DEFAULT_CTL)
  const checkJob = createCheckJob({
    selectLicenses: f => store.selectLicenses(f),
    applyResult: (l, r) => store.applyResult(l, r),
    check: license => checkLicense(license, { ctl }),
    delayMs: 1500,
    onEvent: s => send('check:progress', s),
  })
  const connectManager = createConnectManager({
    login: license => loginOnly(license, { ctl }),
    ctl,
    state: () => connectionState(ctl),
    isBusy: () => checkJob.status().running,
    onEvent: s => send('connect:state', s),
  })
  registerIpc({ ipcMain, store, checkJob, connectManager, ctlAvailable, connectionState: () => connectionState(ctl), saveExport })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.env.VITE_DEV) mainWindow.loadURL('http://127.0.0.1:5174')
  else mainWindow.loadFile(path.join(dirname, '../../dist/index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

// A bootstrap failure (native module ABI, corrupt db, …) must be LOUD — the
// first packaged build died here silently: unhandled rejection, no window,
// headless process. Show the error and exit instead.
app.whenReady().then(() => {
  try {
    bootstrap()
    createWindow()
  } catch (e) {
    console.error('[xvpn] fatal:', e)
    dialog.showErrorBox('XVPN Manager failed to start', `${e?.message || e}\n\nIf this mentions NODE_MODULE_VERSION, rebuild the native module for Electron (see README troubleshooting).`)
    app.exit(1)
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
