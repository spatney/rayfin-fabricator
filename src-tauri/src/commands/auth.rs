//! Authentication — the Rust port of `src/main/services/auth.ts`.
//! Copilot auth is verified by the bundled chat engine, not remembered account
//! metadata; Fabric/Rayfin auth runs `rayfin login status` via the active
//! project's locally-installed CLI (falling back to a global `rayfin` on PATH).
//! Login/logout stream their CLI output to the renderer.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::{AppHandle, State};

use crate::services::crashlog;
use crate::services::emit::proc_streamer;
use crate::services::exec::{self, OnData, RunOptions};
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
static RAYFIN_AUTH_USE: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());
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

/// Keep credential changes from interrupting a deploy or authentication probe.
pub(crate) async fn rayfin_auth_read() -> tokio::sync::RwLockReadGuard<'static, ()> {
  RAYFIN_AUTH_USE.read().await
}

fn rayfin_project_dir(project_id: Option<&str>) -> Result<Option<PathBuf>, String> {
  let project = match project_id {
    Some(id) => Some(store::find_project(id).ok_or_else(|| "Project not found.".to_string())?),
    None => store::active_project(),
  };
  Ok(project.map(|p| PathBuf::from(p.path)))
}

/// Run the Rayfin CLI for Fabric auth, preferring the selected project's
/// locally-installed CLI (so no global install is required) and falling back to a
/// global `rayfin` on PATH when there's no active project. The MSAL token cache is
/// shared across installs, so either resolves the same signed-in session.
async fn run_rayfin(project_dir: Option<&Path>, args: &[&str], opts: RunOptions) -> exec::RunResult {
  match project_dir {
    Some(dir) => exec::run_project_rayfin(dir, args, opts).await,
    None => exec::run("rayfin", args, opts).await,
  }
}

/// Read the CLI identity, then verify its token against Fabric before reporting
/// a connection. Cached `login status` output alone cannot prove access.
pub async fn get_rayfin_auth() -> RayfinAuthStatus {
  let _guard = rayfin_auth_read().await;
  let project_dir = store::active_project().map(|p| PathBuf::from(p.path));
  get_rayfin_auth_for(project_dir.as_deref()).await
}

async fn get_rayfin_auth_for(project_dir: Option<&Path>) -> RayfinAuthStatus {
  let res = run_rayfin(project_dir, &["login", "status"], RunOptions::timeout(30_000)).await;
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
  if let Err(error) = crate::commands::fabric::probe_rayfin_auth(project_dir).await {
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
pub async fn auth_login_copilot(
  app: AppHandle,
  state: State<'_, AppState>,
  host: Option<String>,
) -> Result<ProcResult, String> {
  let Ok(_guard) = COPILOT_AUTH_ACTION.try_lock() else {
    return Ok(auth_failure("copilot-login", None, "A Copilot sign-in or sign-out is already in progress.".into()));
  };
  let args = match copilot_login_args(host.as_deref()) {
    Ok(args) => args,
    Err(error) => return Ok(auth_failure("copilot-login", None, error)),
  };
  let login_guard = match state.copilot.begin_auth_change() {
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
  on_data(exec::Stream::Stdout, &format!("Starting GitHub Copilot sign-in at {}...\n", args[2]));
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
    &args.iter().map(String::as_str).collect::<Vec<_>>(),
    RunOptions {
      on_data: Some(on_data.clone()),
      timeout_ms: Some(5 * 60_000),
      ..Default::default()
    },
  )
  .await;
  state.copilot.reload_auth().await;
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
  drop(login_guard);
  let auth = get_copilot_auth(state.inner()).await;
  let host_error = copilot_host_error(&args[2], &auth);
  Ok(verified_login(
    "copilot-login",
    "GitHub Copilot",
    &res,
    auth.signed_in && host_error.is_none(),
    host_error.or(auth.error),
  ))
}

fn normalize_copilot_host(host: &str) -> Result<String, String> {
  let invalid = || {
    "Enter github.com or a GitHub Enterprise Cloud hostname such as company.ghe.com (optionally with https://). Do not include a path, credentials, or a non-HTTPS port."
      .to_string()
  };
  let host = host.trim();
  if host.is_empty() || host.contains('\\') || host.chars().any(char::is_whitespace) {
    return Err(invalid());
  }
  let url = if host.contains("://") { host.to_string() } else { format!("https://{host}") };
  let url = reqwest::Url::parse(&url).map_err(|_| invalid())?;
  let domain = url.host_str().ok_or_else(invalid)?;
  let valid_domain = domain.len() <= 253 && domain.split('.').all(|label| {
    !label.is_empty()
      && label.len() <= 63
      && !label.starts_with('-')
      && !label.ends_with('-')
      && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
  });
  if url.scheme() != "https"
    || !url.username().is_empty()
    || url.password().is_some()
    || url.port().is_some()
    || url.path() != "/"
    || url.query().is_some()
    || url.fragment().is_some()
    || !valid_domain
    || !(domain == "github.com" || domain.ends_with(".ghe.com"))
  {
    return Err(invalid());
  }
  Ok(format!("https://{domain}"))
}

fn copilot_login_args(host: Option<&str>) -> Result<[String; 3], String> {
  Ok(["login".into(), "--host".into(), normalize_copilot_host(host.unwrap_or("github.com"))?])
}

fn copilot_host_error(requested_host: &str, auth: &CopilotAuthStatus) -> Option<String> {
  let actual_host = auth.host.as_deref().and_then(|host| normalize_copilot_host(host).ok());
  (auth.signed_in && actual_host.as_deref() != Some(requested_host)).then(|| format!(
    "Copilot sign-in completed, but the chat engine is not using {requested_host}. Check for COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN overrides, remove unintended overrides, and sign in again."
  ))
}

#[tauri::command]
pub async fn auth_logout_copilot(app: AppHandle, state: State<'_, AppState>) -> Result<ProcResult, String> {
  let Ok(_guard) = COPILOT_AUTH_ACTION.try_lock() else {
    return Ok(auth_failure("copilot-logout", None, "A Copilot sign-in or sign-out is already in progress.".into()));
  };
  let _auth_guard = match state.copilot.begin_auth_change() {
    Ok(guard) => guard,
    Err(error) => return Ok(auth_failure("copilot-logout", None, error)),
  };
  if state.is_copilot_busy() {
    return Ok(auth_failure(
      "copilot-logout",
      None,
      "Wait for active Copilot tasks to finish or stop them, then sign out again.".into(),
    ));
  }
  let on_data = proc_streamer(&app, "logout:copilot");
  on_data(exec::Stream::Stdout, "Signing out of GitHub Copilot...\n");
  Ok(match state.copilot.logout().await {
    Ok(()) => {
      on_data(exec::Stream::Stdout, "Signed out of GitHub Copilot.\n");
      ProcResult { ok: true, exit_code: None, error: None }
    }
    Err(error) => {
      on_data(exec::Stream::Stderr, &format!("{error}\n"));
      auth_failure("copilot-logout", None, error)
    }
  })
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
pub async fn auth_login_rayfin(app: AppHandle, tenant: Option<String>, project_id: Option<String>) -> ProcResult {
  let Ok(_guard) = RAYFIN_AUTH_ACTION.try_lock() else {
    return auth_failure("fabric-login", None, "A Fabric sign-in, sign-out, or credential refresh is already in progress.".into());
  };
  let project_dir = match rayfin_project_dir(project_id.as_deref()) {
    Ok(dir) => dir,
    Err(error) => return auth_failure("fabric-login", None, error),
  };
  let on_data = proc_streamer(&app, "login:rayfin");
  let _access = RAYFIN_AUTH_USE.write().await;
  login_rayfin(project_dir.as_deref(), tenant, on_data).await
}

async fn login_rayfin(project_dir: Option<&Path>, tenant: Option<String>, on_data: OnData) -> ProcResult {
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
    project_dir,
    &arg_refs,
    RunOptions {
      on_data: Some(on_data.clone()),
      timeout_ms: Some(5 * 60_000),
      ..Default::default()
    },
  )
  .await;
  if res.ok {
    on_data(exec::Stream::System, "Verifying the refreshed credential against Fabric...\n");
    let auth = get_rayfin_auth_for(project_dir).await;
    if auth.signed_in {
      telemetry::track_signin(cached_identity().as_ref(), "login");
      on_data(exec::Stream::System, "Fabric authentication verified.\n");
    }
    let result = verified_login("fabric-login", "Fabric", &res, auth.signed_in, auth.error);
    if let Some(error) = &result.error {
      on_data(exec::Stream::Stderr, &format!("{error}\n"));
    }
    return result;
  }
  // Surface *why* sign-in failed: return a user-facing detail and record the
  // full CLI output to the crash log so it lands in the diagnostics bundle's
  // "Recent crash / hang log" section. Previously this was silently swallowed
  // (issue #17), so a failed sign-in looked like the button did nothing.
  let detail = login_failure_detail(&res);
  on_data(exec::Stream::Stderr, &format!("{detail}\n"));
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
pub async fn auth_refresh_rayfin(app: AppHandle, project_id: String, tenant: Option<String>) -> ProcResult {
  let Ok(_guard) = RAYFIN_AUTH_ACTION.try_lock() else {
    return auth_failure("fabric-refresh", None, "A Fabric sign-in, sign-out, or credential refresh is already in progress.".into());
  };
  let Some(project) = store::find_project(&project_id) else {
    return auth_failure("fabric-refresh", None, "Project not found.".into());
  };
  let on_data = proc_streamer(&app, "refresh:rayfin");
  on_data(exec::Stream::System, "Waiting for current Fabric operations to finish before refreshing credentials...\n");
  let _access = RAYFIN_AUTH_USE.write().await;
  refresh_rayfin(Path::new(&project.path), tenant, on_data).await
}

async fn refresh_rayfin(project_dir: &Path, tenant: Option<String>, on_data: OnData) -> ProcResult {
  // Resolve/install the pinned CLI before discarding any shared credentials.
  if let Err(error) = exec::ensure_project_dependencies(project_dir, Some(on_data.clone())).await {
    on_data(exec::Stream::Stderr, &format!("{error}\n"));
    return auth_failure("fabric-refresh", None, error);
  }
  on_data(exec::Stream::System, "Clearing the shared Fabric / Rayfin credentials with rayfin logout...\n");
  let res = run_rayfin(
    Some(project_dir),
    &["logout"],
    RunOptions {
      on_data: Some(on_data.clone()),
      timeout_ms: Some(60_000),
      ..Default::default()
    },
  )
  .await;
  if !res.ok {
    let error = cli_failure_detail(
      &res,
      "Fabric credential reset",
      "Nothing was retried. Update this project's Rayfin CLI and SDK to 1.35.1 or newer, then try refreshing again.",
    );
    on_data(exec::Stream::Stderr, &format!("{error}\n"));
    return auth_failure("fabric-refresh", res.exit_code, error);
  }
  set_identity(None);
  login_rayfin(Some(project_dir), tenant, on_data).await
}

#[tauri::command]
pub async fn auth_login_az(app: AppHandle) -> ProcResult {
  let Ok(_guard) = AZ_AUTH_ACTION.try_lock() else {
    return auth_failure("azure-login", None, "An Azure sign-in or sign-out is already in progress.".into());
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
pub async fn auth_logout_az(app: AppHandle) -> ProcResult {
  let Ok(_guard) = AZ_AUTH_ACTION.try_lock() else {
    return auth_failure("azure-logout", None, "An Azure sign-in or sign-out is already in progress.".into());
  };
  let on_data = proc_streamer(&app, "logout:az");
  on_data(exec::Stream::Stdout, "Signing out of Azure...\n");
  let res = exec::run(
    "az",
    &["logout"],
    RunOptions {
      on_data: Some(on_data.clone()),
      timeout_ms: Some(60_000),
      ..Default::default()
    },
  )
  .await;
  if !res.ok {
    return auth_failure(
      "azure-logout",
      res.exit_code,
      cli_failure_detail(&res, "Azure sign-out", "Try signing out again."),
    );
  }
  let accounts = exec::run(
    "az",
    &["account", "list", "--output", "json"],
    RunOptions::timeout(30_000),
  )
  .await;
  if let Err(error) = verify_azure_signed_out(&accounts) {
    return auth_failure("azure-logout", res.exit_code, error);
  }
  on_data(exec::Stream::Stdout, "Signed out of Azure.\n");
  ProcResult { ok: true, exit_code: res.exit_code, error: None }
}

fn verify_azure_signed_out(accounts: &exec::RunResult) -> Result<(), String> {
  if !accounts.ok {
    return Err(cli_failure_detail(
      accounts,
      "Azure sign-out verification",
      "Re-check your account status or try signing out again.",
    ));
  }
  let accounts: Vec<serde_json::Value> = serde_json::from_str(&accounts.stdout)
    .map_err(|_| "Azure returned an invalid account list after sign-out. Re-check your account status.".to_string())?;
  if !accounts.is_empty() {
    return Err("Azure still has signed-in accounts. Try signing out again.".into());
  }
  Ok(())
}

#[tauri::command]
pub async fn auth_logout_rayfin(app: AppHandle) -> ProcResult {
  let Ok(_guard) = RAYFIN_AUTH_ACTION.try_lock() else {
    return auth_failure("fabric-logout", None, "A Fabric sign-in, sign-out, or credential refresh is already in progress.".into());
  };
  let project_dir = store::active_project().map(|p| PathBuf::from(p.path));
  let on_data = proc_streamer(&app, "logout:rayfin");
  let _access = RAYFIN_AUTH_USE.write().await;
  let res = run_rayfin(
    project_dir.as_deref(),
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

  struct RayfinFixture(PathBuf);

  impl RayfinFixture {
    fn new(logout_exit: i32, login_exit: i32) -> Self {
      let fixture = Self(std::env::temp_dir().join(format!("fabricator-auth-{}", uuid::Uuid::new_v4())));
      let cli = fixture.0.join("node_modules").join("@microsoft").join("rayfin-cli");
      std::fs::create_dir_all(cli.join("scripts")).unwrap();
      std::fs::create_dir_all(cli.join("dist").join("auth")).unwrap();
      std::fs::write(cli.join("dist").join("auth").join("index.js"), "").unwrap();
      std::fs::write(cli.join("scripts").join("main.js"), r#"
const fs = require('node:fs');
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync('fixture.json', 'utf8'));
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\n');
if (args[0] === 'logout') {
  if (config.logoutExit) console.error('Error: token-cache lock is still held by a live process');
  else console.warn('Removed a stale token-cache lock left by an interrupted sign-in');
  process.exit(config.logoutExit);
}
if (args[1] === 'status') {
  console.log('Not signed in');
  process.exit(0);
}
if (config.loginExit) console.error('Login failed: sign-in cancelled');
process.exit(config.loginExit);
"#).unwrap();
      std::fs::write(
        fixture.0.join("fixture.json"),
        serde_json::json!({ "logoutExit": logout_exit, "loginExit": login_exit }).to_string(),
      ).unwrap();
      fixture
    }

    fn calls(&self) -> Vec<Vec<String>> {
      std::fs::read_to_string(self.0.join("calls.jsonl")).unwrap()
        .lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }
  }

  impl Drop for RayfinFixture {
    fn drop(&mut self) {
      if let Err(error) = std::fs::remove_dir_all(&self.0) {
        eprintln!("Could not remove auth fixture {}: {error}", self.0.display());
      }
    }
  }

  #[tokio::test]
  async fn refresh_stops_before_login_when_logout_fails() {
    let fixture = RayfinFixture::new(1, 0);
    let result = refresh_rayfin(&fixture.0, None, std::sync::Arc::new(|_, _| {})).await;
    assert!(!result.ok);
    assert!(result.error.unwrap().contains("token-cache lock"));
    assert_eq!(fixture.calls(), vec![vec!["logout"]]);
  }

  #[tokio::test]
  async fn refresh_logs_cache_cleanup_and_preserves_the_requested_tenant() {
    let fixture = RayfinFixture::new(0, 1);
    let log = std::sync::Arc::new(Mutex::new(String::new()));
    let capture = log.clone();
    let result = refresh_rayfin(
      &fixture.0,
      Some("tenant-one".into()),
      std::sync::Arc::new(move |_, chunk| capture.lock().unwrap().push_str(chunk)),
    ).await;
    assert!(!result.ok);
    assert!(result.error.unwrap().contains("sign-in cancelled"));
    assert_eq!(fixture.calls(), vec![vec!["logout"], vec!["login", "--select", "--tenant", "tenant-one"]]);
    let log = log.lock().unwrap();
    assert!(log.contains("Removed a stale token-cache lock"));
    assert!(log.contains("Login failed"));
  }

  #[tokio::test]
  async fn refresh_does_not_report_success_from_the_login_exit_code_alone() {
    let fixture = RayfinFixture::new(0, 0);
    let result = refresh_rayfin(&fixture.0, None, std::sync::Arc::new(|_, _| {})).await;
    assert!(!result.ok);
    assert!(result.error.unwrap().contains("authentication could not be verified"));
    assert_eq!(fixture.calls(), vec![vec!["logout"], vec!["login", "--select"], vec!["login", "status"]]);
  }

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
  fn copilot_login_pins_the_normalized_host_before_requesting_a_code() {
    assert_eq!(copilot_login_args(None).unwrap(), ["login", "--host", "https://github.com"]);
    for (input, expected) in [
      ("github.com", "https://github.com"),
      (" https://GitHub.com/ ", "https://github.com"),
      ("company.ghe.com", "https://company.ghe.com"),
      ("https://Company.GHE.com/", "https://company.ghe.com"),
      ("my-company.ghe.com", "https://my-company.ghe.com"),
    ] {
      assert_eq!(copilot_login_args(Some(input)).unwrap(), ["login", "--host", expected]);
    }
  }

  #[test]
  fn copilot_login_rejects_invalid_or_unsupported_hosts() {
    for host in [
      "", " ", "ghe.com", "git.company.com", "http://company.ghe.com",
      "https://company.ghe.com/login/device", "company.ghe.com?query=1",
      "company.ghe.com#fragment", "https://user:secret@company.ghe.com",
      "https://company.ghe.com:8443", "company.ghe.com.attacker.example",
      "https://github.com@attacker.example", "--host=company.ghe.com",
      "company_name.ghe.com", "-company.ghe.com", "company-.ghe.com",
      "company..ghe.com", "https://company.ghe.com\\login\\device", "company\n.ghe.com",
    ] {
      assert!(copilot_login_args(Some(host)).is_err(), "{host}");
    }
  }

  #[test]
  fn copilot_login_verification_cannot_succeed_on_the_wrong_host() {
    let mut auth = CopilotAuthStatus {
      signed_in: true,
      host: Some("https://Company.GHE.com/".into()),
      ..Default::default()
    };
    assert!(copilot_host_error("https://company.ghe.com", &auth).is_none());
    auth.host = Some("https://github.com".into());
    assert!(copilot_host_error("https://company.ghe.com", &auth).unwrap().contains("GH_TOKEN"));
    auth.host = None;
    assert!(copilot_host_error("https://company.ghe.com", &auth).is_some());
    auth.signed_in = false;
    assert!(copilot_host_error("https://company.ghe.com", &auth).is_none());
  }

  #[test]
  fn azure_logout_requires_a_successful_empty_account_list() {
    let mut empty = res(Some(0), false, "[]", "");
    assert!(verify_azure_signed_out(&empty).is_err());
    empty.ok = true;
    assert!(verify_azure_signed_out(&empty).is_ok());
    for stdout in ["", "not json", "{}", "null", r#"[{"user":{"name":"still-signed-in"}}]"#] {
      let mut result = res(Some(0), false, stdout, "");
      result.ok = true;
      assert!(verify_azure_signed_out(&result).is_err(), "{stdout}");
    }
    assert!(verify_azure_signed_out(&res(None, false, "", "")).unwrap_err().contains("timed out"));
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
