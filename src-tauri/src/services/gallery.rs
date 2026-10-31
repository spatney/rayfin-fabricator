//! The app gallery (experimental): every Rayfin app the Azure CLI's account can
//! open in Fabric, including apps that aren't on this computer.
//!
//! Rayfin apps are Fabric `AppBackend` items. One OneLake catalog search lists
//! every one the account can reach, across workspaces. Catalog search needs the
//! `Catalog.Read.All` scope, which only the Azure CLI's client can mint silently
//! (see `semantic_model_helper.mjs`), so the gallery reads as the Azure CLI's
//! account, from Home, before any project is open. When the catalog can't
//! search by the app type, the gallery scans the account's workspaces instead.
//!
//! An app's own address and last publish come from its deploy status, the
//! Rayfin workload endpoint `rayfin up` reads too. Apps are matched to the
//! projects on this computer by the Fabric item each project's deployment
//! registry records, and to team workspaces by their Fabric workspaces.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures::stream::{self, StreamExt};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::team::entra::{self, AzErrorKind};
use super::team::naming;
use crate::types::{FabricDeployment, StudioProject, TeamWorkspace};

const API: &str = "https://api.fabric.microsoft.com/v1";
const RESOURCE: &str = "https://api.fabric.microsoft.com";
const PORTAL: &str = "https://app.fabric.microsoft.com";
/// Fabric's item type for a Rayfin app (what `rayfin up` creates and reuses).
const APP_TYPE: &str = "AppBackend";
/// The Rayfin workload routes a request to the app this header names.
const MONIKER_HEADER: &str = "X-Ms-Workload-Resource-Moniker";
const PAGE_SIZE: u32 = 1000;
/// Pages read before the list stops, and says it stopped.
const MAX_PAGES: usize = 5;
/// Workspaces scanned at once when the catalog can't search by type.
const SCAN_CONCURRENCY: usize = 8;
/// Deploy statuses read at once.
const STATUS_CONCURRENCY: usize = 6;
/// Deploy statuses read per call; the gallery asks again for the rest.
const STATUS_BATCH: usize = 50;
/// How long an Azure token and account are reused: each fresh one costs `az`
/// processes, and the gallery reads statuses right after the list.
const SESSION_TTL: Duration = Duration::from_secs(120);
/// How long an app's deploy status is reused before Fabric is asked again.
const STATUS_TTL: Duration = Duration::from_secs(5 * 60);

/* --------------------------------- types --------------------------------- */

/// The Azure CLI's signed-in account, which the gallery reads with.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GalleryAccount {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub user: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tenant_id: Option<String>,
}

/// The project on this computer that publishes to a gallery app.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GalleryLocal {
  pub project_id: String,
  pub project_name: String,
}

/// The team workspace a gallery app belongs to.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GalleryTeam {
  /// The local team workspace's id.
  pub workspace_id: String,
  pub name: String,
  /// A teammate's preview, rather than the team's published app.
  pub preview: bool,
}

/// One Rayfin app the account can open.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GalleryApp {
  /// The Fabric item id.
  pub id: String,
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  pub workspace_id: String,
  pub workspace_name: String,
  /// The app's page in the Fabric portal.
  pub portal_url: String,
  /// The app's own address, when a project on this computer records it.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub hosting_url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub local: Option<GalleryLocal>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub team: Option<GalleryTeam>,
}

/// Every app the account can open. Never an error across IPC.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GalleryResult {
  pub ok: bool,
  /// Reading needs an Azure sign-in (missing, expired or rejected).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub needs_az: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  pub apps: Vec<GalleryApp>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub account: Option<GalleryAccount>,
  /// More apps than the gallery reads at once.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub truncated: bool,
}

/// An app whose deploy status the gallery wants.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GalleryRef {
  pub workspace_id: String,
  pub id: String,
}

/// What Fabric says about an app's latest publish.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GalleryStatus {
  pub id: String,
  /// The app's own address, once it has published its pages.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub hosting_url: Option<String>,
  /// When it last published successfully (RFC 3339).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub published_at: Option<String>,
  /// Fabric couldn't say: no access to the app's status, or the read failed.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub unknown: bool,
}

/// An app as Fabric lists it, before this computer's projects are matched.
#[derive(Clone, Debug, PartialEq)]
struct RawApp {
  id: String,
  name: String,
  description: Option<String>,
  workspace_id: String,
  workspace_name: String,
}

/* -------------------------------- session -------------------------------- */

#[derive(Clone)]
struct Session {
  at: Instant,
  token: String,
  account: Option<GalleryAccount>,
}

static SESSION: Lazy<Mutex<Option<Session>>> = Lazy::new(Default::default);
static STATUSES: Lazy<Mutex<HashMap<String, (Instant, GalleryStatus)>>> = Lazy::new(Default::default);

/// Why the gallery can't read Fabric.
#[derive(Debug, Clone, PartialEq)]
enum Failure {
  /// The Azure sign-in is missing, expired or was rejected.
  NeedsAz(String),
  Failed(String),
}

impl From<entra::AzError> for Failure {
  fn from(e: entra::AzError) -> Self {
    match e.kind {
      AzErrorKind::Missing => Failure::NeedsAz(
        "Fabricator finds the apps you can open with the Azure CLI, which isn't installed. Install it from setup.".into(),
      ),
      AzErrorKind::NeedsLogin => {
        Failure::NeedsAz("Fabricator finds the apps you can open with your Azure sign-in. Sign in to Azure to see them.".into())
      }
      _ => Failure::Failed(format!("Couldn't use your Azure sign-in: {}", e.message)),
    }
  }
}

fn rejected() -> Failure {
  Failure::NeedsAz("Fabric didn't accept your Azure sign-in. Sign in to Azure again.".into())
}

/// The Azure token and account, reused for [`SESSION_TTL`] unless `fresh`.
async fn session(fresh: bool) -> Result<Session, Failure> {
  if !fresh {
    if let Some(s) = SESSION.lock().unwrap().as_ref() {
      if s.at.elapsed() < SESSION_TTL {
        return Ok(s.clone());
      }
    }
  }
  let (token, account) = tokio::join!(entra::token(RESOURCE), entra::account());
  let session = Session {
    at: Instant::now(),
    token: token?,
    account: account.ok().map(|(tenant, user)| GalleryAccount {
      user: Some(user).filter(|u| !u.trim().is_empty()),
      tenant_id: Some(tenant).filter(|t| !t.trim().is_empty()),
    }),
  };
  *SESSION.lock().unwrap() = Some(session.clone());
  Ok(session)
}

fn forget_session() {
  *SESSION.lock().unwrap() = None;
}

/* ---------------------------------- http --------------------------------- */

fn client() -> Result<reqwest::Client, Failure> {
  reqwest::Client::builder()
    .timeout(Duration::from_secs(30))
    // The token only ever goes to Fabric itself.
    .redirect(reqwest::redirect::Policy::none())
    .build()
    .map_err(|e| Failure::Failed(format!("Couldn't reach Fabric: {e}")))
}

/// One Fabric call: its HTTP status and JSON body (`Null` when it isn't JSON).
/// Waits out throttling a few times, as Fabric's `Retry-After` asks.
async fn call(
  client: &reqwest::Client,
  token: &str,
  method: reqwest::Method,
  url: &str,
  body: Option<&Value>,
  moniker: Option<&str>,
) -> Result<(u16, Value), Failure> {
  for attempt in 0..4 {
    let mut req = client.request(method.clone(), url).bearer_auth(token);
    if let Some(b) = body {
      req = req.json(b);
    }
    if let Some(m) = moniker {
      req = req.header(MONIKER_HEADER, m);
    }
    let res = req.send().await.map_err(|e| Failure::Failed(format!("Couldn't reach Fabric: {e}")))?;
    let status = res.status().as_u16();
    if status == 429 {
      if attempt == 3 {
        break;
      }
      let wait = res
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(5)
        .clamp(1, 30);
      tokio::time::sleep(Duration::from_secs(wait)).await;
      continue;
    }
    let text = res.text().await.unwrap_or_default();
    return Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)));
  }
  Err(Failure::Failed("Fabric is busy right now. Try again in a minute.".into()))
}

/// Fabric's own words for a failed call.
fn fabric_message(status: u16, body: &Value) -> String {
  body
    .get("message")
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|m| !m.is_empty())
    .map(String::from)
    .unwrap_or_else(|| format!("Fabric returned HTTP {status}."))
}

/// The next page of a Fabric list: its `continuationUri` when that stays on
/// Fabric's API, else `start` with the `continuationToken`.
fn next_page(start: &str, page: &Value) -> Option<String> {
  if let Some(uri) = page.get("continuationUri").and_then(Value::as_str) {
    if uri.starts_with(&format!("{API}/")) {
      return Some(uri.to_string());
    }
  }
  let token = page.get("continuationToken").and_then(Value::as_str).filter(|t| !t.is_empty())?;
  let mut url = reqwest::Url::parse(start).ok()?;
  let kept: Vec<(String, String)> = url
    .query_pairs()
    .filter(|(k, _)| k != "continuationToken")
    .map(|(k, v)| (k.into_owned(), v.into_owned()))
    .collect();
  url.query_pairs_mut().clear().extend_pairs(kept).append_pair("continuationToken", token);
  Some(url.to_string())
}

/* --------------------------------- parsing -------------------------------- */

fn is_guid(s: &str) -> bool {
  s.len() == 36
    && s.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

fn text(v: &Value, key: &str) -> Option<String> {
  v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// An app from a catalog search entry: a Fabric item of the app type, with
/// its workspace.
fn app_from_catalog(entry: &Value) -> Option<RawApp> {
  if text(entry, "type").is_some_and(|t| !t.eq_ignore_ascii_case(APP_TYPE)) {
    return None;
  }
  let workspace = entry.get("hierarchy")?.get("workspace")?;
  let (id, workspace_id) = (text(entry, "id")?, text(workspace, "id")?);
  (is_guid(&id) && is_guid(&workspace_id)).then(|| RawApp {
    name: text(entry, "displayName").unwrap_or_else(|| id.clone()),
    description: text(entry, "description"),
    workspace_name: text(workspace, "displayName").unwrap_or_else(|| "Workspace".into()),
    id,
    workspace_id,
  })
}

/// An app from a workspace's item list.
fn app_from_item(item: &Value, workspace_id: &str, workspace_name: &str) -> Option<RawApp> {
  let id = text(item, "id").filter(|id| is_guid(id))?;
  Some(RawApp {
    name: text(item, "displayName").unwrap_or_else(|| id.clone()),
    description: text(item, "description"),
    workspace_id: workspace_id.to_string(),
    workspace_name: workspace_name.to_string(),
    id,
  })
}

/// The catalog can't search for apps here (an unknown type or filter, or no
/// catalog search at all), so the workspaces are scanned instead.
fn catalog_unsupported(status: u16, body: &Value) -> bool {
  let code = body.get("errorCode").and_then(Value::as_str).unwrap_or_default();
  matches!(status, 403 | 404 | 405 | 501)
    || (status == 400
      && matches!(code, "TypeNotFound" | "InvalidFilter" | "InvalidFilterProperty" | "FilterNotSupported"))
}

/// The app's page in the Fabric portal, as `rayfin up status` links it.
fn portal_url(workspace_id: &str, item_id: &str, tenant: Option<&str>) -> String {
  let ctid = tenant.filter(|t| is_guid(t)).map(|t| format!("?ctid={t}")).unwrap_or_default();
  format!("{PORTAL}/groups/{workspace_id}/appbackends/{item_id}{ctid}")
}

/// An `https` address, or nothing: only those are opened.
fn https_url(raw: Option<&str>) -> Option<String> {
  let url = reqwest::Url::parse(raw?.trim()).ok()?;
  (url.scheme() == "https" && url.host_str().is_some_and(|h| !h.is_empty())).then(|| url.to_string().trim_end_matches('/').to_string())
}

/// What an app's deploy status says.
fn status_from(id: &str, body: &Value) -> GalleryStatus {
  GalleryStatus {
    id: id.to_string(),
    hosting_url: https_url(body.get("hostingUrl").and_then(Value::as_str)),
    published_at: body
      .get("lastSuccessfulDeploymentAt")
      .and_then(Value::as_str)
      .and_then(|t| chrono::DateTime::parse_from_rfc3339(t.trim()).ok())
      .map(|t| t.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    unknown: false,
  }
}

/* --------------------------------- listing -------------------------------- */

struct Listing {
  apps: Vec<RawApp>,
  truncated: bool,
}

enum ListError {
  /// The catalog can't search by the app type: scan the workspaces.
  Unsupported,
  Failure(Failure),
}

impl From<Failure> for ListError {
  fn from(f: Failure) -> Self {
    ListError::Failure(f)
  }
}

async fn catalog_apps(client: &reqwest::Client, token: &str) -> Result<Listing, ListError> {
  let url = format!("{API}/catalog/search");
  let mut body = json!({ "filter": format!("Type eq '{APP_TYPE}'"), "pageSize": PAGE_SIZE });
  let mut apps = Vec::new();
  for _ in 0..MAX_PAGES {
    let (status, page) = call(client, token, reqwest::Method::POST, &url, Some(&body), None).await?;
    if status == 401 {
      return Err(rejected().into());
    }
    if catalog_unsupported(status, &page) {
      return Err(ListError::Unsupported);
    }
    if status != 200 {
      return Err(Failure::Failed(format!("Couldn't list your Fabric apps: {}", fabric_message(status, &page))).into());
    }
    apps.extend(page.get("value").and_then(Value::as_array).into_iter().flatten().filter_map(app_from_catalog));
    // A continuation token carries the filter, and must be sent alone.
    match page.get("continuationToken").and_then(Value::as_str).filter(|t| !t.is_empty()) {
      Some(next) => body = json!({ "continuationToken": next }),
      None => return Ok(Listing { apps, truncated: false }),
    }
  }
  Ok(Listing { apps, truncated: true })
}

/// Every page of a Fabric list, or `Ok(None)` when Fabric won't list it for
/// this account (403/404).
async fn list_all(client: &reqwest::Client, token: &str, start: &str) -> Result<Option<(Vec<Value>, bool)>, Failure> {
  let mut items = Vec::new();
  let mut url = start.to_string();
  for _ in 0..MAX_PAGES {
    let (status, page) = call(client, token, reqwest::Method::GET, &url, None, None).await?;
    match status {
      200 => {}
      401 => return Err(rejected()),
      403 | 404 => return Ok(None),
      _ => return Err(Failure::Failed(format!("Couldn't list your Fabric apps: {}", fabric_message(status, &page)))),
    }
    items.extend(page.get("value").and_then(Value::as_array).cloned().unwrap_or_default());
    match next_page(start, &page) {
      Some(next) => url = next,
      None => return Ok(Some((items, false))),
    }
  }
  Ok(Some((items, true)))
}

/// The apps in every workspace the account belongs to.
async fn scanned_apps(client: &reqwest::Client, token: &str) -> Result<Listing, Failure> {
  let Some((workspaces, mut truncated)) = list_all(client, token, &format!("{API}/workspaces")).await? else {
    return Err(Failure::Failed("Couldn't list your Fabric workspaces.".into()));
  };
  let workspaces: Vec<(String, String)> = workspaces
    .iter()
    .filter_map(|w| {
      let id = text(w, "id").filter(|id| is_guid(id))?;
      let personal = text(w, "type").is_some_and(|t| t.eq_ignore_ascii_case("Personal"));
      let name = if personal { "My workspace".to_string() } else { text(w, "displayName").unwrap_or_else(|| id.clone()) };
      Some((id, name))
    })
    .collect();
  let results: Vec<Result<Option<(Vec<RawApp>, bool)>, Failure>> = stream::iter(workspaces)
    .map(|(id, name)| async move {
      let url = format!("{API}/workspaces/{id}/items?type={APP_TYPE}");
      let listed = list_all(client, token, &url).await?;
      Ok::<_, Failure>(listed.map(|(items, more)| {
        (items.iter().filter_map(|item| app_from_item(item, &id, &name)).collect(), more)
      }))
    })
    .buffer_unordered(SCAN_CONCURRENCY)
    .collect()
    .await;
  let mut apps = Vec::new();
  for result in results {
    if let Some((found, more)) = result? {
      apps.extend(found);
      truncated |= more;
    }
  }
  Ok(Listing { apps, truncated })
}

/* -------------------------------- matching -------------------------------- */

/// What this computer knows about Fabric apps.
#[derive(Default)]
struct LocalIndex {
  /// Fabric item id (lowercase) → the project that publishes it, and the
  /// address its registry records.
  by_item: HashMap<String, (GalleryLocal, Option<String>)>,
  /// Fabric workspace id (lowercase) → the team workspace publishing there.
  team_workspaces: HashMap<String, GalleryTeam>,
  /// (team workspace id, production item name) → the team app's project here.
  team_projects: HashMap<(String, String), GalleryLocal>,
}

/// Index the projects on this computer (most recently used first wins) and,
/// when team workspaces are on, their Fabric workspaces. `recorded` reads a
/// project's deployment registry.
fn local_index(
  projects: &[StudioProject],
  teams: &[TeamWorkspace],
  team_enabled: bool,
  recorded: impl Fn(&StudioProject) -> Vec<FabricDeployment>,
) -> LocalIndex {
  let mut index = LocalIndex::default();
  for project in projects.iter().filter(|p| p.missing != Some(true)) {
    let local = GalleryLocal { project_id: project.id.clone(), project_name: project.name.clone() };
    match &project.team {
      Some(binding) if team_enabled => {
        index
          .team_projects
          .entry((binding.workspace_id.clone(), naming::production_item(&binding.folder)))
          .or_insert(local);
      }
      Some(_) => {}
      None => {
        for deployment in recorded(project) {
          let Some(item) = deployment.item_id.as_deref().filter(|id| is_guid(id)) else { continue };
          index
            .by_item
            .entry(item.to_ascii_lowercase())
            .or_insert_with(|| (local.clone(), https_url(deployment.hosting_url.as_deref())));
        }
      }
    }
  }
  if team_enabled {
    for team in teams {
      let Some(fabric) = team.manifest.as_ref().map(|m| &m.fabric) else { continue };
      for (workspace, preview) in [(&fabric.production, false), (&fabric.previews, true)] {
        if is_guid(&workspace.id) {
          index.team_workspaces.entry(workspace.id.to_ascii_lowercase()).or_insert(GalleryTeam {
            workspace_id: team.id.clone(),
            name: team.name.clone(),
            preview,
          });
        }
      }
    }
  }
  index
}

fn decorate(app: RawApp, index: &LocalIndex, tenant: Option<&str>) -> GalleryApp {
  let team = index.team_workspaces.get(&app.workspace_id.to_ascii_lowercase()).cloned();
  let (local, hosting_url) = match index.by_item.get(&app.id.to_ascii_lowercase()) {
    Some((local, url)) => (Some(local.clone()), url.clone()),
    None => {
      let local = team.as_ref().filter(|t| !t.preview).and_then(|t| {
        index.team_projects.get(&(t.workspace_id.clone(), app.name.to_ascii_lowercase())).cloned()
      });
      (local, None)
    }
  };
  GalleryApp {
    portal_url: portal_url(&app.workspace_id, &app.id, tenant),
    id: app.id,
    name: app.name,
    description: app.description,
    workspace_id: app.workspace_id,
    workspace_name: app.workspace_name,
    hosting_url,
    local,
    team,
  }
}

fn recorded(project: &StudioProject) -> Vec<FabricDeployment> {
  crate::commands::deploy::recorded_deployments(Path::new(&project.path))
}

/* ---------------------------------- api ----------------------------------- */

fn failed(failure: Failure) -> GalleryResult {
  match failure {
    Failure::NeedsAz(error) => GalleryResult { ok: false, needs_az: Some(true), error: Some(error), ..Default::default() },
    Failure::Failed(error) => GalleryResult { ok: false, error: Some(error), ..Default::default() },
  }
}

async fn fetch(client: &reqwest::Client, token: &str) -> Result<Listing, Failure> {
  match catalog_apps(client, token).await {
    Ok(listing) => Ok(listing),
    Err(ListError::Unsupported) => scanned_apps(client, token).await,
    Err(ListError::Failure(f)) => Err(f),
  }
}

/// Every Rayfin app the Azure CLI's account can open, A to Z. `refresh` asks
/// Azure for a fresh sign-in and Fabric for fresh statuses (after signing in,
/// or when Refresh is selected).
pub async fn list(refresh: bool) -> GalleryResult {
  let client = match client() {
    Ok(c) => c,
    Err(f) => return failed(f),
  };
  let mut current = match session(refresh).await {
    Ok(s) => s,
    Err(f) => return failed(f),
  };
  let mut listing = fetch(&client, &current.token).await;
  // A reused token Fabric no longer accepts: try once with a fresh one.
  if matches!(listing, Err(Failure::NeedsAz(_))) && !refresh {
    forget_session();
    current = match session(true).await {
      Ok(s) => s,
      Err(f) => return failed(f),
    };
    listing = fetch(&client, &current.token).await;
  }
  let listing = match listing {
    Ok(l) => l,
    Err(f) => return failed(f),
  };
  let state = super::store::get_state();
  let index = local_index(&state.projects, &state.team_workspaces, super::store::team_workspaces_enabled(), recorded);
  let tenant = current.account.as_ref().and_then(|a| a.tenant_id.as_deref());
  let mut seen = std::collections::HashSet::new();
  let mut apps: Vec<GalleryApp> = listing
    .apps
    .into_iter()
    .filter(|a| seen.insert(a.id.to_ascii_lowercase()))
    .map(|a| decorate(a, &index, tenant))
    .collect();
  apps.sort_by_cached_key(|a| (a.name.to_lowercase(), a.workspace_name.to_lowercase()));
  if refresh {
    STATUSES.lock().unwrap().clear();
  }
  GalleryResult { ok: true, apps, account: current.account, truncated: listing.truncated, ..Default::default() }
}

/// What reading one app's deploy status came to.
enum Read {
  Status(GalleryStatus),
  /// Fabric rejected the token: say nothing for now, and sign in afresh next time.
  Rejected,
  /// Fabric couldn't be reached: say nothing for now, and ask again next time.
  Unreachable,
}

/// Each app's address and last publish, in the order asked (at most
/// [`STATUS_BATCH`] at a time). An app Fabric can't say anything about comes
/// back `unknown`. Never fails.
pub async fn status(apps: Vec<GalleryRef>) -> Vec<GalleryStatus> {
  let unknown = |id: &str| GalleryStatus { id: id.to_string(), unknown: true, ..Default::default() };
  let apps: Vec<GalleryRef> = apps.into_iter().take(STATUS_BATCH).collect();
  let mut out: Vec<Option<GalleryStatus>> = {
    let cache = STATUSES.lock().unwrap();
    apps
      .iter()
      .map(|a| {
        if !is_guid(&a.id) || !is_guid(&a.workspace_id) {
          return Some(unknown(&a.id));
        }
        cache.get(&a.id.to_ascii_lowercase()).filter(|(at, _)| at.elapsed() < STATUS_TTL).map(|(_, s)| s.clone())
      })
      .collect()
  };
  let wanted: Vec<(usize, GalleryRef)> =
    apps.iter().cloned().enumerate().filter(|(i, _)| out[*i].is_none()).collect();
  if !wanted.is_empty() {
    let (Ok(current), Ok(client)) = (session(false).await, client()) else {
      return apps.iter().zip(out).map(|(a, s)| s.unwrap_or_else(|| unknown(&a.id))).collect();
    };
    let reads: Vec<(usize, Read)> = stream::iter(wanted)
      .map(|(i, app)| {
        let (client, token) = (&client, current.token.as_str());
        async move {
          let url = format!("{API}/workspaces/{}/appBackends/{}/__private/deploy/status", app.workspace_id, app.id);
          let read = match call(client, token, reqwest::Method::GET, &url, None, Some(&app.id)).await {
            Ok((200, body)) => Read::Status(status_from(&app.id, &body)),
            Ok((401, _)) => Read::Rejected,
            Ok(_) => Read::Status(GalleryStatus { id: app.id.clone(), unknown: true, ..Default::default() }),
            Err(_) => Read::Unreachable,
          };
          (i, read)
        }
      })
      .buffer_unordered(STATUS_CONCURRENCY)
      .collect()
      .await;
    let mut cache = STATUSES.lock().unwrap();
    for (i, read) in reads {
      match read {
        Read::Status(s) => {
          cache.insert(s.id.to_ascii_lowercase(), (Instant::now(), s.clone()));
          out[i] = Some(s);
        }
        Read::Rejected => forget_session(),
        Read::Unreachable => {}
      }
    }
  }
  apps.iter().zip(out).map(|(a, s)| s.unwrap_or_else(|| unknown(&a.id))).collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::{TeamBinding, TeamFabricTargets, TeamFabricWorkspace, TeamManifest};

  const WS: &str = "fa67c3f6-03b2-4cc3-9403-956c4be2f38b";
  const ITEM: &str = "a1d5b7cd-5a28-4304-94cb-3a2060fda1b2";
  const TENANT: &str = "0c08c016-4b68-4350-a2ab-8ce1a6c81b97";

  fn entry(id: &str, name: &str, ws: &str) -> Value {
    json!({ "id": id, "type": "AppBackend", "catalogEntryType": "FabricItem", "displayName": name, "description": "",
            "hierarchy": { "workspace": { "id": ws, "displayName": "Sales" } } })
  }

  #[test]
  fn catalog_entries_become_apps_with_their_workspace() {
    let app = app_from_catalog(&entry(ITEM, "dashy", WS)).unwrap();
    assert_eq!(
      app,
      RawApp { id: ITEM.into(), name: "dashy".into(), description: None, workspace_id: WS.into(), workspace_name: "Sales".into() }
    );
    let described = app_from_catalog(&json!({ "id": ITEM, "type": "AppBackend", "displayName": "dashy", "description": " Expenses ",
      "hierarchy": { "workspace": { "id": WS, "displayName": "Sales" } } }))
    .unwrap();
    assert_eq!(described.description.as_deref(), Some("Expenses"));
    // Another type, an id that isn't one, or no workspace: not an app the gallery can link.
    assert!(app_from_catalog(&json!({ "id": ITEM, "type": "Report", "hierarchy": { "workspace": { "id": WS } } })).is_none());
    assert!(app_from_catalog(&entry("../../x", "dashy", WS)).is_none());
    assert!(app_from_catalog(&json!({ "id": ITEM, "type": "AppBackend", "displayName": "dashy" })).is_none());
  }

  #[test]
  fn the_catalog_falls_back_to_scanning_only_when_it_cant_search_by_type() {
    assert!(catalog_unsupported(400, &json!({ "errorCode": "TypeNotFound" })));
    assert!(catalog_unsupported(400, &json!({ "errorCode": "FilterNotSupported" })));
    assert!(catalog_unsupported(404, &Value::Null));
    assert!(catalog_unsupported(403, &json!({ "errorCode": "Forbidden" })));
    assert!(!catalog_unsupported(400, &json!({ "errorCode": "InvalidRequest" })));
    assert!(!catalog_unsupported(500, &Value::Null));
    assert!(!catalog_unsupported(200, &json!({ "value": [] })));
  }

  #[test]
  fn portal_links_match_rayfin_up_status() {
    assert_eq!(
      portal_url(WS, ITEM, Some(TENANT)),
      format!("https://app.fabric.microsoft.com/groups/{WS}/appbackends/{ITEM}?ctid={TENANT}")
    );
    assert_eq!(portal_url(WS, ITEM, None), format!("https://app.fabric.microsoft.com/groups/{WS}/appbackends/{ITEM}"));
    assert!(!portal_url(WS, ITEM, Some("not a tenant&x=1")).contains("ctid"));
  }

  #[test]
  fn pages_follow_tokens_and_only_fabric_continuation_uris() {
    let start = format!("{API}/workspaces/{WS}/items?type=AppBackend");
    assert_eq!(
      next_page(&start, &json!({ "continuationToken": "a+b/c=" })).unwrap(),
      format!("{API}/workspaces/{WS}/items?type=AppBackend&continuationToken=a%2Bb%2Fc%3D")
    );
    let fabric = format!("{API}/workspaces?continuationToken=xyz");
    assert_eq!(next_page(&start, &json!({ "continuationUri": fabric })).unwrap(), fabric);
    // A continuation link anywhere else isn't followed with the token: the token stays with Fabric.
    assert!(next_page(&start, &json!({ "continuationUri": "https://evil.example/next" })).is_none());
    assert!(next_page(&start, &json!({ "value": [] })).is_none());
  }

  #[test]
  fn deploy_status_gives_an_https_address_and_a_normalized_time() {
    let status = status_from(
      ITEM,
      &json!({ "deployedCodeOrigin": "User", "lastSuccessfulDeploymentAt": "2026-10-24T03:34:31.0000000Z",
               "hostingUrl": "https://noble-bluff-49ca4d5430-westus.webapp.fabricapps.net/" }),
    );
    assert_eq!(status.hosting_url.as_deref(), Some("https://noble-bluff-49ca4d5430-westus.webapp.fabricapps.net"));
    assert_eq!(status.published_at.as_deref(), Some("2026-10-24T03:34:31Z"));
    assert!(!status.unknown);
    let unsafe_status = status_from(ITEM, &json!({ "hostingUrl": "javascript:alert(1)", "lastSuccessfulDeploymentAt": "soon" }));
    assert_eq!(unsafe_status.hosting_url, None);
    assert_eq!(unsafe_status.published_at, None);
  }

  fn project(id: &str, name: &str) -> StudioProject {
    serde_json::from_value(json!({ "id": id, "name": name, "path": format!("C:/p/{id}"), "addedAt": "2026-01-01" })).unwrap()
  }

  fn deployment(item: &str, hosting: Option<&str>) -> FabricDeployment {
    FabricDeployment {
      workspace_name: "Sales".into(),
      name: None,
      active: true,
      workspace_id: Some(WS.into()),
      item_id: Some(item.into()),
      api_url: None,
      hosting_url: hosting.map(String::from),
      deployed_at: None,
    }
  }

  fn team(production: &str, previews: &str) -> TeamWorkspace {
    let mut team: TeamWorkspace = serde_json::from_value(json!({
      "id": "team-1", "name": "Trips team", "repo": "contoso/trips", "dir": "C:/teams/trips", "addedAt": "2026-01-01"
    }))
    .unwrap();
    team.manifest = Some(TeamManifest {
      fabric: TeamFabricTargets {
        production: TeamFabricWorkspace { id: production.into(), name: "Trips".into() },
        previews: TeamFabricWorkspace { id: previews.into(), name: "Trips previews".into() },
      },
      ..serde_json::from_value(json!({})).unwrap()
    });
    team
  }

  fn raw(id: &str, name: &str, ws: &str) -> RawApp {
    RawApp { id: id.into(), name: name.into(), description: None, workspace_id: ws.into(), workspace_name: "W".into() }
  }

  #[test]
  fn apps_are_matched_to_this_computers_projects_and_team_workspaces() {
    const PROD: &str = "11111111-1111-1111-1111-111111111111";
    const PREVIEWS: &str = "22222222-2222-2222-2222-222222222222";
    const TEAM_ITEM: &str = "33333333-3333-3333-3333-333333333333";
    const PREVIEW_ITEM: &str = "44444444-4444-4444-4444-444444444444";
    let mut missing = project("gone", "Gone");
    missing.missing = Some(true);
    let mut trips = project("trips", "Trips");
    trips.team = Some(serde_json::from_value::<TeamBinding>(json!({
      "workspaceId": "team-1", "folder": "trip-logger", "worktree": "C:/teams/trips/trip-logger"
    })).unwrap());
    let projects = vec![project("p1", "Dashy"), project("p2", "Dashy copy"), missing, trips];
    let teams = vec![team(PROD, PREVIEWS)];
    let read = |p: &StudioProject| match p.id.as_str() {
      "p1" | "p2" | "gone" => vec![deployment(&ITEM.to_uppercase(), Some("https://flat-oak.webapp.fabricapps.net"))],
      _ => vec![],
    };

    let index = local_index(&projects, &teams, true, read);
    let mine = decorate(raw(ITEM, "dashy", WS), &index, Some(TENANT));
    // The most recently used project that publishes it, with the address its registry records.
    assert_eq!(mine.local, Some(GalleryLocal { project_id: "p1".into(), project_name: "Dashy".into() }));
    assert_eq!(mine.hosting_url.as_deref(), Some("https://flat-oak.webapp.fabricapps.net"));
    assert_eq!(mine.team, None);

    let published = decorate(raw(TEAM_ITEM, "trip-logger", PROD), &index, None);
    assert_eq!(published.team, Some(GalleryTeam { workspace_id: "team-1".into(), name: "Trips team".into(), preview: false }));
    assert_eq!(published.local, Some(GalleryLocal { project_id: "trips".into(), project_name: "Trips".into() }));

    let preview = decorate(raw(PREVIEW_ITEM, "trip-logger-pv-amy", PREVIEWS), &index, None);
    assert!(preview.team.as_ref().is_some_and(|t| t.preview));
    assert_eq!(preview.local, None);

    let elsewhere = decorate(raw("55555555-5555-5555-5555-555555555555", "other", WS), &index, None);
    assert_eq!((elsewhere.local, elsewhere.team, elsewhere.hosting_url), (None, None, None));

    // With team workspaces off, team apps are just apps.
    let index = local_index(&projects, &teams, false, read);
    let published = decorate(raw(TEAM_ITEM, "trip-logger", PROD), &index, None);
    assert_eq!((published.local, published.team), (None, None));
  }
}
