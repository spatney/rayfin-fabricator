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
  #[serde(default)]
  full_diagnostics: Option<bool>,
  #[serde(default)]
  auto_deploy: Option<bool>,
}

#[tauri::command]
pub fn settings_set(patch: SettingsPatch) -> AppSettings {
  store::set_settings(patch.theme, patch.ui_scale, patch.experiments, patch.full_diagnostics, patch.auto_deploy)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn auto_deploy_patch_distinguishes_false_from_omitted() {
    let paused: SettingsPatch = serde_json::from_str(r#"{"autoDeploy":false}"#).unwrap();
    assert_eq!(paused.auto_deploy, Some(false));
    let unchanged: SettingsPatch = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
    assert_eq!(unchanged.auto_deploy, None);
    let resumed: SettingsPatch = serde_json::from_str(r#"{"autoDeploy":true}"#).unwrap();
    assert_eq!(resumed.auto_deploy, Some(true));
  }
}
