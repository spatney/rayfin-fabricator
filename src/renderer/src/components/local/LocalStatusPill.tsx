import type { JSX } from 'react'
import type { LocalStatus } from '@shared/ipc'
import { localStateLabel, runningProblems, type LocalRunningProblem } from '../../localBackend'
import './local.css'

/** The pill's look for a state: a running app with a problem gets a warning dot. */
function tone(
  status: LocalStatus | null,
  pending: boolean,
  problems: LocalRunningProblem[]
): 'ok' | 'warn' | 'busy' | 'err' | 'idle' {
  switch (status?.state) {
    case 'running':
      return problems.length > 0 ? 'warn' : 'ok'
    case 'starting':
    case 'restarting':
      return 'busy'
    case 'error':
      return 'err'
    default:
      return pending ? 'busy' : 'idle'
  }
}

/** The first line of a problem's detail, kept short for a tooltip, as a sentence. */
function firstLine(detail: string | null): string {
  const line =
    detail
      ?.split('\n')
      .find((l) => l.trim())
      ?.trim() ?? ''
  const short = line.length > 200 ? `${line.slice(0, 199).trimEnd()}…` : line
  return !short || /[.!?…:]$/.test(short) ? short : `${short}.`
}

function explain(
  status: LocalStatus | null,
  pending: boolean,
  problems: LocalRunningProblem[]
): string {
  switch (status?.state) {
    case 'running':
      return problems.length > 0
        ? problems.map((p) => [p.summary, firstLine(p.detail)].filter(Boolean).join(' ')).join(' ')
        : 'Your app runs on this computer, with its own backend and data.'
    case 'starting':
    case 'restarting':
      return 'Your app is starting on this computer.'
    case 'error':
      return 'Your app couldn’t start on this computer.'
    default:
      return pending
        ? 'Your app is starting on this computer.'
        : 'Your app isn’t running on this computer.'
  }
}

/** The local backend's state in the preview toolbar; it opens and closes its output. */
export default function LocalStatusPill({
  status,
  pending = false,
  open,
  onToggle
}: {
  status: LocalStatus | null
  /** A start is on its way, or the status isn't known yet. */
  pending?: boolean
  /** The output is showing. */
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const label = localStateLabel(status, pending)
  const problems = runningProblems(status)
  return (
    <button
      type="button"
      className={`local-pill local-pill--${tone(status, pending, problems)}`}
      aria-pressed={open}
      aria-label={`${label} on this computer. ${open ? 'Hide' : 'View'} output`}
      title={`${explain(status, pending, problems)} Select to ${open ? 'hide' : 'view'} its output.`}
      onClick={onToggle}
    >
      <span className="local-pill-dot" aria-hidden="true" />
      <span className="local-pill-label">{label}</span>
    </button>
  )
}
