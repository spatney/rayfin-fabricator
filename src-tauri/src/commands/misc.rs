//! Misc app commands: ping, version info, open-external, open-logs, relaunch.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};
use crate::services::paths;
use crate::types::{AppVersions, OpenInEditorResult};

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
  let copilot_bundled = crate::services::copilot::bundled_cli_pinned_version();
  AppVersions {
    app: app_version,
    tauri: tauri::VERSION.to_string(),
    webview2: webview_version(),
    copilot,
    copilot_bundled,
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

/// Open the project folder in VS Code (`code <dir>`). Falls back to revealing the
/// folder in the OS file manager when VS Code's CLI isn't installed.
#[tauri::command]
pub async fn open_in_editor(app: AppHandle, id: String) -> AppResult<OpenInEditorResult> {
  let project = crate::services::store::find_project(&id)
    .ok_or_else(|| AppError::Msg("Project not found.".into()))?;
  let path = project.path.clone();

  if launch_vscode(&path) {
    return Ok(OpenInEditorResult { opened: true, revealed_folder: None });
  }
  app
    .opener()
    .open_path(path.clone(), None::<&str>)
    .map_err(|e| AppError::Msg(e.to_string()))?;
  Ok(OpenInEditorResult { opened: false, revealed_folder: Some(true) })
}

/// Try to launch VS Code on `dir`, detached. Returns false when `code` isn't on PATH
/// or the spawn failed. On Windows `code` is a `.cmd` shim that must run via cmd.exe.
fn launch_vscode(dir: &str) -> bool {
  use std::process::{Command, Stdio};
  if which::which("code").is_err() {
    return false;
  }
  #[cfg(windows)]
  let mut cmd = {
    let mut c = Command::new("cmd");
    c.args(["/C", "code"]).arg(dir);
    c
  };
  #[cfg(not(windows))]
  let mut cmd = {
    let code = which::which("code").expect("checked above");
    let mut c = Command::new(code);
    c.arg(dir);
    c
  };
  cmd
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .is_ok()
}

/// Restart the app (used to pick up newly installed Node/Git on PATH).
#[tauri::command]
pub fn relaunch(app: AppHandle) {
  app.restart();
}
