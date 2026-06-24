//! Per-project chat-history persistence — the Rust counterpart to
//! `src/main/services/history.ts`. Each project thread's transcript is a JSON
//! file under `<dataDir>/chats/`. The main thread keeps the bare
//! `<projectId>.json` name; side threads use `<projectId>__<threadId>.json`.

use super::paths;
use crate::types::ChatMessage;

/// The implicit main thread's id (mirrors `MAIN_THREAD_ID` in `shared/ipc.ts`).
pub const MAIN_THREAD_ID: &str = "main";

/// Keep transcripts bounded; older messages beyond this are dropped on save.
const MAX_MESSAGES: usize = 1000;

fn safe_slug(input: &str, fallback: &str) -> String {
  let s: String = input
    .chars()
    .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
    .take(128)
    .collect();
  if s.is_empty() {
    fallback.to_string()
  } else {
    s
  }
}

fn history_file(project_id: &str, thread_id: Option<&str>) -> std::path::PathBuf {
  let dir = paths::chats_dir();
  let project = safe_slug(project_id, "unknown");
  match thread_id {
    None | Some(MAIN_THREAD_ID) => dir.join(format!("{project}.json")),
    Some(tid) => {
      let thread = safe_slug(tid, "thread");
      dir.join(format!("{project}__{thread}.json"))
    }
  }
}

/// Coerce arbitrary persisted JSON into a clean `Vec<ChatMessage>`.
fn sanitize(messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
  messages
    .into_iter()
    .filter(|m| m.role == "user" || m.role == "assistant")
    .collect()
}

/// Load a project thread's persisted conversation (empty when none/invalid).
pub fn load_history(project_id: &str, thread_id: Option<&str>) -> Vec<ChatMessage> {
  match std::fs::read_to_string(history_file(project_id, thread_id)) {
    Ok(raw) => serde_json::from_str::<Vec<ChatMessage>>(&raw)
      .map(sanitize)
      .unwrap_or_default(),
    Err(_) => vec![],
  }
}

/// Persist a project thread's conversation. An empty list removes the file.
pub fn save_history(project_id: &str, messages: Vec<ChatMessage>, thread_id: Option<&str>) {
  let mut clean = sanitize(messages);
  if clean.len() > MAX_MESSAGES {
    clean = clean.split_off(clean.len() - MAX_MESSAGES);
  }
  let file = history_file(project_id, thread_id);
  if clean.is_empty() {
    let _ = std::fs::remove_file(&file);
    return;
  }
  if let Err(e) = std::fs::create_dir_all(paths::chats_dir()) {
    log::warn!("failed to create chats dir {}: {e}", paths::chats_dir().display());
  }
  if let Ok(text) = serde_json::to_string(&clean) {
    if let Err(e) = std::fs::write(&file, text) {
      log::warn!("failed to save chat history to {}: {e}", file.display());
    }
  }
}

/// Delete a project thread's persisted conversation (used on removal).
pub fn clear_history(project_id: &str, thread_id: Option<&str>) {
  let _ = std::fs::remove_file(history_file(project_id, thread_id));
}
