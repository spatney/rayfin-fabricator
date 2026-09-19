//! Filesystem locations, mirroring Electron's `app.getPath(...)` usage.
//!
//! The Electron build stored per-user state under `app.getPath('userData')`,
//! which on Windows resolves to `%APPDATA%\Roaming\<productName>`. To preserve
//! continuity with existing installs we resolve the same directory here, checking
//! the packaged product name first and the dev folder name second.

use std::path::PathBuf;

/// Candidate userData folder names, most-preferred first. "Rayfin Fabricator" is
/// the packaged `productName`; "rayfin-desktop" is the dev-mode app name.
const DATA_DIR_CANDIDATES: &[&str] = &["Rayfin Fabricator", "rayfin-desktop"];

/// Roaming app-data base (`%APPDATA%` on Windows, XDG/Library elsewhere).
fn data_base() -> PathBuf {
  dirs::data_dir().unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
}

/// The per-user data directory (Electron `userData` equivalent). Prefers an
/// existing candidate so prior Electron state is reused; otherwise the canonical
/// product-name folder.
///
/// Debug builds may isolate a test instance with `FABRICATOR_DEV_DATA_DIR`.
/// It must be a nonempty absolute path; invalid values terminate with exit code
/// 2 rather than touching normal user data. Release builds ignore the variable.
/// This overrides app-owned files only, not Tauri's webview profile identifier.
pub fn data_dir() -> PathBuf {
  #[cfg(debug_assertions)]
  if let Some(value) = std::env::var_os("FABRICATOR_DEV_DATA_DIR") {
    return match validated_dev_data_dir(&value) {
      Ok(path) => path,
      Err(error) => {
        // Do not log through crashlog: its own path calls data_dir().
        eprintln!("{error}");
        std::process::exit(2);
      }
    };
  }
  let base = data_base();
  for name in DATA_DIR_CANDIDATES {
    let p = base.join(name);
    if p.exists() {
      return p;
    }
  }
  base.join(DATA_DIR_CANDIDATES[0])
}

#[cfg(any(debug_assertions, test))]
fn validated_dev_data_dir(value: &std::ffi::OsStr) -> Result<PathBuf, &'static str> {
  let path = PathBuf::from(value);
  if value.is_empty() || !path.is_absolute() {
    return Err(
      "FABRICATOR_DEV_DATA_DIR must be a nonempty absolute path; refusing to fall back to the normal application-data directory.",
    );
  }
  Ok(path)
}

/// Ensure the data directory exists and return it.
pub fn ensure_data_dir() -> std::io::Result<PathBuf> {
  let d = data_dir();
  std::fs::create_dir_all(&d)?;
  Ok(d)
}

/// User home directory (Electron `app.getPath('home')`).
pub fn home_dir() -> PathBuf {
  dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// OS temp directory (Electron `app.getPath('temp')`).
pub fn temp_dir() -> PathBuf {
  std::env::temp_dir()
}

/// Per-user logs directory (created on demand).
pub fn logs_dir() -> PathBuf {
  let d = data_dir().join("logs");
  let _ = std::fs::create_dir_all(&d);
  d
}

/// Per-project chat transcript directory.
pub fn chats_dir() -> PathBuf {
  data_dir().join("chats")
}

/// Directory holding saved Advisor reports (one JSON file per project).
pub fn advisor_dir() -> PathBuf {
  let d = data_dir().join("advisor");
  let _ = std::fs::create_dir_all(&d);
  d
}

/// The saved-report file for one project. The id is sanitized so it is always a
/// safe single path segment.
pub fn advisor_file(project_id: &str) -> PathBuf {
  let safe: String = project_id
    .chars()
    .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
    .collect();
  advisor_dir().join(format!("{safe}.json"))
}

/// Directory holding cached starter-suggestion sets (one JSON file per project).
pub fn suggest_dir() -> PathBuf {
  let d = data_dir().join("suggestions");
  let _ = std::fs::create_dir_all(&d);
  d
}

/// The cached-suggestions file for one project. The id is sanitized so it is
/// always a safe single path segment.
pub fn suggest_file(project_id: &str) -> PathBuf {
  let safe: String = project_id
    .chars()
    .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
    .collect();
  suggest_dir().join(format!("{safe}.json"))
}

/// The JSON file backing app state (projects, settings).
pub fn store_file() -> PathBuf {
  data_dir().join("studio.json")
}

/// Scratch directory for preview region-screenshots (deferred feature).
pub fn shots_dir() -> PathBuf {
  temp_dir().join("rayfin-fabricator-shots")
}

/// Absolute path to the bundled Fabricator templates directory.
///
/// Packaged builds ship the templates under `<resource_dir>/resources/
/// fabricator-templates` (see `bundle.resources` in `tauri.conf.json`). In dev
/// there is no resource bundle, so fall back to the in-repo source tree at
/// `<crate>/../resources/fabricator-templates`.
pub fn fabricator_templates_dir(app: &tauri::AppHandle) -> PathBuf {
  use tauri::Manager;
  if let Ok(res) = app.path().resource_dir() {
    let bundled = res.join("resources").join("fabricator-templates");
    if bundled.is_dir() {
      return bundled;
    }
  }
  let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  crate_dir
    .parent()
    .map(|p| p.to_path_buf())
    .unwrap_or(crate_dir)
    .join("resources")
    .join("fabricator-templates")
}

/// Writable per-user npm cache Fabricator points every spawned npm at (via
/// `npm_config_cache`). Seeded once from the bundled warm cache; npm also writes
/// its own cache misses here. Lives under app-data so it survives across projects
/// and app updates.
pub fn npm_cache_dir() -> PathBuf {
  data_dir().join("npm-cache")
}

/// Absolute path to the warm npm cache bundled with the app, when present.
///
/// Packaged builds ship it under `<resource_dir>/resources/npm-cache` (see
/// `bundle.resources` in `tauri.conf.json`); the cache itself is warmed
/// per-platform in CI. Dev builds fall back to the in-repo path, which is
/// normally empty (nothing is committed there), so seeding is a no-op and npm
/// uses the network.
pub fn bundled_npm_cache_dir(app: &tauri::AppHandle) -> PathBuf {
  use tauri::Manager;
  if let Ok(res) = app.path().resource_dir() {
    let bundled = res.join("resources").join("npm-cache");
    if bundled.is_dir() {
      return bundled;
    }
  }
  let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  crate_dir
    .parent()
    .map(|p| p.to_path_buf())
    .unwrap_or(crate_dir)
    .join("resources")
    .join("npm-cache")
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::ffi::OsStr;

  #[test]
  fn design_debug_data_dir_requires_an_absolute_nonempty_path() {
    for invalid in ["", " ", ".", "..", "relative-data"] {
      assert!(validated_dev_data_dir(OsStr::new(invalid)).is_err(), "{invalid:?}");
    }
    #[cfg(windows)]
    for invalid in [r"C:relative-data", r"\rooted-without-a-drive"] {
      assert!(validated_dev_data_dir(OsStr::new(invalid)).is_err(), "{invalid:?}");
    }
    let absolute = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("isolated-debug-data");
    assert_eq!(validated_dev_data_dir(absolute.as_os_str()).unwrap(), absolute);
  }

  #[cfg(debug_assertions)]
  #[test]
  fn design_invalid_debug_data_dir_fails_explicitly_without_fallback() {
    const CHILD: &str = "FABRICATOR_TEST_INVALID_DATA_DIR";
    if std::env::var_os(CHILD).is_some() {
      let _ = data_dir();
      panic!("invalid override unexpectedly reached a data directory");
    }
    let result = std::process::Command::new(std::env::current_exe().unwrap())
      .args([
        "--exact",
        "services::paths::tests::design_invalid_debug_data_dir_fails_explicitly_without_fallback",
        "--nocapture",
      ])
      .env(CHILD, "1")
      .env("FABRICATOR_DEV_DATA_DIR", "relative-data")
      .output()
      .unwrap();
    assert_eq!(result.status.code(), Some(2));
    let error = String::from_utf8_lossy(&result.stderr);
    assert!(error.contains("FABRICATOR_DEV_DATA_DIR"));
    assert!(error.contains("refusing to fall back"));
  }
}
