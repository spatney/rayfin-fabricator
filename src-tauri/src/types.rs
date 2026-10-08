//! Serde DTOs mirroring `src/shared/ipc.ts`. Field names are serialized as
//! camelCase to match the renderer contract.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/* ----------------------------- versions ----------------------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppVersions {
  /// The Fabricator application version.
  pub app: String,
  /// The Tauri framework version.
  pub tauri: String,
  /// WebView2 runtime version on Windows (the embedded browser engine).
  pub webview2: String,
  /// The GitHub Copilot CLI version actually running, self-reported via
  /// `--version`. The CLI self-updates past the SDK's bundled pin, so this can
  /// be newer than `copilot_bundled`. `None` if the platform isn't bundled or
  /// the probe failed.
  pub copilot: Option<String>,
  /// The SDK's *pinned* bundled CLI version (from the install dir). The renderer
  /// shows it alongside `copilot` when the two differ. Omitted when it can't be
  /// determined (e.g. the platform isn't bundled).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub copilot_bundled: Option<String>,
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
  /// True when the version check succeeds and meets any minimum requirement.
  pub satisfied: bool,
  pub version: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub check_error: Option<String>,
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
  #[serde(skip_serializing_if = "Option::is_none")]
  pub host: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RayfinAuthStatus {
  pub signed_in: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub user: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tenant: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AzAuthStatus {
  pub signed_in: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub user: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tenant: Option<String>,
  /// The directory's display name (or default domain) for `tenant`.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tenant_name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
  pub copilot: CopilotAuthStatus,
  pub rayfin: RayfinAuthStatus,
  pub az: AzAuthStatus,
}

/// The providers one `auth_check` verified; the others are omitted.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthCheck {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub copilot: Option<CopilotAuthStatus>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub rayfin: Option<RayfinAuthStatus>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub az: Option<AzAuthStatus>,
}

/// A Microsoft Fabric account signed in on this computer (one Rayfin CLI config folder).
#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FabricAccount {
  pub id: String,
  pub user: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tenant: Option<String>,
  /// The account deploys, workspace lists, sharing and secrets use.
  pub active: bool,
  /// The Rayfin CLI's own sign-in, which `rayfin` in a terminal also uses.
  pub shared: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FabricAccountsResult {
  /// Active account first.
  pub accounts: Vec<FabricAccount>,
  /// The accounts' tokens live in one OS keychain entry (macOS), so signing
  /// out of one signs them all out.
  pub shared_token_store: bool,
}

/// An account (user in a tenant) the Azure CLI is signed in to.
#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AzureAccount {
  pub user: String,
  pub tenant: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tenant_name: Option<String>,
  /// The subscription (or tenant-level entry) `az account set` selects it with.
  pub subscription: String,
  /// The Azure CLI's current account, which Fabricator and the terminal use.
  pub active: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AzureAccountsResult {
  pub az_installed: bool,
  /// Active account first.
  pub accounts: Vec<AzureAccount>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
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

/// One semantic-model connection declared in a project's `fabric.yaml`
/// (active profile). `item_id` is the Power BI dataset id. Surfaced to the Share
/// dialog so the user can see which models will be auto-shared.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticModelRef {
  pub alias: String,
  pub workspace_id: String,
  pub item_id: String,
}

/// The outcome of one grant (the app role assignment, or one model share).
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FabricShareGrant {
  pub ok: bool,
  /// True when the principal already had the access (idempotent no-op).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub skipped: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// The outcome of granting Build on one semantic model, carrying its identity so
/// the UI can label the row.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FabricShareModelGrant {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub alias: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub item_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspace_id: Option<String>,
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub skipped: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// Per-recipient result: whether the email resolved to a directory principal, and
/// the outcome of the app grant plus each different-workspace model grant.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FabricShareRecipientResult {
  pub email: String,
  pub resolved: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub principal_type: Option<String>,
  pub app: FabricShareGrant,
  pub models: Vec<FabricShareModelGrant>,
}

/// Outcome of sharing a deployment's app (+ its different-workspace semantic
/// models) with a set of recipients. Never throws across IPC — a global failure
/// (no cached session / missing Azure CLI) sets `ok:false` with
/// `needs_login`/`needs_az`/`error`; partial failures are reported per recipient.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FabricShareResult {
  pub ok: bool,
  pub recipients: Vec<FabricShareRecipientResult>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub needs_login: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub needs_az: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

impl FabricShareResult {
  /// Build a global `ok:false` failure (no recipients processed).
  pub fn failure(error: String) -> Self {
    FabricShareResult {
      ok: false,
      recipients: vec![],
      needs_login: None,
      needs_az: None,
      error: Some(error),
    }
  }
}

/// One directory person matched by the Share dialog's autocomplete.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FabricDirectoryPerson {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub display_name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub email: Option<String>,
}

/// Outcome of a directory (people) search. Never throws — a missing/expired
/// Azure CLI sets `needs_az` so the dialog can degrade autocomplete gracefully.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FabricDirectoryResult {
  pub ok: bool,
  pub people: Vec<FabricDirectoryPerson>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub needs_az: Option<bool>,
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
  /// User-facing reason a process failed (e.g. the CLI's `❌ Login failed: …`
  /// stderr line). `None` on success or when no detail could be extracted.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
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
  pub error: Option<String>,
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

/// Result of starting a project's Vite dev server for the live local preview.
/// `outcome` is one of `running` (started or already running),
/// `unsupported` (no local Vite / Node), `port-busy` (every sign-in-ready port
/// is taken; see `conflict`), or `error`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevServerResult {
  pub ok: bool,
  pub outcome: String,
  /// The `localhost` URL Vite is serving on, when it started successfully.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub conflict: Option<PortConflict>,
  /// For team apps, which deployment the local preview uses: `preview` (your
  /// preview), `production` (the published app) or `none`.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub backend: Option<String>,
}

/// A local preview's server changed on its own, on `dev:state`: `running` (back
/// after it stopped answering and was started again) or `stopped` (with why).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DevStateEvent {
  pub project_id: String,
  pub state: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// A process listening on a local port the live preview needs.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortOccupant {
  pub pid: u32,
  /// Executable name, e.g. `node.exe`.
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub command_line: Option<String>,
}

/// Why the live preview can't start on a sign-in-ready port, and the ways out.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortConflict {
  /// The preferred registered port that is taken.
  pub port: u16,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub occupant: Option<PortOccupant>,
  /// Another project in this window whose live preview holds `port`.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub own_project: Option<String>,
  /// Fabricator may offer to stop `occupant`.
  pub can_stop: bool,
  /// The next free port to register instead.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub suggested_port: Option<u16>,
  /// Registering `suggested_port` pushes rayfin.yml to the Fabric backend first.
  pub needs_push: bool,
}

/// Where the live preview can start: a ready `port`, or a `conflict` to resolve.
/// Both are absent when the project can't run a local preview at all.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevPortPlan {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub port: Option<u16>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub conflict: Option<PortConflict>,
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
  /// Set once the automatic "semantic-model app ⇒ embedded Fabric preview" default
  /// has been applied (see [`crate::commands::deploy::run_deploy`]). It makes that
  /// default fire at most once per project, so a later manual switch to the direct
  /// view (persisted as `None`) is never re-overridden on subsequent deploys.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub fabric_preview_defaulted: Option<bool>,
  /// Set when the project lives in a GitHub-backed team workspace (experimental).
  /// Team projects never deploy from this machine: the workspace's pipeline does.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub team: Option<TeamBinding>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub missing: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsState {
  pub workspace_root: String,
  pub active_project_id: Option<String>,
  pub projects: Vec<StudioProject>,
  /// GitHub-backed team workspaces this machine has created or joined.
  #[serde(default)]
  pub team_workspaces: Vec<TeamWorkspace>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentFlags {
  /// Team workspaces: share projects through a GitHub repository, work on
  /// branches, and publish through a pipeline that deploys with a service
  /// principal. Team projects never deploy from this machine. Opt-in (off by
  /// default); turning it off hides team workspaces without deleting anything.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub team_workspaces: Option<bool>,
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
  /// Deploy after successful chat turns, including team pushes. Defaults to on.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub auto_deploy: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub experiments: Option<ExperimentFlags>,
  /// Capture full chat diagnostics (prompt/response text + tool I/O) for bug
  /// reports. Off by default — only lightweight metadata is captured. Opt-in via
  /// Settings → Diagnostics.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub full_diagnostics: Option<bool>,
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

/// Whether a new project's name is free where it will be saved.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNameCheck {
  pub ok: bool,
  /// Why the name can't be used, in plain language (when `ok` is false).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub message: Option<String>,
}

/// Whether deploying the active project into a Fabric workspace would replace
/// someone else's app: `rayfin up -y` reuses a same-named app item there when
/// this project hasn't deployed to that workspace before.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeployTargetCheck {
  /// The Fabric item name the project deploys as (`rayfin.yml` `id`).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub item_name: Option<String>,
  /// The existing app's name, when one would be replaced.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub conflict: Option<String>,
  /// The check couldn't run (the deploy itself isn't blocked).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/* ----------------------------- github ----------------------------- */

/// Sign-in / availability state for the optional `gh` CLI, powering the
/// "Clone from GitHub" flow's gating (install → sign in → browse).
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
  /// True when the `gh` binary is resolvable on `PATH`.
  pub gh_installed: bool,
  /// True only after the GitHub API verifies the CLI's active identity.
  pub signed_in: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub user: Option<String>,
}

/// One github.com account the GitHub CLI is signed in to.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccount {
  pub login: String,
  /// The CLI's active account: Clone from GitHub and the terminal use it.
  pub active: bool,
  /// Its stored sign-in still works.
  pub signed_in: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccountsResult {
  pub gh_installed: bool,
  /// Active account first.
  pub accounts: Vec<GithubAccount>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// One repository entry from `gh repo list` (fields flattened/normalized for the UI).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepo {
  pub name_with_owner: String,
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub visibility: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub updated_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  pub is_private: bool,
  pub is_fork: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub primary_language: Option<String>,
}

/// Result of listing the signed-in user's repositories.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubReposResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub repos: Vec<GithubRepo>,
}

/* ----------------------------- team workspaces ----------------------------- */
// GitHub-backed team workspaces (experimental). A team workspace is one private
// GitHub repository holding several Rayfin projects (one per top-level folder),
// deployed by a pipeline that signs in as a service principal through GitHub
// OIDC. Nothing here is secret: only IDs and URLs are stored.

fn team_manifest_schema() -> u32 {
  1
}

fn team_default_branch() -> String {
  "main".to_string()
}

/// Workspace-wide configuration committed to the team repo as
/// `fabricator.workspace.json`. Projects are discovered by folder, not listed
/// here, so two people adding projects never conflict.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamManifest {
  #[serde(default = "team_manifest_schema")]
  pub schema: u32,
  #[serde(default)]
  pub name: String,
  #[serde(default)]
  pub tenant_id: String,
  /// Signs in for pushes to `main` (published apps).
  #[serde(default)]
  pub deploy_identity: TeamDeployIdentity,
  /// Signs in for pull requests (previews only). Empty in workspaces that use a
  /// single identity (an administrator's app registration).
  #[serde(default)]
  pub preview_identity: TeamDeployIdentity,
  #[serde(default)]
  pub fabric: TeamFabricTargets,
  #[serde(default)]
  pub settings: TeamSettings,
  /// Version of the Fabricator-managed workflow template last written.
  #[serde(default)]
  pub template_version: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamDeployIdentity {
  /// Application (client) ID of the Entra app registration the pipeline uses.
  #[serde(default)]
  pub client_id: String,
  #[serde(default)]
  pub display_name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamFabricTargets {
  /// Where merged (published) apps are deployed.
  #[serde(default)]
  pub production: TeamFabricWorkspace,
  /// Where each teammate's personal previews are deployed.
  #[serde(default)]
  pub previews: TeamFabricWorkspace,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamFabricWorkspace {
  #[serde(default)]
  pub id: String,
  #[serde(default)]
  pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamSettings {
  /// Publishing waits for a teammate's approval.
  #[serde(default)]
  pub require_review: bool,
}

/// What the owner asked for when creating a team workspace. Persisted with the
/// setup state so an interrupted setup can resume.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamCreateRequest {
  pub name: String,
  /// GitHub account (the signed-in user or an organization) that owns the repo.
  pub owner: String,
  #[serde(default)]
  pub owner_is_org: bool,
  /// Fabric capacity for the production and previews workspaces.
  pub capacity_id: String,
  #[serde(default)]
  pub capacity_name: Option<String>,
  /// Use an existing app registration (client ID) instead of creating one.
  #[serde(default)]
  pub existing_client_id: Option<String>,
  /// The GitHub account (login) to set the workspace up as; the GitHub CLI's
  /// active account when absent.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub account: Option<String>,
  /// Where the pipeline's jobs run; absent leaves it to the organization (or
  /// GitHub-hosted runners).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub runner: Option<TeamRunner>,
  /// Set up in this repository (`owner/name`), which someone created for the
  /// workspace, instead of creating one: for organizations where members can't
  /// create repositories.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub existing_repo: Option<String>,
}

/// Where a team workspace's pipeline runs: a runner group and/or runner labels.
/// Neither means GitHub-hosted `ubuntu-latest` runners.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunner {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub group: Option<String>,
  /// A runner needs every label.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub labels: Vec<String>,
}

/// One `FABRICATOR_RUNS_ON` Actions variable.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunnerSource {
  /// The variable as GitHub stores it.
  pub value: String,
  /// What it means; absent when the pipeline can't use it.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub runner: Option<TeamRunner>,
}

/// Where a team workspace's pipeline runs (owners).
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunnerInfo {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  /// The repository's choice, which wins over the organization's.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub repository: Option<TeamRunnerSource>,
  /// What the organization shares with the repository.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub organization: Option<TeamRunnerSource>,
}

/// A setup problem, explained in plain language.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamProblem {
  pub step: String,
  pub message: String,
  /// What the user can do about it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub guidance: Option<String>,
  /// Ready-to-send instructions for an administrator, when only one can fix it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub admin_note: Option<String>,
  /// "runner" when no runner ran the pipeline, so the user can choose others.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub kind: Option<String>,
  /// A page that fixes it, such as GitHub's single sign-on authorization.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub link: Option<TeamLink>,
}

/// A labeled link to a web page.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamLink {
  pub label: String,
  pub url: String,
}

/// Progress of the automatic setup, so it can resume after a failure.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamSetupState {
  pub request: TeamCreateRequest,
  #[serde(default)]
  pub completed: Vec<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub tenant_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub app_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub app_object_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub sp_object_id: Option<String>,
  /// The previews identity (absent when one identity serves both).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub preview_app_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub preview_app_object_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub preview_sp_object_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub production_workspace_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub previews_workspace_id: Option<String>,
  /// "enforced" when GitHub protects `main`, "app" when only Fabricator does.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub protection: Option<String>,
  /// An existing repository's description before setup marked it as a team
  /// workspace (absent when it had none), put back if setup is abandoned.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub previous_description: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub problem: Option<TeamProblem>,
  #[serde(default)]
  pub done: bool,
}

/// A team workspace known to this machine (persisted in `studio.json`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamWorkspace {
  /// Local id (uuid).
  pub id: String,
  pub name: String,
  /// GitHub repository, `owner/name` in its canonical case.
  pub repo: String,
  #[serde(default = "team_default_branch")]
  pub default_branch: String,
  /// Local folder holding the team clone (`.repo`) and one worktree per project.
  pub dir: String,
  /// "owner" (the Maintain or Admin role on the repository) or "member".
  #[serde(default)]
  pub role: String,
  pub added_at: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub manifest: Option<TeamManifest>,
  /// Present while (or after) this machine set the workspace up.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub setup: Option<TeamSetupState>,
  /// The GitHub account (login) Fabricator uses for this workspace, whichever
  /// account the GitHub CLI has active. Absent for workspaces from before
  /// accounts were remembered: those use the active account until one is saved.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub account: Option<String>,
  /// Fabric access granted from this machine: GitHub login (lowercase) → Entra
  /// object ID, so removing the member also removes their access.
  #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
  pub fabric_members: std::collections::BTreeMap<String, String>,
}

/// Someone with access to a team workspace's Fabric apps.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamFabricPerson {
  pub principal_id: String,
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub email: Option<String>,
  /// `User` or `Group`.
  pub kind: String,
  /// The workspaces they can reach: "published apps" and/or "previews".
  pub access: Vec<String>,
  /// The GitHub member they were given access for, when known.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub member: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamFabricAccess {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub people: Vec<TeamFabricPerson>,
}

/// One pipeline deployment of a team project, read from GitHub deployments.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamDeployRecord {
  /// `production/<folder>` or `preview/<folder>/<login>`.
  pub environment: String,
  /// GitHub deployment state: success, failure, error, in_progress, queued, …
  #[serde(default)]
  pub state: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub sha: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub api_url: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub portal_url: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub item_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workspace_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub log_url: Option<String>,
  /// Short machine-readable reason on failure (e.g. `data-loss`).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reason: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub updated_at: Option<String>,
  /// The deployment's `RAYFIN_PUBLIC_*` settings (public: they're built into
  /// the app's web page), used to run a local preview against it.
  #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
  pub public_env: std::collections::BTreeMap<String, String>,
}

/// Where a Publish stopped, so it can resume or report.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamPublishState {
  /// checks | review | merged | deploying | done | failed
  pub stage: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub pr_number: Option<u64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub merge_sha: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  /// The production deploy refused a destructive schema change.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub data_loss: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub run_url: Option<String>,
  /// The production run being followed, so a status refresh can settle it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub run_id: Option<u64>,
  pub at: String,
}

/// Ties a [`StudioProject`] to its folder in a team workspace.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamBinding {
  /// Local [`TeamWorkspace::id`].
  pub workspace_id: String,
  /// Project folder in the repo (also the production Fabric item name).
  pub folder: String,
  /// Root of this project's git worktree.
  pub worktree: String,
  /// The current working branch (`fabricator/<login>/<folder>-<stamp>`).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub branch: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub pr_number: Option<u64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub pr_url: Option<String>,
  /// Which deployment the preview shows: "preview" (yours) or "production".
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub view: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub preview: Option<TeamDeployRecord>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub production: Option<TeamDeployRecord>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub publish: Option<TeamPublishState>,
}

/// One project folder found in a team repository.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRepoProject {
  pub folder: String,
  pub name: String,
  /// The local project, once opened on this machine.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub project_id: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamWorkspaceDetail {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspace: Option<TeamWorkspace>,
  pub projects: Vec<TeamRepoProject>,
}

/// Prerequisites for team workspaces on this machine.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamEnvStatus {
  pub enabled: bool,
  pub gh_installed: bool,
  pub gh_signed_in: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub gh_user: Option<String>,
  /// OAuth scopes the GitHub CLI token lacks (`repo`, `read:org`, `workflow`).
  pub gh_missing_scopes: Vec<String>,
  /// The token may delete repositories (`delete_repo`). Only abandoning an
  /// unfinished setup needs it.
  pub gh_can_delete_repos: bool,
  /// Every account the GitHub CLI is signed in to, active first. The `gh_*`
  /// fields above describe the account asked about (or the active one).
  pub gh_accounts: Vec<TeamGhAccount>,
  pub az_signed_in: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub az_user: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub az_tenant: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// An account the GitHub CLI is signed in to.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamGhAccount {
  pub login: String,
  /// The CLI's active account.
  pub active: bool,
  /// Its stored sign-in works.
  pub signed_in: bool,
  /// Required OAuth scopes it lacks.
  pub missing_scopes: Vec<String>,
  pub can_delete_repos: bool,
}

/// A GitHub account that can own a team repository.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamOwner {
  pub login: String,
  pub is_org: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub avatar_url: Option<String>,
  /// Whether the signed-in account can create private repositories in this
  /// organization; absent when GitHub doesn't say (and for the account itself).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub can_create: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamOwnersResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub owners: Vec<TeamOwner>,
}

/// A repository a team workspace could be set up in.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRepoChoice {
  /// `owner/name`.
  pub full_name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamReposResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub repos: Vec<TeamRepoChoice>,
}

/// A pending invitation to a GitHub repository (possibly a team workspace).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamInvitation {
  pub id: u64,
  pub repo: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub inviter: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub created_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  /// The GitHub account the invitation is for.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub account: Option<String>,
}

/// A repository tagged as a team workspace that this machine hasn't joined.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamDiscovered {
  pub repo: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  /// The GitHub account that can see it.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub account: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamJoinOptions {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub invitations: Vec<TeamInvitation>,
  pub discovered: Vec<TeamDiscovered>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
  pub login: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub avatar_url: Option<String>,
  /// "owner" (the Maintain or Admin role) or "member".
  pub role: String,
  /// Invited but not yet accepted.
  pub pending: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub invitation_id: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamMembersResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub members: Vec<TeamMember>,
  /// The signed-in user can invite and remove people: GitHub only lets the
  /// repository's admins do that (owners with the Maintain role can't).
  pub can_manage: bool,
}

/// Result of a team action; `problem` explains failures in plain language.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamActionResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub problem: Option<TeamProblem>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspace: Option<TeamWorkspace>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub project: Option<StudioProject>,
  /// Set when the action stopped on merge conflicts with teammates' changes.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub conflicts: Option<Vec<String>>,
}

/// Something an unfinished setup created, which abandoning it deletes.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamAbandonItem {
  /// identity | fabric | github | local
  pub kind: String,
  /// Client ID, Fabric workspace ID, `owner/name` or folder: matches the
  /// workspace's setup record, which keeps whatever is left after a problem.
  pub id: String,
  pub name: String,
  /// Where to see it (GitHub or the Fabric portal).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
}

/// What abandoning an unfinished setup would delete, looked up live.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamAbandonPlan {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub problem: Option<TeamProblem>,
  /// In the order they're deleted.
  pub items: Vec<TeamAbandonItem>,
  /// What stays and why, e.g. an administrator's app registration.
  pub kept: Vec<String>,
  /// GitHub must allow deleting repositories (`delete_repo`) first.
  pub needs_delete_permission: bool,
}

/// One step of a GitHub Actions job.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunStep {
  pub name: String,
  pub status: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub conclusion: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub started_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub completed_at: Option<String>,
}

/// The pipeline run deploying a team project.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunStatus {
  pub id: u64,
  /// "preview" or "production".
  pub kind: String,
  pub status: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub conclusion: Option<String>,
  pub url: String,
  pub sha: String,
  pub steps: Vec<TeamRunStep>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub started_at: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamPullRequest {
  pub number: u64,
  pub url: String,
  pub draft: bool,
  pub state: String,
  pub title: String,
  pub author: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub head_sha: Option<String>,
  pub approvals: u32,
}

/// Everything the app bar needs to show a team project's working state.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamSessionStatus {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub branch: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub pr: Option<TeamPullRequest>,
  /// Commits on the working branch that aren't published yet.
  pub unpublished: u32,
  /// Uncommitted edits in the project folder.
  pub dirty: bool,
  /// Teammates' published commits to this project not yet in the branch.
  pub behind: u32,
  /// A merge with teammates' changes is waiting to be resolved.
  pub conflicted: bool,
  pub require_review: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub run: Option<TeamRunStatus>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub preview: Option<TeamDeployRecord>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub production: Option<TeamDeployRecord>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub publish: Option<TeamPublishState>,
  /// "preview" or "production".
  pub view: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub viewer: Option<String>,
}

/// A pull request waiting for the signed-in user's review.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamReviewRequest {
  pub workspace_id: String,
  pub repo: String,
  pub pr: TeamPullRequest,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamHealthItem {
  pub id: String,
  pub label: String,
  /// ok | warn | error | unknown
  pub state: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
  #[serde(default)]
  pub repairable: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamHealth {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub items: Vec<TeamHealthItem>,
}

/// A file a working copy changes, compared with the published version.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMapFile {
  /// Repository-relative path.
  pub path: String,
  /// added | modified | deleted | renamed
  pub change: String,
  pub additions: u32,
  pub deletions: u32,
}

/// Someone's working copy of a team app: their branch and pull request, what
/// it changes, and their personal preview.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMapCopy {
  pub branch: String,
  /// GitHub login.
  pub author: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub avatar_url: Option<String>,
  /// The signed-in user's own copy.
  pub mine: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub pr: Option<TeamPullRequest>,
  pub additions: u32,
  pub deletions: u32,
  pub changed_files: u32,
  pub commits: u32,
  /// Edits on this computer that aren't saved to GitHub yet.
  pub local_edits: bool,
  /// Teammates' published changes not in this copy yet (known on this computer only).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub behind: Option<u32>,
  /// APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED
  #[serde(skip_serializing_if = "Option::is_none")]
  pub review: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub updated_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub preview: Option<TeamDeployRecord>,
  /// The changed files (without their content).
  pub files: Vec<TeamMapFile>,
}

/// One app in the workspace map.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMapApp {
  pub folder: String,
  pub name: String,
  /// The app is on `main` (otherwise it exists only on someone's branch so far).
  pub published: bool,
  /// Set when the app is open on this computer.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub project_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub production: Option<TeamDeployRecord>,
  pub copies: Vec<TeamMapCopy>,
}

/// One job of a pipeline run (one app's preview or deploy, or the plan).
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMapJob {
  pub name: String,
  /// The app the job deploys, for `Preview <folder>` / `Deploy <folder>` jobs.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub folder: Option<String>,
  pub status: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub conclusion: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub started_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub completed_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  pub steps: Vec<TeamRunStep>,
}

/// A run of the workspace's pipeline.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMapRun {
  pub id: u64,
  /// preview | production | verify | manual
  pub kind: String,
  /// queued | in_progress | completed | waiting …
  pub status: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub conclusion: Option<String>,
  pub url: String,
  pub sha: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub branch: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub actor: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub actor_avatar: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub pr_number: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub started_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub updated_at: Option<String>,
  /// Jobs, for runs that haven't finished.
  pub jobs: Vec<TeamMapJob>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMapMember {
  pub login: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub avatar_url: Option<String>,
  /// owner | member
  pub role: String,
}

/// Everything in a team workspace, for the workspace map.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamMap {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspace: Option<TeamWorkspace>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub viewer: Option<String>,
  pub apps: Vec<TeamMapApp>,
  pub runs: Vec<TeamMapRun>,
  pub members: Vec<TeamMapMember>,
  pub fetched_at: String,
}

/// The pipeline's recent runs (what's deploying right now).
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamActivity {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub runs: Vec<TeamMapRun>,
  pub fetched_at: String,
}

/// One file of a working copy's changes, with its (possibly shortened) patch.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamDiffFile {
  pub path: String,
  pub change: String,
  pub additions: u32,
  pub deletions: u32,
  /// Unified-diff hunks; absent for binary or very large files.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub patch: Option<String>,
  /// The patch was shortened (or left out to keep the view fast).
  pub truncated: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamDiff {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub files: Vec<TeamDiffFile>,
  /// Some files were left out.
  pub truncated: bool,
}

/// Which copy of an app to read for the overview's data view.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamResourceRequest {
  pub folder: String,
  /// A working copy's branch on GitHub; none for the published app.
  #[serde(default)]
  pub branch: Option<String>,
  /// Your copy on this computer, unsaved edits included.
  #[serde(default)]
  pub local: bool,
}

/// One copy of an app's config: `rayfin.yml`, its data model and its
/// functions' source, by project-relative path.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamResourceSource {
  pub folder: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub branch: Option<String>,
  pub local: bool,
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub files: std::collections::BTreeMap<String, String>,
  /// Some files were left out for size.
  pub truncated: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamResources {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub sources: Vec<TeamResourceSource>,
}

/// Streamed progress for long team operations (setup, publish), on `team:progress`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamProgressEvent {
  /// The workspace id (setup) or project id (publish) the step belongs to.
  pub scope: String,
  pub step: String,
  /// running | done | error | skipped
  pub state: String,
  pub label: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
}

/* ----------------------------- team diagnosis ----------------------------- */

/// "Diagnose with Copilot": which team operation failed and what the user saw.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TeamDiagnoseRequest {
  /// Renderer-owned key: routes `team:diagnosis` events; `team_cancel` stops the run.
  pub diagnosis_id: String,
  /// setup | health | join | pipeline
  pub kind: String,
  pub workspace_id: Option<String>,
  pub project_id: Option<String>,
  /// The repository a join targeted (`owner/name`).
  pub repo: Option<String>,
  /// The GitHub account a join used (a workspace's own account otherwise).
  pub account: Option<String>,
  /// The failed pipeline run.
  pub run_id: Option<u64>,
  /// A run or log URL, when the run id isn't known.
  pub run_url: Option<String>,
  /// The setup step that failed, when there's no `problem` (a picker error).
  pub step: Option<String>,
  pub problem: Option<TeamProblem>,
  /// The plain error message the user saw.
  pub error: Option<String>,
  /// What the owner asked for, when setup stopped before the workspace existed.
  pub request: Option<TeamCreateRequest>,
  /// The health checklist the user saw.
  pub health: Vec<TeamHealthItem>,
}

/// One read-only check a diagnosis ran.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamDiagnosisCheck {
  /// Unique within a run: the check's name plus its target.
  pub id: String,
  pub label: String,
  /// running | done | failed (the read itself didn't work)
  pub state: String,
  /// What the check found, exactly as sent to Copilot.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
}

/// Copilot's structured conclusion, reported through a tool.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamDiagnosisConclusion {
  pub summary: String,
  /// github | entra | fabric | pipeline | app | local | unknown
  pub area: String,
  /// The app's code needs a change Copilot can make in the Build chat.
  pub fix_in_chat: bool,
}

/// Streamed diagnosis events (main -> renderer), tagged by `type`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type")]
pub enum TeamDiagnosisEvent {
  /// What the diagnosis knows about the failure (sent to Copilot).
  #[serde(rename = "context")]
  Context { text: String },
  /// A check started or finished.
  #[serde(rename = "check")]
  Check { check: TeamDiagnosisCheck },
  /// A chunk of the answer. `reset` discards what was streamed so far: it was
  /// narration before a check, not the answer.
  #[serde(rename = "delta")]
  Delta {
    text: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    reset: bool,
  },
  #[serde(rename = "conclusion")]
  Conclusion { conclusion: TeamDiagnosisConclusion },
  /// Terminal marker (`ok` false carries `error`).
  #[serde(rename = "done")]
  Done {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
  },
}

/// One diagnosis event, routed by `diagnosis_id`, on `team:diagnosis`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamDiagnosisEnvelope {
  pub diagnosis_id: String,
  pub event: TeamDiagnosisEvent,
}

/// A finished (or failed) diagnosis.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamDiagnosisResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  /// The Markdown answer.
  pub text: String,
  /// What was sent to Copilot about the failure.
  pub context: String,
  pub checks: Vec<TeamDiagnosisCheck>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub conclusion: Option<TeamDiagnosisConclusion>,
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
  /// True when the code at HEAD differs from the deployed commit in anything that
  /// ships with the app. Absent without a deployment to compare, and for team apps.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub live_differs: Option<bool>,
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

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "lowercase")]
pub enum ChatToolState {
  #[default]
  Running,
  Success,
  Error,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolCall {
  pub id: String,
  pub name: String,
  pub title: String,
  pub state: ChatToolState,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub output: Option<String>,
  /// Full command line for shell tools (`title` carries the description).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub command: Option<String>,
  /// Files the call reads or writes, as reported by the tool (usually absolute).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub paths: Option<Vec<String>>,
  /// Unified diff for file-mutating tools (edit/create/apply_patch).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub diff: Option<String>,
  /// True when `diff` was capped for size.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub diff_truncated: Option<bool>,
  /// Lines added/removed, counted from the full diff before any capping.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub added: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub removed: Option<u32>,
  /// Exit code reported by a shell tool.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub exit_code: Option<i64>,
  /// Epoch ms the renderer saw the call start/finish (for step durations).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub started_at: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub ended_at: Option<f64>,
}

/// One chronological slice of an assistant turn (prose, a tool call, or a
/// question), used to persist the interleaved order of the model's text and the
/// tools it ran. A `Tool` segment references a `ChatToolCall` in `tools` by id;
/// a `Question` segment references a `ChatPlanQuestion` in `questions` by id so
/// the card re-renders docked where it was asked.
///
/// Every kind the renderer can produce must be listed here: this enum is
/// strictly tagged, so an unrecognised kind would otherwise fail the whole
/// transcript. `Unknown` absorbs kinds written by a newer build.
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatSegment {
  Text { text: String },
  Tool { id: String },
  Question { id: String },
  /// A message the user injected mid-turn (conversation steering), shown inline
  /// in the assistant feed as a small "you interjected" bubble.
  Interjection {
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thumbs: Option<Vec<String>>,
  },
  /// The model's readable reasoning ("thinking") for one step of the turn.
  Reasoning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    text: String,
    #[serde(default, rename = "startedAt", skip_serializing_if = "Option::is_none")]
    started_at: Option<f64>,
    #[serde(default, rename = "elapsedMs", skip_serializing_if = "Option::is_none")]
    elapsed_ms: Option<f64>,
  },
  #[serde(other)]
  Unknown,
}

/// One structured todo item from the session's SQL `todos` table (via
/// `session.plan.readSqlTodosWithDependencies`), normalized for the renderer.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatPlanTodo {
  pub id: String,
  pub title: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  /// One of `"pending" | "in_progress" | "done" | "blocked"`.
  pub status: String,
}

/// One dependency edge from the session's SQL `todo_deps` table: `todo_id`
/// depends on (must follow) `depends_on`.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatPlanDependency {
  pub todo_id: String,
  pub depends_on: String,
}

/// One structured question asked via the `ask_user` tool, persisted alongside
/// its resolution so a reloaded transcript can render the exchange.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatPlanQuestion {
  pub id: String,
  pub question: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub choices: Option<Vec<String>>,
  pub allow_freeform: bool,
  /// One of `"pending" | "answered" | "interrupted"`.
  pub state: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub answer: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub was_freeform: Option<bool>,
}

/// A persisted snapshot of a Plan-mode plan card, attached to the assistant
/// message it belongs to so a reloaded transcript can re-render it (including
/// any edits/questions/todos that accumulated while it was live).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatPlanArtifact {
  pub id: String,
  /// Renderer-owned Plan lifecycle phase, e.g. `"researching"` | `"clarifying"`
  /// | `"drafting"` | `"review"` | `"revising"` | `"executing"` | `"completed"`
  /// | `"failed"` | `"interrupted"` (exact set/naming owned by the frontend;
  /// this DTO passes the string through opaquely for persistence/round-trip).
  pub phase: String,
  pub summary: String,
  pub content: String,
  #[serde(default)]
  pub actions: Vec<String>,
  pub recommended_action: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub selected_action: Option<String>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub todos: Vec<ChatPlanTodo>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub dependencies: Vec<ChatPlanDependency>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub questions: Vec<ChatPlanQuestion>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub edited: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub revision_count: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub live_request_id: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    diff: Option<String>,
    #[serde(rename = "diffTruncated", skip_serializing_if = "Option::is_none")]
    diff_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    removed: Option<u32>,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
  },
  /// Incremental output from a still-running tool (appended by the renderer).
  #[serde(rename = "tool-output")]
  ToolOutput { id: String, text: String },
  /// Streamed readable reasoning; `id` groups the deltas of one reasoning block.
  #[serde(rename = "reasoning")]
  Reasoning { id: String, text: String },
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
  /// The session plan file changed (`session.plan_changed`); `content` is empty
  /// when `operation` is `"delete"`.
  #[serde(rename = "plan-content")]
  PlanContent { content: String, operation: String },
  /// A full snapshot of the session's SQL todos + dependencies
  /// (`session.todos_changed`, re-read via `readSqlTodosWithDependencies`).
  #[serde(rename = "plan-todos")]
  PlanTodos {
    todos: Vec<ChatPlanTodo>,
    dependencies: Vec<ChatPlanDependency>,
  },
  /// The session's agent mode changed (`session.mode_changed`).
  #[serde(rename = "mode-changed")]
  ModeChanged { mode: String },
  /// The `ask_user` tool asked a structured question and is awaiting the user's
  /// answer, sent back via `chat_resolve_question`.
  #[serde(rename = "plan-question")]
  PlanQuestion {
    #[serde(rename = "requestId")]
    request_id: String,
    question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    choices: Option<Vec<String>>,
    #[serde(rename = "allowFreeform")]
    allow_freeform: bool,
  },
  /// A previously-asked question was resolved (so its card can dismiss itself).
  /// Shared by both Plan-mode and Agent-mode questions (routed by `request_id`).
  #[serde(rename = "plan-question-resolved")]
  PlanQuestionResolved {
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    answer: Option<String>,
  },
  /// The `ask_user` tool asked a structured question during an **Agent-mode**
  /// turn (no Plan artifact to attach to). Rendered as a standalone question
  /// card on the assistant turn; answered via `chat_resolve_question`, the same
  /// path Plan-mode questions use.
  #[serde(rename = "agent-question")]
  AgentQuestion {
    #[serde(rename = "requestId")]
    request_id: String,
    question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    choices: Option<Vec<String>>,
    #[serde(rename = "allowFreeform")]
    allow_freeform: bool,
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
  /// A Plan-mode plan card attached to this assistant message, so a reloaded
  /// transcript can re-render its proposed/resolved state.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub plan: Option<ChatPlanArtifact>,
  /// Standalone clarifying questions raised by the `ask_user` tool during an
  /// Agent-mode turn (no Plan artifact). Retained so a reloaded transcript can
  /// re-render the exchange; must round-trip through this DTO or it is dropped
  /// when the renderer persists history.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub questions: Option<Vec<ChatPlanQuestion>>,
  /// Wall-clock duration of an assistant turn, in ms.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub elapsed_ms: Option<f64>,
  /// Epoch ms the message was created (shown as its timestamp).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub created_at: Option<f64>,
  /// The Design changes a user message carried (`ChatDesignSummary`), rendered
  /// as a card in the transcript. Opaque to Rust; must round-trip or it is
  /// dropped when the renderer persists history.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub design: Option<serde_json::Value>,
  /// The Advisor findings a user message handed to Copilot (`ChatAdvisorSummary`),
  /// rendered as a card in the transcript. Opaque to Rust; must round-trip or it
  /// is dropped when the renderer persists history.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub advisor: Option<serde_json::Value>,
  /// The prompt Copilot received when it differs from `text` (a Design turn's
  /// structured changes, or a hand-off's full instructions); re-sent by Retry /
  /// Try again / Resume.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub prompt: Option<String>,
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
  /// True when this custom skill comes from the global, reusable custom-skill
  /// library (as opposed to a project-local, agent-authored skill).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub library: Option<bool>,
  /// True when the app has an older copy of this catalog skill than Fabricator ships.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub outdated: Option<bool>,
  /// True when a skill that lives only in this app can be saved to the library.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub promotable: Option<bool>,
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

/* ------------------------- custom-skill library ------------------------- */

/// One entry in the global, reusable custom-skill library (stored under the app
/// data dir). Presentation fields come from the library folder's `meta.json`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomSkillInfo {
  pub id: String,
  pub title: String,
  pub description: String,
  pub icon: String,
  /// True when the library skill ships extra files under `references/`.
  pub has_references: bool,
}

/// Result of a library mutation (save/import/remove): ok plus the refreshed
/// library, and the affected id when a skill was created or edited.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomSkillActionResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub id: Option<String>,
  pub library: Vec<CustomSkillInfo>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// A read-only preview of a picked skill folder / `.md` / `.zip`, shown before the
/// user commits to adding it. Carries the validated SKILL.md plus the source path
/// to install from on confirm.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomSkillPreview {
  pub ok: bool,
  /// True when the user dismissed the picker (a no-op, not an error).
  pub cancelled: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  /// Absolute path of the picked folder / file, passed back to install on confirm.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub source_path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub content: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub icon: Option<String>,
  /// How many `references/*.md` files would come along.
  pub reference_count: u32,
}

/* ----------------------------- secrets ----------------------------- */

/// One function secret: its name and description from `rayfin/rayfin.yml`, and
/// whether (and when) the deployed app has a value. Values never leave the CLI.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  /// Listed in `rayfin.yml`, so functions can reference it by name.
  pub declared: bool,
  /// The deployed app has a value for it.
  pub stored: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub created_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub updated_at: Option<String>,
}

/// A project's secrets, or why they can't be managed here.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecretsState {
  /// `"ready"` | `"not-deployed"` | `"team"` | `"update-rayfin"` | `"error"`.
  pub status: String,
  /// With `"ready"`, every secret; otherwise the ones `rayfin.yml` lists.
  pub secrets: Vec<SecretInfo>,
  /// With `"team"`, each deployment's secrets (read-only): the published app, then your preview.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub environments: Vec<SecretEnvironment>,
  /// `services.functions.enabled` in `rayfin.yml`.
  pub functions_enabled: bool,
  /// The app's Rayfin CLI version, when it's installed.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub rayfin_version: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  /// The error looks like an expired Fabric sign-in.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub sign_in: Option<bool>,
}

/// One deployment of a team app and its secrets.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecretEnvironment {
  /// `"published"` | `"preview"`.
  pub kind: String,
  /// There's a deployed app to hold secrets.
  pub deployed: bool,
  pub secrets: Vec<SecretInfo>,
  /// The app in the Fabric portal, where its secrets can be changed.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub portal_url: Option<String>,
  /// Why the secrets couldn't be read.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// Result of setting or deleting a secret.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecretActionResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  /// The error looks like an expired Fabric sign-in.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub sign_in: Option<bool>,
}

/* ----------------------------- advisor ----------------------------- */

/// One issue surfaced by a quick check or the Copilot deep review (mirrors
/// `AdvisorFinding` in `src/shared/advisor/types.ts`). Persisted in saved
/// reviews, so every field is `#[serde(default)]`: reviews saved before the rule
/// catalog (v1) still load, and fields missing here would be dropped on save.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorFinding {
  /// Stable id: `quick:<rule>` or `ai:<rule>` (one grouped finding per rule);
  /// legacy reviews carry a model slug.
  #[serde(default)]
  pub id: String,
  /// Catalog rule id; empty for legacy reviews.
  #[serde(default)]
  pub rule_id: String,
  #[serde(default)]
  pub category: String,
  /// `"high"` | `"medium"` | `"low"` | `"note"`.
  #[serde(default)]
  pub severity: String,
  /// `"quick"` | `"ai"` (legacy reviews default to `"ai"`).
  #[serde(default = "default_finding_source")]
  pub source: String,
  #[serde(default)]
  pub title: String,
  #[serde(default)]
  pub detail: String,
  #[serde(default)]
  pub recommendation: String,
  /// Project-relative path the issue lives in, when known.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub file: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub line: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub end_line: Option<u32>,
  /// Code excerpt around the evidence (secret-looking values masked).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub excerpt: Option<String>,
  /// 1-based line number of the excerpt's first line.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub excerpt_start: Option<u32>,
  /// Evidence was checked against the file.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub verified: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub confidence: Option<String>,
  /// A finding-specific doc link (e.g. the page a live-guidance finding cites).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub docs_url: Option<String>,
  /// Further places the same issue occurs.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub locations: Vec<AdvisorLocation>,
}

fn default_finding_source() -> String {
  "ai".to_string()
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorLocation {
  #[serde(default)]
  pub file: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub line: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub end_line: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label: Option<String>,
}

/// Outcome of one deep-review rule: `pass` | `fail` | `na` | `skipped`.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorRuleResult {
  #[serde(default)]
  pub rule_id: String,
  #[serde(default)]
  pub status: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub note: Option<String>,
}

/// The deep-review report. Persisted to disk and reloaded, so it is both
/// `Serialize` and `Deserialize` (tolerant of older/omitted fields).
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorReport {
  /// True when the review completed.
  #[serde(default)]
  pub ok: bool,
  /// One or two sentence overview (or an error message when `ok` is false).
  #[serde(default)]
  pub summary: String,
  #[serde(default)]
  pub findings: Vec<AdvisorFinding>,
  /// Outcome of each deep-review rule evaluated (absent for legacy reviews).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub rules: Option<Vec<AdvisorRuleResult>>,
}

/// A saved deep review: the report plus when it ran, how long it took, and
/// whether the project's code has changed since (recomputed on load).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorSnapshot {
  /// 2 for catalog-based reviews; absent (legacy v1) otherwise.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub schema_version: Option<u32>,
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
  /// Rule catalog version the review ran with.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub catalog_version: Option<String>,
  /// Copilot model used (absent for Auto).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub model: Option<String>,
  /// Rayfin CLI version installed when the review ran.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub rayfin_version: Option<String>,
}

/// Shape of the fenced JSON block a model may still emit instead of calling the
/// reporting tools (legacy fallback). Kept separate from [`AdvisorReport`] so
/// `ok` is set by us, not the model.
#[derive(Deserialize, Default)]
pub struct AdvisorRawReport {
  #[serde(default)]
  pub summary: String,
  #[serde(default)]
  pub findings: Vec<AdvisorFinding>,
}

/// Project facts the deep review is grounded on (computed by the quick checks).
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorFacts {
  #[serde(default)]
  pub services: Vec<String>,
  #[serde(default)]
  pub conditions: Vec<String>,
  #[serde(default)]
  pub entities: Vec<AdvisorFactEntity>,
  #[serde(default)]
  pub versions: Vec<AdvisorFactVersion>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub stack: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorFactEntity {
  #[serde(default)]
  pub name: String,
  #[serde(default)]
  pub file: String,
  #[serde(default)]
  pub access: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorFactVersion {
  #[serde(default)]
  pub name: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub installed: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub latest: Option<String>,
}

/// A quick-check finding the deep review should not repeat.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorQuickRef {
  #[serde(default)]
  pub rule_id: String,
  #[serde(default)]
  pub title: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub file: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub line: Option<u32>,
}

/// Arguments of `advisor_run`.
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorRunRequest {
  #[serde(default)]
  pub model: Option<String>,
  #[serde(default)]
  pub effort: Option<String>,
  #[serde(default)]
  pub facts: AdvisorFacts,
  #[serde(default)]
  pub quick: Vec<AdvisorQuickRef>,
  /// Open findings from the last deep review, to re-check rather than rediscover.
  #[serde(default)]
  pub previous: Vec<AdvisorQuickRef>,
}

/// One Verify outcome: `fixed` | `present` | `unclear`.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorVerdict {
  #[serde(default)]
  pub finding_id: String,
  #[serde(default)]
  pub status: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub note: Option<String>,
}

/// One project file listed by `advisor_collect`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorProjectFile {
  pub path: String,
  pub size: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub ignored: Option<bool>,
}

/// An installed or declared `@microsoft/rayfin-*` package.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorPackage {
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub installed: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub declared: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub dev: Option<bool>,
}

/// Everything the quick checks read, gathered in one IPC round-trip.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorProjectSnapshot {
  pub files: Vec<AdvisorProjectFile>,
  pub contents: std::collections::BTreeMap<String, String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub truncated: Option<bool>,
  pub is_git_repo: bool,
  pub packages: Vec<AdvisorPackage>,
}

/// `advisor_load` result: the saved deep review and the renderer-owned
/// lifecycle state (an opaque JSON document the Rust side only stores).
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorLoadResult {
  pub snapshot: Option<AdvisorSnapshot>,
  pub state: Option<serde_json::Value>,
}

/// Streamed advisor events (main -> renderer), tagged by `type`.
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum AdvisorEvent {
  /// A tool call the deep review made (sent on start and again when it ends).
  #[serde(rename = "activity")]
  Activity { tool: ChatToolCall },
  /// A finding reported (and evidence-checked) during the deep review.
  #[serde(rename = "finding")]
  Finding { finding: AdvisorFinding },
  /// Rule outcomes reported as the review works through categories.
  #[serde(rename = "ruleStatus")]
  RuleStatus { results: Vec<AdvisorRuleResult> },
  #[serde(rename = "summary")]
  Summary { text: String },
  #[serde(rename = "error")]
  Error { text: String },
  #[serde(rename = "done")]
  Done { ok: bool },
  /// A chunk of a streamed inline explanation, routed to the right card by
  /// `explainId` (a key the renderer owns). `reset` discards the text streamed
  /// so far — narration the model wrote before a tool call, not the answer.
  #[serde(rename = "explainDelta", rename_all = "camelCase")]
  ExplainDelta {
    explain_id: String,
    text: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    reset: bool,
  },
  /// Terminal marker for an inline explanation (`ok` false carries `error`).
  #[serde(rename = "explainDone", rename_all = "camelCase")]
  ExplainDone {
    explain_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
  },
  /// One re-check outcome from a Verify run, routed by `verifyId`.
  #[serde(rename = "verdict", rename_all = "camelCase")]
  Verdict { verify_id: String, verdict: AdvisorVerdict },
  /// Terminal marker for a Verify run (`ok` false carries `error`).
  #[serde(rename = "verifyDone", rename_all = "camelCase")]
  VerifyDone {
    verify_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
  },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorEventEnvelope {
  pub project_id: String,
  pub event: AdvisorEvent,
}

/* --------------------------- help assistant --------------------------- */

/// A safe app operation the assistant offered, rendered as a button under its
/// answer. `id` is one of `commands::help::tools::ACTIONS`; the renderer owns
/// what each one does.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelpAction {
  pub id: String,
  pub label: String,
  /// Set for `open-docs` only: the page to open.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  /// Set for `open-project` only: the id of the project to open.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub target: Option<String>,
}

/// A bug report or feature request the assistant wrote from what it found,
/// ready for the user to review and submit. The app appends version and system
/// details to a bug report.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelpIssueDraft {
  /// `bug` or `feature`. Decides the title prefix, the GitHub label, and
  /// whether environment details are worth attaching.
  #[serde(default = "default_issue_kind")]
  pub kind: String,
  pub title: String,
  /// Markdown body, in the user's voice.
  pub body: String,
}

fn default_issue_kind() -> String {
  "bug".to_string()
}

/// A documentation page the answer rests on.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelpCitation {
  pub title: String,
  pub url: String,
}

/// One finished exchange, replayed to give the next question its context.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HelpTurn {
  pub question: String,
  pub answer: String,
}

/// A completed answer.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HelpAnswer {
  pub text: String,
  #[serde(default)]
  pub actions: Vec<HelpAction>,
  #[serde(default)]
  pub citations: Vec<HelpCitation>,
  /// A bug report or feature request the assistant drafted for this answer.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub issue: Option<HelpIssueDraft>,
  pub elapsed_ms: u64,
}

/// One question for the Help assistant.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HelpAskRequest {
  /// Routes the streamed events back to the question that produced them.
  pub ask_id: String,
  pub question: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub project_id: Option<String>,
  /// Files and folders the user attached, which become readable for this turn.
  #[serde(default)]
  pub attachments: Vec<String>,
  /// Short statements of what is true *right now*, supplied by the screen that
  /// opened Help — which setup steps passed, what is deployed, and so on. The
  /// activity journal is history; without this the assistant can only reason
  /// from what went wrong, and will raise a problem the user already fixed.
  #[serde(default)]
  pub facts: Vec<String>,
  /// Where the user is: `setup`, `home`, or a project. Gates the actions the
  /// assistant may offer, so it never produces a button that does nothing from
  /// the screen they are actually on.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub surface: Option<String>,
  /// The conversation so far, replayed so follow-up questions have context.
  #[serde(default)]
  pub history: Vec<HelpTurn>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub model: Option<String>,
}

/// What the assistant has cached to reason from.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HelpGrounding {
  /// Fabricator's own source is available.
  pub source_ready: bool,
  /// The documentation mirror is available.
  pub docs_ready: bool,
  /// The git ref the cached source came from.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reference: Option<String>,
  /// True when the cached source matches the running build exactly.
  pub pinned: bool,
}

/// Streamed Help events (main -> renderer), tagged by `type`.
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum HelpEvent {
  /// A chunk of the streaming answer.
  #[serde(rename = "delta")]
  Delta { text: String },
  /// A tool call the assistant made, for the work log (start, then end).
  #[serde(rename = "activity")]
  Activity { tool: ChatToolCall },
  /// An action the user can take, offered as a button.
  #[serde(rename = "action")]
  Action { action: HelpAction },
  /// A documentation page the answer relies on.
  #[serde(rename = "citation")]
  Citation { citation: HelpCitation },
  /// A bug report the assistant wrote, for the user to review and submit.
  #[serde(rename = "issue")]
  Issue { issue: HelpIssueDraft },
  /// Terminal: the finished answer.
  #[serde(rename = "done")]
  Done { answer: HelpAnswer },
  /// Terminal: the turn failed.
  #[serde(rename = "error")]
  Error { message: String },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HelpEventEnvelope {
  /// Routes the event to the question that produced it.
  pub ask_id: String,
  pub event: HelpEvent,
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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn plan_content_event_serializes_camelcase_with_type_tag() {
    let event = ChatEvent::PlanContent { content: "# Plan".into(), operation: "update".into() };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "plan-content");
    assert_eq!(json["content"], "# Plan");
    assert_eq!(json["operation"], "update");
  }

  #[test]
  fn plan_todos_event_nests_normalized_todo_dtos() {
    let event = ChatEvent::PlanTodos {
      todos: vec![ChatPlanTodo {
        id: "t1".into(),
        title: "Write tests".into(),
        description: None,
        status: "pending".into(),
      }],
      dependencies: vec![ChatPlanDependency { todo_id: "t2".into(), depends_on: "t1".into() }],
    };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "plan-todos");
    assert_eq!(json["todos"][0]["id"], "t1");
    assert_eq!(json["todos"][0]["status"], "pending");
    assert!(json["todos"][0].get("description").is_none());
    assert_eq!(json["dependencies"][0]["todoId"], "t2");
    assert_eq!(json["dependencies"][0]["dependsOn"], "t1");
  }

  #[test]
  fn mode_changed_event_serializes() {
    let event = ChatEvent::ModeChanged { mode: "plan".into() };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "mode-changed");
    assert_eq!(json["mode"], "plan");
  }

  #[test]
  fn plan_question_event_uses_camelcase_field_names() {
    let event = ChatEvent::PlanQuestion {
      request_id: "req-1".into(),
      question: "Which approach?".into(),
      choices: Some(vec!["A".into(), "B".into()]),
      allow_freeform: true,
    };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "plan-question");
    assert_eq!(json["requestId"], "req-1");
    assert_eq!(json["allowFreeform"], true);
    assert_eq!(json["choices"][0], "A");
  }

  #[test]
  fn plan_question_resolved_omits_absent_answer() {
    let event = ChatEvent::PlanQuestionResolved { request_id: "req-1".into(), answer: None };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "plan-question-resolved");
    assert!(json.get("answer").is_none());
  }

  #[test]
  fn agent_question_event_uses_camelcase_field_names() {
    let event = ChatEvent::AgentQuestion {
      request_id: "req-2".into(),
      question: "What theme?".into(),
      choices: Some(vec!["Light".into(), "Dark".into()]),
      allow_freeform: false,
    };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "agent-question");
    assert_eq!(json["requestId"], "req-2");
    assert_eq!(json["allowFreeform"], false);
    assert_eq!(json["choices"][1], "Dark");
  }

  #[test]
  fn agent_question_event_omits_absent_choices() {
    let event = ChatEvent::AgentQuestion {
      request_id: "req-3".into(),
      question: "Describe the tone.".into(),
      choices: None,
      allow_freeform: true,
    };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "agent-question");
    assert!(json.get("choices").is_none());
    assert_eq!(json["allowFreeform"], true);
  }

  #[test]
  fn chat_message_round_trips_with_plan_artifact() {
    let msg = ChatMessage {
      id: "m1".into(),
      role: "assistant".into(),
      text: "Here's the plan".into(),
      tools: vec![],
      segments: None,
      error: None,
      attachments: None,
      attachment_thumbs: None,
      kind: None,
      interrupted: None,
      plan: Some(ChatPlanArtifact {
        id: "req-1".into(),
        phase: "proposed".into(),
        summary: "Refactor the widget".into(),
        content: "# Plan\n1. Do it".into(),
        actions: vec!["interactive".into(), "autopilot".into()],
        recommended_action: "interactive".into(),
        selected_action: None,
        todos: vec![ChatPlanTodo {
          id: "t1".into(),
          title: "Do it".into(),
          description: None,
          status: "pending".into(),
        }],
        dependencies: vec![],
        questions: vec![ChatPlanQuestion {
          id: "q1".into(),
          question: "Ready?".into(),
          choices: None,
          allow_freeform: true,
          state: "pending".into(),
          answer: None,
          was_freeform: None,
        }],
        edited: Some(false),
        revision_count: Some(0),
        error: None,
        live_request_id: Some("req-1".into()),
      }),
      questions: None,
      elapsed_ms: None,
      created_at: None,
      design: None,
      advisor: None,
      prompt: None,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let back: ChatMessage = serde_json::from_str(&json).unwrap();
    let plan = back.plan.expect("plan round-trips");
    assert_eq!(plan.id, "req-1");
    assert_eq!(plan.todos[0].id, "t1");
    assert_eq!(plan.questions[0].id, "q1");
    assert!(plan.dependencies.is_empty());
  }

  #[test]
  fn chat_message_round_trips_standalone_agent_questions() {
    let msg = ChatMessage {
      id: "m1".into(),
      role: "assistant".into(),
      text: "".into(),
      tools: vec![],
      segments: None,
      error: None,
      attachments: None,
      attachment_thumbs: None,
      kind: None,
      interrupted: None,
      plan: None,
      questions: Some(vec![ChatPlanQuestion {
        id: "q1".into(),
        question: "Which theme?".into(),
        choices: Some(vec!["Light".into(), "Dark".into()]),
        allow_freeform: false,
        state: "answered".into(),
        answer: Some("Dark".into()),
        was_freeform: Some(false),
      }]),
      elapsed_ms: None,
      created_at: None,
      design: None,
      advisor: None,
      prompt: None,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let back: ChatMessage = serde_json::from_str(&json).unwrap();
    let questions = back.questions.expect("standalone questions round-trip");
    assert_eq!(questions[0].id, "q1");
    assert_eq!(questions[0].state, "answered");
    assert_eq!(questions[0].answer.as_deref(), Some("Dark"));
    assert!(back.plan.is_none());
  }

  #[test]
  fn chat_message_round_trips_a_design_summary_and_hidden_prompt() {
    let raw = serde_json::json!({
      "id": "u1",
      "role": "user",
      "text": "Make it pop",
      "attachments": 2,
      "attachmentThumbs": ["data:image/png;base64,AA", "data:image/png;base64,BB"],
      "design": {
        "items": [{ "n": 1, "kind": "element", "label": "Button · Save", "summary": "Background: bg-indigo-600 → bg-indigo-700", "shot": 1 }],
        "full": 0
      },
      "prompt": "Make it pop\n\n## Design changes from the live preview (1)"
    });
    let msg: ChatMessage = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(msg.prompt.as_deref(), Some("Make it pop\n\n## Design changes from the live preview (1)"));
    let back = serde_json::to_value(&msg).unwrap();
    assert_eq!(back["design"], raw["design"]);
    assert_eq!(back["prompt"], raw["prompt"]);
    // Plain messages don't grow the new keys.
    let plain: ChatMessage = serde_json::from_str(r#"{"id":"m1","role":"user","text":"hi"}"#).unwrap();
    let json = serde_json::to_value(&plain).unwrap();
    assert!(json.get("design").is_none());
    assert!(json.get("advisor").is_none());
    assert!(json.get("prompt").is_none());
  }

  #[test]
  fn chat_message_round_trips_an_advisor_fix_summary() {
    let raw = serde_json::json!({
      "id": "u1",
      "role": "user",
      "text": "Fix 2 Advisor issues",
      "advisor": {
        "fixes": [
          { "id": "quick:data-model/text-without-max", "ruleId": "data-model/text-without-max", "title": "Text field has no maximum length", "severity": "high", "category": "data-model", "source": "quick", "file": "rayfin/data/Todo.ts", "line": 7, "places": 2 },
          { "id": "ai:accessibility/unlabeled-control", "ruleId": "accessibility/unlabeled-control", "title": "Icon button has no label", "severity": "medium", "category": "accessibility", "source": "ai" }
        ]
      },
      "prompt": "The Advisor found 2 issues in this app."
    });
    let msg: ChatMessage = serde_json::from_value(raw.clone()).unwrap();
    let back = serde_json::to_value(&msg).unwrap();
    assert_eq!(back["advisor"], raw["advisor"]);
    assert_eq!(back["prompt"], raw["prompt"]);
  }

  #[test]
  fn chat_message_without_plan_deserializes_from_legacy_json() {
    // Old transcripts saved before the `plan` field existed must still load.
    let legacy = r#"{"id":"m1","role":"user","text":"hi"}"#;
    let msg: ChatMessage = serde_json::from_str(legacy).unwrap();
    assert!(msg.plan.is_none());
    assert!(msg.tools.is_empty());
  }

  #[test]
  fn chat_message_keeps_turn_timing_tool_details_and_segment_extras() {
    let raw = serde_json::json!({
      "id": "a1",
      "role": "assistant",
      "text": "Done",
      "elapsedMs": 83000,
      "createdAt": 1790412554990.0,
      "tools": [{
        "id": "t1", "name": "edit", "title": "src/App.tsx", "state": "success",
        "output": "ok", "command": "npm run build", "paths": ["C:/p/src/App.tsx"],
        "diff": "@@ -1 +1 @@\n-a\n+b", "diffTruncated": true, "added": 1, "removed": 1,
        "exitCode": 2, "startedAt": 10.0, "endedAt": 20.5
      }],
      "segments": [
        {"kind": "reasoning", "id": "r1", "text": "Considering", "startedAt": 5, "elapsedMs": 1200},
        {"kind": "interjection", "text": "also this", "thumbs": ["data:image/png;base64,AA"]},
        {"kind": "tool", "id": "t1"},
        {"kind": "text", "text": "Done"}
      ]
    });
    let msg: ChatMessage = serde_json::from_value(raw).unwrap();
    let back = serde_json::to_value(&msg).unwrap();
    assert_eq!(back["elapsedMs"], 83000.0);
    assert_eq!(back["createdAt"], 1790412554990.0);
    let tool = &back["tools"][0];
    assert_eq!(tool["command"], "npm run build");
    assert_eq!(tool["paths"][0], "C:/p/src/App.tsx");
    assert_eq!(tool["diffTruncated"], true);
    assert_eq!(tool["added"], 1);
    assert_eq!(tool["removed"], 1);
    assert_eq!(tool["exitCode"], 2);
    assert_eq!(tool["endedAt"], 20.5);
    assert_eq!(back["segments"][0]["kind"], "reasoning");
    assert_eq!(back["segments"][0]["id"], "r1");
    assert_eq!(back["segments"][0]["elapsedMs"], 1200.0);
    assert_eq!(back["segments"][1]["thumbs"][0], "data:image/png;base64,AA");
  }

  #[test]
  fn unknown_segment_kind_does_not_drop_the_transcript() {
    let raw = r#"[{"id":"a1","role":"assistant","text":"hi","segments":[
      {"kind":"text","text":"hi"},{"kind":"fromTheFuture","payload":{"x":1}}]}]"#;
    let msgs: Vec<ChatMessage> = serde_json::from_str(raw).unwrap();
    let segments = msgs[0].segments.as_ref().unwrap();
    assert!(matches!(segments[0], ChatSegment::Text { .. }));
    assert!(matches!(segments[1], ChatSegment::Unknown));
  }

  #[test]
  fn streamed_tool_output_reasoning_and_rich_tool_end_serialize() {
    let out = serde_json::to_value(ChatEvent::ToolOutput { id: "t1".into(), text: "line\n".into() }).unwrap();
    assert_eq!(out["type"], "tool-output");
    assert_eq!(out["text"], "line\n");
    let reasoning = serde_json::to_value(ChatEvent::Reasoning { id: "r1".into(), text: "Hm".into() }).unwrap();
    assert_eq!(reasoning["type"], "reasoning");
    assert_eq!(reasoning["id"], "r1");
    let end = serde_json::to_value(ChatEvent::ToolEnd {
      id: "t1".into(),
      state: ChatToolState::Success,
      output: None,
      diff: Some("@@".into()),
      diff_truncated: Some(false),
      added: Some(3),
      removed: None,
      exit_code: Some(0),
    })
    .unwrap();
    assert_eq!(end["type"], "tool-end");
    assert_eq!(end["diff"], "@@");
    assert_eq!(end["diffTruncated"], false);
    assert_eq!(end["added"], 3);
    assert_eq!(end["exitCode"], 0);
    assert!(end.get("removed").is_none());
    assert!(end.get("output").is_none());
  }
}
