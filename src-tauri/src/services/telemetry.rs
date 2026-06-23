//! Pseudonymous usage telemetry — the Rust counterpart to
//! `src/main/services/telemetry.ts`. Two custom events (`signin`, `deploy`) are
//! POSTed to Azure Application Insights. The user's email is reduced to a salted
//! SHA-256 hash before leaving the machine; the email domain is sent in the clear
//! (the `tenantDomain` dimension) while the raw email is never sent. Configuration
//! is read once at startup from the bundled
//! `resources/telemetry.json`; when absent (dev builds) telemetry is a no-op.

use std::time::Duration;

use once_cell::sync::{Lazy, OnceCell};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// Salt mixed into every hash. Ships in the binary (not a secret); it makes the
/// hashes app-specific and stable so a given email always maps to the same id.
const HASH_SALT: &str = "rayfin-fabricator:telemetry:v1";
/// Logical service name reported to App Insights (ai.cloud.role).
const CLOUD_ROLE: &str = "rayfin-fabricator";

#[derive(Clone)]
struct ParsedConnection {
  instrumentation_key: String,
  ingestion_endpoint: String,
}

static CONFIG: OnceCell<Option<ParsedConnection>> = OnceCell::new();
static APP_VERSION: OnceCell<String> = OnceCell::new();
static SESSION_ID: Lazy<String> = Lazy::new(|| uuid::Uuid::new_v4().to_string());

/// A pseudonymous identity resolved from the signed-in Fabric/Rayfin user.
#[derive(Default, Clone)]
pub struct TelemetryIdentity {
  pub email: Option<String>,
  /// Raw tenant id/name — captured for parity with the Electron build but
  /// currently unused (the `tenantDomain` dimension is derived from the email
  /// domain in [`track`]).
  #[allow(dead_code)]
  pub tenant: Option<String>,
}

/// Initialize telemetry from the bundled connection string + app version. Called
/// once at startup (with `None` when the resource file is absent).
pub fn init(connection_string: Option<String>, app_version: String) {
  let _ = APP_VERSION.set(app_version);
  let parsed = connection_string
    .as_deref()
    .and_then(parse_connection_string);
  let _ = CONFIG.set(parsed);
}

fn parse_connection_string(cs: &str) -> Option<ParsedConnection> {
  if cs.trim().is_empty() {
    return None;
  }
  let mut instrumentation_key: Option<String> = None;
  let mut endpoint: Option<String> = None;
  for segment in cs.split(';') {
    let Some(idx) = segment.find('=') else { continue };
    let key = segment[..idx].trim().to_lowercase();
    let value = segment[idx + 1..].trim().to_string();
    match key.as_str() {
      "instrumentationkey" => instrumentation_key = Some(value),
      "ingestionendpoint" => endpoint = Some(value),
      _ => {}
    }
  }
  let instrumentation_key = instrumentation_key?;
  let ingestion_endpoint = endpoint
    .unwrap_or_else(|| "https://dc.services.visualstudio.com".to_string())
    .trim_end_matches('/')
    .to_string();
  Some(ParsedConnection {
    instrumentation_key,
    ingestion_endpoint,
  })
}

fn app_version() -> String {
  APP_VERSION
    .get()
    .cloned()
    .unwrap_or_else(|| "0.0.0".to_string())
}

/// Salted SHA-256 (hex) of a normalized value, or None for empty input.
fn hash(value: Option<&str>) -> Option<String> {
  let normalized = value?.trim().to_lowercase();
  if normalized.is_empty() {
    return None;
  }
  let mut hasher = Sha256::new();
  hasher.update(format!("{HASH_SALT}:{normalized}").as_bytes());
  Some(hex::encode(hasher.finalize()))
}

fn email_domain(email: Option<&str>) -> Option<String> {
  email?.rsplit_once('@').map(|(_, d)| d.to_string())
}

fn send(conn: &ParsedConnection, name: &str, user_id: String, properties: Map<String, Value>) {
  let envelope = json!({
    "name": "Microsoft.ApplicationInsights.Event",
    "time": chrono::Utc::now().to_rfc3339(),
    "iKey": conn.instrumentation_key,
    "tags": {
      "ai.user.id": user_id,
      "ai.session.id": SESSION_ID.clone(),
      "ai.cloud.role": CLOUD_ROLE,
      "ai.device.osVersion": std::env::consts::OS,
      "ai.internal.sdkVersion": format!("rayfin-fabricator:{}", app_version()),
    },
    "data": {
      "baseType": "EventData",
      "baseData": { "ver": 2, "name": name, "properties": properties },
    }
  });
  let url = format!("{}/v2/track", conn.ingestion_endpoint);
  let body = envelope.to_string();
  // Fire-and-forget; telemetry must never slow or break a user action.
  tokio::spawn(async move {
    if let Ok(client) = reqwest::Client::builder()
      .timeout(Duration::from_secs(5))
      .build()
    {
      let _ = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await;
    }
  });
}

fn track(name: &str, identity: Option<&TelemetryIdentity>, props: &[(&str, String)]) {
  let Some(Some(conn)) = CONFIG.get() else {
    return;
  };
  let email = identity.and_then(|i| i.email.as_deref());
  let Some(user_id) = hash(email) else {
    return;
  };
  let mut properties = Map::new();
  for (k, v) in props {
    properties.insert((*k).to_string(), json!(v));
  }
  properties.insert("appVersion".to_string(), json!(app_version()));
  properties.insert("os".to_string(), json!(std::env::consts::OS));
  // Send the raw sign-in domain (e.g. "contoso.com"), normalized but not hashed,
  // so tenants are directly identifiable. The user id above stays a hash.
  if let Some(domain) = email_domain(email) {
    let domain = domain.trim().to_lowercase();
    if !domain.is_empty() {
      properties.insert("tenantDomain".to_string(), json!(domain));
    }
  }
  send(conn, name, user_id, properties);
}

/// Record a sign-in (or active-at-startup) event.
pub fn track_signin(identity: Option<&TelemetryIdentity>, trigger: &str) {
  track("signin", identity, &[("trigger", trigger.to_string())]);
}

/// Record a deploy attempt and whether it succeeded.
pub fn track_deploy(identity: Option<&TelemetryIdentity>, success: bool) {
  track("deploy", identity, &[("success", success.to_string())]);
}
