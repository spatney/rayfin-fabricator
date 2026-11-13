/**
 * Local development: apps run on this computer with the bundled local backend
 * (rayfin-local) from the moment they're created, team apps included.
 * Publishing a personal app to Microsoft Fabric is the user's choice; a team
 * app's pipeline publishes it when the user publishes.
 */
import type { AppSettings, RayfinNewerRelease, RayfinVersionInfo } from '@shared/ipc'

/**
 * Whether chat turns publish personal apps as they finish: the published apps
 * panel's "Publish after each chat turn". Off until the user turns it on
 * (`deployMode`): the app runs on this computer, and publishing is the user's
 * choice. The core decides the same way (`store::is_manual_deploy`).
 */
export function publishesAfterTurn(settings: AppSettings | null | undefined): boolean {
  return settings?.deployMode === 'auto'
}

/** The `x.y.z` core of a version, or null. */
function versionCore(version: string | null | undefined): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? '')
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** Whether `version` is a newer release than `than`. */
export function newerRelease(version: string, than: string): boolean {
  const a = versionCore(version)
  const b = versionCore(than)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/**
 * `info` with every package's update going to `target`, or to nothing while
 * it isn't known. Rayfin's packages ship in lockstep, so it's every package's.
 */
export function updatesTo(
  info: RayfinVersionInfo,
  target: string | null | undefined
): RayfinVersionInfo {
  const to = target ?? null
  const packages = info.packages.map((pkg) => ({
    ...pkg,
    latest: to,
    upgradable: Boolean(to && pkg.installed && newerRelease(to, pkg.installed))
  }))
  return {
    ...info,
    latest: to,
    upgradeAvailable: packages.some((pkg) => pkg.upgradable),
    packages
  }
}

/**
 * An app's Rayfin versions as Fabricator offers updates: to the release it
 * recommends (`recommended`), the newest the bundled local backend runs that
 * isn't newer than Rayfin's latest, so the app keeps running on this computer
 * (a team app too). A newer release is offered on its own, with a warning:
 * see {@link newerRayfin}.
 */
export function recommendedUpdates(info: RayfinVersionInfo): RayfinVersionInfo {
  return updatesTo(info, info.recommended)
}

/**
 * The release newer than the recommended one that the app can update to,
 * with a warning ({@link newerRayfinWarnings}); `null` when there's none, or
 * the app is on it or past it.
 */
export function newerRayfin(info: RayfinVersionInfo | null | undefined): RayfinNewerRelease | null {
  const newer = info?.newer
  if (!newer || !info?.version) return null
  return newerRelease(newer.version, info.version) ? newer : null
}

/**
 * Why an update to `newer` needs care, as sentences: it might be unstable
 * while it isn't Rayfin's latest release, and some things might not work on
 * this computer while the local backend doesn't run it.
 */
export function newerRayfinWarnings(newer: RayfinNewerRelease): string[] {
  const warnings: string[] = []
  if (!newer.isLatest) {
    warnings.push('It isn’t Rayfin’s latest release yet, so it might be unstable.')
  }
  if (!newer.runsLocally) {
    warnings.push(
      'Fabricator doesn’t run it on this computer yet, so some things might not work as expected here.'
    )
  }
  return warnings
}
