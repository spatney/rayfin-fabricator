//! Settings commands: get + patch (theme, experiment flags).

use serde::Deserialize;

use crate::services::store;
use crate::types::{AppSettings, ExperimentFlags};

#[tauri::command]
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
}

#[tauri::command]
pub fn settings_set(patch: SettingsPatch) -> AppSettings {
  store::set_settings(patch.theme, patch.ui_scale, patch.experiments)
}
