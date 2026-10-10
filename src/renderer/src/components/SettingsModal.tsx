import { useEffect, useId, useState, type ReactNode } from 'react'
import type { AppSettings, AppVersions, ThemePreference } from '@shared/ipc'
import { applyTheme, applyUiScale, UI_SCALES } from '../theme'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { useUpdates } from '../update'
import { formatCopilotCli } from '../copilotVersion'
import { openDocs } from '../docsLinks'
import { Codicon } from './icons'

interface Props {
  settings: AppSettings
  versions: AppVersions | null
  /** Persist a settings patch; the parent re-applies theme + stores it. */
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
  /** Open the Accounts dialog. */
  onManageAccounts?: () => void
  /** Leave for the setup screen to re-check tools and sign-ins. */
  onReviewSetup?: () => void
}

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

/** A group of settings: a quiet heading over a card of rows. */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  const id = useId()
  return (
    <section className="set-section" aria-labelledby={id}>
      <h3 className="set-section-title" id={id}>
        {title}
      </h3>
      <div className="set-card">{children}</div>
    </section>
  )
}

/** One setting: its name and what it does, with its control at the end. */
function Item({
  title,
  desc,
  extra,
  children
}: {
  title: string
  desc?: ReactNode
  /** Full-width detail under the row, such as a folder path. */
  extra?: ReactNode
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="set-item">
      <div className="set-item-text">
        <span className="set-item-title">{title}</span>
        {desc ? <span className="set-item-desc">{desc}</span> : null}
      </div>
      {children ? <div className="set-item-control">{children}</div> : null}
      {extra}
    </div>
  )
}

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
    <label className="set-item set-item--toggle">
      <span className="set-item-text">
        <span className="set-item-title">{label}</span>
        <span className="set-item-desc">{hint}</span>
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
  onClose,
  onManageAccounts,
  onReviewSetup
}: Props): JSX.Element {
  useSuppressPreview()
  const { status: updateStatus, info: updateInfo, checkNow } = useUpdates()
  const [checkedUpdates, setCheckedUpdates] = useState(false)
  const [showExperiments, setShowExperiments] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)
  const titleId = useId()
  const experimentsId = useId()
  const experimentsTitleId = useId()
  const experimentsDescId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()

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
          className="modal settings-modal"
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

          <div className="modal-body settings-body">
            <Section title="General">
              {onManageAccounts && (
                <Item
                  title="Accounts"
                  desc="See who you’re signed in as for GitHub Copilot, Microsoft Fabric, the Azure CLI, and GitHub, and sign in or out."
                >
                  <button type="button" className="btn btn--sm" onClick={onManageAccounts}>
                    Manage accounts
                  </button>
                </Item>
              )}
              {onReviewSetup && (
                <Item
                  title="Setup"
                  desc="Check the tools Fabricator needs and install missing ones, such as the GitHub CLI."
                >
                  <button type="button" className="btn btn--sm" onClick={onReviewSetup}>
                    Open setup
                  </button>
                </Item>
              )}
              <Item
                title="Workspace folder"
                desc="New projects are created here."
                extra={
                  <code className="set-path" title={workspaceRoot ?? ''}>
                    {workspaceRoot ?? '…'}
                  </code>
                }
              >
                <button type="button" className="btn btn--sm" onClick={() => void changeRoot()}>
                  Change…
                </button>
              </Item>
            </Section>

            <Section title="Appearance">
              <Item title="Theme" desc="System follows your computer’s light or dark setting.">
                <div className="seg" role="group" aria-label="Theme">
                  {THEMES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      className={`seg-btn${settings.theme === t.value ? ' seg-btn--active' : ''}`}
                      aria-pressed={settings.theme === t.value}
                      onClick={() => pickTheme(t.value)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </Item>
              <Item title="Text size" desc="Scale the whole interface — handy on large monitors.">
                <div className="seg" role="group" aria-label="Text size">
                  {UI_SCALES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`seg-btn${(settings.uiScale ?? 1) === s ? ' seg-btn--active' : ''}`}
                      aria-pressed={(settings.uiScale ?? 1) === s}
                      onClick={() => pickScale(s)}
                    >
                      {Math.round(s * 100)}%
                    </button>
                  ))}
                </div>
              </Item>
              <ToggleRow
                label="Ray"
                hint="Fabricator’s stingray keeps you company while apps install, shares Rayfin facts, and greets you in Help."
                checked={settings.mascot !== false}
                onChange={(v) => onChange({ mascot: v })}
              />
            </Section>

            <Section title="Updates & help">
              <Item title="Updates" desc={updateMsg || undefined}>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={updateBusy}
                  onClick={() => {
                    setCheckedUpdates(true)
                    void checkNow()
                  }}
                >
                  {updateBusy ? 'Checking…' : 'Check for updates'}
                </button>
              </Item>
              <Item
                title="Help"
                desc="Guides for every part of Fabricator, and fixes for common problems."
              >
                <button type="button" className="btn btn--sm" onClick={() => openDocs('home')}>
                  Documentation
                  <Codicon name="link-external" className="set-ext" />
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => openDocs('troubleshooting')}
                >
                  Troubleshooting
                  <Codicon name="link-external" className="set-ext" />
                </button>
              </Item>
            </Section>

            <Section title="Diagnostics">
              <Item
                title="Usage stats"
                desc="We send your sign-in domain and a hashed email so we can see how the product is used. Your email, code, and apps stay on this device."
              />
              <ToggleRow
                label="Full diagnostics"
                hint="Also capture prompts, responses, and tool output for each chat turn. Off by default — only lightweight metadata (timing, tools used, errors) is recorded. Turn on to include more detail in a bug report."
                checked={Boolean(settings.fullDiagnostics)}
                onChange={(v) => onChange({ fullDiagnostics: v })}
              />
              <Item
                title="Logs"
                desc="Diagnostics for your chat sessions are saved on this device. Export them to attach to a bug report."
              >
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={exporting}
                  onClick={() => void exportDiagnostics()}
                >
                  {exporting ? 'Exporting…' : 'Export diagnostics'}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void window.api.openLogs()}
                >
                  Open logs folder
                </button>
              </Item>
            </Section>

            <section className="set-section">
              <div
                className={`set-card set-expander${showExperiments ? ' set-expander--open' : ''}`}
              >
                <button
                  type="button"
                  className="set-item set-expander-head"
                  aria-expanded={showExperiments}
                  aria-controls={showExperiments ? experimentsId : undefined}
                  aria-labelledby={experimentsTitleId}
                  aria-describedby={experimentsDescId}
                  onClick={() => setShowExperiments((s) => !s)}
                >
                  <span className="set-item-text">
                    <span className="set-item-title set-expander-title" id={experimentsTitleId}>
                      Experiments <span className="settings-beta">Beta</span>
                    </span>
                    <span className="set-item-desc" id={experimentsDescId}>
                      These features are experimental and off by default. They may be unstable,
                      change, or be removed in a future update.
                    </span>
                  </span>
                  <Codicon name="chevron-down" className="set-expander-caret" />
                </button>
                {showExperiments && (
                  <div className="set-expander-body" id={experimentsId}>
                    <ToggleRow
                      label="Team workspaces"
                      hint="Build apps with your team in a private GitHub repository. Everyone works on their own copy, and a pipeline publishes to Fabric with a deploy identity that Fabricator sets up. Team apps never deploy from this computer. Needs the GitHub CLI."
                      checked={Boolean(settings.experiments?.teamWorkspaces)}
                      onChange={(v) => onChange({ experiments: { teamWorkspaces: v } })}
                    />
                    <ToggleRow
                      label="Deploy manually"
                      hint="Chat turns don’t deploy your app; select Redeploy when you’re ready. The preview always shows your latest changes, running on this computer. Team apps still save after each turn."
                      checked={Boolean(settings.experiments?.manualDeploy)}
                      onChange={(v) => onChange({ experiments: { manualDeploy: v } })}
                    />
                  </div>
                )}
              </div>
            </section>
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

    </>
  )
}
