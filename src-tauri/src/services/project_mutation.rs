//! Source-writing chat turns and deployments share one per-project lease, so a
//! deploy never publishes a half-written turn and a turn never edits source
//! while `rayfin up` is packaging it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Owner {
  Chat,
  Deploy,
  Team,
  Secrets,
  Handoff,
}

impl Owner {
  fn busy_message(self) -> &'static str {
    match self {
      Owner::Chat => "Copilot is still working on this project. Wait for the turn to finish (or stop it), then try again.",
      Owner::Deploy => "Fabricator is publishing this project. Wait for it to finish, then try again.",
      Owner::Team => "Fabricator is saving or publishing this project. Wait for it to finish, then try again.",
      Owner::Secrets => "Fabricator is updating this app's secrets. Wait for it to finish, then try again.",
      Owner::Handoff => "Fabricator is packing this project for a hand-off. Wait for it to finish, then try again.",
    }
  }
}

struct Lease {
  generation: String,
  owner: Owner,
}

#[derive(Clone, Default)]
pub struct ProjectMutations {
  inner: Arc<Mutex<HashMap<String, Lease>>>,
}

/// Releases the project's lease when dropped (only if it still owns it).
pub struct MutationGuard {
  state: ProjectMutations,
  project_id: String,
  generation: String,
}

impl Drop for MutationGuard {
  fn drop(&mut self) {
    let mut map = self.state.inner.lock().unwrap();
    if map.get(&self.project_id).is_some_and(|l| l.generation == self.generation) {
      map.remove(&self.project_id);
    }
  }
}

impl ProjectMutations {
  fn acquire(&self, project_id: &str, owner: Owner) -> Result<MutationGuard, String> {
    let mut map = self.inner.lock().map_err(|_| "Project mutation ownership is unavailable.")?;
    if let Some(existing) = map.get(project_id) {
      return Err(existing.owner.busy_message().into());
    }
    let generation = uuid::Uuid::new_v4().to_string();
    map.insert(project_id.to_string(), Lease { generation: generation.clone(), owner });
    Ok(MutationGuard { state: self.clone(), project_id: project_id.to_string(), generation })
  }

  /// Lease the project for a source-writing chat turn.
  pub fn chat(&self, project_id: &str) -> Result<MutationGuard, String> {
    self.acquire(project_id, Owner::Chat)
  }

  /// Lease the project for a deployment (or deployment switch).
  pub fn deploy(&self, project_id: &str) -> Result<MutationGuard, String> {
    self.acquire(project_id, Owner::Deploy)
  }

  /// Lease a team project while Fabricator commits, pushes, updates or
  /// publishes its working branch.
  pub fn team(&self, project_id: &str) -> Result<MutationGuard, String> {
    self.acquire(project_id, Owner::Team)
  }

  /// Lease the project while the Rayfin CLI sets or deletes a secret: it
  /// rewrites `rayfin/rayfin.yml`, which a turn or a deploy may be using.
  pub fn secrets(&self, project_id: &str) -> Result<MutationGuard, String> {
    self.acquire(project_id, Owner::Secrets)
  }

  /// Lease the project while its files are packed into a hand-off, so the .zip
  /// never holds a half-written turn or a half-updated publishing record.
  pub fn handoff(&self, project_id: &str) -> Result<MutationGuard, String> {
    self.acquire(project_id, Owner::Handoff)
  }

  #[cfg(test)]
  pub fn busy(&self, project_id: &str) -> bool {
    self.inner.lock().unwrap().contains_key(project_id)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn chat_and_deploy_exclude_each_other_until_released() {
    let state = ProjectMutations::default();
    let chat = state.chat("p").unwrap();
    assert!(state.deploy("p").err().unwrap().contains("Copilot is still working"));
    assert!(state.chat("p").is_err());
    drop(chat);
    let deploy = state.deploy("p").unwrap();
    assert!(state.chat("p").err().unwrap().contains("is publishing"));
    drop(deploy);
    assert!(!state.busy("p"));
  }

  #[test]
  fn leases_are_per_project() {
    let state = ProjectMutations::default();
    let a = state.chat("p").unwrap();
    let b = state.deploy("q").unwrap();
    assert!(state.busy("p") && state.busy("q"));
    drop(a);
    assert!(!state.busy("p"));
    assert!(state.chat("p").is_ok());
    drop(b);
    assert!(!state.busy("q"));
  }

  #[test]
  fn team_work_excludes_chat_turns() {
    let state = ProjectMutations::default();
    let team = state.team("p").unwrap();
    assert!(state.chat("p").err().unwrap().contains("publishing"));
    drop(team);
    let chat = state.chat("p").unwrap();
    assert!(state.team("p").err().unwrap().contains("Copilot is still working"));
    drop(chat);
  }

  #[test]
  fn secret_changes_exclude_turns_and_deploys() {
    let state = ProjectMutations::default();
    let secrets = state.secrets("p").unwrap();
    assert!(state.deploy("p").err().unwrap().contains("secrets"));
    assert!(state.chat("p").err().unwrap().contains("secrets"));
    drop(secrets);
    let deploy = state.deploy("p").unwrap();
    assert!(state.secrets("p").err().unwrap().contains("is publishing"));
    drop(deploy);
  }
}
