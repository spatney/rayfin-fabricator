//! Fabric REST calls for team workspaces, made as the signed-in user with an
//! Azure CLI token. That works from Home before any project is open (the
//! per-project Rayfin sign-in isn't needed) and keeps the tenant aligned with the
//! Entra calls in [`super::entra`].

use std::time::Duration;

use serde_json::{json, Value};

use super::entra;
use crate::types::FabricCapacity;

const API: &str = "https://api.fabric.microsoft.com/v1";
const RESOURCE: &str = "https://api.fabric.microsoft.com";

#[derive(Debug, Clone)]
pub struct FabricError {
  pub status: Option<u16>,
  pub code: Option<String>,
  pub message: String,
  /// The Azure CLI sign-in needs attention.
  pub needs_login: bool,
}

impl FabricError {
  fn new(message: impl Into<String>) -> Self {
    FabricError { status: None, code: None, message: message.into(), needs_login: false }
  }

  pub fn describe(&self, action: &str) -> String {
    if self.needs_login {
      return t!("team.az.describe.expired", action = action);
    }
    format!("{action}: {}", self.message)
  }

  /// "HTTP 403 InsufficientPrivileges: …" for diagnosis evidence.
  pub fn summary(&self) -> String {
    match (self.status, &self.code) {
      (Some(s), Some(c)) => format!("HTTP {s} {c}: {}", self.message),
      (Some(s), None) => format!("HTTP {s}: {}", self.message),
      _ => self.message.clone(),
    }
  }
}

impl From<entra::AzError> for FabricError {
  fn from(e: entra::AzError) -> Self {
    FabricError {
      status: None,
      code: None,
      needs_login: matches!(e.kind, entra::AzErrorKind::NeedsLogin | entra::AzErrorKind::Missing),
      message: e.message,
    }
  }
}

async fn request(method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, FabricError> {
  let token = entra::token(RESOURCE).await?;
  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(60))
    .build()
    .map_err(|e| FabricError::new(e.to_string()))?;
  let mut req = client.request(method, format!("{API}/{}", path.trim_start_matches('/'))).bearer_auth(token);
  if let Some(b) = body {
    req = req.json(&b);
  }
  let res = req.send().await.map_err(|e| FabricError::new(t!("team.fabric.unreachable", error = e)))?;
  let status = res.status();
  let text = res.text().await.unwrap_or_default();
  let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
  if status.is_success() {
    return Ok(parsed);
  }
  let code = parsed.get("errorCode").and_then(Value::as_str).map(String::from);
  let message = parsed
    .get("message")
    .and_then(Value::as_str)
    .map(String::from)
    .unwrap_or_else(|| t!("team.fabric.httpStatus", status = status.as_u16()));
  Err(FabricError { status: Some(status.as_u16()), code, message, needs_login: status.as_u16() == 401 })
}

/// GET a Fabric REST path as the signed-in user. Read-only: used to explain
/// why a team workspace step failed.
pub async fn get(path: &str) -> Result<Value, FabricError> {
  request(reqwest::Method::GET, path, None).await
}

/// Capacities the user can create workspaces on (F and P SKUs that are active).
pub async fn capacities() -> Result<Vec<FabricCapacity>, FabricError> {
  let v = request(reqwest::Method::GET, "capacities", None).await?;
  Ok(
    v.get("value")
      .and_then(Value::as_array)
      .map(|items| items.iter().filter_map(capacity_of).filter(|c| c.eligible).collect())
      .unwrap_or_default(),
  )
}

fn capacity_kind(sku: &str) -> &'static str {
  let s = sku.to_ascii_uppercase();
  if s.starts_with('F') {
    "fabric"
  } else if s.starts_with("PP") {
    "other"
  } else if s.starts_with('P') {
    "premium"
  } else {
    "other"
  }
}

fn capacity_of(v: &Value) -> Option<FabricCapacity> {
  let sku = v.get("sku").and_then(Value::as_str).map(String::from);
  let kind = sku.as_deref().map(capacity_kind).unwrap_or("other").to_string();
  let active = v.get("state").and_then(Value::as_str).is_none_or(|s| s == "Active");
  Some(FabricCapacity {
    id: v.get("id")?.as_str()?.to_string(),
    display_name: v.get("displayName").and_then(Value::as_str).unwrap_or_default().to_string(),
    region: v.get("region").and_then(Value::as_str).map(String::from),
    eligible: (kind == "fabric" || kind == "premium") && active,
    kind,
    sku,
  })
}

/// Create a workspace on `capacity_id`. Returns (id, display name); a taken
/// name gets a numeric suffix.
pub async fn create_workspace(name: &str, capacity_id: &str) -> Result<(String, String), FabricError> {
  let mut attempt = name.to_string();
  for n in 2..=6 {
    match request(
      reqwest::Method::POST,
      "workspaces",
      Some(json!({ "displayName": attempt, "capacityId": capacity_id, "description": "Created by Fabricator for a team workspace." })),
    )
    .await
    {
      Ok(v) => {
        let id = v.get("id").and_then(Value::as_str).ok_or_else(|| FabricError::new(t!("team.fabric.noWorkspaceId")))?;
        return Ok((id.to_string(), attempt));
      }
      Err(e) if e.code.as_deref() == Some("WorkspaceNameAlreadyExists") || e.status == Some(409) => {
        attempt = format!("{name} ({n})");
      }
      Err(e) => return Err(e),
    }
  }
  Err(FabricError::new(t!("team.fabric.namesTaken")))
}

/// One role assignment on a Fabric workspace.
#[derive(Debug, Clone, PartialEq)]
pub struct RoleAssignment {
  pub principal_id: String,
  /// `User`, `Group`, `ServicePrincipal`, …
  pub principal_type: String,
  pub role: String,
  pub display_name: Option<String>,
  pub email: Option<String>,
}

fn role_assignment(a: &Value) -> Option<RoleAssignment> {
  let p = a.get("principal")?;
  let text = |v: Option<&Value>| v.and_then(Value::as_str).map(String::from).filter(|s| !s.is_empty());
  Some(RoleAssignment {
    principal_id: p.get("id")?.as_str()?.to_string(),
    principal_type: text(p.get("type")).unwrap_or_default(),
    role: text(a.get("role")).unwrap_or_default(),
    display_name: text(p.get("displayName")),
    email: text(p.get("userDetails").and_then(|u| u.get("userPrincipalName"))),
  })
}

/// Every role assignment on the workspace (needs Member or Admin).
pub async fn role_assignments(workspace_id: &str) -> Result<Vec<RoleAssignment>, FabricError> {
  let v = request(reqwest::Method::GET, &format!("workspaces/{workspace_id}/roleAssignments"), None).await?;
  Ok(
    v.get("value")
      .and_then(Value::as_array)
      .map(|items| items.iter().filter_map(role_assignment).collect())
      .unwrap_or_default(),
  )
}

/// Give a principal (`User`, `Group` or `ServicePrincipal`) a workspace role.
/// Already having a role counts as success.
pub async fn add_role(workspace_id: &str, principal_id: &str, principal_type: &str, role: &str) -> Result<(), FabricError> {
  let body = json!({ "principal": { "id": principal_id, "type": principal_type }, "role": role });
  match request(reqwest::Method::POST, &format!("workspaces/{workspace_id}/roleAssignments"), Some(body)).await {
    Ok(_) => Ok(()),
    Err(e) if e.status == Some(409) || e.code.as_deref() == Some("PrincipalAlreadyHasWorkspaceRolePermissions") => Ok(()),
    Err(e) => Err(e),
  }
}

/// Remove a principal's role (missing assignments are fine).
pub async fn remove_role(workspace_id: &str, principal_id: &str) -> Result<(), FabricError> {
  match request(
    reqwest::Method::DELETE,
    &format!("workspaces/{workspace_id}/roleAssignments/{principal_id}"),
    None,
  )
  .await
  {
    Ok(_) => Ok(()),
    Err(e) if e.status == Some(404) => Ok(()),
    Err(e) => Err(e),
  }
}

pub async fn delete_workspace(workspace_id: &str) -> Result<(), FabricError> {
  match request(reqwest::Method::DELETE, &format!("workspaces/{workspace_id}"), None).await {
    Ok(_) => Ok(()),
    Err(e) if e.status == Some(404) => Ok(()),
    Err(e) => Err(e),
  }
}

pub async fn delete_item(workspace_id: &str, item_id: &str) -> Result<(), FabricError> {
  match request(reqwest::Method::DELETE, &format!("workspaces/{workspace_id}/items/{item_id}"), None).await {
    Ok(_) => Ok(()),
    Err(e) if e.status == Some(404) => Ok(()),
    Err(e) => Err(e),
  }
}

/// A Rayfin app's secrets: names, descriptions and dates, never values. The
/// same Fabric passthrough `rayfin secret list` reads.
pub async fn app_secrets(workspace_id: &str, item_id: &str) -> Result<Value, FabricError> {
  request(
    reqwest::Method::GET,
    &format!("workspaces/{workspace_id}/appBackends/{item_id}/__private/secrets"),
    None,
  )
  .await
}

/// (item id, display name) for every item in the workspace.
pub async fn items(workspace_id: &str) -> Result<Vec<(String, String)>, FabricError> {
  let v = request(reqwest::Method::GET, &format!("workspaces/{workspace_id}/items"), None).await?;
  Ok(
    v.get("value")
      .and_then(Value::as_array)
      .map(|items| {
        items
          .iter()
          .filter_map(|i| {
            Some((
              i.get("id")?.as_str()?.to_string(),
              i.get("displayName").and_then(Value::as_str).unwrap_or_default().to_string(),
            ))
          })
          .collect()
      })
      .unwrap_or_default(),
  )
}

/// Fabric's item type for a Rayfin app (what `rayfin up` creates and reuses).
const APP_ITEM_TYPE: &str = "AppBackend";
const APP_NAMES_TTL: Duration = Duration::from_secs(60);

/// Percent-encode a query value (RFC 3986 unreserved characters pass through).
fn query_value(raw: &str) -> String {
  raw
    .bytes()
    .map(|b| match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
      _ => format!("%{b:02X}"),
    })
    .collect()
}

static APP_NAMES: once_cell::sync::Lazy<std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Vec<String>)>>> =
  once_cell::sync::Lazy::new(Default::default);

/// Display names of the Rayfin apps in a workspace (all pages), cached briefly
/// so checking a name while someone types doesn't call Fabric on every key.
pub async fn app_item_names(workspace_id: &str) -> Result<Vec<String>, FabricError> {
  if let Some((at, names)) = APP_NAMES.lock().unwrap().get(workspace_id) {
    if at.elapsed() < APP_NAMES_TTL {
      return Ok(names.clone());
    }
  }
  let mut names = Vec::new();
  let mut continuation: Option<String> = None;
  for _ in 0..50 {
    let mut path = format!("workspaces/{workspace_id}/items?type={APP_ITEM_TYPE}");
    if let Some(token) = &continuation {
      path.push_str(&format!("&continuationToken={}", query_value(token)));
    }
    let page = request(reqwest::Method::GET, &path, None).await?;
    names.extend(
      page
        .get("value")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|i| i.get("displayName").and_then(Value::as_str).map(String::from)),
    );
    continuation = page.get("continuationToken").and_then(Value::as_str).filter(|t| !t.is_empty()).map(String::from);
    if continuation.is_none() {
      break;
    }
  }
  APP_NAMES.lock().unwrap().insert(workspace_id.to_string(), (std::time::Instant::now(), names.clone()));
  Ok(names)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn continuation_tokens_are_query_encoded() {
    assert_eq!(query_value("ab+/=c d"), "ab%2B%2F%3Dc%20d");
    assert_eq!(query_value("A-z_0.9~"), "A-z_0.9~");
  }

  #[test]
  fn capacities_match_the_existing_eligibility_rules() {
    let cap = |sku: &str, state: &str| {
      capacity_of(&json!({"id":"c","displayName":"Cap","sku":sku,"region":"westus","state":state})).unwrap()
    };
    assert!(cap("F2", "Active").eligible);
    assert!(cap("P1", "Active").eligible);
    assert!(!cap("PP3", "Active").eligible);
    assert!(!cap("F2", "Paused").eligible);
    assert_eq!(cap("F64", "Active").kind, "fabric");
    assert!(capacity_of(&json!({"displayName":"no id"})).is_none());
  }

  #[test]
  fn role_assignments_carry_who_has_access() {
    let user = role_assignment(&json!({
      "id": "a1", "role": "Contributor",
      "principal": {"id": "u1", "displayName": "Amy", "type": "User", "userDetails": {"userPrincipalName": "amy@contoso.com"}}
    }))
    .unwrap();
    assert_eq!(user.principal_id, "u1");
    assert_eq!(user.email.as_deref(), Some("amy@contoso.com"));
    let sp = role_assignment(&json!({
      "id": "a2", "role": "Contributor",
      "principal": {"id": "s1", "displayName": "Fabricator deploy - Team", "type": "ServicePrincipal"}
    }))
    .unwrap();
    assert_eq!(sp.principal_type, "ServicePrincipal");
    assert_eq!(sp.email, None);
  }
}
