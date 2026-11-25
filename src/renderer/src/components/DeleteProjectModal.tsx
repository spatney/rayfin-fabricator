import { useEffect, useId, useState, type JSX } from 'react'
import type { StudioProject } from '@shared/ipc'
import { Trans, useTranslation } from '../i18n'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import type { RemovalChoice } from '../projectRemovals'
import { itemTypeLabel } from './supporting/text'

interface Props {
  project: StudioProject
  /** Start removing the project in the background. The dialog closes right away. */
  onConfirm: (project: StudioProject, choice: RemovalChoice) => void
  onClose: () => void
}

/** The supporting items Fabricator created in Fabric for the app, by name, and their workspace. */
interface InFabric {
  names: string[]
  workspace?: string
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
 * trash, and its published Fabric app can be deleted with it, and so can the
 * supporting items Fabricator created for it. The removal runs in the background,
 * so the app stays usable and other projects can go at once.
 */
export default function DeleteProjectModal({ project, onConfirm, onClose }: Props): JSX.Element {
  const { t } = useTranslation('projects')
  useSuppressPreview()
  const titleId = useId()
  const folderId = useId()
  const appId = useId()
  const supportingId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const hasDeploy = Boolean(project.lastDeploy?.url)
  // On whenever there's a published app to delete: opting out is one click.
  const [deleteApp, setDeleteApp] = useState(hasDeploy)
  const removesApp = hasDeploy && deleteApp
  const [inFabric, setInFabric] = useState<InFabric | null>(null)
  // Off until chosen: they aren't part of the app, and other reports may read them.
  const [deleteSupporting, setDeleteSupporting] = useState(false)
  const removesSupporting = Boolean(inFabric) && deleteSupporting

  // What the app's supporting-items folder records as created in Fabric (no Fabric call).
  useEffect(() => {
    const list = window.api?.supportingItems?.list
    if (project.team || !list) return
    let alive = true
    list(project.id).then(
      (view) => {
        // With its type: a lakehouse and the model on it often share a name.
        const names = view.items
          .filter((item) => item.itemId)
          .map((item) => `${item.name} (${itemTypeLabel(item.type)})`)
        if (alive && names.length > 0) setInFabric({ names, workspace: view.workspace?.name })
      },
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [project.id, project.team])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function confirm(): void {
    onConfirm(project, { deleteApp: removesApp, deleteSupporting: removesSupporting })
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
          <h2 id={titleId}>{t('remove.title')}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('actions.close')}
            onClick={onClose}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body remove-body">
          <p className="remove-lead">
            <Trans
              t={t}
              i18nKey="remove.lead"
              values={{ name: project.name }}
              components={{ strong: <strong /> }}
            />
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
                  {t('remove.folder.title')}
                </span>
                <span className="remove-badge">{t('remove.folder.badge')}</span>
              </span>
              <span className="remove-option-desc" id={`${folderId}-desc`}>
                <Trans t={t} i18nKey="remove.folder.desc" components={{ strong: <strong /> }} />
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
                    {t('remove.app.title')}
                  </span>
                  <span className="remove-badge remove-badge--danger">{t('remove.app.badge')}</span>
                </span>
                <span className="remove-option-desc" id={`${appId}-desc`}>
                  {project.workspaceName != null
                    ? t('remove.app.desc', {
                        name: project.name,
                        workspace: project.workspaceName
                      })
                    : t('remove.app.descNoWorkspace', { name: project.name })}
                  <span className="remove-option-warn">{t('remove.app.warn')}</span>
                </span>
              </span>
            </label>
          )}

          {inFabric && (
            <label
              className={`remove-option remove-option--danger${deleteSupporting ? ' remove-option--on' : ''}`}
            >
              <input
                type="checkbox"
                className="remove-option-input"
                checked={deleteSupporting}
                onChange={(event) => setDeleteSupporting(event.target.checked)}
                aria-labelledby={`${supportingId}-title`}
                aria-describedby={`${supportingId}-desc`}
              />
              <span className="remove-check" aria-hidden="true">
                <CheckMark />
              </span>
              <span className="remove-option-text">
                <span className="remove-option-head">
                  <span className="remove-option-title" id={`${supportingId}-title`}>
                    {t('remove.supporting.title')}
                  </span>
                  <span className="remove-badge remove-badge--danger">
                    {t('remove.supporting.badge')}
                  </span>
                </span>
                <span className="remove-option-desc" id={`${supportingId}-desc`}>
                  {inFabric.workspace
                    ? t('remove.supporting.desc', {
                        items: inFabric.names.join(', '),
                        workspace: inFabric.workspace
                      })
                    : t('remove.supporting.descNoWorkspace', { items: inFabric.names.join(', ') })}
                  <span className="remove-option-warn">{t('remove.supporting.warn')}</span>
                </span>
              </span>
            </label>
          )}

          <p className="remove-note">
            <span className="codicon codicon-info" aria-hidden="true" />
            {!hasDeploy
              ? t('remove.note.noApp')
              : removesApp
                ? t('remove.note.keepsWorkspace')
                : t('remove.note.keepsApp')}
          </p>
          {inFabric && !deleteSupporting && (
            <p className="remove-note">
              <span className="codicon codicon-info" aria-hidden="true" />
              {t('remove.note.keepsSupporting')}
            </p>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            {t('actions.cancel')}
          </button>
          <button type="button" className="btn btn--danger" autoFocus onClick={confirm}>
            {removesSupporting
              ? t('remove.confirmFabric')
              : removesApp
                ? t('remove.confirmBoth')
                : t('remove.confirmFolder')}
          </button>
        </div>
      </div>
    </div>
  )
}
