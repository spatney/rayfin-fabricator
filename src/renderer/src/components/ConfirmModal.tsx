import { useEffect, useId } from 'react'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'

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
  /**
   * Optional middle button (e.g. "Get latest first") shown between Cancel and the
   * confirm action. Rendered only when both `secondaryLabel` and `onSecondary` are set.
   */
  secondaryLabel?: string
  onSecondary?: () => void
  /** When true, show a spinner on the secondary button and disable controls. */
  secondaryBusy?: boolean
  /** Label shown on the secondary button while busy (default: 'Working…'). */
  secondaryBusyLabel?: string
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
  secondaryLabel,
  onSecondary,
  secondaryBusy = false,
  secondaryBusyLabel = 'Working…',
  onConfirm,
  onCancel
}: Props): JSX.Element {
  useSuppressPreview()
  const working = busy || secondaryBusy
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !working) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [working, onCancel])

  return (
    <div className="modal-backdrop" onClick={working ? undefined : onCancel}>
      <div
        className="modal modal--sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
        </div>
        <div className="modal-body">
          <div className="confirm-message">{message}</div>
        </div>
        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onCancel} disabled={working}>
            {cancelLabel}
          </button>
          {secondaryLabel && onSecondary && (
            <button className="btn btn--ghost" onClick={onSecondary} disabled={working}>
              {secondaryBusy ? (
                <span className="btn-busy">
                  <span className="btn-spin" aria-hidden="true" />
                  {secondaryBusyLabel}
                </span>
              ) : (
                secondaryLabel
              )}
            </button>
          )}
          <button
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={working}
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
