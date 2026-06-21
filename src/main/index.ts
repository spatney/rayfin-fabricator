import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { IpcChannels, type AppVersions } from '../shared/ipc'

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Rayfin Studio',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Open target=_blank / external links in the user's browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

/**
 * Core IPC handlers. Feature modules added in later phases (env doctor, auth,
 * projects, chat, deploy, preview) should expose their own `registerXxxIpc()`
 * function and be wired up here.
 */
function registerCoreIpc(): void {
  ipcMain.handle(IpcChannels.ping, () => 'pong')

  ipcMain.handle(IpcChannels.getVersions, (): AppVersions => {
    return {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8
    }
  })
}

app.whenReady().then(() => {
  registerCoreIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
