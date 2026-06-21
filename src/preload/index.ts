import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IpcChannels,
  type AppSettings,
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
  openLogs: () => ipcRenderer.invoke(IpcChannels.openLogs),

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

  fabric: {
    listWorkspaces: () => ipcRenderer.invoke(IpcChannels.fabricWorkspaces),
    deleteApps: (projectId: string) => ipcRenderer.invoke(IpcChannels.fabricDeleteApps, projectId)
  },

  projects: {
    state: () => ipcRenderer.invoke(IpcChannels.projectsState),
    templates: () => ipcRenderer.invoke(IpcChannels.projectsTemplates),
    communityTemplates: (repoUrl?: string) =>
      ipcRenderer.invoke(IpcChannels.projectsCommunityTemplates, repoUrl),
    pickFolder: () => ipcRenderer.invoke(IpcChannels.projectsPickFolder),
    pickWorkspaceRoot: () => ipcRenderer.invoke(IpcChannels.projectsPickWorkspaceRoot),
    setWorkspaceRoot: (path: string) =>
      ipcRenderer.invoke(IpcChannels.projectsSetWorkspaceRoot, path),
    create: (input: CreateProjectInput) => ipcRenderer.invoke(IpcChannels.projectsCreate, input),
    open: (path: string) => ipcRenderer.invoke(IpcChannels.projectsOpen, path),
    setActive: (id: string | null) => ipcRenderer.invoke(IpcChannels.projectsSetActive, id),
    rename: (id: string, name: string) =>
      ipcRenderer.invoke(IpcChannels.projectsRename, id, name),
    setWorkspace: (id: string, workspace?: string, workspaceName?: string) =>
      ipcRenderer.invoke(IpcChannels.projectsSetWorkspace, id, workspace, workspaceName),
    remove: (id: string, deleteFiles?: boolean) =>
      ipcRenderer.invoke(IpcChannels.projectsRemove, id, deleteFiles),
    git: {
      status: (id: string) => ipcRenderer.invoke(IpcChannels.projectsGitStatus, id),
      commit: (id: string, message: string) =>
        ipcRenderer.invoke(IpcChannels.projectsGitCommit, id, message),
      log: (id: string) => ipcRenderer.invoke(IpcChannels.projectsGitLog, id),
      changes: (id: string, ref: string) =>
        ipcRenderer.invoke(IpcChannels.projectsGitChanges, id, ref),
      fileDiff: (id: string, ref: string, path: string, oldPath?: string) =>
        ipcRenderer.invoke(IpcChannels.projectsGitFileDiff, id, ref, path, oldPath),
      revert: (id: string, ref: string) =>
        ipcRenderer.invoke(IpcChannels.projectsGitRevert, id, ref)
    },
    files: {
      tree: (id: string) => ipcRenderer.invoke(IpcChannels.projectsFilesTree, id),
      read: (id: string, path: string) =>
        ipcRenderer.invoke(IpcChannels.projectsFilesRead, id, path)
    }
  },

  rayfin: {
    versions: (id: string) => ipcRenderer.invoke(IpcChannels.rayfinVersions, id)
  },

  skills: {
    list: (id: string) => ipcRenderer.invoke(IpcChannels.skillsList, id),
    set: (id: string, skillId: string, active: boolean) =>
      ipcRenderer.invoke(IpcChannels.skillsSet, id, skillId, active)
  },

  chat: {
    send: (
      projectId: string,
      turnId: string,
      text: string,
      attachments?: string[],
      threadId?: string
    ) => ipcRenderer.invoke(IpcChannels.chatSend, projectId, turnId, text, attachments, threadId),
    cancel: (projectId: string, threadId?: string) =>
      ipcRenderer.invoke(IpcChannels.chatCancel, projectId, threadId),
    reset: (projectId: string, threadId?: string) =>
      ipcRenderer.invoke(IpcChannels.chatReset, projectId, threadId),
    history: (projectId: string, threadId?: string) =>
      ipcRenderer.invoke(IpcChannels.chatHistory, projectId, threadId),
    saveHistory: (projectId: string, messages, threadId?: string) =>
      ipcRenderer.invoke(IpcChannels.chatSaveHistory, projectId, messages, threadId),
    setOptions: (projectId: string, options) =>
      ipcRenderer.invoke(IpcChannels.chatSetOptions, projectId, options)
  },

  threads: {
    list: (projectId: string) => ipcRenderer.invoke(IpcChannels.threadsList, projectId),
    create: (input) => ipcRenderer.invoke(IpcChannels.threadsCreate, input),
    remove: (projectId: string, threadId: string) =>
      ipcRenderer.invoke(IpcChannels.threadsRemove, projectId, threadId),
    merge: (projectId: string, threadId: string) =>
      ipcRenderer.invoke(IpcChannels.threadsMerge, projectId, threadId)
  },

  screenshot: {
    save: (dataUrl: string) => ipcRenderer.invoke(IpcChannels.screenshotSave, dataUrl),
    cleanup: (paths: string[]) => ipcRenderer.invoke(IpcChannels.screenshotCleanup, paths)
  },

  deploy: {
    run: (projectId: string, workspace?: string, force?: boolean) =>
      ipcRenderer.invoke(IpcChannels.deployRun, projectId, workspace, force),
    list: (projectId: string) => ipcRenderer.invoke(IpcChannels.deployList, projectId),
    switch: (projectId: string, workspace: string, byId?: boolean) =>
      ipcRenderer.invoke(IpcChannels.deploySwitch, projectId, workspace, byId),
    setName: (projectId: string, workspaceKey: string, name: string) =>
      ipcRenderer.invoke(IpcChannels.deploySetName, projectId, workspaceKey, name),
    status: (projectId: string) => ipcRenderer.invoke(IpcChannels.deployStatus, projectId),
    hasChanges: (projectId: string) => ipcRenderer.invoke(IpcChannels.deployHasChanges, projectId)
  },

  settings: {
    get: () => ipcRenderer.invoke(IpcChannels.settingsGet),
    set: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IpcChannels.settingsSet, patch)
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
