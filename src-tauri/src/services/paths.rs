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

/// Directory holding the Help assistant's saved conversation.
pub fn help_dir() -> PathBuf {
  let d = data_dir().join("help");
  let _ = std::fs::create_dir_all(&d);
  d
}

/// The Help assistant's saved conversation. One file: Help is a single
/// app-wide surface, not a per-project one.
pub fn help_session_file() -> PathBuf {
  help_dir().join("session.json")
}

/// The saved-report file for one project. The id is sanitized so it is always a
/// safe single path segment.
pub fn advisor_file(project_id: &str) -> PathBuf {
  advisor_dir().join(format!("{}.json", safe_segment(project_id)))
}

/// The renderer-owned Advisor lifecycle state (dismissals, hand-offs, baseline)
/// for one project, kept next to its saved review.
pub fn advisor_state_file(project_id: &str) -> PathBuf {
  advisor_dir().join(format!("{}.state.json", safe_segment(project_id)))
}

fn safe_segment(id: &str) -> String {
  id.chars()
    .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
    .collect()
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

/// Storage left behind by the retired Design Studio experiment (drafts,
/// receipts, imported assets). Removed best-effort at startup.
pub fn retired_design_studio_dir() -> PathBuf {
  data_dir().join("design")
}

/// The per-user npm cache earlier releases pointed every spawned npm at and
/// seeded from a cache bundled with the app. npm now uses its normal cache, so
/// this is removed best-effort at startup.
pub fn retired_npm_cache_dir() -> PathBuf {
  data_dir().join("npm-cache")
}

/// Scratch directory for preview region-screenshots (deferred feature).
pub fn shots_dir() -> PathBuf {
  temp_dir().join("rayfin-fabricator-shots")
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::ffi::OsStr;

  #[test]
  fn debug_data_dir_requires_an_absolute_nonempty_path() {
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
  fn invalid_debug_data_dir_fails_explicitly_without_fallback() {
    const CHILD: &str = "FABRICATOR_TEST_INVALID_DATA_DIR";
    if std::env::var_os(CHILD).is_some() {
      let _ = data_dir();
      panic!("invalid override unexpectedly reached a data directory");
    }
    let result = std::process::Command::new(std::env::current_exe().unwrap())
      .args([
        "--exact",
        "services::paths::tests::invalid_debug_data_dir_fails_explicitly_without_fallback",
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
