//! Deploy engine: Studio owns the deploy loop (`rayfin up`), the chat agent edits
//! code only. Faithful Rust port of `src/main/services/deploy.ts`.
//!
//! Uses the project's pinned Rayfin CLI (the `npx rayfin` equivalent) via
//! [`exec::run_project_rayfin`]. `rayfin up` runs in human mode (streamed to the
//! UI on the `deploy:run` channel) and the canonical URL is read back from the
//! deployment registry it keeps (`rayfin/.deployments.json`), or from
//! `rayfin up status --json` when that can't say. Preview URL priority:
//! hostingUrl → apiUrl → portalUrl.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::commands::auth::get_cached_identity;
use crate::commands::util::{annotate_state, now_iso};
use crate::services::exec::{self, OnData, RunOptions, RunResult, Stream};
use crate::services::{crashlog, emit, fabric_auth, git, journal, store, telemetry, version_history};
use crate::types::{
  DeployInfo, DeployResult, DeployStatus, FabricDeployment, PendingChanges, ProjectsState, StudioProject,
};

const DEPLOY_TIMEOUT_MS: u64 = 20 * 60_000;
const SETTINGS_PUSH_TIMEOUT_MS: u64 = 10 * 60_000;
const DEPLOY_CHANNEL: &str = "deploy:run";

static GUID_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap());
static HOSTING_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)Hosting URL:\s*(\S+)").unwrap());
static NOT_SIGNED_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)\bunauthorized\b|\bHTTP[:\s]+401\b|\bfailed to authenticate\b|\bauthentication (?:failed|required)\b").unwrap());
static CACHE_ERROR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(
  r"(?i)CrossPlatformLockError|(?:could not|cannot|unable to) acquire (?:the )?token[- ]cache lock|not able to acquire lock|(?:corrupt|unreadable) (?:local )?(?:token|credential)[- ]cache|token cache could not be read"
).unwrap());
static NEEDS_WS_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)no workspace targeting context|pass --workspace").unwrap());
static ERROR_LINE_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)\berror(?:\s+(?:[a-z]+\d+|\[[^\]]+\]))?\s*:|\b[a-z_]+error\b|\b(?:failed|exception)\s*:|\bAADSTS\d+\b|could not acquire|not able to acquire lock").unwrap());
static GENERIC_FAILURE_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)^[^a-z0-9]*(?:deploy(?:ment)? failed|error)\s*[:.!]?\s*$").unwrap());

/* ------------------------------ helpers ----------------------------------- */

/// Map a user-supplied workspace target to the right `rayfin up` flag.
fn workspace_args(workspace: Option<&str>) -> Vec<String> {
  let Some(w) = workspace.map(str::trim).filter(|w| !w.is_empty()) else {
    return vec![];
  };
  if w.starts_with("http://") || w.starts_with("https://") {
    vec!["--workspace-uri".into(), w.to_string()]
  } else if GUID_RE.is_match(w) {
    vec!["--workspace-id".into(), w.to_string()]
  } else {
    vec!["-w".into(), w.to_string()]
  }
}

/// Pull a `Hosting URL:` value out of human deploy output.
fn scrape_hosting_url(text: &str) -> Option<String> {
  HOSTING_RE.captures(text).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string())
}

/// `rayfin up` arguments that push runtime settings (auth redirect URIs
/// included) and the data model, but don't build or upload the app.
fn settings_push_args(workspace: Option<&str>) -> Vec<String> {
  let mut args: Vec<String> =
    ["up", "-y", "--force", "--exclude-services", "staticHosting"].into_iter().map(String::from).collect();
  args.extend(workspace_args(workspace));
  args
}

/// Best URL to load in the preview, in priority order.
fn pick_preview_url(hosting: Option<&str>, api: Option<&str>, portal: Option<&str>) -> Option<String> {
  hosting.or(api).or(portal).map(|s| s.to_string())
}

/// Join the last `n` non-empty lines of `text` with single spaces.
fn last_lines(text: &str, n: usize) -> String {
  let lines: Vec<&str> = text.trim().lines().filter(|line| !line.trim().is_empty()).collect();
  let start = lines.len().saturating_sub(n);
  lines[start..].join(" ")
}

/// Prefer the actual failure over npm warnings or a trailing "Deployment failed".
fn error_text(result: &RunResult, capture: &str, fallback: &str) -> String {
  let output = if capture.trim().is_empty() {
    format!("{}\n{}", result.stdout, result.stderr)
  } else {
    capture.to_string()
  };
  let failure = output.lines().rev().map(str::trim).find(|line| {
    ERROR_LINE_RE.is_match(line) && !GENERIC_FAILURE_RE.is_match(line)
  });
  let primary = if let Some(failure) = failure {
    failure.to_string()
  } else if output.lines().any(|line| GENERIC_FAILURE_RE.is_match(line.trim())) {
    fallback.to_string()
  } else if !result.stderr.trim().is_empty() {
    result.stderr.trim().to_string()
  } else {
    last_lines(&output, 3)
  };
  let sliced: String = primary.chars().take(500).collect();
  if sliced.trim().is_empty() {
    fallback.to_string()
  } else {
    sliced
  }
}

fn failure_outcome(error: &str) -> &'static str {
  if NEEDS_WS_RE.is_match(error) {
    "needs-workspace"
  } else if CACHE_ERROR_RE.is_match(error) {
    "auth-cache-error"
  } else if fabric_auth::failure_flags(error).0 || NOT_SIGNED_RE.is_match(error) {
    "not-signed-in"
  } else {
    "error"
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusDeployment {
  rayfin_api_url: Option<String>,
  fabric_portal_url: Option<String>,
}

#[derive(Deserialize)]
struct StatusJson {
  #[serde(default)]
  deployed: bool,
  #[serde(default)]
  deployment: Option<StatusDeployment>,
}

/// Parse the (possibly noisy) stdout of `rayfin up status --json` — the last line
/// that parses as a status object wins.
fn parse_status_json(stdout: &str) -> Option<StatusJson> {
  for line in stdout.lines().filter(|l| !l.trim().is_empty()).rev() {
    if let Ok(parsed) = serde_json::from_str::<StatusJson>(line.trim()) {
      return Some(parsed);
    }
  }
  None
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDeployment {
  workspace_name: Option<String>,
  #[serde(default)]
  active: bool,
  workspace_id: Option<String>,
  item_id: Option<String>,
  api_url: Option<String>,
  hosting_url: Option<String>,
  deployed_at: Option<String>,
}

/// The friendly name Fabricator keeps for a deployment, by workspace id, then by
/// the (sanitized) workspace name Rayfin records it under.
fn friendly_name(
  names: &std::collections::HashMap<String, String>,
  workspace_id: Option<&str>,
  workspace_name: Option<&str>,
) -> Option<String> {
  workspace_id.and_then(|id| names.get(id)).or_else(|| workspace_name.and_then(|n| names.get(n))).cloned()
}

/// Parse `rayfin up list --json`, distinguishing "no parseable array" (`None`)
/// from a successfully parsed list that may be empty (`Some(vec)`). The last line
/// that parses as an array wins. Reconcile uses the `None` vs `Some` distinction
/// to tell a failed/garbled query apart from "no deployments on disk".
fn parse_deploy_list_opt(
  stdout: &str,
  names: &std::collections::HashMap<String, String>,
) -> Option<Vec<FabricDeployment>> {
  for line in stdout.lines().filter(|l| !l.trim().is_empty()).rev() {
    if let Ok(list) = serde_json::from_str::<Vec<RawDeployment>>(line.trim()) {
      return Some(
        list
          .into_iter()
          .map(|d| {
            let name = friendly_name(names, d.workspace_id.as_deref(), d.workspace_name.as_deref());
            FabricDeployment {
              workspace_name: d.workspace_name.unwrap_or_else(|| "(unknown)".to_string()),
              name,
              active: d.active,
              workspace_id: d.workspace_id,
              item_id: d.item_id,
              api_url: d.api_url,
              hosting_url: d.hosting_url,
              deployed_at: d.deployed_at,
            }
          })
          .collect(),
      );
    }
  }
  None
}

/// Parse `rayfin up list --json` (last line that parses as an array wins).
#[cfg(test)]
fn parse_deploy_list(stdout: &str, names: &std::collections::HashMap<String, String>) -> Vec<FabricDeployment> {
  parse_deploy_list_opt(stdout, names).unwrap_or_default()
}

/* ------------------------- the deployment registry ------------------------- */

/// One deployment in `rayfin/.deployments.json`, the registry `rayfin up` keeps.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RegistryEntry {
  fabric_item_id: Option<String>,
  fabric_api_url: Option<String>,
  fabric_workspace_id: Option<String>,
  hosting_url: Option<String>,
  /// The app in the Fabric portal: what `rayfin up status` reports as `fabricPortalUrl`.
  fabric_deep_link: Option<String>,
  deployed_at: Option<String>,
}

/// A deployment the registry records, under its (sanitized) workspace name.
struct Recorded {
  workspace: String,
  active: bool,
  entry: RegistryEntry,
}

fn filled(value: Option<String>) -> Option<String> {
  value.filter(|v| !v.trim().is_empty())
}

/// Read a project's deployments the way `rayfin up list` does, which is a plain
/// read of `rayfin/.deployments.json`, without starting the CLI: that takes a few
/// seconds (far more on a cold start), and the deployments panel and every
/// project open ask. Entries without an item and a workspace are the placeholders
/// `rayfin init` leaves, and are skipped, as the CLI skips them. `None` when
/// there's no registry or it can't be read: callers then ask the CLI, which also
/// knows older projects' records.
fn read_registry(dir: &Path) -> Option<Vec<Recorded>> {
  let text = std::fs::read_to_string(dir.join("rayfin").join(".deployments.json")).ok()?;
  let json: serde_json::Value = serde_json::from_str(&text).ok()?;
  let all = json.get("deployments")?.as_object()?;
  let active = json.get("active").and_then(serde_json::Value::as_str);
  Some(
    all
      .iter()
      .filter_map(|(workspace, value)| {
        let entry = serde_json::from_value::<RegistryEntry>(value.clone()).ok()?;
        let recorded = filled(entry.fabric_item_id.clone()).is_some() && filled(entry.fabric_workspace_id.clone()).is_some();
        recorded.then(|| Recorded { active: active == Some(workspace.as_str()), workspace: workspace.clone(), entry })
      })
      .collect(),
  )
}

/// The registry's deployments, as `rayfin up list --json` reports them.
fn registry_deployments(dir: &Path, names: &std::collections::HashMap<String, String>) -> Option<Vec<FabricDeployment>> {
  let list = read_registry(dir)?;
  Some(
    list
      .into_iter()
      .map(|r| FabricDeployment {
        name: friendly_name(names, r.entry.fabric_workspace_id.as_deref(), Some(&r.workspace)),
        workspace_name: r.workspace,
        active: r.active,
        workspace_id: r.entry.fabric_workspace_id,
        item_id: r.entry.fabric_item_id,
        api_url: filled(r.entry.fabric_api_url),
        hosting_url: filled(r.entry.hosting_url),
        deployed_at: r.entry.deployed_at,
      })
      .collect(),
  )
}

/// Where the active deployment lives.
struct ActiveDeployment {
  workspace_id: Option<String>,
  workspace_name: String,
  hosting: Option<String>,
  api: Option<String>,
  portal: Option<String>,
}

/// The active deployment as the registry records it: the addresses
/// `rayfin up status --json` reports, without its network checks (about 6 s).
/// `Some(None)` when the registry has no active deployment; `None` when there's
/// no registry to read.
fn registry_active(dir: &Path) -> Option<Option<ActiveDeployment>> {
  let list = read_registry(dir)?;
  Some(list.into_iter().find(|r| r.active).map(|r| ActiveDeployment {
    workspace_id: r.entry.fabric_workspace_id,
    workspace_name: r.workspace,
    hosting: filled(r.entry.hosting_url),
    api: filled(r.entry.fabric_api_url),
    portal: filled(r.entry.fabric_deep_link),
  }))
}

/// Apply a patch to the project's deploy record (explicit field clears honored).
fn patch_deploy(project_id: &str, f: impl FnOnce(&mut DeployInfo)) {
  store::mutate_project(project_id, |p| {
    let mut deploy = p.last_deploy.take().unwrap_or_default();
    f(&mut deploy);
    p.last_deploy = Some(deploy);
  });
}

fn git_opts(dir: &str, ms: u64) -> RunOptions {
  RunOptions {
    cwd: Some(PathBuf::from(dir)),
    timeout_ms: Some(ms),
    ..Default::default()
  }
}

/// Commit the current working tree as a deploy checkpoint (best-effort).
async fn commit_checkpoint(dir: &str, message: &str) {
  let status = git::run(&["status", "--porcelain"], git_opts(dir, 30_000)).await;
  if !status.ok || status.stdout.trim().is_empty() {
    return;
  }
  let _ = git::run(&["add", "-A"], git_opts(dir, 30_000)).await;
  let _ = git::run(&["commit", "-m", message], git_opts(dir, 30_000)).await;
}

/// Resolve the project's current HEAD commit sha (None when unavailable).
async fn head_sha(dir: &str) -> Option<String> {
  let res = git::run(&["rev-parse", "HEAD"], git_opts(dir, 30_000)).await;
  if res.ok {
    let sha = res.stdout.trim().to_string();
    if sha.is_empty() {
      None
    } else {
      Some(sha)
    }
  } else {
    None
  }
}

async fn has_changes_since_deploy(dir: &str, deployed_commit: Option<&str>) -> Result<bool, String> {
  let status = git::run(
    &["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
    git_opts(dir, 30_000),
  )
  .await;
  if !status.ok {
    return Err(format!(
      "Could not check for undeployed changes. {}",
      error_text(&status, &status.stdout, "git status failed.")
    ));
  }
  if !status.stdout.trim().is_empty() {
    return Ok(true);
  }

  // A clean working tree can still contain committed edits that were never
  // deployed. Without a recorded baseline, deploy once to establish one.
  let Some(commit) = deployed_commit.map(str::trim).filter(|s| !s.is_empty()) else {
    return Ok(true);
  };
  let diff = git::run(
    &["diff", "--quiet", "--no-ext-diff", "--ignore-submodules=none", commit, "HEAD", "--"],
    git_opts(dir, 30_000),
  )
  .await;
  match diff.exit_code {
    Some(0) if diff.ok => Ok(false),
    Some(1) if !diff.not_found => Ok(true),
    _ => Err(format!(
      "Could not compare the project with its last deployment. {}",
      error_text(&diff, &diff.stdout, "git diff failed.")
    )),
  }
}

/// The paths a `git status --porcelain=v1 -z` listing is about: NUL-separated,
/// never quoted, with a rename or copy's original path after its new one (skipped).
fn porcelain_paths(stdout: &str) -> Vec<String> {
  let mut paths = Vec::new();
  let mut records = stdout.split('\0').filter(|record| !record.is_empty());
  while let Some(record) = records.next() {
    let (Some(status), Some(path)) = (record.get(..2), record.get(3..)) else {
      continue;
    };
    if status.contains('R') || status.contains('C') {
      records.next();
    }
    if !path.is_empty() {
      paths.push(path.to_string());
    }
  }
  paths
}

/// What a deploy would ship: every file that differs from the deployed version,
/// edited, staged, new or removed, committed or not. Without a known deployed
/// version something always would (as [`has_changes_since_deploy`] says), but
/// how much isn't known. Both listings are NUL-separated, so a path is spelled
/// the same in each (porcelain output quotes unusual names otherwise).
async fn pending_since_deploy(dir: &str, deployed_commit: Option<&str>) -> Result<PendingChanges, String> {
  let status = git::run(
    &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    git_opts(dir, 30_000),
  )
  .await;
  if !status.ok {
    return Err(format!(
      "Could not check for undeployed changes. {}",
      error_text(&status, &status.stdout, "git status failed.")
    ));
  }
  let mut files: std::collections::BTreeSet<String> = porcelain_paths(&status.stdout).into_iter().collect();
  let Some(commit) = deployed_commit.map(str::trim).filter(|s| !s.is_empty()) else {
    return Ok(PendingChanges { changed: true, files: None });
  };
  let diff = git::run(
    &["diff", "--name-only", "-z", "--no-ext-diff", "--ignore-submodules=none", commit, "HEAD", "--"],
    git_opts(dir, 30_000),
  )
  .await;
  if !diff.ok {
    return Err(format!(
      "Could not compare the project with its last deployment. {}",
      error_text(&diff, &diff.stdout, "git diff failed.")
    ));
  }
  files.extend(diff.stdout.split('\0').filter(|path| !path.is_empty()).map(String::from));
  Ok(PendingChanges { changed: !files.is_empty(), files: Some(files.len() as u32) })
}

/// Read the persisted deployment status for a project directory.
async fn status_for(path: &str) -> DeployStatus {
  let res = exec::run_project_rayfin(Path::new(path), &["up", "status", "--json"], RunOptions::timeout(60_000)).await;
  let Some(parsed) = parse_status_json(&res.stdout) else {
    return DeployStatus { deployed: false, url: None, api_url: None, portal_url: None };
  };
  if !parsed.deployed {
    return DeployStatus { deployed: false, url: None, api_url: None, portal_url: None };
  }
  let api = parsed.deployment.as_ref().and_then(|d| d.rayfin_api_url.clone());
  let portal = parsed.deployment.as_ref().and_then(|d| d.fabric_portal_url.clone());
  DeployStatus {
    deployed: true,
    url: pick_preview_url(None, api.as_deref(), portal.as_deref()),
    api_url: api,
    portal_url: portal,
  }
}

/// One-time Fabric-preview default applied after a successful deploy. Semantic-model
/// apps only render correctly inside the Fabric portal shell, so the first deploy that
/// carries a `fabric.yaml` semantic-model connection switches the preview to the
/// embedded Fabric view — but only if the user hasn't already picked a view, and only
/// once, so a later manual switch back to the direct view (persisted as `None`) is
/// never re-overridden on subsequent (often after-turn) auto-deploys. Returns
/// `Some(new_preview_mode)` to persist (marking the project defaulted), or `None` to
/// leave the project untouched.
fn fabric_preview_after_deploy(
  preview_mode: Option<&str>,
  already_defaulted: bool,
  has_semantic_models: bool,
) -> Option<Option<String>> {
  if already_defaulted || !has_semantic_models {
    return None;
  }
  // Adopt the Fabric view when the user hasn't chosen one; otherwise keep their
  // choice. Either way the caller records that the default has now been applied.
  Some(match preview_mode {
    None => Some("fabric".to_string()),
    Some(mode) => Some(mode.to_string()),
  })
}

/* ------------------------------ commands ---------------------------------- */

#[tauri::command]
pub async fn deploy_run(
  app: AppHandle,
  project_id: String,
  workspace: Option<String>,
) -> DeployResult {
  // Keep ownership attached to actual process completion, not to the invoking
  // renderer's lifetime.
  match tokio::spawn(async move { run_deploy(app, project_id, workspace).await }).await {
    Ok(result) => result,
    Err(error) => deployment_error(format!("Deployment task failed: {error}")),
  }
}

/// Core deploy routine shared by the [`deploy_run`] command and Fabricator's
/// after-turn auto-deploy. Runs `rayfin up` (streamed to the
/// `deploy:run` UI channel), records the outcome in the store, and returns the
/// resolved live URL on success. Holds the project's mutation lease for the
/// whole run so a chat turn can't edit source mid-deploy.
pub(crate) async fn run_deploy(
  app: AppHandle,
  project_id: String,
  workspace: Option<String>,
) -> DeployResult {
  // Team projects are deployed by their workspace's pipeline, never from here
  // (enforced whether or not the experiment is on).
  if crate::services::team::is_team_project_id(&project_id) {
    return deployment_error(crate::services::team::NO_LOCAL_DEPLOY.into());
  }
  let state = app.state::<crate::state::AppState>();
  let _lease = match state.mutations.deploy(&project_id) {
    Ok(lease) => lease,
    Err(error) => return deployment_error(error),
  };
  let mut detail = None;
  let result = run_deploy_inner(app.clone(), project_id.clone(), workspace, &mut detail).await;
  record_deploy(&project_id, &result, detail);
  result
}

/// How much of a failed run's output the journal keeps: enough for the step it
/// was on and the CLI's own account of the failure.
const FAILURE_DETAIL_LINES: usize = 16;

/// The end of a failed run's output, as the journal's detail.
///
/// The error the UI shows is one line, and often only the headline — "Runtime
/// settings sync failed: 400 Bad Request" — while the line that explains it
/// ("Details: The PostgreSQLDatabase feature is not enabled.") comes after.
/// Help reads the journal to answer "why did my deploy fail?", so it needs both.
fn failure_detail(output: &str) -> Option<String> {
  let clean = crate::commands::chat_tools::strip_ansi(output);
  let lines: Vec<&str> = clean.lines().map(str::trim_end).filter(|line| !line.trim().is_empty()).collect();
  if lines.is_empty() {
    return None;
  }
  Some(lines[lines.len().saturating_sub(FAILURE_DETAIL_LINES)..].join("\n"))
}

/// Note the outcome of a deploy in the activity journal.
///
/// Both outcomes are recorded. "Did my deploy work?" is one of the most common
/// questions the Help assistant is asked, and a journal that only ever noted
/// failures would answer a successful deploy with the last one that went wrong.
fn record_deploy(project_id: &str, result: &DeployResult, detail: Option<String>) {
  use journal::{Area, Level};
  let message = if result.ok {
    match result.url.as_deref() {
      Some(url) => format!("Deployed successfully. The app is live at {url}"),
      None => "Deployed successfully.".to_string(),
    }
  } else {
    result.error.clone().unwrap_or_else(|| "The deploy failed.".to_string())
  };
  let mut entry = journal::entry(
    if result.ok { Level::Info } else { Level::Error },
    Area::Deploy,
    if result.ok { "deploy.succeeded" } else { "deploy.failed" },
    &message,
  )
  .operation(format!("deploy_run:{}", result.outcome))
  .project(Some(project_id.to_string()));
  if !result.ok {
    entry = entry.surface(journal::Surface::Backend).detail(detail);
  }
  entry.write();
}

fn deployment_error(error: String) -> DeployResult {
  DeployResult { ok: false, outcome: "error".into(), url: None, api_url: None, portal_url: None, error: Some(error) }
}

/// Push rayfin.yml's runtime settings to the project's Fabric backend without
/// rebuilding or uploading the app (`rayfin up --exclude-services staticHosting`).
/// The caller holds the project's deploy lease. The recorded deployment (URL,
/// status, deployed commit) is left alone, so the app itself still ships with
/// the next regular deploy.
pub(crate) async fn push_runtime_settings(project: &StudioProject, on_data: OnData) -> DeployResult {
  if crate::services::team::is_team_project(project) {
    return deployment_error(crate::services::team::NO_LOCAL_DEPLOY.into());
  }
  let dir = Path::new(&project.path);
  if let Err(error) = exec::ensure_project_dependencies(dir, Some(on_data.clone())).await {
    return deployment_error(error);
  }
  let _auth_guard = crate::commands::auth::rayfin_auth_read().await;
  let captured = Arc::new(Mutex::new(String::new()));
  let on_output: OnData = {
    let captured = captured.clone();
    Arc::new(move |stream: Stream, chunk: &str| {
      captured.lock().unwrap().push_str(chunk);
      on_data(stream, chunk);
    })
  };
  let workspace = project.workspace.as_deref().map(str::trim).filter(|w| !w.is_empty());
  let args = settings_push_args(workspace);
  let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
  let result = exec::run_project_rayfin(
    dir,
    &arg_refs,
    RunOptions {
      cwd: Some(dir.to_path_buf()),
      on_data: Some(on_output),
      timeout_ms: Some(SETTINGS_PUSH_TIMEOUT_MS),
      ..Default::default()
    },
  )
  .await;
  if result.ok {
    return DeployResult { ok: true, outcome: "success".into(), url: None, api_url: None, portal_url: None, error: None };
  }
  let captured_text = captured.lock().unwrap().clone();
  let error = error_text(&result, &captured_text, "rayfin up couldn't push the sign-in settings. Check the log above.");
  let outcome = if result.not_found { "not-found" } else { failure_outcome(&error) };
  crashlog::log_error("settings-push", &format!("exit={:?} outcome={outcome}: {error}", result.exit_code));
  DeployResult { ok: false, outcome: outcome.into(), url: None, api_url: None, portal_url: None, error: Some(error) }
}

async fn run_deploy_inner(
  app: AppHandle,
  project_id: String,
  workspace: Option<String>,
  detail: &mut Option<String>,
) -> DeployResult {
  let Some(project) = store::find_project(&project_id) else {
    return DeployResult {
      ok: false,
      outcome: "not-found".into(),
      url: None,
      api_url: None,
      portal_url: None,
      error: Some("Project not found.".into()),
    };
  };

  // Explicit target wins; otherwise reuse the workspace the user picked before.
  let explicit = workspace.as_deref().map(str::trim).filter(|w| !w.is_empty()).map(|w| w.to_string());
  let workspace_target = explicit.clone().or_else(|| {
    project.workspace.as_deref().map(str::trim).filter(|w| !w.is_empty()).map(|w| w.to_string())
  });
  if let Some(w) = explicit {
    store::mutate_project(&project_id, move |p| p.workspace = Some(w));
  }

  patch_deploy(&project_id, |d| {
    if workspace_target != project.workspace {
      d.commit = None;
    }
    d.status = Some("deploying".into());
    d.outcome = None;
    d.at = Some(now_iso());
  });

  let renderer = emit::proc_streamer(&app, DEPLOY_CHANNEL);
  renderer(Stream::System, &format!("Deploying {} to Fabric…\n", project.name));

  let captured = Arc::new(Mutex::new(String::new()));
  let on_data: OnData = {
    let captured = captured.clone();
    let renderer = renderer.clone();
    Arc::new(move |stream: Stream, chunk: &str| {
      captured.lock().unwrap().push_str(chunk);
      renderer(stream, chunk);
    })
  };

  if let Err(error) =
    exec::ensure_project_dependencies(Path::new(&project.path), Some(on_data.clone())).await
  {
    *detail = failure_detail(&captured.lock().unwrap());
    patch_deploy(&project_id, |d| {
      d.status = Some("error".into());
      d.outcome = Some("error".into());
      d.error = Some(error.clone());
      d.at = Some(now_iso());
    });
    telemetry::track_deploy(get_cached_identity().as_ref(), false);
    renderer(Stream::System, &format!("\nDeploy failed: {error}\n"));
    return DeployResult {
      ok: false,
      outcome: "error".into(),
      url: None,
      api_url: None,
      portal_url: None,
      error: Some(error),
    };
  }
  // The dependency-recovery output is useful in the live log, but must not be
  // mistaken for `rayfin up` output when classifying a later deploy failure.
  captured.lock().unwrap().clear();
  let _auth_guard = crate::commands::auth::rayfin_auth_read().await;

  // Always force so destructive datamodel/schema changes are applied — a deploy
  // must never leave the published datamodel stale.
  let mut up_args: Vec<String> = vec!["up".into(), "-y".into(), "--force".into()];
  up_args.extend(workspace_args(workspace_target.as_deref()));
  let arg_refs: Vec<&str> = up_args.iter().map(|s| s.as_str()).collect();

  let result = exec::run_project_rayfin(
    Path::new(&project.path),
    &arg_refs,
    RunOptions {
      cwd: Some(PathBuf::from(&project.path)),
      on_data: Some(on_data),
      timeout_ms: Some(DEPLOY_TIMEOUT_MS),
      ..Default::default()
    },
  )
  .await;

  let captured_text = captured.lock().unwrap().clone();
  if !result.ok {
    *detail = failure_detail(&captured_text);
  }

  if result.not_found {
    let error = error_text(&result, &captured_text, "The project's Rayfin CLI could not be started.");
    patch_deploy(&project_id, |d| {
      d.status = Some("error".into());
      d.outcome = Some("not-found".into());
      d.error = Some(error.clone());
      d.at = Some(now_iso());
    });
    renderer(Stream::System, &format!("\nDeploy failed: {error}\n"));
    crashlog::log_error("deploy", &error);
    return DeployResult {
      ok: false,
      outcome: "not-found".into(),
      url: None,
      api_url: None,
      portal_url: None,
      error: Some(error),
    };
  }

  if !result.ok {
    let fallback = format!(
      "rayfin up exited with code {} without a detailed failure reason. View the deploy logs. If Fabric sign-in looks successful but deploys keep failing, use Refresh Fabric authentication and update the project's Rayfin CLI and SDK to 1.35.1 or newer.",
      result.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
    );
    let detail = error_text(&result, &captured_text, &fallback);
    let outcome = failure_outcome(&detail);
    let error = if outcome == "auth-cache-error" {
      format!("{detail} Use Refresh Fabric authentication to clear the CLI credentials and sign in again. This project's Rayfin CLI and SDK should be 1.35.1 or newer.")
    } else {
      detail
    };
    patch_deploy(&project_id, |d| {
      d.status = Some("error".into());
      d.outcome = Some(outcome.into());
      d.error = Some(error.clone());
      d.at = Some(now_iso());
    });
    crashlog::log_error("deploy", &format!("exit={:?} outcome={outcome}: {error}", result.exit_code));
    telemetry::track_deploy(get_cached_identity().as_ref(), false);
    let sys = match outcome {
      "needs-workspace" => "\nThis project has no Fabric workspace yet — choose one to deploy into.\n".to_string(),
      _ => format!("\nDeploy failed: {error}\n"),
    };
    renderer(Stream::System, &sys);
    return DeployResult {
      ok: false,
      outcome: outcome.into(),
      url: None,
      api_url: None,
      portal_url: None,
      error: Some(error),
    };
  }

  // Success: the registry `rayfin up` just wrote has the addresses. `rayfin up
  // status` (about 6 s more) is only asked when it doesn't, or when it records
  // another workspace than the one this deploy targeted.
  let hosting = scrape_hosting_url(&captured_text);
  let recorded = registry_active(Path::new(&project.path)).flatten().filter(|active| {
    active.api.is_some()
      && workspace_target
        .as_deref()
        .filter(|target| GUID_RE.is_match(target))
        .is_none_or(|target| active.workspace_id.as_deref().is_some_and(|id| id.eq_ignore_ascii_case(target)))
  });
  let (api, portal, recorded_hosting) = match recorded {
    Some(active) => (active.api, active.portal, active.hosting),
    None => {
      let status = status_for(&project.path).await;
      (status.api_url, status.portal_url, None)
    }
  };
  let url = pick_preview_url(hosting.as_deref().or(recorded_hosting.as_deref()), api.as_deref(), portal.as_deref());

  {
    let (url, api, portal) = (url.clone(), api.clone(), portal.clone());
    patch_deploy(&project_id, move |d| {
      d.url = url;
      d.api_url = api;
      d.portal_url = portal;
      d.status = Some("success".into());
      d.outcome = Some("success".into());
      d.error = None;
      d.at = Some(now_iso());
    });
  }

  // First successful deploy clears the onboarding "deploy first" gate.
  store::mutate_project(&project_id, |p| p.awaiting_first_deploy = None);

  // Semantic-model apps render correctly only inside the Fabric portal shell, so the
  // first successful deploy that carries a `fabric.yaml` semantic-model connection
  // defaults the preview to the embedded Fabric view (a one-time default; see
  // `fabric_preview_after_deploy`).
  let has_semantic_models =
    !crate::commands::fabric::read_project_semantic_models(Path::new(&project.path)).is_empty();
  store::mutate_project(&project_id, |p| {
    if let Some(mode) = fabric_preview_after_deploy(
      p.preview_mode.as_deref(),
      p.fabric_preview_defaulted == Some(true),
      has_semantic_models,
    ) {
      p.preview_mode = mode;
      p.fabric_preview_defaulted = Some(true);
    }
  });

  // An app opened from disk may not have a repository yet; start its history so
  // this deploy can record which version is live.
  let _ = version_history::ensure_project_tracked(&project).await;
  commit_checkpoint(&project.path, &format!("Deploy {} ({})", project.name, now_iso())).await;
  let commit = head_sha(&project.path).await;
  patch_deploy(&project_id, move |d| d.commit = commit);
  telemetry::track_deploy(get_cached_identity().as_ref(), true);
  let live = url.as_deref().map(|u| format!("Live at {u}")).unwrap_or_default();
  renderer(Stream::System, &format!("\n✅ Deployed. {live}\n"));

  DeployResult {
    ok: true,
    outcome: "success".into(),
    url,
    api_url: api,
    portal_url: portal,
    error: None,
  }
}

#[tauri::command]
pub async fn deploy_status(project_id: String) -> DeployStatus {
  match store::find_project(&project_id) {
    // A team project's deployments live in its pipeline's records.
    Some(project) if crate::services::team::is_team_project(&project) => {
      let deploy = project.last_deploy.unwrap_or_default();
      DeployStatus { deployed: deploy.url.is_some(), url: deploy.url, api_url: deploy.api_url, portal_url: deploy.portal_url }
    }
    Some(project) => status_for(&project.path).await,
    None => DeployStatus { deployed: false, url: None, api_url: None, portal_url: None },
  }
}

#[tauri::command]
pub async fn deploy_has_changes(project_id: String) -> Result<bool, String> {
  let project = store::find_project(&project_id).ok_or_else(|| "Project not found.".to_string())?;
  if crate::services::team::is_team_project(&project) {
    return Ok(false);
  }
  // A folder opened from disk may have no repository yet. Start its version
  // history so the comparison below can tell what changed.
  version_history::ensure_project_tracked(&project).await.map_err(|error| {
    format!("Could not start this app's version history, so Fabricator can't tell what changed. {error}")
  })?;
  let commit = project.last_deploy.as_ref().and_then(|d| d.commit.as_deref());
  has_changes_since_deploy(&project.path, commit).await
}

/// What the next deploy would ship, for the app bar: whether anything differs
/// from the deployed version and, when that version is known, how many files.
/// Read-only: unlike `deploy_has_changes`, it never starts version history.
#[tauri::command]
pub async fn deploy_pending(project_id: String) -> Result<PendingChanges, String> {
  let project = store::find_project(&project_id).ok_or_else(|| "Project not found.".to_string())?;
  if crate::services::team::is_team_project(&project) {
    return Ok(PendingChanges { changed: false, files: Some(0) });
  }
  let commit = project.last_deploy.as_ref().and_then(|d| d.commit.as_deref());
  pending_since_deploy(&project.path, commit).await
}

#[tauri::command]
pub async fn deploy_list(project_id: String) -> Vec<FabricDeployment> {
  if let Some(project) = store::find_project(&project_id) {
    if !crate::services::team::is_team_project(&project) {
      let names = project.deployment_names.clone().unwrap_or_default();
      if let Some(list) = registry_deployments(Path::new(&project.path), &names) {
        return list;
      }
    }
  }
  deploy_list_checked(&project_id).await.unwrap_or_default()
}

/// Destructive callers must distinguish "nothing deployed" from a failed
/// query; an auth/CLI failure must not silently permit deleting the local app.
/// Team projects have no deployments of their own on this computer.
pub(crate) async fn deploy_list_checked(project_id: &str) -> Result<Vec<FabricDeployment>, String> {
  let project = store::find_project(project_id).ok_or_else(|| "Project not found.".to_string())?;
  if crate::services::team::is_team_project(&project) {
    return Ok(vec![]);
  }
  let names = project.deployment_names.clone().unwrap_or_default();
  let res = exec::run_project_rayfin(Path::new(&project.path), &["up", "list", "--json"], RunOptions::timeout(60_000)).await;
  checked_deploy_list(&res, &names)
}

fn checked_deploy_list(
  res: &exec::RunResult,
  names: &std::collections::HashMap<String, String>,
) -> Result<Vec<FabricDeployment>, String> {
  if !res.ok || res.not_found {
    return Err(format!(
      "Could not read recorded Fabric deployments. {}",
      crate::services::fabric_auth::failure_message(res)
    ));
  }
  parse_deploy_list_opt(&res.stdout, names)
    .ok_or_else(|| "Could not read recorded Fabric deployments: invalid CLI response. Nothing was deleted.".into())
}

/// Reconcile the Studio store's recorded deployment with on-disk reality
/// (`rayfin/.deployments.json`, read via `rayfin up list --json`). Treats disk as
/// the source of truth and re-syncs `last_deploy` + `workspace`/`workspace_name`
/// on every open/select so an already-deployed app shows its deployment without a
/// redeploy. Best-effort: only mutates when the query definitively succeeds — a
/// failed/offline query leaves recorded state untouched (never wipes it).
#[tauri::command]
pub async fn deploy_reconcile(project_id: String) -> ProjectsState {
  let Some(project) = store::find_project(&project_id) else {
    return annotate_state(store::get_state());
  };
  // Team projects follow their pipeline's records (see team_status), not local
  // Rayfin deployment files.
  if crate::services::team::is_team_project(&project) {
    return annotate_state(store::get_state());
  }

  // Never disturb an in-flight deploy.
  if project.last_deploy.as_ref().and_then(|d| d.status.as_deref()) == Some("deploying") {
    return annotate_state(store::get_state());
  }

  let names = project.deployment_names.clone().unwrap_or_default();
  let dir = Path::new(&project.path);
  // The registry `rayfin up` keeps is the truth, read straight from disk. Only
  // without one is the CLI asked (its list, then status for the portal link).
  let active = match registry_active(dir) {
    Some(active) => active,
    None => {
      let res = exec::run_project_rayfin(dir, &["up", "list", "--json"], RunOptions::timeout(60_000)).await;
      // A failed or unparseable query is inconclusive (e.g. a CLI error) — leave
      // recorded state as-is rather than wiping a real deployment.
      if res.not_found || !res.ok {
        return annotate_state(store::get_state());
      }
      let Some(list) = parse_deploy_list_opt(&res.stdout, &names) else {
        return annotate_state(store::get_state());
      };
      match list.into_iter().find(|d| d.active) {
        Some(dep) => {
          let status = status_for(&project.path).await;
          Some(ActiveDeployment {
            workspace_id: dep.workspace_id,
            workspace_name: dep.workspace_name,
            hosting: dep.hosting_url,
            api: dep.api_url.or(status.api_url),
            portal: status.portal_url,
          })
        }
        None => None,
      }
    }
  };

  match active {
    Some(dep) => {
      let url = pick_preview_url(dep.hosting.as_deref(), dep.api.as_deref(), dep.portal.as_deref());
      let (api, portal) = (dep.api, dep.portal);
      let ws_name = match dep.workspace_name.as_str() {
        "" | "(unknown)" => None,
        other => Some(other.to_string()),
      };
      let workspace = dep.workspace_id.clone().or_else(|| ws_name.clone());
      store::mutate_project(&project_id, move |p| {
        let mut deploy = p.last_deploy.take().unwrap_or_default();
        if p.workspace != workspace || deploy.url != url {
          deploy.commit = None;
        }
        deploy.url = url;
        deploy.api_url = api;
        deploy.portal_url = portal;
        deploy.status = Some("success".into());
        deploy.outcome = Some("success".into());
        deploy.error = None;
        deploy.at = Some(now_iso());
        // Preserve a known baseline only for the same deployment; `up list`
        // cannot tell us which commit is live at a different target.
        p.last_deploy = Some(deploy);
        p.workspace = workspace;
        p.workspace_name = ws_name;
        // A recorded deployment exists — lift the onboarding gate.
        p.awaiting_first_deploy = None;
      });
    }
    None => {
      // Disk has no active deployment — clear any stale recorded success so the UI
      // matches reality (still never touches an in-flight deploy).
      store::mutate_project(&project_id, |p| {
        if p.last_deploy.as_ref().and_then(|d| d.status.as_deref()) != Some("deploying") {
          p.last_deploy = None;
          p.workspace = None;
          p.workspace_name = None;
        }
      });
    }
  }

  annotate_state(store::get_state())
}

#[tauri::command]
pub async fn deploy_switch(app: AppHandle, project_id: String, workspace: String, by_id: Option<bool>) -> DeployResult {
  if crate::services::team::is_team_project_id(&project_id) {
    return deployment_error(crate::services::team::NO_LOCAL_DEPLOY.into());
  }
  let state = app.state::<crate::state::AppState>();
  let _lease = match state.mutations.deploy(&project_id) {
    Ok(lease) => lease,
    Err(error) => return deployment_error(error),
  };
  let by_id = by_id.unwrap_or(false);
  let Some(project) = store::find_project(&project_id) else {
    return DeployResult {
      ok: false,
      outcome: "not-found".into(),
      url: None,
      api_url: None,
      portal_url: None,
      error: Some("Project not found.".into()),
    };
  };

  let args: Vec<String> = if by_id {
    vec!["up".into(), "switch".into(), "--workspace-id".into(), workspace.clone()]
  } else {
    vec!["up".into(), "switch".into(), workspace.clone()]
  };
  let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
  let res = exec::run_project_rayfin(
    Path::new(&project.path),
    &arg_refs,
    RunOptions {
      cwd: Some(PathBuf::from(&project.path)),
      timeout_ms: Some(120_000),
      ..Default::default()
    },
  )
  .await;

  if res.not_found {
    return DeployResult {
      ok: false,
      outcome: "not-found".into(),
      url: None,
      api_url: None,
      portal_url: None,
      error: Some("The rayfin CLI was not found on PATH.".into()),
    };
  }
  if !res.ok {
    let error = error_text(&res, &res.stdout, "rayfin up switch failed.");
    return DeployResult {
      ok: false,
      outcome: "error".into(),
      url: None,
      api_url: None,
      portal_url: None,
      error: Some(error),
    };
  }

  // `rayfin up switch` updated the registry; `rayfin up status` (about 6 s more)
  // is only asked when the registry can't say.
  let (deployed, hosting, api, portal) = match registry_active(Path::new(&project.path)) {
    Some(Some(active)) => (active.api.is_some(), active.hosting, active.api, active.portal),
    _ => {
      let status = status_for(&project.path).await;
      (status.deployed, None, status.api_url, status.portal_url)
    }
  };
  let url = pick_preview_url(hosting.as_deref(), api.as_deref(), portal.as_deref());

  {
    let w = workspace.clone();
    store::mutate_project(&project_id, move |p| {
      p.workspace = Some(w);
      // Switching to an existing deployment proves one exists — lift the gate.
      p.awaiting_first_deploy = None;
    });
  }
  {
    let (url, api, portal) = (url.clone(), api.clone(), portal.clone());
    patch_deploy(&project_id, move |d| {
      d.url = url;
      d.api_url = api;
      d.portal_url = portal;
      d.status = if deployed { Some("success".into()) } else { None };
      d.outcome = if deployed { Some("success".into()) } else { None };
      d.error = None;
      d.at = Some(now_iso());
      d.commit = None;
    });
  }

  DeployResult {
    ok: true,
    outcome: "success".into(),
    url,
    api_url: api,
    portal_url: portal,
    error: None,
  }
}

#[tauri::command]
pub fn deploy_set_name(project_id: String, workspace_key: String, name: String) -> ProjectsState {
  let trimmed = name.trim().to_string();
  let state = store::mutate_project(&project_id, move |p| {
    let mut names = p.deployment_names.take().unwrap_or_default();
    if trimmed.is_empty() {
      names.remove(&workspace_key);
    } else {
      names.insert(workspace_key, trimmed);
    }
    p.deployment_names = Some(names);
  });
  annotate_state(state)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn failed_run(stdout: &str, stderr: &str) -> RunResult {
    RunResult {
      ok: false,
      exit_code: Some(1),
      stdout: stdout.into(),
      stderr: stderr.into(),
      not_found: false,
    }
  }

  #[test]
  fn deploy_error_keeps_the_root_cause_instead_of_warnings_or_retry_instructions() {
    let stdout = "Build complete\nError: Could not acquire the token-cache lock (cache.lock)\n\
      Deployment failed\nAfter fixing the error above, re-run rayfin up\n";
    let result = failed_run(stdout, "npm warn deprecated dependency\n");
    let error = error_text(&result, stdout, "fallback");
    assert_eq!(error, "Error: Could not acquire the token-cache lock (cache.lock)");
    assert_eq!(failure_outcome(&error), "auth-cache-error");
    assert_eq!(error_text(&result, "", "fallback"), error);
  }

  #[test]
  fn generic_or_empty_deploy_failures_use_the_actionable_fallback() {
    for output in ["", "  \n", "Deploy failed", "Deployment failed:", "Error:"] {
      let result = failed_run(output, "");
      assert_eq!(error_text(&result, output, "rayfin up exited with code 1."), "rayfin up exited with code 1.");
    }
    let result = failed_run("", &format!("Error: {}", "x".repeat(1000)));
    assert_eq!(error_text(&result, "", "fallback").chars().count(), 500);
  }

  #[test]
  fn a_failure_keeps_the_lines_that_explain_it_for_help() {
    // The one-line error is only the headline; the cause is on the lines after it.
    let output = "Deploying Contoso Expenses to Fabric…\n\
      [rayfin] settings: Applying runtime settings\n\n\
      \x1b[31m❌ Deployment failed: Runtime settings sync failed: 400 Bad Request\x1b[0m\n\
      \x20  Details: The PostgreSQLDatabase feature is not enabled.\n\
      \x20  RootActivityId: 81ae282a-1f0e-4226-8643-eebd435b2c17\n";
    let error = error_text(&failed_run(output, ""), output, "fallback");
    assert!(!error.contains("PostgreSQLDatabase"), "the headline alone doesn't say why");

    let detail = failure_detail(output).expect("a failed run has output to keep");
    assert!(detail.contains("Details: The PostgreSQLDatabase feature is not enabled."));
    assert!(detail.contains("[rayfin] settings: Applying runtime settings"), "and the step it was on");
    assert!(!detail.contains('\x1b'), "colour codes are stripped");
    assert!(!detail.contains("\n\n"), "blank lines are dropped");
  }

  #[test]
  fn a_failure_detail_keeps_only_the_end_of_a_long_run() {
    let output: String = (1..=100).map(|i| format!("line {i}\n")).collect();
    let detail = failure_detail(&output).unwrap();
    assert_eq!(detail.lines().count(), FAILURE_DETAIL_LINES);
    assert!(detail.ends_with("line 100"));
    assert!(!detail.contains("line 84\n"), "the start of the run is left out");
    assert_eq!(failure_detail("  \n\n"), None, "no output, no detail");
  }

  #[test]
  fn deployment_failures_distinguish_cache_login_workspace_and_other_causes() {
    for message in [
      "Could not acquire the token-cache lock (cache.lock)",
      "CrossPlatformLockError: Not able to acquire lock",
      "Token cache could not be read",
    ] {
      assert_eq!(failure_outcome(message), "auth-cache-error", "{message}");
    }
    for message in ["Not signed in", "Error: invalid_grant AADSTS700082", "HTTP 401", "Unauthorized"] {
      assert_eq!(failure_outcome(message), "not-signed-in", "{message}");
    }
    assert_eq!(failure_outcome("No workspace targeting context; pass --workspace"), "needs-workspace");
    for message in [
      "src/login.ts: error TS2307: Cannot find module 'authenticate'",
      "Authenticated successfully; build failed",
      "HTTP 403: Insufficient workspace permissions",
      "Network request failed: login endpoint ETIMEDOUT",
      "Removed a stale token-cache lock left by an interrupted sign-in",
    ] {
      assert_eq!(failure_outcome(message), "error", "{message}");
    }
  }

  struct TestRepo(PathBuf);

  impl TestRepo {
    fn new() -> Self {
      let repo = Self(std::env::temp_dir().join(format!("fabricator-deploy-{}", uuid::Uuid::new_v4())));
      std::fs::create_dir_all(&repo.0).unwrap();
      repo.git(&["init", "--quiet"]);
      repo.git(&["config", "core.autocrlf", "false"]);
      repo.git(&["config", "core.hooksPath", "missing-test-hooks"]);
      repo
    }

    fn dir(&self) -> &str {
      self.0.to_str().unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
      let output = std::process::Command::new("git")
        .args([
          "-c", "user.name=Fabricator Tests",
          "-c", "user.email=tests@rayfin.local",
          "-c", "commit.gpgsign=false",
        ])
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", self.0.join("missing-test-config"))
        .current_dir(&self.0)
        .output()
        .unwrap();
      assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
      String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn write(&self, name: &str, content: &str) {
      std::fs::write(self.0.join(name), content).unwrap();
    }

    fn commit(&self) -> String {
      self.git(&["add", "-A"]);
      self.git(&["commit", "--quiet", "--allow-empty", "-m", "Test checkpoint"]);
      self.git(&["rev-parse", "HEAD"])
    }
  }

  impl Drop for TestRepo {
    fn drop(&mut self) {
      if let Err(error) = std::fs::remove_dir_all(&self.0) {
        eprintln!("Could not remove test repository {}: {error}", self.0.display());
      }
    }
  }

  #[tokio::test]
  async fn committed_edits_still_need_deploying() {
    let repo = TestRepo::new();
    repo.write("app.ts", "export const version = 1;\n");
    let deployed = repo.commit();
    assert!(!has_changes_since_deploy(repo.dir(), Some(&deployed)).await.unwrap());

    repo.write("app.ts", "export const version = 2;\n");
    repo.commit();
    assert!(repo.git(&["status", "--porcelain"]).is_empty());
    assert!(has_changes_since_deploy(repo.dir(), Some(&deployed)).await.unwrap());
  }

  #[tokio::test]
  async fn unchanged_content_does_not_redeploy_for_a_new_commit() {
    let repo = TestRepo::new();
    repo.write("app.ts", "export const version = 1;\n");
    let deployed = repo.commit();
    repo.write("app.ts", "export const version = 2;\n");
    repo.commit();
    repo.write("app.ts", "export const version = 1;\n");
    let restored = repo.commit();
    assert_ne!(deployed, restored);
    assert!(!has_changes_since_deploy(repo.dir(), Some(&deployed)).await.unwrap());
  }

  #[tokio::test]
  async fn uncommitted_staged_deleted_and_untracked_files_need_deploying() {
    let repo = TestRepo::new();
    repo.write("app.ts", "export const version = 1;\n");
    let deployed = repo.commit();
    repo.write("app.ts", "export const version = 2;\n");
    assert!(has_changes_since_deploy(repo.dir(), Some(&deployed)).await.unwrap());
    repo.git(&["add", "app.ts"]);
    assert!(has_changes_since_deploy(repo.dir(), Some(&deployed)).await.unwrap());

    let deployed = repo.commit();
    std::fs::remove_file(repo.0.join("app.ts")).unwrap();
    assert!(has_changes_since_deploy(repo.dir(), Some(&deployed)).await.unwrap());

    let deployed = repo.commit();
    repo.git(&["config", "status.showUntrackedFiles", "no"]);
    repo.write("new.ts", "export const added = true;\n");
    assert!(has_changes_since_deploy(repo.dir(), Some(&deployed)).await.unwrap());
  }

  #[tokio::test]
  async fn missing_deploy_baseline_is_not_treated_as_up_to_date() {
    let repo = TestRepo::new();
    repo.commit();
    assert!(has_changes_since_deploy(repo.dir(), None).await.unwrap());
    assert!(has_changes_since_deploy(repo.dir(), Some(" ")).await.unwrap());
  }

  /// A folder opened from disk with no repository (issue #37): the check used
  /// to fail with "not a git repository" after every turn.
  #[tokio::test]
  async fn an_app_without_a_repository_gets_one_and_then_redeploys_only_on_changes() {
    let dir = std::env::temp_dir().join(format!("fabricator-untracked-{}", uuid::Uuid::new_v4()));
    if version_history::is_tracked(&std::env::temp_dir()) {
      return;
    }
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src").join("app.ts"), "export const version = 1;\n").unwrap();
    let path = dir.to_str().unwrap();
    assert!(has_changes_since_deploy(path, None).await.is_err(), "git alone can't check an untracked folder");

    assert!(version_history::ensure_tracked(&dir).await.unwrap().is_some());
    assert!(has_changes_since_deploy(path, None).await.unwrap(), "deploys once to set a baseline");
    let deployed = head_sha(path).await.expect("the first version is committed");
    assert!(!has_changes_since_deploy(path, Some(&deployed)).await.unwrap());

    std::fs::write(dir.join("src").join("app.ts"), "export const version = 2;\n").unwrap();
    assert!(has_changes_since_deploy(path, Some(&deployed)).await.unwrap());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[tokio::test]
  async fn git_failures_are_reported_instead_of_hiding_changes() {
    let repo = TestRepo::new();
    repo.commit();
    let error = has_changes_since_deploy(repo.dir(), Some("missing-deployed-commit")).await.unwrap_err();
    assert!(error.contains("Could not compare the project with its last deployment"));

    let outside = repo.0.join("..").join(format!("fabricator-missing-{}", uuid::Uuid::new_v4()));
    let error = has_changes_since_deploy(outside.to_str().unwrap(), None).await.unwrap_err();
    assert!(error.contains("Could not check for undeployed changes"));
  }

  #[test]
  fn checked_deployment_list_rejects_auth_failures_and_malformed_output() {
    let names = std::collections::HashMap::new();
    let mut res = exec::RunResult {
      ok: false,
      exit_code: Some(1),
      stdout: "[]".into(),
      stderr: "No cached account; run rayfin login".into(),
      not_found: false,
    };
    let error = checked_deploy_list(&res, &names).err().expect("authentication failure");
    assert_eq!(crate::services::fabric_auth::failure_flags(&error), (true, false));
    res.ok = true;
    res.stderr.clear();
    res.stdout = "not JSON".into();
    assert!(checked_deploy_list(&res, &names).is_err());
    res.stdout = "[]".into();
    assert!(checked_deploy_list(&res, &names).unwrap().is_empty());
  }
  use std::collections::HashMap;

  #[test]
  fn workspace_args_routes_by_shape() {
    assert_eq!(workspace_args(None), Vec::<String>::new());
    assert_eq!(workspace_args(Some("   ")), Vec::<String>::new());
    assert_eq!(
      workspace_args(Some("https://app.fabric.microsoft.com/ws")),
      vec!["--workspace-uri".to_string(), "https://app.fabric.microsoft.com/ws".to_string()]
    );
    assert_eq!(
      workspace_args(Some("3fa85f64-5717-4562-b3fc-2c963f66afa6")),
      vec!["--workspace-id".to_string(), "3fa85f64-5717-4562-b3fc-2c963f66afa6".to_string()]
    );
    assert_eq!(workspace_args(Some("My Workspace")), vec!["-w".to_string(), "My Workspace".to_string()]);
  }

  #[test]
  fn settings_push_skips_the_app_build_and_keeps_the_workspace_target() {
    assert_eq!(settings_push_args(None), ["up", "-y", "--force", "--exclude-services", "staticHosting"]);
    assert_eq!(
      settings_push_args(Some("3fa85f64-5717-4562-b3fc-2c963f66afa6"))[5..],
      ["--workspace-id", "3fa85f64-5717-4562-b3fc-2c963f66afa6"]
    );
  }

  #[test]
  fn scrape_and_pick_url() {
    assert_eq!(scrape_hosting_url("blah\nHosting URL: https://x.dev/app  \nmore").as_deref(), Some("https://x.dev/app"));
    assert_eq!(scrape_hosting_url("nothing here"), None);
    assert_eq!(pick_preview_url(Some("h"), Some("a"), Some("p")).as_deref(), Some("h"));
    assert_eq!(pick_preview_url(None, Some("a"), Some("p")).as_deref(), Some("a"));
    assert_eq!(pick_preview_url(None, None, Some("p")).as_deref(), Some("p"));
    assert_eq!(pick_preview_url(None, None, None), None);
  }

  #[test]
  fn parse_status_grabs_last_json() {
    let out = "noise line\n{\"deployed\":true,\"deployment\":{\"rayfinApiUrl\":\"https://api\",\"fabricPortalUrl\":null}}\n";
    let parsed = parse_status_json(out).expect("should parse");
    assert!(parsed.deployed);
    let dep = parsed.deployment.unwrap();
    assert_eq!(dep.rayfin_api_url.as_deref(), Some("https://api"));
    assert_eq!(dep.fabric_portal_url, None);
    assert!(parse_status_json("not json at all").is_none());
  }

  #[test]
  fn parse_list_maps_friendly_names() {
    let mut names = HashMap::new();
    names.insert("ws-guid".to_string(), "Prod".to_string());
    let out = r#"[{"workspaceName":"Contoso","active":true,"workspaceId":"ws-guid","itemId":"it1","apiUrl":"https://a","hostingUrl":"https://h","deployedAt":"2024"}]"#;
    let list = parse_deploy_list(out, &names);
    assert_eq!(list.len(), 1);
    let d = &list[0];
    assert_eq!(d.workspace_name, "Contoso");
    assert_eq!(d.name.as_deref(), Some("Prod"));
    assert!(d.active);
    assert_eq!(d.api_url.as_deref(), Some("https://a"));
  }

  #[test]
  fn parse_list_opt_distinguishes_failed_empty_and_active() {
    let names = HashMap::new();
    // Unparseable output -> None (treated as an inconclusive query by reconcile).
    assert!(parse_deploy_list_opt("not json at all", &names).is_none());
    // A parsed-but-empty array -> Some(empty) (disk says nothing is deployed).
    let empty = parse_deploy_list_opt("[]", &names).expect("empty array parses");
    assert!(empty.is_empty());
    // A populated array -> Some(list) with the active entry discoverable.
    let out = r#"noise
[{"workspaceName":"WS","active":true,"workspaceId":"g","apiUrl":"https://a","hostingUrl":"https://h"}]"#;
    let some = parse_deploy_list_opt(out, &names).expect("array parses");
    let active = some.into_iter().find(|d| d.active).expect("has active");
    assert_eq!(active.workspace_id.as_deref(), Some("g"));
    assert_eq!(active.hosting_url.as_deref(), Some("https://h"));
  }

  #[test]
  fn last_lines_takes_tail() {
    assert_eq!(last_lines("a\nb\nc\nd", 2), "c d");
    assert_eq!(last_lines("only", 3), "only");
  }

  /// A project folder with `rayfin/.deployments.json` holding `registry`.
  struct RegistryDir(PathBuf);

  impl RegistryDir {
    fn new(registry: Option<&str>) -> Self {
      let dir = std::env::temp_dir().join(format!("fabricator-registry-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(dir.join("rayfin")).unwrap();
      if let Some(text) = registry {
        std::fs::write(dir.join("rayfin").join(".deployments.json"), text).unwrap();
      }
      Self(dir)
    }
  }

  impl Drop for RegistryDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  const REGISTRY: &str = r#"{
    "deployments": {
      "sales-prod": {
        "fabricItemId": "item-1",
        "fabricApiUrl": "https://api/1",
        "fabricWorkspaceId": "WS-1",
        "hostingUrl": "https://sales.example.app",
        "fabricDeepLink": "https://app.fabric.microsoft.com/groups/WS-1/appbackends/item-1",
        "deployedAt": "2026-10-07T15:46:28.982Z"
      },
      "sales-dev": {
        "fabricItemId": "item-2",
        "fabricApiUrl": "https://api/2",
        "fabricWorkspaceId": "ws-2"
      },
      "seeded": { "fabricWorkspaceId": "ws-3", "fabricItemId": "" },
      "odd": "not a record"
    },
    "active": "sales-prod"
  }"#;

  #[test]
  fn the_registry_lists_deployments_as_rayfin_up_list_does() {
    let dir = RegistryDir::new(Some(REGISTRY));
    let mut names = HashMap::new();
    names.insert("WS-1".to_string(), "Prod".to_string());
    names.insert("sales-dev".to_string(), "Dev".to_string());
    let mut list = registry_deployments(&dir.0, &names).expect("a readable registry");
    list.sort_by(|a, b| a.workspace_name.cmp(&b.workspace_name));
    // `rayfin init`'s placeholder and the malformed entry are skipped, as the CLI does.
    assert_eq!(list.iter().map(|d| d.workspace_name.as_str()).collect::<Vec<_>>(), ["sales-dev", "sales-prod"]);
    let (dev, prod) = (&list[0], &list[1]);
    assert!(prod.active && !dev.active);
    assert_eq!(prod.name.as_deref(), Some("Prod"), "named by workspace id");
    assert_eq!(dev.name.as_deref(), Some("Dev"), "or by the workspace name it's recorded under");
    assert_eq!(prod.hosting_url.as_deref(), Some("https://sales.example.app"));
    assert_eq!(prod.deployed_at.as_deref(), Some("2026-10-07T15:46:28.982Z"));
    assert_eq!(dev.hosting_url, None);

    let active = registry_active(&dir.0).flatten().expect("an active deployment");
    assert_eq!(active.workspace_name, "sales-prod");
    assert_eq!(active.workspace_id.as_deref(), Some("WS-1"));
    assert_eq!(active.api.as_deref(), Some("https://api/1"));
    assert_eq!(
      active.portal.as_deref(),
      Some("https://app.fabric.microsoft.com/groups/WS-1/appbackends/item-1"),
      "the deep link is what `rayfin up status` reports as the portal URL"
    );
  }

  #[test]
  fn without_a_readable_registry_the_cli_is_asked() {
    assert!(read_registry(&RegistryDir::new(None).0).is_none(), "no registry: older projects keep theirs elsewhere");
    assert!(read_registry(&RegistryDir::new(Some("{ not json")).0).is_none());
    assert!(read_registry(&RegistryDir::new(Some(r#"{"active":"x"}"#)).0).is_none());
    // A registry that records nothing active is an answer, not a failure.
    let none_active = RegistryDir::new(Some(r#"{"deployments":{"a":{"fabricItemId":"i","fabricWorkspaceId":"w"}}}"#));
    assert!(matches!(registry_active(&none_active.0), Some(None)));
    let empty = RegistryDir::new(Some(r#"{"deployments":{},"active":"gone"}"#));
    assert!(registry_deployments(&empty.0, &HashMap::new()).unwrap().is_empty());
  }

  #[test]
  fn porcelain_listings_name_the_files_they_are_about() {
    let listing = " M src/app.ts\0?? new file.ts\0R  new.ts\0old.ts\0 D gone.ts\0";
    assert_eq!(porcelain_paths(listing), ["src/app.ts", "new file.ts", "new.ts", "gone.ts"]);
    assert!(porcelain_paths("").is_empty());
  }

  #[tokio::test]
  async fn pending_changes_count_every_file_that_differs_from_the_deployed_version() {
    let repo = TestRepo::new();
    repo.write("app.ts", "export const version = 1;\n");
    repo.write("style sheet.css", "body {}\n");
    let deployed = repo.commit();
    let none = pending_since_deploy(repo.dir(), Some(&deployed)).await.unwrap();
    assert_eq!(none, PendingChanges { changed: false, files: Some(0) });

    // A committed edit, an uncommitted edit to the same file, and a new file.
    repo.write("app.ts", "export const version = 2;\n");
    repo.commit();
    repo.write("app.ts", "export const version = 3;\n");
    repo.write("new.ts", "export {};\n");
    let some = pending_since_deploy(repo.dir(), Some(&deployed)).await.unwrap();
    assert_eq!(some, PendingChanges { changed: true, files: Some(2) });

    // A name git would quote counts once, committed and edited again.
    repo.write("style sheet.css", "body { margin: 0 }\n");
    repo.commit();
    repo.write("style sheet.css", "body { margin: 1px }\n");
    let spaced = pending_since_deploy(repo.dir(), Some(&deployed)).await.unwrap();
    assert_eq!(spaced, PendingChanges { changed: true, files: Some(3) });

    // Put back as deployed: nothing to ship, though there are new commits.
    repo.write("app.ts", "export const version = 1;\n");
    repo.write("style sheet.css", "body {}\n");
    std::fs::remove_file(repo.0.join("new.ts")).unwrap();
    repo.commit();
    let restored = pending_since_deploy(repo.dir(), Some(&deployed)).await.unwrap();
    assert_eq!(restored, PendingChanges { changed: false, files: Some(0) });

    // No known deployed version: a deploy would ship, but how much isn't known.
    let unknown = pending_since_deploy(repo.dir(), None).await.unwrap();
    assert_eq!(unknown, PendingChanges { changed: true, files: None });
    assert!(pending_since_deploy(repo.dir(), Some("missing-deployed-commit")).await.is_err());
  }

  #[test]
  fn fabric_preview_after_deploy_switches_once_for_semantic_apps() {
    // No semantic models → never touch the project's preview mode.
    assert_eq!(fabric_preview_after_deploy(None, false, false), None);
    assert_eq!(fabric_preview_after_deploy(Some("fabric"), false, false), None);
    // First deploy with a connected model and no explicit view → adopt Fabric.
    assert_eq!(fabric_preview_after_deploy(None, false, true), Some(Some("fabric".to_string())));
    // Already defaulted once → never override again, even though a later manual
    // switch to the direct view is persisted as `None` (indistinguishable from unset).
    assert_eq!(fabric_preview_after_deploy(None, true, true), None);
    // A model plus an existing explicit choice closes the window without changing it.
    assert_eq!(
      fabric_preview_after_deploy(Some("fabric"), false, true),
      Some(Some("fabric".to_string()))
    );
  }
}
