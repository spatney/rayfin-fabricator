//! Starting a version history for an app that git doesn't track yet.
//!
//! Fabricator keeps every app's versions in git: History lists them, Restore
//! brings one back, each deploy records which one is live, and the check after
//! a chat turn compares the code with that live version to decide whether to
//! redeploy. Apps Fabricator creates get a repository right away, but a folder
//! opened from disk may have none, and then all of that fails — the after-turn
//! check with "fatal: not a git repository" after every single turn.
//!
//! [`ensure_tracked`] gives such a folder a repository, carefully:
//!
//! * A folder inside another repository is left alone, so a monorepo never
//!   gets a second, nested one.
//! * Dependencies, build output, caches, local settings and secrets stay out
//!   even when the app's `.gitignore` misses them. They are listed in
//!   `.git/info/exclude`, which git honours like a `.gitignore` but keeps
//!   inside `.git`, so none of the app's own files change.
//! * Before anything is committed, the files git would add are inspected:
//!   nested repositories, Python environments (whatever their folder is
//!   called), very large files and an `.npmrc` holding a sign-in token are
//!   kept out too.
//! * What's left becomes the first version.

use std::io::Write;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;

use super::exec::{RunOptions, RunResult};
use super::journal::{self, Area, Level};
use super::{git, team};
use crate::types::StudioProject;

/// Files larger than this stay out of the history (GitHub warns at 50 MB).
const LARGE_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// The first version's message, as History shows it.
pub const FIRST_VERSION_MESSAGE: &str = "Start version history";

/// Never tracked, whatever the app's `.gitignore` says. Names that could also
/// be an ordinary source folder (`coverage`, `test-results`) only match at the
/// top of the app.
const DEFAULT_EXCLUDES: &str = "
# Added by Fabricator when it started this app's version history. These stay
# out of the history even when .gitignore doesn't list them.

# Dependencies and environments
node_modules/
bower_components/
jspm_packages/
.pnpm-store/
.yarn/cache/
.yarn/unplugged/
.venv/
__pycache__/
*.py[cod]

# Build output and caches
dist/
dist-ssr/
.vite/
.turbo/
.cache/
.parcel-cache/
.next/
/coverage/
*.tsbuildinfo
.pytest_cache/
.mypy_cache/
.ruff_cache/

# Test and browser-automation output
/test-results/
/playwright-report/
.playwright-cli/
.playwright-mcp/

# Logs, editors and the operating system
*.log
.idea/
.DS_Store
Thumbs.db
desktop.ini

# Local settings and secrets
.env
.env.*
!.env.example
!.env.sample
!.env.template
*.local
local.settings.json
*.pem
*.key
*.pfx
*.p12

# Rayfin's files for this computer
/rayfin/.deployments.json
/rayfin/.temp/
/rayfin/.*.tmp
rayfin.config.json
.rayfin/

# Fabricator's working files for this computer, such as a report migration's
# page images
.fabricator/
";

/// One start at a time, so two callers can't both create the repository.
static STARTING: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/// Something the inspection kept out of the history, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptOut {
  /// Relative to the app's folder; a trailing `/` marks a folder.
  pub path: String,
  pub why: &'static str,
}

/// What starting a history did.
#[derive(Debug, Default)]
pub struct Started {
  /// Files in the first version.
  pub files: usize,
  /// What the inspection kept out, beyond the defaults.
  pub kept_out: Vec<KeptOut>,
  /// Why the first version couldn't be committed. The repository still exists,
  /// with everything staged, so Fabricator's next save can commit it.
  pub commit_error: Option<String>,
}

/// Whether git tracks `dir`: it, or a folder above it, holds a repository
/// (`.git` is a folder, or a file in worktrees and submodules).
pub fn is_tracked(dir: &Path) -> bool {
  dir.ancestors().any(|d| d.join(".git").exists())
}

/// Give `dir` a repository and a first version when git doesn't track it yet.
/// `Ok(None)` when it's tracked already. On `Err` the folder is left exactly as
/// it was.
pub async fn ensure_tracked(dir: &Path) -> Result<Option<Started>, String> {
  ensure_tracked_with(dir, LARGE_FILE_BYTES).await
}

async fn ensure_tracked_with(dir: &Path, large_file_bytes: u64) -> Result<Option<Started>, String> {
  if is_tracked(dir) {
    return Ok(None);
  }
  let _one_at_a_time = STARTING.lock().await;
  if is_tracked(dir) {
    return Ok(None);
  }
  if !dir.is_dir() {
    return Err(format!("The app's folder {} doesn't exist.", dir.display()));
  }

  let init = run(dir, &["init", "--quiet"], 30_000).await;
  if !init.ok {
    return Err(failure("Couldn't create a git repository", &init));
  }
  match prepare_first_version(dir, large_file_bytes).await {
    Ok(started) => Ok(Some(started)),
    Err(error) => {
      undo_init(dir).await;
      Err(error)
    }
  }
}

/// Keep out what doesn't belong, then stage and commit the rest.
async fn prepare_first_version(dir: &Path, large_file_bytes: u64) -> Result<Started, String> {
  let exclude = exclude_file(dir).await;
  append(&exclude, DEFAULT_EXCLUDES)?;

  let listed = run(dir, &["ls-files", "--others", "--exclude-standard", "-z"], 120_000).await;
  if !listed.ok {
    return Err(failure("Couldn't list the app's files", &listed));
  }
  let candidates: Vec<&str> = listed.stdout.split('\0').filter(|p| !p.is_empty()).collect();
  let inspection = inspect(dir, &candidates, large_file_bytes);
  if !inspection.kept_out.is_empty() {
    let mut block = String::from("\n# Found in this folder when its history started.\n");
    for kept in &inspection.kept_out {
      block.push_str(&format!("# It {}.\n{}\n", kept.why, pattern_for(&kept.path)));
    }
    append(&exclude, &block)?;
  }

  let add = run(dir, &["add", "-A"], 300_000).await;
  if !add.ok {
    return Err(failure("Couldn't add the app's files to its history", &add));
  }
  ensure_identity(dir).await;
  let commit = run(dir, &["commit", "--quiet", "--allow-empty", "-m", FIRST_VERSION_MESSAGE], 120_000).await;
  let commit_error = (!commit.ok).then(|| failure("Couldn't save the first version", &commit));
  if let Some(error) = &commit_error {
    log::warn!("{}: {error}", dir.display());
  }
  Ok(Started { files: inspection.files, kept_out: inspection.kept_out, commit_error })
}

/// Remove the repository [`ensure_tracked`] just created, so a failed start
/// leaves the folder as it was. A repository with commits isn't ours to delete.
async fn undo_init(dir: &Path) {
  if run(dir, &["rev-parse", "--verify", "--quiet", "HEAD"], 30_000).await.ok {
    return;
  }
  if let Err(error) = std::fs::remove_dir_all(dir.join(".git")) {
    log::warn!("Couldn't remove the unfinished repository in {}: {error}", dir.display());
  }
}

struct Inspection {
  files: usize,
  kept_out: Vec<KeptOut>,
}

/// Decide what else stays out, from the paths `git ls-files --others` lists
/// (relative and `/`-separated; a trailing `/` is a nested repository).
fn inspect(dir: &Path, candidates: &[&str], large_file_bytes: u64) -> Inspection {
  let mut kept_out: Vec<KeptOut> = Vec::new();
  for path in candidates {
    if path.ends_with('/') {
      kept_out.push(KeptOut { path: path.to_string(), why: "has its own git repository" });
    } else if let Some(env) = path.strip_suffix("pyvenv.cfg").filter(|p| p.ends_with('/')) {
      kept_out.push(KeptOut { path: env.to_string(), why: "is a Python environment" });
    }
  }
  let folders: Vec<String> = kept_out.iter().map(|k| k.path.clone()).collect();

  let mut files = 0;
  for path in candidates.iter().filter(|p| !p.ends_with('/')) {
    if folders.iter().any(|folder| path.starts_with(folder.as_str())) {
      continue;
    }
    let full = dir.join(path);
    let size = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
    if size > large_file_bytes {
      kept_out.push(KeptOut { path: path.to_string(), why: "is larger than 50 MB" });
    } else if file_name(path) == ".npmrc" && holds_registry_token(&full) {
      kept_out.push(KeptOut { path: path.to_string(), why: "holds a registry sign-in token" });
    } else {
      files += 1;
    }
  }
  Inspection { files, kept_out }
}

fn file_name(path: &str) -> &str {
  path.rsplit('/').next().unwrap_or(path)
}

/// Whether an `.npmrc` holds a literal registry credential. A reference to an
/// environment variable (`${NPM_TOKEN}`) is safe to keep, and usual to commit.
fn holds_registry_token(path: &Path) -> bool {
  let Ok(text) = std::fs::read_to_string(path) else {
    return false;
  };
  text.lines().map(str::trim).filter(|line| !line.starts_with('#') && !line.starts_with(';')).any(|line| {
    let Some((key, value)) = line.split_once('=') else {
      return false;
    };
    let key = key.trim().to_ascii_lowercase();
    let value = value.trim();
    let secret_key = ["_authtoken", "_auth", "_password"].iter().any(|k| key.ends_with(k));
    secret_key && !value.is_empty() && !value.starts_with("${")
  })
}

/// An exclude pattern that matches `path` and nothing else, from the top of the
/// app. Wildcards are escaped, as are trailing spaces (which git would drop).
fn pattern_for(path: &str) -> String {
  let mut out = String::with_capacity(path.len() + 2);
  out.push('/');
  for ch in path.chars() {
    if matches!(ch, '\\' | '*' | '?' | '[' | ']' | '!' | '#') {
      out.push('\\');
    }
    out.push(ch);
  }
  let kept = out.trim_end_matches(' ').len();
  let spaces = out.len() - kept;
  out.truncate(kept);
  out.push_str(&"\\ ".repeat(spaces));
  out
}

/// Where this repository keeps its private exclude list.
async fn exclude_file(dir: &Path) -> PathBuf {
  let res = run(dir, &["rev-parse", "--git-path", "info/exclude"], 30_000).await;
  let rel = res.stdout.trim();
  if res.ok && !rel.is_empty() {
    dir.join(rel)
  } else {
    dir.join(".git").join("info").join("exclude")
  }
}

fn append(file: &Path, text: &str) -> Result<(), String> {
  let write = || -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
      std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(file)?;
    f.write_all(text.as_bytes())
  };
  write().map_err(|e| format!("Couldn't write {}: {e}", file.display()))
}

/// Commits need a name and email; use Fabricator's when git has none.
async fn ensure_identity(dir: &Path) {
  for (key, fallback) in [("user.email", "fabricator@rayfin.local"), ("user.name", "Fabricator")] {
    let current = run(dir, &["config", key], 15_000).await;
    if current.stdout.trim().is_empty() {
      let _ = run(dir, &["config", key, fallback], 15_000).await;
    }
  }
}

async fn run(dir: &Path, args: &[&str], timeout_ms: u64) -> RunResult {
  git::run(args, RunOptions { cwd: Some(dir.to_path_buf()), timeout_ms: Some(timeout_ms), ..Default::default() }).await
}

fn failure(what: &str, res: &RunResult) -> String {
  let detail = [res.stderr.trim(), res.stdout.trim()].into_iter().find(|s| !s.is_empty()).unwrap_or("git gave no reason.");
  let detail: String = detail.chars().take(400).collect();
  format!("{what}: {detail}")
}

/// [`ensure_tracked`] for a registered app. Team apps always live in their
/// workspace's repository and are left alone. A history that starts is noted
/// in the activity journal, so Help can explain the new `.git` folder.
pub async fn ensure_project_tracked(project: &StudioProject) -> Result<(), String> {
  if team::is_team_project(project) {
    return Ok(());
  }
  match ensure_tracked(Path::new(&project.path)).await {
    Ok(None) => Ok(()),
    Ok(Some(started)) => {
      journal::entry(Level::Info, Area::Git, "git.history-started", &started_message(&started))
        .detail(started.commit_error.clone())
        .project(Some(project.id.clone()))
        .write();
      Ok(())
    }
    Err(error) => {
      journal::entry(Level::Warn, Area::Git, "git.history-failed", &format!("Couldn't start this app's version history. {error}"))
        .project(Some(project.id.clone()))
        .write();
      Err(error)
    }
  }
}

fn started_message(started: &Started) -> String {
  let mut message = format!(
    "Started a version history for this app with git, so History, Restore and automatic redeploys work. \
     The first version has {} {}.",
    started.files,
    if started.files == 1 { "file" } else { "files" }
  );
  if !started.kept_out.is_empty() {
    let list: Vec<String> = started.kept_out.iter().map(|k| format!("{} ({})", k.path, k.why)).collect();
    message.push_str(&format!(" Kept out: {}.", list.join(", ")));
  }
  if started.commit_error.is_some() {
    message.push_str(" The first version couldn't be saved yet; Fabricator saves it with the next deploy.");
  }
  message
}

#[cfg(test)]
mod tests {
  use super::*;

  struct TempDir(PathBuf);

  impl TempDir {
    fn new() -> Self {
      let dir = std::env::temp_dir().join(format!("fabricator-history-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&dir).unwrap();
      Self(dir)
    }

    fn write(&self, rel: &str, content: &str) {
      let path = self.0.join(rel);
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      std::fs::write(path, content).unwrap();
    }

    fn git(&self, dir: &Path, args: &[&str]) -> String {
      let out = std::process::Command::new("git").args(args).current_dir(dir).output().expect("git runs");
      assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
      String::from_utf8_lossy(&out.stdout).to_string()
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  /// Git is installed, and the temp folder isn't inside a repository (where
  /// every folder counts as tracked).
  fn can_test() -> bool {
    which::which("git").is_ok() && !is_tracked(&std::env::temp_dir())
  }

  #[tokio::test]
  async fn an_untracked_app_gets_a_history_without_what_doesnt_belong_in_it() {
    if !can_test() {
      return;
    }
    let app = TempDir::new();
    app.write("rayfin/rayfin.yml", "id: app\n");
    app.write("src/App.tsx", "export default 1\n");
    app.write(".env.example", "API_URL=\n");
    app.write(".env", "SECRET=1\n");
    app.write("rayfin/.env", "RAYFIN_PUBLIC_KEY=1\n");
    app.write("rayfin/.deployments.json", "{}\n");
    app.write("node_modules/react/index.js", "x\n");
    app.write(".venv/pyvenv.cfg", "home = x\n");
    app.write(".venv/lib/site.py", "x\n");
    app.write("agent/env/pyvenv.cfg", "home = x\n");
    app.write("agent/env/lib/site.py", "x\n");
    app.write("agent/main.py", "print(1)\n");
    app.write("tsconfig.tsbuildinfo", "{}\n");
    app.write(".npmrc", "//registry.npmjs.org/:_authToken=npm_secret\n");
    app.write("public/video [1].mp4", &"v".repeat(256));
    app.write("vendor-lib/lib.js", "x\n");
    app.git(&app.0.join("vendor-lib"), &["init", "--quiet"]);

    let started = ensure_tracked_with(&app.0, 128).await.unwrap().expect("a history starts");
    assert_eq!(started.commit_error, None);

    let tracked = app.git(&app.0, &["ls-files"]);
    let tracked: Vec<&str> = tracked.lines().collect();
    assert_eq!(tracked, vec![".env.example", "agent/main.py", "rayfin/rayfin.yml", "src/App.tsx"]);
    assert_eq!(started.files, 4);
    assert_eq!(
      started.kept_out,
      vec![
        KeptOut { path: "agent/env/".into(), why: "is a Python environment" },
        KeptOut { path: "vendor-lib/".into(), why: "has its own git repository" },
        KeptOut { path: ".npmrc".into(), why: "holds a registry sign-in token" },
        KeptOut { path: "public/video [1].mp4".into(), why: "is larger than 50 MB" },
      ]
    );

    let log = app.git(&app.0, &["log", "--format=%s"]);
    assert_eq!(log.trim(), FIRST_VERSION_MESSAGE);
    assert!(app.git(&app.0, &["status", "--porcelain"]).trim().is_empty(), "everything else stays ignored");
    let gitignore_untouched = !app.0.join(".gitignore").exists();
    assert!(gitignore_untouched, "the app's own files don't change");

    assert!(ensure_tracked_with(&app.0, 128).await.unwrap().is_none(), "a tracked app is left alone");
  }

  #[tokio::test]
  async fn a_folder_inside_a_repository_is_left_alone() {
    if !can_test() {
      return;
    }
    let repo = TempDir::new();
    repo.git(&repo.0, &["init", "--quiet"]);
    repo.write("apps/one/rayfin/rayfin.yml", "id: one\n");
    let app = repo.0.join("apps").join("one");
    assert!(is_tracked(&app));
    assert!(ensure_tracked(&app).await.unwrap().is_none());
    assert!(!app.join(".git").exists(), "no nested repository");
  }

  #[tokio::test]
  async fn a_missing_folder_is_an_error_and_creates_nothing() {
    if !can_test() {
      return;
    }
    let dir = std::env::temp_dir().join(format!("fabricator-history-missing-{}", uuid::Uuid::new_v4()));
    assert!(ensure_tracked(&dir).await.is_err());
    assert!(!dir.exists());
  }

  #[test]
  fn npmrc_credentials_are_spotted_but_variable_references_are_not() {
    let dir = TempDir::new();
    let check = |text: &str| {
      dir.write(".npmrc", text);
      holds_registry_token(&dir.0.join(".npmrc"))
    };
    assert!(check("//registry.npmjs.org/:_authToken=npm_abc\n"));
    assert!(check("registry=https://x\n//x/:_password = c2VjcmV0\n"));
    assert!(check("_auth=dXNlcjpwYXNz\n"));
    assert!(!check("//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n"));
    assert!(!check("# //registry.npmjs.org/:_authToken=npm_abc\nregistry=https://x\n"));
    assert!(!check("save-exact=true\n"));
  }

  #[test]
  fn exclude_patterns_match_only_their_own_path() {
    assert_eq!(pattern_for("agent/env/"), "/agent/env/");
    assert_eq!(pattern_for("public/video [1].mp4"), "/public/video \\[1\\].mp4");
    assert_eq!(pattern_for("a*b?/#c!"), "/a\\*b\\?/\\#c\\!");
    assert_eq!(pattern_for("notes  "), "/notes\\ \\ ");
  }
}
