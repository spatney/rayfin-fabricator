//! A cheap signature of a project's source tree, used to detect when cached,
//! Copilot-derived artifacts (Advisor reports, starter suggestions) have gone
//! stale. Stat-only (file size + mtime), so it never reads file contents and
//! skips heavy/irrelevant directories.

use std::path::Path;
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

/// Directories that never affect a code-derived artifact and would be expensive
/// to walk.
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
      let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy();
      let (len, mtime) = entry
        .metadata()
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
  }
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
