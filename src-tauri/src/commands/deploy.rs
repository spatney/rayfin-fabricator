//! Deploy engine: Studio owns the deploy loop (`rayfin up`), the chat agent edits
//! code only. Faithful Rust port of `src/main/services/deploy.ts`.
//!
//! Uses the project's pinned Rayfin CLI (the `npx rayfin` equivalent) via
//! [`exec::run_project_rayfin`]. `rayfin up` runs in human mode (streamed to the
//! UI on the `deploy:run` channel) and the canonical URL is read back from
//! `rayfin up status --json`. Preview URL priority: hostingUrl → apiUrl → portalUrl.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::commands::auth::get_cached_identity;
use crate::commands::util::{annotate_state, now_iso};
use crate::services::exec::{self, OnData, RunOptions, RunResult, Stream};
use crate::services::{crashlog, emit, fabric_auth, store, telemetry};
use crate::types::{DeployInfo, DeployResult, DeployStatus, FabricDeployment, ProjectsState};

const DEPLOY_TIMEOUT_MS: u64 = 20 * 60_000;
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
            let name = d
              .workspace_id
              .as_ref()
              .and_then(|id| names.get(id))
              .or_else(|| d.workspace_name.as_ref().and_then(|n| names.get(n)))
              .cloned();
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
  let status = exec::run("git", &["status", "--porcelain"], git_opts(dir, 30_000)).await;
  if !status.ok || status.stdout.trim().is_empty() {
    return;
  }
  let _ = exec::run("git", &["add", "-A"], git_opts(dir, 30_000)).await;
  let _ = exec::run("git", &["commit", "-m", message], git_opts(dir, 30_000)).await;
}

/// Resolve the project's current HEAD commit sha (None when unavailable).
async fn head_sha(dir: &str) -> Option<String> {
  let res = exec::run("git", &["rev-parse", "HEAD"], git_opts(dir, 30_000)).await;
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
  let status = exec::run(
    "git",
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
  let diff = exec::run(
    "git",
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
  apply_id: Option<String>,
) -> DeployResult {
  // Keep ownership attached to actual process completion, not to the invoking
  // renderer's lifetime. This is the existing deployment engine, not a second
  // queue or an independent Design publication pipeline.
  match tokio::spawn(async move { run_deploy(app, project_id, workspace, apply_id).await }).await {
    Ok(result) => result,
    Err(error) => deployment_error(format!("Deployment task failed: {error}")),
  }
}

/// Core deploy routine shared by the [`deploy_run`] command and Fabricator's
/// after-turn auto-deploy. Runs `rayfin up` (streamed to the
/// `deploy:run` UI channel), records the outcome in the store, and returns the
/// resolved live URL on success.
pub(crate) async fn run_deploy(
  app: AppHandle,
  project_id: String,
  workspace: Option<String>,
  apply_id: Option<String>,
) -> DeployResult {
  let state = app.state::<crate::state::AppState>();
  let lease = if let Some(id) = &apply_id {
    match crate::services::design_apply::cached_deployment(&project_id, id) {
      Ok(Some(result)) => return result,
      Ok(None) => {}
      Err(error) => return deployment_error(error),
    }
    match crate::services::design_apply::prepare_deployment(&app, &project_id, id) {
      Ok(lease) => lease,
      Err(error) => return deployment_error(error),
    }
  } else {
    match state.mutations.deploy(&project_id, None) {
      Ok(lease) => lease,
      Err(error) => return deployment_error(error),
    }
  };
  let result = run_deploy_inner(app.clone(), project_id.clone(), workspace).await;
  if let Some(id) = apply_id {
    match crate::services::design_apply::complete_deployment(&app, &project_id, &id, &result) {
      Ok(true) => lease.retain(),
      Ok(false) => {}
      Err(error) => return deployment_error(error),
    }
  }
  result
}

fn deployment_error(error: String) -> DeployResult {
  DeployResult { ok: false, outcome: "error".into(), url: None, api_url: None, portal_url: None, error: Some(error) }
}

async fn run_deploy_inner(
  app: AppHandle,
  project_id: String,
  workspace: Option<String>,
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

  // Success — resolve the canonical URL from status, enrich with scraped hostingUrl.
  let hosting = scrape_hosting_url(&captured_text);
  let status = status_for(&project.path).await;
  let api = status.api_url.clone();
  let portal = status.portal_url.clone();
  let url = pick_preview_url(hosting.as_deref(), api.as_deref(), portal.as_deref());

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
    Some(project) => status_for(&project.path).await,
    None => DeployStatus { deployed: false, url: None, api_url: None, portal_url: None },
  }
}

#[tauri::command]
pub async fn deploy_has_changes(project_id: String) -> Result<bool, String> {
  let project = store::find_project(&project_id).ok_or_else(|| "Project not found.".to_string())?;
  let commit = project.last_deploy.as_ref().and_then(|d| d.commit.as_deref());
  has_changes_since_deploy(&project.path, commit).await
}

#[tauri::command]
pub async fn deploy_list(project_id: String) -> Vec<FabricDeployment> {
  deploy_list_checked(&project_id).await.unwrap_or_default()
}

/// Destructive callers must distinguish "nothing deployed" from a failed
/// query; an auth/CLI failure must not silently permit deleting the local app.
pub(crate) async fn deploy_list_checked(project_id: &str) -> Result<Vec<FabricDeployment>, String> {
  let project = store::find_project(project_id).ok_or_else(|| "Project not found.".to_string())?;
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

  // Never disturb an in-flight deploy.
  if project.last_deploy.as_ref().and_then(|d| d.status.as_deref()) == Some("deploying") {
    return annotate_state(store::get_state());
  }

  let names = project.deployment_names.clone().unwrap_or_default();
  let res = exec::run_project_rayfin(
    Path::new(&project.path),
    &["up", "list", "--json"],
    RunOptions::timeout(60_000),
  )
  .await;

  // A failed or unparseable query is inconclusive (e.g. not signed in, CLI error,
  // offline) — leave recorded state as-is rather than wiping a real deployment.
  if res.not_found || !res.ok {
    return annotate_state(store::get_state());
  }
  let Some(list) = parse_deploy_list_opt(&res.stdout, &names) else {
    return annotate_state(store::get_state());
  };

  match list.into_iter().find(|d| d.active) {
    Some(dep) => {
      // Enrich with the Fabric portal URL (and api fallback) from status.
      let status = status_for(&project.path).await;
      let api = dep.api_url.clone().or(status.api_url);
      let portal = status.portal_url;
      let url = pick_preview_url(dep.hosting_url.as_deref(), api.as_deref(), portal.as_deref());
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
  let state = app.state::<crate::state::AppState>();
  let _lease = match state.mutations.deploy(&project_id, None) {
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

  let status = status_for(&project.path).await;
  let deployed = status.deployed;
  let api = status.api_url.clone();
  let portal = status.portal_url.clone();
  let url = pick_preview_url(None, api.as_deref(), portal.as_deref());

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
