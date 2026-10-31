import type { JSX } from 'react'
import { Codicon } from '../icons'
import './local.css'

const NOTICE_KEY = 'fabricator.localNotice.'

/**
 * The app was published before it ran on this computer, and its local data
 * starting empty was pointed out (or never needed to be) for the project.
 */
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
