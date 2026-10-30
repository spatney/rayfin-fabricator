//! Settings commands: get + patch (theme, experiment flags).

use serde::Deserialize;
use tauri::AppHandle;

use crate::services::{local_backend, store};
use crate::types::{AppSettings, ExperimentFlags};

/// Off the main thread, like every read the app makes while it starts.
#[tauri::command(async)]
pub fn settings_get() -> AppSettings {
  store::get_settings()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
  #[serde(default)]
  theme: Option<String>,
  #[serde(default)]
  ui_scale: Option<f64>,
  #[serde(default)]
  experiments: Option<ExperimentFlags>,
  #[serde(default)]
  full_diagnostics: Option<bool>,
  #[serde(default)]
  deploy_mode: Option<String>,
}

#[tauri::command]
pub fn settings_set(app: AppHandle, patch: SettingsPatch) -> AppSettings {
  let was_local = store::local_development_enabled();
  let settings = store::set_settings(
    patch.theme,
    patch.ui_scale,
    patch.experiments,
    patch.full_diagnostics,
    patch.deploy_mode,
  );
  if turned_off_local_development(was_local, &settings) {
    // No app runs on this computer without the experiment: stop every local
    // backend, unless it was turned back on in the meantime.
    tauri::async_runtime::spawn(async move {
      if !store::local_development_enabled() {
        local_backend::stop_all(&app).await;
      }
    });
  }
  settings
}

/// Whether a settings change turned the Local development experiment off.
fn turned_off_local_development(was_on: bool, settings: &AppSettings) -> bool {
  was_on && !store::local_development_in(settings)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn turning_local_development_off_stops_the_local_backends() {
    let settings = |experiments: serde_json::Value| -> AppSettings {
      serde_json::from_value(serde_json::json!({ "theme": "system", "experiments": experiments })).unwrap()
    };
    let on = settings(serde_json::json!({ "localDevelopment": true }));
    let off = settings(serde_json::json!({ "localDevelopment": false }));
    assert!(turned_off_local_development(true, &off));
    assert!(turned_off_local_development(true, &settings(serde_json::json!({}))));
    // Turning it on, or a change that leaves it as it was, stops nothing.
    assert!(!turned_off_local_development(false, &on));
    assert!(!turned_off_local_development(true, &on));
    assert!(!turned_off_local_development(false, &off));
  }
}
