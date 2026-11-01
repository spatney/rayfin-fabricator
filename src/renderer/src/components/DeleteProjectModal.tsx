import { useEffect, useId, useState, type JSX } from 'react'
import type { StudioProject } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'

interface Props {
  project: StudioProject
  /** Start removing the project in the background. The dialog closes right away. */
  onConfirm: (project: StudioProject, choice: { deleteApp: boolean }) => void
  onClose: () => void
}

function CheckMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12.5l4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Choose what removing a project removes: its folder always moves to the system
 * trash, and its published Fabric app can be deleted with it. The removal runs in
 * the background, so the app stays usable and other projects can go at once.
 */
export default function DeleteProjectModal({ project, onConfirm, onClose }: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const folderId = useId()
  const appId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const hasDeploy = Boolean(project.lastDeploy?.url)
  // On whenever there's a published app to delete: opting out is one click.
  const [deleteApp, setDeleteApp] = useState(hasDeploy)
  const removesApp = hasDeploy && deleteApp

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function confirm(): void {
    onConfirm(project, { deleteApp: removesApp })
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal remove-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Remove project</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body remove-body">
          <p className="remove-lead">
            Choose what to remove for <strong>{project.name}</strong>.
          </p>

          {/* Removing a project always trashes its folder; keeping it is Remove from recent projects. */}
          <label className="remove-option remove-option--on">
            <input
              type="checkbox"
              className="remove-option-input"
              checked
              disabled
              aria-labelledby={`${folderId}-title`}
              aria-describedby={`${folderId}-desc`}
            />
            <span className="remove-check" aria-hidden="true">
              <CheckMark />
            </span>
            <span className="remove-option-text">
              <span className="remove-option-head">
                <span className="remove-option-title" id={`${folderId}-title`}>
                  Local project folder
                </span>
                <span className="remove-badge">Recoverable</span>
              </span>
              <span className="remove-option-desc" id={`${folderId}-desc`}>
                Move to <strong>system trash</strong>. Restore it from there.
              </span>
              <span className="remove-path" title={project.path}>
                {project.path}
              </span>
            </span>
          </label>

          {hasDeploy && (
            <label
              className={`remove-option remove-option--danger${deleteApp ? ' remove-option--on' : ''}`}
            >
              <input
                type="checkbox"
                className="remove-option-input"
                checked={deleteApp}
                onChange={(event) => setDeleteApp(event.target.checked)}
                aria-labelledby={`${appId}-title`}
                aria-describedby={`${appId}-desc`}
              />
              <span className="remove-check" aria-hidden="true">
                <CheckMark />
              </span>
              <span className="remove-option-text">
                <span className="remove-option-head">
                  <span className="remove-option-title" id={`${appId}-title`}>
                    Published Fabric app
                  </span>
                  <span className="remove-badge remove-badge--danger">Permanent</span>
                </span>
                <span className="remove-option-desc" id={`${appId}-desc`}>
                  Delete {project.name} and all app data in{' '}
                  {project.workspaceName ?? 'its Fabric workspace'}.
                  <span className="remove-option-warn">This cannot be undone.</span>
                </span>
              </span>
            </label>
          )}

          <p className="remove-note">
            <span className="codicon codicon-info" aria-hidden="true" />
            {!hasDeploy
              ? 'No published Fabric app is linked to this project.'
              : removesApp
                ? 'Your Fabric workspace will be kept.'
                : 'The published app and its data stay in Fabric.'}
          </p>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" autoFocus onClick={confirm}>
            {removesApp ? 'Trash folder & delete app' : 'Move folder to trash'}
          </button>
        </div>
      </div>
    </div>
  )
}
