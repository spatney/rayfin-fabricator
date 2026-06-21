import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IpcChannels,
  type ChatEventEnvelope,
  type CreateProjectInput,
  type ProcLogEvent,
  type RayfinStudioApi,
  type ToolId
} from '../shared/ipc'

const api: RayfinStudioApi = {
  ping: () => ipcRenderer.invoke(IpcChannels.ping),
  getVersions: () => ipcRenderer.invoke(IpcChannels.getVersions),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.openExternal, url),

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

  projects: {
    state: () => ipcRenderer.invoke(IpcChannels.projectsState),
    templates: () => ipcRenderer.invoke(IpcChannels.projectsTemplates),
    pickFolder: () => ipcRenderer.invoke(IpcChannels.projectsPickFolder),
    pickWorkspaceRoot: () => ipcRenderer.invoke(IpcChannels.projectsPickWorkspaceRoot),
    setWorkspaceRoot: (path: string) =>
      ipcRenderer.invoke(IpcChannels.projectsSetWorkspaceRoot, path),
    create: (input: CreateProjectInput) => ipcRenderer.invoke(IpcChannels.projectsCreate, input),
    open: (path: string) => ipcRenderer.invoke(IpcChannels.projectsOpen, path),
    setActive: (id: string | null) => ipcRenderer.invoke(IpcChannels.projectsSetActive, id),
    remove: (id: string) => ipcRenderer.invoke(IpcChannels.projectsRemove, id)
  },

  chat: {
    send: (projectId: string, turnId: string, text: string) =>
      ipcRenderer.invoke(IpcChannels.chatSend, projectId, turnId, text),
    cancel: (projectId: string) => ipcRenderer.invoke(IpcChannels.chatCancel, projectId),
    reset: (projectId: string) => ipcRenderer.invoke(IpcChannels.chatReset, projectId)
  },

  deploy: {
    run: (projectId: string) => ipcRenderer.invoke(IpcChannels.deployRun, projectId),
    status: (projectId: string) => ipcRenderer.invoke(IpcChannels.deployStatus, projectId),
    hasChanges: (projectId: string) => ipcRenderer.invoke(IpcChannels.deployHasChanges, projectId)
  },

  onProcLog: (cb: (event: ProcLogEvent) => void) => {
    const listener = (_e: IpcRendererEvent, payload: ProcLogEvent): void => cb(payload)
    ipcRenderer.on(IpcChannels.procLog, listener)
    return () => ipcRenderer.removeListener(IpcChannels.procLog, listener)
  },

  onChatEvent: (cb: (envelope: ChatEventEnvelope) => void) => {
    const listener = (_e: IpcRendererEvent, payload: ChatEventEnvelope): void => cb(payload)
    ipcRenderer.on(IpcChannels.chatEvent, listener)
    return () => ipcRenderer.removeListener(IpcChannels.chatEvent, listener)
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
