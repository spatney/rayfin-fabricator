//! Projects commands. State/active/workspace/remove are implemented against the
//! store; scaffolding, git, and file operations are ported in later phases.

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::commands::util::{annotate_state, with_missing};
use crate::services::store;
use crate::types::{
  CommunityGalleryResult, CreateProjectInput, FileContent, FileNode, GitChange, GitCommitResult,
  GitFileDiff, GitHistory, GitStatus, ProjectActionResult, ProjectsState, RevertResult,
  TemplateInfo,
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

#[tauri::command]
pub fn projects_state() -> ProjectsState {
  annotate_state(store::get_state())
}

#[tauri::command]
pub async fn projects_templates() -> Vec<TemplateInfo> {
  crate::commands::projects_impl::list_templates().await
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
  crate::commands::projects_impl::create_project(&app, input).await
}

#[tauri::command]
pub async fn projects_open(path: String) -> ProjectActionResult {
  crate::commands::projects_impl::open_project(path).await
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

#[tauri::command]
pub async fn projects_remove(
  app: AppHandle,
  id: String,
  delete_files: Option<bool>,
) -> ProjectsState {
  crate::commands::projects_impl::remove_project(&app, id, delete_files.unwrap_or(false)).await
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
pub async fn projects_git_revert(id: String, r#ref: String) -> RevertResult {
  crate::commands::git::git_revert(id, r#ref).await
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
