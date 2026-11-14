//! Loopback port checks for the live local preview: whether a port is free,
//! which process listens on it, and — only on the user's explicit request —
//! stopping that process.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::types::PortOccupant;

const PROBE_TIMEOUT: Duration = Duration::from_millis(300);
/// How many ports past the start to search for a free one.
const SEARCH_SPAN: u16 = 100;

/// Something accepts connections on `localhost:port` (IPv4 or IPv6).
pub fn is_listening(port: u16) -> bool {
  #[cfg(windows)]
  {
    if let Some(listeners) = windows_tcp::listeners(port) {
      return listeners.iter().any(|listener| listener.reachable);
    }
  }
  [SocketAddr::from((Ipv4Addr::LOCALHOST, port)), SocketAddr::from((Ipv6Addr::LOCALHOST, port))]
    .iter()
    .any(|address| TcpStream::connect_timeout(address, PROBE_TIMEOUT).is_ok())
}

/// Nothing listens on `port` and both loopbacks can bind it, which also rules
/// out OS-reserved ranges. A machine without IPv6 loopback doesn't count
/// against the port.
pub fn is_free(port: u16) -> bool {
  if port == 0 || is_listening(port) {
    return false;
  }
  let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok();
  let v6 = match TcpListener::bind((Ipv6Addr::LOCALHOST, port)) {
    Ok(_) => true,
    Err(error) => error.kind() == std::io::ErrorKind::AddrNotAvailable,
  };
  v4 && v6
}

/// The first free port at or after `start`, skipping `skip`.
pub fn next_free(start: u16, skip: &[u16]) -> Option<u16> {
  (start..=start.saturating_add(SEARCH_SPAN)).filter(|port| !skip.contains(port)).find(|port| is_free(*port))
}

/// The process listening on `localhost:port`, when the OS says.
pub fn occupant(port: u16) -> Option<PortOccupant> {
  listener_pid(port).map(describe)
}

/// Whether Fabricator may offer to stop `pid`: never a system process, this
/// app, or one of `protected` (its own dev servers).
pub fn stoppable(pid: u32, protected: &[u32]) -> bool {
  pid > 4 && pid != std::process::id() && !protected.contains(&pid)
}

/// Stop the process listening on `port`, but only while it is still `pid` (the
/// one the user was shown). Returns once the port is free.
pub fn stop(port: u16, pid: u32, protected: &[u32]) -> Result<(), String> {
  if !stoppable(pid, protected) {
    return Err(t!("services.localPorts.wontStop"));
  }
  match listener_pid(port) {
    Some(current) if current == pid => {}
    Some(_) => return Err(t!("services.localPorts.otherProcess", port = port)),
    None if !is_listening(port) => return Ok(()),
    None => return Err(t!("services.localPorts.unknownProcess", port = port)),
  }
  kill(pid)?;
  let deadline = Instant::now() + Duration::from_secs(5);
  while is_listening(port) {
    if Instant::now() >= deadline {
      return Err(t!("services.localPorts.stillInUse", port = port, pid = pid));
    }
    std::thread::sleep(Duration::from_millis(100));
  }
  Ok(())
}

fn file_name(path: &str) -> Option<String> {
  Path::new(path).file_name().map(|name| name.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn listener_pid(port: u16) -> Option<u32> {
  let listeners = windows_tcp::listeners(port)?;
  listeners.iter().find(|listener| listener.reachable).or(listeners.first()).map(|listener| listener.pid)
}

#[cfg(windows)]
fn describe(pid: u32) -> PortOccupant {
  use windows::core::PWSTR;
  use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
  use windows::Win32::Foundation::{CloseHandle, UNICODE_STRING};
  use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
  };

  let mut occupant = PortOccupant { pid, name: format!("PID {pid}"), path: None, command_line: None };
  let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
    return occupant;
  };
  let mut image = vec![0u16; 32_768];
  let mut length = image.len() as u32;
  if unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(image.as_mut_ptr()), &mut length) }.is_ok() {
    let path = String::from_utf16_lossy(&image[..length as usize]);
    if let Some(name) = file_name(&path) {
      occupant.name = name;
    }
    occupant.path = Some(path);
  }
  // Windows 8.1+: a UNICODE_STRING header followed by the text it points to.
  let mut needed = 0u32;
  let _ = unsafe { NtQueryInformationProcess(process, ProcessCommandLineInformation, std::ptr::null_mut(), 0, &mut needed) };
  if (std::mem::size_of::<UNICODE_STRING>()..=1 << 20).contains(&(needed as usize)) {
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    let status = unsafe {
      NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer.as_mut_ptr().cast(), needed, &mut needed)
    };
    if status.is_ok() {
      let header = unsafe { &*(buffer.as_ptr() as *const UNICODE_STRING) };
      let start = header.Buffer.0 as usize;
      let begin = buffer.as_ptr() as usize;
      let chars = usize::from(header.Length) / 2;
      if start >= begin && start + chars * 2 <= begin + buffer.len() * 8 && chars > 0 {
        let text = unsafe { std::slice::from_raw_parts(header.Buffer.0, chars) };
        let line = String::from_utf16_lossy(text).trim().to_string();
        occupant.command_line = Some(line).filter(|line| !line.is_empty());
      }
    }
  }
  let _ = unsafe { CloseHandle(process) };
  occupant
}

/// Only the listener itself is ended, never a "tree": Windows identifies
/// children by a recorded parent PID, which a reused PID makes unreliable, so a
/// tree kill could take down unrelated processes. The listener is all that holds
/// the port.
#[cfg(windows)]
fn kill(pid: u32) -> Result<(), String> {
  use std::os::windows::process::CommandExt;
  let out = Command::new("taskkill")
    .args(["/PID", &pid.to_string(), "/F"])
    .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
    .stdin(Stdio::null())
    .output()
    .map_err(|e| t!("services.localPorts.taskkillFailed", error = e))?;
  if out.status.success() {
    return Ok(());
  }
  let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
  Err(if detail.is_empty() {
    t!("services.localPorts.stopFailed", pid = pid)
  } else {
    t!("services.localPorts.stopFailedWhy", pid = pid, detail = detail)
  })
}

/// Listening sockets from the Windows TCP tables — instant and exact, unlike a
/// connect probe, which Windows stalls on for closed localhost ports.
#[cfg(windows)]
mod windows_tcp {
  use std::net::Ipv6Addr;

  use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
  };

  const AF_INET: u32 = 2;
  const AF_INET6: u32 = 23;
  const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

  pub struct Listener {
    pub pid: u32,
    /// Bound to loopback or every address, so `localhost:port` reaches it.
    pub reachable: bool,
  }

  /// `dwNumEntries` followed by rows; u32 storage keeps the rows aligned.
  fn table(family: u32) -> Option<Vec<u32>> {
    let mut size = 0u32;
    for _ in 0..4 {
      let mut buffer = vec![0u32; (size as usize).div_ceil(4).max(1)];
      let status = unsafe {
        GetExtendedTcpTable(Some(buffer.as_mut_ptr().cast()), &mut size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0)
      };
      if status == 0 {
        return Some(buffer);
      }
      if status != ERROR_INSUFFICIENT_BUFFER {
        return None;
      }
    }
    None
  }

  fn rows<T>(table: &[u32]) -> Vec<T> {
    let Some(&count) = table.first() else {
      return Vec::new();
    };
    let bytes = std::mem::size_of_val(table);
    let row = std::mem::size_of::<T>();
    (0..count as usize)
      .map(|i| 4 + i * row)
      .take_while(|offset| offset + row <= bytes)
      .map(|offset| unsafe { std::ptr::read_unaligned(table.as_ptr().cast::<u8>().add(offset).cast::<T>()) })
      .collect()
  }

  /// Every listener on `port`, or `None` when the tables can't be read.
  pub fn listeners(port: u16) -> Option<Vec<Listener>> {
    // `dwLocalPort` holds the port in network byte order in its low 16 bits.
    let on_port = |local: u32| u16::from_be(local as u16) == port;
    let v4 = table(AF_INET)?;
    let v6 = table(AF_INET6).unwrap_or_default();
    let mut found: Vec<Listener> = rows::<MIB_TCPROW_OWNER_PID>(&v4)
      .into_iter()
      .filter(|row| on_port(row.dwLocalPort))
      .map(|row| Listener { pid: row.dwOwningPid, reachable: row.dwLocalAddr == 0 || row.dwLocalAddr & 0xff == 127 })
      .collect();
    found.extend(rows::<MIB_TCP6ROW_OWNER_PID>(&v6).into_iter().filter(|row| on_port(row.dwLocalPort)).map(|row| {
      Listener { pid: row.dwOwningPid, reachable: row.ucLocalAddr == [0; 16] || row.ucLocalAddr == Ipv6Addr::LOCALHOST.octets() }
    }));
    Some(found)
  }
}

/// macOS GUI apps get a minimal PATH, so use the system tools directly there.
#[cfg(unix)]
fn tool(name: &'static str) -> &'static str {
  match (cfg!(target_os = "macos"), name) {
    (true, "lsof") => "/usr/sbin/lsof",
    (true, "ps") => "/bin/ps",
    (true, "kill") => "/bin/kill",
    _ => name,
  }
}

#[cfg(unix)]
fn listener_pid(port: u16) -> Option<u32> {
  let out = Command::new(tool("lsof"))
    .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fp"])
    .stdin(Stdio::null())
    .stderr(Stdio::null())
    .output()
    .ok()?;
  lsof_pids(&String::from_utf8_lossy(&out.stdout)).into_iter().next()
}

#[cfg(unix)]
fn describe(pid: u32) -> PortOccupant {
  let ps = |field: &str| {
    Command::new(tool("ps"))
      .args(["-o", &format!("{field}="), "-p", &pid.to_string()])
      .stdin(Stdio::null())
      .stderr(Stdio::null())
      .output()
      .ok()
      .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
      .filter(|value| !value.is_empty())
  };
  let path = ps("comm");
  let name = path.as_deref().and_then(file_name).unwrap_or_else(|| format!("PID {pid}"));
  PortOccupant { pid, name, path, command_line: ps("command") }
}

#[cfg(unix)]
fn kill(pid: u32) -> Result<(), String> {
  let signal = |sig: &str| {
    Command::new(tool("kill"))
      .args([sig, &pid.to_string()])
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status()
      .is_ok_and(|status| status.success())
  };
  if !signal("-TERM") {
    return Err(t!("services.localPorts.stopFailedUnix", pid = pid));
  }
  let deadline = Instant::now() + Duration::from_secs(3);
  while signal("-0") {
    if Instant::now() >= deadline {
      signal("-KILL");
      break;
    }
    std::thread::sleep(Duration::from_millis(100));
  }
  Ok(())
}

/// `p<pid>` lines from `lsof -F p` output.
#[cfg(any(unix, test))]
fn lsof_pids(text: &str) -> Vec<u32> {
  text.lines().filter_map(|line| line.strip_prefix('p')?.trim().parse().ok()).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_listening_port_is_busy_until_released() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    assert!(is_listening(port));
    assert!(!is_free(port));
    assert_ne!(next_free(port, &[]), Some(port));
    drop(listener);
    assert!(!is_listening(port));
  }

  #[test]
  fn next_free_skips_excluded_ports() {
    let first = next_free(20_000, &[]).expect("a free port");
    assert_ne!(next_free(first, &[first]), Some(first));
  }

  #[cfg(any(windows, target_os = "macos"))]
  #[test]
  fn identifies_the_listener_and_refuses_to_stop_this_app() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let found = occupant(port).expect("the listening process");
    assert_eq!(found.pid, std::process::id());
    assert!(found.path.is_some());
    assert!(found.command_line.is_some());
    assert!(stop(port, found.pid, &[]).unwrap_err().contains("won't stop"));
    assert!(is_listening(port));
  }

  #[cfg(windows)]
  #[test]
  fn stops_only_the_listener_the_user_was_shown() {
    use std::io::{BufRead, BufReader};
    let script = "$l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); \
                  [Console]::Out.WriteLine($l.LocalEndpoint.Port); [Console]::Out.Flush(); Start-Sleep -Seconds 60";
    let mut child = Command::new("powershell")
      .args(["-NoProfile", "-NonInteractive", "-Command", script])
      .stdin(Stdio::null())
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .spawn()
      .expect("powershell");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let port: u16 = line.trim().parse().expect("listener port");
    let pid = child.id();

    assert_eq!(occupant(port).map(|o| o.pid), Some(pid));
    assert!(stop(port, pid + 4, &[]).unwrap_err().contains("different process"));
    assert!(stop(port, pid, &[pid]).unwrap_err().contains("won't stop"));
    assert!(is_listening(port));
    stop(port, pid, &[]).unwrap();
    assert!(!is_listening(port));
    let _ = child.wait();
  }

  #[test]
  fn system_self_and_protected_processes_are_never_stoppable() {
    assert!(!stoppable(0, &[]));
    assert!(!stoppable(4, &[]));
    assert!(!stoppable(std::process::id(), &[]));
    assert!(!stoppable(4242, &[4242]));
    assert!(stoppable(4242, &[]));
  }

  #[test]
  fn reads_pids_from_lsof_field_output() {
    assert_eq!(lsof_pids("p1234\ncnode\np99\n"), vec![1234, 99]);
    assert!(lsof_pids("").is_empty());
  }
}
