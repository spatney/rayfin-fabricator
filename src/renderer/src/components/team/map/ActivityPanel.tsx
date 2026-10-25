import { useState, type JSX } from 'react'
import type { TeamManifest, TeamMap, TeamMapRun } from '@shared/ipc'
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
  const parts = [`${counts.live} live`]
  if (counts.deploying) parts.push(`${counts.deploying} deploying`)
  if (counts.failed) parts.push(`${counts.failed} failed`)
  return parts.join(' · ')
}

/** The sidebar while nothing is selected: what the pipeline is doing, and where it deploys. */
export default function ActivityPanel({ map, runs, now, fabric, notice, targetOf, onReveal, onSelect }: Props): JSX.Element {
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
    <aside className="tmap-side" aria-label="Pipeline activity">
      <header className="tmap-side-head">
        <h3>Deployments</h3>
        <span className={`tmap-health tmap-health--${running ? 'deploying' : 'idle'}`}>
          <span className="tmap-health-dot" aria-hidden="true" />
          {running ? `${running} running` : 'All quiet'}
        </span>
      </header>

      {notice && <p className="tmap-insp-warn">{notice}</p>}

      {shown.length === 0 ? (
        <p className="tmap-side-empty">
          Nothing has deployed in the last hour. Saving a change deploys its author&apos;s preview; publishing deploys
          the app for everyone.
        </p>
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
                    ? 'Waiting to start'
                    : !job
                      ? 'Planning'
                      : progress.current
                        ? friendlyStep(progress.current.name)
                        : 'Finishing'
                } · ${elapsed(run.startedAt, now)}`
              : `${state === 'done' ? 'Deployed' : state === 'replaced' ? 'Replaced by a newer save' : 'Failed'} · ${timeAgo(
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
                  title={target ? 'Show it in the overview' : undefined}
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
                    title="Diagnose with Copilot"
                    aria-label="Diagnose with Copilot"
                  >
                    <Codicon name="sparkle" />
                  </button>
                )}
                <button
                  type="button"
                  className="tmap-icon-btn"
                  onClick={() => void window.api.openExternal(run.url)}
                  title="Open the run on GitHub"
                  aria-label="Open the run on GitHub"
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
          <h4>Deploys to</h4>
          <ul className="tmap-insp-list">
            {[
              { id: nodeIds.fabricProd, label: 'Published apps', name: fabric.production.name, production: true },
              { id: nodeIds.fabricPreview, label: 'Previews', name: fabric.previews.name, production: false }
            ].map((target) => (
              <li key={target.id}>
                <button
                  type="button"
                  className="tmap-insp-row tmap-insp-row--button"
                  onClick={() => onSelect(target.id)}
                  title="Show what's deployed there"
                >
                  <FabricGlyph />
                  <span className="tmap-insp-grow">
                    {target.label}
                    <span className="tmap-dim tmap-block tmap-ellipsis">{target.name}</span>
                  </span>
                  <span className="tmap-dim">{deployed(fabricHealth(map, runs, target.production))}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tmap-side-section">
        <h4>How it works</h4>
        <ol className="tmap-how">
          <li>Everyone changes an app in their own working copy.</li>
          <li>
            Each saved change deploys that person&apos;s preview. Previews have their own data, so trying a change never
            touches the published app&apos;s data.
          </li>
          <li>Publishing merges it, and the published app is deployed for everyone.</li>
        </ol>
      </section>

      {repo && (
        <button
          type="button"
          className="tmap-link tmap-side-foot"
          onClick={() => void window.api.openExternal(`https://github.com/${repo}/actions`)}
        >
          All pipeline runs on GitHub <Codicon name="link-external" />
        </button>
      )}
      {diagnose && <TeamDiagnosisModal input={diagnose} title="Diagnose the failed run" onClose={() => setDiagnose(null)} />}
    </aside>
  )
}
