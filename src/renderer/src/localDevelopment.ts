/**
 * The Local development experiment (Settings → Experiments). With it on,
 * personal apps run on this computer with the bundled local backend
 * (rayfin-local) from the moment they're created, and publishing to Microsoft
 * Fabric is the user's choice. Off, the default, apps are developed against
 * their Fabric deployment: a new app is published before chat unlocks, and the
 * preview shows the published app. Team apps aren't affected either way.
 */
import { createContext, useContext } from 'react'
import type { AppSettings, RayfinVersionInfo, StudioProject, ToolStatus } from '@shared/ipc'

/** The Local development experiment (Settings → Experiments). */
export function localDevelopmentEnabled(settings: AppSettings | null | undefined): boolean {
  return Boolean(settings?.experiments?.localDevelopment)
}

/**
 * Whether chat turns publish personal apps when the user hasn't chosen: while
 * Local development is off, as they always have. With it on, the app runs on
 * this computer, and publishing is the user's choice.
 */
export function publishesAfterTurnByDefault(settings: AppSettings | null | undefined): boolean {
  return !localDevelopmentEnabled(settings)
}

/**
 * Whether chat turns publish personal apps as they finish: the published apps
 * panel's "Publish after each chat turn". The user's choice (`deployMode`)
 * always wins; without one, see {@link publishesAfterTurnByDefault}. The core
 * decides the same way (`store::is_manual_deploy`).
 */
export function publishesAfterTurn(settings: AppSettings | null | undefined): boolean {
  if (settings?.deployMode === 'auto') return true
  if (settings?.deployMode === 'manual') return false
  return publishesAfterTurnByDefault(settings)
}

/**
 * The app waits for its first publish before chat unlocks: created in the app
 * while Local development was off, and never published since. Team apps are
 * published by their pipeline, and with Local development on an app runs on
 * this computer from the start, so neither waits.
 */
export function awaitsFirstPublish(
  project: StudioProject | null | undefined,
  localDevelopment: boolean
): boolean {
  return Boolean(project?.awaitingFirstDeploy && !project.team && !localDevelopment)
}

/** The environment doctor's row for the bundled local backend. */
export const LOCAL_BACKEND_TOOL = 'rayfin-local'

/** The doctor's tools as setup shows them: the local backend only with Local development on. */
export function visibleTools(
  tools: readonly ToolStatus[],
  localDevelopment: boolean
): ToolStatus[] {
  return tools.filter((tool) => localDevelopment || tool.id !== LOCAL_BACKEND_TOOL)
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
 * A personal app's Rayfin versions with Local development on: its upgrades stop
 * at the newest release the bundled local backend runs (`latestSupportedLocally`),
 * so the app keeps running on this computer. Rayfin's packages ship in lockstep,
 * so that's every package's target. Nothing is offered while it isn't known.
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

/**
 * Whether Local development is on, for views the workbench renders through
 * others (such as Code → Secrets). The workbench provides it.
 */
export const LocalDevelopmentContext = createContext(false)

export function useLocalDevelopment(): boolean {
  return useContext(LocalDevelopmentContext)
}
