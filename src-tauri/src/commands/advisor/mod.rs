//! Advisor: reviews the active Rayfin app against the shared rule catalog
//! (`src/shared/advisor/rules.json`).
//!
//! * **Quick checks** run in the renderer over an [`advisor_collect`] snapshot —
//!   instant, deterministic, and free.
//! * The **deep review** ([`advisor_run`]) is a Copilot session on a throwaway
//!   session id (never in the Build chat history) that is read-only by
//!   construction: mutating and shell tools are excluded, and the permission
//!   policy denies writes, shell, and non-read-only MCP calls and limits web
//!   fetches to rayfin.ai. The model reports through custom tools, so findings
//!   stream to the UI as they're confirmed, each checked against the file.
//! * **Verify** ([`advisor_verify`]) re-checks specific findings after a fix, and
//!   **Explain** ([`advisor_explain`]) streams an inline Markdown answer.

mod catalog;
mod collect;
mod evidence;
mod prompt;
mod tools;

pub(crate) use evidence::mask_secrets;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use github_copilot_sdk::handler::{PermissionHandler, PermissionResult};
use github_copilot_sdk::session::Session;
use github_copilot_sdk::subscription::RecvErrorKind;
use github_copilot_sdk::{
  EventSubscription, MessageOptions, PermissionRequestData, PermissionRequestKind, RequestId, SessionId,
};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::commands::chat_tools;
use crate::services::byok::{self, ByokManager};
use crate::services::copilot::{CopilotManager, ModelChoice, SessionOptions};
use crate::services::emit::emit_advisor_event;
use crate::services::exec::CancelToken;
use crate::services::fingerprint::fingerprint;
use crate::services::{paths, store};
use crate::state::AppState;
use crate::types::{
  AdvisorEvent, AdvisorFinding, AdvisorLoadResult, AdvisorProjectSnapshot, AdvisorRawReport, AdvisorReport,
  AdvisorRuleResult, AdvisorRunRequest, AdvisorSnapshot, AdvisorVerdict, ChatToolCall, ChatToolState,
};
use tools::{Emit, ReviewContext, ReviewCore, RuleMeta, SharedLog, SharedVerdicts, VerifyContext};

/// Ceiling for one deep review.
const RUN_TIMEOUT_MS: u64 = 10 * 60_000;
/// Ceiling for one inline explanation.
const EXPLAIN_TIMEOUT_MS: u64 = 3 * 60_000;
/// Ceiling for one Verify re-check.
const VERIFY_TIMEOUT_MS: u64 = 4 * 60_000;
/// Most findings one Verify run re-checks.
const MAX_VERIFY_FINDINGS: usize = 12;
/// Largest renderer-owned state document accepted by `advisor_save_state`.
const MAX_STATE_BYTES: usize = 512 * 1024;
/// Output kept per activity step (the feed shows a preview, not the full file).
const MAX_ACTIVITY_OUTPUT: usize = 2000;
/// Saved-review format: 2 = catalog-based.
const SNAPSHOT_SCHEMA: u32 = 2;

/// Built-in tools an Advisor session must not use. The permission policy
/// enforces read-only regardless; excluding them keeps the model from trying.
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

/// Hosts the deep review may fetch documentation from.
const ALLOWED_URL_HOSTS: &[&str] = &["rayfin.ai", "www.rayfin.ai"];

/// What a read-only session may do beyond reading files inside its root.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Sandbox {
  /// Hosts `web_fetch` may reach (https only).
  pub url_hosts: &'static [&'static str],
  /// Allow MCP tools that declare themselves read-only.
  pub read_only_mcp: bool,
}

/// The Advisor's sandbox: rayfin.ai docs and read-only MCP tools.
const ADVISOR_SANDBOX: Sandbox = Sandbox { url_hosts: ALLOWED_URL_HOSTS, read_only_mcp: true };

/* ----------------------------- read-only policy ----------------------------- */

fn url_allowed(url: &str, hosts: &[&str]) -> bool {
  let Some(rest) = url.trim().strip_prefix("https://") else {
    return false;
  };
  let host = rest.split(['/', '?', '#']).next().unwrap_or("");
  let host = host.rsplit('@').next().unwrap_or(host);
  let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
  hosts.contains(&host.as_str())
}

fn path_inside(root: &Path, path: &str) -> bool {
  let p = Path::new(path);
  let joined = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
  crate::commands::util::normalize(&joined).starts_with(crate::commands::util::normalize(root))
}

/// The permission request itself. The runtime nests it under
/// `permissionRequest` in the `permission.requested` event (so the SDK's
/// top-level [`PermissionRequestData::kind`] is unset); older runtimes sent it flat.
fn request_body(data: &PermissionRequestData) -> &Value {
  data.extra.get("permissionRequest").filter(|v| v.is_object()).unwrap_or(&data.extra)
}

fn request_kind(data: &PermissionRequestData) -> Option<String> {
  if let Some(kind) = request_body(data).get("kind").and_then(Value::as_str) {
    return Some(kind.to_string());
  }
  let kind = match data.kind.as_ref()? {
    PermissionRequestKind::Read => "read",
    PermissionRequestKind::Url => "url",
    PermissionRequestKind::CustomTool => "custom-tool",
    PermissionRequestKind::Mcp => "mcp",
    _ => "other",
  };
  Some(kind.to_string())
}

/// Files whose contents are secrets. The quick checks inspect them locally, so
/// the deep review never needs (or sends Copilot) their values.
fn is_secret_file(path: &str) -> bool {
  let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_ascii_lowercase();
  if name == ".env" || name.starts_with(".env.") {
    const TEMPLATES: &[&str] = &[".example", ".sample", ".template", ".defaults", ".dist"];
    return !TEMPLATES.iter().any(|t| name.ends_with(t));
  }
  matches!(name.as_str(), ".envrc" | ".npmrc" | ".netrc" | ".pypirc" | "id_rsa" | "id_ecdsa" | "id_ed25519")
    || [".pem", ".key", ".pfx", ".p12"].iter().any(|ext| name.ends_with(ext))
}

/// Whether a read-only Advisor session may perform a requested action. Fails
/// closed: anything unrecognized, and any sandbox-bypass request, is denied.
#[cfg(test)]
fn permitted(root: &Path, data: &PermissionRequestData) -> bool {
  permitted_in(root, ADVISOR_SANDBOX, data)
}

/// [`permitted`] for any [`Sandbox`].
pub(crate) fn permitted_in(root: &Path, sandbox: Sandbox, data: &PermissionRequestData) -> bool {
  let body = request_body(data);
  let text = |key: &str| body.get(key).and_then(Value::as_str);
  if body.get("requestSandboxBypass").and_then(Value::as_bool) == Some(true) {
    return false;
  }
  match request_kind(data).as_deref() {
    Some("read") => text("path").is_some_and(|p| path_inside(root, p) && !is_secret_file(p)),
    Some("url") => text("url").is_some_and(|u| url_allowed(u, sandbox.url_hosts)),
    Some("custom-tool") => true,
    Some("mcp") => sandbox.read_only_mcp && body.get("readOnly").and_then(Value::as_bool).unwrap_or(false),
    _ => false,
  }
}

/// Answers a read-only session's permission requests with [`permitted_in`].
struct ReadOnlyPolicy {
  root: PathBuf,
  sandbox: Sandbox,
}

#[async_trait]
impl PermissionHandler for ReadOnlyPolicy {
  async fn handle(&self, _: SessionId, _: RequestId, data: PermissionRequestData) -> PermissionResult {
    if permitted_in(&self.root, self.sandbox, &data) {
      return PermissionResult::approve_once();
    }
    log::info!("Read-only session denied a {} request", request_kind(&data).unwrap_or_else(|| "unknown".into()));
    // A `reject` reads as the user declining, which ends the whole turn;
    // "no user available" fails only this call, so the review carries on.
    PermissionResult::user_not_available()
  }
}

/// Session options that sandbox a transient session to reading `root` (and the
/// rayfin.ai docs): writes, shell, secrets and sandbox bypasses are denied.
/// Shared with Design mode's model-backed helpers.
pub(crate) fn read_only_options(root: &str) -> SessionOptions {
  sandboxed_options(root, ADVISOR_SANDBOX)
}

/// [`read_only_options`] with another [`Sandbox`] (documentation hosts, MCP).
pub(crate) fn sandboxed_options(root: &str, sandbox: Sandbox) -> SessionOptions {
  let policy: Arc<dyn PermissionHandler> = Arc::new(ReadOnlyPolicy { root: PathBuf::from(root), sandbox });
  SessionOptions {
    permission: Some(policy),
    excluded_tools: EXCLUDED_TOOLS.iter().map(|s| s.to_string()).collect(),
    ..Default::default()
  }
}

/* ----------------------------- event draining ----------------------------- */

pub(crate) enum DrainEnd {
  Finished,
  Cancelled,
  Closed,
  TimedOut,
}

/// Feed session events to `on_event` until it reports a terminal state, the
/// token is cancelled, the stream closes, or `timeout_ms` passes.
pub(crate) async fn drain(
  session: &Session,
  mut sub: EventSubscription,
  token: &CancelToken,
  timeout_ms: u64,
  mut on_event: impl FnMut(&str, &Value) -> bool,
) -> DrainEnd {
  let run = async {
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
            if on_event(&ev.event_type, &ev.data) {
              return DrainEnd::Finished;
            }
          }
          Err(err) => match err.kind() {
            RecvErrorKind::Lagged(l) => log::warn!("advisor event stream lagged, skipped {} events", l.skipped()),
            RecvErrorKind::Closed => return DrainEnd::Closed,
            other => {
              log::warn!("advisor event stream error: {other:?}");
              return DrainEnd::Closed;
            }
          },
        }
      }
    }
  };
  match tokio::time::timeout(Duration::from_millis(timeout_ms), run).await {
    Ok(end) => end,
    Err(_) => {
      let _ = session.abort().await;
      DrainEnd::TimedOut
    }
  }
}

/// Assistant text reassembled in stream order, plus the terminal state.
#[derive(Default)]
struct TextAcc {
  /// Every assistant message, concatenated.
  text: String,
  /// Characters of each assistant message already appended (dedup with the
  /// terminal `assistant.message` event).
  streamed: HashMap<String, usize>,
  /// Each message's text, in arrival order.
  messages: Vec<(String, String)>,
  /// Messages that handed off to tool calls — narration, not the answer.
  narration: HashSet<String>,
  errored: Option<String>,
}

/// A finished assistant message that hands off to tool calls ("Let me check
/// the docs…"): narration, not part of the answer.
fn is_narration(event_type: &str, data: &Value) -> bool {
  event_type == "assistant.message"
    && data.get("toolRequests").and_then(Value::as_array).is_some_and(|calls| !calls.is_empty())
}

impl TextAcc {
  fn append(&mut self, id: String, text: &str) {
    self.text.push_str(text);
    match self.messages.iter_mut().find(|(m, _)| *m == id) {
      Some((_, body)) => body.push_str(text),
      None => self.messages.push((id, text.to_string())),
    }
  }

  /// Take one event; returns the newly appended text, if any.
  fn feed(&mut self, event_type: &str, data: &Value) -> Option<String> {
    let id = || data.get("messageId").and_then(Value::as_str).unwrap_or("").to_string();
    match event_type {
      "assistant.message_delta" => {
        let text = data.get("deltaContent").and_then(Value::as_str).unwrap_or("");
        if text.is_empty() {
          return None;
        }
        let key = id();
        *self.streamed.entry(key.clone()).or_insert(0) += text.chars().count();
        self.append(key, text);
        Some(text.to_string())
      }
      "assistant.message" => {
        let content = data.get("content").and_then(Value::as_str).unwrap_or("");
        let total = content.chars().count();
        let key = id();
        if is_narration(event_type, data) {
          self.narration.insert(key.clone());
        }
        let have = *self.streamed.get(&key).unwrap_or(&0);
        if total <= have {
          return None;
        }
        let rest: String = content.chars().skip(have).collect();
        self.streamed.insert(key.clone(), total);
        self.append(key, &rest);
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

  /// The reply without narration: the messages that didn't lead to tool calls.
  fn answer(&self) -> String {
    let parts: Vec<&str> = self
      .messages
      .iter()
      .filter(|(id, _)| !self.narration.contains(id))
      .map(|(_, text)| text.trim())
      .filter(|text| !text.is_empty())
      .collect();
    parts.join("\n\n")
  }
}

fn is_terminal(event_type: &str) -> bool {
  matches!(event_type, "session.idle" | "session.error")
}

fn now_ms() -> f64 {
  chrono::Utc::now().timestamp_millis() as f64
}

/// Tool calls the deep review makes, mapped to the chat's `ChatToolCall` shape
/// so the renderer can show them with the same step rows.
#[derive(Default)]
struct Activity {
  tools: HashMap<String, ChatToolCall>,
}

impl Activity {
  fn feed(&mut self, event_type: &str, data: &Value) -> Option<ChatToolCall> {
    match event_type {
      "tool.execution_start" => {
        let name = data.get("toolName").and_then(Value::as_str).unwrap_or("tool").to_string();
        if tools::is_reporting_tool(&name) || name == "report_intent" {
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

/* ----------------------------- legacy JSON fallback ----------------------------- */

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

/// Best-effort extraction of a JSON report when the model wrote one instead of
/// calling the reporting tools: the last fenced block that parses, else the
/// widest `{ ... }` slice.
fn extract_report(text: &str) -> Option<AdvisorRawReport> {
  for block in fenced_blocks(text).into_iter().rev() {
    if let Ok(report) = serde_json::from_str::<AdvisorRawReport>(block.trim()) {
      return Some(report);
    }
  }
  let (start, end) = (text.find('{')?, text.rfind('}')?);
  if end > start {
    serde_json::from_str::<AdvisorRawReport>(&text[start..=end]).ok()
  } else {
    None
  }
}

/// Normalize a finding parsed from a fallback JSON report.
fn normalize_fallback(mut f: AdvisorFinding, allowed: &HashSet<String>) -> AdvisorFinding {
  if !allowed.contains(&f.rule_id) {
    f.rule_id.clear();
  }
  if let Some(rule) = catalog::rule(&f.rule_id) {
    f.category = rule.category.clone();
  }
  f.source = "ai".into();
  f.verified = Some(false);
  if !f.rule_id.is_empty() {
    f.id = evidence::rule_finding_id(&f.rule_id);
  } else if f.id.trim().is_empty() {
    f.id = evidence::finding_id(&f.rule_id, f.file.as_deref(), &f.title);
  }
  f
}

/// Keep one finding per id, folding repeats into the first.
fn fold_by_id(findings: impl IntoIterator<Item = AdvisorFinding>) -> Vec<AdvisorFinding> {
  let mut out: Vec<AdvisorFinding> = Vec::new();
  for f in findings {
    match out.iter_mut().find(|e| e.id == f.id) {
      Some(existing) => {
        tools::merge_finding(existing, f);
      }
      None => out.push(f),
    }
  }
  out
}

/* ----------------------------- persistence ----------------------------- */

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
  let tmp = path.with_extension("tmp");
  std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
  std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn save_snapshot(project_id: &str, snapshot: &AdvisorSnapshot) {
  match serde_json::to_string_pretty(snapshot) {
    Ok(text) => {
      if let Err(e) = write_atomic(&paths::advisor_file(project_id), &text) {
        log::warn!("failed to save advisor snapshot for {project_id}: {e}");
      }
    }
    Err(e) => log::warn!("failed to serialize advisor snapshot for {project_id}: {e}"),
  }
}

/// Load a saved review, recomputing `stale` against the project's current code.
fn load_snapshot(project_id: &str, project_path: &str) -> Option<AdvisorSnapshot> {
  let text = std::fs::read_to_string(paths::advisor_file(project_id)).ok()?;
  let mut snapshot: AdvisorSnapshot = serde_json::from_str(&text).ok()?;
  let current = fingerprint(project_path);
  snapshot.stale = !snapshot.fingerprint.is_empty() && snapshot.fingerprint != current;
  Some(snapshot)
}

fn failed_report(summary: String) -> AdvisorReport {
  AdvisorReport { ok: false, summary, findings: vec![], rules: None }
}

/* ----------------------------- commands ----------------------------- */

/// Gather the quick-check snapshot for a project in one round-trip.
#[tauri::command]
pub async fn advisor_collect(project_id: String) -> Result<AdvisorProjectSnapshot, String> {
  let Some(project) = store::find_project(&project_id) else {
    return Err("Project not found.".into());
  };
  Ok(collect::collect(&project.path).await)
}

/// Return the saved deep review (with `stale` recomputed) and the
/// renderer-owned lifecycle state for a project; either may be absent.
#[tauri::command]
pub async fn advisor_load(project_id: String) -> Result<AdvisorLoadResult, String> {
  let Some(project) = store::find_project(&project_id) else {
    return Ok(AdvisorLoadResult::default());
  };
  let snapshot = load_snapshot(&project_id, &project.path);
  let state = std::fs::read_to_string(paths::advisor_state_file(&project_id))
    .ok()
    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    .filter(Value::is_object);
  Ok(AdvisorLoadResult { snapshot, state })
}

/// Persist the renderer-owned lifecycle state (dismissals, hand-offs, baseline).
/// The backend only stores it; its shape belongs to the renderer.
#[tauri::command]
pub async fn advisor_save_state(project_id: String, state: Value) -> Result<(), String> {
  if store::find_project(&project_id).is_none() {
    return Err("Project not found.".into());
  }
  if !state.is_object() {
    return Err("Invalid Advisor state.".into());
  }
  let text = serde_json::to_string(&state).map_err(|e| e.to_string())?;
  if text.len() > MAX_STATE_BYTES {
    return Err("Advisor state is too large to save.".into());
  }
  write_atomic(&paths::advisor_state_file(&project_id), &text)
}

/// Assemble the final report from what the model reported.
fn finalize_review(
  log: &tools::ReviewLog,
  rules: &[&catalog::RuleDef],
  text: &TextAcc,
  end: &DrainEnd,
) -> AdvisorReport {
  let allowed: HashSet<String> = rules.iter().map(|r| r.id.clone()).collect();
  let mut findings = log.findings.clone();
  let mut reported = log.has_reports();
  if !reported {
    if let Some(raw) = extract_report(&text.text) {
      findings = fold_by_id(raw.findings.into_iter().map(|f| normalize_fallback(f, &allowed)));
      reported = true;
    }
  }
  if !reported {
    let detail = if let Some(e) = &text.errored {
      e.clone()
    } else if matches!(end, DrainEnd::TimedOut) {
      "the review timed out after 10 minutes.".to_string()
    } else if !text.text.trim().is_empty() {
      text.text.trim().chars().take(600).collect()
    } else {
      "Copilot ended without reporting any results.".to_string()
    };
    return AdvisorReport {
      ok: false,
      summary: format!("Couldn't complete the review: {detail}"),
      findings: vec![],
      rules: None,
    };
  }

  let results: Vec<AdvisorRuleResult> = rules
    .iter()
    .map(|r| {
      log.rules.get(&r.id).cloned().unwrap_or_else(|| {
        if findings.iter().any(|f| f.rule_id == r.id) {
          AdvisorRuleResult { rule_id: r.id.clone(), status: "fail".into(), note: None }
        } else {
          AdvisorRuleResult {
            rule_id: r.id.clone(),
            status: "skipped".into(),
            note: Some("Not evaluated in this review.".into()),
          }
        }
      })
    })
    .collect();

  let count = findings.iter().filter(|f| f.severity != "note").count();
  let mut summary = log.summary.clone().unwrap_or_else(|| match count {
    0 => "No issues found in the rules Copilot reviewed.".to_string(),
    1 => "Copilot found 1 issue.".to_string(),
    n => format!("Copilot found {n} issues."),
  });
  let stopped = match end {
    DrainEnd::TimedOut => Some("it timed out"),
    _ if text.errored.is_some() => Some("Copilot reported an error"),
    DrainEnd::Closed if !log.completed => Some("the session ended"),
    _ => None,
  };
  if let Some(reason) = stopped {
    summary = format!("{summary} The review stopped early ({reason}), so some rules may not have been checked.");
  }
  AdvisorReport { ok: true, summary, findings, rules: Some(results) }
}

/* ----------------------------- one-shot sessions ----------------------------- */

/// Where a one-shot Advisor session runs, and how it can be stopped.
struct RunCtx<'a> {
  copilot: &'a CopilotManager,
  /// Your own API keys, for runs on a provider's model.
  byok: &'a ByokManager,
  root: &'a str,
  choice: ModelChoice,
  token: &'a CancelToken,
}

/// Deliver a project's Advisor events to the renderer.
fn emitter(app: &AppHandle, project_id: &str) -> Emit {
  let (app, project_id) = (app.clone(), project_id.to_string());
  Arc::new(move |event| emit_advisor_event(&app, &project_id, event))
}

/// Send `prompt` on a throwaway read-only session and feed its events to
/// `on_event` until the turn ends. `Err` means the prompt never started.
async fn one_shot(
  run: &RunCtx<'_>,
  mut opts: SessionOptions,
  prompt: String,
  timeout_ms: u64,
  mut on_event: impl FnMut(&str, &Value) -> bool,
) -> Result<DrainEnd, String> {
  // A provider's model must be able to run, and the session needs the registry
  // to reach it; otherwise the runtime would quietly use a Copilot model.
  let provider_model = run.choice.model.clone().filter(|m| byok::is_provider_selection(m));
  if let Some(model) = &provider_model {
    run.byok.ensure_ready(model)?;
    opts.byok = run.byok.session_registry();
  }
  let session = run.copilot.transient_session_with(run.root, run.choice.clone(), opts).await?;
  let deadline = Instant::now() + Duration::from_millis(timeout_ms);
  // A provider's model can stop with an empty response (no reply, no tool
  // call): ask it to carry on, within the same time budget. Its errors read plainly.
  let ended_empty = AtomicBool::new(false);
  let mut watch = |event_type: &str, data: &Value| {
    match event_type {
      "assistant.message" => ended_empty.store(byok::is_empty_response(data), Ordering::Relaxed),
      "session.error" => {
        ended_empty.store(false, Ordering::Relaxed);
        let plain = provider_model.as_deref().and_then(|model| {
          data.get("message").and_then(Value::as_str).and_then(|raw| byok::explain_for(model, raw))
        });
        if let Some(plain) = plain {
          let mut data = data.clone();
          data["message"] = Value::String(plain);
          return on_event(event_type, &data);
        }
      }
      _ => {}
    }
    on_event(event_type, data)
  };
  let mut message = prompt;
  let mut continues = 0;
  let end = loop {
    let sub = session.subscribe();
    if let Err(e) = session.send(MessageOptions::new(message)).await {
      // Only the first send decides whether the prompt started.
      break if continues == 0 { Err(e.to_string()) } else { Ok(DrainEnd::Finished) };
    }
    let left = deadline.saturating_duration_since(Instant::now()).as_millis() as u64;
    let end = drain(&session, sub, run.token, left, &mut watch).await;
    let again = provider_model.is_some()
      && matches!(end, DrainEnd::Finished)
      && ended_empty.load(Ordering::Relaxed)
      && continues < byok::MAX_CONTINUES
      && Instant::now() < deadline;
    if !again {
      break Ok(end);
    }
    continues += 1;
    ended_empty.store(false, Ordering::Relaxed);
    message = byok::CONTINUE_PROMPT.to_string();
  };
  // These sessions are never reused; disconnect so they never accumulate.
  let _ = session.disconnect().await;
  end
}

/// Why a one-shot turn ended without a usable answer.
fn incomplete_detail(text: &TextAcc, end: &DrainEnd, fallback: &str) -> String {
  if let Some(e) = &text.errored {
    e.clone()
  } else if matches!(end, DrainEnd::TimedOut) {
    "It timed out.".to_string()
  } else {
    fallback.to_string()
  }
}

/// Run one deep review, streaming findings, rule results, and activity through
/// `emit`. The caller sends the terminal `error`/`done` events.
async fn review(run: &RunCtx<'_>, request: &AdvisorRunRequest, emit: Emit) -> AdvisorReport {
  let rules = catalog::ai_rules_for(&request.facts.conditions);
  let log = SharedLog::default();
  let ctx = Arc::new(ReviewContext {
    emit: emit.clone(),
    core: ReviewCore {
      root: PathBuf::from(run.root),
      log: log.clone(),
      rules: rules
        .iter()
        .map(|r| (r.id.clone(), RuleMeta { category: r.category.clone(), severity: r.severity.clone() }))
        .collect(),
    },
  });
  let mut opts = read_only_options(run.root);
  opts.tools = tools::review_tools(ctx);

  let mut text = TextAcc::default();
  let mut activity = Activity::default();
  let end = one_shot(run, opts, prompt::review_prompt(request, &rules), RUN_TIMEOUT_MS, |event_type, data| {
    if let Some(tool) = activity.feed(event_type, data) {
      emit(AdvisorEvent::Activity { tool });
    }
    text.feed(event_type, data);
    is_terminal(event_type)
  })
  .await;
  match end {
    Err(e) => failed_report(format!("Couldn't start the review. {e}")),
    Ok(DrainEnd::Cancelled) => failed_report("Review cancelled.".into()),
    Ok(end) => finalize_review(&log.lock().unwrap(), &rules, &text, &end),
  }
}

/// Stream a Markdown explanation of one finding to `on_delta` (`reset` means
/// discard what was streamed: it was narration before a tool call); resolves
/// with the full answer. `Err` is the message to show.
async fn explain(
  run: &RunCtx<'_>,
  finding: &AdvisorFinding,
  mut on_delta: impl FnMut(String, bool),
) -> Result<String, String> {
  let mut text = TextAcc::default();
  let opts = read_only_options(run.root);
  let end = one_shot(run, opts, prompt::explain_prompt(finding), EXPLAIN_TIMEOUT_MS, |event_type, data| {
    let chunk = text.feed(event_type, data);
    if is_narration(event_type, data) {
      on_delta(String::new(), true);
    } else if let Some(chunk) = chunk {
      on_delta(chunk, false);
    }
    is_terminal(event_type)
  })
  .await
  .map_err(|e| format!("Couldn't start the explanation. {e}"))?;
  if matches!(end, DrainEnd::Cancelled) {
    return Err("Explanation cancelled.".into());
  }
  let answer = text.answer();
  if answer.is_empty() {
    let detail = incomplete_detail(&text, &end, "Copilot ended without an explanation.");
    return Err(format!("Couldn't complete the explanation. {detail}"));
  }
  Ok(answer)
}

/// Re-check `findings`, streaming a `verdict` event per finding through `emit`;
/// resolves with every verdict. `Err` is the message to show.
async fn verify(
  run: &RunCtx<'_>,
  findings: &[AdvisorFinding],
  verify_id: &str,
  emit: Emit,
) -> Result<Vec<AdvisorVerdict>, String> {
  let verdicts = SharedVerdicts::default();
  let ctx = Arc::new(VerifyContext {
    emit,
    verify_id: verify_id.to_string(),
    finding_ids: findings.iter().map(|f| f.id.clone()).collect(),
    verdicts: verdicts.clone(),
  });
  let mut opts = read_only_options(run.root);
  opts.tools = tools::verify_tools(ctx);

  let mut text = TextAcc::default();
  let end = one_shot(run, opts, prompt::verify_prompt(findings), VERIFY_TIMEOUT_MS, |event_type, data| {
    text.feed(event_type, data);
    is_terminal(event_type)
  })
  .await
  .map_err(|e| format!("Couldn't start the verification. {e}"))?;
  if matches!(end, DrainEnd::Cancelled) {
    return Err("Verification cancelled.".into());
  }
  let verdicts = verdicts.lock().unwrap().clone();
  if verdicts.is_empty() {
    let detail = incomplete_detail(&text, &end, "Copilot ended without a verdict.");
    return Err(format!("Couldn't complete the verification. {detail}"));
  }
  Ok(verdicts)
}

/* ----------------------------- session commands ----------------------------- */

/// Run the Copilot deep review and return the resulting snapshot. Resolves with
/// a snapshot whose `report.ok` reflects success, except for caller errors
/// (unknown project, or a review already running). Completed reviews are saved.
#[tauri::command]
pub async fn advisor_run(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
  request: AdvisorRunRequest,
) -> Result<AdvisorSnapshot, String> {
  let Some(project) = store::find_project(&project_id) else {
    return Err("Project not found.".into());
  };
  let Some(token) = state.try_begin_advisor(&project_id) else {
    return Err("A review is already running for this project.".into());
  };
  let started = Instant::now();
  let emit = emitter(&app, &project_id);
  let run = RunCtx {
    copilot: &state.copilot,
    byok: &state.byok,
    root: &project.path,
    choice: ModelChoice::new(
      request.model.clone(),
      request.effort.clone(),
      request.auto_tier.clone(),
      request.context_tier.clone(),
    ),
    token: &token,
  };
  let report = review(&run, &request, emit.clone()).await;
  state.end_advisor(&project_id, &token);
  if !report.ok {
    emit(AdvisorEvent::Error { text: report.summary.clone() });
  }
  emit(AdvisorEvent::Done { ok: report.ok });

  let rayfin_version = request
    .facts
    .versions
    .iter()
    .find(|v| v.name == "@microsoft/rayfin-cli")
    .and_then(|v| v.installed.clone());
  let mut snapshot = AdvisorSnapshot {
    schema_version: Some(SNAPSHOT_SCHEMA),
    report,
    analyzed_at: chrono::Utc::now().to_rfc3339(),
    duration_ms: started.elapsed().as_millis() as u64,
    stale: false,
    fingerprint: String::new(),
    catalog_version: Some(catalog::CATALOG.catalog_version.clone()),
    model: request.model.clone().filter(|m| !m.trim().is_empty() && m != "auto"),
    rayfin_version,
  };
  // Only persist a completed review, so a failed or cancelled run never
  // clobbers a good saved one.
  if snapshot.report.ok {
    snapshot.fingerprint = fingerprint(&project.path);
    save_snapshot(&project_id, &snapshot);
  }
  Ok(snapshot)
}

/// Cancel the in-flight deep review for a project, if any.
#[tauri::command]
pub fn advisor_cancel(state: State<'_, AppState>, project_id: String) -> bool {
  state.cancel_advisor(&project_id)
}

/// Explain a single finding inline on a throwaway, read-only session, streaming
/// the Markdown answer as `explainDelta` events routed by `explain_id` and
/// resolving with the full text. Emits a terminal `explainDone` in every outcome.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn advisor_explain(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
  explain_id: String,
  finding: AdvisorFinding,
  model: Option<String>,
  effort: Option<String>,
  auto_tier: Option<String>,
  context_tier: Option<String>,
) -> Result<String, String> {
  let Some(project) = store::find_project(&project_id) else {
    return Err("Project not found.".into());
  };
  let Some(token) = state.try_begin_explain(&project_id) else {
    return Err("An explanation is already being generated for this project.".into());
  };
  let emit = emitter(&app, &project_id);
  let choice = ModelChoice::new(model, effort, auto_tier, context_tier);
  let run = RunCtx { copilot: &state.copilot, byok: &state.byok, root: &project.path, choice, token: &token };
  let result = explain(&run, &finding, |text, reset| {
    emit(AdvisorEvent::ExplainDelta { explain_id: explain_id.clone(), text, reset });
  })
  .await;
  state.end_explain(&project_id, &token);
  emit(AdvisorEvent::ExplainDone { explain_id, ok: result.is_ok(), error: result.as_ref().err().cloned() });
  result
}

/// Cancel the in-flight inline explanation for a project, if any.
#[tauri::command]
pub fn advisor_explain_cancel(state: State<'_, AppState>, project_id: String) -> bool {
  state.cancel_explain(&project_id)
}

/// Re-check deep-review findings after a fix on a short read-only session,
/// streaming a `verdict` per finding and resolving with all verdicts. Emits a
/// terminal `verifyDone` in every outcome.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn advisor_verify(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
  verify_id: String,
  findings: Vec<AdvisorFinding>,
  model: Option<String>,
  effort: Option<String>,
  auto_tier: Option<String>,
  context_tier: Option<String>,
) -> Result<Vec<AdvisorVerdict>, String> {
  let Some(project) = store::find_project(&project_id) else {
    return Err("Project not found.".into());
  };
  let findings: Vec<AdvisorFinding> = findings.into_iter().take(MAX_VERIFY_FINDINGS).collect();
  let emit = emitter(&app, &project_id);
  if findings.is_empty() {
    emit(AdvisorEvent::VerifyDone { verify_id, ok: true, error: None });
    return Ok(vec![]);
  }
  let Some(token) = state.try_begin_verify(&project_id) else {
    return Err("A verification is already running for this project.".into());
  };
  let choice = ModelChoice::new(model, effort, auto_tier, context_tier);
  let run = RunCtx { copilot: &state.copilot, byok: &state.byok, root: &project.path, choice, token: &token };
  let result = verify(&run, &findings, &verify_id, emit.clone()).await;
  state.end_verify(&project_id, &token);
  emit(AdvisorEvent::VerifyDone { verify_id, ok: result.is_ok(), error: result.as_ref().err().cloned() });
  result
}

/// Cancel the in-flight verification for a project, if any.
#[tauri::command]
pub fn advisor_verify_cancel(state: State<'_, AppState>, project_id: String) -> bool {
  state.cancel_verify(&project_id)
}
#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  /// A `permission.requested` payload as the runtime sends it (CLI 1.0.71):
  /// the request is nested and the SDK's top-level `kind` is unset.
  fn request(body: Value) -> PermissionRequestData {
    serde_json::from_value(json!({
      "requestId": "r1",
      "permissionRequest": body,
      "promptRequest": body,
    }))
    .unwrap()
  }

  #[test]
  fn permissions_allow_only_read_only_actions() {
    let root = std::env::temp_dir().join("advisor-perm-root");
    let inside = root.join("src").join("App.tsx");
    let outside = std::env::temp_dir().join("elsewhere.txt");
    let read = |path: &str| request(json!({ "kind": "read", "intention": "Read file", "path": path }));
    let url = |u: &str| request(json!({ "kind": "url", "intention": "Fetch", "url": u }));
    assert!(read(&inside.to_string_lossy()).kind.is_none(), "the SDK leaves nested kinds unset");
    assert!(permitted(&root, &read(&root.to_string_lossy())));
    assert!(permitted(&root, &read(&inside.to_string_lossy())));
    assert!(permitted(&root, &read("node_modules/@microsoft/rayfin-guide/README.md")));
    assert!(!permitted(&root, &read(&outside.to_string_lossy())));
    assert!(!permitted(&root, &request(json!({ "kind": "read", "intention": "Read" }))));
    assert!(!permitted(
      &root,
      &request(json!({ "kind": "read", "path": inside.to_string_lossy(), "requestSandboxBypass": true }))
    ));
    assert!(!permitted(&root, &request(json!({ "kind": "write", "fileName": "src/App.tsx", "diff": "" }))));
    assert!(!permitted(&root, &request(json!({ "kind": "shell", "fullCommandText": "git status" }))));
    assert!(!permitted(&root, &request(json!({ "kind": "memory" }))));
    assert!(!permitted(&root, &request(json!({ "kind": "hook" }))));
    assert!(!permitted(&root, &request(json!({ "kind": "something-new" }))));
    assert!(!permitted(&root, &request(json!({}))));
    assert!(permitted(&root, &request(json!({ "kind": "custom-tool", "toolName": "fabricator_advisor_finding" }))));
    assert!(permitted(&root, &request(json!({ "kind": "mcp", "serverName": "rayfin", "readOnly": true }))));
    assert!(!permitted(&root, &request(json!({ "kind": "mcp", "serverName": "rayfin", "readOnly": false }))));
    assert!(permitted(&root, &url("https://rayfin.ai/docs/data/permissions.md")));
    assert!(!permitted(&root, &url("https://evil.example/?q=rayfin.ai")));
    assert!(!permitted(&root, &url("http://rayfin.ai/llms.txt")));
    assert!(!permitted(&root, &url("https://rayfin.ai.evil.example/")));
    assert!(!permitted(
      &root,
      &request(json!({ "kind": "url", "url": "https://rayfin.ai/llms.txt", "requestSandboxBypass": true }))
    ));
    assert!(!permitted(&root, &request(json!({ "kind": "url" }))));
  }

  #[test]
  fn other_sandboxes_allow_only_their_own_hosts_and_can_refuse_mcp() {
    const DOCS: Sandbox = Sandbox { url_hosts: &["learn.microsoft.com", "docs.github.com"], read_only_mcp: false };
    let root = std::env::temp_dir().join("diagnosis-perm-root");
    let url = |u: &str| request(json!({ "kind": "url", "intention": "Fetch", "url": u }));
    assert!(permitted_in(&root, DOCS, &url("https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes")));
    assert!(permitted_in(&root, DOCS, &url("https://docs.github.com/en/actions")));
    assert!(!permitted_in(&root, DOCS, &url("https://rayfin.ai/llms.txt")));
    assert!(!permitted_in(&root, DOCS, &url("https://learn.microsoft.com.evil.example/")));
    assert!(!permitted_in(&root, DOCS, &request(json!({ "kind": "mcp", "serverName": "rayfin", "readOnly": true }))));
    assert!(!permitted_in(&root, DOCS, &request(json!({ "kind": "shell", "fullCommandText": "az ad app list" }))));
    assert!(!permitted_in(&root, DOCS, &request(json!({ "kind": "read", "path": std::env::temp_dir().join("x.txt").to_string_lossy() }))));
    assert!(permitted_in(&root, DOCS, &request(json!({ "kind": "custom-tool", "toolName": "fabricator_team_check" }))));
    // The Advisor's own sandbox is unchanged.
    assert!(permitted_in(&root, ADVISOR_SANDBOX, &request(json!({ "kind": "mcp", "serverName": "rayfin", "readOnly": true }))));
  }

  #[test]
  fn permissions_accept_flat_and_typed_requests() {
    let root = std::env::temp_dir().join("advisor-perm-root");
    let inside = root.join("src").join("App.tsx");
    let flat: PermissionRequestData =
      serde_json::from_value(json!({ "kind": "read", "path": inside.to_string_lossy() })).unwrap();
    assert!(permitted(&root, &flat));
    let typed = PermissionRequestData {
      kind: Some(PermissionRequestKind::Write),
      tool_call_id: None,
      extra: json!({ "fileName": "src/App.tsx" }),
      ..Default::default()
    };
    assert!(!permitted(&root, &typed));
  }

  #[tokio::test]
  async fn denials_fail_only_the_call() {
    let root = std::env::temp_dir().join("advisor-perm-root");
    let policy = ReadOnlyPolicy { root: root.clone(), sandbox: ADVISOR_SANDBOX };
    let decide = |body: Value| policy.handle(SessionId::from("s"), RequestId::new("1"), request(body));
    assert!(matches!(
      decide(json!({ "kind": "shell", "fullCommandText": "rm -rf ." })).await,
      PermissionResult::Decision { decision: github_copilot_sdk::PermissionDecision::UserNotAvailable(_), .. }
    ));
    assert!(matches!(
      decide(json!({ "kind": "read", "path": root.join("rayfin").to_string_lossy() })).await,
      PermissionResult::Decision { decision: github_copilot_sdk::PermissionDecision::ApproveOnce(_), .. }
    ));
  }

  #[test]
  fn secret_files_are_never_read() {
    let root = std::env::temp_dir().join("advisor-perm-root");
    let read = |rel: &str| request(json!({ "kind": "read", "path": root.join(rel).to_string_lossy() }));
    for secret in [".env", ".env.local", "rayfin/.env", "rayfin/.env.production", ".npmrc", "certs/dev.pem", ".envrc"] {
      assert!(!permitted(&root, &read(secret)), "{secret} must be blocked");
    }
    for fine in [".env.example", "rayfin/.env.sample", "src/env.ts", "src/vite-env.d.ts", "rayfin/rayfin.yml"] {
      assert!(permitted(&root, &read(fine)), "{fine} must be readable");
    }
  }

  #[test]
  fn answers_drop_narration_before_tool_calls() {
    let mut acc = TextAcc::default();
    let delta = |id: &str, t: &str| json!({ "messageId": id, "deltaContent": t });
    assert_eq!(acc.feed("assistant.message_delta", &delta("m1", "Let me check ")).as_deref(), Some("Let me check "));
    acc.feed("assistant.message_delta", &delta("m1", "the docs."));
    let narration = json!({ "messageId": "m1", "content": "Let me check the docs.", "toolRequests": [{ "name": "view" }] });
    assert!(is_narration("assistant.message", &narration));
    assert_eq!(acc.feed("assistant.message", &narration), None);
    acc.feed("assistant.message_delta", &delta("m2", "## Why"));
    let last = json!({ "messageId": "m2", "content": "## Why it matters", "toolRequests": [] });
    assert!(!is_narration("assistant.message", &last));
    assert_eq!(acc.feed("assistant.message", &last).as_deref(), Some(" it matters"));
    assert_eq!(acc.answer(), "## Why it matters");
    assert!(acc.text.starts_with("Let me check the docs."));
  }

  #[test]
  fn fallback_json_reports_still_parse() {
    let text = "Done.\n```json\n{\"summary\":\"s\",\"findings\":[{\"id\":\"x\",\"category\":\"auth\",\"severity\":\"high\",\"title\":\"t\",\"detail\":\"d\",\"recommendation\":\"r\"}]}\n```";
    let raw = extract_report(text).unwrap();
    assert_eq!(raw.summary, "s");
    assert_eq!(raw.findings.len(), 1);
    let allowed: HashSet<String> = ["queries/unpaginated-list".to_string()].into_iter().collect();
    let f = normalize_fallback(raw.findings.into_iter().next().unwrap(), &allowed);
    assert_eq!(f.source, "ai");
    assert_eq!(f.verified, Some(false));
    assert_eq!(f.rule_id, "");
    assert_eq!(f.id, "x");
  }

  #[test]
  fn fallback_findings_fold_into_one_per_rule() {
    let text = r#"```json
{"summary":"s","findings":[
  {"id":"a","ruleId":"queries/unpaginated-list","severity":"medium","title":"t1","detail":"d","recommendation":"r","file":"src/a.ts","line":3},
  {"id":"b","ruleId":"queries/unpaginated-list","severity":"high","title":"t2","detail":"d","recommendation":"r","file":"src/b.ts","line":9}
]}
```"#;
    let allowed: HashSet<String> = ["queries/unpaginated-list".to_string()].into_iter().collect();
    let raw = extract_report(text).unwrap();
    let folded = fold_by_id(raw.findings.into_iter().map(|f| normalize_fallback(f, &allowed)));
    assert_eq!(folded.len(), 1);
    assert_eq!(folded[0].id, "ai:queries/unpaginated-list");
    assert_eq!(folded[0].severity, "high");
    assert_eq!(folded[0].file.as_deref(), Some("src/a.ts"));
    assert_eq!(folded[0].locations.len(), 1);
    assert_eq!(folded[0].locations[0].file, "src/b.ts");
    assert_eq!(folded[0].locations[0].line, Some(9));
  }

  #[test]
  fn legacy_snapshots_deserialize_with_defaults() {
    let legacy = r#"{"report":{"ok":true,"summary":"s","findings":[{"id":"lead-fetch","category":"performance","severity":"medium","title":"t","detail":"d","file":"src/a.ts","recommendation":"r"}]},"analyzedAt":"2026-07-05T08:13:23Z","durationMs":1,"stale":false,"fingerprint":"abc"}"#;
    let snap: AdvisorSnapshot = serde_json::from_str(legacy).unwrap();
    assert!(snap.schema_version.is_none());
    assert!(snap.report.rules.is_none());
    let f = &snap.report.findings[0];
    assert_eq!(f.source, "ai");
    assert!(f.rule_id.is_empty());
    assert_eq!(f.file.as_deref(), Some("src/a.ts"));
  }

  #[test]
  fn finalize_marks_unreported_rules_and_early_stops() {
    let rules = catalog::ai_rules_for(&["data".to_string()]);
    let mut log = tools::ReviewLog::default();
    log.findings.push(AdvisorFinding {
      id: "ai:queries/unpaginated-list:1".into(),
      rule_id: "queries/unpaginated-list".into(),
      severity: "high".into(),
      ..Default::default()
    });
    let report = finalize_review(&log, &rules, &TextAcc::default(), &DrainEnd::TimedOut);
    assert!(report.ok);
    assert!(report.summary.contains("stopped early"));
    let results = report.rules.unwrap();
    assert_eq!(results.len(), rules.len());
    assert_eq!(results.iter().find(|r| r.rule_id == "queries/unpaginated-list").unwrap().status, "fail");
    assert!(results.iter().filter(|r| r.rule_id != "queries/unpaginated-list").all(|r| r.status == "skipped"));

    let empty = finalize_review(&tools::ReviewLog::default(), &rules, &TextAcc::default(), &DrainEnd::Finished);
    assert!(!empty.ok);
  }
}
