import { useEffect, useRef, useState, type JSX } from 'react'
import type { StudioProject, TeamMapRun, TeamSessionStatus } from '@shared/ipc'
import { translator, useTranslation } from '../../i18n'
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
  onViewLogs: (runId: number) => void
  /** Diagnose a failed run or publish with Copilot. */
  onDiagnose?: (run: { runId?: number; runUrl?: string; error?: string }) => void
  onRefresh: () => void
  /** Open the workspace overview (every app, copy and deployment). */
  onOpenMap?: () => void
}

/** One-line state of a team app for the chip. */
export function teamChipLabel(status: TeamSessionStatus | undefined, syncing: boolean): string {
  const t = translator('team')
  if (syncing) return t('status.saving')
  if (!status) return t('control.teamApp')
  if (status.conflicted) return t('control.chip.combining')
  if (status.run && status.run.status !== 'completed') {
    return status.run.kind === 'production'
      ? t('shared.publishing')
      : t('control.chip.deployingPreview')
  }
  if (status.publish?.stage === 'review') return t('control.chip.review')
  if (status.publish?.stage === 'deploying') return t('shared.publishing')
  if (status.unpublished > 0) return t('control.chip.unpublished', { count: status.unpublished })
  if (status.dirty) return t('control.chip.unsaved')
  return t('control.chip.upToDate')
}

/**
 * Your preview, deployed for your open pull request once it's ready for review
 * (Publish marks it ready), for you and your reviewers to open. A draft's
 * deploys nothing, and one left from an earlier pull request isn't yours now.
 */
export function livePreviewUrl(status: TeamSessionStatus | undefined): string | undefined {
  const pr = status?.pr
  const preview = status?.preview
  if (!pr || pr.state !== 'open' || pr.draft || preview?.state !== 'success') return undefined
  if (preview.sha && pr.headSha && preview.sha !== pr.headSha) return undefined
  return preview.url
}

/** The app bar control for team apps: state, Publish, and the workspace overview. */
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
  onViewLogs,
  onDiagnose,
  onRefresh,
  onOpenMap
}: Props): JSX.Element {
  const { t } = useTranslation('team')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // The native preview paints above all HTML; step it aside while the menu is open.
  useSuppressPreview(open)
  const unpublished = status?.unpublished ?? 0
  const previewUrl = livePreviewUrl(status)
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
    unpublished > 0 ? t('control.notPublished', { count: unpublished }) : null,
    status?.branch ? t('control.branch', { branch: status.branch }) : null
  ]
    .filter(Boolean)
    .join(' · ')
  const runCancelled = status?.run?.conclusion === 'cancelled'
  const runTitle =
    status?.run?.kind === 'production'
      ? !runFailed
        ? t('control.run.production')
        : runCancelled
          ? t('control.run.productionCancelled')
          : t('control.run.productionFailed')
      : !runFailed
        ? t('control.run.preview')
        : runCancelled
          ? t('control.run.previewCancelled')
          : t('control.run.previewFailed')
  const changesText =
    unpublished > 0
      ? t('control.notPublishedYet', { count: unpublished })
      : t('control.nothingWaiting')

  return (
    <div className="team-control" ref={rootRef}>
      <div className="seg seg--toolbar team-split">
        <button
          type="button"
          className="seg-btn team-split-status"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={chipTitle || t('control.teamApp')}
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
          title={canPublish ? t('control.publishTitle') : t('control.nothingNew')}
          onClick={() => {
            setOpen(false)
            onPublish()
          }}
        >
          {t('shared.publish')}
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
        <div className="team-menu" role="dialog" aria-label={t('control.teamApp')}>
          <div className="team-menu-section">
            <span className="team-menu-name">{workspaceName ?? t('control.teamWorkspace')}</span>
            {status?.branch && (
              <span className="team-menu-branch" title={t('control.yourBranch')}>
                <span className="codicon codicon-git-branch" aria-hidden="true" />
                <span className="team-menu-branch-name">{status.branch}</span>
              </span>
            )}
            <span className="team-muted">{t('control.intro')}</span>
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
                  <span className="codicon codicon-type-hierarchy-sub" aria-hidden="true" />{' '}
                  {t('shared.workspaceOverview')}
                </button>
              </div>
            )}
          </div>

          {status?.run && (runActive || runFailed) && (
            <div className="team-menu-section">
              <span className="team-menu-title">{runTitle}</span>
              <StepTimeline steps={status.run.steps} now={now} />
              {runFailed && (
                <div className="team-menu-actions">
                  <button type="button" className="btn btn--sm" onClick={() => onViewLogs(status.run?.id ?? 0)}>
                    {t('control.viewLogs')}
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
                      <span className="codicon codicon-sparkle" aria-hidden="true" />{' '}
                      {t('shared.diagnoseWithCopilot')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {status?.conflicted ? (
            <div className="team-menu-section">
              <span className="team-menu-title">{t('control.teammates')}</span>
              <span className="team-muted">{t('control.combiningText')}</span>
              <div className="team-menu-actions">
                <button type="button" className="btn btn--sm btn--primary" onClick={onCombine}>
                  {t('control.askCopilot')}
                </button>
              </div>
            </div>
          ) : status && status.behind > 0 ? (
            <div className="team-menu-section">
              <span className="team-menu-title">{t('control.teammates')}</span>
              <span className="team-muted">{t('control.behind', { count: status.behind })}</span>
              <div className="team-menu-actions">
                <button type="button" className="btn btn--sm" onClick={onUpdate}>
                  {t('control.bringIn')}
                </button>
              </div>
            </div>
          ) : null}

          {failedPublish && (
            <div className="team-menu-section">
              <span className="team-menu-title">{t('control.lastPublish')}</span>
              <span className="team-muted">
                {failedPublish.error ?? t('control.lastPublishFailed')}
              </span>
              {(failedPublish.runUrl || onDiagnose) && (
                <div className="team-menu-actions">
                  {failedPublish.runUrl && (
                    <button type="button" className="btn btn--sm" onClick={() => void window.api.openExternal(failedPublish.runUrl ?? '')}>
                      {t('shared.viewOnGithub')}
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
                      <span className="codicon codicon-sparkle" aria-hidden="true" />{' '}
                      {t('shared.diagnoseWithCopilot')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="team-menu-section">
            <span className="team-menu-title">{t('control.yourChanges')}</span>
            <span className="team-muted">
              {status?.requireReview
                ? t('control.withApproval', {
                    changes: changesText,
                    approval: t('control.needsApproval')
                  })
                : changesText}
            </span>
            <div className="team-menu-actions">
              {status?.pr && (
                <button type="button" className="btn btn--sm" onClick={() => void window.api.openExternal(status.pr?.url ?? '')}>
                  {t('shared.viewOnGithub')}
                </button>
              )}
              {previewUrl && (
                <button
                  type="button"
                  className="btn btn--sm"
                  title={t('control.previewTitle')}
                  onClick={() => void window.api.openExternal(previewUrl)}
                >
                  {t('control.openPreview')}
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
                {t('shared.discardChanges')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
