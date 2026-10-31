//! Read-only project file access for the in-app code viewer. Ported from
//! `src/main/services/files.ts`. Sandboxed to the project directory: reads are
//! traversal-guarded and heavy/generated folders are pruned from the tree.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::commands::util::{looks_binary, safe_resolve};
use crate::services::exec::{run, RunOptions};
use crate::services::store::find_project;
use crate::types::{FileContent, FileNode};

/// Folders never worth showing in a code viewer (huge and/or generated).
const EXCLUDED_DIRS: [&str; 11] = [
  "node_modules", ".git", "dist", "out", "build", ".next", ".turbo", ".cache", ".vite", "coverage", ".DS_Store",
];
const MAX_ENTRIES: usize = 8000;
const MAX_DEPTH: usize = 12;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// Set of working-tree paths git considers ignored, so the tree can mark them.
/// `files` holds exact ignored file paths; `dirs` holds wholly-ignored directory
/// prefixes (git collapses those to `dir/`, so their contents inherit the flag).
#[derive(Default)]
pub(crate) struct Ignores {
  files: HashSet<String>,
  dirs: Vec<String>,
}

impl Ignores {
  /// True if `path` (project-relative, POSIX) is ignored or sits under an
  /// ignored directory.
  pub(crate) fn is_ignored(&self, path: &str) -> bool {
    if self.files.contains(path) {
      return true;
    }
    self.dirs.iter().any(|d| {
      path == d.as_str()
        || (path.len() > d.len() && path.starts_with(d.as_str()) && path.as_bytes()[d.len()] == b'/')
    })
  }
}

/// Ask git which paths are ignored (`git status --ignored`, NUL-delimited).
/// Resilient to non-git projects: any failure yields an empty set, so the tree
/// simply shows nothing as ignored rather than erroring.
pub(crate) async fn compute_ignores(cwd: &str) -> Ignores {
  let opts = RunOptions {
    cwd: Some(PathBuf::from(cwd)),
    timeout_ms: Some(15_000),
    ..Default::default()
  };
  let res = run(
    "git",
    &["-c", "core.quotepath=false", "status", "--porcelain", "-z", "--ignored"],
    opts,
  )
  .await;
  let mut ign = Ignores::default();
  if res.ok {
    // Porcelain `-z` entries are `XY<space>PATH\0`; ignored ones carry `!!`.
    for token in res.stdout.split('\0') {
      if let Some(p) = token.strip_prefix("!! ") {
        if let Some(d) = p.strip_suffix('/') {
          ign.dirs.push(d.to_string());
        } else {
          ign.files.insert(p.to_string());
        }
      }
    }
  }
  ign
}

/// Emit `Some(true)` only for ignored nodes so the flag stays out of the JSON
/// for the common (non-ignored) case.
fn ignored_flag(ignored: bool) -> Option<bool> {
  ignored.then_some(true)
}

fn walk(dir: &Path, rel: &str, depth: usize, budget: &mut usize, ign: &Ignores, parent_ignored: bool) -> Vec<FileNode> {
  if depth > MAX_DEPTH || *budget >= MAX_ENTRIES {
    return vec![];
  }
  let Ok(read_dir) = std::fs::read_dir(dir) else {
    return vec![];
  };

  let mut dirs: Vec<FileNode> = Vec::new();
  let mut files: Vec<FileNode> = Vec::new();
  for entry in read_dir.flatten() {
    if *budget >= MAX_ENTRIES {
      break;
    }
    let name = entry.file_name().to_string_lossy().to_string();
    let Ok(file_type) = entry.file_type() else {
      continue;
    };
    if file_type.is_dir() {
      if EXCLUDED_DIRS.contains(&name.as_str()) {
        continue;
      }
      *budget += 1;
      let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
      let ignored = parent_ignored || ign.is_ignored(&child_rel);
      let children = walk(&entry.path(), &child_rel, depth + 1, budget, ign, ignored);
      dirs.push(FileNode {
        name,
        path: child_rel,
        r#type: "dir".into(),
        children: Some(children),
        ignored: ignored_flag(ignored),
      });
    } else if file_type.is_file() {
      *budget += 1;
      let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
      let ignored = parent_ignored || ign.is_ignored(&path);
      files.push(FileNode {
        name,
        path,
        r#type: "file".into(),
        children: None,
        ignored: ignored_flag(ignored),
      });
    }
  }

  let by_name = |a: &FileNode, b: &FileNode| a.name.to_lowercase().cmp(&b.name.to_lowercase());
  dirs.sort_by(by_name);
  files.sort_by(by_name);
  dirs.extend(files);
  dirs
}

/// Build the project's file tree (pruned + capped).
pub async fn files_tree(id: String) -> Vec<FileNode> {
  let Some(project) = find_project(&id) else {
    return vec![];
  };
  let ignores = compute_ignores(&project.path).await;
  let mut budget = 0usize;
  walk(Path::new(&project.path), "", 0, &mut budget, &ignores, false)
}

/// Read a single project file for the viewer (text only, size-capped).
pub async fn files_read(id: String, path: String) -> FileContent {
  let err = |size: u64, message: &str| FileContent {
    path: path.clone(),
    size,
    error: Some(message.to_string()),
    ..Default::default()
  };

  let Some(project) = find_project(&id) else {
    return err(0, "Project not found.");
  };
  let Some(target) = safe_resolve(&project.path, &path) else {
    return err(0, "Path is outside the project.");
  };

  let size = match std::fs::metadata(&target) {
    Ok(m) if m.is_file() => m.len(),
    Ok(_) => return err(0, "Not a file."),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
      return FileContent { missing: Some(true), ..err(0, "File not found.") };
    }
    Err(_) => return err(0, "File not found."),
  };

  if size > MAX_FILE_BYTES {
    return FileContent { path, size, too_large: Some(true), ..Default::default() };
  }

  match std::fs::read(&target) {
    Ok(buf) if looks_binary(&buf) => FileContent { path, size, binary: Some(true), ..Default::default() },
    Ok(buf) => FileContent {
      path,
      size,
      content: Some(String::from_utf8_lossy(&buf).to_string()),
      ..Default::default()
    },
    Err(_) => err(size, "Could not read the file."),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ignores() -> Ignores {
    let mut ign = Ignores::default();
    ign.files.insert(".env".into());
    ign.files.insert("rayfin/.lockfile.json".into());
    ign.dirs.push("dist".into());
    ign.dirs.push("src/generated".into());
    ign
  }

  #[test]
  fn is_ignored_matches_exact_files_and_dir_prefixes() {
    let ign = ignores();
    // Exact ignored files.
    assert!(ign.is_ignored(".env"));
    assert!(ign.is_ignored("rayfin/.lockfile.json"));
    // The ignored directory itself and anything beneath it.
    assert!(ign.is_ignored("dist"));
    assert!(ign.is_ignored("dist/index.html"));
    assert!(ign.is_ignored("src/generated"));
    assert!(ign.is_ignored("src/generated/models/user.ts"));
  }

  #[test]
  fn is_ignored_rejects_partial_prefix_and_unrelated_paths() {
    let ign = ignores();
    // A sibling that merely shares a name prefix must NOT be treated as ignored.
    assert!(!ign.is_ignored("distribution"));
    assert!(!ign.is_ignored("src/generated-notes.md"));
    // Unrelated, tracked paths.
    assert!(!ign.is_ignored("src/main.ts"));
    assert!(!ign.is_ignored(".envrc"));
  }
}
