//! Claude Code CLI engine — the alternative agent backend to `copilot.rs`.
//!
//! Where the Copilot engine drives a long-lived JSON-RPC server through the
//! bundled SDK, Claude Code exposes a simpler contract: one `claude --print
//! --output-format stream-json` process per turn, with conversation context
//! carried across turns by `--session-id` / `--resume <uuid>` (the CLI persists
//! session state under `~/.claude/projects/`, so context survives app restarts
//! the same way the Copilot `session-state` directory does).
//!
//! The CLI is **not** bundled: it is installed by the user
//! (`npm i -g @anthropic-ai/claude-code`) and signed in with their Claude
//! subscription via `claude auth login`. That sign-in is what makes this engine
//! useful — a Claude Pro/Max plan drives the agent instead of a Copilot seat.
//!
//! To keep the turn driver in [`crate::commands::chat`] engine-agnostic, this
//! module's [`Translator`] rewrites Claude's stream-json into the *same* event
//! shapes the Copilot SDK emits (`assistant.message_delta`, `tool.execution_start`,
//! `session.idle`, …), so `map_event` — and everything downstream of it: tool
//! cards, `filesModified`, deploy detection, diagnostics — is reused verbatim.

use std::path::PathBuf;

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use tokio::sync::OnceCell;

use crate::services::exec::{self, RunOptions};
use crate::types::{ClaudeAuthStatus, CopilotModel};

/// Settings value selecting this engine (`AppSettings.agent_engine`).
pub const ENGINE_ID: &str = "claude";

/// Tools whose arguments name a file the agent is writing. A completed call to
/// one of these contributes to the turn's `filesModified` list, mirroring the
/// Copilot engine's `session.info` / `file_*` events.
const FILE_WRITING_TOOLS: [&str; 4] = ["Write", "Edit", "NotebookEdit", "MultiEdit"];

/// Resolve the `claude` executable. The CLI ships as a native binary, reached
/// either directly (native install on `PATH`, e.g. `~/.local/bin/claude`) or via
/// an npm cmd-shim on Windows that points at `claude.exe`. [`exec::resolve_cli`]
/// handles both, plus the `node <script>` shape used by script-based shims.
pub fn cli() -> Option<(PathBuf, Vec<PathBuf>)> {
  exec::resolve_cli("claude")
}


/// The CLI's self-reported version (e.g. `"2.1.187"`), probed once and cached
/// for the process lifetime. `None` when the CLI isn't installed.
pub async fn cli_version() -> Option<String> {
  static CACHE: OnceCell<Option<String>> = OnceCell::const_new();
  CACHE
    .get_or_init(|| async {
      let (program, prefix) = cli()?;
      let raw = exec::run_resolved(program, prefix, &["--version"], RunOptions::timeout(15_000)).await;
      parse_cli_version(&raw.stdout)
    })
    .await
    .clone()
}

/// Pull a semver token out of `claude --version` output such as
/// `"2.1.187 (Claude Code)"`.
fn parse_cli_version(raw: &str) -> Option<String> {
  static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\d+\.\d+\.\d+(?:-[\w.]+)?").unwrap());
  RE.find(raw).map(|m| m.as_str().to_string())
}

/// Read the signed-in Claude account via `claude auth status --json`.
///
/// The CLI answers with `{"loggedIn":true,"authMethod":"claude.ai","email":…,
/// "subscriptionType":"pro"}`. Asking the CLI keeps us off the credential store
/// entirely — tokens live in `~/.claude/.credentials.json` on Windows/Linux but
/// in the Keychain on macOS, and this probe is correct on all three.
pub async fn auth_status() -> ClaudeAuthStatus {
  let Some((program, prefix)) = cli() else {
    return ClaudeAuthStatus::default();
  };
  let res = exec::run_resolved(program, prefix, &["auth", "status", "--json"], RunOptions::timeout(20_000)).await;
  let mut status = parse_auth_status(&res.stdout);
  status.installed = true;
  status
}

/// Parse `claude auth status --json` output into the renderer DTO. Tolerates a
/// non-JSON answer (older CLI, or an error message) by reporting signed-out.
fn parse_auth_status(stdout: &str) -> ClaudeAuthStatus {
  let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) else {
    return ClaudeAuthStatus::default();
  };
  let signed_in = v.get("loggedIn").and_then(Value::as_bool).unwrap_or(false);
  let str_field = |key: &str| {
    v.get(key)
      .and_then(Value::as_str)
      .map(str::trim)
      .filter(|s| !s.is_empty())
      .map(str::to_string)
  };
  ClaudeAuthStatus {
    installed: false, // set by the caller, which knows whether the CLI resolved
    signed_in,
    user: str_field("email"),
    // "pro" / "max" for a Claude subscription; absent for Console (API-billed)
    // sign-ins, which the setup screen labels differently.
    subscription: str_field("subscriptionType"),
    auth_method: str_field("authMethod"),
  }
}

/// Models offered when the Claude engine is active.
///
/// Unlike Copilot — which serves a per-seat, policy-filtered `models.list` RPC —
/// the Claude Code CLI has no machine-readable model listing, so this is a
/// curated catalog of the aliases `--model` accepts. Aliases (not dated ids) are
/// used deliberately: they keep pointing at the current release of each tier, so
/// the list doesn't silently rot as new snapshots ship.
///
/// Effort levels mirror the CLI's `--effort` flag (`low`…`max`), which the chat
/// composer's existing reasoning-effort control drives.
pub fn models() -> Vec<CopilotModel> {
  let efforts = || {
    ["low", "medium", "high", "xhigh", "max"]
      .iter()
      .map(|s| s.to_string())
      .collect::<Vec<_>>()
  };
  vec![
    CopilotModel {
      id: "opus".into(),
      name: "Claude Opus (most capable)".into(),
      supported_reasoning_efforts: efforts(),
      default_reasoning_effort: Some("medium".into()),
    },
    CopilotModel {
      id: "sonnet".into(),
      name: "Claude Sonnet (balanced)".into(),
      supported_reasoning_efforts: efforts(),
      default_reasoning_effort: Some("medium".into()),
    },
    CopilotModel {
      id: "haiku".into(),
      name: "Claude Haiku (fastest)".into(),
      supported_reasoning_efforts: Vec::new(),
      default_reasoning_effort: None,
    },
  ]
}

/// Map the renderer's chat mode to a `--permission-mode` value.
///
/// Fabricator drives the agent unattended (the Copilot engine installs an
/// `ApproveAllHandler`), so Agent/Autopilot turns run with `acceptEdits`, which
/// lets the agent write files without prompting a TTY that isn't there. Plan
/// mode maps to the CLI's own `plan` mode, where the agent researches and then
/// calls `ExitPlanMode` with a proposed plan instead of editing.
pub fn permission_mode(mode: &Option<String>) -> &'static str {
  match mode.as_deref() {
    Some("plan") => "plan",
    _ => "acceptEdits",
  }
}

/// Build the argument list for one turn.
///
/// `session_id` is the project's stored conversation id: the first turn creates
/// it with `--session-id`, later turns continue it with `--resume`, which keeps
/// the same id and replays the prior context.
pub fn turn_args(
  prompt: &str,
  session_id: &str,
  resume: bool,
  model: &Option<String>,
  effort: &Option<String>,
  mode: &Option<String>,
) -> Vec<String> {
  let mut args: Vec<String> = vec![
    "--print".into(),
    prompt.into(),
    "--output-format".into(),
    "stream-json".into(),
    // Required by the CLI for stream-json output, and the source of the
    // incremental `content_block_delta` chunks the composer types out.
    "--verbose".into(),
    "--include-partial-messages".into(),
    "--permission-mode".into(),
    permission_mode(mode).into(),
  ];
  if resume {
    args.push("--resume".into());
  } else {
    args.push("--session-id".into());
  }
  args.push(session_id.into());
  if let Some(m) = normalized(model) {
    args.push("--model".into());
    args.push(m);
  }
  if let Some(e) = normalized(effort) {
    args.push("--effort".into());
    args.push(e);
  }
  args
}

/// Trim a setting to `None` when empty or the synthetic `"auto"` sentinel the
/// model picker uses for "let the engine choose".
fn normalized(value: &Option<String>) -> Option<String> {
  value
    .as_deref()
    .map(str::trim)
    .filter(|v| !v.is_empty() && *v != "auto")
    .map(str::to_string)
}

/// Compose the prompt for a turn, naming any attached files so the agent reads
/// them. The Copilot engine passes typed attachments over its RPC; the CLI has
/// no equivalent for `--print`, but it can open any path inside the project.
pub fn compose_prompt(text: &str, attachments: &[String]) -> String {
  if attachments.is_empty() {
    return text.to_string();
  }
  let list = attachments
    .iter()
    .map(|a| format!("- {a}"))
    .collect::<Vec<_>>()
    .join("\n");
  format!("{text}\n\nAttached files (read these for context):\n{list}")
}

/// Incremental translator from Claude Code's stream-json into Copilot-shaped
/// `(event_type, data)` pairs.
///
/// Feed it raw stdout with [`push`](Translator::push); it buffers partial lines
/// and returns the events completed so far. Emitting the Copilot wire shapes is
/// what lets `chat::map_event` — and the whole renderer contract — stay unaware
/// of which engine produced a turn.
#[derive(Default)]
pub struct Translator {
  /// Carry for a stdout chunk that ended mid-line.
  buf: String,
  /// Id of the assistant message currently streaming, from `message_start`.
  message_id: String,
  /// True once a terminal `result` line has been seen.
  done: bool,
}

impl Translator {
  pub fn new() -> Self {
    Self::default()
  }

  /// Whether the stream reported its terminal `result` event.
  pub fn finished(&self) -> bool {
    self.done
  }

  /// Feed a chunk of stdout, returning any events it completed.
  pub fn push(&mut self, chunk: &str) -> Vec<(String, Value)> {
    self.buf.push_str(chunk);
    let mut out = Vec::new();
    // Keep the trailing partial line (if any) in the buffer for the next chunk.
    while let Some(idx) = self.buf.find('\n') {
      let line = self.buf[..idx].trim().to_string();
      self.buf.drain(..=idx);
      if !line.is_empty() {
        self.translate(&line, &mut out);
      }
    }
    out
  }

  /// Flush a final line left without a trailing newline (process exit).
  pub fn finish(&mut self) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let line = std::mem::take(&mut self.buf).trim().to_string();
    if !line.is_empty() {
      self.translate(&line, &mut out);
    }
    out
  }

  fn translate(&mut self, line: &str, out: &mut Vec<(String, Value)>) {
    // A non-JSON line is CLI chatter (e.g. an update notice); ignore it rather
    // than failing the turn.
    let Ok(v) = serde_json::from_str::<Value>(line) else {
      return;
    };
    match v.get("type").and_then(Value::as_str).unwrap_or_default() {
      "stream_event" => self.translate_stream_event(&v, out),
      "assistant" => self.translate_assistant(&v, out),
      "user" => translate_tool_results(&v, out),
      "result" => {
        self.done = true;
        let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        if is_error {
          let msg = v
            .get("result")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
              v.get("subtype")
                .and_then(Value::as_str)
                .map(|s| format!("Claude ended the turn: {s}."))
            })
            .unwrap_or_else(|| "Claude reported an error.".to_string());
          out.push(("session.error".into(), json!({ "message": msg })));
        } else {
          out.push(("session.idle".into(), json!({})));
        }
      }
      _ => {}
    }
  }

  /// Partial-message events: text deltas become `assistant.message_delta` so the
  /// composer types the answer out live. Thinking deltas are intentionally
  /// dropped — the renderer has no surface for reasoning text.
  fn translate_stream_event(&mut self, v: &Value, out: &mut Vec<(String, Value)>) {
    let Some(event) = v.get("event") else { return };
    match event.get("type").and_then(Value::as_str).unwrap_or_default() {
      "message_start" => {
        if let Some(id) = event
          .get("message")
          .and_then(|m| m.get("id"))
          .and_then(Value::as_str)
        {
          self.message_id = id.to_string();
        }
      }
      "content_block_delta" => {
        let Some(delta) = event.get("delta") else { return };
        if delta.get("type").and_then(Value::as_str) != Some("text_delta") {
          return;
        }
        let text = delta.get("text").and_then(Value::as_str).unwrap_or_default();
        if text.is_empty() {
          return;
        }
        out.push((
          "assistant.message_delta".into(),
          json!({ "messageId": self.message_id, "deltaContent": text }),
        ));
      }
      _ => {}
    }
  }

  /// A complete assistant message: text blocks reconcile whatever the deltas
  /// already streamed (`map_event` emits only the unstreamed tail, so this is
  /// also the fallback when partial messages are unavailable), and `tool_use`
  /// blocks open a tool card.
  fn translate_assistant(&mut self, v: &Value, out: &mut Vec<(String, Value)>) {
    let Some(message) = v.get("message") else { return };
    let id = message
      .get("id")
      .and_then(Value::as_str)
      .unwrap_or(&self.message_id)
      .to_string();
    let Some(content) = message.get("content").and_then(Value::as_array) else {
      return;
    };

    let text = content
      .iter()
      .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
      .filter_map(|b| b.get("text").and_then(Value::as_str))
      .collect::<Vec<_>>()
      .join("");
    if !text.is_empty() {
      out.push((
        "assistant.message".into(),
        json!({ "messageId": id, "content": text }),
      ));
    }

    for block in content
      .iter()
      .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
    {
      let tool_id = block.get("id").and_then(Value::as_str).unwrap_or_default();
      let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
      // A Plan-mode turn finishes by calling `ExitPlanMode` with the plan it
      // wrote. There is no approval round-trip to make here — the CLI ends the
      // turn either way — so the plan is surfaced as the assistant's answer,
      // which puts it in the transcript for the user to act on.
      if name == "ExitPlanMode" {
        if let Some(plan) = block
          .get("input")
          .and_then(|i| i.get("plan"))
          .and_then(Value::as_str)
          .map(str::trim)
          .filter(|p| !p.is_empty())
        {
          out.push((
            "assistant.message".into(),
            json!({ "messageId": format!("{id}-plan"), "content": plan }),
          ));
        }
        continue;
      }
      out.push((
        "tool.execution_start".into(),
        json!({
          "toolCallId": tool_id,
          "toolName": name,
          "arguments": block.get("input").cloned().unwrap_or(Value::Null),
        }),
      ));
      // Record the write target now: the matching tool_result carries the path
      // only for some tools, and the turn's `filesModified` drives the
      // after-turn deploy and the file tree refresh.
      if FILE_WRITING_TOOLS.contains(&name) {
        if let Some(path) = block
          .get("input")
          .and_then(|i| i.get("file_path").or_else(|| i.get("notebook_path")))
          .and_then(Value::as_str)
        {
          out.push((
            "session.info".into(),
            json!({ "infoType": "file_edited", "message": path }),
          ));
        }
      }
    }
  }
}

/// A `user` line carries the results of the tools the agent just ran. Each
/// `tool_result` block closes its tool card.
fn translate_tool_results(v: &Value, out: &mut Vec<(String, Value)>) {
  let Some(content) = v
    .get("message")
    .and_then(|m| m.get("content"))
    .and_then(Value::as_array)
  else {
    return;
  };
  for block in content
    .iter()
    .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
  {
    let id = block
      .get("tool_use_id")
      .and_then(Value::as_str)
      .unwrap_or_default();
    let failed = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
    let text = tool_result_text(block.get("content"));
    let data = if failed {
      json!({ "toolCallId": id, "success": false, "error": { "message": text } })
    } else {
      json!({ "toolCallId": id, "success": true, "result": { "content": text } })
    };
    out.push(("tool.execution_complete".into(), data));
  }
}

/// Flatten a `tool_result.content`, which is either a plain string or the
/// content-block array form (`[{"type":"text","text":…}]`).
fn tool_result_text(content: Option<&Value>) -> String {
  match content {
    Some(Value::String(s)) => s.clone(),
    Some(Value::Array(blocks)) => blocks
      .iter()
      .filter_map(|b| b.get("text").and_then(Value::as_str))
      .collect::<Vec<_>>()
      .join("\n"),
    _ => String::new(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Collect every event a set of stream-json lines translates to.
  fn run(lines: &[&str]) -> Vec<(String, Value)> {
    let mut t = Translator::new();
    let mut out = Vec::new();
    for line in lines {
      out.extend(t.push(&format!("{line}\n")));
    }
    out.extend(t.finish());
    out
  }

  fn kinds(events: &[(String, Value)]) -> Vec<&str> {
    events.iter().map(|(k, _)| k.as_str()).collect()
  }

  #[test]
  fn parses_version_from_cli_banner() {
    assert_eq!(parse_cli_version("2.1.187 (Claude Code)").as_deref(), Some("2.1.187"));
    assert_eq!(parse_cli_version("nothing here"), None);
  }

  #[test]
  fn reads_subscription_auth_status() {
    let s = parse_auth_status(
      r#"{"loggedIn":true,"authMethod":"claude.ai","email":"dev@example.com","subscriptionType":"pro"}"#,
    );
    assert!(s.signed_in);
    assert_eq!(s.user.as_deref(), Some("dev@example.com"));
    assert_eq!(s.subscription.as_deref(), Some("pro"));
  }

  #[test]
  fn signed_out_and_garbage_are_not_signed_in() {
    assert!(!parse_auth_status(r#"{"loggedIn":false}"#).signed_in);
    assert!(!parse_auth_status("command not found").signed_in);
  }

  #[test]
  fn text_deltas_stream_as_message_deltas() {
    let events = run(&[
      r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1"}}}"#,
      r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}"#,
      r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}"#,
    ]);
    assert_eq!(kinds(&events), ["assistant.message_delta", "assistant.message_delta"]);
    assert_eq!(events[0].1["messageId"], "msg_1");
    assert_eq!(events[0].1["deltaContent"], "Hel");
    assert_eq!(events[1].1["deltaContent"], "lo");
  }

  #[test]
  fn thinking_deltas_are_dropped() {
    let events = run(&[
      r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}"#,
    ]);
    assert!(events.is_empty());
  }

  #[test]
  fn tool_use_opens_a_card_and_result_closes_it() {
    let events = run(&[
      r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"npm test"}}]}}"#,
      r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}"#,
    ]);
    assert_eq!(kinds(&events), ["tool.execution_start", "tool.execution_complete"]);
    assert_eq!(events[0].1["toolName"], "Bash");
    assert_eq!(events[0].1["arguments"]["command"], "npm test");
    assert_eq!(events[1].1["toolCallId"], "toolu_1");
    assert_eq!(events[1].1["success"], true);
    assert_eq!(events[1].1["result"]["content"], "ok");
  }

  #[test]
  fn failed_tool_result_reports_the_error() {
    let events = run(&[
      r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t9","is_error":true,"content":[{"type":"text","text":"boom"}]}]}}"#,
    ]);
    assert_eq!(events[0].1["success"], false);
    assert_eq!(events[0].1["error"]["message"], "boom");
  }

  #[test]
  fn file_writes_are_reported_for_files_modified() {
    let events = run(&[
      r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"src/app.ts","content":"x"}}]}}"#,
    ]);
    assert_eq!(kinds(&events), ["tool.execution_start", "session.info"]);
    assert_eq!(events[1].1["infoType"], "file_edited");
    assert_eq!(events[1].1["message"], "src/app.ts");
  }

  #[test]
  fn assistant_text_becomes_a_message_event() {
    let events = run(&[
      r#"{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"Done."}]}}"#,
    ]);
    assert_eq!(kinds(&events), ["assistant.message"]);
    assert_eq!(events[0].1["messageId"], "m2");
    assert_eq!(events[0].1["content"], "Done.");
  }

  #[test]
  fn success_result_ends_the_turn_idle() {
    let events = run(&[r#"{"type":"result","subtype":"success","is_error":false,"result":"done"}"#]);
    assert_eq!(kinds(&events), ["session.idle"]);
  }

  #[test]
  fn error_result_surfaces_the_message() {
    let events = run(&[r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"rate limited"}"#]);
    assert_eq!(kinds(&events), ["session.error"]);
    assert_eq!(events[0].1["message"], "rate limited");
  }

  #[test]
  fn chunks_split_mid_line_are_reassembled() {
    let mut t = Translator::new();
    assert!(t
      .push(r#"{"type":"result","subtype":"success","is_er"#)
      .is_empty());
    let events = t.push("ror\":false}\n");
    assert_eq!(kinds(&events), ["session.idle"]);
    assert!(t.finished());
  }

  #[test]
  fn non_json_chatter_is_ignored() {
    let events = run(&["Update available: 2.2.0", ""]);
    assert!(events.is_empty());
  }

  #[test]
  fn first_turn_creates_a_session_and_later_turns_resume_it() {
    let fresh = turn_args("hi", "sid-1", false, &None, &None, &None);
    assert!(fresh.contains(&"--session-id".to_string()));
    assert!(!fresh.contains(&"--resume".to_string()));

    let resumed = turn_args("hi", "sid-1", true, &None, &None, &None);
    assert!(resumed.contains(&"--resume".to_string()));
    assert!(!resumed.contains(&"--session-id".to_string()));
    // The id follows whichever flag was chosen.
    let at = resumed.iter().position(|a| a == "--resume").unwrap();
    assert_eq!(resumed[at + 1], "sid-1");
  }

  #[test]
  fn model_and_effort_are_passed_through_and_auto_is_omitted() {
    let args = turn_args("hi", "s", false, &Some("sonnet".into()), &Some("high".into()), &None);
    let at = args.iter().position(|a| a == "--model").unwrap();
    assert_eq!(args[at + 1], "sonnet");
    let at = args.iter().position(|a| a == "--effort").unwrap();
    assert_eq!(args[at + 1], "high");

    // "auto" is the picker's "let the engine choose" sentinel — no flag.
    let auto = turn_args("hi", "s", false, &Some("auto".into()), &Some("  ".into()), &None);
    assert!(!auto.contains(&"--model".to_string()));
    assert!(!auto.contains(&"--effort".to_string()));
  }

  #[test]
  fn plan_mode_maps_to_the_cli_plan_permission_mode() {
    assert_eq!(permission_mode(&Some("plan".into())), "plan");
    assert_eq!(permission_mode(&Some("agent".into())), "acceptEdits");
    assert_eq!(permission_mode(&None), "acceptEdits");
  }

  #[test]
  fn attachments_are_named_in_the_prompt() {
    assert_eq!(compose_prompt("fix it", &[]), "fix it");
    let composed = compose_prompt("fix it", &["/tmp/shot.png".to_string()]);
    assert!(composed.starts_with("fix it"));
    assert!(composed.contains("/tmp/shot.png"));
  }
}
