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
use tauri::AppHandle;

use crate::commands::auth::get_cached_identity;
use crate::commands::util::{annotate_state, now_iso};
use crate::services::exec::{self, OnData, RunOptions, RunResult, Stream};
use crate::services::{emit, store, telemetry};
use crate::types::{DeployInfo, DeployResult, DeployStatus, FabricDeployment, ProjectsState};

const DEPLOY_TIMEOUT_MS: u64 = 20 * 60_000;
const DEPLOY_CHANNEL: &str = "deploy:run";

static GUID_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap());
static HOSTING_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)Hosting URL:\s*(\S+)").unwrap());
static NOT_SIGNED_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)not (logged|signed) in|login|unauthor|authenticate").unwrap());
static NEEDS_WS_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)no workspace targeting context|pass --workspace").unwrap());

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
  let lines: Vec<&str> = text.trim().lines().collect();
  let start = lines.len().saturating_sub(n);
  lines[start..].join(" ")
}

/// Compose a user-facing error string (stderr, else trailing output, else fallback).
fn error_text(result: &RunResult, capture: &str, fallback: &str) -> String {
  let primary = if !result.stderr.trim().is_empty() {
    result.stderr.trim().to_string()
  } else {
    last_lines(capture, 3)
  };
  let sliced: String = primary.chars().take(500).collect();
  if sliced.trim().is_empty() {
    fallback.to_string()
  } else {
    sliced
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

/* ------------------------------ commands ---------------------------------- */

#[tauri::command]
pub async fn deploy_run(
  app: AppHandle,
  project_id: String,
  workspace: Option<String>,
  force: Option<bool>,
) -> DeployResult {
  run_deploy(app, project_id, workspace, force).await
}

/// Core deploy routine shared by the [`deploy_run`] command and the agent's
/// `fabricator_deploy_and_wait` tool. Runs `rayfin up` (streamed to the
/// `deploy:run` UI channel), records the outcome in the store, and returns the
/// resolved live URL on success.
pub(crate) async fn run_deploy(
  app: AppHandle,
  project_id: String,
  workspace: Option<String>,
  force: Option<bool>,
) -> DeployResult {
  let force = force.unwrap_or(false);
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

  let mut up_args: Vec<String> = vec!["up".into(), "-y".into()];
  if force {
    up_args.push("--force".into());
  }
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
    let error = "The rayfin CLI was not found on PATH.".to_string();
    patch_deploy(&project_id, |d| {
      d.status = Some("error".into());
      d.outcome = Some("not-found".into());
      d.error = Some(error.clone());
      d.at = Some(now_iso());
    });
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
    let lower = format!("{captured_text}{}", result.stderr).to_lowercase();
    let outcome = if NOT_SIGNED_RE.is_match(&lower) {
      "not-signed-in"
    } else if !force && lower.contains("destructive") {
      "needs-force"
    } else if NEEDS_WS_RE.is_match(&lower) {
      "needs-workspace"
    } else {
      "error"
    };
    let fallback = format!(
      "rayfin up exited with code {}.",
      result.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
    );
    let error = error_text(&result, &captured_text, &fallback);
    patch_deploy(&project_id, |d| {
      d.status = Some("error".into());
      d.outcome = Some(outcome.into());
      d.error = Some(error.clone());
      d.at = Some(now_iso());
    });
    telemetry::track_deploy(get_cached_identity().as_ref(), false);
    let sys = match outcome {
      "needs-workspace" => "\nThis project has no Fabric workspace yet — choose one to deploy into.\n".to_string(),
      "needs-force" => "\nThis deploy needs --force to apply destructive schema changes (possible data loss).\n".to_string(),
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

  commit_checkpoint(&project.path, &format!("Deploy {} ({})", project.name, now_iso())).await;
  if let Some(commit) = head_sha(&project.path).await {
    patch_deploy(&project_id, move |d| d.commit = Some(commit));
  }
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
pub async fn deploy_has_changes(project_id: String) -> bool {
  let Some(project) = store::find_project(&project_id) else {
    return false;
  };
  let res = exec::run("git", &["status", "--porcelain"], git_opts(&project.path, 30_000)).await;
  res.ok && !res.stdout.trim().is_empty()
}

#[tauri::command]
pub async fn deploy_list(project_id: String) -> Vec<FabricDeployment> {
  let Some(project) = store::find_project(&project_id) else {
    return vec![];
  };
  let names = project.deployment_names.clone().unwrap_or_default();
  let res = exec::run_project_rayfin(Path::new(&project.path), &["up", "list", "--json"], RunOptions::timeout(60_000)).await;
  if !res.ok {
    return vec![];
  }
  parse_deploy_list(&res.stdout, &names)
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
        deploy.url = url;
        deploy.api_url = api;
        deploy.portal_url = portal;
        deploy.status = Some("success".into());
        deploy.outcome = Some("success".into());
        deploy.error = None;
        deploy.at = Some(now_iso());
        // `commit` is intentionally preserved — the deployed commit isn't known
        // from `up list`, and fabricating it would defeat drift detection.
        p.last_deploy = Some(deploy);
        p.workspace = workspace;
        p.workspace_name = ws_name;
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
pub async fn deploy_switch(project_id: String, workspace: String, by_id: Option<bool>) -> DeployResult {
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
    store::mutate_project(&project_id, move |p| p.workspace = Some(w));
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
}

