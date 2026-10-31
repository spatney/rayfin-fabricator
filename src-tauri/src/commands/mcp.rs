//! MCP servers (an experiment): the commands behind the MCP servers dialog.
//! The values of a server's environment variables and headers only ever travel
//! renderer → backend, to be kept in the OS credential store; no command
//! returns one.

use std::path::Path;
use std::time::Duration;

use tauri::State;

use crate::services::copilot::{ModelChoice, SessionOptions};
use crate::services::mcp::{self, McpServers};
use crate::services::{paths, store};
use crate::state::AppState;
use crate::types::{McpCheckResult, McpServerEntry, McpServerInput, McpTransport};

/// How long a check waits for a server: a command's first start can download it.
const CHECK_WAIT: Duration = Duration::from_secs(60);
const CHECK_POLL: Duration = Duration::from_millis(500);

fn require_experiment() -> Result<(), String> {
  if mcp::experiment_on(&store::get_settings()) {
    Ok(())
  } else {
    Err("Turn on MCP servers in Settings → Experiments first.".into())
  }
}

/// The MCP servers the user added.
#[tauri::command(async)]
pub fn mcp_list() -> Vec<McpServerEntry> {
  store::mcp_servers()
}

/// Add a server, or change one, and return them all.
#[tauri::command(async)]
pub fn mcp_save(server: McpServerInput) -> Result<Vec<McpServerEntry>, String> {
  require_experiment()?;
  mcp::save(&server)
}

/// Remove a server, turning it off in every chat, and return the rest.
#[tauri::command(async)]
pub fn mcp_remove(id: String) -> Result<Vec<McpServerEntry>, String> {
  mcp::remove(&id)
}

/// Start or connect to a saved server on its own, and list its tools.
#[tauri::command]
pub async fn mcp_check(state: State<'_, AppState>, id: String) -> Result<McpCheckResult, String> {
  require_experiment()?;
  let entry = store::mcp_servers()
    .into_iter()
    .find(|s| s.id == id)
    .ok_or("That server isn't in Fabricator anymore.")?;
  let values = if entry.env.is_empty() && entry.headers.is_empty() { Default::default() } else { mcp::secrets::load(&id)? };
  let command = entry.transport == McpTransport::Stdio;
  let cwd = check_folder();
  let opts = SessionOptions { mcp: McpServers::only(entry, values, Some(cwd.clone())), ..Default::default() };
  let session = state.copilot.transient_session_with(&cwd, ModelChoice::default(), opts).await?;
  let result = mcp::check(&session, &id, command, CHECK_WAIT, CHECK_POLL).await;
  // Never reused: ending it stops the server.
  let _ = session.disconnect().await;
  // Chats try it again from their next message, rather than go by what they found before.
  mcp::MEMORY.reset_server(&id);
  Ok(result)
}

/// Where a check starts a command server: the folder new projects go in, when it's there.
fn check_folder() -> String {
  let root = store::get_state().workspace_root;
  if Path::new(&root).is_dir() {
    root
  } else {
    paths::home_dir().to_string_lossy().to_string()
  }
}
