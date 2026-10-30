import type { JSX } from 'react'
import type { LocalStatus } from '@shared/ipc'
import { localStateLabel } from '../../localBackend'
import './local.css'

/** The pill's look for a state. */
function tone(status: LocalStatus | null, pending: boolean): 'ok' | 'busy' | 'err' | 'idle' {
  switch (status?.state) {
    case 'running':
      return 'ok'
    case 'starting':
    case 'restarting':
      return 'busy'
    case 'error':
      return 'err'
    default:
      return pending ? 'busy' : 'idle'
  }
}

function explain(status: LocalStatus | null, pending: boolean): string {
  switch (status?.state) {
    case 'running':
      return 'Your app runs on this computer, with its own backend and data.'
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
  return (
    <button
      type="button"
      className={`local-pill local-pill--${tone(status, pending)}`}
      aria-pressed={open}
      aria-label={`${label} on this computer. ${open ? 'Hide' : 'View'} output`}
      title={`${explain(status, pending)} Select to ${open ? 'hide' : 'view'} its output.`}
      onClick={onToggle}
    >
      <span className="local-pill-dot" aria-hidden="true" />
      <span className="local-pill-label">{label}</span>
    </button>
  )
}
