import { useState, type JSX } from 'react'
import type { TeamManifest, TeamMap, TeamMapRun } from '@shared/ipc'
import { translator, useTranslation } from '../../../i18n'
import { Codicon } from '../../icons'
import TeamDiagnosisModal from '../diagnosis/TeamDiagnosisModal'
import type { DiagnosisInput } from '../diagnosis/useTeamDiagnosis'
import { elapsed, friendlyStep, runProgress, timeAgo } from '../runProgress'
import { fabricHealth, isActive, nodeIds, runLabel, type Health } from './model'
import { Avatar, FabricGlyph } from './parts'

interface Props {
  map: TeamMap
  runs: TeamMapRun[]
  now: number
  /** The Fabric workspaces the apps deploy to. */
  fabric?: TeamManifest['fabric']
  /** Something couldn't be read, e.g. the apps' data. */
  notice?: string | null
  /** The row or card a run belongs to, to reveal it in the overview. */
  targetOf: (run: TeamMapRun) => string | undefined
  onReveal: (id: string) => void
  /** Select one of the Fabric workspaces. */
  onSelect: (id: string) => void
}

function deployed(counts: Record<Health, number>): string {
  const t = translator('teamMap')
  const parts = [t('activity.live', { count: counts.live })]
  if (counts.deploying) parts.push(t('shared.deploying', { count: counts.deploying }))
  if (counts.failed) parts.push(t('activity.failed', { count: counts.failed }))
  return parts.join(' · ')
}

/** The sidebar while nothing is selected: what the pipeline is doing, and where it deploys. */
export default function ActivityPanel({ map, runs, now, fabric, notice, targetOf, onReveal, onSelect }: Props): JSX.Element {
  const { t } = useTranslation('teamMap')
  const [diagnose, setDiagnose] = useState<DiagnosisInput | null>(null)
  const shown = runs
    .filter(
      (r) =>
        r.kind !== 'verify' &&
        (isActive(r) || now - Date.parse(r.updatedAt ?? r.startedAt ?? '') < 60 * 60_000)
    )
    .slice(0, 8)
  const running = runs.filter((r) => isActive(r) && r.kind !== 'verify').length
  const repo = map.workspace?.repo

  return (
    <aside className="tmap-side" aria-label={t('activity.label')}>
      <header className="tmap-side-head">
        <h3>{t('activity.title')}</h3>
        <span className={`tmap-health tmap-health--${running ? 'deploying' : 'idle'}`}>
          <span className="tmap-health-dot" aria-hidden="true" />
          {running ? t('activity.running', { count: running }) : t('activity.quiet')}
        </span>
      </header>

      {notice && <p className="tmap-insp-warn">{notice}</p>}

      {shown.length === 0 ? (
        <p className="tmap-side-empty">{t('activity.empty')}</p>
      ) : (
        <ul className="tmap-runs">
          {shown.map((run) => {
            const active = isActive(run)
            const job = run.jobs.find((j) => j.folder && j.status !== 'completed') ?? run.jobs.find((j) => j.folder)
            const progress = runProgress(job?.steps ?? [])
            const target = targetOf(run)
            const state = active ? 'running' : run.conclusion === 'success' ? 'done' : run.conclusion === 'cancelled' ? 'replaced' : 'failed'
            const detail = active
              ? `${
                  run.status === 'queued' || run.status === 'waiting'
                    ? t('run.waiting')
                    : !job
                      ? t('run.planning')
                      : progress.current
                        ? friendlyStep(progress.current.name)
                        : t('run.finishing')
                } · ${elapsed(run.startedAt, now)}`
              : `${state === 'done' ? t('run.deployed') : state === 'replaced' ? t('run.replaced') : t('health.failed')} · ${timeAgo(
                  run.updatedAt ?? run.startedAt,
                  now
                )}`
            return (
              <li key={run.id} className={`tmap-run tmap-run--${state}`}>
                <button
                  type="button"
                  className="tmap-run-main"
                  onClick={() => target && onReveal(target)}
                  disabled={!target}
                  title={target ? t('activity.reveal') : undefined}
                >
                  <span className="tmap-run-icon" aria-hidden="true">
                    {state === 'running' ? <span className="tmap-spinner" /> : state === 'done' ? '✓' : state === 'failed' ? '✕' : '–'}
                  </span>
                  <span className="tmap-run-text">
                    <span className="tmap-run-label">{runLabel(run, map.apps)}</span>
                    <span className="tmap-run-meta">
                      {run.actor && <Avatar login={run.actor} url={run.actorAvatar} size={14} />}
                      <span className="tmap-ellipsis">
                        {run.actor ? `${run.actor} · ` : ''}
                        {detail}
                      </span>
                    </span>
                    {active && (
                      <span className="tmap-runline-bar" aria-hidden="true">
                        <span style={{ width: `${Math.max(6, Math.round(progress.fraction * 100))}%` }} />
                      </span>
                    )}
                  </span>
                </button>
                {state === 'failed' && map.workspace && (
                  <button
                    type="button"
                    className="tmap-icon-btn"
                    onClick={() => setDiagnose({ kind: 'pipeline', workspaceId: map.workspace?.id, runId: run.id })}
                    title={t('shared.diagnose')}
                    aria-label={t('shared.diagnose')}
                  >
                    <Codicon name="sparkle" />
                  </button>
                )}
                <button
                  type="button"
                  className="tmap-icon-btn"
                  onClick={() => void window.api.openExternal(run.url)}
                  title={t('activity.openRun')}
                  aria-label={t('activity.openRun')}
                >
                  <Codicon name="link-external" />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {fabric && (
        <section className="tmap-side-section">
          <h4>{t('activity.deploysTo')}</h4>
          <ul className="tmap-insp-list">
            {[
              { id: nodeIds.fabricProd, label: t('shared.publishedApps'), name: fabric.production.name, production: true },
              { id: nodeIds.fabricPreview, label: t('shared.previews'), name: fabric.previews.name, production: false }
            ].map((target) => (
              <li key={target.id}>
                <button
                  type="button"
                  className="tmap-insp-row tmap-insp-row--button"
                  onClick={() => onSelect(target.id)}
                  title={t('activity.showDeployed')}
                >
                  <FabricGlyph />
                  <span className="tmap-insp-grow">
                    {target.label}
                    <span className="tmap-dim tmap-block tmap-ellipsis">{target.name}</span>
                  </span>
                  <span className="tmap-dim tmap-insp-meta">
                    {deployed(fabricHealth(map, runs, target.production))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tmap-side-section">
        <h4>{t('activity.howItWorks')}</h4>
        <ol className="tmap-how">
          <li>{t('activity.how1')}</li>
          <li>{t('activity.how2')}</li>
          <li>{t('activity.how3')}</li>
        </ol>
      </section>

      {repo && (
        <button
          type="button"
          className="tmap-link tmap-side-foot"
          onClick={() => void window.api.openExternal(`https://github.com/${repo}/actions`)}
        >
          {t('activity.allRuns')} <Codicon name="link-external" />
        </button>
      )}
      {diagnose && <TeamDiagnosisModal input={diagnose} title={t('activity.diagnoseRun')} onClose={() => setDiagnose(null)} />}
    </aside>
  )
}
