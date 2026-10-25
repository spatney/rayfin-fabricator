import type { TeamRunStatus } from '@shared/ipc'
import { elapsed, friendlyStep, runProgress, useNow, waitingStep } from './runProgress'
import './team.css'

import type { JSX } from 'react'

interface Props {
  run: TeamRunStatus
  /** Open the workspace overview, where every deployment in progress shows. */
  onOpenMap?: () => void
}

/** A slim live progress bar for the pipeline deploying this team app. */
export default function TeamRunStrip({ run, onOpenMap }: Props): JSX.Element {
  const now = useNow(true)
  const progress = runProgress(run.steps)
  const label = run.kind === 'production' ? 'Publishing for everyone' : 'Deploying your preview'
  const step = waitingStep(run, now) ?? (progress.current ? friendlyStep(progress.current.name) : 'Getting ready')
  const position = progress.total > 0 ? ` · step ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : ''
  return (
    <div className={`team-run-strip team-run-strip--${run.kind}`} role="status" aria-live="polite">
      <span className="team-run-strip-orb" aria-hidden="true" />
      <span className="team-run-strip-text">
        <strong>{label}</strong>
        <span className="team-run-strip-step">
          {step}
          {position}
        </span>
      </span>
      <span
        className="team-run-strip-bar"
        role="progressbar"
        aria-label="Pipeline progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress.fraction * 100)}
      >
        <span style={{ width: `${Math.max(4, Math.round(progress.fraction * 100))}%` }} />
      </span>
      <span className="team-run-strip-time">{elapsed(run.startedAt, now)}</span>
      {onOpenMap && (
        <button type="button" className="btn btn--xs btn--ghost" onClick={onOpenMap}>
          Watch
        </button>
      )}
      <button type="button" className="btn btn--xs btn--ghost" onClick={() => void window.api.openExternal(run.url)}>
        Logs
      </button>
    </div>
  )
}
