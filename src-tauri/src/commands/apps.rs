//! IPC for apps installed from `.rayfin` files (`window.api.apps`): the page
//! Fabricator shows in an app's window, which acts on that window's app, and
//! Home's list. The work is in [`crate::services::apps`].

use tauri::{AppHandle, Window};

use crate::services::apps;
use crate::types::{AppActionResult, AppWindowInfo, InstalledApp, LocalLogEvent};

/// What the calling app window is for: an app file to install, or the installed app.
#[tauri::command]
pub async fn apps_window(app: AppHandle, window: Window) -> AppWindowInfo {
  apps::window_info(&app, window.label()).await
}

/// Install the app file the calling window was opened with (progress on
/// `apps:progress`). The window then runs it with [`apps_run`].
#[tauri::command]
pub async fn apps_install(app: AppHandle, window: Window) -> AppActionResult {
  apps::install(&app, window.label()).await
}

/// Start the calling window's app (its state on `apps:state`). The window
/// shows the app once it's ready.
#[tauri::command]
pub async fn apps_run(app: AppHandle, window: Window) -> AppActionResult {
  apps::run_window(&app, window.label()).await
}

/// The last lines of the calling window's app's output, oldest first.
#[tauri::command]
pub fn apps_logs(app: AppHandle, window: Window) -> Vec<LocalLogEvent> {
  apps::logs(&app, window.label())
}

/// Close the calling app window, which stops its app.
#[tauri::command]
pub fn apps_close(window: Window) {
  if apps::is_app_window(window.label()) {
    let _ = window.close();
  }
}

/// Every installed app, by name.
#[tauri::command]
pub fn apps_list(app: AppHandle) -> Vec<InstalledApp> {
  apps::list(&app)
}

/// Open an installed app in its window.
#[tauri::command]
pub fn apps_open(app: AppHandle, key: String) {
  apps::open(&app, apps::Opened::App(key));
}

/// Remove an installed app, its data and its shortcut.
#[tauri::command]
pub async fn apps_remove(app: AppHandle, key: String) -> AppActionResult {
  apps::remove(&app, &key).await
}
