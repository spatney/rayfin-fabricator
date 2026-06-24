//! Chat engine: drives the GitHub Copilot CLI as the app's AI agent and maps its
//! event stream into clean ChatEvents for the renderer.
//!
//! Built on the GitHub Copilot Rust SDK: each project (and side thread) keeps one
//! persistent [`Session`](github_copilot_sdk::session::Session) — created or
//! resumed from its stored `copilot_session_id` by
//! [`CopilotManager`](crate::services::copilot::CopilotManager) — and a turn sends
//! the prompt, then drains the session's typed event subscription to idle. Reusing
//! the same session id across turns preserves conversation context (and survives
//! app restarts), exactly like the old `--session-id <uuid>` reuse did.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use github_copilot_sdk::handler::{ExitPlanModeHandler, ExitPlanModeResult};
use github_copilot_sdk::rpc::ModeSetRequest;
use github_copilot_sdk::session_events::SessionMode;
use github_copilot_sdk::subscription::RecvErrorKind;
use github_copilot_sdk::{Attachment, DeliveryMode, MessageOptions};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::commands::screenshot;
use crate::services::copilot::PlanModeHandler;
use crate::services::emit::emit_chat_event;
use crate::services::history::{self, MAIN_THREAD_ID};
use crate::services::store;
use crate::state::{AppState, TurnRoute};
use crate::types::{ChatEvent, ChatMessage, ChatOptions, ChatToolCall, ChatToolState, ChatTurnResult, CopilotModel, SteerResult};

const MAX_TOOL_OUTPUT: usize = 4000;
/// Up to this many copilot invocations per turn on a transient pre-work failure.
const MAX_ATTEMPTS: u32 = 3;
/// 20 minute per-turn timeout (matches chat.ts).
const TURN_TIMEOUT_MS: u64 = 20 * 60_000;

/// Stderr signatures that indicate a transient, safe-to-retry failure.
static TRANSIENT_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(
    r"(?i)rate.?limit|too many requests|temporar|timeout|etimedout|econnreset|enotfound|socket hang up|network error|503|502|500|overloaded|service unavailable|try again",
  )
  .unwrap()
});

/// A `rayfin up` invocation inside a tool call marks the turn as a deploy.
static RAYFIN_UP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\brayfin\s+up\b").unwrap());

/// Map the renderer's mode string to an SDK [`SessionMode`]. Unknown / missing
/// falls back to the interactive "Agent" default.
fn session_mode(mode: &Option<String>) -> SessionMode {
  match mode.as_deref() {
    Some("plan") => SessionMode::Plan,
    Some("autopilot") => SessionMode::Autopilot,
    _ => SessionMode::Interactive,
  }
}

fn thread_opt(thread_id: &Option<String>) -> Option<&str> {
  thread_id.as_deref()
}

fn truncate(text: &str, max: usize) -> String {
  if text.chars().count() <= max {
    return text.to_string();
  }
  let head: String = text.chars().take(max).collect();
  let more = text.chars().count() - max;
  format!("{head}\n… ({more} more characters)")
}

/// Derive a one-line summary for a tool call from its arguments.
fn tool_title(tool_name: &str, args: Option<&Value>) -> String {
  let Some(args) = args else {
    return tool_name.to_string();
  };
  let raw = args
    .get("description")
    .and_then(|v| v.as_str())
    .or_else(|| args.get("command").and_then(|v| v.as_str()))
    .or_else(|| args.get("path").and_then(|v| v.as_str()))
    .unwrap_or(tool_name);
  let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
  truncate(collapsed.trim(), 200)
}

/// Per-attempt accumulator for a single turn.
struct TurnCtx {
  files_modified: Vec<String>,
  ran_deploy: bool,
  /// Set once the session signalled turn end (`session.idle`).
  saw_result: bool,
  /// True once any assistant text or tool call occurred (blocks unsafe retries).
  saw_activity: bool,
  /// Set when the session reported an error (`session.error`); holds the message.
  errored: Option<String>,
  /// Characters of each assistant message already streamed as deltas (dedup).
  streamed: HashMap<String, usize>,
  /// The assistant message currently being appended. When the agent emits a new
  /// message mid-turn we insert a blank line, so consecutive messages don't run
  /// together (e.g. "…the implementation.Now let me…").
  cur_msg: Option<String>,
}

impl TurnCtx {
  fn new() -> Self {
    TurnCtx {
      files_modified: vec![],
      ran_deploy: false,
      saw_result: false,
      saw_activity: false,
      errored: None,
      streamed: HashMap::new(),
      cur_msg: None,
    }
  }
}

/// Outcome of feeding one server event to [`map_event`].
enum Flow {
  /// Keep draining the subscription.
  Continue,
  /// Turn reached a terminal state (`session.idle` / `session.error`).
  Stop,
}

/// If the agent has started a *different* assistant message than the one we were
/// appending, emit a blank-line delta first so the two messages read as separate
/// paragraphs instead of being concatenated ("…implementation.Now let me…").
fn ensure_separator(id: &str, sink: &mut dyn FnMut(ChatEvent), ctx: &mut TurnCtx) {
  if ctx.cur_msg.as_deref() == Some(id) {
    return;
  }
  if ctx.cur_msg.is_some() {
    sink(ChatEvent::Delta { text: "\n\n".to_string() });
  }
  ctx.cur_msg = Some(id.to_string());
}

/// Map a single Copilot **server** event (`event_type` plus its `data` object) to
/// ChatEvents pushed into `sink`, updating the turn accumulator. Unlike the old
/// one-shot `-p` JSONL, server events carry `data` as the inner object directly
/// (no `{type,data}` wrapper) and end the turn with `session.idle`.
fn map_event(event_type: &str, data: &Value, sink: &mut dyn FnMut(ChatEvent), ctx: &mut TurnCtx) -> Flow {
  match event_type {
    "assistant.message_delta" => {
      let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
      let text = data.get("deltaContent").and_then(|v| v.as_str()).unwrap_or("");
      if text.is_empty() {
        return Flow::Continue;
      }
      ctx.saw_activity = true;
      ensure_separator(&id, sink, ctx);
      *ctx.streamed.entry(id).or_insert(0) += text.chars().count();
      sink(ChatEvent::Delta { text: text.to_string() });
    }
    "assistant.message" => {
      let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
      let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
      let total = content.chars().count();
      let have = *ctx.streamed.get(&id).unwrap_or(&0);
      if total > have {
        ensure_separator(&id, sink, ctx);
        let rest: String = content.chars().skip(have).collect();
        sink(ChatEvent::Delta { text: rest });
        ctx.streamed.insert(id, total);
      }
    }
    "tool.execution_start" => {
      let tool_name = data.get("toolName").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
      let args = data.get("arguments");
      let title = tool_title(&tool_name, args);
      let command = args.and_then(|a| a.get("command")).and_then(|v| v.as_str()).unwrap_or("");
      if RAYFIN_UP_RE.is_match(command) {
        ctx.ran_deploy = true;
      }
      ctx.saw_activity = true;
      let id = data
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
      sink(ChatEvent::ToolStart {
        tool: ChatToolCall {
          id,
          name: tool_name,
          title,
          state: ChatToolState::Running,
          output: None,
        },
      });
    }
    "tool.execution_complete" => {
      let id = data.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("").to_string();
      let success = data.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
      // Success carries `result.content`; failure carries `error.message`.
      let output = data
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(|v| v.as_str())
        .or_else(|| data.get("error").and_then(|e| e.get("message")).and_then(|v| v.as_str()))
        .map(|c| truncate(c, MAX_TOOL_OUTPUT));
      sink(ChatEvent::ToolEnd {
        id,
        state: if success { ChatToolState::Success } else { ChatToolState::Error },
        output,
      });
    }
    "session.info" => {
      // File mutations surface as info events; collect them for `filesModified`.
      if let Some(info_type) = data.get("infoType").and_then(|v| v.as_str()) {
        if info_type.starts_with("file_") {
          if let Some(path) = data.get("message").and_then(|v| v.as_str()) {
            if !ctx.files_modified.iter().any(|p| p == path) {
              ctx.files_modified.push(path.to_string());
            }
          }
        }
      }
    }
    "exit_plan_mode.completed" => {
      // The plan prompt was answered (here or by another client) — let the
      // renderer dismiss its approval card.
      if let Some(request_id) = data.get("requestId").and_then(|v| v.as_str()) {
        sink(ChatEvent::PlanResolved { request_id: request_id.to_string() });
      }
    }
    "session.idle" => {
      ctx.saw_result = true;
      return Flow::Stop;
    }
    "session.error" => {
      let msg = data
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Copilot reported an error.")
        .to_string();
      sink(ChatEvent::Error { text: msg.clone() });
      ctx.errored = Some(msg);
      return Flow::Stop;
    }
    _ => {}
  }
  Flow::Continue
}

struct ThreadContext {
  cwd: String,
  session_id: String,
}

/// Resolve the working dir + Copilot session id for a thread, creating and
/// persisting a session id on first use. Returns None when the project/thread is
/// gone. Model/effort stay project-level (shared across threads).
fn resolve_context(project_id: &str, thread_id: &str) -> Option<ThreadContext> {
  let project = store::find_project(project_id)?;

  if thread_id == MAIN_THREAD_ID {
    let session_id = match project.copilot_session_id {
      Some(s) => s,
      None => {
        let sid = Uuid::new_v4().to_string();
        let stored = sid.clone();
        store::mutate_project(project_id, move |p| p.copilot_session_id = Some(stored));
        sid
      }
    };
    return Some(ThreadContext { cwd: project.path, session_id });
  }

  let thread = project.threads.as_ref()?.iter().find(|t| t.id == thread_id)?;
  let cwd = thread.worktree_path.clone();
  let session_id = match thread.copilot_session_id.clone() {
    Some(s) => s,
    None => {
      let sid = Uuid::new_v4().to_string();
      let stored = sid.clone();
      let target = thread_id.to_string();
      store::mutate_project(project_id, move |p| {
        if let Some(threads) = p.threads.as_mut() {
          if let Some(t) = threads.iter_mut().find(|t| t.id == target) {
            t.copilot_session_id = Some(stored);
          }
        }
      });
      sid
    }
  };
  Some(ThreadContext { cwd, session_id })
}

#[tauri::command]
pub async fn chat_send(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
  turn_id: String,
  text: String,
  attachments: Option<Vec<String>>,
  thread_id: Option<String>,
  mode: Option<String>,
) -> Result<ChatTurnResult, String> {
  run_turn(app, state.inner(), project_id, turn_id, text, attachments, thread_id, mode).await
}

/// The turn engine shared by `chat_send` and the side-thread merge flow. Drives
/// one Copilot invocation and streams its events to `(project_id, thread, turn_id)`.
/// Always resolves to `Ok` — failures surface inside the [`ChatTurnResult`].
pub(crate) async fn run_turn(
  app: AppHandle,
  state: &AppState,
  project_id: String,
  turn_id: String,
  text: String,
  attachments: Option<Vec<String>>,
  thread_id: Option<String>,
  mode: Option<String>,
) -> Result<ChatTurnResult, String> {
  let thread = thread_id.clone().unwrap_or_else(|| MAIN_THREAD_ID.to_string());
  let attachments = attachments.unwrap_or_default();

  let Some(project) = store::find_project(&project_id) else {
    emit_chat_event(&app, &project_id, &thread, &turn_id, ChatEvent::Error { text: "Project not found.".into() });
    screenshot::cleanup(&attachments);
    return Ok(ChatTurnResult {
      ok: false,
      error: Some("Project not found.".into()),
      files_modified: vec![],
      ran_deploy: false,
    });
  };

  let Some(ctx_info) = resolve_context(&project_id, &thread) else {
    emit_chat_event(&app, &project_id, &thread, &turn_id, ChatEvent::Error { text: "Side thread not found.".into() });
    screenshot::cleanup(&attachments);
    return Ok(ChatTurnResult {
      ok: false,
      error: Some("Thread not found.".into()),
      files_modified: vec![],
      ran_deploy: false,
    });
  };

  // Guard against two concurrent turns on the same project/thread.
  let Some(token) = state.try_begin_chat(&project_id, thread_opt(&thread_id)) else {
    emit_chat_event(
      &app,
      &project_id,
      &thread,
      &turn_id,
      ChatEvent::Error { text: "A message is already being processed for this thread.".into() },
    );
    return Ok(ChatTurnResult {
      ok: false,
      error: Some("Turn already running.".into()),
      files_modified: vec![],
      ran_deploy: false,
    });
  };

  // Surface plan-approval prompts (`exit_plan_mode`) to this turn's UI. The handler
  // is installed on every chat turn (cheap, harmless when not in Plan mode) because
  // the SDK session is cached/reused and may switch to Plan on a later turn.
  let plan_handler: Arc<dyn ExitPlanModeHandler> =
    Arc::new(PlanModeHandler::new(app.clone(), state.plan.clone()));

  // Open (or resume) this thread's persistent SDK session, reconciling model/effort.
  let session = match state
    .copilot
    .turn_session(
      &project_id,
      &thread,
      &ctx_info.cwd,
      &ctx_info.session_id,
      project.model.clone(),
      project.effort.clone(),
      Some(plan_handler),
    )
    .await
  {
    Ok(s) => s,
    Err(e) => {
      emit_chat_event(&app, &project_id, &thread, &turn_id, ChatEvent::Error { text: e.clone() });
      screenshot::cleanup(&attachments);
      state.end_chat(&project_id, thread_opt(&thread_id));
      return Ok(ChatTurnResult { ok: false, error: Some(e), files_modified: vec![], ran_deploy: false });
    }
  };

  // Apply the requested mode (Agent / Plan / Autopilot) to the session before
  // sending. Mode is sticky on the session, so this also handles switching modes
  // between turns. A failure here is non-fatal — fall back to the prior mode.
  let session_mode = session_mode(&mode);
  if let Err(e) = session.rpc().mode().set(ModeSetRequest { mode: session_mode.clone() }).await {
    log::warn!("failed to set session mode {session_mode:?}: {e}");
  }

  // Point the plan handler at this turn's UI for the duration of the turn.
  let session_key = ctx_info.session_id.clone();
  state.plan.set_route(
    &session_key,
    TurnRoute { project_id: project_id.clone(), thread_id: thread.clone(), turn_id: turn_id.clone() },
  );

  // File attachments → typed SDK attachments (built once, cloned per attempt).
  let attach: Vec<Attachment> = attachments
    .iter()
    .map(|a| Attachment::File { path: PathBuf::from(a), display_name: None, line_range: None })
    .collect();

  enum DrainEnd {
    Finished,
    Cancelled,
    Closed,
  }

  let mut ctx = TurnCtx::new();
  let mut cancelled = false;
  let mut timed_out = false;
  let mut send_error: Option<String> = None;
  let mut attempt: u32 = 1;

  loop {
    if attempt > 1 {
      ctx = TurnCtx::new();
      cancelled = false;
      timed_out = false;
    }

    // Subscribe before sending so the turn's events can't be missed.
    let mut sub = session.subscribe();

    let mut opts = MessageOptions::new(text.clone());
    if !attach.is_empty() {
      opts = opts.with_attachments(attach.clone());
    }
    if let Err(e) = session.send(opts).await {
      send_error = Some(e.to_string());
      break;
    }

    // Drain events until the session goes idle / errors, while honouring the stop
    // button (→ `session.abort()`) and a 20-minute per-turn cap.
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
              let mut sink = |e: ChatEvent| emit_chat_event(&app, &project_id, &thread, &turn_id, e);
              if let Flow::Stop = map_event(&ev.event_type, &ev.data, &mut sink, &mut ctx) {
                return DrainEnd::Finished;
              }
            }
            Err(err) => match err.kind() {
              RecvErrorKind::Lagged(l) => {
                log::warn!("chat event stream lagged, skipped {} events", l.skipped());
              }
              RecvErrorKind::Closed => return DrainEnd::Closed,
              // Unknown future error kind: stop draining rather than spin.
              other => {
                log::warn!("chat event stream error: {other:?}");
                return DrainEnd::Closed;
              }
            },
          }
        }
      }
    };

    match tokio::time::timeout(Duration::from_millis(TURN_TIMEOUT_MS), drain).await {
      Ok(DrainEnd::Cancelled) => cancelled = true,
      Ok(DrainEnd::Finished) | Ok(DrainEnd::Closed) => {}
      Err(_) => {
        let _ = session.abort().await;
        timed_out = true;
      }
    }

    // Retry only a transient failure that struck before any work happened —
    // re-sending the same prompt is then side-effect free.
    let transient = !cancelled
      && !timed_out
      && !ctx.saw_activity
      && attempt < MAX_ATTEMPTS
      && ctx.errored.as_deref().map(|m| TRANSIENT_RE.is_match(m)).unwrap_or(false);
    if !transient {
      break;
    }
    emit_chat_event(
      &app,
      &project_id,
      &thread,
      &turn_id,
      ChatEvent::Notice { text: format!("Copilot hiccup — retrying ({}/{})…", attempt, MAX_ATTEMPTS - 1) },
    );
    tokio::time::sleep(Duration::from_millis(attempt as u64 * 1000)).await;
    attempt += 1;
  }

  screenshot::cleanup(&attachments);
  state.end_chat(&project_id, thread_opt(&thread_id));
  // Drop this turn's plan route and unblock any handler still awaiting a decision
  // (covers Stop / timeout while an approval card is open).
  state.plan.clear_route(&session_key);
  state.plan.reject_pending(&session_key);

  if let Some(e) = send_error {
    emit_chat_event(&app, &project_id, &thread, &turn_id, ChatEvent::Error { text: e.clone() });
    emit_chat_event(
      &app,
      &project_id,
      &thread,
      &turn_id,
      ChatEvent::Result { ok: false, files_modified: vec![], ran_deploy: ctx.ran_deploy },
    );
    return Ok(ChatTurnResult { ok: false, error: Some(e), files_modified: vec![], ran_deploy: ctx.ran_deploy });
  }

  let ok = ctx.saw_result && ctx.errored.is_none() && !cancelled && !timed_out;
  // `session.error` already emitted its own Error; cancellation is user-initiated.
  if !ok && !cancelled && ctx.errored.is_none() {
    let detail = if timed_out {
      "Copilot timed out after 20 minutes.".to_string()
    } else {
      "Copilot ended unexpectedly.".to_string()
    };
    emit_chat_event(&app, &project_id, &thread, &turn_id, ChatEvent::Error { text: detail });
  }

  emit_chat_event(
    &app,
    &project_id,
    &thread,
    &turn_id,
    ChatEvent::Result { ok, files_modified: ctx.files_modified.clone(), ran_deploy: ctx.ran_deploy },
  );
  Ok(ChatTurnResult {
    ok,
    error: if ok { None } else { Some("Turn failed.".into()) },
    files_modified: ctx.files_modified,
    ran_deploy: ctx.ran_deploy,
  })
}

#[tauri::command]
pub fn chat_cancel(state: State<'_, AppState>, project_id: String, thread_id: Option<String>) {
  state.cancel_chat(&project_id, thread_opt(&thread_id));
}

/// Interject a message into the turn already running for `(project, thread)` —
/// conversation steering. Returns `{ steered: true }` when a turn was in flight:
/// the message either interrupts the current step immediately (Immediate
/// delivery) or, when a Plan card is awaiting a decision, is routed as
/// plan-revision feedback. Returns `{ steered: false }` when nothing is running,
/// so the renderer sends it as a normal new turn instead.
#[tauri::command]
pub async fn chat_steer(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
  text: String,
  attachments: Option<Vec<String>>,
  thread_id: Option<String>,
) -> Result<SteerResult, String> {
  let thread = thread_id.clone().unwrap_or_else(|| MAIN_THREAD_ID.to_string());
  let attachments = attachments.unwrap_or_default();

  // Nothing running → let the caller start a normal turn.
  if !state.is_chat_running(&project_id, thread_opt(&thread_id)) {
    return Ok(SteerResult { steered: false });
  }
  let Some(ctx_info) = resolve_context(&project_id, &thread) else {
    return Ok(SteerResult { steered: false });
  };
  // Where the live turn is streaming, so any plan card dismisses on the right turn.
  let active_turn = state.plan.route(&ctx_info.session_id).map(|r| r.turn_id);

  // Plan mode: a plan card is awaiting the user's decision, so the agent is
  // blocked on that choice rather than "thinking". Treat the typed message as
  // feedback that asks it to revise the plan instead of an immediate interjection.
  if let Some(request_id) = state.plan.pending_request(&ctx_info.session_id) {
    if let Some(turn) = &active_turn {
      emit_chat_event(&app, &project_id, &thread, turn, ChatEvent::PlanResolved { request_id: request_id.clone() });
    }
    state.plan.resolve(
      &request_id,
      ExitPlanModeResult { approved: false, selected_action: None, feedback: Some(text) },
    );
    screenshot::cleanup(&attachments);
    return Ok(SteerResult { steered: true });
  }

  // Normal interjection: deliver the message Immediately so it interrupts the
  // current step. The in-flight `run_turn` drain loop streams the resulting
  // events to the same turn, so we take no new turn lock here.
  let Some(session) = state.copilot.peek_session(&project_id, &thread).await else {
    // Running but no cached session (shouldn't happen) — treat as handled so the
    // renderer doesn't start a competing turn that the run guard would reject.
    screenshot::cleanup(&attachments);
    return Ok(SteerResult { steered: true });
  };

  let attach: Vec<Attachment> = attachments
    .iter()
    .map(|a| Attachment::File { path: PathBuf::from(a), display_name: None, line_range: None })
    .collect();
  let mut opts = MessageOptions::new(text).with_mode(DeliveryMode::Immediate);
  if !attach.is_empty() {
    opts = opts.with_attachments(attach);
  }
  if let Err(e) = session.send(opts).await {
    if let Some(turn) = &active_turn {
      emit_chat_event(&app, &project_id, &thread, turn, ChatEvent::Error { text: format!("Couldn't interject: {e}") });
    }
    screenshot::cleanup(&attachments);
    // Handled (with an error shown) — don't start a competing turn.
    return Ok(SteerResult { steered: true });
  }

  // The agent reads attachments early in the interjected step; defer cleanup so
  // we neither delete them before they're read nor leak temp files.
  if !attachments.is_empty() {
    tokio::spawn(async move {
      tokio::time::sleep(Duration::from_secs(120)).await;
      screenshot::cleanup(&attachments);
    });
  }
  Ok(SteerResult { steered: true })
}

#[tauri::command]
pub async fn chat_reset(state: State<'_, AppState>, project_id: String, thread_id: Option<String>) -> Result<(), String> {
  let tid = thread_opt(&thread_id);
  // Stop any in-flight turn first (mirrors chat.ts resetSession → cancelMessage).
  state.cancel_chat(&project_id, tid);
  // Drop the cached SDK session so the next turn starts a brand-new conversation.
  state.copilot.forget(&project_id, tid.unwrap_or(MAIN_THREAD_ID)).await;
  history::clear_history(&project_id, tid);
  match tid {
    None | Some(MAIN_THREAD_ID) => {
      store::mutate_project(&project_id, |p| p.copilot_session_id = None);
    }
    Some(tid) => {
      store::mutate_project(&project_id, |p| {
        if let Some(threads) = p.threads.as_mut() {
          if let Some(t) = threads.iter_mut().find(|t| t.id == tid) {
            t.copilot_session_id = None;
          }
        }
      });
    }
  }
  Ok(())
}

#[tauri::command]
pub fn chat_history(project_id: String, thread_id: Option<String>) -> Vec<ChatMessage> {
  history::load_history(&project_id, thread_opt(&thread_id))
}

/// Resolve a pending Plan-mode approval prompt raised via `exit_plan_mode`.
/// `action` is one of "interactive" | "autopilot" | "autopilot_fleet" | "exit_only"
/// (approve and continue with that route) — anything else (e.g. "keep_planning")
/// rejects the plan so the agent revises it, optionally using `feedback`.
#[tauri::command]
pub fn chat_resolve_plan(
  state: State<'_, AppState>,
  request_id: String,
  action: String,
  feedback: Option<String>,
) -> Result<(), String> {
  let result = match action.as_str() {
    "interactive" | "autopilot" | "autopilot_fleet" | "exit_only" => {
      ExitPlanModeResult { approved: true, selected_action: Some(action), feedback }
    }
    _ => ExitPlanModeResult { approved: false, selected_action: None, feedback },
  };
  if state.plan.resolve(&request_id, result) {
    Ok(())
  } else {
    Err("No pending plan to resolve.".into())
  }
}

#[tauri::command]
pub fn chat_save_history(project_id: String, messages: Vec<ChatMessage>, thread_id: Option<String>) {
  history::save_history(&project_id, messages, thread_opt(&thread_id));
}

#[tauri::command]
pub fn chat_set_options(project_id: String, options: ChatOptions) {
  let model = options.model.as_deref().map(str::trim).filter(|m| !m.is_empty()).map(|m| m.to_string());
  store::mutate_project(&project_id, |p| {
    p.model = model;
    p.effort = options.effort.clone();
  });
}

/// List the Copilot models available to the signed-in user, for the chat model
/// picker. Returns an `Err` (the renderer then falls back to its static
/// suggestions) when the engine can't be reached or the user isn't signed in.
#[tauri::command]
pub async fn chat_models(state: State<'_, AppState>) -> Result<Vec<CopilotModel>, String> {
  state.copilot.list_models().await
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn collect(events: &[(&str, Value)], ctx: &mut TurnCtx) -> Vec<ChatEvent> {
    let mut out = vec![];
    let mut sink = |e: ChatEvent| out.push(e);
    for (event_type, data) in events {
      map_event(event_type, data, &mut sink, ctx);
    }
    out
  }

  #[test]
  fn delta_then_file_info_collects_files_and_flags() {
    let mut ctx = TurnCtx::new();
    let events = collect(
      &[
        ("assistant.message_delta", json!({"messageId":"m1","deltaContent":"Hello"})),
        ("session.info", json!({"infoType":"file_created","message":"a.ts"})),
        ("session.info", json!({"infoType":"file_edited","message":"b.ts"})),
        // Duplicate path is ignored.
        ("session.info", json!({"infoType":"file_created","message":"a.ts"})),
        // Non-file info is ignored.
        ("session.info", json!({"infoType":"thinking","message":"hmm"})),
      ],
      &mut ctx,
    );
    assert!(ctx.saw_activity);
    assert_eq!(ctx.files_modified, vec!["a.ts".to_string(), "b.ts".to_string()]);
    assert_eq!(events.len(), 1);
    match &events[0] {
      ChatEvent::Delta { text } => assert_eq!(text, "Hello"),
      _ => panic!("expected delta"),
    }
  }

  #[test]
  fn session_idle_marks_result_and_stops() {
    let mut ctx = TurnCtx::new();
    let flow = map_event("session.idle", &json!({}), &mut |_e: ChatEvent| {}, &mut ctx);
    assert!(matches!(flow, Flow::Stop));
    assert!(ctx.saw_result);
  }

  #[test]
  fn session_error_emits_error_and_stops() {
    let mut ctx = TurnCtx::new();
    let mut events = vec![];
    let flow = {
      let mut sink = |e: ChatEvent| events.push(e);
      map_event("session.error", &json!({"message":"rate limit exceeded"}), &mut sink, &mut ctx)
    };
    assert!(matches!(flow, Flow::Stop));
    assert_eq!(ctx.errored.as_deref(), Some("rate limit exceeded"));
    assert_eq!(events.len(), 1);
    match &events[0] {
      ChatEvent::Error { text } => assert_eq!(text, "rate limit exceeded"),
      _ => panic!("expected error"),
    }
  }

  #[test]
  fn assistant_message_only_emits_untyped_remainder() {
    let mut ctx = TurnCtx::new();
    // 5 chars already streamed as a delta; the full message adds " world".
    let events = collect(
      &[
        ("assistant.message_delta", json!({"messageId":"m1","deltaContent":"Hello"})),
        ("assistant.message", json!({"messageId":"m1","content":"Hello world"})),
      ],
      &mut ctx,
    );
    assert_eq!(events.len(), 2);
    match &events[1] {
      ChatEvent::Delta { text } => assert_eq!(text, " world"),
      _ => panic!("expected remainder delta"),
    }
  }

  #[test]
  fn new_message_inserts_blank_line_separator() {
    let mut ctx = TurnCtx::new();
    // Two distinct assistant messages in one turn must read as separate
    // paragraphs, not concatenated ("First thought.Second thought.").
    let events = collect(
      &[
        ("assistant.message", json!({"messageId":"m1","content":"First thought."})),
        ("assistant.message", json!({"messageId":"m2","content":"Second thought."})),
      ],
      &mut ctx,
    );
    let text: String = events
      .iter()
      .map(|e| match e {
        ChatEvent::Delta { text } => text.as_str(),
        _ => "",
      })
      .collect();
    assert_eq!(text, "First thought.\n\nSecond thought.");
  }

  #[test]
  fn same_message_deltas_are_not_separated() {
    let mut ctx = TurnCtx::new();
    // Multiple deltas for the same messageId stream as one continuous paragraph.
    let events = collect(
      &[
        ("assistant.message_delta", json!({"messageId":"m1","deltaContent":"Hel"})),
        ("assistant.message_delta", json!({"messageId":"m1","deltaContent":"lo"})),
      ],
      &mut ctx,
    );
    let text: String = events
      .iter()
      .map(|e| match e {
        ChatEvent::Delta { text } => text.as_str(),
        _ => "",
      })
      .collect();
    assert_eq!(text, "Hello");
  }

  #[test]
  fn tool_start_detects_deploy_and_titles() {
    let mut ctx = TurnCtx::new();
    let events = collect(
      &[(
        "tool.execution_start",
        json!({"toolCallId":"t1","toolName":"shell","arguments":{"command":"npx rayfin up --json"}}),
      )],
      &mut ctx,
    );
    assert!(ctx.ran_deploy);
    assert!(ctx.saw_activity);
    match &events[0] {
      ChatEvent::ToolStart { tool } => {
        assert_eq!(tool.id, "t1");
        assert_eq!(tool.name, "shell");
        assert_eq!(tool.title, "npx rayfin up --json");
        assert!(matches!(tool.state, ChatToolState::Running));
      }
      _ => panic!("expected tool-start"),
    }
  }

  #[test]
  fn tool_complete_maps_success_and_output() {
    let mut ctx = TurnCtx::new();
    let events = collect(
      &[(
        "tool.execution_complete",
        json!({"toolCallId":"t1","success":true,"result":{"content":"done"}}),
      )],
      &mut ctx,
    );
    match &events[0] {
      ChatEvent::ToolEnd { id, state, output } => {
        assert_eq!(id, "t1");
        assert!(matches!(state, ChatToolState::Success));
        assert_eq!(output.as_deref(), Some("done"));
      }
      _ => panic!("expected tool-end"),
    }
  }

  #[test]
  fn tool_complete_maps_failure_to_error_message() {
    let mut ctx = TurnCtx::new();
    let events = collect(
      &[(
        "tool.execution_complete",
        json!({"toolCallId":"t1","success":false,"error":{"code":"E","message":"boom"}}),
      )],
      &mut ctx,
    );
    match &events[0] {
      ChatEvent::ToolEnd { id, state, output } => {
        assert_eq!(id, "t1");
        assert!(matches!(state, ChatToolState::Error));
        assert_eq!(output.as_deref(), Some("boom"));
      }
      _ => panic!("expected tool-end"),
    }
  }

  #[test]
  fn truncate_appends_more_marker() {
    assert_eq!(truncate("hello", 10), "hello");
    let out = truncate("abcdef", 3);
    assert!(out.starts_with("abc"));
    assert!(out.contains("3 more characters"));
  }
}

