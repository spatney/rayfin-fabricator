import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import type { ExportOptions, ExportPreview, ExportResult, StudioProject } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { errorMessage } from '../errorReport'
import { Trans, useTranslation } from '../i18n'
import { fabricWorkspaceUrl } from '../fabric'
import { docsUrl } from '../docsLinks'
import { drawAppIcon } from '../appIcon'
import { formatBytes, listNames } from './blueprint/localData'
import { ProjectFileProgress, ProjectFileSummary, fileName } from './projectFile'
import AppIcon from './AppIcon'

interface Props {
  project: StudioProject
  /** Why it can't be exported right now: Copilot is working on it, or it's publishing. */
  busy?: string
  onClose: () => void
}

type Phase = 'loading' | 'choose' | 'saving' | 'done'

/** What the export is: a project to keep building (`.fabricator`), or an app to use (`.rayfin`). */
type Format = 'project' | 'app'

const FORMATS = [
  {
    id: 'project',
    title: 'export.format.project',
    desc: 'export.format.projectDesc',
    icon: 'tools'
  },
  { id: 'app', title: 'export.format.app', desc: 'export.format.appDesc', icon: 'window' }
] as const satisfies ReadonlyArray<{ id: Format; title: string; desc: string; icon: string }>

/** Files that may hold secrets named before "and N more". */
const KEPT_OUT_SHOWN = 3

/** Choose what the export is. */
function FormatChoice({
  format,
  disabled,
  onChange
}: {
  format: Format
  disabled: boolean
  onChange: (format: Format) => void
}): JSX.Element {
  const { t } = useTranslation('projects')
  const id = useId()
  return (
    <div className="project-file-formats" role="radiogroup" aria-label={t('export.format.label')}>
      {FORMATS.map((option) => (
        <label
          key={option.id}
          className={`project-file-format${format === option.id ? ' project-file-format--on' : ''}`}
        >
          <input
            type="radio"
            className="project-file-format-input"
            name={`${id}-format`}
            value={option.id}
            checked={format === option.id}
            disabled={disabled}
            aria-labelledby={`${id}-${option.id}`}
            aria-describedby={`${id}-${option.id}-desc`}
            onChange={() => onChange(option.id)}
          />
          <span
            className={`codicon codicon-${option.icon} project-file-format-icon`}
            aria-hidden="true"
          />
          <span className="project-file-format-text">
            <span className="project-file-format-title" id={`${id}-${option.id}`}>
              {t(option.title)}
            </span>
            <span className="project-file-format-desc" id={`${id}-${option.id}-desc`}>
              {t(option.desc)}
            </span>
          </span>
        </label>
      ))}
    </div>
  )
}

function CheckMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12.5l4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** One part of the project the export can hold, with whether it does. */
function Part({
  title,
  detail,
  checked,
  locked,
  disabled,
  onChange,
  children
}: {
  title: string
  detail: string
  checked: boolean
  /** Always in an export. */
  locked?: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
  children: ReactNode
}): JSX.Element {
  const id = useId()
  return (
    <label
      className={`project-file-part${checked ? ' project-file-part--on' : ''}${locked ? ' project-file-part--locked' : ''}`}
    >
      <input
        type="checkbox"
        className="project-file-part-input"
        checked={checked}
        disabled={locked || disabled}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      <span className="project-file-check" aria-hidden="true">
        <CheckMark />
      </span>
      <span className="project-file-part-text">
        <span className="project-file-part-head">
          <span className="project-file-part-title" id={`${id}-title`}>
            {title}
          </span>
          <span className="project-file-part-detail">{detail}</span>
        </span>
        <span className="project-file-part-desc" id={`${id}-desc`}>
          {children}
        </span>
      </span>
    </label>
  )
}

/**
 * Export a project for someone else: as a `.fabricator` file to keep building
 * it, with what they choose besides the code (its version history, where it's
 * published), or as a `.rayfin` app to use it, which Fabricator installs and
 * opens in a window of its own. Save it, then see what the recipient needs.
 * Secret values, the app's local data and sign-ins never go in.
 */
export default function ExportProjectModal({ project, busy, onClose }: Props): JSX.Element {
  const { t } = useTranslation('projects')
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const exportRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)
  const [phase, setPhase] = useState<Phase>('loading')
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [format, setFormat] = useState<Format>('project')
  const [options, setOptions] = useState<ExportOptions>({ history: false, deployment: false })
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null)
  const [saved, setSaved] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  const saving = phase === 'saving'
  const asApp = format === 'app'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  function loadPreview(): void {
    setPhase('loading')
    setPreviewError(null)
    window.api.projects.exportPreview(project.id).then(
      (next) => {
        if (!mountedRef.current) return
        setPreview(next)
        setOptions({ history: Boolean(next.history), deployment: Boolean(next.deployment) })
        setPhase('choose')
      },
      (reason) => {
        if (!mountedRef.current) return
        setPreviewError(errorMessage(reason, t('export.errors.cantLook')))
        setPhase('choose')
      }
    )
  }

  useEffect(() => loadPreview(), [project.id])

  // Once there's something to export, Enter exports it.
  useEffect(() => {
    if (phase === 'choose' && preview && !busy) exportRef.current?.focus()
  }, [phase, preview, busy])

  // Listen from the start, so no event of an export is missed. One export runs per project.
  useEffect(
    () =>
      window.api.projects.onZipProgress((event) => {
        if (event.id === project.id && event.phase === 'packing') {
          setProgress({ processed: event.processed, total: event.total })
        }
      }),
    [project.id]
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  async function save(): Promise<void> {
    setPhase('saving')
    setProgress(null)
    setError(null)
    const failure = asApp ? t('export.errors.cantExportApp') : t('export.errors.cantExportProject')
    let result: ExportResult
    try {
      if (asApp && preview) {
        const icons = await drawAppIcon(preview.app.icon, preview.app.name)
        result = await window.api.projects.exportApp(project.id, icons)
      } else {
        result = await window.api.projects.exportProject(project.id, options)
      }
    } catch (reason) {
      result = { ok: false, error: errorMessage(reason, failure) }
    }
    if (!mountedRef.current) return
    setProgress(null)
    if (result.ok) {
      setSaved(result)
      setPhase('done')
      return
    }
    if (!result.cancelled) setError(result.error ?? failure)
    setPhase('choose')
  }

  function copyInstallLink(): void {
    navigator.clipboard.writeText(docsUrl('install')).then(
      () => {
        if (!mountedRef.current) return
        setLinkCopied(true)
        window.setTimeout(() => {
          if (mountedRef.current) setLinkCopied(false)
        }, 2500)
      },
      () => setError(t('export.errors.cantCopy'))
    )
  }

  const deployment = preview?.deployment
  const workspaceUrl = fabricWorkspaceUrl(deployment?.workspaceId)
  const keptOut = preview?.keptOut ?? []
  const keptOutShown =
    keptOut.length > KEPT_OUT_SHOWN
      ? [
          ...keptOut.slice(0, KEPT_OUT_SHOWN),
          t('export.keptOutMore', { count: keptOut.length - KEPT_OUT_SHOWN })
        ]
      : keptOut
  const secrets = preview?.secrets ?? []
  const canSave = phase === 'choose' && Boolean(preview) && !busy
  const neverIncluded = asApp
    ? secrets.length > 0
      ? t('export.never.appSecrets', { secrets: listNames(secrets) })
      : t('export.never.app')
    : secrets.length > 0
      ? t('export.never.projectSecrets', { secrets: listNames(secrets) })
      : t('export.never.project')

  return (
    <div className="modal-backdrop" onClick={saving ? undefined : onClose}>
      <div
        className="modal project-file-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={saving || phase === 'loading' || undefined}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{t('export.title')}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('actions.close')}
            disabled={saving}
            onClick={onClose}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body project-file-body">
          <ProjectFileSummary name={project.name}>
            {phase === 'done'
              ? t('export.lead.done')
              : asApp
                ? t('export.lead.app')
                : t('export.lead.project')}
          </ProjectFileSummary>

          {phase === 'loading' && (
            <p className="project-file-status" role="status">
              <span className="ws-spinner" aria-hidden="true" />
              {t('export.checking')}
            </p>
          )}

          {previewError && phase === 'choose' && (
            <div className="project-manage-error project-file-error" role="alert">
              <span>{previewError}</span>
              <button type="button" className="btn btn--sm" onClick={loadPreview}>
                {t('actions.tryAgain')}
              </button>
            </div>
          )}

          {preview && (phase === 'choose' || (saving && !progress)) && (
            <>
              <FormatChoice format={format} disabled={saving} onChange={setFormat} />
              <div className="project-file-parts" role="group" aria-label={t('export.includes')}>
                <Part
                  title={t('parts.code')}
                  detail={`${t('file.files', { count: preview.files })} · ${formatBytes(preview.bytes)}`}
                  checked
                  locked
                >
                  {t('export.code.desc')}
                </Part>
                {asApp && (
                  <div className="project-file-part project-file-part--fact">
                    <AppIcon name={preview.app.name} src={preview.app.icon} size={20} />
                    <span className="project-file-part-text">
                      <span className="project-file-part-head">
                        <span className="project-file-part-title">{preview.app.name}</span>
                        {preview.app.version && (
                          <span className="project-file-part-detail">
                            {t('parts.version', { version: preview.app.version })}
                          </span>
                        )}
                      </span>
                      <span className="project-file-part-desc">{t('export.app.desc')}</span>
                    </span>
                  </div>
                )}
                {!asApp && preview.history && (
                  <Part
                    title={t('parts.history')}
                    detail={`${t('file.versions', { count: preview.history.versions })} · ${formatBytes(preview.history.bytes)}`}
                    checked={options.history}
                    disabled={saving}
                    onChange={(history) => setOptions((o) => ({ ...o, history }))}
                  >
                    {t('export.history.desc')}
                  </Part>
                )}
                {!asApp && deployment && (
                  <Part
                    title={t('parts.published')}
                    detail={deployment.workspace}
                    checked={options.deployment}
                    disabled={saving}
                    onChange={(on) => setOptions((o) => ({ ...o, deployment: on }))}
                  >
                    {options.deployment
                      ? t('export.published.include')
                      : t('export.published.exclude')}
                  </Part>
                )}
              </div>

              <div className="project-file-note">
                <span className="codicon codicon-lock" aria-hidden="true" />
                <span>
                  {neverIncluded}
                  {keptOut.length > 0 && (
                    <span className="project-file-note-extra">
                      {t('export.keptOut', { files: listNames(keptOutShown) })}
                    </span>
                  )}
                </span>
              </div>
              {asApp && secrets.length > 0 && (
                <p className="project-file-note">
                  <span className="codicon codicon-warning" aria-hidden="true" />
                  <span>{t('export.secretsWarning')}</span>
                </p>
              )}

              {busy && (
                <p className="project-file-busy" role="status">
                  <span className="project-file-dot" aria-hidden="true" />
                  {busy}
                </p>
              )}

              {error && (
                <p className="project-manage-error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}

          {saving && progress && (
            <ProjectFileProgress
              label={t('export.exportingName', { name: project.name })}
              name={t('export.progress')}
              processed={progress.processed}
              total={progress.total}
            />
          )}

          {phase === 'done' && saved?.path && asApp && (
            <>
              <div className="project-file-saved">
                <span
                  className="codicon codicon-pass-filled project-file-saved-icon"
                  aria-hidden="true"
                />
                <span className="project-file-saved-text">
                  <strong>{t('export.saved', { file: fileName(saved.path) })}</strong>
                  <span>
                    {formatBytes(saved.bytes ?? 0)} · {t('file.files', { count: saved.files ?? 0 })}
                  </span>
                </span>
              </div>
              <div className="project-file-path" title={saved.path}>
                {saved.path}
              </div>
              {error && (
                <p className="project-manage-error" role="alert">
                  {error}
                </p>
              )}

              <section className="project-file-next" aria-labelledby={`${titleId}-next`}>
                <h3 className="project-manage-heading" id={`${titleId}-next`}>
                  {t('export.next.title')}
                </h3>
                <ol className="project-file-steps">
                  <li>{t('export.next.send')}</li>
                  <li>
                    {t('export.next.openApp')}{' '}
                    <button type="button" className="project-file-link" onClick={copyInstallLink}>
                      {linkCopied ? t('export.next.linkCopied') : t('export.next.copyLink')}
                      <span
                        className={`codicon codicon-${linkCopied ? 'check' : 'copy'}`}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                  <li>{t('export.next.afterApp')}</li>
                </ol>
              </section>
            </>
          )}

          {phase === 'done' && saved?.path && !asApp && (
            <>
              <div className="project-file-saved">
                <span
                  className="codicon codicon-pass-filled project-file-saved-icon"
                  aria-hidden="true"
                />
                <span className="project-file-saved-text">
                  <strong>{t('export.saved', { file: fileName(saved.path) })}</strong>
                  <span>
                    {formatBytes(saved.bytes ?? 0)} · {t('file.files', { count: saved.files ?? 0 })}
                  </span>
                </span>
              </div>
              <div className="project-file-path" title={saved.path}>
                {saved.path}
              </div>
              {error && (
                <p className="project-manage-error" role="alert">
                  {error}
                </p>
              )}

              <section className="project-file-next" aria-labelledby={`${titleId}-next`}>
                <h3 className="project-manage-heading" id={`${titleId}-next`}>
                  {t('export.next.title')}
                </h3>
                <ol className="project-file-steps">
                  <li>{t('export.next.send')}</li>
                  <li>
                    <Trans
                      t={t}
                      i18nKey="export.next.openProject"
                      components={{ strong: <strong /> }}
                    />{' '}
                    <button type="button" className="project-file-link" onClick={copyInstallLink}>
                      {linkCopied ? t('export.next.linkCopied') : t('export.next.copyLink')}
                      <span
                        className={`codicon codicon-${linkCopied ? 'check' : 'copy'}`}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                  {options.deployment && deployment && (
                    <li>
                      <Trans
                        t={t}
                        i18nKey="export.next.access"
                        values={{ workspace: deployment.workspace }}
                        components={{ strong: <strong /> }}
                      />
                      {workspaceUrl && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="project-file-link"
                            onClick={() => void window.api.openExternal(workspaceUrl)}
                          >
                            {t('export.next.openWorkspace')}
                            <span className="codicon codicon-link-external" aria-hidden="true" />
                          </button>
                        </>
                      )}
                    </li>
                  )}
                </ol>
              </section>
            </>
          )}
        </div>

        <div className="modal-footer">
          {phase === 'done' && saved?.path ? (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (saved.path) {
                    window.api.projects.revealExport(saved.path).catch((reason) => {
                      setError(errorMessage(reason, t('export.errors.cantShow')))
                    })
                  }
                }}
              >
                <span className="codicon codicon-folder-opened" aria-hidden="true" />
                {t('export.showInFolder')}
              </button>
              <button type="button" className="btn btn--primary" autoFocus onClick={onClose}>
                {t('actions.done')}
              </button>
            </>
          ) : saving && progress ? (
            <button
              type="button"
              className="btn"
              onClick={() => void window.api.projects.stopExport(project.id)}
            >
              {t('actions.stop')}
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={saving} onClick={onClose}>
                {t('actions.cancel')}
              </button>
              <button
                ref={exportRef}
                type="button"
                className="btn btn--primary"
                disabled={!canSave}
                onClick={() => void save()}
              >
                {saving ? t('export.exporting') : t('export.export')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
