//! Authentication — the Rust port of `src/main/services/auth.ts`.
//! Copilot auth is verified by the bundled chat engine, not remembered account
//! metadata; Fabric/Rayfin auth runs `rayfin login status` via the active
//! project's locally-installed CLI (falling back to a global `rayfin` on PATH).
//! Login/logout stream their CLI output to the renderer.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::{AppHandle, State};

use crate::services::crashlog;
use crate::services::emit::proc_streamer;
use crate::services::exec::{self, RunOptions};
use crate::services::store;
use crate::services::telemetry::{self, TelemetryIdentity};
use crate::state::AppState;
use crate::types::{AuthStatus, AzAuthStatus, CopilotAuthStatus, ProcResult, RayfinAuthStatus};

/// Last-known signed-in identity, cached so telemetry can attach a stable hashed
/// user without re-spawning the CLI.
static CACHED_IDENTITY: Lazy<Mutex<Option<TelemetryIdentity>>> = Lazy::new(|| Mutex::new(None));
/// Guard so the "active at startup" signin event fires at most once per process.
static STARTUP_SIGNIN_SENT: AtomicBool = AtomicBool::new(false);
static COPILOT_AUTH_ACTION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static RAYFIN_AUTH_ACTION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static AZ_AUTH_ACTION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn set_identity(identity: Option<TelemetryIdentity>) {
  *CACHED_IDENTITY.lock().unwrap() = identity;
}

fn cached_identity() -> Option<TelemetryIdentity> {
  CACHED_IDENTITY.lock().unwrap().clone()
}

pub async fn get_copilot_auth(state: &AppState) -> CopilotAuthStatus {
  state.copilot.auth_status().await
}

static NOT_SIGNED_IN_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)not\s+(?:currently\s+)?signed\s+in").unwrap());
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

/// Read the CLI identity, then verify its token against Fabric before reporting
/// a connection. Cached `login status` output alone cannot prove access.
pub async fn get_rayfin_auth() -> RayfinAuthStatus {
  let res = run_rayfin(&["login", "status"], RunOptions::timeout(30_000)).await;
  let text = format!("{}\n{}", res.stdout, res.stderr);
  let signed_in = res.ok && !NOT_SIGNED_IN_RE.is_match(&text) && SIGNED_IN_RE.is_match(&text);
  if !signed_in {
    set_identity(None);
    return RayfinAuthStatus {
      error: if res.ok && NOT_SIGNED_IN_RE.is_match(&text) {
        None
      } else if res.ok {
        Some("The Rayfin CLI returned an unrecognized sign-in status. Re-check or sign in to Fabric again.".into())
      } else {
        Some(cli_failure_detail(
          &res,
          "Fabric authentication check",
          "Open a Rayfin project and sign in to Fabric again.",
        ))
      },
      ..Default::default()
    };
  }
  if let Err(error) = crate::commands::fabric::probe_rayfin_auth().await {
    set_identity(None);
    return RayfinAuthStatus { error: Some(error), ..Default::default() };
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
    error: None,
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
    return AzAuthStatus {
      error: Some(cli_failure_detail(
        &token,
        "Azure authentication check",
        "Check your connection and sign in to Azure again.",
      )),
      ..Default::default()
    };
  }

  let show = exec::run(
    "az",
    &["account", "show", "--output", "json"],
    RunOptions::timeout(30_000),
  )
  .await;
  parse_az_account(&show)
}

#[tauri::command]
pub async fn auth_status(state: State<'_, AppState>) -> Result<AuthStatus, String> {
  let (copilot, rayfin, az) = tokio::join!(
    get_copilot_auth(state.inner()),
    get_rayfin_auth(),
    get_az_auth(),
  );
  if rayfin.signed_in && !STARTUP_SIGNIN_SENT.swap(true, Ordering::SeqCst) {
    telemetry::track_signin(cached_identity().as_ref(), "startup");
  }
  Ok(AuthStatus { copilot, rayfin, az })
}

#[tauri::command]
pub async fn auth_login_copilot(app: AppHandle, state: State<'_, AppState>) -> Result<ProcResult, String> {
  let Ok(_guard) = COPILOT_AUTH_ACTION.try_lock() else {
    return Ok(auth_failure("copilot-login", None, "Copilot sign-in is already in progress.".into()));
  };
  let login_guard = match state.copilot.begin_login() {
    Ok(guard) => guard,
    Err(error) => return Ok(auth_failure("copilot-login", None, error)),
  };
  if state.is_copilot_busy() {
    return Ok(auth_failure(
      "copilot-login",
      None,
      "Wait for active Copilot tasks to finish or stop them, then sign in again.".into(),
    ));
  }
  let on_data = proc_streamer(&app, "login:copilot");
  on_data(exec::Stream::Stdout, "Starting GitHub Copilot sign-in…\n");
  let Some(cli) = crate::services::copilot::bundled_cli_path() else {
    on_data(exec::Stream::Stderr, "The bundled Copilot CLI is unavailable on this platform.\n");
    return Ok(auth_failure(
      "copilot-login",
      None,
      "The bundled Copilot CLI is unavailable. Restart or reinstall Fabricator and try again.".into(),
    ));
  };
  let res = exec::run_program(
    cli,
    &["login"],
    RunOptions {
      on_data: Some(on_data.clone()),
      timeout_ms: Some(5 * 60_000),
      ..Default::default()
    },
  )
  .await;
  if !res.ok {
    let detail = cli_failure_detail(
      &res,
      "GitHub Copilot sign-in",
      "Try signing in again and complete the browser or device-code instructions shown above.",
    );
    on_data(exec::Stream::Stderr, &format!("{detail}\n"));
    return Ok(auth_failure("copilot-login", res.exit_code, detail));
  }
  on_data(exec::Stream::Stdout, "Verifying access in the Copilot chat engine...\n");
  state.copilot.reload_auth().await;
  drop(login_guard);
  let auth = get_copilot_auth(state.inner()).await;
  Ok(verified_login("copilot-login", "GitHub Copilot", &res, auth.signed_in, auth.error))
}

fn auth_failure(context: &str, exit_code: Option<i32>, error: String) -> ProcResult {
  crashlog::log_error(context, &one_line(&error));
  ProcResult { ok: false, exit_code, error: Some(error) }
}

fn verified_login(
  context: &str,
  provider: &str,
  res: &exec::RunResult,
  signed_in: bool,
  error: Option<String>,
) -> ProcResult {
  let result = login_verification_result(provider, res, signed_in, error);
  if let Some(error) = &result.error {
    crashlog::log_error(context, &one_line(error));
  }
  result
}

fn login_verification_result(
  provider: &str,
  res: &exec::RunResult,
  signed_in: bool,
  error: Option<String>,
) -> ProcResult {
  if res.ok && signed_in {
    return ProcResult { ok: true, exit_code: res.exit_code, error: None };
  }
  ProcResult {
    ok: false,
    exit_code: res.exit_code,
    error: Some(error.unwrap_or_else(|| format!(
      "{provider} sign-in finished, but authentication could not be verified. Check your connection and try signing in again."
    ))),
  }
}

fn cli_failure_detail(res: &exec::RunResult, action: &str, hint: &str) -> String {
  let detail = res.stderr.lines().rev().map(str::trim).find(|line| !line.is_empty())
    .or_else(|| res.stdout.lines().rev().map(str::trim).find(|line| {
      let lower = line.to_ascii_lowercase();
      lower.contains("error") || lower.contains("failed")
    }));
  let reason = if res.not_found {
    "The required CLI could not be found.".to_string()
  } else if let Some(detail) = detail {
    detail.chars().take(500).collect()
  } else if let Some(code) = res.exit_code {
    format!("The CLI exited with code {code}.")
  } else {
    "The CLI timed out or could not be started.".to_string()
  };
  format!("{action} failed. {reason} {hint}")
}

fn parse_az_account(res: &exec::RunResult) -> AzAuthStatus {
  if !res.ok {
    return AzAuthStatus {
      error: Some(cli_failure_detail(res, "Azure account check", "Sign in to Azure again.")),
      ..Default::default()
    };
  }
  let account = serde_json::from_str::<serde_json::Value>(&res.stdout);
  if let Ok(account) = account {
    let nonempty = |v: &serde_json::Value| {
      v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    };
    if let (Some(user), Some(tenant)) = (nonempty(&account["user"]["name"]), nonempty(&account["tenantId"])) {
      return AzAuthStatus { signed_in: true, user: Some(user), tenant: Some(tenant), error: None };
    }
  }
  log::warn!("Azure account check returned an invalid or incomplete profile");
  AzAuthStatus {
    error: Some("Azure returned an incomplete account profile. Re-check or sign in to Azure again.".into()),
    ..Default::default()
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
  let Ok(_guard) = RAYFIN_AUTH_ACTION.try_lock() else {
    return auth_failure("fabric-login", None, "A Fabric sign-in or sign-out is already in progress.".into());
  };
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
    let auth = get_rayfin_auth().await;
    if auth.signed_in {
      telemetry::track_signin(cached_identity().as_ref(), "login");
    }
    return verified_login("fabric-login", "Fabric", &res, auth.signed_in, auth.error);
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
  let Ok(_guard) = AZ_AUTH_ACTION.try_lock() else {
    return auth_failure("azure-login", None, "Azure sign-in is already in progress.".into());
  };
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
  if !res.ok {
    return auth_failure(
      "azure-login",
      res.exit_code,
      cli_failure_detail(&res, "Azure sign-in", "Complete the browser sign-in and try again."),
    );
  }
  let auth = get_az_auth().await;
  verified_login("azure-login", "Azure", &res, auth.signed_in, auth.error)
}

#[tauri::command]
pub async fn auth_logout_rayfin(app: AppHandle) -> ProcResult {
  let Ok(_guard) = RAYFIN_AUTH_ACTION.try_lock() else {
    return auth_failure("fabric-logout", None, "A Fabric sign-in or sign-out is already in progress.".into());
  };
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
  if !res.ok {
    return auth_failure(
      "fabric-logout",
      res.exit_code,
      cli_failure_detail(&res, "Fabric sign-out", "Try signing out again."),
    );
  }
  set_identity(None);
  ProcResult {
    ok: true,
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
  fn azure_account_requires_a_successful_complete_profile() {
    let valid = r#"{"user":{"name":"signed-in-user"},"tenantId":"tenant"}"#;
    assert!(!parse_az_account(&res(Some(1), false, valid, "Profile unavailable")).signed_in);
    for invalid in ["", "not json", "{}", r#"{"user":{"name":"user"}}"#, r#"{"user":{"name":""},"tenantId":"tenant"}"#] {
      let mut result = res(Some(0), false, invalid, "");
      result.ok = true;
      let status = parse_az_account(&result);
      assert!(!status.signed_in, "{invalid}");
      assert!(status.error.is_some());
    }
    let mut result = res(Some(0), false, valid, "");
    result.ok = true;
    let status = parse_az_account(&result);
    assert!(status.signed_in);
    assert_eq!(status.user.as_deref(), Some("signed-in-user"));
    assert_eq!(status.tenant.as_deref(), Some("tenant"));
  }

  #[test]
  fn login_success_requires_both_cli_success_and_verified_auth() {
    let mut result = res(Some(0), false, "", "");
    result.ok = true;
    assert!(!login_verification_result("Copilot", &result, false, None).ok);
    assert!(login_verification_result("Copilot", &result, true, None).ok);
    result.ok = false;
    let failed = login_verification_result("Copilot", &result, true, Some("Access revoked".into()));
    assert!(!failed.ok);
    assert_eq!(failed.error.as_deref(), Some("Access revoked"));
  }

  #[test]
  fn cli_auth_failure_has_actionable_details_without_echoing_device_codes() {
    let failure = cli_failure_detail(
      &res(Some(1), false, "Use device code ABCD-EFGH", ""),
      "Copilot sign-in",
      "Try again.",
    );
    assert!(failure.contains("code 1"));
    assert!(!failure.contains("ABCD-EFGH"));
    assert!(cli_failure_detail(&res(None, false, "", ""), "Sign-in", "Try again.").contains("timed out"));
    assert!(cli_failure_detail(&res(None, true, "", ""), "Sign-in", "Try again.").contains("could not be found"));
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
