//! The app gallery: every Rayfin app the Azure CLI's account can open in
//! Fabric, including apps that aren't on this computer. See
//! [`crate::services::gallery`].

use crate::services::gallery::{self, GalleryRef, GalleryResult, GalleryStatus};

/// Every Rayfin app the Azure CLI's account can open. `refresh` signs in to
/// Azure afresh and reads every status again. Never fails across IPC.
#[tauri::command]
pub async fn gallery_list(refresh: Option<bool>) -> GalleryResult {
  gallery::list(refresh.unwrap_or(false)).await
}

/// Each app's address and last publish, in the order asked.
#[tauri::command]
pub async fn gallery_status(apps: Vec<GalleryRef>) -> Vec<GalleryStatus> {
  gallery::status(apps).await
}