import type { JSX } from 'react'
import { Codicon } from '../icons'
import './local.css'

const NOTICE_KEY = 'fabricator.localNotice.'

/** The "now runs on this computer" notice was seen (or never needed) for the project. */
export function localNoticeSeen(projectId: string): boolean {
  try {
    return localStorage.getItem(NOTICE_KEY + projectId) === '1'
  } catch {
    return true
  }
}

export function markLocalNoticeSeen(projectId: string): void {
  try {
    localStorage.setItem(NOTICE_KEY + projectId, '1')
  } catch {
    // Without storage it shows again next time; nothing else depends on it.
  }
}

/**
 * Once, for an app that was published before it ran on this computer: its
 * local data starts empty, and the published app keeps its own.
 */
export function PublishedAppNotice({
  name,
  onShowPublished,
  onDismiss
}: {
  name: string
  onShowPublished: () => void
  onDismiss: () => void
}): JSX.Element {
  return (
    <section className="local-note" aria-label="Your app runs on this computer">
      <Codicon name="info" className="local-note-icon" />
      <p className="local-note-text">
        <strong>{name} now runs on this computer.</strong> Its local data starts empty. Your
        published app and its data are unchanged.
      </p>
      <button type="button" className="btn btn--sm" onClick={onShowPublished}>
        Show published app
      </button>
      <button
        type="button"
        className="icon-btn local-note-close"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
      >
        <Codicon name="close" />
      </button>
    </section>
  )
}

/** Why the preview uses the published app's backend instead of this computer's. */
export function FallbackNote({ reason }: { reason: string }): JSX.Element {
  return (
    <section className="local-note" aria-label="Preview backend">
      <Codicon name="cloud" className="local-note-icon" />
      <p className="local-note-text">{reason}</p>
    </section>
  )
}

/**
 * A data model change the running backend refused because it would delete
 * local data: the app keeps the previous data model until the user decides.
 */
export function SchemaWaitingNote({ onReview }: { onReview: () => void }): JSX.Element {
  return (
    <section className="local-note" aria-label="Data model change waiting">
      <span className="local-note-dot" aria-hidden="true" />
      <p className="local-note-text">
        <strong>A data model change is waiting.</strong> It would delete data stored on this
        computer, so your app still uses the previous data model.
      </p>
      <button type="button" className="btn btn--sm" onClick={onReview}>
        Review the change
      </button>
    </section>
  )
}
