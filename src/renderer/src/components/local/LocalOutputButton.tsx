import type { JSX } from 'react'
import type { LocalStatus } from '@shared/ipc'
import { localStateLabel, runningProblems, type LocalRunningProblem } from '../../localBackend'
import { TerminalIcon } from '../icons'
import './local.css'

/** The button's look for a state: a running app with a problem gets a warning dot. */
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

/** What the button says for a running app's problems: "1 problem", "2 problems". */
function problemCount(problems: LocalRunningProblem[]): string | null {
  if (problems.length === 0) return null
  return problems.length === 1 ? '1 problem' : `${problems.length} problems`
}

/**
 * The preview toolbar's **Output** button for the app on this computer: it opens
 * and closes the output of its backend, Vite and functions under the preview.
 * The app's state shows on it only when it needs a look: a blinking dot while it
 * starts, a red one when it couldn't start, and an amber one with the number of
 * problems when it runs but its latest change didn't apply. Running fine, the
 * app on screen says so itself.
 */
export default function LocalOutputButton({
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
  const problems = runningProblems(status)
  const look = tone(status, pending, problems)
  const marked = look === 'busy' || look === 'warn' || look === 'err'
  const count = problemCount(problems)
  return (
    <button
      type="button"
      className={`seg-btn local-output-btn local-output-btn--${look}${marked ? '' : ' seg-btn--icon'}${open ? ' seg-btn--on' : ''}`}
      aria-pressed={open}
      aria-label={`Output: ${count ?? localStateLabel(status, pending)}`}
      title={`${explain(status, pending, problems)} Select to ${open ? 'hide' : 'view'} its output.`}
      onClick={onToggle}
    >
      <TerminalIcon className="btn-ico local-output-ico" />
      {marked && <span className="local-output-dot" aria-hidden="true" />}
      {count && <span className="seg-btn-label">{count}</span>}
    </button>
  )
}
