//! Puts the local backend's problems in the activity journal Help reads.
//!
//! The supervisor (`services::local_backend`) journals its own milestones: a
//! start (`local.started`), a stop after a fatal problem (`local.failed`) and
//! giving up after repeated crashes (`local.crashed`). Everything else it
//! reports only in its status: warnings, errors it keeps running through, a
//! data model change it refused while running, functions that didn't build,
//! the app's dev server failing. This follows that status (`local:state`) and
//! journals those, each once, and journals when one clears, so Help can tell a
//! problem that's over from one that isn't.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::{AppHandle, Listener};

use crate::services::diagnostics::redact_secrets;
use crate::services::journal::{self, Area, Entry, Level};
use crate::services::local_backend::LOCAL_STATE;
use crate::types::{LocalBackendState as State, LocalProblem, LocalStatus};

/// Most of a list (losses, compiler errors) put in a journal message; the
/// detail has the rest.
const MAX_ITEMS: usize = 3;

/// What has been journaled for one project.
#[derive(Default)]
struct Seen {
  /// The newest status handled, so a late or repeated one is ignored.
  revision: u64,
  /// When that status was taken. A backend Fabricator forgot and started again
  /// counts its revisions from zero, but its statuses are newer than this.
  updated_at: Option<String>,
  /// Warnings journaled, by code and message: once per Fabricator session. A
  /// restart repeats its run's warnings, and Help's view of the live status
  /// says whether one still holds.
  warnings: HashSet<String>,
  /// The last non-fatal error journaled.
  error: Option<String>,
  /// The last event of each kind handled, and whether a failure of that kind
  /// is open (journaled and not yet resolved).
  schema: Option<String>,
  schema_open: bool,
  functions: Option<String>,
  functions_open: bool,
  analysis: Option<String>,
  analysis_open: bool,
  vite: Option<String>,
  vite_open: bool,
}

/// Turns each project's status into the journal entries it calls for.
#[derive(Default)]
pub struct LocalJournal {
  projects: HashMap<String, Seen>,
}

fn record(level: Level, event: &str, project_id: &str, message: &str, detail: Option<String>) -> Entry {
  let entry = journal::entry(level, Area::Preview, event, &redact_secrets(message))
    .operation("local_backend")
    .project(Some(project_id.to_string()))
    .detail(detail.map(|d| redact_secrets(&d)));
  if level == Level::Info {
    entry
  } else {
    entry.surface(journal::Surface::Backend)
  }
}

/// A problem's message and hint, as one line.
fn said(problem: &LocalProblem) -> String {
  match problem.hint.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
    Some(hint) => format!("{} {hint}", problem.message.trim()),
    None => problem.message.trim().to_string(),
  }
}

/// A problem's code and details, for the entry's detail.
fn detail(problem: &LocalProblem) -> String {
  match problem.details.as_ref().filter(|d| !d.is_null()) {
    Some(details) => format!("code: {}\ndetails: {details}", problem.code),
    None => format!("code: {}", problem.code),
  }
}

/// The first few of `items`, and how many more there are.
fn some(items: &[String]) -> String {
  let mut text = items.iter().take(MAX_ITEMS).map(|i| i.trim()).collect::<Vec<_>>().join("; ");
  if items.len() > MAX_ITEMS {
    text.push_str(&format!("; and {} more", items.len() - MAX_ITEMS));
  }
  text
}

/// Whether `key` is new for `last`, which then holds it.
fn fresh(last: &mut Option<String>, key: String) -> bool {
  if last.as_deref() == Some(key.as_str()) {
    return false;
  }
  *last = Some(key);
  true
}

impl LocalJournal {
  /// The entries `status` calls for, given what came before.
  pub fn observe(&mut self, status: &LocalStatus) -> Vec<Entry> {
    let seen = self.projects.entry(status.project_id.clone()).or_default();
    // Times are `now_iso`'s fixed-width UTC, so they compare as text.
    let later = status.updated_at.as_deref().is_some_and(|at| seen.updated_at.as_deref().is_none_or(|known| at > known));
    if status.revision <= seen.revision && !later {
      return Vec::new();
    }
    seen.revision = status.revision;
    seen.updated_at = status.updated_at.clone();
    let id = status.project_id.as_str();
    // Problems found while starting stop the start, and the supervisor
    // journals that (`local.failed`); only these happen to a running app.
    let running = status.state == State::Running;
    let mut out = Vec::new();

    for warning in &status.warnings {
      // The functions' own record below carries the compiler errors.
      if warning.code == "functions-build-failed" {
        continue;
      }
      if seen.warnings.insert(format!("{}\n{}", warning.code, warning.message)) {
        let message = format!("The local backend warned ({}): {}", warning.code, said(warning));
        out.push(record(Level::Warn, "local.warning", id, &message, Some(detail(warning))));
      }
    }

    if let Some(error) = status.error.as_ref().filter(|e| !e.fatal) {
      let key = format!("{}\n{}\n{}", error.code, error.message, error.time.as_deref().unwrap_or_default());
      if fresh(&mut seen.error, key) {
        let (level, message) = if error.code == "exited" {
          (Level::Warn, error.message.trim().to_string())
        } else {
          (Level::Error, format!("The local backend reported a problem ({}): {}", error.code, said(error)))
        };
        out.push(record(level, "local.error", id, &message, Some(detail(error))));
      }
    }

    if let Some(schema) = &status.schema {
      let key = format!("{}\n{:?}\n{:?}\n{:?}", schema.result, schema.time, schema.changes, schema.losses);
      if fresh(&mut seen.schema, key) {
        match schema.result.as_str() {
          "refused" if running => {
            seen.schema_open = true;
            let message = format!(
              "A change to the data model wasn't applied to the local database, because it would delete local data: {}. The previous data model stays in use until the user decides.",
              some(&schema.losses)
            );
            out.push(record(Level::Warn, "local.schema.refused", id, &message, Some(schema.losses.join("\n"))));
          }
          "failed" if running => {
            seen.schema_open = true;
            let message = format!(
              "The local database couldn't be updated to the data model: {}. The previous data model stays in use.",
              schema.message.as_deref().unwrap_or("no reason given").trim()
            );
            out.push(record(Level::Error, "local.schema.failed", id, &message, None));
          }
          "applied" if !schema.losses.is_empty() => {
            seen.schema_open = false;
            let message = format!(
              "A change to the data model was applied to the local database, and the local data it removed was dropped: {}.",
              some(&schema.losses)
            );
            out.push(record(Level::Info, "local.schema.applied", id, &message, Some(schema.losses.join("\n"))));
          }
          "applied" | "unchanged" if seen.schema_open => {
            seen.schema_open = false;
            let message = "The local database matches the data model again.";
            out.push(record(Level::Info, "local.schema.applied", id, message, None));
          }
          _ => {}
        }
      }
    }

    if let Some(functions) = &status.functions {
      let key = format!("{}\n{:?}\n{:?}", functions.state, functions.time, functions.errors);
      if fresh(&mut seen.functions, key) {
        match functions.state.as_str() {
          "failed" => {
            seen.functions_open = true;
            let message = format!(
              "The app's functions didn't build, so calling them fails until a build succeeds: {}",
              if functions.errors.is_empty() { "no errors listed".to_string() } else { some(&functions.errors) }
            );
            out.push(record(Level::Error, "local.functions.failed", id, &message, Some(functions.errors.join("\n"))));
          }
          "ready" if seen.functions_open => {
            seen.functions_open = false;
            out.push(record(Level::Info, "local.functions.built", id, "The app's functions built again.", None));
          }
          _ => {}
        }
      }
    }

    if let Some(analysis) = &status.analysis {
      let key = format!("{}\n{:?}\n{:?}", analysis.ok, analysis.time, analysis.message);
      if fresh(&mut seen.analysis, key) {
        if !analysis.ok && running {
          seen.analysis_open = true;
          let message = format!(
            "The app's data model couldn't be read, so the previous one stays in use: {}",
            analysis.message.as_deref().unwrap_or("no reason given").trim()
          );
          out.push(record(Level::Error, "local.analysis.failed", id, &message, None));
        } else if analysis.ok && seen.analysis_open {
          seen.analysis_open = false;
          out.push(record(Level::Info, "local.analysis.ok", id, "The app's data model can be read again.", None));
        }
      }
    }

    if let Some(vite) = &status.vite {
      let key = format!("{}\n{:?}\n{:?}", vite.state, vite.time, vite.message);
      if fresh(&mut seen.vite, key) {
        match vite.state.as_str() {
          "failed" if running => {
            seen.vite_open = true;
            let message = format!(
              "The app's dev server (Vite) couldn't start, so the preview has nothing to show: {}",
              vite.message.as_deref().unwrap_or("no reason given").trim()
            );
            out.push(record(Level::Error, "local.vite.failed", id, &message, None));
          }
          "ready" if seen.vite_open => {
            seen.vite_open = false;
            out.push(record(Level::Info, "local.vite.ready", id, "The app's dev server (Vite) is running again.", None));
          }
          _ => {}
        }
      }
    }

    out
  }
}

/// Journal what each project's local backend reports, from now on.
pub fn watch(app: &AppHandle) {
  let journal = Mutex::new(LocalJournal::default());
  app.listen_any(LOCAL_STATE, move |event| {
    let Ok(status) = serde_json::from_str::<LocalStatus>(event.payload()) else {
      return;
    };
    let entries = match journal.lock() {
      Ok(mut journal) => journal.observe(&status),
      Err(_) => return,
    };
    for entry in entries {
      entry.write();
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::{LocalAnalysis, LocalFunctions, LocalSchema, LocalVite};

  struct Run {
    journal: LocalJournal,
    status: LocalStatus,
  }

  impl Run {
    fn new() -> Self {
      Self {
        journal: LocalJournal::default(),
        status: LocalStatus { project_id: "p".into(), state: State::Running, ..Default::default() },
      }
    }

    /// Change the status, as an event would, and return the events journaled.
    fn then(&mut self, change: impl FnOnce(&mut LocalStatus)) -> Vec<String> {
      change(&mut self.status);
      self.status.revision += 1;
      self.journal.observe(&self.status).into_iter().map(|e| e.event).collect()
    }
  }

  fn warning(code: &str, message: &str) -> LocalProblem {
    LocalProblem { code: code.into(), message: message.into(), ..Default::default() }
  }

  #[test]
  fn a_warning_is_journaled_once() {
    let mut run = Run::new();
    let events = run.then(|s| s.warnings.push(warning("azure-sign-in", "No Azure token could be had.")));
    assert_eq!(events, ["local.warning"]);
    assert!(run.then(|s| s.phase = None).is_empty(), "the same status again journals nothing");
    // A restart repeats the run's warnings; they were journaled already.
    assert!(run.then(|s| s.warnings = vec![warning("azure-sign-in", "No Azure token could be had.")]).is_empty());
    assert_eq!(run.then(|s| s.warnings.push(warning("secret-missing", "KEY has no value."))), ["local.warning"]);
  }

  #[test]
  fn the_entry_says_what_happened_without_secrets() {
    let mut journal = LocalJournal::default();
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let status = LocalStatus {
      project_id: "p".into(),
      revision: 1,
      state: State::Running,
      warnings: vec![LocalProblem {
        code: "connector-unsupported".into(),
        message: format!("The connector logs runs only on Fabric ({token})."),
        hint: Some("Publish the app to use it.".into()),
        details: Some(serde_json::json!({ "name": "logs", "type": "kusto" })),
        ..Default::default()
      }],
      ..Default::default()
    };
    let entries = journal.observe(&status);
    let entry = &entries[0];
    assert_eq!(entry.level, Level::Warn);
    assert_eq!(entry.project_id.as_deref(), Some("p"));
    assert!(entry.message.starts_with("The local backend warned (connector-unsupported): The connector logs runs only on Fabric"));
    assert!(entry.message.ends_with("Publish the app to use it."));
    assert!(entry.detail.as_deref().unwrap().contains("\"type\":\"kusto\""));
    assert!(!entry.message.contains(&token), "{}", entry.message);
  }

  #[test]
  fn fatal_problems_are_left_to_the_supervisor() {
    let mut run = Run::new();
    let events = run.then(|s| {
      s.state = State::Error;
      s.schema = Some(LocalSchema { result: "refused".into(), losses: vec!["Note.title".into()], ..Default::default() });
      s.error = Some(LocalProblem { code: "schema-refused".into(), message: "It would delete data.".into(), fatal: true, ..Default::default() });
    });
    assert!(events.is_empty(), "the supervisor journals local.failed for these: {events:?}");
  }

  #[test]
  fn an_unexpected_stop_is_a_warning_and_a_non_fatal_error_an_error() {
    let mut run = Run::new();
    let exited = run.then(|s| {
      s.state = State::Restarting;
      s.error = Some(LocalProblem { code: "exited".into(), message: "The local backend stopped unexpectedly.".into(), time: Some("t1".into()), ..Default::default() });
    });
    assert_eq!(exited, ["local.error"]);
    assert!(run.then(|s| s.phase = Some("starting".into())).is_empty());
    let vite = run.then(|s| {
      s.state = State::Running;
      s.error = Some(LocalProblem { code: "vite-failed".into(), message: "Vite exited.".into(), time: Some("t2".into()), ..Default::default() });
    });
    assert_eq!(vite, ["local.error"]);
  }

  #[test]
  fn a_refused_change_while_running_and_its_resolution() {
    let mut run = Run::new();
    let refused = run.then(|s| {
      s.schema = Some(LocalSchema { result: "refused".into(), losses: vec!["Note.title (12 values)".into()], live: true, time: Some("t1".into()), ..Default::default() });
    });
    assert_eq!(refused, ["local.schema.refused"]);
    assert!(run.then(|s| s.phase = None).is_empty());
    let applied = run.then(|s| {
      s.schema = Some(LocalSchema { result: "applied".into(), losses: vec!["Note.title (12 values)".into()], live: true, time: Some("t2".into()), ..Default::default() });
    });
    assert_eq!(applied, ["local.schema.applied"]);
    // Kept as it was, then put back: that resolves it too.
    run.then(|s| s.schema = Some(LocalSchema { result: "refused".into(), losses: vec!["Tag".into()], live: true, time: Some("t3".into()), ..Default::default() }));
    let unchanged = run.then(|s| s.schema = Some(LocalSchema { result: "unchanged".into(), live: true, time: Some("t4".into()), ..Default::default() }));
    assert_eq!(unchanged, ["local.schema.applied"]);
    assert!(run.then(|s| s.schema = Some(LocalSchema { result: "unchanged".into(), live: true, time: Some("t5".into()), ..Default::default() })).is_empty(), "nothing was open");
  }

  #[test]
  fn a_failed_build_is_journaled_until_one_succeeds() {
    let mut run = Run::new();
    assert!(run.then(|s| s.functions = Some(LocalFunctions { state: "ready".into(), ..Default::default() })).is_empty());
    let failed = run.then(|s| {
      s.warnings.push(warning("functions-build-failed", "The functions' build failed."));
      s.functions = Some(LocalFunctions { state: "failed".into(), errors: vec!["TS2304".into()], time: Some("t1".into()), ..Default::default() });
    });
    assert_eq!(failed, ["local.functions.failed"], "the warning is the same news");
    assert!(run.then(|s| s.functions = Some(LocalFunctions { state: "building".into(), time: Some("t2".into()), ..Default::default() })).is_empty());
    let built = run.then(|s| s.functions = Some(LocalFunctions { state: "ready".into(), time: Some("t3".into()), ..Default::default() }));
    assert_eq!(built, ["local.functions.built"]);
  }

  #[test]
  fn the_model_and_the_dev_server_failing_while_running() {
    let mut run = Run::new();
    let failed = run.then(|s| {
      s.analysis = Some(LocalAnalysis { ok: false, message: Some("rayfin/data/Note.ts(4,3): error".into()), time: Some("t1".into()), ..Default::default() });
      s.vite = Some(LocalVite { state: "failed".into(), message: Some("Port 5173 is in use".into()), time: Some("t1".into()), ..Default::default() });
    });
    assert_eq!(failed, ["local.analysis.failed", "local.vite.failed"]);
    let fixed = run.then(|s| {
      s.analysis = Some(LocalAnalysis { ok: true, time: Some("t2".into()), ..Default::default() });
      s.vite = Some(LocalVite { state: "ready".into(), time: Some("t2".into()), ..Default::default() });
    });
    assert_eq!(fixed, ["local.analysis.ok", "local.vite.ready"]);
  }

  #[test]
  fn an_older_status_is_ignored() {
    let mut journal = LocalJournal::default();
    let mut status = LocalStatus { project_id: "p".into(), revision: 5, state: State::Running, ..Default::default() };
    journal.observe(&status);
    status.revision = 4;
    status.warnings.push(warning("anonymous-role", "Entities grant anonymous."));
    assert!(journal.observe(&status).is_empty());
    // Each project is followed on its own.
    status.project_id = "q".into();
    assert_eq!(journal.observe(&status).len(), 1);
  }

  #[test]
  fn a_backend_started_again_from_scratch_is_still_followed() {
    let mut journal = LocalJournal::default();
    let at = |time: &str| Some(format!("2026-10-30T03:{time}Z"));
    let mut status =
      LocalStatus { project_id: "p".into(), revision: 40, state: State::Running, updated_at: at("10:00.000"), ..Default::default() };
    journal.observe(&status);
    // A late status from before is still ignored…
    status.revision = 39;
    status.updated_at = at("09:59.900");
    status.warnings.push(warning("anonymous-role", "Entities grant anonymous."));
    assert!(journal.observe(&status).is_empty());
    // …but a new supervisor counts from zero again, later on.
    status.revision = 2;
    status.updated_at = at("12:00.000");
    assert_eq!(journal.observe(&status).len(), 1);
  }
}
