import { useState, type CSSProperties, type JSX } from 'react'
import type { TeamRunStep } from '@shared/ipc'
import { elapsed, friendlyStep, runProgress } from '../runProgress'
import type { Deploying, Health } from './model'

export const HEALTH_LABEL: Record<Health, string> = {
  live: 'Live',
  deploying: 'Deploying',
  failed: 'Failed',
  idle: 'Not deployed'
}

/** A stable hue per name, for marks and initials. */
export function hueOf(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

/** A GitHub avatar URL at a given size (2× for sharp edges). */
export function avatarSrc(url: string | undefined, size: number): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    u.searchParams.set('s', String(size * 2))
    return u.toString()
  } catch {
    return url
  }
}

/** The part of a pull request title after the app's name. */
export function changeTitle(title: string | undefined, appName: string): string | undefined {
  if (!title) return undefined
  const prefix = `${appName}: `
  return title.startsWith(prefix) ? title.slice(prefix.length) : title
}

export function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The Fabric portal page of a workspace. */
export function fabricWorkspaceUrl(id: string): string {
  return `https://app.fabric.microsoft.com/groups/${encodeURIComponent(id)}`
}

export function Avatar({ login, url, size = 26 }: { login: string; url?: string; size?: number }): JSX.Element {
  const [broken, setBroken] = useState(false)
  const src = broken ? undefined : avatarSrc(url, size)
  return src ? (
    <img
      className="tmap-avatar"
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      onError={() => setBroken(true)}
    />
  ) : (
    <span
      className="tmap-avatar tmap-avatar--initial"
      style={{ width: size, height: size, '--hue': hueOf(login) } as CSSProperties}
    >
      {(login.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

export function HealthPill({ health, label }: { health: Health; label?: string }): JSX.Element {
  return (
    <span className={`tmap-health tmap-health--${health}`}>
      <span className="tmap-health-dot" aria-hidden="true" />
      {label ?? HEALTH_LABEL[health]}
    </span>
  )
}

/** GitHub-style five-block bar of added vs removed lines. */
export function DiffBar({ additions, deletions }: { additions: number; deletions: number }): JSX.Element {
  const total = additions + deletions
  const adds = total === 0 ? 0 : Math.round((additions / total) * 5)
  const blocks = Array.from({ length: 5 }, (_, i) => (total === 0 ? 'none' : i < adds ? 'add' : 'del'))
  return (
    <span className="tmap-diffbar" title={`${additions} lines added, ${deletions} removed`}>
      <span className="tmap-diff-add">+{additions.toLocaleString()}</span>
      <span className="tmap-diff-del">−{deletions.toLocaleString()}</span>
      <span className="tmap-diff-blocks" aria-hidden="true">
        {blocks.map((b, i) => (
          <span key={i} className={`tmap-diff-block tmap-diff-block--${b}`} />
        ))}
      </span>
    </span>
  )
}

/** What a deployment in progress is doing: its current step and a progress bar. */
export function RunLine({ deploying, now }: { deploying: Deploying; now: number }): JSX.Element {
  const steps = deploying.job?.steps ?? []
  const progress = runProgress(steps)
  const step =
    deploying.run.status === 'queued' || deploying.run.status === 'waiting'
      ? 'Waiting to start'
      : !deploying.job
        ? 'Planning'
        : progress.current
          ? friendlyStep(progress.current.name)
          : 'Finishing'
  return (
    <div className="tmap-runline" role="status">
      <div className="tmap-runline-text">
        <span className="tmap-runline-step">{step}</span>
        <span className="tmap-runline-time">{elapsed(deploying.job?.startedAt ?? deploying.run.startedAt, now)}</span>
      </div>
      <span className="tmap-runline-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(6, Math.round(progress.fraction * 100))}%` }} />
      </span>
    </div>
  )
}

/** Every step of a pipeline job, with how long each took. */
export function StepTimeline({ steps, now }: { steps: TeamRunStep[]; now: number }): JSX.Element {
  return (
    <ol className="tmap-steps">
      {steps.map((step) => {
        const state =
          step.conclusion === 'failure'
            ? 'failed'
            : step.conclusion === 'skipped'
              ? 'skipped'
              : step.status === 'completed'
                ? 'done'
                : step.status === 'in_progress'
                  ? 'running'
                  : 'pending'
        const took =
          step.startedAt && step.completedAt
            ? `${Math.max(0, Math.round((Date.parse(step.completedAt) - Date.parse(step.startedAt)) / 1000))}s`
            : state === 'running'
              ? elapsed(step.startedAt, now)
              : ''
        return (
          <li key={step.name} className={`tmap-step tmap-step--${state}`}>
            <span className="tmap-step-icon" aria-hidden="true">
              {state === 'done' ? '✓' : state === 'failed' ? '✕' : state === 'running' ? '' : '·'}
            </span>
            <span className="tmap-step-name">{friendlyStep(step.name)}</span>
            <span className="tmap-step-time">{took}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function FabricGlyph(): JSX.Element {
  return (
    <svg className="tmap-fabric-glyph" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M6 9.5 16 4l10 5.5-10 5.5Z" fill="#3fcfaf" />
      <path d="M6 15.5 16 21l10-5.5" fill="none" stroke="#1f9d8b" strokeWidth="3" strokeLinejoin="round" />
      <path d="M6 21.5 16 27l10-5.5" fill="none" stroke="#167a70" strokeWidth="3" strokeLinejoin="round" opacity="0.75" />
    </svg>
  )
}
