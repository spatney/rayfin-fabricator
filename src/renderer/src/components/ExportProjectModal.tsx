import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import type { ExportOptions, ExportPreview, ExportResult, StudioProject } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { errorMessage } from '../errorReport'
import { fabricWorkspaceUrl } from '../fabric'
import { docsUrl } from '../docsLinks'
import { formatBytes, listNames } from './blueprint/localData'
import { ProjectFileProgress, ProjectFileSummary, count, fileName } from './projectFile'

interface Props {
  project: StudioProject
  /** Why it can't be exported right now: Copilot is working on it, or it's publishing. */
  busy?: string
  onClose: () => void
}

type Phase = 'loading' | 'choose' | 'saving' | 'done'

/** Files that may hold secrets named before "and N more". */
const KEPT_OUT_SHOWN = 3

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
 * Export a project for someone else: choose what its `.fabricator` file holds
 * besides the code (its version history, where it's published), save it, then
 * see what the recipient needs to carry on. Secret values, the app's local data
 * and sign-ins never go in.
 */
export default function ExportProjectModal({ project, busy, onClose }: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const exportRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)
  const [phase, setPhase] = useState<Phase>('loading')
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [options, setOptions] = useState<ExportOptions>({ history: false, deployment: false })
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null)
  const [saved, setSaved] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  const saving = phase === 'saving'

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
        setPreviewError(errorMessage(reason, 'Fabricator couldn’t look at this project.'))
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
    let result: ExportResult
    try {
      result = await window.api.projects.exportProject(project.id, options)
    } catch (reason) {
      result = { ok: false, error: errorMessage(reason, 'Fabricator couldn’t export the project.') }
    }
    if (!mountedRef.current) return
    setProgress(null)
    if (result.ok) {
      setSaved(result)
      setPhase('done')
      return
    }
    if (!result.cancelled) setError(result.error ?? 'Fabricator couldn’t export the project.')
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
      () => setError('Fabricator couldn’t copy the link.')
    )
  }

  const deployment = preview?.deployment
  const workspaceUrl = fabricWorkspaceUrl(deployment?.workspaceId)
  const keptOut = preview?.keptOut ?? []
  const keptOutShown =
    keptOut.length > KEPT_OUT_SHOWN
      ? [...keptOut.slice(0, KEPT_OUT_SHOWN), `${keptOut.length - KEPT_OUT_SHOWN} more`]
      : keptOut
  const secrets = preview?.secrets ?? []
  const canSave = phase === 'choose' && Boolean(preview) && !busy

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
          <h2 id={titleId}>Export project</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            disabled={saving}
            onClick={onClose}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body project-file-body">
          <ProjectFileSummary name={project.name}>
            {phase === 'done'
              ? 'It’s exported and ready to send.'
              : 'Save a copy someone else can import into Fabricator.'}
          </ProjectFileSummary>

          {phase === 'loading' && (
            <p className="project-file-status" role="status">
              <span className="ws-spinner" aria-hidden="true" />
              Checking what to include…
            </p>
          )}

          {previewError && phase === 'choose' && (
            <div className="project-manage-error project-file-error" role="alert">
              <span>{previewError}</span>
              <button type="button" className="btn btn--sm" onClick={loadPreview}>
                Try again
              </button>
            </div>
          )}

          {preview && (phase === 'choose' || (saving && !progress)) && (
            <>
              <div
                className="project-file-parts"
                role="group"
                aria-label="What the export includes"
              >
                <Part
                  title="App code"
                  detail={`${count(preview.files, 'file')} · ${formatBytes(preview.bytes)}`}
                  checked
                  locked
                >
                  Source and settings. Installed packages and build output stay out.
                </Part>
                {preview.history && (
                  <Part
                    title="Version history"
                    detail={`${count(preview.history.versions, 'version')} · ${formatBytes(preview.history.bytes)}`}
                    checked={options.history}
                    disabled={saving}
                    onChange={(history) => setOptions((o) => ({ ...o, history }))}
                  >
                    Every saved version, so History and Restore work for them too.
                  </Part>
                )}
                {deployment && (
                  <Part
                    title="Published app"
                    detail={deployment.workspace}
                    checked={options.deployment}
                    disabled={saving}
                    onChange={(on) => setOptions((o) => ({ ...o, deployment: on }))}
                  >
                    {options.deployment
                      ? 'Their publishes update this same app. They’ll need access to its workspace.'
                      : 'They’ll publish it as a new app, in a workspace they choose.'}
                  </Part>
                )}
              </div>

              <div className="project-file-note">
                <span className="codicon codicon-lock" aria-hidden="true" />
                <span>
                  Never included: your chat, secret values
                  {secrets.length > 0 && ` (${listNames(secrets)})`}, local app data or sign-ins.
                  {keptOut.length > 0 && (
                    <span className="project-file-note-extra">
                      Also left out in case they hold secrets: {listNames(keptOutShown)}.
                    </span>
                  )}
                </span>
              </div>

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
              label={`Exporting ${project.name}…`}
              name="Export progress"
              processed={progress.processed}
              total={progress.total}
            />
          )}

          {phase === 'done' && saved?.path && (
            <>
              <div className="project-file-saved">
                <span
                  className="codicon codicon-pass-filled project-file-saved-icon"
                  aria-hidden="true"
                />
                <span className="project-file-saved-text">
                  <strong>Saved {fileName(saved.path)}</strong>
                  <span>
                    {formatBytes(saved.bytes ?? 0)} · {count(saved.files ?? 0, 'file')}
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
                  What happens next
                </h3>
                <ol className="project-file-steps">
                  <li>Send them the file, by email, chat or a shared folder.</li>
                  <li>
                    They double-click it to import it into Fabricator, or select{' '}
                    <strong>Open existing</strong>, then <strong>Import a project</strong>. New to
                    Fabricator?{' '}
                    <button type="button" className="project-file-link" onClick={copyInstallLink}>
                      {linkCopied ? 'Install link copied' : 'Copy the install link'}
                      <span
                        className={`codicon codicon-${linkCopied ? 'check' : 'copy'}`}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                  {options.deployment && deployment && (
                    <li>
                      So they can publish, give them Contributor access to{' '}
                      <strong>{deployment.workspace}</strong> in Fabric.
                      {workspaceUrl && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="project-file-link"
                            onClick={() => void window.api.openExternal(workspaceUrl)}
                          >
                            Open the workspace
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
                      setError(errorMessage(reason, 'Fabricator couldn’t show the file.'))
                    })
                  }
                }}
              >
                <span className="codicon codicon-folder-opened" aria-hidden="true" />
                Show in folder
              </button>
              <button type="button" className="btn btn--primary" autoFocus onClick={onClose}>
                Done
              </button>
            </>
          ) : saving && progress ? (
            <button
              type="button"
              className="btn"
              onClick={() => void window.api.projects.stopExport(project.id)}
            >
              Stop
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={saving} onClick={onClose}>
                Cancel
              </button>
              <button
                ref={exportRef}
                type="button"
                className="btn btn--primary"
                disabled={!canSave}
                onClick={() => void save()}
              >
                {saving ? 'Exporting…' : 'Export…'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
