import {
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type JSX
} from 'react'
import type { StudioProject, TeamWorkspace } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { hueOf } from './team/map/parts'

interface Props {
  project: StudioProject
  /** Return an error message to keep the dialog open, or null after a successful rename. */
  onRename: (project: StudioProject, name: string) => Promise<string | null>
  onRemoveFromList: (project: StudioProject) => void
  /** Open Remove project, which asks what to remove. */
  onReviewRemoval: (project: StudioProject) => void
  onClose: () => void
  /** Team workspaces this project can move into (experimental). */
  teamWorkspaces?: TeamWorkspace[]
  /** Copy the project into a team workspace; returns an error message, or null when done. */
  onMoveToTeam?: (project: StudioProject, workspaceId: string) => Promise<string | null>
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Could not rename the project. Please try again.'
}

/** One thing you can do with the project: an icon, what it does, and its control. */
function Action({
  icon,
  title,
  children,
  control,
  danger
}: {
  icon: string
  title: string
  children: ReactNode
  control?: ReactNode
  danger?: boolean
}): JSX.Element {
  return (
    <div className={`project-action${danger ? ' project-action--danger' : ''}`}>
      <span className={`project-action-icon codicon codicon-${icon}`} aria-hidden="true" />
      <div className="project-action-text">
        <span className="project-action-title">{title}</span>
        {children}
      </div>
      {control}
    </div>
  )
}

/** The project's name, then what you can do with it: hide it from recents, or remove it. */
export default function ManageProjectModal({
  project,
  onRename,
  onRemoveFromList,
  onReviewRemoval,
  onClose,
  teamWorkspaces,
  onMoveToTeam
}: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const nameId = useId()
  const nameHintId = useId()
  const actionsId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const [name, setName] = useState(project.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const moveTargets = (teamWorkspaces ?? []).filter((w) => !w.setup || w.setup.done)
  const [moveTarget, setMoveTarget] = useState(moveTargets[0]?.id ?? '')
  const [moveError, setMoveError] = useState<string | null>(null)
  const teamName = project.team
    ? (teamWorkspaces ?? []).find((w) => w.id === project.team?.workspaceId)?.name
    : undefined
  const hasDeploy = Boolean(project.lastDeploy?.url)
  const trimmedName = name.trim()
  const canSave = Boolean(trimmedName) && trimmedName !== project.name && !saving

  async function moveToTeam(): Promise<void> {
    if (!onMoveToTeam || !moveTarget) return
    setSaving(true)
    setMoveError(null)
    try {
      const nextError = await onMoveToTeam(project, moveTarget)
      if (nextError) {
        setMoveError(nextError)
        return
      }
      onClose()
    } catch (reason) {
      setMoveError(reason instanceof Error ? reason.message : 'Could not move the project.')
    } finally {
      setSaving(false)
    }
  }

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

  function reviewRemoval(): void {
    onClose()
    onReviewRemoval(project)
  }

  const recentsHint = project.team
    ? 'Hide from your recent list. Your work on GitHub stays, and you can open it again from its team workspace.'
    : project.missing
      ? 'Fabricator can’t find this project on this computer. Remove it from your recent list.'
      : hasDeploy
        ? 'Hide from your recent list. Files and the Fabric app stay intact.'
        : 'Hide from your recent list. Files stay intact.'
  const canMove = !project.team && onMoveToTeam && moveTargets.length > 0

  return (
    <div className="modal-backdrop" onClick={saving ? undefined : onClose}>
      <div
        className="modal project-manage-modal"
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
            className="icon-btn"
            aria-label="Close project management"
            disabled={saving}
            onClick={onClose}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body project-manage-body">
          <div className="project-manage-summary">
            <span
              className="home-project-mark project-manage-mark"
              aria-hidden="true"
              style={{ '--hue': hueOf(project.name) } as CSSProperties}
            >
              {project.name.trim()[0]?.toUpperCase() ?? '?'}
            </span>
            <span className="project-manage-summary-text">
              <strong>{project.name}</strong>
              <span className="project-manage-path" title={project.path}>
                <span className="codicon codicon-folder" aria-hidden="true" />
                <span className="project-manage-path-text">{project.path}</span>
              </span>
            </span>
          </div>

          <form className="project-manage-name" onSubmit={(event) => void saveName(event)}>
            <label className="project-manage-label" htmlFor={nameId}>
              Project name
            </label>
            <div className="project-manage-field">
              <input
                id={nameId}
                className="project-manage-input"
                value={name}
                autoFocus
                spellCheck={false}
                aria-describedby={nameHintId}
                onChange={(event) => {
                  setName(event.target.value)
                  setError(null)
                }}
              />
              <button
                type="submit"
                className={`btn${canSave ? ' btn--primary' : ''}`}
                disabled={!canSave}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            <span className="project-manage-hint" id={nameHintId}>
              Also renames it in <code>rayfin/rayfin.yml</code>.
            </span>
            {error && (
              <p className="project-manage-error" role="alert">
                {error}
              </p>
            )}
          </form>

          <section className="project-manage-actions" aria-labelledby={actionsId}>
            <h3 className="project-manage-heading" id={actionsId}>
              Project actions
            </h3>

            {canMove && (
              <Action icon="organization" title="Move to a team workspace">
                <span className="project-action-desc">
                  Copies this app and its chat into the team workspace so your team can work on it.
                  The team pipeline deploys it as a new app, without the data in this project&apos;s
                  published app. This local project stays as it is.
                </span>
                <div className="project-manage-field">
                  <select
                    className="project-manage-input"
                    aria-label="Team workspace"
                    value={moveTarget}
                    disabled={saving}
                    onChange={(event) => setMoveTarget(event.target.value)}
                  >
                    {moveTargets.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn"
                    disabled={saving || !moveTarget}
                    onClick={() => void moveToTeam()}
                  >
                    {saving ? 'Moving…' : 'Move'}
                  </button>
                </div>
                {moveError && (
                  <p className="project-manage-error" role="alert">
                    {moveError}
                  </p>
                )}
              </Action>
            )}

            <Action
              icon="history"
              title="Recent projects"
              control={
                <button
                  type="button"
                  className="btn"
                  aria-label="Remove from recent projects"
                  disabled={saving}
                  onClick={removeFromRecents}
                >
                  Remove
                </button>
              }
            >
              <span className="project-action-desc">{recentsHint}</span>
            </Action>

            {project.team ? (
              <Action icon="organization" title="Team app">
                <span className="project-action-desc">
                  This app belongs to the team workspace{' '}
                  {teamName ? <strong>{teamName}</strong> : 'it was opened from'}. Its owners can
                  remove it for everyone from the workspace&apos;s settings.
                </span>
              </Action>
            ) : project.missing ? null : (
              <Action
                icon="trash"
                title="Remove project"
                danger
                control={
                  <button
                    type="button"
                    className="btn project-manage-danger"
                    disabled={saving}
                    onClick={reviewRemoval}
                  >
                    Review options
                    <span className="codicon codicon-chevron-right" aria-hidden="true" />
                  </button>
                }
              >
                <span className="project-action-desc">
                  {hasDeploy
                    ? 'Move the folder to your system trash, and choose whether to delete the published app too.'
                    : 'Move the folder to your system trash. No Fabric app is changed.'}
                </span>
              </Action>
            )}
          </section>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
