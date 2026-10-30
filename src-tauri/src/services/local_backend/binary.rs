//! Finding rayfin-local and checking that it speaks the host contract this
//! Fabricator was built for (`version --json` answers `contract: 1`).

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use super::process;
use crate::types::{LocalProblem, ToolStatus};

/// Overrides the bundled binary, to develop Fabricator and rayfin-local side by side.
pub const BIN_ENV: &str = "FABRICATOR_RAYFIN_LOCAL_BIN";
/// The host contract this Fabricator speaks.
pub const CONTRACT: u64 = 1;
/// What to do when Windows blocks the bundled binary.
pub const BLOCKED_DOCS_URL: &str =
  "https://spatney.github.io/rayfin-fabricator/docs/troubleshooting/preview#windows-blocked-rayfin-local";
const EXE_NAME: &str = if cfg!(windows) { "rayfin-local.exe" } else { "rayfin-local" };
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const REINSTALL: &str = "Reinstall Fabricator to get it back.";

/// How to run rayfin-local: its executable, or `node <script>` for a script
/// (a stand-in for tests and development).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binary {
  pub program: PathBuf,
  /// Arguments before rayfin-local's own: the script, when `program` is node.
  pub prefix: Vec<OsString>,
}

impl Binary {
  pub fn executable(path: PathBuf) -> Self {
    Self { program: path, prefix: Vec::new() }
  }

  /// `node <script>`, with the `node` on `PATH`.
  pub fn script(script: PathBuf) -> Self {
    let node = which::which("node").unwrap_or_else(|_| PathBuf::from("node"));
    Self { program: node, prefix: vec![script.into_os_string()] }
  }

  /// The file that is rayfin-local: the script, else the executable.
  pub fn file(&self) -> &Path {
    self.prefix.last().map(Path::new).unwrap_or(&self.program)
  }

  pub fn args<I: IntoIterator<Item = OsString>>(&self, args: I) -> Vec<OsString> {
    self.prefix.iter().cloned().chain(args).collect()
  }
}

/// What `rayfin-local version --json` prints.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct VersionInfo {
  pub version: String,
  pub contract: Option<u64>,
  pub sdk: SdkRange,
}

/// The `@microsoft/rayfin-*` versions a rayfin-local implements.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct SdkRange {
  pub supported: Option<String>,
  pub tested: Option<String>,
}

pub fn problem(code: &str, message: impl Into<String>, hint: Option<&str>) -> LocalProblem {
  LocalProblem {
    code: code.into(),
    message: message.into(),
    hint: hint.map(String::from),
    fatal: true,
    details: None,
    time: Some(crate::commands::util::now_iso()),
  }
}

/// rayfin-local: [`BIN_ENV`] when set, else the one next to Fabricator's
/// executable, where Tauri puts the `externalBin` sidecar (in development and
/// installed builds).
pub fn locate() -> Result<Binary, LocalProblem> {
  locate_in(std::env::var_os(BIN_ENV), std::env::current_exe().ok())
}

fn locate_in(env: Option<OsString>, exe: Option<PathBuf>) -> Result<Binary, LocalProblem> {
  if let Some(raw) = env.filter(|v| !v.is_empty()) {
    let path = PathBuf::from(raw);
    if !path.is_file() {
      return Err(problem(
        "binary-missing",
        format!("{BIN_ENV} is set to {}, which isn't a file.", path.display()),
        Some("Point it at a rayfin-local executable, or unset it to use the one that comes with Fabricator."),
      ));
    }
    let script = path.extension().and_then(OsStr::to_str).is_some_and(|e| ["js", "cjs", "mjs"].contains(&e));
    return Ok(if script { Binary::script(path) } else { Binary::executable(path) });
  }
  let path = exe.as_deref().and_then(Path::parent).map(|dir| dir.join(EXE_NAME));
  match path {
    Some(path) if path.is_file() => Ok(Binary::executable(path)),
    path => Err(problem(
      "binary-missing",
      match path {
        Some(path) => format!("The local backend (rayfin-local) that comes with Fabricator is missing from {}.", path.display()),
        None => "Fabricator couldn't find the local backend (rayfin-local) that comes with it.".into(),
      },
      Some(REINSTALL),
    )),
  }
}

/// What a finished rayfin-local command printed.
pub struct CliOutput {
  pub code: Option<i32>,
  pub stdout: String,
  pub stderr: String,
}

/// Run rayfin-local to the end, without a console window. `input` is written
/// to its stdin, which is then closed, so a value never shows in the
/// arguments other processes can read. Killed after `timeout`.
pub async fn run_cli(binary: &Binary, args: Vec<OsString>, input: Option<&str>, timeout: Duration) -> io::Result<CliOutput> {
  let mut cmd = tokio::process::Command::new(&binary.program);
  cmd
    .args(binary.args(args))
    .env("NO_COLOR", "1")
    .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
  process::configure(&mut cmd);
  let mut child = cmd.spawn()?;
  if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
    let text = text.to_string();
    tokio::spawn(async move {
      let _ = stdin.write_all(text.as_bytes()).await;
      let _ = stdin.shutdown().await;
    });
  }
  match tokio::time::timeout(timeout, child.wait_with_output()).await {
    Ok(output) => {
      let output = output?;
      Ok(CliOutput {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
      })
    }
    Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "rayfin-local didn't finish in time")),
  }
}

/// Run `version --json` and check the contract.
pub async fn probe(binary: &Binary) -> Result<VersionInfo, LocalProblem> {
  let args = |list: &[&str]| list.iter().map(OsString::from).collect::<Vec<_>>();
  let output = run_cli(binary, args(&["version", "--json"]), None, PROBE_TIMEOUT)
    .await
    .map_err(|e| spawn_problem(binary.file(), &e))?;
  if let Some(info) = version_json(&output) {
    return judge(info);
  }
  // Releases before the contract don't know `version`; `--version` names them.
  let text = run_cli(binary, args(&["--version"]), None, PROBE_TIMEOUT).await.ok().filter(|o| o.code == Some(0));
  Err(too_old(text.as_ref().map(|o| o.stdout.trim()), &output))
}

fn version_json(output: &CliOutput) -> Option<VersionInfo> {
  if output.code != Some(0) {
    return None;
  }
  let info: VersionInfo = serde_json::from_str(output.stdout.trim()).ok()?;
  (!info.version.is_empty() || info.contract.is_some()).then_some(info)
}

fn judge(info: VersionInfo) -> Result<VersionInfo, LocalProblem> {
  match info.contract {
    Some(CONTRACT) => Ok(info),
    Some(contract) if contract > CONTRACT => Err(LocalProblem {
      details: Some(serde_json::json!({ "version": info.version, "contract": contract })),
      ..problem(
        "binary-incompatible",
        format!(
          "rayfin-local {} speaks host contract {contract}, but this Fabricator speaks contract {CONTRACT}.",
          info.version
        ),
        Some("Update Fabricator, or use the rayfin-local that comes with it."),
      )
    }),
    _ => Err(too_old(Some(&info.version), &CliOutput { code: Some(0), stdout: String::new(), stderr: String::new() })),
  }
}

fn too_old(version_text: Option<&str>, output: &CliOutput) -> LocalProblem {
  let version = version_text
    .map(|t| t.trim().trim_start_matches("rayfin-local").trim().to_string())
    .filter(|v| !v.is_empty());
  let named = version.as_deref().map(|v| format!(" ({v})")).unwrap_or_default();
  let detail = output.stderr.lines().map(str::trim).find(|l| !l.is_empty()).map(String::from);
  LocalProblem {
    details: Some(serde_json::json!({ "version": version, "output": detail })),
    ..problem(
      "binary-too-old",
      format!(
        "The bundled local backend is too old{named}. Fabricator needs a rayfin-local that speaks host contract {CONTRACT}."
      ),
      Some("Update Fabricator. If you build Fabricator yourself, fetch the pinned rayfin-local again or set FABRICATOR_RAYFIN_LOCAL_BIN to a newer one."),
    )
  }
}

/// The problem with a rayfin-local that couldn't be started.
pub fn spawn_problem(file: &Path, error: &io::Error) -> LocalProblem {
  if error.kind() == io::ErrorKind::NotFound {
    return problem("binary-missing", format!("The local backend isn't at {}.", file.display()), Some(REINSTALL));
  }
  if error.kind() == io::ErrorKind::TimedOut {
    return problem(
      "binary-failed",
      "The local backend (rayfin-local) didn't answer within 20 seconds.",
      Some("An antivirus scan can hold it up the first time it runs. Try again in a minute."),
    );
  }
  if blocked(error) {
    let os = if cfg!(windows) { "Windows" } else if cfg!(target_os = "macos") { "macOS" } else { "The system" };
    return LocalProblem {
      details: Some(serde_json::json!({ "path": file.display().to_string(), "docs": BLOCKED_DOCS_URL })),
      ..problem(
        "binary-blocked",
        format!("{os} blocked the local backend (rayfin-local): {error}"),
        Some(&format!(
          "Your antivirus or your organization's app control policy may not allow it. See {BLOCKED_DOCS_URL}"
        )),
      )
    };
  }
  problem("spawn-failed", format!("The local backend (rayfin-local) couldn't start: {error}"), None)
}

/// Access denied, or refused by policy or antivirus.
fn blocked(error: &io::Error) -> bool {
  // 5 access denied, 225 virus detected, 1260 blocked by group policy, 4551 blocked by App Control.
  error.kind() == io::ErrorKind::PermissionDenied || matches!(error.raw_os_error(), Some(5 | 225 | 1260 | 4551))
}

/// The **Local backend** entry of the environment doctor: found, runs, speaks
/// the contract. Optional: projects open without it.
pub async fn doctor_status() -> ToolStatus {
  let result = match locate() {
    Ok(binary) => probe(&binary).await,
    Err(problem) => Err(problem),
  };
  tool_status(result)
}

pub fn tool_status(result: Result<VersionInfo, LocalProblem>) -> ToolStatus {
  let mut status = ToolStatus {
    id: "rayfin-local".into(),
    name: "Local backend".into(),
    found: true,
    satisfied: false,
    version: None,
    check_error: None,
    min_version: None,
    install_hint: "Runs your apps and their data on this computer. It comes with Fabricator.".into(),
    install_url: None,
    auto_installable: false,
    required: false,
  };
  match result {
    Ok(info) => {
      status.satisfied = true;
      status.version = Some(info.version);
    }
    Err(problem) => {
      status.found = problem.code != "binary-missing";
      status.version = problem.details.as_ref().and_then(|d| d["version"].as_str()).map(String::from);
      status.install_url = Some(BLOCKED_DOCS_URL.into());
      let text = match &problem.hint {
        Some(hint) => format!("{} {hint}", problem.message),
        None => problem.message,
      };
      if status.found {
        status.check_error = Some(text);
      } else {
        status.install_hint = text;
      }
    }
  }
  status
}

#[cfg(test)]
mod tests {
  use super::*;

  fn output(code: i32, stdout: &str, stderr: &str) -> CliOutput {
    CliOutput { code: Some(code), stdout: stdout.into(), stderr: stderr.into() }
  }

  #[test]
  fn the_override_wins_and_the_sidecar_sits_next_to_the_app() {
    let dir = std::env::temp_dir().join(format!("fab-rl-bin-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let exe = dir.join(if cfg!(windows) { "Fabricator.exe" } else { "Fabricator" });

    let missing = locate_in(None, Some(exe.clone())).unwrap_err();
    assert_eq!(missing.code, "binary-missing");
    assert!(missing.message.contains(EXE_NAME));

    let sidecar = dir.join(EXE_NAME);
    std::fs::write(&sidecar, "").unwrap();
    assert_eq!(locate_in(None, Some(exe.clone())).unwrap(), Binary::executable(sidecar.clone()));
    assert_eq!(locate_in(Some(OsString::new()), Some(exe.clone())).unwrap(), Binary::executable(sidecar));

    let custom = dir.join("custom-rayfin-local.exe");
    let wrong = locate_in(Some(custom.clone().into_os_string()), Some(exe.clone())).unwrap_err();
    assert_eq!(wrong.code, "binary-missing");
    assert!(wrong.message.contains(BIN_ENV));
    std::fs::write(&custom, "").unwrap();
    assert_eq!(locate_in(Some(custom.clone().into_os_string()), Some(exe.clone())).unwrap(), Binary::executable(custom));

    let script = dir.join("fake.cjs");
    std::fs::write(&script, "").unwrap();
    let binary = locate_in(Some(script.clone().into_os_string()), Some(exe)).unwrap();
    assert_eq!(binary.file(), script.as_path());
    assert_eq!(binary.args([OsString::from("serve")]), [script.into_os_string(), OsString::from("serve")]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn only_contract_1_is_compatible() {
    let ok = version_json(&output(0, r#"{"version":"0.2.0","contract":1,"sdk":{"supported":">=1.36.0 <1.37.0","tested":"1.36.2"}}"#, "")).unwrap();
    let info = judge(ok).unwrap();
    assert_eq!(info.version, "0.2.0");
    assert_eq!(info.sdk.tested.as_deref(), Some("1.36.2"));

    let newer = judge(version_json(&output(0, r#"{"version":"1.0.0","contract":2}"#, "")).unwrap()).unwrap_err();
    assert_eq!(newer.code, "binary-incompatible");
    let unversioned = judge(version_json(&output(0, r#"{"version":"0.1.5"}"#, "")).unwrap()).unwrap_err();
    assert_eq!(unversioned.code, "binary-too-old");
  }

  #[test]
  fn a_release_without_the_contract_is_too_old_not_a_crash() {
    // 0.1.0 has no `version` command: clap rejects it.
    let rejected = output(2, "", "error: unrecognized subcommand 'version'\n\nUsage: rayfin-local [OPTIONS] <COMMAND>\n");
    assert!(version_json(&rejected).is_none());
    let problem = too_old(Some("rayfin-local 0.1.0\n"), &rejected);
    assert_eq!(problem.code, "binary-too-old");
    assert!(problem.message.starts_with("The bundled local backend is too old (0.1.0)."), "{}", problem.message);
    assert_eq!(problem.details.as_ref().unwrap()["output"], "error: unrecognized subcommand 'version'");
    assert!(version_json(&output(0, "rayfin-local 0.1.0", "")).is_none());
  }

  #[test]
  fn access_denied_means_blocked() {
    let denied = io::Error::from_raw_os_error(if cfg!(windows) { 5 } else { 13 });
    let problem = spawn_problem(Path::new("rayfin-local.exe"), &denied);
    assert_eq!(problem.code, "binary-blocked");
    assert!(problem.hint.unwrap().contains(BLOCKED_DOCS_URL));
    assert_eq!(spawn_problem(Path::new("x"), &io::Error::from(io::ErrorKind::NotFound)).code, "binary-missing");
    assert_eq!(spawn_problem(Path::new("x"), &io::Error::other("bad image")).code, "spawn-failed");
  }

  #[test]
  fn the_doctor_lists_an_optional_local_backend() {
    let ok = tool_status(Ok(VersionInfo { version: "0.2.0".into(), contract: Some(1), sdk: SdkRange::default() }));
    assert!(ok.found && ok.satisfied && !ok.required && !ok.auto_installable);
    assert_eq!((ok.id.as_str(), ok.name.as_str(), ok.version.as_deref()), ("rayfin-local", "Local backend", Some("0.2.0")));

    let blocked = tool_status(Err(spawn_problem(Path::new("rayfin-local.exe"), &io::Error::from(io::ErrorKind::PermissionDenied))));
    assert!(blocked.found && !blocked.satisfied);
    assert!(blocked.check_error.unwrap().contains(BLOCKED_DOCS_URL));
    assert_eq!(blocked.install_url.as_deref(), Some(BLOCKED_DOCS_URL));

    let old = tool_status(Err(too_old(Some("rayfin-local 0.1.0"), &output(2, "", ""))));
    assert_eq!(old.version.as_deref(), Some("0.1.0"));
    assert!(old.check_error.unwrap().contains("too old"));

    let missing = tool_status(Err(problem("binary-missing", "Missing.", Some(REINSTALL))));
    assert!(!missing.found && missing.check_error.is_none());
    assert!(missing.install_hint.contains(REINSTALL));
  }

  #[tokio::test]
  async fn probes_a_stand_in_over_its_cli() {
    let Ok(node) = which::which("node") else { return };
    let dir = std::env::temp_dir().join(format!("fab-rl-probe-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake.cjs");
    std::fs::write(&script, super::super::tests::FAKE_RAYFIN_LOCAL).unwrap();
    let binary = Binary { program: node, prefix: vec![script.into_os_string()] };
    let info = probe(&binary).await.unwrap();
    assert_eq!((info.version.as_str(), info.contract), ("9.9.9-fake", Some(1)));
    let _ = std::fs::remove_dir_all(&dir);
  }
}
