//! Shared GitHub Copilot SDK client + per-(project, thread) session manager.
//!
//! Replaces the one-shot `copilot -p … --output-format json` exec path. A single
//! long-lived [`Client`] spawns the bundled `copilot --server` (JSON-RPC); each
//! project/thread keeps a persistent [`Session`] keyed by its stored
//! `copilot_session_id`. On the first turn of a thread the session is **resumed**
//! from on-disk state (`~/.copilot/session-state/<id>/`) when it exists, else
//! **created** with that id — preserving conversation context across turns *and*
//! across app restarts, exactly like the old `--session-id <uuid>` reuse did.
//!
//! The Copilot CLI itself is shipped by the SDK's default `bundled-cli` feature
//! (embedded at build time, self-extracted on first use), so the app needs no
//! separate global install — only a one-time `copilot login`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use github_copilot_sdk::handler::{ApproveAllHandler, ExitPlanModeHandler, ExitPlanModeResult};
use github_copilot_sdk::rpc::ToolsListRequest;
use github_copilot_sdk::session::Session;
use github_copilot_sdk::{
  Client, ClientOptions, Error as SdkError, ExitPlanModeData, Model, ResumeSessionConfig,
  SessionConfig, SessionId, SetModelOptions, Tool,
};
use once_cell::sync::Lazy;
use regex::Regex;
use tauri::AppHandle;
use tokio::sync::{Mutex, OnceCell};

use crate::services::emit::emit_chat_event;
use crate::services::{exec, paths};
use crate::state::PlanGate;
use crate::types::{AgentToolCatalogGroup, AgentToolCatalogItem, ChatEvent};

/// Application name reported to the CLI as User-Agent context.
const CLIENT_NAME: &str = "rayfin-fabricator";

/// A live session plus the model/effort currently applied to it, so a turn only
/// issues a `set_model` RPC when the user actually changed them.
struct Entry {
  session: Arc<Session>,
  cwd: String,
  model: Option<String>,
  effort: Option<String>,
}

/// Lazily-started shared client and the per-thread session cache. Held in
/// [`crate::state::AppState`] for the app's lifetime; the spawned CLI server is
/// killed when the client drops at shutdown.
#[derive(Default)]
pub struct CopilotManager {
  client: Mutex<Option<Client>>,
  sessions: Mutex<HashMap<String, Entry>>,
}

fn cache_key(project_id: &str) -> String {
  project_id.to_string()
}

/// On-disk session-state directory the CLI persists per session id.
fn session_state_dir(session_id: &str) -> PathBuf {
  paths::home_dir()
    .join(".copilot")
    .join("session-state")
    .join(session_id)
}

/// Whether resumable state already exists for this id (decides resume vs create).
fn session_state_exists(session_id: &str) -> bool {
  session_state_dir(session_id).is_dir()
}

/// Normalize the project model: treat empty / `"auto"` as "no explicit model".
fn concrete_model(model: &Option<String>) -> Option<String> {
  model
    .as_deref()
    .map(str::trim)
    .filter(|m| !m.is_empty() && *m != "auto")
    .map(str::to_string)
}

/// Normalize the effort string: treat empty as unset.
fn norm_effort(effort: &Option<String>) -> Option<String> {
  effort
    .as_deref()
    .map(str::trim)
    .filter(|e| !e.is_empty())
    .map(str::to_string)
}

/// Apply model/effort to a live session via `set_model`. No-op when the model is
/// `auto`/unset (there is no model id to switch to; effort then rides on the
/// value supplied at session open).
async fn apply_options(
  session: &Session,
  model: &Option<String>,
  effort: &Option<String>,
) -> Result<(), SdkError> {
  if let Some(m) = concrete_model(model) {
    let mut opts = SetModelOptions::default();
    if let Some(e) = norm_effort(effort) {
      opts = opts.with_reasoning_effort(e);
    }
    session.set_model(&m, Some(opts)).await?;
  }
  Ok(())
}

/// Bridges the SDK's `exit_plan_mode` callback to the renderer. When the agent
/// (in Plan mode) finishes a plan and calls `exit_plan_mode`, the SDK invokes
/// [`handle`](PlanModeHandler::handle): we emit a `plan-proposed` chat event to
/// the active turn's conversation, then block on a oneshot until the user picks
/// an action (via `chat_resolve_plan`) or the turn ends.
pub struct PlanModeHandler {
  app: AppHandle,
  gate: Arc<PlanGate>,
}

impl PlanModeHandler {
  pub fn new(app: AppHandle, gate: Arc<PlanGate>) -> Self {
    Self { app, gate }
  }
}

#[async_trait]
impl ExitPlanModeHandler for PlanModeHandler {
  async fn handle(&self, session_id: SessionId, data: ExitPlanModeData) -> ExitPlanModeResult {
    // No active turn for this session → approve so the agent isn't left hanging.
    let Some(route) = self.gate.route(session_id.as_str()) else {
      return ExitPlanModeResult::default();
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let rx = self.gate.register_pending(session_id.as_str(), &request_id);
    emit_chat_event(
      &self.app,
      &route.project_id,
      &route.turn_id,
      ChatEvent::PlanProposed {
        request_id,
        summary: data.summary,
        plan_content: data.plan_content.unwrap_or_default(),
        actions: data.actions,
        recommended_action: data.recommended_action,
      },
    );
    // Block the runtime's RPC until the user decides (or the turn ends and the
    // sender is dropped, which we treat as "not approved").
    rx.await.unwrap_or(ExitPlanModeResult {
      approved: false,
      selected_action: None,
      feedback: None,
    })
  }
}

/// Resume (when on-disk state exists) or create a session bound to `session_id`,
/// streaming enabled, auto-approving tool permissions, scoped to `cwd`. When
/// `exit_plan` is supplied it is installed so Plan-mode turns surface their plan
/// for approval (harmless for non-plan turns). `tools` are Fabricator's in-process
/// `fabricator_*` capabilities and `excluded_tools` also filters the SDK's built-in
/// coding tools. The product-scoped skill/instruction directories (materialized
/// under app-data, never in the repo) are always registered so these only ever
/// appear in Fabricator-driven sessions.
async fn open_session(
  client: &Client,
  cwd: &str,
  session_id: &str,
  model: &Option<String>,
  effort: &Option<String>,
  exit_plan: Option<Arc<dyn ExitPlanModeHandler>>,
  tools: Vec<Tool>,
  excluded_tools: Vec<String>,
) -> Result<Session, SdkError> {
  let handler = Arc::new(ApproveAllHandler);
  let sid = SessionId::new(session_id.to_string());
  let cwd_pb = PathBuf::from(cwd);
  let eff = norm_effort(effort);
  let model = concrete_model(model);
  let skills_dir = crate::services::agent_skills::skills_dir();
  let instructions_dir = crate::services::agent_skills::instructions_dir();

  if session_state_exists(session_id) {
    let mut cfg = ResumeSessionConfig::new(sid)
      .with_streaming(true)
      .with_client_name(CLIENT_NAME)
      .with_working_directory(cwd_pb)
      .with_permission_handler(handler)
      .with_enable_skills(true)
      .with_skill_directories([skills_dir])
      .with_instruction_directories([instructions_dir]);
    if !tools.is_empty() {
      cfg = cfg.with_tools(tools);
    }
    if !excluded_tools.is_empty() {
      cfg = cfg.with_excluded_tools(excluded_tools);
    }
    if let Some(h) = exit_plan {
      cfg = cfg.with_exit_plan_mode_handler(h);
    }
    cfg.reasoning_effort = eff;
    let session = client.resume_session(cfg).await?;
    // Resume can't carry a model in its config; switch after attaching.
    apply_options(&session, &model, effort).await?;
    Ok(session)
  } else {
    let mut cfg = SessionConfig::default()
      .with_session_id(sid)
      .with_streaming(true)
      .with_client_name(CLIENT_NAME)
      .with_working_directory(cwd_pb)
      .with_permission_handler(handler)
      .with_enable_skills(true)
      .with_skill_directories([skills_dir])
      .with_instruction_directories([instructions_dir]);
    if !tools.is_empty() {
      cfg = cfg.with_tools(tools);
    }
    if !excluded_tools.is_empty() {
      cfg = cfg.with_excluded_tools(excluded_tools);
    }
    if let Some(h) = exit_plan {
      cfg = cfg.with_exit_plan_mode_handler(h);
    }
    cfg.reasoning_effort = eff;
    if let Some(m) = &model {
      cfg = cfg.with_model(m.clone());
    }
    let session = client.create_session(cfg).await?;
    Ok(session)
  }
}

/// Map an SDK [`Model`] to the renderer DTO, dropping models disabled by org
/// policy. The policy state enum isn't re-exported by the SDK, so we compare its
/// serialized wire string (`"disabled"`) instead of naming the variant.
fn map_model(m: &Model) -> Option<crate::types::CopilotModel> {
  // Copilot returns an `auto` pseudo-model first; the renderer already offers a
  // synthetic "Auto (recommended)" entry, so drop this to avoid a duplicate.
  if m.id.eq_ignore_ascii_case("auto") {
    return None;
  }
  let disabled = m.policy.as_ref().is_some_and(|p| {
    serde_json::to_value(&p.state)
      .ok()
      .and_then(|v| v.as_str().map(|s| s == "disabled"))
      .unwrap_or(false)
  });
  if disabled {
    return None;
  }
  Some(crate::types::CopilotModel {
    id: m.id.clone(),
    name: m.name.clone(),
    supported_reasoning_efforts: m.supported_reasoning_efforts.clone().unwrap_or_default(),
    default_reasoning_effort: m.default_reasoning_effort.clone(),
  })
}

const INTERNAL_BUILTIN_TOOLS: &[&str] =
  &["exit_plan_mode", "task_complete", "send_inbox", "context_board"];

fn builtin_tool_group(name: &str) -> (&'static str, &'static str, &'static str) {
  match name {
    "view" | "grep" | "glob" | "rg" | "code_search" => (
      "workspace-read",
      "Workspace files",
      "Read and search the project's source files.",
    ),
    "edit" | "create" | "apply_patch" | "str_replace_editor" => (
      "workspace-write",
      "Code changes",
      "Create and modify files in the project.",
    ),
    "powershell" | "bash" | "shell" => (
      "terminal",
      "Terminal",
      "Run commands, builds, tests, and development tools.",
    ),
    "web_fetch" | "web_search" => (
      "web",
      "Web",
      "Retrieve external documentation and other web resources.",
    ),
    "task" | "read_agent" | "write_agent" | "list_agents" | "ask_user" | "skill" => (
      "collaboration",
      "Agent collaboration",
      "Use skills, ask questions, and coordinate specialized agents.",
    ),
    _ => (
      "copilot-tools",
      "Other Copilot tools",
      "Additional capabilities provided by the Copilot runtime.",
    ),
  }
}

fn builtin_tool_label(name: &str) -> String {
  let known = match name {
    "view" => Some("Read files"),
    "grep" | "rg" => Some("Search file contents"),
    "glob" => Some("Find files"),
    "code_search" => Some("Search code"),
    "edit" | "str_replace_editor" => Some("Edit files"),
    "create" => Some("Create files"),
    "apply_patch" => Some("Apply code patch"),
    "powershell" => Some("Run PowerShell"),
    "bash" | "shell" => Some("Run shell commands"),
    "web_fetch" => Some("Fetch web page"),
    "web_search" => Some("Search the web"),
    "task" => Some("Run sub-agent"),
    "read_agent" => Some("Read sub-agent"),
    "write_agent" => Some("Message sub-agent"),
    "list_agents" => Some("List sub-agents"),
    "ask_user" => Some("Ask a question"),
    "skill" => Some("Run a skill"),
    _ => None,
  };
  known.map(str::to_string).unwrap_or_else(|| {
    name
      .split(['_', '-'])
      .filter(|part| !part.is_empty())
      .map(|part| {
        let mut chars = part.chars();
        chars
          .next()
          .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
          .unwrap_or_default()
      })
      .collect::<Vec<_>>()
      .join(" ")
  })
}

fn concise_tool_description(name: &str, description: &str) -> String {
  let known = match name {
    "view" => Some("Read a file or a targeted range without loading unnecessary content."),
    "grep" | "rg" => Some("Search project file contents for text or regular-expression matches."),
    "glob" => Some("Find project files by name or path pattern."),
    "edit" | "str_replace_editor" => Some("Make targeted changes to an existing project file."),
    "create" => Some("Create a new file in the project."),
    "apply_patch" => Some("Apply a precise multi-file code patch."),
    "powershell" | "bash" | "shell" => Some("Run a command in the project's terminal environment."),
    "web_fetch" => Some("Load a web page for documentation or research."),
    "web_search" => Some("Search the web for relevant technical information."),
    "task" => Some("Delegate an independent task to a specialized sub-agent."),
    "read_agent" => Some("Read the status and result of a running sub-agent."),
    "write_agent" => Some("Send follow-up instructions to a sub-agent."),
    "list_agents" => Some("List active and completed sub-agents."),
    "ask_user" => Some("Pause and ask you for a decision or missing information."),
    "skill" => Some("Invoke a packaged workflow for a specialized task."),
    _ => None,
  };
  if let Some(known) = known {
    return known.to_string();
  }

  let compact = description.split_whitespace().collect::<Vec<_>>().join(" ");
  let mut chars = compact.chars();
  let preview: String = chars.by_ref().take(180).collect();
  if chars.next().is_some() {
    format!("{preview}...")
  } else if preview.is_empty() {
    "Use this Copilot runtime capability.".into()
  } else {
    preview
  }
}

fn builtin_catalog_item(name: &str, description: &str) -> AgentToolCatalogItem {
  AgentToolCatalogItem {
    id: name.to_string(),
    label: builtin_tool_label(name),
    description: concise_tool_description(name, description),
  }
}

fn group_builtin_tools(
  tools: impl IntoIterator<Item = (String, String)>,
) -> Vec<AgentToolCatalogGroup> {
  let mut groups: Vec<AgentToolCatalogGroup> = Vec::new();
  for (name, description) in tools {
    if INTERNAL_BUILTIN_TOOLS.contains(&name.as_str()) {
      continue;
    }
    let (group_id, group_label, group_description) = builtin_tool_group(&name);
    if let Some(group) = groups.iter_mut().find(|group| group.id == group_id) {
      group.tools.push(builtin_catalog_item(&name, &description));
    } else {
      groups.push(AgentToolCatalogGroup {
        id: group_id.into(),
        label: group_label.into(),
        description: group_description.into(),
        tools: vec![builtin_catalog_item(&name, &description)],
      });
    }
  }
  groups
}

fn fallback_builtin_tool_catalog() -> Vec<AgentToolCatalogGroup> {
  let mut tools = vec![
    ("view", "Read files"),
    ("grep", "Search file contents"),
    ("glob", "Find files"),
    ("edit", "Edit files"),
    ("create", "Create files"),
    ("web_fetch", "Fetch web pages"),
    ("task", "Run a sub-agent"),
    ("read_agent", "Read a sub-agent"),
    ("write_agent", "Message a sub-agent"),
    ("list_agents", "List sub-agents"),
    ("ask_user", "Ask the user"),
    ("skill", "Run a skill"),
  ];
  tools.push(if cfg!(target_os = "windows") {
    ("powershell", "Run PowerShell commands")
  } else {
    ("bash", "Run shell commands")
  });
  group_builtin_tools(
    tools
      .into_iter()
      .map(|(name, description)| (name.to_string(), description.to_string())),
  )
}

impl CopilotManager {
  /// Lazily start (or reuse) the shared CLI server connection.
  async fn ensure_client(&self) -> Result<Client, String> {
    let mut guard = self.client.lock().await;
    if let Some(c) = guard.as_ref() {
      return Ok(c.clone());
    }
    let client = Client::start(ClientOptions::default())
      .await
      .map_err(|e| format!("Failed to start the Copilot engine: {e}"))?;
    *guard = Some(client.clone());
    Ok(client)
  }

  /// Tear down the shared client (e.g. after a transport failure) so the next
  /// call restarts a fresh CLI server.
  async fn reset_client(&self) {
    let taken = self.client.lock().await.take();
    if let Some(c) = taken {
      let _ = c.stop().await;
    }
  }

  /// List the Copilot models available to the signed-in user. The SDK caches the
  /// underlying `models.list` RPC, so repeated calls are cheap. Models disabled
  /// by org policy are dropped; ordering (most-preferred first) is preserved.
  ///
  /// Right after the CLI server starts, auth can momentarily report "not
  /// authenticated" before it resolves; the SDK doesn't cache that failure, so we
  /// give it a couple of brief retries before giving up.
  pub async fn list_models(&self) -> Result<Vec<crate::types::CopilotModel>, String> {
    let client = self.ensure_client().await?;
    let mut last_err = String::new();
    for attempt in 0..3u8 {
      if attempt > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
      }
      match client.list_models().await {
        Ok(models) => return Ok(models.iter().filter_map(map_model).collect()),
        Err(e) => last_err = e.to_string(),
      }
    }
    // Persisting failure: drop the client so a later call restarts a fresh
    // server, and let the renderer fall back to its static model list.
    self.reset_client().await;
    Err(format!("Failed to list Copilot models: {last_err}"))
  }

  /// List the built-in Copilot tools available for the selected model. Keep a
  /// compact fallback so tool management still works while the engine is
  /// starting or temporarily unavailable.
  pub async fn builtin_tool_catalog(&self, model: Option<String>) -> Vec<AgentToolCatalogGroup> {
    let result = async {
      let client = self.ensure_client().await?;
      client
        .rpc()
        .tools()
        .list(ToolsListRequest {
          model: concrete_model(&model),
        })
        .await
        .map_err(|error| error.to_string())
    }
    .await;

    match result {
      Ok(tool_list) => group_builtin_tools(
        tool_list
          .tools
          .into_iter()
          .map(|tool| (tool.name, tool.description)),
      ),
      Err(error) => {
        log::warn!("Could not list Copilot built-in tools: {error}");
        fallback_builtin_tool_catalog()
      }
    }
  }

  /// Get the persistent, cached session for a project turn, creating or
  /// resuming it as needed and reconciling the current model/effort.
  pub async fn turn_session(
    &self,
    project_id: &str,
    cwd: &str,
    session_id: &str,
    model: Option<String>,
    effort: Option<String>,
    exit_plan: Option<Arc<dyn ExitPlanModeHandler>>,
    tools: Vec<Tool>,
    excluded_tools: Vec<String>,
  ) -> Result<Arc<Session>, String> {
    let key = cache_key(project_id);
    let want_model = concrete_model(&model);
    let want_effort = norm_effort(&effort);

    let mut sessions = self.sessions.lock().await;

    // Decide reuse vs reopen without holding a borrow across the await points.
    enum Action {
      Reuse(Arc<Session>),
      ApplyThenReuse(Arc<Session>),
      Reopen,
    }
    let action = match sessions.get(&key) {
      Some(e) if e.cwd == cwd => {
        if concrete_model(&e.model) == want_model && norm_effort(&e.effort) == want_effort {
          Action::Reuse(e.session.clone())
        } else if want_model.is_some() {
          Action::ApplyThenReuse(e.session.clone())
        } else {
          // auto model + changed effort: reopen so the new effort takes hold.
          Action::Reopen
        }
      }
      _ => Action::Reopen,
    };

    match action {
      Action::Reuse(s) => return Ok(s),
      Action::ApplyThenReuse(s) => match apply_options(&s, &model, &effort).await {
        Ok(()) => {
          if let Some(e) = sessions.get_mut(&key) {
            e.model = model;
            e.effort = effort;
          }
          return Ok(s);
        }
        Err(err) => {
          log::warn!("set_model failed ({err}); reopening Copilot session");
        }
      },
      Action::Reopen => {}
    }

    // Reopen path: drop any stale session, then resume/create fresh.
    if let Some(old) = sessions.remove(&key) {
      let _ = old.session.disconnect().await;
    }

    let client = self.ensure_client().await?;
    let session = match open_session(
      &client,
      cwd,
      session_id,
      &model,
      &effort,
      exit_plan.clone(),
      tools.clone(),
      excluded_tools.clone(),
    )
    .await
    {
      Ok(s) => s,
      Err(e) if e.is_transport_failure() => {
        // The CLI server died — restart it and try once more.
        self.reset_client().await;
        let client = self.ensure_client().await?;
        open_session(
          &client,
          cwd,
          session_id,
          &model,
          &effort,
          exit_plan,
          tools,
          excluded_tools,
        )
          .await
          .map_err(|e| e.to_string())?
      }
      Err(e) => return Err(e.to_string()),
    };

    let arc = Arc::new(session);
    sessions.insert(
      key,
      Entry {
        session: arc.clone(),
        cwd: cwd.to_string(),
        model,
        effort,
      },
    );
    Ok(arc)
  }

  /// Open a one-off, uncached session (used by the advisor). The caller is
  /// responsible for [`Session::disconnect`]ing it when done.
  pub async fn transient_session(
    &self,
    cwd: &str,
    model: Option<String>,
    effort: Option<String>,
  ) -> Result<Arc<Session>, String> {
    let client = self.ensure_client().await?;
    let id = uuid::Uuid::new_v4().to_string();
    let session = match open_session(
      &client,
      cwd,
      &id,
      &model,
      &effort,
      None,
      Vec::new(),
      Vec::new(),
    )
    .await
    {
      Ok(s) => s,
      Err(e) if e.is_transport_failure() => {
        self.reset_client().await;
        let client = self.ensure_client().await?;
        open_session(
          &client,
          cwd,
          &id,
          &model,
          &effort,
          None,
          Vec::new(),
          Vec::new(),
        )
          .await
          .map_err(|e| e.to_string())?
      }
      Err(e) => return Err(e.to_string()),
    };
    Ok(Arc::new(session))
  }

  /// Return the cached live session for a project **without** creating,
  /// resuming, or re-applying model/effort. Used by conversation steering, which
  /// must interject into the exact session a turn is already running on.
  pub async fn peek_session(&self, project_id: &str) -> Option<Arc<Session>> {
    let key = cache_key(project_id);
    self.sessions.lock().await.get(&key).map(|e| e.session.clone())
  }

  /// Forget (and disconnect) the cached session for a project. Used by
  /// `chat_reset`, which also clears the stored session id so the next turn
  /// starts a brand-new conversation.
  pub async fn forget(&self, project_id: &str) {
    let key = cache_key(project_id);
    let old = self.sessions.lock().await.remove(&key);
    if let Some(old) = old {
      let _ = old.session.disconnect().await;
    }
  }
}

/// Path to the bundled Copilot CLI binary, extracting it from the embedded
/// archive on first call. `None` only if the platform isn't bundled or
/// extraction failed. Used by the `login` flow and the doctor/version probes so
/// they reach the same binary the SDK runs — without spinning up a [`Client`].
pub fn bundled_cli_path() -> Option<PathBuf> {
  github_copilot_sdk::install_bundled_cli()
}

/// The bundled Copilot CLI's self-reported version (e.g. `"1.0.64-3"`), probed
/// once via `copilot --version` and cached for the process lifetime. `None` when
/// the platform isn't bundled or the probe fails. We ask the binary directly
/// because its reported version can differ from the SDK's release-tag/install dir.
pub async fn bundled_cli_version() -> Option<String> {
  static CACHE: OnceCell<Option<String>> = OnceCell::const_new();
  CACHE
    .get_or_init(|| async {
      let path = bundled_cli_path()?;
      let raw = exec::try_version_path(path, &["--version"]).await?;
      parse_cli_version(&raw)
    })
    .await
    .clone()
}

/// Pull a clean semver-ish token out of `copilot --version` output such as
/// `"GitHub Copilot CLI 1.0.64-3.\nRun 'copilot update'…"`.
fn parse_cli_version(raw: &str) -> Option<String> {
  static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\d+\.\d+\.\d+(?:-[\w.]+)?").unwrap());
  RE.find(raw)
    .map(|m| m.as_str().trim_end_matches('.').to_string())
}

#[cfg(test)]
mod tests {
  use super::{builtin_tool_label, group_builtin_tools, parse_cli_version};

  #[test]
  fn parses_prerelease_and_strips_trailing_period() {
    let raw = "GitHub Copilot CLI 1.0.64-3.\nRun 'copilot update' to check for updates.";
    assert_eq!(parse_cli_version(raw).as_deref(), Some("1.0.64-3"));
  }

  #[test]
  fn parses_plain_semver() {
    assert_eq!(parse_cli_version("copilot version 2.10.0").as_deref(), Some("2.10.0"));
  }

  #[test]
  fn returns_none_when_absent() {
    assert_eq!(parse_cli_version("no version here"), None);
  }

  #[test]
  fn groups_builtin_tools_and_hides_runtime_plumbing() {
    let groups = group_builtin_tools([
      ("view".to_string(), "Read files".to_string()),
      ("powershell".to_string(), "Run commands".to_string()),
      ("exit_plan_mode".to_string(), "Finish planning".to_string()),
    ]);

    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].id, "workspace-read");
    assert_eq!(groups[0].tools[0].label, "Read files");
    assert_eq!(groups[1].id, "terminal");
    assert!(
      groups
        .iter()
        .flat_map(|group| &group.tools)
        .all(|tool| tool.id != "exit_plan_mode")
    );
  }

  #[test]
  fn humanizes_new_runtime_tool_names() {
    assert_eq!(builtin_tool_label("future_tool-name"), "Future Tool Name");
  }
}
