//! Advisor: a Copilot-driven, read-only security review of the active Rayfin
//! app. Uses the GitHub Copilot SDK like chat, but on a *transient* session (a
//! throwaway session id, disconnected after the run) so the review never lands
//! in the project's Build chat history. The model is asked to emit a single
//! fenced JSON report which we parse into [`AdvisorReport`].
//!
//! The review covers six checks: data/routes not behind authentication
//! (`category: "auth"`), overly permissive database policies
//! (`category: "policy"`), stale Rayfin CLI/SDK versions (`category: "version"`),
//! data-model best practices (`category: "data-modeling"`), runtime/query
//! performance (`category: "performance"`), and frontend accessibility
//! (`category: "accessibility"`). The `category` field drives grouping in the UI,
//! so new checks can be added later by extending the prompt alone.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use github_copilot_sdk::subscription::RecvErrorKind;
use github_copilot_sdk::MessageOptions;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::services::emit::emit_advisor_event;
use crate::services::fingerprint::fingerprint;
use crate::services::{paths, store};
use crate::state::AppState;
use crate::types::{AdvisorEvent, AdvisorFinding, AdvisorRawReport, AdvisorReport, AdvisorSnapshot};

/// 10 minute ceiling for a single review run.
const RUN_TIMEOUT_MS: u64 = 10 * 60_000;

/// 3 minute ceiling for a single inline "Explain this finding" answer.
const EXPLAIN_TIMEOUT_MS: u64 = 3 * 60_000;

/// The full instruction handed to Copilot. Read-only; ends with a strict JSON
/// contract we can parse out of the assistant's final message.
const ADVISOR_PROMPT: &str = r#"You are a reviewer for a Rayfin app (a Microsoft Fabric app: a TypeScript frontend under `src/` plus a Rayfin backend defined under `rayfin/`). Perform a READ-ONLY review of the app in this directory covering security, data-model quality, performance, and accessibility. DO NOT modify, create, or delete any files, and DO NOT run any deploy or `rayfin up` command.

Review for these categories of issues:

1) category "auth" — data or routes not behind authentication:
   - Rayfin data entities (in `rayfin/data/schema.ts` and any files it imports) that are MISSING an explicit permission decorator. An entity without one silently defaults to `authenticated: *` (full CRUD for ANY signed-in user). Flag each such entity.
   - Entities decorated `@anonymous` (reachable without signing in) — especially when writable or holding non-public data.
   - Frontend pages/routes (in `src/`, e.g. React Router routes or pages reached from `App.tsx` / `src/pages`) that render protected content WITHOUT an auth guard (no check for a signed-in session before rendering).

2) category "policy" — database policies too permissive:
   - Entities granting broad CRUD on user-scoped data WITHOUT a row-level `policy: (claims, item) => claims.sub.eq(item.user_id)` (or equivalent), so any signed-in user can read or modify other users' rows.
   - `@authenticated` or `@role` grants that are broader than the data warrants.
   - Sensitive fields exposed to clients that should be hidden via `exclude: [...]`.

3) category "version" — stale Rayfin CLI or SDK:
   - Look at the project's `package.json` (and `package-lock.json`) for its Rayfin dependencies: the Rayfin CLI plus the SDK/runtime packages — e.g. `@microsoft/rayfin-cli`, `@microsoft/rayfin-sdk`, and any other `@microsoft/rayfin*` package the project depends on.
   - For each, determine the version the project currently uses, then look up the latest published version (run a read-only command such as `npm view <package> version`; you may also use `npx rayfin --version` for the CLI). Do NOT install, update, or modify anything.
   - Flag a finding when the project is meaningfully behind the latest release. Severity: "high" if a MAJOR version behind (risks missing security or breaking fixes), "medium" if a minor version behind, "low" if only patch versions behind. State the current and latest versions in the detail and recommend the upgrade (e.g. `npm install <package>@latest`, or `npm create @microsoft/rayfin@latest` to refresh the project scaffold).
   - If you cannot determine the latest published version (for example there is no network access), do NOT raise anything for this category.

4) category "data-modeling" — Rayfin data-model best practices (read `rayfin/data/schema.ts` and the entity files under `rayfin/data/` it imports):
   - Foreign-key / lookup fields (typically `*_id` columns the app filters or joins on) that have no index, which will slow queries as data grows. Recommend an index.
   - Fields missing sensible constraints or validation (e.g. `@text` with no `min`/`max` where bounded input is expected, or a field left optional/nullable that the app always requires).
   - Sensitive or internal fields returned to clients that should be hidden from reads via `exclude: [...]` (e.g. tokens, internal flags, another user's identifiers).
   - Duplicated/denormalized data across entities that can drift out of sync, where a relation would be safer.
   Severity: "high" for sensitive data exposure; "medium" for missing indexes/constraints that will bite at scale; "low" for minor cleanups.

5) category "performance" — runtime / query performance:
   - List queries that fetch entire tables with no pagination or limit (will degrade as data grows), or obvious N+1 query patterns in the frontend data access.
   - Expensive work on hot render paths in `src/` (e.g. unmemoized heavy computation, fetching in a tight loop) or obviously oversized client bundles.
   Severity: "medium" for issues that scale badly with data/usage; "low" for minor inefficiencies.

6) category "accessibility" — frontend accessibility (review the React UI under `src/`):
   - Interactive elements (custom buttons/menus on `div`/`span`) without an accessible name or role, or with no keyboard handling (not reachable/operable via keyboard).
   - Images/icons conveying meaning without alt text or an aria-label, form inputs without associated labels, or likely color-contrast problems.
   Severity: "medium" for content unreachable by assistive tech or keyboard; "low" for smaller gaps.

Use the `rayfin` MCP tools or `rayfin docs ...` if you need to confirm decorator or policy semantics. Read `rayfin/rayfin.yml`, `rayfin/data/schema.ts`, and the frontend routing under `src/`. Only report real issues you verified by reading the code — do not invent problems.

Severity guidance: "high" = unauthenticated/public access to data, one user able to reach another user's data, or sensitive data exposed to clients; "medium" = overly broad authenticated access, or data-model/performance/accessibility issues that degrade the app as it grows or block assistive-tech users; "low" = minor hardening or cleanup.

Each finding's "category" must be exactly one of "auth", "policy", "version", "data-modeling", "performance", or "accessibility".

When you are done, the FINAL thing in your reply must be a single fenced ```json code block (and nothing after it) exactly matching this schema:

```json
{
  "summary": "<one or two sentence plain-language overview of what you found>",
  "findings": [
    {
      "id": "<short-kebab-slug>",
      "category": "auth",
      "severity": "high",
      "title": "<short title>",
      "detail": "<what is wrong and why it matters, 1-3 sentences>",
      "file": "<project-relative path, or null if not file-specific>",
      "recommendation": "<a concrete fix>"
    }
  ]
}
```

If you find no issues, return an empty "findings" array and a reassuring "summary"."#;

/// Per-run streaming accumulator.
#[derive(Default)]
struct ReviewState {
  /// Full assistant text, reassembled in stream order (for JSON extraction).
  assistant: String,
  /// Characters of each assistant message already appended (dedup with the
  /// terminal `assistant.message` event).
  streamed: HashMap<String, usize>,
  /// Error message if the session reported one (`session.error`).
  errored: Option<String>,
}

/// Derive a short progress label plus the tool name from a tool-start event.
fn progress_label(data: &Value) -> (String, Option<String>) {
  let tool = data.get("toolName").and_then(|v| v.as_str()).unwrap_or("");
  let detail = data
    .get("arguments")
    .and_then(|a| {
      a.get("description")
        .or_else(|| a.get("command"))
        .or_else(|| a.get("path"))
        .or_else(|| a.get("query"))
        .or_else(|| a.get("pattern"))
        .or_else(|| a.get("prompt"))
    })
    .and_then(|v| v.as_str())
    .unwrap_or("");
  let detail = detail.split_whitespace().collect::<Vec<_>>().join(" ");
  let tool_opt = (!tool.is_empty()).then(|| tool.to_string());
  let text = if !detail.is_empty() {
    detail.chars().take(100).collect()
  } else if !tool.is_empty() {
    tool.to_string()
  } else {
    "Working".to_string()
  };
  (text, tool_opt)
}

/// Feed one Copilot **server** event into the review accumulator, surfacing tool
/// activity as progress. Returns `true` once the turn reaches a terminal state
/// (`session.idle` / `session.error`).
fn map_review_event(
  event_type: &str,
  data: &Value,
  st: &mut ReviewState,
  emit_progress: &mut dyn FnMut(String, Option<String>),
) -> bool {
  match event_type {
    "assistant.message_delta" => {
      let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
      let text = data.get("deltaContent").and_then(|v| v.as_str()).unwrap_or("");
      if text.is_empty() {
        return false;
      }
      st.assistant.push_str(text);
      *st.streamed.entry(id).or_insert(0) += text.chars().count();
    }
    "assistant.message" => {
      let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
      let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
      let total = content.chars().count();
      let have = *st.streamed.get(&id).unwrap_or(&0);
      if total > have {
        let rest: String = content.chars().skip(have).collect();
        st.assistant.push_str(&rest);
        st.streamed.insert(id, total);
      }
    }
    "tool.execution_start" => {
      let (text, tool) = progress_label(data);
      emit_progress(text, tool);
    }
    "session.error" => {
      let msg = data
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Copilot reported an error.")
        .to_string();
      st.errored = Some(msg);
      return true;
    }
    "session.idle" => return true,
    _ => {}
  }
  false
}

/// Pull fenced code-block bodies out of `s`, stripping a short leading language
/// tag (e.g. ```json). Blocks are returned in document order.
fn fenced_blocks(s: &str) -> Vec<String> {
  let parts: Vec<&str> = s.split("```").collect();
  let mut out = Vec::new();
  let mut i = 1;
  while i < parts.len() {
    let mut block = parts[i];
    if let Some(nl) = block.find('\n') {
      let first = block[..nl].trim();
      // A bare language tag line has no JSON and is short ("json", "ts", ...).
      if !first.contains('{') && first.len() <= 12 {
        block = &block[nl + 1..];
      }
    }
    out.push(block.to_string());
    i += 2;
  }
  out
}

/// Best-effort extraction of the JSON report from Copilot's final message:
/// prefer the last fenced block that parses, then fall back to the widest
/// `{ ... }` slice.
fn extract_report(text: &str) -> Option<AdvisorRawReport> {
  for block in fenced_blocks(text).into_iter().rev() {
    if let Ok(report) = serde_json::from_str::<AdvisorRawReport>(block.trim()) {
      return Some(report);
    }
  }
  if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) {
    if end > start {
      if let Ok(report) = serde_json::from_str::<AdvisorRawReport>(&text[start..=end]) {
        return Some(report);
      }
    }
  }
  None
}

/// Persist a successful review for later reload.
fn save_snapshot(project_id: &str, snapshot: &AdvisorSnapshot) {
  if let Ok(text) = serde_json::to_string_pretty(snapshot) {
    if let Err(e) = std::fs::write(paths::advisor_file(project_id), text) {
      log::warn!("failed to save advisor snapshot for {project_id}: {e}");
    }
  }
}

/// Load a saved review, recomputing `stale` against the project's current code.
fn load_snapshot(project_id: &str, project_path: &str) -> Option<AdvisorSnapshot> {
  let text = std::fs::read_to_string(paths::advisor_file(project_id)).ok()?;
  let mut snapshot: AdvisorSnapshot = serde_json::from_str(&text).ok()?;
  let current = fingerprint(project_path);
  snapshot.stale = !snapshot.fingerprint.is_empty() && snapshot.fingerprint != current;
  Some(snapshot)
}

/// Return the saved review for a project (with `stale` recomputed), or `None`.
#[tauri::command]
pub async fn advisor_load(project_id: String) -> Result<Option<AdvisorSnapshot>, String> {
  let Some(project) = store::find_project(&project_id) else {
    return Ok(None);
  };
  Ok(load_snapshot(&project_id, &project.path))
}

/// Run a read-only Copilot security review of the project and return a snapshot
/// (report + timing). Always resolves to a snapshot (with `report.ok` reflecting
/// success) except for caller errors (unknown project, or a run already in
/// flight). A successful review is persisted for later reload.
#[tauri::command]
pub async fn advisor_run(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
  model: Option<String>,
) -> Result<AdvisorSnapshot, String> {
  let Some(project) = store::find_project(&project_id) else {
    return Err("Project not found.".into());
  };

  let Some(token) = state.try_begin_advisor(&project_id) else {
    return Err("An analysis is already running for this project.".into());
  };

  let started = Instant::now();

  // A transient, uncached session keeps the review out of the project's chat
  // history; the chosen model is used (or the engine default when None).
  let session = match state.copilot.transient_session(&project.path, model, None).await {
    Ok(s) => s,
    Err(e) => {
      state.end_advisor(&project_id);
      emit_advisor_event(&app, &project_id, AdvisorEvent::Error { text: e.clone() });
      emit_advisor_event(&app, &project_id, AdvisorEvent::Done { ok: false });
      return Ok(AdvisorSnapshot {
        report: AdvisorReport { ok: false, summary: format!("Couldn't start the analysis. {e}"), findings: vec![] },
        analyzed_at: chrono::Utc::now().to_rfc3339(),
        duration_ms: started.elapsed().as_millis() as u64,
        stale: false,
        fingerprint: String::new(),
      });
    }
  };

  enum DrainEnd {
    Finished,
    Cancelled,
    Closed,
  }

  let mut st = ReviewState::default();
  let mut cancelled = false;
  let mut timed_out = false;

  // Subscribe before sending so no events are missed.
  let mut sub = session.subscribe();
  let send_err = session.send(MessageOptions::new(ADVISOR_PROMPT)).await.err().map(|e| e.to_string());

  if send_err.is_none() {
    // Drain until the session goes idle / errors, honouring cancellation and the
    // 10-minute cap.
    let drain = async {
      loop {
        if token.is_cancelled() {
          let _ = session.abort().await;
          return DrainEnd::Cancelled;
        }
        tokio::select! {
          _ = token.wait_cancelled() => {
            let _ = session.abort().await;
            return DrainEnd::Cancelled;
          }
          recv = sub.recv() => match recv {
            Ok(ev) => {
              let mut emit = |text: String, tool: Option<String>| {
                emit_advisor_event(&app, &project_id, AdvisorEvent::Progress { text, tool });
              };
              if map_review_event(&ev.event_type, &ev.data, &mut st, &mut emit) {
                return DrainEnd::Finished;
              }
            }
            Err(err) => match err.kind() {
              RecvErrorKind::Lagged(l) => {
                log::warn!("advisor event stream lagged, skipped {} events", l.skipped());
              }
              RecvErrorKind::Closed => return DrainEnd::Closed,
              other => {
                log::warn!("advisor event stream error: {other:?}");
                return DrainEnd::Closed;
              }
            },
          }
        }
      }
    };
    match tokio::time::timeout(Duration::from_millis(RUN_TIMEOUT_MS), drain).await {
      Ok(DrainEnd::Cancelled) => cancelled = true,
      Ok(DrainEnd::Finished) | Ok(DrainEnd::Closed) => {}
      Err(_) => {
        let _ = session.abort().await;
        timed_out = true;
      }
    }
  }

  // The advisor session is one-shot; disconnect it so it never accumulates.
  let _ = session.disconnect().await;
  state.end_advisor(&project_id);

  // Map the outcome to a report, keeping the UI on a single happy path.
  let report = if cancelled {
    AdvisorReport { ok: false, summary: "Analysis cancelled.".into(), findings: vec![] }
  } else if let Some(e) = send_err {
    AdvisorReport { ok: false, summary: format!("Couldn't complete the analysis. {e}"), findings: vec![] }
  } else if let Some(raw) = extract_report(&st.assistant) {
    AdvisorReport { ok: true, summary: raw.summary, findings: raw.findings }
  } else {
    let detail = if let Some(e) = &st.errored {
      e.clone()
    } else if timed_out {
      "the analysis timed out after 10 minutes".to_string()
    } else if !st.assistant.trim().is_empty() {
      st.assistant.trim().chars().take(600).collect()
    } else {
      "Copilot ended without a report.".to_string()
    };
    AdvisorReport {
      ok: false,
      summary: format!("Couldn't complete the analysis. {detail}"),
      findings: vec![],
    }
  };

  if !report.ok {
    emit_advisor_event(&app, &project_id, AdvisorEvent::Error { text: report.summary.clone() });
  }
  emit_advisor_event(&app, &project_id, AdvisorEvent::Done { ok: report.ok });

  let mut snapshot = AdvisorSnapshot {
    report,
    analyzed_at: chrono::Utc::now().to_rfc3339(),
    duration_ms: started.elapsed().as_millis() as u64,
    stale: false,
    fingerprint: String::new(),
  };
  // Only persist a clean, successful review so a failed/cancelled run never
  // clobbers a good saved one.
  if snapshot.report.ok {
    snapshot.fingerprint = fingerprint(&project.path);
    save_snapshot(&project_id, &snapshot);
  }
  Ok(snapshot)
}

/// Cancel the in-flight review for a project, if any.
#[tauri::command]
pub fn advisor_cancel(state: State<'_, AppState>, project_id: String) -> bool {
  state.cancel_advisor(&project_id)
}

/// Build the read-only "explain this finding" instruction. The answer is prose /
/// Markdown (no JSON contract) rendered inline in the Advisor card.
fn explain_prompt(finding: &AdvisorFinding) -> String {
  let location = match finding.file.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
    Some(f) => f.to_string(),
    None => "(not specific to one file)".to_string(),
  };
  format!(
    r#"You are helping the owner of a Rayfin app (a Microsoft Fabric app: a TypeScript/React frontend under `src/` plus a Rayfin backend under `rayfin/`). The Advisor's read-only review flagged the issue below. Explain it in depth: what the underlying problem is, why it matters for THIS specific app (read the relevant code to ground your explanation), and how you would fix it.

This is a READ-ONLY explanation. DO NOT modify, create, or delete any files, and DO NOT run any deploy or `rayfin up` command.

Issue: {title}
Severity: {severity}
Category: {category}
Location: {location}

Details: {detail}
Suggested fix: {recommendation}

Write a clear, friendly explanation in Markdown for a non-expert app owner: a few short paragraphs, using a short bullet list or a small fenced code snippet only where it genuinely helps. Be concrete to this codebase. Do NOT restate this prompt and do NOT output any JSON — reply with only the explanation."#,
    title = finding.title,
    severity = finding.severity,
    category = finding.category,
    location = location,
    detail = finding.detail,
    recommendation = finding.recommendation,
  )
}

/// Feed one Copilot **server** event into the explain accumulator, streaming
/// assistant text out as `ExplainDelta` events as it arrives. Returns `true` once
/// the turn reaches a terminal state (`session.idle` / `session.error`).
fn map_explain_event(
  event_type: &str,
  data: &Value,
  st: &mut ReviewState,
  emit_delta: &mut dyn FnMut(String),
) -> bool {
  match event_type {
    "assistant.message_delta" => {
      let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
      let text = data.get("deltaContent").and_then(|v| v.as_str()).unwrap_or("");
      if text.is_empty() {
        return false;
      }
      st.assistant.push_str(text);
      *st.streamed.entry(id).or_insert(0) += text.chars().count();
      emit_delta(text.to_string());
    }
    "assistant.message" => {
      let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
      let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
      let total = content.chars().count();
      let have = *st.streamed.get(&id).unwrap_or(&0);
      if total > have {
        let rest: String = content.chars().skip(have).collect();
        st.assistant.push_str(&rest);
        st.streamed.insert(id, total);
        emit_delta(rest);
      }
    }
    "session.error" => {
      let msg = data
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Copilot reported an error.")
        .to_string();
      st.errored = Some(msg);
      return true;
    }
    "session.idle" => return true,
    _ => {}
  }
  false
}

/// Explain a single Advisor finding inline. Runs a *transient*, read-only Copilot
/// session (so the answer never lands in the project's Build chat history),
/// streaming the Markdown answer to the renderer as `explainDelta` events routed
/// by `explain_id`, and resolving with the full text. Emits a terminal
/// `explainDone` event in every outcome.
#[tauri::command]
pub async fn advisor_explain(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
  explain_id: String,
  finding: AdvisorFinding,
  model: Option<String>,
) -> Result<String, String> {
  let Some(project) = store::find_project(&project_id) else {
    return Err("Project not found.".into());
  };

  let Some(token) = state.try_begin_explain(&project_id) else {
    return Err("An explanation is already being generated for this project.".into());
  };

  // Helper to emit a terminal marker and release the guard on every early exit.
  let finish_err = |detail: String| {
    emit_advisor_event(
      &app,
      &project_id,
      AdvisorEvent::ExplainDone { explain_id: explain_id.clone(), ok: false, error: Some(detail.clone()) },
    );
  };

  let session = match state.copilot.transient_session(&project.path, model, None).await {
    Ok(s) => s,
    Err(e) => {
      state.end_explain(&project_id, &token);
      finish_err(format!("Couldn't start the explanation. {e}"));
      return Err(e);
    }
  };

  enum DrainEnd {
    Finished,
    Cancelled,
    Closed,
  }

  let mut st = ReviewState::default();
  let mut cancelled = false;
  let mut timed_out = false;

  // Subscribe before sending so no events are missed.
  let mut sub = session.subscribe();
  let send_err = session
    .send(MessageOptions::new(explain_prompt(&finding)))
    .await
    .err()
    .map(|e| e.to_string());

  if send_err.is_none() {
    let drain = async {
      loop {
        if token.is_cancelled() {
          let _ = session.abort().await;
          return DrainEnd::Cancelled;
        }
        tokio::select! {
          _ = token.wait_cancelled() => {
            let _ = session.abort().await;
            return DrainEnd::Cancelled;
          }
          recv = sub.recv() => match recv {
            Ok(ev) => {
              let mut emit = |text: String| {
                emit_advisor_event(
                  &app,
                  &project_id,
                  AdvisorEvent::ExplainDelta { explain_id: explain_id.clone(), text },
                );
              };
              if map_explain_event(&ev.event_type, &ev.data, &mut st, &mut emit) {
                return DrainEnd::Finished;
              }
            }
            Err(err) => match err.kind() {
              RecvErrorKind::Lagged(l) => {
                log::warn!("advisor explain stream lagged, skipped {} events", l.skipped());
              }
              RecvErrorKind::Closed => return DrainEnd::Closed,
              other => {
                log::warn!("advisor explain stream error: {other:?}");
                return DrainEnd::Closed;
              }
            },
          }
        }
      }
    };
    match tokio::time::timeout(Duration::from_millis(EXPLAIN_TIMEOUT_MS), drain).await {
      Ok(DrainEnd::Cancelled) => cancelled = true,
      Ok(DrainEnd::Finished) | Ok(DrainEnd::Closed) => {}
      Err(_) => {
        let _ = session.abort().await;
        timed_out = true;
      }
    }
  }

  // The explain session is one-shot; disconnect it so it never accumulates.
  let _ = session.disconnect().await;
  state.end_explain(&project_id, &token);

  if cancelled {
    finish_err("Explanation cancelled.".into());
    return Err("Explanation cancelled.".into());
  }
  if let Some(e) = send_err {
    finish_err(format!("Couldn't complete the explanation. {e}"));
    return Err(e);
  }

  let answer = st.assistant.trim().to_string();
  if answer.is_empty() {
    let detail = if let Some(e) = &st.errored {
      e.clone()
    } else if timed_out {
      "the explanation timed out".to_string()
    } else {
      "Copilot ended without an explanation.".to_string()
    };
    finish_err(format!("Couldn't complete the explanation. {detail}"));
    return Err(detail);
  }

  emit_advisor_event(
    &app,
    &project_id,
    AdvisorEvent::ExplainDone { explain_id, ok: true, error: None },
  );
  Ok(answer)
}

/// Cancel the in-flight inline explanation for a project, if any.
#[tauri::command]
pub fn advisor_explain_cancel(state: State<'_, AppState>, project_id: String) -> bool {
  state.cancel_explain(&project_id)
}
