//! A client for a running backend's control API (`{apiUrl}/.rayfin-local/control/*`,
//! loopback only, with the run's bearer token) and for calling the app's own
//! routes as one of its users.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use reqwest::{Method, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::types::{
  LocalCommandError, LocalEntity, LocalIdentity, LocalIdentityRequest, LocalReloadResult, LocalRows, LocalUser,
};

const CONTROL: [&str; 2] = [".rayfin-local", "control"];
const TIMEOUT: Duration = Duration::from_secs(30);
/// Reloading rebuilds the model, the schema and the services.
const RELOAD_TIMEOUT: Duration = Duration::from_secs(180);
/// The most rows the control API returns at once.
pub const MAX_ROWS: u64 = 500;

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
  reqwest::Client::builder()
    .no_proxy()
    .redirect(reqwest::redirect::Policy::none())
    .build()
    .unwrap_or_default()
});

/// The per-run secret the control API asks for (`RAYFIN_LOCAL_CONTROL_TOKEN`).
/// Never printed: its `Debug` is masked.
#[derive(Clone, PartialEq, Eq)]
pub struct ControlToken(Arc<str>);

impl ControlToken {
  /// 64 random hex characters from the OS's generator.
  pub fn generate() -> Self {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    Self(format!("{a}{b}").into())
  }

  pub fn expose(&self) -> &str {
    &self.0
  }
}

impl fmt::Debug for ControlToken {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("ControlToken(***)")
  }
}

/// An access token for calls made as one of the app's users (`POST /token`).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessToken {
  pub access_token: String,
  #[serde(default)]
  pub expires_in: Option<u64>,
  #[serde(default)]
  pub user: Option<LocalUser>,
}

impl fmt::Debug for AccessToken {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("AccessToken").field("expires_in", &self.expires_in).field("user", &self.user).finish_non_exhaustive()
  }
}

/// Who a call to the app's own backend is made as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallAs {
  /// No `Authorization`: an anonymous user.
  Anonymous,
  /// The developer identity.
  Developer,
  /// A local user, by username or id; `create` makes a missing one.
  User { user: String, create: bool },
}

/// A call to the app's own backend, such as `POST /graphql`.
#[derive(Clone, Debug)]
pub struct AppCall {
  pub method: Method,
  /// From the backend's root, such as `/graphql` or `/functions/getBacklog/invoke`.
  pub path: String,
  pub body: Option<Value>,
  pub call_as: CallAs,
}

/// What the app answered, whatever the status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppResponse {
  pub status: u16,
  pub content_type: Option<String>,
  pub body: String,
}

/// A running backend's control API.
#[derive(Clone, Debug)]
pub struct ControlClient {
  base: Url,
  token: ControlToken,
}

pub fn error(code: &str, message: impl Into<String>, hint: Option<&str>) -> LocalCommandError {
  LocalCommandError { code: code.into(), message: message.into(), hint: hint.map(String::from), status: None }
}

impl ControlClient {
  /// `api_url` must be on this computer: the token is never sent anywhere else.
  pub fn new(api_url: &str, token: ControlToken) -> Result<Self, LocalCommandError> {
    let base = Url::parse(api_url).map_err(|e| error("invalid", format!("The backend address {api_url:?} isn't valid: {e}"), None))?;
    let host = base.host_str().unwrap_or_default();
    let loopback = host.eq_ignore_ascii_case("localhost")
      || host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if base.scheme() != "http" || !loopback {
      return Err(error("invalid", format!("The backend address {api_url} isn't on this computer."), None));
    }
    Ok(Self { base, token })
  }

  /// `{apiUrl}/.rayfin-local/control/<segments>`, each segment escaped.
  fn url(&self, segments: &[&str]) -> Url {
    let mut url = self.base.clone();
    url.set_query(None);
    if let Ok(mut path) = url.path_segments_mut() {
      path.pop_if_empty().extend(CONTROL).extend(segments);
    }
    url
  }

  fn request(&self, method: Method, segments: &[&str]) -> reqwest::RequestBuilder {
    self.request_to(method, self.url(segments))
  }

  fn request_to(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
    HTTP.request(method, url).bearer_auth(self.token.expose()).timeout(TIMEOUT)
  }

  async fn send(request: reqwest::RequestBuilder) -> Result<(StatusCode, String), LocalCommandError> {
    let response = request.send().await.map_err(transport)?;
    let status = response.status();
    let body = response.text().await.map_err(transport)?;
    if status.is_success() {
      Ok((status, body))
    } else {
      Err(api_error(status, &body))
    }
  }

  async fn json<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T, LocalCommandError> {
    let (_, body) = Self::send(request).await?;
    serde_json::from_str(&body).map_err(|e| error("bad-response", format!("The local backend sent an answer Fabricator couldn't read: {e}"), None))
  }

  pub async fn identity(&self) -> Result<LocalIdentity, LocalCommandError> {
    Self::json(self.request(Method::GET, &["identity"])).await
  }

  /// Change who the app signs in as. Revokes every local session.
  pub async fn set_identity(&self, identity: &LocalIdentityRequest) -> Result<LocalIdentity, LocalCommandError> {
    Self::json(self.request(Method::PUT, &["identity"]).json(identity)).await
  }

  pub async fn users(&self) -> Result<Vec<LocalUser>, LocalCommandError> {
    #[derive(Deserialize)]
    struct Users {
      #[serde(default)]
      users: Vec<LocalUser>,
    }
    Ok(Self::json::<Users>(self.request(Method::GET, &["users"])).await?.users)
  }

  /// Without a password the user can only be signed in through this API.
  pub async fn add_user(&self, username: &str, password: Option<&str>) -> Result<LocalUser, LocalCommandError> {
    let mut body = json!({ "username": username });
    if let Some(password) = password {
      body["password"] = json!(password);
    }
    Self::json(self.request(Method::POST, &["users"]).json(&body)).await
  }

  /// By username or id. Signs out the user's sessions.
  pub async fn delete_user(&self, user: &str) -> Result<(), LocalCommandError> {
    Self::send(self.request(Method::DELETE, &["users", user])).await.map(drop)
  }

  /// An access token for calls made as `user` (`None`: the developer identity).
  pub async fn token(&self, user: Option<&str>, create: bool) -> Result<AccessToken, LocalCommandError> {
    let body = json!({ "user": user, "create": create });
    Self::json(self.request(Method::POST, &["token"]).json(&body)).await
  }

  pub async fn entities(&self) -> Result<Vec<LocalEntity>, LocalCommandError> {
    #[derive(Deserialize)]
    struct Entities {
      #[serde(default)]
      entities: Vec<LocalEntity>,
    }
    Ok(Self::json::<Entities>(self.request(Method::GET, &["entities"])).await?.entities)
  }

  /// A page of `entity`'s rows, regardless of permissions (`limit` at most [`MAX_ROWS`]).
  pub async fn rows(&self, entity: &str, offset: u64, limit: u64, order_by: Option<&str>, desc: bool) -> Result<LocalRows, LocalCommandError> {
    let mut url = self.url(&["entities", entity, "rows"]);
    {
      let mut query = url.query_pairs_mut();
      query
        .append_pair("offset", &offset.to_string())
        .append_pair("limit", &limit.clamp(1, MAX_ROWS).to_string())
        .append_pair("desc", if desc { "true" } else { "false" });
      if let Some(field) = order_by.filter(|f| !f.is_empty()) {
        query.append_pair("orderBy", field);
      }
    }
    Self::json(self.request_to(Method::GET, url)).await
  }

  /// Delete every row of `entity`; returns how many. Refused (409) while other rows refer to them.
  pub async fn clear_rows(&self, entity: &str) -> Result<u64, LocalCommandError> {
    #[derive(Deserialize)]
    struct Deleted {
      #[serde(default)]
      deleted: u64,
    }
    Ok(Self::json::<Deleted>(self.request(Method::DELETE, &["entities", entity, "rows"])).await?.deleted)
  }

  /// Delete every entity's rows, the local users and their sessions, and the stored files.
  pub async fn reset_data(&self) -> Result<(), LocalCommandError> {
    Self::send(self.request(Method::POST, &["data", "reset"]).json(&json!({}))).await.map(drop)
  }

  /// Read `rayfin.yml`, the entities and the secrets again and apply them now.
  pub async fn reload(&self, force_schema: bool) -> Result<LocalReloadResult, LocalCommandError> {
    let request = self.request(Method::POST, &["reload"]).json(&json!({ "forceSchema": force_schema })).timeout(RELOAD_TIMEOUT);
    Self::json(request).await
  }

  /// The app's publishable key, from `{apiUrl}/rayfin.config.json`.
  pub async fn publishable_key(&self) -> Result<String, LocalCommandError> {
    let url = self.base.join("/rayfin.config.json").map_err(|e| error("invalid", e.to_string(), None))?;
    let (_, body) = Self::send(HTTP.get(url).timeout(TIMEOUT)).await?;
    let config: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    config["publishableKey"]
      .as_str()
      .filter(|key| !key.is_empty())
      .map(String::from)
      .ok_or_else(|| error("bad-response", "The app's rayfin.config.json has no publishable key.", None))
  }

  /// Call the app's own backend as `call.call_as`, the way its frontend does:
  /// with the publishable key, and a bearer token unless anonymous.
  pub async fn call_app(&self, call: AppCall) -> Result<AppResponse, LocalCommandError> {
    if !call.path.starts_with('/') || call.path.starts_with("//") || call.path.starts_with("/.rayfin-local") {
      return Err(error("invalid", format!("{} isn't one of the app's routes.", call.path), None));
    }
    let url = self.base.join(&call.path).map_err(|e| error("invalid", e.to_string(), None))?;
    let key = self.publishable_key().await?;
    let mut request = HTTP.request(call.method, url).header("X-Publishable-Key", key).timeout(TIMEOUT);
    let token = match &call.call_as {
      CallAs::Anonymous => None,
      CallAs::Developer => Some(self.token(None, false).await?),
      CallAs::User { user, create } => Some(self.token(Some(user), *create).await?),
    };
    if let Some(token) = token {
      request = request.bearer_auth(token.access_token);
    }
    if let Some(body) = &call.body {
      request = request.json(body);
    }
    let response = request.send().await.map_err(transport)?;
    let status = response.status().as_u16();
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(String::from);
    let body = response.text().await.map_err(transport)?;
    Ok(AppResponse { status, content_type, body })
  }
}

fn transport(e: reqwest::Error) -> LocalCommandError {
  if e.is_timeout() {
    error("timeout", "The local backend didn't answer in time.", Some("It may be busy rebuilding. Try again in a moment."))
  } else {
    error("unreachable", "Fabricator couldn't reach the local backend. It may have stopped.", Some("Check its status, and start it again if it stopped."))
  }
}

/// `{"error":{"code","message","hint"}}`, else a message for the status.
fn api_error(status: StatusCode, body: &str) -> LocalCommandError {
  #[derive(Deserialize)]
  struct Envelope {
    error: Detail,
  }
  #[derive(Deserialize)]
  struct Detail {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    hint: Option<String>,
  }
  let mut result = match serde_json::from_str::<Envelope>(body) {
    Ok(Envelope { error: detail }) if !detail.message.is_empty() => LocalCommandError {
      code: if detail.code.is_empty() { format!("http-{}", status.as_u16()) } else { detail.code },
      message: detail.message,
      hint: detail.hint,
      status: None,
    },
    _ => match status {
      StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => error(
        "unauthorized",
        "The local backend refused Fabricator's control token.",
        Some("Restart the local backend."),
      ),
      StatusCode::NOT_FOUND => error(
        "not-found",
        "The local backend doesn't know that.",
        Some("It may be an older rayfin-local without this part of the control API."),
      ),
      _ => error(&format!("http-{}", status.as_u16()), format!("The local backend answered {status}."), None),
    },
  };
  result.status = Some(status.as_u16());
  result
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tokens_are_long_random_and_never_printed() {
    let token = ControlToken::generate();
    assert!(token.expose().len() >= 32);
    assert!(token.expose().chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(token, ControlToken::generate());
    assert_eq!(format!("{token:?}"), "ControlToken(***)");
    let client = ControlClient::new("http://localhost:7171", token.clone()).unwrap();
    assert!(!format!("{client:?}").contains(token.expose()));
  }

  #[test]
  fn control_urls_escape_each_segment() {
    let client = ControlClient::new("http://localhost:7171", ControlToken::generate()).unwrap();
    assert_eq!(client.url(&["users", "ana@example.com"]).as_str(), "http://localhost:7171/.rayfin-local/control/users/ana@example.com");
    assert_eq!(client.url(&["users", "a/b c"]).as_str(), "http://localhost:7171/.rayfin-local/control/users/a%2Fb%20c");
    assert_eq!(client.url(&["entities", "Note", "rows"]).path(), "/.rayfin-local/control/entities/Note/rows");
    let nested = ControlClient::new("http://127.0.0.1:7171/", ControlToken::generate()).unwrap();
    assert_eq!(nested.url(&["status"]).as_str(), "http://127.0.0.1:7171/.rayfin-local/control/status");
  }

  #[test]
  fn the_token_never_leaves_this_computer() {
    for url in ["http://localhost:7171", "http://127.0.0.1:7171", "http://[::1]:7171"] {
      assert!(ControlClient::new(url, ControlToken::generate()).is_ok(), "{url}");
    }
    for url in ["https://example.com", "http://192.168.1.4:7171", "http://localhost.example.com", "file:///x", "nonsense"] {
      assert_eq!(ControlClient::new(url, ControlToken::generate()).unwrap_err().code, "invalid", "{url}");
    }
  }

  #[test]
  fn reads_the_control_api_errors() {
    let conflict = api_error(StatusCode::CONFLICT, r#"{"error":{"code":"user-exists","message":"ana@example.com exists.","hint":"Pick another username."}}"#);
    assert_eq!((conflict.code.as_str(), conflict.status), ("user-exists", Some(409)));
    assert_eq!(conflict.hint.as_deref(), Some("Pick another username."));
    assert_eq!(api_error(StatusCode::UNAUTHORIZED, "").code, "unauthorized");
    assert_eq!(api_error(StatusCode::NOT_FOUND, "<html>").code, "not-found");
    assert_eq!(api_error(StatusCode::BAD_GATEWAY, "").code, "http-502");
  }

  #[tokio::test]
  async fn app_calls_stay_on_the_apps_routes() {
    let client = ControlClient::new("http://localhost:1", ControlToken::generate()).unwrap();
    for path in ["graphql", "//evil.example/x", "/.rayfin-local/control/users"] {
      let call = AppCall { method: Method::POST, path: path.into(), body: None, call_as: CallAs::Anonymous };
      assert_eq!(client.call_app(call).await.unwrap_err().code, "invalid", "{path}");
    }
  }
}
