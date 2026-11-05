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
#[cfg(test)]
mod vendor_guard;

use tauri::Manager;

use state::AppState;

use services::apps::Opened;
use services::preview::PreviewState;
use services::updater::UpdaterState;
use services::dev_server::DevServers;

/// What the system asked Fabricator to open before it was ready: macOS can
/// hand over a launch's files before `setup` runs.
static EARLY_OPENED: std::sync::Mutex<Option<Vec<Opened>>> = std::sync::Mutex::new(Some(Vec::new()));

/// Hold `opened` until `setup` takes it; `false` once it has, to open it now.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn hold_early(opened: &[Opened]) -> bool {
  match EARLY_OPENED.lock().unwrap().as_mut() {
    Some(held) => {
      held.extend(opened.iter().cloned());
      true
    }
    None => false,
  }
}

/// Open what Fabricator was asked to open: projects in its own window, which
/// imports them, and apps in theirs. With nothing to open, a later launch
/// (`asked`) brings Fabricator's own window forward.
fn open_requested(app: &tauri::AppHandle, opened: Vec<Opened>, asked: bool) {
  let mut projects = Vec::new();
  let mut apps = false;
  for item in opened {
    match item {
      Opened::Project(path) => projects.push(path),
      other => {
        apps = true;
        services::apps::open(app, other);
      }
    }
  }
  let any_project = !projects.is_empty();
  commands::export::queue_opened(app, projects);
  if any_project || (asked && !apps) {
    commands::misc::bring_forward(app);
  }
}

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

/// Env var the Rayfin CLI reads to permit a plaintext token cache when the OS
/// credential store is unavailable.
const RAYFIN_ENCRYPTION_FALLBACK_ENV: &str = "RAYFIN_ENCRYPTION_FALLBACK_ENABLED";

/// Decide what to set [`RAYFIN_ENCRYPTION_FALLBACK_ENV`] to, given whatever the
/// process already inherited: default it to `"true"` when unset, but never
/// clobber a value the user set deliberately (either direction). Kept pure so
/// the policy is unit-tested without mutating global process state.
fn rayfin_encryption_fallback_value(existing: Option<&str>) -> Option<&'static str> {
  match existing {
    Some(_) => None,
    None => Some("true"),
  }
}

/// Let the Rayfin CLI fall back to a plaintext token cache when the OS keychain
/// (DPAPI on Windows, Keychain on macOS, libsecret on Linux) is unavailable.
///
/// By default the CLI *aborts* when it can't reach the credential store —
/// `createCachePlugin` throws "OS keychain is not available and plaintext token
/// storage is not enabled". On locked-down machines where the native binding
/// can't load, that made `rayfin login` — and every silent token read used to
/// list Fabric workspaces or deploy — fail, so the Sign-in button looked like it
/// did nothing (issue #17). The CLI still prefers encrypted storage whenever the
/// keychain works (it only reaches the plaintext branch after the native path
/// throws), so opting in here is a no-op in the common case and only degrades to
/// plaintext when there is genuinely no credential store to use. Setting it in
/// this process propagates to every spawned CLI/auth-helper child.
fn enable_rayfin_encryption_fallback() {
  let existing = std::env::var(RAYFIN_ENCRYPTION_FALLBACK_ENV).ok();
  if let Some(value) = rayfin_encryption_fallback_value(existing.as_deref()) {
    std::env::set_var(RAYFIN_ENCRYPTION_FALLBACK_ENV, value);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  services::crashlog::install_panic_hook();

  // GUI launchers can inherit a stale Windows PATH or a minimal macOS PATH
  // that omits installed CLIs. Repair it before spawning any child processes.
  services::env_path::repair();

  // Allow the Rayfin CLI to use a plaintext token cache when the OS keychain is
  // unavailable, so Fabric sign-in works on machines without a usable credential
  // store (issue #17). Must run before anything spawns the CLI or its helpers.
  enable_rayfin_encryption_fallback();

  // Point the Rayfin CLI at the Fabric account chosen in Accounts (each extra
  // account has its own config folder). Also before anything spawns the CLI.
  services::fabric_accounts::init();

  // Quiet npm installs (no audit or funding passes) with normal registry
  // metadata freshness checks; scaffolding additionally revalidates metadata for
  // the latest CLI. Set before any child spawns so deploy-time installs and agent
  // installs inherit it.
  services::npm_env::configure_env();

  let builder = tauri::Builder::default();
  // One Fabricator at a time on Windows, where opening a .fabricator or .rayfin
  // file, or an installed app's shortcut, starts the app again with it: that
  // launch hands it to the running app and exits. Release builds only, so a
  // development build still runs beside the installed app.
  #[cfg(all(windows, not(debug_assertions)))]
  let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
    let opened = services::apps::opened_in(args.into_iter().skip(1), Some(std::path::Path::new(&cwd)));
    open_requested(app, opened, true);
  }));

  builder
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(AppState::default())
    .manage(PreviewState::default())
    .manage(UpdaterState::default())
    .manage(DevServers::default())
    .manage(services::local_backend::LocalBackends::default())
    .manage(services::apps::Apps::default())
    // The stills the preview leaves in its place under an HTML overlay.
    .register_uri_scheme_protocol(services::preview::STILL_SCHEME, services::preview::serve_still)
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

      // What Fabricator was started to open: Windows passes files and
      // `--app <key>` as arguments, and macOS may have handed files over
      // already. Started only to run apps, Fabricator's own window never opens.
      let cwd = std::env::current_dir().ok();
      let mut opened = services::apps::opened_in(std::env::args_os().skip(1), cwd.as_deref());
      opened.extend(EARLY_OPENED.lock().unwrap().take().unwrap_or_default());
      let apps_only = !opened.is_empty() && opened.iter().all(|o| !matches!(o, Opened::Project(_)));
      if !apps_only {
        commands::misc::open_main_window(app.handle())?;
      }
      open_requested(app.handle(), opened, false);

      // Watch for main-thread freezes (Parallels/VM hangs) and record them. The
      // monitor actively probes the main thread, so an idle (event-starved) loop
      // is never mistaken for a hang.
      services::watchdog::start(app.handle().clone());

      // Journal the local backends' problems that their supervisor only reports
      // in its status, so Help can see them (see commands::help::local_journal).
      commands::help::watch_local_backends(app.handle());

      // Housekeeping nothing needs during startup runs off the main thread, so
      // the window and the first commands aren't kept waiting on the disk:
      //   - materialize Fabricator's product-scoped agent skills/instructions
      //     under app-data, which chat sessions inject (never into the repo);
      //   - trim old chat-session diagnostics, so the logs directory stays
      //     bounded (once per launch, so per-turn capture adds no pruning I/O);
      //   - remove retired app-data storage nothing reads anymore: the Design
      //     Studio experiment's drafts, receipts and imported assets, and the
      //     per-user npm cache earlier releases seeded from a cache bundled with
      //     the app (a no-op once they're gone);
      //   - delete the packages set aside for new projects that are out of
      //     use, and what setting them aside left behind when Fabricator
      //     stopped part way (last: a spare is tens of thousands of files);
      //   - delete what installing, updating or removing an installed app left
      //     when Fabricator stopped part way, and the folders security checks
      //     of project and app files unpacked them into.
      std::thread::spawn(|| {
        services::agent_skills::ensure_materialized();
        services::diagnostics::prune();
        for (dir, what) in [
          (services::paths::retired_design_studio_dir(), "Design Studio data"),
          (services::paths::retired_npm_cache_dir(), "npm cache"),
        ] {
          if dir.is_dir() {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
              log::warn!("failed to remove retired {what} at {}: {e}", dir.display());
            }
          }
        }
        services::new_project_cache::clean_up();
        services::apps::clean_up();
        commands::security::clean_up();
      });

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      // misc
      commands::misc::ping,
      commands::misc::get_versions,
      commands::misc::open_external,
      commands::misc::open_logs,
      commands::misc::open_in_editor,
      commands::misc::window_reveal,
      commands::misc::relaunch,
      // diagnostics
      commands::diagnostics::diagnostics_export,
      commands::diagnostics::diagnostics_record,
      // updates
      commands::updates::update_check,
      commands::updates::update_download,
      commands::updates::update_install,
      // settings
      commands::settings::settings_get,
      commands::settings::settings_set,
      // your own API keys
      commands::byok::byok_status,
      commands::byok::byok_set_key,
      commands::byok::byok_refresh,
      commands::byok::byok_remove_key,
      commands::byok::byok_set_models,
      // MCP servers (experiment)
      commands::mcp::mcp_list,
      commands::mcp::mcp_save,
      commands::mcp::mcp_remove,
      commands::mcp::mcp_check,
      // doctor
      commands::doctor::doctor_check,
      commands::doctor::doctor_install,
      commands::doctor::doctor_install_all,
      // auth
      commands::auth::auth_status,
      commands::auth::auth_check,
      commands::auth::auth_login_copilot,
      commands::auth::auth_login_rayfin,
      commands::auth::auth_refresh_rayfin,
      commands::auth::auth_login_az,
      commands::auth::auth_logout_copilot,
      commands::auth::auth_logout_rayfin,
      commands::auth::auth_logout_az,
      // accounts (several Fabric and Azure CLI accounts)
      commands::accounts::fabric_accounts,
      commands::accounts::fabric_add_account,
      commands::accounts::fabric_use_account,
      commands::accounts::fabric_sign_out_account,
      commands::accounts::azure_accounts,
      commands::accounts::azure_use_account,
      commands::accounts::azure_sign_out_account,
      // github (optional gh CLI: clone-from-GitHub, accounts)
      commands::github::github_status,
      commands::github::github_login,
      commands::github::github_accounts,
      commands::github::github_add_account,
      commands::github::github_switch_account,
      commands::github::github_sign_out_account,
      commands::github::github_list_repos,
      commands::github::github_clone,
      // team workspaces (experimental)
      commands::team::team_env_status,
      commands::team::team_github_signin,
      commands::team::team_owners,
      commands::team::team_repos,
      commands::team::team_capacities,
      commands::team::team_create,
      commands::team::team_resume_setup,
      commands::team::team_abandon_plan,
      commands::team::team_abandon_setup,
      commands::team::team_cancel,
      commands::team::team_join_options,
      commands::team::team_accept_invitation,
      commands::team::team_join,
      commands::team::team_detail,
      commands::team::team_leave,
      commands::team::team_delete,
      commands::team::team_open_project,
      commands::team::team_create_project,
      commands::team::team_move_project,
      commands::team::team_remove_project,
      commands::team::team_sync,
      commands::team::team_status,
      commands::team::team_update,
      commands::team::team_discard,
      commands::team::team_set_view,
      commands::team::team_run_log,
      commands::team::team_publish,
      commands::team::team_review_requests,
      commands::team::team_approve,
      commands::team::team_members,
      commands::team::team_invite,
      commands::team::team_grant_fabric_access,
      commands::team::team_fabric_access,
      commands::team::team_revoke_fabric_access,
      commands::team::team_remove_member,
      commands::team::team_set_require_review,
      commands::team::team_health,
      commands::team::team_repair,
      commands::team::team_set_account,
      commands::team::team_runner,
      commands::team::team_set_runner,
      commands::team::team_map,
      commands::team::team_activity,
      commands::team::team_diff,
      commands::team::team_resources,
      commands::team::team_diagnose,
      // fabric
      commands::fabric::fabric_workspaces,
      commands::fabric::fabric_capacities,
      commands::fabric::fabric_create_workspace,
      commands::fabric::fabric_delete_apps,
      commands::fabric::fabric_semantic_model_schema,
      commands::fabric::fabric_project_semantic_models,
      commands::fabric::fabric_share_app,
      commands::fabric::fabric_directory_search,
      commands::fabric::fabric_list_workspace_models,
      commands::fabric::fabric_list_workspace_data,
      commands::fabric::fabric_check_deploy_target,
      commands::migration::migration_workspaces,
      commands::migration::migration_reports,
      commands::migration::migration_search,
      commands::migration::migration_inspect,
      commands::migration::migration_start,
      commands::migration::migration_state,
      commands::migration::migration_resume,
      commands::migration::migration_pdf,
      commands::migration::migration_save_page,
      commands::migration::migration_finish_images,
      commands::migration::migration_set_page_status,
      commands::migration::migration_cancel,
      commands::migration::migration_dismiss,
      // app gallery
      commands::gallery::gallery_list,
      commands::gallery::gallery_status,
      commands::gallery::gallery_describe,
      // projects
      commands::projects::projects_state,
      commands::projects::projects_check_name,
      commands::projects::projects_community_templates,
      commands::projects::projects_pick_folder,
      commands::projects::projects_check_location,
      commands::projects::projects_create_location,
      commands::projects::projects_pick_workspace_root,
      commands::projects::projects_set_workspace_root,
      commands::projects::projects_create,
      commands::projects::projects_open,
      commands::projects::projects_prepare_dependencies,
      commands::projects::projects_set_active,
      commands::projects::projects_set_pinned,
      commands::projects::projects_reveal,
      commands::projects::projects_thumbnail_save,
      commands::projects::projects_thumbnails,
      commands::projects::projects_rename,
      commands::projects::projects_set_workspace,
      commands::projects::projects_set_preview_mode,
      commands::projects::projects_remove,
      commands::export::projects_export_preview,
      commands::export::projects_export,
      commands::export::projects_export_app,
      commands::export::projects_export_stop,
      commands::export::projects_export_reveal,
      commands::export::projects_import_pick,
      commands::export::projects_import_inspect,
      commands::export::projects_import,
      commands::security::security_check,
      commands::security::security_check_cancel,
      commands::export::projects_opened_exports,
      // apps installed from .rayfin files
      commands::apps::apps_window,
      commands::apps::apps_install,
      commands::apps::apps_run,
      commands::apps::apps_logs,
      commands::apps::apps_close,
      commands::apps::apps_list,
      commands::apps::apps_open,
      commands::apps::apps_remove,
      commands::projects::projects_git_status,
      commands::projects::projects_git_commit,
      commands::commit_message::projects_git_message,
      commands::projects::projects_git_save_turn,
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
      commands::projects::projects_git_branches,
      commands::projects::projects_git_switch,
      commands::projects::projects_git_merge_latest,
      commands::projects::projects_git_finish_merge,
      commands::projects::projects_git_abort_merge,
      commands::projects::projects_files_tree,
      commands::projects::projects_files_read,
      commands::projects::projects_files_list_dir,
      // rayfin versions
      commands::rayfin_version::rayfin_versions,
      commands::rayfin_version::rayfin_latest,
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
      // function secrets
      commands::secrets::secrets_list,
      commands::secrets::secrets_set,
      commands::secrets::secrets_delete,
      commands::secrets::secrets_declare,
      // advisor
      commands::advisor::advisor_collect,
      commands::advisor::advisor_run,
      commands::advisor::advisor_cancel,
      commands::advisor::advisor_load,
      commands::advisor::advisor_save_state,
      commands::advisor::advisor_explain,
      commands::advisor::advisor_explain_cancel,
      commands::advisor::advisor_verify,
      commands::advisor::advisor_verify_cancel,
      // help assistant
      commands::help::help_ask,
      commands::help::help_cancel,
      commands::help::help_grounding,
      commands::help::help_history_clear,
      commands::help::help_history_load,
      commands::help::help_history_save,
      commands::help::help_pick_paths,
      commands::help::help_prepare,
      // chat
      commands::chat::chat_send,
      commands::chat::chat_steer,
      commands::chat::chat_cancel,
      commands::chat::chat_reset,
      commands::chat::chat_resolve_plan,
      commands::chat::chat_resolve_question,
      commands::chat::chat_export_plan,
      commands::chat::chat_pick_paths,
      commands::chat::chat_inspect_paths,
      commands::chat::chat_history,
      commands::chat::chat_save_history,
      commands::chat::chat_set_options,
      commands::chat::chat_set_plugin,
      commands::chat::chat_models,
      commands::chat::chat_auto_tiers,
      commands::chat::chat_usage,
      commands::chat::chat_quota,
      // suggestions
      commands::suggest::chat_suggest,
      commands::suggest::chat_suggest_cancel,
      // screenshot
      commands::screenshot::screenshot_save,
      commands::screenshot::screenshot_read,
      commands::screenshot::screenshot_cleanup,
      // deploy
      commands::deploy::deploy_run,
      commands::deploy::deploy_status,
      commands::deploy::deploy_has_changes,
      commands::deploy::deploy_pending,
      commands::deploy::deploy_list,
      commands::deploy::deploy_switch,
      commands::deploy::deploy_remove,
      commands::deploy::deploy_set_name,
      commands::deploy::deploy_reconcile,

            services::dev_server::dev_start,
            services::dev_server::dev_stop,
            services::dev_server::dev_supported_cmd,
            services::dev_server::dev_port_plan,
            services::dev_server::dev_free_port,
            services::dev_server::dev_register_port,
      // preview
      services::preview::preview_show_url,
      services::preview::preview_preload,
      services::preview::preview_navigate,
      services::preview::preview_set_bounds,
      services::preview::preview_hide,
      services::preview::preview_suppress,
      services::preview::preview_reload,
      services::preview::preview_back,
      services::preview::preview_forward,
      services::preview::preview_capture,
      services::preview::preview_still,
      services::preview::preview_design_set,
      services::preview::preview_design_poll,
      services::preview::preview_design_snapshot,
      services::preview::preview_design_command,
      services::preview::preview_design_set_theme,
      // the app gallery's quick look
      services::quicklook::quicklook_show,
      services::quicklook::quicklook_set_bounds,
      services::quicklook::quicklook_close,
      commands::design::design_variations,
      commands::design::design_polish,
      commands::design::design_locate,
      // local backend (rayfin-local)
      commands::local::local_start,
      commands::local::local_stop,
      commands::local::local_restart,
      commands::local::local_status,
      commands::local::local_logs,
      commands::local::local_reload,
      commands::local::local_reset_data,
      commands::local::local_users,
      commands::local::local_add_user,
      commands::local::local_delete_user,
      commands::local::local_identity,
      commands::local::local_set_identity,
      commands::local::local_entities,
      commands::local::local_rows,
      commands::local::local_clear_rows,
      commands::local::local_storage,
      commands::local::local_files,
      commands::local::local_file,
      commands::local::local_save_file,
      commands::local::local_delete_file,
      commands::local::local_clear_files,
      commands::local::local_seed,
      commands::local::local_load_seed,
      commands::local::local_save_seed,
      commands::local::local_secrets,
      commands::local::local_set_secret,
      commands::local::local_delete_secret,
      commands::local::local_stop_external,
      commands::local::local_install_packages,
      commands::local::local_reinstall_packages,
      commands::local::local_report_fallback,
      // Preview as: clear the local preview's site data and reload it
      services::preview::preview_reset_site_data,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      services::watchdog::beat();
      // macOS hands Fabricator the files opened with it as events, at launch
      // (possibly before `setup`) and while it runs.
      #[cfg(target_os = "macos")]
      {
        if let tauri::RunEvent::Opened { urls } = &event {
          let files = urls.iter().filter_map(|url| url.to_file_path().ok());
          let opened = services::apps::opened_in(files, None);
          if !hold_early(&opened) {
            open_requested(app, opened, false);
          }
        }
        // The Dock icon was clicked: show Fabricator's own window when it's
        // closed, or when nothing of Fabricator's shows.
        if let tauri::RunEvent::Reopen { has_visible_windows, .. } = &event {
          if !has_visible_windows || app.get_window("main").is_none() {
            commands::misc::bring_forward(app);
          }
        }
      }
      // Kill any live Vite dev servers when the app exits so they never orphan.
      if let tauri::RunEvent::Exit = event {
        services::dev_server::kill_all(app);
        services::local_backend::kill_all(app);
        services::apps::kill_all(app);
      }
    });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn defaults_rayfin_encryption_fallback_on_when_unset() {
    // Regression for #17: with no inherited value the CLI would abort on
    // keychain-less machines, so we must default the fallback on.
    assert_eq!(rayfin_encryption_fallback_value(None), Some("true"));
  }

  #[test]
  fn respects_an_explicit_rayfin_encryption_fallback_override() {
    // A value the user set deliberately (either direction) is left untouched.
    assert_eq!(rayfin_encryption_fallback_value(Some("true")), None);
    assert_eq!(rayfin_encryption_fallback_value(Some("false")), None);
    assert_eq!(rayfin_encryption_fallback_value(Some("")), None);
  }
}
