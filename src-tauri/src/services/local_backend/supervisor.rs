//! Runs one project's `rayfin-local serve --json` and keeps it running: reads
//! its events, stops it by closing its stdin (killing it when it doesn't stop
//! in time), restarts it after a configuration change that needs one, and
//! after a crash with backoff. A fatal error leaves it in `error` until
//! someone starts it again.

use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::{mpsc, oneshot};

use super::binary::{self, Binary};
use super::control::ControlToken;
use super::machine::{Ending, Next};
use super::{process, LocalBackends, Policy, Runtime};
use crate::services::fabric_accounts;
use crate::types::{LocalProblem, LocalStartOptions};

/// The variable that turns on the control API, with the run's bearer token.
pub const TOKEN_ENV: &str = "RAYFIN_LOCAL_CONTROL_TOKEN";
/// The longest stdout or stderr line read; the rest of a longer one is dropped.
const MAX_LINE_BYTES: usize = 1024 * 1024;
/// Lines of output kept with a crash.
const CRASH_TAIL: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
  Stdout,
  Stderr,
}

/// What callers ask of a running supervisor.
pub enum Command {
  Stop(Option<oneshot::Sender<()>>),
  Restart { dir: PathBuf, options: LocalStartOptions, done: oneshot::Sender<()> },
}

/// What Fabricator asked of the current process.
enum Pending {
  Stop(Option<oneshot::Sender<()>>),
  Restart { dir: PathBuf, options: LocalStartOptions, done: Option<oneshot::Sender<()>> },
  /// A configuration change that needs a restart.
  Config,
}

impl Pending {
  fn acknowledge(self) {
    match self {
      Pending::Stop(Some(done)) | Pending::Restart { done: Some(done), .. } => {
        let _ = done.send(());
      }
      _ => {}
    }
  }
}

/// The environment Fabricator gives rayfin-local besides the control token.
#[derive(Clone, Debug, Default)]
pub struct HostEnv {
  /// Fabricator's `PATH`, repaired at startup to include Node.js.
  pub path: Option<OsString>,
  /// The `node` Fabricator found (`RAYFIN_LOCAL_NODE`).
  pub node: Option<PathBuf>,
  /// The active Fabric account's Rayfin CLI folder (`RAYFIN_CONFIG_DIR`).
  pub config_dir: Option<PathBuf>,
}

impl HostEnv {
  pub fn current() -> Self {
    Self {
      path: std::env::var_os("PATH"),
      node: which::which("node").ok(),
      config_dir: fabric_accounts::dir_of(&fabric_accounts::active_id())
        .or_else(|| std::env::var_os(fabric_accounts::CONFIG_DIR_ENV).map(PathBuf::from)),
    }
  }
}

/// How to start one `serve` process.
pub struct LaunchSpec {
  pub program: PathBuf,
  pub args: Vec<OsString>,
  pub cwd: PathBuf,
  pub env: Vec<(&'static str, OsString)>,
}

impl LaunchSpec {
  /// The command line, for the output log (never the environment).
  pub fn describe(&self) -> String {
    std::iter::once(self.program.as_os_str())
      .chain(self.args.iter().map(OsString::as_os_str))
      .map(|part| {
        let text = part.to_string_lossy();
        if text.contains(' ') { format!("\"{text}\"") } else { text.into_owned() }
      })
      .collect::<Vec<_>>()
      .join(" ")
  }
}

impl fmt::Debug for LaunchSpec {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    let env: Vec<(&str, String)> = self
      .env
      .iter()
      .map(|(key, value)| (*key, if *key == TOKEN_ENV { "***".to_string() } else { value.to_string_lossy().into_owned() }))
      .collect();
    f.debug_struct("LaunchSpec").field("program", &self.program).field("args", &self.args).field("cwd", &self.cwd).field("env", &env).finish()
  }
}

/// `serve --json -C <dir>` and the options' flags.
pub fn serve_args(dir: &Path, options: &LocalStartOptions) -> Vec<OsString> {
  let mut args: Vec<OsString> = vec!["serve".into(), "--json".into(), "-C".into(), dir.as_os_str().to_owned()];
  if options.force_schema {
    args.push("--force-schema".into());
  }
  if options.reset {
    args.push("--reset".into());
  }
  if let Some(who) = options.sign_in_as.as_deref().filter(|w| !w.is_empty()) {
    args.push("--sign-in-as".into());
    args.push(who.into());
  }
  args
}

pub fn launch_spec(binary: &Binary, dir: &Path, options: &LocalStartOptions, token: &ControlToken, host: &HostEnv) -> LaunchSpec {
  let mut env: Vec<(&'static str, OsString)> = Vec::new();
  if let Some(path) = &host.path {
    env.push(("PATH", path.clone()));
  }
  if let Some(node) = &host.node {
    env.push(("RAYFIN_LOCAL_NODE", node.clone().into_os_string()));
  }
  if let Some(dir) = &host.config_dir {
    env.push((fabric_accounts::CONFIG_DIR_ENV, dir.clone().into_os_string()));
  }
  env.push((TOKEN_ENV, token.expose().into()));
  env.push(("NO_COLOR", "1".into()));
  env.push(("FORCE_COLOR", "0".into()));
  LaunchSpec { program: binary.program.clone(), args: binary.args(serve_args(dir, options)), cwd: dir.to_path_buf(), env }
}

/// Start `serve` with its stdin, stdout and stderr piped and no console window.
pub fn spawn(spec: &LaunchSpec) -> io::Result<tokio::process::Child> {
  let mut cmd = tokio::process::Command::new(&spec.program);
  cmd.args(&spec.args).current_dir(&spec.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
  for (key, value) in &spec.env {
    cmd.env(key, value);
  }
  process::configure(&mut cmd);
  cmd.spawn()
}

/// Read `reader` line by line into `lines`, until it ends.
async fn read_lines<R: AsyncRead + Unpin>(reader: R, stream: Stream, lines: mpsc::UnboundedSender<(Stream, String)>) {
  let mut reader = BufReader::new(reader);
  let mut buf = Vec::new();
  loop {
    buf.clear();
    match read_line(&mut reader, &mut buf).await {
      Ok(0) | Err(_) => break,
      Ok(_) => {
        let text = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
        if lines.send((stream, text)).is_err() {
          break;
        }
      }
    }
  }
}

/// One line into `buf` (at most [`MAX_LINE_BYTES`]); returns the bytes consumed.
async fn read_line<R: AsyncBufRead + Unpin>(reader: &mut R, buf: &mut Vec<u8>) -> io::Result<usize> {
  let mut consumed = 0;
  loop {
    let available = reader.fill_buf().await?;
    if available.is_empty() {
      return Ok(consumed);
    }
    let (used, done) = match available.iter().position(|b| *b == b'\n') {
      Some(i) => (i + 1, true),
      None => (available.len(), false),
    };
    let room = MAX_LINE_BYTES.saturating_sub(buf.len());
    buf.extend_from_slice(&available[..used.min(room)]);
    reader.consume(used);
    consumed += used;
    if done {
      return Ok(consumed);
    }
  }
}

pub struct Supervisor {
  pub backends: LocalBackends,
  pub rt: Arc<Runtime>,
  pub generation: u64,
  pub commands: mpsc::UnboundedReceiver<Command>,
  pub dir: PathBuf,
  pub options: LocalStartOptions,
  pub binary: Binary,
}

/// How one process ended.
struct Ended {
  pending: Option<Pending>,
  exit_code: Option<i32>,
}

/// What the wait before a crash restart ended with.
enum AfterWait {
  Restart,
  Requested(Command),
  Closed,
}

impl Supervisor {
  /// Supervise until the backend is stopped or fails. The caller already began the first run.
  pub async fn run(mut self) {
    let policy = self.backends.policy().clone();
    let mut fresh = true;
    let mut first = true;
    let mut last_ack: Option<oneshot::Sender<()>> = None;
    loop {
      if self.backends.closing() {
        self.rt.update(|m| m.stopped());
        break;
      }
      if !first {
        match self.backends.binary().await {
          Ok(binary) => self.binary = binary,
          Err(problem) => {
            self.rt.fail(problem);
            break;
          }
        }
        self.rt.update(|m| m.begin(&self.options, fresh));
      }
      first = false;

      let ended = match self.run_once(&policy).await {
        Ok(ended) => ended,
        Err(problem) => {
          self.rt.fail(problem);
          break;
        }
      };
      let ending = match &ended.pending {
        Some(Pending::Stop(_)) => Ending::Stopped,
        Some(_) => Ending::Restart,
        None if self.backends.closing() => Ending::Stopped,
        None => Ending::Exited,
      };
      let tail = self.rt.tail(CRASH_TAIL);
      let next = self.rt.update(|m| m.ended(ending, ended.exit_code, &policy.crash, Instant::now(), &tail));
      self.rt.after_run(next, ended.exit_code);

      match ended.pending {
        Some(Pending::Stop(done)) => {
          last_ack = done;
          break;
        }
        Some(Pending::Restart { dir, options, done }) => {
          self.dir = dir;
          self.options = options;
          fresh = true;
          if let Some(done) = done {
            let _ = done.send(());
          }
        }
        Some(Pending::Config) => {
          self.options = self.rt.sticky_options();
          fresh = false;
        }
        None => match next {
          Next::Restart(delay) => match self.wait(delay).await {
            AfterWait::Restart => {
              self.options = self.rt.sticky_options();
              fresh = false;
            }
            AfterWait::Requested(Command::Restart { dir, options, done }) => {
              self.dir = dir;
              self.options = options;
              fresh = true;
              let _ = done.send(());
            }
            AfterWait::Requested(Command::Stop(done)) => {
              self.rt.update(|m| m.stopped());
              last_ack = done;
              break;
            }
            AfterWait::Closed => {
              self.rt.update(|m| m.stopped());
              break;
            }
          },
          Next::Stop | Next::Fail => break,
        },
      }
    }
    self.rt.finish(self.generation);
    // After `finish`, so a start right after a stop sees it stopped.
    if let Some(done) = last_ack {
      let _ = done.send(());
    }
  }

  /// The wait before a crash restart, cut short by a request.
  async fn wait(&mut self, delay: Duration) -> AfterWait {
    tokio::select! {
      _ = tokio::time::sleep(delay) => AfterWait::Restart,
      command = self.commands.recv() => match command {
        Some(command) => AfterWait::Requested(command),
        None => AfterWait::Closed,
      },
    }
  }

  /// One process, from spawn to exit.
  async fn run_once(&mut self, policy: &Policy) -> Result<Ended, LocalProblem> {
    if !self.dir.is_dir() {
      return Err(binary::problem(
        "project-not-found",
        format!("The project's folder {} isn't there anymore.", self.dir.display()),
        Some("Move it back, or open the project again from where it is now."),
      ));
    }
    let token = ControlToken::generate();
    let spec = launch_spec(&self.binary, &self.dir, &self.options, &token, &self.backends.host_env());
    self.rt.log("fabricator", "info", &format!("Starting {}", spec.describe()), None);
    let mut child = spawn(&spec).map_err(|e| binary::spawn_problem(self.binary.file(), &e))?;
    let pid = child.id();
    self.rt.attach(self.generation, pid, child.stdin.take(), token.clone());
    self.rt.update(|m| m.spawned(pid));

    let (tx, mut lines) = mpsc::unbounded_channel();
    if let Some(stdout) = child.stdout.take() {
      tokio::spawn(read_lines(stdout, Stream::Stdout, tx.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
      tokio::spawn(read_lines(stderr, Stream::Stderr, tx.clone()));
    }
    drop(tx);

    let mut pending: Option<Pending> = None;
    let mut deadline: Option<tokio::time::Instant> = None;
    let mut lines_open = true;
    let mut commands_open = true;
    let mut killed = false;
    let far = || tokio::time::Instant::now() + Duration::from_secs(86_400);
    let status = loop {
      tokio::select! {
        line = lines.recv(), if lines_open => match line {
          Some((stream, text)) => {
            let outcome = self.rt.handle_line(stream, &text, &token);
            if outcome.restart && pending.is_none() {
              self.rt.log("fabricator", "info", "Restarting the local backend to apply the change.", None);
              self.rt.update(|m| m.restarting());
              pending = Some(Pending::Config);
              self.stop_process(&mut deadline, policy.stop_grace);
            }
            if outcome.fatal {
              self.stop_process(&mut deadline, policy.fatal_grace);
            }
          }
          None => lines_open = false,
        },
        command = self.commands.recv(), if commands_open => {
          let next = match command {
            Some(Command::Stop(done)) => Pending::Stop(done),
            Some(Command::Restart { dir, options, done }) => {
              self.rt.update(|m| m.restarting());
              Pending::Restart { dir, options, done: Some(done) }
            }
            None => {
              commands_open = false;
              Pending::Stop(None)
            }
          };
          // The newest request wins; the one it replaces is answered.
          if let Some(previous) = pending.replace(next) {
            previous.acknowledge();
          }
          self.stop_process(&mut deadline, policy.stop_grace);
        },
        exit = child.wait() => break exit.ok(),
        _ = tokio::time::sleep_until(deadline.unwrap_or_else(far)), if deadline.is_some() && !killed => {
          self.rt.log("fabricator", "warn", "The local backend didn't stop in time, so Fabricator ended it.", None);
          if let Some(pid) = pid {
            process::kill_tree(pid);
          }
          let _ = child.start_kill();
          killed = true;
        }
      }
    };
    // The rest of its output, such as the final `stopped` event.
    let until = tokio::time::Instant::now() + Duration::from_secs(1);
    while lines_open {
      match tokio::time::timeout_at(until, lines.recv()).await {
        Ok(Some((stream, text))) => {
          self.rt.handle_line(stream, &text, &token);
        }
        _ => break,
      }
    }
    self.rt.detach(self.generation);
    Ok(Ended { pending, exit_code: status.and_then(|s| s.code()) })
  }

  /// Close its stdin, the signal to stop, and give it `grace` to do so.
  fn stop_process(&self, deadline: &mut Option<tokio::time::Instant>, grace: Duration) {
    self.rt.close_stdin(self.generation);
    if deadline.is_none() {
      *deadline = Some(tokio::time::Instant::now() + grace);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_launch_carries_a_token_it_never_shows() {
    let token = ControlToken::generate();
    let host = HostEnv {
      path: Some("C:\\node;C:\\bin".into()),
      node: Some(PathBuf::from("C:\\node\\node.exe")),
      config_dir: Some(PathBuf::from("C:\\Users\\me\\.rayfin")),
    };
    let binary = Binary::executable(PathBuf::from("C:\\Fabricator\\rayfin-local.exe"));
    let options = LocalStartOptions { force_schema: true, reset: false, sign_in_as: Some("user:ana@example.com".into()) };
    let dir = PathBuf::from("C:\\apps\\my notes");
    let spec = launch_spec(&binary, &dir, &options, &token, &host);

    let env = |key: &str| spec.env.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string_lossy().into_owned());
    let secret = env(TOKEN_ENV).expect("the control token");
    assert!(secret.len() >= 32);
    assert_eq!(secret, token.expose());
    assert_eq!(env("NO_COLOR").as_deref(), Some("1"));
    assert_eq!(env("RAYFIN_LOCAL_NODE").as_deref(), Some("C:\\node\\node.exe"));
    assert_eq!(env("RAYFIN_CONFIG_DIR").as_deref(), Some("C:\\Users\\me\\.rayfin"));
    assert_eq!(env("PATH").as_deref(), Some("C:\\node;C:\\bin"));

    let args: Vec<String> = spec.args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    assert_eq!(args, ["serve", "--json", "-C", "C:\\apps\\my notes", "--force-schema", "--sign-in-as", "user:ana@example.com"]);
    assert_eq!(spec.cwd, dir);

    let shown = format!("{spec:?} {}", spec.describe());
    assert!(!shown.contains(token.expose()), "{shown}");
    assert!(shown.contains("RAYFIN_LOCAL_CONTROL_TOKEN") && shown.contains("***"));
    assert!(spec.describe().contains("\"C:\\apps\\my notes\""));
  }

  #[tokio::test]
  async fn reads_lines_and_cuts_very_long_ones() {
    let long = "x".repeat(MAX_LINE_BYTES + 10);
    let input = format!("one\r\n{long}\ntwo");
    let (tx, mut rx) = mpsc::unbounded_channel();
    read_lines(input.as_bytes(), Stream::Stdout, tx).await;
    let mut got = Vec::new();
    while let Some((_, line)) = rx.recv().await {
      got.push(line);
    }
    assert_eq!(got.len(), 3);
    assert_eq!(got[0], "one");
    assert_eq!(got[1].len(), MAX_LINE_BYTES);
    assert_eq!(got[2], "two");
  }
}
