import { useUpdates } from '../update'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * App-wide banner for the in-app updater. Renders only while an update is being
 * downloaded, is ready to install, or is installing — otherwise nothing.
 */
export default function UpdateBanner(): JSX.Element | null {
  const { status, info, progress, blocking, install, dismiss } = useUpdates()

  // The mandatory full-screen ForcedUpdateScreen takes over while blocking.
  if (blocking) return null

  if (status !== 'downloading' && status !== 'ready' && status !== 'installing') {
    return null
  }

  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null

  let title = ''
  let meta: string | null = null
  if (status === 'downloading') {
    title = `Downloading update${info ? ` ${info.version}` : ''}…`
    meta = pct !== null ? `${pct}%` : progress ? formatBytes(progress.downloaded) : 'Starting…'
  } else if (status === 'ready') {
    title = `Update ${info?.version ?? ''} is ready to install`.replace('  ', ' ')
    meta = 'Fabricator will restart to apply it.'
  } else {
    title = 'Installing update…'
  }

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <div className="update-banner__row">
        <span className="update-banner__dot" aria-hidden="true" />
        <div className="update-banner__body">
          <span className="update-banner__title">{title}</span>
          {meta && <span className="update-banner__meta">{meta}</span>}
        </div>
        {status === 'ready' && (
          <div className="update-banner__actions">
            <button className="btn btn--sm btn--ghost" onClick={dismiss}>
              Later
            </button>
            <button className="btn btn--sm btn--primary" onClick={() => void install()}>
              Restart &amp; update
            </button>
          </div>
        )}
      </div>

      {status === 'downloading' && (
        <div className="update-banner__bar" aria-hidden="true">
          <div
            className={`update-banner__bar-fill${pct === null ? ' update-banner__bar-fill--indet' : ''}`}
            style={pct !== null ? { width: `${pct}%` } : undefined}
          />
        </div>
      )}
    </div>
  )
}
