//! Install-acceleration for the Universal template.
//!
//! Two optional, per-platform artifacts ship under
//! `resources/fabricator-universal-deps/` (generated at release time):
//!   - `node_modules.tgz` — a prebuilt dependency tree for the lean base. When
//!     present we scaffold with `--skip-install` and extract this instead, so the
//!     first create is near-instant.
//!   - `npm-cache.tgz` — a warm npm cache. Extracted once into the writable data
//!     dir; pointing npm at it (via `npm_config_cache` + `prefer-offline`) makes
//!     the capability router's later on-demand `npm install`s resolve offline.
//!
//! Everything here is best-effort. When an artifact is absent (dev/source builds,
//! or a platform we didn't ship it for) or extraction fails, callers fall back to
//! a normal network install — `prefer-offline` (never `offline`) guarantees a
//! cache miss can't break an install.

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::AppHandle;

use crate::services::paths;

/// Fixed artifact names inside the deps dir.
const NODE_MODULES_TGZ: &str = "node_modules.tgz";
const NPM_CACHE_TGZ: &str = "npm-cache.tgz";
/// Marker written under the extracted cache so it is only expanded once.
const CACHE_READY_MARKER: &str = ".fabricator-cache-ready";

/// Path to the prebuilt `node_modules.tgz` for this platform, if it shipped.
pub fn universal_node_modules_tarball(app: &AppHandle) -> Option<PathBuf> {
  let p = paths::fabricator_universal_deps_dir(app).join(NODE_MODULES_TGZ);
  p.is_file().then_some(p)
}

/// Path to the warm `npm-cache.tgz` for this platform, if it shipped.
fn universal_npm_cache_tarball(app: &AppHandle) -> Option<PathBuf> {
  let p = paths::fabricator_universal_deps_dir(app).join(NPM_CACHE_TGZ);
  p.is_file().then_some(p)
}

/// Extract a gzipped tar into `dest` (created if needed) with the system `tar`
/// (present on Windows 10+, macOS, and Linux). `tar` preserves the symlinks that
/// node_modules `.bin` relies on, unlike zip. Returns true on success.
pub fn extract_tgz(tarball: &Path, dest: &Path) -> bool {
  if std::fs::create_dir_all(dest).is_err() {
    return false;
  }
  let mut cmd = Command::new("tar");
  cmd.arg("-xzf").arg(tarball).arg("-C").arg(dest);
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW — don't flash a console.
    cmd.creation_flags(0x0800_0000);
  }
  matches!(cmd.status(), Ok(s) if s.success())
}

/// Ensure the bundled warm npm cache is extracted to a writable location, once.
/// Returns the cache directory when available (freshly extracted or already
/// present), or `None` when no cache shipped or extraction failed.
pub fn ensure_offline_cache(app: &AppHandle) -> Option<PathBuf> {
  let dest = paths::npm_offline_cache_dir();
  let marker = dest.join(CACHE_READY_MARKER);
  if marker.is_file() {
    return Some(dest);
  }
  let tarball = universal_npm_cache_tarball(app)?;
  if !extract_tgz(&tarball, &dest) {
    return None;
  }
  let _ = std::fs::write(&marker, b"1");
  Some(dest)
}

/// Best-effort: point this process at the warm offline cache so every npm the app
/// spawns later — including the agent's on-demand `npm install`s, which inherit
/// the app/CLI-server environment — resolves from the cache first. `prefer-offline`
/// keeps a network fallback, so a miss never breaks an install. No-op when no
/// cache shipped (dev/source builds), leaving the user's default npm cache in
/// place.
///
/// When the cache was already extracted on a prior launch we activate it
/// synchronously (so every child spawned this session inherits it); on the first
/// launch we extract in the background and activate once it finishes.
pub fn init_process_offline_cache(app: &AppHandle) {
  if universal_npm_cache_tarball(app).is_none() {
    return;
  }
  let cache_dir = paths::npm_offline_cache_dir();
  if cache_dir.join(CACHE_READY_MARKER).is_file() {
    activate_offline_cache(&cache_dir);
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || {
    if let Some(dir) = ensure_offline_cache(&app) {
      activate_offline_cache(&dir);
    }
  });
}

/// Set the npm env vars that route installs through `cache_dir` with a network
/// fallback. Process-global, so children spawned afterwards inherit them.
fn activate_offline_cache(cache_dir: &Path) {
  std::env::set_var("npm_config_cache", cache_dir);
  std::env::set_var("npm_config_prefer_offline", "true");
}
