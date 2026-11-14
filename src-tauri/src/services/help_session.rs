//! Persistence for the Help assistant's conversation.
//!
//! Help is a troubleshooting surface, so the thread has to outlive both the
//! overlay and the app. Two things make that necessary rather than nice:
//!
//! * Taking an action Help offered (opening a project, the Accounts dialog, the
//!   share dialog) closes the overlay. Losing the conversation that offered the
//!   action would be absurd.
//! * "Restart Fabricator and try again" is a real fix. The user has to be able
//!   to come back afterwards and say "that didn't work".
//!
//! The conversation is renderer-owned UI state, so it is stored as an opaque
//! JSON value rather than a mirrored struct — a DTO here would silently drop
//! any field the renderer later adds. Rust owns one policy the renderer must
//! not get wrong: a thread goes stale, and a stale one is never resumed.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::paths;

/// Largest conversation accepted. Generous for text, small enough that a
/// runaway transcript can't fill the data directory.
const MAX_BYTES: usize = 512 * 1024;

/// How long a conversation stays resumable. Long enough to survive a restart,
/// a coffee, or picking it up the next morning; short enough that an unrelated
/// problem next week starts fresh instead of resuming a confusing thread.
const MAX_AGE_HOURS: i64 = 24;

/// The stored file: the renderer's conversation plus when it was written.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
  /// RFC 3339 timestamp of the last save.
  pub saved_at: String,
  /// The renderer's own conversation shape, untouched.
  pub data: Value,
}

/// A conversation that is still fresh enough to resume.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResumedSession {
  pub saved_at: String,
  pub data: Value,
}

fn parse_age_hours(saved_at: &str, now: chrono::DateTime<chrono::Utc>) -> Option<i64> {
  let saved = chrono::DateTime::parse_from_rfc3339(saved_at).ok()?;
  Some((now - saved.with_timezone(&chrono::Utc)).num_hours())
}

/// Whether a thread saved at `saved_at` may still be resumed. A timestamp we
/// can't read, or one from the future (a clock change), is treated as stale:
/// starting fresh is always safe, resuming wrongly is not.
fn resumable(saved_at: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
  matches!(parse_age_hours(saved_at, now), Some(age) if (0..MAX_AGE_HOURS).contains(&age))
}

fn load_from(path: &Path, now: chrono::DateTime<chrono::Utc>) -> Option<ResumedSession> {
  let raw = std::fs::read_to_string(path).ok()?;
  let stored: StoredSession = serde_json::from_str(&raw).ok()?;
  if !resumable(&stored.saved_at, now) {
    // Stale: drop it now rather than leaving it to be re-read every launch.
    let _ = std::fs::remove_file(path);
    return None;
  }
  Some(ResumedSession { saved_at: stored.saved_at, data: stored.data })
}

/// The saved conversation, when there is one and it is still fresh.
pub fn load() -> Option<ResumedSession> {
  load_from(&paths::help_session_file(), chrono::Utc::now())
}

fn save_to(path: &Path, data: Value, now: chrono::DateTime<chrono::Utc>) -> Result<(), String> {
  let stored = StoredSession { saved_at: now.to_rfc3339(), data };
  let text = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
  if text.len() > MAX_BYTES {
    return Err(t!("services.helpSession.tooLong"));
  }
  std::fs::write(path, text).map_err(|e| e.to_string())
}

/// Persist the conversation, replacing whatever was there.
pub fn save(data: Value) -> Result<(), String> {
  save_to(&paths::help_session_file(), data, chrono::Utc::now())
}

/// Forget the saved conversation (the user started a new one).
pub fn clear() {
  let _ = std::fs::remove_file(paths::help_session_file());
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn tmp_file(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rayfin-help-session-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("session.json")
  }

  fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
  }

  #[test]
  fn a_saved_conversation_round_trips() {
    let path = tmp_file("round-trip");
    let data = json!([{ "id": "ask-1", "question": "why did my deploy fail?", "answer": "No workspace." }]);
    save_to(&path, data.clone(), now()).unwrap();

    let resumed = load_from(&path, now()).expect("a fresh thread resumes");
    assert_eq!(resumed.data, data, "the renderer's shape is stored untouched");
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
  }

  #[test]
  fn unknown_fields_survive_a_save() {
    // The conversation is renderer-owned: a field added in the UI must not be
    // dropped just because Rust doesn't know about it.
    let path = tmp_file("passthrough");
    let data = json!([{ "id": "ask-1", "somethingAddedLater": { "nested": true } }]);
    save_to(&path, data.clone(), now()).unwrap();
    assert_eq!(load_from(&path, now()).unwrap().data, data);
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
  }

  #[test]
  fn a_stale_conversation_is_not_resumed_and_is_deleted() {
    let path = tmp_file("stale");
    save_to(&path, json!([{ "id": "old" }]), now() - chrono::Duration::hours(MAX_AGE_HOURS + 1)).unwrap();

    assert!(load_from(&path, now()).is_none(), "yesterday's problem is not today's");
    assert!(!path.exists(), "the stale file is cleaned up");
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
  }

  #[test]
  fn a_conversation_just_inside_the_window_still_resumes() {
    let path = tmp_file("fresh-edge");
    save_to(&path, json!([{ "id": "recent" }]), now() - chrono::Duration::hours(MAX_AGE_HOURS - 1)).unwrap();
    assert!(load_from(&path, now()).is_some());
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
  }

  #[test]
  fn a_timestamp_from_the_future_is_treated_as_stale() {
    // A clock change must not pin a thread open forever.
    assert!(!resumable(&(now() + chrono::Duration::hours(2)).to_rfc3339(), now()));
  }

  #[test]
  fn an_unreadable_timestamp_is_treated_as_stale() {
    assert!(!resumable("not a date", now()));
  }

  #[test]
  fn a_corrupt_file_loads_as_nothing_rather_than_failing() {
    let path = tmp_file("corrupt");
    std::fs::write(&path, "{ this is not json").unwrap();
    assert!(load_from(&path, now()).is_none());
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
  }

  #[test]
  fn a_missing_file_loads_as_nothing() {
    assert!(load_from(Path::new("C:\\nope\\missing-session.json"), now()).is_none());
  }

  #[test]
  fn an_oversized_conversation_is_refused() {
    let path = tmp_file("oversize");
    let huge = json!([{ "answer": "x".repeat(MAX_BYTES + 1) }]);
    assert!(save_to(&path, huge, now()).is_err());
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
  }
}
