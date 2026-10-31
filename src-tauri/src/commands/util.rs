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

/// Annotate a project with what its folder says now: whether it's still a Rayfin
/// project (`missing`), and whether its published app works only inside the
/// Fabric portal shell (`needs_fabric_portal`).
pub fn annotate_project(mut project: StudioProject) -> StudioProject {
  project.missing = Some(!is_rayfin_project(&project.path));
  project.needs_fabric_portal =
    Some(crate::commands::fabric::needs_fabric_portal(Path::new(&project.path)));
  project
}

/// Annotate every project in a state snapshot (see [`annotate_project`]). While the
/// Team workspaces experiment is off, team projects and workspaces stay stored
/// but are left out of the snapshot.
pub fn annotate_state(mut state: ProjectsState) -> ProjectsState {
  if !crate::services::store::team_workspaces_enabled() {
    hide_team(&mut state);
  }
  state.projects = state.projects.into_iter().map(annotate_project).collect();
  state
}

/// Drop team workspaces and team projects from a state snapshot (not the store).
pub fn hide_team(state: &mut ProjectsState) {
  state.team_workspaces.clear();
  let active_hidden = state
    .active_project_id
    .as_ref()
    .is_some_and(|id| state.projects.iter().any(|p| &p.id == id && p.team.is_some()));
  state.projects.retain(|p| p.team.is_none());
  if active_hidden {
    state.active_project_id = None;
  }
}

/// Current UTC time as an ISO-8601 string with millisecond precision (matches
/// the JavaScript `new Date().toISOString()` used by the original services).
pub fn now_iso() -> String {
  chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
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

  #[test]
  fn hide_team_drops_team_projects_and_clears_their_selection() {
    let mut state: ProjectsState = serde_json::from_value(serde_json::json!({
      "workspaceRoot": "C:/w",
      "activeProjectId": "t",
      "projects": [
        {"id":"p","name":"Mine","path":"C:/w/mine","addedAt":"2026-01-01T00:00:00.000Z"},
        {"id":"t","name":"Team","path":"C:/w/team/app/app","addedAt":"2026-01-01T00:00:00.000Z",
         "team":{"workspaceId":"w1","folder":"app","worktree":"C:/w/team/app"}}
      ],
      "teamWorkspaces": [{"id":"w1","name":"Team","repo":"o/r","dir":"C:/w/team","addedAt":"2026-01-01T00:00:00.000Z"}]
    }))
    .unwrap();
    hide_team(&mut state);
    assert_eq!(state.projects.len(), 1);
    assert_eq!(state.projects[0].id, "p");
    assert!(state.team_workspaces.is_empty());
    assert_eq!(state.active_project_id, None);
  }
}
