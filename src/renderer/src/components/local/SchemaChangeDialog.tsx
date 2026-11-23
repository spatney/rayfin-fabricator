import { useEffect, useId, useState, type JSX } from 'react'
import { Trans, useTranslation } from '../../i18n'
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
  const { t } = useTranslation('preview')
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
          <h2 id={titleId}>{t('schema.title')}</h2>
        </div>
        <div className="modal-body">
          <p className="schema-dialog-lead">
            <Trans
              t={t}
              i18nKey="schema.lead"
              values={{ name: projectName }}
              components={{ b: <strong /> }}
            />
          </p>
          {losses.length > 0 ? (
            <ul className="schema-losses" aria-label={t('schema.deletes')}>
              {losses.map((loss) => (
                <li key={loss}>
                  <code>{loss}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="schema-dialog-lead">{t('schema.unknown')}</p>
          )}
          <p className="schema-dialog-choices">
            <Trans
              t={t}
              i18nKey={
                atStart
                  ? published
                    ? 'schema.choices.atStartPublished'
                    : 'schema.choices.atStart'
                  : published
                    ? 'schema.choices.published'
                    : 'schema.choices.default'
              }
              components={{ b: <strong /> }}
            />
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
            {t('schema.keep')}
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
            {working('reset', t('schema.resetting'), t('schema.reset'))}
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
            {working('apply', t('schema.applying'), t('schema.apply'))}
          </button>
        </div>
      </div>
    </div>
  )
}
