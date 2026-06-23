//! macOS GUI `PATH` repair.
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
//! [`repair`] asks the user's login shell for its real `PATH` and merges it into
//! the process environment, so `which`/spawns resolve the same tools the
//! terminal would. It runs once at startup, before any child processes spawn.

/// Merge the login shell's `PATH` (plus common Homebrew bins) into the process
/// environment. No-op on non-macOS targets.
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
}

/// No-op on Windows/Linux — those launchers already provide the user's `PATH`.
#[cfg(not(target_os = "macos"))]
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
