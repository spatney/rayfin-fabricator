//! Reports a project's local Rayfin toolchain version — the `@microsoft/rayfin-*`
//! CLI and SDK packages pinned in its package.json — whether a newer stable
//! release is available on npm, the one Fabricator's updates go to (the newest
//! the bundled local backend runs that isn't newer than npm's `latest`), and a
//! newer one it offers with a warning.
//!
//! The app never upgrades these itself: when an update exists, Fabricator
//! hands a prepared prompt to the Copilot agent (which edits package.json and runs
//! `npm install`). This module just supplies the "from X → to Y" facts.
//!
//! Faithful Rust port of `src/main/services/rayfinVersion.ts`.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Deserialize;

use crate::services::exec::{self, RunOptions};
use crate::services::rayfin_sdk::{self, Published};
use crate::services::store;
use crate::types::{RayfinLatest, RayfinNewerRelease, RayfinPackageVersion, RayfinVersionInfo};

/// The canonical CLI package; every other `@microsoft/rayfin-*` is treated as SDK.
const CLI_PACKAGE: &str = "@microsoft/rayfin-cli";

/// Cache npm `latest` lookups so refreshes (per turn/deploy) don't hammer the registry.
const LATEST_TTL: Duration = Duration::from_millis(30 * 60_000);

static LATEST_CACHE: Lazy<std::sync::Mutex<HashMap<String, (Option<String>, Instant)>>> =
  Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

/// What npm lists for a package, its releases and dist-tags, cached like `latest`.
static RELEASES_CACHE: Lazy<std::sync::Mutex<HashMap<String, (Option<Published>, Instant)>>> =
  Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

#[derive(Deserialize)]
struct PackageJson {
  #[serde(default)]
  dependencies: HashMap<String, String>,
  #[serde(default, rename = "devDependencies")]
  dev_dependencies: HashMap<String, String>,
  #[serde(default)]
  version: Option<String>,
}

fn read_json(path: &Path) -> Option<PackageJson> {
  let raw = std::fs::read_to_string(path).ok()?;
  serde_json::from_str(&raw).ok()
}

/// All `@microsoft/rayfin-*` packages declared in the project's package.json.
fn rayfin_dependencies(project_path: &str) -> Vec<String> {
  let Some(pkg) = read_json(&Path::new(project_path).join("package.json")) else {
    return vec![];
  };
  let mut names: Vec<String> = pkg
    .dependencies
    .keys()
    .chain(pkg.dev_dependencies.keys())
    .filter(|name| name.starts_with("@microsoft/rayfin-"))
    .cloned()
    .collect();
  names.sort();
  names.dedup();
  names
}

/// Version actually resolved in node_modules (the real pinned version), or None.
fn installed_version(project_path: &str, pkg: &str) -> Option<String> {
  let mut path = Path::new(project_path).join("node_modules");
  for seg in pkg.split('/') {
    path.push(seg);
  }
  path.push("package.json");
  read_json(&path).and_then(|p| p.version)
}

/// The Rayfin version a project has installed, as Home shows it: its CLI's, or
/// else the first SDK package's that's installed. Read from the project's own
/// files, without asking npm, so listing projects stays quick.
pub(crate) fn local_version(project_path: &str) -> Option<String> {
  let names = rayfin_dependencies(project_path);
  let cli = names.iter().filter(|name| name.as_str() == CLI_PACKAGE);
  cli.chain(names.iter()).find_map(|name| installed_version(project_path, name))
}

/// The npm `latest` dist-tag version for a package, cached, None when unreachable.
async fn latest_version(pkg: &str) -> Option<String> {
  if let Some((version, at)) = LATEST_CACHE.lock().unwrap().get(pkg) {
    if at.elapsed() < LATEST_TTL {
      return version.clone();
    }
  }
  let res = exec::run("npm", &["view", pkg, "version"], RunOptions::timeout(20_000)).await;
  let version = if res.ok {
    res.stdout.split_whitespace().last().map(|s| s.to_string())
  } else {
    None
  };
  LATEST_CACHE
    .lock()
    .unwrap()
    .insert(pkg.to_string(), (version.clone(), Instant::now()));
  version
}

/// What npm lists for a package, cached; None when npm is unreachable.
async fn releases(pkg: &str) -> Option<Published> {
  if let Some((published, at)) = RELEASES_CACHE.lock().unwrap().get(pkg) {
    if at.elapsed() < LATEST_TTL {
      return published.clone();
    }
  }
  let published = rayfin_sdk::published(pkg, None).await;
  RELEASES_CACHE.lock().unwrap().insert(pkg.to_string(), (published.clone(), Instant::now()));
  published
}

/// Where updates go, from npm's releases of the headline package: the release
/// Fabricator recommends, and a newer one it offers with a warning.
fn update_targets(published: Option<&Published>) -> (Option<String>, Option<RayfinNewerRelease>) {
  let Some(published) = published else {
    return (None, None);
  };
  let targets = rayfin_sdk::update_targets(published);
  let newer = targets.newer.map(|version| RayfinNewerRelease {
    is_latest: published.latest.as_deref().is_some_and(|latest| latest.trim() == version.to_string()),
    runs_locally: rayfin_sdk::runs_locally(&version),
    version: version.to_string(),
  });
  (targets.recommended.map(|v| v.to_string()), newer)
}

/// Parse the `x.y.z` core of a semver string (ignoring any prerelease/build).
pub(crate) fn parse_core(version: Option<&str>) -> Option<(u64, u64, u64)> {
  static RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"(\d+)\.(\d+)\.(\d+)").unwrap());
  let v = version?;
  let m = RE.captures(v)?;
  Some((
    m.get(1)?.as_str().parse().ok()?,
    m.get(2)?.as_str().parse().ok()?,
    m.get(3)?.as_str().parse().ok()?,
  ))
}

/// True when `latest` is a strictly newer stable release than `installed`.
fn is_newer(latest: Option<&str>, installed: Option<&str>) -> bool {
  let (Some(a), Some(b)) = (parse_core(latest), parse_core(installed)) else {
    return false;
  };
  a > b
}

fn empty() -> RayfinVersionInfo {
  RayfinVersionInfo {
    version: None,
    latest: None,
    upgrade_available: false,
    packages: vec![],
    recommended: None,
    newer: None,
  }
}

/// Resolve the project's installed Rayfin versions and compare them against npm.
/// Never throws across IPC; returns an empty report when the project is unknown
/// or has no Rayfin dependencies.
#[tauri::command]
pub async fn rayfin_versions(id: String) -> RayfinVersionInfo {
  let Some(project) = store::find_project(&id) else {
    return empty();
  };

  let names = rayfin_dependencies(&project.path);
  if names.is_empty() {
    return empty();
  }

  let mut packages: Vec<RayfinPackageVersion> = Vec::with_capacity(names.len());
  for name in names {
    let installed = installed_version(&project.path, &name);
    let latest = latest_version(&name).await;
    let upgradable = is_newer(latest.as_deref(), installed.as_deref());
    packages.push(RayfinPackageVersion {
      kind: if name == CLI_PACKAGE { "cli".into() } else { "sdk".into() },
      name,
      installed,
      latest,
      upgradable,
    });
  }

  // Headline = the CLI version, falling back to the first SDK package that resolved.
  let headline = packages
    .iter()
    .find(|p| p.kind == "cli")
    .or_else(|| packages.iter().find(|p| p.installed.is_some()))
    .or_else(|| packages.first());
  let version = headline.and_then(|p| p.installed.clone());
  let latest = headline.and_then(|p| p.latest.clone());
  // Rayfin's packages ship in lockstep, so the headline's update targets are
  // every package's.
  let published = match headline.map(|p| p.name.clone()) {
    Some(name) => releases(&name).await,
    None => None,
  };
  let (recommended, newer) = update_targets(published.as_ref());

  RayfinVersionInfo {
    version,
    latest,
    upgrade_available: packages.iter().any(|p| p.upgradable),
    packages,
    recommended,
    newer,
  }
}

/// The newest Rayfin release on npm, and the one every app's updates go to.
/// Rayfin's packages ship in lockstep, so the CLI's are every package's.
/// Cached like [`rayfin_versions`]' lookups; absent when npm is unreachable.
#[tauri::command]
pub async fn rayfin_latest() -> RayfinLatest {
  let published = releases(CLI_PACKAGE).await;
  let (recommended, _) = update_targets(published.as_ref());
  RayfinLatest { latest: published.and_then(|p| p.latest), recommended }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn home_shows_the_installed_rayfin_version_without_asking_npm() {
    let dir = std::env::temp_dir().join(format!("fab-rayfin-version-{}", uuid::Uuid::new_v4()));
    let write = |rel: &str, body: &str| {
      let path = dir.join(rel);
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      std::fs::write(path, body).unwrap();
    };
    write(
      "package.json",
      r#"{"dependencies":{"@microsoft/rayfin-sdk":"~1.36.0"},"devDependencies":{"@microsoft/rayfin-cli":"~1.36.0"}}"#,
    );
    let path = dir.to_string_lossy().to_string();
    assert_eq!(local_version(&path), None, "nothing installed yet");
    write("node_modules/@microsoft/rayfin-sdk/package.json", r#"{"version":"1.36.1"}"#);
    assert_eq!(local_version(&path).as_deref(), Some("1.36.1"));
    write("node_modules/@microsoft/rayfin-cli/package.json", r#"{"version":"1.36.2"}"#);
    assert_eq!(local_version(&path).as_deref(), Some("1.36.2"), "the CLI's comes first");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn parse_core_ignores_prerelease() {
    assert_eq!(parse_core(Some("1.34.0-alpha.1148")), Some((1, 34, 0)));
    assert_eq!(parse_core(Some("v1.33.2")), Some((1, 33, 2)));
    assert_eq!(parse_core(None), None);
    assert_eq!(parse_core(Some("not-a-version")), None);
  }

  #[test]
  fn is_newer_compares_semver_cores() {
    assert!(is_newer(Some("1.34.0"), Some("1.33.2")));
    assert!(is_newer(Some("2.0.0"), Some("1.99.99")));
    assert!(is_newer(Some("1.33.3"), Some("1.33.2")));
    assert!(!is_newer(Some("1.33.2"), Some("1.33.2")));
    assert!(!is_newer(Some("1.33.1"), Some("1.33.2")));
    // A newer prerelease core still counts; equal cores do not.
    assert!(is_newer(Some("1.34.0-alpha.1"), Some("1.33.2")));
    assert!(!is_newer(Some("1.33.2-alpha.1"), Some("1.33.2")));
    // Unreachable/unknown sides never report an upgrade.
    assert!(!is_newer(None, Some("1.33.2")));
    assert!(!is_newer(Some("1.34.0"), None));
  }

  #[test]
  fn a_newer_release_says_whether_it_is_latest_and_runs_here() {
    let npm = |latest: &str| Published { versions: vec!["0.0.1".into(), "999.0.0".into()], latest: Some(latest.into()) };
    let (recommended, preview) = update_targets(Some(&npm("0.0.1")));
    assert_eq!(recommended, None, "the local backend runs neither");
    assert_eq!(preview, Some(RayfinNewerRelease { version: "999.0.0".into(), is_latest: false, runs_locally: false }));
    let (_, latest) = update_targets(Some(&npm("999.0.0")));
    assert_eq!(latest.map(|newer| newer.is_latest), Some(true));
    assert_eq!(update_targets(None), (None, None));
  }

  #[test]
  fn parse_package_json_defaults_missing_maps() {
    let pkg: PackageJson = serde_json::from_str(r#"{"version":"1.0.0"}"#).unwrap();
    assert!(pkg.dependencies.is_empty());
    assert!(pkg.dev_dependencies.is_empty());
    assert_eq!(pkg.version.as_deref(), Some("1.0.0"));
  }

  #[test]
  fn rayfin_dependencies_filters_and_sorts() {
    let dir = std::env::temp_dir().join(format!("rayfinver-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
      dir.join("package.json"),
      r#"{
        "dependencies": { "@microsoft/rayfin-data": "^1.0.0", "react": "^18.0.0" },
        "devDependencies": { "@microsoft/rayfin-cli": "^1.0.0", "vite": "^5" }
      }"#,
    )
    .unwrap();
    let names = rayfin_dependencies(dir.to_string_lossy().as_ref());
    assert_eq!(names, vec!["@microsoft/rayfin-cli", "@microsoft/rayfin-data"]);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
