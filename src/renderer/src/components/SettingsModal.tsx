import { Fragment, useEffect, useId, useRef, useState, type ReactNode, type JSX } from 'react'
import type {
  AppSettings,
  AppVersions,
  Language,
  LanguagePreference,
  ThemePreference
} from '@shared/ipc'
import { applyTheme, applyUiScale, UI_SCALES } from '../theme'
import {
  applyLanguagePreference,
  isLanguagePreference,
  LANGUAGE_NAMES,
  LANGUAGES,
  systemLanguage,
  useTranslation
} from '../i18n'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { formatCopilotCli } from '../copilotVersion'
import { openDocs } from '../docsLinks'
import { Codicon } from './icons'
import { FabricatorMark } from './FabricatorMark'

interface Props {
  settings: AppSettings
  versions: AppVersions | null
  /** Persist a settings patch; the parent re-applies theme + stores it. */
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
  /** Open the Accounts dialog. */
  onManageAccounts?: () => void
  /** Open the Accounts dialog at Model providers (your own API keys). */
  onManageKeys?: () => void
  /** Open the MCP servers dialog. */
  onManageMcpServers?: () => void
  /** Open Chat defaults: the model and plugins a new project's chat starts with. */
  onManageChatDefaults?: () => void
  /** Open Custom instructions: what Copilot follows in every app. */
  onManageCustomInstructions?: () => void
  /** Leave for the setup screen to re-check tools and sign-ins. */
  onReviewSetup?: () => void
}

const THEMES = [
  { value: 'system', label: 'appearance.theme.system' },
  { value: 'dark', label: 'appearance.theme.dark' },
  { value: 'light', label: 'appearance.theme.light' }
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string }>

/** A group of settings: a quiet heading over a card of rows. */
export function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
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
export function Item({
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

export function ToggleRow({
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

/** Fabricator's version and the parts it runs on, with a copy for bug reports. */
function VersionInfo({ versions }: { versions: AppVersions }): JSX.Element {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    },
    []
  )

  // Each part as shown, and as copied: in English whatever the interface's
  // language, since the copy goes in a bug report.
  const running = versions.copilot
  const bundled = versions.copilotBundled
  const parts: Array<[name: string, shown: string, copied: string]> = [
    ['Tauri', versions.tauri, versions.tauri],
    ['WebView2', versions.webview2, versions.webview2],
    [
      'Copilot CLI',
      !running
        ? t('about.unknownVersion')
        : bundled && bundled !== running
          ? t('about.copilotBundled', { version: running, bundled })
          : running,
      formatCopilotCli(versions)
    ],
    [
      'rayfin-local',
      versions.rayfinLocal || t('about.unknownVersion'),
      versions.rayfinLocal || 'unknown'
    ]
  ]

  async function copy(): Promise<void> {
    const text = [
      `Fabricator ${versions.app}`,
      ...parts.map(([name, , version]) => `${name} ${version}`)
    ]
    try {
      await navigator.clipboard.writeText(text.join('\n'))
      setCopied(true)
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  return (
    <>
      <div className="set-item set-about">
        <FabricatorMark className="set-about-mark" />
        <div className="set-item-text">
          <span className="set-item-title">Fabricator</span>
          <span className="set-item-desc">{t('about.version', { version: versions.app })}</span>
        </div>
        <div className="set-item-control">
          <button
            type="button"
            className="btn btn--sm"
            title={t('about.copyVersion')}
            aria-label={t('about.copyVersion')}
            onClick={() => void copy()}
          >
            <Codicon name={copied ? 'check' : 'copy'} />
            {copied ? t('actions.copied') : t('actions.copy')}
          </button>
        </div>
      </div>
      <dl className="set-item set-versions">
        {parts.map(([name, version]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd>{version}</dd>
          </Fragment>
        ))}
      </dl>
    </>
  )
}

/** The interface's language: the computer's (named, once the core says which) or one chosen. */
function LanguagePicker({
  value,
  onPick
}: {
  value: LanguagePreference
  onPick: (language: LanguagePreference) => void
}): JSX.Element {
  const { t } = useTranslation('settings')
  const [system, setSystem] = useState<Language | null>(null)
  useEffect(() => {
    let alive = true
    void systemLanguage().then((language) => {
      if (alive) setSystem(language)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <select
      className="field-input set-select"
      aria-label={t('appearance.language.title')}
      value={value}
      onChange={(e) => {
        if (isLanguagePreference(e.target.value)) onPick(e.target.value)
      }}
    >
      <option value="system">
        {system
          ? t('appearance.language.systemNamed', { language: LANGUAGE_NAMES[system] })
          : t('appearance.language.system')}
      </option>
      {LANGUAGES.map((language) => (
        <option key={language} value={language} lang={language}>
          {LANGUAGE_NAMES[language]}
        </option>
      ))}
    </select>
  )
}

export default function SettingsModal({
  settings,
  versions,
  onChange,
  onClose,
  onManageAccounts,
  onManageKeys,
  onManageMcpServers,
  onManageChatDefaults,
  onManageCustomInstructions,
  onReviewSetup
}: Props): JSX.Element {
  useSuppressPreview()
  const { t } = useTranslation('settings')
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

  // Switch the interface's language right away, as with the theme.
  function pickLanguage(language: LanguagePreference): void {
    void applyLanguagePreference(language)
    onChange({ language })
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
            <h2 id={titleId}>{t('title')}</h2>
            <button className="btn btn--sm btn--ghost" onClick={onClose} aria-label={t('close')}>
              ✕
            </button>
          </div>

          <div className="modal-body settings-body">
            <Section title={t('general.title')}>
              {onManageAccounts && (
                <Item title={t('general.accounts.title')} desc={t('general.accounts.desc')}>
                  <button type="button" className="btn btn--sm" onClick={onManageAccounts}>
                    {t('general.accounts.action')}
                  </button>
                </Item>
              )}
              {onManageKeys && (
                <Item title={t('general.apiKeys.title')} desc={t('general.apiKeys.desc')}>
                  <button type="button" className="btn btn--sm" onClick={onManageKeys}>
                    {t('general.apiKeys.action')}
                  </button>
                </Item>
              )}
              {onManageMcpServers && (
                <Item title={t('general.mcpServers.title')} desc={t('general.mcpServers.desc')}>
                  <button type="button" className="btn btn--sm" onClick={onManageMcpServers}>
                    {t('general.mcpServers.action')}
                  </button>
                </Item>
              )}
              {onManageChatDefaults && (
                <Item title={t('general.chatDefaults.title')} desc={t('general.chatDefaults.desc')}>
                  <button type="button" className="btn btn--sm" onClick={onManageChatDefaults}>
                    {t('general.chatDefaults.action')}
                  </button>
                </Item>
              )}
              {onManageCustomInstructions && (
                <Item
                  title={t('general.customInstructions.title')}
                  desc={t('general.customInstructions.desc')}
                >
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={onManageCustomInstructions}
                  >
                    {t('general.customInstructions.action')}
                  </button>
                </Item>
              )}
              {onReviewSetup && (
                <Item title={t('general.setup.title')} desc={t('general.setup.desc')}>
                  <button type="button" className="btn btn--sm" onClick={onReviewSetup}>
                    {t('general.setup.action')}
                  </button>
                </Item>
              )}
              <Item
                title={t('general.workspaceFolder.title')}
                desc={t('general.workspaceFolder.desc')}
                extra={
                  <code className="set-path" title={workspaceRoot ?? ''}>
                    {workspaceRoot ?? '…'}
                  </code>
                }
              >
                <button type="button" className="btn btn--sm" onClick={() => void changeRoot()}>
                  {t('actions.change')}
                </button>
              </Item>
            </Section>

            <Section title={t('appearance.title')}>
              <Item title={t('appearance.theme.title')} desc={t('appearance.theme.desc')}>
                <div className="seg" role="group" aria-label={t('appearance.theme.title')}>
                  {THEMES.map((theme) => (
                    <button
                      key={theme.value}
                      type="button"
                      className={`seg-btn${settings.theme === theme.value ? ' seg-btn--active' : ''}`}
                      aria-pressed={settings.theme === theme.value}
                      onClick={() => pickTheme(theme.value)}
                    >
                      {t(theme.label)}
                    </button>
                  ))}
                </div>
              </Item>
              <Item title={t('appearance.language.title')} desc={t('appearance.language.desc')}>
                <LanguagePicker value={settings.language ?? 'system'} onPick={pickLanguage} />
              </Item>
              <Item title={t('appearance.textSize.title')} desc={t('appearance.textSize.desc')}>
                <div className="seg" role="group" aria-label={t('appearance.textSize.title')}>
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
            </Section>

            <Section title={t('diagnostics.title')}>
              <Item title={t('diagnostics.usage.title')} desc={t('diagnostics.usage.desc')} />
              <ToggleRow
                label={t('diagnostics.full.title')}
                hint={t('diagnostics.full.desc')}
                checked={Boolean(settings.fullDiagnostics)}
                onChange={(v) => onChange({ fullDiagnostics: v })}
              />
              <Item title={t('diagnostics.logs.title')} desc={t('diagnostics.logs.desc')}>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={exporting}
                  onClick={() => void exportDiagnostics()}
                >
                  {exporting ? t('diagnostics.logs.exporting') : t('diagnostics.logs.export')}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void window.api.openLogs()}
                >
                  {t('diagnostics.logs.openFolder')}
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
                    <span className="set-item-title" id={experimentsTitleId}>
                      {t('experiments.title')}
                    </span>
                    <span className="set-item-desc" id={experimentsDescId}>
                      {t('experiments.desc')}
                    </span>
                  </span>
                  <Codicon name="chevron-down" className="set-expander-caret" />
                </button>
                {showExperiments && (
                  <div className="set-expander-body" id={experimentsId}>
                    <ToggleRow
                      label={t('experiments.teamWorkspaces.title')}
                      hint={t('experiments.teamWorkspaces.desc')}
                      checked={Boolean(settings.experiments?.teamWorkspaces)}
                      onChange={(v) => onChange({ experiments: { teamWorkspaces: v } })}
                    />
                    <ToggleRow
                      label={t('experiments.reportMigration.title')}
                      hint={t('experiments.reportMigration.desc')}
                      checked={Boolean(settings.experiments?.reportMigration)}
                      onChange={(v) => onChange({ experiments: { reportMigration: v } })}
                    />
                    <ToggleRow
                      label={t('experiments.workIq.title')}
                      hint={t('experiments.workIq.desc')}
                      checked={Boolean(settings.experiments?.workIq)}
                      onChange={(v) => onChange({ experiments: { workIq: v } })}
                    />
                  </div>
                )}
              </div>
            </section>

            <Section title={t('about.title')}>
              {versions && <VersionInfo versions={versions} />}
              <Item title={t('about.help.title')} desc={t('about.help.desc')}>
                <button type="button" className="btn btn--sm" onClick={() => openDocs('home')}>
                  {t('about.help.docs')}
                  <Codicon name="link-external" className="set-ext" />
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => openDocs('troubleshooting')}
                >
                  {t('about.help.troubleshooting')}
                  <Codicon name="link-external" className="set-ext" />
                </button>
              </Item>
            </Section>
          </div>

          <div className="modal-footer">
            <button className="btn btn--primary" onClick={onClose}>
              {t('actions.done')}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
