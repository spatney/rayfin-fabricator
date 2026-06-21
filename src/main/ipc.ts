import { ipcMain, app, type IpcMainInvokeEvent } from 'electron'
import { IpcChannels, type AppVersions, type ProcStreamId, type ToolId } from '../shared/ipc'
import { checkEnvironment, installTool } from './services/doctor'
import { getAuthStatus, loginCopilot, loginRayfin, logoutRayfin } from './services/auth'

/** Build an onData callback that streams process output to the calling renderer. */
function streamer(event: IpcMainInvokeEvent, channel: ProcStreamId) {
  return (stream: 'stdout' | 'stderr', data: string): void => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(IpcChannels.procLog, { channel, stream, data })
    }
  }
}

/**
 * Register all IPC handlers. Feature modules added in later phases (projects,
 * chat, deploy, preview) should extend this with their own handlers.
 */
export function registerIpc(): void {
  ipcMain.handle(IpcChannels.ping, () => 'pong')

  ipcMain.handle(
    IpcChannels.getVersions,
    (): AppVersions => ({
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8
    })
  )

  // Environment doctor
  ipcMain.handle(IpcChannels.doctorCheck, () => checkEnvironment())
  ipcMain.handle(IpcChannels.doctorInstall, (event, id: ToolId) => {
    const channel: ProcStreamId = id === 'copilot' ? 'install:copilot' : 'install:rayfin'
    return installTool(id, streamer(event, channel))
  })

  // Authentication
  ipcMain.handle(IpcChannels.authStatus, () => getAuthStatus())
  ipcMain.handle(IpcChannels.authLoginCopilot, (event) =>
    loginCopilot(streamer(event, 'login:copilot'))
  )
  ipcMain.handle(IpcChannels.authLoginRayfin, (event, tenant?: string) =>
    loginRayfin(tenant, streamer(event, 'login:rayfin'))
  )
  ipcMain.handle(IpcChannels.authLogoutRayfin, (event) =>
    logoutRayfin(streamer(event, 'logout:rayfin'))
  )
}
