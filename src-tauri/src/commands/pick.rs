//! Touch Up: the source hints sent with picked elements. Picking itself
//! runs in the preview (see `services::preview` and `services/pick_agent.js`),
//! and Copilot makes the change in an ordinary chat turn.

use std::path::PathBuf;

use crate::services::source_hints::{self, LocateResult, LocateTarget};
use crate::services::store;

/// Find the likely source lines behind picked elements (heuristic hints) and the
/// project's Tailwind entry stylesheet.
#[tauri::command]
pub async fn pick_locate(project_id: String, targets: Vec<LocateTarget>) -> Result<LocateResult, String> {
  let root = store::find_project(&project_id).map(|p| PathBuf::from(p.path)).ok_or_else(|| t!("commands.shared.projectNotFound"))?;
  let targets: Vec<LocateTarget> = targets.into_iter().take(40).collect();
  tokio::task::spawn_blocking(move || source_hints::locate(&root, &targets))
    .await
    .map_err(|e| t!("commands.pick.lookupFailed", error = e))
}
