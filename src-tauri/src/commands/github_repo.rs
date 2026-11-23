//! A project's own GitHub repository. Fabricator creates it through the GitHub
//! CLI, as the account the user picks and owned by that account or one of its
//! organizations, then pushes the project's versions to it. From then on it
//! gets and pushes the project's changes as that account, whichever account the
//! CLI has active and however git itself is set up (see [`network_auth`]).

use std::path::Path;

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::json;

use crate::commands::util::same_path;
use crate::services::exec::{RunOptions, RunResult};
use crate::services::git;
use crate::services::journal::{self, Area, Level, Surface};
use crate::services::store;
use crate::services::team::gh::{self, GhError, RepoInfo};
use crate::types::{GithubRepoRequest, GithubRepoResult, ProjectNameCheck, TeamOwnersResult};

/// GitHub's rule for a repository name: letters, digits, hyphens, underscores
/// and periods, at most 100 of them.
static REPO_NAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9._-]{1,100}$").unwrap());

fn name_rule() -> String {
  t!("commands.githubRepo.nameRule")
}

/// Whether GitHub takes `name` for a repository as it is.
fn valid_repo_name(name: &str) -> bool {
  REPO_NAME_RE.is_match(name) && name != "." && name != ".." && !name.to_ascii_lowercase().ends_with(".git")
}

fn check_names(account: &str, owner: &str, name: &str) -> Result<(), String> {
  if !gh::is_login(account) {
    return Err(t!("commands.github.notAccountName", login = account));
  }
  if !gh::is_login(owner) {
    return Err(t!("commands.githubRepo.notAccountOrOrg", owner = owner));
  }
  if !valid_repo_name(name) {
    return Err(name_rule());
  }
  Ok(())
}

/// The API path that creates a repository owned by `owner`, as `account`.
fn create_path(account: &str, owner: &str) -> String {
  if owner.eq_ignore_ascii_case(account) {
    "user/repos".into()
  } else {
    format!("orgs/{owner}/repos")
  }
}

fn failed(message: impl Into<String>) -> GithubRepoResult {
  GithubRepoResult { ok: false, error: Some(message.into()), url: None }
}

/* -------------------------------- owners ---------------------------------- */

/// Where `account` (the GitHub CLI's active account when absent) can create a
/// repository: itself, then its organizations.
#[tauri::command]
pub async fn github_owners(account: Option<String>) -> TeamOwnersResult {
  gh::as_account(account, async {
    match gh::owners().await {
      Ok(owners) => TeamOwnersResult { ok: true, error: None, owners },
      Err(e) => TeamOwnersResult {
        ok: false,
        error: Some(e.describe(&t!("commands.githubRepo.listOwners"))),
        owners: vec![],
      },
    }
  })
  .await
}

/* ------------------------------- the name --------------------------------- */

/// What `owner/name` holds on GitHub, for the account the current task acts as.
enum Existing {
  /// Nothing yet: it can be created.
  Free,
  /// An empty repository the account can push to, which Fabricator uses.
  Empty(RepoInfo),
  /// A repository with history, or one the account can't push to.
  Taken,
}

async fn existing(full_name: &str) -> Result<Existing, GhError> {
  match gh::repo(full_name).await {
    Ok(info) if info.push && !info.archived => {
      if gh::has_commits(&info.full_name).await? {
        Ok(Existing::Taken)
      } else {
        Ok(Existing::Empty(info))
      }
    }
    Ok(_) => Ok(Existing::Taken),
    Err(e) if e.is_not_found() => Ok(Existing::Free),
    Err(e) => Err(e),
  }
}

fn taken(full_name: &str) -> String {
  t!("commands.githubRepo.taken", name = full_name)
}

/// Whether `owner/name` can take a project's repository, as `account`: a free
/// name, or an empty repository the account can push to (said, since
/// Fabricator then uses it).
#[tauri::command]
pub async fn github_check_repo(account: String, owner: String, name: String) -> ProjectNameCheck {
  let (account, owner, name) = (account.trim(), owner.trim(), name.trim());
  if let Err(message) = check_names(account, owner, name) {
    return ProjectNameCheck { ok: false, message: Some(message) };
  }
  let full_name = format!("{owner}/{name}");
  match gh::as_account(Some(account.to_string()), existing(&full_name)).await {
    Ok(Existing::Taken) => ProjectNameCheck { ok: false, message: Some(taken(&full_name)) },
    Ok(Existing::Empty(_)) => ProjectNameCheck {
      ok: true,
      message: Some(t!("commands.githubRepo.adoptEmpty", name = full_name)),
    },
    // A check that couldn't run doesn't stop creating, which then says what's wrong.
    Ok(Existing::Free) | Err(_) => ProjectNameCheck { ok: true, message: None },
  }
}

/* -------------------------------- create ---------------------------------- */

/// Create a GitHub repository for a project, push its versions, and remember
/// the account for getting and pushing its changes.
#[tauri::command]
pub async fn github_create_repo(id: String, request: GithubRepoRequest) -> GithubRepoResult {
  let result = create_repo(&id, &request).await;
  let entry = match (&result.url, &result.error) {
    (Some(url), _) => journal::entry(Level::Info, Area::Git, "project.github.created", &format!("Put the app on GitHub: {url}.")),
    (_, error) => journal::entry(
      Level::Error,
      Area::Git,
      "project.github.failed",
      error.as_deref().unwrap_or("Couldn't create the app's GitHub repository."),
    )
    .surface(Surface::Backend),
  };
  entry.project(Some(id)).write();
  result
}

async fn create_repo(id: &str, request: &GithubRepoRequest) -> GithubRepoResult {
  let (account, owner, name) = (request.account.trim(), request.owner.trim(), request.name.trim());
  if let Err(message) = check_names(account, owner, name) {
    return failed(message);
  }
  let Some(project) = store::find_project(id) else {
    return failed(t!("commands.shared.projectNotFound"));
  };
  if project.team.is_some() {
    return failed(t!("commands.githubRepo.teamApp"));
  }
  let dir = Path::new(&project.path);
  if !dir.is_dir() {
    return failed(t!("commands.githubRepo.folderMissing"));
  }
  if let Err(message) = own_history(dir).await {
    return failed(message);
  }
  gh::as_account(Some(account.to_string()), async {
    let repo = match create_or_adopt(account, owner, name, request.private).await {
      Ok(repo) => repo,
      Err(message) => return failed(message),
    };
    if let Err(message) = push_first(dir, &repo.full_name).await {
      return failed(t!("commands.githubRepo.pushFailed", name = repo.full_name, message = message));
    }
    store::mutate_project(id, |p| p.github_account = Some(account.to_string()));
    let url = if repo.html_url.is_empty() { format!("https://github.com/{}", repo.full_name) } else { repo.html_url };
    GithubRepoResult { ok: true, error: None, url: Some(url) }
  })
  .await
}

fn local(dir: &Path) -> RunOptions {
  RunOptions { cwd: Some(dir.to_path_buf()), timeout_ms: Some(30_000), ..Default::default() }
}

/// The project is the root of its own git repository, with a first version and
/// no remote yet.
async fn own_history(dir: &Path) -> Result<(), String> {
  let up = git::run(&["rev-parse", "--show-cdup"], local(dir)).await;
  if !up.ok {
    return Err(t!("commands.githubRepo.notTracked"));
  }
  if !up.stdout.trim().is_empty() {
    let top = git::run(&["rev-parse", "--show-toplevel"], local(dir)).await;
    return Err(t!("commands.githubRepo.partOfRepo", path = top.stdout.trim()));
  }
  let remotes = git::run(&["remote"], local(dir)).await;
  if remotes.ok && !remotes.stdout.trim().is_empty() {
    return Err(t!("commands.githubRepo.hasRemote"));
  }
  let head = git::run(&["rev-parse", "--verify", "--quiet", "HEAD"], local(dir)).await;
  if !head.ok {
    return Err(t!("commands.githubRepo.saveFirst"));
  }
  Ok(())
}

/// Create `owner/name` as the current account, or use it when it's already
/// there, empty, and the account can push to it.
async fn create_or_adopt(account: &str, owner: &str, name: &str, private: bool) -> Result<RepoInfo, String> {
  let full_name = format!("{owner}/{name}");
  let body = json!({ "name": name, "private": private, "auto_init": false });
  match gh::api("POST", &create_path(account, owner), Some(&body)).await {
    Ok(v) => gh::repo_info(&v).ok_or_else(|| t!("commands.githubRepo.unexpectedRepo")),
    Err(e) if e.status == Some(422) && e.message.to_ascii_lowercase().contains("already exists") => {
      match existing(&full_name).await {
        Ok(Existing::Empty(info)) => Ok(info),
        Ok(_) => Err(taken(&full_name)),
        Err(e) => Err(e.describe(&t!("commands.githubRepo.useExisting"))),
      }
    }
    Err(e) => Err(e.describe(&t!("commands.githubRepo.createRepo"))),
  }
}

/// Point `origin` at the new repository and push the current branch to it,
/// following it from then on. A failed push leaves no remote behind, so trying
/// again starts over, with the repository still empty.
async fn push_first(dir: &Path, full_name: &str) -> Result<(), String> {
  let url = format!("https://github.com/{full_name}.git");
  let added = git::run(&["remote", "add", "origin", &url], local(dir)).await;
  if !added.ok {
    return Err(reason(&added));
  }
  let pushed = match account_auth().await {
    Ok(auth) => auth.git(dir, &["push", "--quiet", "-u", "origin", "HEAD"], 300_000).await,
    Err(message) => {
      let _ = git::run(&["remote", "remove", "origin"], local(dir)).await;
      return Err(message);
    }
  };
  if pushed.ok {
    return Ok(());
  }
  let _ = git::run(&["remote", "remove", "origin"], local(dir)).await;
  Err(reason(&pushed))
}

/// What git said went wrong, without its hints.
fn reason(res: &RunResult) -> String {
  let lines: Vec<&str> = res
    .stderr
    .lines()
    .chain(res.stdout.lines())
    .map(str::trim)
    .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
    .take(3)
    .collect();
  if lines.is_empty() {
    t!("commands.githubRepo.noReason")
  } else {
    lines.join(" ")
  }
}

/* ------------------------------- syncing ---------------------------------- */

/// Git arguments and environment that authenticate to GitHub with the GitHub
/// CLI's sign-in for one account, for one command: no git configuration changes.
pub(crate) struct NetAuth {
  pub args: Vec<String>,
  pub env: Vec<(String, String)>,
}

impl NetAuth {
  fn with(token: Option<String>) -> Self {
    let mut env = vec![
      ("GH_HOST".to_string(), "github.com".to_string()),
      ("GH_PROMPT_DISABLED".to_string(), "1".to_string()),
    ];
    if let Some(token) = token {
      // The CLI's credential helper prefers it to the active account's sign-in.
      env.push(("GH_TOKEN".to_string(), token));
    }
    NetAuth { args: gh::git_credential_args(), env }
  }

  async fn git(&self, dir: &Path, args: &[&str], timeout_ms: u64) -> RunResult {
    let mut full = self.args.clone();
    full.extend(args.iter().map(|a| a.to_string()));
    let refs: Vec<&str> = full.iter().map(String::as_str).collect();
    let mut env = self.env.clone();
    env.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
    env.push(("GCM_INTERACTIVE".into(), "Never".into()));
    git::run(
      &refs,
      RunOptions {
        cwd: Some(dir.to_path_buf()),
        env,
        env_remove: vec!["GH_TOKEN".into(), "GITHUB_TOKEN".into()],
        timeout_ms: Some(timeout_ms),
        ..Default::default()
      },
    )
    .await
  }
}

/// [`NetAuth`] for the account the current task acts as.
async fn account_auth() -> Result<NetAuth, String> {
  gh::account_token().await.map(NetAuth::with).map_err(|e| e.describe(&t!("commands.githubRepo.connect")))
}

fn is_github_https(url: &str) -> bool {
  url.trim().to_ascii_lowercase().starts_with("https://github.com/")
}

/// How git reaches GitHub for the project in `dir`: as the account Fabricator
/// created its repository as. `None` for any other project, or when its
/// `origin` no longer points at github.com over HTTPS; git's own credentials
/// then apply, as they always have.
pub(crate) async fn network_auth(dir: &str) -> Option<Result<NetAuth, String>> {
  let login = store::get_state().projects.into_iter().find(|p| same_path(&p.path, dir))?.github_account?;
  let origin = git::run(&["config", "--get", "remote.origin.url"], local(Path::new(dir))).await;
  if !is_github_https(&origin.stdout) {
    return None;
  }
  Some(gh::as_account(Some(login), account_auth()).await)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  #[test]
  fn repository_names_follow_githubs_rules() {
    for ok in ["sales", "trip-logger", "Trip_Logger.v2", "a"] {
      assert!(valid_repo_name(ok), "{ok}");
    }
    let long = "a".repeat(101);
    for bad in ["", ".", "..", "my app", "app/two", "app.git", "café", long.as_str()] {
      assert!(!valid_repo_name(bad), "{bad}");
    }
    assert_eq!(check_names("octo", "contoso", "my app"), Err(name_rule()));
    assert!(check_names("octo; rm", "contoso", "sales").is_err());
    assert!(check_names("octo", "-contoso", "sales").is_err());
    assert!(check_names("octo_contoso", "contoso", "sales").is_ok());
  }

  #[test]
  fn the_account_creates_in_its_own_name_or_an_organizations() {
    assert_eq!(create_path("octo", "octo"), "user/repos");
    assert_eq!(create_path("Octo", "octo"), "user/repos");
    assert_eq!(create_path("octo", "contoso"), "orgs/contoso/repos");
  }

  #[test]
  fn only_https_github_remotes_sync_as_the_account() {
    assert!(is_github_https("https://github.com/contoso/sales.git\n"));
    assert!(is_github_https("HTTPS://GitHub.com/contoso/sales"));
    assert!(!is_github_https("git@github.com:contoso/sales.git"));
    assert!(!is_github_https("https://github.com.evil.invalid/contoso/sales.git"));
    assert!(!is_github_https("https://dev.azure.com/contoso/_git/sales"));
    assert!(!is_github_https(""));
  }

  #[test]
  fn git_says_why_without_its_hints() {
    let res = RunResult {
      ok: false,
      exit_code: Some(128),
      stdout: String::new(),
      stderr: "remote: Permission to contoso/sales.git denied to octo.\nhint: see git help\nfatal: unable to access\n".into(),
      not_found: false,
    };
    assert_eq!(reason(&res), "remote: Permission to contoso/sales.git denied to octo. fatal: unable to access");
    assert_eq!(reason(&RunResult { stderr: String::new(), ..res }), "Git didn't say why.");
  }

  /// A folder for a repository test, removed afterwards.
  struct Folder(PathBuf);

  impl Folder {
    fn new() -> Self {
      let dir = std::env::temp_dir().join(format!("fabricator-ghrepo-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&dir).unwrap();
      Folder(dir)
    }

    fn git(&self, at: &Path, args: &[&str]) {
      let out = std::process::Command::new("git").args(args).current_dir(at).output().expect("git runs");
      assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A repository at `at` with one commit.
    fn repo(&self, at: &Path) {
      std::fs::create_dir_all(at).unwrap();
      self.git(at, &["init", "--quiet"]);
      self.git(at, &["config", "user.name", "t"]);
      self.git(at, &["config", "user.email", "t@t"]);
      std::fs::write(at.join("app.txt"), "v1\n").unwrap();
      self.git(at, &["add", "-A"]);
      self.git(at, &["commit", "--quiet", "-m", "First"]);
    }
  }

  impl Drop for Folder {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  #[tokio::test]
  async fn only_a_project_with_its_own_history_and_no_remote_goes_on_github() {
    if which::which("git").is_err() {
      return;
    }
    let folder = Folder::new();

    let untracked = folder.0.join("untracked");
    std::fs::create_dir_all(&untracked).unwrap();
    assert!(own_history(&untracked).await.unwrap_err().contains("isn't tracked by git"));

    let app = folder.0.join("app");
    folder.repo(&app);
    assert_eq!(own_history(&app).await, Ok(()));

    let nested = app.join("apps").join("inner");
    std::fs::create_dir_all(&nested).unwrap();
    assert!(own_history(&nested).await.unwrap_err().contains("is part of the git repository at"));

    folder.git(&app, &["remote", "add", "origin", "https://github.com/contoso/app.git"]);
    assert!(own_history(&app).await.unwrap_err().contains("already has a remote"));

    let fresh = folder.0.join("fresh");
    std::fs::create_dir_all(&fresh).unwrap();
    folder.git(&fresh, &["init", "--quiet"]);
    assert!(own_history(&fresh).await.unwrap_err().contains("Save a first version"));
  }
}
