/**
 * Shared contract between the Rust backend and the renderer.
 *
 * Command names, event channel names and the typed surface exposed on
 * `window.api` live here so the Rust `#[tauri::command]`s and the
 * `src/renderer` (DOM) client stay in sync. To add capabilities, extend the
 * `RayfinStudioApi` interface and the `IpcChannels` map together.
 */

import type {
  ChatDesignSummary,
  DesignCommand,
  DesignEnableOptions,
  DesignHostTheme,
  DesignLocateResult,
  DesignLocateTarget,
  DesignPageOutline,
  DesignRestyleContext,
  DesignSnapshot,
  DesignStatus,
  DesignSuggestion,
  DesignVariation
} from './design'
import type {
  AdvisorFinding,
  AdvisorLoadResult,
  AdvisorProjectSnapshot,
  AdvisorRuleResult,
  AdvisorRunRequest,
  AdvisorSnapshot,
  AdvisorUiState,
  AdvisorVerdict,
  ChatAdvisorSummary
} from './advisor/types'

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
  /** True when the version check succeeds and meets any minimum requirement. */
  satisfied: boolean
  version: string | null
  /** The executable was found, but its version check failed. Do not auto-install another copy. */
  checkError?: string
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
  host?: string
  /** Why authentication could not be verified by the bundled chat engine. */
  error?: string
  /**
   * Renderer-only: not verified yet this session (a background check is still
   * running). Treat the account as unknown, not signed out.
   */
  checking?: boolean
}

export interface RayfinAuthStatus {
  signedIn: boolean
  user?: string
  tenant?: string
  error?: string
  /** Renderer-only: not verified yet this session (see {@link CopilotAuthStatus.checking}). */
  checking?: boolean
}

export interface AzAuthStatus {
  signedIn: boolean
  user?: string
  tenant?: string
  /** The directory's display name (or default domain) for `tenant`. */
  tenantName?: string
  error?: string
  /** Renderer-only: not verified yet this session (see {@link CopilotAuthStatus.checking}). */
  checking?: boolean
}

export interface AuthStatus {
  copilot: CopilotAuthStatus
  rayfin: RayfinAuthStatus
  az: AzAuthStatus
}

/** A sign-in `auth.check` can verify on its own (`rayfin` is Microsoft Fabric). */
export type AuthProvider = keyof AuthStatus

/* ------------------------------------------------------------------ *
 * GitHub (optional gh CLI: clone-from-GitHub)
 * ------------------------------------------------------------------ */

/** Availability + sign-in state for the optional `gh` CLI. */
export interface GithubStatus {
  /** True when the `gh` binary is on PATH. */
  ghInstalled: boolean
  /** True only after the GitHub API verifies the CLI's active identity. */
  signedIn: boolean
  user?: string
}

/** A github.com account the GitHub CLI is signed in to. */
export interface GithubAccount {
  login: string
  /** The CLI's active account: Clone from GitHub and the terminal use it. */
  active: boolean
  /** Its stored sign-in still works. */
  signedIn: boolean
}

export interface GithubAccountsResult {
  ghInstalled: boolean
  /** Active account first. */
  accounts: GithubAccount[]
  error?: string
}

/** A Microsoft Fabric account signed in on this computer. */
export interface FabricAccount {
  id: string
  user: string
  tenant?: string
  /** The account deploys, workspace lists, sharing and secrets use. */
  active: boolean
  /** The Rayfin CLI's own sign-in, which `rayfin` in a terminal also uses. */
  shared: boolean
}

export interface FabricAccountsResult {
  /** Active account first. */
  accounts: FabricAccount[]
  /** One OS keychain entry holds every account's tokens (macOS), so signing out of one signs all out. */
  sharedTokenStore: boolean
}

/** An account (a user in a tenant) the Azure CLI is signed in to. */
export interface AzureAccount {
  user: string
  tenant: string
  tenantName?: string
  /** The subscription (or tenant-level entry) that selects it. */
  subscription: string
  /** The Azure CLI's current account, which Fabricator and the terminal use. */
  active: boolean
}

export interface AzureAccountsResult {
  azInstalled: boolean
  /** Active account first. */
  accounts: AzureAccount[]
  error?: string
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

/* ------------------------------------------------------------------ *
 * Team workspaces (experimental; ExperimentFlags.teamWorkspaces)
 *
 * A team workspace is one private GitHub repository holding several Rayfin
 * apps (one per top-level folder). Its pipeline deploys each teammate's
 * preview from pull requests and the published app from `main`, signing in as
 * the workspace's service principal through GitHub OIDC. Team apps never
 * deploy from this computer.
 * ------------------------------------------------------------------ */

/** Workspace-wide settings committed to the repo as `fabricator.workspace.json`. */
export interface TeamManifest {
  schema: number
  name: string
  tenantId: string
  /** Signs in for pushes to main (published apps). */
  deployIdentity: { clientId: string; displayName: string }
  /** Signs in for pull requests (previews only); empty when one identity serves both. */
  previewIdentity?: { clientId: string; displayName: string }
  fabric: {
    production: { id: string; name: string }
    previews: { id: string; name: string }
  }
  settings: { requireReview: boolean }
  templateVersion: number
}

export interface TeamCreateRequest {
  name: string
  /** GitHub account (you or an organization) that owns the repository. */
  owner: string
  ownerIsOrg?: boolean
  capacityId: string
  capacityName?: string
  /** Use an app registration an administrator created (its client ID). */
  existingClientId?: string
  /** The GitHub account to set it up as; the GitHub CLI's active account when absent. */
  account?: string
  /** Where the pipeline runs; absent leaves it to the organization (or GitHub-hosted runners). */
  runner?: TeamRunner
  /**
   * Set up in this repository (`owner/name`), which someone created for the
   * workspace, instead of creating one. It decides the owner.
   */
  existingRepo?: string
}

/** Where a team workspace's pipeline runs. Neither field means GitHub-hosted runners. */
export interface TeamRunner {
  group?: string
  /** A runner needs every label. */
  labels?: string[]
}

/** One `FABRICATOR_RUNS_ON` Actions variable. */
export interface TeamRunnerSource {
  /** As GitHub stores it. */
  value: string
  /** What it means; absent when the pipeline can't use it. */
  runner?: TeamRunner
}

/** Where a team workspace's pipeline runs (owners). */
export interface TeamRunnerInfo {
  ok: boolean
  error?: string
  /** The repository's choice, which wins over the organization's. */
  repository?: TeamRunnerSource
  /** What the organization shares with the repository. */
  organization?: TeamRunnerSource
}

/** A setup or publishing problem, explained in plain language. */
export interface TeamProblem {
  step: string
  message: string
  guidance?: string
  /** Ready-to-send instructions for an administrator. */
  adminNote?: string
  /**
   * 'runner' when no runner ran the pipeline, so the user can choose others;
   * 'sso' when an organization's single sign-on blocked the GitHub CLI's
   * sign-in, so the user can sign in to GitHub again.
   */
  kind?: 'runner' | 'sso'
  /** A page that fixes it, such as the organization's single sign-on. */
  link?: { label: string; url: string }
}

export interface TeamSetupState {
  request: TeamCreateRequest
  completed: string[]
  tenantId?: string
  appId?: string
  appObjectId?: string
  spObjectId?: string
  previewAppId?: string
  previewAppObjectId?: string
  previewSpObjectId?: string
  productionWorkspaceId?: string
  previewsWorkspaceId?: string
  /** 'enforced' when GitHub protects main; 'app' when only Fabricator does. */
  protection?: 'enforced' | 'app'
  /** An existing repository's description before setup changed it. */
  previousDescription?: string
  problem?: TeamProblem
  done: boolean
}

export interface TeamWorkspace {
  id: string
  name: string
  /** `owner/name` on GitHub. */
  repo: string
  defaultBranch: string
  dir: string
  role: 'owner' | 'member' | ''
  addedAt: string
  manifest?: TeamManifest
  /** Present when this computer set the workspace up. */
  setup?: TeamSetupState
  /**
   * The GitHub account Fabricator uses for this workspace, whichever account the
   * GitHub CLI has active. Absent for older workspaces until it's remembered.
   */
  account?: string
}

/** One pipeline deployment of a team app. */
export interface TeamDeployRecord {
  /** `production/<folder>` or `preview/<folder>/<login>`. */
  environment: string
  /** GitHub deployment state: success, failure, error, in_progress, queued, … */
  state: string
  sha?: string
  url?: string
  apiUrl?: string
  portalUrl?: string
  itemId?: string
  workspaceId?: string
  logUrl?: string
  /** e.g. 'data-loss' when a destructive data-model change was refused. */
  reason?: string
  updatedAt?: string
  /** The deployment's public `RAYFIN_PUBLIC_*` settings (for local previews). */
  publicEnv?: Record<string, string>
}

export interface TeamPublishState {
  stage: 'checks' | 'review' | 'merged' | 'deploying' | 'done' | 'failed'
  prNumber?: number
  mergeSha?: string
  error?: string
  dataLoss?: boolean
  runUrl?: string
  runId?: number
  at: string
}

/** Ties a project to its folder in a team workspace. */
export interface TeamBinding {
  workspaceId: string
  folder: string
  worktree: string
  branch?: string
  prNumber?: number
  prUrl?: string
  /** Which deployment the preview shows. */
  view?: 'preview' | 'production'
  preview?: TeamDeployRecord
  production?: TeamDeployRecord
  publish?: TeamPublishState
}

export interface TeamRepoProject {
  folder: string
  name: string
  /** Set once the app is open on this computer. */
  projectId?: string
}

export interface TeamWorkspaceDetail {
  ok: boolean
  error?: string
  workspace?: TeamWorkspace
  projects: TeamRepoProject[]
}

export interface TeamEnvStatus {
  enabled: boolean
  ghInstalled: boolean
  ghSignedIn: boolean
  ghUser?: string
  /** GitHub permissions the CLI's sign-in lacks (repo, read:org, workflow). */
  ghMissingScopes: string[]
  /** The sign-in may delete repositories (only abandoning a setup needs it). */
  ghCanDeleteRepos: boolean
  /** Every account the GitHub CLI is signed in to, active first. The `gh*` fields describe the one asked about. */
  ghAccounts: TeamGhAccount[]
  azSignedIn: boolean
  azUser?: string
  azTenant?: string
  error?: string
}

export interface TeamOwner {
  login: string
  isOrg: boolean
  avatarUrl?: string
  /** Whether you can create private repositories in this organization (absent when GitHub doesn't say). */
  canCreate?: boolean
}

export interface TeamOwnersResult {
  ok: boolean
  error?: string
  owners: TeamOwner[]
}

/** A repository a team workspace could be set up in. */
export interface TeamRepoChoice {
  /** `owner/name`. */
  fullName: string
  description?: string
}

export interface TeamReposResult {
  ok: boolean
  error?: string
  repos: TeamRepoChoice[]
}

/** An account the GitHub CLI is signed in to. */
export interface TeamGhAccount {
  login: string
  /** The CLI's active account. */
  active: boolean
  /** Its stored sign-in works. */
  signedIn: boolean
  /** Required GitHub permissions it lacks. */
  missingScopes: string[]
  canDeleteRepos: boolean
}

export interface TeamInvitation {
  id: number
  repo: string
  inviter?: string
  createdAt?: string
  description?: string
  /** The GitHub account the invitation is for. */
  account?: string
}

export interface TeamDiscovered {
  repo: string
  description?: string
  /** The GitHub account that can see it. */
  account?: string
}

export interface TeamJoinOptions {
  ok: boolean
  error?: string
  invitations: TeamInvitation[]
  discovered: TeamDiscovered[]
}

export interface TeamMember {
  login: string
  avatarUrl?: string
  role: 'owner' | 'member'
  pending: boolean
  invitationId?: number
}

export interface TeamMembersResult {
  ok: boolean
  error?: string
  members: TeamMember[]
  /** The user can invite and remove people: GitHub only lets the repository's admins (not Maintain). */
  canManage: boolean
}

/** Someone with access to a team workspace's Fabric apps. */
export interface TeamFabricPerson {
  principalId: string
  name: string
  email?: string
  /** 'User' or 'Group'. */
  kind: string
  /** The workspaces they can reach: 'published apps' and/or 'previews'. */
  access: string[]
  /** The GitHub member they were given access for, when known. */
  member?: string
}

export interface TeamFabricAccess {
  ok: boolean
  error?: string
  people: TeamFabricPerson[]
}

export interface TeamActionResult {
  ok: boolean
  error?: string
  problem?: TeamProblem
  workspace?: TeamWorkspace
  project?: StudioProject
  /** Files changed by both you and a teammate (repo-relative). */
  conflicts?: string[]
}

/** Something an unfinished setup created, which abandoning it deletes. */
export interface TeamAbandonItem {
  /**
   * What happens to it: deleted (`identity`, `fabric`, `github`, `local`), or
   * kept without what setup added (`trust`: the federated credentials on an app
   * registration you provided; `pipeline`: Fabricator's files and settings in a
   * repository you provided).
   */
  kind: 'identity' | 'trust' | 'fabric' | 'pipeline' | 'github' | 'local'
  /** Client ID, Fabric workspace ID, `owner/name` or folder (as in the setup record). */
  id: string
  name: string
  /** Where to see it (GitHub or the Fabric portal). */
  url?: string
}

/** What abandoning an unfinished setup would delete, looked up live. */
export interface TeamAbandonPlan {
  ok: boolean
  error?: string
  problem?: TeamProblem
  /** In the order they're deleted. */
  items: TeamAbandonItem[]
  /** What stays and why, e.g. an administrator's app registration. */
  kept: string[]
  /** GitHub must allow deleting repositories (`delete_repo`) first. */
  needsDeletePermission: boolean
}

export interface TeamRunStep {
  name: string
  status: string
  conclusion?: string
  startedAt?: string
  completedAt?: string
}

export interface TeamRunStatus {
  id: number
  kind: 'preview' | 'production'
  status: string
  conclusion?: string
  url: string
  sha: string
  steps: TeamRunStep[]
  startedAt?: string
}

export interface TeamPullRequest {
  number: number
  url: string
  draft: boolean
  state: 'open' | 'closed' | 'merged'
  title: string
  author: string
  headSha?: string
  approvals: number
}

/** A team app's working state (app bar Publish control). */
export interface TeamSessionStatus {
  ok: boolean
  error?: string
  branch?: string
  pr?: TeamPullRequest
  /** Saved changes not yet published. */
  unpublished: number
  /** Edits not saved to GitHub yet. */
  dirty: boolean
  /** Teammates' published changes to this app not yet in your branch. */
  behind: number
  /** A merge with teammates' changes is waiting to be resolved. */
  conflicted: boolean
  requireReview: boolean
  run?: TeamRunStatus
  preview?: TeamDeployRecord
  production?: TeamDeployRecord
  publish?: TeamPublishState
  view: 'preview' | 'production'
  viewer?: string
}

export interface TeamReviewRequest {
  workspaceId: string
  repo: string
  pr: TeamPullRequest
}

export interface TeamHealthItem {
  id: string
  label: string
  state: 'ok' | 'warn' | 'error' | 'unknown'
  detail?: string
  repairable: boolean
}

export interface TeamHealth {
  ok: boolean
  error?: string
  items: TeamHealthItem[]
}

/** A file a working copy changes, compared with the published version. */
export interface TeamMapFile {
  /** Repository-relative path. */
  path: string
  change: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
}

/** Someone's working copy of a team app: branch, pull request, changes and preview. */
export interface TeamMapCopy {
  branch: string
  /** GitHub login. */
  author: string
  avatarUrl?: string
  mine: boolean
  pr?: TeamPullRequest
  additions: number
  deletions: number
  changedFiles: number
  commits: number
  /** Edits on this computer that aren't saved to GitHub yet. */
  localEdits: boolean
  /** Teammates' published changes not in this copy yet (this computer only). */
  behind?: number
  review?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | string
  updatedAt?: string
  preview?: TeamDeployRecord
  files: TeamMapFile[]
}

export interface TeamMapApp {
  folder: string
  name: string
  /** On `main`; otherwise it exists only on someone's branch so far. */
  published: boolean
  /** Set when the app is open on this computer. */
  projectId?: string
  production?: TeamDeployRecord
  copies: TeamMapCopy[]
}

export interface TeamMapJob {
  name: string
  /** The app a `Preview <folder>` / `Deploy <folder>` job deploys. */
  folder?: string
  status: string
  conclusion?: string
  startedAt?: string
  completedAt?: string
  url?: string
  steps: TeamRunStep[]
}

/** A run of the workspace's pipeline. */
export interface TeamMapRun {
  id: number
  kind: 'preview' | 'production' | 'verify' | 'manual' | 'other'
  status: string
  conclusion?: string
  url: string
  sha: string
  branch?: string
  title?: string
  actor?: string
  actorAvatar?: string
  prNumber?: number
  startedAt?: string
  updatedAt?: string
  /** Jobs, for runs that haven't finished. */
  jobs: TeamMapJob[]
}

export interface TeamMapMember {
  login: string
  avatarUrl?: string
  role: 'owner' | 'member'
}

/** Everything in a team workspace, for the workspace map. */
export interface TeamMap {
  ok: boolean
  error?: string
  workspace?: TeamWorkspace
  viewer?: string
  apps: TeamMapApp[]
  runs: TeamMapRun[]
  members: TeamMapMember[]
  fetchedAt: string
}

export interface TeamActivity {
  ok: boolean
  error?: string
  runs: TeamMapRun[]
  fetchedAt: string
}

export interface TeamDiffFile {
  path: string
  change: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  /** Unified-diff hunks; absent for binary or very large files. */
  patch?: string
  truncated: boolean
}

export interface TeamDiff {
  ok: boolean
  error?: string
  files: TeamDiffFile[]
  truncated: boolean
}

/** Which copy of an app to read for the overview's data view. */
export interface TeamResourceRequest {
  folder: string
  /** A working copy's branch on GitHub; omitted for the published app. */
  branch?: string
  /** Your copy on this computer, unsaved edits included. */
  local?: boolean
}

/** One copy of an app's config: rayfin.yml, its data model and its functions' source. */
export interface TeamResourceSource {
  folder: string
  branch?: string
  local: boolean
  ok: boolean
  error?: string
  /** Project-relative path → text. */
  files: Record<string, string>
  /** Some files were left out for size. */
  truncated: boolean
}

export interface TeamResources {
  ok: boolean
  error?: string
  sources: TeamResourceSource[]
}

/** Streamed progress of setup (scope = a caller tag) or publish (scope = project id). */
export interface TeamProgressEvent {
  scope: string
  step: string
  state: 'running' | 'done' | 'error' | 'skipped'
  label: string
  detail?: string
}

/** Which team operation a "Diagnose with Copilot" run is about. */
export type TeamDiagnosisKind = 'setup' | 'health' | 'join' | 'pipeline'

/** "Diagnose with Copilot": what failed and what the user saw. */
export interface TeamDiagnoseRequest {
  /** Caller-owned key: routes `team:diagnosis` events; `team.cancel(diagnosisId)` stops the run. */
  diagnosisId: string
  kind: TeamDiagnosisKind
  workspaceId?: string
  projectId?: string
  /** The repository a join targeted (`owner/name`). */
  repo?: string
  /** The GitHub account a join used (a workspace's own account otherwise). */
  account?: string
  runId?: number
  /** A run or log URL, when the run id isn't known. */
  runUrl?: string
  /** The setup step that failed, when there's no `problem` (a picker error). */
  step?: string
  problem?: TeamProblem
  error?: string
  /** What the owner asked for, when setup stopped before the workspace existed. */
  request?: TeamCreateRequest
  health?: TeamHealthItem[]
}

/** One read-only check a diagnosis ran. */
export interface TeamDiagnosisCheck {
  id: string
  label: string
  /** `failed` means the read itself didn't work (its detail says why). */
  state: 'running' | 'done' | 'failed'
  /** What the check found, exactly as sent to Copilot. */
  detail?: string
}

export interface TeamDiagnosisConclusion {
  summary: string
  area: 'github' | 'entra' | 'fabric' | 'pipeline' | 'app' | 'local' | 'unknown'
  /** The app's code needs a change Copilot can make in the Build chat. */
  fixInChat: boolean
}

export type TeamDiagnosisEvent =
  | { type: 'context'; text: string }
  | { type: 'check'; check: TeamDiagnosisCheck }
  /** `reset` discards the text streamed so far (narration before a check). */
  | { type: 'delta'; text: string; reset?: boolean }
  | { type: 'conclusion'; conclusion: TeamDiagnosisConclusion }
  | { type: 'done'; ok: boolean; error?: string }

export interface TeamDiagnosisEnvelope {
  diagnosisId: string
  event: TeamDiagnosisEvent
}

export interface TeamDiagnosisResult {
  ok: boolean
  error?: string
  /** The Markdown answer. */
  text: string
  /** What was sent to Copilot about the failure. */
  context: string
  checks: TeamDiagnosisCheck[]
  conclusion?: TeamDiagnosisConclusion
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

/**
 * One semantic-model connection declared in a project's `fabric.yaml` (active
 * profile). `itemId` is the Power BI dataset id. Surfaced to the Share dialog so
 * the user can see which models will be auto-shared.
 */
export interface SemanticModelRef {
  alias: string
  workspaceId: string
  itemId: string
}

/** The outcome of one grant — the app role assignment, or one model share. */
export interface FabricShareGrant {
  ok: boolean
  /** True when the principal already had the access (idempotent no-op). */
  skipped?: boolean
  error?: string
}

/** The outcome of granting Build on one semantic model, with its identity. */
export interface FabricShareModelGrant {
  alias?: string
  itemId?: string
  workspaceId?: string
  ok: boolean
  skipped?: boolean
  error?: string
}

/** Per-recipient share outcome: directory resolution + app + model grants. */
export interface FabricShareRecipientResult {
  email: string
  resolved: boolean
  principalType?: string
  app: FabricShareGrant
  models: FabricShareModelGrant[]
}

/**
 * Outcome of sharing a deployment's app (+ its different-workspace semantic
 * models) with a set of recipients. Never throws across IPC — a global failure
 * (no cached Fabric session / missing Azure CLI) sets `ok:false` with
 * `needsLogin`/`needsAz`/`error`; partial failures are reported per recipient.
 */
export interface FabricShareResult {
  ok: boolean
  recipients: FabricShareRecipientResult[]
  /** True when there was no cached Fabric session (Rayfin re-login needed). */
  needsLogin?: boolean
  /** True when the Azure CLI isn't signed in (needed to resolve recipients). */
  needsAz?: boolean
  error?: string
}

/** One directory person matched by the Share dialog's autocomplete. */
export interface FabricDirectoryPerson {
  id?: string
  displayName?: string
  email?: string
}

/** Outcome of a directory (people) search — powers Share-dialog autocomplete. */
export interface FabricDirectoryResult {
  ok: boolean
  people: FabricDirectoryPerson[]
  /** True when the Azure CLI isn't signed in (autocomplete degrades quietly). */
  needsAz?: boolean
  needsLogin?: boolean
  error?: string
}

/** One semantic model (dataset) in a workspace, for the connect-model picker. */
export interface WorkspaceModel {
  id?: string
  name?: string
  isRefreshable?: boolean
  configuredBy?: string
  webUrl?: string
}

/** Outcome of listing a workspace's semantic models (never throws). */
export interface WorkspaceModelsResult {
  ok: boolean
  models: WorkspaceModel[]
  /** True when there was no cached Fabric session (Rayfin re-login needed). */
  needsLogin?: boolean
  needsAz?: boolean
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
  | 'refresh:rayfin'
  | 'login:az'
  | 'logout:copilot'
  | 'logout:rayfin'
  | 'logout:az'
  | 'install:rayfin'
  | 'install:copilot'
  | 'install:node'
  | 'install:git'
  | 'install:gh'
  | 'install:az'
  | 'install:setup'
  | 'create:project'
  | 'clone:project'
  | 'deploy:run'
  | 'dev:run'
  | 'dev:register'

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
  | 'auth-cache-error'
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
 * Result of starting a project's Vite dev server for the live local preview.
 * `outcome` is `running` (started, or already up), `unsupported`
 * (no locally installed Vite / Node), `port-busy` (every port the
 * app's sign-in accepts is taken; see `conflict`), or `error`.
 */
export interface DevServerResult {
  ok: boolean
  outcome: 'running' | 'unsupported' | 'port-busy' | 'error'
  /** The `localhost` URL Vite is serving on, when it started successfully. */
  url?: string
  error?: string
  conflict?: PortConflict
  /** Team apps: the deployment the local preview uses (`production` = the published app). */
  backend?: 'preview' | 'production' | 'none'
}

/** A process listening on a local port the live preview needs. */
export interface PortOccupant {
  pid: number
  /** Executable name, e.g. `node.exe`. */
  name: string
  path?: string
  commandLine?: string
}

/** Why the live preview can't start on a sign-in-ready port, and the ways out. */
export interface PortConflict {
  /** The preferred registered port that is taken. */
  port: number
  occupant?: PortOccupant
  /** Another project in this window whose live preview holds `port`. */
  ownProject?: string
  /** Fabricator may offer to stop `occupant`. */
  canStop: boolean
  /** The next free port to register instead. */
  suggestedPort?: number
  /** Registering `suggestedPort` pushes rayfin.yml to the Fabric backend first. */
  needsPush: boolean
}

/**
 * Where the live preview can start: a ready `port`, or a `conflict` to resolve.
 * Both are absent when the project can't run a local preview.
 */
export interface DevPortPlan {
  port?: number
  conflict?: PortConflict
}

/** A local preview's server changed on its own (on `dev:state`). */
export interface DevStateEvent {
  projectId: string
  /** `running`: it stopped answering and was started again. `stopped`: it couldn't be. */
  state: 'running' | 'stopped'
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
  /**
   * Set when the project lives in a GitHub-backed team workspace (experimental).
   * Team projects are deployed by the workspace's pipeline, never locally.
   */
  team?: TeamBinding
  /** True when the folder no longer exists / is no longer a Rayfin project. */
  missing?: boolean
}

export interface ProjectsState {
  /** Folder under which new projects are created. */
  workspaceRoot: string
  /** Currently active project id, or null when none is selected. */
  activeProjectId: string | null
  projects: StudioProject[]
  /** Team workspaces on this computer (empty while the experiment is off). */
  teamWorkspaces?: TeamWorkspace[]
}

export type ThemePreference = 'dark' | 'light' | 'system'

export interface AppSettings {
  /** UI theme; 'system' follows the OS dark/light setting. */
  theme: ThemePreference
  /** UI zoom factor (1 = 100%). Scales the whole interface for large monitors. */
  uiScale?: number
  /** Deploy after successful chat turns (including team pushes). Defaults to true. */
  autoDeploy?: boolean
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
   * Team workspaces: share apps through a private GitHub repository, work on
   * branches, and publish through a pipeline that deploys with a service
   * principal. Team apps never deploy from this computer. Turning it off hides
   * team workspaces without deleting anything.
   */
  teamWorkspaces?: boolean
}

export interface CreateProjectInput {
  name: string
  /**
   * Template the project is scaffolded from: the bundled starter
   * ('fabricator-universal', also used when empty) or a community template URL
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

/** Whether a new project's name is free where it will be saved. */
export interface ProjectNameCheck {
  ok: boolean
  /** Why the name can't be used, in plain language. */
  message?: string
}

/**
 * Whether deploying the active project into a workspace would replace another
 * app: `rayfin up -y` reuses a same-named Rayfin app there on a first deploy.
 */
export interface DeployTargetCheck {
  /** The Fabric item name the project deploys as (`rayfin.yml` `id`). */
  itemName?: string
  /** The existing app's name, when one would be replaced. */
  conflict?: string
  /** The check couldn't run; the deploy isn't blocked. */
  error?: string
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
  /** Current HEAD commit sha (used to flag the deployed commit). */
  head?: string
  /**
   * True when the code at HEAD differs from the deployed commit in anything that
   * ships with the app (agent guidance such as skills is ignored). Absent without
   * a deployment to compare, and for team apps, whose pipeline controls follow it.
   */
  liveDiffers?: boolean
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
  /** Captured tool output once complete (may be truncated for display). While a
   *  shell tool runs this accumulates its live output. */
  output?: string
  /** Full command line for shell tools (`title` carries the description). */
  command?: string
  /** Files the call reads or writes, as reported by the tool (usually absolute). */
  paths?: string[]
  /** Unified diff for file-mutating tools (edit/create/apply_patch). */
  diff?: string
  /** True when `diff` was capped for size. */
  diffTruncated?: boolean
  /** Lines added/removed, counted from the full diff before capping. */
  added?: number
  removed?: number
  /** Exit code reported by a shell tool. */
  exitCode?: number
  /** Epoch ms the renderer saw the call start / finish. */
  startedAt?: number
  endedAt?: number
}

/**
 * One chronological slice of an assistant turn, used to interleave the model's
 * prose with the tool calls it makes (instead of grouping all tools, then all
 * text). A `'tool'` segment references a {@link ChatToolCall} in `tools` by id so
 * tool-state updates stay in one place; a `'question'` segment likewise
 * references a {@link ChatPlanQuestion} in `questions` by id, which docks the
 * question card at the point in the feed where it was asked instead of letting
 * it drift to the bottom as the turn keeps streaming. A `'reasoning'` segment
 * holds the model's readable thinking for one step. Persisted so reloaded turns
 * keep order — every kind must also exist in the Rust `ChatSegment` DTO.
 */
export type ChatSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string }
  | { kind: 'question'; id: string }
  | { kind: 'interjection'; text: string; thumbs?: string[] }
  | { kind: 'reasoning'; id?: string; text: string; startedAt?: number; elapsedMs?: number }

/**
 * Streamed chat events sent from main -> renderer during a turn. The renderer
 * appends 'delta' text to the active assistant bubble and tracks tool calls by id.
 */
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'tool-start'; tool: ChatToolCall }
  | { type: 'tool-output'; id: string; text: string }
  | {
      type: 'tool-end'
      id: string
      state: ChatToolState
      output?: string
      diff?: string
      diffTruncated?: boolean
      added?: number
      removed?: number
      exitCode?: number
    }
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
  /**
   * True when the app has an older copy of this catalog skill than Fabricator
   * ships. Turning the skill on again writes the latest version.
   */
  outdated?: boolean
  /**
   * True when a skill that lives only in this app can be saved to the library
   * (its name is a plain slug no built-in or Rayfin skill uses).
   */
  promotable?: boolean
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

/* ------------------------------------------------------------------ *
 * Function secrets
 * ------------------------------------------------------------------ */

/**
 * One function secret: its name and description from `rayfin/rayfin.yml`, and
 * whether the deployed app has a value. Values are write-only and never returned.
 */
export interface SecretInfo {
  name: string
  /** What it's for, as recorded in `rayfin.yml`. */
  description?: string
  /** Listed in `rayfin.yml`, so functions can reference it by name. */
  declared: boolean
  /** The deployed app has a value for it. */
  stored: boolean
  createdAt?: string
  updatedAt?: string
}

/** Why secrets can't be managed, or `ready`. */
export type SecretsStatus = 'ready' | 'not-deployed' | 'team' | 'update-rayfin' | 'error'

/** A project's secrets (from the Rayfin CLI), or why they can't be managed here. */
export interface SecretsState {
  status: SecretsStatus
  /** With `ready`, every secret; otherwise only the ones `rayfin.yml` lists. */
  secrets: SecretInfo[]
  /** With `team`, each deployment's secrets (read-only): the published app, then your preview. */
  environments?: SecretEnvironment[]
  /** `services.functions.enabled` in `rayfin.yml`: only functions read secrets. */
  functionsEnabled: boolean
  /** The app's Rayfin CLI version, when it's installed. */
  rayfinVersion?: string
  error?: string
  /** The error looks like an expired Fabric sign-in. */
  signIn?: boolean
}

/** One deployment of a team app and its secrets. */
export interface SecretEnvironment {
  kind: 'published' | 'preview'
  /** There's a deployed app to hold secrets. */
  deployed: boolean
  secrets: SecretInfo[]
  /** The app in the Fabric portal, where its secrets can be changed. */
  portalUrl?: string
  /** Why the secrets couldn't be read. */
  error?: string
}

/** Result of setting or deleting a secret. */
export interface SecretActionResult {
  ok: boolean
  error?: string
  /** The error looks like an expired Fabric sign-in. */
  signIn?: boolean
}

/* ------------------------------------------------------------------ *
 * Advisor
 * ------------------------------------------------------------------ */

export type {
  AdvisorCategoryId,
  AdvisorCondition,
  AdvisorDismissReason,
  AdvisorDismissal,
  AdvisorFacts,
  AdvisorFinding,
  AdvisorFindingRecord,
  AdvisorFindingSet,
  AdvisorHandoff,
  AdvisorLoadResult,
  AdvisorLocation,
  AdvisorPackage,
  AdvisorProjectFile,
  AdvisorProjectSnapshot,
  AdvisorQuickRef,
  AdvisorReport,
  AdvisorResolved,
  AdvisorRuleDef,
  AdvisorRuleResult,
  AdvisorRuleStatus,
  AdvisorRunRequest,
  AdvisorSeverity,
  AdvisorSnapshot,
  AdvisorSource,
  AdvisorUiState,
  AdvisorVerdict,
  AdvisorVerdictStatus,
  ChatAdvisorFix,
  ChatAdvisorSummary
} from './advisor/types'

/** Streamed advisor events (main -> renderer). */
export type AdvisorEvent =
  /** A tool call the deep review made (sent on start and again when it finishes). */
  | { type: 'activity'; tool: ChatToolCall }
  /** A finding reported (and evidence-checked) during the deep review. */
  | { type: 'finding'; finding: AdvisorFinding }
  /** Rule outcomes reported as the deep review works through categories. */
  | { type: 'ruleStatus'; results: AdvisorRuleResult[] }
  | { type: 'summary'; text: string }
  | { type: 'error'; text: string }
  | { type: 'done'; ok: boolean }
  /** A chunk of a streamed inline "Explain this finding" answer, routed by explainId. `reset` discards the text so far (narration before a tool call). */
  | { type: 'explainDelta'; explainId: string; text: string; reset?: boolean }
  /** Terminal marker for an inline explanation (ok false carries error). */
  | { type: 'explainDone'; explainId: string; ok: boolean; error?: string }
  /** One re-check outcome from a Verify run, routed by verifyId. */
  | { type: 'verdict'; verifyId: string; verdict: AdvisorVerdict }
  /** Terminal marker for a Verify run (ok false carries error). */
  | { type: 'verifyDone'; verifyId: string; ok: boolean; error?: string }

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
  /** Epoch ms the message was created (shown as its timestamp). */
  createdAt?: number
  /** Durable Plan-mode artifact owned by this assistant turn, when present. */
  plan?: ChatPlanArtifact
  /**
   * Standalone clarifying questions raised by the `ask_user` tool during an
   * Agent-mode turn (no Plan artifact). Rendered as inline question cards on
   * this assistant turn and answered via `chat_resolve_question`.
   */
  questions?: ChatPlanQuestion[]
  /** The Design changes a (user) message carried, shown as a card in the transcript. */
  design?: ChatDesignSummary
  /** The Advisor findings a (user) message handed to Copilot, shown as a card in the transcript. */
  advisor?: ChatAdvisorSummary
  /**
   * The prompt Copilot received when it differs from `text` (a Design turn's
   * structured changes, or a hand-off's full instructions); re-sent by Retry /
   * Try again / Resume.
   */
  prompt?: string
}

/* ------------------------------------------------------------------ *
 * Preview pane (embedded native webview)
 * ------------------------------------------------------------------ */

/**
 * CSS-pixel rectangle relative to the renderer's visual viewport. `pixelRatio`
 * maps it to native physical pixels, including display/browser/pinch zoom.
 * Without `pixelRatio`, coordinates retain the legacy native logical units.
 */
export interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
  pixelRatio?: number
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

/* ------------------------------------------------------------------ *
 * Help assistant
 * ------------------------------------------------------------------ */

/** Where a journal entry came from, used to group the activity journal. */
export type ErrorArea =
  | 'setup'
  | 'auth'
  | 'chat'
  | 'preview'
  | 'deploy'
  | 'git'
  | 'team'
  | 'advisor'
  | 'project'
  | 'ui'
  | 'app'

/** How an error reached the user. Omitted for `info` entries, which aren't shown. */
export type ErrorSurface = 'toast' | 'inline' | 'boundary' | 'unhandled' | 'backend' | 'panic'

/**
 * How much a journal entry matters. `info` records something that went right
 * (or merely happened); `warn` and `error` record trouble.
 */
export type ActivityLevel = 'info' | 'warn' | 'error'

/**
 * One entry in the activity journal the Help assistant reads.
 *
 * Successes are recorded alongside failures on purpose: without them a journal
 * of nothing but errors makes a healthy app look broken, and a problem the user
 * already solved looks like it is still happening.
 */
export interface ErrorReport {
  /** Defaults to `error`. */
  level?: ActivityLevel
  area: ErrorArea
  /**
   * A stable dotted name for what happened, e.g. `deploy.succeeded` or
   * `auth.signin.failed`. Lets the assistant match a later success to an
   * earlier failure instead of comparing prose.
   */
  event?: string
  /** Only meaningful for `warn`/`error`; ignored otherwise. */
  surface?: ErrorSurface
  /** The text the user saw, or a one-line note about what happened. */
  message: string
  /** The operation involved, e.g. `deploy_run`. */
  operation?: string
  /** A stack trace, stderr, or other context. */
  detail?: string
  projectId?: string
  /**
   * True when this came from a development build run from source. Those are a
   * developer's own half-finished edits, not faults in the installed app, so
   * the Help assistant discounts them.
   */
  dev?: boolean
}

/**
 * A safe app operation the Help assistant offered, shown as a button under its
 * answer. Every id maps to something the user could already do from the UI.
 */
export interface HelpAction {
  id:
    | 'open-docs'
    | 'open-project'
    | 'open-home'
    | 'share-app'
    | 'open-team-access'
    | 'open-advisor'
    | 'open-code'
    | 'run-doctor'
    | 'refresh-fabric-auth'
    | 'sign-in-copilot'
    | 'export-diagnostics'
    | 'open-logs'
    | 'report-issue'
    | 'open-settings'
    | 'open-accounts'
  label: string
  /** Set for `open-docs` only. */
  url?: string
  /** Set for `open-project` only: the id of the project to open. */
  target?: string
}

/**
 * A bug report or feature request the assistant wrote from what it found, ready
 * for the user to review and submit. A bug report also carries version and
 * system details.
 */
export interface HelpIssueDraft {
  /** Decides the title prefix and the GitHub label. */
  kind: 'bug' | 'feature'
  title: string
  /** Markdown body, in the user's voice. */
  body: string
}

/** A documentation page an answer rests on. */
export interface HelpCitation {
  title: string
  url: string
}

/** One finished exchange, replayed to give the next question its context. */
export interface HelpTurn {
  question: string
  answer: string
}

/** A completed answer. */
export interface HelpAnswer {
  text: string
  actions: HelpAction[]
  citations: HelpCitation[]
  /** A bug report the assistant wrote for this answer, when it drafted one. */
  issue?: HelpIssueDraft
  elapsedMs: number
}

/**
 * The message a stopped Help turn returns, so the overlay can tell a deliberate
 * stop apart from a failure. Must match `commands::help::STOPPED` in Rust.
 */
export const HELP_STOPPED = 'Stopped.'

/**
 * The Help conversation as the overlay saved it, plus when. The shape of
 * `exchanges` is owned by the renderer and stored opaquely, so adding a field
 * to the UI never silently drops it.
 */
export interface HelpSavedSession {
  /** RFC 3339 timestamp of the last save. */
  savedAt: string
  /** The renderer's conversation, as it was handed over. */
  data: unknown
}

/** One question for the Help assistant. */
export interface HelpAskRequest {
  /** Routes the streamed events back to the question that produced them. */
  askId: string
  question: string
  projectId?: string
  /** Files and folders the user attached, which become readable for this turn. */
  attachments?: string[]
  /**
   * What is true right now — signed-in accounts, tool readiness, the open
   * project. The journal says what happened; these say where things stand, so
   * the assistant can tell a resolved problem from a live one.
   */
  facts?: string[]
  /**
   * Which screen the user is on. Gates the actions the assistant may offer, so
   * it never produces a button that does nothing from where they are standing.
   */
  surface?: 'setup' | 'home' | 'project'
  /** The conversation so far, replayed so follow-up questions have context. */
  history?: HelpTurn[]
  model?: string
}

/** What the assistant has cached to reason from. */
export interface HelpGrounding {
  /** Fabricator's own source is available. */
  sourceReady: boolean
  /** The documentation mirror is available. */
  docsReady: boolean
  /** The git ref the cached source came from, e.g. `v1.9.5`. */
  reference?: string
  /** True when the cached source matches the running build exactly. */
  pinned: boolean
}

/** Streamed Help events, tagged by `type`. */
export type HelpEvent =
  | { type: 'delta'; text: string }
  | { type: 'activity'; tool: ChatToolCall }
  | { type: 'action'; action: HelpAction }
  | { type: 'citation'; citation: HelpCitation }
  | { type: 'issue'; issue: HelpIssueDraft }
  | { type: 'done'; answer: HelpAnswer }
  | { type: 'error'; message: string }

export interface HelpEventEnvelope {
  /** Routes the event to the question that produced it. */
  askId: string
  event: HelpEvent
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
  authRefreshRayfin: 'auth:refreshRayfin',
  authLoginAz: 'auth:loginAz',
  authLogoutCopilot: 'auth:logoutCopilot',
  authLogoutRayfin: 'auth:logoutRayfin',
  authLogoutAz: 'auth:logoutAz',

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
  helpEvent: 'help:event',
  previewNav: 'preview:nav',
  previewAgent: 'preview:agent',
  updateProgress: 'update:progress',
  deleteProgress: 'delete:progress',
  teamProgress: 'team:progress',
  teamDiagnosis: 'team:diagnosis',
  devState: 'dev:state'
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
     * Build a single consolidated diagnostics file (environment + recent errors
     * + recent chat-turn diagnostics + crash/hang log tail), reveal it in the OS
     * file manager, and return its path so it can be attached to a bug report.
     */
    export: () => Promise<string>
    /**
     * Append one error to the journal the Help assistant reads. Best-effort:
     * recording an error must never fail the operation that was already
     * failing, so this never rejects.
     */
    record: (report: ErrorReport) => Promise<void>
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
     * tools first. Detected tools with failed checks are not reinstalled.
     * Successful system installs return requiresRelaunch.
     */
    installAll: () => Promise<InstallResult>
  }

  auth: {
    status: () => Promise<AuthStatus>
    /**
     * Verify only `providers`; the others are omitted from the result. Lets a
     * caller show each sign-in as soon as it's known instead of waiting for the
     * slowest one (the Fabric check runs a project's Rayfin CLI).
     */
    check: (providers: AuthProvider[]) => Promise<Partial<AuthStatus>>
    loginCopilot: (host?: string) => Promise<ProcResult>
    loginRayfin: (tenant?: string, projectId?: string) => Promise<ProcResult>
    /** Explicitly reset the shared CLI credentials, sign in, and verify Fabric access. */
    refreshRayfin: (projectId: string, tenant?: string) => Promise<ProcResult>
    /**
     * Sign in to Azure (`tenant`: an organization's id or domain). Accounts already
     * signed in stay signed in; this one becomes the Azure CLI's current account.
     */
    loginAz: (tenant?: string) => Promise<ProcResult>
    logoutCopilot: () => Promise<ProcResult>
    /** Sign the Fabric account in use out; another signed-in account takes over. */
    logoutRayfin: () => Promise<ProcResult>
    /** Sign the Azure CLI's current account out; another signed-in account takes over. */
    logoutAz: () => Promise<ProcResult>
  }

  /** Several Microsoft Fabric and Azure CLI accounts on this computer. */
  accounts: {
    /** Every Fabric account signed in here, the one in use first. */
    fabric: () => Promise<FabricAccountsResult>
    /**
     * Sign in to another Fabric account and use it (streams on `login:rayfin`).
     * `tenant` picks the organization; `projectId` whose Rayfin CLI to run.
     */
    addFabric: (tenant?: string, projectId?: string) => Promise<ProcResult>
    /** Use another signed-in Fabric account for deploys, sharing and secrets. */
    useFabric: (id: string) => Promise<ProcResult>
    /** Sign a Fabric account out (streams on `logout:rayfin`). */
    signOutFabric: (id: string, projectId?: string) => Promise<ProcResult>
    /** Every account the Azure CLI is signed in to, the current one first. */
    azure: () => Promise<AzureAccountsResult>
    /** Make another signed-in account the Azure CLI's current one. */
    useAzure: (user: string, subscription: string) => Promise<ProcResult>
    /** Sign an account out of the Azure CLI (streams on `logout:az`). */
    signOutAzure: (user: string) => Promise<ProcResult>
  }

  /** Optional GitHub integration (backed by the `gh` CLI) for cloning repos. */
  github: {
    /** gh CLI availability + sign-in state. */
    status: () => Promise<GithubStatus>
    /** Launch an external terminal running `gh auth login --web` (browser flow). */
    login: () => Promise<ProcResult>
    /** Every github.com account the GitHub CLI is signed in to, active first. */
    accounts: () => Promise<GithubAccountsResult>
    /**
     * Open a terminal to sign in to another account; poll {@link accounts}. The
     * CLI's active account stays the same.
     */
    addAccount: () => Promise<ProcResult>
    /** Make `login` the CLI's active account (Clone from GitHub and the terminal use it). */
    switchAccount: (login: string) => Promise<ProcResult>
    /** Remove `login`'s sign-in from the GitHub CLI on this computer. */
    signOutAccount: (login: string) => Promise<ProcResult>
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
    /**
     * List the semantic-model connections declared in the project's `fabric.yaml`
     * active profile — surfaced in the Share dialog so the user can see which
     * models will also be shared. Never throws (empty list when there are none).
     */
    projectSemanticModels: (projectId: string) => Promise<SemanticModelRef[]>
    /**
     * Share a deployment's app with tenant users/groups (by email): grant each
     * Contributor on the app's hosting workspace, and Build on every semantic
     * model the app uses that lives in a different workspace. Never throws —
     * reports per-recipient results plus `needsLogin`/`needsAz`/`error`.
     */
    shareApp: (
      projectId: string,
      workspaceId: string,
      recipients: string[]
    ) => Promise<FabricShareResult>
    /**
     * Search the directory (Microsoft Graph via the Azure CLI) for people
     * matching a name/email fragment — powers the Share dialog's autocomplete.
     * Never throws; reports `needsAz` when the Azure CLI isn't signed in.
     */
    directorySearch: (query: string) => Promise<FabricDirectoryResult>
    /**
     * List the semantic models (datasets) in a Fabric workspace — the data behind
     * the "connect a model from your workspace" picker. Never throws; reports
     * `needsLogin` when the Fabric session has lapsed.
     */
    listWorkspaceModels: (workspaceId: string) => Promise<WorkspaceModelsResult>
    /**
     * Before the active project's first deploy into a workspace, look for a
     * same-named app there that the deploy would replace. Never throws.
     */
    checkDeployTarget: (workspaceId: string) => Promise<DeployTargetCheck>
  }

  projects: {
    /** Current projects state (workspace root, list, active id). */
    state: () => Promise<ProjectsState>
    /** Fetch a community template gallery (defaults to microsoft/awesome-rayfin). */
    communityTemplates: (repoUrl?: string) => Promise<CommunityGalleryResult>
    /**
     * Whether a new project's name is free: in the projects folder, or in a
     * team workspace (its apps and its published-apps Fabric workspace).
     */
    checkName: (name: string, teamWorkspaceId?: string) => Promise<ProjectNameCheck>
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

  /**
   * Function secrets on the project's deployed app, through its Rayfin CLI
   * (`rayfin secret`). Values are write-only: they go to the CLI and are never
   * returned, stored or logged by Fabricator.
   */
  secrets: {
    /** Every secret's name, description and when its value last changed. */
    list: (projectId: string) => Promise<SecretsState>
    /**
     * Add a secret or replace its value. A new name is recorded in `rayfin.yml`
     * (with `description`) and the change is committed.
     */
    set: (projectId: string, name: string, value: string, description?: string) => Promise<SecretActionResult>
    /** Delete a secret from the deployed app and `rayfin.yml`. */
    remove: (projectId: string, name: string) => Promise<SecretActionResult>
  }

  /**
   * Advisor: instant quick checks (run in the renderer over a project snapshot)
   * plus a read-only Copilot deep review on a throwaway session.
   */
  /**
   * The Help assistant: a read-only agent that debugs the user's problem from
   * the error journal, the published docs, and a pinned copy of Fabricator's
   * own source. It can't change anything.
   */
  help: {
    /** What grounding is cached right now, for the overlay's status line. */
    grounding: () => Promise<HelpGrounding>
    /**
     * Download or refresh the source checkout and the docs mirror. Resolves the
     * resulting status; a failure leaves the assistant working with less, so it
     * is reported through the status rather than thrown.
     */
    prepare: (force?: boolean) => Promise<HelpGrounding>
    /**
     * Ask one question. Streams `help:event` deltas, work-log activity, offered
     * actions and citations keyed by `askId`, and resolves the finished answer.
     */
    ask: (request: HelpAskRequest) => Promise<HelpAnswer>
    /** Stop the in-flight answer. Resolves true if one was running. */
    cancel: () => Promise<boolean>
    /**
     * Let the user point the assistant at files or a folder. Whatever is picked
     * becomes a readable root for the next question; nothing else is reachable.
     */
    pickPaths: (directory: boolean, title?: string) => Promise<string[]>
    /**
     * The saved conversation, when one is still fresh enough to resume.
     * Resolves null when there is none, it has gone stale, or it is unreadable.
     */
    loadHistory: () => Promise<HelpSavedSession | null>
    /** Persist the conversation so it survives closing Help and restarting. */
    saveHistory: (data: unknown) => Promise<void>
    /** Forget the saved conversation, for "New conversation". */
    clearHistory: () => Promise<void>
    /** Subscribe to streamed Help events. */
    onEvent: (cb: (envelope: HelpEventEnvelope) => void) => () => void
  }

  advisor: {
    /**
     * Gather everything the quick checks read in one round-trip: the file list
     * (with git-ignored flags), capped contents of the relevant files, and the
     * installed `@microsoft/rayfin-*` package versions.
     */
    collect: (projectId: string) => Promise<AdvisorProjectSnapshot>
    /**
     * Run the Copilot deep review and resolve the saved snapshot. Streams
     * `advisor:event` activity, findings, and rule outcomes as it works. Uses an
     * ephemeral, read-only session so the review never lands in the Build chat.
     * A completed review is persisted and can be reloaded with {@link load}.
     */
    run: (projectId: string, request: AdvisorRunRequest) => Promise<AdvisorSnapshot>
    /** Cancel the in-flight review for a project. Resolves true if one was running. */
    cancel: (projectId: string) => Promise<boolean>
    /**
     * Load the last saved deep review (with `stale` recomputed against the
     * current code) and the renderer-owned lifecycle state, either of which may
     * be null.
     */
    load: (projectId: string) => Promise<AdvisorLoadResult>
    /** Persist the renderer-owned lifecycle state (dismissals, hand-offs, baseline). */
    saveState: (projectId: string, state: AdvisorUiState) => Promise<void>
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
      model?: string,
      effort?: string
    ) => Promise<string>
    /** Cancel the in-flight inline explanation for a project. Resolves true if one was running. */
    explainCancel: (projectId: string) => Promise<boolean>
    /**
     * Re-check deep-review findings after a fix, on a short read-only session.
     * Streams a `verdict` per finding (routed by `verifyId`) and resolves with all
     * verdicts; rejects (and emits `verifyDone` with ok=false) on failure.
     */
    verify: (
      projectId: string,
      verifyId: string,
      findings: AdvisorFinding[],
      model?: string,
      effort?: string
    ) => Promise<AdvisorVerdict[]>
    /** Cancel the in-flight verification for a project. Resolves true if one was running. */
    verifyCancel: (projectId: string) => Promise<boolean>
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
    /**
     * True for uncommitted edits or content changes since the last deployed commit.
     * An unknown deployment baseline also needs a deploy; Git failures reject.
     */
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
   * Automatic live local preview for projects with locally installed Vite.
   * Runs the project's Vite dev server directly (no `rayfin up`) so edits show
   * live at `localhost` during an agent turn; stopped at turn end. It serves on a
   * port listed in rayfin.yml's `allowedRedirectUris` so sign-in works. Output
   * streams on the `dev:run` channel (see {@link onProcLog}).
   */
  dev: {
    /**
     * Where the preview would start: a free, sign-in-ready port, or the
     * conflict to put to the user. Probes only; starts nothing.
     */
    plan: (projectId: string) => Promise<DevPortPlan>
    /**
     * Start (or reuse) the project's Vite dev server, on `port` when given (it
     * must be free and registered) or the first free registered port. Resolves
     * once Vite is serving with its `localhost` URL, or with `unsupported` /
     * `port-busy` / `error`. The process keeps running until {@link stop}.
     */
    start: (projectId: string, port?: number) => Promise<DevServerResult>
    /** Stop the project's dev server (no-op when none is running). */
    stop: (projectId: string) => Promise<void>
    /** True when the project has a locally installed Vite. */
    supported: (projectId: string) => Promise<boolean>
    /**
     * Stop the process the user chose to stop on `port`, only while `pid` still
     * owns it. Rejects with a readable reason otherwise.
     */
    freePort: (port: number, pid: number) => Promise<void>
    /**
     * Add `http://localhost:{port}` to rayfin.yml's allowed redirect URIs and,
     * when the app is deployed, push the settings to Fabric without rebuilding
     * the app. A failed push undoes the rayfin.yml edit. Streams on `dev:register`.
     */
    registerPort: (projectId: string, port: number) => Promise<DeployResult>
    /**
     * A local preview's server changed on its own: `running` (it stopped
     * answering and was started again; the preview reloads) or `stopped` (it
     * couldn't be, with why). Returns the unsubscribe function.
     */
    onState: (callback: (event: DevStateEvent) => void) => () => void
  }

  /**
   * Design mode's model-backed and source-aware helpers. The model calls run on
   * transient, read-only Copilot sessions (never in chat history).
   */
  design: {
    /** Ask a fast model for `count` named alternative looks for one element. */
    variations: (
      projectId: string,
      context: DesignRestyleContext,
      hint?: string,
      count?: number,
      model?: string
    ) => Promise<DesignVariation[]>
    /** Review a page outline (+ optional screenshot) and suggest improvements. */
    polish: (
      projectId: string,
      page: DesignPageOutline,
      screenshotPath?: string,
      model?: string
    ) => Promise<DesignSuggestion[]>
    /** Find the likely source lines behind picked elements (heuristic hints). */
    locate: (projectId: string, targets: DesignLocateTarget[]) => Promise<DesignLocateResult>
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
     * `CapturePreview`). Used for the still frame shown while an overlay hides the
     * native preview, and by Design to attach the previewed changes (full view +
     * element crops) to a chat turn. Rejects when no preview is open or capture fails.
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
     * In-preview Design mode ("visual chat"). The controller injected into every
     * preview frame lets the user point at elements, preview tweaks, and queue
     * changes that are later sent to Copilot as one turn. Works in both the
     * direct and Fabric-embedded views. The host only relays the JSON documents
     * described in `@shared/design`.
     */
    design: {
      /**
       * Turn Design on/off. `embedded` marks the Fabric-embedded view, where the
       * app is a cross-origin iframe; `appUrl` (the direct app URL) supplies the
       * origin the top-frame relay uses to find and drive that iframe. `options`
       * seeds the session (id, queued items, host theme).
       */
      setEnabled: (
        enabled: boolean,
        embedded?: boolean,
        appUrl?: string,
        options?: DesignEnableOptions
      ) => Promise<void>
      /** Read the controller's lightweight status. Polled while Design is on. */
      poll: () => Promise<DesignStatus | null>
      /** Read the queued items (fetched when `poll().version` changes). */
      snapshot: () => Promise<DesignSnapshot | null>
      /** Send a command to the controller; results arrive via `poll().results`. */
      command: (command: DesignCommand) => Promise<void>
      /**
       * Push Fabricator's own theme (accent/surfaces/text/border + UI scale) so
       * the design tools match the host app's look and zoom. Re-sent after a
       * preview reload (when `poll().hasTheme` is false) and on theme/scale change.
       */
      setTheme: (theme: DesignHostTheme) => Promise<void>
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

  /**
   * Team workspaces (experimental). Every call refuses while
   * {@link ExperimentFlags.teamWorkspaces} is off.
   */
  team: {
    /**
     * GitHub CLI and Azure CLI sign-ins. `ghAccounts` lists every GitHub account
     * the CLI is signed in to; the other `gh*` fields describe `account` (the
     * CLI's active account when absent).
     */
    envStatus: (account?: string) => Promise<TeamEnvStatus>
    /**
     * Open a terminal to sign in to GitHub; poll envStatus. With `account`, that
     * account's sign-in is refreshed (adding permissions); otherwise `signedIn`
     * refreshes the active account and `false` signs in to another account.
     * `deleteRepo` also asks for permission to delete repositories. The CLI's
     * active account stays the same.
     */
    githubSignIn: (signedIn: boolean, deleteRepo?: boolean, account?: string) => Promise<ProcResult>
    /** GitHub accounts that can own a workspace set up as `account` (it and its organizations). */
    owners: (account?: string) => Promise<TeamOwnersResult>
    /**
     * Repositories `account` could set a workspace up in: private or internal,
     * administered by it, and not team workspaces yet (suggestions only).
     */
    repos: (account?: string) => Promise<TeamReposResult>
    /** Fabric capacities for the workspace's apps (via the Azure CLI). */
    capacities: () => Promise<FabricCapacitiesResult>
    /** Set up a new team workspace automatically; progress on `team:progress` (scope). */
    create: (request: TeamCreateRequest, scope: string) => Promise<TeamActionResult>
    /** Continue an interrupted setup, optionally with an existing app registration. */
    resumeSetup: (
      workspaceId: string,
      scope: string,
      existingClientId?: string
    ) => Promise<TeamActionResult>
    /** What abandoning an unfinished setup would delete. Changes nothing. */
    abandonPlan: (workspaceId: string) => Promise<TeamAbandonPlan>
    /**
     * Delete what an unfinished setup created and forget the workspace here;
     * progress on `team:progress` (scope).
     */
    abandonSetup: (workspaceId: string, scope: string) => Promise<TeamActionResult>
    /** Stop waiting on a long operation (setup verification or publish). */
    cancel: (key: string) => Promise<boolean>
    /**
     * Pending invitations and team workspaces `account` can join; without it,
     * those of every signed-in account, each marked with its account.
     */
    joinOptions: (account?: string) => Promise<TeamJoinOptions>
    /** Accept an invitation as `account` and join the workspace. */
    acceptInvitation: (invitationId: number, repo: string, account?: string) => Promise<TeamActionResult>
    /** Join a workspace `account` can already change (`owner/name`). */
    join: (repo: string, account?: string) => Promise<TeamActionResult>
    /** The workspace's apps, refreshed from GitHub. */
    detail: (workspaceId: string) => Promise<TeamWorkspaceDetail>
    /** Forget a workspace on this computer (work on GitHub is kept). */
    leave: (workspaceId: string) => Promise<ProjectsState>
    /** Delete a workspace (owners): identity removed, repo archived. */
    delete: (workspaceId: string, deleteFabric: boolean) => Promise<TeamActionResult>
    /** Open a team app on a working branch (resuming your open changes). */
    openProject: (workspaceId: string, folder: string) => Promise<TeamActionResult>
    /** Create a new app in a team workspace (streams on `create:project`). */
    createProject: (workspaceId: string, input: CreateProjectInput) => Promise<TeamActionResult>
    /** Copy a local project into a team workspace as a new team app. */
    moveProject: (workspaceId: string, projectId: string) => Promise<TeamActionResult>
    /** Remove an app from the workspace (owners), optionally deleting its Fabric apps. */
    removeProject: (
      workspaceId: string,
      folder: string,
      deleteApps: boolean
    ) => Promise<TeamActionResult>
    /** Save the app's changes to its working branch (deploys your preview). */
    sync: (projectId: string, message: string) => Promise<TeamActionResult>
    /** Working state; `refresh` also asks GitHub (PR, deployments, pipeline run). */
    status: (projectId: string, refresh: boolean) => Promise<TeamSessionStatus>
    /** Bring in teammates' published changes; `keepConflicts` leaves them for Copilot. */
    update: (projectId: string, keepConflicts: boolean) => Promise<TeamActionResult>
    /** Throw away unpublished changes and start fresh from the published app. */
    discard: (projectId: string) => Promise<TeamActionResult>
    /** Show your preview or the published app in the preview pane. */
    setView: (projectId: string, view: 'preview' | 'production') => Promise<TeamActionResult>
    runLog: (projectId: string, runId: number) => Promise<string>
    /** Publish (progress on `team:progress` with scope = projectId). */
    publish: (projectId: string, confirmDataLoss: boolean) => Promise<TeamActionResult>
    reviewRequests: () => Promise<TeamReviewRequest[]>
    approve: (workspaceId: string, prNumber: number) => Promise<TeamActionResult>
    members: (workspaceId: string) => Promise<TeamMembersResult>
    invite: (
      workspaceId: string,
      login: string,
      owner: boolean,
      email?: string
    ) => Promise<TeamActionResult>
    grantFabricAccess: (workspaceId: string, email: string, login?: string) => Promise<TeamActionResult>
    /** People who can open the workspace's apps in Fabric (owners). */
    fabricAccess: (workspaceId: string) => Promise<TeamFabricAccess>
    revokeFabricAccess: (workspaceId: string, principalId: string) => Promise<TeamActionResult>
    /** Remove a member (and the Fabric access given to them from this computer). */
    removeMember: (workspaceId: string, login: string, invitationId?: number) => Promise<TeamActionResult>
    setRequireReview: (workspaceId: string, require: boolean) => Promise<TeamActionResult>
    health: (workspaceId: string) => Promise<TeamHealth>
    /** Fix what the health check found, then verify the pipeline. */
    repair: (workspaceId: string, scope: string) => Promise<TeamActionResult>
    /**
     * Use another GitHub account the CLI is signed in to for this workspace. It
     * must be able to change the repository.
     */
    setAccount: (workspaceId: string, account: string) => Promise<TeamActionResult>
    /** Where the workspace's pipeline runs (owners). */
    runner: (workspaceId: string) => Promise<TeamRunnerInfo>
    /**
     * Choose where the pipeline runs (owners): a runner group and/or labels, or
     * neither for the organization's choice or GitHub-hosted runners.
     */
    setRunner: (workspaceId: string, runner: TeamRunner) => Promise<TeamActionResult>
    /** Apps, working copies, deployments, pipeline runs and members (workspace map). */
    map: (workspaceId: string) => Promise<TeamMap>
    /** The pipeline's recent runs, with the steps of those in progress. */
    activity: (workspaceId: string) => Promise<TeamActivity>
    /** A working copy's changes: a pull request's, or your copy here (with unsaved edits). */
    diff: (workspaceId: string, folder: string, prNumber?: number) => Promise<TeamDiff>
    /** Apps' config (data model, functions, connectors), published and in working copies. */
    resources: (workspaceId: string, requests: TeamResourceRequest[]) => Promise<TeamResources>
    /**
     * Diagnose a failed team operation with Copilot (read-only checks plus a
     * streamed answer on `team:diagnosis`); stop it with `cancel(diagnosisId)`.
     */
    diagnose: (request: TeamDiagnoseRequest) => Promise<TeamDiagnosisResult>
    onDiagnosis: (cb: (envelope: TeamDiagnosisEnvelope) => void) => () => void
    onProgress: (cb: (event: TeamProgressEvent) => void) => () => void
  }
}
