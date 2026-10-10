//! Project scaffolding/registration (ported from `src/main/services/projects.ts`).
//! Handles listing templates, creating a project via `npm create
//! @microsoft/rayfin` (the official scaffolder, streaming live output on the
//! `create:project` proc channel), opening an existing project, renaming, and
//! removing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::{AppHandle, Emitter};

use crate::commands::util::{is_rayfin_project, normalize, same_path, with_missing};
use crate::services::exec::{run, OnData, RunOptions, Stream};
use crate::services::{emit, git, history, store};
use crate::state::AppState;
use crate::types::{
  CommunityGallery, CommunityGalleryResult, CommunityTemplate, CreateProjectInput,
  DeleteProgressEvent, ProjectActionResult, ProjectNameCheck, ProjectsState, StudioProject,
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
      error: Some("Enter a GitHub repo URL, e.g. https://github.com/microsoft/awesome-rayfin".into()),
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
      error: Some(format!(
        "Couldn't reach {owner}/{repo}. Check you're online and the repo has a rayfin-template.yml at its root."
      )),
      gallery: None,
    };
  };

  let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(&raw) else {
    return CommunityGalleryResult {
      ok: false,
      error: Some("This gallery\u{2019}s rayfin-template.yml could not be parsed.".into()),
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
      error: Some("No templates were found in this gallery.".into()),
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
    awaiting_first_deploy: None,
    model: None,
    effort: None,
    preview_mode: None,
    fabric_preview_defaulted: None,
    team: None,
    missing: None,
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
}

impl ScaffoldRequest {
  pub fn label(&self) -> String {
    if self.is_url { "community template".to_string() } else { format!("{} template", self.template) }
  }
}

/// Whether a new local project named `name` can be created under `root`: its
/// folder (the same slug [`create_project`] uses) must not exist yet.
pub(crate) fn check_local_name_in(root: &Path, name: &str) -> ProjectNameCheck {
  let slug = crate::commands::util::slugify(name);
  if slug.is_empty() {
    return ProjectNameCheck { ok: false, message: Some("Use letters or numbers in the name.".into()) };
  }
  if root.join(&slug).exists() {
    return ProjectNameCheck {
      ok: false,
      message: Some(format!("A folder named “{slug}” is already in your projects folder. Choose another name.")),
    };
  }
  ProjectNameCheck { ok: true, message: None }
}

/// [`check_local_name_in`] for the workspace root new projects are saved in.
pub fn check_local_name(name: &str) -> ProjectNameCheck {
  let root = store::get_state().workspace_root;
  check_local_name_in(Path::new(&root), name)
}

/// Validate a New Project request (name, template) into a [`ScaffoldRequest`].
pub(crate) fn scaffold_request(input: &CreateProjectInput) -> Result<ScaffoldRequest, String> {
  let name = input.name.trim().to_string();
  if name.is_empty() {
    return Err("Please enter a project name.".into());
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
    return Err("Project name must contain letters or numbers.".into());
  }
  Ok(ScaffoldRequest { name, slug, template, template_name, is_url })
}

/// The `npm` arguments that scaffold `request` into `<cwd>/<folder>`:
///
/// `npm create @microsoft/rayfin@latest -- <folder> -t <template>
///   [--template-name <name>] --project-name "<name>"`
///
/// `<template>` is a template built into the Rayfin CLI (resolved against the
/// CLI's own set) or a community template URL, which may also name one entry of
/// a multi-template gallery. The positional `<folder>` is the target directory;
/// `--project-name` carries the human identity (rayfin.yml id/name + package
/// name).
fn create_args(folder: &str, request: &ScaffoldRequest) -> Vec<String> {
  let mut args: Vec<String> = vec![
    "create".into(),
    "@microsoft/rayfin@latest".into(),
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
  args
}

/// Run the Rayfin scaffolder into `<root>/<folder>` and add Fabricator's agent
/// instructions. Doesn't touch git. Returns the project dir.
pub(crate) async fn scaffold_project(
  root: &Path,
  folder: &str,
  request: &ScaffoldRequest,
  on: &OnData,
) -> Result<PathBuf, String> {
  let dir = root.join(folder);
  say(on, &format!("Creating \"{folder}\" from the {}…\n", request.label()));

  let create_args = create_args(folder, request);
  let arg_refs: Vec<&str> = create_args.iter().map(String::as_str).collect();
  let init = run(
    "npm",
    &arg_refs,
    RunOptions {
      cwd: Some(root.to_path_buf()),
      env: crate::services::npm_env::fresh_registry_env(),
      on_data: Some(on.clone()),
      timeout_ms: Some(600_000),
      ..Default::default()
    },
  )
  .await;

  if init.not_found {
    return Err("npm was not found on PATH. Install Node.js (which includes npm) to create projects.".into());
  }
  if !init.ok || !is_rayfin_project(&dir.to_string_lossy()) {
    let code = init.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into());
    return Err(if request.is_url {
      format!("Creating the project from the template URL failed (exit code {code}). Check the URL is a valid Rayfin template.")
    } else {
      format!("Project creation failed (exit code {code}).")
    });
  }

  crate::commands::skills::ensure_project_skills(dir.to_string_lossy().as_ref());
  Ok(dir)
}

/// Scaffold a new Rayfin project, git-init it, and make it active.
pub async fn create_project(app: &AppHandle, input: CreateProjectInput) -> ProjectActionResult {
  let request = match scaffold_request(&input) {
    Ok(r) => r,
    Err(e) => return err(e),
  };

  let root = store::get_state().workspace_root;
  if !Path::new(&root).exists() {
    if let Err(e) = std::fs::create_dir_all(&root) {
      return err(format!("Could not create workspace folder: {e}"));
    }
  }
  let dir = Path::new(&root).join(&request.slug);
  if dir.exists() {
    return err(format!("A folder named \"{}\" already exists in your workspace.", request.slug));
  }

  let on = emit::proc_streamer(app, CREATE_CHANNEL);
  let dir = match scaffold_project(Path::new(&root), &request.slug, &request, &on).await {
    Ok(dir) => dir,
    Err(e) => return err(e),
  };
  init_git_repo(&dir, &format!("Initial commit ({})", request.label()), &on).await;

  let project = register_project(&dir, Some(&request.name));
  // Mark this project as awaiting its first deployment so the workbench guides the
  // user to deploy before chatting (cleared on the first successful deploy). This
  // is set only on create — projects opened from disk are never gated. The preview
  // mode is left at its default (direct view); a project that later connects a
  // semantic model is switched to the embedded Fabric view on its next deploy.
  store::mutate_project(&project.id, |p| {
    p.awaiting_first_deploy = Some(true);
  });
  let project = store::find_project(&project.id).unwrap_or(project);
  store::set_active(Some(project.id.clone()));
  say(&on, "\n✅ Project ready.\n");
  ProjectActionResult {
    ok: true,
    error: None,
    project: Some(with_missing(project)),
  }
}

/// Register an existing on-disk Rayfin project and make it active.
pub async fn open_project(path: String) -> ProjectActionResult {
  let abs = normalize(Path::new(&path));
  let abs_str = abs.to_string_lossy().to_string();
  if !abs.exists() {
    return err("That folder no longer exists.");
  }
  if !is_rayfin_project(&abs_str) {
    return err("That folder is not a Rayfin project (no rayfin/rayfin.yml).");
  }
  crate::commands::skills::ensure_project_skills(&abs_str);
  let project = register_project(&abs, None);
  store::set_active(Some(project.id.clone()));
  ProjectActionResult {
    ok: true,
    error: None,
    project: Some(with_missing(project)),
  }
}

/// Ensure an opened project's local Rayfin CLI is available before the renderer
/// mounts tools that depend on it (Fabric workspaces, deploy, and model browsing).
pub async fn prepare_project_dependencies(id: String) -> ProjectActionResult {
  let Some(project) = store::find_project(&id) else {
    return err("Project not found.");
  };
  let dir = Path::new(&project.path);
  if !is_rayfin_project(&project.path) {
    return err("That folder is no longer a Rayfin project (no rayfin/rayfin.yml).");
  }
  if let Err(error) = crate::services::exec::ensure_project_dependencies(dir, None).await {
    return err(error);
  }
  // A folder opened from disk may not have a repository yet. Start the version
  // history that History, Restore and the after-turn redeploy rely on. A failure
  // doesn't block the app; it's noted in the activity journal.
  let _ = crate::services::version_history::ensure_project_tracked(&project).await;
  ProjectActionResult {
    ok: true,
    error: None,
    project: Some(with_missing(project)),
  }
}

/// Rename a project's display name (and rayfin/rayfin.yml `name`).
pub async fn rename_project(id: String, name: String) -> ProjectActionResult {
  let Some(project) = store::find_project(&id) else {
    return err("Project not found.");
  };
  let trimmed = name.trim().to_string();
  if trimmed.is_empty() {
    return err("Please enter a project name.");
  }
  write_project_name(&project.path, &trimmed);
  store::mutate_project(&id, |p| p.name = trimmed.clone());
  let updated = store::find_project(&id).unwrap_or(project);
  ProjectActionResult {
    ok: true,
    error: None,
    project: Some(with_missing(updated)),
  }
}

/// Remove a project. Forgets it by default; trashes the folder when `delete_files`.
pub async fn remove_project(
  app: &AppHandle,
  state: &AppState,
  id: String,
  delete_files: bool,
) -> ProjectsState {
  // Stop any in-flight chat and drop the transcript *before* the project folder
  // goes away.
  state.cancel_chat(&id);
  history::clear_history(&id);

  if delete_files {
    if let Some(project) = store::find_project(&id) {
      let path = project.path.clone();
      if Path::new(&path).exists() {
        // The trash move is blocking and can take a while for a project with a
        // large node_modules, so run it off the async runtime and stream a live
        // file count (delete:progress) so the delete never looks hung.
        let app = app.clone();
        let id = id.clone();
        let _ =
          tokio::task::spawn_blocking(move || count_and_trash(&app, &id, Path::new(&path))).await;
      }
    }
  }
  crate::commands::util::annotate_state(store::remove_project(&id))
}

/// Walk `root` streaming a throttled `delete:progress` file count, then move the
/// whole tree to the system trash. The folder is trashed atomically (one
/// `trash::delete`) so the user can still restore it; the up-front scan is purely
/// to report a count (the OS move itself exposes no per-file progress).
fn count_and_trash(app: &AppHandle, id: &str, root: &Path) {
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
  let _ = trash::delete(root);
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
    };
    let args = |request: &ScaffoldRequest| create_args(&request.slug, request).join(" ");

    // A blank template means the CLI's built-in Universal App, by name.
    let blank = scaffold_request(&input("", None)).unwrap();
    assert_eq!(blank.template, STARTER_TEMPLATE);
    assert!(!blank.is_url);
    assert_eq!(
      args(&blank),
      "create @microsoft/rayfin@latest -- trip-logger -t universal-app --project-name Trip Logger"
    );

    // A community gallery is passed by URL, with the chosen entry's name.
    let example = scaffold_request(&input("https://github.com/microsoft/awesome-rayfin", Some(" Todo App "))).unwrap();
    assert!(example.is_url);
    assert_eq!(
      args(&example),
      "create @microsoft/rayfin@latest -- trip-logger -t https://github.com/microsoft/awesome-rayfin \
       --template-name Todo App --project-name Trip Logger"
    );

    // Only URL sources take a template name.
    let named = scaffold_request(&input("universal-app", Some("Todo App"))).unwrap();
    assert!(!args(&named).contains("--template-name"));
  }

  #[test]
  fn local_names_must_not_reuse_an_existing_folder() {
    let root = std::env::temp_dir().join(format!("fab-name-check-{}", std::process::id()));
    std::fs::create_dir_all(root.join("trip-logger")).unwrap();
    let taken = check_local_name_in(&root, "Trip Logger");
    assert!(!taken.ok);
    assert!(taken.message.as_deref().unwrap_or_default().contains("“trip-logger”"));
    assert_eq!(check_local_name_in(&root, "Trip Planner"), ProjectNameCheck { ok: true, message: None });
    assert!(!check_local_name_in(&root, "!!!").ok);
    let _ = std::fs::remove_dir_all(&root);
  }
}
