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
//!
//! The export also carries each project's local backend: its status and the
//! tail of its output log. Everything in the export goes through [`redact`]
//! first, because it ends up attached to a public bug report.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

use super::paths;
use crate::types::{LocalBackendState, LocalStatus};

/// Cap on any single free-text field persisted in a record, so a runaway prompt
/// or tool output can't bloat the log (keeps writes small and cheap).
const MAX_FIELD: usize = 4000;
/// Keep at most this many days of per-turn diagnostics files (pruned at startup).
const RETENTION_DAYS: i64 = 7;
/// Max JSONL lines pulled into an export bundle (bounds the shareable file size).
const EXPORT_MAX_LINES: usize = 500;
/// Lines of each project's local backend output put in an export.
const EXPORT_LOCAL_LINES: usize = 300;
/// Most projects whose local backend an export describes.
const EXPORT_LOCAL_PROJECTS: usize = 6;

/// The folder under the logs directory where the local backend supervisor
/// (`services::local_backend`) keeps each project's output, as `<id>.log`
/// rolled over to `<id>.log.1`.
pub const LOCAL_LOG_DIR: &str = "local-backend";

/* ----------------------------- redaction ----------------------------- */

/// `rayfin-local`'s publishable keys: `pk-local-` and 24 letters or digits.
static PUBLISHABLE_KEY: Lazy<Regex> = Lazy::new(|| Regex::new(r"\bpk-local-[A-Za-z0-9_-]+").unwrap());
/// A control token (`RAYFIN_LOCAL_CONTROL_TOKEN`) is 64 hex characters, as is
/// any other 256-bit secret printed in hex.
static HEX_SECRET: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b[0-9A-Fa-f]{64}\b").unwrap());
/// Email addresses, which is also what Microsoft Entra user names (UPNs) look like.
static EMAIL: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b").unwrap());

/// `text` with credentials masked: bearer tokens and JWTs, `pk-local-…`
/// publishable keys, 64-character hex secrets such as the local backend's
/// control token, and the values of secret-looking assignments and well-known
/// token formats. For text Help reads and the activity journal.
pub fn redact_secrets(text: &str) -> String {
  let text = super::fabric_auth::redact(text);
  let text = PUBLISHABLE_KEY.replace_all(&text, "pk-local-***");
  let text = HEX_SECRET.replace_all(&text, "***");
  crate::commands::advisor::mask_secrets(&text)
}

/// [`redact_secrets`], and also email addresses (user names) and the user's
/// home folder: for files the user shares. Addresses at the reserved
/// `example.*` domains, such as the local backend's `developer@example.com`,
/// are nobody's and stay as they are.
pub fn redact(text: &str) -> String {
  let text = redact_secrets(text);
  let text = EMAIL.replace_all(&text, |c: &regex::Captures| {
    let domain = c[1].to_ascii_lowercase();
    let reserved = ["example.com", "example.org", "example.net"]
      .iter()
      .any(|d| domain == *d || domain.ends_with(&format!(".{d}")));
    if reserved {
      c[0].to_string()
    } else {
      format!("***@{}", &c[1])
    }
  });
  mask_home(&text, &paths::home_dir())
}

/// `text` with the home folder written as `~`, also where it appears with its
/// backslashes escaped (inside JSON) or turned into forward slashes.
fn mask_home(text: &str, home: &Path) -> String {
  let home = home.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
  // A root or a relative fallback would mask far too much.
  if home.len() < 4 || !Path::new(&home).is_absolute() {
    return text.to_string();
  }
  let mut forms = vec![home.clone(), home.replace('\\', "\\\\"), home.replace('\\', "/")];
  forms.dedup();
  let pattern = forms.iter().map(|f| regex::escape(f)).collect::<Vec<_>>().join("|");
  // Only the whole folder: `C:\Users\sam` is not the start of `C:\Users\samantha`.
  match Regex::new(&format!(r#"(?i)(?:{pattern})([\\/"'\s,;)\]]|$)"#)) {
    Ok(re) => re.replace_all(text, "~$1").into_owned(),
    Err(_) => text.to_string(),
  }
}

/* ----------------------------- local backend logs ----------------------------- */

/// A project id as the supervisor names its log file: ids are UUIDs, and
/// anything else is made safe as `services::local_backend` does.
fn local_log_name(project_id: &str) -> String {
  let name: String =
    project_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
  if name.is_empty() {
    "_".into()
  } else {
    name
  }
}

/// A project's local backend log files under `logs`, oldest first: the rolled
/// over `<id>.log.1`, then the current `<id>.log`.
pub fn local_log_files(logs: &Path, project_id: &str) -> [PathBuf; 2] {
  let dir = logs.join(LOCAL_LOG_DIR);
  let name = local_log_name(project_id);
  [dir.join(format!("{name}.log.1")), dir.join(format!("{name}.log"))]
}

/// The last `max_lines` lines of a project's local backend log, oldest first,
/// exactly as written (`<time> <source> <level> <line>`), not yet redacted.
pub fn local_log_lines(logs: &Path, project_id: &str, max_lines: usize) -> Vec<String> {
  let mut lines: Vec<String> = Vec::new();
  for path in local_log_files(logs, project_id) {
    if let Ok(bytes) = std::fs::read(&path) {
      lines.extend(String::from_utf8_lossy(&bytes).lines().filter(|l| !l.trim().is_empty()).map(str::to_string));
    }
  }
  let start = lines.len().saturating_sub(max_lines);
  lines.split_off(start)
}

/// One project's local backend, for an export.
#[derive(Clone, Debug)]
pub struct LocalBackendReport {
  pub project_id: String,
  pub project_name: String,
  /// What the supervisor holds; `None` when the backend hasn't run since
  /// Fabricator started.
  pub status: Option<LocalStatus>,
}

/// When a project's local backend last wrote output, if it ever did.
fn local_log_written(logs: &Path, project_id: &str) -> Option<SystemTime> {
  local_log_files(logs, project_id).iter().filter_map(|path| std::fs::metadata(path).and_then(|m| m.modified()).ok()).max()
}

/// A local backend state as the status reports it.
pub fn state_name(state: LocalBackendState) -> &'static str {
  match state {
    LocalBackendState::Stopped => "stopped",
    LocalBackendState::Starting => "starting",
    LocalBackendState::Running => "running",
    LocalBackendState::Restarting => "restarting",
    LocalBackendState::Error => "error",
  }
}

/// The export's local backend section: per project, its status and the tail
/// of its output. The backends that ran since Fabricator started come first,
/// then the ones with the newest output, up to [`EXPORT_LOCAL_PROJECTS`];
/// output older than the retention window is left out.
fn local_backends_section(dir: &Path, reports: &[LocalBackendReport]) -> String {
  let cutoff = SystemTime::now().checked_sub(Duration::from_secs(RETENTION_DAYS as u64 * 24 * 3600));
  let mut picked: Vec<(&LocalBackendReport, Option<SystemTime>)> = reports
    .iter()
    .map(|report| (report, local_log_written(dir, &report.project_id)))
    .filter(|(report, written)| report.status.is_some() || written.is_some_and(|at| cutoff.is_none_or(|cut| at >= cut)))
    .collect();
  picked.sort_by(|(a, a_written), (b, b_written)| {
    b.status.is_some().cmp(&a.status.is_some()).then_with(|| b_written.cmp(a_written))
  });
  let left_out = picked.len().saturating_sub(EXPORT_LOCAL_PROJECTS);
  picked.truncate(EXPORT_LOCAL_PROJECTS);

  let mut out = String::from("## Local backends\n\n");
  if picked.is_empty() {
    out.push_str("No project's local backend has run recently.\n\n");
  }
  for (report, _) in picked {
    let lines = local_log_lines(dir, &report.project_id, EXPORT_LOCAL_LINES);
    out.push_str(&format!("### {}\n\n- project: `{}`\n", report.project_name.trim(), report.project_id));
    match &report.status {
      Some(status) => {
        out.push_str(&format!("- state: {}\n\n````json\n", state_name(status.state)));
        out.push_str(&serde_json::to_string_pretty(status).unwrap_or_default());
        out.push_str("\n````\n\n");
      }
      None => out.push_str("- state: not run since Fabricator started\n\n"),
    }
    if lines.is_empty() {
      out.push_str("No output on disk.\n\n");
    } else {
      out.push_str(&format!("Recent output (`{LOCAL_LOG_DIR}/`, oldest first):\n\n````text\n"));
      out.push_str(&lines.join("\n"));
      out.push_str("\n````\n\n");
    }
  }
  if left_out > 0 {
    out.push_str(&format!(
      "{left_out} more project{} with older local backend output left out.\n\n",
      if left_out == 1 { "" } else { "s" }
    ));
  }
  out
}

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

/// Assemble the shareable bundle body from the environment header, the recent
/// diagnostics and crash logs found in `dir`, and the local backends, all
/// [redacted](redact). Pure (no I/O beyond reading `dir`), so it is unit-testable.
fn build_bundle(
  dir: &Path,
  app_version: &str,
  extra_env: &[(&str, String)],
  local: &[LocalBackendReport],
) -> String {
  let mut out = String::new();
  out.push_str("# Fabricator diagnostics\n\n");
  out.push_str(
    "Attach this file to your bug report. It contains no credentials: tokens, keys and email addresses are masked.\n\n",
  );
  out.push_str("## Environment\n\n");
  out.push_str(&format!("- generated: {}\n", chrono::Utc::now().to_rfc3339()));
  out.push_str(&format!("- app: {app_version}\n"));
  out.push_str(&format!("- os: {}\n", std::env::consts::OS));
  out.push_str(&format!("- arch: {}\n", std::env::consts::ARCH));
  for (k, v) in extra_env {
    out.push_str(&format!("- {k}: {v}\n"));
  }
  out.push_str("\n## Recent activity\n\n```jsonl\n");
  out.push_str(&recent_lines(dir, "activity-", EXPORT_MAX_LINES));
  out.push_str("\n```\n\n## Recent chat-turn diagnostics\n\n```jsonl\n");
  out.push_str(&recent_lines(dir, "diagnostics-", EXPORT_MAX_LINES));
  out.push_str("\n```\n\n## Recent crash / hang log\n\n```\n");
  out.push_str(&recent_lines(dir, "main-", EXPORT_MAX_LINES));
  out.push_str("\n```\n\n");
  out.push_str(&local_backends_section(dir, local));
  redact(&out)
}

/// Build a single consolidated, shareable diagnostics file under the logs
/// directory and return its path. Bundles the environment, recent per-turn
/// diagnostics, the tail of the crash/hang log and each project's local
/// backend into one Markdown file the user can attach to a bug report.
pub fn export_bundle(
  app_version: &str,
  extra_env: &[(&str, String)],
  local: &[LocalBackendReport],
) -> Result<PathBuf, String> {
  let dir = paths::logs_dir();
  let body = build_bundle(&dir, app_version, extra_env, local);
  let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
  let out = dir.join(format!("fabricator-diagnostics-{ts}.md"));
  std::fs::write(&out, body).map_err(|e| e.to_string())?;
  Ok(out)
}

/// Delete diagnostics JSONL files and exported bundles older than the retention
/// window. Best-effort; intended to run once at startup so the logs directory
/// stays bounded without adding per-turn I/O.
pub fn prune() {
  super::journal::prune(RETENTION_DAYS);
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
      &[],
    );
    assert!(body.contains("# Fabricator diagnostics"));
    assert!(body.contains("- app: 9.9.9"));
    assert!(body.contains("- tauri: 2.0.0"));
    assert!(body.contains("Recent activity"));
    assert!(body.contains("Recent chat-turn diagnostics"));
    // The recorded turn is embedded in the bundle.
    assert!(body.contains("\"turnId\":\"turn-1\"") || body.contains("turn-1"));
    let _ = std::fs::remove_dir_all(&dir);
  }

  const JWT: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJlLXZhbHVl";

  fn control_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
  }

  #[test]
  fn redaction_masks_tokens_keys_and_people() {
    let token = control_token();
    let scheme = "Bearer";
    let text = format!(
      "Authorization: {scheme} {JWT} | key pk-local-abcdefghijklmnopqrstuvwx | {token} | signed in as ana@contoso.com"
    );
    let shared = redact(&text);
    for secret in [JWT, "abcdefghijklmnopqrstuvwx", token.as_str(), "ana@"] {
      assert!(!shared.contains(secret), "{secret} leaked: {shared}");
    }
    assert!(shared.contains("pk-local-***"));
    assert!(shared.contains("***@contoso.com"), "the domain stays, the person doesn't: {shared}");

    // Help reads people's names; only credentials are masked for it.
    let for_help = redact_secrets(&text);
    assert!(!for_help.contains(JWT) && !for_help.contains(&token) && !for_help.contains("abcdefghijklmnopqrstuvwx"));
    assert!(for_help.contains("ana@contoso.com"));
  }

  #[test]
  fn the_local_developer_and_package_versions_are_not_people() {
    let text = "Signed in as developer@example.com with @microsoft/rayfin-core@1.36.2 and vite@8.0.16.";
    assert_eq!(redact(text), text);
  }

  #[test]
  fn the_home_folder_is_written_as_a_tilde() {
    let home = if cfg!(windows) { Path::new("C:\\Users\\sam") } else { Path::new("/Users/sam") };
    let (plain, escaped) = if cfg!(windows) {
      ("C:\\Users\\sam\\apps\\notes", "\"C:\\\\Users\\\\sam\\\\apps\"")
    } else {
      ("/Users/sam/apps/notes", "\"/Users/sam/apps\"")
    };
    assert!(mask_home(plain, home).starts_with('~'), "{}", mask_home(plain, home));
    assert!(mask_home(escaped, home).starts_with("\"~"), "{}", mask_home(escaped, home));
    let other = if cfg!(windows) { "C:\\Users\\samantha\\x" } else { "/Users/samantha/x" };
    assert_eq!(mask_home(other, home), other, "another user's folder isn't the home folder");
    assert_eq!(mask_home("C:\\x", Path::new("C:\\")), "C:\\x", "a root is never masked");
  }

  #[test]
  fn a_local_backend_log_is_read_oldest_first_and_cut_to_its_tail() {
    let dir = tmp_dir("local-log");
    let [rolled, current] = local_log_files(&dir, "p-1");
    std::fs::create_dir_all(current.parent().unwrap()).unwrap();
    std::fs::write(&rolled, "t vite info one\nt vite info two\n").unwrap();
    std::fs::write(&current, "t vite info three\n\nt vite info four\n").unwrap();
    assert_eq!(local_log_lines(&dir, "p-1", 10), ["t vite info one", "t vite info two", "t vite info three", "t vite info four"]);
    assert_eq!(local_log_lines(&dir, "p-1", 2), ["t vite info three", "t vite info four"]);
    assert!(local_log_lines(&dir, "missing", 10).is_empty());
    let [_, escape] = local_log_files(&dir, "../escape");
    assert!(escape.starts_with(dir.join(LOCAL_LOG_DIR)), "a project id can't leave the folder");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn the_bundle_carries_each_local_backend_redacted() {
    let dir = tmp_dir("bundle-local");
    let token = control_token();
    let [_, log] = local_log_files(&dir, "p-1");
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::fs::write(
      &log,
      format!(
        "2026-10-30T03:12:01Z vite info GET /graphql Authorization: Bearer {JWT}\n2026-10-30T03:12:02Z stderr warn token {token}\n2026-10-30T03:12:03Z rayfin-local error The change would delete data: Note.title\n"
      ),
    )
    .unwrap();
    let status = LocalStatus {
      project_id: "p-1".into(),
      state: LocalBackendState::Error,
      revision: 7,
      error: Some(crate::types::LocalProblem {
        code: "already-serving".into(),
        message: "ana@contoso.com already serves it with pk-local-abcdefghijklmnopqrstuvwx".into(),
        fatal: true,
        ..Default::default()
      }),
      ..Default::default()
    };
    let reports = [
      LocalBackendReport { project_id: "p-1".into(), project_name: "Contoso Expenses".into(), status: Some(status) },
      LocalBackendReport { project_id: "p-2".into(), project_name: "Never ran".into(), status: None },
    ];

    let body = build_bundle(&dir, "9.9.9", &[], &reports);
    assert!(body.contains("## Local backends"));
    assert!(body.contains("### Contoso Expenses"));
    assert!(body.contains("- state: error"));
    assert!(body.contains("\"code\": \"already-serving\""), "the status snapshot is there");
    assert!(body.contains("The change would delete data: Note.title"), "the output is there");
    assert!(!body.contains("Never ran"), "a backend with nothing to show is left out");
    for secret in [JWT, token.as_str(), "abcdefghijklmnopqrstuvwx", "ana@contoso.com"] {
      assert!(!body.contains(secret), "{secret} leaked into the bundle");
    }
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_bundle_without_local_backends_says_so() {
    let dir = tmp_dir("bundle-none");
    let body = build_bundle(&dir, "9.9.9", &[], &[]);
    assert!(body.contains("No project's local backend has run recently."));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn the_bundle_keeps_to_recent_local_backends() {
    let dir = tmp_dir("bundle-recent");
    let write = |id: &str, age_days: u64| {
      let [_, log] = local_log_files(&dir, id);
      std::fs::create_dir_all(log.parent().unwrap()).unwrap();
      std::fs::write(&log, format!("2026-10-30T03:12:01Z vite info output of {id}\n")).unwrap();
      let at = SystemTime::now() - Duration::from_secs(age_days * 24 * 3600);
      std::fs::File::options().write(true).open(&log).unwrap().set_modified(at).unwrap();
    };
    let report = |id: &str, status: Option<LocalStatus>| LocalBackendReport {
      project_id: id.into(),
      project_name: format!("App {id}"),
      status,
    };
    // A month-old log, a backend running now with an older log than the rest,
    // and more recent logs than an export takes.
    write("stale", 30);
    write("running", 3);
    let mut reports = vec![
      report("stale", None),
      report("running", Some(LocalStatus { project_id: "running".into(), revision: 4, ..Default::default() })),
    ];
    for i in 0..EXPORT_LOCAL_PROJECTS {
      let id = format!("recent-{i}");
      write(&id, i as u64);
      reports.push(report(&id, None));
    }

    let body = build_bundle(&dir, "9.9.9", &[], &reports);
    assert!(!body.contains("output of stale"), "output older than the retention window is left out");
    let running = body.find("### App running").expect("the backend that ran this session is there");
    let newest = body.find("### App recent-0").expect("the newest output is there");
    assert!(running < newest, "this session's backends come first");
    assert!(body.contains("### App recent-4"));
    assert!(!body.contains("### App recent-5"), "the oldest of the rest is over the cap");
    assert!(body.contains("1 more project with older local backend output left out."));
    let _ = std::fs::remove_dir_all(&dir);
  }
}
