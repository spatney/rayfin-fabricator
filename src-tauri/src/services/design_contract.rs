//! Version-one Design Studio wire contracts. Runtime DOM state never belongs in
//! a draft; only bounded, JSON-serializable transactions cross this boundary.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::DeployResult;

pub const MAX_DRAFT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_WIRE_BYTES: usize = 24 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_HISTORY_BYTES: usize = 1_800_000;
pub const MAX_TRANSACTIONS: usize = 300;
pub const MAX_EDITS: usize = 4000;
pub const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignTarget {
  pub id: String,
  pub selector: String,
  pub tag: String,
  pub label: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub text: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub parent_selector: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub role: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub aria_label: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub component: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesignEditKind {
  Style,
  Text,
  Remove,
  Reorder,
  Insert,
  Image,
  Theme,
  Chart,
  Comment,
  Annotation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignEdit {
  pub kind: DesignEditKind,
  pub target: DesignTarget,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub property: Option<String>,
  pub before: Value,
  pub after: Value,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignTransaction {
  pub id: String,
  pub label: String,
  pub route: String,
  pub edits: Vec<DesignEdit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesignSource {
  Local,
  Direct,
  Fabric,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesignTool {
  Select,
  Interact,
  Comment,
  Draw,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ApplyPhase {
  Editing,
  SourceUpdated,
  Deploying,
  Deployed,
  NeedsReview,
  Error,
  Interrupted,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignApplyReceipt {
  pub id: String,
  pub project_id: String,
  pub draft_revision: u64,
  /// Design Apply uses its Apply ID as the normal chat event turn ID.
  pub turn_id: String,
  pub phase: ApplyPhase,
  pub source_revision_before: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub source_revision_after: Option<String>,
  pub files_modified: Vec<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub deployment: Option<DeployResult>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignDraft {
  pub schema_version: u32,
  pub project_id: String,
  pub session_id: String,
  pub revision: u64,
  pub source: DesignSource,
  pub route: String,
  pub source_revision: String,
  pub history: Vec<DesignTransaction>,
  pub cursor: usize,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub viewport_width: Option<f64>,
  /// Last accepted Apply bookmark. The separate receipt store owns pending
  /// work; merging that state here would hide an interrupted/unapplied draft.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub receipt: Option<DesignApplyReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignAsset {
  pub id: String,
  pub name: String,
  pub mime: String,
  pub size: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub project_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignConnection {
  pub session_id: String,
  pub embedded: bool,
  pub app_url: String,
  pub history: Vec<DesignTransaction>,
  pub cursor: usize,
  pub revision: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub route: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub asset_previews: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignImageSelection {
  pub src: String,
  pub alt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignChartType {
  pub value: String,
  pub label: String,
  pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignChartSelection {
  pub spec: BTreeMap<String, Value>,
  pub types: Vec<DesignChartType>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignSelection {
  #[serde(flatten)]
  pub target: DesignTarget,
  pub styles: BTreeMap<String, String>,
  pub inline_styles: BTreeMap<String, String>,
  pub text_editable: bool,
  pub own_text: String,
  pub width: f64,
  pub height: f64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub parent: Option<DesignTarget>,
  pub children: Vec<DesignTarget>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub image: Option<DesignImageSelection>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub chart: Option<DesignChartSelection>,
  pub can_contain: bool,
  pub can_reorder: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenKind {
  Color,
  Length,
  Font,
  Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignToken {
  pub name: String,
  pub value: String,
  pub kind: TokenKind,
  pub target: DesignTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignConflict {
  pub transaction_id: String,
  pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignVerification {
  pub transaction_id: String,
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignViewport {
  pub width: f64,
  pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignSnapshot {
  pub protocol: u32,
  pub session_id: String,
  pub document_id: String,
  pub revision: u64,
  pub enabled: bool,
  pub route: String,
  pub tool: DesignTool,
  pub compare: bool,
  pub selection: Vec<DesignSelection>,
  pub layers: Vec<DesignTarget>,
  pub tokens: Vec<DesignToken>,
  pub breakpoints: Vec<String>,
  pub viewport: DesignViewport,
  pub history: Vec<DesignTransaction>,
  pub cursor: usize,
  pub conflicts: Vec<DesignConflict>,
  pub acknowledged: Vec<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub notice: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub verification: Option<Vec<DesignVerification>>,
}

/// Commands are validated as an exact tagged object before eval. Keeping the
/// body as JSON preserves the existing optional restyle/Graphein wire shapes.
#[derive(Debug, Clone)]
pub struct ValidatedCommand {
  pub value: Value,
  pub session_id: String,
  pub document_id: String,
  pub command_id: String,
}

pub fn bounded(value: &str, max: usize, name: &str) -> Result<(), String> {
  if value.len() > max || value.contains('\0') {
    Err(format!("Design {name} exceeds its budget or contains a null byte."))
  } else {
    Ok(())
  }
}

pub fn identity(value: &str) -> Result<(), String> {
  if value.is_empty()
    || value.len() > 160
    || !value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b':' | b'.'))
  {
    return Err("Invalid Design identity.".into());
  }
  Ok(())
}

pub fn revision(value: u64) -> Result<(), String> {
  if value > MAX_SAFE_REVISION {
    Err("Design revision is not a safe integer.".into())
  } else {
    Ok(())
  }
}

pub fn source_revision(value: &str) -> Result<(), String> {
  match value.strip_prefix("sha256:") {
    Some(hex) if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(()),
    _ => Err("Invalid Design source-content revision.".into()),
  }
}

pub fn route(value: &str) -> Result<(), String> {
  bounded(value, 2048, "route")?;
  if !value.starts_with('/') || value.starts_with("//") || value.contains('\\') || value.chars().any(char::is_control) {
    return Err("Design route must be an app-relative path.".into());
  }
  Ok(())
}

pub fn target(value: &DesignTarget) -> Result<(), String> {
  identity(&value.id)?;
  bounded(&value.selector, 2048, "selector")?;
  bounded(&value.tag, 100, "tag")?;
  bounded(&value.label, 1024, "label")?;
  if value.selector.trim().is_empty() || value.tag.trim().is_empty() {
    return Err("Design target requires a selector and tag.".into());
  }
  for text in
    [&value.text, &value.parent_selector, &value.role, &value.aria_label, &value.component].into_iter().flatten()
  {
    bounded(text, 16_384, "target context")?;
  }
  Ok(())
}

fn json_inner(value: &Value, depth: usize, nodes: &mut usize, persistent: bool) -> Result<(), String> {
  *nodes += 1;
  if depth > 32 || *nodes > 100_000 {
    return Err("Design JSON exceeds its nesting or node budget.".into());
  }
  match value {
    Value::String(s) => {
      bounded(s, if persistent { 256 * 1024 } else { MAX_WIRE_BYTES }, "JSON string")?;
      if persistent && (s.trim_start().starts_with("data:") || s.trim_start().starts_with("blob:")) {
        return Err("Drafts must reference durable asset IDs, not data/blob URLs.".into());
      }
    }
    Value::Array(a) => {
      for v in a {
        json_inner(v, depth + 1, nodes, persistent)?;
      }
    }
    Value::Object(o) => {
      for (k, v) in o {
        bounded(k, 1024, "JSON key")?;
        if matches!(k.as_str(), "__proto__" | "prototype" | "constructor") {
          return Err("Unsafe Design JSON key.".into());
        }
        json_inner(v, depth + 1, nodes, persistent)?;
      }
    }
    _ => {}
  }
  Ok(())
}

pub fn json(value: &Value, persistent: bool) -> Result<(), String> {
  json_inner(value, 0, &mut 0, persistent)
}

pub fn history(transactions: &[DesignTransaction], cursor: usize) -> Result<(), String> {
  if transactions.len() > MAX_TRANSACTIONS || cursor > transactions.len() {
    return Err("Design history exceeds its budget or has an invalid cursor.".into());
  }
  let mut seen = HashSet::new();
  let mut count = 0;
  for t in transactions {
    identity(&t.id)?;
    if !seen.insert(&t.id) {
      return Err("Duplicate Design transaction ID.".into());
    }
    bounded(&t.label, 2048, "transaction label")?;
    route(&t.route)?;
    count += t.edits.len();
    if t.edits.is_empty() || t.edits.len() > 256 || count > MAX_EDITS {
      return Err("Design edit budget exceeded or empty transaction.".into());
    }
    for edit in &t.edits {
      target(&edit.target)?;
      if let Some(p) = &edit.property {
        bounded(p, 256, "property")?;
      }
      if let Some(s) = &edit.scope {
        bounded(s, 2048, "scope")?;
      }
      json(&edit.before, true)?;
      json(&edit.after, true)?;
    }
  }
  let bytes = serde_json::to_vec(transactions).map_err(|e| e.to_string())?;
  if bytes.len() > MAX_HISTORY_BYTES {
    return Err("Design history exceeds the controller's 1.8 MB journal budget.".into());
  }
  Ok(())
}

pub fn draft(value: &DesignDraft) -> Result<(), String> {
  if value.schema_version != 1 {
    return Err("Unsupported Design draft schema. Keep this file for recovery.".into());
  }
  identity(&value.project_id)?;
  identity(&value.session_id)?;
  revision(value.revision)?;
  route(&value.route)?;
  source_revision(&value.source_revision)?;
  history(&value.history, value.cursor)?;
  if value.viewport_width.is_some_and(|w| !w.is_finite() || !(240.0..=7680.0).contains(&w)) {
    return Err("Design viewport width must be between 240 and 7680 CSS pixels.".into());
  }
  if let Some(r) = &value.receipt {
    receipt(r)?;
    if r.project_id != value.project_id {
      return Err("Design receipt belongs to another project.".into());
    }
  }
  if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_DRAFT_BYTES {
    return Err("Design draft exceeds 4 MiB.".into());
  }
  Ok(())
}

pub fn receipt(value: &DesignApplyReceipt) -> Result<(), String> {
  identity(&value.id)?;
  identity(&value.project_id)?;
  if value.turn_id != value.id {
    return Err("Design Apply turn ID must equal its Apply ID.".into());
  }
  revision(value.draft_revision)?;
  source_revision(&value.source_revision_before)?;
  if let Some(after) = &value.source_revision_after {
    source_revision(after)?;
  }
  if value.files_modified.len() > 20_000 {
    return Err("Design receipt file budget exceeded.".into());
  }
  for path in &value.files_modified {
    relative_path(path)?;
  }
  if let Some(e) = &value.error {
    bounded(e, 16_384, "Apply error")?;
  }
  Ok(())
}

pub fn relative_path(value: &str) -> Result<(), String> {
  bounded(value, 2048, "project path")?;
  if value.is_empty()
    || value.starts_with(['/', '\\'])
    || value.contains(':')
    || value.split(['/', '\\']).any(|c| c.is_empty() || c == "." || c == "..")
    || value.chars().any(char::is_control)
  {
    return Err("Design path must be a confined project-relative file.".into());
  }
  Ok(())
}

pub fn connection(value: &DesignConnection) -> Result<(), String> {
  identity(&value.session_id)?;
  revision(value.revision)?;
  history(&value.history, value.cursor)?;
  bounded(&value.app_url, 4096, "app URL")?;
  if let Some(r) = &value.route {
    route(r)?;
  }
  if let Some(previews) = &value.asset_previews {
    if previews.len() > 256 {
      return Err("Too many Design asset previews.".into());
    }
    for (id, url) in previews {
      identity(id)?;
      image_data_url(url)?;
    }
  }
  if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_WIRE_BYTES {
    return Err("Design connection exceeds its payload budget.".into());
  }
  Ok(())
}

pub fn image_data_url(url: &str) -> Result<(), String> {
  if url.len() > MAX_IMAGE_BYTES * 4 / 3 + 64
    || !["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/gif;base64,", "data:image/webp;base64,"]
      .iter()
      .any(|prefix| url.starts_with(prefix))
  {
    return Err("Use a staged PNG, JPEG, GIF, or WebP image. SVG is not supported.".into());
  }
  Ok(())
}

pub fn snapshot(value: &DesignSnapshot) -> Result<(), String> {
  if value.protocol != 1 {
    return Err("Unsupported Design controller protocol.".into());
  }
  identity(&value.session_id)?;
  if value.enabled {
    identity(&value.document_id)?;
  } else {
    bounded(&value.document_id, 160, "pending document identity")?;
  }
  revision(value.revision)?;
  if value.enabled || !value.route.is_empty() {
    route(&value.route)?;
  }
  history(&value.history, value.cursor)?;
  if value.selection.len() > 100
    || value.layers.len() > 2000
    || value.tokens.len() > 1000
    || value.breakpoints.len() > 100
    || value.acknowledged.len() > 1000
    || value.conflicts.len() > MAX_TRANSACTIONS
  {
    return Err("Design snapshot exceeds its collection budget.".into());
  }
  for n in [value.viewport.width, value.viewport.height] {
    if !n.is_finite() || !(0.0..=100_000.0).contains(&n) {
      return Err("Invalid Design viewport.".into());
    }
  }
  for s in &value.selection {
    target(&s.target)?;
    if !s.width.is_finite()
      || !s.height.is_finite()
      || s.width < 0.0
      || s.height < 0.0
      || s.children.len() > 2000
      || s.styles.len() > 1000
      || s.inline_styles.len() > 1000
    {
      return Err("Invalid Design selection.".into());
    }
    for t in &s.children {
      target(t)?;
    }
    if let Some(t) = &s.parent {
      target(t)?;
    }
  }
  for t in &value.layers {
    target(t)?;
  }
  for t in &value.tokens {
    target(&t.target)?;
    bounded(&t.name, 256, "token name")?;
  }
  for id in &value.acknowledged {
    identity(id)?;
  }
  let json_value = serde_json::to_value(value).map_err(|e| e.to_string())?;
  json(&json_value, false)?;
  if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_WIRE_BYTES {
    return Err("Design snapshot exceeds its byte budget.".into());
  }
  Ok(())
}

pub fn command(value: Value) -> Result<ValidatedCommand, String> {
  let obj = value.as_object().ok_or("Design command must be an object.")?;
  let string = |key: &str| -> Result<&str, String> {
    obj.get(key).and_then(Value::as_str).ok_or_else(|| format!("Design command requires {key}."))
  };
  let session_id = string("sessionId")?.to_string();
  let document_id = string("documentId")?.to_string();
  let command_id = string("commandId")?.to_string();
  for id in [&session_id, &document_id, &command_id] {
    identity(id)?;
  }
  let kind = string("type")?;
  let (required, optional): (&[&str], &[&str]) = match kind {
    "select" => (&["target"], &["toggle"]),
    "tool" => (&["tool"], &[]),
    "style" => (&["values"], &["scope", "gestureId", "phase"]),
    "text" | "comment" => (&["value"], &[]),
    "undo" | "redo" | "reset" | "discard" | "clear" | "remove" | "duplicate" => (&[], &[]),
    "revert" => (&["transactionId"], &[]),
    "retarget" => (&["transactionId", "target"], &[]),
    "compare" | "freeMove" | "debug" | "capture" => (&["enabled"], &[]),
    "move" => (&["direction"], &["free"]),
    "insert" => (&["block", "placement"], &[]),
    "image" => (&["assetId", "dataUrl"], &["alt"]),
    "attribute" => (&["name", "value"], &[]),
    "theme" => (&["values"], &[]),
    "chart" | "restyle" => (&["patch"], &[]),
    "drawOptions" => (&["shape", "color"], &[]),
    "generated" => (&["html"], &[]),
    "verify" => (&["history", "cursor"], &[]),
    _ => return Err("Unknown Design command.".into()),
  };
  if required.iter().any(|k| !obj.contains_key(*k))
    || obj.keys().any(|k| {
      !["sessionId", "documentId", "commandId", "type"].contains(&k.as_str())
        && !required.contains(&k.as_str())
        && !optional.contains(&k.as_str())
    })
  {
    return Err("Design command has missing or unknown fields.".into());
  }
  for k in ["toggle", "enabled", "free"] {
    if obj.get(k).is_some_and(|v| !v.is_boolean()) {
      return Err(format!("Design {k} must be boolean."));
    }
  }
  for k in ["value", "scope", "gestureId", "transactionId", "alt", "color", "html"] {
    if let Some(v) = obj.get(k) {
      bounded(v.as_str().ok_or_else(|| format!("Design {k} must be text."))?, 256 * 1024, k)?;
    }
  }
  for (k, allowed) in [
    ("tool", &["select", "interact", "comment", "draw"][..]),
    ("phase", &["preview", "commit", "cancel"][..]),
    ("direction", &["previous", "next"][..]),
    ("block", &["section", "row", "columns", "card", "heading", "text", "button", "image"][..]),
    ("placement", &["inside", "before", "after"][..]),
    ("name", &["alt"][..]),
    ("shape", &["pen", "arrow", "rect", "ellipse"][..]),
  ] {
    if let Some(v) = obj.get(k) {
      if !v.as_str().is_some_and(|s| allowed.contains(&s)) {
        return Err(format!("Invalid Design {k}."));
      }
    }
  }
  if let Some(v) = obj.get("target") {
    target(&serde_json::from_value::<DesignTarget>(v.clone()).map_err(|e| e.to_string())?)?;
  }
  if kind == "image" {
    identity(string("assetId")?)?;
    image_data_url(string("dataUrl")?)?;
  }
  if kind == "style" {
    let values = obj["values"].as_object().ok_or("Design styles must be an object.")?;
    if values.len() > 128 {
      return Err("Too many Design style properties.".into());
    }
    for (key, val) in values {
      if key.is_empty() || key.len() > 128 || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("Invalid Design CSS property.".into());
      }
      let s = val.as_str().ok_or("Design style values must be strings.")?;
      bounded(s, 4096, "style")?;
      let lower = s.to_ascii_lowercase();
      if ["javascript:", "expression(", "-moz-binding", "@import"].iter().any(|p| lower.contains(p)) {
        return Err("Unsafe Design style value.".into());
      }
    }
  }
  if kind == "theme" {
    let values = obj["values"].as_array().ok_or("Design theme values must be an array.")?;
    if values.len() > 1000 {
      return Err("Too many Design theme values.".into());
    }
    for val in values {
      let token: DesignToken =
        serde_json::from_value(val.get("token").cloned().ok_or("Missing theme token.")?).map_err(|e| e.to_string())?;
      target(&token.target)?;
      bounded(val.get("value").and_then(Value::as_str).ok_or("Missing theme value.")?, 4096, "theme value")?;
    }
  }
  if matches!(kind, "chart" | "restyle") && !obj["patch"].is_object() {
    return Err("Design patch must be an object.".into());
  }
  if kind == "verify" {
    let h: Vec<DesignTransaction> = serde_json::from_value(obj["history"].clone()).map_err(|e| e.to_string())?;
    let c = obj["cursor"].as_u64().ok_or("Invalid Design verification cursor.")?;
    history(&h, usize::try_from(c).map_err(|_| "Invalid Design verification cursor.")?)?;
  }
  json(&value, false)?;
  if serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > MAX_WIRE_BYTES {
    return Err("Design command exceeds its byte budget.".into());
  }
  Ok(ValidatedCommand { value, session_id, document_id, command_id })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn design_commands_are_correlated_and_exact() {
    assert!(command(json!({"type":"undo","sessionId":"s","documentId":"d","commandId":"c"})).is_ok());
    assert!(
      command(json!({"type":"undo","sessionId":"s","documentId":"d","commandId":"c","path":"C:\\secret"})).is_err()
    );
    assert!(
      command(json!({"type":"compare","sessionId":"s","documentId":"d","commandId":"c","enabled":"yes"})).is_err()
    );
    assert!(command(json!({"type":"tool","sessionId":"s","documentId":"d","commandId":"c","tool":"script"})).is_err());
  }

  #[test]
  fn design_durable_json_rejects_runtime_assets_and_pollution() {
    assert!(json(&json!({"assetId":"asset-1","alt":"A cat"}), true).is_ok());
    assert!(json(&json!({"src":"data:image/png;base64,abc"}), true).is_err());
    assert!(json(&json!({"__proto__":{"bad":true}}), true).is_err());
  }

  #[test]
  fn design_paths_and_revisions_are_strict() {
    for path in ["../secret", "C:\\secret", "\\\\host\\share", "a/../b", "a//b"] {
      assert!(relative_path(path).is_err());
    }
    assert!(relative_path("public/design/logo.png").is_ok());
    assert!(source_revision(&format!("sha256:{}", "a".repeat(64))).is_ok());
    assert!(source_revision("mtime-123").is_err());
    assert!(revision(MAX_SAFE_REVISION + 1).is_err());
  }

  #[test]
  fn design_wire_selection_accepts_all_optional_target_fields() {
    let fixture = json!({
      "id":"n","selector":"h1","tag":"h1","label":"Heading","text":"A title","parentSelector":"main",
      "role":"heading","ariaLabel":"Title","component":"App",
      "styles":{"color":"red"},"inlineStyles":{},"textEditable":true,"ownText":"A title",
      "width":120.0,"height":30.0,"parent":{"id":"p","selector":"main","tag":"main","label":"Main"},
      "children":[],"image":{"src":"/logo.png","alt":"Logo"},
      "chart":{"spec":{"type":"bar"},"types":[{"value":"bar","label":"Bar","enabled":true}]},
      "canContain":true,"canReorder":false
    });
    let parsed: DesignSelection = serde_json::from_value(fixture.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), fixture);
    let mut unknown = fixture;
    unknown["node"] = json!({"runtime":true});
    assert!(serde_json::from_value::<DesignSelection>(unknown).is_err());
  }

  #[test]
  fn design_pending_snapshots_may_not_have_a_document_yet() {
    let pending: DesignSnapshot = serde_json::from_value(json!({
      "protocol":1,"sessionId":"s","documentId":"","revision":0,"enabled":false,"route":"",
      "tool":"select","compare":false,"selection":[],"layers":[],"tokens":[],"breakpoints":[],
      "viewport":{"width":0,"height":0},"history":[],"cursor":0,"conflicts":[],"acknowledged":[]
    }))
    .unwrap();
    assert!(snapshot(&pending).is_ok());
    let mut invalid_ready = pending;
    invalid_ready.enabled = true;
    assert!(snapshot(&invalid_ready).is_err());
  }
}
