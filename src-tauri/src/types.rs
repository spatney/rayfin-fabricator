//! Serde DTOs mirroring `src/shared/ipc.ts`. Field names are serialized as
//! camelCase to match the renderer contract.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/* ----------------------------- versions ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppVersions {
  /// The Rayfin Fabricator application version.
  pub app: String,
  /// The Tauri framework version.
  pub tauri: String,
  /// WebView2 runtime version on Windows (the embedded browser engine).
  pub webview2: String,
  /// The bundled GitHub Copilot CLI version (self-reported via `--version`).
  /// `None` if the platform isn't bundled or the probe failed.
  pub copilot: Option<String>,
}

/* ----------------------------- updates ----------------------------- */

/// An available application update, surfaced to the renderer as `AppUpdateInfo`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
  /// The available (newer) version.
  pub version: String,
  /// The currently running app version.
  pub current_version: String,
  /// Release notes / body, when published.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub notes: Option<String>,
  /// Publish date, when present.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub date: Option<String>,
}

/// Background-download progress for an update, streamed on `update:progress`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
  /// Bytes downloaded so far.
  pub downloaded: u64,
  /// Total bytes to download, when the server reports a content length.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub total: Option<u64>,
}

/* ----------------------------- doctor ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
  pub id: String,
  pub name: String,
  pub found: bool,
  /// True when the tool is present *and* meets any minimum-version requirement.
  pub satisfied: bool,
  pub version: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub min_version: Option<String>,
  pub install_hint: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub install_url: Option<String>,
  pub auto_installable: bool,
  pub required: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
  pub tools: Vec<ToolStatus>,
  pub ready: bool,
}

/* ----------------------------- auth ----------------------------- */

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CopilotAuthStatus {
  pub signed_in: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub user: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RayfinAuthStatus {
  pub signed_in: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub user: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tenant: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AzAuthStatus {
  pub signed_in: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub user: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tenant: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
  pub copilot: CopilotAuthStatus,
  pub rayfin: RayfinAuthStatus,
  pub az: AzAuthStatus,
}

/* ----------------------------- fabric ----------------------------- */

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FabricWorkspace {
  pub id: String,
  pub display_name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub r#type: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub capacity_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub region: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub sku: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub capacity_name: Option<String>,
  pub capacity_kind: String,
  pub eligible: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FabricWorkspacesResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspaces: Option<Vec<FabricWorkspace>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub needs_login: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// A dedicated capacity the signed-in user can create a workspace on.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FabricCapacity {
  pub id: String,
  pub display_name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub sku: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub region: Option<String>,
  /// F* = fabric, P* (not PP) = premium, PP* = other (PPU, ineligible).
  pub kind: String,
  pub eligible: bool,
}

/// Outcome of listing eligible Fabric capacities (never throws across IPC).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FabricCapacitiesResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub capacities: Option<Vec<FabricCapacity>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub needs_login: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// Outcome of creating + assigning a new Fabric workspace (never throws).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FabricCreateWorkspaceResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspace_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub needs_login: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FabricDeleteFailure {
  pub name: String,
  pub error: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FabricDeleteResult {
  pub ok: bool,
  pub deleted: u32,
  pub failures: Vec<FabricDeleteFailure>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub needs_login: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/* ----------------------------- processes ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcResult {
  pub ok: bool,
  pub exit_code: Option<i32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenInEditorResult {
  pub opened: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub revealed_folder: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
  pub ok: bool,
  pub exit_code: Option<i32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub requires_relaunch: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub manual: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcLogEvent {
  pub channel: String,
  pub stream: String,
  pub data: String,
}

/// File-count progress streamed while a project's files are moved to the system
/// trash. The trash move is atomic (no per-file callback), so we report the
/// count from an up-front scan of the tree.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProgressEvent {
  /// Project id being deleted (lets the modal match its own delete).
  pub id: String,
  /// `"scanning"` while counting files, `"trashing"` while the OS moves them.
  pub phase: String,
  /// Files counted so far (equals `total` once the scan completes).
  pub processed: u64,
  /// Total files, known once the scan completes.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub total: Option<u64>,
}

/* ----------------------------- templates ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
  pub name: String,
  pub display_name: String,
  pub description: String,
  /// When `Some("fabric")`, projects scaffolded from this template default to the
  /// embedded Fabric portal preview (the toolbar Fabric toggle is on at creation).
  /// Absent for templates that open in the direct app view.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub default_preview_mode: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommunityTemplate {
  pub repo_url: String,
  pub path: String,
  pub name: String,
  pub description: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommunityGallery {
  pub repo_url: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub display_name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  pub templates: Vec<CommunityTemplate>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommunityGalleryResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub gallery: Option<CommunityGallery>,
}

/* ----------------------------- deploy ----------------------------- */

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeployInfo {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub api_url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub portal_url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub status: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub outcome: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub commit: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeployResult {
  pub ok: bool,
  pub outcome: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub api_url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub portal_url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeployStatus {
  pub deployed: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub api_url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub portal_url: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FabricDeployment {
  pub workspace_name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub name: Option<String>,
  pub active: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspace_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub item_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub api_url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub hosting_url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub deployed_at: Option<String>,
}

/* ----------------------------- projects ----------------------------- */

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudioProject {
  pub id: String,
  pub name: String,
  pub path: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub template: Option<String>,
  pub added_at: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_deploy: Option<DeployInfo>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub copilot_session_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspace: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspace_name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub deployment_names: Option<std::collections::HashMap<String, String>>,
  /// Set when a project is freshly created in-app and has never been deployed.
  /// Drives the onboarding "deploy first" gate (the chat composer is disabled
  /// until a deployment exists). Cleared on the first successful deploy. Never
  /// set for projects opened from disk, so opening an existing app is not gated.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub awaiting_first_deploy: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub model: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub effort: Option<String>,
  /// Preview pane view selection: `"fabric"` shows the app embedded in the Fabric
  /// portal shell (`last_deploy.portal_url`); absent / `"direct"` shows the app
  /// URL directly. Persisted so the Fabricator agent's screenshot/navigate tools
  /// honour the same view the user is looking at.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub preview_mode: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub missing: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsState {
  pub workspace_root: String,
  pub active_project_id: Option<String>,
  pub projects: Vec<StudioProject>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentFlags {
  /// Auto-refresh the Advisor review when its results go stale (opt-in).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub advisor_auto_run: Option<bool>,
  /// Force WebView2 software/compatibility rendering (disables GPU acceleration).
  /// Fixes freezing/hangs in VMs such as Parallels where the virtualized GPU
  /// misbehaves. Read at startup and applied before the window is created, so a
  /// change only takes effect after the app is relaunched. Opt-in (off by default).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub compatibility_rendering: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
  #[serde(default = "default_theme")]
  pub theme: String,
  /// UI zoom factor (1.0 = 100%). Scales the whole interface so text is legible
  /// on large/high-DPI monitors. Clamped to 0.8–2.0 when applied.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub ui_scale: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub experiments: Option<ExperimentFlags>,
}

fn default_theme() -> String {
  "dark".to_string()
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
  pub name: String,
  pub template: String,
  #[serde(default)]
  pub template_name: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActionResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub project: Option<StudioProject>,
}

/* ----------------------------- git ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
  pub is_repo: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub branch: Option<String>,
  pub changed_count: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub no_commits: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub status: GitStatus,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
  pub hash: String,
  pub short_hash: String,
  pub subject: String,
  pub author: String,
  pub relative_date: String,
  pub iso_date: String,
  pub files_changed: u32,
  pub insertions: u32,
  pub deletions: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitHistory {
  pub is_repo: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub no_commits: Option<bool>,
  pub commits: Vec<GitCommitSummary>,
  pub working_changes: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub head: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub head: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub no_changes: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
  pub path: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub old_path: Option<String>,
  pub status: String,
  pub insertions: u32,
  pub deletions: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub binary: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
  pub path: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub old_path: Option<String>,
  pub status: String,
  pub before: String,
  pub after: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub binary: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub too_large: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// Sync state of the project's current branch against its remote-tracking branch.
/// `ahead` = local commits not yet pushed; `behind` = remote commits not yet pulled.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteStatus {
  pub is_repo: bool,
  /// True when the repository has at least one configured remote.
  pub has_remote: bool,
  /// True when the current branch has an upstream/tracking branch set.
  pub has_upstream: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub branch: Option<String>,
  /// Local commits not on the upstream (pushable).
  pub ahead: u32,
  /// Upstream commits not in the local branch (pullable).
  pub behind: u32,
  /// Present when a `git fetch` was attempted but failed (e.g. offline/auth).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub fetch_error: Option<String>,
}

/// Result of a pull or push. Carries refreshed working-tree + remote status so the
/// renderer can update without a second round-trip.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  /// `Some(true)` when a pull couldn't be combined automatically (rebase conflict,
  /// aborted and restored). Distinct from a generic error so the UI can phrase it.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub conflict: Option<bool>,
  pub status: GitStatus,
  pub remote: GitRemoteStatus,
}

/* ----------------------------- files ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
  pub name: String,
  pub path: String,
  pub r#type: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub children: Option<Vec<FileNode>>,
  /// `Some(true)` when git ignores this path (set only for ignored nodes).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub ignored: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
  pub path: String,
  pub size: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub content: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub binary: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub too_large: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/* ----------------------------- chat ----------------------------- */

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ChatToolState {
  Running,
  Success,
  Error,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolCall {
  pub id: String,
  pub name: String,
  pub title: String,
  pub state: ChatToolState,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub output: Option<String>,
}

/// One chronological slice of an assistant turn (prose or a tool call), used to
/// persist the interleaved order of the model's text and the tools it ran. A
/// `Tool` segment references a `ChatToolCall` in `tools` by id.
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatSegment {
  Text { text: String },
  Tool { id: String },
  /// A message the user injected mid-turn (conversation steering), shown inline
  /// in the assistant feed as a small "you interjected" bubble.
  Interjection { text: String },
}

/// Streamed chat events (main -> renderer), tagged by `type`.
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum ChatEvent {
  #[serde(rename = "delta")]
  Delta { text: String },
  #[serde(rename = "tool-start")]
  ToolStart { tool: ChatToolCall },
  #[serde(rename = "tool-end")]
  ToolEnd {
    id: String,
    state: ChatToolState,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
  },
  #[serde(rename = "notice")]
  Notice { text: String },
  #[serde(rename = "error")]
  Error { text: String },
  #[serde(rename = "result")]
  Result {
    ok: bool,
    #[serde(rename = "filesModified")]
    files_modified: Vec<String>,
    #[serde(rename = "ranDeploy")]
    ran_deploy: bool,
  },
  /// Plan mode produced a plan and is awaiting the user's decision. The renderer
  /// shows an approval card; the choice is sent back via `chat_resolve_plan`.
  #[serde(rename = "plan-proposed")]
  PlanProposed {
    #[serde(rename = "requestId")]
    request_id: String,
    summary: String,
    #[serde(rename = "planContent")]
    plan_content: String,
    actions: Vec<String>,
    #[serde(rename = "recommendedAction")]
    recommended_action: String,
  },
  /// A previously-proposed plan was resolved (so the card can dismiss itself).
  #[serde(rename = "plan-resolved")]
  PlanResolved {
    #[serde(rename = "requestId")]
    request_id: String,
  },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatEventEnvelope {
  pub project_id: String,
  pub turn_id: String,
  pub event: ChatEvent,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub files_modified: Vec<String>,
  pub ran_deploy: bool,
}

/// Result of a `chat_steer` call: whether the message interrupted a running turn.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SteerResult {
  /// True when a turn was in flight and the message was handled (interjected, or
  /// routed as plan-revision feedback). False when nothing was running — the
  /// renderer then sends the message as a normal new turn.
  pub steered: bool,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatOptions {
  #[serde(default)]
  pub model: Option<String>,
  #[serde(default)]
  pub effort: Option<String>,
}

/// A Copilot model available to the signed-in user, surfaced in the chat model
/// picker. Trimmed from the SDK's richer `Model` to just what the UI renders.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopilotModel {
  /// Selection id passed to the engine as `--model` (e.g. `"claude-sonnet-4.5"`).
  pub id: String,
  /// Human-friendly display name.
  pub name: String,
  /// Reasoning-effort levels this model supports (empty when it has none).
  pub supported_reasoning_efforts: Vec<String>,
  /// The model's default reasoning effort, when it supports configuring one.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub default_reasoning_effort: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
  pub id: String,
  pub role: String,
  pub text: String,
  #[serde(default)]
  pub tools: Vec<ChatToolCall>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub segments: Option<Vec<ChatSegment>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub attachments: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub attachment_thumbs: Option<Vec<String>>,
  /// Legacy marker for a removed "merge" system event; retained only so old
  /// transcripts deserialize (such messages are dropped on load). See
  /// `history::sanitize`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub kind: Option<String>,
  /// True when an assistant turn was still streaming when the app closed/crashed.
  /// Persisted for the in-flight turn so it can be detected and offered for
  /// "resume" (re-run the prompt) on the next launch; cleared on completion.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub interrupted: Option<bool>,
}

/* ----------------------------- rayfin versions ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RayfinPackageVersion {
  pub name: String,
  pub kind: String,
  pub installed: Option<String>,
  pub latest: Option<String>,
  pub upgradable: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RayfinVersionInfo {
  pub version: Option<String>,
  pub latest: Option<String>,
  pub upgrade_available: bool,
  pub packages: Vec<RayfinPackageVersion>,
}

/* ----------------------------- skills ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
  pub id: String,
  pub title: String,
  pub description: String,
  pub icon: String,
  pub base: bool,
  pub active: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub category: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub custom: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillActionResult {
  pub ok: bool,
  pub skills: Vec<SkillInfo>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
  pub ok: bool,
  pub installed: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub content: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/* ----------------------------- advisor ----------------------------- */

/// One issue the Advisor (Copilot-driven security review) surfaced. Parsed from
/// Copilot's JSON output and forwarded to the renderer, so it is both
/// `Deserialize` (tolerant of omitted fields) and `Serialize`.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorFinding {
  /// Stable-ish id for the finding (the UI falls back to the array index).
  #[serde(default)]
  pub id: String,
  /// Check bucket: `"auth"` (access/authentication) or `"policy"` (data policies).
  #[serde(default)]
  pub category: String,
  /// `"high"` | `"medium"` | `"low"`.
  #[serde(default)]
  pub severity: String,
  #[serde(default)]
  pub title: String,
  #[serde(default)]
  pub detail: String,
  /// Project-relative path the issue lives in, when known.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub file: Option<String>,
  #[serde(default)]
  pub recommendation: String,
}

/// The full Advisor report. Persisted to disk and reloaded, so it is both
/// `Serialize` and `Deserialize` (tolerant of older/omitted fields).
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorReport {
  /// True when Copilot completed and its JSON report parsed cleanly.
  #[serde(default)]
  pub ok: bool,
  /// One-line human summary (or a raw/error message when `ok` is false).
  #[serde(default)]
  pub summary: String,
  #[serde(default)]
  pub findings: Vec<AdvisorFinding>,
}

/// A saved review: the report plus when it ran, how long it took, and whether the
/// project's code has changed since (recomputed on load via the fingerprint).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorSnapshot {
  pub report: AdvisorReport,
  /// RFC3339 timestamp of when the review completed.
  #[serde(default)]
  pub analyzed_at: String,
  /// Wall-clock duration of the review in milliseconds.
  #[serde(default)]
  pub duration_ms: u64,
  /// True when the code changed since this review (set on load, not persisted meaningfully).
  #[serde(default)]
  pub stale: bool,
  /// Cheap signature of the reviewed source tree, used only for change detection.
  #[serde(default, skip_serializing_if = "String::is_empty")]
  pub fingerprint: String,
}

/// Shape of the JSON block Copilot is asked to emit. Kept separate from
/// [`AdvisorReport`] so `ok` is set by us, not the model.
#[derive(Deserialize, Default)]
pub struct AdvisorRawReport {
  #[serde(default)]
  pub summary: String,
  #[serde(default)]
  pub findings: Vec<AdvisorFinding>,
}

/// Streamed advisor events (main -> renderer), tagged by `type`.
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum AdvisorEvent {
  /// Live status line shown while Copilot scans (from tool activity).
  #[serde(rename = "progress")]
  Progress {
    text: String,
    /// The tool driving this step (for an icon), when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
  },
  #[serde(rename = "error")]
  Error { text: String },
  #[serde(rename = "done")]
  Done { ok: bool },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorEventEnvelope {
  pub project_id: String,
  pub event: AdvisorEvent,
}

/* --------------------------- suggestions --------------------------- */

/// One Copilot-generated starter suggestion shown on the empty Build chat: a
/// short emoji icon plus a single plain-language idea the user can click to
/// prefill the composer. Persisted (cached) and reloaded, so it is both
/// `Serialize` and `Deserialize`.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
  /// A single emoji used as the card's glyph (falls back to a generic one).
  #[serde(default)]
  pub icon: String,
  /// The suggestion text — one concise imperative the user would type.
  #[serde(default)]
  pub text: String,
}

/// A generated (or cached) set of starter suggestions for one project. `ok` is
/// set by us based on whether generation produced any usable suggestions; the
/// renderer falls back to its built-in heuristics when `ok` is false.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionSet {
  /// True when Copilot returned a parseable, non-empty list.
  #[serde(default)]
  pub ok: bool,
  #[serde(default)]
  pub suggestions: Vec<Suggestion>,
  /// Cheap signature of the source tree these were generated from; used to
  /// invalidate the cache when the app's code changes.
  #[serde(default, skip_serializing_if = "String::is_empty")]
  pub fingerprint: String,
}

/// Shape of the JSON block Copilot is asked to emit. Kept separate from
/// [`SuggestionSet`] so `ok`/`fingerprint` are set by us, not the model.
#[derive(Deserialize, Default)]
pub struct SuggestionRaw {
  #[serde(default)]
  pub suggestions: Vec<Suggestion>,
}
