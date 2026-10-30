import type { AuthProvider, AuthStatus, DoctorReport } from '@shared/ipc'

/** Set once setup has passed on this computer; later launches open straight into the app. */
const SETUP_DONE_KEY = 'fabricator.setupComplete'

export function hasCompletedSetup(): boolean {
  try {
    return localStorage.getItem(SETUP_DONE_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberSetupComplete(): void {
  try {
    localStorage.setItem(SETUP_DONE_KEY, '1')
  } catch (error) {
    console.warn('Could not remember that setup is complete', error)
  }
}

/** Every account unknown while the first checks of a launch run. */
export const CHECKING_AUTH: AuthStatus = {
  copilot: { signedIn: false, checking: true },
  rayfin: { signedIn: false, checking: true },
  az: { signedIn: false, checking: true }
}

/** `result`'s entries for `providers` only. */
export function pickAuth(
  result: Partial<AuthStatus>,
  providers: AuthProvider[]
): Partial<AuthStatus> {
  const out: Partial<AuthStatus> = {}
  for (const provider of providers) {
    const value = result[provider]
    if (value) Object.assign(out, { [provider]: value })
  }
  return out
}

/** `providers` as signed out because their check failed with `error`. */
export function failedAuth(providers: AuthProvider[], error: string): Partial<AuthStatus> {
  const out: Partial<AuthStatus> = {}
  for (const provider of providers) out[provider] = { signedIn: false, error }
  return out
}

/** What a background check found that setup would have caught. */
export interface SetupAttention {
  /** Required tools that are missing, outdated, or failing their check. */
  tools: string[]
  /** Accounts setup requires that aren't signed in, by display name. */
  signIns: string[]
  /** The tool check couldn't run at all. */
  error?: string
}

/**
 * Whether Fabricator can be entered: the required tools work and GitHub Copilot
 * is signed in. Azure is optional; the features that need it ask for it.
 */
export function setupReady(
  doctor: DoctorReport | null | undefined,
  auth: Partial<AuthStatus> | null | undefined
): boolean {
  return Boolean(doctor?.ready && auth?.copilot?.signedIn)
}

/**
 * Problems to raise in the app after a background check, or null. Accounts that
 * are still being checked are never reported as signed out, and optional ones
 * (Azure, Fabric) never are.
 */
export function setupAttention(
  doctor: DoctorReport | null,
  auth: AuthStatus | null,
  toolsError: string | null
): SetupAttention | null {
  const tools = (doctor?.tools ?? []).filter((t) => t.required && !t.satisfied).map((t) => t.name)
  const signIns: string[] = []
  if (auth && !auth.copilot.checking && !auth.copilot.signedIn) signIns.push('GitHub Copilot')
  const error = toolsError ?? undefined
  return tools.length > 0 || signIns.length > 0 || error ? { tools, signIns, error } : null
}

/** "a", "a and b", "a, b, and c". */
export function listText(items: string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/** How far the first-launch checks have got, for Ray to narrate on the splash. */
export type StartupStage = 'tools' | 'accounts' | 'ready' | 'setup' | 'error'

/**
 * Where the startup checks stand: the tools, then the sign-in setup needs, then
 * whether the app opens or setup is next. A check that couldn't run is `error`.
 */
export function startupStage(
  doctor: DoctorReport | null,
  auth: AuthStatus | null,
  failed: boolean
): StartupStage {
  if (failed) return 'error'
  if (!doctor) return 'tools'
  if (!auth || auth.copilot.checking) return 'accounts'
  return setupReady(doctor, auth) ? 'ready' : 'setup'
}
