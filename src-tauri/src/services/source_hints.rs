//! Source hints for Touch Up: find the lines most likely to render a picked
//! element, so Copilot starts at the right file instead of searching for it.
//!
//! Heuristic and dependency-free. The deployed DOM keeps Tailwind class names
//! and visible text verbatim, so each project source line is scored by
//!   * coverage of the element's class tokens (both directions, so a literal
//!     completed by a `${className}` prop at the call site still ranks),
//!   * exact (or prefix) matches of its visible text, and
//!   * chart title / type literals for Graphein charts.
//! The results are hints for the agent, never edits.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Files scanned at most, and the largest file read.
const MAX_FILES: usize = 3000;
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// Candidates returned per target.
const MAX_CANDIDATES: usize = 3;
/// Candidates below this score are noise.
const MIN_SCORE: f64 = 0.35;
const SOURCE_EXTS: &[&str] = &["tsx", "jsx", "ts", "js", "mjs", "mts", "vue", "svelte", "html"];
const SKIP_DIRS: &[&str] =
  &["node_modules", "dist", "build", "out", "coverage", ".git", ".vite", ".next", ".turbo", ".cache"];

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LocateTarget {
  pub key: String,
  pub tag: Option<String>,
  pub classes: Option<String>,
  pub text: Option<String>,
  pub chart_title: Option<String>,
  pub chart_type: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
  pub file: String,
  pub line: usize,
  pub reason: String,
  pub score: f64,
  pub snippet: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TargetResult {
  pub key: String,
  pub candidates: Vec<Candidate>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocateResult {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub entry_css: Option<String>,
  pub targets: Vec<TargetResult>,
}

struct SourceFile {
  rel: String,
  lines: Vec<String>,
}

/// Rank likely source locations for every target in `project_dir`.
pub fn locate(project_dir: &Path, targets: &[LocateTarget]) -> LocateResult {
  let files = collect_sources(project_dir);
  LocateResult {
    entry_css: find_entry_css(project_dir),
    targets: targets
      .iter()
      .map(|t| TargetResult { key: t.key.clone(), candidates: rank(&files, t) })
      .collect(),
  }
}

fn relative(project_dir: &Path, path: &Path) -> String {
  path.strip_prefix(project_dir).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn skip_dir(path: &Path) -> bool {
  path.file_name().and_then(|n| n.to_str()).is_some_and(|n| SKIP_DIRS.contains(&n) || n.starts_with('.'))
}

/// Walk `dir` (not following symlinks) collecting files that match `want`.
fn walk(dir: &Path, want: &dyn Fn(&Path) -> bool, out: &mut Vec<PathBuf>, limit: usize) {
  let Ok(entries) = std::fs::read_dir(dir) else { return };
  let mut entries: Vec<_> = entries.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for entry in entries {
    if out.len() >= limit {
      return;
    }
    let path = entry.path();
    let Ok(kind) = entry.file_type() else { continue };
    if kind.is_symlink() {
      continue;
    }
    if kind.is_dir() {
      if !skip_dir(&path) {
        walk(&path, want, out, limit);
      }
    } else if kind.is_file() && want(&path) {
      out.push(path);
    }
  }
}

fn is_source(path: &Path) -> bool {
  let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
  if name.ends_with(".d.ts") || name.contains(".test.") || name.contains(".spec.") {
    return false;
  }
  path.extension().and_then(|e| e.to_str()).is_some_and(|e| SOURCE_EXTS.contains(&e))
}

/// The app's source roots: `src/` when present (Rayfin templates), else the
/// project root (skipping build output and dependencies).
fn source_root(project_dir: &Path) -> PathBuf {
  let src = project_dir.join("src");
  if src.is_dir() { src } else { project_dir.to_path_buf() }
}

fn read_small(path: &Path) -> Option<String> {
  let meta = std::fs::metadata(path).ok()?;
  if meta.len() > MAX_FILE_BYTES {
    return None;
  }
  std::fs::read_to_string(path).ok()
}

fn collect_sources(project_dir: &Path) -> Vec<SourceFile> {
  let mut paths = Vec::new();
  walk(&source_root(project_dir), &is_source, &mut paths, MAX_FILES);
  paths
    .into_iter()
    .filter_map(|p| {
      let text = read_small(&p)?;
      Some(SourceFile { rel: relative(project_dir, &p), lines: text.lines().map(str::to_string).collect() })
    })
    .collect()
}

/// The Tailwind entry stylesheet: the CSS file that imports `tailwindcss` (v4)
/// or declares `@tailwind` layers (v3). Prefers the conventional entry names.
pub fn find_entry_css(project_dir: &Path) -> Option<String> {
  let mut css = Vec::new();
  let want = |p: &Path| p.extension().and_then(|e| e.to_str()) == Some("css");
  walk(&source_root(project_dir), &want, &mut css, 400);
  if css.is_empty() {
    walk(project_dir, &want, &mut css, 400);
  }
  let is_entry = |p: &PathBuf| {
    read_small(p).is_some_and(|t| {
      t.contains("@import 'tailwindcss'") || t.contains("@import \"tailwindcss\"") || t.contains("@tailwind base")
    })
  };
  let preferred = ["main.css", "index.css", "app.css", "globals.css", "global.css", "styles.css"];
  let mut entries: Vec<&PathBuf> = css.iter().filter(|p| is_entry(p)).collect();
  entries.sort_by_key(|p| {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    preferred.iter().position(|n| *n == name).unwrap_or(preferred.len())
  });
  entries.first().map(|p| relative(project_dir, p))
}

fn is_token_char(c: char) -> bool {
  c.is_alphanumeric() || matches!(c, '-' | '_' | ':' | '/' | '[' | ']' | '.' | '%' | '#' | '!' | '&' | '>' | '*' | '@' | '=')
}

/// Class-like tokens inside the string literals of `line` (quoted or template).
fn literal_tokens(line: &str) -> Vec<&str> {
  let mut out = Vec::new();
  let bytes = line.as_bytes();
  let mut i = 0;
  while i < bytes.len() {
    let q = bytes[i];
    if q == b'"' || q == b'\'' || q == b'`' {
      if let Some(end) = line[i + 1..].find(q as char) {
        let body = &line[i + 1..i + 1 + end];
        // Drop `${…}` interpolations from template literals.
        let mut rest = body;
        while let Some(start) = rest.find("${") {
          out.extend(rest[..start].split_whitespace());
          rest = match rest[start..].find('}') {
            Some(close) => &rest[start + close + 1..],
            None => "",
          };
        }
        out.extend(rest.split_whitespace());
        i += end + 2;
        continue;
      }
    }
    i += 1;
  }
  out.retain(|t| t.chars().all(is_token_char) && t.chars().any(|c| c.is_ascii_alphabetic()));
  out
}

/// Score how well `line`'s string literals match the element's `classes`:
/// recall (element tokens found) blended with precision (literal tokens that
/// belong to the element). Needs several shared tokens to count at all, so a
/// multi-line `cn(…)` argument or a class constant still ranks, but a stray
/// `"flex"` elsewhere doesn't.
fn class_score(line: &str, dom: &HashSet<&str>) -> Option<(f64, usize)> {
  if dom.is_empty() {
    return None;
  }
  let literal = literal_tokens(line);
  if literal.is_empty() {
    return None;
  }
  let hits: HashSet<&str> = literal.iter().copied().filter(|t| dom.contains(t)).collect();
  let needed = dom.len().min(3);
  if hits.len() < needed {
    return None;
  }
  let recall = hits.len() as f64 / dom.len() as f64;
  let precision = hits.len() as f64 / literal.len() as f64;
  Some((0.6 * recall + 0.4 * precision, hits.len()))
}

fn clean_text(text: &str) -> String {
  text.trim().trim_end_matches('…').trim().to_string()
}

/// Score a visible-text match on `line`: an exact literal (or JSX text) match
/// beats a prefix match of a long string that may wrap across lines.
fn text_score(line: &str, text: &str) -> Option<(f64, &'static str)> {
  if text.chars().count() < 2 {
    return None;
  }
  if line.contains(text) {
    let quoted = [format!("'{text}"), format!("\"{text}"), format!("`{text}"), format!(">{text}")];
    let literal = quoted.iter().any(|q| line.contains(q.as_str()));
    return Some((if literal { 0.85 } else { 0.7 }, "text"));
  }
  let prefix: String = text.chars().take(24).collect();
  if text.chars().count() > 24 && line.contains(prefix.as_str()) {
    return Some((0.55, "text prefix"));
  }
  None
}

fn snippet(line: &str) -> String {
  let t = line.trim();
  if t.chars().count() > 160 { format!("{}…", t.chars().take(160).collect::<String>()) } else { t.to_string() }
}

fn rank(files: &[SourceFile], target: &LocateTarget) -> Vec<Candidate> {
  let dom: HashSet<&str> = target
    .classes
    .as_deref()
    .unwrap_or("")
    .split_whitespace()
    .filter(|t| !t.starts_with("__rf"))
    .collect();
  let text = target.text.as_deref().map(clean_text).unwrap_or_default();
  let title = target.chart_title.as_deref().map(clean_text).unwrap_or_default();
  let tag_open = target.tag.as_deref().filter(|t| !t.is_empty()).map(|t| format!("<{t}"));
  let chart_type = target.chart_type.as_deref().filter(|t| !t.is_empty());

  let mut found: Vec<Candidate> = Vec::new();
  for file in files {
    for (idx, line) in file.lines.iter().enumerate() {
      let mut best: Option<(f64, String)> = None;
      let mut consider = |score: f64, reason: String| {
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
          best = Some((score, reason));
        }
      };
      if let Some((score, hits)) = class_score(line, &dom) {
        let tag_bonus = tag_open.as_deref().is_some_and(|t| has_tag(line, t));
        consider((score + if tag_bonus { 0.1 } else { 0.0 }).min(1.0), format!("{hits} matching classes"));
      }
      if !text.is_empty() {
        if let Some((score, reason)) = text_score(line, &text) {
          consider(score, reason.to_string());
        }
      }
      if !title.is_empty() && line.contains(title.as_str()) {
        consider(0.8, "chart title".into());
      } else if let Some(kind) = chart_type {
        if line.contains(&format!("type: '{kind}'")) || line.contains(&format!("type: \"{kind}\"")) {
          consider(0.4, format!("{kind} chart spec"));
        }
      }
      if let Some((score, reason)) = best {
        if score >= MIN_SCORE {
          found.push(Candidate { file: file.rel.clone(), line: idx + 1, reason, score, snippet: snippet(line) });
        }
      }
    }
  }
  // A class match with the element's text a few lines below it is the element
  // itself (e.g. `<button className=…>` then `Add deal`): merge the two signals.
  if !text.is_empty() {
    let texts: Vec<(String, usize)> = found
      .iter()
      .filter(|c| c.reason.starts_with("text"))
      .map(|c| (c.file.clone(), c.line))
      .collect();
    for c in found.iter_mut().filter(|c| c.reason.ends_with("matching classes")) {
      if texts.iter().any(|(f, l)| *f == c.file && *l >= c.line && *l <= c.line + 6) {
        c.score = (c.score + 0.25).min(1.0);
        c.reason.push_str(" + text");
      }
    }
  }
  found.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then(a.file.cmp(&b.file)).then(a.line.cmp(&b.line)));
  let mut picked: Vec<Candidate> = Vec::new();
  for c in found {
    if picked.iter().any(|p| p.file == c.file && p.line.abs_diff(c.line) <= 2) {
      continue;
    }
    picked.push(Candidate { score: (c.score * 100.0).round() / 100.0, ..c });
    if picked.len() >= MAX_CANDIDATES {
      break;
    }
  }
  picked
}

fn has_tag(line: &str, open: &str) -> bool {
  line.match_indices(open).any(|(i, _)| {
    line[i + open.len()..].chars().next().is_none_or(|c| c.is_whitespace() || c == '>' || c == '/')
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn project(files: &[(&str, &str)]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fabricator-locate-{}", uuid::Uuid::new_v4()));
    for (rel, body) in files {
      let path = dir.join(rel);
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      std::fs::write(path, body).unwrap();
    }
    dir
  }

  fn target(classes: &str, text: &str, tag: &str) -> LocateTarget {
    LocateTarget {
      key: "1".into(),
      classes: Some(classes.into()),
      text: Some(text.into()),
      tag: Some(tag.into()),
      ..Default::default()
    }
  }

  const UI: &str = r#"export function ChartCard({ title, className = '' }) {
  return (
    <section
      className={`flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm ${className}`}
    >
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
    </section>
  );
}
"#;

  const PAGE: &str = r#"import { ChartCard } from '@/components/ui';
export default function DealsPage() {
  return (
    <div className="flex flex-col gap-4">
      <ChartCard title="Pipeline value" className="lg:col-span-8" />
      <button className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">
        Add deal
      </button>
    </div>
  );
}
"#;

  #[test]
  fn class_literal_completed_by_a_prop_still_ranks_first() {
    let dir = project(&[("src/components/ui.tsx", UI), ("src/pages/DealsPage.tsx", PAGE)]);
    let t = target(
      "flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm lg:col-span-8",
      "Pipeline value",
      "section",
    );
    let result = locate(&dir, &[t]);
    let top = &result.targets[0].candidates;
    assert_eq!(top[0].file, "src/components/ui.tsx");
    assert_eq!(top[0].line, 4);
    // The call site that passes the title text is also offered.
    assert!(top.iter().any(|c| c.file == "src/pages/DealsPage.tsx" && c.line == 5));
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn class_and_text_on_nearby_lines_merge_into_the_element() {
    let dir = project(&[("src/pages/DealsPage.tsx", PAGE)]);
    let t = target(
      "inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white",
      "Add deal",
      "button",
    );
    let top = &locate(&dir, &[t]).targets[0].candidates;
    assert_eq!((top[0].file.as_str(), top[0].line), ("src/pages/DealsPage.tsx", 6));
    assert!(top[0].reason.contains("+ text"), "{:?}", top[0]);
    assert!(top[0].score > 0.9);
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn generic_classes_alone_do_not_match_everything() {
    let dir = project(&[("src/pages/DealsPage.tsx", PAGE)]);
    let t = LocateTarget { key: "1".into(), classes: Some("flex".into()), ..Default::default() };
    // A single generic token still needs a real literal match (the `flex` div).
    let top = &locate(&dir, &[t]).targets[0].candidates;
    assert!(top.iter().all(|c| c.snippet.contains("flex")));
    let none = LocateTarget { key: "2".into(), classes: Some("does-not-exist other-thing".into()), ..Default::default() };
    assert!(locate(&dir, &[none]).targets[0].candidates.is_empty());
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn chart_titles_and_entry_css_are_found() {
    let dir = project(&[
      ("src/services/chartSpecs.ts", "export const spec = {\n  type: 'bar',\n  title: 'Revenue by month',\n};\n"),
      ("src/main.css", "@import 'tailwindcss';\n@theme inline { --font-sans: Inter; }\n"),
      ("src/other.css", ".x { color: red; }\n"),
      ("node_modules/pkg/index.js", "export const x = 'Revenue by month';\n"),
    ]);
    let t = LocateTarget {
      key: "c".into(),
      chart_title: Some("Revenue by month".into()),
      chart_type: Some("bar".into()),
      ..Default::default()
    };
    let result = locate(&dir, &[t]);
    let top = &result.targets[0].candidates;
    assert_eq!((top[0].file.as_str(), top[0].line), ("src/services/chartSpecs.ts", 3));
    assert!(top.iter().all(|c| !c.file.starts_with("node_modules")));
    assert_eq!(result.entry_css.as_deref(), Some("src/main.css"));
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn literal_tokens_skip_template_interpolations() {
    let line = "className={`rounded-xl ${active ? 'bg-indigo-600' : 'bg-white'} px-4`}";
    let tokens = literal_tokens(line);
    assert!(tokens.contains(&"rounded-xl"));
    assert!(tokens.contains(&"px-4"));
    assert!(!tokens.iter().any(|t| t.contains("active")));
  }
}
