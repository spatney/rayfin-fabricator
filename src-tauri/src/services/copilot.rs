//! Shared GitHub Copilot SDK client + per-(project, thread) session manager.
//!
//! Replaces the one-shot `copilot -p … --output-format json` exec path. A single
//! long-lived [`Client`] spawns the bundled `copilot --server` (JSON-RPC); each
//! project/thread keeps a persistent [`Session`] keyed by its stored
//! `copilot_session_id`. On the first turn of a thread the session is **resumed**
//! by the runtime when available, else **created** with that id — preserving
//! conversation context across turns *and*
//! across app restarts, exactly like the old `--session-id <uuid>` reuse did.
//!
//! The Copilot CLI itself is shipped by the SDK's default `bundled-cli` feature
//! (embedded at build time, self-extracted on first use), so the app needs no
//! separate global install — users sign in through Fabricator.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use github_copilot_sdk::handler::{
  ApproveAllHandler, ExitPlanModeHandler, ExitPlanModeResult, UserInputHandler, UserInputResponse,
};
use github_copilot_sdk::session::Session;
use github_copilot_sdk::types::GetAuthStatusResponse;
use github_copilot_sdk::{
  CliProgram, Client, ClientOptions, Error as SdkError, ExitPlanModeData, Model, ResumeSessionConfig,
  SessionConfig, SessionId, SetModelOptions, Tool, Transport,
};
use once_cell::sync::Lazy;
use regex::Regex;
use tauri::AppHandle;
use tokio::sync::{Mutex, OnceCell};

use crate::services::emit::emit_chat_event;
use crate::services::exec;
use crate::state::PlanGate;
use crate::types::{ChatEvent, CopilotAuthStatus};

/// Application name reported to the CLI as User-Agent context.
const CLIENT_NAME: &str = "rayfin-fabricator";

/// The SDK's "auto" router pseudo-model id. Selecting Auto (no explicit project
/// model) resolves to this when we must issue an explicit `set_model` — e.g. to
/// switch a resumed session, which otherwise keeps its last concrete model.
const AUTO_MODEL_ID: &str = "auto";
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const AUTH_RETRY_DELAY: Duration = Duration::from_millis(600);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

pub const COPILOT_SIGN_IN_REQUIRED: &str =
  "GitHub Copilot is not signed in. Sign in to Copilot in Fabricator, then retry your message.";

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
  engine: Mutex<Engine>,
  signing_in: AtomicBool,
}

#[derive(Default)]
struct Engine {
  client: Option<Client>,
  sessions: HashMap<String, Entry>,
  generation: u64,
  #[cfg(test)]
  mock: bool,
}

pub struct TurnSession {
  pub session: Arc<Session>,
  pub recreated: bool,
}

pub struct CopilotSignInGuard<'a>(&'a AtomicBool);

impl Drop for CopilotSignInGuard<'_> {
  fn drop(&mut self) {
    self.0.store(false, Ordering::SeqCst);
  }
}

pub fn is_session_not_found(error: &str) -> bool {
  static RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\bsession(?:\s+[^\s:]+)?\s+(?:not found|does not exist)\b|\bunknown session\b").unwrap()
  });
  RE.is_match(error)
}

pub fn is_session_auth_missing(error: &str) -> bool {
  error.to_ascii_lowercase().contains("session was not created with authentication info")
}

pub fn is_recoverable_session_error(error: &str) -> bool {
  is_session_not_found(error) || is_session_auth_missing(error)
}

struct StopClientOnDrop(Client);

impl Drop for StopClientOnDrop {
  fn drop(&mut self) {
    self.0.force_stop();
  }
}

/// Normalize the project model: treat empty / `"auto"` as "no explicit model".
fn concrete_model(model: &Option<String>) -> Option<String> {
  model
    .as_deref()
    .map(str::trim)
    .filter(|m| !m.is_empty() && *m != "auto")
    .map(str::to_string)
}

/// The model id to hand `set_model` for a live session: the concrete model, or
/// the SDK's `"auto"` router when the project has no explicit model. Switching a
/// resumed session back to Auto requires this explicit `set_model("auto")` — the
/// session keeps its last concrete model otherwise.
fn set_model_target(model: &Option<String>) -> String {
  concrete_model(model).unwrap_or_else(|| AUTO_MODEL_ID.to_string())
}

/// Whether a cached session can be reused as-is, or needs `set_model` re-applied.
#[derive(Debug, PartialEq, Eq)]
enum Sync {
  Reuse,
  Apply,
}

/// Decide how to reconcile a cached session against the model/effort a turn wants.
/// Any change — crucially including switching *to* Auto — needs [`Sync::Apply`],
/// because a live/resumed session keeps its last concrete model until `set_model`
/// says otherwise (see [`apply_options`]).
fn session_sync(
  cur_model: &Option<String>,
  cur_effort: &Option<String>,
  want_model: &Option<String>,
  want_effort: &Option<String>,
) -> Sync {
  if concrete_model(cur_model) == concrete_model(want_model)
    && norm_effort(cur_effort) == norm_effort(want_effort)
  {
    Sync::Reuse
  } else {
    Sync::Apply
  }
}

/// Normalize the effort string: treat empty as unset.
fn norm_effort(effort: &Option<String>) -> Option<String> {
  effort
    .as_deref()
    .map(str::trim)
    .filter(|e| !e.is_empty())
    .map(str::to_string)
}

/// Apply model/effort to a live session via `set_model`. Always switches — to the
/// concrete model, or back to the `"auto"` router — so returning to Auto after
/// using a named model actually takes effect (a live/resumed session keeps its
/// last model otherwise). The reasoning effort rides along on the switch.
async fn apply_options(
  session: &Session,
  model: &Option<String>,
  effort: &Option<String>,
) -> Result<(), SdkError> {
  let mut opts = SetModelOptions::default();
  if let Some(e) = norm_effort(effort) {
    opts = opts.with_reasoning_effort(e);
  }
  session.set_model(&set_model_target(model), Some(opts)).await
}

/// Bridges the SDK's `exit_plan_mode` and `ask_user` callbacks to the renderer.
/// When the agent (in Plan mode) finishes a plan and calls `exit_plan_mode`, the
/// SDK invokes [`handle`](ExitPlanModeHandler::handle): we emit a `plan-proposed`
/// chat event to the active turn's conversation, then block on a oneshot until
/// the user picks an action (via `chat_resolve_plan`) or the turn ends. The same
/// bridge answers `ask_user` questions via [`UserInputHandler`]. Plan-mode
/// turns (`TurnRoute::plan_context`) surface the question inside their Plan
/// artifact (`plan-question`); Agent-mode turns have no Plan card, so they
/// surface it as a standalone question card (`agent-question`). Either way it
/// emits the event and blocks until `chat_resolve_question` answers it or the
/// turn ends.
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
    let rx = self.gate.register_pending_plan(session_id.as_str(), &request_id);
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

#[async_trait]
impl UserInputHandler for PlanModeHandler {
  async fn handle(
    &self,
    session_id: SessionId,
    question: String,
    choices: Option<Vec<String>>,
    allow_freeform: Option<bool>,
  ) -> Option<UserInputResponse> {
    // No active turn for this session → no answer available.
    let route = self.gate.route(session_id.as_str())?;
    // The CLI's `allowFreeform` is optional on the wire; default to allowed.
    let allow_freeform = allow_freeform.unwrap_or(true);
    let request_id = uuid::Uuid::new_v4().to_string();
    let rx = self.gate.register_pending_question(session_id.as_str(), &request_id, allow_freeform);
    // Plan-mode questions attach to the turn's Plan artifact card; Agent-mode
    // questions have no Plan card, so they surface as a standalone question card
    // (`agent-question`). Both block on the same gate and are answered by
    // `chat_resolve_question` (routed by `request_id`), so declining to bridge an
    // Agent-mode question — which left `ask_user` resolving to "no response" and
    // the agent guessing — is no longer necessary.
    let event = if route.plan_context {
      ChatEvent::PlanQuestion { request_id, question, choices, allow_freeform }
    } else {
      ChatEvent::AgentQuestion { request_id, question, choices, allow_freeform }
    };
    emit_chat_event(&self.app, &route.project_id, &route.turn_id, event);
    // Block until the user answers (via `chat_resolve_question`) or the turn
    // ends and the sender is dropped/rejected, which we treat as "no answer".
    rx.await.ok().flatten()
  }
}

/// Ask the runtime to resume, or create a session bound to `session_id`,
/// streaming enabled, auto-approving tool permissions, scoped to `cwd`. When
/// `exit_plan` is supplied it is installed so Plan-mode turns surface their plan
/// for approval (harmless for non-plan turns); when `user_input` is supplied it
/// answers `ask_user` questions the same way. `tools` are Fabricator's in-process
/// `fabricator_*` capabilities; the product-scoped skill/instruction directories
/// (materialized under app-data, never in the repo) are always registered so these
/// only ever appear in Fabricator-driven sessions.
async fn open_session(
  client: &Client,
  cwd: &str,
  session_id: &str,
  model: &Option<String>,
  effort: &Option<String>,
  exit_plan: Option<Arc<dyn ExitPlanModeHandler>>,
  user_input: Option<Arc<dyn UserInputHandler>>,
  tools: Vec<Tool>,
  resume: bool,
) -> Result<TurnSession, SdkError> {
  let handler = Arc::new(ApproveAllHandler);
  let sid = SessionId::new(session_id.to_string());
  let cwd_pb = PathBuf::from(cwd);
  let eff = norm_effort(effort);
  let model = concrete_model(model);

  let mut recreated = false;
  if resume {
    let mut cfg = ResumeSessionConfig::new(sid.clone())
      .with_streaming(true)
      .with_client_name(CLIENT_NAME)
      .with_working_directory(cwd_pb.clone())
      .with_permission_handler(handler.clone());
    if !tools.is_empty() {
      cfg = cfg
        .with_enable_skills(true)
        .with_skill_directories([crate::services::agent_skills::skills_dir()])
        .with_instruction_directories([crate::services::agent_skills::instructions_dir()])
        .with_tools(tools.clone());
    }
    if let Some(h) = exit_plan.clone() {
      cfg = cfg.with_exit_plan_mode_handler(h);
    }
    if let Some(h) = user_input.clone() {
      cfg = cfg.with_user_input_handler(h);
    }
    cfg.reasoning_effort = eff.clone();
    match client.resume_session(cfg).await {
      Ok(session) => {
        if let Err(e) = apply_options(&session, &model, effort).await {
          if e.is_transport_failure() || is_session_not_found(&e.to_string()) {
            return Err(e);
          }
          log::warn!("failed to reconcile model on resumed Copilot session: {e}");
        }
        return Ok(TurnSession { session: Arc::new(session), recreated: false });
      }
      Err(e) if is_session_not_found(&e.to_string()) => {
        // Directory existence is not authoritative: the CLI may have pruned
        // state, changed its storage layout, or use a custom config directory.
        log::info!("Copilot session {session_id} is unavailable; creating it");
        recreated = true;
      }
      Err(e) => return Err(e),
    }
  }
  let mut cfg = SessionConfig::default()
    .with_session_id(sid)
    .with_streaming(true)
    .with_client_name(CLIENT_NAME)
    .with_working_directory(cwd_pb)
    .with_permission_handler(handler);
  if !tools.is_empty() {
    cfg = cfg
      .with_enable_skills(true)
      .with_skill_directories([crate::services::agent_skills::skills_dir()])
      .with_instruction_directories([crate::services::agent_skills::instructions_dir()])
      .with_tools(tools);
  }
  if let Some(h) = exit_plan {
    cfg = cfg.with_exit_plan_mode_handler(h);
  }
  if let Some(h) = user_input {
    cfg = cfg.with_user_input_handler(h);
  }
  cfg.reasoning_effort = eff;
  if let Some(m) = &model {
    cfg = cfg.with_model(m.clone());
  }
  let session = client.create_session(cfg).await?;
  Ok(TurnSession { session: Arc::new(session), recreated })
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

impl Engine {
  async fn ensure_client(&mut self) -> Result<Client, String> {
    if let Some(c) = self.client.as_ref() {
      return Ok(c.clone());
    }
    #[cfg(test)]
    if self.mock {
      return Err("The mock Copilot engine disconnected; refusing to start the user's CLI.".into());
    }
    let path = bundled_cli_path()
      .ok_or("The bundled Copilot CLI is unavailable. Restart or reinstall Fabricator and try again.")?;
    // Do not let SDK environment overrides select a different runtime from the
    // binary used by sign-in and the version check.
    let options = ClientOptions::default()
      .with_program(CliProgram::Path(path))
      .with_transport(Transport::Stdio);
    let client = Client::start(options)
      .await
      .map_err(|e| format!("Failed to start the Copilot engine: {e}"))?;
    self.client = Some(client.clone());
    Ok(client)
  }

  async fn authenticated_client(&mut self) -> Result<(Client, GetAuthStatusResponse), String> {
    let client = self.ensure_client().await?;
    match client.get_auth_status().await {
      Ok(auth) if auth.is_authenticated => Ok((client, auth)),
      Ok(auth) => {
        let detail = auth.status_message.as_deref().map(str::trim).filter(|s| !s.is_empty());
        Err(match detail {
          Some(detail) => format!("{COPILOT_SIGN_IN_REQUIRED} {detail}"),
          None => COPILOT_SIGN_IN_REQUIRED.to_string(),
        })
      }
      Err(error) => {
        let detail = format!("Could not check GitHub Copilot authentication: {error}");
        if error.is_transport_failure() {
          self.reset_client().await;
        }
        Err(detail)
      }
    }
  }

  /// Tear down the shared client (e.g. after a transport failure) so the next
  /// call restarts a fresh CLI server.
  async fn reset_client(&mut self) {
    self.generation += 1;
    let sessions: Vec<Entry> = self.sessions.drain().map(|(_, entry)| entry).collect();
    if let Some(client) = self.client.take() {
      let client = StopClientOnDrop(client);
      let shutdown = async {
        for entry in sessions {
          if let Err(e) = entry.session.disconnect().await {
            log::warn!("Failed to disconnect a stale Copilot session: {e}");
          }
        }
        if let Err(e) = client.0.stop().await {
          log::warn!("Failed to stop the Copilot engine cleanly: {e}");
        }
      };
      if tokio::time::timeout(STOP_TIMEOUT, shutdown).await.is_err() {
        log::warn!("Timed out stopping the Copilot engine");
      }
    }
  }
}

impl CopilotManager {
  pub fn begin_login(&self) -> Result<CopilotSignInGuard<'_>, String> {
    self.signing_in.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
      .map_err(|_| "Copilot sign-in is already in progress.".to_string())?;
    Ok(CopilotSignInGuard(&self.signing_in))
  }

  fn check_available(&self) -> Result<(), String> {
    if self.signing_in.load(Ordering::SeqCst) {
      return Err("Copilot sign-in is in progress. Finish signing in, then retry your message.".into());
    }
    Ok(())
  }

  async fn wait_for_auth(engine: &mut Engine) -> Result<Client, String> {
    let wait = async {
      let mut last_error = COPILOT_SIGN_IN_REQUIRED.to_string();
      for attempt in 0..3 {
        if attempt > 0 {
          tokio::time::sleep(AUTH_RETRY_DELAY).await;
        }
        match engine.authenticated_client().await {
          Ok((client, _)) => return Ok(client),
          Err(error) => last_error = error,
        }
      }
      Err(last_error)
    };
    tokio::time::timeout(AUTH_TIMEOUT, wait).await
      .map_err(|_| "Checking GitHub Copilot authentication timed out. Re-check or sign in again.".to_string())?
  }

  /// Verify credentials in the same runtime that serves chat, without sending a
  /// prompt. A remembered account (or a cached model list) is not proof of access.
  pub async fn auth_status(&self) -> CopilotAuthStatus {
    self.check_auth(AUTH_TIMEOUT, AUTH_RETRY_DELAY).await
  }

  async fn check_auth(&self, timeout: Duration, retry_delay: Duration) -> CopilotAuthStatus {
    let probe = async {
      let mut last = Err(COPILOT_SIGN_IN_REQUIRED.to_string());
      for attempt in 0..3 {
        if attempt > 0 {
          tokio::time::sleep(retry_delay).await;
        }
        last = self.probe_auth().await;
        if last.is_ok() {
          break;
        }
      }
      last
    };
    let result = match tokio::time::timeout(timeout, probe).await {
      Ok(result) => result,
      Err(_) => Err(
        "Checking GitHub Copilot authentication timed out. Check your connection and use Re-check, or try signing in again."
          .to_string(),
      ),
    };
    match result {
      Ok(status) => status,
      Err(error) => {
        log::warn!("Copilot authentication check failed: {error}");
        CopilotAuthStatus { signed_in: false, user: None, error: Some(error) }
      }
    }
  }

  /// Discard the old runtime's credentials and live session handles after login.
  /// Detach rather than destroy sessions so their persisted conversations resume.
  pub async fn reload_auth(&self) {
    self.engine.lock().await.reset_client().await;
  }

  /// List the Copilot models available to the signed-in user. The SDK caches the
  /// underlying `models.list` RPC, so repeated calls are cheap. Models disabled
  /// by org policy are dropped; ordering (most-preferred first) is preserved.
  ///
  /// Right after the CLI server starts, auth can momentarily report "not
  /// authenticated" before it resolves; the SDK doesn't cache that failure, so we
  /// give it a couple of brief retries before giving up.
  pub async fn list_models(&self) -> Result<Vec<crate::types::CopilotModel>, String> {
    let (client, generation) = {
      let mut engine = self.engine.lock().await;
      self.check_available()?;
      (engine.ensure_client().await?, engine.generation)
    };
    let mut last_err = String::new();
    let mut transport_failed = false;
    for attempt in 0..3u8 {
      if attempt > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
      }
      match client.list_models().await {
        Ok(models) => return Ok(models.iter().filter_map(map_model).collect()),
        Err(e) => {
          transport_failed = e.is_transport_failure();
          last_err = e.to_string();
        }
      }
    }
    // An auth/network/model error must not kill healthy, in-flight sessions.
    // Only reset the failed transport, and never a newer engine from sign-in.
    if transport_failed {
      let mut engine = self.engine.lock().await;
      if engine.generation == generation {
        engine.reset_client().await;
      }
    }
    Err(format!("Failed to list Copilot models: {last_err}"))
  }

  async fn probe_auth(&self) -> Result<CopilotAuthStatus, String> {
    let (client, auth) = {
      let mut engine = self.engine.lock().await;
      self.check_available()?;
      engine.authenticated_client().await?
    };
    // Unlike Client::list_models, this issues a fresh RPC on every check, so a
    // previously successful model lookup cannot mask revoked/expired credentials.
    client.rpc().models().list().await.map_err(|e| {
      format!(
        "Could not verify GitHub Copilot access: {e}. Check your connection and Copilot access, then re-check or sign in again."
      )
    })?;
    Ok(CopilotAuthStatus { signed_in: true, user: auth.login, error: None })
  }

  /// Get the persistent, cached session for a project turn, creating or
  /// resuming it as needed and reconciling the current model/effort.
  #[allow(clippy::too_many_arguments)]
  pub async fn turn_session(
    &self,
    project_id: &str,
    cwd: &str,
    session_id: &str,
    model: Option<String>,
    effort: Option<String>,
    exit_plan: Option<Arc<dyn ExitPlanModeHandler>>,
    user_input: Option<Arc<dyn UserInputHandler>>,
    tools: Vec<Tool>,
  ) -> Result<TurnSession, String> {
    let key = project_id.to_string();
    let mut engine = self.engine.lock().await;
    self.check_available()?;
    let client = Self::wait_for_auth(&mut engine).await?;

    // Decide reuse vs reopen without holding a borrow across the await points.
    enum Action {
      Reuse(Arc<Session>),
      ApplyThenReuse(Arc<Session>),
      Reopen,
    }
    let action = match engine.sessions.get(&key) {
      Some(e) if e.cwd == cwd && e.session.id().as_str() == session_id => match session_sync(&e.model, &e.effort, &model, &effort) {
        // Model and/or effort changed — apply on the live session. `set_model`
        // now switches back to the "auto" router too, so returning to Auto takes
        // effect (previously it reopened → resumed → kept the old model).
        Sync::Apply => Action::ApplyThenReuse(e.session.clone()),
        Sync::Reuse => Action::Reuse(e.session.clone()),
      },
      _ => Action::Reopen,
    };

    match action {
      Action::Reuse(session) => return Ok(TurnSession { session, recreated: false }),
      Action::ApplyThenReuse(s) => match apply_options(&s, &model, &effort).await {
        Ok(()) => {
          if let Some(e) = engine.sessions.get_mut(&key) {
            e.model = model;
            e.effort = effort;
          }
          return Ok(TurnSession { session: s, recreated: false });
        }
        Err(err) => {
          log::warn!("set_model failed ({err}); reopening Copilot session");
        }
      },
      Action::Reopen => {}
    }

    // Reopen path: drop any stale session, then resume/create fresh.
    if let Some(old) = engine.sessions.remove(&key) {
      disconnect_session(&old.session).await;
    }

    let opened = match open_session(
      &client,
      cwd,
      session_id,
      &model,
      &effort,
      exit_plan.clone(),
      user_input.clone(),
      tools.clone(),
      true,
    )
    .await
    {
      Ok(s) => s,
      Err(e) if e.is_transport_failure() => {
        // The CLI server died — restart it and try once more.
        engine.reset_client().await;
        let client = Self::wait_for_auth(&mut engine).await?;
        open_session(&client, cwd, session_id, &model, &effort, exit_plan, user_input, tools, true)
          .await
          .map_err(|e| e.to_string())?
      }
      Err(e) => return Err(e.to_string()),
    };

    engine.sessions.insert(
      key,
      Entry {
        session: opened.session.clone(),
        cwd: cwd.to_string(),
        model,
        effort,
      },
    );
    Ok(opened)
  }

  /// Open a one-off, uncached session (used by the advisor). The caller is
  /// responsible for [`Session::disconnect`]ing it when done.
  pub async fn transient_session(
    &self,
    cwd: &str,
    model: Option<String>,
    effort: Option<String>,
  ) -> Result<Arc<Session>, String> {
    let mut engine = self.engine.lock().await;
    self.check_available()?;
    let client = Self::wait_for_auth(&mut engine).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let opened = match open_session(&client, cwd, &id, &model, &effort, None, None, Vec::new(), false).await {
      Ok(s) => s,
      Err(e) if e.is_transport_failure() => {
        engine.reset_client().await;
        let client = Self::wait_for_auth(&mut engine).await?;
        open_session(&client, cwd, &id, &model, &effort, None, None, Vec::new(), false)
          .await
          .map_err(|e| e.to_string())?
      }
      Err(e) => return Err(e.to_string()),
    };
    Ok(opened.session)
  }

  /// Return the cached live session for a project **without** creating,
  /// resuming, or re-applying model/effort. Used by conversation steering, which
  /// must interject into the exact session a turn is already running on.
  pub async fn peek_session(&self, project_id: &str) -> Option<Arc<Session>> {
    self.engine.lock().await.sessions.get(project_id).map(|e| e.session.clone())
  }

  /// Forget (and disconnect) the cached session for a project. Used by
  /// `chat_reset`, which also clears the stored session id so the next turn
  /// starts a brand-new conversation.
  pub async fn forget(&self, project_id: &str) {
    let mut engine = self.engine.lock().await;
    let old = engine.sessions.remove(project_id);
    if let Some(old) = old {
      disconnect_session(&old.session).await;
    }
  }

  pub async fn invalidate_transport(&self, project_id: &str, session: &Arc<Session>) {
    let mut engine = self.engine.lock().await;
    if engine.sessions.get(project_id).is_some_and(|entry| Arc::ptr_eq(&entry.session, session)) {
      engine.reset_client().await;
    }
  }
}

async fn disconnect_session(session: &Session) {
  match tokio::time::timeout(STOP_TIMEOUT, session.disconnect()).await {
    Ok(Ok(())) => {}
    Ok(Err(e)) => log::warn!("Failed to disconnect Copilot session: {e}"),
    Err(_) => log::warn!("Timed out disconnecting Copilot session"),
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

/// The SDK's *pinned* bundled CLI version, read from the install directory name
/// (`.../github-copilot-sdk/cli/<version>/copilot[.exe]`). This is what the SDK
/// baked in at build time — the floor the CLI self-updates from — so it can lag
/// the running binary's self-reported `--version` (see [`bundled_cli_version`]).
/// `None` when the platform isn't bundled or the path carries no version.
pub fn bundled_cli_pinned_version() -> Option<String> {
  let path = bundled_cli_path()?;
  let name = path.parent()?.file_name()?.to_string_lossy().to_string();
  (!name.is_empty() && name != "unversioned").then_some(name)
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
  use super::*;
  use serde_json::{json, Value};
  use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

  fn fake_client(steps: Vec<(&'static str, Value)>) -> (Client, tokio::task::JoinHandle<Vec<Value>>) {
    let (client_stream, server_stream) = tokio::io::duplex(65536);
    let (reader, writer) = tokio::io::split(client_stream);
    let client = Client::from_streams(reader, writer, PathBuf::from(".")).unwrap();
    let server = tokio::spawn(async move {
      let (reader, mut writer) = tokio::io::split(server_stream);
      let mut reader = BufReader::new(reader);
      let mut requests = Vec::new();
      for (method, payload) in steps {
        let mut length = None;
        loop {
          let mut line = String::new();
          assert!(reader.read_line(&mut line).await.unwrap() > 0, "missing {method}");
          if line.trim().is_empty() {
            break;
          }
          if let Some(value) = line.strip_prefix("Content-Length:") {
            length = Some(value.trim().parse::<usize>().unwrap());
          }
        }
        let mut body = vec![0; length.expect("frame length")];
        reader.read_exact(&mut body).await.unwrap();
        let request: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(request["method"], method);
        let mut reply = json!({ "jsonrpc": "2.0", "id": request["id"] });
        reply.as_object_mut().unwrap().extend(payload.as_object().unwrap().clone());
        let body = serde_json::to_vec(&reply).unwrap();
        writer.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes()).await.unwrap();
        writer.write_all(&body).await.unwrap();
        writer.flush().await.unwrap();
        requests.push(request);
      }
      requests
    });
    (client, server)
  }

  fn manager_with(client: Client) -> CopilotManager {
    CopilotManager {
      engine: Mutex::new(Engine { client: Some(client), mock: true, ..Default::default() }),
      ..Default::default()
    }
  }

  fn rpc_error(message: &str) -> Value {
    json!({ "error": { "code": -32000, "message": message } })
  }

  #[tokio::test]
  async fn remembered_account_without_runtime_credentials_is_not_signed_in() {
    let (client, server) = fake_client(vec![
      ("auth.getStatus", json!({ "result": { "isAuthenticated": false, "login": "remembered-user" } })),
      ("auth.getStatus", json!({ "result": { "isAuthenticated": false, "login": "remembered-user" } })),
      ("auth.getStatus", json!({ "result": { "isAuthenticated": false, "login": "remembered-user" } })),
    ]);
    let manager = manager_with(client);
    let status = manager.check_auth(Duration::from_secs(2), Duration::ZERO).await;
    assert!(!status.signed_in);
    assert!(status.user.is_none());
    assert!(status.error.unwrap().contains("Sign in to Copilot in Fabricator"));
    server.await.unwrap();
  }

  #[tokio::test]
  async fn token_auth_does_not_require_a_remembered_username() {
    let (client, server) = fake_client(vec![
      ("auth.getStatus", json!({ "result": { "isAuthenticated": true, "authType": "env" } })),
      ("models.list", json!({ "result": { "models": [] } })),
    ]);
    let status = manager_with(client).check_auth(Duration::from_secs(2), Duration::ZERO).await;
    assert!(status.signed_in);
    assert!(status.error.is_none());
    server.await.unwrap();
  }

  #[tokio::test]
  async fn auth_waits_for_runtime_initialization() {
    let (client, server) = fake_client(vec![
      ("auth.getStatus", json!({ "result": { "isAuthenticated": false } })),
      ("auth.getStatus", json!({ "result": { "isAuthenticated": true, "login": "current-user" } })),
      ("models.list", json!({ "result": { "models": [] } })),
    ]);
    let status = manager_with(client).check_auth(Duration::from_secs(2), Duration::ZERO).await;
    assert!(status.signed_in);
    assert_eq!(status.user.as_deref(), Some("current-user"));
    server.await.unwrap();
  }

  #[tokio::test]
  async fn cached_models_cannot_mask_revoked_credentials() {
    let mut steps = vec![("models.list", json!({ "result": { "models": [] } }))];
    for _ in 0..3 {
      steps.push(("auth.getStatus", json!({ "result": { "isAuthenticated": true, "login": "stale-user" } })));
      steps.push(("models.list", rpc_error("401: token expired")));
    }
    let (client, server) = fake_client(steps);
    client.list_models().await.unwrap();
    let status = manager_with(client).check_auth(Duration::from_secs(2), Duration::ZERO).await;
    assert!(!status.signed_in);
    assert!(status.error.unwrap().contains("token expired"));
    server.await.unwrap();
  }

  #[tokio::test]
  async fn an_unresponsive_auth_probe_fails_closed_with_a_reason() {
    let (client_stream, _unresponsive_server) = tokio::io::duplex(65536);
    let (reader, writer) = tokio::io::split(client_stream);
    let client = Client::from_streams(reader, writer, PathBuf::from(".")).unwrap();
    let manager = manager_with(client.clone());
    let status = manager.check_auth(Duration::from_millis(20), Duration::ZERO).await;
    assert!(!status.signed_in);
    assert!(status.error.unwrap().contains("timed out"));
    client.force_stop();
  }

  #[tokio::test]
  async fn resetting_credentials_evicts_all_session_handles_without_deleting_history() {
    let (client, server) = fake_client(vec![
      ("session.create", json!({ "result": { "sessionId": "saved-session" } })),
      ("session.destroy", json!({ "result": {} })),
    ]);
    let session = client.create_session(
      SessionConfig::default().with_session_id(SessionId::new("saved-session")),
    ).await.unwrap();
    let manager = manager_with(client);
    manager.engine.lock().await.sessions.insert("project".into(), Entry {
      session: Arc::new(session), cwd: ".".into(), model: None, effort: None,
    });
    manager.reload_auth().await;
    let engine = manager.engine.lock().await;
    assert!(engine.client.is_none());
    assert!(engine.sessions.is_empty());
    assert_eq!(engine.generation, 1);
    let requests = server.await.unwrap();
    assert_eq!(requests[1]["params"]["sessionId"], "saved-session");
    assert!(requests.iter().all(|r| r["method"] != "session.delete"));
  }

  #[tokio::test]
  async fn missing_persisted_session_is_recreated_with_the_same_id() {
    let (client, server) = fake_client(vec![
      ("session.resume", rpc_error("Session not found saved-session")),
      ("session.create", json!({ "result": { "sessionId": "saved-session" } })),
    ]);
    let opened = open_session(
      &client, ".", "saved-session", &None, &None, None, None, Vec::new(), true,
    ).await.unwrap();
    assert!(opened.recreated);
    assert_eq!(opened.session.id().as_str(), "saved-session");
    let requests = server.await.unwrap();
    assert_eq!(requests[1]["params"]["sessionId"], "saved-session");
    client.force_stop();
  }

  #[tokio::test]
  async fn a_model_auth_error_does_not_discard_healthy_chat_sessions() {
    let (client, server) = fake_client(vec![
      ("session.create", json!({ "result": { "sessionId": "healthy-session" } })),
      ("models.list", rpc_error("Not authenticated")),
      ("models.list", rpc_error("Not authenticated")),
      ("models.list", rpc_error("Not authenticated")),
    ]);
    let session = client.create_session(
      SessionConfig::default().with_session_id(SessionId::new("healthy-session")),
    ).await.unwrap();
    let manager = manager_with(client.clone());
    manager.engine.lock().await.sessions.insert("project".into(), Entry {
      session: Arc::new(session), cwd: ".".into(), model: None, effort: None,
    });
    assert!(manager.list_models().await.is_err());
    let engine = manager.engine.lock().await;
    assert!(engine.client.is_some());
    assert!(engine.sessions.contains_key("project"));
    assert_eq!(engine.generation, 0);
    server.await.unwrap();
    client.force_stop();
  }

  #[tokio::test]
  async fn transport_invalidation_clears_current_handles_but_ignores_stale_ones() {
    let (client, server) = fake_client(vec![
      ("session.create", json!({ "result": { "sessionId": "current-session" } })),
      ("session.create", json!({ "result": { "sessionId": "stale-session" } })),
      ("session.destroy", json!({ "result": {} })),
      ("session.destroy", json!({ "result": {} })),
    ]);
    let current = Arc::new(client.create_session(
      SessionConfig::default().with_session_id(SessionId::new("current-session")),
    ).await.unwrap());
    let stale = Arc::new(client.create_session(
      SessionConfig::default().with_session_id(SessionId::new("stale-session")),
    ).await.unwrap());
    let manager = manager_with(client);
    manager.engine.lock().await.sessions.insert("project".into(), Entry {
      session: current.clone(), cwd: ".".into(), model: None, effort: None,
    });
    manager.invalidate_transport("project", &stale).await;
    assert!(manager.engine.lock().await.client.is_some());
    manager.invalidate_transport("project", &current).await;
    let engine = manager.engine.lock().await;
    assert!(engine.client.is_none());
    assert!(engine.sessions.is_empty());
    assert_eq!(engine.generation, 1);
    server.await.unwrap();
  }

  #[tokio::test]
  async fn resume_auth_failure_does_not_create_a_replacement_session() {
    let (client, server) = fake_client(vec![
      ("session.resume", rpc_error("Not authenticated")),
    ]);
    let result = open_session(
      &client, ".", "saved-session", &None, &None, None, None, Vec::new(), true,
    ).await;
    assert!(result.is_err());
    assert_eq!(server.await.unwrap().len(), 1);
    client.force_stop();
  }

  #[tokio::test]
  async fn cached_session_must_match_the_current_session_id() {
    let (client, server) = fake_client(vec![
      ("session.create", json!({ "result": { "sessionId": "old-session" } })),
      ("auth.getStatus", json!({ "result": { "isAuthenticated": true } })),
      ("session.destroy", json!({ "result": {} })),
      ("session.resume", json!({ "result": { "sessionId": "new-session" } })),
      ("session.skills.reload", json!({ "result": {} })),
      ("session.model.switchTo", json!({ "result": {} })),
    ]);
    let old = client.create_session(
      SessionConfig::default().with_session_id(SessionId::new("old-session")),
    ).await.unwrap();
    let manager = manager_with(client.clone());
    manager.engine.lock().await.sessions.insert("project".into(), Entry {
      session: Arc::new(old), cwd: ".".into(), model: None, effort: None,
    });
    let opened = manager.turn_session(
      "project", ".", "new-session", None, None, None, None, Vec::new(),
    ).await.unwrap();
    assert_eq!(opened.session.id().as_str(), "new-session");
    assert!(!opened.recreated);
    server.await.unwrap();
    client.force_stop();
  }

  #[test]
  fn only_explicit_missing_session_errors_allow_recreation() {
    for error in ["Session not found abc", "session not found: abc", "Session abc does not exist", "Unknown session abc"] {
      assert!(is_session_not_found(error), "{error}");
    }
    for error in ["File not found", "Not authenticated", "Connection closed", "Permission denied", "Session timed out"] {
      assert!(!is_session_not_found(error), "{error}");
    }
  }

  #[tokio::test]
  async fn sessions_cannot_be_created_before_runtime_auth_is_ready() {
    let (client, server) = fake_client(vec![
      ("auth.getStatus", json!({ "result": { "isAuthenticated": false } })),
      ("auth.getStatus", json!({ "result": { "isAuthenticated": false } })),
      ("auth.getStatus", json!({ "result": { "isAuthenticated": false } })),
    ]);
    let manager = manager_with(client);
    let result = manager.turn_session(
      "project", ".", "unauthenticated-session", None, None, None, None, Vec::new(),
    ).await;
    assert!(result.err().unwrap().contains("Sign in to Copilot"));
    assert!(manager.engine.lock().await.sessions.is_empty());
    assert_eq!(server.await.unwrap().len(), 3);
  }

  #[test]
  fn missing_session_auth_info_is_recoverable_but_general_auth_errors_are_not_replayed() {
    assert!(is_recoverable_session_error(
      "Execution failed: Error: Session was not created with authentication info or custom provider"
    ));
    assert!(!is_recoverable_session_error("Not authenticated"));
    assert!(!is_recoverable_session_error("401 Unauthorized"));
  }

  #[test]
  fn login_excludes_new_engine_work_until_the_guard_is_dropped() {
    let manager = CopilotManager::default();
    let guard = manager.begin_login().unwrap();
    assert!(manager.begin_login().is_err());
    assert!(manager.check_available().is_err());
    drop(guard);
    assert!(manager.check_available().is_ok());
  }

  /// Shorthand for an `Option<String>` from a string literal.
  fn m(v: &str) -> Option<String> {
    Some(v.to_string())
  }

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
  fn set_model_target_falls_back_to_auto() {
    // No explicit model (or the pseudo "auto"/blank) → the SDK's "auto" router.
    assert_eq!(set_model_target(&None), "auto");
    assert_eq!(set_model_target(&m("")), "auto");
    assert_eq!(set_model_target(&m("   ")), "auto");
    assert_eq!(set_model_target(&m("auto")), "auto");
    // A concrete model passes through verbatim.
    assert_eq!(set_model_target(&m("gpt-5.4-mini")), "gpt-5.4-mini");
  }

  #[test]
  fn switching_to_auto_from_a_named_model_re_applies() {
    // The bug: a session on a concrete model, switched back to Auto, must
    // re-apply (set_model "auto") — not silently reuse the old model.
    assert_eq!(session_sync(&m("gpt-5.4-mini"), &None, &None, &None), Sync::Apply);
    assert_eq!(session_sync(&m("gpt-5.4-mini"), &None, &m("auto"), &None), Sync::Apply);
  }

  #[test]
  fn unchanged_model_and_effort_reuses() {
    assert_eq!(session_sync(&None, &None, &None, &None), Sync::Reuse);
    assert_eq!(session_sync(&m("x"), &m("high"), &m("x"), &m("high")), Sync::Reuse);
    // None and "auto" (and blank) are equivalent, so auto→auto reuses.
    assert_eq!(session_sync(&None, &None, &m("auto"), &None), Sync::Reuse);
    assert_eq!(session_sync(&m("auto"), &None, &None, &None), Sync::Reuse);
  }

  #[test]
  fn model_or_effort_change_applies() {
    assert_eq!(session_sync(&m("a"), &None, &m("b"), &None), Sync::Apply);
    assert_eq!(session_sync(&None, &m("low"), &None, &m("high")), Sync::Apply);
    // Auto → a concrete model also needs applying.
    assert_eq!(session_sync(&None, &None, &m("gpt"), &None), Sync::Apply);
  }
}
