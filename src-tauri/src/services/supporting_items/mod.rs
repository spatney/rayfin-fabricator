//! Supporting items: the Microsoft Fabric items an app relies on that aren't
//! part of the Rayfin app, such as a Power BI semantic model its pages read, or
//! a lakehouse its data is staged in.
//!
//! Copilot defines each one in the app's repo, in a folder of its own under
//! [`DIR`], in Fabric's Git format: `<Name>.SemanticModel/` holds `.platform`,
//! `definition.pbism` and the model in TMDL under `definition/`;
//! `<Name>.Lakehouse/` holds `.platform`, `lakehouse.metadata.json` and the
//! tables Fabricator loads into it from files under its `data/` ([`lakehouse`]).
//! Fabricator creates or changes the item in the app's Fabric workspace only
//! after the user approves a review card in the chat ([`tools`]), and records
//! the Fabric item each folder became in [`STATE_FILE`]. Publishing the app
//! (`rayfin up`) never touches them: it deploys only the Rayfin app in `rayfin/`.
//!
//! Chat has them while the app's chat has [`PLUGIN`] on ([`on_for`]). Team apps
//! don't: their pipeline would have to apply them.

pub mod analysis;
pub mod fabric;
pub mod lakehouse;
pub mod review;
pub mod tmdl;
pub mod tools;

pub use lakehouse::LAKEHOUSE;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::StudioProject;

/// The plugin id that turns supporting items on in a project's chat.
pub const PLUGIN: &str = "supporting-items";
/// The folder, in an app's repo, that holds its supporting items.
pub const DIR: &str = "supporting-items";
/// Fabricator's record, in [`DIR`], of the Fabric item each folder became.
pub const STATE_FILE: &str = "applied.json";
/// What [`DIR`] is, for whoever opens it.
const README_FILE: &str = "README.md";
/// Keeps lakehouses' data files out of git, in [`DIR`].
const GITIGNORE_FILE: &str = ".gitignore";
/// A semantic model: the type of item an app reads with a connector.
pub const SEMANTIC_MODEL: &str = "SemanticModel";

/// The most files one item's definition may have.
const MAX_FILES: usize = 2_000;
/// The most bytes one item's definition may have.
const MAX_BYTES: u64 = 30 * 1024 * 1024;

/// Whether chat in `project` has supporting items: it isn't a team app, and its
/// chat has them on.
pub fn on_for(project: &StudioProject) -> bool {
  in_chat(project) == InChat::On
}

/// What a project's Build chat has of supporting items.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InChat {
  /// Not offered: it's a team app.
  #[default]
  Unavailable,
  /// Offered, but off in the app's chat: chat can ask the user to turn them on
  /// ([`tools::TURN_ON_TOOL`]).
  Off,
  /// On: the tools that create and change them, with their guidance.
  On,
}

impl InChat {
  pub fn on(self) -> bool {
    self == InChat::On
  }
}

/// What chat in `project` has of supporting items.
pub fn in_chat(project: &StudioProject) -> InChat {
  if project.team.is_some() {
    InChat::Unavailable
  } else if project.plugins.iter().any(|p| p == PLUGIN) {
    InChat::On
  } else {
    InChat::Off
  }
}

/// Whether `value` is a GUID, as Fabric's ids are.
pub fn is_guid(value: &str) -> bool {
  static GUID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$").unwrap());
  GUID.is_match(value.trim())
}

/* -------------------------------- problems -------------------------------- */

/// Something about a supporting item's folder that stops Fabricator from
/// applying it. `code` says what, for the interface to describe in the user's
/// language; [`Problem::message`] says it in English, for Copilot.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
  pub code: String,
  /// The file, relative to the item's folder.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub file: Option<String>,
  /// Its 1-based line.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub line: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub table: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub column: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
}

impl Problem {
  fn new(code: &str) -> Self {
    Problem { code: code.into(), ..Default::default() }
  }

  fn in_file(mut self, file: &str) -> Self {
    self.file = Some(file.into());
    self
  }

  fn at_line(mut self, line: usize) -> Self {
    self.line = Some(line);
    self
  }

  fn with_detail(mut self, detail: impl Into<String>) -> Self {
    self.detail = Some(detail.into());
    self
  }

  /// What's wrong, in English, for Copilot to fix.
  pub fn message(&self) -> String {
    let file = self.file.as_deref().unwrap_or("");
    let detail = self.detail.as_deref().unwrap_or("");
    let at = match self.line {
      Some(line) => format!("{file} line {line}"),
      None => file.to_string(),
    };
    let table = self.table.as_deref().unwrap_or("");
    let column = self.column.as_deref().unwrap_or("");
    match self.code.as_str() {
      "bad-name" => {
        "Name the item's folder `<Name>.SemanticModel` or `<Name>.Lakehouse`, such as `Sales.SemanticModel`.".into()
      }
      "unsupported-type" => format!(
        "Supporting items can be semantic models (`<Name>.SemanticModel`) or lakehouses (`<Name>.Lakehouse`) for \
         now, not `{detail}`."
      ),
      "tmsl" => {
        "model.bim (TMSL) isn't supported here: define the model in TMDL under definition/, and remove model.bim.".into()
      }
      "missing-file" => format!("{file} is missing."),
      "bad-json" => format!("{file} isn't valid JSON ({detail})."),
      "wrong-type" => format!(".platform says the item is a `{detail}`, but its folder's name says otherwise."),
      "name-mismatch" => {
        format!("The displayName in .platform (\"{detail}\") must be the folder's name without its type, such as `Sales`.")
      }
      "lakehouse-schemas" => format!(
        "{} sets a defaultSchema, which makes a lakehouse with schemas: Fabric can't load tables into one yet. Make \
         it `{{}}`.",
        lakehouse::METADATA
      ),
      "bad-table-name" => format!(
        "In {}, the table name \"{detail}\" can't be used: use letters, digits and underscores, starting with a \
         letter or underscore, such as `sales_orders`.",
        lakehouse::MANIFEST
      ),
      "bad-data-path" => format!(
        "In {}, the table `{table}` loads from \"{detail}\": its file must be a relative path under the lakehouse's \
         {}/ folder, such as `{}/orders.csv`.",
        lakehouse::MANIFEST,
        lakehouse::DATA_DIR,
        lakehouse::DATA_DIR
      ),
      "missing-data" => format!(
        "The table `{table}` loads from {detail}, which isn't in the lakehouse's folder. Copy the file there first."
      ),
      "empty-data" => format!("The table `{table}` loads from {detail}, which has no files."),
      "bad-format" => format!(
        "The table `{table}` loads from {detail}: Fabricator loads CSV (.csv, .tsv, .txt) and Parquet files. Set \
         \"format\" to \"csv\" or \"parquet\" when the files' names don't say which."
      ),
      "bad-delimiter" => format!("The table `{table}`'s delimiter \"{detail}\" must be one character, such as \",\" or \";\"."),
      "no-logical-id" => {
        ".platform needs config.logicalId: a new GUID, which stays the same for the life of the item.".into()
      }
      "pbism-version" => {
        format!("definition.pbism's version must be 4.0 or later for a model defined in TMDL (it's {detail}).")
      }
      "secret" => format!(
        "{at} looks like it holds {detail}. Definitions are committed with the app, so keep credentials out of them: \
         the user sets the data source's credentials in Fabric."
      ),
      "too-large" => format!("The definition is too large: {detail}."),
      "data-too-large" => format!("The table `{table}` loads more than Fabricator uploads: {detail}."),
      "link" => format!("{file} is a link. A supporting item's folder can't contain links."),
      "unreadable" => format!("{file} can't be read ({detail})."),
      "tmdl" => format!("{at}: {detail}"),
      "no-tables" => "The model has no tables.".into(),
      "direct-lake-level" => format!(
        "Direct Lake tables need compatibilityLevel {} or later in definition/database.tmdl (it's {detail}).",
        analysis::DIRECT_LAKE_LEVEL
      ),
      "duplicate-table" => format!("The table `{table}` is defined more than once."),
      "duplicate-name" => format!("The table `{table}` has more than one column or measure named `{column}`."),
      "duplicate-measure" => {
        format!("More than one table has a measure named `{column}`; measure names must be unique in the model.")
      }
      "missing-table" => format!("A relationship ({detail}) refers to the table `{table}`, which the model doesn't have."),
      "missing-column" => {
        format!("A relationship ({detail}) refers to `{table}[{column}]`, which the model doesn't have.")
      }
      "self-relationship" => format!("A relationship ({detail}) goes from a column to itself."),
      "duplicate-relationship" => format!("Two relationships join the same columns ({detail})."),
      other => format!("{other}: {at} {detail}").trim().to_string(),
    }
  }
}

/// The problems of `folder`, as one message for Copilot.
pub fn problems_text(folder: &str, problems: &[Problem]) -> String {
  let mut text = format!("Fabricator can't apply {DIR}/{folder} yet:");
  for problem in problems.iter().take(30) {
    text.push_str("\n- ");
    text.push_str(&problem.message());
  }
  if problems.len() > 30 {
    text.push_str(&format!("\n- …and {} more.", problems.len() - 30));
  }
  text
}

/* --------------------------------- folders -------------------------------- */

/// One file of an item's definition, as Fabric takes it: its path in the item's
/// folder, with `/`, and its bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
  pub path: String,
  pub bytes: Vec<u8>,
}

/// A supporting item's folder and its definition, read and checked.
#[derive(Clone, Debug)]
pub struct Item {
  /// The folder's name, `<name>.<type>`.
  pub folder: String,
  pub name: String,
  pub item_type: String,
  /// `.platform`'s `config.logicalId`, lowercase: how [`AppliedState`] knows the item.
  pub key: String,
  pub parts: Vec<Part>,
  /// A hash of the parts (and a lakehouse's data files), to tell when they change.
  pub hash: String,
  /// A semantic model's model; empty for a lakehouse.
  pub model: tmdl::Model,
  /// A lakehouse's tables and their data files.
  pub lakehouse: Option<lakehouse::Definition>,
  /// What the review card warns about.
  pub advisory: Vec<analysis::Check>,
}

impl Item {
  /// The folder, from the app's root: `supporting-items/Sales.SemanticModel`.
  pub fn path(&self) -> String {
    format!("{DIR}/{}", self.folder)
  }

  pub fn is_lakehouse(&self) -> bool {
    self.item_type == LAKEHOUSE
  }
}

/// The folder of an app's supporting items.
pub fn dir(project_dir: &Path) -> PathBuf {
  project_dir.join(DIR)
}

/// The item folders in an app's [`DIR`], by name: the folders whose names have
/// a type after a dot.
pub fn folders(project_dir: &Path) -> Vec<String> {
  let Ok(entries) = std::fs::read_dir(dir(project_dir)) else {
    return Vec::new();
  };
  let mut names: Vec<String> = entries
    .flatten()
    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
    .filter_map(|e| e.file_name().into_string().ok())
    .filter(|name| !name.starts_with('.') && split_folder(name).is_some())
    .collect();
  names.sort_by_key(|n| n.to_lowercase());
  names
}

/// A folder's name and type: `Sales.SemanticModel` is `("Sales", "SemanticModel")`.
pub fn split_folder(folder: &str) -> Option<(&str, &str)> {
  let (name, kind) = folder.rsplit_once('.')?;
  (!name.trim().is_empty() && !kind.is_empty()).then_some((name, kind))
}

/// The files of an item's definition in `root`: `.platform`, `definition.pbism`,
/// `diagramLayout.json` and everything under `definition/`, as paths relative to
/// `root` with `/`. Anything else, such as Power BI Desktop's `.pbi/` cache, is
/// left out.
fn definition_files(root: &Path, problems: &mut Vec<Problem>) -> Vec<(String, PathBuf)> {
  let mut files = Vec::new();
  for top in [".platform", "definition.pbism", "diagramLayout.json"] {
    let path = root.join(top);
    match std::fs::symlink_metadata(&path) {
      Ok(meta) if meta.file_type().is_symlink() => problems.push(Problem::new("link").in_file(top)),
      Ok(meta) if meta.is_file() => files.push((top.to_string(), path)),
      _ => {}
    }
  }
  if root.join("model.bim").is_file() {
    problems.push(Problem::new("tmsl").in_file("model.bim"));
  }
  let mut stack = vec![(root.join("definition"), "definition".to_string())];
  while let Some((dir, rel)) = stack.pop() {
    let Ok(entries) = std::fs::read_dir(&dir) else { continue };
    for entry in entries.flatten() {
      let Ok(name) = entry.file_name().into_string() else { continue };
      let child = format!("{rel}/{name}");
      match entry.file_type() {
        Ok(t) if t.is_symlink() => problems.push(Problem::new("link").in_file(&child)),
        Ok(t) if t.is_dir() => stack.push((entry.path(), child)),
        Ok(t) if t.is_file() => files.push((child, entry.path())),
        _ => {}
      }
    }
  }
  files.sort_by(|a, b| a.0.cmp(&b.0));
  files
}

/// What looks like a credential in a definition, and how to name it.
static CREDENTIALS: Lazy<Vec<(&'static str, Regex)>> = Lazy::new(|| {
  [
    ("a password", r#"(?i)\b(?:password|passwd|pwd)\s*[=:]\s*["']?[^\s"';,\])]{3,}"#),
    ("an account key", r"(?i)\baccountkey\s*=\s*[A-Za-z0-9+/=]{20,}"),
    ("a shared access signature", r"(?i)[?&;]sig=[A-Za-z0-9%+/=]{20,}"),
    ("a client secret", r#"(?i)\bclient[_-]?secret\b["']?\s*[=:,]\s*["'][^"'\s]{8,}["']"#),
    ("a bearer token", r"(?i)\bbearer\s+[A-Za-z0-9\-_.~+/]{20,}"),
    ("a JSON web token", r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    ("a private key", r"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----"),
  ]
  .into_iter()
  .map(|(what, pattern)| (what, Regex::new(pattern).unwrap()))
  .collect()
});

/// The lines of `text` that look like they hold a credential.
fn credentials_in(file: &str, text: &str) -> Vec<Problem> {
  text
    .lines()
    .enumerate()
    .filter_map(|(i, line)| {
      CREDENTIALS
        .iter()
        .find(|(_, pattern)| pattern.is_match(line))
        .map(|(what, _)| Problem::new("secret").in_file(file).at_line(i + 1).with_detail(*what))
    })
    .collect()
}

/// A hash of an item's parts, the same whatever line endings they were saved with.
pub fn parts_hash(parts: &[Part]) -> String {
  let mut sorted: Vec<&Part> = parts.iter().collect();
  sorted.sort_by(|a, b| a.path.cmp(&b.path));
  let mut hasher = Sha256::new();
  for part in sorted {
    hasher.update(part.path.as_bytes());
    hasher.update([0]);
    let text = String::from_utf8_lossy(&part.bytes).replace("\r\n", "\n");
    hasher.update(text.as_bytes());
    hasher.update([0]);
  }
  hex::encode(hasher.finalize())
}

/// A hash of a model's material properties (see [`analysis::canonical`]): it
/// tells when the model in Fabric was changed since Fabricator applied it,
/// whatever form Fabric writes its definition in.
pub fn model_hash(model: &tmdl::Model) -> String {
  hex::encode(Sha256::digest(analysis::canonical(model).as_bytes()))
}

/// The TMDL files among `parts`, as text, for [`tmdl::parse_definition`].
pub fn tmdl_files(parts: &[Part]) -> Vec<(String, String)> {
  parts
    .iter()
    .filter(|p| p.path.starts_with("definition/") && p.path.to_lowercase().ends_with(".tmdl"))
    .map(|p| (p.path.clone(), String::from_utf8_lossy(&p.bytes).trim_start_matches('\u{feff}').to_string()))
    .collect()
}

/// A JSON file among `parts`, parsed; a problem when it's missing or isn't JSON.
fn json_part(parts: &[Part], file: &str, problems: &mut Vec<Problem>) -> Option<serde_json::Value> {
  let Some(part) = parts.iter().find(|p| p.path == file) else {
    problems.push(Problem::new("missing-file").in_file(file));
    return None;
  };
  let text = String::from_utf8_lossy(&part.bytes);
  match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
    Ok(value) => Some(value),
    Err(e) => {
      problems.push(Problem::new("bad-json").in_file(file).with_detail(e.to_string()));
      None
    }
  }
}

/// A `definition.pbism` version's major number: `"4.2"` → 4.
fn version_major(value: &serde_json::Value) -> Option<u64> {
  match value {
    serde_json::Value::Number(n) => n.as_f64().map(|v| v.trunc() as u64),
    serde_json::Value::String(s) => s.trim().split('.').next()?.parse().ok(),
    _ => None,
  }
}

/// Read and check the supporting item in `supporting-items/<folder>`: its
/// definition's files and `.platform`; for a semantic model, `definition.pbism`
/// and its model, which must be read without errors and have nothing that
/// stops Fabric from taking it; for a lakehouse, its tables and their data
/// files. Every problem found when it can't be applied.
pub fn read_item(project_dir: &Path, folder: &str) -> Result<Item, Vec<Problem>> {
  let Some((name, kind)) = split_folder(folder) else {
    return Err(vec![Problem::new("bad-name")]);
  };
  match kind {
    SEMANTIC_MODEL => read_model(project_dir, folder, name),
    LAKEHOUSE => read_lakehouse(project_dir, folder, name),
    _ => Err(vec![Problem::new("unsupported-type").with_detail(kind)]),
  }
}

/// The files of `files` in `root`, read, within the size limits.
fn read_parts(files: &[(String, PathBuf)], problems: &mut Vec<Problem>) -> Option<Vec<Part>> {
  if files.len() > MAX_FILES {
    problems.push(Problem::new("too-large").with_detail(format!("{} files, at most {MAX_FILES}", files.len())));
    return None;
  }
  let mut parts = Vec::new();
  let mut total = 0u64;
  for (rel, path) in files {
    match std::fs::read(path) {
      Ok(bytes) => {
        total += bytes.len() as u64;
        parts.push(Part { path: rel.clone(), bytes });
      }
      Err(e) => problems.push(Problem::new("unreadable").in_file(rel).with_detail(e.to_string())),
    }
  }
  if total > MAX_BYTES {
    problems.push(Problem::new("too-large").with_detail(format!("{} MB, at most {} MB", total >> 20, MAX_BYTES >> 20)));
    return None;
  }
  Some(parts)
}

/// Check `.platform` among `parts`: its type is `kind`, its name the folder's
/// `name`, and it has a logical id, which it returns, lowercase.
fn check_platform(parts: &[Part], name: &str, kind: &str, problems: &mut Vec<Problem>) -> String {
  let mut key = String::new();
  if let Some(platform) = json_part(parts, ".platform", problems) {
    let field = |path: &[&str]| -> Option<String> {
      path.iter().try_fold(&platform, |v, k| v.get(k)).and_then(|v| v.as_str()).map(|s| s.trim().to_string())
    };
    match field(&["metadata", "type"]) {
      Some(t) if t == kind => {}
      t => problems.push(Problem::new("wrong-type").in_file(".platform").with_detail(t.unwrap_or_else(|| "none".into()))),
    }
    match field(&["metadata", "displayName"]) {
      Some(display) if display == name => {}
      display => {
        problems.push(Problem::new("name-mismatch").in_file(".platform").with_detail(display.unwrap_or_default()))
      }
    }
    match field(&["config", "logicalId"]) {
      Some(id) if is_guid(&id) => key = id.to_lowercase(),
      _ => problems.push(Problem::new("no-logical-id").in_file(".platform")),
    }
  }
  key
}

fn read_model(project_dir: &Path, folder: &str, name: &str) -> Result<Item, Vec<Problem>> {
  let root = dir(project_dir).join(folder);
  let mut problems = Vec::new();
  let files = definition_files(&root, &mut problems);
  let Some(parts) = read_parts(&files, &mut problems) else {
    return Err(problems);
  };
  let key = check_platform(&parts, name, SEMANTIC_MODEL, &mut problems);
  if let Some(pbism) = json_part(&parts, "definition.pbism", &mut problems) {
    let version = pbism.get("version");
    if version.and_then(version_major).is_none_or(|major| major < 4) {
      let shown = version.map(|v| v.to_string()).unwrap_or_else(|| "missing".into());
      problems.push(Problem::new("pbism-version").in_file("definition.pbism").with_detail(shown));
    }
  }
  for required in ["definition/database.tmdl", "definition/model.tmdl"] {
    if !parts.iter().any(|p| p.path.eq_ignore_ascii_case(required)) {
      problems.push(Problem::new("missing-file").in_file(required));
    }
  }
  for part in &parts {
    if let Ok(text) = std::str::from_utf8(&part.bytes) {
      problems.extend(credentials_in(&part.path, text));
    }
  }

  let model = match tmdl::parse_definition(&tmdl_files(&parts)) {
    Ok(model) => Some(model),
    Err(diagnostics) => {
      problems.extend(
        diagnostics.into_iter().map(|d| Problem::new("tmdl").in_file(&d.file).at_line(d.line).with_detail(d.message)),
      );
      None
    }
  };
  let mut advisory = Vec::new();
  if let Some(model) = &model {
    let (blocking, warnings) = analysis::checks(model);
    problems.extend(blocking.into_iter().map(|c| Problem {
      code: c.code,
      table: c.table,
      column: c.column,
      detail: c.detail,
      ..Default::default()
    }));
    advisory = warnings;
  }
  match model {
    Some(model) if problems.is_empty() => {
      let hash = parts_hash(&parts);
      Ok(Item {
        folder: folder.to_string(),
        name: name.to_string(),
        item_type: SEMANTIC_MODEL.to_string(),
        key,
        parts,
        hash,
        model,
        lakehouse: None,
        advisory,
      })
    }
    _ => Err(problems),
  }
}

/// The files of a lakehouse's definition in `root`: `.platform`, Fabric's
/// metadata and Fabricator's table list. Its data files are read by [`lakehouse::read`].
fn lakehouse_files(root: &Path, problems: &mut Vec<Problem>) -> Vec<(String, PathBuf)> {
  let mut files = Vec::new();
  for top in [".platform", lakehouse::METADATA, lakehouse::MANIFEST] {
    let path = root.join(top);
    match std::fs::symlink_metadata(&path) {
      Ok(meta) if meta.file_type().is_symlink() => problems.push(Problem::new("link").in_file(top)),
      Ok(meta) if meta.is_file() => files.push((top.to_string(), path)),
      _ => {}
    }
  }
  files
}

fn read_lakehouse(project_dir: &Path, folder: &str, name: &str) -> Result<Item, Vec<Problem>> {
  let root = dir(project_dir).join(folder);
  let mut problems = Vec::new();
  let files = lakehouse_files(&root, &mut problems);
  let Some(parts) = read_parts(&files, &mut problems) else {
    return Err(problems);
  };
  let key = check_platform(&parts, name, LAKEHOUSE, &mut problems);
  let metadata = parts.iter().any(|p| p.path == lakehouse::METADATA).then(|| json_part(&parts, lakehouse::METADATA, &mut problems)).flatten();
  let manifest = parts.iter().find(|p| p.path == lakehouse::MANIFEST).map(|p| p.bytes.as_slice());
  let definition = lakehouse::read(&root, manifest, metadata.as_ref(), &mut problems);
  for part in &parts {
    if let Ok(text) = std::str::from_utf8(&part.bytes) {
      problems.extend(credentials_in(&part.path, text));
    }
  }
  if !problems.is_empty() {
    return Err(problems);
  }
  let mut hasher = Sha256::new();
  hasher.update(parts_hash(&parts).as_bytes());
  hasher.update(definition.fingerprint().as_bytes());
  Ok(Item {
    folder: folder.to_string(),
    name: name.to_string(),
    item_type: LAKEHOUSE.to_string(),
    key,
    parts,
    hash: hex::encode(hasher.finalize()),
    model: tmdl::Model::default(),
    lakehouse: Some(definition),
    advisory: Vec::new(),
  })
}

/* ---------------------------------- state --------------------------------- */

/// A Fabric workspace, by id and the name it had when Fabricator last saw it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
  pub id: String,
  pub name: String,
}

/// A supporting item Fabricator created in Fabric.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppliedItem {
  pub item_id: String,
  #[serde(rename = "type")]
  pub item_type: String,
  pub display_name: String,
  /// Its folder in [`DIR`].
  pub folder: String,
  /// When it was last created or changed (RFC 3339).
  pub applied_at: String,
  /// [`parts_hash`] of the definition last applied.
  pub local_hash: String,
  /// [`model_hash`] of the model Fabric held right after, when it could be read.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub fabric_hash: Option<String>,
  /// A lakehouse's OneLake address: `https://onelake.dfs.fabric.microsoft.com/<workspace id>/<item id>`,
  /// on the host Fabric gave for the organization.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub one_lake: Option<String>,
  /// The tables Fabricator loaded into a lakehouse, by name.
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub tables: BTreeMap<String, lakehouse::LoadedTable>,
}

/// An item whose creation started but whose outcome isn't known yet: the next
/// apply looks for it in Fabric before creating it again.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Creating {
  pub display_name: String,
  #[serde(rename = "type")]
  pub item_type: String,
  pub started_at: String,
}

fn version_one() -> u32 {
  1
}

/// What [`STATE_FILE`] holds: where an app's supporting items are and which
/// Fabric item each folder became. Committed with the app, so a copy of it
/// elsewhere knows its items, as `rayfin.yml` holds its connectors' ids.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppliedState {
  #[serde(default = "version_one")]
  pub version: u32,
  /// The workspace the app's supporting items are in.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workspace: Option<Workspace>,
  /// The items Fabricator created, by their folder's logical id.
  #[serde(default)]
  pub items: BTreeMap<String, AppliedItem>,
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub creating: BTreeMap<String, Creating>,
}

impl Default for AppliedState {
  fn default() -> Self {
    AppliedState { version: 1, workspace: None, items: BTreeMap::new(), creating: BTreeMap::new() }
  }
}

fn state_path(project_dir: &Path) -> PathBuf {
  dir(project_dir).join(STATE_FILE)
}

/// An app's [`AppliedState`]: empty when it has none. An `Err` when the file is
/// there but can't be read, which Fabricator won't guess around.
pub fn load_state(project_dir: &Path) -> Result<AppliedState, String> {
  match std::fs::read_to_string(state_path(project_dir)) {
    Ok(text) => serde_json::from_str(text.trim_start_matches('\u{feff}'))
      .map_err(|e| format!("{DIR}/{STATE_FILE} can't be read ({e}). Fabricator writes that file; restore it from git.")),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AppliedState::default()),
    Err(e) => Err(format!("{DIR}/{STATE_FILE} can't be read ({e}).")),
  }
}

/// Save an app's [`AppliedState`], and the folder's README when it has none.
pub fn save_state(project_dir: &Path, state: &AppliedState) -> std::io::Result<()> {
  let folder = dir(project_dir);
  std::fs::create_dir_all(&folder)?;
  ensure_readme(project_dir);
  let mut text = serde_json::to_string_pretty(state).map_err(std::io::Error::other)?;
  text.push('\n');
  let temp = folder.join(format!(".{STATE_FILE}.tmp"));
  std::fs::write(&temp, text)?;
  std::fs::rename(&temp, state_path(project_dir))
}

/// What the supporting items folder is, for whoever opens it.
const README: &str = "# Supporting items

This folder holds the Microsoft Fabric items this app relies on that aren't part of the Rayfin app,
such as Power BI semantic models and the lakehouses their data is staged in. Copilot in Fabricator
defines each one here, in a folder of its own in Fabric's Git format: `<Name>.SemanticModel/` or
`<Name>.Lakehouse/`.

- Fabricator creates or changes them in Fabric only after you approve each change in the chat.
- Publishing the app doesn't change them: Publish deploys only the Rayfin app in `rayfin/`.
- A lakehouse's `tables.json` lists the tables Fabricator loads into it from the files in its `data/`
  folder. Those files stay out of git: once loaded, the lakehouse holds the data.
- `applied.json` records the Fabric item each folder became. Fabricator writes it, so don't edit it.

Learn more: https://spatney.github.io/rayfin-fabricator/docs/build/supporting-items
";

/// What [`GITIGNORE_FILE`] holds: lakehouses' data files stay on this computer.
const GITIGNORE: &str = "# Data files Fabricator loads into lakehouses stay out of git: the lakehouse holds the data.
*.Lakehouse/data/
";

/// Write the folder's README when it has none, and its `.gitignore` for
/// lakehouses' data files when it lacks that line.
pub fn ensure_readme(project_dir: &Path) {
  let folder = dir(project_dir);
  let path = folder.join(README_FILE);
  if !path.exists() {
    if let Err(e) = std::fs::create_dir_all(&folder).and_then(|_| std::fs::write(&path, README)) {
      log::warn!("couldn't write {DIR}/{README_FILE}: {e}");
    }
  }
  ensure_gitignore(project_dir);
}

/// Make sure [`DIR`]'s `.gitignore` keeps lakehouses' data files out of git:
/// written before Copilot copies any there, while supporting items are on.
pub fn ensure_gitignore(project_dir: &Path) {
  let folder = dir(project_dir);
  let path = folder.join(GITIGNORE_FILE);
  let current = std::fs::read_to_string(&path).unwrap_or_default();
  if current.lines().any(|line| line.trim() == "*.Lakehouse/data/") {
    return;
  }
  let text = if current.trim().is_empty() {
    GITIGNORE.to_string()
  } else {
    format!("{}\n\n{GITIGNORE}", current.trim_end())
  };
  if let Err(e) = std::fs::create_dir_all(&folder).and_then(|_| std::fs::write(&path, text)) {
    log::warn!("couldn't write {DIR}/{GITIGNORE_FILE}: {e}");
  }
}

/// Where a supporting item stands, from the app's files alone.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
  /// Defined, and not in Fabric yet.
  NotCreated,
  /// In Fabric as it's defined.
  Applied,
  /// Its definition changed since it was last applied.
  Changed,
  /// In Fabric, but its folder is gone from the app.
  Removed,
  /// Its folder can't be applied as it is.
  Unreadable,
}

/// Where `item` stands, given the app's state.
pub fn status_of(item: &Item, state: &AppliedState) -> Status {
  match state.items.get(&item.key) {
    Some(applied) if applied.local_hash == item.hash => Status::Applied,
    Some(_) => Status::Changed,
    None => Status::NotCreated,
  }
}

/* -------------------------------- workspaces ------------------------------- */

/// The workspace an app's supporting items go to: the one they're in, else the
/// one the app is published to. `None` when it has neither, and the user picks one.
pub fn target(project: &StudioProject, state: &AppliedState) -> Option<Workspace> {
  state.workspace.clone().or_else(|| publish_workspace(project))
}

/// The workspace a personal app is published to, as its deployment registry
/// records it (the active published app), else as the project remembers it.
pub fn publish_workspace(project: &StudioProject) -> Option<Workspace> {
  if project.team.is_some() {
    return None;
  }
  let friendly = project.workspace_name.clone().filter(|n| !n.trim().is_empty());
  if let Some(Some(active)) = crate::commands::deploy::registry_active(Path::new(&project.path)) {
    if let Some(id) = active.workspace_id.filter(|id| is_guid(id)) {
      return Some(Workspace { id, name: friendly.unwrap_or(active.workspace_name) });
    }
  }
  let id = project.workspace.as_deref().map(str::trim).filter(|w| is_guid(w))?;
  Some(Workspace { id: id.to_string(), name: friendly.unwrap_or_else(|| id.to_string()) })
}

/* ---------------------------------- diagram -------------------------------- */

/// A model as the semantic model diagram draws it, like one read from Fabric
/// (see `services::semantic_model`): Blueprint and the review card show a
/// supporting model before it's in Fabric this way.
pub fn to_schema(model: &tmdl::Model) -> crate::services::semantic_model::SemanticSchemaResult {
  use crate::services::semantic_model::{
    SemanticColumn, SemanticMeasure, SemanticRelationship, SemanticSchemaResult, SemanticTable,
  };
  let tables = model
    .tables
    .iter()
    .map(|t| SemanticTable {
      name: Some(t.name.clone()),
      description: t.description.clone(),
      is_hidden: t.is_hidden,
      storage_mode: t.partitions.iter().find_map(|p| p.mode.clone()),
    })
    .collect();
  let columns = model
    .tables
    .iter()
    .flat_map(|t| {
      t.columns.iter().map(move |c| SemanticColumn {
        table: Some(t.name.clone()),
        name: Some(c.name.clone()),
        data_type: c.data_type.clone(),
        is_hidden: c.is_hidden,
        is_key: c.is_key,
        data_category: c.data_category.clone(),
        format_string: c.format_string.clone(),
        display_folder: c.display_folder.clone(),
        expression: c.expression.clone(),
      })
    })
    .collect();
  let measures = model
    .tables
    .iter()
    .flat_map(|t| {
      t.measures.iter().map(move |m| SemanticMeasure {
        table: Some(t.name.clone()),
        name: Some(m.name.clone()),
        expression: m.expression.clone(),
        data_type: None,
        format_string: m.format_string.clone(),
        display_folder: m.display_folder.clone(),
        description: m.description.clone(),
        is_hidden: m.is_hidden,
      })
    })
    .collect();
  let relationships = model
    .relationships
    .iter()
    .map(|r| SemanticRelationship {
      name: Some(r.name.clone()),
      from_table: Some(r.from_table.clone()),
      from_column: Some(r.from_column.clone()),
      from_cardinality: Some(r.from_cardinality.clone().unwrap_or_else(|| "many".into())),
      to_table: Some(r.to_table.clone()),
      to_column: Some(r.to_column.clone()),
      to_cardinality: Some(r.to_cardinality.clone().unwrap_or_else(|| "one".into())),
      is_active: r.is_active,
      cross_filter: Some(r.cross_filtering_behavior.clone().unwrap_or_else(|| "oneDirection".into())),
    })
    .collect();
  SemanticSchemaResult {
    ok: true,
    matched: !model.tables.is_empty(),
    tables,
    columns,
    measures,
    relationships,
    ..Default::default()
  }
}

/* ------------------------------ Fabric addresses ----------------------------- */

/// The Fabric item's description, which says what it's for wherever people
/// find it in Fabric. Fabric keeps at most 256 characters.
pub fn description(app: &str, folder: &str) -> String {
  let tail = format!(", managed in Fabricator from {DIR}/{folder}.");
  let budget = 256usize.saturating_sub("Supporting item for the Rayfin app \"\"".len() + tail.chars().count());
  let app: String = if app.chars().count() > budget {
    let mut cut: String = app.chars().take(budget.saturating_sub(1)).collect();
    cut.push('…');
    cut
  } else {
    app.to_string()
  };
  format!("Supporting item for the Rayfin app \"{app}\"{tail}").chars().take(256).collect()
}

/// The semantic model in the Power BI service.
pub fn item_url(workspace_id: &str, item_id: &str) -> String {
  format!("https://app.powerbi.com/groups/{workspace_id}/datasets/{item_id}/details")
}

/// The item in Fabric, by its type.
pub fn item_url_of(item_type: &str, workspace_id: &str, item_id: &str) -> String {
  if item_type == LAKEHOUSE {
    format!("https://app.fabric.microsoft.com/groups/{workspace_id}/lakehouses/{item_id}")
  } else {
    item_url(workspace_id, item_id)
  }
}

/// A lakehouse's OneLake address for a Direct Lake model's expression, on the
/// host every organization's OneLake answers on.
pub fn one_lake_url(workspace_id: &str, item_id: &str) -> String {
  format!("https://onelake.dfs.fabric.microsoft.com/{workspace_id}/{item_id}")
}

/// The semantic model's settings, where its data source credentials are set.
pub fn settings_url(workspace_id: &str, item_id: &str) -> String {
  format!("https://app.powerbi.com/groups/{workspace_id}/settings/datasets/{item_id}")
}

#[cfg(test)]
mod tests;
