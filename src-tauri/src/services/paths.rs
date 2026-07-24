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
pub fn data_dir() -> PathBuf {
  let base = data_base();
  for name in DATA_DIR_CANDIDATES {
    let p = base.join(name);
    if p.exists() {
      return p;
    }
  }
  base.join(DATA_DIR_CANDIDATES[0])
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
