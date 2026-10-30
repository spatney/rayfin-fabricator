//! `advisor_collect`: one round-trip project snapshot for the renderer's quick
//! checks — the file list (with git-ignored flags), capped text contents of the
//! files the rules read, the `@microsoft/rayfin-*` package versions, and the
//! Rayfin releases the bundled local backend runs.
//! Read-only and bounded: heavy/generated folders are skipped, the local
//! backend's state (`.rayfin-local/`) is only sampled, and both the walk and the
//! collected bytes are capped.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Deserialize;

use crate::commands::files::{compute_ignores, Ignores};
use crate::commands::util::looks_binary;
use crate::services::project_layout::{is_under, relative_to, ProjectLayout};
use crate::services::rayfin_sdk;
use crate::types::{AdvisorPackage, AdvisorProjectFile, AdvisorProjectSnapshot};

/// Folders that never hold reviewable source and can be huge.
const SKIP_DIRS: &[&str] = &[
  "node_modules", ".git", "dist", "out", "build", ".next", ".turbo", ".cache", ".vite", "coverage", "target",
  ".temp", ".rayfin",
];
/// The local backend's state at the project root: the app's local data, keys,
/// secrets, uploaded files and caches. Only its `.gitignore` is ever read.
const LOCAL_STATE_DIR: &str = ".rayfin-local";
/// Files listed from each `.rayfin-local/` subfolder: enough to tell whether git ignores them.
const LOCAL_STATE_SAMPLE: usize = 20;
const MAX_FILES: usize = 6000;
const MAX_DEPTH: usize = 12;
/// Largest single file whose contents are collected.
const MAX_FILE_BYTES: u64 = 256 * 1024;
/// Total collected content budget.
const MAX_TOTAL_BYTES: usize = 6 * 1024 * 1024;

const SOURCE_EXTS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];
const SCRIPT_EXTS: &[&str] = &["ts", "js", "mjs", "cjs", "ps1", "sh", "cmd", "bat"];

fn ext(path: &str) -> &str {
  path.rsplit_once('.').map(|(_, e)| e).unwrap_or("")
}

fn file_name(path: &str) -> &str {
  path.rsplit('/').next().unwrap_or(path)
}

/// Whether the quick checks read this project-relative file's contents. Besides
/// the project root's `src/` and `rayfin/`, that's the frontend, data model and
/// functions packages `layout` names, as in the Rayfin CLI's Universal App.
pub(crate) fn wants_contents(path: &str, layout: &ProjectLayout) -> bool {
  // Of the local backend's state, only the `.gitignore` that keeps it out of git.
  if let Some(rest) = path.strip_prefix(LOCAL_STATE_DIR).and_then(|rest| rest.strip_prefix('/')) {
    return rest == ".gitignore";
  }
  let name = file_name(path);
  let lower = path.to_ascii_lowercase();
  let depth = path.matches('/').count();
  let source = SOURCE_EXTS.contains(&ext(path)) && !name.ends_with(".d.ts");
  // The frontend and functions packages' own folders, read like the root:
  // their manifests, Vite config and the env files Vite loads.
  let in_package_root = |root: &str| !root.is_empty() && relative_to(path, root).is_some_and(|rel| !rel.contains('/'));
  if in_package_root(&layout.frontend_root)
    && (name == "package.json" || name.starts_with("vite.config.") || name.starts_with(".env"))
  {
    return true;
  }
  if in_package_root(&layout.functions_root) && name == "package.json" {
    return true;
  }
  if name.starts_with(".env") && (depth == 0 || lower.starts_with("rayfin/")) {
    return depth <= 1;
  }
  if name == ".gitignore" {
    return depth == 0 || lower.starts_with("rayfin/");
  }
  if depth == 0 {
    return name == "package.json"
      || (name.starts_with("tsconfig") && name.ends_with(".json"))
      || name.starts_with("vite.config.");
  }
  // npm workspace manifests, such as the Rayfin CLI Universal App's
  // `packages/frontend/package.json`: an app's dependencies can be declared there.
  if name == "package.json" && depth <= 2 {
    return true;
  }
  if lower.starts_with("rayfin/") {
    return name == "rayfin.yml"
      || name == "rayfin.yaml"
      || name == "package.json"
      || (name.starts_with("tsconfig") && name.ends_with(".json"))
      || source;
  }
  if lower.starts_with("src/") {
    return source;
  }
  if [layout.frontend_src(), layout.data_dir.clone(), layout.functions_src()].iter().any(|dir| is_under(path, dir)) {
    return source;
  }
  if lower.starts_with("scripts/") {
    return SCRIPT_EXTS.contains(&ext(path));
  }
  if lower.starts_with(".github/workflows/") {
    return matches!(ext(path), "yml" | "yaml");
  }
  false
}

fn walk(
  dir: &Path,
  rel: &str,
  depth: usize,
  ign: &Ignores,
  out: &mut Vec<AdvisorProjectFile>,
  truncated: &mut bool,
  limit: usize,
) {
  if depth > MAX_DEPTH {
    return;
  }
  let Ok(read_dir) = std::fs::read_dir(dir) else {
    return;
  };
  let mut entries: Vec<_> = read_dir.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for entry in entries {
    if out.len() >= limit {
      *truncated = true;
      return;
    }
    let name = entry.file_name().to_string_lossy().to_string();
    let Ok(file_type) = entry.file_type() else {
      continue;
    };
    let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
    if file_type.is_dir() {
      if rel.is_empty() && name == LOCAL_STATE_DIR {
        walk_local_state(&entry.path(), &path, depth + 1, ign, out, truncated);
      } else if !SKIP_DIRS.contains(&name.as_str()) {
        walk(&entry.path(), &path, depth + 1, ign, out, truncated, limit);
      }
    } else if file_type.is_file() {
      out.push(listed(&entry, path, ign));
    }
  }
}

fn listed(entry: &std::fs::DirEntry, path: String, ign: &Ignores) -> AdvisorProjectFile {
  let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
  AdvisorProjectFile { ignored: ign.is_ignored(&path).then_some(true), path, size }
}

/// Lists `.rayfin-local/` for the check that keeps it out of git: its own files
/// and, unless git ignores the whole folder, a few of each subfolder's (`keys/`,
/// `storage/`, `cache/`), so uploads and caches never crowd out the app's files.
fn walk_local_state(
  dir: &Path,
  rel: &str,
  depth: usize,
  ign: &Ignores,
  out: &mut Vec<AdvisorProjectFile>,
  truncated: &mut bool,
) {
  let Ok(read_dir) = std::fs::read_dir(dir) else {
    return;
  };
  let mut entries: Vec<_> = read_dir.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  let wholly_ignored = ign.is_ignored(rel);
  let mut subfolders = Vec::new();
  for entry in entries {
    let Ok(file_type) = entry.file_type() else {
      continue;
    };
    let path = format!("{rel}/{}", entry.file_name().to_string_lossy());
    if file_type.is_file() {
      if out.len() >= MAX_FILES {
        *truncated = true;
        return;
      }
      out.push(listed(&entry, path, ign));
    } else if file_type.is_dir() && !wholly_ignored {
      subfolders.push((entry.path(), path));
    }
  }
  for (subfolder, path) in subfolders {
    let mut sample = Vec::new();
    walk(&subfolder, &path, depth + 1, ign, &mut sample, &mut false, LOCAL_STATE_SAMPLE);
    let room = MAX_FILES.saturating_sub(out.len());
    if sample.len() > room {
      *truncated = true;
    }
    out.extend(sample.into_iter().take(room));
  }
}

#[derive(Deserialize, Default)]
struct PackageJson {
  #[serde(default)]
  version: Option<String>,
  #[serde(default)]
  dependencies: HashMap<String, String>,
  #[serde(default, rename = "devDependencies")]
  dev_dependencies: HashMap<String, String>,
}

fn read_package_json(path: &Path) -> Option<PackageJson> {
  serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Declared (package.json) and installed (node_modules) `@microsoft/rayfin-*`
/// packages, merged by name and sorted.
fn rayfin_packages(root: &Path) -> Vec<AdvisorPackage> {
  let mut by_name: BTreeMap<String, AdvisorPackage> = BTreeMap::new();
  if let Some(pkg) = read_package_json(&root.join("package.json")) {
    for (deps, dev) in [(&pkg.dependencies, false), (&pkg.dev_dependencies, true)] {
      for (name, range) in deps {
        if name.starts_with("@microsoft/rayfin") {
          let entry = by_name.entry(name.clone()).or_insert_with(|| AdvisorPackage { name: name.clone(), ..Default::default() });
          entry.declared = Some(range.clone());
          entry.dev = Some(dev);
        }
      }
    }
  }
  let scope = root.join("node_modules").join("@microsoft");
  if let Ok(read_dir) = std::fs::read_dir(&scope) {
    for entry in read_dir.flatten() {
      let dir = entry.file_name().to_string_lossy().to_string();
      if !dir.starts_with("rayfin") {
        continue;
      }
      let name = format!("@microsoft/{dir}");
      if let Some(version) = read_package_json(&entry.path().join("package.json")).and_then(|p| p.version) {
        let entry = by_name.entry(name.clone()).or_insert_with(|| AdvisorPackage { name, ..Default::default() });
        entry.installed = Some(version);
      }
    }
  }
  by_name.into_values().collect()
}

/// Build the quick-check snapshot for the project at `root`. `local`: the
/// bundled local backend runs the app (personal apps; team apps don't).
pub(crate) async fn collect(root: &str, local: bool) -> AdvisorProjectSnapshot {
  let root_path = Path::new(root).to_path_buf();
  let is_git_repo = root_path.join(".git").exists();
  let ignores = if is_git_repo { compute_ignores(root).await } else { Ignores::default() };
  let mut snapshot = tokio::task::spawn_blocking(move || collect_blocking(&root_path, &ignores, is_git_repo))
    .await
    .unwrap_or_default();
  snapshot.local_sdk_range = local.then(|| rayfin_sdk::supported_range().to_string());
  snapshot
}

fn collect_blocking(root: &Path, ignores: &Ignores, is_git_repo: bool) -> AdvisorProjectSnapshot {
  let mut files = Vec::new();
  let mut truncated = false;
  walk(root, "", 0, ignores, &mut files, &mut truncated, MAX_FILES);

  let layout = ProjectLayout::read(root);
  let mut contents = BTreeMap::new();
  let mut total = 0usize;
  for file in &files {
    if !wants_contents(&file.path, &layout) {
      continue;
    }
    if file.size > MAX_FILE_BYTES || total + file.size as usize > MAX_TOTAL_BYTES {
      truncated = true;
      continue;
    }
    let Ok(buf) = std::fs::read(root.join(&file.path)) else {
      continue;
    };
    if looks_binary(&buf) {
      continue;
    }
    total += buf.len();
    contents.insert(file.path.clone(), String::from_utf8_lossy(&buf).into_owned());
  }

  AdvisorProjectSnapshot {
    files,
    contents,
    truncated: truncated.then_some(true),
    is_git_repo,
    packages: rayfin_packages(root),
    local_sdk_range: None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn wants_contents_selects_reviewable_files_only() {
    let single = ProjectLayout::default();
    for path in [
      "package.json",
      "tsconfig.json",
      "tsconfig.app.json",
      "vite.config.ts",
      ".env",
      ".env.local",
      ".gitignore",
      "rayfin/.env",
      "rayfin/rayfin.yml",
      "rayfin/data/Todo.ts",
      "rayfin/functions/src/function_app.ts",
      "rayfin/functions/package.json",
      "packages/frontend/package.json",
      "frontend/package.json",
      "src/App.tsx",
      "src/services/rayfinClient.ts",
      "scripts/seed.mjs",
      ".github/workflows/deploy.yml",
      ".rayfin-local/.gitignore",
    ] {
      assert!(wants_contents(path, &single), "{path} should be collected");
    }
    for path in [
      "README.md",
      "src/vite-env.d.ts",
      "src/assets/logo.png",
      "src/main.css",
      "public/robots.txt",
      "docs/.env",
      "src/nested/.env",
      "rayfin/connectors/sales/metadata.json",
      "packages/frontend/src/vendor/lib/package.json",
      "packages/frontend/src/App.tsx",
      "packages/frontend/.env",
      ".rayfin-local/secrets.json",
      ".rayfin-local/state.json",
      ".rayfin-local/cache/package.json",
    ] {
      assert!(!wants_contents(path, &single), "{path} should not be collected");
    }
  }

  #[test]
  fn wants_contents_reads_the_packages_rayfin_yml_names() {
    // The Rayfin CLI's Universal App, with its functions pack applied.
    let layout = ProjectLayout::parse(
      "services:\n  data:\n    path: packages/data\n  staticHosting:\n    path: packages/frontend\n  functions:\n    path: apps/api/functions\n",
    );
    for path in [
      "packages/frontend/src/App.tsx",
      "packages/frontend/src/lib/rayfin-client.ts",
      "packages/frontend/vite.config.ts",
      "packages/frontend/.env",
      "packages/frontend/.env.local",
      "packages/data/src/index.ts",
      "packages/data/src/Item.ts",
      "apps/api/functions/package.json",
      "apps/api/functions/src/function_app.ts",
      "rayfin/rayfin.yml",
      "src/App.tsx",
    ] {
      assert!(wants_contents(path, &layout), "{path} should be collected");
    }
    for path in [
      "packages/frontend/src/vite-env.d.ts",
      "packages/frontend/src/global.css",
      "packages/frontend/public/.env",
      "packages/data/dist/index.js",
      "packages/data/README.md",
      "packages/shared/src/index.ts",
      "apps/api/functions/local.settings.json",
      "apps/api/functions/dist/index.js",
    ] {
      assert!(!wants_contents(path, &layout), "{path} should not be collected");
    }
  }

  #[test]
  fn collect_walks_files_and_reads_rayfin_packages() {
    let dir = std::env::temp_dir().join(format!("advisor-collect-{}", uuid::Uuid::new_v4()));
    let write = |rel: &str, body: &str| {
      let p = dir.join(rel);
      std::fs::create_dir_all(p.parent().unwrap()).unwrap();
      std::fs::write(p, body).unwrap();
    };
    write(
      "package.json",
      r#"{"dependencies":{"@microsoft/rayfin-core":"^1.35.1","react":"^19"},"devDependencies":{"@microsoft/rayfin-cli":"1.35.1"}}"#,
    );
    write("rayfin/rayfin.yml", "services:\n  auth:\n    enabled: true\n");
    write("rayfin/data/Todo.ts", "export class Todo {}\n");
    write("rayfin/.temp/compiled/Todo.js", "compiled");
    write("node_modules/@microsoft/rayfin-core/package.json", r#"{"version":"1.35.1"}"#);
    write("node_modules/@microsoft/rayfin-lib/package.json", r#"{"version":"1.34.0"}"#);
    write("node_modules/react/package.json", r#"{"version":"19.0.0"}"#);
    write("src/App.tsx", "export default function App() { return null }\n");

    let snap = collect_blocking(&dir, &Ignores::default(), false);
    let paths: Vec<&str> = snap.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"rayfin/data/Todo.ts"));
    assert!(paths.contains(&"src/App.tsx"));
    assert!(!paths.iter().any(|p| p.contains("node_modules") || p.contains(".temp")));
    assert!(snap.contents.contains_key("rayfin/rayfin.yml"));
    assert!(snap.contents.contains_key("src/App.tsx"));
    assert!(!snap.is_git_repo);

    let pkg = |name: &str| snap.packages.iter().find(|p| p.name == name).cloned();
    let core = pkg("@microsoft/rayfin-core").unwrap();
    assert_eq!(core.declared.as_deref(), Some("^1.35.1"));
    assert_eq!(core.installed.as_deref(), Some("1.35.1"));
    assert_eq!(core.dev, Some(false));
    let cli = pkg("@microsoft/rayfin-cli").unwrap();
    assert_eq!(cli.dev, Some(true));
    assert!(cli.installed.is_none());
    assert_eq!(pkg("@microsoft/rayfin-lib").unwrap().installed.as_deref(), Some("1.34.0"));
    assert!(pkg("react").is_none());
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A project with the local backend's state folder: its own files, signing
  /// keys, and more uploads and cache files than the walk samples.
  fn project_with_local_state() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("advisor-local-state-{}", uuid::Uuid::new_v4()));
    let write = |rel: &str, body: &str| {
      let p = dir.join(rel);
      std::fs::create_dir_all(p.parent().unwrap()).unwrap();
      std::fs::write(p, body).unwrap();
    };
    write("src/App.tsx", "export default function App() { return null }\n");
    write(".rayfin-local/.gitignore", "*\n");
    write(".rayfin-local/db.sqlite", "data");
    write(".rayfin-local/secrets.json", r#"{"API_KEY":"value"}"#);
    write(".rayfin-local/keys/signing.json", "{}");
    for i in 0..LOCAL_STATE_SAMPLE + 15 {
      write(&format!(".rayfin-local/storage/photos/{i:03}.png"), "png");
      write(&format!(".rayfin-local/cache/{i:03}.js"), "js");
    }
    dir
  }

  #[test]
  fn collect_samples_the_local_backends_state_and_reads_only_its_gitignore() {
    let dir = project_with_local_state();
    let snap = collect_blocking(&dir, &Ignores::default(), false);
    let paths: Vec<&str> = snap.files.iter().map(|f| f.path.as_str()).collect();
    for listed in [
      ".rayfin-local/.gitignore",
      ".rayfin-local/db.sqlite",
      ".rayfin-local/secrets.json",
      ".rayfin-local/keys/signing.json",
      "src/App.tsx",
    ] {
      assert!(paths.contains(&listed), "{listed} should be listed");
    }
    for sub in [".rayfin-local/storage/", ".rayfin-local/cache/"] {
      assert_eq!(paths.iter().filter(|p| p.starts_with(sub)).count(), LOCAL_STATE_SAMPLE, "{sub}");
    }
    assert!(snap.truncated.is_none(), "a sampled folder doesn't truncate the app's files");
    let read: Vec<&str> = snap.contents.keys().map(String::as_str).filter(|p| p.starts_with(".rayfin-local/")).collect();
    assert_eq!(read, [".rayfin-local/.gitignore"]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[tokio::test]
  async fn a_wholly_ignored_local_state_folder_lists_only_its_own_files() {
    if which::which("git").is_err() {
      return;
    }
    let dir = project_with_local_state();
    let init = std::process::Command::new("git").args(["init", "-q"]).current_dir(&dir).status();
    assert!(init.is_ok_and(|s| s.success()), "git init");
    let ignores = compute_ignores(&dir.to_string_lossy()).await;
    let snap = collect_blocking(&dir, &ignores, true);
    let local: Vec<_> = snap.files.iter().filter(|f| f.path.starts_with(".rayfin-local/")).collect();
    let mut paths: Vec<&str> = local.iter().map(|f| f.path.as_str()).collect();
    paths.sort_unstable();
    assert_eq!(paths, [".rayfin-local/.gitignore", ".rayfin-local/db.sqlite", ".rayfin-local/secrets.json"]);
    assert!(local.iter().all(|f| f.ignored == Some(true)));
    assert!(snap.files.iter().any(|f| f.path == "src/App.tsx" && f.ignored.is_none()));
    let _ = std::fs::remove_dir_all(&dir);
  }
}
