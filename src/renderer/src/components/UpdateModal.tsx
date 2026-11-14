import { useUpdates } from '../update'
import { useTranslation } from '../i18n'
import ConfirmModal from './ConfirmModal'
import Markdown from './Markdown'

import type { JSX } from 'react'

/**
 * Centered, dismissible prompt for the optional startup update. Shown once an
 * automatic check has downloaded a ready-to-install release (`useUpdates().modalOpen`).
 *
 * "Update now" installs and restarts; "Later" boots into the app and leaves the
 * {@link UpdateBanner} as a reminder — so a user can decline a broken release and
 * stay on their working version. The mandatory/`blocking` flow never renders this
 * (it uses {@link ForcedUpdateScreen} instead).
 */
export default function UpdateModal(): JSX.Element | null {
  const { modalOpen, info, status, install, later } = useUpdates()
  const { t } = useTranslation('app')

  if (!modalOpen) return null

  const version = info?.version
  const message = (
    <div className="update-modal">
      <p className="update-modal__lead">
        {version ? t('update.leadVersion', { version }) : t('update.lead')}
      </p>
      {info?.currentVersion && version && (
        <p className="update-modal__versions">
          {info.currentVersion} → {version}
        </p>
      )}
      {/* The release's notes are the GitHub release's Markdown. */}
      {info?.notes && (
        <div className="update-modal__notes">
          <Markdown>{info.notes}</Markdown>
        </div>
      )}
      <p className="update-modal__hint">{t('update.hint')}</p>
    </div>
  )

  return (
    <ConfirmModal
      title={t('update.title')}
      message={message}
      confirmLabel={t('update.updateNow')}
      cancelLabel={t('update.later')}
      busy={status === 'installing'}
      busyLabel={t('update.installingShort')}
      onConfirm={() => void install()}
      onCancel={later}
    />
  )
}
