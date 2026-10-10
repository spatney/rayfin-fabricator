//! Environment for the npm processes Fabricator spawns.
//!
//!   * [`configure_env`] makes every spawned npm install quietly (no audit or
//!     funding passes) with normal registry metadata freshness checks. It's set
//!     process-wide at startup, like [`crate::enable_rayfin_encryption_fallback`],
//!     so deploy-time installs, the scaffolder and agent-driven installs all
//!     inherit it. npm keeps using its own cache.
//!   * [`fresh_registry_env`] makes `npm create @microsoft/rayfin@latest` resolve
//!     the latest scaffolder and its CLI against fresh registry metadata:
//!     `prefer-offline` can report ETARGET for a published version even when
//!     online (issue #28).

use std::ffi::OsStr;
use std::path::Path;

use crate::services::paths;

/// Make every npm process Fabricator spawns install quietly with normal
/// freshness checks. Set process-wide (like the Rayfin encryption fallback) so it
/// propagates to every CLI/agent child, but never the user's own shell.
pub fn configure_env() {
  // Earlier releases pointed npm at a per-user cache in app data, process-wide,
  // and the in-app updater's restart inherits that environment. Startup removes
  // that folder now, so npm must stop using it.
  let retired = paths::retired_npm_cache_dir();
  if std::env::var_os("npm_config_cache").is_some_and(|cache| uses_retired_cache(&cache, &retired)) {
    std::env::remove_var("npm_config_cache");
  }
  for (key, value) in quiet_env() {
    std::env::set_var(key, value);
  }
}

/// Whether an inherited `npm_config_cache` is the retired per-user cache, rather
/// than a cache the user chose.
fn uses_retired_cache(cache: &OsStr, retired: &Path) -> bool {
  Path::new(cache) == retired
}

fn quiet_env() -> [(&'static str, &'static str); 3] {
  [
    ("npm_config_prefer_offline", "false"),
    ("npm_config_audit", "false"),
    ("npm_config_fund", "false"),
  ]
}

/// Resolve the latest scaffolder and its exact CLI dependency against fresh
/// registry metadata, keeping npm's cache. Both flags are needed: npm's
/// `prefer-offline` takes precedence over `prefer-online`. Environment overrides
/// also reach npm children spawned by the scaffolder.
pub fn fresh_registry_env() -> Vec<(String, String)> {
  [
    ("npm_config_prefer_offline", "false"),
    ("npm_config_prefer_online", "true"),
  ]
  .into_iter()
  .map(|(key, value)| (key.to_string(), value.to_string()))
  .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Marks the fixture's npm cache so a test can prove it wasn't cleared.
  const CACHE_MARKER: &str = ".fixture-marker";

  fn unique_dir(tag: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("target")
      .join(format!("npm-env-{tag}-{}", uuid::Uuid::new_v4()))
  }

  #[test]
  fn only_the_retired_per_user_cache_is_dropped_from_the_environment() {
    let retired = Path::new("Application Support").join("Rayfin Fabricator").join("npm-cache");
    assert!(uses_retired_cache(retired.as_os_str(), &retired));
    // A cache the user chose stays.
    let own = Path::new("Users").join("me").join(".npm");
    assert!(!uses_retired_cache(own.as_os_str(), &retired));
    assert!(!uses_retired_cache(OsStr::new(""), &retired));
  }

  #[test]
  fn quiet_env_keeps_npms_own_cache_and_normal_freshness() {
    let env: std::collections::HashMap<_, _> = quiet_env().into_iter().collect();
    assert_eq!(env["npm_config_prefer_offline"], "false");
    assert_eq!(env["npm_config_audit"], "false");
    assert_eq!(env["npm_config_fund"], "false");
    assert!(!env.contains_key("npm_config_cache"));
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
      std::fs::create_dir_all(dir.join("npm cache")).unwrap();
      std::fs::write(dir.join("package.json"), r#"{"name":"cache-fixture","private":true}"#).unwrap();
      std::fs::write(dir.join("user.npmrc"), "").unwrap();
      std::fs::write(dir.join("global.npmrc"), "").unwrap();
      std::fs::write(dir.join("npm cache").join(CACHE_MARKER), "fixture").unwrap();

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
      let mut env: Vec<(String, String)> = quiet_env()
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
      env.extend([
        ("npm_config_cache".into(), self.dir.join("npm cache").to_string_lossy().into_owned()),
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
      std::fs::read_to_string(fixture.dir.join("npm cache").join(CACHE_MARKER)).unwrap(),
      "fixture"
    );

    // A genuinely unpublished version remains an error, not a silent downgrade.
    let missing = fixture.resolve("1.35.0", fresh_registry_env()).await;
    assert!(!missing.ok);
    assert!(missing.stderr.contains("ETARGET"), "{}", missing.stderr);
  }
}
