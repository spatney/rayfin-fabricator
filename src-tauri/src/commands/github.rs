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

const AUTH_PROBE_ARGS: &[&str] =
  &["api", "--hostname", "github.com", "user", "--jq", "{login: .login, id: .id}"];

fn gh_options(timeout_ms: u64) -> RunOptions {
  RunOptions {
    env: vec![
      ("GH_HOST".into(), "github.com".into()),
      ("GH_PROMPT_DISABLED".into(), "1".into()),
      ("GIT_TERMINAL_PROMPT".into(), "0".into()),
      ("GCM_INTERACTIVE".into(), "Never".into()),
    ],
    timeout_ms: Some(timeout_ms),
    ..Default::default()
  }
}

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
  Lazy::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$").unwrap());

#[derive(Deserialize)]
struct ApiIdentity {
  id: u64,
  login: String,
}

fn status_from_result(res: &exec::RunResult) -> GithubStatus {
  let identity = serde_json::from_str::<ApiIdentity>(&res.stdout)
    .ok()
    .filter(|identity| identity.id > 0 && AUTH_USER_RE.is_match(&identity.login));
  let signed_in = res.ok && !res.not_found && identity.is_some();
  GithubStatus {
    gh_installed: !res.not_found,
    signed_in,
    user: if signed_in { identity.map(|identity| identity.login) } else { None },
  }
}

/// Verify the active github.com credential with a read-only API request.
/// `gh auth status` can describe a different host or an inactive account.
#[tauri::command]
pub async fn github_status() -> GithubStatus {
  let res = exec::run("gh", AUTH_PROBE_ARGS, gh_options(20_000)).await;
  status_from_result(&res)
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
  for name in ["GH_TOKEN", "GITHUB_TOKEN"] {
    if std::env::var_os(name).is_some_and(|value| !value.is_empty()) {
      return ProcResult {
        ok: false,
        exit_code: None,
        error: Some(format!(
          "{name} overrides the GitHub CLI's saved credentials. Update or unset that environment variable before signing in; browser sign-in cannot replace it."
        )),
      };
    }
  }
  let ok = launch_login_terminal();
  ProcResult {
    ok,
    exit_code: None,
    error: (!ok).then(|| "Could not open a terminal for GitHub sign-in. Run `gh auth login --hostname github.com` in your terminal.".into()),
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

static AUTH_FAILURE_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?i)\bHTTP[ /:]*(?:401)\b|\bbad credentials\b|\brequires authentication\b|\bauthentication (?:failed|required)\b|\bgh auth login\b|\binvalid (?:oauth |authentication )?token\b").unwrap()
});

fn command_error(operation: &str, res: &exec::RunResult) -> String {
  if res.exit_code == Some(4) || AUTH_FAILURE_RE.is_match(&res.stderr) {
    return format!("{operation}: GitHub authentication is required or has expired. Sign in to github.com again.");
  }
  let detail = res.stderr.trim();
  if detail.is_empty() {
    format!(
      "{operation} (exit {}).",
      res.exit_code.map(|code| code.to_string()).unwrap_or_else(|| "unknown".into())
    )
  } else {
    format!("{operation}: {detail}")
  }
}

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
    gh_options(30_000),
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
    return GithubReposResult {
      ok: false,
      error: Some(command_error("Could not list your repositories", &res)),
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

/// Accept only github.com repositories, never credentials or arbitrary hosts.
static GH_URL_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?i)^(?:https://github\.com(?::443)?/|git@github\.com:|ssh://git@github\.com/)?([a-z0-9][a-z0-9-]{0,38})/([a-z0-9_.-]{1,100}?)(?:\.git)?/?(?:[#?].*)?$").unwrap()
});

/// Reject anything that isn't a safe single path segment (no separators / dot dirs).
fn sanitize_repo_name(name: &str) -> Option<String> {
  let n = name.trim();
  if n.is_empty() || n == "." || n == ".." || n.eq_ignore_ascii_case(".git") || n.ends_with('.') || n.contains('/') || n.contains('\\') {
    return None;
  }
  let stem = n.split('.').next()?.to_ascii_uppercase();
  if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
    || (stem.len() == 4
      && (stem.starts_with("COM") || stem.starts_with("LPT"))
      && matches!(stem.as_bytes()[3], b'1'..=b'9'))
  {
    return None;
  }
  Some(n.to_string())
}

/// Normalize URL/SSH/shorthand inputs to HTTPS so clone uses the same gh
/// credential as the status and repository-list probes, not a separate SSH key.
fn clone_target(input: &str) -> Option<(String, String)> {
  let caps = GH_URL_RE.captures(input.trim())?;
  let owner = caps.get(1)?.as_str();
  let name = sanitize_repo_name(caps.get(2)?.as_str())?;
  Some((format!("https://github.com/{owner}/{name}.git"), name))
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

  let Some((repository, target_name)) = clone_target(&input) else {
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

  say(&on, &format!("Cloning {repository} …\n"));
  let res = exec::run(
    "gh",
    &["repo", "clone", &repository, &dir_str],
    RunOptions {
      cwd: Some(Path::new(&root).to_path_buf()),
      on_data: Some(on.clone()),
      ..gh_options(300_000)
    },
  )
  .await;

  if res.not_found {
    return err("GitHub CLI (gh) was not found. Install it, then try cloning again.");
  }
  if !res.ok {
    // Remove any partial checkout so a retry starts clean (dir didn't exist before).
    let _ = std::fs::remove_dir_all(&dir);
    return err(command_error("Clone failed", &res));
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
  fn status_requires_a_verified_api_identity() {
    let mut res = exec::RunResult {
      ok: true,
      exit_code: Some(0),
      stdout: r#"{"login":"octocat","id":1}"#.into(),
      stderr: String::new(),
      not_found: false,
    };
    assert!(status_from_result(&res).signed_in);
    assert_eq!(status_from_result(&res).user.as_deref(), Some("octocat"));
    for text in ["", "null", "Logged in to github.example account octocat", "{}", r#"{"login":null,"id":1}"#, r#"{"login":"octocat","id":0}"#] {
      res.stdout = text.into();
      assert!(!status_from_result(&res).signed_in);
    }
    res.stdout = r#"{"login":"octocat","id":1}"#.into();
    res.ok = false;
    assert!(!status_from_result(&res).signed_in);
    assert!(status_from_result(&res).user.is_none());
    res.not_found = true;
    assert!(!status_from_result(&res).gh_installed);
  }

  #[test]
  fn gh_operations_pin_host_and_disable_interactive_prompts() {
    assert!(AUTH_PROBE_ARGS.windows(2).any(|args| args == ["--hostname", "github.com"]));
    let options = gh_options(1000);
    assert!(options.env.contains(&("GH_HOST".into(), "github.com".into())));
    assert!(options.env.contains(&("GH_PROMPT_DISABLED".into(), "1".into())));
    assert!(options.env.contains(&("GIT_TERMINAL_PROMPT".into(), "0".into())));
  }

  #[test]
  fn expired_credentials_are_not_permission_errors() {
    let mut res = exec::RunResult {
      ok: false,
      exit_code: Some(1),
      stdout: String::new(),
      stderr: "HTTP 401: Bad credentials".into(),
      not_found: false,
    };
    assert!(command_error("List failed", &res).contains("Sign in to github.com again"));
    res.stderr = "HTTP 403: Resource not accessible by integration".into();
    assert!(!command_error("List failed", &res).contains("Sign in"));
    res.stderr.clear();
    res.exit_code = Some(4);
    assert!(command_error("Clone failed", &res).contains("Sign in"));
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
    let clone_target_name = |input| clone_target(input).map(|(_, name)| name);
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

  #[test]
  fn clone_rejects_other_hosts_credentials_and_unsafe_destinations() {
    for input in [
      "https://github.com.evil.invalid/owner/repo",
      "https://other.invalid/github.com/owner/repo",
      "https://user:synthetic@github.com/owner/repo",
      "http://github.com/owner/repo",
      "--config/option",
      "owner/../repo",
      "owner/.git",
      "owner/CON",
      "owner/NUL.txt",
      "owner/repo.",
      "owner/repo:stream",
    ] {
      assert!(clone_target(input).is_none(), "{input}");
    }
    assert_eq!(
      clone_target("git@github.com:octocat/app.git"),
      Some(("https://github.com/octocat/app.git".into(), "app".into()))
    );
  }
}
