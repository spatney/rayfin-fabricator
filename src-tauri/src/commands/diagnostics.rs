//! Diagnostics commands: export a shareable diagnostics bundle for bug reports.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};
use crate::services::{diagnostics, paths};

/// Build a single consolidated diagnostics file (environment + recent chat-turn
/// diagnostics + crash/hang log tail), reveal the containing logs folder in the
/// OS file manager, and return the file's path. The renderer references this
/// path in the prefilled GitHub issue so the user can attach it.
#[tauri::command]
pub async fn diagnostics_export(app: AppHandle) -> AppResult<String> {
  let app_version = app.package_info().version.to_string();
  let copilot = crate::services::copilot::bundled_cli_version()
    .await
    .unwrap_or_else(|| "unknown".to_string());
  let extra = vec![
    ("tauri", tauri::VERSION.to_string()),
    ("webview2", tauri::webview_version().unwrap_or_default()),
    ("copilot", copilot),
  ];

  let path = diagnostics::export_bundle(&app_version, &extra).map_err(AppError::Msg)?;

  // Reveal the logs folder so the freshly written bundle is easy to grab/attach.
  // Failing to open the folder must not fail the export itself.
  let _ = app
    .opener()
    .open_path(paths::logs_dir().to_string_lossy().to_string(), None::<&str>);

  Ok(path.to_string_lossy().to_string())
}
