//! JSON-file persistence for app state — the Rust counterpart to
//! `src/main/services/store.ts`. State lives in `studio.json` under the per-user
//! data directory and is cached in memory after first read. Credentials are never
//! persisted here (each CLI owns its own credential store).

use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::Value;

use super::paths;
use crate::types::{
  AppSettings, ByokProviderSettings, ByokSettings, ChatDefaults, ExperimentFlags, McpServerEntry, ProjectsState,
  StudioProject, TeamWorkspace,
};

struct Cache {
  state: ProjectsState,
  settings: AppSettings,
}

static CACHE: Lazy<Mutex<Option<Cache>>> = Lazy::new(|| Mutex::new(None));

fn default_state() -> ProjectsState {
  ProjectsState {
    workspace_root: paths::home_dir()
      .join("RayfinProjects")
      .to_string_lossy()
      .to_string(),
    active_project_id: None,
    projects: vec![],
    team_workspaces: vec![],
    recent_locations: vec![],
  }
}

fn default_flags() -> ExperimentFlags {
  ExperimentFlags {
    team_workspaces: Some(false),
    report_migration: Some(false),
    work_iq: Some(false),
    goals: Some(false),
  }
}

fn default_settings() -> AppSettings {
  AppSettings {
    theme: "system".to_string(),
    ui_scale: Some(1.0),
    experiments: Some(default_flags()),
    full_diagnostics: Some(false),
    deploy_mode: None,
    byok: None,
    mcp_servers: Vec::new(),
    chat_defaults: None,
  }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawStore {
  workspace_root: Option<String>,
  #[serde(default)]
  projects: Vec<StudioProject>,
  #[serde(default)]
  team_workspaces: Vec<TeamWorkspace>,
  #[serde(default)]
  recent_locations: Vec<String>,
  /// Read as JSON first, so settings that can't be read fall back to the
  /// defaults without losing the projects (see [`settings_from`]).
  #[serde(default)]
  settings: Option<Value>,
}

/// The saved settings. Settings that can't be read fall back to the defaults
/// without losing the projects; retired experiment flags are dropped as unknown.
fn settings_from(saved: Option<Value>) -> AppSettings {
  saved
    .and_then(|settings| serde_json::from_value(settings).ok())
    .unwrap_or_else(default_settings)
}

/// The projects a saved store holds. The project that was open when
/// Fabricator closed isn't opened again (the store still records it): a
/// launch opens on Home.
fn state_from(parsed: RawStore) -> ProjectsState {
  let mut state = default_state();
  if let Some(root) = parsed.workspace_root {
    state.workspace_root = root;
  }
  state.projects = parsed.projects;
  state.team_workspaces = parsed.team_workspaces;
  state.recent_locations = parsed.recent_locations;
  state
}

fn load() -> Cache {
  match std::fs::read_to_string(paths::store_file()) {
    Ok(raw) => match serde_json::from_str::<RawStore>(&raw) {
      Ok(mut parsed) => {
        let settings = settings_from(parsed.settings.take());
        Cache { state: state_from(parsed), settings }
      }
      Err(_) => Cache {
        state: default_state(),
        settings: default_settings(),
      },
    },
    Err(_) => Cache {
      state: default_state(),
      settings: default_settings(),
    },
  }
}

fn with_cache<R>(f: impl FnOnce(&mut Cache) -> R) -> R {
  let mut guard = CACHE.lock().unwrap();
  if guard.is_none() {
    *guard = Some(load());
  }
  f(guard.as_mut().unwrap())
}

/// Write the current cache to disk as `{ ...state, settings }`.
fn persist(cache: &Cache) {
  let _ = paths::ensure_data_dir();
  let mut value = match serde_json::to_value(&cache.state) {
    Ok(v) => v,
    Err(_) => return,
  };
  if let Value::Object(ref mut map) = value {
    if let Ok(s) = serde_json::to_value(&cache.settings) {
      map.insert("settings".to_string(), s);
    }
  }
  match serde_json::to_string_pretty(&value) {
    Ok(text) => {
      if let Err(e) = std::fs::write(paths::store_file(), text) {
        log::error!("failed to persist project store to {}: {e}", paths::store_file().display());
      }
    }
    Err(e) => log::error!("failed to serialize project store: {e}"),
  }
}

pub fn get_state() -> ProjectsState {
  with_cache(|c| c.state.clone())
}

pub fn get_settings() -> AppSettings {
  with_cache(|c| c.settings.clone())
}

/// Patch fields of the settings (deep-merging experiment flags) and persist.
pub fn set_settings(
  theme: Option<String>,
  ui_scale: Option<f64>,
  experiments: Option<ExperimentFlags>,
  full_diagnostics: Option<bool>,
  deploy_mode: Option<String>,
) -> AppSettings {
  with_cache(|c| {
    if let Some(t) = theme {
      c.settings.theme = t;
    }
    if let Some(s) = ui_scale {
      c.settings.ui_scale = Some(s.clamp(0.8, 2.0));
    }
    if let Some(v) = full_diagnostics {
      c.settings.full_diagnostics = Some(v);
    }
    if let Some(mode) = deploy_mode.filter(|m| m == "auto" || m == "manual") {
      c.settings.deploy_mode = Some(mode);
    }
    if let Some(patch) = experiments {
      merge_experiments(&mut c.settings.experiments, patch);
    }
    persist(c);
    c.settings.clone()
  })
}

fn merge_experiments(experiments: &mut Option<ExperimentFlags>, patch: ExperimentFlags) {
  let current = experiments.get_or_insert_with(default_flags);
  if let Some(v) = patch.team_workspaces { current.team_workspaces = Some(v); }
  if let Some(v) = patch.report_migration { current.report_migration = Some(v); }
  if let Some(v) = patch.work_iq { current.work_iq = Some(v); }
  if let Some(v) = patch.goals { current.goals = Some(v); }
}

/// The Goals experiment is on.
pub fn goals_enabled() -> bool {
  with_cache(|c| c.settings.experiments.as_ref().and_then(|f| f.goals).unwrap_or(false))
}

/// Each provider's models and the ones shown in the model pickers.
pub fn byok_settings() -> ByokSettings {
  with_cache(|c| c.settings.byok.clone().unwrap_or_default())
}

/// Replace one provider's settings (or, with `None`, forget the provider).
pub fn set_byok_provider(provider: &str, value: Option<ByokProviderSettings>) {
  with_cache(|c| {
    let byok = c.settings.byok.get_or_insert_with(Default::default);
    match value {
      Some(v) => {
        byok.providers.insert(provider.to_string(), v);
      }
      None => {
        byok.providers.remove(provider);
      }
    }
    persist(c);
  })
}

/// True when the Team workspaces experiment is on.
pub fn team_workspaces_enabled() -> bool {
  with_cache(|c| {
    c.settings
      .experiments
      .as_ref()
      .and_then(|e| e.team_workspaces)
      .unwrap_or(false)
  })
}

/// True when the Migrate Power BI reports experiment is on.
pub fn report_migration_enabled() -> bool {
  with_cache(|c| {
    c.settings
      .experiments
      .as_ref()
      .and_then(|e| e.report_migration)
      .unwrap_or(false)
  })
}

/// The MCP servers the user added, in the order they were added.
pub fn mcp_servers() -> Vec<McpServerEntry> {
  with_cache(|c| c.settings.mcp_servers.clone())
}

/// Add an MCP server, or replace the one with its id, and return them all.
pub fn upsert_mcp_server(server: McpServerEntry) -> Vec<McpServerEntry> {
  with_cache(|c| {
    match c.settings.mcp_servers.iter_mut().find(|s| s.id == server.id) {
      Some(saved) => *saved = server,
      None => c.settings.mcp_servers.push(server),
    }
    persist(c);
    c.settings.mcp_servers.clone()
  })
}

/// Forget an MCP server, and turn it off in every chat that has it on, and in
/// the chat defaults. Returns the servers left.
pub fn remove_mcp_server(id: &str) -> Vec<McpServerEntry> {
  let plugin = format!("mcp:{id}");
  with_cache(|c| {
    c.settings.mcp_servers.retain(|s| s.id != id);
    for project in &mut c.state.projects {
      project.plugins.retain(|p| *p != plugin);
    }
    if let Some(defaults) = c.settings.chat_defaults.as_mut() {
      defaults.plugins.retain(|p| *p != plugin);
    }
    persist(c);
    c.settings.mcp_servers.clone()
  })
}

/// Save what a new project's chat starts with (already checked: see
/// `commands::chat::chat_defaults`), and return the settings.
pub fn set_chat_defaults(defaults: ChatDefaults) -> AppSettings {
  with_cache(|c| {
    c.settings.chat_defaults = Some(defaults);
    persist(c);
    c.settings.clone()
  })
}

/// True when chat turns don't publish personal apps: the changes stay on this
/// computer until the user publishes them. The published apps panel's "Publish
/// after each chat turn" saves the user's choice ("auto" or "manual"), which
/// always wins. Without one, turns don't publish: the app runs on this computer,
/// and publishing is the user's choice.
fn is_manual_deploy(settings: &AppSettings) -> bool {
  settings.deploy_mode.as_deref() != Some("auto")
}

/// True when chat turns don't publish (see [`is_manual_deploy`]). Every decision
/// the backend makes about publishing after a turn goes through this.
pub fn manual_deploy_enabled() -> bool {
  with_cache(|c| is_manual_deploy(&c.settings))
}

pub fn team_workspaces() -> Vec<TeamWorkspace> {
  with_cache(|c| c.state.team_workspaces.clone())
}

pub fn find_team_workspace(id: &str) -> Option<TeamWorkspace> {
  with_cache(|c| c.state.team_workspaces.iter().find(|w| w.id == id).cloned())
}

/// Insert or replace a team workspace (matched by id).
pub fn upsert_team_workspace(workspace: TeamWorkspace) -> ProjectsState {
  with_cache(|c| {
    match c.state.team_workspaces.iter_mut().find(|w| w.id == workspace.id) {
      Some(existing) => *existing = workspace,
      None => c.state.team_workspaces.push(workspace),
    }
    persist(c);
    c.state.clone()
  })
}

/// Mutate a team workspace in place (id preserved) and persist.
pub fn mutate_team_workspace(id: &str, f: impl FnOnce(&mut TeamWorkspace)) -> Option<TeamWorkspace> {
  with_cache(|c| {
    let updated = c.state.team_workspaces.iter_mut().find(|w| w.id == id).map(|w| {
      let keep = w.id.clone();
      f(w);
      w.id = keep;
      w.clone()
    });
    persist(c);
    updated
  })
}

/// Forget a team workspace and every local project bound to it.
pub fn remove_team_workspace(id: &str) -> ProjectsState {
  with_cache(|c| {
    c.state.team_workspaces.retain(|w| w.id != id);
    let removed: Vec<String> = c
      .state
      .projects
      .iter()
      .filter(|p| p.team.as_ref().is_some_and(|t| t.workspace_id == id))
      .map(|p| p.id.clone())
      .collect();
    c.state.projects.retain(|p| !removed.contains(&p.id));
    if c.state.active_project_id.as_ref().is_some_and(|a| removed.contains(a)) {
      c.state.active_project_id = None;
    }
    persist(c);
    c.state.clone()
  })
}

pub fn set_workspace_root(path: String) -> ProjectsState {
  with_cache(|c| {
    c.state.workspace_root = path;
    persist(c);
    c.state.clone()
  })
}

/// How many folders New project remembers.
const RECENT_LOCATIONS: usize = 5;

/// `recent` with `path` first, without another spelling of it, keeping the
/// most recent [`RECENT_LOCATIONS`].
fn with_recent(mut recent: Vec<String>, path: &str) -> Vec<String> {
  recent.retain(|known| !crate::commands::util::same_path(known, path));
  recent.insert(0, path.to_string());
  recent.truncate(RECENT_LOCATIONS);
  recent
}

/// Remember a folder, other than the projects folder, that a new project went in.
pub fn remember_location(path: &str) -> ProjectsState {
  with_cache(|c| {
    c.state.recent_locations = with_recent(std::mem::take(&mut c.state.recent_locations), path);
    persist(c);
    c.state.clone()
  })
}

pub fn set_active(id: Option<String>) -> ProjectsState {
  with_cache(|c| {
    if let Some(ref want) = id {
      // Bump the selected project to the front so Home shows true
      // most-recently-used order (matches how upsert_project front-loads
      // newly created / opened projects), and note when it was opened.
      if let Some(pos) = c.state.projects.iter().position(|p| &p.id == want) {
        c.state.projects[pos].last_opened_at = Some(crate::commands::util::now_iso());
        if pos != 0 {
          let p = c.state.projects.remove(pos);
          c.state.projects.insert(0, p);
        }
      } else {
        return c.state.clone();
      }
    }
    c.state.active_project_id = id;
    persist(c);
    c.state.clone()
  })
}

/// Pin a project to the top of Home's recent projects, or unpin it.
pub fn set_pinned(id: &str, pinned: bool) -> ProjectsState {
  mutate_project(id, |p| p.pinned = pinned)
}

/// Insert or update a project (matched by id), keeping it at the front.
pub fn upsert_project(project: StudioProject) -> ProjectsState {
  with_cache(|c| {
    c.state.projects.retain(|p| p.id != project.id);
    c.state.projects.insert(0, project);
    persist(c);
    c.state.clone()
  })
}

pub fn remove_project(id: &str) -> ProjectsState {
  let state = with_cache(|c| {
    c.state.projects.retain(|p| p.id != id);
    if c.state.active_project_id.as_deref() == Some(id) {
      c.state.active_project_id = None;
    }
    persist(c);
    c.state.clone()
  });
  crate::services::thumbnails::forget(id);
  state
}

/// Mutate a tracked project in place (id preserved) and persist.
pub fn mutate_project(id: &str, f: impl FnOnce(&mut StudioProject)) -> ProjectsState {
  with_cache(|c| {
    if let Some(p) = c.state.projects.iter_mut().find(|p| p.id == id) {
      let keep = p.id.clone();
      f(p);
      p.id = keep;
    }
    persist(c);
    c.state.clone()
  })
}

pub fn find_project(id: &str) -> Option<StudioProject> {
  with_cache(|c| c.state.projects.iter().find(|p| p.id == id).cloned())
}

/// The currently-active project (resolved from `active_project_id`), if any. Used
/// to locate the project-local Rayfin CLI for Fabric auth / REST calls.
pub fn active_project() -> Option<StudioProject> {
  with_cache(|c| {
    let id = c.state.active_project_id.clone()?;
    c.state.projects.iter().find(|p| p.id == id).cloned()
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn new_project_locations_are_remembered_newest_first_once_each() {
    let recent = (1..=5).fold(vec![], |list, n| with_recent(list, &format!("/work/apps/{n}")));
    assert_eq!(recent[0], "/work/apps/5");
    // Used again, under another spelling, it moves to the front rather than repeating.
    let recent = with_recent(recent, "/Work/Apps/2/");
    assert_eq!(recent[..2], ["/Work/Apps/2/", "/work/apps/5"]);
    assert_eq!(recent.len(), 5);
    // A new one pushes the oldest out.
    let recent = with_recent(recent, "/other");
    assert_eq!((recent.len(), recent[0].as_str()), (5, "/other"));
    assert!(!recent.contains(&"/work/apps/1".to_string()));
  }

  #[test]
  fn experiment_patch_preserves_unmentioned_flags() {
    let mut flags: Option<ExperimentFlags> = Some(serde_json::from_value(serde_json::json!({
      "teamWorkspaces":true
    })).unwrap());
    merge_experiments(&mut flags, serde_json::from_value(serde_json::json!({})).unwrap());
    assert_eq!(flags.as_ref().unwrap().team_workspaces, Some(true));
    merge_experiments(&mut flags, serde_json::from_value(serde_json::json!({"teamWorkspaces":false})).unwrap());
    assert_eq!(serde_json::to_value(flags.unwrap()).unwrap(), serde_json::json!({"teamWorkspaces":false}));
  }

  #[test]
  fn team_workspaces_flag_merges_and_defaults_off() {
    assert_eq!(default_settings().experiments.unwrap().team_workspaces, Some(false));
    let mut flags = None;
    merge_experiments(&mut flags, serde_json::from_value(serde_json::json!({})).unwrap());
    assert_eq!(flags.as_ref().unwrap().team_workspaces, Some(false));
    merge_experiments(&mut flags, serde_json::from_value(serde_json::json!({"teamWorkspaces":true})).unwrap());
    assert_eq!(flags.unwrap().team_workspaces, Some(true));
  }

  #[test]
  fn report_migration_flag_merges_and_defaults_off() {
    assert_eq!(default_settings().experiments.unwrap().report_migration, Some(false));
    let mut flags: Option<ExperimentFlags> =
      Some(serde_json::from_value(serde_json::json!({"teamWorkspaces":true})).unwrap());
    merge_experiments(&mut flags, serde_json::from_value(serde_json::json!({"reportMigration":true})).unwrap());
    assert_eq!(flags.as_ref().unwrap().report_migration, Some(true));
    assert_eq!(flags.as_ref().unwrap().team_workspaces, Some(true));
    assert_eq!(
      serde_json::to_value(flags.unwrap()).unwrap(),
      serde_json::json!({"teamWorkspaces":true,"reportMigration":true})
    );
  }

  #[test]
  fn work_iq_flag_merges_and_defaults_off() {
    assert_eq!(default_settings().experiments.unwrap().work_iq, Some(false));
    let mut flags: Option<ExperimentFlags> =
      Some(serde_json::from_value(serde_json::json!({"reportMigration":true})).unwrap());
    merge_experiments(&mut flags, serde_json::from_value(serde_json::json!({"workIq":true})).unwrap());
    assert_eq!(
      serde_json::to_value(flags.unwrap()).unwrap(),
      serde_json::json!({"reportMigration":true,"workIq":true})
    );
  }

  /// The App gallery, MCP servers and Export as an app were experiments until
  /// they shipped to everyone; settings saved with their old flags still load,
  /// and the flags are gone once they're saved.
  #[test]
  fn graduated_experiment_flags_still_load_and_are_dropped() {
    let flags: ExperimentFlags = serde_json::from_value(serde_json::json!({
      "appGallery":true,"mcpServers":true,"appExport":true,"workIq":true
    })).unwrap();
    assert_eq!(serde_json::to_value(flags).unwrap(), serde_json::json!({"workIq":true}));
  }

  #[test]
  fn goals_flag_merges_and_defaults_off() {
    assert_eq!(default_settings().experiments.unwrap().goals, Some(false));
    let mut flags: Option<ExperimentFlags> =
      Some(serde_json::from_value(serde_json::json!({"workIq":true})).unwrap());
    merge_experiments(&mut flags, serde_json::from_value(serde_json::json!({"goals":true})).unwrap());
    assert_eq!(serde_json::to_value(flags.unwrap()).unwrap(), serde_json::json!({"workIq":true,"goals":true}));
  }

  #[test]
  fn saved_mcp_servers_load_and_settings_without_them_still_do() {
    let settings = settings_from(Some(serde_json::json!({
      "theme":"dark",
      "mcpServers":[{"id":"chart","name":"Chart","transport":"stdio","command":"npx","args":["-y","@antv/mcp-server-chart"],"env":["TOKEN"],"addedAt":"2026-10-31T00:00:00Z"}]
    })));
    assert_eq!(settings.mcp_servers.len(), 1);
    assert_eq!(settings.mcp_servers[0].env, ["TOKEN"]);
    assert!(!settings.mcp_servers[0].read_only);
    assert!(settings_from(Some(serde_json::json!({"theme":"dark"}))).mcp_servers.is_empty());
    // Without any, settings are saved as before.
    assert!(serde_json::to_value(default_settings()).unwrap().get("mcpServers").is_none());
  }

  #[test]
  fn an_explicit_choice_decides_whether_turns_publish_and_unset_keeps_changes_here() {
    let manual = |saved: serde_json::Value| is_manual_deploy(&settings_from(Some(saved)));
    assert!(is_manual_deploy(&default_settings()));
    assert!(manual(serde_json::json!({})));
    // The retired Local development experiment's flag no longer decides, either way.
    assert!(manual(serde_json::json!({"experiments":{"localDevelopment":false}})));
    assert!(manual(serde_json::json!({"experiments":{"localDevelopment":true}})));
    assert!(manual(serde_json::json!({"deployMode":"manual"})));
    assert!(!manual(serde_json::json!({"deployMode":"auto"})));
    assert!(!manual(serde_json::json!({"experiments":{"localDevelopment":false},"deployMode":"auto"})));
    // A value the switch never saves counts as no choice.
    assert!(manual(serde_json::json!({"deployMode":"sometimes"})));
  }

  #[test]
  fn unreadable_settings_fall_back_to_the_defaults() {
    let settings = settings_from(Some(serde_json::json!({"theme":5})));
    assert_eq!(settings.theme, "system");
    assert!(settings_from(None).deploy_mode.is_none());
  }

  #[test]
  fn stores_without_team_workspaces_still_load() {
    let raw: RawStore = serde_json::from_value(serde_json::json!({
      "workspaceRoot": "C:/x", "activeProjectId": null,
      "projects": [{"id":"p","name":"App","path":"C:/x/app","addedAt":"2026-01-01T00:00:00.000Z"}]
    })).unwrap();
    assert!(raw.team_workspaces.is_empty());
    assert!(raw.projects[0].team.is_none());
  }

  #[test]
  fn a_launch_opens_on_home_not_the_project_open_at_closing() {
    let raw: RawStore = serde_json::from_value(serde_json::json!({
      "workspaceRoot": "C:/x", "activeProjectId": "p",
      "projects": [{"id":"p","name":"App","path":"C:/x/app","addedAt":"2026-01-01T00:00:00.000Z","pinned":true}]
    })).unwrap();
    let state = state_from(raw);
    assert_eq!(state.active_project_id, None);
    assert_eq!(state.workspace_root, "C:/x");
    assert_eq!(state.projects.len(), 1);
    assert!(state.projects[0].pinned, "the projects themselves come back as they were");
  }

  #[test]
  fn retired_experiment_flags_are_ignored_on_load() {
    for enabled in [false, true] {
      let settings: AppSettings = serde_json::from_value(serde_json::json!({
        "theme":"dark",
        "uiScale":1.25,
        "fullDiagnostics":true,
        "experiments":{
          "compatibilityRendering":enabled,
          "chatModeSelector":enabled,
          "localDevPreview":enabled,
          "designStudio":enabled,
          "manualDeploy":enabled,
          "byok":enabled,
          "localDevelopment":enabled,
          "fabricIq":enabled,
          "teamWorkspaces":true
        }
      })).unwrap();
      assert_eq!(serde_json::to_value(settings).unwrap(), serde_json::json!({
        "theme":"dark",
        "uiScale":1.25,
        "fullDiagnostics":true,
        "experiments":{"teamWorkspaces":true}
      }));
    }
  }
}
