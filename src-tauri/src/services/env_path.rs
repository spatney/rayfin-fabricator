//! GUI `PATH` repair.
//!
//! When the app is launched from Finder/Dock (rather than a terminal), macOS
//! gives the process a minimal `PATH` — `/usr/bin:/bin:/usr/sbin:/sbin`. That
//! omits Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) and Node version
//! managers (nvm, asdf, volta, fnm), so `which node` / `which rayfin` fail even
//! though the user has them installed. Git resolves (it lives in `/usr/bin`),
//! which is exactly why the doctor reports Git as installed but Node/npm/Rayfin
//! CLI as missing only in the packaged app — never under `npm run dev`, which
//! inherits the terminal's full `PATH`.
//!
//! On macOS, [`repair`] asks the user's login shell for its real `PATH`. On
//! Windows, it reads the persistent machine/user environment and discovers
//! common installer bins without running a shell. Inherited paths keep priority.
//! Windows repair can also run again when checking for newly installed tools.
//!
//! macOS repair also makes sure the first `node` on `PATH` is one Fabricator
//! supports: a version manager's older default can come first even when a newer
//! Node.js is installed further along (see [`supported_node_first`]).

#[cfg(any(target_os = "macos", test))]
use std::ffi::{OsStr, OsString};
#[cfg(any(target_os = "macos", test))]
use std::path::{Path, PathBuf};

#[cfg(windows)]
#[path = "env_path_windows.rs"]
mod windows_path;

/// Merge the login shell's `PATH` (plus common Homebrew bins) into the process
/// environment, with a supported Node.js first.
#[cfg(target_os = "macos")]
pub fn repair() {
  if let Some(shell_path) = login_shell_path() {
    merge(&shell_path);
  }
  // Belt-and-suspenders: ensure the common Homebrew bin dirs are present even if
  // the shell probe failed (e.g. a slow or misbehaving rc file).
  for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
    if std::path::Path::new(dir).is_dir() {
      merge(dir);
    }
  }
  prefer_supported_node();
}

/// Refresh Windows CLI search paths without changing the persistent environment.
#[cfg(windows)]
pub fn repair() {
  windows_path::repair();
}

/// Other platforms keep their inherited `PATH`.
#[cfg(not(any(target_os = "macos", windows)))]
pub fn repair() {}

/// Ask the user's login+interactive shell for its `PATH`. Interactive (`-i`) so
/// rc files that configure nvm/asdf/volta run; login (`-l`) so profile files do
/// too. Bounded by a timeout so a misbehaving rc file can't hang startup.
#[cfg(target_os = "macos")]
fn login_shell_path() -> Option<String> {
  use std::process::Command;
  use std::sync::mpsc;
  use std::time::Duration;

  let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
  let (tx, rx) = mpsc::channel();
  std::thread::spawn(move || {
    let out = Command::new(&shell)
      .args(["-ilc", "command printf '%s' \"$PATH\""])
      .env("TERM", "dumb")
      .output();
    let _ = tx.send(out);
  });

  match rx.recv_timeout(Duration::from_secs(4)) {
    Ok(Ok(out)) if out.status.success() => {
      let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
      if p.is_empty() {
        None
      } else {
        Some(p)
      }
    }
    _ => None,
  }
}

/// Append any `PATH` entries from `extra` that aren't already present, preserving
/// the existing order (so the inherited entries keep priority).
#[cfg(target_os = "macos")]
fn merge(extra: &str) {
  let current = std::env::var("PATH").unwrap_or_default();
  let mut dirs: Vec<String> = current
    .split(':')
    .filter(|s| !s.is_empty())
    .map(str::to_string)
    .collect();
  for dir in extra.split(':').filter(|s| !s.is_empty()) {
    if !dirs.iter().any(|d| d == dir) {
      dirs.push(dir.to_string());
    }
  }
  std::env::set_var("PATH", dirs.join(":"));
}

/// The Node.js executable in a `PATH` folder.
#[cfg(any(target_os = "macos", test))]
const NODE: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// Put a supported Node.js first on `PATH` (see [`supported_node_first`]) and
/// note it in the activity log. Everything Fabricator starts (npm, Vite, the
/// Rayfin CLI, the agent's shell) then runs on it.
#[cfg(target_os = "macos")]
fn prefer_supported_node() {
  use crate::services::journal::{self, Area, Level};
  let Some(path) = std::env::var_os("PATH") else { return };
  let Some(switch) = supported_node_first(&path, node_version) else { return };
  std::env::set_var("PATH", &switch.path);
  let home = crate::services::paths::home_dir();
  let folder = match switch.folder.strip_prefix(&home) {
    Ok(rest) => Path::new("~").join(rest),
    Err(_) => switch.folder.clone(),
  };
  let message = format!(
    "Using Node.js {} from {}: the first Node.js on PATH ({}) is older than {}.",
    switch.version,
    folder.display(),
    switch.replaced.as_deref().unwrap_or("unknown version"),
    crate::commands::doctor::MIN_NODE_VERSION,
  );
  journal::entry(Level::Info, Area::Setup, "setup.node.preferred", &message).write();
}

/// A `PATH` with a supported Node.js moved ahead of an older one.
#[cfg(any(target_os = "macos", test))]
struct NodeSwitch {
  path: OsString,
  /// The supported Node.js's folder and version.
  folder: PathBuf,
  version: String,
  /// The version of the Node.js it now comes before, when that could be read.
  replaced: Option<String>,
}

/// Version managers such as nvm put their default Node.js first on `PATH`, and it
/// can be older than Fabricator supports (Vite then won't start the local
/// preview) while a newer Node.js is installed further along, by Homebrew or the
/// Node.js installer. Moves the first supported one's folder just ahead of the
/// first `node`, which shadows as few other tools as possible. `None` when the
/// first `node` is supported, or no later one is. `version` reads a `node`'s.
#[cfg(any(target_os = "macos", test))]
fn supported_node_first(path: &OsStr, version: impl Fn(&Path) -> Option<String>) -> Option<NodeSwitch> {
  use crate::commands::doctor::{meets_min_version, MIN_NODE_VERSION};
  let supported = |v: Option<&str>| meets_min_version(v, MIN_NODE_VERSION);
  let has_node = |dir: &Path| !dir.as_os_str().is_empty() && dir.join(NODE).is_file();
  let mut dirs: Vec<PathBuf> = std::env::split_paths(path).collect();
  let first = dirs.iter().position(|dir| has_node(dir))?;
  let replaced = version(&dirs[first].join(NODE));
  if supported(replaced.as_deref()) {
    return None;
  }
  let (index, found) = (first + 1..dirs.len())
    .filter(|&i| dirs[i] != dirs[first] && has_node(&dirs[i]))
    .find_map(|i| Some((i, version(&dirs[i].join(NODE)).filter(|v| supported(Some(v)))?)))?;
  let folder = dirs.remove(index);
  dirs.insert(first, folder.clone());
  Some(NodeSwitch { path: std::env::join_paths(&dirs).ok()?, folder, version: found, replaced })
}

/// The version `node --version` prints (without its `v`), or `None` when it
/// fails or takes over 3 seconds.
#[cfg(target_os = "macos")]
fn node_version(node: &Path) -> Option<String> {
  use std::io::Read;
  use std::process::{Command, Stdio};
  use std::time::{Duration, Instant};

  let mut child = Command::new(node)
    .arg("--version")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;
  let deadline = Instant::now() + Duration::from_secs(3);
  loop {
    match child.try_wait() {
      Ok(Some(status)) if status.success() => break,
      Ok(Some(_)) => return None,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return None;
      }
    }
  }
  let mut out = String::new();
  child.stdout.take()?.read_to_string(&mut out).ok()?;
  Some(out.trim().trim_start_matches('v').to_string()).filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
  use super::*;

  /// A `PATH` of new temp folders. A folder named `<name>-<version>` holds a
  /// `node` of that version (`broken` when its version can't be read).
  fn path_of(folders: &[&str]) -> (PathBuf, OsString) {
    let root = std::env::temp_dir().join(format!("rayfin-env-path-{}", uuid::Uuid::new_v4()));
    for folder in folders {
      std::fs::create_dir_all(root.join(folder)).unwrap();
      if folder.contains('-') {
        std::fs::write(root.join(folder).join(NODE), "").unwrap();
      }
    }
    (root.clone(), std::env::join_paths(folders.iter().map(|f| root.join(f))).unwrap())
  }

  fn version(node: &Path) -> Option<String> {
    let folder = node.parent()?.file_name()?.to_str()?;
    Some(folder.split_once('-')?.1.to_string()).filter(|v| v != "broken")
  }

  fn folders(root: &Path, path: &OsStr) -> Vec<String> {
    std::env::split_paths(path).map(|dir| dir.strip_prefix(root).unwrap().to_string_lossy().into_owned()).collect()
  }

  #[test]
  fn a_newer_node_later_on_path_moves_just_ahead_of_an_older_first_one() {
    let (root, path) = path_of(&["shims", "nvm-20.10.0", "texinfo", "brew-24.17.0", "system"]);
    let switch = supported_node_first(&path, version).expect("a supported node");
    assert_eq!(folders(&root, &switch.path), ["shims", "brew-24.17.0", "nvm-20.10.0", "texinfo", "system"]);
    assert_eq!((switch.version.as_str(), switch.replaced.as_deref()), ("24.17.0", Some("20.10.0")));
    assert_eq!(switch.folder, root.join("brew-24.17.0"));
    std::fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn skips_later_nodes_that_are_too_old_and_replaces_an_unreadable_first_one() {
    let (root, path) = path_of(&["nvm-broken", "old-22.11.0", "new-22.12.0", "newest-24.0.0"]);
    let switch = supported_node_first(&path, version).expect("a supported node");
    assert_eq!(folders(&root, &switch.path), ["new-22.12.0", "nvm-broken", "old-22.11.0", "newest-24.0.0"]);
    assert_eq!(switch.replaced, None);
    std::fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn path_is_left_alone_when_the_first_node_is_supported_or_no_node_is() {
    for case in [&["bin", "brew-24.17.0", "nvm-20.10.0"][..], &["nvm-20.10.0", "old-18.20.4"], &["bin", "sbin"]] {
      let (root, path) = path_of(case);
      assert!(supported_node_first(&path, version).is_none(), "{case:?}");
      std::fs::remove_dir_all(root).unwrap();
    }
  }
}
