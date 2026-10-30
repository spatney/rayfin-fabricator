//! The open app's local backend as Help sees it: its status, described for the
//! prompt, and its recent output, for the `help_local_output` tool.
//!
//! All of it comes from rayfin-local or from the app itself, so it is treated
//! as untrusted text: clipped, and with credentials masked
//! ([`redact_secrets`]) before the model sees it. The supervisor already masks
//! the control token as it reads each line; the masking here would catch it
//! again if it ever slipped through.

use serde_json::Value;
use tauri::AppHandle;

use crate::services::diagnostics::{self, redact_secrets};
use crate::services::{local_backend, paths};
use crate::types::{LocalBackendState as State, LocalLogEvent, LocalProblem, LocalStatus};

/// Longest piece of rayfin-local's text quoted in the prompt.
const MAX_TEXT: usize = 600;
/// Most items of a list (errors, losses, warnings, names) quoted in the prompt.
const MAX_ITEMS: usize = 12;

/// How many of the newest output lines the tool returns unless asked otherwise.
pub const DEFAULT_OUTPUT_LINES: usize = 120;
/// Most output lines one call returns.
pub const MAX_OUTPUT_LINES: usize = 400;
/// How far back a filtered read looks: everything the supervisor keeps.
pub const FILTER_WINDOW: usize = 2000;
/// Longest output line returned; longer ones are cut.
const MAX_OUTPUT_LINE: usize = 500;
/// Most text one call returns. The newest lines win.
const MAX_OUTPUT_CHARS: usize = 24_000;

fn clip(text: &str, max: usize) -> String {
  let text = text.trim();
  match text.char_indices().nth(max) {
    Some((cut, _)) => format!("{}…", &text[..cut]),
    None => text.to_string(),
  }
}

/// Text from rayfin-local, safe to put in front of the model.
fn quote(text: &str) -> String {
  clip(&redact_secrets(text), MAX_TEXT)
}

/// The first [`MAX_ITEMS`] of `items`, quoted and joined, with a count of the rest.
fn list(items: &[String], separator: &str) -> String {
  let mut out = items.iter().take(MAX_ITEMS).map(|i| quote(i)).collect::<Vec<_>>().join(separator);
  if items.len() > MAX_ITEMS {
    out.push_str(&format!("{separator}and {} more", items.len() - MAX_ITEMS));
  }
  out
}

/// `code`: message, hint and details of one problem.
fn problem(p: &LocalProblem) -> String {
  let mut out = format!("`{}`", p.code);
  if p.fatal {
    out.push_str(" (stopped the backend)");
  }
  out.push_str(&format!(": {}", quote(&p.message)));
  if let Some(hint) = p.hint.as_deref().filter(|h| !h.trim().is_empty()) {
    out.push_str(&format!(" Hint: {}", quote(hint)));
  }
  if let Some(details) = p.details.as_ref().filter(|d| !d.is_null()) {
    out.push_str(&format!(" Details: {}", clip(&redact_secrets(&details.to_string()), MAX_TEXT * 2)));
  }
  if let Some(time) = p.time.as_deref().filter(|t| !t.is_empty()) {
    out.push_str(&format!(" ({time})"));
  }
  out
}

/// Who the app signs in as, in words.
fn sign_in(status: &LocalStatus) -> Option<String> {
  let flag = status.sign_in_as.clone().or_else(|| {
    let kind = status.ready.as_ref()?.sign_in_as.as_ref()?.get("kind")?.as_str()?.to_string();
    Some(kind)
  })?;
  Some(match flag.as_str() {
    "developer" => "the developer: the user's own account when Fabricator can get it without a prompt, else a local developer account".into(),
    "none" => "nobody: automatic sign-in is off, so the app starts signed out".into(),
    other => match other.strip_prefix("user:") {
      Some(user) => format!("the local test user {}", quote(user)),
      None => quote(other),
    },
  })
}

/// Why the local backend can't run all of this app, if it can't: an SDK
/// outside its supported range, and connectors that run only on Fabric.
fn limits(status: &LocalStatus) -> Vec<String> {
  let mut out = Vec::new();
  let sdk = status
    .ready
    .as_ref()
    .and_then(|r| r.sdk.clone())
    .or_else(|| status.analysis.as_ref().and_then(|a| a.sdk.clone()));
  let warning = status.warnings.iter().find(|w| w.code == "sdk-unsupported");
  let detail = |key: &str| warning.and_then(|w| w.details.as_ref()).and_then(|d| d.get(key)).and_then(Value::as_str);
  if sdk.as_ref().is_some_and(|s| s.version.is_some() && !s.supported) || warning.is_some() {
    let version = sdk.as_ref().and_then(|s| s.version.clone()).or_else(|| detail("version").map(str::to_string));
    let version = version.map(|v| format!(" ({})", quote(&v))).unwrap_or_default();
    let range = detail("supported").map(|r| format!(" ({})", quote(r))).unwrap_or_default();
    out.push(format!("its Rayfin packages{version} are outside the versions the local backend supports{range}"));
  }
  let mut connectors: Vec<String> = status
    .ready
    .as_ref()
    .map(|r| r.features.connectors.iter().filter(|c| !c.supported).map(|c| format!("{} ({})", c.name, c.kind)).collect())
    .unwrap_or_default();
  for w in status.warnings.iter().filter(|w| w.code == "connector-unsupported") {
    let field = |key: &str| w.details.as_ref().and_then(|d| d.get(key)).and_then(Value::as_str).unwrap_or("?").to_string();
    let named = format!("{} ({})", field("name"), field("type"));
    if !connectors.contains(&named) {
      connectors.push(named);
    }
  }
  if !connectors.is_empty() {
    out.push(format!("it uses connectors that run only on Microsoft Fabric: {}", list(&connectors, ", ")));
  }
  out
}

/// The `<local-backend>` block: the open personal app's local backend right now.
pub fn describe(status: &LocalStatus, published: bool) -> String {
  let mut s = String::from(
    "The open app's local backend at this moment, from Fabricator's own records. This is the \
present: it outranks anything older in the journal. Read its output with `help_local_output`.\n\n",
  );
  let mut line = |text: String| {
    s.push_str("- ");
    s.push_str(&text);
    s.push('\n');
  };

  let since = |at: &Option<String>| at.as_deref().map(|t| format!(", since {t}")).unwrap_or_default();
  line(match status.state {
    State::Running => format!("State: running{}.", since(&status.started_at)),
    State::Starting => format!(
      "State: starting{}{}.",
      status.phase.as_deref().map(|p| format!(" (step: {p})")).unwrap_or_default(),
      since(&status.started_at)
    ),
    State::Restarting => "State: restarting.".into(),
    State::Error => "State: stopped by a problem, so the app isn't running on this computer.".into(),
    State::Stopped if status.revision == 0 => {
      "State: not started since Fabricator opened. Fabricator starts it when the app is open in the workbench.".into()
    }
    State::Stopped => "State: stopped.".into(),
  });
  if let Some(version) = &status.version {
    line(format!("rayfin-local (the local backend) version: {}.", quote(version)));
  }

  if let Some(ready) = &status.ready {
    let mut urls = Vec::new();
    if let Some(app) = &ready.app_url {
      urls.push(format!("the app {app} (what the preview shows)"));
    }
    if !ready.api_url.is_empty() {
      urls.push(format!("its backend {}", ready.api_url));
    }
    if let Some(portal) = &ready.portal_url {
      urls.push(format!("the local sign-in page {portal}"));
    }
    if !urls.is_empty() {
      line(format!("Addresses: {}.", urls.join("; ")));
    }
    let f = &ready.features;
    let mut parts = Vec::new();
    if f.data.enabled {
      parts.push(format!("data ({})", if f.data.entities.is_empty() { "no entities".into() } else { list(&f.data.entities, ", ") }));
    }
    if f.functions.enabled {
      parts.push(format!("functions ({})", if f.functions.names.is_empty() { "none".into() } else { list(&f.functions.names, ", ") }));
    }
    if f.storage.enabled {
      parts.push("file storage".into());
    }
    if f.auth.enabled {
      parts.push("sign-in".into());
    }
    if !f.connectors.is_empty() {
      let connectors: Vec<String> = f
        .connectors
        .iter()
        .map(|c| format!("{} ({}{})", c.name, c.kind, if c.supported { "" } else { ", runs only on Fabric" }))
        .collect();
      parts.push(format!("connectors: {}", list(&connectors, ", ")));
    }
    if !parts.is_empty() {
      line(format!("What it serves: {}.", parts.join("; ")));
    }
  }
  if let Some(who) = sign_in(status) {
    line(format!("The app signs in as {who}."));
  }

  let sdk = status.ready.as_ref().and_then(|r| r.sdk.clone()).or_else(|| status.analysis.as_ref().and_then(|a| a.sdk.clone()));
  if let Some(sdk) = sdk {
    line(match (&sdk.version, sdk.supported) {
      (Some(v), true) => format!("Rayfin packages: {}, which the local backend supports.", quote(v)),
      (Some(v), false) => format!("Rayfin packages: {}, which the local backend does not support.", quote(v)),
      (None, _) => "Rayfin packages: not installed.".into(),
    });
  }

  if let Some(a) = status.analysis.as_ref().filter(|a| !a.ok) {
    let message = a.message.as_deref().map(quote).unwrap_or_else(|| "no message".into());
    line(format!("Data model: couldn't be read: {message}"));
  }
  if let Some(schema) = &status.schema {
    let when = schema.time.as_deref().map(|t| format!(" ({t})")).unwrap_or_default();
    let live = if schema.live { " while running" } else { " at start" };
    line(match schema.result.as_str() {
      "refused" => format!(
        "Last data model change: refused{live}, because it would delete local data: {}. Nothing is lost until the user decides; {}{when}",
        list(&schema.losses, "; "),
        if schema.live { "the previous data model stays in use." } else { "the backend didn't start." }
      ),
      "failed" => format!(
        "Last data model change: failed{live}: {}{when}",
        schema.message.as_deref().map(quote).unwrap_or_else(|| "no message".into())
      ),
      "applied" if !schema.losses.is_empty() => format!(
        "Last data model change: applied{live}, dropping local data: {}{when}",
        list(&schema.losses, "; ")
      ),
      "applied" => format!("Last data model change: applied{live} ({}){when}.", list(&schema.changes, ", ")),
      _ => "Local database: up to date with the data model.".into(),
    });
  }
  if let Some(f) = &status.functions {
    line(match f.state.as_str() {
      "failed" => format!(
        "Functions: the build failed, so calling them fails until a build succeeds. Errors: {}",
        if f.errors.is_empty() { "none listed".into() } else { list(&f.errors, " | ") }
      ),
      "building" => "Functions: building.".into(),
      "off" => format!("Functions: off ({}).", f.message.as_deref().map(quote).unwrap_or_default()),
      _ => "Functions: built and ready.".into(),
    });
  }
  if let Some(v) = &status.vite {
    let message = v.message.as_deref().map(|m| format!(": {}", quote(m))).unwrap_or_default();
    line(match v.state.as_str() {
      "ready" => format!("The app's dev server (Vite): running{}.", v.url.as_deref().map(|u| format!(" at {u}")).unwrap_or_default()),
      "restarting" => format!("The app's dev server (Vite): stopped and starting again{message}"),
      "exited" => format!("The app's dev server (Vite): stopped{message}"),
      _ => format!("The app's dev server (Vite): couldn't start{message}"),
    });
  }
  if let Some(config) = status.config.as_ref().filter(|c| c.restart_required) {
    line(format!(
      "A configuration change needs a restart{}.",
      config.message.as_deref().map(|m| format!(": {}", quote(m))).unwrap_or_default()
    ));
  }

  if !status.warnings.is_empty() {
    let warnings: Vec<String> = status.warnings.iter().rev().take(MAX_ITEMS).rev().map(problem).collect();
    line(format!("Warnings of this run, oldest first:\n  - {}", warnings.join("\n  - ")));
  }
  if let Some(error) = &status.error {
    line(format!("Last problem: {}", problem(error)));
  }
  if let Some(stopped) = status.stopped.as_ref().filter(|_| matches!(status.state, State::Stopped | State::Error)) {
    let code = stopped.exit_code.map(|c| format!(", exit code {c}")).unwrap_or_default();
    line(format!("How the last run ended: {}{code}.", stopped.reason));
  }
  if status.crashes > 0 {
    line(format!("Unexpected stops in the last two minutes: {}.", status.crashes));
  }

  let limits = limits(status);
  if !limits.is_empty() {
    let fallback = if published {
      "The app has been published, so the preview can use the published app's backend instead (the fallback)."
    } else {
      "The app has never been published, so there is no published backend to fall back to: what needs Fabric fails on this computer until the user publishes it."
    };
    line(format!("The local backend can't run all of this app: {}. {fallback}", limits.join("; and ")));
  } else if published {
    line("The app has also been published to Microsoft Fabric; the preview's Published view shows that copy, with its own data.".into());
  }
  s
}

/* ----------------------------- output ----------------------------- */

/// The project's last `n` lines of local backend output, oldest first: what
/// the supervisor holds, else its log file (say, after Fabricator restarted).
pub fn read_output(app: &AppHandle, project_id: &str, n: usize) -> Vec<LocalLogEvent> {
  let lines = local_backend::recent_logs(app, project_id, n);
  if !lines.is_empty() {
    return lines;
  }
  diagnostics::local_log_lines(&paths::logs_dir(), project_id, n)
    .iter()
    .map(|line| parse_log_line(project_id, line))
    .collect()
}

/// One line of a local backend log file: `<time> <source> <level> <text>`.
fn parse_log_line(project_id: &str, line: &str) -> LocalLogEvent {
  let parts: Vec<&str> = line.splitn(4, ' ').collect();
  match parts.as_slice() {
    [time, source, level, text] if time.contains('T') => LocalLogEvent {
      project_id: project_id.to_string(),
      seq: 0,
      source: source.to_string(),
      level: level.to_string(),
      line: text.to_string(),
      time: time.to_string(),
    },
    _ => LocalLogEvent {
      project_id: project_id.to_string(),
      level: "info".into(),
      line: line.to_string(),
      ..Default::default()
    },
  }
}

/// What the model asked to read.
#[derive(Clone, Debug, Default)]
pub struct OutputQuery {
  pub lines: usize,
  /// Only this source's lines (`vite`, `functions`, `build`, `rayfin-local`, …).
  pub source: Option<String>,
  /// Only warnings and errors.
  pub problems_only: bool,
}

impl OutputQuery {
  /// How many lines to fetch to answer it: a filter needs everything there is.
  pub fn fetch(&self) -> usize {
    if self.source.is_some() || self.problems_only {
      FILTER_WINDOW
    } else {
      self.lines.clamp(1, MAX_OUTPUT_LINES)
    }
  }
}

/// The tool's answer: the newest lines that match `query`, oldest first,
/// redacted and cut to size.
pub fn format_output(events: &[LocalLogEvent], query: &OutputQuery) -> String {
  if events.is_empty() {
    return "The local backend hasn't printed anything for this app since Fabricator started, and \
there's no log of an earlier run."
      .to_string();
  }
  let wanted = |e: &&LocalLogEvent| {
    query.source.as_deref().is_none_or(|s| e.source.eq_ignore_ascii_case(s))
      && (!query.problems_only || matches!(e.level.as_str(), "warn" | "error"))
  };
  let picked: Vec<&LocalLogEvent> = events.iter().filter(wanted).collect();
  let filter = match (&query.source, query.problems_only) {
    (Some(source), true) => format!(" (only warnings and errors from {source})"),
    (Some(source), false) => format!(" (only from {source})"),
    (None, true) => " (only warnings and errors)".to_string(),
    (None, false) => String::new(),
  };
  if picked.is_empty() {
    return format!("None of the last {} lines of output match{filter}.", events.len());
  }

  let start = picked.len().saturating_sub(query.lines.clamp(1, MAX_OUTPUT_LINES));
  let mut lines: Vec<String> = picked[start..]
    .iter()
    .map(|e| {
      let text = clip(&redact_secrets(&e.line), MAX_OUTPUT_LINE);
      match (e.time.is_empty(), e.source.is_empty()) {
        (true, true) => text,
        _ => format!("{} {} {}: {text}", e.time, e.source, e.level),
      }
    })
    .collect();
  // Keep the newest lines that fit.
  let mut size = 0;
  let mut keep = 0;
  for line in lines.iter().rev() {
    size += line.len() + 1;
    if size > MAX_OUTPUT_CHARS {
      break;
    }
    keep += 1;
  }
  let dropped = lines.len() - keep;
  lines.drain(..dropped);

  let mut out = format!(
    "The local backend's output{filter}, oldest first: {} line{}. Times are UTC; tokens and keys are masked.\n",
    lines.len(),
    if lines.len() == 1 { "" } else { "s" }
  );
  if dropped > 0 {
    out.push_str(&format!("({dropped} earlier lines left out to keep this short.)\n"));
  }
  out.push_str(&lines.join("\n"));
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::{LocalConnector, LocalFunctions, LocalReady, LocalSchema, LocalSdk, LocalVite};

  fn running() -> LocalStatus {
    LocalStatus {
      project_id: "p".into(),
      state: State::Running,
      revision: 9,
      version: Some("0.2.0".into()),
      sign_in_as: Some("developer".into()),
      started_at: Some("2026-10-30T03:12:09Z".into()),
      ready: Some(LocalReady {
        app_url: Some("http://localhost:5173/".into()),
        api_url: "http://localhost:7171".into(),
        portal_url: Some("http://localhost:7171/.rayfin-local/portal".into()),
        sdk: Some(LocalSdk { version: Some("1.36.2".into()), supported: true }),
        ..Default::default()
      }),
      ..Default::default()
    }
  }

  fn line(source: &str, level: &str, text: &str) -> LocalLogEvent {
    LocalLogEvent {
      project_id: "p".into(),
      seq: 0,
      source: source.into(),
      level: level.into(),
      line: text.into(),
      time: "2026-10-30T03:12:09Z".into(),
    }
  }

  #[test]
  fn a_running_backend_says_where_the_app_is_and_what_it_runs() {
    let text = describe(&running(), false);
    assert!(text.contains("State: running, since 2026-10-30T03:12:09Z."));
    assert!(text.contains("http://localhost:5173/ (what the preview shows)"));
    assert!(text.contains("1.36.2, which the local backend supports"));
    assert!(text.contains("the user's own account"));
    assert!(!text.contains("fall back"), "nothing stops it from running the whole app");
  }

  #[test]
  fn what_only_fabric_runs_explains_the_fallback() {
    let mut status = running();
    let ready = status.ready.as_mut().unwrap();
    ready.sdk = Some(LocalSdk { version: Some("1.38.0".into()), supported: false });
    ready.features.connectors = vec![
      LocalConnector { name: "sales".into(), kind: "fabric-semanticmodel".into(), supported: true },
      LocalConnector { name: "logs".into(), kind: "kusto".into(), supported: false },
    ];
    let published = describe(&status, true);
    assert!(published.contains("1.38.0, which the local backend does not support"));
    assert!(
      published.contains("connectors that run only on Microsoft Fabric: logs (kusto). The app has been published"),
      "only the connector Fabric alone runs is a limit: {published}"
    );
    assert!(published.contains("the preview can use the published app's backend instead"));
    let never = describe(&status, false);
    assert!(never.contains("never been published, so there is no published backend to fall back to"));
  }

  #[test]
  fn a_refused_schema_names_the_data_it_would_lose() {
    let mut status = running();
    status.state = State::Error;
    status.ready = None;
    status.schema = Some(LocalSchema {
      result: "refused".into(),
      losses: vec!["Note.title (12 values)".into()],
      ..Default::default()
    });
    status.error = Some(LocalProblem {
      code: "schema-refused".into(),
      message: "The change would delete data.".into(),
      hint: Some("Restart with --force-schema.".into()),
      fatal: true,
      details: Some(serde_json::json!({ "losses": ["Note.title (12 values)"] })),
      ..Default::default()
    });
    let text = describe(&status, false);
    assert!(text.contains("stopped by a problem"));
    assert!(text.contains("refused at start, because it would delete local data: Note.title (12 values)"));
    assert!(text.contains("Last problem: `schema-refused` (stopped the backend): The change would delete data."));
    assert!(text.contains("\"losses\""));
  }

  #[test]
  fn build_errors_vite_and_warnings_are_all_listed() {
    let mut status = running();
    status.functions = Some(LocalFunctions {
      state: "failed".into(),
      errors: vec!["src/getBacklog.ts(3,1): error TS2304".into()],
      ..Default::default()
    });
    status.vite = Some(LocalVite { state: "failed".into(), message: Some("vite.config.ts: Unexpected token".into()), ..Default::default() });
    status.warnings = vec![LocalProblem {
      code: "azure-sign-in".into(),
      message: "No Azure token could be had.".into(),
      ..Default::default()
    }];
    let text = describe(&status, false);
    assert!(text.contains("the build failed") && text.contains("error TS2304"));
    assert!(text.contains("couldn't start: vite.config.ts: Unexpected token"));
    assert!(text.contains("`azure-sign-in`: No Azure token could be had."));
  }

  #[test]
  fn a_backend_that_never_ran_says_so() {
    let status = LocalStatus { project_id: "p".into(), ..Default::default() };
    assert!(describe(&status, false).contains("not started since Fabricator opened"));
  }

  #[test]
  fn the_description_never_carries_credentials() {
    let mut status = running();
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    status.error = Some(LocalProblem {
      code: "internal".into(),
      message: format!("request with token={token} and key pk-local-abcdefghijklmnopqrstuvwx failed"),
      ..Default::default()
    });
    let text = describe(&status, false);
    assert!(!text.contains(&token) && !text.contains("abcdefghijklmnopqrstuvwx"), "{text}");
  }

  #[test]
  fn output_is_the_newest_lines_oldest_first() {
    let events: Vec<LocalLogEvent> = (0..10).map(|i| line("vite", "info", &format!("line {i}"))).collect();
    let text = format_output(&events, &OutputQuery { lines: 3, ..Default::default() });
    assert!(text.contains("3 lines"));
    let body: Vec<&str> = text.lines().skip(1).collect();
    assert_eq!(body.len(), 3);
    assert!(body[0].ends_with("line 7") && body[2].ends_with("line 9"));
    assert!(body[0].starts_with("2026-10-30T03:12:09Z vite info: "));
  }

  #[test]
  fn output_can_be_narrowed_to_one_source_or_to_problems() {
    let events = vec![
      line("vite", "info", "ready"),
      line("functions", "error", "TS2304"),
      line("vite", "error", "Unexpected token"),
      line("rayfin-local", "warn", "No Azure token"),
    ];
    let vite = format_output(&events, &OutputQuery { lines: 50, source: Some("vite".into()), problems_only: false });
    assert!(vite.contains("ready") && vite.contains("Unexpected token") && !vite.contains("TS2304"));
    let problems = format_output(&events, &OutputQuery { lines: 50, source: None, problems_only: true });
    assert!(problems.contains("TS2304") && problems.contains("No Azure token") && !problems.contains(": ready"));
    let none = format_output(&events, &OutputQuery { lines: 50, source: Some("build".into()), problems_only: false });
    assert!(none.starts_with("None of the last 4 lines"));
    assert!(format_output(&[], &OutputQuery::default()).contains("hasn't printed anything"));
  }

  #[test]
  fn output_never_carries_tokens_and_stays_short() {
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let scheme = "Bearer";
    let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJlLXZhbHVl";
    let mut events = vec![
      line("stderr", "warn", &format!("RAYFIN_LOCAL_CONTROL_TOKEN={token}")),
      line("vite", "info", &format!("Authorization: {scheme} {jwt}")),
      line("vite", "info", "key pk-local-abcdefghijklmnopqrstuvwx"),
    ];
    let text = format_output(&events, &OutputQuery { lines: 50, ..Default::default() });
    for secret in [token.as_str(), jwt, "abcdefghijklmnopqrstuvwx"] {
      assert!(!text.contains(secret), "{secret} leaked: {text}");
    }

    events = (0..MAX_OUTPUT_LINES).map(|i| line("vite", "info", &format!("{i} {}", "x".repeat(2000)))).collect();
    let text = format_output(&events, &OutputQuery { lines: MAX_OUTPUT_LINES, ..Default::default() });
    assert!(text.len() < MAX_OUTPUT_CHARS + 1000, "{}", text.len());
    assert!(text.contains("earlier lines left out"));
    assert!(text.contains(&format!("{} x", MAX_OUTPUT_LINES - 1)), "the newest line is kept");
  }

  #[test]
  fn filtered_reads_look_through_everything_kept() {
    assert_eq!(OutputQuery { lines: 20, ..Default::default() }.fetch(), 20);
    assert_eq!(OutputQuery { lines: 5000, ..Default::default() }.fetch(), MAX_OUTPUT_LINES);
    assert_eq!(OutputQuery { lines: 20, problems_only: true, ..Default::default() }.fetch(), FILTER_WINDOW);
  }

  #[test]
  fn log_file_lines_are_read_back_into_their_parts() {
    let event = parse_log_line("p", "2026-10-30T03:12:09.512Z vite warn page reload src/App.tsx");
    assert_eq!((event.source.as_str(), event.level.as_str()), ("vite", "warn"));
    assert_eq!(event.line, "page reload src/App.tsx");
    let odd = parse_log_line("p", "not a log line");
    assert_eq!((odd.line.as_str(), odd.source.as_str()), ("not a log line", ""));
  }
}
