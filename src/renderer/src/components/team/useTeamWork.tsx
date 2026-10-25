import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { StudioProject, TeamActionResult, TeamProgressEvent, TeamSessionStatus } from '@shared/ipc'
import ConfirmModal from '../ConfirmModal'
import { StepList, teamError, type StepRow } from './common'
import TeamDiagnosis from './diagnosis/TeamDiagnosis'
import TeamDiagnosisModal from './diagnosis/TeamDiagnosisModal'
import { fixInChatPrompt, type DiagnosisInput } from './diagnosis/useTeamDiagnosis'
import { useSuppressPreview } from '../../overlay'
import { useModalFocus } from '../../modalFocus'
import './team.css'

/** Mirrors PUBLISH_STEPS in src-tauri/src/commands/team/publish.rs. */
export const PUBLISH_STEPS = [
  { id: 'save', label: 'Save your latest changes' },
  { id: 'update', label: "Bring in your teammates' changes" },
  { id: 'checks', label: 'Check that your preview deploys' },
  { id: 'review', label: "Get a teammate's approval" },
  { id: 'merge', label: 'Publish your changes' },
  { id: 'deploy', label: 'Deploy the published app' }
] as const

/** The prompt that asks Copilot to finish combining teammates' changes. */
export function conflictPrompt(files: string[]): string {
  const list = files.map((f) => `- ${f}`).join('\n')
  return [
    "My teammates published changes to some of the same files I changed. Fabricator has merged their published version into my working copy, and these files contain git conflict markers (<<<<<<<, =======, >>>>>>>):",
    list,
    '',
    'Resolve every conflict so the app keeps both my changes and theirs. Where they truly contradict, prefer their published version and re-apply my intent on top. Remove all conflict markers, make sure the app still builds, and summarize what you combined. Don’t run git commands; Fabricator saves the result.'
  ].join('\n')
}

interface Options {
  /** The Team workspaces experiment is on (nothing is subscribed otherwise). */
  enabled: boolean
  toast: {
    error: (message: string, opts?: { title?: string }) => number
    success: (message: string, opts?: { title?: string }) => number
    info: (message: string, opts?: { title?: string }) => number
  }
  /** Re-read the projects state (the preview follows `lastDeploy`). */
  refreshProjects: () => Promise<unknown>
  /** Send a prompt to the project's chat. */
  sendToChat: (projectId: string, display: string, prompt: string) => void
}

interface PublishRun {
  projectId: string
  rows: StepRow[]
  running: boolean
  result?: TeamActionResult
}

export interface TeamWork {
  status: (projectId: string) => TeamSessionStatus | undefined
  syncing: (projectId: string) => boolean
  /** Save a finished chat turn to the working branch (deploys the preview). */
  afterTurn: (projectId: string, message: string) => Promise<void>
  refresh: (projectId: string, deep?: boolean) => Promise<void>
  publish: (projectId: string, confirmDataLoss?: boolean) => void
  update: (projectId: string) => void
  combineWithCopilot: (projectId: string, files: string[]) => void
  discard: (projectId: string) => void
  setView: (projectId: string, view: 'preview' | 'production') => void
  viewLogs: (projectId: string, runId: number) => void
  /** Diagnose a failed run or publish with Copilot (read-only), in a dialog. */
  diagnose: (projectId: string, run: { runId?: number; runUrl?: string; error?: string }) => void
  overlays: JSX.Element
}

function recordKey(status: TeamSessionStatus | undefined): string {
  if (!status) return ''
  const r = (x?: { state: string; url?: string; sha?: string }): string =>
    x ? `${x.state}|${x.url ?? ''}|${x.sha ?? ''}` : '-'
  return `${r(status.preview)}/${r(status.production)}/${status.view}/${status.publish?.stage ?? ''}`
}

/**
 * The working loop of team apps: saving after each turn, following the
 * pipeline, Update, Publish, Discard, and the dialogs they need.
 */
export function useTeamWork(activeProject: StudioProject | null, options: Options): TeamWork {
  const [statuses, setStatuses] = useState<Record<string, TeamSessionStatus>>({})
  const [syncingIds, setSyncingIds] = useState<string[]>([])
  const [publishing, setPublishing] = useState<PublishRun | null>(null)
  const [conflicts, setConflicts] = useState<{ projectId: string; files: string[] } | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [logs, setLogs] = useState<{ projectId?: string; runId?: number; text: string | null; error?: string } | null>(null)
  const [diagnosis, setDiagnosis] = useState<{ projectId: string; input: DiagnosisInput } | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses
  const publishingRef = useRef(publishing)
  publishingRef.current = publishing

  const refresh = useCallback(async (projectId: string, deep = true): Promise<void> => {
    let next: TeamSessionStatus
    try {
      next = await window.api.team.status(projectId, deep)
    } catch {
      return
    }
    if (!next.ok && !next.branch) return
    const before = recordKey(statusesRef.current[projectId])
    setStatuses((all) => ({ ...all, [projectId]: next }))
    if (deep && before !== recordKey(next)) void optionsRef.current.refreshProjects()
  }, [])

  // Follow publish progress (long-lived, so no early event is missed).
  const enabled = options.enabled
  useEffect(() => {
    if (!enabled) return
    return window.api.team.onProgress((event: TeamProgressEvent) => {
      const current = publishingRef.current
      if (!current || current.projectId !== event.scope) return
      setPublishing((p) =>
        p && p.projectId === event.scope
          ? {
              ...p,
              rows: p.rows.map((row) =>
                row.id === event.step ? { ...row, state: event.state, detail: event.detail } : row
              )
            }
          : p
      )
    })
  }, [enabled])

  // Poll the active team app: quickly while the pipeline works, slowly otherwise.
  const activeId = enabled && activeProject?.team ? activeProject.id : null
  useEffect(() => {
    if (!activeId) return
    let alive = true
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      await refresh(activeId, true)
      if (!alive) return
      const s = statusesRef.current[activeId]
      const busy =
        (s?.run && s.run.status !== 'completed') ||
        s?.publish?.stage === 'deploying' ||
        s?.preview?.state === 'in_progress' ||
        s?.preview?.state === 'queued'
      timer = window.setTimeout(() => void tick(), busy ? 10_000 : 60_000)
    }
    void tick()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [activeId, refresh])

  const afterTurn = useCallback(
    async (projectId: string, message: string): Promise<void> => {
      setSyncingIds((ids) => [...ids, projectId])
      try {
        const result = await window.api.team.sync(projectId, message)
        if (!result.ok) {
          optionsRef.current.toast.error(result.error ?? 'Your changes were not saved to GitHub.', {
            title: 'Couldn’t save to GitHub'
          })
        }
      } catch (reason) {
        optionsRef.current.toast.error(teamError(reason, 'Your changes were not saved to GitHub.'), {
          title: 'Couldn’t save to GitHub'
        })
      } finally {
        setSyncingIds((ids) => ids.filter((id) => id !== projectId))
        await optionsRef.current.refreshProjects()
        await refresh(projectId, true)
      }
    },
    [refresh]
  )

  const publish = useCallback(
    (projectId: string, confirmDataLoss = false): void => {
      if (publishingRef.current?.running) return
      const run: PublishRun = {
        projectId,
        running: true,
        // A confirmed data-loss deploy only re-runs the last step.
        rows: PUBLISH_STEPS.map((s) => ({
          id: s.id,
          label: s.label,
          state: confirmDataLoss && s.id !== 'deploy' ? 'done' : 'pending'
        }))
      }
      publishingRef.current = run
      setPublishing(run)
      void (async () => {
        let result: TeamActionResult
        try {
          result = await window.api.team.publish(projectId, confirmDataLoss)
        } catch (reason) {
          result = { ok: false, error: teamError(reason, 'Publishing stopped unexpectedly.') }
        }
        setPublishing((p) => (p && p.projectId === projectId ? { ...p, running: false, result } : p))
        if (result.conflicts?.length) setConflicts({ projectId, files: result.conflicts })
        await optionsRef.current.refreshProjects()
        await refresh(projectId, true)
      })()
    },
    [refresh]
  )

  const update = useCallback(
    (projectId: string): void => {
      void (async () => {
        try {
          const result = await window.api.team.update(projectId, false)
          if (result.conflicts?.length) {
            setConflicts({ projectId, files: result.conflicts })
          } else if (!result.ok) {
            optionsRef.current.toast.error(result.error ?? 'Could not bring in the changes.', {
              title: 'Update failed'
            })
          } else {
            optionsRef.current.toast.success("You have your teammates' latest changes.", { title: 'Updated' })
          }
        } catch (reason) {
          optionsRef.current.toast.error(teamError(reason, 'Could not bring in the changes.'), { title: 'Update failed' })
        }
        await optionsRef.current.refreshProjects()
        await refresh(projectId, true)
      })()
    },
    [refresh]
  )

  const combineWithCopilot = useCallback((projectId: string, files: string[]): void => {
    setConflicts(null)
    setPublishing(null)
    void (async () => {
      try {
        const result = await window.api.team.update(projectId, true)
        const conflicted = result.conflicts?.length ? result.conflicts : files
        if (!result.ok && !result.conflicts?.length) {
          optionsRef.current.toast.error(result.error ?? 'Could not start combining the changes.', {
            title: 'Update failed'
          })
          return
        }
        optionsRef.current.sendToChat(
          projectId,
          "Combine my changes with my teammates' published changes",
          conflictPrompt(conflicted)
        )
      } catch (reason) {
        optionsRef.current.toast.error(teamError(reason, 'Could not start combining the changes.'), {
          title: 'Update failed'
        })
      }
    })()
  }, [])

  const setView = useCallback(
    (projectId: string, view: 'preview' | 'production'): void => {
      void window.api.team
        .setView(projectId, view)
        .then(() => optionsRef.current.refreshProjects())
        .then(() => refresh(projectId, false))
    },
    [refresh]
  )

  const viewLogs = useCallback((projectId: string, runId: number): void => {
    setLogs({ projectId, runId, text: null })
    void window.api.team
      .runLog(projectId, runId)
      .then((text) => setLogs({ projectId, runId, text }))
      .catch((reason) => setLogs({ projectId, runId, text: '', error: teamError(reason, 'Could not read the log.') }))
  }, [])

  const diagnose = useCallback(
    (projectId: string, run: { runId?: number; runUrl?: string; error?: string }): void => {
      setDiagnosis({ projectId, input: { kind: 'pipeline', projectId, ...run } })
    },
    []
  )

  /** Hand a diagnosed failure in the app's code to its Build chat. */
  const fixInChat = useCallback((projectId: string, answer: string): void => {
    optionsRef.current.sendToChat(projectId, 'Fix what broke the pipeline', fixInChatPrompt(answer))
  }, [])

  async function runDiscard(): Promise<void> {
    const projectId = confirmDiscard
    if (!projectId) return
    setDiscarding(true)
    try {
      const result = await window.api.team.discard(projectId)
      if (!result.ok) {
        optionsRef.current.toast.error(result.error ?? 'Could not discard your changes.', { title: 'Discard failed' })
      }
    } finally {
      setDiscarding(false)
      setConfirmDiscard(null)
      await optionsRef.current.refreshProjects()
      await refresh(projectId, true)
    }
  }

  const overlays = (
    <>
      {publishing && (
        <PublishModal
          run={publishing}
          onClose={() => setPublishing(null)}
          onStop={() => void window.api.team.cancel(publishing.projectId)}
          onConfirmDataLoss={() => publish(publishing.projectId, true)}
          onViewLogs={(url) => void window.api.openExternal(url)}
          onCombine={(files) => combineWithCopilot(publishing.projectId, files)}
          onFixInChat={(answer) => {
            setPublishing(null)
            fixInChat(publishing.projectId, answer)
          }}
        />
      )}
      {conflicts && !publishing && (
        <ConfirmModal
          title="Your teammates changed the same files"
          message={
            <>
              <p>
                Your teammates published changes to some of the files you changed. Copilot can
                combine the two versions for you.
              </p>
              <ul className="team-muted">
                {conflicts.files.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
            </>
          }
          confirmLabel="Let Copilot combine them"
          cancelLabel="Not now"
          onConfirm={() => combineWithCopilot(conflicts.projectId, conflicts.files)}
          onCancel={() => setConflicts(null)}
        />
      )}
      {confirmDiscard && (
        <ConfirmModal
          title="Discard your unpublished changes?"
          message={
            <p>
              Your changes since the last publish are thrown away and the app goes back to its
              published version. This can&apos;t be undone.
            </p>
          }
          danger
          busy={discarding}
          confirmLabel="Discard changes"
          onConfirm={() => void runDiscard()}
          onCancel={() => setConfirmDiscard(null)}
        />
      )}
      {logs && (
        <LogModal
          logs={logs}
          onClose={() => setLogs(null)}
          onDiagnose={
            logs.projectId && logs.runId
              ? () => {
                  const { projectId, runId } = logs
                  setLogs(null)
                  if (projectId) diagnose(projectId, { runId })
                }
              : undefined
          }
        />
      )}
      {diagnosis && (
        <TeamDiagnosisModal
          input={diagnosis.input}
          title="Diagnose the failed run"
          onFixInChat={(answer) => fixInChat(diagnosis.projectId, answer)}
          onClose={() => setDiagnosis(null)}
        />
      )}
    </>
  )

  return {
    status: (projectId) => statuses[projectId],
    syncing: (projectId) => syncingIds.includes(projectId),
    afterTurn,
    refresh,
    publish,
    update,
    combineWithCopilot,
    discard: (projectId) => setConfirmDiscard(projectId),
    setView,
    viewLogs,
    diagnose,
    overlays
  }
}

function PublishModal({
  run,
  onClose,
  onStop,
  onConfirmDataLoss,
  onViewLogs,
  onCombine,
  onFixInChat
}: {
  run: PublishRun
  onClose: () => void
  onStop: () => void
  onConfirmDataLoss: () => void
  onViewLogs: (url: string) => void
  onCombine: (files: string[]) => void
  onFixInChat: (answer: string) => void
}): JSX.Element {
  useSuppressPreview()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const result = run.result
  const reviewWaiting = result?.ok && result.project?.team?.publish?.stage === 'review'
  const publish = result?.project?.team?.publish
  const dataLoss = Boolean(publish?.dataLoss) && publish?.stage === 'failed'
  // Conflicts and data-loss refusals have their own actions; anything else can be diagnosed.
  const diagnosable = !run.running && Boolean(result) && !result?.ok && !result?.conflicts?.length && !dataLoss
  return (
    <div className="modal-backdrop">
      <div className="modal team-modal" role="dialog" aria-modal="true" aria-label="Publish" ref={dialogRef}>
        <div className="modal-header">
          <h2>{run.running ? 'Publishing…' : result?.ok && !reviewWaiting ? 'Published' : 'Publish'}</h2>
        </div>
        <div className="modal-body team-form">
          <StepList rows={run.rows} />
          {run.running && (
            <p className="team-muted">
              Your changes are safe on GitHub the whole time. You can keep working once the merge
              step is done.
            </p>
          )}
          {reviewWaiting && (
            <div className="team-notice">
              <span className="team-notice-text">
                Waiting for a teammate to approve your changes. They see your request on Fabricator&apos;s
                Home. Publish again once they&apos;ve approved.
              </span>
            </div>
          )}
          {result && !result.ok && (
            <div className="alert alert--error" role="alert">
              {result.error ?? 'Publishing stopped.'}
            </div>
          )}
          {diagnosable && (
            <TeamDiagnosis
              input={{
                kind: 'pipeline',
                projectId: run.projectId,
                runId: publish?.runId,
                runUrl: publish?.runUrl,
                error: result?.error
              }}
              onFixInChat={onFixInChat}
            />
          )}
        </div>
        <div className="modal-footer">
          {run.running ? (
            <button type="button" className="btn btn--ghost" onClick={onStop}>
              Stop waiting
            </button>
          ) : (
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Close
            </button>
          )}
          {!run.running && publish?.runUrl && !result?.ok && (
            <button type="button" className="btn" onClick={() => onViewLogs(publish.runUrl ?? '')}>
              View logs on GitHub
            </button>
          )}
          {!run.running && result?.conflicts?.length ? (
            <button type="button" className="btn btn--primary" onClick={() => onCombine(result.conflicts ?? [])}>
              Let Copilot combine them
            </button>
          ) : null}
          {!run.running && dataLoss && (
            <button type="button" className="btn btn--danger" onClick={onConfirmDataLoss}>
              Deploy anyway (deletes data)
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function LogModal({
  logs,
  onClose,
  onDiagnose
}: {
  logs: { text: string | null; error?: string }
  onClose: () => void
  /** Diagnose this run with Copilot (replaces the log dialog). */
  onDiagnose?: () => void
}): JSX.Element {
  useSuppressPreview()
  const dialogRef = useModalFocus<HTMLDivElement>()
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal team-modal team-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label="Pipeline log"
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Pipeline log</h2>
        </div>
        <div className="modal-body">
          {logs.error ? (
            <div className="alert alert--error">{logs.error}</div>
          ) : logs.text === null ? (
            <span className="team-muted">
              <span className="ws-spinner" /> Loading the log…
            </span>
          ) : (
            <pre className="team-log">{logs.text || 'The log is empty.'}</pre>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          {onDiagnose && (
            <button type="button" className="btn" onClick={onDiagnose}>
              <span className="codicon codicon-sparkle" aria-hidden="true" /> Diagnose with Copilot
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
