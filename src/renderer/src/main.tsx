import React from 'react'
import ReactDOM from 'react-dom/client'
import { api } from './api'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { OverlayProvider } from './overlay'
import './assets/main.css'

// Expose the Tauri-backed API as `window.api`, matching the contract the rest of
// the renderer relies on (previously provided by the Electron preload bridge).
window.api = api

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <OverlayProvider>
        <App />
      </OverlayProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
