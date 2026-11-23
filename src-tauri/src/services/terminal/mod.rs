//! The project terminal: shells in pseudoterminals, started in a project's
//! folder, for the renderer's terminal panel (xterm.js).
//!
//! A terminal is a [`Session`]: a shell in a PTY (ConPTY on Windows, a Unix PTY
//! elsewhere) and four threads. One reads what the shell prints and one sends
//! it to the renderer over the terminal's channel as text, batched when it comes
//! faster than it can be sent. One writes keystrokes in the order they came, and
//! one waits for the shell to end, then says so after its last output.
//!
//! The renderer pauses the output while xterm.js is behind (a command printing
//! a flood): the reader stops reading, the PTY's buffer fills and the command
//! waits, as in any terminal. Closing a terminal ends the shell and what it
//! started; so does quitting Fabricator.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

use crate::services::local_backend::process;
use crate::types::{TerminalEvent, TerminalInfo};

pub mod env;
pub mod shells;
mod utf8;

pub use shells::Shell;

/// Bytes read from the PTY at a time.
const READ_CHUNK: usize = 64 * 1024;
/// The most one output event carries when output queues up faster than it's sent.
const MAX_BATCH: usize = 256 * 1024;
/// How long a shell that ended has to hand over the rest of its output. Its
/// background jobs may hold the PTY open for much longer.
const DRAIN_GRACE: Duration = Duration::from_secs(2);
/// How long a closed terminal's shell has to end on its hangup before it's killed.
#[cfg(unix)]
const HANGUP_GRACE: Duration = Duration::from_secs(1);

/// What a terminal starts.
pub struct Launch {
  /// Chosen by the renderer, so its keystrokes have somewhere to go before the start returns.
  pub id: String,
  pub project_id: String,
  pub cwd: PathBuf,
  pub shell: Shell,
  /// The whole environment (see [`env::build`]); the shell's own variables are added to it.
  pub env: Vec<(OsString, OsString)>,
  pub cols: u16,
  pub rows: u16,
}

/// Every open terminal, by id (Tauri managed state).
#[derive(Default, Clone)]
pub struct Terminals {
  sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}

impl Terminals {
  /// Start `launch.shell`, streaming what it prints, then how it ended, to `events`.
  pub fn spawn(&self, launch: Launch, events: Channel<TerminalEvent>) -> Result<TerminalInfo, String> {
    if self.sessions.lock().unwrap().contains_key(&launch.id) {
      return Err(t!("services.terminal.alreadyOpen"));
    }
    let size = pty_size(launch.cols, launch.rows);
    let pair = native_pty_system().openpty(size).map_err(|e| t!("services.terminal.openFailed", error = e))?;

    let mut command = CommandBuilder::new(&launch.shell.program);
    command.args(&launch.shell.args);
    command.cwd(&launch.cwd);
    // Exactly the environment given: portable-pty's own adds every variable the
    // Windows registry has, which Fabricator never copies into a process.
    command.env_clear();
    for (key, value) in &launch.env {
      command.env(key, value);
    }
    for (key, value) in &launch.shell.env {
      command.env(key, value);
    }
    let mut child = pair
      .slave
      .spawn_command(command)
      .map_err(|e| t!("services.terminal.startShellFailed", shell = launch.shell.name, error = e))?;
    // Our copy of the shell's end, so the PTY reports the shell closing it (Unix).
    drop(pair.slave);

    let pid = child.process_id();
    let ends = pair.master.try_clone_reader().and_then(|reader| Ok((reader, pair.master.take_writer()?)));
    let (reader, writer) = match ends {
      Ok(ends) => ends,
      Err(e) => {
        let _ = child.kill();
        return Err(t!("services.terminal.connectFailed", shell = launch.shell.name, error = e));
      }
    };

    let (input, keystrokes) = mpsc::channel::<Vec<u8>>();
    let session = Arc::new(Session {
      project_id: launch.project_id,
      input: Mutex::new(Some(input)),
      master: Mutex::new(Some(pair.master)),
      killer: Mutex::new(child.clone_killer()),
      pid,
      exited: AtomicBool::new(false),
      flow: Flow::default(),
      outlet: Mutex::new(Outlet { events, ended: false }),
    });
    let id = launch.id;
    // Listed before the waiter can end it, which takes it off the list.
    self.sessions.lock().unwrap().insert(id.clone(), session.clone());

    let (chunks, received) = mpsc::channel::<Vec<u8>>();
    let (drained, all_sent) = mpsc::channel::<()>();
    let reading = session.clone();
    let sending = session.clone();
    let waiting = session.clone();
    let sessions = self.sessions.clone();
    let waiting_id = id.clone();
    let threads: [(&str, Box<dyn FnOnce() + Send>); 4] = [
      ("input", Box::new(move || write_input(writer, keystrokes))),
      ("read", Box::new(move || read_output(reader, chunks, &reading.flow))),
      ("output", Box::new(move || send_output(&sending, received, drained))),
      (
        "wait",
        Box::new(move || {
          wait_for_exit(&waiting, child, all_sent);
          let mut open = sessions.lock().unwrap();
          if open.get(&waiting_id).is_some_and(|s| Arc::ptr_eq(s, &waiting)) {
            open.remove(&waiting_id);
          }
        }),
      ),
    ];
    for (name, run) in threads {
      if let Err(e) = std::thread::Builder::new().name(format!("terminal-{name}")).spawn(run) {
        session.kill();
        self.sessions.lock().unwrap().remove(&id);
        return Err(t!("services.terminal.startFailed", error = e));
      }
    }
    Ok(TerminalInfo {
      id,
      shell_id: launch.shell.id,
      shell_name: launch.shell.name,
      cwd: launch.cwd.to_string_lossy().into_owned(),
      pid,
      windows_build: windows_build(),
    })
  }

  /// Type into the terminal: keystrokes, a paste, or the terminal's replies to the shell.
  pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
    let session = self.get(id)?;
    let input = session.input.lock().unwrap();
    match input.as_ref() {
      Some(input) if input.send(data.as_bytes().to_vec()).is_ok() => Ok(()),
      _ => Err(ended()),
    }
  }

  /// The terminal's size changed: the shell hears of it and redraws.
  pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let session = self.get(id)?;
    let master = session.master.lock().unwrap();
    match master.as_ref() {
      Some(master) => master.resize(pty_size(cols, rows)).map_err(|e| t!("services.terminal.resizeFailed", error = e)),
      None => Ok(()),
    }
  }

  /// Hold the shell's output while the renderer catches up, or let it flow again.
  pub fn set_paused(&self, id: &str, paused: bool) -> Result<(), String> {
    self.get(id)?.flow.set(paused);
    Ok(())
  }

  /// End a terminal's shell and what it started. It reports its exit as usual.
  pub fn kill(&self, id: &str) {
    if let Ok(session) = self.get(id) {
      session.kill();
    }
  }

  /// End every terminal of `project_id`, or every terminal.
  pub fn kill_all(&self, project_id: Option<&str>) {
    let open: Vec<Arc<Session>> = self.sessions.lock().unwrap().values().cloned().collect();
    for session in open {
      if project_id.is_none_or(|id| id == session.project_id) {
        session.kill();
      }
    }
  }

  fn get(&self, id: &str) -> Result<Arc<Session>, String> {
    self.sessions.lock().unwrap().get(id).cloned().ok_or_else(ended)
  }
}

fn ended() -> String {
  t!("services.terminal.ended")
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
  PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

/// Windows' build number: xterm.js reflows lines itself only where ConPTY no
/// longer redraws them on a resize (build 21376 and later).
#[cfg(windows)]
fn windows_build() -> Option<u32> {
  use windows::core::w;
  use windows::Win32::Foundation::ERROR_SUCCESS;
  use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
  let mut value = [0u16; 32];
  let mut bytes = (value.len() * 2) as u32;
  let status = unsafe {
    RegGetValueW(
      HKEY_LOCAL_MACHINE,
      w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"),
      w!("CurrentBuildNumber"),
      RRF_RT_REG_SZ,
      None,
      Some(value.as_mut_ptr().cast()),
      Some(&mut bytes),
    )
  };
  if status != ERROR_SUCCESS {
    return None;
  }
  let units = (bytes as usize / 2).min(value.len());
  String::from_utf16_lossy(&value[..units]).trim_end_matches('\0').trim().parse().ok()
}

#[cfg(not(windows))]
fn windows_build() -> Option<u32> {
  None
}

struct Session {
  project_id: String,
  /// Keystrokes for the input thread, until the shell ends.
  input: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
  /// The PTY, until it's closed.
  master: Mutex<Option<Box<dyn MasterPty + Send>>>,
  killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
  pid: Option<u32>,
  exited: AtomicBool,
  flow: Flow,
  outlet: Mutex<Outlet>,
}

/// The renderer's channel. Events go out under its lock, so none follows the exit.
struct Outlet {
  events: Channel<TerminalEvent>,
  ended: bool,
}

impl Session {
  fn emit(&self, event: TerminalEvent) {
    let outlet = self.outlet.lock().unwrap();
    if !outlet.ended {
      let _ = outlet.events.send(event);
    }
  }

  fn end(&self, code: Option<u32>) {
    let mut outlet = self.outlet.lock().unwrap();
    if !outlet.ended {
      outlet.ended = true;
      let _ = outlet.events.send(TerminalEvent::Exit { code });
    }
  }

  /// Close the PTY: Windows ends what's still attached to it, Unix hangs it up.
  fn close_pty(&self) {
    // Closing a pseudoconsole can wait on its host, so not under the lock.
    let master = self.master.lock().unwrap().take();
    drop(master);
  }

  fn kill(self: &Arc<Self>) {
    self.flow.set(false);
    if self.exited.load(Ordering::Acquire) {
      return;
    }
    #[cfg(windows)]
    {
      // The whole tree, while the session's handle on the shell keeps its pid from being reused.
      if let Some(pid) = self.pid {
        process::kill_tree(pid);
      }
      let _ = self.killer.lock().unwrap().kill();
      self.close_pty();
    }
    #[cfg(unix)]
    {
      // A hangup, as when a terminal window closes: the shell passes it on to its
      // jobs, and the command in the foreground hears it directly. What ignores
      // it is killed after a moment, unless the shell has ended by then.
      let foreground = self.master.lock().unwrap().as_ref().and_then(|master| master.process_group_leader());
      let _ = self.killer.lock().unwrap().kill();
      if let Some(group) = foreground {
        process::signal("-HUP", &format!("-{group}"));
      }
      self.close_pty();
      let session = self.clone();
      std::thread::spawn(move || {
        std::thread::sleep(HANGUP_GRACE);
        if session.exited.load(Ordering::Acquire) {
          return;
        }
        if let Some(group) = foreground {
          process::signal("-KILL", &format!("-{group}"));
        }
        if let Some(pid) = session.pid {
          process::kill_tree(pid);
        }
      });
    }
  }
}

/// Output held while the renderer catches up.
#[derive(Default)]
struct Flow {
  paused: Mutex<bool>,
  changed: Condvar,
}

impl Flow {
  fn set(&self, paused: bool) {
    *self.paused.lock().unwrap() = paused;
    self.changed.notify_all();
  }

  fn wait_while_paused(&self) {
    let mut paused = self.paused.lock().unwrap();
    while *paused {
      paused = self.changed.wait(paused).unwrap();
    }
  }
}

fn write_input(mut writer: Box<dyn Write + Send>, keystrokes: mpsc::Receiver<Vec<u8>>) {
  while let Ok(bytes) = keystrokes.recv() {
    if writer.write_all(&bytes).and_then(|()| writer.flush()).is_err() {
      break;
    }
  }
}

fn read_output(mut reader: Box<dyn Read + Send>, chunks: mpsc::Sender<Vec<u8>>, flow: &Flow) {
  let mut buf = vec![0u8; READ_CHUNK];
  loop {
    flow.wait_while_paused();
    match reader.read(&mut buf) {
      Ok(0) => break,
      Ok(n) => {
        if chunks.send(buf[..n].to_vec()).is_err() {
          break;
        }
      }
      Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
      // Unix reports the shell's side of the PTY closing as an error (EIO).
      Err(_) => break,
    }
  }
}

fn send_output(session: &Session, received: mpsc::Receiver<Vec<u8>>, drained: mpsc::Sender<()>) {
  let mut text = utf8::Utf8Stream::default();
  while let Ok(mut bytes) = received.recv() {
    while bytes.len() < MAX_BATCH {
      match received.try_recv() {
        Ok(more) => bytes.extend_from_slice(&more),
        Err(_) => break,
      }
    }
    let data = text.decode(&bytes);
    if !data.is_empty() {
      session.emit(TerminalEvent::Output { data });
    }
  }
  let data = text.finish();
  if !data.is_empty() {
    session.emit(TerminalEvent::Output { data });
  }
  let _ = drained.send(());
}

fn wait_for_exit(session: &Session, mut child: Box<dyn Child + Send + Sync>, all_sent: mpsc::Receiver<()>) {
  let code = child.wait().ok().map(|status| status.exit_code());
  session.exited.store(true, Ordering::Release);
  session.input.lock().unwrap().take();
  session.flow.set(false);
  // ConPTY keeps the output open until the pseudoconsole closes.
  session.close_pty();
  let _ = all_sent.recv_timeout(DRAIN_GRACE);
  session.end(code);
}

#[cfg(test)]
mod tests;
