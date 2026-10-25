import { useNow } from './components/team/runProgress'
import { deployRuns, readDeployProgress, type DeployProgress } from './deployProgress'

/**
 * A running deploy's progress as one number and a few words: the same in the app
 * bar, in the strip over the preview and on Ray's deploy screen, because they
 * all read it here.
 */
export interface DeployMeter {
  progress: DeployProgress
  /** 0–1, never moving back within a run. */
  fraction: number
  /** The step in progress, counted from 1, and how many there are. */
  step: number
  steps: number
  /** How many times the step has changed (Ray hops when it does). */
  changes: number
  /** Whole seconds since the deploy started. */
  elapsed: number
}

interface Memo {
  startedAt: number
  /** A sign-in retry starts the CLI again, and its progress over. */
  runs: number
  /** When the CLI started in this run; `null` while packages install first. */
  cliAt: number | null
  stepId: string
  stepAt: number
  changes: number
  high: number
}

/** One per deploy, by key (a project), so everything showing a deploy agrees. */
const memos = new Map<string, Memo>()

/**
 * Read a deploy's progress from its log. The bar starts each step where the step
 * usually begins and eases toward where the next would, never back; the CLI's
 * own percentage wins when it gives one.
 */
export function readDeployMeter(key: string, log: readonly string[], startedAt: number, now: number): DeployMeter {
  const runs = deployRuns(log)
  let memo = memos.get(key)
  if (!memo || memo.startedAt !== startedAt) {
    memo = { startedAt, runs, cliAt: startedAt, stepId: '', stepAt: startedAt, changes: 0, high: 0 }
    memos.set(key, memo)
  }
  if (memo.runs !== runs) {
    memo.runs = runs
    memo.cliAt = now
    memo.high = 0
  }
  // An older CLI's progress is partly read off the clock, from when the CLI
  // started in the latest run; installing packages doesn't count.
  const cliSec = memo.cliAt === null ? 0 : Math.max(0, now - memo.cliAt) / 1000
  const progress = readDeployProgress(log, cliSec)
  if (progress.current.id === 'packages') memo.cliAt = null
  else if (memo.cliAt === null) memo.cliAt = now
  if (memo.stepId !== progress.current.id) {
    if (memo.stepId) {
      memo.stepAt = now
      memo.changes += 1
    }
    memo.stepId = progress.current.id
  }

  const span = progress.next - progress.at
  const inStepSec = Math.max(0, now - memo.stepAt) / 1000
  const tau = progress.topic === 'build' || progress.topic === 'upload' ? 16 : 6
  const target = progress.live
    ? 1
    : progress.percent !== null
      ? progress.at + (span * progress.percent) / 100
      : progress.at + span * 0.85 * (1 - Math.exp(-inStepSec / tau))
  memo.high = Math.min(1, Math.max(memo.high, target))

  return {
    progress,
    fraction: memo.high,
    step: progress.steps.findIndex((s) => s.id === progress.current.id) + 1,
    steps: progress.steps.length,
    changes: memo.changes,
    elapsed: Math.max(0, Math.floor((now - startedAt) / 1000))
  }
}

/** Forget a deploy's meter (its screen went away, or it finished). */
export function forgetDeployMeter(key: string): void {
  memos.delete(key)
}

/** A running deploy's meter, read again every second; `null` when none is running. */
export function useDeployMeter(
  key: string,
  log: readonly string[] | undefined,
  startedAt: number | undefined,
  running: boolean
): DeployMeter | null {
  const now = useNow(running)
  if (!running || startedAt === undefined) return null
  return readDeployMeter(key, log ?? [], startedAt, Math.max(now, startedAt))
}

/** `1:07`: a deploy's running time. */
export function clockLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** What a deploy is doing, in a few words for a strip or a status line. */
export function meterStepLabel(meter: DeployMeter): string {
  const { progress } = meter
  if (progress.live) return 'Going live'
  if (progress.topic === 'signin') return 'Waiting for you to sign in to Fabric in your browser'
  if (progress.topic === 'retry') return 'Fabric is busy, trying again'
  return progress.current.label
}
