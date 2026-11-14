//! Local-preview origins in `rayfin/rayfin.yml`.
//!
//! Fabric sign-in only hands off to origins listed in
//! `services.auth.allowedRedirectUris` (and pushed with `rayfin up`), so the live
//! preview must serve on a listed `http://localhost:N` port. This module reads
//! those ports and registers a new one with a surgical text edit that keeps the
//! rest of the file (comments, order, formatting) intact. Every edit is verified
//! by re-parsing: the result may differ from the original only by the new origin.

use std::path::{Path, PathBuf};

use serde_yaml::Value;

/// Rayfin's default `allowedRedirectUris` is `["http://localhost:5173"]`.
pub const DEFAULT_PORT: u16 = 5173;

/// What rayfin.yml says about local-preview origins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalOrigins {
  /// `services.auth.enabled`. When false nothing signs in, so any port works.
  pub auth_enabled: bool,
  /// Ports of the listed `http://localhost:N` origins, in list order.
  pub ports: Vec<u16>,
}

/// A rayfin.yml edit, kept so a failed push can undo it.
#[derive(Debug, Clone)]
pub struct OriginEdit {
  pub original: String,
  pub updated: String,
}

pub fn origin(port: u16) -> String {
  format!("http://localhost:{port}")
}

fn config_path(project_dir: &Path) -> PathBuf {
  project_dir.join("rayfin").join("rayfin.yml")
}

/// The port of an exact `http://localhost:N` origin (a trailing `/` is allowed).
fn localhost_port(uri: &str) -> Option<u16> {
  let rest = uri.trim().strip_prefix("http://localhost:")?;
  let digits = rest.strip_suffix('/').unwrap_or(rest);
  if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }
  digits.parse::<u16>().ok().filter(|port| *port > 0)
}

fn load(text: &str) -> Result<Value, String> {
  serde_yaml::from_str(text.strip_prefix('\u{feff}').unwrap_or(text))
    .map_err(|e| t!("services.redirectUris.invalidYaml", error = e))
}

fn auth(doc: &Value) -> Option<&Value> {
  doc.get("services")?.get("auth")
}

/// The configured list, or `None` when the key is absent or empty (Rayfin's
/// default then applies).
fn redirect_list(doc: &Value) -> Result<Option<Vec<String>>, String> {
  match auth(doc).and_then(|a| a.get("allowedRedirectUris")) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::Sequence(items)) => Ok(Some(items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())),
    Some(_) => Err(t!("services.redirectUris.notAList")),
  }
}

pub fn parse(text: &str) -> Result<LocalOrigins, String> {
  let doc = load(text)?;
  let auth_enabled = auth(&doc).and_then(|a| a.get("enabled")).and_then(Value::as_bool).unwrap_or(false);
  let listed = redirect_list(&doc)?.unwrap_or_else(|| vec![origin(DEFAULT_PORT)]);
  let mut ports = Vec::new();
  for port in listed.iter().filter_map(|uri| localhost_port(uri)) {
    if !ports.contains(&port) {
      ports.push(port);
    }
  }
  Ok(LocalOrigins { auth_enabled, ports })
}

pub fn read(project_dir: &Path) -> Result<LocalOrigins, String> {
  let text = std::fs::read_to_string(config_path(project_dir))
    .map_err(|e| t!("services.redirectUris.readFailed", error = e))?;
  parse(&text)
}

/// `text` with `http://localhost:{port}` appended to
/// `services.auth.allowedRedirectUris`, or `None` when it's already allowed.
/// A missing list is created with Rayfin's default origin first, so adding a
/// port never drops `localhost:5173`.
pub fn with_origin(text: &str, port: u16) -> Result<Option<String>, String> {
  let uri = origin(port);
  let manual = || t!("services.redirectUris.manual", uri = uri);
  let before = load(text)?;
  let mut expected = redirect_list(&before)?.unwrap_or_else(|| vec![origin(DEFAULT_PORT)]);
  if expected.iter().any(|listed| localhost_port(listed) == Some(port)) {
    return Ok(None);
  }
  let next = insert(text, &uri).ok_or_else(manual)?;
  let after = load(&next).map_err(|_| manual())?;
  expected.push(uri.clone());
  if redirect_list(&after).ok().flatten() != Some(expected) || without_redirects(before) != without_redirects(after) {
    return Err(manual());
  }
  Ok(Some(next))
}

fn without_redirects(mut doc: Value) -> Value {
  if let Some(auth) = doc.get_mut("services").and_then(|s| s.get_mut("auth")).and_then(Value::as_mapping_mut) {
    auth.remove("allowedRedirectUris");
  }
  doc
}

/// Register `http://localhost:{port}` in the project's rayfin.yml. `None` when
/// it's already allowed (nothing written).
pub fn add(project_dir: &Path, port: u16) -> Result<Option<OriginEdit>, String> {
  let path = config_path(project_dir);
  let original = std::fs::read_to_string(&path).map_err(|e| t!("services.redirectUris.readFailed", error = e))?;
  let Some(updated) = with_origin(&original, port)? else {
    return Ok(None);
  };
  std::fs::write(&path, &updated).map_err(|e| t!("services.redirectUris.writeFailed", error = e))?;
  Ok(Some(OriginEdit { original, updated }))
}

/// Undo [`add`] unless the file changed again since, so other edits survive.
pub fn revert(project_dir: &Path, edit: &OriginEdit) -> bool {
  let path = config_path(project_dir);
  match std::fs::read_to_string(&path) {
    Ok(current) if current == edit.updated => std::fs::write(&path, &edit.original).is_ok(),
    _ => false,
  }
}

/// A source line without its line break.
struct Src<'a> {
  text: &'a str,
  indent: usize,
}

impl<'a> Src<'a> {
  fn new(text: &'a str) -> Self {
    Src { text, indent: text.len() - text.trim_start_matches(' ').len() }
  }

  /// Blank and comment-only lines carry no structure.
  fn filler(&self) -> bool {
    let body = self.text.trim();
    body.is_empty() || body.starts_with('#')
  }

  /// `(key, value)` when the line opens a mapping entry with a plain key.
  fn entry(&self) -> Option<(&'a str, &'a str)> {
    let body = &self.text[self.indent..];
    let colon = body.find(':')?;
    let key = &body[..colon];
    let rest = &body[colon + 1..];
    let plain = !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    (plain && (rest.is_empty() || rest.starts_with(' '))).then(|| (key, strip_comment(rest).trim()))
  }
}

/// `#` starts a comment at the start of a value or after whitespace.
fn strip_comment(value: &str) -> &str {
  let bytes = value.as_bytes();
  (0..bytes.len())
    .find(|&i| bytes[i] == b'#' && (i == 0 || bytes[i - 1] == b' ' || bytes[i - 1] == b'\t'))
    .map_or(value, |i| &value[..i])
}

/// Lines nested under the entry at `at`, ending after its last non-filler line.
fn block(lines: &[Src], at: usize) -> std::ops::Range<usize> {
  let parent = lines[at].indent;
  let mut end = at + 1;
  for (i, line) in lines.iter().enumerate().skip(at + 1) {
    if line.filler() {
      continue;
    }
    if line.indent <= parent {
      break;
    }
    end = i + 1;
  }
  (at + 1)..end
}

fn child_indent(lines: &[Src], at: usize) -> Option<usize> {
  lines[block(lines, at)].iter().find(|line| !line.filler()).map(|line| line.indent)
}

/// The block-mapping entry `key` directly under `at` (or at the top level).
fn child(lines: &[Src], at: Option<usize>, key: &str) -> Option<usize> {
  let (range, indent) = match at {
    Some(parent) => (block(lines, parent), child_indent(lines, parent)?),
    None => (0..lines.len(), 0),
  };
  range.into_iter().find(|&i| {
    let line = &lines[i];
    !line.filler() && line.indent == indent && line.entry().is_some_and(|(k, _)| k == key)
  })
}

fn mapping_child(lines: &[Src], at: Option<usize>, key: &str) -> Option<usize> {
  let found = child(lines, at, key)?;
  lines[found].entry().is_some_and(|(_, value)| value.is_empty()).then_some(found)
}

/// Insert `uri` into the redirect list with the file's own layout. `None` when
/// the shape isn't one this edit understands.
fn insert(text: &str, uri: &str) -> Option<String> {
  let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
  let raw: Vec<&str> = text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
  let lines: Vec<Src> = raw.iter().map(|line| Src::new(line)).collect();
  let mut out: Vec<String> = raw.iter().map(|line| line.to_string()).collect();

  let services = mapping_child(&lines, None, "services")?;
  let auth = mapping_child(&lines, Some(services), "auth")?;
  let default = origin(DEFAULT_PORT);
  match child(&lines, Some(auth), "allowedRedirectUris") {
    Some(key) => {
      let (_, value) = lines[key].entry()?;
      if value.is_empty() {
        // Block sequence; items may sit at the key's own indent.
        let key_indent = lines[key].indent;
        let mut items: Option<(usize, usize)> = None;
        for (i, line) in lines.iter().enumerate().skip(key + 1) {
          if line.filler() {
            continue;
          }
          let body = line.text.trim_start();
          let item = line.indent >= key_indent && (body == "-" || body.starts_with("- "));
          if item && items.is_none_or(|(_, indent)| indent == line.indent) {
            items = Some((i, line.indent));
            continue;
          }
          if line.indent > items.map_or(key_indent, |(_, indent)| indent) {
            return None;
          }
          break;
        }
        match items {
          Some((last, indent)) => out.insert(last + 1, format!("{}- {uri}", " ".repeat(indent))),
          None => {
            let pad = " ".repeat(key_indent + 2);
            out.splice(key + 1..key + 1, [format!("{pad}- {default}"), format!("{pad}- {uri}")]);
          }
        }
      } else if value.starts_with('[') && value.ends_with(']') {
        let line = lines[key].text;
        let close = line.find(value)? + value.len() - 1;
        let (head, tail) = line.split_at(close);
        let separator = if value[1..value.len() - 1].trim().is_empty() { "" } else { ", " };
        out[key] = format!("{}{separator}{uri}{tail}", head.trim_end());
      } else {
        return None;
      }
    }
    None => {
      let indent = child_indent(&lines, auth).unwrap_or(lines[auth].indent + 2);
      let at = block(&lines, auth).end;
      let (pad, item) = (" ".repeat(indent), " ".repeat(indent + 2));
      out.splice(
        at..at,
        [format!("{pad}allowedRedirectUris:"), format!("{item}- {default}"), format!("{item}- {uri}")],
      );
    }
  }
  Some(out.join(newline))
}

#[cfg(test)]
mod tests {
  use super::*;

  const TEMPLATE: &str = "id: app\nname: app\nservices:\n  auth:\n    enabled: true\n    fabric:\n      enabled: true\n    allowedRedirectUris:\n      - http://localhost:5173\n      - https://hazy-shade-9227facbc8-westus.webapp.fabricapps.net\n  data:\n    enabled: true\n";

  #[test]
  fn reads_listed_localhost_ports_in_order() {
    let yml = TEMPLATE.replace(
      "      - https://",
      "      - http://127.0.0.1:5174\n      - http://localhost:5174/\n      - https://localhost:5175\n      - http://localhost\n      - https://",
    );
    assert_eq!(parse(&yml).unwrap(), LocalOrigins { auth_enabled: true, ports: vec![5173, 5174] });
  }

  #[test]
  fn missing_list_means_rayfin_default_and_auth_defaults_off() {
    let origins = parse("services:\n  auth:\n    fabric:\n      enabled: true\n").unwrap();
    assert_eq!(origins, LocalOrigins { auth_enabled: false, ports: vec![DEFAULT_PORT] });
    assert_eq!(parse("id: x\n").unwrap().ports, vec![DEFAULT_PORT]);
    assert!(parse("services:\n  auth:\n    allowedRedirectUris: []\n").unwrap().ports.is_empty());
    assert!(parse("services: [").is_err());
  }

  #[test]
  fn appends_to_a_block_list_and_keeps_everything_else() {
    let yml = TEMPLATE.replace("  data:", "    # keep me\n  data:");
    let next = with_origin(&yml, 5174).unwrap().unwrap();
    assert_eq!(
      next,
      yml.replace(
        "fabricapps.net\n",
        "fabricapps.net\n      - http://localhost:5174\n"
      )
    );
    assert_eq!(parse(&next).unwrap().ports, vec![5173, 5174]);
  }

  #[test]
  fn keeps_crlf_line_endings_and_items_at_key_indent() {
    let yml = "services:\r\n  auth:\r\n    enabled: true\r\n    allowedRedirectUris:\r\n    - http://localhost:5173\r\n    scopes:\r\n    - read\r\n";
    let next = with_origin(yml, 5180).unwrap().unwrap();
    assert_eq!(next, yml.replace("5173\r\n", "5173\r\n    - http://localhost:5180\r\n"));
  }

  #[test]
  fn creates_the_list_with_the_default_origin_when_absent_or_empty() {
    let yml = "services:\n  auth:\n    enabled: true\n    fabric:\n      enabled: true\n\n  data:\n    enabled: false\n";
    let next = with_origin(yml, 5174).unwrap().unwrap();
    assert_eq!(
      next,
      "services:\n  auth:\n    enabled: true\n    fabric:\n      enabled: true\n    allowedRedirectUris:\n      - http://localhost:5173\n      - http://localhost:5174\n\n  data:\n    enabled: false\n"
    );
    let empty = "services:\n  auth:\n    enabled: true\n    allowedRedirectUris:\n  data: {}\n";
    let next = with_origin(empty, 5174).unwrap().unwrap();
    assert_eq!(parse(&next).unwrap().ports, vec![5173, 5174]);
  }

  #[test]
  fn appends_to_one_line_flow_lists() {
    let yml = "services:\n  auth:\n    enabled: true\n    allowedRedirectUris: [http://localhost:5173] # local [dev]\n";
    assert_eq!(
      with_origin(yml, 5174).unwrap().unwrap(),
      "services:\n  auth:\n    enabled: true\n    allowedRedirectUris: [http://localhost:5173, http://localhost:5174] # local [dev]\n"
    );
    let empty = "services:\n  auth:\n    allowedRedirectUris: []\n";
    assert_eq!(
      with_origin(empty, 5174).unwrap().unwrap(),
      "services:\n  auth:\n    allowedRedirectUris: [http://localhost:5174]\n"
    );
  }

  #[test]
  fn already_allowed_ports_need_no_edit() {
    assert!(with_origin(TEMPLATE, 5173).unwrap().is_none());
    assert!(with_origin("services:\n  auth:\n    enabled: true\n", 5173).unwrap().is_none());
    let listed = TEMPLATE.replace("5173\n", "5173/\n");
    assert!(with_origin(&listed, 5173).unwrap().is_none());
  }

  #[test]
  fn unsupported_shapes_ask_for_a_manual_edit() {
    for yml in [
      "services:\n  auth: {enabled: true}\n",
      "services:\n  auth:\n    allowedRedirectUris: [\n      http://localhost:5173]\n",
      "services:\n  auth:\n    allowedRedirectUris:\n      - >-\n        http://localhost:5173\n",
      "id: x\n",
    ] {
      let error = with_origin(yml, 5174).unwrap_err();
      assert!(error.contains("Add `http://localhost:5174`"), "{yml}: {error}");
    }
    assert!(with_origin("services:\n  auth:\n    allowedRedirectUris: nope\n", 5174).unwrap_err().contains("isn't a list"));
  }

  #[test]
  fn add_writes_and_revert_restores_only_our_edit() {
    let dir = std::env::temp_dir().join(format!("rayfin-redirects-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("rayfin")).unwrap();
    let file = dir.join("rayfin").join("rayfin.yml");
    std::fs::write(&file, TEMPLATE).unwrap();

    let edit = add(&dir, 5174).unwrap().unwrap();
    assert_eq!(read(&dir).unwrap().ports, vec![5173, 5174]);
    assert!(add(&dir, 5174).unwrap().is_none());
    assert!(revert(&dir, &edit));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), TEMPLATE);

    let edit = add(&dir, 5175).unwrap().unwrap();
    std::fs::write(&file, format!("{}# agent edit\n", edit.updated)).unwrap();
    assert!(!revert(&dir, &edit));
    assert!(std::fs::read_to_string(&file).unwrap().contains("# agent edit"));
    let _ = std::fs::remove_dir_all(&dir);
  }
}
