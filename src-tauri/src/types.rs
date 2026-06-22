//! Serde DTOs mirroring `src/shared/ipc.ts`. Field names are serialized as
//! camelCase to match the renderer contract.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/* ----------------------------- versions ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppVersions {
  pub app: String,
  /// Kept for renderer compatibility; reports the Tauri version under Tauri.
  pub electron: String,
  /// WebView2 runtime version on Windows (the embedded browser engine).
  pub chrome: String,
  /// Reports the Rust toolchain version under Tauri (no Node runtime).
  pub node: String,
  pub v8: String,
}

/* ----------------------------- doctor ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
  pub id: String,
  pub name: String,
  pub found: bool,
  pub version: Option<String>,
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
pub struct AuthStatus {
  pub copilot: CopilotAuthStatus,
  pub rayfin: RayfinAuthStatus,
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

/* ----------------------------- templates ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
  pub name: String,
  pub display_name: String,
  pub description: String,
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
pub struct ProjectThread {
  pub id: String,
  pub name: String,
  pub branch: String,
  pub worktree_path: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub copilot_session_id: Option<String>,
  pub status: String,
  pub base_branch: String,
  pub base_commit: String,
  pub created_at: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub merged_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub merge_commit: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_error: Option<String>,
}

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
  #[serde(skip_serializing_if = "Option::is_none")]
  pub model: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub effort: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub missing: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub threads: Option<Vec<ProjectThread>>,
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
  #[serde(skip_serializing_if = "Option::is_none")]
  pub side_threads: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
  #[serde(default = "default_theme")]
  pub theme: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub experiments: Option<ExperimentFlags>,
}

fn default_theme() -> String {
  "system".to_string()
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

/* ----------------------------- files ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
  pub name: String,
  pub path: String,
  pub r#type: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub children: Option<Vec<FileNode>>,
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
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatEventEnvelope {
  pub project_id: String,
  pub thread_id: String,
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

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatOptions {
  #[serde(default)]
  pub model: Option<String>,
  #[serde(default)]
  pub effort: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
  pub id: String,
  pub role: String,
  pub text: String,
  #[serde(default)]
  pub tools: Vec<ChatToolCall>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub attachments: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub kind: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub merge_name: Option<String>,
}

/* ----------------------------- threads ----------------------------- */

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadInput {
  pub project_id: String,
  pub name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThreadActionResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub thread: Option<ProjectThread>,
  pub threads: Vec<ProjectThread>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub had_conflicts: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub merge_commit: Option<String>,
  pub threads: Vec<ProjectThread>,
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
