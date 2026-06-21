import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, type RayfinStudioApi } from '../shared/ipc'

const api: RayfinStudioApi = {
  ping: () => ipcRenderer.invoke(IpcChannels.ping),
  getVersions: () => ipcRenderer.invoke(IpcChannels.getVersions)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose preload API:', error)
  }
} else {
  // Fallback when context isolation is disabled (not expected in production).
  // @ts-ignore - window is augmented in index.d.ts
  window.api = api
}
