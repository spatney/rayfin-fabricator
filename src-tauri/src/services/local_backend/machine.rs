//! The status of one project's local backend, built from rayfin-local's
//! events and from what the supervisor sees (spawned, exited, failed). No
//! processes and no I/O here, so every transition is unit-tested.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use super::events::Event;
use crate::types::{LocalBackendState as State, LocalProblem, LocalStartOptions, LocalStatus};

/// Most warnings kept per run; the oldest go first.
const MAX_WARNINGS: usize = 50;

/// What an event asks of the supervisor.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Outcome {
  /// The status changed: tell the renderer.
  pub changed: bool,
  /// A configuration change can't be applied while running: restart.
  pub restart: bool,
  /// A fatal error: rayfin-local stops by itself.
  pub fatal: bool,
  /// The run's first `ready`.
  pub ready: bool,
}

/// Why a run's process ended, as far as the supervisor knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
  /// Fabricator stopped it.
  Stopped,
  /// Fabricator is restarting it (a restart request or a configuration change).
  Restart,
  /// It exited by itself.
  Exited,
}

/// What follows the end of a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
  Stop,
  /// Start it again after the delay.
  Restart(Duration),
  /// Stay in `error` until someone starts it.
  Fail,
}

/// Restarts after unexpected exits, waiting longer each time, and gives up
/// when the backend keeps crashing.
#[derive(Debug, Clone)]
pub struct CrashPolicy {
  /// The waits before the first, second and third restart within `window`.
  /// One more crash in the window gives up.
  pub backoff: Vec<Duration>,
  pub window: Duration,
}

impl Default for CrashPolicy {
  fn default() -> Self {
    Self {
      backoff: vec![Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(5)],
      window: Duration::from_secs(120),
    }
  }
}

impl CrashPolicy {
  /// Record a crash at `now` and return the wait before restarting, or `None`
  /// to give up. Crashes older than the window are forgotten.
  pub fn next(&self, crashes: &mut VecDeque<Instant>, now: Instant) -> Option<Duration> {
    while crashes.front().is_some_and(|at| now.saturating_duration_since(*at) > self.window) {
      crashes.pop_front();
    }
    crashes.push_back(now);
    self.backoff.get(crashes.len() - 1).copied()
  }
}

pub struct Machine {
  status: LocalStatus,
  crashes: VecDeque<Instant>,
  /// The current run's fatal error.
  fatal: Option<LocalProblem>,
  ready_seen: bool,
}

impl Machine {
  pub fn new(project_id: &str) -> Self {
    Self {
      status: LocalStatus { project_id: project_id.to_string(), ..Default::default() },
      crashes: VecDeque::new(),
      fatal: None,
      ready_seen: false,
    }
  }

  pub fn status(&self) -> &LocalStatus {
    &self.status
  }

  fn changed(&mut self) {
    self.status.revision += 1;
    self.status.updated_at = Some(crate::commands::util::now_iso());
  }

  /// A run is about to start. `fresh` for a start someone asked for, which
  /// forgets earlier errors and crashes; restarts keep them.
  pub fn begin(&mut self, options: &LocalStartOptions, fresh: bool) {
    let s = &mut self.status;
    s.state = State::Starting;
    s.phase = None;
    s.pid = None;
    s.version = None;
    s.ready = None;
    s.analysis = None;
    s.schema = None;
    s.functions = None;
    s.vite = None;
    s.config = None;
    s.warnings.clear();
    s.stopped = None;
    if options.sign_in_as.is_some() {
      s.sign_in_as = options.sign_in_as.clone();
    }
    if fresh {
      s.error = None;
      self.crashes.clear();
      s.crashes = 0;
    }
    s.started_at = Some(crate::commands::util::now_iso());
    self.fatal = None;
    self.ready_seen = false;
    self.changed();
  }

  pub fn spawned(&mut self, pid: Option<u32>) {
    self.status.pid = pid;
    self.changed();
  }

  /// The supervisor is stopping the process to start it again.
  pub fn restarting(&mut self) {
    if self.status.state != State::Restarting {
      self.status.state = State::Restarting;
      self.changed();
    }
  }

  /// Someone stopped a backend that wasn't running (say, one in `error`).
  pub fn stopped(&mut self) {
    if self.status.state != State::Stopped {
      self.status.state = State::Stopped;
      self.status.phase = None;
      self.changed();
    }
  }

  pub fn set_sign_in_as(&mut self, sign_in_as: Option<String>) {
    if self.status.sign_in_as != sign_in_as {
      self.status.sign_in_as = sign_in_as;
      self.changed();
    }
  }

  /// The backend can't start or keep running: `error` with `problem`.
  pub fn fail(&mut self, problem: LocalProblem) {
    let s = &mut self.status;
    s.state = State::Error;
    s.error = Some(problem);
    s.pid = None;
    s.phase = None;
    s.ready = None;
    self.changed();
  }

  pub fn apply(&mut self, event: &Event) -> Outcome {
    let mut outcome = Outcome { changed: true, ..Default::default() };
    let starting = self.status.state == State::Starting;
    let s = &mut self.status;
    let phase = |s: &mut LocalStatus, step: &str| {
      if starting {
        s.phase = Some(step.to_string());
      }
    };
    match event {
      Event::Starting(e) => {
        s.pid = e.pid.or(s.pid);
        s.version = e.version.clone();
        s.project_root = e.project.as_ref().map(|p| p.root.clone()).or(s.project_root.take());
        phase(s, "starting");
      }
      Event::Analysis(a) => {
        s.analysis = Some(a.clone());
        phase(s, "analysis");
      }
      Event::Schema(x) => {
        s.schema = Some(x.clone());
        phase(s, "schema");
      }
      Event::Functions(x) => {
        s.functions = Some(x.clone());
        phase(s, "functions");
      }
      Event::Vite(x) => {
        s.vite = Some(x.clone());
        phase(s, "vite");
      }
      Event::Ready(ready) => {
        s.ready = Some(ready.clone());
        if self.fatal.is_none() && matches!(s.state, State::Starting | State::Running) {
          s.state = State::Running;
          s.phase = None;
          s.error = None;
        }
        outcome.ready = !self.ready_seen;
        self.ready_seen = true;
      }
      Event::ConfigChanged(config) => {
        s.config = Some(config.clone());
        outcome.restart = config.restart_required;
      }
      Event::Warning(problem) => {
        s.warnings.retain(|w| !(w.code == problem.code && w.message == problem.message));
        s.warnings.push(problem.clone());
        if s.warnings.len() > MAX_WARNINGS {
          s.warnings.remove(0);
        }
      }
      Event::Error(problem) => {
        s.error = Some(problem.clone());
        if problem.fatal {
          self.fatal = Some(problem.clone());
          s.state = State::Error;
          s.phase = None;
          outcome.fatal = true;
        }
      }
      Event::Stopped(stopped) => s.stopped = Some(stopped.clone()),
      Event::Log(_) | Event::Unknown => outcome.changed = false,
    }
    if outcome.changed {
      self.changed();
    }
    outcome
  }

  /// The run's process ended: decide what follows. `tail` is its last output,
  /// kept with a crash to show why.
  pub fn ended(&mut self, ending: Ending, exit_code: Option<i32>, policy: &CrashPolicy, now: Instant, tail: &[String]) -> Next {
    let signalled = self.status.stopped.as_ref().is_some_and(|s| s.reason == "signal");
    let s = &mut self.status;
    s.pid = None;
    s.phase = None;
    s.ready = None;
    let next = match ending {
      Ending::Stopped => {
        s.state = State::Stopped;
        Next::Stop
      }
      Ending::Restart => {
        s.state = State::Restarting;
        Next::Restart(Duration::ZERO)
      }
      Ending::Exited => match self.fatal.clone() {
        Some(problem) => {
          s.state = State::Error;
          s.error = Some(problem);
          Next::Fail
        }
        // Stopped from outside Fabricator (a signal), on purpose: leave it stopped.
        None if signalled => {
          s.state = State::Stopped;
          Next::Stop
        }
        None => {
          let details = serde_json::json!({ "exitCode": exit_code, "lines": tail });
          let code = exit_code.map(|c| format!(" (exit code {c})")).unwrap_or_default();
          match policy.next(&mut self.crashes, now) {
            Some(delay) => {
              s.state = State::Restarting;
              s.error = Some(LocalProblem {
                code: "exited".into(),
                message: format!("The local backend stopped unexpectedly{code}. Starting it again…"),
                details: Some(details),
                time: Some(crate::commands::util::now_iso()),
                ..Default::default()
              });
              Next::Restart(delay)
            }
            None => {
              s.state = State::Error;
              s.error = Some(LocalProblem {
                code: "crashed".into(),
                message: format!(
                  "The local backend stopped unexpectedly {} times in {} minutes{code}, so Fabricator stopped restarting it.",
                  self.crashes.len(),
                  policy.window.as_secs().div_ceil(60),
                ),
                hint: Some("Check its output for the cause, then start it again.".into()),
                fatal: true,
                details: Some(details),
                time: Some(crate::commands::util::now_iso()),
              });
              Next::Fail
            }
          }
        }
      },
    };
    s.crashes = self.crashes.len() as u32;
    self.changed();
    next
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::services::local_backend::events::parse;

  fn event(json: &str) -> Event {
    parse(json).unwrap()
  }

  fn started() -> Machine {
    let mut machine = Machine::new("p");
    machine.begin(&LocalStartOptions::default(), true);
    machine.spawned(Some(42));
    machine
  }

  const READY: &str = r#"{"v":1,"type":"ready","appUrl":"http://localhost:5173/","apiUrl":"http://localhost:7171"}"#;

  #[test]
  fn startup_steps_then_ready_mean_running() {
    let mut machine = started();
    assert_eq!(machine.status().state, State::Starting);
    let revision = machine.status().revision;
    machine.apply(&event(r#"{"v":1,"type":"starting","pid":42,"version":"0.2.0","project":{"root":"C:\\p","name":"p"}}"#));
    machine.apply(&event(r#"{"v":1,"type":"analysis","ok":true,"entities":["Note"]}"#));
    machine.apply(&event(r#"{"v":1,"type":"schema","result":"unchanged"}"#));
    assert_eq!(machine.status().phase.as_deref(), Some("schema"));
    assert!(machine.status().revision > revision);
    let outcome = machine.apply(&event(READY));
    assert!(outcome.ready && outcome.changed && !outcome.restart);
    let status = machine.status();
    assert_eq!(status.state, State::Running);
    assert_eq!(status.phase, None);
    assert_eq!(status.version.as_deref(), Some("0.2.0"));
    assert_eq!(status.project_root.as_deref(), Some(r"C:\p"));
    assert_eq!(status.ready.as_ref().unwrap().api_url, "http://localhost:7171");
    // A later ready (a live config change) isn't the first one.
    assert!(!machine.apply(&event(READY)).ready);
    // Logs don't change the status.
    assert!(!machine.apply(&event(r#"{"v":1,"type":"log","source":"vite","level":"info","line":"x"}"#)).changed);
  }

  #[test]
  fn a_fatal_error_fails_without_a_restart() {
    let mut machine = started();
    let outcome = machine.apply(&event(crate::services::local_backend::events::tests::FATAL));
    assert!(outcome.fatal);
    assert_eq!(machine.status().state, State::Error);
    machine.apply(&event(r#"{"v":1,"type":"stopped","reason":"error","exitCode":1}"#));
    let next = machine.ended(Ending::Exited, Some(1), &CrashPolicy::default(), Instant::now(), &[]);
    assert_eq!(next, Next::Fail);
    let status = machine.status();
    assert_eq!(status.state, State::Error);
    assert_eq!(status.error.as_ref().unwrap().code, "schema-refused");
    assert_eq!(status.crashes, 0);
  }

  #[test]
  fn non_fatal_errors_and_warnings_keep_it_running() {
    let mut machine = started();
    machine.apply(&event(READY));
    machine.apply(&event(r#"{"v":1,"type":"error","code":"vite-failed","message":"Vite exited.","fatal":false}"#));
    machine.apply(&event(r#"{"v":1,"type":"warning","code":"secret-missing","message":"KEY has no value.","details":{"name":"KEY"}}"#));
    machine.apply(&event(r#"{"v":1,"type":"warning","code":"secret-missing","message":"KEY has no value.","details":{"name":"KEY"}}"#));
    let status = machine.status();
    assert_eq!(status.state, State::Running);
    assert_eq!(status.error.as_ref().unwrap().code, "vite-failed");
    assert_eq!(status.warnings.len(), 1, "a repeated warning is kept once");
  }

  #[test]
  fn crashes_restart_with_backoff_then_give_up() {
    let policy = CrashPolicy::default();
    let mut machine = started();
    let start = Instant::now();
    let mut waits = Vec::new();
    for i in 0..3u64 {
      machine.apply(&event(READY));
      let next = machine.ended(Ending::Exited, Some(3), &policy, start + Duration::from_secs(i * 10), &["boom".into()]);
      assert_eq!(machine.status().state, State::Restarting);
      assert_eq!(machine.status().error.as_ref().unwrap().code, "exited");
      assert_eq!(machine.status().ready, None, "the old URLs are gone");
      let Next::Restart(wait) = next else { panic!("restart {i}") };
      waits.push(wait.as_secs());
      machine.begin(&LocalStartOptions::default(), false);
      assert_eq!(machine.status().error.as_ref().unwrap().code, "exited", "a restart keeps the last error");
    }
    assert_eq!(waits, [1, 2, 5]);
    let next = machine.ended(Ending::Exited, Some(3), &policy, start + Duration::from_secs(40), &["boom".into()]);
    assert_eq!(next, Next::Fail);
    let status = machine.status();
    assert_eq!(status.state, State::Error);
    let error = status.error.as_ref().unwrap();
    assert_eq!(error.code, "crashed");
    assert_eq!(error.details.as_ref().unwrap()["lines"][0], "boom");
    assert_eq!(status.crashes, 4);
    // Ready clears the error, and a fresh start forgets the crashes.
    machine.begin(&LocalStartOptions::default(), true);
    assert_eq!((machine.status().error.clone(), machine.status().crashes), (None, 0));
  }

  #[test]
  fn crashes_outside_the_window_are_forgotten() {
    let policy = CrashPolicy::default();
    let mut crashes = VecDeque::new();
    let start = Instant::now();
    assert_eq!(policy.next(&mut crashes, start), Some(Duration::from_secs(1)));
    assert_eq!(policy.next(&mut crashes, start + Duration::from_secs(60)), Some(Duration::from_secs(2)));
    // The first crash is out of the window by now; the second isn't.
    assert_eq!(policy.next(&mut crashes, start + Duration::from_secs(150)), Some(Duration::from_secs(2)));
    assert_eq!(crashes.len(), 2);
  }

  #[test]
  fn config_changes_that_need_a_restart_ask_for_one() {
    let mut machine = started();
    machine.apply(&event(READY));
    let applied = machine.apply(&event(r#"{"v":1,"type":"config-changed","applied":true,"restartRequired":false,"what":["services"]}"#));
    assert!(!applied.restart);
    let outcome = machine.apply(&event(r#"{"v":1,"type":"config-changed","applied":false,"restartRequired":true,"what":["frontend"],"message":"The frontend moved."}"#));
    assert!(outcome.restart);
    machine.restarting();
    assert_eq!(machine.status().state, State::Restarting);
    assert_eq!(machine.ended(Ending::Restart, Some(0), &CrashPolicy::default(), Instant::now(), &[]), Next::Restart(Duration::ZERO));
    assert_eq!(machine.status().crashes, 0, "a requested restart isn't a crash");
  }

  #[test]
  fn requested_and_signalled_stops_stay_stopped() {
    let mut machine = started();
    machine.apply(&event(READY));
    assert_eq!(machine.ended(Ending::Stopped, Some(0), &CrashPolicy::default(), Instant::now(), &[]), Next::Stop);
    assert_eq!(machine.status().state, State::Stopped);

    let mut machine = started();
    machine.apply(&event(r#"{"v":1,"type":"stopped","reason":"signal","exitCode":0}"#));
    assert_eq!(machine.ended(Ending::Exited, Some(0), &CrashPolicy::default(), Instant::now(), &[]), Next::Stop);
  }

  #[test]
  fn sign_in_identity_carries_over_runs() {
    let mut machine = Machine::new("p");
    machine.begin(&LocalStartOptions { sign_in_as: Some("user:ana@example.com".into()), ..Default::default() }, true);
    machine.begin(&LocalStartOptions::default(), false);
    assert_eq!(machine.status().sign_in_as.as_deref(), Some("user:ana@example.com"));
    machine.set_sign_in_as(Some("none".into()));
    assert_eq!(machine.status().sign_in_as.as_deref(), Some("none"));
  }
}
