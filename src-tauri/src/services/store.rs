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
  AppSettings, ByokProviderSettings, ByokSettings, ExperimentFlags, ProjectsState, StudioProject, TeamWorkspace,
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
  }
}

fn default_flags() -> ExperimentFlags {
  ExperimentFlags {
    team_workspaces: Some(false),
    report_migration: Some(false),
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
  }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawStore {
  workspace_root: Option<String>,
  #[serde(default)]
  active_project_id: Option<String>,
  #[serde(default)]
  projects: Vec<StudioProject>,
  #[serde(default)]
  team_workspaces: Vec<TeamWorkspace>,
  /// Read as JSON first, so settings from older versions can be carried over
  /// (see [`migrate_settings`]) before they're typed.
  #[serde(default)]
  settings: Option<Value>,
}

/// Carry settings saved by an older version over to this one. Deploying after
/// each chat turn used to be the only mode unless the Deploy manually experiment
/// was on, and that experiment started in Manual. It's now the deployment
/// panel's switch, Auto unless the user turned it off, so its retired flag is
/// read once: with it on, the user keeps the Manual they chose; with it off, a
/// leftover "manual" from it goes back to Auto. Without the flag (settings from
/// this version), nothing changes. Retired flags are then dropped as unknown.
fn migrate_settings(mut settings: Value) -> Value {
  let Some(experiment_on) = settings.pointer("/experiments/manualDeploy").and_then(Value::as_bool) else {
    return settings;
  };
  if let Some(map) = settings.as_object_mut() {
    match (experiment_on, map.get("deployMode").and_then(Value::as_str)) {
      (true, None) => {
        map.insert("deployMode".into(), "manual".into());
      }
      (false, Some("manual")) => {
        map.remove("deployMode");
      }
      _ => {}
    }
  }
  settings
}

/// The saved settings, carried over from an older version when need be. Settings
/// that can't be read fall back to the defaults without losing the projects.
fn settings_from(saved: Option<Value>) -> AppSettings {
  saved
    .map(migrate_settings)
    .and_then(|settings| serde_json::from_value(settings).ok())
    .unwrap_or_else(default_settings)
}

fn load() -> Cache {
  match std::fs::read_to_string(paths::store_file()) {
    Ok(raw) => match serde_json::from_str::<RawStore>(&raw) {
      Ok(parsed) => {
        let mut state = default_state();
        if let Some(root) = parsed.workspace_root {
          state.workspace_root = root;
        }
        state.active_project_id = parsed.active_project_id;
        state.projects = parsed.projects;
        state.team_workspaces = parsed.team_workspaces;
        let settings = settings_from(parsed.settings);
        Cache { state, settings }
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

/// True when chat turns don't deploy: the user turned off the deployment
/// panel's "Deploy after each chat turn". Auto is the default.
fn is_manual_deploy(settings: &AppSettings) -> bool {
  settings.deploy_mode.as_deref() == Some("manual")
}

/// True when chat turns don't deploy (see [`is_manual_deploy`]).
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

pub fn set_active(id: Option<String>) -> ProjectsState {
  with_cache(|c| {
    if let Some(ref want) = id {
      // Bump the selected project to the front so Home shows true
      // most-recently-used order (matches how upsert_project front-loads
      // newly created / opened projects).
      if let Some(pos) = c.state.projects.iter().position(|p| &p.id == want) {
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
  with_cache(|c| {
    c.state.projects.retain(|p| p.id != id);
    if c.state.active_project_id.as_deref() == Some(id) {
      c.state.active_project_id = None;
    }
    persist(c);
    c.state.clone()
  })
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
  fn chat_turns_deploy_unless_the_user_chose_manual() {
    let settings = |value: serde_json::Value| -> AppSettings { serde_json::from_value(value).unwrap() };
    assert!(!is_manual_deploy(&default_settings()));
    assert!(!is_manual_deploy(&settings(serde_json::json!({}))));
    assert!(!is_manual_deploy(&settings(serde_json::json!({"deployMode":"auto"}))));
    assert!(is_manual_deploy(&settings(serde_json::json!({"deployMode":"manual"}))));
  }

  #[test]
  fn the_retired_deploy_manually_flag_carries_the_users_choice_over() {
    let mode = |saved: serde_json::Value| settings_from(Some(saved)).deploy_mode;
    // The experiment was on: Manual stays, including when it was Manual only by
    // starting that way, unless the user had switched to Auto.
    assert_eq!(mode(serde_json::json!({"experiments":{"manualDeploy":true}})).as_deref(), Some("manual"));
    assert_eq!(mode(serde_json::json!({"experiments":{"manualDeploy":true},"deployMode":"manual"})).as_deref(), Some("manual"));
    assert_eq!(mode(serde_json::json!({"experiments":{"manualDeploy":true},"deployMode":"auto"})).as_deref(), Some("auto"));
    // It was turned off: the "manual" it started with is left over, not chosen.
    assert_eq!(mode(serde_json::json!({"experiments":{"manualDeploy":false},"deployMode":"manual"})), None);
    assert_eq!(mode(serde_json::json!({"experiments":{"manualDeploy":false}})), None);
    // Settings from this version: Manual is the user's choice.
    assert_eq!(mode(serde_json::json!({"deployMode":"manual"})).as_deref(), Some("manual"));
    assert_eq!(mode(serde_json::json!({"experiments":{"teamWorkspaces":true}})), None);

    // The flag is gone once the settings are saved again, so it's read only once.
    let carried = settings_from(Some(serde_json::json!({
      "theme":"dark","experiments":{"manualDeploy":true,"teamWorkspaces":true}
    })));
    assert_eq!(
      serde_json::to_value(carried).unwrap(),
      serde_json::json!({"theme":"dark","experiments":{"teamWorkspaces":true},"deployMode":"manual"})
    );
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
