import type { TeamRunStatus } from '@shared/ipc'
import { elapsed, friendlyStep, runProgress, useNow, waitingForRunner, waitingStep } from './runProgress'
import './team.css'

import type { JSX } from 'react'

/** What a deploy is doing, in words: its title, current step, and how far along it is. */
export function describeRun(
  run: TeamRunStatus,
  now = Date.now()
): { title: string; step: string; position: string; fraction: number } {
  const progress = runProgress(run.steps)
  const step = waitingStep(run, now) ?? (progress.current ? friendlyStep(progress.current.name) : 'Getting ready')
  return {
    title: run.kind === 'production' ? 'Publishing for everyone' : 'Deploying your preview',
    step,
    position: progress.total > 0 ? `step ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : '',
    fraction: progress.fraction
  }
}

interface Props {
  run: TeamRunStatus
  /** No preview of this app has been deployed yet. */
  first?: boolean
  onOpenMap?: () => void
}

/** The preview area while the pipeline deploys an app that has nothing to show yet. */
export default function TeamDeployCard({ run, first, onOpenMap }: Props): JSX.Element {
  const now = useNow(true)
  const { title, step, position, fraction } = describeRun(run, now)
  const percent = Math.max(4, Math.round(fraction * 100))
  return (
    <div className="team-deploy-card" role="status" aria-live="polite">
      <span className="team-deploy-card-spinner" aria-hidden="true" />
      <h3 className="team-deploy-card-title">{first && run.kind === 'preview' ? 'Deploying your first preview' : title}</h3>
      <p className="team-deploy-card-step">
        {step}
        {position && <span className="team-deploy-card-dim"> · {position}</span>}
        <span className="team-deploy-card-dim"> · {elapsed(run.startedAt, now)}</span>
      </p>
      <span
        className="team-deploy-card-bar"
        role="progressbar"
        aria-label="Deploy progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </span>
      <p className="team-deploy-card-note">
        {waitingForRunner(run, now)
          ? 'No runner has picked up the pipeline yet. If your organization turned off GitHub-hosted runners, an owner can choose its runners under Manage → Settings → Where the pipeline runs.'
          : first
            ? 'The team pipeline builds the app and deploys it to Fabric. The first deploy takes a few minutes; later ones are quicker.'
            : 'The team pipeline is deploying your latest change. The preview switches to it when it’s live.'}
      </p>
      <div className="team-deploy-card-actions">
        {onOpenMap && (
          <button type="button" className="btn btn--sm" onClick={onOpenMap}>
            <span className="codicon codicon-type-hierarchy-sub" aria-hidden="true" /> Watch in overview
          </button>
        )}
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => void window.api.openExternal(run.url)}>
          Logs <span className="codicon codicon-link-external" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
