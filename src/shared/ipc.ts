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
  /** GitHub Copilot CLI version actually running (self-reported), or null. */
  copilot: string | null
  /**
   * The SDK's pinned bundled CLI version (from the install dir). The CLI
   * self-updates past this, so it can be older than `copilot`; surfaced only
   * to disambiguate the two. Absent when it can't be determined.
   */
  copilotBundled?: string | null
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

/** File-count progress while a project's files are moved to trash (mirrors the Rust `DeleteProgressEvent`). */
export interface DeleteProgressEvent {
  /** Project id being deleted (so the modal can match its own delete). */
  id: string
  /** `'scanning'` while counting files, `'trashing'` while the OS moves them. */
  phase: 'scanning' | 'trashing'
  /** Files counted so far (equals `total` once scanning completes). */
  processed: number
  /** Total files, known once the scan completes. */
  total?: number
}

/* ------------------------------------------------------------------ *
 * Environment doctor
 * ------------------------------------------------------------------ */

export type ToolId = 'node' | 'npm' | 'git' | 'rayfin' | 'copilot' | 'az' | 'gh'

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

export interface AzAuthStatus {
  signedIn: boolean
  user?: string
  tenant?: string
}

export interface AuthStatus {
  copilot: CopilotAuthStatus
  rayfin: RayfinAuthStatus
  az: AzAuthStatus
}

/* ------------------------------------------------------------------ *
 * GitHub (optional gh CLI: clone-from-GitHub)
 * ------------------------------------------------------------------ */

/** Availability + sign-in state for the optional `gh` CLI. */
export interface GithubStatus {
  /** True when the `gh` binary is on PATH. */
  ghInstalled: boolean
  /** True when `gh auth status` reports a signed-in account. */
  signedIn: boolean
  user?: string
}

/** One repository from `gh repo list` (fields normalized for the picker). */
export interface GithubRepo {
  nameWithOwner: string
  name: string
  description?: string
  /** 'PUBLIC' | 'PRIVATE' | 'INTERNAL' (as reported by gh). */
  visibility?: string
  updatedAt?: string
  url?: string
  isPrivate: boolean
  isFork: boolean
  primaryLanguage?: string
}

export interface GithubReposResult {
  ok: boolean
  error?: string
  repos: GithubRepo[]
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
  /**
   * Capacity family inferred from the SKU prefix (F* = fabric, P* = premium).
   * 'unknown' = the workspace is on a dedicated capacity but its SKU isn't
   * visible to the signed-in user (they don't administer that capacity).
   */
  capacityKind: 'fabric' | 'premium' | 'other' | 'none' | 'unknown'
  /**
   * True when a Rayfin app can be created in this workspace — Fabric (F-SKU),
   * Power BI Premium (P-SKU), or 'unknown' (capacity present, SKU not visible)
   * qualify; the deploy performs the final validation.
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

/** A Power BI report in a Fabric workspace the user can migrate. */
export interface FabricReport {
  id: string
  displayName: string
  /** Report description, when set. */
  description?: string
  /** Direct link to the report in the Fabric/Power BI portal, when known. */
  webUrl?: string
}

/** Outcome of listing a workspace's Power BI reports (never throws across IPC). */
export interface FabricReportsResult {
  ok: boolean
  reports?: FabricReport[]
  /** True when the failure was a missing/expired Fabric session. */
  needsLogin?: boolean
  error?: string
}

/** Outcome of downloading a report's PBIR definition to disk (never throws). */
export interface FabricReportDefinitionResult {
  ok: boolean
  /** Relative paths (under the destination dir) of the files written. */
  files?: string[]
  /** Absolute directory the report files were written into. */
  dir?: string
  /** The report's bound semantic model id (report downloads only), resolved from
   * its `definition.pbir` so the caller can download the model next. */
  modelId?: string
  /** True when the failure was a missing/expired Fabric session. */
  needsLogin?: boolean
  error?: string
}

/** Outcome of the interactive Fabric sign-in (never throws across IPC). */
export interface FabricSignInResult {
  ok: boolean
  error?: string
}

/** Outcome of exporting a Power BI report to PDF (never throws across IPC). The
 * PDF is returned inline (base64) so the renderer can rasterize each page to an
 * image with pdf.js and stage them as chat attachments. Best-effort: a failure
 * (image/PDF export disabled on the tenant, or a non-capacity workspace) is
 * reported, not thrown, and never blocks the migration. */
export interface FabricExportPdfResult {
  ok: boolean
  /** Absolute path the exported PDF was written to (`source-report/report.pdf`). */
  pdfPath?: string
  /** The exported PDF, base64-encoded, for renderer rasterization. */
  pdfBase64?: string
  /** Byte length of the exported PDF. */
  bytes?: number
  /** True when the failure was that the Azure CLI (`az`) isn't signed in. */
  needsLogin?: boolean
  error?: string
}

/** A dedicated capacity the user can create a workspace on. */
export interface FabricCapacity {
  id: string
  displayName: string
  /** SKU, e.g. 'F2', 'P1' (undefined when not visible). */
  sku?: string
  region?: string
  /** F* = fabric, P* (not PP) = premium, PP* = other (PPU, ineligible). */
  kind: 'fabric' | 'premium' | 'other'
  eligible: boolean
}

/** Outcome of listing eligible Fabric capacities (never throws). */
export interface FabricCapacitiesResult {
  ok: boolean
  capacities?: FabricCapacity[]
  needsLogin?: boolean
  error?: string
}

/** Outcome of creating + assigning a new Fabric workspace (never throws). */
export interface FabricCreateWorkspaceResult {
  ok: boolean
  workspaceId?: string
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

/** One table in a semantic model's schema (a node in the Model-tab diagram). */
export interface SemanticTable {
  name?: string
  description?: string
  isHidden: boolean
  storageMode?: string
}

/** One column on a semantic-model table; `expression` is set only for a calculated column. */
export interface SemanticColumn {
  table?: string
  name?: string
  dataType?: string
  isHidden: boolean
  isKey: boolean
  dataCategory?: string
  formatString?: string
  displayFolder?: string
  expression?: string
}

/** One measure on a semantic-model table (its DAX `expression` is shown on click). */
export interface SemanticMeasure {
  table?: string
  name?: string
  expression?: string
  dataType?: string
  formatString?: string
  displayFolder?: string
  description?: string
  isHidden: boolean
}

/** One relationship (an edge) with cardinality, cross-filter direction and active state. */
export interface SemanticRelationship {
  name?: string
  fromTable?: string
  fromColumn?: string
  /** 'One' | 'Many' (as reported by INFO.VIEW.RELATIONSHIPS). */
  fromCardinality?: string
  toTable?: string
  toColumn?: string
  toCardinality?: string
  isActive: boolean
  /** 'OneDirection' | 'BothDirections' | 'Automatic'. */
  crossFilter?: string
}

/**
 * Outcome of reading a semantic model's schema for the Model-tab diagram (never
 * throws across IPC). The schema is queried live from Fabric with the Azure CLI
 * Power BI token (like `@microsoft/fabric-app-data-cli`), so `needsAz` drives an
 * `az login` CTA, `needsLogin` a Fabric sign-in, and `error` covers the "not
 * deployed / no access" cases.
 */
export interface SemanticSchemaResult {
  ok: boolean
  /** True when at least one table came back. */
  matched: boolean
  /** True when the failure was a missing/expired Fabric session. */
  needsLogin?: boolean
  /** True when the failure was a missing/signed-out Azure CLI. */
  needsAz?: boolean
  error?: string
  workspaceId?: string
  itemId?: string
  tables: SemanticTable[]
  columns: SemanticColumn[]
  measures: SemanticMeasure[]
  relationships: SemanticRelationship[]
  /** Non-fatal notes (e.g. a sub-query that failed while tables succeeded). */
  notes: string[]
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
  | 'install:gh'
  | 'install:setup'
  | 'create:project'
  | 'clone:project'
  | 'deploy:run'
  | 'dev:run'

export interface ProcLogEvent {
  channel: ProcStreamId
  stream: 'stdout' | 'stderr' | 'system'
  data: string
}

export interface ProcResult {
  ok: boolean
  exitCode: number | null
  /**
   * User-facing reason the process failed (e.g. the Rayfin CLI's
   * `❌ Login failed: …` output). Present only on failure; absent on success.
   */
  error?: string
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

/** A built-in (bundled) Rayfin project template shown in the New Project picker. */
export interface TemplateInfo {
  name: string
  displayName: string
  description: string
  /**
   * When `'fabric'`, projects created from this template default to the embedded
   * Fabric portal preview (the toolbar Fabric toggle starts on). Absent for
   * templates that open in the direct app view.
   */
  defaultPreviewMode?: PreviewMode
}

/** One template entry from a community gallery repo's root `rayfin-template.yml`. */
export interface CommunityTemplate {
  /** Gallery repo URL this is scaffolded from (`npm create @microsoft/rayfin -- -t <repoUrl>`). */
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

/**
 * Result of starting a project's Vite dev server for the live local preview
 * (experimental). `outcome` is `running` (started, or already up), `unsupported`
 * (the project has no `dev` script / no local Vite), or `error`.
 */
export interface DevServerResult {
  ok: boolean
  outcome: 'running' | 'unsupported' | 'error'
  /** The `localhost` URL Vite is serving on, when it started successfully. */
  url?: string
  error?: string
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

/** Durable lifecycle of a Plan-mode artifact in the chat transcript. */
export type ChatPlanPhase =
  | 'researching'
  | 'clarifying'
  | 'drafting'
  | 'review'
  | 'revising'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'interruptedReview'
  | 'interruptedExecution'

/** Status values written by the agent to the session SQL `todos` table. */
export type ChatPlanTodoStatus = 'pending' | 'in_progress' | 'done' | 'blocked'

export interface ChatPlanTodo {
  id: string
  title: string
  description?: string
  status: ChatPlanTodoStatus
}

export interface ChatPlanDependency {
  todoId: string
  dependsOn: string
}

export interface ChatPlanQuestion {
  id: string
  question: string
  choices?: string[]
  allowFreeform: boolean
  state: 'pending' | 'answered' | 'interrupted'
  answer?: string
  wasFreeform?: boolean
}

/**
 * Durable Plan-mode artifact attached to the assistant turn that created it.
 * `liveRequestId` is populated only while this process owns the SDK callback;
 * persisted/reloaded artifacts clear it and use a continuation turn to resume.
 */
export interface ChatPlanArtifact {
  id: string
  phase: ChatPlanPhase
  summary: string
  content: string
  actions: string[]
  recommendedAction: string
  selectedAction?: string
  todos: ChatPlanTodo[]
  dependencies: ChatPlanDependency[]
  questions: ChatPlanQuestion[]
  edited?: boolean
  revisionCount?: number
  error?: string
  liveRequestId?: string
}

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

/** Preview pane view selection: the direct app URL, or the app embedded in the
 *  Fabric portal shell (`StudioProject.lastDeploy.portalUrl`). */
export type PreviewMode = 'direct' | 'fabric'

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
  /**
   * Set when a project is freshly created in-app and has never been deployed.
   * Drives the onboarding "deploy first" gate — the chat composer is disabled
   * until a deployment exists. Cleared on the first successful deploy. Never set
   * for projects opened from disk, so opening an existing app is never gated.
   */
  awaitingFirstDeploy?: boolean
  /** Copilot model id for this project's chat (`--model`); undefined = auto. */
  model?: string
  /** Copilot reasoning effort for this project's chat (`--effort`). */
  effort?: ReasoningEffort
  /**
   * Preview pane view selection. `'fabric'` shows the app embedded in the Fabric
   * portal shell ({@link DeployInfo.portalUrl}); absent / `'direct'` shows the
   * direct app URL. Persisted (rather than kept in the renderer alone) so the
   * Fabricator agent's screenshot/navigate tools honour the same view the user
   * is looking at.
   */
  previewMode?: PreviewMode
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

export type ThemePreference = 'dark' | 'light' | 'system'

export interface AppSettings {
  /** UI theme; 'system' follows the OS dark/light setting. */
  theme: ThemePreference
  /** UI zoom factor (1 = 100%). Scales the whole interface for large monitors. */
  uiScale?: number
  /** Experimental, opt-in features (off by default). */
  experiments?: ExperimentFlags
  /**
   * Capture full chat diagnostics (prompt/response text + tool I/O) for bug
   * reports. Off by default — only lightweight metadata is captured. Opt-in via
   * Settings → Diagnostics.
   */
  fullDiagnostics?: boolean
}

/** Opt-in experimental feature flags (Settings → Experiments). */
export interface ExperimentFlags {
  /**
   * Compatibility rendering: force WebView2 software rendering (disable GPU
   * acceleration). Fixes freezing/hangs in VMs such as Parallels where the
   * virtualized GPU misbehaves. Applied at startup, so a change needs a relaunch.
   */
  compatibilityRendering?: boolean
  /**
   * Chat mode selector: show the Agent / Plan / Autopilot dropdown in the chat
   * composer. Plan mode researches, clarifies, and waits for approval before
   * building. When off (the default), every turn runs in standard Agent mode.
   */
  chatModeSelector?: boolean
  /**
   * Live local preview: while an agent turn runs, start the project's Vite dev
   * server and point the preview at `localhost` so edits show live (HMR). The
   * server is stopped at turn end and the normal after-turn deploy takes over.
   * Off by default; only affects projects that declare a `dev` script.
   */
  localDevPreview?: boolean
}

export interface CreateProjectInput {
  name: string
  /**
   * Template the project is scaffolded from. Either a built-in (bundled) name
   * ('fabricator-dataapp' | 'fabricator-todoapp') or a community template URL
   * (e.g. an awesome-rayfin git/tarball URL) — `npm create @microsoft/rayfin -- -t`
   * accepts either.
   */
  template: string
  /**
   * For a multi-template source URL, the specific template to pick
   * (`npm create @microsoft/rayfin -- --template-name <name>`). Ignored for
   * built-in templates.
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
  | { kind: 'interjection'; text: string; thumbs?: string[] }

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
  | { type: 'plan-content'; content: string; operation: string }
  | { type: 'plan-todos'; todos: ChatPlanTodo[]; dependencies: ChatPlanDependency[] }
  | { type: 'mode-changed'; mode: ChatMode }
  | {
      type: 'plan-question'
      requestId: string
      question: string
      choices?: string[]
      allowFreeform: boolean
    }
  | { type: 'plan-question-resolved'; requestId: string; answer?: string }
  | {
      type: 'agent-question'
      requestId: string
      question: string
      choices?: string[]
      allowFreeform: boolean
    }

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
  /**
   * True when this custom skill comes from the global, reusable custom-skill
   * library (vs. a project-local, agent-authored skill). Library skills can be
   * edited or deleted from the library, and toggled into any project.
   */
  library?: boolean
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
 * One entry in the global, reusable custom-skill library (stored under the app
 * data dir). Presentation fields come from the library folder's `meta.json`.
 */
export interface CustomSkillInfo {
  /** Stable slug id, e.g. 'team-brand'. */
  id: string
  /** Human title shown on the card. */
  title: string
  /** Short one-line description for the card. */
  description: string
  /** Emoji/glyph for the card. */
  icon: string
  /** True when the library skill ships extra files under `references/`. */
  hasReferences: boolean
}

/** Payload to create or edit a library skill from the in-app authoring form. */
export interface CustomSkillSaveInput {
  /** Present when editing an existing library skill; omit to create a new one. */
  id?: string
  /** Human title (also slugified into the id on create). */
  title: string
  /** Short card description; falls back to the frontmatter description when empty. */
  description: string
  /** Emoji/glyph; defaults to a puzzle piece when empty. */
  icon?: string
  /** The full SKILL.md the user authored/edited (frontmatter + body). */
  content: string
}

/** Result of a library mutation (save/import/remove): ok plus the refreshed library. */
export interface CustomSkillActionResult {
  ok: boolean
  /** The id created or edited, when ok. */
  id?: string
  /** The refreshed custom-skill library. */
  library: CustomSkillInfo[]
  /** Set when ok is false and it was a real failure (absent on a cancelled dialog). */
  error?: string
}

/**
 * A read-only preview of a picked skill folder / `.md` / `.zip`, shown before the
 * user commits to adding it.
 */
export interface CustomSkillPreview {
  ok: boolean
  /** True when the user dismissed the picker (a no-op, not an error). */
  cancelled: boolean
  error?: string
  /** Absolute path of the picked folder/file, passed back to install on confirm. */
  sourcePath?: string
  /** The picked SKILL.md content. */
  content?: string
  title?: string
  description?: string
  icon?: string
  /** How many `references/*.md` files would come along. */
  referenceCount: number
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
  /** A chunk of a streamed inline "Explain this finding" answer, routed by explainId. */
  | { type: 'explainDelta'; explainId: string; text: string }
  /** Terminal marker for an inline explanation (ok false carries error). */
  | { type: 'explainDone'; explainId: string; ok: boolean; error?: string }

/** Envelope so the renderer can route advisor events to the right project. */
export interface AdvisorEventEnvelope {
  projectId: string
  event: AdvisorEvent
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
   * True when this assistant turn was still streaming when the app closed or
   * crashed. Persisted only for the in-flight turn so it can be detected on the
   * next launch and offered for "resume" (re-run the prompt); cleared once the
   * turn completes normally.
   */
  interrupted?: boolean
  /** Wall-clock duration of the assistant turn, in ms. Set when the turn finishes. */
  elapsedMs?: number
  /** Durable Plan-mode artifact owned by this assistant turn, when present. */
  plan?: ChatPlanArtifact
  /**
   * Standalone clarifying questions raised by the `ask_user` tool during an
   * Agent-mode turn (no Plan artifact). Rendered as inline question cards on
   * this assistant turn and answered via `chat_resolve_question`.
   */
  questions?: ChatPlanQuestion[]
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

/**
 * A request from the Fabricator agent (its in-process `fabricator_*` tools) for
 * the renderer to surface the preview pane, pushed on the `preview:agent` event.
 * Lets a deploy/navigate/screenshot tool make the preview visible even when the
 * user has the chat pane focused.
 */
export interface PreviewAgentEvent {
  /** Currently only `show`: bring the preview into view (optionally at `url`). */
  action: 'show'
  /** The live URL the agent is pointing the preview at, when known. */
  url?: string
}

/**
 * Lightweight status of the in-preview "design mode" session (experiment),
 * polled by the renderer while design mode is on. Mirrors the injected
 * controller's `peek()` (see the native `DesignStatus`).
 */
export interface PreviewDesignStatus {
  enabled: boolean
  /** Bumped on every recorded change — lets the poll detect activity cheaply. */
  version: number
  /** Number of tweaks recorded so far. */
  changeCount: number
  /** True once the user hit "Send to chat"; the renderer then captures + drains. */
  handoffReady: boolean
  /** True once the user asked to "Generate with AI" on a placeholder. */
  aiPending?: boolean
  /** Whether the controller currently holds the AI model list (re-pushed if not). */
  hasModels?: boolean
  /** The AI picker's currently selected model id — persisted by the renderer. */
  aiModel?: string | null
  /** True once the user hit "Apply" on an element's "Edit with AI" card. */
  aiEditPending?: boolean
  /** Whether the controller currently holds the Fabricator theme (re-pushed if not). */
  hasTheme?: boolean
}

/**
 * A drained "Generate with AI" request from an inserted placeholder: the target
 * placeholder id and the natural-language description + box size the renderer
 * feeds to the fast model.
 */
export interface PreviewDesignAiRequest {
  id: string
  description: string
  width: number
  height: number
  /** Model id chosen in the picker (undefined → host default / fast model). */
  model?: string
}

/**
 * A drained design-mode "Send to chat" hand-off: the composed natural-language
 * instruction describing every tweak, plus the change count.
 */
export interface PreviewDesignHandoff {
  instruction: string
  changeCount: number
}

/**
 * Compact element context the controller sends with an "Edit with AI" restyle
 * request; forwarded verbatim to `design.restyleElement`.
 */
export interface PreviewDesignRestyleContext {
  tag: string
  text?: string
  classes?: string
  component?: string
  /** Current (relevant) computed styles, keyed by CSS property. */
  styles: Record<string, string>
  isChart: boolean
  chartType?: string
  /** Current Graphein spec (data omitted) for charts. */
  spec?: unknown
  /** Notable descendants the model can target via `rules`. */
  children?: { tag: string; classes?: string; text?: string }[]
}

/**
 * A drained "Edit with AI" restyle request for a selected element: the target
 * element id (`data-rayfin-edit-id`), the natural-language change, the chosen
 * model, and the element context the renderer forwards to the model.
 */
export interface PreviewDesignAiEditRequest {
  id: string
  /** All target element ids (multi-select) — the one patch applies to each. */
  ids?: string[]
  description: string
  model?: string
  context: PreviewDesignRestyleContext
}

/**
 * Fabricator's own theme pushed into the design controller so the tools match
 * the host app's look + zoom (built by the renderer from its CSS tokens +
 * `uiScale`). Colors are CSS color strings; `scale` is the UI zoom (1 = 100%).
 */
export interface PreviewDesignTheme {
  accent: string
  accentHi?: string
  panel: string
  panel2?: string
  border?: string
  txt: string
  txtDim?: string
  scale?: number
}

/**
 * The structured restyle patch returned by `design.restyleElement`: whitelisted
 * inline CSS property→value pairs, plus an optional Graphein spec patch (charts).
 */
export interface PreviewDesignRestylePatch {
  styles: Record<string, string>
  graphein?: unknown
  /** Descendant rules: whitelisted CSS applied to elements matching `selector`. */
  rules?: { selector: string; styles: Record<string, string> }[]
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
  authLoginAz: 'auth:loginAz',
  authLogoutRayfin: 'auth:logoutRayfin',

  githubStatus: 'github:status',
  githubLogin: 'github:login',
  githubListRepos: 'github:listRepos',
  githubClone: 'github:clone',

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
  previewAgent: 'preview:agent',
  updateProgress: 'update:progress',
  deleteProgress: 'delete:progress'
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
   * Chat-session diagnostics captured for bug reports (metadata by default; full
   * capture is opt-in via {@link AppSettings.fullDiagnostics}).
   */
  diagnostics: {
    /**
     * Build a single consolidated diagnostics file (environment + recent
     * chat-turn diagnostics + crash/hang log tail), reveal it in the OS file
     * manager, and return its path so it can be attached to a bug report.
     */
    export: () => Promise<string>
  }
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
    loginAz: () => Promise<ProcResult>
    logoutRayfin: () => Promise<ProcResult>
  }

  /** Optional GitHub integration (backed by the `gh` CLI) for cloning repos. */
  github: {
    /** gh CLI availability + sign-in state. */
    status: () => Promise<GithubStatus>
    /** Launch an external terminal running `gh auth login --web` (browser flow). */
    login: () => Promise<ProcResult>
    /** List the signed-in user's repositories. */
    listRepos: () => Promise<GithubReposResult>
    /**
     * Clone a repo (`owner/name` or a GitHub URL) into the workspace, then
     * register + open it. Fails if the clone isn't a Rayfin project.
     */
    clone: (repo: string) => Promise<ProjectActionResult>
  }

  fabric: {
    /** List the signed-in user's Fabric workspaces (with capacity / F-SKU info). */
    listWorkspaces: () => Promise<FabricWorkspacesResult>
    /** List the Power BI reports in a workspace (for the migrate-report picker). */
    listReports: (workspaceId: string) => Promise<FabricReportsResult>
    /**
     * Download a report's public definition (PBIR) into `<projectDir>/source-report`
     * so the agent can rebuild it. Follows the getDefinition long-running operation
     * and writes each decoded part to disk; never throws.
     */
    reportDefinition: (
      workspaceId: string,
      reportId: string,
      projectDir: string
    ) => Promise<FabricReportDefinitionResult>
    /**
     * Download a semantic model's definition (TMDL — the DAX measures/tables)
     * into `<projectDir>/source-model`. `modelId` comes from a prior
     * `reportDefinition` call. Best-effort: a failure is reported, not thrown.
     */
    semanticModelDefinition: (
      workspaceId: string,
      modelId: string,
      projectDir: string
    ) => Promise<FabricReportDefinitionResult>
    /**
     * Export a Power BI report to a PDF (every page) via the Power BI `ExportTo`
     * REST API, writing it to `<projectDir>/source-report/report.pdf` and
     * returning it base64-encoded so the renderer can rasterize each page into an
     * image for the migrate chat hand-off. Best-effort: image export is
     * tenant-blocked on many tenants (so we export PDF), and PDF export needs a
     * capacity-backed workspace — a failure is reported, not thrown.
     */
    exportReportPdf: (
      workspaceId: string,
      reportId: string,
      projectDir: string
    ) => Promise<FabricExportPdfResult>
    /**
     * Persist the renderer's rasterized report pages (PNG data URLs) into
     * `<projectDir>/source-report/pages/` as `page-01.png`, … and return their
     * absolute paths. These live in the project (not a temp dir), so the build
     * agent can re-open them on any turn as a persistent visual reference;
     * `source-report/` is git-ignored so they're never committed or bundled.
     */
    saveReportPages: (projectDir: string, pages: string[]) => Promise<string[]>
    /**
     * Open the interactive Microsoft Fabric sign-in window (returns immediately
     * when already signed in). Used by the migrate-report flow so workspaces can
     * be listed from the Home screen where no project is active.
     */
    signIn: () => Promise<FabricSignInResult>
    /** List eligible (F-SKU / P-SKU) capacities the user can create a workspace on. */
    listCapacities: () => Promise<FabricCapacitiesResult>
    /** Create + assign a new workspace to `capacityId`; region follows the capacity. */
    createWorkspace: (name: string, capacityId: string) => Promise<FabricCreateWorkspaceResult>
    /**
     * Delete the project's deployed app(s) from Fabric (the Fabric items behind
     * its recorded deployments). Used when removing a project so the Fabric side
     * is cleaned up too. Never throws — reports per-deployment failures.
     */
    deleteApps: (projectId: string) => Promise<FabricDeleteResult>
    /**
     * Read a semantic model's schema (tables/columns/measures/relationships) for
     * the Model tab's diagram. Queried live from Fabric via DAX `INFO.VIEW.*`
     * using the Azure CLI Power BI token; never throws — reports
     * `needsAz`/`needsLogin`/`error` for the UI to render.
     */
    semanticModelSchema: (workspaceId: string, itemId: string) => Promise<SemanticSchemaResult>
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
    /** Install missing dependencies so this project's pinned Rayfin CLI is ready. */
    ensureDependencies: (id: string) => Promise<ProjectActionResult>
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
     * Persist the preview pane's view selection (direct app URL vs. the app
     * embedded in the Fabric portal shell). Stored on the project so the
     * Fabricator agent's screenshot/navigate tools honour the same view.
     */
    setPreviewMode: (id: string, mode: PreviewMode) => Promise<ProjectActionResult>
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

  /**
   * Your reusable custom-skill **library** (stored under the app data dir). Adding
   * or uploading a skill installs it into the given project's `.agents/skills/`;
   * pass `toLibrary: true` to also save it to the library for reuse in other apps.
   */
  customSkills: {
    /** The current custom-skill library. */
    list: () => Promise<CustomSkillInfo[]>
    /** Read the raw SKILL.md of a library skill, for the authoring/preview editor. */
    source: (id: string) => Promise<SkillSource>
    /**
     * Create a skill in `projectId` (with `id` unset), or edit an existing library
     * skill in place (with `id` set). `toLibrary` also saves a new skill to the library.
     */
    save: (
      input: CustomSkillSaveInput,
      projectId: string,
      toLibrary: boolean
    ) => Promise<CustomSkillActionResult>
    /** Pick a skill folder and return a read-only preview (no install yet). */
    pickFolderPreview: () => Promise<CustomSkillPreview>
    /** Pick a SKILL.md or `.zip` bundle and return a read-only preview (no install yet). */
    pickFilePreview: () => Promise<CustomSkillPreview>
    /** Confirm a previewed upload: install the skill at `sourcePath` into the app. */
    addFromPath: (
      projectId: string,
      sourcePath: string,
      toLibrary: boolean
    ) => Promise<CustomSkillActionResult>
    /** Save a skill that's only in this app into the reusable library. */
    promote: (projectId: string, id: string) => Promise<CustomSkillActionResult>
    /** Remove a skill from the library (installed app copies are kept). */
    remove: (id: string) => Promise<CustomSkillActionResult>
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
    run: (projectId: string, model?: string) => Promise<AdvisorSnapshot>
    /** Cancel the in-flight review for a project. Resolves true if one was running. */
    cancel: (projectId: string) => Promise<boolean>
    /**
     * Load the last saved review for a project (with `stale` recomputed against
     * the current code), or null if it has never been analyzed.
     */
    load: (projectId: string) => Promise<AdvisorSnapshot | null>
    /**
     * Explain a single finding inline. Runs a throwaway, read-only Copilot session
     * (so the answer never lands in the Build chat), streaming `advisor:event`
     * `explainDelta` chunks routed by `explainId`, and resolving with the full
     * Markdown answer. Rejects (and emits `explainDone` with ok=false) on failure.
     */
    explain: (
      projectId: string,
      explainId: string,
      finding: AdvisorFinding,
      model?: string
    ) => Promise<string>
    /** Cancel the in-flight inline explanation for a project. Resolves true if one was running. */
    explainCancel: (projectId: string) => Promise<boolean>
    /** Subscribe to streamed advisor events. Returns an unsubscribe function. */
    onEvent: (cb: (envelope: AdvisorEventEnvelope) => void) => () => void
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
      attachments?: string[],
      mode?: ChatMode
    ) => Promise<ChatTurnResult>
    /**
     * Interject a message into the turn already running for a project —
     * conversation steering. When a turn is in flight the message interrupts the
     * current step immediately (or, if a Plan card is open, becomes plan-revision
     * feedback) and resolves with `{ steered: true }`. When nothing is running it
     * resolves with `{ steered: false }`, so the caller sends it as a new turn.
     */
    steer: (projectId: string, text: string, attachments?: string[]) => Promise<SteerResult>
    /** Cancel the in-flight turn for a project. */
    cancel: (projectId: string) => Promise<void>
    /** Start a fresh conversation (drops the persisted Copilot session id). */
    reset: (projectId: string) => Promise<void>
    /**
     * Answer a Plan-mode approval prompt (`plan-proposed`). `action` is one of
     * 'interactive' | 'autopilot' | 'autopilot_fleet' | 'exit_only' to approve and
     * continue with that route, or 'keep_planning' to send the agent back to revise
     * the plan (optionally with `feedback`).
     */
    resolvePlan: (
      projectId: string,
      requestId: string,
      action: string,
      planContent: string,
      feedback?: string
    ) => Promise<void>
    /** Answer a structured clarification raised by the Plan-mode `ask_user` tool. */
    resolveQuestion: (requestId: string, answer: string, wasFreeform: boolean) => Promise<void>
    /** Export a plan to a user-selected Markdown file. Null means the dialog was cancelled. */
    exportPlan: (suggestedName: string, content: string) => Promise<string | null>
    /** Load the persisted conversation history for a project. */
    history: (projectId: string) => Promise<ChatMessage[]>
    /** Persist the conversation history for a project (empty array clears it). */
    saveHistory: (projectId: string, messages: ChatMessage[]) => Promise<void>
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
    run: (projectId: string, workspace?: string) => Promise<DeployResult>
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

  /**
   * Live local preview (experimental, opt-in via {@link ExperimentFlags.localDevPreview}).
   * Runs the project's Vite dev server directly (no `rayfin up`) so edits show
   * live at `localhost` during an agent turn; stopped at turn end. Output streams
   * on the `dev:run` channel (see {@link onProcLog}).
   */
  dev: {
    /**
     * Start (or reuse) the project's Vite dev server. Resolves once Vite is
     * serving with its `localhost` URL, or with `unsupported` / `error`. The
     * process keeps running until {@link stop}.
     */
    start: (projectId: string) => Promise<DevServerResult>
    /** Stop the project's Vite dev server (no-op when none is running). */
    stop: (projectId: string) => Promise<void>
    /** True when the project supports a local preview (declares a `dev` script). */
    supported: (projectId: string) => Promise<boolean>
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
    /** Suppress the preview for a transient HTML overlay (dropdown / menu /
     *  modal) without stopping it rendering, so the reveal on close is
     *  flash-free. Parks it off-screen at `bounds`' size so the reveal is a pure
     *  move. Use {@link hide} for durable hides (tab switch / unmount). */
    suppress: (bounds: PreviewBounds) => Promise<void>
    /** Reload the current page. */
    reload: () => Promise<void>
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
    /**
     * Subscribe to agent requests to surface the preview (the Fabricator
     * `fabricator_*` tools emit these so a deploy/validate turn can show the
     * running app). Returns an unsubscribe function.
     */
    onAgentPreview: (cb: (event: PreviewAgentEvent) => void) => () => void
    /**
     * In-preview "design mode". Injects a click-to-edit controller into the
     * preview webview so the user can tweak live elements (move / resize /
     * recolor / text + a Graphein spec editor), then hand the collected changes
     * to the chat composer. Works in both the direct and Fabric-embedded views.
     */
    design: {
      /**
       * Turn design mode on/off (enables/disables the controller). `embedded`
       * marks the Fabric-embedded view, where the app is a cross-origin iframe;
       * `appUrl` (the direct app URL) supplies the origin the top-frame relay
       * uses to find and drive that iframe.
       */
      setEnabled: (enabled: boolean, embedded?: boolean, appUrl?: string) => Promise<void>
      /** Read the controller status (change count + handoff-ready). Polled while on. */
      poll: () => Promise<PreviewDesignStatus | null>
      /** Drain a pending "Send to chat" hand-off (call after capturing a shot). */
      drain: () => Promise<PreviewDesignHandoff | null>
      /** Drain a pending "Generate with AI" request from a placeholder. */
      drainAi: () => Promise<PreviewDesignAiRequest | null>
      /** Inject AI-generated HTML into the placeholder `id` (controller sanitizes it). */
      applyGenerated: (id: string, html: string) => Promise<void>
      /** Supply the placeholder AI model picker with the available models. */
      setModels: (
        models: { id: string; name: string; fast: boolean }[],
        preferred?: string
      ) => Promise<void>
      /**
       * Push Fabricator's own theme (accent/surfaces/text/border + UI scale) so
       * the design tools match the host app's look and zoom. Re-sent after a
       * preview reload (when `poll().hasTheme` is false) and on theme/scale change.
       */
      setTheme: (theme: PreviewDesignTheme) => Promise<void>
      /**
       * Generate a self-contained HTML/CSS snippet for a placeholder from a
       * description, on a transient fast-model session. Returns the raw HTML
       * (the controller sanitizes before injecting). `model` defaults to a fast
       * model; omit for the engine default.
       */
      generateHtml: (
        projectId: string,
        description: string,
        width: number,
        height: number,
        model?: string
      ) => Promise<string>
      /** Drain a pending "Edit with AI" restyle request for a selected element. */
      drainAiEdit: () => Promise<PreviewDesignAiEditRequest | null>
      /** Apply a restyle patch to the element tagged `id` (controller records it). */
      applyRestyle: (id: string, patch: PreviewDesignRestylePatch) => Promise<void>
      /**
       * Restyle an existing element from a natural-language change, on a transient
       * fast-model session. Returns a structured patch (whitelisted inline CSS +
       * optional Graphein spec patch) the controller applies via `applyRestyle`.
       */
      restyleElement: (
        projectId: string,
        description: string,
        context: PreviewDesignRestyleContext,
        model?: string
      ) => Promise<PreviewDesignRestylePatch>
    }
  }

  /** Subscribe to streamed process output. Returns an unsubscribe function. */
  onProcLog: (cb: (event: ProcLogEvent) => void) => () => void
  /** Subscribe to project-delete file-count progress. Returns an unsubscribe function. */
  onDeleteProgress: (cb: (event: DeleteProgressEvent) => void) => () => void
  /** Subscribe to streamed chat events. Returns an unsubscribe function. */
  onChatEvent: (cb: (envelope: ChatEventEnvelope) => void) => () => void
  /** Subscribe to streamed advisor events. Returns an unsubscribe function. */
  onAdvisorEvent: (cb: (envelope: AdvisorEventEnvelope) => void) => () => void
}
