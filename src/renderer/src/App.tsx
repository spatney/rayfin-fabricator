import { useEffect, useState } from 'react'
import type { AppVersions } from '@shared/ipc'

function App(): JSX.Element {
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [bridgeOk, setBridgeOk] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const [pong, v] = await Promise.all([window.api.ping(), window.api.getVersions()])
        if (cancelled) return
        setBridgeOk(pong === 'pong')
        setVersions(v)
      } catch {
        if (!cancelled) setBridgeOk(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">▰</span>
          <span className="brand-name">Rayfin Studio</span>
        </div>
        <div className="titlebar-status">
          <span className={`pill ${bridgeOk ? 'pill--ok' : 'pill--pending'}`}>
            {bridgeOk === null ? 'starting…' : bridgeOk ? 'ready' : 'bridge error'}
          </span>
        </div>
      </header>

      <div className="workbench">
        <aside className="sidebar">
          <div className="sidebar-section-title">Projects</div>
          <div className="sidebar-empty">
            No projects yet.
            <br />
            Project management arrives in a later phase.
          </div>
        </aside>

        <main className="content">
          <section className="pane pane--chat">
            <div className="pane-title">Chat</div>
            <div className="pane-placeholder">
              The Copilot-powered chat will live here.
            </div>
          </section>
          <section className="pane pane--preview">
            <div className="pane-title">Preview</div>
            <div className="pane-placeholder">
              Your deployed Rayfin app will render here after <code>rayfin up</code>.
            </div>
          </section>
        </main>
      </div>

      <footer className="statusbar">
        <span className="statusbar-item">Rayfin Studio v{versions?.app ?? '—'}</span>
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item">Electron {versions?.electron ?? '—'}</span>
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item">Node {versions?.node ?? '—'}</span>
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item">Chromium {versions?.chrome ?? '—'}</span>
      </footer>
    </div>
  )
}

export default App
