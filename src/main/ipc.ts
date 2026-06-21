import { ipcMain, app, shell, type IpcMainInvokeEvent } from 'electron'
import {
  IpcChannels,
  MAIN_THREAD_ID,
  type AppSettings,
  type AppVersions,
  type ChatEvent,
  type ChatMessage,
  type ChatOptions,
  type CreateProjectInput,
  type CreateThreadInput,
  type ProcStreamId,
  type ToolId
} from '../shared/ipc'
import { checkEnvironment, installTool } from './services/doctor'
import { getAuthStatus, loginCopilot, loginRayfin, logoutRayfin } from './services/auth'
import { listFabricWorkspaces, deleteFabricApps } from './services/fabric'
import {
  createProject,
  getProjectsState,
  gitCommit,
  gitStatus,
  listCommunityTemplates,
  listTemplates,
  openProject,
  pickFolder,
  removeProject,
  renameProject,
  setActive,
  setProjectWorkspace,
  setWorkspaceRoot
} from './services/projects'
import { getSettings, getState, setSettings } from './services/store'
import { cancelMessage, resetSession, sendMessage, setChatOptions } from './services/chat'
import { loadHistory, saveHistory, clearHistory } from './services/history'
import {
  createThread,
  listThreads,
  removeAllThreads,
  removeThread
} from './services/threads'
import { mergeThread } from './services/merge'
import {
  getDeployStatus,
  hasPendingChanges,
  listDeployments,
  runDeploy,
  setDeploymentName,
  switchDeployment
} from './services/deploy'
import { listProjectFiles, readProjectFile } from './services/files'
import { gitChanges, gitFileDiff, gitLog, revertTo } from './services/git'
import { getProjectRayfinVersion } from './services/rayfinVersion'
import { listSkills, setSkill } from './services/skills'
import { openLogs } from './services/crashlog'
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
  ipcMain.handle(IpcChannels.openLogs, () => openLogs())

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

  // Fabric account (workspace enumeration for the picker)
  ipcMain.handle(IpcChannels.fabricWorkspaces, () => listFabricWorkspaces())
  ipcMain.handle(IpcChannels.fabricDeleteApps, (_event, projectId: string) =>
    deleteFabricApps(projectId)
  )

  // Projects
  ipcMain.handle(IpcChannels.projectsState, () => getProjectsState())
  ipcMain.handle(IpcChannels.projectsTemplates, () => listTemplates())
  ipcMain.handle(IpcChannels.projectsCommunityTemplates, (_event, repoUrl?: string) =>
    listCommunityTemplates(repoUrl)
  )
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
  ipcMain.handle(
    IpcChannels.projectsSetWorkspace,
    (_event, id: string, workspace?: string, workspaceName?: string) =>
      setProjectWorkspace(id, workspace, workspaceName)
  )
  ipcMain.handle(IpcChannels.projectsRemove, (_event, id: string, deleteFiles?: boolean) => {
    cancelMessage(id)
    clearHistory(id)
    return removeAllThreads(id).then(() => removeProject(id, deleteFiles ?? false))
  })
  ipcMain.handle(IpcChannels.projectsGitStatus, (_event, id: string) => gitStatus(id))
  ipcMain.handle(IpcChannels.projectsGitCommit, (_event, id: string, message: string) =>
    gitCommit(id, message)
  )
  ipcMain.handle(IpcChannels.projectsGitLog, (_event, id: string) => gitLog(id))
  ipcMain.handle(IpcChannels.projectsGitChanges, (_event, id: string, ref: string) =>
    gitChanges(id, ref)
  )
  ipcMain.handle(
    IpcChannels.projectsGitFileDiff,
    (_event, id: string, ref: string, path: string, oldPath?: string) =>
      gitFileDiff(id, ref, path, oldPath)
  )
  ipcMain.handle(IpcChannels.projectsGitRevert, (_event, id: string, ref: string) =>
    revertTo(id, ref)
  )
  ipcMain.handle(IpcChannels.projectsFilesTree, (_event, id: string) => listProjectFiles(id))
  ipcMain.handle(IpcChannels.projectsFilesRead, (_event, id: string, path: string) =>
    readProjectFile(id, path)
  )

  // Local Rayfin CLI / SDK version + upgrade availability
  ipcMain.handle(IpcChannels.rayfinVersions, (_event, id: string) => getProjectRayfinVersion(id))

  // Project skills (curated agent-guidance modules inlined into copilot-instructions.md)
  ipcMain.handle(IpcChannels.skillsList, (_event, id: string) => listSkills(id))
  ipcMain.handle(IpcChannels.skillsSet, (_event, id: string, skillId: string, active: boolean) =>
    setSkill(id, skillId, active)
  )

  // Chat (Copilot CLI)
  ipcMain.handle(
    IpcChannels.chatSend,
    (
      event,
      projectId: string,
      turnId: string,
      text: string,
      attachments?: string[],
      threadId?: string
    ) => {
      const thread = threadId ?? MAIN_THREAD_ID
      const emit = (chatEvent: ChatEvent): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IpcChannels.chatEvent, {
            projectId,
            threadId: thread,
            turnId,
            event: chatEvent
          })
        }
      }
      return sendMessage(projectId, thread, text, emit, attachments ?? [])
    }
  )
  ipcMain.handle(IpcChannels.chatCancel, (_event, projectId: string, threadId?: string) =>
    cancelMessage(projectId, threadId ?? MAIN_THREAD_ID)
  )
  ipcMain.handle(IpcChannels.chatReset, (_event, projectId: string, threadId?: string) =>
    resetSession(projectId, threadId ?? MAIN_THREAD_ID)
  )
  ipcMain.handle(IpcChannels.chatHistory, (_event, projectId: string, threadId?: string) =>
    loadHistory(projectId, threadId ?? MAIN_THREAD_ID)
  )
  ipcMain.handle(
    IpcChannels.chatSaveHistory,
    (_event, projectId: string, messages: ChatMessage[], threadId?: string) => {
      saveHistory(projectId, Array.isArray(messages) ? messages : [], threadId ?? MAIN_THREAD_ID)
    }
  )
  ipcMain.handle(IpcChannels.chatSetOptions, (_event, projectId: string, options: ChatOptions) =>
    setChatOptions(projectId, options ?? {})
  )

  // Experimental side threads (parallel forks)
  ipcMain.handle(IpcChannels.threadsList, (_event, projectId: string) => listThreads(projectId))
  ipcMain.handle(IpcChannels.threadsCreate, (_event, input: CreateThreadInput) =>
    createThread(input)
  )
  ipcMain.handle(IpcChannels.threadsRemove, (_event, projectId: string, threadId: string) =>
    removeThread(projectId, threadId)
  )
  ipcMain.handle(IpcChannels.threadsMerge, (event, projectId: string, threadId: string) => {
    // Conflict-resolution progress streams into the project's MAIN thread chat.
    const emit = (chatEvent: ChatEvent): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannels.chatEvent, {
          projectId,
          threadId: MAIN_THREAD_ID,
          turnId: `merge-${threadId}`,
          event: chatEvent
        })
      }
    }
    return mergeThread(projectId, threadId, emit)
  })

  // Preview screenshots (region capture → temp PNG → chat attachment)
  ipcMain.handle(IpcChannels.screenshotSave, (_event, dataUrl: string) => saveScreenshot(dataUrl))
  ipcMain.handle(IpcChannels.screenshotCleanup, (_event, paths: string[]) =>
    cleanupScreenshots(Array.isArray(paths) ? paths : [])
  )

  // Deploy loop (Studio-owned `rayfin up`)
  ipcMain.handle(IpcChannels.deployRun, (event, projectId: string, workspace?: string, force?: boolean) =>
    runDeploy(projectId, streamer(event, 'deploy:run'), workspace, force)
  )
  ipcMain.handle(IpcChannels.deployList, (_event, projectId: string) =>
    listDeployments(projectId)
  )
  ipcMain.handle(
    IpcChannels.deploySwitch,
    (_event, projectId: string, workspace: string, byId?: boolean) =>
      switchDeployment(projectId, workspace, byId)
  )
  ipcMain.handle(
    IpcChannels.deploySetName,
    (_event, projectId: string, workspaceKey: string, name: string) =>
      setDeploymentName(projectId, workspaceKey, name)
  )
  ipcMain.handle(IpcChannels.deployStatus, (_event, projectId: string) =>
    getDeployStatus(projectId)
  )
  ipcMain.handle(IpcChannels.deployHasChanges, (_event, projectId: string) =>
    hasPendingChanges(projectId)
  )

  // App settings (theme, telemetry opt-in)
  ipcMain.handle(IpcChannels.settingsGet, () => getSettings())
  ipcMain.handle(IpcChannels.settingsSet, (_event, patch: Partial<AppSettings>) =>
    setSettings(patch)
  )
}
