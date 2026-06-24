//! Rayfin Fabricator — Tauri application entry point.
//!
//! Declares the Rust module tree (ported from the former Electron main process),
//! wires up plugins + managed state, and registers every `#[tauri::command]`
//! that backs the renderer's `window.api` surface (see `src/shared/ipc.ts`).

mod commands;
mod error;
mod services;
mod state;
mod types;

use tauri::Manager;

use state::AppState;

use services::preview::PreviewState;
use services::updater::UpdaterState;

/// Read the bundled telemetry connection string (App Insights) if present.
/// Mirrors the Electron build, which injects `resources/telemetry.json` at
/// package time. Absent in dev → telemetry is a no-op.
fn telemetry_connection_string(app: &tauri::App) -> Option<String> {
  let dir = app.path().resource_dir().ok()?;
  let candidates = [
    dir.join("telemetry.json"),
    dir.join("resources").join("telemetry.json"),
  ];
  for path in candidates {
    if let Ok(raw) = std::fs::read_to_string(&path) {
      if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
        if let Some(cs) = json.get("connectionString").and_then(|v| v.as_str()) {
          if !cs.trim().is_empty() {
            return Some(cs.to_string());
          }
        }
      }
    }
  }
  None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  services::crashlog::install_panic_hook();

  // Repair PATH before anything spawns a child process: a Finder/Dock-launched
  // macOS app inherits a minimal PATH that omits Homebrew and Node version
  // managers, so the doctor would otherwise report Node/npm/Rayfin CLI as missing.
  services::env_path::repair();

  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(AppState::default())
    .manage(PreviewState::default())
    .manage(UpdaterState::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      let version = app.package_info().version.to_string();
      services::telemetry::init(telemetry_connection_string(app), version);

      // Materialize Fabricator's product-scoped agent skills/instructions under
      // app-data so chat sessions can inject them (never written into the repo).
      services::agent_skills::ensure_materialized();

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      // misc
      commands::misc::ping,
      commands::misc::get_versions,
      commands::misc::open_external,
      commands::misc::open_logs,
      commands::misc::open_in_editor,
      commands::misc::relaunch,
      // updates
      commands::updates::update_check,
      commands::updates::update_download,
      commands::updates::update_install,
      // settings
      commands::settings::settings_get,
      commands::settings::settings_set,
      // doctor
      commands::doctor::doctor_check,
      commands::doctor::doctor_install,
      commands::doctor::doctor_install_all,
      // auth
      commands::auth::auth_status,
      commands::auth::auth_login_copilot,
      commands::auth::auth_login_rayfin,
      commands::auth::auth_logout_rayfin,
      // fabric
      commands::fabric::fabric_workspaces,
      commands::fabric::fabric_delete_apps,
      // projects
      commands::projects::projects_state,
      commands::projects::projects_templates,
      commands::projects::projects_community_templates,
      commands::projects::projects_pick_folder,
      commands::projects::projects_pick_workspace_root,
      commands::projects::projects_set_workspace_root,
      commands::projects::projects_create,
      commands::projects::projects_open,
      commands::projects::projects_set_active,
      commands::projects::projects_rename,
      commands::projects::projects_set_workspace,
      commands::projects::projects_set_preview_mode,
      commands::projects::projects_remove,
      commands::projects::projects_git_status,
      commands::projects::projects_git_commit,
      commands::projects::projects_git_log,
      commands::projects::projects_git_changes,
      commands::projects::projects_git_file_diff,
      commands::projects::projects_git_compare_changes,
      commands::projects::projects_git_compare_file_diff,
      commands::projects::projects_git_file_log,
      commands::projects::projects_git_revert,
      commands::projects::projects_git_remote_status,
      commands::projects::projects_git_divergence,
      commands::projects::projects_git_pull,
      commands::projects::projects_git_push,
      commands::projects::projects_files_tree,
      commands::projects::projects_files_read,
      // rayfin versions
      commands::rayfin_version::rayfin_versions,
      // skills
      commands::skills::skills_list,
      commands::skills::skills_set,
      commands::skills::skills_source,
      // advisor
      commands::advisor::advisor_run,
      commands::advisor::advisor_cancel,
      commands::advisor::advisor_load,
      // chat
      commands::chat::chat_send,
      commands::chat::chat_steer,
      commands::chat::chat_cancel,
      commands::chat::chat_reset,
      commands::chat::chat_resolve_plan,
      commands::chat::chat_history,
      commands::chat::chat_save_history,
      commands::chat::chat_set_options,
      commands::chat::chat_models,
      // suggestions
      commands::suggest::chat_suggest,
      commands::suggest::chat_suggest_cancel,
      // threads
      commands::threads::threads_list,
      commands::threads::threads_create,
      commands::threads::threads_remove,
      commands::threads::threads_merge,
      // screenshot
      commands::screenshot::screenshot_save,
      commands::screenshot::screenshot_cleanup,
      // deploy
      commands::deploy::deploy_run,
      commands::deploy::deploy_status,
      commands::deploy::deploy_has_changes,
      commands::deploy::deploy_list,
      commands::deploy::deploy_switch,
      commands::deploy::deploy_set_name,
      commands::deploy::deploy_reconcile,
      // preview
      services::preview::preview_show_url,
      services::preview::preview_navigate,
      services::preview::preview_set_bounds,
      services::preview::preview_hide,
      services::preview::preview_reload,
      services::preview::preview_clear_data,
      services::preview::preview_back,
      services::preview::preview_forward,
      services::preview::preview_capture,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
