import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import type { ImportPreview, ImportResult, StudioProject } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { errorMessage } from '../errorReport'
import { formatLocale, Trans, translator, useTranslation } from '../i18n'
import { formatBytes, listNames } from './blueprint/localData'
import { displayPath } from './projectDisplay'
import { ProjectFileProgress, ProjectFileSummary, fileName } from './projectFile'
import SecurityCheckPanel from './security/SecurityCheck'
import { useSecurityCheck } from './security/useSecurityCheck'

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
  return at.toLocaleDateString(formatLocale(), { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Import a project someone exported: see what its file brings in (who exported
 * it, where it's published, the secrets it needs) and where it will go, then
 * unpack it into the projects folder and open it. Opening a project installs its
 * packages and runs it, so this asks first, whether the file was picked here or
 * opened with Fabricator, and offers to check the file for security risks first.
 */
export default function ImportProjectModal({ path, onImported, onClose }: Props): JSX.Element {
  const { t } = useTranslation('projects')
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const importRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)
  const [phase, setPhase] = useState<Phase>('loading')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null)
  const check = useSecurityCheck(path, 'project')
  const importing = phase === 'importing'
  const checking = check.state.phase === 'running'
  const checked = check.state.phase === 'done' ? check.state.report : null
  const risky = checked?.verdict === 'danger'
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
        setError(errorMessage(reason, translator('projects')('import.errors.cantRead', { file })))
        setPhase('review')
      }
    )
  }, [path, file])

  useEffect(() => {
    if (phase === 'review' && preview) importRef.current?.focus()
  }, [phase, preview])

  // When the check ends, its verdict decides what Enter does: import, or
  // after a serious risk, nothing until you choose.
  useEffect(() => {
    if (!checked) return
    ;(risky ? cancelRef : importRef).current?.focus()
  }, [checked, risky])

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
      result = {
        ok: false,
        error: errorMessage(reason, t('import.errors.cantImport', { file }))
      }
    }
    if (!mountedRef.current) return
    if (result.ok && result.project) {
      onImported(result.project)
      onClose()
      return
    }
    setError(result.error ?? t('import.errors.cantImport', { file }))
    setPhase('review')
  }

  const when = exportedOn(preview?.exportedAt)
  const lead = preview?.from
    ? when
      ? t('import.exportedByOn', { from: preview.from, date: when })
      : t('import.exportedBy', { from: preview.from })
    : t('import.fromFile', { file })

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
          <h2 id={titleId}>{t('import.title')}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('actions.close')}
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
              {t('import.reading', { file })}
            </p>
          )}

          {!preview && error && (
            <p className="project-manage-error" role="alert">
              {error}
            </p>
          )}

          {preview && (
            <ProjectFileSummary name={preview.name}>
              {importing ? t('import.importingFrom', { file }) : lead}
            </ProjectFileSummary>
          )}

          {preview && importing && progress && (
            <ProjectFileProgress
              label={t('import.importingName', { name: preview.name })}
              name={t('import.progress')}
              processed={progress.processed}
              total={progress.total}
            />
          )}

          {preview && !(importing && progress) && (
            <>
              <div className="project-file-parts" role="list" aria-label={t('import.bringsIn')}>
                <Fact
                  icon="file-code"
                  title={t('parts.code')}
                  detail={`${t('file.files', { count: preview.files })} · ${formatBytes(preview.bytes)}`}
                >
                  {t('import.code.desc')}
                </Fact>
                {preview.history && (
                  <Fact icon="history" title={t('parts.history')}>
                    {t('import.history.desc')}
                  </Fact>
                )}
                {preview.workspace && (
                  <Fact icon="cloud" title={t('parts.published')} detail={preview.workspace}>
                    {preview.from
                      ? t('import.published.askFrom', { from: preview.from })
                      : t('import.published.needAccess')}
                  </Fact>
                )}
                {preview.secrets.length > 0 && (
                  <Fact icon="key" title={t('parts.secrets')} detail={listNames(preview.secrets)}>
                    {t('import.secrets.desc')}
                  </Fact>
                )}
              </div>

              <p className="project-file-note">
                <span className="codicon codicon-folder" aria-hidden="true" />
                <span>
                  <Trans
                    t={t}
                    i18nKey="import.folder"
                    values={{ folder: displayPath(preview.folder) }}
                    components={{
                      code: <code className="project-file-code" title={preview.folder} />
                    }}
                  />
                </span>
              </p>
              <p className="project-file-note">
                <span className="codicon codicon-shield" aria-hidden="true" />
                <span>{t('import.trust')}</span>
              </p>

              <SecurityCheckPanel check={check} kind="project" disabled={importing} />

              {error && (
                <p className="project-manage-error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            disabled={importing}
            onClick={onClose}
          >
            {preview ? t('actions.cancel') : t('actions.close')}
          </button>
          {preview && (
            <button
              ref={importRef}
              type="button"
              className={risky ? 'btn btn--danger' : 'btn btn--primary'}
              disabled={importing || checking}
              onClick={() => void importIt()}
            >
              {importing
                ? t('import.importing')
                : risky
                  ? t('import.importAnyway')
                  : t('import.import')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
