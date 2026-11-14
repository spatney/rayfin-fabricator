import { useEffect, useState } from 'react'
import type { TeamRunStatus, TeamRunStep } from '@shared/ipc'
import { translator } from '../../i18n'

export interface RunProgress {
  done: number
  total: number
  /** The step running now (or the next one to run). */
  current?: TeamRunStep
  failed?: TeamRunStep
  /** 0…1; a running step counts as half done so the bar moves while it works. */
  fraction: number
}

export function runProgress(steps: TeamRunStep[]): RunProgress {
  const total = steps.length
  const done = steps.filter((s) => s.status === 'completed').length
  const current = steps.find((s) => s.status === 'in_progress') ?? steps.find((s) => s.status !== 'completed')
  const failed = steps.find((s) => s.conclusion === 'failure')
  const fraction = total === 0 ? 0 : Math.min(1, (done + (current?.status === 'in_progress' ? 0.5 : 0)) / total)
  return { done, total, current, failed, fraction }
}

/** The pipeline's step names, in plain words. */
export function friendlyStep(name: string): string {
  const t = translator('team')
  if (/^Run actions\/checkout@/i.test(name)) return t('progress.step.checkout')
  if (/^Run actions\/setup-node@/i.test(name)) return t('progress.step.setupNode')
  if (/^Run azure\/login@/i.test(name)) return t('progress.step.signIn')
  if (/^Run actions\/github-script@/i.test(name)) return t('progress.step.record')
  return name.replace(/^Run /, '')
}

/** GitHub-hosted runners start within a minute or two; longer suggests none will. */
const RUNNER_HINT_MS = 3 * 60_000

/** Whether a run has waited unusually long for a runner to pick it up. */
export function waitingForRunner(run: TeamRunStatus, now: number): boolean {
  const since = run.startedAt ? Date.parse(run.startedAt) : NaN
  return run.status === 'queued' && Number.isFinite(since) && now - since > RUNNER_HINT_MS
}

/** What a run that hasn't started is waiting for; `undefined` once it runs. */
export function waitingStep(run: TeamRunStatus, now: number): string | undefined {
  if (run.status !== 'queued' && run.status !== 'waiting') return undefined
  const t = translator('team')
  return waitingForRunner(run, now) ? t('progress.stillWaitingForRunner') : t('progress.waitingToStart')
}

/** "42s", "3:07" — time since an ISO timestamp. */
export function elapsed(since: string | undefined, now: number): string {
  if (!since) return ''
  const ms = now - Date.parse(since)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  return s < 60
    ? translator('team')('progress.seconds', { seconds: s })
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function timeAgo(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const t = translator('team')
  const min = Math.floor(ms / 60_000)
  if (min < 1) return t('progress.justNow')
  if (min < 60) return t('progress.minutesAgo', { count: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('progress.hoursAgo', { count: h })
  return t('progress.daysAgo', { count: Math.floor(h / 24) })
}

/** The current time, updated every `intervalMs` while `active`. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [active, intervalMs])
  return now
}
