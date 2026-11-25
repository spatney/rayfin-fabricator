//! Lakehouse supporting items: a Fabric lakehouse the app's data is staged in,
//! with the tables Fabricator loads into it from files in the app's folder.
//!
//! `supporting-items/<Name>.Lakehouse/` holds `.platform` (type `Lakehouse`),
//! `lakehouse.metadata.json` (Fabric's Git format; a lakehouse with schemas
//! isn't supported, since Fabric can't load tables into one yet) and
//! [`MANIFEST`], Fabricator's own: each table and the CSV or Parquet file, or
//! folder of files, under the item's [`DATA_DIR`] it's loaded from. Applying it
//! uploads those files to the lakehouse's Files (at the same path) and loads
//! each table from them, replacing what the table held. The data files stay out
//! of git (see [`super::GITIGNORE`]): once loaded, the lakehouse holds the data.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::Problem;

/// The item type, as `.platform` and the folder's name say it.
pub const LAKEHOUSE: &str = "Lakehouse";
/// Fabricator's list of the tables to load, in the item's folder.
pub const MANIFEST: &str = "tables.json";
/// Fabric's own metadata file for a lakehouse.
pub const METADATA: &str = "lakehouse.metadata.json";
/// Where the data files are, in the item's folder.
pub const DATA_DIR: &str = "data";

/// The most files one table may load from a folder.
const MAX_TABLE_FILES: usize = 500;
/// The largest data file Fabricator uploads.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Rows are counted in CSV files up to this size; larger ones are too slow to count.
const COUNT_ROWS_UP_TO: u64 = 256 * 1024 * 1024;
/// The most bytes read to find a CSV file's header.
const HEADER_BYTES: usize = 64 * 1024;

/// A data file's format.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Format {
  Csv,
  Parquet,
}

impl Format {
  fn of_extension(path: &str) -> Option<Format> {
    let lower = path.to_lowercase();
    if lower.ends_with(".csv") || lower.ends_with(".tsv") || lower.ends_with(".txt") {
      Some(Format::Csv)
    } else if lower.ends_with(".parquet") {
      Some(Format::Parquet)
    } else {
      None
    }
  }

  /// As Fabric's Load Table API names it.
  pub fn wire(self) -> &'static str {
    match self {
      Format::Csv => "Csv",
      Format::Parquet => "Parquet",
    }
  }
}

/// One file a table loads from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataFile {
  /// Its path in the item's folder, with `/`: `data/orders.csv`.
  pub rel: String,
  pub path: PathBuf,
  pub bytes: u64,
  /// When it was last changed, in milliseconds since 1970.
  pub modified: u64,
}

/// A table the lakehouse loads, and where from.
#[derive(Clone, Debug, PartialEq)]
pub struct TableSource {
  pub name: String,
  /// The file or folder it loads from, in the item's folder: `data/orders.csv`.
  pub source: String,
  /// It loads every file in a folder.
  pub folder: bool,
  pub format: Format,
  /// A CSV file's first line names its columns.
  pub header: bool,
  pub delimiter: char,
  pub files: Vec<DataFile>,
  /// A CSV file's column names, from its header.
  pub columns: Vec<String>,
  /// A CSV file's rows, not counting the header, when they were counted.
  pub rows: Option<u64>,
}

impl TableSource {
  pub fn bytes(&self) -> u64 {
    self.files.iter().map(|f| f.bytes).sum()
  }
}

/// A lakehouse's definition: the tables it loads.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Definition {
  pub tables: Vec<TableSource>,
}

impl Definition {
  /// A fingerprint of the data files, for the item's hash: which files, their
  /// sizes and when they changed.
  pub fn fingerprint(&self) -> String {
    let mut text = String::new();
    for table in &self.tables {
      for file in &table.files {
        text.push_str(&format!("{}\u{0}{}\u{0}{}\u{0}{}\n", table.name, file.rel, file.bytes, file.modified));
      }
    }
    text
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestTable {
  name: String,
  file: String,
  #[serde(default)]
  format: Option<String>,
  #[serde(default)]
  header: Option<bool>,
  #[serde(default)]
  delimiter: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
  #[serde(default)]
  tables: Vec<ManifestTable>,
}

/// A table name Fabric's Load Table API takes: letters, digits and underscores.
pub fn valid_table_name(name: &str) -> bool {
  static NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$").unwrap());
  NAME.is_match(name)
}

/// `file` as a path in the item's folder, when it's one under [`DATA_DIR`]:
/// relative, with no `..`, drive or root.
fn data_path(file: &str) -> Option<String> {
  let normalized = file.trim().replace('\\', "/");
  let trimmed = normalized.trim_end_matches('/');
  if trimmed.is_empty() || trimmed.starts_with('/') || trimmed.contains(':') {
    return None;
  }
  let path = Path::new(trimmed);
  if !path.components().all(|c| matches!(c, Component::Normal(_))) {
    return None;
  }
  let first = trimmed.split('/').next()?;
  (first == DATA_DIR && trimmed.len() > DATA_DIR.len()).then(|| trimmed.to_string())
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
  meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// The files under `dir` (relative to the item's folder as `rel`), by path, leaving out
/// hidden ones; `None` when one is a link.
fn files_under(dir: &Path, rel: &str) -> Option<Vec<DataFile>> {
  let mut files = Vec::new();
  let mut stack = vec![(dir.to_path_buf(), rel.to_string())];
  while let Some((dir, rel)) = stack.pop() {
    let Ok(entries) = std::fs::read_dir(&dir) else { continue };
    for entry in entries.flatten() {
      let Ok(name) = entry.file_name().into_string() else { continue };
      if name.starts_with('.') || name.starts_with('_') {
        continue;
      }
      let child = format!("{rel}/{name}");
      let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
      if meta.file_type().is_symlink() {
        return None;
      }
      if meta.is_dir() {
        stack.push((entry.path(), child));
      } else if meta.is_file() {
        files.push(DataFile { rel: child, path: entry.path(), bytes: meta.len(), modified: modified_ms(&meta) });
      }
    }
  }
  files.sort_by(|a, b| a.rel.cmp(&b.rel));
  Some(files)
}

/// A CSV line's fields, unquoting `"…"` with `""` inside.
pub fn csv_fields(line: &str, delimiter: char) -> Vec<String> {
  let mut fields = Vec::new();
  let mut field = String::new();
  let mut quoted = false;
  let mut chars = line.chars().peekable();
  while let Some(c) = chars.next() {
    if quoted {
      if c == '"' {
        if chars.peek() == Some(&'"') {
          field.push('"');
          chars.next();
        } else {
          quoted = false;
        }
      } else {
        field.push(c);
      }
    } else if c == '"' && field.trim().is_empty() {
      field.clear();
      quoted = true;
    } else if c == delimiter {
      fields.push(field.trim().to_string());
      field = String::new();
    } else {
      field.push(c);
    }
  }
  fields.push(field.trim().to_string());
  fields
}

/// A CSV file's first line, without a byte order mark or line ending.
fn first_line(path: &Path) -> Option<String> {
  let mut buffer = vec![0u8; HEADER_BYTES];
  let mut file = std::fs::File::open(path).ok()?;
  let read = file.read(&mut buffer).ok()?;
  let text = String::from_utf8_lossy(&buffer[..read]);
  let text = text.trim_start_matches('\u{feff}');
  let line = text.split('\n').next()?.trim_end_matches('\r');
  (!line.trim().is_empty()).then(|| line.to_string())
}

/// A CSV file's lines, counting a last line without a line ending.
fn count_lines(path: &Path) -> Option<u64> {
  let mut file = std::fs::File::open(path).ok()?;
  let mut buffer = vec![0u8; 1 << 20];
  let mut lines = 0u64;
  let mut last = b'\n';
  let mut any = false;
  loop {
    let read = file.read(&mut buffer).ok()?;
    if read == 0 {
      break;
    }
    any = true;
    lines += buffer[..read].iter().filter(|&&b| b == b'\n').count() as u64;
    last = buffer[read - 1];
  }
  Some(if any && last != b'\n' { lines + 1 } else { lines })
}

/// Read and check a lakehouse's [`MANIFEST`] and the data files it names, in
/// `root` (the item's folder). Problems are added to `problems`.
pub fn read(root: &Path, manifest: Option<&[u8]>, metadata: Option<&serde_json::Value>, problems: &mut Vec<Problem>) -> Definition {
  if metadata.and_then(|m| m.get("defaultSchema")).is_some_and(|s| !s.is_null()) {
    problems.push(Problem::new("lakehouse-schemas").in_file(METADATA));
  }
  let Some(manifest) = manifest else {
    return Definition::default();
  };
  let parsed: Manifest = match serde_json::from_slice(strip_bom(manifest)) {
    Ok(parsed) => parsed,
    Err(e) => {
      problems.push(Problem::new("bad-json").in_file(MANIFEST).with_detail(e.to_string()));
      return Definition::default();
    }
  };
  let mut seen = HashSet::new();
  let mut tables = Vec::new();
  for entry in parsed.tables {
    let name = entry.name.trim().to_string();
    if !valid_table_name(&name) {
      problems.push(Problem::new("bad-table-name").in_file(MANIFEST).with_detail(name.clone()));
      continue;
    }
    if !seen.insert(name.to_lowercase()) {
      problems.push(Problem { table: Some(name), ..Problem::new("duplicate-table") });
      continue;
    }
    let Some(source) = data_path(&entry.file) else {
      problems.push(Problem { table: Some(name), ..Problem::new("bad-data-path").with_detail(entry.file.clone()) });
      continue;
    };
    let path = root.join(&source);
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
      problems.push(Problem { table: Some(name), ..Problem::new("missing-data").with_detail(source) });
      continue;
    };
    if meta.file_type().is_symlink() {
      problems.push(Problem::new("link").in_file(&source));
      continue;
    }
    let folder = meta.is_dir();
    let files = if folder {
      match files_under(&path, &source) {
        Some(files) => files,
        None => {
          problems.push(Problem::new("link").in_file(&source));
          continue;
        }
      }
    } else {
      vec![DataFile { rel: source.clone(), path: path.clone(), bytes: meta.len(), modified: modified_ms(&meta) }]
    };
    if files.is_empty() {
      problems.push(Problem { table: Some(name), ..Problem::new("empty-data").with_detail(source) });
      continue;
    }
    if files.len() > MAX_TABLE_FILES {
      problems.push(Problem {
        table: Some(name),
        ..Problem::new("data-too-large").with_detail(format!("{} files in {source}, at most {MAX_TABLE_FILES}", files.len()))
      });
      continue;
    }
    if let Some(big) = files.iter().find(|f| f.bytes > MAX_FILE_BYTES) {
      problems.push(Problem {
        table: Some(name),
        ..Problem::new("data-too-large").with_detail(format!("{} is {} MB, at most {} MB", big.rel, big.bytes >> 20, MAX_FILE_BYTES >> 20))
      });
      continue;
    }
    let format = match entry.format.as_deref().map(|f| f.trim().to_lowercase()) {
      Some(f) if f == "csv" => Some(Format::Csv),
      Some(f) if f == "parquet" => Some(Format::Parquet),
      Some(other) => {
        problems.push(Problem { table: Some(name), ..Problem::new("bad-format").with_detail(other) });
        continue;
      }
      None => {
        let kinds: HashSet<Option<Format>> = files.iter().map(|f| Format::of_extension(&f.rel)).collect();
        match kinds.into_iter().collect::<Vec<_>>().as_slice() {
          [Some(format)] => Some(*format),
          _ => None,
        }
      }
    };
    let Some(format) = format else {
      problems.push(Problem { table: Some(name), ..Problem::new("bad-format").with_detail(source) });
      continue;
    };
    let delimiter = match entry.delimiter.as_deref() {
      None => {
        if source.to_lowercase().ends_with(".tsv") {
          '\t'
        } else {
          ','
        }
      }
      Some("\\t") | Some("\t") => '\t',
      Some(d) if d.chars().count() == 1 => d.chars().next().unwrap_or(','),
      Some(d) => {
        problems.push(Problem { table: Some(name), ..Problem::new("bad-delimiter").with_detail(d.to_string()) });
        continue;
      }
    };
    let header = entry.header.unwrap_or(true);
    let (columns, rows) = if format == Format::Csv {
      let first = &files[0];
      let columns = match first_line(&first.path) {
        Some(line) if header => csv_fields(&line, delimiter),
        Some(line) => (1..=csv_fields(&line, delimiter).len()).map(|i| format!("_c{}", i - 1)).collect(),
        None => Vec::new(),
      };
      let rows = if files.iter().all(|f| f.bytes <= COUNT_ROWS_UP_TO) {
        files
          .iter()
          .map(|f| count_lines(&f.path).map(|lines| if header { lines.saturating_sub(1) } else { lines }))
          .sum::<Option<u64>>()
      } else {
        None
      };
      (columns, rows)
    } else {
      (Vec::new(), None)
    };
    tables.push(TableSource { name, source, folder, format, header, delimiter, files, columns, rows });
  }
  Definition { tables }
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
  bytes.strip_prefix(b"\xEF\xBB\xBF".as_slice()).unwrap_or(bytes)
}

/* --------------------------------- loads --------------------------------- */

/// A file Fabricator uploaded for a table: what it was, to tell when it changes.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedFile {
  /// Its path in the item's folder: `data/orders.csv`.
  pub path: String,
  pub bytes: u64,
  pub modified: u64,
  pub sha256: String,
}

/// A column of a loaded table, as its Delta table has it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableColumn {
  pub name: String,
  /// The Delta type: `string`, `long`, `double`, `timestamp`…
  #[serde(rename = "type")]
  pub data_type: String,
}

/// A table Fabricator loaded into a lakehouse.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedTable {
  /// The file or folder it loaded from, in the item's folder.
  pub source: String,
  pub files: Vec<LoadedFile>,
  /// How it was read: `csv;header;,` or `parquet`.
  pub options: String,
  pub loaded_at: String,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub columns: Vec<TableColumn>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub rows: Option<u64>,
}

/// How a table's source is read, to tell when that changes.
pub fn options_of(table: &TableSource) -> String {
  match table.format {
    Format::Csv => format!("csv;{};{}", if table.header { "header" } else { "noheader" }, table.delimiter),
    Format::Parquet => "parquet".into(),
  }
}

/// A file's SHA-256, in hex.
pub fn sha256_of(path: &Path) -> std::io::Result<String> {
  use sha2::{Digest, Sha256};
  let mut file = std::fs::File::open(path)?;
  let mut hasher = Sha256::new();
  let mut buffer = vec![0u8; 1 << 20];
  loop {
    let read = file.read(&mut buffer)?;
    if read == 0 {
      break;
    }
    hasher.update(&buffer[..read]);
  }
  Ok(hex::encode(hasher.finalize()))
}

/// Whether `table` would load the same data as `loaded` did: the same files,
/// with the same contents, read the same way. A file whose size and time are
/// the same is taken to be the same; else its contents are compared.
pub fn same_as_loaded(table: &TableSource, loaded: &LoadedTable) -> bool {
  if loaded.source != table.source || loaded.options != options_of(table) || loaded.files.len() != table.files.len() {
    return false;
  }
  table.files.iter().zip(&loaded.files).all(|(file, was)| {
    file.rel == was.path
      && file.bytes == was.bytes
      && (file.modified == was.modified || sha256_of(&file.path).is_ok_and(|sha| sha == was.sha256))
  })
}

/// A Delta column type as the TMDL `dataType` a Direct Lake model gives it.
pub fn tmdl_type(delta: &str) -> &'static str {
  let lower = delta.to_lowercase();
  match lower.split('(').next().unwrap_or_default() {
    "string" | "varchar" | "char" => "string",
    "long" | "integer" | "int" | "short" | "byte" | "bigint" | "smallint" | "tinyint" => "int64",
    "double" | "float" | "real" => "double",
    "decimal" => "decimal",
    "boolean" => "boolean",
    "timestamp" | "timestamp_ntz" | "date" => "dateTime",
    "binary" => "binary",
    _ => "string",
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fab-lakehouse-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(DATA_DIR)).unwrap();
    dir
  }

  fn codes(problems: &[Problem]) -> Vec<&str> {
    problems.iter().map(|p| p.code.as_str()).collect()
  }

  #[test]
  fn tables_load_from_csv_and_parquet_files_under_data() {
    let root = temp();
    std::fs::write(root.join("data/orders.csv"), "\u{feff}OrderId,\"Region, area\",Amount\r\n1,West,2.5\r\n2,\"East, \"\"far\"\"\",3\r\n").unwrap();
    std::fs::create_dir_all(root.join("data/events")).unwrap();
    std::fs::write(root.join("data/events/a.parquet"), b"PAR1").unwrap();
    std::fs::write(root.join("data/events/b.parquet"), b"PAR1").unwrap();
    std::fs::write(root.join("data/events/_SUCCESS"), b"").unwrap();
    let manifest = br#"{"tables":[{"name":"orders","file":"data/orders.csv"},{"name":"events","file":"data\\events\\"}]}"#;
    let mut problems = Vec::new();
    let definition = read(&root, Some(manifest), None, &mut problems);
    assert!(problems.is_empty(), "{problems:?}");
    let orders = &definition.tables[0];
    assert_eq!((orders.format, orders.folder, orders.delimiter), (Format::Csv, false, ','));
    assert_eq!(orders.columns, ["OrderId", "Region, area", "Amount"]);
    assert_eq!(orders.rows, Some(2));
    let events = &definition.tables[1];
    assert_eq!((events.source.as_str(), events.format, events.folder), ("data/events", Format::Parquet, true));
    assert_eq!(events.files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), ["data/events/a.parquet", "data/events/b.parquet"]);
    assert!(definition.fingerprint().contains("data/orders.csv"));
    std::fs::remove_dir_all(root).ok();
  }

  #[test]
  fn a_manifest_names_valid_tables_and_files_inside_data() {
    let root = temp();
    std::fs::write(root.join("data/a.csv"), "x\n1\n").unwrap();
    std::fs::write(root.join("data/notes.xlsx"), "x").unwrap();
    let manifest = br#"{"tables":[
      {"name":"bad name","file":"data/a.csv"},
      {"name":"a","file":"data/a.csv"},
      {"name":"A","file":"data/a.csv"},
      {"name":"up","file":"../secrets.csv"},
      {"name":"outside","file":"a.csv"},
      {"name":"absolute","file":"C:/data/a.csv"},
      {"name":"gone","file":"data/gone.csv"},
      {"name":"excel","file":"data/notes.xlsx"},
      {"name":"semicolons","file":"data/a.csv","delimiter":";;"}
    ]}"#;
    let mut problems = Vec::new();
    let definition = read(&root, Some(manifest), Some(&serde_json::json!({ "defaultSchema": "dbo" })), &mut problems);
    assert_eq!(definition.tables.len(), 1);
    assert_eq!(
      codes(&problems),
      [
        "lakehouse-schemas",
        "bad-table-name",
        "duplicate-table",
        "bad-data-path",
        "bad-data-path",
        "bad-data-path",
        "missing-data",
        "bad-format",
        "bad-delimiter"
      ]
    );
    std::fs::remove_dir_all(root).ok();
  }

  #[test]
  fn without_a_manifest_a_lakehouse_loads_no_tables() {
    let mut problems = Vec::new();
    assert_eq!(read(Path::new("."), None, Some(&serde_json::json!({})), &mut problems), Definition::default());
    assert!(problems.is_empty());
    read(Path::new("."), Some(b"{ not json"), None, &mut problems);
    assert_eq!(codes(&problems), ["bad-json"]);
  }

  #[test]
  fn a_table_is_loaded_again_only_when_its_data_or_how_it_is_read_changes() {
    let root = temp();
    std::fs::write(root.join("data/a.csv"), "x\n1\n").unwrap();
    let mut problems = Vec::new();
    let table = read(&root, Some(br#"{"tables":[{"name":"a","file":"data/a.csv"}]}"#), None, &mut problems).tables.remove(0);
    let file = &table.files[0];
    let loaded = LoadedTable {
      source: "data/a.csv".into(),
      files: vec![LoadedFile { path: file.rel.clone(), bytes: file.bytes, modified: file.modified, sha256: sha256_of(&file.path).unwrap() }],
      options: options_of(&table),
      ..Default::default()
    };
    assert!(same_as_loaded(&table, &loaded));
    // Touched, with the same contents: still the same.
    let touched = LoadedTable { files: vec![LoadedFile { modified: 1, ..loaded.files[0].clone() }], ..loaded.clone() };
    assert!(same_as_loaded(&table, &touched));
    let changed = LoadedTable { files: vec![LoadedFile { modified: 1, sha256: "0".into(), ..loaded.files[0].clone() }], ..loaded.clone() };
    assert!(!same_as_loaded(&table, &changed));
    let read_otherwise = LoadedTable { options: "csv;noheader;,".into(), ..loaded };
    assert!(!same_as_loaded(&table, &read_otherwise));
    std::fs::remove_dir_all(root).ok();
  }

  #[test]
  fn delta_types_become_tmdl_data_types() {
    assert_eq!(tmdl_type("string"), "string");
    assert_eq!(tmdl_type("long"), "int64");
    assert_eq!(tmdl_type("integer"), "int64");
    assert_eq!(tmdl_type("double"), "double");
    assert_eq!(tmdl_type("decimal(18,2)"), "decimal");
    assert_eq!(tmdl_type("timestamp"), "dateTime");
    assert_eq!(tmdl_type("date"), "dateTime");
    assert_eq!(tmdl_type("boolean"), "boolean");
  }

  #[test]
  fn csv_fields_are_unquoted() {
    assert_eq!(csv_fields("a,\"b,c\",\"d \"\"e\"\"\", f ", ','), ["a", "b,c", "d \"e\"", "f"]);
    assert_eq!(csv_fields("a\tb", '\t'), ["a", "b"]);
  }
}
