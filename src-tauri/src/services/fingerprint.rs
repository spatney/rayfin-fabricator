//! A cheap signature of a project's source tree, used to detect when cached,
//! Copilot-derived artifacts (Advisor reports, starter suggestions) have gone
//! stale. Stat-only (file size + mtime), so it never reads file contents and
//! skips heavy/irrelevant directories.

use std::path::Path;
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

/// Directories that never affect a code-derived artifact and would be expensive
/// to walk. `.rayfin-local` is the local backend's state (its database changes
/// whenever the app runs), never a change to the app.
const SKIP_DIRS: &[&str] = &[
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  "coverage",
  ".rayfin",
  ".rayfin-local",
  ".turbo",
  ".cache",
];

/// Walk `dir`, feeding `relpath|len|mtime` of each file into `hasher` (stat-only,
/// no reads), skipping heavy/irrelevant directories.
fn hash_dir(hasher: &mut Sha256, root: &Path, dir: &Path) {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return;
  };
  let mut entries: Vec<_> = entries.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for entry in entries {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    let Ok(ft) = entry.file_type() else {
      continue;
    };
    let path = entry.path();
    if ft.is_dir() {
      if !SKIP_DIRS.contains(&name.as_ref()) {
        hash_dir(hasher, root, &path);
      }
    } else if ft.is_file() {
      hash_file(hasher, root, &path, entry.metadata().ok());
    }
  }
}

/// Feed `relpath|len|mtime` of one file into `hasher`.
fn hash_file(hasher: &mut Sha256, root: &Path, path: &Path, meta: Option<std::fs::Metadata>) {
  let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy();
  let (len, mtime) = meta
    .map(|m| {
      let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
      (m.len(), mtime)
    })
    .unwrap_or((0, 0));
  hasher.update(rel.as_bytes());
  hasher.update(b"\0");
  hasher.update(len.to_le_bytes());
  hasher.update(mtime.to_le_bytes());
  hasher.update(b"\n");
}

/// A cheap signature of the project's source tree. Any file added, removed, or
/// edited (size/mtime) changes it. Prefers the dirs an app's code actually lives
/// in (`rayfin/`, `src/`), falling back to the whole root.
pub fn fingerprint(project_path: &str) -> String {
  let root = Path::new(project_path);
  let mut hasher = Sha256::new();
  let mut hashed_any = false;
  for sub in ["rayfin", "src"] {
    let p = root.join(sub);
    if p.is_dir() {
      hash_dir(&mut hasher, root, &p);
      hashed_any = true;
    }
  }
  if !hashed_any {
    hash_dir(&mut hasher, root, root);
  }
  hex::encode(hasher.finalize())
}

/// [`fingerprint`] of the given project-relative files and folders, those
/// that exist, for what depends on more of the app than `rayfin/` and `src/`
/// (a workspace app keeps its code in packages). A part inside another counts once.
pub fn fingerprint_parts(project_path: &str, parts: &[String]) -> String {
  let root = Path::new(project_path);
  let mut parts: Vec<String> =
    parts.iter().map(|p| p.trim().trim_matches('/').replace('\\', "/")).filter(|p| !p.is_empty() && !p.contains("..")).collect();
  parts.sort();
  parts.dedup();
  let mut hasher = Sha256::new();
  let mut taken: Vec<String> = Vec::new();
  for part in parts {
    if taken.iter().any(|t| part.starts_with(&format!("{t}/"))) {
      continue;
    }
    let path = root.join(&part);
    if path.is_dir() {
      hash_dir(&mut hasher, root, &path);
    } else if path.is_file() {
      hash_file(&mut hasher, root, &path, std::fs::metadata(&path).ok());
    }
    taken.push(part);
  }
  hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
  use super::*;

  struct TempDir(std::path::PathBuf);

  impl TempDir {
    fn new() -> Self {
      let dir = std::env::temp_dir().join(format!("fabricator-fingerprint-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&dir).unwrap();
      Self(dir)
    }

    fn write(&self, rel: &str, content: &str) {
      let path = self.0.join(rel);
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      std::fs::write(path, content).unwrap();
    }

    fn fingerprint(&self) -> String {
      fingerprint(&self.0.to_string_lossy())
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn the_local_backends_state_is_never_a_change() {
    // No `rayfin/` or `src/`, so the whole folder is walked.
    let app = TempDir::new();
    app.write("index.html", "<h1>Hi</h1>");
    let before = app.fingerprint();
    app.write(".rayfin-local/db.sqlite", "rows");
    app.write(".rayfin-local/secrets.json", "{}");
    app.write("web/.rayfin-local/state.json", "{}");
    assert_eq!(app.fingerprint(), before);
    app.write("app.js", "console.log(1)");
    assert_ne!(app.fingerprint(), before, "a change to the app still counts");
  }

  #[test]
  fn parts_cover_a_workspace_apps_packages() {
    let app = TempDir::new();
    app.write("rayfin/rayfin.yml", "services: {}");
    app.write("packages/data/src/index.ts", "export {}");
    let root = app.0.to_string_lossy().to_string();
    let parts = |list: &[&str]| fingerprint_parts(&root, &list.iter().map(|p| p.to_string()).collect::<Vec<_>>());
    let before = parts(&["rayfin", "packages/data/src", "packages/data", "missing"]);
    assert_eq!(before, parts(&["packages/data", "rayfin"]), "nested and missing parts don't count twice");
    app.write("packages/data/node_modules/x/index.js", "");
    assert_eq!(parts(&["rayfin", "packages/data"]), before);
    app.write("packages/data/src/model.ts", "export const a = 1");
    assert_ne!(parts(&["rayfin", "packages/data"]), before);
  }
}
