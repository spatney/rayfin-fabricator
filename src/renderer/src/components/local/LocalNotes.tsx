import type { JSX } from 'react'
import { Trans, useTranslation } from '../../i18n'
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
  const { t } = useTranslation('preview')
  return (
    <section className="local-note" aria-label={t('notes.backend')}>
      <Codicon name="cloud" className="local-note-icon" />
      <p className="local-note-text">{reason}</p>
    </section>
  )
}

/**
 * The app runs on this computer on a Rayfin version the local backend doesn't
 * implement, such as a newer one: some things might not work as expected.
 */
export function SdkWarningNote({ warning }: { warning: string }): JSX.Element {
  const { t } = useTranslation('preview')
  return (
    <section className="local-note" aria-label={t('notes.rayfinVersion')}>
      <Codicon name="warning" className="local-note-icon local-note-icon--warn" />
      <p className="local-note-text">{warning}</p>
    </section>
  )
}

/**
 * A data model change the running backend refused because it would delete
 * local data: the app keeps the previous data model until the user decides.
 */
export function SchemaWaitingNote({ onReview }: { onReview: () => void }): JSX.Element {
  const { t } = useTranslation('preview')
  return (
    <section className="local-note" aria-label={t('notes.schemaWaiting')}>
      <span className="local-note-dot" aria-hidden="true" />
      <p className="local-note-text">
        <Trans t={t} i18nKey="notes.schemaWaitingText" components={{ b: <strong /> }} />
      </p>
      <button type="button" className="btn btn--sm" onClick={onReview}>
        {t('schema.review')}
      </button>
    </section>
  )
}
