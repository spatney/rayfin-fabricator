import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode
} from 'react'
import type { HandoffOptions, HandoffPreview, HandoffSaveResult, StudioProject } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { errorMessage } from '../errorReport'
import { fabricWorkspaceUrl } from '../fabric'
import { formatBytes, listNames } from './blueprint/localData'
import { hueOf } from './team/map/parts'

interface Props {
  project: StudioProject
  /** Why it can't be packed right now: Copilot is working on it, or it's publishing. */
  busy?: string
  onClose: () => void
}

type Phase = 'loading' | 'choose' | 'saving' | 'done'

/** Files that may hold secrets named before "and N more". */
const KEPT_OUT_SHOWN = 3

function count(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
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

/** One part of the project the hand-off can hold, with whether it does. */
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
  /** Always in a hand-off. */
  locked?: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
  children: ReactNode
}): JSX.Element {
  const id = useId()
  return (
    <label
      className={`handoff-part${checked ? ' handoff-part--on' : ''}${locked ? ' handoff-part--locked' : ''}`}
    >
      <input
        type="checkbox"
        className="handoff-part-input"
        checked={checked}
        disabled={locked || disabled}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      <span className="handoff-check" aria-hidden="true">
        <CheckMark />
      </span>
      <span className="handoff-part-text">
        <span className="handoff-part-head">
          <span className="handoff-part-title" id={`${id}-title`}>
            {title}
          </span>
          <span className="handoff-part-detail">{detail}</span>
        </span>
        <span className="handoff-part-desc" id={`${id}-desc`}>
          {children}
        </span>
      </span>
    </label>
  )
}

/**
 * Hand a project off to someone else: choose what the .zip holds besides the
 * code (its version history, where it's published, its chat), save it, then
 * see what the recipient needs to carry on. Secret values, the app's local data
 * and sign-ins never go in.
 */
export default function HandoffProjectModal({ project, busy, onClose }: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const saveRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)
  const [phase, setPhase] = useState<Phase>('loading')
  const [preview, setPreview] = useState<HandoffPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [options, setOptions] = useState<HandoffOptions>({
    history: false,
    deployment: false,
    chat: false
  })
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null)
  const [saved, setSaved] = useState<HandoffSaveResult | null>(null)
  const [error, setError] = useState<string | null>(null)
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
    window.api.projects.handoff.preview(project.id).then(
      (next) => {
        if (!mountedRef.current) return
        setPreview(next)
        setOptions({
          history: Boolean(next.history),
          deployment: Boolean(next.deployment),
          chat: next.chatMessages > 0
        })
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

  // Once there's something to save, Enter saves it.
  useEffect(() => {
    if (phase === 'choose' && preview && !busy) saveRef.current?.focus()
  }, [phase, preview, busy])

  // Listen from the start, so no event of a save is missed. Only one save runs per project.
  useEffect(
    () =>
      window.api.projects.handoff.onProgress((event) => {
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
    let result: HandoffSaveResult
    try {
      result = await window.api.projects.handoff.save(project.id, options)
    } catch (reason) {
      result = { ok: false, error: errorMessage(reason, 'Fabricator couldn’t save the hand-off.') }
    }
    if (!mountedRef.current) return
    setProgress(null)
    if (result.ok) {
      setSaved(result)
      setPhase('done')
      return
    }
    if (!result.cancelled) setError(result.error ?? 'Fabricator couldn’t save the hand-off.')
    setPhase('choose')
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
        className="modal handoff-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={saving || phase === 'loading' || undefined}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Hand off project</h2>
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

        <div className="modal-body handoff-body">
          <div className="project-manage-summary">
            <span
              className="home-project-mark project-manage-mark"
              aria-hidden="true"
              style={{ '--hue': hueOf(project.name) } as CSSProperties}
            >
              {project.name.trim()[0]?.toUpperCase() ?? '?'}
            </span>
            <span className="project-manage-summary-text">
              <strong>{project.name}</strong>
              <span className="handoff-lead">
                {phase === 'done'
                  ? 'Its hand-off is ready to send.'
                  : 'Save it as a .zip someone else can open in Fabricator and carry on from.'}
              </span>
            </span>
          </div>

          {phase === 'loading' && (
            <p className="handoff-status" role="status">
              <span className="ws-spinner" aria-hidden="true" />
              Checking what to include…
            </p>
          )}

          {previewError && phase === 'choose' && (
            <div className="project-manage-error handoff-error" role="alert">
              <span>{previewError}</span>
              <button type="button" className="btn btn--sm" onClick={loadPreview}>
                Try again
              </button>
            </div>
          )}

          {preview && (phase === 'choose' || (saving && !progress)) && (
            <>
              <div className="handoff-parts" role="group" aria-label="What the hand-off includes">
                <Part
                  title="App code"
                  detail={`${count(preview.files, 'file')} · ${formatBytes(preview.bytes)}`}
                  checked
                  locked
                >
                  Its source and settings. Installed packages and build output stay out; Fabricator
                  installs them again.
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
                {preview.chatMessages > 0 && (
                  <Part
                    title="Chat"
                    detail={count(preview.chatMessages, 'message')}
                    checked={options.chat}
                    disabled={saving}
                    onChange={(chat) => setOptions((o) => ({ ...o, chat }))}
                  >
                    Your conversation with Copilot, so they can see how the app was built.
                  </Part>
                )}
              </div>

              <div className="handoff-note">
                <span className="codicon codicon-lock" aria-hidden="true" />
                <span>
                  Never included: secret values
                  {secrets.length > 0 && ` (${listNames(secrets)})`}, the app’s data on this
                  computer and your sign-ins.
                  {keptOut.length > 0 && (
                    <span className="handoff-note-extra">
                      Also left out in case they hold secrets: {listNames(keptOutShown)}.
                    </span>
                  )}
                </span>
              </div>

              {busy && (
                <p className="handoff-busy" role="status">
                  <span className="handoff-dot" aria-hidden="true" />
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
            <div className="handoff-packing" role="status">
              <span className="handoff-packing-text">
                <span className="ws-spinner" aria-hidden="true" />
                Packing {project.name}…
              </span>
              <span
                className="handoff-bar"
                role="progressbar"
                aria-label="Hand-off progress"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.processed}
              >
                <span
                  style={{
                    width: `${progress.total ? Math.max(2, (progress.processed / progress.total) * 100) : 2}%`
                  }}
                />
              </span>
              <span className="handoff-packing-count">
                {progress.processed.toLocaleString('en-US')} of {count(progress.total, 'file')}
              </span>
            </div>
          )}

          {phase === 'done' && saved?.path && (
            <>
              <div className="handoff-saved">
                <span
                  className="codicon codicon-pass-filled handoff-saved-icon"
                  aria-hidden="true"
                />
                <span className="handoff-saved-text">
                  <strong>Saved {fileName(saved.path)}</strong>
                  <span>
                    {formatBytes(saved.bytes ?? 0)} · {count(saved.files ?? 0, 'file')}
                  </span>
                </span>
              </div>
              <div className="handoff-path" title={saved.path}>
                {saved.path}
              </div>
              {error && (
                <p className="project-manage-error" role="alert">
                  {error}
                </p>
              )}

              <section className="handoff-next" aria-labelledby={`${titleId}-next`}>
                <h3 className="project-manage-heading" id={`${titleId}-next`}>
                  What happens next
                </h3>
                <ol className="handoff-steps">
                  <li>Send them the .zip, by email, chat or a shared folder.</li>
                  <li>
                    In Fabricator, they select <strong>Open existing</strong>, then{' '}
                    <strong>Open a hand-off</strong>. The HANDOFF.md inside walks them through it
                    too.
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
                            className="handoff-link"
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
                    window.api.projects.handoff.reveal(saved.path).catch((reason) => {
                      setError(errorMessage(reason, 'Fabricator couldn’t show the .zip.'))
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
              onClick={() => void window.api.projects.handoff.stop(project.id)}
            >
              Stop
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={saving} onClick={onClose}>
                Cancel
              </button>
              <button
                ref={saveRef}
                type="button"
                className="btn btn--primary"
                disabled={!canSave}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save .zip…'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
