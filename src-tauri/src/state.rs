//! Shared, mutable application state managed by Tauri (`app.manage(...)`).
//!
//! Holds the in-flight chat cancellation handles so a `chat_cancel` command can
//! stop the running Copilot process for a specific project/thread turn.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::services::exec::CancelToken;
use crate::services::history::MAIN_THREAD_ID;

#[derive(Default)]
pub struct AppState {
  /// Active chat cancel tokens, keyed by `"<projectId>::<threadId>"`.
  chat_cancels: Mutex<HashMap<String, CancelToken>>,
}

fn key(project_id: &str, thread_id: Option<&str>) -> String {
  format!("{project_id}::{}", thread_id.unwrap_or(MAIN_THREAD_ID))
}

impl AppState {
  /// Register a fresh cancel token for a turn only if none is already running for
  /// this project/thread. Returns `None` when a turn is already in flight.
  pub fn try_begin_chat(&self, project_id: &str, thread_id: Option<&str>) -> Option<CancelToken> {
    let mut map = self.chat_cancels.lock().unwrap();
    let k = key(project_id, thread_id);
    if map.contains_key(&k) {
      return None;
    }
    let token = CancelToken::new();
    map.insert(k, token.clone());
    Some(token)
  }

  /// Remove a turn's cancel token (called when the turn completes).
  pub fn end_chat(&self, project_id: &str, thread_id: Option<&str>) {
    self
      .chat_cancels
      .lock()
      .unwrap()
      .remove(&key(project_id, thread_id));
  }

  /// Cancel an in-flight turn, if one is running. Returns true when a token was
  /// found and signalled.
  pub fn cancel_chat(&self, project_id: &str, thread_id: Option<&str>) -> bool {
    if let Some(token) = self.chat_cancels.lock().unwrap().remove(&key(project_id, thread_id)) {
      token.cancel();
      true
    } else {
      false
    }
  }
}
