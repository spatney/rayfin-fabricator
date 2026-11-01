//! Per-project chat-history persistence — the Rust counterpart to
//! `src/main/services/history.ts`. Each project's transcript is a JSON file
//! `<projectId>.json` under `<dataDir>/chats/`, and what its chat has used is
//! `<projectId>.usage.json` beside it.

use super::paths;
use crate::types::{ChatMessage, ChatUsage};

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

fn usage_file(project_id: &str) -> std::path::PathBuf {
  paths::chats_dir().join(format!("{}.usage.json", safe_slug(project_id, "unknown")))
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

/// Delete a project's persisted conversation and what it used (used on removal
/// and when the chat starts over).
pub fn clear_history(project_id: &str) {
  let _ = std::fs::remove_file(history_file(project_id));
  let _ = std::fs::remove_file(usage_file(project_id));
}

/// What a project's chat used, as of its last save (`None` when never saved).
pub fn load_usage(project_id: &str) -> Option<ChatUsage> {
  let raw = std::fs::read_to_string(usage_file(project_id)).ok()?;
  serde_json::from_str(&raw).ok()
}

/// Keep what a project's chat has used, for when its session isn't open.
pub fn save_usage(project_id: &str, usage: &ChatUsage) {
  if load_usage(project_id).as_ref() == Some(usage) {
    return;
  }
  if let Err(e) = std::fs::create_dir_all(paths::chats_dir()) {
    log::warn!("failed to create chats dir {}: {e}", paths::chats_dir().display());
  }
  let file = usage_file(project_id);
  if let Ok(text) = serde_json::to_string(usage) {
    if let Err(e) = std::fs::write(&file, text) {
      log::warn!("failed to save chat usage to {}: {e}", file.display());
    }
  }
}

/// Copy one project's conversation to another (used when a project moves into
/// a team workspace and gets a new id).
pub fn copy_history(from_project_id: &str, to_project_id: &str) {
  let messages = load_history(from_project_id);
  if !messages.is_empty() {
    save_history(to_project_id, messages);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn legacy_rows_load_and_retired_markers_are_dropped() {
    // Transcripts saved by the removed Design Studio carried `designApplyId`; they
    // must still load (the marker is simply ignored) and legacy merges vanish.
    let rows: Vec<ChatMessage> = serde_json::from_value(serde_json::json!([
      {"id":"apply-user","role":"user","text":"Apply the visual draft","designApplyId":"apply-1"},
      {"id":"apply-1","role":"assistant","text":"","designApplyId":"apply-1","interrupted":true},
      {"id":"old-merge","role":"assistant","kind":"merge","text":"Legacy merge"}
    ])).unwrap();
    let saved = serde_json::to_string(&sanitize(rows)).unwrap();
    let reloaded = sanitize(serde_json::from_str(&saved).unwrap());
    assert_eq!(reloaded.len(), 2);
    assert_eq!(reloaded[1].interrupted, Some(true));
    assert!(!saved.contains("designApplyId"));
  }
}
