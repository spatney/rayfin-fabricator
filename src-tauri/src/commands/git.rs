//! Git status, commits, branch switching, sync, and history/diffs.
//! Branch switching and sync affect the containing repository, including when
//! the project is a subfolder.

use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;

use crate::commands::util::{looks_binary, safe_resolve};
use crate::services::exec::RunOptions;
use crate::services::git::run;
use crate::services::store::find_project;
use crate::types::{
  GitBranch, GitChange, GitCommitResult, GitCommitSummary, GitFileDiff, GitHistory, GitRemoteStatus, GitStatus,
  GitSyncResult, RevertResult,
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
}

/// Parse `git status --porcelain=v1 --branch` into branch + change count.
fn parse_git_status(stdout: &str) -> ParsedStatus {
  let mut branch: Option<String> = None;
  let mut no_commits = false;
  let mut changed_count = 0u32;
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
    }
  }
  ParsedStatus {
    branch,
    changed_count,
    no_commits,
  }
}

pub async fn git_status(id: String) -> GitStatus {
  let Some(project) = find_project(&id) else {
    return GitStatus { is_repo: false, branch: None, changed_count: 0, no_commits: None };
  };
  if !Path::new(&project.path).exists() {
    return GitStatus { is_repo: false, branch: None, changed_count: 0, no_commits: None };
  }
  let res = git(&project.path, &["status", "--porcelain=v1", "--branch"]).await;
  if !res.ok {
    return GitStatus { is_repo: false, branch: None, changed_count: 0, no_commits: None };
  }
  let parsed = parse_git_status(&res.stdout);
  GitStatus {
    is_repo: true,
    branch: parsed.branch,
    changed_count: parsed.changed_count,
    no_commits: if parsed.no_commits { Some(true) } else { None },
  }
}

/* -------------------------------- branches -------------------------------- */

fn git_error(result: &Git, fallback: &str) -> String {
  let message = format!("{}\n{}", result.stderr, result.stdout);
  if message.trim().is_empty() { fallback.to_string() } else { message.trim().to_string() }
}

async fn branches_in(cwd: &str) -> Result<Vec<GitBranch>, String> {
  let result = git(cwd, &[
    "for-each-ref", "--sort=refname", "--format=%(refname)%00%(symref)%00%(HEAD)",
    "refs/heads/", "refs/remotes/",
  ]).await;
  if !result.ok {
    return Err(git_error(&result, "Could not list branches."));
  }
  Ok(result.stdout.lines().filter_map(|line| {
    let mut fields = line.split('\0');
    let ref_name = fields.next()?;
    let symbolic = fields.next()?;
    let current = fields.next()? == "*";
    if !symbolic.is_empty() {
      return None;
    }
    let (name, remote) = if let Some(name) = ref_name.strip_prefix("refs/heads/") {
      (name, false)
    } else {
      (ref_name.strip_prefix("refs/remotes/")?, true)
    };
    Some(GitBranch { ref_name: ref_name.into(), name: name.into(), remote, current })
  }).collect())
}

pub async fn git_branches(id: String) -> Result<Vec<GitBranch>, String> {
  let project = find_project(&id).ok_or("Project folder not found.")?;
  branches_in(&project.path).await
}

async fn switch_branch_in(cwd: &str, ref_name: &str) -> Result<(), String> {
  let branch = branches_in(cwd).await?.into_iter().find(|b| b.ref_name == ref_name)
    .ok_or("That branch no longer exists. Reopen the branch picker and try again.")?;
  if branch.current {
    return Ok(());
  }
  // Porcelain v1 includes the whole repository, even from a project subfolder.
  let status = git(cwd, &["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]).await;
  if !status.ok {
    return Err(git_error(&status, "Could not check the repository for uncommitted changes."));
  }
  if !status.stdout.trim().is_empty() {
    return Err("Commit or stash all changes in this repository before switching branches, including changes outside this project folder.".into());
  }

  let prefix = git(cwd, &["rev-parse", "--show-prefix"]).await;
  if !prefix.ok {
    return Err(git_error(&prefix, "Could not locate the project in its repository."));
  }
  let relative = prefix.stdout.trim().trim_end_matches('/');
  if !relative.is_empty() {
    let target = format!("{ref_name}:{relative}");
    let folder = git(cwd, &["cat-file", "-t", &target]).await;
    if !folder.ok || folder.stdout.trim() != "tree" {
      return Err("This project folder does not exist on that branch. Switch to a branch that contains this project.".into());
    }
  }

  let result = if branch.remote {
    // Ask Git for the configured remote rather than assuming it is named origin.
    let remotes = git(cwd, &["remote"]).await;
    if !remotes.ok {
      return Err(git_error(&remotes, "Could not list repository remotes."));
    }
    let remote = remotes.stdout.lines()
      .filter(|r| branch.name.starts_with(&format!("{r}/")))
      .max_by_key(|r| r.len())
      .ok_or("The remote for that branch is no longer configured.")?;
    let local = &branch.name[remote.len() + 1..];
    git(cwd, &["switch", "--track", "--create", local, &branch.ref_name]).await
  } else {
    git(cwd, &["switch", "--no-guess", "--", &branch.name]).await
  };
  if !result.ok {
    return Err(git_error(&result, "Could not switch branches."));
  }
  Ok(())
}

pub async fn git_switch_branch(id: String, ref_name: String) -> Result<GitStatus, String> {
  let project = find_project(&id).ok_or("Project folder not found.")?;
  if project.team.is_some() {
    return Err("Team apps use a managed working branch. Use the team workflow instead.".into());
  }
  switch_branch_in(&project.path, &ref_name).await?;
  Ok(git_status(id).await)
}

pub async fn git_commit(id: String, message: String) -> GitCommitResult {
  let no_repo = || GitStatus { is_repo: false, branch: None, changed_count: 0, no_commits: None };
  let Some(project) = find_project(&id) else {
    return GitCommitResult { ok: false, error: Some("Project folder not found.".into()), status: no_repo() };
  };
  if !Path::new(&project.path).exists() {
    return GitCommitResult { ok: false, error: Some("Project folder not found.".into()), status: no_repo() };
  }
  let msg = message.trim().to_string();
  if msg.is_empty() {
    return GitCommitResult { ok: false, error: Some("Enter a commit message.".into()), status: git_status(id).await };
  }
  let dir = project.path.clone();

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
  async fn branch_switch_from_nested_project_updates_the_containing_repo() {
    let repo = TestRepo::new();
    let app = repo.dir.join("apps").join("my app");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::write(app.join("app.txt"), "main\n").unwrap();
    run_git(&repo.dir, &["add", "-A"]);
    run_git(&repo.dir, &["commit", "-qm", "First"]);
    run_git(&repo.dir, &["switch", "-c", "feature/report"]);
    std::fs::write(app.join("app.txt"), "feature\n").unwrap();
    run_git(&repo.dir, &["commit", "-qam", "Feature"]);
    run_git(&repo.dir, &["switch", "main"]);
    let cwd = app.to_str().unwrap();
    let branches = branches_in(cwd).await.unwrap();
    assert_eq!(branches.len(), 2);
    assert!(branches.iter().any(|b| b.name == "main" && b.current && !b.remote));
    switch_branch_in(cwd, "refs/heads/feature/report").await.unwrap();
    assert_eq!(run_git(&repo.dir, &["branch", "--show-current"]), "feature/report");
    assert_eq!(std::fs::read_to_string(app.join("app.txt")).unwrap(), "feature\n");
    assert!(switch_branch_in(cwd, "refs/heads/missing").await.unwrap_err().contains("no longer exists"));
    assert!(switch_branch_in(cwd, "--discard-changes").await.is_err());
  }

  #[tokio::test]
  async fn branch_switch_blocks_all_repo_changes_including_siblings() {
    let repo = TestRepo::new();
    let app = repo.dir.join("app");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::write(app.join("app.txt"), "main\n").unwrap();
    std::fs::write(repo.dir.join("sibling.txt"), "original\n").unwrap();
    run_git(&repo.dir, &["add", "-A"]);
    run_git(&repo.dir, &["commit", "-qm", "First"]);
    run_git(&repo.dir, &["branch", "feature"]);
    let cwd = app.to_str().unwrap();
    for mode in ["unstaged", "staged", "untracked"] {
      let path = if mode == "untracked" { repo.dir.join("new.txt") } else { repo.dir.join("sibling.txt") };
      std::fs::write(&path, "keep me\n").unwrap();
      if mode == "staged" {
        run_git(&repo.dir, &["add", "-A"]);
      }
      let error = switch_branch_in(cwd, "refs/heads/feature").await.unwrap_err();
      assert!(error.contains("Commit or stash"), "{mode}: {error}");
      assert_eq!(run_git(&repo.dir, &["branch", "--show-current"]), "main");
      assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep me\n");
      if mode == "untracked" {
        std::fs::remove_file(path).unwrap();
      } else {
        std::fs::write(path, "original\n").unwrap();
        run_git(&repo.dir, &["add", "-A"]);
      }
    }
  }

  #[tokio::test]
  async fn branch_switch_tracks_remote_branches_and_skips_symbolic_head() {
    let repo = TestRepo::new();
    std::fs::write(repo.dir.join("app.txt"), "main\n").unwrap();
    run_git(&repo.dir, &["add", "-A"]);
    run_git(&repo.dir, &["commit", "-qm", "First"]);
    run_git(&repo.dir, &["remote", "add", "ado", repo.root.join("remote.git").to_str().unwrap()]);
    run_git(&repo.dir, &["update-ref", "refs/remotes/ado/feature/report", "HEAD"]);
    run_git(&repo.dir, &["symbolic-ref", "refs/remotes/ado/HEAD", "refs/remotes/ado/feature/report"]);
    let cwd = repo.dir.to_str().unwrap();
    let branches = branches_in(cwd).await.unwrap();
    assert_eq!(branches.len(), 2);
    assert!(branches.iter().any(|b| b.name == "ado/feature/report" && b.remote && !b.current));
    switch_branch_in(cwd, "refs/remotes/ado/feature/report").await.unwrap();
    assert_eq!(run_git(&repo.dir, &["branch", "--show-current"]), "feature/report");
    assert_eq!(run_git(&repo.dir, &["rev-parse", "--abbrev-ref", "@{u}"]), "ado/feature/report");
    run_git(&repo.dir, &["switch", "main"]);
    assert!(switch_branch_in(cwd, "refs/remotes/ado/feature/report").await.is_err());
    assert_eq!(run_git(&repo.dir, &["branch", "--show-current"]), "main");
  }

  #[tokio::test]
  async fn branch_switch_rejects_missing_project_and_checked_out_worktree_branch() {
    let repo = TestRepo::new();
    std::fs::write(repo.dir.join("root.txt"), "main\n").unwrap();
    run_git(&repo.dir, &["add", "-A"]);
    run_git(&repo.dir, &["commit", "-qm", "Root"]);
    run_git(&repo.dir, &["branch", "without-app"]);
    let app = repo.dir.join("app");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::write(app.join("app.txt"), "app\n").unwrap();
    run_git(&repo.dir, &["add", "-A"]);
    run_git(&repo.dir, &["commit", "-qm", "App"]);
    let error = switch_branch_in(app.to_str().unwrap(), "refs/heads/without-app").await.unwrap_err();
    assert!(error.contains("project folder does not exist"));
    let worktree = repo.root.join("worktree");
    run_git(&repo.dir, &["worktree", "add", "-q", "-b", "other", worktree.to_str().unwrap()]);
    assert!(switch_branch_in(app.to_str().unwrap(), "refs/heads/other").await.is_err());
    assert_eq!(run_git(&repo.dir, &["branch", "--show-current"]), "main");
    // Switching from a linked worktree uses its own HEAD, not the main worktree's.
    run_git(&worktree, &["branch", "available"]);
    switch_branch_in(worktree.join("app").to_str().unwrap(), "refs/heads/available").await.unwrap();
    assert_eq!(run_git(&worktree, &["branch", "--show-current"]), "available");
    assert_eq!(run_git(&repo.dir, &["branch", "--show-current"]), "main");
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

/// Run a network-touching git command (fetch/pull/push) with [`net_opts`].
async fn git_net(cwd: &str, args: &[&str]) -> Git {
  let mut full: Vec<&str> = vec!["-c", "core.quotepath=false"];
  full.extend_from_slice(args);
  let res = run(&full, net_opts(cwd)).await;
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
  GitStatus { is_repo: false, branch: None, changed_count: 0, no_commits: None }
}

/// Team projects sync through their working branch (see `commands::team`).
const TEAM_SYNC: &str = "Fabricator saves this team app to GitHub for you after each change. Use Update and Publish instead.";

fn sync_err(message: &str, status: GitStatus, remote: GitRemoteStatus) -> GitSyncResult {
  GitSyncResult { ok: false, error: Some(message.to_string()), conflict: None, status, remote }
}

pub async fn git_pull(id: String) -> GitSyncResult {
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
  if !has_upstream(&cwd).await {
    return sync_err(
      "This branch isn’t linked to a remote branch yet.",
      git_status(id.clone()).await,
      compute_remote_status(&cwd, false).await,
    );
  }

  // Don't lose uncommitted work — commit it first (mirrors git_revert).
  let dirty = git(&cwd, &["status", "--porcelain"]).await;
  if dirty.ok && !dirty.stdout.trim().is_empty() {
    git(&cwd, &["add", "-A"]).await;
    let mut args: Vec<&str> = COMMIT_IDENT.to_vec();
    args.extend_from_slice(&["commit", "-m", "Save before getting the latest changes"]);
    let saved = git(&cwd, &args).await;
    if !saved.ok {
      return sync_err(
        "Could not save your current changes before updating.",
        git_status(id.clone()).await,
        compute_remote_status(&cwd, false).await,
      );
    }
  }

  // Refresh remote-tracking refs before merging.
  let fetched = git_net(&cwd, &["fetch", "--no-tags", "--quiet"]).await;
  if !fetched.ok {
    let e = fetched.stderr.trim();
    return sync_err(
      if e.is_empty() { "Could not reach the remote." } else { e },
      git_status(id.clone()).await,
      compute_remote_status(&cwd, false).await,
    );
  }

  // Fast-forward when possible; fall back to a rebase when histories diverged.
  let ff = git(&cwd, &["merge", "--ff-only", "@{u}"]).await;
  if !ff.ok {
    let orig = git(&cwd, &["rev-parse", "HEAD"]).await;
    let orig = orig.stdout.trim().to_string();
    let rebased = git(&cwd, &["rebase", "@{u}"]).await;
    if !rebased.ok {
      // Leave no half-applied state: abort and restore exactly where we were.
      git(&cwd, &["rebase", "--abort"]).await;
      if !orig.is_empty() {
        git(&cwd, &["reset", "--hard", &orig]).await;
      }
      return GitSyncResult {
        ok: false,
        error: Some(
          "Your changes and the latest changes overlap and couldn’t be combined automatically.".to_string(),
        ),
        conflict: Some(true),
        status: git_status(id.clone()).await,
        remote: compute_remote_status(&cwd, false).await,
      };
    }
  }

  GitSyncResult {
    ok: true,
    error: None,
    conflict: None,
    status: git_status(id.clone()).await,
    remote: compute_remote_status(&cwd, false).await,
  }
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
      status: git_status(id.clone()).await,
      remote: compute_remote_status(&cwd, false).await,
    };
  }

  GitSyncResult {
    ok: true,
    error: None,
    conflict: None,
    status: git_status(id.clone()).await,
    remote: compute_remote_status(&cwd, false).await,
  }
}
