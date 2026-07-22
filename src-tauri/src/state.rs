//! Shared, mutable application state managed by Tauri (`app.manage(...)`).
//!
//! Holds the in-flight chat cancellation handles so a `chat_cancel` command can
//! stop the running Copilot process for a specific project/thread turn, plus the
//! [`PlanGate`] that bridges the SDK's `exit_plan_mode` and `ask_user` callbacks
//! to the renderer's plan-approval and structured-question UI.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use github_copilot_sdk::handler::{ExitPlanModeResult, UserInputResponse};
use tokio::sync::oneshot;

use crate::services::copilot::CopilotManager;
use crate::services::exec::CancelToken;

#[derive(Default)]
pub struct AppState {
  /// Active chat cancel tokens, keyed by `projectId` (one turn per project).
  chat_cancels: Mutex<HashMap<String, CancelToken>>,
  /// Active advisor-run cancel tokens, keyed by `projectId` (one run per project).
  advisor_cancels: Mutex<HashMap<String, CancelToken>>,
  /// Active suggestion-generation cancel tokens, keyed by `projectId` (one per project).
  suggest_cancels: Mutex<HashMap<String, CancelToken>>,
  /// Active inline-explain cancel tokens, keyed by `projectId` (one explain per project).
  explain_cancels: Mutex<HashMap<String, CancelToken>>,
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
  pub turn_id: String,
  /// Whether this turn was started in Plan mode. Determines how an `ask_user`
  /// question is surfaced: Plan-mode turns route it into the Plan artifact
  /// (`plan-question`), Agent-mode turns surface it as a standalone question
  /// card (`agent-question`). Stays fixed for the lifetime of this route,
  /// including through an approved Plan continuation (e.g. into Autopilot),
  /// since the route isn't replaced until the turn ends.
  pub plan_context: bool,
}

/// One outstanding plan-approval prompt awaiting the user's decision.
struct PendingPlan {
  request_id: String,
  tx: oneshot::Sender<ExitPlanModeResult>,
}

/// One outstanding structured question (the `ask_user` tool, via
/// `UserInputHandler`) awaiting the user's answer.
struct PendingQuestion {
  request_id: String,
  /// Whether the CLI will accept a free-form (not preset-choice) answer.
  allow_freeform: bool,
  tx: oneshot::Sender<Option<UserInputResponse>>,
}

/// Which project a still-pending plan prompt belongs to, returned by
/// [`PlanGate::plan_owner`] so `chat_resolve_plan` can validate that a call
/// targets the project the prompt was actually raised for.
#[derive(Clone)]
pub struct PlanOwner {
  pub project_id: String,
}

/// Which project/turn a still-pending question belongs to, plus whether it
/// accepts a free-form answer, returned by [`PlanGate::question_owner`] so
/// `chat_resolve_question` can validate ownership and free-form eligibility.
#[derive(Clone)]
pub struct QuestionOwner {
  pub project_id: String,
  pub turn_id: String,
  pub allow_freeform: bool,
}

/// Routes Plan-mode prompts between the SDK callbacks (running on the client's
/// dispatch task) and the renderer. All maps are keyed by the Copilot session
/// id; at most one plan prompt and one question prompt are outstanding per
/// session at a time (the agent awaits each sequentially).
#[derive(Default)]
pub struct PlanGate {
  routes: Mutex<HashMap<String, TurnRoute>>,
  pending_plans: Mutex<HashMap<String, PendingPlan>>,
  pending_questions: Mutex<HashMap<String, PendingQuestion>>,
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
  pub fn register_pending_plan(&self, session_id: &str, request_id: &str) -> oneshot::Receiver<ExitPlanModeResult> {
    let (tx, rx) = oneshot::channel();
    self.pending_plans.lock().unwrap().insert(
      session_id.to_string(),
      PendingPlan { request_id: request_id.to_string(), tx },
    );
    rx
  }

  /// The request id of the plan prompt currently awaiting a decision for this
  /// session, if any. Lets conversation steering treat a message typed while a
  /// plan card is open as plan-revision feedback.
  pub fn pending_plan_request(&self, session_id: &str) -> Option<String> {
    self.pending_plans.lock().unwrap().get(session_id).map(|p| p.request_id.clone())
  }

  /// Resolve a pending plan decision by its request id. Returns `true` when a
  /// matching prompt was found and answered.
  pub fn resolve_plan(&self, request_id: &str, result: ExitPlanModeResult) -> bool {
    let mut map = self.pending_plans.lock().unwrap();
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
  pub fn reject_pending_plan(&self, session_id: &str) {
    if let Some(p) = self.pending_plans.lock().unwrap().remove(session_id) {
      let _ = p.tx.send(ExitPlanModeResult {
        approved: false,
        selected_action: None,
        feedback: None,
      });
    }
  }

  /// The project/turn that owns a still-pending plan prompt, for validating
  /// that a `chat_resolve_plan` call targets the project it was raised for.
  pub fn plan_owner(&self, request_id: &str) -> Option<PlanOwner> {
    let session_id = self
      .pending_plans
      .lock()
      .unwrap()
      .iter()
      .find(|(_, p)| p.request_id == request_id)
      .map(|(k, _)| k.clone())?;
    let route = self.routes.lock().unwrap().get(&session_id).cloned()?;
    Some(PlanOwner { project_id: route.project_id })
  }

  /// Register a pending structured question and return the receiver the
  /// handler awaits. Any prior outstanding question for the session is
  /// dropped (its receiver then resolves to "no answer available").
  pub fn register_pending_question(
    &self,
    session_id: &str,
    request_id: &str,
    allow_freeform: bool,
  ) -> oneshot::Receiver<Option<UserInputResponse>> {
    let (tx, rx) = oneshot::channel();
    self.pending_questions.lock().unwrap().insert(
      session_id.to_string(),
      PendingQuestion { request_id: request_id.to_string(), allow_freeform, tx },
    );
    rx
  }

  /// The request id (and whether it accepts a free-form answer) of the
  /// question currently awaiting an answer for this session, if any. Lets
  /// conversation steering answer it directly when free-form is allowed.
  pub fn pending_question(&self, session_id: &str) -> Option<(String, bool)> {
    self
      .pending_questions
      .lock()
      .unwrap()
      .get(session_id)
      .map(|p| (p.request_id.clone(), p.allow_freeform))
  }

  /// Resolve a pending question by its request id with an answer (or `None`
  /// for "no answer available"). Returns `true` when a matching prompt was
  /// found and answered.
  pub fn resolve_question(&self, request_id: &str, response: Option<UserInputResponse>) -> bool {
    let mut map = self.pending_questions.lock().unwrap();
    let key = map
      .iter()
      .find(|(_, p)| p.request_id == request_id)
      .map(|(k, _)| k.clone());
    if let Some(k) = key {
      if let Some(p) = map.remove(&k) {
        return p.tx.send(response).is_ok();
      }
    }
    false
  }

  /// Reject and drop any outstanding question for a session (turn end
  /// cleanup), so a blocked `UserInputHandler` never leaks.
  pub fn reject_pending_question(&self, session_id: &str) {
    if let Some(p) = self.pending_questions.lock().unwrap().remove(session_id) {
      let _ = p.tx.send(None);
    }
  }

  /// The project/turn that owns a still-pending question, plus whether it
  /// accepts a free-form answer, for validating a `chat_resolve_question` call.
  pub fn question_owner(&self, request_id: &str) -> Option<QuestionOwner> {
    let (session_id, allow_freeform) = {
      let pending = self.pending_questions.lock().unwrap();
      pending
        .iter()
        .find(|(_, p)| p.request_id == request_id)
        .map(|(k, p)| (k.clone(), p.allow_freeform))?
    };
    let route = self.routes.lock().unwrap().get(&session_id).cloned()?;
    Some(QuestionOwner { project_id: route.project_id, turn_id: route.turn_id, allow_freeform })
  }
}

impl AppState {
  /// Register a fresh cancel token for a turn only if none is already running for
  /// this project. Returns `None` when a turn is already in flight.
  pub fn try_begin_chat(&self, project_id: &str) -> Option<CancelToken> {
    let mut map = self.chat_cancels.lock().unwrap();
    if map.contains_key(project_id) {
      return None;
    }
    let token = CancelToken::new();
    map.insert(project_id.to_string(), token.clone());
    Some(token)
  }

  /// Remove a turn's cancel token (called when the turn completes).
  pub fn end_chat(&self, project_id: &str) {
    self.chat_cancels.lock().unwrap().remove(project_id);
  }

  /// Cancel an in-flight turn, if one is running. Returns true when a token was
  /// found and signalled.
  pub fn cancel_chat(&self, project_id: &str) -> bool {
    if let Some(token) = self.chat_cancels.lock().unwrap().remove(project_id) {
      token.cancel();
      true
    } else {
      false
    }
  }

  /// Whether a chat turn is currently in flight for this project. Lets
  /// conversation steering decide between interjecting into a live turn and
  /// starting a fresh one.
  pub fn is_chat_running(&self, project_id: &str) -> bool {
    self.chat_cancels.lock().unwrap().contains_key(project_id)
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
  /// Only clears the slot when it still holds `token`, so a stale run finishing
  /// up never evicts a newer run that already took the slot.
  pub fn end_suggest(&self, project_id: &str, token: &CancelToken) {
    let mut map = self.suggest_cancels.lock().unwrap();
    if map.get(project_id).is_some_and(|t| t.same(token)) {
      map.remove(project_id);
    }
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

  /// Register a fresh inline-explain cancel token for a project only if none is
  /// already running. Returns `None` when an explanation is already in flight.
  pub fn try_begin_explain(&self, project_id: &str) -> Option<CancelToken> {
    let mut map = self.explain_cancels.lock().unwrap();
    if map.contains_key(project_id) {
      return None;
    }
    let token = CancelToken::new();
    map.insert(project_id.to_string(), token.clone());
    Some(token)
  }

  /// Remove an explain run's cancel token (called when it completes). Only clears
  /// the slot when it still holds `token`, so a stale run finishing never evicts a
  /// newer explanation that already took the slot.
  pub fn end_explain(&self, project_id: &str, token: &CancelToken) {
    let mut map = self.explain_cancels.lock().unwrap();
    if map.get(project_id).is_some_and(|t| t.same(token)) {
      map.remove(project_id);
    }
  }

  /// Cancel an in-flight inline explanation, if one is running. Returns true when
  /// a token was found and signalled.
  pub fn cancel_explain(&self, project_id: &str) -> bool {
    if let Some(token) = self.explain_cancels.lock().unwrap().remove(project_id) {
      token.cancel();
      true
    } else {
      false
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn route(project_id: &str, turn_id: &str, plan_context: bool) -> TurnRoute {
    TurnRoute { project_id: project_id.to_string(), turn_id: turn_id.to_string(), plan_context }
  }

  #[test]
  fn plan_round_trip_resolves_and_reports_owner() {
    let gate = PlanGate::default();
    gate.set_route("sess-1", route("proj-1", "turn-1", true));
    let mut rx = gate.register_pending_plan("sess-1", "req-1");

    assert_eq!(gate.pending_plan_request("sess-1").as_deref(), Some("req-1"));
    let owner = gate.plan_owner("req-1").expect("owner");
    assert_eq!(owner.project_id, "proj-1");

    let result = ExitPlanModeResult { approved: true, selected_action: Some("interactive".into()), feedback: None };
    assert!(gate.resolve_plan("req-1", result.clone()));
    let got = rx.try_recv().expect("resolved");
    assert!(got.approved);
    assert_eq!(got.selected_action.as_deref(), Some("interactive"));

    // Already resolved: a second resolve for the same id finds nothing.
    assert!(!gate.resolve_plan("req-1", result));
    assert_eq!(gate.pending_plan_request("sess-1"), None);
  }

  #[test]
  fn plan_teardown_unblocks_pending_receiver_as_rejected() {
    let gate = PlanGate::default();
    gate.set_route("sess-1", route("proj-1", "turn-1", true));
    let mut rx = gate.register_pending_plan("sess-1", "req-1");
    gate.reject_pending_plan("sess-1");
    let got = rx.try_recv().expect("resolved");
    assert!(!got.approved);
    assert_eq!(gate.pending_plan_request("sess-1"), None);
  }

  #[test]
  fn question_round_trip_resolves_and_reports_owner_with_freeform_flag() {
    let gate = PlanGate::default();
    gate.set_route("sess-1", route("proj-1", "turn-1", true));
    let mut rx = gate.register_pending_question("sess-1", "q-1", true);

    let (req_id, allow_freeform) = gate.pending_question("sess-1").expect("pending question");
    assert_eq!(req_id, "q-1");
    assert!(allow_freeform);

    let owner = gate.question_owner("q-1").expect("owner");
    assert_eq!(owner.project_id, "proj-1");
    assert!(owner.allow_freeform);

    assert!(gate.resolve_question("q-1", Some(UserInputResponse { answer: "yes".into(), was_freeform: true })));
    let got = rx.try_recv().expect("resolved").expect("answered");
    assert_eq!(got.answer, "yes");
    assert!(got.was_freeform);
    assert_eq!(gate.pending_question("sess-1"), None);
  }

  #[test]
  fn question_owner_reports_disallowed_freeform() {
    let gate = PlanGate::default();
    gate.set_route("sess-1", route("proj-1", "turn-1", true));
    let _rx = gate.register_pending_question("sess-1", "q-1", false);
    let owner = gate.question_owner("q-1").expect("owner");
    assert!(!owner.allow_freeform);
  }

  #[test]
  fn question_teardown_unblocks_pending_receiver_with_no_answer() {
    let gate = PlanGate::default();
    gate.set_route("sess-1", route("proj-1", "turn-1", true));
    let mut rx = gate.register_pending_question("sess-1", "q-1", true);
    gate.reject_pending_question("sess-1");
    let got = rx.try_recv().expect("resolved");
    assert!(got.is_none());
    assert_eq!(gate.pending_question("sess-1"), None);
  }

  #[test]
  fn plan_and_question_gates_are_independent_per_session() {
    let gate = PlanGate::default();
    gate.set_route("sess-1", route("proj-1", "turn-1", true));
    let mut plan_rx = gate.register_pending_plan("sess-1", "req-1");
    let mut question_rx = gate.register_pending_question("sess-1", "q-1", true);

    // Tearing down only the question gate leaves the plan gate untouched.
    gate.reject_pending_question("sess-1");
    assert!(gate.pending_plan_request("sess-1").is_some());
    assert!(gate.pending_question("sess-1").is_none());
    assert!(question_rx.try_recv().expect("resolved").is_none());

    gate.reject_pending_plan("sess-1");
    assert!(plan_rx.try_recv().is_ok());
  }

  #[test]
  fn unknown_request_ids_resolve_to_nothing() {
    let gate = PlanGate::default();
    assert!(!gate.resolve_plan("missing", ExitPlanModeResult::default()));
    assert!(!gate.resolve_question("missing", None));
    assert!(gate.plan_owner("missing").is_none());
    assert!(gate.question_owner("missing").is_none());
  }

  #[test]
  fn route_reports_plan_context_as_set() {
    let gate = PlanGate::default();
    gate.set_route("sess-1", route("proj-1", "turn-1", true));
    assert!(gate.route("sess-1").expect("route").plan_context);

    // An Agent-mode turn stores `plan_context: false`.
    gate.set_route("sess-1", route("proj-1", "turn-2", false));
    assert!(!gate.route("sess-1").expect("route").plan_context);
  }
}
