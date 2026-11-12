//! Real shells in real PTYs: what they print comes out, what's typed goes in,
//! and an ending is reported after the last output, with the exit code.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};

use super::*;

const PATIENCE: Duration = Duration::from_secs(30);

#[derive(Debug)]
enum Seen {
  Output(String),
  Exit(Option<u32>),
}

/// A channel like the renderer's, delivering events to the test instead.
fn channel() -> (Channel<TerminalEvent>, mpsc::Receiver<Seen>) {
  let (tx, rx) = mpsc::channel();
  let channel = Channel::new(move |body| {
    let InvokeResponseBody::Json(json) = body else {
      panic!("terminal events are JSON");
    };
    let event: serde_json::Value = serde_json::from_str(&json).unwrap();
    let seen = match event["kind"].as_str() {
      Some("output") => Seen::Output(event["data"].as_str().unwrap().to_string()),
      Some("exit") => Seen::Exit(event["code"].as_u64().map(|code| code as u32)),
      other => panic!("unexpected event kind {other:?}"),
    };
    let _ = tx.send(seen);
    Ok(())
  });
  (channel, rx)
}

/// A shell running `script` (cmd.exe's on Windows, sh's elsewhere).
fn script_shell(script: &str) -> Shell {
  if cfg!(windows) {
    let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    Shell::new("cmd", "Command Prompt", system.join("System32").join("cmd.exe"), &["/V:ON", "/D", "/C", script])
  } else {
    Shell::new("sh", "sh", PathBuf::from("/bin/sh"), &["-c", script])
  }
}

fn launch(id: &str, shell: Shell) -> Launch {
  Launch {
    id: id.to_string(),
    project_id: "project".into(),
    cwd: std::env::temp_dir(),
    shell,
    env: std::env::vars_os().collect(),
    cols: 100,
    rows: 30,
  }
}

/// Everything the terminal prints until it ends, answering ConPTY's question
/// about the cursor as xterm.js does. Calls `on_output` with the output so far.
fn run_to_end(terminals: &Terminals, id: &str, events: mpsc::Receiver<Seen>, mut on_output: impl FnMut(&str)) -> (String, Option<u32>) {
  let deadline = Instant::now() + PATIENCE;
  let mut output = String::new();
  loop {
    let left = deadline.saturating_duration_since(Instant::now());
    match events.recv_timeout(left) {
      Ok(Seen::Output(data)) => {
        if data.contains("\x1b[6n") {
          let _ = terminals.write(id, "\x1b[1;1R");
        }
        output.push_str(&data);
        on_output(&output);
      }
      Ok(Seen::Exit(code)) => {
        // Nothing may follow the exit.
        assert!(events.recv_timeout(Duration::from_millis(200)).is_err(), "an event came after the exit");
        return (output, code);
      }
      Err(_) => panic!("the terminal didn't end in time; it printed {output:?}"),
    }
  }
}

#[test]
fn what_the_shell_prints_comes_out_then_its_exit_code() {
  let terminals = Terminals::default();
  let (events, seen) = channel();
  let script = if cfg!(windows) { "echo hello-from-the-pty& exit /b 3" } else { "echo hello-from-the-pty; exit 3" };
  let info = terminals.spawn(launch("t-print", script_shell(script)), events).expect("the shell starts");
  assert_eq!(info.id, "t-print");
  assert!(info.pid.is_some());

  let (output, code) = run_to_end(&terminals, "t-print", seen, |_| {});
  assert!(output.contains("hello-from-the-pty"), "{output:?}");
  assert_eq!(code, Some(3));
  // An ended terminal leaves the list.
  let deadline = Instant::now() + Duration::from_secs(5);
  while terminals.get("t-print").is_ok() && Instant::now() < deadline {
    std::thread::sleep(Duration::from_millis(20));
  }
  assert!(terminals.write("t-print", "x").is_err());
}

#[test]
fn what_is_typed_reaches_the_shell() {
  let terminals = Terminals::default();
  let (events, seen) = channel();
  let script = if cfg!(windows) { "set /p line=& echo got:!line!" } else { "read line; echo \"got:$line\"" };
  terminals.spawn(launch("t-type", script_shell(script)), events).expect("the shell starts");
  terminals.resize("t-type", 120, 40).expect("a running terminal resizes");
  // Typed as xterm.js sends it: Enter is a carriage return.
  terminals.write("t-type", "typed-input\r").unwrap();
  let (output, code) = run_to_end(&terminals, "t-type", seen, |_| {});
  assert!(output.contains("got:typed-input"), "{output:?}");
  assert_eq!(code, Some(0));
}

#[test]
fn closing_a_terminal_ends_its_shell() {
  let terminals = Terminals::default();
  let (events, seen) = channel();
  let script = if cfg!(windows) { "echo ready& ping -n 60 127.0.0.1 >nul" } else { "echo ready; sleep 60" };
  terminals.spawn(launch("t-kill", script_shell(script)), events).expect("the shell starts");
  let mut killed = false;
  let started = Instant::now();
  let (_, code) = run_to_end(&terminals, "t-kill", seen, |output| {
    if !killed && output.contains("ready") {
      killed = true;
      terminals.kill("t-kill");
    }
  });
  assert!(killed, "the shell never said it was ready");
  assert!(started.elapsed() < Duration::from_secs(20), "the shell outlived its terminal");
  assert_ne!(code, Some(0));
}

#[test]
fn a_shell_that_cant_start_says_so() {
  let terminals = Terminals::default();
  let (events, _seen) = channel();
  let missing = Shell::new("nope", "Nope", std::env::temp_dir().join("no-such-shell-here"), &[]);
  let error = terminals.spawn(launch("t-missing", missing), events).unwrap_err();
  assert!(error.contains("Nope"), "{error}");
  assert!(terminals.get("t-missing").is_err());
}

#[test]
fn windows_reports_a_build_conpty_runs_on() {
  if cfg!(windows) {
    // ConPTY arrived in Windows 10 1809 (build 17763).
    assert!(windows_build().is_some_and(|build| build >= 17763), "{:?}", windows_build());
  } else {
    assert_eq!(windows_build(), None);
  }
}
