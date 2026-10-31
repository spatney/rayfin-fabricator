//! The app gallery (experimental): every Rayfin app the Azure CLI's account can
//! open in Fabric, including apps that aren't on this computer. See
//! [`crate::services::gallery`].

use crate::services::gallery::{self, GalleryRef, GalleryResult, GalleryStatus};
use crate::services::store;

const OFF: &str = "Turn on App gallery in Settings → Experiments first.";

/// Every Rayfin app the Azure CLI's account can open. `refresh` signs in to
/// Azure afresh and reads every status again. Never fails across IPC.
#[tauri::command]
pub async fn gallery_list(refresh: Option<bool>) -> GalleryResult {
  if !store::app_gallery_enabled() {
    return GalleryResult { ok: false, error: Some(OFF.into()), ..Default::default() };
  }
  gallery::list(refresh.unwrap_or(false)).await
}

/// Each app's address and last publish, in the order asked.
#[tauri::command]
pub async fn gallery_status(apps: Vec<GalleryRef>) -> Vec<GalleryStatus> {
  if !store::app_gallery_enabled() {
    return apps.into_iter().map(|a| GalleryStatus { id: a.id, unknown: true, ..Default::default() }).collect();
  }
  gallery::status(apps).await
}
