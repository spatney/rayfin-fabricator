//! Migrating a Power BI report into a Rayfin app.
//!
//! Fabricator gathers what Copilot rebuilds a report from: the report's
//! definition (pages, visuals, fields, filters, theme), its semantic model's
//! tables and measures, and a PDF of its pages, which the renderer turns into
//! page images and text. Everything is read with the **Azure CLI**'s sign-in
//! (a tool setup already requires), so a report can be picked before any
//! project exists. A short-lived `node` helper does the REST calls, as the
//! other Fabric helpers do: [`HELPER_SOURCE`] with the pure [`DEFINITION_SOURCE`].
//!
//! The material lives in the project under [`MIGRATION_ROOT`], kept out of git
//! through the repository's `.git/info/exclude`: page images and text show real
//! data, and the app doesn't need them. `state.json` there records the source,
//! each stage of gathering, and each page's migration turn.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use once_cell::sync::{Lazy, OnceCell};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::services::exec::{self, CancelToken, RunOptions, Stream};
use crate::services::{fabric_auth, paths, semantic_model, telemetry};

const HELPER_SOURCE: &str = include_str!("report_migration_helper.mjs");
const DEFINITION_SOURCE: &str = include_str!("report_definition.mjs");

/// Listing, searching and inspecting.
const QUICK_TIMEOUT_MS: u64 = 120_000;
/// Reading a definition or a model (long-running operations on Fabric's side).
const READ_TIMEOUT_MS: u64 = 5 * 60_000;
/// Exporting pages: Power BI renders each one (about 20 s a page, in jobs of 50).
const EXPORT_TIMEOUT_MS: u64 = 60 * 60_000;

/// Where a project's migration material lives, relative to the project.
pub const MIGRATION_ROOT: &str = ".fabricator/migration";
/// Emitted with a project's [`MigrationState`] whenever it changes.
pub const STATE_EVENT: &str = "migration:state";

/* ---------------------------------- DTOs ---------------------------------- */

/// The Azure CLI's signed-in account, so the picker can say whose reports it lists.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationAccount {
  pub user: Option<String>,
  pub tenant_id: Option<String>,
  pub domain: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationWorkspace {
  pub id: String,
  pub name: String,
  /// My workspace.
  pub personal: bool,
  pub capacity_id: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationWorkspacesResult {
  pub ok: bool,
  pub needs_az: bool,
  pub needs_login: bool,
  pub error: Option<String>,
  pub workspaces: Vec<MigrationWorkspace>,
  pub account: Option<MigrationAccount>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationReportItem {
  pub id: String,
  pub name: String,
  pub description: Option<String>,
  pub workspace_id: String,
  pub workspace_name: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationReportsResult {
  pub ok: bool,
  pub needs_az: bool,
  pub needs_login: bool,
  pub error: Option<String>,
  pub reports: Vec<MigrationReportItem>,
}

/// One inspection check: `ok`, `warn` (the migration goes on with less) or
/// `error` (it can't).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationCheck {
  pub status: String,
  pub message: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationChecks {
  /// Can the report's definition be read (edit access)?
  pub definition: MigrationCheck,
  /// Can its semantic model be queried (Build permission)?
  pub model: MigrationCheck,
  /// Can its pages be exported (a Fabric or Premium capacity)?
  pub images: MigrationCheck,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InspectedReport {
  pub id: String,
  pub name: String,
  pub workspace_id: String,
  pub workspace_name: Option<String>,
  pub personal: bool,
  pub web_url: Option<String>,
  /// `PBIR` or `PBIRLegacy`.
  pub format: Option<String>,
  pub report_type: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InspectedModel {
  pub id: String,
  pub name: Option<String>,
  pub workspace_id: String,
  pub workspace_name: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InspectedPage {
  pub name: String,
  pub display_name: String,
  pub order: u32,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportInspection {
  pub ok: bool,
  pub needs_az: bool,
  pub needs_login: bool,
  pub error: Option<String>,
  pub report: Option<InspectedReport>,
  pub model: Option<InspectedModel>,
  pub pages: Vec<InspectedPage>,
  pub checks: Option<MigrationChecks>,
  /// Why this report can't be migrated, when it can't.
  pub blocked: Option<String>,
}

/// The report a migration rebuilds, as the picker inspected it.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationSource {
  pub report_id: String,
  pub report_name: String,
  pub workspace_id: String,
  pub workspace_name: Option<String>,
  pub personal: bool,
  pub web_url: Option<String>,
  pub format: Option<String>,
  pub model_id: Option<String>,
  pub model_name: Option<String>,
  pub model_workspace_id: Option<String>,
  pub model_workspace_name: Option<String>,
}

/// One stage of gathering: `pending`, `running`, `done`, `skipped` or `failed`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationStage {
  pub status: String,
  pub message: Option<String>,
  /// 0–100 while running, for the export.
  pub progress: Option<u32>,
}

impl Default for MigrationStage {
  fn default() -> Self {
    MigrationStage { status: "pending".into(), message: None, progress: None }
  }
}

impl MigrationStage {
  fn is_open(&self) -> bool {
    self.status == "pending" || self.status == "running"
  }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationStages {
  pub definition: MigrationStage,
  pub model: MigrationStage,
  pub export: MigrationStage,
  /// Rendering the exported pages to images and text (done by the renderer).
  pub images: MigrationStage,
}

/// One report page, and its migration turn.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationPage {
  /// The report's page id.
  pub name: String,
  pub display_name: String,
  pub order: u32,
  /// `page`, `tooltip` or `drillthrough`.
  pub kind: String,
  pub hidden: bool,
  pub width: Option<f64>,
  pub height: Option<f64>,
  pub visuals: Option<u32>,
  /// File name stem under `pages/`, such as `01-overview`.
  pub stem: String,
  /// Material paths, relative to the project.
  pub image: Option<String>,
  pub text: Option<String>,
  /// A small data-URL preview for the Migration card and the message chip.
  pub thumb: Option<String>,
  /// The page's turn: `pending`, `running`, `done` or `failed`.
  pub status: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationState {
  pub version: u32,
  /// The material's folder, relative to the project (`.fabricator/migration/<report>`).
  pub dir: String,
  /// The connector's name for the report's semantic model.
  pub alias: String,
  pub source: MigrationSource,
  pub stages: MigrationStages,
  /// Report pages, in report order.
  pub pages: Vec<MigrationPage>,
  /// Exported PDFs, relative to `dir`, in page order.
  pub pdfs: Vec<String>,
  pub warnings: Vec<String>,
  pub started_at: String,
  /// The user closed the Migration card.
  pub dismissed: bool,
}

/// The `migration:state` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStateEvent {
  pub project_id: String,
  pub state: MigrationState,
}

/* ------------------------------ Helper replies ----------------------------- */

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StepReply {
  ok: bool,
  needs_az: bool,
  needs_login: bool,
  error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DefinitionPage {
  name: String,
  display_name: String,
  order: u32,
  width: Option<f64>,
  height: Option<f64>,
  hidden: bool,
  kind: Option<String>,
  visuals: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DefinitionReply {
  #[serde(flatten)]
  step: StepReply,
  format: Option<String>,
  pages: Vec<DefinitionPage>,
  visuals: Option<u32>,
  custom_visuals: Vec<String>,
  warnings: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ModelReply {
  #[serde(flatten)]
  step: StepReply,
  source: Option<String>,
  warnings: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ExportReply {
  #[serde(flatten)]
  step: StepReply,
  files: Vec<String>,
}

impl StepReply {
  /// A failed step's message, with the sign-in it needs.
  fn failure(&self) -> String {
    let error = self.error.clone().unwrap_or_else(|| "It didn't finish.".into());
    if self.needs_az || self.needs_login {
      format!("{error} Sign in to the Azure CLI again (az login), then try again.")
    } else {
      error
    }
  }
}

/* --------------------------------- Helper --------------------------------- */

/// Write the helper and the modules it imports, side by side under their source
/// names, once per run. Returns the helper's path.
fn write_helper() -> std::io::Result<PathBuf> {
  static PATH: OnceCell<PathBuf> = OnceCell::new();
  PATH
    .get_or_try_init(|| {
      fabric_auth::write_helper()?;
      let dir = paths::ensure_data_dir()?;
      std::fs::write(dir.join("report_definition.mjs"), DEFINITION_SOURCE)?;
      std::fs::write(dir.join("semantic_model_helper.mjs"), semantic_model::HELPER_SOURCE)?;
      let path = dir.join("report_migration_helper.mjs");
      std::fs::write(&path, HELPER_SOURCE)?;
      Ok(path)
    })
    .cloned()
}

/// Run the helper with `request`, decoding its one-line JSON reply. `Err` means
/// it died before replying; a reply with `ok: false` is still `Ok`.
async fn run_helper<T: DeserializeOwned>(
  request: &serde_json::Value,
  timeout_ms: u64,
  on_data: Option<exec::OnData>,
  cancel: Option<CancelToken>,
) -> Result<T, String> {
  let script = write_helper().map_err(|e| format!("Could not prepare the migration helper: {e}"))?;
  let script = script.to_string_lossy().to_string();
  let request = request.to_string();
  let res = exec::run(
    "node",
    &[&script, &request],
    RunOptions { timeout_ms: Some(timeout_ms), on_data, cancel, ..Default::default() },
  )
  .await;
  fabric_auth::parse_helper_output(&res)
}

/// A reply type that can stand for its own failure.
trait Failable: Default {
  fn failed(error: String) -> Self;
}

macro_rules! failable {
  ($($t:ty),*) => {$(
    impl Failable for $t {
      fn failed(error: String) -> Self {
        let (needs_login, needs_az) = fabric_auth::failure_flags(&error);
        let mut out = Self::default();
        out.ok = false;
        out.needs_login = needs_login;
        out.needs_az = needs_az;
        out.error = Some(error);
        out
      }
    }
  )*};
}
failable!(MigrationWorkspacesResult, MigrationReportsResult, ReportInspection);

async fn quick<T: DeserializeOwned + Failable>(request: serde_json::Value) -> T {
  match run_helper(&request, QUICK_TIMEOUT_MS, None, None).await {
    Ok(reply) => reply,
    Err(error) => T::failed(error),
  }
}

/// The workspaces the Azure CLI's account can open, with My workspace first.
pub async fn workspaces() -> MigrationWorkspacesResult {
  quick(serde_json::json!({ "mode": "workspaces" })).await
}

/// The Power BI reports in a workspace.
pub async fn reports(workspace_id: &str) -> MigrationReportsResult {
  quick(serde_json::json!({ "mode": "reports", "workspaceId": workspace_id })).await
}

/// Reports whose name matches `query`, across the tenant's catalog.
pub async fn search(query: &str) -> MigrationReportsResult {
  quick(serde_json::json!({ "mode": "search", "query": query })).await
}

/// What Fabricator can read of a report, from a link or from its ids.
pub async fn inspect(target: Option<&str>, workspace_id: Option<&str>, report_id: Option<&str>) -> ReportInspection {
  let mut inspection: ReportInspection = quick(serde_json::json!({
    "mode": "inspect",
    "target": target,
    "workspaceId": workspace_id,
    "reportId": report_id,
  }))
  .await;
  block_personal_models(&mut inspection);
  inspection
}

/// Rayfin's semantic-model connector reads models in shared workspaces; a model
/// in My workspace has to be published to one first.
fn block_personal_models(inspection: &mut ReportInspection) {
  let (Some(report), Some(model)) = (&inspection.report, &inspection.model) else { return };
  let personal_model = report.personal && (model.workspace_id.is_empty() || model.workspace_id.eq_ignore_ascii_case(&report.workspace_id));
  if !personal_model {
    return;
  }
  let message = "Its semantic model is in My workspace, and Rayfin apps connect to models in shared workspaces. Publish the report to a workspace first, then migrate it from there.".to_string();
  if let Some(checks) = inspection.checks.as_mut() {
    checks.model = MigrationCheck { status: "error".into(), message: message.clone() };
  }
  inspection.blocked.get_or_insert(message);
}

/* ------------------------------ Names on disk ------------------------------ */

/// A lowercase, dash-separated slug of `text`, at most `max` characters.
fn slug(text: &str, max: usize) -> String {
  let mut out = String::new();
  for c in text.chars().flat_map(|c| c.to_lowercase()) {
    if c.is_ascii_alphanumeric() {
      out.push(c);
    } else if !out.ends_with('-') && !out.is_empty() {
      out.push('-');
    }
  }
  let mut out: String = out.trim_matches('-').chars().take(max).collect();
  while out.ends_with('-') {
    out.pop();
  }
  out
}

/// `01-overview`: a page's file name stem, in report order.
pub fn page_stem(order: u32, display_name: &str) -> String {
  let name = slug(display_name, 40);
  format!("{:02}-{}", order + 1, if name.is_empty() { "page" } else { &name })
}

/// The connector's name for a model: lowercase letters and digits, starting with
/// a letter (`Sales Analytics` → `salesanalytics`). `rayfin connector add`
/// lower-cases names, so this is the name the app's code and `rayfin.yml` use.
pub fn connector_alias(model_name: &str) -> String {
  let mut out: String = model_name
    .chars()
    .filter(|c| c.is_ascii_alphanumeric())
    .map(|c| c.to_ascii_lowercase())
    .collect();
  if !out.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
    out.insert_str(0, "model");
  }
  out.chars().take(40).collect()
}

/// The exact command that connects the app to the source's model.
pub fn connector_command(state: &MigrationState) -> Option<String> {
  let model = state.source.model_id.as_deref()?;
  let workspace = state.source.model_workspace_id.as_deref().unwrap_or(&state.source.workspace_id);
  Some(format!(
    "npx rayfin connector add --type fabric-semanticmodel --workspace-id {workspace} --item-id {model} --name {}",
    state.alias
  ))
}

fn root_dir(project_dir: &Path) -> PathBuf {
  project_dir.join(MIGRATION_ROOT)
}

fn state_file(project_dir: &Path) -> PathBuf {
  root_dir(project_dir).join("state.json")
}

fn bundle_dir(project_dir: &Path, state: &MigrationState) -> PathBuf {
  project_dir.join(&state.dir)
}

/* ---------------------------------- State --------------------------------- */

/// Serializes read-modify-write of every project's `state.json`.
static STATE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// A project's migration, when it has one.
pub fn load(project_dir: &Path) -> Option<MigrationState> {
  let text = std::fs::read_to_string(state_file(project_dir)).ok()?;
  serde_json::from_str(&text).ok()
}

fn save(project_dir: &Path, state: &MigrationState) -> Result<(), String> {
  let file = state_file(project_dir);
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not save the migration: {e}"))?;
  }
  let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
  let tmp = file.with_extension("json.tmp");
  std::fs::write(&tmp, text).map_err(|e| format!("Could not save the migration: {e}"))?;
  std::fs::rename(&tmp, &file).map_err(|e| format!("Could not save the migration: {e}"))
}

/// Change a project's migration and save it, returning the new state.
pub fn update(project_dir: &Path, f: impl FnOnce(&mut MigrationState)) -> Result<MigrationState, String> {
  let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut state = load(project_dir).ok_or("This project has no report migration.")?;
  f(&mut state);
  save(project_dir, &state)?;
  Ok(state)
}

pub fn emit(app: &AppHandle, project_id: &str, state: &MigrationState) {
  let _ = app.emit(STATE_EVENT, MigrationStateEvent { project_id: project_id.to_string(), state: state.clone() });
}

/// A new migration of `source` in `project_dir`, with the inspected pages.
pub fn create(project_dir: &Path, source: MigrationSource, pages: &[InspectedPage]) -> Result<MigrationState, String> {
  let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  if load(project_dir).is_some() {
    return Err("This project already has a report migration.".into());
  }
  let name = slug(&source.report_name, 50);
  let folder = if name.is_empty() { slug(&source.report_id, 8) } else { name };
  let mut pages: Vec<MigrationPage> = pages
    .iter()
    .map(|p| MigrationPage {
      name: p.name.clone(),
      display_name: p.display_name.clone(),
      order: p.order,
      kind: "page".into(),
      stem: page_stem(p.order, &p.display_name),
      status: "pending".into(),
      ..Default::default()
    })
    .collect();
  pages.sort_by_key(|p| p.order);
  let model_stage = if source.model_id.is_some() {
    MigrationStage::default()
  } else {
    MigrationStage { status: "skipped".into(), message: Some("The report has no semantic model.".into()), progress: None }
  };
  let state = MigrationState {
    version: 1,
    dir: format!("{MIGRATION_ROOT}/{folder}"),
    alias: connector_alias(source.model_name.as_deref().unwrap_or("model")),
    source,
    stages: MigrationStages { model: model_stage, ..Default::default() },
    pages,
    started_at: chrono::Utc::now().to_rfc3339(),
    ..Default::default()
  };
  std::fs::create_dir_all(bundle_dir(project_dir, &state).join("pages"))
    .map_err(|e| format!("Could not create the migration folder: {e}"))?;
  save(project_dir, &state)?;
  Ok(state)
}

/// Keep `.fabricator/` out of git in whichever repository holds the project,
/// through `info/exclude`, so none of the app's own files change. A folder git
/// doesn't track needs nothing.
pub async fn exclude_from_git(project_dir: &Path) {
  let res = exec::run(
    "git",
    &["rev-parse", "--git-path", "info/exclude"],
    RunOptions { cwd: Some(project_dir.to_path_buf()), timeout_ms: Some(15_000), ..Default::default() },
  )
  .await;
  if !res.ok {
    return;
  }
  let path = PathBuf::from(res.stdout.trim());
  let path = if path.is_absolute() { path } else { project_dir.join(path) };
  let current = std::fs::read_to_string(&path).unwrap_or_default();
  if let Some(next) = with_exclusion(&current) {
    if let Some(dir) = path.parent() {
      let _ = std::fs::create_dir_all(dir);
    }
    if let Err(error) = std::fs::write(&path, next) {
      log::warn!("could not keep migration material out of git: {error}");
    }
  }
}

/// `exclude` with `.fabricator/` added, or `None` when it's already there.
fn with_exclusion(exclude: &str) -> Option<String> {
  if exclude.lines().any(|l| matches!(l.trim(), ".fabricator/" | ".fabricator" | "/.fabricator/" | "/.fabricator")) {
    return None;
  }
  let mut next = exclude.to_string();
  if !next.is_empty() && !next.ends_with('\n') {
    next.push('\n');
  }
  next.push_str("\n# Fabricator's working files for this computer, such as a report migration's page images\n.fabricator/\n");
  Some(next)
}

/* -------------------------------- Gathering -------------------------------- */

/// Gather what's still missing of a project's migration material: the
/// definition, the model, the page export, and the README. Each stage that
/// fails is recorded, and the rest go on without it. Stops when `cancel` fires.
pub async fn gather(app: &AppHandle, project_id: &str, project_dir: &Path, cancel: &CancelToken) {
  let started = Instant::now();
  let Some(state) = load(project_dir) else { return };
  let out_dir = bundle_dir(project_dir, &state);
  let out = out_dir.to_string_lossy().to_string();
  let source = state.source.clone();
  let set = |f: &dyn Fn(&mut MigrationState)| {
    if let Ok(next) = update(project_dir, |s| f(s)) {
      emit(app, project_id, &next);
    }
  };

  if state.stages.definition.is_open() && !cancel.is_cancelled() {
    set(&|s| s.stages.definition = running());
    let request = serde_json::json!({
      "mode": "definition",
      "workspaceId": source.workspace_id,
      "reportId": source.report_id,
      "personal": source.personal,
      "outDir": out,
    });
    let reply: Result<DefinitionReply, String> = run_helper(&request, READ_TIMEOUT_MS, None, Some(cancel.clone())).await;
    set(&|s| match &reply {
      Ok(r) if r.step.ok => {
        s.stages.definition = done(None);
        if r.format.is_some() {
          s.source.format = r.format.clone();
        }
        merge_definition_pages(s, &r.pages);
        s.warnings.extend(r.warnings.iter().cloned());
        if !r.custom_visuals.is_empty() {
          s.warnings.push(format!("Custom visuals: {}.", r.custom_visuals.join(", ")));
        }
      }
      Ok(r) => s.stages.definition = failed(r.step.failure()),
      Err(e) => s.stages.definition = failed(e.clone()),
    });
  }

  if state.stages.model.is_open() && !cancel.is_cancelled() {
    if let Some(model_id) = source.model_id.clone() {
      set(&|s| s.stages.model = running());
      let model_ws = source.model_workspace_id.clone().unwrap_or_else(|| source.workspace_id.clone());
      let request = serde_json::json!({
        "mode": "model",
        "workspaceId": model_ws,
        "datasetId": model_id,
        "personal": source.personal && model_ws.eq_ignore_ascii_case(&source.workspace_id),
        "outDir": out,
      });
      let reply: Result<ModelReply, String> = run_helper(&request, READ_TIMEOUT_MS, None, Some(cancel.clone())).await;
      set(&|s| match &reply {
        Ok(r) if r.step.ok => {
          let note = (r.source.as_deref() == Some("queries"))
            .then(|| "Read with queries: measure formulas aren't included.".to_string());
          s.stages.model = done(note);
          s.warnings.extend(r.warnings.iter().cloned());
        }
        Ok(r) => s.stages.model = failed(r.step.failure()),
        Err(e) => s.stages.model = failed(e.clone()),
      });
    }
  }

  let current = load(project_dir).unwrap_or(state);
  if current.stages.export.is_open() && !cancel.is_cancelled() {
    set(&|s| s.stages.export = running());
    let pages: Vec<String> = current.pages.iter().map(|p| p.name.clone()).filter(|n| !n.is_empty()).collect();
    let request = serde_json::json!({
      "mode": "export",
      "workspaceId": source.workspace_id,
      "reportId": source.report_id,
      "personal": source.personal,
      "pages": if pages.is_empty() { serde_json::Value::Null } else { serde_json::json!(pages) },
      "outDir": out,
    });
    let reply: Result<ExportReply, String> =
      run_helper(&request, EXPORT_TIMEOUT_MS, Some(progress_reporter(app, project_id, project_dir)), Some(cancel.clone())).await;
    let skipped_by_user = cancel.is_cancelled();
    set(&|s| match &reply {
      _ if skipped_by_user => {
        s.stages.export = skipped("Skipped.");
        s.stages.images = skipped("No pages were exported.");
      }
      Ok(r) if r.step.ok && !r.files.is_empty() => {
        s.stages.export = done(None);
        s.pdfs = r.files.clone();
      }
      Ok(r) => {
        s.stages.export = failed(r.step.failure());
        s.stages.images = skipped("No pages were exported.");
      }
      Err(e) => {
        s.stages.export = failed(e.clone());
        s.stages.images = skipped("No pages were exported.");
      }
    });
  }

  // The README is written even when gathering stopped early: it covers what's there.
  if let Some(state) = load(project_dir) {
    write_readme(&state, project_dir).await;
    if !cancel.is_cancelled() {
      let outcome = |stage: &MigrationStage| stage.status.clone();
      telemetry::track_migration(
        crate::commands::auth::get_cached_identity().as_ref(),
        "extract",
        &[
          ("definition", outcome(&state.stages.definition)),
          ("model", outcome(&state.stages.model)),
          ("export", outcome(&state.stages.export)),
          ("format", state.source.format.clone().unwrap_or_default()),
          ("pages", state.pages.len().to_string()),
          ("visuals", state.pages.iter().filter_map(|p| p.visuals).sum::<u32>().to_string()),
          ("seconds", started.elapsed().as_secs().to_string()),
        ],
      );
    }
  }
}

fn running() -> MigrationStage {
  MigrationStage { status: "running".into(), message: None, progress: None }
}

fn done(message: Option<String>) -> MigrationStage {
  MigrationStage { status: "done".into(), message, progress: None }
}

fn failed(message: String) -> MigrationStage {
  MigrationStage { status: "failed".into(), message: Some(fabric_auth::redact(&message)), progress: None }
}

fn skipped(message: &str) -> MigrationStage {
  MigrationStage { status: "skipped".into(), message: Some(message.into()), progress: None }
}

/// The definition knows every page, hidden ones included, with its kind and
/// size: it replaces the inspected list, keeping any turn already recorded.
fn merge_definition_pages(state: &mut MigrationState, pages: &[DefinitionPage]) {
  if pages.is_empty() {
    return;
  }
  let mut next: Vec<MigrationPage> = pages
    .iter()
    .map(|p| {
      let before = state.pages.iter().find(|x| x.name == p.name);
      MigrationPage {
        name: p.name.clone(),
        display_name: p.display_name.clone(),
        order: p.order,
        kind: p.kind.clone().unwrap_or_else(|| "page".into()),
        hidden: p.hidden,
        width: p.width,
        height: p.height,
        visuals: p.visuals,
        stem: page_stem(p.order, &p.display_name),
        image: before.and_then(|b| b.image.clone()),
        text: before.and_then(|b| b.text.clone()),
        thumb: before.and_then(|b| b.thumb.clone()),
        status: before.map(|b| b.status.clone()).unwrap_or_else(|| "pending".into()),
      }
    })
    .collect();
  next.sort_by_key(|p| p.order);
  state.pages = next;
}

/// Parses the export's `{"progress":N}` stderr lines into the stage's progress.
fn progress_reporter(app: &AppHandle, project_id: &str, project_dir: &Path) -> exec::OnData {
  let app = app.clone();
  let project_id = project_id.to_string();
  let project_dir = project_dir.to_path_buf();
  let last = Arc::new(Mutex::new(None::<u32>));
  Arc::new(move |stream: Stream, data: &str| {
    if stream != Stream::Stderr {
      return;
    }
    let Some(progress) = data.lines().rev().find_map(parse_progress) else { return };
    {
      let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
      if *last == Some(progress) {
        return;
      }
      *last = Some(progress);
    }
    if let Ok(next) = update(&project_dir, |s| {
      if s.stages.export.status == "running" {
        s.stages.export.progress = Some(progress);
      }
    }) {
      emit(&app, &project_id, &next);
    }
  })
}

fn parse_progress(line: &str) -> Option<u32> {
  let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
  value.get("progress")?.as_f64().map(|p| p.clamp(0.0, 100.0).round() as u32)
}

/// (Re)write the material's README for Copilot, from the definition when there
/// is one. Best effort: the turns still name every file.
pub async fn write_readme(state: &MigrationState, project_dir: &Path) {
  let images = state.stages.images.status != "skipped" && state.stages.images.status != "failed" && !state.pdfs.is_empty();
  let request = serde_json::json!({
    "mode": "readme",
    "outDir": bundle_dir(project_dir, state).to_string_lossy(),
    "source": {
      "reportName": state.source.report_name,
      "reportUrl": state.source.web_url,
      "workspaceName": state.source.workspace_name.clone().unwrap_or_else(|| if state.source.personal { "My workspace".into() } else { String::new() }),
      "personal": state.source.personal,
      "modelName": state.source.model_name,
      "modelWorkspaceName": state.source.model_workspace_name,
      "alias": state.alias,
      "connectorCommand": connector_command(state),
    },
    "pages": state.pages.iter().map(|p| serde_json::json!({
      "name": p.name,
      "displayName": p.display_name,
      "order": p.order,
      "stem": p.stem,
      "kind": p.kind,
      "hidden": p.hidden,
      "width": p.width,
      "height": p.height,
    })).collect::<Vec<_>>(),
    "images": images,
  });
  match run_helper::<StepReply>(&request, QUICK_TIMEOUT_MS, None, None).await {
    Ok(reply) if reply.ok => {}
    Ok(reply) => log::warn!("migration README not written: {}", reply.failure()),
    Err(error) => log::warn!("migration README not written: {error}"),
  }
}

/// Save one rendered page: its image (a PNG data URL), its text and its preview.
pub fn save_page(project_dir: &Path, index: usize, png: &str, text: &str, thumb: Option<String>) -> Result<MigrationState, String> {
  let state = load(project_dir).ok_or("This project has no report migration.")?;
  let page = state.pages.get(index).ok_or("That page isn't part of the migration.")?;
  let bytes = decode_png(png)?;
  let rel_image = format!("{}/pages/{}.png", state.dir, page.stem);
  let rel_text = format!("{}/pages/{}.txt", state.dir, page.stem);
  let image_path = project_dir.join(&rel_image);
  if let Some(dir) = image_path.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not save the page image: {e}"))?;
  }
  std::fs::write(&image_path, bytes).map_err(|e| format!("Could not save the page image: {e}"))?;
  std::fs::write(project_dir.join(&rel_text), text).map_err(|e| format!("Could not save the page text: {e}"))?;
  update(project_dir, |s| {
    if let Some(p) = s.pages.get_mut(index) {
      p.image = Some(rel_image);
      p.text = Some(rel_text);
      p.thumb = thumb.filter(|t| t.starts_with("data:image/") && t.len() < 200_000);
    }
    let saved = s.pages.iter().filter(|p| p.image.is_some()).count();
    s.stages.images = MigrationStage {
      status: "running".into(),
      message: None,
      progress: Some(((saved * 100) / s.pages.len().max(1)) as u32),
    };
  })
}

fn decode_png(data_url: &str) -> Result<Vec<u8>, String> {
  use base64::Engine;
  let payload = data_url
    .strip_prefix("data:image/png;base64,")
    .ok_or("A page image must be a PNG data URL.")?;
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(payload)
    .map_err(|_| "The page image isn't valid base64.".to_string())?;
  if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    return Err("The page image isn't a PNG.".into());
  }
  Ok(bytes)
}

/// The renderer finished turning the export into page images (or couldn't).
pub async fn finish_images(project_dir: &Path, error: Option<String>) -> Result<MigrationState, String> {
  let state = update(project_dir, |s| {
    s.stages.images = match &error {
      None => done(None),
      Some(e) => failed(e.clone()),
    };
  })?;
  write_readme(&state, project_dir).await;
  Ok(state)
}

/// The bytes of the `index`th exported PDF.
pub fn read_pdf(project_dir: &Path, index: usize) -> Result<Vec<u8>, String> {
  let state = load(project_dir).ok_or("This project has no report migration.")?;
  let file = state.pdfs.get(index).ok_or("There's no such exported PDF.")?;
  if file.contains("..") || Path::new(file).is_absolute() {
    return Err("The exported PDF's path isn't valid.".into());
  }
  std::fs::read(bundle_dir(project_dir, &state).join(file)).map_err(|e| format!("Could not read the exported pages: {e}"))
}

/// Record a page turn starting or ending.
pub fn set_page_status(project_dir: &Path, index: usize, status: &str) -> Result<MigrationState, String> {
  if !matches!(status, "pending" | "running" | "done" | "failed") {
    return Err(format!("Unknown page status: {status}"));
  }
  let next = update(project_dir, |s| {
    if let Some(p) = s.pages.get_mut(index) {
      p.status = status.to_string();
    }
  })?;
  if matches!(status, "done" | "failed") {
    telemetry::track_migration(
      crate::commands::auth::get_cached_identity().as_ref(),
      "page",
      &[
        ("ok", (status == "done").to_string()),
        ("index", index.to_string()),
        ("pages", next.pages.len().to_string()),
      ],
    );
  }
  Ok(next)
}

/// Stages a restart left open, back to pending so [`gather`] picks them up.
pub fn reopen_interrupted(project_dir: &Path) -> Result<MigrationState, String> {
  update(project_dir, |s| {
    for stage in [&mut s.stages.definition, &mut s.stages.model, &mut s.stages.export] {
      if stage.status == "running" {
        *stage = MigrationStage::default();
      }
    }
  })
}

/// True when [`gather`] still has something to do.
pub fn needs_gathering(state: &MigrationState) -> bool {
  state.stages.definition.is_open() || state.stages.model.is_open() || state.stages.export.is_open()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_project(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fab-migration-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn source() -> MigrationSource {
    MigrationSource {
      report_id: "26ff389c-0000-0000-0000-000000000000".into(),
      report_name: "Financial Performance: Overview".into(),
      workspace_id: "ws-1".into(),
      workspace_name: Some("Finance".into()),
      model_id: Some("ds-1".into()),
      model_name: Some("Sales & Finance 2024".into()),
      ..Default::default()
    }
  }

  #[test]
  fn names_on_disk_are_stable_and_safe() {
    assert_eq!(page_stem(0, "Financial Overview"), "01-financial-overview");
    assert_eq!(page_stem(11, "  Q&A / Détails  "), "12-q-a-d-tails");
    assert_eq!(page_stem(2, "???"), "03-page");
    assert_eq!(slug("A very long report name that keeps going and going past the limit", 20), "a-very-long-report-n");
    assert_eq!(connector_alias("Sales & Finance 2024"), "salesfinance2024");
    assert_eq!(connector_alias("2024 Sales"), "model2024sales");
    assert_eq!(connector_alias(""), "model");
  }

  #[test]
  fn connector_command_targets_the_models_workspace() {
    let mut state = MigrationState { alias: "sales".into(), source: source(), ..Default::default() };
    assert_eq!(
      connector_command(&state).unwrap(),
      "npx rayfin connector add --type fabric-semanticmodel --workspace-id ws-1 --item-id ds-1 --name sales"
    );
    state.source.model_workspace_id = Some("ws-models".into());
    assert!(connector_command(&state).unwrap().contains("--workspace-id ws-models"));
    state.source.model_id = None;
    assert!(connector_command(&state).is_none());
  }

  #[test]
  fn a_migration_is_created_once_with_its_pages_in_order() {
    let dir = temp_project("create");
    let pages = vec![
      InspectedPage { name: "b".into(), display_name: "Details".into(), order: 1 },
      InspectedPage { name: "a".into(), display_name: "Overview".into(), order: 0 },
    ];
    let state = create(&dir, source(), &pages).unwrap();
    assert_eq!(state.dir, ".fabricator/migration/financial-performance-overview");
    assert_eq!(state.alias, "salesfinance2024");
    assert_eq!(state.pages.iter().map(|p| p.stem.as_str()).collect::<Vec<_>>(), vec!["01-overview", "02-details"]);
    assert_eq!(state.stages.definition.status, "pending");
    assert!(dir.join(".fabricator/migration/financial-performance-overview/pages").is_dir());
    assert_eq!(load(&dir).unwrap(), state);
    assert!(create(&dir, source(), &pages).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_report_without_a_model_skips_the_model_stage() {
    let dir = temp_project("nomodel");
    let state = create(&dir, MigrationSource { model_id: None, ..source() }, &[]).unwrap();
    assert_eq!(state.stages.model.status, "skipped");
    assert!(needs_gathering(&state));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn definition_pages_replace_inspected_ones_and_keep_turns() {
    let mut state = MigrationState {
      pages: vec![MigrationPage { name: "a".into(), display_name: "Overview".into(), status: "done".into(), ..Default::default() }],
      ..Default::default()
    };
    merge_definition_pages(
      &mut state,
      &[
        DefinitionPage { name: "t".into(), display_name: "Tip".into(), order: 1, hidden: true, kind: Some("tooltip".into()), ..Default::default() },
        DefinitionPage { name: "a".into(), display_name: "Overview".into(), order: 0, visuals: Some(9), width: Some(1280.0), ..Default::default() },
      ],
    );
    assert_eq!(state.pages.len(), 2);
    assert_eq!((state.pages[0].name.as_str(), state.pages[0].status.as_str(), state.pages[0].visuals), ("a", "done", Some(9)));
    assert_eq!((state.pages[1].kind.as_str(), state.pages[1].hidden, state.pages[1].status.as_str()), ("tooltip", true, "pending"));
    assert_eq!(state.pages[1].stem, "02-tip");
  }

  #[test]
  fn pages_are_saved_as_pngs_with_their_text() {
    use base64::Engine;
    let dir = temp_project("save");
    create(&dir, source(), &[InspectedPage { name: "a".into(), display_name: "Overview".into(), order: 0 }]).unwrap();
    let png = [b"\x89PNG\r\n\x1a\n".as_slice(), b"rest"].concat();
    let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png));
    let state = save_page(&dir, 0, &url, "Revenue 12.3M", Some("data:image/png;base64,AA".into())).unwrap();
    let page = &state.pages[0];
    assert_eq!(page.image.as_deref(), Some(".fabricator/migration/financial-performance-overview/pages/01-overview.png"));
    assert_eq!(std::fs::read(dir.join(page.image.as_ref().unwrap())).unwrap(), png);
    assert_eq!(std::fs::read_to_string(dir.join(page.text.as_ref().unwrap())).unwrap(), "Revenue 12.3M");
    assert_eq!(state.stages.images.progress, Some(100));
    assert!(save_page(&dir, 0, "data:image/jpeg;base64,AA", "", None).is_err());
    assert!(save_page(&dir, 0, "data:image/png;base64,QUJD", "", None).is_err());
    assert!(save_page(&dir, 5, &url, "", None).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn page_statuses_are_checked_and_saved() {
    let dir = temp_project("status");
    create(&dir, source(), &[InspectedPage { name: "a".into(), display_name: "Overview".into(), order: 0 }]).unwrap();
    assert_eq!(set_page_status(&dir, 0, "running").unwrap().pages[0].status, "running");
    assert!(set_page_status(&dir, 0, "finished").is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn interrupted_stages_are_picked_up_again() {
    let dir = temp_project("reopen");
    create(&dir, source(), &[]).unwrap();
    update(&dir, |s| {
      s.stages.definition = done(None);
      s.stages.model = running();
      s.stages.export = failed("Export is disabled.".into());
    })
    .unwrap();
    let state = reopen_interrupted(&dir).unwrap();
    assert_eq!(state.stages.model.status, "pending");
    assert_eq!(state.stages.export.status, "failed");
    assert!(needs_gathering(&state));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn pdfs_are_read_only_from_the_material_folder() {
    let dir = temp_project("pdf");
    create(&dir, source(), &[]).unwrap();
    let state = update(&dir, |s| s.pdfs = vec!["export-1.pdf".into(), "../../escape.pdf".into()]).unwrap();
    std::fs::write(dir.join(&state.dir).join("export-1.pdf"), b"%PDF-1.7").unwrap();
    assert_eq!(read_pdf(&dir, 0).unwrap(), b"%PDF-1.7");
    assert!(read_pdf(&dir, 1).is_err());
    assert!(read_pdf(&dir, 2).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn the_exclusion_is_added_once() {
    let next = with_exclusion("# git ls-files --others --exclude-from=.git/info/exclude\n").unwrap();
    assert!(next.ends_with(".fabricator/\n"));
    assert!(with_exclusion(&next).is_none());
    assert!(with_exclusion("node_modules/\n/.fabricator\n").is_none());
    assert_eq!(with_exclusion("").unwrap().trim_start(), "# Fabricator's working files for this computer, such as a report migration's page images\n.fabricator/\n");
  }

  #[test]
  fn export_progress_lines_are_parsed() {
    assert_eq!(parse_progress("{\"progress\":42}"), Some(42));
    assert_eq!(parse_progress("{\"progress\":140.2}"), Some(100));
    assert_eq!(parse_progress("Polling export…"), None);
  }

  #[test]
  fn reports_with_a_model_in_my_workspace_are_blocked() {
    let mut inspection = ReportInspection {
      ok: true,
      report: Some(InspectedReport { id: "r".into(), name: "Getting Started".into(), workspace_id: "me-ws".into(), personal: true, ..Default::default() }),
      model: Some(InspectedModel { id: "m".into(), workspace_id: "me-ws".into(), ..Default::default() }),
      checks: Some(MigrationChecks::default()),
      ..Default::default()
    };
    block_personal_models(&mut inspection);
    assert!(inspection.blocked.as_deref().unwrap().contains("My workspace"));
    assert_eq!(inspection.checks.unwrap().model.status, "error");

    let mut shared = ReportInspection {
      ok: true,
      report: Some(InspectedReport { id: "r".into(), workspace_id: "me-ws".into(), personal: true, ..Default::default() }),
      model: Some(InspectedModel { id: "m".into(), workspace_id: "team-ws".into(), ..Default::default() }),
      ..Default::default()
    };
    block_personal_models(&mut shared);
    assert!(shared.blocked.is_none());
  }

  /// The helper's pure module: normalizing both report formats, readable
  /// filters and the README. Skips when `node` isn't on PATH.
  #[test]
  fn report_definition_regressions() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src").join("services").join("report_definition.test.mjs");
    let output = match std::process::Command::new("node").arg("--test").arg(script).output() {
      Ok(output) => output,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
      Err(error) => panic!("Could not run the report definition tests: {error}"),
    };
    assert!(
      output.status.success(),
      "{}\n{}",
      String::from_utf8_lossy(&output.stdout),
      String::from_utf8_lossy(&output.stderr)
    );
  }
}
