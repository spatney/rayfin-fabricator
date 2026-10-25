//! Report migration: pick a Power BI report, gather what Copilot rebuilds it
//! from, and track each page's turn. See [`crate::services::report_migration`].

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::services::report_migration::{
  self as migration, InspectedPage, MigrationReportsResult, MigrationSource, MigrationState, MigrationWorkspacesResult,
  ReportInspection,
};
use crate::services::{store, telemetry};
use crate::state::AppState;

fn project_dir(project_id: &str) -> Result<PathBuf, String> {
  store::find_project(project_id)
    .map(|p| PathBuf::from(p.path))
    .ok_or_else(|| "That project isn't in Fabricator anymore.".to_string())
}

fn ensure_enabled() -> Result<(), String> {
  if store::report_migration_enabled() {
    Ok(())
  } else {
    Err("Turn on Migrate Power BI reports in Settings → Experiments first.".into())
  }
}

/// Gather the project's missing material in the background, unless that's
/// already happening.
fn spawn_gather(app: &AppHandle, project_id: &str, dir: PathBuf) {
  let Some(token) = app.state::<AppState>().begin_migration(project_id) else { return };
  let app = app.clone();
  let project_id = project_id.to_string();
  tauri::async_runtime::spawn(async move {
    migration::gather(&app, &project_id, &dir, &token).await;
    app.state::<AppState>().end_migration(&project_id, &token);
  });
}

/// The workspaces the Azure CLI's account can open, for the report picker.
#[tauri::command]
pub async fn migration_workspaces() -> MigrationWorkspacesResult {
  migration::workspaces().await
}

/// The reports in a workspace.
#[tauri::command]
pub async fn migration_reports(workspace_id: String) -> MigrationReportsResult {
  migration::reports(&workspace_id).await
}

/// Reports whose name matches `query`.
#[tauri::command]
pub async fn migration_search(query: String) -> MigrationReportsResult {
  migration::search(&query).await
}

/// What Fabricator can read of a report: from a pasted link (`target`) or from
/// the picker's ids.
#[tauri::command]
pub async fn migration_inspect(
  target: Option<String>,
  workspace_id: Option<String>,
  report_id: Option<String>,
) -> ReportInspection {
  migration::inspect(target.as_deref(), workspace_id.as_deref(), report_id.as_deref()).await
}

/// Start migrating `source` into the project just created for it: save the
/// migration, keep its material out of git, and gather the material in the
/// background.
#[tauri::command]
pub async fn migration_start(
  app: AppHandle,
  project_id: String,
  source: MigrationSource,
  pages: Vec<InspectedPage>,
) -> Result<MigrationState, String> {
  ensure_enabled()?;
  let dir = project_dir(&project_id)?;
  let format = source.format.clone().unwrap_or_default();
  let personal = source.personal;
  let state = migration::create(&dir, source, &pages)?;
  migration::exclude_from_git(&dir).await;
  telemetry::track_migration(
    crate::commands::auth::get_cached_identity().as_ref(),
    "start",
    &[("pages", pages.len().to_string()), ("format", format), ("personal", personal.to_string())],
  );
  migration::emit(&app, &project_id, &state);
  spawn_gather(&app, &project_id, dir);
  Ok(state)
}

/// A project's migration, when it has one.
#[tauri::command]
pub fn migration_state(project_id: String) -> Option<MigrationState> {
  project_dir(&project_id).ok().and_then(|dir| migration::load(&dir))
}

/// Pick up gathering a restart interrupted. Returns the migration, if any.
#[tauri::command]
pub async fn migration_resume(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
) -> Result<Option<MigrationState>, String> {
  let dir = project_dir(&project_id)?;
  if migration::load(&dir).is_none() {
    return Ok(None);
  }
  if state.migration_running(&project_id) {
    return Ok(migration::load(&dir));
  }
  let current = migration::reopen_interrupted(&dir)?;
  if migration::needs_gathering(&current) {
    spawn_gather(&app, &project_id, dir);
  }
  Ok(Some(current))
}

/// The `index`th exported PDF's bytes, for the renderer to draw the pages.
#[tauri::command]
pub fn migration_pdf(project_id: String, index: usize) -> Result<tauri::ipc::Response, String> {
  let dir = project_dir(&project_id)?;
  migration::read_pdf(&dir, index).map(tauri::ipc::Response::new)
}

/// Save one page the renderer drew: a PNG data URL, its text and a preview.
#[tauri::command]
pub fn migration_save_page(
  app: AppHandle,
  project_id: String,
  index: usize,
  png: String,
  text: String,
  thumb: Option<String>,
) -> Result<MigrationState, String> {
  let dir = project_dir(&project_id)?;
  let state = migration::save_page(&dir, index, &png, &text, thumb)?;
  migration::emit(&app, &project_id, &state);
  Ok(state)
}

/// The renderer finished drawing the pages, or couldn't (`error`).
#[tauri::command]
pub async fn migration_finish_images(
  app: AppHandle,
  project_id: String,
  error: Option<String>,
) -> Result<MigrationState, String> {
  let dir = project_dir(&project_id)?;
  let state = migration::finish_images(&dir, error).await?;
  migration::emit(&app, &project_id, &state);
  Ok(state)
}

/// Record a page's turn starting (`running`) or ending (`done`, `failed`).
#[tauri::command]
pub async fn migration_set_page_status(
  app: AppHandle,
  project_id: String,
  index: usize,
  status: String,
) -> Result<MigrationState, String> {
  let dir = project_dir(&project_id)?;
  let state = migration::set_page_status(&dir, index, &status)?;
  migration::emit(&app, &project_id, &state);
  Ok(state)
}

/// Stop gathering. Returns true when it was running.
#[tauri::command]
pub fn migration_cancel(state: State<'_, AppState>, project_id: String) -> bool {
  state.cancel_migration(&project_id)
}

/// Close (or reopen) the Migration card. The material stays.
#[tauri::command]
pub fn migration_dismiss(app: AppHandle, project_id: String, dismissed: bool) -> Result<MigrationState, String> {
  let dir = project_dir(&project_id)?;
  let state = migration::update(&dir, |s| s.dismissed = dismissed)?;
  migration::emit(&app, &project_id, &state);
  Ok(state)
}
