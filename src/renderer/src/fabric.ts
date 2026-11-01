import type { DeployResult, StudioProject, UnsupportedWorkspace } from '@shared/ipc'

/**
 * Fabric's region-availability page, which lists where Fabric apps are
 * available. Fabricator points people to it but never decides anything from it:
 * which regions have Fabric apps changes, so what Fabric answers when an app is
 * published is what counts.
 */
export const REGION_AVAILABILITY_URL =
  'https://learn.microsoft.com/fabric/admin/region-availability'

/** "UK South", "uksouth" and "uk-south" name the same region. */
function regionKey(region?: string): string {
  return (region ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function sameText(a?: string, b?: string): boolean {
  return Boolean(a?.trim() && b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase())
}

/** A workspace Fabric turned down an app in, and how another workspace relates to it. */
export interface Refusal {
  refused: UnsupportedWorkspace
  /** The workspace itself, another on its capacity, or another in its region. */
  by: 'workspace' | 'capacity' | 'region'
}

/**
 * Whether Fabric turned down an app in this workspace, or in one on its
 * capacity or in its region, going by Fabric's own answers (`refused`), not by
 * a list of regions.
 */
export function refusalFor(
  workspace: { id: string; displayName?: string; capacityId?: string; region?: string },
  refused: readonly UnsupportedWorkspace[]
): Refusal | undefined {
  const own = refused.find(
    (r) => sameText(r.id, workspace.id) || sameText(r.id, workspace.displayName)
  )
  if (own) return { refused: own, by: 'workspace' }
  const capacity = refused.find((r) => sameText(r.capacityId, workspace.capacityId))
  if (capacity) return { refused: capacity, by: 'capacity' }
  const key = regionKey(workspace.region)
  const region = key ? refused.find((r) => regionKey(r.region) === key) : undefined
  return region ? { refused: region, by: 'region' } : undefined
}

/** The regions Fabric turned apps down in, once each, as Fabric names them. */
export function refusedRegions(refused: readonly UnsupportedWorkspace[]): string[] {
  const regions = new Map<string, string>()
  for (const r of refused) {
    const key = regionKey(r.region)
    if (key && !regions.has(key)) regions.set(key, (r.region ?? '').trim())
  }
  return [...regions.values()]
}

/**
 * The workspaces Fabric turned apps down in, once a publish to `target` ended
 * with `result`: Fabric turning it down adds the workspace (once), and a
 * workspace that took the app after all is dropped.
 */
export function refusedAfterPublish(
  refused: readonly UnsupportedWorkspace[],
  result: DeployResult,
  target?: string
): readonly UnsupportedWorkspace[] {
  const turnedDown =
    !result.ok && result.outcome === 'workspace-unsupported' ? result.unsupported : undefined
  if (turnedDown?.id) return [...refused.filter((r) => !sameText(r.id, turnedDown.id)), turnedDown]
  if (result.ok && refused.some((r) => sameText(r.id, target))) {
    return refused.filter((r) => !sameText(r.id, target))
  }
  return refused
}

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
