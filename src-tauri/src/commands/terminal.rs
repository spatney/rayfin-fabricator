//! The project terminal (services/terminal): shells in a project's folder for
//! the terminal panel. They run whatever is typed, so only Fabricator's own page
//! has them, never a page the preview or an app's window shows.

use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::{AppHandle, State, Webview};

use crate::services::terminal::{env, shells, Launch, Terminals};
use crate::services::{npm_env, rayfin_telemetry, store};
use crate::types::{TerminalEvent, TerminalInfo, TerminalShell};

/// The label of Fabricator's own page.
const MAIN: &str = "main";

fn ours(webview: &Webview) -> Result<(), String> {
  if webview.label() == MAIN {
    Ok(())
  } else {
    Err(t!("commands.terminal.notHere"))
  }
}

/// A terminal id the renderer chose: a UUID, or something as plain.
fn valid_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The shells on this computer, the default first.
#[tauri::command(async)]
pub fn terminal_shells(webview: Webview) -> Result<Vec<TerminalShell>, String> {
  ours(&webview)?;
  Ok(shells::available().iter().enumerate().map(|(i, shell)| shell.describe(i == 0)).collect())
}

/// Start a terminal in a project's folder, running `shell` (an id from
/// [`terminal_shells`]) or the default. What it prints, then how it ended,
/// stream to `on_event`.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn terminal_spawn(
  app: AppHandle,
  webview: Webview,
  terminals: State<'_, Terminals>,
  id: String,
  project_id: String,
  shell: Option<String>,
  cols: u16,
  rows: u16,
  on_event: Channel<TerminalEvent>,
) -> Result<TerminalInfo, String> {
  ours(&webview)?;
  if !valid_id(&id) {
    return Err(t!("commands.terminal.badId"));
  }
  let project = store::find_project(&project_id).ok_or_else(|| t!("commands.shared.projectGone"))?;
  let cwd = PathBuf::from(&project.path);
  if !cwd.is_dir() {
    return Err(t!("commands.shared.projectFolderGone"));
  }
  // Tools installed since Fabricator started, as checking for tools finds them.
  #[cfg(windows)]
  crate::services::env_path::repair();
  let shell = shells::resolve(shell.as_deref()).ok_or_else(|| t!("commands.terminal.noShell"))?;
  let mut restore = npm_env::for_user_shell();
  restore.push(rayfin_telemetry::for_user_shell());
  let version = app.package_info().version.to_string();
  let env = env::build(std::env::vars_os(), &cwd, &version, &restore);
  terminals.spawn(Launch { id, project_id, cwd, shell, env, cols, rows }, on_event)
}

/// Type into a terminal. Not async, so keystrokes are handled in the order they come.
#[tauri::command]
pub fn terminal_write(webview: Webview, terminals: State<'_, Terminals>, id: String, data: String) -> Result<(), String> {
  ours(&webview)?;
  terminals.write(&id, &data)
}

#[tauri::command]
pub fn terminal_resize(
  webview: Webview,
  terminals: State<'_, Terminals>,
  id: String,
  cols: u16,
  rows: u16,
) -> Result<(), String> {
  ours(&webview)?;
  terminals.resize(&id, cols, rows)
}

/// Hold a terminal's output while the panel catches up (`paused`), or let it flow.
#[tauri::command]
pub fn terminal_pause(webview: Webview, terminals: State<'_, Terminals>, id: String, paused: bool) -> Result<(), String> {
  ours(&webview)?;
  terminals.set_paused(&id, paused)
}

/// End a terminal's shell and what it started.
#[tauri::command(async)]
pub fn terminal_kill(webview: Webview, terminals: State<'_, Terminals>, id: String) -> Result<(), String> {
  ours(&webview)?;
  terminals.kill(&id);
  Ok(())
}

/// End every terminal of a project, or every terminal: the renderer's page was
/// loaded again, so nothing shows the ones it had.
#[tauri::command(async)]
pub fn terminal_kill_all(
  webview: Webview,
  terminals: State<'_, Terminals>,
  project_id: Option<String>,
) -> Result<(), String> {
  ours(&webview)?;
  terminals.kill_all(project_id.as_deref());
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn terminal_ids_are_plain() {
    assert!(valid_id("2b7e1c9a-4f51-4a7e-9a0b-3f2d8c6e1d55"));
    for bad in ["", "a b", "../x", "x;y", &"a".repeat(65)] {
      assert!(!valid_id(bad), "{bad:?}");
    }
  }
}
