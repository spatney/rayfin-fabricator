//! Cross-platform process runner — the Rust counterpart to `src/main/services/exec.ts`.
//!
//! On Windows the npm-distributed `rayfin` CLI is a `.cmd` shim. Spawning a
//! `.cmd` through `std`/`tokio` routes it via `cmd.exe`, which mangles arguments
//! containing `&` `|` `^` `<` `>` and *rejects* arguments containing newlines
//! outright. We therefore resolve the shim to its underlying `node <script>`
//! invocation and spawn `node.exe` (a real executable) directly, so arbitrary
//! argument text is delivered verbatim. Other tools are resolved on `PATH` via
//! the `which` crate (which also yields a clean "not found" signal). The Copilot
//! CLI no longer goes through here — the GitHub Copilot SDK drives its own
//! bundled binary (see [`crate::services::copilot`]); only `login` and the
//! version probe still spawn it, by absolute path via [`run_program`].

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Notify};

/// Serialize recovery installs per project. Fabric can request workspaces and
/// capacities close together; running two `npm install`s in one project would
/// corrupt its lockfile, while separate projects can prepare independently.
static PROJECT_DEPENDENCY_INSTALL_LOCKS: Lazy<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
  Lazy::new(|| Mutex::new(HashMap::new()));

/// Which output stream a chunk came from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stream {
  Stdout,
  Stderr,
  System,
}

impl Stream {
  pub fn as_str(self) -> &'static str {
    match self {
      Stream::Stdout => "stdout",
      Stream::Stderr => "stderr",
      Stream::System => "system",
    }
  }
}

/// Streaming callback invoked with each output chunk.
pub type OnData = Arc<dyn Fn(Stream, &str) + Send + Sync>;

/// Cooperative cancel handle for an in-flight process (e.g. a chat turn's stop
/// button). Cloneable; cancelling kills the spawned child.
#[derive(Clone, Default)]
pub struct CancelToken {
  cancelled: Arc<AtomicBool>,
  notify: Arc<Notify>,
}

impl CancelToken {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn cancel(&self) {
    self.cancelled.store(true, Ordering::SeqCst);
    self.notify.notify_waiters();
  }

  pub fn is_cancelled(&self) -> bool {
    self.cancelled.load(Ordering::SeqCst)
  }

  /// True when both handles refer to the *same* underlying token. Used by the
  /// per-project cancel maps so a stale run that is finishing up can't clear a
  /// newer run's slot (which would otherwise leave the newer run uncancellable).
  pub fn same(&self, other: &CancelToken) -> bool {
    Arc::ptr_eq(&self.cancelled, &other.cancelled)
  }

  /// Resolves when this token is cancelled (or immediately if already
  /// cancelled). Lets async consumers `select!` on cancellation — e.g. the
  /// chat turn loop aborts the live Copilot session when the user hits stop.
  pub async fn wait_cancelled(&self) {
    if self.is_cancelled() {
      return;
    }
    self.notify.notified().await;
  }
}

#[derive(Default)]
pub struct RunOptions {
  pub cwd: Option<PathBuf>,
  pub env: Vec<(String, String)>,
  /// Environment variables to remove from the child process. This is useful
  /// when a CLI gives ambient variables precedence over its persisted login.
  pub env_remove: Vec<String>,
  pub on_data: Option<OnData>,
  pub timeout_ms: Option<u64>,
  pub cancel: Option<CancelToken>,
  /// Text written to the child's stdin, which is then closed. Use it for
  /// sensitive input (a secret's value) that must not appear in the arguments,
  /// which other processes on the machine can read. Without it stdin is empty.
  pub stdin: Option<String>,
}

impl RunOptions {
  pub fn timeout(ms: u64) -> Self {
    RunOptions {
      timeout_ms: Some(ms),
      ..Default::default()
    }
  }
}

pub struct RunResult {
  pub ok: bool,
  pub exit_code: Option<i32>,
  pub stdout: String,
  pub stderr: String,
  /// True when the executable could not be found on PATH.
  pub not_found: bool,
}

/// A resolved program plus any prefix args (e.g. the node script for a shim).
struct Resolved {
  program: PathBuf,
  prefix: Vec<PathBuf>,
  not_found: bool,
}

/// Extract the `node` target script from an npm cmd-shim (`*.cmd`). The shim's
/// final line is `... & "%_prog%"  "%dp0%\node_modules\...\entry.js" %*`.
static SHIM_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r#""%~?dp0%\\?([^"]+)"\s+%\*"#).unwrap());

fn parse_shim(cmd_path: &Path) -> Option<PathBuf> {
  let content = std::fs::read_to_string(cmd_path).ok()?;
  let caps = SHIM_RE.captures(&content)?;
  let rel = caps.get(1)?.as_str().replace('/', "\\");
  let dir = cmd_path.parent()?;
  Some(dir.join(rel))
}

fn is_batch(path: &Path) -> bool {
  matches!(
    path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
    Some(ref e) if e == "cmd" || e == "bat"
  )
}

/// Resolve the npm-installed `rayfin` CLI to a direct `node <script>`
/// invocation, bypassing the fragile `.cmd` shim.
fn node_bypass(name: &str) -> Option<Resolved> {
  let cmd = which::which(name).ok()?;
  if is_batch(&cmd) {
    let script = parse_shim(&cmd)?;
    let node = which::which("node").ok()?;
    Some(Resolved {
      program: node,
      prefix: vec![script],
      not_found: false,
    })
  } else {
    // Already a real executable on this platform — run it directly.
    Some(Resolved {
      program: cmd,
      prefix: vec![],
      not_found: false,
    })
  }
}

fn which_resolved(file: &str) -> Resolved {
  match which::which(file) {
    Ok(p) => Resolved {
      program: p,
      prefix: vec![],
      not_found: false,
    },
    Err(_) => Resolved {
      program: PathBuf::from(file),
      prefix: vec![],
      not_found: true,
    },
  }
}

fn resolve_program(file: &str) -> Resolved {
  match file {
    "rayfin" => node_bypass(file).unwrap_or_else(|| which_resolved(file)),
    _ => which_resolved(file),
  }
}

/// Resolve the global rayfin-cli's auth entry module (`dist/auth/index.js`),
/// reusing the same CLI the app already drives. Derives the global package root
/// from the `rayfin` bin on PATH so we never have to spawn the non-bypassable
/// `npm` cmd-shim. Handles the Windows layout (`<binDir>/node_modules/...`), the
/// Unix layout (`<prefix>/lib/node_modules/...`), and symlinked bins (macOS/Linux
/// nvm/Homebrew). Returns the first existing candidate, or `None` when the CLI
/// can't be located.
pub fn global_rayfin_auth_module() -> Option<PathBuf> {
  let shim = which::which("rayfin").ok()?;
  let mut candidates: Vec<PathBuf> = Vec::new();
  if let Some(bin_dir) = shim.parent() {
    // Windows npm global layout: <binDir>/node_modules/@microsoft/rayfin-cli/...
    candidates.push(
      bin_dir
        .join("node_modules")
        .join("@microsoft")
        .join("rayfin-cli")
        .join("dist")
        .join("auth")
        .join("index.js"),
    );
    // Unix npm global layout: the bin lives in <prefix>/bin while the package is
    // installed under <prefix>/lib/node_modules (covers nvm, Homebrew, system).
    if let Some(prefix) = bin_dir.parent() {
      candidates.push(
        prefix
          .join("lib")
          .join("node_modules")
          .join("@microsoft")
          .join("rayfin-cli")
          .join("dist")
          .join("auth")
          .join("index.js"),
      );
    }
  }
  // Or derive from the cmd-shim's node target (<pkgRoot>/scripts/main.js).
  if is_batch(&shim) {
    if let Some(script) = parse_shim(&shim) {
      if let Some(pkg_root) = script.parent().and_then(|p| p.parent()) {
        candidates.push(pkg_root.join("dist").join("auth").join("index.js"));
      }
    }
  }
  // On macOS/Linux the bin is a symlink into the package (e.g.
  // <pkgRoot>/scripts/main); resolve it to the real script and walk up to the
  // package root, then locate the auth entry module.
  if let Ok(real) = std::fs::canonicalize(&shim) {
    if let Some(pkg_root) = real.parent().and_then(|p| p.parent()) {
      candidates.push(pkg_root.join("dist").join("auth").join("index.js"));
    }
  }
  candidates.into_iter().find(|p| p.exists())
}

fn local_rayfin_cli_dir(project_dir: &Path) -> PathBuf {
  project_dir
    .join("node_modules")
    .join("@microsoft")
    .join("rayfin-cli")
}

fn local_rayfin_auth_module(project_dir: &Path) -> PathBuf {
  local_rayfin_cli_dir(project_dir)
    .join("dist")
    .join("auth")
    .join("index.js")
}

/// True when the project has the local CLI pieces Fabricator needs for both
/// `rayfin` commands and silent Fabric authentication.
pub fn project_rayfin_cli_installed(project_dir: &Path) -> bool {
  let cli_dir = local_rayfin_cli_dir(project_dir);
  local_rayfin_auth_module(project_dir).is_file()
    && ["main.js", "main"]
      .iter()
      .any(|entry| cli_dir.join("scripts").join(entry).is_file())
}

/// Deeper than any real npm tree; stops a folder that loops back on itself
/// from being walked forever.
const MAX_PACKAGE_NESTING: usize = 12;

/// npm's record of the packages its last install placed on disk. npm writes
/// `node_modules/.package-lock.json` when an install finishes.
#[derive(Deserialize)]
struct InstalledPackages {
  #[serde(default)]
  packages: HashMap<String, serde::de::IgnoredAny>,
}

/// The project's installed packages that can't load, as locations like
/// `node_modules/commander` or `node_modules/a/node_modules/@scope/b`:
///
/// - package folders without a `package.json`. npm creates every package's
///   folder before it unpacks any of them, so an install stopped part way (a
///   timeout, a closed app) leaves empty folders behind, and a sync or
///   antivirus tool that deletes files can do the same. Node reports these as
///   "Cannot find package '<folder>\index.js'".
/// - packages npm recorded installing whose folder is gone, which Node reports
///   as "Cannot find package '<name>'".
///
/// `npm install` repairs both: it unpacks a package again when its folder has
/// no manifest, and adds a missing one back.
fn incomplete_packages(project_dir: &Path) -> Vec<String> {
  let mut found = Vec::new();
  collect_packages(&project_dir.join("node_modules"), "node_modules", 0, &mut found);
  let mut incomplete: BTreeSet<String> =
    found.iter().filter(|(_, complete)| !complete).map(|(location, _)| location.clone()).collect();
  let present: HashSet<&str> =
    found.iter().filter(|(_, complete)| *complete).map(|(location, _)| location.as_str()).collect();
  for location in recorded_packages(project_dir) {
    // The walk doesn't reach every recorded location (a workspace keeps its
    // own node_modules), so check the rest directly.
    if !present.contains(location.as_str()) && !project_dir.join(&location).join("package.json").is_file() {
      incomplete.insert(location);
    }
  }
  incomplete.into_iter().collect()
}

/// [`incomplete_packages`] off the async runtime, since it walks the whole tree.
async fn find_incomplete_packages(project_dir: &Path) -> Vec<String> {
  let dir = project_dir.to_path_buf();
  tokio::task::spawn_blocking(move || incomplete_packages(&dir))
    .await
    .unwrap_or_default()
}

/// How long a project's incomplete packages must go untouched before
/// [`ensure_project_dependencies`] repairs them, how often it looks again, and
/// how long it waits at most.
const QUIET_FOR: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 30 });
const QUIET_CHECK: Duration = Duration::from_secs(2);
const QUIET_LIMIT: Duration = Duration::from_secs(300);

/// The package folders Fabricator marked for reinstall itself, and when.
/// Removing a `package.json` changes its folder, which mustn't read as an
/// install at work; a change after that still does.
static MARKED_FOR_REINSTALL: Lazy<std::sync::Mutex<HashMap<PathBuf, SystemTime>>> =
  Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

/// Leeway for a file system that rounds its times (FAT keeps two seconds).
const MARK_LEEWAY: Duration = Duration::from_secs(2);

/// The project's incomplete packages once nothing has touched them for
/// [`QUIET_FOR`]. An install that's running (Copilot's, or one in a terminal)
/// creates every package folder first and fills them as it goes, writing each
/// `package.json` near the end, and a second npm working in the same tree would
/// undo its work. The leftovers of an install that stopped are quiet already.
async fn quiet_incomplete_packages(project_dir: &Path, on_data: Option<&OnData>) -> Result<Vec<String>, String> {
  let started = tokio::time::Instant::now();
  let mut announced = false;
  loop {
    let dir = project_dir.to_path_buf();
    let (incomplete, untouched) = tokio::task::spawn_blocking(move || {
      let incomplete = incomplete_packages(&dir);
      let untouched = untouched_for(&dir, &incomplete);
      (incomplete, untouched)
    })
    .await
    .unwrap_or_default();
    if incomplete.is_empty() || untouched >= QUIET_FOR {
      return Ok(incomplete);
    }
    if started.elapsed() >= QUIET_LIMIT {
      return Err("Another package install is still running in this project. Try again when it finishes.".to_string());
    }
    if !announced {
      announced = true;
      if let Some(on) = on_data {
        on(Stream::System, "Waiting for changes to this project's packages to finish...\n");
      }
    }
    tokio::time::sleep(QUIET_CHECK.min(QUIET_FOR - untouched)).await;
  }
}

/// How long it's been since anything changed in the folders of the
/// `incomplete` packages, or, for one that's gone, in the folder that held it.
fn untouched_for(project_dir: &Path, incomplete: &[String]) -> Duration {
  let marked = MARKED_FOR_REINSTALL.lock().map(|marked| marked.clone()).unwrap_or_default();
  let mut budget = 20_000;
  let newest = incomplete
    .iter()
    .filter_map(|location| {
      let dir = project_dir.join(location);
      let changed = if dir.is_dir() {
        last_change_within(&dir, &mut budget)
      } else {
        dir.parent().and_then(last_change)
      };
      match (changed, marked.get(&dir)) {
        (Some(changed), Some(&at)) if changed <= at + MARK_LEEWAY => None,
        _ => changed,
      }
    })
    .max();
  // A time in the future is a skewed clock, not activity.
  newest
    .and_then(|time| SystemTime::now().duration_since(time).ok())
    .unwrap_or(Duration::MAX)
}

/// When `path` was last written or created.
fn last_change(path: &Path) -> Option<SystemTime> {
  let meta = std::fs::symlink_metadata(path).ok()?;
  meta.modified().ok().max(meta.created().ok())
}

/// The latest [`last_change`] of `dir` and everything in it, looking at no
/// more than `budget` entries and without following links.
fn last_change_within(dir: &Path, budget: &mut usize) -> Option<SystemTime> {
  let mut newest = last_change(dir);
  let Ok(entries) = std::fs::read_dir(dir) else {
    return newest;
  };
  for entry in entries.flatten() {
    if *budget == 0 {
      break;
    }
    *budget -= 1;
    let path = entry.path();
    let changed = match entry.file_type() {
      Ok(kind) if kind.is_dir() => last_change_within(&path, budget),
      _ => last_change(&path),
    };
    newest = newest.max(changed);
  }
  newest
}

/// Add each package folder in the `node_modules` folder `dir` (at `location`
/// in the project) to `found`, with whether it has a `package.json`, then the
/// packages nested in it.
fn collect_packages(dir: &Path, location: &str, depth: usize, found: &mut Vec<(String, bool)>) {
  if depth > MAX_PACKAGE_NESTING {
    return;
  }
  for (name, path, linked) in package_folders(dir) {
    if name.starts_with('@') {
      for (scoped, path, linked) in package_folders(&path) {
        collect_package(&path, &format!("{location}/{name}/{scoped}"), linked, depth, found);
      }
    } else {
      collect_package(&path, &format!("{location}/{name}"), linked, depth, found);
    }
  }
}

fn collect_package(dir: &Path, location: &str, linked: bool, depth: usize, found: &mut Vec<(String, bool)>) {
  found.push((location.to_string(), dir.join("package.json").is_file()));
  // A linked package (an npm workspace) keeps its dependencies with its source.
  if !linked {
    collect_packages(&dir.join("node_modules"), &format!("{location}/node_modules"), depth + 1, found);
  }
}

/// The folders in `dir` that can hold a package or a scope, with whether each
/// is a link. Names starting with `.` never do: they're npm's own (`.bin`),
/// tool caches (`.vite`, `.cache`) or folders an interrupted npm install set
/// aside (`.name-1a2b3c4d`).
fn package_folders(dir: &Path) -> Vec<(String, PathBuf, bool)> {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return Vec::new();
  };
  entries
    .flatten()
    .filter_map(|entry| {
      let name = entry.file_name().into_string().ok()?;
      let file_type = entry.file_type().ok()?;
      let path = entry.path();
      let linked = file_type.is_symlink();
      let folder = file_type.is_dir() || (linked && path.is_dir());
      (folder && !name.starts_with('.')).then_some((name, path, linked))
    })
    .collect()
}

/// The package locations npm recorded at the end of its last install.
fn recorded_packages(project_dir: &Path) -> Vec<String> {
  let record = project_dir.join("node_modules").join(".package-lock.json");
  let Some(installed) = std::fs::read_to_string(record)
    .ok()
    .and_then(|text| serde_json::from_str::<InstalledPackages>(&text).ok())
  else {
    return Vec::new();
  };
  installed
    .packages
    .into_keys()
    .filter(|location| is_installed_location(location))
    .collect()
}

/// Whether an npm lockfile location, like `node_modules/x` or
/// `packages/app/node_modules/@s/x`, is a package installed inside the project,
/// rather than the project itself, a workspace's source folder or a path that
/// leaves the project.
fn is_installed_location(location: &str) -> bool {
  let parts: Vec<&str> = location.split('/').collect();
  parts.len() >= 2
    && parts[..parts.len() - 1].contains(&"node_modules")
    && parts
      .iter()
      .all(|part| !part.is_empty() && *part != "." && *part != ".." && !part.contains(['\\', ':']))
}

/// Package locations as names for a message, like `commander, @azure/msal-node
/// and 3 more`.
fn package_names(locations: &[String]) -> String {
  const SHOWN: usize = 4;
  let mut names = locations
    .iter()
    .take(SHOWN)
    .map(|location| location.strip_prefix("node_modules/").unwrap_or(location))
    .collect::<Vec<_>>()
    .join(", ");
  if locations.len() > SHOWN {
    names.push_str(&format!(" and {} more", locations.len() - SHOWN));
  }
  names
}

/// Node's report of a module it couldn't load: what it looked for, then the
/// file that asked for it (`imported from <file>` for an ES module, the first
/// `Require stack` entry for CommonJS).
static MODULE_NOT_FOUND_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(concat!(
    r"Cannot find (?:package|module) '([^'\r\n]+)'",
    r"(?: imported from ([^\r\n]+)|[^\r\n]*\r?\n[ \t]*Require stack:[ \t]*\r?\n[ \t]*- ([^\r\n]+))?",
  ))
  .unwrap()
});

/// When `output` shows Node failing to load a file of a package installed in
/// `project_dir`, mark each such package incomplete, so the next
/// [`ensure_project_dependencies`] reinstalls it. Returns their locations.
///
/// A package folder without a `package.json` is already incomplete. One that
/// lost other files (to a sync or antivirus tool, say) still looks installed,
/// and `npm install` would leave it as it is; removing its `package.json` makes
/// npm unpack it again. A package missing outright, which Node names rather
/// than a file in it, is for [`incomplete_packages`] to find.
fn invalidate_unloadable_packages(project_dir: &Path, output: &str) -> Vec<String> {
  let mut marked = BTreeSet::new();
  for caps in MODULE_NOT_FOUND_RE.captures_iter(output) {
    let importer = caps.get(2).or_else(|| caps.get(3)).map(|m| m.as_str());
    // A file the project's own code asked for is that code's mistake, not the install's.
    if importer.is_some_and(|importer| installed_package_of(project_dir, &reported_path(importer)).is_none()) {
      continue;
    }
    let Some(file) = unloadable_file(&caps[1], importer) else {
      continue;
    };
    let Some((dir, location)) = installed_package_of(project_dir, &file) else {
      continue;
    };
    // Never reach through a link: behind a linked package (an npm workspace, a
    // `file:` dependency or `npm link`) is the user's own source, which npm
    // can't put back.
    if !installed_in_place(project_dir, &location) {
      continue;
    }
    let manifest = dir.join("package.json");
    if manifest.is_file() {
      if let Err(error) = std::fs::remove_file(&manifest) {
        log::warn!("Couldn't mark {location} for reinstall: {error}");
        continue;
      }
      if let Ok(mut marks) = MARKED_FOR_REINSTALL.lock() {
        marks.insert(dir, SystemTime::now());
      }
    }
    marked.insert(location);
  }
  marked.into_iter().collect()
}

/// Whether every folder from the project's `node_modules` down to the package
/// at `location` is a real folder, not a link.
fn installed_in_place(project_dir: &Path, location: &str) -> bool {
  let mut path = project_dir.to_path_buf();
  location.split('/').all(|part| {
    path.push(part);
    std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir())
  })
}

/// The file Node couldn't load: the path it reported, or a relative import
/// resolved against the file that made it. `None` for a package name.
fn unloadable_file(specifier: &str, importer: Option<&str>) -> Option<PathBuf> {
  let path = reported_path(specifier);
  if path.is_absolute() {
    return Some(path);
  }
  let relative = ["./", "../", ".\\", "..\\"].iter().any(|start| specifier.starts_with(start));
  if !relative {
    return None;
  }
  Some(reported_path(importer?).parent()?.join(specifier))
}

/// A path as Node printed it, without the `\\?\` prefix Windows paths can carry.
fn reported_path(text: &str) -> PathBuf {
  let text = text.trim();
  let unprefixed = text
    .strip_prefix(r"\\?\")
    .filter(|rest| rest.as_bytes().get(1) == Some(&b':'));
  PathBuf::from(unprefixed.unwrap_or(text))
}

/// The package installed in `project_dir`'s `node_modules` that `file` belongs
/// to: its folder and its location, like `node_modules/@scope/name`.
fn installed_package_of(project_dir: &Path, file: &Path) -> Option<(PathBuf, String)> {
  // Node prints real paths: try the project's too (no 8.3 names or links).
  let inside = parts_within(project_dir, file).or_else(|| {
    let real = std::fs::canonicalize(project_dir).ok()?;
    parts_within(&reported_path(&real.to_string_lossy()), file)
  })?;
  if inside.first().map(String::as_str) != Some("node_modules") {
    return None;
  }
  // The innermost node_modules folder holds the package.
  let at = inside.iter().rposition(|part| part == "node_modules")?;
  let name_parts = if inside.get(at + 1)?.starts_with('@') { 2 } else { 1 };
  let package = inside.get(..at + 1 + name_parts)?;
  if package.iter().any(|part| part.starts_with('.')) {
    return None;
  }
  let location = package.join("/");
  Some((project_dir.join(&location), location))
}

/// The names in `path` after `dir`, with `.` and `..` resolved, or `None` when
/// `path` isn't inside `dir`. Node may print a path in another case than the
/// project's (`c:` for `C:`).
fn parts_within(dir: &Path, path: &Path) -> Option<Vec<String>> {
  let mut parts = path.components();
  for expected in dir.components() {
    if !parts.next()?.as_os_str().eq_ignore_ascii_case(expected.as_os_str()) {
      return None;
    }
  }
  let mut inside = Vec::new();
  for part in parts {
    match part {
      Component::Normal(name) => inside.push(name.to_str()?.to_string()),
      Component::CurDir => {}
      Component::ParentDir => {
        inside.pop()?;
      }
      _ => return None,
    }
  }
  Some(inside)
}

/// Whether a dependency install can use the faster, deterministic `npm ci` (a
/// committed lockfile and no `node_modules` yet, as in a fresh clone) instead of
/// `npm install`. `npm ci` skips dependency resolution and installs exactly the
/// locked tree.
fn use_npm_ci(has_lockfile: bool, has_node_modules: bool) -> bool {
  has_lockfile && !has_node_modules
}

fn npm_install_args(subcommand: &str) -> [&str; 4] {
  [
    subcommand,
    if subcommand == "ci" { "--prefer-offline" } else { "--prefer-offline=false" },
    "--no-audit",
    "--no-fund",
  ]
}

/// Reuse npm's cache for both install modes, but only skip metadata freshness
/// checks when `ci` installs a locked tree. `install` may need published versions
/// that a cached packument doesn't know about yet.
async fn run_npm_install(project_dir: &Path, subcommand: &str, on_data: Option<OnData>) -> RunResult {
  run(
    "npm",
    &npm_install_args(subcommand),
    RunOptions {
      cwd: Some(project_dir.to_path_buf()),
      on_data,
      timeout_ms: Some(600_000),
      ..Default::default()
    },
  )
  .await
}

/// Install a Rayfin project's dependencies when its local CLI is absent or its
/// packages are incomplete.
///
/// A cloned project normally has no `node_modules`; relying on a global CLI in
/// that case hides the problem until another local package is needed. An
/// install that stopped part way is just as broken while the CLI's own files
/// look ready: its commands fail with "Cannot find package" until npm fills in
/// the rest. This makes the project's pinned CLI the source of truth and is a
/// no-op once it is ready.
pub async fn ensure_project_dependencies(project_dir: &Path, on_data: Option<OnData>) -> Result<(), String> {
  if project_rayfin_cli_installed(project_dir) && find_incomplete_packages(project_dir).await.is_empty() {
    return Ok(());
  }

  let install_lock = {
    let mut locks = PROJECT_DEPENDENCY_INSTALL_LOCKS.lock().await;
    locks
      .entry(project_dir.to_path_buf())
      .or_insert_with(|| Arc::new(Mutex::new(())))
      .clone()
  };
  let _install_guard = install_lock.lock().await;
  // Another request may have completed the install while this one waited.
  let incomplete = quiet_incomplete_packages(project_dir, on_data.as_ref()).await?;
  if incomplete.is_empty() && project_rayfin_cli_installed(project_dir) {
    return Ok(());
  }

  if !project_dir.join("package.json").is_file() {
    return Err("This Rayfin project has no package.json, so its dependencies cannot be installed.".to_string());
  }

  if incomplete.is_empty() {
    if let Some(on) = &on_data {
      on(Stream::System, "Project dependencies are missing; installing them with npm...\n");
    }
  } else {
    log::warn!("Reinstalling incomplete packages in {}: {}", project_dir.display(), incomplete.join(", "));
    if let Some(on) = &on_data {
      on(
        Stream::System,
        &format!(
          "Project dependencies are missing or incomplete ({}); reinstalling them with npm...\n",
          package_names(&incomplete)
        ),
      );
    }
  }

  // A lockfile and no `node_modules` (a fresh clone) → `npm ci` is fastest and
  // fully deterministic (skips resolution and installs the locked tree).
  // Otherwise (no lockfile, or a partial `node_modules`) fall back to
  // `npm install`, allowing stale registry metadata to refresh.
  // Both skip the slow audit/fund passes.
  let use_ci = use_npm_ci(
    project_dir.join("package-lock.json").is_file(),
    project_dir.join("node_modules").exists(),
  );
  let mut result = run_npm_install(project_dir, if use_ci { "ci" } else { "install" }, on_data.clone()).await;

  // `npm ci` aborts when the lockfile and package.json are out of sync (e.g. a
  // package.json edited without updating the lock). Fall back to a plain install
  // rather than failing the whole deploy.
  if use_ci && !result.ok && !result.not_found {
    if let Some(on) = &on_data {
      on(Stream::System, "npm ci was rejected; retrying with npm install...\n");
    }
    result = run_npm_install(project_dir, "install", on_data.clone()).await;
  }

  if result.not_found {
    return Err("npm was not found on PATH. Install Node.js (which includes npm), then retry.".to_string());
  }
  if !result.ok {
    let code = result
      .exit_code
      .map(|code| code.to_string())
      .unwrap_or_else(|| "unknown".to_string());
    let detail = if result.stderr.trim().is_empty() {
      result.stdout.trim()
    } else {
      result.stderr.trim()
    };
    let tail = detail
      .lines()
      .rev()
      .find(|line| !line.trim().is_empty())
      .map(str::trim)
      .unwrap_or_default();
    let tail: String = tail.chars().take(300).collect();
    let suffix = if tail.is_empty() {
      String::new()
    } else {
      format!(": {tail}")
    };
    return Err(format!("npm install failed (exit code {code}){suffix}"));
  }
  if !project_rayfin_cli_installed(project_dir) {
    return Err(
      "npm install completed, but @microsoft/rayfin-cli is still missing. Check this project's package.json."
        .to_string(),
    );
  }
  let still_incomplete = find_incomplete_packages(project_dir).await;
  if !still_incomplete.is_empty() {
    return Err(format!(
      "npm install completed, but some packages are still incomplete ({}). Close Fabricator, delete this project's node_modules folder, then open the project again.",
      package_names(&still_incomplete)
    ));
  }
  Ok(())
}

/// Resolve the Fabric auth entry module (`dist/auth/index.js`), preferring a
/// project's *locally-installed* `@microsoft/rayfin-cli` so Fabric auth no longer
/// requires a global CLI. Falls back to [`global_rayfin_auth_module`] when the
/// project has no local copy (or `project_dir` is `None`), keeping existing global
/// installs working. The MSAL token cache is shared across installs, so a
/// project-local module reads the same signed-in session.
pub fn project_rayfin_auth_module(project_dir: Option<&Path>) -> Option<PathBuf> {
  if let Some(dir) = project_dir {
    let local = local_rayfin_auth_module(dir);
    if local.is_file() {
      return Some(local);
    }
  }
  global_rayfin_auth_module()
}

/// Build the `node <script>` invocation for a project's locally-installed Rayfin
/// CLI (the `npx rayfin` equivalent, honoring the project-pinned version).
/// Falls back to the global `rayfin` shim, then to `npx`.
pub fn project_rayfin(project_dir: &Path) -> (PathBuf, Vec<PathBuf>) {
  let local = local_rayfin_cli_dir(project_dir).join("scripts");
  for entry in ["main.js", "main"] {
    let script = local.join(entry);
    if script.exists() {
      if let Ok(node) = which::which("node") {
        return (node, vec![script]);
      }
    }
  }
  // Fall back to the global rayfin shim (node-bypassed), then npx.
  let g = resolve_program("rayfin");
  if !g.not_found {
    return (g.program, g.prefix);
  }
  (PathBuf::from("npx"), vec![PathBuf::from("rayfin")])
}

async fn pump<R>(mut reader: R, stream: Stream, on_data: Option<OnData>, buf: Arc<Mutex<String>>)
where
  R: AsyncReadExt + Unpin,
{
  let mut tmp = [0u8; 8192];
  loop {
    match reader.read(&mut tmp).await {
      Ok(0) => break,
      Ok(n) => {
        let chunk = String::from_utf8_lossy(&tmp[..n]).to_string();
        buf.lock().await.push_str(&chunk);
        if let Some(cb) = &on_data {
          cb(stream, &chunk);
        }
      }
      Err(_) => break,
    }
  }
}

/// Run a command to completion, capturing (and optionally streaming) output.
/// Never returns Err — failures surface via [`RunResult`].
pub async fn run(file: &str, args: &[&str], opts: RunOptions) -> RunResult {
  spawn_and_run(resolve_program(file), args, opts).await
}

/// Run an already-resolved executable by absolute path, skipping PATH/shim
/// resolution. Used for the SDK-bundled Copilot CLI (`login` + version probe),
/// whose binary lives under `%LOCALAPPDATA%` and is never on `PATH`.
pub async fn run_program(program: PathBuf, args: &[&str], opts: RunOptions) -> RunResult {
  let missing = !program.is_file();
  spawn_and_run(Resolved { program, prefix: vec![], not_found: missing }, args, opts).await
}

/// Run a project's pinned Rayfin CLI (the `npx rayfin` equivalent) by resolving
/// the project-local `@microsoft/rayfin-cli` script and spawning node directly,
/// so deploys honor the version installed with the project.
///
/// The CLI locates the project by walking up from its working directory looking
/// for a `rayfin/` folder, so the child must run *inside* the project. We default
/// `cwd` to `project_dir` when the caller didn't set one — otherwise commands like
/// `up list` / `up status` exit with "Not inside a Rayfin project" and report no
/// deployments even when the project is deployed.
///
/// When the CLI fails because a package it loads is incomplete, that package is
/// marked for the next dependency check to reinstall (see
/// [`invalidate_unloadable_packages`]).
pub async fn run_project_rayfin(project_dir: &Path, args: &[&str], mut opts: RunOptions) -> RunResult {
  let (program, prefix) = project_rayfin(project_dir);
  if opts.cwd.is_none() {
    opts.cwd = Some(project_dir.to_path_buf());
  }
  let on_data = opts.on_data.clone();
  let result = spawn_and_run(Resolved { program, prefix, not_found: false }, args, opts).await;
  if !result.ok {
    let output = format!("{}\n{}", result.stderr, result.stdout);
    let incomplete = invalidate_unloadable_packages(project_dir, &output);
    if !incomplete.is_empty() {
      log::warn!("The Rayfin CLI couldn't load packages in {}: {}", project_dir.display(), incomplete.join(", "));
      if let Some(on) = on_data {
        on(
          Stream::System,
          &format!(
            "\nSome of this project's packages didn't install completely ({}). Fabricator reinstalls them the next time you deploy, sign in to Fabric or open the project.\n",
            package_names(&incomplete)
          ),
        );
      }
    }
  }
  result
}

async fn spawn_and_run(resolved: Resolved, args: &[&str], opts: RunOptions) -> RunResult {
  if resolved.not_found {
    return RunResult {
      ok: false,
      exit_code: None,
      stdout: String::new(),
      stderr: format!("{} was not found on PATH", resolved.program.display()),
      not_found: true,
    };
  }

  let mut cmd = tokio::process::Command::new(&resolved.program);
  for p in &resolved.prefix {
    cmd.arg(p);
  }
  cmd.args(args);
  if let Some(cwd) = &opts.cwd {
    cmd.current_dir(cwd);
  }
  cmd.env("NO_COLOR", "1").env("FORCE_COLOR", "0");
  for name in &opts.env_remove {
    cmd.env_remove(name);
  }
  for (k, v) in &opts.env {
    cmd.env(k, v);
  }
  cmd.stdin(if opts.stdin.is_some() { Stdio::piped() } else { Stdio::null() });
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::piped());
  // A caller that stops waiting (an outer timeout, a `select!`, or a Copilot tool call
  // the SDK cancels by dropping its future) must not leave the child running.
  cmd.kill_on_drop(true);
  #[cfg(windows)]
  {
    // CREATE_NO_WINDOW — don't flash a console for child processes.
    cmd.creation_flags(0x0800_0000);
  }

  let mut child = match cmd.spawn() {
    Ok(c) => c,
    Err(e) => {
      let not_found = e.kind() == std::io::ErrorKind::NotFound;
      return RunResult {
        ok: false,
        exit_code: None,
        stdout: String::new(),
        stderr: e.to_string(),
        not_found,
      };
    }
  };

  let out_buf = Arc::new(Mutex::new(String::new()));
  let err_buf = Arc::new(Mutex::new(String::new()));
  // Write the input, then close stdin so the child sees the end of it. A child
  // that exits without reading it makes the write fail, which is fine.
  if let (Some(input), Some(mut pipe)) = (opts.stdin, child.stdin.take()) {
    tokio::spawn(async move {
      let _ = pipe.write_all(input.as_bytes()).await;
      let _ = pipe.shutdown().await;
    });
  }
  let out_handle = child
    .stdout
    .take()
    .map(|s| tokio::spawn(pump(s, Stream::Stdout, opts.on_data.clone(), out_buf.clone())));
  let err_handle = child
    .stderr
    .take()
    .map(|s| tokio::spawn(pump(s, Stream::Stderr, opts.on_data.clone(), err_buf.clone())));

  let timeout = opts.timeout_ms.map(std::time::Duration::from_millis);
  let cancel = opts.cancel.clone();

  let mut timed_out = false;
  let mut cancelled = false;

  let status = loop {
    tokio::select! {
      res = child.wait() => {
        break res.ok();
      }
      _ = async { if let Some(c) = &cancel { c.wait_cancelled().await } else { std::future::pending::<()>().await } } => {
        cancelled = true;
        let _ = child.start_kill();
        break child.wait().await.ok();
      }
      _ = async { match timeout { Some(d) => tokio::time::sleep(d).await, None => std::future::pending::<()>().await } } => {
        timed_out = true;
        let _ = child.start_kill();
        break child.wait().await.ok();
      }
    }
  };

  if let Some(h) = out_handle {
    let _ = h.await;
  }
  if let Some(h) = err_handle {
    let _ = h.await;
  }

  let exit_code = status.and_then(|s| s.code());
  let stdout = Arc::try_unwrap(out_buf)
    .map(|m| m.into_inner())
    .unwrap_or_default();
  let stderr = Arc::try_unwrap(err_buf)
    .map(|m| m.into_inner())
    .unwrap_or_default();
  let ok = exit_code == Some(0) && !timed_out && !cancelled;

  RunResult {
    ok,
    exit_code,
    stdout,
    stderr,
    not_found: false,
  }
}

/// Convenience: run a process and return trimmed stdout, or None on failure.
pub async fn try_version(file: &str, args: &[&str]) -> Option<String> {
  version_from(run(file, args, RunOptions::timeout(15_000)).await)
}

/// Like [`try_version`] but for an absolute executable path (e.g. the bundled
/// Copilot CLI under `%LOCALAPPDATA%`, which is never on `PATH`).
pub async fn try_version_path(program: PathBuf, args: &[&str]) -> Option<String> {
  version_from(run_program(program, args, RunOptions::timeout(15_000)).await)
}

fn version_from(res: RunResult) -> Option<String> {
  if !res.ok {
    return None;
  }
  let out = if res.stdout.trim().is_empty() {
    res.stderr.trim()
  } else {
    res.stdout.trim()
  };
  if out.is_empty() {
    None
  } else {
    Some(out.to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn a_run_its_caller_stops_awaiting_kills_the_child() {
    if which::which("node").is_err() {
      return;
    }
    let marker = std::env::temp_dir().join(format!("exec-dropped-{}", uuid::Uuid::new_v4()));
    let marker_arg = marker.to_string_lossy().into_owned();
    let script = "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'still running'), 1000)";
    let args = ["-e", script, &marker_arg];
    let pending = run("node", &args, RunOptions::timeout(30_000));
    // Dropping the future is what the Copilot SDK does when it cancels a tool call.
    assert!(tokio::time::timeout(Duration::from_millis(300), pending).await.is_err());
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    let survived = marker.exists();
    let _ = std::fs::remove_file(&marker);
    assert!(!survived, "the child kept running after its caller stopped waiting");
  }

  #[tokio::test]
  async fn stdin_reaches_the_child_but_not_its_arguments() {
    if which::which("node").is_err() {
      return;
    }
    let script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({input:s,args:process.argv})))";
    let res = run(
      "node",
      &["-e", script],
      RunOptions { stdin: Some("s3cret & value\n".into()), timeout_ms: Some(30_000), ..Default::default() },
    )
    .await;
    assert!(res.ok, "{}", res.stderr);
    let out: serde_json::Value = serde_json::from_str(res.stdout.trim()).unwrap();
    assert_eq!(out["input"], "s3cret & value\n");
    assert!(!out["args"].to_string().contains("s3cret"));
    // Without input, stdin is empty: the child never waits on the terminal.
    let res = run("node", &["-e", script], RunOptions::timeout(30_000)).await;
    assert!(res.ok, "{}", res.stderr);
    let out: serde_json::Value = serde_json::from_str(res.stdout.trim()).unwrap();
    assert_eq!(out["input"], "");
  }

  #[test]
  fn project_rayfin_auth_module_prefers_local_then_falls_back() {
    // A project with the CLI installed locally resolves to its own auth module.
    let dir = std::env::temp_dir().join(format!("rayfin-auth-{}", uuid::Uuid::new_v4()));
    let module = dir
      .join("node_modules")
      .join("@microsoft")
      .join("rayfin-cli")
      .join("dist")
      .join("auth")
      .join("index.js");
    std::fs::create_dir_all(module.parent().unwrap()).unwrap();
    std::fs::write(&module, "// stub").unwrap();
    assert_eq!(project_rayfin_auth_module(Some(&dir)), Some(module));

    // A project without a local copy (or no project at all) falls back to the
    // global resolver — deterministically identical to calling it directly.
    let empty = std::env::temp_dir().join(format!("rayfin-empty-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(
      project_rayfin_auth_module(Some(&empty)),
      global_rayfin_auth_module()
    );
    assert_eq!(project_rayfin_auth_module(None), global_rayfin_auth_module());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&empty);
  }

  #[test]
  fn project_rayfin_cli_requires_a_complete_local_install() {
    let dir = std::env::temp_dir().join(format!("rayfin-cli-ready-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("package.json"), r#"{"name":"example"}"#).unwrap();

    // A fresh clone has neither node_modules nor the local CLI.
    assert!(!project_rayfin_cli_installed(&dir));

    let cli = local_rayfin_cli_dir(&dir);
    let auth = cli.join("dist").join("auth").join("index.js");
    std::fs::create_dir_all(auth.parent().unwrap()).unwrap();
    std::fs::write(&auth, "// auth").unwrap();
    // The auth entry alone is not enough: deploys also need the CLI command.
    assert!(!project_rayfin_cli_installed(&dir));

    let command = cli.join("scripts").join("main.js");
    std::fs::create_dir_all(command.parent().unwrap()).unwrap();
    std::fs::write(&command, "// cli").unwrap();
    assert!(project_rayfin_cli_installed(&dir));

    let _ = std::fs::remove_dir_all(&dir);
  }

  fn temp_project(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rayfin-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  /// Install a package (just its `package.json`) at each location in `dir`.
  fn install_packages(dir: &Path, locations: &[&str]) {
    for location in locations {
      std::fs::create_dir_all(dir.join(location)).unwrap();
      std::fs::write(dir.join(location).join("package.json"), "{}").unwrap();
    }
  }

  #[test]
  fn incomplete_packages_finds_what_an_interrupted_install_left_behind() {
    let dir = temp_project("incomplete");
    assert!(incomplete_packages(&dir).is_empty(), "nothing is installed yet");

    let packages = [
      "node_modules/commander",
      "node_modules/jsonwebtoken",
      "node_modules/@azure/msal-node",
      "node_modules/inquirer",
      "node_modules/inquirer/node_modules/rxjs",
      "packages/app/node_modules/lodash",
    ];
    install_packages(&dir, &packages);
    let mut record = serde_json::json!({ "": {}, "packages/app": {} });
    for location in packages {
      record[location] = serde_json::json!({});
    }
    let node_modules = dir.join("node_modules");
    std::fs::write(node_modules.join(".package-lock.json"), serde_json::json!({ "packages": record }).to_string()).unwrap();
    // npm's own folders, tool caches, a folder an interrupted install set aside
    // and an empty scope aren't packages.
    for folder in [".bin", ".vite/deps", ".commander-1a2b3c4d", "@types"] {
      std::fs::create_dir_all(node_modules.join(folder)).unwrap();
    }
    assert!(incomplete_packages(&dir).is_empty());

    // Emptied package folders, at the top, in a scope and nested, and a
    // recorded package that's gone.
    std::fs::remove_file(node_modules.join("commander").join("package.json")).unwrap();
    std::fs::remove_file(node_modules.join("@azure").join("msal-node").join("package.json")).unwrap();
    std::fs::write(node_modules.join("@azure").join("msal-node").join("index.mjs"), "").unwrap();
    std::fs::remove_file(node_modules.join("inquirer").join("node_modules").join("rxjs").join("package.json")).unwrap();
    std::fs::remove_dir_all(node_modules.join("jsonwebtoken")).unwrap();
    assert_eq!(
      incomplete_packages(&dir),
      [
        "node_modules/@azure/msal-node",
        "node_modules/commander",
        "node_modules/inquirer/node_modules/rxjs",
        "node_modules/jsonwebtoken",
      ]
    );

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[tokio::test]
  async fn a_half_installed_project_is_not_ready() {
    let dir = temp_project("half-installed");
    let cli = local_rayfin_cli_dir(&dir);
    for file in ["package.json", "dist/auth/index.js", "scripts/main.js"] {
      std::fs::create_dir_all(cli.join(file).parent().unwrap()).unwrap();
      std::fs::write(cli.join(file), "{}").unwrap();
    }
    install_packages(&dir, &["node_modules/commander"]);
    assert!(ensure_project_dependencies(&dir, None).await.is_ok());

    // An install that's still unpacking is left to finish.
    let manifest = dir.join("node_modules").join("commander").join("package.json");
    std::fs::remove_file(&manifest).unwrap();
    let unpacking = {
      let manifest = manifest.clone();
      tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        std::fs::write(manifest, "{}").unwrap();
      })
    };
    assert!(ensure_project_dependencies(&dir, None).await.is_ok());
    unpacking.await.unwrap();

    // One that stopped part way leaves the CLI's own files looking ready, but a
    // package it loads is empty, so ensure installs (and stops: this fixture has
    // no package.json).
    std::fs::remove_file(&manifest).unwrap();
    assert!(project_rayfin_cli_installed(&dir));
    let error = ensure_project_dependencies(&dir, None).await.unwrap_err();
    assert!(error.contains("no package.json"), "{error}");

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn node_load_failures_mark_only_this_projects_packages() {
    let dir = temp_project("unloadable");
    let other = temp_project("unloadable-other");
    install_packages(
      &dir,
      &["node_modules/inquirer", "node_modules/@azure/msal-node", "node_modules/a", "node_modules/a/node_modules/b"],
    );
    install_packages(&other, &["node_modules/inquirer"]);
    let node_modules = dir.join("node_modules");
    let list = node_modules.join("inquirer").join("lib").join("prompts").join("list.js");

    // A package Node names rather than a file in it is missing outright, a file
    // the project's own code asks for is that code's mistake, and another
    // folder's packages aren't this project's to repair.
    let untouched = format!(
      "Cannot find package 'rxjs' imported from {}\nCannot find module '{}' imported from {}\nCannot find module '{}' imported from {}",
      list.display(),
      node_modules.join("inquirer").join("missing.js").display(),
      dir.join("scripts").join("build.mjs").display(),
      other.join("node_modules").join("inquirer").join("index.js").display(),
      list.display(),
    );
    assert!(invalidate_unloadable_packages(&dir, &untouched).is_empty());
    assert!(other.join("node_modules").join("inquirer").join("package.json").is_file());
    assert!(incomplete_packages(&dir).is_empty());

    // An ES module reports the file's path, in whatever case it was typed.
    let esm = format!(
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '{}' imported from {}",
      node_modules.join("@azure").join("msal-node").join("dist").join("client.mjs").display().to_string().to_lowercase(),
      node_modules.join("@azure").join("msal-node").join("dist").join("index.mjs").display(),
    );
    assert_eq!(invalidate_unloadable_packages(&dir, &esm), ["node_modules/@azure/msal-node"]);
    // CommonJS reports a relative path and the module that required it.
    let cjs = format!(
      "Error: Cannot find module './prompts/list'\nRequire stack:\n- {}\n- {}",
      node_modules.join("inquirer").join("lib").join("inquirer.js").display(),
      node_modules.join("a").join("node_modules").join("b").join("index.js").display(),
    );
    assert_eq!(invalidate_unloadable_packages(&dir, &cjs), ["node_modules/inquirer"]);
    let nested = format!(
      "Cannot find package '{}' imported from {}",
      node_modules.join("a").join("node_modules").join("b").join("index.js").display(),
      node_modules.join("a").join("index.js").display(),
    );
    assert_eq!(invalidate_unloadable_packages(&dir, &nested), ["node_modules/a/node_modules/b"]);
    assert_eq!(
      incomplete_packages(&dir),
      ["node_modules/@azure/msal-node", "node_modules/a/node_modules/b", "node_modules/inquirer"]
    );

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&other);
  }

  /// Link `link` to the folder `target` the way npm links a workspace: a
  /// junction on Windows, a symlink elsewhere.
  fn link_folder(target: &Path, link: &Path) {
    #[cfg(windows)]
    let linked = std::process::Command::new("cmd")
      .args(["/C", "mklink", "/J"])
      .arg(link)
      .arg(target)
      .output()
      .is_ok_and(|out| out.status.success());
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(target, link).is_ok();
    assert!(linked, "couldn't link {}", link.display());
  }

  #[test]
  fn node_load_failures_never_reach_through_a_linked_package() {
    // Behind a workspace's link in node_modules is the project's own source.
    let dir = temp_project("linked");
    install_packages(&dir, &["packages/shared"]);
    let link = dir.join("node_modules").join("@rayfin-app").join("shared");
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    link_folder(&dir.join("packages").join("shared"), &link);
    assert!(incomplete_packages(&dir).is_empty());

    let unbuilt = format!(
      "Cannot find module '{}' imported from {}",
      link.join("dist").join("index.js").display(),
      dir.join("node_modules").join("@microsoft").join("rayfin-cli").join("dist").join("index.js").display(),
    );
    assert!(invalidate_unloadable_packages(&dir, &unbuilt).is_empty());
    assert!(dir.join("packages").join("shared").join("package.json").is_file());

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[tokio::test]
  async fn a_cli_that_cannot_load_a_package_marks_it_for_reinstall() {
    if which::which("node").is_err() {
      return;
    }
    let dir = temp_project("cli-unloadable");
    let cli = local_rayfin_cli_dir(&dir);
    std::fs::create_dir_all(cli.join("scripts")).unwrap();
    std::fs::write(cli.join("package.json"), r#"{"name":"@microsoft/rayfin-cli","type":"module"}"#).unwrap();
    std::fs::write(cli.join("scripts").join("main.js"), "await import('commander')").unwrap();
    // commander looks installed, but lost a file its entry point imports.
    let commander = dir.join("node_modules").join("commander");
    std::fs::create_dir_all(&commander).unwrap();
    std::fs::write(commander.join("package.json"), r#"{"name":"commander","type":"module","main":"index.js"}"#).unwrap();
    std::fs::write(commander.join("index.js"), "import './lib/command.js'").unwrap();
    assert!(incomplete_packages(&dir).is_empty());

    let log = Arc::new(std::sync::Mutex::new(String::new()));
    let capture = log.clone();
    let on_data: OnData = Arc::new(move |_: Stream, chunk: &str| capture.lock().unwrap().push_str(chunk));
    let res = run_project_rayfin(
      &dir,
      &["up"],
      RunOptions { on_data: Some(on_data), timeout_ms: Some(30_000), ..Default::default() },
    )
    .await;
    assert!(!res.ok);
    assert!(res.stderr.contains("Cannot find module"), "{}", res.stderr);
    assert_eq!(incomplete_packages(&dir), ["node_modules/commander"]);
    assert!(log.lock().unwrap().contains("Fabricator reinstalls them"), "{}", log.lock().unwrap());

    // Marking it isn't mistaken for an install at work, so the retry the note
    // suggests repairs at once (and stops: this fixture has no package.json).
    log.lock().unwrap().clear();
    let capture = log.clone();
    let on_data: OnData = Arc::new(move |_: Stream, chunk: &str| capture.lock().unwrap().push_str(chunk));
    let error = ensure_project_dependencies(&dir, Some(on_data)).await.unwrap_err();
    assert!(error.contains("no package.json"), "{error}");
    assert!(!log.lock().unwrap().contains("Waiting"), "{}", log.lock().unwrap());

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn npm_ci_only_with_a_lockfile_and_no_node_modules() {
    // Committed lockfile + no node_modules (a fresh clone) → npm ci.
    assert!(use_npm_ci(true, false));
    // No lockfile → must resolve, so npm install.
    assert!(!use_npm_ci(false, false));
    // A partial/existing node_modules → npm install (ci would wipe it and is
    // strict about sync); let install reconcile instead.
    assert!(!use_npm_ci(true, true));
    assert!(!use_npm_ci(false, true));
  }

  #[test]
  fn npm_install_only_prefers_offline_for_a_locked_tree() {
    assert_eq!(
      npm_install_args("ci"),
      ["ci", "--prefer-offline", "--no-audit", "--no-fund"]
    );
    assert_eq!(
      npm_install_args("install"),
      ["install", "--prefer-offline=false", "--no-audit", "--no-fund"]
    );
  }
}
