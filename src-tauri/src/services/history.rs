//! Per-project chat-history persistence — the Rust counterpart to
//! `src/main/services/history.ts`. Each project's transcript is a JSON file
//! `<projectId>.json` under `<dataDir>/chats/`.

use super::paths;
use crate::types::ChatMessage;

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

fn history_file(project_id: &str) -> std::path::PathBuf {
  paths::chats_dir().join(format!("{}.json", safe_slug(project_id, "unknown")))
}

/// Coerce arbitrary persisted JSON into a clean `Vec<ChatMessage>`, dropping
/// legacy "merge" system events from the removed side-threads feature.
fn sanitize(messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
  messages
    .into_iter()
    .filter(|m| (m.role == "user" || m.role == "assistant") && m.kind.as_deref() != Some("merge"))
    .collect()
}

/// Load a project's persisted conversation (empty when none/invalid).
pub fn load_history(project_id: &str) -> Vec<ChatMessage> {
  match std::fs::read_to_string(history_file(project_id)) {
    Ok(raw) => serde_json::from_str::<Vec<ChatMessage>>(&raw)
      .map(sanitize)
      .unwrap_or_default(),
    Err(_) => vec![],
  }
}

/// Persist a project's conversation. An empty list removes the file.
pub fn save_history(project_id: &str, messages: Vec<ChatMessage>) {
  let mut clean = sanitize(messages);
  if clean.len() > MAX_MESSAGES {
    clean = clean.split_off(clean.len() - MAX_MESSAGES);
  }
  let file = history_file(project_id);
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

/// Delete a project's persisted conversation (used on removal).
pub fn clear_history(project_id: &str) {
  let _ = std::fs::remove_file(history_file(project_id));
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn design_apply_markers_survive_chat_history_sanitizing_and_serde() {
    let rows: Vec<ChatMessage> = serde_json::from_value(serde_json::json!([
      {"id":"apply-user","role":"user","text":"Apply the visual draft","designApplyId":"apply-1"},
      {"id":"apply-1","role":"assistant","text":"","designApplyId":"apply-1","interrupted":true},
      {"id":"old-merge","role":"assistant","kind":"merge","text":"Legacy merge"}
    ])).unwrap();
    let saved = serde_json::to_string(&sanitize(rows)).unwrap();
    let reloaded = sanitize(serde_json::from_str(&saved).unwrap());
    assert_eq!(reloaded.len(), 2);
    assert!(reloaded.iter().all(|row| row.design_apply_id.as_deref() == Some("apply-1")));
    assert_eq!(reloaded[1].interrupted, Some(true));
    assert!(saved.contains("\"designApplyId\":\"apply-1\""));
    assert!(!saved.contains("design_apply_id"));
  }

  #[test]
  fn design_marker_is_optional_in_legacy_chat_history() {
    let row: ChatMessage = serde_json::from_str(r#"{"id":"ordinary","role":"user","text":"Hello"}"#).unwrap();
    assert!(row.design_apply_id.is_none());
    assert!(!serde_json::to_string(&row).unwrap().contains("designApplyId"));
  }
}
