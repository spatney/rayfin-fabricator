//! Project scaffolding/registration (ported from `src/main/services/projects.ts`).
//! Handles listing templates, creating a project via `rayfin init` (streaming
//! live output on the `create:project` proc channel), opening an existing
//! project, renaming, and removing.

use std::path::Path;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::AppHandle;

use crate::commands::util::{is_rayfin_project, normalize, same_path, with_missing};
use crate::services::emit;
use crate::services::exec::{run, OnData, RunOptions, Stream};
use crate::services::store;
use crate::types::{
  CommunityGalleryResult, CreateProjectInput, ProjectActionResult, ProjectsState, StudioProject,
  TemplateInfo,
};

const CREATE_CHANNEL: &str = "create:project";

fn fallback_templates() -> Vec<TemplateInfo> {
  vec![
    TemplateInfo {
      name: "blankapp".into(),
      display_name: "Blank App".into(),
      description: "Bare-bones Fabric-authenticated React + Vite app — no data layer.".into(),
    },
    TemplateInfo {
      name: "todoapp".into(),
      display_name: "Basic Todo App".into(),
      description: "End-to-end Fabric-authenticated todo CRUD exercising the full data path.".into(),
    },
    TemplateInfo {
      name: "gettingstartedauth".into(),
      display_name: "Todo App with Auth + Docs".into(),
      description: "Todo app with Fabric auth, Tailwind CSS, and getting-started docs.".into(),
    },
    TemplateInfo {
      name: "dataapp".into(),
      display_name: "Data App".into(),
      description: "Build a data analytics app based on your data in Fabric.".into(),
    },
  ]
}

/// List available templates via the Rayfin CLI (falls back to a static list).
pub async fn list_templates() -> Vec<TemplateInfo> {
  let res = run("rayfin", &["init", "--list-templates"], RunOptions::timeout(60_000)).await;
  if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&res.stdout) {
    if let Some(bundled) = parsed.get("bundled").and_then(|b| b.as_array()) {
      let list: Vec<TemplateInfo> = bundled
        .iter()
        .filter_map(|t| {
          let name = t.get("name")?.as_str()?.to_string();
          let display_name = t
            .get("displayName")
            .and_then(|v| v.as_str())
            .unwrap_or(&name)
            .to_string();
          let description = t
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
          Some(TemplateInfo {
            name,
            display_name,
            description,
          })
        })
        .collect();
      if !list.is_empty() {
        return list;
      }
    }
  }
  fallback_templates()
}

/// Community gallery browsing is not yet ported (needs a YAML reader); the
/// create flow still accepts a template Git URL directly.
pub async fn list_community_templates(_repo_url: Option<String>) -> CommunityGalleryResult {
  CommunityGalleryResult {
    ok: false,
    error: Some(
      "Browsing community galleries isn't available yet in this build — paste a template's GitHub URL into the template field instead."
        .to_string(),
    ),
    gallery: None,
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
fn register_project(dir: &Path, display_name: Option<&str>) -> StudioProject {
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
    model: None,
    effort: None,
    missing: None,
    threads: None,
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
      let _ = std::fs::write(&file, next);
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
  let init = run("git", &["init"], run_in(dir, Some(on.clone()))).await;
  if !init.ok {
    return;
  }
  run("git", &["add", "-A"], run_in(dir, None)).await;

  let email = run("git", &["config", "user.email"], run_in(dir, None)).await;
  if email.stdout.trim().is_empty() {
    run("git", &["config", "user.email", "fabricator@rayfin.local"], run_in(dir, None)).await;
    run("git", &["config", "user.name", "Rayfin Fabricator"], run_in(dir, None)).await;
  }
  run("git", &["commit", "-m", summary], run_in(dir, Some(on.clone()))).await;
}

fn err(message: impl Into<String>) -> ProjectActionResult {
  ProjectActionResult {
    ok: false,
    error: Some(message.into()),
    project: None,
  }
}

/// Scaffold a new Rayfin project, git-init it, and make it active.
pub async fn create_project(app: &AppHandle, input: CreateProjectInput) -> ProjectActionResult {
  let name = input.name.trim().to_string();
  if name.is_empty() {
    return err("Please enter a project name.");
  }
  let template = {
    let t = input.template.trim();
    if t.is_empty() { "blankapp".to_string() } else { t.to_string() }
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
    return err("Project name must contain letters or numbers.");
  }

  let root = store::get_state().workspace_root;
  if !Path::new(&root).exists() {
    if let Err(e) = std::fs::create_dir_all(&root) {
      return err(format!("Could not create workspace folder: {e}"));
    }
  }
  let dir = Path::new(&root).join(&slug);
  if dir.exists() {
    return err(format!("A folder named \"{slug}\" already exists in your workspace."));
  }

  let on = emit::proc_streamer(app, CREATE_CHANNEL);
  let label = if is_url { "community template".to_string() } else { format!("{template} template") };
  say(&on, &format!("Creating \"{slug}\" from the {label}…\n"));

  let mut init_args: Vec<String> = vec!["init".into(), slug.clone(), "-t".into(), template.clone()];
  if is_url {
    if let Some(tn) = &template_name {
      init_args.push("--template-name".into());
      init_args.push(tn.clone());
    }
  }
  init_args.push("-y".into());
  let arg_refs: Vec<&str> = init_args.iter().map(String::as_str).collect();
  let init = run(
    "rayfin",
    &arg_refs,
    RunOptions {
      cwd: Some(Path::new(&root).to_path_buf()),
      on_data: Some(on.clone()),
      timeout_ms: Some(300_000),
      ..Default::default()
    },
  )
  .await;

  if init.not_found {
    return err("The rayfin CLI was not found on PATH.");
  }
  if !init.ok || !is_rayfin_project(&dir.to_string_lossy()) {
    let code = init.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into());
    return err(if is_url {
      format!("rayfin init from the template URL failed (exit code {code}). Check the URL is a valid Rayfin template.")
    } else {
      format!("rayfin init failed (exit code {code}).")
    });
  }

  crate::commands::skills::ensure_project_skills(dir.to_string_lossy().as_ref());
  init_git_repo(&dir, &format!("Initial commit ({label})"), &on).await;

  let project = register_project(&dir, Some(&name));
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
pub async fn remove_project(_app: &AppHandle, id: String, delete_files: bool) -> ProjectsState {
  if delete_files {
    if let Some(project) = store::find_project(&id) {
      if Path::new(&project.path).exists() {
        let _ = trash::delete(&project.path);
      }
    }
  }
  crate::commands::util::annotate_state(store::remove_project(&id))
}
