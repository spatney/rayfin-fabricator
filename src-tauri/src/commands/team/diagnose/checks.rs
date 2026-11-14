//! The read-only checks a team diagnosis runs: GitHub, Microsoft Entra ID and
//! Fabric reads with the user's own `gh`/`az` sign-ins, plus local facts. Each
//! check is a GET against a fixed endpoint, can only target this context's
//! repository, identities, Fabric workspaces and runs, and masks secrets in its
//! result, which is sent to Copilot and shown under "Details sent to Copilot".

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use futures::future::join_all;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use super::{DiagContext, FabricTarget, Identity, Kind};
use crate::commands::advisor::mask_secrets;
use crate::services::exec::{self, CancelToken, RunOptions};
use crate::services::team::{self, entra, fabric, gh, naming, templates};
use crate::types::{TeamDiagnosisCheck, TeamDiagnosisEvent};

/// Delivers a diagnosis event to the renderer.
pub type Emit = Arc<dyn Fn(TeamDiagnosisEvent) + Send + Sync>;

const CHECK_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_DETAIL: usize = 5_000;
const MAX_LOG: usize = 12_000;
/// Checks Copilot may ask for in one diagnosis (one call can cover several targets).
pub const MAX_REQUESTED: usize = 16;
/// Microsoft Entra ID's limit on federated credentials per app registration.
const MAX_FEDERATED: usize = 20;

const VARIABLES: &[&str] =
  &["AZURE_CLIENT_ID", "AZURE_PREVIEW_CLIENT_ID", "AZURE_TENANT_ID", "FABRIC_WORKSPACE_ID", "FABRIC_PREVIEW_WORKSPACE_ID"];

/* --------------------------------- catalog -------------------------------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Check {
  GithubAccount,
  GithubRepo,
  GithubOrg,
  GithubActionsPolicy,
  GithubBranchRules,
  GithubOidcSubject,
  GithubVariables,
  GithubWorkflow,
  GithubRuns,
  GithubRun,
  GithubRunLog,
  GithubInvitations,
  AzureAccount,
  EntraAppPolicy,
  EntraMyRoles,
  EntraApp,
  EntraFederatedCredentials,
  FabricCapacities,
  FabricWorkspace,
  FabricTenantSettings,
  LocalTools,
  ProjectRayfin,
}

/// (check, name, what it reads): the names Copilot asks for, and the
/// descriptions its prompt and tool list.
const CATALOG: &[(Check, &str, &str)] = &[
  (Check::GithubAccount, "github_account", "The signed-in GitHub account and the GitHub CLI token's scopes."),
  (Check::GithubRepo, "github_repo", "The repository: visibility, owner, your permission, archived or disabled."),
  (Check::GithubOrg, "github_org", "Your role in the GitHub organization that owns the repository, and the organization settings you can see."),
  (Check::GithubActionsPolicy, "github_actions_policy", "Whether GitHub Actions is on for the repository, which actions may run (and whether each action the workflow uses may), SHA pinning, and default workflow token permissions."),
  (Check::GithubBranchRules, "github_branch_rules", "Rulesets and branch protection on main, which can block Fabricator's writes to main."),
  (Check::GithubOidcSubject, "github_oidc_subject", "Whether the repository or organization customizes the OIDC subject claim the pipeline presents."),
  (Check::GithubVariables, "github_variables", "The pipeline's Actions variables: client, tenant and Fabric workspace IDs, and the runners its jobs ask for, from the repository or the organization (owners only)."),
  (Check::GithubWorkflow, "github_workflow", "Whether the workflow file on main matches Fabricator's current template."),
  (Check::GithubRuns, "github_runs", "The Fabricator workflow's recent runs."),
  (Check::GithubRun, "github_run", "One run's jobs, steps and runners. Optional runId; default: the run being diagnosed, or the latest failed one."),
  (Check::GithubRunLog, "github_run_log", "The end of one run's failed-steps log. Optional runId, same default."),
  (Check::GithubInvitations, "github_invitations", "Your pending invitation to the repository."),
  (Check::AzureAccount, "azure_account", "The Azure CLI's signed-in user and tenant."),
  (Check::EntraAppPolicy, "entra_app_policy", "Whether the directory lets users register applications."),
  (Check::EntraMyRoles, "entra_my_roles", "Your user type and active Microsoft Entra ID directory roles."),
  (Check::EntraApp, "entra_app", "An identity's app registration: whether it exists in the tenant, its owners and whether you're one, its service principal and that service principal's groups. Optional clientId; default: every known identity."),
  (Check::EntraFederatedCredentials, "entra_federated_credentials", "An identity's federated credentials compared with the ones the pipeline needs. Optional clientId; default: every known identity."),
  (Check::FabricCapacities, "fabric_capacities", "The Fabric capacities you can see, with SKU and state."),
  (Check::FabricWorkspace, "fabric_workspace", "A Fabric workspace: whether you can read it, its capacity, and its role assignments including the deploy identities'. Optional workspaceId; default: every known workspace."),
  (Check::FabricTenantSettings, "fabric_tenant_settings", "Fabric tenant settings for service principals and workspace creation, and whether the identities are in the allowed groups (readable by Fabric administrators only)."),
  (Check::LocalTools, "local_tools", "Versions of gh, az and git on this computer, the OS, and Fabricator's version."),
  (Check::ProjectRayfin, "project_rayfin", "The Rayfin CLI version the pipeline installs for the open app, compared with the minimum."),
];

impl Check {
  pub fn name(self) -> &'static str {
    CATALOG.iter().find(|(c, ..)| *c == self).map(|(_, name, _)| *name).unwrap_or_default()
  }

  pub fn parse(name: &str) -> Option<Check> {
    CATALOG.iter().find(|(_, n, _)| *n == name.trim()).map(|(c, ..)| *c)
  }

  pub fn names() -> Vec<&'static str> {
    CATALOG.iter().map(|(_, name, _)| *name).collect()
  }

  /// `- name: what it reads`, one per line.
  pub fn catalog() -> String {
    CATALOG.iter().map(|(_, name, about)| format!("- `{name}`: {about}")).collect::<Vec<_>>().join("\n")
  }

  fn needs_repo(self) -> bool {
    matches!(
      self,
      Check::GithubRepo
        | Check::GithubActionsPolicy
        | Check::GithubBranchRules
        | Check::GithubOidcSubject
        | Check::GithubVariables
        | Check::GithubWorkflow
        | Check::GithubRuns
        | Check::GithubRun
        | Check::GithubRunLog
        | Check::GithubInvitations
    )
  }

  fn label(self) -> &'static str {
    match self {
      Check::GithubAccount => "Checking your GitHub sign-in",
      Check::GithubRepo => "Checking the repository and your access",
      Check::GithubOrg => "Checking your role in the GitHub organization",
      Check::GithubActionsPolicy => "Checking the repository's GitHub Actions settings",
      Check::GithubBranchRules => "Checking the rules on the main branch",
      Check::GithubOidcSubject => "Checking how GitHub identifies the pipeline",
      Check::GithubVariables => "Checking the pipeline's settings",
      Check::GithubWorkflow => "Checking the deploy pipeline file",
      Check::GithubRuns => "Checking recent pipeline runs",
      Check::GithubRun => "Checking the failed pipeline run",
      Check::GithubRunLog => "Reading the failed run's log",
      Check::GithubInvitations => "Checking your invitations",
      Check::AzureAccount => "Checking your Azure sign-in",
      Check::EntraAppPolicy => "Checking whether you can register apps",
      Check::EntraMyRoles => "Checking your Microsoft Entra ID roles",
      Check::EntraApp => "Checking the deploy identity",
      Check::EntraFederatedCredentials => "Checking what the deploy identity trusts",
      Check::FabricCapacities => "Checking your Fabric capacities",
      Check::FabricWorkspace => "Checking the Fabric workspace",
      Check::FabricTenantSettings => "Checking Fabric's tenant settings",
      Check::LocalTools => "Checking the tools on this computer",
      Check::ProjectRayfin => "Checking the app's Rayfin version",
    }
  }

  /// [`Check::label`] in the app's language, for the renderer's list of checks.
  fn display_label(self) -> String {
    match self {
      Check::GithubAccount => t!("team.diagnose.check.githubAccount"),
      Check::GithubRepo => t!("team.diagnose.check.githubRepo"),
      Check::GithubOrg => t!("team.diagnose.check.githubOrg"),
      Check::GithubActionsPolicy => t!("team.diagnose.check.githubActionsPolicy"),
      Check::GithubBranchRules => t!("team.diagnose.check.githubBranchRules"),
      Check::GithubOidcSubject => t!("team.diagnose.check.githubOidcSubject"),
      Check::GithubVariables => t!("team.diagnose.check.githubVariables"),
      Check::GithubWorkflow => t!("team.diagnose.check.githubWorkflow"),
      Check::GithubRuns => t!("team.diagnose.check.githubRuns"),
      Check::GithubRun => t!("team.diagnose.check.githubRun"),
      Check::GithubRunLog => t!("team.diagnose.check.githubRunLog"),
      Check::GithubInvitations => t!("team.diagnose.check.githubInvitations"),
      Check::AzureAccount => t!("team.diagnose.check.azureAccount"),
      Check::EntraAppPolicy => t!("team.diagnose.check.entraAppPolicy"),
      Check::EntraMyRoles => t!("team.diagnose.check.entraMyRoles"),
      Check::EntraApp => t!("team.diagnose.check.entraApp"),
      Check::EntraFederatedCredentials => t!("team.diagnose.check.entraFederatedCredentials"),
      Check::FabricCapacities => t!("team.diagnose.check.fabricCapacities"),
      Check::FabricWorkspace => t!("team.diagnose.check.fabricWorkspace"),
      Check::FabricTenantSettings => t!("team.diagnose.check.fabricTenantSettings"),
      Check::LocalTools => t!("team.diagnose.check.localTools"),
      Check::ProjectRayfin => t!("team.diagnose.check.projectRayfin"),
    }
  }
}

/* --------------------------------- requests -------------------------------- */

/// What one check looks at.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
  None,
  Identity(Identity),
  Workspace(FabricTarget),
  /// A run of the workspace's workflow (`None`: the latest failed one).
  Run(Option<u64>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Request {
  pub check: Check,
  pub target: Target,
}

impl Request {
  fn new(check: Check) -> Self {
    Request { check, target: Target::None }
  }

  pub fn id(&self) -> String {
    let name = self.check.name();
    match &self.target {
      Target::Identity(i) => format!("{name}:{}", i.client_id),
      Target::Workspace(w) => format!("{name}:{}", w.id),
      Target::Run(Some(id)) => format!("{name}:{id}"),
      _ => name.to_string(),
    }
  }

  /// What the check is called in the evidence Copilot reads (always English).
  pub fn label(&self) -> String {
    match (self.check, &self.target) {
      (Check::EntraApp, Target::Identity(i)) => format!("Checking the {}", i.describe()),
      (Check::EntraFederatedCredentials, Target::Identity(i)) => format!("Checking what the {} trusts", i.describe()),
      (Check::FabricWorkspace, Target::Workspace(w)) => format!("Checking the {} Fabric workspace", w.label),
      (Check::GithubRun, Target::Run(Some(id))) => format!("Checking pipeline run {id}"),
      (Check::GithubRunLog, Target::Run(Some(id))) => format!("Reading pipeline run {id}'s log"),
      (check, _) => check.label().to_string(),
    }
  }

  /// [`Request::label`] in the app's language, for the renderer's list of checks.
  pub fn display_label(&self) -> String {
    match (self.check, &self.target) {
      (Check::EntraApp, Target::Identity(i)) => match i.role {
        "deploy" => t!("team.diagnose.check.identity.deploy"),
        "preview" => t!("team.diagnose.check.identity.preview"),
        "shared" => t!("team.diagnose.check.identity.shared"),
        _ => t!("team.diagnose.check.identity.admin"),
      },
      (Check::EntraFederatedCredentials, Target::Identity(i)) => match i.role {
        "deploy" => t!("team.diagnose.check.trusts.deploy"),
        "preview" => t!("team.diagnose.check.trusts.preview"),
        "shared" => t!("team.diagnose.check.trusts.shared"),
        _ => t!("team.diagnose.check.trusts.admin"),
      },
      (Check::FabricWorkspace, Target::Workspace(w)) if w.label == "published apps" => t!("team.diagnose.check.workspace.published"),
      (Check::FabricWorkspace, Target::Workspace(w)) if w.label == "previews" => t!("team.diagnose.check.workspace.previews"),
      (Check::GithubRun, Target::Run(Some(id))) => t!("team.diagnose.check.run", id = id),
      (Check::GithubRunLog, Target::Run(Some(id))) => t!("team.diagnose.check.runLog", id = id),
      (check, _) => check.display_label(),
    }
  }
}

/// Optional targets Copilot can name; each must be one this context knows.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Args {
  pub client_id: Option<String>,
  pub workspace_id: Option<String>,
  pub run_id: Option<u64>,
}

fn known_list<'a>(values: impl Iterator<Item = &'a str>) -> String {
  let list: Vec<String> = values.map(|v| format!("`{v}`")).collect();
  if list.is_empty() {
    "none are known".into()
  } else {
    list.join(", ")
  }
}

/// The requests one check expands to here, or why it can't run.
pub fn requests_for(ctx: &DiagContext, check: Check, args: &Args) -> Result<Vec<Request>, String> {
  if check.needs_repo() && ctx.repo.is_none() {
    return Err("There's no repository to check: setup stopped before creating it.".into());
  }
  let wanted = |value: &Option<String>| value.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(String::from);
  match check {
    Check::GithubOrg if ctx.owner.is_none() => Err("The GitHub owner isn't known.".into()),
    Check::ProjectRayfin if ctx.project_dir.is_none() => Err("The app isn't open on this computer.".into()),
    Check::EntraApp | Check::EntraFederatedCredentials => {
      let ids = &ctx.identities;
      match wanted(&args.client_id) {
        Some(id) => match ids.iter().find(|i| i.client_id.eq_ignore_ascii_case(&id)) {
          Some(identity) => Ok(vec![Request { check, target: Target::Identity(identity.clone()) }]),
          None => Err(format!(
            "`{id}` isn't one of this workspace's identities ({}). Only those can be checked.",
            known_list(ids.iter().map(|i| i.client_id.as_str()))
          )),
        },
        None if ids.is_empty() => Err("No deploy identity is known yet: setup stopped before creating one.".into()),
        None => Ok(ids.iter().map(|i| Request { check, target: Target::Identity(i.clone()) }).collect()),
      }
    }
    Check::FabricWorkspace => {
      let all = &ctx.fabric;
      match wanted(&args.workspace_id) {
        Some(id) => match all.iter().find(|w| w.id.eq_ignore_ascii_case(&id)) {
          Some(target) => Ok(vec![Request { check, target: Target::Workspace(target.clone()) }]),
          None => Err(format!(
            "`{id}` isn't one of this workspace's Fabric workspaces ({}). Only those can be checked.",
            known_list(all.iter().map(|w| w.id.as_str()))
          )),
        },
        None if all.is_empty() => Err("No Fabric workspace is known yet: setup stopped before creating them.".into()),
        None => Ok(all.iter().map(|w| Request { check, target: Target::Workspace(w.clone()) }).collect()),
      }
    }
    // Runs are read through the context's repository, so any id stays in it.
    Check::GithubRun | Check::GithubRunLog => Ok(vec![Request { check, target: Target::Run(args.run_id.or(ctx.run_id)) }]),
    _ => Ok(vec![Request::new(check)]),
  }
}

/// The checks to run before Copilot starts, for this kind of failure.
pub fn baseline(ctx: &DiagContext) -> Vec<Check> {
  use Check::*;
  let step = ctx.step.as_deref().unwrap_or_default();
  match ctx.kind {
    Kind::Setup => match step {
      "github" => vec![GithubAccount, GithubOrg],
      "fabric" => vec![AzureAccount, FabricCapacities],
      "identity" => vec![AzureAccount, EntraAppPolicy, EntraMyRoles, EntraApp],
      "trust" => vec![AzureAccount, EntraApp, EntraFederatedCredentials],
      "access" => vec![EntraApp, FabricWorkspace, FabricTenantSettings],
      "files" | "protection" => vec![GithubAccount, GithubBranchRules, GithubActionsPolicy],
      "clone" => vec![LocalTools, GithubRepo],
      "verify" => vec![
        GithubRun,
        GithubRunLog,
        GithubVariables,
        EntraFederatedCredentials,
        GithubOidcSubject,
        GithubActionsPolicy,
        FabricWorkspace,
        FabricTenantSettings,
      ],
      _ => vec![GithubAccount, AzureAccount],
    },
    Kind::Health => {
      let mut list = vec![GithubRepo, GithubWorkflow, GithubVariables, EntraApp, EntraFederatedCredentials, FabricWorkspace];
      if step == "verify" {
        list.extend([GithubRun, GithubRunLog]);
      }
      list
    }
    Kind::Join => {
      let mut list = vec![GithubAccount, GithubRepo, GithubInvitations, GithubOrg];
      let error = ctx.error.as_deref().unwrap_or_default().to_ascii_lowercase();
      if ["clone", "git ", "fatal:", "ssl", "certificate"].iter().any(|k| error.contains(k)) {
        list.push(LocalTools);
      }
      list
    }
    Kind::Pipeline => vec![GithubRun, GithubRunLog, ProjectRayfin],
  }
}

/// [`baseline`] expanded into requests, skipping checks that can't run here.
pub fn baseline_requests(ctx: &DiagContext) -> Vec<Request> {
  baseline(ctx).into_iter().filter_map(|c| requests_for(ctx, c, &Args::default()).ok()).flatten().collect()
}

/* ---------------------------------- runner --------------------------------- */

/// One finished check.
#[derive(Clone, Debug)]
pub struct Outcome {
  /// [`Request::label`], in English for Copilot.
  pub label: String,
  /// The read worked (its findings can still be bad news).
  pub ok: bool,
  pub detail: String,
}

/// Evidence for Copilot: each check's label and findings.
pub fn render(outcomes: &[Outcome]) -> String {
  outcomes
    .iter()
    .map(|o| format!("### {}{}\n{}", o.label, if o.ok { "" } else { " (the check couldn't complete)" }, o.detail))
    .collect::<Vec<_>>()
    .join("\n\n")
}

/// Runs checks for one diagnosis: reports each to the renderer, caches results,
/// and limits how many Copilot can ask for.
pub struct Runner {
  pub ctx: Arc<DiagContext>,
  emit: Emit,
  token: CancelToken,
  results: Mutex<Vec<TeamDiagnosisCheck>>,
  cache: Mutex<HashMap<String, Outcome>>,
  requested: AtomicUsize,
}

impl Runner {
  pub fn new(ctx: Arc<DiagContext>, emit: Emit, token: CancelToken) -> Self {
    Runner { ctx, emit, token, results: Mutex::default(), cache: Mutex::default(), requested: AtomicUsize::new(0) }
  }

  /// Count one check Copilot asked for; false once the budget is spent.
  pub fn take_request(&self) -> bool {
    self.requested.fetch_add(1, Ordering::SeqCst) < MAX_REQUESTED
  }

  pub async fn run_all(&self, requests: Vec<Request>) -> Vec<Outcome> {
    join_all(requests.iter().map(|r| self.run(r))).await
  }

  async fn run(&self, request: &Request) -> Outcome {
    let id = request.id();
    if let Some(done) = self.cache.lock().unwrap().get(&id).cloned() {
      return done;
    }
    let label = request.display_label();
    self.record(TeamDiagnosisCheck { id: id.clone(), label: label.clone(), state: "running".into(), detail: None });
    // Copilot's tool calls arrive on the SDK's tasks, so the account is set here.
    let checked = gh::as_account(self.ctx.account.clone(), execute(&self.ctx, request));
    let result = tokio::select! {
      r = tokio::time::timeout(CHECK_TIMEOUT, checked) => r.unwrap_or_else(|_| Err("The check timed out.".into())),
      _ = self.token.wait_cancelled() => Err("Stopped.".into()),
    };
    let (ok, detail) = match result {
      Ok(detail) => (true, detail),
      Err(why) => (false, format!("- {why}")),
    };
    let max = if request.check == Check::GithubRunLog { MAX_LOG } else { MAX_DETAIL };
    let detail = clip(&mask(&detail), max);
    let outcome = Outcome { label: request.label(), ok, detail: detail.clone() };
    self.cache.lock().unwrap().insert(id.clone(), outcome.clone());
    let state = if ok { "done" } else { "failed" };
    self.record(TeamDiagnosisCheck { id, label, state: state.into(), detail: Some(detail) });
    outcome
  }

  fn record(&self, check: TeamDiagnosisCheck) {
    {
      let mut results = self.results.lock().unwrap();
      match results.iter_mut().find(|c| c.id == check.id) {
        Some(existing) => *existing = check.clone(),
        None => results.push(check.clone()),
      }
    }
    (self.emit)(TeamDiagnosisEvent::Check { check });
  }

  /// Every check so far, in the order they started.
  pub fn checks(&self) -> Vec<TeamDiagnosisCheck> {
    self.results.lock().unwrap().clone()
  }
}

static JWT_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}").unwrap());
static BEARER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}").unwrap());

/// Mask anything that looks like a credential or access token.
pub fn mask(text: &str) -> String {
  let text = mask_secrets(text);
  let text = JWT_RE.replace_all(&text, "eyJ••••••");
  BEARER_RE.replace_all(&text, "${1}••••••").into_owned()
}

fn clip(text: &str, max: usize) -> String {
  if text.chars().count() <= max {
    return text.to_string();
  }
  let mut out: String = text.chars().take(max).collect();
  out.push_str("\n… (shortened)");
  out
}

fn tail(text: &str, max: usize) -> String {
  let count = text.chars().count();
  if count <= max {
    text.to_string()
  } else {
    text.chars().skip(count - max).collect()
  }
}

/* ---------------------------------- helpers --------------------------------- */

fn text(v: &Value, key: &str) -> Option<String> {
  v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn flag(v: &Value, key: &str) -> Option<bool> {
  v.get(key).and_then(Value::as_bool)
}

fn strings(v: Option<&Value>) -> Vec<String> {
  v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

fn yes_no(value: bool) -> &'static str {
  if value {
    "yes"
  } else {
    "no"
  }
}

fn gh_error(e: &gh::GhError) -> String {
  if e.missing_cli {
    return "The GitHub CLI (gh) isn't installed.".into();
  }
  match e.status {
    Some(status) => format!("GitHub returned HTTP {status}: {}", e.message),
    None => e.message.clone(),
  }
}

async fn gh_get(path: &str) -> Result<Value, String> {
  gh::api("GET", path, None).await.map_err(|e| gh_error(&e))
}

fn az_error(e: &entra::AzError) -> String {
  match e.kind {
    entra::AzErrorKind::Missing => "The Azure CLI (az) isn't installed.".into(),
    entra::AzErrorKind::NeedsLogin => format!("The Azure CLI isn't signed in, or its sign-in expired: {}", e.message),
    _ => e.message.clone(),
  }
}

fn graph_error(e: &entra::GraphError, what: &str) -> String {
  if matches!(e.status, Some(401) | Some(403)) {
    format!("Couldn't read {what}: {} (your account isn't allowed to read it).", e.summary())
  } else {
    format!("Couldn't read {what}: {}", e.summary())
  }
}

fn fabric_error(e: &fabric::FabricError, what: &str) -> String {
  if e.status.is_none() && e.needs_login {
    format!("Couldn't read {what}: the Azure CLI isn't signed in, or its sign-in expired ({}).", e.message)
  } else {
    format!("Couldn't read {what}: {}", e.summary())
  }
}

/* --------------------------------- executors -------------------------------- */

async fn execute(ctx: &DiagContext, request: &Request) -> Result<String, String> {
  let repo = ctx.repo.as_deref().unwrap_or_default();
  match (request.check, &request.target) {
    (Check::GithubAccount, _) => github_account().await,
    (Check::GithubRepo, _) => github_repo(repo).await,
    (Check::GithubOrg, _) => github_org(ctx).await,
    (Check::GithubActionsPolicy, _) => github_actions_policy(repo).await,
    (Check::GithubBranchRules, _) => github_branch_rules(repo).await,
    (Check::GithubOidcSubject, _) => github_oidc_subject(ctx, repo).await,
    (Check::GithubVariables, _) => github_variables(repo).await,
    (Check::GithubWorkflow, _) => github_workflow(repo).await,
    (Check::GithubRuns, _) => github_runs(repo).await,
    (Check::GithubRun, Target::Run(id)) => github_run(ctx, repo, *id).await,
    (Check::GithubRunLog, Target::Run(id)) => github_run_log(ctx, repo, *id).await,
    (Check::GithubInvitations, _) => github_invitations(repo).await,
    (Check::AzureAccount, _) => azure_account(ctx).await,
    (Check::EntraAppPolicy, _) => entra_app_policy().await,
    (Check::EntraMyRoles, _) => entra_my_roles().await,
    (Check::EntraApp, Target::Identity(identity)) => entra_app(ctx, identity).await,
    (Check::EntraFederatedCredentials, Target::Identity(identity)) => entra_federated(ctx, identity).await,
    (Check::FabricCapacities, _) => fabric_capacities(ctx).await,
    (Check::FabricWorkspace, Target::Workspace(target)) => fabric_workspace(ctx, target).await,
    (Check::FabricTenantSettings, _) => fabric_tenant_settings(ctx).await,
    (Check::LocalTools, _) => local_tools().await,
    (Check::ProjectRayfin, _) => project_rayfin(ctx),
    _ => Err("This check needs a target.".into()),
  }
}

async fn github_account() -> Result<String, String> {
  let (who, scopes) = tokio::join!(gh::viewer(), gh::token_scopes());
  let viewer = who.map_err(|e| gh_error(&e))?;
  let mut out = vec![format!("- Signed in to github.com as `{}`.", viewer.login)];
  match scopes {
    Ok(granted) => {
      let missing = gh::missing_scopes(&granted);
      out.push(format!(
        "- Token scopes: {}.",
        if granted.is_empty() { "none reported".to_string() } else { granted.join(", ") }
      ));
      out.push(if missing.is_empty() {
        format!("- Fabricator's required scopes ({}) are granted.", gh::REQUIRED_SCOPES.join(", "))
      } else {
        format!("- Missing scopes Fabricator needs: {}.", missing.join(", "))
      });
    }
    Err(e) => out.push(format!("- Couldn't read the token's scopes: {}", gh_error(&e))),
  }
  Ok(out.join("\n"))
}

async fn github_repo(repo: &str) -> Result<String, String> {
  let v = gh_get(&format!("repos/{repo}")).await?;
  let owner = v.get("owner");
  let perms = v.get("permissions");
  let perm = |k: &str| perms.and_then(|p| p.get(k)).and_then(Value::as_bool).unwrap_or(false);
  let access = if perm("admin") {
    "admin (owner)"
  } else if perm("maintain") {
    "maintain (owner; adding or removing people, protecting `main` and deleting the workspace need admin)"
  } else if perm("push") {
    "write (member)"
  } else if perm("pull") {
    "read only"
  } else {
    "none"
  };
  let mut out = vec![
    format!(
      "- `{}`: {} repository owned by `{}` ({}).",
      text(&v, "full_name").unwrap_or_else(|| repo.to_string()),
      text(&v, "visibility").unwrap_or_else(|| "private".into()),
      owner.and_then(|o| text(o, "login")).unwrap_or_default(),
      owner.and_then(|o| text(o, "type")).unwrap_or_else(|| "unknown type".into()),
    ),
    format!("- Your access: {access}."),
    format!("- Default branch: `{}`.", text(&v, "default_branch").unwrap_or_default()),
  ];
  if flag(&v, "archived") == Some(true) {
    out.push("- The repository is archived (read-only): the workspace was deleted.".into());
  }
  if flag(&v, "disabled") == Some(true) {
    out.push("- GitHub has disabled the repository.".into());
  }
  let tagged = strings(v.get("topics")).iter().any(|t| t == naming::REPO_TOPIC);
  out.push(format!("- Tagged as a Fabricator team workspace (`{}` topic): {}.", naming::REPO_TOPIC, yes_no(tagged)));
  Ok(out.join("\n"))
}

const ORG_FIELDS: &[(&str, &str)] = &[
  ("members_can_create_repositories", "Members can create repositories"),
  ("members_can_create_private_repositories", "Members can create private repositories"),
  ("members_can_create_internal_repositories", "Members can create internal repositories"),
  ("default_repository_permission", "Default repository permission"),
  ("two_factor_requirement_enabled", "Two-factor authentication required"),
  ("web_commit_signoff_required", "Web commit sign-off required"),
];

fn show(v: &Value) -> String {
  match v {
    Value::Bool(b) => yes_no(*b).to_string(),
    Value::String(s) => s.clone(),
    other => other.to_string(),
  }
}

async fn github_org(ctx: &DiagContext) -> Result<String, String> {
  let owner = ctx.owner.as_deref().unwrap_or_default();
  if ctx.owner_is_org == Some(false) {
    return Ok(format!("- `{owner}` is a personal GitHub account, so no organization policies apply."));
  }
  let (membership_path, org_path) = (format!("user/memberships/orgs/{owner}"), format!("orgs/{owner}"));
  let (membership, org) = tokio::join!(gh::api("GET", &membership_path, None), gh::api("GET", &org_path, None));
  let mut out = Vec::new();
  match &org {
    Err(e) if e.is_not_found() => {
      return Ok(format!("- `{owner}` isn't a GitHub organization (a personal account, or one GitHub hides from you)."))
    }
    Err(e) => out.push(format!("- Couldn't read the organization `{owner}`: {}", gh_error(e))),
    Ok(_) => {}
  }
  match membership {
    Ok(m) => out.push(format!(
      "- Your role in `{owner}`: {} (membership {}).",
      text(&m, "role").unwrap_or_else(|| "unknown".into()),
      text(&m, "state").unwrap_or_else(|| "unknown".into())
    )),
    Err(e) if e.is_not_found() => out.push(format!("- You aren't a member of `{owner}` (or GitHub hides your membership).")),
    Err(e) => out.push(format!("- Couldn't read your membership in `{owner}`: {}", gh_error(&e))),
  }
  if let Ok(o) = &org {
    for (key, label) in ORG_FIELDS {
      if let Some(value) = o.get(*key).filter(|v| !v.is_null()) {
        out.push(format!("- {label}: {}.", show(value)));
      }
    }
    if let Some(plan) = o.get("plan").and_then(|p| text(p, "name")) {
      out.push(format!("- Plan: {plan}."));
    }
    out.push("- GitHub shows some organization settings only to the organization's owners.".into());
  }
  Ok(out.join("\n"))
}

static USES_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\s*(?:-\s*)?uses:\s*([^\s#]+)").unwrap());

/// The actions the managed workflow uses (`owner/name@ref`).
pub fn workflow_actions() -> Vec<String> {
  let mut out: Vec<String> = USES_RE.captures_iter(&templates::workflow()).map(|c| c[1].to_string()).collect();
  out.sort();
  out.dedup();
  out
}

/// `*` wildcard matching, case-insensitive, as GitHub's allowed-actions patterns use.
pub fn glob_match(pattern: &str, value: &str) -> bool {
  let p: Vec<char> = pattern.trim().to_ascii_lowercase().chars().collect();
  let t: Vec<char> = value.to_ascii_lowercase().chars().collect();
  let (mut pi, mut ti) = (0usize, 0usize);
  let (mut star, mut mark) = (None::<usize>, 0usize);
  while ti < t.len() {
    if pi < p.len() && p[pi] != '*' && p[pi] == t[ti] {
      pi += 1;
      ti += 1;
    } else if pi < p.len() && p[pi] == '*' {
      star = Some(pi);
      mark = ti;
      pi += 1;
    } else if let Some(s) = star {
      pi = s + 1;
      mark += 1;
      ti = mark;
    } else {
      return false;
    }
  }
  while pi < p.len() && p[pi] == '*' {
    pi += 1;
  }
  pi == p.len()
}

/// Whether an Actions policy that allows only selected actions lets `action`
/// (`owner/name@ref`) run.
pub fn action_verdict(action: &str, github_owned: bool, verified: bool, patterns: &[String]) -> String {
  let bare = action.split('@').next().unwrap_or(action);
  if let Some(p) = patterns.iter().find(|p| glob_match(p, action) || (!p.contains('@') && glob_match(p, bare))) {
    return format!("allowed by the pattern `{p}`.");
  }
  let owner = action.split('/').next().unwrap_or_default().to_ascii_lowercase();
  if owner == "actions" || owner == "github" {
    return if github_owned {
      "allowed (GitHub-owned).".into()
    } else {
      "BLOCKED: GitHub-owned actions aren't allowed and no pattern matches it.".into()
    };
  }
  if verified {
    "allowed only if its publisher is a Marketplace verified creator; no pattern matches it.".into()
  } else {
    "BLOCKED: no allowed pattern matches it.".into()
  }
}

async fn github_actions_policy(repo: &str) -> Result<String, String> {
  let perms = gh_get(&format!("repos/{repo}/actions/permissions")).await?;
  let enabled = flag(&perms, "enabled").unwrap_or(true);
  let allowed = text(&perms, "allowed_actions").unwrap_or_else(|| "all".into());
  let actions = workflow_actions();
  let mut out = vec![
    format!("- GitHub Actions enabled for the repository: {}.", yes_no(enabled)),
    format!("- Allowed actions: {allowed}."),
  ];
  if flag(&perms, "sha_pinning_required") == Some(true) {
    out.push("- Actions must be pinned to a full commit SHA. Fabricator's workflow uses version tags (for example `actions/checkout@v7`), so GitHub refuses to run it.".into());
  }
  match allowed.as_str() {
    "selected" => match gh_get(&format!("repos/{repo}/actions/permissions/selected-actions")).await {
      Ok(selected) => {
        let owned = flag(&selected, "github_owned_allowed").unwrap_or(false);
        let verified = flag(&selected, "verified_allowed").unwrap_or(false);
        let patterns = strings(selected.get("patterns_allowed"));
        out.push(format!(
          "- GitHub-owned actions allowed: {}. Marketplace verified creators allowed: {}. Allowed patterns: {}.",
          yes_no(owned),
          yes_no(verified),
          if patterns.is_empty() { "none".to_string() } else { patterns.join(", ") }
        ));
        for action in &actions {
          out.push(format!("  - `{action}`: {}", action_verdict(action, owned, verified, &patterns)));
        }
      }
      Err(e) => out.push(format!("- Couldn't read which actions are allowed: {e}")),
    },
    "local_only" => out.push(format!(
      "- Only actions from this repository or organization may run, so the workflow's actions ({}) are blocked.",
      actions.join(", ")
    )),
    _ => {}
  }
  match gh_get(&format!("repos/{repo}/actions/permissions/workflow")).await {
    Ok(w) => out.push(format!(
      "- Default workflow token permissions: {} (the workflow asks for `id-token: write` itself).",
      text(&w, "default_workflow_permissions").unwrap_or_else(|| "unknown".into())
    )),
    Err(e) => out.push(format!("- Couldn't read the workflow token settings: {e}")),
  }
  Ok(out.join("\n"))
}

async fn github_branch_rules(repo: &str) -> Result<String, String> {
  let branch = naming::DEFAULT_BRANCH;
  let rules = gh_get(&format!("repos/{repo}/rules/branches/{branch}")).await?;
  let rules = rules.as_array().cloned().unwrap_or_default();
  let mut out = Vec::new();
  if rules.is_empty() {
    out.push(format!("- No rulesets apply to `{branch}`."));
  }
  for rule in &rules {
    let kind = text(rule, "type").unwrap_or_default();
    let source = match (text(rule, "ruleset_source_type"), text(rule, "ruleset_source")) {
      (Some(t), Some(s)) => format!(" (from {t} `{s}`)"),
      _ => String::new(),
    };
    let params = rule.get("parameters");
    let extra = match kind.as_str() {
      "pull_request" => params
        .and_then(|p| p.get("required_approving_review_count"))
        .and_then(Value::as_u64)
        .map(|n| format!(", {n} approval(s)"))
        .unwrap_or_default(),
      "required_status_checks" => params
        .and_then(|p| p.get("required_status_checks"))
        .and_then(Value::as_array)
        .map(|checks| format!(": {}", checks.iter().filter_map(|c| text(c, "context")).collect::<Vec<_>>().join(", ")))
        .unwrap_or_default(),
      _ => String::new(),
    };
    out.push(format!("- Ruleset rule `{kind}`{extra}{source}."));
  }
  match gh::api("GET", &format!("repos/{repo}/branches/{branch}/protection"), None).await {
    Ok(p) => {
      let reviews = p
        .get("required_pull_request_reviews")
        .and_then(|r| r.get("required_approving_review_count"))
        .and_then(Value::as_u64);
      let admins = p.get("enforce_admins").and_then(|e| flag(e, "enabled")).unwrap_or(false);
      out.push(format!(
        "- Classic branch protection is on: pull requests required{}; applies to admins: {}.",
        reviews.map(|n| format!(" with {n} approval(s)")).unwrap_or_default(),
        yes_no(admins)
      ));
    }
    Err(e) if e.is_not_found() => out.push("- No classic branch protection.".into()),
    Err(e) if e.needs_upgrade() => out.push("- GitHub doesn't offer classic branch protection for this repository on its plan.".into()),
    Err(e) => out.push(format!("- Couldn't read classic branch protection: {}", gh_error(&e))),
  }
  out.push("- Fabricator writes the pipeline and settings files straight to `main` during setup and Repair, as the signed-in user. Rules that block direct updates for that user (for example `update`, `pull_request` without a bypass, `required_signatures`, `required_status_checks`) stop those steps.".into());
  Ok(out.join("\n"))
}

async fn github_oidc_subject(ctx: &DiagContext, repo: &str) -> Result<String, String> {
  let v = gh_get(&format!("repos/{repo}/actions/oidc/customization/sub")).await?;
  let keys = strings(v.get("include_claim_keys"));
  let mut out = vec![if flag(&v, "use_default").unwrap_or(true) {
    "- The repository uses GitHub's default OIDC subject, which is what Fabricator's federated credentials expect.".to_string()
  } else if keys.is_empty() {
    "- The repository uses its organization's custom OIDC subject template.".to_string()
  } else {
    format!(
      "- The repository uses a custom OIDC subject built from: {}. The pipeline's token then carries a different subject than the ones Fabricator trusts.",
      keys.join(", ")
    )
  }];
  if let Some(owner) = ctx.owner.as_deref().filter(|_| ctx.owner_is_org != Some(false)) {
    match gh::api("GET", &format!("orgs/{owner}/actions/oidc/customization/sub"), None).await {
      Ok(o) => {
        let org_keys = strings(o.get("include_claim_keys"));
        out.push(if org_keys.is_empty() {
          format!("- `{owner}` has no custom OIDC subject template.")
        } else {
          format!("- `{owner}`'s OIDC subject template (for repositories that use it): {}.", org_keys.join(", "))
        });
      }
      Err(e) if e.is_not_found() => {}
      Err(e) => out.push(format!("- Couldn't read `{owner}`'s OIDC subject template: {}", gh_error(&e))),
    }
  }
  Ok(out.join("\n"))
}

async fn github_variables(repo: &str) -> Result<String, String> {
  let values = join_all(VARIABLES.iter().map(|name| gh::variable(repo, name))).await;
  let mut out = Vec::new();
  for (name, value) in VARIABLES.iter().zip(values) {
    match value {
      Ok(Some(v)) => out.push(format!("- `{name}` = `{}`", v.trim())),
      Ok(None) => out.push(format!("- `{name}` isn't set.")),
      Err(e) => return Err(format!("Couldn't read the repository variables: {} (reading them needs write access to the repository).", gh_error(&e))),
    }
  }
  // Optional: where the jobs run.
  let runs_on = templates::RUNS_ON_VARIABLE;
  let (repository, organization) =
    tokio::join!(gh::variable(repo, runs_on), gh::organization_variable(repo, runs_on));
  let describe = |v: &str| match templates::parse_runs_on(v) {
    Some(_) => format!("`{}`", v.trim()),
    None => format!("`{}`, which `runs-on` can't use, so every job fails to start", v.trim()),
  };
  match repository {
    Ok(Some(v)) => out.push(format!("- `{runs_on}` = {} (the repository's choice of runners).", describe(&v))),
    Ok(None) => out.push(format!("- `{runs_on}` isn't set on the repository.")),
    Err(e) => out.push(format!("- Couldn't read `{runs_on}`: {}", gh_error(&e))),
  }
  match organization {
    Ok(Some(v)) => out.push(format!("- The organization shares `{runs_on}` = {} with the repository (the repository's own value wins).", describe(&v))),
    Ok(None) => out.push(format!("- The organization doesn't share `{runs_on}` with the repository.")),
    Err(e) => out.push(format!("- Couldn't read the organization's variables: {}", gh_error(&e))),
  }
  Ok(out.join("\n"))
}

async fn github_workflow(repo: &str) -> Result<String, String> {
  let path = naming::WORKFLOW_PATH;
  let v = match gh::api("GET", &format!("repos/{repo}/contents/{path}?ref={}", naming::DEFAULT_BRANCH), None).await {
    Ok(v) => v,
    Err(e) if e.is_not_found() => return Ok(format!("- `{path}` is missing on `main`, so nothing deploys.")),
    Err(e) => return Err(gh_error(&e)),
  };
  let encoded = text(&v, "content").unwrap_or_default().replace(['\n', '\r'], "");
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(encoded)
    .map_err(|e| format!("Couldn't decode the workflow file: {e}"))?;
  let content = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
  let version = templates::TEMPLATE_VERSION;
  Ok(if content.trim_end() == templates::workflow().trim_end() {
    format!("- `{path}` matches Fabricator's current template (v{version}).")
  } else {
    format!(
      "- `{path}` differs from Fabricator's current template (v{version}): it's an older template or was edited. Its first line: `{}`. Repair puts the current one back.",
      content.lines().next().unwrap_or_default()
    )
  })
}

fn run_line(r: &gh::Run) -> String {
  format!(
    "- Run {} ({}{}): {}{}, created {}{}",
    r.id,
    r.event,
    r.head_branch.as_deref().map(|b| format!(" on `{b}`")).unwrap_or_default(),
    r.status,
    r.conclusion.as_deref().map(|c| format!("/{c}")).unwrap_or_default(),
    r.created_at.as_deref().unwrap_or("?"),
    if r.url.is_empty() { String::new() } else { format!(" — {}", r.url) }
  )
}

async fn github_runs(repo: &str) -> Result<String, String> {
  let runs = gh::recent_runs(repo, 8).await.map_err(|e| gh_error(&e))?;
  if runs.is_empty() {
    return Ok("- The Fabricator workflow has no runs yet.".into());
  }
  Ok(runs.iter().map(run_line).collect::<Vec<_>>().join("\n"))
}

/// The latest failed run: a verification run for setup and Repair.
async fn failed_run(repo: &str, kind: Kind) -> Result<u64, String> {
  let runs = gh::recent_runs(repo, 20).await.map_err(|e| gh_error(&e))?;
  let failed = |r: &&gh::Run| {
    r.status == "completed" && !matches!(r.conclusion.as_deref(), Some("success" | "skipped" | "cancelled" | "neutral"))
  };
  let verification = matches!(kind, Kind::Setup | Kind::Health);
  runs
    .iter()
    .filter(failed)
    .find(|r| !verification || r.event == "workflow_dispatch")
    .or_else(|| runs.iter().find(failed))
    .map(|r| r.id)
    .ok_or_else(|| "No failed run of the Fabricator workflow was found.".to_string())
}

async fn github_run(ctx: &DiagContext, repo: &str, id: Option<u64>) -> Result<String, String> {
  let id = match id {
    Some(id) => id,
    None => failed_run(repo, ctx.kind).await?,
  };
  let (run, jobs) = tokio::join!(gh::run(repo, id), gh::run_jobs(repo, id));
  let run = run.map_err(|e| gh_error(&e))?;
  let mut out = vec![run_line(&run)];
  if let Some(title) = &run.title {
    out.push(format!("- Title: {title}"));
  }
  match jobs {
    Ok(jobs) => {
      for job in &jobs {
        let status = text(job, "status").unwrap_or_default();
        let labels = strings(job.get("labels"));
        out.push(format!(
          "- Job `{}`: {status}{}, {}{}",
          text(job, "name").unwrap_or_default(),
          text(job, "conclusion").map(|c| format!("/{c}")).unwrap_or_default(),
          text(job, "runner_name").map(|r| format!("runner `{r}`")).unwrap_or_else(|| "no runner assigned".into()),
          if labels.is_empty() { String::new() } else { format!(" (labels: {})", labels.join(", ")) }
        ));
        if status == "queued" {
          out.push(format!(
            "  - Queued since {}. A job that stays queued means no runner picked it up: GitHub-hosted runners may be turned off for the organization, or the runners `{}` names are busy, offline or not available to the repository.",
            text(job, "created_at").unwrap_or_else(|| "?".into()),
            templates::RUNS_ON_VARIABLE
          ));
        }
        for step in job.get("steps").and_then(Value::as_array).into_iter().flatten() {
          if text(step, "conclusion").as_deref() == Some("failure") {
            out.push(format!("  - Step `{}` failed.", text(step, "name").unwrap_or_default()));
          }
        }
      }
      // A job that never started has no log; GitHub's annotations say why.
      if let Some(job) = gh::unstarted_job(&jobs) {
        out.push(match gh::job_annotations(repo, job).await {
          Ok(reasons) if !reasons.is_empty() => format!("- GitHub never started job {job}: {}", reasons.join(" ")),
          Ok(_) => format!("- GitHub never started job {job} and gave no reason."),
          Err(e) => format!("- GitHub never started job {job}; couldn't read why: {}", gh_error(&e)),
        });
      }
    }
    Err(e) => out.push(format!("- Couldn't read the run's jobs: {}", gh_error(&e))),
  }
  Ok(out.join("\n"))
}

static LOG_TIMESTAMP_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?").unwrap());
static ANSI_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").unwrap());

/// A run log without timestamps, terminal colors, or the `UNKNOWN STEP`
/// column `gh run view --log-failed` prints for composite steps.
pub fn clean_log(log: &str) -> String {
  let log = LOG_TIMESTAMP_RE.replace_all(log, "");
  let log = ANSI_RE.replace_all(&log, "");
  log.replace("\tUNKNOWN STEP\t", "\t")
}

async fn github_run_log(ctx: &DiagContext, repo: &str, id: Option<u64>) -> Result<String, String> {
  let id = match id {
    Some(id) => id,
    None => failed_run(repo, ctx.kind).await?,
  };
  let log = gh::run_log(repo, id, MAX_LOG * 2).await.map_err(|e| gh_error(&e))?;
  let log = tail(clean_log(&log).trim(), MAX_LOG - 200);
  Ok(format!("Run {id}, the end of its failed steps' log:\n````text\n{}\n````", log.trim()))
}

async fn github_invitations(repo: &str) -> Result<String, String> {
  let list = gh::user_invitations().await.map_err(|e| gh_error(&e))?;
  let mine: Vec<String> = list
    .iter()
    .filter(|i| i.repo.eq_ignore_ascii_case(repo))
    .map(|i| {
      format!(
        "- Pending invitation to `{}`{}{}.",
        i.repo,
        i.inviter.as_deref().map(|w| format!(" from `{w}`")).unwrap_or_default(),
        i.created_at.as_deref().map(|c| format!(", sent {c}")).unwrap_or_default()
      )
    })
    .collect();
  Ok(if mine.is_empty() { format!("- You have no pending invitation to `{repo}`.") } else { mine.join("\n") })
}

async fn azure_account(ctx: &DiagContext) -> Result<String, String> {
  let (tenant, user) = entra::account().await.map_err(|e| az_error(&e))?;
  let mut out = vec![format!("- The Azure CLI is signed in as `{user}` in tenant `{tenant}`.")];
  if let Some(expected) = ctx.tenant_id.as_deref().filter(|t| !t.eq_ignore_ascii_case(&tenant)) {
    out.push(format!("- That isn't the workspace's tenant (`{expected}`)."));
  }
  Ok(out.join("\n"))
}

async fn entra_app_policy() -> Result<String, String> {
  let v = entra::graph_get("policies/authorizationPolicy").await.map_err(|e| graph_error(&e, "the directory's user settings"))?;
  let policy = v.get("value").and_then(Value::as_array).and_then(|a| a.first()).unwrap_or(&v);
  let allowed = policy.get("defaultUserRolePermissions").and_then(|p| flag(p, "allowedToCreateApps"));
  Ok(match allowed {
    Some(true) => "- Users can register applications (\"Users can register applications\" is on).".into(),
    Some(false) => "- Users can't register applications: \"Users can register applications\" is off. Only people with a role such as Application Developer, Application Administrator or Cloud Application Administrator can.".into(),
    None => "- The directory's app registration setting isn't visible.".into(),
  })
}

async fn entra_my_roles() -> Result<String, String> {
  let me = entra::graph_get("me?$select=id,userPrincipalName,userType").await.map_err(|e| graph_error(&e, "your account"))?;
  let user_type = text(&me, "userType").unwrap_or_else(|| "Member".into());
  let mut out = vec![format!("- You: `{}` ({user_type}).", text(&me, "userPrincipalName").unwrap_or_default())];
  if user_type == "Guest" {
    out.push("- You're a guest in this directory. Guests usually can't register apps or read directory settings.".into());
  }
  match entra::graph_list("me/transitiveMemberOf?$select=id,displayName&$top=999", 5).await {
    Ok(items) => {
      let roles: Vec<String> = items
        .iter()
        .filter(|i| text(i, "@odata.type").as_deref() == Some("#microsoft.graph.directoryRole"))
        .filter_map(|i| text(i, "displayName"))
        .collect();
      out.push(if roles.is_empty() {
        "- No active directory roles. Roles you're only eligible for in Privileged Identity Management don't count until you activate them.".into()
      } else {
        format!("- Active directory roles: {}.", roles.join(", "))
      });
    }
    Err(e) => out.push(format!("- {}", graph_error(&e, "your directory roles"))),
  }
  Ok(out.join("\n"))
}

/// The app registration with this client ID, if it's in the signed-in tenant.
async fn find_app(client_id: &str) -> Result<Option<Value>, String> {
  match entra::graph_get(&format!("applications(appId='{client_id}')?$select=id,appId,displayName,signInAudience")).await {
    Ok(v) => Ok(Some(v)),
    Err(e) if e.is_not_found() => Ok(None),
    Err(e) => Err(graph_error(&e, "the app registration")),
  }
}

/// The object ID of the service principal for a client ID.
async fn service_principal_id(client_id: &str) -> Option<String> {
  entra::graph_get(&format!("servicePrincipals(appId='{client_id}')?$select=id"))
    .await
    .ok()
    .and_then(|v| text(&v, "id"))
}

fn not_in_tenant(ctx: &DiagContext, client_id: &str) -> String {
  format!(
    "- No app registration with client ID `{client_id}` exists in the Azure CLI's tenant, or you can't see it.{}",
    ctx.tenant_id.as_deref().map(|t| format!(" The workspace's tenant is `{t}`.")).unwrap_or_default()
  )
}

async fn entra_app(ctx: &DiagContext, identity: &Identity) -> Result<String, String> {
  let id = &identity.client_id;
  let Some(app) = find_app(id).await? else {
    return Ok(not_in_tenant(ctx, id));
  };
  let object_id = text(&app, "id").unwrap_or_default();
  let mut out = vec![format!(
    "- `{}`: client ID `{id}`, object ID `{object_id}`, sign-in audience {}.",
    text(&app, "displayName").unwrap_or_default(),
    text(&app, "signInAudience").unwrap_or_else(|| "unknown".into())
  )];
  let owners_path = format!("applications/{object_id}/owners?$select=id,displayName,userPrincipalName");
  let sp_path = format!("servicePrincipals(appId='{id}')?$select=id,accountEnabled");
  let (owners, me, sp) =
    tokio::join!(entra::graph_list(&owners_path, 2), entra::graph_get("me?$select=id"), entra::graph_get(&sp_path));
  let my_id = me.ok().and_then(|m| text(&m, "id"));
  match owners {
    Ok(list) => {
      let names: Vec<String> = list
        .iter()
        .map(|o| text(o, "userPrincipalName").or_else(|| text(o, "displayName")).or_else(|| text(o, "id")).unwrap_or_default())
        .collect();
      let mine = my_id.as_deref().is_some_and(|me| list.iter().any(|o| text(o, "id").as_deref() == Some(me)));
      out.push(format!(
        "- Owners: {}. You {} an owner. Owners, and Application or Cloud Application Administrators, can add the pipeline's federated credentials.",
        if names.is_empty() { "none".to_string() } else { names.join(", ") },
        if mine { "are" } else { "aren't" }
      ));
    }
    Err(e) => out.push(format!("- {}", graph_error(&e, "its owners"))),
  }
  match sp {
    Ok(sp) => {
      let sp_id = text(&sp, "id").unwrap_or_default();
      out.push(format!("- Service principal `{sp_id}`, enabled: {}.", yes_no(flag(&sp, "accountEnabled").unwrap_or(true))));
      match entra::graph_list(&format!("servicePrincipals/{sp_id}/transitiveMemberOf?$select=id,displayName"), 2).await {
        Ok(groups) => {
          let names: Vec<String> = groups.iter().filter_map(|g| text(g, "displayName")).collect();
          out.push(if names.is_empty() {
            "- The service principal isn't in any groups.".into()
          } else {
            format!("- The service principal's groups: {}.", names.join(", "))
          });
        }
        Err(e) => out.push(format!("- {}", graph_error(&e, "the service principal's groups"))),
      }
    }
    Err(e) if e.is_not_found() => out.push("- It has no service principal (enterprise application) in this tenant yet.".into()),
    Err(e) => out.push(format!("- {}", graph_error(&e, "its service principal"))),
  }
  Ok(out.join("\n"))
}

/// One federated credential on an app registration.
#[derive(Clone, Debug, PartialEq)]
pub struct Credential {
  pub name: String,
  pub issuer: String,
  pub subject: String,
  pub audiences: Vec<String>,
}

fn credential_line(c: &Credential) -> String {
  format!("`{}`: issuer `{}`, subject `{}`, audiences {}", c.name, c.issuer, c.subject, c.audiences.join(", "))
}

/// An identity's federated credentials against the (name, subject) pairs the
/// pipeline needs. Setup finds credentials by name, so a needed subject under
/// another name makes it add a duplicate, which Entra ID rejects.
pub fn compare_credentials(expected: &[(String, String)], actual: &[Credential]) -> Vec<String> {
  let issuer_ok = |c: &Credential| c.issuer.trim_end_matches('/').eq_ignore_ascii_case(entra::GITHUB_ISSUER);
  let mut out = Vec::new();
  for (name, subject) in expected {
    match actual.iter().find(|c| &c.name == name) {
      Some(c) => {
        let mut problems = Vec::new();
        if &c.subject != subject {
          problems.push(format!("its subject is `{}`, expected `{subject}`", c.subject));
        }
        if !issuer_ok(c) {
          problems.push(format!("its issuer is `{}`, expected `{}`", c.issuer, entra::GITHUB_ISSUER));
        }
        if !c.audiences.iter().any(|a| a == entra::TOKEN_EXCHANGE_AUDIENCE) {
          problems.push(format!("its audiences are [{}], expected `{}`", c.audiences.join(", "), entra::TOKEN_EXCHANGE_AUDIENCE));
        }
        out.push(if problems.is_empty() {
          format!("- OK: `{name}` trusts `{subject}`.")
        } else {
          format!("- WRONG: `{name}`: {}.", problems.join("; "))
        });
      }
      None => match actual.iter().find(|c| &c.subject == subject && issuer_ok(c)) {
        Some(other) => out.push(format!(
          "- DUPLICATE: `{subject}` is already trusted under another name, `{}`. Fabricator looks for `{name}`, so setup and Repair try to add it and Microsoft Entra ID rejects the duplicate (each issuer and subject pair must be unique). Pipeline sign-in itself works for this subject.",
          other.name
        )),
        None => out.push(format!("- MISSING: `{name}` for `{subject}`.")),
      },
    }
  }
  for c in actual.iter().filter(|c| !expected.iter().any(|(n, s)| &c.name == n || &c.subject == s)) {
    out.push(format!("- Other credential {}.", credential_line(c)));
  }
  out.push(format!("- {} of {MAX_FEDERATED} federated credentials used.", actual.len()));
  out
}

/// The (name, subject) pairs this identity needs, from the repository's IDs.
async fn expected_subjects(ctx: &DiagContext, identity: &Identity) -> Result<Vec<(String, String)>, String> {
  let repo = ctx.repo.as_deref().ok_or("The repository doesn't exist yet, so there are no subjects to compare with.")?;
  let info = gh::repo(repo).await.map_err(|e| format!("Couldn't read the repository's IDs: {}", gh_error(&e)))?;
  let (deploy, preview) = naming::identity_subjects(&info.full_name, info.owner_id, info.id, !ctx.shared_identity);
  Ok(if identity.role == "preview" { preview } else { deploy })
}

async fn entra_federated(ctx: &DiagContext, identity: &Identity) -> Result<String, String> {
  let id = &identity.client_id;
  let Some(app) = find_app(id).await? else {
    return Ok(not_in_tenant(ctx, id));
  };
  let object_id = text(&app, "id").unwrap_or_default();
  let items = entra::graph_list(&format!("applications/{object_id}/federatedIdentityCredentials"), 2)
    .await
    .map_err(|e| graph_error(&e, "its federated credentials"))?;
  let actual: Vec<Credential> = items
    .iter()
    .map(|c| Credential {
      name: text(c, "name").unwrap_or_default(),
      issuer: text(c, "issuer").unwrap_or_default(),
      subject: text(c, "subject").unwrap_or_default(),
      audiences: strings(c.get("audiences")),
    })
    .collect();
  Ok(match expected_subjects(ctx, identity).await {
    Ok(expected) => compare_credentials(&expected, &actual).join("\n"),
    Err(why) => {
      let mut out = vec![format!("- {why}")];
      out.extend(actual.iter().map(|c| format!("- {}.", credential_line(c))));
      out.join("\n")
    }
  })
}

async fn fabric_capacities(ctx: &DiagContext) -> Result<String, String> {
  let v = fabric::get("capacities").await.map_err(|e| fabric_error(&e, "your Fabric capacities"))?;
  let items = v.get("value").and_then(Value::as_array).cloned().unwrap_or_default();
  if items.is_empty() {
    return Ok("- You can't see any Fabric capacities. Creating a workspace on a capacity needs Contributor or Admin permission on it.".into());
  }
  let chosen = ctx.capacity.as_ref().map(|(id, _)| id.as_str());
  let is_chosen = |c: &Value| chosen.is_some_and(|id| text(c, "id").is_some_and(|cid| cid.eq_ignore_ascii_case(id)));
  let mut out: Vec<String> = items
    .iter()
    .map(|c| {
      format!(
        "- {}`{}`: SKU {}, state {}, region {}.",
        if is_chosen(c) { "(chosen for setup) " } else { "" },
        text(c, "displayName").unwrap_or_default(),
        text(c, "sku").unwrap_or_else(|| "?".into()),
        text(c, "state").unwrap_or_else(|| "?".into()),
        text(c, "region").unwrap_or_else(|| "?".into())
      )
    })
    .collect();
  if let Some(id) = chosen.filter(|_| !items.iter().any(is_chosen)) {
    out.push(format!("- The capacity chosen for setup (`{id}`) isn't in your list any more."));
  }
  out.push("- Team workspaces need an active F or P SKU capacity.".into());
  Ok(out.join("\n"))
}

/// Whether an identity should have a role on a Fabric workspace.
fn belongs(identity: &Identity, target: &FabricTarget) -> bool {
  match identity.role {
    "deploy" => target.label == "published apps",
    "preview" => target.label == "previews",
    _ => true,
  }
}

async fn fabric_workspace(ctx: &DiagContext, target: &FabricTarget) -> Result<String, String> {
  let id = &target.id;
  let ws = fabric::get(&format!("workspaces/{id}"))
    .await
    .map_err(|e| fabric_error(&e, &format!("the {} workspace `{id}`", target.label)))?;
  let mut out = vec![format!(
    "- `{}` (`{id}`), capacity `{}`.",
    text(&ws, "displayName").unwrap_or_default(),
    text(&ws, "capacityId").unwrap_or_else(|| "none".into())
  )];
  match fabric::role_assignments(id).await {
    Ok(roles) => {
      for r in &roles {
        let who = r.display_name.clone().or_else(|| r.email.clone()).unwrap_or_else(|| r.principal_id.clone());
        out.push(format!("- {} `{who}`: {}.", r.principal_type, r.role));
      }
      for identity in ctx.identities.iter().filter(|i| belongs(i, target)) {
        match service_principal_id(&identity.client_id).await {
          Some(sp) => match roles.iter().find(|r| r.principal_id.eq_ignore_ascii_case(&sp)) {
            Some(r) => out.push(format!("- The {} (service principal `{sp}`) has {}.", identity.describe(), r.role)),
            None => out.push(format!(
              "- MISSING: the {} (service principal `{sp}`) has no role here. It needs Contributor.",
              identity.describe()
            )),
          },
          None => out.push(format!("- The {}'s service principal wasn't found, so its role here can't be checked.", identity.describe())),
        }
      }
      if let Ok((_, user)) = entra::account().await {
        match roles.iter().find(|r| r.email.as_deref().is_some_and(|e| e.eq_ignore_ascii_case(&user))) {
          Some(r) => out.push(format!("- You (`{user}`) have {}.", r.role)),
          None => out.push(format!("- You (`{user}`) have no direct role here (you may have one through a group).")),
        }
      }
    }
    Err(e) => out.push(format!("- {}", fabric_error(&e, "its role assignments (Member or Admin can)"))),
  }
  Ok(out.join("\n"))
}

fn is_sp_setting(s: &Value) -> bool {
  text(s, "title").unwrap_or_default().to_ascii_lowercase().contains("service principal")
    || text(s, "settingName").unwrap_or_default().to_ascii_lowercase().contains("serviceprincipal")
}

fn group_names(groups: &[Value]) -> String {
  groups.iter().filter_map(|g| text(g, "name").or_else(|| text(g, "graphId"))).collect::<Vec<_>>().join(", ")
}

async fn fabric_tenant_settings(ctx: &DiagContext) -> Result<String, String> {
  let v = match fabric::get("admin/tenantsettings").await {
    Ok(v) => v,
    Err(e) if matches!(e.status, Some(401) | Some(403)) => {
      return Ok(format!(
        "- Not visible to you ({}). Only Fabric administrators can read tenant settings, so this is normal. A Fabric administrator can check \"Service principals can call Fabric public APIs\" and related settings in Tenant settings → Developer settings.",
        e.summary()
      ))
    }
    Err(e) => return Err(fabric_error(&e, "Fabric's tenant settings")),
  };
  let settings = v.get("tenantSettings").and_then(Value::as_array).cloned().unwrap_or_default();
  let relevant: Vec<&Value> = settings
    .iter()
    .filter(|s| is_sp_setting(s) || text(s, "title").unwrap_or_default().to_ascii_lowercase().contains("create workspaces"))
    .collect();
  if relevant.is_empty() {
    return Ok("- No service principal or workspace creation settings were returned.".into());
  }
  // Which groups each identity's service principal is in, for group-limited settings.
  let mut memberships: Vec<(&'static str, Vec<String>)> = Vec::new();
  for identity in &ctx.identities {
    if let Some(sp) = service_principal_id(&identity.client_id).await {
      let groups: Vec<String> = entra::graph_list(&format!("servicePrincipals/{sp}/transitiveMemberOf?$select=id"), 2)
        .await
        .map(|g| g.iter().filter_map(|x| text(x, "id")).collect())
        .unwrap_or_default();
      memberships.push((identity.describe(), groups));
    }
  }
  let mut out = Vec::new();
  for s in relevant {
    let enabled = flag(s, "enabled").unwrap_or(false);
    let groups = s.get("enabledSecurityGroups").and_then(Value::as_array).cloned().unwrap_or_default();
    let excluded = s.get("excludedSecurityGroups").and_then(Value::as_array).cloned().unwrap_or_default();
    let scope = if !enabled {
      "OFF".to_string()
    } else if groups.is_empty() {
      "on for the whole organization".to_string()
    } else {
      format!("on only for these groups: {}", group_names(&groups))
    };
    out.push(format!(
      "- \"{}\" (`{}`): {scope}{}.",
      text(s, "title").unwrap_or_default(),
      text(s, "settingName").unwrap_or_default(),
      if excluded.is_empty() { String::new() } else { format!(", except: {}", group_names(&excluded)) }
    ));
    if enabled && !groups.is_empty() && is_sp_setting(s) {
      let allowed: Vec<String> = groups.iter().filter_map(|g| text(g, "graphId")).collect();
      for (who, member_of) in &memberships {
        let inside = member_of.iter().any(|g| allowed.iter().any(|a| a.eq_ignore_ascii_case(g)));
        out.push(format!("  - The {who} is {}in one of those groups.", if inside { "" } else { "NOT " }));
      }
    }
  }
  Ok(out.join("\n"))
}

/// The first line of a tool's version output, or why there isn't one.
async fn version_of(program: &str, args: &[&str]) -> String {
  let res = exec::run(program, args, RunOptions { timeout_ms: Some(30_000), ..Default::default() }).await;
  if res.not_found {
    return "not installed".into();
  }
  let output = if res.stdout.trim().is_empty() { &res.stderr } else { &res.stdout };
  let first = output.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no output");
  if res.ok {
    first.to_string()
  } else {
    format!("failed: {first}")
  }
}

/// The Azure CLI's version, read from `az version`'s JSON (a `--query` needs
/// quotes, which `cmd.exe` mangles for `az.cmd`).
async fn az_version() -> String {
  let res = exec::run("az", &["version", "--output", "json"], RunOptions { timeout_ms: Some(30_000), ..Default::default() }).await;
  if res.not_found {
    return "not installed".into();
  }
  match serde_json::from_str::<Value>(res.stdout.trim()).ok().and_then(|v| text(&v, "azure-cli")) {
    Some(version) => version,
    None if res.ok => "unknown".into(),
    None => format!("failed: {}", res.stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no output")),
  }
}

async fn local_tools() -> Result<String, String> {
  let (gh_version, git_version, az_version) =
    tokio::join!(version_of("gh", &["--version"]), version_of("git", &["--version"]), az_version());
  Ok(format!(
    "- Fabricator {} on {} ({}).\n- GitHub CLI: {gh_version}\n- Git: {git_version}\n- Azure CLI: {az_version}",
    env!("CARGO_PKG_VERSION"),
    std::env::consts::OS,
    std::env::consts::ARCH
  ))
}

fn project_rayfin(ctx: &DiagContext) -> Result<String, String> {
  let dir = ctx.project_dir.as_ref().ok_or("The app isn't open on this computer.")?;
  Ok(match team::deploy_cli_version(dir) {
    Some(v) if team::rayfin_supported(&v) => {
      format!("- The pipeline installs Rayfin CLI {v} for this app. Team workspaces need {} or newer, so that's fine.", team::MIN_RAYFIN)
    }
    Some(v) => format!(
      "- The pipeline installs Rayfin CLI {v} for this app, but team workspaces need {} or newer.",
      team::MIN_RAYFIN
    ),
    None => "- The app's Rayfin CLI version couldn't be read (no package-lock.json or installed CLI).".into(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn guid(n: u8) -> String {
    format!("{n:08x}-0000-4000-8000-000000000000")
  }

  fn ctx_with(kind: Kind, step: &str) -> DiagContext {
    DiagContext {
      kind,
      step: Some(step.to_string()).filter(|s| !s.is_empty()),
      repo: Some("contoso/team-apps".into()),
      owner: Some("contoso".into()),
      identities: vec![
        Identity { role: "deploy", client_id: guid(1) },
        Identity { role: "preview", client_id: guid(2) },
      ],
      fabric: vec![
        FabricTarget { label: "published apps", id: guid(3) },
        FabricTarget { label: "previews", id: guid(4) },
      ],
      ..Default::default()
    }
  }

  #[test]
  fn catalog_names_round_trip() {
    for name in Check::names() {
      assert_eq!(Check::parse(name).map(|c| c.name()), Some(name));
    }
    assert_eq!(Check::parse("rm_rf"), None);
    assert!(Check::catalog().contains("`entra_federated_credentials`"));
  }

  #[test]
  fn the_renderer_shows_copilots_labels_in_the_apps_language() {
    let mut requests: Vec<Request> = CATALOG.iter().map(|(check, ..)| Request::new(*check)).collect();
    for role in ["deploy", "preview", "shared", "admin"] {
      for check in [Check::EntraApp, Check::EntraFederatedCredentials] {
        requests.push(Request { check, target: Target::Identity(Identity { role, client_id: guid(1) }) });
      }
    }
    for label in ["published apps", "previews"] {
      requests.push(Request { check: Check::FabricWorkspace, target: Target::Workspace(FabricTarget { label, id: guid(3) }) });
    }
    for check in [Check::GithubRun, Check::GithubRunLog] {
      requests.push(Request { check, target: Target::Run(Some(42)) });
    }
    for request in requests {
      assert_eq!(request.display_label(), request.label());
    }
  }

  #[test]
  fn checks_only_target_this_contexts_identities_and_workspaces() {
    let ctx = ctx_with(Kind::Setup, "trust");
    let all = requests_for(&ctx, Check::EntraApp, &Args::default()).unwrap();
    assert_eq!(all.len(), 2);
    let upper = Args { client_id: Some(guid(2).to_uppercase()), ..Default::default() };
    assert_eq!(requests_for(&ctx, Check::EntraFederatedCredentials, &upper).unwrap().len(), 1);
    let other = Args { client_id: Some(guid(9)), ..Default::default() };
    let err = requests_for(&ctx, Check::EntraApp, &other).unwrap_err();
    assert!(err.contains("isn't one of this workspace's identities"), "{err}");
    let ws = Args { workspace_id: Some(guid(7)), ..Default::default() };
    assert!(requests_for(&ctx, Check::FabricWorkspace, &ws).is_err());
    let none = DiagContext { kind: Kind::Setup, ..Default::default() };
    assert!(requests_for(&none, Check::GithubRepo, &Args::default()).unwrap_err().contains("no repository"));
    assert!(requests_for(&none, Check::EntraApp, &Args::default()).is_err());
    assert!(requests_for(&none, Check::ProjectRayfin, &Args::default()).is_err());
    let run = Args { run_id: Some(42), ..Default::default() };
    assert_eq!(requests_for(&ctx, Check::GithubRunLog, &run).unwrap()[0].target, Target::Run(Some(42)));
  }

  #[test]
  fn baselines_fit_the_failure() {
    let names = |ctx: &DiagContext| baseline_requests(ctx).iter().map(|r| r.id()).collect::<Vec<_>>();
    let verify = names(&ctx_with(Kind::Setup, "verify"));
    assert!(verify.contains(&"github_run_log".to_string()));
    assert!(verify.contains(&format!("entra_federated_credentials:{}", guid(2))));
    assert!(verify.contains(&format!("fabric_workspace:{}", guid(3))));
    assert_eq!(names(&ctx_with(Kind::Setup, "github")), vec!["github_account", "github_org"]);
    // Before the repository exists, repository checks are skipped.
    let early = DiagContext { kind: Kind::Setup, step: Some("files".into()), ..Default::default() };
    assert_eq!(names(&early), vec!["github_account"]);
    let join = DiagContext { kind: Kind::Join, error: Some("fatal: unable to access".into()), ..ctx_with(Kind::Join, "") };
    assert!(names(&join).contains(&"local_tools".to_string()));
    assert_eq!(names(&ctx_with(Kind::Pipeline, "")), vec!["github_run", "github_run_log"]);
  }

  #[test]
  fn federated_credentials_are_compared_by_name_and_subject() {
    let cred = |name: &str, subject: &str| Credential {
      name: name.into(),
      issuer: entra::GITHUB_ISSUER.into(),
      subject: subject.into(),
      audiences: vec![entra::TOKEN_EXCHANGE_AUDIENCE.into()],
    };
    let expected = vec![
      ("fabricator-main".to_string(), "repo:o/r:ref:refs/heads/main".to_string()),
      ("fabricator-pull-requests".to_string(), "repo:o/r:pull_request".to_string()),
      ("fabricator-main-ids".to_string(), "repo:o@1/r@2:ref:refs/heads/main".to_string()),
    ];
    let actual = vec![
      cred("fabricator-main", "repo:o/r:ref:refs/heads/main"),
      cred("github-prs", "repo:o/r:pull_request"),
      Credential { audiences: vec!["other".into()], ..cred("fabricator-main-ids", "repo:o@1/r@2:ref:refs/heads/dev") },
      cred("unrelated", "repo:x/y:environment:prod"),
    ];
    let lines = compare_credentials(&expected, &actual);
    assert!(lines[0].starts_with("- OK: `fabricator-main`"));
    assert!(lines[1].starts_with("- DUPLICATE:") && lines[1].contains("`github-prs`"), "{}", lines[1]);
    assert!(lines[2].starts_with("- WRONG: `fabricator-main-ids`") && lines[2].contains("refs/heads/dev") && lines[2].contains("audiences"));
    assert!(lines[3].contains("Other credential `unrelated`"));
    assert_eq!(lines.last().unwrap(), "- 4 of 20 federated credentials used.");
    let missing = compare_credentials(&expected[..1], &[]);
    assert_eq!(missing[0], "- MISSING: `fabricator-main` for `repo:o/r:ref:refs/heads/main`.");
  }

  #[test]
  fn actions_policies_are_matched_like_github() {
    assert!(glob_match("azure/*", "azure/login@v3"));
    assert!(glob_match("Azure/login@*", "azure/login@v3"));
    assert!(!glob_match("azure/login@v2", "azure/login@v3"));
    assert!(glob_match("*", "anything@v1"));
    let patterns = vec!["azure/login".to_string()];
    assert!(action_verdict("azure/login@v3", false, false, &patterns).starts_with("allowed by the pattern"));
    assert!(action_verdict("actions/checkout@v7", true, false, &[]).starts_with("allowed (GitHub-owned)"));
    assert!(action_verdict("actions/checkout@v7", false, false, &[]).starts_with("BLOCKED"));
    assert!(action_verdict("azure/login@v3", true, true, &[]).contains("verified creator"));
    assert!(action_verdict("azure/login@v3", true, false, &[]).starts_with("BLOCKED"));
    let used = workflow_actions();
    assert!(used.iter().any(|a| a.starts_with("actions/checkout@")), "{used:?}");
    // Only GitHub's own actions, so "Allow GitHub-owned actions" policies run it.
    assert!(used.iter().all(|a| action_verdict(a, true, false, &[]).starts_with("allowed (GitHub-owned)")), "{used:?}");
  }

  #[test]
  fn secrets_and_tokens_are_masked() {
    let jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOm8vciJ9.c2lnbmF0dXJlX2hlcmU";
    let masked = mask(&format!("Authorization: Bearer abcdefghijklmnop12345 token {jwt} gho_abcdefghijklmnopqrstuvwxyz0123"));
    assert!(!masked.contains("abcdefghijklmnop12345"), "{masked}");
    assert!(!masked.contains("c2lnbmF0dXJlX2hlcmU"), "{masked}");
    assert!(!masked.contains("gho_abcdefghijklmnopqrstuvwxyz0123"), "{masked}");
    assert!(masked.contains("Bearer ••••••"), "{masked}");
  }

  #[test]
  fn long_results_are_shortened() {
    assert_eq!(clip("abc", 5), "abc");
    assert_eq!(clip("abcdef", 3), "abc\n… (shortened)");
    assert_eq!(tail("abcdef", 2), "ef");
  }

  #[test]
  fn logs_lose_timestamps_colors_and_unknown_step_columns() {
    let raw = "Preview dashboard\tUNKNOWN STEP\t2026-10-04T07:53:10.1234567Z \u{1b}[36;1mnpx rayfin up\u{1b}[0m\nverify\tSign in\t2026-10-04T07:53:11Z Error: AADSTS70021";
    assert_eq!(clean_log(raw), "Preview dashboard\tnpx rayfin up\nverify\tSign in\tError: AADSTS70021");
  }
}
