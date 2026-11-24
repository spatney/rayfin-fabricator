//! Running git, and getting past the lock files it leaves behind.
//!
//! Git takes `<git dir>/index.lock` while it writes the index and refuses to
//! run at all when that file already exists. Fabricator runs git from several
//! places that overlap — saving a team app after a chat turn, the History and
//! app-bar panels reading the project's state, Copilot's own shell commands —
//! so a save can land exactly while another git holds the lock. Worse, a git
//! that was killed (a timeout, or quitting mid-save) leaves its lock behind for
//! good, and then *every* later command fails the same way:
//!
//! ```text
//! fatal: Unable to create '…/index.lock': File exists.
//! ```
//!
//! Every git Fabricator runs therefore goes through [`run`], which
//!
//! * never takes git's *optional* locks, so reading a project's state can't
//!   make a concurrent save fail, and
//! * waits out a lock another git holds, then clears one that was abandoned.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use once_cell::sync::Lazy;
use regex::Regex;

use super::exec::{self, RunOptions, RunResult};

/// How long to let the git holding the lock finish, and when to treat the lock
/// as left behind by a git that is no longer running.
struct Wait {
  retry_for: Duration,
  retry_every: Duration,
  abandoned_after: Duration,
}

const WAIT: Wait = Wait {
  retry_for: Duration::from_secs(10),
  retry_every: Duration::from_millis(250),
  abandoned_after: Duration::from_secs(30),
};

/// `fatal: Unable to create '<path>.lock': File exists.`
static LOCKED_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)unable to create '(.+?\.lock)': file exists").unwrap());

/// True when git failed because another process holds one of its lock files.
pub fn is_lock_failure(text: &str) -> bool {
  LOCKED_RE.is_match(text)
}

/// The lock file git refused to create, when that is why the command failed.
fn blocking_lock(res: &RunResult) -> Option<PathBuf> {
  if res.ok {
    return None;
  }
  LOCKED_RE
    .captures(&res.stderr)
    .or_else(|| LOCKED_RE.captures(&res.stdout))
    .map(|caps| PathBuf::from(caps[1].trim()))
}

fn written_at(lock: &Path) -> Option<SystemTime> {
  std::fs::metadata(lock).ok()?.modified().ok()
}

/// Whether the lock belongs to a git that died: it is still there, and nothing
/// has written to it since we first saw it (git writes the new index into its
/// lock as it works, so a live one keeps changing).
fn abandoned(lock: &Path, found_at: Option<SystemTime>, after: Duration) -> bool {
  let (Some(found_at), Some(now)) = (found_at, written_at(lock)) else {
    return false;
  };
  found_at == now && now.elapsed().is_ok_and(|age| age >= after)
}

/// The caller's options, plus the one git setting this module guarantees.
fn options(opts: &RunOptions) -> RunOptions {
  let mut env = opts.env.clone();
  if !env.iter().any(|(k, _)| k == "GIT_OPTIONAL_LOCKS") {
    // Reading (status, diff, log) then never locks the index to refresh it,
    // which is what made a save fail while a panel was reading the project.
    env.push(("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string()));
  }
  RunOptions {
    cwd: opts.cwd.clone(),
    env,
    env_remove: opts.env_remove.clone(),
    on_data: opts.on_data.clone(),
    timeout_ms: opts.timeout_ms,
    cancel: opts.cancel.clone(),
    stdin: opts.stdin.clone(),
    on_spawn: opts.on_spawn.clone(),
  }
}

/// Run git, waiting out a lock another git holds and clearing an abandoned one.
/// Never returns Err — failures surface via [`RunResult`], as in [`exec::run`].
pub async fn run(args: &[&str], opts: RunOptions) -> RunResult {
  run_waiting(args, opts, &WAIT).await
}

async fn run_waiting(args: &[&str], opts: RunOptions, wait: &Wait) -> RunResult {
  let attempt = || exec::run("git", args, options(&opts));
  let mut res = attempt().await;
  let Some(lock) = blocking_lock(&res) else {
    return res;
  };
  let found_at = written_at(&lock);
  let deadline = Instant::now() + wait.retry_for;
  while Instant::now() < deadline {
    tokio::time::sleep(wait.retry_every).await;
    res = attempt().await;
    if blocking_lock(&res).is_none() {
      return res;
    }
  }
  // Still blocked, and nothing wrote to the lock while we waited: the git that
  // made it is gone, so clearing it is the only way out (git's own message
  // says as much). A live git keeps writing, and is left alone.
  if abandoned(&lock, found_at, wait.abandoned_after) {
    log::warn!("Clearing a git lock no process is writing to: {}", lock.display());
    if std::fs::remove_file(&lock).is_ok() {
      return attempt().await;
    }
  }
  res
}

#[cfg(test)]
mod tests {
  use super::*;

  struct Repo {
    _dir: PathBuf,
    path: PathBuf,
  }

  /// A repository with one commit and an edited file waiting to be staged.
  fn repo() -> Repo {
    let dir = std::env::temp_dir().join(format!("fabricator-gitlock-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let git = |args: &[&str]| {
      let out = std::process::Command::new("git").args(args).current_dir(&dir).output().expect("git runs");
      assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "t"]);
    git(&["config", "user.email", "t@t"]);
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "--quiet", "-m", "first"]);
    std::fs::write(dir.join("a.txt"), "two\n").unwrap();
    Repo { path: dir.clone(), _dir: dir }
  }

  impl Drop for Repo {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.path);
    }
  }

  fn opts(repo: &Repo) -> RunOptions {
    RunOptions {
      cwd: Some(repo.path.clone()),
      timeout_ms: Some(30_000),
      ..Default::default()
    }
  }

  fn lock_of(repo: &Repo) -> PathBuf {
    repo.path.join(".git").join("index.lock")
  }

  fn have_git() -> bool {
    which::which("git").is_ok()
  }

  #[tokio::test]
  async fn a_lock_another_git_holds_is_waited_out() {
    if !have_git() {
      return;
    }
    let repo = repo();
    let lock = lock_of(&repo);
    std::fs::write(&lock, "held").unwrap();
    let releasing = lock.clone();
    tokio::spawn(async move {
      tokio::time::sleep(Duration::from_millis(400)).await;
      std::fs::remove_file(&releasing).unwrap();
    });
    let wait = Wait {
      retry_for: Duration::from_secs(10),
      retry_every: Duration::from_millis(100),
      abandoned_after: Duration::from_secs(600),
    };
    let res = run_waiting(&["add", "-A"], opts(&repo), &wait).await;
    assert!(res.ok, "{}", res.stderr);
    assert!(!lock.exists());
  }

  #[tokio::test]
  async fn a_lock_left_behind_by_a_dead_git_is_cleared() {
    if !have_git() {
      return;
    }
    let repo = repo();
    let lock = lock_of(&repo);
    std::fs::write(&lock, "abandoned").unwrap();
    let wait = Wait {
      retry_for: Duration::from_millis(300),
      retry_every: Duration::from_millis(100),
      abandoned_after: Duration::ZERO,
    };
    let res = run_waiting(&["add", "-A"], opts(&repo), &wait).await;
    assert!(res.ok, "{}", res.stderr);
    let staged = exec::run("git", &["diff", "--cached", "--name-only"], opts(&repo)).await;
    assert_eq!(staged.stdout.trim(), "a.txt");
  }

  #[tokio::test]
  async fn a_lock_a_live_git_keeps_writing_to_is_left_alone() {
    if !have_git() {
      return;
    }
    let repo = repo();
    let lock = lock_of(&repo);
    std::fs::write(&lock, "working").unwrap();
    let working = lock.clone();
    let writer = tokio::spawn(async move {
      for i in 0..12 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let _ = std::fs::write(&working, format!("working {i}"));
      }
    });
    let wait = Wait {
      retry_for: Duration::from_millis(600),
      retry_every: Duration::from_millis(100),
      abandoned_after: Duration::ZERO,
    };
    let res = run_waiting(&["add", "-A"], opts(&repo), &wait).await;
    assert!(!res.ok);
    assert!(is_lock_failure(&res.stderr), "{}", res.stderr);
    assert!(lock.exists(), "a git still writing to its lock keeps it");
    writer.abort();
  }

  #[tokio::test]
  async fn reading_never_takes_gits_optional_locks() {
    if !have_git() {
      return;
    }
    let repo = repo();
    let res = run(&["status", "--porcelain"], opts(&repo)).await;
    assert!(res.ok, "{}", res.stderr);
    assert!(res.stdout.contains("a.txt"));
    // The caller's own setting wins when it sets one.
    let mut with_env = opts(&repo);
    with_env.env.push(("GIT_OPTIONAL_LOCKS".to_string(), "1".to_string()));
    let chosen = options(&with_env);
    assert_eq!(
      chosen.env.iter().filter(|(k, _)| k == "GIT_OPTIONAL_LOCKS").map(|(_, v)| v.as_str()).collect::<Vec<_>>(),
      vec!["1"]
    );
  }

  #[test]
  fn only_lock_failures_are_recognised() {
    let lock = |stderr: &str| {
      blocking_lock(&RunResult {
        ok: false,
        exit_code: Some(128),
        stdout: String::new(),
        stderr: stderr.to_string(),
        not_found: false,
      })
    };
    assert_eq!(
      lock("fatal: Unable to create 'C:/w/.repo/.git/worktrees/app/index.lock': File exists.\n\nAnother git process"),
      Some(PathBuf::from("C:/w/.repo/.git/worktrees/app/index.lock"))
    );
    assert_eq!(
      lock("error: cannot lock ref 'refs/heads/x': Unable to create '/r/.git/refs/heads/x.lock': File exists"),
      Some(PathBuf::from("/r/.git/refs/heads/x.lock"))
    );
    assert_eq!(lock("fatal: not a git repository"), None);
    assert_eq!(lock("error: Unable to create 'x.lock': Permission denied"), None);
    assert!(blocking_lock(&RunResult {
      ok: true,
      exit_code: Some(0),
      stdout: "Unable to create 'a.lock': File exists".into(),
      stderr: String::new(),
      not_found: false,
    })
    .is_none());
  }
}
