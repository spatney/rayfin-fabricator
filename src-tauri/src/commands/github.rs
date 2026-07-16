//! GitHub integration for "Open existing… → Clone from GitHub". Everything is
//! driven through the optional `gh` CLI (GitHub CLI), resolved on `PATH` by the
//! shared [`exec`] runner. When `gh` is missing the doctor offers to install it
//! (see `commands::doctor`); until then these commands report `gh_installed:false`
//! / a friendly error rather than failing hard.
//!
//! `gh auth login --web` can't be driven headlessly (it needs a real TTY), so
//! [`github_login`] launches the user's terminal running it and the renderer
//! polls [`github_status`] until sign-in is detected.

use std::path::Path;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use tauri::AppHandle;

use crate::commands::util::is_rayfin_project;
use crate::services::emit::proc_streamer;
use crate::services::exec::{self, OnData, RunOptions, Stream};
use crate::services::store;
use crate::types::{GithubRepo, GithubReposResult, GithubStatus, ProcResult, ProjectActionResult};

/// Streaming channel for `gh repo clone` output (matches `IpcChannels.githubClone` consumer).
const CLONE_CHANNEL: &str = "clone:project";

/// The `--json` fields we request from `gh repo list` (kept in sync with [`RawRepo`]).
const REPO_LIST_FIELDS: &str =
  "nameWithOwner,name,description,visibility,updatedAt,url,isPrivate,isFork,primaryLanguage";

fn err(msg: impl Into<String>) -> ProjectActionResult {
  ProjectActionResult {
    ok: false,
    error: Some(msg.into()),
    project: None,
  }
}

fn say(on: &OnData, msg: &str) {
  on(Stream::Stdout, msg);
}

/* --------------------------------- status --------------------------------- */

static AUTH_USER_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)\b(?:account|as)\s+([A-Za-z0-9][A-Za-z0-9-]*)").unwrap());

/// Extract the signed-in GitHub username from `gh auth status` output, tolerating
/// both the current ("Logged in to github.com account <user>") and older
/// ("Logged in to github.com as <user>") phrasings.
fn parse_auth_user(text: &str) -> Option<String> {
  AUTH_USER_RE
    .captures(text)
    .and_then(|c| c.get(1))
    .map(|m| m.as_str().to_string())
}

/// Report whether `gh` is installed and whether the user is signed in.
#[tauri::command]
pub async fn github_status() -> GithubStatus {
  let res = exec::run("gh", &["auth", "status"], RunOptions::timeout(20_000)).await;
  if res.not_found {
    return GithubStatus {
      gh_installed: false,
      signed_in: false,
      user: None,
    };
  }
  // `gh auth status` exits 0 only when signed in to at least one host.
  let text = format!("{}\n{}", res.stdout, res.stderr);
  GithubStatus {
    gh_installed: true,
    signed_in: res.ok,
    user: if res.ok { parse_auth_user(&text) } else { None },
  }
}

/* ---------------------------------- login --------------------------------- */

/// The `gh auth login` invocation used in the launched terminal — the web/device
/// flow, with the git protocol pinned so gh doesn't prompt for it.
const LOGIN_CMD: &str = "gh auth login --web --git-protocol https --hostname github.com";

/// Launch the user's terminal running `gh auth login --web` (browser + one-time
/// code). Returns `ok:false` when `gh` isn't installed or the terminal couldn't
/// be spawned; the renderer then polls [`github_status`] to detect completion.
#[tauri::command]
pub fn github_login() -> ProcResult {
  if which::which("gh").is_err() {
    return ProcResult {
      ok: false,
      exit_code: None,
      error: Some("The GitHub CLI (gh) is not installed or not on PATH.".into()),
    };
  }
  let ok = launch_login_terminal();
  ProcResult {
    ok,
    exit_code: None,
    error: None,
  }
}

#[cfg(target_os = "windows")]
fn launch_login_terminal() -> bool {
  // `start "" cmd /K <cmd>` opens a fresh console window that stays open (so the
  // user can read the one-time code and any errors). No CREATE_NO_WINDOW here —
  // we want the window to be visible.
  std::process::Command::new("cmd")
    .args(["/C", "start", "", "cmd", "/K", LOGIN_CMD])
    .spawn()
    .is_ok()
}

#[cfg(target_os = "macos")]
fn launch_login_terminal() -> bool {
  let script = format!("tell application \"Terminal\" to do script \"{LOGIN_CMD}\"");
  std::process::Command::new("osascript")
    .args([
      "-e",
      &script,
      "-e",
      "tell application \"Terminal\" to activate",
    ])
    .spawn()
    .is_ok()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn launch_login_terminal() -> bool {
  // Best-effort on Linux (not a shipped target): try a common terminal emulator.
  std::process::Command::new("x-terminal-emulator")
    .args(["-e", "sh", "-c", &format!("{LOGIN_CMD}; exec sh")])
    .spawn()
    .is_ok()
}

/* --------------------------------- list ----------------------------------- */

#[derive(Deserialize)]
struct RawLang {
  name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepo {
  name_with_owner: String,
  name: String,
  #[serde(default)]
  description: Option<String>,
  #[serde(default)]
  visibility: Option<String>,
  #[serde(default)]
  updated_at: Option<String>,
  #[serde(default)]
  url: Option<String>,
  #[serde(default)]
  is_private: bool,
  #[serde(default)]
  is_fork: bool,
  #[serde(default)]
  primary_language: Option<RawLang>,
}

/// Parse `gh repo list --json …` output into [`GithubRepo`]s. `description` is
/// normalized so empty strings become `None`, and `primaryLanguage` (a nullable
/// `{name}` object) is flattened to its name.
fn parse_repos_json(stdout: &str) -> Result<Vec<GithubRepo>, String> {
  let raw: Vec<RawRepo> = serde_json::from_str(stdout.trim())
    .map_err(|e| format!("Could not read the repository list: {e}"))?;
  Ok(
    raw
      .into_iter()
      .map(|r| GithubRepo {
        name_with_owner: r.name_with_owner,
        name: r.name,
        description: r.description.filter(|d| !d.trim().is_empty()),
        visibility: r.visibility,
        updated_at: r.updated_at,
        url: r.url,
        is_private: r.is_private,
        is_fork: r.is_fork,
        primary_language: r.primary_language.and_then(|l| l.name),
      })
      .collect(),
  )
}

/// List the signed-in user's repositories (most-recent first, capped at 200).
#[tauri::command]
pub async fn github_list_repos() -> GithubReposResult {
  let res = exec::run(
    "gh",
    &["repo", "list", "--json", REPO_LIST_FIELDS, "--limit", "200"],
    RunOptions::timeout(30_000),
  )
  .await;
  if res.not_found {
    return GithubReposResult {
      ok: false,
      error: Some("GitHub CLI (gh) was not found. Install it to browse repositories.".into()),
      repos: vec![],
    };
  }
  if !res.ok {
    let detail = res.stderr.trim();
    let msg = if detail.is_empty() {
      "Could not list your repositories. Make sure you're signed in to GitHub.".to_string()
    } else {
      format!("Could not list your repositories: {detail}")
    };
    return GithubReposResult {
      ok: false,
      error: Some(msg),
      repos: vec![],
    };
  }
  match parse_repos_json(&res.stdout) {
    Ok(repos) => GithubReposResult {
      ok: true,
      error: None,
      repos,
    },
    Err(e) => GithubReposResult {
      ok: false,
      error: Some(e),
      repos: vec![],
    },
  }
}

/* --------------------------------- clone ---------------------------------- */

/// Extract the repo URL's `name` component (group 2), tolerating a `.git` suffix,
/// a trailing slash, and query/fragment tails. Matches `https://…` and `git@…`.
static GH_URL_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?i)github\.com[/:]([^/\s]+)/([^/\s#?]+?)(?:\.git)?/?(?:[#?].*)?$").unwrap()
});

/// Reject anything that isn't a safe single path segment (no separators / dot dirs).
fn sanitize_repo_name(name: &str) -> Option<String> {
  let n = name.trim().trim_end_matches(".git").trim();
  if n.is_empty() || n == "." || n == ".." || n.contains('/') || n.contains('\\') {
    return None;
  }
  Some(n.to_string())
}

/// Derive the destination folder name for a clone input, which may be a full
/// GitHub URL, an `git@github.com:owner/name.git` SCP form, or an `owner/name`
/// shorthand. Returns `None` for inputs that aren't cloneable (e.g. a bare name).
fn clone_target_name(input: &str) -> Option<String> {
  let s = input.trim();
  if s.is_empty() {
    return None;
  }
  if let Some(caps) = GH_URL_RE.captures(s) {
    return sanitize_repo_name(caps.get(2)?.as_str());
  }
  if s.contains('/') {
    let last = s.rsplit('/').next()?.trim();
    return sanitize_repo_name(last);
  }
  None
}

/// Clone a repository (`owner/name` or a GitHub URL) into the workspace root,
/// install its dependencies (`npm install`), then register + open it. Enforces the
/// Rayfin-project requirement: a clone that isn't a Rayfin project is removed and
/// reported as an error. A dependency-install failure keeps the clone on disk (so
/// the user can finish it manually) and is reported. Streams output on the
/// `clone:project` channel.
#[tauri::command]
pub async fn github_clone(app: AppHandle, input: String) -> ProjectActionResult {
  let on = proc_streamer(&app, CLONE_CHANNEL);

  let Some(target_name) = clone_target_name(&input) else {
    return err("Enter a repository as owner/name or a GitHub URL.");
  };

  let root = store::get_state().workspace_root;
  if !Path::new(&root).exists() {
    if let Err(e) = std::fs::create_dir_all(&root) {
      return err(format!("Could not create workspace folder: {e}"));
    }
  }
  let dir = Path::new(&root).join(&target_name);
  if dir.exists() {
    return err(format!(
      "A folder named \"{target_name}\" already exists in your workspace."
    ));
  }
  let dir_str = dir.to_string_lossy().to_string();

  say(&on, &format!("Cloning {} …\n", input.trim()));
  let res = exec::run(
    "gh",
    &["repo", "clone", input.trim(), &dir_str],
    RunOptions {
      cwd: Some(Path::new(&root).to_path_buf()),
      on_data: Some(on.clone()),
      timeout_ms: Some(300_000),
      ..Default::default()
    },
  )
  .await;

  if res.not_found {
    return err("GitHub CLI (gh) was not found. Install it, then try cloning again.");
  }
  if !res.ok {
    // Remove any partial checkout so a retry starts clean (dir didn't exist before).
    let _ = std::fs::remove_dir_all(&dir);
    let code = res
      .exit_code
      .map(|c| c.to_string())
      .unwrap_or_else(|| "unknown".into());
    let detail = res.stderr.trim();
    return err(if detail.is_empty() {
      format!("Clone failed (exit code {code}).")
    } else {
      format!("Clone failed (exit code {code}): {detail}")
    });
  }

  say(&on, "\nVerifying Rayfin project…\n");
  if !is_rayfin_project(&dir_str) {
    // Not a Rayfin app — discard the fresh clone and report it.
    let _ = std::fs::remove_dir_all(&dir);
    return err("That repository isn't a Rayfin project (no rayfin/rayfin.yml).");
  }

  // A fresh clone has no node_modules; install deps now so preview/deploy work.
  say(&on, "\nInstalling dependencies (npm install)…\n");
  let install = exec::run(
    "npm",
    &["install"],
    RunOptions {
      cwd: Some(dir.clone()),
      on_data: Some(on.clone()),
      timeout_ms: Some(600_000),
      ..Default::default()
    },
  )
  .await;
  if install.not_found {
    // Keep the clone: this is a missing prerequisite (Node/npm), not a bad repo.
    return err(format!(
      "Cloned to {dir_str}, but npm was not found on PATH. Install Node.js (which includes npm), \
       run \"npm install\" in that folder, then use Open existing → Browse folder to open it."
    ));
  }
  if !install.ok {
    // Keep the clone: the checkout is valid and re-cloning is wasteful (a dep
    // failure is often a transient registry/policy issue). Point the user at
    // finishing the install manually, then opening the folder.
    let code = install
      .exit_code
      .map(|c| c.to_string())
      .unwrap_or_else(|| "unknown".into());
    return err(format!(
      "Cloned to {dir_str}, but installing dependencies failed (npm install exited {code}). \
       See details below, then run \"npm install\" in that folder and use Open existing → Browse folder to open it."
    ));
  }

  say(&on, "\n✅ Cloned and dependencies installed. Opening…\n");
  crate::commands::projects_impl::open_project(dir_str).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parse_auth_user_handles_both_phrasings() {
    let current = "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n";
    assert_eq!(parse_auth_user(current), Some("octocat".to_string()));
    let older = "✓ Logged in to github.com as hub-user (oauth_token)\n";
    assert_eq!(parse_auth_user(older), Some("hub-user".to_string()));
    assert_eq!(parse_auth_user("You are not logged into any GitHub hosts."), None);
  }

  #[test]
  fn parse_repos_json_flattens_language_and_empty_description() {
    let json = r#"[
      {"nameWithOwner":"octocat/app","name":"app","description":"An app","visibility":"PUBLIC",
       "updatedAt":"2024-01-02T03:04:05Z","url":"https://github.com/octocat/app",
       "isPrivate":false,"isFork":false,"primaryLanguage":{"name":"Rust"}},
      {"nameWithOwner":"octocat/empty","name":"empty","description":"","visibility":"PRIVATE",
       "updatedAt":"2024-02-02T00:00:00Z","url":"https://github.com/octocat/empty",
       "isPrivate":true,"isFork":true,"primaryLanguage":null}
    ]"#;
    let repos = parse_repos_json(json).expect("parse");
    assert_eq!(repos.len(), 2);
    assert_eq!(repos[0].name_with_owner, "octocat/app");
    assert_eq!(repos[0].primary_language.as_deref(), Some("Rust"));
    assert_eq!(repos[0].description.as_deref(), Some("An app"));
    assert!(!repos[0].is_private);
    // Empty description → None; null primaryLanguage → None; flags preserved.
    assert_eq!(repos[1].description, None);
    assert_eq!(repos[1].primary_language, None);
    assert!(repos[1].is_private);
    assert!(repos[1].is_fork);
  }

  #[test]
  fn parse_repos_json_rejects_garbage() {
    assert!(parse_repos_json("not json").is_err());
  }

  #[test]
  fn clone_target_name_derives_folder_from_various_forms() {
    assert_eq!(clone_target_name("octocat/Hello-World"), Some("Hello-World".into()));
    assert_eq!(
      clone_target_name("https://github.com/octocat/Hello-World"),
      Some("Hello-World".into())
    );
    assert_eq!(
      clone_target_name("https://github.com/octocat/Hello-World.git"),
      Some("Hello-World".into())
    );
    assert_eq!(
      clone_target_name("git@github.com:octocat/Hello-World.git"),
      Some("Hello-World".into())
    );
    assert_eq!(
      clone_target_name("https://github.com/octocat/Hello-World/"),
      Some("Hello-World".into())
    );
    // Not cloneable / unsafe inputs.
    assert_eq!(clone_target_name("just-a-name"), None);
    assert_eq!(clone_target_name(""), None);
    assert_eq!(clone_target_name("   "), None);
    assert_eq!(clone_target_name("owner/"), None);
  }
}
