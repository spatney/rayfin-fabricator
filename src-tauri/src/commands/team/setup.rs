//! Creating a team workspace: every step is automatic, idempotent and
//! resumable, with plain-language problems (and admin instructions) when the
//! directory, Fabric or GitHub settings block a step.

use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use super::{cancelled, fail, fail_with, git_identity, problem, progress, run_status, sleep_or_cancel, unique_dir, viewer};
use crate::commands::util::now_iso;
use crate::services::exec::CancelToken;
use crate::services::store;
use crate::services::team::{self, entra, fabric, gh, naming, repo, templates};
use crate::state::AppState;
use crate::types::{
  TeamActionResult, TeamCreateRequest, TeamDeployIdentity, TeamFabricTargets, TeamFabricWorkspace, TeamLink, TeamManifest,
  TeamProblem, TeamSettings, TeamSetupState, TeamWorkspace,
};

/// Setup steps in order: (id, English label, for Copilot). The renderer shows
/// the same checklist; `label` gives a step's label in the app's language.
pub const SETUP_STEPS: &[(&str, &str)] = &[
  ("github", "Create the private GitHub repository"),
  ("fabric", "Create the production and preview Fabric workspaces"),
  ("identity", "Create the deploy identities (service principals)"),
  ("trust", "Let the repository's pipeline sign in as those identities"),
  ("access", "Give the deploy identities access to Fabric"),
  ("files", "Add the deploy pipeline to the repository"),
  ("protection", "Protect the main branch"),
  ("clone", "Download the workspace to this computer"),
  ("verify", "Check that the pipeline can reach Fabric"),
];

fn label(step: &str) -> String {
  match step {
    "github" => t!("team.setup.step.github"),
    "fabric" => t!("team.setup.step.fabric"),
    "identity" => t!("team.setup.step.identity"),
    "trust" => t!("team.setup.step.trust"),
    "access" => t!("team.setup.step.access"),
    "files" => t!("team.setup.step.files"),
    "protection" => t!("team.setup.step.protection"),
    "clone" => t!("team.setup.step.clone"),
    "verify" => t!("team.setup.step.verify"),
    _ => t!("team.setup.step.setup"),
  }
}

pub(crate) const FABRIC_SP_NOTE: &str = "In the Fabric admin portal, open Tenant settings → Developer settings and turn on \"Service principals can call Fabric public APIs\" (for the organization, or for a security group that includes the workspace's deploy identity).";

struct Setup<'a> {
  app: &'a AppHandle,
  scope: String,
  ws: TeamWorkspace,
  state: TeamSetupState,
}

impl Setup<'_> {
  fn done(&self, step: &str) -> bool {
    self.state.completed.iter().any(|s| s == step)
  }

  fn start(&self, step: &str) {
    progress(self.app, &self.scope, step, "running", &label(step), None);
  }

  fn finish(&mut self, step: &str) {
    if !self.done(step) {
      self.state.completed.push(step.to_string());
    }
    progress(self.app, &self.scope, step, "done", &label(step), None);
    self.save();
  }

  fn save(&mut self) {
    self.ws.setup = Some(self.state.clone());
    if !self.ws.repo.is_empty() {
      store::upsert_team_workspace(self.ws.clone());
    }
  }

  fn fail(mut self, p: TeamProblem) -> TeamActionResult {
    progress(self.app, &self.scope, &p.step, "error", &label(&p.step), Some(p.message.clone()));
    self.state.problem = Some(p.clone());
    self.save();
    let mut result = fail_with(p);
    if !self.ws.repo.is_empty() {
      result.workspace = Some(self.ws);
    }
    result
  }
}

fn github_problem(step: &str, action: &str, e: &gh::GhError) -> TeamProblem {
  if let Some(p) = super::sso_problem(step, action, e) {
    return p;
  }
  let mut p = problem(step, e.describe(action));
  if e.status == Some(403) {
    p.guidance = Some(if step == "github" { t!("team.setup.cantCreateRepos") } else { t!("team.setup.orgMayNotAllow") });
  } else if e.message.to_ascii_lowercase().contains("workflow") {
    p.guidance = Some(t!("team.setup.workflowPermission"));
  }
  p
}

fn azure_problem(step: &str, action: &str, e: &entra::AzError, admin_note: Option<String>) -> TeamProblem {
  let mut p = problem(step, e.describe(action));
  if e.kind == entra::AzErrorKind::Blocked {
    p.message = t!("team.setup.entraBlocked");
    p.guidance = Some(t!("team.setup.entraBlockedHint"));
    p.admin_note = admin_note;
  }
  p
}

fn fabric_problem(step: &str, action: &str, e: &fabric::FabricError) -> TeamProblem {
  let mut p = problem(step, e.describe(action));
  if matches!(e.status, Some(401) | Some(403)) {
    p.guidance = Some(if step == "fabric" { t!("team.setup.fabricCapacityHint") } else { t!("team.setup.fabricRoleHint") });
    if step == "access" {
      p.admin_note = Some(FABRIC_SP_NOTE.into());
    }
  }
  p
}

/// Create a team workspace. `scope` tags the `team:progress` events.
#[tauri::command]
pub async fn team_create(app: AppHandle, request: TeamCreateRequest, scope: String) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let mut request = request;
  request.name = request.name.trim().to_string();
  if request.name.is_empty() {
    return fail(t!("team.setup.enterName"));
  }
  request.existing_repo = match request.existing_repo.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
    Some(raw) => match naming::parse_repo(raw) {
      Some(repo) => Some(repo),
      None => return fail(t!("team.setup.repoFormat")),
    },
    None => None,
  };
  // An existing repository decides the owner.
  if let Some(repo) = &request.existing_repo {
    request.owner = repo.split('/').next().unwrap_or_default().to_string();
  }
  if request.owner.trim().is_empty() {
    return fail(t!("team.setup.chooseOwner"));
  }
  if request.capacity_id.trim().is_empty() {
    return fail(t!("team.setup.chooseCapacity"));
  }
  request.existing_client_id = request.existing_client_id.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
  request.account = request.account.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
  if request.account.as_deref().is_some_and(|a| !gh::is_login(a)) {
    return fail(t!("team.workspace.chooseAccount"));
  }
  request.runner = match request.runner.map(templates::clean_runner).transpose() {
    Ok(runner) => runner,
    Err(e) => return fail(e),
  };
  let account = request.account.clone();
  let dir = unique_dir(&naming::slug(&request.name));
  let ws = TeamWorkspace {
    id: uuid::Uuid::new_v4().to_string(),
    name: request.name.clone(),
    repo: String::new(),
    default_branch: naming::DEFAULT_BRANCH.to_string(),
    dir: dir.to_string_lossy().to_string(),
    role: "owner".into(),
    added_at: now_iso(),
    manifest: None,
    setup: Some(TeamSetupState { request, ..Default::default() }),
    account: None,
    fabric_members: Default::default(),
  };
  gh::as_account(account, run_setup(&app, ws, &scope)).await
}

/// Continue an interrupted or failed setup. A new `existing_client_id` lets the
/// owner finish with an app registration an administrator created.
#[tauri::command]
pub async fn team_resume_setup(
  app: AppHandle,
  workspace_id: String,
  scope: String,
  existing_client_id: Option<String>,
) -> TeamActionResult {
  if let Err(e) = team::require_enabled() {
    return fail(e);
  }
  let Some(mut ws) = store::find_team_workspace(&workspace_id) else {
    return fail(t!("team.workspaceMissing"));
  };
  let Some(setup) = ws.setup.as_mut() else {
    return fail(t!("team.setup.joinedHere"));
  };
  if let Some(client) = existing_client_id.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
    setup.request.existing_client_id = Some(client);
    setup.app_id = None;
    setup.app_object_id = None;
    setup.sp_object_id = None;
    setup.preview_app_id = None;
    setup.preview_app_object_id = None;
    setup.preview_sp_object_id = None;
    setup.completed.retain(|s| !matches!(s.as_str(), "identity" | "trust" | "access" | "files" | "verify"));
  }
  let account = ws.account.clone().or_else(|| setup.request.account.clone());
  gh::as_account(account, run_setup(&app, ws, &scope)).await
}

/// Stop waiting on a long team operation (setup verification or publish).
#[tauri::command]
pub fn team_cancel(state: State<'_, AppState>, key: String) -> bool {
  state.cancel_team_op(&key)
}

async fn run_setup(app: &AppHandle, ws: TeamWorkspace, scope: &str) -> TeamActionResult {
  let state = app.state::<AppState>();
  // Keyed by the caller's scope: the renderer doesn't know a new workspace's id yet.
  let cancel = state.begin_team_op(scope);
  let result = provision(app, ws, scope, &cancel).await;
  state.end_team_op(scope, &cancel);
  crate::services::telemetry::track_team(crate::commands::auth::get_cached_identity().as_ref(), "create", result.ok);
  result
}

async fn provision(app: &AppHandle, ws: TeamWorkspace, scope: &str, cancel: &CancelToken) -> TeamActionResult {
  let state = ws.setup.clone().unwrap_or_default();
  let mut s = Setup { app, scope: scope.to_string(), ws, state };
  s.state.problem = None;
  let req = s.state.request.clone();
  let name = req.name.clone();

  let me = match viewer().await {
    Ok(v) => v,
    Err(e) => return s.fail(problem("github", e)),
  };
  let (git_name, git_email) = git_identity(&me);

  let tenant = match entra::account().await {
    Ok((t, _)) => t,
    Err(e) => return s.fail(azure_problem("identity", &t!("team.actions.checkAzureSignIn"), &e, None)),
  };
  if s.state.tenant_id.as_deref().is_some_and(|t| t != tenant) {
    return s.fail(problem("identity", t!("team.setup.wrongTenant")));
  }
  s.state.tenant_id = Some(tenant.clone());

  // 1. The private repository: a new one, or the one someone created for the workspace.
  s.start("github");
  let info = if !s.ws.repo.is_empty() {
    match gh::repo(&s.ws.repo).await {
      Ok(info) => info,
      Err(e) => return s.fail(github_problem("github", &t!("team.actions.openGithubRepo"), &e)),
    }
  } else if let Some(existing) = &req.existing_repo {
    match adopt_repo(existing, &me.login).await {
      Ok(info) => info,
      Err(p) => return s.fail(p),
    }
  } else {
    let base = naming::repo_name(&name).unwrap_or_else(|| "team-apps".into());
    let mut created = None;
    let mut last_error = None;
    for n in 1..=5 {
      let candidate = if n == 1 { base.clone() } else { format!("{base}-{n}") };
      match gh::create_repo(&req.owner, req.owner_is_org, &candidate, &naming::repo_description(&name)).await {
        Ok(info) => {
          created = Some(info);
          break;
        }
        Err(e) if e.status == Some(422) && e.message.to_ascii_lowercase().contains("already exists") => last_error = Some(e),
        Err(e) => {
          last_error = Some(e);
          break;
        }
      }
    }
    match created {
      Some(info) => info,
      None => {
        let e = last_error.unwrap_or_else(|| gh::GhError { status: None, message: t!("team.setup.noRepoName"), missing_cli: false, sso_url: None });
        return s.fail(github_problem("github", &t!("team.actions.createRepo"), &e));
      }
    }
  };
  s.ws.repo = info.full_name.clone();
  // The account that reached the repository is the one the workspace uses.
  s.ws.account.get_or_insert_with(|| me.login.clone());
  if req.existing_repo.is_some() && !s.done("github") {
    // Invitations to it are told apart from other repositories' by this description.
    if !naming::is_workspace_description(info.description.as_deref()) {
      s.state.previous_description = info.description.clone();
      s.save();
      if let Err(e) = gh::set_description(&info.full_name, &naming::repo_description(&name)).await {
        log::warn!("couldn't describe {} as a team workspace: {}", info.full_name, e.message);
      }
    }
    // Publishing squash-merges pull requests.
    if let Err(e) = gh::apply_merge_settings(&info.full_name).await {
      log::warn!("couldn't apply the merge settings to {}: {}", info.full_name, e.message);
    }
  } else if req.existing_repo.is_none() && info.manages() && !naming::is_workspace_description(info.description.as_deref()) {
    // Its organization replaced the description when it locked the new repository.
    if let Err(e) = gh::set_description(&info.full_name, &naming::repo_description(&name)).await {
      log::warn!("couldn't describe {} as a team workspace: {}", info.full_name, e.message);
    }
  }
  if let Err(e) = gh::set_topic(&info, naming::REPO_TOPIC, true).await {
    log::warn!("couldn't tag {} as a team workspace: {}", info.full_name, e.message);
  }
  s.finish("github");

  // 2. Fabric workspaces for published apps and previews.
  s.start("fabric");
  if s.state.production_workspace_id.is_none() {
    match fabric::create_workspace(&name, &req.capacity_id).await {
      Ok((id, _)) => s.state.production_workspace_id = Some(id),
      Err(e) => return s.fail(fabric_problem("fabric", &t!("team.actions.createFabricWorkspace"), &e)),
    }
    s.save();
  }
  if s.state.previews_workspace_id.is_none() {
    match fabric::create_workspace(&format!("{name} previews"), &req.capacity_id).await {
      Ok((id, _)) => s.state.previews_workspace_id = Some(id),
      Err(e) => return s.fail(fabric_problem("fabric", &t!("team.actions.createPreviewsWorkspace"), &e)),
    }
  }
  s.finish("fabric");
  let prod_ws = s.state.production_workspace_id.clone().unwrap_or_default();
  let preview_ws = s.state.previews_workspace_id.clone().unwrap_or_default();

  // 3. The deploy identities: one for published apps and one for previews, so a
  // pull request can't reach the published apps. An administrator's app
  // registration serves both.
  let separate = req.existing_client_id.is_none();
  let display = naming::app_display_name(&name);
  let preview_display = naming::preview_app_display_name(&name);
  let (deploy_subjects, preview_subjects) = naming::identity_subjects(&info.full_name, info.owner_id, info.id, separate);
  let all_subjects = naming::identity_subjects(&info.full_name, info.owner_id, info.id, false).0;
  let note = entra::admin_note(&display, &info.full_name, &all_subjects);
  s.start("identity");
  if s.state.app_id.is_none() || s.state.app_object_id.is_none() {
    let registration = match &req.existing_client_id {
      Some(client) => match entra::app(client).await {
        Ok(Some(app)) => app,
        Ok(None) => return s.fail(problem("identity", t!("team.setup.noAppRegistration", client = client))),
        Err(e) => return s.fail(azure_problem("identity", &t!("team.actions.findAppRegistration"), &e, Some(note.clone()))),
      },
      None => match entra::create_app(&display).await {
        Ok(app) => app,
        Err(e) => return s.fail(azure_problem("identity", &t!("team.actions.createDeployIdentity"), &e, Some(note.clone()))),
      },
    };
    s.state.app_id = Some(registration.app_id);
    s.state.app_object_id = Some(registration.object_id);
    s.save();
  }
  let app_id = s.state.app_id.clone().unwrap_or_default();
  let app_object_id = s.state.app_object_id.clone().unwrap_or_default();
  if s.state.sp_object_id.is_none() {
    match entra::ensure_service_principal(&app_id).await {
      Ok(id) => s.state.sp_object_id = Some(id),
      Err(e) => return s.fail(azure_problem("identity", &t!("team.actions.createSp"), &e, Some(note.clone()))),
    }
    s.save();
  }
  let sp_id = s.state.sp_object_id.clone().unwrap_or_default();
  if separate {
    if s.state.preview_app_id.is_none() || s.state.preview_app_object_id.is_none() {
      match entra::create_app(&preview_display).await {
        Ok(app) => {
          s.state.preview_app_id = Some(app.app_id);
          s.state.preview_app_object_id = Some(app.object_id);
        }
        Err(e) => return s.fail(azure_problem("identity", &t!("team.actions.createPreviewIdentity"), &e, Some(note.clone()))),
      }
      s.save();
    }
    if s.state.preview_sp_object_id.is_none() {
      let preview_app = s.state.preview_app_id.clone().unwrap_or_default();
      match entra::ensure_service_principal(&preview_app).await {
        Ok(id) => s.state.preview_sp_object_id = Some(id),
        Err(e) => return s.fail(azure_problem("identity", &t!("team.actions.createPreviewSp"), &e, Some(note.clone()))),
      }
    }
  }
  s.finish("identity");
  let (preview_app_id, preview_app_object_id, preview_sp_id) = if separate {
    (
      s.state.preview_app_id.clone().unwrap_or_default(),
      s.state.preview_app_object_id.clone().unwrap_or_default(),
      s.state.preview_sp_object_id.clone().unwrap_or_default(),
    )
  } else {
    (app_id.clone(), app_object_id.clone(), sp_id.clone())
  };

  // 4. Trust the repository's pipeline (GitHub OIDC; no secrets).
  s.start("trust");
  if let Err(e) = entra::ensure_federated_credentials(&app_object_id, &deploy_subjects).await {
    return s.fail(azure_problem("trust", &t!("team.actions.trustPipeline"), &e, Some(note.clone())));
  }
  if separate {
    if let Err(e) = entra::ensure_federated_credentials(&preview_app_object_id, &preview_subjects).await {
      return s.fail(azure_problem("trust", &t!("team.actions.trustPrs"), &e, Some(note.clone())));
    }
  }
  s.finish("trust");

  // 5. Fabric access: published apps for the deploy identity, previews for the
  // preview identity.
  s.start("access");
  for (ws_id, principal) in [(&prod_ws, &sp_id), (&preview_ws, &preview_sp_id)] {
    if let Err(e) = fabric::add_role(ws_id, principal, "ServicePrincipal", "Contributor").await {
      return s.fail(fabric_problem("access", &t!("team.actions.grantIdentities"), &e));
    }
  }
  s.finish("access");

  // 6. Pipeline settings, manifest and workflow.
  s.start("files");
  let manifest = TeamManifest {
    schema: 1,
    name: name.clone(),
    tenant_id: tenant.clone(),
    deploy_identity: TeamDeployIdentity { client_id: app_id.clone(), display_name: display.clone() },
    preview_identity: if separate {
      TeamDeployIdentity { client_id: preview_app_id.clone(), display_name: preview_display.clone() }
    } else {
      TeamDeployIdentity::default()
    },
    fabric: TeamFabricTargets {
      production: TeamFabricWorkspace { id: prod_ws.clone(), name: name.clone() },
      previews: TeamFabricWorkspace { id: preview_ws.clone(), name: format!("{name} previews") },
    },
    settings: TeamSettings::default(),
    template_version: templates::TEMPLATE_VERSION,
  };
  for (var, value) in [
    ("AZURE_CLIENT_ID", app_id.as_str()),
    ("AZURE_PREVIEW_CLIENT_ID", preview_app_id.as_str()),
    ("AZURE_TENANT_ID", tenant.as_str()),
    ("FABRIC_WORKSPACE_ID", prod_ws.as_str()),
    ("FABRIC_PREVIEW_WORKSPACE_ID", preview_ws.as_str()),
  ] {
    if let Err(e) = gh::set_variable(&info.full_name, var, value).await {
      let p = github_problem("files", &t!("team.actions.configurePipeline"), &e);
      return s.fail(or_locked(p, &info.full_name, &me.login).await);
    }
  }
  // Where the jobs run, when the owner chose (no choice leaves the organization's).
  if let Some(runner) = &req.runner {
    let saved = match templates::runs_on_value(runner) {
      Some(value) => gh::set_variable(&info.full_name, templates::RUNS_ON_VARIABLE, &value).await,
      None => gh::delete_variable(&info.full_name, templates::RUNS_ON_VARIABLE).await,
    };
    if let Err(e) = saved {
      let p = github_problem("files", &t!("team.actions.chooseRunner"), &e);
      return s.fail(or_locked(p, &info.full_name, &me.login).await);
    }
  }
  if !s.done("files") {
    let files = vec![
      ("README.md".to_string(), templates::readme(&name)),
      (".gitignore".to_string(), templates::gitignore().to_string()),
      (naming::MANIFEST_FILE.to_string(), templates::manifest_json(&manifest)),
      (naming::WORKFLOW_PATH.to_string(), templates::workflow()),
    ];
    if let Err(p) = write_files(&info.full_name, &files, &git_name, &git_email).await {
      return s.fail(or_locked(p, &info.full_name, &me.login).await);
    }
  }
  s.ws.name = name.clone();
  s.ws.manifest = Some(manifest.clone());
  s.finish("files");

  // 7. Ask GitHub to require pull requests into main (paid plans, admins only).
  s.start("protection");
  let (protection, protection_note) = match gh::protect_main(&info.full_name, false).await {
    Ok(true) => ("enforced", None),
    Ok(false) => ("app", Some(t!("team.setup.protection.plan"))),
    Err(e) => {
      log::warn!("couldn't protect main on {}: {}", info.full_name, e.message);
      ("app", Some(if info.admin { t!("team.setup.protection.unprotected") } else { t!("team.setup.protection.adminOnly") }))
    }
  };
  s.state.protection = Some(protection.into());
  progress(app, &s.scope, "protection", "done", &label("protection"), protection_note);
  if !s.done("protection") {
    s.state.completed.push("protection".into());
  }
  s.save();

  // 8. Local clone.
  s.start("clone");
  if let Err(e) = repo::ensure_clone(&s.ws, None).await {
    return s.fail(problem("clone", e));
  }
  if let Err(e) = repo::set_identity(&s.ws, &git_name, &git_email).await {
    return s.fail(problem("clone", e));
  }
  s.finish("clone");

  // 9. Prove the pipeline can sign in and reach both workspaces.
  s.start("verify");
  if let Err(p) = verify_pipeline(app, &s.scope, &info.full_name, cancel).await {
    return s.fail(p);
  }
  s.finish("verify");
  s.state.done = true;
  s.save();
  super::with_workspace(s.ws)
}

/// The repository someone created for the workspace, when setup can use it.
/// An invitation to it waiting for this account is accepted.
async fn adopt_repo(full_name: &str, login: &str) -> Result<gh::RepoInfo, TeamProblem> {
  let open = |e: &gh::GhError| github_problem("github", &t!("team.actions.openNamedRepo", repo = full_name), e);
  let info = match gh::repo(full_name).await {
    Ok(info) => info,
    Err(e) if e.is_not_found() => match super::join::accept_pending_invitation(full_name).await {
      Ok(true) => gh::repo(full_name).await.map_err(|e| open(&e))?,
      Ok(false) => {
        let mut p = problem("github", t!("team.setup.repoHidden", repo = full_name, login = login));
        p.guidance = Some(t!("team.setup.repoHiddenHint", login = login));
        return Err(p);
      }
      Err(e) => return Err(github_problem("github", &t!("team.actions.acceptInvitationTo", repo = full_name), &e)),
    },
    Err(e) => return Err(open(&e)),
  };
  let has_commits = gh::has_commits(&info.full_name).await.map_err(|e| open(&e))?;
  let is_workspace = has_commits
    && gh::main_file(&info.full_name, naming::MANIFEST_FILE).await.map_err(|e| open(&e))?.is_some();
  match adoption_problem(&info, login, has_commits, is_workspace) {
    Some(p) => Err(p),
    None => Ok(info),
  }
}

/// Why setup can't use an existing repository, or `None` when it can.
fn adoption_problem(info: &gh::RepoInfo, login: &str, has_commits: bool, is_workspace: bool) -> Option<TeamProblem> {
  let repo = &info.full_name;
  let owner = repo.split('/').next().unwrap_or_default();
  let (message, guidance) = if info.archived {
    (t!("team.setup.adopt.archived", repo = repo), t!("team.setup.adopt.archivedHint"))
  } else if let Some(p) = locked_problem("github", info, login) {
    return Some(p);
  } else if !info.manages() {
    (
      t!("team.setup.adopt.needsRole", login = login, repo = repo),
      t!("team.setup.adopt.needsRoleHint", owner = owner, login = login),
    )
  } else if !info.private {
    (t!("team.setup.adopt.public", repo = repo), t!("team.setup.adopt.publicHint"))
  } else if is_workspace {
    (t!("team.setup.adopt.alreadyWorkspace", repo = repo), t!("team.setup.adopt.alreadyWorkspaceHint"))
  } else if has_commits && info.default_branch != naming::DEFAULT_BRANCH {
    (
      t!("team.setup.adopt.defaultBranch", repo = repo, branch = info.default_branch),
      t!("team.setup.adopt.defaultBranchHint"),
    )
  } else {
    return None;
  };
  let mut p = problem("github", message);
  p.guidance = Some(guidance);
  Some(p)
}

/// Why `login` can't change `info` when its organization locked it until it's
/// set up in the organization's portal (it locks new repositories, even ones
/// setup just created), with the link to finish.
fn locked_problem(step: &str, info: &gh::RepoInfo, login: &str) -> Option<TeamProblem> {
  if info.manages() || !info.awaiting_setup() {
    return None;
  }
  let repo = &info.full_name;
  let owner = repo.split('/').next().unwrap_or_default();
  let mut p = problem(step, t!("team.setup.locked.message", owner = owner, repo = repo, login = login));
  p.link = info.setup_url().map(|url| TeamLink { label: t!("team.setup.locked.link"), url });
  p.guidance = Some(if p.link.is_some() {
    t!("team.setup.locked.hintLink", login = login)
  } else {
    t!("team.setup.locked.hint", login = login)
  });
  Some(p)
}

/// `p`, unless GitHub refused because the repository's organization locked it
/// until it's set up (which can happen after setup created it).
async fn or_locked(p: TeamProblem, repo: &str, login: &str) -> TeamProblem {
  match gh::repo(repo).await {
    Ok(info) => locked_problem(&p.step, &info, login).unwrap_or(p),
    Err(_) => p,
  }
}

/// Put the workspace's files on `main`: the first commit of an empty
/// repository, or a commit for each file that differs in one with commits (an
/// existing repository, or a retry after the first push).
async fn write_files(repo: &str, files: &[(String, String)], git_name: &str, git_email: &str) -> Result<(), TeamProblem> {
  let has_commits = gh::has_commits(repo).await.map_err(|e| github_problem("files", &t!("team.actions.checkRepo"), &e))?;
  if !has_commits {
    let Err(e) = repo::seed_repository(repo, files, git_name, git_email).await else {
      return Ok(());
    };
    let lower = e.to_ascii_lowercase();
    // Someone else pushed first: add the files on top of their commit instead.
    let raced = lower.contains("rejected") || lower.contains("fetch first") || lower.contains("non-fast-forward");
    if !raced {
      let mut p = problem("files", e.clone());
      if lower.contains("workflow") {
        p.guidance = Some(t!("team.setup.workflowPermission"));
      }
      return Err(p);
    }
  }
  for (path, content) in files {
    let existing = gh::main_file(repo, path).await.map_err(|e| github_problem("files", &t!("team.actions.checkRepo"), &e))?;
    let Some(content) = merged_file(path, content, existing.as_ref().map(|(text, _)| text.as_str())) else {
      continue;
    };
    if let Err(e) = gh::put_main_file(repo, path, &content, "Set up Fabricator team workspace").await {
      return Err(github_problem("files", &t!("team.actions.addFile", path = path), &e));
    }
  }
  Ok(())
}

/// What to write to `path` in a repository that already has `existing`, or
/// `None` to leave it: a repository's own README stays, and its `.gitignore`
/// only gains the lines it's missing. Fabricator's own files are replaced.
fn merged_file(path: &str, ours: &str, existing: Option<&str>) -> Option<String> {
  let Some(existing) = existing.filter(|text| !text.trim().is_empty()) else {
    return Some(ours.to_string());
  };
  match path {
    "README.md" => None,
    ".gitignore" => {
      let have: Vec<&str> = existing.lines().map(str::trim).collect();
      let missing: Vec<&str> = ours.lines().filter(|line| !have.contains(&line.trim())).collect();
      if missing.is_empty() {
        return None;
      }
      let mut text = existing.to_string();
      if !text.ends_with('\n') {
        text.push('\n');
      }
      for line in missing {
        text.push_str(line);
        text.push('\n');
      }
      Some(text)
    }
    _ => Some(ours.to_string()),
  }
}

static ENTERPRISE_CLAIM_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)must contain the enterprise claim with value (.+?) but actual value is '([^']*)'").unwrap());
static QUOTED_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"'([^']+)'").unwrap());

/// When Microsoft Entra ID refused the pipeline's sign-in because the tenant
/// only trusts GitHub Actions from some GitHub enterprises (AADSTS7002381):
/// (the enterprises it trusts, the repository's own enterprise, if any).
fn enterprise_restriction(log: &str) -> Option<(Vec<String>, String)> {
  if let Some(caps) = ENTERPRISE_CLAIM_RE.captures(log) {
    let allowed = QUOTED_RE.captures_iter(&caps[1]).map(|c| c[1].to_string()).collect();
    return Some((allowed, caps[2].trim().to_string()));
  }
  log.to_ascii_lowercase().contains("aadsts7002381").then(|| (Vec::new(), String::new()))
}

/// "a", "a or b", "a, b or c".
fn either(names: &[String]) -> String {
  match names {
    [] => String::new(),
    [one] => one.clone(),
    [rest @ .., last] => t!("team.setup.verify.either", rest = rest.join(", "), last = last),
  }
}

/// Explain a failed verification run. Returns (problem, worth retrying).
fn verify_problem(log: &str, url: &str, repo: &str) -> (TeamProblem, bool) {
  let lower = log.to_ascii_lowercase();
  if let Some((allowed, actual)) = enterprise_restriction(log) {
    let message = match (allowed.is_empty(), actual.is_empty()) {
      (true, true) => t!("team.setup.verify.enterprise.someNotIn", repo = repo),
      (true, false) => t!("team.setup.verify.enterprise.someIn", repo = repo, enterprise = actual),
      (false, true) => t!("team.setup.verify.enterprise.listNotIn", enterprises = either(&allowed), repo = repo),
      (false, false) => t!("team.setup.verify.enterprise.listIn", enterprises = either(&allowed), repo = repo, enterprise = actual),
    };
    let mut p = problem("verify", message);
    p.guidance = Some(t!("team.setup.verify.enterprise.hint"));
    return (p, false);
  }
  if ["aadsts70021", "no matching federated identity record", "aadsts700016", "aadsts700213", "aadsts70025"].iter().any(|k| lower.contains(k)) {
    let mut p = problem("verify", t!("team.setup.verify.notAccepted"));
    p.guidance = Some(t!("team.setup.verify.notAcceptedHint"));
    return (p, true);
  }
  // The workflow's own messages when the runner's network blocks a sign-in or Fabric.
  if ["couldn't get an oidc token from github", "couldn't reach microsoft entra id", "couldn't reach microsoft fabric"].iter().any(|k| lower.contains(k)) {
    let mut p = problem("verify", t!("team.setup.verify.unreachable"));
    p.guidance = Some(t!("team.setup.verify.unreachableHint"));
    p.kind = Some("runner".into());
    return (p, false);
  }
  if lower.contains("returned http 401") || lower.contains("returned http 403") {
    let mut p = problem("verify", t!("team.setup.verify.refused"));
    p.guidance = Some(t!("team.setup.verify.refusedHint"));
    p.admin_note = Some(FABRIC_SP_NOTE.into());
    return (p, false);
  }
  if lower.contains("returned http 404") {
    let mut p = problem("verify", t!("team.setup.verify.cantSee"));
    p.guidance = Some(t!("team.setup.verify.cantSeeHint"));
    return (p, false);
  }
  let mut p = problem("verify", t!("team.setup.verify.failed"));
  p.guidance = Some(t!("team.setup.verify.failedHint", url = url));
  (p, false)
}

/// Dispatch the workflow's `verify` action and wait for it.
pub(crate) async fn verify_pipeline(app: &AppHandle, scope: &str, full_name: &str, cancel: &CancelToken) -> Result<(), TeamProblem> {
  for attempt in 0..2 {
    let since = chrono::Utc::now() - chrono::Duration::seconds(20);
    // A just-pushed workflow takes a moment before it can be dispatched.
    let mut dispatched = false;
    for _ in 0..10 {
      match gh::dispatch(full_name, json!({ "action": "verify" })).await {
        Ok(()) => {
          dispatched = true;
          break;
        }
        Err(e) if e.is_not_found() || e.status == Some(422) => {
          if sleep_or_cancel(8_000, cancel).await {
            return Err(problem("verify", cancelled()));
          }
        }
        Err(e) => return Err(problem("verify", e.describe(&t!("team.actions.startVerification")))),
      }
    }
    if !dispatched {
      return Err(problem("verify", t!("team.setup.verify.notDispatched")));
    }
    let mut run = None;
    for _ in 0..30 {
      if let Ok(runs) = gh::dispatch_runs(full_name).await {
        run = runs.into_iter().find(|r| {
          r.created_at
            .as_deref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| t >= since)
        });
      }
      if run.is_some() {
        break;
      }
      if sleep_or_cancel(4_000, cancel).await {
        return Err(problem("verify", cancelled()));
      }
    }
    let Some(run) = run else {
      return Err(problem("verify", t!("team.setup.verify.notStarted")));
    };
    let finished = match finish_verification(app, scope, full_name, run, cancel).await? {
      Verification::Finished(run) => run,
      Verification::Stuck(run) => {
        // Don't leave it queued for GitHub's 24 hours.
        if let Err(e) = gh::cancel_run(full_name, run.id).await {
          log::warn!("couldn't cancel the waiting verification run {} on {full_name}: {}", run.id, e.message);
        }
        return Err(runner_problem(full_name, NoRunner::Waited));
      }
    };
    if finished.conclusion.as_deref() == Some("success") {
      return Ok(());
    }
    // A job GitHub never started has no log; its annotations say why.
    if let Some(reason) = gh::unstarted_reason(full_name, finished.id).await {
      return Err(runner_problem(full_name, NoRunner::Refused(reason)));
    }
    // A runner setting `runs-on` can't use fails the run without listing the job.
    if let Some(value) = unusable_runs_on(full_name).await {
      return Err(runner_problem(full_name, NoRunner::Invalid(value)));
    }
    let log = gh::run_log(full_name, finished.id, 8_000).await.unwrap_or_default();
    let (p, retry) = verify_problem(&log, &finished.url, full_name);
    if retry && attempt == 0 {
      progress(app, scope, "verify", "running", &label("verify"), Some(t!("team.setup.verify.waitingForTrust")));
      if sleep_or_cancel(45_000, cancel).await {
        return Err(problem("verify", cancelled()));
      }
      continue;
    }
    return Err(p);
  }
  Err(problem("verify", t!("team.setup.verify.failed")))
}

/// How long the verification run may wait for a runner before setup says
/// none is available. GitHub-hosted runners usually start within a minute.
pub(crate) const RUNNER_WAIT: Duration = Duration::from_secs(6 * 60);

enum Verification {
  Finished(gh::Run),
  /// No runner picked the run up within [`RUNNER_WAIT`].
  Stuck(gh::Run),
}

/// Poll the verification run until it completes (up to 40 minutes), or until
/// it has waited [`RUNNER_WAIT`] for a runner.
async fn finish_verification(
  app: &AppHandle,
  scope: &str,
  full_name: &str,
  mut run: gh::Run,
  cancel: &CancelToken,
) -> Result<Verification, TeamProblem> {
  let mut waiting_since: Option<Instant> = None;
  for _ in 0..400 {
    if run.status == "completed" {
      return Ok(Verification::Finished(run));
    }
    let waiting = match gh::run_jobs(full_name, run.id).await {
      Ok(jobs) => waiting_for_runner(&run.status, &jobs),
      Err(_) => waiting_since.is_some(),
    };
    let detail = if waiting {
      let since = *waiting_since.get_or_insert_with(Instant::now);
      if since.elapsed() >= RUNNER_WAIT {
        return Ok(Verification::Stuck(run));
      }
      t!("team.setup.verify.waitingForRunner")
    } else {
      waiting_since = None;
      run_status(&run.status)
    };
    progress(app, scope, "verify", "running", &label("verify"), Some(detail));
    if sleep_or_cancel(6_000, cancel).await {
      return Err(problem("verify", cancelled()));
    }
    if let Ok(next) = gh::run(full_name, run.id).await {
      run = next;
    }
  }
  Err(problem("verify", t!("team.runTooLong", url = run.url)))
}

fn job_str<'a>(job: &'a Value, key: &str) -> Option<&'a str> {
  job.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Whether a run waits for a runner: no job is running and one is queued
/// without a runner (or GitHub hasn't listed a queued run's jobs yet).
fn waiting_for_runner(run_status: &str, jobs: &[Value]) -> bool {
  if jobs.is_empty() {
    return run_status == "queued";
  }
  fn status(job: &Value) -> &str {
    job_str(job, "status").unwrap_or_default()
  }
  !jobs.iter().any(|job| status(job) == "in_progress")
    && jobs.iter().any(|job| status(job) == "queued" && job_str(job, "runner_name").is_none())
}

/// Why no runner ran the verification.
enum NoRunner {
  /// It waited [`RUNNER_WAIT`] for one.
  Waited,
  /// GitHub failed it before it started, with GitHub's reason (empty when it gave none).
  Refused(String),
  /// The runner setting the pipeline uses, which `runs-on` can't use.
  Invalid(String),
}

/// The `FABRICATOR_RUNS_ON` value the pipeline uses (the repository's, else
/// the organization's) when `runs-on` can't use it.
async fn unusable_runs_on(repo: &str) -> Option<String> {
  let value = match gh::variable(repo, templates::RUNS_ON_VARIABLE).await {
    Ok(Some(value)) => value,
    Ok(None) => gh::organization_variable(repo, templates::RUNS_ON_VARIABLE).await.ok().flatten()?,
    Err(_) => return None,
  };
  templates::parse_runs_on(&value).is_none().then_some(value)
}

/// No runner ran the verification: GitHub-hosted runners may be turned off for
/// the repository, or the runners it asks for are busy, offline or not allowed.
fn runner_problem(repo: &str, why: NoRunner) -> TeamProblem {
  let mut p = match why {
    NoRunner::Waited => {
      let mut p = problem("verify", t!("team.setup.runner.waited", minutes = RUNNER_WAIT.as_secs() / 60));
      p.guidance = Some(t!("team.setup.runner.waitedHint"));
      p
    }
    NoRunner::Refused(reason) => {
      let reason: String = reason.trim().chars().take(400).collect();
      let mut p = problem(
        "verify",
        if reason.is_empty() { t!("team.setup.runner.refused") } else { t!("team.setup.runner.refusedWith", reason = reason) },
      );
      p.guidance = Some(t!("team.setup.runner.refusedHint"));
      p
    }
    NoRunner::Invalid(value) => {
      let value: String = value.trim().chars().take(200).collect();
      let mut p = problem("verify", t!("team.setup.runner.invalid", variable = templates::RUNS_ON_VARIABLE, value = value));
      p.guidance = Some(t!("team.setup.runner.invalidHint"));
      p
    }
  };
  p.kind = Some("runner".into());
  p.admin_note = Some(runner_admin_note(repo));
  p
}

/// What a GitHub organization owner can do when no runner runs the pipeline.
pub(crate) fn runner_admin_note(repo: &str) -> String {
  format!(
    "Fabricator's deploy pipeline in the GitHub repository {repo} needs GitHub Actions runners. Please tell me which runner group (or runner labels) its jobs should use, and let the repository use that runner group (organization Settings → Actions → Runner groups → the group → Repository access). The runners need Linux with bash, curl and git, and outbound access to GitHub, the npm registry, Microsoft Entra ID (login.microsoftonline.com) and Microsoft Fabric (api.fabric.microsoft.com). To choose the runners for every Fabricator workspace in the organization at once, add an organization Actions variable named {} with the runner group as JSON, for example {{\"group\":\"<runner group>\"}}.",
    templates::RUNS_ON_VARIABLE
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn every_step_has_a_label() {
    let ids: Vec<&str> = SETUP_STEPS.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids, vec!["github", "fabric", "identity", "trust", "access", "files", "protection", "clone", "verify"]);
    assert_eq!(label("trust"), "Let the repository's pipeline sign in as those identities");
    for (id, english) in SETUP_STEPS {
      assert_eq!(label(id), *english, "the app's label for {id} matches the one Copilot reads");
    }
  }

  #[test]
  fn verification_failures_are_explained() {
    let verify = |log: &str, url: &str| verify_problem(log, url, "o/r");
    let (p, retry) = verify("Error: AADSTS70021: No matching federated identity record found", "u");
    assert!(retry && p.message.contains("didn't accept"));
    let (p, retry) = verify("::error title=Fabric access::Workspace x returned HTTP 403: {}", "u");
    assert!(!retry && p.admin_note.unwrap().contains("Service principals can call Fabric public APIs"));
    let (p, _) = verify("Workspace x returned HTTP 404", "u");
    assert!(p.guidance.unwrap().contains("Repair"));
    let (p, _) = verify("boom", "https://github.com/o/r/actions/runs/1");
    assert!(p.guidance.unwrap().ends_with("/runs/1"));
    let (p, retry) = verify("##[error]Couldn't reach Microsoft Entra ID (login.microsoftonline.com) from this runner.", "u");
    assert!(!retry && p.kind.as_deref() == Some("runner") && p.guidance.unwrap().contains("Where the pipeline runs"));
    // As a real runner logged it for an identity without federated credentials (yet).
    let (p, retry) = verify(
      "##[error]Microsoft Entra ID didn't sign in 00000000-0000-0000-0000-00000000f00d: AADSTS70025: The client '00000000-0000-0000-0000-00000000f00d'() has no configured federated identity credentials. Trace ID: x",
      "u",
    );
    assert!(retry && p.message.contains("didn't accept"));
  }

  #[test]
  fn tenants_that_only_trust_some_github_enterprises_are_explained() {
    // As a self-hosted runner logged it for a repository owned by a personal account.
    let log = "##[error]Microsoft Entra ID didn't sign in 8898913a-0798-43d0-bfae-0acc43189713: AADSTS7002381: Federated identity credentials issued by 'https://token.actions.githubusercontent.com/' for applications or managed identities registered in this tenant must contain the enterprise claim with value 'microsoft', 'github' or 'microsoftopensource' but actual value is ''. Trace ID: 2726d5f4";
    let (p, retry) = verify_problem(log, "u", "sapatney_microsoft/rayfinteamapps");
    assert!(!retry, "trying again can't change the repository's owner");
    assert_eq!(
      p.message,
      "Your Microsoft Entra ID only accepts the pipeline's sign-in from repositories owned by organizations in the GitHub enterprises microsoft, github or microsoftopensource, and sapatney_microsoft/rayfinteamapps isn't in one."
    );
    let guidance = p.guidance.unwrap();
    assert!(guidance.contains("Abandon setup…") && guidance.contains("Existing repository"), "{guidance}");
    let other = log.replace("actual value is ''", "actual value is 'contoso'");
    assert!(verify_problem(&other, "u", "c/r").0.message.ends_with("and c/r is in the enterprise contoso."));
    let (p, _) = verify_problem("Error: AADSTS7002381: something new", "u", "o/r");
    assert!(p.message.contains("organizations in certain GitHub enterprises"), "{}", p.message);
    assert_eq!(either(&["a".into()]), "a");
    assert_eq!(either(&["a".into(), "b".into()]), "a or b");
  }

  #[test]
  fn existing_repositories_are_checked_before_setup_uses_them() {
    let repo = |over: serde_json::Value| {
      let mut v = json!({
        "full_name": "azure-data/sales-apps", "private": true, "default_branch": "main",
        "permissions": { "admin": true, "push": true }, "description": null
      });
      for (k, value) in over.as_object().unwrap() {
        v[k] = value.clone();
      }
      gh::repo_info(&v).unwrap()
    };
    let check = |info: &gh::RepoInfo, has_commits: bool, is_workspace: bool| {
      adoption_problem(info, "amy_contoso", has_commits, is_workspace).map(|p| (p.message, p.guidance.unwrap_or_default()))
    };
    assert_eq!(check(&repo(json!({})), false, false), None, "an empty private repository with Admin");
    assert_eq!(check(&repo(json!({ "visibility": "internal" })), true, false), None, "internal repositories report private");
    // Maintain covers what setup changes; GitHub keeps only branch protection for admins, which setup leaves to Fabricator.
    let maintain = json!({ "permissions": { "admin": false, "maintain": true, "push": true, "triage": true, "pull": true } });
    assert_eq!(check(&repo(maintain), true, false), None, "the Maintain role is enough");
    let (message, guidance) = check(&repo(json!({ "permissions": { "admin": false, "push": true } })), false, false).unwrap();
    assert_eq!(message, "amy_contoso needs the Maintain or Admin role on azure-data/sales-apps to set up a workspace in it.");
    assert!(guidance.contains("Ask an owner of azure-data, or an admin of the repository, to give amy_contoso the Maintain role"));
    assert!(check(&repo(json!({ "private": false })), false, false).unwrap().0.ends_with("is public."));
    assert!(check(&repo(json!({ "archived": true })), false, false).unwrap().0.ends_with("is archived."));
    assert!(check(&repo(json!({})), true, true).unwrap().1.contains("select Join"));
    let (message, _) = check(&repo(json!({ "default_branch": "master" })), true, false).unwrap();
    assert_eq!(message, "azure-data/sales-apps's default branch is master.");
    // An empty repository gets main from setup's first push.
    assert_eq!(check(&repo(json!({ "default_branch": "master" })), false, false), None);
  }

  #[test]
  fn a_repository_locked_until_its_organization_sets_it_up_links_to_the_portal() {
    let wizard = "https://repos.opensource.microsoft.com/microsoft/wizard?existingreponame=rayfin-team-apps&existingrepoid=1406546045";
    let locked = gh::repo_info(&json!({
      "full_name": "microsoft/rayfin-team-apps", "private": true, "default_branch": "main",
      "permissions": { "admin": false, "push": false, "pull": true },
      "description": "To gain access, please finish setting up this repository now at: ", "homepage": wizard
    }))
    .unwrap();
    let p = adoption_problem(&locked, "amy_contoso", true, false).unwrap();
    assert_eq!(p.step, "github");
    assert_eq!(
      p.message,
      "microsoft locked microsoft/rayfin-team-apps until it's set up in the organization's portal, so amy_contoso can't change it yet."
    );
    let link = p.link.unwrap();
    assert_eq!((link.label.as_str(), link.url.as_str()), ("Finish setting up the repository", wizard));
    assert!(p.guidance.unwrap().contains("Setup needs amy_contoso to have the Maintain or Admin role"));
    // After setup there (or for someone with Maintain or Admin), it's an ordinary repository.
    for unlocked in [gh::RepoInfo { admin: true, ..locked.clone() }, gh::RepoInfo { maintain: true, push: true, ..locked.clone() }] {
      assert!(locked_problem("files", &unlocked, "amy_contoso").is_none());
    }
    let mid_setup = locked_problem("files", &locked, "amy_contoso").unwrap();
    assert_eq!(mid_setup.step, "files", "a repository setup just created can be locked by the time files are written");
    // Without an address, the description says where.
    let no_link = gh::RepoInfo { homepage: None, ..locked };
    let p = locked_problem("github", &no_link, "amy_contoso").unwrap();
    assert!(p.link.is_none());
    assert!(p.guidance.unwrap().starts_with("Finish setting it up as its description on GitHub says, then try again."));
  }

  #[test]
  fn an_existing_repositorys_own_files_are_kept() {
    let ours = "node_modules/\n.DS_Store\n";
    assert_eq!(merged_file(".gitignore", ours, None).as_deref(), Some(ours));
    assert_eq!(merged_file(".gitignore", ours, Some("  \n")).as_deref(), Some(ours));
    assert_eq!(merged_file(".gitignore", ours, Some("*.log\nnode_modules/")).as_deref(), Some("*.log\nnode_modules/\n.DS_Store\n"));
    assert_eq!(merged_file(".gitignore", ours, Some("node_modules/\n.DS_Store\n*.log\n")), None);
    assert_eq!(merged_file("README.md", "# Ours\n", Some("# Sales apps\n")), None);
    assert_eq!(merged_file("README.md", "# Ours\n", None).as_deref(), Some("# Ours\n"));
    // Fabricator's own files always match the workspace.
    assert_eq!(merged_file(naming::MANIFEST_FILE, "{}\n", Some("{\"old\":1}\n")).as_deref(), Some("{}\n"));
  }

  #[test]
  fn a_run_waits_for_a_runner_until_a_job_starts() {
    let job = |status: &str, runner: Option<&str>| json!({ "status": status, "runner_name": runner, "steps": [] });
    assert!(waiting_for_runner("queued", &[]));
    assert!(!waiting_for_runner("in_progress", &[]));
    assert!(waiting_for_runner("queued", &[job("queued", None)]));
    // GitHub reports an empty runner name before it assigns one.
    assert!(waiting_for_runner("queued", &[job("queued", Some(""))]));
    assert!(!waiting_for_runner("queued", &[job("queued", Some("GitHub Actions 2"))]));
    assert!(!waiting_for_runner("in_progress", &[job("in_progress", Some("r")), job("queued", None)]));
    // Plan finished and Verify waits for its own runner.
    assert!(waiting_for_runner("in_progress", &[job("completed", Some("r")), job("queued", None)]));
    assert!(!waiting_for_runner("in_progress", &[job("completed", Some("r"))]));
  }

  #[test]
  fn runner_problems_offer_a_choice_and_admin_steps() {
    let p = runner_problem("o/r", NoRunner::Waited);
    assert_eq!(p.step, "verify");
    assert_eq!(p.kind.as_deref(), Some("runner"));
    assert!(p.message.contains("No runner picked up") && p.message.contains("6 minutes"), "{}", p.message);
    assert!(p.guidance.as_deref().unwrap().contains("Where the pipeline runs"));
    let note = p.admin_note.unwrap();
    assert!(note.contains("o/r") && note.contains("Runner groups") && note.contains(r#"FABRICATOR_RUNS_ON"#));
    assert!(note.contains(r#"{"group":"<runner group>"}"#));
    // What GitHub said when an enterprise turned hosted runners off.
    let reason = "  GitHub Actions hosted runners are disabled for this repository. For more information please contact your GitHub Enterprise Administrator.  ";
    let p = runner_problem("o/r", NoRunner::Refused(reason.into()));
    assert_eq!(
      p.message,
      "GitHub didn't start the pipeline's verification run: GitHub Actions hosted runners are disabled for this repository. For more information please contact your GitHub Enterprise Administrator."
    );
    assert_eq!(p.kind.as_deref(), Some("runner"));
    assert!(p.guidance.unwrap().contains("Where the pipeline runs"));
    assert_eq!(runner_problem("o/r", NoRunner::Refused(" ".into())).message, "GitHub didn't start the pipeline's verification run.");
    let p = runner_problem("o/r", NoRunner::Invalid("contoso-runners".into()));
    assert_eq!(p.message, "GitHub can't use the pipeline's runner setting: FABRICATOR_RUNS_ON is contoso-runners.");
    assert_eq!(p.kind.as_deref(), Some("runner"));
  }
}
