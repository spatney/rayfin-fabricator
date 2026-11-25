//! The review card a Build chat shows before Fabricator changes anything in
//! Fabric for a supporting item, and then how the change went. Fabricator owns
//! the card: each change to it goes to the chat whole (`supporting-review`),
//! and the renderer keeps the latest with the turn.

use serde::Serialize;

use super::analysis::{self, Change, Check, Summary};
use super::lakehouse::{Format, TableSource};
use super::{tmdl, Item, Workspace, DIR};

/// The most changes a card lists for one item.
pub const MAX_CHANGES: usize = 60;

/// What a card asks for.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewKind {
  /// Create or change items in Fabric.
  #[default]
  Apply,
  /// Load an item's data.
  Refresh,
}

/// Where a card stands.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
  /// Waiting for the user.
  #[default]
  Pending,
  /// Approved, and Fabricator is at work.
  Working,
  Done,
  /// Approved, and something didn't work.
  Failed,
  Declined,
  /// The turn ended before the user answered.
  Interrupted,
}

/// What a card does to an item.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ItemChange {
  #[default]
  Create,
  Update,
  Refresh,
}

/// How one item's part of the work went.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ItemState {
  #[default]
  Pending,
  Working,
  Done,
  Failed,
  /// Left as it was.
  Skipped,
}

/// What loading a table does.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TableChange {
  /// A new table.
  #[default]
  Load,
  /// Replaces what the table holds.
  Reload,
}

/// A table a lakehouse loads, on a card.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableLoad {
  pub name: String,
  /// The file or folder it loads from, from the app's root.
  pub source: String,
  /// `csv` or `parquet`.
  pub format: String,
  pub files: usize,
  pub bytes: u64,
  /// A CSV file's rows, when they were counted.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub rows: Option<u64>,
  /// A CSV file's columns, from its header.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub columns: Vec<String>,
  pub change: TableChange,
  pub state: ItemState,
  /// What's happening while it's worked on: `uploading` or `loading`.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub phase: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

impl TableLoad {
  pub fn of(folder: &str, table: &TableSource, change: TableChange) -> Self {
    TableLoad {
      name: table.name.clone(),
      source: format!("{DIR}/{folder}/{}", table.source),
      format: match table.format {
        Format::Csv => "csv".into(),
        Format::Parquet => "parquet".into(),
      },
      files: table.files.len(),
      bytes: table.bytes(),
      rows: table.rows,
      columns: table.columns.clone(),
      change,
      ..Default::default()
    }
  }
}

/// One item on a card.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItem {
  /// Its folder's logical id.
  pub key: String,
  pub name: String,
  #[serde(rename = "type")]
  pub item_type: String,
  /// Its folder, from the app's root: `supporting-items/Sales.SemanticModel`.
  pub folder: String,
  pub change: ItemChange,
  pub summary: Summary,
  /// For an update: what changes, at most [`MAX_CHANGES`].
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub changes: Vec<Change>,
  /// How many changes there are beyond `changes`.
  #[serde(skip_serializing_if = "is_zero")]
  pub more_changes: usize,
  /// For an update: Fabric's definition couldn't be read, so the changes aren't known.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub changes_unknown: bool,
  /// Someone changed the item in Fabric since Fabricator last applied it, and
  /// applying replaces what they changed.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub drift: bool,
  /// Fabricator created the item before, but it's gone from Fabric: it's created again.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub recreate: bool,
  /// What the user should know before they approve.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub checks: Vec<Check>,
  /// For a refresh: the folder has changes that aren't in Fabric yet, so the
  /// refresh loads the model as Fabric has it.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub unapplied: bool,
  pub state: ItemState,
  /// What's happening while it's worked on, beyond its change: `refreshing`,
  /// when a Direct Lake model reads its tables for the first time.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub phase: Option<String>,
  /// A lakehouse's tables to load.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub tables: Vec<TableLoad>,
  /// A Direct Lake model: Fabricator refreshes it once it's applied, so it reads its tables.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub frames: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub item_id: Option<String>,
  /// When its work started, in epoch ms, for the card's timer.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub started_at: Option<f64>,
  /// What went wrong.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  /// What a failed refresh said.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub errors: Vec<String>,
  /// The refresh needs the data source's credentials, set in Fabric.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub needs_credentials: bool,
  /// Fabricator can't start the refresh with the user's sign-ins: they refresh
  /// it in Fabric.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub refresh_in_fabric: bool,
  /// The item in Fabric.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  /// Its settings in Fabric, where its data source credentials are set.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub settings_url: Option<String>,
}

fn is_zero(n: &usize) -> bool {
  *n == 0
}

/// A review card.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Review {
  /// The card's request id, which the user's answer comes back with.
  pub id: String,
  /// The app it's for: its workspace picker lists what the app's Fabric account
  /// can create items in.
  #[serde(skip_serializing_if = "String::is_empty")]
  pub project_id: String,
  pub kind: ReviewKind,
  pub state: ReviewState,
  /// What Copilot says it's for, in a few words.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reason: Option<String>,
  /// The workspace the items are in or go to: none until the user picks one.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub workspace: Option<Workspace>,
  /// The user picks the workspace on the card: the app has none yet.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub pick_workspace: bool,
  /// The Fabric account Fabricator uses: the app's.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub account: Option<String>,
  /// The Azure CLI's account, which uploads lakehouses' files to OneLake, when
  /// it isn't the same as `account`.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub uploads_as: Option<String>,
  pub items: Vec<ReviewItem>,
  /// What went wrong, when it isn't one item's doing.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

impl Review {
  /// The card as the chat event carries it.
  pub fn to_value(&self) -> serde_json::Value {
    serde_json::to_value(self).unwrap_or_default()
  }

  /// Whether any item failed.
  pub fn any_failed(&self) -> bool {
    self.items.iter().any(|i| i.state == ItemState::Failed)
  }
}

/// An item to create, on a card: a lakehouse loads every table it lists.
pub fn create_item(item: &Item) -> ReviewItem {
  let tables = match &item.lakehouse {
    Some(definition) => definition.tables.iter().map(|t| TableLoad::of(&item.folder, t, TableChange::Load)).collect(),
    None => Vec::new(),
  };
  let summary = if item.is_lakehouse() { lakehouse_summary(item) } else { analysis::summary(&item.model) };
  ReviewItem {
    key: item.key.clone(),
    name: item.name.clone(),
    item_type: item.item_type.clone(),
    folder: item.path(),
    change: ItemChange::Create,
    frames: frames(&summary),
    summary,
    checks: item.advisory.clone(),
    tables,
    ..Default::default()
  }
}

/// A lakehouse at a glance: its tables, and their columns where they're known.
fn lakehouse_summary(item: &Item) -> Summary {
  let tables = item.lakehouse.as_ref().map(|d| d.tables.as_slice()).unwrap_or_default();
  Summary { tables: tables.len(), columns: tables.iter().map(|t| t.columns.len()).sum(), ..Default::default() }
}

/// A lakehouse that's in Fabric, on a card: the tables it loads again, by their
/// index in its definition, and whether each is new to it.
pub fn lakehouse_item(item: &Item, item_id: &str, loads: &[(usize, TableChange)]) -> ReviewItem {
  let mut card = create_item(item);
  card.change = ItemChange::Update;
  card.item_id = Some(item_id.to_string());
  let tables = item.lakehouse.as_ref().map(|d| d.tables.as_slice()).unwrap_or_default();
  card.tables = loads.iter().filter_map(|(i, change)| tables.get(*i).map(|t| TableLoad::of(&item.folder, t, *change))).collect();
  card
}

/// An item to update, on a card: what changes from `fabric`, the model Fabric
/// has now (`None` when it couldn't be read), and whether someone changed it in
/// Fabric since it was applied (`drift`).
pub fn update_item(item: &Item, item_id: &str, fabric: Option<&tmdl::Model>, drift: bool) -> ReviewItem {
  let mut card = create_item(item);
  card.change = ItemChange::Update;
  card.item_id = Some(item_id.to_string());
  card.drift = drift;
  match fabric {
    Some(model) => {
      let mut changes = analysis::diff(model, &item.model);
      if changes.len() > MAX_CHANGES {
        card.more_changes = changes.len() - MAX_CHANGES;
        changes.truncate(MAX_CHANGES);
      }
      card.changes = changes;
    }
    None => card.changes_unknown = true,
  }
  card
}

/// Whether a summary's storage loads data with a refresh: import, dual or mixed.
pub fn loads_data(summary: &Summary) -> bool {
  matches!(summary.storage.as_deref(), Some("import" | "dual" | "mixed"))
}

/// Whether a model is Direct Lake: it reads its tables once it's refreshed, and
/// again whenever it's refreshed after they change.
pub fn frames(summary: &Summary) -> bool {
  summary.storage.as_deref() == Some("directLake")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_card_goes_to_the_chat_in_camel_case_without_empty_fields() {
    let review = Review {
      id: "r1".into(),
      kind: ReviewKind::Apply,
      state: ReviewState::Pending,
      workspace: Some(Workspace { id: "w".into(), name: "Finance".into() }),
      items: vec![ReviewItem { key: "k".into(), name: "Sales".into(), item_type: "SemanticModel".into(), ..Default::default() }],
      ..Default::default()
    };
    let value = review.to_value();
    assert_eq!(value["kind"], "apply");
    assert_eq!(value["state"], "pending");
    assert_eq!(value["items"][0]["type"], "SemanticModel");
    assert_eq!(value["items"][0]["change"], "create");
    assert!(value.get("pickWorkspace").is_none() && value["items"][0].get("drift").is_none());
  }

  #[test]
  fn only_models_that_load_data_need_a_refresh() {
    let with = |storage: Option<&str>| Summary { storage: storage.map(str::to_string), ..Default::default() };
    assert!(loads_data(&with(Some("import"))) && loads_data(&with(Some("mixed"))));
    assert!(!loads_data(&with(Some("directQuery"))) && !loads_data(&with(Some("directLake"))) && !loads_data(&with(None)));
  }
}
