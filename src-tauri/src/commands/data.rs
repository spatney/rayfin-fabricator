//! Live Data Browser backend — a thin, server-side proxy to a deployed Rayfin
//! app's managed GraphQL data API (Data API Builder under the hood).
//!
//! Why proxy from Rust instead of calling the API from the renderer:
//!   * avoids CORS (the BaaS endpoint isn't served from the Fabricator origin),
//!   * keeps the publishable key out of the renderer (it never leaves Rust),
//!   * centralises endpoint resolution + header handling.
//!
//! Endpoint + auth are resolved from the project's `rayfin/.env`
//! (`RAYFIN_PUBLIC_API_URL` + `RAYFIN_PUBLIC_PUBLISHABLE_KEY`), falling back to
//! the recorded deploy's `apiUrl` and `rayfin/rayfin.yml`'s `publishable_key`.
//! The GraphQL endpoint is `<apiUrl>/graphql`; requests send
//! `X-Publishable-Key` (service-level auth). User-scoped rows behind
//! `@authenticated` policies need a signed-in session — that's a follow-up
//! (authenticated browsing via the preview webview).

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::services::store;

/// Canonical, trimmed GraphQL introspection query (graphql-js shape) — enough to
/// list queryable collections and their scalar fields without pulling in
/// directives/descriptions.
const INTROSPECTION_QUERY: &str = r#"query IntrospectionQuery {
  __schema {
    queryType { name }
    types {
      kind
      name
      fields(includeDeprecated: true) {
        name
        args { name }
        type { ...TypeRef }
      }
      enumValues(includeDeprecated: true) { name }
      inputFields { name }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name
    ofType { kind name
      ofType { kind name
        ofType { kind name
          ofType { kind name
            ofType { kind name
              ofType { kind name } } } } } } }
}"#;

/// What the Data tab needs to know about a project's data API. The publishable
/// key itself is intentionally **not** returned — only whether one is present.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataConfig {
  /// True when we have both an endpoint and a publishable key.
  pub configured: bool,
  /// Base data-plane URL (safe to display).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub api_url: Option<String>,
  /// Resolved GraphQL endpoint (`<apiUrl>/graphql`).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub endpoint: Option<String>,
  /// True when a publishable key was found (its value stays server-side).
  pub has_key: bool,
  /// Where the config came from, for display: "env" | "rayfin.yml" | "deploy".
  #[serde(skip_serializing_if = "Option::is_none")]
  pub source: Option<String>,
}

/// Minimal `.env` parser: `KEY=VALUE` per line, `#` comments and blanks ignored,
/// surrounding single/double quotes stripped. Good enough for `rayfin/.env`.
fn parse_env(text: &str) -> HashMap<String, String> {
  let mut out = HashMap::new();
  for raw in text.lines() {
    let line = raw.trim();
    if line.is_empty() || line.starts_with('#') {
      continue;
    }
    let Some((k, v)) = line.split_once('=') else {
      continue;
    };
    let key = k.trim().to_string();
    let mut val = v.trim().to_string();
    if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
      || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
    {
      val = val[1..val.len() - 1].to_string();
    }
    if !key.is_empty() {
      out.insert(key, val);
    }
  }
  out
}

/// Pull `publishable_key:` out of a `rayfin/rayfin.yml` without a YAML dep.
fn yaml_publishable_key(text: &str) -> Option<String> {
  for line in text.lines() {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("publishable_key:") {
      let v = rest.trim().trim_matches('"').trim_matches('\'').trim();
      if !v.is_empty() {
        return Some(v.to_string());
      }
    }
  }
  None
}

/// Join a base data-plane URL with the GraphQL path, preserving any path
/// component already on the base (the BaaS URL carries a long `/webapi/...`
/// prefix, so a naive `URL::join("/graphql")` would be wrong).
fn graphql_endpoint(api_url: &str) -> String {
  format!("{}/graphql", api_url.trim_end_matches('/'))
}

/// Resolved data-API connection details for a project.
struct Resolved {
  api_url: String,
  key: Option<String>,
  source: String,
}

/// Resolve `(apiUrl, publishableKey?, source)` for a project from `rayfin/.env`,
/// the recorded deploy, and `rayfin/rayfin.yml` (in that order of preference).
fn resolve(project_id: &str) -> Result<Resolved, String> {
  let project = store::find_project(project_id).ok_or("Project not found.")?;
  let root = Path::new(&project.path);

  let env = std::fs::read_to_string(root.join("rayfin").join(".env"))
    .ok()
    .map(|t| parse_env(&t))
    .unwrap_or_default();

  let mut sources: Vec<&str> = Vec::new();

  let mut api_url = env.get("RAYFIN_PUBLIC_API_URL").cloned().filter(|s| !s.is_empty());
  if api_url.is_some() {
    sources.push("env");
  }
  if api_url.is_none() {
    if let Some(d) = project.last_deploy.as_ref().and_then(|d| d.api_url.clone()) {
      if !d.is_empty() {
        api_url = Some(d);
        sources.push("deploy");
      }
    }
  }

  let mut key = env
    .get("RAYFIN_PUBLIC_PUBLISHABLE_KEY")
    .cloned()
    .filter(|s| !s.is_empty());
  if key.is_some() && !sources.contains(&"env") {
    sources.push("env");
  }
  if key.is_none() {
    if let Ok(yml) = std::fs::read_to_string(root.join("rayfin").join("rayfin.yml")) {
      if let Some(k) = yaml_publishable_key(&yml) {
        key = Some(k);
        sources.push("rayfin.yml");
      }
    }
  }

  let api_url = api_url.ok_or(
    "This project hasn't been deployed yet, so it has no data API to browse. Deploy the app first.",
  )?;

  Ok(Resolved {
    api_url,
    key,
    source: if sources.is_empty() {
      "env".to_string()
    } else {
      sources.join("+")
    },
  })
}

/// POST a GraphQL document to the project's endpoint and return the parsed JSON
/// response. GraphQL-level errors (`{ "errors": [...] }`) are returned as `Ok`
/// so the UI can render them; only transport failures and non-JSON bodies are
/// surfaced as `Err`.
async fn post_graphql(
  project_id: &str,
  query: &str,
  variables: Option<Value>,
) -> Result<Value, String> {
  let resolved = resolve(project_id)?;
  let key = resolved.key.ok_or(
    "No publishable key found for this project (looked in rayfin/.env and rayfin/rayfin.yml). Redeploy or run `npx rayfin env` to refresh it.",
  )?;
  let endpoint = graphql_endpoint(&resolved.api_url);

  let mut body = json!({ "query": query });
  if let Some(vars) = variables {
    if !vars.is_null() {
      body["variables"] = vars;
    }
  }

  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(30))
    .build()
    .map_err(|e| format!("Couldn't create HTTP client: {e}"))?;

  let res = client
    .post(&endpoint)
    .header("Content-Type", "application/json")
    .header("X-Publishable-Key", key)
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("Request to the data API failed: {e}"))?;

  let status = res.status();
  let text = res
    .text()
    .await
    .map_err(|e| format!("Couldn't read the data API response: {e}"))?;

  match serde_json::from_str::<Value>(&text) {
    // A GraphQL response always carries `data` and/or `errors`; pass it through
    // even on a 4xx so the console can show the GraphQL error detail.
    Ok(v) if v.get("data").is_some() || v.get("errors").is_some() => Ok(v),
    _ if status.is_success() => {
      // 2xx but not a recognisable GraphQL envelope — return as-is if JSON.
      serde_json::from_str::<Value>(&text)
        .map_err(|_| format!("Unexpected response from the data API (HTTP {status})."))
    }
    _ => {
      let snippet: String = text.chars().take(300).collect();
      Err(format!("Data API returned HTTP {status}: {snippet}"))
    }
  }
}

/// Return the project's data-API connection status (endpoint + whether a key is
/// available). Never errors on a missing deploy — returns `configured: false`.
#[tauri::command]
pub async fn data_config(project_id: String) -> Result<DataConfig, String> {
  match resolve(&project_id) {
    Ok(r) => Ok(DataConfig {
      configured: r.key.is_some(),
      endpoint: Some(graphql_endpoint(&r.api_url)),
      api_url: Some(r.api_url),
      has_key: r.key.is_some(),
      source: Some(r.source),
    }),
    Err(_) => Ok(DataConfig {
      configured: false,
      api_url: None,
      endpoint: None,
      has_key: false,
      source: None,
    }),
  }
}

/// Run a GraphQL introspection query against the project's data API.
#[tauri::command]
pub async fn data_introspect(project_id: String) -> Result<Value, String> {
  post_graphql(&project_id, INTROSPECTION_QUERY, None).await
}

/// Run an arbitrary GraphQL query/mutation against the project's data API.
#[tauri::command]
pub async fn data_query(
  project_id: String,
  query: String,
  variables: Option<Value>,
) -> Result<Value, String> {
  if query.trim().is_empty() {
    return Err("The query is empty.".into());
  }
  post_graphql(&project_id, &query, variables).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_env_pairs_and_strips_quotes() {
    let env = parse_env(
      "# comment\nRAYFIN_PUBLIC_API_URL=https://h/webapi/x/\nRAYFIN_PUBLIC_PUBLISHABLE_KEY=\"pk-abc\"\n\nBLANK=\n",
    );
    assert_eq!(env.get("RAYFIN_PUBLIC_API_URL").unwrap(), "https://h/webapi/x/");
    assert_eq!(env.get("RAYFIN_PUBLIC_PUBLISHABLE_KEY").unwrap(), "pk-abc");
    assert_eq!(env.get("BLANK").unwrap(), "");
  }

  #[test]
  fn graphql_endpoint_preserves_base_path_and_trims_slash() {
    assert_eq!(
      graphql_endpoint("https://h/webapi/caps/1/appbackends/2/"),
      "https://h/webapi/caps/1/appbackends/2/graphql"
    );
    assert_eq!(
      graphql_endpoint("https://h/webapi/caps/1/appbackends/2"),
      "https://h/webapi/caps/1/appbackends/2/graphql"
    );
  }

  #[test]
  fn extracts_publishable_key_from_yaml() {
    assert_eq!(
      yaml_publishable_key("id: x\npublishable_key: pk-HxtPqsGh\nname: y\n").as_deref(),
      Some("pk-HxtPqsGh")
    );
    assert_eq!(yaml_publishable_key("publishable_key: \"pk-q\"\n").as_deref(), Some("pk-q"));
    assert_eq!(yaml_publishable_key("name: y\n"), None);
  }
}
