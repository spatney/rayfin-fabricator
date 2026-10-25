import React from 'react'
import ReactDOM from 'react-dom/client'
import { api } from './api'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { OverlayProvider } from './overlay'
import { UpdateProvider } from './update'
import { ToastProvider } from './toast'
import { applyRememberedAppearance } from './theme'
import { installGlobalErrorCapture } from './errorReport'
import '@vscode/codicons/dist/codicon.css'
import './assets/main.css'

// Expose the Tauri-backed API as `window.api`, matching the contract the rest of
// the renderer relies on (previously provided by the Electron preload bridge).
window.api = api

// Record exceptions and rejections that never reach a `catch`, so the Help
// assistant can explain them. Installed before the first render.
installGlobalErrorCapture()

applyRememberedAppearance()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <OverlayProvider>
        <UpdateProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </UpdateProvider>
      </OverlayProvider>
    </ErrorBoundary>
  </React.StrictMode>
)

/** `rgb(r, g, b)` as `#rrggbb`, or undefined for anything else. */
function hexColor(css: string): string | undefined {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css)
  if (!match) return undefined
  return `#${match
    .slice(1, 4)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('')}`
}

// The window starts hidden, so a launch never shows it empty. Show it once the
// first screen has rendered, giving the page a frame or two to paint it (a
// hidden window may never run animation frames, hence the timer as well).
let revealed = false
function reveal(): void {
  if (revealed) return
  revealed = true
  void api.revealWindow(hexColor(getComputedStyle(document.body).backgroundColor)).catch(() => {})
}
requestAnimationFrame(() => requestAnimationFrame(reveal))
window.setTimeout(reveal, 120)
