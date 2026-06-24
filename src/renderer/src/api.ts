/**
 * Renderer-side implementation of {@link RayfinStudioApi}, backed by Tauri.
 *
 * This replaces the Electron `preload` contextBridge. Each method calls a Rust
 * `#[tauri::command]` via `invoke(...)`; the two streaming channels (`proc:log`,
 * `chat:event`) are delivered as Tauri events via `listen(...)`.
 *
 * Tauri convention: command arguments are passed as a JSON object with camelCase
 * keys, which Tauri maps to the Rust command's snake_case parameters.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  IpcChannels,
  type AppSettings,
  type AdvisorEventEnvelope,
  type ChatEventEnvelope,
  type ChatMessage,
  type ChatMode,
  type ChatOptions,
  type CreateProjectInput,
  type CreateThreadInput,
  type PreviewBounds,
  type PreviewNavState,
  type ProcLogEvent,
  type RayfinStudioApi,
  type ToolId,
  type UpdateProgress
} from '@shared/ipc'

/** Subscribe to a Tauri event, returning a synchronous unsubscribe function. */
function subscribe<T>(name: string, cb: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | undefined
  let cancelled = false
  void listen<T>(name, (event) => cb(event.payload)).then((fn) => {
    if (cancelled) fn()
    else unlisten = fn
  })
  return () => {
    cancelled = true
    unlisten?.()
    unlisten = undefined
  }
}

export const api: RayfinStudioApi = {
  ping: () => invoke('ping'),
  getVersions: () => invoke('get_versions'),
  openExternal: (url: string) => invoke('open_external', { url }),
  openLogs: () => invoke('open_logs'),
  openInEditor: (id: string) => invoke('open_in_editor', { id }),
  relaunch: () => invoke('relaunch'),

  updates: {
    check: () => invoke('update_check'),
    download: () => invoke('update_download'),
    install: () => invoke('update_install'),
    onProgress: (cb: (progress: UpdateProgress) => void) =>
      subscribe<UpdateProgress>(IpcChannels.updateProgress, cb)
  },

  doctor: {
    check: () => invoke('doctor_check'),
    install: (id: ToolId) => invoke('doctor_install', { id }),
    installAll: () => invoke('doctor_install_all')
  },

  auth: {
    status: () => invoke('auth_status'),
    loginCopilot: () => invoke('auth_login_copilot'),
    loginRayfin: (tenant?: string) => invoke('auth_login_rayfin', { tenant }),
    logoutRayfin: () => invoke('auth_logout_rayfin')
  },

  fabric: {
    listWorkspaces: () => invoke('fabric_workspaces'),
    deleteApps: (projectId: string) => invoke('fabric_delete_apps', { projectId })
  },

  projects: {
    state: () => invoke('projects_state'),
    templates: () => invoke('projects_templates'),
    communityTemplates: (repoUrl?: string) => invoke('projects_community_templates', { repoUrl }),
    pickFolder: () => invoke('projects_pick_folder'),
    pickWorkspaceRoot: () => invoke('projects_pick_workspace_root'),
    setWorkspaceRoot: (path: string) => invoke('projects_set_workspace_root', { path }),
    create: (input: CreateProjectInput) => invoke('projects_create', { input }),
    open: (path: string) => invoke('projects_open', { path }),
    setActive: (id: string | null) => invoke('projects_set_active', { id }),
    rename: (id: string, name: string) => invoke('projects_rename', { id, name }),
    setWorkspace: (id: string, workspace?: string, workspaceName?: string) =>
      invoke('projects_set_workspace', { id, workspace, workspaceName }),
    remove: (id: string, deleteFiles?: boolean) => invoke('projects_remove', { id, deleteFiles }),
    git: {
      status: (id: string) => invoke('projects_git_status', { id }),
      commit: (id: string, message: string) => invoke('projects_git_commit', { id, message }),
      log: (id: string) => invoke('projects_git_log', { id }),
      changes: (id: string, ref: string) => invoke('projects_git_changes', { id, ref }),
      fileDiff: (id: string, ref: string, path: string, oldPath?: string) =>
        invoke('projects_git_file_diff', { id, ref, path, oldPath }),
      compareChanges: (id: string, base: string, target: string) =>
        invoke('projects_git_compare_changes', { id, base, target }),
      compareFileDiff: (id: string, base: string, target: string, path: string, oldPath?: string) =>
        invoke('projects_git_compare_file_diff', { id, base, target, path, oldPath }),
      fileLog: (id: string, path: string) => invoke('projects_git_file_log', { id, path }),
      revert: (id: string, ref: string) => invoke('projects_git_revert', { id, ref })
    },
    files: {
      tree: (id: string) => invoke('projects_files_tree', { id }),
      read: (id: string, path: string) => invoke('projects_files_read', { id, path })
    }
  },

  rayfin: {
    versions: (id: string) => invoke('rayfin_versions', { id })
  },

  skills: {
    list: (id: string) => invoke('skills_list', { id }),
    set: (id: string, skillId: string, active: boolean) =>
      invoke('skills_set', { id, skillId, active }),
    source: (id: string, skillId: string) => invoke('skills_source', { id, skillId })
  },

  advisor: {
    run: (projectId: string) => invoke('advisor_run', { projectId }),
    cancel: (projectId: string) => invoke('advisor_cancel', { projectId }),
    load: (projectId: string) => invoke('advisor_load', { projectId }),
    onEvent: (cb: (envelope: AdvisorEventEnvelope) => void) =>
      subscribe<AdvisorEventEnvelope>(IpcChannels.advisorEvent, cb)
  },

  chat: {
    send: (
      projectId: string,
      turnId: string,
      text: string,
      attachments?: string[],
      threadId?: string,
      mode?: ChatMode
    ) => invoke('chat_send', { projectId, turnId, text, attachments, threadId, mode }),
    steer: (
      projectId: string,
      text: string,
      attachments?: string[],
      threadId?: string
    ) => invoke('chat_steer', { projectId, text, attachments, threadId }),
    cancel: (projectId: string, threadId?: string) =>
      invoke('chat_cancel', { projectId, threadId }),
    reset: (projectId: string, threadId?: string) => invoke('chat_reset', { projectId, threadId }),
    resolvePlan: (requestId: string, action: string, feedback?: string) =>
      invoke('chat_resolve_plan', { requestId, action, feedback }),
    history: (projectId: string, threadId?: string) =>
      invoke('chat_history', { projectId, threadId }),
    saveHistory: (projectId: string, messages: ChatMessage[], threadId?: string) =>
      invoke('chat_save_history', { projectId, messages, threadId }),
    setOptions: (projectId: string, options: ChatOptions) =>
      invoke('chat_set_options', { projectId, options }),
    listModels: () => invoke('chat_models'),
    suggest: (projectId: string) => invoke('chat_suggest', { projectId }),
    cancelSuggest: (projectId: string) => invoke('chat_suggest_cancel', { projectId })
  },

  threads: {
    list: (projectId: string) => invoke('threads_list', { projectId }),
    create: (input: CreateThreadInput) => invoke('threads_create', { input }),
    remove: (projectId: string, threadId: string) =>
      invoke('threads_remove', { projectId, threadId }),
    merge: (projectId: string, threadId: string) => invoke('threads_merge', { projectId, threadId })
  },

  screenshot: {
    save: (dataUrl: string) => invoke('screenshot_save', { dataUrl }),
    cleanup: (paths: string[]) => invoke('screenshot_cleanup', { paths })
  },

  deploy: {
    run: (projectId: string, workspace?: string, force?: boolean) =>
      invoke('deploy_run', { projectId, workspace, force }),
    list: (projectId: string) => invoke('deploy_list', { projectId }),
    switch: (projectId: string, workspace: string, byId?: boolean) =>
      invoke('deploy_switch', { projectId, workspace, byId }),
    setName: (projectId: string, workspaceKey: string, name: string) =>
      invoke('deploy_set_name', { projectId, workspaceKey, name }),
    status: (projectId: string) => invoke('deploy_status', { projectId }),
    hasChanges: (projectId: string) => invoke('deploy_has_changes', { projectId }),
    reconcile: (projectId: string) => invoke('deploy_reconcile', { projectId })
  },

  settings: {
    get: () => invoke('settings_get'),
    set: (patch: Partial<AppSettings>) => invoke('settings_set', { patch })
  },

  preview: {
    showUrl: (url: string, bounds: PreviewBounds) => invoke('preview_show_url', { url, bounds }),
    navigate: (url: string, bounds: PreviewBounds) => invoke('preview_navigate', { url, bounds }),
    setBounds: (bounds: PreviewBounds) => invoke('preview_set_bounds', { bounds }),
    hide: () => invoke('preview_hide'),
    reload: () => invoke('preview_reload'),
    clearData: () => invoke('preview_clear_data'),
    back: () => invoke('preview_back'),
    forward: () => invoke('preview_forward'),
    capture: () => invoke('preview_capture'),
    onNavState: (cb: (state: PreviewNavState) => void) =>
      subscribe<PreviewNavState>(IpcChannels.previewNav, cb)
  },

  onProcLog: (cb: (event: ProcLogEvent) => void) =>
    subscribe<ProcLogEvent>(IpcChannels.procLog, cb),

  onChatEvent: (cb: (envelope: ChatEventEnvelope) => void) =>
    subscribe<ChatEventEnvelope>(IpcChannels.chatEvent, cb),

  onAdvisorEvent: (cb: (envelope: AdvisorEventEnvelope) => void) =>
    subscribe<AdvisorEventEnvelope>(IpcChannels.advisorEvent, cb)
}

// The renderer talks to the Rust backend exclusively through `window.api`
// (assigned from `api` in `main.tsx`). This global augmentation replaces the
// former Electron `preload` contextBridge type declaration.
declare global {
  interface Window {
    api: RayfinStudioApi
  }
}
