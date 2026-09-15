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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use once_cell::sync::Lazy;
use regex::Regex;
use tokio::io::AsyncReadExt;
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
  pub on_data: Option<OnData>,
  pub timeout_ms: Option<u64>,
  pub cancel: Option<CancelToken>,
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

/// Whether a fresh scaffold lets us use the faster, deterministic `npm ci`
/// (a committed lockfile and no `node_modules` yet) instead of `npm install`.
/// `npm ci` skips dependency resolution and installs exactly the locked tree,
/// every tarball of which is in the warm cache.
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

/// Use the warm cache for both install modes, but only skip metadata freshness
/// checks when `ci` installs a locked tree. `install` may need published versions
/// that a bundled packument doesn't know about yet.
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

/// Install a Rayfin project's dependencies when its local CLI is absent.
///
/// A cloned project normally has no `node_modules`; relying on a global CLI in
/// that case hides the problem until another local package is needed. This makes
/// the project's pinned CLI the source of truth and is a no-op once it is ready.
pub async fn ensure_project_dependencies(project_dir: &Path, on_data: Option<OnData>) -> Result<(), String> {
  if project_rayfin_cli_installed(project_dir) {
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
  if project_rayfin_cli_installed(project_dir) {
    return Ok(());
  }

  if !project_dir.join("package.json").is_file() {
    return Err("This Rayfin project has no package.json, so its dependencies cannot be installed.".to_string());
  }

  if let Some(on) = &on_data {
    on(Stream::System, "Project dependencies are missing; installing with the warm npm cache...\n");
  }

  // Fresh scaffold with a committed lockfile → `npm ci` is fastest and fully
  // deterministic (skips resolution, and every locked tarball is in the warm
  // cache). Otherwise (no lockfile, or a partial `node_modules`) fall back to a
  // cache-backed `npm install`, allowing stale registry metadata to refresh.
  // Both skip the slow audit/fund passes.
  let use_ci = use_npm_ci(
    project_dir.join("package-lock.json").is_file(),
    project_dir.join("node_modules").exists(),
  );
  let mut result = run_npm_install(project_dir, if use_ci { "ci" } else { "install" }, on_data.clone()).await;

  // `npm ci` aborts when the lockfile and package.json are out of sync (e.g. a
  // scaffolder that rewrote package.json but kept an older lock). Fall back to a
  // plain — still cache-backed — install rather than failing the whole deploy.
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
pub async fn run_project_rayfin(project_dir: &Path, args: &[&str], mut opts: RunOptions) -> RunResult {
  let (program, prefix) = project_rayfin(project_dir);
  if opts.cwd.is_none() {
    opts.cwd = Some(project_dir.to_path_buf());
  }
  spawn_and_run(Resolved { program, prefix, not_found: false }, args, opts).await
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
  for (k, v) in &opts.env {
    cmd.env(k, v);
  }
  cmd.stdin(Stdio::null());
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::piped());
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

  #[test]
  fn npm_ci_only_on_a_fresh_scaffold_with_a_lockfile() {
    // Committed lockfile + no node_modules (the fresh-scaffold case) → npm ci.
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
