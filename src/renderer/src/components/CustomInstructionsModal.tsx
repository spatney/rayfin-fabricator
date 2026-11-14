import { useEffect, useId, useState, type JSX } from 'react'
import { CUSTOM_INSTRUCTIONS_MAX } from '@shared/ipc'
import { formatLocale, useTranslation } from '../i18n'
import { useModalFocus } from '../modalFocus'
import { useSuppressPreview } from '../overlay'

/**
 * Custom instructions: your own guidance for every app you build, such as "Use
 * the system theme by default." Every Build chat follows them, with
 * Fabricator's own guidance, from its next message. Save keeps them; Cancel,
 * Escape and a click outside leave them as they were.
 */
export default function CustomInstructionsModal({
  instructions,
  onSave,
  onClose
}: {
  /** The saved instructions. */
  instructions?: string
  /** Save the instructions; an empty text clears them. */
  onSave: (text: string) => void
  onClose: () => void
}): JSX.Element {
  const { t } = useTranslation('models')
  useSuppressPreview()
  const titleId = useId()
  const fieldId = useId()
  const hintId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const saved = instructions ?? ''
  const [text, setText] = useState(saved)
  const changed = text.trim() !== saved.trim()
  /** Examples in the empty box: the kind of guidance that suits every app. */
  const placeholder = [
    t('instructions.examples.theme'),
    t('instructions.examples.case'),
    t('instructions.examples.dates')
  ].join('\n')

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function save(): void {
    onSave(text.trim())
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal custom-instructions-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{t('instructions.title')}</h2>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onClose}
            aria-label={t('instructions.close')}
          >
            ✕
          </button>
        </div>

        <div className="modal-body settings-body">
          <p className="modal-sub">{t('instructions.sub')}</p>
          <div className="field">
            <label className="field-label" htmlFor={fieldId}>
              {t('instructions.label')}
            </label>
            <textarea
              id={fieldId}
              className="field-input custom-instructions-text"
              rows={9}
              maxLength={CUSTOM_INSTRUCTIONS_MAX}
              autoFocus
              value={text}
              placeholder={placeholder}
              aria-describedby={hintId}
              onChange={(e) => setText(e.target.value)}
            />
            <span className="field-hint custom-instructions-hint" id={hintId}>
              <span>{t('instructions.hint')}</span>
              <span className="custom-instructions-count">
                {text.length.toLocaleString(formatLocale())} /{' '}
                {CUSTOM_INSTRUCTIONS_MAX.toLocaleString(formatLocale())}
              </span>
            </span>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('actions.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={!changed} onClick={save}>
            {t('actions.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
