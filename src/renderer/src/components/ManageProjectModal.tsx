import {
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode
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
  onMoveToTrash: (project: StudioProject) => void
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

/** A group of related controls: a quiet heading over a card of rows, as in Settings. */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  const id = useId()
  return (
    <section className="set-section" aria-labelledby={id}>
      <h3 className="set-section-title" id={id}>
        {title}
      </h3>
      <div className="set-card">{children}</div>
    </section>
  )
}

/** Keeps project metadata, recents cleanup, and local-file cleanup visibly separate. */
export default function ManageProjectModal({
  project,
  onRename,
  onRemoveFromList,
  onMoveToTrash,
  onClose,
  teamWorkspaces,
  onMoveToTeam
}: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const nameId = useId()
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

  function moveToTrash(): void {
    onClose()
    onMoveToTrash(project)
  }

  const recentsHint = project.team
    ? 'Remove this entry from Fabricator. Your work saved to GitHub stays, and you can open the app again from its team workspace.'
    : 'Remove this entry from Fabricator without changing the local folder or any Fabric app.'
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
            className="btn btn--sm btn--ghost"
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
              className="home-project-mark"
              aria-hidden="true"
              style={{ '--hue': hueOf(project.name) } as CSSProperties}
            >
              {project.name.trim()[0]?.toUpperCase() ?? '?'}
            </span>
            <span className="project-manage-summary-text">
              <strong>{project.name}</strong>
              <span className="project-manage-path" title={project.path}>
                {project.path}
              </span>
            </span>
          </div>

          <Section title="Project details">
            <form className="set-item" onSubmit={(event) => void saveName(event)}>
              <div className="set-item-text">
                <label className="set-item-title" htmlFor={nameId}>
                  Project name
                </label>
                <span className="set-item-desc">
                  Changing the name also updates <code>rayfin/rayfin.yml</code>.
                </span>
              </div>
              <div className="project-manage-field">
                <input
                  id={nameId}
                  className="project-manage-input"
                  value={name}
                  autoFocus
                  spellCheck={false}
                  onChange={(event) => {
                    setName(event.target.value)
                    setError(null)
                  }}
                />
                <button
                  type="submit"
                  className={`btn btn--sm${canSave ? ' btn--primary' : ''}`}
                  disabled={!canSave}
                >
                  {saving ? 'Saving...' : 'Save name'}
                </button>
              </div>
              {error && (
                <p className="project-manage-error" role="alert">
                  {error}
                </p>
              )}
            </form>
          </Section>

          {canMove && (
            <Section title="Team workspace">
              <div className="set-item">
                <div className="set-item-text">
                  <span className="set-item-title">Move to a team workspace</span>
                  <span className="set-item-desc">
                    Copies this app and its chat into the team workspace so your team can work on
                    it. The team pipeline deploys it as a new app, without the data in this
                    project&apos;s current deployment. This local project stays as it is.
                  </span>
                </div>
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
                    className="btn btn--sm"
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
              </div>
            </Section>
          )}

          <Section title="Remove">
            <div className="set-item">
              <div className="set-item-text">
                <span className="set-item-title">Recent projects</span>
                <span className="set-item-desc">{recentsHint}</span>
              </div>
              <div className="set-item-control">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={saving}
                  onClick={removeFromRecents}
                >
                  Remove from recent projects
                </button>
              </div>
            </div>
            {project.team ? (
              <div className="set-item">
                <div className="set-item-text">
                  <span className="set-item-title">Team app</span>
                  <span className="set-item-desc">
                    This app belongs to the team workspace{' '}
                    {teamName ? <strong>{teamName}</strong> : 'it was opened from'}. Its owners can
                    remove it for everyone from the workspace&apos;s settings.
                  </span>
                </div>
              </div>
            ) : (
              <div className="set-item">
                <div className="set-item-text">
                  <span className="set-item-title">Remove project</span>
                  <span className="set-item-desc">
                    {hasDeploy
                      ? "Review two independent removal options in the next step: move this local folder to your system trash, and optionally delete this project's deployed Fabric app and its data for good. Your Fabric workspace is never deleted."
                      : 'Move this local folder to your system trash in the next step. You can restore it there; no Fabric app will be changed.'}
                  </span>
                </div>
                <div className="set-item-control">
                  <button
                    type="button"
                    className="btn btn--sm project-manage-danger"
                    disabled={saving}
                    onClick={moveToTrash}
                  >
                    Review removal options...
                  </button>
                </div>
              </div>
            )}
          </Section>
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
