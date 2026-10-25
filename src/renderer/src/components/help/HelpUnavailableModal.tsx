import { useEffect, useId, type JSX } from 'react'
import { useSuppressPreview } from '../../overlay'
import { useModalFocus } from '../../modalFocus'
import { BookIcon, Codicon, InfoIcon } from '../icons'
import './help.css'

export interface HelpUnavailableModalProps {
  /** Open the Accounts dialog so the user can sign in to Copilot. */
  onSignIn: () => void
  /** Open the documentation in the browser. */
  onDocs: () => void
  /** Export diagnostics and open a prefilled GitHub bug report. */
  onReportIssue: () => void
  onClose: () => void
}

/**
 * What **Help** does when the assistant can't run.
 *
 * The assistant needs GitHub Copilot, and being signed out is exactly the kind
 * of problem someone opens Help to solve — so this can't be a dead end. It is
 * the static version of the same offer: sign in to get the assistant back, or
 * fall back to the two things it would otherwise have done for you (point you
 * at the docs, or start a bug report).
 *
 * Deliberately a small dialog rather than the full-screen overlay: there is no
 * conversation to show, and a takeover to say "sign in" is out of proportion.
 */
export default function HelpUnavailableModal({
  onSignIn,
  onDocs,
  onReportIssue,
  onClose
}: HelpUnavailableModalProps): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Help</h2>
        </div>
        <div className="modal-body">
          <p className="help-offline-lead">
            Help answers questions about what went wrong using your own error history. It needs
            GitHub Copilot, and you&apos;re not signed in right now.
          </p>
          <ul className="help-offline-list">
            <li>
              <button className="help-offline-item is-primary" onClick={onSignIn} autoFocus>
                <Codicon name="key" className="help-offline-icon" />
                <span className="help-offline-text">
                  <span className="help-offline-title">Sign in to GitHub Copilot</span>
                  <span className="help-offline-sub">Then Help can look into it for you</span>
                </span>
                <Codicon name="arrow-right" className="help-offline-go" />
              </button>
            </li>
            <li>
              <button className="help-offline-item" onClick={onDocs}>
                <BookIcon />
                <span className="help-offline-text">
                  <span className="help-offline-title">Browse the documentation</span>
                  <span className="help-offline-sub">Setup, deploying, and troubleshooting</span>
                </span>
                <Codicon name="link-external" className="help-offline-go" />
              </button>
            </li>
            <li>
              <button className="help-offline-item" onClick={onReportIssue}>
                <InfoIcon />
                <span className="help-offline-text">
                  <span className="help-offline-title">Report an issue</span>
                  <span className="help-offline-sub">
                    Opens a bug report with your version and a diagnostics file
                  </span>
                </span>
                <Codicon name="link-external" className="help-offline-go" />
              </button>
            </li>
          </ul>
        </div>
        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
