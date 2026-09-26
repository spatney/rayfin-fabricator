//! Presentation metadata for Copilot tool calls, derived from raw SDK tool
//! events: a one-line title, the files a call touches, the shell command it ran,
//! a unified diff for file edits, and cleaned-up shell output.
//!
//! The SDK reports two views of a result: `result.content` is the concise text
//! sent back to the model, while `result.detailedContent` is meant for UI
//! timelines and carries full unified diffs for file edits. Output shown in chat
//! comes from `content`; diffs come from `detailedContent`.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

/// Cap for tool output forwarded to the renderer (and persisted with the chat).
pub const MAX_TOOL_OUTPUT: usize = 4000;
/// Cap for a forwarded diff; line counts are taken from the full diff first.
pub const MAX_TOOL_DIFF: usize = 16_000;
/// Cap for a forwarded shell command line.
const MAX_COMMAND: usize = 2000;

/// Argument keys tried, in order, for a tool's one-line title. `pattern` wins
/// over `path` so searches read as their query rather than their search root.
const TITLE_KEYS: &[&str] = &[
  "description", "command", "pattern", "path", "url", "query", "skill", "question", "name", "prompt",
];

static ANSI_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").unwrap());

/// The status marker the Copilot shell tools append once a command finishes.
static SHELL_DONE_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?m)^[ \t]*<shellId:[^>\n]*?completed with exit code (-?\d+)>[ \t]*\r?$\n?").unwrap());

fn lower(name: &str) -> String {
  name.to_ascii_lowercase()
}

/// Tools that execute a shell command (`powershell`, `bash`, `shell`, ...).
pub fn is_shell_tool(name: &str) -> bool {
  let n = lower(name);
  !n.starts_with("fabricator_") && (n.contains("powershell") || n.contains("bash") || n.contains("shell"))
}

/// Tools that create or modify files and report a unified diff.
pub fn is_mutating_tool(name: &str) -> bool {
  matches!(
    lower(name).as_str(),
    "edit" | "create" | "apply_patch" | "write" | "write_file" | "multi_edit" | "str_replace" | "str_replace_editor" | "insert"
  )
}

fn is_read_tool(name: &str) -> bool {
  matches!(lower(name).as_str(), "view" | "read" | "read_file" | "cat")
}

/// Truncate to `max` characters, noting how many were dropped.
pub fn truncate(text: &str, max: usize) -> String {
  if text.chars().count() <= max {
    return text.to_string();
  }
  let head: String = text.chars().take(max).collect();
  let more = text.chars().count() - max;
  format!("{head}\n… ({more} more characters)")
}

/// Truncate to about `max` characters keeping both ends; the end of a command's
/// output is where errors and summaries land, so it gets the larger share.
pub fn truncate_middle(text: &str, max: usize) -> String {
  let total = text.chars().count();
  if total <= max {
    return text.to_string();
  }
  let head_len = max * 3 / 10;
  let tail_len = max - head_len;
  let head: String = text.chars().take(head_len).collect();
  let tail: String = text.chars().skip(total - tail_len).collect();
  // Snap to line boundaries when one is close, so lines aren't cut mid-way.
  let head = match head.rfind('\n') {
    Some(i) if i > head.len() / 2 => head[..i].to_string(),
    _ => head,
  };
  let tail = match tail.find('\n') {
    Some(i) if i < tail.len() / 2 => tail[i + 1..].to_string(),
    _ => tail,
  };
  let omitted = total - head.chars().count() - tail.chars().count();
  format!("{head}\n… ({omitted} characters omitted) …\n{tail}")
}

/// Remove terminal color / control sequences.
pub fn strip_ansi(text: &str) -> String {
  if !text.contains('\x1b') {
    return text.to_string();
  }
  ANSI_RE.replace_all(text, "").into_owned()
}

/// Split a shell tool's output into its body and exit code, dropping the
/// `<shellId: N completed with exit code X>` marker.
pub fn split_shell_status(text: &str) -> (String, Option<i64>) {
  let mut code = None;
  for caps in SHELL_DONE_RE.captures_iter(text) {
    code = caps.get(1).and_then(|m| m.as_str().parse().ok());
  }
  if code.is_none() {
    return (text.to_string(), None);
  }
  (SHELL_DONE_RE.replace_all(text, "").into_owned(), code)
}

/// Files named by `apply_patch` text (`*** Add/Update/Delete File: <path>`).
pub fn patch_files(patch: &str) -> Vec<String> {
  let mut files: Vec<String> = Vec::new();
  for line in patch.lines() {
    let path = ["*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"]
      .iter()
      .find_map(|prefix| line.strip_prefix(prefix))
      .map(str::trim)
      .filter(|p| !p.is_empty());
    if let Some(path) = path {
      if !files.iter().any(|f| f == path) {
        files.push(path.to_string());
      }
    }
  }
  files
}

fn collapse(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Derive a one-line title for a tool call from its arguments.
pub fn tool_title(tool_name: &str, args: Option<&Value>) -> String {
  let Some(args) = args else {
    return tool_name.to_string();
  };
  // `apply_patch` sends the raw patch text rather than an arguments object.
  if let Some(patch) = args.as_str() {
    return patch_files(patch).into_iter().next().unwrap_or_else(|| tool_name.to_string());
  }
  let raw = TITLE_KEYS
    .iter()
    .find_map(|key| args.get(*key).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()))
    .unwrap_or(tool_name);
  truncate(collapse(raw).trim(), 200)
}

/// Files a call reads or writes, when the tool names them.
pub fn tool_paths(tool_name: &str, args: Option<&Value>) -> Option<Vec<String>> {
  let args = args?;
  if let Some(patch) = args.as_str() {
    let files = patch_files(patch);
    return (!files.is_empty()).then_some(files);
  }
  if !(is_mutating_tool(tool_name) || is_read_tool(tool_name)) {
    return None;
  }
  let path = args.get("path").and_then(|v| v.as_str()).map(str::trim).filter(|p| !p.is_empty())?;
  Some(vec![path.to_string()])
}

/// The command line a shell tool ran.
pub fn shell_command(tool_name: &str, args: Option<&Value>) -> Option<String> {
  if !is_shell_tool(tool_name) {
    return None;
  }
  let command = args?.get("command")?.as_str()?.trim();
  (!command.is_empty()).then(|| truncate(command, MAX_COMMAND))
}

fn looks_like_diff(text: &str) -> bool {
  text.starts_with("@@") || text.contains("\n@@") || text.contains("diff --git")
}

/// Count added / removed lines in a unified diff (hunk bodies only, so file
/// headers and content lines that merely start with `+++` are handled).
pub fn count_diff_lines(diff: &str) -> (u32, u32) {
  let (mut added, mut removed) = (0u32, 0u32);
  let mut in_hunk = false;
  for line in diff.lines() {
    if line.starts_with("diff --git") {
      in_hunk = false;
    } else if line.starts_with("@@") {
      in_hunk = true;
    } else if in_hunk {
      if line.starts_with('+') {
        added += 1;
      } else if line.starts_with('-') {
        removed += 1;
      }
    }
  }
  (added, removed)
}

/// Cap `text` to about `max` characters on a line boundary.
fn cap_lines(text: &str, max: usize) -> (String, bool) {
  if text.chars().count() <= max {
    return (text.to_string(), false);
  }
  let head: String = text.chars().take(max).collect();
  let cut = head.rfind('\n').unwrap_or(head.len());
  (head[..cut].to_string(), true)
}

/// Cap for the live output tail forwarded while a tool runs.
pub const LIVE_OUTPUT_TAIL: usize = 8000;
/// Cap for live output buffered per tool (incremental streams only).
const LIVE_OUTPUT_BUFFER: usize = 64_000;

fn tail_chars(text: &str, max: usize) -> &str {
  let total = text.chars().count();
  if total <= max {
    return text;
  }
  let skip = total - max;
  let start = text.char_indices().nth(skip).map(|(i, _)| i).unwrap_or(0);
  &text[start..]
}

/// Live output of one running tool. The Copilot shell tools report
/// `partialOutput` cumulatively (each event repeats everything so far), but the
/// SDK documents it as incremental chunks, so the mode is inferred from the
/// second event: cumulative streams are replaced, incremental ones appended.
#[derive(Default)]
pub struct LiveOutput {
  cumulative: Option<bool>,
  buf: String,
}

impl LiveOutput {
  /// Fold in one partial result and return the current output tail to show.
  pub fn push(&mut self, text: &str) -> String {
    match self.cumulative {
      None if self.buf.is_empty() => self.buf = text.to_string(),
      None => {
        let cumulative = text.starts_with(self.buf.as_str());
        self.cumulative = Some(cumulative);
        if cumulative {
          self.buf = text.to_string();
        } else {
          self.buf.push_str(text);
        }
      }
      Some(true) => self.buf = text.to_string(),
      Some(false) => self.buf.push_str(text),
    }
    if self.buf.len() > LIVE_OUTPUT_BUFFER * 4 {
      self.buf = tail_chars(&self.buf, LIVE_OUTPUT_BUFFER).to_string();
    }
    tail_chars(&self.buf, LIVE_OUTPUT_TAIL).trim_start_matches(['\r', '\n']).to_string()
  }
}

/// Everything the renderer needs about a finished tool call.
#[derive(Default, Debug, PartialEq)]
pub struct ToolEndDetails {
  pub output: Option<String>,
  pub diff: Option<String>,
  pub diff_truncated: Option<bool>,
  pub added: Option<u32>,
  pub removed: Option<u32>,
  pub exit_code: Option<i64>,
}

/// Build the renderer-facing details of a `tool.execution_complete` event.
/// `tool_name` comes from the matching `tool.execution_start`, when known.
pub fn tool_end_details(tool_name: Option<&str>, data: &Value) -> ToolEndDetails {
  let name = tool_name.unwrap_or("");
  let result = data.get("result");
  // Success carries `result.content`; failure carries `error.message`.
  let raw = result
    .and_then(|r| r.get("content"))
    .and_then(|v| v.as_str())
    .or_else(|| data.get("error").and_then(|e| e.get("message")).and_then(|v| v.as_str()));
  let mut details = ToolEndDetails::default();
  if let Some(raw) = raw {
    if is_shell_tool(name) {
      let (body, code) = split_shell_status(&strip_ansi(raw));
      details.exit_code = code;
      details.output = Some(truncate_middle(body.trim_end(), MAX_TOOL_OUTPUT));
    } else {
      details.output = Some(truncate(raw, MAX_TOOL_OUTPUT));
    }
  }
  let success = data.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
  if success && is_mutating_tool(name) {
    let diff = result
      .and_then(|r| r.get("detailedContent"))
      .and_then(|v| v.as_str())
      .map(|d| d.trim_start_matches(['\r', '\n']))
      .filter(|d| looks_like_diff(d));
    if let Some(diff) = diff {
      let (added, removed) = count_diff_lines(diff);
      let (capped, truncated) = cap_lines(diff.trim_end(), MAX_TOOL_DIFF);
      details.added = Some(added);
      details.removed = Some(removed);
      details.diff = Some(capped);
      details.diff_truncated = truncated.then_some(true);
    }
  }
  details
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn truncate_appends_more_marker() {
    assert_eq!(truncate("hello", 10), "hello");
    let out = truncate("abcdef", 3);
    assert!(out.starts_with("abc"));
    assert!(out.contains("3 more characters"));
  }

  #[test]
  fn titles_prefer_descriptions_patterns_and_urls() {
    let shell = json!({"command":"npm run build","description":"Build the app"});
    assert_eq!(tool_title("powershell", Some(&shell)), "Build the app");
    let grep = json!({"pattern":"salesModel","paths":"C:\\p\\src","output_mode":"content"});
    assert_eq!(tool_title("grep", Some(&grep)), "salesModel");
    let rooted = json!({"pattern":"**/*.ts","path":"C:\\p"});
    assert_eq!(tool_title("glob", Some(&rooted)), "**/*.ts");
    assert_eq!(tool_title("web_fetch", Some(&json!({"url":"https://rayfin.ai/llms.txt"}))), "https://rayfin.ai/llms.txt");
    assert_eq!(tool_title("skill", Some(&json!({"skill":"data-modeling"}))), "data-modeling");
    assert_eq!(tool_title("view", Some(&json!({"path":"C:\\p\\src\\App.tsx"}))), "C:\\p\\src\\App.tsx");
    assert_eq!(tool_title("ask_user", Some(&json!({"question":"Which   theme?"}))), "Which theme?");
    assert_eq!(tool_title("mystery", Some(&json!({"flag":true}))), "mystery");
    assert_eq!(tool_title("mystery", None), "mystery");
  }

  #[test]
  fn apply_patch_titles_and_paths_come_from_the_patch_text() {
    let patch = json!("*** Begin Patch\n*** Update File: C:\\p\\src\\App.tsx\n@@\n-a\n+b\n*** Add File: C:\\p\\src\\theme.ts\n+x\n*** Update File: C:\\p\\src\\App.tsx\n*** End Patch");
    assert_eq!(tool_title("apply_patch", Some(&patch)), "C:\\p\\src\\App.tsx");
    assert_eq!(
      tool_paths("apply_patch", Some(&patch)),
      Some(vec!["C:\\p\\src\\App.tsx".to_string(), "C:\\p\\src\\theme.ts".to_string()])
    );
  }

  #[test]
  fn paths_only_for_file_tools_and_commands_only_for_shells() {
    let edit = json!({"path":"C:\\p\\a.ts","old_str":"a","new_str":"b"});
    assert_eq!(tool_paths("edit", Some(&edit)), Some(vec!["C:\\p\\a.ts".to_string()]));
    assert_eq!(tool_paths("grep", Some(&json!({"pattern":"x","path":"C:\\p"}))), None);
    let shell = json!({"command":"  npm run build  ","description":"Build"});
    assert_eq!(shell_command("powershell", Some(&shell)).as_deref(), Some("npm run build"));
    assert_eq!(shell_command("edit", Some(&shell)), None);
    assert!(!is_shell_tool("fabricator_screenshot"));
  }

  #[test]
  fn shell_output_drops_the_status_marker_and_keeps_the_exit_code() {
    let (body, code) = split_shell_status("1.35.1\n1.35.1\n<shellId: 0 completed with exit code 0>\n");
    assert_eq!(body, "1.35.1\n1.35.1\n");
    assert_eq!(code, Some(0));
    let (body, code) = split_shell_status("error TS2304\n<shellId: 12 completed with exit code 2>");
    assert_eq!(body.trim_end(), "error TS2304");
    assert_eq!(code, Some(2));
    let (body, code) = split_shell_status("<command with shellId: 3 is still running after 30 seconds>");
    assert_eq!(code, None);
    assert!(body.contains("still running"));
  }

  #[test]
  fn ansi_sequences_are_removed() {
    assert_eq!(strip_ansi("\x1b[32m✓ built\x1b[0m in 2s"), "✓ built in 2s");
    assert_eq!(strip_ansi("plain"), "plain");
  }

  #[test]
  fn middle_truncation_keeps_the_end_of_long_output() {
    let long: String = (0..2000).map(|i| format!("line {i}\n")).collect();
    let out = truncate_middle(&long, 400);
    assert!(out.starts_with("line 0"));
    assert!(out.contains("characters omitted"));
    assert!(out.trim_end().ends_with("line 1999"));
    assert!(out.chars().count() < 500);
    assert_eq!(truncate_middle("short", 400), "short");
  }

  #[test]
  fn diff_line_counts_ignore_headers_and_plus_prefixed_content() {
    let diff = "diff --git a/C:/p/a.ts b/C:/p/a.ts\nindex 0000000..0000000 100644\n--- a/C:/p/a.ts\n+++ b/C:/p/a.ts\n@@ -1,3 +1,4 @@\n const a = 1\n-const b = 2\n+const b = 3\n++++counter\n context\n";
    assert_eq!(count_diff_lines(diff), (2, 1));
  }

  #[test]
  fn edit_completion_forwards_the_detailed_diff_with_stats() {
    let data = json!({
      "toolCallId": "t1",
      "success": true,
      "result": {
        "content": "File C:\\p\\a.ts updated with changes.",
        "detailedContent": "\ndiff --git a/C:/p/a.ts b/C:/p/a.ts\nindex 0000000..0000000 100644\n--- a/C:/p/a.ts\n+++ b/C:/p/a.ts\n@@ -1,2 +1,2 @@\n-const b = 2\n+const b = 3\n keep\n"
      }
    });
    let details = tool_end_details(Some("edit"), &data);
    assert_eq!(details.output.as_deref(), Some("File C:\\p\\a.ts updated with changes."));
    assert!(details.diff.as_deref().unwrap().starts_with("diff --git"));
    assert_eq!((details.added, details.removed), (Some(1), Some(1)));
    assert_eq!(details.diff_truncated, None);
    assert_eq!(details.exit_code, None);
  }

  #[test]
  fn large_diffs_are_capped_but_counted_in_full() {
    let body: String = (0..3000).map(|i| format!("+line {i}\n")).collect();
    let detailed = format!("diff --git a/x b/x\n--- a/dev/null\n+++ b/x\n@@ -1,0 +1,3000 @@\n{body}");
    let data = json!({"success": true, "result": {"content": "Created", "detailedContent": detailed}});
    let details = tool_end_details(Some("create"), &data);
    assert_eq!(details.added, Some(3000));
    assert_eq!(details.diff_truncated, Some(true));
    assert!(details.diff.as_deref().unwrap().chars().count() <= MAX_TOOL_DIFF);
  }

  #[test]
  fn reads_and_failures_carry_no_diff() {
    let view = json!({"success": true, "result": {"content": "1. a", "detailedContent": "\ndiff --git a/x b/x\n@@ -1 +1 @@\n a"}});
    assert_eq!(tool_end_details(Some("view"), &view).diff, None);
    let failed = json!({"success": false, "error": {"message": "boom"}});
    let details = tool_end_details(Some("edit"), &failed);
    assert_eq!(details.output.as_deref(), Some("boom"));
    assert_eq!(details.diff, None);
  }

  #[test]
  fn live_output_replaces_cumulative_partials_and_appends_incremental_ones() {
    let mut cumulative = LiveOutput::default();
    assert_eq!(cumulative.push("\nPinging "), "Pinging ");
    assert_eq!(cumulative.push("\nPinging 127.0.0.1\nReply 1\n"), "Pinging 127.0.0.1\nReply 1\n");
    assert_eq!(cumulative.push("\nPinging 127.0.0.1\nReply 1\nReply 2\n"), "Pinging 127.0.0.1\nReply 1\nReply 2\n");
    let mut incremental = LiveOutput::default();
    assert_eq!(incremental.push("building "), "building ");
    assert_eq!(incremental.push("chunk 1\n"), "building chunk 1\n");
    assert_eq!(incremental.push("chunk 2\n"), "building chunk 1\nchunk 2\n");
  }

  #[test]
  fn live_output_forwards_only_a_bounded_tail() {
    let mut live = LiveOutput::default();
    let big: String = (0..5000).map(|i| format!("row {i}\n")).collect();
    let shown = live.push(&big);
    assert!(shown.chars().count() <= LIVE_OUTPUT_TAIL);
    assert!(shown.trim_end().ends_with("row 4999"));
  }

  #[test]
  fn shell_completion_is_cleaned_and_reports_exit_code() {
    let data = json!({"success": true, "result": {"content": "\x1b[31merror\x1b[0m TS2304\n<shellId: 4 completed with exit code 1>\n"}});
    let details = tool_end_details(Some("powershell"), &data);
    assert_eq!(details.output.as_deref(), Some("error TS2304"));
    assert_eq!(details.exit_code, Some(1));
  }
}
