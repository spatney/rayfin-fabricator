import type { StudioProject } from '@shared/ipc'
import { Codicon } from './icons'
import { fabricWorkspaceUrl, publishedItem } from '../fabric'
import { useTranslation } from '../i18n'

import type { JSX } from 'react'

/**
 * Footer status-bar item for a published project's Fabric workspace. Shows the
 * workspace name and links out to the published app's item in it, in the Fabric
 * portal, or to the workspace itself (`groups/{id}`) when the item isn't known.
 * Renders nothing when the project has no known workspace yet (never published /
 * not reconciled).
 */
export default function WorkspaceStatus({
  project
}: {
  project: StudioProject
}): JSX.Element | null {
  const { t } = useTranslation('publish')
  const name = project.workspaceName || project.workspace
  if (!name) return null

  const item = publishedItem(project)?.url
  const url = item ?? fabricWorkspaceUrl(project.workspace)
  if (!url) {
    // No GUID to deep-link with yet — show the name as a plain readout.
    return (
      <span className="statusbar-item" title={t('workspaceStatus.title')}>
        {name}
      </span>
    )
  }

  return (
    <button
      className="statusbar-ws"
      onClick={() => void window.api.openExternal(url)}
      title={
        item
          ? t('workspaceStatus.openItem', { name })
          : t('workspaceStatus.openWorkspace', { name })
      }
    >
      <Codicon name="link-external" className="statusbar-ico" />
      <span className="statusbar-ws-name">{name}</span>
    </button>
  )
}
