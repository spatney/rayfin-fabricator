//! Read-only project file access for the in-app code viewer. Ported from
//! `src/main/services/files.ts`. Sandboxed to the project directory: reads are
//! traversal-guarded and heavy/generated folders are pruned from the tree.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use crate::commands::util::{looks_binary, safe_resolve};
use crate::services::exec::{run, RunOptions};
use crate::services::paths;
use crate::services::store::find_project;
use crate::types::{DirEntryInfo, DirListing, FileContent, FileNode};

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

/// The most entries a folder lists for an `@` reference: plenty to pick from
/// once filtered by what's typed.
const MAX_DIR_ENTRIES: usize = 2000;

/// A path from an `@` reference, resolved: relative to the project folder,
/// from the home folder after `~`, or absolute, with `.` and `..` worked out.
fn resolve_reference(project_dir: &Path, path: &str) -> PathBuf {
  let path = path.trim();
  let joined = if path == "~" {
    paths::home_dir()
  } else if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
    paths::home_dir().join(rest)
  } else {
    project_dir.join(path)
  };
  normalize(&joined)
}

/// `path` with `.` and `..` worked out, without reaching above its root.
fn normalize(path: &Path) -> PathBuf {
  let mut out = PathBuf::new();
  for component in path.components() {
    match component {
      Component::CurDir => {}
      Component::ParentDir => {
        if matches!(out.components().next_back(), Some(Component::Normal(_))) {
          out.pop();
        }
      }
      other => out.push(other.as_os_str()),
    }
  }
  out
}

/// One folder's entries: folders first, then files, each by name.
fn list_dir(dir: &Path) -> DirListing {
  let shown = dir.to_string_lossy().to_string();
  let failed = |error: &str| DirListing { dir: shown.clone(), error: Some(error.into()), ..Default::default() };
  if dir.is_file() {
    return failed("This is a file, not a folder.");
  }
  let read = match std::fs::read_dir(dir) {
    Ok(read) => read,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return failed("There's no folder here."),
    Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
      return failed("You don't have access to this folder.")
    }
    Err(_) => return failed("Couldn't open this folder."),
  };
  let mut entries: Vec<DirEntryInfo> = read
    .flatten()
    .map(|entry| {
      // A link to a folder is browsed like one.
      let dir = entry.file_type().is_ok_and(|t| t.is_dir() || (t.is_symlink() && entry.path().is_dir()));
      DirEntryInfo { name: entry.file_name().to_string_lossy().to_string(), dir }
    })
    .collect();
  entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
  let truncated = entries.len() > MAX_DIR_ENTRIES;
  entries.truncate(MAX_DIR_ENTRIES);
  DirListing { dir: shown, entries, truncated, error: None }
}

/// List one folder for an `@` reference in chat, which can point at anything
/// the user can open, in the project or outside it. Names only: nothing is read.
pub async fn files_list_dir(id: String, path: String) -> DirListing {
  let Some(project) = find_project(&id) else {
    return DirListing { error: Some("Project not found.".into()), ..Default::default() };
  };
  let dir = resolve_reference(Path::new(&project.path), &path);
  tokio::task::spawn_blocking(move || list_dir(&dir))
    .await
    .unwrap_or_else(|_| DirListing { error: Some("Couldn't open this folder.".into()), ..Default::default() })
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

  #[test]
  fn references_resolve_from_the_project_the_home_folder_or_a_full_path() {
    let project = std::env::temp_dir().join("fabricator-refs").join("app");
    assert_eq!(resolve_reference(&project, "../shared/"), project.parent().unwrap().join("shared"));
    assert_eq!(resolve_reference(&project, "./src/../rayfin"), project.join("rayfin"));
    assert_eq!(resolve_reference(&project, "~/notes"), paths::home_dir().join("notes"));
    let elsewhere = std::env::temp_dir().join("elsewhere");
    assert_eq!(resolve_reference(&project, &elsewhere.to_string_lossy()), elsewhere);
    // However many `..`, never above the root.
    let root = project.ancestors().last().unwrap().to_path_buf();
    assert_eq!(resolve_reference(&project, &"../".repeat(40)), root);
  }

  #[test]
  fn a_folder_lists_folders_first_then_files_by_name_or_says_why_it_cannot() {
    let dir = std::env::temp_dir().join(format!("fabricator-list-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("beta")).unwrap();
    std::fs::create_dir_all(dir.join("Alpha")).unwrap();
    std::fs::write(dir.join("notes.md"), "x").unwrap();
    std::fs::write(dir.join("a.txt"), "x").unwrap();

    let listing = list_dir(&dir);
    assert_eq!(listing.error, None);
    let entries: Vec<(&str, bool)> = listing.entries.iter().map(|e| (e.name.as_str(), e.dir)).collect();
    assert_eq!(entries, [("Alpha", true), ("beta", true), ("a.txt", false), ("notes.md", false)]);
    assert_eq!(list_dir(&dir.join("missing")).error.as_deref(), Some("There's no folder here."));
    assert_eq!(list_dir(&dir.join("a.txt")).error.as_deref(), Some("This is a file, not a folder."));
    std::fs::remove_dir_all(&dir).unwrap();
  }
}
