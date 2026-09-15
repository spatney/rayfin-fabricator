//! Per-chat-turn diagnostics — a lightweight, best-effort record of every chat
//! turn so a user can share it when reporting a bug.
//!
//! Design goals (from the feature request):
//!   * **Light on CPU** — nothing here runs on the hot streaming path. A single
//!     record is written once per turn (see `commands/chat.rs`), and the export
//!     bundle is built only when the user asks.
//!   * **Never crash the app on a logging failure** — every write is best-effort
//!     (`let _ = …`, no `unwrap`/panics), mirroring `crashlog.rs`.
//!   * **Metadata only by default** — prompt/response text and tool I/O are
//!     captured only when the user opts into "full diagnostics" (see
//!     [`full_enabled`]); the caller decides what to populate.
//!
//! Records are appended as JSON lines to `<dataDir>/logs/diagnostics-<day>.jsonl`.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::paths;

/// Cap on any single free-text field persisted in a record, so a runaway prompt
/// or tool output can't bloat the log (keeps writes small and cheap).
const MAX_FIELD: usize = 4000;
/// Keep at most this many days of per-turn diagnostics files (pruned at startup).
const RETENTION_DAYS: i64 = 7;
/// Max JSONL lines pulled into an export bundle (bounds the shareable file size).
const EXPORT_MAX_LINES: usize = 500;

/// One tool invocation observed during a turn.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolDiag {
  pub name: String,
  pub ok: bool,
  /// Truncated tool output/error — populated in full-diagnostics mode only.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub output: Option<String>,
}

/// A single chat turn's diagnostics record (serialized as one JSONL line).
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnDiagnostics {
  /// RFC 3339 timestamp the turn finished.
  pub time: String,
  pub app_version: String,
  pub os: String,
  pub project_id: String,
  pub turn_id: String,
  pub session_id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub model: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub mode: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub effort: Option<String>,
  pub duration_ms: u64,
  pub attempts: u32,
  pub attachments: usize,
  pub files_modified: usize,
  pub ran_deploy: bool,
  /// One of `ok` | `cancelled` | `timed_out` | `error` | `send_error` |
  /// `incomplete`.
  pub outcome: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  /// Count of dropped events reported by the SDK subscription (stream lag).
  pub lagged_events: u64,
  /// True if the event stream closed before the turn reached a terminal state.
  pub stream_closed: bool,
  pub tools: Vec<ToolDiag>,
  /// Full-diagnostics mode only: the user's prompt text (truncated).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub prompt: Option<String>,
  /// Full-diagnostics mode only: the assistant's response text (truncated).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub response: Option<String>,
}

/// Truncate a string to a bounded number of characters for storage. Multi-byte
/// safe (operates on `char`s).
pub fn clip(text: &str) -> String {
  if text.chars().count() <= MAX_FIELD {
    return text.to_string();
  }
  let head: String = text.chars().take(MAX_FIELD).collect();
  format!("{head}… (truncated)")
}

/// Whether the user has opted into full (content-capturing) diagnostics. Reads
/// the in-memory settings cache, so it is cheap to call once per turn.
pub fn full_enabled() -> bool {
  super::store::get_settings()
    .full_diagnostics
    .unwrap_or(false)
}

fn day() -> String {
  chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// Append one record as a JSON line into `dir`. Best-effort; never panics and
/// never creates the directory (callers use [`paths::logs_dir`], which does).
fn append_to(dir: &Path, rec: &TurnDiagnostics) {
  let Ok(line) = serde_json::to_string(rec) else {
    return;
  };
  let path = dir.join(format!("diagnostics-{}.jsonl", day()));
  if let Ok(mut f) = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
  {
    let _ = writeln!(f, "{line}");
  }
}

/// Record one chat turn. Called once per turn from the turn engine; a failure
/// here is swallowed so diagnostics can never break a chat.
pub fn record_turn(rec: &TurnDiagnostics) {
  append_to(&paths::logs_dir(), rec);
}

/// Collect the tail of the most recent files in `dir` whose name starts with
/// `prefix`, newest last, capped at `max_lines` total lines.
fn recent_lines(dir: &Path, prefix: &str, max_lines: usize) -> String {
  let mut files: Vec<PathBuf> = match std::fs::read_dir(dir) {
    Ok(rd) => rd
      .flatten()
      .map(|e| e.path())
      .filter(|p| {
        p.is_file()
          && p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with(prefix))
            .unwrap_or(false)
      })
      .collect(),
    Err(_) => return String::new(),
  };
  // Dated file names (`*-YYYY-MM-DD.*`) sort chronologically, so a lexical sort
  // puts the newest last; read the last few so the tail is the most recent.
  files.sort();
  let mut lines: Vec<String> = Vec::new();
  for path in files.iter().rev().take(3).rev() {
    if let Ok(content) = std::fs::read_to_string(path) {
      lines.extend(content.lines().map(|l| l.to_string()));
    }
  }
  let start = lines.len().saturating_sub(max_lines);
  lines[start..].join("\n")
}

/// Assemble the shareable bundle body from the environment header and the recent
/// diagnostics + crash logs found in `dir`. Pure (no I/O beyond reading `dir`),
/// so it is unit-testable.
fn build_bundle(dir: &Path, app_version: &str, extra_env: &[(&str, String)]) -> String {
  let mut out = String::new();
  out.push_str("# Fabricator diagnostics\n\n");
  out.push_str("Attach this file to your bug report. It contains no credentials.\n\n");
  out.push_str("## Environment\n\n");
  out.push_str(&format!("- generated: {}\n", chrono::Utc::now().to_rfc3339()));
  out.push_str(&format!("- app: {app_version}\n"));
  out.push_str(&format!("- os: {}\n", std::env::consts::OS));
  out.push_str(&format!("- arch: {}\n", std::env::consts::ARCH));
  for (k, v) in extra_env {
    out.push_str(&format!("- {k}: {v}\n"));
  }
  out.push_str("\n## Recent chat-turn diagnostics\n\n```jsonl\n");
  out.push_str(&recent_lines(dir, "diagnostics-", EXPORT_MAX_LINES));
  out.push_str("\n```\n\n## Recent crash / hang log\n\n```\n");
  out.push_str(&recent_lines(dir, "main-", EXPORT_MAX_LINES));
  out.push_str("\n```\n");
  out
}

/// Build a single consolidated, shareable diagnostics file under the logs
/// directory and return its path. Bundles the environment, recent per-turn
/// diagnostics, and the tail of the crash/hang log into one Markdown file the
/// user can attach to a bug report.
pub fn export_bundle(app_version: &str, extra_env: &[(&str, String)]) -> Result<PathBuf, String> {
  let dir = paths::logs_dir();
  let body = build_bundle(&dir, app_version, extra_env);
  let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
  let out = dir.join(format!("fabricator-diagnostics-{ts}.md"));
  std::fs::write(&out, body).map_err(|e| e.to_string())?;
  Ok(out)
}

/// Delete diagnostics JSONL files and exported bundles older than the retention
/// window. Best-effort; intended to run once at startup so the logs directory
/// stays bounded without adding per-turn I/O.
pub fn prune() {
  let dir = paths::logs_dir();
  // `diagnostics-YYYY-MM-DD.jsonl`: the date sorts lexically, so compare the
  // embedded date string against the cutoff date string (no date parsing).
  let cutoff = (chrono::Utc::now() - chrono::Duration::days(RETENTION_DAYS))
    .format("%Y-%m-%d")
    .to_string();
  let bundle_max_age =
    std::time::Duration::from_secs(RETENTION_DAYS.max(0) as u64 * 24 * 60 * 60);
  let Ok(rd) = std::fs::read_dir(&dir) else {
    return;
  };
  for entry in rd.flatten() {
    let path = entry.path();
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
      continue;
    };
    if let Some(date) = name
      .strip_prefix("diagnostics-")
      .and_then(|s| s.strip_suffix(".jsonl"))
    {
      if date < cutoff.as_str() {
        let _ = std::fs::remove_file(&path);
      }
    } else if name.starts_with("fabricator-diagnostics-") && name.ends_with(".md") {
      if let Ok(age) = entry.metadata().and_then(|m| m.modified()).map(|m| m.elapsed()) {
        if age.map(|a| a > bundle_max_age).unwrap_or(false) {
          let _ = std::fs::remove_file(&path);
        }
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn sample() -> TurnDiagnostics {
    TurnDiagnostics {
      time: "2026-01-01T00:00:00Z".into(),
      app_version: "1.2.3".into(),
      os: "windows".into(),
      project_id: "proj-1".into(),
      turn_id: "turn-1".into(),
      session_id: "sess-1".into(),
      model: Some("gpt-5".into()),
      mode: Some("agent".into()),
      effort: None,
      duration_ms: 1234,
      attempts: 1,
      attachments: 0,
      files_modified: 2,
      ran_deploy: false,
      outcome: "ok".into(),
      error: None,
      lagged_events: 0,
      stream_closed: false,
      tools: vec![ToolDiag { name: "shell".into(), ok: true, output: None }],
      prompt: None,
      response: None,
    }
  }

  fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "rayfin-diag-test-{tag}-{}",
      uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn appends_a_parseable_jsonl_line() {
    let dir = tmp_dir("append");
    let rec = sample();
    append_to(&dir, &rec);
    append_to(&dir, &rec);

    let file = dir.join(format!("diagnostics-{}.jsonl", day()));
    let content = std::fs::read_to_string(&file).unwrap();
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 2, "each record is one line");

    let parsed: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(parsed["outcome"], "ok");
    assert_eq!(parsed["projectId"], "proj-1");
    assert_eq!(parsed["filesModified"], 2);
    assert_eq!(parsed["tools"][0]["name"], "shell");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn metadata_mode_omits_prompt_and_response() {
    let rec = sample();
    let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&rec).unwrap()).unwrap();
    assert!(json.get("prompt").is_none(), "prompt omitted in metadata mode");
    assert!(json.get("response").is_none(), "response omitted in metadata mode");
  }

  #[test]
  fn full_mode_includes_prompt_and_response() {
    let mut rec = sample();
    rec.prompt = Some("hello".into());
    rec.response = Some("hi there".into());
    let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&rec).unwrap()).unwrap();
    assert_eq!(json["prompt"], "hello");
    assert_eq!(json["response"], "hi there");
  }

  #[test]
  fn clip_truncates_long_text() {
    let long = "x".repeat(MAX_FIELD + 50);
    let clipped = clip(&long);
    assert!(clipped.chars().count() < long.chars().count());
    assert!(clipped.ends_with("(truncated)"));

    let short = "short";
    assert_eq!(clip(short), short, "short text is left untouched");
  }

  #[test]
  fn append_to_a_bad_dir_does_not_panic() {
    // Point at a path whose parent does not exist: the open fails and is
    // swallowed rather than panicking.
    let bad = std::env::temp_dir()
      .join("rayfin-diag-missing")
      .join(uuid::Uuid::new_v4().to_string())
      .join("nested");
    append_to(&bad, &sample());
    // Nothing to assert beyond "did not panic".
  }

  #[test]
  fn bundle_contains_env_header_and_recent_records() {
    let dir = tmp_dir("bundle");
    append_to(&dir, &sample());

    let body = build_bundle(
      &dir,
      "9.9.9",
      &[("tauri", "2.0.0".to_string()), ("copilot", "1.0.0".to_string())],
    );
    assert!(body.contains("# Fabricator diagnostics"));
    assert!(body.contains("- app: 9.9.9"));
    assert!(body.contains("- tauri: 2.0.0"));
    assert!(body.contains("Recent chat-turn diagnostics"));
    // The recorded turn is embedded in the bundle.
    assert!(body.contains("\"turnId\":\"turn-1\"") || body.contains("turn-1"));
    let _ = std::fs::remove_dir_all(&dir);
  }
}
