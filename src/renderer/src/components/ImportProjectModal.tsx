import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import type { ImportPreview, ImportResult, StudioProject } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { errorMessage } from '../errorReport'
import { formatBytes, listNames } from './blueprint/localData'
import { displayPath } from './projectDisplay'
import { ProjectFileProgress, ProjectFileSummary, count, fileName } from './projectFile'

interface Props {
  /** The `.fabricator` file, or .zip of a Rayfin project, to import. */
  path: string
  /** The project is imported, and Fabricator has opened it. */
  onImported: (project: StudioProject) => void
  onClose: () => void
}

type Phase = 'loading' | 'review' | 'importing'

/** One thing the file brings in. */
function Fact({
  icon,
  title,
  detail,
  children
}: {
  icon: string
  title: string
  detail?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="project-file-part project-file-part--fact" role="listitem">
      <span className={`project-file-part-icon codicon codicon-${icon}`} aria-hidden="true" />
      <span className="project-file-part-text">
        <span className="project-file-part-head">
          <span className="project-file-part-title">{title}</span>
          {detail && <span className="project-file-part-detail">{detail}</span>}
        </span>
        <span className="project-file-part-desc">{children}</span>
      </span>
    </div>
  )
}

function exportedOn(iso: string | undefined): string | undefined {
  const at = iso ? new Date(iso) : null
  if (!at || Number.isNaN(at.getTime())) return undefined
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Import a project someone exported: see what its file brings in (who exported
 * it, where it's published, the secrets it needs) and where it will go, then
 * unpack it into the projects folder and open it. Opening a project installs its
 * packages and runs it, so this asks first, whether the file was picked here or
 * opened with Fabricator.
 */
export default function ImportProjectModal({ path, onImported, onClose }: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const importRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)
  const [phase, setPhase] = useState<Phase>('loading')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null)
  const importing = phase === 'importing'
  const file = fileName(path)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    setPhase('loading')
    setError(null)
    window.api.projects.inspectImport(path).then(
      (next) => {
        if (!mountedRef.current) return
        setPreview(next)
        setPhase('review')
      },
      (reason) => {
        if (!mountedRef.current) return
        setError(errorMessage(reason, `Fabricator couldn’t read ${file}.`))
        setPhase('review')
      }
    )
  }, [path, file])

  useEffect(() => {
    if (phase === 'review' && preview) importRef.current?.focus()
  }, [phase, preview])

  useEffect(
    () =>
      window.api.projects.onZipProgress((event) => {
        if (event.id === 'import' && event.phase === 'unpacking') {
          setProgress({ processed: event.processed, total: event.total })
        }
      }),
    []
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !importing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, importing])

  async function importIt(): Promise<void> {
    setPhase('importing')
    setProgress(null)
    setError(null)
    let result: ImportResult
    try {
      result = await window.api.projects.importProject(path)
    } catch (reason) {
      result = { ok: false, error: errorMessage(reason, `Fabricator couldn’t import ${file}.`) }
    }
    if (!mountedRef.current) return
    if (result.ok && result.project) {
      onImported(result.project)
      onClose()
      return
    }
    setError(result.error ?? `Fabricator couldn’t import ${file}.`)
    setPhase('review')
  }

  const when = exportedOn(preview?.exportedAt)
  const lead = preview?.from
    ? `Exported by ${preview.from}${when ? ` on ${when}` : ''}`
    : `From ${file}`

  return (
    <div className="modal-backdrop" onClick={importing ? undefined : onClose}>
      <div
        className="modal project-file-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={importing || phase === 'loading' || undefined}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Import project</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            disabled={importing}
            onClick={onClose}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body project-file-body">
          {phase === 'loading' && (
            <p className="project-file-status" role="status">
              <span className="ws-spinner" aria-hidden="true" />
              Reading {file}…
            </p>
          )}

          {!preview && error && (
            <p className="project-manage-error" role="alert">
              {error}
            </p>
          )}

          {preview && (
            <ProjectFileSummary name={preview.name}>
              {importing ? `Importing it from ${file}.` : lead}
            </ProjectFileSummary>
          )}

          {preview && importing && progress && (
            <ProjectFileProgress
              label={`Importing ${preview.name}…`}
              name="Import progress"
              processed={progress.processed}
              total={progress.total}
            />
          )}

          {preview && !(importing && progress) && (
            <>
              <div className="project-file-parts" role="list" aria-label="What it brings in">
                <Fact
                  icon="file-code"
                  title="App code"
                  detail={`${count(preview.files, 'file')} · ${formatBytes(preview.bytes)}`}
                >
                  Fabricator installs its packages when you open it.
                </Fact>
                {preview.history && (
                  <Fact icon="history" title="Version history">
                    Every version saved before, so History and Restore work.
                  </Fact>
                )}
                {preview.workspace && (
                  <Fact icon="cloud" title="Published app" detail={preview.workspace}>
                    {preview.from
                      ? `Publishing updates this same app. Ask ${preview.from} for workspace access.`
                      : 'Publishing updates this same app, once you have access to its workspace.'}
                  </Fact>
                )}
                {preview.secrets.length > 0 && (
                  <Fact icon="key" title="Secrets" detail={listNames(preview.secrets)}>
                    Their values don’t come with it. Set your own in Code → Secrets.
                  </Fact>
                )}
              </div>

              <p className="project-file-note">
                <span className="codicon codicon-folder" aria-hidden="true" />
                <span>
                  It goes in a new folder,{' '}
                  <code className="project-file-code" title={preview.folder}>
                    {displayPath(preview.folder)}
                  </code>
                  .
                </span>
              </p>
              <p className="project-file-note">
                <span className="codicon codicon-shield" aria-hidden="true" />
                <span>
                  Only import projects from people you trust. Their code runs on this computer.
                </span>
              </p>

              {error && (
                <p className="project-manage-error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" disabled={importing} onClick={onClose}>
            {preview ? 'Cancel' : 'Close'}
          </button>
          {preview && (
            <button
              ref={importRef}
              type="button"
              className="btn btn--primary"
              disabled={importing}
              onClick={() => void importIt()}
            >
              {importing ? 'Importing…' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
