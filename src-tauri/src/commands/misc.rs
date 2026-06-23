//! Misc app commands: ping, version info, open-external, open-logs, relaunch.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};
use crate::services::paths;
use crate::types::AppVersions;

#[tauri::command]
pub fn ping() -> &'static str {
  "pong"
}

/// Version info for the About/Settings panel. Under Tauri there is no Node/V8
/// runtime, so the panel reports the app, Tauri framework, WebView2 and bundled
/// Copilot CLI versions.
#[tauri::command]
pub async fn get_versions(app: AppHandle) -> AppVersions {
  let app_version = app.package_info().version.to_string();
  let copilot = crate::services::copilot::bundled_cli_version().await;
  AppVersions {
    app: app_version,
    tauri: tauri::VERSION.to_string(),
    webview2: webview_version(),
    copilot,
  }
}

fn webview_version() -> String {
  tauri::webview_version().unwrap_or_default()
}

/// Open a URL in the user's default browser (http/https only).
#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> AppResult<()> {
  if url.starts_with("http://") || url.starts_with("https://") {
    app
      .opener()
      .open_url(url, None::<&str>)
      .map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

/// Open the logs folder in the OS file manager; returns its path.
#[tauri::command]
pub async fn open_logs(app: AppHandle) -> AppResult<String> {
  let dir = paths::logs_dir();
  let path = dir.to_string_lossy().to_string();
  app
    .opener()
    .open_path(path.clone(), None::<&str>)
    .map_err(|e| AppError::Msg(e.to_string()))?;
  Ok(path)
}

/// Restart the app (used to pick up newly installed Node/Git on PATH).
#[tauri::command]
pub fn relaunch(app: AppHandle) {
  app.restart();
}
