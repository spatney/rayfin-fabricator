//! Tools people make with Copilot. The user describes a tool, such as one that
//! makes images with their OpenAI key, and Copilot writes it as a small MCP
//! server in JavaScript, built on Fabricator's tool kit (`kit.mjs`, which
//! speaks MCP for it). Fabricator keeps it in its app data (`tools/<id>/`) and
//! runs it with Node.js. Each one is among the user's MCP servers (with
//! `made`), so a chat turns it on among its plugins like any other.
//!
//! While it works, Copilot can read documentation on the web, and hands the
//! tool over through `fabricator_save_tool`, which starts it on its own and
//! lists its tools ([`client`]), without its keys and without calling a tool,
//! so Copilot can fix what doesn't start. Only a tool that started is kept.
//! The user can change it later the same way ([`change`]), read its code, try
//! its tools with their keys in a folder of its own ([`try_tool`]), and share
//! it as a file that never holds a key ([`export`], [`import`]).

mod client;
mod prompt;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use base64::Engine as _;
use github_copilot_sdk::handler::{PermissionHandler, PermissionResult};
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::{DeferMode, ToolInvocation};
use github_copilot_sdk::{Error as SdkError, PermissionRequestData, RequestId, SessionId, Tool, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use self::client::{Failure, Server};
use self::prompt::Brief;
use crate::commands::advisor::{self, DrainEnd, RunCtx, TextAcc};
use crate::services::agent_tools::failure;
use crate::services::byok::ByokManager;
use crate::services::copilot::{CopilotManager, ModelChoice, SessionOptions};
use crate::services::exec::CancelToken;
use crate::services::mcp;
use crate::services::{paths, store};
use crate::types::{
  MadeTool, MadeToolSpec, McpServerEntry, McpServerInput, McpToolInfo, McpTransport, SharedToolKey, ToolCode,
  ToolImportInput, ToolImportPreview, ToolMadeResult, ToolMakeInput, ToolMakerEvent, ToolTryContent, ToolTryFile,
  ToolTryResult,
};

/// Fabricator's tool kit, written beside each tool's code.
const KIT: &str = include_str!("kit.mjs");
const KIT_FILE: &str = "kit.mjs";
/// A tool's code.
const SERVER_FILE: &str = "server.mjs";
/// Its code before the last change.
const PREVIOUS_FILE: &str = "server.previous.mjs";
/// The folder a try runs in, standing in for an app's.
const TRY_FOLDER: &str = "try";
/// Where Copilot works on a tool, one folder per run.
const DRAFTS: &str = ".drafts";
const SAVE_TOOL: &str = "fabricator_save_tool";

const MAX_CODE: usize = 256 * 1024;
const MAX_SUMMARY: usize = 120;
/// The longest name Copilot gives a tool.
const MAX_TOOL_NAME: usize = 50;
const MAX_REQUEST: usize = 4000;
/// The requests a tool remembers, the latest.
const MAX_REQUESTS: usize = 10;
const MAX_KEYS: usize = 20;
/// The most times Copilot saves a tool in one run.
const MAX_SAVES: usize = 12;
/// The longest Copilot works on a tool in one try.
const RUN_TIMEOUT_MS: u64 = 10 * 60_000;
/// How long a tool may take when it's tried.
const TRY_WAIT: Duration = Duration::from_secs(5 * 60);
/// What a try shows of its text, and of its pictures.
const MAX_TRY_TEXT: usize = 20_000;
const MAX_TRY_IMAGES: usize = 4;
const MAX_TRY_IMAGE_BYTES: u64 = 4 * 1024 * 1024;
/// The files a try lists.
const MAX_TRY_FILES: usize = 20;
/// The largest shared tool's file.
const MAX_SHARED_BYTES: u64 = 1024 * 1024;
/// The format of a shared tool's file.
const SHARED_FORMAT: u32 = 1;

/* ---------------------------------- files --------------------------------- */

/// Whether `id` is a tool's id that names a folder of its own.
fn safe_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn tool_dir(id: &str) -> PathBuf {
  paths::tools_dir().join(id)
}

fn server_path(id: &str) -> PathBuf {
  tool_dir(id).join(SERVER_FILE)
}

/// What a session runs for tool `id`: Node.js with its code.
pub fn launch(id: &str) -> (String, Vec<String>) {
  ("node".to_string(), vec![server_path(id).to_string_lossy().into_owned()])
}

/// A fingerprint of tool `id`'s code, so a chat's session starts the code as
/// it is now. Empty when it can't be read.
pub fn code_revision(id: &str) -> String {
  std::fs::read(server_path(id)).map(|code| hex::encode(&Sha256::digest(&code)[..8])).unwrap_or_default()
}

/// Deletes tool `id`'s folder: its code and what its tries saved.
pub fn forget(id: &str) {
  if safe_id(id) {
    let _ = std::fs::remove_dir_all(tool_dir(id));
  }
}

/// Writes the tool kit beside tool `id`'s code, as this Fabricator has it.
pub fn refresh_kit(id: &str) -> Result<(), String> {
  let path = tool_dir(id).join(KIT_FILE);
  if std::fs::read_to_string(&path).ok().as_deref() == Some(KIT) {
    return Ok(());
  }
  std::fs::create_dir_all(tool_dir(id)).and_then(|_| std::fs::write(&path, KIT)).map_err(cant_save)
}

fn cant_save(error: std::io::Error) -> String {
  t!("services.toolMaker.cantSave", error = error)
}

/// Keeps `code` as tool `id`'s, with the kit; the code it replaces is kept
/// beside it. A new tool starts from an empty folder.
fn install(id: &str, code: &str, new: bool) -> Result<(), String> {
  if !safe_id(id) {
    return Err(t!("services.toolMaker.gone"));
  }
  let dir = tool_dir(id);
  if new {
    let _ = std::fs::remove_dir_all(&dir);
  }
  std::fs::create_dir_all(&dir).map_err(cant_save)?;
  let server = dir.join(SERVER_FILE);
  if !new && server.is_file() {
    let _ = std::fs::copy(&server, dir.join(PREVIOUS_FILE));
  }
  std::fs::write(dir.join(KIT_FILE), KIT).map_err(cant_save)?;
  std::fs::write(&server, code).map_err(cant_save)
}

/// A folder Copilot works in, with the kit; deleted when it's done.
struct Draft {
  path: PathBuf,
}

impl Draft {
  fn new() -> Result<Draft, String> {
    let drafts = paths::tools_dir().join(DRAFTS);
    sweep(&drafts);
    let path = drafts.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&path).map_err(cant_save)?;
    std::fs::write(path.join(KIT_FILE), KIT).map_err(cant_save)?;
    Ok(Draft { path })
  }

  fn root(&self) -> String {
    self.path.to_string_lossy().into_owned()
  }
}

impl Drop for Draft {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.path);
  }
}

/// Deletes drafts a run left behind, such as when Fabricator closed during one.
fn sweep(drafts: &Path) {
  let Ok(entries) = std::fs::read_dir(drafts) else {
    return;
  };
  let day = Duration::from_secs(24 * 60 * 60);
  for entry in entries.flatten() {
    let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > day);
    if old {
      let _ = std::fs::remove_dir_all(entry.path());
    }
  }
}

/* --------------------------------- checks --------------------------------- */

fn now() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Whether `code` is built on the kit.
fn imports_kit(code: &str) -> bool {
  code.contains("./kit.mjs")
}

/// `text` on one line, cut to `max` characters.
fn one_line(text: &str, max: usize) -> String {
  let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
  match line.char_indices().nth(max) {
    Some((end, _)) => format!("{}…", line[..end].trim_end()),
    None => line,
  }
}

/// What the user asks for, checked.
fn request_text(request: &str) -> Result<String, String> {
  let request = request.trim();
  if request.is_empty() {
    return Err(t!("services.toolMaker.describe"));
  }
  if request.chars().count() > MAX_REQUEST {
    return Err(t!("services.toolMaker.requestTooLong", max = MAX_REQUEST));
  }
  Ok(request.to_string())
}

/// The environment variables a tool's code says it reads, checked.
fn keys_from(keys: &[String]) -> Result<Vec<String>, String> {
  let mut out: Vec<String> = Vec::new();
  for key in keys.iter().map(|k| k.trim()).filter(|k| !k.is_empty()) {
    if !mcp::is_env_name(key) {
      return Err(format!("{key} can't be the name of an environment variable."));
    }
    if !out.iter().any(|k| k.eq_ignore_ascii_case(key)) {
      out.push(key.to_string());
    }
  }
  if out.len() > MAX_KEYS {
    return Err(format!("A tool can read at most {MAX_KEYS} environment variables."));
  }
  Ok(out)
}

/// Starts the tool at `script` on its own, in `cwd`, without keys, and lists its tools.
async fn check(script: &Path, cwd: &Path) -> Result<Vec<MadeToolSpec>, Failure> {
  let mut server = Server::start(script, cwd, &[])?;
  let listed = server.tools(None).await;
  server.stop().await;
  let tools = listed?;
  if tools.is_empty() {
    return Err(Failure::Answer("it offers no tools".into()));
  }
  Ok(tools)
}

/// A tool as a list shows it.
fn info(spec: &MadeToolSpec) -> McpToolInfo {
  let description = one_line(&spec.description, 240);
  McpToolInfo { name: spec.name.clone(), description: (!description.is_empty()).then_some(description) }
}

/// The tool `id`, made with Copilot.
fn made_entry(id: &str) -> Result<McpServerEntry, String> {
  store::mcp_servers()
    .into_iter()
    .find(|s| s.id == id && s.made.is_some())
    .ok_or_else(|| t!("services.toolMaker.gone"))
}

/// The environment variables `entry` gets, with the provider whose key each holds.
fn keys_of(entry: &McpServerEntry) -> Vec<(String, Option<String>)> {
  entry.env.iter().map(|name| (name.clone(), entry.provider_keys.get(name).map(|p| mcp::provider_name(p)))).collect()
}

/// `entry`'s environment variables with their values, for its server.
fn env_of(entry: &McpServerEntry) -> Result<Vec<(String, String)>, String> {
  let values = mcp::load_values(entry)?;
  Ok(entry.env.iter().filter_map(|name| values.env.get(name).map(|value| (name.clone(), value.clone()))).collect())
}

/* --------------------------------- making --------------------------------- */

/// What reports a run's progress.
pub type Progress = Arc<dyn Fn(ToolMakerEvent) + Send + Sync>;

/// Where Copilot makes a tool, and how it reports and stops.
pub struct Job<'a> {
  pub copilot: &'a CopilotManager,
  pub byok: &'a ByokManager,
  pub choice: ModelChoice,
  pub cancel: &'a CancelToken,
  pub progress: Progress,
}

/// A tool Copilot saved, and it started.
#[derive(Clone, Debug, Default)]
struct Saved {
  code: String,
  summary: String,
  /// The name Copilot gave it, when the user left that to Copilot.
  name: String,
  /// The environment variables its code reads.
  keys: Vec<String>,
  tools: Vec<MadeToolSpec>,
  /// What Copilot said about it.
  message: String,
}

#[derive(Default)]
struct Attempts {
  /// The last one that started.
  good: Option<Saved>,
  /// The code saved last, and why it didn't start.
  code: Option<String>,
  failed: Option<Failure>,
  saves: usize,
}

/// `fabricator_save_tool`: saves Copilot's code in its draft, and starts it.
struct Checker {
  draft: PathBuf,
  progress: Progress,
  /// Copilot names the tool when it saves it.
  names: bool,
  attempts: Mutex<Attempts>,
  /// One save at a time.
  one: tokio::sync::Mutex<()>,
}

#[derive(Deserialize, Default)]
struct SaveArgs {
  #[serde(default)]
  code: String,
  #[serde(default)]
  summary: String,
  #[serde(default)]
  name: String,
  #[serde(default)]
  keys: Vec<String>,
}

impl Checker {
  fn new(draft: PathBuf, progress: Progress, names: bool) -> Self {
    Checker { draft, progress, names, attempts: Mutex::default(), one: tokio::sync::Mutex::new(()) }
  }

  fn good(&self) -> Option<Saved> {
    self.attempts.lock().unwrap().good.clone()
  }

  /// A new session starts with all its saves.
  fn fresh_budget(&self) {
    self.attempts.lock().unwrap().saves = 0;
  }

  /// The code saved last, and why it didn't start.
  fn last(&self) -> (Option<String>, Option<Failure>) {
    let attempts = self.attempts.lock().unwrap();
    (attempts.code.clone(), attempts.failed.clone())
  }

  /// Saves and starts the tool: what to tell Copilot.
  async fn save(&self, args: SaveArgs) -> Result<String, String> {
    let _one = self.one.lock().await;
    {
      let mut attempts = self.attempts.lock().unwrap();
      attempts.saves += 1;
      if attempts.saves > MAX_SAVES {
        return Err("You've saved it too many times. Stop, and tell the user what keeps going wrong.".into());
      }
    }
    let code = args.code.trim_start_matches('\u{feff}');
    if code.trim().is_empty() {
      return Err("Pass the whole of server.mjs as `code`.".into());
    }
    if code.len() > MAX_CODE {
      return Err(format!("The code is too long: keep it under {} KB.", MAX_CODE / 1024));
    }
    if !imports_kit(code) {
      return Err("Build the tool on the kit: `import { serve } from './kit.mjs'`, then call serve().".into());
    }
    let summary = one_line(&args.summary, MAX_SUMMARY);
    if summary.is_empty() {
      return Err("Pass a `summary`: what the tool does, in one short line.".into());
    }
    let name = one_line(&args.name, MAX_TOOL_NAME);
    if self.names && name.is_empty() {
      return Err("Pass a `name`: the tool's name in two or three words, such as \"Word lookup\".".into());
    }
    let keys = keys_from(&args.keys)?;
    self.attempts.lock().unwrap().code = Some(code.to_string());
    (self.progress)(ToolMakerEvent::Writing { code: code.to_string() });
    (self.progress)(ToolMakerEvent::Checking);
    let script = self.draft.join(SERVER_FILE);
    std::fs::write(&script, code).map_err(|e| format!("Fabricator couldn't save it ({e}). Try again."))?;
    match check(&script, &self.draft).await {
      Ok(tools) => {
        let names: Vec<String> = tools.iter().map(|t| t.name.clone()).collect();
        (self.progress)(ToolMakerEvent::Works { tools: names.clone() });
        let mut attempts = self.attempts.lock().unwrap();
        attempts.failed = None;
        attempts.good = Some(Saved { code: code.to_string(), summary, name, keys, tools, message: String::new() });
        Ok(format!(
          "Saved. It started, and offers: {}. Fabricator didn't call them. If that's all, end with one or two \
           sentences for the user.",
          names.join(", ")
        ))
      }
      Err(failed) => {
        (self.progress)(ToolMakerEvent::Failed { error: failed.for_user() });
        let error = failed.for_model();
        self.attempts.lock().unwrap().failed = Some(failed);
        Err(format!("It didn't start. {error}\n\nFix it, and save the whole file again."))
      }
    }
  }
}

struct SaveHandler(Arc<Checker>);

#[async_trait]
impl ToolHandler for SaveHandler {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let args = invocation.params::<SaveArgs>().unwrap_or_default();
    Ok(match self.0.save(args).await {
      Ok(text) => ToolResult::Text(text),
      Err(text) => failure(text),
    })
  }
}

fn save_tool(checker: Arc<Checker>) -> Tool {
  let mut properties = json!({
    "code": { "type": "string", "description": "The whole of server.mjs." },
    "summary": { "type": "string", "description": "What the tool does, in one short line for lists." },
    "keys": {
      "type": "array",
      "items": { "type": "string" },
      "description": "The environment variables the code reads with tool.env(), such as OPENAI_API_KEY."
    }
  });
  let mut required = vec!["code", "summary"];
  if checker.names {
    properties["name"] = json!({ "type": "string", "description": "The tool's name in two or three words, such as \"Word lookup\"." });
    required.push("name");
  }
  Tool::new(SAVE_TOOL)
    .with_description(
      "Save the tool's code as server.mjs, start it on its own and list its tools. Pass the whole file each time. \
       It says why when the tool didn't start.",
    )
    .with_parameters(json!({ "type": "object", "properties": properties, "required": required }))
    .with_skip_permission(true)
    .with_defer(DeferMode::Never)
    .with_handler(Arc::new(SaveHandler(checker)))
}

/// Whether `ip` is on the internet, not this computer or a private network.
fn public_ip(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(v4) => {
      let [a, b, ..] = v4.octets();
      !(v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_documentation()
        || a == 0
        || (a == 100 && (b & 0xc0) == 64))
    }
    IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
      Some(v4) => public_ip(IpAddr::V4(v4)),
      None => {
        let first = v6.segments()[0];
        !(v6.is_loopback() || v6.is_unspecified() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80)
      }
    },
  }
}

/// A page Copilot may read while it makes a tool: https, on the internet.
fn public_page(url: &str) -> bool {
  let Ok(url) = reqwest::Url::parse(url.trim()) else {
    return false;
  };
  if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
    return false;
  }
  let Some(host) = url.host_str() else {
    return false;
  };
  let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
  match host.parse::<IpAddr>() {
    Ok(ip) => public_ip(ip),
    Err(_) => {
      host.contains('.') && ![".localhost", ".local", ".internal", ".lan", ".home.arpa"].iter().any(|end| host.ends_with(end))
    }
  }
}

/// What a session that makes a tool may do: read pages on the web, and save the
/// tool. It can't read or write files, run commands or use MCP servers.
fn permitted(data: &PermissionRequestData) -> bool {
  let body = advisor::request_body(data);
  if body.get("requestSandboxBypass").and_then(Value::as_bool) == Some(true) {
    return false;
  }
  match advisor::request_kind(data).as_deref() {
    Some("url") => body.get("url").and_then(Value::as_str).is_some_and(public_page),
    Some("custom-tool") => true,
    _ => false,
  }
}

struct MakerPolicy;

#[async_trait]
impl PermissionHandler for MakerPolicy {
  async fn handle(&self, _: SessionId, _: RequestId, data: PermissionRequestData) -> PermissionResult {
    if permitted(&data) {
      return PermissionResult::approve_once();
    }
    log::info!("Making a tool: denied a {} request", advisor::request_kind(&data).unwrap_or_else(|| "unknown".into()));
    PermissionResult::user_not_available()
  }
}

/// How one session that makes a tool ended: how it stopped, what Copilot said
/// last, and the session's error, if it had one.
struct Ended {
  end: DrainEnd,
  answer: String,
  error: Option<String>,
}

/// Reads JSON as far as it's written, such as a tool call's arguments while
/// Copilot streams them.
struct Scan<'a> {
  chars: std::iter::Peekable<std::str::Chars<'a>>,
}

impl Scan<'_> {
  fn space(&mut self) {
    while self.chars.next_if(|c| c.is_whitespace()).is_some() {}
  }

  /// Whether `want` comes next, past any space; it's read when it does.
  fn eat(&mut self, want: char) -> bool {
    self.space();
    self.chars.next_if_eq(&want).is_some()
  }

  /// A string's text after its opening quote, and whether it ended. An escape
  /// cut off by the end isn't in the text.
  fn string(&mut self) -> (String, bool) {
    let mut text = String::new();
    loop {
      match self.chars.next() {
        None => return (text, false),
        Some('"') => return (text, true),
        Some('\\') => {
          let decoded = match self.chars.next() {
            None => None,
            Some('n') => Some('\n'),
            Some('t') => Some('\t'),
            Some('r') => Some('\r'),
            Some('b') => Some('\u{8}'),
            Some('f') => Some('\u{c}'),
            Some('u') => self.unicode(),
            Some(other) => Some(other),
          };
          match decoded {
            Some(c) => text.push(c),
            None => return (text, false),
          }
        }
        Some(c) => text.push(c),
      }
    }
  }

  /// The character of a `\uXXXX` escape (with its low half, for a surrogate
  /// pair); none when the JSON ends first.
  fn unicode(&mut self) -> Option<char> {
    let hex = |scan: &mut Self| -> Option<u32> {
      let digits: String = (0..4).map_while(|_| scan.chars.next()).collect();
      if digits.len() < 4 {
        return None;
      }
      Some(u32::from_str_radix(&digits, 16).unwrap_or(0xfffd))
    };
    let high = hex(self)?;
    if !(0xd800..0xdc00).contains(&high) {
      return Some(char::from_u32(high).unwrap_or('\u{fffd}'));
    }
    if self.chars.next()? != '\\' || self.chars.next()? != 'u' {
      return Some('\u{fffd}');
    }
    let low = hex(self)?;
    if !(0xdc00..0xe000).contains(&low) {
      return Some('\u{fffd}');
    }
    Some(char::from_u32(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00)).unwrap_or('\u{fffd}'))
  }

  /// Reads past a value; false when the JSON ends first.
  fn skip(&mut self) -> bool {
    self.space();
    match self.chars.peek() {
      None => false,
      Some('"') => {
        self.chars.next();
        self.string().1
      }
      Some('{' | '[') => {
        let mut depth = 0;
        while let Some(c) = self.chars.next() {
          match c {
            '{' | '[' => depth += 1,
            '}' | ']' => {
              depth -= 1;
              if depth == 0 {
                return true;
              }
            }
            '"' if !self.string().1 => return false,
            _ => {}
          }
        }
        false
      }
      // A number, true, false or null.
      Some(_) => {
        while self.chars.next_if(|c| !matches!(c, ',' | '}' | ']') && !c.is_whitespace()).is_some() {}
        self.chars.peek().is_some()
      }
    }
  }
}

/// The text of the string `key` holds in the JSON object `json`, as far as
/// it's written; none until it starts.
fn partial_string(json: &str, key: &str) -> Option<String> {
  let mut scan = Scan { chars: json.chars().peekable() };
  if !scan.eat('{') {
    return None;
  }
  loop {
    if !scan.eat('"') {
      return None;
    }
    let (name, ended) = scan.string();
    if !ended || !scan.eat(':') {
      return None;
    }
    if name == key && scan.eat('"') {
      return Some(scan.string().0);
    }
    if !scan.skip() || !scan.eat(',') {
      return None;
    }
  }
}

/// How often what Copilot says, and the code it writes, go to the dialog.
const LIVE_EVERY: Duration = Duration::from_millis(150);
/// The most of what Copilot says that the dialog gets: the end of it.
const MAX_SAYING: usize = 600;

/// `text` cut to its last `max` characters, from a word.
fn tail(text: &str, max: usize) -> String {
  let count = text.chars().count();
  if count <= max {
    return text.to_string();
  }
  let cut: String = text.chars().skip(count - max).collect();
  let from_word = cut.split_once(char::is_whitespace).map_or(cut.as_str(), |(_, rest)| rest);
  format!("…{}", from_word.trim_start())
}

/// `code` cut to the longest a tool's code may be.
fn capped(mut code: String) -> String {
  if code.len() > MAX_CODE {
    let mut end = MAX_CODE;
    while !code.is_char_boundary(end) {
      end -= 1;
    }
    code.truncate(end);
  }
  code
}

/// What Copilot does as a session streams: the model it runs on, what it
/// says, and the code it writes, sent to the dialog at most every
/// [`LIVE_EVERY`] each, and as soon as something else happens.
struct Live {
  progress: Progress,
  model: Option<String>,
  started: bool,
  /// The message Copilot is writing, and its text so far.
  message: String,
  said: String,
  said_due: bool,
  said_at: Option<Instant>,
  /// The arguments of each save Copilot writes, by tool call, and the one it
  /// writes now.
  saves: HashMap<String, String>,
  writing: Option<String>,
  code_due: bool,
  code_at: Option<Instant>,
}

impl Live {
  fn new(progress: Progress) -> Self {
    Live {
      progress,
      model: None,
      started: false,
      message: String::new(),
      said: String::new(),
      said_due: false,
      said_at: None,
      saves: HashMap::new(),
      writing: None,
      code_due: false,
      code_at: None,
    }
  }

  fn feed(&mut self, event_type: &str, data: &Value) {
    fn text<'a>(data: &'a Value, key: &str) -> &'a str {
      data.get(key).and_then(Value::as_str).unwrap_or_default()
    }
    match event_type {
      "session.auto_mode_resolved" if !text(data, "chosenModel").is_empty() => {
        self.model = Some(text(data, "chosenModel").into());
      }
      "model.turn_started" if !text(data, "model").is_empty() => self.model = Some(text(data, "model").into()),
      "assistant.turn_start" if !self.started => {
        self.started = true;
        (self.progress)(ToolMakerEvent::Started { model: self.model.clone() });
      }
      "assistant.message_delta" => {
        if text(data, "messageId") != self.message {
          self.message = text(data, "messageId").into();
          self.said.clear();
        }
        self.said.push_str(text(data, "deltaContent"));
        self.said_due = true;
      }
      "assistant.tool_call_delta" if text(data, "toolName") == SAVE_TOOL => {
        let id = text(data, "toolCallId");
        self.saves.entry(id.into()).or_default().push_str(text(data, "inputDelta"));
        self.writing = Some(id.into());
        self.code_due = true;
      }
      _ => {}
    }
    // Streams interleave their deltas; anything else sends what's waiting.
    self.send(!event_type.ends_with("_delta"));
  }

  fn send(&mut self, now: bool) {
    let due = |at: Option<Instant>| now || at.is_none_or(|at| at.elapsed() >= LIVE_EVERY);
    if self.said_due && due(self.said_at) {
      self.said_due = false;
      self.said_at = Some(Instant::now());
      let said = self.said.trim();
      if !said.is_empty() {
        (self.progress)(ToolMakerEvent::Saying { text: tail(said, MAX_SAYING) });
      }
    }
    if self.code_due && due(self.code_at) {
      self.code_due = false;
      self.code_at = Some(Instant::now());
      let code = self.writing.as_ref().and_then(|id| self.saves.get(id)).and_then(|args| partial_string(args, "code"));
      if let Some(code) = code.filter(|code| !code.trim().is_empty()) {
        (self.progress)(ToolMakerEvent::Writing { code: capped(code) });
      }
    }
  }
}

/// One session in which Copilot works on the tool in `draft`.
async fn session(job: &Job<'_>, draft: &Draft, checker: Arc<Checker>, prompt: String) -> Result<Ended, String> {
  let opts = SessionOptions {
    tools: vec![save_tool(checker)],
    available_tools: Some(vec!["web_fetch".into(), SAVE_TOOL.into()]),
    permission: Some(Arc::new(MakerPolicy)),
    untrusted: true,
    ..Default::default()
  };
  let root = draft.root();
  let run = RunCtx { copilot: job.copilot, byok: job.byok, root: &root, choice: job.choice.clone(), token: job.cancel };
  let progress = job.progress.clone();
  let mut live = Live::new(progress.clone());
  let mut text = TextAcc::default();
  let end = advisor::one_shot(&run, opts, prompt, RUN_TIMEOUT_MS, |event_type, data| {
    live.feed(event_type, data);
    if event_type == "tool.execution_start" && data.get("toolName").and_then(Value::as_str) == Some("web_fetch") {
      if let Some(url) = data.pointer("/arguments/url").and_then(Value::as_str) {
        progress(ToolMakerEvent::Reading { url: url.to_string() });
      }
    }
    text.feed(event_type, data);
    advisor::is_terminal(event_type)
  })
  .await?;
  Ok(Ended { end, answer: text.answer(), error: text.errored.clone() })
}

/// Why Copilot ended without a tool that works: why the tool didn't start, or
/// what Copilot said when it didn't save one.
fn didnt_work(failed: Option<Failure>, said: &str) -> String {
  match failed {
    Some(failed) => t!("services.toolMaker.didntWork", error = failed.for_user()),
    None if !said.trim().is_empty() => t!("services.toolMaker.notSavedSaid", said = said.trim()),
    None => t!("services.toolMaker.notSaved"),
  }
}

/// Has Copilot write the tool `brief` asks for in `draft`, trying once more
/// from what went wrong when its first run ends without a tool that starts.
async fn generate(job: &Job<'_>, brief: &Brief<'_>, draft: &Draft) -> Result<Saved, String> {
  let checker = Arc::new(Checker::new(draft.path.clone(), job.progress.clone(), brief.name.is_empty()));
  let mut prompt = prompt::make(brief);
  let mut said = String::new();
  for again in [false, true] {
    if again {
      (job.progress)(ToolMakerEvent::Retrying);
    }
    checker.fresh_budget();
    let ended = session(job, draft, checker.clone(), prompt).await?;
    if let Some(mut saved) = checker.good() {
      saved.message = ended.answer;
      return Ok(saved);
    }
    said = ended.answer;
    match ended.end {
      DrainEnd::Cancelled => return Err(t!("services.toolMaker.cancelled")),
      DrainEnd::TimedOut => return Err(didnt_work(checker.last().1, &said)),
      DrainEnd::Finished | DrainEnd::Closed => {}
    }
    // Copilot itself failed, such as a model that isn't available: starting
    // again wouldn't help.
    if let Some(error) = ended.error {
      return Err(error);
    }
    let (code, failed) = checker.last();
    let error = failed.map(|f| f.for_model());
    prompt = prompt::retry(brief, code.as_deref(), error.as_deref(), Some(&said));
  }
  Err(didnt_work(checker.last().1, &said))
}

/// What the dialog gets for a tool Copilot made or changed.
fn made_result(servers: Vec<McpServerEntry>, entry: &McpServerEntry, saved: Saved) -> ToolMadeResult {
  let missing_keys =
    saved.keys.iter().filter(|key| !entry.env.iter().any(|name| name.eq_ignore_ascii_case(key))).cloned().collect();
  ToolMadeResult {
    servers,
    id: entry.id.clone(),
    tools: saved.tools.iter().map(info).collect(),
    message: saved.message.trim().to_string(),
    missing_keys,
  }
}

/// The server to save for a new tool.
fn server_input(name: &str, env: &[crate::types::McpValueInput], read_only: bool) -> McpServerInput {
  McpServerInput {
    name: name.to_string(),
    transport: McpTransport::Stdio,
    env: env.to_vec(),
    read_only,
    ..Default::default()
  }
}

/// The keys a new tool gets now, and the names of the ones the user adds once
/// it's made: a key without a provider or a value yet.
fn split_keys(env: &[crate::types::McpValueInput]) -> (Vec<crate::types::McpValueInput>, Vec<String>) {
  let mut now: Vec<crate::types::McpValueInput> = Vec::new();
  let mut later: Vec<String> = Vec::new();
  for key in env {
    let name = key.name.trim();
    let valueless = key.provider.as_deref().is_none_or(|p| p.trim().is_empty()) && key.value.as_deref().unwrap_or_default().is_empty();
    if valueless && mcp::is_env_name(name) {
      if !later.iter().any(|n| n.eq_ignore_ascii_case(name)) {
        later.push(name.to_string());
      }
    } else {
      now.push(key.clone());
    }
  }
  later.retain(|name| !now.iter().any(|k| k.name.trim().eq_ignore_ascii_case(name)));
  (now, later)
}

/// Has Copilot make the tool `input` describes, and keeps it among the user's
/// MCP servers once it starts. Without a name, Copilot names it.
pub async fn make(job: &Job<'_>, input: &ToolMakeInput) -> Result<ToolMadeResult, String> {
  let request = request_text(&input.request)?;
  let (env, later) = split_keys(&input.env);
  let named = !input.name.trim().is_empty();
  // What can't be saved says so before Copilot starts.
  let checked_name = if named { input.name.clone() } else { unique_name("", &store::mcp_servers()) };
  let server = server_input(&checked_name, &env, input.read_only);
  let (entry, _) = mcp::made_entry_from(&server, &store::mcp_servers(), &now(), MadeTool::default())?;
  mcp::check_provider_keys(&entry)?;
  which::which("node").map_err(|_| Failure::NoNode.for_user())?;
  let draft = Draft::new()?;
  let mut keys = keys_of(&entry);
  keys.extend(later.into_iter().map(|name| (name, None)));
  let brief = Brief { name: if named { &entry.name } else { "" }, request: &request, keys, current: None, history: &[] };
  let saved = generate(job, &brief, &draft).await?;
  // Against the servers as they are now: one may have come meanwhile.
  let existing = store::mcp_servers();
  let name = if named { input.name.clone() } else { unique_name(&saved.name, &existing) };
  let server = server_input(&name, &env, input.read_only);
  let made = MadeTool { summary: saved.summary.clone(), requests: vec![request], updated_at: now(), ..Default::default() };
  let (entry, values) = mcp::made_entry_from(&server, &existing, &now(), made)?;
  install(&entry.id, &saved.code, true)?;
  let servers = mcp::store_entry(entry.clone(), &values).inspect_err(|_| forget(&entry.id))?;
  Ok(made_result(servers, &entry, saved))
}

/// Has Copilot change tool `id` as `request` asks, keeping the change once the
/// tool starts. The code it replaces is kept, so the change can be undone.
pub async fn change(job: &Job<'_>, id: &str, request: &str) -> Result<ToolMadeResult, String> {
  let request = request_text(request)?;
  let entry = made_entry(id)?;
  let code = std::fs::read_to_string(server_path(id)).map_err(|e| t!("services.toolMaker.cantRead", error = e))?;
  which::which("node").map_err(|_| Failure::NoNode.for_user())?;
  let draft = Draft::new()?;
  let history = entry.made.as_ref().map(|m| m.requests.clone()).unwrap_or_default();
  let brief = Brief { name: &entry.name, request: &request, keys: keys_of(&entry), current: Some(&code), history: &history };
  let saved = generate(job, &brief, &draft).await?;
  // As it is now: its keys may have changed meanwhile.
  let mut entry = made_entry(id)?;
  install(id, &saved.code, false)?;
  let before = entry.made.take().unwrap_or_default();
  let mut requests = before.requests;
  requests.push(request);
  let drop = requests.len().saturating_sub(MAX_REQUESTS);
  requests.drain(..drop);
  entry.made = Some(MadeTool {
    summary: saved.summary.clone(),
    requests,
    updated_at: now(),
    previous_summary: Some(before.summary),
  });
  let servers = store::upsert_mcp_server(entry.clone());
  mcp::MEMORY.reset_server(id);
  Ok(made_result(servers, &entry, saved))
}

/// Puts tool `id` back as it was before its last change: its code, what it
/// does, and what was asked of it. The change is gone afterwards.
pub fn undo(id: &str) -> Result<Vec<McpServerEntry>, String> {
  let mut entry = made_entry(id)?;
  restore_previous(&tool_dir(id))?;
  if let Some(made) = entry.made.as_mut() {
    undone(made);
  }
  let servers = store::upsert_mcp_server(entry);
  mcp::MEMORY.reset_server(id);
  Ok(servers)
}

/// Puts back the code in `dir` from before its last change.
fn restore_previous(dir: &Path) -> Result<(), String> {
  let previous = dir.join(PREVIOUS_FILE);
  let code = std::fs::read_to_string(&previous).map_err(|_| t!("services.toolMaker.nothingToUndo"))?;
  std::fs::write(dir.join(SERVER_FILE), code).map_err(cant_save)?;
  let _ = std::fs::remove_file(&previous);
  Ok(())
}

/// `made` as it was before its last change.
fn undone(made: &mut MadeTool) {
  made.requests.pop();
  if let Some(summary) = made.previous_summary.take() {
    made.summary = summary;
  }
  made.updated_at = now();
}

/* ---------------------------------- code ---------------------------------- */

/// Tool `id`'s code, to read, with its code before the last change.
pub fn code(id: &str) -> Result<ToolCode, String> {
  made_entry(id)?;
  let path = server_path(id);
  let code = std::fs::read_to_string(&path).map_err(|e| t!("services.toolMaker.cantRead", error = e))?;
  let previous = std::fs::read_to_string(tool_dir(id).join(PREVIOUS_FILE)).ok();
  Ok(ToolCode { code, path: path.to_string_lossy().into_owned(), previous })
}

/// Tool `id`'s code file, to show in the file manager.
pub fn code_file(id: &str) -> Result<PathBuf, String> {
  made_entry(id)?;
  Ok(server_path(id))
}

/// The folder tool `id`'s tries run in, made if it isn't there.
pub fn try_folder(id: &str) -> Result<PathBuf, String> {
  made_entry(id)?;
  let folder = tool_dir(id).join(TRY_FOLDER);
  std::fs::create_dir_all(&folder).map_err(cant_save)?;
  Ok(folder)
}

/* ----------------------------------- try ---------------------------------- */

/// Tool `id`'s tools, with what each takes.
pub async fn specs(id: &str) -> Result<Vec<MadeToolSpec>, String> {
  let folder = try_folder(id)?;
  refresh_kit(id)?;
  let mut server = Server::start(&server_path(id), &folder, &[]).map_err(|f| f.for_user())?;
  let listed = server.tools(None).await;
  server.stop().await;
  listed.map_err(|f| f.for_user())
}

/// Each file in `folder`, with its size and when it changed.
type Snapshot = HashMap<PathBuf, (u64, Option<SystemTime>)>;

fn snapshot(folder: &Path) -> Snapshot {
  fn walk(dir: &Path, depth: usize, out: &mut Snapshot) {
    let Ok(entries) = std::fs::read_dir(dir) else {
      return;
    };
    for entry in entries.flatten() {
      if out.len() >= 5000 {
        return;
      }
      let Ok(kind) = entry.file_type() else {
        continue;
      };
      if kind.is_dir() && depth < 8 {
        walk(&entry.path(), depth + 1, out);
      } else if kind.is_file() {
        if let Ok(meta) = entry.metadata() {
          out.insert(entry.path(), (meta.len(), meta.modified().ok()));
        }
      }
    }
  }
  let mut out = Snapshot::new();
  walk(folder, 0, &mut out);
  out
}

/// The kind of picture `bytes` are, of those a picture shows safely.
fn picture_kind(bytes: &[u8]) -> Option<&'static str> {
  if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    Some("image/png")
  } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
    Some("image/jpeg")
  } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
    Some("image/gif")
  } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
    Some("image/webp")
  } else {
    None
  }
}

/// `bytes` as a picture's `data:` URL, when they're one.
fn picture(bytes: &[u8]) -> Option<String> {
  let kind = picture_kind(bytes)?;
  Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// The files in `folder` a try saved or changed, newest-looking first by path.
fn changed_files(folder: &Path, before: &Snapshot) -> Vec<ToolTryFile> {
  let mut changed: Vec<(PathBuf, u64)> = snapshot(folder)
    .into_iter()
    .filter(|(path, seen)| before.get(path) != Some(seen))
    .map(|(path, (size, _))| (path, size))
    .collect();
  changed.sort();
  let mut pictures = 0;
  changed
    .into_iter()
    .take(MAX_TRY_FILES)
    .map(|(path, size)| {
      let image = (pictures < MAX_TRY_IMAGES && size <= MAX_TRY_IMAGE_BYTES)
        .then(|| std::fs::read(&path).ok().and_then(|bytes| picture(&bytes)))
        .flatten();
      if image.is_some() {
        pictures += 1;
      }
      let rel = path.strip_prefix(folder).unwrap_or(&path);
      let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
      ToolTryFile { path: rel, size, image }
    })
    .collect()
}

/// What a tool's result has, as a try shows it.
fn contents(result: &Value) -> Vec<ToolTryContent> {
  let clip = |text: &str| crate::commands::chat_tools::truncate(text, MAX_TRY_TEXT);
  let mut out = Vec::new();
  let mut pictures = 0;
  for item in result.get("content").and_then(Value::as_array).into_iter().flatten() {
    match item.get("type").and_then(Value::as_str) {
      Some("text") => out.push(ToolTryContent::Text { text: clip(item.get("text").and_then(Value::as_str).unwrap_or("")) }),
      Some("image") => {
        let data: String = item.get("data").and_then(Value::as_str).unwrap_or("").split_whitespace().collect();
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).ok();
        let url = bytes.filter(|b| b.len() as u64 <= MAX_TRY_IMAGE_BYTES).and_then(|b| picture(&b));
        match url {
          Some(url) if pictures < MAX_TRY_IMAGES => {
            pictures += 1;
            out.push(ToolTryContent::Image { url });
          }
          _ => out.push(ToolTryContent::Text { text: t!("services.toolMaker.pictureLeftOut") }),
        }
      }
      _ => out.push(ToolTryContent::Text { text: clip(&serde_json::to_string_pretty(item).unwrap_or_default()) }),
    }
  }
  if out.is_empty() {
    if let Some(structured) = result.get("structuredContent") {
      out.push(ToolTryContent::Text { text: clip(&serde_json::to_string_pretty(structured).unwrap_or_default()) });
    }
  }
  out
}

/// Calls tool `id`'s tool `name` with `args`, as chat would, with the tool's
/// keys, in its try folder, and says what it returned and saved.
pub async fn try_tool(id: &str, name: &str, args: Value, cancel: &CancelToken) -> Result<ToolTryResult, String> {
  if !args.is_object() {
    return Err(t!("services.toolMaker.badArguments"));
  }
  let entry = made_entry(id)?;
  let env = env_of(&entry)?;
  let folder = try_folder(id)?;
  refresh_kit(id)?;
  let before = snapshot(&folder);
  let started = Instant::now();
  let mut server = Server::start(&server_path(id), &folder, &env).map_err(|f| f.for_user())?;
  let called = match server.tools(Some(cancel)).await {
    Ok(_) => server.call(name, args, TRY_WAIT, cancel).await,
    Err(failed) => Err(failed),
  };
  server.stop().await;
  let result = called.map_err(|f| f.for_user())?;
  Ok(ToolTryResult {
    is_error: result.get("isError").and_then(Value::as_bool).unwrap_or(false),
    content: contents(&result),
    files: changed_files(&folder, &before),
    folder: folder.to_string_lossy().into_owned(),
    ms: started.elapsed().as_millis() as u64,
  })
}

/* --------------------------------- sharing -------------------------------- */

/// A tool as a file to share: everything but its keys' values.
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SharedTool {
  /// The format's version.
  fabricator_tool: u32,
  name: String,
  #[serde(default)]
  summary: String,
  #[serde(default)]
  requests: Vec<String>,
  #[serde(default)]
  keys: Vec<SharedToolKey>,
  #[serde(default)]
  read_only: bool,
  code: String,
}

/// Tool `id` as a file to share: its name, and what it holds.
pub fn export(id: &str) -> Result<(String, String), String> {
  let entry = made_entry(id)?;
  let code = code(id)?.code;
  let made = entry.made.clone().unwrap_or_default();
  let shared = SharedTool {
    fabricator_tool: SHARED_FORMAT,
    name: entry.name.clone(),
    summary: made.summary,
    requests: made.requests,
    keys: entry
      .env
      .iter()
      .map(|name| SharedToolKey { name: name.clone(), provider: entry.provider_keys.get(name).cloned() })
      .collect(),
    read_only: entry.read_only,
    code,
  };
  let text = serde_json::to_string_pretty(&shared).map_err(|e| t!("services.toolMaker.cantSave", error = e))?;
  Ok((format!("{id}.fabricator-tool.json"), text))
}

/// The shared tool in `text`, checked.
fn shared_from(text: &str) -> Result<SharedTool, String> {
  let shared: SharedTool =
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| t!("services.toolMaker.notATool"))?;
  if shared.fabricator_tool > SHARED_FORMAT {
    return Err(t!("services.toolMaker.newerTool"));
  }
  if shared.fabricator_tool == 0 || shared.code.trim().is_empty() || shared.code.len() > MAX_CODE || !imports_kit(&shared.code) {
    return Err(t!("services.toolMaker.notATool"));
  }
  if shared.keys.len() > MAX_KEYS || shared.keys.iter().any(|k| !mcp::is_env_name(k.name.trim())) {
    return Err(t!("services.toolMaker.notATool"));
  }
  Ok(shared)
}

fn read_shared(path: &Path) -> Result<(SharedTool, String), String> {
  let size = std::fs::metadata(path).map_err(|e| t!("services.toolMaker.cantRead", error = e))?.len();
  if size > MAX_SHARED_BYTES {
    return Err(t!("services.toolMaker.notATool"));
  }
  let text = std::fs::read_to_string(path).map_err(|e| t!("services.toolMaker.cantRead", error = e))?;
  // What the user reviewed is what's added: the file can't change in between.
  let digest = hex::encode(Sha256::digest(text.as_bytes()));
  Ok((shared_from(&text)?, digest))
}

/// `name`, or the first of `name 2`, `name 3`… that none of `existing` has.
fn unique_name(name: &str, existing: &[McpServerEntry]) -> String {
  let name = one_line(name, 50);
  let name = if name.is_empty() { t!("services.toolMaker.defaultName") } else { name };
  let taken = |candidate: &str| existing.iter().any(|s| s.name.eq_ignore_ascii_case(candidate));
  if !taken(&name) {
    return name;
  }
  (2..).map(|n| format!("{name} {n}")).find(|candidate| !taken(candidate)).unwrap_or(name)
}

/// The shared tool in the file at `path`, to review before it's added.
pub fn preview(path: &Path) -> Result<ToolImportPreview, String> {
  let (shared, digest) = read_shared(path)?;
  Ok(ToolImportPreview {
    path: path.to_string_lossy().into_owned(),
    digest,
    name: unique_name(&shared.name, &store::mcp_servers()),
    summary: one_line(&shared.summary, MAX_SUMMARY),
    requests: shared.requests.iter().take(MAX_REQUESTS).map(|r| r.trim().to_string()).collect(),
    keys: shared.keys,
    read_only: shared.read_only,
    code: shared.code,
  })
}

/// Adds the shared tool `input` reviewed, once it starts. The file must be as
/// it was when it was reviewed.
pub async fn import(input: &ToolImportInput) -> Result<ToolMadeResult, String> {
  let (shared, digest) = read_shared(Path::new(&input.path))?;
  if digest != input.digest {
    return Err(t!("services.toolMaker.fileChanged"));
  }
  let server = server_input(&input.name, &input.env, input.read_only);
  let mut requests: Vec<String> = shared.requests.iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect();
  let drop = requests.len().saturating_sub(MAX_REQUESTS);
  requests.drain(..drop);
  let made = MadeTool { summary: one_line(&shared.summary, MAX_SUMMARY), requests, updated_at: now(), ..Default::default() };
  let (entry, values) = mcp::made_entry_from(&server, &store::mcp_servers(), &now(), made)?;
  mcp::check_provider_keys(&entry)?;
  let draft = Draft::new()?;
  let script = draft.path.join(SERVER_FILE);
  std::fs::write(&script, &shared.code).map_err(cant_save)?;
  let tools = check(&script, &draft.path).await.map_err(|f| t!("services.toolMaker.didntStart", error = f.for_user()))?;
  install(&entry.id, &shared.code, true)?;
  let servers = mcp::store_entry(entry.clone(), &values).inspect_err(|_| forget(&entry.id))?;
  Ok(ToolMadeResult {
    servers,
    id: entry.id.clone(),
    tools: tools.iter().map(info).collect(),
    message: String::new(),
    missing_keys: Vec::new(),
  })
}
