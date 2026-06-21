import { ipcMain, app, shell, type IpcMainInvokeEvent } from 'electron'
import {
  IpcChannels,
  type AppVersions,
  type ChatEvent,
  type ChatMessage,
  type ChatOptions,
  type CreateProjectInput,
  type ProcStreamId,
  type ToolId
} from '../shared/ipc'
import { checkEnvironment, installTool } from './services/doctor'
import { getAuthStatus, loginCopilot, loginRayfin, logoutRayfin } from './services/auth'
import {
  createProject,
  getProjectsState,
  gitCommit,
  gitStatus,
  listTemplates,
  openProject,
  pickFolder,
  removeProject,
  renameProject,
  setActive,
  setWorkspaceRoot
} from './services/projects'
import { getState } from './services/store'
import { cancelMessage, resetSession, sendMessage, setChatOptions } from './services/chat'
import { loadHistory, saveHistory, clearHistory } from './services/history'
import { getDeployStatus, hasPendingChanges, runDeploy } from './services/deploy'
import { listProjectFiles, readProjectFile } from './services/files'
import { saveScreenshot, cleanupScreenshots } from './services/screenshot'

/** Build an onData callback that streams process output to the calling renderer. */
function streamer(event: IpcMainInvokeEvent, channel: ProcStreamId) {
  return (stream: 'stdout' | 'stderr' | 'system', data: string): void => {
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

  ipcMain.handle(IpcChannels.openExternal, async (_event, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

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

  // Projects
  ipcMain.handle(IpcChannels.projectsState, () => getProjectsState())
  ipcMain.handle(IpcChannels.projectsTemplates, () => listTemplates())
  ipcMain.handle(IpcChannels.projectsPickFolder, () => pickFolder('Open a Rayfin project'))
  ipcMain.handle(IpcChannels.projectsPickWorkspaceRoot, async () => {
    const picked = await pickFolder('Choose a workspace folder', getState().workspaceRoot)
    return picked ? setWorkspaceRoot(picked) : getProjectsState()
  })
  ipcMain.handle(IpcChannels.projectsSetWorkspaceRoot, (_event, path: string) =>
    setWorkspaceRoot(path)
  )
  ipcMain.handle(IpcChannels.projectsCreate, (event, input: CreateProjectInput) =>
    createProject(input, streamer(event, 'create:project'))
  )
  ipcMain.handle(IpcChannels.projectsOpen, (_event, path: string) => openProject(path))
  ipcMain.handle(IpcChannels.projectsSetActive, (_event, id: string | null) => setActive(id))
  ipcMain.handle(IpcChannels.projectsRename, (_event, id: string, name: string) =>
    renameProject(id, name)
  )
  ipcMain.handle(IpcChannels.projectsRemove, (_event, id: string, deleteFiles?: boolean) => {
    cancelMessage(id)
    clearHistory(id)
    return removeProject(id, deleteFiles ?? false)
  })
  ipcMain.handle(IpcChannels.projectsGitStatus, (_event, id: string) => gitStatus(id))
  ipcMain.handle(IpcChannels.projectsGitCommit, (_event, id: string, message: string) =>
    gitCommit(id, message)
  )
  ipcMain.handle(IpcChannels.projectsFilesTree, (_event, id: string) => listProjectFiles(id))
  ipcMain.handle(IpcChannels.projectsFilesRead, (_event, id: string, path: string) =>
    readProjectFile(id, path)
  )

  // Chat (Copilot CLI)
  ipcMain.handle(
    IpcChannels.chatSend,
    (event, projectId: string, turnId: string, text: string, attachments?: string[]) => {
      const emit = (chatEvent: ChatEvent): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IpcChannels.chatEvent, { projectId, turnId, event: chatEvent })
        }
      }
      return sendMessage(projectId, text, emit, attachments ?? [])
    }
  )
  ipcMain.handle(IpcChannels.chatCancel, (_event, projectId: string) => cancelMessage(projectId))
  ipcMain.handle(IpcChannels.chatReset, (_event, projectId: string) => resetSession(projectId))
  ipcMain.handle(IpcChannels.chatHistory, (_event, projectId: string) => loadHistory(projectId))
  ipcMain.handle(
    IpcChannels.chatSaveHistory,
    (_event, projectId: string, messages: ChatMessage[]) => {
      saveHistory(projectId, Array.isArray(messages) ? messages : [])
    }
  )
  ipcMain.handle(IpcChannels.chatSetOptions, (_event, projectId: string, options: ChatOptions) =>
    setChatOptions(projectId, options ?? {})
  )

  // Preview screenshots (region capture → temp PNG → chat attachment)
  ipcMain.handle(IpcChannels.screenshotSave, (_event, dataUrl: string) => saveScreenshot(dataUrl))
  ipcMain.handle(IpcChannels.screenshotCleanup, (_event, paths: string[]) =>
    cleanupScreenshots(Array.isArray(paths) ? paths : [])
  )

  // Deploy loop (Studio-owned `rayfin up`)
  ipcMain.handle(IpcChannels.deployRun, (event, projectId: string, workspace?: string) =>
    runDeploy(projectId, streamer(event, 'deploy:run'), workspace)
  )
  ipcMain.handle(IpcChannels.deployStatus, (_event, projectId: string) =>
    getDeployStatus(projectId)
  )
  ipcMain.handle(IpcChannels.deployHasChanges, (_event, projectId: string) =>
    hasPendingChanges(projectId)
  )
}
