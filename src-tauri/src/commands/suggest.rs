//! Starter suggestions: Copilot-generated "what to build next" ideas for the
//! empty Build chat, grounded in the app's actual code (entities, routes,
//! `package.json`) instead of guessing from the project name.
//!
//! Like the Advisor, this runs on a *transient* Copilot session (a throwaway
//! session id, disconnected after the run) so it never lands in the project's
//! chat history, and asks the model for a single fenced JSON block we parse into
//! a [`SuggestionSet`]. Results are cached per project and reused until the
//! source tree changes (same fingerprint scheme the Advisor uses for `stale`).

use std::collections::HashMap;
use std::time::Duration;

use github_copilot_sdk::subscription::RecvErrorKind;
use github_copilot_sdk::MessageOptions;
use serde_json::Value;
use tauri::State;

use crate::services::fingerprint::fingerprint;
use crate::services::{paths, store};
use crate::state::AppState;
use crate::types::{SuggestionRaw, SuggestionSet};

/// 3 minute ceiling for a single suggestion-generation run.
const RUN_TIMEOUT_MS: u64 = 3 * 60_000;

/// How many suggestions we keep (the welcome screen shows a 2x2 grid).
const MAX_SUGGESTIONS: usize = 4;

/// The instruction handed to Copilot. Read-only; ends with a strict JSON
/// contract we can parse out of the assistant's final message.
const SUGGEST_PROMPT: &str = r#"You are helping a NON-CODER decide what to build next in their Rayfin app (a Microsoft Fabric app: a TypeScript/React frontend under `src/` plus a Rayfin backend defined under `rayfin/`). Perform a READ-ONLY look at the app in this directory. DO NOT modify, create, or delete any files, and DO NOT run any deploy or `rayfin up` command.

Read enough of the code to understand what the app currently does and what it manages: look at `rayfin/data/schema.ts` (the data entities/models), the frontend pages and routes under `src/` (e.g. `src/App.tsx`, `src/pages`), and `package.json`. Identify the main "thing" the app is about (e.g. slides, tasks, plants, recipes).

Then propose exactly 4 short, concrete NEXT-STEP ideas the user could ask for, tailored to THIS app — a mix of things that are missing and natural improvements. Write each as a single plain-language sentence in the user's own voice, the way they would type it (imperative, friendly, no jargon, ideally 4-9 words). Examples of the right voice: "Show all my slides on a clean page", "Add a form to create and edit a slide", "Let people sign in to see their own slides", "Give the whole app a fresh, modern look".

Only propose things Rayfin natively provides:
- data: lists/tables, create/edit forms, search & filters, dashboards & charts
- authentication & per-user data (sign-in)
- file/image storage (attachments, photos)
- visual design / polish

NEVER propose anything that needs an external service (payments, sending email or SMS, third-party APIs).

Pick 4 DIFFERENT ideas (do not propose two variations of the same thing). Give each a single relevant emoji.

When you are done, the FINAL thing in your reply must be a single fenced ```json code block (and nothing after it) exactly matching this schema:

```json
{
  "suggestions": [
    { "icon": "📋", "text": "Show all my slides on a clean page" },
    { "icon": "✏️", "text": "Add a form to create and edit a slide" },
    { "icon": "📊", "text": "Add a dashboard that charts my slides" },
    { "icon": "🎨", "text": "Give the whole app a fresh, modern look" }
  ]
}
```"#;

/// Per-run streaming accumulator.
#[derive(Default)]
struct GenState {
  /// Full assistant text, reassembled in stream order (for JSON extraction).
  assistant: String,
  /// Characters of each assistant message already appended (dedup with the
  /// terminal `assistant.message` event).
  streamed: HashMap<String, usize>,
  /// Error message if the session reported one (`session.error`).
  errored: Option<String>,
}

/// Feed one Copilot **server** event into the accumulator. Returns `true` once
/// the turn reaches a terminal state (`session.idle` / `session.error`).
fn map_gen_event(event_type: &str, data: &Value, st: &mut GenState) -> bool {
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
      let msg = data
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Copilot reported an error.")
        .to_string();
      st.errored = Some(msg);
      return true;
    }
    "session.idle" => return true,
    _ => {}
  }
  false
}

/// Pull fenced code-block bodies out of `s`, stripping a short leading language
/// tag (e.g. ```json). Blocks are returned in document order.
fn fenced_blocks(s: &str) -> Vec<String> {
  let parts: Vec<&str> = s.split("```").collect();
  let mut out = Vec::new();
  let mut i = 1;
  while i < parts.len() {
    let mut block = parts[i];
    if let Some(nl) = block.find('\n') {
      let first = block[..nl].trim();
      if !first.contains('{') && first.len() <= 12 {
        block = &block[nl + 1..];
      }
    }
    out.push(block.to_string());
    i += 2;
  }
  out
}

/// Best-effort extraction of the JSON suggestions from Copilot's final message:
/// prefer the last fenced block that parses, then fall back to the widest
/// `{ ... }` slice.
fn extract_suggestions(text: &str) -> Option<SuggestionRaw> {
  for block in fenced_blocks(text).into_iter().rev() {
    if let Ok(raw) = serde_json::from_str::<SuggestionRaw>(block.trim()) {
      return Some(raw);
    }
  }
  if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) {
    if end > start {
      if let Ok(raw) = serde_json::from_str::<SuggestionRaw>(&text[start..=end]) {
        return Some(raw);
      }
    }
  }
  None
}

/// Persist a successful suggestion set for later reuse.
fn save_set(project_id: &str, set: &SuggestionSet) {
  if let Ok(text) = serde_json::to_string_pretty(set) {
    if let Err(e) = std::fs::write(paths::suggest_file(project_id), text) {
      log::warn!("failed to save suggestions for {project_id}: {e}");
    }
  }
}

/// Load a cached suggestion set, if any.
fn load_set(project_id: &str) -> Option<SuggestionSet> {
  let text = std::fs::read_to_string(paths::suggest_file(project_id)).ok()?;
  serde_json::from_str(&text).ok()
}

/// Generate (or return cached) starter suggestions for a project. Returns a set
/// with `ok: true` when Copilot produced usable suggestions; `ok: false` (with
/// an empty list) tells the renderer to fall back to its built-in heuristics.
/// A successful, fresh set is cached and reused until the project's code changes.
#[tauri::command]
pub async fn chat_suggest(
  state: State<'_, AppState>,
  project_id: String,
) -> Result<SuggestionSet, String> {
  let Some(project) = store::find_project(&project_id) else {
    return Err("Project not found.".into());
  };

  let current_fp = fingerprint(&project.path);

  // Reuse a cached set when it matches the current code.
  if let Some(set) = load_set(&project_id) {
    if set.ok && !set.fingerprint.is_empty() && set.fingerprint == current_fp {
      return Ok(set);
    }
  }

  let Some(token) = state.try_begin_suggest(&project_id) else {
    return Err("Suggestions are already being generated for this project.".into());
  };

  // A transient, uncached session keeps this out of the project's chat history.
  let session = match state.copilot.transient_session(&project.path, None, None).await {
    Ok(s) => s,
    Err(_) => {
      state.end_suggest(&project_id);
      return Ok(SuggestionSet::default());
    }
  };

  enum DrainEnd {
    Finished,
    Cancelled,
    Closed,
  }

  let mut st = GenState::default();
  let mut cancelled = false;

  // Subscribe before sending so no events are missed.
  let mut sub = session.subscribe();
  let send_ok = session.send(MessageOptions::new(SUGGEST_PROMPT)).await.is_ok();

  if send_ok {
    let drain = async {
      loop {
        if token.is_cancelled() {
          let _ = session.abort().await;
          return DrainEnd::Cancelled;
        }
        tokio::select! {
          _ = token.wait_cancelled() => {
            let _ = session.abort().await;
            return DrainEnd::Cancelled;
          }
          recv = sub.recv() => match recv {
            Ok(ev) => {
              if map_gen_event(&ev.event_type, &ev.data, &mut st) {
                return DrainEnd::Finished;
              }
            }
            Err(err) => match err.kind() {
              RecvErrorKind::Lagged(l) => {
                log::warn!("suggest event stream lagged, skipped {} events", l.skipped());
              }
              RecvErrorKind::Closed => return DrainEnd::Closed,
              other => {
                log::warn!("suggest event stream error: {other:?}");
                return DrainEnd::Closed;
              }
            },
          }
        }
      }
    };
    match tokio::time::timeout(Duration::from_millis(RUN_TIMEOUT_MS), drain).await {
      Ok(DrainEnd::Cancelled) => cancelled = true,
      Ok(DrainEnd::Finished) | Ok(DrainEnd::Closed) => {}
      Err(_) => {
        let _ = session.abort().await;
      }
    }
  }

  // The suggestion session is one-shot; disconnect it so it never accumulates.
  let _ = session.disconnect().await;
  state.end_suggest(&project_id);

  if cancelled {
    return Ok(SuggestionSet::default());
  }

  // Parse the model's JSON, keep up to MAX_SUGGESTIONS non-empty entries.
  let set = match extract_suggestions(&st.assistant) {
    Some(raw) => {
      let suggestions: Vec<_> = raw
        .suggestions
        .into_iter()
        .filter(|s| !s.text.trim().is_empty())
        .take(MAX_SUGGESTIONS)
        .collect();
      if suggestions.is_empty() {
        SuggestionSet::default()
      } else {
        SuggestionSet { ok: true, suggestions, fingerprint: current_fp }
      }
    }
    None => SuggestionSet::default(),
  };

  if set.ok {
    save_set(&project_id, &set);
  }
  Ok(set)
}

/// Cancel the in-flight suggestion generation for a project, if any.
#[tauri::command]
pub fn chat_suggest_cancel(state: State<'_, AppState>, project_id: String) -> bool {
  state.cancel_suggest(&project_id)
}
