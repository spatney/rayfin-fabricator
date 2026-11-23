import type { TeamRunStatus } from '@shared/ipc'
import { translator, useTranslation } from '../../i18n'
import { elapsed, friendlyStep, runProgress, useNow, waitingForRunner, waitingStep } from './runProgress'
import './team.css'

import type { JSX } from 'react'

/** What a deploy is doing, in words: its title, current step, and how far along it is. */
export function describeRun(
  run: TeamRunStatus,
  now = Date.now()
): { title: string; step: string; position: string; fraction: number } {
  const t = translator('team')
  const progress = runProgress(run.steps)
  const step = waitingStep(run, now) ?? (progress.current ? friendlyStep(progress.current.name) : t('run.gettingReady'))
  return {
    title: run.kind === 'production' ? t('run.publishing') : t('run.deploying'),
    step,
    position:
      progress.total > 0
        ? t('run.position', { step: Math.min(progress.done + 1, progress.total), total: progress.total })
        : '',
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
  const { t } = useTranslation('team')
  const now = useNow(true)
  const { title, step, position, fraction } = describeRun(run, now)
  const percent = Math.max(4, Math.round(fraction * 100))
  return (
    <div className="team-deploy-card" role="status" aria-live="polite">
      <span className="team-deploy-card-spinner" aria-hidden="true" />
      <h3 className="team-deploy-card-title">{first && run.kind === 'preview' ? t('deployCard.first') : title}</h3>
      <p className="team-deploy-card-step">
        {step}
        {position && <span className="team-deploy-card-dim"> · {position}</span>}
        <span className="team-deploy-card-dim"> · {elapsed(run.startedAt, now)}</span>
      </p>
      <span
        className="team-deploy-card-bar"
        role="progressbar"
        aria-label={t('deployCard.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </span>
      <p className="team-deploy-card-note">
        {waitingForRunner(run, now)
          ? t('deployCard.noRunner')
          : first
            ? t('deployCard.firstNote')
            : t('deployCard.note')}
      </p>
      <div className="team-deploy-card-actions">
        {onOpenMap && (
          <button type="button" className="btn btn--sm" onClick={onOpenMap}>
            <span className="codicon codicon-type-hierarchy-sub" aria-hidden="true" /> {t('deployCard.watch')}
          </button>
        )}
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => void window.api.openExternal(run.url)}>
          {t('run.logs')} <span className="codicon codicon-link-external" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
