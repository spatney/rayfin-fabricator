//! Chat engine: drives the GitHub Copilot CLI as the app's AI agent and maps its
//! event stream into clean ChatEvents for the renderer.
//!
//! Built on the GitHub Copilot Rust SDK: each project keeps one persistent
//! [`Session`](github_copilot_sdk::session::Session) — created or resumed from
//! its stored `copilot_session_id` by
//! [`CopilotManager`](crate::services::copilot::CopilotManager) — and a turn sends
//! the prompt, then drains the session's typed event subscription to idle. Reusing
//! the same session id across turns preserves conversation context (and survives
//! app restarts), exactly like the old `--session-id <uuid>` reuse did.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use github_copilot_sdk::handler::{ExitPlanModeHandler, ExitPlanModeResult, UserInputHandler, UserInputResponse};
use github_copilot_sdk::rpc::{ModeSetRequest, PlanSqlTodoDependency, PlanSqlTodosRow, PlanUpdateRequest};
use github_copilot_sdk::session::Session;
use github_copilot_sdk::session_events::SessionMode;
use github_copilot_sdk::subscription::RecvErrorKind;
use github_copilot_sdk::{Attachment, DeliveryMode, MessageOptions};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::commands::screenshot;
use crate::services::copilot::PlanModeHandler;
use crate::services::diagnostics;
use crate::services::emit::emit_chat_event;
use crate::services::history;
use crate::services::store;
use crate::state::{AppState, TurnRoute};
use crate::types::{
  ChatEvent, ChatMessage, ChatOptions, ChatPlanDependency, ChatPlanTodo, ChatToolCall, ChatToolState, ChatTurnResult,
  CopilotModel, SteerResult,
};

const MAX_TOOL_OUTPUT: usize = 4000;
/// Up to this many copilot invocations per turn on a transient pre-work failure.
const MAX_ATTEMPTS: u32 = 3;
/// 1 hour per-turn timeout. Long agent turns (large refactors, multi-step
/// deploys) can legitimately run well past 20 minutes.
const TURN_TIMEOUT_MS: u64 = 60 * 60_000;

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

/// Map the SDK's `session.mode_changed` wire mode (`newMode`) to the renderer's
/// mode string. Unknown/unrecognized values are dropped rather than guessed at.
fn map_sdk_mode(new_mode: &str) -> Option<String> {
  match new_mode {
    "interactive" => Some("agent".to_string()),
    "plan" => Some("plan".to_string()),
    "autopilot" => Some("autopilot".to_string()),
    _ => None,
  }
}

/// Normalize a best-effort SQL todo status into one of the four statuses the
/// renderer understands; unknown/missing values fall back to `"pending"`.
fn normalize_status(status: Option<&str>) -> String {
  match status.map(str::trim).map(str::to_lowercase).as_deref() {
    Some("in_progress") | Some("in-progress") | Some("inprogress") => "in_progress",
    Some("done") | Some("complete") | Some("completed") => "done",
    Some("blocked") => "blocked",
    _ => "pending",
  }
  .to_string()
}

/// Normalize best-effort SQL todo rows + dependency edges (from
/// `readSqlTodosWithDependencies`) into the renderer DTOs. Rows without a
/// nonblank id are dropped (nothing to key them on); a missing/blank title
/// falls back to a nonblank description, then the id itself.
fn normalize_todos(
  rows: Vec<PlanSqlTodosRow>,
  deps: Vec<PlanSqlTodoDependency>,
) -> (Vec<ChatPlanTodo>, Vec<ChatPlanDependency>) {
  let todos = rows
    .into_iter()
    .filter_map(|row| {
      let id = row.id.as_deref().map(str::trim).filter(|s| !s.is_empty())?.to_string();
      let description = row
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
      let title = row
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| description.clone())
        .unwrap_or_else(|| id.clone());
      let status = normalize_status(row.status.as_deref());
      Some(ChatPlanTodo { id, title, description, status })
    })
    .collect();
  let dependencies = deps
    .into_iter()
    .map(|d| ChatPlanDependency { todo_id: d.todo_id, depends_on: d.depends_on })
    .collect();
  (todos, dependencies)
}

/// How the drain loop should treat a raw SDK event with respect to Plan
/// structural state. `session.todos_changed`/`session.plan_changed` are
/// general SDK events (not exclusive to Plan mode); bridging them into
/// `plan-todos`/`plan-content` (RPC reads + chat events) only makes sense for
/// turns that started in Plan mode ([`TurnRoute::plan_context`]) — otherwise
/// they're treated as [`PlanStructuralEvent::Other`] and fall through to the
/// normal `map_event` path (which ignores them).
#[derive(Debug, PartialEq, Eq)]
enum PlanStructuralEvent {
  TodosChanged,
  PlanChanged,
  Other,
}

/// Classify a raw SDK event for the drain loop's Plan-structural handling.
/// `plan_context` gates `TodosChanged`/`PlanChanged` so non-Plan turns never
/// trigger a `plan().read()`/`readSqlTodosWithDependencies()` RPC call.
fn classify_plan_event(event_type: &str, plan_context: bool) -> PlanStructuralEvent {
  match event_type {
    "session.todos_changed" if plan_context => PlanStructuralEvent::TodosChanged,
    "session.plan_changed" if plan_context => PlanStructuralEvent::PlanChanged,
    _ => PlanStructuralEvent::Other,
  }
}

/// Read the session's current SQL todos + dependencies and emit the full
/// snapshot as a `plan-todos` chat event. Best-effort: a read failure is logged
/// and swallowed rather than ending the turn — the next `todos_changed` retries.
async fn emit_plan_todos(session: &Session, app: &AppHandle, project_id: &str, turn_id: &str) {
  match session.rpc().plan().read_sql_todos_with_dependencies().await {
    Ok(result) => {
      let (todos, dependencies) = normalize_todos(result.rows, result.dependencies);
      emit_chat_event(app, project_id, turn_id, ChatEvent::PlanTodos { todos, dependencies });
    }
    Err(e) => log::warn!("failed to read session plan todos: {e}"),
  }
}

/// Read (or, for a delete, skip reading) the session plan file and emit its
/// content as a `plan-content` chat event. Best-effort: a read failure is
/// logged and swallowed rather than ending the turn.
async fn emit_plan_content(session: &Session, app: &AppHandle, project_id: &str, turn_id: &str, operation: &str) {
  if operation == "delete" {
    emit_chat_event(
      app,
      project_id,
      turn_id,
      ChatEvent::PlanContent { content: String::new(), operation: operation.to_string() },
    );
    return;
  }
  match session.rpc().plan().read().await {
    Ok(result) => {
      let content = result.content.unwrap_or_default();
      emit_chat_event(app, project_id, turn_id, ChatEvent::PlanContent { content, operation: operation.to_string() });
    }
    Err(e) => log::warn!("failed to read session plan file: {e}"),
  }
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

/// One tool invocation observed during a turn, accumulated for diagnostics.
struct ToolCallAcc {
  id: String,
  name: String,
  ok: Option<bool>,
  output: Option<String>,
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
  /// When true, capture content (assistant text + tool output) for full
  /// diagnostics. Off by default — only cheap metadata is accumulated.
  capture_full: bool,
  /// Tool calls seen this turn (name + success), for diagnostics.
  tool_calls: Vec<ToolCallAcc>,
  /// Reconstructed assistant response text (full-diagnostics mode only).
  response: Option<String>,
  /// Count of dropped events reported by the subscription (stream lag).
  lagged_events: u64,
  /// True if the event stream closed before a terminal state.
  stream_closed: bool,
}

impl TurnCtx {
  fn new(capture_full: bool) -> Self {
    TurnCtx {
      files_modified: vec![],
      ran_deploy: false,
      saw_result: false,
      saw_activity: false,
      errored: None,
      streamed: HashMap::new(),
      cur_msg: None,
      capture_full,
      tool_calls: vec![],
      response: None,
      lagged_events: 0,
      stream_closed: false,
    }
  }

  /// Record the start of a tool call (metadata always; cheap).
  fn tool_start(&mut self, id: &str, name: &str) {
    self.tool_calls.push(ToolCallAcc {
      id: id.to_string(),
      name: name.to_string(),
      ok: None,
      output: None,
    });
  }

  /// Record a tool call's outcome; capture its output only in full mode.
  fn tool_end(&mut self, id: &str, ok: bool, output: Option<&str>) {
    let full = self.capture_full;
    if let Some(tc) = self.tool_calls.iter_mut().rev().find(|t| t.id == id) {
      tc.ok = Some(ok);
      if full {
        tc.output = output.map(|s| s.to_string());
      }
    }
  }

  /// Append assistant text to the reconstructed response, full mode only, with a
  /// soft cap so a very long turn can't grow the buffer without bound.
  fn push_response(&mut self, text: &str) {
    if !self.capture_full || text.is_empty() {
      return;
    }
    const CAP: usize = 200_000;
    let buf = self.response.get_or_insert_with(String::new);
    if buf.len() < CAP {
      buf.push_str(text);
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
      ctx.push_response(text);
    }
    "assistant.message" => {
      let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
      let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
      let total = content.chars().count();
      let have = *ctx.streamed.get(&id).unwrap_or(&0);
      if total > have {
        ensure_separator(&id, sink, ctx);
        let rest: String = content.chars().skip(have).collect();
        ctx.push_response(&rest);
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
      ctx.tool_start(&id, &tool_name);
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
      ctx.tool_end(&id, success, output.as_deref());
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
    "session.mode_changed" => {
      // Purely a data-mapping event (no RPC needed), so it's handled inline
      // here rather than in the drain loop's async plan_changed/todos_changed path.
      if let Some(mode) = data.get("newMode").and_then(|v| v.as_str()).and_then(map_sdk_mode) {
        sink(ChatEvent::ModeChanged { mode });
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

struct ProjectContext {
  cwd: String,
  session_id: String,
}

/// Resolve the working dir + Copilot session id for a project, creating and
/// persisting a session id on first use. Returns None when the project is gone.
fn resolve_context(project_id: &str) -> Option<ProjectContext> {
  let project = store::find_project(project_id)?;
  let session_id = match project.copilot_session_id {
    Some(s) => s,
    None => {
      let sid = Uuid::new_v4().to_string();
      let stored = sid.clone();
      store::mutate_project(project_id, move |p| p.copilot_session_id = Some(stored));
      sid
    }
  };
  Some(ProjectContext { cwd: project.path, session_id })
}

/// Build and persist a diagnostics record for one completed turn. Best-effort;
/// [`diagnostics::record_turn`] swallows all I/O failures so this can never break
/// a chat. Content fields (`prompt`/`response`/tool output) are included only
/// when `full` is set (the opt-in Settings → Diagnostics toggle).
#[allow(clippy::too_many_arguments)]
fn record_turn_diagnostics(
  app_version: &str,
  session_id: &str,
  project_id: &str,
  turn_id: &str,
  model: &Option<String>,
  mode: &Option<String>,
  effort: &Option<String>,
  prompt: &str,
  attachments: usize,
  full: bool,
  duration_ms: u64,
  attempts: u32,
  outcome: &str,
  error: Option<String>,
  ctx: &TurnCtx,
) {
  let rec = diagnostics::TurnDiagnostics {
    time: chrono::Utc::now().to_rfc3339(),
    app_version: app_version.to_string(),
    os: std::env::consts::OS.to_string(),
    project_id: project_id.to_string(),
    turn_id: turn_id.to_string(),
    session_id: session_id.to_string(),
    model: model.clone(),
    mode: mode.clone(),
    effort: effort.clone(),
    duration_ms,
    attempts,
    attachments,
    files_modified: ctx.files_modified.len(),
    ran_deploy: ctx.ran_deploy,
    outcome: outcome.to_string(),
    error: error.map(|e| diagnostics::clip(&e)),
    lagged_events: ctx.lagged_events,
    stream_closed: ctx.stream_closed,
    tools: ctx
      .tool_calls
      .iter()
      .map(|t| diagnostics::ToolDiag {
        name: t.name.clone(),
        ok: t.ok.unwrap_or(false),
        output: t.output.clone(),
      })
      .collect(),
    prompt: if full { Some(diagnostics::clip(prompt)) } else { None },
    response: if full {
      ctx.response.as_deref().map(diagnostics::clip)
    } else {
      None
    },
  };
  diagnostics::record_turn(&rec);
}

#[tauri::command]
pub async fn chat_send(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
  turn_id: String,
  text: String,
  attachments: Option<Vec<String>>,
  mode: Option<String>,
) -> Result<ChatTurnResult, String> {
  run_turn(app, state.inner(), project_id, turn_id, text, attachments, mode).await
}

/// The turn engine behind `chat_send`. Drives one Copilot invocation and streams
/// its events to `(project_id, turn_id)`. Always resolves to `Ok` — failures
/// surface inside the [`ChatTurnResult`].
pub(crate) async fn run_turn(
  app: AppHandle,
  state: &AppState,
  project_id: String,
  turn_id: String,
  text: String,
  attachments: Option<Vec<String>>,
  mode: Option<String>,
) -> Result<ChatTurnResult, String> {
  let attachments = attachments.unwrap_or_default();

  let Some(project) = store::find_project(&project_id) else {
    emit_chat_event(&app, &project_id, &turn_id, ChatEvent::Error { text: "Project not found.".into() });
    screenshot::cleanup(&attachments);
    return Ok(ChatTurnResult {
      ok: false,
      error: Some("Project not found.".into()),
      files_modified: vec![],
      ran_deploy: false,
    });
  };

  let Some(ctx_info) = resolve_context(&project_id) else {
    emit_chat_event(&app, &project_id, &turn_id, ChatEvent::Error { text: "Project not found.".into() });
    screenshot::cleanup(&attachments);
    return Ok(ChatTurnResult {
      ok: false,
      error: Some("Project not found.".into()),
      files_modified: vec![],
      ran_deploy: false,
    });
  };

  // Guard against two concurrent turns on the same project.
  let Some(token) = state.try_begin_chat(&project_id) else {
    emit_chat_event(
      &app,
      &project_id,
      &turn_id,
      ChatEvent::Error { text: "A message is already being processed for this project.".into() },
    );
    return Ok(ChatTurnResult {
      ok: false,
      error: Some("Turn already running.".into()),
      files_modified: vec![],
      ran_deploy: false,
    });
  };

  // Diagnostics context, captured once per turn (cheap): a monotonic start for
  // duration, whether the user opted into full (content) capture, and the app
  // version for the record. Read here so a session-open failure is also recorded.
  let started = std::time::Instant::now();
  let full = diagnostics::full_enabled();
  let app_version = app.package_info().version.to_string();

  // Surface plan-approval prompts (`exit_plan_mode`) and structured questions
  // (`ask_user`) to this turn's UI. Both are backed by the same handler/gate and
  // installed on every chat turn (cheap, harmless when neither fires) because the
  // SDK session is cached/reused and may switch to Plan (or call `ask_user`) on a
  // later turn.
  let bridge = Arc::new(PlanModeHandler::new(app.clone(), state.plan.clone()));
  let plan_handler: Arc<dyn ExitPlanModeHandler> = bridge.clone();
  let user_input_handler: Arc<dyn UserInputHandler> = bridge;

  // Build Fabricator's in-process tools for this turn. They let the agent locate
  // and wire semantic models; visual validation happens via headless `npm run
  // preview` and Fabricator auto-deploys after the turn.
  let fab_tools = crate::services::agent_tools::fabricator_tools(app.clone(), project_id.clone());

  // Open (or resume) this project's persistent SDK session, reconciling model/effort.
  let session = match state
    .copilot
    .turn_session(
      &project_id,
      &ctx_info.cwd,
      &ctx_info.session_id,
      project.model.clone(),
      project.effort.clone(),
      Some(plan_handler),
      Some(user_input_handler),
      fab_tools,
    )
    .await
  {
    Ok(s) => s,
    Err(e) => {
      emit_chat_event(&app, &project_id, &turn_id, ChatEvent::Error { text: e.clone() });
      screenshot::cleanup(&attachments);
      state.end_chat(&project_id);
      let empty = TurnCtx::new(full);
      record_turn_diagnostics(
        &app_version,
        &ctx_info.session_id,
        &project_id,
        &turn_id,
        &project.model,
        &mode,
        &project.effort,
        &text,
        attachments.len(),
        full,
        started.elapsed().as_millis() as u64,
        0,
        "error",
        Some(e.clone()),
        &empty,
      );
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
  // `plan_context` records whether this turn was started in Plan mode:
  // `UserInputHandler` uses it to route an `ask_user` question into the Plan
  // artifact (`plan-question`) for Plan-mode turns, or a standalone question
  // card (`agent-question`) for Agent-mode turns. It stays fixed for the whole
  // route (i.e. through an approved Plan continuation into Autopilot/Interactive),
  // since the route isn't replaced again until the turn ends.
  let session_key = ctx_info.session_id.clone();
  let plan_context = mode.as_deref() == Some("plan");
  state.plan.set_route(
    &session_key,
    TurnRoute { project_id: project_id.clone(), turn_id: turn_id.clone(), plan_context },
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

  let mut ctx = TurnCtx::new(full);
  let mut cancelled = false;
  let mut timed_out = false;
  let mut send_error: Option<String> = None;
  let mut attempt: u32 = 1;

  loop {
    if attempt > 1 {
      ctx = TurnCtx::new(full);
      cancelled = false;
      timed_out = false;
    }

    // Subscribe before sending so the turn's events can't be missed.
    let mut sub = session.subscribe();
    // Coalesces bursts of `session.todos_changed` signals (no payload; a bulk
    // todo-table write can fire many in a row) into one `readSqlTodosWithDependencies`
    // RPC + `plan-todos` emit, flushed right before the next distinct event so
    // relative event order is preserved.
    let mut todos_dirty = false;

    let mut opts = MessageOptions::new(text.clone());
    if !attach.is_empty() {
      opts = opts.with_attachments(attach.clone());
    }
    if let Err(e) = session.send(opts).await {
      send_error = Some(e.to_string());
      break;
    }

    // Drain events until the session goes idle / errors, while honouring the stop
    // button (→ `session.abort()`) and a 1-hour per-turn cap.
    let drain = async {
      loop {
        if token.is_cancelled() {
          if todos_dirty {
            emit_plan_todos(&session, &app, &project_id, &turn_id).await;
            todos_dirty = false;
          }
          let _ = session.abort().await;
          return DrainEnd::Cancelled;
        }
        tokio::select! {
          _ = token.wait_cancelled() => {
            if todos_dirty {
              emit_plan_todos(&session, &app, &project_id, &turn_id).await;
              todos_dirty = false;
            }
            let _ = session.abort().await;
            return DrainEnd::Cancelled;
          }
          recv = sub.recv() => match recv {
            Ok(ev) => match classify_plan_event(&ev.event_type, plan_context) {
              // Signal-only (no payload): defer the actual read/emit until the
              // burst settles (see `todos_dirty` above).
              PlanStructuralEvent::TodosChanged => {
                todos_dirty = true;
              }
              PlanStructuralEvent::PlanChanged => {
                if todos_dirty {
                  emit_plan_todos(&session, &app, &project_id, &turn_id).await;
                  todos_dirty = false;
                }
                let operation = ev.data.get("operation").and_then(|v| v.as_str()).unwrap_or("update");
                emit_plan_content(&session, &app, &project_id, &turn_id, operation).await;
              }
              PlanStructuralEvent::Other => {
                if todos_dirty {
                  emit_plan_todos(&session, &app, &project_id, &turn_id).await;
                  todos_dirty = false;
                }
                let mut sink = |e: ChatEvent| emit_chat_event(&app, &project_id, &turn_id, e);
                if let Flow::Stop = map_event(&ev.event_type, &ev.data, &mut sink, &mut ctx) {
                  return DrainEnd::Finished;
                }
              }
            },
            Err(err) => match err.kind() {
              RecvErrorKind::Lagged(l) => {
                ctx.lagged_events += l.skipped();
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
      Ok(DrainEnd::Finished) => {}
      Ok(DrainEnd::Closed) => ctx.stream_closed = true,
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
      &turn_id,
      ChatEvent::Notice { text: format!("Copilot hiccup — retrying ({}/{})…", attempt, MAX_ATTEMPTS - 1) },
    );
    tokio::time::sleep(Duration::from_millis(attempt as u64 * 1000)).await;
    attempt += 1;
  }

  screenshot::cleanup(&attachments);
  state.end_chat(&project_id);
  // Drop this turn's plan route and unblock any handler still awaiting a decision
  // (covers Stop / timeout while an approval card or a structured question is open).
  state.plan.clear_route(&session_key);
  state.plan.reject_pending_plan(&session_key);
  state.plan.reject_pending_question(&session_key);

  // Record one lightweight diagnostics line for this turn (off the streaming hot
  // path, best-effort). `outcome` mirrors the branches below.
  let outcome = if send_error.is_some() {
    "send_error"
  } else if cancelled {
    "cancelled"
  } else if timed_out {
    "timed_out"
  } else if ctx.errored.is_some() {
    "error"
  } else if ctx.saw_result {
    "ok"
  } else {
    "incomplete"
  };
  record_turn_diagnostics(
    &app_version,
    &ctx_info.session_id,
    &project_id,
    &turn_id,
    &project.model,
    &mode,
    &project.effort,
    &text,
    attachments.len(),
    full,
    started.elapsed().as_millis() as u64,
    attempt,
    outcome,
    send_error.clone().or_else(|| ctx.errored.clone()),
    &ctx,
  );

  if let Some(e) = send_error {
    emit_chat_event(&app, &project_id, &turn_id, ChatEvent::Error { text: e.clone() });
    emit_chat_event(
      &app,
      &project_id,
      &turn_id,
      ChatEvent::Result { ok: false, files_modified: vec![], ran_deploy: ctx.ran_deploy },
    );
    return Ok(ChatTurnResult { ok: false, error: Some(e), files_modified: vec![], ran_deploy: ctx.ran_deploy });
  }

  let ok = ctx.saw_result && ctx.errored.is_none() && !cancelled && !timed_out;
  // `session.error` already emitted its own Error; cancellation is user-initiated.
  if !ok && !cancelled && ctx.errored.is_none() {
    let detail = if timed_out {
      "Copilot timed out after an hour.".to_string()
    } else {
      "Copilot ended unexpectedly.".to_string()
    };
    emit_chat_event(&app, &project_id, &turn_id, ChatEvent::Error { text: detail });
  }

  emit_chat_event(
    &app,
    &project_id,
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
pub fn chat_cancel(state: State<'_, AppState>, project_id: String) {
  state.cancel_chat(&project_id);
}

/// Interject a message into the turn already running for `project` —
/// conversation steering. Returns `{ steered: true }` when a turn was in flight:
/// the message either interrupts the current step immediately (Immediate
/// delivery), answers a pending structured question (when it accepts a
/// free-form answer), or, when a Plan card is awaiting a decision, is routed as
/// plan-revision feedback. Returns `{ steered: false }` when nothing is running,
/// so the renderer sends it as a normal new turn instead.
#[tauri::command]
pub async fn chat_steer(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
  text: String,
  attachments: Option<Vec<String>>,
) -> Result<SteerResult, String> {
  let attachments = attachments.unwrap_or_default();

  // Nothing running → let the caller start a normal turn.
  if !state.is_chat_running(&project_id) {
    return Ok(SteerResult { steered: false });
  }
  let Some(ctx_info) = resolve_context(&project_id) else {
    return Ok(SteerResult { steered: false });
  };
  // Where the live turn is streaming, so any plan/question card dismisses on
  // the right turn.
  let active_turn = state.plan.route(&ctx_info.session_id).map(|r| r.turn_id);

  // Plan mode: a plan card is awaiting the user's decision, so the agent is
  // blocked on that choice rather than "thinking". Treat the typed message as
  // feedback that asks it to revise the plan instead of an immediate interjection.
  if let Some(request_id) = state.plan.pending_plan_request(&ctx_info.session_id) {
    if let Some(turn) = &active_turn {
      emit_chat_event(&app, &project_id, turn, ChatEvent::PlanResolved { request_id: request_id.clone() });
    }
    state.plan.resolve_plan(
      &request_id,
      ExitPlanModeResult { approved: false, selected_action: None, feedback: Some(text) },
    );
    screenshot::cleanup(&attachments);
    return Ok(SteerResult { steered: true });
  }

  // A structured `ask_user` question is awaiting an answer. Only consume the
  // typed message as its answer when the question accepts a free-form reply —
  // otherwise leave it pending for the renderer's own choice UI and fall
  // through to a normal interjection.
  if let Some((request_id, allow_freeform)) = state.plan.pending_question(&ctx_info.session_id) {
    if allow_freeform {
      // Mirror `chat_resolve_question`: only emit `plan-question-resolved` once
      // the pending oneshot has actually resolved, so a dropped receiver (the
      // turn ending in the same race) can't render an answered card.
      let resolved = state
        .plan
        .resolve_question(&request_id, Some(UserInputResponse { answer: text.clone(), was_freeform: true }));
      if resolved {
        if let Some(turn) = &active_turn {
          emit_chat_event(
            &app,
            &project_id,
            turn,
            ChatEvent::PlanQuestionResolved { request_id: request_id.clone(), answer: Some(text.clone()) },
          );
        }
      }
      screenshot::cleanup(&attachments);
      return Ok(SteerResult { steered: true });
    }
  }

  // Normal interjection: deliver the message Immediately so it interrupts the
  // current step. The in-flight `run_turn` drain loop streams the resulting
  // events to the same turn, so we take no new turn lock here.
  let Some(session) = state.copilot.peek_session(&project_id).await else {
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
      emit_chat_event(&app, &project_id, turn, ChatEvent::Error { text: format!("Couldn't interject: {e}") });
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
pub async fn chat_reset(state: State<'_, AppState>, project_id: String) -> Result<(), String> {
  // Stop any in-flight turn first (mirrors chat.ts resetSession → cancelMessage).
  state.cancel_chat(&project_id);
  // Drop the cached SDK session so the next turn starts a brand-new conversation.
  state.copilot.forget(&project_id).await;
  history::clear_history(&project_id);
  store::mutate_project(&project_id, |p| p.copilot_session_id = None);
  Ok(())
}

#[tauri::command]
pub fn chat_history(project_id: String) -> Vec<ChatMessage> {
  history::load_history(&project_id)
}

/// Sanitize a user-suggested export filename: keep letters, digits, spaces,
/// `_`/`-`; everything else becomes `-`. Falls back to `"plan"` when nothing
/// usable remains (e.g. an all-emoji summary).
fn sanitize_export_name(input: &str) -> String {
  let mapped: String = input
    .chars()
    .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ' ' { c } else { '-' })
    .collect();
  let trimmed = mapped.trim().trim_matches('-').trim();
  if trimmed.is_empty() {
    "plan".to_string()
  } else {
    trimmed.to_string()
  }
}

/// Resolve a pending Plan-mode approval prompt raised via `exit_plan_mode`.
/// `action` is one of "interactive" | "autopilot" | "autopilot_fleet" | "exit_only"
/// (approve and continue with that route) — anything else (e.g. "keep_planning")
/// rejects the plan so the agent revises it, optionally using `feedback`.
///
/// Before resolving, writes `plan_content` back to the session's plan file via
/// `session.plan.update` (the user may have edited the card). Validates that
/// `request_id` is still pending *for this project*, and that the update RPC
/// succeeds, before ever touching the pending oneshot — a failure here leaves
/// the prompt outstanding rather than silently discarding the user's edits.
#[tauri::command]
pub async fn chat_resolve_plan(
  state: State<'_, AppState>,
  project_id: String,
  request_id: String,
  action: String,
  plan_content: String,
  feedback: Option<String>,
) -> Result<(), String> {
  let owner = state.plan.plan_owner(&request_id).ok_or_else(|| "No pending plan to resolve.".to_string())?;
  if owner.project_id != project_id {
    return Err("That plan request doesn't belong to this project.".into());
  }
  let session = state
    .copilot
    .peek_session(&project_id)
    .await
    .ok_or_else(|| "No active Copilot session for this project.".to_string())?;
  session
    .rpc()
    .plan()
    .update(PlanUpdateRequest { content: plan_content })
    .await
    .map_err(|e| format!("Failed to update the plan: {e}"))?;

  let result = match action.as_str() {
    "interactive" | "autopilot" | "autopilot_fleet" | "exit_only" => {
      ExitPlanModeResult { approved: true, selected_action: Some(action), feedback }
    }
    _ => ExitPlanModeResult { approved: false, selected_action: None, feedback },
  };
  if state.plan.resolve_plan(&request_id, result) {
    Ok(())
  } else {
    Err("No pending plan to resolve.".into())
  }
}

/// Resolve a pending structured question raised via the `ask_user` tool.
/// Rejects an empty/whitespace-only answer, and rejects `was_freeform: true`
/// when the question doesn't accept a free-form reply. Only emits
/// `plan-question-resolved` to the question's turn *after* the pending oneshot
/// resolves successfully — if the receiver was already dropped (e.g. the turn
/// ended), we return `Err` without telling the renderer the card was answered.
#[tauri::command]
pub fn chat_resolve_question(
  app: AppHandle,
  state: State<'_, AppState>,
  request_id: String,
  answer: String,
  was_freeform: bool,
) -> Result<(), String> {
  let trimmed = answer.trim();
  if trimmed.is_empty() {
    return Err("An answer is required.".into());
  }
  let owner = state
    .plan
    .question_owner(&request_id)
    .ok_or_else(|| "No pending question to resolve.".to_string())?;
  if was_freeform && !owner.allow_freeform {
    return Err("This question doesn't accept a free-form answer.".into());
  }
  if !state
    .plan
    .resolve_question(&request_id, Some(UserInputResponse { answer: trimmed.to_string(), was_freeform }))
  {
    return Err("No pending question to resolve.".into());
  }
  emit_chat_event(
    &app,
    &owner.project_id,
    &owner.turn_id,
    ChatEvent::PlanQuestionResolved { request_id: request_id.clone(), answer: Some(trimmed.to_string()) },
  );
  Ok(())
}

#[tauri::command]
pub fn chat_save_history(project_id: String, messages: Vec<ChatMessage>) {
  history::save_history(&project_id, messages);
}

/// Export a plan's Markdown content via the OS's native "Save As" dialog.
/// Returns `Ok(None)` when the user cancels; writes UTF-8 to disk only after a
/// destination is chosen — the project tree is never touched automatically.
#[tauri::command]
pub async fn chat_export_plan(app: AppHandle, suggested_name: String, content: String) -> Result<Option<String>, String> {
  let file_name = format!("{}.md", sanitize_export_name(&suggested_name));
  let (tx, rx) = tokio::sync::oneshot::channel();
  app
    .dialog()
    .file()
    .add_filter("Markdown", &["md"])
    .set_file_name(file_name)
    .save_file(move |picked| {
      let _ = tx.send(picked);
    });
  let Some(picked) = rx.await.ok().flatten() else {
    return Ok(None);
  };
  let Some(path) = picked.into_path().ok() else {
    return Ok(None);
  };
  std::fs::write(&path, content.as_bytes()).map_err(|e| format!("Couldn't save the plan: {e}"))?;
  Ok(Some(path.display().to_string()))
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
    let mut ctx = TurnCtx::new(false);
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
    let mut ctx = TurnCtx::new(false);
    let flow = map_event("session.idle", &json!({}), &mut |_e: ChatEvent| {}, &mut ctx);
    assert!(matches!(flow, Flow::Stop));
    assert!(ctx.saw_result);
  }

  #[test]
  fn session_error_emits_error_and_stops() {
    let mut ctx = TurnCtx::new(false);
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
    let mut ctx = TurnCtx::new(false);
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
    let mut ctx = TurnCtx::new(false);
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
    let mut ctx = TurnCtx::new(false);
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
    let mut ctx = TurnCtx::new(false);
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
    let mut ctx = TurnCtx::new(false);
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
    let mut ctx = TurnCtx::new(false);
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

  #[test]
  fn map_sdk_mode_maps_known_wire_values() {
    assert_eq!(map_sdk_mode("interactive").as_deref(), Some("agent"));
    assert_eq!(map_sdk_mode("plan").as_deref(), Some("plan"));
    assert_eq!(map_sdk_mode("autopilot").as_deref(), Some("autopilot"));
    assert_eq!(map_sdk_mode("something_else"), None);
    assert_eq!(map_sdk_mode(""), None);
  }

  #[test]
  fn classify_plan_event_bridges_structural_events_only_in_plan_context() {
    // In a Plan-mode turn, both structural events are bridged.
    assert_eq!(classify_plan_event("session.todos_changed", true), PlanStructuralEvent::TodosChanged);
    assert_eq!(classify_plan_event("session.plan_changed", true), PlanStructuralEvent::PlanChanged);
    // In an ordinary Agent/Autopilot turn, the same events are general SDK
    // signals (not exclusive to Plan mode) and must NOT trigger an RPC
    // read/emit — they fall through to `Other` (→ `map_event`, which ignores
    // them) instead.
    assert_eq!(classify_plan_event("session.todos_changed", false), PlanStructuralEvent::Other);
    assert_eq!(classify_plan_event("session.plan_changed", false), PlanStructuralEvent::Other);
    // Unrelated event types are always `Other`, regardless of plan_context.
    assert_eq!(classify_plan_event("session.idle", true), PlanStructuralEvent::Other);
    assert_eq!(classify_plan_event("session.idle", false), PlanStructuralEvent::Other);
  }

  #[test]
  fn mode_changed_event_maps_new_mode_to_chat_event() {
    let mut ctx = TurnCtx::new(false);
    let events = collect(&[("session.mode_changed", json!({"newMode":"plan","previousMode":"interactive"}))], &mut ctx);
    assert_eq!(events.len(), 1);
    match &events[0] {
      ChatEvent::ModeChanged { mode } => assert_eq!(mode, "plan"),
      _ => panic!("expected mode-changed"),
    }
  }

  #[test]
  fn mode_changed_event_drops_unknown_mode() {
    let mut ctx = TurnCtx::new(false);
    let events = collect(&[("session.mode_changed", json!({"newMode":"mystery"}))], &mut ctx);
    assert!(events.is_empty());
  }

  #[test]
  fn normalize_status_maps_known_variants_and_defaults_unknown_to_pending() {
    assert_eq!(normalize_status(Some("in_progress")), "in_progress");
    assert_eq!(normalize_status(Some("in-progress")), "in_progress");
    assert_eq!(normalize_status(Some("InProgress")), "in_progress");
    assert_eq!(normalize_status(Some("done")), "done");
    assert_eq!(normalize_status(Some("complete")), "done");
    assert_eq!(normalize_status(Some("completed")), "done");
    assert_eq!(normalize_status(Some("blocked")), "blocked");
    assert_eq!(normalize_status(Some("pending")), "pending");
    assert_eq!(normalize_status(Some("whatever")), "pending");
    assert_eq!(normalize_status(None), "pending");
  }

  #[test]
  fn normalize_todos_drops_blank_or_missing_ids() {
    let rows = vec![
      PlanSqlTodosRow {
        id: Some("t1".into()),
        title: Some("Do the thing".into()),
        description: None,
        status: Some("done".into()),
      },
      PlanSqlTodosRow { id: None, title: Some("orphaned".into()), description: None, status: None },
      PlanSqlTodosRow { id: Some("  ".into()), title: Some("blank id".into()), description: None, status: None },
    ];
    let (todos, deps) = normalize_todos(rows, vec![]);
    assert_eq!(todos.len(), 1);
    assert_eq!(todos[0].id, "t1");
    assert_eq!(todos[0].title, "Do the thing");
    assert_eq!(todos[0].status, "done");
    assert!(deps.is_empty());
  }

  #[test]
  fn normalize_todos_title_falls_back_to_description_then_id() {
    let rows = vec![
      PlanSqlTodosRow { id: Some("t1".into()), title: None, description: Some("desc only".into()), status: None },
      PlanSqlTodosRow { id: Some("t2".into()), title: Some("   ".into()), description: None, status: None },
      PlanSqlTodosRow {
        id: Some("t3".into()),
        title: Some("   ".into()),
        description: Some("   ".into()),
        status: None,
      },
    ];
    let (todos, _deps) = normalize_todos(rows, vec![]);
    assert_eq!(todos[0].title, "desc only");
    assert_eq!(todos[0].description.as_deref(), Some("desc only"));
    assert_eq!(todos[1].title, "t2");
    assert_eq!(todos[1].description, None);
    // Blank title AND blank description both fall back to the id.
    assert_eq!(todos[2].title, "t3");
    assert_eq!(todos[2].description, None);
  }

  #[test]
  fn normalize_todos_maps_dependencies() {
    let deps = vec![PlanSqlTodoDependency { todo_id: "t2".into(), depends_on: "t1".into() }];
    let (_todos, mapped) = normalize_todos(vec![], deps);
    assert_eq!(mapped.len(), 1);
    assert_eq!(mapped[0].todo_id, "t2");
    assert_eq!(mapped[0].depends_on, "t1");
  }

  #[test]
  fn sanitize_export_name_replaces_unsafe_chars_and_falls_back() {
    assert_eq!(sanitize_export_name("My Plan / v2?"), "My Plan - v2");
    assert_eq!(sanitize_export_name("  "), "plan");
    assert_eq!(sanitize_export_name("💥💥"), "plan");
    assert_eq!(sanitize_export_name("normal-name_1"), "normal-name_1");
  }
}

