//! Fabricator's own MCP client for the tools people make: it starts a tool's
//! server with Node.js and speaks MCP to it over standard input and output, to
//! check that it starts and list its tools while Copilot makes it, and to try
//! one from the MCP servers dialog. Chats reach the tools through the Copilot
//! runtime instead (see `services::mcp`).

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::task::JoinHandle;

use crate::services::exec::CancelToken;
use crate::types::MadeToolSpec;

/// The MCP version Fabricator asks for.
const PROTOCOL: &str = "2025-06-18";
/// How long a server may take to start and answer.
const START_WAIT: Duration = Duration::from_secs(20);
/// How long listing its tools may take.
const LIST_WAIT: Duration = Duration::from_secs(10);
/// The most of a server's error output kept, from its end.
const MAX_ERROR_OUTPUT: usize = 3000;

/// What a tool's server gets of Fabricator's environment: what Node.js and its
/// network requests need, and nothing else. Its keys are added to it.
const INHERITED: &[&str] = &[
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "USERNAME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/// Why a tool's server didn't answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Failure {
  /// Node.js isn't on this computer.
  NoNode,
  /// Node.js couldn't be started.
  Spawn(String),
  /// It stopped, with the end of what it wrote to its error output.
  Stopped(String),
  /// It didn't answer in time.
  Slow,
  Cancelled,
  /// It answered with an error.
  Answer(String),
}

impl Failure {
  /// What went wrong, for Copilot.
  pub fn for_model(&self) -> String {
    match self {
      Failure::NoNode => "Node.js isn't on this computer, so Fabricator can't start the tool.".into(),
      Failure::Spawn(e) => format!("Fabricator couldn't start Node.js ({e})."),
      Failure::Stopped(output) if output.is_empty() => "It stopped without saying why.".into(),
      Failure::Stopped(output) => format!("It stopped. The end of its error output:\n{output}"),
      Failure::Slow => "It didn't answer in time. Call serve() when the module loads, and don't wait for anything \
                        before it."
        .into(),
      Failure::Cancelled => "Cancelled.".into(),
      Failure::Answer(e) => format!("It answered with an error: {e}"),
    }
  }

  /// What went wrong, for the user.
  pub fn for_user(&self) -> String {
    match self {
      Failure::NoNode => t!("services.toolMaker.noNode"),
      Failure::Spawn(e) => t!("services.toolMaker.cantStart", error = e),
      Failure::Stopped(output) if output.is_empty() => t!("services.toolMaker.stopped"),
      Failure::Stopped(output) => t!("services.toolMaker.stoppedWith", output = output),
      Failure::Slow => t!("services.toolMaker.slow"),
      Failure::Cancelled => t!("services.toolMaker.cancelled"),
      Failure::Answer(e) => t!("services.toolMaker.answered", error = e),
    }
  }
}

/// A tool's server, running. Dropping it stops it.
pub struct Server {
  child: Child,
  stdin: ChildStdin,
  lines: Lines<BufReader<ChildStdout>>,
  errors: Arc<Mutex<String>>,
  drain: Option<JoinHandle<()>>,
  next: u64,
}

/// Keeps the end of what a server writes to its error output.
async fn collect(mut pipe: ChildStderr, into: Arc<Mutex<String>>) {
  let mut chunk = [0u8; 4096];
  loop {
    match pipe.read(&mut chunk).await {
      Ok(0) | Err(_) => break,
      Ok(n) => {
        let mut text = into.lock().unwrap();
        text.push_str(&String::from_utf8_lossy(&chunk[..n]));
        if text.len() > MAX_ERROR_OUTPUT * 2 {
          let mut cut = text.len() - MAX_ERROR_OUTPUT;
          while !text.is_char_boundary(cut) {
            cut += 1;
          }
          text.drain(..cut);
        }
      }
    }
  }
}

/// The end of a server's error output, without terminal colors.
fn tail(output: &str) -> String {
  let clean = crate::commands::chat_tools::strip_ansi(output);
  let clean = clean.trim();
  let start = clean.char_indices().rev().nth(MAX_ERROR_OUTPUT - 1).map_or(0, |(i, _)| i);
  clean[start..].to_string()
}

/// A tool's tools, as its `tools/list` reply has them.
fn specs(listed: &Value) -> Result<Vec<MadeToolSpec>, Failure> {
  let tools = listed
    .get("tools")
    .and_then(Value::as_array)
    .ok_or_else(|| Failure::Answer("its tools/list reply has no list of tools".into()))?;
  Ok(
    tools
      .iter()
      .filter_map(|tool| {
        Some(MadeToolSpec {
          name: tool.get("name")?.as_str()?.to_string(),
          description: tool.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
          input_schema: tool.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object" })),
          read_only: tool.pointer("/annotations/readOnlyHint").and_then(Value::as_bool).unwrap_or(false),
        })
      })
      .collect(),
  )
}

impl Server {
  /// Starts the server at `script`, in `cwd`, with `env` beside what Node.js needs.
  pub fn start(script: &Path, cwd: &Path, env: &[(String, String)]) -> Result<Server, Failure> {
    let node = which::which("node").map_err(|_| Failure::NoNode)?;
    let mut cmd = Command::new(node);
    cmd.arg(script).current_dir(cwd).env_clear();
    for name in INHERITED {
      if let Some(value) = std::env::var_os(name) {
        cmd.env(name, value);
      }
    }
    cmd.envs(env.iter().map(|(name, value)| (name, value)));
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    {
      // CREATE_NO_WINDOW: no console flashes up.
      cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| Failure::Spawn(e.to_string()))?;
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
      return Err(Failure::Spawn("its input and output weren't there".into()));
    };
    let errors = Arc::new(Mutex::new(String::new()));
    let drain = tokio::spawn(collect(stderr, errors.clone()));
    Ok(Server { child, stdin, lines: BufReader::new(stdout).lines(), errors, drain: Some(drain), next: 0 })
  }

  /// It stopped: why, from its error output once it's written.
  async fn stopped(&mut self) -> Failure {
    let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
    if let Some(drain) = self.drain.take() {
      let _ = tokio::time::timeout(Duration::from_secs(1), drain).await;
    }
    Failure::Stopped(tail(&self.errors.lock().unwrap()))
  }

  async fn write(&mut self, message: &Value) -> Result<(), Failure> {
    let mut line = message.to_string();
    line.push('\n');
    if self.stdin.write_all(line.as_bytes()).await.is_err() || self.stdin.flush().await.is_err() {
      return Err(self.stopped().await);
    }
    Ok(())
  }

  async fn notify(&mut self, method: &str, params: Value) -> Result<(), Failure> {
    self.write(&json!({ "jsonrpc": "2.0", "method": method, "params": params })).await
  }

  /// Reads until the reply to request `id`.
  async fn reply(&mut self, id: u64) -> Result<Value, Failure> {
    loop {
      let line = match self.lines.next_line().await {
        Ok(Some(line)) => line,
        Ok(None) | Err(_) => return Err(self.stopped().await),
      };
      let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
        continue;
      };
      if message.get("method").is_some() {
        // A request of its own: Fabricator offers servers nothing.
        if let Some(asked) = message.get("id").filter(|v| !v.is_null()).cloned() {
          let error = json!({ "code": -32601, "message": "Fabricator doesn't offer this." });
          self.write(&json!({ "jsonrpc": "2.0", "id": asked, "error": error })).await?;
        }
        continue;
      }
      if message.get("id").and_then(Value::as_u64) != Some(id) {
        continue;
      }
      if let Some(error) = message.get("error") {
        let text = error.get("message").and_then(Value::as_str).unwrap_or("no message");
        return Err(Failure::Answer(text.to_string()));
      }
      return Ok(message.get("result").cloned().unwrap_or(Value::Null));
    }
  }

  async fn request(
    &mut self,
    method: &str,
    params: Value,
    wait: Duration,
    cancel: Option<&CancelToken>,
  ) -> Result<Value, Failure> {
    self.next += 1;
    let id = self.next;
    self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
    let never = CancelToken::new();
    let cancel = cancel.unwrap_or(&never);
    let outcome = tokio::select! {
      replied = tokio::time::timeout(wait, self.reply(id)) => replied.unwrap_or(Err(Failure::Slow)),
      _ = cancel.wait_cancelled() => Err(Failure::Cancelled),
    };
    if matches!(outcome, Err(Failure::Slow | Failure::Cancelled)) {
      let _ = self.notify("notifications/cancelled", json!({ "requestId": id })).await;
    }
    outcome
  }

  /// Begins MCP with it, and lists its tools.
  pub async fn tools(&mut self, cancel: Option<&CancelToken>) -> Result<Vec<MadeToolSpec>, Failure> {
    let hello = json!({
      "protocolVersion": PROTOCOL,
      "capabilities": {},
      "clientInfo": { "name": "Fabricator", "version": env!("CARGO_PKG_VERSION") }
    });
    self.request("initialize", hello, START_WAIT, cancel).await?;
    self.notify("notifications/initialized", json!({})).await?;
    let listed = self.request("tools/list", json!({}), LIST_WAIT, cancel).await?;
    specs(&listed)
  }

  /// Calls its tool `name` with `args`: the result, as MCP has it.
  pub async fn call(&mut self, name: &str, args: Value, wait: Duration, cancel: &CancelToken) -> Result<Value, Failure> {
    self.request("tools/call", json!({ "name": name, "arguments": args }), wait, Some(cancel)).await
  }

  /// Stops it, and waits until it has: closing its input ends a kit server,
  /// and one that doesn't end is killed. Until then it holds its folder.
  pub async fn stop(mut self) {
    drop(self.stdin);
    if tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await.is_err() {
      let _ = self.child.kill().await;
    }
  }
}
