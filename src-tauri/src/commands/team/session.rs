//! The working loop of a team app: saving each turn to the working branch,
//! following its preview, bringing in teammates' changes, discarding, and the
//! working-state status shown in the app bar.

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{fail, git_identity, viewer, with_project};
use crate::services::store;
use crate::services::team::{self, gh, naming, repo};
use crate::state::AppState;
use crate::types::{StudioProject, TeamActionResult, TeamDeployRecord, TeamRunStatus, TeamRunStep, TeamSessionStatus};

/// First line of a chat message as a commit message.
pub(crate) fn summary(message: &str, fallback: &str) -> String {
  let line = message.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
  let line = line.trim_start_matches(|c: char| c == '#' || c == '-' || c == '*' || c.is_whitespace());
  let clipped: String = line.chars().take(72).collect();
  if clipped.is_empty() {
    fallback.to_string()
  } else if line.chars().count() > 72 {
    format!("{}…", clipped.trim_end())
  } else {
    clipped
  }
}

fn pr_body(project_name: &str) -> String {
  format!(
    "Changes to **{project_name}**, made in Fabricator, which runs the app on its author's computer while they work.\n\nWhile this pull request is a draft, nothing deploys. Publishing in Fabricator marks it ready for review, which deploys a personal preview of the app (and each push after that deploys it again), then merges it; the team pipeline then deploys the published app."
  )
}

/// Commit the app's changes, push the working branch, and open its pull
/// request once it differs from the published version. The caller holds the
/// project's team lease.
pub(crate) async fn save_and_share(project_id: &str, message: &str) -> Result<StudioProject, String> {
  let tp = team::team_project(project_id)?;
  let wt = PathBuf::from(&tp.binding.worktree);
  let folder = tp.binding.folder.clone();
  let full = tp.workspace.repo.clone();
  let me = viewer().await?;
  let (name, email) = git_identity(&me);
  repo::set_identity(&tp.workspace, &name, &email).await?;
  let branch = repo::current_branch(&wt)
    .await
    .ok_or("This app's working branch is missing. Reopen the app from Home.")?;

  // A merge with teammates' changes is concluded only once nothing is left unresolved.
  if repo::in_merge(&wt).await {
    let unmerged = repo::conflicted_files(&wt).await;
    let marked = repo::files_with_markers(&wt, &unmerged);
    if !marked.is_empty() {
      return Err(format!(
        "Some conflicts with your teammates' changes are still unresolved: {}. Ask Copilot to finish resolving them.",
        marked.join(", ")
      ));
    }
  }
  let message = summary(message, &format!("Update {}", tp.project.name));
  let committed = repo::commit_folder(&wt, &folder, &message).await?;
  if committed || repo::unpushed(&wt, &branch).await > 0 {
    repo::push(&wt, &branch).await?;
  }

  let (unpublished, _) = repo::divergence(&wt, &folder).await;
  let mut pr_number = tp.binding.pr_number;
  let mut pr_url = tp.binding.pr_url.clone();
  if let Some(n) = pr_number {
    if let Ok(pr) = gh::get_pr(&full, n).await {
      if pr.state != "open" {
        pr_number = None;
        pr_url = None;
      }
    }
  }
  if pr_number.is_none() && unpublished > 0 {
    let pr = match gh::open_pr_for_branch(&full, &branch).await.ok().flatten() {
      Some(pr) => pr,
      None => {
        let title = format!("{}: {message}", tp.project.name);
        gh::create_pr(&full, &branch, &title, &pr_body(&tp.project.name))
          .await
          .map_err(|e| e.describe("Open the pull request"))?
      }
    };
    pr_number = Some(pr.number);
    pr_url = Some(pr.url);
  }
  team::save_binding(project_id, |b| {
    b.branch = Some(branch.clone());
    b.pr_number = pr_number;
    b.pr_url = pr_url.clone();
  });
  team::apply_view(project_id).ok_or_else(|| "Project not found.".to_string())
}

/// After a chat turn: save the app's changes to its working branch on GitHub
/// (its draft pull request, which deploys nothing until you publish).
#[tauri::command]
pub async fn team_sync(app: AppHandle, project_id: String, message: String) -> TeamActionResult {
  let account = super::project_account(&project_id);
  let task = tokio::spawn(gh::as_account(account, async move {
    let state = app.state::<AppState>();
    let _lease = match state.mutations.team(&project_id) {
      Ok(lease) => lease,
      Err(e) => return fail(e),
    };
    match save_and_share(&project_id, &message).await {
      Ok(project) => with_project(Some(project)),
      Err(e) => {
        let mut result = fail(e);
        result.project = store::find_project(&project_id);
        result
      }
    }
  }));
  task.await.unwrap_or_else(|e| fail(format!("Saving to GitHub failed: {e}")))
}

/// Latest deployment records, keeping the previous value when GitHub can't be reached.
async fn refresh_records(
  full: &str,
  folder: &str,
  login: Option<&str>,
  previous: (Option<TeamDeployRecord>, Option<TeamDeployRecord>),
) -> (Option<TeamDeployRecord>, Option<TeamDeployRecord>) {
  let (old_preview, old_production) = previous;
  let production = gh::latest_deployment(full, &naming::production_environment(folder)).await.unwrap_or(old_production);
  let preview = match login {
    Some(l) => gh::latest_deployment(full, &naming::preview_environment(folder, l)).await.unwrap_or(old_preview),
    None => old_preview,
  };
  (preview, production)
}

/// The pipeline run for `sha` (from `event`), with the steps of this app's job.
/// A draft pull request's run deploys nothing, so it isn't one.
pub(crate) async fn run_status(full: &str, sha: &str, event: &str, kind: &str, folder: &str) -> Option<TeamRunStatus> {
  let run = gh::runs_for_sha(full, sha).await.ok()?.into_iter().find(|r| r.event == event && !r.is_draft())?;
  Some(run_status_for(full, run, kind, folder).await)
}

/// A run with the steps of this app's job.
pub(crate) async fn run_status_for(full: &str, run: gh::Run, kind: &str, folder: &str) -> TeamRunStatus {
  let jobs = gh::run_jobs(full, run.id).await.unwrap_or_default();
  let name_of = |j: &Value| j.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
  let job = jobs.iter().find(|j| name_of(j).ends_with(folder)).or_else(|| jobs.last());
  let steps = job
    .and_then(|j| j.get("steps"))
    .and_then(Value::as_array)
    .map(|steps| {
      steps
        .iter()
        .filter_map(|s| {
          Some(TeamRunStep {
            name: s.get("name")?.as_str()?.to_string(),
            status: s.get("status").and_then(Value::as_str).unwrap_or_default().to_string(),
            conclusion: s.get("conclusion").and_then(Value::as_str).map(String::from),
            started_at: s.get("started_at").and_then(Value::as_str).map(String::from),
            completed_at: s.get("completed_at").and_then(Value::as_str).map(String::from),
          })
        })
        .filter(gh::shows_step)
        .collect()
    })
    .unwrap_or_default();
  TeamRunStatus {
    id: run.id,
    kind: kind.to_string(),
    status: run.status,
    conclusion: run.conclusion,
    url: run.url,
    sha: run.head_sha,
    steps,
    started_at: run.created_at,
  }
}

/// The app's working state. `refresh` also fetches and asks GitHub for the pull
/// request, deployment records and the current pipeline run.
#[tauri::command]
pub async fn team_status(project_id: String, refresh: bool) -> TeamSessionStatus {
  let account = super::project_account(&project_id);
  gh::as_account(account, session_status(project_id, refresh)).await
}

async fn session_status(project_id: String, refresh: bool) -> TeamSessionStatus {
  let tp = match team::team_project(&project_id) {
    Ok(tp) => tp,
    Err(e) => return TeamSessionStatus { ok: false, error: Some(e), ..Default::default() },
  };
  let wt = PathBuf::from(&tp.binding.worktree);
  let folder = tp.binding.folder.clone();
  let full = tp.workspace.repo.clone();
  let mut status = TeamSessionStatus {
    ok: true,
    require_review: tp.workspace.manifest.as_ref().is_some_and(|m| m.settings.require_review),
    publish: tp.binding.publish.clone(),
    preview: tp.binding.preview.clone(),
    production: tp.binding.production.clone(),
    ..Default::default()
  };
  if refresh {
    if let Err(e) = repo::fetch(&tp.workspace).await {
      status.error = Some(e);
    }
  }
  status.branch = repo::current_branch(&wt).await;
  status.dirty = repo::is_dirty(&wt, &folder).await;
  status.conflicted = repo::in_merge(&wt).await;
  let (unpublished, behind) = repo::divergence(&wt, &folder).await;
  status.unpublished = unpublished;
  status.behind = behind;
  if !refresh {
    return status;
  }

  let me = viewer().await.ok();
  status.viewer = me.as_ref().map(|v| v.login.clone());
  if let Some(n) = tp.binding.pr_number {
    if let Ok(mut pr) = gh::get_pr(&full, n).await {
      if status.require_review {
        pr.approvals = gh::approvals(&full, n, &pr.author).await.unwrap_or(0);
      }
      status.pr = Some(pr);
    }
  }
  let (preview, production) = refresh_records(
    &full,
    &folder,
    status.viewer.as_deref(),
    (tp.binding.preview.clone(), tp.binding.production.clone()),
  )
  .await;
  // Settle a publish whose production deploy finished while nobody was waiting.
  let mut publish = tp.binding.publish.clone();
  if let Some(p) = publish.as_ref().filter(|p| p.stage == "deploying") {
    if let Some(done) = super::publish::settle_deploying(&full, p, production.as_ref()).await {
      publish = Some(done);
    }
  }
  status.run = match publish.as_ref().filter(|p| p.stage == "deploying") {
    Some(p) => match (p.run_id, &p.merge_sha) {
      (Some(id), _) => match gh::run(&full, id).await {
        Ok(run) => Some(run_status_for(&full, run, "production", &folder).await),
        Err(_) => None,
      },
      (None, Some(sha)) => run_status(&full, sha, "push", "production", &folder).await,
      (None, None) => None,
    },
    None => match status.pr.as_ref().filter(|p| p.state == "open").and_then(|p| p.head_sha.clone()) {
      Some(sha) => run_status(&full, &sha, "pull_request", "preview", &folder).await,
      None => None,
    },
  };
  let pr_closed = status.pr.as_ref().is_some_and(|p| p.state != "open");
  team::save_binding(&project_id, |b| {
    b.preview = preview.clone();
    b.production = production.clone();
    b.publish = publish.clone();
    if pr_closed {
      b.pr_number = None;
      b.pr_url = None;
    }
  });
  team::apply_view(&project_id);
  status.preview = preview;
  status.production = production;
  status.publish = publish;
  status
}

/// Bring the team's published changes into your working branch. With
/// `keep_conflicts`, a conflicted merge is left in place for Copilot to resolve.
#[tauri::command]
pub async fn team_update(app: AppHandle, project_id: String, keep_conflicts: bool) -> TeamActionResult {
  let account = super::project_account(&project_id);
  let task = tokio::spawn(gh::as_account(account, async move {
    let state = app.state::<AppState>();
    let _lease = match state.mutations.team(&project_id) {
      Ok(lease) => lease,
      Err(e) => return fail(e),
    };
    let tp = match team::team_project(&project_id) {
      Ok(tp) => tp,
      Err(e) => return fail(e),
    };
    let wt = PathBuf::from(&tp.binding.worktree);
    let me = match viewer().await {
      Ok(v) => v,
      Err(e) => return fail(e),
    };
    let (name, email) = git_identity(&me);
    if let Err(e) = repo::fetch(&tp.workspace).await {
      return fail(e);
    }
    let before = repo::head(&wt).await;
    match repo::merge_main(&wt, keep_conflicts, &name, &email).await {
      Ok(repo::MergeOutcome::UpToDate) => with_project(store::find_project(&project_id)),
      Ok(repo::MergeOutcome::Merged) => {
        let (unpublished, _) = repo::divergence(&wt, &tp.binding.folder).await;
        if unpublished > 0 {
          if let Some(branch) = repo::current_branch(&wt).await {
            if let Err(e) = repo::push(&wt, &branch).await {
              return fail(e);
            }
          }
        }
        let mut result = with_project(store::find_project(&project_id));
        result.packages_changed =
          super::packages_changed(&tp.project.path, before.as_deref(), repo::head(&wt).await.as_deref()).await;
        result
      }
      Ok(repo::MergeOutcome::Conflicts(files)) => TeamActionResult {
        ok: false,
        error: Some("Your teammates changed some of the same files as you.".into()),
        conflicts: Some(files),
        project: store::find_project(&project_id),
        ..Default::default()
      },
      Err(e) => fail(e),
    }
  }));
  task.await.unwrap_or_else(|e| fail(format!("Updating failed: {e}")))
}

/// Throw away your unpublished changes: close the pull request, delete the
/// working branch and start fresh from the published version.
#[tauri::command]
pub async fn team_discard(app: AppHandle, project_id: String) -> TeamActionResult {
  let account = super::project_account(&project_id);
  let task = tokio::spawn(gh::as_account(account, async move {
    let state = app.state::<AppState>();
    let _lease = match state.mutations.team(&project_id) {
      Ok(lease) => lease,
      Err(e) => return fail(e),
    };
    let tp = match team::team_project(&project_id) {
      Ok(tp) => tp,
      Err(e) => return fail(e),
    };
    let wt = PathBuf::from(&tp.binding.worktree);
    let me = match viewer().await {
      Ok(v) => v,
      Err(e) => return fail(e),
    };
    let full = tp.workspace.repo.clone();
    let old = repo::current_branch(&wt).await;
    let before = repo::head(&wt).await;
    if let Some(n) = tp.binding.pr_number {
      let _ = gh::close_pr(&full, n).await;
    }
    if let Some(branch) = &old {
      let _ = gh::delete_branch(&full, branch).await;
    }
    if let Err(e) = repo::discard_changes(&wt, &tp.binding.folder).await {
      return fail(e);
    }
    let _ = repo::fetch(&tp.workspace).await;
    let fresh = naming::session_branch(&me.login, &tp.binding.folder, &naming::stamp(chrono::Utc::now()));
    if let Err(e) = repo::start_branch(&wt, &fresh).await {
      return fail(e);
    }
    if let Some(branch) = &old {
      repo::delete_local_branch(&wt, branch).await;
    }
    team::save_binding(&project_id, |b| {
      b.branch = Some(fresh.clone());
      b.pr_number = None;
      b.pr_url = None;
      b.publish = None;
    });
    let mut result = with_project(team::apply_view(&project_id));
    result.packages_changed =
      super::packages_changed(&tp.project.path, before.as_deref(), repo::head(&wt).await.as_deref()).await;
    result
  }));
  task.await.unwrap_or_else(|e| fail(format!("Discarding failed: {e}")))
}

/// The log of a pipeline run (failed steps first), for "View logs".
#[tauri::command]
pub async fn team_run_log(project_id: String, run_id: u64) -> Result<String, String> {
  let tp = team::team_project(&project_id)?;
  gh::as_account(tp.workspace.account.clone(), gh::run_log(&tp.workspace.repo, run_id, 40_000))
    .await
    .map_err(|e| e.describe("Read the pipeline log"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn summaries_are_one_short_line() {
    assert_eq!(summary("  \n## Add a dark mode toggle\nmore", "x"), "Add a dark mode toggle");
    assert_eq!(summary("", "Update App"), "Update App");
    let long = summary(&"word ".repeat(30), "x");
    assert!(long.ends_with('…'));
    assert!(long.chars().count() <= 73);
  }
}
