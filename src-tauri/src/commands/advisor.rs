//! Advisor: a Copilot-driven, read-only security review of the active Rayfin
//! app. Drives the same Copilot CLI path as chat (`copilot -p <prompt>
//! --output-format json -C <cwd> ...`) but with an *ephemeral* session id so the
//! review never lands in the project's Build chat history. The model is asked to
//! emit a single fenced JSON report which we parse into [`AdvisorReport`].
//!
//! The review currently covers three checks: data/routes not behind
//! authentication (`category: "auth"`), overly permissive database policies
//! (`category: "policy"`), and stale Rayfin CLI/SDK versions
//! (`category: "version"`). The `category` field drives grouping in the UI, so new
//! checks can be added later by extending the prompt alone.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::services::emit::emit_advisor_event;
use crate::services::exec::{run, OnData, RunOptions, Stream};
use crate::services::{paths, store};
use crate::state::AppState;
use crate::types::{AdvisorEvent, AdvisorRawReport, AdvisorReport, AdvisorSnapshot};

/// 10 minute ceiling for a single review run.
const RUN_TIMEOUT_MS: u64 = 10 * 60_000;

/// The full instruction handed to Copilot. Read-only; ends with a strict JSON
/// contract we can parse out of the assistant's final message.
const ADVISOR_PROMPT: &str = r#"You are a security reviewer for a Rayfin app (a Microsoft Fabric app: a TypeScript frontend under `src/` plus a Rayfin backend defined under `rayfin/`). Perform a READ-ONLY review of the app in this directory. DO NOT modify, create, or delete any files, and DO NOT run any deploy or `rayfin up` command.

Review for these three categories of issues:

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

Use the `rayfin` MCP tools or `rayfin docs ...` if you need to confirm decorator or policy semantics. Read `rayfin/rayfin.yml`, `rayfin/data/schema.ts`, and the frontend routing under `src/`. Only report real issues you verified by reading the code — do not invent problems.

Severity guidance: "high" = unauthenticated/public access to data, or one user able to reach another user's data; "medium" = overly broad authenticated access; "low" = minor hardening.

Each finding's "category" must be exactly one of "auth", "policy", or "version".

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
  /// Partial line carried across stdout chunks.
  buffer: String,
  /// Full assistant text, reassembled in stream order (for JSON extraction).
  assistant: String,
  /// Characters of each assistant message already appended (dedup with the
  /// terminal `assistant.message` event).
  streamed: HashMap<String, usize>,
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

/// Parse one JSONL line: accumulate assistant text and surface tool activity as
/// progress events.
fn handle_line(
  line: &str,
  st: &mut ReviewState,
  emit_progress: &mut dyn FnMut(String, Option<String>),
) {
  let trimmed = line.trim();
  if trimmed.is_empty() {
    return;
  }
  let Ok(raw) = serde_json::from_str::<Value>(trimmed) else {
    return;
  };
  let Some(kind) = raw.get("type").and_then(|v| v.as_str()) else {
    return;
  };
  let empty = Value::Object(serde_json::Map::new());
  let data = raw.get("data").filter(|d| d.is_object()).unwrap_or(&empty);

  match kind {
    "assistant.message_delta" => {
      let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
      let text = data.get("deltaContent").and_then(|v| v.as_str()).unwrap_or("");
      if text.is_empty() {
        return;
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
    _ => {}
  }
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

/// Directories that never affect a review and would be expensive to walk.
const SKIP_DIRS: &[&str] = &[
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  "coverage",
  ".rayfin",
  ".turbo",
  ".cache",
];

/// Walk `dir`, feeding `relpath|len|mtime` of each file into `hasher` (stat-only,
/// no reads), skipping heavy/irrelevant directories.
fn hash_dir(hasher: &mut Sha256, root: &Path, dir: &Path) {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return;
  };
  let mut entries: Vec<_> = entries.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for entry in entries {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    let Ok(ft) = entry.file_type() else {
      continue;
    };
    let path = entry.path();
    if ft.is_dir() {
      if !SKIP_DIRS.contains(&name.as_ref()) {
        hash_dir(hasher, root, &path);
      }
    } else if ft.is_file() {
      let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy();
      let (len, mtime) = entry
        .metadata()
        .map(|m| {
          let mtime = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
          (m.len(), mtime)
        })
        .unwrap_or((0, 0));
      hasher.update(rel.as_bytes());
      hasher.update(b"\0");
      hasher.update(len.to_le_bytes());
      hasher.update(mtime.to_le_bytes());
      hasher.update(b"\n");
    }
  }
}

/// A cheap signature of the project's source tree. Any file added, removed, or
/// edited (size/mtime) changes it; used only to flag a saved review as stale.
fn fingerprint(project_path: &str) -> String {
  let root = Path::new(project_path);
  let mut hasher = Sha256::new();
  let mut hashed_any = false;
  // Prefer the dirs a review actually depends on; fall back to the whole root.
  for sub in ["rayfin", "src"] {
    let p = root.join(sub);
    if p.is_dir() {
      hash_dir(&mut hasher, root, &p);
      hashed_any = true;
    }
  }
  if !hashed_any {
    hash_dir(&mut hasher, root, root);
  }
  hex::encode(hasher.finalize())
}

/// Persist a successful review for later reload.
fn save_snapshot(project_id: &str, snapshot: &AdvisorSnapshot) {
  if let Ok(text) = serde_json::to_string_pretty(snapshot) {
    let _ = std::fs::write(paths::advisor_file(project_id), text);
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
) -> Result<AdvisorSnapshot, String> {
  let Some(project) = store::find_project(&project_id) else {
    return Err("Project not found.".into());
  };

  let Some(token) = state.try_begin_advisor(&project_id) else {
    return Err("An analysis is already running for this project.".into());
  };

  let started = Instant::now();
  let session_id = Uuid::new_v4().to_string();
  let cwd = PathBuf::from(&project.path);
  let args: Vec<&str> = vec![
    "-p",
    ADVISOR_PROMPT,
    "--output-format",
    "json",
    "--session-id",
    &session_id,
    "-C",
    &project.path,
    "--allow-all",
    "--no-color",
  ];

  let shared = Arc::new(Mutex::new(ReviewState::default()));
  let on_data: OnData = {
    let shared = shared.clone();
    let app = app.clone();
    let pid = project_id.clone();
    Arc::new(move |stream: Stream, chunk: &str| {
      if !matches!(stream, Stream::Stdout) {
        return;
      }
      let mut st = shared.lock().unwrap();
      st.buffer.push_str(chunk);
      let mut emit = |text: String, tool: Option<String>| {
        emit_advisor_event(&app, &pid, AdvisorEvent::Progress { text, tool })
      };
      while let Some(nl) = st.buffer.find('\n') {
        let line = st.buffer[..nl].to_string();
        st.buffer.replace_range(..=nl, "");
        handle_line(&line, &mut st, &mut emit);
      }
    })
  };

  let result = run(
    "copilot",
    &args,
    RunOptions {
      cwd: Some(cwd),
      env: vec![],
      on_data: Some(on_data),
      timeout_ms: Some(RUN_TIMEOUT_MS),
      cancel: Some(token.clone()),
    },
  )
  .await;

  // Flush any trailing partial line.
  {
    let mut st = shared.lock().unwrap();
    if !st.buffer.is_empty() {
      let line = std::mem::take(&mut st.buffer);
      let mut emit = |text: String, tool: Option<String>| {
        emit_advisor_event(&app, &project_id, AdvisorEvent::Progress { text, tool })
      };
      handle_line(&line, &mut st, &mut emit);
    }
  }

  state.end_advisor(&project_id);

  let assistant = shared.lock().unwrap().assistant.clone();

  // Map the outcome to a report, keeping the UI on a single happy path.
  let report = if token.is_cancelled() {
    AdvisorReport { ok: false, summary: "Analysis cancelled.".into(), findings: vec![] }
  } else if result.not_found {
    AdvisorReport {
      ok: false,
      summary: "The copilot CLI was not found on PATH.".into(),
      findings: vec![],
    }
  } else if let Some(raw) = extract_report(&assistant) {
    AdvisorReport { ok: true, summary: raw.summary, findings: raw.findings }
  } else {
    let detail = if !result.stderr.trim().is_empty() {
      result.stderr.trim().to_string()
    } else if !assistant.trim().is_empty() {
      assistant.trim().chars().take(600).collect()
    } else {
      format!(
        "copilot exited with code {}",
        result.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
      )
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
