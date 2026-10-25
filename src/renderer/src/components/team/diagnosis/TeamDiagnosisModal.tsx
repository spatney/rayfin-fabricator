import { useEffect, useId, type JSX } from 'react'
import { useSuppressPreview } from '../../../overlay'
import { useModalFocus } from '../../../modalFocus'
import TeamDiagnosis from './TeamDiagnosis'
import type { DiagnosisInput } from './useTeamDiagnosis'
import '../team.css'

interface Props {
  input: DiagnosisInput
  title?: string
  /** Hand the answer to the Build chat (closes this dialog). */
  onFixInChat?: (answer: string) => void
  onClose: () => void
}

/** "Diagnose with Copilot" in its own dialog, for menus and lists. It starts right away. */
export default function TeamDiagnosisModal({ input, title = 'Diagnose with Copilot', onFixInChat, onClose }: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal team-modal team-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
        </div>
        <div className="modal-body team-form">
          <TeamDiagnosis
            input={input}
            autoStart
            onFixInChat={
              onFixInChat &&
              ((answer) => {
                onFixInChat(answer)
                onClose()
              })
            }
          />
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
