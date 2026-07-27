//! Bundled warm npm cache: a prebuilt cacache of the Universal App's
//! dependencies (base template + capability packs), shipped as an app resource
//! so the first `npm install` after creating a project resolves from a local
//! cache instead of downloading ~30+ packages over the network — the slow
//! first-run experience this exists to fix.
//!
//! Two moving parts:
//!   * [`configure_env`] points every spawned npm at a writable per-user cache
//!     dir and turns on `prefer-offline` (process-wide, so `npm create`, the
//!     deploy-time install, and agent-driven pack installs all benefit). Mirrors
//!     [`crate::enable_rayfin_encryption_fallback`]: set once at startup, then
//!     inherited by every child process.
//!   * [`ensure_seeded`] copies the read-only bundled cache into that writable
//!     dir once per app version (bundled resources are read-only / code-signed,
//!     so npm cannot write into them). Mirrors
//!     [`crate::services::agent_skills::ensure_materialized`].
//!
//! Everything is best-effort: with no bundled cache (dev builds) or on any I/O
//! error, npm simply falls back to the network. `--prefer-offline` (not
//! `--offline`) keeps that fallback graceful for cache misses and newly
//! published in-range versions.

use std::path::Path;

use crate::services::paths;

/// File under the writable cache recording the app version its contents were
/// seeded from, so a matching version short-circuits re-seeding.
const SEED_SENTINEL: &str = ".seeded-version";

/// Point every npm process Fabricator spawns at the writable warm cache and
/// enable offline-preferring, quiet installs. Set process-wide (like the Rayfin
/// encryption fallback) so it propagates to every spawned CLI/agent child.
///
/// The cache location is set unconditionally — the warm cache is the whole point
/// — but only for npm children of *this* process, never the user's own shell.
pub fn configure_env() {
  let cache = paths::npm_cache_dir();
  let _ = std::fs::create_dir_all(&cache);
  std::env::set_var("npm_config_cache", cache.as_os_str());
  std::env::set_var("npm_config_prefer_offline", "true");
  std::env::set_var("npm_config_audit", "false");
  std::env::set_var("npm_config_fund", "false");
}

/// Copy the bundled warm cache into the writable per-user npm cache once per app
/// version. Best-effort and idempotent: a matching version sentinel
/// short-circuits, and a missing bundled cache (dev builds) is a no-op. Safe to
/// call from a background thread at startup.
pub fn ensure_seeded(app: &tauri::AppHandle, app_version: &str) {
  let bundled = paths::bundled_npm_cache_dir(app);
  let target = paths::npm_cache_dir();
  match seed_into(&bundled, &target, app_version) {
    Ok(true) => log::info!("seeded warm npm cache ({app_version})"),
    Ok(false) => {}
    Err(e) => log::warn!("failed to seed warm npm cache: {e}"),
  }
}

/// Version-guarded copy of `<bundled>/_cacache` into `<target>/_cacache`. Returns
/// `Ok(true)` when a copy happened, `Ok(false)` when it was skipped (already
/// seeded for this version, or no bundled cache to seed). Takes plain paths so it
/// is unit-testable without an app handle.
fn seed_into(bundled: &Path, target: &Path, app_version: &str) -> std::io::Result<bool> {
  let src = bundled.join("_cacache");
  if !src.is_dir() {
    // No bundled cache (dev build) — nothing to seed; npm will use the network.
    return Ok(false);
  }
  let sentinel = target.join(SEED_SENTINEL);
  if target.join("_cacache").is_dir() {
    if let Ok(seen) = std::fs::read_to_string(&sentinel) {
      if seen.trim() == app_version {
        return Ok(false); // Already seeded for this version.
      }
    }
  }
  std::fs::create_dir_all(target)?;
  copy_dir_all(&src, &target.join("_cacache"))?;
  std::fs::write(&sentinel, app_version)?;
  Ok(true)
}

/// Recursively copy `src` into `dst`, merging into any existing tree. cacache is
/// content-addressed, so overwriting identical entries is safe.
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
  std::fs::create_dir_all(dst)?;
  for entry in std::fs::read_dir(src)? {
    let entry = entry?;
    let from = entry.path();
    let to = dst.join(entry.file_name());
    if entry.file_type()?.is_dir() {
      copy_dir_all(&from, &to)?;
    } else {
      std::fs::copy(&from, &to)?;
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn unique_dir(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("npm-cache-{tag}-{}", uuid::Uuid::new_v4()))
  }

  /// Write a bundled-cache layout (`<dir>/_cacache/<rel>` = `body`).
  fn write_bundled(dir: &Path, rel: &str, body: &str) {
    let p = dir.join("_cacache").join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
  }

  #[test]
  fn seed_into_is_a_noop_without_a_bundled_cache() {
    let bundled = unique_dir("nobundle");
    let target = unique_dir("nobundle-target");
    std::fs::create_dir_all(&bundled).unwrap();

    assert_eq!(seed_into(&bundled, &target, "1.0.0").unwrap(), false);
    // Nothing seeded → no _cacache and no sentinel written.
    assert!(!target.join("_cacache").exists());
    assert!(!target.join(SEED_SENTINEL).exists());

    let _ = std::fs::remove_dir_all(&bundled);
    let _ = std::fs::remove_dir_all(&target);
  }

  #[test]
  fn seed_into_copies_then_skips_on_matching_version() {
    let bundled = unique_dir("copy");
    let target = unique_dir("copy-target");
    write_bundled(&bundled, "content-v2/sha512/ab/cd/pkg.tgz", "tarball-bytes");

    // First call copies and records the version.
    assert_eq!(seed_into(&bundled, &target, "1.2.3").unwrap(), true);
    let seeded = target.join("_cacache").join("content-v2/sha512/ab/cd/pkg.tgz");
    assert!(seeded.is_file());
    assert_eq!(std::fs::read_to_string(&seeded).unwrap(), "tarball-bytes");
    assert_eq!(std::fs::read_to_string(target.join(SEED_SENTINEL)).unwrap(), "1.2.3");

    // A user/npm write into the seeded cache must survive a same-version restart:
    // the second call short-circuits and does not re-copy.
    std::fs::write(&seeded, "locally-modified").unwrap();
    assert_eq!(seed_into(&bundled, &target, "1.2.3").unwrap(), false);
    assert_eq!(std::fs::read_to_string(&seeded).unwrap(), "locally-modified");

    let _ = std::fs::remove_dir_all(&bundled);
    let _ = std::fs::remove_dir_all(&target);
  }

  #[test]
  fn seed_into_reseeds_on_a_new_app_version() {
    let bundled = unique_dir("bump");
    let target = unique_dir("bump-target");
    write_bundled(&bundled, "content-v2/sha512/aa/one.tgz", "v1-bytes");
    assert_eq!(seed_into(&bundled, &target, "1.0.0").unwrap(), true);

    // A newer app ships a fresh bundled cache; a version bump must re-seed it.
    write_bundled(&bundled, "content-v2/sha512/bb/two.tgz", "v2-bytes");
    assert_eq!(seed_into(&bundled, &target, "2.0.0").unwrap(), true);

    assert!(target.join("_cacache").join("content-v2/sha512/bb/two.tgz").is_file());
    assert_eq!(std::fs::read_to_string(target.join(SEED_SENTINEL)).unwrap(), "2.0.0");

    let _ = std::fs::remove_dir_all(&bundled);
    let _ = std::fs::remove_dir_all(&target);
  }
}
