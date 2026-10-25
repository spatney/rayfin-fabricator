import type { StudioProject } from '@shared/ipc'

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

/** A workspace one of your apps uses, and when it last did (ms; 0 when unknown). */
export interface WorkspaceUse {
  /** A workspace id, or briefly its display name (see {@link StudioProject.workspace}). */
  workspace: string
  at: number
}

/**
 * The workspaces your apps use, most recently used first: each app's recorded
 * {@link StudioProject.workspace} (an id, or briefly a display name), timed by
 * `lastDeploy.at`, which a deploy or opening the app updates. Team apps are left
 * out, since their pipeline deploys them.
 */
export function workspaceUses(projects: readonly StudioProject[]): WorkspaceUse[] {
  const latest = new Map<string, WorkspaceUse>()
  for (const p of projects) {
    const workspace = p.workspace?.trim()
    if (!workspace || p.team) continue
    const at = Date.parse(p.lastDeploy?.at ?? '') || 0
    const key = workspace.toLowerCase()
    const seen = latest.get(key)
    if (!seen || at > seen.at) latest.set(key, { workspace, at })
  }
  return [...latest.values()].sort((a, b) => b.at - a.at)
}

/** The workspaces your apps use, most recently used first (see {@link workspaceUses}).
 *  The deploy picker lists these first. */
export function recentWorkspaces(projects: readonly StudioProject[]): string[] {
  return workspaceUses(projects).map((r) => r.workspace)
}
