import { useEffect, useState } from 'react'
import type { AppVersions, AuthStatus } from '@shared/ipc'

interface Props {
  auth: AuthStatus
  onSignOut: () => Promise<void> | void
}

export default function Workbench({ auth, onSignOut }: Props): JSX.Element {
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => {
    void window.api.getVersions().then(setVersions)
  }, [])

  async function signOut(): Promise<void> {
    setSigningOut(true)
    try {
      await window.api.auth.logoutRayfin()
    } finally {
      setSigningOut(false)
      await onSignOut()
    }
  }

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">▰</span>
          <span className="brand-name">Rayfin Studio</span>
        </div>
        <div className="titlebar-status">
          <span className="who">{auth.rayfin.user ?? 'Signed in'}</span>
          <button className="btn btn--sm btn--ghost" disabled={signingOut} onClick={signOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <div className="workbench">
        <aside className="sidebar">
          <div className="sidebar-section-title">Projects</div>
          <div className="sidebar-empty">
            No projects yet.
            <br />
            Project management arrives next.
          </div>
        </aside>

        <main className="content">
          <section className="pane pane--chat">
            <div className="pane-title">Chat</div>
            <div className="pane-placeholder">The Copilot-powered chat will live here.</div>
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
        <span className="statusbar-item">Copilot {auth.copilot.signedIn ? '✓' : '—'}</span>
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item">Fabric {auth.rayfin.signedIn ? '✓' : '—'}</span>
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item">Electron {versions?.electron ?? '—'}</span>
      </footer>
    </div>
  )
}
