//! Settings commands: get + patch (theme, language, experiment flags, chat
//! defaults, custom instructions).

use serde::Deserialize;

use crate::services::{agent_skills, store};
use crate::types::{AppSettings, ChatDefaults, ExperimentFlags};

/// Off the main thread, like every read the app makes while it starts.
#[tauri::command(async)]
pub fn settings_get() -> AppSettings {
  store::get_settings()
}

/// The language the computer's settings ask for, of the ones Fabricator comes
/// in (English when it's none of them): what Settings' "System" language is.
#[tauri::command]
pub fn settings_system_language() -> String {
  crate::i18n::system_language().to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
  #[serde(default)]
  theme: Option<String>,
  #[serde(default)]
  ui_scale: Option<f64>,
  /// A language Fabricator comes in, or "system" for the computer's.
  #[serde(default)]
  language: Option<String>,
  #[serde(default)]
  experiments: Option<ExperimentFlags>,
  #[serde(default)]
  full_diagnostics: Option<bool>,
  #[serde(default)]
  deploy_mode: Option<String>,
  /// Replaces the chat defaults as a whole.
  #[serde(default)]
  chat_defaults: Option<ChatDefaults>,
  /// Replaces the custom instructions; an empty text clears them.
  #[serde(default)]
  custom_instructions: Option<String>,
}

#[tauri::command]
pub fn settings_set(patch: SettingsPatch) -> AppSettings {
  // Work IQ's experiment decides whether chats can have its plugin: changing it
  // tries Work IQ again from scratch, and turning it off drops its sign-in.
  let work_iq_changed = patch.experiments.as_ref().is_some_and(|e| e.work_iq.is_some());
  let language_changed = patch.language.is_some();
  let mut settings = store::set_settings(
    patch.theme,
    patch.ui_scale,
    patch.language,
    patch.experiments,
    patch.full_diagnostics,
    patch.deploy_mode,
  );
  if language_changed {
    crate::i18n::set_preference(settings.language.as_deref());
  }
  if let Some(defaults) = patch.chat_defaults {
    settings = store::set_chat_defaults(crate::commands::chat::chat_defaults(defaults, &settings.mcp_servers));
  }
  // Each Build chat picks them up from its next message (see `CopilotManager::turn_session`).
  if let Some(text) = patch.custom_instructions {
    settings = store::set_custom_instructions(agent_skills::custom_instructions(&text));
    // Their file follows now, so instructions cleared here leave none behind.
    let _ = agent_skills::custom_instructions_dir(settings.custom_instructions.as_deref());
  }
  if work_iq_changed {
    use crate::services::iq::{self, Iq, IqConfig};
    iq::toggled(Iq::Work, IqConfig::in_use(&store::get_state().projects, &settings));
  }
  settings
}
