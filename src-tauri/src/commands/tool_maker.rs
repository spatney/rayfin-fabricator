//! Tools people make with Copilot: the commands behind the MCP servers
//! dialog's tool maker (see `services::tool_maker`). Like the rest of MCP
//! servers, a key's value only ever travels renderer → backend; no command
//! returns one, and a shared tool's file never holds one.

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::services::copilot::ModelChoice;
use crate::services::exec::CancelToken;
use crate::services::store;
use crate::services::tool_maker::{self, Job};
use crate::state::AppState;
use crate::types::{
  MadeToolSpec, McpServerEntry, ToolCode, ToolImportInput, ToolImportPreview, ToolMadeResult, ToolMakeInput,
  ToolMakerEvent, ToolTryResult,
};

/// Making, changing and adding tools is the Make tools with Copilot experiment.
fn experiment_on() -> Result<(), String> {
  if store::custom_tools_enabled() {
    Ok(())
  } else {
    Err(t!("commands.toolMaker.experimentOff"))
  }
}

/// A run's job, reporting through `on_event`.
fn job<'a>(state: &'a AppState, choice: ModelChoice, cancel: &'a CancelToken, on_event: Channel<ToolMakerEvent>) -> Job<'a> {
  Job {
    copilot: &state.copilot,
    byok: &state.byok,
    choice,
    cancel,
    progress: Arc::new(move |event| {
      let _ = on_event.send(event);
    }),
  }
}

/// Have Copilot make a tool, and add it to the MCP servers once it starts.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn tool_maker_make(
  state: State<'_, AppState>,
  run_id: String,
  input: ToolMakeInput,
  model: Option<String>,
  effort: Option<String>,
  auto_tier: Option<String>,
  context_tier: Option<String>,
  on_event: Channel<ToolMakerEvent>,
) -> Result<ToolMadeResult, String> {
  experiment_on()?;
  let token = state.begin_tool_run(&run_id);
  let choice = ModelChoice::new(model, effort, auto_tier, context_tier);
  let result = tool_maker::make(&job(&state, choice, &token, on_event), &input).await;
  state.end_tool_run(&run_id, &token);
  result
}

/// Have Copilot change a tool it made.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn tool_maker_change(
  state: State<'_, AppState>,
  run_id: String,
  id: String,
  request: String,
  model: Option<String>,
  effort: Option<String>,
  auto_tier: Option<String>,
  context_tier: Option<String>,
  on_event: Channel<ToolMakerEvent>,
) -> Result<ToolMadeResult, String> {
  experiment_on()?;
  let token = state.begin_tool_run(&run_id);
  let choice = ModelChoice::new(model, effort, auto_tier, context_tier);
  let result = tool_maker::change(&job(&state, choice, &token, on_event), &id, &request).await;
  state.end_tool_run(&run_id, &token);
  result
}

/// Stop making, changing or trying a tool.
#[tauri::command]
pub fn tool_maker_cancel(state: State<'_, AppState>, run_id: String) -> bool {
  state.cancel_tool_run(&run_id)
}

/// A tool's code, to read.
#[tauri::command(async)]
pub fn tool_maker_code(id: String) -> Result<ToolCode, String> {
  tool_maker::code(&id)
}

/// Undo the last change Copilot made to a tool, and return every MCP server.
#[tauri::command(async)]
pub fn tool_maker_undo(id: String) -> Result<Vec<McpServerEntry>, String> {
  experiment_on()?;
  tool_maker::undo(&id)
}

/// Show a tool's code file, or the folder its tries run in, in the file manager.
#[tauri::command(async)]
pub fn tool_maker_reveal(app: AppHandle, id: String, what: String) -> Result<(), String> {
  if what == "try" {
    let folder = tool_maker::try_folder(&id)?;
    app.opener().open_path(folder.to_string_lossy().to_string(), None::<&str>).map_err(|e| e.to_string())
  } else {
    app.opener().reveal_item_in_dir(tool_maker::code_file(&id)?).map_err(|e| e.to_string())
  }
}

/// A tool's tools, with what each takes, to try one.
#[tauri::command]
pub async fn tool_maker_specs(id: String) -> Result<Vec<MadeToolSpec>, String> {
  tool_maker::specs(&id).await
}

/// Call one of a tool's tools with its keys, in its try folder.
#[tauri::command]
pub async fn tool_maker_try(
  state: State<'_, AppState>,
  run_id: String,
  id: String,
  tool: String,
  args: Value,
) -> Result<ToolTryResult, String> {
  let token = state.begin_tool_run(&run_id);
  let result = tool_maker::try_tool(&id, &tool, args, &token).await;
  state.end_tool_run(&run_id, &token);
  result
}

/// Save a tool as a file to share, without its keys. `None` when the user
/// closes the dialog.
#[tauri::command]
pub async fn tool_maker_export(app: AppHandle, id: String) -> Result<Option<String>, String> {
  let (name, text) = tool_maker::export(&id)?;
  let (tx, rx) = tokio::sync::oneshot::channel();
  app
    .dialog()
    .file()
    .add_filter(t!("commands.toolMaker.filter"), &["json"])
    .set_file_name(name)
    .save_file(move |picked| {
      let _ = tx.send(picked);
    });
  let Some(path) = rx.await.ok().flatten().and_then(|picked| picked.into_path().ok()) else {
    return Ok(None);
  };
  std::fs::write(&path, text).map_err(|e| t!("commands.toolMaker.cantExport", error = e))?;
  Ok(Some(path.to_string_lossy().into_owned()))
}

/// Pick a shared tool's file, and read it to review. `None` when the user
/// closes the dialog.
#[tauri::command]
pub async fn tool_maker_pick_import(app: AppHandle) -> Result<Option<ToolImportPreview>, String> {
  experiment_on()?;
  let (tx, rx) = tokio::sync::oneshot::channel();
  app
    .dialog()
    .file()
    .add_filter(t!("commands.toolMaker.filter"), &["json"])
    .pick_file(move |picked| {
      let _ = tx.send(picked);
    });
  let Some(path) = rx.await.ok().flatten().and_then(|picked| picked.into_path().ok()) else {
    return Ok(None);
  };
  tokio::task::spawn_blocking(move || tool_maker::preview(Path::new(&path)))
    .await
    .map_err(|e| e.to_string())?
    .map(Some)
}

/// Add the shared tool the user reviewed, once it starts.
#[tauri::command]
pub async fn tool_maker_import(input: ToolImportInput) -> Result<ToolMadeResult, String> {
  experiment_on()?;
  tool_maker::import(&input).await
}
