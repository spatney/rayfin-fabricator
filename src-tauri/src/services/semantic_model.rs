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
use serde::{Deserialize, Serialize};

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

/// One table in a semantic model's schema (a node in the Model-tab diagram).
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SemanticTable {
  pub name: Option<String>,
  pub description: Option<String>,
  pub is_hidden: bool,
  pub storage_mode: Option<String>,
}

/// One column on a semantic-model table. `expression` is set only for a
/// calculated column.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SemanticColumn {
  pub table: Option<String>,
  pub name: Option<String>,
  pub data_type: Option<String>,
  pub is_hidden: bool,
  pub is_key: bool,
  pub data_category: Option<String>,
  pub format_string: Option<String>,
  pub display_folder: Option<String>,
  pub expression: Option<String>,
}

/// One measure on a semantic-model table (its DAX `expression` is shown on click).
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SemanticMeasure {
  pub table: Option<String>,
  pub name: Option<String>,
  pub expression: Option<String>,
  pub data_type: Option<String>,
  pub format_string: Option<String>,
  pub display_folder: Option<String>,
  pub description: Option<String>,
  pub is_hidden: bool,
}

/// One relationship (an edge in the diagram) with its cardinality, cross-filter
/// direction and active state.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SemanticRelationship {
  pub name: Option<String>,
  pub from_table: Option<String>,
  pub from_column: Option<String>,
  pub from_cardinality: Option<String>,
  pub to_table: Option<String>,
  pub to_column: Option<String>,
  pub to_cardinality: Option<String>,
  pub is_active: bool,
  pub cross_filter: Option<String>,
}

/// The helper's `mode:"schema"` reply — the model's tables/columns/measures/
/// relationships, plus the shared ok/needs-login/error envelope.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SemanticSchemaResult {
  pub ok: bool,
  pub matched: bool,
  pub needs_login: bool,
  pub needs_az: bool,
  pub error: Option<String>,
  pub workspace_id: Option<String>,
  pub item_id: Option<String>,
  pub tables: Vec<SemanticTable>,
  pub columns: Vec<SemanticColumn>,
  pub measures: Vec<SemanticMeasure>,
  pub relationships: Vec<SemanticRelationship>,
  pub notes: Vec<String>,
}

impl SemanticSchemaResult {
  /// Build an `ok: false` failure with login/az classification from a message.
  fn failure(error: String) -> Self {
    let needs_az = NEEDS_AZ_RE.is_match(&error);
    let needs_login = !needs_az && NEEDS_LOGIN_RE.is_match(&error);
    SemanticSchemaResult {
      ok: false,
      needs_login,
      needs_az,
      error: Some(error),
      ..Default::default()
    }
  }
}

/// One semantic model (dataset) in a workspace, for the "connect a model from
/// your workspace" picker (`mode:"listWorkspaceModels"`).
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceModel {
  pub id: Option<String>,
  pub name: Option<String>,
  pub is_refreshable: Option<bool>,
  pub configured_by: Option<String>,
  pub web_url: Option<String>,
}

/// The helper's `listWorkspaceModels` reply: the workspace's datasets plus the
/// shared ok/needs-login/error envelope. Never panics — a failure classifies the
/// login/az need so the UI can offer a sign-in.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceModelsResult {
  pub ok: bool,
  pub needs_login: bool,
  pub needs_az: bool,
  pub error: Option<String>,
  pub models: Vec<WorkspaceModel>,
}

impl WorkspaceModelsResult {
  fn failure(error: String) -> Self {
    let needs_az = NEEDS_AZ_RE.is_match(&error);
    let needs_login = !needs_az && NEEDS_LOGIN_RE.is_match(&error);
    WorkspaceModelsResult {
      ok: false,
      needs_login,
      needs_az,
      error: Some(error),
      ..Default::default()
    }
  }
}

/// Write the embedded helper to the app data dir and return its path.
///
/// The helper source is a compile-time constant, so we only need to materialize
/// it once per process: the first call writes it (refreshing any stale copy left
/// by a previous app version) and caches the path; later calls skip the write
/// entirely. This removes a redundant file write from every semantic-model lookup.
fn write_helper() -> std::io::Result<PathBuf> {
  static HELPER_PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
  if let Some(path) = HELPER_PATH.get() {
    return Ok(path.clone());
  }
  let dir = paths::ensure_data_dir()?;
  let path = dir.join("semantic-model.mjs");
  std::fs::write(&path, HELPER_SOURCE)?;
  // Cache for the rest of the session (a concurrent first-call race just writes
  // the identical bytes twice — harmless — before one writer wins the set).
  let _ = HELPER_PATH.set(path.clone());
  Ok(path)
}

/// Prepare (locate the Rayfin CLI auth module + write the helper) and run the
/// node helper with `request`, returning its single JSON stdout line on success,
/// or a human-readable error string the caller turns into an `ok:false` result.
/// The helper itself emits well-formed `{ok:false,…}` JSON for login/az needs,
/// so an `Err` here means the child died before writing anything.
async fn invoke_helper(request: &serde_json::Value) -> Result<String, String> {
  let project_dir = store::active_project().map(|p| PathBuf::from(p.path));
  if let Some(dir) = project_dir.as_deref() {
    exec::ensure_project_dependencies(dir, None)
      .await
      .map_err(|error| format!("Could not install this project's dependencies: {error}"))?;
  }
  let auth_path = exec::project_rayfin_auth_module(project_dir.as_deref()).ok_or_else(|| {
    "Could not locate the Rayfin CLI. Open a Rayfin project to reach Fabric.".to_string()
  })?;
  let script_path =
    write_helper().map_err(|err| format!("Could not prepare the semantic-model helper: {err}"))?;

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
    return Err("Node.js was not found on PATH.".to_string());
  }

  let out = res.stdout.trim();
  if !out.is_empty() {
    return Ok(out.to_string());
  }
  let detail = if !res.stderr.trim().is_empty() {
    res.stderr.trim().to_string()
  } else {
    let code = res
      .exit_code
      .map(|c| c.to_string())
      .unwrap_or_else(|| "unknown".to_string());
    format!("semantic-model lookup failed (exit {code}).")
  };
  Err(detail)
}

/// Run the helper with a request JSON string and parse its reply. Never panics —
/// every failure path returns an `ok: false` [`SemanticModelResult`] the caller
/// can render.
async fn run_helper(request: &serde_json::Value) -> SemanticModelResult {
  match invoke_helper(request).await {
    Ok(out) => {
      serde_json::from_str::<SemanticModelResult>(&out).unwrap_or_else(|_| SemanticModelResult::failure(out))
    }
    Err(detail) => SemanticModelResult::failure(detail),
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

/// Read the schema (tables/columns/measures/relationships) of the semantic model
/// `item_id` in workspace `workspace_id` — the data behind the Model tab's
/// semantic-model diagram. Queries the model *live* via DAX `INFO.VIEW.*` through
/// the Power BI `executeQueries` endpoint (the helper's `schema` mode). Never
/// panics — every failure path returns an `ok:false` [`SemanticSchemaResult`]
/// the UI can render (with login classification for a sign-in CTA).
pub async fn schema_semantic_model(workspace_id: &str, item_id: &str) -> SemanticSchemaResult {
  let request = serde_json::json!({
    "mode": "schema",
    "workspaceId": workspace_id,
    "itemId": item_id,
  });
  match invoke_helper(&request).await {
    Ok(out) => serde_json::from_str::<SemanticSchemaResult>(&out)
      .unwrap_or_else(|_| SemanticSchemaResult::failure(out)),
    Err(detail) => SemanticSchemaResult::failure(detail),
  }
}

/// List the semantic models (datasets) in `workspace_id` — the data behind the
/// "connect a model from your workspace" picker. Uses the silent Power BI token
/// (the helper's `listWorkspaceModels` mode). Never panics — a failure returns an
/// `ok:false` [`WorkspaceModelsResult`] with login classification.
pub async fn list_workspace_models(workspace_id: &str) -> WorkspaceModelsResult {
  let request = serde_json::json!({
    "mode": "listWorkspaceModels",
    "workspaceId": workspace_id,
  });
  match invoke_helper(&request).await {
    Ok(out) => serde_json::from_str::<WorkspaceModelsResult>(&out)
      .unwrap_or_else(|_| WorkspaceModelsResult::failure(out)),
    Err(detail) => WorkspaceModelsResult::failure(detail),
  }
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

  /// The helper's `schema` reply must round-trip into [`SemanticSchemaResult`]
  /// with camelCase fields and defaulted optionals.
  #[test]
  fn schema_success_shape_deserializes() {
    let json = r#"{
      "ok": true, "matched": true, "workspaceId": "ws", "itemId": "ds",
      "tables": [{"name":"Sales","isHidden":false},{"name":"Date","isHidden":true}],
      "columns": [{"table":"Sales","name":"Amount","dataType":"Decimal","isKey":false}],
      "measures": [{"table":"Sales","name":"Total","expression":"SUM(Sales[Amount])"}],
      "relationships": [{"fromTable":"Sales","fromColumn":"DateKey","toTable":"Date","toColumn":"DateKey","isActive":true,"crossFilter":"OneDirection","fromCardinality":"Many","toCardinality":"One"}],
      "notes": []
    }"#;
    let parsed: SemanticSchemaResult = serde_json::from_str(json).unwrap();
    assert!(parsed.ok);
    assert_eq!(parsed.tables.len(), 2);
    assert_eq!(parsed.tables[1].name.as_deref(), Some("Date"));
    assert!(parsed.tables[1].is_hidden);
    assert_eq!(parsed.columns[0].data_type.as_deref(), Some("Decimal"));
    assert_eq!(parsed.measures[0].expression.as_deref(), Some("SUM(Sales[Amount])"));
    let rel = &parsed.relationships[0];
    assert!(rel.is_active);
    assert_eq!(rel.cross_filter.as_deref(), Some("OneDirection"));
    assert_eq!(rel.from_cardinality.as_deref(), Some("Many"));
    // Absent optional fields default to None/false.
    assert!(parsed.columns[0].format_string.is_none());
  }

  /// An `ok:false` schema failure carries login classification and empty vecs.
  #[test]
  fn schema_failure_shape_deserializes() {
    let json = r#"{"ok":false,"needsLogin":true,"error":"no cached account"}"#;
    let parsed: SemanticSchemaResult = serde_json::from_str(json).unwrap();
    assert!(!parsed.ok);
    assert!(parsed.needs_login);
    assert!(parsed.tables.is_empty());
    assert_eq!(parsed.error.as_deref(), Some("no cached account"));
  }
}
