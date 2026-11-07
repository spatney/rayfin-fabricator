//! The live preview of a team app that this computer's local backend can't run
//! all of (a Fabric-only connector, or a Rayfin version it can't start). Every
//! other team app runs on its local backend, like any app. The workspace's
//! pipeline deploys team apps, so this computer has no `rayfin/.env` pointing at
//! a backend: before such a preview starts, the app's `rayfin/.env` is pointed
//! at your personal preview's deployment or, without one, the published app's.

use std::collections::BTreeMap;
use std::path::Path;

use crate::services::exec::{self, RunOptions};
use crate::types::{TeamBinding, TeamDeployRecord};

/// Settings a deployment writes to `rayfin/.env` (the Rayfin CLI's public
/// projection of a deployment). They're replaced together, so a key a newer
/// deployment no longer has doesn't linger.
const DEPLOYMENT_KEYS: &[&str] = &[
  "RAYFIN_PUBLIC_API_URL",
  "RAYFIN_PUBLIC_PUBLISHABLE_KEY",
  "RAYFIN_PUBLIC_ITEM_ID",
  "RAYFIN_PUBLIC_WORKSPACE_ID",
  "RAYFIN_PUBLIC_TENANT_ID",
  "RAYFIN_PUBLIC_PORTAL_URL",
];

/// Which deployment a local preview talks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
  /// Your personal preview (deployed by the pipeline when you publish).
  Preview,
  /// The published app: real data.
  Published,
  /// Nothing is deployed yet.
  None,
}

impl Backend {
  pub fn as_str(self) -> &'static str {
    match self {
      Backend::Preview => "preview",
      Backend::Published => "production",
      Backend::None => "none",
    }
  }
}

fn usable(record: &TeamDeployRecord) -> bool {
  !record.public_env.is_empty() || (record.item_id.is_some() && record.workspace_id.is_some())
}

/// Your preview once it's deployed, otherwise the published app.
pub fn choose(binding: &TeamBinding) -> (Backend, Option<&TeamDeployRecord>) {
  if let Some(record) = binding.preview.as_ref().filter(|r| usable(r)) {
    return (Backend::Preview, Some(record));
  }
  if let Some(record) = binding.production.as_ref().filter(|r| usable(r)) {
    return (Backend::Published, Some(record));
  }
  (Backend::None, None)
}

/// Point `rayfin/.env` at a deployment: its settings replace the deployment
/// settings there, and everything else (comments, the local port, the app's own
/// settings) is kept. Returns whether the file changed.
pub fn write_public_env(project_dir: &Path, env: &BTreeMap<String, String>) -> std::io::Result<bool> {
  let path = project_dir.join("rayfin").join(".env");
  let existing = std::fs::read_to_string(&path).unwrap_or_default();
  let replaced = |key: &str| env.contains_key(key) || DEPLOYMENT_KEYS.contains(&key);
  let mut next: String = existing
    .lines()
    .filter(|line| {
      let key = line.split_once('=').map(|(k, _)| k.trim()).unwrap_or_default();
      !replaced(key)
    })
    .map(|line| format!("{line}\n"))
    .collect();
  if existing.trim().is_empty() {
    next = "# Rayfin environment configuration\n# Written by Fabricator from the team pipeline's deployment.\n\n".into();
  }
  for (key, value) in env {
    next.push_str(&format!("{key}={value}\n"));
  }
  if next == existing {
    return Ok(false);
  }
  std::fs::create_dir_all(project_dir.join("rayfin"))?;
  std::fs::write(&path, next)?;
  Ok(true)
}

/// A Fabric ID (a GUID), safe to pass on: it can't be read as an option.
fn is_id(value: &str) -> bool {
  value.len() <= 64
    && value.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
    && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Ask the app's own Rayfin CLI to read a deployment's settings from Fabric
/// (with the cached sign-in only) and write them to `rayfin/.env`. For
/// deployments recorded before the pipeline saved these settings.
async fn hydrate_with_cli(project_dir: &Path, workspace_id: &str, item_id: &str) -> Result<(), String> {
  const SCRIPT: &str = "const [root, workspaceId, itemId, file] = process.argv.slice(1); const { pathToFileURL } = await import('node:url'); const { hydrateDeploymentFromFabric } = await import(pathToFileURL(file).href); await hydrateDeploymentFromFabric({ projectRoot: root, workspaceId, itemId });";
  if !is_id(workspace_id) || !is_id(item_id) {
    return Err("the deployment record isn't valid".into());
  }
  let module = project_dir.join("node_modules/@microsoft/rayfin-cli/dist/utils/hydrate-deployment.js");
  if !module.exists() {
    return Err("this app's Rayfin CLI can't read deployments".into());
  }
  let node = which::which("node").map_err(|_| "Node.js wasn't found".to_string())?;
  let root = project_dir.to_string_lossy().to_string();
  let file = module.to_string_lossy().to_string();
  let res = exec::run(
    &node.to_string_lossy(),
    &["--input-type=module", "-e", SCRIPT, &root, workspace_id, item_id, &file],
    RunOptions { cwd: Some(project_dir.to_path_buf()), timeout_ms: Some(45_000), ..Default::default() },
  )
  .await;
  if res.ok {
    return Ok(());
  }
  let detail = res
    .stderr
    .lines()
    .map(str::trim)
    .filter(|l| !l.is_empty() && !l.starts_with("at "))
    .find(|l| l.contains("Error") || l.contains("Run `rayfin login`") || l.contains("Fabric"))
    .unwrap_or("Fabric sign-in is needed")
    .chars()
    .take(240)
    .collect::<String>();
  Err(detail)
}

/// Point the app's `rayfin/.env` at the deployment its local preview uses, and
/// say which one in the preview log.
pub async fn prepare(project_dir: &Path, binding: &TeamBinding, log: impl Fn(&str)) -> Backend {
  let (backend, record) = choose(binding);
  let Some(record) = record else {
    log("This app isn't deployed yet, so the live preview runs without data until the team pipeline deploys it.\n");
    return Backend::None;
  };
  if backend == Backend::Preview {
    log("The live preview uses your preview's data (deployed by the team pipeline when you last published).\n");
  } else {
    log("You don't have a preview, so the live preview uses the published app's data. Changes you make in it are real.\n");
  }
  if !record.public_env.is_empty() {
    if let Err(e) = write_public_env(project_dir, &record.public_env) {
      log(&format!("Couldn't update rayfin/.env: {e}\n"));
    }
    return backend;
  }
  if let (Some(workspace_id), Some(item_id)) = (record.workspace_id.as_deref(), record.item_id.as_deref()) {
    if let Err(e) = hydrate_with_cli(project_dir, workspace_id, item_id).await {
      log(&format!(
        "Couldn't read the deployment's settings: {e}. Sign in to Fabric, or update the workspace's pipeline (Manage → Settings → Repair) and publish again.\n"
      ));
    }
  }
  backend
}

#[cfg(test)]
mod tests {
  use super::*;

  fn record(env: &[(&str, &str)], item: Option<&str>) -> TeamDeployRecord {
    TeamDeployRecord {
      environment: "x".into(),
      state: "success".into(),
      item_id: item.map(String::from),
      workspace_id: item.map(|_| "ws".to_string()),
      public_env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
      ..Default::default()
    }
  }

  #[test]
  fn local_previews_prefer_your_preview_then_the_published_app() {
    let mut binding = TeamBinding::default();
    assert_eq!(choose(&binding).0, Backend::None);
    binding.production = Some(record(&[], Some("prod-item")));
    assert_eq!(choose(&binding).0, Backend::Published);
    // A preview without anything to connect to doesn't count.
    binding.preview = Some(record(&[], None));
    assert_eq!(choose(&binding).0, Backend::Published);
    binding.preview = Some(record(&[("RAYFIN_PUBLIC_API_URL", "https://preview")], None));
    let (backend, chosen) = choose(&binding);
    assert_eq!((backend, chosen.unwrap().public_env["RAYFIN_PUBLIC_API_URL"].as_str()), (Backend::Preview, "https://preview"));
    assert_eq!(Backend::Published.as_str(), "production");
  }

  #[test]
  fn rayfin_env_gets_the_deployments_settings_and_keeps_the_rest() {
    let dir = std::env::temp_dir().join(format!("fab-env-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("rayfin")).unwrap();
    std::fs::write(
      dir.join("rayfin/.env"),
      "# Rayfin\nRAYFIN_PUBLIC_FRONTEND_PORT=5173\nRAYFIN_PUBLIC_API_URL=https://old\nRAYFIN_PUBLIC_PORTAL_URL=https://old-portal\nRAYFIN_PUBLIC_MAPS_KEY=mine\n",
    )
    .unwrap();
    let env: BTreeMap<String, String> = [("RAYFIN_PUBLIC_API_URL", "https://new"), ("RAYFIN_PUBLIC_ITEM_ID", "item")]
      .into_iter()
      .map(|(k, v)| (k.to_string(), v.to_string()))
      .collect();
    assert!(write_public_env(&dir, &env).unwrap());
    let text = std::fs::read_to_string(dir.join("rayfin/.env")).unwrap();
    assert_eq!(
      text,
      "# Rayfin\nRAYFIN_PUBLIC_FRONTEND_PORT=5173\nRAYFIN_PUBLIC_MAPS_KEY=mine\nRAYFIN_PUBLIC_API_URL=https://new\nRAYFIN_PUBLIC_ITEM_ID=item\n"
    );
    assert!(!write_public_env(&dir, &env).unwrap(), "writing the same settings again changes nothing");
    let fresh = dir.join("fresh");
    assert!(write_public_env(&fresh, &env).unwrap());
    assert!(std::fs::read_to_string(fresh.join("rayfin/.env")).unwrap().ends_with("RAYFIN_PUBLIC_ITEM_ID=item\n"));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn only_fabric_ids_reach_the_cli() {
    assert!(is_id("0f1e2d3c-aaaa-bbbb-cccc-1234567890ab"));
    assert!(!is_id(""));
    assert!(!is_id("--inspect"));
    assert!(!is_id("a b"));
  }
}
