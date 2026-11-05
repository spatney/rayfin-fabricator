//! Apps installed from `.rayfin` files: a project exported to be used rather
//! than built (`commands::export`), which Fabricator installs and runs on its
//! own, in a window of its own, like any app on the computer.
//!
//! Opening a file opens the app's window with Fabricator's page in it
//! ([`window`]), which asks before installing: the app's code runs on this
//! computer. Installing unpacks it into `<apps>/<key>/app` ([`paths::apps_dir`]),
//! keeping the app's data (`.rayfin-local`) from the version it replaces.
//! Running it installs its npm packages when they're missing, then has
//! rayfin-local build it and serve it from its backend (`serve --static`) on
//! a port that stays the same, so its sign-in and storage in the window last;
//! later starts serve that build again (`--reuse-build`) while the port stays.
//! Once it's ready the window shows the app itself, which can't reach
//! Fabricator's commands: Tauri treats its origin as remote. Installed apps
//! have their own [`LocalBackends`], so they never stop a project's backend.
//!
//! When Fabricator starts only to open apps, its own window never opens, and it
//! quits with the last app's window (`lib.rs`). On Windows each app has its own
//! taskbar button and a Start menu shortcut ([`shell`]).

mod shell;
mod window;

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Url};

use crate::commands::export;
use crate::commands::util::now_iso;
use crate::services::exec::{OnData, Stream};
use crate::services::journal::{self, Area, Level};
use crate::services::local_backend::{Emit, LocalBackends, Policy, Settings, Sink};
use crate::services::{local_ports, paths};
use crate::types::{
  AppActionResult, AppFilePreview, AppProgressEvent, AppWindowInfo, InstalledApp, LocalBackendState, LocalReady,
  LocalStartOptions, LocalStatus, ServeMode,
};

pub use window::is_app_window;

/// Tauri event with an installed app's [`LocalStatus`] whenever it changes
/// (its `projectId` is the app's key).
pub const APPS_STATE: &str = "apps:state";
/// Tauri event with each line of an installed app's backend output.
pub const APPS_LOG: &str = "apps:log";
/// Tauri event with an [`AppProgressEvent`] while an app installs.
pub const APPS_PROGRESS: &str = "apps:progress";
/// Tauri event when an app is installed, updated or removed, or its window opens or closes.
pub const APPS_CHANGED: &str = "apps:changed";
/// The command-line flag that opens an installed app, as its shortcut does: `--app <key>`.
pub const APP_FLAG: &str = "--app";

/// What Fabricator keeps about an installed app, next to it.
const RECORD: &str = "app.json";
/// The app's own folder, which rayfin-local serves.
const CODE: &str = "app";
const ICON_PNG: &str = "icon.png";
const ICON_ICO: &str = "icon.ico";
/// The ports installed apps are served on, away from projects' (7171 and up).
const PORTS: std::ops::RangeInclusive<u16> = 47100..=47999;
/// Backends of installed apps that run at once.
const MAX_RUNNING: usize = 16;

const NOT_INSTALLED: &str = "This app isn’t installed anymore. Open its .rayfin file to install it again.";

/// What Fabricator keeps about an installed app (`<apps>/<key>/app.json`).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Record {
  pub key: String,
  pub name: String,
  pub version: Option<String>,
  /// Who exported the file it came from, and when.
  pub from: Option<String>,
  pub exported_at: Option<String>,
  pub installed_at: String,
  pub updated_at: String,
  /// The port its backend serves it on.
  pub port: Option<u16>,
  /// The port of the build rayfin-local left: the next start serves that
  /// build again while the port is the same. `None` after an update.
  pub built_for: Option<u16>,
  /// Its Start menu shortcut (Windows).
  pub shortcut: Option<String>,
}

/// Installed apps' backends and windows (Tauri managed state).
pub struct Apps {
  backends: LocalBackends,
  attached: AtomicBool,
  windows: Mutex<std::collections::HashMap<String, window::WindowState>>,
  /// Apps being installed or removed.
  busy: Mutex<HashSet<String>>,
  /// Apps whose start moved to another port because theirs was taken, until they run.
  moved: Mutex<HashSet<String>>,
  /// One start at a time per app ([`run`]).
  launching: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Default for Apps {
  fn default() -> Self {
    let settings = Settings {
      log_dir: Some(paths::logs_dir().join("apps")),
      policy: Policy { max_running: MAX_RUNNING, ..Policy::default() },
      ..Settings::default()
    };
    Self {
      backends: LocalBackends::new(settings),
      attached: AtomicBool::new(false),
      windows: Mutex::new(Default::default()),
      busy: Mutex::new(HashSet::new()),
      moved: Mutex::new(HashSet::new()),
      launching: Mutex::new(HashMap::new()),
    }
  }
}

/// Installed apps' backends, telling the app windows and the journal what happens.
fn backends(app: &AppHandle) -> LocalBackends {
  let apps = app.state::<Apps>();
  if !apps.attached.swap(true, Ordering::SeqCst) {
    apps.backends.attach_sink(sink(app));
  }
  apps.backends.clone()
}

fn sink(app: &AppHandle) -> Sink {
  let app = app.clone();
  Arc::new(move |emit| match emit {
    Emit::State(status) => {
      let _ = app.emit(APPS_STATE, &status);
      on_status(&app, &status);
    }
    Emit::Log(line) => {
      let _ = app.emit(APPS_LOG, &line);
    }
    Emit::Milestone { level, event, message, code, .. } => {
      if level != Level::Info {
        journal::entry(level, Area::Preview, event, &message)
          .operation("installed_app")
          .detail(code.map(|code| format!("code: {code}")))
          .write();
      }
    }
  })
}

/* ------------------------------ the records ------------------------------ */

fn app_dir(key: &str) -> PathBuf {
  paths::apps_dir().join(key)
}

/// The installed app's own folder, which rayfin-local serves.
pub(crate) fn code_dir(key: &str) -> PathBuf {
  app_dir(key).join(CODE)
}

pub(crate) fn read_record(key: &str) -> Option<Record> {
  if !export::valid_app_key(key) {
    return None;
  }
  let text = std::fs::read_to_string(app_dir(key).join(RECORD)).ok()?;
  serde_json::from_str::<Record>(&text).ok().filter(|r| r.key == key && code_dir(key).is_dir())
}

fn write_record(record: &Record) -> Result<(), String> {
  let file = app_dir(&record.key).join(RECORD);
  let partial = file.with_extension("json.partial");
  let json = serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?;
  std::fs::write(&partial, json)
    .and_then(|()| std::fs::rename(&partial, &file))
    .map_err(|e| format!("Couldn’t save what Fabricator knows about {}: {e}", record.name))
}

/// Every installed app, by name.
fn records() -> Vec<Record> {
  let Ok(entries) = std::fs::read_dir(paths::apps_dir()) else {
    return Vec::new();
  };
  let mut found: Vec<Record> =
    entries.flatten().filter_map(|entry| read_record(&entry.file_name().to_string_lossy())).collect();
  found.sort_by_key(|r| r.name.to_lowercase());
  found
}

fn data_url(png: &[u8]) -> String {
  use base64::Engine as _;
  format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

fn icon_of(key: &str) -> Option<Vec<u8>> {
  let file = app_dir(key).join(ICON_PNG);
  std::fs::metadata(&file).ok().filter(|m| m.len() <= export::MAX_ICON_BYTES)?;
  std::fs::read(file).ok()
}

fn info(app: &AppHandle, record: &Record) -> InstalledApp {
  InstalledApp {
    key: record.key.clone(),
    name: record.name.clone(),
    version: record.version.clone(),
    from: record.from.clone(),
    exported_at: record.exported_at.clone(),
    installed_at: record.installed_at.clone(),
    updated_at: record.updated_at.clone(),
    icon: icon_of(&record.key).map(|png| data_url(&png)),
    open: window::is_open(app, &record.key),
  }
}

/// A PNG as the pixels a window icon takes.
pub(crate) fn window_icon(png: &[u8]) -> Option<tauri::image::Image<'static>> {
  let (width, height) = export::png_size(png)?;
  if width == 0 || height == 0 || width > 1024 || height > 1024 {
    return None;
  }
  let mut decoder = ::png::Decoder::new(std::io::Cursor::new(png));
  decoder.set_transformations(::png::Transformations::normalize_to_color8() | ::png::Transformations::ALPHA);
  let mut reader = decoder.read_info().ok()?;
  let mut pixels = vec![0; reader.output_buffer_size()?];
  let frame = reader.next_frame(&mut pixels).ok()?;
  let pixels = &pixels[..frame.buffer_size()];
  let rgba = match frame.color_type {
    ::png::ColorType::Rgba => pixels.to_vec(),
    ::png::ColorType::GrayscaleAlpha => pixels.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
    _ => return None,
  };
  Some(tauri::image::Image::new_owned(rgba, frame.width, frame.height))
}

/* ------------------------- what the system opens -------------------------- */

/// Something Fabricator was asked to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
  /// A `.fabricator` file, which the workbench imports.
  Project(PathBuf),
  /// A `.rayfin` file, to install, or to run when it's what's installed.
  AppFile(PathBuf),
  /// An installed app, by its key (`--app <key>`, from its shortcut).
  App(String),
}

/// What a launch's arguments ask Fabricator to open: `.fabricator` and
/// `.rayfin` files that exist (relative ones resolved against `cwd`), and
/// installed apps (`--app <key>`).
pub fn opened_in<A: Into<OsString>>(args: impl IntoIterator<Item = A>, cwd: Option<&Path>) -> Vec<Opened> {
  let mut out = Vec::new();
  let mut args = args.into_iter().map(Into::into);
  while let Some(arg) = args.next() {
    if arg == APP_FLAG {
      let key = args.next().and_then(|key| key.into_string().ok());
      if let Some(key) = key.filter(|key| export::valid_app_key(key)) {
        out.push(Opened::App(key));
      }
      continue;
    }
    let path = PathBuf::from(arg);
    let path = match cwd {
      Some(cwd) if path.is_relative() => cwd.join(path),
      _ => path,
    };
    if !path.is_file() {
      continue;
    }
    if export::is_app_file(&path) {
      out.push(Opened::AppFile(path));
    } else if export::is_export(&path) {
      out.push(Opened::Project(path));
    }
  }
  out
}

/// Open an app file or an installed app in its window. Its own task: reading
/// the file takes a moment, and windows mustn't be made on the event loop.
pub fn open(app: &AppHandle, opened: Opened) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    match opened {
      Opened::AppFile(path) => open_file(&app, path).await,
      Opened::App(key) => {
        let record = read_record(&key);
        let title = record.as_ref().map(|r| r.name.clone()).unwrap_or_else(|| "Rayfin app".into());
        let error = record.is_none().then(|| NOT_INSTALLED.to_string());
        window::open(&app, &key, &title, icon_of(&key), None, error);
      }
      Opened::Project(_) => {}
    }
  });
}

async fn open_file(app: &AppHandle, path: PathBuf) {
  let from = path.clone();
  let read = tokio::task::spawn_blocking(move || export::read_app(&from)).await;
  match read.map_err(|e| e.to_string()).and_then(|read| read) {
    Ok(file) => {
      let key = file.manifest.key.clone();
      let installed = read_record(&key);
      // The file that's installed runs; any other asks first.
      let same = installed.as_ref().is_some_and(|r| r.exported_at.is_some() && r.exported_at == file.manifest.created_at);
      let icon = file.icon_png.clone().or_else(|| icon_of(&key));
      window::open(app, &key, &file.manifest.name, icon, (!same).then_some(path), None);
    }
    Err(error) => {
      let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
      window::open(app, "", &name, None, None, Some(error));
    }
  }
}

/* ------------------------------- the window ------------------------------- */

/// What the app window `label` is for, for Fabricator's page in it.
pub async fn window_info(app: &AppHandle, label: &str) -> AppWindowInfo {
  let Some((key, file, error)) = window::purpose(app, label) else {
    return AppWindowInfo { mode: "error".into(), error: Some("This window isn’t an app’s.".into()), ..Default::default() };
  };
  let status = backends(app).status(&key);
  let installed = read_record(&key).map(|record| info(app, &record));
  if let Some(error) = error {
    return AppWindowInfo { key, mode: "error".into(), error: Some(error), installed, status, ..Default::default() };
  }
  let Some(path) = file else {
    return match installed {
      Some(installed) => AppWindowInfo { key, mode: "run".into(), installed: Some(installed), status, ..Default::default() },
      None => AppWindowInfo { key, mode: "error".into(), error: Some(NOT_INSTALLED.into()), status, ..Default::default() },
    };
  };
  let from = path.clone();
  let read = tokio::task::spawn_blocking(move || export::read_app(&from)).await;
  match read.map_err(|e| e.to_string()).and_then(|read| read) {
    Ok(read) if read.manifest.key == key => {
      let file = AppFilePreview {
        path: path.to_string_lossy().to_string(),
        key: key.clone(),
        name: read.manifest.name.clone(),
        version: read.manifest.version.clone(),
        from: read.manifest.from.clone(),
        exported_at: read.manifest.created_at.clone(),
        files: read.files,
        bytes: read.bytes,
        secrets: read.secrets.clone(),
        icon: read.icon_png.as_deref().map(data_url),
      };
      let mode = if installed.is_some() { "update" } else { "install" };
      AppWindowInfo { key, mode: mode.into(), file: Some(file), installed, status, ..Default::default() }
    }
    Ok(_) => AppWindowInfo {
      key,
      mode: "error".into(),
      error: Some("That file holds a different app now. Open it again.".into()),
      installed,
      status,
      ..Default::default()
    },
    Err(error) => AppWindowInfo { key, mode: "error".into(), error: Some(error), installed, status, ..Default::default() },
  }
}

/* ------------------------------- installing ------------------------------- */

fn failed(code: &str, error: impl Into<String>) -> AppActionResult {
  AppActionResult { ok: false, code: Some(code.into()), error: Some(error.into()) }
}

fn done() -> AppActionResult {
  AppActionResult { ok: true, ..Default::default() }
}

/// Holds an app as busy (installing or removing) until dropped.
struct Busy {
  app: AppHandle,
  key: String,
}

impl Busy {
  fn take(app: &AppHandle, key: &str) -> Option<Self> {
    let taken = app.state::<Apps>().busy.lock().unwrap().insert(key.to_string());
    taken.then(|| Busy { app: app.clone(), key: key.to_string() })
  }
}

impl Drop for Busy {
  fn drop(&mut self) {
    self.app.state::<Apps>().busy.lock().unwrap().remove(&self.key);
  }
}

fn emit_progress(app: &AppHandle, key: &str, phase: &str, processed: u64, total: u64, line: Option<String>) {
  let event = AppProgressEvent { key: key.to_string(), phase: phase.to_string(), processed, total, line };
  let _ = app.emit(APPS_PROGRESS, event);
}

/// npm's output while it installs an app's packages, line by line.
fn package_lines(app: &AppHandle, key: &str) -> OnData {
  let (app, key) = (app.clone(), key.to_string());
  Arc::new(move |_: Stream, text: &str| {
    for line in text.lines().map(str::trim_end).filter(|line| !line.trim().is_empty()) {
      emit_progress(&app, &key, "packages", 0, 0, Some(line.to_string()));
    }
  })
}

/// A short random name for a folder.
fn short_id() -> String {
  uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// `f`, tried again for a few seconds while it fails: on Windows a folder an
/// antivirus or the indexer is reading can't be renamed for a moment.
fn patiently<T>(mut f: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
  let mut tries = 0;
  loop {
    match f() {
      Ok(value) => return Ok(value),
      Err(_) if tries < 20 => {
        tries += 1;
        std::thread::sleep(Duration::from_millis(150));
      }
      Err(error) => return Err(error),
    }
  }
}

/// Put the app unpacked in `incoming` in place of the one in `dir`, with the
/// replaced version's data. Its packages and build don't come along: the new
/// version may need others, so it gets its own.
fn swap_in(dir: &Path, incoming: &Path) -> Result<(), String> {
  let code = dir.join(CODE);
  if code.exists() {
    let data = code.join(".rayfin-local");
    if data.exists() && !incoming.join(".rayfin-local").exists() {
      patiently(|| std::fs::rename(&data, incoming.join(".rayfin-local")))
        .map_err(|e| format!("Couldn’t keep the app’s data from the version installed: {e}"))?;
    }
    let old = dir.join(format!(".old-{}", short_id()));
    patiently(|| std::fs::rename(&code, &old)).map_err(|e| format!("Couldn’t replace the version installed: {e}"))?;
    std::thread::spawn(move || {
      let _ = std::fs::remove_dir_all(&old);
    });
  }
  patiently(|| std::fs::rename(incoming, &code)).map_err(|e| format!("Couldn’t put the app in place: {e}"))
}

/// Unpack the app file at `path` (of the app `key`) into place, and record it.
fn install_file(app: &AppHandle, key: &str, path: &Path) -> Result<Record, String> {
  let mut file = export::read_app(path)?;
  if file.manifest.key != key {
    return Err("That file holds a different app now. Open it again.".into());
  }
  let dir = app_dir(key);
  std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn’t create {}: {e}", dir.display()))?;
  let incoming = dir.join(format!(".incoming-{}", short_id()));
  std::fs::create_dir(&incoming).map_err(|e| format!("Couldn’t create {}: {e}", incoming.display()))?;
  let unpacked = file
    .unpack_into(&incoming, |done, total| emit_progress(app, key, "unpacking", done, total, None))
    .and_then(|()| swap_in(&dir, &incoming));
  if let Err(error) = unpacked {
    let _ = std::fs::remove_dir_all(&incoming);
    return Err(error);
  }
  for (name, bytes) in [(ICON_PNG, &file.icon_png), (ICON_ICO, &file.icon_ico)] {
    match bytes {
      Some(bytes) => {
        let _ = std::fs::write(dir.join(name), bytes);
      }
      None => {
        let _ = std::fs::remove_file(dir.join(name));
      }
    }
  }
  let before = read_record(key);
  let now = now_iso();
  let manifest = &file.manifest;
  let record = Record {
    key: key.to_string(),
    name: manifest.name.clone(),
    version: manifest.version.clone(),
    from: manifest.from.clone(),
    exported_at: manifest.created_at.clone(),
    installed_at: before.as_ref().map(|r| r.installed_at.clone()).unwrap_or_else(|| now.clone()),
    updated_at: now,
    port: before.as_ref().and_then(|r| r.port),
    built_for: None,
    shortcut: before.and_then(|r| r.shortcut),
  };
  write_record(&record)?;
  Ok(record)
}

/// Install the app file the window `label` was opened with, in place of the
/// version installed, if any. The window then runs it (see [`run`]).
pub async fn install(app: &AppHandle, label: &str) -> AppActionResult {
  let Some((key, Some(path), None)) = window::purpose(app, label) else {
    return failed("not-installed", "There’s no app file to install in this window.");
  };
  let Some(_busy) = Busy::take(app, &key) else {
    return failed("busy", "Fabricator is already installing this app.");
  };
  // Its files are about to change.
  backends(app).stop(&key).await;
  let (handle, k, p) = (app.clone(), key.clone(), path.clone());
  let installed = tokio::task::spawn_blocking(move || install_file(&handle, &k, &p)).await;
  let record = match installed.map_err(|e| e.to_string()).and_then(|r| r) {
    Ok(record) => record,
    Err(error) => {
      journal::entry(Level::Warn, Area::Project, "app.install.failed", &error).operation("installed_app").write();
      return failed("install-failed", error);
    }
  };
  let record = shell::ensure_shortcut(record).await;
  let _ = write_record(&record);
  window::installed(app, label, &record.name, icon_of(&key));
  let from = record.from.as_deref().map(|f| format!(", exported by {f}")).unwrap_or_default();
  journal::entry(Level::Info, Area::Project, "app.installed", &format!("Installed the app \"{}\"{from}.", record.name))
    .operation("installed_app")
    .write();
  let _ = app.emit(APPS_CHANGED, ());
  done()
}

/* -------------------------------- running -------------------------------- */

/// Checking a port binds it for a moment, so two checks at once can each find
/// it taken: ports are chosen one at a time.
static CHOOSING_PORT: Mutex<()> = Mutex::new(());

/// The port to serve the app on: its own while it's free, else the first
/// free one no other installed app has.
fn choose_port(key: &str, current: Option<u16>) -> Option<u16> {
  let _choosing = CHOOSING_PORT.lock().unwrap_or_else(PoisonError::into_inner);
  if let Some(port) = current.filter(|port| local_ports::is_free(*port)) {
    return Some(port);
  }
  let taken: HashSet<u16> = records().into_iter().filter(|r| r.key != key).filter_map(|r| r.port).collect();
  PORTS.filter(|port| !taken.contains(port) && Some(*port) != current).find(|port| local_ports::is_free(*port))
}

/// Start the app of the window `label` (see [`run`]): the version installed,
/// even when the window was opened with a file of another version.
pub async fn run_window(app: &AppHandle, label: &str) -> AppActionResult {
  let Some((key, file, None)) = window::purpose(app, label).filter(|(key, _, _)| !key.is_empty()) else {
    return failed("not-installed", NOT_INSTALLED);
  };
  if file.is_some() {
    if read_record(&key).is_none() {
      return failed("not-installed", "Install the app first.");
    }
    window::forget_file(app, label);
  }
  run(app, &key).await
}

/// The last lines of the window `label`'s app's output, oldest first.
pub fn logs(app: &AppHandle, label: &str) -> Vec<crate::types::LocalLogEvent> {
  match window::purpose(app, label) {
    Some((key, _, _)) if !key.is_empty() => backends(app).logs(&key, crate::services::local_backend::DEFAULT_LOG_LINES),
    _ => Vec::new(),
  }
}

/// Node.js is on `PATH`, looking again for one installed since Fabricator started.
fn has_node() -> bool {
  if which::which("node").is_ok() && which::which("npm").is_ok() {
    return true;
  }
  crate::services::env_path::repair();
  which::which("node").is_ok() && which::which("npm").is_ok()
}

/// Start the installed app unless it runs: its npm packages first, when
/// they're missing, then its backend. Its window shows it once it's ready.
pub async fn run(app: &AppHandle, key: &str) -> AppActionResult {
  // A second start waits for the first, then finds the app starting: two
  // would install its packages at once, and the second, finding the port the
  // first took, would move the app off it.
  let launch = app.state::<Apps>().launching.lock().unwrap().entry(key.to_string()).or_default().clone();
  let _launching = launch.lock().await;
  let Some(mut record) = read_record(key) else {
    return failed("not-installed", NOT_INSTALLED);
  };
  if app.state::<Apps>().busy.lock().unwrap().contains(key) {
    return failed("busy", "Fabricator is installing this app. Try again in a moment.");
  }
  let backends = backends(app);
  let status = backends.status(key);
  match status.state {
    LocalBackendState::Running if status.ready.is_some() => {
      on_status(app, &status);
      return done();
    }
    LocalBackendState::Starting | LocalBackendState::Restarting => return done(),
    _ => {}
  }
  if !tokio::task::spawn_blocking(has_node).await.unwrap_or(false) {
    return failed("node-missing", "This app runs on Node.js, which isn’t installed on this computer.");
  }
  let dir = code_dir(key);
  if !dir.join("node_modules").is_dir() {
    emit_progress(app, key, "packages", 0, 0, None);
  }
  let output = package_lines(app, key);
  let packages = match crate::services::exec::ensure_project_dependencies(&dir, Some(output.clone())).await {
    Ok(()) => crate::commands::projects_impl::ensure_functions_dependencies(&dir, Some(output)).await,
    Err(error) => Err(error),
  };
  if let Err(error) = packages {
    return failed("install-failed", error);
  }
  let Some(port) = choose_port(key, record.port) else {
    return failed("no-port", "Every port Fabricator runs apps on is in use. Close some apps, then try again.");
  };
  if record.port != Some(port) {
    record.port = Some(port);
    record.built_for = None;
    if let Err(error) = write_record(&record) {
      log::warn!("{error}");
    }
  }
  let reuse_build = record.built_for == Some(port) && backends.reuses_builds().await;
  let serve = ServeMode { static_build: true, reuse_build, port: Some(port), ..Default::default() };
  backends.start(key, dir, LocalStartOptions { serve, ..Default::default() }).await;
  done()
}

/// Where the window shows the app once it's ready: the app, or for an app
/// that signs in only inside Fabric, the local Fabric host that frames it.
fn app_url(key: &str, ready: &LocalReady) -> Option<Url> {
  let framed = crate::commands::fabric::needs_fabric_portal(&code_dir(key));
  let url = if framed { ready.embed_url.as_ref().or(ready.app_url.as_ref()) } else { ready.app_url.as_ref() };
  Url::parse(url?).ok()
}

/// An installed app's backend changed: show the app once it's ready, and
/// Fabricator's page again when it stops on an error.
fn on_status(app: &AppHandle, status: &LocalStatus) {
  let key = status.project_id.as_str();
  match status.state {
    LocalBackendState::Running => {
      let Some(ready) = status.ready.as_ref() else { return };
      let Some(url) = app_url(key, ready) else { return };
      app.state::<Apps>().moved.lock().unwrap().remove(key);
      // The build it serves is for the port it serves on.
      let port = Url::parse(&ready.api_url).ok().and_then(|api| api.port());
      if let Some(record) = read_record(key).filter(|r| port.is_some() && (r.port != port || r.built_for != port)) {
        let _ = write_record(&Record { port, built_for: port, ..record });
      }
      window::show_app(app, key, url);
    }
    LocalBackendState::Error => {
      let code = status.error.as_ref().map(|e| e.code.as_str()).unwrap_or_default();
      // Something took its port since it last ran: move, once.
      if code == "port-in-use" && app.state::<Apps>().moved.lock().unwrap().insert(key.to_string()) {
        let (app, key) = (app.clone(), key.to_string());
        tauri::async_runtime::spawn(async move {
          if let Some(mut record) = read_record(&key) {
            let current = record.port;
            record.port = choose_port(&key, None).filter(|port| Some(*port) != current);
            record.built_for = None;
            let _ = write_record(&record);
          }
          if !run(&app, &key).await.ok {
            window::show_launcher(&app, &key);
          }
        });
        return;
      }
      window::show_launcher(app, key);
    }
    _ => {}
  }
}

/* --------------------------- listing, removing --------------------------- */

/// Every installed app, by name.
pub fn list(app: &AppHandle) -> Vec<InstalledApp> {
  records().iter().map(|record| info(app, record)).collect()
}

/// Remove an installed app: close its window, stop it, and delete it, its data
/// and its shortcut.
pub async fn remove(app: &AppHandle, key: &str) -> AppActionResult {
  let Some(record) = read_record(key) else {
    return failed("not-installed", NOT_INSTALLED);
  };
  let Some(_busy) = Busy::take(app, key) else {
    return failed("busy", "Fabricator is installing this app. Try again in a moment.");
  };
  window::close(app, key);
  backends(app).forget(key).await;
  if let Some(shortcut) = record.shortcut.as_deref() {
    shell::remove_shortcut(Path::new(shortcut));
  }
  let dir = app_dir(key);
  let gone = paths::apps_dir().join(format!(".removed-{}", short_id()));
  let removed = tokio::task::spawn_blocking(move || {
    patiently(|| std::fs::rename(&dir, &gone))?;
    std::fs::remove_dir_all(&gone)
  })
  .await;
  let _ = app.emit(APPS_CHANGED, ());
  match removed.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())) {
    Ok(()) => {
      journal::entry(Level::Info, Area::Project, "app.removed", &format!("Removed the app \"{}\".", record.name))
        .operation("installed_app")
        .write();
      done()
    }
    Err(error) => failed("remove-failed", format!("Couldn’t delete {}: {error}", record.name)),
  }
}

/// Remove what installs, updates and removals left when Fabricator stopped
/// part way. Blocks: run it off the main thread.
pub fn clean_up() {
  let Ok(entries) = std::fs::read_dir(paths::apps_dir()) else {
    return;
  };
  for entry in entries.flatten() {
    if entry.file_name().to_string_lossy().starts_with(".removed-") {
      let _ = std::fs::remove_dir_all(entry.path());
      continue;
    }
    let Ok(inside) = std::fs::read_dir(entry.path()) else { continue };
    for leftover in inside.flatten() {
      let name = leftover.file_name().to_string_lossy().to_string();
      if name.starts_with(".incoming-") || name.starts_with(".old-") {
        let _ = std::fs::remove_dir_all(leftover.path());
      }
    }
  }
}

/// Stop every installed app's backend as Fabricator exits.
pub fn kill_all(app: &AppHandle) {
  if let Some(apps) = app.try_state::<Apps>() {
    apps.backends.kill_all();
  }
}

/// Stop every installed app's backend and wait, before an update replaces rayfin-local.
pub async fn stop_all(app: &AppHandle) {
  let Some(backends) = app.try_state::<Apps>().map(|apps| apps.backends.clone()) else {
    return;
  };
  backends.stop_all().await;
}

/// Stop the app's backend: its window closed.
fn stop(app: &AppHandle, key: &str) {
  let backends = app.state::<Apps>().backends.clone();
  let key = key.to_string();
  tauri::async_runtime::spawn(async move {
    backends.stop(&key).await;
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn launches_choosing_a_port_at_once_agree() {
    let port = PORTS.rev().find(|port| local_ports::is_free(*port)).expect("a free port");
    let together = std::sync::Barrier::new(8);
    let chosen: Vec<Option<u16>> = std::thread::scope(|scope| {
      let launches: Vec<_> = (0..8)
        .map(|_| {
          scope.spawn(|| {
            together.wait();
            choose_port("notes-1a2b3c4d", Some(port))
          })
        })
        .collect();
      launches.into_iter().map(|launch| launch.join().unwrap()).collect()
    });
    assert_eq!(chosen, vec![Some(port); 8], "a launch found the port taken by another one's check");
  }

  #[test]
  fn a_launch_opens_app_files_projects_and_installed_apps() {
    let dir = std::env::temp_dir().join(format!("fab-apps-args-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    for file in ["Notes.rayfin", "Toy.FABRICATOR", "photos.zip"] {
      std::fs::write(dir.join(file), "zip").unwrap();
    }
    let args: Vec<OsString> = vec![
      "Notes.rayfin".into(),
      "Toy.FABRICATOR".into(),
      "missing.rayfin".into(),
      "photos.zip".into(),
      "--app".into(),
      "notes-1a2b3c4d".into(),
      "--app".into(),
      "../escape".into(),
      "--flag".into(),
    ];
    assert_eq!(
      opened_in(args, Some(&dir)),
      vec![
        Opened::AppFile(dir.join("Notes.rayfin")),
        Opened::Project(dir.join("Toy.FABRICATOR")),
        Opened::App("notes-1a2b3c4d".into()),
      ]
    );
    assert!(opened_in(["--app"], None).is_empty(), "a flag without its key");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn an_update_keeps_the_apps_data_and_nothing_else() {
    let dir = std::env::temp_dir().join(format!("fab-apps-swap-{}", uuid::Uuid::new_v4()));
    let code = dir.join(CODE);
    std::fs::create_dir_all(code.join(".rayfin-local")).unwrap();
    std::fs::create_dir_all(code.join("node_modules").join("react")).unwrap();
    std::fs::create_dir_all(code.join("dist")).unwrap();
    std::fs::write(code.join(".rayfin-local").join("db.sqlite"), "rows").unwrap();
    std::fs::write(code.join("version.txt"), "1").unwrap();
    let incoming = dir.join(".incoming-test");
    std::fs::create_dir_all(&incoming).unwrap();
    std::fs::write(incoming.join("version.txt"), "2").unwrap();

    swap_in(&dir, &incoming).unwrap();
    assert_eq!(std::fs::read_to_string(code.join("version.txt")).unwrap(), "2");
    assert_eq!(std::fs::read_to_string(code.join(".rayfin-local").join("db.sqlite")).unwrap(), "rows");
    assert!(!code.join("node_modules").exists() && !code.join("dist").exists(), "the new version gets its own");
    assert!(!incoming.exists());

    // A first install has nothing to keep.
    let fresh = dir.join("fresh");
    let incoming = fresh.join(".incoming-test");
    std::fs::create_dir_all(&incoming).unwrap();
    swap_in(&fresh, &incoming).unwrap();
    assert!(fresh.join(CODE).is_dir());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn window_icons_come_from_the_apps_png() {
    // A 2×1 RGBA PNG.
    let mut png = Vec::new();
    {
      let mut encoder = ::png::Encoder::new(&mut png, 2, 1);
      encoder.set_color(::png::ColorType::Rgba);
      encoder.set_depth(::png::BitDepth::Eight);
      let mut writer = encoder.write_header().unwrap();
      writer.write_image_data(&[255, 0, 0, 255, 0, 0, 255, 128]).unwrap();
    }
    let icon = window_icon(&png).expect("an icon");
    assert_eq!((icon.width(), icon.height()), (2, 1));
    assert_eq!(icon.rgba(), &[255, 0, 0, 255, 0, 0, 255, 128]);
    assert!(window_icon(b"not a png").is_none());
  }
}
