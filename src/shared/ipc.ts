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
  /** Error message from the last failed deploy, if any. */
  error?: string
  /** ISO timestamp of the last deploy attempt. */
  at?: string
}

/** Outcome of a Studio-driven `rayfin up`. */
export type DeployOutcome = 'success' | 'error' | 'cancelled' | 'not-signed-in' | 'not-found'

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
  /** Template name, e.g. 'blankapp' | 'dataapp' | 'gettingstartedauth' | 'todoapp'. */
  template: string
}

export interface ProjectActionResult {
  ok: boolean
  error?: string
  project?: StudioProject
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
  projectsRemove: 'projects:remove',

  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatReset: 'chat:reset',

  deployRun: 'deploy:run',
  deployStatus: 'deploy:status',
  deployHasChanges: 'deploy:hasChanges',

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
    /** Remove a project from the list (does not delete files on disk). */
    remove: (id: string) => Promise<ProjectsState>
  }

  chat: {
    /**
     * Send a message to the Copilot agent scoped to the project. Streams
     * `chat:event` envelopes (subscribe via onChatEvent) and resolves with the
     * final turn result. `turnId` correlates the streamed events.
     */
    send: (projectId: string, turnId: string, text: string) => Promise<ChatTurnResult>
    /** Cancel the in-flight turn for a project. */
    cancel: (projectId: string) => Promise<void>
    /** Start a fresh conversation (drops the persisted Copilot session id). */
    reset: (projectId: string) => Promise<void>
  }

  deploy: {
    /**
     * Run a full `rayfin up` for the project (streams progress on the
     * 'deploy:run' channel) and resolve the live URL. Studio owns deploys.
     */
    run: (projectId: string) => Promise<DeployResult>
    /** Read the persisted deployment status (`rayfin up status --json`). */
    status: (projectId: string) => Promise<DeployStatus>
    /** True when the project has uncommitted changes not yet deployed. */
    hasChanges: (projectId: string) => Promise<boolean>
  }

  /** Subscribe to streamed process output. Returns an unsubscribe function. */
  onProcLog: (cb: (event: ProcLogEvent) => void) => () => void
  /** Subscribe to streamed chat events. Returns an unsubscribe function. */
  onChatEvent: (cb: (envelope: ChatEventEnvelope) => void) => () => void
}
