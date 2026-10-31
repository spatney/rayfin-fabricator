//! The tokens Fabricator gives the Copilot runtime for Fabric IQ and Work IQ
//! when it connects to them ([`IqAuth`]). The runtime's own sign-in waits for
//! the system's account window, which never opens from Fabricator's background
//! Copilot process, so Fabricator signs in itself:
//!
//! - Fabric IQ with the Azure CLI's sign-in, like Fabricator's other Fabric
//!   features.
//! - Work IQ in the browser, with Work IQ's own Microsoft Entra app and the
//!   redirect that Microsoft's Work IQ plugin for Copilot CLI uses: a public
//!   client with PKCE, coming back to a listener on this computer.
//!
//! Tokens stay in memory: Work IQ asks to sign in again after Fabricator restarts.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine;
use github_copilot_sdk::handler::{McpAuthHandler, McpAuthRequest, McpAuthResult};
use github_copilot_sdk::session_events::McpOauthRequestReason;
use github_copilot_sdk::{RequestId, SessionId};
use once_cell::sync::Lazy;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::{clip, Iq, Opener, SignIn};
use crate::services::exec::CancelToken;
use crate::services::team::entra::{self, AzErrorKind};

const FABRIC_RESOURCE: &str = "https://api.fabric.microsoft.com";
/// How long Fabricator reuses the Azure CLI's token, which lasts at least an hour.
const FABRIC_TOKEN_LIFE: Duration = Duration::from_secs(30 * 60);

const WORK_AUTHORITY: &str = "https://login.microsoftonline.com/organizations/oauth2/v2.0";
/// Work IQ's Microsoft Entra app, a public client, and the redirect registered
/// for it: Copilot CLI's sign-in callback, on the port Microsoft's Work IQ
/// plugin sets.
const WORK_CLIENT_ID: &str = "ba081686-5d24-4bc6-a0d6-d034ecffed87";
const WORK_REDIRECT_PORT: u16 = 12798;
/// What Work IQ's server asks for (its OAuth metadata's `scopes_supported`),
/// and a refresh token.
const WORK_SCOPE: &str = "fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask offline_access";

/// A token the server turns down this soon after Fabricator handed it over
/// won't do better, so the runtime gets none.
const TURNED_DOWN_WITHIN: Duration = Duration::from_secs(60);
/// A token this close to expiring is renewed rather than handed over.
const EXPIRY_MARGIN: Duration = Duration::from_secs(120);

const NOT_SIGNED_IN: &str =
  "the user hasn't signed in to Work IQ. Turning Work IQ off and on in Settings → Experiments asks again";

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

struct Token {
  access: String,
  expires_at: Instant,
  issued_at: Instant,
}

#[derive(Default)]
struct Store {
  tokens: HashMap<Iq, Token>,
  work_refresh: Option<String>,
}

impl Store {
  fn keep(&mut self, iq: Iq, access: String, life: Duration) -> (String, Duration) {
    let now = Instant::now();
    self.tokens.insert(iq, Token { access: access.clone(), expires_at: now + life, issued_at: now });
    (access, life)
  }
}

static STORE: Lazy<Mutex<Store>> = Lazy::new(Mutex::default);

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
  reqwest::Client::builder()
    .timeout(Duration::from_secs(30))
    .user_agent("rayfin-fabricator")
    .build()
    .unwrap_or_default()
});

/// Answers the runtime's requests for Fabric IQ's and Work IQ's tokens as it
/// connects to them, without asking the user: [`super::prepare`] does that
/// before a message, then has the runtime connect again.
pub struct IqAuth;

#[async_trait]
impl McpAuthHandler for IqAuth {
  async fn handle(&self, _: SessionId, _: RequestId, request: McpAuthRequest) -> McpAuthResult {
    let Some(iq) = Iq::from_server(&request.server_name) else {
      return McpAuthResult::Cancelled;
    };
    match token(iq, request.reason != McpOauthRequestReason::Initial).await {
      Ok((access, life)) => McpAuthResult::Token {
        access_token: access,
        token_type: Some("Bearer".into()),
        expires_in: Some(life.as_secs() as i64),
      },
      Err(why) => {
        log::info!("No {} token for the Copilot runtime: {why}", iq.label());
        McpAuthResult::Cancelled
      }
    }
  }
}

/// What to do about a request for `iq`'s token, from what Fabricator has.
#[derive(Debug, PartialEq)]
enum Cached {
  Use(String, Duration),
  TurnedDown,
  Fetch,
}

/// `fresh` is set when the server turned the last token down.
fn cached(store: &Store, iq: Iq, fresh: bool, now: Instant) -> Cached {
  let Some(token) = store.tokens.get(&iq) else {
    return Cached::Fetch;
  };
  if fresh && now.saturating_duration_since(token.issued_at) < TURNED_DOWN_WITHIN {
    return Cached::TurnedDown;
  }
  if !fresh && token.expires_at > now + EXPIRY_MARGIN {
    return Cached::Use(token.access.clone(), token.expires_at - now);
  }
  Cached::Fetch
}

/// `iq`'s token without asking the user, and how long it lasts, or why there
/// isn't one, in words the user can act on.
pub(super) async fn token(iq: Iq, fresh: bool) -> Result<(String, Duration), String> {
  let found = cached(&STORE.lock().unwrap(), iq, fresh, Instant::now());
  match found {
    Cached::Use(access, life) => return Ok((access, life)),
    Cached::TurnedDown => return Err(iq.turned_down().into()),
    Cached::Fetch => {}
  }
  match iq {
    Iq::Fabric => {
      let access = entra::token(FABRIC_RESOURCE).await.map_err(|e| azure_problem(&e))?;
      Ok(STORE.lock().unwrap().keep(iq, access, FABRIC_TOKEN_LIFE))
    }
    Iq::Work => {
      let refresh = STORE.lock().unwrap().work_refresh.clone().ok_or_else(|| NOT_SIGNED_IN.to_string())?;
      match redeem(&[("grant_type", "refresh_token"), ("refresh_token", &refresh)]).await {
        Ok(grant) => Ok(keep_work(grant)),
        Err(e) if e.signed_out => {
          forget(Iq::Work);
          Err(NOT_SIGNED_IN.into())
        }
        Err(e) => Err(e.message),
      }
    }
  }
}

fn azure_problem(e: &entra::AzError) -> String {
  match e.kind {
    AzErrorKind::Missing => {
      "it uses the Azure CLI's sign-in, and the Azure CLI isn't installed. Settings → Setup installs it".into()
    }
    AzErrorKind::NeedsLogin => "it uses the Azure CLI's sign-in, and the Azure CLI isn't signed in. Sign in to \
                                Azure in Settings → Accounts, then send the message again"
      .into(),
    _ => format!("it uses the Azure CLI's sign-in, which didn't work ({})", clip(&e.message)),
  }
}

/// Drops `iq`'s tokens, signing out of Work IQ.
pub(super) fn forget(iq: Iq) {
  let mut store = STORE.lock().unwrap();
  store.tokens.remove(&iq);
  if iq == Iq::Work {
    store.work_refresh = None;
  }
}

/// Signs in to Work IQ in the browser: Microsoft's sign-in page comes back to
/// a listener on this computer with a code, which Fabricator redeems for tokens.
pub(super) async fn sign_in_work(open: Opener<'_>, cancel: &CancelToken, wait: Duration) -> SignIn {
  let listener = match TcpListener::bind(("127.0.0.1", WORK_REDIRECT_PORT)).await {
    Ok(listener) => listener,
    Err(_) => {
      return SignIn::Failed(format!(
        "its sign-in needs port {WORK_REDIRECT_PORT} on this computer, and another app is using it"
      ))
    }
  };
  let verifier = random(32);
  let state = random(16);
  if let Err(why) = open(&authorize_url(&challenge(&verifier), &state)) {
    return SignIn::Failed(why);
  }
  let code = tokio::select! {
    _ = cancel.wait_cancelled() => return SignIn::Cancelled,
    received = tokio::time::timeout(wait, receive(&listener, &state)) => match received {
      Err(_) => return SignIn::Unfinished,
      Ok(Err(why)) => return SignIn::Failed(why),
      Ok(Ok(code)) => code,
    },
  };
  let redirect = redirect_uri();
  let params = [
    ("grant_type", "authorization_code"),
    ("code", code.as_str()),
    ("redirect_uri", redirect.as_str()),
    ("code_verifier", verifier.as_str()),
  ];
  match redeem(&params).await {
    Ok(grant) => {
      keep_work(grant);
      SignIn::Done
    }
    Err(e) => SignIn::Failed(e.message),
  }
}

/// `bytes` random bytes, base64url: PKCE's verifier, the sign-in's state.
fn random(bytes: usize) -> String {
  let mut buf = Vec::with_capacity(bytes + 16);
  while buf.len() < bytes {
    buf.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
  }
  buf.truncate(bytes);
  B64.encode(buf)
}

/// PKCE's S256 challenge for `verifier`.
fn challenge(verifier: &str) -> String {
  B64.encode(Sha256::digest(verifier.as_bytes()))
}

fn redirect_uri() -> String {
  format!("http://127.0.0.1:{WORK_REDIRECT_PORT}/")
}

fn authorize_url(challenge: &str, state: &str) -> String {
  let mut url = reqwest::Url::parse(&format!("{WORK_AUTHORITY}/authorize")).expect("the authority is a URL");
  url
    .query_pairs_mut()
    .append_pair("client_id", WORK_CLIENT_ID)
    .append_pair("response_type", "code")
    .append_pair("redirect_uri", &redirect_uri())
    .append_pair("response_mode", "query")
    .append_pair("scope", WORK_SCOPE)
    .append_pair("code_challenge", challenge)
    .append_pair("code_challenge_method", "S256")
    .append_pair("state", state)
    .append_pair("prompt", "select_account");
  url.into()
}

/// What a request to the redirect brought back.
#[derive(Debug, PartialEq)]
enum Callback {
  Code(String),
  Failed(String),
  Other,
}

/// Only the sign-in this started, by its `state`, counts.
fn callback(head: &str, state: &str) -> Callback {
  let target = head.lines().next().and_then(|line| line.strip_prefix("GET ")).and_then(|rest| rest.split(' ').next());
  let Some(url) = target.and_then(|t| reqwest::Url::parse(&format!("http://127.0.0.1{t}")).ok()) else {
    return Callback::Other;
  };
  let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
  if url.path() != "/" || query.get("state").map(String::as_str) != Some(state) {
    return Callback::Other;
  }
  if let Some(code) = query.get("code").filter(|code| !code.is_empty()) {
    return Callback::Code(code.clone());
  }
  match query.get("error") {
    Some(error) => Callback::Failed(explain(error, query.get("error_description").map_or("", String::as_str))),
    None => Callback::Other,
  }
}

/// Waits for the browser to come back from Microsoft's sign-in.
async fn receive(listener: &TcpListener, state: &str) -> Result<String, String> {
  loop {
    let (mut stream, _) = listener.accept().await.map_err(|e| format!("its sign-in stopped listening ({e})"))?;
    let head = read_head(&mut stream).await;
    match callback(&head, state) {
      Callback::Code(code) => {
        reply(&mut stream, "200 OK", "You're signed in to Work IQ. You can close this tab and return to Fabricator.").await;
        return Ok(code);
      }
      Callback::Failed(why) => {
        let message = format!("Work IQ sign-in didn't finish: {why}. You can close this tab and return to Fabricator.");
        reply(&mut stream, "200 OK", &message).await;
        return Err(why);
      }
      Callback::Other => reply(&mut stream, "404 Not Found", "Not found.").await,
    }
  }
}

async fn read_head(stream: &mut TcpStream) -> String {
  let mut head = Vec::new();
  let mut chunk = [0u8; 4096];
  while head.len() < 16 * 1024 && !head.windows(4).any(|w| w == b"\r\n\r\n") {
    match tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk)).await {
      Ok(Ok(read)) if read > 0 => head.extend_from_slice(&chunk[..read]),
      _ => break,
    }
  }
  String::from_utf8_lossy(&head).into_owned()
}

async fn reply(stream: &mut TcpStream, status: &str, message: &str) {
  let message = message.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
  let body = format!(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Fabricator</title></head>\
     <body style=\"font-family:system-ui,sans-serif;margin:3rem;max-width:40rem\"><p>{message}</p></body></html>"
  );
  let response = format!(
    "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
    body.len()
  );
  let _ = stream.write_all(response.as_bytes()).await;
  let _ = stream.shutdown().await;
}

/// Work IQ's tokens, as Microsoft's sign-in hands them out. Never logged.
#[derive(Deserialize)]
struct Grant {
  access_token: String,
  #[serde(default)]
  expires_in: Option<u64>,
  #[serde(default)]
  refresh_token: Option<String>,
}

struct Refused {
  message: String,
  /// The sign-in is over: the user has to sign in again.
  signed_out: bool,
}

fn keep_work(grant: Grant) -> (String, Duration) {
  let mut store = STORE.lock().unwrap();
  if let Some(refresh) = grant.refresh_token {
    store.work_refresh = Some(refresh);
  }
  store.keep(Iq::Work, grant.access_token, Duration::from_secs(grant.expires_in.unwrap_or(3600)))
}

/// Redeems a code or a refresh token at Microsoft's sign-in for Work IQ's tokens.
async fn redeem(params: &[(&str, &str)]) -> Result<Grant, Refused> {
  // reqwest's form encoding is an optional feature: the URL's query serializer
  // writes the same `application/x-www-form-urlencoded` body.
  let mut form = reqwest::Url::parse("http://form.invalid/").expect("a URL");
  form.query_pairs_mut().append_pair("client_id", WORK_CLIENT_ID).append_pair("scope", WORK_SCOPE).extend_pairs(params);
  let response = HTTP
    .post(format!("{WORK_AUTHORITY}/token"))
    .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
    .body(form.query().unwrap_or_default().to_string())
    .send()
    .await
    .map_err(|e| Refused { message: format!("Fabricator couldn't reach Microsoft's sign-in ({e})"), signed_out: false })?;
  let ok = response.status().is_success();
  let value: serde_json::Value = response.json().await.unwrap_or_default();
  if ok {
    return serde_json::from_value(value).map_err(|_| Refused {
      message: "Microsoft's sign-in answered in a way Fabricator didn't understand".into(),
      signed_out: false,
    });
  }
  let field = |key: &str| value.get(key).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
  let error = field("error");
  Err(Refused {
    message: explain(&error, &field("error_description")),
    signed_out: matches!(error.as_str(), "invalid_grant" | "interaction_required"),
  })
}

/// Microsoft's sign-in error, in words the user can act on.
fn explain(error: &str, description: &str) -> String {
  const APPROVAL: [&str; 4] = ["AADSTS65001", "AADSTS90094", "AADSTS90095", "AADSTS650052"];
  if APPROVAL.iter().any(|code| description.contains(code)) {
    return "the organization has to approve Work IQ first: an administrator grants consent, and each user needs a \
            Microsoft 365 Copilot license"
      .into();
  }
  if error == "access_denied" {
    return "the sign-in was declined or cancelled".into();
  }
  match description.lines().next().map(str::trim).filter(|d| !d.is_empty()) {
    Some(detail) => format!("Microsoft's sign-in said: {}", clip(detail)),
    None => format!("Microsoft's sign-in said {}", if error.is_empty() { "no" } else { error }),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn pkce_follows_rfc_7636() {
    assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    let (a, b) = (random(32), random(32));
    assert_eq!(a.len(), 43, "a verifier is 43 to 128 characters");
    assert_ne!(a, b);
  }

  #[test]
  fn work_iq_signs_in_with_its_own_app_and_pkce() {
    let url = reqwest::Url::parse(&authorize_url("the-challenge", "the-state")).unwrap();
    assert_eq!((url.host_str(), url.path()), (Some("login.microsoftonline.com"), "/organizations/oauth2/v2.0/authorize"));
    let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(query["client_id"], WORK_CLIENT_ID);
    assert_eq!(query["redirect_uri"], "http://127.0.0.1:12798/");
    assert_eq!(query["scope"], "fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask offline_access");
    assert_eq!((query["code_challenge"].as_str(), query["code_challenge_method"].as_str()), ("the-challenge", "S256"));
    assert_eq!(query["state"], "the-state");
  }

  #[test]
  fn only_the_redirect_of_this_sign_in_counts() {
    let get = |target: &str| format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:12798\r\n\r\n");
    assert_eq!(callback(&get("/?code=abc&state=s1"), "s1"), Callback::Code("abc".into()));
    assert_eq!(callback(&get("/?code=abc&state=other"), "s1"), Callback::Other);
    assert_eq!(callback(&get("/favicon.ico"), "s1"), Callback::Other);
    assert_eq!(callback("POST /?code=abc&state=s1 HTTP/1.1\r\n\r\n", "s1"), Callback::Other);
    let approval = get("/?state=s1&error=consent_required&error_description=AADSTS65001%3A+The+user+or+administrator+has+not+consented");
    assert!(matches!(callback(&approval, "s1"), Callback::Failed(why) if why.starts_with("the organization has to approve Work IQ")));
    let declined = get("/?state=s1&error=access_denied");
    assert_eq!(callback(&declined, "s1"), Callback::Failed("the sign-in was declined or cancelled".into()));
  }

  #[test]
  fn a_token_turned_down_right_after_it_was_given_is_not_offered_again() {
    let now = Instant::now();
    let mut store = Store::default();
    assert_eq!(cached(&store, Iq::Work, false, now), Cached::Fetch);
    store.tokens.insert(Iq::Work, Token { access: "t".into(), expires_at: now + Duration::from_secs(3600), issued_at: now });
    assert_eq!(cached(&store, Iq::Work, false, now), Cached::Use("t".into(), Duration::from_secs(3600)));
    assert_eq!(cached(&store, Iq::Work, true, now), Cached::TurnedDown);
    // Turned down well after it was given, it has expired early: renew it.
    assert_eq!(cached(&store, Iq::Work, true, now + Duration::from_secs(600)), Cached::Fetch);
    // About to expire: renew it too.
    assert_eq!(cached(&store, Iq::Work, false, now + Duration::from_secs(3590)), Cached::Fetch);
  }

  #[tokio::test]
  async fn the_redirect_listener_waits_for_this_sign_in() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let waiting = tokio::spawn(async move { receive(&listener, "s1").await });
    let visit = |target: &'static str| async move {
      let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
      stream.write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).await.unwrap();
      let mut page = String::new();
      stream.read_to_string(&mut page).await.unwrap();
      page
    };
    assert!(visit("/favicon.ico").await.starts_with("HTTP/1.1 404"));
    assert!(visit("/?code=xyz&state=s1").await.contains("signed in to Work IQ"));
    assert_eq!(waiting.await.unwrap(), Ok("xyz".to_string()));
  }
}
