//! Where a Rayfin app keeps its frontend, data model and functions. Mirrors the
//! renderer's `src/renderer/src/model/projectLayout.ts`.
//!
//! Single-package apps keep the frontend in `src/`, the data model in
//! `rayfin/data/` and functions in `rayfin/functions/`. Workspace apps, such as
//! the Rayfin CLI's Universal App, keep each in its own npm package, which
//! `rayfin/rayfin.yml` names with `services.<service>.path` (`packages/frontend`,
//! `packages/data`, `packages/functions`). The Rayfin CLI builds and deploys
//! each service from that folder.

use std::path::Path;

/// Project-relative folders, always with `/` separators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectLayout {
  /// The frontend package's folder: `""` for the project root.
  pub frontend_root: String,
  /// The data model's source folder: `rayfin/data`, or a data package's `src`.
  pub data_dir: String,
  /// The functions package's folder: `rayfin/functions` unless rayfin.yml names another.
  pub functions_root: String,
}

impl Default for ProjectLayout {
  /// A single-package app, and one whose rayfin.yml can't be read.
  fn default() -> Self {
    Self {
      frontend_root: String::new(),
      data_dir: "rayfin/data".into(),
      functions_root: "rayfin/functions".into(),
    }
  }
}

impl ProjectLayout {
  /// The layout `rayfin/rayfin.yml`'s text describes.
  pub fn parse(rayfin_yml: &str) -> Self {
    let text = rayfin_yml.strip_prefix('\u{feff}').unwrap_or(rayfin_yml);
    let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(text) else {
      return Self::default();
    };
    let folder = |service: &str| doc.get("services")?.get(service)?.get("path")?.as_str().and_then(service_folder);
    let default = Self::default();
    Self {
      frontend_root: folder("staticHosting").unwrap_or_default(),
      // The CLI reads entities from a data package's exports; the project root
      // (the default) keeps them in `rayfin/data/`.
      data_dir: folder("data").filter(|f| !f.is_empty()).map(|f| format!("{f}/src")).unwrap_or(default.data_dir),
      functions_root: folder("functions").filter(|f| !f.is_empty()).unwrap_or(default.functions_root),
    }
  }

  /// The layout of the project in `project_dir`, from its `rayfin/rayfin.yml`.
  pub fn read(project_dir: &Path) -> Self {
    ["rayfin.yml", "rayfin.yaml"]
      .iter()
      .find_map(|name| std::fs::read_to_string(project_dir.join("rayfin").join(name)).ok())
      .map(|text| Self::parse(&text))
      .unwrap_or_default()
  }

  /// The frontend's source folder: `src`, or `<frontend_root>/src`.
  pub fn frontend_src(&self) -> String {
    join(&self.frontend_root, "src")
  }

  /// The functions' source folder: `<functions_root>/src`.
  pub fn functions_src(&self) -> String {
    join(&self.functions_root, "src")
  }
}

/// A `services.<service>.path` as a normalized project-relative folder: `""`
/// for the project root, `None` when it would leave the project.
pub fn service_folder(value: &str) -> Option<String> {
  let raw = value.trim().replace('\\', "/");
  let drive = raw.len() >= 2 && raw.as_bytes()[0].is_ascii_alphabetic() && raw.as_bytes()[1] == b':';
  if raw.starts_with('/') || drive {
    return None;
  }
  let mut parts = Vec::new();
  for segment in raw.split('/') {
    match segment {
      "" | "." => {}
      ".." => return None,
      name => parts.push(name),
    }
  }
  Some(parts.join("/"))
}

/// `dir/rel`, or `rel` when `dir` is the project root (`""`).
pub fn join(dir: &str, rel: &str) -> String {
  if dir.is_empty() { rel.to_string() } else { format!("{dir}/{rel}") }
}

/// `path` relative to the folder `dir`, or `None` when it isn't inside it.
pub fn relative_to<'a>(path: &'a str, dir: &str) -> Option<&'a str> {
  if dir.is_empty() {
    return Some(path);
  }
  path.strip_prefix(dir)?.strip_prefix('/')
}

/// Whether `path` is inside the folder `dir` (the project root `""` holds everything).
pub fn is_under(path: &str, dir: &str) -> bool {
  relative_to(path, dir).is_some()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn single_package_apps_use_the_root_and_rayfin_folders() {
    for yml in ["", "not: [valid", "id: app\nservices:\n  data:\n    enabled: true\n", "services:\n  data:\n    path: .\n"] {
      assert_eq!(ProjectLayout::parse(yml), ProjectLayout::default(), "{yml:?}");
    }
    let layout = ProjectLayout::default();
    assert_eq!(layout.frontend_src(), "src");
    assert_eq!(layout.functions_src(), "rayfin/functions/src");
  }

  #[test]
  fn workspace_apps_use_the_packages_rayfin_yml_names() {
    // The Rayfin CLI's Universal App, with its functions pack applied.
    let yml = "\u{feff}services:\n  data:\n    enabled: false\n    path: packages/data\n  staticHosting:\n    path: ./packages/frontend/\n  functions:\n    path: packages\\functions\n";
    let layout = ProjectLayout::parse(yml);
    assert_eq!(
      layout,
      ProjectLayout {
        frontend_root: "packages/frontend".into(),
        data_dir: "packages/data/src".into(),
        functions_root: "packages/functions".into(),
      }
    );
    assert_eq!(layout.frontend_src(), "packages/frontend/src");
    assert_eq!(layout.functions_src(), "packages/functions/src");
  }

  #[test]
  fn paths_that_leave_the_project_are_ignored() {
    for outside in ["../elsewhere", "/abs/app", "C:/app", "c:app", "packages/../../x"] {
      assert_eq!(service_folder(outside), None, "{outside}");
      let yml = format!("services:\n  staticHosting:\n    path: {outside:?}\n  data:\n    path: {outside:?}\n");
      assert_eq!(ProjectLayout::parse(&yml), ProjectLayout::default(), "{outside}");
    }
    assert_eq!(service_folder(" ./a//b/ ").as_deref(), Some("a/b"));
    assert_eq!(service_folder(".").as_deref(), Some(""));
  }

  #[test]
  fn paths_are_matched_by_folder() {
    assert_eq!(relative_to("packages/frontend/src/App.tsx", "packages/frontend"), Some("src/App.tsx"));
    assert_eq!(relative_to("packages/frontend-old/x.ts", "packages/frontend"), None);
    assert_eq!(relative_to("packages/frontend", "packages/frontend"), None);
    assert_eq!(relative_to("src/App.tsx", ""), Some("src/App.tsx"));
    assert!(is_under("rayfin/data/Todo.ts", "rayfin/data"));
    assert!(!is_under("rayfin/database.ts", "rayfin/data"));
    assert_eq!(join("", "src"), "src");
    assert_eq!(join("packages/frontend", "src"), "packages/frontend/src");
  }

  #[test]
  fn read_finds_rayfin_yml_or_yaml() {
    let dir = std::env::temp_dir().join(format!("fab-layout-{}", uuid::Uuid::new_v4()));
    assert_eq!(ProjectLayout::read(&dir), ProjectLayout::default());
    std::fs::create_dir_all(dir.join("rayfin")).unwrap();
    std::fs::write(dir.join("rayfin").join("rayfin.yaml"), "services:\n  data:\n    path: packages/data\n").unwrap();
    assert_eq!(ProjectLayout::read(&dir).data_dir, "packages/data/src");
    let _ = std::fs::remove_dir_all(&dir);
  }
}
