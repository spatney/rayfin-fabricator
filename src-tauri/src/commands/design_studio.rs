//! Design Studio persistence and source-Apply commands (`src/shared/design.ts`).
//!
//! `design_apply` returns only the source receipt; its `turnId` equals `applyId`.
//! The caller must await `deploy_run({ projectId, applyId })` only after
//! `source-updated`, verify the fresh app through `preview_studio_command`, then
//! call `design_apply_finish`. A failed deployment preserves `source-updated`
//! for retry without Copilot; interrupted work is retained, never replayed.
//! `finish(false)` retains the draft for review and releases idle ownership;
//! `finish(true)` accepts automatic verification or explicit human review after
//! successful deployment. Start fresh archives both latest records, not source.

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::services::design_contract::{DesignApplyReceipt, DesignAsset, DesignDraft};
use crate::services::{design_apply, design_store as disk};
use crate::state::AppState;

#[tauri::command]
pub async fn design_draft_load(app: AppHandle, project_id: String) -> Result<Option<DesignDraft>, String> {
  tokio::task::spawn_blocking(move || {
    let _disk = disk::lock()?;
    let project = disk::project(&project_id)?;
    design_apply::reconcile_receipt(&project, &app.state::<AppState>())?;
    project.load_draft()
  })
  .await
  .map_err(|e| format!("Loading the Design draft failed: {e}"))?
}

#[tauri::command]
pub async fn design_draft_save(app: AppHandle, draft: DesignDraft) -> Result<u64, String> {
  tokio::task::spawn_blocking(move || {
    let _disk = disk::lock()?;
    let project = disk::project(&draft.project_id)?;
    if app.state::<AppState>().mutations.apply_id(&draft.project_id).is_some() {
      let saved = project.load_draft()?.ok_or("Design Apply is using a frozen draft.")?;
      if saved.revision != draft.revision
        || saved.history != draft.history
        || saved.cursor != draft.cursor
        || saved.source_revision != draft.source_revision
      {
        return Err("Design Apply is using this frozen draft. Wait for completion before changing its journal.".into());
      }
    }
    project.save_draft(draft)
  })
  .await
  .map_err(|e| format!("Saving the Design draft failed: {e}"))?
}

#[tauri::command]
pub async fn design_draft_clear(app: AppHandle, project_id: String) -> Result<(), String> {
  tokio::task::spawn_blocking(move || {
    let _disk = disk::lock()?;
    let state = app.state::<AppState>();
    if state.is_chat_running(&project_id) {
      return Err("Wait for the running source turn to finish before starting a fresh draft.".into());
    }
    let _lease = state.mutations.resetting_draft(&project_id)?;
    disk::project(&project_id)?.archive_and_clear()
  })
  .await
  .map_err(|e| format!("Clearing the Design draft failed: {e}"))?
}

#[tauri::command]
pub async fn design_source_revision(project_id: String) -> Result<String, String> {
  tokio::task::spawn_blocking(move || {
    let project = disk::project(&project_id)?;
    Ok(disk::source_snapshot(&project.project_path)?.revision)
  })
  .await
  .map_err(|e| format!("Design source scan failed: {e}"))?
}

#[tauri::command]
pub async fn design_assets(project_id: String) -> Result<Vec<DesignAsset>, String> {
  tokio::task::spawn_blocking(move || {
    let _disk = disk::lock()?;
    disk::project(&project_id)?.assets()
  })
  .await
  .map_err(|e| format!("Design image catalogue failed: {e}"))?
}

#[tauri::command]
pub async fn design_import_asset(app: AppHandle, project_id: String) -> Result<Option<DesignAsset>, String> {
  let project = disk::project(&project_id)?;
  let (tx, rx) = tokio::sync::oneshot::channel();
  app
    .dialog()
    .file()
    .add_filter("Design images (SVG is not supported)", &["png", "jpg", "jpeg", "gif", "webp"])
    .pick_file(move |file| {
      let _ = tx.send(file);
    });
  let Some(file) = rx.await.map_err(|_| "The Design image picker was interrupted.")? else {
    return Ok(None);
  };
  let path = file.into_path().map_err(|_| "Only local image files can be imported into Design.")?;
  tokio::task::spawn_blocking(move || {
    let _disk = disk::lock()?;
    project.import_asset(&path).map(Some)
  })
  .await
  .map_err(|e| format!("Design image import failed: {e}"))?
}

#[tauri::command]
pub async fn design_asset_preview(project_id: String, asset_id: String) -> Result<String, String> {
  tokio::task::spawn_blocking(move || {
    let _disk = disk::lock()?;
    disk::project(&project_id)?.asset_preview(&asset_id)
  })
  .await
  .map_err(|e| format!("Design image preview failed: {e}"))?
}

#[tauri::command]
pub async fn design_apply(
  app: AppHandle,
  project_id: String,
  apply_id: String,
  revision: u64,
  screenshot_path: Option<String>,
) -> Result<DesignApplyReceipt, String> {
  tokio::spawn(async move { design_apply::apply(app, project_id, apply_id, revision, screenshot_path).await })
    .await
    .map_err(|e| format!("Design Apply task failed; inspect its retained receipt before retrying: {e}"))?
}

#[tauri::command]
pub async fn design_apply_receipt(app: AppHandle, project_id: String) -> Result<Option<DesignApplyReceipt>, String> {
  tokio::task::spawn_blocking(move || {
    let _disk = disk::lock()?;
    let project = disk::project(&project_id)?;
    Ok(design_apply::reconcile_receipt(&project, &app.state::<AppState>())?.map(|r| r.receipt))
  })
  .await
  .map_err(|e| format!("Loading the Design Apply receipt failed: {e}"))?
}

#[tauri::command]
pub async fn design_apply_finish(
  app: AppHandle,
  project_id: String,
  apply_id: String,
  verified: bool,
) -> Result<DesignApplyReceipt, String> {
  tokio::task::spawn_blocking(move || design_apply::finish(&app, &project_id, &apply_id, verified))
    .await
    .map_err(|e| format!("Finishing Design Apply failed: {e}"))?
}
