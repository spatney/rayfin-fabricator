import { useEffect, useState } from 'react'
import type { AppSettings, AppVersions, ThemePreference } from '@shared/ipc'
import { applyTheme } from '../theme'

interface Props {
  settings: AppSettings
  versions: AppVersions | null
  /** Persist a settings patch; the parent re-applies theme + stores it. */
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
}

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

export default function SettingsModal({
  settings,
  versions,
  onChange,
  onClose
}: Props): JSX.Element {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)

  useEffect(() => {
    void window.api.projects.state().then((s) => setWorkspaceRoot(s.workspaceRoot))
  }, [])

  // Preview a theme choice immediately; persistence happens via onChange.
  function pickTheme(theme: ThemePreference): void {
    applyTheme(theme)
    onChange({ theme })
  }

  async function changeRoot(): Promise<void> {
    const next = await window.api.projects.pickWorkspaceRoot()
    setWorkspaceRoot(next.workspaceRoot)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="btn btn--sm btn--ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <span className="field-label">Theme</span>
            <div className="seg">
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={`seg-btn${settings.theme === t.value ? ' seg-btn--active' : ''}`}
                  onClick={() => pickTheme(t.value)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            <span className="field-label">Workspace folder</span>
            <div className="settings-row">
              <code className="settings-path" title={workspaceRoot ?? ''}>
                {workspaceRoot ?? '…'}
              </code>
              <button className="btn btn--sm btn--ghost" onClick={() => void changeRoot()}>
                Change…
              </button>
            </div>
            <span className="field-hint">New projects are created under this folder.</span>
          </label>

          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.telemetry}
              onChange={(e) => onChange({ telemetry: e.target.checked })}
            />
            <span>
              <span className="settings-check-label">Share anonymous usage data</span>
              <span className="field-hint">
                Opt in to anonymous telemetry. Stored locally only — nothing is sent yet.
              </span>
            </span>
          </label>

          <div className="field">
            <span className="field-label">
              Experiments <span className="settings-beta">Beta</span>
            </span>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={Boolean(settings.experiments?.sideThreads)}
                onChange={(e) =>
                  onChange({ experiments: { sideThreads: e.target.checked } })
                }
              />
              <span>
                <span className="settings-check-label">Side threads</span>
                <span className="field-hint">
                  Fork a project into parallel background agents. Each side thread works in
                  isolation, then auto-merges into your main thread and redeploys when it’s
                  done.
                </span>
              </span>
            </label>
          </div>

          <div className="field">
            <span className="field-label">Diagnostics</span>
            <div className="settings-row">
              <span className="field-hint">Crash and error logs are saved on this device.</span>
              <button className="btn btn--sm btn--ghost" onClick={() => void window.api.openLogs()}>
                Open logs folder
              </button>
            </div>
          </div>
        </div>

        <div className="modal-footer settings-footer">
          <span className="settings-version">
            {versions
              ? `Rayfin Fabricator · Electron ${versions.electron} · Node ${versions.node}`
              : ''}
          </span>
          <button className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
