//! The tools Copilot creates, changes and refreshes supporting items with, in a
//! Build chat that has them on (see [`super::on_for`]). Neither does anything
//! in Fabric before the user approves a review card ([`super::review`]): the
//! card is the permission, so the tools skip the runtime's own.
//!
//! - `fabricator_apply_supporting_items` checks the definitions in
//!   `supporting-items/`, shows what it would create or change and where, and
//!   once approved creates or updates each semantic model and records it in
//!   `supporting-items/applied.json`.
//! - `fabricator_refresh_supporting_item` loads a model's data, which an Import
//!   model has none of until then, and reports what went wrong when it fails,
//!   such as blank keys or a data source without credentials.
//!
//! While they're off in an app's chat, where they're offered (see
//! [`super::InChat`]), chat gets `fabricator_turn_on_supporting_items` instead:
//! it asks the user on a card to turn them on, and chat then continues the
//! request in a new message ([`take_continue`]), since a session gets its tools
//! and guidance only when it opens.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::ToolInvocation;
use github_copilot_sdk::{Error as SdkError, Tool, ToolResult};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager};

use super::analysis;
use super::fabric::{self, Account, Failure};
use super::review::{self, ItemChange, ItemState, Review, ReviewItem, ReviewKind, ReviewState, TableChange};
use super::{
  description, folders, in_chat, item_url, item_url_of, lakehouse, load_state, model_hash, on_for, problems_text,
  read_item, save_state, settings_url, split_folder, status_of, target, tmdl, tmdl_files, AppliedItem, AppliedState,
  Creating, InChat, Item, Part, Status, Workspace, DIR, LAKEHOUSE, PLUGIN,
};
use crate::services::agent_tools::{ask_on_card, failure, not_now, shown_reason, Card, QUESTION_POLL};
use crate::services::emit::emit_chat_event;
use crate::services::exec::CancelToken;
use crate::services::store;
use crate::state::{AppState, PlanGate, ReviewDecision, TurnRoute};
use crate::types::ChatEvent;

pub const APPLY_TOOL: &str = "fabricator_apply_supporting_items";
pub const REFRESH_TOOL: &str = "fabricator_refresh_supporting_item";
pub const TURN_ON_TOOL: &str = "fabricator_turn_on_supporting_items";

/// How long the refresh tool waits for a refresh to end.
const REFRESH_WAIT: Duration = Duration::from_secs(10 * 60);
/// How often it asks Power BI how the refresh is going.
const REFRESH_POLL: Duration = Duration::from_secs(5);

/// The supporting items tools of a project's chat: the ones that change
/// Fabric while they're on, the one that asks to turn them on while they're
/// off, and none where they aren't offered.
pub fn tools(app: AppHandle, project_id: String, in_chat: InChat) -> Vec<Tool> {
  match in_chat {
    InChat::On => {
      // Before Copilot copies any data into a lakehouse's folder.
      if let Some(project) = store::find_project(&project_id) {
        super::ensure_gitignore(Path::new(&project.path));
      }
      vec![apply_tool(app.clone(), project_id.clone()), refresh_tool(app, project_id)]
    }
    InChat::Off => vec![turn_on_tool(app, project_id)],
    InChat::Unavailable => Vec::new(),
  }
}

/// The turns, by project, at whose end chat continues in a new message because
/// the user turned supporting items on during them.
pub(super) static CONTINUE: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(Mutex::default);

/// Whether chat continues in a new message after `turn_id`, in which the user
/// turned supporting items on: once, as the turn ends.
pub fn take_continue(project_id: &str, turn_id: &str) -> bool {
  let mut pending = CONTINUE.lock().unwrap();
  if pending.get(project_id).is_some_and(|turn| turn == turn_id) {
    pending.remove(project_id);
    true
  } else {
    false
  }
}

fn turn_on_tool(app: AppHandle, project_id: String) -> Tool {
  Tool::new(TURN_ON_TOOL)
    .with_description(
      "Turn on supporting items in this app's chat. Supporting items are the Power BI semantic models \
       this app relies on that aren't part of the Rayfin app, and the lakehouses their data is staged \
       in, which Fabricator creates and changes in the app's Fabric workspace once the user approves \
       each change. They're off in this chat, so you can't build one now. Call this when the user \
       wants a semantic model (a dataset or Power BI model) built or changed for this app, for example \
       over their Snowflake, SQL or lakehouse data or over data you gather for them, or gives you data \
       files (CSV, Parquet, Excel) to build a report, dashboard or model on. Fabricator asks the user \
       with a button. If they turn supporting items on, Fabricator continues their request in a new \
       message, with the tools that create the items and their instructions: don't write them in this \
       message. Pass `reason`: what the items are for, in a few plain words, which the user sees.",
    )
    .with_parameters(json!({
      "type": "object",
      "properties": {
        "reason": {
          "type": "string",
          "description": "What the items are for, in a few plain words that follow \"for\" on the user's card: a noun phrase such as \"the monthly revenue dashboard\", or an -ing phrase such as \"staging the sales files for a report\". Not an instruction such as \"stage the data\"."
        }
      },
      "required": ["reason"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(TurnOnTool { app, project_id }))
}

struct TurnOnTool {
  app: AppHandle,
  project_id: String,
}

#[derive(Deserialize, Default)]
struct TurnOnParams {
  #[serde(default, alias = "purpose")]
  reason: Option<String>,
}

#[async_trait]
impl ToolHandler for TurnOnTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = invocation.params::<TurnOnParams>().unwrap_or_default();
    let reason = params.reason.as_deref().map(shown_reason).filter(|r| !r.is_empty());
    Ok(turn_on(&self.app, &self.project_id, invocation.session_id.as_str(), reason).await)
  }
}

/// What Copilot hears once the user turned supporting items on.
const TURNED_ON: &str = "Supporting items are on for this app now. Their tools and instructions load in a new \
  message, which Fabricator sends as soon as this one ends, so don't write the semantic model or its files in this \
  message. Finish anything else the user asked for that doesn't need the model, or end this message now with one \
  short sentence saying you'll build the model next.";

/// What Copilot hears when the user leaves supporting items off.
const LEFT_OFF: &str = "The user left supporting items off, so don't build or change a semantic model in Fabric, and \
  don't try another way. Carry on with what doesn't need it, and tell them they can turn on Supporting items in the \
  chat's Plugins & tools whenever they want the model.";

/// Ask the user to turn supporting items on in the app's chat, and have chat
/// continue in a new message once they do.
async fn turn_on(app: &AppHandle, project_id: &str, session_id: &str, reason: Option<String>) -> ToolResult {
  let state = app.state::<AppState>();
  let turn = match turn_of(app, &state, project_id, session_id) {
    Ok(turn) => turn,
    Err(result) => return result,
  };
  let lock = busy_lock(project_id);
  let _one_at_a_time = tokio::select! {
    guard = lock.lock() => guard,
    _ = turn.cancel.wait_cancelled() => return stopped(),
  };
  let Some(project) = store::find_project(project_id) else {
    return failure("This app isn't in Fabricator anymore.");
  };
  let continue_after = || {
    CONTINUE.lock().unwrap().insert(project_id.to_string(), turn.route.turn_id.clone());
    ToolResult::Text(TURNED_ON.into())
  };
  match in_chat(&project) {
    InChat::Unavailable => {
      return failure(
        "Supporting items aren't available for this app: team apps don't have them. Don't build the semantic model \
         or lakehouse another way: tell the user.",
      )
    }
    // Turned on another way since this message started.
    InChat::On => return continue_after(),
    InChat::Off => {}
  }
  let shown = vec![TURN_ON_TOOL.to_string()];
  if declined_before(project_id, &turn.route.turn_id, &shown) {
    return ToolResult::Text(LEFT_OFF.into());
  }
  let accept = t!("services.supportingItems.turnOn");
  let question = match &reason {
    Some(reason) => t!("services.supportingItems.turnOnQuestionFor", reason = reason),
    None => t!("services.supportingItems.turnOnQuestion"),
  };
  match turn.ask(question, vec![accept.clone(), not_now()]).await {
    Some(answer) if answer == accept => {}
    Some(_) => {
      remember_declined(project_id, &turn.route.turn_id, shown);
      track_turn_on("declined");
      return ToolResult::Text(LEFT_OFF.into());
    }
    None if turn.cancel.is_cancelled() => return stopped(),
    None => return failure("The user didn't answer, so supporting items are still off."),
  }
  if let Err(why) = crate::commands::chat::chat_set_plugin(project_id.into(), PLUGIN.into(), true) {
    return failure(format!("Fabricator couldn't turn on supporting items: {why}"));
  }
  turn.emit(ChatEvent::PluginsChanged);
  track_turn_on("approved");
  continue_after()
}

fn track_turn_on(outcome: &str) {
  let identity = crate::commands::auth::get_cached_identity();
  crate::services::telemetry::track_supporting(identity.as_ref(), "turn-on", outcome, &[]);
}

fn apply_tool(app: AppHandle, project_id: String) -> Tool {
  Tool::new(APPLY_TOOL)
    .with_description(
      "Create or update this app's supporting items in its Microsoft Fabric workspace: the Power BI \
       semantic models the app relies on that aren't part of the Rayfin app, each defined in TMDL in \
       supporting-items/<Name>.SemanticModel/, and the lakehouses their data is staged in, each in \
       supporting-items/<Name>.Lakehouse/ with a tables.json that lists the CSV or Parquet files under \
       its data/ to load as tables (see the supporting-semantic-models skill). Write or change the \
       definition first, then call this. Fabricator checks it, shows the user a review card with the \
       workspace, a summary and what changes, and creates or updates the items only if they approve, so \
       don't ask them yourself. For a lakehouse, it then uploads the files and loads each table, and \
       tells you each table's columns and types. Without `items`, every item whose definition or data \
       changed since it was last applied is applied, lakehouses first; pass `items` (folder names such \
       as \"Sales.SemanticModel\", or item names) to apply only those. Pass `reason`: what the items are \
       for, in a few plain words, which the user sees. This is the only way to create or change a \
       semantic model, a lakehouse, its files or any other Fabric item: never use az rest, curl, azcopy, \
       the Fabric CLI or a script for it.",
    )
    .with_parameters(json!({
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": { "type": "string" },
          "description": "The items to apply: folder names in supporting-items/, such as \"Sales.SemanticModel\", or model names. Leave out to apply every item whose definition changed."
        },
        "reason": {
          "type": "string",
          "description": "What the items are for, in a few plain words, which the user sees on the card as its purpose, such as \"the monthly revenue dashboard\"."
        }
      },
      "required": ["reason"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(ApplyTool { app, project_id }))
}

fn refresh_tool(app: AppHandle, project_id: String) -> Tool {
  Tool::new(REFRESH_TOOL)
    .with_description(
      "Load the data of one of this app's supporting semantic models in Fabric, once it's created or \
       changed with fabricator_apply_supporting_items: an Import model has no data until it's \
       refreshed. Fabricator asks the user on a card first, runs the refresh, and waits for it for up \
       to 10 minutes. Pass `item` (its folder name, such as \"Sales.SemanticModel\", or the model's \
       name) and `reason`, in a few plain words. When the refresh fails, the errors say why: fix the \
       definition and apply it again, or, when the data source has no credentials, ask the user to set \
       them in Fabric.",
    )
    .with_parameters(json!({
      "type": "object",
      "properties": {
        "item": { "type": "string", "description": "The item to refresh: its folder name in supporting-items/, such as \"Sales.SemanticModel\", or the model's name." },
        "reason": { "type": "string", "description": "What the data is needed for, in a few plain words, which the user sees on the card as its purpose, such as \"checking the dashboard's numbers\"." }
      },
      "required": ["item", "reason"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(RefreshTool { app, project_id }))
}

struct ApplyTool {
  app: AppHandle,
  project_id: String,
}

#[derive(Deserialize, Default)]
struct ApplyParams {
  #[serde(default)]
  items: Option<Vec<String>>,
  #[serde(default, alias = "purpose")]
  reason: Option<String>,
}

#[async_trait]
impl ToolHandler for ApplyTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = invocation.params::<ApplyParams>().unwrap_or_default();
    let reason = params.reason.as_deref().map(shown_reason).filter(|r| !r.is_empty());
    let wanted = params.items.unwrap_or_default();
    Ok(apply(&self.app, &self.project_id, invocation.session_id.as_str(), &wanted, reason).await)
  }
}

struct RefreshTool {
  app: AppHandle,
  project_id: String,
}

#[derive(Deserialize, Default)]
struct RefreshParams {
  #[serde(default, alias = "items", alias = "name")]
  item: Option<String>,
  #[serde(default, alias = "purpose")]
  reason: Option<String>,
}

#[async_trait]
impl ToolHandler for RefreshTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = invocation.params::<RefreshParams>().unwrap_or_default();
    let reason = params.reason.as_deref().map(shown_reason).filter(|r| !r.is_empty());
    let item = params.item.unwrap_or_default();
    Ok(refresh(&self.app, &self.project_id, invocation.session_id.as_str(), item.trim(), reason).await)
  }
}

/* ---------------------------------- turns --------------------------------- */

/// One supporting items operation at a time in a project, so a second call
/// (made in parallel, or by a subagent) waits for the first one's card.
static BUSY: Lazy<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = Lazy::new(Mutex::default);

fn busy_lock(project_id: &str) -> Arc<tokio::sync::Mutex<()>> {
  BUSY.lock().unwrap().entry(project_id.to_string()).or_default().clone()
}

/// The turn in which the user last turned a card down, by project, and what the
/// card showed: the same isn't put to them again in that turn.
static DECLINED: Lazy<Mutex<HashMap<String, (String, Vec<String>)>>> = Lazy::new(Mutex::default);

fn declined_before(project_id: &str, turn_id: &str, shown: &[String]) -> bool {
  DECLINED.lock().unwrap().get(project_id).is_some_and(|(turn, what)| turn == turn_id && what == shown)
}

fn remember_declined(project_id: &str, turn_id: &str, shown: Vec<String>) {
  DECLINED.lock().unwrap().insert(project_id.to_string(), (turn_id.to_string(), shown));
}

/// A refresh still running in Fabric when its tool stopped waiting for it.
#[derive(Clone, Debug)]
struct Running {
  refresh_id: Option<String>,
  started: DateTime<Utc>,
}

/// The refreshes still running, by project and item key: the next call follows
/// one rather than starting another.
static RUNNING: Lazy<Mutex<HashMap<(String, String), Running>>> = Lazy::new(Mutex::default);

/// The chat turn a tool runs in, and how it reaches the user.
struct Turn<'a> {
  app: &'a AppHandle,
  gate: &'a PlanGate,
  session_id: &'a str,
  route: TurnRoute,
  cancel: CancelToken,
}

impl Turn<'_> {
  fn emit(&self, event: ChatEvent) {
    emit_chat_event(self.app, &self.route.project_id, &self.route.turn_id, event);
  }

  fn show(&self, review: &Review) {
    self.emit(ChatEvent::SupportingReview { review: review.to_value() });
  }

  /// Ask a question on a card, as Fabric IQ's tool does.
  async fn ask(&self, question: String, choices: Vec<String>) -> Option<String> {
    let emit = |event: ChatEvent| self.emit(event);
    ask_on_card(self.gate, self.session_id, self.route.plan_context, Card { question, choices }, &emit, &self.cancel, QUESTION_POLL)
      .await
  }

  /// Show `review` and wait for the user's decision: `None` when the turn ends
  /// or stops first.
  async fn decide(&self, review: &Review) -> Option<ReviewDecision> {
    let answer = self.gate.register_pending_review(self.session_id, &review.id);
    self.show(review);
    tokio::select! {
      answer = answer => answer.ok(),
      _ = self.cancel.wait_cancelled() => {
        self.gate.reject_pending_review(self.session_id);
        None
      }
    }
  }
}

fn stopped() -> ToolResult {
  failure("The user stopped the message.")
}

fn unanswered(cancel: &CancelToken) -> ToolResult {
  if cancel.is_cancelled() {
    stopped()
  } else {
    failure("The user didn't answer, so nothing changed in Fabric.")
  }
}

fn now_rfc3339() -> String {
  Utc::now().to_rfc3339()
}

/// Count what happened to a card (see `telemetry::track_supporting`).
fn track(kind: ReviewKind, outcome: &str, props: &[(&str, String)]) {
  let kind = match kind {
    ReviewKind::Apply => "apply",
    ReviewKind::Refresh => "refresh",
  };
  let identity = crate::commands::auth::get_cached_identity();
  crate::services::telemetry::track_supporting(identity.as_ref(), kind, outcome, props);
}

/// An error code as counted: Fabric's and Power BI's are short words; anything
/// else is `other`, and none is `none`.
fn error_code(code: Option<&str>) -> String {
  match code.map(str::trim) {
    None | Some("") => "none".into(),
    Some(code) if code.len() <= 80 && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') => {
      code.to_string()
    }
    Some(_) => "other".into(),
  }
}

fn now_ms() -> f64 {
  Utc::now().timestamp_millis() as f64
}

/// The turn a tool call belongs to, or why it can't run now.
fn turn_of<'a>(app: &'a AppHandle, state: &'a AppState, project_id: &str, session_id: &'a str) -> Result<Turn<'a>, ToolResult> {
  let Some(route) = state.plan.route(session_id).filter(|r| r.project_id == project_id) else {
    return Err(failure("Fabricator changes supporting items only while a chat message is in progress."));
  };
  let cancel = state.chat_token(project_id).unwrap_or_default();
  Ok(Turn { app, gate: &state.plan, session_id, route, cancel })
}

/// What Copilot hears when the app's chat doesn't have supporting items now.
const OFF: &str = "Supporting items are off in this chat now, so Fabricator can't create or change them. Tell the \
  user they can turn on Supporting items in the chat's Plugins & tools. Don't create or change Fabric items another \
  way.";

/// The app's Fabric account, which Fabricator creates and changes its supporting
/// items as, signed in, with its name for the card: when it needs the user to
/// sign in again, it asks them on a card. The tool's result when it can't.
async fn ensure_fabric(turn: &Turn<'_>, dir: &Path) -> Result<(Account, Option<String>), ToolResult> {
  let account = Account::of(dir).map_err(|f| failure(format!("{} Tell the user.", f.message)))?;
  match fabric::signed_in(&account).await {
    Ok(who) => return Ok((account, who.user)),
    Err(f) if !f.needs_login => {
      return Err(failure(format!(
        "Fabricator couldn't use the app's Fabric sign-in ({}). Tell the user what happened.",
        f.message
      )))
    }
    Err(_) => {}
  }
  let accept = t!("services.supportingItems.signIn");
  match turn.ask(t!("services.supportingItems.signInQuestion"), vec![accept.clone(), not_now()]).await {
    Some(answer) if answer == accept => {}
    Some(_) => {
      return Err(ToolResult::Text(
        "The user didn't sign in to Fabric, so Fabricator can't change supporting items in this message. Don't do it \
         another way: carry on without it, or ask the user how they'd like to go on."
          .into(),
      ))
    }
    None => return Err(unanswered(&turn.cancel)),
  }
  turn.emit(ChatEvent::Notice { text: t!("services.signIn.inBrowser", name = "Fabric") });
  let signed = tokio::select! {
    result = crate::commands::auth::auth_login_rayfin(turn.app.clone(), None, Some(turn.route.project_id.clone())) => result,
    _ = turn.cancel.wait_cancelled() => return Err(stopped()),
  };
  if !signed.ok {
    let why = signed.error.unwrap_or_else(|| "it didn't finish".into());
    return Err(failure(format!(
      "The Fabric sign-in didn't work ({why}), so Fabricator can't change supporting items now. Tell the user, and \
       that they can try again."
    )));
  }
  fabric::signed_in(&account).await.map(|who| (account, who.user)).map_err(|f| {
    failure(format!("Fabricator still can't use the app's Fabric sign-in ({}). Tell the user.", f.message))
  })
}

/// What Copilot hears when a Fabric call needs the user to sign in again.
const SIGN_IN_AGAIN: &str = "The app's Fabric sign-in stopped working while Fabricator talked to Fabric. Ask the user \
  to select Refresh Fabric authentication in Fabricator's account menu, then try again.";
/* --------------------------------- choosing -------------------------------- */

/// The folders among `all` that `wanted` names: by folder name
/// (`Sales.SemanticModel`), model name (`Sales`) or path, ignoring case. All of
/// them when `wanted` is empty.
fn choose(all: &[String], wanted: &[String]) -> Result<Vec<String>, String> {
  if wanted.iter().all(|w| w.trim().is_empty()) {
    return Ok(all.to_vec());
  }
  let mut chosen: Vec<String> = Vec::new();
  let mut unknown = Vec::new();
  for w in wanted.iter().map(|w| w.trim()).filter(|w| !w.is_empty()) {
    let w = w.replace('\\', "/");
    let last = w.trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_string();
    let found = all.iter().find(|f| {
      f.eq_ignore_ascii_case(&last) || split_folder(f).is_some_and(|(name, _)| name.eq_ignore_ascii_case(&last))
    });
    match found {
      Some(f) if !chosen.contains(f) => chosen.push(f.clone()),
      Some(_) => {}
      None => unknown.push(format!("\"{last}\"")),
    }
  }
  if unknown.is_empty() {
    Ok(chosen)
  } else {
    Err(format!(
      "{} isn't in {DIR}/, which has: {}.",
      unknown.join(", "),
      all.iter().map(|f| format!("\"{f}\"")).collect::<Vec<_>>().join(", ")
    ))
  }
}

/// A connector alias for a model: its name, lowercase, letters and digits only.
fn alias_of(name: &str) -> String {
  let alias: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase();
  if alias.is_empty() {
    "model".into()
  } else {
    alias
  }
}

/* ---------------------------------- apply --------------------------------- */

/// What applying does to one item.
struct Plan {
  item: Item,
  /// The Fabric item it updates; `None` creates one.
  existing: Option<String>,
  card: ReviewItem,
  /// For a lakehouse: the tables it loads, by their index in its definition,
  /// in the order the card lists them.
  loads: Vec<usize>,
}

/// An item to create: a lakehouse loads every table it lists.
fn new_plan(item: Item) -> Plan {
  let card = review::create_item(&item);
  let loads = (0..card.tables.len()).collect();
  Plan { item, existing: None, card, loads }
}

/// An update to `item_id`, with what changes from the model Fabric has now.
async fn update_plan(
  account: &Account,
  item: Item,
  ws: &Workspace,
  item_id: &str,
  fabric_hash: Option<&str>,
) -> Result<Plan, ToolResult> {
  match fabric::get_definition(account, &ws.id, item_id).await {
    Ok(parts) => {
      let model = tmdl::parse_definition(&tmdl_files(&parts)).ok();
      let drift = matches!((&model, fabric_hash), (Some(m), Some(h)) if model_hash(m) != h);
      let card = review::update_item(&item, item_id, model.as_ref(), drift);
      Ok(Plan { item, existing: Some(item_id.to_string()), card, loads: Vec::new() })
    }
    Err(f) if f.not_found => {
      let mut plan = new_plan(item);
      plan.card.recreate = true;
      Ok(plan)
    }
    Err(f) if f.signs_in() => Err(failure(SIGN_IN_AGAIN)),
    // Its definition can't be read (say, the user's access changed): the card says so.
    Err(f) => {
      log::warn!("couldn't read the definition of supporting item {}: {}", item.folder, f.message);
      let card = review::update_item(&item, item_id, None, false);
      Ok(Plan { item, existing: Some(item_id.to_string()), card, loads: Vec::new() })
    }
  }
}

/// Whether `table` would load what `loaded` did, reading files' contents only
/// when their sizes or times changed.
async fn unchanged(table: &lakehouse::TableSource, loaded: &lakehouse::LoadedTable) -> bool {
  let (table, loaded) = (table.clone(), loaded.clone());
  tokio::task::spawn_blocking(move || lakehouse::same_as_loaded(&table, &loaded)).await.unwrap_or(false)
}

/// A lakehouse that's in Fabric as `recorded`: the tables to load again (those
/// whose data, or the way it's read, changed) and new ones. All of them when
/// the lakehouse is gone from Fabric and is created again.
async fn lakehouse_plan(account: &Account, item: Item, ws: &Workspace, recorded: &AppliedItem) -> Result<Plan, ToolResult> {
  match fabric::get_lakehouse(account, &ws.id, &recorded.item_id).await {
    Ok(Some(_)) => {}
    Ok(None) => {
      let mut plan = new_plan(item);
      plan.card.recreate = true;
      return Ok(plan);
    }
    Err(f) if f.signs_in() => return Err(failure(SIGN_IN_AGAIN)),
    Err(f) if f.not_found => return Err(failure(not_open(ws))),
    Err(f) => {
      return Err(failure(format!("Fabricator couldn't read the lakehouse \"{}\" in Fabric: {}", item.name, f.message)))
    }
  }
  let tables = item.lakehouse.as_ref().map(|d| d.tables.clone()).unwrap_or_default();
  let mut loads = Vec::new();
  for (i, table) in tables.iter().enumerate() {
    match recorded.tables.get(&table.name) {
      Some(loaded) if unchanged(table, loaded).await => {}
      Some(_) => loads.push((i, TableChange::Reload)),
      None => loads.push((i, TableChange::Load)),
    }
  }
  let card = review::lakehouse_item(&item, &recorded.item_id, &loads);
  Ok(Plan { item, existing: Some(recorded.item_id.clone()), card, loads: loads.into_iter().map(|(i, _)| i).collect() })
}

/// "semantic model" or "lakehouse", for Copilot.
fn kind_name(item_type: &str) -> &'static str {
  if item_type == LAKEHOUSE {
    "lakehouse"
  } else {
    "semantic model"
  }
}

/// What Copilot hears when an item of the item's name and type, which the app
/// didn't create, is in the workspace already.
fn name_taken(item: &Item, ws: &Workspace) -> String {
  let kind = kind_name(&item.item_type);
  format!(
    "The workspace \"{}\" already has a {kind} named \"{}\", and it isn't one this app created, so Fabricator \
     won't change it. Use another name: rename the folder {}/{} and the displayName in its .platform to match, then \
     apply again. If the user wants the app to use the {kind} that's there, connect it as it is instead.",
    ws.name,
    item.name,
    DIR,
    item.folder
  )
}

/// How each item would be applied in `ws`, checked against what Fabric has,
/// lakehouses first: a Direct Lake model applied with one reads its tables.
/// `applied` learns of an earlier creation that went through after all.
async fn plan_all(account: &Account, items: Vec<Item>, applied: &mut AppliedState, ws: &Workspace) -> Result<Vec<Plan>, ToolResult> {
  let mut plans = Vec::new();
  for item in items {
    if let Some(recorded) = applied.items.get(&item.key).cloned() {
      plans.push(if item.is_lakehouse() {
        lakehouse_plan(account, item, ws, &recorded).await?
      } else {
        update_plan(account, item, ws, &recorded.item_id, recorded.fabric_hash.as_deref()).await?
      });
      continue;
    }
    match fabric::find_item(account, &ws.id, &item.item_type, &item.name).await {
      // An earlier creation's outcome wasn't known, and it went through: it's this app's.
      Ok(Some(found)) if applied.creating.contains_key(&item.key) => {
        applied.creating.remove(&item.key);
        let recorded = AppliedItem {
          item_id: found.id.clone(),
          item_type: item.item_type.clone(),
          display_name: item.name.clone(),
          folder: item.folder.clone(),
          applied_at: now_rfc3339(),
          ..Default::default()
        };
        applied.items.insert(item.key.clone(), recorded.clone());
        plans.push(if item.is_lakehouse() {
          lakehouse_plan(account, item, ws, &recorded).await?
        } else {
          update_plan(account, item, ws, &found.id, None).await?
        });
      }
      Ok(Some(_)) => return Err(failure(name_taken(&item, ws))),
      Ok(None) => plans.push(new_plan(item)),
      Err(f) if f.signs_in() => return Err(failure(SIGN_IN_AGAIN)),
      Err(f) if f.not_found => return Err(failure(not_open(ws))),
      Err(f) => {
        return Err(failure(format!(
          "Fabricator couldn't check the workspace \"{}\" for a {} named \"{}\": {}",
          ws.name,
          kind_name(&item.item_type),
          item.name,
          f.message
        )))
      }
    }
  }
  plans.sort_by_key(|p| !p.item.is_lakehouse());
  Ok(plans)
}

/// What Copilot hears when the app's Fabric account can't open the workspace
/// its supporting items are in, or go to.
fn not_open(ws: &Workspace) -> String {
  format!(
    "The app's Fabric account can't open the workspace \"{}\", where its supporting items go: it may be signed in as \
     another account than the one that put them there. Tell the user, and ask them to sign in to Fabric with an \
     account that can open it (Refresh Fabric authentication in Fabricator's account menu).",
    ws.name
  )
}

/// The parts sent to create an item: `.platform` carries the item's description.
fn with_description(parts: &[Part], description: &str) -> Vec<Part> {
  parts
    .iter()
    .map(|part| {
      if part.path != ".platform" {
        return part.clone();
      }
      let Ok(mut platform) = serde_json::from_slice::<serde_json::Value>(&part.bytes) else {
        return part.clone();
      };
      if let Some(metadata) = platform.get_mut("metadata").and_then(|m| m.as_object_mut()) {
        metadata.insert("description".into(), json!(description));
      }
      let bytes = serde_json::to_vec_pretty(&platform).unwrap_or_else(|_| part.bytes.clone());
      Part { path: part.path.clone(), bytes }
    })
    .collect()
}

/// The parts sent to update an item: without `.platform`, so its name and
/// description stay as they are in Fabric.
fn without_platform(parts: &[Part]) -> Vec<Part> {
  parts.iter().filter(|p| p.path != ".platform").cloned().collect()
}

/// [`super::model_hash`] of the model Fabric holds now, when it can be read.
async fn fabric_hash_of(account: &Account, ws: &Workspace, item_id: &str) -> Option<String> {
  let parts = fabric::get_definition(account, &ws.id, item_id).await.ok()?;
  tmdl::parse_definition(&tmdl_files(&parts)).ok().map(|m| model_hash(&m))
}

/// A failure, for the card and for Copilot.
fn failure_text(f: &Failure) -> String {
  let mut text = f.message.trim().to_string();
  for detail in f.details.iter().take(4) {
    if !text.contains(detail.as_str()) {
      text.push_str(&format!(" {detail}"));
    }
  }
  text
}

/// Whether a creation's outcome is unknown: no answer came from Fabric.
fn outcome_unknown(f: &Failure) -> bool {
  f.status.is_none() && !f.signs_in() && !f.name_in_use && !f.forbidden
}

/// How one lakehouse table's load went.
struct TableOutcome {
  name: String,
  /// Where it loaded from, from the app's root.
  source: String,
  rows: Option<u64>,
  /// Its columns, as its Delta table has them, or why it didn't load.
  result: Result<Vec<lakehouse::TableColumn>, String>,
}

/// How one item's apply went.
enum Outcome {
  Done(String),
  /// A lakehouse is in Fabric (`created` now), with how each table's load went,
  /// and the tables Fabricator loaded before that its definition no longer lists.
  Lake { item_id: String, created: bool, tables: Vec<TableOutcome>, dropped: Vec<String> },
  /// A Direct Lake model is in Fabric, but its first refresh didn't work: why.
  FirstRefreshFailed(String, String),
  Failed(Failure),
  /// The user chose not to discard the model's data.
  KeptData,
  Stopped,
}

/// Record that `item`'s creation started, so a retry looks for it first.
fn creating(dir: &Path, item: &Item, applied: &mut AppliedState) {
  applied.items.remove(&item.key);
  applied.creating.insert(
    item.key.clone(),
    Creating { display_name: item.name.clone(), item_type: item.item_type.clone(), started_at: now_rfc3339() },
  );
  save_quietly(dir, applied);
}

/// A creation failed: forget it was started, unless it may have gone through.
fn not_created(dir: &Path, item: &Item, applied: &mut AppliedState, f: &Failure) {
  if !outcome_unknown(f) {
    applied.creating.remove(&item.key);
    save_quietly(dir, applied);
  }
}

/// Create the semantic model in `ws`, recording it in `applied` (saved as it goes).
async fn create_one(
  account: &Account,
  dir: &Path,
  app_name: &str,
  plan: &Plan,
  ws: &Workspace,
  applied: &mut AppliedState,
) -> Outcome {
  let item = &plan.item;
  creating(dir, item, applied);
  let parts = with_description(&item.parts, &description(app_name, &item.folder));
  match fabric::create(account, &ws.id, &item.name, &description(app_name, &item.folder), &parts).await {
    Ok(item_id) => {
      let fabric_hash = fabric_hash_of(account, ws, &item_id).await;
      applied.creating.remove(&item.key);
      applied.items.insert(
        item.key.clone(),
        AppliedItem {
          item_id: item_id.clone(),
          item_type: item.item_type.clone(),
          display_name: item.name.clone(),
          folder: item.folder.clone(),
          applied_at: now_rfc3339(),
          local_hash: item.hash.clone(),
          fabric_hash,
          ..Default::default()
        },
      );
      save_quietly(dir, applied);
      Outcome::Done(item_id)
    }
    Err(f) => {
      not_created(dir, item, applied, &f);
      Outcome::Failed(f)
    }
  }
}

/// Update `item_id` to the item's definition, asking the user first when that
/// would discard data the model has loaded.
async fn update_one(
  turn: &Turn<'_>,
  account: &Account,
  dir: &Path,
  plan: &Plan,
  item_id: &str,
  ws: &Workspace,
  applied: &mut AppliedState,
) -> Outcome {
  let item = &plan.item;
  let parts = without_platform(&item.parts);
  let mut result = fabric::update(account, &ws.id, item_id, &parts, false).await;
  if matches!(&result, Err(f) if f.purge_required) {
    let apply = t!("services.supportingItems.purgeApply");
    let keep = t!("services.supportingItems.purgeKeep");
    let question = t!("services.supportingItems.purgeQuestion", name = item.name);
    match turn.ask(question, vec![apply.clone(), keep]).await {
      Some(answer) if answer == apply => result = fabric::update(account, &ws.id, item_id, &parts, true).await,
      Some(_) => return Outcome::KeptData,
      None => return Outcome::Stopped,
    }
  }
  match result {
    Ok(()) => {
      let fabric_hash = fabric_hash_of(account, ws, item_id).await;
      applied.items.insert(
        item.key.clone(),
        AppliedItem {
          item_id: item_id.to_string(),
          item_type: item.item_type.clone(),
          display_name: item.name.clone(),
          folder: item.folder.clone(),
          applied_at: now_rfc3339(),
          local_hash: item.hash.clone(),
          fabric_hash,
          ..Default::default()
        },
      );
      save_quietly(dir, applied);
      Outcome::Done(item_id.to_string())
    }
    Err(f) => Outcome::Failed(f),
  }
}

/// Refresh a Direct Lake model once it's applied, so it reads its tables: until
/// then, queries can't find them.
async fn first_refresh(turn: &Turn<'_>, account: &Account, ws: &Workspace, item_id: &str, card: &mut Review, index: usize) -> Outcome {
  card.items[index].phase = Some("refreshing".into());
  turn.show(card);
  let started = Utc::now();
  let running = match fabric::refresh(account, &ws.id, item_id).await {
    Ok(begun) => Running { refresh_id: begun.refresh_id, started },
    Err(f) if f.already_running => Running { refresh_id: None, started: started - chrono::Duration::days(1) },
    Err(f) => return Outcome::FirstRefreshFailed(item_id.to_string(), failure_text(&f)),
  };
  let followed = follow(turn, account, ws, item_id, &running).await;
  card.items[index].phase = None;
  match followed {
    Followed::Ended(status) if status.status == "succeeded" => Outcome::Done(item_id.to_string()),
    Followed::Ended(status) => {
      let said: Vec<String> = status.errors.iter().map(|e| e.message.clone()).filter(|m| !m.trim().is_empty()).take(6).collect();
      let why = if said.is_empty() { "Power BI didn't say why.".to_string() } else { said.join(" ") };
      Outcome::FirstRefreshFailed(item_id.to_string(), why)
    }
    // It goes on in Fabric, and a Direct Lake refresh only reads the tables' metadata.
    Followed::StillRunning(_) => Outcome::Done(item_id.to_string()),
    Followed::Stopped => Outcome::Stopped,
    Followed::Failed(f) => Outcome::FirstRefreshFailed(item_id.to_string(), failure_text(&f)),
  }
}

/// What Fabricator records about `files` after loading them: their contents' hashes.
async fn loaded_files(files: &[lakehouse::DataFile]) -> Result<Vec<lakehouse::LoadedFile>, String> {
  let files = files.to_vec();
  tokio::task::spawn_blocking(move || {
    files
      .iter()
      .map(|f| {
        let sha256 = lakehouse::sha256_of(&f.path).map_err(|e| format!("{} can't be read ({e}).", f.rel))?;
        Ok(lakehouse::LoadedFile { path: f.rel.clone(), bytes: f.bytes, modified: f.modified, sha256 })
      })
      .collect()
  })
  .await
  .unwrap_or_else(|e| Err(e.to_string()))
}

/// Upload a table's files to the lakehouse's Files and load the table from them,
/// showing each step on its row of the card (`row` of item `index`).
#[allow(clippy::too_many_arguments)]
async fn load_one(
  turn: &Turn<'_>,
  account: &Account,
  ws: &Workspace,
  item_id: &str,
  one_lake: Option<&str>,
  table: &lakehouse::TableSource,
  card: &mut Review,
  index: usize,
  row: usize,
) -> Result<lakehouse::LoadedTable, String> {
  let set = |card: &mut Review, state: ItemState, phase: Option<&str>, error: Option<String>| {
    if let Some(entry) = card.items[index].tables.get_mut(row) {
      entry.state = state;
      entry.phase = phase.map(str::to_string);
      entry.error = error;
    }
    turn.show(card);
  };
  set(card, ItemState::Working, Some("uploading"), None);
  let fail = |card: &mut Review, why: String| {
    set(card, ItemState::Failed, None, Some(why.clone()));
    Err(why)
  };
  let files = match loaded_files(&table.files).await {
    Ok(files) => files,
    Err(why) => return fail(card, why),
  };
  let uploads: Vec<fabric::Upload> =
    table.files.iter().map(|f| fabric::Upload { local: f.path.clone(), remote: format!("Files/{}", f.rel) }).collect();
  if let Err(f) = fabric::upload_files(account, &ws.id, item_id, one_lake, &uploads, table.bytes()).await {
    return fail(card, failure_text(&f));
  }
  set(card, ItemState::Working, Some("loading"), None);
  let load = fabric::Load {
    table: table.name.clone(),
    relative_path: format!("Files/{}", table.source),
    folder: table.folder,
    format: table.format,
    header: table.header,
    delimiter: table.delimiter,
  };
  if let Err(f) = fabric::load_table(account, &ws.id, item_id, &load).await {
    return fail(card, failure_text(&f));
  }
  let columns = match fabric::table_schema(account, &ws.id, item_id, one_lake, &table.name).await {
    Ok(columns) => columns,
    Err(f) => {
      log::warn!("couldn't read the columns of the lakehouse table {}: {}", table.name, f.message);
      Vec::new()
    }
  };
  set(card, ItemState::Done, None, None);
  Ok(lakehouse::LoadedTable {
    source: table.source.clone(),
    files,
    options: lakehouse::options_of(table),
    loaded_at: now_rfc3339(),
    columns,
    rows: table.rows,
  })
}

/// Create the lakehouse when it isn't in Fabric, then load the tables the plan
/// lists, recording each in `applied` as it loads. It's applied, as its folder
/// defines it, once every table has loaded.
#[allow(clippy::too_many_arguments)]
async fn apply_lakehouse(
  turn: &Turn<'_>,
  account: &Account,
  dir: &Path,
  app_name: &str,
  plan: &Plan,
  ws: &Workspace,
  applied: &mut AppliedState,
  card: &mut Review,
  index: usize,
) -> Outcome {
  let item = &plan.item;
  let (item_id, created) = match &plan.existing {
    Some(item_id) => (item_id.clone(), false),
    None => {
      creating(dir, item, applied);
      match fabric::create_lakehouse(account, &ws.id, &item.name, &description(app_name, &item.folder)).await {
        Ok(item_id) => {
          applied.creating.remove(&item.key);
          applied.items.insert(
            item.key.clone(),
            AppliedItem {
              item_id: item_id.clone(),
              item_type: item.item_type.clone(),
              display_name: item.name.clone(),
              folder: item.folder.clone(),
              applied_at: now_rfc3339(),
              ..Default::default()
            },
          );
          save_quietly(dir, applied);
          (item_id, true)
        }
        Err(f) => {
          not_created(dir, item, applied, &f);
          return Outcome::Failed(f);
        }
      }
    }
  };
  card.items[index].item_id = Some(item_id.clone());
  // Uploads go to the OneLake host Fabric gives for the lakehouse's organization.
  let one_lake = match fabric::get_lakehouse(account, &ws.id, &item_id).await {
    Ok(Some(lake)) => lake.one_lake(),
    _ => None,
  }
  .or_else(|| applied.items.get(&item.key).and_then(|a| a.one_lake.clone()));
  if let Some(recorded) = applied.items.get_mut(&item.key) {
    recorded.one_lake = one_lake.clone();
  }
  let definition = item.lakehouse.clone().unwrap_or_default();
  let mut tables = Vec::new();
  for (row, &i) in plan.loads.iter().enumerate() {
    let Some(table) = definition.tables.get(i) else { continue };
    if turn.cancel.is_cancelled() {
      break;
    }
    let result = load_one(turn, account, ws, &item_id, one_lake.as_deref(), table, card, index, row).await;
    if let (Ok(loaded), Some(recorded)) = (&result, applied.items.get_mut(&item.key)) {
      recorded.tables.insert(table.name.clone(), loaded.clone());
      recorded.applied_at = now_rfc3339();
      save_quietly(dir, applied);
    }
    tables.push(TableOutcome {
      name: table.name.clone(),
      source: format!("{DIR}/{}/{}", item.folder, table.source),
      rows: table.rows,
      result: result.map(|loaded| loaded.columns),
    });
  }
  let mut dropped = Vec::new();
  if tables.len() == plan.loads.len() && tables.iter().all(|t| t.result.is_ok()) {
    if let Some(recorded) = applied.items.get_mut(&item.key) {
      recorded.local_hash = item.hash.clone();
      // Tables its folder no longer lists stay in the lakehouse; Fabricator forgets them.
      let listed: HashSet<&str> = definition.tables.iter().map(|t| t.name.as_str()).collect();
      dropped = recorded.tables.keys().filter(|name| !listed.contains(name.as_str())).cloned().collect();
      recorded.tables.retain(|name, _| listed.contains(name.as_str()));
    }
    save_quietly(dir, applied);
  }
  if turn.cancel.is_cancelled() && tables.len() < plan.loads.len() {
    return Outcome::Stopped;
  }
  Outcome::Lake { item_id, created, tables, dropped }
}

fn save_quietly(dir: &Path, applied: &AppliedState) {
  if let Err(e) = save_state(dir, applied) {
    log::warn!("couldn't save {DIR}/applied.json: {e}");
  }
}

/// On the cards of Direct Lake models over the app's own lakehouses: those
/// lakehouses by name, and what doesn't match the tables Fabricator loaded.
fn name_lakehouses(plans: &mut [Plan], applied: &AppliedState) {
  let lakes: Vec<&AppliedItem> = applied.items.values().filter(|a| a.item_type == LAKEHOUSE).collect();
  if lakes.is_empty() {
    return;
  }
  let names: Vec<(String, String)> = lakes.iter().map(|a| (a.item_id.clone(), a.display_name.clone())).collect();
  let tables: Vec<analysis::LakeTable<'_>> = lakes
    .iter()
    .flat_map(|lake| {
      lake.tables.iter().map(|(name, loaded)| analysis::LakeTable {
        item_id: &lake.item_id,
        lakehouse: &lake.display_name,
        table: name,
        columns: loaded.columns.iter().map(|c| c.name.as_str()).collect(),
      })
    })
    .collect();
  for plan in plans.iter_mut().filter(|p| !p.item.is_lakehouse()) {
    analysis::name_items(&mut plan.card.summary.sources, &names);
    plan.card.checks.extend(analysis::direct_lake_checks(&plan.item.model, &tables));
  }
}

/// What Copilot hears when the Azure CLI can't upload a lakehouse's files.
fn cant_upload(f: &Failure, account: Option<&str>) -> String {
  format!(
    "Fabricator can't upload the lakehouse's files: {} Ask the user to sign in to the Azure CLI, in Fabricator's \
     Accounts, with an account in the same organization as the app's Fabric account{}, then call {APPLY_TOOL} again.",
    failure_text(f),
    account.map(|a| format!(" ({a})")).unwrap_or_default()
  )
}

/// Create and update the app's supporting items, after the user approves.
async fn apply(app: &AppHandle, project_id: &str, session_id: &str, wanted: &[String], reason: Option<String>) -> ToolResult {
  let state = app.state::<AppState>();
  let turn = match turn_of(app, &state, project_id, session_id) {
    Ok(turn) => turn,
    Err(result) => return result,
  };
  let lock = busy_lock(project_id);
  let _one_at_a_time = tokio::select! {
    guard = lock.lock() => guard,
    _ = turn.cancel.wait_cancelled() => return stopped(),
  };
  let Some(project) = store::find_project(project_id) else {
    return failure("This app isn't in Fabricator anymore.");
  };
  if !on_for(&project) {
    return failure(OFF);
  }
  let dir = Path::new(&project.path).to_path_buf();
  super::ensure_gitignore(&dir);
  let all = folders(&dir);
  if all.is_empty() {
    return failure(format!(
      "There's nothing in {DIR}/ to apply yet. Define the item first: a semantic model in TMDL in \
       {DIR}/<Name>.SemanticModel/, or a lakehouse in {DIR}/<Name>.Lakehouse/ (see the supporting-semantic-models \
       skill), then call {APPLY_TOOL}."
    ));
  }
  let chosen = match choose(&all, wanted) {
    Ok(chosen) => chosen,
    Err(why) => return failure(why),
  };

  let mut items = Vec::new();
  let mut problems = Vec::new();
  for folder in &chosen {
    match read_item(&dir, folder) {
      Ok(item) => items.push(item),
      Err(found) => problems.push(problems_text(folder, &found)),
    }
  }
  if !problems.is_empty() {
    return failure(format!("{}\n\nFix these, then call {APPLY_TOOL} again.", problems.join("\n\n")));
  }
  if let Some(twin) = items.iter().enumerate().find_map(|(i, a)| items[i + 1..].iter().find(|b| b.key == a.key).map(|b| (a, b))) {
    return failure(format!(
      "{DIR}/{} and {DIR}/{} have the same logicalId in .platform. Give each item its own: a new GUID for the one \
       that was copied.",
      twin.0.folder, twin.1.folder
    ));
  }
  let mut applied = match load_state(&dir) {
    Ok(applied) => applied,
    Err(why) => return failure(why),
  };

  let (todo, unchanged): (Vec<Item>, Vec<Item>) =
    items.into_iter().partition(|i| status_of(i, &applied) != Status::Applied || applied.creating.contains_key(&i.key));
  if todo.is_empty() {
    let names = unchanged.iter().map(|i| format!("\"{}\"", i.name)).collect::<Vec<_>>().join(", ");
    return ToolResult::Text(format!(
      "Nothing to apply: {names} {} in Fabric as defined already. Change the definition first when it should be \
       different.",
      if unchanged.len() == 1 { "is" } else { "are" }
    ));
  }
  let shown: Vec<String> = todo.iter().map(|i| i.hash.clone()).collect();
  if declined_before(project_id, &turn.route.turn_id, &shown) {
    return ToolResult::Text(DECLINED_APPLY.into());
  }

  let (fabric_account, account) = match ensure_fabric(&turn, &dir).await {
    Ok(signed) => signed,
    Err(result) => return result,
  };
  let workspace = target(&project, &applied);
  let plans = match &workspace {
    Some(ws) => match plan_all(&fabric_account, todo, &mut applied, ws).await {
      Ok(plans) => plans,
      Err(result) => return result,
    },
    None => {
      let mut plans: Vec<Plan> = todo.into_iter().map(new_plan).collect();
      plans.sort_by_key(|p| !p.item.is_lakehouse());
      plans
    }
  };
  // A lakehouse whose data is what Fabric has loaded already needs nothing there.
  let (mut plans, same): (Vec<Plan>, Vec<Plan>) =
    plans.into_iter().partition(|p| !(p.item.is_lakehouse() && p.existing.is_some() && p.loads.is_empty()));
  name_lakehouses(&mut plans, &applied);
  for plan in &same {
    if let Some(recorded) = applied.items.get_mut(&plan.item.key) {
      recorded.local_hash = plan.item.hash.clone();
    }
  }
  if !same.is_empty() {
    save_quietly(&dir, &applied);
  }
  if plans.is_empty() {
    let names = same.iter().map(|p| format!("\"{}\"", p.item.name)).collect::<Vec<_>>().join(", ");
    return ToolResult::Text(format!(
      "Nothing to load: the tables of {names} hold the data of their files already. Change a file, or add a table \
       to tables.json, to load more."
    ));
  }
  // Lakehouses' files go up as the Azure CLI's sign-in: check it can before asking.
  let mut uploads_as = None;
  if plans.iter().any(|p| !p.loads.is_empty()) {
    match fabric::upload_check(&fabric_account).await {
      Ok(user) => uploads_as = user.filter(|u| account.as_deref().is_none_or(|a| !a.eq_ignore_ascii_case(u))),
      Err(f) if f.upload_not_allowed => return failure(cant_upload(&f, account.as_deref())),
      Err(f) if f.signs_in() => return failure(SIGN_IN_AGAIN),
      Err(f) => {
        return failure(format!("Fabricator couldn't check that it can upload the lakehouse's files: {}", failure_text(&f)))
      }
    }
  }

  let mut card = Review {
    id: uuid::Uuid::new_v4().to_string(),
    project_id: project_id.to_string(),
    kind: ReviewKind::Apply,
    state: ReviewState::Pending,
    reason,
    workspace: workspace.clone(),
    pick_workspace: workspace.is_none(),
    account,
    uploads_as,
    items: plans.iter().map(|p| p.card.clone()).collect(),
    error: None,
  };
  let creates = plans.iter().filter(|p| p.existing.is_none()).count();
  let lakehouses = plans.iter().filter(|p| p.item.is_lakehouse()).count();
  track(
    ReviewKind::Apply,
    "shown",
    &[
      ("creates", creates.to_string()),
      ("updates", (plans.len() - creates).to_string()),
      ("lakehouses", lakehouses.to_string()),
    ],
  );
  let decision = turn.decide(&card).await;
  let Some(decision) = decision else {
    card.state = ReviewState::Interrupted;
    turn.show(&card);
    return unanswered(&turn.cancel);
  };
  if !decision.approved {
    card.state = ReviewState::Declined;
    turn.show(&card);
    track(ReviewKind::Apply, "declined", &[]);
    remember_declined(project_id, &turn.route.turn_id, shown);
    return ToolResult::Text(DECLINED_APPLY.into());
  }
  track(ReviewKind::Apply, "approved", &[]);
  let ws = match workspace.or_else(|| picked(&decision)) {
    Some(ws) => ws,
    None => {
      card.state = ReviewState::Failed;
      card.error = Some(t!("services.supportingItems.noWorkspace"));
      turn.show(&card);
      return failure("The user approved, but no workspace was picked, so nothing changed in Fabric. Ask them to try again.");
    }
  };
  card.workspace = Some(ws.clone());
  card.pick_workspace = false;
  card.state = ReviewState::Working;
  turn.show(&card);

  // Picked on the card: check the names there before creating anything.
  if applied.workspace.is_none() {
    for plan in &plans {
      match fabric::find_item(&fabric_account, &ws.id, &plan.item.item_type, &plan.item.name).await {
        Ok(None) => {}
        Ok(Some(_)) => {
          card.state = ReviewState::Failed;
          card.error = Some(t!("services.supportingItems.nameTaken", name = plan.item.name, workspace = ws.name));
          turn.show(&card);
          return failure(name_taken(&plan.item, &ws));
        }
        Err(f) => {
          card.state = ReviewState::Failed;
          card.error = Some(failure_text(&f));
          turn.show(&card);
          return failure(if f.signs_in() {
            SIGN_IN_AGAIN.to_string()
          } else if f.not_found {
            not_open(&ws)
          } else {
            format!("Fabricator couldn't check the workspace: {}", f.message)
          });
        }
      }
    }
    applied.workspace = Some(ws.clone());
    save_quietly(&dir, &applied);
  }

  let mut report = Vec::new();
  for (i, plan) in plans.iter().enumerate() {
    card.items[i].state = ItemState::Working;
    card.items[i].started_at = Some(now_ms());
    turn.show(&card);
    let outcome = if plan.item.is_lakehouse() {
      apply_lakehouse(&turn, &fabric_account, &dir, &project.name, plan, &ws, &mut applied, &mut card, i).await
    } else {
      let outcome = match &plan.existing {
        Some(item_id) => update_one(&turn, &fabric_account, &dir, plan, item_id, &ws, &mut applied).await,
        None => create_one(&fabric_account, &dir, &project.name, plan, &ws, &mut applied).await,
      };
      match outcome {
        Outcome::Done(item_id) if plan.card.frames => {
          first_refresh(&turn, &fabric_account, &ws, &item_id, &mut card, i).await
        }
        other => other,
      }
    };
    let entry = &mut card.items[i];
    let change = if plan.existing.is_some() { "update" } else { "create" };
    let kind = if plan.item.is_lakehouse() { "lakehouse" } else { "model" };
    let link = |entry: &mut ReviewItem, item_id: &str| {
      entry.item_id = Some(item_id.to_string());
      entry.url = Some(item_url_of(&plan.item.item_type, &ws.id, item_id));
      if !plan.item.is_lakehouse() {
        entry.settings_url = Some(settings_url(&ws.id, item_id));
      }
    };
    match &outcome {
      Outcome::Done(item_id) => {
        entry.state = ItemState::Done;
        link(entry, item_id);
        track(ReviewKind::Apply, "succeeded", &[("change", change.into()), ("type", kind.into())]);
      }
      Outcome::Lake { item_id, tables, .. } => {
        link(entry, item_id);
        let failed = tables.iter().filter(|t| t.result.is_err()).count();
        if failed == 0 && tables.len() == plan.loads.len() {
          entry.state = ItemState::Done;
          track(ReviewKind::Apply, "succeeded", &[("change", change.into()), ("type", kind.into()), ("tables", tables.len().to_string())]);
        } else {
          // Its tables say which didn't load, and why.
          entry.state = ItemState::Failed;
          track(ReviewKind::Apply, "failed", &[("change", change.into()), ("type", kind.into()), ("code", "load".into())]);
        }
      }
      Outcome::FirstRefreshFailed(item_id, why) => {
        entry.state = ItemState::Failed;
        link(entry, item_id);
        entry.error = Some(t!("services.supportingItems.firstRefreshFailed", error = why));
        track(ReviewKind::Apply, "failed", &[("change", change.into()), ("type", kind.into()), ("code", "firstRefresh".into())]);
      }
      Outcome::Failed(f) => {
        entry.state = ItemState::Failed;
        entry.error = Some(failure_text(f));
        track(
          ReviewKind::Apply,
          "failed",
          &[("change", change.into()), ("type", kind.into()), ("code", error_code(f.code.as_deref()))],
        );
      }
      Outcome::KeptData => {
        entry.state = ItemState::Skipped;
        entry.error = Some(t!("services.supportingItems.keptData"));
      }
      Outcome::Stopped => entry.state = ItemState::Skipped,
    }
    turn.show(&card);
    report.push((plan, outcome));
    if matches!(report.last(), Some((_, Outcome::Stopped))) {
      break;
    }
  }
  card.state = if card.any_failed() { ReviewState::Failed } else { ReviewState::Done };
  turn.show(&card);
  ToolResult::Text(apply_report(&report, &ws))
}

/// The workspace picked on the card, when it's one.
fn picked(decision: &ReviewDecision) -> Option<Workspace> {
  let (id, name) = decision.workspace.clone()?;
  super::is_guid(&id).then(|| Workspace { name: if name.trim().is_empty() { id.clone() } else { name }, id })
}

/// What Copilot hears when the user turns the card down.
const DECLINED_APPLY: &str = "The user didn't approve the change, so nothing changed in Fabric. Don't create or change \
  it another way. Ask the user what they'd like to change, or carry on without it.";

/// How Copilot writes a Direct Lake model over a lakehouse at `one_lake`.
fn direct_lake_next(name: &str, one_lake: &str) -> String {
  format!(
    "To build a semantic model over the lakehouse \"{name}\", write a Direct Lake model in {DIR}/<Name>.SemanticModel/ \
     (see the Direct Lake section of the supporting-semantic-models skill): compatibilityLevel {} or later in \
     database.tmdl; a shared expression that reads `AzureStorage.DataLake(\"{one_lake}\", [HierarchicalNavigation = \
     true])`; and for each table, a partition `= entity` with `mode: directLake`, a `source` with `entityName` (the \
     lakehouse table's name) and `expressionSource` (that expression), and columns whose sourceColumn is the column \
     name above, with the dataType shown. Then apply it with {APPLY_TOOL}: Fabricator refreshes it once, so it reads \
     the tables, and it needs no other refresh.",
    super::analysis::DIRECT_LAKE_LEVEL
  )
}

/// What Copilot hears about an apply: how each item went, and what's next.
fn apply_report(report: &[(&Plan, Outcome)], ws: &Workspace) -> String {
  let mut lines = Vec::new();
  let mut next = Vec::new();
  let mut created = Vec::new();
  let mut needs_data = Vec::new();
  for (plan, outcome) in report {
    let item = &plan.item;
    let verb = if plan.existing.is_some() { "update" } else { "create" };
    let kind = kind_name(&item.item_type);
    match outcome {
      Outcome::Done(item_id) => {
        let direct_lake = if plan.card.frames {
          " It's Direct Lake, and Fabricator refreshed it, so it reads the lakehouse's tables now."
        } else {
          ""
        };
        if plan.existing.is_some() {
          lines.push(format!(
            "Updated the semantic model \"{}\" (item id {item_id}) in the workspace \"{}\" to match {}.{direct_lake}",
            item.name,
            ws.name,
            item.path()
          ));
        } else {
          lines.push(format!(
            "Created the semantic model \"{}\" in the workspace \"{}\" (workspace id {}, item id {item_id}) from \
             {}.{direct_lake}",
            item.name,
            ws.name,
            ws.id,
            item.path()
          ));
          created.push((item.name.clone(), item_id.clone()));
        }
        if review::loads_data(&plan.card.summary) {
          needs_data.push(item.name.clone());
        }
      }
      Outcome::FirstRefreshFailed(item_id, why) => {
        lines.push(format!(
          "{} the semantic model \"{}\" (item id {item_id}) in the workspace \"{}\", but its first refresh, which makes \
           a Direct Lake model read its tables, failed: {why}",
          if plan.existing.is_some() { "Updated" } else { "Created" },
          item.name,
          ws.name
        ));
        if plan.existing.is_none() {
          created.push((item.name.clone(), item_id.clone()));
        }
        next.push(format!(
          "Fix {}: each table's entityName must be a table in the lakehouse, and each column's sourceColumn a column \
           of that table, as the lakehouse's apply result listed them. Then call {APPLY_TOOL} again: Fabricator \
           refreshes it again.",
          item.path()
        ));
      }
      Outcome::Lake { item_id, created: new, tables, dropped } => {
        if *new {
          lines.push(format!(
            "Created the lakehouse \"{}\" in the workspace \"{}\" (workspace id {}, item id {item_id}) from {}.",
            item.name,
            ws.name,
            ws.id,
            item.path()
          ));
        } else {
          lines.push(format!("Loaded data into the lakehouse \"{}\" (item id {item_id}) in the workspace \"{}\".", item.name, ws.name));
        }
        for table in tables {
          let rows = table.rows.map(|r| format!(", {r} rows")).unwrap_or_default();
          match &table.result {
            Ok(columns) if !columns.is_empty() => {
              let columns = columns
                .iter()
                .map(|c| format!("{} ({}, dataType {})", c.name, c.data_type, lakehouse::tmdl_type(&c.data_type)))
                .collect::<Vec<_>>()
                .join("; ");
              lines.push(format!("- Loaded the table `{}` from {}{rows}. Its columns: {columns}.", table.name, table.source));
            }
            Ok(_) => lines.push(format!(
              "- Loaded the table `{}` from {}{rows}. Its columns couldn't be read: they're the file's, as Fabric named \
               them.",
              table.name, table.source
            )),
            Err(why) => lines.push(format!("- Couldn't load the table `{}` from {}: {why}", table.name, table.source)),
          }
        }
        if !dropped.is_empty() {
          let names = dropped.iter().map(|n| format!("`{n}`")).collect::<Vec<_>>().join(", ");
          lines.push(format!(
            "tables.json no longer lists {names}: Fabricator left {} in the lakehouse as {} {}.",
            if dropped.len() == 1 { "it" } else { "them" },
            if dropped.len() == 1 { "it" } else { "they" },
            if dropped.len() == 1 { "is" } else { "are" }
          ));
        }
        if tables.iter().any(|t| t.result.is_err()) {
          next.push(format!(
            "Fix the files or {}/tables.json for the tables that didn't load (the errors say what Fabric refused), then \
             call {APPLY_TOOL} again: it loads only the tables that haven't loaded.",
            item.path()
          ));
        }
        if tables.iter().any(|t| t.result.is_ok()) {
          next.push(direct_lake_next(&item.name, &super::one_lake_url(&ws.id, item_id)));
        }
      }
      Outcome::Failed(f) => {
        lines.push(format!("Couldn't {verb} the {kind} \"{}\": {}", item.name, failure_text(f)));
        if f.name_in_use {
          next.push(name_taken(item, ws));
        } else if f.upload_not_allowed {
          next.push(cant_upload(f, None));
        } else if f.forbidden {
          next.push(format!(
            "The app's Fabric account isn't allowed to {verb} {kind}s in \"{}\": it needs the Contributor role or \
             higher in that workspace. Tell the user.",
            ws.name
          ));
        } else if f.signs_in() {
          next.push(SIGN_IN_AGAIN.into());
        } else if outcome_unknown(f) {
          next.push(format!(
            "Fabric didn't answer, so it isn't known whether \"{}\" was created. Calling {APPLY_TOOL} again checks \
             before it creates anything.",
            item.name
          ));
        } else {
          next.push(format!(
            "Fix {} so Fabric accepts it (the error says what it refused), then call {APPLY_TOOL} again.",
            item.path()
          ));
        }
      }
      Outcome::KeptData => lines.push(format!(
        "Left \"{}\" as it was: the change would have discarded the data it has loaded, and the user chose to keep it.",
        item.name
      )),
      Outcome::Stopped => lines.push(format!("Stopped before \"{}\" finished.", item.name)),
    }
  }
  for (name, item_id) in &created {
    next.push(format!(
      "To read \"{name}\" from the app, connect it with a Rayfin connector, unless the app already has one for it: \
       `npx rayfin connector add --type fabric-semanticmodel --workspace-id {} --item-id {item_id} --name {}` (see the \
       connect-semantic-model skill).",
      ws.id,
      alias_of(name)
    ));
  }
  if !needs_data.is_empty() {
    let names = needs_data.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(", ");
    next.push(format!(
      "{names} load their data when they're refreshed: a new Import model has none, and a changed one keeps its old \
       data until then. Call {REFRESH_TOOL} for each next. If the data source has no credentials in Fabric yet, the \
       refresh says so."
    ));
  }
  let mut text = lines.join("\n");
  if !next.is_empty() {
    text.push_str("\n\n");
    text.push_str(&next.join("\n"));
  }
  text
}

/* --------------------------------- refresh -------------------------------- */

/// Refresh a supporting model's data, after the user approves.
async fn refresh(app: &AppHandle, project_id: &str, session_id: &str, wanted: &str, reason: Option<String>) -> ToolResult {
  let state = app.state::<AppState>();
  let turn = match turn_of(app, &state, project_id, session_id) {
    Ok(turn) => turn,
    Err(result) => return result,
  };
  let lock = busy_lock(project_id);
  let _one_at_a_time = tokio::select! {
    guard = lock.lock() => guard,
    _ = turn.cancel.wait_cancelled() => return stopped(),
  };
  let Some(project) = store::find_project(project_id) else {
    return failure("This app isn't in Fabricator anymore.");
  };
  if !on_for(&project) {
    return failure(OFF);
  }
  let dir = Path::new(&project.path).to_path_buf();
  if wanted.is_empty() {
    return failure("Pass `item`: the folder name in supporting-items/ of the model to refresh, such as \"Sales.SemanticModel\".");
  }
  let applied = match load_state(&dir) {
    Ok(applied) => applied,
    Err(why) => return failure(why),
  };
  let mut known = folders(&dir);
  for folder in applied.items.values().map(|i| &i.folder) {
    if !known.contains(folder) {
      known.push(folder.clone());
    }
  }
  let folder = match choose(&known, &[wanted.to_string()]) {
    Ok(mut chosen) if !chosen.is_empty() => chosen.remove(0),
    Ok(_) => return failure("Pass `item`: the model to refresh."),
    Err(why) => return failure(why),
  };
  let Some((key, item)) = applied.items.iter().find(|(_, i)| i.folder.eq_ignore_ascii_case(&folder)) else {
    return failure(format!(
      "{DIR}/{folder} isn't in Fabric yet, so there's nothing to refresh. Create it with {APPLY_TOOL} first."
    ));
  };
  let (key, item) = (key.clone(), item.clone());
  if item.item_type == LAKEHOUSE {
    return failure(format!(
      "\"{}\" is a lakehouse: it doesn't refresh. To load changed or new files into its tables, apply it again with \
       {APPLY_TOOL}. To make a Direct Lake model over it read its tables again, refresh that model.",
      item.display_name
    ));
  }
  let Some(ws) = applied.workspace.clone() else {
    return failure(format!("{DIR}/applied.json doesn't say which workspace the items are in. Apply them again with {APPLY_TOOL}."));
  };
  let read = read_item(&dir, &folder).ok();
  let unapplied = read.as_ref().is_none_or(|r| r.hash != item.local_hash);

  // One that an earlier call left running is followed, not started again.
  let earlier = RUNNING.lock().unwrap().get(&(project_id.to_string(), key.clone())).cloned();
  if let Some(running) = earlier {
    let fabric_account = match ensure_fabric(&turn, &dir).await {
      Ok((fabric_account, _)) => fabric_account,
      Err(result) => return result,
    };
    turn.emit(ChatEvent::Notice { text: t!("services.supportingItems.following", name = item.display_name) });
    let status = follow(&turn, &fabric_account, &ws, &item.item_id, &running).await;
    return finish_refresh(project_id, &key, &item, &ws, &folder, None, status, &turn);
  }

  let shown = vec![format!("refresh:{key}")];
  if declined_before(project_id, &turn.route.turn_id, &shown) {
    return ToolResult::Text(DECLINED_REFRESH.into());
  }
  let (fabric_account, account) = match ensure_fabric(&turn, &dir).await {
    Ok(signed) => signed,
    Err(result) => return result,
  };
  let mut card = Review {
    id: uuid::Uuid::new_v4().to_string(),
    project_id: project_id.to_string(),
    kind: ReviewKind::Refresh,
    state: ReviewState::Pending,
    reason,
    workspace: Some(ws.clone()),
    account,
    items: vec![ReviewItem {
      key: key.clone(),
      name: item.display_name.clone(),
      item_type: item.item_type.clone(),
      folder: format!("{DIR}/{folder}"),
      change: ItemChange::Refresh,
      summary: read.as_ref().map(|r| super::analysis::summary(&r.model)).unwrap_or_default(),
      unapplied,
      item_id: Some(item.item_id.clone()),
      url: Some(item_url(&ws.id, &item.item_id)),
      settings_url: Some(settings_url(&ws.id, &item.item_id)),
      ..Default::default()
    }],
    ..Default::default()
  };
  track(ReviewKind::Refresh, "shown", &[]);
  let Some(decision) = turn.decide(&card).await else {
    card.state = ReviewState::Interrupted;
    turn.show(&card);
    return unanswered(&turn.cancel);
  };
  if !decision.approved {
    card.state = ReviewState::Declined;
    turn.show(&card);
    track(ReviewKind::Refresh, "declined", &[]);
    remember_declined(project_id, &turn.route.turn_id, shown);
    return ToolResult::Text(DECLINED_REFRESH.into());
  }
  track(ReviewKind::Refresh, "approved", &[]);
  card.state = ReviewState::Working;
  card.items[0].state = ItemState::Working;
  card.items[0].started_at = Some(now_ms());
  turn.show(&card);

  let started = Utc::now();
  let running = match fabric::refresh(&fabric_account, &ws.id, &item.item_id).await {
    Ok(begun) => Running { refresh_id: begun.refresh_id, started },
    // One is running already (started in Fabric, say): follow it.
    Err(f) if f.already_running => Running { refresh_id: None, started: started - chrono::Duration::days(1) },
    Err(f) => {
      card.state = ReviewState::Failed;
      card.items[0].state = ItemState::Failed;
      card.items[0].error = Some(failure_text(&f));
      card.items[0].refresh_in_fabric = f.refresh_not_allowed;
      turn.show(&card);
      track(ReviewKind::Refresh, "failed", &[("code", error_code(f.code.as_deref()))]);
      return failure(if f.signs_in() {
        SIGN_IN_AGAIN.to_string()
      } else if f.refresh_not_allowed {
        format!(
          "Fabricator can't refresh \"{}\" with the user's sign-ins: Power BI lets their Fabric account read the model \
           but not start a refresh, and the Azure CLI isn't signed in to the same organization. Ask the user to open \
           the model in Fabric ({}), select Refresh now, and tell you when it's done. Don't refresh it another way.",
          item.display_name,
          item_url(&ws.id, &item.item_id)
        )
      } else if f.forbidden {
        format!(
          "Power BI didn't let the user refresh \"{}\" ({}). They need the Contributor role or higher in the workspace \
           \"{}\". Tell the user.",
          item.display_name, f.message, ws.name
        )
      } else {
        format!("Power BI couldn't start a refresh of \"{}\": {}", item.display_name, failure_text(&f))
      });
    }
  };
  RUNNING.lock().unwrap().insert((project_id.to_string(), key.clone()), running.clone());
  let status = follow(&turn, &fabric_account, &ws, &item.item_id, &running).await;
  finish_refresh(project_id, &key, &item, &ws, &folder, Some(card), status, &turn)
}

/// How following a refresh ended.
enum Followed {
  Ended(fabric::RefreshStatus),
  /// Still running when the tool stopped waiting.
  StillRunning(Duration),
  Stopped,
  Failed(Failure),
}

/// Whether a refresh in the model's history is the one that started at
/// `started`, or later: one from before it isn't.
fn is_ours(status: &fabric::RefreshStatus, running: &Running) -> bool {
  if running.refresh_id.is_some() {
    return true;
  }
  match status.start_time.as_deref().and_then(|t| DateTime::parse_from_rfc3339(t).ok()) {
    Some(at) => at.with_timezone(&Utc) >= running.started - chrono::Duration::minutes(2),
    None => true,
  }
}

/// Wait for a refresh to end, for up to [`REFRESH_WAIT`].
async fn follow(turn: &Turn<'_>, account: &Account, ws: &Workspace, item_id: &str, running: &Running) -> Followed {
  let begun = Instant::now();
  let mut failures = 0;
  loop {
    match fabric::refresh_status(account, &ws.id, item_id, running.refresh_id.as_deref()).await {
      Ok(status) if status.finished() && is_ours(&status, running) => return Followed::Ended(status),
      Ok(_) => failures = 0,
      Err(f) if f.signs_in() || f.refresh_not_allowed => return Followed::Failed(f),
      Err(f) => {
        failures += 1;
        if failures >= 4 {
          return Followed::Failed(f);
        }
      }
    }
    if begun.elapsed() >= REFRESH_WAIT {
      return Followed::StillRunning(begun.elapsed());
    }
    tokio::select! {
      _ = tokio::time::sleep(REFRESH_POLL) => {}
      _ = turn.cancel.wait_cancelled() => return Followed::Stopped,
    }
  }
}

/// What Copilot hears when the user turns a refresh down.
const DECLINED_REFRESH: &str = "The user didn't approve the refresh, so the model's data didn't change. Don't refresh \
  it another way. Ask the user what they'd like to do, or carry on without it.";

/// Show how a refresh ended on its card, and tell Copilot.
#[allow(clippy::too_many_arguments)]
fn finish_refresh(
  project_id: &str,
  key: &str,
  item: &AppliedItem,
  ws: &Workspace,
  folder: &str,
  card: Option<Review>,
  followed: Followed,
  turn: &Turn<'_>,
) -> ToolResult {
  let ended = !matches!(followed, Followed::StillRunning(_) | Followed::Stopped);
  if ended {
    RUNNING.lock().unwrap().remove(&(project_id.to_string(), key.to_string()));
  }
  let name = &item.display_name;
  let settings = settings_url(&ws.id, &item.item_id);
  let show = |state: ReviewState, item_state: ItemState, apply: &dyn Fn(&mut ReviewItem)| {
    if let Some(mut card) = card.clone() {
      card.state = state;
      card.items[0].state = item_state;
      apply(&mut card.items[0]);
      turn.show(&card);
    }
  };
  match followed {
    Followed::Ended(status) if status.status == "succeeded" => {
      show(ReviewState::Done, ItemState::Done, &|_| {});
      track(ReviewKind::Refresh, "succeeded", &[]);
      ToolResult::Text(format!(
        "Refreshed \"{name}\": its data is loaded. Check the numbers before you build on them, through the app's \
         connector once it's connected (see the connect-semantic-model skill), or with FabricIQ-ExecuteQuery on the \
         item id {} when Fabric IQ is already on in this chat.",
        item.item_id
      ))
    }
    Followed::Ended(status) => {
      let code = status.errors.iter().find_map(|e| e.code.as_deref());
      track(
        ReviewKind::Refresh,
        "failed",
        &[("code", error_code(code)), ("credentials", status.needs_credentials.to_string())],
      );
      let errors: Vec<String> = status
        .errors
        .iter()
        .map(|e| match &e.code {
          Some(code) if !code.is_empty() && !e.message.contains(code.as_str()) => format!("{code}: {}", e.message),
          _ => e.message.clone(),
        })
        .filter(|e| !e.trim().is_empty())
        .take(6)
        .collect();
      let cancelled = status.status == "cancelled";
      show(ReviewState::Failed, ItemState::Failed, &|entry| {
        entry.errors = errors.clone();
        entry.needs_credentials = status.needs_credentials;
        if cancelled {
          entry.error = Some(t!("services.supportingItems.refreshCancelled"));
        }
      });
      let said = if errors.is_empty() { "Power BI didn't say why.".to_string() } else { errors.join(" ") };
      if cancelled {
        ToolResult::Text(format!("The refresh of \"{name}\" was cancelled in Fabric. {said}"))
      } else if status.needs_credentials {
        ToolResult::Text(format!(
          "The refresh of \"{name}\" failed because its data source has no credentials in Fabric yet: {said} Tell \
           the user to open the model's settings in Fabric ({settings}), sign in to the data source under Data \
           source credentials, and then ask you to refresh it again. Never put credentials in the definition."
        ))
      } else {
        ToolResult::Text(format!(
          "The refresh of \"{name}\" failed: {said} Fix the definition in {DIR}/{folder} so the refresh can work: \
           for example, the column on a relationship's one side needs unique, non-blank values, so leave out blank and \
           duplicate keys in that table's M source. Apply it with {APPLY_TOOL}, then refresh again."
        ))
      }
    }
    Followed::StillRunning(waited) => {
      show(ReviewState::Working, ItemState::Working, &|_| {});
      ToolResult::Text(format!(
        "The refresh of \"{name}\" is still running in Fabric after {} minutes. Call {REFRESH_TOOL} again later to \
         see how it went: it follows this refresh rather than starting another.",
        waited.as_secs() / 60
      ))
    }
    Followed::Stopped => stopped(),
    Followed::Failed(f) => {
      show(ReviewState::Failed, ItemState::Failed, &|entry| entry.error = Some(failure_text(&f)));
      failure(if f.signs_in() {
        SIGN_IN_AGAIN.to_string()
      } else if f.refresh_not_allowed {
        format!(
          "Fabricator can't check the refresh of \"{name}\" with the user's sign-ins: {} Ask the user to open the \
           model in Fabric ({}), look at its refresh history, and tell you how it went. Don't refresh it another way.",
          failure_text(&f),
          item_url(&ws.id, &item.item_id)
        )
      } else {
        format!("Fabricator couldn't tell how the refresh of \"{name}\" went: {}", failure_text(&f))
      })
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::services::supporting_items::SEMANTIC_MODEL;

  fn folders_of(names: &[&str]) -> Vec<String> {
    names.iter().map(|n| n.to_string()).collect()
  }

  #[test]
  fn items_are_chosen_by_folder_model_name_or_path() {
    let all = folders_of(&["Sales.SemanticModel", "Inventory.SemanticModel"]);
    assert_eq!(choose(&all, &[]).unwrap(), all);
    assert_eq!(choose(&all, &["sales".into()]).unwrap(), ["Sales.SemanticModel"]);
    assert_eq!(
      choose(&all, &["supporting-items\\Inventory.SemanticModel\\".into(), "Inventory".into()]).unwrap(),
      ["Inventory.SemanticModel"]
    );
    let err = choose(&all, &["Orders".into()]).unwrap_err();
    assert!(err.contains("\"Orders\"") && err.contains("\"Sales.SemanticModel\""), "{err}");
  }

  #[test]
  fn a_connector_alias_is_the_name_in_lowercase_letters_and_digits() {
    assert_eq!(alias_of("Sales 2026"), "sales2026");
    assert_eq!(alias_of("Vendas & Lucro"), "vendaslucro");
    assert_eq!(alias_of("仕入れ"), "model");
  }

  #[test]
  fn the_created_items_platform_carries_its_description_and_updates_leave_it_out() {
    let parts = vec![
      Part { path: ".platform".into(), bytes: br#"{"metadata":{"type":"SemanticModel","displayName":"Sales"},"config":{"logicalId":"x"}}"#.to_vec() },
      Part { path: "definition/model.tmdl".into(), bytes: b"model Model".to_vec() },
    ];
    let sent = with_description(&parts, "Supporting item");
    let platform: serde_json::Value = serde_json::from_slice(&sent[0].bytes).unwrap();
    assert_eq!(platform["metadata"]["description"], "Supporting item");
    assert_eq!(platform["config"]["logicalId"], "x");
    assert_eq!(sent[1], parts[1]);
    assert_eq!(without_platform(&parts), parts[1..]);
  }

  #[test]
  fn only_an_unanswered_create_has_an_unknown_outcome() {
    assert!(outcome_unknown(&Failure { message: "timed out".into(), ..Default::default() }));
    assert!(!outcome_unknown(&Failure { status: Some(400), ..Default::default() }));
    assert!(!outcome_unknown(&Failure { needs_login: true, ..Default::default() }));
  }

  #[test]
  fn a_refresh_from_before_this_one_isnt_taken_for_it() {
    let started = Utc::now();
    let following = Running { refresh_id: None, started };
    let at = |offset: chrono::Duration| fabric::RefreshStatus {
      status: "succeeded".into(),
      start_time: Some((started + offset).to_rfc3339()),
      ..Default::default()
    };
    assert!(!is_ours(&at(-chrono::Duration::hours(3)), &following));
    assert!(is_ours(&at(chrono::Duration::seconds(5)), &following));
    assert!(is_ours(&at(-chrono::Duration::hours(3)), &Running { refresh_id: Some("r1".into()), started }));
  }

  #[test]
  fn a_report_says_what_to_do_next() {
    let item = Item {
      folder: "Sales.SemanticModel".into(),
      name: "Sales".into(),
      item_type: SEMANTIC_MODEL.into(),
      key: "k".into(),
      parts: vec![],
      hash: "h".into(),
      model: Default::default(),
      lakehouse: None,
      advisory: vec![],
    };
    let mut card = review::create_item(&item);
    card.summary.storage = Some("import".into());
    let plan = Plan { item, existing: None, card, loads: vec![] };
    let ws = Workspace { id: "11111111-2222-3333-4444-555555555555".into(), name: "Finance".into() };
    let text = apply_report(&[(&plan, Outcome::Done("item-1".into()))], &ws);
    assert!(text.contains("Created the semantic model \"Sales\" in the workspace \"Finance\""), "{text}");
    assert!(text.contains("--workspace-id 11111111-2222-3333-4444-555555555555 --item-id item-1 --name sales"), "{text}");
    assert!(text.contains(REFRESH_TOOL), "{text}");

    let taken = Failure { status: Some(409), name_in_use: true, message: "Name in use.".into(), ..Default::default() };
    let text = apply_report(&[(&plan, Outcome::Failed(taken))], &ws);
    assert!(text.contains("Couldn't create the semantic model \"Sales\"") && text.contains("Use another name"), "{text}");
  }

  #[test]
  fn a_lakehouse_report_gives_each_tables_columns_for_a_direct_lake_model() {
    let item = Item {
      folder: "Sales.Lakehouse".into(),
      name: "Sales".into(),
      item_type: LAKEHOUSE.into(),
      key: "k".into(),
      parts: vec![],
      hash: "h".into(),
      model: Default::default(),
      lakehouse: Some(Default::default()),
      advisory: vec![],
    };
    let card = review::create_item(&item);
    let plan = Plan { item, existing: None, card, loads: vec![0, 1] };
    let ws = Workspace { id: "11111111-2222-3333-4444-555555555555".into(), name: "Finance".into() };
    let column = |name: &str, data_type: &str| lakehouse::TableColumn { name: name.into(), data_type: data_type.into() };
    let outcome = Outcome::Lake {
      item_id: "lake-1".into(),
      created: true,
      tables: vec![
        TableOutcome {
          name: "orders".into(),
          source: "supporting-items/Sales.Lakehouse/data/orders.csv".into(),
          rows: Some(120),
          result: Ok(vec![column("OrderId", "long"), column("Amount", "double")]),
        },
        TableOutcome {
          name: "returns".into(),
          source: "supporting-items/Sales.Lakehouse/data/returns.csv".into(),
          rows: None,
          result: Err("Column count mismatch.".into()),
        },
      ],
      dropped: vec!["old".into()],
    };
    let text = apply_report(&[(&plan, outcome)], &ws);
    assert!(text.contains("Created the lakehouse \"Sales\" in the workspace \"Finance\""), "{text}");
    assert!(text.contains("Loaded the table `orders` from supporting-items/Sales.Lakehouse/data/orders.csv, 120 rows"), "{text}");
    assert!(text.contains("OrderId (long, dataType int64); Amount (double, dataType double)"), "{text}");
    assert!(text.contains("Couldn't load the table `returns`") && text.contains("loads only the tables that haven't loaded"), "{text}");
    assert!(text.contains("no longer lists `old`"), "{text}");
    assert!(
      text.contains("AzureStorage.DataLake(\"https://onelake.dfs.fabric.microsoft.com/11111111-2222-3333-4444-555555555555/lake-1\""),
      "{text}"
    );
    // A lakehouse isn't connected to the app: its model is.
    assert!(!text.contains("rayfin connector add"), "{text}");
  }
}
