//! Fabricator — Tauri application entry point.
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
use services::dev_server::DevServers;

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

/// When the user enabled "compatibility rendering" (e.g. to fix freezing under
/// Parallels/VMs), force WebView2 to software-render by disabling GPU before any
/// window is created — WebView2 reads `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` when
/// its environment is created, so this must run before the Tauri builder. The
/// preference is read straight off disk (the store is file-based, no app handle
/// needed). Windows-only; a no-op elsewhere. Changing the toggle requires a
/// relaunch to take effect.
#[cfg(windows)]
fn apply_compatibility_rendering() {
  let enabled = services::store::get_settings()
    .experiments
    .and_then(|e| e.compatibility_rendering)
    .unwrap_or(false);
  if !enabled {
    return;
  }
  // Disable hardware GPU + GPU compositing so Chromium falls back to its software
  // (SwiftShader) renderer, and turn off D3D11 + GPU rasterization too — the
  // virtualized GPU in Parallels/VMs misreports capabilities and otherwise hangs
  // or paints garbage. We deliberately do NOT disable the software rasterizer,
  // since that fallback is exactly what we want the VM to use.
  const FLAGS: &str =
    "--disable-gpu --disable-gpu-compositing --disable-gpu-rasterization --disable-d3d11";
  const KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
  let merged = match std::env::var(KEY) {
    Ok(existing) if !existing.trim().is_empty() => format!("{existing} {FLAGS}"),
    _ => FLAGS.to_string(),
  };
  std::env::set_var(KEY, merged);
}

#[cfg(not(windows))]
fn apply_compatibility_rendering() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  services::crashlog::install_panic_hook();

  // Repair PATH before anything spawns a child process: a Finder/Dock-launched
  // macOS app inherits a minimal PATH that omits Homebrew and Node version
  // managers, so the doctor would otherwise report Node/npm/Rayfin CLI as missing.
  services::env_path::repair();

  // Apply the "compatibility rendering" preference before the webview is created
  // (WebView2 reads this env var at environment creation). Fixes freezing/hangs in
  // VMs such as Parallels where the virtualized GPU misbehaves.
  apply_compatibility_rendering();

  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(AppState::default())
    .manage(PreviewState::default())
    .manage(UpdaterState::default())
    .manage(DevServers::default())
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

      // Watch for main-thread freezes (Parallels/VM hangs) and record them. The
      // monitor actively probes the main thread, so an idle (event-starved) loop
      // is never mistaken for a hang.
      services::watchdog::start(app.handle().clone());

      // Trim old chat-session diagnostics so the logs directory stays bounded.
      // Runs once at startup so per-turn capture adds no pruning I/O.
      services::diagnostics::prune();

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
      // diagnostics
      commands::diagnostics::diagnostics_export,
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
      commands::auth::auth_login_az,
      commands::auth::auth_logout_rayfin,
      // github (optional gh CLI: clone-from-GitHub)
      commands::github::github_status,
      commands::github::github_login,
      commands::github::github_list_repos,
      commands::github::github_clone,
      // fabric
      commands::fabric::fabric_workspaces,
      commands::fabric::fabric_reports,
      commands::fabric::fabric_report_definition,
      commands::fabric::fabric_export_report_pdf,
      commands::fabric::fabric_save_report_pages,
      commands::fabric::fabric_semantic_model_definition,
      commands::fabric::fabric_sign_in,
      commands::fabric::fabric_capacities,
      commands::fabric::fabric_create_workspace,
      commands::fabric::fabric_delete_apps,
      commands::fabric::fabric_semantic_model_schema,
      // projects
      commands::projects::projects_state,
      commands::projects::projects_templates,
      commands::projects::projects_community_templates,
      commands::projects::projects_pick_folder,
      commands::projects::projects_pick_workspace_root,
      commands::projects::projects_set_workspace_root,
      commands::projects::projects_create,
      commands::projects::projects_open,
      commands::projects::projects_prepare_dependencies,
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
      // custom-skill library
      commands::custom_skills::custom_skills_list,
      commands::custom_skills::custom_skills_source,
      commands::custom_skills::custom_skills_save,
      commands::custom_skills::custom_skills_pick_folder_preview,
      commands::custom_skills::custom_skills_pick_file_preview,
      commands::custom_skills::custom_skills_add_from_path,
      commands::custom_skills::custom_skills_promote,
      commands::custom_skills::custom_skills_remove,
      // advisor
      commands::advisor::advisor_run,
      commands::advisor::advisor_cancel,
      commands::advisor::advisor_load,
      commands::advisor::advisor_explain,
      commands::advisor::advisor_explain_cancel,
      // chat
      commands::chat::chat_send,
      commands::chat::chat_steer,
      commands::chat::chat_cancel,
      commands::chat::chat_reset,
      commands::chat::chat_resolve_plan,
      commands::chat::chat_resolve_question,
      commands::chat::chat_export_plan,
      commands::chat::chat_history,
      commands::chat::chat_save_history,
      commands::chat::chat_set_options,
      commands::chat::chat_models,
      // suggestions
      commands::suggest::chat_suggest,
      commands::suggest::chat_suggest_cancel,
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

            services::dev_server::dev_start,
            services::dev_server::dev_stop,
            services::dev_server::dev_supported_cmd,
      // preview
      services::preview::preview_show_url,
      services::preview::preview_navigate,
      services::preview::preview_set_bounds,
      services::preview::preview_hide,
      services::preview::preview_suppress,
      services::preview::preview_reload,
      services::preview::preview_back,
      services::preview::preview_forward,
      services::preview::preview_capture,
      services::preview::preview_design_set,
      services::preview::preview_design_poll,
      services::preview::preview_design_drain,
      services::preview::preview_design_drain_ai,
      services::preview::preview_design_drain_ai_edit,
      services::preview::preview_design_apply_generated,
      services::preview::preview_design_apply_restyle,
      services::preview::preview_design_set_models,
      services::preview::preview_design_set_theme,
      commands::design::design_generate_html,
      commands::design::design_restyle_element,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      services::watchdog::beat();
      // Kill any live Vite dev servers when the app exits so they never orphan.
      if let tauri::RunEvent::Exit = event {
        services::dev_server::kill_all(app);
      }
    });
}
