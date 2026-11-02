//! Checking a project or app file for security risks before it's imported or
//! installed, at the user's choice.
//!
//! Fabricator unpacks the file into a folder of its own, where nothing in it
//! runs: no programs, media, large or secret files, and of git's data only its
//! settings. Its own checks read the files for what would run on this computer
//! and where the packages come from (`checks`). Then Copilot reviews the code,
//! on Auto, in a session that can only read that folder, takes none of the
//! package's files as its own instructions, skills or settings, and reports
//! through tools (`tools`), so findings stream to the window as they're
//! confirmed. The folder is removed when the check ends.

mod checks;
mod prompt;
mod tools;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use github_copilot_sdk::MessageOptions;
use once_cell::sync::Lazy;
use serde_json::Value;
use tauri::{AppHandle, State, Window, WindowEvent};

use crate::commands::advisor::{self, evidence, DrainEnd, Sandbox};
use crate::commands::chat_tools;
use crate::commands::export::{self, PackageFile};
use crate::services::copilot::{CopilotManager, ModelChoice, COPILOT_SIGN_IN_REQUIRED};
use crate::services::emit::emit_security_event;
use crate::services::exec::CancelToken;
use crate::services::journal::{self, Area, Level};
use crate::services::paths;
use crate::state::AppState;
use crate::types::{ChatToolCall, ChatToolState, SecurityEvent, SecurityReport};
use tools::{CheckContext, CheckCore, CheckLog, Emit, SharedLog};

/// The most Copilot's review may take.
const RUN_TIMEOUT_MS: u64 = 6 * 60_000;
/// The most unpacked for one check.
const MAX_REVIEW_BYTES: u64 = 96 * 1024 * 1024;
/// Output kept per activity step (the window shows a preview).
const MAX_ACTIVITY_OUTPUT: usize = 1500;
/// The longest an excerpt's line is shown: minified code has lines of thousands of characters.
const MAX_EXCERPT_LINE: usize = 240;
/// Media, fonts, archives and documents: nothing in them to read for a security check.
const NOT_READ: &[&str] = &[
  "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "bmp", "ico", "icns", "tif", "tiff", "psd", "mp3", "mp4", "m4a", "mov",
  "webm", "wav", "ogg", "flac", "avi", "mkv", "woff", "woff2", "ttf", "otf", "eot", "zip", "gz", "tgz", "bz2", "xz", "7z",
  "zst", "br", "rar", "tar", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "sqlite", "db", "wasm",
];
/// Built-in tools a check doesn't use, beside the read-only sessions' (see `advisor::EXCLUDED_TOOLS`).
const ALSO_EXCLUDED: &[&str] = &["web_fetch", "fetch", "skill"];

/// Checks that are running, by the id the window gave them, with what stops them.
static CHECKS: Lazy<Mutex<HashMap<String, CancelToken>>> = Lazy::new(Default::default);

/// What's being checked: a project to import, or an app to install.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
  Project,
  App,
}

/// The areas a check covers, in the order the window shows them.
const AREAS: [&str; 6] = ["install", "packages", "network", "hidden", "system", "agents"];

/// An app isn't built with Copilot, so it has no instructions for coding agents to check.
fn areas_for(kind: Kind) -> Vec<&'static str> {
  AREAS.into_iter().filter(|area| kind == Kind::Project || *area != "agents").collect()
}

/// A severity's weight, `note` 0 to `high` 3.
fn rank(severity: &str) -> u8 {
  match severity {
    "high" => 3,
    "medium" => 2,
    "low" => 1,
    _ => 0,
  }
}

/// `text` with each line cut to a readable length.
fn clip_lines(text: &str) -> String {
  text
    .lines()
    .map(|line| {
      if line.chars().count() <= MAX_EXCERPT_LINE {
        line.to_string()
      } else {
        let cut: String = line.chars().take(MAX_EXCERPT_LINE - 1).collect();
        format!("{cut}…")
      }
    })
    .collect::<Vec<_>>()
    .join("\n")
}

/* ------------------------------- unpacking ------------------------------- */

fn extension_of(path: &str) -> String {
  let name = path.rsplit('/').next().unwrap_or(path);
  name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default()
}

/// Whether a check unpacks a file of this path and size: text it can read,
/// but nothing that may hold a secret. What the checks decide by gets more
/// room, so padding can't hide it.
fn worth_reading(path: &str, size: u64) -> bool {
  let max = if checks::decides(path) { checks::MAX_DECIDING_BYTES } else { checks::MAX_TEXT_BYTES };
  size <= max && !export::may_hold_secret(path) && !NOT_READ.contains(&extension_of(path).as_str())
}

/// An `.npmrc` setting without its sign-in: the key stays, so the setting still shows.
fn mask_npmrc_setting(setting: &str) -> String {
  if let Some((key, _)) = setting.split_once('=') {
    let lower = checks::ini_text(key).to_ascii_lowercase();
    if ["auth", "password", "token", "certfile", "keyfile", "cert", "key"].iter().any(|word| lower.ends_with(word)) {
      return format!("{}=••••••", key.trim_end());
    }
  }
  evidence::mask_secrets(setting)
}

/// Take the sign-ins out of the package's `.npmrc` files before anything reads
/// them. npm ends a setting at a `\r` too, so each part of a line is masked
/// on its own; one that can't be read is taken away.
fn mask_npmrcs(root: &Path, files: &[PackageFile]) {
  let npmrc = |f: &&PackageFile| f.unpacked && f.path.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case(".npmrc"));
  for file in files.iter().filter(npmrc) {
    let path = file.path.split('/').fold(root.to_path_buf(), |dir, part| dir.join(part));
    let Ok(bytes) = std::fs::read(&path) else {
      let _ = std::fs::remove_file(&path);
      continue;
    };
    let text = String::from_utf8_lossy(&bytes);
    let masked: Vec<String> =
      text.split('\n').map(|line| line.split('\r').map(mask_npmrc_setting).collect::<Vec<_>>().join("\r")).collect();
    if std::fs::write(&path, masked.join("\n")).is_err() {
      let _ = std::fs::remove_file(&path);
    }
  }
}

/// Remove a check's folder, trying again for a moment: on Windows, a search
/// Copilot ran may hold a file open as its session closes.
fn remove_dir(dir: &Path) {
  for _ in 0..10 {
    if !dir.exists() || std::fs::remove_dir_all(dir).is_ok() {
      return;
    }
    std::thread::sleep(Duration::from_millis(200));
  }
  log::warn!("Couldn't remove the security check folder {}", dir.display());
}

/// Delete what checks left behind when Fabricator stopped part way.
pub fn clean_up() {
  let dir = paths::package_checks_dir();
  if dir.is_dir() {
    if let Err(e) = std::fs::remove_dir_all(&dir) {
      log::warn!("failed to remove security check folders at {}: {e}", dir.display());
    }
  }
}

/* ----------------------------- Copilot's review ----------------------------- */

fn now_ms() -> f64 {
  chrono::Utc::now().timestamp_millis() as f64
}

/// The tool calls Copilot makes, as the chat's step rows show them.
#[derive(Default)]
struct Activity {
  tools: HashMap<String, ChatToolCall>,
}

impl Activity {
  fn feed(&mut self, event_type: &str, data: &Value) -> Option<ChatToolCall> {
    match event_type {
      "tool.execution_start" => {
        let name = data.get("toolName").and_then(Value::as_str).unwrap_or("tool").to_string();
        if tools::is_reporting_tool(&name) || name == "report_intent" {
          return None;
        }
        let id = data.get("toolCallId").and_then(Value::as_str)?.to_string();
        let args = data.get("arguments");
        let tool = ChatToolCall {
          id: id.clone(),
          title: chat_tools::tool_title(&name, args),
          command: chat_tools::shell_command(&name, args),
          paths: chat_tools::tool_paths(&name, args),
          name,
          state: ChatToolState::Running,
          started_at: Some(now_ms()),
          ..Default::default()
        };
        self.tools.insert(id, tool.clone());
        Some(tool)
      }
      "tool.execution_complete" => {
        let id = data.get("toolCallId").and_then(Value::as_str)?;
        let tool = self.tools.get_mut(id)?;
        let details = chat_tools::tool_end_details(Some(&tool.name), data);
        let success = data.get("success").and_then(Value::as_bool).unwrap_or(false);
        tool.state = if success { ChatToolState::Success } else { ChatToolState::Error };
        tool.output = details.output.map(|o| chat_tools::truncate(&o, MAX_ACTIVITY_OUTPUT));
        tool.exit_code = details.exit_code;
        tool.ended_at = Some(now_ms());
        Some(tool.clone())
      }
      _ => None,
    }
  }
}

/// Have Copilot review the package unpacked at `root`. `Err` means the review
/// never started; otherwise how it ended, and the error it reported, if any.
async fn review(
  copilot: &CopilotManager,
  root: &str,
  ctx: Arc<CheckContext>,
  prompt: String,
  token: &CancelToken,
) -> Result<(DrainEnd, Option<String>), String> {
  // Read only the package, nothing on the web, and no MCP server.
  let sandbox = Sandbox { url_hosts: &[], read_only_mcp: false };
  let mut opts = advisor::sandboxed_options(root, sandbox);
  opts.untrusted = true;
  opts.excluded_tools.extend(ALSO_EXCLUDED.iter().map(|t| t.to_string()));
  opts.tools = tools::check_tools(ctx.clone());
  let session = copilot.transient_session_with(root, ModelChoice::auto(), opts).await?;
  let sub = session.subscribe();
  if let Err(e) = session.send(MessageOptions::new(prompt)).await {
    let _ = session.disconnect().await;
    return Err(e.to_string());
  }
  let mut activity = Activity::default();
  let mut error = None;
  let end = advisor::drain(&session, sub, token, RUN_TIMEOUT_MS, |event_type, data| {
    if let Some(tool) = activity.feed(event_type, data) {
      (ctx.emit)(SecurityEvent::Activity { tool });
    }
    if event_type == "session.error" {
      let message = data.get("message").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty());
      error = Some(message.unwrap_or("Copilot reported an error.").to_string());
    }
    matches!(event_type, "session.idle" | "session.error")
  })
  .await;
  // These sessions are never reused.
  let _ = session.disconnect().await;
  Ok((end, error))
}

/// A reason the review didn't run, as the window says it.
fn plain_error(error: &str) -> String {
  if error == COPILOT_SIGN_IN_REQUIRED {
    return "GitHub Copilot isn’t signed in. Sign in to Copilot in Fabricator, then check again.".into();
  }
  error.trim().replace("retry your message", "check again")
}

/// The report from what the checks and Copilot found, and how the review ended.
fn finalize(log: &CheckLog, areas: &[&str], files: (u64, u64), end: Result<(DrainEnd, Option<String>), String>) -> SecurityReport {
  let mut report = SecurityReport {
    findings: log.findings.clone(),
    files: files.0,
    readable: files.1,
    ..Default::default()
  };
  match end {
    Err(error) => report.error = Some(plain_error(&error)),
    Ok((DrainEnd::Cancelled, _)) => report.cancelled = true,
    Ok(_) if log.completed => report.ok = true,
    Ok((end, error)) if log.reported => {
      // Copilot reported some of what it found, then stopped before it was done.
      report.ok = true;
      report.partial = true;
      report.error = Some(match (end, error) {
        (_, Some(error)) => plain_error(&error),
        (DrainEnd::TimedOut, _) => format!("Copilot didn’t finish in {} minutes.", RUN_TIMEOUT_MS / 60_000),
        _ => "Copilot stopped before it finished.".to_string(),
      });
    }
    Ok((end, error)) => {
      report.error = Some(match (end, error) {
        (_, Some(error)) => plain_error(&error),
        (DrainEnd::TimedOut, _) => format!("Copilot didn’t finish in {} minutes.", RUN_TIMEOUT_MS / 60_000),
        _ => "Copilot ended without reporting what it found.".to_string(),
      })
    }
  }
  let said = if log.completed { log.verdict } else { None };
  report.verdict = tools::verdict(&log.findings, said).to_string();
  report.areas = log.area_results(areas, true);
  report.summary = match (&log.summary, report.verdict.as_str()) {
    (Some(summary), _) if report.ok => summary.clone(),
    (_, "danger") => "It has code that could harm this computer or your data.".into(),
    (_, "caution") => "It has things worth a look before you go ahead.".into(),
    _ => "Nothing in it looks risky.".into(),
  };
  report
}

/// Unpack and check the file at `source` in `dir`, then have Copilot review
/// it. Returns its name and the report.
async fn check(
  copilot: &CopilotManager,
  source: &Path,
  kind: Kind,
  dir: &Path,
  token: &CancelToken,
  emit: Emit,
) -> (String, SecurityReport) {
  let areas = areas_for(kind);
  let (from, root) = (source.to_path_buf(), dir.to_path_buf());
  let prepared = tokio::task::spawn_blocking(move || {
    std::fs::create_dir_all(&root).map_err(|e| format!("Fabricator couldn’t make a folder to check it in: {e}"))?;
    let (name, files) = export::unpack_for_check(&from, &root, worth_reading, checks::decides, MAX_REVIEW_BYTES)?;
    mask_npmrcs(&root, &files);
    let outcome = checks::run(&root, &files, kind);
    Ok::<_, String>((name, outcome))
  })
  .await
  .map_err(|e| e.to_string())
  .and_then(|prepared| prepared);
  let (name, outcome) = match prepared {
    Ok(prepared) => prepared,
    Err(error) => {
      let name = source.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
      return (name, SecurityReport { verdict: "clear".into(), error: Some(error), ..Default::default() });
    }
  };

  let facts = &outcome.facts;
  let log: SharedLog = Arc::new(Mutex::new(CheckLog::new(&outcome.signals, &outcome.clear)));
  emit(SecurityEvent::Started {
    root: dir.to_string_lossy().to_string(),
    files: facts.files,
    areas: areas.iter().map(|a| a.to_string()).collect(),
  });
  for signal in &outcome.signals {
    emit(SecurityEvent::Finding { finding: signal.finding.clone() });
  }
  emit(SecurityEvent::Areas { results: log.lock().unwrap().area_results(&areas, false) });

  let found: Vec<_> = outcome.signals.iter().map(|s| s.finding.clone()).collect();
  let prompt = prompt::review_prompt(&name, kind, facts, &found, &areas);
  let end = if token.is_cancelled() {
    Ok((DrainEnd::Cancelled, None))
  } else {
    let core = CheckCore { root: dir.to_path_buf(), areas: areas.clone(), log: log.clone() };
    let ctx = Arc::new(CheckContext { emit, core });
    review(copilot, &dir.to_string_lossy(), ctx, prompt, token).await
  };
  let report = finalize(&log.lock().unwrap(), &areas, (facts.files, facts.readable), end);
  (name, report)
}

/* -------------------------------- commands -------------------------------- */

/// Check the project or app file at `path` for security risks before it's
/// imported or installed. Progress streams on `security:event` under
/// `check_id`, which [`security_check_cancel`] stops it by; closing the
/// window that asked stops it too. Resolves with the report however it ends,
/// except when the file can't be checked at all.
#[tauri::command]
pub async fn security_check(
  app: AppHandle,
  window: Window,
  state: State<'_, AppState>,
  check_id: String,
  path: String,
) -> Result<SecurityReport, String> {
  let check_id = check_id.trim().to_string();
  if check_id.is_empty() || check_id.len() > 80 {
    return Err("That isn’t a check Fabricator can run.".into());
  }
  let source = PathBuf::from(&path);
  let zip = source.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
  let kind = if export::is_app_file(&source) {
    Kind::App
  } else if export::is_export(&source) || zip {
    Kind::Project
  } else {
    return Err("Fabricator checks .fabricator, .rayfin and .zip files.".into());
  };
  if !source.is_file() {
    return Err("That file isn’t there anymore.".into());
  }
  let token = CancelToken::new();
  {
    let mut checks = CHECKS.lock().unwrap();
    if checks.contains_key(&check_id) {
      return Err("This check is already running.".into());
    }
    checks.insert(check_id.clone(), token.clone());
  }
  let stop = token.clone();
  window.on_window_event(move |event| {
    if matches!(event, WindowEvent::Destroyed) {
      stop.cancel();
    }
  });

  let started = Instant::now();
  let emit: Emit = {
    let (app, check_id) = (app.clone(), check_id.clone());
    Arc::new(move |event| emit_security_event(&app, &check_id, event))
  };
  let dir = paths::package_checks_dir().join(uuid::Uuid::new_v4().simple().to_string());
  let (name, mut report) = check(&state.copilot, &source, kind, &dir, &token, emit).await;
  let _ = tokio::task::spawn_blocking(move || remove_dir(&dir)).await;
  {
    let mut checks = CHECKS.lock().unwrap();
    if checks.get(&check_id).is_some_and(|t| t.same(&token)) {
      checks.remove(&check_id);
    }
  }
  report.duration_ms = started.elapsed().as_millis() as u64;

  let outcome = if report.cancelled {
    "stopped".to_string()
  } else if report.ok {
    format!("{} with {} findings", report.verdict, report.findings.len())
  } else {
    format!("Copilot's review didn't finish, {} findings from Fabricator's checks", report.findings.len())
  };
  let level = if report.ok || report.cancelled { Level::Info } else { Level::Warn };
  journal::entry(level, Area::Project, "package.checked", &format!("Checked \"{name}\" for security risks: {outcome}."))
    .operation("security_check")
    .detail(report.error.clone())
    .write();
  Ok(report)
}

/// Stop a security check. Returns whether one was running.
#[tauri::command]
pub fn security_check_cancel(check_id: String) -> bool {
  match CHECKS.lock().unwrap().get(check_id.trim()) {
    Some(token) => {
      token.cancel();
      true
    }
    None => false,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn log_with(findings: &[(&str, &str)], completed: bool, reported: bool) -> CheckLog {
    let signals: Vec<checks::Signal> = findings
      .iter()
      .enumerate()
      .map(|(i, (area, severity))| checks::Signal {
        finding: crate::types::SecurityFinding {
          id: format!("check:{i}"),
          area: area.to_string(),
          severity: severity.to_string(),
          ..Default::default()
        },
        floor: "low",
      })
      .collect();
    let mut log = CheckLog::new(&signals, &[]);
    log.completed = completed;
    log.reported = reported;
    log
  }

  #[test]
  fn a_review_that_never_started_keeps_fabricators_findings() {
    let log = log_with(&[("install", "medium")], false, false);
    let report = finalize(&log, &areas_for(Kind::App), (10, 9), Err(COPILOT_SIGN_IN_REQUIRED.to_string()));
    assert!(!report.ok);
    assert_eq!(report.error.as_deref(), Some("GitHub Copilot isn’t signed in. Sign in to Copilot in Fabricator, then check again."));
    assert_eq!((report.verdict.as_str(), report.findings.len()), ("caution", 1));
    assert_eq!(report.areas.iter().find(|a| a.area == "install").unwrap().status, "flagged");
    assert!(report.areas.iter().all(|a| a.area != "agents"));
  }

  #[test]
  fn a_review_that_stopped_part_way_is_partial_and_one_that_reported_nothing_failed() {
    let log = log_with(&[], false, true);
    let report = finalize(&log, &areas_for(Kind::Project), (1, 1), Ok((DrainEnd::TimedOut, None)));
    assert!(report.ok && report.partial);
    assert_eq!(report.error.as_deref(), Some("Copilot didn’t finish in 6 minutes."));

    let silent = log_with(&[], false, false);
    let report = finalize(&silent, &areas_for(Kind::Project), (1, 1), Ok((DrainEnd::Finished, None)));
    assert!(!report.ok);
    assert_eq!(report.error.as_deref(), Some("Copilot ended without reporting what it found."));

    let stopped = finalize(&silent, &areas_for(Kind::Project), (1, 1), Ok((DrainEnd::Cancelled, None)));
    assert!(stopped.cancelled && !stopped.ok && stopped.error.is_none());
  }

  #[test]
  fn a_finished_review_takes_copilots_summary_and_stricter_verdict() {
    let mut log = log_with(&[("packages", "low")], true, true);
    log.summary = Some("An expense tracker that only talks to its own backend.".into());
    log.verdict = Some("caution");
    let report = finalize(&log, &areas_for(Kind::Project), (5, 5), Ok((DrainEnd::Finished, None)));
    assert!(report.ok && !report.partial && report.error.is_none());
    assert_eq!(report.verdict, "caution");
    assert_eq!(report.summary, "An expense tracker that only talks to its own backend.");
  }

  #[test]
  fn what_a_check_unpacks_and_how_npmrc_sign_ins_are_hidden() {
    assert!(worth_reading("src/App.tsx", 2_000));
    assert!(worth_reading("package-lock.json", 3 * 1024 * 1024));
    assert!(worth_reading("packages/api/package.json", 3 * 1024 * 1024), "padding can't hide a manifest");
    assert!(!worth_reading("src/huge.js", 3 * 1024 * 1024));
    assert!(!worth_reading("assets/logo.png", 10));
    assert!(!worth_reading("rayfin/.env", 10));
    assert!(!worth_reading("certs/app.pem", 10));
    assert!(worth_reading(".npmrc", 10));
    assert!(worth_reading(".git/config", 3 * 1024 * 1024) && worth_reading("PACKAGE.JSON", 3 * 1024 * 1024));
    assert_eq!(mask_npmrc_setting("//npm.contoso.com/:_authToken=abc123def456"), "//npm.contoso.com/:_authToken=••••••");
    assert_eq!(mask_npmrc_setting("\"//npm.contoso.com/:_authToken\"=abc123"), "\"//npm.contoso.com/:_authToken\"=••••••");
    assert_eq!(mask_npmrc_setting("registry=https://npm.contoso.com/"), "registry=https://npm.contoso.com/");

    // npm ends a setting at a lone `\r`, so a sign-in after one is hidden too.
    let root = std::env::temp_dir().join(format!("fabricator-npmrc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("app")).unwrap();
    std::fs::write(root.join("app").join(".NPMRC"), "fund=false\r//npm.contoso.com/:_authToken=abc123\r\n").unwrap();
    let file = PackageFile { path: "app/.NPMRC".into(), size: 10, unpacked: true, program: false };
    mask_npmrcs(&root, &[file]);
    let masked = std::fs::read_to_string(root.join("app").join(".NPMRC")).unwrap();
    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(masked, "fund=false\r//npm.contoso.com/:_authToken=••••••\r\n");
  }

  #[test]
  fn excerpt_lines_are_cut_to_a_readable_length() {
    let clipped = clip_lines(&format!("short\n{}", "x".repeat(1000)));
    let lines: Vec<&str> = clipped.lines().collect();
    assert_eq!(lines[0], "short");
    assert_eq!(lines[1].chars().count(), MAX_EXCERPT_LINE);
    assert!(lines[1].ends_with('…'));
  }
}
