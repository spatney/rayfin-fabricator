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

export const IpcChannels = {
  ping: 'app:ping',
  getVersions: 'app:getVersions'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/** The API surface exposed to the renderer via the preload contextBridge. */
export interface RayfinStudioApi {
  /** Simple liveness check that round-trips through the main process. */
  ping: () => Promise<string>
  /** Runtime versions for diagnostics / about screens. */
  getVersions: () => Promise<AppVersions>
}
