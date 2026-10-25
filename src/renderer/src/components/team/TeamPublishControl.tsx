import { useEffect, useRef, useState, type JSX } from 'react'
import type { StudioProject, TeamMapRun, TeamSessionStatus } from '@shared/ipc'
import { useSuppressPreview } from '../../overlay'
import { appRunsKey } from './appRun'
import { StepTimeline } from './map/parts'
import { runProgress, useNow } from './runProgress'
import TeamMapButton from './TeamMapButton'
import './map/teamMap.css'
import './team.css'

interface Props {
  project: StudioProject
  workspaceName?: string
  status?: TeamSessionStatus
  /** The workspace's pipeline runs, polled every few seconds. */
  runs?: TeamMapRun[]
  syncing: boolean
  onPublish: () => void
  onUpdate: () => void
  onCombine: () => void
  onDiscard: () => void
  onSetView: (view: 'preview' | 'production') => void
  onViewLogs: (runId: number) => void
  /** Diagnose a failed run or publish with Copilot. */
  onDiagnose?: (run: { runId?: number; runUrl?: string; error?: string }) => void
  onRefresh: () => void
  /** Open the workspace overview (every app, copy and deployment). */
  onOpenMap?: () => void
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** One-line state of a team app for the chip. */
export function teamChipLabel(status: TeamSessionStatus | undefined, syncing: boolean): string {
  if (syncing) return 'Saving…'
  if (!status) return 'Team app'
  if (status.conflicted) return 'Combining changes…'
  if (status.run && status.run.status !== 'completed') {
    return status.run.kind === 'production' ? 'Publishing…' : 'Deploying preview…'
  }
  if (status.publish?.stage === 'review') return 'Waiting for review'
  if (status.publish?.stage === 'deploying') return 'Publishing…'
  if (status.unpublished > 0) return `${status.unpublished} unpublished`
  if (status.dirty) return 'Unsaved edits'
  return 'Up to date'
}

function deployLabel(state?: string): string {
  switch (state) {
    case 'success':
      return 'Live'
    case 'failure':
    case 'error':
      return 'Failed'
    case 'in_progress':
    case 'queued':
    case 'pending':
      return 'Deploying…'
    default:
      return 'Not deployed yet'
  }
}

/** The app bar control for team apps: state, Publish, the preview choice and the workspace overview. */
export default function TeamPublishControl({
  project,
  workspaceName,
  status,
  runs,
  syncing,
  onPublish,
  onUpdate,
  onCombine,
  onDiscard,
  onSetView,
  onViewLogs,
  onDiagnose,
  onRefresh,
  onOpenMap
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // The native preview paints above all HTML; step it aside while the menu is open.
  useSuppressPreview(open)
  const view = status?.view ?? project.team?.view ?? 'preview'
  const unpublished = status?.unpublished ?? 0
  const publishing =
    status?.publish?.stage === 'deploying' ||
    (status?.run?.kind === 'production' && status.run.status !== 'completed')
  const canPublish = (unpublished > 0 || Boolean(status?.dirty)) && !syncing && !status?.conflicted
  const failedPublish = status?.publish?.stage === 'failed' ? status.publish : undefined
  const runFailed = status?.run?.status === 'completed' && status.run.conclusion !== 'success'
  const runActive = Boolean(status?.run && status.run.status !== 'completed')
  const now = useNow(open && runActive)
  const progress = runActive && status?.run ? Math.max(4, Math.round(runProgress(status.run.steps).fraction * 100)) : 0

  // The workspace's runs see this app's deploy start and finish before its own
  // status does (that's read right after a save, often before GitHub starts the
  // run): read the status again whenever they change.
  const runsKey = appRunsKey(runs ?? [], project.team?.folder, status?.branch)
  useEffect(() => {
    if (runsKey) onRefresh()
  }, [runsKey])

  useEffect(() => {
    if (!open) return
    onRefresh()
    const onDoc = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const busy = syncing || Boolean(status?.run && status.run.status !== 'completed') || publishing
  const chipTitle = [
    unpublished > 0 ? `${plural(unpublished, 'change')} not published yet` : null,
    status?.branch ? `Working branch: ${status.branch}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="team-control" ref={rootRef}>
      <div className="seg seg--toolbar team-split">
        <button
          type="button"
          className="seg-btn team-split-status"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={chipTitle || 'Team app'}
          onClick={() => setOpen((o) => !o)}
        >
          {busy ? (
            <span className="ws-spinner" aria-hidden="true" />
          ) : (
            <span className="codicon codicon-git-branch" aria-hidden="true" />
          )}
          <span className="team-branch-chip-label">{teamChipLabel(status, syncing)}</span>
          <span className="codicon codicon-chevron-down team-split-caret" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`seg-btn team-split-publish${canPublish && !publishing ? ' seg-btn--primary' : ''}`}
          disabled={!canPublish || publishing}
          title={canPublish ? 'Publish your changes for everyone' : 'Nothing new to publish'}
          onClick={() => {
            setOpen(false)
            onPublish()
          }}
        >
          Publish
        </button>
        {onOpenMap && (
          <TeamMapButton
            runs={runs ?? []}
            onClick={() => {
              setOpen(false)
              onOpenMap()
            }}
          />
        )}
        {runActive && (
          <span className="team-split-progress" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </span>
        )}
      </div>

      {open && (
        <div className="team-menu" role="dialog" aria-label="Team app">
          <div className="team-menu-section">
            <span className="team-menu-name">{workspaceName ?? 'Team workspace'}</span>
            {status?.branch && (
              <span className="team-menu-branch" title="Your working branch">
                <span className="codicon codicon-git-branch" aria-hidden="true" />
                <span className="team-menu-branch-name">{status.branch}</span>
              </span>
            )}
            <span className="team-muted">
              Your edits are saved to your own working copy on GitHub after each change. Publish
              makes them live for everyone.
            </span>
            {onOpenMap && (
              <div className="team-menu-actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    setOpen(false)
                    onOpenMap()
                  }}
                >
                  <span className="codicon codicon-type-hierarchy-sub" aria-hidden="true" /> Workspace overview
                </button>
              </div>
            )}
          </div>

          <div className="team-menu-section">
            <span className="team-menu-title">Preview shows</span>
            <div className="seg team-view" role="radiogroup" aria-label="Preview shows">
              <button
                type="button"
                role="radio"
                aria-checked={view === 'preview'}
                className={`seg-btn${view === 'preview' ? ' seg-btn--active' : ''}`}
                onClick={() => onSetView('preview')}
              >
                <span className="team-view-label">My preview</span>
                <span className="team-view-state">{deployLabel(status?.preview?.state)}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={view === 'production'}
                className={`seg-btn${view === 'production' ? ' seg-btn--active' : ''}`}
                onClick={() => onSetView('production')}
              >
                <span className="team-view-label">Published</span>
                <span className="team-view-state">{deployLabel(status?.production?.state)}</span>
              </button>
            </div>
          </div>

          {status?.run && (runActive || runFailed) && (
            <div className="team-menu-section">
              <span className="team-menu-title">
                {status.run.kind === 'production' ? 'Publishing' : 'Deploying your preview'}
                {runFailed && (status.run.conclusion === 'cancelled' ? ' · cancelled' : ' · failed')}
              </span>
              <StepTimeline steps={status.run.steps} now={now} />
              {runFailed && (
                <div className="team-menu-actions">
                  <button type="button" className="btn btn--sm" onClick={() => onViewLogs(status.run?.id ?? 0)}>
                    View logs
                  </button>
                  {onDiagnose && status.run.conclusion !== 'cancelled' && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        setOpen(false)
                        onDiagnose({ runId: status.run?.id })
                      }}
                    >
                      <span className="codicon codicon-sparkle" aria-hidden="true" /> Diagnose with Copilot
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {status?.conflicted ? (
            <div className="team-menu-section">
              <span className="team-menu-title">Teammates&apos; changes</span>
              <span className="team-muted">
                You&apos;re combining your changes with your teammates&apos;. Ask Copilot to finish, then
                they&apos;re saved automatically.
              </span>
              <div className="team-menu-actions">
                <button type="button" className="btn btn--sm btn--primary" onClick={onCombine}>
                  Ask Copilot to finish
                </button>
              </div>
            </div>
          ) : status && status.behind > 0 ? (
            <div className="team-menu-section">
              <span className="team-menu-title">Teammates&apos; changes</span>
              <span className="team-muted">
                Your teammates published {plural(status.behind, 'change')} to this app since you
                started.
              </span>
              <div className="team-menu-actions">
                <button type="button" className="btn btn--sm" onClick={onUpdate}>
                  Bring in their changes
                </button>
              </div>
            </div>
          ) : null}

          {failedPublish && (
            <div className="team-menu-section">
              <span className="team-menu-title">Last publish</span>
              <span className="team-muted">{failedPublish.error ?? 'The last publish didn’t finish.'}</span>
              {(failedPublish.runUrl || onDiagnose) && (
                <div className="team-menu-actions">
                  {failedPublish.runUrl && (
                    <button type="button" className="btn btn--sm" onClick={() => void window.api.openExternal(failedPublish.runUrl ?? '')}>
                      View on GitHub
                    </button>
                  )}
                  {onDiagnose && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        setOpen(false)
                        onDiagnose({ runId: failedPublish.runId, runUrl: failedPublish.runUrl, error: failedPublish.error })
                      }}
                    >
                      <span className="codicon codicon-sparkle" aria-hidden="true" /> Diagnose with Copilot
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="team-menu-section">
            <span className="team-menu-title">Your changes</span>
            <span className="team-muted">
              {unpublished > 0
                ? `${plural(unpublished, 'change')} not published yet.`
                : 'Nothing waiting to be published.'}
              {status?.requireReview && ' Publishing needs a teammate’s approval.'}
            </span>
            <div className="team-menu-actions">
              {status?.pr && (
                <button type="button" className="btn btn--sm" onClick={() => void window.api.openExternal(status.pr?.url ?? '')}>
                  View on GitHub
                </button>
              )}
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={unpublished === 0 && !status?.dirty}
                onClick={() => {
                  setOpen(false)
                  onDiscard()
                }}
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
