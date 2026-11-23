import type { JSX } from 'react'
import type { LocalStatus } from '@shared/ipc'
import { translator, useTranslation } from '../../i18n'
import {
  localStateLabel,
  localTone,
  runningProblems,
  type LocalRunningProblem
} from '../../localBackend'
import { TerminalIcon } from '../icons'
import './local.css'

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
  const t = translator('preview')
  switch (status?.state) {
    case 'running':
      return problems.length > 0
        ? problems.map((p) => [p.summary, firstLine(p.detail)].filter(Boolean).join(' ')).join(' ')
        : t('output.running')
    case 'starting':
    case 'restarting':
      return t('output.starting')
    case 'error':
      return t('output.couldntStart')
    default:
      return pending ? t('output.starting') : t('output.notRunning')
  }
}

/** What the button says for a running app's problems: "1 problem", "2 problems". */
function problemCount(problems: LocalRunningProblem[]): string | null {
  if (problems.length === 0) return null
  return translator('preview')('output.problems', { count: problems.length })
}

/**
 * The preview toolbar's **Output** button for the app on this computer: it shows
 * and hides the output of its backend, Vite and functions, the terminal panel's
 * Output tab. The app's state shows on it only when it needs a look: a blinking
 * dot while it starts, a red one when it couldn't start, and an amber one with
 * the number of problems when it runs but its latest change didn't apply.
 * Running fine, the app on screen says so itself.
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
  const { t } = useTranslation('preview')
  const problems = runningProblems(status)
  const look = localTone(status, pending)
  const marked = look === 'busy' || look === 'warn' || look === 'err'
  const count = problemCount(problems)
  const explanation = explain(status, pending, problems)
  return (
    <button
      type="button"
      className={`seg-btn local-output-btn local-output-btn--${look}${marked ? '' : ' seg-btn--icon'}${open ? ' seg-btn--on' : ''}`}
      aria-pressed={open}
      aria-label={t('output.label', { state: count ?? localStateLabel(status, pending) })}
      title={open ? t('output.hide', { explanation }) : t('output.show', { explanation })}
      onClick={onToggle}
    >
      <TerminalIcon className="btn-ico local-output-ico" />
      {marked && <span className="local-output-dot" aria-hidden="true" />}
      {count && <span className="seg-btn-label">{count}</span>}
    </button>
  )
}
