import { useEffect, useId, useMemo, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { SupportingSummary } from '@shared/ipc'
import { useTranslation } from '../../i18n'
import { useModalFocus } from '../../modalFocus'
import { useSuppressPreview } from '../../overlay'
import type { SemanticModelRef } from '../../model/fabricConfig'
import SemanticModelView from '../SemanticModelView'
import { BlueprintHeadSlot } from '../blueprint/ViewHead'
import { Codicon } from '../icons'
import { countsLine, storageLine } from './text'
import './supporting.css'

/**
 * The model a supporting item's folder defines, drawn the way Blueprint draws a
 * semantic model, from the app's files rather than Fabric: what the user
 * reviews before Fabricator creates or changes it.
 */
export default function SupportingModelDialog({
  projectId,
  name,
  folder,
  summary,
  onClose
}: {
  projectId: string
  name: string
  /** Its folder: `Sales.SemanticModel`, or from the app's root, `supporting-items/Sales.SemanticModel`. */
  folder: string
  /** What it holds and reads, for the header. */
  summary?: SupportingSummary
  onClose: () => void
}): JSX.Element {
  const { t } = useTranslation('supporting')
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const leaf = folder.split('/').pop() || folder
  const models = useMemo<SemanticModelRef[]>(
    () => [{ alias: name, workspaceId: '', itemId: leaf, folder: leaf }],
    [name, leaf]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="modal-backdrop sup-model-backdrop" onClick={onClose}>
      <div
        className="modal sup-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header sup-model-head">
          <span className="sup-tile" aria-hidden="true">
            <Codicon name="graph" />
          </span>
          <div className="sup-item-titles">
            <h2 id={titleId} className="sup-model-title">
              {name}
            </h2>
            <span className="sup-item-sub">
              {t('dialog.definedIn')}
              <code className="sup-path">supporting-items/{leaf}</code>
              {summary && summary.tables > 0 && (
                <>
                  <span className="sup-sep" aria-hidden="true">
                    ·
                  </span>
                  <span>
                    {[countsLine(summary), storageLine(summary)].filter(Boolean).join(' · ')}
                  </span>
                </>
              )}
            </span>
          </div>
          <button
            type="button"
            className="btn btn--xs btn--ghost"
            onClick={onClose}
            aria-label={t('dialog.close')}
            title={t('dialog.close')}
          >
            <Codicon name="close" />
          </button>
        </div>
        <div className="sup-model-body">
          {/* Opened from Blueprint, the diagram's header stays in the dialog, not Blueprint's own. */}
          <BlueprintHeadSlot.Provider value={null}>
            <SemanticModelView projectId={projectId} models={models} refreshKey={0} title={name} />
          </BlueprintHeadSlot.Provider>
        </div>
      </div>
    </div>,
    document.body
  )
}
