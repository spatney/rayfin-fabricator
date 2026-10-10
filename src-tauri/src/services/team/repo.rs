//! Local git for team workspaces. Each workspace folder holds a clone of the
//! team repo without a checkout (`.repo`) plus one worktree per opened project,
//! sparse-checked out to that project's folder (and the repo's root files), so
//! several team projects can be open at once, each on its own branch:
//!
//! ```text
//! <workspace dir>/.repo/                 clone, nothing checked out (origin = GitHub)
//! <workspace dir>/<folder>/              worktree on the session branch
//! <workspace dir>/<folder>/<folder>/     the Rayfin project Fabricator opens
//! ```
//!
//! The clone isn't bare: git refuses implicit bare repositories when
//! `safe.bareRepository=explicit` is configured.
//!
//! Network operations authenticate with the GitHub CLI's sign-in through
//! per-command `-c credential.helper=…` arguments (see [`gh::git_credential_args`]),
//! and every change is limited to the project's folder with a pathspec.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use super::gh;
use crate::services::exec::{OnData, RunOptions, RunResult};
use crate::services::git;
use crate::services::project_layout::{is_under, ProjectLayout};
use crate::types::TeamWorkspace;

const CLONE_DIR: &str = ".repo";

pub fn clone_dir(workspace: &TeamWorkspace) -> PathBuf {
  Path::new(&workspace.dir).join(CLONE_DIR)
}

pub fn worktree_dir(workspace: &TeamWorkspace, folder: &str) -> PathBuf {
  Path::new(&workspace.dir).join(folder)
}

pub fn project_dir(workspace: &TeamWorkspace, folder: &str) -> PathBuf {
  worktree_dir(workspace, folder).join(folder)
}

pub fn remote_url(full_name: &str) -> String {
  format!("https://github.com/{full_name}.git")
}

/// The git subcommand in `args`, after options such as `-c name=value`.
fn subcommand<'a>(args: &[&'a str]) -> Option<&'a str> {
  let mut iter = args.iter();
  while let Some(arg) = iter.next() {
    if matches!(*arg, "-c" | "-C") {
      iter.next();
    } else if !arg.starts_with('-') {
      return Some(arg);
    }
  }
  None
}

/// Whether git talks to GitHub (and so asks the credential helper) for `args`.
fn reaches_github(args: &[&str]) -> bool {
  matches!(subcommand(args), Some("clone" | "fetch" | "push" | "pull" | "ls-remote"))
}

/// Run git in `dir` with gh-backed credentials (for the account the current
/// task acts as) and no interactive prompts.
async fn git_in(dir: &Path, args: &[&str], timeout_ms: u64, on: Option<OnData>) -> RunResult {
  let mut full: Vec<String> = gh::git_credential_args();
  full.extend(args.iter().map(|s| s.to_string()));
  let refs: Vec<&str> = full.iter().map(String::as_str).collect();
  let mut env = vec![
    ("GIT_TERMINAL_PROMPT".into(), "0".into()),
    ("GCM_INTERACTIVE".into(), "Never".into()),
    ("GH_HOST".into(), "github.com".into()),
    ("GH_PROMPT_DISABLED".into(), "1".into()),
  ];
  // Local commands never ask for credentials, so they work even when the
  // workspace's account isn't signed in.
  if reaches_github(args) {
    match gh::account_token().await {
      Ok(Some(token)) => env.push(("GH_TOKEN".into(), token)),
      Ok(None) => {}
      Err(e) => {
        return RunResult {
          ok: false,
          exit_code: None,
          stdout: String::new(),
          stderr: format!("Authentication failed: {}", e.message),
          not_found: false,
        }
      }
    }
  }
  git::run(
    &refs,
    RunOptions {
      cwd: Some(dir.to_path_buf()),
      env,
      env_remove: vec!["GH_TOKEN".into(), "GITHUB_TOKEN".into()],
      on_data: on,
      timeout_ms: Some(timeout_ms),
      ..Default::default()
    },
  )
  .await
}

fn failure(action: &str, res: &RunResult) -> String {
  if res.not_found {
    return format!("{action}: git isn't installed.");
  }
  let detail = res
    .stderr
    .lines()
    .chain(res.stdout.lines())
    .map(str::trim)
    .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
    .take(4)
    .collect::<Vec<_>>()
    .join(" ");
  if detail.to_ascii_lowercase().contains("authentication failed") || detail.contains("could not read Username") {
    return match gh::current_account() {
      Some(login) => format!("{action}: GitHub didn't accept the GitHub CLI's sign-in for {login}. Sign in to GitHub as {login} again, then retry."),
      None => format!("{action}: GitHub sign-in is required. Sign in to GitHub again, then retry."),
    };
  }
  // A lock held for longer than [`git::run`] waits it out. Git's own wording
  // ("Another git process seems to be running…") means nothing to the people
  // using Fabricator.
  if git::is_lock_failure(&detail) {
    return format!("{action}: something else on this computer is using this app's folder. Wait a moment, then try again.");
  }
  if detail.is_empty() {
    format!("{action} failed.")
  } else {
    format!("{action}: {detail}")
  }
}

async fn git_ok(dir: &Path, args: &[&str], action: &str) -> Result<String, String> {
  let res = git_in(dir, args, 120_000, None).await;
  if res.ok {
    Ok(res.stdout)
  } else {
    Err(failure(action, &res))
  }
}

/// Create the team repo's first commit from `files` and push it to `main`.
pub async fn seed_repository(full_name: &str, files: &[(String, String)], name: &str, email: &str) -> Result<(), String> {
  let tmp = std::env::temp_dir().join(format!("fabricator-seed-{}", uuid::Uuid::new_v4()));
  std::fs::create_dir_all(&tmp).map_err(|e| format!("Couldn't prepare the repository: {e}"))?;
  let result = async {
    git_ok(&tmp, &["init", "-q", "-b", "main"], "Prepare the repository").await?;
    for (rel, content) in files {
      let path = tmp.join(rel);
      if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't write {rel}: {e}"))?;
      }
      std::fs::write(&path, content).map_err(|e| format!("Couldn't write {rel}: {e}"))?;
    }
    git_ok(&tmp, &["add", "-A"], "Prepare the repository").await?;
    git_ok(
      &tmp,
      &["-c", &format!("user.name={name}"), "-c", &format!("user.email={email}"), "commit", "-q", "-m", "Set up Fabricator team workspace"],
      "Create the first commit",
    )
    .await?;
    let url = remote_url(full_name);
    let res = git_in(&tmp, &["push", &url, "main"], 300_000, None).await;
    if res.ok {
      Ok(())
    } else {
      Err(failure("Push the workspace to GitHub", &res))
    }
  }
  .await;
  let _ = std::fs::remove_dir_all(&tmp);
  result
}

/// Clone the team repo (without a checkout) when missing, then fetch.
pub async fn ensure_clone(workspace: &TeamWorkspace, on: Option<OnData>) -> Result<(), String> {
  let dir = clone_dir(workspace);
  if !dir.join(".git").exists() {
    std::fs::create_dir_all(&workspace.dir).map_err(|e| format!("Couldn't create {}: {e}", workspace.dir))?;
    let _ = std::fs::remove_dir_all(&dir);
    let target = dir.to_string_lossy().to_string();
    let url = remote_url(&workspace.repo);
    let res = git_in(Path::new(&workspace.dir), &["clone", "--no-checkout", "--quiet", &url, &target], 600_000, on).await;
    if !res.ok {
      let _ = std::fs::remove_dir_all(&dir);
      return Err(failure("Download the team workspace", &res));
    }
  }
  fetch(workspace).await
}

pub async fn fetch(workspace: &TeamWorkspace) -> Result<(), String> {
  let res = git_in(&clone_dir(workspace), &["fetch", "--prune", "--quiet", "origin"], 300_000, None).await;
  if res.ok {
    Ok(())
  } else {
    Err(failure("Get the team's latest changes", &res))
  }
}

/// Attribute commits in this workspace to the GitHub user.
pub async fn set_identity(workspace: &TeamWorkspace, name: &str, email: &str) -> Result<(), String> {
  let dir = clone_dir(workspace);
  git_ok(&dir, &["config", "user.name", name], "Set your git name").await?;
  git_ok(&dir, &["config", "user.email", email], "Set your git email").await?;
  Ok(())
}

/// A file from the published `main`, or `None` when it doesn't exist.
pub async fn read_main_file(workspace: &TeamWorkspace, path: &str) -> Result<Option<String>, String> {
  let spec = format!("origin/main:{path}");
  let res = git_in(&clone_dir(workspace), &["show", &spec], 60_000, None).await;
  if res.ok {
    Ok(Some(res.stdout))
  } else if res.stderr.contains("does not exist") || res.stderr.contains("exists on disk, but not in") || res.stderr.contains("invalid object name") {
    Ok(None)
  } else {
    Err(failure("Read the team workspace", &res))
  }
}

/// Project folders on `main` (folders with `rayfin/rayfin.yml`): (folder, name).
pub async fn list_projects(workspace: &TeamWorkspace) -> Result<Vec<(String, String)>, String> {
  let out = git_ok(&clone_dir(workspace), &["ls-tree", "-r", "--name-only", "origin/main"], "List the team's apps").await?;
  let mut projects = Vec::new();
  for folder in project_folders(&out) {
    let yml = read_main_file(workspace, &format!("{folder}/rayfin/rayfin.yml")).await?.unwrap_or_default();
    let name = yaml_name(&yml).unwrap_or_else(|| folder.clone());
    projects.push((folder, name));
  }
  Ok(projects)
}

/// The files the overview's data view reads from an app (project-relative):
/// `rayfin.yml`, the data model, and the functions' source, wherever `layout`
/// says they are.
pub fn is_app_config(path: &str, layout: &ProjectLayout) -> bool {
  let lower = path.to_ascii_lowercase();
  if lower == "rayfin/rayfin.yml" || lower == "rayfin/rayfin.yaml" {
    return true;
  }
  if lower.split('/').any(|part| part == "node_modules" || part == "dist") {
    return false;
  }
  lower.ends_with(".ts")
    && !lower.ends_with(".d.ts")
    && [layout.data_dir.to_ascii_lowercase(), layout.functions_src().to_ascii_lowercase()]
      .iter()
      .any(|dir| is_under(&lower, dir))
}

/// At most this many config files per app, each at most this big.
const MAX_CONFIG_FILES: usize = 150;
const MAX_CONFIG_BYTES: usize = 256 * 1024;

/// Config files rebuilt from `git grep -z -e "" <tree> -- …`, whose every
/// line reads `<tree>:<path>\0<text>`. Paths come back project-relative; the
/// flag is true when a file was left out for size.
fn config_from_grep(output: &str, tree: &str, folder: &str, layout: &ProjectLayout) -> (BTreeMap<String, String>, bool) {
  let prefix = format!("{tree}:{folder}/");
  let mut files: BTreeMap<String, String> = BTreeMap::new();
  let mut dropped: BTreeSet<String> = BTreeSet::new();
  for line in output.split('\n') {
    let Some((name, text)) = line.split_once('\0') else { continue };
    let Some(path) = name.strip_prefix(&prefix) else { continue };
    if !is_app_config(path, layout) || dropped.contains(path) {
      continue;
    }
    let size = files.get(path).map(String::len);
    let too_many = size.is_none() && files.len() >= MAX_CONFIG_FILES;
    if too_many || size.unwrap_or(0) + text.len() + 1 > MAX_CONFIG_BYTES {
      files.remove(path);
      dropped.insert(path.to_string());
      continue;
    }
    let file = files.entry(path.to_string()).or_default();
    file.push_str(text);
    file.push('\n');
  }
  (files, !dropped.is_empty())
}

/// An app's config files at `tree` in the team clone: `origin/main`, or a
/// working copy's `origin/<branch>`. The flag is true when some were left out.
pub async fn read_app_config(workspace: &TeamWorkspace, tree: &str, folder: &str) -> Result<(BTreeMap<String, String>, bool), String> {
  let dir = clone_dir(workspace);
  // rayfin.yml says where the data model and functions live.
  let mut layout = ProjectLayout::default();
  for name in ["rayfin.yml", "rayfin.yaml"] {
    let spec = format!("{tree}:{folder}/rayfin/{name}");
    let res = git_in(&dir, &["show", &spec], 60_000, None).await;
    if res.ok {
      layout = ProjectLayout::parse(&res.stdout);
      break;
    }
  }
  let specs = [
    format!("{folder}/rayfin/rayfin.yml"),
    format!("{folder}/rayfin/rayfin.yaml"),
    format!("{folder}/{}", layout.data_dir),
    format!("{folder}/{}", layout.functions_src()),
  ];
  // Every line of every file, each prefixed with its path (and no line numbers,
  // whatever the user's git config says).
  let mut args = vec!["-c", "grep.lineNumber=false", "-c", "grep.column=false", "grep", "--no-color", "-I", "-z", "-e", "", tree, "--"];
  args.extend(specs.iter().map(String::as_str));
  let res = git_in(&dir, &args, 60_000, None).await;
  // `git grep` exits with 1 when nothing matched: the app has none of these files.
  if res.ok || (res.exit_code == Some(1) && res.stderr.trim().is_empty()) {
    Ok(config_from_grep(&res.stdout, tree, folder, &layout))
  } else {
    Err(failure("Read the app's settings", &res))
  }
}

/// The same config files from an app's folder on disk: your working copy,
/// unsaved edits included.
pub fn read_app_config_on_disk(project_dir: &Path) -> (BTreeMap<String, String>, bool) {
  fn add(files: &mut BTreeMap<String, String>, dropped: &mut bool, path: &Path, rel: String) {
    let small = std::fs::metadata(path).is_ok_and(|m| m.len() as usize <= MAX_CONFIG_BYTES);
    if files.len() >= MAX_CONFIG_FILES || !small {
      *dropped = true;
    } else if let Ok(text) = std::fs::read_to_string(path) {
      files.insert(rel, text);
    }
  }
  fn walk(
    root: &Path,
    dir: &Path,
    depth: usize,
    layout: &ProjectLayout,
    files: &mut BTreeMap<String, String>,
    dropped: &mut bool,
  ) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
      let path = entry.path();
      let Ok(rel) = path.strip_prefix(root) else { continue };
      let rel = rel.to_string_lossy().replace('\\', "/");
      let Ok(kind) = entry.file_type() else { continue };
      if kind.is_dir() {
        if depth > 0 {
          walk(root, &path, depth - 1, layout, files, dropped);
        }
      } else if kind.is_file() && is_app_config(&rel, layout) {
        add(files, dropped, &path, rel);
      }
    }
  }
  let layout = ProjectLayout::read(project_dir);
  let mut files = BTreeMap::new();
  let mut dropped = false;
  for name in ["rayfin/rayfin.yml", "rayfin/rayfin.yaml"] {
    let path = project_dir.join(name);
    if path.is_file() {
      add(&mut files, &mut dropped, &path, name.to_string());
    }
  }
  for dir in [layout.data_dir.clone(), layout.functions_src()] {
    walk(project_dir, &project_dir.join(&dir), 4, &layout, &mut files, &mut dropped);
  }
  (files, dropped)
}

/// Folders holding a Rayfin project, from `git ls-tree -r --name-only` output.
fn project_folders(listing: &str) -> Vec<String> {
  let mut folders: Vec<String> = listing
    .lines()
    .filter_map(|l| l.trim().strip_suffix("/rayfin/rayfin.yml"))
    .filter(|f| !f.is_empty() && !f.contains('/'))
    .map(String::from)
    .collect();
  folders.sort();
  folders.dedup();
  folders
}

/// The `name:` in a rayfin.yml.
fn yaml_name(yml: &str) -> Option<String> {
  let value: serde_yaml::Value = serde_yaml::from_str(yml).ok()?;
  value.get("name")?.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// True when `origin/<branch>` exists.
pub async fn remote_branch_exists(workspace: &TeamWorkspace, branch: &str) -> bool {
  let reference = format!("refs/remotes/origin/{branch}");
  git_in(&clone_dir(workspace), &["rev-parse", "--verify", "--quiet", &reference], 30_000, None).await.ok
}

/// Create the project's worktree on `branch`. A new branch starts from the
/// published `main`; an existing remote branch is resumed (tracking it).
pub async fn add_worktree(workspace: &TeamWorkspace, folder: &str, branch: &str, resume: bool) -> Result<PathBuf, String> {
  let wt = worktree_dir(workspace, folder);
  let target = wt.to_string_lossy().to_string();
  let clone = clone_dir(workspace);
  // A stale registration (folder deleted by hand) would block the add.
  let _ = git_in(&clone, &["worktree", "prune"], 30_000, None).await;
  let start = if resume { format!("origin/{branch}") } else { "origin/main".to_string() };
  let mut args = vec!["worktree", "add", "--no-checkout"];
  if !resume {
    args.push("--no-track");
  }
  args.extend(["-B", branch, &target, &start]);
  git_ok(&clone, &args, "Prepare the project folder").await?;
  git_ok(&wt, &["sparse-checkout", "set", "--cone", folder], "Limit the checkout to this app").await?;
  git_ok(&wt, &["checkout", "--quiet"], "Check out the app").await?;
  Ok(wt)
}

/// Start a new working branch from the published `main` in an existing worktree.
pub async fn start_branch(worktree: &Path, branch: &str) -> Result<(), String> {
  git_ok(worktree, &["switch", "--quiet", "--no-track", "-C", branch, "origin/main"], "Start a new working branch").await.map(|_| ())
}

pub async fn current_branch(worktree: &Path) -> Option<String> {
  let res = git_in(worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"], 30_000, None).await;
  res.ok.then(|| res.stdout.trim().to_string()).filter(|b| !b.is_empty())
}

pub async fn head(worktree: &Path) -> Option<String> {
  let res = git_in(worktree, &["rev-parse", "HEAD"], 30_000, None).await;
  res.ok.then(|| res.stdout.trim().to_string()).filter(|s| !s.is_empty())
}

/// Commit every change in the project folder (and, while concluding a merge,
/// the merge's conflicted files). Returns false when there was nothing to commit.
pub async fn commit_folder(worktree: &Path, folder: &str, message: &str) -> Result<bool, String> {
  let merging = in_merge(worktree).await;
  let conflicted = if merging { conflicted_files(worktree).await } else { Vec::new() };
  let mut add = vec!["add", "-A", "--", folder];
  add.extend(conflicted.iter().map(String::as_str));
  git_ok(worktree, &add, "Save your changes").await?;
  let staged = git_in(worktree, &["diff", "--cached", "--quiet"], 60_000, None).await;
  // A pending merge commit still needs concluding even without new edits.
  if staged.ok && !merging {
    return Ok(false);
  }
  git_ok(worktree, &["commit", "--quiet", "--no-verify", "-m", message], "Save your changes").await?;
  Ok(true)
}

/// Push the branch to GitHub, setting its upstream.
pub async fn push(worktree: &Path, branch: &str) -> Result<(), String> {
  let res = git_in(worktree, &["push", "--quiet", "-u", "origin", branch], 300_000, None).await;
  if res.ok {
    Ok(())
  } else {
    Err(failure("Save your work to GitHub", &res))
  }
}

/// Uncommitted edits in the project folder.
pub async fn is_dirty(worktree: &Path, folder: &str) -> bool {
  let res = git_in(worktree, &["status", "--porcelain", "--", folder], 60_000, None).await;
  res.ok && !res.stdout.trim().is_empty()
}

/// What this working copy changes in the app folder compared with the published
/// `main`: committed, unsaved and new files.
pub async fn local_changes(worktree: &Path, folder: &str) -> Vec<crate::types::TeamMapFile> {
  let numstat = git_in(worktree, &["diff", "--no-renames", "--numstat", "-z", "origin/main", "--", folder], 60_000, None).await;
  let status = git_in(worktree, &["diff", "--no-renames", "--name-status", "-z", "origin/main", "--", folder], 60_000, None).await;
  let untracked = untracked_files(worktree, folder).await;
  merge_changes(&numstat.stdout, &status.stdout, &untracked, |path| count_lines(&worktree.join(path)))
}

/// New files in the app folder that git doesn't track yet.
pub async fn untracked_files(worktree: &Path, folder: &str) -> Vec<String> {
  let res = git_in(worktree, &["ls-files", "--others", "--exclude-standard", "-z", "--", folder], 60_000, None).await;
  res.stdout.split('\0').map(str::trim).filter(|p| !p.is_empty()).map(String::from).collect()
}

/// Unified diff of the working copy against the published `main` for the app
/// folder (tracked files only; see [`untracked_files`]).
pub async fn local_diff(worktree: &Path, folder: &str) -> String {
  let res = git_in(
    worktree,
    &["diff", "--no-renames", "--no-color", "--no-ext-diff", "origin/main", "--", folder],
    120_000,
    None,
  )
  .await;
  res.stdout
}

/// Lines in a small text file (0 for binary or large files).
fn count_lines(path: &Path) -> u32 {
  match std::fs::metadata(path) {
    Ok(meta) if meta.len() <= 1_000_000 => std::fs::read(path)
      .ok()
      .filter(|bytes| !bytes.contains(&0))
      .map(|bytes| bytes.iter().filter(|b| **b == b'\n').count() as u32 + u32::from(!bytes.is_empty() && !bytes.ends_with(b"\n")))
      .unwrap_or(0),
    _ => 0,
  }
}

/// Combine `git diff --numstat -z`, `--name-status -z` and untracked files.
fn merge_changes(numstat: &str, name_status: &str, untracked: &[String], lines: impl Fn(&str) -> u32) -> Vec<crate::types::TeamMapFile> {
  use crate::types::TeamMapFile;
  let mut kinds = std::collections::HashMap::new();
  let mut parts = name_status.split('\0').filter(|p| !p.is_empty());
  while let (Some(code), Some(path)) = (parts.next(), parts.next()) {
    let kind = match code.chars().next() {
      Some('A') => "added",
      Some('D') => "deleted",
      _ => "modified",
    };
    kinds.insert(path.to_string(), kind);
  }
  let mut files: Vec<TeamMapFile> = numstat
    .split('\0')
    .filter_map(|record| {
      let mut fields = record.splitn(3, '\t');
      let (adds, dels, path) = (fields.next()?, fields.next()?, fields.next()?.trim());
      (!path.is_empty()).then(|| TeamMapFile {
        path: path.to_string(),
        change: kinds.get(path).copied().unwrap_or("modified").to_string(),
        additions: adds.trim().parse().unwrap_or(0),
        deletions: dels.trim().parse().unwrap_or(0),
      })
    })
    .collect();
  for path in untracked {
    if !files.iter().any(|f| &f.path == path) {
      files.push(TeamMapFile { path: path.clone(), change: "added".into(), additions: lines(path), deletions: 0 });
    }
  }
  files.sort_by(|a, b| a.path.cmp(&b.path));
  files
}

pub async fn in_merge(worktree: &Path) -> bool {
  git_in(worktree, &["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], 30_000, None).await.ok
}

async fn count(worktree: &Path, range: &str, folder: &str) -> u32 {
  let res = git_in(worktree, &["rev-list", "--count", range, "--", folder], 60_000, None).await;
  res.stdout.trim().parse().unwrap_or(0)
}

/// (unpublished commits on the branch, teammates' commits on main not yet merged),
/// both limited to the project folder.
pub async fn divergence(worktree: &Path, folder: &str) -> (u32, u32) {
  (count(worktree, "origin/main..HEAD", folder).await, count(worktree, "HEAD..origin/main", folder).await)
}

/// Commits on the branch that GitHub doesn't have yet (all of them when the
/// branch was never pushed).
pub async fn unpushed(worktree: &Path, branch: &str) -> u32 {
  let range = format!("origin/{branch}..HEAD");
  let res = git_in(worktree, &["rev-list", "--count", &range], 60_000, None).await;
  if res.ok {
    res.stdout.trim().parse().unwrap_or(0)
  } else {
    u32::MAX
  }
}

pub enum MergeOutcome {
  UpToDate,
  Merged,
  /// Conflicted files (repo-relative); the merge was aborted unless kept.
  Conflicts(Vec<String>),
}

/// Merge the published `main` into the working branch (fetch first).
pub async fn merge_main(worktree: &Path, keep_conflicts: bool, name: &str, email: &str) -> Result<MergeOutcome, String> {
  if in_merge(worktree).await {
    return Ok(MergeOutcome::Conflicts(conflicted_files(worktree).await));
  }
  let behind = git_in(worktree, &["rev-list", "--count", "HEAD..origin/main"], 60_000, None).await;
  if behind.stdout.trim() == "0" {
    return Ok(MergeOutcome::UpToDate);
  }
  let res = git_in(
    worktree,
    &[
      "-c",
      &format!("user.name={name}"),
      "-c",
      &format!("user.email={email}"),
      "merge",
      "--no-edit",
      "--quiet",
      "origin/main",
    ],
    120_000,
    None,
  )
  .await;
  if res.ok {
    return Ok(MergeOutcome::Merged);
  }
  let files = conflicted_files(worktree).await;
  if files.is_empty() {
    let _ = git_in(worktree, &["merge", "--abort"], 60_000, None).await;
    return Err(failure("Bring in your teammates' changes", &res));
  }
  if !keep_conflicts {
    let _ = git_in(worktree, &["merge", "--abort"], 60_000, None).await;
  }
  Ok(MergeOutcome::Conflicts(files))
}

pub async fn conflicted_files(worktree: &Path) -> Vec<String> {
  let res = git_in(worktree, &["diff", "--name-only", "--diff-filter=U"], 60_000, None).await;
  res.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

/// Files (repo-relative) that still contain conflict markers.
pub fn files_with_markers(worktree: &Path, files: &[String]) -> Vec<String> {
  files
    .iter()
    .filter(|f| {
      std::fs::read_to_string(worktree.join(f))
        .map(|text| text.lines().any(|l| l.starts_with("<<<<<<< ") || l.starts_with(">>>>>>> ") || l == "======="))
        .unwrap_or(false)
    })
    .cloned()
    .collect()
}

/// Remove a project folder on a fresh branch and push it (for removing an app
/// from the workspace through a pull request).
pub async fn removal_branch(workspace: &TeamWorkspace, folder: &str, branch: &str, name: &str, email: &str) -> Result<(), String> {
  let wt = Path::new(&workspace.dir).join(format!(".remove-{folder}"));
  let target = wt.to_string_lossy().to_string();
  let clone = clone_dir(workspace);
  let _ = git_in(&clone, &["worktree", "prune"], 30_000, None).await;
  git_ok(&clone, &["worktree", "add", "--no-checkout", "--no-track", "-B", branch, &target, "origin/main"], "Prepare the removal").await?;
  let result = async {
    git_ok(&wt, &["sparse-checkout", "set", "--cone", folder], "Prepare the removal").await?;
    git_ok(&wt, &["checkout", "--quiet"], "Prepare the removal").await?;
    git_ok(&wt, &["rm", "-r", "-q", "--", folder], "Remove the app").await?;
    git_ok(
      &wt,
      &["-c", &format!("user.name={name}"), "-c", &format!("user.email={email}"), "commit", "--quiet", "--no-verify", "-m", &format!("Remove {folder}")],
      "Remove the app",
    )
    .await?;
    push(&wt, branch).await
  }
  .await;
  let _ = git_in(&clone, &["worktree", "remove", "--force", &target], 120_000, None).await;
  let _ = git_in(&clone, &["branch", "-D", branch], 30_000, None).await;
  result
}

pub async fn abort_merge(worktree: &Path) {
  let _ = git_in(worktree, &["merge", "--abort"], 60_000, None).await;
}

/// Throw away uncommitted edits in the project folder.
pub async fn discard_changes(worktree: &Path, folder: &str) -> Result<(), String> {
  abort_merge(worktree).await;
  git_ok(worktree, &["reset", "--quiet", "--hard"], "Discard your changes").await?;
  git_ok(worktree, &["clean", "-fdq", "--", folder], "Discard your changes").await?;
  Ok(())
}

pub async fn delete_local_branch(worktree: &Path, branch: &str) {
  let _ = git_in(worktree, &["branch", "-D", branch], 30_000, None).await;
}

/// Remove a project's worktree (its files and registration).
pub async fn remove_worktree(workspace: &TeamWorkspace, folder: &str) -> Result<(), String> {
  let wt = worktree_dir(workspace, folder);
  let target = wt.to_string_lossy().to_string();
  let res = git_in(&clone_dir(workspace), &["worktree", "remove", "--force", &target], 120_000, None).await;
  if !res.ok && wt.exists() {
    std::fs::remove_dir_all(&wt).map_err(|e| format!("Couldn't remove {}: {e}", wt.display()))?;
    let _ = git_in(&clone_dir(workspace), &["worktree", "prune"], 30_000, None).await;
  }
  Ok(())
}

/// Files never copied when moving a project into a team workspace: generated
/// output, dependencies, git data, and secret-bearing Rayfin files.
const MOVE_SKIP: &[&str] = &["node_modules", ".git", "dist", "dist-ssr", ".vite", "coverage"];

fn skip_on_move(rel: &Path) -> bool {
  let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
  if parts.iter().any(|p| MOVE_SKIP.contains(&p.as_str())) {
    return true;
  }
  if parts.len() >= 2 && parts[0] == "rayfin" {
    let name = parts[1].as_str();
    return name.starts_with(".env") || name == ".deployments.json" || name == ".temp";
  }
  parts.last().is_some_and(|n| n.ends_with(".local"))
}

/// Copy a project's sources into `dst`, leaving out dependencies, build output,
/// git data and secrets. Returns the number of files copied.
pub fn copy_project(src: &Path, dst: &Path) -> Result<usize, String> {
  let mut copied = 0usize;
  let mut stack = vec![src.to_path_buf()];
  while let Some(dir) = stack.pop() {
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Couldn't read {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
      let path = entry.path();
      let rel = path.strip_prefix(src).map_err(|e| e.to_string())?.to_path_buf();
      if skip_on_move(&rel) {
        continue;
      }
      let kind = entry.file_type().map_err(|e| e.to_string())?;
      if kind.is_dir() {
        stack.push(path);
      } else if kind.is_file() {
        let out = dst.join(&rel);
        if let Some(parent) = out.parent() {
          std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        std::fs::copy(&path, &out).map_err(|e| format!("Couldn't copy {}: {e}", rel.display()))?;
        copied += 1;
      }
    }
  }
  Ok(copied)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_commands_that_reach_github_need_the_accounts_token() {
    assert!(reaches_github(&["fetch", "--prune", "--quiet", "origin"]));
    assert!(reaches_github(&["-c", "user.name=A", "push", "-u", "origin", "b"]));
    assert!(reaches_github(&["clone", "--no-checkout", "u", "t"]));
    assert!(!reaches_github(&["-c", "user.name=push", "commit", "-m", "push the button"]));
    assert!(!reaches_github(&["worktree", "add", "x"]));
    assert!(!reaches_github(&["-C", "fetch", "status"]), "-C takes a value");
    assert_eq!(subcommand(&["--no-pager", "diff"]), Some("diff"));
  }

  #[test]
  fn project_folders_are_top_level_rayfin_projects() {
    let listing = "README.md\nfabricator.workspace.json\napp/rayfin/rayfin.yml\napp/src/main.ts\nnested/deep/rayfin/rayfin.yml\nzeta/rayfin/rayfin.yml\n.github/workflows/fabricator.yml\n";
    assert_eq!(project_folders(listing), vec!["app".to_string(), "zeta".to_string()]);
  }

  #[test]
  fn yaml_name_reads_the_project_name() {
    assert_eq!(yaml_name("name: Lead Tracker\nservices: {}\n").as_deref(), Some("Lead Tracker"));
    assert_eq!(yaml_name("services: {}\n"), None);
  }

  #[test]
  fn local_changes_combine_numstat_status_and_new_files() {
    let numstat = "3\t1\tapp/src/App.tsx\0-\t-\tapp/logo.png\x000\t12\tapp/old.ts\0";
    let status = "M\0app/src/App.tsx\0A\0app/logo.png\0D\0app/old.ts\0";
    let files = merge_changes(numstat, status, &["app/new.ts".to_string(), "app/src/App.tsx".to_string()], |_| 7);
    let summary: Vec<(&str, &str, u32, u32)> =
      files.iter().map(|f| (f.path.as_str(), f.change.as_str(), f.additions, f.deletions)).collect();
    assert_eq!(
      summary,
      vec![
        ("app/logo.png", "added", 0, 0),
        ("app/new.ts", "added", 7, 0),
        ("app/old.ts", "deleted", 0, 12),
        ("app/src/App.tsx", "modified", 3, 1),
      ]
    );
  }

  #[test]
  fn moving_a_project_leaves_out_dependencies_output_and_secrets() {
    for skipped in ["node_modules/x/index.js", ".git/HEAD", "dist/index.html", "rayfin/.env", "rayfin/.env.bak", "rayfin/.deployments.json", "rayfin/.temp/a", ".env.local"] {
      assert!(skip_on_move(Path::new(skipped)), "{skipped}");
    }
    for kept in ["rayfin/rayfin.yml", "src/App.tsx", "package.json", ".gitignore", "rayfin/data/schema.ts"] {
      assert!(!skip_on_move(Path::new(kept)), "{kept}");
    }
  }

  #[test]
  fn copy_project_copies_sources_only() {
    let base = std::env::temp_dir().join(format!("fab-copy-{}", uuid::Uuid::new_v4()));
    let src = base.join("src");
    std::fs::create_dir_all(src.join("rayfin")).unwrap();
    std::fs::create_dir_all(src.join("node_modules/pkg")).unwrap();
    std::fs::write(src.join("rayfin/rayfin.yml"), "name: x").unwrap();
    std::fs::write(src.join("rayfin/.env"), "SECRET=1").unwrap();
    std::fs::write(src.join("node_modules/pkg/index.js"), "x").unwrap();
    std::fs::write(src.join("package.json"), "{}").unwrap();
    let dst = base.join("dst");
    assert_eq!(copy_project(&src, &dst).unwrap(), 2);
    assert!(dst.join("rayfin/rayfin.yml").exists());
    assert!(!dst.join("rayfin/.env").exists());
    assert!(!dst.join("node_modules").exists());
    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn app_config_is_rayfin_yml_the_data_model_and_functions_source() {
    let single = ProjectLayout::default();
    for kept in [
      "rayfin/rayfin.yml",
      "rayfin/rayfin.yaml",
      "rayfin/data/Trip.ts",
      "rayfin/data/nested/Tag.ts",
      "rayfin/functions/src/function_app.ts",
    ] {
      assert!(is_app_config(kept, &single), "{kept}");
    }
    for skipped in [
      "rayfin/data/schema.d.ts",
      "rayfin/data/Trip.js",
      "rayfin/functions/src/node_modules/p/index.ts",
      "rayfin/functions/dist/index.ts",
      "rayfin/functions/package.json",
      "rayfin/.temp/compiled/data/Trip.ts",
      "rayfin/connectors/sales/schema.ts",
      "src/App.tsx",
      "packages/data/src/Item.ts",
    ] {
      assert!(!is_app_config(skipped, &single), "{skipped}");
    }
    // The Rayfin CLI's Universal App keeps them in the packages rayfin.yml names.
    let workspace =
      ProjectLayout::parse("services:\n  data:\n    path: packages/data\n  functions:\n    path: packages/functions\n");
    for kept in ["rayfin/rayfin.yml", "packages/data/src/Item.ts", "packages/data/src/index.ts", "packages/functions/src/function_app.ts"] {
      assert!(is_app_config(kept, &workspace), "{kept}");
    }
    for skipped in ["rayfin/data/Trip.ts", "packages/data/dist/index.ts", "packages/frontend/src/App.tsx", "packages/shared/src/index.ts"] {
      assert!(!is_app_config(skipped, &workspace), "{skipped}");
    }
  }

  #[test]
  fn grep_output_rebuilds_the_files() {
    let out = "origin/main:app/rayfin/rayfin.yml\0name: App\n\
               origin/main:app/rayfin/rayfin.yml\0services: {}\n\
               origin/main:app/rayfin/data/Trip.ts\0export class Trip {}\r\n\
               origin/main:app/rayfin/data/schema.d.ts\0declare const x: 1\n\
               origin/main:other/rayfin/rayfin.yml\0name: Other\n\
               not a file line\n";
    let (files, truncated) = config_from_grep(out, "origin/main", "app", &ProjectLayout::default());
    assert!(!truncated);
    assert_eq!(files.len(), 2);
    assert_eq!(files["rayfin/rayfin.yml"], "name: App\nservices: {}\n");
    assert_eq!(files["rayfin/data/Trip.ts"], "export class Trip {}\r\n");

    // A file too big to read is left out whole, and says so.
    let big = "x".repeat(MAX_CONFIG_BYTES);
    let out = format!("t:app/rayfin/data/Big.ts\0{big}\nt:app/rayfin/data/Big.ts\0more\nt:app/rayfin/data/Small.ts\0ok\n");
    let (files, truncated) = config_from_grep(&out, "t", "app", &ProjectLayout::default());
    assert!(truncated);
    assert_eq!(files.keys().map(String::as_str).collect::<Vec<_>>(), vec!["rayfin/data/Small.ts"]);
  }

  #[test]
  fn app_config_on_disk_skips_build_output() {
    let base = std::env::temp_dir().join(format!("fab-config-{}", uuid::Uuid::new_v4()));
    for (path, text) in [
      ("rayfin/rayfin.yml", "name: X\n"),
      ("rayfin/data/schema.ts", "export const schema = []\n"),
      ("rayfin/data/schema.d.ts", "x"),
      ("rayfin/functions/src/function_app.ts", "udf.func('a', async () => 1, [])\n"),
      ("rayfin/functions/src/node_modules/p/index.ts", "x"),
      ("src/App.tsx", "x"),
    ] {
      let file = base.join(path);
      std::fs::create_dir_all(file.parent().unwrap()).unwrap();
      std::fs::write(file, text).unwrap();
    }
    let (files, truncated) = read_app_config_on_disk(&base);
    assert!(!truncated);
    assert_eq!(
      files.keys().map(String::as_str).collect::<Vec<_>>(),
      vec!["rayfin/data/schema.ts", "rayfin/functions/src/function_app.ts", "rayfin/rayfin.yml"]
    );
    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn app_config_on_disk_follows_the_packages_rayfin_yml_names() {
    let base = std::env::temp_dir().join(format!("fab-config-ws-{}", uuid::Uuid::new_v4()));
    for (path, text) in [
      ("rayfin/rayfin.yml", "services:\n  data:\n    path: packages/data\n  functions:\n    path: packages/functions\n"),
      ("packages/data/src/index.ts", "import { Item } from './Item.js';\nexport const schema = [Item];\n"),
      ("packages/data/src/Item.ts", "export class Item {}\n"),
      ("packages/data/dist/index.d.ts", "x"),
      ("packages/functions/src/function_app.ts", "udf.func('a', async () => 1, [])\n"),
      ("packages/frontend/src/App.tsx", "x"),
      ("rayfin/data/Old.ts", "x"),
    ] {
      let file = base.join(path);
      std::fs::create_dir_all(file.parent().unwrap()).unwrap();
      std::fs::write(file, text).unwrap();
    }
    let (files, _) = read_app_config_on_disk(&base);
    assert_eq!(
      files.keys().map(String::as_str).collect::<Vec<_>>(),
      vec![
        "packages/data/src/Item.ts",
        "packages/data/src/index.ts",
        "packages/functions/src/function_app.ts",
        "rayfin/rayfin.yml"
      ]
    );
    let _ = std::fs::remove_dir_all(&base);
  }

  fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git").args(args).current_dir(dir).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
  }

  #[tokio::test]
  async fn app_config_reads_the_published_app_and_working_branches() {
    if which::which("git").is_err() {
      return;
    }
    let base = std::env::temp_dir().join(format!("fab-config-git-{}", uuid::Uuid::new_v4()));
    let seed = base.join("seed");
    let write = |path: &str, text: &str| {
      let file = seed.join(path);
      std::fs::create_dir_all(file.parent().unwrap()).unwrap();
      std::fs::write(file, text).unwrap();
    };
    write("app/rayfin/rayfin.yml", "name: App\nservices:\n  data:\n    enabled: true\n");
    write("app/rayfin/data/Trip.ts", "export class Trip {}\n");
    write("app/src/App.tsx", "x\n");
    write("other/rayfin/rayfin.yml", "name: Other\n");
    // An app from the Rayfin CLI's Universal App keeps its data model in a package.
    write("mono/rayfin/rayfin.yml", "name: Mono\nservices:\n  data:\n    path: packages/data\n");
    write("mono/packages/data/src/index.ts", "export const schema = []\n");
    write("mono/packages/frontend/src/App.tsx", "x\n");
    git(&seed, &["init", "-q", "-b", "main"]);
    git(&seed, &["add", "-A"]);
    git(&seed, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    // A teammate's working copy adds a function.
    git(&seed, &["checkout", "-qb", "fabricator/amy/app-20261003-101500"]);
    write("app/rayfin/functions/src/function_app.ts", "udf.func('hello', async () => 'hi', [])\n");
    git(&seed, &["add", "-A"]);
    git(&seed, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fn"]);
    git(&seed, &["checkout", "-q", "main"]);
    git(&base, &["clone", "-q", "--bare", "seed", "remote.git"]);
    let remote = base.join("remote.git").to_string_lossy().to_string();
    let ws = TeamWorkspace {
      id: "w".into(),
      name: "Team".into(),
      repo: "o/r".into(),
      default_branch: "main".into(),
      dir: base.join("team").to_string_lossy().to_string(),
      role: "owner".into(),
      added_at: String::new(),
      manifest: None,
      setup: None,
      account: None,
      fabric_members: Default::default(),
    };
    std::fs::create_dir_all(&ws.dir).unwrap();
    git(Path::new(&ws.dir), &["clone", "-q", "--no-checkout", &remote, ".repo"]);
    fetch(&ws).await.unwrap();

    let (main, truncated) = read_app_config(&ws, "origin/main", "app").await.unwrap();
    assert!(!truncated);
    assert_eq!(main.keys().map(String::as_str).collect::<Vec<_>>(), vec!["rayfin/data/Trip.ts", "rayfin/rayfin.yml"]);
    assert!(main["rayfin/rayfin.yml"].contains("enabled: true"));
    let (copy, _) = read_app_config(&ws, "origin/fabricator/amy/app-20261003-101500", "app").await.unwrap();
    assert_eq!(copy["rayfin/functions/src/function_app.ts"], "udf.func('hello', async () => 'hi', [])\n");
    let (mono, _) = read_app_config(&ws, "origin/main", "mono").await.unwrap();
    assert_eq!(mono.keys().map(String::as_str).collect::<Vec<_>>(), vec!["packages/data/src/index.ts", "rayfin/rayfin.yml"]);
    // Nothing to read is an empty answer; a missing commit is an error.
    assert!(read_app_config(&ws, "origin/main", "missing").await.unwrap().0.is_empty());
    assert!(read_app_config(&ws, "origin/gone", "app").await.is_err());
    let _ = std::fs::remove_dir_all(&base);
  }

  #[tokio::test]
  async fn session_flow_against_a_local_remote() {
    if which::which("git").is_err() {
      return;
    }
    let base = std::env::temp_dir().join(format!("fab-team-{}", uuid::Uuid::new_v4()));
    let seed = base.join("seed");
    std::fs::create_dir_all(seed.join("app/rayfin")).unwrap();
    std::fs::create_dir_all(seed.join("other/rayfin")).unwrap();
    std::fs::write(seed.join("README.md"), "x\n").unwrap();
    std::fs::write(seed.join("app/rayfin/rayfin.yml"), "name: App\n").unwrap();
    std::fs::write(seed.join("app/index.ts"), "a1\n").unwrap();
    std::fs::write(seed.join("other/rayfin/rayfin.yml"), "name: Other\n").unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    git(&seed, &["add", "-A"]);
    git(&seed, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    git(&base, &["clone", "-q", "--bare", "seed", "remote.git"]);
    let remote = base.join("remote.git").to_string_lossy().to_string();
    let ws = TeamWorkspace {
      id: "w".into(),
      name: "Team".into(),
      repo: "o/r".into(),
      default_branch: "main".into(),
      dir: base.join("team").to_string_lossy().to_string(),
      role: "owner".into(),
      added_at: String::new(),
      manifest: None,
      setup: None,
      account: None,
      fabric_members: Default::default(),
    };
    std::fs::create_dir_all(&ws.dir).unwrap();
    // Stands in for ensure_clone, which clones from GitHub.
    git(Path::new(&ws.dir), &["clone", "-q", "--no-checkout", &remote, ".repo"]);
    fetch(&ws).await.unwrap();
    set_identity(&ws, "Me", "me@example.com").await.unwrap();
    assert_eq!(
      list_projects(&ws).await.unwrap(),
      vec![("app".to_string(), "App".to_string()), ("other".to_string(), "Other".to_string())]
    );
    assert_eq!(read_main_file(&ws, "missing.json").await.unwrap(), None);

    // A working branch with only this app checked out.
    let wt = add_worktree(&ws, "app", "fabricator/me/app-1", false).await.unwrap();
    assert!(wt.join("app/index.ts").exists() && wt.join("README.md").exists());
    assert!(!wt.join("other").exists());
    assert_eq!(current_branch(&wt).await.as_deref(), Some("fabricator/me/app-1"));
    assert!(!commit_folder(&wt, "app", "Nothing").await.unwrap());
    std::fs::write(wt.join("app/index.ts"), "mine\n").unwrap();
    assert!(is_dirty(&wt, "app").await);
    std::fs::write(wt.join("app/new.ts"), "one\ntwo\n").unwrap();
    let changes = local_changes(&wt, "app").await;
    let summary: Vec<(&str, &str, u32, u32)> =
      changes.iter().map(|f| (f.path.as_str(), f.change.as_str(), f.additions, f.deletions)).collect();
    assert_eq!(summary, vec![("app/index.ts", "modified", 1, 1), ("app/new.ts", "added", 2, 0)]);
    assert!(local_diff(&wt, "app").await.contains("+mine"));
    assert_eq!(untracked_files(&wt, "app").await, vec!["app/new.ts".to_string()]);
    std::fs::remove_file(wt.join("app/new.ts")).unwrap();
    assert!(commit_folder(&wt, "app", "Edit").await.unwrap());
    assert_eq!(unpushed(&wt, "fabricator/me/app-1").await, u32::MAX);
    push(&wt, "fabricator/me/app-1").await.unwrap();
    assert_eq!(unpushed(&wt, "fabricator/me/app-1").await, 0);
    assert_eq!(divergence(&wt, "app").await, (1, 0));

    // A teammate publishes a conflicting change.
    let mate = base.join("mate");
    git(&base, &["clone", "-q", &remote, "mate"]);
    std::fs::write(mate.join("app/index.ts"), "theirs\n").unwrap();
    git(&mate, &["-c", "user.name=m", "-c", "user.email=m@m", "commit", "-qam", "theirs"]);
    git(&mate, &["push", "-q", "origin", "main"]);
    fetch(&ws).await.unwrap();
    assert_eq!(divergence(&wt, "app").await, (1, 1));
    match merge_main(&wt, false, "Me", "me@example.com").await.unwrap() {
      MergeOutcome::Conflicts(files) => assert_eq!(files, vec!["app/index.ts".to_string()]),
      _ => panic!("expected a conflict"),
    }
    assert!(!in_merge(&wt).await, "an unkept conflict is aborted");

    // Kept for Copilot to resolve, then concluded by the next save.
    assert!(matches!(merge_main(&wt, true, "Me", "me@example.com").await.unwrap(), MergeOutcome::Conflicts(_)));
    assert!(in_merge(&wt).await);
    let conflicted = conflicted_files(&wt).await;
    assert_eq!(files_with_markers(&wt, &conflicted), vec!["app/index.ts".to_string()]);
    std::fs::write(wt.join("app/index.ts"), "both\n").unwrap();
    assert!(files_with_markers(&wt, &conflicted).is_empty());
    assert!(commit_folder(&wt, "app", "Resolve").await.unwrap());
    assert!(!in_merge(&wt).await);
    assert_eq!(divergence(&wt, "app").await.1, 0);
    assert!(matches!(merge_main(&wt, false, "Me", "me@example.com").await.unwrap(), MergeOutcome::UpToDate));

    // Discard, then start over from the published version.
    std::fs::write(wt.join("app/index.ts"), "junk\n").unwrap();
    std::fs::write(wt.join("app/new.ts"), "new\n").unwrap();
    discard_changes(&wt, "app").await.unwrap();
    assert!(!is_dirty(&wt, "app").await);
    start_branch(&wt, "fabricator/me/app-2").await.unwrap();
    assert_eq!(current_branch(&wt).await.as_deref(), Some("fabricator/me/app-2"));
    assert_eq!(divergence(&wt, "app").await, (0, 0));
    assert_eq!(std::fs::read_to_string(wt.join("app/index.ts")).unwrap().trim(), "theirs");
    remove_worktree(&ws, "app").await.unwrap();
    assert!(!wt.exists());
    let _ = std::fs::remove_dir_all(&base);
  }
}
