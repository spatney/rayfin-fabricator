//! Git status/commit + read-only history/diffs for the History view. Ported from
//! `src/main/services/git.ts` and the git helpers in `projects.ts`. Everything is
//! read-only except commit/revert, and sandboxed to the project directory.

use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;

use crate::commands::util::{looks_binary, safe_resolve};
use crate::services::exec::{run, RunOptions};
use crate::services::store::find_project;
use crate::types::{
  GitChange, GitCommitResult, GitCommitSummary, GitFileDiff, GitHistory, GitRemoteStatus, GitStatus,
  GitSyncResult, RevertResult,
};

/// Working-tree sentinel ref (matches `GIT_WORKING_REF` in src/shared/ipc.ts).
const GIT_WORKING_REF: &str = "WORKING";
/// Identity used for Studio's own commits to user projects (matches deploys).
const COMMIT_IDENT: [&str; 4] = [
  "-c",
  "user.name=Rayfin Fabricator",
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
  let res = run("git", &full, opts(cwd)).await;
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
    git(&dir, &["config", "user.name", "Rayfin Fabricator"]).await;
  }

  let add = git(&dir, &["add", "-A"]).await;
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
  let none = || GitHistory { is_repo: false, no_commits: None, commits: vec![], working_changes: 0, head: None };
  let Some(project) = find_project(&id) else {
    return none();
  };
  let cwd = project.path.clone();

  let inside = git(&cwd, &["rev-parse", "--is-inside-work-tree"]).await;
  if !inside.ok || inside.stdout.trim() != "true" {
    return none();
  }

  let status = git(&cwd, &["status", "--porcelain=v1", "--untracked-files=all"]).await;
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

  let fmt = format!("{RECORD}%H{FIELD}%h{FIELD}%an{FIELD}%ar{FIELD}%aI{FIELD}%s");
  let n = MAX_COMMITS.to_string();
  let log = git(&cwd, &["log", "-n", &n, "--shortstat", &format!("--pretty=format:{fmt}")]).await;
  if !log.ok {
    return GitHistory { is_repo: true, no_commits: Some(true), commits: vec![], working_changes, head };
  }
  GitHistory { is_repo: true, no_commits: None, commits: parse_log(&log.stdout), working_changes, head }
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
  let name_status = git(cwd, &["show", hash, "--name-status", "--format=", "-M"]).await;
  if !name_status.ok {
    return vec![];
  }
  let numstat = git(cwd, &["show", hash, "--numstat", "--format=", "-M"]).await;
  let counts = parse_numstat(if numstat.ok { &numstat.stdout } else { "" });
  parse_name_status(&name_status.stdout, &counts)
}

async fn working_change_list(cwd: &str) -> Vec<GitChange> {
  let status = git(cwd, &["status", "--porcelain=v1", "--untracked-files=all"]).await;
  if !status.ok {
    return vec![];
  }
  let numstat = git(cwd, &["diff", "--numstat", "HEAD"]).await;
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
    let path = path.trim().trim_matches('"').to_string();
    if path.is_empty() {
      continue;
    }
    let status2 = if code == "??" { "added" } else { status_from_code(code.trim()) };
    let c = counts.get(&path);
    changes.push(GitChange {
      path,
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
  let cwd = project.path;
  let name_status = git(&cwd, &["diff", "--name-status", "-M", &base, &target]).await;
  if !name_status.ok {
    return vec![];
  }
  let numstat = git(&cwd, &["diff", "--numstat", "-M", &base, &target]).await;
  let counts = parse_numstat(if numstat.ok { &numstat.stdout } else { "" });
  let mut list = parse_name_status(&name_status.stdout, &counts);
  list.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
  list
}

/* --------------------------------- diff ----------------------------------- */

async fn show_at(cwd: &str, rev: &str, path: &str) -> String {
  let res = run("git", &["-c", "core.quotepath=false", "show", &format!("{rev}:{path}")], opts(cwd)).await;
  if res.ok { res.stdout } else { String::new() }
}

fn read_working(root: &str, rel_path: &str) -> String {
  let Some(target) = safe_resolve(root, rel_path) else {
    return String::new();
  };
  match std::fs::metadata(&target) {
    Ok(m) if m.is_file() => std::fs::read_to_string(&target).unwrap_or_default(),
    _ => String::new(),
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
  let cwd = project.path;
  let source = old_path.as_deref().unwrap_or(&path);

  let (before, after) = if reference == GIT_WORKING_REF {
    (show_at(&cwd, "HEAD", source).await, read_working(&cwd, &path))
  } else {
    (
      show_at(&cwd, &format!("{reference}^"), source).await,
      show_at(&cwd, &reference, &path).await,
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
      ("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string()),
      ("GCM_INTERACTIVE".to_string(), "never".to_string()),
    ],
    ..Default::default()
  }
}

/// Run a network-touching git command (fetch/pull/push) with [`net_opts`].
async fn git_net(cwd: &str, args: &[&str]) -> Git {
  let mut full: Vec<&str> = vec!["-c", "core.quotepath=false"];
  full.extend_from_slice(args);
  let res = run("git", &full, net_opts(cwd)).await;
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

fn sync_err(message: &str, status: GitStatus, remote: GitRemoteStatus) -> GitSyncResult {
  GitSyncResult { ok: false, error: Some(message.to_string()), conflict: None, status, remote }
}

pub async fn git_pull(id: String) -> GitSyncResult {
  let Some(project) = find_project(&id) else {
    return sync_err("Project folder not found.", no_repo_status(), GitRemoteStatus::default());
  };
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
