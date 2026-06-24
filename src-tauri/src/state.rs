//! Shared, mutable application state managed by Tauri (`app.manage(...)`).
//!
//! Holds the in-flight chat cancellation handles so a `chat_cancel` command can
//! stop the running Copilot process for a specific project/thread turn, plus the
//! [`PlanGate`] that bridges the SDK's `exit_plan_mode` callback to the renderer's
//! plan-approval UI.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use github_copilot_sdk::handler::ExitPlanModeResult;
use tokio::sync::oneshot;

use crate::services::copilot::CopilotManager;
use crate::services::exec::CancelToken;
use crate::services::history::MAIN_THREAD_ID;

#[derive(Default)]
pub struct AppState {
  /// Active chat cancel tokens, keyed by `"<projectId>::<threadId>"`.
  chat_cancels: Mutex<HashMap<String, CancelToken>>,
  /// Active advisor-run cancel tokens, keyed by `projectId` (one run per project).
  advisor_cancels: Mutex<HashMap<String, CancelToken>>,
  /// Active suggestion-generation cancel tokens, keyed by `projectId` (one per project).
  suggest_cancels: Mutex<HashMap<String, CancelToken>>,
  /// Shared Copilot SDK client + per-thread session cache.
  pub copilot: CopilotManager,
  /// Bridges Plan-mode `exit_plan_mode` requests to the renderer's approval UI.
  pub plan: Arc<PlanGate>,
}

/// Where the active turn for a given Copilot session is streaming, so the
/// `exit_plan_mode` handler can address its plan card to the right conversation.
#[derive(Clone)]
pub struct TurnRoute {
  pub project_id: String,
  pub thread_id: String,
  pub turn_id: String,
}

/// One outstanding plan-approval prompt awaiting the user's decision.
struct PendingPlan {
  request_id: String,
  tx: oneshot::Sender<ExitPlanModeResult>,
}

/// Routes Plan-mode prompts between the SDK callback (running on the client's
/// dispatch task) and the renderer. Both maps are keyed by the Copilot session
/// id; at most one plan prompt is outstanding per session (the agent calls
/// `exit_plan_mode` sequentially).
#[derive(Default)]
pub struct PlanGate {
  routes: Mutex<HashMap<String, TurnRoute>>,
  pending: Mutex<HashMap<String, PendingPlan>>,
}

impl PlanGate {
  /// Record where a session's current turn is streaming (called at turn start).
  pub fn set_route(&self, session_id: &str, route: TurnRoute) {
    self.routes.lock().unwrap().insert(session_id.to_string(), route);
  }

  /// The active turn route for a session, if a turn is in flight.
  pub fn route(&self, session_id: &str) -> Option<TurnRoute> {
    self.routes.lock().unwrap().get(session_id).cloned()
  }

  /// Forget a session's route (called at turn end).
  pub fn clear_route(&self, session_id: &str) {
    self.routes.lock().unwrap().remove(session_id);
  }

  /// Register a pending plan decision and return the receiver the handler awaits.
  /// Any prior outstanding prompt for the session is dropped (its receiver then
  /// resolves to "not approved").
  pub fn register_pending(&self, session_id: &str, request_id: &str) -> oneshot::Receiver<ExitPlanModeResult> {
    let (tx, rx) = oneshot::channel();
    self.pending.lock().unwrap().insert(
      session_id.to_string(),
      PendingPlan { request_id: request_id.to_string(), tx },
    );
    rx
  }

  /// The request id of the plan prompt currently awaiting a decision for this
  /// session, if any. Lets conversation steering treat a message typed while a
  /// plan card is open as plan-revision feedback.
  pub fn pending_request(&self, session_id: &str) -> Option<String> {
    self.pending.lock().unwrap().get(session_id).map(|p| p.request_id.clone())
  }

  /// Resolve a pending plan decision by its request id. Returns `true` when a
  /// matching prompt was found and answered.
  pub fn resolve(&self, request_id: &str, result: ExitPlanModeResult) -> bool {
    let mut map = self.pending.lock().unwrap();
    let key = map
      .iter()
      .find(|(_, p)| p.request_id == request_id)
      .map(|(k, _)| k.clone());
    if let Some(k) = key {
      if let Some(p) = map.remove(&k) {
        return p.tx.send(result).is_ok();
      }
    }
    false
  }

  /// Reject and drop any outstanding plan prompt for a session (turn end cleanup),
  /// so a blocked `exit_plan_mode` handler never leaks.
  pub fn reject_pending(&self, session_id: &str) {
    if let Some(p) = self.pending.lock().unwrap().remove(session_id) {
      let _ = p.tx.send(ExitPlanModeResult {
        approved: false,
        selected_action: None,
        feedback: None,
      });
    }
  }
}

fn key(project_id: &str, thread_id: Option<&str>) -> String {
  format!("{project_id}::{}", thread_id.unwrap_or(MAIN_THREAD_ID))
}

impl AppState {
  /// Register a fresh cancel token for a turn only if none is already running for
  /// this project/thread. Returns `None` when a turn is already in flight.
  pub fn try_begin_chat(&self, project_id: &str, thread_id: Option<&str>) -> Option<CancelToken> {
    let mut map = self.chat_cancels.lock().unwrap();
    let k = key(project_id, thread_id);
    if map.contains_key(&k) {
      return None;
    }
    let token = CancelToken::new();
    map.insert(k, token.clone());
    Some(token)
  }

  /// Remove a turn's cancel token (called when the turn completes).
  pub fn end_chat(&self, project_id: &str, thread_id: Option<&str>) {
    self
      .chat_cancels
      .lock()
      .unwrap()
      .remove(&key(project_id, thread_id));
  }

  /// Cancel an in-flight turn, if one is running. Returns true when a token was
  /// found and signalled.
  pub fn cancel_chat(&self, project_id: &str, thread_id: Option<&str>) -> bool {
    if let Some(token) = self.chat_cancels.lock().unwrap().remove(&key(project_id, thread_id)) {
      token.cancel();
      true
    } else {
      false
    }
  }

  /// Whether a chat turn is currently in flight for this project/thread. Lets
  /// conversation steering decide between interjecting into a live turn and
  /// starting a fresh one.
  pub fn is_chat_running(&self, project_id: &str, thread_id: Option<&str>) -> bool {
    self.chat_cancels.lock().unwrap().contains_key(&key(project_id, thread_id))
  }

  /// Register a fresh advisor-run cancel token for a project only if none is
  /// already running. Returns `None` when a run is already in flight.
  pub fn try_begin_advisor(&self, project_id: &str) -> Option<CancelToken> {
    let mut map = self.advisor_cancels.lock().unwrap();
    if map.contains_key(project_id) {
      return None;
    }
    let token = CancelToken::new();
    map.insert(project_id.to_string(), token.clone());
    Some(token)
  }

  /// Remove an advisor run's cancel token (called when the run completes).
  pub fn end_advisor(&self, project_id: &str) {
    self.advisor_cancels.lock().unwrap().remove(project_id);
  }

  /// Cancel an in-flight advisor run, if one is running. Returns true when a
  /// token was found and signalled.
  pub fn cancel_advisor(&self, project_id: &str) -> bool {
    if let Some(token) = self.advisor_cancels.lock().unwrap().remove(project_id) {
      token.cancel();
      true
    } else {
      false
    }
  }

  /// Register a fresh suggestion-generation cancel token for a project only if
  /// none is already running. Returns `None` when generation is already in flight.
  pub fn try_begin_suggest(&self, project_id: &str) -> Option<CancelToken> {
    let mut map = self.suggest_cancels.lock().unwrap();
    if map.contains_key(project_id) {
      return None;
    }
    let token = CancelToken::new();
    map.insert(project_id.to_string(), token.clone());
    Some(token)
  }

  /// Remove a suggestion run's cancel token (called when generation completes).
  pub fn end_suggest(&self, project_id: &str) {
    self.suggest_cancels.lock().unwrap().remove(project_id);
  }

  /// Cancel an in-flight suggestion generation, if one is running. Returns true
  /// when a token was found and signalled.
  pub fn cancel_suggest(&self, project_id: &str) -> bool {
    if let Some(token) = self.suggest_cancels.lock().unwrap().remove(project_id) {
      token.cancel();
      true
    } else {
      false
    }
  }
}
