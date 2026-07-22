import { useEffect, useId, useState } from 'react'
import type { AppSettings, AppVersions, ThemePreference } from '@shared/ipc'
import { applyTheme, applyUiScale, UI_SCALES } from '../theme'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { useUpdates } from '../update'
import { formatCopilotCli } from '../copilotVersion'
import ConfirmModal from './ConfirmModal'

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

function ToggleRow({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (value: boolean) => void
}): JSX.Element {
  return (
    <label className="set-row">
      <span className="set-row-text">
        <span className="set-row-label">{label}</span>
        <span className="field-hint">{hint}</span>
      </span>
      <span className={`switch${checked ? ' switch--on' : ''}`}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="switch-knob" />
      </span>
    </label>
  )
}

export default function SettingsModal({
  settings,
  versions,
  onChange,
  onClose
}: Props): JSX.Element {
  useSuppressPreview()
  const { status: updateStatus, info: updateInfo, checkNow } = useUpdates()
  const [checkedUpdates, setCheckedUpdates] = useState(false)
  const [showExperiments, setShowExperiments] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  // Compatibility rendering is applied at startup, so any change only takes effect
  // after a relaunch. Toggling it opens a mandatory restart prompt; `restartPrompt`
  // holds the value to revert to if the user declines, keeping the setting from
  // being left half-applied.
  const [restartPrompt, setRestartPrompt] = useState<{ revertTo: boolean } | null>(null)

  // Toggling compatibility rendering forces a restart: persist the new value, then
  // require the user to relaunch (or cancel, which reverts the change).
  function toggleCompatRendering(value: boolean): void {
    const revertTo = Boolean(settings.experiments?.compatibilityRendering)
    onChange({ experiments: { compatibilityRendering: value } })
    setRestartPrompt({ revertTo })
  }

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

  // Preview the UI scale immediately so the whole window resizes as you pick.
  function pickScale(uiScale: number): void {
    applyUiScale(uiScale)
    onChange({ uiScale })
  }

  async function changeRoot(): Promise<void> {
    const next = await window.api.projects.pickWorkspaceRoot()
    setWorkspaceRoot(next.workspaceRoot)
  }

  // Build and reveal a shareable diagnostics bundle. Best-effort: the backend
  // reveals the logs folder on success, and a failure must never throw.
  async function exportDiagnostics(): Promise<void> {
    if (exporting) return
    setExporting(true)
    try {
      await window.api.diagnostics.export()
    } catch {
      /* diagnostics export is best-effort */
    } finally {
      setExporting(false)
    }
  }

  const updateBusy =
    updateStatus === 'checking' || updateStatus === 'downloading' || updateStatus === 'installing'
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
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          ref={dialogRef}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">
            <h2 id={titleId}>Settings</h2>
            <button
              className="btn btn--sm btn--ghost"
              onClick={onClose}
              aria-label="Close settings"
            >
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

            <div className="field">
              <span className="field-label">Text size</span>
              <div className="seg">
                {UI_SCALES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`seg-btn${(settings.uiScale ?? 1) === s ? ' seg-btn--active' : ''}`}
                    onClick={() => pickScale(s)}
                  >
                    {Math.round(s * 100)}%
                  </button>
                ))}
              </div>
              <span className="field-hint">Scale the whole interface — handy on large monitors.</span>
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
              <span className="field-hint">New projects are created here.</span>
            </label>

            <div className="field">
              <span className="field-label">Usage stats</span>
              <span className="field-hint">
                We send your sign-in domain and a hashed email so we can see how the product is
                used. Your email, code, and apps stay on this device.
              </span>
            </div>

            <div className="field">
              <span className="field-label">Performance</span>
              <ToggleRow
                label="Compatibility rendering"
                hint="Disable GPU acceleration to fix freezing in VMs like Parallels."
                checked={Boolean(settings.experiments?.compatibilityRendering)}
                onChange={toggleCompatRendering}
              />
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
              <ToggleRow
                label="Full diagnostics"
                hint="Also capture prompts, responses, and tool output for each chat turn. Off by default — only lightweight metadata (timing, tools used, errors) is recorded. Turn on to include more detail in a bug report."
                checked={Boolean(settings.fullDiagnostics)}
                onChange={(v) => onChange({ fullDiagnostics: v })}
              />
              <div className="settings-row">
                <span className="field-hint">
                  Diagnostics for your chat sessions are saved on this device. Export them to
                  attach to a bug report.
                </span>
                <span className="diagnostics-actions">
                  <button
                    className="btn btn--sm btn--ghost"
                    disabled={exporting}
                    onClick={() => void exportDiagnostics()}
                  >
                    {exporting ? 'Exporting…' : 'Export diagnostics'}
                  </button>
                  <button
                    className="btn btn--sm btn--ghost"
                    onClick={() => void window.api.openLogs()}
                  >
                    Open logs folder
                  </button>
                </span>
              </div>
            </div>

            <div
              className={`field settings-experiments${showExperiments ? ' settings-experiments--open' : ''}`}
            >
              <button
                type="button"
                className={`settings-disclosure${showExperiments ? ' settings-disclosure--open' : ''}`}
                aria-expanded={showExperiments}
                onClick={() => setShowExperiments((s) => !s)}
              >
                <span
                  className="codicon codicon-chevron-right settings-disclosure-caret"
                  aria-hidden="true"
                />
                <span className="field-label">
                  Experiments <span className="settings-beta">Beta</span>
                </span>
              </button>
              {showExperiments && (
                <div className="settings-disclosure-body">
                  <div className="settings-warn" role="note">
                    <span className="codicon codicon-warning" aria-hidden="true" />
                    <span>
                      These features are experimental and off by default. They may be unstable,
                      change, or be removed in a future update.
                    </span>
                  </div>
                  <ToggleRow
                    label="Chat mode selector"
                    hint="Show Agent, Plan, and Autopilot in the composer. Plan researches, clarifies, and waits for approval before building."
                    checked={Boolean(settings.experiments?.chatModeSelector)}
                    onChange={(v) => onChange({ experiments: { chatModeSelector: v } })}
                  />
                  <ToggleRow
                    label="Live local preview"
                    hint="While an agent turn runs, start the app's Vite dev server and show it in the preview so edits appear live. Stopped at turn end; needs a project with a dev script."
                    checked={Boolean(settings.experiments?.localDevPreview)}
                    onChange={(v) => onChange({ experiments: { localDevPreview: v } })}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="modal-footer settings-footer">
            <span className="settings-version">
              {versions
                ? `Fabricator ${versions.app} · Tauri ${versions.tauri} · WebView2 ${versions.webview2} · Copilot CLI ${formatCopilotCli(versions)}`
                : ''}
            </span>
            <button className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>

      {restartPrompt && (
        <ConfirmModal
          title="Restart required"
          message="Compatibility rendering only changes after a restart. Fabricator will restart now to apply it."
          confirmLabel="Restart now"
          cancelLabel="Cancel"
          onConfirm={() => void window.api.relaunch()}
          onCancel={() => {
            onChange({ experiments: { compatibilityRendering: restartPrompt.revertTo } })
            setRestartPrompt(null)
          }}
        />
      )}
    </>
  )
}
