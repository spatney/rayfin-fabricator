import { useEffect, useId, useState, type FormEvent } from 'react'
import type { StudioProject } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'

interface Props {
  project: StudioProject
  /** Return an error message to keep the dialog open, or null after a successful rename. */
  onRename: (project: StudioProject, name: string) => Promise<string | null>
  onRemoveFromList: (project: StudioProject) => void
  onMoveToTrash: (project: StudioProject) => void
  onClose: () => void
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Could not rename the project. Please try again.'
}

/** Keeps project metadata, recents cleanup, and local-file cleanup visibly separate. */
export default function ManageProjectModal({
  project,
  onRename,
  onRemoveFromList,
  onMoveToTrash,
  onClose
}: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const [name, setName] = useState(project.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasDeploy = Boolean(project.lastDeploy?.url)
  const trimmedName = name.trim()
  const canSave = Boolean(trimmedName) && trimmedName !== project.name && !saving

  useEffect(() => {
    setName(project.name)
    setError(null)
  }, [project.id, project.name])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  async function saveName(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!trimmedName) {
      setError('Enter a project name.')
      return
    }
    if (trimmedName === project.name) {
      onClose()
      return
    }

    setSaving(true)
    setError(null)
    try {
      const nextError = await onRename(project, trimmedName)
      if (nextError) {
        setError(nextError)
        return
      }
      onClose()
    } catch (reason) {
      setError(messageFor(reason))
    } finally {
      setSaving(false)
    }
  }

  function removeFromRecents(): void {
    onClose()
    onRemoveFromList(project)
  }

  function moveToTrash(): void {
    onClose()
    onMoveToTrash(project)
  }

  return (
    <div className="modal-backdrop" onClick={saving ? undefined : onClose}>
      <div
        className="modal modal--sm project-manage-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Manage project</h2>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            aria-label="Close project management"
            disabled={saving}
            onClick={onClose}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body">
          <div className="project-manage-summary">
            <span className="project-manage-mark" aria-hidden="true">
              {project.name.trim()[0]?.toUpperCase() ?? '?'}
            </span>
            <span className="project-manage-summary-text">
              <strong>{project.name}</strong>
              <code className="project-manage-path" title={project.path}>
                {project.path}
              </code>
            </span>
          </div>

          <form className="project-manage-section" onSubmit={(event) => void saveName(event)}>
            <div className="project-manage-section-heading">
              <span className="project-manage-label">Project details</span>
              <span className="project-manage-hint">
                Changing the name also updates <code>rayfin/rayfin.yml</code>.
              </span>
            </div>
            <label className="project-manage-name-field">
              <span>Project name</span>
              <div className="project-manage-rename-row">
                <input
                  className="project-manage-input"
                  value={name}
                  autoFocus
                  spellCheck={false}
                  onChange={(event) => {
                    setName(event.target.value)
                    setError(null)
                  }}
                />
                <button type="submit" className="btn btn--primary btn--sm" disabled={!canSave}>
                  {saving ? 'Saving...' : 'Save name'}
                </button>
              </div>
            </label>
            {error && (
              <p className="project-manage-error" role="alert">
                {error}
              </p>
            )}
          </form>

          <section className="project-manage-section" aria-labelledby="project-recents-title">
            <div className="project-manage-section-heading">
              <span id="project-recents-title" className="project-manage-label">
                Recent projects
              </span>
              <span className="project-manage-hint">
                Remove this entry from Fabricator without changing the local folder or any Fabric
                app.
              </span>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm project-manage-action"
              disabled={saving}
              onClick={removeFromRecents}
            >
              Remove from recent projects
            </button>
          </section>

          <section
            className="project-manage-section project-manage-section--danger"
            aria-labelledby="project-removal-title"
          >
            <div className="project-manage-section-heading">
              <span id="project-removal-title" className="project-manage-label">
                Remove project
              </span>
              <span className="project-manage-hint">
                {hasDeploy
                  ? "Review two independent removal options in the next step: move this local folder to your system trash, and optionally permanently delete this project's deployed Fabric app and data. Your Fabric workspace is never deleted."
                  : 'Move this local folder to your system trash in the next step. You can restore it there; no Fabric app will be changed.'}
              </span>
            </div>
            <button
              type="button"
              className="btn btn--danger btn--sm project-manage-action"
              disabled={saving}
              onClick={moveToTrash}
            >
              Review removal options...
            </button>
          </section>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn--ghost" disabled={saving} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
