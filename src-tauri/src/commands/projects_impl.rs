//! Project scaffolding/registration (ported from `src/main/services/projects.ts`).
//! Handles listing templates, creating a project via `npm create
//! @microsoft/rayfin` (the official scaffolder, streaming live output on the
//! `create:project` proc channel), opening an existing project, renaming, and
//! removing.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::AppHandle;

use crate::commands::util::{is_rayfin_project, normalize, same_path, with_missing};
use crate::services::exec::{run, OnData, RunOptions, Stream};
use crate::services::{emit, history, store};
use crate::state::AppState;
use crate::types::{
  CommunityGallery, CommunityGalleryResult, CommunityTemplate, CreateProjectInput,
  ProjectActionResult, ProjectsState, StudioProject, TemplateInfo,
};

const CREATE_CHANNEL: &str = "create:project";

/// The default preview mode a project scaffolded from `template` should adopt.
/// The Data App is Fabric-auth-only and renders correctly only inside the Fabric
/// portal shell, so it opens in the embedded Fabric preview by default; every
/// other template uses the direct app view (`None`). Returned as `Some("fabric")`
/// to match `StudioProject::preview_mode`.
pub fn fabricator_default_preview_mode(template: &str) -> Option<String> {
  match template {
    "fabricator-dataapp" => Some("fabric".to_string()),
    _ => None,
  }
}

/// The built-in template set shown in New Project: only the two bundled Fabricator
/// variants (`fabricator-dataapp` / `fabricator-todoapp`, under
/// `resources/fabricator-templates`), which strip the local-testing surface for the
/// deploy-to-test workflow. Their metadata ships with the app, so the list is
/// constant — no registry / `--list-templates` discovery is needed, and New Project
/// opens instantly and offline. The Data App carries `default_preview_mode = "fabric"`
/// so it opens in the embedded Fabric portal preview.
fn bundled_templates() -> Vec<TemplateInfo> {
  vec![
    TemplateInfo {
      name: "fabricator-dataapp".into(),
      display_name: "Data App".into(),
      description:
        "Fabric Analytics app — connect a Power BI semantic model and build dashboards with DAX-powered visuals, then deploy to Fabric to try it."
          .into(),
      default_preview_mode: fabricator_default_preview_mode("fabricator-dataapp"),
    },
    TemplateInfo {
      name: "fabricator-todoapp".into(),
      display_name: "Todo App".into(),
      description:
        "A polished todo app with per-user row-level security on a Rayfin data model, ready to deploy to Fabric."
          .into(),
      default_preview_mode: fabricator_default_preview_mode("fabricator-todoapp"),
    },
  ]
}

/// List the built-in (bundled) templates shown in New Project. The set is constant
/// (the two bundled Fabricator variants), so this is instant and works offline.
pub async fn list_templates() -> Vec<TemplateInfo> {
  bundled_templates()
}

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
    awaiting_first_deploy: None,
    model: None,
    effort: None,
    preview_mode: None,
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

  // Resolve the template source passed to `-t`:
  //   - bundled Fabricator templates -> the local template dir under resources
  //     (an absolute path, which the scaffolder treats as a local template),
  //   - community/URL templates       -> the URL (+ optional --template-name),
  //   - upstream built-in names       -> the bare name (the scaffolder resolves
  //     it against its bundled set).
  let is_fabricator = matches!(template.as_str(), "fabricator-dataapp" | "fabricator-todoapp");
  let template_source = if is_fabricator {
    let tmpl_dir = crate::services::paths::fabricator_templates_dir(app).join(&template);
    if !tmpl_dir.is_dir() {
      return err(format!(
        "The bundled \"{template}\" template is missing from this install."
      ));
    }
    tmpl_dir.to_string_lossy().to_string()
  } else {
    template.clone()
  };

  let label = if is_url { "community template".to_string() } else { format!("{template} template") };
  say(&on, &format!("Creating \"{slug}\" from the {label}…\n"));

  // npm create @microsoft/rayfin@latest -- <slug> -t <source>
  //   [--template-name <name>] --project-name "<name>"
  // The positional <slug> is the target directory; --project-name carries the
  // human identity (rayfin.yml id/name + package name). A bundled single-entry
  // local template needs no --template-name.
  let mut create_args: Vec<String> = vec![
    "create".into(),
    "@microsoft/rayfin@latest".into(),
    "--".into(),
    slug.clone(),
    "-t".into(),
    template_source,
  ];
  if is_url {
    if let Some(tn) = &template_name {
      create_args.push("--template-name".into());
      create_args.push(tn.clone());
    }
  }
  create_args.push("--project-name".into());
  create_args.push(name.clone());

  let arg_refs: Vec<&str> = create_args.iter().map(String::as_str).collect();
  let init = run(
    "npm",
    &arg_refs,
    RunOptions {
      cwd: Some(Path::new(&root).to_path_buf()),
      on_data: Some(on.clone()),
      timeout_ms: Some(600_000),
      ..Default::default()
    },
  )
  .await;

  if init.not_found {
    return err("npm was not found on PATH. Install Node.js (which includes npm) to create projects.");
  }
  if !init.ok || !is_rayfin_project(&dir.to_string_lossy()) {
    let code = init.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into());
    return err(if is_url {
      format!("Creating the project from the template URL failed (exit code {code}). Check the URL is a valid Rayfin template.")
    } else {
      format!("Project creation failed (exit code {code}).")
    });
  }

  crate::commands::skills::ensure_project_skills(dir.to_string_lossy().as_ref());
  init_git_repo(&dir, &format!("Initial commit ({label})"), &on).await;

  let project = register_project(&dir, Some(&name));
  // Mark this project as awaiting its first deployment so the workbench guides the
  // user to deploy before chatting (cleared on the first successful deploy). This
  // is set only on create — projects opened from disk are never gated. Also seed the
  // template's default preview mode (the Data App opens embedded in the Fabric portal
  // shell); the user can still flip the toolbar Fabric toggle afterward.
  let default_preview = fabricator_default_preview_mode(&template);
  store::mutate_project(&project.id, |p| {
    p.awaiting_first_deploy = Some(true);
    p.preview_mode = default_preview.clone();
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
  _app: &AppHandle,
  state: &AppState,
  id: String,
  delete_files: bool,
) -> ProjectsState {
  // Stop any in-flight chat, drop the transcript, and tear down every side
  // thread (worktrees + branches) *before* the project folder goes away — the
  // worktree-removal git commands need the project to still exist on disk.
  state.cancel_chat(&id, Some(history::MAIN_THREAD_ID));
  history::clear_history(&id, None);
  crate::commands::threads::remove_all_threads(&id).await;

  if delete_files {
    if let Some(project) = store::find_project(&id) {
      if Path::new(&project.path).exists() {
        let _ = trash::delete(&project.path);
      }
    }
  }
  crate::commands::util::annotate_state(store::remove_project(&id))
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
  fn bundled_templates_lists_only_the_fabricator_variants() {
    let bundled = bundled_templates();
    let names: Vec<&str> = bundled.iter().map(|t| t.name.as_str()).collect();
    // Only the two bundled Fabricator templates are offered as built-ins; the
    // upstream blankapp / gettingstartedauth entries are dropped.
    assert_eq!(names, vec!["fabricator-dataapp", "fabricator-todoapp"]);
    assert!(bundled
      .iter()
      .all(|t| !t.display_name.is_empty() && !t.description.is_empty()));
  }

  #[test]
  fn data_app_defaults_to_embedded_fabric_preview() {
    let bundled = bundled_templates();
    let data = bundled.iter().find(|t| t.name == "fabricator-dataapp").unwrap();
    let todo = bundled.iter().find(|t| t.name == "fabricator-todoapp").unwrap();
    // The Data App opens embedded in the Fabric portal shell by default…
    assert_eq!(data.default_preview_mode.as_deref(), Some("fabric"));
    // …while the Todo App uses the direct app view.
    assert_eq!(todo.default_preview_mode, None);
  }

  #[test]
  fn fabricator_default_preview_mode_only_fabric_for_data_app() {
    assert_eq!(
      fabricator_default_preview_mode("fabricator-dataapp").as_deref(),
      Some("fabric")
    );
    assert_eq!(fabricator_default_preview_mode("fabricator-todoapp"), None);
    assert_eq!(fabricator_default_preview_mode("blankapp"), None);
    assert_eq!(fabricator_default_preview_mode("anything-else"), None);
  }
}
