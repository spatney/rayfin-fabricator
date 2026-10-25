//! Your own API keys: the commands behind Accounts → Model providers.
//! A key only ever travels renderer → backend, to be checked and saved in the OS
//! credential store; no command returns one.

use tauri::State;

use crate::services::byok::{self, catalog::CopilotTwin};
use crate::state::AppState;
use crate::types::{ByokProviderStatus, ByokStatus};

/// Copilot's catalog, to match each provider model with Copilot's own (its
/// agent configuration and limits). Fine to go without when it can't be read.
async fn twins(state: &AppState) -> Vec<CopilotTwin> {
  match state.copilot.list_sdk_models().await {
    Ok(models) => models.iter().map(byok::twin_from).collect(),
    Err(e) => {
      log::warn!("couldn't read Copilot's models to match provider models: {e}");
      Vec::new()
    }
  }
}

#[tauri::command]
pub async fn byok_status(state: State<'_, AppState>) -> Result<ByokStatus, String> {
  Ok(state.byok.status())
}

/// Check a key against the provider, then save it and the models it can use.
#[tauri::command]
pub async fn byok_set_key(state: State<'_, AppState>, provider: String, key: String) -> Result<ByokProviderStatus, String> {
  let twins = twins(&state).await;
  state.byok.set_key(&provider, &key, &twins).await
}

/// Check the saved key again and update its models.
#[tauri::command]
pub async fn byok_refresh(state: State<'_, AppState>, provider: String) -> Result<ByokProviderStatus, String> {
  let twins = twins(&state).await;
  state.byok.refresh(&provider, &twins).await
}

#[tauri::command]
pub async fn byok_remove_key(state: State<'_, AppState>, provider: String) -> Result<ByokProviderStatus, String> {
  state.byok.remove_key(&provider)
}

/// Choose which of a provider's models the model pickers show.
#[tauri::command]
pub async fn byok_set_models(
  state: State<'_, AppState>,
  provider: String,
  models: Vec<String>,
) -> Result<ByokProviderStatus, String> {
  state.byok.set_models(&provider, &models)
}
