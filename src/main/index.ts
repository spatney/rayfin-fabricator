import { app, shell, BrowserWindow, type WebContents } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'

/** Session partition shared by the preview <webview> and its auth popups. */
const PREVIEW_PARTITION = 'persist:rayfin-preview'

/**
 * Microsoft's identity pages (login.microsoftonline.com / Fabric broker) refuse
 * to render inside an "embedded webview": they sniff the User-Agent for framework
 * tokens (e.g. `Electron/…`, the app name) and return a blank/blocked page. Present
 * a clean, current Edge UA instead so the Fabric/AAD sign-in renders and works.
 * The Chromium version is read from the running Electron so the UA stays current.
 */
const PREVIEW_USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36 ` +
  `Edg/${process.versions.chrome}`

// Make the clean Edge UA the global default. This is the only reliable way to
// cover the *auth popup* too: it's a brand-new BrowserWindow created by the
// window-open handler, and a per-session `setUserAgent` does NOT propagate to a
// freshly created window's webContents (verified: the popup still presented the
// default `…rayfin-desktop/0.0.1 …Electron/33.4.11…` UA and AAD went blank).
// `app.userAgentFallback` is the per-webContents default, so the shell, the
// preview <webview>, and every auth popup all inherit the clean UA. The Studio
// shell only loads local content, so changing its UA is harmless.
app.userAgentFallback = PREVIEW_USER_AGENT

// The Fabric SDK opens its sign-in broker with `window.open(...)` only *after*
// several awaits (silent-resume/SSO checks), so the click's user-activation has
// already expired and Chromium's popup blocker swallows the call (returns null →
// the app reports TAB_BLOCKED). `allowpopups` on the <webview> is not enough to
// bypass this; disabling the popup blocker lets the broker popup actually open.
// Safe here: the Studio shell window denies every window.open (routes to the
// system browser), and the preview only allows the auth popup via its handler.
app.commandLine.appendSwitch('disable-popup-blocking')

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
      nodeIntegration: false,
      webviewTag: true
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

  configurePreviewWebview(mainWindow.webContents)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/** Pull width/height out of a `window.open` feature string (e.g. "popup=yes,width=480,height=640"). */
function parsePopupSize(features: string): { width: number; height: number } {
  const num = (key: string, fallback: number): number => {
    const m = new RegExp(`${key}\\s*=\\s*(\\d+)`).exec(features)
    return m ? Number(m[1]) : fallback
  }
  return { width: num('width', 520), height: num('height', 720) }
}

/**
 * The preview <webview> hosts the user's *deployed* Rayfin app. Its Fabric
 * sign-in opens a broker popup via `window.open(url, 'fabricAuth', 'popup=yes,…')`
 * and waits for that popup to `postMessage` the auth handoff back to
 * `window.opener`. We hook the guest webContents via the host's
 * `did-attach-webview` event (the reliable way to reach a <webview> guest from the
 * main process) and allow the auth popup as a real child window that keeps the
 * `opener` relationship (so the postMessage handoff is delivered) and shares the
 * preview session partition (so Fabric SSO cookies are reused). The clean Edge UA
 * comes from `app.userAgentFallback`; we re-assert it on the guest as a belt-and-
 * suspenders measure. Plain `target=_blank` links go to the system browser.
 */
function configurePreviewWebview(host: WebContents): void {
  host.on('did-attach-webview', (_event, guest) => {
    guest.setUserAgent(PREVIEW_USER_AGENT)
    guest.setWindowOpenHandler((details) => {
      const features = details.features || ''
      const isAuthPopup = /\b(popup|width|height)\s*=/.test(features)
      if (!isAuthPopup) {
        if (details.url && /^https?:\/\//.test(details.url)) void shell.openExternal(details.url)
        return { action: 'deny' }
      }
      const { width, height } = parsePopupSize(features)
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width,
          height,
          autoHideMenuBar: true,
          title: 'Sign in',
          webPreferences: {
            partition: PREVIEW_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
          }
        }
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
