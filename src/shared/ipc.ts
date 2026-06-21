/**
 * Shared IPC contract between the Electron main process and the renderer.
 *
 * Channel names and the typed surface exposed on `window.api` live here so that
 * both `src/main` (Node) and `src/renderer` (DOM) stay in sync. As new phases add
 * capabilities (env doctor, auth, projects, chat, deploy, preview), extend the
 * `RayfinStudioApi` interface and the `IpcChannels` map together.
 */

export interface AppVersions {
  app: string
  electron: string
  chrome: string
  node: string
  v8: string
}

/* ------------------------------------------------------------------ *
 * Environment doctor
 * ------------------------------------------------------------------ */

export type ToolId = 'node' | 'npm' | 'git' | 'rayfin' | 'copilot'

export interface ToolStatus {
  id: ToolId
  name: string
  found: boolean
  version: string | null
  /** Short human guidance shown when the tool is missing. */
  installHint: string
  /** Docs / download URL for tools the app cannot auto-install. */
  installUrl?: string
  /** True when the app can install this tool itself (global npm package). */
  autoInstallable: boolean
  /** Whether this tool must be present before the app can be used. */
  required: boolean
}

export interface DoctorReport {
  tools: ToolStatus[]
  /** True when every required tool is present. */
  ready: boolean
}

/* ------------------------------------------------------------------ *
 * Authentication
 * ------------------------------------------------------------------ */

export interface CopilotAuthStatus {
  signedIn: boolean
  user?: string
}

export interface RayfinAuthStatus {
  signedIn: boolean
  user?: string
  tenant?: string
}

export interface AuthStatus {
  copilot: CopilotAuthStatus
  rayfin: RayfinAuthStatus
}

/* ------------------------------------------------------------------ *
 * Long-running / streaming processes (logins, installs, deploys)
 * ------------------------------------------------------------------ */

/** Stable identifiers for streamed process output. */
export type ProcStreamId =
  | 'login:copilot'
  | 'login:rayfin'
  | 'logout:rayfin'
  | 'install:rayfin'
  | 'install:copilot'

export interface ProcLogEvent {
  channel: ProcStreamId
  stream: 'stdout' | 'stderr' | 'system'
  data: string
}

export interface ProcResult {
  ok: boolean
  exitCode: number | null
}

/* ------------------------------------------------------------------ *
 * IPC channels
 * ------------------------------------------------------------------ */

export const IpcChannels = {
  ping: 'app:ping',
  getVersions: 'app:getVersions',

  doctorCheck: 'doctor:check',
  doctorInstall: 'doctor:install',

  authStatus: 'auth:status',
  authLoginCopilot: 'auth:loginCopilot',
  authLoginRayfin: 'auth:loginRayfin',
  authLogoutRayfin: 'auth:logoutRayfin',

  // main -> renderer event
  procLog: 'proc:log'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/* ------------------------------------------------------------------ *
 * Renderer-facing API (exposed via preload contextBridge as window.api)
 * ------------------------------------------------------------------ */

export interface RayfinStudioApi {
  ping: () => Promise<string>
  getVersions: () => Promise<AppVersions>

  doctor: {
    check: () => Promise<DoctorReport>
    /** Install an auto-installable tool (currently rayfin / copilot via npm -g). */
    install: (id: ToolId) => Promise<ProcResult>
  }

  auth: {
    status: () => Promise<AuthStatus>
    loginCopilot: () => Promise<ProcResult>
    loginRayfin: (tenant?: string) => Promise<ProcResult>
    logoutRayfin: () => Promise<ProcResult>
  }

  /** Subscribe to streamed process output. Returns an unsubscribe function. */
  onProcLog: (cb: (event: ProcLogEvent) => void) => () => void
}
