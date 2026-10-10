//! GitHub-backed team workspaces (experimental; Settings → Experiments).
//!
//! A team workspace is one private GitHub repository holding several Rayfin
//! projects, one per top-level folder. Each workspace has an Entra app
//! registration (service principal) trusted by the repository through GitHub
//! OIDC, and a Fabricator-managed workflow that deploys:
//! - pull requests: a personal preview of the changed project for its author;
//! - pushes to `main`: the published app.
//!
//! Team projects never deploy from this machine. Fabricator works on a branch
//! per session, commits and pushes after each chat turn, and publishes by
//! merging the branch's pull request.

pub mod entra;
pub mod fabric;
pub mod gh;
pub mod guard;
pub mod local_preview;
pub mod naming;
pub mod repo;
pub mod templates;

use std::path::Path;

use crate::commands::rayfin_version::parse_core;
use crate::services::store;
use crate::types::{DeployInfo, StudioProject, TeamBinding, TeamDeployRecord, TeamManifest, TeamWorkspace};

/// The oldest Rayfin CLI the team pipeline can deploy with: it deploys by
/// item name (`rayfin up --item-name`), which older CLIs don't support.
pub const MIN_RAYFIN: &str = "1.36.2";

/// The Rayfin CLI version the pipeline installs for an app: the one in its
/// lockfile (`npm ci`), or the installed one when there's no lockfile.
pub fn deploy_cli_version(project_dir: &Path) -> Option<String> {
  let read = |path: std::path::PathBuf| {
    std::fs::read_to_string(path)
      .ok()
      .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
  };
  let version = |value: &serde_json::Value| value.get("version").and_then(|v| v.as_str()).map(String::from);
  read(project_dir.join("package-lock.json"))
    .and_then(|lock| lock.pointer("/packages/node_modules~1@microsoft~1rayfin-cli").and_then(version))
    .or_else(|| read(project_dir.join("node_modules/@microsoft/rayfin-cli/package.json")).as_ref().and_then(version))
}

/// Whether a Rayfin CLI version is new enough for the team pipeline.
pub fn rayfin_supported(version: &str) -> bool {
  parse_core(Some(version)) >= parse_core(Some(MIN_RAYFIN))
}

/// Why an app can't deploy from a team workspace yet, if its Rayfin is too old.
/// An app whose version can't be read passes; the pipeline checks it again.
pub fn rayfin_update_needed(project_dir: &Path, name: &str) -> Option<String> {
  let version = deploy_cli_version(project_dir)?;
  (!rayfin_supported(&version)).then(|| {
    format!(
      "{name} uses Rayfin {version}, and team workspaces need Rayfin {MIN_RAYFIN} or newer. Open the app, select Rayfin in the status bar, choose Update with Copilot, then move it again."
    )
  })
}

/// The client ID pull requests sign in with (the deploy identity's when one
/// identity serves both).
pub fn preview_client_id(manifest: &TeamManifest) -> &str {
  if manifest.preview_identity.client_id.is_empty() {
    &manifest.deploy_identity.client_id
  } else {
    &manifest.preview_identity.client_id
  }
}

/// The IDs that privileged actions (Repair, Delete, Fabric access) act on.
/// They come from the repository's Actions variables, which only repository
/// admins can change, or this computer's own setup record. They never come
/// from `fabricator.workspace.json`, which any member can edit.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TrustedTargets {
  pub tenant_id: String,
  pub deploy_client_id: String,
  /// Empty or equal to the deploy identity when one identity serves both.
  pub preview_client_id: String,
  pub production_workspace_id: String,
  pub previews_workspace_id: String,
}

impl TrustedTargets {
  pub fn separate(&self) -> bool {
    !self.preview_client_id.is_empty() && self.preview_client_id != self.deploy_client_id
  }

  pub fn preview_or_deploy(&self) -> &str {
    if self.preview_client_id.is_empty() {
      &self.deploy_client_id
    } else {
      &self.preview_client_id
    }
  }

  /// The manifest says the same as the trusted settings.
  pub fn matches(&self, manifest: &TeamManifest) -> bool {
    manifest.deploy_identity.client_id == self.deploy_client_id
      && preview_client_id(manifest) == self.preview_or_deploy()
      && manifest.fabric.production.id == self.production_workspace_id
      && manifest.fabric.previews.id == self.previews_workspace_id
  }
}

async fn variable(repo: &str, name: &str) -> Option<String> {
  gh::variable(repo, name).await.ok().flatten().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Combine the repository variables with this computer's setup record.
fn combine(vars: [Option<String>; 5], setup: Option<&crate::types::TeamSetupState>) -> TrustedTargets {
  let [deploy, preview, tenant, production, previews] = vars;
  let local = |f: fn(&crate::types::TeamSetupState) -> Option<&String>| setup.and_then(f).filter(|s| !s.is_empty()).cloned();
  TrustedTargets {
    deploy_client_id: deploy.or_else(|| local(|s| s.app_id.as_ref())).unwrap_or_default(),
    preview_client_id: preview
      .or_else(|| local(|s| s.preview_app_id.as_ref()))
      .or_else(|| local(|s| s.app_id.as_ref()))
      .unwrap_or_default(),
    tenant_id: tenant.or_else(|| local(|s| s.tenant_id.as_ref())).unwrap_or_default(),
    production_workspace_id: production.or_else(|| local(|s| s.production_workspace_id.as_ref())).unwrap_or_default(),
    previews_workspace_id: previews.or_else(|| local(|s| s.previews_workspace_id.as_ref())).unwrap_or_default(),
  }
}

pub async fn trusted_targets(ws: &TeamWorkspace) -> Result<TrustedTargets, String> {
  let (deploy, preview, tenant, production, previews) = tokio::join!(
    variable(&ws.repo, "AZURE_CLIENT_ID"),
    variable(&ws.repo, "AZURE_PREVIEW_CLIENT_ID"),
    variable(&ws.repo, "AZURE_TENANT_ID"),
    variable(&ws.repo, "FABRIC_WORKSPACE_ID"),
    variable(&ws.repo, "FABRIC_PREVIEW_WORKSPACE_ID"),
  );
  let targets = combine([deploy, preview, tenant, production, previews], ws.setup.as_ref());
  if targets.deploy_client_id.is_empty() || targets.production_workspace_id.is_empty() || targets.previews_workspace_id.is_empty() {
    return Err(
      "The workspace's pipeline settings are missing on GitHub. The owner who set the workspace up can repair them from its settings.".into(),
    );
  }
  Ok(targets)
}

/// Message for team commands while the experiment is off.
pub const DISABLED: &str =
  "Team workspaces are an experimental feature. Turn them on in Settings → Experiments.";

/// Fail when the Team workspaces experiment is off.
pub fn require_enabled() -> Result<(), String> {
  if store::team_workspaces_enabled() {
    Ok(())
  } else {
    Err(DISABLED.to_string())
  }
}

/// Message for local deploy commands on team projects.
pub const NO_LOCAL_DEPLOY: &str =
  "This project belongs to a team workspace, so the team pipeline deploys it. Use Publish instead.";

/// True when the project lives in a team workspace (whatever the experiment says).
pub fn is_team_project(project: &StudioProject) -> bool {
  project.team.is_some()
}

/// True when the stored project with `id` lives in a team workspace.
pub fn is_team_project_id(id: &str) -> bool {
  store::find_project(id).is_some_and(|p| is_team_project(&p))
}

/// A team project with its binding and workspace.
pub struct TeamProject {
  pub project: StudioProject,
  pub binding: TeamBinding,
  pub workspace: TeamWorkspace,
}

/// Resolve a project id to its team binding and workspace.
pub fn team_project(id: &str) -> Result<TeamProject, String> {
  require_enabled()?;
  let project = store::find_project(id).ok_or("Project not found.")?;
  let binding = project.team.clone().ok_or("This project isn't in a team workspace.")?;
  let workspace = store::find_team_workspace(&binding.workspace_id)
    .ok_or("This project's team workspace is no longer on this machine.")?;
  Ok(TeamProject { project, binding, workspace })
}

/// Persist changes to a project's team binding.
pub fn save_binding(project_id: &str, f: impl FnOnce(&mut TeamBinding)) -> Option<StudioProject> {
  store::mutate_project(project_id, |p| {
    if let Some(binding) = p.team.as_mut() {
      f(binding);
    }
  });
  store::find_project(project_id)
}

/// Guidance prepended to each chat message in a team project. Skills are shared
/// by every project, so the team-specific rules travel with the message.
pub const CHAT_NOTE: &str = "[Fabricator: this app is in a team workspace. When auto-deploy after chat is enabled, Fabricator saves the changes to the team's working branch on GitHub at turn end, and the team pipeline deploys a personal preview. When paused, changes stay local until the user deploys. Don't deploy, sign in to Rayfin, or run git branch, push or merge commands, or gh: Fabricator handles those.]";

/// The text sent to Copilot for a chat message in `project_id`.
pub fn chat_text(project_id: &str, text: &str) -> String {
  if is_team_project_id(project_id) {
    format!("{CHAT_NOTE}\n\n{text}")
  } else {
    text.to_string()
  }
}

/// The preview pane's deployment info for a pipeline record.
pub fn deploy_info(record: &TeamDeployRecord) -> DeployInfo {
  let status = match record.state.as_str() {
    "success" => "success",
    "failure" | "error" => "error",
    "inactive" => "success",
    _ => "deploying",
  };
  DeployInfo {
    url: record.url.clone().or_else(|| record.api_url.clone()).or_else(|| record.portal_url.clone()),
    api_url: record.api_url.clone(),
    portal_url: record.portal_url.clone(),
    status: Some(status.to_string()),
    outcome: Some(if status == "error" { "error".to_string() } else { "success".to_string() }),
    error: (status == "error").then(|| match record.reason.as_deref() {
      Some("data-loss") => "The pipeline stopped because this change would delete data in the published app.".to_string(),
      Some("rayfin-update") => format!(
        "The pipeline needs Rayfin {MIN_RAYFIN} or newer to deploy this app. Select Rayfin in the status bar and choose Update with Copilot; the pipeline deploys again once the update is saved."
      ),
      _ => "The team pipeline couldn't deploy this version. Open the run on GitHub for details.".to_string(),
    }),
    at: record.updated_at.clone(),
    commit: record.sha.clone(),
  }
}

/// Which record the preview shows: your preview while you have one (and asked
/// for it), otherwise the published app.
pub fn shown_record(binding: &TeamBinding) -> Option<&TeamDeployRecord> {
  let want_preview = binding.view.as_deref() != Some("production");
  if want_preview {
    binding.preview.as_ref().filter(|r| r.url.is_some()).or(binding.production.as_ref())
  } else {
    binding.production.as_ref()
  }
}

/// Point the project's `last_deploy` (what the preview loads) at the shown record.
pub fn apply_view(project_id: &str) -> Option<StudioProject> {
  store::mutate_project(project_id, |p| {
    if let Some(binding) = p.team.as_ref() {
      p.last_deploy = shown_record(binding).map(deploy_info);
    }
  });
  store::find_project(project_id)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn trusted_targets_prefer_admin_variables_then_this_computers_setup() {
    let setup = crate::types::TeamSetupState {
      app_id: Some("local-deploy".into()),
      preview_app_id: Some("local-preview".into()),
      production_workspace_id: Some("local-prod".into()),
      previews_workspace_id: Some("local-previews".into()),
      tenant_id: Some("local-tenant".into()),
      ..Default::default()
    };
    let from_vars = combine(
      [Some("d".into()), Some("p".into()), Some("t".into()), Some("w1".into()), Some("w2".into())],
      Some(&setup),
    );
    assert_eq!(from_vars.deploy_client_id, "d");
    assert!(from_vars.separate());
    let from_setup = combine([None, None, None, None, None], Some(&setup));
    assert_eq!(from_setup.preview_client_id, "local-preview");
    assert_eq!(from_setup.production_workspace_id, "local-prod");
    // A single shared identity: the preview falls back to the deploy identity.
    let shared = combine([Some("d".into()), None, None, Some("w1".into()), Some("w2".into())], None);
    assert!(!shared.separate());
    assert_eq!(shared.preview_or_deploy(), "d");
  }

  #[test]
  fn a_tampered_manifest_doesnt_match_the_trusted_settings() {
    let targets = combine([Some("d".into()), Some("p".into()), None, Some("w1".into()), Some("w2".into())], None);
    let mut manifest = TeamManifest::default();
    manifest.deploy_identity.client_id = "d".into();
    manifest.preview_identity.client_id = "p".into();
    manifest.fabric.production.id = "w1".into();
    manifest.fabric.previews.id = "w2".into();
    assert!(targets.matches(&manifest));
    manifest.preview_identity.client_id.clear();
    assert!(!targets.matches(&manifest), "dropping the preview identity is tampering");
    manifest.preview_identity.client_id = "p".into();
    manifest.fabric.production.id = "someone-elses".into();
    assert!(!targets.matches(&manifest));
  }

  fn record(env: &str, state: &str, url: Option<&str>) -> TeamDeployRecord {
    TeamDeployRecord {
      environment: env.into(),
      state: state.into(),
      url: url.map(String::from),
      ..Default::default()
    }
  }

  #[test]
  fn the_pipeline_needs_a_rayfin_cli_that_deploys_by_item_name() {
    assert!(rayfin_supported(MIN_RAYFIN));
    assert!(rayfin_supported("1.37.0-alpha.1"));
    assert!(rayfin_supported("2.0.0"));
    assert!(!rayfin_supported("1.35.1"));
    assert!(!rayfin_supported("not a version"));
  }

  #[test]
  fn the_lockfile_decides_which_rayfin_cli_the_pipeline_installs() {
    let dir = std::env::temp_dir().join(format!("fab-rayfin-{}", uuid::Uuid::new_v4()));
    let cli = dir.join("node_modules/@microsoft/rayfin-cli");
    std::fs::create_dir_all(&cli).unwrap();
    assert_eq!(deploy_cli_version(&dir), None);
    assert_eq!(rayfin_update_needed(&dir, "Leads"), None, "unknown versions are left to the pipeline");
    std::fs::write(cli.join("package.json"), r#"{"version":"1.36.2"}"#).unwrap();
    assert_eq!(deploy_cli_version(&dir).as_deref(), Some("1.36.2"));
    std::fs::write(
      dir.join("package-lock.json"),
      r#"{"packages":{"node_modules/@microsoft/rayfin-cli":{"version":"1.35.1"}}}"#,
    )
    .unwrap();
    assert_eq!(deploy_cli_version(&dir).as_deref(), Some("1.35.1"));
    let why = rayfin_update_needed(&dir, "Leads").unwrap();
    assert!(why.contains("Leads uses Rayfin 1.35.1") && why.contains(MIN_RAYFIN), "{why}");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn records_map_to_preview_states() {
    assert_eq!(deploy_info(&record("p", "success", Some("https://a"))).status.as_deref(), Some("success"));
    assert_eq!(deploy_info(&record("p", "in_progress", None)).status.as_deref(), Some("deploying"));
    let failed = deploy_info(&TeamDeployRecord { reason: Some("data-loss".into()), ..record("p", "failure", None) });
    assert_eq!(failed.status.as_deref(), Some("error"));
    assert!(failed.error.unwrap().contains("delete data"));
    let outdated = deploy_info(&TeamDeployRecord { reason: Some("rayfin-update".into()), ..record("p", "failure", None) });
    assert!(outdated.error.unwrap().contains(MIN_RAYFIN));
  }

  #[test]
  fn the_preview_shows_your_preview_until_you_pick_the_published_app() {
    let mut binding = TeamBinding {
      preview: Some(record("preview/app/amy", "success", Some("https://preview"))),
      production: Some(record("production/app", "success", Some("https://prod"))),
      ..Default::default()
    };
    assert_eq!(shown_record(&binding).unwrap().url.as_deref(), Some("https://preview"));
    binding.view = Some("production".into());
    assert_eq!(shown_record(&binding).unwrap().url.as_deref(), Some("https://prod"));
    binding.view = None;
    binding.preview = Some(record("preview/app/amy", "in_progress", None));
    assert_eq!(shown_record(&binding).unwrap().url.as_deref(), Some("https://prod"));
  }
}
