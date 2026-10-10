//! Apps in a team workspace: opening one (on a working branch), creating a new
//! one, moving a local project in, and removing one from the workspace.

use std::path::Path;

use tauri::{AppHandle, Manager};

use super::{fail, git_identity, viewer, with_project};
use crate::commands::projects_impl;
use crate::commands::util::is_rayfin_project;
use crate::services::exec::Stream;
use crate::services::team::{self, fabric, gh, naming, repo};
use crate::services::{emit, history, store};
use crate::state::AppState;
use crate::types::{CreateProjectInput, StudioProject, TeamActionResult, TeamBinding, TeamPullRequest, TeamWorkspace};

const CREATE_CHANNEL: &str = "create:project";

fn local_project(workspace_id: &str, folder: &str) -> Option<StudioProject> {
  store::get_state()
    .projects
    .into_iter()
    .find(|p| p.team.as_ref().is_some_and(|t| t.workspace_id == workspace_id && t.folder == folder))
}

/// Register a team app's folder as a Fabricator project bound to its branch.
fn register(ws: &TeamWorkspace, folder: &str, branch: &str, pr: Option<&TeamPullRequest>, name: Option<&str>) -> Option<StudioProject> {
  let dir = repo::project_dir(ws, folder);
  crate::commands::skills::ensure_project_skills(dir.to_string_lossy().as_ref());
  let project = projects_impl::register_project(&dir, name);
  let binding = TeamBinding {
    workspace_id: ws.id.clone(),
    folder: folder.to_string(),
    worktree: repo::worktree_dir(ws, folder).to_string_lossy().to_string(),
    branch: Some(branch.to_string()),
    pr_number: pr.map(|p| p.number),
    pr_url: pr.map(|p| p.url.clone()),
    view: Some(if pr.is_some() { "preview".into() } else { "production".into() }),
    ..Default::default()
  };
  store::mutate_project(&project.id, |p| {
    p.team = Some(binding);
    p.awaiting_first_deploy = None;
  });
  store::set_active(Some(project.id.clone()));
  store::find_project(&project.id)
}

/// The user's open pull request (and its branch) for this app, if any.
async fn my_open_session(ws: &TeamWorkspace, login: &str, folder: &str) -> Option<(TeamPullRequest, String)> {
  gh::open_prs(&ws.repo)
    .await
    .ok()?
    .into_iter()
    .find(|(pr, head)| naming::is_session_branch(head, login, folder) && pr.author.eq_ignore_ascii_case(login))
}

/// Open a team app on this computer, resuming your open pull request for it
/// or starting a new working branch from the published version.
#[tauri::command]
pub async fn team_open_project(workspace_id: String, folder: String) -> TeamActionResult {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, open_project(workspace_id, folder)).await
}

async fn open_project(workspace_id: String, folder: String) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(ws) = store::find_team_workspace(&workspace_id) else {
    return fail("That team workspace is no longer on this computer.");
  };
  if naming::project_folder(&folder).as_deref() != Some(folder.as_str()) && !naming::is_app_folder(&folder) {
    return fail("That isn't an app folder in this workspace.");
  }
  if let Some(existing) = local_project(&ws.id, &folder) {
    if Path::new(&existing.path).exists() {
      store::set_active(Some(existing.id.clone()));
      return with_project(store::find_project(&existing.id));
    }
    // The folder was deleted outside Fabricator: forget it and check out again.
    store::remove_project(&existing.id);
  }
  let me = match viewer().await {
    Ok(v) => v,
    Err(e) => return fail(e),
  };
  if let Err(e) = repo::ensure_clone(&ws, None).await {
    return fail(e);
  }
  let wt = repo::worktree_dir(&ws, &folder);
  let existing_branch = if wt.join(".git").exists() { repo::current_branch(&wt).await } else { None };
  let (branch, pr) = match existing_branch {
    // Keep a working copy that's already here: it may hold unsaved edits.
    Some(branch) => {
      let pr = gh::open_pr_for_branch(&ws.repo, &branch).await.ok().flatten();
      (branch, pr)
    }
    None => {
      let open = my_open_session(&ws, &me.login, &folder).await;
      let (branch, resume, pr) = match open {
        Some((pr, head)) if repo::remote_branch_exists(&ws, &head).await => (head, true, Some(pr)),
        _ => (naming::session_branch(&me.login, &folder, &naming::stamp(chrono::Utc::now())), false, None),
      };
      let _ = repo::remove_worktree(&ws, &folder).await;
      if let Err(e) = repo::add_worktree(&ws, &folder, &branch, resume).await {
        return fail(e);
      }
      (branch, pr)
    }
  };
  if !is_rayfin_project(&repo::project_dir(&ws, &folder).to_string_lossy()) {
    let _ = repo::remove_worktree(&ws, &folder).await;
    return fail("That folder isn't a Rayfin app.");
  }
  let project = register(&ws, &folder, &branch, pr.as_ref(), None);
  if let Some(p) = &project {
    team::apply_view(&p.id);
  }
  with_project(project.and_then(|p| store::find_project(&p.id)))
}

/// Make sure a project's `.gitignore` keeps secrets and generated files out of
/// the team repository.
fn ensure_gitignore(dir: &Path) {
  let file = dir.join(".gitignore");
  let current = std::fs::read_to_string(&file).unwrap_or_default();
  let needed = ["node_modules", "dist", "*.local", "rayfin/.env*", "rayfin/.deployments.json", "rayfin/.temp/"];
  let missing: Vec<&str> = needed.iter().copied().filter(|line| !current.lines().any(|l| l.trim() == *line)).collect();
  if missing.is_empty() {
    return;
  }
  let mut next = current;
  if !next.is_empty() && !next.ends_with('\n') {
    next.push('\n');
  }
  next.push_str("\n# Kept out of the team repository by Fabricator\n");
  for line in missing {
    next.push_str(line);
    next.push('\n');
  }
  if let Err(e) = std::fs::write(&file, next) {
    log::warn!("couldn't update {}: {e}", file.display());
  }
}

/// Why a new app named `name` can't join this team workspace, if it can't.
/// Names are compared as Fabric item names (`Lead_Tracker` and `lead-tracker`
/// deploy to the same item) against the team's apps, apps created on this
/// computer that aren't published yet, and the Rayfin apps already in the
/// published-apps Fabric workspace, which the pipeline would deploy over.
/// Reads the local clone; the Fabric lookup is best-effort.
pub(crate) async fn new_app_name_problem(ws: &TeamWorkspace, name: &str) -> Option<String> {
  let Some(folder) = naming::project_folder(name) else {
    return Some("Choose a name with letters or numbers (and not a reserved word).".into());
  };
  let item = naming::production_item(&folder);
  let taken = |existing: &str| Some(format!("{} already has an app named “{existing}”. Choose another name.", ws.name));
  if let Ok(apps) = repo::list_projects(ws).await {
    if let Some((_, existing)) = apps.iter().find(|(f, _)| naming::production_item(f) == item) {
      return taken(existing);
    }
  }
  let unpublished = store::get_state().projects.into_iter().find(|p| {
    p.team.as_ref().is_some_and(|t| t.workspace_id == ws.id && naming::production_item(&t.folder) == item)
  });
  if let Some(p) = unpublished {
    return taken(&p.name);
  }
  let production = ws.manifest.as_ref().map(|m| m.fabric.production.id.clone()).filter(|id| !id.is_empty())?;
  match fabric::app_item_names(&production).await {
    Ok(names) if names.iter().any(|n| n.eq_ignore_ascii_case(&item)) => Some(format!(
      "The team’s Fabric workspace already has an app named “{item}”. Choose another name so publishing doesn’t replace it."
    )),
    Ok(_) => None,
    Err(e) => {
      log::warn!("couldn't list the apps in {}'s Fabric workspace: {}", ws.name, e.message);
      None
    }
  }
}

/// A folder name for a new app that isn't taken in the workspace. Names are
/// also compared as Fabric item names: `Lead_Tracker` and `lead-tracker` would
/// deploy to the same item.
async fn free_folder(ws: &TeamWorkspace, name: &str) -> Result<String, String> {
  let base = naming::project_folder(name).ok_or("Choose a name with letters or numbers (and not a reserved word).")?;
  let mut taken: Vec<String> = repo::list_projects(ws).await?.into_iter().map(|(f, _)| naming::production_item(&f)).collect();
  // Apps created here that aren't published yet.
  taken.extend(
    store::get_state()
      .projects
      .into_iter()
      .filter_map(|p| p.team.filter(|t| t.workspace_id == ws.id).map(|t| naming::production_item(&t.folder))),
  );
  let mut folder = base.clone();
  let mut n = 2;
  while taken.contains(&naming::production_item(&folder)) || repo::worktree_dir(ws, &folder).exists() {
    folder = format!("{base}-{n}");
    n += 1;
  }
  Ok(folder)
}

/// Create a new app in a team workspace on a working branch, save it to GitHub
/// and open its pull request (which deploys your preview).
#[tauri::command]
pub async fn team_create_project(app: AppHandle, workspace_id: String, input: CreateProjectInput) -> TeamActionResult {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, create_project(app, workspace_id, input)).await
}

async fn create_project(app: AppHandle, workspace_id: String, input: CreateProjectInput) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(ws) = store::find_team_workspace(&workspace_id) else {
    return fail("That team workspace is no longer on this computer.");
  };
  let request = match projects_impl::scaffold_request(&input) {
    Ok(r) => r,
    Err(e) => return fail(e),
  };
  let me = match viewer().await {
    Ok(v) => v,
    Err(e) => return fail(e),
  };
  if let Err(e) = repo::ensure_clone(&ws, None).await {
    return fail(e);
  }
  let folder = match free_folder(&ws, &request.name).await {
    Ok(f) => f,
    Err(e) => return fail(e),
  };
  let branch = naming::session_branch(&me.login, &folder, &naming::stamp(chrono::Utc::now()));
  let worktree = match repo::add_worktree(&ws, &folder, &branch, false).await {
    Ok(w) => w,
    Err(e) => return fail(e),
  };
  let on = emit::proc_streamer(&app, CREATE_CHANNEL);
  if let Err(e) = projects_impl::scaffold_project(&worktree, &folder, &request, &on).await {
    let _ = repo::remove_worktree(&ws, &folder).await;
    return fail(e);
  }
  ensure_gitignore(&repo::project_dir(&ws, &folder));
  let Some(project) = register(&ws, &folder, &branch, None, Some(&request.name)) else {
    return fail("Couldn't register the new app.");
  };
  // Also moves the create screen to its last phase (it watches for "git repository").
  on(Stream::Stdout, "\nSaving the app to the team's git repository…\n");
  first_save(&app, &project.id, &format!("Create {}", request.name)).await
}

/// Move a local project into a team workspace. The team copy is a new project
/// (with the same chat history); the original stays where it is.
#[tauri::command]
pub async fn team_move_project(app: AppHandle, workspace_id: String, project_id: String) -> TeamActionResult {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, move_project(app, workspace_id, project_id)).await
}

async fn move_project(app: AppHandle, workspace_id: String, project_id: String) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(ws) = store::find_team_workspace(&workspace_id) else {
    return fail("That team workspace is no longer on this computer.");
  };
  let Some(source) = store::find_project(&project_id) else {
    return fail("Project not found.");
  };
  if source.team.is_some() {
    return fail("That project is already in a team workspace.");
  }
  if let Some(why) = team::rayfin_update_needed(Path::new(&source.path), &source.name) {
    return fail(why);
  }
  let me = match viewer().await {
    Ok(v) => v,
    Err(e) => return fail(e),
  };
  if let Err(e) = repo::ensure_clone(&ws, None).await {
    return fail(e);
  }
  let folder = match free_folder(&ws, &source.name).await {
    Ok(f) => f,
    Err(e) => return fail(e),
  };
  let branch = naming::session_branch(&me.login, &folder, &naming::stamp(chrono::Utc::now()));
  if let Err(e) = repo::add_worktree(&ws, &folder, &branch, false).await {
    return fail(e);
  }
  let dst = repo::project_dir(&ws, &folder);
  let src = std::path::PathBuf::from(&source.path);
  let copied = tokio::task::spawn_blocking({
    let dst = dst.clone();
    move || repo::copy_project(&src, &dst)
  })
  .await
  .map_err(|e| e.to_string())
  .and_then(|r| r);
  if let Err(e) = copied {
    let _ = repo::remove_worktree(&ws, &folder).await;
    return fail(e);
  }
  ensure_gitignore(&dst);
  let Some(project) = register(&ws, &folder, &branch, None, Some(&source.name)) else {
    return fail("Couldn't register the moved app.");
  };
  history::copy_history(&source.id, &project.id);
  store::mutate_project(&project.id, |p| {
    p.model = source.model.clone();
    p.effort = source.effort.clone();
    p.preview_mode = source.preview_mode.clone();
  });
  first_save(&app, &project.id, &format!("Move {} into the team workspace", source.name)).await
}

/// Commit, push and open the pull request for a new team app.
async fn first_save(app: &AppHandle, project_id: &str, message: &str) -> TeamActionResult {
  let state = app.state::<AppState>();
  let result = match state.mutations.team(project_id) {
    Ok(_lease) => super::session::save_and_share(project_id, message).await,
    Err(e) => Err(e),
  };
  match result {
    Ok(project) => with_project(Some(project)),
    Err(e) => {
      // The app exists locally even if GitHub didn't take it yet; the next
      // successful save shares it.
      let mut res = with_project(store::find_project(project_id));
      res.error = Some(format!("The app was created, but it isn't on GitHub yet: {e}"));
      res
    }
  }
}

/// Remove an app from the workspace (owners): deletes its folder through a
/// merged pull request and, optionally, its published and preview apps in Fabric.
#[tauri::command]
pub async fn team_remove_project(workspace_id: String, folder: String, delete_apps: bool) -> TeamActionResult {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, remove_project(workspace_id, folder, delete_apps)).await
}

async fn remove_project(workspace_id: String, folder: String, delete_apps: bool) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(ws) = store::find_team_workspace(&workspace_id) else {
    return fail("That team workspace is no longer on this computer.");
  };
  match gh::repo(&ws.repo).await {
    Ok(info) if info.manages() => {}
    Ok(_) => return fail("Only the workspace's owners can remove apps."),
    Err(e) => return fail(e.describe("Check your access to the workspace")),
  }
  let me = match viewer().await {
    Ok(v) => v,
    Err(e) => return fail(e),
  };
  let (name, email) = git_identity(&me);
  if let Err(e) = repo::ensure_clone(&ws, None).await {
    return fail(e);
  }
  let production = gh::latest_deployment(&ws.repo, &naming::production_environment(&folder)).await.ok().flatten();
  let branch = format!("{}remove-{folder}-{}", naming::BRANCH_ROOT, naming::stamp(chrono::Utc::now()));
  if let Err(e) = repo::removal_branch(&ws, &folder, &branch, &name, &email).await {
    return fail(e);
  }
  let pr = match gh::create_pr(&ws.repo, &branch, &format!("Remove {folder}"), "Removed in Fabricator.").await {
    Ok(pr) => pr,
    Err(e) => return fail(e.describe("Open the removal pull request")),
  };
  if pr.draft {
    let _ = gh::mark_ready(&ws.repo, pr.number).await;
  }
  if let Err(e) = gh::merge_pr(&ws.repo, pr.number, &format!("Remove {folder}")).await {
    return fail(e.describe("Merge the removal"));
  }
  let _ = gh::delete_branch(&ws.repo, &branch).await;
  if let Some(local) = local_project(&ws.id, &folder) {
    history::clear_history(&local.id);
    store::remove_project(&local.id);
  }
  let _ = repo::remove_worktree(&ws, &folder).await;
  let mut problems = Vec::new();
  if delete_apps {
    if let Some(manifest) = &ws.manifest {
      // The pipeline names the published item after the folder, so it can be
      // found even without a deployment record.
      let production_item = match production.as_ref().and_then(|r| r.item_id.clone()) {
        Some(id) => Some(id),
        None => fabric::items(&manifest.fabric.production.id).await.ok().and_then(|items| {
          let wanted = naming::production_item(&folder);
          items.into_iter().find(|(_, name)| *name == wanted).map(|(id, _)| id)
        }),
      };
      if let Some(item) = production_item {
        if let Err(e) = fabric::delete_item(&manifest.fabric.production.id, &item).await {
          problems.push(e.describe("Delete the published app"));
        }
      }
      let prefix = naming::preview_item_prefix(&folder);
      match fabric::items(&manifest.fabric.previews.id).await {
        Ok(items) => {
          for (id, display) in items.into_iter().filter(|(_, d)| d.starts_with(&prefix)) {
            if let Err(e) = fabric::delete_item(&manifest.fabric.previews.id, &id).await {
              problems.push(e.describe(&format!("Delete the preview {display}")));
            }
          }
        }
        Err(e) => problems.push(e.describe("List the previews")),
      }
    }
  }
  TeamActionResult { ok: true, error: (!problems.is_empty()).then(|| problems.join(" ")), ..Default::default() }
}
