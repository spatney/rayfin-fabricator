/**
 * A lightweight loading placeholder: a few softly pulsing bars that echo the
 * shape of the content about to arrive (list rows). Prefer this over a bare
 * "Loading…" label for panes that render structured lists. Decorative only
 * (`aria-hidden`) — the surrounding region should carry any `aria-busy`.
 */
export default function Skeleton({
  rows = 4,
  avatar = false
}: {
  /** How many placeholder rows to render. */
  rows?: number
  /** Show a leading dot/avatar per row (e.g. for a commit timeline). */
  avatar?: boolean
}): JSX.Element {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          {avatar && <span className="skeleton-dot skeleton-pulse" />}
          <span className="skeleton-col">
            <span className="skeleton-bar skeleton-pulse" style={{ width: `${68 - (i % 3) * 10}%` }} />
            <span
              className="skeleton-bar skeleton-bar--sm skeleton-pulse"
              style={{ width: `${44 + (i % 2) * 12}%` }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}
