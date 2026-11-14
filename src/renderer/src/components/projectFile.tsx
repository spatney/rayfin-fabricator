import type { CSSProperties, JSX, ReactNode } from 'react'
import { useTranslation } from '../i18n'
import { initials, markHue } from './gallery/model'

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
        style={{ '--hue': markHue(name) } as CSSProperties}
      >
        {initials(name)}
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
  const { t } = useTranslation('projects')
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
      <span className="project-file-count">{t('file.progress', { processed, count: total })}</span>
    </div>
  )
}
