//! JSON-file persistence for app state — the Rust counterpart to
//! `src/main/services/store.ts`. State lives in `studio.json` under the per-user
//! data directory and is cached in memory after first read. Credentials are never
//! persisted here (each CLI owns its own credential store).

use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::Value;

use super::paths;
use crate::types::{AppSettings, ExperimentFlags, ProjectsState, StudioProject, TeamWorkspace};

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
  }
}

fn default_settings() -> AppSettings {
  AppSettings {
    theme: "system".to_string(),
    ui_scale: Some(1.0),
    auto_deploy: Some(true),
    experiments: Some(default_flags()),
    full_diagnostics: Some(false),
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
  #[serde(default)]
  settings: Option<AppSettings>,
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
        let settings = parsed.settings.unwrap_or_else(default_settings);
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
  auto_deploy: Option<bool>,
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
    if let Some(v) = auto_deploy {
      c.settings.auto_deploy = Some(v);
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
  fn auto_deploy_defaults_on_and_round_trips_paused() {
    assert_eq!(default_settings().auto_deploy, Some(true));
    let legacy: AppSettings = serde_json::from_value(serde_json::json!({"theme":"system"})).unwrap();
    assert!(legacy.auto_deploy.unwrap_or(true));
    let raw: RawStore = serde_json::from_value(serde_json::json!({
      "settings": {"theme":"dark", "autoDeploy":false}
    })).unwrap();
    let stored = serde_json::to_value(raw.settings.unwrap()).unwrap();
    assert_eq!(stored["autoDeploy"], false);
    let reloaded: AppSettings = serde_json::from_value(stored).unwrap();
    assert_eq!(reloaded.auto_deploy, Some(false));
    assert_eq!(reloaded.theme, "dark");
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
