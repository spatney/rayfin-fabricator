import { useUpdates } from '../update'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Full-screen, non-dismissible gate shown when a mandatory startup update is
 * found. It blocks the whole app while the update downloads and installs itself;
 * the app restarts automatically once applied. There is no "Later" — driven by
 * `useUpdates().blocking`.
 */
export default function ForcedUpdateScreen(): JSX.Element {
  const { status, info, progress } = useUpdates()

  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null
  const installing = status === 'ready' || status === 'installing'

  const title = installing
    ? `Installing update${info ? ` ${info.version}` : ''}…`
    : `Downloading update${info ? ` ${info.version}` : ''}…`
  const meta = installing
    ? 'Rayfin Fabricator will restart automatically.'
    : pct !== null
      ? `${pct}%`
      : progress
        ? formatBytes(progress.downloaded)
        : 'Starting…'

  return (
    <div className="forced-update" role="alertdialog" aria-modal="true" aria-live="polite">
      <div className="forced-update__card">
        <span className="forced-update__dot" aria-hidden="true" />
        <span className="forced-update__title">{title}</span>
        <span className="forced-update__meta">{meta}</span>
        <div className="forced-update__bar" aria-hidden="true">
          <div
            className={`forced-update__bar-fill${
              installing || pct === null ? ' forced-update__bar-fill--indet' : ''
            }`}
            style={!installing && pct !== null ? { width: `${pct}%` } : undefined}
          />
        </div>
        <span className="forced-update__note">A required update must be installed to continue.</span>
      </div>
    </div>
  )
}
