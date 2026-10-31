//! MCP servers the user adds (an experiment): a command Fabricator runs on this
//! computer, or a remote server's URL, that Build chat can turn on among its
//! plugins, beside Fabric IQ and Work IQ ([`crate::services::iq`]).
//!
//! Servers are personal: they're kept in Fabricator's settings on this
//! computer, never in a project, and the values of their environment variables
//! and headers are kept in the OS credential store ([`secrets`]). A chat's
//! Copilot session gets the servers that are on in its project, named by their
//! ids, so their tools are `<id>-<tool>`. Fabricator decides which tools chat
//! may call ([`Permits`]): any of them, or, for a server the user marks
//! read-only and in every team app, only those the server marks as read-only.
//! Before each message it connects them ([`prepare`]), asking the user to sign
//! in to a server in the browser when it needs that. The runtime keeps the
//! sign-in in memory, for that chat's session.

mod auth;
pub mod connect;
pub mod secrets;

use std::collections::BTreeMap;

use github_copilot_sdk::types::{McpHttpServerConfig, McpServerConfig, McpStdioServerConfig};
use github_copilot_sdk::IndexMap;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub use auth::SessionAuth;
pub use connect::{check, prepare, Prepared, Waits, MEMORY};
pub use secrets::Values;

use crate::services::{keychain, store};
use crate::types::{AppSettings, McpServerEntry, McpServerInput, McpTransport, McpValueInput, StudioProject};

/// What starts a server's plugin id among a project's plugins (`mcp:chart`).
const PLUGIN_PREFIX: &str = "mcp:";
/// The most characters in a server's name.
const MAX_NAME: usize = 60;
/// The most characters in a server's id, which starts each of its tools' names.
const MAX_ID: usize = 20;
/// The most characters in the name of an environment variable or header.
const MAX_VALUE_NAME: usize = 128;

/// Whether the MCP servers experiment is on.
pub fn experiment_on(settings: &AppSettings) -> bool {
  settings.experiments.as_ref().and_then(|f| f.mcp_servers).unwrap_or(false)
}

/// The server a plugin id names (`mcp:<id>`), when it's one the user added.
pub fn server_of_plugin(plugin: &str) -> Option<&str> {
  plugin.strip_prefix(PLUGIN_PREFIX).filter(|id| !id.is_empty())
}

/// Ids that Fabric IQ, Work IQ or Fabricator's own tools go by.
fn reserved(id: &str) -> bool {
  let id = id.to_ascii_lowercase();
  id == "fabriciq" || id == "workiq" || id.starts_with("fabricator")
}

/// `text`, cut to `max` characters, without a hyphen at the end.
fn cut(text: &str, max: usize) -> String {
  text.chars().take(max).collect::<String>().trim_end_matches('-').to_string()
}

/// A new server's id, from its name (`Microsoft Learn` → `microsoft-learn`):
/// lowercase letters, digits and hyphens, starting with a letter, and unlike
/// any id in `taken`.
pub fn new_id(name: &str, taken: &[&str]) -> String {
  let mut slug = String::new();
  for c in name.chars() {
    if c.is_ascii_alphanumeric() {
      slug.push(c.to_ascii_lowercase());
    } else if !slug.is_empty() && !slug.ends_with('-') {
      slug.push('-');
    }
  }
  let mut base = cut(&slug, MAX_ID);
  if !base.starts_with(|c: char| c.is_ascii_lowercase()) || reserved(&base) {
    base = cut(&format!("mcp-{base}"), MAX_ID);
  }
  let free = |id: &str| !taken.iter().any(|t| t.eq_ignore_ascii_case(id));
  if free(&base) {
    return base;
  }
  (2..)
    .map(|n| {
      let suffix = format!("-{n}");
      format!("{}{suffix}", cut(&base, MAX_ID - suffix.len()))
    })
    .find(|id| free(id))
    .unwrap_or(base)
}

fn is_env_name(name: &str) -> bool {
  name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// An HTTP header name: a token (RFC 9110).
fn is_header_name(name: &str) -> bool {
  !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
}

fn has_line_break(text: &str) -> bool {
  text.contains(['\0', '\r', '\n'])
}

/// The names and values of a server's environment variables or headers being
/// saved: each with its new value, or the one `saved` under its name.
fn values_for(
  inputs: &[McpValueInput],
  saved: &BTreeMap<String, String>,
  valid: fn(&str) -> bool,
  what: &str,
) -> Result<(Vec<String>, BTreeMap<String, String>), String> {
  let mut names: Vec<String> = Vec::new();
  let mut values = BTreeMap::new();
  for input in inputs {
    let name = input.name.trim();
    if name.is_empty() {
      // An empty row is left out.
      if input.value.as_deref().unwrap_or_default().is_empty() {
        continue;
      }
      return Err(format!("Give each {what} a name."));
    }
    if name.chars().count() > MAX_VALUE_NAME || !valid(name) {
      return Err(format!("{name} can't be the name of {}.", with_article(what)));
    }
    if names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
      return Err(format!("{name} is there twice."));
    }
    let value = match &input.value {
      Some(value) if value.is_empty() => return Err(format!("Enter a value for {name}.")),
      Some(value) => value.clone(),
      None => saved.get(name).cloned().ok_or_else(|| format!("Enter a value for {name}."))?,
    };
    if has_line_break(&value) {
      return Err(format!("The value of {name} can't contain line breaks."));
    }
    names.push(name.to_string());
    values.insert(name.to_string(), value);
  }
  Ok((names, values))
}

fn with_article(what: &str) -> String {
  if what.starts_with(['a', 'e', 'i', 'o', 'u']) {
    format!("an {what}")
  } else {
    format!("a {what}")
  }
}

/// Whether `host` (as a URL gives it) is this computer.
fn is_loopback(host: &str) -> bool {
  let host = host.trim_start_matches('[').trim_end_matches(']');
  host.eq_ignore_ascii_case("localhost")
    || host.to_ascii_lowercase().ends_with(".localhost")
    || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// A remote server's URL, checked: an http(s) address with a host, over https
/// unless the server is on this computer, since its headers can carry keys.
fn check_url(raw: &str) -> Result<String, String> {
  let raw = raw.trim();
  if raw.is_empty() {
    return Err("Enter the server's URL.".into());
  }
  let url = reqwest::Url::parse(raw)
    .map_err(|_| format!("{raw} isn't a web address. Enter the server's URL, such as https://example.com/mcp."))?;
  let host = url.host_str().unwrap_or_default();
  match url.scheme() {
    "https" if !host.is_empty() => Ok(raw.to_string()),
    "http" if is_loopback(host) => Ok(raw.to_string()),
    "http" if !host.is_empty() => Err("Use an https:// URL. Only a server on this computer can use http://.".into()),
    _ => Err("Enter an https:// URL, such as https://example.com/mcp.".into()),
  }
}

/// Checks `input` and turns it into the server to save, with its values: each
/// environment variable or header with its new value, or the one in `saved`
/// (the values of the server being changed). `existing` are the user's servers.
pub fn entry_from(
  input: &McpServerInput,
  existing: &[McpServerEntry],
  saved: &Values,
  now: &str,
) -> Result<(McpServerEntry, Values), String> {
  let name = input.name.split_whitespace().collect::<Vec<_>>().join(" ");
  if name.is_empty() {
    return Err("Give the server a name.".into());
  }
  if name.chars().count() > MAX_NAME {
    return Err(format!("Use a name of up to {MAX_NAME} characters."));
  }
  let previous = match &input.id {
    Some(id) => Some(existing.iter().find(|s| &s.id == id).ok_or("That server isn't in Fabricator anymore.")?),
    None => None,
  };
  if existing.iter().any(|s| Some(&s.id) != input.id.as_ref() && s.name.eq_ignore_ascii_case(&name)) {
    return Err(format!("You already have a server named {name}. Choose another name."));
  }
  let id = match previous {
    Some(server) => server.id.clone(),
    None => new_id(&name, &existing.iter().map(|s| s.id.as_str()).collect::<Vec<_>>()),
  };
  let mut entry = McpServerEntry {
    id,
    name,
    transport: input.transport,
    read_only: input.read_only,
    added_at: previous.map_or_else(|| now.to_string(), |s| s.added_at.clone()),
    ..Default::default()
  };
  let mut values = Values::default();
  match input.transport {
    McpTransport::Stdio => {
      let command = input.command.trim();
      if command.is_empty() {
        return Err("Enter the command that starts the server, such as npx.".into());
      }
      if has_line_break(command) || input.args.iter().any(|a| has_line_break(a)) {
        return Err("The command can't contain line breaks.".into());
      }
      entry.command = command.to_string();
      entry.args = input.args.clone();
      (entry.env, values.env) = values_for(&input.env, &saved.env, is_env_name, "environment variable")?;
    }
    McpTransport::Http | McpTransport::Sse => {
      entry.url = check_url(&input.url)?;
      (entry.headers, values.headers) = values_for(&input.headers, &saved.headers, is_header_name, "header")?;
    }
  }
  Ok((entry, values))
}

/// Saves the server `input` describes, with its values in the credential
/// store, and returns the user's servers. The next message tries it from scratch.
pub fn save(input: &McpServerInput) -> Result<Vec<McpServerEntry>, String> {
  let existing = store::mcp_servers();
  // Values that can't be read are entered again: the form asks for each missing one.
  let saved = input.id.as_deref().map(|id| secrets::load(id).unwrap_or_default()).unwrap_or_default();
  let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
  let (entry, values) = entry_from(input, &existing, &saved, &now)?;
  if !values.is_empty() && !keychain::supported() {
    return Err("Fabricator can't keep the values of environment variables or headers safely on this operating system yet.".into());
  }
  secrets::save(&entry.id, &values)?;
  let id = entry.id.clone();
  let servers = store::upsert_mcp_server(entry);
  MEMORY.reset_server(&id);
  Ok(servers)
}

/// Forgets server `id`, its values and its place in every chat, and returns
/// the servers left.
pub fn remove(id: &str) -> Result<Vec<McpServerEntry>, String> {
  secrets::forget(id)?;
  let servers = store::remove_mcp_server(id);
  MEMORY.reset_server(id);
  Ok(servers)
}

/// A server that's on in a chat, with its values.
#[derive(Clone, Debug)]
struct OnServer {
  entry: McpServerEntry,
  values: Values,
}

/// The servers the user added that are on in a Build chat, and how chat may use them.
#[derive(Clone, Debug, Default)]
pub struct McpServers {
  /// The app whose chat it is (empty for a check).
  project: String,
  on: Vec<OnServer>,
  /// Servers that are on but can't be given to the session, by name, and why.
  missing: Vec<(String, String)>,
  /// A team app's chat, which may call only tools that only read.
  team: bool,
  /// Where command servers start: the project's folder.
  cwd: Option<String>,
}

/// The part of a server its session gets, for [`McpServers::revision`].
#[derive(Serialize)]
struct Fingerprint<'a> {
  id: &'a str,
  transport: McpTransport,
  command: &'a str,
  args: &'a [String],
  url: &'a str,
  values: &'a Values,
  read_only: bool,
}

impl McpServers {
  /// The servers on in `project`'s chat, while the experiment is on, with the
  /// values saved for them.
  pub fn for_project(project: &StudioProject, settings: &AppSettings) -> Self {
    Self::for_project_with(project, settings, secrets::load)
  }

  fn for_project_with(
    project: &StudioProject,
    settings: &AppSettings,
    load: impl Fn(&str) -> Result<Values, String>,
  ) -> Self {
    let mut servers = McpServers {
      project: project.id.clone(),
      team: project.team.is_some(),
      cwd: Some(project.path.clone()),
      ..Default::default()
    };
    if !experiment_on(settings) {
      return servers;
    }
    for id in project.plugins.iter().filter_map(|p| server_of_plugin(p)) {
      let Some(entry) = settings.mcp_servers.iter().find(|s| s.id == id) else {
        continue;
      };
      if servers.on.iter().any(|s| s.entry.id == id) {
        continue;
      }
      let values = if entry.env.is_empty() && entry.headers.is_empty() { Ok(Values::default()) } else { load(id) };
      match values {
        Ok(values) => servers.on.push(OnServer { entry: entry.clone(), values }),
        Err(why) => servers.missing.push((entry.name.clone(), why.trim_end_matches('.').to_string())),
      }
    }
    servers
  }

  /// Just `entry`, to check it on its own, starting in `cwd`.
  pub fn only(entry: McpServerEntry, values: Values, cwd: Option<String>) -> Self {
    McpServers { on: vec![OnServer { entry, values }], cwd, ..Default::default() }
  }

  pub fn is_empty(&self) -> bool {
    self.on.is_empty() && self.missing.is_empty()
  }

  /// Chat may call only `server`'s tools that only read.
  fn read_only(&self, server: &McpServerEntry) -> bool {
    server.read_only || self.team
  }

  /// Each server's configuration for a session, by id.
  pub fn servers(&self) -> IndexMap<String, McpServerConfig> {
    self.on.iter().map(|s| (s.entry.id.clone(), config(&s.entry, &s.values, self.cwd.as_deref()))).collect()
  }

  /// Each server's id and the name the user gave it.
  pub fn names(&self) -> Vec<(String, String)> {
    self.on.iter().map(|s| (s.entry.id.clone(), s.entry.name.clone())).collect()
  }

  /// Which of their tools chat may call.
  pub fn permits(&self) -> Permits {
    Permits {
      servers: self.on.iter().map(|s| (s.entry.id.clone(), self.read_only(&s.entry))).collect(),
      team: self.team,
    }
  }

  /// A fingerprint of what a session gets from these servers, so a session
  /// opened with other servers, settings or values is opened again. Empty
  /// without any.
  pub fn revision(&self) -> String {
    if self.on.is_empty() {
      return String::new();
    }
    let servers: Vec<Fingerprint> = self
      .on
      .iter()
      .map(|s| Fingerprint {
        id: &s.entry.id,
        transport: s.entry.transport,
        command: &s.entry.command,
        args: &s.entry.args,
        url: &s.entry.url,
        values: &s.values,
        read_only: self.read_only(&s.entry),
      })
      .collect();
    let json = serde_json::to_vec(&(servers, &self.cwd)).unwrap_or_default();
    hex::encode(Sha256::digest(json))
  }
}

/// A server's configuration for a session: its command and environment, or its
/// URL and headers, with the values saved for them.
fn config(entry: &McpServerEntry, values: &Values, cwd: Option<&str>) -> McpServerConfig {
  match entry.transport {
    McpTransport::Stdio => McpServerConfig::Stdio(McpStdioServerConfig {
      command: entry.command.clone(),
      args: entry.args.clone(),
      env: entry.env.iter().filter_map(|n| values.env.get(n).map(|v| (n.clone(), v.clone()))).collect(),
      working_directory: cwd.map(str::to_string),
      ..Default::default()
    }),
    McpTransport::Http | McpTransport::Sse => {
      let server = McpHttpServerConfig {
        url: entry.url.clone(),
        headers: entry.headers.iter().filter_map(|n| values.headers.get(n).map(|v| (n.clone(), v.clone()))).collect(),
        ..Default::default()
      };
      if entry.transport == McpTransport::Sse {
        McpServerConfig::Sse(server)
      } else {
        McpServerConfig::Http(server)
      }
    }
  }
}

/// Which tools of the user's servers a chat may call.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Permits {
  /// Each server that's on, and whether chat may call only its read-only tools.
  servers: Vec<(String, bool)>,
  /// A team app's chat, which may call only tools that only read.
  pub team: bool,
}

impl Permits {
  /// Whether chat may call a tool of MCP server `server`, which the server
  /// marks as read-only or not, or `None` when the user didn't add the server.
  pub fn permits(&self, server: &str, read_only_tool: bool) -> Option<bool> {
    let (_, read_only) = self.servers.iter().find(|(id, _)| id == server)?;
    Some(read_only_tool || !read_only)
  }
}

#[cfg(test)]
mod tests;
