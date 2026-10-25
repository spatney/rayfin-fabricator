//! "Diagnose with Copilot" for team workspaces. When setup, Repair, joining or
//! a pipeline run fails, Fabricator gathers read-only evidence ([`checks`]) and
//! a throwaway Copilot session explains the most likely cause and who can fix
//! it, streaming Markdown on `team:diagnosis`.
//!
//! Nothing here changes Microsoft Entra ID, Fabric, GitHub or local files. The
//! checks are GET-only reads with the user's own `gh`/`az` sign-ins, limited to
//! this context's repository, identities, Fabric workspaces and runs, with
//! secrets masked. The session's sandbox denies shell, writes, MCP and web
//! search, and lets `web_fetch` reach documentation hosts only.

mod checks;
mod prompt;
mod tools;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use github_copilot_sdk::MessageOptions;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::commands::advisor::{self, DrainEnd, Sandbox};
use crate::services::copilot::{CopilotManager, SessionOptions};
use crate::services::exec::CancelToken;
use crate::services::team;
use crate::services::{paths, store};
use crate::state::AppState;
use crate::types::{
  TeamCreateRequest, TeamDiagnoseRequest, TeamDiagnosisEnvelope, TeamDiagnosisEvent, TeamDiagnosisResult,
  TeamHealthItem, TeamProblem, TeamSetupState, TeamWorkspace,
};

use checks::{Emit, Runner};

/// Event for a diagnosis's checks and streamed answer.
pub const DIAGNOSIS_EVENT: &str = "team:diagnosis";

/// Ceiling for Copilot's analysis (each check has its own timeout).
const ANALYSIS_TIMEOUT_MS: u64 = 5 * 60_000;

/// Documentation the session may fetch: Microsoft Learn (Entra ID, Fabric and
/// AADSTS error references), GitHub Docs, Rayfin's docs and Fabricator's own.
const DOC_HOSTS: &[&str] = &["learn.microsoft.com", "docs.github.com", "rayfin.ai", "www.rayfin.ai", "spatney.github.io"];

/// Read-only and documentation-only, with no MCP: an MCP server would receive
/// the tenant details this session holds.
const SANDBOX: Sandbox = Sandbox { url_hosts: DOC_HOSTS, read_only_mcp: false };

const STOPPED: &str = "Diagnosis stopped.";

/* --------------------------------- context -------------------------------- */

/// Which team operation failed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Kind {
  #[default]
  Setup,
  Health,
  Join,
  Pipeline,
}

impl Kind {
  fn parse(value: &str) -> Option<Kind> {
    match value.trim() {
      "setup" => Some(Kind::Setup),
      "health" => Some(Kind::Health),
      "join" => Some(Kind::Join),
      "pipeline" => Some(Kind::Pipeline),
      _ => None,
    }
  }
}

/// A deploy identity the diagnosis may look up.
#[derive(Clone, Debug, PartialEq)]
struct Identity {
  /// deploy | preview | shared | admin
  role: &'static str,
  client_id: String,
}

impl Identity {
  fn describe(&self) -> &'static str {
    match self.role {
      "deploy" => "deploy identity (published apps)",
      "preview" => "preview identity (pull request previews)",
      "shared" => "deploy identity (previews and published apps)",
      _ => "app registration from your administrator",
    }
  }
}

/// A Fabric workspace the diagnosis may look up.
#[derive(Clone, Debug, PartialEq)]
struct FabricTarget {
  /// "published apps" | "previews"
  label: &'static str,
  id: String,
}

/// Everything a diagnosis knows about where the failure happened. Checks can
/// only target the repository, identities and workspaces listed here.
#[derive(Debug, Default)]
struct DiagContext {
  kind: Kind,
  /// The GitHub account the failed operation used (`None`: the CLI's active
  /// account). Checks run as it.
  account: Option<String>,
  /// The setup step that failed (`verify` also when Repair's check failed).
  step: Option<String>,
  problem: Option<TeamProblem>,
  error: Option<String>,
  health: Vec<TeamHealthItem>,
  workspace: Option<TeamWorkspace>,
  workspace_name: Option<String>,
  /// `owner/name`: the workspace's repository, or the one a join targeted.
  repo: Option<String>,
  owner: Option<String>,
  owner_is_org: Option<bool>,
  request: Option<TeamCreateRequest>,
  setup: Option<TeamSetupState>,
  tenant_id: Option<String>,
  identities: Vec<Identity>,
  /// One identity serves previews and published apps.
  shared_identity: bool,
  fabric: Vec<FabricTarget>,
  /// (id, name) of the capacity chosen for setup.
  capacity: Option<(String, Option<String>)>,
  run_id: Option<u64>,
  /// The open app a pipeline diagnosis can hand to the Build chat.
  project_id: Option<String>,
  project_dir: Option<PathBuf>,
  project_name: Option<String>,
  folder: Option<String>,
}

static REPO_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$").unwrap());
static OWNER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9-]*$").unwrap());
static GUID_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$").unwrap()
});
static RUN_URL_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)^https://github\.com/([^/\s]+/[^/\s]+)/actions/runs/(\d+)").unwrap());

fn is_guid(value: &str) -> bool {
  GUID_RE.is_match(value)
}

fn clean(value: Option<&String>) -> Option<String> {
  value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// The first value that is a GUID (IDs end up in request paths, so anything
/// else is ignored).
fn first_guid(values: impl IntoIterator<Item = Option<String>>) -> Option<String> {
  values.into_iter().flatten().map(|v| v.trim().to_string()).find(|v| is_guid(v))
}

/// The run id in a GitHub Actions run or job URL, when it belongs to `repo`.
fn run_id_from_url(url: &str, repo: Option<&str>) -> Option<u64> {
  let caps = RUN_URL_RE.captures(url.trim())?;
  if repo.is_some_and(|r| !caps[1].eq_ignore_ascii_case(r)) {
    return None;
  }
  caps[2].parse().ok()
}

/// The GitHub account the failed operation used: its project's or workspace's,
/// the one setup was asked to use, or the one a join used.
fn request_account(req: &TeamDiagnoseRequest) -> Option<String> {
  clean(req.project_id.as_ref())
    .and_then(|id| super::project_account(&id))
    .or_else(|| clean(req.workspace_id.as_ref()).and_then(|id| super::workspace_account(&id)))
    .or_else(|| req.request.as_ref().and_then(|r| clean(r.account.as_ref())))
    .or_else(|| clean(req.account.as_ref()))
    .filter(|a| team::gh::is_login(a))
}

async fn resolve(req: &TeamDiagnoseRequest) -> Result<DiagContext, String> {
  let kind = Kind::parse(&req.kind).ok_or("Fabricator doesn't know how to diagnose that.")?;
  let mut ctx = DiagContext {
    kind,
    account: request_account(req),
    step: clean(req.step.as_ref()).or_else(|| req.problem.as_ref().and_then(|p| clean(Some(&p.step)))),
    problem: req.problem.clone(),
    error: clean(req.error.as_ref()),
    health: req.health.clone(),
    ..Default::default()
  };
  if let Some(project_id) = clean(req.project_id.as_ref()) {
    if let Ok(tp) = team::team_project(&project_id) {
      ctx.project_dir = Some(PathBuf::from(&tp.project.path));
      ctx.project_name = Some(tp.project.name.clone());
      ctx.folder = Some(tp.binding.folder.clone());
      if kind == Kind::Pipeline {
        ctx.run_id = tp.binding.publish.as_ref().and_then(|p| p.run_id);
      }
      ctx.workspace = Some(tp.workspace);
      ctx.project_id = Some(project_id);
    }
  }
  if let Some(ws) = clean(req.workspace_id.as_ref()).and_then(|id| store::find_team_workspace(&id)) {
    ctx.workspace = Some(ws);
  }
  if let Some(ws) = &ctx.workspace {
    ctx.workspace_name = clean(Some(&ws.name));
    ctx.repo = Some(ws.repo.clone()).filter(|r| REPO_RE.is_match(r));
    ctx.setup = ws.setup.clone();
  }
  if kind == Kind::Join {
    if let Some(repo) = clean(req.repo.as_ref()).filter(|r| REPO_RE.is_match(r)) {
      ctx.repo = Some(repo);
    }
  }
  ctx.request = req.request.clone().or_else(|| ctx.setup.as_ref().map(|s| s.request.clone()));
  if let Some(r) = &ctx.request {
    if ctx.workspace_name.is_none() {
      ctx.workspace_name = clean(Some(&r.name));
    }
    ctx.capacity = Some(r.capacity_id.trim().to_string()).filter(|c| is_guid(c)).map(|c| (c, r.capacity_name.clone()));
    // Setup was asked to use this repository, so its checks can read it.
    if ctx.repo.is_none() {
      ctx.repo = r.existing_repo.as_deref().and_then(team::naming::parse_repo).filter(|r| REPO_RE.is_match(r));
    }
  }
  ctx.owner = ctx
    .repo
    .as_deref()
    .and_then(|r| r.split('/').next())
    .map(String::from)
    .or_else(|| ctx.request.as_ref().map(|r| r.owner.trim().to_string()))
    .filter(|o| OWNER_RE.is_match(o));
  ctx.owner_is_org = ctx
    .request
    .as_ref()
    .filter(|r| ctx.owner.as_deref().is_some_and(|o| o.eq_ignore_ascii_case(r.owner.trim())))
    .map(|r| r.owner_is_org);
  if let Some(id) = req.run_id.or_else(|| req.run_url.as_deref().and_then(|u| run_id_from_url(u, ctx.repo.as_deref()))) {
    ctx.run_id = Some(id);
  }
  fill_targets(&mut ctx).await;
  Ok(ctx)
}

/// The identities, tenant and Fabric workspaces this context may look up: the
/// repository's variables (readable by owners), this computer's setup record,
/// then the workspace manifest.
async fn fill_targets(ctx: &mut DiagContext) {
  let trusted = match &ctx.workspace {
    Some(ws) if ctx.repo.is_some() && ctx.kind != Kind::Join => team::trusted_targets(ws).await.ok(),
    _ => None,
  };
  let setup = ctx.setup.as_ref();
  let manifest = ctx.workspace.as_ref().and_then(|w| w.manifest.as_ref());
  let deploy = first_guid([
    trusted.as_ref().map(|t| t.deploy_client_id.clone()),
    setup.and_then(|s| s.app_id.clone()),
    manifest.map(|m| m.deploy_identity.client_id.clone()),
  ]);
  let preview = first_guid([
    trusted.as_ref().map(|t| t.preview_client_id.clone()),
    setup.and_then(|s| s.preview_app_id.clone()),
    manifest.map(|m| m.preview_identity.client_id.clone()),
  ]);
  let admin = first_guid([ctx.request.as_ref().and_then(|r| r.existing_client_id.clone())]);
  let tenant = first_guid([
    trusted.as_ref().map(|t| t.tenant_id.clone()),
    setup.and_then(|s| s.tenant_id.clone()),
    manifest.map(|m| m.tenant_id.clone()),
  ]);
  let production = first_guid([
    trusted.as_ref().map(|t| t.production_workspace_id.clone()),
    setup.and_then(|s| s.production_workspace_id.clone()),
    manifest.map(|m| m.fabric.production.id.clone()),
  ]);
  let previews = first_guid([
    trusted.as_ref().map(|t| t.previews_workspace_id.clone()),
    setup.and_then(|s| s.previews_workspace_id.clone()),
    manifest.map(|m| m.fabric.previews.id.clone()),
  ]);
  let (shared, identities) = identities(deploy, preview, admin);
  ctx.shared_identity = shared;
  ctx.identities = identities;
  ctx.tenant_id = tenant;
  ctx.fabric = [("published apps", production), ("previews", previews)]
    .into_iter()
    .filter_map(|(label, id)| id.map(|id| FabricTarget { label, id }))
    .collect();
}

/// The identities to check, and whether one serves previews and published apps.
fn identities(deploy: Option<String>, preview: Option<String>, admin: Option<String>) -> (bool, Vec<Identity>) {
  let same = |a: &Option<String>, b: &Option<String>| a.as_deref().zip(b.as_deref()).is_some_and(|(a, b)| a.eq_ignore_ascii_case(b));
  let shared = admin.is_some() || preview.is_none() || same(&preview, &deploy);
  let mut list = Vec::new();
  match &deploy {
    Some(id) => list.push(Identity { role: if shared { "shared" } else { "deploy" }, client_id: id.clone() }),
    None => {
      if let Some(id) = &admin {
        list.push(Identity { role: "admin", client_id: id.clone() });
      }
    }
  }
  if !shared {
    if let Some(id) = &preview {
      list.push(Identity { role: "preview", client_id: id.clone() });
    }
  }
  // An administrator's app registration that setup hasn't switched to yet.
  if let (Some(a), Some(_)) = (&admin, &deploy) {
    if !same(&admin, &deploy) {
      list.push(Identity { role: "admin", client_id: a.clone() });
    }
  }
  (shared, list)
}

/* -------------------------------- the command ------------------------------- */

/// Diagnose a failed team operation: run read-only checks, then let Copilot
/// explain the most likely cause, streaming on `team:diagnosis`. Resolves with
/// the whole result; `team_cancel(diagnosis_id)` stops it.
#[tauri::command]
pub async fn team_diagnose(
  app: AppHandle,
  state: State<'_, AppState>,
  request: TeamDiagnoseRequest,
) -> Result<TeamDiagnosisResult, String> {
  team::require_enabled()?;
  let id = request.diagnosis_id.trim().to_string();
  if id.is_empty() {
    return Err("Missing diagnosis id.".into());
  }
  let token = state.begin_team_op(&id);
  let emit: Emit = {
    let (app, id) = (app.clone(), id.clone());
    Arc::new(move |event| {
      let _ = app.emit(DIAGNOSIS_EVENT, TeamDiagnosisEnvelope { diagnosis_id: id.clone(), event });
    })
  };
  let result = team::gh::as_account(request_account(&request), diagnose(&state.copilot, &request, emit.clone(), &token)).await;
  state.end_team_op(&id, &token);
  emit(TeamDiagnosisEvent::Done { ok: result.ok, error: result.error.clone() });
  crate::services::telemetry::track_team(crate::commands::auth::get_cached_identity().as_ref(), "diagnose", result.ok);
  Ok(result)
}

async fn diagnose(copilot: &CopilotManager, request: &TeamDiagnoseRequest, emit: Emit, token: &CancelToken) -> TeamDiagnosisResult {
  let ctx = match resolve(request).await {
    Ok(ctx) => Arc::new(ctx),
    Err(e) => return TeamDiagnosisResult { error: Some(e), ..Default::default() },
  };
  let context = prompt::context_text(&ctx);
  emit(TeamDiagnosisEvent::Context { text: context.clone() });
  let runner = Arc::new(Runner::new(ctx.clone(), emit.clone(), token.clone()));
  let evidence = runner.run_all(checks::baseline_requests(&ctx)).await;
  let mut result = TeamDiagnosisResult { context: context.clone(), ..Default::default() };
  if token.is_cancelled() {
    result.checks = runner.checks();
    result.error = Some(STOPPED.into());
    return result;
  }

  let conclusion: tools::SharedConclusion = Arc::default();
  let outcome = match analysis_root(&ctx) {
    Ok(root) => {
      let mut opts = advisor::sandboxed_options(&root, SANDBOX);
      opts.tools = tools::diagnosis_tools(runner.clone(), conclusion.clone(), emit.clone());
      analyze(copilot, &root, opts, prompt::build(&ctx, &context, &evidence), token, &emit).await
    }
    Err(e) => Err(e),
  };
  result.checks = runner.checks();
  result.conclusion = conclusion.lock().unwrap().clone();
  match outcome {
    Err(e) => result.error = Some(format!("Couldn't start the diagnosis. {e}")),
    Ok((_, DrainEnd::Cancelled)) => result.error = Some(STOPPED.into()),
    Ok((answer, end)) => {
      result.text = answer.text();
      if result.text.is_empty() {
        let why = answer.errored.clone().unwrap_or_else(|| {
          if matches!(end, DrainEnd::TimedOut) { "It timed out.".to_string() } else { "Copilot ended without an answer.".to_string() }
        });
        result.error = Some(format!("Couldn't finish the diagnosis. {why}"));
      } else {
        result.ok = true;
      }
    }
  }
  result
}

/// Where the session runs: the app's folder for a pipeline failure (so Copilot
/// can read the code a build failed on), otherwise an empty scratch folder.
fn analysis_root(ctx: &DiagContext) -> Result<String, String> {
  if ctx.kind == Kind::Pipeline {
    if let Some(dir) = ctx.project_dir.as_ref().filter(|d| d.is_dir()) {
      return Ok(dir.to_string_lossy().to_string());
    }
  }
  let dir = paths::temp_dir().join("fabricator-team-diagnosis");
  std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't prepare a folder for it: {e}"))?;
  Ok(dir.to_string_lossy().to_string())
}

/// Send the prompt on a throwaway session and stream the answer.
async fn analyze(
  copilot: &CopilotManager,
  root: &str,
  opts: SessionOptions,
  prompt: String,
  token: &CancelToken,
  emit: &Emit,
) -> Result<(Answer, DrainEnd), String> {
  let session = copilot.transient_session_with(root, Default::default(), opts).await?;
  let sub = session.subscribe();
  let mut answer = Answer::default();
  let end = match session.send(MessageOptions::new(prompt)).await {
    Ok(_) => Ok(
      advisor::drain(&session, sub, token, ANALYSIS_TIMEOUT_MS, |event_type, data| {
        if let Some((text, reset)) = answer.feed(event_type, data) {
          emit(TeamDiagnosisEvent::Delta { text, reset });
        }
        matches!(event_type, "session.idle" | "session.error")
      })
      .await,
    ),
    Err(e) => Err(e.to_string()),
  };
  // These sessions are never reused; disconnect so they don't accumulate.
  let _ = session.disconnect().await;
  end.map(|end| (answer, end))
}

/* --------------------------------- the answer -------------------------------- */

/// The answer, reassembled from the stream: every assistant message except
/// narration that handed off to checks or documentation.
#[derive(Default)]
struct Answer {
  messages: Vec<(String, String)>,
  streamed: HashMap<String, usize>,
  narration: HashSet<String>,
  errored: Option<String>,
}

/// A finished message that hands off to checks or docs: narration, not the
/// answer. Reporting the conclusion doesn't count.
fn hands_off(data: &Value) -> bool {
  data
    .get("toolRequests")
    .and_then(Value::as_array)
    .is_some_and(|calls| calls.iter().any(|c| c.get("name").and_then(Value::as_str) != Some(tools::CONCLUDE_TOOL)))
}

impl Answer {
  fn append(&mut self, id: &str, text: &str) {
    match self.messages.iter_mut().find(|(m, _)| m == id) {
      Some((_, body)) => body.push_str(text),
      None => self.messages.push((id.to_string(), text.to_string())),
    }
  }

  /// Take one session event. Returns text to stream, or `(_, true)` to discard
  /// what was streamed so far (it was narration).
  fn feed(&mut self, event_type: &str, data: &Value) -> Option<(String, bool)> {
    let id = data.get("messageId").and_then(Value::as_str).unwrap_or_default().to_string();
    match event_type {
      "assistant.message_delta" => {
        let text = data.get("deltaContent").and_then(Value::as_str).unwrap_or_default();
        if text.is_empty() {
          return None;
        }
        *self.streamed.entry(id.clone()).or_insert(0) += text.chars().count();
        self.append(&id, text);
        Some((text.to_string(), false))
      }
      "assistant.message" => {
        let content = data.get("content").and_then(Value::as_str).unwrap_or_default();
        let total = content.chars().count();
        let have = self.streamed.get(&id).copied().unwrap_or(0);
        let mut rest = String::new();
        if total > have {
          rest = content.chars().skip(have).collect();
          self.streamed.insert(id.clone(), total);
          self.append(&id, &rest);
        }
        if hands_off(data) {
          self.narration.insert(id);
          return Some((String::new(), true));
        }
        (!rest.is_empty()).then_some((rest, false))
      }
      "session.error" => {
        let message = data.get("message").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty());
        self.errored = Some(message.unwrap_or("Copilot reported an error.").to_string());
        None
      }
      _ => None,
    }
  }

  /// The answer without narration.
  fn text(&self) -> String {
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

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn kinds_parse() {
    assert_eq!(Kind::parse(" setup "), Some(Kind::Setup));
    assert_eq!(Kind::parse("pipeline"), Some(Kind::Pipeline));
    assert_eq!(Kind::parse("other"), None);
  }

  #[test]
  fn run_ids_come_only_from_this_repositorys_runs() {
    let url = "https://github.com/Contoso/Team-Apps/actions/runs/123456/job/789";
    assert_eq!(run_id_from_url(url, Some("contoso/team-apps")), Some(123456));
    assert_eq!(run_id_from_url(url, None), Some(123456));
    assert_eq!(run_id_from_url(url, Some("contoso/other")), None);
    assert_eq!(run_id_from_url("https://evil.example/contoso/team-apps/actions/runs/1", None), None);
  }

  #[test]
  fn only_guids_are_used_as_ids() {
    let id = "8f6b2c1e-1a2b-4c3d-8e9f-0123456789ab";
    assert_eq!(first_guid([Some(String::new()), Some("x')/owners".into()), Some(format!(" {id} "))]), Some(id.to_string()));
    assert_eq!(first_guid([None, Some("not-a-guid".into())]), None);
  }

  #[test]
  fn identities_follow_how_setup_assigned_them() {
    let (d, p, a) = (
      "11111111-1111-1111-1111-111111111111".to_string(),
      "22222222-2222-2222-2222-222222222222".to_string(),
      "33333333-3333-3333-3333-333333333333".to_string(),
    );
    let (shared, list) = identities(Some(d.clone()), Some(p.clone()), None);
    assert!(!shared);
    assert_eq!(list.iter().map(|i| i.role).collect::<Vec<_>>(), vec!["deploy", "preview"]);
    let (shared, list) = identities(Some(d.clone()), Some(d.clone()), None);
    assert!(shared);
    assert_eq!(list.iter().map(|i| i.role).collect::<Vec<_>>(), vec!["shared"]);
    // Setup stopped before it could look up the administrator's app registration.
    let (shared, list) = identities(None, None, Some(a.clone()));
    assert!(shared);
    assert_eq!(list, vec![Identity { role: "admin", client_id: a.clone() }]);
    let (_, list) = identities(Some(d), None, Some(a));
    assert_eq!(list.iter().map(|i| i.role).collect::<Vec<_>>(), vec!["shared", "admin"]);
  }

  #[test]
  fn narration_before_checks_is_dropped_but_the_conclusion_call_is_not() {
    let mut answer = Answer::default();
    assert_eq!(
      answer.feed("assistant.message_delta", &json!({ "messageId": "m1", "deltaContent": "Let me check." })),
      Some(("Let me check.".to_string(), false))
    );
    let narration = json!({ "messageId": "m1", "content": "Let me check.", "toolRequests": [{ "name": "fabricator_team_check" }] });
    assert_eq!(answer.feed("assistant.message", &narration), Some((String::new(), true)));
    let last = json!({ "messageId": "m2", "content": "**Most likely cause**", "toolRequests": [{ "name": tools::CONCLUDE_TOOL }] });
    assert_eq!(answer.feed("assistant.message", &last), Some(("**Most likely cause**".to_string(), false)));
    assert_eq!(answer.text(), "**Most likely cause**");
    answer.feed("session.error", &json!({ "message": " boom " }));
    assert_eq!(answer.errored.as_deref(), Some("boom"));
  }
}
