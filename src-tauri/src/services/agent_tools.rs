//! In-process Copilot tools for Fabricator's chat sessions:
//!
//! - **Semantic models** (every session): find the Power BI / Fabric semantic
//!   model behind a report, app, or dataset, to wire it into the app.
//! - **The local backend** (sessions with the Local guidance, see
//!   [`crate::services::agent_skills`]): `fabricator_local_status` reports on the
//!   app's local backend ([`crate::services::local_backend`]), and
//!   `fabricator_local_call` calls the app's own routes as one of its users.
//!   Both first bring the backend up to date ([`prepare`]): they start it when it
//!   isn't running, start it again after a problem the agent's changes may have
//!   fixed, and wait until it has picked up the latest changes to the app's
//!   backend sources.
//!
//! Registered on each chat session via
//! [`SessionConfig::with_tools`](github_copilot_sdk::SessionConfig::with_tools)
//! (see [`crate::services::copilot`]). Each handler runs inside the Tauri host
//! process. The agent checks visuals headlessly (`npm run preview`), so there are
//! no preview-browser tools.
//!
//! These tools exist **only** in Fabricator-driven sessions — they are never part
//! of the project on disk, so a plain `copilot` CLI run sees none of them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::{ToolInvocation, ToolResultExpanded};
use github_copilot_sdk::{Error as SdkError, Tool, ToolResult};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::services::agent_skills::Guidance;
use crate::services::diagnostics::redact_secrets;
use crate::services::local_backend::{self, AppCall, AppResponse, CallAs, LocalBackends};
use crate::services::project_layout::ProjectLayout;
use crate::services::{semantic_model, store};
use crate::types::{LocalBackendState as State, LocalLogEvent, LocalProblem, LocalStartOptions, LocalStatus};

/// Build the Fabricator in-process tool set for one project's chat session.
/// The local backend tools come with the Local guidance only: other apps'
/// backends run on Microsoft Fabric.
pub fn fabricator_tools(app: AppHandle, project_id: String, guidance: Guidance) -> Vec<Tool> {
  let mut tools = vec![
    Tool::new("fabricator_locate_semantic_model")
      .with_description(
        "Find the Power BI / Fabric semantic model (dataset) behind a report, app, or dataset \
         when the user gives you a link or id. Pass a Power BI URL — a report, app, dataset, or \
         model-editor link (.../modeling/<id>/modelView) — or a bare GUID as `target`. Returns \
         the model's name, workspace id, and item id. \
         A Power BI dataset id IS its Fabric semantic-model item id, so you can wire the model \
         straight into this app (see the connect-semantic-model skill: a Rayfin connector, or \
         `fabric-app-data add` in apps with a fabric.yaml). Use this to turn a report/app \
         link the user pastes into the underlying model the app should connect to.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "target": {
            "type": "string",
            "description": "A Power BI URL (report/app/dataset or model-editor /modeling/<id>/modelView link) or a bare GUID to resolve."
          },
          "workspace": {
            "type": "string",
            "description": "Optional workspace-id hint to speed up / disambiguate the lookup."
          },
          "admin": {
            "type": "boolean",
            "description": "Optional: also try tenant-admin lookup paths (only works if you have admin rights)."
          }
        },
        "required": ["target"]
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(LocateSemanticModelTool)),
    Tool::new("fabricator_search_semantic_models")
      .with_description(
        "Search Microsoft Fabric for semantic models (datasets) by description or keywords when \
         you do NOT have a direct link or id. Pass natural-language keywords as `query` (e.g. \
         \"sales pipeline\", \"finance revenue by region\"). Returns matching models with their \
         workspace id and item id, ready to wire into this app (see the connect-semantic-model \
         skill). If you already have a report/app link or id, use \
         fabricator_locate_semantic_model instead. Requires Azure CLI \
         sign-in (handled by the Fabricator setup screen).",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Description or keywords to search for, e.g. \"customer churn\"."
          },
          "types": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Optional item types to match (defaults to [\"report\", \"model\"]). Accepts report, model/dataset, lakehouse, warehouse, notebook."
          },
          "limit": {
            "type": "number",
            "description": "Optional cap on the number of catalog hits to consider (default 30)."
          }
        },
        "required": ["query"]
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(SearchSemanticModelsTool)),
  ];
  if guidance == Guidance::Local {
    tools.push(local_status_tool(app.clone(), project_id.clone()));
    tools.push(local_call_tool(app, project_id));
  }
  tools
}

/* ----------------------------- shared helpers ----------------------------- */

/// A failure tool result carrying a message the agent can act on.
fn failure(message: impl Into<String>) -> ToolResult {
  let message = message.into();
  // `ToolResultExpanded` is `#[non_exhaustive]` in the SDK; build it via the
  // `new(...).with_*` chain rather than a struct literal.
  ToolResult::Expanded(ToolResultExpanded::new(message.clone(), "failure").with_error(message))
}

/* ------------------------ semantic-model locator -------------------------- */


struct LocateSemanticModelTool;

#[derive(Deserialize)]
struct LocateParams {
  #[serde(alias = "url", alias = "id", alias = "link", alias = "report", alias = "app")]
  target: String,
  #[serde(default)]
  workspace: Option<String>,
  #[serde(default)]
  admin: Option<bool>,
}

#[async_trait]
impl ToolHandler for LocateSemanticModelTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: LocateParams = match invocation.params() {
      Ok(p) => p,
      Err(e) => return Ok(failure(format!("Invalid arguments: {e}"))),
    };
    let target = params.target.trim();
    if target.is_empty() {
      return Ok(failure(
        "Provide a report/app/dataset id or a Power BI URL as `target`.",
      ));
    }
    let result = semantic_model::locate_semantic_model(
      target,
      params.workspace.as_deref(),
      params.admin.unwrap_or(false),
    )
    .await;
    Ok(render_semantic_model_result(&result))
  }
}

struct SearchSemanticModelsTool;

#[derive(Deserialize)]
struct SearchParams {
  #[serde(alias = "description", alias = "keywords", alias = "q", alias = "text")]
  query: String,
  #[serde(default)]
  types: Option<Vec<String>>,
  #[serde(default)]
  limit: Option<u32>,
}

#[async_trait]
impl ToolHandler for SearchSemanticModelsTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: SearchParams = match invocation.params() {
      Ok(p) => p,
      Err(e) => return Ok(failure(format!("Invalid arguments: {e}"))),
    };
    let query = params.query.trim();
    if query.is_empty() {
      return Ok(failure(
        "Provide a description or keywords to search for as `query`.",
      ));
    }
    let result = semantic_model::search_semantic_models(query, params.types.clone(), params.limit).await;
    Ok(render_semantic_model_result(&result))
  }
}

/// Render a [`semantic_model::SemanticModelResult`] (from either tool) into a
/// compact text block the agent can act on, including the wiring commands for
/// the top match and any access/admin notes.
fn render_semantic_model_result(r: &semantic_model::SemanticModelResult) -> ToolResult {
  use std::fmt::Write as _;

  if !r.ok {
    let base = r
      .error
      .clone()
      .unwrap_or_else(|| "The semantic-model lookup failed.".to_string());
    if r.needs_az {
      return failure(format!(
        "Azure CLI isn't signed in, which is required to search the Fabric catalog. Run \
         `az login` (or use the Fabricator setup screen), then try again. ({base})"
      ));
    }
    if r.needs_login {
      return failure(format!(
        "Not signed in to Rayfin, so I couldn't query Power BI / Fabric. Sign in from the \
         Fabricator setup screen, then try again. ({base})"
      ));
    }
    return failure(base);
  }

  let mut out = String::new();

  // What the target (locate) resolved through, for context.
  if let Some(app) = &r.app {
    let name = app.name.as_deref().unwrap_or("(app)");
    let _ = write!(out, "Resolved app '{name}'");
    if let Some(ws) = app.workspace_name.as_deref().or(app.workspace_id.as_deref()) {
      let _ = write!(out, " in workspace {ws}");
    }
    out.push_str(".\n");
  } else if let Some(rep) = &r.report {
    let name = rep.name.as_deref().unwrap_or("(report)");
    let _ = write!(out, "Resolved report '{name}'");
    if let Some(ws) = rep.workspace_name.as_deref().or(rep.workspace_id.as_deref()) {
      let _ = write!(out, " in workspace {ws}");
    }
    out.push_str(".\n");
  }

  if r.models.is_empty() {
    out.push_str(if r.matched {
      "Matched the target, but its semantic model couldn't be resolved (you may not have access to it).\n"
    } else {
      "No matching semantic model was found.\n"
    });
  } else {
    let n = r.models.len();
    let _ = writeln!(out, "Found {n} semantic model{}:", if n == 1 { "" } else { "s" });
    for (i, m) in r.models.iter().enumerate() {
      let name = m.name.as_deref().unwrap_or("(unnamed model)");
      let item = m.item_id.as_deref().or(m.id.as_deref()).unwrap_or("?");
      let ws_id = m.workspace_id.as_deref().unwrap_or("?");
      let _ = writeln!(out, "{}. {name}", i + 1);
      if let Some(wn) = m.workspace_name.as_deref() {
        let _ = writeln!(out, "   workspace: {wn} ({ws_id})");
      } else {
        let _ = writeln!(out, "   workspace id: {ws_id}");
      }
      let _ = writeln!(out, "   item id (= dataset id): {item}");
      if let Some(via) = m.matched_via.as_deref() {
        let _ = writeln!(out, "   matched via: {via}");
      }
      if let Some(owner) = m.owner.as_deref() {
        let _ = writeln!(out, "   owner: {owner}");
      }
      if let Some(url) = m.web_url.as_deref() {
        let _ = writeln!(out, "   url: {url}");
      }
    }
    let first = &r.models[0];
    if let (Some(ws), Some(item)) = (
      first.workspace_id.as_deref(),
      first.item_id.as_deref().or(first.id.as_deref()),
    ) {
      let _ = write!(
        out,
        "\nTo connect this app to the first model:\n\
         - Apps that read semantic models through Rayfin connectors (follow the project's analytics skill):\n    \
         npx rayfin connector add --type fabric-semanticmodel --workspace-id {ws} --item-id {item} --name <alias>\n\
         - Apps with a fabric.yaml:\n    \
         fabric-app-data add <alias> -w {ws} -i {item}\n  then run a build (see the fabric-data skill).\n"
      );
    }
  }

  if !r.other_matches.is_empty() {
    out.push_str("\nOther catalog matches (not semantic models):\n");
    for o in &r.other_matches {
      let name = o.display_name.as_deref().unwrap_or("(item)");
      let ty = o.r#type.as_deref().unwrap_or("item");
      let ws = o
        .workspace_name
        .as_deref()
        .or(o.workspace_id.as_deref())
        .unwrap_or("?");
      let _ = writeln!(out, "- {name} [{ty}] in {ws}");
    }
  }

  if !r.notes.is_empty() {
    out.push_str("\nNotes:\n");
    for note in &r.notes {
      let _ = writeln!(out, "- {note}");
    }
  }

  // The helper sometimes returns a soft hint (ok:true) instead of a match.
  if r.models.is_empty() {
    if let Some(hint) = r.error.as_deref() {
      let _ = write!(out, "\n{hint}");
    }
  }

  ToolResult::Text(out.trim_end().to_string())
}

/* ------------------------------ local backend ----------------------------- */

const LOCAL_STATUS_TOOL: &str = "fabricator_local_status";
const LOCAL_CALL_TOOL: &str = "fabricator_local_call";

fn local_status_tool(app: AppHandle, project_id: String) -> Tool {
  Tool::new(LOCAL_STATUS_TOOL)
    .with_description(
      "Check this app's local backend. Fabricator runs the app and its whole backend on this \
       computer: the data API with its `@role` policies, sign-in, functions, connectors, storage \
       and the app's own Vite. Call this after you change entities, functions, connectors or \
       rayfin/rayfin.yml, and whenever something doesn't work. It first brings the backend up to \
       date: it starts it when it isn't running, starts it again when it stopped on a problem your \
       changes may have fixed, and waits until it has picked up your latest changes. Then it \
       reports, as JSON: the state and URLs; the app's Rayfin SDK and whether the local backend \
       supports it; its features (entities, functions, connectors with `supported`, storage); the \
       last data model change (`schema`, with the data a refused change would delete in \
       `losses`); the functions' build and its errors; Vite; warnings and errors; advice; and the \
       last output lines (oldest first, UTC). Never start the app or its backend yourself. Takes \
       no arguments.",
    )
    .with_parameters(json!({ "type": "object", "properties": {} }))
    .with_skip_permission(true)
    .with_handler(Arc::new(LocalStatusTool { app, project_id }))
}

fn local_call_tool(app: AppHandle, project_id: String) -> Tool {
  Tool::new(LOCAL_CALL_TOOL)
    .with_description(
      "Call this app's local backend the way its frontend does, as one of its users, to prove \
       that data access, permissions, functions and connectors work. Fabricator brings the backend \
       up to date first, as fabricator_local_status does. `target` picks the route: `graphql` \
       (POST /graphql, the data API; body {\"query\": \"…\", \"variables\": {…}}), `function` \
       (POST /functions/<name>/invoke; body: the function's input), `connector` (POST \
       /connector-invoke/<name>; for a semantic model, body {\"operation\": \"executeQuery\", \
       \"input\": {\"query\": \"<DAX>\"}}) or `connector-graphql` (POST /connectors/<name>/graphql, \
       a SQL connector's data API; body as for graphql). `as` is who calls: `developer` (the user, \
       the default), `anonymous` (signed out) or `user:<email>`, a local test user that is created \
       when missing. Returns the HTTP status and the answer (truncated, with tokens masked). A \
       permission that should refuse someone is proven only by a call that is refused.",
    )
    .with_parameters(json!({
      "type": "object",
      "properties": {
        "target": {
          "type": "string",
          "enum": ["graphql", "function", "connector", "connector-graphql"],
          "description": "The route: the data API (graphql), a function, a connector, or a SQL connector's data API (connector-graphql)."
        },
        "name": {
          "type": "string",
          "description": "The function's or the connector's name. Not used with graphql."
        },
        "body": {
          "type": "object",
          "description": "The JSON request body: {\"query\", \"variables\"} for graphql and connector-graphql, the function's input for function, {\"operation\", \"input\"} for connector."
        },
        "as": {
          "type": "string",
          "description": "Who calls: developer (the user; the default), anonymous (signed out), or user:<email> for a local test user, created when missing, such as user:ana@example.com."
        }
      },
      "required": ["target"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(LocalCallTool { app, project_id }))
}

struct LocalStatusTool {
  app: AppHandle,
  project_id: String,
}

#[async_trait]
impl ToolHandler for LocalStatusTool {
  async fn call(&self, _invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let dir = match local_dir(&self.project_id) {
      Ok(dir) => dir,
      Err(result) => return Ok(result),
    };
    let backends = local_backend::state(&self.app);
    Ok(local_status(&backends, &self.project_id, &dir, Waits::default()).await)
  }
}

struct LocalCallTool {
  app: AppHandle,
  project_id: String,
}

#[async_trait]
impl ToolHandler for LocalCallTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: CallParams = match invocation.params() {
      Ok(p) => p,
      Err(e) => return Ok(failure(format!("Invalid arguments: {e}"))),
    };
    let request = match parse_call(params) {
      Ok(request) => request,
      Err(message) => return Ok(failure(message)),
    };
    let dir = match local_dir(&self.project_id) {
      Ok(dir) => dir,
      Err(result) => return Ok(result),
    };
    let backends = local_backend::state(&self.app);
    Ok(local_call(&backends, &self.project_id, &dir, &request, Waits::default()).await)
  }
}

/// The folder of the app whose local backend the tools use, or why there's none.
fn local_dir(project_id: &str) -> Result<PathBuf, ToolResult> {
  if store::find_project(project_id).is_some_and(|p| p.team.is_some()) {
    return Err(failure(
      "This app is in a team workspace, so its backend runs on Microsoft Fabric, not on this computer: \
       it has no local backend.",
    ));
  }
  local_backend::project_dir(project_id).map_err(|e| failure(e.to_string()))
}

async fn local_status(backends: &LocalBackends, project_id: &str, dir: &Path, waits: Waits) -> ToolResult {
  let prepared = prepare(backends, project_id, dir, waits).await;
  let output = backends.logs(project_id, OUTPUT_LINES);
  ToolResult::Text(status_report(&prepared.status, &output, &prepared.notes))
}

async fn local_call(backends: &LocalBackends, project_id: &str, dir: &Path, request: &CallRequest, waits: Waits) -> ToolResult {
  let prepared = prepare(backends, project_id, dir, waits).await;
  let control = match backends.control(project_id) {
    Ok(control) => control,
    Err(error) => {
      let mut message = prepared.notes.join(" ");
      if !message.is_empty() {
        message.push(' ');
      }
      message.push_str(&format!(
        "The app's local backend can't take calls: {error} Call {LOCAL_STATUS_TOOL} to see why."
      ));
      return failure(message);
    }
  };
  let call = AppCall {
    method: reqwest::Method::POST,
    path: request.path.clone(),
    body: Some(request.body.clone()),
    call_as: request.call_as.clone(),
  };
  match control.call_app(call).await {
    Ok(response) => ToolResult::Text(call_report(request, &response, &prepared.notes)),
    Err(error) => failure(format!("Calling {} {} failed: {error}", request.path, who(&request.call_as))),
  }
}

/* ------------------------- bringing it up to date ------------------------- */

/// How long the local backend tools wait for the backend, from the call.
#[derive(Clone, Copy, Debug)]
struct Waits {
  /// For it to start (or start again) until it runs or fails.
  start: Duration,
  /// For it to report on the latest changes to the app's backend sources.
  change: Duration,
  /// For a functions build, or a restart of the app's Vite, to end.
  busy: Duration,
  /// How long nothing may change, after a wait, before the tool answers.
  quiet: Duration,
  poll: Duration,
}

impl Default for Waits {
  fn default() -> Self {
    Self {
      start: Duration::from_secs(90),
      change: Duration::from_secs(45),
      busy: Duration::from_secs(60),
      quiet: Duration::from_millis(400),
      poll: Duration::from_millis(150),
    }
  }
}

/// Problems a change to the app can't fix, so the tools don't start the
/// backend again after them: the preview offers the fix. As the renderer's
/// `retriesAfterTurn`.
const OUTSIDE_THE_APP: &[&str] = &[
  "already-serving",
  "node-missing",
  "node-too-old",
  "project-not-found",
  "port-in-use",
  "binary-missing",
  "binary-too-old",
  "binary-incompatible",
  "binary-blocked",
  "binary-failed",
  "spawn-failed",
];

/// The backend after a tool brought it up to date, and what that took.
struct Prepared {
  status: LocalStatus,
  /// For the agent: what Fabricator did, and what it gave up waiting for.
  notes: Vec<String>,
}

/// What a tool waits for.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Waiting {
  Start,
  /// A change to the backend sources, made at this time.
  Change(SystemTime),
  Busy,
}

/// Per project: the change to its backend sources a tool last gave up waiting
/// for, so a change rayfin-local never reports on (a comment in `rayfin.yml`)
/// costs one wait, not one per call. Its lock lets one tool at a time bring
/// the backend up to date.
type Gate = Arc<tokio::sync::Mutex<Option<SystemTime>>>;

fn gate(project_id: &str) -> Gate {
  static GATES: Lazy<Mutex<HashMap<String, Gate>>> = Lazy::new(Default::default);
  GATES.lock().unwrap_or_else(|e| e.into_inner()).entry(project_id.to_string()).or_default().clone()
}

/// Bring the project's local backend up to date for a tool: start it when it
/// isn't running, start it again when it stopped on a problem in the app that
/// changed since, or when it kept the previous data model after a change it
/// couldn't analyze and the app changed since, then wait until it runs, has
/// reported on the latest changes to the app's backend sources, and isn't
/// building the functions.
async fn prepare(backends: &LocalBackends, project_id: &str, dir: &Path, waits: Waits) -> Prepared {
  let gate = gate(project_id);
  let mut given_up = gate.lock().await;
  let began = Instant::now();
  let stamps = source_stamps(dir);
  let mut notes = Vec::new();
  let before = backends.status(project_id);
  // Why Fabricator (re)started it, for a note that says how that went.
  let started = match before.state {
    State::Stopped => {
      backends.start(project_id, dir.to_path_buf(), LocalStartOptions::default()).await;
      Some("The local backend wasn't running".to_string())
    }
    State::Error if restartable(&before, &stamps, dir) => {
      let code = before.error.as_ref().map(|e| e.code.clone()).unwrap_or_default();
      backends.restart(project_id, dir.to_path_buf(), LocalStartOptions::default()).await;
      Some(format!("The local backend had stopped (`{code}`), and the app changed since"))
    }
    State::Running if stuck_on_failed_analysis(&before, &stamps) => {
      backends.restart(project_id, dir.to_path_buf(), LocalStartOptions::default()).await;
      Some(
        "The local backend had kept the previous data model after a change it couldn't analyze, and the app changed \
         since"
          .to_string(),
      )
    }
    _ => None,
  };

  let mut waited = false;
  let mut waited_for_changes = false;
  let mut gave_up = None;
  let status = loop {
    let status = backends.status(project_id);
    let what = match status.state {
      State::Starting | State::Restarting => Waiting::Start,
      State::Running => match unreported(&stamps, &status).filter(|change| *given_up != Some(*change)) {
        Some(change) => Waiting::Change(change),
        None if busy(&status) => Waiting::Busy,
        None => break status,
      },
      _ => break status,
    };
    let limit = match what {
      Waiting::Start => waits.start,
      Waiting::Change(_) => waits.change,
      Waiting::Busy => waits.busy,
    };
    if began.elapsed() >= limit {
      let secs = began.elapsed().as_secs();
      gave_up = Some(match what {
        Waiting::Start => format!("The local backend is still starting after {secs} s: call this again in a moment."),
        Waiting::Change(change) => {
          *given_up = Some(change);
          format!(
            "The local backend hasn't reported on your latest changes after {secs} s, so this may not include \
             them: call {LOCAL_STATUS_TOOL} again in a moment."
          )
        }
        Waiting::Busy => format!(
          "The local backend is still building the functions, or restarting the app's Vite, after {secs} s."
        ),
      });
      break status;
    }
    waited = true;
    waited_for_changes |= matches!(what, Waiting::Change(_));
    tokio::time::sleep(waits.poll).await;
  };
  let status = if waited { settle(backends, project_id, waits).await } else { status };
  if let Some(why) = started {
    notes.push(match status.state {
      State::Error | State::Stopped => format!("{why}, so Fabricator tried to start it, but it stopped: see `error`."),
      _ => format!("{why}, so Fabricator started it."),
    });
  }
  notes.extend(gave_up);
  if waited_for_changes && unreported(&stamps, &status).is_none() {
    notes.push(format!(
      "Fabricator waited {} s for the local backend to pick up your latest changes.",
      began.elapsed().as_secs().max(1)
    ));
  }
  Prepared { status, notes }
}

/// The status once it stopped changing for a moment (a `schema` event follows
/// its `analysis`, and a `ready` a configuration change), within a few seconds.
async fn settle(backends: &LocalBackends, project_id: &str, waits: Waits) -> LocalStatus {
  let deadline = Instant::now() + waits.quiet * 8;
  let mut status = backends.status(project_id);
  loop {
    tokio::time::sleep(waits.quiet).await;
    let next = backends.status(project_id);
    if next.revision == status.revision || Instant::now() >= deadline {
      return next;
    }
    status = next;
  }
}

/// Building the functions, or restarting the app's Vite.
fn busy(status: &LocalStatus) -> bool {
  status.functions.as_ref().is_some_and(|f| f.state == "building")
    || status.vite.as_ref().is_some_and(|v| v.state == "restarting")
}

/// Whether a backend that stopped on `status.error` should start again: the
/// problem is in the app, and the app changed since (its backend sources, or
/// its npm packages, after `packages-missing`).
fn restartable(status: &LocalStatus, stamps: &Stamps, dir: &Path) -> bool {
  let Some(error) = &status.error else {
    return false;
  };
  if OUTSIDE_THE_APP.contains(&error.code.as_str()) {
    return false;
  }
  let Some(failed_at) = time_of(error.time.as_deref()).or_else(|| time_of(status.updated_at.as_deref())) else {
    return false;
  };
  [stamps.model, stamps.functions, stamps.config, installed(dir, error)].into_iter().flatten().any(|at| at > failed_at)
}

/// Whether a running backend serves the data model it had before a change it
/// couldn't analyze, and the app's data model or `rayfin.yml` changed after
/// that. rayfin-local doesn't always analyze the app again then: a data package
/// that `rayfin.yml` turned on while it ran is neither built nor followed until
/// it starts again, and starting builds it first.
fn stuck_on_failed_analysis(status: &LocalStatus, stamps: &Stamps) -> bool {
  let Some(failed_at) = status.analysis.as_ref().filter(|a| !a.ok).and_then(|a| time_of(a.time.as_deref())) else {
    return false;
  };
  [stamps.model, stamps.config].into_iter().flatten().any(|at| at > failed_at)
}

/// When npm last installed packages in the project, its functions package, or
/// the folder a `packages-missing` names.
fn installed(dir: &Path, error: &LocalProblem) -> Option<SystemTime> {
  let reported = error.details.as_ref().and_then(|d| d.get("dir")).and_then(Value::as_str).map(|d| dir.join(d));
  let functions = dir.join(ProjectLayout::read(dir).functions_root);
  [Some(dir.to_path_buf()), Some(functions), reported]
    .into_iter()
    .flatten()
    .filter_map(|folder| modified(&folder.join("node_modules").join(".package-lock.json")))
    .max()
}

/// The newest change to the app's backend sources the backend hasn't reported
/// on yet. A report without a time can't tell, so nothing waits for it.
fn unreported(stamps: &Stamps, status: &LocalStatus) -> Option<SystemTime> {
  let latest = |times: &[Option<&str>]| times.iter().filter_map(|t| time_of(*t)).max();
  let after = |changed: Option<SystemTime>, seen: Option<SystemTime>| changed.zip(seen).filter(|(c, s)| c > s).map(|(c, _)| c);
  let analysis = status.analysis.as_ref().and_then(|a| a.time.as_deref());
  let schema = status.schema.as_ref().and_then(|s| s.time.as_deref());
  let config = status.config.as_ref().and_then(|c| c.time.as_deref());
  let ready = status.ready.as_ref().and_then(|r| r.time.as_deref());
  // A `rayfin.yml` it can't read, or a change that needs a restart, is reported as a problem.
  let warning = status.warnings.last().and_then(|w| w.time.as_deref());
  let error = status.error.as_ref().and_then(|e| e.time.as_deref());
  let functions = status.functions.as_ref().filter(|f| f.state != "off");
  [
    after(stamps.model, latest(&[analysis, schema])),
    functions.and_then(|f| after(stamps.functions, latest(&[f.time.as_deref()]))),
    after(stamps.config, latest(&[config, analysis, ready, warning, error])),
  ]
  .into_iter()
  .flatten()
  .max()
}

fn time_of(at: Option<&str>) -> Option<SystemTime> {
  chrono::DateTime::parse_from_rfc3339(at?.trim()).ok().map(SystemTime::from)
}

fn modified(path: &Path) -> Option<SystemTime> {
  std::fs::metadata(path).ok()?.modified().ok()
}

/// When the app's backend sources last changed, by the report that covers them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Stamps {
  /// The data model and storage folders: an `analysis` event.
  model: Option<SystemTime>,
  /// The functions package: a `functions` event.
  functions: Option<SystemTime>,
  /// `rayfin.yml` and `rayfin-local.toml`: `config-changed`, `analysis` or `ready`.
  config: Option<SystemTime>,
}

/// Folders the scan skips: dependencies, build output and caches.
const SKIPPED_DIRS: &[&str] = &["node_modules", "dist", "build", "out", "coverage"];
/// Source files of the app's backend (not notes, lockfiles or data).
const SOURCE_EXTENSIONS: &[&str] = &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "yml", "yaml"];
const MAX_SCAN_DEPTH: usize = 8;
/// Most entries a scan looks at, so a huge folder can't stall a tool.
const MAX_SCAN_ENTRIES: usize = 5000;

/// When the backend sources rayfin-local watches last changed: `rayfin.yml`,
/// the data model and storage folders, and the functions package, where the
/// project's layout puts them. The frontend isn't one: Vite updates the page.
fn source_stamps(dir: &Path) -> Stamps {
  let layout = ProjectLayout::read(dir);
  let mut budget = MAX_SCAN_ENTRIES;
  let mut model_dirs = vec![layout.data_dir.clone(), "rayfin/data".to_string(), "rayfin/storage".to_string()];
  // A data package also keeps entities in its own `rayfin/` folder.
  if let Some(package) = layout.data_dir.strip_suffix("/src") {
    model_dirs.push(format!("{package}/rayfin"));
  }
  model_dirs.sort();
  model_dirs.dedup();
  let mut model = modified(&dir.join("rayfin").join("tsconfig.json"));
  for rel in &model_dirs {
    model = model.max(newest_in(&dir.join(rel), 0, &mut budget));
  }
  let functions = newest_in(&dir.join(&layout.functions_root), 0, &mut budget);
  let config = ["rayfin/rayfin.yml", "rayfin/rayfin.yaml", "rayfin-local.toml"].iter().filter_map(|rel| modified(&dir.join(rel))).max();
  Stamps { model, functions, config }
}

/// The newest modification time of the source files under `dir`.
fn newest_in(dir: &Path, depth: usize, budget: &mut usize) -> Option<SystemTime> {
  let mut newest = None;
  for entry in std::fs::read_dir(dir).ok()?.flatten() {
    if *budget == 0 {
      break;
    }
    *budget -= 1;
    let name = entry.file_name().to_string_lossy().into_owned();
    let Ok(kind) = entry.file_type() else { continue };
    let found = if kind.is_dir() {
      if depth >= MAX_SCAN_DEPTH || name.starts_with('.') || SKIPPED_DIRS.contains(&name.as_str()) {
        continue;
      }
      newest_in(&entry.path(), depth + 1, budget)
    } else if is_source(&name) {
      entry.metadata().ok().and_then(|m| m.modified().ok())
    } else {
      None
    };
    newest = newest.max(found);
  }
  newest
}

fn is_source(name: &str) -> bool {
  let extension = Path::new(name).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
  name != "package-lock.json" && extension.is_some_and(|e| SOURCE_EXTENSIONS.contains(&e.as_str()))
}

/* ------------------------------ the status ------------------------------- */

/// Longest piece of rayfin-local's or the app's text in an answer.
const MAX_TEXT: usize = 600;
/// Most items of a list in an answer.
const MAX_ITEMS: usize = 20;
/// Most warnings in a status: the newest.
const MAX_WARNINGS: usize = 12;
/// Output lines a status ends with.
const OUTPUT_LINES: usize = 60;
/// Longest output line in a status.
const MAX_OUTPUT_LINE: usize = 300;
/// Most text a status holds: the oldest output lines give way first.
const MAX_STATUS: usize = 20_000;
/// Most of an answer's body a call shows.
const MAX_BODY: usize = 8_000;

/// `text` cut to `max` characters, saying how much was cut.
fn clip(text: &str, max: usize) -> String {
  match text.char_indices().nth(max) {
    Some((cut, _)) => format!("{}… ({} more characters)", &text[..cut], text[cut..].chars().count()),
    None => text.to_string(),
  }
}

/// Text from rayfin-local or the app, fit for the model: credentials masked, and short.
fn quote(text: &str, max: usize) -> String {
  clip(&redact_secrets(text.trim()), max)
}

/// `value` with every string quoted, and its lists and depth bounded.
fn scrub(value: &Value, depth: usize) -> Value {
  match value {
    Value::String(text) => Value::String(quote(text, MAX_TEXT)),
    Value::Array(items) if depth < 4 => {
      let mut out: Vec<Value> = items.iter().take(MAX_ITEMS).map(|item| scrub(item, depth + 1)).collect();
      if items.len() > MAX_ITEMS {
        out.push(Value::String(format!("… and {} more", items.len() - MAX_ITEMS)));
      }
      Value::Array(out)
    }
    Value::Object(map) if depth < 4 => Value::Object(map.iter().map(|(k, v)| (k.clone(), scrub(v, depth + 1))).collect()),
    Value::Array(_) | Value::Object(_) => Value::String("…".into()),
    other => other.clone(),
  }
}

fn scrubbed<T: serde::Serialize>(value: &T) -> Value {
  serde_json::to_value(value).map(|v| scrub(&v, 0)).unwrap_or(Value::Null)
}

fn problem(problem: &LocalProblem) -> Value {
  let mut out = Map::new();
  out.insert("code".into(), json!(problem.code));
  out.insert("message".into(), json!(quote(&problem.message, MAX_TEXT)));
  if let Some(hint) = problem.hint.as_deref().filter(|h| !h.trim().is_empty()) {
    out.insert("hint".into(), json!(quote(hint, MAX_TEXT)));
  }
  if problem.fatal {
    out.insert("fatal".into(), json!(true));
  }
  if let Some(details) = problem.details.as_ref().filter(|d| !d.is_null() && d.as_object().is_none_or(|o| !o.is_empty())) {
    out.insert("details".into(), scrub(details, 0));
  }
  if let Some(time) = &problem.time {
    out.insert("time".into(), json!(time));
  }
  Value::Object(out)
}

fn summary(status: &LocalStatus) -> String {
  match status.state {
    State::Running => match status.ready.as_ref().and_then(|r| r.app_url.as_deref()) {
      Some(url) => format!("The local backend is running, and the app is at {url}."),
      None => "The local backend is running.".into(),
    },
    State::Starting => "The local backend is still starting.".into(),
    State::Restarting => "The local backend is starting again.".into(),
    State::Error => match &status.error {
      Some(error) => format!("The local backend stopped on a problem (`{}`): {}", error.code, quote(&error.message, MAX_TEXT)),
      None => "The local backend stopped on a problem.".into(),
    },
    State::Stopped => "The local backend isn't running.".into(),
  }
}

/// The app's Rayfin SDK, and whether the local backend runs it.
fn sdk_report(status: &LocalStatus) -> Option<Value> {
  let sdk = status.ready.as_ref().and_then(|r| r.sdk.as_ref()).or_else(|| status.analysis.as_ref().and_then(|a| a.sdk.as_ref()));
  let warning = status.warnings.iter().find(|w| w.code == "sdk-unsupported");
  let detail = |key: &str| warning.and_then(|w| w.details.as_ref()).and_then(|d| d.get(key)).and_then(Value::as_str).map(String::from);
  if sdk.is_none() && warning.is_none() {
    return None;
  }
  let mut out = Map::new();
  out.insert("version".into(), json!(sdk.and_then(|s| s.version.clone()).or_else(|| detail("version"))));
  out.insert("supported".into(), json!(sdk.is_some_and(|s| s.supported) && warning.is_none()));
  if let Some(range) = detail("supported") {
    out.insert("supportedRange".into(), json!(range));
  }
  Some(Value::Object(out))
}

/// What the app offers: as `ready` reported it, else what the analysis found.
fn features_report(status: &LocalStatus) -> Option<Value> {
  if let Some(ready) = &status.ready {
    return Some(scrubbed(&ready.features));
  }
  let analysis = status.analysis.as_ref()?;
  Some(json!({ "data": { "entities": scrubbed(&analysis.entities) }, "storage": { "folders": scrubbed(&analysis.storage_folders) } }))
}

/// Who the app signs in as: `developer`, `none` or `user:<username>`.
fn signed_in_as(status: &LocalStatus) -> Option<String> {
  status.sign_in_as.clone().or_else(|| {
    let identity = status.ready.as_ref()?.sign_in_as.as_ref()?;
    let kind = identity.get("kind")?.as_str()?;
    match identity.pointer("/user/username").and_then(Value::as_str) {
      Some(user) if kind == "user" => Some(format!("user:{user}")),
      _ => Some(kind.to_string()),
    }
  })
}

/// What to do about what the status shows.
fn advice(status: &LocalStatus) -> Vec<String> {
  let mut out = Vec::new();
  let code = status.error.as_ref().map(|e| e.code.as_str());
  let stopped = status.state == State::Error;
  let refused = status.schema.as_ref().is_some_and(|s| s.result == "refused") || (stopped && code == Some("schema-refused"));
  if refused {
    out.push(
      "Your last data model change was refused because it would delete local data (`schema.losses`). Don't delete \
       data, the database or `.rayfin-local` to get around it. Tell the user what it would delete: Fabricator asks \
       them whether to apply it. To keep the data instead, change the model so it can stay, for example with an \
       optional field or a default value."
        .to_string(),
    );
  }
  if stopped {
    match code {
      Some("schema-refused") | None => {}
      Some(code) if OUTSIDE_THE_APP.contains(&code) => out.push(
        "The problem is outside the app's code (`error.hint`). Tell the user: Fabricator's preview shows it and \
         offers the fix."
          .into(),
      ),
      Some("packages-missing") => out.push(format!(
        "Run `npm install` once in the folder `error.details.dir` names, then call {LOCAL_STATUS_TOOL} again."
      )),
      Some(_) => out.push(format!(
        "Fix what `error` and `recentOutput` describe, then call {LOCAL_STATUS_TOOL} again: Fabricator starts the \
         backend again after your change."
      )),
    }
  }
  if status.state == State::Running && status.analysis.as_ref().is_some_and(|a| !a.ok) {
    out.push(
      "Your latest data model change couldn't be analyzed (`analysis.message`), so the previous model is still in \
       use. Fix it, then check again."
        .into(),
    );
  }
  if status.schema.as_ref().is_some_and(|s| s.result == "failed") {
    out.push("Applying your last data model change failed (`schema.message`); the previous schema is still in use.".into());
  }
  if status.functions.as_ref().is_some_and(|f| f.state == "failed") {
    out.push(
      "The functions' build failed (`functions.errors`): until it builds, calls to them fail or run the previous \
       build."
        .into(),
    );
  }
  if status.vite.as_ref().is_some_and(|v| matches!(v.state.as_str(), "exited" | "failed")) {
    out.push("The app's Vite stopped (`vite.message`, `recentOutput`), so the preview can't show the app.".into());
  }
  let mut seen: Vec<&str> = Vec::new();
  for warning in &status.warnings {
    let name = warning.details.as_ref().and_then(|d| d.get("name")).and_then(Value::as_str).unwrap_or("?");
    let text = match warning.code.as_str() {
      "anonymous-role" if !seen.contains(&"anonymous-role") => {
        "Entities grant the `anonymous` role. That works here, but most Fabric tenants refuse it when the app is \
         published: keep it only if the user asked for public access, and tell them."
          .to_string()
      }
      "secret-missing" => format!(
        "The secret {name} has no local value. Ask the user to set it in Fabricator's **Secrets** view, and never \
         ask for the value in chat."
      ),
      "azure-sign-in" if !seen.contains(&"azure-sign-in") => {
        "No Azure sign-in is available, so connectors, functions' `ctx.Tokens` and the developer's identity that \
         need one fail. Ask the user to sign in to the Azure CLI in Fabricator's **Accounts**."
          .to_string()
      }
      "connector-unsupported" => format!("The {name} connector runs only on Microsoft Fabric, so you can't call it here."),
      "sdk-unsupported" if !seen.contains(&"sdk-unsupported") => {
        "The app's Rayfin packages are outside the versions the local backend runs (`sdk`), so parts of the app may \
         not work here. Don't upgrade them further. Tell the user, and move every `@microsoft/rayfin-*` package back \
         to one `~` range the local backend runs only if they agree."
          .to_string()
      }
      _ => continue,
    };
    seen.push(warning.code.as_str());
    out.push(text);
  }
  out
}

/// One line of output: its time (UTC), source, level and text.
fn output_line(event: &LocalLogEvent) -> String {
  let time = event.time.get(11..19).filter(|_| event.time.contains('T')).unwrap_or("");
  format!("{time} {} {}: {}", event.source, event.level, quote(&event.line, MAX_OUTPUT_LINE)).trim_start().to_string()
}

/// The status tool's answer: a JSON object, with the newest output lines that fit.
fn status_report(status: &LocalStatus, output: &[LocalLogEvent], notes: &[String]) -> String {
  let mut report = Map::new();
  let mut put = |key: &str, value: Value| {
    report.insert(key.to_string(), value);
  };
  put("summary", json!(summary(status)));
  put("state", json!(status.state));
  if let Some(phase) = status.phase.as_deref().filter(|_| status.state == State::Starting) {
    put("phase", json!(phase));
  }
  if !notes.is_empty() {
    put("notes", json!(notes));
  }
  if let Some(ready) = &status.ready {
    let urls = [
      ("appUrl", ready.app_url.as_deref()),
      ("apiUrl", Some(ready.api_url.as_str())),
      ("portalUrl", ready.portal_url.as_deref()),
      ("embedUrl", ready.embed_url.as_deref()),
    ];
    for (key, url) in urls {
      if let Some(url) = url.filter(|u| !u.is_empty()) {
        put(key, json!(url));
      }
    }
  }
  if let Some(who) = signed_in_as(status) {
    put("signInAs", json!(who));
  }
  if let Some(version) = &status.version {
    put("rayfinLocal", json!(version));
  }
  if let Some(sdk) = sdk_report(status) {
    put("sdk", sdk);
  }
  if let Some(features) = features_report(status) {
    put("features", features);
  }
  if let Some(analysis) = status.analysis.as_ref().filter(|a| !a.ok) {
    put("analysis", json!({ "ok": false, "message": analysis.message.as_deref().map(|m| quote(m, MAX_TEXT)) }));
  }
  if let Some(schema) = &status.schema {
    put("schema", scrubbed(schema));
  }
  if let Some(functions) = &status.functions {
    put("functions", scrubbed(functions));
  }
  if let Some(vite) = &status.vite {
    put("vite", scrubbed(vite));
  }
  if let Some(config) = status.config.as_ref().filter(|c| c.restart_required || !c.applied) {
    put("config", scrubbed(config));
  }
  if !status.warnings.is_empty() {
    let skip = status.warnings.len().saturating_sub(MAX_WARNINGS);
    put("warnings", Value::Array(status.warnings.iter().skip(skip).map(problem).collect()));
  }
  if let Some(error) = &status.error {
    put("error", problem(error));
  }
  if status.crashes > 0 {
    put("crashes", json!(status.crashes));
  }
  let advice = advice(status);
  if !advice.is_empty() {
    put("advice", json!(advice));
  }
  let used = serde_json::to_string_pretty(&report).map(|text| text.len()).unwrap_or(0);
  let mut room = MAX_STATUS.saturating_sub(used);
  let mut lines: Vec<String> = Vec::new();
  for line in output.iter().rev().map(output_line) {
    // Quotes, a comma and the indentation.
    let size = line.len() + 8;
    if size > room {
      break;
    }
    room -= size;
    lines.push(line);
  }
  lines.reverse();
  if !lines.is_empty() {
    report.insert("recentOutput".into(), json!(lines));
  }
  serde_json::to_string_pretty(&report).unwrap_or_default()
}

/* ------------------------------- the call -------------------------------- */

#[derive(Deserialize)]
struct CallParams {
  #[serde(default, alias = "route", alias = "kind")]
  target: Option<String>,
  #[serde(default, alias = "function", alias = "connector")]
  name: Option<String>,
  #[serde(default, alias = "input", alias = "payload")]
  body: Option<Value>,
  #[serde(default, rename = "as", alias = "callAs", alias = "call_as", alias = "identity")]
  call_as: Option<String>,
  /// A test user named beside `as`.
  #[serde(default)]
  user: Option<String>,
  /// GraphQL's query and variables, passed beside `body`.
  #[serde(default)]
  query: Option<String>,
  #[serde(default)]
  variables: Option<Value>,
}

/// The app's routes the call tool reaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
  Graphql,
  Function,
  Connector,
  ConnectorGraphql,
}

impl Target {
  fn parse(text: &str) -> Option<Self> {
    match text.trim().to_ascii_lowercase().replace('_', "-").as_str() {
      "graphql" | "data" => Some(Self::Graphql),
      "function" | "functions" => Some(Self::Function),
      "connector" | "connector-invoke" => Some(Self::Connector),
      "connector-graphql" | "sql" => Some(Self::ConnectorGraphql),
      _ => None,
    }
  }
}

/// A checked call: where, with what, and as whom.
#[derive(Clone, Debug)]
struct CallRequest {
  name: Option<String>,
  path: String,
  body: Value,
  call_as: CallAs,
}

const GRAPHQL_BODY: &str = "Pass the GraphQL request as `body`: {\"query\": \"…\", \"variables\": {…}}.";
const CONNECTOR_BODY: &str =
  "Pass the connector call as `body`, such as {\"operation\": \"executeQuery\", \"input\": {\"query\": \"EVALUATE …\"}} for a semantic model.";

fn parse_call(params: CallParams) -> Result<CallRequest, String> {
  let target_text = params.target.as_deref().map(str::trim).unwrap_or_default();
  let target = Target::parse(target_text).ok_or_else(|| {
    let given = if target_text.is_empty() { String::new() } else { format!(", not {target_text:?}") };
    format!("`target` must be graphql, function, connector or connector-graphql{given}.")
  })?;
  let name = params.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(String::from);
  let path = app_path(target, name.as_deref())?;
  let call_as = caller(params.call_as.as_deref(), params.user.as_deref())?;
  let body = request_body(target, params.body, params.query, params.variables)?;
  Ok(CallRequest { name: if target == Target::Graphql { None } else { name }, path, body, call_as })
}

/// The route of `target` in the app's backend.
fn app_path(target: Target, name: Option<&str>) -> Result<String, String> {
  let named = |what: &str| -> Result<String, String> {
    let name = name.ok_or_else(|| format!("Pass the {what}'s name as `name`."))?;
    let valid = name.len() <= 128
      && !name.contains("..")
      && name.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
      && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if valid {
      Ok(name.to_string())
    } else {
      Err(format!("{name:?} isn't a {what} name: use letters, digits, `_`, `-` and `.`."))
    }
  };
  Ok(match target {
    Target::Graphql => "/graphql".to_string(),
    Target::Function => format!("/functions/{}/invoke", named("function")?),
    Target::Connector => format!("/connector-invoke/{}", named("connector")?),
    Target::ConnectorGraphql => format!("/connectors/{}/graphql", named("connector")?),
  })
}

/// Who a call is made as: `developer` (the default), `anonymous`, or
/// `user:<email>`, a test user created when missing.
fn caller(call_as: Option<&str>, user: Option<&str>) -> Result<CallAs, String> {
  let test_user = |name: &str| -> Result<CallAs, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().any(char::is_whitespace) {
      return Err("Name the test user as `as: user:<email>`, such as user:ana@example.com.".into());
    }
    Ok(CallAs::User { user: name.to_string(), create: true })
  };
  let text = call_as.map(str::trim).unwrap_or_default();
  match text.to_ascii_lowercase().as_str() {
    "" => user.map_or(Ok(CallAs::Developer), test_user),
    "developer" | "dev" | "you" | "me" => Ok(CallAs::Developer),
    "anonymous" | "anon" | "none" | "signed-out" | "signed out" | "public" => Ok(CallAs::Anonymous),
    "user" => test_user(user.unwrap_or_default()),
    _ => match text.split_once(':') {
      Some((kind, name)) if kind.trim().eq_ignore_ascii_case("user") => test_user(name),
      _ if text.contains('@') => test_user(text),
      _ => Err(format!("`as` must be developer, anonymous or user:<email>, not {text:?}.")),
    },
  }
}

/// The JSON body a route takes, from what the model passed.
fn request_body(target: Target, body: Option<Value>, query: Option<String>, variables: Option<Value>) -> Result<Value, String> {
  // A JSON body passed as a string.
  let body = match body {
    Some(Value::String(text)) => Some(serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text))),
    Some(Value::Null) => None,
    other => other,
  };
  match target {
    Target::Graphql | Target::ConnectorGraphql => {
      let body = match (body, query) {
        (Some(Value::String(query)), _) | (None, Some(query)) => {
          let mut body = json!({ "query": query });
          if let Some(variables) = variables.filter(|v| !v.is_null()) {
            body["variables"] = variables;
          }
          body
        }
        (Some(body), _) => body,
        (None, None) => return Err(GRAPHQL_BODY.into()),
      };
      match body.get("query").and_then(Value::as_str) {
        Some(query) if !query.trim().is_empty() => Ok(body),
        _ => Err(GRAPHQL_BODY.into()),
      }
    }
    Target::Function => Ok(body.unwrap_or_else(|| json!({}))),
    Target::Connector => match body {
      Some(body @ Value::Object(_)) => Ok(body),
      _ => Err(CONNECTOR_BODY.into()),
    },
  }
}

fn who(call_as: &CallAs) -> String {
  match call_as {
    CallAs::Developer => "as developer".into(),
    CallAs::Anonymous => "as anonymous (signed out)".into(),
    CallAs::User { user, .. } => format!("as user:{user}"),
  }
}

/// What a status means for the agent, when it isn't plain success.
fn status_note(call_as: &CallAs, status: u16) -> Option<String> {
  let caller = match call_as {
    CallAs::Developer => "the developer".to_string(),
    CallAs::Anonymous => "a signed-out caller".to_string(),
    CallAs::User { user, .. } => user.clone(),
  };
  Some(match status {
    401 => "The backend answered 401: this route needs a signed-in user.".into(),
    403 => format!("The backend refused the call (403): {caller} isn't allowed to do this."),
    404 => "Nothing answers there (404): check the name, and that the app declares it.".into(),
    501 => "Not available on this computer (501): this connector's type runs only on Microsoft Fabric.".into(),
    503 => format!("Unavailable (503): the backend is busy, or the functions' build failed. See {LOCAL_STATUS_TOOL}."),
    500..=599 => format!("The backend failed: see the answer, and the recent output in {LOCAL_STATUS_TOOL}."),
    _ => return None,
  })
}

/// The messages of a GraphQL answer's `errors`.
fn graphql_errors(answer: &Value) -> Option<String> {
  let errors = answer.get("errors")?.as_array().filter(|e| !e.is_empty())?;
  let mut messages: Vec<String> = errors
    .iter()
    .take(3)
    .map(|e| e.get("message").and_then(Value::as_str).map_or_else(|| quote(&e.to_string(), 200), |m| quote(m, 200)))
    .collect();
  if errors.len() > 3 {
    messages.push(format!("and {} more", errors.len() - 3));
  }
  Some(messages.join("; "))
}

/// The call tool's answer: what was called, the status, and the body.
fn call_report(request: &CallRequest, response: &AppResponse, notes: &[String]) -> String {
  let mut out = String::new();
  for note in notes {
    out.push_str(note);
    out.push('\n');
  }
  let reason = reqwest::StatusCode::from_u16(response.status).ok().and_then(|s| s.canonical_reason()).unwrap_or("");
  let header = format!("POST {} {}: {} {reason}", request.path, who(&request.call_as), response.status);
  out.push_str(header.trim_end());
  out.push('\n');
  if let Some(note) = status_note(&request.call_as, response.status) {
    out.push_str(&note);
    out.push('\n');
  }
  let content_type = response.content_type.as_deref().unwrap_or_default().to_ascii_lowercase();
  let body = response.body.trim();
  if content_type.contains("arrow") {
    out.push_str(&format!(
      "The answer is an Apache Arrow stream, which only the app's SDK decodes: the query ran. To read its values, \
       run `npx rayfin connector invoke {} executeQuery --file <query>.json` with the same input in the file.",
      request.name.as_deref().unwrap_or("<name>")
    ));
    return out;
  }
  if body.is_empty() {
    out.push_str("The answer has no body.");
    return out;
  }
  match serde_json::from_str::<Value>(body) {
    Ok(answer) => {
      if let Some(errors) = graphql_errors(&answer) {
        out.push_str(&format!(
          "The answer has GraphQL errors, which is also how the data API refuses a permission: {errors}\n"
        ));
      }
      let pretty = serde_json::to_string_pretty(&answer).unwrap_or_else(|_| body.to_string());
      out.push_str(&format!("Body (JSON):\n{}", quote(&pretty, MAX_BODY)));
    }
    Err(_) => {
      let kind = if content_type.is_empty() { "text" } else { content_type.as_str() };
      out.push_str(&format!("Body ({kind}):\n{}", quote(body, MAX_BODY)));
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  fn text_of(r: &ToolResult) -> String {
    match r {
      ToolResult::Text(s) => s.clone(),
      ToolResult::Expanded(e) => e.text_result_for_llm.clone(),
      _ => String::new(),
    }
  }

  #[test]
  fn render_sm_needs_az_points_to_az_login() {
    let r = semantic_model::SemanticModelResult {
      ok: false,
      needs_az: true,
      error: Some("az account get-access-token failed".into()),
      ..Default::default()
    };
    let t = text_of(&render_semantic_model_result(&r));
    assert!(t.contains("az login"), "got: {t}");
  }

  #[test]
  fn render_sm_lists_models_and_wiring_command() {
    let m = semantic_model::SemanticModel {
      name: Some("Sales".into()),
      id: Some("ds-1".into()),
      item_id: Some("ds-1".into()),
      workspace_id: Some("ws-1".into()),
      workspace_name: Some("Finance".into()),
      ..Default::default()
    };
    let r = semantic_model::SemanticModelResult {
      ok: true,
      matched: true,
      models: vec![m],
      ..Default::default()
    };
    let t = text_of(&render_semantic_model_result(&r));
    assert!(t.contains("Sales"), "got: {t}");
    assert!(t.contains("item id (= dataset id): ds-1"), "got: {t}");
    assert!(
      t.contains("fabric-app-data add <alias> -w ws-1 -i ds-1"),
      "got: {t}"
    );
    assert!(
      t.contains("npx rayfin connector add --type fabric-semanticmodel --workspace-id ws-1 --item-id ds-1 --name <alias>"),
      "got: {t}"
    );
  }

  #[test]
  fn render_sm_soft_no_match_surfaces_hint() {
    let r = semantic_model::SemanticModelResult {
      ok: true,
      matched: false,
      error: Some("That looks like a GUID — use the locate tool for direct id/URL lookups.".into()),
      ..Default::default()
    };
    let t = text_of(&render_semantic_model_result(&r));
    assert!(t.contains("No matching semantic model"), "got: {t}");
    assert!(t.contains("use the locate tool"), "got: {t}");
  }

  /* ---------------------------- local backend ---------------------------- */

  use crate::services::local_backend::{Binary, Policy, Settings};

  /// An RFC 3339 time, `seconds` ago.
  fn ago(seconds: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::seconds(seconds)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
  }

  fn json_of(result: &ToolResult) -> Value {
    let text = text_of(result);
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{e}: {text}"))
  }

  /// A running backend with something to say about every part of the app.
  fn eventful() -> LocalStatus {
    serde_json::from_value(json!({
      "projectId": "p",
      "state": "running",
      "revision": 7,
      "version": "0.2.0",
      "signInAs": "developer",
      "ready": {
        "appUrl": "http://localhost:5173/",
        "apiUrl": "http://localhost:7171",
        "portalUrl": "http://localhost:7171/.rayfin-local/portal",
        "sdk": { "version": "1.36.2", "supported": true },
        "features": {
          "data": { "enabled": true, "entities": ["Note", "Tag"] },
          "functions": { "enabled": true, "names": ["getBacklog"] },
          "storage": { "enabled": false, "folders": [] },
          "auth": { "enabled": true, "fabric": true, "password": false },
          "connectors": [
            { "name": "sales", "type": "fabric-semanticmodel", "supported": true },
            { "name": "logs", "type": "kusto", "supported": false }
          ]
        },
        "time": ago(60)
      },
      "analysis": { "ok": true, "entities": ["Note", "Tag"], "time": ago(30) },
      "schema": { "result": "refused", "changes": ["changed Note"], "losses": ["Note.title (3 values)"], "live": true, "time": ago(30) },
      "functions": { "state": "failed", "names": ["getBacklog"], "errors": ["src/index.ts(3,1): error TS2304: Cannot find name 'x'."], "time": ago(20) },
      "vite": { "state": "ready", "url": "http://localhost:5173/" },
      "warnings": [
        { "code": "anonymous-role", "message": "Entities grant anonymous.", "details": { "entities": ["Note"] } },
        { "code": "secret-missing", "message": "API_KEY has no value.", "details": { "name": "API_KEY" } },
        { "code": "connector-unsupported", "message": "logs runs only on Fabric.", "details": { "name": "logs", "type": "kusto" } },
        { "code": "azure-sign-in", "message": "No token: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", "details": {} }
      ]
    }))
    .unwrap()
  }

  fn line(seq: u64, text: &str) -> LocalLogEvent {
    LocalLogEvent {
      project_id: "p".into(),
      seq,
      source: "functions".into(),
      level: "info".into(),
      line: text.into(),
      time: "2026-10-30T03:12:09.512Z".into(),
    }
  }

  #[test]
  fn the_status_reports_what_the_agent_acts_on() {
    let output = vec![line(1, "built"), line(2, "token Bearer abcdef123456, key pk-local-abcdefghijklmnopqrstuvwx")];
    let text = status_report(&eventful(), &output, &["Fabricator started it.".into()]);
    let report: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(report["state"], "running");
    assert_eq!(report["summary"], "The local backend is running, and the app is at http://localhost:5173/.");
    assert_eq!(report["notes"], json!(["Fabricator started it."]));
    assert_eq!((report["appUrl"].as_str(), report["apiUrl"].as_str()), (Some("http://localhost:5173/"), Some("http://localhost:7171")));
    assert_eq!(report["signInAs"], "developer");
    assert_eq!(report["sdk"], json!({ "version": "1.36.2", "supported": true }));
    assert_eq!(report["features"]["data"]["entities"], json!(["Note", "Tag"]));
    assert_eq!(report["features"]["functions"]["names"], json!(["getBacklog"]));
    assert_eq!(report["features"]["connectors"][1], json!({ "name": "logs", "type": "kusto", "supported": false }));
    assert_eq!(report["features"]["storage"]["enabled"], false);
    assert_eq!((report["schema"]["result"].as_str(), report["schema"]["live"].as_bool()), (Some("refused"), Some(true)));
    assert_eq!(report["schema"]["losses"], json!(["Note.title (3 values)"]));
    assert_eq!(report["functions"]["state"], "failed");
    assert!(report["functions"]["errors"][0].as_str().unwrap().contains("TS2304"));
    assert_eq!(report["vite"]["state"], "ready");
    assert_eq!(report["warnings"].as_array().unwrap().len(), 4);
    let advice = report["advice"].to_string();
    for marker in [
      "`schema.losses`",
      "Don't delete",
      "Fabricator asks",
      "`functions.errors`",
      "most Fabric tenants refuse it",
      "API_KEY",
      "**Secrets** view",
      "The logs connector runs only on Microsoft Fabric",
      "Azure CLI",
    ] {
      assert!(advice.contains(marker), "advice should mention {marker}: {advice}");
    }
    assert_eq!(report["recentOutput"][0], "03:12:09 functions info: built");
    // Credentials never reach the model.
    for secret in ["c2lnbmF0dXJl", "abcdef123456", "pk-local-abcdefghijklmnopqrstuvwx"] {
      assert!(!text.contains(secret), "{secret} leaked: {text}");
    }
  }

  #[test]
  fn the_status_stays_short_and_keeps_the_newest_output() {
    let long = "x".repeat(2000);
    let output: Vec<LocalLogEvent> = (0..400).map(|i| line(i, &format!("{i} {long}"))).collect();
    let mut status = eventful();
    status.functions.as_mut().unwrap().errors = (0..500).map(|i| format!("error {i}: {long}")).collect();
    let text = status_report(&status, &output, &[]);
    assert!(text.len() <= MAX_STATUS + 1000, "{}", text.len());
    let report: Value = serde_json::from_str(&text).unwrap();
    let errors = report["functions"]["errors"].as_array().unwrap();
    assert_eq!(errors.len(), MAX_ITEMS + 1);
    assert_eq!(errors[MAX_ITEMS], format!("… and {} more", 500 - MAX_ITEMS));
    assert!(errors[0].as_str().unwrap().ends_with("more characters)"));
    let shown = report["recentOutput"].as_array().unwrap();
    assert!(!shown.is_empty() && shown.len() < 400);
    assert!(shown.last().unwrap().as_str().unwrap().starts_with("03:12:09 functions info: 399 xxx"));
  }

  #[test]
  fn a_stopped_backend_says_why_and_what_to_do() {
    let stopped = |error: Value| -> LocalStatus { serde_json::from_value(json!({ "state": "error", "error": error })).unwrap() };
    let advice_of = |status: &LocalStatus| -> Vec<String> {
      serde_json::from_str::<Value>(&status_report(status, &[], &[])).unwrap()["advice"]
        .as_array()
        .map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect())
        .unwrap_or_default()
    };

    let mut refused = stopped(json!({
      "code": "schema-refused", "message": "The change would delete data.", "fatal": true,
      "details": { "losses": ["Note.title (3 values)"] }
    }));
    refused.schema = Some(crate::types::LocalSchema { result: "refused".into(), losses: vec!["Note.title (3 values)".into()], ..Default::default() });
    let report: Value = serde_json::from_str(&status_report(&refused, &[], &[])).unwrap();
    assert_eq!(report["summary"], "The local backend stopped on a problem (`schema-refused`): The change would delete data.");
    assert_eq!(report["error"]["details"]["losses"][0], "Note.title (3 values)");
    assert_eq!(report["error"]["fatal"], true);
    let advice = advice_of(&refused);
    assert_eq!(advice.len(), 1, "{advice:?}");
    assert!(advice[0].contains("was refused"));

    let blocked = stopped(json!({ "code": "binary-blocked", "message": "Windows blocked rayfin-local.", "hint": "Allow it." }));
    assert!(advice_of(&blocked)[0].contains("outside the app's code"));
    let packages = stopped(json!({ "code": "packages-missing", "message": "Run npm install.", "details": { "dir": "rayfin/functions" } }));
    assert!(advice_of(&packages)[0].contains("`npm install`"));
    let analysis = stopped(json!({ "code": "analysis-failed", "message": "Note.ts(3,1): error TS1005." }));
    assert!(advice_of(&analysis)[0].contains("starts the backend again after your change"));

    let never: Value = serde_json::from_str(&status_report(&LocalStatus::default(), &[], &[])).unwrap();
    assert_eq!(never["state"], "stopped");
    assert_eq!(never["summary"], "The local backend isn't running.");
    assert!(never.get("advice").is_none() && never.get("recentOutput").is_none());
  }

  #[test]
  fn changes_wait_for_the_report_that_covers_them() {
    let status: LocalStatus = serde_json::from_value(json!({
      "state": "running",
      "analysis": { "ok": true, "time": ago(10) },
      "functions": { "state": "ready", "time": ago(5) },
      "ready": { "apiUrl": "http://localhost:7171", "time": ago(10) }
    }))
    .unwrap();
    let before = SystemTime::now() - Duration::from_secs(60);
    let now = SystemTime::now();
    let stamps = |model, functions, config| Stamps { model, functions, config };
    assert_eq!(unreported(&stamps(Some(before), Some(before), Some(before)), &status), None);
    assert_eq!(unreported(&stamps(Some(now), None, None), &status), Some(now));
    assert_eq!(unreported(&stamps(None, Some(now), None), &status), Some(now));
    assert_eq!(unreported(&stamps(None, None, Some(now)), &status), Some(now));
    // Functions that are off never report on their sources.
    let mut off = status.clone();
    off.functions.as_mut().unwrap().state = "off".into();
    assert_eq!(unreported(&stamps(None, Some(now), None), &off), None);
    // Without a report's time there's nothing to wait for.
    assert_eq!(unreported(&stamps(Some(now), Some(now), Some(now)), &LocalStatus::default()), None);

    assert!(!busy(&status));
    let mut building = status.clone();
    building.functions.as_mut().unwrap().state = "building".into();
    assert!(busy(&building));
  }

  fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fab-agent-tools-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  /// Write `text` to `rel` in `dir`, modified `age` ago.
  fn write_aged(dir: &Path, rel: &str, text: &str, age: Duration) -> SystemTime {
    let path = dir.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, text).unwrap();
    let at = SystemTime::now() - age;
    std::fs::File::options().write(true).open(&path).unwrap().set_modified(at).unwrap();
    at
  }

  fn close(a: Option<SystemTime>, b: SystemTime) -> bool {
    a.is_some_and(|a| a.duration_since(b).or_else(|e| Ok::<_, ()>(e.duration())).unwrap() < Duration::from_millis(5))
  }

  #[test]
  fn source_stamps_follow_the_projects_layout() {
    let dir = scratch("layout");
    let yml = "services:\n  data:\n    path: packages/data\n  functions:\n    path: packages/functions\n";
    let config = write_aged(&dir, "rayfin/rayfin.yml", yml, Duration::from_secs(500));
    write_aged(&dir, "packages/data/src/Note.ts", "x", Duration::from_secs(400));
    let model = write_aged(&dir, "packages/data/rayfin/data/Tag.ts", "x", Duration::from_secs(300));
    let functions = write_aged(&dir, "packages/functions/src/index.ts", "x", Duration::from_secs(200));
    // Dependencies, build output, lockfiles, hidden folders, notes and the frontend don't count.
    for rel in [
      "packages/data/node_modules/dep/index.js",
      "packages/functions/dist/index.js",
      "packages/functions/package-lock.json",
      "packages/functions/.cache/state.json",
      "packages/functions/src/README.md",
      "src/App.tsx",
    ] {
      write_aged(&dir, rel, "x", Duration::from_secs(1));
    }
    let stamps = source_stamps(&dir);
    assert!(close(stamps.config, config), "{stamps:?}");
    assert!(close(stamps.model, model), "{stamps:?}");
    assert!(close(stamps.functions, functions), "{stamps:?}");

    // A single-package app keeps them under `rayfin/`.
    let single = scratch("single");
    let entity = write_aged(&single, "rayfin/data/Note.ts", "x", Duration::from_secs(30));
    write_aged(&single, "src/main.tsx", "x", Duration::from_secs(1));
    let stamps = source_stamps(&single);
    assert!(close(stamps.model, entity) && stamps.functions.is_none() && stamps.config.is_none(), "{stamps:?}");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&single);
  }

  #[test]
  fn calls_go_to_the_apps_own_routes() {
    let route = |target: &str, name: Option<&str>| {
      let params = json!({ "target": target, "name": name, "body": { "query": "{ x }", "operation": "executeQuery" } });
      parse_call(serde_json::from_value(params).unwrap()).map(|request| request.path)
    };
    assert_eq!(route("graphql", Some("ignored")).unwrap(), "/graphql");
    assert_eq!(route("function", Some("getBacklog")).unwrap(), "/functions/getBacklog/invoke");
    assert_eq!(route("connector", Some("sales")).unwrap(), "/connector-invoke/sales");
    assert_eq!(route("connector-graphql", Some("warehouse")).unwrap(), "/connectors/warehouse/graphql");
    assert_eq!(route("connector_graphql", Some("warehouse")).unwrap(), "/connectors/warehouse/graphql");
    for bad in ["../control", "a/b", "x?y", ".hidden", "a b", "a..b"] {
      assert!(route("function", Some(bad)).is_err(), "{bad}");
    }
    assert!(route("function", Some(" ")).unwrap_err().contains("`name`"));
    assert!(route("mutation", None).unwrap_err().contains("`target` must be"));
  }

  #[test]
  fn callers_come_from_as() {
    assert_eq!(caller(None, None), Ok(CallAs::Developer));
    assert_eq!(caller(Some("developer"), None), Ok(CallAs::Developer));
    for anonymous in ["anonymous", "Anonymous", "signed-out", "none"] {
      assert_eq!(caller(Some(anonymous), None), Ok(CallAs::Anonymous), "{anonymous}");
    }
    let ana = Ok(CallAs::User { user: "ana@example.com".into(), create: true });
    assert_eq!(caller(Some("user:ana@example.com"), None), ana);
    assert_eq!(caller(Some("ana@example.com"), None), ana);
    assert_eq!(caller(Some("user"), Some("ana@example.com")), ana);
    assert_eq!(caller(None, Some("ana@example.com")), ana);
    assert!(caller(Some("user:"), None).is_err());
    assert!(caller(Some("admin"), None).unwrap_err().contains("`as` must be"));
  }

  #[test]
  fn bodies_fit_their_route() {
    let query = json!({ "query": "{ notes { items { id } } }" });
    assert_eq!(request_body(Target::Graphql, Some(query.clone()), None, None), Ok(query.clone()));
    // A bare query, as the body or beside it, and a JSON body passed as a string.
    assert_eq!(request_body(Target::Graphql, Some(json!("{ x }")), None, None), Ok(json!({ "query": "{ x }" })));
    assert_eq!(
      request_body(Target::ConnectorGraphql, None, Some("{ x }".into()), Some(json!({ "n": 1 }))),
      Ok(json!({ "query": "{ x }", "variables": { "n": 1 } }))
    );
    assert_eq!(request_body(Target::Graphql, Some(json!(query.to_string())), None, None), Ok(query));
    assert!(request_body(Target::Graphql, None, None, None).unwrap_err().contains("`body`"));
    assert!(request_body(Target::Graphql, Some(json!({ "variables": {} })), None, None).is_err());
    assert_eq!(request_body(Target::Function, None, None, None), Ok(json!({})));
    assert_eq!(request_body(Target::Function, Some(json!({ "limit": 5 })), None, None), Ok(json!({ "limit": 5 })));
    let invoke = json!({ "operation": "executeQuery", "input": { "query": "EVALUATE Sales" } });
    assert_eq!(request_body(Target::Connector, Some(invoke.clone()), None, None), Ok(invoke));
    assert!(request_body(Target::Connector, Some(json!("EVALUATE Sales")), None, None).unwrap_err().contains("executeQuery"));
  }

  #[test]
  fn call_answers_show_the_status_and_a_short_masked_body() {
    let answer = |status: u16, content_type: &str, body: &str| AppResponse {
      status,
      content_type: Some(content_type.into()),
      body: body.into(),
    };
    let graphql = CallRequest { name: None, path: "/graphql".into(), body: json!({}), call_as: CallAs::Anonymous };
    let denied = r#"{"data":null,"errors":[{"message":"The current user is not authorized to access this resource."}]}"#;
    let refused = call_report(&graphql, &answer(200, "application/json", denied), &[]);
    assert!(refused.starts_with("POST /graphql as anonymous (signed out): 200 OK\n"), "{refused}");
    assert!(refused.contains("GraphQL errors") && refused.contains("is not authorized"), "{refused}");
    let forbidden = call_report(&graphql, &answer(403, "application/json", r#"{"error":"no"}"#), &[]);
    assert!(forbidden.contains("refused the call (403): a signed-out caller isn't allowed"), "{forbidden}");

    let token = r#"{"data":{"me":{"accessToken":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"}}}"#;
    let masked = call_report(&graphql, &answer(200, "application/json", token), &["Fabricator started it.".into()]);
    assert!(masked.starts_with("Fabricator started it.\nPOST /graphql"), "{masked}");
    assert!(!masked.contains("c2lnbmF0dXJl"), "{masked}");

    let notes = vec![r#"{"title":"a note"}"#; 2000].join(",");
    let long = call_report(&graphql, &answer(200, "application/json", &format!(r#"{{"data":{{"notes":[{notes}]}}}}"#)), &[]);
    assert!(long.contains("more characters)") && long.len() < MAX_BODY + 400, "{}", long.len());

    let sales = CallRequest { name: Some("sales".into()), path: "/connector-invoke/sales".into(), body: json!({}), call_as: CallAs::Developer };
    let arrow = call_report(&sales, &answer(200, "application/vnd.apache.arrow.stream", "\u{1}ARROW1"), &[]);
    assert!(arrow.contains("Apache Arrow") && arrow.contains("npx rayfin connector invoke sales executeQuery"), "{arrow}");
    assert!(!arrow.contains("ARROW1"));
    let gateway = call_report(&sales, &answer(502, "text/html", "<html>bad gateway</html>"), &[]);
    assert!(gateway.contains("as developer: 502 Bad Gateway") && gateway.contains("Body (text/html):\n<html>bad gateway</html>"), "{gateway}");
  }

  /// The supervisor tests' stand-in rayfin-local under a real [`LocalBackends`]
  /// (run with the `node` on `PATH`; `None` without one).
  struct Fake {
    backends: LocalBackends,
    root: PathBuf,
  }

  impl Drop for Fake {
    fn drop(&mut self) {
      self.backends.kill_all();
      let _ = std::fs::remove_dir_all(&self.root);
    }
  }

  fn fake() -> Option<Fake> {
    let node = which::which("node").ok()?;
    let root = scratch("fake");
    let script = root.join("fake-rayfin-local.cjs");
    std::fs::write(&script, include_str!("local_backend/fake_rayfin_local.cjs")).unwrap();
    let backends = LocalBackends::new(Settings {
      binary: Some(Binary { program: node, prefix: vec![script.into_os_string()] }),
      log_dir: Some(root.join("logs")),
      policy: Policy::default(),
      host_env: false,
    });
    Some(Fake { backends, root })
  }

  impl Fake {
    /// A project the stand-in serves in `mode` (see `fake_rayfin_local.cjs`).
    fn project(&self, mode: &str) -> (String, PathBuf) {
      let id = uuid::Uuid::new_v4().to_string();
      let dir = self.root.join(&id);
      std::fs::create_dir_all(&dir).unwrap();
      std::fs::write(dir.join("fake-mode"), mode).unwrap();
      (id, dir)
    }
  }

  fn quick() -> Waits {
    Waits {
      start: Duration::from_secs(20),
      change: Duration::from_millis(800),
      busy: Duration::from_secs(5),
      quiet: Duration::from_millis(100),
      poll: Duration::from_millis(20),
    }
  }

  fn call(params: Value) -> CallRequest {
    parse_call(serde_json::from_value(params).unwrap()).unwrap()
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn the_tools_start_the_backend_and_call_the_app_as_each_user() {
    let Some(fake) = fake() else { return };
    let (id, dir) = fake.project("ok");
    let text = text_of(&local_status(&fake.backends, &id, &dir, quick()).await);
    let report: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(report["state"], "running", "{text}");
    assert!(report["notes"][0].as_str().unwrap().contains("Fabricator started it"), "{text}");
    assert_eq!(report["features"]["data"]["entities"], json!(["Note"]));
    assert_eq!(report["schema"]["result"], "applied");
    assert!(report["recentOutput"].to_string().contains("token check ***"), "{text}");
    assert!(!regex::Regex::new("[0-9a-f]{64}").unwrap().is_match(&text), "the control token never shows: {text}");
    let again = json_of(&local_status(&fake.backends, &id, &dir, quick()).await);
    assert!(again.get("notes").is_none(), "a running backend is left alone: {again}");

    let graphql = |call_as: Option<&str>| call(json!({ "target": "graphql", "body": { "query": "{ notes { items { id } } }" }, "as": call_as }));
    let developer = text_of(&local_call(&fake.backends, &id, &dir, &graphql(None), quick()).await);
    assert!(developer.starts_with("POST /graphql as developer: 200 OK\n"), "{developer}");
    assert!(developer.contains(r#""key": "pk_fake""#) && !developer.contains("access-developer"), "{developer}");
    let anonymous = text_of(&local_call(&fake.backends, &id, &dir, &graphql(Some("anonymous")), quick()).await);
    assert!(anonymous.contains("as anonymous (signed out): 200 OK") && anonymous.contains(r#""auth": null"#), "{anonymous}");
    let ana = text_of(&local_call(&fake.backends, &id, &dir, &graphql(Some("user:ana@example.com")), quick()).await);
    assert!(ana.contains("as user:ana@example.com: 200 OK") && !ana.contains("access-ana"), "{ana}");
    // The stand-in has no functions: the app's own answer comes back as it is.
    let function = call(json!({ "target": "function", "name": "getBacklog" }));
    let missing = text_of(&local_call(&fake.backends, &id, &dir, &function, quick()).await);
    assert!(missing.starts_with("POST /functions/getBacklog/invoke as developer: 404 Not Found\n"), "{missing}");
    assert!(missing.contains("No such route."), "{missing}");
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn a_backend_stopped_by_the_app_starts_again_once_the_app_changed() {
    let Some(fake) = fake() else { return };
    let (id, dir) = fake.project("fatal");
    let refused = json_of(&local_status(&fake.backends, &id, &dir, quick()).await);
    assert_eq!((refused["state"].as_str(), refused["error"]["code"].as_str()), (Some("error"), Some("schema-refused")), "{refused}");
    assert_eq!(refused["schema"]["losses"], json!(["Note.title (3 values)"]));
    assert!(refused["advice"][0].as_str().unwrap().contains("was refused"));
    // Nothing changed: it waits for the user's decision.
    let unchanged = json_of(&local_status(&fake.backends, &id, &dir, quick()).await);
    assert_eq!(unchanged["state"], "error");
    assert!(unchanged.get("notes").is_none(), "{unchanged}");

    // The model changes so the data can stay.
    tokio::time::sleep(Duration::from_millis(50)).await;
    std::fs::write(dir.join("fake-mode"), "ok").unwrap();
    write_aged(&dir, "rayfin/data/Note.ts", "export class Note {}", Duration::ZERO);
    let fixed = json_of(&local_status(&fake.backends, &id, &dir, quick()).await);
    assert_eq!(fixed["state"], "running", "{fixed}");
    assert!(fixed["notes"][0].as_str().unwrap().contains("(`schema-refused`)"), "{fixed}");
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn a_backend_left_on_a_model_it_couldnt_analyze_starts_again_once_the_app_changed() {
    let Some(fake) = fake() else { return };
    let (id, dir) = fake.project("analysis-fails-once");
    let stuck = json_of(&local_status(&fake.backends, &id, &dir, quick()).await);
    assert_eq!((stuck["state"].as_str(), stuck["analysis"]["ok"].as_bool()), (Some("running"), Some(false)), "{stuck}");
    assert!(stuck["advice"].to_string().contains("couldn't be analyzed"), "{stuck}");
    // Nothing changed since: it keeps running.
    let unchanged = json_of(&local_status(&fake.backends, &id, &dir, quick()).await);
    assert!(unchanged.get("notes").is_none(), "{unchanged}");
    assert_eq!(std::fs::read_to_string(dir.join("starts")).unwrap(), "1");

    // The data model changes after the analysis that failed, which live reload doesn't always analyze again.
    tokio::time::sleep(Duration::from_millis(50)).await;
    write_aged(&dir, "rayfin/data/Note.ts", "export class Note {}", Duration::ZERO);
    let fixed = json_of(&local_status(&fake.backends, &id, &dir, quick()).await);
    assert_eq!(fixed["state"], "running", "{fixed}");
    assert!(fixed.get("analysis").is_none(), "starting analyzed it again: {fixed}");
    assert!(fixed["notes"][0].as_str().unwrap().contains("a change it couldn't analyze"), "{fixed}");
    assert_eq!(std::fs::read_to_string(dir.join("starts")).unwrap(), "2");
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn a_change_the_backend_never_reports_on_costs_one_wait() {
    let Some(fake) = fake() else { return };
    let (id, dir) = fake.project("ok");
    assert_eq!(json_of(&local_status(&fake.backends, &id, &dir, quick()).await)["state"], "running");
    // Saved after the backend's analysis, which the stand-in never runs again.
    tokio::time::sleep(Duration::from_millis(50)).await;
    write_aged(&dir, "rayfin/data/Note.ts", "export class Note {}", Duration::ZERO);
    let began = Instant::now();
    let waited = json_of(&local_status(&fake.backends, &id, &dir, quick()).await);
    assert!(began.elapsed() >= quick().change);
    assert!(waited["notes"][0].as_str().unwrap().contains("hasn't reported on your latest changes"), "{waited}");
    let began = Instant::now();
    let again = json_of(&local_status(&fake.backends, &id, &dir, quick()).await);
    assert!(began.elapsed() < quick().change, "the same change isn't waited for twice");
    assert!(again.get("notes").is_none(), "{again}");
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn calls_say_why_when_the_backend_cannot_run() {
    let root = scratch("missing");
    let backends = LocalBackends::new(Settings {
      binary: Some(Binary::executable(root.join("missing-rayfin-local.exe"))),
      log_dir: Some(root.join("logs")),
      policy: Policy::default(),
      host_env: false,
    });
    let request = call(json!({ "target": "graphql", "body": { "query": "{ x }" } }));
    let result = local_call(&backends, "p", &root, &request, quick()).await;
    let ToolResult::Expanded(failed) = &result else { panic!("a failure: {}", text_of(&result)) };
    assert_eq!(failed.result_type, "failure");
    assert!(failed.text_result_for_llm.contains("can't take calls"), "{}", failed.text_result_for_llm);
    assert!(failed.text_result_for_llm.contains(LOCAL_STATUS_TOOL));
    let status = json_of(&local_status(&backends, "p", &root, quick()).await);
    assert_eq!((status["state"].as_str(), status["error"]["code"].as_str()), (Some("error"), Some("binary-missing")), "{status}");
    assert!(status["advice"][0].as_str().unwrap().contains("outside the app's code"), "{status}");
    let _ = std::fs::remove_dir_all(&root);
  }
}
