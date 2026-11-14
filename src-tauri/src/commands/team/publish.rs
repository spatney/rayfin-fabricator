//! Publishing a team app. Every step can be repeated safely: Publish resumes
//! where it stopped (for example after a teammate approves).
//!
//! 1. Save your latest changes to the working branch.
//! 2. Bring in teammates' published changes (conflicts go back to the user).
//! 3. Mark the draft pull request ready, which deploys your preview, and wait
//!    for that deploy (the check). A draft's own runs deploy nothing.
//! 4. Wait for a teammate's approval, when the workspace requires reviews.
//! 5. Squash-merge, then start a fresh working branch.
//! 6. Follow the pipeline's production deploy.

use std::path::PathBuf;

use serde_json::json;
use tauri::{AppHandle, Manager};

use super::session::save_and_share;
use super::{cancelled, fail, finish_run, git_identity, progress, run_status, sleep_or_cancel, viewer, wait_for_run, with_project};
use crate::commands::util::now_iso;
use crate::services::exec::CancelToken;
use crate::services::store;
use crate::services::team::{self, gh, naming, repo};
use crate::state::AppState;
use crate::types::{StudioProject, TeamActionResult, TeamDeployRecord, TeamPublishState, TeamReviewRequest, TeamWorkspace};

pub const PUBLISH_STEPS: &[(&str, fn() -> String)] = &[
  ("save", || t!("team.publish.step.save")),
  ("update", || t!("team.publish.step.update")),
  ("checks", || t!("team.publish.step.checks")),
  ("review", || t!("team.publish.step.review")),
  ("merge", || t!("team.publish.step.merge")),
  ("deploy", || t!("team.publish.step.deploy")),
];

fn label(step: &str) -> String {
  PUBLISH_STEPS.iter().find(|(id, _)| *id == step).map(|(_, l)| l()).unwrap_or_else(|| t!("team.publish.step.publish"))
}

fn set_publish(project_id: &str, state: Option<TeamPublishState>) -> Option<StudioProject> {
  team::save_binding(project_id, |b| b.publish = state)
}

fn stage(stage: &str, pr: Option<u64>) -> TeamPublishState {
  TeamPublishState { stage: stage.to_string(), pr_number: pr, at: now_iso(), ..Default::default() }
}

#[tauri::command]
pub async fn team_publish(app: AppHandle, project_id: String, confirm_data_loss: bool) -> TeamActionResult {
  let account = super::project_account(&project_id);
  let task = tokio::spawn(gh::as_account(account, async move {
    let state = app.state::<AppState>();
    let cancel = state.begin_team_op(&project_id);
    let result = if confirm_data_loss {
      publish_with_data_loss(&app, &project_id, &cancel).await
    } else {
      publish(&app, &project_id, &cancel).await
    };
    state.end_team_op(&project_id, &cancel);
    result
  }));
  task.await.unwrap_or_else(|e| fail(t!("team.publish.taskFailed", error = e)))
}

async fn publish(app: &AppHandle, project_id: &str, cancel: &CancelToken) -> TeamActionResult {
  let step = |id: &str, state: &str, detail: Option<String>| progress(app, project_id, id, state, &label(id), detail);
  let fail_at = |id: &str, message: String| {
    progress(app, project_id, id, "error", &label(id), Some(message.clone()));
    let mut result = fail(message);
    result.project = store::find_project(project_id);
    result
  };
  let state = app.state::<AppState>();
  let lease = match state.mutations.team(project_id) {
    Ok(lease) => lease,
    Err(e) => return fail(e),
  };
  let tp = match team::team_project(project_id) {
    Ok(tp) => tp,
    Err(e) => return fail(e),
  };
  let full = tp.workspace.repo.clone();
  let folder = tp.binding.folder.clone();
  let wt = PathBuf::from(&tp.binding.worktree);
  let me = match viewer().await {
    Ok(v) => v,
    Err(e) => return fail(e),
  };
  let (name, email) = git_identity(&me);

  // 1. Save.
  step("save", "running", None);
  if let Err(e) = save_and_share(project_id, "").await {
    return fail_at("save", e);
  }
  step("save", "done", None);

  // 2. Bring in teammates' changes.
  step("update", "running", None);
  if let Err(e) = repo::fetch(&tp.workspace).await {
    return fail_at("update", e);
  }
  let before_update = repo::head(&wt).await;
  match repo::merge_main(&wt, false, &name, &email).await {
    Ok(repo::MergeOutcome::Conflicts(files)) => {
      progress(app, project_id, "update", "error", &label("update"), Some(t!("team.publish.conflictsShort")));
      return TeamActionResult {
        ok: false,
        error: Some(t!("team.publish.conflicts")),
        conflicts: Some(files),
        project: store::find_project(project_id),
        ..Default::default()
      };
    }
    Ok(_) => {}
    Err(e) => return fail_at("update", e),
  }
  let branch = match repo::current_branch(&wt).await {
    Some(b) => b,
    None => return fail_at("update", t!("team.branchMissing")),
  };
  if repo::unpushed(&wt, &branch).await > 0 {
    if let Err(e) = repo::push(&wt, &branch).await {
      return fail_at("update", e);
    }
  }
  step("update", "done", None);
  // Teammates' changes may bring new packages, which the app on this computer needs.
  let packages_changed =
    super::packages_changed(&tp.project.path, before_update.as_deref(), repo::head(&wt).await.as_deref()).await;

  let (unpublished, _) = repo::divergence(&wt, &folder).await;
  if unpublished == 0 {
    set_publish(project_id, None);
    let mut result = fail(t!("team.publish.nothingNew"));
    result.packages_changed = packages_changed;
    return result;
  }
  // Saving opens the pull request once there's something to publish.
  let Some(tp) = team::team_project(project_id).ok() else {
    return fail(t!("team.services.projectNotFound"));
  };
  let pr_number = match tp.binding.pr_number {
    Some(n) => n,
    None => match save_and_share(project_id, "").await.ok().and_then(|p| p.team.and_then(|t| t.pr_number)) {
      Some(n) => n,
      None => return fail_at("save", t!("team.publish.cantOpenPr")),
    },
  };
  let pr = match gh::get_pr(&full, pr_number).await {
    Ok(pr) => pr,
    Err(e) => return fail_at("checks", e.describe(&t!("team.actions.openPr"))),
  };
  if pr.draft {
    if let Err(e) = gh::mark_ready(&full, pr_number).await {
      return fail_at("checks", e.describe(&t!("team.actions.markReady")));
    }
  }
  let Some(head) = repo::head(&wt).await else {
    return fail_at("checks", t!("team.publish.cantReadHead"));
  };

  // 3. Marking the pull request ready deploys your preview, which is the check
  //    (wait_for_run passes over a draft's runs, which deploy nothing).
  set_publish(project_id, Some(stage("checks", Some(pr_number))));
  step("checks", "running", None);
  let on_checks = |r: &gh::Run| step("checks", "running", Some(run_status(&r.status)));
  match wait_for_run(&full, &head, "pull_request", cancel, &on_checks).await {
    Err(e) => {
      set_publish(project_id, None);
      return fail_at("checks", e);
    }
    Ok(None) => {
      set_publish(project_id, None);
      return fail_at("checks", t!("team.publish.checksNotStarted"));
    }
    Ok(Some(run)) if run.conclusion.as_deref() != Some("success") => {
      // A run GitHub never started (no runner) isn't the app's problem.
      let unstarted = gh::unstarted_reason(&full, run.id).await;
      set_publish(
        project_id,
        Some(TeamPublishState {
          error: Some(t!("team.publish.previewFailedShort")),
          run_url: Some(run.url.clone()),
          ..stage("failed", Some(pr_number))
        }),
      );
      return fail_at(
        "checks",
        match unstarted {
          Some(reason) => super::unstarted_message(&t!("team.publish.previewUnstarted"), &reason),
          None => t!("team.publish.previewFailed"),
        },
      );
    }
    Ok(Some(_)) => {}
  }
  step("checks", "done", None);

  // 4. Reviews.
  let require_review = tp.workspace.manifest.as_ref().is_some_and(|m| m.settings.require_review);
  if require_review {
    let approvals = gh::approvals(&full, pr_number, &pr.author).await.unwrap_or(0);
    if approvals == 0 {
      step("review", "running", Some(t!("team.publish.waitingReview")));
      let project = set_publish(project_id, Some(stage("review", Some(pr_number))));
      let mut result = with_project(project);
      result.packages_changed = packages_changed;
      return result;
    }
    step("review", "done", None);
  } else {
    step("review", "skipped", None);
  }

  // 5. Merge, then start a fresh working branch.
  step("merge", "running", None);
  let identity = crate::commands::auth::get_cached_identity();
  let merge_sha = match gh::merge_pr(&full, pr_number, &pr.title).await {
    Ok(sha) => {
      crate::services::telemetry::track_team(identity.as_ref(), "publish", true);
      sha
    }
    Err(e) if matches!(e.status, Some(405) | Some(409)) => {
      crate::services::telemetry::track_team(identity.as_ref(), "publish", false);
      set_publish(project_id, None);
      return fail_at("merge", t!("team.publish.notYet", error = e.message));
    }
    Err(e) => {
      crate::services::telemetry::track_team(identity.as_ref(), "publish", false);
      set_publish(project_id, None);
      return fail_at("merge", e.describe(&t!("team.actions.merge")));
    }
  };
  let _ = gh::delete_branch(&full, &branch).await;
  let _ = repo::fetch(&tp.workspace).await;
  let fresh = naming::session_branch(&me.login, &folder, &naming::stamp(chrono::Utc::now()));
  if let Err(e) = repo::start_branch(&wt, &fresh).await {
    log::warn!("couldn't start a new working branch after publishing: {e}");
  } else {
    repo::delete_local_branch(&wt, &branch).await;
  }
  team::save_binding(project_id, |b| {
    b.branch = Some(fresh.clone());
    b.pr_number = None;
    b.pr_url = None;
    b.publish = Some(TeamPublishState { merge_sha: Some(merge_sha.clone()), ..stage("deploying", Some(pr_number)) });
  });
  team::apply_view(project_id);
  step("merge", "done", None);
  drop(lease);

  // 6. Follow the production deploy (the lease is released: chat can continue).
  let mut result = follow_production(app, project_id, &full, &folder, &merge_sha, "push", pr_number, cancel).await;
  result.packages_changed = packages_changed;
  result
}

/// Wait for the production run for `sha`, record its outcome and report.
#[allow(clippy::too_many_arguments)]
async fn follow_production(
  app: &AppHandle,
  project_id: &str,
  full: &str,
  folder: &str,
  sha: &str,
  event: &str,
  pr_number: u64,
  cancel: &CancelToken,
) -> TeamActionResult {
  let step = |state: &str, detail: Option<String>| progress(app, project_id, "deploy", state, &label("deploy"), detail);
  step("running", None);
  // Record the run as soon as it's known, so a status refresh can settle the
  // publish if nobody is waiting here any more.
  let recorded = std::sync::Mutex::new(None::<u64>);
  let on_run = |r: &gh::Run| {
    let mut seen = recorded.lock().unwrap();
    if *seen != Some(r.id) {
      *seen = Some(r.id);
      let (id, url) = (r.id, r.url.clone());
      team::save_binding(project_id, |b| {
        if let Some(p) = b.publish.as_mut().filter(|p| p.stage == "deploying") {
          p.run_id = Some(id);
          p.run_url = Some(url);
        }
      });
    }
    step("running", Some(run_status(&r.status)));
  };
  let run = match event {
    "push" => wait_for_run(full, sha, "push", cancel, &on_run).await,
    _ => match find_dispatch_run(full, cancel).await {
      Ok(Some(run)) => finish_run(full, run, cancel, &on_run).await.map(Some),
      Ok(None) => Ok(None),
      Err(e) => Err(e),
    },
  };
  let finished = match run {
    Err(e) => {
      // Stopped waiting: the pipeline keeps going and a status refresh settles it.
      step("error", Some(e.clone()));
      let mut result = fail(e);
      result.project = store::find_project(project_id);
      return result;
    }
    Ok(None) => {
      let project = set_publish(project_id, Some(stage("done", Some(pr_number))));
      step("skipped", Some(t!("team.publish.noDeploy")));
      return with_project(project);
    }
    Ok(Some(run)) => run,
  };
  let production = gh::latest_deployment(full, &naming::production_environment(folder)).await.ok().flatten();
  if production.is_some() {
    team::save_binding(project_id, |b| b.production = production.clone());
  }
  let current = store::find_project(project_id)
    .and_then(|p| p.team.and_then(|t| t.publish))
    .unwrap_or_else(|| TeamPublishState { merge_sha: Some(sha.to_string()), ..stage("deploying", Some(pr_number)) });
  let mut outcome = settled(&current, &finished, production.as_ref());
  if outcome.stage == "failed" && outcome.data_loss != Some(true) {
    if let Some(reason) = gh::unstarted_reason(full, finished.id).await {
      outcome.error = Some(super::unstarted_message(&t!("team.publish.deployUnstarted"), &reason));
    }
  }
  let failed = outcome.stage == "failed";
  let message = outcome.error.clone();
  let project = set_publish(project_id, Some(outcome));
  team::apply_view(project_id);
  if !failed {
    step("done", None);
    return with_project(project.and_then(|p| store::find_project(&p.id)));
  }
  let message = message.unwrap_or_else(|| t!("team.publish.deployFailed"));
  step("error", Some(message.clone()));
  let mut result = fail(message);
  result.project = store::find_project(project_id);
  result
}

/// The outcome of a finished production run. Data loss is taken only from the
/// pipeline's deployment record for this commit, which the workflow marks
/// when the Rayfin CLI refused a destructive change.
fn settled(publish: &TeamPublishState, run: &gh::Run, production: Option<&TeamDeployRecord>) -> TeamPublishState {
  let base = TeamPublishState { run_id: Some(run.id), run_url: Some(run.url.clone()), at: now_iso(), ..publish.clone() };
  if run.conclusion.as_deref() == Some("success") {
    return TeamPublishState { stage: "done".into(), error: None, data_loss: None, ..base };
  }
  let data_loss = production.is_some_and(|r| {
    r.reason.as_deref() == Some("data-loss") && (publish.merge_sha.is_none() || r.sha == publish.merge_sha || r.sha.as_deref() == Some(run.head_sha.as_str()))
  });
  let error = if data_loss { t!("team.publish.dataLoss") } else { t!("team.publish.deployFailedLogs") };
  TeamPublishState { stage: "failed".into(), error: Some(error), data_loss: Some(data_loss), ..base }
}

/// Settle a publish whose production deploy finished (or never started) while
/// nobody was waiting on it. `None` while it's still running.
pub(crate) async fn settle_deploying(
  full: &str,
  publish: &TeamPublishState,
  production: Option<&TeamDeployRecord>,
) -> Option<TeamPublishState> {
  let since = chrono::DateTime::parse_from_rfc3339(&publish.at).ok()?;
  let run = match (publish.run_id, &publish.merge_sha) {
    (Some(id), _) => gh::run(full, id).await.ok(),
    // Only a run started for this deploy (not an earlier, failed one).
    (None, Some(sha)) => gh::runs_for_sha(full, sha).await.ok().and_then(|runs| {
      runs.into_iter().find(|r| {
        r.event == "push"
          && r.created_at
            .as_deref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| t >= since - chrono::Duration::minutes(2))
      })
    }),
    (None, None) => None,
  };
  match run {
    Some(run) if run.status == "completed" => Some(settled(publish, &run, production)),
    Some(_) => None,
    None => (chrono::Utc::now().signed_duration_since(since) > chrono::Duration::minutes(15)).then(|| TeamPublishState {
      stage: "failed".into(),
      error: Some(t!("team.publish.deployNeverStarted")),
      at: now_iso(),
      ..publish.clone()
    }),
  }
}

async fn find_dispatch_run(full: &str, cancel: &CancelToken) -> Result<Option<gh::Run>, String> {
  let since = chrono::Utc::now() - chrono::Duration::seconds(20);
  for _ in 0..30 {
    if let Ok(runs) = gh::dispatch_runs(full).await {
      let found = runs.into_iter().find(|r| {
        r.created_at
          .as_deref()
          .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
          .is_some_and(|t| t >= since)
      });
      if found.is_some() {
        return Ok(found);
      }
    }
    if sleep_or_cancel(4_000, cancel).await {
      return Err(cancelled());
    }
  }
  Ok(None)
}

/// Deploy the published app even though its data-model change deletes data
/// (after the user confirmed).
async fn publish_with_data_loss(app: &AppHandle, project_id: &str, cancel: &CancelToken) -> TeamActionResult {
  let tp = match team::team_project(project_id) {
    Ok(tp) => tp,
    Err(e) => return fail(e),
  };
  let Some(publish) = tp.binding.publish.clone().filter(|p| p.data_loss == Some(true)) else {
    return fail(t!("team.publish.noBlockedDeploy"));
  };
  let full = tp.workspace.repo.clone();
  let folder = tp.binding.folder.clone();
  let pr_number = publish.pr_number.unwrap_or(0);
  if let Err(e) = gh::dispatch(&full, json!({ "action": "deploy", "project": folder, "force": true })).await {
    return fail(e.describe(&t!("team.actions.startDeploy")));
  }
  set_publish(project_id, Some(TeamPublishState { merge_sha: publish.merge_sha.clone(), ..stage("deploying", Some(pr_number)) }));
  follow_production(app, project_id, &full, &folder, publish.merge_sha.as_deref().unwrap_or_default(), "workflow_dispatch", pr_number, cancel).await
}

/// Pull requests waiting for your approval, in workspaces that require reviews.
/// Each workspace is read as its own GitHub account.
#[tauri::command]
pub async fn team_review_requests() -> Vec<TeamReviewRequest> {
  if team::require_enabled().is_err() {
    return vec![];
  }
  let mut requests = Vec::new();
  for ws in store::team_workspaces() {
    if !ws.manifest.as_ref().is_some_and(|m| m.settings.require_review) {
      continue;
    }
    requests.extend(gh::as_account(ws.account.clone(), review_requests_in(&ws)).await);
  }
  requests
}

async fn review_requests_in(ws: &TeamWorkspace) -> Vec<TeamReviewRequest> {
  let Ok(me) = viewer().await else { return vec![] };
  let Ok(prs) = gh::open_prs(&ws.repo).await else { return vec![] };
  let mut requests = Vec::new();
  for (mut pr, head) in prs {
    if pr.draft || pr.author.eq_ignore_ascii_case(&me.login) || !head.starts_with(naming::BRANCH_ROOT) {
      continue;
    }
    pr.approvals = gh::approvals(&ws.repo, pr.number, &pr.author).await.unwrap_or(0);
    if pr.approvals == 0 {
      requests.push(TeamReviewRequest { workspace_id: ws.id.clone(), repo: ws.repo.clone(), pr });
    }
  }
  requests
}

#[tauri::command]
pub async fn team_approve(workspace_id: String, pr_number: u64) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(ws) = store::find_team_workspace(&workspace_id) else {
    return fail(t!("team.workspaceMissing"));
  };
  match gh::as_account(ws.account.clone(), gh::approve(&ws.repo, pr_number)).await {
    Ok(()) => super::with_workspace(ws),
    Err(e) => fail(e.describe(&t!("team.actions.approve"))),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn run(conclusion: &str) -> gh::Run {
    gh::Run {
      id: 9,
      event: "push".into(),
      status: "completed".into(),
      conclusion: Some(conclusion.into()),
      url: "https://github.com/o/r/actions/runs/9".into(),
      head_sha: "merge".into(),
      head_branch: Some("main".into()),
      ..Default::default()
    }
  }

  fn deploying() -> TeamPublishState {
    TeamPublishState { merge_sha: Some("merge".into()), ..stage("deploying", Some(3)) }
  }

  #[test]
  fn data_loss_comes_only_from_this_commits_deployment_record() {
    let record = |sha: &str, reason: Option<&str>| TeamDeployRecord {
      environment: "production/app".into(),
      state: "failure".into(),
      sha: Some(sha.into()),
      reason: reason.map(String::from),
      ..Default::default()
    };
    let blocked = settled(&deploying(), &run("failure"), Some(&record("merge", Some("data-loss"))));
    assert_eq!(blocked.stage, "failed");
    assert_eq!(blocked.data_loss, Some(true));
    assert_eq!(blocked.run_id, Some(9));
    // Any other failure, or a record from an older commit, isn't data loss.
    assert_eq!(settled(&deploying(), &run("failure"), Some(&record("merge", None))).data_loss, Some(false));
    assert_eq!(settled(&deploying(), &run("failure"), Some(&record("older", Some("data-loss")))).data_loss, Some(false));
    assert_eq!(settled(&deploying(), &run("failure"), None).data_loss, Some(false));
  }

  #[test]
  fn a_successful_run_settles_as_done() {
    let done = settled(&deploying(), &run("success"), None);
    assert_eq!(done.stage, "done");
    assert_eq!(done.error, None);
    assert_eq!(done.pr_number, Some(3));
  }

  #[test]
  fn publish_steps_are_labelled() {
    assert_eq!(PUBLISH_STEPS.len(), 6);
    assert_eq!(label("review"), "Get a teammate's approval");
  }
}
