//! Small filesystem/string helpers shared by the projects, git, and files
//! command modules. Ported from the equivalent helpers in
//! `src/main/services/{projects,git,files}.ts`.

use std::path::{Component, Path, PathBuf};

use crate::types::{ProjectsState, StudioProject};

/// Turn a display name into a safe, predictable folder name.
pub fn slugify(name: &str) -> String {
  let lower = name.trim().to_lowercase();
  let mut out = String::with_capacity(lower.len());
  let mut prev_dash = false;
  for ch in lower.chars() {
    if ch.is_ascii_alphanumeric() {
      out.push(ch);
      prev_dash = false;
    } else if !prev_dash {
      out.push('-');
      prev_dash = true;
    }
  }
  out.trim_matches('-').to_string()
}

/// True when `dir` looks like a Rayfin project (`rayfin/rayfin.yml` present).
pub fn is_rayfin_project(dir: &str) -> bool {
  Path::new(dir).join("rayfin").join("rayfin.yml").exists()
}

/// Lexically normalize a path (resolve `.`/`..` without touching the disk).
pub fn normalize(p: &Path) -> PathBuf {
  let mut out = PathBuf::new();
  for comp in p.components() {
    match comp {
      Component::ParentDir => {
        out.pop();
      }
      Component::CurDir => {}
      other => out.push(other.as_os_str()),
    }
  }
  out
}

/// Resolve a project-relative path, guarding against directory traversal.
/// Returns `None` when the target escapes the project root.
pub fn safe_resolve(root: &str, rel_path: &str) -> Option<PathBuf> {
  let root_resolved = normalize(Path::new(root));
  let target = normalize(&root_resolved.join(rel_path));
  if target == root_resolved || target.starts_with(&root_resolved) {
    // `starts_with` is component-wise, so it can't be fooled by a sibling whose
    // name shares a prefix with the root.
    Some(target)
  } else {
    None
  }
}

/// Case-insensitive, trailing-separator-insensitive path equality.
pub fn same_path(a: &str, b: &str) -> bool {
  let norm = |p: &str| -> String {
    normalize(Path::new(p))
      .to_string_lossy()
      .trim_end_matches(['\\', '/'])
      .to_lowercase()
  };
  norm(a) == norm(b)
}

/// Heuristic binary check: a NUL byte in the first 8 KiB means "not text".
pub fn looks_binary(buf: &[u8]) -> bool {
  buf.iter().take(8192).any(|&b| b == 0)
}

/// Annotate a project with whether its on-disk folder is still a Rayfin project.
pub fn with_missing(mut project: StudioProject) -> StudioProject {
  project.missing = Some(!is_rayfin_project(&project.path));
  project
}

/// Annotate every project in a state snapshot with its `missing` flag.
pub fn annotate_state(mut state: ProjectsState) -> ProjectsState {
  state.projects = state.projects.into_iter().map(with_missing).collect();
  state
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn slugify_strips_specials_and_collapses() {
    assert_eq!(slugify("  My App & Co! "), "my-app-co");
    assert_eq!(slugify("Hello___World"), "hello-world");
    assert_eq!(slugify("***"), "");
    assert_eq!(slugify("Café 123"), "caf-123");
  }

  #[test]
  fn safe_resolve_blocks_traversal() {
    let root = if cfg!(windows) { r"C:\proj" } else { "/proj" };
    assert!(safe_resolve(root, "src/main.rs").is_some());
    assert!(safe_resolve(root, ".").is_some());
    assert!(safe_resolve(root, "../secret.txt").is_none());
    assert!(safe_resolve(root, "src/../../etc").is_none());
  }

  #[test]
  fn looks_binary_detects_nul() {
    assert!(looks_binary(b"abc\0def"));
    assert!(!looks_binary(b"plain text"));
  }
}
