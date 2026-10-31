//! Settings commands: get + patch (theme, experiment flags).

use serde::Deserialize;

use crate::services::store;
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
pub fn settings_set(patch: SettingsPatch) -> AppSettings {
  // Work IQ's experiment decides whether chats can have its plugin: changing it
  // tries Work IQ again from scratch, and turning it off drops its sign-in.
  let work_iq_changed = patch.experiments.as_ref().is_some_and(|e| e.work_iq.is_some());
  let settings = store::set_settings(
    patch.theme,
    patch.ui_scale,
    patch.experiments,
    patch.full_diagnostics,
    patch.deploy_mode,
  );
  if work_iq_changed {
    use crate::services::iq::{self, Iq, IqConfig};
    iq::toggled(Iq::Work, IqConfig::in_use(&store::get_state().projects, &settings));
  }
  settings
}
