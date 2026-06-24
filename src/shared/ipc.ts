/**
 * Shared contract between the Rust backend and the renderer.
 *
 * Command names, event channel names and the typed surface exposed on
 * `window.api` live here so the Rust `#[tauri::command]`s and the
 * `src/renderer` (DOM) client stay in sync. To add capabilities, extend the
 * `RayfinStudioApi` interface and the `IpcChannels` map together.
 */

export interface AppVersions {
  app: string
  tauri: string
  webview2: string
  /** Bundled GitHub Copilot CLI version, or null if unavailable. */
  copilot: string | null
}

/** An available application update (mirrors the Rust `UpdateInfo`). */
export interface AppUpdateInfo {
  /** The available (newer) version. */
  version: string
  /** The currently running app version. */
  currentVersion: string
  /** Release notes / body, when published. */
  notes?: string
  /** Publish date, when present. */
  date?: string
}

/** Background-download progress for an update (mirrors the Rust `UpdateProgress`). */
export interface UpdateProgress {
  /** Bytes downloaded so far. */
  downloaded: number
  /** Total bytes to download, when the server reports a content length. */
  total?: number
}

/* ------------------------------------------------------------------ *
 * Environment doctor
 * ------------------------------------------------------------------ */

export type ToolId = 'node' | 'npm' | 'git' | 'rayfin' | 'copilot'

export interface ToolStatus {
  id: ToolId
  name: string
  found: boolean
  /** True when found AND meeting any minimum-version requirement. */
  satisfied: boolean
  version: string | null
  /** Minimum required version (`major.minor[.patch]`), when version-gated. */
  minVersion?: string | null
  /** Short human guidance shown when the tool is missing. */
  installHint: string
  /** Docs / download URL for tools the app cannot auto-install. */
  installUrl?: string
  /** True when the app can install this tool itself (npm package or winget/brew). */
  autoInstallable: boolean
  /** Whether this tool must be present before the app can be used. */
  required: boolean
}

export interface DoctorReport {
  tools: ToolStatus[]
  /** True when every required tool is present and meets its minimum version. */
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

/** A Fabric workspace the signed-in user can access, with capacity details. */
export interface FabricWorkspace {
  id: string
  displayName: string
  /** Fabric workspace type, e.g. 'Workspace' | 'Personal'. */
  type?: string
  capacityId?: string
  /** Capacity region, when known. */
  region?: string
  /** Capacity SKU, e.g. 'F2', 'FT1', 'P1' (undefined when no capacity). */
  sku?: string
  /** Capacity display name, when known. */
  capacityName?: string
  /** Capacity family inferred from the SKU prefix (F* = fabric, P* = premium). */
  capacityKind: 'fabric' | 'premium' | 'other' | 'none'
  /**
   * True when a Rayfin app can be created in this workspace — only Fabric
   * (F-SKU) or Power BI Premium (P-SKU) capacities qualify.
   */
  eligible: boolean
}

/** Outcome of listing Fabric workspaces (never throws across IPC). */
export interface FabricWorkspacesResult {
  ok: boolean
  workspaces?: FabricWorkspace[]
  /** True when the failure was a missing/expired Fabric session. */
  needsLogin?: boolean
  error?: string
}

/** Outcome of deleting a project's deployed app(s) from Fabric (never throws). */
export interface FabricDeleteResult {
  ok: boolean
  /** Number of Fabric items successfully deleted. */
  deleted: number
  /** Per-deployment failures (the local delete proceeds regardless). */
  failures: Array<{ name: string; error: string }>
  /** True when there was no cached Fabric session to authorize the delete. */
  needsLogin?: boolean
  error?: string
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
  | 'install:node'
  | 'install:git'
  | 'install:setup'
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

/** Result of a tool install, including whether the app must relaunch to see it. */
export interface InstallResult extends ProcResult {
  /**
   * True when a system tool (Node/Git) was installed via a package manager. Its
   * new PATH entry is not visible to the already-running process, so the app must
   * relaunch before the tool — and anything that depends on it — can be used.
   */
  requiresRelaunch?: boolean
  /**
   * True when auto-install was unavailable and the official installer was opened
   * in the browser instead; the user finishes manually, then relaunches.
   */
  manual?: boolean
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

/** One template entry from a community gallery repo's root `rayfin-template.yml`. */
export interface CommunityTemplate {
  /** Gallery repo URL this is scaffolded from (`rayfin init -t <repoUrl>`). */
  repoUrl: string
  /** Path within the repo (e.g. `templates/field-technician`). */
  path: string
  /** Template name — passed to `--template-name` to pick it non-interactively. */
  name: string
  /** Human-readable description from the manifest. */
  description: string
}

/** A community template gallery (defaults to microsoft/awesome-rayfin). */
export interface CommunityGallery {
  repoUrl: string
  displayName?: string
  description?: string
  templates: CommunityTemplate[]
}

/** Result of fetching a community gallery (friendly error instead of a throw). */
export interface CommunityGalleryResult {
  ok: boolean
  error?: string
  gallery?: CommunityGallery
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
  /**
   * Git commit (HEAD sha) that was live as of the last successful deploy. Used
   * to detect "drift" — when the project's current code differs from what is
   * actually deployed (e.g. after restoring an older version).
   */
  commit?: string
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

/** One Fabric deployment recorded for a project (`rayfin up list`). */
export interface FabricDeployment {
  workspaceName: string
  /**
   * Friendly, user-chosen label for this deployment. Rayfin keys deployments by
   * (slugified) workspace name; Studio stores a nicer alias per workspace so
   * users can tell "Production" from "Staging" at a glance.
   */
  name?: string
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

/**
 * Composer mode for a chat turn, mirroring the Copilot CLI:
 * - `agent`: today's behaviour — do the work, auto-approving tools.
 * - `plan`: research read-only, then propose a plan for approval before acting.
 * - `autopilot`: run autonomously end-to-end, auto-approving tools.
 */
export type ChatMode = 'agent' | 'plan' | 'autopilot'

/**
 * A Copilot model available to the signed-in user, as reported by the engine
 * (`models.list`). Drives the chat model picker so the choices match each user's
 * plan/policy instead of a hard-coded list.
 */
export interface CopilotModel {
  /** Selection id passed to the engine as the model (e.g. "claude-sonnet-4.5"). */
  id: string
  /** Human-friendly display name. */
  name: string
  /** Reasoning-effort levels this model supports; empty when it has none. */
  supportedReasoningEfforts: ReasoningEffort[]
  /** The model's default reasoning effort, when it supports configuring one. */
  defaultReasoningEffort?: ReasoningEffort
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
  /**
   * Last Fabric workspace target used for deploys (display name, portal URL,
   * or GUID). Remembered after the user picks one so subsequent deploys reuse
   * it without re-prompting.
   */
  workspace?: string
  /**
   * Human-friendly label for {@link workspace} (e.g. the workspace display
   * name) when it was chosen from the picker. `workspace` itself may be a GUID;
   * this drives the chip label without re-querying Fabric.
   */
  workspaceName?: string
  /**
   * Friendly, user-chosen names for this project's deployments, keyed by the
   * Fabric workspace GUID (falling back to the slugified workspace name). Lets
   * users label deployments ("Production", "Staging") independently of the
   * workspace they live in.
   */
  deploymentNames?: Record<string, string>
  /** Copilot model id for this project's chat (`--model`); undefined = auto. */
  model?: string
  /** Copilot reasoning effort for this project's chat (`--effort`). */
  effort?: ReasoningEffort
  /** True when the folder no longer exists / is no longer a Rayfin project. */
  missing?: boolean
  /**
   * Experimental "side threads" — parallel forks of this project, each a focused
   * background agent working in its own git branch + worktree. Empty/absent for
   * projects with no side threads. The implicit "Main" thread is the project
   * itself (its existing path, branch, and {@link copilotSessionId}).
   */
  threads?: ProjectThread[]
}

/** The implicit main thread's id (the project itself; never a side thread). */
export const MAIN_THREAD_ID = 'main'

/** Lifecycle of a side thread, as persisted on the project. */
export type ThreadStatus = 'active' | 'merged' | 'error'

/**
 * An experimental side thread: a parallel fork of a project that a background
 * Copilot agent works in isolation, via its own git branch checked out in a
 * linked worktree (outside the project dir). When it goes idle after a
 * successful turn it auto-merges into main and the project redeploys.
 */
export interface ProjectThread {
  /** Stable id (uuid) for this side thread. */
  id: string
  /** Display name, e.g. "Mobile view". */
  name: string
  /** Branch holding the thread's work, e.g. `fabricator/thread-<shortId>`. */
  branch: string
  /** Absolute path to the thread's linked git worktree. */
  worktreePath: string
  /** The thread agent's own Copilot CLI session id (independent memory). */
  copilotSessionId?: string
  /** Lifecycle state. */
  status: ThreadStatus
  /** The project's default branch this thread merges back into (e.g. `main`). */
  baseBranch: string
  /** Main HEAD commit the thread was forked from (its merge base). */
  baseCommit: string
  /** ISO timestamp when the thread was created. */
  createdAt: string
  /** ISO timestamp when the thread merged into main (status === 'merged'). */
  mergedAt?: string
  /** The merge commit recorded on main (status === 'merged'). */
  mergeCommit?: string
  /** Friendly error text when status === 'error'. */
  lastError?: string
}

export interface ProjectsState {
  /** Folder under which new projects are created. */
  workspaceRoot: string
  /** Currently active project id, or null when none is selected. */
  activeProjectId: string | null
  projects: StudioProject[]
}

export type ThemePreference = 'dark' | 'light' | 'system'

export interface AppSettings {
  /** UI theme; 'system' follows the OS dark/light setting. */
  theme: ThemePreference
  /** Experimental, opt-in features (off by default). */
  experiments?: ExperimentFlags
}

/** Opt-in experimental feature flags (Settings → Experiments). */
export interface ExperimentFlags {
  /**
   * Side threads: fork a project into parallel background agents that each work
   * in their own git branch/worktree and auto-merge + redeploy when idle.
   */
  sideThreads?: boolean
  /**
   * Advisor auto-refresh: when the Advisor tab is opened and its saved analysis
   * has gone stale (the code changed since the last review), automatically
   * re-run the review instead of just flagging it as stale.
   */
  advisorAutoRun?: boolean
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

/** Sentinel ref for "uncommitted working-tree changes" (vs a commit SHA). */
export const GIT_WORKING_REF = 'WORKING'

/** How one file changed in a commit or the working tree. */
export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed'

/** One commit in a project's history — a friendly "what happened" timeline row. */
export interface GitCommitSummary {
  /** Full 40-char SHA — used as the ref for follow-up change/diff queries. */
  hash: string
  /** Abbreviated SHA for display. */
  shortHash: string
  /** First line of the commit message. */
  subject: string
  /** Author name. */
  author: string
  /** Human relative time, e.g. "2 hours ago". */
  relativeDate: string
  /** ISO timestamp (for tooltips). */
  isoDate: string
  /** Number of files this commit touched. */
  filesChanged: number
  /** Lines added across the commit. */
  insertions: number
  /** Lines removed across the commit. */
  deletions: number
}

/** A project's commit timeline plus a count of not-yet-committed changes. */
export interface GitHistory {
  /** False when the folder is missing or is not a git repository. */
  isRepo: boolean
  /** True when the repo has no commits yet. */
  noCommits?: boolean
  /** Most-recent-first commits (capped). */
  commits: GitCommitSummary[]
  /** Number of files with uncommitted (working-tree) changes. */
  workingChanges: number
  /** Current HEAD commit sha (used to flag the deployed commit + drift). */
  head?: string
}

/** Outcome of restoring a project to a past commit (never throws across IPC). */
export interface RevertResult {
  ok: boolean
  /** The new HEAD sha created by the restore (a fresh commit on top). */
  head?: string
  /** True when the project was already at that version (nothing to restore). */
  noChanges?: boolean
  error?: string
}

/**
 * Sync state of the current branch against its remote-tracking branch.
 * `ahead` = local commits not yet pushed; `behind` = remote commits not yet pulled.
 */
export interface GitRemoteStatus {
  /** False when the folder is missing or is not a git repository. */
  isRepo: boolean
  /** True when the repository has at least one configured remote. */
  hasRemote: boolean
  /** True when the current branch has an upstream/tracking branch set. */
  hasUpstream: boolean
  /** Current branch name when known. */
  branch?: string
  /** Local commits not on the upstream (pushable). */
  ahead: number
  /** Upstream commits not in the local branch (pullable). */
  behind: number
  /** Present when a `git fetch` was attempted but failed (offline/auth). */
  fetchError?: string
}

/** Outcome of a pull or push, carrying refreshed working-tree + remote status. */
export interface GitSyncResult {
  ok: boolean
  error?: string
  /** True when a pull couldn't be combined automatically (rebase conflict). */
  conflict?: boolean
  status: GitStatus
  remote: GitRemoteStatus
}

/** One file changed within a commit or the working tree. */
export interface GitChange {
  /** Current project-relative path (the new path for renames). */
  path: string
  /** Previous path when the file was renamed. */
  oldPath?: string
  status: GitChangeStatus
  /** Lines added (0 for binary). */
  insertions: number
  /** Lines removed (0 for binary). */
  deletions: number
  /** True when git treats the file as binary (no text diff shown). */
  binary?: boolean
}

/** Before/after content for one file, to drive a side-by-side diff view. */
export interface GitFileDiff {
  path: string
  oldPath?: string
  status: GitChangeStatus
  /** Content before the change (empty for additions). */
  before: string
  /** Content after the change (empty for deletions). */
  after: string
  /** True when the file is binary and not shown. */
  binary?: boolean
  /** True when either side exceeded the viewer size cap. */
  tooLarge?: boolean
  /** Populated when the diff could not be produced. */
  error?: string
}

/** A node in a project's file tree (directories carry `children`). */
export interface FileNode {
  name: string
  /** Project-relative POSIX-style path. */
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
  /** True when git ignores this path (or it sits under an ignored folder). */
  ignored?: boolean
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
 * One chronological slice of an assistant turn, used to interleave the model's
 * prose with the tool calls it makes (instead of grouping all tools, then all
 * text). A `'tool'` segment references a {@link ChatToolCall} in `tools` by id so
 * tool-state updates stay in one place. Persisted so reloaded turns keep order.
 */
export type ChatSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string }
  | { kind: 'interjection'; text: string }


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
  | {
      type: 'plan-proposed'
      requestId: string
      summary: string
      planContent: string
      /** Allowed continuations, e.g. 'interactive' | 'autopilot' | 'autopilot_fleet' | 'exit_only'. */
      actions: string[]
      recommendedAction: string
    }
  | { type: 'plan-resolved'; requestId: string }

/** Envelope so the renderer can route events to the right project's conversation. */
export interface ChatEventEnvelope {
  projectId: string
  /** Which thread the event belongs to (MAIN_THREAD_ID for the main thread). */
  threadId: string
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

/** Result of a `chat.steer` call. */
export interface SteerResult {
  /**
   * True when a turn was in flight and the message was handled (interjected, or
   * routed as plan-revision feedback). False when nothing was running — the
   * renderer then sends the message as a normal new turn.
   */
  steered: boolean
}

/* ------------------------------------------------------------------ *
 * Side threads (experimental)
 * ------------------------------------------------------------------ */

/** Input for creating a side thread. */
export interface CreateThreadInput {
  projectId: string
  /** Display name, e.g. "Mobile view". */
  name: string
}

/** Result of a thread lifecycle action (create/remove), with the fresh list. */
export interface ThreadActionResult {
  ok: boolean
  error?: string
  /** The created thread (on a successful create). */
  thread?: ProjectThread
  /** The project's full side-thread list after the action. */
  threads: ProjectThread[]
}

/** Result of merging a side thread into the project's main branch. */
export interface MergeResult {
  ok: boolean
  error?: string
  /** True when git reported conflicts that Copilot was asked to resolve. */
  hadConflicts?: boolean
  /** The merge commit recorded on main, when successful. */
  mergeCommit?: string
  /** The project's full side-thread list after the merge. */
  threads: ProjectThread[]
}

/* ------------------------------------------------------------------ *
 * Rayfin CLI / SDK versions
 * ------------------------------------------------------------------ */

/** Installed vs. latest version for one of a project's @microsoft/rayfin-* packages. */
export interface RayfinPackageVersion {
  /** npm package name, e.g. '@microsoft/rayfin-cli'. */
  name: string
  /** 'cli' for @microsoft/rayfin-cli, otherwise 'sdk' (the runtime libraries). */
  kind: 'cli' | 'sdk'
  /** Version resolved in the project's node_modules, or null when not installed. */
  installed: string | null
  /** Latest stable version on npm (null when offline / the lookup failed). */
  latest: string | null
  /** True when {@link latest} is a newer stable release than {@link installed}. */
  upgradable: boolean
}

/**
 * The project's local Rayfin toolchain version — the CLI plus the SDK libraries
 * pinned in its package.json — and whether a newer release is available. Drives
 * the status-bar version chip and the "update with Copilot" hand-off.
 */
export interface RayfinVersionInfo {
  /** Headline installed version (the CLI, falling back to the SDK), or null. */
  version: string | null
  /** Newest stable version available across the project's Rayfin packages. */
  latest: string | null
  /** True when at least one Rayfin package can be upgraded. */
  upgradeAvailable: boolean
  /** Per-package detail, used to build the upgrade prompt + popover. */
  packages: RayfinPackageVersion[]
}

/* ------------------------------------------------------------------ *
 * Skills
 * ------------------------------------------------------------------ */

/**
 * A curated app-building "skill" the user can switch on per project. Active
 * skills are inlined into the project's `.github/copilot-instructions.md` so the
 * agent applies them. The base skill is always on and cannot be removed.
 */
export interface SkillInfo {
  /** Stable id, e.g. 'buttery-animations'. */
  id: string
  /** Short human title shown on the card. */
  title: string
  /** One-line description of what the skill does. */
  description: string
  /** Emoji/glyph for the card. */
  icon: string
  /** True for the locked base skill (always active, can't be removed). */
  base: boolean
  /** Whether the skill is currently active for the project. */
  active: boolean
  /** Catalog grouping (e.g. 'Design & feel'); absent for base/custom skills. */
  category?: string
  /** True for an on-disk skill that isn't part of our curated catalog. */
  custom?: boolean
}

/** Result of toggling a skill: ok plus the refreshed skill list. */
export interface SkillActionResult {
  ok: boolean
  /** The project's full skill catalog with updated active flags. */
  skills: SkillInfo[]
  /** Set when ok is false. */
  error?: string
}

/** The raw SKILL.md behind a skill, for the read-only preview. */
export interface SkillSource {
  ok: boolean
  /** True when the content is the file on disk; false when it's a catalog sample. */
  installed: boolean
  /** The SKILL.md text (frontmatter + markdown body) when ok. */
  content?: string
  /** Set when ok is false. */
  error?: string
}

/**
 * One issue surfaced by the Advisor (a Copilot-driven, read-only review of the
 * app spanning security, data-model quality, performance, and accessibility).
 * Findings are grouped in the UI by {@link category}.
 */
export interface AdvisorFinding {
  /** Short slug; the UI falls back to the array index if empty. */
  id: string
  /**
   * Check bucket: 'auth' (access/authentication), 'policy' (data policies),
   * 'version' (stale Rayfin CLI/SDK), 'data-modeling' (data-model best
   * practices), 'performance' (runtime/query performance), or 'accessibility'
   * (frontend a11y). Unknown values fall back to an "Other" group.
   */
  category:
    | 'auth'
    | 'policy'
    | 'version'
    | 'data-modeling'
    | 'performance'
    | 'accessibility'
    | string
  severity: 'high' | 'medium' | 'low' | string
  /** Short headline for the card. */
  title: string
  /** What's wrong and why it matters. */
  detail: string
  /** Project-relative path the issue lives in, when known. */
  file?: string
  /** A concrete suggested fix. */
  recommendation: string
}

/** The full Advisor report (persisted and reloaded across runs). */
export interface AdvisorReport {
  /** True when Copilot completed and its JSON report parsed cleanly. */
  ok: boolean
  /** One-line overview (or a raw/error message when ok is false). */
  summary: string
  findings: AdvisorFinding[]
}

/** A saved review: the report plus when it ran, how long it took, and staleness. */
export interface AdvisorSnapshot {
  report: AdvisorReport
  /** RFC3339 timestamp of when the review completed. */
  analyzedAt: string
  /** Wall-clock duration of the review, in milliseconds. */
  durationMs: number
  /** True when the project's code changed since this review (recomputed on load). */
  stale: boolean
}

/** Streamed advisor events (main -> renderer) during a review run. */
export type AdvisorEvent =
  | { type: 'progress'; text: string; tool?: string }
  | { type: 'error'; text: string }
  | { type: 'done'; ok: boolean }

/** Envelope so the renderer can route advisor events to the right project. */
export interface AdvisorEventEnvelope {
  projectId: string
  event: AdvisorEvent
}

/**
 * Connection status for a project's deployed Rayfin data API. The publishable
 * key itself never crosses the IPC boundary — only whether one is available.
 */
export interface DataApiConfig {
  /** True when both an endpoint and a publishable key were resolved. */
  configured: boolean
  /** Base data-plane URL (safe to display). */
  apiUrl?: string
  /** Resolved GraphQL endpoint (`<apiUrl>/graphql`). */
  endpoint?: string
  /** True when a publishable key was found (its value stays in the backend). */
  hasKey: boolean
  /** Where the config was resolved from: "env" | "rayfin.yml" | "deploy" (joined with "+"). */
  source?: string
}


/** Per-project chat configuration (model + reasoning effort). */
export interface ChatOptions {
  /** Copilot model id (`--model`); 'auto' or undefined lets Copilot pick. */
  model?: string
  /** Reasoning effort (`--effort`). */
  effort?: ReasoningEffort
}

/**
 * A clickable starter prompt shown on the empty Build chat: a single emoji glyph
 * plus one plain-language idea the user can click to prefill the composer. These
 * are generated by Copilot from the app's actual code (see `chat.suggest`), with
 * a built-in heuristic fallback in the renderer.
 */
export interface Suggestion {
  icon: string
  text: string
}

/** A generated (or cached) set of starter suggestions for one project. */
export interface SuggestionSet {
  /** True when Copilot returned a usable, non-empty list. */
  ok: boolean
  suggestions: Suggestion[]
  /** Signature of the code these were generated from (cache invalidation). */
  fingerprint?: string
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
  /**
   * Ordered prose/tool slices for an assistant turn (interleaved as they
   * streamed). When present, the UI renders these in order; otherwise it falls
   * back to grouping `tools` then `text` (e.g. for legacy stored turns).
   */
  segments?: ChatSegment[]
  /** Error text shown on a failed turn, if any. */
  error?: string
  /** Number of screenshots that were attached to this (user) message. */
  attachments?: number
  /** Thumbnail data URLs for screenshots attached to this (user) message. */
  attachmentThumbs?: string[]
  /**
   * Marks a non-conversational system event rendered distinctly from a normal
   * turn. `'merge'` = an auto-merge of a side thread into main.
   */
  kind?: 'merge'
  /** For a `kind: 'merge'` event: the merged side thread's display name. */
  mergeName?: string
}

/* ------------------------------------------------------------------ *
 * Preview pane (embedded native webview)
 * ------------------------------------------------------------------ */

/**
 * Logical-pixel rectangle for the native preview webview, expressed in the
 * renderer's client coordinates (i.e. the host element's `getBoundingClientRect`,
 * which map 1:1 to the child webview's logical coordinates).
 */
export interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Navigation state of the preview webview, pushed on the `preview:nav` event. */
export interface PreviewNavState {
  /** Current committed main-frame URL. */
  url: string
  /** True while a document load is in flight. */
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/* ------------------------------------------------------------------ *
 * IPC channels
 * ------------------------------------------------------------------ */

export const IpcChannels = {
  ping: 'app:ping',
  getVersions: 'app:getVersions',
  openExternal: 'app:openExternal',
  openLogs: 'app:openLogs',
  relaunch: 'app:relaunch',

  updateCheck: 'app:updateCheck',
  updateDownload: 'app:updateDownload',
  updateInstall: 'app:updateInstall',

  doctorCheck: 'doctor:check',
  doctorInstall: 'doctor:install',
  doctorInstallAll: 'doctor:installAll',

  authStatus: 'auth:status',
  authLoginCopilot: 'auth:loginCopilot',
  authLoginRayfin: 'auth:loginRayfin',
  authLogoutRayfin: 'auth:logoutRayfin',

  fabricWorkspaces: 'fabric:workspaces',
  fabricDeleteApps: 'fabric:deleteApps',

  projectsState: 'projects:state',
  projectsTemplates: 'projects:templates',
  projectsCommunityTemplates: 'projects:communityTemplates',
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
  projectsGitLog: 'projects:gitLog',
  projectsGitChanges: 'projects:gitChanges',
  projectsGitFileDiff: 'projects:gitFileDiff',
  projectsGitCompareChanges: 'projects:gitCompareChanges',
  projectsGitCompareFileDiff: 'projects:gitCompareFileDiff',
  projectsGitFileLog: 'projects:gitFileLog',
  projectsGitRevert: 'projects:gitRevert',
  projectsGitRemoteStatus: 'projects:gitRemoteStatus',
  projectsGitDivergence: 'projects:gitDivergence',
  projectsGitPull: 'projects:gitPull',
  projectsGitPush: 'projects:gitPush',
  projectsFilesTree: 'projects:filesTree',
  projectsFilesRead: 'projects:filesRead',

  rayfinVersions: 'rayfin:versions',

  skillsList: 'skills:list',
  skillsSet: 'skills:set',
  skillsSource: 'skills:source',

  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatReset: 'chat:reset',
  chatHistory: 'chat:history',
  chatSaveHistory: 'chat:saveHistory',
  chatSetOptions: 'chat:setOptions',

  threadsList: 'threads:list',
  threadsCreate: 'threads:create',
  threadsRemove: 'threads:remove',
  threadsMerge: 'threads:merge',

  screenshotSave: 'screenshot:save',
  screenshotCleanup: 'screenshot:cleanup',

  deployRun: 'deploy:run',
  deployStatus: 'deploy:status',
  deployHasChanges: 'deploy:hasChanges',
  deployList: 'deploy:list',
  deploySwitch: 'deploy:switch',
  deploySetName: 'deploy:setName',
  deployReconcile: 'deploy:reconcile',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  // main -> renderer events
  procLog: 'proc:log',
  chatEvent: 'chat:event',
  advisorEvent: 'advisor:event',
  previewNav: 'preview:nav',
  updateProgress: 'update:progress'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/** Outcome of "Open in VSCode": whether the editor actually launched. */
export interface OpenInEditorResult {
  /** True when VS Code's `code` CLI was found and launched on the folder. */
  opened: boolean
  /** True when we fell back to revealing the folder in the OS file manager. */
  revealedFolder?: boolean
}

/* ------------------------------------------------------------------ *
 * Renderer-facing API (exposed via preload contextBridge as window.api)
 * ------------------------------------------------------------------ */

export interface RayfinStudioApi {
  ping: () => Promise<string>
  getVersions: () => Promise<AppVersions>
  /** Open a URL in the user's default browser. */
  openExternal: (url: string) => Promise<void>
  /** Open the logs folder (userData/logs) in the OS file manager; returns its path. */
  openLogs: () => Promise<string>
  /**
   * Open the project folder in VS Code (`code <dir>`). When VS Code's CLI isn't
   * found, the project folder is revealed in the OS file manager instead and
   * `opened` is false, so the UI can nudge the user to install VS Code.
   */
  openInEditor: (id: string) => Promise<OpenInEditorResult>
  /** Restart the app (used to pick up newly installed Node/Git on PATH). */
  relaunch: () => Promise<void>

  /** In-app auto-update (Tauri updater, backed by GitHub Releases). */
  updates: {
    /** Check for a newer release without downloading it. */
    check: () => Promise<AppUpdateInfo | null>
    /** Download the pending update in the background (streams progress). */
    download: () => Promise<AppUpdateInfo | null>
    /** Install the downloaded update and restart the app. */
    install: () => Promise<void>
    /** Subscribe to background download progress; returns an unsubscribe fn. */
    onProgress: (cb: (progress: UpdateProgress) => void) => () => void
  }

  doctor: {
    check: () => Promise<DoctorReport>
    /** Install one auto-installable tool (npm: rayfin/copilot, system: node/git). */
    install: (id: ToolId) => Promise<InstallResult>
    /**
     * Install every missing required tool in dependency order. Installs system
     * tools (Node/Git) first; if any are installed it returns requiresRelaunch so
     * the caller can restart before the npm-based CLIs are installed.
     */
    installAll: () => Promise<InstallResult>
  }

  auth: {
    status: () => Promise<AuthStatus>
    loginCopilot: () => Promise<ProcResult>
    loginRayfin: (tenant?: string) => Promise<ProcResult>
    logoutRayfin: () => Promise<ProcResult>
  }

  fabric: {
    /** List the signed-in user's Fabric workspaces (with capacity / F-SKU info). */
    listWorkspaces: () => Promise<FabricWorkspacesResult>
    /**
     * Delete the project's deployed app(s) from Fabric (the Fabric items behind
     * its recorded deployments). Used when removing a project so the Fabric side
     * is cleaned up too. Never throws — reports per-deployment failures.
     */
    deleteApps: (projectId: string) => Promise<FabricDeleteResult>
  }

  projects: {
    /** Current projects state (workspace root, list, active id). */
    state: () => Promise<ProjectsState>
    /** Available scaffolding templates. */
    templates: () => Promise<TemplateInfo[]>
    /** Fetch a community template gallery (defaults to microsoft/awesome-rayfin). */
    communityTemplates: (repoUrl?: string) => Promise<CommunityGalleryResult>
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
    setWorkspace: (
      id: string,
      workspace?: string,
      workspaceName?: string
    ) => Promise<ProjectActionResult>
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
      /** The project's commit timeline + uncommitted-change count (History view). */
      log: (id: string) => Promise<GitHistory>
      /**
       * Files changed by a commit (`ref` = SHA) or the working tree
       * (`ref` = GIT_WORKING_REF), with per-file status + line counts.
       */
      changes: (id: string, ref: string) => Promise<GitChange[]>
      /** Before/after content for one changed file (drives the diff view). */
      fileDiff: (id: string, ref: string, path: string, oldPath?: string) => Promise<GitFileDiff>
      /**
       * Files changed between two commits (`base`..`target`) — powers the
       * History "Compare" mode, where the user picks any two snapshots.
       */
      compareChanges: (id: string, base: string, target: string) => Promise<GitChange[]>
      /** Before (`base`) / after (`target`) content for one file across a range. */
      compareFileDiff: (
        id: string,
        base: string,
        target: string,
        path: string,
        oldPath?: string
      ) => Promise<GitFileDiff>
      /** Every commit that touched one file (newest first), following renames. */
      fileLog: (id: string, path: string) => Promise<GitCommitSummary[]>
      /**
       * Restore the project to the snapshot at `ref` (a commit SHA) by recording
       * it as a new commit on top of the current history (nothing is lost). The
       * caller then redeploys to publish the restored version.
       */
      revert: (id: string, ref: string) => Promise<RevertResult>
      /**
       * Sync state vs the remote: runs `git fetch` first, so it reflects new
       * remote commits. Drives the header pill's pull/push affordances.
       */
      remoteStatus: (id: string) => Promise<GitRemoteStatus>
      /**
       * Same shape as `remoteStatus` but WITHOUT fetching — an instant read of the
       * already-known divergence. Used by the deploy "unpulled changes" guard.
       */
      divergence: (id: string) => Promise<GitRemoteStatus>
      /** Get the latest remote changes (fast-forward, else rebase local on top). */
      pull: (id: string) => Promise<GitSyncResult>
      /** Push local commits to the remote (only when an upstream exists). */
      push: (id: string) => Promise<GitSyncResult>
    }
    files: {
      /** The project's pruned, sorted file tree (read-only browsing). */
      tree: (id: string) => Promise<FileNode[]>
      /** Read one project file's text (size-capped, traversal-guarded). */
      read: (id: string, path: string) => Promise<FileContent>
    }
  }

  rayfin: {
    /** The project's local Rayfin CLI + SDK versions, with upgrade availability. */
    versions: (id: string) => Promise<RayfinVersionInfo>
  }

  skills: {
    /** The project's skill catalog, each flagged active/inactive. */
    list: (id: string) => Promise<SkillInfo[]>
    /** Turn a skill on/off; updates instructions + commits. Base can't be removed. */
    set: (id: string, skillId: string, active: boolean) => Promise<SkillActionResult>
    /** Read the raw SKILL.md behind a skill (on-disk file, or a catalog sample). */
    source: (id: string, skillId: string) => Promise<SkillSource>
  }

  /** Advisor: a Copilot-driven, read-only security review of the app. */
  advisor: {
    /**
     * Run a security review of the project with the Copilot CLI and resolve the
     * saved snapshot (report + timing). Streams `advisor:event` progress
     * (subscribe via onAdvisorEvent). Uses an ephemeral Copilot session so the
     * review never lands in the project's Build chat history. A successful review
     * is persisted and can be reloaded with {@link load}.
     */
    run: (projectId: string) => Promise<AdvisorSnapshot>
    /** Cancel the in-flight review for a project. Resolves true if one was running. */
    cancel: (projectId: string) => Promise<boolean>
    /**
     * Load the last saved review for a project (with `stale` recomputed against
     * the current code), or null if it has never been analyzed.
     */
    load: (projectId: string) => Promise<AdvisorSnapshot | null>
    /** Subscribe to streamed advisor events. Returns an unsubscribe function. */
    onEvent: (cb: (envelope: AdvisorEventEnvelope) => void) => () => void
  }

  /** Live Data Browser: query a deployed app's managed Rayfin GraphQL data API. */
  data: {
    /**
     * Resolve the project's data-API connection status (endpoint + whether a
     * publishable key is available). Never rejects on a missing deploy —
     * resolves `{ configured: false }` so the Data tab can show an empty state.
     */
    config: (projectId: string) => Promise<DataApiConfig>
    /** Run a GraphQL introspection query against the deployed data API. */
    introspect: (projectId: string) => Promise<unknown>
    /** Run an arbitrary GraphQL query/mutation against the deployed data API. */
    query: (projectId: string, query: string, variables?: Record<string, unknown>) => Promise<unknown>
  }


  chat: {
    /**
     * Send a message to the Copilot agent scoped to the project (and optional
     * side thread). Streams `chat:event` envelopes (subscribe via onChatEvent)
     * and resolves with the final turn result. `turnId` correlates the streamed
     * events. `attachments` are absolute file paths (e.g. region screenshots)
     * passed to copilot as `--attachment` and cleaned up after the turn.
     * `threadId` defaults to the main thread when omitted.
     */
    send: (
      projectId: string,
      turnId: string,
      text: string,
      attachments?: string[],
      threadId?: string,
      mode?: ChatMode
    ) => Promise<ChatTurnResult>
    /**
     * Interject a message into the turn already running for a project's thread —
     * conversation steering. When a turn is in flight the message interrupts the
     * current step immediately (or, if a Plan card is open, becomes plan-revision
     * feedback) and resolves with `{ steered: true }`. When nothing is running it
     * resolves with `{ steered: false }`, so the caller sends it as a new turn.
     */
    steer: (
      projectId: string,
      text: string,
      attachments?: string[],
      threadId?: string
    ) => Promise<SteerResult>
    /** Cancel the in-flight turn for a project's thread (main when omitted). */
    cancel: (projectId: string, threadId?: string) => Promise<void>
    /** Start a fresh conversation (drops the persisted Copilot session id). */
    reset: (projectId: string, threadId?: string) => Promise<void>
    /**
     * Answer a Plan-mode approval prompt (`plan-proposed`). `action` is one of
     * 'interactive' | 'autopilot' | 'autopilot_fleet' | 'exit_only' to approve and
     * continue with that route, or 'keep_planning' to send the agent back to revise
     * the plan (optionally with `feedback`).
     */
    resolvePlan: (requestId: string, action: string, feedback?: string) => Promise<void>
    /** Load the persisted conversation history for a project's thread. */
    history: (projectId: string, threadId?: string) => Promise<ChatMessage[]>
    /** Persist the conversation history for a thread (empty array clears it). */
    saveHistory: (projectId: string, messages: ChatMessage[], threadId?: string) => Promise<void>
    /** Set the model / reasoning effort used for this project's chat. */
    setOptions: (projectId: string, options: ChatOptions) => Promise<void>
    /** List the Copilot models available to the signed-in user (for the picker). */
    listModels: () => Promise<CopilotModel[]>
    /**
     * Generate (or return cached) Copilot starter suggestions for a project's
     * empty Build chat, grounded in the app's code. `ok: false` means the
     * renderer should fall back to its built-in heuristic suggestions. Cached
     * per project and reused until the code changes; safe to call repeatedly.
     */
    suggest: (projectId: string) => Promise<SuggestionSet>
    /** Cancel an in-flight suggestion generation (e.g. the user started typing). */
    cancelSuggest: (projectId: string) => Promise<boolean>
  }

  /** Experimental side threads (parallel forks). */
  threads: {
    /** List a project's side threads. */
    list: (projectId: string) => Promise<ProjectThread[]>
    /** Fork a new side thread (branch + linked worktree + own Copilot session). */
    create: (input: CreateThreadInput) => Promise<ThreadActionResult>
    /** Discard a side thread (remove its worktree + branch + transcript). */
    remove: (projectId: string, threadId: string) => Promise<ThreadActionResult>
    /**
     * Merge a side thread into the project's main branch, resolving any
     * conflicts with Copilot. Streams Copilot conflict-resolution progress on
     * the main thread's `chat:event` channel.
     */
    merge: (projectId: string, threadId: string) => Promise<MergeResult>
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
    /**
     * Set (or clear, when empty) the friendly name for one of the project's
     * deployments. `workspaceKey` is the deployment's workspace GUID (or its
     * slugified workspace name when no GUID is known).
     */
    setName: (projectId: string, workspaceKey: string, name: string) => Promise<ProjectsState>
    /**
     * Reconcile the recorded deployment with on-disk reality
     * (`rayfin/.deployments.json`) and return the updated projects state. Called
     * on open/select so an already-deployed app reflects its deployment without a
     * redeploy. Best-effort: leaves state untouched on a failed/offline query.
     */
    reconcile: (projectId: string) => Promise<ProjectsState>
  }

  /** App-wide settings (theme, telemetry opt-in). */
  settings: {
    get: () => Promise<AppSettings>
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>
  }

  /**
   * Embedded preview pane, backed by a single native WebView2 child webview that
   * floats above the React layout. The renderer owns *where* it sits (it reports
   * the host element's bounds) and *when* it is visible (it must hide the webview
   * whenever something is painted over the host: other tabs, modals, the deploy
   * log). Navigation state is delivered out-of-band via {@link onNavState}.
   */
  preview: {
    /**
     * Show the preview at `url`, positioned over `bounds`. Creates the webview on
     * first call; afterwards navigates (when `url` changed) and repositions.
     */
    showUrl: (url: string, bounds: PreviewBounds) => Promise<void>
    /**
     * Navigate the preview to `url` and reposition to `bounds`, **without**
     * changing visibility. Used to load a switch/redeploy/Fabric-toggle target
     * while the surface is hidden behind a loading placeholder; the renderer
     * re-reveals it via {@link showUrl} once the new page finishes loading.
     */
    navigate: (url: string, bounds: PreviewBounds) => Promise<void>
    /** Reposition/resize the preview to track its host element. */
    setBounds: (bounds: PreviewBounds) => Promise<void>
    /** Hide the preview (call whenever the host is covered or unmounted). */
    hide: () => Promise<void>
    /** Reload the current page. */
    reload: () => Promise<void>
    /**
     * Clear the preview's browsing session — cookies, cached tokens and site
     * storage — then reload. Use to drop a cached Entra/AAD identity and sign in
     * as a different tenant or account.
     */
    clearData: () => Promise<void>
    /** Navigate back one entry in the preview's history. */
    back: () => Promise<void>
    /** Navigate forward one entry in the preview's history. */
    forward: () => Promise<void>
    /**
     * Capture the current preview content as a PNG `data:` URL (via WebView2's
     * `CapturePreview`). Used by the annotate-and-attach flow: the renderer freezes
     * this image, lets the user draw on it, then stages the result as a chat
     * attachment. Rejects when no preview is open or capture fails.
     */
    capture: () => Promise<string>
    /** Subscribe to preview navigation state. Returns an unsubscribe function. */
    onNavState: (cb: (state: PreviewNavState) => void) => () => void
  }

  /** Subscribe to streamed process output. Returns an unsubscribe function. */
  onProcLog: (cb: (event: ProcLogEvent) => void) => () => void
  /** Subscribe to streamed chat events. Returns an unsubscribe function. */
  onChatEvent: (cb: (envelope: ChatEventEnvelope) => void) => () => void
  /** Subscribe to streamed advisor events. Returns an unsubscribe function. */
  onAdvisorEvent: (cb: (envelope: AdvisorEventEnvelope) => void) => () => void
}
