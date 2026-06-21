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

/* ------------------------------------------------------------------ *
 * Environment doctor
 * ------------------------------------------------------------------ */

export type ToolId = 'node' | 'npm' | 'git' | 'rayfin' | 'copilot'

export interface ToolStatus {
  id: ToolId
  name: string
  found: boolean
  version: string | null
  /** Short human guidance shown when the tool is missing. */
  installHint: string
  /** Docs / download URL for tools the app cannot auto-install. */
  installUrl?: string
  /** True when the app can install this tool itself (global npm package). */
  autoInstallable: boolean
  /** Whether this tool must be present before the app can be used. */
  required: boolean
}

export interface DoctorReport {
  tools: ToolStatus[]
  /** True when every required tool is present. */
  ready: boolean
}

/* ------------------------------------------------------------------ *
 * Authentication
 * ------------------------------------------------------------------ */

export interface CopilotAuthStatus {
  signedIn: boolean
  user?: string
}

export interface RayfinAuthStatus {
  signedIn: boolean
  user?: string
  tenant?: string
}

export interface AuthStatus {
  copilot: CopilotAuthStatus
  rayfin: RayfinAuthStatus
}

/* ------------------------------------------------------------------ *
 * Long-running / streaming processes (logins, installs, deploys)
 * ------------------------------------------------------------------ */

/** Stable identifiers for streamed process output. */
export type ProcStreamId =
  | 'login:copilot'
  | 'login:rayfin'
  | 'logout:rayfin'
  | 'install:rayfin'
  | 'install:copilot'
  | 'create:project'
  | 'deploy:run'
  | 'deploy:dryrun'

export interface ProcLogEvent {
  channel: ProcStreamId
  stream: 'stdout' | 'stderr' | 'system'
  data: string
}

export interface ProcResult {
  ok: boolean
  exitCode: number | null
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

/** A Rayfin project template (from `rayfin init --list-templates`). */
export interface TemplateInfo {
  name: string
  displayName: string
  description: string
}

export interface DeployInfo {
  /** Best URL to load in the preview (hostingUrl → rayfinApiUrl → fabricPortalUrl). */
  url?: string
  /** Rayfin item BaaS endpoint (`deployment.rayfinApiUrl`). */
  apiUrl?: string
  /** Fabric portal deep link for the deployed item. */
  portalUrl?: string
  /** 'deploying' | 'success' | 'error' | 'cancelled'. */
  status?: string
  /** Structured outcome of the last attempt (drives e.g. the workspace prompt). */
  outcome?: DeployOutcome
  /** Error message from the last failed deploy, if any. */
  error?: string
  /** ISO timestamp of the last deploy attempt. */
  at?: string
}

/** Outcome of a Studio-driven `rayfin up`. */
export type DeployOutcome =
  | 'success'
  | 'error'
  | 'cancelled'
  | 'not-signed-in'
  | 'not-found'
  | 'needs-workspace'
  | 'needs-force'

export interface DeployResult {
  ok: boolean
  outcome: DeployOutcome
  /** Best URL to load in the preview. */
  url?: string
  apiUrl?: string
  portalUrl?: string
  error?: string
}

/** Read-only deployment status from `rayfin up status --json`. */
export interface DeployStatus {
  deployed: boolean
  url?: string
  apiUrl?: string
  portalUrl?: string
}

/** Result of a `rayfin up --dry-run` preview (no API calls made). */
export interface DryRunResult {
  ok: boolean
  /** The captured human-readable preview output. */
  output: string
  error?: string
}

/** One Fabric deployment recorded for a project (`rayfin up list`). */
export interface FabricDeployment {
  workspaceName: string
  /** True for the currently active deployment (the one `rayfin up` targets). */
  active: boolean
  workspaceId?: string
  itemId?: string
  apiUrl?: string
  hostingUrl?: string
  deployedAt?: string
}

/** Reasoning effort levels supported by the Copilot CLI (`--effort`). */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A project tracked by the app. Source lives in a local git repo on disk. */
export interface StudioProject {
  /** Internal stable id (uuid) used by the app. */
  id: string
  /** Display name (from rayfin/rayfin.yml, falls back to folder name). */
  name: string
  /** Absolute path to the project directory. */
  path: string
  /** Template id the project was scaffolded from, when known. */
  template?: string
  /** ISO timestamp when the project was added to the app. */
  addedAt: string
  /** Most recent deployment metadata. */
  lastDeploy?: DeployInfo
  /** Persisted Copilot CLI session id so chat resumes across restarts. */
  copilotSessionId?: string
  /**
   * Last Fabric workspace target used for deploys (display name, portal URL,
   * or GUID). Remembered after the user picks one so subsequent deploys reuse
   * it without re-prompting.
   */
  workspace?: string
  /** Copilot model id for this project's chat (`--model`); undefined = auto. */
  model?: string
  /** Copilot reasoning effort for this project's chat (`--effort`). */
  effort?: ReasoningEffort
  /** True when the folder no longer exists / is no longer a Rayfin project. */
  missing?: boolean
}

export interface ProjectsState {
  /** Folder under which new projects are created. */
  workspaceRoot: string
  /** Currently active project id, or null when none is selected. */
  activeProjectId: string | null
  projects: StudioProject[]
}

export interface CreateProjectInput {
  name: string
  /**
   * Template the project is scaffolded from. Either a built-in name
   * ('blankapp' | 'dataapp' | 'gettingstartedauth' | 'todoapp') or a community
   * template URL (e.g. an awesome-rayfin git/tarball URL) — `rayfin init -t`
   * accepts either.
   */
  template: string
  /**
   * For a multi-template source URL, the specific template to pick
   * (`rayfin init --template-name <name>`). Ignored for built-in templates.
   */
  templateName?: string
}

export interface ProjectActionResult {
  ok: boolean
  error?: string
  project?: StudioProject
}

/** A compact snapshot of a project's git working tree. */
export interface GitStatus {
  /** False when the folder is missing or is not a git repository. */
  isRepo: boolean
  /** Current branch name (or a detached-HEAD label) when known. */
  branch?: string
  /** Files with staged, unstaged, or untracked changes. */
  changedCount: number
  /** True when the repo has no commits yet (unborn HEAD). */
  noCommits?: boolean
}

export interface GitCommitResult {
  ok: boolean
  error?: string
  /** The working-tree status after the commit attempt. */
  status: GitStatus
}

/** A node in a project's file tree (directories carry `children`). */
export interface FileNode {
  name: string
  /** Project-relative POSIX-style path. */
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
}

/** The result of reading one project file for the viewer. */
export interface FileContent {
  path: string
  /** Size in bytes. */
  size: number
  /** UTF-8 text content (omitted for binary / too-large / errored reads). */
  content?: string
  /** True when the file is binary and not shown. */
  binary?: boolean
  /** True when the file exceeds the viewer size cap. */
  tooLarge?: boolean
  /** Populated when the read failed. */
  error?: string
}

/* ------------------------------------------------------------------ *
 * Chat (Copilot CLI)
 * ------------------------------------------------------------------ */

export type ChatToolState = 'running' | 'success' | 'error'

export interface ChatToolCall {
  /** Copilot toolCallId. */
  id: string
  /** Tool name, e.g. 'powershell', 'create', 'edit', 'view'. */
  name: string
  /** Human-friendly one-line summary (description / command / path). */
  title: string
  state: ChatToolState
  /** Captured tool output once complete (may be truncated for display). */
  output?: string
}

/**
 * Streamed chat events sent from main -> renderer during a turn. The renderer
 * appends 'delta' text to the active assistant bubble and tracks tool calls by id.
 */
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool-start'; tool: ChatToolCall }
  | { type: 'tool-end'; id: string; state: ChatToolState; output?: string }
  | { type: 'notice'; text: string }
  | { type: 'error'; text: string }
  | { type: 'result'; ok: boolean; filesModified: string[]; ranDeploy: boolean }

/** Envelope so the renderer can route events to the right project's conversation. */
export interface ChatEventEnvelope {
  projectId: string
  /** Correlates events to a single send() turn. */
  turnId: string
  event: ChatEvent
}

export interface ChatTurnResult {
  ok: boolean
  error?: string
  filesModified: string[]
  /** True when the agent ran a full `rayfin up` during the turn. */
  ranDeploy: boolean
}

/** Per-project chat configuration (model + reasoning effort). */
export interface ChatOptions {
  /** Copilot model id (`--model`); 'auto' or undefined lets Copilot pick. */
  model?: string
  /** Reasoning effort (`--effort`). */
  effort?: ReasoningEffort
}

/**
 * A persisted chat message. This is the durable shape written to disk per
 * project so a conversation survives app restarts (the Copilot session id is
 * persisted separately on the project). The renderer's live message type adds
 * transient fields (turnId, pending) on top of this.
 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools: ChatToolCall[]
  /** Error text shown on a failed turn, if any. */
  error?: string
  /** Number of screenshots that were attached to this (user) message. */
  attachments?: number
}

/* ------------------------------------------------------------------ *
 * IPC channels
 * ------------------------------------------------------------------ */

export const IpcChannels = {
  ping: 'app:ping',
  getVersions: 'app:getVersions',
  openExternal: 'app:openExternal',

  doctorCheck: 'doctor:check',
  doctorInstall: 'doctor:install',

  authStatus: 'auth:status',
  authLoginCopilot: 'auth:loginCopilot',
  authLoginRayfin: 'auth:loginRayfin',
  authLogoutRayfin: 'auth:logoutRayfin',

  projectsState: 'projects:state',
  projectsTemplates: 'projects:templates',
  projectsPickFolder: 'projects:pickFolder',
  projectsPickWorkspaceRoot: 'projects:pickWorkspaceRoot',
  projectsSetWorkspaceRoot: 'projects:setWorkspaceRoot',
  projectsCreate: 'projects:create',
  projectsOpen: 'projects:open',
  projectsSetActive: 'projects:setActive',
  projectsRename: 'projects:rename',
  projectsSetWorkspace: 'projects:setWorkspace',
  projectsRemove: 'projects:remove',
  projectsGitStatus: 'projects:gitStatus',
  projectsGitCommit: 'projects:gitCommit',
  projectsFilesTree: 'projects:filesTree',
  projectsFilesRead: 'projects:filesRead',

  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatReset: 'chat:reset',
  chatHistory: 'chat:history',
  chatSaveHistory: 'chat:saveHistory',
  chatSetOptions: 'chat:setOptions',

  screenshotSave: 'screenshot:save',
  screenshotCleanup: 'screenshot:cleanup',

  deployRun: 'deploy:run',
  deployStatus: 'deploy:status',
  deployHasChanges: 'deploy:hasChanges',
  deployDryRun: 'deploy:dryRun',
  deployList: 'deploy:list',
  deploySwitch: 'deploy:switch',

  // main -> renderer events
  procLog: 'proc:log',
  chatEvent: 'chat:event'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/* ------------------------------------------------------------------ *
 * Renderer-facing API (exposed via preload contextBridge as window.api)
 * ------------------------------------------------------------------ */

export interface RayfinStudioApi {
  ping: () => Promise<string>
  getVersions: () => Promise<AppVersions>
  /** Open a URL in the user's default browser. */
  openExternal: (url: string) => Promise<void>

  doctor: {
    check: () => Promise<DoctorReport>
    /** Install an auto-installable tool (currently rayfin / copilot via npm -g). */
    install: (id: ToolId) => Promise<ProcResult>
  }

  auth: {
    status: () => Promise<AuthStatus>
    loginCopilot: () => Promise<ProcResult>
    loginRayfin: (tenant?: string) => Promise<ProcResult>
    logoutRayfin: () => Promise<ProcResult>
  }

  projects: {
    /** Current projects state (workspace root, list, active id). */
    state: () => Promise<ProjectsState>
    /** Available scaffolding templates. */
    templates: () => Promise<TemplateInfo[]>
    /** Native folder picker; returns the chosen path or null if cancelled. */
    pickFolder: () => Promise<string | null>
    /** Native folder picker for the workspace root; persists and returns state. */
    pickWorkspaceRoot: () => Promise<ProjectsState>
    setWorkspaceRoot: (path: string) => Promise<ProjectsState>
    /** Scaffold a new project (streams output on the 'create:project' channel). */
    create: (input: CreateProjectInput) => Promise<ProjectActionResult>
    /** Register an existing Rayfin project by path and make it active. */
    open: (path: string) => Promise<ProjectActionResult>
    setActive: (id: string | null) => Promise<ProjectsState>
    /** Rename a project (updates the display name and rayfin/rayfin.yml `name`). */
    rename: (id: string, name: string) => Promise<ProjectActionResult>
    /** Set (or clear, when empty) the Fabric workspace a project deploys to. */
    setWorkspace: (id: string, workspace?: string) => Promise<ProjectActionResult>
    /**
     * Remove a project. By default it is only forgotten (files left on disk);
     * pass `deleteFiles: true` to also move the project folder to the OS trash.
     */
    remove: (id: string, deleteFiles?: boolean) => Promise<ProjectsState>
    git: {
      /** Snapshot of the project's git working tree (branch + change count). */
      status: (id: string) => Promise<GitStatus>
      /** Stage everything and commit; resolves with the post-commit status. */
      commit: (id: string, message: string) => Promise<GitCommitResult>
    }
    files: {
      /** The project's pruned, sorted file tree (read-only browsing). */
      tree: (id: string) => Promise<FileNode[]>
      /** Read one project file's text (size-capped, traversal-guarded). */
      read: (id: string, path: string) => Promise<FileContent>
    }
  }

  chat: {
    /**
     * Send a message to the Copilot agent scoped to the project. Streams
     * `chat:event` envelopes (subscribe via onChatEvent) and resolves with the
     * final turn result. `turnId` correlates the streamed events. `attachments`
     * are absolute file paths (e.g. region screenshots) passed to copilot as
     * `--attachment` and cleaned up after the turn.
     */
    send: (
      projectId: string,
      turnId: string,
      text: string,
      attachments?: string[]
    ) => Promise<ChatTurnResult>
    /** Cancel the in-flight turn for a project. */
    cancel: (projectId: string) => Promise<void>
    /** Start a fresh conversation (drops the persisted Copilot session id). */
    reset: (projectId: string) => Promise<void>
    /** Load the persisted conversation history for a project. */
    history: (projectId: string) => Promise<ChatMessage[]>
    /** Persist the conversation history for a project (empty array clears it). */
    saveHistory: (projectId: string, messages: ChatMessage[]) => Promise<void>
    /** Set the model / reasoning effort used for this project's chat. */
    setOptions: (projectId: string, options: ChatOptions) => Promise<void>
  }

  screenshot: {
    /** Persist a captured PNG (data URL) to a temp file; returns its path. */
    save: (dataUrl: string) => Promise<string>
    /** Delete temp screenshot files (best-effort; only within Studio's temp dir). */
    cleanup: (paths: string[]) => Promise<void>
  }

  deploy: {
    /**
     * Run a full `rayfin up` for the project (streams progress on the
     * 'deploy:run' channel) and resolve the live URL. Studio owns deploys.
     * `workspace` optionally targets a Fabric workspace by display name (first
     * deploy); subsequent deploys reuse the recorded active deployment.
     */
    run: (projectId: string, workspace?: string, force?: boolean) => Promise<DeployResult>
    /** Preview a deploy with `rayfin up --dry-run` (no API calls). */
    dryRun: (projectId: string, workspace?: string) => Promise<DryRunResult>
    /** Read the persisted deployment status (`rayfin up status --json`). */
    status: (projectId: string) => Promise<DeployStatus>
    /** True when the project has uncommitted changes not yet deployed. */
    hasChanges: (projectId: string) => Promise<boolean>
    /** List the Fabric deployments recorded for this project (`rayfin up list`). */
    list: (projectId: string) => Promise<FabricDeployment[]>
    /**
     * Switch the active Fabric deployment (`rayfin up switch`). `workspace` is a
     * recorded workspace name; pass `byId` to switch by workspace GUID instead.
     */
    switch: (projectId: string, workspace: string, byId?: boolean) => Promise<DeployResult>
  }

  /** Subscribe to streamed process output. Returns an unsubscribe function. */
  onProcLog: (cb: (event: ProcLogEvent) => void) => () => void
  /** Subscribe to streamed chat events. Returns an unsubscribe function. */
  onChatEvent: (cb: (envelope: ChatEventEnvelope) => void) => () => void
}
