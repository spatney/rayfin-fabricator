import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IpcChannels,
  type ProcLogEvent,
  type RayfinStudioApi,
  type ToolId
} from '../shared/ipc'

const api: RayfinStudioApi = {
  ping: () => ipcRenderer.invoke(IpcChannels.ping),
  getVersions: () => ipcRenderer.invoke(IpcChannels.getVersions),

  doctor: {
    check: () => ipcRenderer.invoke(IpcChannels.doctorCheck),
    install: (id: ToolId) => ipcRenderer.invoke(IpcChannels.doctorInstall, id)
  },

  auth: {
    status: () => ipcRenderer.invoke(IpcChannels.authStatus),
    loginCopilot: () => ipcRenderer.invoke(IpcChannels.authLoginCopilot),
    loginRayfin: (tenant?: string) => ipcRenderer.invoke(IpcChannels.authLoginRayfin, tenant),
    logoutRayfin: () => ipcRenderer.invoke(IpcChannels.authLogoutRayfin)
  },

  onProcLog: (cb: (event: ProcLogEvent) => void) => {
    const listener = (_e: IpcRendererEvent, payload: ProcLogEvent): void => cb(payload)
    ipcRenderer.on(IpcChannels.procLog, listener)
    return () => ipcRenderer.removeListener(IpcChannels.procLog, listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose preload API:', error)
  }
} else {
  // Fallback when context isolation is disabled (not expected in production).
  ;(globalThis as unknown as { api: RayfinStudioApi }).api = api
}
