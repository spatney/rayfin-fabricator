//! Diagnostics commands: export a shareable diagnostics bundle for bug reports,
//! and record renderer activity into the structured journal.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};
use crate::services::journal::{self, Area, Level, Surface};
use crate::services::{diagnostics, local_backend, paths, store};
use crate::types::ToolStatus;

/// Record one renderer event in the activity journal.
///
/// Called from the renderer's single chokepoint (`reportError` / `reportEvent`),
/// which every error toast, error boundary, unhandled rejection and notable
/// success funnels through. Best-effort by design: recording must never fail
/// the operation it is describing, so this always returns `Ok`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn diagnostics_record(
  level: Option<String>,
  area: String,
  event: Option<String>,
  message: String,
  surface: Option<String>,
  operation: Option<String>,
  detail: Option<String>,
  project_id: Option<String>,
  dev: Option<bool>,
) {
  let level = level.as_deref().map(Level::parse).unwrap_or(Level::Error);
  let area = Area::parse(&area);
  let event = event.unwrap_or_else(|| match level {
    Level::Info => "app.ok".to_string(),
    _ => "app.failed".to_string(),
  });
  let mut entry = journal::entry(level, area, &event, &message)
    .operation(operation.unwrap_or_default())
    .detail(detail)
    .project(project_id);
  entry.operation = entry.operation.filter(|o| !o.is_empty());
  if level != Level::Info {
    entry = entry.surface(surface.as_deref().map(Surface::parse).unwrap_or(Surface::Toast));
  }
  if let Some(dev) = dev {
    entry = entry.dev(dev);
  }
  entry.write();
}

/// Build a single consolidated diagnostics file (environment + recent errors +
/// recent chat-turn diagnostics + crash/hang log tail + each project's local
/// backend status and output), reveal the containing logs folder in the OS file
/// manager, and return the file's path. The renderer references this path in
/// the prefilled GitHub issue so the user can attach it. Everything in it is
/// redacted (see [`diagnostics::redact`]).
#[tauri::command]
pub async fn diagnostics_export(app: AppHandle) -> AppResult<String> {
  let app_version = app.package_info().version.to_string();
  let copilot = crate::services::copilot::bundled_cli_version()
    .await
    .unwrap_or_else(|| "unknown".to_string());
  let local = local_backend_reports(&app);
  // A backend that ran this session already said which rayfin-local it is;
  // otherwise ask the bundled one, which also says why it can't run.
  let rayfin_local = match local.iter().find_map(|r| r.status.as_ref()?.version.clone()) {
    Some(version) => version,
    None => rayfin_local_version(&local_backend::doctor_status().await),
  };
  let extra = vec![
    ("tauri", tauri::VERSION.to_string()),
    ("webview2", tauri::webview_version().unwrap_or_default()),
    ("copilot", copilot),
    ("rayfin-local", rayfin_local),
  ];

  let path = diagnostics::export_bundle(&app_version, &extra, &local).map_err(AppError::Msg)?;

  // Reveal the logs folder so the freshly written bundle is easy to grab/attach.
  // Failing to open the folder must not fail the export itself.
  let _ = app
    .opener()
    .open_path(paths::logs_dir().to_string_lossy().to_string(), None::<&str>);

  Ok(path.to_string_lossy().to_string())
}

/// The bundled rayfin-local's version, or why it couldn't be had.
fn rayfin_local_version(status: &ToolStatus) -> String {
  match (&status.version, status.satisfied) {
    (Some(version), true) => version.clone(),
    _ => {
      let why = status.check_error.as_deref().unwrap_or(&status.install_hint);
      let why: String = why.lines().next().unwrap_or_default().trim().chars().take(200).collect();
      format!("unavailable ({why})")
    }
  }
}

/// Every personal project's local backend, as the supervisor holds it. Team
/// apps don't run on one.
fn local_backend_reports(app: &AppHandle) -> Vec<diagnostics::LocalBackendReport> {
  store::get_state()
    .projects
    .into_iter()
    .filter(|p| p.team.is_none())
    .map(|p| {
      let status = local_backend::snapshot(app, &p.id);
      diagnostics::LocalBackendReport {
        project_id: p.id,
        project_name: p.name,
        status: (status.revision > 0).then_some(status),
      }
    })
    .collect()
}
