//! Authentication — the Rust port of `src/main/services/auth.ts`.
//! Copilot auth is a cheap, non-interactive probe of `~/.copilot/config.json`
//! (JSONC); Fabric/Rayfin auth runs `rayfin login status`. Login/logout stream
//! their CLI output to the renderer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::AppHandle;

use crate::services::emit::proc_streamer;
use crate::services::exec::{self, RunOptions};
use crate::services::paths;
use crate::services::telemetry::{self, TelemetryIdentity};
use crate::types::{AuthStatus, CopilotAuthStatus, ProcResult, RayfinAuthStatus};

/// Last-known signed-in identity, cached so telemetry can attach a stable hashed
/// user without re-spawning the CLI.
static CACHED_IDENTITY: Lazy<Mutex<Option<TelemetryIdentity>>> = Lazy::new(|| Mutex::new(None));
/// Guard so the "active at startup" signin event fires at most once per process.
static STARTUP_SIGNIN_SENT: AtomicBool = AtomicBool::new(false);

fn set_identity(identity: Option<TelemetryIdentity>) {
  *CACHED_IDENTITY.lock().unwrap() = identity;
}

fn cached_identity() -> Option<TelemetryIdentity> {
  CACHED_IDENTITY.lock().unwrap().clone()
}

/// Strip line/block comments from JSONC while preserving string contents (the
/// Copilot config contains URLs like `https://github.com`).
fn strip_json_comments(input: &str) -> String {
  let bytes: Vec<char> = input.chars().collect();
  let mut out = String::with_capacity(input.len());
  let mut in_string = false;
  let mut escaped = false;
  let mut i = 0;
  while i < bytes.len() {
    let c = bytes[i];
    let next = bytes.get(i + 1).copied();
    if in_string {
      out.push(c);
      if escaped {
        escaped = false;
      } else if c == '\\' {
        escaped = true;
      } else if c == '"' {
        in_string = false;
      }
      i += 1;
      continue;
    }
    if c == '"' {
      in_string = true;
      out.push(c);
      i += 1;
      continue;
    }
    if c == '/' && next == Some('/') {
      i += 2;
      while i < bytes.len() && bytes[i] != '\n' {
        i += 1;
      }
      out.push('\n');
      continue;
    }
    if c == '/' && next == Some('*') {
      i += 2;
      while i < bytes.len() && !(bytes[i] == '*' && bytes.get(i + 1) == Some(&'/')) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out.push(c);
    i += 1;
  }
  out
}

/// Read Copilot's logged-in user from `~/.copilot/config.json`.
pub fn get_copilot_auth() -> CopilotAuthStatus {
  let cfg_path = paths::home_dir().join(".copilot").join("config.json");
  let Ok(raw) = std::fs::read_to_string(cfg_path) else {
    return CopilotAuthStatus::default();
  };
  let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&strip_json_comments(&raw)) else {
    return CopilotAuthStatus::default();
  };

  let users = &cfg["loggedInUsers"];
  let mut signed_in = false;
  let mut first_login: Option<String> = None;
  if let Some(arr) = users.as_array() {
    signed_in = !arr.is_empty();
    first_login = arr
      .first()
      .and_then(|u| u.get("login"))
      .and_then(|l| l.as_str())
      .map(|s| s.to_string());
  } else if let Some(obj) = users.as_object() {
    signed_in = !obj.is_empty();
  }

  let last_login = match &cfg["lastLoggedInUser"] {
    serde_json::Value::String(s) => Some(s.clone()),
    serde_json::Value::Object(_) => cfg["lastLoggedInUser"]["login"]
      .as_str()
      .map(|s| s.to_string()),
    _ => None,
  };

  CopilotAuthStatus {
    signed_in,
    user: last_login.or(first_login),
  }
}

static NOT_SIGNED_IN_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)not\s+signed\s+in").unwrap());
static SIGNED_IN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)signed\s+in").unwrap());
static USER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)User:\s*(.+)").unwrap());
static TENANT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)Tenant:\s*(.+)").unwrap());

/// Detect Fabric/Rayfin auth via `rayfin login status`.
pub async fn get_rayfin_auth() -> RayfinAuthStatus {
  let res = exec::run("rayfin", &["login", "status"], RunOptions::timeout(30_000)).await;
  let text = format!("{}\n{}", res.stdout, res.stderr);
  let signed_in = res.ok && !NOT_SIGNED_IN_RE.is_match(&text) && SIGNED_IN_RE.is_match(&text);
  if !signed_in {
    set_identity(None);
    return RayfinAuthStatus::default();
  }
  let user = USER_RE
    .captures(&text)
    .and_then(|c| c.get(1))
    .map(|m| m.as_str().trim().to_string());
  let tenant = TENANT_RE
    .captures(&text)
    .and_then(|c| c.get(1))
    .map(|m| m.as_str().trim().to_string());
  set_identity(Some(TelemetryIdentity {
    email: user.clone(),
    tenant: tenant.clone(),
  }));
  RayfinAuthStatus {
    signed_in: true,
    user,
    tenant,
  }
}

#[tauri::command]
pub async fn auth_status() -> AuthStatus {
  let copilot = get_copilot_auth();
  let rayfin = get_rayfin_auth().await;
  if rayfin.signed_in && !STARTUP_SIGNIN_SENT.swap(true, Ordering::SeqCst) {
    telemetry::track_signin(cached_identity().as_ref(), "startup");
  }
  AuthStatus { copilot, rayfin }
}

#[tauri::command]
pub async fn auth_login_copilot(app: AppHandle) -> ProcResult {
  let on_data = proc_streamer(&app, "login:copilot");
  on_data(exec::Stream::Stdout, "Starting GitHub Copilot sign-in…\n");
  let Some(cli) = crate::services::copilot::bundled_cli_path() else {
    on_data(exec::Stream::Stderr, "The bundled Copilot CLI is unavailable on this platform.\n");
    return ProcResult { ok: false, exit_code: None };
  };
  let res = exec::run_program(
    cli,
    &["login"],
    RunOptions {
      on_data: Some(on_data),
      timeout_ms: Some(5 * 60_000),
      ..Default::default()
    },
  )
  .await;
  ProcResult {
    ok: res.ok,
    exit_code: res.exit_code,
  }
}

#[tauri::command]
pub async fn auth_login_rayfin(app: AppHandle, tenant: Option<String>) -> ProcResult {
  let on_data = proc_streamer(&app, "login:rayfin");
  on_data(exec::Stream::Stdout, "Starting Fabric / Rayfin sign-in…\n");
  let mut args: Vec<String> = vec!["login".into(), "--select".into()];
  if let Some(t) = tenant.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
    args.push("--tenant".into());
    args.push(t.to_string());
  }
  let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
  let res = exec::run(
    "rayfin",
    &arg_refs,
    RunOptions {
      on_data: Some(on_data),
      timeout_ms: Some(5 * 60_000),
      ..Default::default()
    },
  )
  .await;
  if res.ok {
    get_rayfin_auth().await;
    telemetry::track_signin(cached_identity().as_ref(), "login");
  }
  ProcResult {
    ok: res.ok,
    exit_code: res.exit_code,
  }
}

#[tauri::command]
pub async fn auth_logout_rayfin(app: AppHandle) -> ProcResult {
  let on_data = proc_streamer(&app, "logout:rayfin");
  let res = exec::run(
    "rayfin",
    &["logout"],
    RunOptions {
      on_data: Some(on_data),
      timeout_ms: Some(60_000),
      ..Default::default()
    },
  )
  .await;
  if res.ok {
    set_identity(None);
  }
  ProcResult {
    ok: res.ok,
    exit_code: res.exit_code,
  }
}

/// The most recently resolved signed-in identity (used by deploy telemetry).
pub fn get_cached_identity() -> Option<TelemetryIdentity> {
  cached_identity()
}
