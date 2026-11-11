//! Git status/commit + read-only history/diffs for the History view. Ported from
//! `src/main/services/git.ts` and the git helpers in `projects.ts`. Everything is
//! read-only except commit/revert, and sandboxed to the project directory.

use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;

use crate::commands::github_repo::network_auth;
use crate::commands::util::{looks_binary, safe_resolve};
use crate::services::exec::RunOptions;
use crate::services::git::run;
use crate::services::journal::{self, Area, Level};
use crate::services::store::find_project;
use crate::services::version_history;
use crate::types::{
  GitBranch, GitBranches, GitChange, GitCommitResult, GitCommitSummary, GitFileDiff, GitHistory, GitRemoteStatus,
  GitStatus, GitSyncResult, RevertResult, SavedTurn,
};

/// Working-tree sentinel ref (matches `GIT_WORKING_REF` in src/shared/ipc.ts).
const GIT_WORKING_REF: &str = "WORKING";
/// Identity used for Studio's own commits to user projects (matches deploys).
const COMMIT_IDENT: [&str; 4] = [
  "-c",
  "user.name=Fabricator",
  "-c",
  "user.email=fabricator@rayfin.local",
];
const MAX_COMMITS: u32 = 200;
const MAX_DIFF_BYTES: usize = 1024 * 1024;
const FIELD: char = '\x1f';
const RECORD: char = '\x1e';

struct Git {
  ok: bool,
  stdout: String,
  stderr: String,
}

fn opts(cwd: &str) -> RunOptions {
  RunOptions {
    cwd: Some(PathBuf::from(cwd)),
    timeout_ms: Some(30_000),
    ..Default::default()
  }
}

/// Run git in a project (with `core.quotepath=false`), returning ok + output.
async fn git(cwd: &str, args: &[&str]) -> Git {
  let mut full: Vec<&str> = vec!["-c", "core.quotepath=false"];
  full.extend_from_slice(args);
  let res = run(&full, opts(cwd)).await;
  Git {
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
  }
}

/* --------------------------------- status --------------------------------- */

struct ParsedStatus {
  branch: Option<String>,
  changed_count: u32,
  no_commits: bool,
  /// Files a merge left unmerged, with git's code for how (`UU`, `UD`, …), from the repository's root.
  unmerged: Vec<(String, String)>,
}

/// `git status`'s codes for a file a merge left unmerged.
const UNMERGED: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

/// A path as git prints it, without the quotes it puts around unusual ones.
fn unquote(path: &str) -> String {
  match path.strip_prefix('"').and_then(|p| p.strip_suffix('"')) {
    Some(inner) => inner.replace("\\\"", "\"").replace("\\\\", "\\"),
    None => path.to_string(),
  }
}

/// Parse `git status --porcelain=v1 --branch` into branch + change count.
fn parse_git_status(stdout: &str) -> ParsedStatus {
  let mut branch: Option<String> = None;
  let mut no_commits = false;
  let mut changed_count = 0u32;
  let mut unmerged = Vec::new();
  for line in stdout.split('\n') {
    if line.is_empty() {
      continue;
    }
    if let Some(head) = line.strip_prefix("## ") {
      let head = head.trim();
      if let Some(rest) = head.strip_prefix("No commits yet on ") {
        no_commits = true;
        branch = Some(rest.trim().to_string());
      } else if head.starts_with("HEAD (no branch)") {
        branch = Some("detached HEAD".to_string());
      } else {
        let b = head.split("...").next().unwrap_or(head);
        let b = b.split(' ').next().unwrap_or(b);
        branch = Some(b.to_string());
      }
    } else {
      changed_count += 1;
      if let (Some(code), Some(path)) = (line.get(..2), line.get(3..)) {
        if UNMERGED.contains(&code) {
          unmerged.push((code.to_string(), unquote(path.trim_end_matches('\r'))));
        }
      }
    }
  }
  ParsedStatus {
    branch,
    changed_count,
    no_commits,
    unmerged,
  }
}

/// A path from the repository's root, relative to the folder `prefix` names
/// (`git rev-parse --show-prefix`, such as `apps/explorer/`).
fn from_prefix(path: &str, prefix: &str) -> String {
  if prefix.is_empty() {
    return path.to_string();
  }
  if let Some(inside) = path.strip_prefix(prefix) {
    return inside.to_string();
  }
  let up = prefix.trim_end_matches('/').split('/').count();
  format!("{}{path}", "../".repeat(up))
}

static MARKER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(.+):\d+: leftover conflict marker$").unwrap());

/// Files whose changes since `HEAD` still hold conflict markers, from the
/// repository's root, unmerged or not: git counts a file resolved once it's
/// added, markers or not, and one resolved but not added as still unmerged.
async fn marker_files(cwd: &str) -> Vec<String> {
  let check = git(cwd, &["diff", "--check", "HEAD"]).await;
  let mut files: Vec<String> = check
    .stdout
    .lines()
    .filter_map(|line| MARKER_RE.captures(line.trim_end()).map(|c| unquote(&c[1])))
    .collect();
  files.dedup();
  files
}

/// Whether a merge is waiting to be finished.
async fn merging(cwd: &str) -> bool {
  git(cwd, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).await.ok
}

/// The working tree of the repository `cwd` is in: its branch, changes, and a
/// merge waiting to be finished with the files that still have conflicts.
async fn status_in(cwd: &str) -> GitStatus {
  let res = git(cwd, &["status", "--porcelain=v1", "--branch"]).await;
  if !res.ok {
    return GitStatus::default();
  }
  let parsed = parse_git_status(&res.stdout);
  let merging = merging(cwd).await;
  let mut conflicts: Vec<String> = if merging {
    // A conflict in a file's content lasts while its markers do; one over a
    // file deleted or added on one side, until it's added or removed.
    let mut files: Vec<String> = parsed
      .unmerged
      .into_iter()
      .filter(|(code, _)| code != "UU" && code != "AA")
      .map(|(_, path)| path)
      .collect();
    files.extend(marker_files(cwd).await);
    files
  } else {
    parsed.unmerged.into_iter().map(|(_, path)| path).collect()
  };
  if !conflicts.is_empty() {
    let prefix = git(cwd, &["rev-parse", "--show-prefix"]).await.stdout.trim().to_string();
    conflicts = conflicts.iter().map(|path| from_prefix(path, &prefix)).collect();
    conflicts.sort();
    conflicts.dedup();
  }
  GitStatus {
    is_repo: true,
    branch: parsed.branch,
    changed_count: parsed.changed_count,
    no_commits: parsed.no_commits.then_some(true),
    merging,
    conflicts,
  }
}

pub async fn git_status(id: String) -> GitStatus {
  let Some(project) = find_project(&id) else {
    return GitStatus::default();
  };
  if !Path::new(&project.path).exists() {
    return GitStatus::default();
  }
  status_in(&project.path).await
}

pub async fn git_commit(id: String, message: String) -> GitCommitResult {
  let Some(project) = find_project(&id) else {
    return GitCommitResult { ok: false, error: Some("Project folder not found.".into()), status: GitStatus::default() };
  };
  if !Path::new(&project.path).exists() {
    return GitCommitResult { ok: false, error: Some("Project folder not found.".into()), status: GitStatus::default() };
  }
  let msg = message.trim().to_string();
  if msg.is_empty() {
    return GitCommitResult { ok: false, error: Some("Enter a commit message.".into()), status: git_status(id).await };
  }
  let dir = project.path.clone();
  // Adding everything would count a file's conflict markers as its resolution.
  let current = status_in(&dir).await;
  if current.merging && !current.conflicts.is_empty() {
    return GitCommitResult { ok: false, error: Some(STILL_CONFLICTED.into()), status: current };
  }

  let email = git(&dir, &["config", "user.email"]).await;
  if !email.ok || email.stdout.trim().is_empty() {
    git(&dir, &["config", "user.email", "fabricator@rayfin.local"]).await;
    git(&dir, &["config", "user.name", "Fabricator"]).await;
  }

  // A team app commits only its own folder (the shared root files stay as published).
  let add_args: &[&str] = if project.team.is_some() { &["add", "-A", "--", "."] } else { &["add", "-A"] };
  let add = git(&dir, add_args).await;
  if !add.ok {
    let e = add.stderr.trim().to_string();
    return GitCommitResult {
      ok: false,
      error: Some(if e.is_empty() { "git add failed.".into() } else { e }),
      status: git_status(id).await,
    };
  }

  let commit = git(&dir, &["commit", "-m", &msg]).await;
  if !commit.ok {
    let combined = format!("{}\n{}", commit.stdout, commit.stderr);
    let nothing = Regex::new(r"(?i)nothing to commit|no changes added").unwrap().is_match(&combined);
    let err = combined.trim().to_string();
    return GitCommitResult {
      ok: false,
      error: Some(if nothing {
        "Nothing to commit.".into()
      } else if err.is_empty() {
        "git commit failed.".into()
      } else {
        err
      }),
      status: git_status(id).await,
    };
  }
  GitCommitResult { ok: true, error: None, status: git_status(id).await }
}

/// After a chat turn that changed a personal app: save what it changed as a
/// version, named after what the user asked (`request`), so History lists one
/// per turn and Restore goes back turn by turn. Nothing else saves a turn while
/// chat turns don't publish. A team app saves each turn to its working branch
/// instead.
pub async fn git_save_turn(id: String, request: String) -> SavedTurn {
  let Some(project) = find_project(&id) else {
    return SavedTurn { commit: None, error: Some("Project not found.".into()) };
  };
  if project.team.is_some() {
    return SavedTurn::default();
  }
  let message = version_history::turn_message(&request, &format!("Update {}", project.name));
  let saved = match version_history::ensure_project_tracked(&project).await {
    Ok(()) => version_history::save_version(Path::new(&project.path), &message).await,
    Err(error) => Err(error),
  };
  match saved {
    Ok(commit) => SavedTurn { commit, error: None },
    Err(error) => {
      journal::entry(
        Level::Warn,
        Area::Git,
        "git.turn-save-failed",
        "Couldn't save the chat turn's changes as a version in History, so they stay as uncommitted changes.",
      )
      .detail(Some(error.clone()))
      .project(Some(id))
      .write();
      SavedTurn { commit: None, error: Some(error) }
    }
  }
}

/* ---------------------------------- log ----------------------------------- */

static RE_FILES: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\d+)\s+files?\s+changed").unwrap());
static RE_INS: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\d+)\s+insertions?\(\+\)").unwrap());
static RE_DEL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\d+)\s+deletions?\(-\)").unwrap());
static RE_BRACE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\{[^}]*? => ([^}]*?)\}").unwrap());
static RE_SLASHES: Lazy<Regex> = Lazy::new(|| Regex::new(r"/{2,}").unwrap());

fn num(re: &Regex, s: &str) -> u32 {
  re.captures(s)
    .and_then(|c| c.get(1))
    .and_then(|m| m.as_str().parse().ok())
    .unwrap_or(0)
}

struct Stat {
  files_changed: u32,
  insertions: u32,
  deletions: u32,
}

fn parse_shortstat(lines: &[&str]) -> Stat {
  let mut stat = Stat { files_changed: 0, insertions: 0, deletions: 0 };
  for line in lines {
    if RE_FILES.is_match(line) {
      stat.files_changed = num(&RE_FILES, line);
      stat.insertions = num(&RE_INS, line);
      stat.deletions = num(&RE_DEL, line);
    }
  }
  stat
}

fn parse_log(stdout: &str) -> Vec<GitCommitSummary> {
  let mut commits = Vec::new();
  for record in stdout.split(RECORD) {
    if record.trim().is_empty() {
      continue;
    }
    let lines: Vec<&str> = record.split('\n').collect();
    let head: Vec<&str> = lines[0].split(FIELD).collect();
    let hash = head.first().copied().unwrap_or("");
    if hash.is_empty() {
      continue;
    }
    let stat = parse_shortstat(&lines[1..]);
    let short_hash = head.get(1).copied().filter(|s| !s.is_empty()).unwrap_or(&hash[..hash.len().min(7)]);
    let subject = head.get(5).copied().unwrap_or("").trim();
    commits.push(GitCommitSummary {
      hash: hash.to_string(),
      short_hash: short_hash.to_string(),
      author: head.get(2).copied().unwrap_or("").to_string(),
      relative_date: head.get(3).copied().unwrap_or("").to_string(),
      iso_date: head.get(4).copied().unwrap_or("").to_string(),
      subject: if subject.is_empty() { "(no message)".to_string() } else { subject.to_string() },
      files_changed: stat.files_changed,
      insertions: stat.insertions,
      deletions: stat.deletions,
    });
  }
  commits
}

pub async fn git_log(id: String) -> GitHistory {
  let none = || GitHistory {
    is_repo: false,
    no_commits: None,
    commits: vec![],
    working_changes: 0,
    head: None,
    live_differs: None,
  };
  let Some(project) = find_project(&id) else {
    return none();
  };
  let cwd = project.path.clone();
  // A team app shares its repository with the workspace's other apps: its
  // history and changes are limited to its own folder (the cwd).
  let scope: &[&str] = if project.team.is_some() { &["--", "."] } else { &[] };

  let inside = git(&cwd, &["rev-parse", "--is-inside-work-tree"]).await;
  if !inside.ok || inside.stdout.trim() != "true" {
    return none();
  }

  let mut status_args = vec!["status", "--porcelain=v1", "--untracked-files=all"];
  status_args.extend_from_slice(scope);
  let status = git(&cwd, &status_args).await;
  let working_changes = if status.ok {
    status.stdout.split('\n').filter(|l| !l.trim().is_empty()).count() as u32
  } else {
    0
  };

  let head_res = git(&cwd, &["rev-parse", "HEAD"]).await;
  let head = if head_res.ok {
    let h = head_res.stdout.trim().to_string();
    if h.is_empty() { None } else { Some(h) }
  } else {
    None
  };
  // Team apps are deployed by their pipeline (a preview and the published app),
  // which the team controls follow, so History doesn't compare them.
  let live_differs = if project.team.is_some() {
    None
  } else {
    let deployed = project.last_deploy.as_ref().and_then(|d| d.commit.as_deref());
    live_differs(&cwd, deployed, head.as_deref()).await
  };

  let fmt = format!("{RECORD}%H{FIELD}%h{FIELD}%an{FIELD}%ar{FIELD}%aI{FIELD}%s");
  let n = MAX_COMMITS.to_string();
  let pretty = format!("--pretty=format:{fmt}");
  let mut log_args = vec!["log", "-n", &n, "--shortstat", &pretty];
  log_args.extend_from_slice(scope);
  let log = git(&cwd, &log_args).await;
  if !log.ok {
    return GitHistory { is_repo: true, no_commits: Some(true), commits: vec![], working_changes, head, live_differs };
  }
  GitHistory { is_repo: true, no_commits: None, commits: parse_log(&log.stdout), working_changes, head, live_differs }
}

/// Files that only guide the coding agent (skills, Copilot instructions, MCP
/// settings). They never ship, so changing them doesn't make the live app stale.
const AGENT_ONLY: &[&str] = &[":(exclude).agents", ":(exclude).github", ":(exclude)AGENTS.md", ":(exclude).mcp.json"];

/// Whether HEAD differs from the deployed commit in anything that ships with the
/// app. `None` without both commits to compare.
async fn live_differs(cwd: &str, deployed: Option<&str>, head: Option<&str>) -> Option<bool> {
  let deployed = deployed.map(str::trim).filter(|s| !s.is_empty())?;
  let head = head?;
  if deployed == head {
    return Some(false);
  }
  let mut args = vec!["diff", "--quiet", "--no-ext-diff", deployed, "HEAD", "--", "."];
  args.extend_from_slice(AGENT_ONLY);
  let res = run(&args, opts(cwd)).await;
  match res.exit_code {
    Some(0) if res.ok => Some(false),
    // Exit 1 means they differ. Anything else (say, the deployed commit is gone)
    // can't be compared: the code has moved on from it.
    _ => Some(true),
  }
}

/* -------------------------------- changes --------------------------------- */

fn status_from_code(code: &str) -> &'static str {
  let c = code.chars().next().unwrap_or(' ');
  if c == 'A' || code == "??" {
    "added"
  } else if c == 'D' {
    "deleted"
  } else if c == 'R' || c == 'C' {
    "renamed"
  } else {
    "modified"
  }
}

fn numstat_path(raw: &str) -> String {
  let braced = RE_BRACE.replace_all(raw, "$1").to_string();
  let path = match braced.find(" => ") {
    Some(i) => braced[i + 4..].to_string(),
    None => braced,
  };
  RE_SLASHES.replace_all(&path, "/").to_string()
}

struct Count {
  insertions: u32,
  deletions: u32,
  binary: bool,
}

fn parse_numstat(stdout: &str) -> std::collections::HashMap<String, Count> {
  let mut map = std::collections::HashMap::new();
  for line in stdout.split('\n') {
    if line.trim().is_empty() {
      continue;
    }
    let tab: Vec<&str> = line.split('\t').collect();
    if tab.len() < 3 {
      continue;
    }
    let ins = tab[0];
    let del = tab[1];
    let path = numstat_path(&tab[2..].join("\t"));
    let binary = ins == "-" || del == "-";
    map.insert(
      path,
      Count {
        insertions: if binary { 0 } else { ins.parse().unwrap_or(0) },
        deletions: if binary { 0 } else { del.parse().unwrap_or(0) },
        binary,
      },
    );
  }
  map
}

fn parse_name_status(name_status_stdout: &str, counts: &std::collections::HashMap<String, Count>) -> Vec<GitChange> {
  let mut changes = Vec::new();
  for line in name_status_stdout.split('\n') {
    if line.trim().is_empty() {
      continue;
    }
    let parts: Vec<&str> = line.split('\t').collect();
    let status = status_from_code(parts[0]);
    let renamed = status == "renamed";
    let path = if renamed { parts.get(2) } else { parts.get(1) }.map(|s| s.trim()).unwrap_or("");
    if path.is_empty() {
      continue;
    }
    let old_path = if renamed { parts.get(1).map(|s| s.trim().to_string()) } else { None };
    let c = counts.get(path);
    changes.push(GitChange {
      path: path.to_string(),
      old_path,
      status: status.to_string(),
      insertions: c.map(|c| c.insertions).unwrap_or(0),
      deletions: c.map(|c| c.deletions).unwrap_or(0),
      binary: c.and_then(|c| if c.binary { Some(true) } else { None }),
    });
  }
  changes
}

async fn commit_changes(cwd: &str, hash: &str) -> Vec<GitChange> {
  let name_status = git(cwd, &["show", hash, "--name-status", "--format=", "-M", "--relative", "--", "."]).await;
  if !name_status.ok {
    return vec![];
  }
  let numstat = git(cwd, &["show", hash, "--numstat", "--format=", "-M", "--relative", "--", "."]).await;
  let counts = parse_numstat(if numstat.ok { &numstat.stdout } else { "" });
  parse_name_status(&name_status.stdout, &counts)
}

async fn working_change_list(cwd: &str) -> Vec<GitChange> {
  let status = git(cwd, &["status", "--porcelain=v1", "--untracked-files=all", "--", "."]).await;
  if !status.ok {
    return vec![];
  }
  // Porcelain paths are repository-relative even when cwd is a nested app.
  let prefix = git(cwd, &["rev-parse", "--show-prefix"]).await;
  if !prefix.ok {
    log::warn!("could not resolve Git's project prefix for {cwd}: {}", prefix.stderr.trim());
    return vec![];
  }
  let prefix = prefix.stdout.trim_end_matches(['\r', '\n']);
  let numstat = git(cwd, &["diff", "--numstat", "--relative", "HEAD", "--", "."]).await;
  let counts = parse_numstat(if numstat.ok { &numstat.stdout } else { "" });

  let mut changes = Vec::new();
  for raw in status.stdout.split('\n') {
    if raw.trim().is_empty() {
      continue;
    }
    let code = &raw[..raw.len().min(2)];
    let rest = if raw.len() > 3 { &raw[3..] } else { "" };
    let renamed = code.contains('R');
    let mut path = rest.to_string();
    let mut old_path: Option<String> = None;
    if renamed {
      if let Some(idx) = rest.find(" -> ") {
        old_path = Some(rest[..idx].trim().to_string());
        path = rest[idx + 4..].trim().to_string();
      }
    }
    let path = path.trim().trim_matches('"');
    let Some(path) = path.strip_prefix(prefix) else { continue };
    if path.is_empty() {
      continue;
    }
    let old_path = old_path.and_then(|old| {
      old.trim_matches('"').strip_prefix(prefix).map(str::to_string)
    });
    let status2 = if code == "??" { "added" } else { status_from_code(code.trim()) };
    let c = counts.get(path);
    changes.push(GitChange {
      path: path.to_string(),
      old_path,
      status: status2.to_string(),
      insertions: c.map(|c| c.insertions).unwrap_or(0),
      deletions: c.map(|c| c.deletions).unwrap_or(0),
      binary: c.and_then(|c| if c.binary { Some(true) } else { None }),
    });
  }
  changes
}

pub async fn git_changes(id: String, reference: String) -> Vec<GitChange> {
  let Some(project) = find_project(&id) else {
    return vec![];
  };
  let cwd = project.path;
  let mut list = if reference == GIT_WORKING_REF {
    working_change_list(&cwd).await
  } else {
    commit_changes(&cwd, &reference).await
  };
  list.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
  list
}

pub async fn git_compare_changes(id: String, base: String, target: String) -> Vec<GitChange> {
  let Some(project) = find_project(&id) else {
    return vec![];
  };
  let mut list = compare_change_list(&project.path, &base, &target).await;
  list.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
  list
}

async fn compare_change_list(cwd: &str, base: &str, target: &str) -> Vec<GitChange> {
  let name_status = git(cwd, &["diff", "--name-status", "-M", "--relative", base, target, "--", "."]).await;
  if !name_status.ok {
    return vec![];
  }
  let numstat = git(cwd, &["diff", "--numstat", "-M", "--relative", base, target, "--", "."]).await;
  let counts = parse_numstat(if numstat.ok { &numstat.stdout } else { "" });
  parse_name_status(&name_status.stdout, &counts)
}

/* --------------------------------- diff ----------------------------------- */

async fn show_at(cwd: &str, rev: &str, path: &str) -> String {
  // `:./` resolves from the app's cwd, including inside a linked worktree.
  let res = run(&["-c", "core.quotepath=false", "show", &format!("{rev}:./{path}")], opts(cwd)).await;
  if res.ok { res.stdout } else { String::new() }
}

fn read_working(root: &str, rel_path: &str) -> Result<String, String> {
  let target = safe_resolve(root, rel_path).ok_or_else(|| "Path is outside the project.".to_string())?;
  match std::fs::read(&target) {
    Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
    Err(e) => Err(format!("Could not read {rel_path}: {e}")),
  }
}

pub async fn git_file_diff(id: String, reference: String, path: String, old_path: Option<String>) -> GitFileDiff {
  let Some(project) = find_project(&id) else {
    return GitFileDiff {
      path,
      old_path: None,
      status: "modified".into(),
      before: String::new(),
      after: String::new(),
      binary: None,
      too_large: None,
      error: Some("Project not found.".into()),
    };
  };
  file_diff_at(&project.path, &reference, path, old_path).await
}

async fn file_diff_at(cwd: &str, reference: &str, path: String, old_path: Option<String>) -> GitFileDiff {
  let source = old_path.as_deref().unwrap_or(&path);

  let (before, after) = if reference == GIT_WORKING_REF {
    let after = match read_working(cwd, &path) {
      Ok(content) => content,
      Err(error) => return GitFileDiff {
        path, old_path, status: "modified".into(),
        before: String::new(), after: String::new(),
        binary: None, too_large: None, error: Some(error),
      },
    };
    (show_at(cwd, "HEAD", source).await, after)
  } else {
    (
      show_at(cwd, &format!("{reference}^"), source).await,
      show_at(cwd, reference, &path).await,
    )
  };

  let status = if old_path.is_some() {
    "renamed"
  } else if !before.is_empty() && after.is_empty() {
    "deleted"
  } else if before.is_empty() && !after.is_empty() {
    "added"
  } else {
    "modified"
  };

  if looks_binary(before.as_bytes()) || looks_binary(after.as_bytes()) {
    return GitFileDiff {
      path,
      old_path,
      status: status.into(),
      before: String::new(),
      after: String::new(),
      binary: Some(true),
      too_large: None,
      error: None,
    };
  }
  if before.len() > MAX_DIFF_BYTES || after.len() > MAX_DIFF_BYTES {
    return GitFileDiff {
      path,
      old_path,
      status: status.into(),
      before: String::new(),
      after: String::new(),
      binary: None,
      too_large: Some(true),
      error: None,
    };
  }
  GitFileDiff {
    path,
    old_path,
    status: status.into(),
    before,
    after,
    binary: None,
    too_large: None,
    error: None,
  }
}

pub async fn git_compare_file_diff(
  id: String,
  base: String,
  target: String,
  path: String,
  old_path: Option<String>,
) -> GitFileDiff {
  let Some(project) = find_project(&id) else {
    return GitFileDiff {
      path,
      old_path: None,
      status: "modified".into(),
      before: String::new(),
      after: String::new(),
      binary: None,
      too_large: None,
      error: Some("Project not found.".into()),
    };
  };
  let cwd = project.path;
  let source = old_path.as_deref().unwrap_or(&path);

  let before = show_at(&cwd, &base, source).await;
  let after = show_at(&cwd, &target, &path).await;

  let status = if old_path.is_some() {
    "renamed"
  } else if !before.is_empty() && after.is_empty() {
    "deleted"
  } else if before.is_empty() && !after.is_empty() {
    "added"
  } else {
    "modified"
  };

  if looks_binary(before.as_bytes()) || looks_binary(after.as_bytes()) {
    return GitFileDiff {
      path,
      old_path,
      status: status.into(),
      before: String::new(),
      after: String::new(),
      binary: Some(true),
      too_large: None,
      error: None,
    };
  }
  if before.len() > MAX_DIFF_BYTES || after.len() > MAX_DIFF_BYTES {
    return GitFileDiff {
      path,
      old_path,
      status: status.into(),
      before: String::new(),
      after: String::new(),
      binary: None,
      too_large: Some(true),
      error: None,
    };
  }
  GitFileDiff {
    path,
    old_path,
    status: status.into(),
    before,
    after,
    binary: None,
    too_large: None,
    error: None,
  }
}

pub async fn git_file_log(id: String, path: String) -> Vec<GitCommitSummary> {
  let Some(project) = find_project(&id) else {
    return vec![];
  };
  let cwd = project.path;
  let fmt = format!("{RECORD}%H{FIELD}%h{FIELD}%an{FIELD}%ar{FIELD}%aI{FIELD}%s");
  let n = MAX_COMMITS.to_string();
  let log = git(
    &cwd,
    &[
      "log",
      "-n",
      &n,
      "--follow",
      "--shortstat",
      &format!("--pretty=format:{fmt}"),
      "--",
      &path,
    ],
  )
  .await;
  if log.ok { parse_log(&log.stdout) } else { vec![] }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn run_git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").args(args).current_dir(dir).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
  }

  struct TestRepo {
    root: PathBuf,
    dir: PathBuf,
  }

  impl TestRepo {
    fn new() -> Self {
      let root = std::env::temp_dir().join(format!("fab-history-{}", uuid::Uuid::new_v4()));
      let dir = root.join("repo");
      std::fs::create_dir_all(&dir).unwrap();
      run_git(&dir, &["init", "-q", "-b", "main"]);
      run_git(&dir, &["config", "core.autocrlf", "false"]);
      run_git(&dir, &["config", "user.name", "Test"]);
      run_git(&dir, &["config", "user.email", "test@example.invalid"]);
      Self { root, dir }
    }
  }

  impl Drop for TestRepo {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.root);
    }
  }

  #[tokio::test]
  async fn nested_worktree_diffs_read_the_app_not_a_repeated_folder_prefix() {
    let repo = TestRepo::new();
    let app = repo.dir.join("apps").join("meow");
    std::fs::create_dir_all(app.join("src")).unwrap();
    std::fs::create_dir_all(repo.dir.join("other")).unwrap();
    let before = "{\n  \"name\": \"meow\"\n}\n";
    let after = "{\n  \"name\": \"meow\",\n  \"private\": true\n}\n";
    std::fs::write(app.join("package.json"), before).unwrap();
    std::fs::write(app.join("staged.ts"), "staged before\n").unwrap();
    std::fs::write(app.join("mixed.ts"), "mixed before\n").unwrap();
    std::fs::write(app.join("deleted.ts"), "deleted before\n").unwrap();
    std::fs::write(app.join("old name.ts"), "renamed content\n").unwrap();
    std::fs::write(repo.dir.join("other").join("app.ts"), "other before\n").unwrap();
    run_git(&repo.dir, &["add", "-A"]);
    run_git(&repo.dir, &["commit", "-qm", "First"]);
    let base = run_git(&repo.dir, &["rev-parse", "HEAD"]);
    let worktree = repo.root.join("working copy");
    run_git(&repo.dir, &["worktree", "add", "--quiet", "--detach", worktree.to_str().unwrap(), "HEAD"]);
    let app = worktree.join("apps").join("meow");
    let cwd = app.to_str().unwrap();
    std::fs::create_dir_all(app.join("src")).unwrap();
    std::fs::write(app.join("package.json"), after).unwrap();
    std::fs::write(app.join("staged.ts"), "staged after\n").unwrap();
    std::fs::write(app.join("mixed.ts"), "mixed staged\n").unwrap();
    run_git(&app, &["add", "staged.ts", "mixed.ts"]);
    std::fs::write(app.join("mixed.ts"), "mixed working\n").unwrap();
    std::fs::remove_file(app.join("deleted.ts")).unwrap();
    run_git(&app, &["mv", "old name.ts", "new name.ts"]);
    std::fs::write(app.join("src").join("new file.ts"), "new content\n").unwrap();
    std::fs::write(worktree.join("other").join("app.ts"), "other after\n").unwrap();

    let changes = working_change_list(cwd).await;
    assert_eq!(changes.len(), 6);
    for (path, expected_before, expected_after, status) in [
      ("package.json", before, after, "modified"),
      ("staged.ts", "staged before\n", "staged after\n", "modified"),
      ("mixed.ts", "mixed before\n", "mixed working\n", "modified"),
      ("deleted.ts", "deleted before\n", "", "deleted"),
      ("new name.ts", "renamed content\n", "renamed content\n", "renamed"),
      ("src/new file.ts", "", "new content\n", "added"),
    ] {
      let change = changes.iter().find(|c| c.path == path)
        .unwrap_or_else(|| panic!("missing project-relative path {path}"));
      assert_eq!(change.status, status);
      if status == "renamed" {
        assert_eq!(change.old_path.as_deref(), Some("old name.ts"));
      }
      let diff = file_diff_at(cwd, GIT_WORKING_REF, change.path.clone(), change.old_path.clone()).await;
      assert!(diff.error.is_none(), "{:?}", diff.error);
      assert_eq!(diff.before, expected_before, "{path}");
      assert_eq!(diff.after, expected_after, "{path}");
      assert_eq!(diff.status, status, "{path}");
    }
    let mixed = changes.iter().find(|c| c.path == "mixed.ts").unwrap();
    assert_eq!((mixed.insertions, mixed.deletions), (1, 1));

    run_git(&worktree, &["add", "-A"]);
    run_git(&worktree, &["commit", "-qm", "Second"]);
    let head = run_git(&worktree, &["rev-parse", "HEAD"]);
    for changes in [commit_changes(cwd, &head).await, compare_change_list(cwd, &base, &head).await] {
      assert_eq!(changes.len(), 6);
      assert!(changes.iter().any(|c| c.path == "package.json"));
      assert!(!changes.iter().any(|c| c.path.starts_with("apps/") || c.path.starts_with("other/")));
    }
    let snapshot = file_diff_at(cwd, &head, "package.json".into(), None).await;
    assert_eq!(snapshot.before, before);
    assert_eq!(snapshot.after, after);
    let root_diff = file_diff_at(worktree.to_str().unwrap(), &head, "apps/meow/package.json".into(), None).await;
    assert_eq!(root_diff.before, before);
    assert_eq!(root_diff.after, after);
  }

  #[tokio::test]
  async fn working_diffs_handle_new_binary_large_and_unreadable_files() {
    let repo = TestRepo::new();
    let cwd = repo.dir.to_str().unwrap();
    std::fs::write(repo.dir.join("new.txt"), "new before the first commit\n").unwrap();
    std::fs::write(repo.dir.join("binary.dat"), [0, 0xff, 1]).unwrap();
    std::fs::write(repo.dir.join("large.txt"), vec![b'x'; MAX_DIFF_BYTES + 1]).unwrap();
    std::fs::create_dir(repo.dir.join("directory")).unwrap();
    let added = file_diff_at(cwd, GIT_WORKING_REF, "new.txt".into(), None).await;
    assert_eq!(added.before, "");
    assert_eq!(added.after, "new before the first commit\n");
    assert_eq!(added.status, "added");
    let binary = file_diff_at(cwd, GIT_WORKING_REF, "binary.dat".into(), None).await;
    assert_eq!(binary.binary, Some(true));
    assert!(binary.after.is_empty());
    let large = file_diff_at(cwd, GIT_WORKING_REF, "large.txt".into(), None).await;
    assert_eq!(large.too_large, Some(true));
    assert!(large.after.is_empty());
    let unreadable = file_diff_at(cwd, GIT_WORKING_REF, "directory".into(), None).await;
    assert!(unreadable.error.as_deref().is_some_and(|e| e.starts_with("Could not read directory:")));
    let outside = file_diff_at(cwd, GIT_WORKING_REF, "../outside.txt".into(), None).await;
    assert_eq!(outside.error.as_deref(), Some("Path is outside the project."));
  }

  #[tokio::test]
  async fn restoring_a_team_app_only_touches_its_folder() {
    if which::which("git").is_err() {
      return;
    }
    let root = std::env::temp_dir().join(format!("fab-revert-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("app")).unwrap();
    std::fs::create_dir_all(root.join("other")).unwrap();
    let commit = |msg: &str| run_git(&root, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", msg]);
    run_git(&root, &["init", "-q", "-b", "main"]);
    run_git(&root, &["config", "core.autocrlf", "false"]);
    std::fs::write(root.join("app/a.txt"), "v1\n").unwrap();
    std::fs::write(root.join("other/b.txt"), "theirs v1\n").unwrap();
    std::fs::write(root.join("shared.json"), "{\"v\":1}\n").unwrap();
    run_git(&root, &["add", "-A"]);
    commit("first");
    let old = run_git(&root, &["rev-parse", "HEAD"]);
    std::fs::write(root.join("app/a.txt"), "v2\n").unwrap();
    std::fs::write(root.join("other/b.txt"), "theirs v2\n").unwrap();
    std::fs::write(root.join("shared.json"), "{\"v\":2}\n").unwrap();
    commit("second");
    run_git(&root, &["config", "user.name", "Me"]);
    run_git(&root, &["config", "user.email", "me@example.com"]);

    let app = root.join("app").to_string_lossy().to_string();
    let result = revert_folder(&app, &old, "first").await;
    assert!(result.ok, "{:?}", result.error);
    assert_eq!(std::fs::read_to_string(root.join("app/a.txt")).unwrap(), "v1\n");
    // Teammates' apps and shared files keep their latest version.
    assert_eq!(std::fs::read_to_string(root.join("other/b.txt")).unwrap(), "theirs v2\n");
    assert_eq!(std::fs::read_to_string(root.join("shared.json")).unwrap(), "{\"v\":2}\n");
    let changed = run_git(&root, &["show", "--name-only", "--pretty=format:", "HEAD"]);
    assert_eq!(changed, "app/a.txt");
    assert_eq!(run_git(&root, &["log", "-1", "--pretty=%an"]), "Me");

    // Restoring the same version again changes nothing.
    let again = revert_folder(&app, &old, "first").await;
    assert_eq!(again.no_changes, Some(true));
    let _ = std::fs::remove_dir_all(&root);
  }

  #[tokio::test]
  async fn the_live_app_lags_only_when_shipped_files_change() {
    let repo = TestRepo::new();
    let cwd = repo.dir.to_str().unwrap();
    std::fs::create_dir_all(repo.dir.join("src")).unwrap();
    std::fs::write(repo.dir.join("src/app.ts"), "v1\n").unwrap();
    run_git(&repo.dir, &["add", "-A"]);
    run_git(&repo.dir, &["commit", "-qm", "Deploy"]);
    let deployed = run_git(&repo.dir, &["rev-parse", "HEAD"]);
    assert_eq!(live_differs(cwd, None, Some(&deployed)).await, None);
    assert_eq!(live_differs(cwd, Some(&deployed), Some(&deployed)).await, Some(false));

    // Turning on a skill (or editing other agent guidance) commits, but ships nothing.
    for (path, text) in [
      (".agents/skills/polished-ui/SKILL.md", "skill\n"),
      (".github/copilot-instructions.md", "rules\n"),
      ("AGENTS.md", "agents\n"),
      (".mcp.json", "{}\n"),
    ] {
      let file = repo.dir.join(path);
      std::fs::create_dir_all(file.parent().unwrap()).unwrap();
      std::fs::write(file, text).unwrap();
    }
    run_git(&repo.dir, &["add", "-A"]);
    run_git(&repo.dir, &["commit", "-qm", "Add skill: Polished, modern UI"]);
    let head = run_git(&repo.dir, &["rev-parse", "HEAD"]);
    assert_eq!(live_differs(cwd, Some(&deployed), Some(&head)).await, Some(false));

    std::fs::write(repo.dir.join("src/app.ts"), "v2\n").unwrap();
    run_git(&repo.dir, &["commit", "-qam", "Change the app"]);
    let head = run_git(&repo.dir, &["rev-parse", "HEAD"]);
    assert_eq!(live_differs(cwd, Some(&deployed), Some(&head)).await, Some(true));

    // A deployed commit that no longer exists can't match.
    let gone = "0123456789abcdef0123456789abcdef01234567";
    assert_eq!(live_differs(cwd, Some(gone), Some(&head)).await, Some(true));
  }

  #[test]
  fn parse_status_branch_and_count() {
    let out = "## main...origin/main [ahead 1]\n M src/a.rs\n?? new.txt\n";
    let p = parse_git_status(out);
    assert_eq!(p.branch.as_deref(), Some("main"));
    assert_eq!(p.changed_count, 2);
    assert!(!p.no_commits);
  }

  #[test]
  fn parse_status_unborn_branch() {
    let p = parse_git_status("## No commits yet on main\n?? a.txt\n");
    assert_eq!(p.branch.as_deref(), Some("main"));
    assert_eq!(p.changed_count, 1);
    assert!(p.no_commits);
  }

  #[test]
  fn status_code_mapping() {
    assert_eq!(status_from_code("A"), "added");
    assert_eq!(status_from_code("??"), "added");
    assert_eq!(status_from_code("D"), "deleted");
    assert_eq!(status_from_code("R"), "renamed");
    assert_eq!(status_from_code("M"), "modified");
  }

  #[test]
  fn numstat_path_resolves_renames() {
    assert_eq!(numstat_path("src/old.rs => src/new.rs"), "src/new.rs");
    assert_eq!(numstat_path("src/{old => new}/file.rs"), "src/new/file.rs");
    assert_eq!(numstat_path("plain.rs"), "plain.rs");
  }

  #[test]
  fn parse_log_reads_records() {
    let r = '\x1e';
    let f = '\x1f';
    let stdout = format!(
      "{r}abc123{f}abc{f}Ada{f}2 days ago{f}2024-01-01T00:00:00Z{f}Initial\n 1 file changed, 2 insertions(+), 1 deletion(-)\n"
    );
    let commits = parse_log(&stdout);
    assert_eq!(commits.len(), 1);
    let c = &commits[0];
    assert_eq!(c.hash, "abc123");
    assert_eq!(c.short_hash, "abc");
    assert_eq!(c.subject, "Initial");
    assert_eq!(c.files_changed, 1);
    assert_eq!(c.insertions, 2);
    assert_eq!(c.deletions, 1);
  }

  #[test]
  fn parse_name_status_reads_renames_and_counts() {
    let counts = parse_numstat("3\t1\told.txt => new.txt\n-\t-\tbin.dat\n");
    let changes = parse_name_status("R100\told.txt\tnew.txt\nA\tbin.dat\n", &counts);
    assert_eq!(changes.len(), 2);

    assert_eq!(changes[0].path, "new.txt");
    assert_eq!(changes[0].old_path.as_deref(), Some("old.txt"));
    assert_eq!(changes[0].status, "renamed");
    assert_eq!(changes[0].insertions, 3);
    assert_eq!(changes[0].deletions, 1);
    assert_eq!(changes[0].binary, None);

    assert_eq!(changes[1].path, "bin.dat");
    assert_eq!(changes[1].old_path, None);
    assert_eq!(changes[1].status, "added");
    assert_eq!(changes[1].insertions, 0);
    assert_eq!(changes[1].deletions, 0);
    assert_eq!(changes[1].binary, Some(true));
  }

  #[test]
  fn parse_ahead_behind_counts() {
    // `git rev-list --left-right --count @{u}...HEAD` → "<behind>\t<ahead>".
    assert_eq!(parse_ahead_behind("2\t1\n"), (2, 1));
    assert_eq!(parse_ahead_behind("0\t0"), (0, 0));
    assert_eq!(parse_ahead_behind("5   3"), (5, 3));
    assert_eq!(parse_ahead_behind(""), (0, 0));
  }

  #[test]
  fn parse_status_lists_what_a_merge_left_unmerged() {
    let p = parse_git_status("## main...origin/main [ahead 1, behind 1]\nUU app.txt\nUD \"odd \\\"name\\\".txt\"\n M other.txt\n");
    assert_eq!(p.changed_count, 3);
    let unmerged: Vec<(&str, &str)> = p.unmerged.iter().map(|(c, f)| (c.as_str(), f.as_str())).collect();
    assert_eq!(unmerged, [("UU", "app.txt"), ("UD", "odd \"name\".txt")]);
  }

  #[test]
  fn conflicts_are_named_from_the_app_folder() {
    assert_eq!(from_prefix("apps/explorer/src/a.ts", "apps/explorer/"), "src/a.ts");
    assert_eq!(from_prefix("shared/b.ts", "apps/explorer/"), "../../shared/b.ts");
    assert_eq!(from_prefix("a.ts", ""), "a.ts");
  }

  #[test]
  fn package_manifests_are_what_npm_installs_from() {
    for path in ["package.json", "rayfin/functions/package-lock.json", "npm-shrinkwrap.json"] {
      assert!(is_package_manifest(path), "{path}");
    }
    for path in ["node_modules/x/package.json", "src/package.ts", "yarn.lock", "README.md"] {
      assert!(!is_package_manifest(path), "{path}");
    }
  }

  #[test]
  fn branches_are_local_then_remote_ones_without_a_local_branch() {
    let refs = [
      "refs/heads/main\x1forigin/main",
      "refs/heads/topic\x1f",
      "refs/remotes/origin/HEAD\x1f",
      "refs/remotes/origin\x1f",
      "refs/remotes/origin/main\x1f",
      "refs/remotes/origin/topic\x1f",
      "refs/remotes/origin/feature\x1f",
    ]
    .join("\n");
    let names: Vec<(String, bool)> = parse_branches(&refs).into_iter().map(|b| (b.name, b.remote)).collect();
    assert_eq!(names, [("main".into(), false), ("topic".into(), false), ("origin/feature".into(), true)]);
  }

  /// A bare repository standing in for GitHub, and clones of it to work in.
  struct Origin {
    root: PathBuf,
    bare: PathBuf,
  }

  impl Origin {
    /// `main` holds the files in `files`.
    fn with(files: &[(&str, &str)]) -> Self {
      let root = std::env::temp_dir().join(format!("fab-sync-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&root).unwrap();
      let bare = root.join("origin.git");
      run_git(&root, &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
      let origin = Self { root, bare };
      let seed = origin.clone_as("seed");
      origin.commit(&seed, files, "First");
      run_git(&seed, &["push", "-q", "-u", "origin", "main"]);
      origin
    }

    fn clone_as(&self, name: &str) -> PathBuf {
      let dir = self.root.join(name);
      // Set while cloning, so a global core.autocrlf doesn't check files out changed.
      run_git(&self.root, &["clone", "-q", "-c", "core.autocrlf=false", self.bare.to_str().unwrap(), dir.to_str().unwrap()]);
      for (key, value) in [("user.name", "Test"), ("user.email", "test@example.invalid")] {
        run_git(&dir, &["config", key, value]);
      }
      dir
    }

    fn commit(&self, dir: &Path, files: &[(&str, &str)], message: &str) {
      for (path, text) in files {
        std::fs::write(dir.join(path), text).unwrap();
      }
      run_git(dir, &["add", "-A"]);
      run_git(dir, &["commit", "-qm", message]);
    }

    /// Someone else pushes `files` to `branch`.
    fn push(&self, branch: &str, files: &[(&str, &str)]) {
      let seed = self.root.join("seed");
      run_git(&seed, &["switch", "-q", branch]);
      run_git(&seed, &["pull", "-q", "--ff-only"]);
      self.commit(&seed, files, "Theirs");
      run_git(&seed, &["push", "-q"]);
    }
  }

  impl Drop for Origin {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.root);
    }
  }

  fn read(dir: &Path, path: &str) -> String {
    std::fs::read_to_string(dir.join(path)).unwrap()
  }

  #[tokio::test]
  async fn the_latest_changes_say_when_they_change_the_apps_packages() {
    let origin = Origin::with(&[("app.txt", "v1\n"), ("package.json", "{}\n")]);
    let me = origin.clone_as("me");
    let cwd = me.to_str().unwrap();

    origin.push("main", &[("app.txt", "v2\n")]);
    let pulled = pull_in(cwd).await;
    assert!(pulled.ok, "{:?}", pulled.error);
    assert!(!pulled.packages_changed);
    assert_eq!(read(&me, "app.txt"), "v2\n");

    origin.push("main", &[("package.json", "{ \"dependencies\": { \"zod\": \"^4.0.0\" } }\n")]);
    let pulled = pull_in(cwd).await;
    assert!(pulled.ok && pulled.packages_changed, "{:?}", pulled.error);
  }

  #[tokio::test]
  async fn overlapping_changes_merge_for_copilot_then_finish_or_cancel() {
    let origin = Origin::with(&[("app.txt", "base\n")]);
    let me = origin.clone_as("me");
    let cwd = me.to_str().unwrap();
    origin.push("main", &[("app.txt", "theirs\n")]);
    std::fs::write(me.join("app.txt"), "mine\n").unwrap();

    // Getting them leaves everything as it was, with your change saved.
    let pulled = pull_in(cwd).await;
    assert_eq!((pulled.ok, pulled.conflict), (false, Some(true)));
    assert!(!pulled.status.merging);
    assert_eq!(read(&me, "app.txt"), "mine\n");

    let merged = merge_latest_in(cwd).await;
    assert_eq!((merged.ok, merged.conflict), (false, Some(true)));
    assert!(merged.status.merging);
    assert_eq!(merged.status.conflicts, ["app.txt"]);
    assert!(read(&me, "app.txt").contains("<<<<<<<"));

    // Added with its markers still in, the file still has conflicts.
    run_git(&me, &["add", "app.txt"]);
    assert_eq!(status_in(cwd).await.conflicts, ["app.txt"]);
    let refused = finish_merge_in(cwd).await;
    assert_eq!((refused.ok, refused.conflict), (false, Some(true)));

    let cancelled = abort_merge_in(cwd).await;
    assert!(cancelled.ok && !cancelled.status.merging, "{:?}", cancelled.error);
    assert_eq!(read(&me, "app.txt"), "mine\n");

    merge_latest_in(cwd).await;
    // Resolved, though not added yet: ready to finish.
    std::fs::write(me.join("app.txt"), "mine and theirs\n").unwrap();
    let ready = status_in(cwd).await;
    assert!(ready.merging && ready.conflicts.is_empty(), "{:?}", ready.conflicts);
    let finished = finish_merge_in(cwd).await;
    assert!(finished.ok && !finished.status.merging, "{:?}", finished.error);
    let parents = run_git(&me, &["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(parents.split_whitespace().count(), 3, "a merge commit: {parents}");
    assert_eq!(finished.remote.behind, 0);
  }

  #[tokio::test]
  async fn switching_branches_saves_your_changes_and_follows_remote_ones() {
    let origin = Origin::with(&[("app.txt", "main\n"), ("package.json", "{}\n")]);
    let seed = origin.root.join("seed");
    run_git(&seed, &["switch", "-q", "-c", "feature"]);
    origin.commit(&seed, &[("app.txt", "feature\n"), ("package.json", "{ \"private\": true }\n")], "Feature");
    run_git(&seed, &["push", "-q", "-u", "origin", "feature"]);
    let me = origin.clone_as("me");
    let cwd = me.to_str().unwrap();

    let listed = branches_in(cwd).await;
    assert_eq!(listed.current.as_deref(), Some("main"));
    let names: Vec<&str> = listed.branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["main", "origin/feature"]);

    std::fs::write(me.join("app.txt"), "unsaved\n").unwrap();
    let switched = switch_in(cwd, "origin/feature").await;
    assert!(switched.ok && switched.packages_changed, "{:?}", switched.error);
    assert_eq!(switched.status.branch.as_deref(), Some("feature"));
    assert_eq!(run_git(&me, &["rev-parse", "--abbrev-ref", "feature@{u}"]), "origin/feature");
    assert_eq!(read(&me, "app.txt"), "feature\n");
    assert_eq!(run_git(&me, &["log", "-1", "--format=%s", "main"]), "Save before switching to feature");

    let back = switch_in(cwd, "main").await;
    assert!(back.ok && back.packages_changed, "{:?}", back.error);
    assert_eq!(read(&me, "app.txt"), "unsaved\n");
    let names: Vec<String> = branches_in(cwd).await.branches.into_iter().map(|b| b.name).collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(names.contains(&"feature".to_string()) && names.contains(&"main".to_string()));

    let missing = switch_in(cwd, "nope").await;
    assert_eq!(missing.error.as_deref(), Some("There’s no branch named nope."));
  }
}

fn revert_err(message: &str) -> RevertResult {
  RevertResult { ok: false, head: None, no_changes: None, error: Some(message.to_string()) }
}

/// Restore a team app: only its folder (`cwd`) goes back to `target_sha`, so the
/// workspace's other apps and shared files are untouched. Recorded as a new
/// commit by the user's own git identity (set on the team clone).
async fn revert_folder(cwd: &str, target_sha: &str, subject: &str) -> RevertResult {
  let dirty = git(cwd, &["status", "--porcelain", "--", "."]).await;
  if dirty.ok && !dirty.stdout.trim().is_empty() {
    git(cwd, &["add", "-A", "--", "."]).await;
    if !git(cwd, &["commit", "-m", "Save before restoring an earlier version"]).await.ok {
      return revert_err("Could not save your current changes before restoring.");
    }
  }
  let orig_res = git(cwd, &["rev-parse", "HEAD"]).await;
  let orig = orig_res.stdout.trim().to_string();
  if !orig_res.ok || orig.is_empty() {
    return revert_err("Could not read the current version.");
  }
  let source = format!("--source={target_sha}");
  let restored = git(cwd, &["restore", &source, "--staged", "--worktree", "--", "."]).await;
  if !restored.ok {
    let back = format!("--source={orig}");
    git(cwd, &["restore", &back, "--staged", "--worktree", "--", "."]).await;
    return revert_err("That version doesn’t include this app, so it can’t be restored.");
  }
  if git(cwd, &["diff", "--cached", "--quiet"]).await.ok {
    return RevertResult { ok: true, head: Some(orig), no_changes: Some(true), error: None };
  }
  let restore_msg = format!("Restore earlier version — {subject}");
  let commit = git(cwd, &["commit", "-m", &restore_msg]).await;
  if !commit.ok {
    let back = format!("--source={orig}");
    git(cwd, &["restore", &back, "--staged", "--worktree", "--", "."]).await;
    let e = commit.stderr.trim();
    return revert_err(if e.is_empty() { "Could not save the restored version." } else { e });
  }
  let head = git(cwd, &["rev-parse", "HEAD"]).await;
  RevertResult {
    ok: true,
    head: head.ok.then(|| head.stdout.trim().to_string()).filter(|h| !h.is_empty()),
    no_changes: None,
    error: None,
  }
}

pub async fn git_revert(id: String, reference: String) -> RevertResult {
  let Some(project) = find_project(&id) else {
    return revert_err("Project not found.");
  };
  let cwd = project.path;

  if reference.is_empty() || reference == GIT_WORKING_REF {
    return revert_err("Pick a saved version to restore.");
  }

  let inside = git(&cwd, &["rev-parse", "--is-inside-work-tree"]).await;
  if !inside.ok || inside.stdout.trim() != "true" {
    return revert_err("This project isn’t tracked by git, so there’s nothing to restore.");
  }

  let target = git(&cwd, &["rev-parse", "--verify", &format!("{reference}^{{commit}}")]).await;
  if !target.ok || target.stdout.trim().is_empty() {
    return revert_err("That version no longer exists.");
  }
  let target_sha = target.stdout.trim().to_string();
  let subject_res = git(&cwd, &["log", "-1", "--pretty=%s", &target_sha]).await;
  let subject = if subject_res.ok && !subject_res.stdout.trim().is_empty() {
    subject_res.stdout.trim().to_string()
  } else {
    target_sha[..target_sha.len().min(7)].to_string()
  };

  if project.team.is_some() {
    return revert_folder(&cwd, &target_sha, &subject).await;
  }

  // 1) Don't lose uncommitted work — commit it first.
  let dirty = git(&cwd, &["status", "--porcelain"]).await;
  if dirty.ok && !dirty.stdout.trim().is_empty() {
    git(&cwd, &["add", "-A"]).await;
    let mut args: Vec<&str> = COMMIT_IDENT.to_vec();
    args.extend_from_slice(&["commit", "-m", "Save before restoring an earlier version"]);
    let saved = git(&cwd, &args).await;
    if !saved.ok {
      return revert_err("Could not save your current changes before restoring.");
    }
  }

  let orig_res = git(&cwd, &["rev-parse", "HEAD"]).await;
  if !orig_res.ok || orig_res.stdout.trim().is_empty() {
    return revert_err("Could not read the current version.");
  }
  let orig = orig_res.stdout.trim().to_string();
  if orig == target_sha {
    return RevertResult { ok: true, head: Some(orig), no_changes: Some(true), error: None };
  }

  // 2) Make the working tree + index exactly match the target tree…
  let hard = git(&cwd, &["reset", "--hard", &target_sha]).await;
  if !hard.ok {
    let e = hard.stderr.trim();
    return revert_err(if e.is_empty() { "Could not restore that version." } else { e });
  }
  // 3) …then move the branch pointer back so the change becomes a new commit.
  let soft = git(&cwd, &["reset", "--soft", &orig]).await;
  if !soft.ok {
    git(&cwd, &["reset", "--hard", &orig]).await;
    let e = soft.stderr.trim();
    return revert_err(if e.is_empty() { "Could not restore that version." } else { e });
  }

  let staged = git(&cwd, &["diff", "--cached", "--quiet"]).await;
  if staged.ok {
    return RevertResult { ok: true, head: Some(orig), no_changes: Some(true), error: None };
  }

  let restore_msg = format!("Restore earlier version — {subject}");
  let mut args: Vec<&str> = COMMIT_IDENT.to_vec();
  args.extend_from_slice(&["commit", "-m", &restore_msg]);
  let commit = git(&cwd, &args).await;
  if !commit.ok {
    git(&cwd, &["reset", "--hard", &orig]).await;
    let e = commit.stderr.trim();
    return revert_err(if e.is_empty() { "Could not save the restored version." } else { e });
  }
  let new_head = git(&cwd, &["rev-parse", "HEAD"]).await;
  RevertResult {
    ok: true,
    head: if new_head.ok {
      let h = new_head.stdout.trim().to_string();
      if h.is_empty() { None } else { Some(h) }
    } else {
      None
    },
    no_changes: None,
    error: None,
  }
}

/* ------------------------------ remote sync ------------------------------- */

/// Options for a (possibly networked) git command: a longer timeout plus a
/// non-interactive environment so a missing credential fails fast instead of
/// hanging on a terminal/GUI prompt (stdin is already null'd by `exec::run`).
fn net_opts(cwd: &str) -> RunOptions {
  RunOptions {
    cwd: Some(PathBuf::from(cwd)),
    timeout_ms: Some(90_000),
    env: vec![
      ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
      ("GCM_INTERACTIVE".to_string(), "never".to_string()),
    ],
    ..Default::default()
  }
}

/// Run a network-touching git command (fetch/pull/push) with [`net_opts`]. A
/// project whose GitHub repository Fabricator created reaches it as the account
/// that created it (see [`network_auth`]); any other uses git's own credentials.
async fn git_net(cwd: &str, args: &[&str]) -> Git {
  let mut full: Vec<String> = vec!["-c".into(), "core.quotepath=false".into()];
  let mut opts = net_opts(cwd);
  match network_auth(cwd).await {
    Some(Ok(auth)) => {
      full.extend(auth.args);
      opts.env.extend(auth.env);
      opts.env_remove.extend(["GH_TOKEN".to_string(), "GITHUB_TOKEN".to_string()]);
    }
    Some(Err(message)) => return Git { ok: false, stdout: String::new(), stderr: message },
    None => {}
  }
  full.extend(args.iter().map(|a| a.to_string()));
  let refs: Vec<&str> = full.iter().map(String::as_str).collect();
  let res = run(&refs, opts).await;
  Git { ok: res.ok, stdout: res.stdout, stderr: res.stderr }
}

/// Parse `git rev-list --left-right --count @{u}...HEAD` into `(behind, ahead)`.
/// The left count is commits on the upstream but not local (pullable / behind);
/// the right count is local commits not on the upstream (pushable / ahead).
fn parse_ahead_behind(stdout: &str) -> (u32, u32) {
  let mut it = stdout.split_whitespace();
  let behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
  let ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
  (behind, ahead)
}

/// Current branch name, or `None` when detached / unborn.
async fn current_branch(cwd: &str) -> Option<String> {
  let r = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
  let b = r.stdout.trim();
  if r.ok && !b.is_empty() && b != "HEAD" {
    Some(b.to_string())
  } else {
    None
  }
}

/// True when the current branch has an upstream/tracking branch configured.
async fn has_upstream(cwd: &str) -> bool {
  let u = git(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await;
  u.ok && !u.stdout.trim().is_empty()
}

/// Build a [`GitRemoteStatus`] for the project, optionally running `git fetch`
/// first to refresh the remote-tracking refs. When `do_fetch` is false this is a
/// fast, network-free read of the already-known divergence.
async fn compute_remote_status(cwd: &str, do_fetch: bool) -> GitRemoteStatus {
  let mut out = GitRemoteStatus::default();

  let inside = git(cwd, &["rev-parse", "--is-inside-work-tree"]).await;
  if !inside.ok || inside.stdout.trim() != "true" {
    return out;
  }
  out.is_repo = true;
  out.branch = current_branch(cwd).await;

  let remotes = git(cwd, &["remote"]).await;
  out.has_remote = remotes.ok && !remotes.stdout.trim().is_empty();
  if !out.has_remote {
    return out;
  }

  if do_fetch {
    let fetched = git_net(cwd, &["fetch", "--no-tags", "--quiet"]).await;
    if !fetched.ok {
      let e = fetched.stderr.trim();
      out.fetch_error =
        Some(if e.is_empty() { "Could not reach the remote.".to_string() } else { e.to_string() });
    }
  }

  out.has_upstream = has_upstream(cwd).await;
  if !out.has_upstream {
    return out;
  }

  let counts = git(cwd, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]).await;
  if counts.ok {
    let (behind, ahead) = parse_ahead_behind(&counts.stdout);
    out.behind = behind;
    out.ahead = ahead;
  }
  out
}

pub async fn git_remote_status(id: String) -> GitRemoteStatus {
  let Some(project) = find_project(&id) else {
    return GitRemoteStatus::default();
  };
  if !Path::new(&project.path).exists() {
    return GitRemoteStatus::default();
  }
  compute_remote_status(&project.path, true).await
}

pub async fn git_divergence(id: String) -> GitRemoteStatus {
  let Some(project) = find_project(&id) else {
    return GitRemoteStatus::default();
  };
  if !Path::new(&project.path).exists() {
    return GitRemoteStatus::default();
  }
  compute_remote_status(&project.path, false).await
}

fn no_repo_status() -> GitStatus {
  GitStatus::default()
}

/// Team projects sync through their working branch (see `commands::team`).
const TEAM_SYNC: &str = "Fabricator saves this team app to GitHub for you after each change. Use Update and Publish instead.";
const MERGING: &str = "A merge is waiting to be finished. Finish it or cancel it first.";
const STILL_CONFLICTED: &str = "Some files still have conflicts. Resolve them, or cancel the merge, first.";
const OVERLAP: &str = "Your changes and the latest changes overlap and couldn’t be combined automatically.";

fn sync_err(message: &str, status: GitStatus, remote: GitRemoteStatus) -> GitSyncResult {
  GitSyncResult { ok: false, error: Some(message.to_string()), conflict: None, packages_changed: false, status, remote }
}

/// What git said went wrong, in a line.
fn reason(res: &Git) -> String {
  let said = [res.stderr.as_str(), res.stdout.as_str()]
    .into_iter()
    .flat_map(str::lines)
    .map(str::trim)
    .find(|line| !line.is_empty())
    .unwrap_or("git gave no reason.");
  let said = said.strip_prefix("error: ").or_else(|| said.strip_prefix("fatal: ")).unwrap_or(said);
  said.chars().take(300).collect()
}

/// The commit `HEAD` names, or "" when there's none yet.
async fn head(cwd: &str) -> String {
  let res = git(cwd, &["rev-parse", "HEAD"]).await;
  if res.ok { res.stdout.trim().to_string() } else { String::new() }
}

/// A `package.json` or npm lockfile, outside `node_modules`: a change to one
/// changes what `npm install` puts there.
fn is_package_manifest(path: &str) -> bool {
  let path = path.trim().replace('\\', "/");
  if path.split('/').any(|part| part == "node_modules") {
    return false;
  }
  let name = path.rsplit('/').next().unwrap_or(&path);
  matches!(name, "package.json" | "package-lock.json" | "npm-shrinkwrap.json")
}

/// Whether going from commit `before` to `after` changed the app's packages.
pub(crate) async fn packages_changed(cwd: &str, before: &str, after: &str) -> bool {
  if before.is_empty() || after.is_empty() || before == after {
    return false;
  }
  let diff = git(cwd, &["diff", "--name-only", "--relative", before, after, "--", "."]).await;
  diff.ok && diff.stdout.lines().any(is_package_manifest)
}

/// Commit any uncommitted changes first, so none are lost (as Restore does).
async fn save_first(cwd: &str, message: &str) -> bool {
  let dirty = git(cwd, &["status", "--porcelain"]).await;
  if !dirty.ok || dirty.stdout.trim().is_empty() {
    return true;
  }
  git(cwd, &["add", "-A"]).await;
  let mut args: Vec<&str> = COMMIT_IDENT.to_vec();
  args.extend_from_slice(&["commit", "-m", message]);
  git(cwd, &args).await.ok
}

/// A sync that went through from commit `before`: where things stand after it,
/// and whether it changed the app's packages.
async fn synced(cwd: &str, before: &str) -> GitSyncResult {
  let after = head(cwd).await;
  GitSyncResult {
    ok: true,
    error: None,
    conflict: None,
    packages_changed: packages_changed(cwd, before, &after).await,
    status: status_in(cwd).await,
    remote: compute_remote_status(cwd, false).await,
  }
}

/// A merge that stopped at conflicts, for Copilot or you to resolve.
async fn conflicted(cwd: &str, status: GitStatus) -> GitSyncResult {
  let count = status.conflicts.len();
  GitSyncResult {
    ok: false,
    error: Some(format!(
      "Your changes and the latest changes overlap in {count} file{}.",
      if count == 1 { "" } else { "s" }
    )),
    conflict: Some(true),
    packages_changed: false,
    status,
    remote: compute_remote_status(cwd, false).await,
  }
}

/// The folder of the personal app `id` names, in a git repository, or why it
/// can't sync. Team apps sync through their working branch instead.
async fn sync_folder(id: &str) -> Result<String, Box<GitSyncResult>> {
  let Some(project) = find_project(id) else {
    return Err(Box::new(sync_err("Project folder not found.", no_repo_status(), GitRemoteStatus::default())));
  };
  if project.team.is_some() {
    return Err(Box::new(sync_err(TEAM_SYNC, status_in(&project.path).await, GitRemoteStatus::default())));
  }
  if !Path::new(&project.path).exists() {
    return Err(Box::new(sync_err("Project folder not found.", no_repo_status(), GitRemoteStatus::default())));
  }
  let inside = git(&project.path, &["rev-parse", "--is-inside-work-tree"]).await;
  if !inside.ok || inside.stdout.trim() != "true" {
    return Err(Box::new(sync_err(
      "This project isn’t tracked by git.",
      status_in(&project.path).await,
      GitRemoteStatus::default(),
    )));
  }
  Ok(project.path)
}

pub async fn git_pull(id: String) -> GitSyncResult {
  match sync_folder(&id).await {
    Ok(cwd) => pull_in(&cwd).await,
    Err(result) => *result,
  }
}

/// Get the latest changes: fast-forward when possible, else rebase your
/// commits onto them. When they overlap, everything goes back as it was and
/// the result says so; [`merge_latest_in`] then merges them for Copilot.
async fn pull_in(cwd: &str) -> GitSyncResult {
  if merging(cwd).await {
    return sync_err(MERGING, status_in(cwd).await, compute_remote_status(cwd, false).await);
  }
  if !has_upstream(cwd).await {
    return sync_err(
      "This branch isn’t linked to a remote branch yet.",
      status_in(cwd).await,
      compute_remote_status(cwd, false).await,
    );
  }
  if !save_first(cwd, "Save before getting the latest changes").await {
    return sync_err(
      "Could not save your current changes before updating.",
      status_in(cwd).await,
      compute_remote_status(cwd, false).await,
    );
  }

  // Refresh remote-tracking refs before merging.
  let fetched = git_net(cwd, &["fetch", "--no-tags", "--quiet"]).await;
  if !fetched.ok {
    let e = fetched.stderr.trim();
    return sync_err(
      if e.is_empty() { "Could not reach the remote." } else { e },
      status_in(cwd).await,
      compute_remote_status(cwd, false).await,
    );
  }

  // Fast-forward when possible; fall back to a rebase when histories diverged.
  let before = head(cwd).await;
  let ff = git(cwd, &["merge", "--ff-only", "@{u}"]).await;
  if !ff.ok {
    let rebased = git(cwd, &["rebase", "@{u}"]).await;
    if !rebased.ok {
      // Leave no half-applied state: abort and restore exactly where we were.
      git(cwd, &["rebase", "--abort"]).await;
      if !before.is_empty() {
        git(cwd, &["reset", "--hard", &before]).await;
      }
      return GitSyncResult {
        ok: false,
        error: Some(OVERLAP.to_string()),
        conflict: Some(true),
        packages_changed: false,
        status: status_in(cwd).await,
        remote: compute_remote_status(cwd, false).await,
      };
    }
  }
  synced(cwd, &before).await
}

/// After a pull found that your changes and the latest ones overlap: merge the
/// latest changes in, leaving git's conflict markers for Copilot (or you) to
/// resolve. A merge that goes through on its own is simply done.
pub async fn git_merge_latest(id: String) -> GitSyncResult {
  match sync_folder(&id).await {
    Ok(cwd) => merge_latest_in(&cwd).await,
    Err(result) => *result,
  }
}

async fn merge_latest_in(cwd: &str) -> GitSyncResult {
  let status = status_in(cwd).await;
  if status.merging {
    return if status.conflicts.is_empty() {
      sync_err(MERGING, status, compute_remote_status(cwd, false).await)
    } else {
      conflicted(cwd, status).await
    };
  }
  if !has_upstream(cwd).await {
    return sync_err(
      "This branch isn’t linked to a remote branch yet.",
      status,
      compute_remote_status(cwd, false).await,
    );
  }
  if !save_first(cwd, "Save before getting the latest changes").await {
    return sync_err(
      "Could not save your current changes before updating.",
      status_in(cwd).await,
      compute_remote_status(cwd, false).await,
    );
  }
  // Whoever finishes the merge, Copilot included, commits it.
  version_history::ensure_identity(Path::new(cwd)).await;
  let before = head(cwd).await;
  let merged = git(cwd, &["merge", "--no-edit", "@{u}"]).await;
  if merged.ok {
    return synced(cwd, &before).await;
  }
  let status = status_in(cwd).await;
  if status.merging && !status.conflicts.is_empty() {
    return conflicted(cwd, status).await;
  }
  // It stopped for another reason, such as files it would overwrite: leave nothing half done.
  if status.merging {
    git(cwd, &["merge", "--abort"]).await;
  }
  sync_err(
    &format!("Couldn’t combine the latest changes: {}", reason(&merged)),
    status_in(cwd).await,
    compute_remote_status(cwd, false).await,
  )
}

/// Finish a merge whose conflicts are all resolved: commit it, with git's message.
pub async fn git_finish_merge(id: String) -> GitSyncResult {
  match sync_folder(&id).await {
    Ok(cwd) => finish_merge_in(&cwd).await,
    Err(result) => *result,
  }
}

async fn finish_merge_in(cwd: &str) -> GitSyncResult {
  let status = status_in(cwd).await;
  if !status.merging {
    return synced(cwd, "").await;
  }
  if !status.conflicts.is_empty() {
    let mut result = conflicted(cwd, status).await;
    result.error = Some(STILL_CONFLICTED.to_string());
    return result;
  }
  version_history::ensure_identity(Path::new(cwd)).await;
  let before = head(cwd).await;
  let added = git(cwd, &["add", "-A"]).await;
  let committed = if added.ok { git(cwd, &["commit", "--no-edit"]).await } else { added };
  if !committed.ok {
    return sync_err(
      &format!("Couldn’t finish the merge: {}", reason(&committed)),
      status_in(cwd).await,
      compute_remote_status(cwd, false).await,
    );
  }
  synced(cwd, &before).await
}

/// Cancel a merge: everything goes back to how it was before it started.
pub async fn git_abort_merge(id: String) -> GitSyncResult {
  match sync_folder(&id).await {
    Ok(cwd) => abort_merge_in(&cwd).await,
    Err(result) => *result,
  }
}

async fn abort_merge_in(cwd: &str) -> GitSyncResult {
  if !merging(cwd).await {
    return synced(cwd, "").await;
  }
  // Packages installed for the merged package.json go back out with it.
  let touched = git(cwd, &["diff", "--name-only", "--relative", "HEAD", "--", "."]).await;
  let packages = touched.ok && touched.stdout.lines().any(is_package_manifest);
  let aborted = git(cwd, &["merge", "--abort"]).await;
  if !aborted.ok {
    return sync_err(
      &format!("Couldn’t cancel the merge: {}", reason(&aborted)),
      status_in(cwd).await,
      compute_remote_status(cwd, false).await,
    );
  }
  let mut result = synced(cwd, "").await;
  result.packages_changed = packages;
  result
}

/// The branches to switch to (see [`GitBranches`]).
pub async fn git_branches(id: String) -> GitBranches {
  match sync_folder(&id).await {
    Ok(cwd) => branches_in(&cwd).await,
    Err(_) => GitBranches::default(),
  }
}

async fn branches_in(cwd: &str) -> GitBranches {
  let refs = git(
    cwd,
    &["for-each-ref", "--sort=-committerdate", "--format=%(refname)%1f%(upstream:short)", "refs/heads", "refs/remotes"],
  )
  .await;
  GitBranches {
    current: current_branch(cwd).await,
    branches: if refs.ok { parse_branches(&refs.stdout) } else { Vec::new() },
  }
}

/// `git for-each-ref` lines (`<refname>\x1f<upstream>`) as branches: the local
/// ones, then the remote ones no local branch follows or shares a name with.
fn parse_branches(stdout: &str) -> Vec<GitBranch> {
  let mut local = Vec::new();
  let mut remote = Vec::new();
  for line in stdout.lines() {
    let mut fields = line.trim_end_matches('\r').split('\x1f');
    let Some(full) = fields.next() else { continue };
    let upstream = fields.next().map(str::trim).filter(|u| !u.is_empty()).map(str::to_string);
    if let Some(name) = full.strip_prefix("refs/heads/") {
      local.push(GitBranch { name: name.to_string(), upstream, remote: false });
    } else if let Some(name) = full.strip_prefix("refs/remotes/") {
      if name.contains('/') && !name.ends_with("/HEAD") {
        remote.push(GitBranch { name: name.to_string(), upstream: None, remote: true });
      }
    }
  }
  remote.retain(|r| {
    let short = r.name.split_once('/').map_or(r.name.as_str(), |(_, name)| name);
    !local.iter().any(|l| l.upstream.as_deref() == Some(r.name.as_str()) || l.name == short)
  });
  local.extend(remote);
  local
}

/// Switch to `branch`, a local branch or a remote one (which gets a local
/// branch that follows it), saving any uncommitted changes on the current
/// branch first.
pub async fn git_switch(id: String, branch: String) -> GitSyncResult {
  match sync_folder(&id).await {
    Ok(cwd) => switch_in(&cwd, branch.trim()).await,
    Err(result) => *result,
  }
}

async fn switch_in(cwd: &str, branch: &str) -> GitSyncResult {
  if merging(cwd).await {
    return sync_err(MERGING, status_in(cwd).await, compute_remote_status(cwd, false).await);
  }
  let known = branches_in(cwd).await;
  let Some(target) = known.branches.into_iter().find(|b| b.name == branch) else {
    return sync_err(
      &format!("There’s no branch named {branch}."),
      status_in(cwd).await,
      compute_remote_status(cwd, false).await,
    );
  };
  let name = if target.remote {
    target.name.split_once('/').map_or(target.name.as_str(), |(_, name)| name)
  } else {
    target.name.as_str()
  };
  let before = head(cwd).await;
  if known.current.as_deref() == Some(name) {
    return synced(cwd, &before).await;
  }
  if !save_first(cwd, &format!("Save before switching to {name}")).await {
    return sync_err(
      "Could not save your current changes before switching.",
      status_in(cwd).await,
      compute_remote_status(cwd, false).await,
    );
  }
  let before = head(cwd).await;
  let switched = if target.remote {
    git(cwd, &["switch", "--track", &target.name]).await
  } else {
    git(cwd, &["switch", &target.name]).await
  };
  if !switched.ok {
    return sync_err(
      &format!("Couldn’t switch to {name}: {}", reason(&switched)),
      status_in(cwd).await,
      compute_remote_status(cwd, false).await,
    );
  }
  synced(cwd, &before).await
}

pub async fn git_push(id: String) -> GitSyncResult {
  let Some(project) = find_project(&id) else {
    return sync_err("Project folder not found.", no_repo_status(), GitRemoteStatus::default());
  };
  if project.team.is_some() {
    return sync_err(TEAM_SYNC, git_status(id.clone()).await, GitRemoteStatus::default());
  }
  if !Path::new(&project.path).exists() {
    return sync_err("Project folder not found.", no_repo_status(), GitRemoteStatus::default());
  }
  let cwd = project.path.clone();

  let inside = git(&cwd, &["rev-parse", "--is-inside-work-tree"]).await;
  if !inside.ok || inside.stdout.trim() != "true" {
    return sync_err("This project isn’t tracked by git.", git_status(id.clone()).await, GitRemoteStatus::default());
  }
  // Per product decision: only push when an upstream already exists.
  if !has_upstream(&cwd).await {
    return sync_err(
      "This branch isn’t linked to a remote branch yet.",
      git_status(id.clone()).await,
      compute_remote_status(&cwd, false).await,
    );
  }

  let pushed = git_net(&cwd, &["push"]).await;
  if !pushed.ok {
    let combined = format!("{}\n{}", pushed.stdout, pushed.stderr);
    let rejected = Regex::new(r"(?i)rejected|non-fast-forward|fetch first").unwrap().is_match(&combined);
    let e = combined.trim().to_string();
    return GitSyncResult {
      ok: false,
      error: Some(if rejected {
        "The remote has changes you don’t have yet. Get the latest changes first, then push again.".to_string()
      } else if e.is_empty() {
        "Could not push your changes.".to_string()
      } else {
        e
      }),
      conflict: None,
      packages_changed: false,
      status: git_status(id.clone()).await,
      remote: compute_remote_status(&cwd, false).await,
    };
  }

  GitSyncResult {
    ok: true,
    error: None,
    conflict: None,
    packages_changed: false,
    status: git_status(id.clone()).await,
    remote: compute_remote_status(&cwd, false).await,
  }
}
