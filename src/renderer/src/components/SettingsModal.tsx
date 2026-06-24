import { useEffect, useId, useState } from 'react'
import type { AppSettings, AppVersions, ThemePreference } from '@shared/ipc'
import { applyTheme } from '../theme'
import { useSuppressPreview } from '../overlay'
import { useUpdates } from '../update'

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
  useSuppressPreview()
  const { status: updateStatus, info: updateInfo, checkNow } = useUpdates()
  const [checkedUpdates, setCheckedUpdates] = useState(false)
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)
  const titleId = useId()

  useEffect(() => {
    void window.api.projects.state().then((s) => setWorkspaceRoot(s.workspaceRoot))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Preview a theme choice immediately; persistence happens via onChange.
  function pickTheme(theme: ThemePreference): void {
    applyTheme(theme)
    onChange({ theme })
  }

  async function changeRoot(): Promise<void> {
    const next = await window.api.projects.pickWorkspaceRoot()
    setWorkspaceRoot(next.workspaceRoot)
  }

  const updateBusy =
    updateStatus === 'checking' ||
    updateStatus === 'downloading' ||
    updateStatus === 'installing'
  let updateMsg: string
  if (updateStatus === 'checking') updateMsg = 'Checking for updates…'
  else if (updateStatus === 'downloading') updateMsg = 'Downloading the latest update…'
  else if (updateStatus === 'ready')
    updateMsg = `Update ${updateInfo?.version ?? ''} is ready — restart from the banner.`.replace(
      '  ',
      ' '
    )
  else if (updateStatus === 'installing') updateMsg = 'Installing update…'
  else if (updateStatus === 'error') updateMsg = 'Couldn’t check for updates. Try again later.'
  else if (checkedUpdates) updateMsg = 'You’re up to date.'
  else updateMsg = versions ? `You’re on version ${versions.app}.` : ''

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Settings</h2>
          <button className="btn btn--sm btn--ghost" onClick={onClose} aria-label="Close settings">
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

          <div className="settings-note">
            <span className="settings-check-label">Anonymous usage stats</span>
            <span className="field-hint">
              Rayfin Fabricator sends minimal usage stats — your sign-in domain (e.g.
              company.com) and a one-way hash of your email — so we can see how the
              product is used. Your email address, code, and app contents never leave
              your machine.
            </span>
          </div>

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
            <label className="settings-check">
              <input
                type="checkbox"
                checked={Boolean(settings.experiments?.advisorAutoRun)}
                onChange={(e) =>
                  onChange({ experiments: { advisorAutoRun: e.target.checked } })
                }
              />
              <span>
                <span className="settings-check-label">Auto-refresh the Advisor</span>
                <span className="field-hint">
                  When you open the Advisor and its last review is out of date (your code
                  changed since), re-run it automatically instead of just flagging it as stale.
                </span>
              </span>
            </label>
          </div>

          <div className="field">
            <span className="field-label">Updates</span>
            <div className="settings-row">
              <span className="field-hint">{updateMsg}</span>
              <button
                className="btn btn--sm btn--ghost"
                disabled={updateBusy}
                onClick={() => {
                  setCheckedUpdates(true)
                  void checkNow()
                }}
              >
                {updateBusy ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
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
              ? `Rayfin Fabricator ${versions.app} · Tauri ${versions.tauri} · WebView2 ${versions.webview2} · Copilot CLI ${versions.copilot ?? 'unknown'}`
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
