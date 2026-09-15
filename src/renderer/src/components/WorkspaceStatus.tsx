import type { StudioProject } from '@shared/ipc'
import { Codicon } from './icons'
import { fabricWorkspaceUrl } from '../fabric'

/**
 * Footer status-bar item for a deployed project's Fabric workspace. Shows the
 * workspace name and, when the project's workspace id is a GUID, links out to the
 * workspace in the Fabric portal (`groups/{id}`). Renders nothing when the project
 * has no known workspace yet (never deployed / not reconciled).
 */
export default function WorkspaceStatus({
  project
}: {
  project: StudioProject
}): JSX.Element | null {
  const name = project.workspaceName || project.workspace
  if (!name) return null

  const url = fabricWorkspaceUrl(project.workspace)
  if (!url) {
    // No GUID to deep-link with yet — show the name as a plain readout.
    return (
      <span className="statusbar-item" title="Fabric workspace">
        {name}
      </span>
    )
  }

  return (
    <button
      className="statusbar-ws"
      onClick={() => void window.api.openExternal(url)}
      title={`Open workspace “${name}” in the Fabric portal`}
    >
      <Codicon name="link-external" className="statusbar-ws-ico" />
      <span className="statusbar-ws-name">{name}</span>
    </button>
  )
}
