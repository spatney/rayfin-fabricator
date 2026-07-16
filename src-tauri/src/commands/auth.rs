//! Authentication — the Rust port of `src/main/services/auth.ts`.
//! Copilot auth is a cheap, non-interactive probe of `~/.copilot/config.json`
//! (JSONC); Fabric/Rayfin auth runs `rayfin login status` via the active
//! project's locally-installed CLI (falling back to a global `rayfin` on PATH).
//! Login/logout stream their CLI output to the renderer.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::AppHandle;

use crate::services::crashlog;
use crate::services::emit::proc_streamer;
use crate::services::exec::{self, RunOptions};
use crate::services::paths;
use crate::services::store;
use crate::services::telemetry::{self, TelemetryIdentity};
use crate::types::{AuthStatus, AzAuthStatus, CopilotAuthStatus, ProcResult, RayfinAuthStatus};

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

/// Run the Rayfin CLI for Fabric auth, preferring the active project's
/// locally-installed CLI (so no global install is required) and falling back to a
/// global `rayfin` on PATH when there's no active project. The MSAL token cache is
/// shared across installs, so either resolves the same signed-in session.
async fn run_rayfin(args: &[&str], opts: RunOptions) -> exec::RunResult {
  match store::active_project() {
    Some(project) => exec::run_project_rayfin(Path::new(&project.path), args, opts).await,
    None => exec::run("rayfin", args, opts).await,
  }
}

/// Detect Fabric/Rayfin auth via `rayfin login status`.
pub async fn get_rayfin_auth() -> RayfinAuthStatus {
  let res = run_rayfin(&["login", "status"], RunOptions::timeout(30_000)).await;
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

/// Detect Azure CLI auth via the `az` CLI.
///
/// `az account show` reads the on-disk profile and keeps reporting a signed-in
/// account even after the refresh token has expired (AADSTS700082), so it can't
/// be trusted on its own. We first probe `az account get-access-token`, which
/// actually exercises the token, and only then read `az account show` for the
/// display name + tenant.
pub async fn get_az_auth() -> AzAuthStatus {
  let token = exec::run(
    "az",
    &["account", "get-access-token", "--output", "none"],
    RunOptions::timeout(30_000),
  )
  .await;
  if !token.ok {
    return AzAuthStatus::default();
  }

  let show = exec::run(
    "az",
    &["account", "show", "--output", "json"],
    RunOptions::timeout(30_000),
  )
  .await;
  let (user, tenant) = serde_json::from_str::<serde_json::Value>(&show.stdout)
    .ok()
    .map(|v| {
      let user = v["user"]["name"].as_str().map(|s| s.to_string());
      let tenant = v["tenantId"].as_str().map(|s| s.to_string());
      (user, tenant)
    })
    .unwrap_or((None, None));

  AzAuthStatus {
    signed_in: true,
    user,
    tenant,
  }
}

#[tauri::command]
pub async fn auth_status() -> AuthStatus {
  let copilot = get_copilot_auth();
  // Rayfin and Azure both shell out to their CLIs; run them concurrently so the
  // startup check isn't the sum of two slow process spawns.
  let (rayfin, az) = tokio::join!(get_rayfin_auth(), get_az_auth());
  if rayfin.signed_in && !STARTUP_SIGNIN_SENT.swap(true, Ordering::SeqCst) {
    telemetry::track_signin(cached_identity().as_ref(), "startup");
  }
  AuthStatus { copilot, rayfin, az }
}

#[tauri::command]
pub async fn auth_login_copilot(app: AppHandle) -> ProcResult {
  let on_data = proc_streamer(&app, "login:copilot");
  on_data(exec::Stream::Stdout, "Starting GitHub Copilot sign-in…\n");
  let Some(cli) = crate::services::copilot::bundled_cli_path() else {
    on_data(exec::Stream::Stderr, "The bundled Copilot CLI is unavailable on this platform.\n");
    return ProcResult {
      ok: false,
      exit_code: None,
      error: Some("The bundled Copilot CLI is unavailable on this platform.".into()),
    };
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
    error: None,
  }
}

/// Collapse multi-line CLI output into a single, bounded line so a login
/// failure is one greppable record and survives the diagnostics tail logic.
/// Returns `"(none)"` when empty.
fn one_line(text: &str) -> String {
  let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
  if joined.is_empty() {
    return "(none)".to_string();
  }
  joined.chars().take(1500).collect()
}

/// Compose a user-facing reason for a failed `rayfin login`.
///
/// The CLI prints the real cause to stderr as `❌ Login failed: <message>` (see
/// `@microsoft/rayfin-cli` login command) and exits non-zero for the fast-fail
/// cases users hit (native keychain/MSAL module load, MSAL/AADSTS errors,
/// browser-open failures, partial `RAYFIN_*` overrides). Prefer the most
/// descriptive stderr line, then stdout, then an exit-status-based hint that
/// points at the same `npx rayfin login` fallback we suggest in the UI.
fn login_failure_detail(res: &exec::RunResult) -> String {
  if res.not_found {
    return "The Rayfin CLI could not be found. Open the project so its dependencies install (or install Node.js and the Rayfin CLI), then try signing in again."
      .to_string();
  }
  let pick = |text: &str| -> Option<String> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    // Prefer an explicit failure/error line (the CLI logs `❌ Login failed: …`
    // last), else the final non-empty line.
    lines
      .iter()
      .rev()
      .find(|l| {
        let low = l.to_lowercase();
        low.contains("login failed") || low.contains("failed") || low.contains("error")
      })
      .or_else(|| lines.last())
      .map(|l| l.chars().take(500).collect::<String>())
  };
  if let Some(msg) = pick(&res.stderr).filter(|m| !m.is_empty()) {
    return msg;
  }
  if let Some(msg) = pick(&res.stdout).filter(|m| !m.is_empty()) {
    return msg;
  }
  match res.exit_code {
    Some(code) => format!(
      "Sign-in exited with code {code} without opening a sign-in window or reporting a reason. Please try again; if it keeps happening, run `npx rayfin login` in the project folder to see the full error."
    ),
    None => "Sign-in ended without opening a sign-in window or reporting a reason (it may have timed out or been blocked). Please try again; if it keeps happening, run `npx rayfin login` in the project folder to see the full error."
      .to_string(),
  }
}

#[tauri::command]
pub async fn auth_login_rayfin(app: AppHandle, tenant: Option<String>) -> ProcResult {
  let on_data = proc_streamer(&app, "login:rayfin");
  on_data(exec::Stream::Stdout, "Starting Fabric / Rayfin sign-in…\n");
  let mut args: Vec<String> = vec!["login".into(), "--select".into()];
  let tenant_label = tenant
    .as_ref()
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .map(|t| t.to_string());
  if let Some(t) = tenant_label.as_ref() {
    args.push("--tenant".into());
    args.push(t.clone());
  }
  let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
  let res = run_rayfin(
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
    return ProcResult {
      ok: true,
      exit_code: res.exit_code,
      error: None,
    };
  }
  // Surface *why* sign-in failed: return a user-facing detail and record the
  // full CLI output to the crash log so it lands in the diagnostics bundle's
  // "Recent crash / hang log" section. Previously this was silently swallowed
  // (issue #17), so a failed sign-in looked like the button did nothing.
  let detail = login_failure_detail(&res);
  crashlog::log_error(
    "fabric-login",
    &format!(
      "rayfin login failed — exit={:?} not_found={} tenant={} — stderr: {} — stdout: {}",
      res.exit_code,
      res.not_found,
      tenant_label.as_deref().unwrap_or("(default)"),
      one_line(&res.stderr),
      one_line(&res.stdout),
    ),
  );
  ProcResult {
    ok: false,
    exit_code: res.exit_code,
    error: Some(detail),
  }
}

#[tauri::command]
pub async fn auth_login_az(app: AppHandle) -> ProcResult {
  let on_data = proc_streamer(&app, "login:az");
  on_data(exec::Stream::Stdout, "Starting Azure sign-in…\n");
  let res = exec::run(
    "az",
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
    error: None,
  }
}

#[tauri::command]
pub async fn auth_logout_rayfin(app: AppHandle) -> ProcResult {
  let on_data = proc_streamer(&app, "logout:rayfin");
  let res = run_rayfin(
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
    error: None,
  }
}

/// The most recently resolved signed-in identity (used by deploy telemetry).
pub fn get_cached_identity() -> Option<TelemetryIdentity> {
  cached_identity()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn res(exit_code: Option<i32>, not_found: bool, stdout: &str, stderr: &str) -> exec::RunResult {
    exec::RunResult {
      ok: false,
      exit_code,
      stdout: stdout.to_string(),
      stderr: stderr.to_string(),
      not_found,
    }
  }

  #[test]
  fn login_detail_prefers_the_cli_failure_line_from_stderr() {
    // The CLI logs MSAL warnings then the real reason last; we surface the
    // `❌ Login failed: …` line, not the noise above it.
    let r = res(
      Some(1),
      false,
      "🔑 Opening browser for sign-in...\n",
      "[msal] some info\n❌ Login failed: AADSTS50020: User account from identity provider does not exist in tenant\n",
    );
    let detail = login_failure_detail(&r);
    assert!(detail.contains("Login failed"), "got: {detail}");
    assert!(detail.contains("AADSTS50020"), "got: {detail}");
  }

  #[test]
  fn login_detail_reports_a_missing_cli() {
    let r = res(None, true, "", "rayfin was not found on PATH");
    let detail = login_failure_detail(&r);
    assert!(detail.contains("Rayfin CLI could not be found"), "got: {detail}");
  }

  #[test]
  fn login_detail_falls_back_to_stdout_then_exit_hint() {
    // No stderr, but stdout carried the reason.
    let from_stdout = login_failure_detail(&res(Some(1), false, "Something failed mid-run\n", ""));
    assert!(from_stdout.contains("Something failed"), "got: {from_stdout}");

    // No output at all → an actionable, exit-status-based hint pointing at the
    // same `npx rayfin login` fallback the UI suggests.
    let from_code = login_failure_detail(&res(Some(3), false, "", ""));
    assert!(from_code.contains("code 3"), "got: {from_code}");
    assert!(from_code.contains("npx rayfin login"), "got: {from_code}");

    let no_code = login_failure_detail(&res(None, false, "   \n  ", "\n"));
    assert!(no_code.contains("npx rayfin login"), "got: {no_code}");
  }

  #[test]
  fn one_line_collapses_whitespace_and_marks_empty() {
    assert_eq!(one_line("  a\n\n  b   c \n"), "a b c");
    assert_eq!(one_line("   \n\t "), "(none)");
    // Bounded so a runaway log can't bloat the crash file.
    assert!(one_line(&"x ".repeat(2000)).chars().count() <= 1500);
  }
}
