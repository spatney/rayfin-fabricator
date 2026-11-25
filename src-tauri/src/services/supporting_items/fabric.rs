//! Fabric calls for supporting items, made by a short-lived Node helper
//! (`supporting_items_helper.mjs`) as the app's Fabric account ([`Account`]):
//! the Rayfin CLI's sign-in in the app's folder, which publishes the app and
//! checks its connectors, so its supporting items are where the app can read
//! them. That account's Power BI token can't start a refresh; the helper then
//! uses the Azure CLI's, when it's signed in to the same organization. Like the
//! other Fabric helpers, tokens stay in the helper; Rust reads its one line of
//! JSON.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};

use super::Part;
use crate::services::exec::{self, RunOptions};
use crate::services::{fabric_auth, paths};

/// The helper, embedded at compile time and written beside `fabric_auth_helper.mjs`, which it imports.
const HELPER_SOURCE: &str = include_str!("../supporting_items_helper.mjs");

/// Creating or changing a model polls Fabric for up to 10 minutes.
const WRITE_TIMEOUT_MS: u64 = 12 * 60_000;
/// Loading a table polls Fabric for up to 30 minutes.
const LOAD_TIMEOUT_MS: u64 = 32 * 60_000;
/// Reading takes a few seconds; a large model's definition can take longer.
const READ_TIMEOUT_MS: u64 = 4 * 60_000;

/// The app's Fabric account: Fabric calls are made as it, through the Rayfin
/// CLI installed in the app's folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
  auth_module: PathBuf,
}

impl Account {
  /// The Fabric account of the app in `project_dir`.
  pub fn of(project_dir: &Path) -> Result<Account, Failure> {
    crate::services::exec::project_rayfin_auth_module(Some(project_dir))
      .map(|auth_module| Account { auth_module })
      .ok_or_else(|| Failure {
        message: "The app's Rayfin CLI isn't installed, so Fabricator can't sign in to Fabric as its account. Install \
                  the app's packages (npm install), then try again."
          .into(),
        ..Default::default()
      })
  }
}

/// Who Fabric calls are made as.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SignedIn {
  pub user: Option<String>,
  pub tenant: Option<String>,
}

/// Why a call didn't work.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Failure {
  /// What happened, in a sentence, with Fabric's own error.
  pub message: String,
  /// The user has to sign in to Fabric again.
  pub needs_login: bool,
  /// The Azure CLI isn't installed, or the user has to sign in to it.
  pub needs_az: bool,
  /// The HTTP status Fabric answered with.
  pub status: Option<u16>,
  /// Fabric's or Power BI's error code.
  pub code: Option<String>,
  /// Fabric's further details, as `code: message`.
  pub details: Vec<String>,
  /// Another item of the type has the name in the workspace.
  pub name_in_use: bool,
  /// The user isn't allowed to do it in the workspace.
  pub forbidden: bool,
  pub not_found: bool,
  /// Applying the change would discard data the model has loaded.
  pub purge_required: bool,
  /// A refresh is already running.
  pub already_running: bool,
  /// Power BI lets the app's Fabric account read the model but not refresh it,
  /// and the Azure CLI isn't signed in to the same organization.
  pub refresh_not_allowed: bool,
  /// Files can't go up to OneLake: the Azure CLI, which uploads them, isn't
  /// signed in to the app's Fabric account's organization.
  pub upload_not_allowed: bool,
}

impl Failure {
  fn of(value: &Value) -> Self {
    let flag = |key: &str| value.get(key).and_then(Value::as_bool).unwrap_or(false);
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let details = value
      .get("details")
      .and_then(Value::as_array)
      .map(|list| {
        list
          .iter()
          .filter_map(|d| {
            let message = d.get("message").and_then(Value::as_str)?.trim();
            Some(match d.get("code").and_then(Value::as_str) {
              Some(code) if !code.is_empty() => format!("{code}: {message}"),
              _ => message.to_string(),
            })
          })
          .collect()
      })
      .unwrap_or_default();
    Failure {
      message: text("error").unwrap_or_else(|| "Fabric didn't say what went wrong.".into()),
      needs_login: flag("needsLogin"),
      needs_az: flag("needsAz"),
      status: value.get("status").and_then(Value::as_u64).and_then(|s| u16::try_from(s).ok()),
      code: text("errorCode"),
      details,
      name_in_use: flag("nameInUse"),
      forbidden: flag("forbidden"),
      not_found: flag("notFound"),
      purge_required: flag("purgeRequired"),
      already_running: flag("alreadyRunning"),
      refresh_not_allowed: flag("refreshNotAllowed"),
      upload_not_allowed: flag("uploadNotAllowed"),
    }
  }

  fn plain(message: String) -> Self {
    let (needs_login, needs_az) = fabric_auth::failure_flags(&message);
    Failure { message, needs_login, needs_az, ..Default::default() }
  }

  /// The user has to sign in again: to Fabric, or to the Azure CLI.
  pub fn signs_in(&self) -> bool {
    self.needs_login || self.needs_az
  }
}

/// An item in a workspace.
#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FabricItem {
  pub id: String,
  pub display_name: String,
  #[serde(rename = "type")]
  pub item_type: String,
  pub description: Option<String>,
}

/// Who Fabric calls are made as: the app's Fabric account, when it's signed in.
pub async fn signed_in(account: &Account) -> Result<SignedIn, Failure> {
  let reply = call(account, json!({ "mode": "account" }), READ_TIMEOUT_MS).await?;
  let text = |key: &str| reply.get(key).and_then(Value::as_str).map(str::to_string).filter(|s| !s.trim().is_empty());
  Ok(SignedIn { user: text("user"), tenant: text("tenant") })
}

/// The shared workspaces the user can create items in, by name.
pub async fn list_workspaces(account: &Account) -> Result<Vec<super::Workspace>, Failure> {
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct Listed {
    id: String,
    display_name: String,
  }
  let reply = call(account, json!({ "mode": "listWorkspaces" }), READ_TIMEOUT_MS).await?;
  let listed: Vec<Listed> = serde_json::from_value(reply.get("workspaces").cloned().unwrap_or_default())
    .map_err(|e| Failure::plain(format!("Fabric's list of workspaces can't be read ({e}).")))?;
  Ok(listed.into_iter().map(|w| super::Workspace { id: w.id, name: w.display_name }).collect())
}

/// A refresh Power BI started.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Started {
  /// An enhanced refresh's id, to follow that refresh; without one, the
  /// model's latest refresh is followed.
  pub refresh_id: Option<String>,
}

/// One message a refresh left.
#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct RefreshError {
  pub code: Option<String>,
  pub message: String,
}

/// How a refresh is going.
#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RefreshStatus {
  /// `notStarted`, `running`, `succeeded`, `failed`, `cancelled` or `unknown`.
  pub status: String,
  pub refresh_id: Option<String>,
  pub start_time: Option<String>,
  pub end_time: Option<String>,
  pub errors: Vec<RefreshError>,
  /// The data source needs credentials set in Fabric.
  pub needs_credentials: bool,
}

impl RefreshStatus {
  /// It has ended, one way or another.
  pub fn finished(&self) -> bool {
    matches!(self.status.as_str(), "succeeded" | "failed" | "cancelled")
  }
}

fn write_helper() -> std::io::Result<PathBuf> {
  fabric_auth::write_helper()?;
  static PATH: OnceLock<PathBuf> = OnceLock::new();
  if let Some(path) = PATH.get() {
    return Ok(path.clone());
  }
  let path = paths::ensure_data_dir()?.join("supporting-items.mjs");
  std::fs::write(&path, HELPER_SOURCE)?;
  let _ = PATH.set(path.clone());
  Ok(path)
}

/// Run the helper with `request` and read its reply: the reply when it says
/// `ok`, else why not. Requests that carry a definition go in a file, which can
/// be far longer than a command line.
async fn call(account: &Account, mut request: Value, timeout_ms: u64) -> Result<Value, Failure> {
  let script = write_helper().map_err(|e| Failure::plain(format!("Fabricator couldn't prepare its Fabric helper ({e}).")))?;
  request["authModule"] = json!(account.auth_module.to_string_lossy());
  let text = request.to_string();
  let file = if text.len() > 4_000 {
    let path = paths::ensure_data_dir()
      .map_err(|e| Failure::plain(format!("Fabricator couldn't prepare its Fabric request ({e}).")))?
      .join(format!("supporting-request-{}.json", uuid::Uuid::new_v4()));
    std::fs::write(&path, &text)
      .map_err(|e| Failure::plain(format!("Fabricator couldn't prepare its Fabric request ({e}).")))?;
    Some(path)
  } else {
    None
  };
  let arg = match &file {
    Some(path) => format!("@{}", path.to_string_lossy()),
    None => text,
  };
  let script = script.to_string_lossy().to_string();
  let res = exec::run("node", &[script.as_str(), arg.as_str()], RunOptions::timeout(timeout_ms)).await;
  if let Some(path) = file {
    let _ = std::fs::remove_file(path);
  }
  let value: Value = fabric_auth::parse_helper_output(&res).map_err(Failure::plain)?;
  if value.get("ok").and_then(Value::as_bool) == Some(true) {
    Ok(value)
  } else {
    Err(Failure::of(&value))
  }
}

fn wire_parts(parts: &[Part]) -> Vec<Value> {
  parts
    .iter()
    .map(|p| json!({ "path": p.path, "payload": base64::engine::general_purpose::STANDARD.encode(&p.bytes) }))
    .collect()
}

/// The parts of a definition Fabric returned.
fn parts_of(value: &Value) -> Result<Vec<Part>, Failure> {
  let list = value.get("parts").and_then(Value::as_array).cloned().unwrap_or_default();
  list
    .iter()
    .map(|p| {
      let path = p.get("path").and_then(Value::as_str).unwrap_or_default().to_string();
      let payload = p.get("payload").and_then(Value::as_str).unwrap_or_default();
      let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| Failure::plain(format!("Fabric returned a definition Fabricator can't read ({path}: {e}).")))?;
      Ok(Part { path, bytes })
    })
    .collect()
}

fn item_of(value: &Value) -> Option<FabricItem> {
  if value.get("found").and_then(Value::as_bool) == Some(false) {
    return None;
  }
  value.get("item").and_then(|item| serde_json::from_value(item.clone()).ok()).filter(|i: &FabricItem| !i.id.is_empty())
}

/// The item `item_id` in `workspace_id`: `None` when it's gone.
pub async fn get_item(account: &Account, workspace_id: &str, item_id: &str) -> Result<Option<FabricItem>, Failure> {
  let reply = call(account, json!({ "mode": "getItem", "workspaceId": workspace_id, "itemId": item_id }), READ_TIMEOUT_MS).await?;
  Ok(item_of(&reply))
}

/// The item of `item_type` named `name` in `workspace_id`, if there's one.
pub async fn find_item(account: &Account, workspace_id: &str, item_type: &str, name: &str) -> Result<Option<FabricItem>, Failure> {
  let request = json!({ "mode": "findItem", "workspaceId": workspace_id, "type": item_type, "displayName": name });
  Ok(item_of(&call(account, request, READ_TIMEOUT_MS).await?))
}

/// A semantic model's definition in TMDL.
pub async fn get_definition(account: &Account, workspace_id: &str, item_id: &str) -> Result<Vec<Part>, Failure> {
  let request = json!({ "mode": "getDefinition", "workspaceId": workspace_id, "itemId": item_id, "format": "TMDL" });
  parts_of(&call(account, request, READ_TIMEOUT_MS).await?)
}

/// Create a semantic model from `parts`; its id.
pub async fn create(account: &Account, workspace_id: &str, name: &str, description: &str, parts: &[Part]) -> Result<String, Failure> {
  let request = json!({
    "mode": "create",
    "workspaceId": workspace_id,
    "displayName": name,
    "description": description,
    "parts": wire_parts(parts),
  });
  let reply = call(account, request, WRITE_TIMEOUT_MS).await?;
  reply
    .get("itemId")
    .and_then(Value::as_str)
    .filter(|id| !id.is_empty())
    .map(str::to_string)
    .ok_or_else(|| Failure::plain("Fabric created the semantic model but didn't say its id.".into()))
}

/// Replace a semantic model's definition with `parts`, discarding data it has
/// loaded that no longer fits only when `allow_purge_data` says so.
pub async fn update(account: &Account, workspace_id: &str, item_id: &str, parts: &[Part], allow_purge_data: bool) -> Result<(), Failure> {
  let request = json!({
    "mode": "updateDefinition",
    "workspaceId": workspace_id,
    "itemId": item_id,
    "parts": wire_parts(parts),
    "allowPurgeData": allow_purge_data,
  });
  call(account, request, WRITE_TIMEOUT_MS).await.map(|_| ())
}

/// Start loading a semantic model's data.
pub async fn refresh(account: &Account, workspace_id: &str, item_id: &str) -> Result<Started, Failure> {
  let reply = call(account, json!({ "mode": "refresh", "workspaceId": workspace_id, "itemId": item_id }), READ_TIMEOUT_MS).await?;
  Ok(Started { refresh_id: reply.get("refreshId").and_then(Value::as_str).map(str::to_string) })
}

/// How a semantic model's refresh is going: `refresh_id`'s, else its latest.
pub async fn refresh_status(account: &Account, workspace_id: &str, item_id: &str, refresh_id: Option<&str>) -> Result<RefreshStatus, Failure> {
  let mut request = json!({ "mode": "refreshStatus", "workspaceId": workspace_id, "itemId": item_id });
  if let Some(id) = refresh_id {
    request["refreshId"] = json!(id);
  }
  let reply = call(account, request, READ_TIMEOUT_MS).await?;
  serde_json::from_value(reply).map_err(|e| Failure::plain(format!("Power BI's refresh status can't be read ({e}).")))
}

/// Delete an item. Already gone counts as deleted.
pub async fn delete(account: &Account, workspace_id: &str, item_id: &str) -> Result<(), Failure> {
  call(account, json!({ "mode": "delete", "workspaceId": workspace_id, "itemId": item_id }), READ_TIMEOUT_MS).await.map(|_| ())
}

/* ------------------------------- lakehouses ------------------------------- */

/// A lakehouse in Fabric.
#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Lakehouse {
  pub id: String,
  pub display_name: String,
  /// `https://<org>-onelake.dfs.fabric.microsoft.com/<workspace id>/<item id>/Files`.
  pub one_lake_files_path: Option<String>,
  pub one_lake_tables_path: Option<String>,
  pub sql_endpoint: Option<String>,
  pub sql_endpoint_id: Option<String>,
}

impl Lakehouse {
  /// Its OneLake address, on the host Fabric gave for its organization.
  pub fn one_lake(&self) -> Option<String> {
    let files = self.one_lake_files_path.as_deref()?;
    let root = files.trim_end_matches('/').strip_suffix("/Files")?;
    Some(root.to_string())
  }
}

/// Create a lakehouse, without schemas; its id.
pub async fn create_lakehouse(account: &Account, workspace_id: &str, name: &str, description: &str) -> Result<String, Failure> {
  let request = json!({ "mode": "createLakehouse", "workspaceId": workspace_id, "displayName": name, "description": description });
  let reply = call(account, request, WRITE_TIMEOUT_MS).await?;
  reply
    .get("itemId")
    .and_then(Value::as_str)
    .filter(|id| !id.is_empty())
    .map(str::to_string)
    .ok_or_else(|| Failure::plain("Fabric created the lakehouse but didn't say its id.".into()))
}

/// The lakehouse `item_id`: `None` when it's gone.
pub async fn get_lakehouse(account: &Account, workspace_id: &str, item_id: &str) -> Result<Option<Lakehouse>, Failure> {
  let reply = call(account, json!({ "mode": "getLakehouse", "workspaceId": workspace_id, "itemId": item_id }), READ_TIMEOUT_MS).await?;
  if reply.get("found").and_then(Value::as_bool) != Some(true) {
    return Ok(None);
  }
  serde_json::from_value(reply.get("lakehouse").cloned().unwrap_or_default())
    .map(Some)
    .map_err(|e| Failure::plain(format!("Fabric's answer about the lakehouse can't be read ({e}).")))
}

/// The names of a lakehouse's tables.
pub async fn list_tables(account: &Account, workspace_id: &str, item_id: &str) -> Result<Vec<String>, Failure> {
  let reply = call(account, json!({ "mode": "listTables", "workspaceId": workspace_id, "itemId": item_id }), READ_TIMEOUT_MS).await?;
  Ok(
    reply
      .get("tables")
      .and_then(Value::as_array)
      .map(|tables| tables.iter().filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_string)).collect())
      .unwrap_or_default(),
  )
}

/// Whether files can go up to OneLake, and as whom: the Azure CLI's account.
pub async fn upload_check(account: &Account) -> Result<Option<String>, Failure> {
  let reply = call(account, json!({ "mode": "uploadCheck" }), READ_TIMEOUT_MS).await?;
  Ok(reply.get("user").and_then(Value::as_str).map(str::to_string).filter(|u| !u.trim().is_empty()))
}

/// A file to upload: from `local`, to `remote` in the lakehouse's Files (`Files/data/orders.csv`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upload {
  pub local: PathBuf,
  pub remote: String,
}

/// Upload `files` to the lakehouse's Files, replacing files of the same name.
/// It allows a minute for each 20 MB, on top of five minutes.
pub async fn upload_files(account: &Account, workspace_id: &str, item_id: &str, one_lake: Option<&str>, files: &[Upload], bytes: u64) -> Result<(), Failure> {
  let request = json!({
    "mode": "uploadFiles",
    "workspaceId": workspace_id,
    "itemId": item_id,
    "oneLake": one_lake,
    "files": files.iter().map(|f| json!({ "local": f.local.to_string_lossy(), "remote": f.remote })).collect::<Vec<_>>(),
  });
  let timeout = 5 * 60_000 + (bytes / (20 << 20) + 1) * 60_000;
  call(account, request, timeout).await.map(|_| ())
}

/// How to load a table, from files in the lakehouse's Files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Load {
  pub table: String,
  /// `Files/data/orders.csv`, or a folder.
  pub relative_path: String,
  pub folder: bool,
  pub format: super::lakehouse::Format,
  pub header: bool,
  pub delimiter: char,
}

/// Load a table, replacing what it held.
pub async fn load_table(account: &Account, workspace_id: &str, item_id: &str, load: &Load) -> Result<(), Failure> {
  let request = json!({
    "mode": "loadTable",
    "workspaceId": workspace_id,
    "itemId": item_id,
    "table": load.table,
    "relativePath": load.relative_path,
    "pathType": if load.folder { "Folder" } else { "File" },
    "format": load.format.wire(),
    "header": load.header,
    "delimiter": load.delimiter.to_string(),
  });
  call(account, request, LOAD_TIMEOUT_MS).await.map(|_| ())
}

/// A table's columns, as its Delta log says.
pub async fn table_schema(account: &Account, workspace_id: &str, item_id: &str, one_lake: Option<&str>, table: &str) -> Result<Vec<super::lakehouse::TableColumn>, Failure> {
  let request = json!({ "mode": "tableSchema", "workspaceId": workspace_id, "itemId": item_id, "oneLake": one_lake, "table": table });
  let reply = call(account, request, READ_TIMEOUT_MS).await?;
  serde_json::from_value(reply.get("columns").cloned().unwrap_or_default())
    .map_err(|e| Failure::plain(format!("The table's columns can't be read ({e}).")))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_failure_keeps_what_fabric_said() {
    let failure = Failure::of(&json!({
      "ok": false, "needsAz": false, "needsLogin": false,
      "error": "Fabric couldn't create the semantic model (HTTP 400, ItemDisplayNameAlreadyInUse): Name in use.",
      "status": 400, "errorCode": "ItemDisplayNameAlreadyInUse", "nameInUse": true,
      "details": [{ "code": "Conflict", "message": "Another item has it." }, { "message": "Pick another." }]
    }));
    assert!(failure.name_in_use && !failure.forbidden && !failure.needs_az);
    assert_eq!(failure.status, Some(400));
    assert_eq!(failure.code.as_deref(), Some("ItemDisplayNameAlreadyInUse"));
    assert_eq!(failure.details, ["Conflict: Another item has it.", "Pick another."]);
  }

  #[test]
  fn a_definition_comes_back_as_its_parts() {
    let parts = parts_of(&json!({ "ok": true, "parts": [
      { "path": "definition/model.tmdl", "payload": "bW9kZWwgTW9kZWw=" },
      { "path": "definition.pbism", "payload": "e30=" }
    ]}))
    .unwrap();
    assert_eq!(parts[0], Part { path: "definition/model.tmdl".into(), bytes: b"model Model".to_vec() });
    assert_eq!(parts[1].bytes, b"{}");
    assert!(parts_of(&json!({ "parts": [{ "path": "x", "payload": "not base64!" }] })).is_err());
  }

  #[test]
  fn parts_go_to_fabric_in_base64() {
    let wire = wire_parts(&[Part { path: ".platform".into(), bytes: b"{}".to_vec() }]);
    assert_eq!(wire, [json!({ "path": ".platform", "payload": "e30=" })]);
  }

  #[test]
  fn an_item_found_or_not() {
    let found = json!({ "ok": true, "found": true, "item": { "id": "i1", "displayName": "Sales", "type": "SemanticModel" } });
    assert_eq!(item_of(&found).map(|i| i.display_name), Some("Sales".into()));
    assert_eq!(item_of(&json!({ "ok": true, "found": false })), None);
  }

  #[test]
  fn a_refresh_status_says_when_it_ended() {
    let status: RefreshStatus = serde_json::from_value(json!({
      "ok": true, "status": "failed", "errors": [{ "code": "DuplicateKey", "message": "Column 'CustomerKey' has duplicates." }],
      "needsCredentials": false
    }))
    .unwrap();
    assert!(status.finished());
    assert_eq!(status.errors[0].message, "Column 'CustomerKey' has duplicates.");
    let running: RefreshStatus = serde_json::from_value(json!({ "ok": true, "status": "running", "errors": [] })).unwrap();
    assert!(!running.finished());
  }

  /// The helper's own tests (offline: they stub Fabric and the Azure CLI).
  #[test]
  fn supporting_items_helper_regressions() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .join("src")
      .join("services")
      .join("supporting_items_helper.test.mjs");
    let output = match std::process::Command::new("node").arg("--test").arg(script).output() {
      Ok(output) => output,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
      Err(error) => panic!("Could not run the supporting items helper's tests: {error}"),
    };
    assert!(
      output.status.success(),
      "{}\n{}",
      String::from_utf8_lossy(&output.stdout),
      String::from_utf8_lossy(&output.stderr)
    );
  }
}
