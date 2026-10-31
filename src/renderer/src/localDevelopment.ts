/**
 * Local development: personal apps run on this computer with the bundled local
 * backend (rayfin-local) from the moment they're created, and publishing them
 * to Microsoft Fabric is the user's choice. Team apps run on the backend their
 * pipeline publishes.
 */
import type { AppSettings, RayfinVersionInfo } from '@shared/ipc'

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
function newerRelease(version: string, than: string): boolean {
  const a = versionCore(version)
  const b = versionCore(than)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/**
 * A personal app's Rayfin versions: its upgrades stop at the newest release
 * the bundled local backend runs (`latestSupportedLocally`), so the app keeps
 * running on this computer. Rayfin's packages ship in lockstep, so that's every
 * package's target. Nothing is offered while it isn't known.
 */
export function upgradesWithinLocalRange(info: RayfinVersionInfo): RayfinVersionInfo {
  const target = info.latestSupportedLocally ?? null
  const packages = info.packages.map((pkg) => ({
    ...pkg,
    latest: target,
    upgradable: Boolean(target && pkg.installed && newerRelease(target, pkg.installed))
  }))
  return {
    ...info,
    latest: target,
    upgradeAvailable: packages.some((pkg) => pkg.upgradable),
    packages
  }
}
