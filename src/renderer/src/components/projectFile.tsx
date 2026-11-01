import type { CSSProperties, JSX, ReactNode } from 'react'
import { hueOf } from './team/map/parts'

/** `1 file`, `1,234 files`. */
export function count(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
}

/** The last part of a path, on Windows or macOS. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** The project's mark and name, with a line about what's happening to it. */
export function ProjectFileSummary({
  name,
  children
}: {
  name: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="project-manage-summary">
      <span
        className="home-project-mark project-manage-mark"
        aria-hidden="true"
        style={{ '--hue': hueOf(name) } as CSSProperties}
      >
        {name.trim()[0]?.toUpperCase() ?? '?'}
      </span>
      <span className="project-manage-summary-text">
        <strong>{name}</strong>
        <span className="project-file-lead">{children}</span>
      </span>
    </div>
  )
}

/** Writing or unpacking a project's file: what's happening, and how far it's got. */
export function ProjectFileProgress({
  label,
  name,
  processed,
  total
}: {
  /** What's happening, e.g. "Exporting Sales…". */
  label: string
  /** The progress bar's accessible name. */
  name: string
  processed: number
  total: number
}): JSX.Element {
  const percent = total ? Math.max(2, (processed / total) * 100) : 2
  return (
    <div className="project-file-progress" role="status">
      <span className="project-file-progress-text">
        <span className="ws-spinner" aria-hidden="true" />
        {label}
      </span>
      <span
        className="project-file-bar"
        role="progressbar"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={processed}
      >
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="project-file-count">
        {processed.toLocaleString('en-US')} of {count(total, 'file')}
      </span>
    </div>
  )
}
