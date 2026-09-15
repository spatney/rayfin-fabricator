/** Matches a Fabric workspace GUID (the `groups/{id}` segment of a portal URL). */
const WORKSPACE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Build the Fabric portal deep link for a workspace from its GUID, e.g.
 * `https://app.fabric.microsoft.com/groups/{id}/`. The workspace id comes from a
 * deployment's `fabricWorkspaceId` (recorded in the project's deployment file and
 * surfaced as {@link StudioProject.workspace} after reconcile).
 *
 * Returns `undefined` when the id is missing or isn't a GUID — a project's
 * `workspace` may briefly hold a display name before it has been reconciled to
 * the workspace id — so callers can fall back to plain, non-clickable text.
 */
export function fabricWorkspaceUrl(workspaceId?: string): string | undefined {
  const id = workspaceId?.trim()
  if (!id || !WORKSPACE_GUID.test(id)) return undefined
  return `https://app.fabric.microsoft.com/groups/${id}/`
}
