/**
 * The side-thread switcher shown above the chat pane (experimental). Lets the
 * user move between the main thread and any parallel side threads, fork a new
 * one, and — when a side thread goes idle after a turn — confirm or defer the
 * automatic merge back into main.
 *
 * Purely presentational: all state + orchestration lives in Workbench.
 */

export type ThreadUiStatus =
  | 'idle'
  | 'working'
  | 'merging'
  | 'error'
  | 'countdown'
  | 'waiting-main'

export interface ThreadView {
  id: string
  name: string
  status: ThreadUiStatus
  /** Seconds left before the auto-merge fires (status === 'countdown'). */
  countdown?: number
  /** Friendly error (status === 'error'). */
  error?: string
}

interface Props {
  /** Side threads only — the main thread pill is rendered here directly. */
  threads: ThreadView[]
  activeThreadId: string
  mainBusy: boolean
  onSelect: (threadId: string) => void
  onNew: () => void
  onMergeNow: (threadId: string) => void
  onKeepWorking: (threadId: string) => void
  onDiscard: (threadId: string) => void
}

const MAIN = 'main'

function StatusDot({ status }: { status: ThreadUiStatus }): JSX.Element {
  return <span className={`thread-dot thread-dot--${status}`} aria-hidden="true" />
}

export default function ThreadBar({
  threads,
  activeThreadId,
  mainBusy,
  onSelect,
  onNew,
  onMergeNow,
  onKeepWorking,
  onDiscard
}: Props): JSX.Element {
  const counting = threads.filter((t) => t.status === 'countdown')
  const waitingMain = threads.filter((t) => t.status === 'waiting-main')

  return (
    <div className="threadbar">
      <div className="threadbar-pills">
        <button
          type="button"
          className={`thread-pill${activeThreadId === MAIN ? ' thread-pill--active' : ''}`}
          onClick={() => onSelect(MAIN)}
        >
          <StatusDot status={mainBusy ? 'working' : 'idle'} />
          <span className="thread-pill-name">Main</span>
        </button>

        {threads.map((t) => (
          <span
            key={t.id}
            className={`thread-pill${activeThreadId === t.id ? ' thread-pill--active' : ''}`}
          >
            <button type="button" className="thread-pill-main" onClick={() => onSelect(t.id)}>
              <StatusDot status={t.status} />
              <span className="thread-pill-name" title={t.error ?? t.name}>
                {t.name}
              </span>
            </button>
            <button
              type="button"
              className="thread-pill-x"
              title="Discard side thread"
              aria-label={`Discard ${t.name}`}
              onClick={() => onDiscard(t.id)}
            >
              ✕
            </button>
          </span>
        ))}

        <button type="button" className="thread-pill thread-pill--new" onClick={onNew}>
          <span className="thread-plus" aria-hidden="true">
            +
          </span>
          New thread
        </button>
      </div>

      {counting.map((t) => (
        <div key={t.id} className="merge-banner">
          <span className="merge-banner-spinner" aria-hidden="true" />
          <span className="merge-banner-text">
            Merging <strong>{t.name}</strong> into main in {t.countdown}s…
          </span>
          <div className="merge-banner-actions">
            <button type="button" className="btn btn--xs btn--primary" onClick={() => onMergeNow(t.id)}>
              Merge now
            </button>
            <button
              type="button"
              className="btn btn--xs btn--ghost"
              onClick={() => onKeepWorking(t.id)}
            >
              Keep working
            </button>
          </div>
        </div>
      ))}

      {waitingMain.map((t) => (
        <div key={t.id} className="merge-banner merge-banner--waiting">
          <span className="merge-banner-spinner" aria-hidden="true" />
          <span className="merge-banner-text">
            <strong>{t.name}</strong> is ready — merging once <strong>Main</strong> finishes…
          </span>
          <div className="merge-banner-actions">
            <button
              type="button"
              className="btn btn--xs btn--ghost"
              onClick={() => onKeepWorking(t.id)}
            >
              Keep working
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
