//! Read-only project file access for the in-app code viewer. Ported from
//! `src/main/services/files.ts`. Sandboxed to the project directory: reads are
//! traversal-guarded and heavy/generated folders are pruned from the tree.

use std::path::Path;

use crate::commands::util::{looks_binary, safe_resolve};
use crate::services::store::find_project;
use crate::types::{FileContent, FileNode};

/// Folders never worth showing in a code viewer (huge and/or generated).
const EXCLUDED_DIRS: [&str; 11] = [
  "node_modules", ".git", "dist", "out", "build", ".next", ".turbo", ".cache", ".vite", "coverage", ".DS_Store",
];
const MAX_ENTRIES: usize = 8000;
const MAX_DEPTH: usize = 12;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

fn walk(dir: &Path, rel: &str, depth: usize, budget: &mut usize) -> Vec<FileNode> {
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
      let children = walk(&entry.path(), &child_rel, depth + 1, budget);
      dirs.push(FileNode {
        name,
        path: child_rel,
        r#type: "dir".into(),
        children: Some(children),
      });
    } else if file_type.is_file() {
      *budget += 1;
      let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
      files.push(FileNode {
        name,
        path,
        r#type: "file".into(),
        children: None,
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
  let mut budget = 0usize;
  walk(Path::new(&project.path), "", 0, &mut budget)
}

/// Read a single project file for the viewer (text only, size-capped).
pub async fn files_read(id: String, path: String) -> FileContent {
  let err = |size: u64, message: &str| FileContent {
    path: path.clone(),
    size,
    content: None,
    binary: None,
    too_large: None,
    error: Some(message.to_string()),
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
    Err(_) => return err(0, "File not found."),
  };

  if size > MAX_FILE_BYTES {
    return FileContent {
      path,
      size,
      content: None,
      binary: None,
      too_large: Some(true),
      error: None,
    };
  }

  match std::fs::read(&target) {
    Ok(buf) if looks_binary(&buf) => FileContent {
      path,
      size,
      content: None,
      binary: Some(true),
      too_large: None,
      error: None,
    },
    Ok(buf) => FileContent {
      path,
      size,
      content: Some(String::from_utf8_lossy(&buf).to_string()),
      binary: None,
      too_large: None,
      error: None,
    },
    Err(_) => err(size, "Could not read the file."),
  }
}
