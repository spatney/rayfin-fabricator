//! Blueprint's view of an app's supporting items (see
//! `services::supporting_items`): what the app defines and where each stands,
//! a definition's model for the diagram, what Fabric says about the ones it
//! created, and deleting one, which only the user does.

use std::path::Path;

use serde::Serialize;

use crate::services::semantic_model::SemanticSchemaResult;
use crate::services::store;
use crate::services::supporting_items::analysis::Summary;
use crate::services::supporting_items::{
  self as supporting, fabric, folders, is_guid, item_url_of, lakehouse, load_state, read_item, save_state,
  settings_url, status_of, AppliedState, Item, Problem, Status, Workspace, LAKEHOUSE,
};

/// An app's supporting items, for Blueprint.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SupportingItemsView {
  /// The experiment is on and the app isn't a team app.
  pub available: bool,
  /// The app's chat has supporting items on.
  pub on: bool,
  /// The workspace the items are in.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspace: Option<Workspace>,
  /// The workspace new items go to: theirs, else the app's publish workspace.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub target: Option<Workspace>,
  pub items: Vec<ListedItem>,
  /// `applied.json` can't be read.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// One supporting item in the view.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListedItem {
  /// Its logical id, when it's known.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub key: Option<String>,
  /// Its folder in `supporting-items/`.
  pub folder: String,
  pub name: String,
  #[serde(rename = "type")]
  pub item_type: String,
  pub status: Option<Status>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub item_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub applied_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub summary: Option<Summary>,
  /// Why its folder can't be applied as it is.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub problems: Vec<Problem>,
  /// A lakehouse's tables, as its folder lists them.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub tables: Vec<ListedTable>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub settings_url: Option<String>,
}

/// One table of a lakehouse in the view.
#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListedTable {
  pub name: String,
  /// The file or folder it loads from, from the app's root.
  pub source: String,
  pub bytes: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub rows: Option<u64>,
  /// When Fabricator last loaded it.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub loaded_at: Option<String>,
  /// Its files, or how they're read, changed since it was loaded.
  pub changed: bool,
}

/// A lakehouse's tables as its folder lists them, with when each was loaded.
fn tables_of(item: &Item, state: &AppliedState) -> Vec<ListedTable> {
  let Some(definition) = &item.lakehouse else { return Vec::new() };
  let loaded = state.items.get(&item.key).map(|a| &a.tables);
  definition
    .tables
    .iter()
    .map(|table| {
      let was = loaded.and_then(|tables| tables.get(&table.name));
      ListedTable {
        name: table.name.clone(),
        source: format!("{}/{}/{}", supporting::DIR, item.folder, table.source),
        bytes: table.bytes(),
        rows: table.rows.or_else(|| was.and_then(|w| w.rows)),
        loaded_at: was.map(|w| w.loaded_at.clone()),
        changed: was.is_some_and(|w| !lakehouse::same_as_loaded(table, w)),
      }
    })
    .collect()
}

fn project_dir(project_id: &str) -> Result<(crate::types::StudioProject, std::path::PathBuf), String> {
  let project = store::find_project(project_id).ok_or_else(|| t!("commands.shared.projectNotFound"))?;
  let dir = Path::new(&project.path).to_path_buf();
  Ok((project, dir))
}

/// What an app's `supporting-items/` defines, and where each item stands.
fn view_of(project: &crate::types::StudioProject, dir: &Path) -> SupportingItemsView {
  let (state, error) = match load_state(dir) {
    Ok(state) => (state, None),
    Err(why) => (Default::default(), Some(why)),
  };
  let link = |item_type: &str, item_id: &str| {
    state.workspace.as_ref().map(|ws| {
      let settings = (item_type != LAKEHOUSE).then(|| settings_url(&ws.id, item_id));
      (item_url_of(item_type, &ws.id, item_id), settings)
    })
  };
  // The app's lakehouses, which Direct Lake models' sources are named after.
  let lakes: Vec<(String, String)> = state
    .items
    .values()
    .filter(|a| a.item_type == LAKEHOUSE)
    .map(|a| (a.item_id.clone(), a.display_name.clone()))
    .collect();
  let mut items = Vec::new();
  for folder in folders(dir) {
    let (name, kind) = supporting::split_folder(&folder).unwrap_or((folder.as_str(), ""));
    let mut listed = ListedItem { folder: folder.clone(), name: name.to_string(), item_type: kind.to_string(), ..Default::default() };
    match read_item(dir, &folder) {
      Ok(item) => {
        listed.status = Some(status_of(&item, &state));
        if item.is_lakehouse() {
          let tables = tables_of(&item, &state);
          listed.summary = Some(Summary { tables: tables.len(), ..Default::default() });
          listed.tables = tables;
        } else {
          let mut summary = supporting::analysis::summary(&item.model);
          supporting::analysis::name_items(&mut summary.sources, &lakes);
          listed.summary = Some(summary);
        }
        if let Some(applied) = state.items.get(&item.key) {
          listed.item_id = Some(applied.item_id.clone());
          listed.applied_at = Some(applied.applied_at.clone());
        }
        listed.key = Some(item.key);
      }
      Err(problems) => {
        listed.status = Some(Status::Unreadable);
        listed.problems = problems;
        if let Some((key, applied)) = state.items.iter().find(|(_, i)| i.folder.eq_ignore_ascii_case(&folder)) {
          listed.key = Some(key.clone());
          listed.item_id = Some(applied.item_id.clone());
          listed.applied_at = Some(applied.applied_at.clone());
        }
      }
    }
    items.push(listed);
  }
  // Items in Fabric whose folder is gone.
  for (key, applied) in &state.items {
    if items.iter().any(|i| i.key.as_deref() == Some(key.as_str())) {
      continue;
    }
    items.push(ListedItem {
      key: Some(key.clone()),
      folder: applied.folder.clone(),
      name: applied.display_name.clone(),
      item_type: applied.item_type.clone(),
      status: Some(Status::Removed),
      item_id: Some(applied.item_id.clone()),
      applied_at: Some(applied.applied_at.clone()),
      ..Default::default()
    });
  }
  for item in &mut items {
    if let Some((url, settings)) = item.item_id.as_deref().and_then(|id| link(&item.item_type, id)) {
      item.url = Some(url);
      item.settings_url = settings;
    }
  }
  items.sort_by_key(|i| i.name.to_lowercase());
  SupportingItemsView {
    available: project.team.is_none(),
    on: supporting::on_for(project),
    target: supporting::target(project, &state),
    workspace: state.workspace,
    items,
    error,
  }
}

/// An app's supporting items, from its files alone.
#[tauri::command(async)]
pub fn supporting_items_list(project_id: String) -> Result<SupportingItemsView, String> {
  let (project, dir) = project_dir(&project_id)?;
  Ok(view_of(&project, &dir))
}

/// The workspaces a review card offers an app with none yet.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChoices {
  /// The ones the user's apps are published to, most recently opened first.
  pub recent: Vec<Workspace>,
  /// The rest, by name.
  pub others: Vec<Workspace>,
}

/// The most workspaces [`WorkspaceChoices::recent`] lists.
const RECENT_WORKSPACES: usize = 5;

/// `all`, with the workspaces `projects` are published to first.
fn choices(all: Vec<Workspace>, mut projects: Vec<crate::types::StudioProject>) -> WorkspaceChoices {
  projects.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
  let mut recent: Vec<Workspace> = Vec::new();
  for project in projects.iter().filter(|p| p.team.is_none()) {
    let Some(id) = project.workspace.as_deref().map(str::trim).filter(|id| is_guid(id)) else { continue };
    if recent.len() < RECENT_WORKSPACES && !recent.iter().any(|w| w.id.eq_ignore_ascii_case(id)) {
      if let Some(ws) = all.iter().find(|w| w.id.eq_ignore_ascii_case(id)) {
        recent.push(ws.clone());
      }
    }
  }
  let others = all.into_iter().filter(|w| !recent.iter().any(|r| r.id.eq_ignore_ascii_case(&w.id))).collect();
  WorkspaceChoices { recent, others }
}

/// The shared workspaces the app's Fabric account, which Fabricator creates its
/// supporting items as, can create items in: where a review card can put them
/// when the app has no workspace yet.
#[tauri::command]
pub async fn supporting_items_workspaces(project_id: String) -> Result<WorkspaceChoices, String> {
  let (_, dir) = project_dir(&project_id)?;
  let account = fabric::Account::of(&dir).map_err(|f| f.message)?;
  let all = fabric::list_workspaces(&account).await.map_err(|f| {
    if f.signs_in() {
      t!("commands.supportingItems.signIn")
    } else {
      f.message
    }
  })?;
  Ok(choices(all, store::get_state().projects))
}

/// The model a supporting item's folder defines, for the semantic model
/// diagram, without Fabric: `ok: false`, with what's wrong, when it can't be read.
#[tauri::command(async)]
pub fn supporting_items_schema(project_id: String, folder: String) -> Result<SemanticSchemaResult, String> {
  let (_, dir) = project_dir(&project_id)?;
  // Only one of the app's own item folders, by name.
  if !folders(&dir).iter().any(|f| *f == folder) {
    return Err(t!("commands.supportingItems.noFolder", folder = folder));
  }
  Ok(match read_item(&dir, &folder) {
    Ok(item) if item.is_lakehouse() => SemanticSchemaResult {
      ok: false,
      error: Some(t!("commands.supportingItems.notAModel", folder = folder)),
      ..Default::default()
    },
    Ok(item) => supporting::to_schema(&item.model),
    Err(problems) => SemanticSchemaResult {
      ok: false,
      error: Some(problems.iter().map(Problem::message).collect::<Vec<_>>().join("\n")),
      ..Default::default()
    },
  })
}

/// What Fabric says about a supporting item the app created.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FabricState {
  pub key: String,
  /// It's in Fabric; `None` when Fabric couldn't say.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub exists: Option<bool>,
  /// Someone changed it in Fabric since Fabricator last applied it.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub drift: Option<bool>,
  /// How its latest refresh went: `running`, `succeeded`, `failed`, `cancelled`…
  #[serde(skip_serializing_if = "Option::is_none")]
  pub refresh: Option<String>,
  /// When its latest refresh ended, or started while it runs (RFC 3339).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub refreshed_at: Option<String>,
  /// A lakehouse's tables, as Fabric lists them.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tables: Option<Vec<String>>,
  /// The user has to sign in to Fabric again.
  pub needs_sign_in: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// What Fabric says about each supporting item the app created: whether it's
/// there, was changed outside Fabricator, and how its latest refresh went.
#[tauri::command]
pub async fn supporting_items_fabric(project_id: String) -> Result<Vec<FabricState>, String> {
  let (_, dir) = project_dir(&project_id)?;
  let state = load_state(&dir)?;
  let Some(ws) = state.workspace.clone() else {
    return Ok(Vec::new());
  };
  if state.items.is_empty() {
    return Ok(Vec::new());
  }
  let account = fabric::Account::of(&dir).map_err(|f| f.message)?;
  let checks = state.items.iter().map(|(key, applied)| {
    let (ws, account) = (ws.clone(), account.clone());
    async move {
      let mut out = FabricState { key: key.clone(), ..Default::default() };
      match fabric::get_item(&account, &ws.id, &applied.item_id).await {
        Ok(None) => {
          out.exists = Some(false);
          return out;
        }
        Ok(Some(_)) => out.exists = Some(true),
        Err(f) => {
          out.needs_sign_in = f.signs_in();
          out.error = Some(f.message);
          return out;
        }
      }
      if applied.item_type == LAKEHOUSE {
        out.tables = fabric::list_tables(&account, &ws.id, &applied.item_id).await.ok();
        return out;
      }
      let (refresh, definition) = tokio::join!(
        fabric::refresh_status(&account, &ws.id, &applied.item_id, None),
        fabric::get_definition(&account, &ws.id, &applied.item_id)
      );
      if let Ok(status) = refresh {
        out.refreshed_at = status.end_time.clone().or(status.start_time.clone());
        out.refresh = Some(status.status).filter(|s| !s.is_empty() && s != "unknown");
      }
      if let (Ok(parts), Some(recorded)) = (definition, &applied.fabric_hash) {
        if let Ok(model) = supporting::tmdl::parse_definition(&supporting::tmdl_files(&parts)) {
          out.drift = Some(supporting::model_hash(&model) != *recorded);
        }
      }
      out
    }
  });
  Ok(futures::future::join_all(checks).await)
}

/// Delete a supporting item the app created from Fabric, and forget it; with
/// `remove_folder`, move its folder to the trash too. Only the user does this,
/// from Blueprint: chat never deletes Fabric items.
#[tauri::command]
pub async fn supporting_items_delete(project_id: String, key: String, remove_folder: bool) -> Result<SupportingItemsView, String> {
  let (project, dir) = project_dir(&project_id)?;
  let mut state = load_state(&dir)?;
  let applied = state.items.get(&key).cloned().ok_or_else(|| t!("commands.supportingItems.notCreated"))?;
  let ws = state.workspace.clone().filter(|ws| is_guid(&ws.id)).ok_or_else(|| t!("commands.supportingItems.noWorkspace"))?;
  let account = fabric::Account::of(&dir).map_err(|f| f.message)?;
  fabric::delete(&account, &ws.id, &applied.item_id).await.map_err(|f| {
    if f.signs_in() {
      t!("commands.supportingItems.signIn")
    } else {
      t!("commands.supportingItems.deleteFailed", error = f.message)
    }
  })?;
  state.items.remove(&key);
  // With none left, the next one goes where the app is published, or is picked
  // again: not to a workspace only the deleted ones were in.
  if state.items.is_empty() {
    state.workspace = None;
  }
  save_state(&dir, &state).map_err(|e| t!("commands.supportingItems.saveFailed", error = e))?;
  crate::services::telemetry::track_supporting(
    crate::commands::auth::get_cached_identity().as_ref(),
    "delete",
    "succeeded",
    &[("folder", remove_folder.to_string())],
  );
  if remove_folder && folders(&dir).iter().any(|f| *f == applied.folder) {
    let path = supporting::dir(&dir).join(&applied.folder);
    trash::delete(&path).map_err(|e| t!("commands.supportingItems.trashFailed", error = e))?;
  }
  Ok(view_of(&project, &dir))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ws(id: &str, name: &str) -> Workspace {
    Workspace { id: id.into(), name: name.into() }
  }

  fn project(id: &str, workspace: Option<&str>, opened: &str) -> crate::types::StudioProject {
    serde_json::from_value(serde_json::json!({
      "id": id, "name": id, "path": "C:/apps", "addedAt": "", "workspace": workspace, "lastOpenedAt": opened
    }))
    .unwrap()
  }

  #[test]
  fn a_card_offers_the_workspaces_the_users_apps_are_published_to_first() {
    let a = "11111111-1111-4111-8111-111111111111";
    let b = "22222222-2222-4222-8222-222222222222";
    let all = vec![ws(a, "Alpha"), ws(b, "Beta"), ws("33333333-3333-4333-8333-333333333333", "Gamma")];
    let projects = vec![
      project("old", Some(a), "2026-01-01T00:00:00Z"),
      project("new", Some(&b.to_uppercase()), "2026-06-01T00:00:00Z"),
      project("same", Some(b), "2026-05-01T00:00:00Z"),
      // Not one the account can create items in, or not a workspace id at all.
      project("gone", Some("44444444-4444-4444-8444-444444444444"), "2026-07-01T00:00:00Z"),
      project("named", Some("Finance"), "2026-08-01T00:00:00Z"),
      project("local", None, "2026-09-01T00:00:00Z"),
    ];
    let offered = choices(all, projects);
    assert_eq!(offered.recent, [ws(b, "Beta"), ws(a, "Alpha")]);
    assert_eq!(offered.others, [ws("33333333-3333-4333-8333-333333333333", "Gamma")]);
  }
}