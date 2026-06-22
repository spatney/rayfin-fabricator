//! Cross-platform process runner — the Rust counterpart to `src/main/services/exec.ts`.
//!
//! On Windows the npm-distributed CLIs (`copilot`, `rayfin`) are `.cmd` shims.
//! Spawning a `.cmd` through `std`/`tokio` routes it via `cmd.exe`, which mangles
//! arguments containing `&` `|` `^` `<` `>` and *rejects* arguments containing
//! newlines outright — fatal for `copilot -p <multi-line prompt>`. We therefore
//! resolve the shim to its underlying `node <script>` invocation and spawn
//! `node.exe` (a real executable) directly, so arbitrary argument text is
//! delivered verbatim. Other tools are resolved on `PATH` via the `which` crate
//! (which also yields a clean "not found" signal).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use once_cell::sync::Lazy;
use regex::Regex;
use tokio::io::AsyncReadExt;
use tokio::sync::{Mutex, Notify};

/// Which output stream a chunk came from.
#[derive(Clone, Copy)]
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

  async fn wait_cancelled(&self) {
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

/// Resolve an npm-installed CLI (`copilot`, `rayfin`) to a direct
/// `node <script>` invocation, bypassing the fragile `.cmd` shim.
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
    "copilot" | "rayfin" => node_bypass(file).unwrap_or_else(|| which_resolved(file)),
    _ => which_resolved(file),
  }
}

/// Resolve the global rayfin-cli's auth entry module (`dist/auth/index.js`),
/// reusing the same CLI the app already drives. Mirrors the TS `npm root -g`
/// lookup but derives the global package root from the `rayfin` shim on PATH so
/// we never have to spawn the non-bypassable `npm` cmd-shim. Returns the first
/// existing candidate, or `None` when the CLI can't be located.
pub fn global_rayfin_auth_module() -> Option<PathBuf> {
  let shim = which::which("rayfin").ok()?;
  let mut candidates: Vec<PathBuf> = Vec::new();
  // Standard npm global layout: <binDir>/node_modules/@microsoft/rayfin-cli/...
  if let Some(bin_dir) = shim.parent() {
    candidates.push(
      bin_dir
        .join("node_modules")
        .join("@microsoft")
        .join("rayfin-cli")
        .join("dist")
        .join("auth")
        .join("index.js"),
    );
  }
  // Or derive from the cmd-shim's node target (<pkgRoot>/scripts/main.js).
  if is_batch(&shim) {
    if let Some(script) = parse_shim(&shim) {
      if let Some(pkg_root) = script.parent().and_then(|p| p.parent()) {
        candidates.push(pkg_root.join("dist").join("auth").join("index.js"));
      }
    }
  }
  candidates.into_iter().find(|p| p.exists())
}

/// Build the `node <script>` invocation for a project's locally-installed Rayfin
/// CLI (the `npx rayfin` equivalent, honoring the project-pinned version).
/// Falls back to the global `rayfin` shim, then to `npx`.
pub fn project_rayfin(project_dir: &Path) -> (PathBuf, Vec<PathBuf>) {
  let local = project_dir
    .join("node_modules")
    .join("@microsoft")
    .join("rayfin-cli")
    .join("scripts");
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
  let res = run(file, args, RunOptions::timeout(15_000)).await;
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
