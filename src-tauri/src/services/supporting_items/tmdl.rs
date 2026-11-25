//! Reads a Power BI semantic model from its TMDL (Tabular Model Definition
//! Language) files into the few things Fabricator shows or compares.
//!
//! The reader is lenient: it skips object types and properties it doesn't
//! model, and reports only what makes a definition unreadable. Fabric remains
//! the final validator.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

/// A semantic model read from TMDL. Only what Fabricator shows or compares.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
  pub compatibility_level: Option<u32>,
  pub culture: Option<String>,
  pub tables: Vec<Table>,
  pub relationships: Vec<Relationship>,
  /// Shared M expressions and parameters (`expression X = ...`).
  pub expressions: Vec<NamedExpression>,
  pub roles: Vec<Role>,
}

/// A table, with the columns, measures and partitions declared inside it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
  pub name: String,
  pub description: Option<String>,
  pub is_hidden: bool,
  /// Declared as a calculation group (`calculationGroup` child).
  pub calculation_group: bool,
  pub columns: Vec<Column>,
  pub measures: Vec<Measure>,
  pub partitions: Vec<Partition>,
  pub hierarchies: Vec<String>,
}

/// A column of a table: read from its source, or calculated with DAX.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
  pub name: String,
  pub data_type: Option<String>,
  pub is_hidden: bool,
  pub is_key: bool,
  pub source_column: Option<String>,
  /// Set for a calculated column (its DAX).
  pub expression: Option<String>,
  pub format_string: Option<String>,
  pub data_category: Option<String>,
  pub display_folder: Option<String>,
  pub summarize_by: Option<String>,
  pub sort_by_column: Option<String>,
  pub description: Option<String>,
}

/// A DAX measure.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measure {
  pub name: String,
  pub expression: Option<String>,
  pub format_string: Option<String>,
  pub display_folder: Option<String>,
  pub description: Option<String>,
  pub is_hidden: bool,
}

/// Where a table's rows come from.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Partition {
  pub name: String,
  /// The source kind after `=`: `m`, `calculated`, `entity`, `query`, `calculationGroup`, …
  pub kind: Option<String>,
  /// `import`, `directQuery`, `directLake`, `dual` or `default`, as written.
  pub mode: Option<String>,
  /// The source expression (M for `m`, DAX for `calculated`); for `entity`, the `entityName`.
  pub source: Option<String>,
  /// For `entity` partitions (Direct Lake): `expressionSource`, when set.
  pub expression_source: Option<String>,
}

/// A relationship between a column of one table and a column of another.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
  pub name: String,
  pub from_table: String,
  pub from_column: String,
  pub to_table: String,
  pub to_column: String,
  /// As written; `None` means the default (`many` for from, `one` for to).
  pub from_cardinality: Option<String>,
  pub to_cardinality: Option<String>,
  /// As written; `None` means `oneDirection`.
  pub cross_filtering_behavior: Option<String>,
  pub is_active: bool,
}

/// A shared M query or parameter.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedExpression {
  pub name: String,
  /// The full M text, including any trailing `meta [...]`.
  pub expression: String,
  /// `meta [IsParameterQuery=true...]`.
  pub is_parameter: bool,
  /// For a parameter: its value, as the literal before `meta` (a quoted text value is unquoted, e.g.
  /// `"xy.snowflakecomputing.com"` → `xy.snowflakecomputing.com`; a number or other literal kept as written).
  pub parameter_value: Option<String>,
}

/// A security role.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
  pub name: String,
  pub model_permission: Option<String>,
  /// (table, DAX filter) pairs.
  pub table_permissions: Vec<(String, String)>,
}

/// A problem that stops a definition from being read.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
  /// The file, as given to [`parse_definition`].
  pub file: String,
  /// 1-based line.
  pub line: usize,
  pub message: String,
}

/// Read a semantic model from its TMDL files: `(path, text)` pairs with paths relative to the item
/// folder using `/` (e.g. `definition/model.tmdl`, `definition/tables/Sales.tmdl`). Files outside
/// `definition/` or not ending in `.tmdl` are ignored. Returns every problem found when the
/// definition can't be read reliably (a line that isn't valid TMDL at its position, an object
/// declared at an impossible indentation, an unterminated ``` fence, a relationship missing
/// fromColumn/toColumn, a qualified reference that can't be split into table and column…).
/// Tables, columns, measures, relationships etc. appear in a deterministic order: files sorted by
/// path, objects in file order.
pub fn parse_definition(files: &[(String, String)]) -> Result<Model, Vec<Diagnostic>> {
  let mut selected: Vec<(String, &String, &String)> = files
    .iter()
    .filter_map(|(path, text)| {
      let normal = path.replace('\\', "/");
      let normal = normal.trim_start_matches("./").trim_start_matches('/').to_string();
      let lower = normal.to_ascii_lowercase();
      (lower.starts_with("definition/") && lower.ends_with(".tmdl")).then_some((normal, path, text))
    })
    .collect();
  selected.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));

  let mut builder = Builder::default();
  for (_, path, text) in selected {
    let start = builder.diags.len();
    let mut parser = Parser::new(path, text);
    let items = parser.parse_items(None);
    builder.diags.append(&mut parser.diags);
    builder.file.clone_from(path);
    builder.root(&items);
    builder.diags[start..].sort_by_key(|diag| diag.line);
  }
  if builder.diags.is_empty() {
    Ok(builder.model)
  } else {
    Err(builder.diags)
  }
}

/// How many columns a tab advances the indentation.
const TAB_WIDTH: usize = 4;

/// Object types whose bodies hold something the model keeps. Other objects are skipped whole.
const PARSED: &[&str] = &[
  "database",
  "model",
  "table",
  "column",
  "measure",
  "partition",
  "relationship",
  "expression",
  "role",
  "tablepermission",
  "source",
];

/// Object types that can only be declared inside a table.
const TABLE_ONLY: &[&str] =
  &["column", "measure", "partition", "hierarchy", "level", "calculationgroup", "calculationitem"];

/// Object types that can only be declared at the top level (or inside `model`/`database`).
const ROOT_ONLY: &[&str] = &["database", "model", "table", "relationship", "expression", "role"];

struct Line<'a> {
  /// The line without its line break.
  raw: &'a str,
  /// Its indentation, in columns.
  indent: usize,
  /// The line without surrounding whitespace.
  content: &'a str,
}

#[derive(Debug)]
enum Item {
  Prop(Prop),
  Node(Node),
}

#[derive(Debug)]
struct Prop {
  /// The property name, lowercased (TMDL is case-insensitive).
  key: String,
  /// The property name as written.
  word: String,
  value: PropValue,
  /// 0-based line.
  line: usize,
}

#[derive(Debug)]
enum PropValue {
  /// A boolean written as just its name.
  Flag,
  /// `name: value`.
  Text(String),
  /// `name = expression`.
  Expr(String),
}

#[derive(Debug)]
struct Node {
  /// The object type, lowercased.
  kind: String,
  name: String,
  /// The default property, after `=`.
  value: Option<String>,
  /// Text after the name that isn't a default property (only kept for `database`).
  extra: Option<String>,
  items: Vec<Item>,
  description: Option<String>,
  /// 0-based line.
  line: usize,
}

impl Node {
  fn props(&self) -> impl Iterator<Item = &Prop> {
    self.items.iter().filter_map(|item| match item {
      Item::Prop(prop) => Some(prop),
      Item::Node(_) => None,
    })
  }

  fn children(&self) -> impl Iterator<Item = &Node> {
    self.items.iter().filter_map(|item| match item {
      Item::Node(node) => Some(node),
      Item::Prop(_) => None,
    })
  }

  fn prop(&self, key: &str) -> Option<&Prop> {
    self.props().filter(|prop| prop.key == key).last()
  }

  /// A text or expression property, `None` when absent or empty.
  fn text(&self, key: &str) -> Option<String> {
    match &self.prop(key)?.value {
      PropValue::Text(text) | PropValue::Expr(text) => non_empty(text),
      PropValue::Flag => None,
    }
  }

  fn flag(&self, key: &str) -> Option<bool> {
    self.prop(key).map(|prop| match &prop.value {
      PropValue::Flag => true,
      PropValue::Text(text) | PropValue::Expr(text) => text.trim().eq_ignore_ascii_case("true"),
    })
  }

  /// The default property, or else the expression property `key`.
  fn expression(&self, key: &str) -> Option<String> {
    self.value.as_deref().and_then(non_empty).or_else(|| self.text(key))
  }
}

struct Parser<'a> {
  file: &'a str,
  lines: Vec<Line<'a>>,
  pos: usize,
  diags: Vec<Diagnostic>,
}

impl<'a> Parser<'a> {
  fn new(file: &'a str, text: &'a str) -> Self {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines = text
      .split('\n')
      .map(|line| {
        let raw = line.strip_suffix('\r').unwrap_or(line);
        Line { raw, indent: indent_width(raw), content: raw.trim() }
      })
      .collect();
    Parser { file, lines, pos: 0, diags: Vec::new() }
  }

  fn diag(&mut self, index: usize, message: impl Into<String>) {
    self.diags.push(Diagnostic { file: self.file.to_string(), line: index + 1, message: message.into() });
  }

  /// The index of the next line with content, without consuming anything.
  fn next_content(&self) -> Option<usize> {
    (self.pos..self.lines.len()).find(|&i| !self.lines[i].content.is_empty())
  }

  /// Consumes the lines indented deeper than `indent`.
  fn skip_deeper(&mut self, indent: usize) {
    while let Some(i) = self.next_content() {
      if self.lines[i].indent <= indent {
        break;
      }
      self.pos = i + 1;
    }
  }

  /// Reads the properties and objects of a body: the lines indented deeper than `parent` (the
  /// declaration's indentation), or the whole file at the top level.
  fn parse_items(&mut self, parent: Option<usize>) -> Vec<Item> {
    let mut items = Vec::new();
    let mut description: Vec<String> = Vec::new();
    let mut base: Option<usize> = None;
    while let Some(i) = self.next_content() {
      let indent = self.lines[i].indent;
      match parent {
        Some(parent) if indent <= parent => break,
        Some(_) => {}
        None => match base {
          Some(base) if indent > base => {
            self.pos = i + 1;
            self.diag(i, "This line is indented, but it isn't inside any object: remove its indentation or move it under the object it belongs to.");
            self.skip_deeper(indent);
            description.clear();
            continue;
          }
          Some(base) if indent == base => {}
          _ => base = Some(indent),
        },
      }
      if i > self.pos {
        // A blank line separates a description from what follows, so it describes nothing.
        description.clear();
      }
      self.pos = i + 1;
      let content = self.lines[i].content;
      if let Some(text) = content.strip_prefix("///") {
        description.push(text.trim().to_string());
        continue;
      }
      let described = (!description.is_empty()).then(|| description.join("\n"));
      description.clear();
      if let Some(item) = self.parse_line(i, described) {
        items.push(item);
      }
    }
    items
  }

  fn parse_line(&mut self, i: usize, description: Option<String>) -> Option<Item> {
    let content = self.lines[i].content;
    let indent = self.lines[i].indent;
    let word_len = content.bytes().take_while(|b| b.is_ascii_alphanumeric() || *b == b'_').count();
    if word_len == 0 || content.as_bytes()[0].is_ascii_digit() {
      self.invalid(i, content);
      return None;
    }
    let word = &content[..word_len];
    let kind = word.to_ascii_lowercase();
    let rest = &content[word_len..];
    let after = rest.trim_start();

    if after.is_empty() {
      // A bare word is a boolean property, unless it has a body: then it's an object without a name.
      if self.next_content().is_some_and(|j| self.lines[j].indent > indent) {
        return Some(Item::Node(self.object(i, kind, String::new(), None, None, description)));
      }
      return Some(Item::Prop(Prop { key: kind, word: word.to_string(), value: PropValue::Flag, line: i }));
    }
    if let Some(value) = after.strip_prefix(':') {
      let value = PropValue::Text(unquote_text(value.trim()));
      return Some(Item::Prop(Prop { key: kind, word: word.to_string(), value, line: i }));
    }
    if let Some(value) = after.strip_prefix('=') {
      let value = PropValue::Expr(self.read_value(i, value, false)?);
      return Some(Item::Prop(Prop { key: kind, word: word.to_string(), value, line: i }));
    }
    if kind == "ref" {
      self.skip_deeper(indent);
      return None;
    }
    if !rest.starts_with(char::is_whitespace) {
      self.invalid(i, content);
      return None;
    }
    let (name, tail) = match parse_name(after) {
      Ok(parsed) => parsed,
      Err(message) => {
        self.diag(i, message);
        self.skip_deeper(indent);
        return None;
      }
    };
    let tail = tail.trim_start();
    let (value, extra) = if tail.is_empty() {
      (None, None)
    } else if let Some(value) = tail.strip_prefix('=') {
      (self.read_value(i, value, true), None)
    } else if kind == "database" {
      (None, Some(tail.to_string()))
    } else {
      self.diag(
        i,
        format!(
          "Unexpected `{}` after the name of `{word} {name}`. Quote a name that has spaces or dots ('My Name'), and put a property on its own line, indented under the object.",
          shorten(tail)
        ),
      );
      self.skip_deeper(indent);
      return None;
    };
    Some(Item::Node(self.object(i, kind, name, value, extra, description)))
  }

  fn invalid(&mut self, i: usize, content: &str) {
    self.diag(
      i,
      format!(
        "`{}` isn't valid TMDL: expected an object (such as `table Sales` or `measure 'Total Sales' = ...`) or a property (such as `dataType: int64`). A multi-line expression starts on the line after `=`, indented deeper than the object's properties.",
        shorten(content)
      ),
    );
    let indent = self.lines[i].indent;
    self.skip_deeper(indent);
  }

  fn object(
    &mut self,
    i: usize,
    kind: String,
    name: String,
    value: Option<String>,
    extra: Option<String>,
    description: Option<String>,
  ) -> Node {
    let indent = self.lines[i].indent;
    let items = if PARSED.contains(&kind.as_str()) {
      self.parse_items(Some(indent))
    } else {
      self.skip_deeper(indent);
      Vec::new()
    };
    Node { kind, name, value, extra, items, description, line: i }
  }

  /// Reads the value after `=` on line `i`: on the same line, fenced with ```, or on the lines that
  /// follow, indented deeper. For an object's default property the expression ends where the
  /// indentation returns to its properties' level; for a property, where it returns to the
  /// property's own level.
  fn read_value(&mut self, i: usize, after: &str, object: bool) -> Option<String> {
    let value = after.trim();
    if let Some(fenced) = value.strip_prefix("```") {
      return self.read_fence(i, fenced);
    }
    if !value.is_empty() {
      return Some(value.to_string());
    }
    let owner = self.lines[i].indent;
    let start = self.pos;
    let mut end = start;
    let mut first: Option<usize> = None;
    for j in start..self.lines.len() {
      let line = &self.lines[j];
      if line.content.is_empty() {
        continue;
      }
      let inside = match first {
        Some(first) if object => line.indent >= first,
        _ => line.indent > owner,
      };
      if !inside {
        break;
      }
      first.get_or_insert(line.indent);
      end = j + 1;
    }
    self.pos = end;
    Some(dedent(&self.lines[start..end]))
  }

  fn read_fence(&mut self, i: usize, after: &str) -> Option<String> {
    if let Some(inner) = after.trim_end().strip_suffix("```") {
      return Some(inner.trim().to_string());
    }
    let mut lines: Vec<&str> = Vec::new();
    if !after.trim().is_empty() {
      lines.push(after.trim());
    }
    for j in self.pos..self.lines.len() {
      let raw = self.lines[j].raw;
      if let Some(before) = raw.trim_end().strip_suffix("```") {
        if !before.trim().is_empty() {
          lines.push(before);
        }
        self.pos = j + 1;
        return Some(dedent_verbatim(&lines));
      }
      lines.push(raw);
    }
    self.diag(i, "This ``` fence is never closed: end the expression with a line that holds only ```.");
    self.pos = self.lines.len();
    None
  }
}

/// Builds the model from the parsed files, in order.
#[derive(Default)]
struct Builder {
  model: Model,
  file: String,
  tables: HashMap<String, String>,
  expressions: HashMap<String, String>,
  roles: HashMap<String, String>,
  diags: Vec<Diagnostic>,
}

impl Builder {
  fn diag(&mut self, line: usize, message: impl Into<String>) {
    self.diags.push(Diagnostic { file: self.file.clone(), line: line + 1, message: message.into() });
  }

  fn root(&mut self, items: &[Item]) {
    for item in items {
      match item {
        Item::Node(node) => self.root_node(node),
        Item::Prop(prop) if prop.key == "compatibilitylevel" => self.compatibility_level(prop),
        Item::Prop(Prop { key, value: PropValue::Flag, .. }) if ROOT_ONLY.contains(&key.as_str()) => {}
        Item::Prop(prop) => {
          let line = prop.line;
          self.diag(
            line,
            format!("The property `{}` isn't inside any object: indent it under the object it belongs to.", prop.word),
          );
        }
      }
    }
  }

  fn root_node(&mut self, node: &Node) {
    match node.kind.as_str() {
      "database" => {
        if let Some(prop) = node.prop("compatibilitylevel") {
          self.compatibility_level(prop);
        } else if let Some(level) = node.extra.as_deref().and_then(inline_compatibility_level) {
          self.model.compatibility_level = Some(level);
        }
        node.children().for_each(|child| self.root_node(child));
      }
      "model" => {
        if let Some(culture) = node.text("culture") {
          self.model.culture = Some(culture);
        }
        node.children().for_each(|child| self.root_node(child));
      }
      "table" => self.table(node),
      "relationship" => self.relationship(node),
      "expression" => self.expression(node),
      "role" => self.role(node),
      "tablepermission" => {
        self.diag(node.line, format!("`tablePermission {}` must be declared inside a role.", node.name))
      }
      kind if TABLE_ONLY.contains(&kind) => self.diag(
        node.line,
        format!("`{kind} {}` must be declared inside a table: indent it under its `table`.", node.name),
      ),
      _ => {}
    }
  }

  fn compatibility_level(&mut self, prop: &Prop) {
    if let PropValue::Text(text) = &prop.value {
      match text.trim().parse::<u32>() {
        Ok(level) => self.model.compatibility_level = Some(level),
        Err(_) => self.diag(prop.line, format!("`compatibilityLevel: {text}` must be a whole number, such as 1567.")),
      }
    }
  }

  /// Whether `node` has a name, reporting it when it doesn't.
  fn named(&mut self, node: &Node, what: &str) -> bool {
    if node.name.trim().is_empty() {
      self.diag(node.line, format!("This {what} has no name: write `{} <name>`.", node.kind));
      return false;
    }
    true
  }

  /// Whether `node` is the first declaration of its name, reporting it when it isn't.
  fn first_declaration(
    &mut self,
    node: &Node,
    what: &str,
    seen: fn(&mut Self) -> &mut HashMap<String, String>,
  ) -> bool {
    let place = format!("{}:{}", self.file, node.line + 1);
    let key = node.name.to_lowercase();
    if let Some(previous) = seen(self).get(&key).cloned() {
      self.diag(node.line, format!("The {what} `{}` is declared more than once (also at {previous}).", node.name));
      return false;
    }
    seen(self).insert(key, place);
    true
  }

  /// Reports an `=` that no expression follows, on its line or the lines below: in the object's
  /// declaration, or in its expression property `property`.
  fn require_expressions(&mut self, node: &Node, property: &str) {
    if node.value.as_deref().is_some_and(|value| value.trim().is_empty()) && node.text(property).is_none() {
      self.empty_expression(node.line);
    }
    for prop in node.props().filter(|prop| prop.key == property) {
      if matches!(&prop.value, PropValue::Expr(text) if text.trim().is_empty()) {
        self.empty_expression(prop.line);
      }
    }
  }

  fn empty_expression(&mut self, line: usize) {
    self.diag(
      line,
      "No expression follows `=`: write it after `=`, or on the lines below, indented deeper than the object's properties.",
    );
  }

  fn table(&mut self, node: &Node) {
    if !self.named(node, "table") || !self.first_declaration(node, "table", |b| &mut b.tables) {
      return;
    }
    let mut table = Table {
      name: node.name.clone(),
      description: node.description.clone().or_else(|| node.text("description")),
      is_hidden: node.flag("ishidden").unwrap_or(false),
      calculation_group: node.flag("calculationgroup").unwrap_or(false),
      ..Table::default()
    };
    for child in node.children() {
      match child.kind.as_str() {
        "column" | "measure" | "partition" if !self.named(child, &child.kind) => {}
        "column" => {
          self.require_expressions(child, "expression");
          table.columns.push(column(child));
        }
        "measure" => {
          self.require_expressions(child, "expression");
          table.measures.push(measure(child));
        }
        "partition" => {
          self.require_expressions(child, "source");
          table.partitions.push(partition(child));
        }
        "hierarchy" => table.hierarchies.push(child.name.clone()),
        "calculationgroup" => table.calculation_group = true,
        kind if ROOT_ONLY.contains(&kind) => self.diag(
          child.line,
          format!(
            "`{kind} {}` can't be declared inside table `{}`: declare it at the top level, without indentation.",
            child.name, table.name
          ),
        ),
        _ => {}
      }
    }
    self.model.tables.push(table);
  }

  fn relationship(&mut self, node: &Node) {
    let from = self.endpoint(node, "fromColumn", "fromtable");
    let to = self.endpoint(node, "toColumn", "totable");
    let (Some((from_table, from_column)), Some((to_table, to_column))) = (from, to) else {
      return;
    };
    self.model.relationships.push(Relationship {
      name: node.name.clone(),
      from_table,
      from_column,
      to_table,
      to_column,
      from_cardinality: node.text("fromcardinality"),
      to_cardinality: node.text("tocardinality"),
      cross_filtering_behavior: node.text("crossfilteringbehavior"),
      is_active: node.flag("isactive").unwrap_or(true),
    });
  }

  /// One end of a relationship, split into table and column.
  fn endpoint(&mut self, node: &Node, property: &str, table_property: &str) -> Option<(String, String)> {
    let Some(prop) = node.prop(&property.to_ascii_lowercase()) else {
      self
        .diag(node.line, format!("Relationship `{}` has no `{property}`: add `{property}: Table.Column`.", node.name));
      return None;
    };
    let value = match &prop.value {
      PropValue::Text(text) | PropValue::Expr(text) => text.trim().to_string(),
      PropValue::Flag => String::new(),
    };
    if let Some(parts) = split_reference(&value) {
      return Some(parts);
    }
    if let (Some(table), false) = (node.text(table_property), value.is_empty()) {
      return Some((name_reference(&table), name_reference(&value)));
    }
    let line = prop.line;
    self.diag(
      line,
      format!(
        "Relationship `{}`: `{property}: {value}` must name a table and a column, as `Sales.CustomerKey` or `'My Table'.'My Column'`.",
        node.name
      ),
    );
    None
  }

  fn expression(&mut self, node: &Node) {
    if !self.named(node, "expression") || !self.first_declaration(node, "expression", |b| &mut b.expressions) {
      return;
    }
    self.require_expressions(node, "expression");
    let expression = node.expression("expression").unwrap_or_default();
    let (is_parameter, parameter_value) = parameter_info(&expression);
    self.model.expressions.push(NamedExpression { name: node.name.clone(), expression, is_parameter, parameter_value });
  }

  fn role(&mut self, node: &Node) {
    if !self.named(node, "role") || !self.first_declaration(node, "role", |b| &mut b.roles) {
      return;
    }
    let mut table_permissions = Vec::new();
    for child in node.children().filter(|child| child.kind == "tablepermission") {
      self.require_expressions(child, "filterexpression");
      table_permissions.push((child.name.clone(), child.expression("filterexpression").unwrap_or_default()));
    }
    self.model.roles.push(Role {
      name: node.name.clone(),
      model_permission: node.text("modelpermission"),
      table_permissions,
    });
  }
}

fn column(node: &Node) -> Column {
  Column {
    name: node.name.clone(),
    data_type: node.text("datatype"),
    is_hidden: node.flag("ishidden").unwrap_or(false),
    is_key: node.flag("iskey").unwrap_or(false),
    source_column: node.text("sourcecolumn"),
    expression: node.expression("expression"),
    format_string: node.text("formatstring"),
    data_category: node.text("datacategory"),
    display_folder: node.text("displayfolder"),
    summarize_by: node.text("summarizeby"),
    sort_by_column: node.text("sortbycolumn").map(|name| name_reference(&name)),
    description: node.description.clone().or_else(|| node.text("description")),
  }
}

fn measure(node: &Node) -> Measure {
  Measure {
    name: node.name.clone(),
    expression: node.expression("expression"),
    format_string: node.text("formatstring"),
    display_folder: node.text("displayfolder"),
    description: node.description.clone().or_else(|| node.text("description")),
    is_hidden: node.flag("ishidden").unwrap_or(false),
  }
}

fn partition(node: &Node) -> Partition {
  // Fabric writes an entity partition's source properties in a nested `source` object.
  let nested = node.children().find(|child| child.kind == "source");
  let text = |key: &str| node.text(key).or_else(|| nested.and_then(|source| source.text(key)));
  let kind = node.value.as_deref().and_then(non_empty).or_else(|| text("sourcetype"));
  let entity = kind.as_deref().is_some_and(|kind| kind.eq_ignore_ascii_case("entity"));
  let expression = node.text("source").or_else(|| text("query")).or_else(|| text("expression"));
  let source = if entity { text("entityname").or(expression) } else { expression };
  Partition {
    name: node.name.clone(),
    kind,
    mode: node.text("mode"),
    source,
    expression_source: text("expressionsource").map(|name| name_reference(&name)),
  }
}

fn non_empty(text: &str) -> Option<String> {
  let trimmed = text.trim();
  (!trimmed.is_empty()).then(|| text.to_string())
}

fn indent_width(line: &str) -> usize {
  let mut width = 0;
  for c in line.chars() {
    match c {
      ' ' => width += 1,
      '\t' => width += TAB_WIDTH,
      _ => break,
    }
  }
  width
}

/// `line` without up to `columns` columns of indentation.
fn strip_columns(line: &str, columns: usize) -> &str {
  let mut width = 0;
  for (i, c) in line.char_indices() {
    if width >= columns {
      return &line[i..];
    }
    match c {
      ' ' => width += 1,
      '\t' => width += TAB_WIDTH,
      _ => return &line[i..],
    }
  }
  ""
}

/// A multi-line expression as a user reads it: without the common indentation, trailing whitespace,
/// or leading and trailing blank lines.
fn dedent(lines: &[Line]) -> String {
  let common = lines.iter().filter(|l| !l.content.is_empty()).map(|l| l.indent).min().unwrap_or(0);
  let text: Vec<&str> =
    lines.iter().map(|l| if l.content.is_empty() { "" } else { strip_columns(l.raw, common).trim_end() }).collect();
  let first = text.iter().position(|l| !l.is_empty()).unwrap_or(text.len());
  let last = text.iter().rposition(|l| !l.is_empty()).map_or(first, |i| i + 1);
  text[first..last.max(first)].join("\n")
}

/// A fenced expression: its lines verbatim, without their common indentation.
fn dedent_verbatim(lines: &[&str]) -> String {
  let common = lines.iter().filter(|l| !l.trim().is_empty()).map(|l| indent_width(l)).min().unwrap_or(0);
  lines.iter().map(|l| strip_columns(l, common)).collect::<Vec<_>>().join("\n")
}

/// A text property's value: double quotes removed, `""` read as `"`.
fn unquote_text(value: &str) -> String {
  if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
    value[1..value.len() - 1].replace("\"\"", "\"")
  } else {
    value.to_string()
  }
}

/// Reads an object name at the start of `text`: `'quoted'` (with `''` for a quote) or a bare word.
/// Returns the name and the text after it.
fn parse_name(text: &str) -> Result<(String, &str), String> {
  if let Some(body) = text.strip_prefix('\'') {
    let mut name = String::new();
    let mut chars = body.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
      if c != '\'' {
        name.push(c);
      } else if matches!(chars.peek(), Some((_, '\''))) {
        chars.next();
        name.push('\'');
      } else {
        return Ok((name, &body[i + 1..]));
      }
    }
    return Err(format!(
      "The name {} is missing its closing quote ('). Write a quote inside a name as two quotes ('').",
      shorten(text)
    ));
  }
  let end = text.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(text.len());
  Ok((text[..end].to_string(), &text[end..]))
}

/// A name written in a reference, unquoted.
fn name_reference(text: &str) -> String {
  let text = text.trim();
  match parse_name(text) {
    Ok((name, rest)) if text.starts_with('\'') && rest.trim().is_empty() => name,
    _ => text.to_string(),
  }
}

/// Splits a qualified column reference (`Sales.'Product Key'`, `'My Table'.Col`, `'A.B'.C`,
/// `Sales[Amount]`) into table and column.
fn split_reference(text: &str) -> Option<(String, String)> {
  let text = text.trim();
  let (table, rest) = if text.starts_with('\'') {
    parse_name(text).ok()?
  } else {
    let end = text.find(['.', '['])?;
    (text[..end].trim().to_string(), &text[end..])
  };
  let rest = rest.trim_start();
  let column = if let Some(column) = rest.strip_prefix('.') {
    let column = column.trim();
    if column.starts_with('\'') {
      let (name, tail) = parse_name(column).ok()?;
      if !tail.trim().is_empty() {
        return None;
      }
      name
    } else {
      column.to_string()
    }
  } else {
    rest.strip_prefix('[')?.strip_suffix(']')?.trim().to_string()
  };
  (!table.is_empty() && !column.is_empty()).then_some((table, column))
}

fn inline_compatibility_level(text: &str) -> Option<u32> {
  static LEVEL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)compatibilityLevel\s*:\s*(\d+)").unwrap());
  LEVEL.captures(text)?.get(1)?.as_str().parse().ok()
}

/// Whether an M expression is a parameter, and its value.
fn parameter_info(expression: &str) -> (bool, Option<String>) {
  static IS_PARAMETER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bIsParameterQuery\s*=\s*true\b").unwrap());
  let Some(at) = find_meta(expression) else {
    return (false, None);
  };
  if !IS_PARAMETER.is_match(&expression[at..]) {
    return (false, None);
  }
  let value = expression[..at].trim();
  (true, Some(m_text_literal(value).unwrap_or_else(|| value.to_string())))
}

/// Where the last `meta [` outside string literals starts.
fn find_meta(expression: &str) -> Option<usize> {
  let bytes = expression.as_bytes();
  let mut found = None;
  let mut in_string = false;
  let mut i = 0;
  while i < bytes.len() {
    let b = bytes[i];
    if b == b'"' {
      in_string = !in_string;
    } else if !in_string
      && bytes[i..].starts_with(b"meta")
      && (i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_' || bytes[i - 1] == b'.'))
    {
      let after = bytes[i + 4..].iter().position(|b| !b.is_ascii_whitespace()).map(|n| i + 4 + n);
      if after.is_some_and(|j| bytes[j] == b'[') {
        found = Some(i);
      }
    }
    i += 1;
  }
  found
}

/// The text of an M string literal (`"a ""b"""` → `a "b"`), if `value` is exactly one.
fn m_text_literal(value: &str) -> Option<String> {
  let inner = value.strip_prefix('"')?.strip_suffix('"')?;
  let mut text = String::new();
  let mut chars = inner.chars().peekable();
  while let Some(c) = chars.next() {
    if c == '"' && chars.next() != Some('"') {
      return None;
    }
    text.push(c);
  }
  Some(text)
}

/// The start of a long line, for messages.
fn shorten(text: &str) -> String {
  const MAX: usize = 60;
  if text.chars().count() <= MAX {
    text.to_string()
  } else {
    format!("{}…", text.chars().take(MAX).collect::<String>())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn files(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter().map(|(path, text)| (path.to_string(), text.to_string())).collect()
  }

  fn parse(list: &[(&str, &str)]) -> Model {
    parse_definition(&files(list)).unwrap_or_else(|diags| panic!("unexpected diagnostics: {diags:#?}"))
  }

  fn diagnostics(list: &[(&str, &str)]) -> Vec<Diagnostic> {
    match parse_definition(&files(list)) {
      Ok(model) => panic!("expected diagnostics, got {model:#?}"),
      Err(diags) => diags,
    }
  }

  fn table<'m>(model: &'m Model, name: &str) -> &'m Table {
    model.tables.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("no table {name}"))
  }

  /// The sample from Microsoft's TMDL overview, with valid indentation.
  const MICROSOFT_SAMPLE: &str = r#"database Sales
    compatibilityLevel: 1567

model Model
    culture: en-US

table Sales

    partition 'Sales-Partition' = m
        mode: import
        source =
            let
                Source = Sql.Database(Server, Database)
            in
                Source

    measure 'Sales Amount' = SUMX('Sales', 'Sales'[Quantity] * 'Sales'[Net Price])
        formatString: $ #,##0

    column 'Product Key'
        dataType: int64
        isHidden
        sourceColumn: ProductKey
        summarizeBy: None

    column Quantity
        dataType: int64
        isHidden
        sourceColumn: Quantity
        summarizeBy: None

    column 'Net Price'
        dataType: int64
        isHidden
        sourceColumn: "Net Price"
        summarizeBy: none

table Product

    partition 'Product-Partition' = m
        mode: import
        source =
            let
                Source = Sql.Database(Server, Database)
            in
                Source

    column 'Product Key'
        dataType: int64
        isKey
        sourceColumn: ProductKey
        summarizeBy: none

relationship cdb6e6a9-c9d1-42b9-b9e0-484a1bc7e123
    fromColumn: Sales.'Product Key'
    toColumn: Product.'Product Key'

role Role_Store1
    modelPermission: read

    tablePermission Store = 'Store'[Store Code] IN {1,10,20,30}

expression Server = "localhost" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]

expression Database = "Contoso" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]
"#;

  /// A table as Fabric serializes it: tabs, lineage tags, annotations.
  const FABRIC_SALES: &str = "table Sales\n\
    \tlineageTag: e9374b9a-faee-4f9e-b2e7-d9aafb9d6a91\n\
    \n\
    \tmeasure 'Sales Amount' =\n\
    \t\t\tvar result = SUMX('Sales', [Quantity] * [Net Price])\n\
    \t\t\treturn result\n\
    \t\tformatString: $ #,##0\n\
    \t\tlineageTag: 1f8f1a2a-06b6-4989-8af7-212719cf3617\n\
    \n\
    \tcolumn 'Product Key'\n\
    \t\tdataType: int64\n\
    \t\tisHidden\n\
    \t\tformatString: 0\n\
    \t\tlineageTag: 7c3b0d5e-0000-4000-8000-000000000001\n\
    \t\tsummarizeBy: none\n\
    \t\tsourceColumn: ProductKey\n\
    \n\
    \t\tannotation SummarizationSetBy = Automatic\n\
    \n\
    \tpartition Sales = m\n\
    \t\tmode: import\n\
    \t\tsource =\n\
    \t\t\t\tlet\n\
    \t\t\t\t    Source = Snowflake.Databases(Server, Warehouse),\n\
    \n\
    \t\t\t\t    DB = Source{[Name=\"SALES\",Kind=\"Database\"]}[Data]   \n\
    \t\t\t\tin\n\
    \t\t\t\t    DB\n\
    \n\
    \tannotation PBI_ResultType = Table\n";

  #[test]
  fn reads_the_microsoft_sample() {
    let model = parse(&[("definition/model.tmdl", MICROSOFT_SAMPLE)]);
    assert_eq!(model.compatibility_level, Some(1567));
    assert_eq!(model.culture.as_deref(), Some("en-US"));
    assert_eq!(model.tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["Sales", "Product"]);

    let sales = table(&model, "Sales");
    assert_eq!(sales.columns.len(), 3);
    assert_eq!(sales.measures.len(), 1);
    assert_eq!(sales.measures[0].name, "Sales Amount");
    assert_eq!(sales.measures[0].expression.as_deref(), Some("SUMX('Sales', 'Sales'[Quantity] * 'Sales'[Net Price])"));
    assert_eq!(sales.measures[0].format_string.as_deref(), Some("$ #,##0"));
    let net_price = &sales.columns[2];
    assert_eq!(net_price.name, "Net Price");
    assert_eq!(net_price.source_column.as_deref(), Some("Net Price"));
    assert!(net_price.is_hidden);
    assert_eq!(net_price.data_type.as_deref(), Some("int64"));
    let partition = &sales.partitions[0];
    assert_eq!(partition.name, "Sales-Partition");
    assert_eq!(partition.kind.as_deref(), Some("m"));
    assert_eq!(partition.mode.as_deref(), Some("import"));
    assert_eq!(partition.source.as_deref(), Some("let\n    Source = Sql.Database(Server, Database)\nin\n    Source"));
    assert!(table(&model, "Product").columns[0].is_key);

    let relationship = &model.relationships[0];
    assert_eq!(relationship.name, "cdb6e6a9-c9d1-42b9-b9e0-484a1bc7e123");
    assert_eq!((relationship.from_table.as_str(), relationship.from_column.as_str()), ("Sales", "Product Key"));
    assert_eq!((relationship.to_table.as_str(), relationship.to_column.as_str()), ("Product", "Product Key"));
    assert!(relationship.is_active);
    assert_eq!(relationship.from_cardinality, None);

    assert_eq!(
      model.roles,
      vec![Role {
        name: "Role_Store1".into(),
        model_permission: Some("read".into()),
        table_permissions: vec![("Store".into(), "'Store'[Store Code] IN {1,10,20,30}".into())],
      }]
    );
    assert_eq!(model.expressions.len(), 2);
    assert!(model.expressions.iter().all(|e| e.is_parameter));
    assert_eq!(model.expressions[0].parameter_value.as_deref(), Some("localhost"));
    assert_eq!(model.expressions[1].name, "Database");
    assert_eq!(model.expressions[1].parameter_value.as_deref(), Some("Contoso"));
  }

  #[test]
  fn reads_fabric_serialization() {
    let model = parse(&[("definition/tables/Sales.tmdl", FABRIC_SALES)]);
    let sales = table(&model, "Sales");
    let measure = &sales.measures[0];
    assert_eq!(
      measure.expression.as_deref(),
      Some("var result = SUMX('Sales', [Quantity] * [Net Price])\nreturn result")
    );
    assert_eq!(measure.format_string.as_deref(), Some("$ #,##0"));
    let column = &sales.columns[0];
    assert_eq!(column.name, "Product Key");
    assert!(column.is_hidden);
    assert_eq!(column.format_string.as_deref(), Some("0"));
    assert_eq!(column.summarize_by.as_deref(), Some("none"));
    assert_eq!(column.source_column.as_deref(), Some("ProductKey"));
    let partition = &sales.partitions[0];
    assert_eq!(partition.mode.as_deref(), Some("import"));
    assert_eq!(
      partition.source.as_deref(),
      Some(
        "let\n    Source = Snowflake.Databases(Server, Warehouse),\n\n    \
         DB = Source{[Name=\"SALES\",Kind=\"Database\"]}[Data]\nin\n    DB"
      )
    );
    assert_eq!(sales.columns.len(), 1);
    assert_eq!(sales.partitions.len(), 1);
  }

  #[test]
  fn reads_backtick_fenced_expressions() {
    let text = "table T\n\
      \tmeasure M = ```\n\
      \t\t\tVAR x = 1\n\
      \n\
      \t\t\t    RETURN   x   \n\
      \t\t\t```\n\
      \t\tformatString: 0\n\
      \tmeasure Inline = ```SUM(T[A])```\n\
      \tpartition T = m\n\
      \t\tmode: import\n\
      \t\tsource = ```\n\
      \t\t\t\tlet\n\
      \tnot a property, still M\n\
      \t\t\t\tin\n\
      \t\t\t\t    1\n\
      \t\t\t\t```\n\
      \tcolumn C\n\
      \t\tdataType: string\n";
    let model = parse(&[("definition/tables/T.tmdl", text)]);
    let t = table(&model, "T");
    assert_eq!(t.measures[0].expression.as_deref(), Some("VAR x = 1\n\n    RETURN   x   "));
    assert_eq!(t.measures[0].format_string.as_deref(), Some("0"));
    assert_eq!(t.measures[1].expression.as_deref(), Some("SUM(T[A])"));
    assert_eq!(t.partitions[0].source.as_deref(), Some("\t\t\tlet\nnot a property, still M\n\t\t\tin\n\t\t\t    1"));
    assert_eq!(t.columns[0].data_type.as_deref(), Some("string"));
  }

  #[test]
  fn reads_descriptions_and_quoted_names() {
    let text = "/// Sales facts\n\
      /// One row per order line\n\
      table 'Sales ''Facts'''\n\
      \t/// The amount, in dollars\n\
      \tmeasure 'Amount (USD)' = SUM('Sales ''Facts'''[Amount])\n\
      \tcolumn 'Order.Date'\n\
      \t\tdataType: dateTime\n\
      \t\tsortByColumn: 'Order Key'\n\
      \t\tdisplayFolder: \" My \"\"Amazing\"\" Dates\"\n\
      \t/// Not attached: a blank line follows.\n\
      \n\
      \tcolumn 'It''s' = 1\n\
      \t\tisHidden: false\n";
    let model = parse(&[("definition/tables/Sales.tmdl", text)]);
    let t = table(&model, "Sales 'Facts'");
    assert_eq!(t.description.as_deref(), Some("Sales facts\nOne row per order line"));
    assert_eq!(t.measures[0].name, "Amount (USD)");
    assert_eq!(t.measures[0].description.as_deref(), Some("The amount, in dollars"));
    assert_eq!(t.measures[0].expression.as_deref(), Some("SUM('Sales ''Facts'''[Amount])"));
    assert_eq!(t.columns[0].name, "Order.Date");
    assert_eq!(t.columns[0].sort_by_column.as_deref(), Some("Order Key"));
    assert_eq!(t.columns[0].display_folder.as_deref(), Some(" My \"Amazing\" Dates"));
    assert_eq!(t.columns[1].name, "It's");
    assert_eq!(t.columns[1].description, None);
    assert!(!t.columns[1].is_hidden);
  }

  #[test]
  fn splits_qualified_references_in_relationships() {
    let text = "relationship 5d2b0c1e-6a8f-4b7e-9c3d-2f1a0b9c8d7e\n\
      \tfromColumn: Sales.'Product Key'\n\
      \ttoColumn: 'My Table'.Col\n\
      \n\
      relationship r2\n\
      \tisActive: false\n\
      \tfromColumn: 'A.B'.C\n\
      \ttoColumn: Product[Key]\n\
      \tfromCardinality: one\n\
      \ttoCardinality: many\n\
      \tcrossFilteringBehavior: bothDirections\n\
      \n\
      relationship r3\n\
      \tfromColumn: 'It''s'.'x.y'\n\
      \ttoColumn: Sales.Amount\n\
      \tisActive\n";
    let model = parse(&[("definition/relationships.tmdl", text)]);
    let ends =
      |r: &Relationship| (r.from_table.clone(), r.from_column.clone(), r.to_table.clone(), r.to_column.clone());
    let r = &model.relationships;
    assert_eq!(ends(&r[0]), ("Sales".into(), "Product Key".into(), "My Table".into(), "Col".into()));
    assert!(r[0].is_active);
    assert_eq!(ends(&r[1]), ("A.B".into(), "C".into(), "Product".into(), "Key".into()));
    assert!(!r[1].is_active);
    assert_eq!(r[1].from_cardinality.as_deref(), Some("one"));
    assert_eq!(r[1].to_cardinality.as_deref(), Some("many"));
    assert_eq!(r[1].cross_filtering_behavior.as_deref(), Some("bothDirections"));
    assert_eq!(ends(&r[2]), ("It's".into(), "x.y".into(), "Sales".into(), "Amount".into()));
    assert!(r[2].is_active);
  }

  #[test]
  fn reads_calculated_columns_calculated_tables_and_direct_lake() {
    let margins = "table Margins\n\
      \tcolumn Margin = [Price] - [Cost]\n\
      \t\tdataType: double\n\
      \t\tformatString: 0.00\n\
      \t\tisHidden: true\n\
      \tcolumn Price\n\
      \t\tdataType: double\n\
      \t\tsourceColumn: Price\n\
      \tpartition Margins = calculated\n\
      \t\tmode: import\n\
      \t\tsource = FILTER(Products, [Price] > 0)\n";
    let lake = "table sales\n\
      \tpartition sales = entity\n\
      \t\tmode: directLake\n\
      \t\tentityName: sales\n\
      \t\texpressionSource: DatabaseQuery\n\
      \n\
      table orders\n\
      \tpartition orders = entity\n\
      \t\tmode: directLake\n\
      \t\tsource\n\
      \t\t\tentityName: orders\n\
      \t\t\tschemaName: dbo\n\
      \t\t\texpressionSource: 'Database Query'\n";
    let model = parse(&[("definition/tables/Margins.tmdl", margins), ("definition/tables/sales.tmdl", lake)]);
    let t = table(&model, "Margins");
    assert_eq!(t.columns[0].expression.as_deref(), Some("[Price] - [Cost]"));
    assert_eq!(t.columns[0].data_type.as_deref(), Some("double"));
    assert!(t.columns[0].is_hidden);
    assert_eq!(t.columns[1].expression, None);
    assert_eq!(t.partitions[0].kind.as_deref(), Some("calculated"));
    assert_eq!(t.partitions[0].source.as_deref(), Some("FILTER(Products, [Price] > 0)"));

    let sales = &table(&model, "sales").partitions[0];
    assert_eq!(sales.kind.as_deref(), Some("entity"));
    assert_eq!(sales.mode.as_deref(), Some("directLake"));
    assert_eq!(sales.source.as_deref(), Some("sales"));
    assert_eq!(sales.expression_source.as_deref(), Some("DatabaseQuery"));
    let orders = &table(&model, "orders").partitions[0];
    assert_eq!(orders.source.as_deref(), Some("orders"));
    assert_eq!(orders.expression_source.as_deref(), Some("Database Query"));
  }

  #[test]
  fn reads_parameters_and_shared_expressions() {
    let text = "expression Server = \"xy.snowflakecomputing.com\" meta [IsParameterQuery=true, Type=\"Text\", IsParameterQueryRequired=true]\n\
      \tlineageTag: 3f0f2a7c\n\
      \tqueryGroup: Parameters\n\
      \n\
      \tannotation PBI_ResultType = Text\n\
      \n\
      expression Port = 443 meta [IsParameterQuery=true, Type=\"Number\", IsParameterQueryRequired=true]\n\
      \n\
      expression 'Quoted \"\"Name\"\"' = \"a \"\"b\"\"\" meta [IsParameterQuery=true, Type=\"Text\"]\n\
      \n\
      expression DatabaseQuery =\n\
      \t\tlet\n\
      \t\t    database = Sql.Database(\"x.datawarehouse.fabric.microsoft.com\", \"wh\")\n\
      \t\tin\n\
      \t\t    database\n\
      \tlineageTag: 9d1e\n";
    let model = parse(&[("definition/expressions.tmdl", text)]);
    let e = &model.expressions;
    assert_eq!(e.len(), 4);
    assert_eq!(e[0].name, "Server");
    assert!(e[0].is_parameter);
    assert_eq!(e[0].parameter_value.as_deref(), Some("xy.snowflakecomputing.com"));
    assert!(e[0].expression.starts_with("\"xy.snowflakecomputing.com\" meta [IsParameterQuery=true"));
    assert_eq!(e[1].parameter_value.as_deref(), Some("443"));
    assert_eq!(e[2].name, "Quoted \"\"Name\"\"");
    assert_eq!(e[2].parameter_value.as_deref(), Some("a \"b\""));
    assert!(!e[3].is_parameter);
    assert_eq!(e[3].parameter_value, None);
    assert_eq!(
      e[3].expression,
      "let\n    database = Sql.Database(\"x.datawarehouse.fabric.microsoft.com\", \"wh\")\nin\n    database"
    );
  }

  #[test]
  fn reads_roles() {
    let text = "role 'Store Managers'\n\
      \tmodelPermission: read\n\
      \n\
      \ttablePermission Store = 'Store'[Region] = \"West\"\n\
      \n\
      \ttablePermission 'Sales Facts' =\n\
      \t\t\tVAR r = USERPRINCIPALNAME()\n\
      \t\t\tRETURN 'Sales Facts'[Owner] = r\n\
      \n\
      \tannotation PBI_Id = 123\n";
    let model = parse(&[("definition/roles/Store Managers.tmdl", text)]);
    assert_eq!(model.roles[0].name, "Store Managers");
    assert_eq!(model.roles[0].model_permission.as_deref(), Some("read"));
    assert_eq!(
      model.roles[0].table_permissions,
      vec![
        ("Store".to_string(), "'Store'[Region] = \"West\"".to_string()),
        ("Sales Facts".to_string(), "VAR r = USERPRINCIPALNAME()\nRETURN 'Sales Facts'[Owner] = r".to_string()),
      ]
    );
  }

  #[test]
  fn reads_crlf_and_bom_and_ignores_other_files() {
    let text = format!("\u{feff}{}", FABRIC_SALES.replace('\n', "\r\n"));
    let model = parse(&[
      ("definition/tables/Sales.tmdl", &text),
      ("definition.pbism", "{ not tmdl"),
      (".platform", "{}"),
      ("tables/Other.tmdl", "table Other"),
      ("definition/notes.md", "this is not valid"),
    ]);
    assert_eq!(model.tables.len(), 1);
    let sales = table(&model, "Sales");
    assert_eq!(
      sales.measures[0].expression.as_deref(),
      Some("var result = SUMX('Sales', [Quantity] * [Net Price])\nreturn result")
    );
    assert!(sales.partitions[0].source.as_deref().is_some_and(|s| s.ends_with("in\n    DB")));
    assert_eq!(sales.columns[0].source_column.as_deref(), Some("ProductKey"));
  }

  #[test]
  fn skips_objects_it_does_not_model() {
    let calendar = "table Calendar\n\
      \tlineageTag: abc\n\
      \n\
      \tcolumn Date\n\
      \t\tdataType: dateTime\n\
      \t\tisKey\n\
      \t\tformatString: Long Date\n\
      \t\tsourceColumn: Date\n\
      \t\tchangedProperty = IsHidden\n\
      \n\
      \t\tvariation Variation\n\
      \t\t\tisDefault\n\
      \t\t\trelationship: 0a1b\n\
      \t\t\tdefaultHierarchy: LocalDateTable.'Date Hierarchy'\n\
      \n\
      \t\tannotation UnderlyingDateTimeDataType = Date\n\
      \n\
      \thierarchy 'Calendar Hierarchy'\n\
      \t\tlineageTag: def\n\
      \n\
      \t\tlevel Year\n\
      \t\t\tcolumn: Year\n\
      \n\
      \t\tlevel Month\n\
      \t\t\tcolumn: Month\n\
      \n\
      \textendedProperty ParameterMetadata =\n\
      \t\t\t{\n\
      \t\t\t  \"version\": 0,\n\
      \t\t\t  \"kind\": 2\n\
      \t\t\t}\n\
      \n\
      \tpartition Calendar = m\n\
      \t\tmode: import\n\
      \t\tsource = Calendar\n";
    let time = "table 'Time Intelligence'\n\
      \tcalculationGroup\n\
      \t\tprecedence: 1\n\
      \n\
      \t\tcalculationItem YTD = CALCULATE(SELECTEDMEASURE(), DATESYTD('Calendar'[Date]))\n\
      \n\
      \t\tcalculationItem PY =\n\
      \t\t\t\tCALCULATE(\n\
      \t\t\t\t    SELECTEDMEASURE(),\n\
      \t\t\t\t    SAMEPERIODLASTYEAR('Calendar'[Date])\n\
      \t\t\t\t)\n\
      \t\t\tformatStringDefinition = SELECTEDMEASUREFORMATSTRING()\n\
      \n\
      \tcolumn Name\n\
      \t\tdataType: string\n\
      \t\tsourceColumn: Name\n\
      \n\
      \tpartition 'Time Intelligence' = calculationGroup\n";
    let model_file = "model Model\n\
      \tculture: en-US\n\
      \tdefaultPowerBIDataSourceVersion: powerBI_V3\n\
      \tdataAccessOptions\n\
      \t\tlegacyRedirects\n\
      \t\treturnErrorValuesAsNull\n\
      \n\
      queryGroup Parameters\n\
      \n\
      \tannotation PBI_QueryGroupOrder = 0\n\
      \n\
      annotation PBI_QueryOrder = [\"Calendar\"]\n\
      \n\
      ref table Calendar\n\
      ref table 'Time Intelligence'\n\
      ref cultureInfo en-US\n";
    let culture = "cultureInfo en-US\n\
      \n\
      \tlinguisticMetadata =\n\
      \t\t\t{\n\
      \t\t\t  \"Version\": \"1.0.0\"\n\
      \t\t\t}\n\
      \t\tcontentType: json\n";
    let perspective = "perspective Sales\n\tperspectiveTable Calendar\n\t\tperspectiveColumn Date\n";
    let database = "database\n\tcompatibilityLevel: 1604\n";
    let model = parse(&[
      ("definition/tables/Time Intelligence.tmdl", time),
      ("definition/tables/Calendar.tmdl", calendar),
      ("definition/model.tmdl", model_file),
      ("definition/cultures/en-US.tmdl", culture),
      ("definition/perspectives/Sales.tmdl", perspective),
      ("definition/database.tmdl", database),
    ]);
    assert_eq!(model.compatibility_level, Some(1604));
    assert_eq!(model.culture.as_deref(), Some("en-US"));
    assert_eq!(model.tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["Calendar", "Time Intelligence"]);
    let calendar = table(&model, "Calendar");
    assert_eq!(calendar.hierarchies, ["Calendar Hierarchy"]);
    assert_eq!(calendar.columns.len(), 1);
    assert!(calendar.columns[0].is_key);
    assert_eq!(calendar.columns[0].format_string.as_deref(), Some("Long Date"));
    assert_eq!(calendar.partitions[0].source.as_deref(), Some("Calendar"));
    assert!(!calendar.calculation_group);
    let time = table(&model, "Time Intelligence");
    assert!(time.calculation_group);
    assert_eq!(time.columns.len(), 1);
    assert_eq!(time.partitions[0].kind.as_deref(), Some("calculationGroup"));
    assert!(time.measures.is_empty());
  }

  #[test]
  fn reports_broken_definitions_with_file_and_line() {
    let fence = "table T\n\tmeasure M = ```\n\t\t\tSUM(T[A])\n\tcolumn C\n\t\tdataType: string\n";
    let diags = diagnostics(&[("definition/tables/T.tmdl", fence)]);
    assert_eq!(diags.len(), 1);
    assert_eq!((diags[0].file.as_str(), diags[0].line), ("definition/tables/T.tmdl", 2));
    assert!(diags[0].message.contains("```"));

    let garbage = "table T\n\tcolumn C\n\t\tdataType: string\n\tthis is not valid\n\t} oops\n\tcolumn D\n";
    let diags = diagnostics(&[("definition/tables/T.tmdl", garbage)]);
    assert_eq!(diags.iter().map(|d| d.line).collect::<Vec<_>>(), [4, 5]);

    let relationships = "relationship r1\n\tfromColumn: Sales.CustomerKey\n\nrelationship r2\n\tfromColumn: CustomerKey\n\ttoColumn: Customer.CustomerKey\n";
    let diags = diagnostics(&[("definition/relationships.tmdl", relationships)]);
    assert_eq!(diags.iter().map(|d| d.line).collect::<Vec<_>>(), [1, 5]);
    assert!(diags[0].message.contains("toColumn"));
    assert!(diags[1].message.contains("fromColumn"));

    let diags = diagnostics(&[
      ("definition/tables/B.tmdl", "\n\ntable sales\n\tcolumn X\n"),
      ("definition/tables/A.tmdl", "table Sales\n\tcolumn X\n"),
    ]);
    assert_eq!(diags.len(), 1);
    assert_eq!((diags[0].file.as_str(), diags[0].line), ("definition/tables/B.tmdl", 3));
    assert!(diags[0].message.contains("definition/tables/A.tmdl:1"));

    let misplaced = "dataType: int64\ncolumn X\n\tdataType: string\ntable T\n\ttable U\n";
    let diags = diagnostics(&[("definition/tables/T.tmdl", misplaced)]);
    assert_eq!(diags.iter().map(|d| d.line).collect::<Vec<_>>(), [1, 2, 5]);

    let empty = "table T\n\tmeasure M =\n\tcolumn C\n\t\tdataType: string\n\tpartition T = m\n\t\tmode: import\n\t\tsource =\n\t\tlet\n\t\t\tSource = 1\n\t\tin\n\t\t\tSource\n";
    let diags = diagnostics(&[("definition/tables/T.tmdl", empty)]);
    assert_eq!(diags.iter().map(|d| d.line).collect::<Vec<_>>(), [2, 7]);

    let quote = "table 'Sales\n\tcolumn X\n";
    assert_eq!(diagnostics(&[("definition/tables/T.tmdl", quote)])[0].line, 1);
  }

  #[test]
  fn reads_database_forms() {
    let level = |text: &str| parse(&[("definition/database.tmdl", text)]).compatibility_level;
    assert_eq!(level("database Sales compatibilityLevel: 1567\n"), Some(1567));
    assert_eq!(level("database 'Sales Model'\n\tcompatibilityLevel: 1601\n"), Some(1601));
    assert_eq!(level("database Sales\ncompatibilityLevel: 1550\n"), Some(1550));
    assert_eq!(level("database\n"), None);
  }

  #[test]
  fn orders_objects_by_file_path_then_position() {
    let model = parse(&[
      ("definition/tables/b.tmdl", "table B2\ntable B1\n"),
      ("definition/tables/a.tmdl", "table A\n"),
      ("definition/model.tmdl", "model Model\n\nref table B1\nref table A\n"),
    ]);
    assert_eq!(model.tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["A", "B2", "B1"]);
  }

  #[test]
  fn never_panics() {
    let samples = [
      MICROSOFT_SAMPLE,
      FABRIC_SALES,
      "'",
      "table '",
      "measure X = ```",
      "table T\n\tmeasure X = ```x",
      "\u{feff}",
      "\t\t\t",
      "relationship r\n\tfromColumn: '\n\ttoColumn: 'a'.\n",
      "expression E = \"abc\" meta [",
      "expression E = meta [IsParameterQuery=true]",
      "table é\n\tcolumn ü = ```é```\n\t\tdataType: ü\n",
      "database Sales compatibilityLevel: 99999999999999999999",
      "///\n///",
      "=\n:\n```\n",
    ];
    for sample in samples {
      let text: Vec<char> = sample.chars().collect();
      for end in 0..=text.len() {
        let prefix: String = text[..end].iter().collect();
        let _ = parse_definition(&files(&[("definition/x.tmdl", &prefix)]));
        let shifted: String = prefix.replace('\t', " ");
        let _ = parse_definition(&files(&[("definition/x.tmdl", &shifted)]));
      }
    }
  }
}
