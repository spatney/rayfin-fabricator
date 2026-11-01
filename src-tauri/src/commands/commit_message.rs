//! A commit message for a project's uncommitted changes, written by Copilot on
//! its Auto model from what the commit would take: the changed files, the diff
//! and the start of each new file, within a budget. It runs on a throwaway,
//! tool-less session, like Design's one-shot calls, so it never touches the
//! project's chat.

use std::path::{Path, PathBuf};

use tauri::State;

use crate::commands::util::looks_binary;
use crate::services::exec::RunOptions;
use crate::services::git::run;
use crate::services::store::find_project;
use crate::state::AppState;
use crate::types::GitMessageResult;

/// What Copilot sees of the changes, at most: enough to name them, small enough to answer fast.
const CHANGES_BUDGET: usize = 16 * 1024;
/// The longest message kept.
const MAX_SUBJECT_CHARS: usize = 100;
/// New files quoted, and how much of each: a new file's start says what it is.
const MAX_NEW_FILES: usize = 8;
const NEW_FILE_MAX_BYTES: u64 = 64 * 1024;
const NEW_FILE_QUOTE_BYTES: usize = 1500;

/// Left out of what Copilot sees. Lockfiles change by thousands of lines and say
/// nothing about the change; `.env` files and the local backend's state hold
/// secret values, which never leave this computer this way.
const LEFT_OUT: [&str; 6] = [
  ":(exclude,glob)**/package-lock.json",
  ":(exclude,glob)**/pnpm-lock.yaml",
  ":(exclude,glob)**/yarn.lock",
  ":(exclude,glob)**/.env",
  ":(exclude,glob)**/.env.*",
  ":(exclude,glob)**/.rayfin-local/**",
];

const PROMPT: &str = "Write a git commit message for the changes below.

Rules:
- One line of at most 72 characters, in the imperative mood, such as \"Add a chart of this month's expenses\".
- Say what changed for the app or the people using it, not which files changed.
- No prefix such as \"feat:\", no trailing period, no quotes and no code fences.
- Reply with that one line and nothing else.
";

async fn git(dir: &str, args: &[&str]) -> Option<String> {
  let mut full = vec!["-c", "core.quotepath=false"];
  full.extend_from_slice(args);
  let res = run(
    &full,
    RunOptions { cwd: Some(PathBuf::from(dir)), timeout_ms: Some(30_000), ..Default::default() },
  )
  .await;
  res.ok.then_some(res.stdout)
}

/// A file or folder whose contents stay out of the prompt (see [`LEFT_OUT`]).
fn private(path: &str) -> bool {
  let name = path.rsplit('/').next().unwrap_or(path);
  name == ".env" || name.starts_with(".env.") || path.split('/').any(|part| part == ".rayfin-local")
}

/// The start of a small new text file, or `None` when it's large, binary or private.
fn new_file_head(root: &Path, rel: &str) -> Option<String> {
  if private(rel) {
    return None;
  }
  let path = root.join(rel);
  let meta = std::fs::symlink_metadata(&path).ok()?;
  if !meta.is_file() || meta.len() > NEW_FILE_MAX_BYTES {
    return None;
  }
  let bytes = std::fs::read(&path).ok()?;
  if looks_binary(&bytes) {
    return None;
  }
  let text = String::from_utf8_lossy(&bytes);
  let mut cut = NEW_FILE_QUOTE_BYTES.min(text.len());
  while !text.is_char_boundary(cut) {
    cut -= 1;
  }
  Some(text[..cut].to_string())
}

/// Append `text` while it fits in `budget`; a cut is marked. False once full.
fn push_within(out: &mut String, text: &str, budget: usize) -> bool {
  let room = budget.saturating_sub(out.len());
  if text.len() <= room {
    out.push_str(text);
    return true;
  }
  let mut cut = room;
  while !text.is_char_boundary(cut) {
    cut -= 1;
  }
  out.push_str(&text[..cut]);
  out.push_str("\n[cut short]\n");
  false
}

/// The changes as the prompt gives them: the status, the diff, then new files.
fn compose(status: &str, diff: &str, new_files: &[(String, String)], budget: usize) -> String {
  let mut out = String::new();
  let mut parts = vec![("Changed files (git status --porcelain):\n".to_string(), status.to_string())];
  if !diff.trim().is_empty() {
    parts.push(("\nDiff:\n".to_string(), diff.to_string()));
  }
  for (path, head) in new_files {
    parts.push((format!("\nNew file {path}, from the start:\n"), head.clone()));
  }
  for (heading, body) in parts {
    if !push_within(&mut out, &heading, budget) || !push_within(&mut out, &body, budget) {
      break;
    }
  }
  out
}

/// What committing everything would take, for the prompt. Empty when there's nothing to commit.
async fn pending_changes(dir: &str) -> String {
  let status = git(dir, &["status", "--porcelain=v1", "--untracked-files=all", "--", "."])
    .await
    .unwrap_or_default();
  if status.trim().is_empty() {
    return String::new();
  }
  let has_head = git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]).await.is_some();
  let diff = if has_head {
    let mut args = vec!["diff", "HEAD", "--no-color", "--no-ext-diff", "--unified=2", "--", "."];
    args.extend(LEFT_OUT);
    git(dir, &args).await.unwrap_or_default()
  } else {
    String::new()
  };
  // Porcelain paths are relative to the repository's root, which a team app's folder is inside.
  let root = git(dir, &["rev-parse", "--show-toplevel"])
    .await
    .map(|top| PathBuf::from(top.trim()))
    .unwrap_or_else(|| PathBuf::from(dir));
  let new_files: Vec<(String, String)> = status
    .lines()
    .filter_map(|line| line.strip_prefix("?? "))
    .map(|path| path.trim().trim_matches('"').to_string())
    .filter_map(|path| new_file_head(&root, &path).map(|head| (path, head)))
    .take(MAX_NEW_FILES)
    .collect();
  compose(&status, &diff, &new_files, CHANGES_BUDGET)
}

/// The subject line in the model's reply: its first line of text, without a
/// code fence, quotes, a label such as "Subject:", or a trailing period.
fn subject_line(reply: &str) -> Option<String> {
  let body = match reply.split("```").nth(1) {
    Some(fenced) => match fenced.split_once('\n') {
      Some((tag, rest)) if !tag.trim().contains(' ') && tag.trim().len() <= 12 => rest,
      _ => fenced,
    },
    None => reply,
  };
  let line = body.lines().map(str::trim).find(|line| !line.is_empty())?;
  let unquote = |s: &str| {
    s.trim()
      .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '*' | '“' | '”'))
      .trim()
      .to_string()
  };
  let mut line = unquote(line);
  for label in ["commit message:", "subject:", "message:"] {
    let labelled = line.get(..label.len()).is_some_and(|head| head.eq_ignore_ascii_case(label));
    if labelled {
      line = unquote(&line[label.len()..]);
    }
  }
  let words = line.trim_end_matches('.').split_whitespace().collect::<Vec<_>>().join(" ");
  (!words.is_empty()).then(|| words.chars().take(MAX_SUBJECT_CHARS).collect())
}

fn failed(error: impl Into<String>) -> GitMessageResult {
  GitMessageResult { ok: false, message: None, error: Some(error.into()) }
}

/// Write a commit message for everything a project's commit would take, with
/// Copilot's Auto model.
#[tauri::command]
pub async fn projects_git_message(
  state: State<'_, AppState>,
  id: String,
) -> Result<GitMessageResult, String> {
  let Some(project) = find_project(&id) else {
    return Ok(failed("Project folder not found."));
  };
  if !Path::new(&project.path).exists() {
    return Ok(failed("Project folder not found."));
  }
  let changes = pending_changes(&project.path).await;
  if changes.is_empty() {
    return Ok(failed("There's nothing to commit."));
  }
  let prompt = format!("{PROMPT}\n{changes}");
  let reply =
    crate::commands::design::run_transient(state.inner(), &project.path, None, None, prompt, &[], None).await;
  Ok(match reply {
    Ok(reply) => match subject_line(&reply) {
      Some(message) => GitMessageResult { ok: true, message: Some(message), error: None },
      None => failed("Copilot didn't write a message. Please try again."),
    },
    Err(error) => failed(format!("Couldn't write a message: {error}")),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_subject_line_is_the_reply_without_its_wrapping() {
    assert_eq!(subject_line("Add a chart of this month's expenses").as_deref(), Some("Add a chart of this month's expenses"));
    assert_eq!(subject_line("\"Fix the sign-in button.\"\n").as_deref(), Some("Fix the sign-in button"));
    assert_eq!(subject_line("```text\nShow totals by category\n```").as_deref(), Some("Show totals by category"));
    assert_eq!(subject_line("```\nShow totals by category\n```").as_deref(), Some("Show totals by category"));
    assert_eq!(subject_line("Subject: `Rename the app`").as_deref(), Some("Rename the app"));
    assert_eq!(subject_line("\n\nAdd search\n\nIt filters by name.").as_deref(), Some("Add search"));
    assert_eq!(subject_line("  \n ``` \n").as_deref(), None);
    assert_eq!(subject_line(&"word ".repeat(40)).map(|s| s.chars().count()), Some(MAX_SUBJECT_CHARS));
  }

  #[test]
  fn the_changes_stay_within_the_budget_and_say_where_they_were_cut() {
    let status = "M  src/App.tsx\n?? src/Chart.tsx\n";
    let diff = format!("diff --git a/src/App.tsx b/src/App.tsx\n{}", "+line\n".repeat(100));
    let new_files = vec![("src/Chart.tsx".to_string(), "export function Chart() {}\n".to_string())];

    let all = compose(status, &diff, &new_files, 10_000);
    assert!(all.contains("M  src/App.tsx") && all.contains("+line") && all.contains("New file src/Chart.tsx"));

    let cut = compose(status, &diff, &new_files, 200);
    assert!(cut.len() <= 200 + "\n[cut short]\n".len());
    assert!(cut.contains("M  src/App.tsx") && cut.ends_with("[cut short]\n"));
    assert!(!cut.contains("New file"));
  }

  #[test]
  fn secrets_and_local_state_stay_out_of_the_prompt() {
    assert!(private(".env") && private("rayfin/.env") && private("rayfin/.env.local"));
    assert!(private(".rayfin-local/db.sqlite") && private("app/.rayfin-local/keys/secret.json"));
    assert!(!private("src/env.ts") && !private("docs/.environment.md"));
  }
}
