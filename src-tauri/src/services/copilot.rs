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
use github_copilot_sdk::handler::{
  ApproveAllHandler, ExitPlanModeHandler, ExitPlanModeResult, UserInputHandler, UserInputResponse,
};
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
use crate::types::ChatEvent;

/// Application name reported to the CLI as User-Agent context.
const CLIENT_NAME: &str = "rayfin-fabricator";

/// The SDK's "auto" router pseudo-model id. Selecting Auto (no explicit project
/// model) resolves to this when we must issue an explicit `set_model` — e.g. to
/// switch a resumed session, which otherwise keeps its last concrete model.
const AUTO_MODEL_ID: &str = "auto";

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
/// bridge answers `ask_user` questions via [`UserInputHandler`], but only for
/// turns that started in Plan mode (`TurnRoute::plan_context`) — an Agent-mode
/// question has no Plan card to attach to, so it's answered with `None`
/// (declining to bridge it) rather than surfacing a misleading Plan-artifact
/// card. When bridged, it emits `plan-question` and blocks until
/// `chat_resolve_question` answers it or the turn ends.
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
    // Agent-mode questions have no Plan card to attach to — surfacing one as
    // `plan-question` would draw a misleading "before drafting" card in the
    // renderer's Plan artifact. Only bridge `ask_user` for turns that started
    // in Plan mode (this stays true through an approved Plan continuation).
    if !route.plan_context {
      return None;
    }
    // The CLI's `allowFreeform` is optional on the wire; default to allowed.
    let allow_freeform = allow_freeform.unwrap_or(true);
    let request_id = uuid::Uuid::new_v4().to_string();
    let rx = self.gate.register_pending_question(session_id.as_str(), &request_id, allow_freeform);
    emit_chat_event(
      &self.app,
      &route.project_id,
      &route.turn_id,
      ChatEvent::PlanQuestion { request_id, question, choices, allow_freeform },
    );
    // Block until the user answers (via `chat_resolve_question`) or the turn
    // ends and the sender is dropped/rejected, which we treat as "no answer".
    rx.await.ok().flatten()
  }
}

/// Resume (when on-disk state exists) or create a session bound to `session_id`,
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
      .with_permission_handler(handler);
    if !tools.is_empty() {
      cfg = cfg
        .with_enable_skills(true)
        .with_skill_directories([skills_dir])
        .with_instruction_directories([instructions_dir])
        .with_tools(tools);
    }
    if let Some(h) = exit_plan {
      cfg = cfg.with_exit_plan_mode_handler(h);
    }
    if let Some(h) = user_input {
      cfg = cfg.with_user_input_handler(h);
    }
    cfg.reasoning_effort = eff;
    let session = client.resume_session(cfg).await?;
    // Resume can't carry a model in its config; reconcile after attaching. A
    // failure here is non-fatal — the session keeps its persisted model rather
    // than breaking the turn.
    if let Err(e) = apply_options(&session, &model, effort).await {
      log::warn!("failed to reconcile model on resumed Copilot session: {e}");
    }
    Ok(session)
  } else {
    let mut cfg = SessionConfig::default()
      .with_session_id(sid)
      .with_streaming(true)
      .with_client_name(CLIENT_NAME)
      .with_working_directory(cwd_pb)
      .with_permission_handler(handler);
    if !tools.is_empty() {
      cfg = cfg
        .with_enable_skills(true)
        .with_skill_directories([skills_dir])
        .with_instruction_directories([instructions_dir])
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
  ) -> Result<Arc<Session>, String> {
    let key = cache_key(project_id);

    let mut sessions = self.sessions.lock().await;

    // Decide reuse vs reopen without holding a borrow across the await points.
    enum Action {
      Reuse(Arc<Session>),
      ApplyThenReuse(Arc<Session>),
      Reopen,
    }
    let action = match sessions.get(&key) {
      Some(e) if e.cwd == cwd => match session_sync(&e.model, &e.effort, &model, &effort) {
        // Model and/or effort changed — apply on the live session. `set_model`
        // now switches back to the "auto" router too, so returning to Auto takes
        // effect (previously it reopened → resumed → kept the old model).
        Sync::Apply => Action::ApplyThenReuse(e.session.clone()),
        Sync::Reuse => Action::Reuse(e.session.clone()),
      },
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
      user_input.clone(),
      tools.clone(),
    )
    .await
    {
      Ok(s) => s,
      Err(e) if e.is_transport_failure() => {
        // The CLI server died — restart it and try once more.
        self.reset_client().await;
        let client = self.ensure_client().await?;
        open_session(&client, cwd, session_id, &model, &effort, exit_plan, user_input, tools)
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
    let session = match open_session(&client, cwd, &id, &model, &effort, None, None, Vec::new()).await {
      Ok(s) => s,
      Err(e) if e.is_transport_failure() => {
        self.reset_client().await;
        let client = self.ensure_client().await?;
        open_session(&client, cwd, &id, &model, &effort, None, None, Vec::new())
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
  use super::{parse_cli_version, session_sync, set_model_target, Sync};

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
