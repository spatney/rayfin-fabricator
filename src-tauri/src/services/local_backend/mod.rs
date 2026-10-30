//! The local backend: each personal project's whole Rayfin backend (data API
//! with policies, auth with a local Fabric sign-in page, functions,
//! connectors, storage) plus the app's own Vite, run on this computer by the
//! bundled **rayfin-local** (`serve --json`, host contract 1, see
//! rayfin-local's `docs/embedding.md`).
//!
//! [`LocalBackends`] (Tauri managed state) supervises one `serve` per project:
//! it builds a status from the process's events and emits it on `local:state`,
//! streams its output on `local:log` (and keeps it in a ring and a rolling file
//! under the logs folder, credentials masked), restarts it after a crash or a
//! configuration change that needs one, and stops it by closing its stdin. At
//! most two projects run at once: the one in use and the previous one. Every
//! run gets a fresh control token, which never appears in a log.
//!
//! Other modules use [`snapshot`], [`recent_logs`] and [`control`]; the IPC is
//! `commands::local`. The output files are named by [`log_files`].

mod binary;
mod control;
mod events;
mod logs;
mod machine;
mod process;
mod supervisor;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Emitter, Manager};
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, oneshot};

// The API other modules build on (agent tools, Help, diagnostics); some of it has no caller yet.
#[allow(unused_imports)]
pub use binary::{doctor_status, Binary, VersionInfo, BIN_ENV, BLOCKED_DOCS_URL};
#[allow(unused_imports)]
pub use control::{error, AccessToken, AppCall, AppResponse, CallAs, ControlClient, ControlToken, MAX_ROWS};
use logs::{LogFile, LogRing};
pub use logs::{log_files, LOG_DIR};
use machine::{CrashPolicy, Machine, Next, Outcome};
use supervisor::{Command, HostEnv, Stream, Supervisor};

use crate::services::journal::{self, Area, Level};
use crate::services::store;
use crate::types::{LocalCommandError, LocalIdentity, LocalLogEvent, LocalProblem, LocalSecret, LocalStartOptions, LocalStatus};
use crate::types::LocalBackendState as State;

/// Tauri event with a project's full [`LocalStatus`] whenever it changes.
pub const LOCAL_STATE: &str = "local:state";
/// Tauri event with each [`LocalLogEvent`] of a project's output.
pub const LOCAL_LOG: &str = "local:log";
/// Lines [`recent_logs`] returns when the caller doesn't say.
pub const DEFAULT_LOG_LINES: usize = 500;
/// Timeout of the `secret` commands.
const CLI_TIMEOUT: Duration = Duration::from_secs(30);

/// What the supervisors tell the rest of the app.
pub(crate) enum Emit {
  State(LocalStatus),
  Log(LocalLogEvent),
  /// A line for the activity journal Help reads, with the problem's code when it's a failure.
  Milestone { level: Level, event: &'static str, message: String, project_id: String, code: Option<String> },
}

pub(crate) type Sink = Arc<dyn Fn(Emit) + Send + Sync>;
type SinkCell = Arc<RwLock<Option<Sink>>>;

/// Timing and limits.
#[derive(Clone, Debug)]
pub(crate) struct Policy {
  /// How long a stopping backend gets after its stdin closes before it's killed.
  pub stop_grace: Duration,
  /// The same after a fatal error, when it stops by itself.
  pub fatal_grace: Duration,
  /// How long the backends get to stop when Fabricator exits.
  pub exit_grace: Duration,
  pub crash: CrashPolicy,
  /// Projects running at once.
  pub max_running: usize,
}

impl Default for Policy {
  fn default() -> Self {
    Self {
      stop_grace: Duration::from_secs(8),
      fatal_grace: Duration::from_secs(10),
      exit_grace: Duration::from_secs(3),
      crash: CrashPolicy::default(),
      max_running: 2,
    }
  }
}

pub(crate) struct Settings {
  /// `None`: the bundled rayfin-local (or [`BIN_ENV`]).
  pub binary: Option<Binary>,
  /// `None`: [`LOG_DIR`] under Fabricator's logs folder.
  pub log_dir: Option<PathBuf>,
  pub policy: Policy,
  /// Pass Fabricator's `PATH`, Node.js and Fabric account to rayfin-local.
  pub host_env: bool,
}

impl Default for Settings {
  fn default() -> Self {
    Self { binary: None, log_dir: None, policy: Policy::default(), host_env: true }
  }
}

/// The live supervisor of a project.
struct Run {
  generation: u64,
  commands: mpsc::UnboundedSender<Command>,
  /// Held open while the backend should run: closing it is the stop signal.
  stdin: Option<ChildStdin>,
  pid: Option<u32>,
  token: Option<ControlToken>,
}

/// One project's local backend: status, output and live supervisor.
pub(crate) struct Runtime {
  id: String,
  machine: Mutex<Machine>,
  ring: Mutex<(LogRing, u64)>,
  file: Mutex<Option<LogFile>>,
  run: Mutex<Option<Run>>,
  last_used: Mutex<Instant>,
  /// Serializes start, restart and stop.
  lifecycle: tokio::sync::Mutex<()>,
  sink: SinkCell,
}

impl Runtime {
  fn new(id: &str, log_dir: Option<&Path>, sink: SinkCell) -> Self {
    Self {
      id: id.to_string(),
      machine: Mutex::new(Machine::new(id)),
      ring: Mutex::new((LogRing::new(logs::RING_CAPACITY), 0)),
      file: Mutex::new(log_dir.map(|dir| LogFile::new(dir, id))),
      run: Mutex::new(None),
      last_used: Mutex::new(Instant::now()),
      lifecycle: tokio::sync::Mutex::new(()),
      sink,
    }
  }

  fn emit(&self, emit: Emit) {
    let sink = self.sink.read().unwrap().clone();
    if let Some(sink) = sink {
      sink(emit);
    }
  }

  fn snapshot(&self) -> LocalStatus {
    self.machine.lock().unwrap().status().clone()
  }

  /// Change the status, and tell the renderer when it did change.
  fn update<R>(&self, f: impl FnOnce(&mut Machine) -> R) -> R {
    let (result, changed) = {
      let mut machine = self.machine.lock().unwrap();
      let before = machine.status().revision;
      let result = f(&mut machine);
      (result, (machine.status().revision != before).then(|| machine.status().clone()))
    };
    if let Some(status) = changed {
      self.emit(Emit::State(status));
    }
    result
  }

  fn milestone(&self, level: Level, event: &'static str, message: String, code: Option<&str>) {
    self.emit(Emit::Milestone { level, event, message, project_id: self.id.clone(), code: code.map(str::to_string) });
  }

  /// Record one line of output, credentials masked (see [`logs::sanitize`]).
  fn log(&self, source: &str, level: &str, line: &str, time: Option<String>) {
    let event = {
      let mut ring = self.ring.lock().unwrap();
      ring.1 += 1;
      let event = LocalLogEvent {
        project_id: self.id.clone(),
        seq: ring.1,
        source: source.to_string(),
        level: level.to_string(),
        line: logs::sanitize(line),
        time: time.filter(|t| t.contains('T')).unwrap_or_else(crate::commands::util::now_iso),
      };
      ring.0.push(event.clone());
      event
    };
    if let Some(file) = self.file.lock().unwrap().as_mut() {
      file.append(&event);
    }
    self.emit(Emit::Log(event));
  }

  fn recent(&self, n: usize) -> Vec<LocalLogEvent> {
    self.ring.lock().unwrap().0.recent(n)
  }

  fn tail(&self, n: usize) -> Vec<String> {
    self.ring.lock().unwrap().0.tail(n)
  }

  /// One line of the process's stdout (events) or stderr.
  fn handle_line(&self, stream: Stream, raw: &str, token: &ControlToken) -> Outcome {
    let text = logs::redact(raw, token.expose());
    if text.trim().is_empty() {
      return Outcome::default();
    }
    if stream == Stream::Stderr {
      self.log("stderr", "warn", &text, None);
      return Outcome::default();
    }
    match events::parse(&text) {
      Ok(events::Event::Log(line)) => {
        let source = if line.source.is_empty() { "rayfin-local" } else { &line.source };
        let level = if line.level.is_empty() { "info" } else { &line.level };
        self.log(source, level, &line.line, line.time);
        Outcome::default()
      }
      Ok(event) => {
        let outcome = self.update(|m| m.apply(&event));
        if let Some((level, line)) = events::describe(&event) {
          self.log("rayfin-local", level, &line, None);
        }
        if outcome.ready {
          let status = self.snapshot();
          let at = status.ready.as_ref().map(|r| r.app_url.clone().unwrap_or_else(|| r.api_url.clone())).unwrap_or_default();
          self.milestone(Level::Info, "local.started", format!("The local backend is running at {at}"), None);
        }
        if outcome.fatal {
          if let events::Event::Error(problem) = &event {
            self.milestone(
              Level::Error,
              "local.failed",
              format!("The local backend stopped ({}): {}", problem.code, problem.message),
              Some(&problem.code),
            );
          }
        }
        outcome
      }
      Err(_) => {
        self.log("stdout", "info", &text, None);
        Outcome::default()
      }
    }
  }

  /// The backend can't start or keep running.
  fn fail(&self, problem: LocalProblem) {
    self.log("fabricator", "error", &match &problem.hint {
      Some(hint) => format!("{} {hint}", problem.message),
      None => problem.message.clone(),
    }, None);
    self.milestone(
      Level::Error,
      "local.failed",
      format!("The local backend didn't start ({}): {}", problem.code, problem.message),
      Some(&problem.code),
    );
    self.update(|m| m.fail(problem));
  }

  /// Say what follows the end of a run.
  fn after_run(&self, next: Next, exit_code: Option<i32>) {
    let status = self.snapshot();
    match next {
      Next::Restart(delay) if status.error.as_ref().is_some_and(|e| e.code == "exited") => {
        let code = exit_code.map(|c| format!(" (exit code {c})")).unwrap_or_default();
        self.log("fabricator", "warn", &format!("The local backend stopped unexpectedly{code}. Starting it again in {} s.", delay.as_secs_f32()), None);
      }
      Next::Fail if status.error.as_ref().is_some_and(|e| e.code == "crashed") => {
        let message = status.error.map(|e| e.message).unwrap_or_default();
        self.log("fabricator", "error", &message, None);
        self.milestone(Level::Error, "local.crashed", message, Some("crashed"));
      }
      Next::Stop => self.log("fabricator", "info", "The local backend stopped.", None),
      _ => {}
    }
  }

  fn touch(&self) {
    *self.last_used.lock().unwrap() = Instant::now();
  }

  fn last_used(&self) -> Instant {
    *self.last_used.lock().unwrap()
  }

  fn is_live(&self) -> bool {
    self.run.lock().unwrap().is_some()
  }

  fn commands(&self) -> Option<mpsc::UnboundedSender<Command>> {
    self.run.lock().unwrap().as_ref().map(|run| run.commands.clone())
  }

  fn pid(&self) -> Option<u32> {
    self.run.lock().unwrap().as_ref().and_then(|run| run.pid)
  }

  fn token(&self) -> Option<ControlToken> {
    self.run.lock().unwrap().as_ref().and_then(|run| run.token.clone())
  }

  fn sign_in_as(&self) -> Option<String> {
    self.machine.lock().unwrap().status().sign_in_as.clone()
  }

  /// The options a restart Fabricator decides on uses: the sign-in identity only.
  fn sticky_options(&self) -> LocalStartOptions {
    LocalStartOptions { sign_in_as: self.sign_in_as(), ..Default::default() }
  }

  /// `options`, keeping the remembered sign-in identity unless they name one.
  fn with_sticky(&self, options: LocalStartOptions) -> LocalStartOptions {
    LocalStartOptions { sign_in_as: options.sign_in_as.clone().or_else(|| self.sign_in_as()), ..options }
  }

  fn with_run<R>(&self, generation: u64, f: impl FnOnce(&mut Run) -> R) -> Option<R> {
    self.run.lock().unwrap().as_mut().filter(|run| run.generation == generation).map(f)
  }

  fn attach(&self, generation: u64, pid: Option<u32>, stdin: Option<ChildStdin>, token: ControlToken) {
    self.with_run(generation, |run| {
      run.pid = pid;
      run.stdin = stdin;
      run.token = Some(token);
    });
  }

  fn close_stdin(&self, generation: u64) {
    self.with_run(generation, |run| run.stdin = None);
  }

  fn detach(&self, generation: u64) {
    self.with_run(generation, |run| {
      run.stdin = None;
      run.pid = None;
      run.token = None;
    });
  }

  fn finish(&self, generation: u64) {
    let mut run = self.run.lock().unwrap();
    if run.as_ref().is_some_and(|r| r.generation == generation) {
      *run = None;
    }
  }

  /// Close the stdin of the live process, if any; returns its pid.
  fn close_now(&self) -> Option<u32> {
    let mut run = self.run.lock().unwrap();
    let run = run.as_mut()?;
    run.stdin = None;
    run.pid
  }
}

struct Inner {
  settings: Settings,
  runtimes: Mutex<HashMap<String, Arc<Runtime>>>,
  sink: SinkCell,
  /// Fabricator is exiting: nothing restarts.
  closing: AtomicBool,
  generation: AtomicU64,
  /// The last binary that passed the contract check, and its file's stamp.
  probed: Mutex<Option<(Binary, Option<(SystemTime, u64)>)>>,
}

/// Every project's local backend (Tauri managed state).
#[derive(Clone)]
pub struct LocalBackends {
  inner: Arc<Inner>,
}

impl Default for LocalBackends {
  fn default() -> Self {
    Self::new(Settings::default())
  }
}

impl LocalBackends {
  pub(crate) fn new(settings: Settings) -> Self {
    Self {
      inner: Arc::new(Inner {
        settings,
        runtimes: Mutex::new(HashMap::new()),
        sink: Arc::new(RwLock::new(None)),
        closing: AtomicBool::new(false),
        generation: AtomicU64::new(0),
        probed: Mutex::new(None),
      }),
    }
  }

  #[cfg(test)]
  pub(crate) fn set_sink(&self, sink: Sink) {
    *self.inner.sink.write().unwrap() = Some(sink);
  }

  /// Send state and output to the renderer, and milestones to the activity
  /// journal and telemetry (started, or failed with the problem's code).
  pub fn attach_app(&self, app: &AppHandle) {
    if self.inner.sink.read().unwrap().is_some() {
      return;
    }
    let app = app.clone();
    let sink: Sink = Arc::new(move |emit| match emit {
      Emit::State(status) => {
        let _ = app.emit(LOCAL_STATE, status);
      }
      Emit::Log(line) => {
        let _ = app.emit(LOCAL_LOG, line);
      }
      Emit::Milestone { level, event, message, project_id, code } => {
        let outcome = match event {
          "local.started" => Some("started"),
          "local.failed" | "local.crashed" => Some("failed"),
          _ => None,
        };
        if let Some(outcome) = outcome {
          crate::services::telemetry::track_local(crate::commands::auth::get_cached_identity().as_ref(), outcome, code.as_deref());
        }
        let mut entry = journal::entry(level, Area::Preview, event, &message)
          .operation("local_backend")
          .detail(code.map(|code| format!("code: {code}")))
          .project(Some(project_id));
        if level != Level::Info {
          entry = entry.surface(journal::Surface::Backend);
        }
        entry.write();
      }
    });
    let mut slot = self.inner.sink.write().unwrap();
    if slot.is_none() {
      *slot = Some(sink);
    }
  }

  fn policy(&self) -> &Policy {
    &self.inner.settings.policy
  }

  fn closing(&self) -> bool {
    self.inner.closing.load(Ordering::SeqCst)
  }

  fn host_env(&self) -> HostEnv {
    if self.inner.settings.host_env { HostEnv::current() } else { HostEnv::default() }
  }

  fn runtime(&self, project_id: &str) -> Arc<Runtime> {
    let mut runtimes = self.inner.runtimes.lock().unwrap();
    runtimes
      .entry(project_id.to_string())
      .or_insert_with(|| {
        let dir = self.inner.settings.log_dir.clone().unwrap_or_else(|| crate::services::paths::logs_dir().join(LOG_DIR));
        Arc::new(Runtime::new(project_id, Some(&dir), self.inner.sink.clone()))
      })
      .clone()
  }

  fn existing(&self, project_id: &str) -> Option<Arc<Runtime>> {
    self.inner.runtimes.lock().unwrap().get(project_id).cloned()
  }

  fn all(&self) -> Vec<Arc<Runtime>> {
    self.inner.runtimes.lock().unwrap().values().cloned().collect()
  }

  /// rayfin-local, checked once against the contract (again when its file changes).
  pub async fn binary(&self) -> Result<Binary, LocalProblem> {
    let binary = match &self.inner.settings.binary {
      Some(binary) => binary.clone(),
      None => binary::locate()?,
    };
    let stamp = std::fs::metadata(binary.file()).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
    if self.inner.probed.lock().unwrap().as_ref().is_some_and(|(known, known_stamp)| *known == binary && *known_stamp == stamp) {
      return Ok(binary);
    }
    binary::probe(&binary).await?;
    *self.inner.probed.lock().unwrap() = Some((binary.clone(), stamp));
    Ok(binary)
  }

  /// The project's status (`stopped` for one never started).
  pub fn status(&self, project_id: &str) -> LocalStatus {
    match self.existing(project_id) {
      Some(rt) => rt.snapshot(),
      None => LocalStatus { project_id: project_id.to_string(), ..Default::default() },
    }
  }

  /// The project's last `limit` output lines, oldest first.
  pub fn logs(&self, project_id: &str, limit: usize) -> Vec<LocalLogEvent> {
    self.existing(project_id).map(|rt| rt.recent(limit.min(logs::RING_CAPACITY))).unwrap_or_default()
  }

  /// Start the project's backend in `dir` unless it already runs (then its
  /// status comes back as is). Problems show in the status, not as errors.
  pub async fn start(&self, project_id: &str, dir: PathBuf, options: LocalStartOptions) -> LocalStatus {
    let rt = self.runtime(project_id);
    let _lifecycle = rt.lifecycle.lock().await;
    rt.touch();
    if rt.is_live() || self.closing() {
      return rt.snapshot();
    }
    self.launch(&rt, dir, options).await
  }

  /// Stop the project's backend if it runs, and start it with `options`.
  pub async fn restart(&self, project_id: &str, dir: PathBuf, options: LocalStartOptions) -> LocalStatus {
    let rt = self.runtime(project_id);
    let _lifecycle = rt.lifecycle.lock().await;
    rt.touch();
    if self.closing() {
      return rt.snapshot();
    }
    let options = rt.with_sticky(options);
    if let Some(commands) = rt.commands() {
      let (done, finished) = oneshot::channel();
      if commands.send(Command::Restart { dir: dir.clone(), options: options.clone(), done }).is_ok() {
        let acknowledged = tokio::time::timeout(self.policy().stop_grace + Duration::from_secs(5), finished).await;
        if matches!(acknowledged, Ok(Ok(()))) || rt.is_live() {
          return rt.snapshot();
        }
      }
    }
    self.launch(&rt, dir, options).await
  }

  async fn launch(&self, rt: &Arc<Runtime>, dir: PathBuf, options: LocalStartOptions) -> LocalStatus {
    let options = rt.with_sticky(options);
    rt.update(|m| m.begin(&options, true));
    let binary = match self.binary().await {
      Ok(binary) => binary,
      Err(problem) => {
        rt.fail(problem);
        return rt.snapshot();
      }
    };
    self.evict(&rt.id);
    let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (commands, receiver) = mpsc::unbounded_channel();
    *rt.run.lock().unwrap() = Some(Run { generation, commands, stdin: None, pid: None, token: None });
    let supervisor = Supervisor { backends: self.clone(), rt: rt.clone(), generation, commands: receiver, dir, options, binary };
    tokio::spawn(supervisor.run());
    rt.snapshot()
  }

  /// Keep at most `max_running` backends: stop the least recently used others.
  fn evict(&self, keep: &str) {
    let max = self.policy().max_running.max(1);
    let mut live: Vec<Arc<Runtime>> = self.all().into_iter().filter(|rt| rt.id != keep && rt.is_live()).collect();
    if live.len() < max {
      return;
    }
    live.sort_by_key(|rt| rt.last_used());
    let excess = live.len() + 1 - max;
    for rt in live.into_iter().take(excess) {
      rt.log("fabricator", "info", &format!("Stopping this app's local backend: Fabricator keeps the {max} most recently used running."), None);
      let me = self.clone();
      tokio::spawn(async move {
        let _lifecycle = rt.lifecycle.lock().await;
        me.stop_runtime(&rt).await;
      });
    }
  }

  /// Stop the project's backend: close its stdin, wait, kill it if it must.
  pub async fn stop(&self, project_id: &str) -> LocalStatus {
    let Some(rt) = self.existing(project_id) else {
      return self.status(project_id);
    };
    let _lifecycle = rt.lifecycle.lock().await;
    self.stop_runtime(&rt).await;
    rt.snapshot()
  }

  async fn stop_runtime(&self, rt: &Runtime) {
    match rt.commands() {
      Some(commands) => {
        let (done, finished) = oneshot::channel();
        if commands.send(Command::Stop(Some(done))).is_ok() {
          let _ = tokio::time::timeout(self.policy().stop_grace + Duration::from_secs(5), finished).await;
        }
      }
      None => rt.update(|m| m.stopped()),
    }
  }

  /// Stop the project's backend and forget it, before the project goes away
  /// (its folder trashed, or removed from Fabricator's list). Its output file stays.
  pub async fn forget(&self, project_id: &str) {
    let Some(rt) = self.existing(project_id) else {
      return;
    };
    {
      let _lifecycle = rt.lifecycle.lock().await;
      self.stop_runtime(&rt).await;
    }
    let mut runtimes = self.inner.runtimes.lock().unwrap();
    if runtimes.get(project_id).is_some_and(|known| Arc::ptr_eq(known, &rt) && !known.is_live()) {
      runtimes.remove(project_id);
    }
  }

  /// Install the npm packages the project's backend reported missing
  /// (`packages-missing`): `npm install` in the folder it named, or, without
  /// one, what Fabricator installs when a project opens (the project's packages
  /// with its pinned Rayfin CLI, and the functions folder's). npm's output goes
  /// to the project's output.
  pub async fn install_packages(&self, project_id: &str, project: &Path) -> Result<(), LocalCommandError> {
    let rt = self.runtime(project_id);
    let output = install_output(rt.clone());
    let reported = rt
      .snapshot()
      .error
      .filter(|e| e.code == "packages-missing")
      .and_then(|e| e.details)
      .and_then(|details| details.get("dir").and_then(|dir| dir.as_str()).map(PathBuf::from))
      .and_then(|dir| folder_within(project, &dir));
    let result = match reported {
      Some(dir) => {
        rt.log("fabricator", "info", &format!("Installing the npm packages in {}…", dir.display()), None);
        npm_install(&dir, output).await
      }
      None => {
        rt.log("fabricator", "info", "Installing the app's npm packages…", None);
        match crate::services::exec::ensure_project_dependencies(project, Some(output.clone())).await {
          Ok(()) => crate::commands::projects_impl::ensure_functions_dependencies(project, Some(output)).await,
          Err(message) => Err(message),
        }
      }
    };
    match result {
      Ok(()) => {
        rt.log("fabricator", "info", "Installed the npm packages.", None);
        Ok(())
      }
      Err(message) => {
        rt.log("fabricator", "error", &message, None);
        Err(error("install-failed", message, Some("Check the output for npm's messages, then try again.")))
      }
    }
  }

  /// A client for the project's control API, while its backend runs.
  pub fn control(&self, project_id: &str) -> Result<ControlClient, LocalCommandError> {
    let Some(rt) = self.existing(project_id) else {
      return Err(not_running(&self.status(project_id)));
    };
    rt.touch();
    let status = rt.snapshot();
    let api_url = status.ready.as_ref().map(|r| r.api_url.clone()).filter(|url| !url.is_empty());
    match (status.state, api_url, rt.token()) {
      (State::Running, Some(url), Some(token)) => ControlClient::new(&url, token),
      _ => Err(not_running(&status)),
    }
  }

  /// Keep the sign-in identity set through the control API for later restarts.
  pub fn remember_sign_in(&self, project_id: &str, sign_in_as: Option<String>) {
    if let Some(rt) = self.existing(project_id) {
      rt.update(|m| m.set_sign_in_as(sign_in_as));
    }
  }

  /// The processes of every backend Fabricator runs.
  pub fn owned_pids(&self) -> Vec<u32> {
    self.all().iter().filter_map(|rt| rt.pid()).collect()
  }

  /// The ports other projects' backends serve their app and API on, with the
  /// project's id, so a live preview of a team or published app keeps off them.
  pub fn held_ports(&self, except: &str) -> Vec<(u16, String)> {
    let mut held = Vec::new();
    for rt in self.all().into_iter().filter(|rt| rt.id != except && rt.is_live()) {
      let Some(ready) = rt.snapshot().ready else { continue };
      let urls = ready.app_url.iter().chain(std::iter::once(&ready.api_url));
      held.extend(urls.filter_map(|url| tauri::Url::parse(url).ok()?.port_or_known_default()).map(|port| (port, rt.id.clone())));
    }
    held
  }

  /// Stop a rayfin-local that Fabricator didn't start (the `already-serving`
  /// one), after checking that it is one.
  pub async fn stop_external(&self, project_id: &str, pid: u32) -> Result<(), LocalCommandError> {
    if self.owned_pids().contains(&pid) {
      return Err(error("invalid", "Fabricator runs that local backend itself. Stop it from its app.", None));
    }
    if pid <= 4 || pid == std::process::id() {
      return Err(error("invalid", "Fabricator won't stop that process.", None));
    }
    let grace = self.policy().stop_grace;
    let result = tokio::task::spawn_blocking(move || {
      let Some(path) = process::image_path(pid) else {
        return if process::is_alive(pid) {
          Err(error("not-rayfin-local", format!("Fabricator can't tell which program process {pid} runs, so it won't stop it."), Some("Stop it where it runs.")))
        } else {
          Ok(())
        };
      };
      if !process::is_rayfin_local(&path) {
        return Err(error(
          "not-rayfin-local",
          format!("Process {pid} is {}, not rayfin-local, so Fabricator won't stop it.", path.display()),
          None,
        ));
      }
      process::terminate(pid, grace).map_err(|message| error("stop-failed", message, None))
    })
    .await
    .map_err(|e| error("stop-failed", format!("Stopping the process failed: {e}"), None))?;
    if result.is_ok() {
      self.runtime(project_id).log("fabricator", "info", &format!("Stopped the other rayfin-local (process {pid})."), None);
    }
    result
  }

  /// `secret list --json`: the declared secrets and where their local values come from.
  pub async fn secrets(&self, dir: &Path) -> Result<Vec<LocalSecret>, LocalCommandError> {
    #[derive(serde::Deserialize)]
    struct List {
      #[serde(default)]
      secrets: Vec<LocalSecret>,
    }
    let output = self.cli(dir, &["secret", "list", "--json"], None).await?;
    serde_json::from_str::<List>(output.trim())
      .map(|list| list.secrets)
      .map_err(|e| error("bad-response", format!("rayfin-local listed the secrets in a way Fabricator couldn't read: {e}"), None))
  }

  /// `secret set NAME`, the value piped to its stdin: never an argument.
  pub async fn set_secret(&self, dir: &Path, name: &str, value: &str) -> Result<(), LocalCommandError> {
    self.cli(dir, &["secret", "set", name], Some(value)).await.map(drop)
  }

  pub async fn delete_secret(&self, dir: &Path, name: &str) -> Result<(), LocalCommandError> {
    self.cli(dir, &["secret", "delete", name], None).await.map(drop)
  }

  /// Run `rayfin-local -C <dir> <args>`; its stdout, or why it failed.
  async fn cli(&self, dir: &Path, args: &[&str], input: Option<&str>) -> Result<String, LocalCommandError> {
    let binary = self.binary().await.map_err(problem_error)?;
    // The project goes first: `secret set` would take a later `-C` for the value.
    let mut all: Vec<OsString> = vec!["-C".into(), dir.as_os_str().to_owned()];
    all.extend(args.iter().map(OsString::from));
    let output = binary::run_cli(&binary, all, input, CLI_TIMEOUT)
      .await
      .map_err(|e| problem_error(binary::spawn_problem(binary.file(), &e)))?;
    if output.code == Some(0) {
      return Ok(output.stdout);
    }
    let said = output.stderr.lines().chain(output.stdout.lines()).map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
    let said = said.strip_prefix("error:").map(str::trim).unwrap_or(&said);
    Err(error(
      "cli-failed",
      if said.is_empty() { format!("rayfin-local {} failed.", args.join(" ")) } else { said.to_string() },
      None,
    ))
  }

  /// Fabricator is exiting: close every backend's stdin, give them a moment
  /// to stop, then kill what's left. Blocks.
  pub fn kill_all(&self) {
    self.inner.closing.store(true, Ordering::SeqCst);
    let pids: Vec<u32> = self.all().iter().filter_map(|rt| rt.close_now()).collect();
    for pid in process::wait_for_exit(&pids, self.policy().exit_grace) {
      process::kill_tree(pid);
    }
  }

  /// Stop every backend and wait for them (before an update replaces rayfin-local).
  pub async fn stop_all(&self) {
    let runtimes: Vec<Arc<Runtime>> = self.all().into_iter().filter(|rt| rt.is_live()).collect();
    futures::future::join_all(runtimes.iter().map(|rt| async move {
      let _lifecycle = rt.lifecycle.lock().await;
      self.stop_runtime(rt).await;
    }))
    .await;
    for pid in self.owned_pids() {
      process::kill_tree(pid);
    }
  }
}

/// Why the control API can't be used right now.
fn not_running(status: &LocalStatus) -> LocalCommandError {
  match status.state {
    State::Starting | State::Restarting => error(
      "not-running",
      "The local backend is still starting.",
      Some("Try again once it's running."),
    ),
    State::Error => LocalCommandError {
      hint: status.error.as_ref().and_then(|e| e.hint.clone()),
      ..error(
        "not-running",
        format!(
          "The local backend isn't running: {}",
          status.error.as_ref().map(|e| e.message.as_str()).unwrap_or("it stopped after an error.")
        ),
        None,
      )
    },
    _ => error("not-running", "The local backend isn't running.", Some("Start it first.")),
  }
}

pub(crate) fn problem_error(problem: LocalProblem) -> LocalCommandError {
  LocalCommandError { code: problem.code, message: problem.message, hint: problem.hint, status: None }
}

/// npm's output, line by line, into the project's output.
fn install_output(rt: Arc<Runtime>) -> crate::services::exec::OnData {
  use crate::services::exec::Stream as Out;
  Arc::new(move |stream, text| {
    let (source, level) = match stream {
      Out::System => ("fabricator", "info"),
      Out::Stderr => ("npm", "warn"),
      Out::Stdout => ("npm", "info"),
    };
    for line in text.lines().map(str::trim_end).filter(|line| !line.trim().is_empty()) {
      rt.log(source, level, line, None);
    }
  })
}

/// `npm install` in `dir`, streaming its output.
async fn npm_install(dir: &Path, output: crate::services::exec::OnData) -> Result<(), String> {
  let result = crate::services::exec::run(
    "npm",
    &["install", "--no-audit", "--no-fund"],
    crate::services::exec::RunOptions {
      cwd: Some(dir.to_path_buf()),
      env: crate::services::npm_env::fresh_registry_env(),
      on_data: Some(output),
      timeout_ms: Some(600_000),
      ..Default::default()
    },
  )
  .await;
  if result.ok {
    return Ok(());
  }
  if result.not_found {
    return Err("npm wasn't found. Install Node.js, which includes npm, then try again.".into());
  }
  let code = result.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into());
  Err(format!("npm install failed in {} (exit code {code}).", dir.display()))
}

/// `dir` (absolute, or relative to `project`) when it's a folder of the project
/// with a `package.json`.
fn folder_within(project: &Path, dir: &Path) -> Option<PathBuf> {
  let dir = if dir.is_absolute() { dir.to_path_buf() } else { project.join(dir) };
  let inside = dir.canonicalize().ok()?.starts_with(project.canonicalize().ok()?);
  (inside && dir.join("package.json").is_file()).then_some(dir)
}

/// `developer`, `none` or `user:<username>`.
pub fn valid_sign_in(sign_in_as: &str) -> bool {
  matches!(sign_in_as, "developer" | "none") || sign_in_as.strip_prefix("user:").is_some_and(|user| !user.trim().is_empty())
}

/// The `--sign-in-as` value for an identity the control API reports.
pub fn sign_in_flag(identity: &LocalIdentity, requested_user: Option<&str>) -> Option<String> {
  match identity.kind.as_str() {
    "user" => identity.user.as_ref().map(|u| u.username.as_str()).or(requested_user).map(|name| format!("user:{name}")),
    "developer" | "none" => Some(identity.kind.clone()),
    _ => None,
  }
}

/// The folder of a project Fabricator knows.
pub fn project_dir(project_id: &str) -> Result<PathBuf, LocalCommandError> {
  let project = store::find_project(project_id)
    .ok_or_else(|| error("project-not-found", "Fabricator doesn't know that project anymore.", Some("Open it again from Home.")))?;
  let dir = PathBuf::from(&project.path);
  if !dir.is_dir() {
    return Err(error(
      "project-not-found",
      format!("The project's folder {} isn't there anymore.", dir.display()),
      Some("Move it back, or open the project again from where it is now."),
    ));
  }
  Ok(dir)
}

/// The managed [`LocalBackends`], wired to `app`'s events.
pub fn state(app: &AppHandle) -> LocalBackends {
  let backends = app.state::<LocalBackends>().inner().clone();
  backends.attach_app(app);
  backends
}

/// A project's local backend status.
pub fn snapshot(app: &AppHandle, project_id: &str) -> LocalStatus {
  state(app).status(project_id)
}

/// A project's last `n` lines of local backend output, oldest first.
pub fn recent_logs(app: &AppHandle, project_id: &str, n: usize) -> Vec<LocalLogEvent> {
  state(app).logs(project_id, n)
}

/// A client for a project's control API (and for calling the app as a user),
/// while its backend runs.
pub fn control(app: &AppHandle, project_id: &str) -> Result<ControlClient, LocalCommandError> {
  state(app).control(project_id)
}

/// Stop every local backend as Fabricator exits.
pub fn kill_all(app: &AppHandle) {
  if let Some(backends) = app.try_state::<LocalBackends>() {
    backends.kill_all();
  }
}

/// Stop every local backend and wait, before an update replaces rayfin-local.
pub async fn stop_all(app: &AppHandle) {
  let Some(backends) = app.try_state::<LocalBackends>().map(|s| s.inner().clone()) else {
    return;
  };
  backends.stop_all().await;
}
