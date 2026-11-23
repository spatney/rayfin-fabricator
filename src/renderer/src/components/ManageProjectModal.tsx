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
import { Trans, translator, useTranslation } from '../i18n'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { initials, markHue } from './gallery/model'

interface Props {
  project: StudioProject
  /** Return an error message to keep the dialog open, or null after a successful rename. */
  onRename: (project: StudioProject, name: string) => Promise<string | null>
  onRemoveFromList: (project: StudioProject) => void
  /** Open Remove project, which asks what to remove. */
  onReviewRemoval: (project: StudioProject) => void
  /** Open Export project, which saves the project as a file for someone else. */
  onExport?: (project: StudioProject) => void
  onClose: () => void
  /** Team workspaces this project can move into (experimental). */
  teamWorkspaces?: TeamWorkspace[]
  /** Copy the project into a team workspace; returns an error message, or null when done. */
  onMoveToTeam?: (project: StudioProject, workspaceId: string) => Promise<string | null>
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : translator('projects')('manage.errors.cantRename')
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
      <span className="project-action-icon" aria-hidden="true">
        <span className={`codicon codicon-${icon}`} />
      </span>
      <div className="project-action-text">
        <span className="project-action-title">{title}</span>
        {children}
      </div>
      {control}
    </div>
  )
}

/** The project's name, then what you can do with it: export it, hide it from recents, or remove it. */
export default function ManageProjectModal({
  project,
  onRename,
  onRemoveFromList,
  onReviewRemoval,
  onExport,
  onClose,
  teamWorkspaces,
  onMoveToTeam
}: Props): JSX.Element {
  const { t } = useTranslation('projects')
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
      setMoveError(reason instanceof Error ? reason.message : t('manage.errors.cantMove'))
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
      setError(t('manage.errors.noName'))
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

  function exportProject(): void {
    onClose()
    onExport?.(project)
  }

  const recentsHint = project.team
    ? t('manage.recents.team')
    : project.missing
      ? t('manage.recents.missing')
      : hasDeploy
        ? t('manage.recents.withApp')
        : t('manage.recents.filesOnly')
  const canMove = !project.team && onMoveToTeam && moveTargets.length > 0
  const canExport = Boolean(onExport) && !project.team && !project.missing

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
          <h2 id={titleId}>{t('manage.title')}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('manage.close')}
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
              style={{ '--hue': markHue(project.name) } as CSSProperties}
            >
              {initials(project.name)}
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
              {t('manage.nameLabel')}
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
                {saving ? t('status.saving') : t('actions.save')}
              </button>
            </div>
            <span className="project-manage-hint" id={nameHintId}>
              <Trans t={t} i18nKey="manage.renameHint" components={{ code: <code /> }} />
            </span>
            {error && (
              <p className="project-manage-error" role="alert">
                {error}
              </p>
            )}
          </form>

          <section className="project-manage-actions" aria-labelledby={actionsId}>
            <h3 className="project-manage-heading" id={actionsId}>
              {t('manage.actionsHeading')}
            </h3>

            {canMove && (
              <Action icon="organization" title={t('manage.move.title')}>
                <span className="project-action-desc">{t('manage.move.desc')}</span>
                <div className="project-manage-field">
                  <select
                    className="project-manage-input"
                    aria-label={t('manage.move.workspaceLabel')}
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
                    {saving ? t('manage.move.moving') : t('manage.move.move')}
                  </button>
                </div>
                {moveError && (
                  <p className="project-manage-error" role="alert">
                    {moveError}
                  </p>
                )}
              </Action>
            )}

            {canExport && (
              <Action
                icon="package"
                title={t('export.title')}
                control={
                  <button
                    type="button"
                    className="btn project-manage-next"
                    disabled={saving}
                    onClick={exportProject}
                  >
                    {t('manage.export.button')}
                    <span className="codicon codicon-chevron-right" aria-hidden="true" />
                  </button>
                }
              >
                <span className="project-action-desc">{t('export.lead.project')}</span>
              </Action>
            )}

            <Action
              icon="history"
              title={t('manage.recents.title')}
              control={
                <button
                  type="button"
                  className="btn"
                  aria-label={t('manage.recents.remove')}
                  disabled={saving}
                  onClick={removeFromRecents}
                >
                  {t('actions.remove')}
                </button>
              }
            >
              <span className="project-action-desc">{recentsHint}</span>
            </Action>

            {project.team ? (
              <Action icon="organization" title={t('manage.team.title')}>
                <span className="project-action-desc">
                  {teamName ? (
                    <Trans
                      t={t}
                      i18nKey="manage.team.desc"
                      values={{ team: teamName }}
                      components={{ strong: <strong /> }}
                    />
                  ) : (
                    t('manage.team.descUnknown')
                  )}
                </span>
              </Action>
            ) : project.missing ? null : (
              <Action
                icon="trash"
                title={t('remove.title')}
                danger
                control={
                  <button
                    type="button"
                    className="btn project-manage-danger"
                    disabled={saving}
                    onClick={reviewRemoval}
                  >
                    {t('manage.remove.review')}
                    <span className="codicon codicon-chevron-right" aria-hidden="true" />
                  </button>
                }
              >
                <span className="project-action-desc">
                  {hasDeploy ? t('manage.remove.withApp') : t('manage.remove.folderOnly')}
                </span>
              </Action>
            )}
          </section>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {t('actions.done')}
          </button>
        </div>
      </div>
    </div>
  )
}
