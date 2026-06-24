//! Experimental "side threads": parallel forks of a project that background
//! Copilot agents work in isolation. Each thread is a git branch checked out in
//! a linked worktree (kept outside the project dir, under the app data dir) so
//! two agents never touch the same files. A thread shares the main project's
//! `node_modules` via a directory junction, and carries its own Copilot session
//! id + chat transcript.
//!
//! Lifecycle: create → (agent works in the worktree) → merge into the project's
//! main branch (Copilot resolves conflicts) → worktree + branch are removed.
//!
//! Faithful Rust port of `src/main/services/threads.ts` + `merge.ts`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::commands::chat;
use crate::commands::util::now_iso;
use crate::services::emit::emit_chat_event;
use crate::services::exec::{self, RunOptions};
use crate::services::history::{self, MAIN_THREAD_ID};
use crate::services::{paths, store};
use crate::state::AppState;
use crate::types::{ChatEvent, CreateThreadInput, MergeResult, ProjectThread, ThreadActionResult};

/// Identity used for Fabricator's own commits (matches deploys / history).
const COMMIT_IDENT: [&str; 4] = [
  "-c",
  "user.name=Rayfin Fabricator",
  "-c",
  "user.email=fabricator@rayfin.local",
];

/// Run git in a directory, returning (ok, stdout, stderr). Never throws.
async fn git(cwd: &str, args: &[&str]) -> (bool, String, String) {
  let mut full: Vec<&str> = vec!["-c", "core.quotepath=false"];
  full.extend_from_slice(args);
  let res = exec::run(
    "git",
    &full,
    RunOptions {
      cwd: Some(PathBuf::from(cwd)),
      timeout_ms: Some(60_000),
      ..Default::default()
    },
  )
  .await;
  (res.ok, res.stdout, res.stderr)
}

/// Root folder holding a project's side-thread worktrees (outside the project).
fn threads_root(project_id: &str) -> PathBuf {
  paths::data_dir().join("worktrees").join(project_id)
}

/// Absolute path to one thread's linked worktree.
fn worktree_path_for(project_id: &str, thread_id: &str) -> PathBuf {
  threads_root(project_id).join(thread_id)
}

/// Confirm a directory is the top of a git work tree.
async fn is_repo(cwd: &str) -> bool {
  let res = git(cwd, &["rev-parse", "--is-inside-work-tree"]).await;
  res.0 && res.1.trim() == "true"
}

/// The branch the project's main worktree is on (None if detached).
async fn current_branch(cwd: &str) -> Option<String> {
  let res = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
  let name = if res.0 { res.1.trim().to_string() } else { String::new() };
  if !name.is_empty() && name != "HEAD" {
    Some(name)
  } else {
    None
  }
}

/// Commit any pending work in a worktree under Fabricator's identity.
async fn commit_pending(cwd: &str, message: &str) {
  let status = git(cwd, &["status", "--porcelain"]).await;
  if !status.0 || status.1.trim().is_empty() {
    return;
  }
  let _ = git(cwd, &["add", "-A"]).await;
  let mut args: Vec<&str> = COMMIT_IDENT.to_vec();
  args.extend(["commit", "-m", message]);
  let _ = git(cwd, &args).await;
}

/// Share the main project's node_modules into a worktree via a junction.
async fn link_node_modules(project_path: &str, worktree_path: &str) {
  let source = Path::new(project_path).join("node_modules");
  let target = Path::new(worktree_path).join("node_modules");
  if !source.exists() || target.exists() {
    return;
  }
  let target_s = target.to_string_lossy().to_string();
  let source_s = source.to_string_lossy().to_string();
  // `mklink /J` creates a directory junction without requiring symlink privilege
  // (unlike std::os::windows::fs::symlink_dir). Non-fatal: the agent can still
  // run without prebuilt deps.
  let _ = exec::run(
    "cmd",
    &["/c", "mklink", "/J", &target_s, &source_s],
    RunOptions::timeout(30_000),
  )
  .await;
}

/// Remove a worktree's node_modules junction without touching the real folder.
fn unlink_node_modules(worktree_path: &str) {
  let target = Path::new(worktree_path).join("node_modules");
  if !target.exists() {
    return;
  }
  // remove_dir removes the junction reparse point itself; it never recurses into
  // (and so never deletes) the linked target. Do this BEFORE any recursive delete
  // of the worktree so we can't follow the link into main's deps.
  let _ = std::fs::remove_dir(&target);
}

/// A project's side threads (persisted list, or empty).
fn project_threads(project_id: &str) -> Vec<ProjectThread> {
  store::find_project(project_id)
    .and_then(|p| p.threads)
    .unwrap_or_default()
}

/// Apply a patch to one side thread and persist; returns the full list.
fn patch_thread(
  project_id: &str,
  thread_id: &str,
  patch: impl FnOnce(&mut ProjectThread),
) -> Vec<ProjectThread> {
  let mut threads = project_threads(project_id);
  if let Some(t) = threads.iter_mut().find(|t| t.id == thread_id) {
    patch(t);
  }
  store::set_threads(project_id, threads.clone());
  threads
}

/// Fork a new side thread: a branch + linked worktree + its own Copilot session.
async fn create_thread(input: CreateThreadInput) -> ThreadActionResult {
  let project = store::find_project(&input.project_id);
  let existing = project.as_ref().and_then(|p| p.threads.clone()).unwrap_or_default();
  let Some(project) = project else {
    return ThreadActionResult {
      ok: false,
      error: Some("Project not found.".into()),
      thread: None,
      threads: existing,
    };
  };

  let trimmed = input.name.trim();
  let name = if trimmed.is_empty() { "Side thread".to_string() } else { trimmed.to_string() };
  let cwd = project.path.clone();

  if !is_repo(&cwd).await {
    return ThreadActionResult {
      ok: false,
      error: Some("This project isn\u{2019}t tracked by git, so it can\u{2019}t be forked.".into()),
      thread: None,
      threads: existing,
    };
  }

  let Some(base_branch) = current_branch(&cwd).await else {
    return ThreadActionResult {
      ok: false,
      error: Some("The project is in a detached git state; switch to a branch first.".into()),
      thread: None,
      threads: existing,
    };
  };

  commit_pending(&cwd, &format!("Checkpoint before forking side thread: {name}")).await;
  let head_res = git(&cwd, &["rev-parse", "HEAD"]).await;
  let base_commit = if head_res.0 { head_res.1.trim().to_string() } else { String::new() };
  if base_commit.is_empty() {
    return ThreadActionResult {
      ok: false,
      error: Some("The project has no commits yet to fork from.".into()),
      thread: None,
      threads: existing,
    };
  }

  let thread_id = Uuid::new_v4().to_string();
  let branch = format!("fabricator/thread-{}", &thread_id[..8]);
  let worktree_path = worktree_path_for(&input.project_id, &thread_id);
  if let Err(e) = std::fs::create_dir_all(threads_root(&input.project_id)) {
    log::warn!("failed to create threads dir for {}: {e}", input.project_id);
  }

  let worktree_str = worktree_path.to_string_lossy().to_string();
  let add = git(&cwd, &["worktree", "add", "-b", &branch, &worktree_str, &base_commit]).await;
  if !add.0 {
    let error = if !add.2.trim().is_empty() {
      add.2.trim().to_string()
    } else {
      "Could not create the side-thread workspace.".to_string()
    };
    return ThreadActionResult {
      ok: false,
      error: Some(error),
      thread: None,
      threads: existing,
    };
  }

  link_node_modules(&cwd, &worktree_str).await;

  let thread = ProjectThread {
    id: thread_id,
    name,
    branch,
    worktree_path: worktree_str,
    copilot_session_id: Some(Uuid::new_v4().to_string()),
    status: "active".into(),
    base_branch,
    base_commit,
    created_at: now_iso(),
    merged_at: None,
    merge_commit: None,
    last_error: None,
  };

  let mut threads = existing;
  threads.push(thread.clone());
  store::set_threads(&input.project_id, threads.clone());
  ThreadActionResult {
    ok: true,
    error: None,
    thread: Some(thread),
    threads,
  }
}

/// Tear down a thread's worktree + branch (used on discard and after merge).
async fn destroy_worktree(project_path: &str, worktree_path: &str, branch: &str) {
  unlink_node_modules(worktree_path);
  let _ = git(project_path, &["worktree", "remove", "--force", worktree_path]).await;
  if Path::new(worktree_path).exists() {
    let _ = std::fs::remove_dir_all(worktree_path);
  }
  let _ = git(project_path, &["worktree", "prune"]).await;
  let _ = git(project_path, &["branch", "-D", branch]).await;
}

/// Discard a side thread entirely: its worktree, branch, and transcript.
async fn remove_thread(project_id: &str, thread_id: &str) -> ThreadActionResult {
  let Some(project) = store::find_project(project_id) else {
    return ThreadActionResult {
      ok: false,
      error: Some("Project not found.".into()),
      thread: None,
      threads: vec![],
    };
  };
  let existing = project.threads.clone().unwrap_or_default();
  let Some(thread) = existing.iter().find(|t| t.id == thread_id).cloned() else {
    return ThreadActionResult {
      ok: true,
      error: None,
      thread: None,
      threads: existing,
    };
  };

  destroy_worktree(&project.path, &thread.worktree_path, &thread.branch).await;
  history::clear_history(project_id, Some(thread_id));
  let remaining: Vec<ProjectThread> = existing.into_iter().filter(|t| t.id != thread_id).collect();
  store::set_threads(project_id, remaining.clone());
  ThreadActionResult {
    ok: true,
    error: None,
    thread: None,
    threads: remaining,
  }
}

/// Remove every side thread of a project (used when the project is deleted).
pub async fn remove_all_threads(project_id: &str) {
  let Some(project) = store::find_project(project_id) else {
    return;
  };
  for thread in project.threads.clone().unwrap_or_default() {
    destroy_worktree(&project.path, &thread.worktree_path, &thread.branch).await;
    history::clear_history(project_id, Some(&thread.id));
  }
  let root = threads_root(project_id);
  if root.exists() {
    let _ = std::fs::remove_dir_all(&root);
  }
}

// ── Merge ────────────────────────────────────────────────────────────────────

/// Per-project lock that serializes merges so two threads finishing at once
/// can't stomp each other.
static MERGE_LOCKS: Lazy<std::sync::Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> =
  Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

fn merge_lock(project_id: &str) -> Arc<AsyncMutex<()>> {
  let mut map = MERGE_LOCKS.lock().unwrap();
  map
    .entry(project_id.to_string())
    .or_insert_with(|| Arc::new(AsyncMutex::new(())))
    .clone()
}

/// Files git still considers unmerged (conflicted) in a worktree.
async fn conflicted_files(cwd: &str) -> Vec<String> {
  let res = git(cwd, &["diff", "--name-only", "--diff-filter=U"]).await;
  if res.0 {
    res
      .1
      .split('\n')
      .map(|l| l.trim().to_string())
      .filter(|l| !l.is_empty())
      .collect()
  } else {
    vec![]
  }
}

/// True while a merge is in progress (MERGE_HEAD exists).
async fn is_merging(cwd: &str) -> bool {
  let res = git(cwd, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).await;
  res.0 && !res.1.trim().is_empty()
}

fn fail(project_id: &str, thread_id: &str, error: &str) -> MergeResult {
  let threads = patch_thread(project_id, thread_id, |t| {
    t.status = "error".into();
    t.last_error = Some(error.to_string());
  });
  MergeResult {
    ok: false,
    error: Some(error.to_string()),
    had_conflicts: None,
    merge_commit: None,
    threads,
  }
}

/// Build the conflict-resolution prompt for Copilot.
fn conflict_prompt(name: &str, base_branch: &str, files: &[String]) -> String {
  let mut lines: Vec<String> = vec![
    format!("You are resolving a git merge conflict. The side thread \"{name}\" is being merged into"),
    format!("the \"{base_branch}\" branch and git reported conflicts in these files:"),
    String::new(),
  ];
  for f in files {
    lines.push(format!("  - {f}"));
  }
  lines.push(String::new());
  lines.push("Edit each file to resolve every conflict, keeping BOTH changes working together where".into());
  lines.push("possible. Remove all conflict markers (<<<<<<<, =======, >>>>>>>). Do not run git commit".into());
  lines.push("or git merge \u{2014} just fix the files so the project builds. When done, briefly summarize how".into());
  lines.push("you resolved the conflicts.".into());
  lines.join("\n")
}

static MARKER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)conflict marker").unwrap());

/// Merge a side thread into main, asking Copilot to resolve any conflicts. Runs
/// in the project's main worktree; conflict-resolution progress streams into the
/// MAIN thread chat under turn id `merge-<threadId>`.
async fn do_merge(app: &AppHandle, state: &AppState, project_id: &str, thread_id: &str) -> MergeResult {
  let merge_turn_id = format!("merge-{thread_id}");

  let Some(project) = store::find_project(project_id) else {
    return MergeResult {
      ok: false,
      error: Some("Project not found.".into()),
      had_conflicts: None,
      merge_commit: None,
      threads: vec![],
    };
  };
  let threads_now = project.threads.clone().unwrap_or_default();
  let Some(thread) = threads_now.iter().find(|t| t.id == thread_id).cloned() else {
    return MergeResult {
      ok: false,
      error: Some("Side thread not found.".into()),
      had_conflicts: None,
      merge_commit: None,
      threads: threads_now,
    };
  };
  if thread.status == "merged" {
    return MergeResult {
      ok: true,
      error: None,
      had_conflicts: None,
      merge_commit: thread.merge_commit.clone(),
      threads: threads_now,
    };
  }

  let cwd = project.path.clone();

  // Main worktree must be on the base branch (the side branch is checked out in
  // the thread's own worktree, so main can't already be on it).
  let cur = git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
  if cur.0 && cur.1.trim() != thread.base_branch {
    let checkout = git(&cwd, &["checkout", &thread.base_branch]).await;
    if !checkout.0 {
      return fail(
        project_id,
        thread_id,
        &format!("Couldn\u{2019}t switch to {} to merge.", thread.base_branch),
      );
    }
  }

  patch_thread(project_id, thread_id, |t| {
    t.status = "active".into();
    t.last_error = None;
  });

  // Make sure both sides have their work committed before merging.
  commit_pending(&cwd, "Checkpoint before merging a side thread").await;
  commit_pending(&thread.worktree_path, &format!("Side thread work: {}", thread.name)).await;

  let merge_msg = format!("Merge side thread: {}", thread.name);
  let mut margs: Vec<&str> = COMMIT_IDENT.to_vec();
  margs.extend(["merge", "--no-ff", "-m", merge_msg.as_str(), thread.branch.as_str()]);
  let merge = git(&cwd, &margs).await;

  let mut had_conflicts = false;
  if !merge.0 {
    let files = conflicted_files(&cwd).await;
    if files.is_empty() {
      // Not a conflict (e.g. nothing to merge / other error) — leave main clean.
      let _ = git(&cwd, &["merge", "--abort"]).await;
      let msg = if !merge.2.trim().is_empty() {
        merge.2.trim().to_string()
      } else {
        "The merge could not be completed.".to_string()
      };
      return fail(project_id, thread_id, &msg);
    }

    had_conflicts = true;
    let plural = if files.len() > 1 { "s" } else { "" };
    emit_chat_event(
      app,
      project_id,
      MAIN_THREAD_ID,
      &merge_turn_id,
      ChatEvent::Notice {
        text: format!(
          "Merging \u{201c}{}\u{201d} hit {} conflict{} \u{2014} asking Copilot to resolve\u{2026}",
          thread.name,
          files.len(),
          plural
        ),
      },
    );

    let prompt = conflict_prompt(&thread.name, &thread.base_branch, &files);
    let _ = chat::run_turn(
      app.clone(),
      state,
      project_id.to_string(),
      merge_turn_id.clone(),
      prompt,
      None,
      None,
      None,
    )
    .await;

    // The agent is told NOT to run git, so it edits the working tree but leaves the
    // paths "unmerged" in the index. Check the *working tree* for leftover markers
    // (`--diff-filter=U` would always report unmerged since nothing is staged yet).
    let check = git(&cwd, &["diff", "--check"]).await;
    let markers_remain = !check.0 && MARKER_RE.is_match(&check.1);
    if markers_remain {
      if is_merging(&cwd).await {
        let _ = git(&cwd, &["merge", "--abort"]).await;
      }
      return fail(
        project_id,
        thread_id,
        "Copilot couldn\u{2019}t fully resolve the merge conflicts. The side thread was left intact so you can try again.",
      );
    }

    // Markers are gone — stage the agent's resolution, then confirm nothing is
    // still unmerged before committing.
    let _ = git(&cwd, &["add", "-A"]).await;
    let still_unmerged = conflicted_files(&cwd).await;
    if !still_unmerged.is_empty() {
      if is_merging(&cwd).await {
        let _ = git(&cwd, &["merge", "--abort"]).await;
      }
      return fail(
        project_id,
        thread_id,
        "Copilot couldn\u{2019}t fully resolve the merge conflicts. The side thread was left intact so you can try again.",
      );
    }

    // Finish the merge commit if the agent didn't already commit it.
    if is_merging(&cwd).await {
      let mut cargs: Vec<&str> = COMMIT_IDENT.to_vec();
      cargs.extend(["commit", "--no-edit"]);
      let commit = git(&cwd, &cargs).await;
      if !commit.0 {
        if is_merging(&cwd).await {
          let _ = git(&cwd, &["merge", "--abort"]).await;
        }
        let msg = if !commit.2.trim().is_empty() {
          commit.2.trim().to_string()
        } else {
          "Could not finalize the merge.".to_string()
        };
        return fail(project_id, thread_id, &msg);
      }
    }
  }

  let head_res = git(&cwd, &["rev-parse", "HEAD"]).await;
  let merge_commit = if head_res.0 { Some(head_res.1.trim().to_string()) } else { None };

  // Success: the work now lives on main — tear down the thread's worktree/branch.
  destroy_worktree(&cwd, &thread.worktree_path, &thread.branch).await;
  let threads = patch_thread(project_id, thread_id, |t| {
    t.status = "merged".into();
    t.merged_at = Some(now_iso());
    t.merge_commit = merge_commit.clone();
    t.last_error = None;
  });
  emit_chat_event(
    app,
    project_id,
    MAIN_THREAD_ID,
    &merge_turn_id,
    ChatEvent::Notice {
      text: format!("Merged \u{201c}{}\u{201d} into {}.", thread.name, thread.base_branch),
    },
  );
  MergeResult {
    ok: true,
    error: None,
    had_conflicts: Some(had_conflicts),
    merge_commit,
    threads,
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn threads_list(project_id: String) -> Vec<ProjectThread> {
  project_threads(&project_id)
}

#[tauri::command]
pub async fn threads_create(input: CreateThreadInput) -> ThreadActionResult {
  create_thread(input).await
}

#[tauri::command]
pub async fn threads_remove(project_id: String, thread_id: String) -> ThreadActionResult {
  remove_thread(&project_id, &thread_id).await
}

#[tauri::command]
pub async fn threads_merge(
  app: AppHandle,
  state: State<'_, AppState>,
  project_id: String,
  thread_id: String,
) -> Result<MergeResult, String> {
  // Serialize merges per project (the renderer coalesces the post-merge redeploy).
  let lock = merge_lock(&project_id);
  let _guard = lock.lock().await;
  Ok(do_merge(&app, state.inner(), &project_id, &thread_id).await)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn conflict_prompt_lists_files_and_rules() {
    let p = conflict_prompt("My Thread", "main", &["a.ts".into(), "b/c.ts".into()]);
    assert!(p.contains("side thread \"My Thread\" is being merged into"));
    assert!(p.contains("the \"main\" branch"));
    assert!(p.contains("  - a.ts"));
    assert!(p.contains("  - b/c.ts"));
    assert!(p.contains("Remove all conflict markers"));
    assert!(p.contains("Do not run git commit"));
  }

  #[test]
  fn branch_name_uses_first_8_of_uuid() {
    let id = "abcdef12-3456-7890-abcd-ef1234567890";
    let branch = format!("fabricator/thread-{}", &id[..8]);
    assert_eq!(branch, "fabricator/thread-abcdef12");
  }

  #[test]
  fn marker_regex_is_case_insensitive() {
    assert!(MARKER_RE.is_match("error: leftover conflict marker in foo"));
    assert!(MARKER_RE.is_match("CONFLICT MARKER"));
    assert!(!MARKER_RE.is_match("all clean"));
  }
}
