//! Projects commands. State/active/workspace/remove are implemented against the
//! store; scaffolding, git, and file operations are ported in later phases.

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::util::{annotate_state, with_missing};
use crate::services::store;
use crate::state::AppState;
use crate::types::{
  CommunityGalleryResult, CreateProjectInput, FileContent, FileNode, GitChange, GitCommitResult,
  GitCommitSummary, GitFileDiff, GitHistory, GitRemoteStatus, GitStatus, GitSyncResult,
  ProjectActionResult, ProjectNameCheck, ProjectsState, RevertResult,
};

/// Show a native folder picker, returning the chosen absolute path (or None).
async fn pick_folder_dialog(app: &AppHandle) -> Option<String> {
  let (tx, rx) = tokio::sync::oneshot::channel();
  app.dialog().file().pick_folder(move |picked| {
    let _ = tx.send(picked);
  });
  let picked = rx.await.ok().flatten()?;
  picked
    .into_path()
    .ok()
    .map(|p| p.to_string_lossy().to_string())
}

/// Runs off the main thread: it checks every project's folder on disk.
#[tauri::command(async)]
pub fn projects_state() -> ProjectsState {
  annotate_state(store::get_state())
}

/// Whether a new project's name is free where it will be saved: the projects
/// folder on this computer, or the chosen team workspace (its apps and the
/// Fabric workspace its pipeline publishes to).
#[tauri::command]
pub async fn projects_check_name(name: String, team_workspace_id: Option<String>) -> ProjectNameCheck {
  if let Some(problem) = crate::commands::projects_impl::project_name_problem(&name) {
    return ProjectNameCheck { ok: false, message: Some(problem.into()) };
  }
  let Some(id) = team_workspace_id.filter(|id| !id.trim().is_empty()) else {
    return crate::commands::projects_impl::check_local_name(&name);
  };
  let Some(ws) = store::find_team_workspace(&id) else {
    return ProjectNameCheck { ok: false, message: Some("That team workspace is no longer on this computer.".into()) };
  };
  match crate::commands::team::new_app_name_problem(&ws, &name).await {
    Some(message) => ProjectNameCheck { ok: false, message: Some(message) },
    None => ProjectNameCheck { ok: true, message: None },
  }
}

#[tauri::command]
pub async fn projects_community_templates(repo_url: Option<String>) -> CommunityGalleryResult {
  crate::commands::projects_impl::list_community_templates(repo_url).await
}

#[tauri::command]
pub async fn projects_pick_folder(app: AppHandle) -> Option<String> {
  pick_folder_dialog(&app).await
}

#[tauri::command]
pub async fn projects_pick_workspace_root(app: AppHandle) -> ProjectsState {
  match pick_folder_dialog(&app).await {
    Some(path) => annotate_state(store::set_workspace_root(path)),
    None => annotate_state(store::get_state()),
  }
}

#[tauri::command]
pub fn projects_set_workspace_root(path: String) -> ProjectsState {
  annotate_state(store::set_workspace_root(path))
}

#[tauri::command]
pub async fn projects_create(app: AppHandle, input: CreateProjectInput) -> ProjectActionResult {
  let name = input.name.clone();
  let result = crate::commands::projects_impl::create_project(&app, input).await;
  record_project(&result, "project.created", "project.create.failed", &format!("Created the app \"{name}\"."));
  result
}

#[tauri::command]
pub async fn projects_open(path: String) -> ProjectActionResult {
  let result = crate::commands::projects_impl::open_project(path).await;
  let name = result.project.as_ref().map(|p| p.name.clone()).unwrap_or_default();
  record_project(&result, "project.opened", "project.open.failed", &format!("Opened the app \"{name}\"."));
  result
}

/// Note a project create/open in the activity journal, either way it went.
///
/// These are the moments a user describes as "when I made my app" or "when I
/// opened it", so having them in the record is what lets Help line a later
/// problem up against the right app.
fn record_project(result: &ProjectActionResult, ok_event: &str, fail_event: &str, ok_message: &str) {
  use crate::services::journal::{self, Area, Level, Surface};
  let mut entry = if result.ok {
    journal::entry(Level::Info, Area::Project, ok_event, ok_message)
  } else {
    journal::entry(
      Level::Error,
      Area::Project,
      fail_event,
      result.error.as_deref().unwrap_or("The app could not be set up."),
    )
    .surface(Surface::Backend)
  };
  entry = entry.project(result.project.as_ref().map(|p| p.id.clone()));
  entry.write();
}

#[tauri::command]
pub async fn projects_prepare_dependencies(id: String) -> ProjectActionResult {
  crate::commands::projects_impl::prepare_project_dependencies(id).await
}

#[tauri::command]
pub fn projects_set_active(id: Option<String>) -> ProjectsState {
  annotate_state(store::set_active(id))
}

#[tauri::command]
pub async fn projects_rename(id: String, name: String) -> ProjectActionResult {
  crate::commands::projects_impl::rename_project(id, name).await
}

#[tauri::command]
pub fn projects_set_workspace(
  id: String,
  workspace: Option<String>,
  workspace_name: Option<String>,
) -> ProjectActionResult {
  let has = workspace.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false);
  store::mutate_project(&id, |p| {
    if has {
      p.workspace = workspace.clone();
      p.workspace_name = workspace_name.clone();
    } else {
      p.workspace = None;
      p.workspace_name = None;
    }
  });
  ProjectActionResult {
    ok: true,
    error: None,
    project: store::find_project(&id).map(with_missing),
  }
}

/// Persist the preview pane's view selection (`"fabric"` ⇒ the app embedded in the
/// Fabric portal shell; anything else ⇒ the direct app URL). Stored on the project
/// so the Fabricator agent's screenshot/navigate tools honour the same view the
/// user is looking at. `"direct"` is stored as `None` to keep `studio.json` clean.
#[tauri::command]
pub fn projects_set_preview_mode(id: String, mode: String) -> ProjectActionResult {
  let normalized = if mode == "fabric" { Some("fabric".to_string()) } else { None };
  store::mutate_project(&id, |p| {
    p.preview_mode = normalized.clone();
  });
  ProjectActionResult {
    ok: true,
    error: None,
    project: store::find_project(&id).map(with_missing),
  }
}

#[tauri::command]
pub async fn projects_remove(
  app: AppHandle,
  state: State<'_, AppState>,
  id: String,
  delete_files: Option<bool>,
) -> Result<ProjectsState, String> {
  Ok(
    crate::commands::projects_impl::remove_project(&app, state.inner(), id, delete_files.unwrap_or(false))
      .await,
  )
}

/* ----------------------------- git (ported in Phase 3) ----------------------------- */

#[tauri::command]
pub async fn projects_git_status(id: String) -> GitStatus {
  crate::commands::git::git_status(id).await
}

#[tauri::command]
pub async fn projects_git_commit(id: String, message: String) -> GitCommitResult {
  crate::commands::git::git_commit(id, message).await
}

#[tauri::command]
pub async fn projects_git_log(id: String) -> GitHistory {
  crate::commands::git::git_log(id).await
}

#[tauri::command]
pub async fn projects_git_changes(id: String, r#ref: String) -> Vec<GitChange> {
  crate::commands::git::git_changes(id, r#ref).await
}

#[tauri::command]
pub async fn projects_git_file_diff(
  id: String,
  r#ref: String,
  path: String,
  old_path: Option<String>,
) -> GitFileDiff {
  crate::commands::git::git_file_diff(id, r#ref, path, old_path).await
}

#[tauri::command]
pub async fn projects_git_compare_changes(id: String, base: String, target: String) -> Vec<GitChange> {
  crate::commands::git::git_compare_changes(id, base, target).await
}

#[tauri::command]
pub async fn projects_git_compare_file_diff(
  id: String,
  base: String,
  target: String,
  path: String,
  old_path: Option<String>,
) -> GitFileDiff {
  crate::commands::git::git_compare_file_diff(id, base, target, path, old_path).await
}

#[tauri::command]
pub async fn projects_git_file_log(id: String, path: String) -> Vec<GitCommitSummary> {
  crate::commands::git::git_file_log(id, path).await
}

#[tauri::command]
pub async fn projects_git_revert(id: String, r#ref: String) -> RevertResult {
  crate::commands::git::git_revert(id, r#ref).await
}

#[tauri::command]
pub async fn projects_git_remote_status(id: String) -> GitRemoteStatus {
  crate::commands::git::git_remote_status(id).await
}

#[tauri::command]
pub async fn projects_git_divergence(id: String) -> GitRemoteStatus {
  crate::commands::git::git_divergence(id).await
}

#[tauri::command]
pub async fn projects_git_pull(id: String) -> GitSyncResult {
  crate::commands::git::git_pull(id).await
}

#[tauri::command]
pub async fn projects_git_push(id: String) -> GitSyncResult {
  crate::commands::git::git_push(id).await
}

/* ----------------------------- files (ported in Phase 3) ----------------------------- */

#[tauri::command]
pub async fn projects_files_tree(id: String) -> Vec<FileNode> {
  crate::commands::files::files_tree(id).await
}

#[tauri::command]
pub async fn projects_files_read(id: String, path: String) -> FileContent {
  crate::commands::files::files_read(id, path).await
}
