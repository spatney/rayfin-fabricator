//! The workspace map: every app in a team workspace, everyone's working copies
//! (branch, pull request and what it changes), their previews and the published
//! apps, and the pipeline runs deploying them right now.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use futures::stream::{self, StreamExt};
use serde_json::Value;

use super::viewer;
use crate::commands::util::now_iso;
use crate::services::store;
use crate::services::team::{self, gh, naming, repo, templates};
use crate::types::{
  StudioProject, TeamActivity, TeamDiff, TeamDiffFile, TeamMap, TeamMapApp, TeamMapCopy, TeamMapMember, TeamMapRun,
  TeamResourceRequest, TeamResourceSource, TeamResources, TeamWorkspace,
};

/// Pipeline runs shown, newest first.
const RUN_COUNT: u32 = 12;
/// Limits that keep the diff view fast for very large changes.
const MAX_DIFF_FILES: usize = 300;
const MAX_FILE_PATCH_LINES: usize = 400;
const MAX_TOTAL_PATCH_LINES: usize = 6000;
const MAX_NEW_FILE_LINES: usize = 200;
/// App copies read for the data view, and how many at once.
const MAX_RESOURCE_SOURCES: usize = 40;
const RESOURCE_READS_AT_ONCE: usize = 6;

fn local_projects(ws: &TeamWorkspace) -> Vec<StudioProject> {
  store::get_state()
    .projects
    .into_iter()
    .filter(|p| p.team.as_ref().is_some_and(|t| t.workspace_id == ws.id))
    .collect()
}

/// The pipeline's recent runs, with the jobs of the ones still going. A draft
/// pull request's run deploys nothing, so it isn't activity.
async fn runs_with_jobs(full: &str) -> Result<Vec<TeamMapRun>, String> {
  let mut runs = gh::recent_runs(full, RUN_COUNT).await.map_err(|e| e.describe(&t!("team.actions.readRuns")))?;
  runs.retain(|run| !run.is_draft());
  let jobs = futures::future::join_all(runs.iter().map(|run| async move {
    if run.status == "completed" {
      Vec::new()
    } else {
      gh::run_jobs(full, run.id).await.unwrap_or_default()
    }
  }))
  .await;
  Ok(runs.iter().zip(jobs.iter()).map(|(run, jobs)| gh::map_run(run, jobs)).collect())
}

/// An app's display name before it's published: the open project's name, or
/// the pull request title's `<name>: …` prefix.
fn pending_name(title: &str, folder: &str) -> String {
  title
    .split_once(": ")
    .map(|(name, _)| name.trim())
    .filter(|name| !name.is_empty() && name.len() <= 80)
    .unwrap_or(folder)
    .to_string()
}

fn app_index(apps: &mut Vec<TeamMapApp>, folder: &str, name: impl FnOnce() -> String) -> usize {
  if let Some(i) = apps.iter().position(|a| a.folder.eq_ignore_ascii_case(folder)) {
    return i;
  }
  apps.push(TeamMapApp { folder: folder.to_string(), name: name(), published: false, ..Default::default() });
  apps.len() - 1
}

/// Apps, working copies, deployments, pipeline runs and members of a workspace.
#[tauri::command]
pub async fn team_map(workspace_id: String) -> TeamMap {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, read_map(workspace_id)).await
}

async fn read_map(workspace_id: String) -> TeamMap {
  let fail = |error: String| TeamMap { ok: false, error: Some(error), fetched_at: now_iso(), ..Default::default() };
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(ws) = store::find_team_workspace(&workspace_id) else {
    return fail(t!("team.workspaceMissing"));
  };
  if ws.setup.as_ref().is_some_and(|s| !s.done) {
    return TeamMap { ok: true, workspace: Some(ws), fetched_at: now_iso(), ..Default::default() };
  }
  let full = ws.repo.clone();
  let mut problems: Vec<String> = Vec::new();

  let published = async {
    repo::ensure_clone(&ws, None).await?;
    repo::list_projects(&ws).await
  };
  let (published, prs, runs, collaborators, me) =
    tokio::join!(published, gh::open_pr_summaries(&full), runs_with_jobs(&full), gh::collaborators(&full), viewer());
  let login = me.ok().map(|v| v.login);
  let ok = published.is_ok();
  if ok {
    super::pin_account(&ws).await;
  }
  let published = published.unwrap_or_else(|e| {
    problems.push(e);
    Vec::new()
  });
  let prs = prs.unwrap_or_else(|e| {
    problems.push(e.describe(&t!("team.actions.readCopies")));
    Vec::new()
  });
  let runs = runs.unwrap_or_else(|e| {
    problems.push(e);
    Vec::new()
  });
  let members: Vec<TeamMapMember> = collaborators
    .map(|list| {
      list
        .into_iter()
        .map(|(login, avatar_url, owner)| TeamMapMember {
          login,
          avatar_url,
          role: if owner { "owner".into() } else { "member".into() },
        })
        .collect()
    })
    .unwrap_or_default();
  let is_me = |author: &str| login.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(author));

  let mut apps: Vec<TeamMapApp> = published
    .into_iter()
    .map(|(folder, name)| TeamMapApp { folder, name, published: true, ..Default::default() })
    .collect();

  // Everyone's working copies on GitHub (their pull requests).
  for summary in prs {
    let Some((_, folder)) = naming::parse_session_branch(&summary.head) else {
      continue;
    };
    let i = app_index(&mut apps, &folder, || pending_name(&summary.pr.title, &folder));
    let mine = is_me(&summary.pr.author);
    apps[i].copies.push(TeamMapCopy {
      branch: summary.head,
      author: summary.pr.author.clone(),
      avatar_url: summary.avatar_url,
      mine,
      additions: summary.additions,
      deletions: summary.deletions,
      changed_files: summary.changed_files,
      commits: summary.commits,
      review: summary.review,
      updated_at: summary.updated_at,
      files: summary.files,
      pr: Some(summary.pr),
      ..Default::default()
    });
  }

  // Your copies on this computer, including ones not saved to GitHub yet.
  for project in local_projects(&ws) {
    let Some(binding) = project.team.clone() else { continue };
    let i = app_index(&mut apps, &binding.folder, || project.name.clone());
    apps[i].project_id = Some(project.id.clone());
    if !apps[i].published {
      apps[i].name = project.name.clone();
    }
    let wt = PathBuf::from(&binding.worktree);
    let Some(branch) = repo::current_branch(&wt).await.or(binding.branch.clone()) else {
      continue;
    };
    let dirty = repo::is_dirty(&wt, &binding.folder).await;
    let (unpublished, behind) = repo::divergence(&wt, &binding.folder).await;
    if let Some(copy) = apps[i].copies.iter_mut().find(|c| c.branch == branch) {
      copy.mine = true;
      copy.local_edits = dirty;
      copy.behind = Some(behind);
      continue;
    }
    let files = if dirty || unpublished > 0 { repo::local_changes(&wt, &binding.folder).await } else { Vec::new() };
    let author = login.clone().unwrap_or_default();
    let avatar_url = members.iter().find(|m| m.login.eq_ignore_ascii_case(&author)).and_then(|m| m.avatar_url.clone());
    apps[i].copies.push(TeamMapCopy {
      branch,
      author,
      avatar_url,
      mine: true,
      additions: files.iter().map(|f| f.additions).sum(),
      deletions: files.iter().map(|f| f.deletions).sum(),
      changed_files: files.len() as u32,
      commits: unpublished,
      local_edits: dirty,
      behind: Some(behind),
      files,
      ..Default::default()
    });
  }

  // The latest deployment of every published app and every author's preview.
  let mut environments: Vec<String> = Vec::new();
  for app in &apps {
    if app.published {
      environments.push(naming::production_environment(&app.folder));
    }
    for copy in app.copies.iter().filter(|c| !c.author.is_empty()) {
      environments.push(naming::preview_environment(&app.folder, &copy.author));
    }
  }
  environments.sort();
  environments.dedup();
  let records = if environments.is_empty() {
    HashMap::new()
  } else {
    gh::latest_deployments(&full, &environments).await.unwrap_or_else(|e| {
      problems.push(e.describe(&t!("team.actions.readDeployments")));
      HashMap::new()
    })
  };
  // From template v6 a draft deploys nothing, so a draft's (or an unsaved
  // copy's) preview record is left from an earlier pull request.
  let ready_previews =
    ws.manifest.as_ref().is_some_and(|m| m.template_version >= templates::READY_PREVIEWS_VERSION);
  for app in &mut apps {
    app.production = records.get(&naming::production_environment(&app.folder)).cloned();
    for copy in &mut app.copies {
      let deploys = !ready_previews || copy.pr.as_ref().is_some_and(|pr| !pr.draft);
      if !copy.author.is_empty() && deploys {
        copy.preview = records.get(&naming::preview_environment(&app.folder, &copy.author)).cloned();
      }
    }
    app.copies.sort_by(|a, b| b.mine.cmp(&a.mine).then_with(|| b.updated_at.cmp(&a.updated_at)));
  }
  apps.sort_by(|a, b| b.published.cmp(&a.published).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));

  TeamMap {
    ok,
    error: (!problems.is_empty()).then(|| problems.join(" ")),
    workspace: Some(ws),
    viewer: login,
    apps,
    runs,
    members,
    fetched_at: now_iso(),
  }
}

/// What the workspace's pipeline is doing: its recent runs, with the steps of
/// the ones in progress.
#[tauri::command]
pub async fn team_activity(workspace_id: String) -> TeamActivity {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, read_activity(workspace_id)).await
}

async fn read_activity(workspace_id: String) -> TeamActivity {
  let fail = |error: String| TeamActivity { ok: false, error: Some(error), fetched_at: now_iso(), ..Default::default() };
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(ws) = store::find_team_workspace(&workspace_id) else {
    return fail(t!("team.workspaceMissing"));
  };
  if ws.setup.as_ref().is_some_and(|s| !s.done) {
    return TeamActivity { ok: true, fetched_at: now_iso(), ..Default::default() };
  }
  match runs_with_jobs(&ws.repo).await {
    Ok(runs) => TeamActivity { ok: true, error: None, runs, fetched_at: now_iso() },
    Err(e) => fail(e),
  }
}

/// The changes in a working copy: a pull request's (`pr_number`), or your copy
/// on this computer including edits not saved to GitHub yet.
#[tauri::command]
pub async fn team_diff(workspace_id: String, folder: String, pr_number: Option<u64>) -> TeamDiff {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, read_diff(workspace_id, folder, pr_number)).await
}

async fn read_diff(workspace_id: String, folder: String, pr_number: Option<u64>) -> TeamDiff {
  let fail = |error: String| TeamDiff { ok: false, error: Some(error), ..Default::default() };
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(ws) = store::find_team_workspace(&workspace_id) else {
    return fail(t!("team.workspaceMissing"));
  };
  if let Some(number) = pr_number {
    return match gh::pr_files(&ws.repo, number).await {
      Ok(files) => limit(rest_files(&files)),
      Err(e) => fail(e.describe(&t!("team.actions.readChanges"))),
    };
  }
  let Some(binding) = local_projects(&ws)
    .into_iter()
    .filter_map(|p| p.team)
    .find(|t| t.folder.eq_ignore_ascii_case(&folder))
  else {
    return fail(t!("team.map.notOpen"));
  };
  let wt = PathBuf::from(&binding.worktree);
  let mut files = split_unified_diff(&repo::local_diff(&wt, &binding.folder).await);
  for path in repo::untracked_files(&wt, &binding.folder).await {
    if !files.iter().any(|f| f.path == path) {
      files.push(new_file_diff(&wt, &path));
    }
  }
  files.sort_by(|a, b| a.path.cmp(&b.path));
  limit(files)
}

/// The config of the app copies asked for (published, a teammate's working
/// copy on GitHub, or yours on this computer): `rayfin.yml`, the data model and
/// the functions' source, for the overview's view of each app's data and
/// connections. Reads the team clone `team_map` just fetched; no network.
#[tauri::command]
pub async fn team_resources(workspace_id: String, requests: Vec<TeamResourceRequest>) -> TeamResources {
  let fail = |error: String| TeamResources { ok: false, error: Some(error), ..Default::default() };
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(ws) = store::find_team_workspace(&workspace_id) else {
    return fail(t!("team.workspaceMissing"));
  };
  let locals = local_projects(&ws);
  let sources = stream::iter(requests.into_iter().take(MAX_RESOURCE_SOURCES))
    .map(|request| read_resource_source(&ws, &locals, request))
    .buffered(RESOURCE_READS_AT_ONCE)
    .collect::<Vec<_>>()
    .await;
  TeamResources { ok: true, error: None, sources }
}

/// The commit a request reads in the team clone, or why it can't be read.
fn resource_tree(request: &TeamResourceRequest) -> Result<String, String> {
  let plain = |b: &str| !b.contains("..") && b.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
  match &request.branch {
    None => Ok("origin/main".into()),
    // Only Fabricator's working branches for this app: never an arbitrary ref.
    Some(branch)
      if plain(branch)
        && naming::parse_session_branch(branch).is_some_and(|(_, f)| f.eq_ignore_ascii_case(&request.folder)) =>
    {
      Ok(format!("origin/{branch}"))
    }
    Some(_) => Err(t!("team.map.notACopy")),
  }
}

async fn read_resource_source(ws: &TeamWorkspace, locals: &[StudioProject], request: TeamResourceRequest) -> TeamResourceSource {
  let mut source = TeamResourceSource {
    folder: request.folder.clone(),
    branch: request.branch.clone(),
    local: request.local,
    ..Default::default()
  };
  let read = if !naming::is_app_folder(&request.folder) {
    Err(t!("team.map.notAnApp"))
  } else if request.local {
    match locals.iter().filter_map(|p| p.team.as_ref()).find(|t| t.folder.eq_ignore_ascii_case(&request.folder)) {
      Some(binding) => {
        let dir = PathBuf::from(&binding.worktree).join(&binding.folder);
        tokio::task::spawn_blocking(move || repo::read_app_config_on_disk(&dir))
          .await
          .map_err(|_| t!("team.map.cantReadCopy"))
      }
      None => Err(t!("team.map.copyMissing")),
    }
  } else {
    match resource_tree(&request) {
      Ok(tree) => repo::read_app_config(ws, &tree, &request.folder).await,
      Err(e) => Err(e),
    }
  };
  match read {
    Ok((files, truncated)) => {
      source.ok = true;
      source.files = files;
      source.truncated = truncated;
    }
    Err(e) => source.error = Some(e),
  }
  source
}

/// Changed files from GitHub's pull request files API.
fn rest_files(files: &[Value]) -> Vec<TeamDiffFile> {
  let count = |v: Option<&Value>| v.and_then(Value::as_u64).unwrap_or(0).min(u64::from(u32::MAX)) as u32;
  files
    .iter()
    .filter_map(|f| {
      Some(TeamDiffFile {
        path: f.get("filename")?.as_str()?.to_string(),
        change: gh::change_kind(f.get("status").and_then(Value::as_str).unwrap_or_default()),
        additions: count(f.get("additions")),
        deletions: count(f.get("deletions")),
        patch: f.get("patch").and_then(Value::as_str).map(String::from),
        truncated: false,
      })
    })
    .collect()
}

/// Split `git diff` output into one entry per file, counting its added and
/// removed lines. Each patch starts at its first hunk, like GitHub's.
fn split_unified_diff(text: &str) -> Vec<TeamDiffFile> {
  fn finish(mut file: TeamDiffFile, lines: Vec<&str>) -> TeamDiffFile {
    if !lines.is_empty() {
      file.patch = Some(lines.join("\n"));
    }
    file
  }
  let mut files = Vec::new();
  let mut current: Option<(TeamDiffFile, Vec<&str>)> = None;
  for line in text.lines() {
    if let Some(rest) = line.strip_prefix("diff --git ") {
      if let Some((file, lines)) = current.take() {
        files.push(finish(file, lines));
      }
      let path = rest.rsplit_once(" b/").map(|(_, b)| b).unwrap_or(rest).to_string();
      current = Some((TeamDiffFile { path, change: "modified".into(), ..Default::default() }, Vec::new()));
      continue;
    }
    let Some((file, lines)) = current.as_mut() else { continue };
    if lines.is_empty() && !line.starts_with("@@") {
      if line.starts_with("new file mode") {
        file.change = "added".into();
      } else if line.starts_with("deleted file mode") {
        file.change = "deleted".into();
      }
      continue;
    }
    if line.starts_with('+') {
      file.additions += 1;
    } else if line.starts_with('-') {
      file.deletions += 1;
    }
    lines.push(line);
  }
  if let Some((file, lines)) = current.take() {
    files.push(finish(file, lines));
  }
  files
}

/// A new file that isn't tracked yet, shown as all-added lines.
fn new_file_diff(worktree: &Path, path: &str) -> TeamDiffFile {
  let full = worktree.join(path);
  let text = std::fs::metadata(&full)
    .ok()
    .filter(|m| m.is_file() && m.len() <= 1_000_000)
    .and_then(|_| std::fs::read(&full).ok())
    .filter(|bytes| !bytes.contains(&0))
    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
  let Some(text) = text else {
    return TeamDiffFile { path: path.to_string(), change: "added".into(), ..Default::default() };
  };
  let lines: Vec<&str> = text.lines().collect();
  let shown: Vec<String> = lines.iter().take(MAX_NEW_FILE_LINES).map(|l| format!("+{l}")).collect();
  TeamDiffFile {
    path: path.to_string(),
    change: "added".into(),
    additions: lines.len() as u32,
    deletions: 0,
    patch: (!lines.is_empty()).then(|| format!("@@ -0,0 +1,{} @@\n{}", lines.len(), shown.join("\n"))),
    truncated: lines.len() > MAX_NEW_FILE_LINES,
  }
}

/// Keep the diff to a size the view can show quickly.
fn limit(mut files: Vec<TeamDiffFile>) -> TeamDiff {
  let mut truncated = false;
  if files.len() > MAX_DIFF_FILES {
    files.truncate(MAX_DIFF_FILES);
    truncated = true;
  }
  let mut budget = MAX_TOTAL_PATCH_LINES;
  for file in &mut files {
    let Some(patch) = file.patch.take() else { continue };
    let lines: Vec<&str> = patch.lines().collect();
    let keep = lines.len().min(MAX_FILE_PATCH_LINES).min(budget);
    if keep < lines.len() {
      file.truncated = true;
    }
    budget -= keep;
    if keep > 0 {
      file.patch = Some(lines[..keep].join("\n"));
    }
  }
  TeamDiff { ok: true, error: None, files, truncated }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn the_data_view_reads_only_this_apps_working_branches() {
    let request = |folder: &str, branch: Option<&str>| TeamResourceRequest {
      folder: folder.into(),
      branch: branch.map(String::from),
      local: false,
    };
    assert_eq!(resource_tree(&request("trips", None)).unwrap(), "origin/main");
    assert_eq!(
      resource_tree(&request("trips", Some("fabricator/amy/trips-20261003-101500"))).unwrap(),
      "origin/fabricator/amy/trips-20261003-101500"
    );
    for refused in [
      "fabricator/amy/notes-20261003-101500",
      "main",
      "fabricator/a:b/trips-20261003-101500",
      "fabricator/../trips-20261003-101500",
      "-c/x",
    ] {
      assert!(resource_tree(&request("trips", Some(refused))).is_err(), "{refused}");
    }
  }

  #[test]
  fn unified_diffs_split_into_files_with_counts() {
    let text = "diff --git a/app/src/App.tsx b/app/src/App.tsx\nindex 1..2 100644\n--- a/app/src/App.tsx\n+++ b/app/src/App.tsx\n@@ -1,2 +1,2 @@\n-old\n+new\n+++plus\n context\ndiff --git a/app/gone.ts b/app/gone.ts\ndeleted file mode 100644\n--- a/app/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\ndiff --git a/app/logo.png b/app/logo.png\nnew file mode 100644\nBinary files /dev/null and b/app/logo.png differ\n";
    let files = split_unified_diff(text);
    assert_eq!(files.len(), 3);
    assert_eq!((files[0].path.as_str(), files[0].change.as_str(), files[0].additions, files[0].deletions), ("app/src/App.tsx", "modified", 2, 1));
    assert!(files[0].patch.as_deref().unwrap().starts_with("@@ -1,2 +1,2 @@"));
    assert_eq!((files[1].change.as_str(), files[1].deletions), ("deleted", 1));
    assert_eq!((files[2].change.as_str(), files[2].patch.as_deref()), ("added", None));
  }

  #[test]
  fn large_diffs_are_shortened() {
    let big: Vec<String> = (0..MAX_FILE_PATCH_LINES + 50).map(|i| format!("+line {i}")).collect();
    let file = |path: &str| TeamDiffFile { path: path.into(), patch: Some(big.join("\n")), ..Default::default() };
    let many: Vec<TeamDiffFile> = (0..MAX_DIFF_FILES + 5).map(|i| file(&format!("f{i}"))).collect();
    let diff = limit(many);
    assert!(diff.truncated);
    assert_eq!(diff.files.len(), MAX_DIFF_FILES);
    assert!(diff.files[0].truncated);
    assert_eq!(diff.files[0].patch.as_deref().unwrap().lines().count(), MAX_FILE_PATCH_LINES);
    let shown: usize = diff.files.iter().filter_map(|f| f.patch.as_deref()).map(|p| p.lines().count()).sum();
    assert_eq!(shown, MAX_TOTAL_PATCH_LINES);
    assert!(diff.files.last().unwrap().patch.is_none() && diff.files.last().unwrap().truncated);
  }

  #[test]
  fn pull_request_files_keep_their_patches() {
    let files = rest_files(&[
      json!({"filename": "trips/src/Map.tsx", "status": "added", "additions": 3, "deletions": 0, "patch": "@@ -0,0 +1,3 @@\n+a\n+b\n+c"}),
      json!({"filename": "trips/package-lock.json", "status": "modified", "additions": 900, "deletions": 20}),
    ]);
    assert_eq!(files[0].change, "added");
    assert_eq!(files[0].patch.as_deref().map(|p| p.lines().count()), Some(4));
    assert_eq!(files[1].patch, None);
  }

  #[test]
  fn new_files_show_as_added_lines() {
    let dir = std::env::temp_dir().join(format!("fab-newfile-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("app")).unwrap();
    std::fs::write(dir.join("app/a.ts"), "one\ntwo\n").unwrap();
    std::fs::write(dir.join("app/b.bin"), [0u8, 1, 2]).unwrap();
    let text = new_file_diff(&dir, "app/a.ts");
    assert_eq!((text.additions, text.patch.as_deref()), (2, Some("@@ -0,0 +1,2 @@\n+one\n+two")));
    let binary = new_file_diff(&dir, "app/b.bin");
    assert_eq!((binary.change.as_str(), binary.patch.as_deref()), ("added", None));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn unpublished_apps_take_their_name_from_the_pull_request() {
    assert_eq!(pending_name("Trip Logger: add a map", "trip-logger"), "Trip Logger");
    assert_eq!(pending_name("no prefix here", "trips"), "trips");
    assert_eq!(pending_name(": empty", "trips"), "trips");
  }
}
