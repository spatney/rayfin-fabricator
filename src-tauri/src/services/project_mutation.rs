//! Source-writing chat, Design Apply and deployment share one project lease.
//! An Apply deliberately retains it between source completion and deployment.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApplyStage {
  Editing,
  WaitingDeploy,
  Deploying,
  Verifying,
  Finishing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Owner {
  Chat,
  Deploy,
  DraftReset,
  Apply { id: String, stage: ApplyStage },
}

struct Lease {
  generation: String,
  owner: Owner,
}

#[derive(Clone, Default)]
pub struct ProjectMutations {
  inner: Arc<Mutex<HashMap<String, Lease>>>,
}

pub struct MutationGuard {
  state: ProjectMutations,
  project_id: String,
  generation: String,
  retained: bool,
}

impl MutationGuard {
  pub fn retain(mut self) {
    self.retained = true;
  }
}

impl Drop for MutationGuard {
  fn drop(&mut self) {
    if !self.retained {
      let mut map = self.state.inner.lock().unwrap();
      if map.get(&self.project_id).is_some_and(|l| l.generation == self.generation) {
        map.remove(&self.project_id);
      }
    }
  }
}

impl ProjectMutations {
  fn acquire(&self, project_id: &str, owner: Owner) -> Result<MutationGuard, String> {
    let mut map = self.inner.lock().map_err(|_| "Project mutation ownership is unavailable.")?;
    if map.contains_key(project_id) {
      return Err(
        "This project is busy with chat, Design Apply, or deployment. Finish or cancel that work first.".into(),
      );
    }
    let generation = uuid::Uuid::new_v4().to_string();
    map.insert(project_id.to_string(), Lease { generation: generation.clone(), owner });
    Ok(MutationGuard { state: self.clone(), project_id: project_id.to_string(), generation, retained: false })
  }

  pub fn chat(&self, project_id: &str) -> Result<MutationGuard, String> {
    self.acquire(project_id, Owner::Chat)
  }

  pub fn apply(&self, project_id: &str, apply_id: &str) -> Result<MutationGuard, String> {
    self.acquire(project_id, Owner::Apply { id: apply_id.to_string(), stage: ApplyStage::Editing })
  }

  pub fn deploy(&self, project_id: &str, apply_id: Option<&str>) -> Result<MutationGuard, String> {
    let Some(id) = apply_id else {
      return self.acquire(project_id, Owner::Deploy);
    };
    let mut map = self.inner.lock().map_err(|_| "Project mutation ownership is unavailable.")?;
    if let Some(lease) = map.get_mut(project_id) {
      if lease.owner != (Owner::Apply { id: id.to_string(), stage: ApplyStage::WaitingDeploy }) {
        return Err("A conflicting project mutation is still running; Design deployment was not started.".into());
      }
      lease.owner = Owner::Apply { id: id.to_string(), stage: ApplyStage::Deploying };
      return Ok(MutationGuard {
        state: self.clone(),
        project_id: project_id.to_string(),
        generation: lease.generation.clone(),
        retained: false,
      });
    }
    // Recovery after restart: the caller must validate the durable receipt and
    // strong content revision before invoking the deploy engine.
    let generation = uuid::Uuid::new_v4().to_string();
    map.insert(
      project_id.to_string(),
      Lease {
        generation: generation.clone(),
        owner: Owner::Apply { id: id.to_string(), stage: ApplyStage::Deploying },
      },
    );
    Ok(MutationGuard { state: self.clone(), project_id: project_id.to_string(), generation, retained: false })
  }

  pub fn transition(&self, project_id: &str, id: &str, from: ApplyStage, to: ApplyStage) -> Result<(), String> {
    let mut map = self.inner.lock().map_err(|_| "Project mutation ownership is unavailable.")?;
    let lease = map.get_mut(project_id).ok_or("Design Apply no longer owns this project.")?;
    if lease.owner != (Owner::Apply { id: id.to_string(), stage: from }) {
      return Err("Stale Design Apply ownership or phase.".into());
    }
    lease.owner = Owner::Apply { id: id.to_string(), stage: to };
    Ok(())
  }

  pub fn is_apply(&self, project_id: &str, id: &str, stage: ApplyStage) -> bool {
    self.inner.lock().unwrap().get(project_id).is_some_and(|l| l.owner == Owner::Apply { id: id.to_string(), stage })
  }

  pub fn apply_id(&self, project_id: &str) -> Option<String> {
    match self.inner.lock().unwrap().get(project_id).map(|l| &l.owner) {
      Some(Owner::Apply { id, .. }) => Some(id.clone()),
      _ => None,
    }
  }

  #[cfg(test)]
  pub fn busy(&self, project_id: &str) -> bool {
    self.inner.lock().unwrap().contains_key(project_id)
  }

  pub fn finishing(&self, project_id: &str, id: &str) -> Result<MutationGuard, String> {
    let mut map = self.inner.lock().map_err(|_| "Project mutation ownership is unavailable.")?;
    let generation = if let Some(lease) = map.get_mut(project_id) {
      match &lease.owner {
        Owner::Apply { id: active, stage: ApplyStage::WaitingDeploy | ApplyStage::Verifying } if active == id => {}
        _ => return Err("Cannot finish Design Apply while a source or deployment process is running.".into()),
      }
      lease.owner = Owner::Apply { id: id.to_string(), stage: ApplyStage::Finishing };
      lease.generation.clone()
    } else {
      let generation = uuid::Uuid::new_v4().to_string();
      map.insert(
        project_id.to_string(),
        Lease {
          generation: generation.clone(),
          owner: Owner::Apply { id: id.to_string(), stage: ApplyStage::Finishing },
        },
      );
      generation
    };
    Ok(MutationGuard { state: self.clone(), project_id: project_id.to_string(), generation, retained: false })
  }

  pub fn resetting_draft(&self, project_id: &str) -> Result<MutationGuard, String> {
    let mut map = self.inner.lock().map_err(|_| "Project mutation ownership is unavailable.")?;
    let generation = if let Some(lease) = map.get_mut(project_id) {
      if !matches!(lease.owner, Owner::Apply { stage: ApplyStage::WaitingDeploy | ApplyStage::Verifying, .. }) {
        return Err(
          "Wait for the running chat, Apply, or deployment process to finish before starting a fresh draft.".into(),
        );
      }
      lease.owner = Owner::DraftReset;
      lease.generation.clone()
    } else {
      let generation = uuid::Uuid::new_v4().to_string();
      map.insert(project_id.to_string(), Lease { generation: generation.clone(), owner: Owner::DraftReset });
      generation
    };
    Ok(MutationGuard { state: self.clone(), project_id: project_id.to_string(), generation, retained: false })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn design_apply_owns_source_through_deploy_and_finish() {
    let state = ProjectMutations::default();
    let guard = state.apply("p", "a").unwrap();
    assert!(state.chat("p").is_err());
    assert!(state.deploy("p", None).is_err());
    assert!(state.deploy("p", Some("a")).is_err());
    assert!(state.finishing("p", "a").is_err());
    state.transition("p", "a", ApplyStage::Editing, ApplyStage::WaitingDeploy).unwrap();
    guard.retain();
    assert!(state.chat("p").is_err());
    assert!(state.deploy("p", Some("wrong")).is_err());
    let deploy = state.deploy("p", Some("a")).unwrap();
    assert!(state.deploy("p", Some("a")).is_err());
    state.transition("p", "a", ApplyStage::Deploying, ApplyStage::Verifying).unwrap();
    deploy.retain();
    drop(state.finishing("p", "a").unwrap());
    assert!(state.chat("p").is_ok());
  }

  #[test]
  fn design_mutation_failures_release_and_other_projects_are_independent() {
    let state = ProjectMutations::default();
    let a = state.apply("p", "a").unwrap();
    let b = state.chat("q").unwrap();
    drop(a);
    assert!(state.chat("p").is_ok());
    drop(b);
    assert!(!state.busy("q"));
  }

  #[test]
  fn design_finish_and_fresh_draft_exclude_queued_deployment_acquisition() {
    let state = ProjectMutations::default();
    let source = state.apply("p", "a").unwrap();
    assert!(state.resetting_draft("p").is_err());
    state.transition("p", "a", ApplyStage::Editing, ApplyStage::WaitingDeploy).unwrap();
    source.retain();
    let finish = state.finishing("p", "a").unwrap();
    assert!(state.deploy("p", Some("a")).is_err());
    assert!(state.resetting_draft("p").is_err());
    drop(finish);
    let retry = state.deploy("p", Some("a")).unwrap();
    assert!(state.resetting_draft("p").is_err());
    state.transition("p", "a", ApplyStage::Deploying, ApplyStage::Verifying).unwrap();
    retry.retain();
    let reset = state.resetting_draft("p").unwrap();
    assert!(state.deploy("p", Some("a")).is_err());
    assert!(state.chat("p").is_err());
    drop(reset);
    assert!(state.chat("p").is_ok());
  }
}
