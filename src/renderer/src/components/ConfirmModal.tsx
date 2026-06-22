import { useEffect } from 'react'
import { useSuppressPreview } from '../overlay'

interface Props {
  title: string
  message: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as a destructive action. */
  danger?: boolean
  /** Disable controls while the confirmed action runs. */
  busy?: boolean
  /** Label shown on the confirm button while busy (default: 'Working…'). */
  busyLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

/** A small, focused confirmation dialog (e.g. destructive project actions). */
export default function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  busyLabel = 'Working…',
  onConfirm,
  onCancel
}: Props): JSX.Element {
  useSuppressPreview()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
        </div>
        <div className="modal-body">
          <div className="confirm-message">{message}</div>
        </div>
        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
            autoFocus
          >
            {busy ? (
              <span className="btn-busy">
                <span className="btn-spin" aria-hidden="true" />
                {busyLabel}
              </span>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
