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
import { serializePreviewMutations } from './previewSurface'
import {
  IpcChannels,
  type AdvisorModelChoice,
  type AppSettings,
  type AuthProvider,
  type AdvisorEventEnvelope,
  type AdvisorFinding,
  type AdvisorRunRequest,
  type AdvisorUiState,
  type ChatEventEnvelope,
  type ChatMessage,
  type ChatMode,
  type ChatOptions,
  type CreateProjectInput,
  type CustomSkillSaveInput,
  type DevStateEvent,
  type HelpEventEnvelope,
  type MigrationInspectedPage,
  type MigrationPage,
  type MigrationSource,
  type MigrationStateEvent,
  type PreviewBounds,
  type PreviewNavState,
  type PreviewAgentEvent,
  type ProcLogEvent,
  type DeleteProgressEvent,
  type DesignVariationsOptions,
  type RayfinStudioApi,
  type ReasoningEffort,
  type TeamCreateRequest,
  type TeamDiagnoseRequest,
  type TeamDiagnosisEnvelope,
  type TeamProgressEvent,
  type TeamResourceRequest,
  type TeamRunner,
  type ToolId,
  type UpdateProgress
} from '@shared/ipc'
import type {
  DesignCommand,
  DesignEnableOptions,
  DesignHostTheme,
  DesignLocateTarget,
  DesignPageOutline,
  DesignRestyleContext,
  DesignVariationEvent
} from '@shared/design'

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

/** A one-off Advisor run's model, as command arguments (blank parts left out). */
function modelChoiceArgs(choice?: AdvisorModelChoice): AdvisorModelChoice {
  return {
    model: choice?.model || undefined,
    effort: choice?.effort || undefined,
    autoTier: choice?.autoTier || undefined,
    contextTier: choice?.contextTier || undefined
  }
}

export const api: RayfinStudioApi = {
  ping: () => invoke('ping'),
  getVersions: () => invoke('get_versions'),
  openExternal: (url: string) => invoke('open_external', { url }),
  openLogs: () => invoke('open_logs'),
  diagnostics: {
    export: () => invoke('diagnostics_export'),
    record: (report) =>
      invoke('diagnostics_record', {
        level: report.level,
        area: report.area,
        event: report.event,
        surface: report.surface,
        message: report.message,
        operation: report.operation,
        detail: report.detail,
        projectId: report.projectId,
        dev: report.dev
      })
  },
  openInEditor: (id: string) => invoke('open_in_editor', { id }),
  relaunch: () => invoke('relaunch'),
  revealWindow: (background?: string) => invoke('window_reveal', { background: background ?? null }),

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
    check: (providers: AuthProvider[]) => invoke('auth_check', { providers }),
    loginCopilot: (host?: string) => invoke('auth_login_copilot', { host }),
    loginRayfin: (tenant?: string, projectId?: string) =>
      invoke('auth_login_rayfin', { tenant, projectId }),
    refreshRayfin: (projectId: string, tenant?: string) =>
      invoke('auth_refresh_rayfin', { projectId, tenant }),
    loginAz: (tenant?: string) => invoke('auth_login_az', { tenant }),
    logoutCopilot: () => invoke('auth_logout_copilot'),
    logoutRayfin: () => invoke('auth_logout_rayfin'),
    logoutAz: () => invoke('auth_logout_az')
  },

  accounts: {
    fabric: () => invoke('fabric_accounts'),
    addFabric: (tenant?: string, projectId?: string) =>
      invoke('fabric_add_account', { tenant, projectId }),
    useFabric: (id: string) => invoke('fabric_use_account', { id }),
    signOutFabric: (id: string, projectId?: string) =>
      invoke('fabric_sign_out_account', { id, projectId }),
    azure: () => invoke('azure_accounts'),
    useAzure: (user: string, subscription: string) =>
      invoke('azure_use_account', { user, subscription }),
    signOutAzure: (user: string) => invoke('azure_sign_out_account', { user })
  },

  github: {
    status: () => invoke('github_status'),
    login: () => invoke('github_login'),
    accounts: () => invoke('github_accounts'),
    addAccount: () => invoke('github_add_account'),
    switchAccount: (login: string) => invoke('github_switch_account', { login }),
    signOutAccount: (login: string) => invoke('github_sign_out_account', { login }),
    listRepos: () => invoke('github_list_repos'),
    clone: (repo: string) => invoke('github_clone', { input: repo })
  },

  fabric: {
    listWorkspaces: () => invoke('fabric_workspaces'),
    listCapacities: () => invoke('fabric_capacities'),
    createWorkspace: (name: string, capacityId: string) =>
      invoke('fabric_create_workspace', { name, capacityId }),
    deleteApps: (projectId: string) => invoke('fabric_delete_apps', { projectId }),
    semanticModelSchema: (workspaceId: string, itemId: string) =>
      invoke('fabric_semantic_model_schema', { workspaceId, itemId }),
    projectSemanticModels: (projectId: string) =>
      invoke('fabric_project_semantic_models', { projectId }),
    shareApp: (projectId: string, workspaceId: string, recipients: string[]) =>
      invoke('fabric_share_app', { projectId, workspaceId, recipients }),
    directorySearch: (query: string) => invoke('fabric_directory_search', { query }),
    listWorkspaceModels: (workspaceId: string) =>
      invoke('fabric_list_workspace_models', { workspaceId }),
    listWorkspaceData: (workspaceId: string) =>
      invoke('fabric_list_workspace_data', { workspaceId }),
    checkDeployTarget: (workspaceId: string) => invoke('fabric_check_deploy_target', { workspaceId })
  },

  migration: {
    workspaces: () => invoke('migration_workspaces'),
    reports: (workspaceId: string) => invoke('migration_reports', { workspaceId }),
    search: (query: string) => invoke('migration_search', { query }),
    inspect: (request: { target?: string; workspaceId?: string; reportId?: string }) =>
      invoke('migration_inspect', {
        target: request.target ?? null,
        workspaceId: request.workspaceId ?? null,
        reportId: request.reportId ?? null
      }),
    start: (projectId: string, source: MigrationSource, pages: MigrationInspectedPage[]) =>
      invoke('migration_start', { projectId, source, pages }),
    state: (projectId: string) => invoke('migration_state', { projectId }),
    resume: (projectId: string) => invoke('migration_resume', { projectId }),
    pdf: (projectId: string, index: number) => invoke('migration_pdf', { projectId, index }),
    savePage: (projectId: string, index: number, png: string, text: string, thumb?: string) =>
      invoke('migration_save_page', { projectId, index, png, text, thumb: thumb ?? null }),
    finishImages: (projectId: string, error?: string) =>
      invoke('migration_finish_images', { projectId, error: error ?? null }),
    setPageStatus: (projectId: string, index: number, status: MigrationPage['status']) =>
      invoke('migration_set_page_status', { projectId, index, status }),
    cancel: (projectId: string) => invoke('migration_cancel', { projectId }),
    dismiss: (projectId: string, dismissed: boolean) => invoke('migration_dismiss', { projectId, dismissed }),
    onState: (cb: (event: MigrationStateEvent) => void) =>
      subscribe<MigrationStateEvent>(IpcChannels.migrationState, cb)
  },

  projects: {
    state: () => invoke('projects_state'),
    communityTemplates: (repoUrl?: string) => invoke('projects_community_templates', { repoUrl }),
    checkName: (name: string, teamWorkspaceId?: string) =>
      invoke('projects_check_name', { name, teamWorkspaceId: teamWorkspaceId ?? null }),
    pickFolder: () => invoke('projects_pick_folder'),
    pickWorkspaceRoot: () => invoke('projects_pick_workspace_root'),
    setWorkspaceRoot: (path: string) => invoke('projects_set_workspace_root', { path }),
    create: (input: CreateProjectInput) => invoke('projects_create', { input }),
    open: (path: string) => invoke('projects_open', { path }),
    ensureDependencies: (id: string) => invoke('projects_prepare_dependencies', { id }),
    setActive: (id: string | null) => invoke('projects_set_active', { id }),
    rename: (id: string, name: string) => invoke('projects_rename', { id, name }),
    setWorkspace: (id: string, workspace?: string, workspaceName?: string) =>
      invoke('projects_set_workspace', { id, workspace, workspaceName }),
    setPreviewMode: (id: string, mode: string) => invoke('projects_set_preview_mode', { id, mode }),
    remove: (id: string, deleteFiles?: boolean) => invoke('projects_remove', { id, deleteFiles }),
    git: {
      status: (id: string) => invoke('projects_git_status', { id }),
      branches: (id: string) => invoke('projects_git_branches', { id }),
      switchBranch: (id: string, refName: string) =>
        invoke('projects_git_switch_branch', { id, refName }),
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
      revert: (id: string, ref: string) => invoke('projects_git_revert', { id, ref }),
      remoteStatus: (id: string) => invoke('projects_git_remote_status', { id }),
      divergence: (id: string) => invoke('projects_git_divergence', { id }),
      pull: (id: string) => invoke('projects_git_pull', { id }),
      push: (id: string) => invoke('projects_git_push', { id })
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

  customSkills: {
    list: () => invoke('custom_skills_list'),
    source: (id: string) => invoke('custom_skills_source', { id }),
    save: (input: CustomSkillSaveInput, projectId: string, toLibrary: boolean) =>
      invoke('custom_skills_save', { projectId, input, toLibrary }),
    pickFolderPreview: () => invoke('custom_skills_pick_folder_preview'),
    pickFilePreview: () => invoke('custom_skills_pick_file_preview'),
    addFromPath: (projectId: string, sourcePath: string, toLibrary: boolean) =>
      invoke('custom_skills_add_from_path', { projectId, sourcePath, toLibrary }),
    promote: (projectId: string, id: string) => invoke('custom_skills_promote', { projectId, id }),
    remove: (id: string) => invoke('custom_skills_remove', { id })
  },

  secrets: {
    list: (projectId: string) => invoke('secrets_list', { projectId }),
    set: (projectId: string, name: string, value: string, description?: string) =>
      invoke('secrets_set', { projectId, name, value, description }),
    remove: (projectId: string, name: string) => invoke('secrets_delete', { projectId, name })
  },

  advisor: {
    collect: (projectId: string) => invoke('advisor_collect', { projectId }),
    run: (projectId: string, request: AdvisorRunRequest) =>
      invoke('advisor_run', { projectId, request }),
    cancel: (projectId: string) => invoke('advisor_cancel', { projectId }),
    load: (projectId: string) => invoke('advisor_load', { projectId }),
    saveState: (projectId: string, state: AdvisorUiState) =>
      invoke('advisor_save_state', { projectId, state }),
    explain: (projectId: string, explainId: string, finding: AdvisorFinding, choice?: AdvisorModelChoice) =>
      invoke('advisor_explain', { projectId, explainId, finding, ...modelChoiceArgs(choice) }),
    explainCancel: (projectId: string) => invoke('advisor_explain_cancel', { projectId }),
    verify: (projectId: string, verifyId: string, findings: AdvisorFinding[], choice?: AdvisorModelChoice) =>
      invoke('advisor_verify', { projectId, verifyId, findings, ...modelChoiceArgs(choice) }),
    verifyCancel: (projectId: string) => invoke('advisor_verify_cancel', { projectId }),
    onEvent: (cb: (envelope: AdvisorEventEnvelope) => void) =>
      subscribe<AdvisorEventEnvelope>(IpcChannels.advisorEvent, cb)
  },

  help: {
    grounding: () => invoke('help_grounding'),
    prepare: (force?: boolean) => invoke('help_prepare', { force: force ?? false }),
    ask: (request) => invoke('help_ask', { request }),
    cancel: () => invoke('help_cancel'),
    pickPaths: (directory: boolean, title?: string) =>
      invoke('help_pick_paths', { directory, title }),
    loadHistory: () => invoke('help_history_load'),
    saveHistory: (data: unknown) => invoke('help_history_save', { data }),
    clearHistory: () => invoke('help_history_clear'),
    onEvent: (cb: (envelope: HelpEventEnvelope) => void) =>
      subscribe<HelpEventEnvelope>(IpcChannels.helpEvent, cb)
  },

  chat: {
    send: (
      projectId: string,
      turnId: string,
      text: string,
      attachments?: string[],
      mode?: ChatMode
    ) => invoke('chat_send', { projectId, turnId, text, attachments, mode }),
    steer: (projectId: string, text: string, attachments?: string[]) =>
      invoke('chat_steer', { projectId, text, attachments }),
    cancel: (projectId: string) => invoke('chat_cancel', { projectId }),
    reset: (projectId: string) => invoke('chat_reset', { projectId }),
    resolvePlan: (
      projectId: string,
      requestId: string,
      action: string,
      planContent: string,
      feedback?: string
    ) => invoke('chat_resolve_plan', { projectId, requestId, action, planContent, feedback }),
    resolveQuestion: (requestId: string, answer: string, wasFreeform: boolean) =>
      invoke('chat_resolve_question', { requestId, answer, wasFreeform }),
    exportPlan: (suggestedName: string, content: string) =>
      invoke('chat_export_plan', { suggestedName, content }),
    history: (projectId: string) => invoke('chat_history', { projectId }),
    saveHistory: (projectId: string, messages: ChatMessage[]) =>
      invoke('chat_save_history', { projectId, messages }),
    setOptions: (projectId: string, options: ChatOptions) =>
      invoke('chat_set_options', { projectId, options }),
    listModels: () => invoke('chat_models'),
    autoTiers: () => invoke('chat_auto_tiers'),
    suggest: (projectId: string) => invoke('chat_suggest', { projectId }),
    cancelSuggest: (projectId: string) => invoke('chat_suggest_cancel', { projectId })
  },

  screenshot: {
    save: (dataUrl: string) => invoke('screenshot_save', { dataUrl }),
    cleanup: (paths: string[]) => invoke('screenshot_cleanup', { paths })
  },

  deploy: {
    run: (projectId: string, workspace?: string) =>
      invoke('deploy_run', { projectId, workspace }),
    list: (projectId: string) => invoke('deploy_list', { projectId }),
    switch: (projectId: string, workspace: string, byId?: boolean) =>
      invoke('deploy_switch', { projectId, workspace, byId }),
    setName: (projectId: string, workspaceKey: string, name: string) =>
      invoke('deploy_set_name', { projectId, workspaceKey, name }),
    status: (projectId: string) => invoke('deploy_status', { projectId }),
    hasChanges: (projectId: string) => invoke('deploy_has_changes', { projectId }),
    pending: (projectId: string) => invoke('deploy_pending', { projectId }),
    reconcile: (projectId: string) => invoke('deploy_reconcile', { projectId })
  },

  dev: {
    plan: (projectId: string) => invoke('dev_port_plan', { projectId }),
    start: (projectId: string, port?: number) => invoke('dev_start', { projectId, port }),
    stop: (projectId: string) => invoke('dev_stop', { projectId }),
    supported: (projectId: string) => invoke('dev_supported_cmd', { projectId }),
    freePort: (port: number, pid: number) => invoke('dev_free_port', { port, pid }),
    registerPort: (projectId: string, port: number) => invoke('dev_register_port', { projectId, port }),
    onState: (cb: (event: DevStateEvent) => void) => subscribe<DevStateEvent>(IpcChannels.devState, cb)
  },

  design: {
    variations: (
      projectId: string,
      context: DesignRestyleContext,
      hint?: string,
      count?: number,
      model?: string,
      options?: DesignVariationsOptions
    ) =>
      invoke('design_variations', {
        projectId,
        context,
        hint,
        count,
        model,
        effort: options?.effort,
        requestId: options?.requestId,
        screenshotPath: options?.screenshotPath
      }),
    onVariation: (cb: (event: DesignVariationEvent) => void) =>
      subscribe<DesignVariationEvent>(IpcChannels.designVariation, cb),
    polish: (
      projectId: string,
      page: DesignPageOutline,
      screenshotPath?: string,
      model?: string,
      effort?: ReasoningEffort
    ) => invoke('design_polish', { projectId, page, screenshotPath, model, effort }),
    locate: (projectId: string, targets: DesignLocateTarget[]) =>
      invoke('design_locate', { projectId, targets })
  },

  settings: {
    get: () => invoke('settings_get'),
    set: (patch: Partial<AppSettings>) => invoke('settings_set', { patch })
  },

  byok: {
    status: () => invoke('byok_status'),
    setKey: (provider: string, key: string) => invoke('byok_set_key', { provider, key }),
    refresh: (provider: string) => invoke('byok_refresh', { provider }),
    removeKey: (provider: string) => invoke('byok_remove_key', { provider }),
    setModels: (provider: string, models: string[]) => invoke('byok_set_models', { provider, models })
  },

  preview: {
    ...serializePreviewMutations({
      showUrl: (url: string, bounds: PreviewBounds) => invoke('preview_show_url', { url, bounds }),
      preload: (url: string, bounds: PreviewBounds) => invoke('preview_preload', { url, bounds }),
      navigate: (url: string, bounds: PreviewBounds) => invoke('preview_navigate', { url, bounds }),
      setBounds: (bounds: PreviewBounds) => invoke('preview_set_bounds', { bounds }),
      hide: () => invoke('preview_hide'),
      suppress: (bounds: PreviewBounds) => invoke('preview_suppress', { bounds }),
      reload: () => invoke('preview_reload'),
      back: () => invoke('preview_back'),
      forward: () => invoke('preview_forward')
    }),
    capture: () => invoke('preview_capture'),
    onNavState: (cb: (state: PreviewNavState) => void) =>
      subscribe<PreviewNavState>(IpcChannels.previewNav, cb),
    onAgentPreview: (cb: (event: PreviewAgentEvent) => void) =>
      subscribe<PreviewAgentEvent>(IpcChannels.previewAgent, cb),
    design: {
      setEnabled: (
        enabled: boolean,
        embedded?: boolean,
        appUrl?: string,
        options?: DesignEnableOptions
      ) =>
        invoke('preview_design_set', {
          enabled,
          embedded: embedded ?? false,
          appUrl: appUrl ?? null,
          options: options ?? null
        }),
      poll: () => invoke('preview_design_poll'),
      snapshot: () => invoke('preview_design_snapshot'),
      command: (command: DesignCommand) => invoke('preview_design_command', { command }),
      setTheme: (theme: DesignHostTheme) => invoke('preview_design_set_theme', { theme })
    }
  },

  onProcLog: (cb: (event: ProcLogEvent) => void) =>
    subscribe<ProcLogEvent>(IpcChannels.procLog, cb),

  onDeleteProgress: (cb: (event: DeleteProgressEvent) => void) =>
    subscribe<DeleteProgressEvent>(IpcChannels.deleteProgress, cb),

  onChatEvent: (cb: (envelope: ChatEventEnvelope) => void) =>
    subscribe<ChatEventEnvelope>(IpcChannels.chatEvent, cb),

  onAdvisorEvent: (cb: (envelope: AdvisorEventEnvelope) => void) =>
    subscribe<AdvisorEventEnvelope>(IpcChannels.advisorEvent, cb),

  team: {
    envStatus: (account?: string) => invoke('team_env_status', { account }),
    githubSignIn: (signedIn: boolean, deleteRepo?: boolean, account?: string) =>
      invoke('team_github_signin', { signedIn, deleteRepo, account }),
    owners: (account?: string) => invoke('team_owners', { account }),
    repos: (account?: string) => invoke('team_repos', { account }),
    capacities: () => invoke('team_capacities'),
    create: (request: TeamCreateRequest, scope: string) => invoke('team_create', { request, scope }),
    resumeSetup: (workspaceId: string, scope: string, existingClientId?: string) =>
      invoke('team_resume_setup', { workspaceId, scope, existingClientId }),
    abandonPlan: (workspaceId: string) => invoke('team_abandon_plan', { workspaceId }),
    abandonSetup: (workspaceId: string, scope: string) =>
      invoke('team_abandon_setup', { workspaceId, scope }),
    cancel: (key: string) => invoke('team_cancel', { key }),
    joinOptions: (account?: string) => invoke('team_join_options', { account }),
    acceptInvitation: (invitationId: number, repo: string, account?: string) =>
      invoke('team_accept_invitation', { invitationId, repo, account }),
    join: (repo: string, account?: string) => invoke('team_join', { repo, account }),
    detail: (workspaceId: string) => invoke('team_detail', { workspaceId }),
    leave: (workspaceId: string) => invoke('team_leave', { workspaceId }),
    delete: (workspaceId: string, deleteFabric: boolean) =>
      invoke('team_delete', { workspaceId, deleteFabric }),
    openProject: (workspaceId: string, folder: string) =>
      invoke('team_open_project', { workspaceId, folder }),
    createProject: (workspaceId: string, input: CreateProjectInput) =>
      invoke('team_create_project', { workspaceId, input }),
    moveProject: (workspaceId: string, projectId: string) =>
      invoke('team_move_project', { workspaceId, projectId }),
    removeProject: (workspaceId: string, folder: string, deleteApps: boolean) =>
      invoke('team_remove_project', { workspaceId, folder, deleteApps }),
    sync: (projectId: string, message: string) => invoke('team_sync', { projectId, message }),
    status: (projectId: string, refresh: boolean) => invoke('team_status', { projectId, refresh }),
    update: (projectId: string, keepConflicts: boolean) =>
      invoke('team_update', { projectId, keepConflicts }),
    discard: (projectId: string) => invoke('team_discard', { projectId }),
    setView: (projectId: string, view: 'preview' | 'production') =>
      invoke('team_set_view', { projectId, view }),
    runLog: (projectId: string, runId: number) => invoke('team_run_log', { projectId, runId }),
    publish: (projectId: string, confirmDataLoss: boolean) =>
      invoke('team_publish', { projectId, confirmDataLoss }),
    reviewRequests: () => invoke('team_review_requests'),
    approve: (workspaceId: string, prNumber: number) =>
      invoke('team_approve', { workspaceId, prNumber }),
    members: (workspaceId: string) => invoke('team_members', { workspaceId }),
    invite: (workspaceId: string, login: string, owner: boolean, email?: string) =>
      invoke('team_invite', { workspaceId, login, owner, email }),
    grantFabricAccess: (workspaceId: string, email: string, login?: string) =>
      invoke('team_grant_fabric_access', { workspaceId, email, login }),
    fabricAccess: (workspaceId: string) => invoke('team_fabric_access', { workspaceId }),
    revokeFabricAccess: (workspaceId: string, principalId: string) =>
      invoke('team_revoke_fabric_access', { workspaceId, principalId }),
    removeMember: (workspaceId: string, login: string, invitationId?: number) =>
      invoke('team_remove_member', { workspaceId, login, invitationId }),
    setRequireReview: (workspaceId: string, require: boolean) =>
      invoke('team_set_require_review', { workspaceId, require }),
    health: (workspaceId: string) => invoke('team_health', { workspaceId }),
    repair: (workspaceId: string, scope: string) => invoke('team_repair', { workspaceId, scope }),
    setAccount: (workspaceId: string, account: string) => invoke('team_set_account', { workspaceId, account }),
    runner: (workspaceId: string) => invoke('team_runner', { workspaceId }),
    setRunner: (workspaceId: string, runner: TeamRunner) => invoke('team_set_runner', { workspaceId, runner }),
    map: (workspaceId: string) => invoke('team_map', { workspaceId }),
    activity: (workspaceId: string) => invoke('team_activity', { workspaceId }),
    diff: (workspaceId: string, folder: string, prNumber?: number) =>
      invoke('team_diff', { workspaceId, folder, prNumber }),
    resources: (workspaceId: string, requests: TeamResourceRequest[]) =>
      invoke('team_resources', { workspaceId, requests }),
    diagnose: (request: TeamDiagnoseRequest) => invoke('team_diagnose', { request }),
    onDiagnosis: (cb: (envelope: TeamDiagnosisEnvelope) => void) =>
      subscribe<TeamDiagnosisEnvelope>(IpcChannels.teamDiagnosis, cb),
    onProgress: (cb: (event: TeamProgressEvent) => void) =>
      subscribe<TeamProgressEvent>(IpcChannels.teamProgress, cb)
  }
}

// The renderer talks to the Rust backend exclusively through `window.api`
// (assigned from `api` in `main.tsx`). This global augmentation replaces the
// former Electron `preload` contextBridge type declaration.
declare global {
  interface Window {
    api: RayfinStudioApi
  }
}
