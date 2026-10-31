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
  // Turning Fabric IQ or Work IQ off and on is how the user retries; turning
  // one off also drops its sign-in.
  let iq_changed = patch.experiments.as_ref().is_some_and(|e| e.fabric_iq.is_some() || e.work_iq.is_some());
  let settings = store::set_settings(
    patch.theme,
    patch.ui_scale,
    patch.experiments,
    patch.full_diagnostics,
    patch.deploy_mode,
  );
  if iq_changed {
    crate::services::iq::settings_changed(crate::services::iq::IqConfig::from_settings(&settings));
  }
  settings
}
