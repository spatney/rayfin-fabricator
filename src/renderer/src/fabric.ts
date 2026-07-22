import unsupportedRegionsData from './fabric-apps-unsupported-regions.json'

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

/**
 * The official Fabric region-availability matrix — the source of truth for which
 * regions support Fabric Apps. Surfaced in warnings so users can verify the
 * current list, since availability changes over time (and widens at GA).
 */
export const FABRIC_REGION_AVAILABILITY_DOC =
  'https://learn.microsoft.com/fabric/admin/region-availability'

/**
 * Regions where Fabric Apps (preview) is unavailable, loaded from
 * `fabric-apps-unsupported-regions.json` — the single place to update when a
 * region gains or loses support. Compared case-insensitively.
 */
const UNSUPPORTED_FABRIC_APPS_REGIONS = new Set(
  unsupportedRegionsData.unsupportedRegions.map((r) => r.toLowerCase())
)

export type FabricAppsRegionSupport = 'supported' | 'unsupported' | 'unknown'

/**
 * Classify a workspace capacity region for Fabric Apps support. Fail-open: a
 * missing/unknown region returns 'unknown' and never blocks, so a stale list can
 * only ever produce a soft warning — never a wrong hard block.
 */
export function classifyFabricAppsRegion(
  region: string | null | undefined
): FabricAppsRegionSupport {
  if (!region || !region.trim()) return 'unknown'
  return UNSUPPORTED_FABRIC_APPS_REGIONS.has(region.trim().toLowerCase())
    ? 'unsupported'
    : 'supported'
}

/**
 * A user-facing warning when a workspace's region isn't a supported Fabric Apps
 * region, or undefined when supported/unknown. Advises checking the live docs
 * because region availability changes over time.
 */
export function fabricAppsRegionWarning(region: string | null | undefined): string | undefined {
  if (classifyFabricAppsRegion(region) !== 'unsupported') return undefined
  return `The selected workspace is located in ${region}, which is not currently listed as a supported region for Fabric Apps. Region availability changes over time — check the latest supported and unsupported regions in the Fabric documentation before continuing.`
}
