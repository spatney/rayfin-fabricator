//! What Fabricator tells the user about a semantic model before creating or
//! changing it in Fabric: a summary, the data sources its M reads, what changes
//! compared with the model in Fabric, and checks.

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ops::Range;

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::tmdl::{Column, Measure, Model, NamedExpression, Partition, Relationship, Role, Table};

/// What the review card says about a model at a glance.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
  pub tables: usize,
  pub columns: usize,
  pub measures: usize,
  pub relationships: usize,
  /// `import`, `directQuery`, `directLake`, `dual`, `mixed`, or `None` without partitions.
  pub storage: Option<String>,
  pub sources: Vec<Source>,
}

/// A data source the model's M reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
  /// What it is: `Snowflake`, `SQL Server`, `Azure SQL`, `Fabric Lakehouse`, `Fabric Warehouse`,
  /// `Databricks`, `PostgreSQL`, `Oracle`, `MySQL`, `OData`, `Web`, `SharePoint`, `Excel`, `CSV`,
  /// `Folder`, `File`, `Entered data` (values held in the model), `Other`.
  pub kind: String,
  /// The M function, e.g. `Snowflake.Databases`.
  pub function: String,
  /// Its first arguments resolved to text where possible (string literals, or parameter
  /// expressions' values), e.g. `["xy.snowflakecomputing.com", "COMPUTE_WH"]`.
  pub args: Vec<String>,
  /// Reads a file or folder on a computer (File.Contents, Folder.Files, a local path or UNC path),
  /// which Fabric can only refresh through a gateway.
  pub local: bool,
  /// The app's supporting item it reads, by name: a lakehouse a Direct Lake model is over.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub item: Option<String>,
}

/// The id of the Fabric item a OneLake URL points to: its second path segment
/// (`https://onelake.dfs.fabric.microsoft.com/<workspace>/<item>`), lowercase.
pub fn one_lake_item(url: &str) -> Option<String> {
  let lower = url.trim().to_lowercase();
  let rest = lower.split_once("onelake.dfs.fabric.microsoft.com/").or_else(|| lower.split_once("onelake.blob.fabric.microsoft.com/"))?.1;
  let item = rest.split('/').nth(1)?.split(['?', '#']).next()?;
  (!item.is_empty()).then(|| item.trim_end_matches(".lakehouse").to_string())
}

/// Name the sources that read one of the app's supporting lakehouses: `lakehouses`
/// are their (item id, name) pairs.
pub fn name_items(sources: &mut [Source], lakehouses: &[(String, String)]) {
  for source in sources.iter_mut() {
    let Some(item) = source.args.first().and_then(|url| one_lake_item(url)) else { continue };
    if let Some((_, name)) = lakehouses.iter().find(|(id, _)| id.eq_ignore_ascii_case(&item)) {
      source.item = Some(name.clone());
    }
  }
}

/// What a model holds and reads, at a glance.
pub fn summary(model: &Model) -> Summary {
  Summary {
    tables: model.tables.len(),
    columns: model.tables.iter().map(|t| t.columns.len()).sum(),
    measures: model.tables.iter().map(|t| t.measures.len()).sum(),
    relationships: model.relationships.len(),
    storage: storage(model),
    sources: sources(model),
  }
}

/// Data sources, deduplicated (same function + args), in first-seen order, from partition sources
/// (M) and then shared expressions. Identifier arguments that name a parameter expression (including
/// `#"Quoted Name"` identifiers) resolve to the parameter's value. Pure M library functions
/// (`Table.*`, `List.*`, `Json.Document`, …) aren't sources; a parser wrapped around a file or web
/// read (`Excel.Workbook(File.Contents(...))`, `Csv.Document(...)`) is reported once, as the parser
/// with the read's arguments. M that reads nothing but holds its own values (`#table(...)`, or
/// Power BI's Enter data) is reported once as `Entered data`, function `#table`.
pub fn sources(model: &Model) -> Vec<Source> {
  let values = parameter_values(model);
  let partitions =
    model.tables.iter().flat_map(|t| &t.partitions).filter(|p| is_m(p)).filter_map(|p| p.source.as_deref());
  let shared = model.expressions.iter().filter(|e| !e.is_parameter).map(|e| e.expression.as_str());
  let mut found: Vec<Source> = Vec::new();
  for m in partitions.chain(shared) {
    let mut read = m_sources(m, &values);
    if read.is_empty() && entered_data(m) {
      read.push(Source { kind: "Entered data".into(), function: "#table".into(), args: Vec::new(), local: false, item: None });
    }
    for source in read {
      if !found.iter().any(|s| s.function == source.function && s.args == source.args) {
        found.push(source);
      }
    }
  }
  found
}

/// Whether M holds its own values: a `#table` literal, or Power BI's Enter data
/// (`Table.FromRows(Json.Document(Binary.Decompress(Binary.FromText(…))))`).
fn entered_data(m: &str) -> bool {
  let compact: String = m.chars().filter(|c| !c.is_whitespace()).collect();
  ["#table(", "Table.FromRows(", "Table.FromRecords(", "Binary.FromText("].iter().any(|f| compact.contains(f))
}

/// Whether a change adds, removes or changes an object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeOp {
  Added,
  Removed,
  Changed,
}

/// The type of object a change is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
  Model,
  Table,
  Column,
  Measure,
  Partition,
  Relationship,
  Expression,
  Role,
}

/// One difference between two versions of a model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
  pub op: ChangeOp,
  pub kind: ChangeKind,
  /// The table a column, measure or partition belongs to.
  pub table: Option<String>,
  /// The object's name; for a relationship, `From[Col] → To[Col]` (e.g. `Sales[CustomerKey] → Customer[CustomerKey]`).
  pub name: String,
  /// For `Changed`: what changed, as property names in camelCase, e.g. `["dataType", "expression"]`.
  pub fields: Vec<String>,
}

/// What changes going from `old` (the model in Fabric) to `new` (the files in the repo). Only
/// material properties count, so a serialization difference (property order, lineageTag,
/// annotations, whitespace inside expressions, default values written out or left implicit) is not
/// a change. Tables match by name case-insensitively; columns, measures and partitions by
/// (table, name) case-insensitively; relationships by their endpoints (from table/column, to
/// table/column, case-insensitive), never by their name (often a generated GUID); expressions and
/// roles by name, case-insensitively. Material properties: table isHidden and description (its
/// words; line breaks and spacing don't count); column dataType, isKey, isHidden, sourceColumn,
/// expression, formatString, sortByColumn; measure expression, formatString, isHidden,
/// displayFolder; partition mode (unset or `default` counts as `import`), kind, source,
/// expressionSource; relationship cardinalities (defaults: from many, to one),
/// crossFilteringBehavior (default oneDirection), isActive; expression text; role modelPermission
/// (default none) and tablePermissions; model culture and compatibilityLevel (kind `Model`, name
/// `model`). Enumerations (dataType, mode, cardinalities…) and references (sortByColumn,
/// expressionSource) compare case-insensitively. Expressions compare with whitespace normalized:
/// each line trimmed, blank lines dropped, runs of spaces and tabs outside quotes collapsed to one
/// space. Changes are ordered by kind (as listed in [`ChangeKind`]), then table, then name. The
/// columns, measures and partitions of an added or removed table aren't listed separately.
pub fn diff(old: &Model, new: &Model) -> Vec<Change> {
  let mut changes = Vec::new();
  let fields = changed(&model_fields(old), &model_fields(new));
  if !fields.is_empty() {
    changes.push(Change { fields, ..simple(ChangeOp::Changed, ChangeKind::Model, None, "model") });
  }

  let old_tables = by_name(&old.tables, |t| &t.name);
  let new_tables = by_name(&new.tables, |t| &t.name);
  for (key, table) in &old_tables {
    if !new_tables.contains_key(key) {
      changes.push(simple(ChangeOp::Removed, ChangeKind::Table, None, &table.name));
    }
  }
  for (key, new_table) in &new_tables {
    let Some(old_table) = old_tables.get(key) else {
      changes.push(simple(ChangeOp::Added, ChangeKind::Table, None, &new_table.name));
      continue;
    };
    let fields = changed(&table_fields(old_table), &table_fields(new_table));
    if !fields.is_empty() {
      changes.push(Change { fields, ..simple(ChangeOp::Changed, ChangeKind::Table, None, &new_table.name) });
    }
    let table = Some(new_table.name.as_str());
    let columns = (&old_table.columns[..], &new_table.columns[..]);
    diff_named(&mut changes, ChangeKind::Column, table, columns, |c| &c.name, column_fields);
    let measures = (&old_table.measures[..], &new_table.measures[..]);
    diff_named(&mut changes, ChangeKind::Measure, table, measures, |m| &m.name, measure_fields);
    let partitions = (&old_table.partitions[..], &new_table.partitions[..]);
    diff_named(&mut changes, ChangeKind::Partition, table, partitions, |p| &p.name, partition_fields);
  }

  type Pairs<'a> = (Vec<&'a Relationship>, Vec<&'a Relationship>);
  let mut relationships: BTreeMap<_, Pairs> = BTreeMap::new();
  for r in &old.relationships {
    relationships.entry(relationship_key(r)).or_default().0.push(r);
  }
  for r in &new.relationships {
    relationships.entry(relationship_key(r)).or_default().1.push(r);
  }
  for (old_list, new_list) in relationships.values() {
    for i in 0..old_list.len().max(new_list.len()) {
      match (old_list.get(i), new_list.get(i)) {
        (Some(old), Some(new)) => {
          let fields = changed(&relationship_fields(old), &relationship_fields(new));
          if !fields.is_empty() {
            changes
              .push(Change { fields, ..simple(ChangeOp::Changed, ChangeKind::Relationship, None, &endpoints(new)) });
          }
        }
        (Some(old), None) => changes.push(simple(ChangeOp::Removed, ChangeKind::Relationship, None, &endpoints(old))),
        (None, Some(new)) => changes.push(simple(ChangeOp::Added, ChangeKind::Relationship, None, &endpoints(new))),
        (None, None) => {}
      }
    }
  }

  let expressions = (&old.expressions[..], &new.expressions[..]);
  diff_named(&mut changes, ChangeKind::Expression, None, expressions, |e| &e.name, expression_fields);
  diff_named(&mut changes, ChangeKind::Role, None, (&old.roles[..], &new.roles[..]), |r| &r.name, role_fields);

  changes.sort_by_cached_key(|c| (c.kind, c.table.as_deref().map(str::to_lowercase), c.name.to_lowercase(), c.op));
  changes
}

/// One finding about a model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
  /// What was found, such as `missing-column` or `one-side-key` (see [`checks`]).
  pub code: String,
  pub table: Option<String>,
  pub column: Option<String>,
  /// Extra context, such as the other side of a relationship (`Sales[CustomerKey]`) or a type pair.
  pub detail: Option<String>,
}

/// The codes of blocking findings, in the order they're reported.
const BLOCKING: &[&str] = &[
  "no-tables",
  "direct-lake-level",
  "duplicate-table",
  "duplicate-name",
  "duplicate-measure",
  "missing-table",
  "missing-column",
  "self-relationship",
  "duplicate-relationship",
];

/// The codes of advisory findings, in the order they're reported.
const ADVISORY: &[&str] = &[
  "one-side-key",
  "one-side-key-direct-lake",
  "type-mismatch",
  "no-partition",
  "local-source",
  "both-directions",
  "direct-lake-table",
  "direct-lake-column",
];

/// The compatibility level Direct Lake tables need.
pub const DIRECT_LAKE_LEVEL: u32 = 1604;

/// A table in one of the app's supporting lakehouses, as Fabricator loaded it.
pub struct LakeTable<'a> {
  /// The lakehouse's item id.
  pub item_id: &'a str,
  pub lakehouse: &'a str,
  pub table: &'a str,
  /// Its columns' names.
  pub columns: Vec<&'a str>,
}

/// Advisory findings about a Direct Lake model over the app's supporting
/// lakehouses (`tables`, as Fabricator loaded them): `direct-lake-table` (table,
/// column = the entity, detail = the lakehouse) for a table whose entity isn't
/// one of the lakehouse's tables, and `direct-lake-column` (table, column, detail = the
/// lakehouse table) for a column whose sourceColumn isn't in that table. Tables
/// over other sources, or a lakehouse Fabricator doesn't know the tables of, are
/// left alone.
pub fn direct_lake_checks(model: &Model, tables: &[LakeTable<'_>]) -> Vec<Check> {
  let values = parameter_values(model);
  let mut found = Vec::new();
  for table in &model.tables {
    for partition in table.partitions.iter().filter(|p| mode_name(&p.mode) == "directLake") {
      let Some(entity) = partition.source.as_deref().map(str::trim).filter(|e| !e.is_empty()) else { continue };
      let Some(expression) = partition.expression_source.as_deref() else { continue };
      let Some(named) = model.expressions.iter().find(|e| e.name.eq_ignore_ascii_case(expression)) else { continue };
      let Some(item) = m_sources(&named.expression, &values).iter().find_map(|s| s.args.first().and_then(|url| one_lake_item(url)))
      else {
        continue;
      };
      let known: Vec<&LakeTable<'_>> = tables.iter().filter(|t| t.item_id.eq_ignore_ascii_case(&item)).collect();
      let Some(first) = known.first() else { continue };
      match known.iter().find(|t| t.table.eq_ignore_ascii_case(entity)) {
        None => found.push(check("direct-lake-table", Some(&table.name), Some(entity), Some(first.lakehouse))),
        Some(lake) if !lake.columns.is_empty() => {
          for column in table.columns.iter().filter(|c| c.expression.is_none()) {
            let source = column.source_column.as_deref().unwrap_or(&column.name);
            if !lake.columns.iter().any(|c| c.eq_ignore_ascii_case(source)) {
              found.push(check("direct-lake-column", Some(&table.name), Some(source), Some(lake.table)));
            }
          }
        }
        Some(_) => {}
      }
    }
  }
  sort_checks(&mut found, ADVISORY);
  found
}

/// (blocking, advisory) findings.
///
/// Blocking: `no-tables`; `duplicate-table` (table); `duplicate-name` (table, column = a name that
/// two of the table's columns or measures share); `duplicate-measure` (table, column = a measure
/// name an earlier table also has, detail = that table); `missing-table` (table = a relationship's
/// table the model lacks, detail = the relationship's endpoints); `missing-column` (table, column,
/// detail = endpoints); `self-relationship` (from table and column, detail = endpoints);
/// `duplicate-relationship` (from table and column of a second relationship with the same
/// endpoints in the same direction, detail = endpoints).
///
/// Advisory: `one-side-key` (table and column on the "one" side of a relationship — the `to` side
/// unless cardinalities say otherwise, both sides for one-to-one, none for many-to-many — which
/// must hold unique, non-blank values or the refresh fails; detail = the other side as
/// `Table[Column]`), or `one-side-key-direct-lake` when that table is in Direct Lake mode, where
/// framing doesn't check keys and the queries that use the relationship fail instead; `type-mismatch` (from table and column, detail = `fromType → toType`) when both
/// ends have known, different data types; `no-partition` (table) for a table with no partition that
/// isn't a calculation group; `local-source` (detail = the function and its first argument) for each
/// source on a computer; `both-directions` (from table and column, detail = endpoints) for a
/// relationship that filters both ways, which can make filter paths ambiguous.
///
/// Findings are ordered by code (as listed), then table, then column.
pub fn checks(model: &Model) -> (Vec<Check>, Vec<Check>) {
  let mut blocking = Vec::new();
  let mut advisory = Vec::new();
  if model.tables.is_empty() {
    blocking.push(check("no-tables", None, None, None));
  }
  let direct_lake = model.tables.iter().flat_map(|t| &t.partitions).any(|p| mode_name(&p.mode) == "directLake");
  if direct_lake && model.compatibility_level.is_none_or(|level| level < DIRECT_LAKE_LEVEL) {
    let level = model.compatibility_level.map(|l| l.to_string()).unwrap_or_else(|| "not set".into());
    blocking.push(check("direct-lake-level", None, None, Some(&level)));
  }

  let mut tables: HashMap<String, &Table> = HashMap::new();
  let mut measure_tables: HashMap<String, &str> = HashMap::new();
  for table in &model.tables {
    match tables.entry(table.name.to_lowercase()) {
      Entry::Occupied(_) => blocking.push(check("duplicate-table", Some(&table.name), None, None)),
      Entry::Vacant(entry) => {
        entry.insert(table);
      }
    }
    let mut names = HashSet::new();
    let column_names = table.columns.iter().map(|c| &c.name);
    for name in column_names.chain(table.measures.iter().map(|m| &m.name)) {
      if !names.insert(name.to_lowercase()) {
        blocking.push(check("duplicate-name", Some(&table.name), Some(name), None));
      }
    }
    for measure in &table.measures {
      match measure_tables.get(&measure.name.to_lowercase()) {
        Some(first) if first.to_lowercase() != table.name.to_lowercase() => {
          blocking.push(check("duplicate-measure", Some(&table.name), Some(&measure.name), Some(first)));
        }
        Some(_) => {}
        None => {
          measure_tables.insert(measure.name.to_lowercase(), &table.name);
        }
      }
    }
  }

  let column = |table: &str, column: &str| -> Option<&Column> {
    let table = tables.get(&table.to_lowercase())?;
    table.columns.iter().find(|c| c.name.to_lowercase() == column.to_lowercase())
  };
  let mut seen = HashSet::new();
  for r in &model.relationships {
    let ends = endpoints(r);
    let mut valid = true;
    for (table, column_name) in [(&r.from_table, &r.from_column), (&r.to_table, &r.to_column)] {
      if !tables.contains_key(&table.to_lowercase()) {
        blocking.push(check("missing-table", Some(table), None, Some(&ends)));
        valid = false;
      } else if column(table, column_name).is_none() {
        blocking.push(check("missing-column", Some(table), Some(column_name), Some(&ends)));
        valid = false;
      }
    }
    let key = relationship_key(r);
    let from = Some(r.from_table.as_str());
    let from_column = Some(r.from_column.as_str());
    if key.0 == key.2 && key.1 == key.3 {
      blocking.push(check("self-relationship", from, from_column, Some(&ends)));
      valid = false;
    }
    if !seen.insert(key) {
      blocking.push(check("duplicate-relationship", from, from_column, Some(&ends)));
      valid = false;
    }
    if valid {
      let from_side = format!("{}[{}]", r.from_table, r.from_column);
      let to_side = format!("{}[{}]", r.to_table, r.to_column);
      let key_check = |table: &str| {
        let lake = tables
          .get(&table.to_lowercase())
          .is_some_and(|t| t.partitions.iter().any(|p| mode_name(&p.mode) == "directLake"));
        if lake { "one-side-key-direct-lake" } else { "one-side-key" }
      };
      if lower_or(&r.to_cardinality, "one") == "one" {
        advisory.push(check(key_check(&r.to_table), Some(&r.to_table), Some(&r.to_column), Some(&from_side)));
      }
      if lower_or(&r.from_cardinality, "many") == "one" {
        advisory.push(check(key_check(&r.from_table), from, from_column, Some(&to_side)));
      }
      let data_type = |table: &str, name: &str| {
        column(table, name).and_then(|c| c.data_type.as_deref()).map(str::trim).filter(|t| !t.is_empty())
      };
      let from_type = data_type(&r.from_table, &r.from_column);
      let to_type = data_type(&r.to_table, &r.to_column);
      if let (Some(from_type), Some(to_type)) = (from_type, to_type) {
        if !from_type.eq_ignore_ascii_case(to_type) {
          advisory.push(check("type-mismatch", from, from_column, Some(&format!("{from_type} → {to_type}"))));
        }
      }
    }
    if lower_or(&r.cross_filtering_behavior, "onedirection") == "bothdirections" {
      advisory.push(check("both-directions", from, from_column, Some(&ends)));
    }
  }

  for table in &model.tables {
    if table.partitions.is_empty() && !table.calculation_group {
      advisory.push(check("no-partition", Some(&table.name), None, None));
    }
  }
  for source in sources(model).iter().filter(|s| s.local) {
    let detail = match source.args.first() {
      Some(arg) => format!("{}(\"{arg}\")", source.function),
      None => source.function.clone(),
    };
    advisory.push(check("local-source", None, None, Some(&detail)));
  }

  sort_checks(&mut blocking, BLOCKING);
  sort_checks(&mut advisory, ADVISORY);
  (blocking, advisory)
}

/// A canonical JSON form of the model's material properties (as in [`diff`]), with every list
/// sorted (by lowercased name; names keep their case in the output), defaults applied
/// (relationship cardinalities, crossFilteringBehavior oneDirection, isActive true) and
/// expressions whitespace-normalized as in [`diff`]. Two models that [`diff`] finds no changes
/// between produce identical strings, unless names differ only in case (which [`diff`] ignores).
/// Fabricator hashes it to notice when the model in Fabric was changed outside Fabricator.
pub fn canonical(model: &Model) -> String {
  let mut tables: Vec<Value> = model
    .tables
    .iter()
    .map(|t| {
      let mut table = named(&t.name, table_fields(t));
      table.insert("columns".into(), sorted_objects(&t.columns, |c| &c.name, column_fields));
      table.insert("measures".into(), sorted_objects(&t.measures, |m| &m.name, measure_fields));
      table.insert("partitions".into(), sorted_objects(&t.partitions, |p| &p.name, partition_fields));
      Value::Object(table)
    })
    .collect();
  sort_values(&mut tables);

  let mut relationships: Vec<(_, Value)> = model
    .relationships
    .iter()
    .map(|r| {
      let mut object = Map::new();
      object.insert("from".into(), json!(format!("{}[{}]", r.from_table, r.from_column)));
      object.insert("to".into(), json!(format!("{}[{}]", r.to_table, r.to_column)));
      object.extend(fields_object(relationship_fields(r)));
      (relationship_key(r), Value::Object(object))
    })
    .collect();
  relationships.sort_by_cached_key(|(key, value)| (key.clone(), sorted_json(value)));

  let mut root = Map::new();
  root.insert("model".into(), Value::Object(fields_object(model_fields(model))));
  root.insert("tables".into(), Value::Array(tables));
  root.insert("relationships".into(), Value::Array(relationships.into_iter().map(|(_, v)| v).collect()));
  root.insert("expressions".into(), sorted_objects(&model.expressions, |e| &e.name, expression_fields));
  root.insert("roles".into(), sorted_objects(&model.roles, |r| &r.name, role_fields));
  sorted_json(&Value::Object(root))
}

/// `value` as compact JSON with every object's keys sorted, so the text doesn't depend on the order
/// a JSON map keeps its keys in (serde_json's `preserve_order` feature).
fn sorted_json(value: &Value) -> String {
  match value {
    Value::Object(map) => {
      let mut entries: Vec<(&String, &Value)> = map.iter().collect();
      entries.sort_by(|a, b| a.0.cmp(b.0));
      let entries: Vec<String> =
        entries.into_iter().map(|(key, value)| format!("{}:{}", json!(key), sorted_json(value))).collect();
      format!("{{{}}}", entries.join(","))
    }
    Value::Array(items) => format!("[{}]", items.iter().map(sorted_json).collect::<Vec<_>>().join(",")),
    other => other.to_string(),
  }
}

/// Material properties, as (camelCase name, normalized value) pairs in a fixed order.
type Fields = Vec<(&'static str, Value)>;

fn model_fields(model: &Model) -> Fields {
  vec![("culture", lower(&model.culture)), ("compatibilityLevel", json!(model.compatibility_level))]
}

fn table_fields(table: &Table) -> Fields {
  // The TMDL serializer may wrap a long description over several `///` lines, so only words count.
  let description = table.description.as_deref().map(|d| d.split_whitespace().collect::<Vec<_>>().join(" "));
  vec![("isHidden", json!(table.is_hidden)), ("description", text(&description))]
}

fn column_fields(column: &Column) -> Fields {
  vec![
    ("dataType", lower(&column.data_type)),
    ("isKey", json!(column.is_key)),
    ("isHidden", json!(column.is_hidden)),
    ("sourceColumn", text(&column.source_column)),
    ("expression", expression(column.expression.as_deref())),
    ("formatString", text(&column.format_string)),
    ("sortByColumn", lower(&column.sort_by_column)),
  ]
}

fn measure_fields(measure: &Measure) -> Fields {
  vec![
    ("expression", expression(measure.expression.as_deref())),
    ("formatString", text(&measure.format_string)),
    ("isHidden", json!(measure.is_hidden)),
    ("displayFolder", text(&measure.display_folder)),
  ]
}

fn partition_fields(partition: &Partition) -> Fields {
  let mode = match lower(&partition.mode) {
    Value::String(mode) if mode != "default" => mode,
    _ => "import".to_string(),
  };
  vec![
    ("mode", json!(mode)),
    ("kind", lower(&partition.kind)),
    ("source", expression(partition.source.as_deref())),
    ("expressionSource", lower(&partition.expression_source)),
  ]
}

fn relationship_fields(relationship: &Relationship) -> Fields {
  vec![
    ("fromCardinality", json!(lower_or(&relationship.from_cardinality, "many"))),
    ("toCardinality", json!(lower_or(&relationship.to_cardinality, "one"))),
    ("crossFilteringBehavior", json!(lower_or(&relationship.cross_filtering_behavior, "onedirection"))),
    ("isActive", json!(relationship.is_active)),
  ]
}

fn expression_fields(named: &NamedExpression) -> Fields {
  vec![("expression", expression(Some(&named.expression)))]
}

fn role_fields(role: &Role) -> Fields {
  let mut permissions: Vec<(String, String, Value)> = role
    .table_permissions
    .iter()
    .map(|(table, filter)| (table.to_lowercase(), table.clone(), expression(Some(filter))))
    .collect();
  permissions.sort_by_cached_key(|(lower, table, filter)| (lower.clone(), table.clone(), filter.to_string()));
  let permissions: Vec<Value> = permissions.into_iter().map(|(_, table, filter)| json!([table, filter])).collect();
  vec![("modelPermission", json!(lower_or(&role.model_permission, "none"))), ("tablePermissions", json!(permissions))]
}

/// The names of the fields whose values differ.
fn changed(old: &Fields, new: &Fields) -> Vec<String> {
  old.iter().zip(new).filter(|(o, n)| o.1 != n.1).map(|(o, _)| o.0.to_string()).collect()
}

fn simple(op: ChangeOp, kind: ChangeKind, table: Option<&str>, name: &str) -> Change {
  Change { op, kind, table: table.map(String::from), name: name.to_string(), fields: Vec::new() }
}

/// Objects by lowercased name; the first of a duplicated name wins.
fn by_name<T>(items: &[T], name: fn(&T) -> &String) -> BTreeMap<String, &T> {
  let mut map = BTreeMap::new();
  for item in items {
    map.entry(name(item).to_lowercase()).or_insert(item);
  }
  map
}

fn diff_named<T>(
  changes: &mut Vec<Change>,
  kind: ChangeKind,
  table: Option<&str>,
  (old, new): (&[T], &[T]),
  name: fn(&T) -> &String,
  fields: fn(&T) -> Fields,
) {
  let old = by_name(old, name);
  let new = by_name(new, name);
  for (key, item) in &old {
    if !new.contains_key(key) {
      changes.push(simple(ChangeOp::Removed, kind, table, name(item)));
    }
  }
  for (key, item) in &new {
    match old.get(key) {
      None => changes.push(simple(ChangeOp::Added, kind, table, name(item))),
      Some(previous) => {
        let fields = changed(&fields(previous), &fields(item));
        if !fields.is_empty() {
          changes.push(Change { fields, ..simple(ChangeOp::Changed, kind, table, name(item)) });
        }
      }
    }
  }
}

fn relationship_key(r: &Relationship) -> (String, String, String, String) {
  (r.from_table.to_lowercase(), r.from_column.to_lowercase(), r.to_table.to_lowercase(), r.to_column.to_lowercase())
}

/// `From[Col] → To[Col]`.
fn endpoints(r: &Relationship) -> String {
  format!("{}[{}] → {}[{}]", r.from_table, r.from_column, r.to_table, r.to_column)
}

fn text(value: &Option<String>) -> Value {
  match value.as_deref().map(str::trim) {
    Some(text) if !text.is_empty() => json!(text),
    _ => Value::Null,
  }
}

fn lower(value: &Option<String>) -> Value {
  match value.as_deref().map(str::trim) {
    Some(text) if !text.is_empty() => json!(text.to_lowercase()),
    _ => Value::Null,
  }
}

fn lower_or(value: &Option<String>, default: &str) -> String {
  match value.as_deref().map(str::trim) {
    Some(text) if !text.is_empty() => text.to_lowercase(),
    _ => default.to_string(),
  }
}

fn expression(value: Option<&str>) -> Value {
  let normal = normalize_expression(value.unwrap_or_default());
  if normal.is_empty() {
    Value::Null
  } else {
    json!(normal)
  }
}

/// An expression with each line trimmed, blank lines dropped, and runs of spaces and tabs outside
/// quotes (`"…"` strings, `'…'` DAX names) collapsed to one space.
fn normalize_expression(text: &str) -> String {
  let mut lines = Vec::new();
  for line in text.lines() {
    let mut out = String::with_capacity(line.len());
    let mut quote: Option<char> = None;
    let mut space = false;
    for c in line.trim().chars() {
      if let Some(q) = quote {
        out.push(c);
        if c == q {
          quote = None;
        }
        continue;
      }
      if c == ' ' || c == '\t' {
        space = true;
        continue;
      }
      if space {
        out.push(' ');
        space = false;
      }
      if c == '"' || c == '\'' {
        quote = Some(c);
      }
      out.push(c);
    }
    if !out.is_empty() {
      lines.push(out);
    }
  }
  lines.join("\n")
}

fn fields_object(fields: Fields) -> Map<String, Value> {
  fields.into_iter().map(|(key, value)| (key.to_string(), value)).collect()
}

fn named(name: &str, fields: Fields) -> Map<String, Value> {
  let mut object = Map::new();
  object.insert("name".into(), json!(name));
  object.extend(fields_object(fields));
  object
}

fn sorted_objects<T>(items: &[T], name: fn(&T) -> &String, fields: fn(&T) -> Fields) -> Value {
  let mut values: Vec<Value> = items.iter().map(|item| Value::Object(named(name(item), fields(item)))).collect();
  sort_values(&mut values);
  Value::Array(values)
}

/// Sorts objects by lowercased name, then by name, then by content.
fn sort_values(values: &mut [Value]) {
  values.sort_by_cached_key(|value| {
    let name = value.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    (name.to_lowercase(), name, sorted_json(value))
  });
}

fn check(code: &str, table: Option<&str>, column: Option<&str>, detail: Option<&str>) -> Check {
  Check {
    code: code.to_string(),
    table: table.map(String::from),
    column: column.map(String::from),
    detail: detail.map(String::from),
  }
}

fn sort_checks(checks: &mut [Check], order: &[&str]) {
  checks.sort_by_cached_key(|c| {
    (
      order.iter().position(|code| *code == c.code).unwrap_or(order.len()),
      c.table.as_deref().map(str::to_lowercase),
      c.column.as_deref().map(str::to_lowercase),
      c.detail.clone(),
    )
  });
}

/// How a model stores its data: the partitions' mode (unset or `default` counts as `import`), or
/// `mixed`. Calculated tables and calculation groups don't count, unless they're all there is.
fn storage(model: &Model) -> Option<String> {
  let partitions: Vec<&Partition> = model.tables.iter().flat_map(|t| &t.partitions).collect();
  if partitions.is_empty() {
    return None;
  }
  let modes: BTreeSet<String> = partitions.iter().filter(|p| !is_calculated(p)).map(|p| mode_name(&p.mode)).collect();
  let mut modes = modes.into_iter();
  Some(match (modes.next(), modes.next()) {
    (None, _) => "import".to_string(),
    (Some(mode), None) => mode,
    (Some(_), Some(_)) => "mixed".to_string(),
  })
}

fn mode_name(mode: &Option<String>) -> String {
  let mode = mode.as_deref().map(str::trim).unwrap_or_default();
  match mode.to_lowercase().as_str() {
    "" | "default" | "import" => "import".to_string(),
    "directquery" => "directQuery".to_string(),
    "directlake" => "directLake".to_string(),
    "dual" => "dual".to_string(),
    _ => mode.to_string(),
  }
}

fn is_calculated(partition: &Partition) -> bool {
  partition
    .kind
    .as_deref()
    .is_some_and(|kind| kind.eq_ignore_ascii_case("calculated") || kind.eq_ignore_ascii_case("calculationGroup"))
}

/// Whether a partition's source is M.
fn is_m(partition: &Partition) -> bool {
  partition.kind.as_deref().is_none_or(|kind| kind.trim().eq_ignore_ascii_case("m"))
}

/// The values of the model's parameters, and of shared expressions that are a single text value.
fn parameter_values(model: &Model) -> HashMap<String, String> {
  let mut values = HashMap::new();
  for e in &model.expressions {
    let value = match (&e.parameter_value, e.is_parameter) {
      (Some(value), true) => Some(value.clone()),
      _ => match tokens(&e.expression).as_slice() {
        [Token::Text(text)] => Some(text.clone()),
        _ => None,
      },
    };
    if let Some(value) = value {
      values.entry(e.name.clone()).or_insert(value);
    }
  }
  values
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
  /// An identifier, possibly dotted (`Sql.Database`) or quoted (`#"My Name"`, unquoted here).
  Ident(String),
  /// A text literal, unquoted.
  Text(String),
  Number(String),
  Punct(char),
}

/// Splits M into tokens, skipping whitespace and comments.
fn tokens(m: &str) -> Vec<Token> {
  let chars: Vec<char> = m.chars().collect();
  let mut out = Vec::new();
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    let next = chars.get(i + 1).copied();
    if c.is_whitespace() {
      i += 1;
    } else if c == '/' && next == Some('/') {
      while i < chars.len() && chars[i] != '\n' {
        i += 1;
      }
    } else if c == '/' && next == Some('*') {
      i += 2;
      while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
        i += 1;
      }
      i += 2;
    } else if c == '"' {
      let (text, end) = m_string(&chars, i + 1);
      out.push(Token::Text(text));
      i = end;
    } else if c == '#' && next == Some('"') {
      let (text, end) = m_string(&chars, i + 2);
      out.push(Token::Ident(text));
      i = end;
    } else if c.is_alphabetic() || c == '_' || c == '#' {
      let start = i;
      i += 1;
      while i < chars.len() {
        let dotted = chars[i] == '.' && chars.get(i + 1).is_some_and(|n| n.is_alphabetic() || *n == '_');
        if !(chars[i].is_alphanumeric() || chars[i] == '_' || dotted) {
          break;
        }
        i += 1;
      }
      out.push(Token::Ident(chars[start..i].iter().collect()));
    } else if c.is_ascii_digit() {
      let start = i;
      while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '.') {
        i += 1;
      }
      out.push(Token::Number(chars[start..i].iter().collect()));
    } else {
      out.push(Token::Punct(c));
      i += 1;
    }
  }
  out
}

/// Reads an M text literal starting after its opening quote. Returns the text and where it ends.
fn m_string(chars: &[char], mut i: usize) -> (String, usize) {
  let mut text = String::new();
  while i < chars.len() {
    if chars[i] == '"' {
      if chars.get(i + 1) == Some(&'"') {
        text.push('"');
        i += 2;
        continue;
      }
      return (text, i + 1);
    }
    text.push(chars[i]);
    i += 1;
  }
  (text, i)
}

/// A function call in a token list: where its function's token is, and its arguments' tokens.
struct Call {
  at: usize,
  function: String,
  args: Vec<Range<usize>>,
}

/// The call that starts at token `at` (`Some.Function(`), if any.
fn call_at(tokens: &[Token], at: usize) -> Option<Call> {
  let Some(Token::Ident(function)) = tokens.get(at) else {
    return None;
  };
  if !function.contains('.') || tokens.get(at + 1) != Some(&Token::Punct('(')) {
    return None;
  }
  let mut args = Vec::new();
  let mut depth = 0usize;
  let mut start = at + 2;
  for (i, token) in tokens.iter().enumerate().skip(at + 2) {
    match token {
      Token::Punct('(' | '[' | '{') => depth += 1,
      Token::Punct(')') if depth == 0 => {
        if i > start {
          args.push(start..i);
        }
        return Some(Call { at, function: function.clone(), args });
      }
      Token::Punct(')' | ']' | '}') => depth = depth.saturating_sub(1),
      Token::Punct(',') if depth == 0 => {
        args.push(start..i);
        start = i + 1;
      }
      _ => {}
    }
  }
  if tokens.len() > start {
    args.push(start..tokens.len());
  }
  Some(Call { at, function: function.clone(), args })
}

/// The most arguments a source lists.
const MAX_ARGS: usize = 3;

/// The data sources one M expression reads.
fn m_sources(m: &str, values: &HashMap<String, String>) -> Vec<Source> {
  let tokens = tokens(m);
  let resolved = |call: &Call| -> Vec<String> {
    call.args.iter().take(MAX_ARGS).map_while(|range| resolve(&tokens[range.clone()], values)).collect()
  };
  let mut inner_calls = HashSet::new();
  let mut found = Vec::new();
  for at in 0..tokens.len() {
    if inner_calls.contains(&at) {
      continue;
    }
    let Some(call) = call_at(&tokens, at) else {
      continue;
    };
    if let Some(kind) = parser_kind(&call.function) {
      // A parser reads what the call in its first argument fetches: report the two as one source.
      let inner = call.args.first().and_then(|range| call_at(&tokens, range.start));
      let Some(inner) = inner.filter(|inner| access_kind(&inner.function).is_some()) else {
        continue;
      };
      inner_calls.insert(inner.at);
      let args = resolved(&inner);
      let local = is_local(&inner.function, &args);
      found.push(Source { kind: kind.to_string(), function: call.function.clone(), args, local, item: None });
    } else if let Some(kind) = access_kind(&call.function) {
      let args = resolved(&call);
      let kind = refine_kind(kind, &args);
      let local = is_local(&call.function, &args);
      found.push(Source { kind: kind.to_string(), function: call.function.clone(), args, local, item: None });
    }
  }
  found
}

/// An argument's text: a literal, a parameter, or an `&` concatenation of them.
fn resolve(tokens: &[Token], values: &HashMap<String, String>) -> Option<String> {
  let mut text = String::new();
  for (i, token) in tokens.iter().enumerate() {
    match (i % 2, token) {
      (0, Token::Text(value) | Token::Number(value)) => text.push_str(value),
      (0, Token::Ident(name)) => text.push_str(values.get(name)?),
      (1, Token::Punct('&')) => {}
      _ => return None,
    }
  }
  (tokens.len() % 2 == 1).then_some(text)
}

/// Parsers whose source is the call in their first argument, and the kind of source that makes.
fn parser_kind(function: &str) -> Option<&'static str> {
  match function.to_lowercase().as_str() {
    "excel.workbook" => Some("Excel"),
    "csv.document" => Some("CSV"),
    _ => None,
  }
}

/// Function families (the part before the dot) that read data, beyond those with a kind of their own.
const OTHER_FAMILIES: &[&str] = &[
  "access",
  "activedirectory",
  "adobeanalytics",
  "amazonathena",
  "amazonredshift",
  "analysisservices",
  "azurecosmosdb",
  "azuredataexplorer",
  "azuredatalakestorage",
  "azureenterprise",
  "azurestorage",
  "bigquery",
  "cds",
  "clickhouse",
  "commondataservice",
  "dataflows",
  "dataverse",
  "db2",
  "denodo",
  "documentdb",
  "dremio",
  "dynamics365businesscentral",
  "dynamicsnav",
  "essbase",
  "exchange",
  "fabric",
  "googleanalytics",
  "googlebigquery",
  "googlesheets",
  "hdfs",
  "hdinsight",
  "hive",
  "impala",
  "informix",
  "kusto",
  "mongodb",
  "netezza",
  "odbc",
  "oledb",
  "powerbi",
  "powerplatform",
  "presto",
  "salesforce",
  "sapbusinesswarehouse",
  "saphana",
  "smartsheet",
  "spark",
  "sybase",
  "teradata",
  "trino",
  "vertica",
];

/// The kind of source a function reads, if it reads one.
fn access_kind(function: &str) -> Option<&'static str> {
  let function = function.to_lowercase();
  let family = function.split('.').next().unwrap_or_default();
  Some(match (family, function.as_str()) {
    ("snowflake", _) => "Snowflake",
    (_, "sql.database" | "sql.databases") => "SQL Server",
    ("lakehouse", _) | (_, "fabric.lakehouse" | "fabric.lakehouses") => "Fabric Lakehouse",
    ("warehouse", _) | (_, "fabric.warehouse" | "fabric.warehouses") => "Fabric Warehouse",
    ("databricks" | "databricksmulticloud", _) => "Databricks",
    ("postgresql", _) => "PostgreSQL",
    ("oracle", _) => "Oracle",
    ("mysql", _) => "MySQL",
    ("odata", _) => "OData",
    (_, "web.contents" | "web.browsercontents" | "web.headers") => "Web",
    ("sharepoint", _) => "SharePoint",
    (_, "folder.files" | "folder.contents") => "Folder",
    (_, "file.contents") => "File",
    (family, _) if OTHER_FAMILIES.contains(&family) => "Other",
    _ => return None,
  })
}

/// Tells sources apart by where they point: `Sql.Database` reads SQL Server, Azure SQL and Fabric
/// SQL endpoints alike, and a OneLake URL (Direct Lake on OneLake) is a Fabric item.
fn refine_kind(kind: &'static str, args: &[String]) -> &'static str {
  let target = args.first().map(|s| s.to_lowercase()).unwrap_or_default();
  if target.contains("onelake.dfs.fabric.microsoft.com") || target.contains("onelake.blob.fabric.microsoft.com") {
    return if target.contains(".warehouse") { "Fabric Warehouse" } else { "Fabric Lakehouse" };
  }
  if kind != "SQL Server" {
    kind
  } else if target.contains(".datawarehouse.fabric.microsoft.com") || target.contains(".datawarehouse.pbidedicated.") {
    "Fabric Warehouse"
  } else if target.contains(".database.windows.net") || target.contains(".sql.azuresynapse.net") {
    "Azure SQL"
  } else {
    "SQL Server"
  }
}

/// Whether a call reads a file or folder on a computer.
fn is_local(function: &str, args: &[String]) -> bool {
  let function = function.to_lowercase();
  matches!(function.as_str(), "file.contents" | "folder.files" | "folder.contents")
    || args.iter().any(|a| is_local_path(a))
}

fn is_local_path(text: &str) -> bool {
  let text = text.trim();
  let bytes = text.as_bytes();
  let drive =
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/');
  drive || text.starts_with("\\\\") || text.to_lowercase().starts_with("file:")
}

#[cfg(test)]
mod tests {
  use super::super::tmdl::parse_definition;
  use super::*;

  fn model(files: &[(&str, &str)]) -> Model {
    let files: Vec<(String, String)> = files.iter().map(|(p, t)| (p.to_string(), t.to_string())).collect();
    parse_definition(&files).unwrap_or_else(|diags| panic!("unexpected diagnostics: {diags:#?}"))
  }

  const SALES: &str = r#"table Sales
  column OrderKey
    dataType: int64
    sourceColumn: OrderKey
  column CustomerKey
    dataType: int64
    sourceColumn: CustomerKey
  column Amount
    dataType: decimal
    sourceColumn: Amount
  measure Total = SUM(Sales[Amount])
    formatString: #,##0
  partition Sales = m
    mode: import
    source =
        let
            Source = Snowflake.Databases(Server, Warehouse),
            DB = Source{[Name="SALES"]}[Data]
        in
            DB
"#;

  const CUSTOMER: &str = r#"table Customer
  column CustomerKey
    dataType: int64
    isKey
    sourceColumn: CustomerKey
  column Name
    dataType: string
    sourceColumn: Name
  partition Customer = m
    mode: import
    source = Sql.Database("contoso.database.windows.net", "crm")
"#;

  const RELATIONSHIPS: &str = "relationship 7a1c\n  fromColumn: Sales.CustomerKey\n  toColumn: Customer.CustomerKey\n";

  const EXPRESSIONS: &str = r#"expression Server = "xy.snowflakecomputing.com" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]
expression Warehouse = "COMPUTE_WH" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]
"#;

  fn base() -> Model {
    model(&[
      ("definition/tables/Sales.tmdl", SALES),
      ("definition/tables/Customer.tmdl", CUSTOMER),
      ("definition/relationships.tmdl", RELATIONSHIPS),
      ("definition/expressions.tmdl", EXPRESSIONS),
      ("definition/model.tmdl", "model Model\n  culture: en-US\n"),
    ])
  }

  fn source(kind: &str, function: &str, args: &[&str], local: bool) -> Source {
    Source { kind: kind.into(), function: function.into(), args: args.iter().map(|a| a.to_string()).collect(), local, item: None }
  }

  /// A check as (code, table, column, detail).
  type Row<'a> = (&'a str, Option<&'a str>, Option<&'a str>, Option<&'a str>);

  fn codes(checks: &[Check]) -> Vec<Row<'_>> {
    checks.iter().map(|c| (c.code.as_str(), c.table.as_deref(), c.column.as_deref(), c.detail.as_deref())).collect()
  }

  #[test]
  fn summarizes_counts_storage_and_sources() {
    let model = base();
    let summary = summary(&model);
    assert_eq!((summary.tables, summary.columns, summary.measures, summary.relationships), (2, 5, 1, 1));
    assert_eq!(summary.storage.as_deref(), Some("import"));
    assert_eq!(
      summary.sources,
      [
        source("Azure SQL", "Sql.Database", &["contoso.database.windows.net", "crm"], false),
        source("Snowflake", "Snowflake.Databases", &["xy.snowflakecomputing.com", "COMPUTE_WH"], false),
      ]
    );

    let mut mixed = model.clone();
    mixed.tables[0].partitions[0].mode = Some("directQuery".into());
    assert_eq!(super::summary(&mixed).storage.as_deref(), Some("mixed"));
    let mut lake = model.clone();
    for table in &mut lake.tables {
      table.partitions[0].mode = Some("directLake".into());
    }
    assert_eq!(storage(&lake).as_deref(), Some("directLake"));
    assert_eq!(super::summary(&Model::default()).storage, None);
  }

  #[test]
  fn values_held_in_the_model_are_entered_data() {
    let tables = r#"table Filings
  partition Filings = m
    mode: import
    source =
        #table(
            type table [Ticker = text, Revenue = number],
            {{"AAPL", 391035}, {"MSFT", 245122}}
        )
  partition Pasted = m
    mode: import
    source = Table.FromRows(Json.Document(Binary.Decompress(Binary.FromText("i45W", BinaryEncoding.Base64), Compression.Deflate)))
"#;
    let model = model(&[("definition/tables/Filings.tmdl", tables), ("definition/model.tmdl", "model Model\n")]);
    assert_eq!(sources(&model), [source("Entered data", "#table", &[], false)]);
    // A model that reads a source doesn't count a table it builds from it.
    assert!(sources(&base()).iter().all(|s| s.function != "#table"));
  }

  #[test]
  fn finds_sources_in_m() {
    let tables = r#"table A
  partition A1 = m
    mode: import
    source =
        let
            // Oracle.Database("commented out")
            Source = Sql.Database("srv01", "db", [Query="select ""Web.Contents("" from x"]),
            Rows = Table.SelectRows(Source, each List.Contains({1}, [Id]))
        in
            Rows
  partition A2 = m
    mode: import
    source = Json.Document(Web.Contents("https://example.com/data.json"))
  partition A3 = m
    mode: import
    source = Excel.Workbook(File.Contents("C:\data\x.xlsx"), null, true)
  partition A4 = m
    mode: import
    source = Sql.Database("srv01", "db")
  partition A5 = m
    mode: import
    source = Csv.Document(File.Contents("\\server\share\a.csv"), [Delimiter=","])
  partition A6 = m
    mode: import
    source = PostgreSQL.Database(#"Server Name", "sales" & "_" & Env)
  partition A7 = m
    mode: import
    source = Folder.Files("D:\exports")
  partition A8 = calculated
    source = Sql.Database("not", "m")
"#;
    let expressions = r#"expression 'Server Name' = "pg.example.com" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]
expression Env = "prod" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]
expression Lake =
    let
        Source = Lakehouse.Contents(null),
        Sheet = Excel.Workbook(Source)
    in
        Sheet
expression DatabaseQuery =
    let
        database = Sql.Database("abc.datawarehouse.fabric.microsoft.com", "wh")
    in
        database
expression OneLake =
    AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/0d1c/9a8b", [HierarchicalNavigation=true])
"#;
    let model = model(&[("definition/tables/A.tmdl", tables), ("definition/expressions.tmdl", expressions)]);
    assert_eq!(
      sources(&model),
      [
        source("SQL Server", "Sql.Database", &["srv01", "db"], false),
        source("Web", "Web.Contents", &["https://example.com/data.json"], false),
        source("Excel", "Excel.Workbook", &["C:\\data\\x.xlsx"], true),
        source("CSV", "Csv.Document", &["\\\\server\\share\\a.csv"], true),
        source("PostgreSQL", "PostgreSQL.Database", &["pg.example.com", "sales_prod"], false),
        source("Folder", "Folder.Files", &["D:\\exports"], true),
        source("Fabric Lakehouse", "Lakehouse.Contents", &[], false),
        source("Fabric Warehouse", "Sql.Database", &["abc.datawarehouse.fabric.microsoft.com", "wh"], false),
        source(
          "Fabric Lakehouse",
          "AzureStorage.DataLake",
          &["https://onelake.dfs.fabric.microsoft.com/0d1c/9a8b"],
          false
        ),
      ]
    );
  }

  /// The base model as Fabric might serialize it: other order, whitespace, lineage tags, defaults
  /// written out, another relationship name.
  fn base_reserialized() -> Model {
    let sales = r#"table Sales
	lineageTag: 0b9e

	measure Total =
			SUM(Sales[Amount])   

		formatString: #,##0
		lineageTag: 77aa

	partition Sales = m
		mode: Import
		source =
				let
				    Source = Snowflake.Databases(Server,   Warehouse),


				    DB = Source{[Name="SALES"]}[Data]
				in
				    DB

	column Amount
		dataType: Decimal
		sourceColumn: Amount
		annotation SummarizationSetBy = Automatic

	column CustomerKey
		dataType: int64
		isHidden: false
		sourceColumn: CustomerKey

	column OrderKey
		dataType: int64
		sourceColumn: OrderKey
"#;
    let customer = CUSTOMER.replace("    isKey\n", "    isKey: true\n    lineageTag: 12\n");
    let relationships = "relationship 0c5f4e1a-9a0e-4c39-8d0f-2a6b9e1d7c33\n\
      \tfromColumn: Sales.CustomerKey\n\
      \ttoColumn: Customer.CustomerKey\n\
      \ttoCardinality: one\n\
      \tcrossFilteringBehavior: oneDirection\n\
      \tisActive: true\n";
    model(&[
      ("definition/model.tmdl", "model Model\n\tculture: en-US\n\nref table Customer\nref table Sales\n"),
      ("definition/expressions.tmdl", EXPRESSIONS),
      ("definition/relationships.tmdl", relationships),
      ("definition/tables/Customer.tmdl", &customer),
      ("definition/tables/Sales.tmdl", sales),
    ])
  }

  fn change(op: ChangeOp, kind: ChangeKind, table: Option<&str>, name: &str, fields: &[&str]) -> Change {
    Change {
      op,
      kind,
      table: table.map(String::from),
      name: name.into(),
      fields: fields.iter().map(|f| f.to_string()).collect(),
    }
  }

  #[test]
  fn diff_ignores_serialization_differences() {
    assert_eq!(diff(&base(), &base_reserialized()), []);
    assert_eq!(diff(&base_reserialized(), &base()), []);
    let (mut old, mut new) = (base(), base());
    old.tables[0].description = Some("Customers, one row per  customer".into());
    new.tables[0].description = Some("Customers, one row\nper customer".into());
    assert_eq!(diff(&old, &new), []);
    assert_eq!(
      normalize_expression("  CALCULATE(  [X],\n\n\t'My  Table'[A] = \"a  b\" )  \n"),
      "CALCULATE( [X],\n'My  Table'[A] = \"a  b\" )"
    );
  }

  #[test]
  fn diff_lists_material_changes_in_order() {
    let old = base();
    let mut new = base();
    new.tables[1].columns[2].data_type = Some("string".into());
    new.tables[1].measures[0].expression = Some("SUM(Sales[Amount]) * 2".into());
    new.tables[1].partitions[0].source =
      Some("let\n    Source = Snowflake.Databases(Server, \"OTHER_WH\")\nin\n    Source".into());
    new.tables[0].partitions[0].mode = Some("dual".into());
    new.expressions[0].expression = "\"zz.snowflakecomputing.com\" meta [IsParameterQuery=true]".into();
    new.relationships.clear();
    new.tables.push(Table {
      name: "Date".into(),
      columns: vec![Column { name: "Date".into(), ..Column::default() }],
      ..Table::default()
    });
    new.culture = Some("fr-FR".into());
    let expected = {
      use ChangeKind::*;
      use ChangeOp::*;
      [
        change(Changed, Model, None, "model", &["culture"]),
        change(Added, Table, None, "Date", &[]),
        change(Changed, Column, Some("Sales"), "Amount", &["dataType"]),
        change(Changed, Measure, Some("Sales"), "Total", &["expression"]),
        change(Changed, Partition, Some("Customer"), "Customer", &["mode"]),
        change(Changed, Partition, Some("Sales"), "Sales", &["source"]),
        change(Removed, Relationship, None, "Sales[CustomerKey] → Customer[CustomerKey]", &[]),
        change(Changed, Expression, None, "Server", &["expression"]),
      ]
    };
    assert_eq!(diff(&old, &new), expected);
    let removed = diff(&new, &old);
    assert!(removed.contains(&change(ChangeOp::Removed, ChangeKind::Table, None, "Date", &[])));
    assert!(!removed.iter().any(|c| c.kind == ChangeKind::Column && c.table.as_deref() == Some("Date")));
  }

  #[test]
  fn diff_matches_relationships_by_endpoints_and_applies_defaults() {
    let old = base();
    let mut new = base();
    new.relationships[0].name = "another-guid".into();
    new.relationships[0].from_table = "sales".into();
    new.relationships[0].to_cardinality = Some("One".into());
    new.relationships[0].from_cardinality = Some("many".into());
    assert_eq!(diff(&old, &new), []);
    new.relationships[0].is_active = false;
    new.relationships[0].cross_filtering_behavior = Some("bothDirections".into());
    assert_eq!(
      diff(&old, &new),
      [change(
        ChangeOp::Changed,
        ChangeKind::Relationship,
        None,
        "sales[CustomerKey] → Customer[CustomerKey]",
        &["crossFilteringBehavior", "isActive"]
      )]
    );
  }

  #[test]
  fn checks_relationships() {
    let tables = r#"table Sales
  column CustomerKey
    dataType: string
  column ProductKey
    dataType: int64
  measure Total = 1
  partition Sales = m
    source = Sql.Database("s", "d")
table Customer
  column CustomerKey
    dataType: int64
  measure total = 2
  partition Customer = m
    source = Sql.Database("s", "d")
table Product
  column ProductKey
    dataType: int64
  partition Product = m
    source = Sql.Database("s", "d")
"#;
    let relationships = r#"relationship r1
  fromColumn: Sales.CustomerKey
  toColumn: Customer.CustomerKey
relationship r2
  fromColumn: Sales.CustomerKey
  toColumn: Customer.CustKey
relationship r3
  fromColumn: Product.ProductKey
  toColumn: Sales.ProductKey
  fromCardinality: one
  toCardinality: many
  crossFilteringBehavior: bothDirections
relationship r4
  fromColumn: Sales.ProductKey
  toColumn: Product.ProductKey
  fromCardinality: many
  toCardinality: many
relationship r5
  fromColumn: Sales.CustomerKey
  toColumn: Customer.CustomerKey
  isActive: false
relationship r6
  fromColumn: Sales.ProductKey
  toColumn: Sales.ProductKey
relationship r7
  fromColumn: Sales.ProductKey
  toColumn: Store.StoreKey
"#;
    let model = model(&[("definition/tables/All.tmdl", tables), ("definition/relationships.tmdl", relationships)]);
    let (blocking, advisory) = checks(&model);
    assert_eq!(
      codes(&blocking),
      [
        ("duplicate-measure", Some("Customer"), Some("total"), Some("Sales")),
        ("missing-table", Some("Store"), None, Some("Sales[ProductKey] → Store[StoreKey]")),
        ("missing-column", Some("Customer"), Some("CustKey"), Some("Sales[CustomerKey] → Customer[CustKey]")),
        ("self-relationship", Some("Sales"), Some("ProductKey"), Some("Sales[ProductKey] → Sales[ProductKey]")),
        (
          "duplicate-relationship",
          Some("Sales"),
          Some("CustomerKey"),
          Some("Sales[CustomerKey] → Customer[CustomerKey]")
        ),
      ]
    );
    assert_eq!(
      codes(&advisory),
      [
        ("one-side-key", Some("Customer"), Some("CustomerKey"), Some("Sales[CustomerKey]")),
        ("one-side-key", Some("Product"), Some("ProductKey"), Some("Sales[ProductKey]")),
        ("type-mismatch", Some("Sales"), Some("CustomerKey"), Some("string → int64")),
        ("both-directions", Some("Product"), Some("ProductKey"), Some("Product[ProductKey] → Sales[ProductKey]")),
      ]
    );
  }

  #[test]
  fn checks_tables_and_sources() {
    assert_eq!(codes(&checks(&Model::default()).0), [("no-tables", None, None, None)]);

    let tables = r#"table Sales
  column Amount
    dataType: double
  measure amount = SUM(Sales[Amount])
  partition Sales = m
    source = Excel.Workbook(File.Contents("C:\data\x.xlsx"))
table Empty
  column X
    dataType: string
table 'Time Intelligence'
  calculationGroup
    calculationItem YTD = SELECTEDMEASURE()
  column Name
    dataType: string
"#;
    let mut model = model(&[("definition/tables/All.tmdl", tables)]);
    model.tables.push(Table { name: "SALES".into(), ..Table::default() });
    let (blocking, advisory) = checks(&model);
    assert_eq!(
      codes(&blocking),
      [("duplicate-table", Some("SALES"), None, None), ("duplicate-name", Some("Sales"), Some("amount"), None)]
    );
    assert_eq!(
      codes(&advisory),
      [
        ("no-partition", Some("Empty"), None, None),
        ("no-partition", Some("SALES"), None, None),
        ("local-source", None, None, Some("Excel.Workbook(\"C:\\data\\x.xlsx\")")),
      ]
    );
  }

  #[test]
  fn canonical_form_ignores_serialization_but_not_changes() {
    let canonical_base = canonical(&base());
    assert_eq!(canonical_base, canonical(&base_reserialized()));
    let parsed: Value = serde_json::from_str(&canonical_base).expect("canonical is JSON");
    assert_eq!(parsed["tables"][0]["name"], "Customer");
    assert_eq!(parsed["relationships"][0]["toCardinality"], "one");

    let mut changed = base();
    changed.tables[1].measures[0].expression = Some("SUM(Sales[Amount]) + 1".into());
    assert_ne!(canonical_base, canonical(&changed));
    assert_eq!(
      canonical(&Model::default()),
      r#"{"expressions":[],"model":{"compatibilityLevel":null,"culture":null},"relationships":[],"roles":[],"tables":[]}"#
    );
  }

  const LAKE_ID: &str = "9a8b7c6d-0000-4000-8000-000000000001";

  fn direct_lake(level: &str) -> Model {
    let database = format!("database\n\tcompatibilityLevel: {level}\n");
    let expressions = format!(
      "expression DirectLake =\n\t\tlet\n\t\t    Source = AzureStorage.DataLake(\"https://onelake.dfs.fabric.microsoft.com/0d1c/{LAKE_ID}\", [HierarchicalNavigation = true])\n\t\tin\n\t\t    Source\n"
    );
    let orders = "table Orders\n\
      \tcolumn OrderId\n\t\tdataType: int64\n\t\tsourceColumn: OrderId\n\
      \tcolumn Region\n\t\tdataType: string\n\t\tsourceColumn: region_name\n\
      \tcolumn Margin = [Amount] * 0.1\n\t\tdataType: double\n\
      \tpartition Orders = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: orders\n\t\t\texpressionSource: DirectLake\n";
    let missing = "table Returns\n\
      \tcolumn Id\n\t\tdataType: int64\n\t\tsourceColumn: Id\n\
      \tpartition Returns = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: returns\n\t\t\texpressionSource: DirectLake\n";
    model(&[
      ("definition/database.tmdl", &database),
      ("definition/expressions.tmdl", &expressions),
      ("definition/tables/Orders.tmdl", orders),
      ("definition/tables/Returns.tmdl", missing),
    ])
  }

  #[test]
  fn direct_lake_needs_compatibility_level_1604() {
    let codes = |model: &Model| checks(model).0.into_iter().map(|c| (c.code, c.detail)).collect::<Vec<_>>();
    assert_eq!(codes(&direct_lake("1567")), [("direct-lake-level".to_string(), Some("1567".to_string()))]);
    assert!(codes(&direct_lake("1604")).is_empty());
    let summary = summary(&direct_lake("1604"));
    assert_eq!(summary.storage.as_deref(), Some("directLake"));
    assert_eq!(summary.sources[0].kind, "Fabric Lakehouse");
  }

  #[test]
  fn a_direct_lake_key_is_checked_for_the_queries_that_rely_on_it() {
    let mut lake = direct_lake("1604");
    lake.relationships =
      model(&[("definition/relationships.tmdl", "relationship r1\n\tfromColumn: Returns.Id\n\ttoColumn: Orders.OrderId\n")])
        .relationships;
    let (_, advisory) = checks(&lake);
    let found: Vec<(&str, Option<&str>)> = advisory.iter().map(|c| (c.code.as_str(), c.table.as_deref())).collect();
    assert_eq!(found, [("one-side-key-direct-lake", Some("Orders"))]);
  }

  #[test]
  fn a_direct_lake_model_is_checked_against_the_lakehouse_tables_fabricator_loaded() {
    let model = direct_lake("1604");
    let tables = [LakeTable { item_id: LAKE_ID, lakehouse: "Sales", table: "orders", columns: vec!["OrderId", "Region", "Amount"] }];
    let found: Vec<(String, Option<String>, Option<String>, Option<String>)> =
      direct_lake_checks(&model, &tables).into_iter().map(|c| (c.code, c.table, c.column, c.detail)).collect();
    assert_eq!(
      found,
      [
        ("direct-lake-table".into(), Some("Returns".into()), Some("returns".into()), Some("Sales".into())),
        ("direct-lake-column".into(), Some("Orders".into()), Some("region_name".into()), Some("orders".into())),
      ]
    );
    // A lakehouse Fabricator doesn't know the tables of is left alone.
    assert!(direct_lake_checks(&model, &[]).is_empty());
  }

  #[test]
  fn sources_name_the_apps_own_lakehouse() {
    assert_eq!(
      one_lake_item("https://msit-onelake.dfs.fabric.microsoft.com/0D1C/9A8B7C6D-0000-4000-8000-000000000001/Tables"),
      Some(LAKE_ID.to_string())
    );
    assert_eq!(one_lake_item("https://onelake.dfs.fabric.microsoft.com/ws/Sales.Lakehouse"), Some("sales".to_string()));
    assert_eq!(one_lake_item("https://example.com/0d1c/9a8b"), None);
    let mut sources = summary(&direct_lake("1604")).sources;
    name_items(&mut sources, &[(LAKE_ID.to_uppercase(), "Sales".to_string())]);
    assert_eq!(sources[0].item.as_deref(), Some("Sales"));
  }
}