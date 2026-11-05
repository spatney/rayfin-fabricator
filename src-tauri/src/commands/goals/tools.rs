//! Client-defined tools a Goals run checks the app through. Copilot calls the
//! copy of the app's backend as its users with `fabricator_goals_call`, and
//! reports each check with `fabricator_goals_result`. Fabricator numbers the
//! calls and keeps what each asked and how the app answered: a check passes
//! only on calls it names, so its evidence is what the app did, never what
//! Copilot read in the code. A draft proposes the goals through its own tool.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::{ToolInvocation, ToolResultExpanded};
use github_copilot_sdk::{Error as SdkError, Tool, ToolResult};
use serde::Deserialize;
use serde_json::{json, Value};

use super::file;
use super::scratch::Handle;
use crate::services::agent_tools::{call_report_reading, parse_call, who, CallParams, CallRequest};
use crate::services::diagnostics::redact_secrets;
use crate::services::local_backend::{AppCall, AppResponse, CallAs, ControlClient};
use crate::types::{GoalCheck, GoalResult, GoalStatus, GoalsEvent, GoalsProposal};

pub(super) const CALL_TOOL: &str = "fabricator_goals_call";
pub(super) const RESULT_TOOL: &str = "fabricator_goals_result";
pub(super) const COMPLETE_TOOL: &str = "fabricator_goals_complete";
pub(super) const PROPOSE_TOOL: &str = "fabricator_goals_propose";

const MAX_SUMMARY: usize = 400;
const MAX_NOTES: usize = 4;
const MAX_CALLS_SHOWN: usize = 5;
const MAX_LINE: usize = 300;
const MAX_ASKED: usize = 160;
const MAX_ANSWER: usize = 140;
/// The most checks a draft proposes.
const MAX_DRAFTED: usize = 12;
/// Lines of the copy's output a failed call shows.
const OUTPUT_LINES: usize = 30;
const STATUSES: [&str; 3] = ["passed", "failed", "not_proven"];
const ARROW: &str = "Its values can't be read here, so this call doesn't show what they are: a check that depends on \
                     them is not_proven by it.";

/// The run's own reporting tools, which the activity feed leaves out. Its calls to the app stay in.
pub(super) fn is_reporting_tool(name: &str) -> bool {
  name.starts_with("fabricator_goals_") && name != CALL_TOOL
}

fn clip(text: &str, max: usize) -> String {
  let t = text.trim();
  if t.chars().count() <= max {
    return t.to_string();
  }
  let cut: String = t.chars().take(max.saturating_sub(1)).collect();
  format!("{}…", cut.trim_end())
}

/// `text` on one line, clipped, without secrets.
fn line(text: &str, max: usize) -> String {
  clip(&redact_secrets(&file::tidy(text)), max)
}

fn status_of(value: &str) -> Option<GoalStatus> {
  match value.trim().to_ascii_lowercase().replace(['-', ' '], "_").as_str() {
    "passed" | "pass" | "passes" | "met" => Some(GoalStatus::Passed),
    "failed" | "fail" | "fails" | "not_met" => Some(GoalStatus::Failed),
    "not_proven" | "notproven" | "unproven" | "inconclusive" | "unknown" => Some(GoalStatus::NotProven),
    _ => None,
  }
}

/* --------------------------------- calls --------------------------------- */

/// What a call asked, in short.
fn asked(request: &CallRequest) -> String {
  let body = &request.body;
  let graphql = || {
    let mut text = line(body.get("query").and_then(Value::as_str).unwrap_or_default(), MAX_ASKED);
    if let Some(variables) = body.get("variables").filter(|v| v.as_object().is_some_and(|o| !o.is_empty())) {
      text = format!("{text} with {}", line(&variables.to_string(), MAX_ASKED / 2));
    }
    text
  };
  let name = request.name.as_deref().unwrap_or("?");
  if request.path == "/graphql" {
    graphql()
  } else if request.path.starts_with("/connectors/") {
    format!("connector {name}: {}", graphql())
  } else if request.path.starts_with("/functions/") {
    format!("function {name} {}", line(&body.to_string(), MAX_ASKED))
  } else {
    format!("connector {name} {}", line(&body.to_string(), MAX_ASKED))
  }
}

/// How the app answered a call, in short: its status, and the GraphQL error
/// that refused it or the start of the answer.
fn answered(response: &AppResponse) -> String {
  let body = response.body.trim();
  let content_type = response.content_type.as_deref().unwrap_or_default().to_ascii_lowercase();
  let text = if content_type.contains("arrow") {
    "an Apache Arrow stream".to_string()
  } else if body.is_empty() {
    "no body".to_string()
  } else {
    match serde_json::from_str::<Value>(body) {
      Ok(answer) => match answer.get("errors").and_then(Value::as_array).and_then(|errors| errors.first()) {
        Some(error) => {
          let message = error.get("message").and_then(Value::as_str).unwrap_or("an error");
          let code = error.pointer("/extensions/code").and_then(Value::as_str);
          let code = code.map(|c| format!(" ({c})")).unwrap_or_default();
          format!("GraphQL error: {}{code}", line(message, MAX_ANSWER))
        }
        None => line(&answer.to_string(), MAX_ANSWER),
      },
      Err(_) => line(body, MAX_ANSWER),
    }
  };
  format!("{} {text}", response.status)
}

/// One call as evidence: who made it, what it asked and how the app answered.
pub(super) fn call_line(request: &CallRequest, response: &AppResponse) -> String {
  clip(&format!("{}: {} → {}", who(&request.call_as), asked(request), answered(response)), MAX_LINE)
}

/// Who made a call, as the app's rules see them: the id they compare with
/// `claims.sub`, which the rows a user owns carry, and the email.
async fn caller_note(control: &ControlClient, call_as: &CallAs) -> Option<String> {
  let users = match call_as {
    CallAs::Anonymous => return None,
    _ => control.users().await.ok()?,
  };
  let user = users.iter().find(|u| match call_as {
    CallAs::Developer => u.developer,
    CallAs::User { user, .. } => {
      u.id == *user
        || u.username.eq_ignore_ascii_case(user)
        || u.email.as_deref().is_some_and(|email| email.eq_ignore_ascii_case(user))
    }
    CallAs::Anonymous => false,
  })?;
  let email = user.email.as_deref().map(|email| format!(" and their email (`claims.email`) is {email}")).unwrap_or_default();
  Some(format!("The caller's id (`claims.sub`) is {}{email}.", user.id))
}

/// Whether a GraphQL document holds a mutation (outside its strings and comments).
fn is_mutation(query: &str) -> bool {
  let mut code = String::new();
  let mut chars = query.chars();
  while let Some(c) = chars.next() {
    match c {
      '#' => {
        chars.by_ref().find(|c| *c == '\n');
        code.push(' ');
      }
      '"' => {
        let mut escaped = false;
        for c in chars.by_ref() {
          match c {
            '\\' if !escaped => escaped = true,
            '"' if !escaped => break,
            _ => escaped = false,
          }
        }
        code.push(' ');
      }
      c => code.push(c),
    }
  }
  code.split(|c: char| !(c.is_alphanumeric() || c == '_')).any(|word| word == "mutation")
}

/// Why Fabricator won't make a call that could change data outside the app: a
/// SQL connector's data API reaches its real database, as the developer.
fn outside_change(request: &CallRequest) -> Option<String> {
  let query = request.body.get("query").and_then(Value::as_str)?;
  (request.path.starts_with("/connectors/") && is_mutation(query)).then(|| {
    format!(
      "Goals checks don't change data outside the app, and connector {} reaches its real database, as the \
       developer. Only read through it, and report a check that needs a change there as not_proven.",
      request.name.as_deref().unwrap_or("?")
    )
  })
}

/* -------------------------------- results -------------------------------- */

/// Everything the run has reported.
#[derive(Default)]
pub(super) struct RunLog {
  pub results: Vec<GoalResult>,
  pub summary: Option<String>,
  /// Copilot called the completing tool, and it was taken.
  pub completed: bool,
  /// Each call to the copy, as [`call_line`] has it: call `n` is at `n - 1`.
  calls: Vec<String>,
  /// Copilot tried to finish with checks left once.
  nagged: bool,
}

/// What the tools check reports against (no copy, so it can be unit-tested).
pub(super) struct RunCore {
  pub checks: Vec<GoalCheck>,
  /// The app's code the run checks ([`super::scratch::app_fingerprint`]).
  pub fingerprint: String,
  pub log: Mutex<RunLog>,
}

impl RunCore {
  pub(super) fn new(checks: Vec<GoalCheck>, fingerprint: String) -> Self {
    Self { checks, fingerprint, log: Mutex::new(RunLog::default()) }
  }

  /// The checks without a result yet.
  pub(super) fn left(&self) -> Vec<GoalCheck> {
    let log = self.log.lock().unwrap();
    self.checks.iter().filter(|c| !log.results.iter().any(|r| r.check_id == c.id)).cloned().collect()
  }

  /// Keep a call as evidence; its number.
  fn record_call(&self, line: String) -> usize {
    let mut log = self.log.lock().unwrap();
    log.calls.push(line);
    log.calls.len()
  }
}

/// Checks as `id (text)`, for Copilot.
fn listed(checks: &[GoalCheck]) -> String {
  checks.iter().map(|c| format!("{} ({})", c.id, clip(&c.text, 80))).collect::<Vec<_>>().join("; ")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResultParams {
  #[serde(alias = "check", alias = "id")]
  check_id: String,
  status: String,
  #[serde(default)]
  summary: String,
  /// Call numbers, as numbers or text such as `"3"`.
  #[serde(default)]
  calls: Vec<Value>,
  #[serde(default, alias = "notes")]
  evidence: Vec<String>,
}

fn call_number(value: &Value) -> Option<usize> {
  match value {
    Value::Number(n) => n.as_u64().map(|n| n as usize),
    Value::String(text) => text.trim().trim_start_matches(|c: char| !c.is_ascii_digit()).parse().ok(),
    _ => None,
  }
}

/// Check one reported result and record it (a check reported again keeps the
/// last). `Err` is the message Copilot gets back to correct its report.
pub(super) fn record_result(core: &RunCore, p: ResultParams) -> Result<GoalResult, String> {
  let id = p.check_id.trim();
  let Some(check) = core.checks.iter().find(|c| c.id == id) else {
    return Err(format!("Unknown checkId `{id}`. Use one of: {}.", listed(&core.checks)));
  };
  let Some(status) = status_of(&p.status) else {
    return Err("status must be passed, failed or not_proven.".into());
  };
  let summary = line(&p.summary, MAX_SUMMARY);
  if summary.is_empty() {
    return Err("summary is required: say in a sentence or two what the calls showed, or why it couldn't be shown.".into());
  }
  let notes: Vec<String> =
    p.evidence.iter().map(|note| line(note, MAX_LINE)).filter(|note| !note.is_empty()).take(MAX_NOTES).collect();

  let mut log = core.log.lock().unwrap();
  let made = log.calls.len();
  let mut numbers: Vec<usize> = Vec::new();
  for raw in &p.calls {
    match call_number(raw).filter(|n| (1..=made).contains(n)) {
      Some(n) if !numbers.contains(&n) => numbers.push(n),
      Some(_) => {}
      None if made == 0 => return Err("This run hasn't called the app yet, so there are no calls to name.".into()),
      None => return Err(format!("There's no call {raw} in this run: name calls by their numbers, 1 to {made}.")),
    }
  }
  if status == GoalStatus::Passed && numbers.is_empty() {
    return Err(if made == 0 {
      format!(
        "A check passes only on calls to the app that show it, and this run hasn't made any. Call the app with \
         {CALL_TOOL} as the check's users, then report again, or report not_proven with the reason."
      )
    } else {
      format!("Name the calls that show it passes in `calls`: their numbers from {CALL_TOOL}'s answers.")
    });
  }
  if status == GoalStatus::Failed && numbers.is_empty() && notes.is_empty() {
    return Err("Show why it fails: name the calls that show it in `calls`, or say in `evidence` what's missing from the app.".into());
  }
  let result = GoalResult {
    check_id: check.id.clone(),
    check: check.text.clone(),
    status,
    summary,
    calls: numbers.iter().take(MAX_CALLS_SHOWN).map(|n| log.calls[n - 1].clone()).collect(),
    evidence: notes,
    ran_at: chrono::Utc::now().to_rfc3339(),
    fingerprint: core.fingerprint.clone(),
    stale: false,
  };
  log.results.retain(|r| r.check_id != result.check_id);
  log.results.push(result.clone());
  Ok(result)
}

/// Record the end of the run. Copilot is sent back once to report the checks it left.
pub(super) fn record_completion(core: &RunCore, summary: &str) -> Result<(), String> {
  let left = core.left();
  let mut log = core.log.lock().unwrap();
  if !left.is_empty() && !log.nagged {
    log.nagged = true;
    return Err(format!(
      "These checks have no result yet: {}. Report each with {RESULT_TOOL} (not_proven, with the reason, when you \
       can't show it either way), then call {COMPLETE_TOOL} again.",
      listed(&left)
    ));
  }
  log.completed = true;
  log.summary = Some(line(summary, MAX_SUMMARY)).filter(|s| !s.is_empty());
  Ok(())
}

/* --------------------------------- tools --------------------------------- */

fn ok(text: impl Into<String>) -> ToolResult {
  ToolResult::Expanded(ToolResultExpanded::new(text.into(), "success"))
}

fn fail(text: impl Into<String>) -> ToolResult {
  let text = text.into();
  ToolResult::Expanded(ToolResultExpanded::new(text.clone(), "failure").with_error(text))
}

/// Delivers an event to the window (a closure, so the tools don't need a Tauri handle).
pub(super) type Emit = Arc<dyn Fn(GoalsEvent) + Send + Sync>;

pub(super) struct RunContext {
  pub emit: Emit,
  pub copy: Handle,
  pub core: RunCore,
}

struct CallTool(Arc<RunContext>);
struct ResultTool(Arc<RunContext>);
struct CompleteTool(Arc<RunContext>);

#[async_trait]
impl ToolHandler for CallTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<CallParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid arguments: {e}"))),
    };
    let request = match parse_call(params) {
      Ok(request) => request,
      Err(message) => return Ok(fail(message)),
    };
    if let Some(refusal) = outside_change(&request) {
      return Ok(fail(refusal));
    }
    let ctx = &self.0;
    let control = match ctx.copy.control().await {
      Ok(control) => control,
      Err(e) => return Ok(fail(format!("The copy of the app can't take calls: {e}"))),
    };
    let call = AppCall {
      method: reqwest::Method::POST,
      path: request.path.clone(),
      body: Some(request.body.clone()),
      call_as: request.call_as.clone(),
    };
    match control.call_app(call).await {
      Ok(response) => {
        let n = ctx.core.record_call(call_line(&request, &response));
        let caller: Vec<String> = caller_note(&control, &request.call_as).await.into_iter().collect();
        let mut text = format!("Call {n}.\n");
        text.push_str(&call_report_reading(&request, &response, &caller, "the copy's output, shown below", ARROW));
        if response.status >= 500 {
          let output = ctx.copy.recent_output(OUTPUT_LINES);
          if !output.is_empty() {
            text.push_str(&format!("\n\nThe copy's recent output (oldest first, UTC):\n{}", redact_secrets(&output)));
          }
        }
        Ok(ok(text))
      }
      Err(e) => Ok(fail(format!("Calling {} {} failed: {e}", request.path, who(&request.call_as)))),
    }
  }
}

#[async_trait]
impl ToolHandler for ResultTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<ResultParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid result: {e}"))),
    };
    let ctx = &self.0;
    match record_result(&ctx.core, params) {
      Ok(result) => {
        (ctx.emit)(GoalsEvent::Result { result });
        let left = ctx.core.left();
        Ok(ok(if left.is_empty() {
          format!("Recorded. That was the last check: call {COMPLETE_TOOL} with a short summary.")
        } else {
          format!("Recorded. Checks left: {}.", listed(&left))
        }))
      }
      Err(message) => Ok(fail(message)),
    }
  }
}

#[derive(Deserialize)]
struct CompleteParams {
  #[serde(default)]
  summary: String,
}

#[async_trait]
impl ToolHandler for CompleteTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<CompleteParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid completion: {e}"))),
    };
    match record_completion(&self.0.core, &params.summary) {
      Ok(()) => Ok(ok("Run recorded. Reply with one short sentence and stop.")),
      Err(message) => Ok(fail(message)),
    }
  }
}

/// The tools a run checks the app and reports through.
pub(super) fn run_tools(ctx: Arc<RunContext>) -> Vec<Tool> {
  let ids: Vec<String> = ctx.core.checks.iter().map(|c| c.id.clone()).collect();
  let call = Tool::new(CALL_TOOL)
    .with_description(
      "Call the copy of the app's backend the way its frontend does, as one of its users. The copy has its own \
       database, loaded from the app's seed data, so what you create, change or delete stays in it. `target` \
       picks the route: `graphql` (POST /graphql, the data API; body {\"query\": \"…\", \"variables\": {…}}), \
       `function` (POST /functions/<name>/invoke; body: the function's input), `connector` (POST \
       /connector-invoke/<name>; body {\"operation\": \"…\", \"input\": {…}}) or `connector-graphql` (POST \
       /connectors/<name>/graphql, a SQL connector's data API; queries only). `as` is who calls: `developer` (the \
       default), `anonymous` (signed out) or `user:<email>`, a test user created when missing. Returns the call's \
       number, the caller's id (`claims.sub`), the HTTP status and the answer. Name the calls that show a check \
       when you report it.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "target": {
          "type": "string",
          "enum": ["graphql", "function", "connector", "connector-graphql"],
          "description": "The route: the data API (graphql), a function, a connector, or a SQL connector's data API (connector-graphql)."
        },
        "name": { "type": "string", "description": "The function's or the connector's name. Not used with graphql." },
        "body": {
          "type": "object",
          "description": "The JSON request body: {\"query\", \"variables\"} for graphql and connector-graphql, the function's input for function, {\"operation\", \"input\"} for connector."
        },
        "as": {
          "type": "string",
          "description": "Who calls: developer (the default), anonymous (signed out), or user:<email> for a test user, created when missing, such as user:ana@example.com."
        }
      },
      "required": ["target"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(CallTool(ctx.clone())));
  let result = Tool::new(RESULT_TOOL)
    .with_description(
      "Report one check's outcome as soon as you know it. passed: calls you made show everything the check says; \
       name them in `calls`. failed: calls show the app doesn't do it, or the app has nothing that could. \
       not_proven: you couldn't show it either way by calling the app; say why. Reading the code never passes a \
       check.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "checkId": { "type": "string", "enum": ids },
        "status": { "type": "string", "enum": STATUSES },
        "summary": {
          "type": "string",
          "description": "One or two plain sentences for the app's maker, under 50 words: what the calls showed, or why it couldn't be shown. Name the users by role."
        },
        "calls": {
          "type": "array",
          "items": { "type": "integer", "minimum": 1 },
          "description": "The numbers of the calls that show it, from fabricator_goals_call's answers. Required for passed."
        },
        "evidence": {
          "type": "array",
          "maxItems": MAX_NOTES,
          "items": { "type": "string" },
          "description": "Up to 4 short lines: what those answers showed (such as 'Ana's list had her 2 deals and no one else's'), or what's missing from the app."
        }
      },
      "required": ["checkId", "status", "summary"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(ResultTool(ctx.clone())));
  let complete = Tool::new(COMPLETE_TOOL)
    .with_description("Finish the run, last, once every check has a result: a plain summary for the app's maker.")
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "summary": { "type": "string", "description": "One or two short sentences, under 40 words: does the app still do what it's for?" }
      },
      "required": ["summary"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(CompleteTool(ctx)));
  vec![call, result, complete]
}

/* --------------------------------- draft --------------------------------- */

/// What a draft proposed.
#[derive(Default)]
pub(super) struct DraftContext {
  pub proposal: Mutex<Option<GoalsProposal>>,
}

#[derive(Deserialize)]
pub(super) struct ProposeParams {
  #[serde(default)]
  purpose: String,
  #[serde(default)]
  checks: Vec<String>,
}

/// Check a proposal and keep it (a later one replaces it).
pub(super) fn record_proposal(ctx: &DraftContext, p: ProposeParams) -> Result<GoalsProposal, String> {
  let checks: Vec<String> = p.checks.iter().map(|check| redact_secrets(check)).collect();
  let (purpose, checks) = file::validate(&redact_secrets(&p.purpose), &checks)?;
  if purpose.is_empty() {
    return Err("Say in `purpose` what the app is for, and who uses it.".into());
  }
  if checks.is_empty() {
    return Err("Propose at least one check.".into());
  }
  if checks.len() > MAX_DRAFTED {
    return Err(format!("Propose at most {MAX_DRAFTED} checks: the ones that matter most."));
  }
  let proposal = GoalsProposal { purpose, checks };
  *ctx.proposal.lock().unwrap() = Some(proposal.clone());
  Ok(proposal)
}

struct ProposeTool(Arc<DraftContext>);

#[async_trait]
impl ToolHandler for ProposeTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<ProposeParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid proposal: {e}"))),
    };
    match record_proposal(&self.0, params) {
      Ok(_) => Ok(ok("Proposal recorded. Reply with one short sentence and stop.")),
      Err(message) => Ok(fail(message)),
    }
  }
}

/// The tool a draft proposes the goals through.
pub(super) fn draft_tools(ctx: Arc<DraftContext>) -> Vec<Tool> {
  vec![Tool::new(PROPOSE_TOOL)
    .with_description(
      "Propose the app's goals, once, last: what it's for, and the checks it must keep passing, in the words of \
       the people who use it.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "purpose": {
          "type": "string",
          "description": "Two to four plain sentences: what the app is for, who uses it, and what each kind of user does with it."
        },
        "checks": {
          "type": "array",
          "minItems": 1,
          "maxItems": MAX_DRAFTED,
          "items": { "type": "string" },
          "description": "3 to 8 checks, one sentence each, under 25 words: something a kind of user must be able to do, or must not."
        }
      },
      "required": ["purpose", "checks"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(ProposeTool(ctx)))]
}

#[cfg(test)]
mod tests {
  use super::*;

  fn core() -> RunCore {
    let checks = file::with_ids(vec!["A rep can log a deal.".into(), "A rep can't see other reps' deals.".into()]);
    RunCore::new(checks, "fp".into())
  }

  fn report(core: &RunCore, n: usize, status: &str, calls: Value, evidence: &[&str]) -> Result<GoalResult, String> {
    let params = json!({
      "checkId": core.checks[n].id,
      "status": status,
      "summary": "  Ana logged a deal and saw it.  ",
      "calls": calls,
      "evidence": evidence,
    });
    record_result(core, serde_json::from_value(params).unwrap())
  }

  fn graphql(user: &str, query: &str) -> CallRequest {
    CallRequest {
      name: None,
      path: "/graphql".into(),
      body: json!({ "query": query }),
      call_as: CallAs::User { user: user.into(), create: true },
    }
  }

  fn answer(status: u16, body: Value) -> AppResponse {
    AppResponse { status, content_type: Some("application/json".into()), body: body.to_string() }
  }

  #[test]
  fn a_check_passes_only_on_calls_the_run_made() {
    let core = core();
    assert!(report(&core, 0, "passed", json!([]), &[]).unwrap_err().contains("hasn't made any"));
    assert!(report(&core, 0, "passed", json!([1]), &[]).unwrap_err().contains("hasn't called the app"));

    let line = call_line(&graphql("ana@example.com", "mutation { createDeal(item: {title: \"Q3\"}) { id } }"), &answer(200, json!({"data": {"createDeal": {"id": 1}}})));
    assert_eq!(core.record_call(line), 1);
    assert!(report(&core, 0, "passed", json!([2]), &[]).unwrap_err().contains("no call 2"));
    let result = report(&core, 0, "Passed", json!(["call 1", 1]), &["Ana's new deal came back with id 1."]).unwrap();
    assert_eq!(result.status, GoalStatus::Passed);
    assert_eq!(result.summary, "Ana logged a deal and saw it.");
    assert_eq!(result.calls.len(), 1, "a call named twice counts once");
    assert!(result.calls[0].starts_with("as user:ana@example.com: mutation { createDeal"), "{}", result.calls[0]);
    assert_eq!((result.fingerprint.as_str(), result.check.as_str()), ("fp", "A rep can log a deal."));

    assert!(report(&core, 1, "failed", json!([]), &[]).is_err(), "a failure needs calls or a reason");
    assert_eq!(report(&core, 1, "not proven", json!([]), &[]).unwrap().status, GoalStatus::NotProven);
    assert!(report(&core, 1, "maybe", json!([]), &[]).is_err());
    assert_eq!(core.log.lock().unwrap().results.len(), 2);
  }

  #[test]
  fn finishing_with_checks_left_is_sent_back_once() {
    let core = core();
    report(&core, 1, "not_proven", json!([]), &[]).unwrap();
    let refusal = record_completion(&core, "Done.").unwrap_err();
    assert!(refusal.contains(&core.checks[0].id) && !refusal.contains(&core.checks[1].id), "{refusal}");
    record_completion(&core, " Mostly fine. ").unwrap();
    let log = core.log.lock().unwrap();
    assert!(log.completed);
    assert_eq!(log.summary.as_deref(), Some("Mostly fine."));
  }

  #[test]
  fn a_call_line_says_who_asked_what_and_how_the_app_answered() {
    let refused = json!({"errors": [{"message": "Not authorized.", "extensions": {"code": "AUTH_NOT_AUTHORIZED"}}]});
    let line = call_line(&graphql("bo@example.com", "query {\n  deals { items { title } }\n}"), &answer(200, refused));
    assert_eq!(
      line,
      "as user:bo@example.com: query { deals { items { title } } } → 200 GraphQL error: Not authorized. (AUTH_NOT_AUTHORIZED)"
    );
  }

  #[test]
  fn connectors_are_only_read() {
    assert!(is_mutation("mutation AddRow { createRow(item: {}) { id } }"));
    assert!(!is_mutation("query { rows(filter: {note: {eq: \"a \\\" mutation\"}}) { items { id } } }"));
    assert!(!is_mutation("# no mutation here\nquery { rows { items { id } } }"));
    let mut request = graphql("ana@example.com", "mutation { deleteRow(id: 1) { id } }");
    assert!(outside_change(&request).is_none(), "the app's own data API is the copy's");
    request.path = "/connectors/sales/graphql".into();
    request.name = Some("sales".into());
    assert!(outside_change(&request).unwrap().contains("connector sales"));
  }

  #[test]
  fn a_proposal_needs_a_purpose_and_checks() {
    let ctx = DraftContext::default();
    let propose = |purpose: &str, checks: &[&str]| {
      let params = json!({ "purpose": purpose, "checks": checks });
      record_proposal(&ctx, serde_json::from_value(params).unwrap())
    };
    assert!(propose("", &["x"]).is_err());
    assert!(propose("Deals.", &[" ", ""]).is_err());
    assert!(propose("Deals.", &vec!["x"; MAX_DRAFTED + 1]).is_err());
    let proposal = propose("Reps track deals.", &["  A rep can log a deal. "]).unwrap();
    assert_eq!(proposal.checks, ["A rep can log a deal."]);
    assert_eq!(ctx.proposal.lock().unwrap().as_ref(), Some(&proposal));
  }
}
