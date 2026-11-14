//! Read a Power BI / Fabric **semantic model** and the data in a workspace, for
//! the Model tab, the workspace pickers, and report migrations.
//!
//! Like [`crate::commands::fabric`], the work runs in a short-lived `node`
//! child so it can reuse the active project's (or global) Rayfin CLI MSAL token
//! cache (native modules — DPAPI / msal-node-extensions — own that cache, so a
//! pure-Rust port is impractical). The helper script ([`HELPER_SOURCE`],
//! embedded from `semantic_model_helper.mjs`) mints the tokens *silently*,
//! performs the REST calls, and writes exactly one JSON line to stdout.
//! Authentication rejection is classified by the shared helper; Rust checks the
//! process exit status and deserializes the result.
//!
//! Its modes:
//! - **schema** — a model's tables, columns, measures and relationships, read
//!   from its definition with the **Azure CLI**'s Fabric token.
//! - **listWorkspaceModels** / **listWorkspaceData** — the semantic models, or
//!   every item a Rayfin connector can read, in a workspace.
//!
//! Chat finds and reads the user's models with Fabric IQ
//! ([`crate::services::iq`]), not with this helper.

use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::services::exec::{self, RunOptions};
use crate::services::fabric_auth;
use crate::services::paths;
use crate::services::store;

/// Generous upper bound: a large model's definition can take a while to come
/// back, and a slow tenant should degrade gracefully instead of being killed
/// mid-flight.
const HELPER_TIMEOUT_MS: u64 = 120_000;

/// The Node helper, embedded at compile time. Written to the app data dir at
/// runtime (see [`write_helper`]) so the system `node` can execute it; the
/// report-migration helper imports it too.
pub(crate) const HELPER_SOURCE: &str = include_str!("semantic_model_helper.mjs");

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
    let (needs_login, needs_az) = fabric_auth::failure_flags(&error);
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
    let (needs_login, needs_az) = fabric_auth::failure_flags(&error);
    WorkspaceModelsResult {
      ok: false,
      needs_login,
      needs_az,
      error: Some(error),
      ..Default::default()
    }
  }
}

/// One item in a workspace that a Rayfin connector can read, for the "Add
/// Fabric data" picker (`mode:"listWorkspaceData"`).
#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceDataItem {
  pub id: String,
  pub name: String,
  /// Fabric's item type: `SemanticModel`, `Warehouse`, `SQLDatabase` or `Lakehouse`.
  #[serde(rename = "type")]
  pub item_type: String,
  pub description: Option<String>,
}

/// The helper's `listWorkspaceData` reply, with the shared ok/needs-login/error envelope.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceDataResult {
  pub ok: bool,
  pub needs_login: bool,
  pub needs_az: bool,
  pub error: Option<String>,
  pub items: Vec<WorkspaceDataItem>,
}

impl WorkspaceDataResult {
  fn failure(error: String) -> Self {
    let (needs_login, needs_az) = fabric_auth::failure_flags(&error);
    WorkspaceDataResult {
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
/// entirely. This removes a redundant file write from every helper run.
fn write_helper() -> std::io::Result<PathBuf> {
  fabric_auth::write_helper()?;
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
/// node helper with `request`, returning its decoded JSON result on success,
/// or a human-readable error string the caller turns into an `ok:false` result.
/// The helper itself emits well-formed `{ok:false,…}` JSON for login/az needs,
/// so an `Err` here means the child died before writing anything.
async fn invoke_helper<T: DeserializeOwned>(request: &serde_json::Value) -> Result<T, String> {
  let auth_path = if request["mode"] == "schema" {
    // Model definitions use the Azure CLI, not Rayfin/MSAL.
    PathBuf::from("-")
  } else {
    let project_dir = store::active_project().map(|p| PathBuf::from(p.path));
    if let Some(dir) = project_dir.as_deref() {
      exec::ensure_project_dependencies(dir, None)
        .await
        .map_err(|error| t!("services.semanticModel.depsFailed", error = error))?;
    }
    exec::project_rayfin_auth_module(project_dir.as_deref())
      .ok_or_else(|| t!("services.semanticModel.noRayfinCli"))?
  };
  let script_path =
    write_helper().map_err(|err| t!("services.semanticModel.helperFailed", error = err))?;

  let auth_str = auth_path.to_string_lossy().to_string();
  let script_str = script_path.to_string_lossy().to_string();
  let request_str = request.to_string();
  let args = [script_str.as_str(), auth_str.as_str(), request_str.as_str()];
  let opts = RunOptions::timeout(HELPER_TIMEOUT_MS);
  // Schema reads use the Azure CLI; every other mode opens the Rayfin CLI's token cache.
  let res = if request["mode"] == "schema" {
    exec::run("node", &args, opts).await
  } else {
    fabric_auth::run_helper(&args, opts).await
  };

  fabric_auth::parse_helper_output(&res)
}

/// Read the schema (tables/columns/measures/relationships) of the semantic model
/// `item_id` in workspace `workspace_id` — the data behind the Model tab's
/// semantic-model diagram. Reads the model definition with the Azure CLI's
/// Fabric token (the helper's `schema` mode), independently of Rayfin auth. Never
/// panics — every failure path returns an `ok:false` [`SemanticSchemaResult`]
/// the UI can render (with login classification for a sign-in CTA).
pub async fn schema_semantic_model(workspace_id: &str, item_id: &str) -> SemanticSchemaResult {
  let request = serde_json::json!({
    "mode": "schema",
    "workspaceId": workspace_id,
    "itemId": item_id,
  });
  match invoke_helper(&request).await {
    Ok(result) => result,
    Err(detail) => SemanticSchemaResult::failure(detail),
  }
}

/// List the semantic models (datasets) in `workspace_id` — the data behind the
/// "connect a model from your workspace" picker. Uses the silent Fabric token
/// (the helper's `listWorkspaceModels` mode). Never panics — a failure returns an
/// `ok:false` [`WorkspaceModelsResult`] with login classification.
pub async fn list_workspace_models(workspace_id: &str) -> WorkspaceModelsResult {
  let request = serde_json::json!({
    "mode": "listWorkspaceModels",
    "workspaceId": workspace_id,
  });
  match invoke_helper(&request).await {
    Ok(result) => result,
    Err(detail) => WorkspaceModelsResult::failure(detail),
  }
}

/// List the items in `workspace_id` that a Rayfin connector can read (semantic
/// models, warehouses, SQL databases and lakehouses), with the silent Fabric
/// token (the helper's `listWorkspaceData` mode). Any workspace the user can open
/// works. Never panics — a failure returns an `ok:false` [`WorkspaceDataResult`]
/// with login classification.
pub async fn list_workspace_data(workspace_id: &str) -> WorkspaceDataResult {
  let request = serde_json::json!({
    "mode": "listWorkspaceData",
    "workspaceId": workspace_id,
  });
  match invoke_helper(&request).await {
    Ok(result) => result,
    Err(detail) => WorkspaceDataResult::failure(detail),
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
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src").join("services").join("semantic_model_helper.mjs");
    let out = std::process::Command::new("node")
      .arg(&script)
      .arg("--selftest")
      .output();
    match out {
      Ok(o) => assert!(
        o.status.success(),
        "parseTarget selftest failed: {}",
        String::from_utf8_lossy(&o.stderr)
      ),
      Err(_) => { /* node unavailable; parsing covered by `node --selftest` in dev */ }
    }
  }

  /// The helper's `listWorkspaceData` reply keeps each item's Fabric type, and a
  /// sign-in failure comes back as `needsLogin`.
  #[test]
  fn workspace_data_reply_deserializes() {
    let json = r#"{"ok":true,"items":[{"id":"l1","name":"orders","type":"Lakehouse","description":"Raw orders"},{"id":"m1","name":"Sales","type":"SemanticModel"}]}"#;
    let parsed: WorkspaceDataResult = serde_json::from_str(json).unwrap();
    assert!(parsed.ok && !parsed.needs_login);
    assert_eq!(
      parsed.items[0],
      WorkspaceDataItem { id: "l1".into(), name: "orders".into(), item_type: "Lakehouse".into(), description: Some("Raw orders".into()) }
    );
    assert_eq!(serde_json::to_value(&parsed.items[1]).unwrap()["type"], "SemanticModel");
    let failed: WorkspaceDataResult =
      serde_json::from_str(r#"{"ok":false,"needsLogin":true,"error":"Sign in to Fabric."}"#).unwrap();
    assert!(!failed.ok && failed.needs_login && failed.items.is_empty());
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
