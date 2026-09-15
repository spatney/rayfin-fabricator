import { useUpdates } from '../update'
import ConfirmModal from './ConfirmModal'

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

  if (!modalOpen) return null

  const version = info?.version
  const message = (
    <div className="update-modal">
      <p className="update-modal__lead">
        {version ? `Fabricator ${version} is ready to install.` : 'A new update is ready to install.'}
      </p>
      {info?.currentVersion && version && (
        <p className="update-modal__versions">
          {info.currentVersion} → {version}
        </p>
      )}
      {info?.notes && <div className="update-modal__notes">{info.notes}</div>}
      <p className="update-modal__hint">
        You can install now, or choose Later to keep using this version and update anytime.
      </p>
    </div>
  )

  return (
    <ConfirmModal
      title="Update available"
      message={message}
      confirmLabel="Update now"
      cancelLabel="Later"
      busy={status === 'installing'}
      busyLabel="Installing…"
      onConfirm={() => void install()}
      onCancel={later}
    />
  )
}
