//! Members of a team workspace: GitHub collaborators, who can change the apps,
//! and Fabric access, so people can open the previews and published apps.
//! Fabric access matches Share (Contributor on the workspaces). The workspaces
//! come from the repository's admin-only settings (see `TrustedTargets`), never
//! from the editable manifest.

use super::{fail, with_workspace};
use crate::services::store;
use crate::services::team::{self, entra, fabric, gh, TrustedTargets};
use crate::types::{
  TeamActionResult, TeamFabricAccess, TeamFabricPerson, TeamMember, TeamMembersResult, TeamWorkspace,
};

const MEMBER_ROLE: &str = "Contributor";

/// Owners (the Maintain or Admin role on the repository) manage who can open
/// the workspace's apps in Fabric.
async fn require_owner(ws: &TeamWorkspace) -> Result<(), String> {
  match gh::repo(&ws.repo).await {
    Ok(info) if info.manages() => Ok(()),
    Ok(_) => Err(t!("team.members.ownersOnlyAccess")),
    Err(e) => Err(e.describe(&t!("team.actions.checkAccess"))),
  }
}

/// GitHub only lets a repository's admins add and remove people.
async fn require_admin(ws: &TeamWorkspace) -> Result<(), String> {
  match gh::repo(&ws.repo).await {
    Ok(info) if info.admin => Ok(()),
    Ok(info) if info.manages() => Err(admin_only(&info.full_name)),
    Ok(_) => Err(t!("team.members.ownersOnly")),
    Err(e) => Err(e.describe(&t!("team.actions.checkAccess"))),
  }
}

/// What an owner with the Maintain role hears when they try to add or remove someone.
fn admin_only(repo: &str) -> String {
  t!("team.members.adminOnly", repo = repo)
}

fn workspace(id: &str) -> Result<TeamWorkspace, String> {
  team::require_enabled()?;
  store::find_team_workspace(id).ok_or_else(|| t!("team.workspaceMissing"))
}

/// The workspace's Fabric workspaces with their labels, from trusted settings.
/// The labels stay English: the renderer names them in the app's language.
fn fabric_targets(targets: &TrustedTargets) -> [(&'static str, String); 2] {
  [
    ("published apps", targets.production_workspace_id.clone()),
    ("previews", targets.previews_workspace_id.clone()),
  ]
}

async fn directory_user(email: &str) -> Result<String, String> {
  match entra::find_user(email).await {
    Ok(Some((id, _))) => Ok(id),
    Ok(None) => Err(t!("team.members.noSuchEmail", email = email)),
    Err(e) => Err(e.describe(&t!("team.actions.lookUpPerson"))),
  }
}

/// Give a person Contributor on both workspaces; returns their object ID.
async fn grant_fabric(targets: &TrustedTargets, email: &str) -> Result<String, String> {
  let id = directory_user(email).await?;
  for (_, target) in fabric_targets(targets).iter().filter(|(_, t)| !t.is_empty()) {
    fabric::add_role(target, &id, "User", MEMBER_ROLE)
      .await
      .map_err(|e| e.describe(&t!("team.actions.grantFabric")))?;
  }
  Ok(id)
}

async fn revoke_fabric(targets: &TrustedTargets, principal_id: &str) -> Result<(), String> {
  for (_, target) in fabric_targets(targets).iter().filter(|(_, t)| !t.is_empty()) {
    fabric::remove_role(target, principal_id).await.map_err(|e| e.describe(&t!("team.actions.revokeFabric")))?;
  }
  Ok(())
}

fn remember(ws: &TeamWorkspace, login: &str, principal_id: &str) {
  let (login, id) = (login.to_ascii_lowercase(), principal_id.to_string());
  store::mutate_team_workspace(&ws.id, |w| {
    w.fabric_members.insert(login, id);
  });
}

fn forget(ws: &TeamWorkspace, login: &str) -> Option<String> {
  let key = login.to_ascii_lowercase();
  let id = ws.fabric_members.get(&key).cloned();
  store::mutate_team_workspace(&ws.id, |w| {
    w.fabric_members.remove(&key);
  });
  id
}

#[tauri::command]
pub async fn team_members(workspace_id: String) -> TeamMembersResult {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, members(workspace_id)).await
}

async fn members(workspace_id: String) -> TeamMembersResult {
  let empty = |error: String| TeamMembersResult { ok: false, error: Some(error), members: vec![], can_manage: false };
  let ws = match workspace(&workspace_id) {
    Ok(ws) => ws,
    Err(e) => return empty(e),
  };
  let info = match gh::repo(&ws.repo).await {
    Ok(info) => info,
    Err(e) => return empty(e.describe(&t!("team.actions.openWorkspace"))),
  };
  let (collaborators, invitations) = tokio::join!(gh::collaborators(&ws.repo), gh::repo_invitations(&ws.repo));
  let mut members: Vec<TeamMember> = match collaborators {
    Ok(list) => list
      .into_iter()
      .map(|(login, avatar_url, owner)| TeamMember {
        login,
        avatar_url,
        role: if owner { "owner".into() } else { "member".into() },
        pending: false,
        invitation_id: None,
      })
      .collect(),
    Err(e) => return empty(e.describe(&t!("team.actions.listMembers"))),
  };
  for (id, login, avatar_url, owner) in invitations.unwrap_or_default() {
    members.push(TeamMember {
      login,
      avatar_url,
      role: if owner { "owner".into() } else { "member".into() },
      pending: true,
      invitation_id: Some(id),
    });
  }
  members.sort_by(|a, b| {
    (a.pending, a.role != "owner", a.login.to_lowercase()).cmp(&(b.pending, b.role != "owner", b.login.to_lowercase()))
  });
  TeamMembersResult { ok: true, error: None, members, can_manage: info.admin }
}

/// Invite someone by GitHub username. With `email`, they also get access to the
/// workspace's Fabric apps.
#[tauri::command]
pub async fn team_invite(workspace_id: String, login: String, owner: bool, email: Option<String>) -> TeamActionResult {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, invite(workspace_id, login, owner, email)).await
}

async fn invite(workspace_id: String, login: String, owner: bool, email: Option<String>) -> TeamActionResult {
  let ws = match workspace(&workspace_id) {
    Ok(ws) => ws,
    Err(e) => return fail(e),
  };
  if let Err(e) = require_admin(&ws).await {
    return fail(e);
  }
  let wanted = login.trim().trim_start_matches('@').to_string();
  if wanted.is_empty() {
    return fail(t!("team.members.enterUsername"));
  }
  let canonical = match gh::user(&wanted).await {
    Ok(Some((login, _))) => login,
    Ok(None) => return fail(t!("team.members.noSuchAccount", login = wanted)),
    Err(e) => return fail(e.describe(&t!("team.actions.lookUpAccount"))),
  };
  if let Err(e) = gh::invite(&ws.repo, &canonical, if owner { "admin" } else { "push" }).await {
    return fail(e.describe(&t!("team.actions.invite")));
  }
  let mut result = with_workspace(ws.clone());
  if let Some(email) = email.map(|e| e.trim().to_string()).filter(|e| !e.is_empty()) {
    let granted = async {
      let targets = team::trusted_targets(&ws).await?;
      grant_fabric(&targets, &email).await
    };
    match granted.await {
      Ok(id) => remember(&ws, &canonical, &id),
      Err(e) => result.error = Some(t!("team.members.invitedBut", login = canonical, error = e)),
    }
  }
  result.workspace = store::find_team_workspace(&ws.id);
  result
}

/// Give a person (by work email) access to the workspace's Fabric apps.
#[tauri::command]
pub async fn team_grant_fabric_access(workspace_id: String, email: String, login: Option<String>) -> TeamActionResult {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, grant_fabric_access(workspace_id, email, login)).await
}

async fn grant_fabric_access(workspace_id: String, email: String, login: Option<String>) -> TeamActionResult {
  let ws = match workspace(&workspace_id) {
    Ok(ws) => ws,
    Err(e) => return fail(e),
  };
  if let Err(e) = require_owner(&ws).await {
    return fail(e);
  }
  let granted = async {
    let targets = team::trusted_targets(&ws).await?;
    grant_fabric(&targets, email.trim()).await
  };
  match granted.await {
    Ok(id) => {
      if let Some(login) = login.map(|l| l.trim().to_string()).filter(|l| !l.is_empty()) {
        remember(&ws, &login, &id);
      }
      with_workspace(store::find_team_workspace(&ws.id).unwrap_or(ws))
    }
    Err(e) => fail(e),
  }
}

/// People with access to the workspace's Fabric apps (owners). The deploy
/// identities aren't listed.
#[tauri::command]
pub async fn team_fabric_access(workspace_id: String) -> TeamFabricAccess {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, fabric_access(workspace_id)).await
}

async fn fabric_access(workspace_id: String) -> TeamFabricAccess {
  let empty = |error: String| TeamFabricAccess { ok: false, error: Some(error), people: vec![] };
  let ws = match workspace(&workspace_id) {
    Ok(ws) => ws,
    Err(e) => return empty(e),
  };
  if let Err(e) = require_owner(&ws).await {
    return empty(e);
  }
  let targets = match team::trusted_targets(&ws).await {
    Ok(t) => t,
    Err(e) => return empty(e),
  };
  let members_by_id: std::collections::HashMap<&str, &str> =
    ws.fabric_members.iter().map(|(login, id)| (id.as_str(), login.as_str())).collect();
  let mut people: Vec<TeamFabricPerson> = Vec::new();
  for (label, target) in fabric_targets(&targets) {
    let assignments = match fabric::role_assignments(&target).await {
      Ok(a) => a,
      Err(e) => return empty(e.describe(&t!("team.actions.listAccess"))),
    };
    for a in assignments.into_iter().filter(|a| a.principal_type == "User" || a.principal_type == "Group") {
      match people.iter_mut().find(|p| p.principal_id == a.principal_id) {
        Some(person) => person.access.push(label.to_string()),
        None => people.push(TeamFabricPerson {
          member: members_by_id.get(a.principal_id.as_str()).map(|l| l.to_string()),
          name: a.display_name.clone().or_else(|| a.email.clone()).unwrap_or_else(|| a.principal_id.clone()),
          email: a.email,
          kind: a.principal_type,
          access: vec![label.to_string()],
          principal_id: a.principal_id,
        }),
      }
    }
  }
  people.sort_by_key(|p| p.name.to_lowercase());
  TeamFabricAccess { ok: true, error: None, people }
}

/// Remove a person's access to the workspace's Fabric apps (owners).
#[tauri::command]
pub async fn team_revoke_fabric_access(workspace_id: String, principal_id: String) -> TeamActionResult {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, revoke_fabric_access(workspace_id, principal_id)).await
}

async fn revoke_fabric_access(workspace_id: String, principal_id: String) -> TeamActionResult {
  let ws = match workspace(&workspace_id) {
    Ok(ws) => ws,
    Err(e) => return fail(e),
  };
  if let Err(e) = require_owner(&ws).await {
    return fail(e);
  }
  let targets = match team::trusted_targets(&ws).await {
    Ok(t) => t,
    Err(e) => return fail(e),
  };
  let principal_id = principal_id.trim().to_string();
  if let Err(e) = revoke_fabric(&targets, &principal_id).await {
    return fail(e);
  }
  store::mutate_team_workspace(&ws.id, |w| w.fabric_members.retain(|_, id| *id != principal_id));
  with_workspace(store::find_team_workspace(&ws.id).unwrap_or(ws))
}

/// Remove a member or cancel their invitation, along with the Fabric access
/// they were given from this computer.
#[tauri::command]
pub async fn team_remove_member(workspace_id: String, login: String, invitation_id: Option<u64>) -> TeamActionResult {
  let account = super::workspace_account(&workspace_id);
  gh::as_account(account, remove_member(workspace_id, login, invitation_id)).await
}

async fn remove_member(workspace_id: String, login: String, invitation_id: Option<u64>) -> TeamActionResult {
  let ws = match workspace(&workspace_id) {
    Ok(ws) => ws,
    Err(e) => return fail(e),
  };
  if let Err(e) = require_admin(&ws).await {
    return fail(e);
  }
  let removed = match invitation_id {
    Some(id) => gh::cancel_invitation(&ws.repo, id).await,
    None => gh::remove_collaborator(&ws.repo, login.trim()).await,
  };
  if let Err(e) = removed {
    return fail(e.describe(&t!("team.actions.removeMember")));
  }
  let mut result = with_workspace(ws.clone());
  if let Some(principal_id) = forget(&ws, login.trim()) {
    let revoked = async {
      let targets = team::trusted_targets(&ws).await?;
      revoke_fabric(&targets, &principal_id).await
    };
    if let Err(e) = revoked.await {
      result.error = Some(t!("team.members.removedBut", login = login, error = e));
    }
  }
  result.workspace = store::find_team_workspace(&ws.id);
  result
}
