//! OS process helpers for rayfin-local processes: no console window, tree
//! kills, liveness, and which executable a process runs.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Hide the console window on Windows. Elsewhere rayfin-local leads its own
/// process group, so [`kill_tree`] can end it together with its children.
pub fn configure(cmd: &mut tokio::process::Command) {
  #[cfg(windows)]
  {
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  #[cfg(unix)]
  {
    cmd.process_group(0);
  }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "macos")]
const KILL: &str = "/bin/kill";
#[cfg(all(unix, not(target_os = "macos")))]
const KILL: &str = "kill";

/// Kill `pid` and the processes it started (Vite, the function host).
pub fn kill_tree(pid: u32) {
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
      .args(["/PID", &pid.to_string(), "/T", "/F"])
      .creation_flags(CREATE_NO_WINDOW)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status();
  }
  #[cfg(unix)]
  {
    // The group first (see `configure`), then the process itself in case it isn't a group leader.
    let _ = signal("-KILL", &format!("-{pid}"));
    let _ = signal("-KILL", &pid.to_string());
  }
}

#[cfg(unix)]
fn signal(signal: &str, target: &str) -> bool {
  Command::new(KILL)
    .args([signal, "--", target])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .is_ok_and(|status| status.success())
}

/// Whether process `pid` is still running.
pub fn is_alive(pid: u32) -> bool {
  #[cfg(windows)]
  {
    use windows::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
    let Ok(process) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }) else {
      return false;
    };
    let alive = unsafe { WaitForSingleObject(process, 0) } == WAIT_TIMEOUT;
    let _ = unsafe { CloseHandle(process) };
    alive
  }
  #[cfg(unix)]
  {
    signal("-0", &pid.to_string())
  }
}

/// Wait up to `limit` for every process in `pids` to end; returns those still running.
pub fn wait_for_exit(pids: &[u32], limit: Duration) -> Vec<u32> {
  let deadline = Instant::now() + limit;
  loop {
    let alive: Vec<u32> = pids.iter().copied().filter(|pid| is_alive(*pid)).collect();
    if alive.is_empty() || Instant::now() >= deadline {
      return alive;
    }
    std::thread::sleep(Duration::from_millis(50));
  }
}

/// The executable process `pid` runs, when the OS says.
pub fn image_path(pid: u32) -> Option<PathBuf> {
  #[cfg(windows)]
  {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
      OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut image = vec![0u16; 32_768];
    let mut length = image.len() as u32;
    let found = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(image.as_mut_ptr()), &mut length) }.is_ok();
    let _ = unsafe { CloseHandle(process) };
    found.then(|| PathBuf::from(String::from_utf16_lossy(&image[..length as usize])))
  }
  #[cfg(unix)]
  {
    let ps = if cfg!(target_os = "macos") { "/bin/ps" } else { "ps" };
    let out = Command::new(ps).args(["-o", "comm=", "-p", &pid.to_string()]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
  }
}

/// Whether `path` is a rayfin-local executable (`rayfin-local[.exe]`, or the
/// sidecar's `rayfin-local-<target>[.exe]`).
pub fn is_rayfin_local(path: &Path) -> bool {
  let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(str::to_ascii_lowercase) else {
    return false;
  };
  let executable = path.extension().is_none_or(|ext| ext.eq_ignore_ascii_case("exe"));
  executable && (stem == "rayfin-local" || stem.starts_with("rayfin-local-"))
}

/// Stop a rayfin-local Fabricator didn't start: politely where the OS allows
/// (it stops gracefully on SIGTERM), then by force.
pub fn terminate(pid: u32, grace: Duration) -> Result<(), String> {
  #[cfg(unix)]
  {
    if signal("-TERM", &pid.to_string()) && wait_for_exit(&[pid], grace).is_empty() {
      return Ok(());
    }
  }
  #[cfg(windows)]
  let _ = grace;
  kill_tree(pid);
  if wait_for_exit(&[pid], Duration::from_secs(5)).is_empty() {
    Ok(())
  } else {
    Err(format!(
      "Couldn't stop rayfin-local (PID {pid}). It may run as another user or as administrator: stop it where it runs, then start this app again."
    ))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn recognizes_rayfin_local_executables() {
    let mut executables = vec!["/Applications/Fab.app/Contents/MacOS/rayfin-local", "x/RAYFIN-LOCAL-x86_64-pc-windows-msvc.EXE"];
    if cfg!(windows) {
      // Only Windows reads `\` as a separator; elsewhere this whole string is one file name.
      executables.push("C:\\Program Files\\Rayfin Fabricator\\rayfin-local.exe");
    }
    for path in executables {
      assert!(is_rayfin_local(Path::new(path)), "{path}");
    }
    for path in ["C:\\Windows\\node.exe", "rayfin-localhost.exe", "rayfin-local.js", "/usr/bin/rayfin", ""] {
      assert!(!is_rayfin_local(Path::new(path)), "{path}");
    }
  }

  #[test]
  fn sees_a_process_live_and_die() {
    assert!(is_alive(std::process::id()));
    assert!(image_path(std::process::id()).is_some());
    let mut child = if cfg!(windows) {
      Command::new("cmd").args(["/C", "exit 0"]).spawn().unwrap()
    } else {
      Command::new("sh").args(["-c", "exit 0"]).spawn().unwrap()
    };
    let pid = child.id();
    child.wait().unwrap();
    drop(child);
    assert!(wait_for_exit(&[pid], Duration::from_secs(2)).is_empty());
  }
}
