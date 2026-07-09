//! Locate / search the Power BI / Fabric **semantic model (dataset)** behind a
//! report or app, on behalf of the Fabricator agent's in-process tools
//! ([`crate::services::agent_tools`]).
//!
//! Like [`crate::commands::fabric`], the heavy lifting runs in a short-lived
//! `node` child so we can reuse the globally-installed Rayfin CLI's own MSAL
//! token cache (native modules — DPAPI / msal-node-extensions — own that cache,
//! so a pure-Rust port is impractical). The helper script
//! ([`HELPER_SOURCE`], embedded from `semantic_model_helper.mjs`) mints the
//! tokens *silently*, performs the REST calls, and writes exactly one JSON line
//! to stdout. All orchestration, timeouts and error classification are Rust.
//!
//! Two modes:
//! - **locate** — id / URL → model. Pure Power BI REST with the silently-minted
//!   Power BI token (`analysis.windows.net/powerbi/api`).
//! - **search** — description / keywords → model. The Fabric OneLake catalog
//!   search needs the delegated `Catalog.Read.All` scope, which the Rayfin app
//!   registration cannot mint silently, so the catalog token comes from the
//!   **Azure CLI** (`az` — already a required, signed-in Fabricator tool). Each
//!   matched report is then resolved to its model with the Power BI token.

use std::path::PathBuf;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;

use crate::services::exec::{self, RunOptions};
use crate::services::paths;
use crate::services::store;

/// Generous upper bound: a `locate` may fan out a bounded parallel scan across
/// every workspace the user can see, and a `search` resolves each matched
/// report to its model. Keep it comfortably above the helper's own budget so a
/// slow tenant degrades gracefully instead of being killed mid-flight.
const HELPER_TIMEOUT_MS: u64 = 120_000;

/// The Node helper, embedded at compile time. Written to the app data dir at
/// runtime (see [`write_helper`]) so the system `node` can execute it.
const HELPER_SOURCE: &str = include_str!("semantic_model_helper.mjs");

/// Parse-failure classification (when the child dies before emitting JSON).
/// Mirrors the heuristics the helper itself uses for its `needsLogin` flag.
static NEEDS_LOGIN_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)silent|cached|account|login|token|interactive|sign").unwrap());
/// Parse-failure classification for a missing / signed-out Azure CLI.
static NEEDS_AZ_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)\baz\b|azure cli|az login|az account").unwrap());

/// One semantic model in a result. A Power BI `dataset` *is* a Fabric
/// semantic-model item, so [`item_id`](SemanticModel::item_id) ==
/// [`id`](SemanticModel::id) and feeds `fabric-app-data add -w <workspace_id> -i
/// <item_id>` directly.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SemanticModel {
  pub name: Option<String>,
  pub id: Option<String>,
  pub item_id: Option<String>,
  pub workspace_id: Option<String>,
  pub workspace_name: Option<String>,
  pub owner: Option<String>,
  pub is_refreshable: Option<bool>,
  pub web_url: Option<String>,
  pub xmla_endpoint: Option<String>,
  /// Set on `search` results: how this model was matched (e.g. a report name).
  pub matched_via: Option<String>,
}

/// A report or app the target resolved through (locate only). Optional fields
/// cover both shapes (a report has no `published_by` / `report_count`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NamedRef {
  pub id: Option<String>,
  pub name: Option<String>,
  pub workspace_id: Option<String>,
  pub workspace_name: Option<String>,
  pub web_url: Option<String>,
  pub published_by: Option<String>,
  pub report_count: Option<u32>,
}

/// A non-model catalog hit (search only) — e.g. a lakehouse or warehouse.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OtherMatch {
  pub id: Option<String>,
  pub r#type: Option<String>,
  pub display_name: Option<String>,
  pub workspace_id: Option<String>,
  pub workspace_name: Option<String>,
}

/// The helper's single-line JSON contract, shared by both modes. Unknown/absent
/// fields default, so the same struct deserializes a locate *or* a search reply
/// (and a synthesized failure).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SemanticModelResult {
  pub ok: bool,
  pub matched: bool,
  pub needs_login: bool,
  pub needs_az: bool,
  pub error: Option<String>,
  pub models: Vec<SemanticModel>,
  pub notes: Vec<String>,
  /// locate: the report the id/URL pointed at (if any).
  pub report: Option<NamedRef>,
  /// locate: the app the id/URL pointed at (if any).
  pub app: Option<NamedRef>,
  /// search: catalog hits that aren't models/reports.
  pub other_matches: Vec<OtherMatch>,
}

impl SemanticModelResult {
  /// Build an `ok: false` failure with login/az classification from a message.
  fn failure(error: String) -> Self {
    let needs_az = NEEDS_AZ_RE.is_match(&error);
    let needs_login = !needs_az && NEEDS_LOGIN_RE.is_match(&error);
    SemanticModelResult {
      ok: false,
      needs_login,
      needs_az,
      error: Some(error),
      ..Default::default()
    }
  }
}

/// Write the embedded helper to the app data dir and return its path.
fn write_helper() -> std::io::Result<PathBuf> {
  let dir = paths::ensure_data_dir()?;
  let path = dir.join("semantic-model.mjs");
  std::fs::write(&path, HELPER_SOURCE)?;
  Ok(path)
}

/// Run the helper with a request JSON string and parse its reply. Never panics —
/// every failure path returns an `ok: false` [`SemanticModelResult`] the caller
/// can render.
async fn run_helper(request: &serde_json::Value) -> SemanticModelResult {
  let project_dir = store::active_project().map(|p| PathBuf::from(p.path));
  let auth_path = match exec::project_rayfin_auth_module(project_dir.as_deref()) {
    Some(p) => p,
    None => {
      return SemanticModelResult::failure(
        "Could not locate the Rayfin CLI. Open a project and install its dependencies to reach Fabric.".to_string(),
      )
    }
  };
  let script_path = match write_helper() {
    Ok(p) => p,
    Err(err) => {
      return SemanticModelResult::failure(format!(
        "Could not prepare the semantic-model helper: {err}"
      ))
    }
  };

  let auth_str = auth_path.to_string_lossy().to_string();
  let script_str = script_path.to_string_lossy().to_string();
  let request_str = request.to_string();
  let res = exec::run(
    "node",
    &[&script_str, &auth_str, &request_str],
    RunOptions::timeout(HELPER_TIMEOUT_MS),
  )
  .await;

  if res.not_found {
    return SemanticModelResult::failure("Node.js was not found on PATH.".to_string());
  }

  let out = res.stdout.trim();
  match serde_json::from_str::<SemanticModelResult>(out) {
    Ok(parsed) => parsed,
    Err(_) => {
      let detail = if !res.stderr.trim().is_empty() {
        res.stderr.trim().to_string()
      } else if !out.is_empty() {
        out.to_string()
      } else {
        let code = res
          .exit_code
          .map(|c| c.to_string())
          .unwrap_or_else(|| "unknown".to_string());
        format!("semantic-model lookup failed (exit {code}).")
      };
      SemanticModelResult::failure(detail)
    }
  }
}

/// Locate the semantic model behind a Power BI / Fabric **report, app, or
/// dataset** referenced by `target` (a GUID or a Power BI URL). `workspace` is
/// an optional workspace-id hint; `admin` opts into the tenant-admin lookup
/// paths the ported script attempts when the caller has the rights.
pub async fn locate_semantic_model(
  target: &str,
  workspace: Option<&str>,
  admin: bool,
) -> SemanticModelResult {
  let request = serde_json::json!({
    "mode": "locate",
    "target": target,
    "workspace": workspace,
    "admin": admin,
  });
  run_helper(&request).await
}

/// Search the Fabric catalog by free-text `query` and resolve matches to their
/// semantic model(s). `types` optionally narrows the catalog item types
/// (defaults to reports + semantic models); `limit` caps the catalog hits.
pub async fn search_semantic_models(
  query: &str,
  types: Option<Vec<String>>,
  limit: Option<u32>,
) -> SemanticModelResult {
  let request = serde_json::json!({
    "mode": "search",
    "query": query,
    "types": types,
    "limit": limit,
  });
  run_helper(&request).await
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The helper's `parseTarget` cases must pass — this guards URL parsing
  /// (e.g. the /modeling/<id>/modelView model-editor link) against regressions.
  /// Skips gracefully if `node` isn't on PATH (parsing is JS-only).
  #[test]
  fn helper_selftest_parses_known_urls() {
    let script = std::env::temp_dir().join("semantic-model-selftest.mjs");
    if std::fs::write(&script, HELPER_SOURCE).is_err() {
      return;
    }
    let out = std::process::Command::new("node")
      .arg(&script)
      .arg("--selftest")
      .output();
    let _ = std::fs::remove_file(&script);
    match out {
      Ok(o) => assert!(
        o.status.success(),
        "parseTarget selftest failed: {}",
        String::from_utf8_lossy(&o.stderr)
      ),
      Err(_) => { /* node unavailable; parsing covered by `node --selftest` in dev */ }
    }
  }
}
