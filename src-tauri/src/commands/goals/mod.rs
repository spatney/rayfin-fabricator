//! Goals: what an app is for, and the checks it must keep passing, in plain
//! words, in the project's `GOALS.md` (`file`). It lives with the code, so git
//! keeps its history and the chat's Copilot reads it.
//!
//! A run checks the app, not its code. Fabricator copies the app and starts a
//! backend of its own for the copy, on a fresh database loaded from the seed
//! data (`scratch`). Copilot calls the copy's routes as the users each check is
//! about, and reports each check through tools (`tools`): a check passes only
//! on calls the run made that show it, never on what Copilot read in the code.
//! The results stay on this computer with a signature of the code they ran
//! against, so they go stale when it changes. Copilot can also draft the goals
//! from the app's code, for its maker to edit and save.

mod file;
mod prompt;
mod scratch;
mod tools;

pub use scratch::{clean_up, kill_all, stop_all, GoalRunners};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use github_copilot_sdk::Tool;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::commands::advisor::{self, DrainEnd, RunCtx, Sandbox, TextAcc};
use crate::commands::chat_tools;
use crate::services::copilot::{ModelChoice, SessionOptions, COPILOT_SIGN_IN_REQUIRED};
use crate::services::emit::emit_goals_event;
use crate::services::exec::CancelToken;
use crate::services::project_layout::ProjectLayout;
use crate::services::{paths, store};
use crate::state::AppState;
use crate::types::{
  ChatToolCall, ChatToolState, GoalCheck, GoalResult, GoalStatus, GoalsEvent, GoalsProposal, GoalsRunEnd,
  GoalsRunInfo, GoalsRunRequest, GoalsSnapshot, StudioProject,
};
use scratch::{Failure, Scratch};
use tools::{DraftContext, Emit, RunContext, RunCore};

/// The most a draft may take.
const DRAFT_TIMEOUT_MS: u64 = 5 * 60_000;
/// Output kept per activity step (the tab shows a preview).
const MAX_ACTIVITY_OUTPUT: usize = 1500;
/// Built-in tools a Goals session doesn't use, beside the read-only sessions' (see `advisor::EXCLUDED_TOOLS`).
const ALSO_EXCLUDED: &[&str] = &["web_fetch", "fetch", "skill"];
const TEAM_APP: &str = "Goals checks don't run on team apps yet.";
/// What a chat turn is told when the app's `GOALS.md` has checks.
const CHAT_NOTE: &str = "[Fabricator: GOALS.md, at the app's root, says what this app is for and lists checks it must keep passing, which the user runs in Fabricator before publishing. Read it before you change the app's data, permissions, functions or screens. If a change would stop a check passing, tell the user which, and why. Edit GOALS.md only when the user asks.]";

/// How long Copilot gets to check `n` checks, in minutes.
fn run_minutes(n: usize) -> u64 {
  (4 + n as u64).clamp(10, 30)
}

/// The checks a run covers, in `GOALS.md`'s order: those in `ids`, or all of them.
fn chosen(checks: &[GoalCheck], ids: Option<&[String]>) -> Result<Vec<GoalCheck>, String> {
  if checks.is_empty() {
    return Err("Add a check first: say what the app must keep doing, then run it.".into());
  }
  let picked: Vec<GoalCheck> = match ids {
    Some(ids) => checks.iter().filter(|check| ids.contains(&check.id)).cloned().collect(),
    None => checks.to_vec(),
  };
  if picked.is_empty() {
    return Err("Those checks aren't in GOALS.md any more. Pick the checks to run again.".into());
  }
  if picked.len() > file::MAX_CHECKS {
    return Err(format!(
      "That's more than {} checks for one run. Run them in parts: pick the checks to run.",
      file::MAX_CHECKS
    ));
  }
  Ok(picked)
}

/* ------------------------------ saved results ------------------------------ */

/// A project's last results, kept on this computer ([`paths::goals_file`]).
#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
struct Saved {
  results: Vec<GoalResult>,
  last_run: Option<GoalsRunInfo>,
}

fn load_saved(project_id: &str) -> Saved {
  std::fs::read_to_string(paths::goals_file(project_id))
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
    .unwrap_or_default()
}

fn save(project_id: &str, saved: &Saved) {
  let written = serde_json::to_string_pretty(saved)
    .map_err(|e| e.to_string())
    .and_then(|text| advisor::write_atomic(&paths::goals_file(project_id), &text));
  if let Err(e) = written {
    log::warn!("failed to save the Goals results of {project_id}: {e}");
  }
}

/// `saved` with a run's `results` in place of their checks' earlier ones, kept
/// only for the checks `GOALS.md` has now, and the run as the last one.
fn merged(mut saved: Saved, results: Vec<GoalResult>, run: GoalsRunInfo, checks: &[GoalCheck]) -> Saved {
  saved.results.retain(|old| !results.iter().any(|new| new.check_id == old.check_id));
  saved.results.extend(results);
  saved.results.retain(|result| checks.iter().any(|check| check.id == result.check_id));
  saved.last_run = Some(run);
  saved
}

/* -------------------------------- snapshots -------------------------------- */

fn read_text(path: &Path) -> Option<String> {
  std::fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// The project's `GOALS.md`, read, when it has one.
fn read_goals(project: &Path) -> Option<file::Goals> {
  read_text(&project.join(file::FILE_NAME)).map(|text| file::parse(&text))
}

/// Why the checks can't run for `project`, when they can't.
fn cannot_run(project: &StudioProject) -> Option<&'static str> {
  project.team.is_some().then_some(TEAM_APP)
}

/// What the Goals tab shows: `goals` (`None` without a `GOALS.md`) with each
/// check's saved result, stale when the app's code is no longer `current`.
fn snapshot(goals: Option<file::Goals>, saved: Saved, current: &str, cannot_run: Option<&str>) -> GoalsSnapshot {
  let exists = goals.is_some();
  let goals = goals.unwrap_or_default();
  let results: Vec<GoalResult> = goals
    .checks
    .iter()
    .filter_map(|check| saved.results.iter().find(|result| result.check_id == check.id))
    .map(|result| GoalResult { stale: result.fingerprint != current, ..result.clone() })
    .collect();
  let all_passed = !goals.checks.is_empty()
    && goals.checks.iter().all(|check| {
      results.iter().any(|r| r.check_id == check.id && r.status == GoalStatus::Passed && !r.stale)
    });
  GoalsSnapshot {
    exists,
    purpose: goals.purpose,
    checks: goals.checks,
    results,
    last_run: saved.last_run,
    all_passed,
    cannot_run: cannot_run.map(str::to_string),
    running: false,
  }
}

/// The project's goals and their results, as they are now.
async fn load(project: &StudioProject) -> GoalsSnapshot {
  let (id, path, cannot) = (project.id.clone(), PathBuf::from(&project.path), cannot_run(project));
  tokio::task::spawn_blocking(move || {
    let goals = read_goals(&path);
    let saved = load_saved(&id);
    // Only results need the code's signature, which takes a moment.
    let current = if saved.results.is_empty() { String::new() } else { scratch::app_fingerprint(&path) };
    snapshot(goals, saved, &current, cannot)
  })
  .await
  .unwrap_or_default()
}

fn find(project_id: &str) -> Result<StudioProject, String> {
  store::find_project(project_id).ok_or_else(|| "Project not found.".to_string())
}

/// The note a chat turn in `project` starts with, when the Goals experiment is
/// on and the app's `GOALS.md` has checks.
pub fn chat_note(project: &StudioProject) -> Option<&'static str> {
  if project.team.is_some() || !store::goals_enabled() {
    return None;
  }
  let goals = read_goals(Path::new(&project.path))?;
  (!goals.checks.is_empty()).then_some(CHAT_NOTE)
}

/* -------------------------------- sessions -------------------------------- */

fn now_ms() -> f64 {
  chrono::Utc::now().timestamp_millis() as f64
}

/// `text` with paths in the copy at `from` shown in the project at `to`,
/// whichever way their slashes lean.
fn relocated(text: &str, from: &str, to: &str) -> String {
  let (from, to) = (from.trim_end_matches(['/', '\\']), to.trim_end_matches(['/', '\\']));
  if from.is_empty() {
    return text.to_string();
  }
  let mut out = text.to_string();
  for (slash, as_slash) in [('/', "\\"), ('\\', "/")] {
    out = out.replace(&from.replace(slash, as_slash), &to.replace(slash, as_slash));
  }
  out
}

/// The tool calls a session makes, as the chat's step rows show them.
#[derive(Default)]
struct Activity {
  tools: HashMap<String, ChatToolCall>,
  /// A run's copy of the app and the project it copies: steps show the project's paths.
  copy: Option<(String, String)>,
}

impl Activity {
  fn of_copy(copy: &str, project: &str) -> Self {
    Self { copy: Some((copy.to_string(), project.to_string())), ..Self::default() }
  }

  fn shown(&self, text: String) -> String {
    match &self.copy {
      Some((copy, project)) => relocated(&text, copy, project),
      None => text,
    }
  }

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
          title: self.shown(chat_tools::tool_title(&name, args)),
          command: chat_tools::shell_command(&name, args).map(|command| self.shown(command)),
          paths: chat_tools::tool_paths(&name, args).map(|paths| paths.into_iter().map(|path| self.shown(path)).collect()),
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
        let name = self.tools.get(id)?.name.clone();
        let details = chat_tools::tool_end_details(Some(&name), data);
        let output = details.output.map(|output| chat_tools::truncate(&self.shown(output), MAX_ACTIVITY_OUTPUT));
        let success = data.get("success").and_then(Value::as_bool).unwrap_or(false);
        let tool = self.tools.get_mut(id)?;
        tool.state = if success { ChatToolState::Success } else { ChatToolState::Error };
        tool.output = output;
        tool.exit_code = details.exit_code;
        tool.ended_at = Some(now_ms());
        Some(tool.clone())
      }
      _ => None,
    }
  }
}

/// Deliver a project's Goals events to the window.
fn emitter(app: &AppHandle, project_id: &str) -> Emit {
  let (app, project_id) = (app.clone(), project_id.to_string());
  Arc::new(move |event| emit_goals_event(&app, &project_id, event))
}

/// A Goals session's options: it reads only `root` (no secret files, nothing
/// on the web, no MCP server), takes none of the app's files as its own
/// instructions, and has `tools`.
fn options(root: &str, tools: Vec<Tool>) -> SessionOptions {
  let mut opts = advisor::sandboxed_options(root, Sandbox { url_hosts: &[], read_only_mcp: false });
  opts.untrusted = true;
  opts.excluded_tools.extend(ALSO_EXCLUDED.iter().map(|tool| tool.to_string()));
  opts.tools = tools;
  opts
}

/// A run's or a draft's place for its project, given back when it ends, however it ends.
struct Slot<'a> {
  state: &'a AppState,
  project_id: String,
  token: CancelToken,
  draft: bool,
}

impl Drop for Slot<'_> {
  fn drop(&mut self) {
    if self.draft {
      self.state.end_goals_draft(&self.project_id, &self.token);
    } else {
      self.state.end_goals(&self.project_id, &self.token);
    }
  }
}

/// Copilot's error, as the tab says it.
fn plain_error(error: &str) -> String {
  if error == COPILOT_SIGN_IN_REQUIRED {
    return "GitHub Copilot isn't signed in. Sign in to Copilot in Fabricator, then try again.".into();
  }
  error.trim().replace("retry your message", "try again")
}

/// Why Copilot couldn't start `what`.
fn not_started(what: &str, error: &str) -> String {
  if error == COPILOT_SIGN_IN_REQUIRED {
    return plain_error(error);
  }
  format!("Copilot couldn't start {what}. {}", plain_error(error))
}

/// How a run ended, as its `done` event says it.
#[derive(Debug, PartialEq)]
struct Outcome {
  /// Every check it was given has a result.
  ok: bool,
  cancelled: bool,
  /// Why it stopped short.
  error: Option<String>,
}

impl Outcome {
  fn cancelled() -> Self {
    Self { ok: false, cancelled: true, error: None }
  }

  fn failed(error: String) -> Self {
    Self { ok: false, cancelled: false, error: Some(error) }
  }

  /// How Copilot's part of a run with `given` checks ended: `end`, the error
  /// it reported, and the `reported` checks it got to. `minutes` is its limit.
  fn of(end: &Result<DrainEnd, String>, errored: Option<&str>, reported: usize, given: usize, minutes: u64) -> Self {
    let end = match end {
      Err(e) => return Self::failed(not_started("the checks", e)),
      Ok(DrainEnd::Cancelled) => return Self::cancelled(),
      Ok(_) if reported >= given => return Self { ok: true, cancelled: false, error: None },
      Ok(end) => end,
    };
    let unreached = if given == 1 {
      "the check".to_string()
    } else if reported == 0 {
      "any of the checks".to_string()
    } else {
      format!("{} of the {given} checks", given - reported)
    };
    Self::failed(match (errored, end) {
      (Some(e), _) => format!("Copilot stopped before it got to {unreached}. {}", plain_error(e)),
      (None, DrainEnd::TimedOut) => format!(
        "The run stopped after {minutes} minutes, before Copilot got to {unreached}. {}",
        if given > 1 { "Run fewer checks at a time." } else { "Try again." }
      ),
      (None, DrainEnd::Closed) => format!("Copilot's session ended before it got to {unreached}. Try again."),
      (None, _) => format!("Copilot ended the run before it got to {unreached}. Try again."),
    })
  }
}

/// Copy the app at `root` into `scratch` and start the copy, with the
/// fingerprint of the code it copied. It holds the project's lease while it's
/// fingerprinted and copied, so chat turns and publishes can't start then: the
/// copy is the code as a turn left it, and its results go stale with the next.
async fn prepare(
  state: &AppState,
  project_id: &str,
  scratch: &Scratch,
  root: &Path,
  token: &CancelToken,
  phase: &(dyn Fn(&str) + Send + Sync),
) -> Result<(String, scratch::Ready), Failure> {
  let fingerprint = {
    let _lease = state.mutations.goals(project_id).map_err(Failure::Error)?;
    let at = root.to_path_buf();
    let fingerprint = tokio::task::spawn_blocking(move || scratch::app_fingerprint(&at)).await.unwrap_or_default();
    scratch.copy(root, token).await?;
    fingerprint
  };
  Ok((fingerprint, scratch.prepare(token, phase).await?))
}

/* -------------------------------- commands -------------------------------- */

/// The project's goals and their last results, and whether a run is going.
#[tauri::command]
pub async fn goals_load(project_id: String, state: State<'_, AppState>) -> Result<GoalsSnapshot, String> {
  let project = find(&project_id)?;
  let snapshot = load(&project).await;
  Ok(GoalsSnapshot { running: state.goals_running(&project_id), ..snapshot })
}

/// Save the project's goals to its `GOALS.md`, keeping whatever else the file says.
#[tauri::command]
pub async fn goals_save(project_id: String, purpose: String, checks: Vec<String>) -> Result<GoalsSnapshot, String> {
  let project = find(&project_id)?;
  let (purpose, checks) = file::validate(&purpose, &checks)?;
  let path = Path::new(&project.path).join(file::FILE_NAME);
  tokio::task::spawn_blocking(move || {
    let old = read_text(&path);
    let goals = old.as_deref().map(file::parse).unwrap_or_default();
    let mut text = file::render(&goals.intro, &purpose, &checks, &goals.rest);
    if old.as_deref().is_some_and(|old| old.contains("\r\n")) {
      text = text.replace('\n', "\r\n");
    }
    advisor::write_atomic(&path, &text)
  })
  .await
  .map_err(|e| e.to_string())
  .and_then(|written| written)
  .map_err(|e| format!("Fabricator couldn't save GOALS.md: {e}"))?;
  Ok(load(&project).await)
}

/// Run the project's checks (those in the request, or all of them) on a fresh
/// copy of the app, streaming its steps and each result. `Err` only when the
/// run can't begin: an unknown project, a team app, no such checks, or a run
/// already going. Otherwise whatever results it got are saved, its `done`
/// event says how it went, and so does what it resolves with, along with the
/// goals and results as they are now.
#[tauri::command]
pub async fn goals_run(
  app: AppHandle,
  state: State<'_, AppState>,
  runners: State<'_, GoalRunners>,
  project_id: String,
  request: GoalsRunRequest,
) -> Result<GoalsRunEnd, String> {
  let project = find(&project_id)?;
  if let Some(reason) = cannot_run(&project) {
    return Err(reason.into());
  }
  let root = PathBuf::from(&project.path);
  let goals = read_goals(&root).unwrap_or_default();
  let checks = chosen(&goals.checks, request.check_ids.as_deref())?;
  let Some(token) = state.try_begin_goals(&project_id) else {
    return Err("Checks are already running for this app.".into());
  };
  // Given back once the copy is stopped and removed and the results saved.
  let slot = Slot { state: &state, project_id: project_id.clone(), token: token.clone(), draft: false };
  let started = Instant::now();
  let ran_at = chrono::Utc::now().to_rfc3339();
  let emit = emitter(&app, &project_id);
  let phase = |phase: &str| emit(GoalsEvent::Phase { phase: phase.to_string(), detail: None });
  phase("preparing");

  let minutes = run_minutes(checks.len());
  let mut reported: Vec<GoalResult> = Vec::new();
  let mut summary = None;
  let outcome = match Scratch::new(runners.backends(), &project_id, &paths::goals_runs_dir()) {
    Err(e) => Outcome::failed(e),
    Ok(scratch) => {
      let outcome = match prepare(&state, &project_id, &scratch, &root, &token, &phase).await {
        Err(Failure::Cancelled) => Outcome::cancelled(),
        Err(Failure::Error(e)) => Outcome::failed(e),
        Ok((fingerprint, ready)) => {
          phase("checking");
          let ctx = Arc::new(RunContext {
            emit: emit.clone(),
            copy: scratch.handle(),
            core: RunCore::new(checks.clone(), fingerprint),
          });
          let copy = scratch.root().to_string_lossy().to_string();
          let run = RunCtx {
            copilot: &state.copilot,
            byok: &state.byok,
            root: &copy,
            choice: ModelChoice::new(
              request.model.clone(),
              request.effort.clone(),
              request.auto_tier.clone(),
              request.context_tier.clone(),
            ),
            token: &token,
          };
          let prompt = prompt::run_prompt(&goals.purpose, &checks, &ready, minutes);
          let opts = options(&copy, tools::run_tools(ctx.clone()));
          let mut text = TextAcc::default();
          let mut activity = Activity::of_copy(&copy, &project.path);
          let end = advisor::one_shot(&run, opts, prompt, minutes * 60_000, |event_type, data| {
            if let Some(tool) = activity.feed(event_type, data) {
              emit(GoalsEvent::Activity { tool });
            }
            text.feed(event_type, data);
            advisor::is_terminal(event_type)
          })
          .await;
          {
            let log = ctx.core.log.lock().unwrap_or_else(|e| e.into_inner());
            reported = log.results.clone();
            summary = log.summary.clone();
          }
          Outcome::of(&end, text.errored.as_deref(), reported.len(), checks.len(), minutes)
        }
      };
      phase("finishing");
      scratch.finish().await;
      outcome
    }
  };

  if !reported.is_empty() {
    let run = GoalsRunInfo {
      ran_at,
      duration_ms: started.elapsed().as_millis() as u64,
      model: request.model.clone().filter(|m| !m.trim().is_empty() && m != "auto"),
      summary: summary.unwrap_or_default(),
      check_ids: checks.iter().map(|check| check.id.clone()).collect(),
      all: checks.len() == goals.checks.len(),
      complete: reported.len() >= checks.len(),
    };
    let id = project_id.clone();
    let _ = tokio::task::spawn_blocking(move || {
      let now = read_goals(&root).map(|goals| goals.checks).unwrap_or_default();
      save(&id, &merged(load_saved(&id), reported, run, &now));
    })
    .await;
  }
  // Free before `done`, so a run started on it doesn't find this one going.
  drop(slot);
  let Outcome { ok, cancelled, error } = outcome;
  emit(GoalsEvent::Done { ok, cancelled, error: error.clone() });
  Ok(GoalsRunEnd { ok, cancelled, error, snapshot: load(&project).await })
}

/// Stop the project's run, if one is going. It still stops and removes its copy.
#[tauri::command]
pub fn goals_cancel(state: State<'_, AppState>, project_id: String) -> bool {
  state.cancel_goals(&project_id)
}

/// Have Copilot read the app and propose its goals, building on the `purpose`
/// and `checks` the tab has, saved or not. Nothing is saved: the user edits
/// the proposal, then saves it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn goals_draft(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
  purpose: String,
  checks: Vec<String>,
  model: Option<String>,
  effort: Option<String>,
  auto_tier: Option<String>,
  context_tier: Option<String>,
) -> Result<GoalsProposal, String> {
  let project = find(&project_id)?;
  let (purpose, checks) = file::validate(&purpose, &checks)?;
  let Some(token) = state.try_begin_goals_draft(&project_id) else {
    return Err("Copilot is already drafting this app's goals.".into());
  };
  let _slot = Slot { state: &state, project_id: project_id.clone(), token: token.clone(), draft: true };
  let ctx = Arc::new(DraftContext::default());
  let run = RunCtx {
    copilot: &state.copilot,
    byok: &state.byok,
    root: &project.path,
    choice: ModelChoice::new(model, effort, auto_tier, context_tier),
    token: &token,
  };
  let emit = emitter(&app, &project_id);
  let layout = ProjectLayout::read(Path::new(&project.path));
  let prompt = prompt::draft_prompt(&purpose, &file::with_ids(checks), &layout);
  let opts = options(&project.path, tools::draft_tools(ctx.clone()));
  let mut text = TextAcc::default();
  let mut activity = Activity::default();
  let end = advisor::one_shot(&run, opts, prompt, DRAFT_TIMEOUT_MS, |event_type, data| {
    if let Some(tool) = activity.feed(event_type, data) {
      emit(GoalsEvent::DraftActivity { tool });
    }
    text.feed(event_type, data);
    advisor::is_terminal(event_type)
  })
  .await;
  let proposal = ctx.proposal.lock().unwrap_or_else(|e| e.into_inner()).clone();
  match (end, proposal) {
    (Err(e), _) => Err(not_started("drafting", &e)),
    (Ok(DrainEnd::Cancelled), _) => Err("Drafting stopped.".into()),
    (Ok(_), Some(proposal)) => Ok(proposal),
    (Ok(end), None) => Err(match (&text.errored, end) {
      (Some(e), _) => plain_error(e),
      (None, DrainEnd::TimedOut) => format!(
        "Copilot didn't propose any goals within {} minutes. Try again.",
        DRAFT_TIMEOUT_MS / 60_000
      ),
      _ => "Copilot ended without proposing any goals. Try again.".into(),
    }),
  }
}

/// Stop drafting the project's goals, if Copilot is.
#[tauri::command]
pub fn goals_draft_cancel(state: State<'_, AppState>, project_id: String) -> bool {
  state.cancel_goals_draft(&project_id)
}

#[cfg(test)]
mod tests {
  use serde_json::json;

  use super::*;

  fn checks(texts: &[&str]) -> Vec<GoalCheck> {
    file::with_ids(texts.iter().map(|text| text.to_string()).collect())
  }

  fn result(check: &GoalCheck, status: GoalStatus, fingerprint: &str) -> GoalResult {
    GoalResult {
      check_id: check.id.clone(),
      check: check.text.clone(),
      status,
      fingerprint: fingerprint.into(),
      ..GoalResult::default()
    }
  }

  fn goals(checks: &[GoalCheck]) -> Option<file::Goals> {
    Some(file::Goals { purpose: "Track the team's deals.".into(), checks: checks.to_vec(), ..file::Goals::default() })
  }

  fn passed(checks: &[GoalCheck], fingerprint: &str) -> Saved {
    Saved { results: checks.iter().map(|c| result(c, GoalStatus::Passed, fingerprint)).collect(), last_run: None }
  }

  #[test]
  fn every_check_passes_only_on_the_code_as_it_is_now() {
    let list = checks(&["A rep can log a deal.", "Reps see only their own deals."]);
    let now = snapshot(goals(&list), passed(&list, "v1"), "v1", None);
    assert!(now.exists && now.all_passed && now.results.iter().all(|r| !r.stale));
    let changed = snapshot(goals(&list), passed(&list, "v1"), "v2", None);
    assert!(!changed.all_passed && changed.results.iter().all(|r| r.stale));

    let mut one_left = passed(&list, "v1");
    one_left.results.pop();
    assert!(!snapshot(goals(&list), one_left, "v1", None).all_passed);
    let mut failed = passed(&list, "v1");
    failed.results[1].status = GoalStatus::Failed;
    assert!(!snapshot(goals(&list), failed, "v1", None).all_passed);

    assert!(!snapshot(goals(&[]), Saved::default(), "", None).all_passed);
    let none = snapshot(None, Saved::default(), "", Some(TEAM_APP));
    assert!(!none.exists && !none.all_passed);
    assert_eq!(none.cannot_run.as_deref(), Some(TEAM_APP));
  }

  #[test]
  fn a_reworded_check_has_no_result_until_it_runs() {
    let list = checks(&["A rep can log a deal.", "Reps see only their own deals."]);
    let reworded = checks(&["a rep can log a deal", "Reps see only the deals they own."]);
    let now = snapshot(goals(&reworded), passed(&list, "v1"), "v1", None);
    assert_eq!(now.results.len(), 1);
    assert_eq!(now.results[0].check_id, reworded[0].id);
    assert!(!now.all_passed);
  }

  #[test]
  fn a_run_replaces_its_checks_results_and_keeps_the_others() {
    let list = checks(&["A", "B", "C"]);
    let gone = checks(&["Gone"]);
    let saved = Saved {
      results: vec![
        result(&list[0], GoalStatus::Passed, "v1"),
        result(&list[1], GoalStatus::Passed, "v1"),
        result(&gone[0], GoalStatus::Passed, "v1"),
      ],
      last_run: None,
    };
    let run = GoalsRunInfo { check_ids: vec![list[1].id.clone(), list[2].id.clone()], ..GoalsRunInfo::default() };
    let ran = vec![result(&list[1], GoalStatus::Failed, "v2"), result(&list[2], GoalStatus::Passed, "v2")];
    let after = merged(saved, ran, run.clone(), &list);
    let outcome = |check: &GoalCheck| {
      after.results.iter().find(|r| r.check_id == check.id).map(|r| (r.status, r.fingerprint.as_str()))
    };
    assert_eq!(outcome(&list[0]), Some((GoalStatus::Passed, "v1")));
    assert_eq!(outcome(&list[1]), Some((GoalStatus::Failed, "v2")));
    assert_eq!(outcome(&list[2]), Some((GoalStatus::Passed, "v2")));
    assert_eq!(outcome(&gone[0]), None);
    assert_eq!(after.last_run, Some(run));
  }

  #[test]
  fn a_run_takes_the_checks_asked_for_in_the_files_order() {
    let list = checks(&["A", "B", "C"]);
    assert_eq!(chosen(&list, None).unwrap(), list);
    let ids = vec![list[2].id.clone(), list[0].id.clone(), "gone".to_string()];
    assert_eq!(chosen(&list, Some(&ids)).unwrap(), vec![list[0].clone(), list[2].clone()]);
    assert!(chosen(&list, Some(&["gone".to_string()])).unwrap_err().contains("aren't in GOALS.md"));
    assert!(chosen(&[], None).unwrap_err().starts_with("Add a check first"));

    let many = file::with_ids((0..=file::MAX_CHECKS).map(|n| format!("Check {n}")).collect());
    assert!(chosen(&many, None).unwrap_err().contains("Run them in parts"));
    assert_eq!(chosen(&many, Some(&[many[3].id.clone()])).unwrap().len(), 1);
  }

  #[test]
  fn a_run_gets_more_time_for_more_checks_within_limits() {
    assert_eq!(run_minutes(1), 10);
    assert_eq!(run_minutes(12), 16);
    assert_eq!(run_minutes(40), 30);
  }

  #[test]
  fn steps_show_the_projects_paths_not_the_copys() {
    let (copy, project) = (r"C:\cache\goals\app-1a2b", r"C:\apps\deals");
    assert_eq!(relocated(r"C:\cache\goals\app-1a2b\rayfin\data\schema.ts", copy, project), r"C:\apps\deals\rayfin\data\schema.ts");
    assert_eq!(relocated("C:/cache/goals/app-1a2b/src/App.tsx:3", copy, project), "C:/apps/deals/src/App.tsx:3");
    assert_eq!(relocated("nothing to move", copy, project), "nothing to move");

    let mut activity = Activity::of_copy(copy, project);
    let start = json!({ "toolName": "view", "toolCallId": "t1", "arguments": { "path": r"C:\cache\goals\app-1a2b\src\App.tsx" } });
    let step = activity.feed("tool.execution_start", &start).unwrap();
    assert_eq!(step.paths, Some(vec![r"C:\apps\deals\src\App.tsx".to_string()]));
    // The run's reports aren't steps; its calls to the app are.
    let report = json!({ "toolName": tools::RESULT_TOOL, "toolCallId": "t2", "arguments": {} });
    assert!(activity.feed("tool.execution_start", &report).is_none());
    let call = json!({ "toolName": tools::CALL_TOOL, "toolCallId": "t3", "arguments": { "target": "graphql" } });
    assert!(activity.feed("tool.execution_start", &call).is_some());
  }

  #[test]
  fn a_run_that_stops_short_says_why() {
    let complete = Outcome { ok: true, cancelled: false, error: None };
    assert_eq!(Outcome::of(&Ok(DrainEnd::Finished), None, 3, 3, 10), complete);
    // An error after the last report doesn't take the results away.
    assert_eq!(Outcome::of(&Ok(DrainEnd::Closed), Some("boom"), 3, 3, 10), complete);
    assert_eq!(Outcome::of(&Ok(DrainEnd::Cancelled), None, 1, 3, 10), Outcome::cancelled());

    let error = |end: Result<DrainEnd, String>, errored: Option<&str>, reported: usize, given: usize| {
      Outcome::of(&end, errored, reported, given, 12).error.unwrap()
    };
    assert_eq!(
      error(Ok(DrainEnd::Finished), None, 1, 3),
      "Copilot ended the run before it got to 2 of the 3 checks. Try again."
    );
    assert_eq!(
      error(Ok(DrainEnd::TimedOut), None, 0, 3),
      "The run stopped after 12 minutes, before Copilot got to any of the checks. Run fewer checks at a time."
    );
    assert_eq!(
      error(Ok(DrainEnd::TimedOut), None, 0, 1),
      "The run stopped after 12 minutes, before Copilot got to the check. Try again."
    );
    assert_eq!(
      error(Ok(DrainEnd::Closed), None, 2, 3),
      "Copilot's session ended before it got to 1 of the 3 checks. Try again."
    );
    assert_eq!(
      error(Ok(DrainEnd::Finished), Some(" Rate limited. Please retry your message. "), 0, 2),
      "Copilot stopped before it got to any of the checks. Rate limited. Please try again."
    );
    assert_eq!(
      error(Err(COPILOT_SIGN_IN_REQUIRED.into()), None, 0, 2),
      "GitHub Copilot isn't signed in. Sign in to Copilot in Fabricator, then try again."
    );
    assert_eq!(error(Err("No such model.".into()), None, 0, 2), "Copilot couldn't start the checks. No such model.");
  }
}
