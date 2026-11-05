//! The copy of the app a Goals run checks. The app's files, without its git
//! history, local data or frontend build, go to a folder of Fabricator's own
//! (`paths::goals_runs_dir`), with its npm packages linked from the original
//! rather than copied. A rayfin-local of its own serves only the backend
//! (`--no-frontend`) on an empty database, loaded from the app's seed data.
//! Whatever a check creates, changes or deletes stays in the copy, which is
//! stopped and removed when the run ends.

use std::collections::HashSet;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tauri::{AppHandle, Manager};

use crate::services::agent_tools::output_line;
use crate::services::diagnostics::redact_secrets;
use crate::services::exec::CancelToken;
use crate::services::fingerprint;
use crate::services::local_backend::{ControlClient, LocalBackends, Policy, Settings};
use crate::services::project_layout::{self, ProjectLayout};
use crate::services::{local_ports, paths, rayfin_sdk};
use crate::types::LocalBackendState as State;
use crate::types::{LocalColumn, LocalFeatures, LocalSeedLoad, LocalSeedProblem, LocalStartOptions, LocalStatus, ServeMode};

/// Ports a copy's backend serves on: away from the ones apps and previews use,
/// and below the range Windows hands out to outgoing connections.
const PORTS: std::ops::RangeInclusive<u16> = 48_100..=48_999;
/// Copies running at once, across projects.
const MAX_RUNNING: usize = 3;
/// How long a copy gets to start: its functions build on the way.
const START_TIMEOUT: Duration = Duration::from_secs(240);
const POLL: Duration = Duration::from_millis(500);
/// How long a call waits for the copy to be ready again, after a crash.
const CONTROL_WAIT: Duration = Duration::from_secs(30);
/// The most a copy may take, its npm packages aside.
const MAX_COPY_BYTES: u64 = 1 << 30;
/// Entities whose fields a run is told.
const MAX_ENTITIES: usize = 30;
/// Folders never copied, wherever they are: git's data, caches, and the state
/// of the tools that run or publish the app.
const SKIP_ANYWHERE: &[&str] = &[".git", ".vite", ".fabricator", ".rayfin", ".micro-fabric", ".turbo", ".cache", ".next"];
/// Builds at the app's root: the frontend's, which a copy doesn't serve.
/// Packages' builds stay: a data package's is what rayfin-local reads.
const SKIP_AT_ROOT: &[&str] = &["dist", "build", "out", "coverage", "target"];
/// What a copy keeps of the app's local backend state: its ports, publishable
/// key and secret values, not its data, keys or the lock of a running backend.
const LOCAL_STATE_KEPT: &[&str] = &["state.json", "secrets.json", ".gitignore"];
const NO_SEED: &str =
  "The app has no seed data (rayfin/seed), so its data starts empty: create what a check needs through the app's routes.";

/// The backends of Goals runs' copies (Tauri managed state), apart from the
/// projects' own: their output goes to their own folder, never to the preview.
#[derive(Clone)]
pub struct GoalRunners(LocalBackends);

impl Default for GoalRunners {
  fn default() -> Self {
    Self(LocalBackends::new(Settings {
      log_dir: Some(paths::logs_dir().join("goals")),
      policy: Policy { max_running: MAX_RUNNING, ..Policy::default() },
      ..Settings::default()
    }))
  }
}

impl GoalRunners {
  pub(super) fn backends(&self) -> LocalBackends {
    self.0.clone()
  }
}

/// Fabricator is exiting: stop every copy's backend. Blocks.
pub fn kill_all(app: &AppHandle) {
  if let Some(runners) = app.try_state::<GoalRunners>() {
    runners.0.kill_all();
  }
}

/// Stop every copy's backend and wait for them (before an update replaces rayfin-local).
pub async fn stop_all(app: &AppHandle) {
  let Some(runners) = app.try_state::<GoalRunners>().map(|runners| runners.inner().clone()) else {
    return;
  };
  runners.0.stop_all().await;
}

/* --------------------------------- ports --------------------------------- */

/// Ports leased to copies, from before they start until they're removed.
static LEASED: Lazy<Mutex<HashSet<u16>>> = Lazy::new(Default::default);

struct PortLease(u16);

impl Drop for PortLease {
  fn drop(&mut self) {
    LEASED.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
  }
}

fn lease_port() -> Result<PortLease, String> {
  let mut leased = LEASED.lock().unwrap_or_else(|e| e.into_inner());
  if leased.len() >= MAX_RUNNING {
    return Err(format!(
      "Goals checks are already running for {MAX_RUNNING} other apps. Try again when one of them ends."
    ));
  }
  let port = PORTS.filter(|port| !leased.contains(port)).find(|port| local_ports::is_free(*port)).ok_or_else(|| {
    format!("Fabricator couldn't find a free port for the copy of the app ({}-{}).", PORTS.start(), PORTS.end())
  })?;
  leased.insert(port);
  Ok(PortLease(port))
}

/* --------------------------------- copy --------------------------------- */

/// Why preparing the copy ended early.
#[derive(Debug)]
pub(super) enum Failure {
  Cancelled,
  Error(String),
}

/// An entity of the copy's data model, with its fields.
#[derive(Clone, Debug)]
pub(super) struct Entity {
  pub name: String,
  /// Rows after the seed data loaded.
  pub rows: u64,
  /// `name (type)`, `, key` for the primary key's.
  pub fields: Vec<String>,
}

/// The copy, running on its seed data: what a run is told about it.
#[derive(Clone, Debug, Default)]
pub(super) struct Ready {
  pub features: LocalFeatures,
  pub entities: Vec<Entity>,
  /// The user placeholders the seed data uses, such as `$developer`.
  pub seed_users: Vec<String>,
  /// What Fabricator did, and what doesn't work in the copy.
  pub notes: Vec<String>,
  pub layout: ProjectLayout,
}

/// The copy of the app a run checks. Dropped without [`Scratch::finish`]
/// (a run that panicked), it still stops and removes itself.
pub(super) struct Scratch {
  backends: LocalBackends,
  /// Its backend's id among the [`GoalRunners`]: one per project, so its output has one file.
  key: String,
  root: PathBuf,
  lease: Option<PortLease>,
  finished: bool,
}

impl Scratch {
  /// A copy of project `project_id` to make in a new folder under `parent`.
  pub(super) fn new(backends: LocalBackends, project_id: &str, parent: &Path) -> Result<Self, String> {
    let lease = lease_port()?;
    let name: String = paths::safe_name(project_id).chars().take(24).collect();
    let unique = uuid::Uuid::new_v4().simple().to_string();
    Ok(Self {
      backends,
      key: format!("goals-{project_id}"),
      root: parent.join(format!("{name}-{}", &unique[..8])),
      lease: Some(lease),
      finished: false,
    })
  }

  pub(super) fn root(&self) -> &Path {
    &self.root
  }

  pub(super) fn handle(&self) -> Handle {
    Handle { backends: self.backends.clone(), key: self.key.clone() }
  }

  /// Copy the app in `original`.
  pub(super) async fn copy(&self, original: &Path, token: &CancelToken) -> Result<(), Failure> {
    let (from, to, cancel) = (original.to_path_buf(), self.root.clone(), token.clone());
    tokio::task::spawn_blocking(move || copy_app(&from, &to, &cancel))
      .await
      .map_err(|e| Failure::Error(format!("Copying the app failed: {e}")))??;
    if token.is_cancelled() {
      return Err(Failure::Cancelled);
    }
    Ok(())
  }

  /// Start the [copied](Self::copy) app's backend on an empty database and
  /// load the seed data. `phase` hears each step (`starting`, `seeding`).
  pub(super) async fn prepare(&self, token: &CancelToken, phase: &(dyn Fn(&str) + Send + Sync)) -> Result<Ready, Failure> {
    phase("starting");
    self.backends.forget(&self.key).await;
    let options = LocalStartOptions {
      reset: true,
      serve: ServeMode { no_frontend: true, port: self.lease.as_ref().map(|lease| lease.0), ..Default::default() },
      ..Default::default()
    };
    self.backends.start(&self.key, self.root.clone(), options).await;
    self.until_ready(token).await?;

    phase("seeding");
    let control = self
      .backends
      .control(&self.key)
      .map_err(|e| Failure::Error(format!("Fabricator couldn't reach the copy of the app: {e}")))?;
    let mut notes = Vec::new();
    let mut seed_users = Vec::new();
    match or_cancel(token, control.seed()).await? {
      Ok(seed) if !seed.exists => notes.push(NO_SEED.to_string()),
      Ok(seed) => {
        seed_users = seed.users;
        match or_cancel(token, control.load_seed(false)).await? {
          Ok(load) if load.ok => notes.push(loaded_note(&load)),
          Ok(load) => notes.push(format!(
            "Fabricator couldn't load the app's seed data, so its data starts empty. {}",
            problems_text(&load.problems)
          )),
          Err(e) => notes.push(format!("Fabricator couldn't load the app's seed data, so its data starts empty: {e}")),
        }
      }
      Err(e) => notes.push(format!("Fabricator couldn't read the app's seed data, so its data starts empty: {e}")),
    }

    let mut entities = Vec::new();
    match or_cancel(token, control.entities()).await? {
      Ok(list) => {
        if list.len() > MAX_ENTITIES {
          notes.push(format!("The app has {} entities; the fields of the first {MAX_ENTITIES} are listed.", list.len()));
        }
        for entity in list.into_iter().take(MAX_ENTITIES) {
          let fields = match or_cancel(token, control.rows(&entity.name, 0, 1, None, false)).await? {
            Ok(rows) => rows.columns.iter().map(describe_column).collect(),
            Err(_) => Vec::new(),
          };
          entities.push(Entity { name: entity.name, rows: entity.rows, fields });
        }
      }
      Err(e) => notes.push(format!("Fabricator couldn't list the app's entities: {e}")),
    }

    let status = self.backends.status(&self.key);
    notes.extend(status_notes(&status));
    Ok(Ready {
      features: status.ready.map(|ready| ready.features).unwrap_or_default(),
      entities,
      seed_users,
      notes,
      layout: ProjectLayout::read(&self.root),
    })
  }

  /// Wait until the copy's backend runs and isn't building its functions.
  async fn until_ready(&self, token: &CancelToken) -> Result<(), Failure> {
    let began = Instant::now();
    loop {
      if token.is_cancelled() {
        return Err(Failure::Cancelled);
      }
      let status = self.backends.status(&self.key);
      match status.state {
        State::Running if !busy(&status) => {
          settle(&self.backends, &self.key).await;
          return Ok(());
        }
        State::Error | State::Stopped => return Err(Failure::Error(start_failure(&status))),
        _ => {}
      }
      if began.elapsed() >= START_TIMEOUT {
        return Err(Failure::Error(format!(
          "The copy of the app didn't start within {} minutes. Its output is in Fabricator's logs folder, under goals.",
          START_TIMEOUT.as_secs() / 60
        )));
      }
      tokio::select! {
        _ = token.wait_cancelled() => {}
        _ = tokio::time::sleep(POLL) => {}
      }
    }
  }

  /// Stop the copy's backend and remove the copy.
  pub(super) async fn finish(mut self) {
    self.finished = true;
    self.backends.forget(&self.key).await;
    self.lease.take();
    let root = self.root.clone();
    let _ = tokio::task::spawn_blocking(move || remove_tree(&root)).await;
  }
}

impl Drop for Scratch {
  fn drop(&mut self) {
    if self.finished {
      return;
    }
    let (backends, key, root, lease) = (self.backends.clone(), self.key.clone(), self.root.clone(), self.lease.take());
    match tokio::runtime::Handle::try_current() {
      Ok(runtime) => {
        runtime.spawn(async move {
          backends.forget(&key).await;
          drop(lease);
          let _ = tokio::task::spawn_blocking(move || remove_tree(&root)).await;
        });
      }
      Err(_) => {
        drop(lease);
        remove_tree(&root);
      }
    }
  }
}

/// What a run's tools reach the copy through.
#[derive(Clone)]
pub(super) struct Handle {
  backends: LocalBackends,
  key: String,
}

impl Handle {
  /// The copy's control API, once its backend is ready (it starts again after a crash).
  pub(super) async fn control(&self) -> Result<ControlClient, String> {
    let began = Instant::now();
    loop {
      let status = self.backends.status(&self.key);
      match status.state {
        State::Running if !busy(&status) => return self.backends.control(&self.key).map_err(|e| e.to_string()),
        State::Error | State::Stopped => return Err(start_failure(&status)),
        _ => {}
      }
      if began.elapsed() >= CONTROL_WAIT {
        return Err("The copy of the app isn't ready: it's still starting again.".into());
      }
      tokio::time::sleep(Duration::from_millis(250)).await;
    }
  }

  /// The copy's last `lines` lines of output.
  pub(super) fn recent_output(&self, lines: usize) -> String {
    self.backends.logs(&self.key, lines).iter().map(output_line).collect::<Vec<_>>().join("\n")
  }
}

/// `work`, unless `token` is cancelled first.
async fn or_cancel<T>(token: &CancelToken, work: impl Future<Output = T>) -> Result<T, Failure> {
  tokio::pin!(work);
  loop {
    if token.is_cancelled() {
      return Err(Failure::Cancelled);
    }
    // The poll covers a cancel made just before `wait_cancelled` listens.
    tokio::select! {
      out = &mut work => return Ok(out),
      _ = token.wait_cancelled() => {}
      _ = tokio::time::sleep(Duration::from_millis(250)) => {}
    }
  }
}

/// The status once it stops changing for a moment (a `schema` event follows
/// its `analysis`), within a few seconds.
async fn settle(backends: &LocalBackends, key: &str) -> LocalStatus {
  let quiet = Duration::from_millis(400);
  let mut status = backends.status(key);
  for _ in 0..8 {
    tokio::time::sleep(quiet).await;
    let next = backends.status(key);
    if next.revision == status.revision {
      return next;
    }
    status = next;
  }
  status
}

/// Building the functions, or restarting the app's Vite.
fn busy(status: &LocalStatus) -> bool {
  status.functions.as_ref().is_some_and(|f| f.state == "building")
    || status.vite.as_ref().is_some_and(|v| v.state == "restarting")
}

/// Why the copy's backend isn't running, for the user.
fn start_failure(status: &LocalStatus) -> String {
  let Some(problem) = &status.error else {
    return "The copy of the app stopped before it was ready.".to_string();
  };
  if problem.code == "packages-missing" {
    return "The copy of the app couldn't find all its npm packages. Start the app's preview, which installs what's \
            missing, then run the checks again."
      .to_string();
  }
  let mut text = format!("The copy of the app didn't start: {}", problem.message.trim());
  if let Some(hint) = problem.hint.as_deref().map(str::trim).filter(|hint| !hint.is_empty()) {
    text = format!("{text} {hint}");
  }
  redact_secrets(&text)
}

/// What doesn't work in the copy, as its status says.
fn status_notes(status: &LocalStatus) -> Vec<String> {
  let mut notes = Vec::new();
  if let Some(analysis) = status.analysis.as_ref().filter(|a| !a.ok) {
    let why = analysis.message.as_deref().unwrap_or("it gave no reason");
    notes.push(redact_secrets(&format!("rayfin-local couldn't read the app's data model: {why}")));
  }
  if let Some(schema) = status.schema.as_ref().filter(|s| s.result == "failed" || s.result == "refused") {
    let why = schema.message.as_deref().unwrap_or("it gave no reason");
    notes.push(redact_secrets(&format!("The copy's database doesn't match the data model ({}): {why}", schema.result)));
  }
  if let Some(functions) = status.functions.as_ref().filter(|f| f.state == "failed") {
    let why = functions.errors.first().or(functions.message.as_ref()).map(String::as_str).unwrap_or("no reason given");
    notes.push(redact_secrets(&format!("The app's functions didn't build, so calling them fails: {why}")));
  }
  if status.newer_sdk {
    notes.push(
      "The app uses a newer Rayfin SDK than the local backend implements, so some of it may not work in the copy."
        .to_string(),
    );
  }
  notes
}

fn loaded_note(load: &LocalSeedLoad) -> String {
  let mut parts: Vec<String> =
    load.entities.iter().filter(|e| e.rows > 0).map(|e| format!("{} {}", e.rows, e.name)).collect();
  parts.extend(load.storage.iter().filter(|f| f.files > 0).map(|f| {
    format!("{} {} in {}", f.files, if f.files == 1 { "file" } else { "files" }, f.folder)
  }));
  if parts.is_empty() {
    return "The app's seed data is empty, so its data starts empty: create what a check needs through the app's \
            routes."
      .to_string();
  }
  format!("Fabricator loaded the app's seed data: {}.", parts.join(", "))
}

fn problems_text(problems: &[LocalSeedProblem]) -> String {
  let mut lines: Vec<String> = problems
    .iter()
    .take(3)
    .map(|p| {
      let at = match (p.row, &p.field) {
        (Some(row), Some(field)) => format!("{} (item {row}, {field})", p.file),
        (Some(row), None) => format!("{} (item {row})", p.file),
        (None, Some(field)) => format!("{} ({field})", p.file),
        (None, None) => p.file.clone(),
      };
      format!("{at}: {}", p.message)
    })
    .collect();
  if problems.len() > 3 {
    lines.push(format!("and {} more", problems.len() - 3));
  }
  if lines.is_empty() {
    return "It was refused.".to_string();
  }
  format!("Its problems: {}.", lines.join("; "))
}

fn describe_column(column: &LocalColumn) -> String {
  match (column.kind.trim(), column.key) {
    ("", false) => column.name.clone(),
    ("", true) => format!("{} (key)", column.name),
    (kind, false) => format!("{} ({kind})", column.name),
    (kind, true) => format!("{} ({kind}, key)", column.name),
  }
}

/* -------------------------------- copying -------------------------------- */

/// A link to make once everything's copied.
struct Link {
  at: PathBuf,
  /// The copy of what it points to, when that's part of the app (an npm workspace's package).
  inside: Option<PathBuf>,
  /// What it points to in the original.
  target: PathBuf,
}

struct Copier<'a> {
  /// The app's folder, canonical.
  from: PathBuf,
  to: PathBuf,
  token: &'a CancelToken,
  bytes: u64,
  links: Vec<Link>,
}

/// Copy the app in `from` to `to` (see the module's docs).
fn copy_app(from: &Path, to: &Path, token: &CancelToken) -> Result<(), Failure> {
  let from = fs::canonicalize(from)
    .map(|path| plain(&path))
    .map_err(|e| Failure::Error(format!("Couldn't read the app's folder: {e}")))?;
  fs::create_dir_all(to).map_err(|e| Failure::Error(format!("Couldn't make a folder for the copy of the app: {e}")))?;
  let mut copier = Copier { from, to: to.to_path_buf(), token, bytes: 0, links: Vec::new() };
  copier.dir(Path::new(""))?;
  copier.link_all()
}

/// `path` with `/` separators, for messages.
fn show(rel: &Path) -> String {
  let text = rel.to_string_lossy().replace('\\', "/");
  if text.is_empty() { "folder".into() } else { text }
}

impl Copier<'_> {
  fn error(&self, rel: &Path, e: std::io::Error) -> Failure {
    Failure::Error(format!("Couldn't copy the app's {}: {e}", show(rel)))
  }

  fn entries(&self, rel: &Path) -> Result<Vec<fs::DirEntry>, Failure> {
    fs::read_dir(self.from.join(rel)).and_then(|entries| entries.collect()).map_err(|e| self.error(rel, e))
  }

  fn dir(&mut self, rel: &Path) -> Result<(), Failure> {
    if self.token.is_cancelled() {
      return Err(Failure::Cancelled);
    }
    fs::create_dir_all(self.to.join(rel)).map_err(|e| self.error(rel, e))?;
    let at_root = rel.as_os_str().is_empty();
    let in_rayfin = show(rel).eq_ignore_ascii_case("rayfin");
    for entry in self.entries(rel)? {
      let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
      let child = rel.join(entry.file_name());
      let kind = entry.file_type().map_err(|e| self.error(&child, e))?;
      if name == "node_modules" {
        if kind.is_symlink() {
          self.relink(&child);
        } else if kind.is_dir() {
          self.packages(&child)?;
        }
      } else if kind.is_symlink() {
        // A link the app holds may point anywhere: the copy keeps to the app's own files.
      } else if kind.is_dir() {
        if name == ".rayfin-local" {
          if at_root {
            self.local_state(&child)?;
          }
        } else if !(SKIP_ANYWHERE.contains(&name.as_str())
          || (at_root && SKIP_AT_ROOT.contains(&name.as_str()))
          || (in_rayfin && name == ".temp"))
        {
          self.dir(&child)?;
        }
      } else if kind.is_file() {
        self.file(&child)?;
      }
    }
    Ok(())
  }

  /// The app's local backend state: only [`LOCAL_STATE_KEPT`].
  fn local_state(&mut self, rel: &Path) -> Result<(), Failure> {
    fs::create_dir_all(self.to.join(rel)).map_err(|e| self.error(rel, e))?;
    for name in LOCAL_STATE_KEPT {
      if self.from.join(rel).join(name).is_file() {
        self.file(&rel.join(name))?;
      }
    }
    Ok(())
  }

  /// An npm `node_modules` folder: a folder of the copy's own, whose packages
  /// link to the original's (npm's own files are copied). Tools write to its
  /// caches, so those stay out.
  fn packages(&mut self, rel: &Path) -> Result<(), Failure> {
    if self.token.is_cancelled() {
      return Err(Failure::Cancelled);
    }
    fs::create_dir_all(self.to.join(rel)).map_err(|e| self.error(rel, e))?;
    for entry in self.entries(rel)? {
      let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
      if matches!(name.as_str(), ".cache" | ".vite" | ".vite-temp") {
        continue;
      }
      let child = rel.join(entry.file_name());
      let kind = entry.file_type().map_err(|e| self.error(&child, e))?;
      if kind.is_dir() && name.starts_with('@') {
        self.scope(&child)?;
      } else {
        self.package(&child, kind)?;
      }
    }
    Ok(())
  }

  /// A scope's folder, such as `@microsoft`: the copy's own, its packages linked.
  fn scope(&mut self, rel: &Path) -> Result<(), Failure> {
    fs::create_dir_all(self.to.join(rel)).map_err(|e| self.error(rel, e))?;
    for entry in self.entries(rel)? {
      let child = rel.join(entry.file_name());
      let kind = entry.file_type().map_err(|e| self.error(&child, e))?;
      self.package(&child, kind)?;
    }
    Ok(())
  }

  fn package(&mut self, rel: &Path, kind: fs::FileType) -> Result<(), Failure> {
    if kind.is_symlink() {
      self.relink(rel);
    } else if kind.is_dir() {
      self.links.push(Link { at: self.to.join(rel), inside: None, target: self.from.join(rel) });
    } else if kind.is_file() {
      self.file(rel)?;
    }
    Ok(())
  }

  /// A link in `node_modules` (npm links a workspace's packages): to the copy
  /// of what it points to when that's part of the app, else to the same place.
  fn relink(&mut self, rel: &Path) {
    let Ok(target) = fs::canonicalize(self.from.join(rel)).map(|path| plain(&path)) else {
      return;
    };
    let inside = target
      .strip_prefix(&self.from)
      .ok()
      .filter(|inner| !inner.components().any(|part| part.as_os_str().eq_ignore_ascii_case("node_modules")))
      .map(|inner| self.to.join(inner));
    self.links.push(Link { at: self.to.join(rel), inside, target });
  }

  fn file(&mut self, rel: &Path) -> Result<(), Failure> {
    let source = self.from.join(rel);
    let target = self.to.join(rel);
    let meta = fs::metadata(&source).map_err(|e| self.error(rel, e))?;
    self.charge(meta.len(), rel)?;
    fs::copy(&source, &target).map_err(|e| self.error(rel, e))?;
    // Builds are compared with their sources by time: a data package's build
    // mustn't look older than its code.
    if let Ok(modified) = meta.modified() {
      if let Ok(file) = fs::OpenOptions::new().write(true).open(&target) {
        let _ = file.set_modified(modified);
      }
    }
    Ok(())
  }

  fn charge(&mut self, bytes: u64, rel: &Path) -> Result<(), Failure> {
    self.bytes += bytes;
    if self.bytes > MAX_COPY_BYTES {
      return Err(Failure::Error(format!(
        "The app is too large to copy for its checks: over {} GB without its npm packages (at {}).",
        MAX_COPY_BYTES >> 30,
        show(rel)
      )));
    }
    Ok(())
  }

  fn link_all(&mut self) -> Result<(), Failure> {
    for link in std::mem::take(&mut self.links) {
      if self.token.is_cancelled() {
        return Err(Failure::Cancelled);
      }
      let rel = link.at.strip_prefix(&self.to).unwrap_or(&link.at).to_path_buf();
      let target = link.inside.filter(|inside| inside.exists()).unwrap_or(link.target);
      if target.is_dir() {
        link_dir(&target, &link.at).map_err(|e| self.error(&rel, e))?;
      } else if target.is_file() {
        self.charge(fs::metadata(&target).map(|m| m.len()).unwrap_or(0), &rel)?;
        fs::copy(&target, &link.at).map_err(|e| self.error(&rel, e))?;
      }
    }
    Ok(())
  }
}

/// `path` without the `\\?\` that `canonicalize` adds on Windows, which links and tools don't take.
fn plain(path: &Path) -> PathBuf {
  let text = path.to_string_lossy();
  if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
    return PathBuf::from(format!(r"\\{rest}"));
  }
  match text.strip_prefix(r"\\?\") {
    Some(rest) => PathBuf::from(rest),
    None => path.to_path_buf(),
  }
}

/// Link the folder `link` to `target`: a junction on Windows, which needs no
/// privilege (a symbolic link for a network folder, which junctions can't reach).
#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
  if target.to_string_lossy().starts_with(r"\\") {
    return std::os::windows::fs::symlink_dir(target, link);
  }
  junction(target, link).or_else(|e| std::os::windows::fs::symlink_dir(target, link).map_err(|_| e))
}

#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
  std::os::unix::fs::symlink(target, link)
}

/// Make `link` a directory junction (a mount point) to `target`, made absolute
/// with `\` separators: a junction to a path with `/` in it leads nowhere.
#[cfg(windows)]
fn junction(target: &Path, link: &Path) -> std::io::Result<()> {
  use std::os::windows::ffi::OsStrExt;
  use std::os::windows::fs::OpenOptionsExt;
  use std::os::windows::io::AsRawHandle;

  use windows::Win32::Foundation::HANDLE;
  use windows::Win32::System::IO::DeviceIoControl;

  const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
  const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
  const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
  const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
  const MAX_BUFFER: usize = 16 * 1024;

  let target = std::path::absolute(target)?;
  let print: Vec<u16> = target.as_os_str().encode_wide().collect();
  let substitute: Vec<u16> = r"\??\".encode_utf16().chain(print.iter().copied()).collect();
  let (substitute_bytes, print_bytes) = (substitute.len() * 2, print.len() * 2);
  // The four name fields, then each name with its NUL.
  let data_len = 8 + substitute_bytes + 2 + print_bytes + 2;
  if 8 + data_len > MAX_BUFFER {
    return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "the path is too long for a junction"));
  }
  let mut buffer: Vec<u8> = Vec::with_capacity(8 + data_len);
  buffer.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
  for field in [data_len, 0, 0, substitute_bytes, substitute_bytes + 2, print_bytes] {
    buffer.extend_from_slice(&(field as u16).to_le_bytes());
  }
  for unit in substitute.iter().chain(&[0]).chain(&print).chain(&[0]) {
    buffer.extend_from_slice(&unit.to_le_bytes());
  }

  fs::create_dir(link)?;
  let set = fs::OpenOptions::new()
    .read(true)
    .write(true)
    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
    .open(link)
    .and_then(|dir| {
      let mut returned = 0u32;
      unsafe {
        DeviceIoControl(
          HANDLE(dir.as_raw_handle()),
          FSCTL_SET_REPARSE_POINT,
          Some(buffer.as_ptr().cast()),
          buffer.len() as u32,
          None,
          0,
          Some(&mut returned),
          None,
        )
      }
      .map_err(std::io::Error::from)
    });
  if set.is_err() {
    let _ = fs::remove_dir(link);
  }
  set
}

/* -------------------------------- removing -------------------------------- */

/// Remove the links under `dir` first, so removing it can't reach what they point to.
fn unlink_all(dir: &Path) {
  let Ok(entries) = fs::read_dir(dir) else {
    return;
  };
  for entry in entries.flatten() {
    let Ok(kind) = entry.file_type() else {
      continue;
    };
    let path = entry.path();
    if kind.is_symlink() {
      // A junction or a link to a folder goes as a folder on Windows; elsewhere a link is a file.
      if fs::remove_dir(&path).is_err() {
        let _ = fs::remove_file(&path);
      }
    } else if kind.is_dir() {
      unlink_all(&path);
    }
  }
}

/// Remove a copy (or every copy, from their parent), its links first. A
/// backend that just stopped may still hold files for a moment.
pub(super) fn remove_tree(dir: &Path) {
  if fs::symlink_metadata(dir).is_err() {
    return;
  }
  unlink_all(dir);
  for attempt in 0..=10 {
    match fs::remove_dir_all(dir) {
      Ok(()) => return,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
      Err(e) if attempt == 10 => log::warn!("Couldn't remove the Goals copy {}: {e}", dir.display()),
      Err(_) => std::thread::sleep(Duration::from_millis(200)),
    }
  }
}

/// Remove the copies a Fabricator that exited during a run left. At startup.
pub fn clean_up() {
  remove_tree(&paths::goals_runs_dir());
}

/* ------------------------------ fingerprint ------------------------------ */

/// A signature of what a run's results depend on: the app's backend (its
/// data model, functions, seed data, configuration and packages) and its
/// frontend's source, whose screens decide what's called. Not its docs, its
/// other files or `GOALS.md`: a reworded check is a new check anyway.
pub(super) fn app_fingerprint(project: &Path) -> String {
  let layout = ProjectLayout::read(project);
  let mut parts: Vec<String> = vec!["package.json".into(), "rayfin-local.toml".into(), layout.frontend_src()];
  if let Ok(entries) = fs::read_dir(project.join("rayfin")) {
    for entry in entries.flatten() {
      let name = entry.file_name().to_string_lossy().to_string();
      if !name.starts_with('.') {
        parts.push(format!("rayfin/{name}"));
      }
    }
  }
  parts.push(layout.data_dir.strip_suffix("/src").unwrap_or(&layout.data_dir).to_string());
  parts.push(layout.functions_root.clone());
  for dir in rayfin_sdk::workspace_dirs(project) {
    let Ok(rel) = dir.strip_prefix(project) else {
      continue;
    };
    let rel = rel.to_string_lossy().replace('\\', "/");
    let frontend = &layout.frontend_root;
    if !frontend.is_empty() && (rel == *frontend || project_layout::is_under(&rel, frontend)) {
      continue;
    }
    parts.push(rel);
  }
  fingerprint::fingerprint_parts(&project.to_string_lossy(), &parts)
}

#[cfg(test)]
mod tests {
  use std::time::SystemTime;

  use serde_json::json;

  use super::*;
  use crate::services::local_backend::{AppCall, Binary, CallAs};

  const FAKE_RAYFIN_LOCAL: &str = include_str!("../../services/local_backend/fake_rayfin_local.cjs");

  struct Temp(PathBuf);

  impl Temp {
    fn new() -> Self {
      let dir = std::env::temp_dir().join(format!("fab-goals-{}", uuid::Uuid::new_v4()));
      fs::create_dir_all(&dir).unwrap();
      Self(dir)
    }

    fn write(&self, rel: &str, text: &str) -> PathBuf {
      let path = self.0.join(rel);
      fs::create_dir_all(path.parent().unwrap()).unwrap();
      fs::write(&path, text).unwrap();
      path
    }
  }

  impl Drop for Temp {
    fn drop(&mut self) {
      remove_tree(&self.0);
    }
  }

  fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
  }

  #[test]
  fn copies_the_app_without_its_history_data_or_build_and_links_its_packages() {
    let app = Temp::new();
    for rel in [
      "package.json",
      "rayfin/rayfin.yml",
      "rayfin/.temp/deploy.json",
      ".git/HEAD",
      "dist/index.html",
      "packages/data/dist/index.js",
      "packages/data/.turbo/log",
      ".rayfin-local/state.json",
      ".rayfin-local/secrets.json",
      ".rayfin-local/db.sqlite",
      ".rayfin-local/serve.lock",
      "node_modules/.package-lock.json",
      "node_modules/.cache/x",
      "node_modules/foo/index.js",
      "node_modules/@scope/bar/index.js",
    ] {
      app.write(rel, rel);
    }
    let code = app.write("src/App.tsx", "app");
    let then = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
    fs::OpenOptions::new().write(true).open(&code).unwrap().set_modified(then).unwrap();

    let out = Temp::new();
    let copy = out.0.join("copy");
    copy_app(&app.0, &copy, &CancelToken::new()).unwrap();
    for kept in [
      "package.json",
      "rayfin/rayfin.yml",
      "packages/data/dist/index.js",
      ".rayfin-local/state.json",
      ".rayfin-local/secrets.json",
      "node_modules/.package-lock.json",
    ] {
      assert!(copy.join(kept).is_file(), "{kept} is copied");
    }
    for left in [
      "rayfin/.temp",
      ".git",
      "dist",
      "packages/data/.turbo",
      ".rayfin-local/db.sqlite",
      ".rayfin-local/serve.lock",
      "node_modules/.cache",
    ] {
      assert!(!copy.join(left).exists(), "{left} is left out");
    }
    assert_eq!(fs::metadata(copy.join("src/App.tsx")).unwrap().modified().unwrap(), then, "times are kept");
    assert!(is_link(&copy.join("node_modules/foo")));
    assert_eq!(fs::read_to_string(copy.join("node_modules/foo/index.js")).unwrap(), "node_modules/foo/index.js");
    assert!(!is_link(&copy.join("node_modules/@scope")), "a scope is a folder of the copy's own");
    assert!(is_link(&copy.join("node_modules/@scope/bar")));
    assert!(copy.join("node_modules/@scope/bar/index.js").is_file());

    remove_tree(&copy);
    assert!(!copy.exists());
    assert!(app.0.join("node_modules/foo/index.js").is_file(), "removing the copy leaves the original's packages");
    assert!(app.0.join("node_modules/@scope/bar/index.js").is_file());
  }

  #[test]
  fn links_to_the_apps_own_packages_point_into_the_copy() {
    let app = Temp::new();
    app.write("packages/data/package.json", "{}");
    app.write("packages/data/src/index.ts", "export {}");
    fs::create_dir_all(app.0.join("node_modules/@app")).unwrap();
    link_dir(&app.0.join("packages/data"), &app.0.join("node_modules/@app/data")).unwrap();

    let out = Temp::new();
    let copy = out.0.join("copy");
    copy_app(&app.0, &copy, &CancelToken::new()).unwrap();
    assert!(is_link(&copy.join("node_modules/@app/data")));
    assert_eq!(
      fs::canonicalize(copy.join("node_modules/@app/data")).unwrap(),
      fs::canonicalize(copy.join("packages/data")).unwrap()
    );
  }

  #[test]
  fn results_go_stale_when_the_apps_code_changes_not_its_docs() {
    let app = Temp::new();
    let yml = "services:\n  data:\n    path: packages/data\n  staticHosting:\n    path: packages/web\n";
    app.write("rayfin/rayfin.yml", yml);
    app.write("package.json", r#"{"workspaces":["packages/*"]}"#);
    app.write("packages/data/package.json", "{}");
    app.write("packages/web/package.json", "{}");
    let before = app_fingerprint(&app.0);
    app.write("README.md", "# Deals");
    app.write("GOALS.md", "## Checks\n- A rep can log a deal.\n");
    assert_eq!(app_fingerprint(&app.0), before);
    app.write("packages/web/src/App.tsx", "export {}");
    let screens = app_fingerprint(&app.0);
    assert_ne!(screens, before);
    app.write("packages/data/src/Deal.ts", "export {}");
    assert_ne!(app_fingerprint(&app.0), screens);
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn prepares_a_copy_running_on_its_seed_data_then_removes_it() {
    let Ok(node) = which::which("node") else { return };
    let temp = Temp::new();
    let script = temp.write("fake-rayfin-local.cjs", FAKE_RAYFIN_LOCAL);
    let backends = LocalBackends::new(Settings {
      binary: Some(Binary { program: node, prefix: vec![script.into_os_string()] }),
      log_dir: Some(temp.0.join("logs")),
      policy: Policy { max_running: MAX_RUNNING, ..Policy::default() },
      host_env: false,
    });
    let app = temp.0.join("app");
    temp.write("app/fake-mode", "ok");
    temp.write("app/rayfin/rayfin.yml", "services: {}");
    temp.write("app/.git/HEAD", "ref");
    temp.write("app/.rayfin-local/db.sqlite", "rows");

    let scratch = Scratch::new(backends.clone(), "p1", &temp.0.join("runs")).unwrap();
    let phases = Mutex::new(Vec::new());
    scratch.copy(&app, &CancelToken::new()).await.unwrap();
    let ready = scratch
      .prepare(&CancelToken::new(), &|phase| phases.lock().unwrap().push(phase.to_string()))
      .await
      .unwrap();
    assert_eq!(*phases.lock().unwrap(), ["starting", "seeding"]);

    let root = scratch.root().to_path_buf();
    let args: Vec<String> = serde_json::from_str(&fs::read_to_string(root.join("args-1.json")).unwrap()).unwrap();
    for arg in ["--reset", "--no-frontend", "--port"] {
      assert!(args.iter().any(|a| a == arg), "{arg} in {args:?}");
    }
    assert!(!root.join(".git").exists());
    assert!(!root.join(".rayfin-local/db.sqlite").exists());
    assert!(ready.notes.iter().any(|note| note.contains("2 Note")), "{:?}", ready.notes);
    assert_eq!(ready.entities.len(), 1);
    assert_eq!(ready.entities[0].fields, ["id (int, key)", "title (string)"]);
    assert_eq!(ready.seed_users, ["$developer"]);

    let control = scratch.handle().control().await.unwrap();
    let call = AppCall { method: reqwest::Method::POST, path: "/graphql".into(), body: Some(json!({})), call_as: CallAs::Developer };
    let response = control.call_app(call).await.unwrap();
    assert_eq!(response.status, 200);
    assert!(response.body.contains("access-developer"), "{}", response.body);

    scratch.finish().await;
    assert!(!root.exists(), "the copy is removed");
    assert!(app.join("fake-mode").is_file(), "the original stays");
    backends.kill_all();
  }
}
