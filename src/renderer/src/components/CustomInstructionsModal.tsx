import { useEffect, useId, useState, type JSX } from 'react'
import { CUSTOM_INSTRUCTIONS_MAX } from '@shared/ipc'
import { useModalFocus } from '../modalFocus'
import { useSuppressPreview } from '../overlay'

/** Examples in the empty box: the kind of guidance that suits every app. */
const PLACEHOLDER = [
  'Use the system’s light or dark theme by default.',
  'Use sentence case for headings, labels and buttons.',
  'Show dates like 5 Mar 2026.'
].join('\n')

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
  useSuppressPreview()
  const titleId = useId()
  const fieldId = useId()
  const hintId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const saved = instructions ?? ''
  const [text, setText] = useState(saved)
  const changed = text.trim() !== saved.trim()

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
          <h2 id={titleId}>Custom instructions</h2>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onClose}
            aria-label="Close custom instructions"
          >
            ✕
          </button>
        </div>

        <div className="modal-body settings-body">
          <p className="modal-sub">
            Tell Copilot what you want in every app you build, such as a theme, wording or layout.
            Each app’s chat follows these from its next message, and what you ask in the chat comes
            first. They stay in Fabricator: they aren’t saved in your apps.
          </p>
          <div className="field">
            <label className="field-label" htmlFor={fieldId}>
              Instructions
            </label>
            <textarea
              id={fieldId}
              className="field-input custom-instructions-text"
              rows={9}
              maxLength={CUSTOM_INSTRUCTIONS_MAX}
              autoFocus
              value={text}
              placeholder={PLACEHOLDER}
              aria-describedby={hintId}
              onChange={(e) => setText(e.target.value)}
            />
            <span className="field-hint custom-instructions-hint" id={hintId}>
              <span>Keep them short: Copilot reads them with every message.</span>
              <span className="custom-instructions-count">
                {text.length.toLocaleString()} / {CUSTOM_INSTRUCTIONS_MAX.toLocaleString()}
              </span>
            </span>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!changed} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
