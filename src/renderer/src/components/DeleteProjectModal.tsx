import { useEffect, useId, useMemo, useState } from 'react'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { FabricIcon } from './icons'
import type { DeleteProgressEvent, ProjectsState, StudioProject } from '@shared/ipc'

interface Props {
  project: StudioProject
  onRemoved: (projects: ProjectsState) => void
  onClose: () => void
}

type StepStatus = 'pending' | 'active' | 'done' | 'error'
type StepKey = 'fabric' | 'local'

interface Step {
  key: StepKey
  label: string
  hint: string
  status: StepStatus
}

/** Reject if the promise hasn't settled within `ms` so the UI can never hang. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

function TrashGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckGlyph(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 13l4 4L19 7"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function AlertGlyph(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 8v5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="1.2" fill="currentColor" />
    </svg>
  )
}

/** Live hint for the active "move to trash" step, driven by `delete:progress`. */
function localStepHint(
  fallback: string,
  progress: DeleteProgressEvent | null,
  elapsed: number
): string {
  if (!progress) return fallback
  if (progress.phase === 'scanning') {
    return `Scanning files… ${progress.processed.toLocaleString()}`
  }
  const total = (progress.total ?? progress.processed).toLocaleString()
  return elapsed > 0
    ? `Moving ${total} files to trash… (${elapsed}s)`
    : `Moving ${total} files to trash…`
}

/**
 * A focused, stepped dialog for moving a project to trash. It can additionally
 * remove deployed Fabric app(s), only when that separate option is selected.
 */
export default function DeleteProjectModal({ project, onRemoved, onClose }: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const hasDeploy = Boolean(project.lastDeploy?.url)
  const [alsoDeleteFabric, setAlsoDeleteFabric] = useState(false)
  const [phase, setPhase] = useState<'confirm' | 'running' | 'error' | 'done'>('confirm')
  const [steps, setSteps] = useState<Step[]>([])
  const [error, setError] = useState<string | null>(null)
  /** Which step failed — drives the recovery actions shown in the footer. */
  const [failedAt, setFailedAt] = useState<StepKey | null>(null)
  /** Live file-count progress for the local "move to trash" step. */
  const [localProgress, setLocalProgress] = useState<DeleteProgressEvent | null>(null)
  /** Seconds elapsed during the (countless) OS trash move, for reassurance. */
  const [trashElapsed, setTrashElapsed] = useState(0)

  const running = phase === 'running'

  // Stream the backend's file-count progress for *this* project's delete.
  useEffect(() => {
    const off = window.api.onDeleteProgress((e) => {
      if (e.id === project.id) setLocalProgress(e)
    })
    return off
  }, [project.id])

  // The OS trash move reports no per-file progress, so tick an elapsed timer
  // while it runs so the step never looks frozen.
  useEffect(() => {
    if (localProgress?.phase !== 'trashing') return
    const started = Date.now()
    const t = setInterval(() => setTrashElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(t)
  }, [localProgress?.phase])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, onClose])

  const fabricLabel = useMemo(
    () =>
      project.workspaceName
        ? `Removing the deployed app from ${project.workspaceName}`
        : 'Removing the deployed app from Fabric',
    [project.workspaceName]
  )

  function mark(key: StepKey, status: StepStatus): void {
    setSteps((cur) => cur.map((s) => (s.key === key ? { ...s, status } : s)))
  }

  /**
   * Run the delete. `skipFabric` lets the error-recovery path remove the project
   * locally even when the Fabric cleanup keeps failing.
   */
  async function run(skipFabric: boolean): Promise<void> {
    const wantFabric = alsoDeleteFabric && !skipFabric
    const plan: Step[] = []
    if (wantFabric) {
      plan.push({
        key: 'fabric',
        label: fabricLabel,
        hint: 'Removing the published app and its data',
        status: 'pending'
      })
    }
    plan.push({
      key: 'local',
      label: 'Moving project files to trash',
      hint: 'You can restore them from your system trash',
      status: 'pending'
    })
    setSteps(plan)
    setError(null)
    setFailedAt(null)
    setLocalProgress(null)
    setTrashElapsed(0)
    setPhase('running')

    if (wantFabric) {
      mark('fabric', 'active')
      try {
        let res = await withTimeout(window.api.fabric.deleteApps(project.id), 130_000)
        if (!res.ok && res.needsLogin) {
          // The Fabric session expired — re-sign-in once, then retry.
          const login = await window.api.auth.loginRayfin()
          if (login.ok) res = await withTimeout(window.api.fabric.deleteApps(project.id), 130_000)
        }
        if (!res.ok) {
          mark('fabric', 'error')
          setFailedAt('fabric')
          setError(
            res.needsLogin
              ? 'Your Fabric session expired and sign-in was cancelled. Sign in and try again, or delete locally only.'
              : (res.failures[0]?.error ?? res.error ?? 'Could not delete the app from Fabric.')
          )
          setPhase('error')
          return
        }
      } catch {
        mark('fabric', 'error')
        setFailedAt('fabric')
        setError(
          'Deleting from Fabric is taking longer than expected — it may be a slow connection. Try again, or delete locally only.'
        )
        setPhase('error')
        return
      }
      mark('fabric', 'done')
    }

    mark('local', 'active')
    let next: ProjectsState
    try {
      next = await withTimeout(window.api.projects.remove(project.id, true), 90_000)
    } catch {
      mark('local', 'error')
      setFailedAt('local')
      setError(
        'Moving the files to trash is taking too long — a file may be locked by a running process (e.g. a dev server or open editor). Stop it and try again, or just remove the project from this list.'
      )
      setPhase('error')
      return
    }
    mark('local', 'done')
    setPhase('done')
    // Let the finished checklist land before the dialog closes.
    setTimeout(() => {
      onRemoved(next)
      onClose()
    }, 550)
  }

  /** Error recovery: drop the project from the list without deleting its files. */
  async function removeFromListOnly(): Promise<void> {
    setPhase('running')
    setError(null)
    try {
      const next = await withTimeout(window.api.projects.remove(project.id, false), 30_000)
      onRemoved(next)
      onClose()
    } catch {
      setError('Could not remove the project. Please try again.')
      setPhase('error')
    }
  }

  const headerTitle =
    phase === 'confirm'
      ? 'Remove project'
      : phase === 'error'
        ? 'Couldn’t finish removing the project'
        : phase === 'done'
          ? alsoDeleteFabric
            ? 'Project files and Fabric app removed'
            : 'Local project folder moved to trash'
          : alsoDeleteFabric
            ? 'Removing project files and Fabric app...'
            : 'Moving local project folder to trash...'

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div
        className="modal modal--sm delete-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{headerTitle}</h2>
        </div>

        <div className="modal-body">
          {phase === 'confirm' ? (
            <div className="confirm-message">
              <p>
                Choose what to remove for <strong>{project.name}</strong>.
              </p>
              <div className="delete-scope">
                <span className="delete-scope-label">Local project folder</span>
                <span className="delete-scope-hint">
                  Move it to your system trash. You can restore it from there.
                </span>
                <p className="confirm-path">{project.path}</p>
              </div>
              {hasDeploy ? (
                <label
                  className={`confirm-check confirm-check--toggle${
                    alsoDeleteFabric ? ' confirm-check--selected' : ''
                  }`}
                >
                  <span className="confirm-check-copy">
                    <span className="confirm-check-label">
                      Also permanently delete the deployed Fabric app
                    </span>
                    <span className="confirm-check-hint">
                      {project.workspaceName ? (
                        <>
                          {' '}
                          — deletes this app and its data in{' '}
                          <strong>{project.workspaceName}</strong>. The Fabric workspace itself is
                          not deleted.
                        </>
                      ) : (
                        <>
                          {' '}
                          — deletes this app and its data. The Fabric workspace itself is not
                          deleted.
                        </>
                      )}
                    </span>
                  </span>
                  <span className={`switch${alsoDeleteFabric ? ' switch--on' : ''}`}>
                    <input
                      type="checkbox"
                      aria-label="Also permanently delete the deployed Fabric app"
                      checked={alsoDeleteFabric}
                      onChange={(e) => setAlsoDeleteFabric(e.target.checked)}
                    />
                    <span className="switch-knob" />
                  </span>
                </label>
              ) : (
                <p className="confirm-note">
                  No deployed Fabric app is linked to this project. Only the local folder will be
                  moved to trash.
                </p>
              )}
            </div>
          ) : (
            <ol className="delete-steps">
              {steps.map((s) => {
                const hint =
                  s.key === 'local' && s.status === 'active'
                    ? localStepHint(s.hint, localProgress, trashElapsed)
                    : s.hint
                return (
                  <li key={s.key} className={`delete-step delete-step--${s.status}`}>
                    <span className="delete-step-icon" aria-hidden="true">
                      {s.status === 'done' ? (
                        <CheckGlyph />
                      ) : s.status === 'error' ? (
                        <AlertGlyph />
                      ) : s.status === 'active' ? (
                        <span className="delete-step-spin" />
                      ) : s.key === 'fabric' ? (
                        <FabricIcon width={15} height={15} />
                      ) : (
                        <TrashGlyph />
                      )}
                    </span>
                    <span className="delete-step-text">
                      <span className="delete-step-label">{s.label}</span>
                      <span className="delete-step-hint">{hint}</span>
                    </span>
                  </li>
                )
              })}
              {error && (
                <li className="delete-step-error" role="alert">
                  {error}
                </li>
              )}
            </ol>
          )}
        </div>

        <div className="modal-footer">
          {phase === 'confirm' && (
            <>
              <button className="btn btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn--danger" onClick={() => void run(false)} autoFocus>
                {alsoDeleteFabric
                  ? 'Move folder to trash and delete Fabric app'
                  : 'Move folder to trash'}
              </button>
            </>
          )}
          {phase === 'running' && (
            <span className="delete-running-note">
              <span className="delete-step-spin" aria-hidden="true" />
              Working… this can take a moment.
            </span>
          )}
          {phase === 'error' && (
            <>
              <button className="btn btn--ghost" onClick={onClose}>
                Close
              </button>
              {failedAt === 'fabric' ? (
                <button className="btn btn--danger" onClick={() => void run(true)}>
                  Move local folder to trash
                </button>
              ) : (
                <button className="btn btn--ghost" onClick={() => void removeFromListOnly()}>
                  Remove from recent projects
                </button>
              )}
              <button className="btn btn--primary" onClick={() => void run(false)}>
                Try again
              </button>
            </>
          )}
          {phase === 'done' && (
            <span className="delete-running-note delete-running-note--done">
              <span className="delete-done-check" aria-hidden="true">
                <CheckGlyph />
              </span>
              Done
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
