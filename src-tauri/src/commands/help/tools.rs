//! Client-defined tools the Help assistant reports through, and the one it
//! reads with.
//!
//! The assistant can't change anything, so its reporting tools don't *do*
//! work — they turn parts of an answer into UI the user can act on. An offered
//! action becomes a button in the transcript; a citation becomes a docs link.
//! `help_local_output` reads the open app's local backend output, redacted.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::{ToolInvocation, ToolResultExpanded};
use github_copilot_sdk::{Error as SdkError, Tool, ToolResult};
use serde::Deserialize;
use serde_json::{json, Value};

use super::local;
use crate::types::{HelpAction, HelpCitation, HelpEvent, HelpIssueDraft, LocalLogEvent};

pub const ACTION_TOOL: &str = "help_offer_action";
pub const CITE_TOOL: &str = "help_cite";
pub const ISSUE_TOOL: &str = "help_draft_issue";
pub const LOCAL_OUTPUT_TOOL: &str = "help_local_output";

/// Where `help_local_output` reads: the open project's last `n` lines of local
/// backend output, oldest first.
pub type LocalOutput = Arc<dyn Fn(usize) -> Vec<LocalLogEvent> + Send + Sync>;

/// Sources a local backend output line can come from.
const OUTPUT_SOURCES: &[&str] = &["rayfin-local", "vite", "functions", "build", "fabricator", "npm", "stderr", "stdout"];

/// True for the assistant's own reporting tools, which are hidden from the
/// activity feed (the user sees their result as a button or a link instead).
pub fn is_reporting_tool(name: &str) -> bool {
  name == ACTION_TOOL || name == CITE_TOOL || name == ISSUE_TOOL
}

/// The safe app operations the assistant may offer. Each maps to something the
/// user could already do themselves from the UI; the button is a shortcut,
/// never a new capability, and none of them change the user's app.
pub const ACTIONS: &[(&str, &str)] = &[
  ("open-docs", "Open a documentation page in the browser. Needs `url`."),
  (
    "open-project",
    "Open one of the user's projects. Needs `target`, the project's id from the list above.",
  ),
  ("open-home", "Show the list of all their projects, so they can pick one."),
  ("share-app", "Open the dialog for sharing the open project's published app with someone. Personal projects only."),
  (
    "open-team-access",
    "Open the team workspace overview, where an owner grants access to the team's apps. Use this \
instead of `share-app` for a team app.",
  ),
  ("open-advisor", "Open the Advisor, which reviews the open project for problems."),
  ("open-code", "Show the open project's files."),
  ("run-doctor", "Re-check that the required tools are installed."),
  ("refresh-fabric-auth", "Refresh the Microsoft Fabric sign-in."),
  ("sign-in-copilot", "Sign in to GitHub Copilot again."),
  ("export-diagnostics", "Write a diagnostics file and reveal it in the file manager."),
  ("open-logs", "Open the logs folder."),
  ("report-issue", "Open a prefilled GitHub bug report."),
  ("open-settings", "Open Settings."),
  ("open-accounts", "Open the Accounts dialog."),
];

/// Actions that only make sense with a project open.
const NEEDS_PROJECT: &[&str] = &["share-app", "open-advisor", "open-code", "open-team-access"];

/// Actions that only apply to a personal project. A team app is published by
/// the team's pipeline and its access is granted workspace-wide by an owner, so
/// it has no Share control at all — offering one would be a dead button.
const PERSONAL_ONLY: &[&str] = &["share-app"];

/// Actions that only apply to a team app.
const TEAM_ONLY: &[&str] = &["open-team-access"];

/// The only actions that work from the setup screen. The rest need the
/// workbench, which doesn't exist yet while someone is still setting up —
/// offering one there produces a button that does nothing when pressed.
const SETUP_SAFE: &[&str] = &[
  "open-docs",
  "open-logs",
  "export-diagnostics",
  "report-issue",
  "run-doctor",
  "sign-in-copilot",
];

/// Where the user is standing when they ask. Decides whether an in-app
/// navigation action can actually take them anywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Surface {
  /// Still setting up; the workbench isn't running.
  Setup,
  /// Looking at the list of their projects.
  Home,
  /// Inside a project.
  #[default]
  Project,
}

impl Surface {
  pub fn parse(raw: Option<&str>) -> Self {
    match raw.map(str::trim).unwrap_or_default() {
      "setup" => Self::Setup,
      "home" => Self::Home,
      _ => Self::Project,
    }
  }
}

fn action_ids() -> Vec<&'static str> {
  ACTIONS.iter().map(|(id, _)| *id).collect()
}

/// The catalogue, rendered for the prompt so the model knows what it can offer.
pub fn action_catalogue() -> String {
  ACTIONS.iter().map(|(id, what)| format!("- `{id}` — {what}")).collect::<Vec<_>>().join("\n")
}

pub type Emit = Arc<dyn Fn(HelpEvent) + Send + Sync>;

/// Collects what one turn produced, so the command can persist it with the
/// finished message.
#[derive(Default)]
pub struct TurnArtifacts {
  pub actions: Vec<HelpAction>,
  pub citations: Vec<HelpCitation>,
  pub issue: Option<HelpIssueDraft>,
}

pub type SharedArtifacts = Arc<Mutex<TurnArtifacts>>;

pub struct ToolContext {
  pub emit: Emit,
  pub artifacts: SharedArtifacts,
  /// Ids of the user's projects, so `open-project` can't be offered for one
  /// that doesn't exist.
  pub project_ids: Vec<String>,
  /// Whether a project is currently open, which gates the project-scoped actions.
  pub has_project: bool,
  /// Whether the open project is a team app, which has a different set of
  /// controls from a personal one.
  pub team_project: bool,
  /// Where the user is, which decides whether a navigation action is reachable.
  pub surface: Surface,
  /// The open personal project's local backend output; `None` without one.
  pub local_output: Option<LocalOutput>,
}

fn ok(text: impl Into<String>) -> ToolResult {
  ToolResult::Expanded(ToolResultExpanded::new(text.into(), "success"))
}

fn fail(text: impl Into<String>) -> ToolResult {
  let text = text.into();
  ToolResult::Expanded(ToolResultExpanded::new(text.clone(), "failure").with_error(text))
}

fn clip(text: &str, max: usize) -> String {
  let t = text.trim();
  if t.chars().count() <= max {
    return t.to_string();
  }
  let mut s: String = t.chars().take(max.saturating_sub(1)).collect();
  s.push('…');
  s
}

/* ----------------------------- offer an action ----------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionParams {
  id: String,
  label: String,
  #[serde(default)]
  url: Option<String>,
  #[serde(default)]
  target: Option<String>,
}

struct ActionTool(Arc<ToolContext>);

#[async_trait]
impl ToolHandler for ActionTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<ActionParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid action: {e}"))),
    };
    let id = params.id.trim().to_ascii_lowercase();
    if !action_ids().contains(&id.as_str()) {
      return Ok(fail(format!(
        "`{id}` is not an action this app can perform. Choose one of: {}.",
        action_ids().join(", ")
      )));
    }

    let ctx = &self.0;
    // A button that does nothing is worse than no button. Everything below
    // rejects an action the user's current screen cannot actually perform, and
    // says what to offer instead.
    if ctx.surface == Surface::Setup && !SETUP_SAFE.contains(&id.as_str()) {
      return Ok(fail(format!(
        "`{id}` isn't available yet: the user is still on the setup screen, and the rest of the \
app isn't running. Tell them what to do on the setup screen instead, or offer one of: {}.",
        SETUP_SAFE.join(", ")
      )));
    }
    if id == "open-home" && ctx.surface == Surface::Home {
      return Ok(fail(
        "The user is already looking at their list of projects, so `open-home` would do nothing. \
Either offer `open-project` with a specific project's id, or just tell them to pick one."
          .to_string(),
      ));
    }
    if (id == "open-home" || id == "open-project") && ctx.project_ids.is_empty() {
      return Ok(fail(
        "There are no projects on this computer yet, so there is nothing to open. Tell them to \
select New project on the home screen instead."
          .to_string(),
      ));
    }
    if NEEDS_PROJECT.contains(&id.as_str()) && !ctx.has_project {
      return Ok(fail(format!(
        "`{id}` needs a project to be open, and none is. Offer `open-project` or `open-home` first."
      )));
    }
    // A dead button is worse than no button: these controls genuinely don't
    // exist for the other kind of project.
    if ctx.team_project && PERSONAL_ONLY.contains(&id.as_str()) {
      return Ok(fail(format!(
        "`{id}` doesn't exist for a team app. Team apps are published by the team's pipeline, and \
an owner grants access under App access in the workspace overview — offer `open-team-access` and \
explain that only a workspace owner can grant it."
      )));
    }
    if !ctx.team_project && TEAM_ONLY.contains(&id.as_str()) {
      return Ok(fail(format!("`{id}` only applies to a team app, and this is a personal project.")));
    }

    // `open-docs` carries a URL, and only to Fabricator's own docs. The URL is
    // model-authored and ends up in the user's browser, so the host is parsed
    // rather than prefix-matched.
    let url = params.url.as_deref().map(str::trim).filter(|u| !u.is_empty());
    if id == "open-docs" {
      match url {
        Some(u) if super::fabricator_docs_url(u) => {}
        Some(_) => {
          return Ok(fail(
            "open-docs only opens pages on https://spatney.github.io/rayfin-fabricator.".to_string(),
          ))
        }
        None => return Ok(fail("open-docs needs the full https URL of the page.".to_string())),
      }
    }

    // `open-project` carries a project id, which must be one that exists.
    let target = params.target.as_deref().map(str::trim).filter(|t| !t.is_empty());
    if id == "open-project" {
      match target {
        Some(t) if ctx.project_ids.iter().any(|known| known == t) => {}
        Some(t) => {
          return Ok(fail(format!(
            "There is no project with id `{t}`. Use an id from the list you were given, or offer \
`open-home` instead."
          )))
        }
        None => {
          return Ok(fail(
            "open-project needs `target`, the id of the project to open.".to_string(),
          ))
        }
      }
    }

    let action = HelpAction {
      id: id.clone(),
      label: clip(&params.label, 60),
      url: if id == "open-docs" { url.map(str::to_string) } else { None },
      target: if id == "open-project" { target.map(str::to_string) } else { None },
    };
    {
      let mut held = ctx.artifacts.lock().unwrap();
      if held.actions.iter().any(|a| a.id == action.id && a.url == action.url && a.target == action.target) {
        return Ok(ok("Already offered."));
      }
      held.actions.push(action.clone());
    }
    (ctx.emit)(HelpEvent::Action { action });
    Ok(ok(format!("Offered \"{id}\" to the user as a button. Don't repeat the instruction in prose.")))
  }
}

/* ----------------------------- cite a page ----------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CiteParams {
  title: String,
  url: String,
}

struct CiteTool(Arc<ToolContext>);

#[async_trait]
impl ToolHandler for CiteTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<CiteParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid citation: {e}"))),
    };
    let url = params.url.trim();
    if !super::docs_url_allowed(url) && !super::release_notes_url(url) {
      return Ok(fail(format!(
        "Cite only the Fabricator documentation (https://spatney.github.io/rayfin-fabricator), \
Fabricator's release notes ({}), or https://rayfin.ai.",
        crate::services::grounding::RELEASES_URL
      )));
    }
    let citation = HelpCitation { title: clip(&params.title, 80), url: url.to_string() };
    {
      let mut held = self.0.artifacts.lock().unwrap();
      if held.citations.iter().any(|c| c.url == citation.url) {
        return Ok(ok("Already cited."));
      }
      held.citations.push(citation.clone());
    }
    (self.0.emit)(HelpEvent::Citation { citation });
    Ok(ok("Citation shown under your answer."))
  }
}

/* ----------------------------- draft an issue ----------------------------- */

const MAX_ISSUE_TITLE: usize = 120;
const MAX_ISSUE_BODY: usize = 6000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueParams {
  #[serde(default)]
  kind: Option<String>,
  title: String,
  body: String,
}

/// Normalise the model's answer to the one of two things the repository has
/// templates and labels for.
fn issue_kind(raw: Option<&str>) -> String {
  match raw.map(|k| k.trim().to_ascii_lowercase()).as_deref() {
    Some("feature") | Some("enhancement") | Some("request") => "feature".to_string(),
    _ => "bug".to_string(),
  }
}

struct IssueTool(Arc<ToolContext>);

#[async_trait]
impl ToolHandler for IssueTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<IssueParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid issue draft: {e}"))),
    };
    let title = clip(&params.title, MAX_ISSUE_TITLE);
    let body = clip(&params.body, MAX_ISSUE_BODY);
    if title.is_empty() || body.is_empty() {
      return Ok(fail("An issue draft needs both a title and a body.".to_string()));
    }

    // The draft quotes the user's own logs, so mask anything secret-looking
    // before it can reach a public issue.
    let kind = issue_kind(params.kind.as_deref());
    let issue = HelpIssueDraft {
      kind: kind.clone(),
      title: crate::commands::advisor::mask_secrets(&title),
      body: crate::commands::advisor::mask_secrets(&body),
    };
    {
      let mut held = self.0.artifacts.lock().unwrap();
      if held.issue.is_some() {
        return Ok(ok("An issue is already drafted for this answer."));
      }
      held.issue = Some(issue.clone());
    }
    (self.0.emit)(HelpEvent::Issue { issue });
    let what = if kind == "feature" { "feature request" } else { "bug report" };
    Ok(ok(format!(
      "Drafted the {what}. The user sees it with a button to review and submit it, so don't \
repeat the text in your answer — just say it's ready."
    )))
  }
}

/* ----------------------------- read the local backend's output ----------------------------- */

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OutputParams {
  lines: Option<u64>,
  source: Option<String>,
  problems_only: bool,
}

impl OutputParams {
  fn query(self) -> local::OutputQuery {
    local::OutputQuery {
      lines: self.lines.map_or(local::DEFAULT_OUTPUT_LINES, |n| n.clamp(1, local::MAX_OUTPUT_LINES as u64) as usize),
      source: self.source.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()),
      problems_only: self.problems_only,
    }
  }
}

/// The work log's title for a `help_local_output` call.
pub fn local_output_title(args: Option<&Value>) -> String {
  let params = args.and_then(|a| serde_json::from_value::<OutputParams>(a.clone()).ok()).unwrap_or_default();
  let query = params.query();
  let mut title = "Read the local backend's output".to_string();
  if let Some(source) = &query.source {
    title.push_str(&format!(" from {source}"));
  }
  if query.problems_only {
    title.push_str(" (warnings and errors)");
  }
  title
}

struct LocalOutputTool(Arc<ToolContext>);

#[async_trait]
impl ToolHandler for LocalOutputTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<OutputParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid request: {e}"))),
    };
    let ctx = &self.0;
    let Some(read) = ctx.local_output.clone() else {
      return Ok(fail(if ctx.team_project {
        "The open app is a team app, and team apps don't run on a local backend: their preview \
uses a backend the team's pipeline publishes, so there is no local output to read."
      } else {
        "No personal app is open, so there is no local backend output to read. It's there once \
the user opens an app."
      }));
    };
    let query = params.query();
    let fetch = query.fetch();
    let events = tokio::task::spawn_blocking(move || read(fetch)).await.unwrap_or_default();
    Ok(ok(local::format_output(&events, &query)))
  }
}

/// The assistant's reporting tools.
pub fn help_tools(ctx: Arc<ToolContext>) -> Vec<Tool> {
  let action = Tool::new(ACTION_TOOL)
    .with_description(
      "Offer the user a button that performs an action the app can do for them. Call this instead \
of telling them to go and click something, whenever the action is in the list. Call it once per \
action, after you have explained why it helps. Offer at most three per answer, most useful first.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "enum": action_ids(), "description": "Which action to offer." },
        "label": { "type": "string", "description": "Button text, imperative and under 6 words, e.g. \"Refresh Fabric sign-in\" or \"Open Contoso Expenses\"." },
        "url": { "type": "string", "description": "Required for open-docs: the full https URL of the documentation page." },
        "target": { "type": "string", "description": "Required for open-project: the id of the project to open." }
      },
      "required": ["id", "label"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(ActionTool(ctx.clone())));

  let cite = Tool::new(CITE_TOOL)
    .with_description(
      "Cite the documentation page or release notes your answer is based on, so the user can read \
more. Call it once per page, at most three times per answer.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "title": { "type": "string", "description": "The page's title." },
        "url": { "type": "string", "description": "The page's full https URL." }
      },
      "required": ["title", "url"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(CiteTool(ctx.clone())));

  let issue = Tool::new(ISSUE_TOOL)
    .with_description(
      "Write up something for the user to file on GitHub, and say it's ready. Call this when a \
problem looks like a fault in Fabricator rather than something they can fix, when they ask you to \
report something, or when they ask for a feature or improvement that doesn't exist yet. Fill in \
everything you learned so they don't have to remember it. Call it at most once per answer.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "kind": {
          "type": "string",
          "enum": ["bug", "feature"],
          "description":
            "`bug` when something is broken or behaving wrongly. `feature` when the user wants \
something Fabricator doesn't do yet, or wants an existing thing to work differently. Read what \
they actually asked for: \"can you add…\", \"it would be good if…\" and \"I wish it…\" are \
feature requests, not bugs."
        },
        "title": {
          "type": "string",
          "description":
            "One line naming the thing. For a bug, the symptom: \"Publish fails with 'Tenant not \
authorized for cluster'\". For a feature, the capability: \"Let me copy my local data to the \
published app\". Don't prefix it with Bug or Feature — the app does that."
        },
        "body": {
          "type": "string",
          "description":
            "Markdown in the user's voice, as 'I'.\n\nFor a bug, use these headings: '## Summary' \
quoting the exact error and when it started; '## Steps to reproduce' as a numbered list; '## \
Expected behavior'; '## Actual behavior'; and '## What I've already tried' if anything was. Quote \
real values from the logs, but never secrets or tokens. Leave out version and system details — \
the app adds them.\n\nFor a feature, use these headings instead: '## Problem or motivation' \
saying what they are trying to do and why it's hard today; '## Proposed solution'; and '## \
Alternatives considered' if they mentioned any. Don't invent steps to reproduce for a feature."
        }
      },
      "required": ["kind", "title", "body"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(IssueTool(ctx.clone())));

  let output = Tool::new(LOCAL_OUTPUT_TOOL)
    .with_description(
      "Read the open app's recent local backend output: what rayfin-local, the app's dev server \
(Vite), the functions' build and host, and Fabricator printed while running it, oldest first and \
newest last. Read it before explaining why the app didn't start, stopped, or misbehaves in the \
preview, and quote the line that explains it. Tokens and keys are masked. Only for a personal app \
that's open.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "lines": {
          "type": "integer",
          "minimum": 1,
          "maximum": local::MAX_OUTPUT_LINES,
          "description": format!("How many of the newest matching lines to return (default {}).", local::DEFAULT_OUTPUT_LINES)
        },
        "source": {
          "type": "string",
          "enum": OUTPUT_SOURCES,
          "description": "Only lines from this source: `rayfin-local` (the local backend itself, including failed requests), `vite` (the app's dev server), `functions` (the function host and its build), `build` (the data model's build), `fabricator` (Fabricator starting and stopping it), `npm` (installing the app's packages), `stderr` and `stdout` (anything else the local backend printed)."
        },
        "problemsOnly": { "type": "boolean", "description": "Only warnings and errors." }
      }
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(LocalOutputTool(ctx)));

  vec![action, cite, issue, output]
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reporting_tools_are_recognised() {
    assert!(is_reporting_tool(ACTION_TOOL));
    assert!(is_reporting_tool(CITE_TOOL));
    assert!(!is_reporting_tool("read"));
  }

  #[test]
  fn the_catalogue_lists_every_action() {
    let text = action_catalogue();
    for (id, _) in ACTIONS {
      assert!(text.contains(id), "{id} is missing from the catalogue");
    }
  }

  #[test]
  fn action_ids_are_unique() {
    let mut ids = action_ids();
    let before = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), before);
  }

  #[test]
  fn every_project_scoped_action_exists() {
    for id in NEEDS_PROJECT {
      assert!(action_ids().contains(id), "{id} is gated but not offered");
    }
  }

  #[test]
  fn every_setup_safe_action_exists() {
    for id in SETUP_SAFE {
      assert!(action_ids().contains(id), "{id} is allowed in setup but not offered");
    }
  }

  /// The setup screen can only run a handful of these; the rest need a
  /// workbench that isn't running yet. Anything outside the safe list must be
  /// something the setup screen actually ignores.
  #[test]
  fn nothing_outside_the_setup_safe_list_pretends_to_work_during_setup() {
    for id in &["open-home", "open-project", "share-app", "open-advisor", "open-settings"] {
      assert!(!SETUP_SAFE.contains(id), "{id} cannot work before the workbench exists");
    }
  }

  #[test]
  fn a_surface_defaults_to_the_project_view() {
    assert_eq!(Surface::parse(None), Surface::Project);
    assert_eq!(Surface::parse(Some("project")), Surface::Project);
    assert_eq!(Surface::parse(Some("nonsense")), Surface::Project);
    assert_eq!(Surface::parse(Some(" setup ")), Surface::Setup);
    assert_eq!(Surface::parse(Some("home")), Surface::Home);
  }

  #[test]
  fn navigation_actions_are_offered() {
    // The two the user asked for by name: "find me app X" and "share my app".
    assert!(action_ids().contains(&"open-project"));
    assert!(action_ids().contains(&"share-app"));
  }

  #[test]
  fn the_two_project_kinds_do_not_share_their_controls() {
    // Share exists only for a personal project; a team app's access is granted
    // workspace-wide from the overview. Offering either to the wrong kind would
    // be a button that does nothing.
    for id in PERSONAL_ONLY {
      assert!(action_ids().contains(id), "{id} is gated but not offered");
      assert!(!TEAM_ONLY.contains(id), "{id} cannot be both");
    }
    for id in TEAM_ONLY {
      assert!(action_ids().contains(id), "{id} is gated but not offered");
      assert!(NEEDS_PROJECT.contains(id), "{id} needs a project to act on");
    }
  }

  #[test]
  fn an_issue_kind_falls_back_to_bug_but_recognises_a_feature() {
    assert_eq!(issue_kind(Some("feature")), "feature");
    assert_eq!(issue_kind(Some("  Feature  ")), "feature");
    assert_eq!(issue_kind(Some("enhancement")), "feature");
    assert_eq!(issue_kind(Some("bug")), "bug");
    // A report the model mislabels should land as a bug, which is the safer
    // default: it carries the diagnostics a maintainer needs.
    assert_eq!(issue_kind(Some("nonsense")), "bug");
    assert_eq!(issue_kind(None), "bug");
  }

  #[test]
  fn clip_shortens_long_labels() {
    assert_eq!(clip("  Refresh  ", 60), "Refresh");
    assert!(clip(&"x".repeat(100), 10).ends_with('…'));
  }

  fn context(local_output: Option<LocalOutput>, team_project: bool) -> Arc<ToolContext> {
    Arc::new(ToolContext {
      emit: Arc::new(|_| {}),
      artifacts: Arc::new(Mutex::new(TurnArtifacts::default())),
      project_ids: vec!["p".into()],
      has_project: true,
      team_project,
      surface: Surface::Project,
      local_output,
    })
  }

  /// Call `help_local_output` with `arguments`: its result type and text.
  async fn read_output(ctx: Arc<ToolContext>, arguments: Value) -> (String, String) {
    let mut invocation = ToolInvocation::default();
    invocation.tool_name = LOCAL_OUTPUT_TOOL.into();
    invocation.arguments = arguments;
    match LocalOutputTool(ctx).call(invocation).await.unwrap() {
      ToolResult::Expanded(result) => (result.result_type, result.text_result_for_llm),
      ToolResult::Text(text) => ("success".into(), text),
      _ => panic!("an unexpected result"),
    }
  }

  #[tokio::test]
  async fn the_output_tool_reads_what_it_was_asked_for() {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = asked.clone();
    let read: LocalOutput = Arc::new(move |n| {
      seen.lock().unwrap().push(n);
      (0..n.min(5))
        .map(|i| LocalLogEvent {
          source: if i % 2 == 0 { "vite" } else { "functions" }.into(),
          level: "error".into(),
          line: format!("line {i}"),
          time: "2026-10-30T03:12:09Z".into(),
          ..Default::default()
        })
        .collect()
    });
    let (kind, text) = read_output(context(Some(read.clone()), false), json!({ "lines": 3 })).await;
    assert_eq!(kind, "success");
    assert!(text.contains("3 lines"), "{text}");
    let (_, text) = read_output(context(Some(read), false), json!({ "source": "Vite", "problemsOnly": true })).await;
    assert!(text.contains("only warnings and errors from vite"), "{text}");
    assert!(!text.contains("line 1"), "{text}");
    assert_eq!(*asked.lock().unwrap(), [3, local::FILTER_WINDOW], "a filter looks through everything kept");
  }

  #[tokio::test]
  async fn the_output_tool_says_why_there_is_nothing_to_read() {
    let (kind, text) = read_output(context(None, true), json!({})).await;
    assert_eq!(kind, "failure");
    assert!(text.contains("team apps don't run on a local backend"));
    let (_, text) = read_output(context(None, false), json!({})).await;
    assert!(text.contains("No personal app is open"));
  }

  #[test]
  fn the_work_log_names_what_was_read() {
    assert_eq!(local_output_title(None), "Read the local backend's output");
    assert_eq!(
      local_output_title(Some(&json!({ "source": "vite", "problemsOnly": true }))),
      "Read the local backend's output from vite (warnings and errors)"
    );
    assert!(!is_reporting_tool(LOCAL_OUTPUT_TOOL), "reading shows in the work log");
  }
}
