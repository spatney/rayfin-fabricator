//! Project scaffolding/registration (ported from `src/main/services/projects.ts`).
//! Handles listing templates, creating a project via `npm create
//! @microsoft/rayfin` (the official scaffolder, streaming live output on the
//! `create:project` proc channel) on the Rayfin release new projects start on,
//! opening an existing project, renaming, and removing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::util::{annotate_project, is_rayfin_project, normalize, same_path};
use crate::services::exec::{run_npm, OnData, RunOptions, RunResult, Stream};
use crate::services::rayfin_sdk::{self, Pinning};
use crate::services::{emit, git, history, store, version_history};
use crate::state::AppState;
use crate::types::{
  CommunityGallery, CommunityGalleryResult, CommunityTemplate, CreateProjectInput, DeleteProgressEvent,
  ProjectActionResult, ProjectLocationCheck, ProjectNameCheck, ProjectsState, StudioProject,
};

const CREATE_CHANNEL: &str = "create:project";

/// The template every new project uses unless the user picks a community
/// example: the Rayfin CLI's built-in Universal App (the CLI's own picker offers
/// it as "Use default template"). It starts as a small authenticated app with the
/// data service off, so no database is created until the app needs one, and its
/// capability router grows it into whatever the user describes, so nobody has to
/// choose an app shape up front.
pub(crate) const STARTER_TEMPLATE: &str = "universal-app";

/// Default community gallery (the user can point at any compatible repo).
const DEFAULT_GALLERY: &str = "https://github.com/microsoft/awesome-rayfin";

/// Cache parsed galleries per repo URL (successful fetches only).
static GALLERY_CACHE: Lazy<std::sync::Mutex<HashMap<String, CommunityGallery>>> =
  Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

/// Extract { owner, repo } from a GitHub repo URL (https or git@).
static GH_REPO_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)github\.com[/:]([^/]+)/([^/#?]+?)(?:\.git)?/?$").unwrap());

fn parse_github_repo(url: &str) -> Option<(String, String)> {
  let caps = GH_REPO_RE.captures(url.trim())?;
  Some((caps.get(1)?.as_str().to_string(), caps.get(2)?.as_str().to_string()))
}

/// Fetch text with a timeout; returns None on any non-2xx / network error.
async fn fetch_text(url: &str, timeout: Duration) -> Option<String> {
  let client = reqwest::Client::builder().timeout(timeout).build().ok()?;
  let res = client.get(url).send().await.ok()?;
  if !res.status().is_success() {
    return None;
  }
  res.text().await.ok()
}

/// Coerce a YAML node to a string, mirroring the TS `str()` (non-strings → "").
fn yaml_str(value: Option<&serde_yaml::Value>) -> String {
  match value {
    Some(serde_yaml::Value::String(s)) => s.clone(),
    _ => String::new(),
  }
}

/// Fetch + parse a community gallery's root `rayfin-template.yml` (the same file
/// the Rayfin CLI reads for its interactive picker) and return its templates so
/// the user can pick one instead of typing a URL. Cached per repo URL.
pub async fn list_community_templates(repo_url: Option<String>) -> CommunityGalleryResult {
  let url = repo_url
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .unwrap_or(DEFAULT_GALLERY)
    .to_string();

  if let Some(cached) = GALLERY_CACHE.lock().unwrap().get(&url) {
    return CommunityGalleryResult {
      ok: true,
      error: None,
      gallery: Some(cached.clone()),
    };
  }

  let Some((owner, repo)) = parse_github_repo(&url) else {
    return CommunityGalleryResult {
      ok: false,
      error: Some(t!("commands.projects.enterRepoUrl")),
      gallery: None,
    };
  };

  // `rayfin-template.yml` lives at the repo root; try the common default branches.
  let mut raw: Option<String> = None;
  for branch in ["main", "master"] {
    let candidate = format!(
      "https://raw.githubusercontent.com/{owner}/{repo}/{branch}/rayfin-template.yml"
    );
    raw = fetch_text(&candidate, Duration::from_millis(15_000)).await;
    if raw.is_some() {
      break;
    }
  }
  let Some(raw) = raw else {
    return CommunityGalleryResult {
      ok: false,
      error: Some(t!("commands.projects.cantReachGallery", owner = owner, repo = repo)),
      gallery: None,
    };
  };

  let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(&raw) else {
    return CommunityGalleryResult {
      ok: false,
      error: Some(t!("commands.projects.galleryUnreadable")),
      gallery: None,
    };
  };

  let templates: Vec<CommunityTemplate> = doc
    .get("entries")
    .and_then(|e| e.as_sequence())
    .map(|seq| {
      seq
        .iter()
        .filter(|e| !yaml_str(e.get("name")).is_empty())
        .map(|e| CommunityTemplate {
          repo_url: url.clone(),
          path: yaml_str(e.get("path")),
          name: yaml_str(e.get("name")),
          description: yaml_str(e.get("description")),
        })
        .collect()
    })
    .unwrap_or_default();

  if templates.is_empty() {
    return CommunityGalleryResult {
      ok: false,
      error: Some(t!("commands.projects.noTemplates")),
      gallery: None,
    };
  }

  let metadata = doc.get("metadata");
  let display_name = yaml_str(metadata.and_then(|m| m.get("displayName")));
  let description = yaml_str(metadata.and_then(|m| m.get("description")));
  let gallery = CommunityGallery {
    repo_url: url.clone(),
    display_name: if display_name.is_empty() { None } else { Some(display_name) },
    description: if description.is_empty() { None } else { Some(description) },
    templates,
  };
  GALLERY_CACHE.lock().unwrap().insert(url, gallery.clone());
  CommunityGalleryResult {
    ok: true,
    error: None,
    gallery: Some(gallery),
  }
}

static NAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^name:\s*(.+)$").unwrap());

fn now_iso() -> String {
  chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Read the project's display name from rayfin/rayfin.yml (falls back to folder).
fn read_project_name(dir: &str) -> String {
  let yml_path = Path::new(dir).join("rayfin").join("rayfin.yml");
  if let Ok(yml) = std::fs::read_to_string(&yml_path) {
    if let Some(caps) = NAME_RE.captures(&yml) {
      let raw = caps.get(1).unwrap().as_str().trim();
      return raw.trim_matches(['"', '\'']).to_string();
    }
  }
  Path::new(dir)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_default()
}

/// Read the template id the project was scaffolded from, when recorded.
fn read_template(dir: &str) -> Option<String> {
  let manifest = std::fs::read_to_string(Path::new(dir).join("manifest.json")).ok()?;
  let json: serde_json::Value = serde_json::from_str(&manifest).ok()?;
  json
    .get("templateId")
    .and_then(|v| v.as_str())
    .map(String::from)
}

/// Register a project directory in the store (idempotent by path).
pub(crate) fn register_project(dir: &Path, display_name: Option<&str>) -> StudioProject {
  let abs = normalize(dir).to_string_lossy().to_string();
  if let Some(existing) = store::get_state().projects.into_iter().find(|p| same_path(&p.path, &abs)) {
    return existing;
  }
  let name = display_name
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| read_project_name(&abs));
  // Its chat starts with the chat defaults (Settings → Chat defaults).
  let (chat, plugins) = crate::commands::chat::new_project_chat(&store::get_settings());
  let project = StudioProject {
    id: uuid::Uuid::new_v4().to_string(),
    name,
    template: read_template(&abs),
    path: abs,
    added_at: now_iso(),
    last_deploy: None,
    copilot_session_id: None,
    workspace: None,
    workspace_name: None,
    deployment_names: None,
    model: chat.model,
    effort: chat.effort,
    auto_tier: chat.auto_tier,
    context_tier: chat.context_tier,
    plugins,
    preview_mode: None,
    fabric_preview_defaulted: None,
    needs_fabric_portal: None,
    team: None,
    github_account: None,
    missing: None,
    rayfin_version: None,
    last_opened_at: None,
    pinned: false,
    thumbnail_at: None,
  };
  store::upsert_project(project.clone());
  project
}

/// Best-effort update of the `name:` field in rayfin/rayfin.yml.
fn write_project_name(dir: &str, name: &str) {
  let file = Path::new(dir).join("rayfin").join("rayfin.yml");
  let Ok(yml) = std::fs::read_to_string(&file) else {
    return;
  };
  let value = if name.contains([':', '#', '"', '\'', '\n']) {
    serde_json::to_string(name).unwrap_or_else(|_| name.to_string())
  } else {
    name.to_string()
  };
  if NAME_RE.is_match(&yml) {
    let next = NAME_RE.replace(&yml, format!("name: {value}").as_str()).to_string();
    if next != yml {
      if let Err(e) = std::fs::write(&file, next) {
        log::warn!("failed to update project name in {}: {e}", file.display());
      }
    }
  }
}

fn say(on: &OnData, line: &str) {
  (**on)(Stream::Stdout, line);
}

fn run_in(dir: &Path, on: Option<OnData>) -> RunOptions {
  RunOptions {
    cwd: Some(dir.to_path_buf()),
    on_data: on,
    timeout_ms: Some(30_000),
    ..Default::default()
  }
}

/// Initialize a git repo with a baseline commit (best-effort).
async fn init_git_repo(dir: &Path, summary: &str, on: &OnData) {
  say(on, "Initializing git repository…\n");
  let init = git::run(&["init"], run_in(dir, Some(on.clone()))).await;
  if !init.ok {
    return;
  }
  git::run(&["add", "-A"], run_in(dir, None)).await;

  let email = git::run(&["config", "user.email"], run_in(dir, None)).await;
  if email.stdout.trim().is_empty() {
    git::run(&["config", "user.email", "fabricator@rayfin.local"], run_in(dir, None)).await;
    git::run(&["config", "user.name", "Fabricator"], run_in(dir, None)).await;
  }
  git::run(&["commit", "-m", summary], run_in(dir, Some(on.clone()))).await;
}

fn err(message: impl Into<String>) -> ProjectActionResult {
  ProjectActionResult {
    ok: false,
    error: Some(message.into()),
    project: None,
  }
}

/// A validated request to scaffold a project.
pub(crate) struct ScaffoldRequest {
  pub name: String,
  pub slug: String,
  template: String,
  template_name: Option<String>,
  is_url: bool,
  /// The line of Rayfin releases New project picked, when it picked one.
  line: Option<rayfin_sdk::Line>,
}

impl ScaffoldRequest {
  pub fn label(&self) -> String {
    if self.is_url { "community template".to_string() } else { format!("{} template", self.template) }
  }
}

/// Why `name` can't name a project, as the Rayfin CLI's `isValidProjectName`
/// would refuse it when the project is created: only letters, digits, spaces,
/// hyphens and underscores, with at least one letter or digit.
pub(crate) fn project_name_problem(name: &str) -> Option<String> {
  let name = name.trim();
  if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c.is_whitespace()) {
    return Some(t!("commands.projects.nameCharacters"));
  }
  if !name.chars().any(|c| c.is_ascii_alphanumeric()) {
    return Some(t!("commands.projects.nameLetterOrNumber"));
  }
  None
}

/// Whether a new local project named `name` can be created under `root`: its
/// folder (the same slug [`create_project`] uses) must not exist yet.
pub(crate) fn check_local_name_in(root: &Path, name: &str, place: &str) -> ProjectNameCheck {
  if let Some(problem) = project_name_problem(name) {
    return ProjectNameCheck { ok: false, message: Some(problem.into()) };
  }
  let slug = crate::commands::util::slugify(name);
  if slug.is_empty() {
    return ProjectNameCheck { ok: false, message: Some(t!("commands.projects.nameNeedsLetters")) };
  }
  if root.join(&slug).exists() {
    return ProjectNameCheck {
      ok: false,
      message: Some(t!("commands.projects.nameTaken", slug = slug, place = place)),
    };
  }
  ProjectNameCheck { ok: true, message: None }
}

/// [`check_local_name_in`] for where a new project is saved: the folder the
/// user chose, or the projects folder.
pub fn check_local_name(name: &str, location: Option<&str>) -> ProjectNameCheck {
  match chosen_location(location) {
    Some(folder) => check_local_name_in(&folder, name, &t!("commands.projects.place.thatFolder")),
    None => check_local_name_in(Path::new(&store::get_state().workspace_root), name, &t!("commands.projects.place.projectsFolder")),
  }
}

/// The folder the user chose for a new project, when it isn't the projects folder.
fn chosen_location(location: Option<&str>) -> Option<PathBuf> {
  let projects_folder = store::get_state().workspace_root;
  location
    .map(str::trim)
    .filter(|l| !l.is_empty())
    .map(|l| normalize(Path::new(l)))
    .filter(|l| !same_path(&l.to_string_lossy(), &projects_folder))
}

/// Whether `path` can take a new project: a folder that exists, given in full.
/// Blank is the projects folder, which is always fine.
pub fn check_location(path: &str) -> ProjectLocationCheck {
  let path = path.trim();
  let problem = |message: &str| ProjectLocationCheck { ok: false, missing: false, message: Some(message.into()) };
  if path.is_empty() {
    return ProjectLocationCheck { ok: true, ..Default::default() };
  }
  let folder = Path::new(path);
  if !folder.is_absolute() {
    return problem(&t!("commands.projects.enterFullPath"));
  }
  if folder.is_dir() {
    return ProjectLocationCheck { ok: true, ..Default::default() };
  }
  if folder.exists() {
    return problem(&t!("commands.projects.notAFolder"));
  }
  ProjectLocationCheck { ok: false, missing: true, message: Some(t!("commands.projects.folderMissing")) }
}

/// Create a missing folder for a new project to go in.
pub fn create_location(path: &str) -> ProjectLocationCheck {
  let check = check_location(path);
  if !check.missing {
    return check;
  }
  match std::fs::create_dir_all(path.trim()) {
    Ok(()) => check_location(path),
    Err(e) => ProjectLocationCheck { message: Some(t!("commands.projects.cantCreateFolder", error = e)), ..check },
  }
}

/// Validate a New Project request (name, template) into a [`ScaffoldRequest`].
pub(crate) fn scaffold_request(input: &CreateProjectInput) -> Result<ScaffoldRequest, String> {
  let name = input.name.trim().to_string();
  if name.is_empty() {
    return Err(t!("commands.projects.enterName"));
  }
  if let Some(problem) = project_name_problem(&name) {
    return Err(problem.into());
  }
  let template = {
    let t = input.template.trim();
    if t.is_empty() { STARTER_TEMPLATE.to_string() } else { t.to_string() }
  };
  let template_name = input
    .template_name
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(String::from);
  let is_url = {
    let t = template.to_lowercase();
    t.starts_with("http://") || t.starts_with("https://") || t.starts_with("git@") || t.starts_with("git+")
  };
  let slug = crate::commands::util::slugify(&name);
  if slug.is_empty() {
    return Err(t!("commands.projects.nameNeedsLettersOrNumbers"));
  }
  let line = match input.rayfin_line.as_deref().map(str::trim).filter(|line| !line.is_empty()) {
    None => None,
    Some(asked) => match rayfin_sdk::new_project_line(asked) {
      Some(line) => Some(line),
      None => {
        let lines = rayfin_sdk::new_project_lines().join(", ");
        return Err(t!("commands.projects.unknownRayfinLine", line = asked, lines = lines));
      }
    },
  };
  Ok(ScaffoldRequest { name, slug, template, template_name, is_url, line })
}

/// The `npm` arguments that scaffold `request` into `<cwd>/<folder>`:
///
/// `npm create @microsoft/rayfin@<release> -- <folder> -t <template>
///   [--template-name <name>] --project-name "<name>" [--skip-install]`
///
/// `<release>` is a version. `<template>` is a template
/// built into the Rayfin CLI (resolved against the CLI's own set) or a community
/// template URL, which may also name one entry of a multi-template gallery. The
/// positional `<folder>` is the target directory; `--project-name` carries the
/// human identity (rayfin.yml id/name + package name). `--skip-install`, a
/// hidden `rayfin init` flag, leaves installing the packages to Fabricator, which
/// pins their Rayfin versions first.
fn create_args(folder: &str, request: &ScaffoldRequest, release: &str, skip_install: bool) -> Vec<String> {
  let mut args: Vec<String> = vec![
    "create".into(),
    format!("@microsoft/rayfin@{release}"),
    "--".into(),
    folder.to_string(),
    "-t".into(),
    request.template.clone(),
  ];
  if request.is_url {
    if let Some(tn) = &request.template_name {
      args.push("--template-name".into());
      args.push(tn.clone());
    }
  }
  args.push("--project-name".into());
  args.push(request.name.clone());
  if skip_install {
    args.push("--skip-install".into());
  }
  args
}

/// Whether the scaffolder refused `--skip-install`, which a Rayfin CLI without
/// the hidden flag reports as an unknown option before creating anything.
fn rejects_skip_install(result: &RunResult) -> bool {
  static REFUSED: Lazy<Regex> = Lazy::new(|| Regex::new(r#"unknown option ['"`]?--skip-install\b"#).unwrap());
  !result.ok && !result.not_found && (REFUSED.is_match(&result.stderr) || REFUSED.is_match(&result.stdout))
}

async fn run_scaffolder(
  root: &Path,
  folder: &str,
  request: &ScaffoldRequest,
  release: &str,
  skip_install: bool,
  on: &OnData,
) -> RunResult {
  let create_args = create_args(folder, request, release, skip_install);
  let arg_refs: Vec<&str> = create_args.iter().map(String::as_str).collect();
  run_npm(
    &arg_refs,
    RunOptions {
      cwd: Some(root.to_path_buf()),
      env: crate::services::npm_env::fresh_registry_env(),
      on_data: Some(on.clone()),
      timeout_ms: Some(600_000),
      ..Default::default()
    },
  )
  .await
}

/// Why the scaffolder didn't create a Rayfin project in `dir`, if it didn't.
fn scaffold_failure(init: &RunResult, dir: &Path, request: &ScaffoldRequest) -> Option<String> {
  if init.not_found {
    return Some(t!("commands.projects.npmMissingCreate"));
  }
  if init.ok && is_rayfin_project(&dir.to_string_lossy()) {
    return None;
  }
  let code = init.exit_code.map(|c| c.to_string()).unwrap_or_else(|| t!("commands.shared.unknown"));
  let failure = if request.is_url {
    t!("commands.projects.createFromUrlFailed", code = code)
  } else {
    t!("commands.projects.createFailed", code = code)
  };
  Some(with_earlier_rayfin_hint(failure, init))
}

/// Whether npm couldn't get a Rayfin package from its registry, which hasn't
/// got it (`E404`), has no release that matches (`ETARGET`) or refuses it
/// (`E403`), as an npm registry without the newest Rayfin packages does.
fn registry_lacks_rayfin(result: &RunResult) -> bool {
  let errors: Vec<String> = [result.stderr.as_str(), result.stdout.as_str()]
    .into_iter()
    .flat_map(str::lines)
    .map(|line| line.trim().to_ascii_lowercase())
    .filter(|line| line.starts_with("npm error") || line.starts_with("npm err!"))
    .collect();
  let missing = errors.iter().any(|line| ["code e404", "code etarget", "code e403"].iter().any(|code| line.ends_with(code)));
  missing && errors.iter().any(|line| line.contains("microsoft") && line.contains("rayfin"))
}

/// `message`, saying how to start on an earlier Rayfin release when npm
/// couldn't get a Rayfin package from its registry.
fn with_earlier_rayfin_hint(message: String, result: &RunResult) -> String {
  if registry_lacks_rayfin(result) { format!("{message} {}", t!("commands.projects.tryEarlierRayfin")) } else { message }
}

/// Run the Rayfin scaffolder into `<root>/<folder>` on the release new projects
/// start on (of the line New project picked, when it picked one), pin the
/// project's Rayfin packages to its line, install them, and add Fabricator's
/// agent instructions. Doesn't touch git. Returns the project dir. Every new
/// project gets this, personal or team.
pub(crate) async fn scaffold_project(
  root: &Path,
  folder: &str,
  request: &ScaffoldRequest,
  on: &OnData,
) -> Result<PathBuf, String> {
  let dir = root.join(folder);
  let sdk = rayfin_sdk::new_project_sdk(root, request.line).await;
  let release = sdk.version.to_string();
  if let Some(asked) = sdk.instead_of {
    let asked = rayfin_sdk::line_name(asked);
    say(on, &format!("{}\n", t!("commands.projects.startsOnOtherLine", asked = asked, release = release)));
  }
  let creating = if request.is_url {
    t!("commands.projects.creatingFromCommunity", folder = folder, release = release)
  } else {
    t!("commands.projects.creatingFrom", folder = folder, template = request.template, release = release)
  };
  say(on, &format!("{creating}\n"));

  let mut skipped_install = true;
  let mut init = run_scaffolder(root, folder, request, &release, true, on).await;
  if rejects_skip_install(&init) {
    say(on, &format!("\n{}\n", t!("commands.projects.noSkipInstall")));
    if dir.exists() {
      let _ = std::fs::remove_dir_all(&dir);
    }
    skipped_install = false;
    init = run_scaffolder(root, folder, request, &release, false, on).await;
  }
  if let Some(error) = scaffold_failure(&init, &dir, request) {
    return Err(error);
  }

  // A community template that asks for Rayfin releases outside the line new
  // projects start on keeps them; the built-in templates always take the pin.
  let pinned = match rayfin_sdk::pin_project(&dir, &sdk, request.is_url) {
    Ok(Pinning::Pinned { range, files }) => {
      if files > 0 {
        say(on, &format!("\n{}\n", t!("commands.projects.pinned", range = range)));
      }
      files > 0
    }
    Ok(Pinning::Kept { name, spec }) => {
      say(
        on,
        &format!(
          "\n{}\n",
          t!(
            "commands.projects.keptVersions",
            name = name,
            spec = spec,
            major = sdk.version.major,
            minor = sdk.version.minor,
            supported = rayfin_sdk::supported_range()
          )
        ),
      );
      false
    }
    Err(e) => {
      say(on, &format!("\n⚠️ {e}\n"));
      false
    }
  };
  // Without --skip-install the scaffolder already installed, before the pin.
  if skipped_install || pinned {
    install_new_project(&dir, &release, !request.is_url, on).await;
  }

  crate::commands::skills::ensure_project_skills(dir.to_string_lossy().as_ref());
  Ok(dir)
}

/// `npm install` in `dir`, streaming its output.
async fn npm_install(dir: &Path, on: Option<OnData>) -> RunResult {
  crate::services::exec::npm_install(
    &["install", "--no-audit", "--no-fund"],
    RunOptions {
      cwd: Some(dir.to_path_buf()),
      env: crate::services::npm_env::fresh_registry_env(),
      on_data: on,
      timeout_ms: Some(600_000),
      ..Default::default()
    },
  )
  .await
}

/// Why an `npm install` in `folder` failed, in npm's own words.
fn install_failure(folder: &str, result: &RunResult) -> String {
  if result.not_found {
    return t!("commands.projects.npmMissingRetry");
  }
  crate::services::exec::npm_install_failure(result, Some(folder))
}

/// Install a new project's packages: the root's, with its workspaces, from
/// what earlier new projects on Rayfin `release` installed when it can (with a
/// spare set aside for the next one when `built_in`, see
/// [`crate::services::new_project_cache`]), then the functions folder's when it
/// has its own. A failure doesn't stop the project being created: the
/// dependency check installs again when it opens.
async fn install_new_project(dir: &Path, release: &str, built_in: bool, on: &OnData) {
  let from_registry = || npm_install(dir, Some(on.clone()));
  let result = crate::services::new_project_cache::install(dir, release, built_in, on, from_registry).await;
  let outcome = if result.ok {
    ensure_functions_dependencies(dir, Some(on.clone())).await
  } else {
    Err(with_earlier_rayfin_hint(install_failure(&t!("commands.projects.theProject"), &result), &result))
  };
  if let Err(e) = outcome {
    say(on, &format!("\n⚠️ {e}\n{}\n", t!("commands.shared.retryOnOpen")));
  }
}

/// One install at a time per functions folder.
static FUNCTIONS_INSTALL_LOCKS: Lazy<tokio::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
  Lazy::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// Install the functions folder's packages when it has its own package.json,
/// outside the root's npm workspaces, and nothing is installed there yet. The
/// root install doesn't cover it, and the local backend builds the functions
/// with them.
pub(crate) async fn ensure_functions_dependencies(project: &Path, on: Option<OnData>) -> Result<(), String> {
  let Some(functions) = rayfin_sdk::separate_functions_dir(project) else {
    return Ok(());
  };
  let node_modules = functions.join("node_modules");
  let cut_off = crate::services::exec::earlier_install_cut_off(&functions, on.as_ref()).await?;
  if node_modules.is_dir() && !cut_off {
    return Ok(());
  }
  let lock = FUNCTIONS_INSTALL_LOCKS.lock().await.entry(functions.clone()).or_default().clone();
  let _guard = lock.lock().await;
  // Another request may have installed them while this one waited.
  let cut_off = crate::services::exec::earlier_install_cut_off(&functions, on.as_ref()).await?;
  if node_modules.is_dir() && !cut_off {
    return Ok(());
  }
  // An install that stopped part way can leave a package with a file cut
  // short, which `npm install` keeps: start again from scratch.
  if cut_off && node_modules.exists() {
    let doomed = node_modules.clone();
    if let Ok(Err(error)) = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(doomed)).await {
      log::warn!("Couldn't remove {}: {error}", node_modules.display());
    }
  }
  let folder = functions.strip_prefix(project).unwrap_or(&functions).to_string_lossy().replace('\\', "/");
  if let Some(on) = &on {
    say(on, &format!("\nInstalling the dependencies in {folder} with npm…\n"));
  }
  let result = npm_install(&functions, on).await;
  if result.ok {
    Ok(())
  } else {
    Err(install_failure(&folder, &result))
  }
}

/// Scaffold a new Rayfin project, start its history, and make it active.
pub async fn create_project(app: &AppHandle, input: CreateProjectInput) -> ProjectActionResult {
  let request = match scaffold_request(&input) {
    Ok(r) => r,
    Err(e) => return err(e),
  };

  // The folder the user chose, which New project has them create when it's
  // missing; or else the projects folder, created here when it's missing.
  let chosen = chosen_location(input.location.as_deref());
  let root = match &chosen {
    Some(folder) => {
      let check = check_location(&folder.to_string_lossy());
      if !check.ok {
        return err(check.message.unwrap_or_else(|| t!("commands.projects.chooseAnotherFolder")));
      }
      folder.clone()
    }
    None => {
      let root = PathBuf::from(store::get_state().workspace_root);
      if !root.exists() {
        if let Err(e) = std::fs::create_dir_all(&root) {
          return err(t!("commands.projects.cantCreateWorkspaceFolder", error = e));
        }
      }
      root
    }
  };
  let dir = root.join(&request.slug);
  if dir.exists() {
    let place = if chosen.is_some() { t!("commands.projects.place.thatFolder") } else { t!("commands.projects.place.workspace") };
    return err(t!("commands.projects.folderExists", slug = request.slug, place = place));
  }

  let on = emit::proc_streamer(app, CREATE_CHANNEL);
  let dir = match scaffold_project(&root, &request.slug, &request, &on).await {
    Ok(dir) => dir,
    Err(e) => return err(e),
  };
  let summary = format!("Initial commit ({})", request.label());
  // In a folder git already tracks, such as a repository's apps folder, the app
  // joins that repository: a second one nested in it would hide the app's
  // files from it. Its first version is saved there, of its own folder only.
  if version_history::is_tracked(&root) {
    say(&on, "Saving the first version in the folder's git repository…\n");
    if let Err(e) = version_history::save_version(&dir, &summary).await {
      say(&on, &format!("⚠️ {e}\n"));
    }
  } else {
    init_git_repo(&dir, &summary, &on).await;
  }
  if let Some(folder) = &chosen {
    store::remember_location(&folder.to_string_lossy());
  }

  // The app runs on this computer from the start. The preview mode is left at
  // its default (direct view); a project that later connects a semantic model
  // is switched to the embedded Fabric view on its next publish.
  let project = register_project(&dir, Some(&request.name));
  store::set_active(Some(project.id.clone()));
  say(&on, &format!("\n✅ {}\n", t!("commands.projects.ready")));
  ProjectActionResult {
    ok: true,
    error: None,
    project: Some(annotate_project(project)),
  }
}

/// Register an existing on-disk Rayfin project and make it active.
pub async fn open_project(path: String) -> ProjectActionResult {
  let abs = normalize(Path::new(&path));
  let abs_str = abs.to_string_lossy().to_string();
  if !abs.exists() {
    return err(t!("commands.projects.folderGone"));
  }
  if !is_rayfin_project(&abs_str) {
    return err(t!("commands.projects.notRayfinProject"));
  }
  crate::commands::skills::ensure_project_skills(&abs_str);
  let known = store::get_state().projects.iter().any(|p| same_path(&p.path, &abs_str));
  let project = register_project(&abs, None);
  // A folder unpacked from an export brings its record the first time it opens.
  if !known {
    crate::commands::export::adopt(&abs, &project.id);
  }
  store::set_active(Some(project.id.clone()));
  ProjectActionResult {
    ok: true,
    error: None,
    project: Some(annotate_project(project)),
  }
}

/// Ensure an opened project's local Rayfin CLI is available before the renderer
/// mounts tools that depend on it (Fabric workspaces, deploy, and model browsing),
/// along with the functions folder's own packages, which the root install doesn't
/// cover.
pub async fn prepare_project_dependencies(id: String) -> ProjectActionResult {
  let Some(project) = store::find_project(&id) else {
    return err(t!("commands.shared.projectNotFound"));
  };
  let dir = Path::new(&project.path);
  if !is_rayfin_project(&project.path) {
    return err(t!("commands.projects.noLongerRayfinProject"));
  }
  if let Err(error) = crate::services::exec::ensure_project_dependencies(dir, None).await {
    return err(error);
  }
  if let Err(error) = ensure_functions_dependencies(dir, None).await {
    return err(error);
  }
  // A folder opened from disk may not have a repository yet. Start the version
  // history that History, Restore and the after-turn redeploy rely on. A failure
  // doesn't block the app; it's noted in the activity journal.
  let _ = crate::services::version_history::ensure_project_tracked(&project).await;
  ProjectActionResult {
    ok: true,
    error: None,
    project: Some(annotate_project(project)),
  }
}

/// Rename a project's display name (and rayfin/rayfin.yml `name`).
pub async fn rename_project(id: String, name: String) -> ProjectActionResult {
  let Some(project) = store::find_project(&id) else {
    return err(t!("commands.shared.projectNotFound"));
  };
  let trimmed = name.trim().to_string();
  if trimmed.is_empty() {
    return err(t!("commands.projects.enterName"));
  }
  write_project_name(&project.path, &trimmed);
  store::mutate_project(&id, |p| p.name = trimmed.clone());
  let updated = store::find_project(&id).unwrap_or(project);
  ProjectActionResult {
    ok: true,
    error: None,
    project: Some(annotate_project(updated)),
  }
}

/// Remove a project. Forgets it by default; trashes the folder when `delete_files`.
/// A folder that can't be trashed (a program has one of its files open) keeps the
/// project and its chat, and the error says why.
pub async fn remove_project(
  app: &AppHandle,
  state: &AppState,
  id: String,
  delete_files: bool,
) -> Result<ProjectsState, String> {
  // What Fabricator runs in the folder stops first, and doesn't outlive a
  // project that's only forgotten either.
  release_project(app, state, &id).await;

  if delete_files {
    if let Some(project) = store::find_project(&id) {
      let path = project.path.clone();
      if Path::new(&path).exists() {
        // The trash move is blocking and can take a while for a project with a
        // large node_modules, so run it off the async runtime and stream a live
        // file count (delete:progress) so the delete never looks hung.
        let app = app.clone();
        let id = id.clone();
        tokio::task::spawn_blocking(move || count_and_trash(&app, &id, Path::new(&path)))
          .await
          .map_err(|error| t!("commands.projects.cantTrash", error = error))??;
      }
    }
  }
  history::clear_history(&id);
  Ok(crate::commands::util::annotate_state(store::remove_project(&id)))
}

/// How long releasing a project waits for its chat turn to stop.
const TURN_STOP_WAIT: Duration = Duration::from_secs(10);

/// Stop what Fabricator runs in a project's folder, which Windows can't move or
/// delete while a process runs in it: its chat turn, its chat's Copilot
/// session, whose MCP servers and shells run in the folder, its terminals, and
/// its local backend, which also holds the app's database and logs there.
pub(crate) async fn release_project(app: &AppHandle, state: &AppState, id: &str) {
  // A turn that's still starting could open the session again after it goes.
  if state.cancel_chat(id) {
    let deadline = Instant::now() + TURN_STOP_WAIT;
    while state.is_chat_running(id) && Instant::now() < deadline {
      tokio::time::sleep(Duration::from_millis(100)).await;
    }
  }
  state.copilot.forget(id).await;
  if let Some(terminals) = app.try_state::<crate::services::terminal::Terminals>() {
    let (terminals, id) = (terminals.inner().clone(), id.to_string());
    let _ = tokio::task::spawn_blocking(move || terminals.kill_all(Some(&id))).await;
  }
  crate::services::local_backend::state(app).forget(id).await;
}

/// The waits between attempts to move a folder to the trash: the processes
/// [`release_project`] stopped take a moment to let go of it.
const TRASH_RETRY_WAITS: [Duration; 4] =
  [Duration::from_millis(250), Duration::from_millis(500), Duration::from_secs(1), Duration::from_secs(2)];

/// Move `root` to the trash, trying again a few times while it's in use.
fn trash_folder(root: &Path) -> Result<(), trash::Error> {
  let mut waits = TRASH_RETRY_WAITS.into_iter();
  loop {
    match trash::delete(root) {
      Ok(()) => return Ok(()),
      Err(_) if !root.exists() => return Ok(()),
      Err(error) => match waits.next() {
        Some(wait) => std::thread::sleep(wait),
        None => return Err(error),
      },
    }
  }
}

/// Why a folder couldn't be moved to trash, in words: the crate's own message is
/// its debug dump.
fn trash_failure(error: &trash::Error) -> String {
  let reason = match error {
    trash::Error::Os { description, .. } | trash::Error::Unknown { description } => {
      description.trim().trim_end_matches('.')
    }
    _ => "",
  };
  let hint = t!("commands.projects.trashHint");
  if reason.is_empty() {
    t!("commands.projects.cantTrashHint", hint = hint)
  } else {
    t!("commands.projects.cantTrashReason", reason = reason, hint = hint)
  }
}

/// Walk `root` streaming a throttled `delete:progress` file count, then move the
/// whole tree to the system trash. The folder is trashed atomically (one
/// `trash::delete`) so the user can still restore it; the up-front scan is purely
/// to report a count (the OS move itself exposes no per-file progress).
fn count_and_trash(app: &AppHandle, id: &str, root: &Path) -> Result<(), String> {
  emit_delete_progress(app, id, "scanning", 0, None);

  let mut files: u64 = 0;
  let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
  let mut last_emit = Instant::now();
  let mut last_count = 0u64;
  while let Some(dir) = stack.pop() {
    let Ok(entries) = std::fs::read_dir(&dir) else {
      continue;
    };
    for entry in entries.flatten() {
      // `file_type()` doesn't follow symlinks, so symlinked directories aren't
      // descended into (avoids cycles) — they count as a single entry.
      if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
        stack.push(entry.path());
      } else {
        files += 1;
        if files - last_count >= 300 || last_emit.elapsed() >= Duration::from_millis(90) {
          last_count = files;
          last_emit = Instant::now();
          emit_delete_progress(app, id, "scanning", files, None);
        }
      }
    }
  }

  emit_delete_progress(app, id, "trashing", files, Some(files));
  trash_folder(root).map_err(|error| trash_failure(&error))
}

/// Emit one `delete:progress` event (file-count progress for a project delete).
fn emit_delete_progress(app: &AppHandle, id: &str, phase: &str, processed: u64, total: Option<u64>) {
  let _ = app.emit(
    emit::DELETE_PROGRESS,
    DeleteProgressEvent {
      id: id.to_string(),
      phase: phase.to_string(),
      processed,
      total,
    },
  );
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parse_github_repo_handles_https_git_and_suffixes() {
    assert_eq!(
      parse_github_repo("https://github.com/microsoft/awesome-rayfin"),
      Some(("microsoft".into(), "awesome-rayfin".into()))
    );
    assert_eq!(
      parse_github_repo("https://github.com/microsoft/awesome-rayfin.git"),
      Some(("microsoft".into(), "awesome-rayfin".into()))
    );
    assert_eq!(
      parse_github_repo("https://github.com/Owner/Repo/"),
      Some(("Owner".into(), "Repo".into()))
    );
    assert_eq!(
      parse_github_repo("git@github.com:microsoft/awesome-rayfin.git"),
      Some(("microsoft".into(), "awesome-rayfin".into()))
    );
    assert_eq!(parse_github_repo("https://example.com/foo/bar"), None);
    assert_eq!(parse_github_repo("not a url"), None);
  }

  #[test]
  fn gallery_yaml_parses_entries_and_metadata() {
    let yaml = r#"
metadata:
  displayName: Awesome Rayfin
  description: A community gallery
entries:
  - path: apps/todo
    name: Todo App
    description: A todo list
  - name: Notes
  - path: apps/skip
    description: missing name is skipped
"#;
    let doc: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
    let entries = doc.get("entries").and_then(|e| e.as_sequence()).unwrap();
    let kept: Vec<CommunityTemplate> = entries
      .iter()
      .filter(|e| !yaml_str(e.get("name")).is_empty())
      .map(|e| CommunityTemplate {
        repo_url: "u".into(),
        path: yaml_str(e.get("path")),
        name: yaml_str(e.get("name")),
        description: yaml_str(e.get("description")),
      })
      .collect();
    assert_eq!(kept.len(), 2);
    assert_eq!(kept[0].name, "Todo App");
    assert_eq!(kept[0].path, "apps/todo");
    assert_eq!(kept[1].name, "Notes");
    assert_eq!(kept[1].path, ""); // absent → coerced to empty
    assert_eq!(yaml_str(doc.get("metadata").and_then(|m| m.get("displayName"))), "Awesome Rayfin");
  }

  #[test]
  fn yaml_str_coerces_non_strings_to_empty() {
    let doc: serde_yaml::Value = serde_yaml::from_str("a: 5\nb: hello\n").unwrap();
    assert_eq!(yaml_str(doc.get("a")), ""); // number → ""
    assert_eq!(yaml_str(doc.get("b")), "hello");
    assert_eq!(yaml_str(None), "");
  }

  #[test]
  fn new_projects_start_from_the_cli_universal_app() {
    let input = |template: &str, template_name: Option<&str>| CreateProjectInput {
      name: "Trip Logger".into(),
      template: template.into(),
      template_name: template_name.map(String::from),
      location: None,
      rayfin_line: None,
    };
    let args = |request: &ScaffoldRequest| create_args(&request.slug, request, "1.36.2", true).join(" ");

    // A blank template means the CLI's built-in Universal App, by name, on the
    // pinned release, leaving the install to Fabricator.
    let blank = scaffold_request(&input("", None)).unwrap();
    assert_eq!(blank.template, STARTER_TEMPLATE);
    assert!(!blank.is_url);
    assert_eq!(
      args(&blank),
      "create @microsoft/rayfin@1.36.2 -- trip-logger -t universal-app --project-name Trip Logger --skip-install"
    );
    assert!(!create_args(&blank.slug, &blank, "1.36.2", false).contains(&"--skip-install".to_string()));

    // A community gallery is passed by URL, with the chosen entry's name.
    let example = scaffold_request(&input("https://github.com/microsoft/awesome-rayfin", Some(" Todo App "))).unwrap();
    assert!(example.is_url);
    assert_eq!(
      args(&example),
      "create @microsoft/rayfin@1.36.2 -- trip-logger -t https://github.com/microsoft/awesome-rayfin \
       --template-name Todo App --project-name Trip Logger --skip-install"
    );

    // Only URL sources take a template name.
    let named = scaffold_request(&input("universal-app", Some("Todo App"))).unwrap();
    assert!(!args(&named).contains("--template-name"));
  }

  #[test]
  fn a_scaffolder_without_skip_install_is_detected() {
    let result = |ok: bool, stderr: &str| RunResult {
      ok,
      exit_code: Some(if ok { 0 } else { 1 }),
      stdout: String::new(),
      stderr: stderr.into(),
      not_found: false,
    };
    // npm echoes the whole command, flag included, whatever went wrong.
    let echo = "npm error command C:\\WINDOWS\\system32\\cmd.exe /d /s /c create-rayfin app -t universal-app --skip-install";
    assert!(rejects_skip_install(&result(false, &format!("error: unknown option '--skip-install'\n{echo}"))));
    assert!(!rejects_skip_install(&result(false, &format!("npm error code ETARGET\n{echo}"))));
    assert!(!rejects_skip_install(&result(false, &format!("error: unknown option '--template-name'\n{echo}"))));
    assert!(!rejects_skip_install(&result(true, "")));
  }

  #[test]
  fn local_names_must_not_reuse_an_existing_folder() {
    let root = std::env::temp_dir().join(format!("fab-name-check-{}", std::process::id()));
    std::fs::create_dir_all(root.join("trip-logger")).unwrap();
    let taken = check_local_name_in(&root, "Trip Logger", "your projects folder");
    assert!(!taken.ok);
    assert!(taken.message.as_deref().unwrap_or_default().contains("“trip-logger” is already in your projects folder"));
    assert_eq!(check_local_name_in(&root, "Trip Planner", "that folder"), ProjectNameCheck { ok: true, message: None });
    assert!(!check_local_name_in(&root, "!!!", "that folder").ok);
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn a_new_projects_folder_is_given_in_full_and_offered_for_creating_when_missing() {
    let base = std::env::temp_dir().join(format!("fab-location-{}", uuid::Uuid::new_v4()));
    let missing = base.join("apps").join("new");
    let check = check_location(&missing.to_string_lossy());
    assert_eq!((check.ok, check.missing), (false, true));
    assert_eq!(create_location(&missing.to_string_lossy()), ProjectLocationCheck { ok: true, ..Default::default() });
    assert!(missing.is_dir());
    std::fs::write(base.join("notes.txt"), "x").unwrap();
    let file = check_location(&base.join("notes.txt").to_string_lossy());
    assert!(!file.ok && !file.missing, "{file:?}");
    assert_eq!(create_location(&base.join("notes.txt").to_string_lossy()), file, "a file isn't replaced");
    assert!(!check_location("relative/apps").ok);
    assert!(check_location("  ").ok, "blank is the projects folder");
    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn names_the_rayfin_cli_would_refuse_are_caught_before_creating() {
    assert_eq!(project_name_problem("Q4 results - v2_final"), None);
    assert_eq!(
      project_name_problem("SalesBenchmark (migrated)").as_deref(),
      Some("Use only letters, numbers, spaces, hyphens and underscores.")
    );
    assert_eq!(project_name_problem("Café").as_deref(), Some("Use only letters, numbers, spaces, hyphens and underscores."));
    assert_eq!(project_name_problem(" - _ ").as_deref(), Some("Include at least one letter or number."));
    let input = CreateProjectInput {
      name: "SalesBenchmark (migrated)".into(),
      template: String::new(),
      template_name: None,
      location: None,
      rayfin_line: None,
    };
    assert_eq!(
      scaffold_request(&input).err().as_deref(),
      Some("Use only letters, numbers, spaces, hyphens and underscores.")
    );
  }

  #[test]
  fn new_projects_start_on_the_rayfin_line_new_project_picked() {
    let input = |line: Option<&str>| CreateProjectInput {
      name: "Trip Logger".into(),
      template: String::new(),
      template_name: None,
      location: None,
      rayfin_line: line.map(String::from),
    };
    assert_eq!(scaffold_request(&input(None)).unwrap().line, None, "the line new projects start on");
    assert_eq!(scaffold_request(&input(Some(" "))).unwrap().line, None);
    for name in rayfin_sdk::new_project_lines() {
      let line = scaffold_request(&input(Some(&name))).unwrap().line;
      assert_eq!(line.map(rayfin_sdk::line_name), Some(name));
    }
    let refused = scaffold_request(&input(Some("0.9"))).err().unwrap_or_default();
    assert!(refused.contains("0.9") && refused.contains(&rayfin_sdk::new_project_lines().join(", ")), "{refused}");
  }

  #[test]
  fn npm_errors_from_a_registry_without_a_rayfin_release_suggest_an_earlier_one() {
    let failed = |stderr: &str| RunResult {
      ok: false,
      exit_code: Some(1),
      stdout: String::new(),
      stderr: stderr.into(),
      not_found: false,
    };
    let lacking = [
      "npm error code ETARGET\nnpm error notarget No matching version found for @microsoft/create-rayfin@2.0.1.",
      "npm error code E404\nnpm error 404 Not Found - GET https://proxy.example/npm/@microsoft%2fcreate-rayfin - Not found",
      "npm ERR! code E403\nnpm ERR! 403 403 Forbidden - GET https://proxy.example/npm/@microsoft/rayfin-core/-/rayfin-core-2.0.0.tgz",
    ];
    for stderr in lacking {
      assert!(registry_lacks_rayfin(&failed(stderr)), "{stderr}");
      let message = with_earlier_rayfin_hint("Project creation failed (exit code 1).".into(), &failed(stderr));
      assert!(message.starts_with("Project creation failed (exit code 1). ") && message.contains("Rayfin version"), "{message}");
    }
    for stderr in [
      "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/left-padd - Not found",
      "npm error code ERESOLVE\nnpm error ERESOLVE could not resolve @microsoft/rayfin-core",
      "npm error code ECONNRESET\nnpm error network aborted",
    ] {
      assert!(!registry_lacks_rayfin(&failed(stderr)), "{stderr}");
      assert_eq!(with_earlier_rayfin_hint("Failed.".into(), &failed(stderr)), "Failed.");
    }
  }
}
