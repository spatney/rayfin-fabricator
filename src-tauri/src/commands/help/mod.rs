//! The Help assistant: a full-screen, read-only agent that debugs the user's
//! problem using what actually happened on their machine.
//!
//! It is deliberately *not* a second Build chat. It can't change anything —
//! mutating and shell tools are excluded and the permission policy denies every
//! write — and it is pointed at a different set of facts:
//!
//! * the **activity journal** (`services::journal`), which records what the app
//!   did — successes as well as failures — so "why did that fail?" and "how did
//!   that go?" both have real answers;
//! * the **published documentation**, mirrored locally, for how things are meant
//!   to work;
//! * the **release notes**, mirrored locally, for what changed in each version;
//! * **Fabricator's own source**, pinned to the running release, so a symptom
//!   can be traced to its cause;
//! * the user's **project**, and anything they attach.
//!
//! The source is evidence only. `prompt.rs` forbids showing it, naming internal
//! symbols, or proposing changes to Fabricator itself — the user is running an
//! installed app, so the only useful answer is one phrased in terms of the UI.

mod context;
mod prompt;
mod tools;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use github_copilot_sdk::handler::{PermissionHandler, PermissionResult};
use github_copilot_sdk::{MessageOptions, PermissionRequestData, RequestId, SessionId};
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::advisor::{drain, DrainEnd};
use crate::commands::chat_tools;
use crate::services::copilot::SessionOptions;
use crate::services::emit::emit_help_event;
use crate::services::journal::{self, Area, Level};
use crate::services::{exec::CancelToken, grounding, help_session};
use crate::state::AppState;
use crate::types::{
  ChatToolCall, ChatToolState, HelpAnswer, HelpAskRequest, HelpEvent, HelpGrounding, HelpTurn,
};

use context::HelpContext;
use tools::{SharedArtifacts, ToolContext, TurnArtifacts};

/// Ceiling for one Help answer.
const TURN_TIMEOUT_MS: u64 = 4 * 60_000;
/// Output kept per activity step in the work log.
const MAX_ACTIVITY_OUTPUT: usize = 1200;
/// Longest question accepted, so a pasted log can't blow past the context window.
const MAX_QUESTION: usize = 16_000;
/// Most files/folders the user may attach to one question.
const MAX_ATTACHMENTS: usize = 20;

/// How many earlier exchanges are replayed into a new question. A resumed
/// conversation can be long, and the useful context for "that didn't work" is
/// the last few turns, not everything since yesterday.
const MAX_REPLAYED_TURNS: usize = 6;

/// The message a stopped turn returns. The renderer matches on it to tell a
/// deliberate stop apart from a failure, so both sides share the constant.
pub const STOPPED: &str = "Stopped.";

/// Documentation hosts the assistant may fetch when the local mirror is stale.
const ALLOWED_URL_HOSTS: &[&str] = &[
  "spatney.github.io",
  "rayfin.ai",
  "www.rayfin.ai",
];

/// Where Fabricator's documentation lives on `spatney.github.io`, which hosts
/// many unrelated projects. A link there must be inside this project.
const DOCS_PATH_PREFIX: &str = "/rayfin-fabricator";

/// Where Fabricator's releases are published on `github.com`, which hosts
/// everyone's projects. These pages are the only ones reachable there.
const RELEASES_PATH: &str = "/spatney/rayfin-fabricator/releases";

/// Built-in tools the assistant must not use. The permission policy enforces
/// read-only regardless; excluding them stops the model from trying.
const EXCLUDED_TOOLS: &[&str] = &[
  "edit",
  "create",
  "apply_patch",
  "write",
  "write_file",
  "multi_edit",
  "str_replace",
  "str_replace_editor",
  "insert",
  "powershell",
  "bash",
  "shell",
  "read_powershell",
  "write_powershell",
  "stop_powershell",
  "list_powershell",
  "read_bash",
  "write_bash",
  "stop_bash",
  "list_bash",
  "task",
  "read_agent",
  "write_agent",
  "list_agents",
  "run_factory",
  "factories_manage",
  "manage_schedule",
  "web_search",
  "ask_user",
  "exit_plan_mode",
  "store_memory",
  "vote_memory",
  "sql",
];

/* ----------------------------- read-only policy ----------------------------- */

/// The host and path of an `https` URL, or `None` if it isn't one.
///
/// Parsed rather than prefix-matched: `https://rayfin.ai.evil.example/` and
/// `https://rayfin.ai@evil.example/` both *start with* an allowed host but are
/// served by an attacker's. Userinfo and the port are stripped, matching
/// [`crate::commands::advisor`]'s treatment of the same problem. A backslash is
/// refused outright: browsers read it as `/`, so `https://evil.example\@rayfin.ai/`
/// opens `evil.example` even though it appears to name `rayfin.ai`.
fn split_https(url: &str) -> Option<(String, String)> {
  if url.contains('\\') {
    return None;
  }
  let rest = url.trim().strip_prefix("https://")?;
  let (authority, path) = match rest.find(['/', '?', '#']) {
    Some(at) => (&rest[..at], &rest[at..]),
    None => (rest, "/"),
  };
  let host = authority.rsplit('@').next().unwrap_or(authority);
  let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
  if host.is_empty() {
    return None;
  }
  Some((host, path.to_string()))
}

/// Whether the agent may fetch `url`: the documentation hosts, for when the
/// local mirror is stale, and Fabricator's release pages, for when the mirrored
/// release notes don't have the version being asked about.
fn url_allowed(url: &str) -> bool {
  split_https(url).is_some_and(|(host, _)| ALLOWED_URL_HOSTS.contains(&host.as_str()))
    || release_notes_url(url)
}

/// Whether `url` is one of Fabricator's release pages on GitHub: the list of
/// releases, the latest one, or one release by its tag.
///
/// Matched exactly rather than by prefix, because `github.com` serves everyone:
/// `…/releases/tag/../../../someone-else` must not pass, so a tag is limited to
/// the characters a version tag uses.
pub(super) fn release_notes_url(url: &str) -> bool {
  let Some((host, path)) = split_https(url) else {
    return false;
  };
  let path = path.split(['?', '#']).next().unwrap_or_default();
  let Some(rest) = path.strip_prefix(RELEASES_PATH) else {
    return false;
  };
  host == "github.com"
    && match rest {
      "" | "/" | "/latest" => true,
      _ => rest.strip_prefix("/tag/").is_some_and(|tag| {
        tag.chars().any(|c| c.is_ascii_alphanumeric())
          && !tag.contains("..")
          && tag.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
      }),
    }
}

/// Whether `url` is a documentation page the assistant may link the user to.
///
/// Stricter than [`url_allowed`]: these URLs are opened in the user's real
/// browser, and the model that produces them has read untrusted input (the
/// error journal, project files, attachments), so a citation must be a page we
/// actually publish.
pub(super) fn docs_url_allowed(url: &str) -> bool {
  let Some((host, path)) = split_https(url) else {
    return false;
  };
  match host.as_str() {
    "spatney.github.io" => path == DOCS_PATH_PREFIX || path.starts_with(&format!("{DOCS_PATH_PREFIX}/")),
    "rayfin.ai" | "www.rayfin.ai" => true,
    _ => false,
  }
}

/// [`docs_url_allowed`], restricted to Fabricator's own documentation. Used by
/// the `open-docs` action, which must not send the user to Rayfin's site.
pub(super) fn fabricator_docs_url(url: &str) -> bool {
  split_https(url).is_some_and(|(host, path)| {
    host == "spatney.github.io"
      && (path == DOCS_PATH_PREFIX || path.starts_with(&format!("{DOCS_PATH_PREFIX}/")))
  })
}

/// Whether `path` sits inside any readable root. Relative paths resolve against
/// the session's working directory.
fn path_allowed(roots: &[PathBuf], cwd: &Path, path: &str) -> bool {
  let p = Path::new(path);
  let joined = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
  let target = crate::commands::util::normalize(&joined);
  roots.iter().any(|root| target.starts_with(crate::commands::util::normalize(root)))
}

/// Files whose contents are secrets. The assistant never needs their values,
/// and a user debugging a sign-in problem shouldn't have them read aloud.
fn is_secret_file(path: &str) -> bool {
  let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_ascii_lowercase();
  if name == ".env" || name.starts_with(".env.") {
    const TEMPLATES: &[&str] = &[".example", ".sample", ".template", ".defaults", ".dist"];
    return !TEMPLATES.iter().any(|t| name.ends_with(t));
  }
  matches!(name.as_str(), ".envrc" | ".npmrc" | ".netrc" | ".pypirc" | "id_rsa" | "id_ecdsa" | "id_ed25519")
    || [".pem", ".key", ".pfx", ".p12"].iter().any(|ext| name.ends_with(ext))
}

/// Answers the session's permission requests. Fails closed: anything
/// unrecognized, and any sandbox-bypass request, is denied.
struct HelpPolicy {
  roots: Vec<PathBuf>,
  cwd: PathBuf,
}

impl HelpPolicy {
  fn permits(&self, data: &PermissionRequestData) -> bool {
    let body = request_body(data);
    let text = |key: &str| body.get(key).and_then(Value::as_str);
    if body.get("requestSandboxBypass").and_then(Value::as_bool) == Some(true) {
      return false;
    }
    match request_kind(data).as_deref() {
      Some("read") => {
        text("path").is_some_and(|p| path_allowed(&self.roots, &self.cwd, p) && !is_secret_file(p))
      }
      Some("url") => text("url").is_some_and(url_allowed),
      Some("custom-tool") => true,
      _ => false,
    }
  }
}

/// The permission request itself; the runtime nests it under `permissionRequest`.
fn request_body(data: &PermissionRequestData) -> &Value {
  data.extra.get("permissionRequest").filter(|v| v.is_object()).unwrap_or(&data.extra)
}

fn request_kind(data: &PermissionRequestData) -> Option<String> {
  request_body(data).get("kind").and_then(Value::as_str).map(str::to_string).or_else(|| {
    use github_copilot_sdk::PermissionRequestKind;
    Some(
      match data.kind.as_ref()? {
        PermissionRequestKind::Read => "read",
        PermissionRequestKind::Url => "url",
        PermissionRequestKind::CustomTool => "custom-tool",
        PermissionRequestKind::Mcp => "mcp",
        _ => "other",
      }
      .to_string(),
    )
  })
}

#[async_trait]
impl PermissionHandler for HelpPolicy {
  async fn handle(&self, _: SessionId, _: RequestId, data: PermissionRequestData) -> PermissionResult {
    if self.permits(&data) {
      return PermissionResult::approve_once();
    }
    log::info!("Help assistant denied a {} request", request_kind(&data).unwrap_or_else(|| "unknown".into()));
    // `reject` reads as the user declining and ends the whole turn; "no user
    // available" fails only this call, so the answer carries on.
    PermissionResult::user_not_available()
  }
}

/* ----------------------------- streaming ----------------------------- */

/// Reassembles the answer text across streaming deltas and terminal messages.
#[derive(Default)]
struct Answer {
  text: String,
  /// Characters of each message already emitted, so the terminal
  /// `assistant.message` doesn't duplicate what the deltas already sent.
  streamed: std::collections::HashMap<String, usize>,
  errored: Option<String>,
}

impl Answer {
  /// Take one event; returns newly produced text, if any.
  fn feed(&mut self, event_type: &str, data: &Value) -> Option<String> {
    let id = || data.get("messageId").and_then(Value::as_str).unwrap_or("").to_string();
    match event_type {
      "assistant.message_delta" => {
        let text = data.get("deltaContent").and_then(Value::as_str).unwrap_or("");
        if text.is_empty() {
          return None;
        }
        *self.streamed.entry(id()).or_insert(0) += text.chars().count();
        self.text.push_str(text);
        Some(text.to_string())
      }
      "assistant.message" => {
        let content = data.get("content").and_then(Value::as_str).unwrap_or("");
        let total = content.chars().count();
        let key = id();
        let have = *self.streamed.get(&key).unwrap_or(&0);
        if total <= have {
          return None;
        }
        let rest: String = content.chars().skip(have).collect();
        self.streamed.insert(key, total);
        self.text.push_str(&rest);
        Some(rest)
      }
      "session.error" => {
        let msg = data
          .get("message")
          .and_then(Value::as_str)
          .map(str::trim)
          .filter(|s| !s.is_empty())
          .unwrap_or("Copilot reported an error.");
        self.errored = Some(msg.to_string());
        None
      }
      _ => None,
    }
  }
}

fn is_terminal(event_type: &str) -> bool {
  matches!(event_type, "session.idle" | "session.error")
}

fn now_ms() -> f64 {
  chrono::Utc::now().timestamp_millis() as f64
}

/// Maps the model's tool calls to the chat's step rows, so the Help work log
/// looks and behaves like the one in Build chat.
#[derive(Default)]
struct Activity {
  tools: std::collections::HashMap<String, ChatToolCall>,
}

impl Activity {
  fn feed(&mut self, event_type: &str, data: &Value) -> Option<ChatToolCall> {
    match event_type {
      "tool.execution_start" => {
        let name = data.get("toolName").and_then(Value::as_str).unwrap_or("tool").to_string();
        if tools::is_reporting_tool(&name) {
          return None;
        }
        let id = data.get("toolCallId").and_then(Value::as_str)?.to_string();
        let args = data.get("arguments");
        let tool = ChatToolCall {
          id: id.clone(),
          title: chat_tools::tool_title(&name, args),
          command: chat_tools::shell_command(&name, args),
          paths: chat_tools::tool_paths(&name, args),
          name,
          state: ChatToolState::Running,
          started_at: Some(now_ms()),
          ..Default::default()
        };
        self.tools.insert(id, tool.clone());
        Some(tool)
      }
      "tool.execution_complete" => {
        let id = data.get("toolCallId").and_then(Value::as_str)?;
        let tool = self.tools.get_mut(id)?;
        let details = chat_tools::tool_end_details(Some(&tool.name), data);
        let success = data.get("success").and_then(Value::as_bool).unwrap_or(false);
        tool.state = if success { ChatToolState::Success } else { ChatToolState::Error };
        tool.output = details.output.map(|o| chat_tools::truncate(&o, MAX_ACTIVITY_OUTPUT));
        tool.exit_code = details.exit_code;
        tool.ended_at = Some(now_ms());
        Some(tool.clone())
      }
      _ => None,
    }
  }
}

/* ----------------------------- commands ----------------------------- */

/// What grounding the assistant currently has, for the overlay's status line.
#[tauri::command]
pub fn help_grounding(app: AppHandle) -> HelpGrounding {
  let version = app.package_info().version.to_string();
  let status = grounding::status(&version);
  HelpGrounding {
    source_ready: status.source_ready,
    docs_ready: status.docs_ready,
    notes_ready: status.notes_ready,
    reference: status.reference,
    pinned: status.pinned,
  }
}

/// Download (or refresh) the source checkout, the documentation mirror and the
/// release notes.
///
/// Runs on first open and when the user asks to refresh. Failures are reported
/// through the returned status rather than as an error: the assistant still
/// works with the logs alone, just with less to say.
#[tauri::command]
pub async fn help_prepare(app: AppHandle, force: bool) -> HelpGrounding {
  let version = app.package_info().version.to_string();
  let status = grounding::ensure_all(&version, force).await;
  HelpGrounding {
    source_ready: status.source_ready,
    docs_ready: status.docs_ready,
    notes_ready: status.notes_ready,
    reference: status.reference,
    pinned: status.pinned,
  }
}

/// Stop the in-flight answer. Returns true when one was running.
#[tauri::command]
pub fn help_cancel(state: State<'_, AppState>) -> bool {
  state.cancel_help()
}

/// The saved conversation, when one is still fresh enough to resume.
///
/// Returns the renderer's own shape untouched, plus when it was saved, so the
/// overlay can say it is picking something up rather than silently appearing
/// with old content.
#[tauri::command]
pub fn help_history_load() -> Option<help_session::ResumedSession> {
  help_session::load()
}

/// Persist the conversation so it survives closing the overlay and restarting.
#[tauri::command]
pub fn help_history_save(data: Value) -> Result<(), String> {
  help_session::save(data)
}

/// Forget the saved conversation, for "New conversation".
#[tauri::command]
pub fn help_history_clear() {
  help_session::clear();
}

/// Let the user point the assistant at files or a folder.
///
/// Attaching is how the user widens what Help may read: whatever comes back
/// here becomes a readable root for the next question (see
/// [`context::HelpContext::roots`]), and nothing else on disk is reachable.
#[tauri::command]
pub async fn help_pick_paths(app: AppHandle, directory: bool, title: Option<String>) -> Vec<String> {
  let dialog = app.dialog().file();
  let dialog = match &title {
    Some(t) => dialog.set_title(t),
    None => dialog,
  };
  let (tx, rx) = tokio::sync::oneshot::channel();
  if directory {
    dialog.pick_folders(move |picked| {
      let _ = tx.send(picked);
    });
  } else {
    dialog.pick_files(move |picked| {
      let _ = tx.send(picked);
    });
  }
  rx.await
    .ok()
    .flatten()
    .unwrap_or_default()
    .into_iter()
    .filter_map(|p| p.into_path().ok())
    .map(|p| p.to_string_lossy().to_string())
    .take(MAX_ATTACHMENTS)
    .collect()
}

/// Ask the assistant one question, streaming the answer to the overlay.
///
/// Each question runs on its own throwaway session: the conversation so far is
/// replayed in the prompt, which keeps a long Help session from ever landing in
/// the user's Build chat history and lets a stuck turn be abandoned cleanly.
#[tauri::command]
pub async fn help_ask(
  app: AppHandle,
  state: State<'_, AppState>,
  request: HelpAskRequest,
) -> Result<HelpAnswer, String> {
  let HelpAskRequest { ask_id, question, project_id, attachments, facts, surface, history, model } =
    request;
  let question = question.trim().to_string();
  if question.is_empty() {
    return Err("Type a question first.".to_string());
  }
  if question.chars().count() > MAX_QUESTION {
    return Err("That question is too long. Attach the file instead of pasting it.".to_string());
  }

  let attachments: Vec<String> =
    attachments.into_iter().filter(|p| !p.trim().is_empty()).take(MAX_ATTACHMENTS).collect();

  let version = app.package_info().version.to_string();
  let ctx = HelpContext::build(
    &version,
    project_id.as_deref(),
    &attachments,
    &facts,
    tools::Surface::parse(surface.as_deref()),
  );
  let token = state.begin_help();

  let emit: tools::Emit = {
    let (app, ask_id) = (app.clone(), ask_id.clone());
    Arc::new(move |event| emit_help_event(&app, &ask_id, event))
  };

  let artifacts: SharedArtifacts = Arc::new(Mutex::new(TurnArtifacts::default()));
  let result = run_turn(
    state.inner(),
    &ctx,
    &question,
    &attachments,
    history,
    model,
    &token,
    emit.clone(),
    artifacts.clone(),
  )
  .await;
  state.end_help(&token);

  match result {
    Ok(answer) => {
      emit(HelpEvent::Done { answer: answer.clone() });
      Ok(answer)
    }
    Err(message) => {
      // Help failing is itself worth recording — a user whose Help broke is
      // exactly who needs the journal to have caught it. Stopping is the user's
      // own doing, and recording it would crowd real errors out of the recent
      // window the next question is primed with.
      if message != STOPPED {
        journal::entry(Level::Error, Area::App, "help.failed", &message)
          .surface(journal::Surface::Inline)
          .operation("help_ask")
          .project(project_id.clone())
          .write();
      }
      emit(HelpEvent::Error { message: message.clone() });
      Err(message)
    }
  }
}

#[allow(clippy::too_many_arguments)]
async fn run_turn(
  state: &AppState,
  ctx: &HelpContext,
  question: &str,
  attachments: &[String],
  history: Vec<HelpTurn>,
  model: Option<String>,
  token: &CancelToken,
  emit: tools::Emit,
  artifacts: SharedArtifacts,
) -> Result<HelpAnswer, String> {
  let roots = ctx.roots();
  let cwd = ctx.cwd();
  let policy: Arc<dyn PermissionHandler> = Arc::new(HelpPolicy { roots, cwd: cwd.clone() });

  let tool_ctx = Arc::new(ToolContext {
    emit: emit.clone(),
    artifacts: artifacts.clone(),
    project_ids: ctx.projects.iter().map(|p| p.id.clone()).collect(),
    has_project: ctx.project.is_some(),
    team_project: ctx.project.as_ref().is_some_and(|p| p.team.is_some()),
    surface: ctx.surface,
  });
  let opts = SessionOptions {
    permission: Some(policy),
    excluded_tools: EXCLUDED_TOOLS.iter().map(|s| s.to_string()).collect(),
    tools: tools::help_tools(tool_ctx),
    ..Default::default()
  };

  let session = state
    .copilot
    .transient_session_with(
      &cwd.to_string_lossy(),
      crate::services::copilot::ModelChoice::of(model, None),
      opts,
    )
    .await?;
  let sub = session.subscribe();

  let message = compose(ctx, question, attachments, &history);
  let started = std::time::Instant::now();

  let mut answer = Answer::default();
  let mut activity = Activity::default();
  let end = match session.send(MessageOptions::new(message)).await {
    Ok(_) => {
      drain(&session, sub, token, TURN_TIMEOUT_MS, |event_type, data| {
        if let Some(tool) = activity.feed(event_type, data) {
          emit(HelpEvent::Activity { tool });
        }
        if let Some(delta) = answer.feed(event_type, data) {
          emit(HelpEvent::Delta { text: delta });
        }
        is_terminal(event_type)
      })
      .await
    }
    Err(e) => {
      let _ = session.disconnect().await;
      return Err(friendly_send_error(&e.to_string()));
    }
  };
  // Never reused, so disconnect rather than letting sessions accumulate.
  let _ = session.disconnect().await;

  if let Some(e) = answer.errored {
    return Err(e);
  }
  let text = answer.text.trim().to_string();
  match end {
    DrainEnd::Cancelled => Err(STOPPED.to_string()),
    DrainEnd::TimedOut if text.is_empty() => {
      Err("That took too long. Try asking something more specific.".to_string())
    }
    DrainEnd::Closed if text.is_empty() => {
      Err("The connection to Copilot closed before an answer arrived. Try again.".to_string())
    }
    _ if text.is_empty() => Err("No answer came back. Try again.".to_string()),
    _ => {
      let held = artifacts.lock().unwrap();
      Ok(HelpAnswer {
        text,
        actions: held.actions.clone(),
        citations: held.citations.clone(),
        issue: held.issue.clone(),
        elapsed_ms: started.elapsed().as_millis() as u64,
      })
    }
  }
}

/// Turn the SDK's send error into something a non-developer can act on.
fn friendly_send_error(raw: &str) -> String {
  let lower = raw.to_ascii_lowercase();
  if lower.contains("sign in") || lower.contains("authenticat") || lower.contains("unauthor") {
    "You need to be signed in to GitHub Copilot to use Help. Open the account menu in the app bar \
and sign in, then ask again."
      .to_string()
  } else if lower.contains("quota") || lower.contains("rate limit") {
    "Your Copilot quota is used up right now, so Help can't answer. Try again later.".to_string()
  } else {
    format!("Help couldn't reach Copilot: {raw}")
  }
}

/// Build the message for one turn: the standing instructions and context on the
/// first question, then the conversation so far, then the new question.
fn compose(ctx: &HelpContext, question: &str, attachments: &[String], history: &[HelpTurn]) -> String {
  let mut s = prompt::system_frame(ctx);
  s.push_str("\n\n# Actions you can offer\n\n");
  s.push_str(&tools::action_catalogue());
  s.push_str("\n\n");

  if !history.is_empty() {
    // Only the most recent turns: a resumed thread can be long, and the model
    // needs what just happened, not everything since yesterday.
    let recent = &history[history.len().saturating_sub(MAX_REPLAYED_TURNS)..];
    if recent.len() < history.len() {
      s.push_str("# The conversation so far\n\n(Earlier turns omitted.)\n\n");
    } else {
      s.push_str("# The conversation so far\n\n");
    }
    for turn in recent {
      s.push_str(&format!("User: {}\n\n", turn.question.trim()));
      if !turn.answer.trim().is_empty() {
        s.push_str(&format!("You: {}\n\n", turn.answer.trim()));
      }
    }
  }

  s.push_str("# Answer this\n\n");
  s.push_str(&prompt::turn_frame(ctx, question, attachments));
  s
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The fixtures are written as Windows paths; elsewhere `C:\a\b` becomes `/a/b`, so
  /// the policy's path checks mean the same on every OS the tests run on.
  fn native(path: &str) -> String {
    if cfg!(windows) {
      path.to_string()
    } else {
      path.trim_start_matches("C:").replace('\\', "/")
    }
  }

  fn roots() -> Vec<PathBuf> {
    vec![PathBuf::from(native("C:\\data\\logs")), PathBuf::from(native("C:\\cache\\source"))]
  }

  fn policy() -> HelpPolicy {
    HelpPolicy { roots: roots(), cwd: PathBuf::from(native("C:\\cache")) }
  }

  fn ctx() -> HelpContext {
    HelpContext {
      app_version: "1.10.0".into(),
      dev_build: false,
      os: "windows".into(),
      source_dir: None,
      source_ref: None,
      docs_dir: None,
      release_notes: None,
      logs_dir: "C:\\data\\logs".into(),
      project: None,
      projects: Vec::new(),
      recent_activity: String::new(),
      facts: Vec::new(),
      surface: crate::commands::help::tools::Surface::Project,
      extra_roots: Vec::new(),
    }
  }

  fn request(kind: &str, key: &str, value: &str) -> PermissionRequestData {
    PermissionRequestData {
      extra: serde_json::json!({ "permissionRequest": { "kind": kind, key: value } }),
      ..Default::default()
    }
  }

  fn read_request(path: &str) -> PermissionRequestData {
    request("read", "path", &native(path))
  }

  fn url_request(url: &str) -> PermissionRequestData {
    request("url", "url", url)
  }

  #[test]
  fn reads_inside_a_root_are_allowed() {
    assert!(policy().permits(&read_request("C:\\data\\logs\\errors-2026-01-01.jsonl")));
    assert!(policy().permits(&read_request("C:\\cache\\source\\src-tauri\\src\\lib.rs")));
  }

  #[test]
  fn reads_outside_every_root_are_denied() {
    assert!(!policy().permits(&read_request("C:\\Users\\me\\Documents\\taxes.xlsx")));
    assert!(!policy().permits(&read_request("C:\\Windows\\System32\\config\\SAM")));
  }

  #[test]
  fn secret_files_are_denied_even_inside_a_root() {
    assert!(!policy().permits(&read_request("C:\\cache\\source\\.env")));
    assert!(!policy().permits(&read_request("C:\\cache\\source\\id_rsa")));
    assert!(policy().permits(&read_request("C:\\cache\\source\\.env.example")), "templates are fine");
  }

  #[test]
  fn only_documentation_hosts_are_fetchable() {
    assert!(policy().permits(&url_request("https://spatney.github.io/rayfin-fabricator/docs")));
    assert!(policy().permits(&url_request("https://rayfin.ai/docs")));
    assert!(!policy().permits(&url_request("https://example.com/")));
    assert!(!policy().permits(&url_request("http://spatney.github.io/")), "https only");
  }

  #[test]
  fn a_lookalike_host_is_not_an_allowed_fetch() {
    // These all *start with* an allowed host but are served by another one.
    assert!(!url_allowed("https://rayfin.ai.evil.example/docs"));
    assert!(!url_allowed("https://rayfin.ai@evil.example/docs"));
    assert!(!url_allowed("https://spatney.github.io.evil.example/rayfin-fabricator"));
    assert!(!url_allowed("https://evil.example/?x=https://rayfin.ai"));
  }

  #[test]
  fn a_citation_must_be_a_page_we_publish() {
    assert!(docs_url_allowed("https://spatney.github.io/rayfin-fabricator"));
    assert!(docs_url_allowed("https://spatney.github.io/rayfin-fabricator/docs/ship/deploy"));
    assert!(docs_url_allowed("https://rayfin.ai/docs/reference/cli"));
    // github.io hosts many projects; a citation must stay inside ours.
    assert!(!docs_url_allowed("https://spatney.github.io/some-other-project/docs"));
    assert!(!docs_url_allowed("https://spatney.github.io/rayfin-fabricator-evil/docs"));
    // The lookalikes above must not pass here either.
    assert!(!docs_url_allowed("https://rayfin.ai.evil.example/docs"));
    assert!(!docs_url_allowed("https://rayfin.ai@evil.example/docs"));
    assert!(!docs_url_allowed("http://rayfin.ai/docs"), "https only");
  }

  #[test]
  fn open_docs_never_leaves_fabricators_own_documentation() {
    assert!(fabricator_docs_url("https://spatney.github.io/rayfin-fabricator/docs/ship/deploy"));
    assert!(!fabricator_docs_url("https://rayfin.ai/docs"), "that is Rayfin's site, not ours");
    assert!(!fabricator_docs_url("https://spatney.github.io/other/docs"));
    assert!(
      !fabricator_docs_url(&grounding::release_page("1.14.0")),
      "release notes are cited, not opened as docs"
    );
  }

  #[test]
  fn a_backslash_cannot_disguise_the_host() {
    // Browsers treat `\` as `/`, so each of these opens evil.example.
    assert!(!url_allowed("https://evil.example\\@rayfin.ai/docs"));
    assert!(!docs_url_allowed("https://evil.example\\@spatney.github.io/rayfin-fabricator/docs"));
    assert!(!release_notes_url("https://evil.example\\@github.com/spatney/rayfin-fabricator/releases"));
  }

  #[test]
  fn fabricators_release_pages_can_be_read_and_cited() {
    for url in [
      grounding::RELEASES_URL.to_string(),
      grounding::release_page("1.14.0"),
      "https://github.com/spatney/rayfin-fabricator/releases/".to_string(),
      "https://github.com/spatney/rayfin-fabricator/releases/latest".to_string(),
      "https://github.com/spatney/rayfin-fabricator/releases/tag/v1.3.4-experimental.mac-sso.1".to_string(),
      "https://github.com/spatney/rayfin-fabricator/releases?page=2".to_string(),
      "https://github.com/spatney/rayfin-fabricator/releases/tag/v1.14.0#see-every-step-of-a-deploy".to_string(),
    ] {
      assert!(release_notes_url(&url), "{url} is one of our release pages");
      assert!(policy().permits(&url_request(&url)), "{url} can be fetched");
    }
  }

  #[test]
  fn nothing_else_on_github_is_reachable() {
    for url in [
      "https://github.com/spatney/rayfin-fabricator",
      "https://github.com/spatney/rayfin-fabricator/issues/new",
      "https://github.com/spatney/rayfin-fabricator/releases/download/v1.14.0/latest.json",
      "https://github.com/spatney/rayfin-fabricator-evil/releases",
      "https://github.com/spatney/rayfin-fabricator/releasesx",
      "https://github.com/someone/else/releases",
      "https://github.com/spatney/rayfin-fabricator/releases/tag/../../../evil/phish",
      "https://github.com/spatney/rayfin-fabricator/releases/tag/v1.14.0/../../../../evil",
      "https://github.com/spatney/rayfin-fabricator/releases/tag/%2e%2e/%2e%2e",
      "https://github.com/spatney/rayfin-fabricator/releases/tag/.",
      "https://github.com/spatney/rayfin-fabricator/releases/tag/",
      "https://github.com.evil.example/spatney/rayfin-fabricator/releases",
      "https://github.com@evil.example/spatney/rayfin-fabricator/releases",
      "https://api.github.com/repos/spatney/rayfin-fabricator/releases",
      "http://github.com/spatney/rayfin-fabricator/releases",
    ] {
      assert!(!release_notes_url(url), "{url} is not a release page of ours");
      assert!(!policy().permits(&url_request(url)), "{url} cannot be fetched");
    }
  }

  #[test]
  fn the_agent_cannot_search_the_web() {
    // Its only egress is the documentation hosts; a search would carry the
    // user's error text and project name to a third party.
    assert!(EXCLUDED_TOOLS.contains(&"web_search"));
  }

  #[test]
  fn a_sandbox_bypass_is_always_denied() {
    let data = PermissionRequestData {
      extra: serde_json::json!({
        "permissionRequest": {
          "kind": "read",
          "path": native("C:\\data\\logs\\errors.jsonl"),
          "requestSandboxBypass": true
        }
      }),
      ..Default::default()
    };
    assert!(!policy().permits(&data));
  }

  #[test]
  fn unknown_request_kinds_fail_closed() {
    assert!(!policy().permits(&request("write", "path", "C:\\data\\logs\\x")));
    assert!(!policy().permits(&request("mcp", "path", "C:\\data\\logs\\x")));
  }

  #[test]
  fn the_answer_does_not_duplicate_streamed_text() {
    let mut answer = Answer::default();
    let delta = serde_json::json!({ "messageId": "m1", "deltaContent": "Hello" });
    assert_eq!(answer.feed("assistant.message_delta", &delta).as_deref(), Some("Hello"));
    let full = serde_json::json!({ "messageId": "m1", "content": "Hello there" });
    assert_eq!(answer.feed("assistant.message", &full).as_deref(), Some(" there"));
    assert_eq!(answer.text, "Hello there");
  }

  #[test]
  fn a_session_error_is_captured() {
    let mut answer = Answer::default();
    answer.feed("session.error", &serde_json::json!({ "message": "model unavailable" }));
    assert_eq!(answer.errored.as_deref(), Some("model unavailable"));
  }

  #[test]
  fn a_long_conversation_only_replays_its_recent_turns() {
    let c = ctx();
    let history: Vec<HelpTurn> = (0..MAX_REPLAYED_TURNS + 4)
      .map(|i| HelpTurn { question: format!("question {i}"), answer: format!("answer {i}") })
      .collect();
    let message = compose(&c, "what now?", &[], &history);

    assert!(message.contains("Earlier turns omitted."));
    assert!(!message.contains("question 0"), "the oldest turns are dropped");
    let newest = history.len() - 1;
    assert!(message.contains(&format!("question {newest}")), "the newest turn is kept");
    assert_eq!(
      message.matches("User: question").count(),
      MAX_REPLAYED_TURNS,
      "exactly the cap is replayed"
    );
  }

  #[test]
  fn a_short_conversation_replays_whole_and_says_nothing_about_omissions() {
    let message = compose(
      &ctx(),
      "what now?",
      &[],
      &[HelpTurn { question: "first".into(), answer: "yes".into() }],
    );
    assert!(message.contains("User: first"));
    assert!(!message.contains("Earlier turns omitted."));
  }

  #[test]
  fn sign_in_failures_become_actionable_advice() {
    let text = friendly_send_error("request failed: unauthorized");
    assert!(text.contains("signed in to GitHub Copilot"));
    assert!(!text.contains("unauthorized"), "the raw error is replaced, not appended");
  }

  #[test]
  fn an_unrecognised_failure_keeps_its_detail() {
    assert!(friendly_send_error("socket hang up").contains("socket hang up"));
  }
}
