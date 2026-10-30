import { useEffect, useId, useState, type JSX } from 'react'
import { useSuppressPreview } from '../../overlay'
import { useModalFocus } from '../../modalFocus'
import './local.css'

interface Props {
  projectName: string
  /** What the change would delete, as rayfin-local lists it. */
  losses: string[]
  /** Refused as the app started: it doesn't run until the user decides. */
  atStart: boolean
  /** The app has a published app, whose data the decision doesn't touch. */
  published: boolean
  /** An action is running. */
  busy: boolean
  /** Why the last action failed. */
  error: string | null
  /** Apply the change, deleting the data it drops. */
  onApply: () => void
  /** Delete all of the app's local data, then apply the change. */
  onReset: () => void
  /** Keep the current data model (and, at start, leave the app stopped). */
  onKeep: () => void
}

/**
 * A change to the data model that would delete local data waits for a
 * decision: delete that data and apply it, start over with no local data, or
 * keep the current version. The buttons say what each deletes.
 */
export default function SchemaChangeDialog({
  projectName,
  losses,
  atStart,
  published,
  busy,
  error,
  onApply,
  onReset,
  onKeep
}: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  /** The action the user chose last, which `busy` is about. */
  const [chosen, setChosen] = useState<'apply' | 'reset' | null>(null)
  const working = (action: 'apply' | 'reset', label: string, idle: string): JSX.Element | string =>
    busy && chosen === action ? (
      <span className="btn-busy">
        <span className="btn-spin" aria-hidden="true" />
        {label}
      </span>
    ) : (
      idle
    )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onKeep()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onKeep])

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onKeep}>
      <div
        className="modal schema-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>This change would delete local data</h2>
        </div>
        <div className="modal-body">
          <p className="schema-dialog-lead">
            The data model of <strong>{projectName}</strong> changed. Applying the change deletes
            this data, stored on this computer:
          </p>
          {losses.length > 0 ? (
            <ul className="schema-losses" aria-label="Data the change deletes">
              {losses.map((loss) => (
                <li key={loss}>
                  <code>{loss}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="schema-dialog-lead">Which data it deletes isn’t known.</p>
          )}
          <p className="schema-dialog-choices">
            <strong>Delete this data and apply</strong> deletes only what’s listed.{' '}
            <strong>Reset local data</strong> deletes all of the app’s local data, its test users
            and files, then applies the change. <strong>Keep the current version</strong> keeps your
            data and the data model you have now
            {atStart ? ', and the app doesn’t start until you choose.' : '.'}
            {published ? ' Your published app and its data aren’t affected.' : ''}
          </p>
          {error && (
            <p className="confirm-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-footer schema-dialog-footer">
          <button
            type="button"
            className="btn btn--ghost schema-dialog-keep"
            onClick={onKeep}
            disabled={busy}
            autoFocus
          >
            Keep the current version
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setChosen('reset')
              onReset()
            }}
            disabled={busy}
          >
            {working('reset', 'Resetting…', 'Reset local data')}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              setChosen('apply')
              onApply()
            }}
            disabled={busy}
          >
            {working('apply', 'Applying…', 'Delete this data and apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
