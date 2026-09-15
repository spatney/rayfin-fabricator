//! Bundled warm npm cache: a prebuilt cacache of the Universal App's
//! dependencies (base template + capability packs), shipped as an app resource
//! so the first `npm install` after creating a project resolves from a local
//! cache instead of downloading ~30+ packages over the network — the slow
//! first-run experience this exists to fix.
//!
//! Two moving parts:
//!   * [`configure_env`] points every spawned npm at a writable per-user cache
//!     dir without bypassing registry metadata freshness checks (process-wide,
//!     so deploy-time installs and agent-driven pack installs benefit). Mirrors
//!     [`crate::enable_rayfin_encryption_fallback`]: set once at startup, then
//!     inherited by every child process.
//!   * [`ensure_seeded`] copies the read-only bundled cache into that writable
//!     dir once per app version (bundled resources are read-only / code-signed,
//!     so npm cannot write into them). Mirrors
//!     [`crate::services::agent_skills::ensure_materialized`].
//!
//! Everything is best-effort: with no bundled cache (dev builds) or on any I/O
//! error, npm simply falls back to the network. Only lockfile-backed `npm ci`
//! prefers offline data. Registry resolution must revalidate stale metadata:
//! `prefer-offline` can report ETARGET for a published version even when online.

use std::path::Path;

use crate::services::paths;

/// File under the writable cache recording the app version its contents were
/// seeded from, so a matching version short-circuits re-seeding.
const SEED_SENTINEL: &str = ".seeded-version";

/// Point every npm process Fabricator spawns at the writable warm cache and
/// enable quiet installs with normal freshness checks. Set process-wide (like
/// the Rayfin encryption fallback) so it propagates to every CLI/agent child.
///
/// The cache location is set unconditionally — the warm cache is the whole point
/// — but only for npm children of *this* process, never the user's own shell.
pub fn configure_env() {
  let cache = paths::npm_cache_dir();
  let _ = std::fs::create_dir_all(&cache);
  for (key, value) in cache_env(&cache) {
    std::env::set_var(key, value);
  }
}

fn cache_env(cache: &Path) -> [(&'static str, std::ffi::OsString); 4] {
  [
    ("npm_config_cache", cache.as_os_str().to_owned()),
    ("npm_config_prefer_offline", "false".into()),
    ("npm_config_audit", "false".into()),
    ("npm_config_fund", "false".into()),
  ]
}

/// Resolve the latest scaffolder and its exact CLI dependency against fresh
/// registry metadata, retaining the same writable cache. Both flags are needed:
/// npm's `prefer-offline` takes precedence over `prefer-online`. Environment
/// overrides also reach npm children spawned by the scaffolder.
pub fn fresh_registry_env() -> Vec<(String, String)> {
  [
    ("npm_config_prefer_offline", "false"),
    ("npm_config_prefer_online", "true"),
  ]
  .into_iter()
  .map(|(key, value)| (key.to_string(), value.to_string()))
  .collect()
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
    Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("target")
      .join(format!("npm-cache-{tag}-{}", uuid::Uuid::new_v4()))
  }

  #[test]
  fn cache_env_preserves_the_cache_path_without_forcing_stale_metadata() {
    let cache = Path::new("Application Support").join("Rayfin Fabricator").join("npm-cache");
    let env: std::collections::HashMap<_, _> = cache_env(&cache).into_iter().collect();
    assert_eq!(env["npm_config_cache"], cache.as_os_str());
    assert_eq!(env["npm_config_prefer_offline"], "false");
    assert!(!env.contains_key("npm_config_prefer_online"));
  }

  #[test]
  fn fresh_registry_env_overrides_both_preferences_without_replacing_the_cache() {
    let env: std::collections::HashMap<_, _> = fresh_registry_env().into_iter().collect();
    assert_eq!(env["npm_config_prefer_offline"], "false");
    assert_eq!(env["npm_config_prefer_online"], "true");
    assert!(!env.contains_key("npm_config_cache"));
    assert!(!env.contains_key("npm_config_registry"));
  }

  struct RegistryFixture {
    dir: std::path::PathBuf,
    url: String,
    published: std::sync::Arc<std::sync::atomic::AtomicBool>,
    requests: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    server: Option<std::thread::JoinHandle<()>>,
  }

  impl RegistryFixture {
    fn new() -> Self {
      use std::io::{BufRead, Write};
      use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
      use std::sync::Arc;
      use std::time::Duration;

      let dir = unique_dir("registry");
      std::fs::create_dir_all(dir.join("warm cache")).unwrap();
      std::fs::write(dir.join("package.json"), r#"{"name":"cache-fixture","private":true}"#).unwrap();
      std::fs::write(dir.join("user.npmrc"), "").unwrap();
      std::fs::write(dir.join("global.npmrc"), "").unwrap();
      std::fs::write(dir.join("warm cache").join(SEED_SENTINEL), "fixture").unwrap();

      let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
      listener.set_nonblocking(true).unwrap();
      let url = format!("http://{}", listener.local_addr().unwrap());
      let published = Arc::new(AtomicBool::new(false));
      let requests = Arc::new(AtomicUsize::new(0));
      let stop = Arc::new(AtomicBool::new(false));
      let state = (published.clone(), requests.clone(), stop.clone());
      let server = std::thread::spawn(move || {
        let (published, requests, stop) = state;
        while !stop.load(Ordering::SeqCst) {
          let (mut stream, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
              std::thread::sleep(Duration::from_millis(10));
              continue;
            }
            Err(e) => panic!("fixture registry failed: {e}"),
          };
          stream.set_nonblocking(false).unwrap();
          stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
          let mut reader = std::io::BufReader::new(&stream);
          let mut line = String::new();
          loop {
            line.clear();
            if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
              break;
            }
          }
          let mut versions = serde_json::json!({
            "1.33.2": { "name": "@fabricator-cache-fixture/cli", "version": "1.33.2" }
          });
          let latest = if published.load(Ordering::SeqCst) {
            versions["1.34.0"] =
              serde_json::json!({ "name": "@fabricator-cache-fixture/cli", "version": "1.34.0" });
            "1.34.0"
          } else {
            "1.33.2"
          };
          let body = serde_json::json!({
            "name": "@fabricator-cache-fixture/cli",
            "dist-tags": { "latest": latest },
            "versions": versions,
          })
          .to_string();
          requests.fetch_add(1, Ordering::SeqCst);
          write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: public, max-age=0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body
          )
          .unwrap();
        }
      });
      Self { dir, url, published, requests, stop, server: Some(server) }
    }

    async fn npm(&self, args: &[&str], preferences: Vec<(String, String)>) -> crate::services::exec::RunResult {
      let mut env: Vec<_> = cache_env(&self.dir.join("warm cache"))
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.into_string().unwrap()))
        .collect();
      env.extend([
        ("npm_config_userconfig".into(), self.dir.join("user.npmrc").to_string_lossy().into_owned()),
        ("npm_config_globalconfig".into(), self.dir.join("global.npmrc").to_string_lossy().into_owned()),
        ("npm_config_registry".into(), self.url.clone()),
        ("npm_config_fetch_retries".into(), "0".into()),
        ("npm_config_offline".into(), "false".into()),
        ("npm_config_prefer_online".into(), "false".into()),
        ("NO_PROXY".into(), "127.0.0.1".into()),
        ("no_proxy".into(), "127.0.0.1".into()),
      ]);
      env.extend(preferences);
      crate::services::exec::run(
        "npm",
        args,
        crate::services::exec::RunOptions {
          cwd: Some(self.dir.clone()),
          env,
          timeout_ms: Some(30_000),
          ..Default::default()
        },
      )
      .await
    }

    async fn view(&self, version: &str, preferences: Vec<(String, String)>) -> crate::services::exec::RunResult {
      self.npm(
        &["view", &format!("@fabricator-cache-fixture/cli@{version}"), "version", "--json"],
        preferences,
      )
      .await
    }

    async fn resolve(&self, version: &str, preferences: Vec<(String, String)>) -> crate::services::exec::RunResult {
      // Exercise the same manifest picker as `npm create`, but forbid installs.
      self.npm(
        &[
          "exec", "--yes=false", "--package", &format!("@fabricator-cache-fixture/cli@{version}"),
          "--", "node", "--version",
        ],
        preferences,
      )
      .await
    }
  }

  impl Drop for RegistryFixture {
    fn drop(&mut self) {
      self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
      if let Some(server) = self.server.take() {
        let _ = server.join();
      }
      let _ = std::fs::remove_dir_all(&self.dir);
    }
  }

  /// Uses the installed npm against a loopback-only registry; no packages are
  /// installed and neither the user's npm config nor global cache is touched.
  #[tokio::test]
  async fn npm_resolution_refreshes_stale_metadata_without_clearing_the_cache() {
    use std::sync::atomic::Ordering;

    let fixture = RegistryFixture::new();
    let stale_env = || {
      vec![
        ("npm_config_prefer_offline".into(), "true".into()),
        ("npm_config_prefer_online".into(), "true".into()),
      ]
    };
    // Resolve without installing; --yes=false cancels after metadata selection.
    let seeded = fixture.resolve("1.33.2", stale_env()).await;
    assert!(!seeded.ok);
    assert!(seeded.stderr.contains("npx canceled"), "npm fixture seed failed: {}", seeded.stderr);
    let seed_requests = fixture.requests.load(Ordering::SeqCst);
    fixture.published.store(true, Ordering::SeqCst);

    // Reproduce #28: prefer-online alone cannot override prefer-offline.
    let stale = fixture.resolve("1.34.0", stale_env()).await;
    assert!(!stale.ok);
    assert!(stale.stderr.contains("ETARGET"), "{}", stale.stderr);
    assert_eq!(fixture.requests.load(Ordering::SeqCst), seed_requests);

    let resolved = fixture.resolve("1.34.0", fresh_registry_env()).await;
    assert!(!resolved.ok);
    assert!(resolved.stderr.contains("npx canceled"), "npm did not refresh the manifest: {}", resolved.stderr);
    assert!(resolved.stderr.contains("1.34.0"), "{}", resolved.stderr);
    assert!(fixture.requests.load(Ordering::SeqCst) > seed_requests);
    let fresh = fixture.view("1.34.0", fresh_registry_env()).await;
    assert!(fresh.ok, "{}", fresh.stderr);
    assert!(fresh.stdout.contains("1.34.0"), "{}", fresh.stdout);
    assert_eq!(
      std::fs::read_to_string(fixture.dir.join("warm cache").join(SEED_SENTINEL)).unwrap(),
      "fixture"
    );

    // A genuinely unpublished version remains an error, not a silent downgrade.
    let missing = fixture.resolve("1.35.0", fresh_registry_env()).await;
    assert!(!missing.ok);
    assert!(missing.stderr.contains("ETARGET"), "{}", missing.stderr);
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
