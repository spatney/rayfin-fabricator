//! One managed Vite frontend for the active Fabricator project.
//!
//! Fabricator owns the process instead of shelling through `npm run dev`, which
//! keeps the selected port deterministic, prevents duplicate servers, and lets
//! the app stop the child on project removal or application exit. Data Apps
//! (detected by their `@microsoft/fabric-app-data` dependency) are surfaced
//! through Fabric's secureItemEmbed dev-mode route so the local page retains the
//! governed Fabric data proxy.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::Value as JsonValue;
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;

use crate::commands::{auth, deploy};
use crate::services::exec::{self, RunOptions, RunResult};
use crate::services::store;
use crate::types::{DevServerStatus, FabricDeployment, StudioProject};

const FIRST_DEV_PORT: u16 = 5173;
const LAST_PREFERRED_DEV_PORT: u16 = 5199;
const START_TIMEOUT: Duration = Duration::from_secs(45);
const CONFIG_APPLY_TIMEOUT_MS: u64 = 10 * 60_000;
const COMMAND_CAPTURE_BYTES: usize = 256 * 1024;
const MAX_LOG_LINES: usize = 200;
const MAX_LOG_LINE_CHARS: usize = 1_000;
const RETURNED_LOG_LINES: usize = 12;

static ENSURE_LOCK: Lazy<AsyncMutex<()>> = Lazy::new(|| AsyncMutex::new(()));
static SERVER: Lazy<StdMutex<Option<ManagedServer>>> = Lazy::new(|| StdMutex::new(None));
static LIFECYCLE_GENERATIONS: Lazy<StdMutex<HashMap<String, u64>>> =
  Lazy::new(|| StdMutex::new(HashMap::new()));
static APPLIED_REDIRECTS: Lazy<StdMutex<HashSet<(String, String, String)>>> =
  Lazy::new(|| StdMutex::new(HashSet::new()));

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DevPreviewTarget {
  pub dev_uri: String,
  pub surface_url: String,
  pub data_proxy: bool,
}

struct ManagedServer {
  project_id: String,
  instance_id: String,
  data_proxy: bool,
  dev_uri: String,
  target: Option<DevPreviewTarget>,
  child: Child,
  logs: Arc<StdMutex<VecDeque<String>>>,
}

fn status(
  ok: bool,
  state: &str,
  data_proxy: bool,
  target: Option<&DevPreviewTarget>,
  dev_uri: Option<String>,
  error: Option<String>,
  logs: Vec<String>,
) -> DevServerStatus {
  DevServerStatus {
    ok,
    status: state.to_string(),
    data_proxy,
    url: target.map(|value| value.surface_url.clone()),
    dev_uri: target.map(|value| value.dev_uri.clone()).or(dev_uri),
    instance_id: None,
    error,
    logs,
  }
}

fn stopped_status(data_proxy: bool) -> DevServerStatus {
  status(false, "stopped", data_proxy, None, None, None, vec![])
}

fn error_status(data_proxy: bool, error: impl Into<String>, logs: Vec<String>) -> DevServerStatus {
  status(
    false,
    "error",
    data_proxy,
    None,
    None,
    Some(error.into()),
    logs,
  )
}

fn requires_deploy_status(data_proxy: bool) -> DevServerStatus {
  status(
    false,
    "requires-deploy",
    data_proxy,
    None,
    None,
    Some("Deploy this project to Fabric before starting its local preview.".into()),
    vec![],
  )
}

fn truncate_line(line: &str) -> String {
  if line.chars().count() <= MAX_LOG_LINE_CHARS {
    return line.to_string();
  }
  let mut value = line.chars().take(MAX_LOG_LINE_CHARS).collect::<String>();
  value.push_str(" ... truncated");
  value
}

fn push_log(logs: &Arc<StdMutex<VecDeque<String>>>, stream: &str, line: &str) {
  let mut logs = logs.lock().unwrap();
  logs.push_back(format!("[{stream}] {}", truncate_line(line)));
  while logs.len() > MAX_LOG_LINES {
    logs.pop_front();
  }
}

async fn pump<R>(reader: R, stream: &'static str, logs: Arc<StdMutex<VecDeque<String>>>)
where
  R: AsyncRead + Unpin,
{
  let mut reader = reader;
  let mut chunk = [0u8; 4_096];
  loop {
    let count = match reader.read(&mut chunk).await {
      Ok(0) | Err(_) => break,
      Ok(count) => count,
    };
    // Split fixed-size chunks rather than waiting for an unbounded newline.
    for line in String::from_utf8_lossy(&chunk[..count]).split('\n') {
      let line = line.trim_end_matches('\r');
      if !line.is_empty() {
        push_log(&logs, stream, line);
      }
    }
  }
}

fn tail_logs(logs: &Arc<StdMutex<VecDeque<String>>>) -> Vec<String> {
  let logs = logs.lock().unwrap();
  logs
    .iter()
    .skip(logs.len().saturating_sub(RETURNED_LOG_LINES))
    .cloned()
    .collect()
}

fn result_error(result: &RunResult, fallback: &str) -> String {
  let combined = format!("{}\n{}", result.stderr.trim(), result.stdout.trim());
  let mut lines = combined
    .lines()
    .map(str::trim)
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>();
  if lines.len() > 20 {
    lines.drain(..lines.len() - 20);
  }
  let detail = lines.join("\n");
  if detail.is_empty() {
    fallback.to_string()
  } else {
    detail.chars().take(12_000).collect()
  }
}

fn package_json(project_dir: &Path) -> Option<JsonValue> {
  let raw = std::fs::read_to_string(project_dir.join("package.json")).ok()?;
  serde_json::from_str(&raw).ok()
}

/// Package presence, rather than Fabricator template identity, is the source of
/// truth because opened/community projects can use the same proxy integration.
pub(crate) fn project_uses_fabric_data(project_dir: &Path) -> bool {
  let Some(package) = package_json(project_dir) else {
    return false;
  };
  ["dependencies", "devDependencies"].iter().any(|section| {
    package
      .get(section)
      .and_then(JsonValue::as_object)
      .is_some_and(|values| values.contains_key("@microsoft/fabric-app-data"))
  })
}

fn vite_entry(project_dir: &Path) -> Option<PathBuf> {
  let entry = project_dir
    .join("node_modules")
    .join("vite")
    .join("bin")
    .join("vite.js");
  entry.is_file().then_some(entry)
}

fn port_available(port: u16) -> bool {
  TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn choose_port() -> Result<u16, String> {
  if let Some(port) = (FIRST_DEV_PORT..=LAST_PREFERRED_DEV_PORT).find(|port| port_available(*port)) {
    return Ok(port);
  }
  let listener =
    TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("Could not reserve a local preview port: {error}"))?;
  listener
    .local_addr()
    .map(|address| address.port())
    .map_err(|error| format!("Could not inspect the local preview port: {error}"))
}

fn stop_server(server: &mut ManagedServer) {
  let _ = server.child.start_kill();
}

fn lifecycle_generation(project_id: &str) -> u64 {
  *LIFECYCLE_GENERATIONS
    .lock()
    .unwrap()
    .entry(project_id.to_string())
    .or_default()
}

fn invalidate_project(project_id: &str) {
  let mut generations = LIFECYCLE_GENERATIONS.lock().unwrap();
  let generation = generations.entry(project_id.to_string()).or_default();
  *generation = generation.wrapping_add(1);
}

fn lifecycle_is_current(project_id: &str, generation: u64) -> bool {
  LIFECYCLE_GENERATIONS
    .lock()
    .unwrap()
    .get(project_id)
    .copied()
    .unwrap_or_default()
    == generation
}

fn startup_is_current(project_id: &str, generation: u64) -> bool {
  lifecycle_is_current(project_id, generation)
    && store::active_project().is_some_and(|project| project.id == project_id)
}

fn take_server(project_id: Option<&str>) -> Option<ManagedServer> {
  let mut guard = SERVER.lock().unwrap();
  if project_id.is_some_and(|id| {
    guard
      .as_ref()
      .is_some_and(|server| server.project_id.as_str() != id)
  }) {
    return None;
  }
  guard.take()
}

pub(crate) fn stop_project(project_id: &str) -> bool {
  // Invalidate even when the process has not been registered yet. An in-flight
  // deployment lookup or predev step must not start a server after removal.
  invalidate_project(project_id);
  stop_project_server(project_id)
}

fn stop_project_server(project_id: &str) -> bool {
  let Some(mut server) = take_server(Some(project_id)) else {
    return false;
  };
  stop_server(&mut server);
  true
}

pub(crate) fn stop_all() {
  for generation in LIFECYCLE_GENERATIONS.lock().unwrap().values_mut() {
    *generation = generation.wrapping_add(1);
  }
  stop_managed_server();
}

fn stop_managed_server() {
  if let Some(mut server) = take_server(None) {
    stop_server(&mut server);
  }
}

fn current_status(project_id: &str, data_proxy: bool) -> Option<DevServerStatus> {
  let mut guard = SERVER.lock().unwrap();
  let server = guard.as_mut()?;
  if server.project_id != project_id {
    return None;
  }
  if server.data_proxy != data_proxy {
    let mut stale = status(
      false,
      "stale",
      data_proxy,
      None,
      Some(server.dev_uri.clone()),
      None,
      vec![],
    );
    stale.instance_id = Some(server.instance_id.clone());
    return Some(stale);
  }
  let mut current = match server.child.try_wait() {
    Ok(None) => match server.target.as_ref() {
      Some(target) => Some(status(
        true,
        "ready",
        server.data_proxy,
        Some(target),
        None,
        None,
        vec![],
      )),
      None => Some(status(
        false,
        "starting",
        server.data_proxy,
        None,
        Some(server.dev_uri.clone()),
        None,
        vec![],
      )),
    },
    Ok(Some(exit)) => Some(error_status(
      server.data_proxy,
      format!(
        "The local frontend server exited{}.",
        exit.code().map(|code| format!(" with code {code}")).unwrap_or_default()
      ),
      tail_logs(&server.logs),
    )),
    Err(error) => Some(error_status(
      data_proxy,
      format!("Could not inspect the local frontend server: {error}"),
      tail_logs(&server.logs),
    )),
  };
  if let Some(status) = current.as_mut() {
    status.instance_id = Some(server.instance_id.clone());
  }
  current
}

pub(crate) fn active_preview_target(project_id: &str) -> Option<DevPreviewTarget> {
  let mut guard = SERVER.lock().unwrap();
  let server = guard.as_mut()?;
  if server.project_id != project_id || server.child.try_wait().ok().flatten().is_some() {
    return None;
  }
  server.target.clone()
}

fn spawn_vite(
  project: &StudioProject,
  data_proxy: bool,
  port: u16,
) -> Result<(Arc<StdMutex<VecDeque<String>>>, String), String> {
  let project_dir = Path::new(&project.path);
  let vite = vite_entry(project_dir)
    .ok_or_else(|| "Vite is not installed in this project. Run npm install and try again.".to_string())?;
  let node = which::which("node")
    .map_err(|_| "Node.js was not found on PATH. Install Node.js and try again.".to_string())?;
  let dev_uri = format!("http://localhost:{port}");
  let instance_id = uuid::Uuid::new_v4().to_string();
  let logs = Arc::new(StdMutex::new(VecDeque::new()));

  let mut command = Command::new(node);
  command
    .arg(vite)
    .arg("--host")
    .arg("127.0.0.1")
    .arg("--port")
    .arg(port.to_string())
    .arg("--strictPort")
    .current_dir(project_dir)
    .env("NO_COLOR", "1")
    .env("FORCE_COLOR", "0")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
  #[cfg(windows)]
  {
    command.creation_flags(0x0800_0000);
  }

  let mut child = command
    .spawn()
    .map_err(|error| format!("Could not start the local frontend server: {error}"))?;
  if let Some(stdout) = child.stdout.take() {
    tokio::spawn(pump(stdout, "stdout", logs.clone()));
  }
  if let Some(stderr) = child.stderr.take() {
    tokio::spawn(pump(stderr, "stderr", logs.clone()));
  }

  let mut guard = SERVER.lock().unwrap();
  *guard = Some(ManagedServer {
    project_id: project.id.clone(),
    instance_id: instance_id.clone(),
    data_proxy,
    dev_uri,
    target: None,
    child,
    logs: logs.clone(),
  });
  Ok((logs, instance_id))
}

async fn wait_until_ready(
  project_id: &str,
  generation: u64,
  dev_uri: &str,
  logs: &Arc<StdMutex<VecDeque<String>>>,
) -> Result<(), String> {
  let client = reqwest::Client::builder()
    .no_proxy()
    .timeout(Duration::from_secs(2))
    .build()
    .map_err(|error| format!("Could not create the local preview health probe: {error}"))?;
  let deadline = Instant::now() + START_TIMEOUT;
  loop {
    if !startup_is_current(project_id, generation) {
      return Err("Local frontend startup was cancelled.".into());
    }
    {
      let mut guard = SERVER.lock().unwrap();
      let Some(server) = guard.as_mut().filter(|server| server.project_id == project_id) else {
        return Err("The local frontend server was stopped before it became ready.".into());
      };
      match server.child.try_wait() {
        Ok(None) => {}
        Ok(Some(exit)) => {
          let suffix = exit
            .code()
            .map(|code| format!(" with code {code}"))
            .unwrap_or_default();
          return Err(format!("The local frontend server exited{suffix}."));
        }
        Err(error) => return Err(format!("Could not inspect the local frontend server: {error}")),
      }
    }
    if client.get(dev_uri).send().await.is_ok() {
      return Ok(());
    }
    if Instant::now() >= deadline {
      let detail = tail_logs(logs);
      let suffix = if detail.is_empty() {
        String::new()
      } else {
        format!("\n\n{}", detail.join("\n"))
      };
      return Err(format!(
        "The local frontend server did not become ready within {} seconds.{suffix}",
        START_TIMEOUT.as_secs()
      ));
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
  }
}

fn leading_spaces(line: &str) -> usize {
  line.chars().take_while(|character| *character == ' ').count()
}

fn yaml_key(line: &str, key: &str) -> bool {
  line.trim() == format!("{key}:")
}

fn section_end(lines: &[String], start: usize, indent: usize) -> usize {
  lines
    .iter()
    .enumerate()
    .skip(start + 1)
    .find(|(_, line)| {
      let trimmed = line.trim();
      !trimmed.is_empty() && !trimmed.starts_with('#') && leading_spaces(line) <= indent
    })
    .map(|(index, _)| index)
    .unwrap_or(lines.len())
}

/// Append without reserializing YAML so comments and the project's formatting are
/// preserved. Existing redirect origins are intentionally retained.
fn with_allowed_redirect(raw: &str, dev_uri: &str) -> Result<Option<String>, String> {
  let document: serde_yaml::Value =
    serde_yaml::from_str(raw).map_err(|error| format!("rayfin.yml is invalid: {error}"))?;
  let configured = document
    .get("services")
    .and_then(|value| value.get("auth"))
    .and_then(|value| value.get("allowedRedirectUris"));
  let existing = match configured {
    Some(value) => Some(
      value
        .as_sequence()
        .ok_or_else(|| "services.auth.allowedRedirectUris must be a YAML list.".to_string())?
        .iter()
        .map(|entry| {
          entry
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "Every allowedRedirectUris entry must be a string.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?,
    ),
    None => None,
  };
  if existing
    .as_ref()
    .is_some_and(|values| values.iter().any(|value| value == dev_uri))
  {
    return Ok(None);
  }

  let newline = if raw.contains("\r\n") { "\r\n" } else { "\n" };
  let trailing_newline = raw.ends_with('\n');
  let mut lines = raw.lines().map(str::to_string).collect::<Vec<_>>();
  let services = lines
    .iter()
    .position(|line| yaml_key(line, "services"))
    .ok_or_else(|| "rayfin.yml has no services section.".to_string())?;
  let services_indent = leading_spaces(&lines[services]);
  let services_end = section_end(&lines, services, services_indent);
  let auth = (services + 1..services_end)
    .find(|index| yaml_key(&lines[*index], "auth"))
    .ok_or_else(|| "rayfin.yml has no services.auth section.".to_string())?;
  let auth_indent = leading_spaces(&lines[auth]);
  let auth_end = section_end(&lines, auth, auth_indent);
  let indent_step = auth_indent.saturating_sub(services_indent).max(2);

  if let Some(redirects) =
    (auth + 1..auth_end).find(|index| yaml_key(&lines[*index], "allowedRedirectUris"))
  {
    let redirects_indent = leading_spaces(&lines[redirects]);
    let redirects_end = section_end(&lines, redirects, redirects_indent);
    let item_indent = (redirects + 1..redirects_end)
      .find_map(|index| {
        let line = &lines[index];
        line.trim_start()
          .starts_with("- ")
          .then(|| leading_spaces(line))
      })
      .unwrap_or(redirects_indent + indent_step);
    lines.insert(redirects_end, format!("{}- {dev_uri}", " ".repeat(item_indent)));
  } else if let Some(redirects) = (auth + 1..auth_end).find(|index| {
    lines[*index]
      .trim_start()
      .starts_with("allowedRedirectUris:")
  }) {
    // Normalize a valid flow-style list (`allowedRedirectUris: [a, b]`) to a
    // block list so the new origin can be appended without reserializing the
    // rest of the user's configuration.
    let redirects_indent = leading_spaces(&lines[redirects]);
    let item_indent = redirects_indent + indent_step;
    lines[redirects] = format!("{}allowedRedirectUris:", " ".repeat(redirects_indent));
    let mut insert_at = redirects + 1;
    for value in existing.unwrap_or_default() {
      lines.insert(insert_at, format!("{}- {value}", " ".repeat(item_indent)));
      insert_at += 1;
    }
    lines.insert(insert_at, format!("{}- {dev_uri}", " ".repeat(item_indent)));
  } else {
    let key_indent = auth_indent + indent_step;
    lines.insert(auth_end, format!("{}allowedRedirectUris:", " ".repeat(key_indent)));
    lines.insert(
      auth_end + 1,
      format!("{}- {dev_uri}", " ".repeat(key_indent + indent_step)),
    );
  }

  let mut updated = lines.join(newline);
  if trailing_newline {
    updated.push_str(newline);
  }
  Ok(Some(updated))
}

fn ensure_allowed_redirect(project_dir: &Path, dev_uri: &str) -> Result<bool, String> {
  let config = project_dir.join("rayfin").join("rayfin.yml");
  let raw = std::fs::read_to_string(&config)
    .map_err(|error| format!("Could not read {}: {error}", config.display()))?;
  let Some(updated) = with_allowed_redirect(&raw, dev_uri)? else {
    return Ok(false);
  };
  std::fs::write(&config, updated)
    .map_err(|error| format!("Could not update {}: {error}", config.display()))?;
  Ok(true)
}

fn without_allowed_redirect(raw: &str, dev_uri: &str) -> Result<Option<String>, String> {
  let newline = if raw.contains("\r\n") { "\r\n" } else { "\n" };
  let trailing_newline = raw.ends_with('\n');
  let mut lines = raw.lines().map(str::to_string).collect::<Vec<_>>();
  let services = lines
    .iter()
    .position(|line| yaml_key(line, "services"))
    .ok_or_else(|| "rayfin.yml has no services section.".to_string())?;
  let services_indent = leading_spaces(&lines[services]);
  let services_end = section_end(&lines, services, services_indent);
  let auth = (services + 1..services_end)
    .find(|index| yaml_key(&lines[*index], "auth"))
    .ok_or_else(|| "rayfin.yml has no services.auth section.".to_string())?;
  let auth_indent = leading_spaces(&lines[auth]);
  let auth_end = section_end(&lines, auth, auth_indent);
  let Some(redirects) =
    (auth + 1..auth_end).find(|index| yaml_key(&lines[*index], "allowedRedirectUris"))
  else {
    return Ok(None);
  };
  let redirects_indent = leading_spaces(&lines[redirects]);
  let redirects_end = section_end(&lines, redirects, redirects_indent);
  let expected = format!("- {dev_uri}");
  let Some(index) =
    (redirects + 1..redirects_end).find(|index| lines[*index].trim() == expected)
  else {
    return Ok(None);
  };
  let has_other_items = (redirects + 1..redirects_end)
    .any(|candidate| candidate != index && lines[candidate].trim_start().starts_with("- "));
  lines.remove(index);
  if !has_other_items {
    lines.remove(redirects);
  }
  let mut updated = lines.join(newline);
  if trailing_newline {
    updated.push_str(newline);
  }
  Ok(Some(updated))
}

fn rollback_allowed_redirect(project_dir: &Path, dev_uri: &str) -> Result<(), String> {
  let config = project_dir.join("rayfin").join("rayfin.yml");
  let raw = std::fs::read_to_string(&config)
    .map_err(|error| format!("Could not read {} while rolling back: {error}", config.display()))?;
  let Some(updated) = without_allowed_redirect(&raw, dev_uri)? else {
    return Ok(());
  };
  std::fs::write(&config, updated)
    .map_err(|error| format!("Could not roll back {}: {error}", config.display()))
}

async fn prepare_frontend(
  project_dir: &Path,
  project_id: &str,
  generation: u64,
) -> Result<(), String> {
  // Honor project-specific codegen/environment setup without invoking the `dev`
  // script itself (Fabricator must own Vite's port and process lifecycle).
  let _deploy_guard = deploy::acquire_deploy_lock().await;
  if !startup_is_current(project_id, generation) {
    return Err("Local frontend startup was cancelled.".into());
  }
  let result = exec::run(
    "npm",
    &["run", "predev", "--if-present"],
    RunOptions {
      cwd: Some(project_dir.to_path_buf()),
      timeout_ms: Some(120_000),
      max_capture_bytes: Some(COMMAND_CAPTURE_BYTES),
      ..Default::default()
    },
  )
  .await;
  if result.ok {
    Ok(())
  } else {
    Err(result_error(
      &result,
      "The project's predev preparation failed.",
    ))
  }
}

async fn active_deployment(
  project: &StudioProject,
  generation: u64,
) -> Result<Option<FabricDeployment>, String> {
  let _deploy_guard = deploy::acquire_deploy_lock().await;
  if !startup_is_current(&project.id, generation) {
    return Err("Local frontend startup was cancelled.".into());
  }
  deploy::active_deployment(project).await
}

async fn apply_redirect_configuration(project_dir: &Path) -> Result<(), String> {
  // Local preview never needs to republish the static bundle. This applies auth
  // and other service configuration while leaving hosted assets untouched. The
  // caller holds the deployment lock across the config edit and this command.
  let result = exec::run_project_rayfin(
    project_dir,
    &["up", "-y", "--exclude-services", "staticHosting"],
    RunOptions {
      timeout_ms: Some(CONFIG_APPLY_TIMEOUT_MS),
      max_capture_bytes: Some(COMMAND_CAPTURE_BYTES),
      ..Default::default()
    },
  )
  .await;
  if result.ok {
    Ok(())
  } else {
    Err(result_error(
      &result,
      "Rayfin could not apply the local preview redirect origin.",
    ))
  }
}

fn encode_component(value: &str) -> String {
  let mut encoded = String::with_capacity(value.len());
  for byte in value.bytes() {
    let unescaped = byte.is_ascii_alphanumeric()
      || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
    if unescaped {
      encoded.push(byte as char);
    } else {
      encoded.push_str(&format!("%{byte:02X}"));
    }
  }
  encoded
}

fn secure_embed_url(
  deployment: &FabricDeployment,
  dev_uri: &str,
  tenant_id: Option<&str>,
) -> Result<String, String> {
  let item_id = deployment
    .item_id
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .ok_or_else(|| "The active Rayfin deployment has no Fabric item id.".to_string())?;
  let workspace_id = deployment
    .workspace_id
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .ok_or_else(|| "The active Rayfin deployment has no Fabric workspace id.".to_string())?;
  let mut base = format!(
    "https://app.fabric.microsoft.com/secureItemEmbed?itemId={}&workspaceId={}&itemType=appBackend",
    encode_component(item_id),
    encode_component(workspace_id)
  );
  if let Some(tenant) = tenant_id.map(str::trim).filter(|value| !value.is_empty()) {
    base.push_str("&ctid=");
    base.push_str(&encode_component(tenant));
  }
  let extension_path = format!("?devUri={}", encode_component(dev_uri));
  base.push_str("&extensionPath=");
  base.push_str(&encode_component(&extension_path));
  Ok(base)
}

fn deployment_identity(deployment: &FabricDeployment) -> String {
  format!(
    "{}:{}",
    deployment
      .workspace_id
      .as_deref()
      .unwrap_or(&deployment.workspace_name),
    deployment.item_id.as_deref().unwrap_or_default()
  )
}

fn redirect_was_applied(
  project_id: &str,
  deployment: &FabricDeployment,
  dev_uri: &str,
) -> bool {
  APPLIED_REDIRECTS.lock().unwrap().contains(&(
    project_id.to_string(),
    deployment_identity(deployment),
    dev_uri.to_string(),
  ))
}

fn mark_redirect_applied(
  project_id: &str,
  deployment: &FabricDeployment,
  dev_uri: &str,
) {
  APPLIED_REDIRECTS.lock().unwrap().insert((
    project_id.to_string(),
    deployment_identity(deployment),
    dev_uri.to_string(),
  ));
}

fn forget_redirect_application(
  project_id: &str,
  deployment: &FabricDeployment,
  dev_uri: &str,
) {
  APPLIED_REDIRECTS.lock().unwrap().remove(&(
    project_id.to_string(),
    deployment_identity(deployment),
    dev_uri.to_string(),
  ));
}

fn set_ready_target(project_id: &str, target: DevPreviewTarget) -> Result<(), String> {
  let mut guard = SERVER.lock().unwrap();
  let server = guard
    .as_mut()
    .filter(|server| server.project_id == project_id)
    .ok_or_else(|| "The local frontend server stopped during setup.".to_string())?;
  server.target = Some(target);
  Ok(())
}

pub(crate) async fn ensure(_app: AppHandle, project_id: String) -> DevServerStatus {
  let generation = lifecycle_generation(&project_id);
  let _guard = ENSURE_LOCK.lock().await;
  if !lifecycle_is_current(&project_id, generation) {
    return error_status(false, "Local frontend startup was cancelled.", vec![]);
  }
  let Some(project) = store::find_project(&project_id) else {
    return error_status(false, "Project not found.", vec![]);
  };
  if !store::active_project().is_some_and(|active| active.id == project_id) {
    return error_status(false, "This project is no longer active.", vec![]);
  }
  let project_dir = Path::new(&project.path);
  let data_proxy = project_uses_fabric_data(project_dir);

  if let Some(current) = current_status(&project_id, data_proxy) {
    if current.ok && current.data_proxy == data_proxy {
      return current;
    }
  }
  stop_managed_server();

  let deployment = match active_deployment(&project, generation).await {
    Ok(Some(deployment)) => deployment,
    Ok(None) => return requires_deploy_status(data_proxy),
    Err(error) => return error_status(data_proxy, error, vec![]),
  };
  if !startup_is_current(&project_id, generation) {
    return error_status(data_proxy, "Local frontend startup was cancelled.", vec![]);
  }
  if let Err(error) = prepare_frontend(project_dir, &project_id, generation).await {
    return error_status(data_proxy, error, vec![]);
  }
  if !startup_is_current(&project_id, generation) {
    return error_status(data_proxy, "Local frontend startup was cancelled.", vec![]);
  }

  let port = match choose_port() {
    Ok(port) => port,
    Err(error) => return error_status(data_proxy, error, vec![]),
  };
  let dev_uri = format!("http://localhost:{port}");
  let (logs, instance_id) = match spawn_vite(&project, data_proxy, port) {
    Ok(server) => server,
    Err(error) => return error_status(data_proxy, error, vec![]),
  };
  if let Err(error) = wait_until_ready(&project_id, generation, &dev_uri, &logs).await {
    let output = tail_logs(&logs);
    stop_project_server(&project_id);
    return error_status(data_proxy, error, output);
  }
  if !startup_is_current(&project_id, generation) {
    let output = tail_logs(&logs);
    stop_project_server(&project_id);
    return error_status(data_proxy, "Local frontend startup was cancelled.", output);
  }

  // Keep the edit, remote apply, success tracking, and any rollback atomic with
  // respect to full deploys, deployment switches, and reconciliation reads.
  let deploy_guard = deploy::acquire_deploy_lock().await;
  if !startup_is_current(&project_id, generation) {
    let output = tail_logs(&logs);
    stop_project_server(&project_id);
    return error_status(data_proxy, "Local frontend startup was cancelled.", output);
  }
  let config_changed = match ensure_allowed_redirect(project_dir, &dev_uri) {
    Ok(changed) => changed,
    Err(error) => {
      let output = tail_logs(&logs);
      stop_project_server(&project_id);
      return error_status(data_proxy, error, output);
    }
  };
  if !startup_is_current(&project_id, generation) {
    let output = tail_logs(&logs);
    let error = if config_changed {
      rollback_allowed_redirect(project_dir, &dev_uri)
        .err()
        .map(|rollback| format!("Local frontend startup was cancelled.\n\n{rollback}"))
        .unwrap_or_else(|| "Local frontend startup was cancelled.".to_string())
    } else {
      "Local frontend startup was cancelled.".to_string()
    };
    stop_project_server(&project_id);
    return error_status(data_proxy, error, output);
  };
  let apply_required = config_changed || !redirect_was_applied(&project_id, &deployment, &dev_uri);
  if apply_required {
    forget_redirect_application(&project_id, &deployment, &dev_uri);
    if let Err(error) = apply_redirect_configuration(project_dir).await {
      let output = tail_logs(&logs);
      stop_project_server(&project_id);
      let error = if config_changed {
        match rollback_allowed_redirect(project_dir, &dev_uri) {
          Ok(()) => error,
          Err(rollback) => format!("{error}\n\n{rollback}"),
        }
      } else {
        error
      };
      return error_status(data_proxy, error, output);
    }
    mark_redirect_applied(&project_id, &deployment, &dev_uri);
  }
  drop(deploy_guard);

  if !startup_is_current(&project_id, generation) {
    let output = tail_logs(&logs);
    stop_project_server(&project_id);
    return error_status(data_proxy, "Local frontend startup was cancelled.", output);
  }
  let deployment = if apply_required {
    match active_deployment(&project, generation).await {
      Ok(Some(updated)) => updated,
      Ok(None) => deployment,
      Err(error) => {
        let output = tail_logs(&logs);
        stop_project_server(&project_id);
        return error_status(data_proxy, error, output);
      }
    }
  } else {
    deployment
  };
  if !startup_is_current(&project_id, generation) {
    let output = tail_logs(&logs);
    stop_project_server(&project_id);
    return error_status(data_proxy, "Local frontend startup was cancelled.", output);
  }

  let surface_url = if data_proxy {
    let tenant = auth::get_rayfin_auth().await.tenant;
    match secure_embed_url(&deployment, &dev_uri, tenant.as_deref()) {
      Ok(url) => url,
      Err(error) => {
        let output = tail_logs(&logs);
        stop_project_server(&project_id);
        return error_status(data_proxy, error, output);
      }
    }
  } else {
    dev_uri.clone()
  };
  let target = DevPreviewTarget {
    dev_uri,
    surface_url,
    data_proxy,
  };
  if let Err(error) = set_ready_target(&project_id, target.clone()) {
    return error_status(data_proxy, error, tail_logs(&logs));
  }
  let mut ready = status(
    true,
    "ready",
    data_proxy,
    Some(&target),
    None,
    None,
    vec![],
  );
  ready.instance_id = Some(instance_id);
  ready
}

#[tauri::command]
pub async fn dev_server_ensure(app: AppHandle, project_id: String) -> DevServerStatus {
  ensure(app, project_id).await
}

#[tauri::command]
pub fn dev_server_status(project_id: String) -> DevServerStatus {
  let data_proxy = store::find_project(&project_id)
    .is_some_and(|project| project_uses_fabric_data(Path::new(&project.path)));
  current_status(&project_id, data_proxy).unwrap_or_else(|| stopped_status(data_proxy))
}

#[tauri::command]
pub fn dev_server_stop(project_id: String) -> bool {
  stop_project(&project_id)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn detects_fabric_data_in_dependencies_or_dev_dependencies() {
    let root = std::env::temp_dir().join(format!("fabricator-data-detect-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
      root.join("package.json"),
      r#"{"dependencies":{"@microsoft/fabric-app-data":"1.0.0"}}"#,
    )
    .unwrap();
    assert!(project_uses_fabric_data(&root));
    std::fs::write(
      root.join("package.json"),
      r#"{"devDependencies":{"@microsoft/fabric-app-data":"1.0.0"}}"#,
    )
    .unwrap();
    assert!(project_uses_fabric_data(&root));
    std::fs::write(root.join("package.json"), r#"{"dependencies":{"react":"19"}}"#).unwrap();
    assert!(!project_uses_fabric_data(&root));
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn appends_redirect_without_reformatting_or_duplicating_yaml() {
    let raw = "services:\n    auth:\n        enabled: true\n        allowedRedirectUris:\n            - http://localhost:5173\n    data:\n        enabled: false\n";
    let uri = "http://localhost:5174";
    let updated = with_allowed_redirect(raw, uri)
      .expect("valid")
      .expect("changed");
    assert!(updated.contains("            - http://localhost:5173\n            - http://localhost:5174\n"));
    assert_eq!(with_allowed_redirect(&updated, uri).expect("valid"), None);
  }

  #[test]
  fn adds_missing_redirect_list_under_auth() {
    let raw = "services:\n  auth:\n    enabled: true\n  data:\n    enabled: false\n";
    let updated = with_allowed_redirect(raw, "http://localhost:5174")
      .expect("valid")
      .expect("changed");
    assert!(updated.contains(
      "  auth:\n    enabled: true\n    allowedRedirectUris:\n      - http://localhost:5174\n"
    ));
  }

  #[test]
  fn normalizes_flow_style_redirects_before_appending() {
    let raw = "services:\n  auth:\n    allowedRedirectUris: [http://localhost:5173]\n  staticHosting:\n    buildCommand: npm run build\n";
    let updated = with_allowed_redirect(raw, "http://localhost:5174")
      .expect("valid")
      .expect("changed");
    assert!(updated.contains(
      "    allowedRedirectUris:\n      - http://localhost:5173\n      - http://localhost:5174\n"
    ));
    assert!(updated.contains("    buildCommand: npm run build\n"));
  }

  #[test]
  fn rejects_non_list_redirect_configuration() {
    let raw = "services:\n  auth:\n    allowedRedirectUris: http://localhost:5173\n";
    let error = with_allowed_redirect(raw, "http://localhost:5174").unwrap_err();
    assert!(error.contains("must be a YAML list"));
  }

  #[test]
  fn rollback_removes_only_the_new_redirect() {
    let raw = "services:\n  auth:\n    allowedRedirectUris:\n      - http://localhost:5173\n      - http://localhost:5174\n";
    let updated = without_allowed_redirect(raw, "http://localhost:5174")
      .expect("valid")
      .expect("changed");
    assert!(updated.contains("      - http://localhost:5173\n"));
    assert!(!updated.contains("http://localhost:5174"));
  }

  #[test]
  fn rollback_removes_an_empty_redirect_key() {
    let raw =
      "services:\n  auth:\n    enabled: true\n    allowedRedirectUris:\n      - http://localhost:5174\n";
    let updated = without_allowed_redirect(raw, "http://localhost:5174")
      .expect("valid")
      .expect("changed");
    assert!(!updated.contains("allowedRedirectUris"));
    assert!(updated.contains("    enabled: true\n"));
  }

  #[test]
  fn stopping_a_project_invalidates_pending_startup() {
    let project_id = format!("pending-{}", uuid::Uuid::new_v4());
    let generation = lifecycle_generation(&project_id);
    assert!(lifecycle_is_current(&project_id, generation));
    stop_project(&project_id);
    assert!(!lifecycle_is_current(&project_id, generation));
  }

  #[test]
  fn stale_server_cleanup_does_not_cancel_a_queued_restart() {
    let project_id = format!("cleanup-{}", uuid::Uuid::new_v4());
    let generation = lifecycle_generation(&project_id);
    assert!(!stop_project_server(&project_id));
    assert!(lifecycle_is_current(&project_id, generation));
  }

  #[test]
  fn redirect_application_is_scoped_to_the_fabric_item() {
    let project_id = format!("redirect-{}", uuid::Uuid::new_v4());
    let deployment = |item: &str| FabricDeployment {
      workspace_name: "Dev".into(),
      name: None,
      active: true,
      workspace_id: Some("workspace-1".into()),
      item_id: Some(item.into()),
      api_url: None,
      hosting_url: None,
      deployed_at: None,
    };
    let first = deployment("item-1");
    let second = deployment("item-2");
    let uri = "http://localhost:5174";
    mark_redirect_applied(&project_id, &first, uri);
    assert!(redirect_was_applied(&project_id, &first, uri));
    assert!(!redirect_was_applied(&project_id, &second, uri));
  }

  #[test]
  fn secure_embed_url_double_encodes_extension_path() {
    let deployment = FabricDeployment {
      workspace_name: "Dev".into(),
      name: None,
      active: true,
      workspace_id: Some("workspace-1".into()),
      item_id: Some("item-1".into()),
      api_url: None,
      hosting_url: None,
      deployed_at: None,
    };
    assert_eq!(
      secure_embed_url(
        &deployment,
        "http://localhost:5174",
        Some("tenant-1")
      )
      .expect("url"),
      "https://app.fabric.microsoft.com/secureItemEmbed?itemId=item-1&workspaceId=workspace-1&itemType=appBackend&ctid=tenant-1&extensionPath=%3FdevUri%3Dhttp%253A%252F%252Flocalhost%253A5174"
    );
  }
}
