//! One-shot model calls on **transient, read-only** Copilot sessions: commit
//! messages and the App gallery's descriptions ask a model once and use its
//! reply. They never land in a project's chat history, can't write files or run
//! commands, and carry no built-in tools.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use github_copilot_sdk::subscription::RecvErrorKind;
use github_copilot_sdk::{Attachment, MessageOptions};
use serde_json::Value;

use crate::services::byok;
use crate::services::copilot::ModelChoice;
use crate::state::AppState;

/// How long one run may take before it's abandoned.
const RUN_TIMEOUT_MS: u64 = 60_000;

/// One-shot calls answer from the prompt (and optional attachments) alone, so
/// their sessions carry no built-in tools: tool schemas would only add prompt
/// size and latency. The read-only policy stays as a backstop.
fn session_options(cwd: &str) -> crate::services::copilot::SessionOptions {
  crate::services::copilot::SessionOptions {
    available_tools: Some(Vec::new()),
    ..crate::commands::advisor::read_only_options(cwd)
  }
}

/// Streaming accumulator for one transient run.
#[derive(Default)]
struct GenState {
  assistant: String,
  streamed: HashMap<String, usize>,
  /// The session's error message, when it reported one.
  error: Option<String>,
}

/// Feed one Copilot server event in. Returns `true` at a terminal state.
fn map_event(event_type: &str, data: &Value, st: &mut GenState) -> bool {
  match event_type {
    "assistant.message_delta" => {
      let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
      let text = data.get("deltaContent").and_then(|v| v.as_str()).unwrap_or("");
      if text.is_empty() {
        return false;
      }
      st.assistant.push_str(text);
      *st.streamed.entry(id).or_insert(0) += text.chars().count();
    }
    "assistant.message" => {
      let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
      let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
      let total = content.chars().count();
      let have = *st.streamed.get(&id).unwrap_or(&0);
      if total > have {
        let rest: String = content.chars().skip(have).collect();
        st.assistant.push_str(&rest);
        st.streamed.insert(id, total);
      }
    }
    "session.error" => {
      st.error = data.get("message").and_then(|v| v.as_str()).map(str::to_string);
      return true;
    }
    "session.idle" => return true,
    _ => {}
  }
  false
}

/// Run `prompt` once on a transient, read-only session rooted at `cwd` and
/// return the assistant's full reply. Never touches the project's chat.
/// `on_text` sees the reply so far each time it grows. A model on the user's
/// own key must be able to run first, and its errors come back in plain language.
/// With no `model`, Copilot's Auto router picks one (commit messages use that).
pub(crate) async fn run_transient(
  state: &AppState,
  cwd: &str,
  model: Option<String>,
  effort: Option<String>,
  prompt: String,
  attachments: &[PathBuf],
  mut on_text: Option<&mut (dyn FnMut(&str) + Send)>,
) -> Result<String, String> {
  let mut options = session_options(cwd);
  let provider_model = model.clone().filter(|m| byok::is_provider_selection(m));
  if let Some(m) = &provider_model {
    state.byok.ensure_ready(m)?;
    options.byok = state.byok.session_registry();
  }
  let session = state
    .copilot
    .transient_session_with(cwd, ModelChoice::of(model, effort), options)
    .await
    .map_err(|_| "Couldn't reach the model.".to_string())?;

  let mut st = GenState::default();
  let mut sub = session.subscribe();
  let mut opts = MessageOptions::new(prompt);
  if !attachments.is_empty() {
    opts = opts.with_attachments(
      attachments
        .iter()
        .map(|p| Attachment::File { path: p.clone(), display_name: None, line_range: None })
        .collect(),
    );
  }
  let sent = session.send(opts).await.is_ok();
  if sent {
    let drain = async {
      loop {
        match sub.recv().await {
          Ok(ev) => {
            let before = st.assistant.len();
            let done = map_event(&ev.event_type, &ev.data, &mut st);
            if st.assistant.len() != before {
              if let Some(f) = on_text.as_mut() {
                f(&st.assistant);
              }
            }
            if done {
              break;
            }
          }
          Err(err) => match err.kind() {
            RecvErrorKind::Lagged(_) => {}
            _ => break,
          },
        }
      }
    };
    if tokio::time::timeout(Duration::from_millis(RUN_TIMEOUT_MS), drain).await.is_err() {
      let _ = session.abort().await;
    }
  }
  let _ = session.disconnect().await;
  if !sent {
    return Err("Couldn't send the request to the model.".into());
  }
  if st.assistant.trim().is_empty() {
    if let (Some(model), Some(raw)) = (&provider_model, &st.error) {
      return Err(byok::explain_for(model, raw).unwrap_or_else(|| raw.clone()));
    }
  }
  Ok(st.assistant)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn transient_sessions_carry_no_built_in_tools() {
    let opts = session_options("C:/project");
    assert_eq!(opts.available_tools, Some(Vec::new()));
    assert!(opts.permission.is_some(), "the read-only policy stays as a backstop");
  }
}
