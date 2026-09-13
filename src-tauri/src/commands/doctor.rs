//! Environment doctor — the Rust port of `src/main/services/doctor.ts`.
//! Detects the external prerequisites the user must provide (Node, npm, Git, and
//! the Azure CLI) and can auto-install them via winget (Windows) / brew (macOS),
//! falling back to the official installer. Fabric sign-in and deploys use each
//! project's locally-installed `@microsoft/rayfin-cli` (installed with the
//! project), so no global Rayfin CLI is required here. The Copilot CLI is
//! intentionally *not* listed either — it ships bundled with the app (embedded by
//! the SDK, self-extracted on first use), so it needs no install, only a one-time
//! sign-in (tracked separately by `auth_status`).

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::services::emit::proc_streamer;
use crate::services::exec::{self, OnData, RunOptions, Stream};
use crate::types::{DoctorReport, InstallResult, ToolStatus};

struct SystemPkg {
  winget: Option<&'static str>,
  brew: Option<&'static str>,
}

struct ToolDef {
  id: &'static str,
  name: &'static str,
  bin: &'static str,
  version_args: &'static [&'static str],
  /// Minimum acceptable version (`major.minor[.patch]`); below it the tool is
  /// reported unsatisfied so the doctor offers to upgrade. `None` = any version.
  min_version: Option<&'static str>,
  required: bool,
  system: Option<SystemPkg>,
  install_hint: &'static str,
  install_url: Option<&'static str>,
}

static TOOLS: Lazy<Vec<ToolDef>> = Lazy::new(|| {
  vec![
    ToolDef {
      id: "node",
      name: "Node.js",
      bin: "node",
      version_args: &["--version"],
      required: true,
      system: Some(SystemPkg {
        winget: Some("OpenJS.NodeJS.LTS"),
        brew: Some("node"),
      }),
      min_version: Some("20"),
      install_hint: "Install Node.js 20 or newer (includes npm).",
      install_url: Some("https://nodejs.org/en/download"),
    },
    ToolDef {
      id: "npm",
      name: "npm",
      bin: "npm",
      version_args: &["--version"],
      required: true,
      system: None,
      min_version: None,
      install_hint: "npm ships with Node.js.",
      install_url: Some("https://nodejs.org/en/download"),
    },
    ToolDef {
      id: "git",
      name: "Git",
      bin: "git",
      version_args: &["--version"],
      required: true,
      system: Some(SystemPkg {
        winget: Some("Git.Git"),
        brew: Some("git"),
      }),
      min_version: None,
      install_hint: "Install Git for version control of your apps.",
      install_url: Some("https://git-scm.com/downloads"),
    },
    ToolDef {
      id: "az",
      name: "Azure CLI",
      bin: "az",
      version_args: &["version"],
      required: true,
      system: Some(SystemPkg {
        winget: Some("Microsoft.AzureCLI"),
        brew: Some("azure-cli"),
      }),
      min_version: None,
      install_hint: "Required to sign in to Azure.",
      install_url: Some("https://learn.microsoft.com/cli/azure/install-azure-cli"),
    },
    ToolDef {
      id: "gh",
      name: "GitHub CLI (gh)",
      bin: "gh",
      version_args: &["--version"],
      required: false,
      system: Some(SystemPkg {
        winget: Some("GitHub.cli"),
        brew: Some("gh"),
      }),
      min_version: None,
      install_hint: "Optional repository browsing with gh — separate from the bundled GitHub Copilot engine.",
      install_url: Some("https://cli.github.com"),
    },
  ]
});

fn tool_by_id(id: &str) -> Option<&'static ToolDef> {
  TOOLS.iter().find(|t| t.id == id)
}

fn is_windows() -> bool {
  std::env::consts::OS == "windows"
}

fn is_macos() -> bool {
  std::env::consts::OS == "macos"
}

fn system_installable(def: &ToolDef) -> bool {
  match &def.system {
    None => false,
    Some(sys) => {
      if is_windows() {
        sys.winget.is_some()
      } else if is_macos() {
        sys.brew.is_some()
      } else {
        false
      }
    }
  }
}

fn is_auto_installable(def: &ToolDef) -> bool {
  system_installable(def)
}

static VERSION_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"\d+\.\d+\.\d+(?:[-.][\w.]+)?").unwrap());

fn parse_version(raw: Option<&str>) -> Option<String> {
  let raw = raw?;
  match VERSION_RE.find(raw) {
    Some(m) => Some(m.as_str().to_string()),
    None => None,
  }
}

/// Parse a `major.minor[.patch]` prefix into a comparable tuple (missing parts
/// default to 0). Tolerates a leading `v` and trailing pre-release/build text.
fn version_tuple(v: &str) -> Option<(u64, u64, u64)> {
  static RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?").unwrap());
  let c = RE.captures(v)?;
  let part = |i: usize| c.get(i).map_or(0, |m| m.as_str().parse().unwrap_or(0));
  Some((c.get(1)?.as_str().parse().ok()?, part(2), part(3)))
}

/// True when `version` is present and meets or exceeds `min` (both
/// `major.minor[.patch]`). An unparseable/absent version never satisfies a floor.
fn meets_min_version(version: Option<&str>, min: &str) -> bool {
  match (version.and_then(version_tuple), version_tuple(min)) {
    (Some(v), Some(m)) => v >= m,
    _ => false,
  }
}

async fn check_tool(def: &ToolDef) -> ToolStatus {
  let result = exec::run(def.bin, def.version_args, RunOptions::timeout(15_000)).await;
  let status = tool_status(def, &result);
  if let Some(error) = &status.check_error {
    log::warn!("Prerequisite check for {}: {error}", def.id);
  }
  status
}

fn tool_status(def: &ToolDef, result: &exec::RunResult) -> ToolStatus {
  let found = !result.not_found;
  let output = if result.stdout.trim().is_empty() { &result.stderr } else { &result.stdout };
  let version = if result.ok { parse_version(Some(output)) } else { None };
  let check_error = if found && (!result.ok || version.is_none()) {
    let reason = if result.ok {
      "returned no recognizable version".to_string()
    } else if let Some(detail) = result.stderr.lines().rev().map(str::trim).find(|line| !line.is_empty())
      .or_else(|| result.stdout.lines().rev().map(str::trim).find(|line| !line.is_empty()))
    {
      format!("failed: {}", detail.chars().take(500).collect::<String>())
    } else {
      match result.exit_code {
        Some(code) => format!("failed with exit code {code}"),
        None => "could not finish (it may have timed out or failed to start)".into(),
      }
    };
    Some(format!(
      "{} was found, but its version check {reason}. Re-check or run {} {} in a terminal to diagnose the existing installation.",
      def.name, def.bin, def.version_args.join(" "),
    ))
  } else {
    None
  };
  let satisfied = found && check_error.is_none()
    && def
      .min_version
      .map_or(true, |min| meets_min_version(version.as_deref(), min));
  ToolStatus {
    id: def.id.to_string(),
    name: def.name.to_string(),
    found,
    satisfied,
    version,
    check_error,
    min_version: def.min_version.map(|s| s.to_string()),
    install_hint: def.install_hint.to_string(),
    install_url: def.install_url.map(|s| s.to_string()),
    auto_installable: is_auto_installable(def),
    required: def.required,
  }
}

pub async fn check_environment() -> DoctorReport {
  #[cfg(windows)]
  crate::services::env_path::repair();
  let mut tools = Vec::with_capacity(TOOLS.len());
  for def in TOOLS.iter() {
    tools.push(check_tool(def).await);
  }
  let ready = tools.iter().filter(|t| t.required).all(|t| t.satisfied);
  DoctorReport { tools, ready }
}

#[tauri::command]
pub async fn doctor_check() -> DoctorReport {
  check_environment().await
}

#[tauri::command]
pub async fn doctor_install(app: AppHandle, id: String) -> InstallResult {
  let channel = match id.as_str() {
    "node" => "install:node",
    "npm" => "install:setup",
    "git" => "install:git",
    "az" => "install:az",
    "gh" => "install:gh",
    _ => "install:setup",
  };
  let on_data = proc_streamer(&app, channel);
  install_tool(&app, &id, Some(on_data)).await
}

#[tauri::command]
pub async fn doctor_install_all(app: AppHandle) -> InstallResult {
  let on_data = proc_streamer(&app, "install:setup");
  install_all_missing(&app, Some(on_data)).await
}

fn emit(on_data: &Option<OnData>, stream: Stream, msg: &str) {
  if let Some(cb) = on_data {
    cb(stream, msg);
  }
}

fn install_failure(on_data: &Option<OnData>, error: String) -> InstallResult {
  emit(on_data, Stream::Stderr, &format!("{error}\n"));
  log::warn!("{error}");
  InstallResult {
    ok: false, exit_code: None, error: Some(error), requires_relaunch: None, manual: None,
  }
}

async fn install_system_tool(app: &AppHandle, def: &ToolDef, on_data: Option<OnData>) -> InstallResult {
  if is_windows() {
    if let Some(winget_id) = def.system.as_ref().and_then(|s| s.winget) {
      let has_winget = exec::try_version("winget", &["--version"]).await.is_some();
      if has_winget {
        emit(
          &on_data,
          Stream::Stdout,
          &format!("Installing {} via winget (you may see a permission prompt)…\n", def.name),
        );
        let res = exec::run(
          "winget",
          &[
            "install",
            "-e",
            "--id",
            winget_id,
            "--silent",
            "--accept-source-agreements",
            "--accept-package-agreements",
          ],
          RunOptions {
            on_data: on_data.clone(),
            timeout_ms: Some(15 * 60_000),
            ..Default::default()
          },
        )
        .await;
        if res.ok {
          emit(
            &on_data,
            Stream::Stdout,
            &format!("\nInstalled {}. Restart Fabricator to finish setup.\n", def.name),
          );
          return InstallResult {
            ok: true,
            exit_code: res.exit_code,
            error: None,
            requires_relaunch: Some(true),
            manual: None,
          };
        }
        emit(
          &on_data,
          Stream::Stderr,
          &format!(
            "\nwinget could not install {} (exit {:?}). Opening the official installer…\n",
            def.name, res.exit_code
          ),
        );
      } else {
        emit(
          &on_data,
          Stream::Stderr,
          &format!("\nwinget is unavailable. Opening the official {} installer…\n", def.name),
        );
      }
    }
  } else if is_macos() {
    if let Some(brew_id) = def.system.as_ref().and_then(|s| s.brew) {
      let has_brew = exec::try_version("brew", &["--version"]).await.is_some();
      if has_brew {
        emit(&on_data, Stream::Stdout, &format!("Installing {} via Homebrew…\n", def.name));
        let res = exec::run(
          "brew",
          &["install", brew_id],
          RunOptions {
            on_data: on_data.clone(),
            timeout_ms: Some(15 * 60_000),
            ..Default::default()
          },
        )
        .await;
        if res.ok {
          emit(
            &on_data,
            Stream::Stdout,
            &format!("\nInstalled {}. Restart Fabricator to finish setup.\n", def.name),
          );
          return InstallResult {
            ok: true,
            exit_code: res.exit_code,
            error: None,
            requires_relaunch: Some(true),
            manual: None,
          };
        }
        emit(
          &on_data,
          Stream::Stderr,
          &format!(
            "\nHomebrew could not install {} (exit {:?}). Opening the official installer…\n",
            def.name, res.exit_code
          ),
        );
      } else {
        emit(
          &on_data,
          Stream::Stderr,
          &format!("\nHomebrew is unavailable. Opening the official {} installer…\n", def.name),
        );
      }
    }
  }

  if let Some(url) = def.install_url {
    if let Err(error) = app.opener().open_url(url.to_string(), None::<&str>) {
      return install_failure(&on_data, format!("Could not open the {} installer: {error}", def.name));
    }
    emit(
      &on_data,
      Stream::Stdout,
      &format!("\nOpened {url}. Install {}, then click \u{201c}Restart\u{201d}.\n", def.name),
    );
  }
  InstallResult {
    ok: false,
    exit_code: None,
    error: None,
    requires_relaunch: None,
    manual: Some(true),
  }
}

pub async fn install_tool(app: &AppHandle, id: &str, on_data: Option<OnData>) -> InstallResult {
  let Some(def) = tool_by_id(id) else {
    return install_failure(&on_data, format!("Unknown prerequisite: {id}."));
  };
  #[cfg(windows)]
  crate::services::env_path::repair();
  let status = check_tool(def).await;
  if let Some(error) = status.check_error {
    return install_failure(&on_data, error);
  }
  if status.satisfied {
    emit(&on_data, Stream::Stdout, &format!("{} is already available.\n", def.name));
    return InstallResult {
      ok: true, exit_code: Some(0), error: None, requires_relaunch: None, manual: None,
    };
  }
  if system_installable(def) {
    return install_system_tool(app, def, on_data).await;
  }
  emit(
    &on_data,
    Stream::Stderr,
    &format!("{} cannot be installed automatically on this platform.\n", def.name),
  );
  if let Some(url) = def.install_url {
    if let Err(error) = app.opener().open_url(url.to_string(), None::<&str>) {
      return install_failure(&on_data, format!("Could not open the {} installer: {error}", def.name));
    }
  } else {
    return install_failure(&on_data, format!("{}. {}", def.name, def.install_hint));
  }
  InstallResult {
    ok: false,
    exit_code: None,
    error: None,
    requires_relaunch: None,
    manual: Some(true),
  }
}

pub async fn install_all_missing(app: &AppHandle, on_data: Option<OnData>) -> InstallResult {
  let report = check_environment().await;
  if let Some(error) = required_probe_failure(&report) {
    return install_failure(&on_data, format!(
      "Resolve the existing CLI check failure before installing all prerequisites. {error}"
    ));
  }
  let missing: Vec<String> = report
    .tools
    .iter()
    .filter(|t| t.required && !t.satisfied)
    .map(|t| t.id.clone())
    .collect();
  if missing.is_empty() {
    return InstallResult {
      ok: true,
      exit_code: Some(0),
      error: None,
      requires_relaunch: None,
      manual: None,
    };
  }

  // All auto-installable prerequisites are system packages (Node first so npm
  // appears, then Git, then the Azure CLI). They land on PATH and need a relaunch
  // to be picked up.
  let system_missing: Vec<&ToolDef> = ["node", "git", "az"]
    .iter()
    .filter_map(|id| tool_by_id(id))
    .filter(|def| missing.iter().any(|m| m == def.id) && system_installable(def))
    .collect();
  if system_missing.is_empty() {
    return install_failure(&on_data, "The remaining prerequisites cannot be installed automatically. Follow their setup guidance.".into());
  }

  let mut all_ok = true;
  let mut installed_any = false;
  for def in system_missing {
    emit(&on_data, Stream::Stdout, &format!("\n\u{203a} Installing {}\n", def.name));
    installed_any = true;
    let res = install_system_tool(app, def, on_data.clone()).await;
    all_ok = all_ok && res.ok;
  }
  InstallResult {
    ok: all_ok,
    exit_code: if all_ok { Some(0) } else { None },
    error: if all_ok { None } else { Some("One or more installations did not complete. Check the process output for details.".into()) },
    requires_relaunch: if installed_any { Some(true) } else { None },
    manual: None,
  }
}

fn required_probe_failure(report: &DoctorReport) -> Option<&str> {
  report.tools.iter().filter(|tool| tool.required)
    .find_map(|tool| tool.check_error.as_deref())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn probe(ok: bool, not_found: bool, stdout: &str, stderr: &str) -> exec::RunResult {
    exec::RunResult {
      ok, not_found, exit_code: if not_found { None } else { Some(if ok { 0 } else { 7 }) },
      stdout: stdout.into(), stderr: stderr.into(),
    }
  }

  #[test]
  fn an_installed_but_failing_cli_is_not_reported_as_missing() {
    let az = tool_by_id("az").unwrap();
    let status = tool_status(az, &probe(false, false, "", "Shim could not start its Python interpreter"));
    assert!(status.found);
    assert!(!status.satisfied);
    assert!(status.version.is_none());
    assert!(status.check_error.unwrap().contains("Python interpreter"));
    let absent = tool_status(az, &probe(false, true, "", "not found on PATH"));
    assert!(!absent.found);
    assert!(!absent.satisfied);
    assert!(absent.check_error.is_none());
  }

  #[test]
  fn empty_or_unrecognized_version_output_fails_closed_without_installing() {
    for output in ["", "  ", "The shim could not load its target"] {
      let status = tool_status(tool_by_id("az").unwrap(), &probe(true, false, output, ""));
      assert!(status.found);
      assert!(!status.satisfied);
      assert!(status.check_error.is_some());
    }
  }

  #[test]
  fn valid_probes_and_version_upgrade_requirements_are_preserved() {
    let az = tool_status(tool_by_id("az").unwrap(), &probe(true, false, r#"{"azure-cli":"2.88.0"}"#, ""));
    assert!(az.found && az.satisfied);
    assert_eq!(az.version.as_deref(), Some("2.88.0"));
    assert!(az.check_error.is_none());
    let old_node = tool_status(tool_by_id("node").unwrap(), &probe(true, false, "v18.20.4", ""));
    assert!(old_node.found && !old_node.satisfied);
    assert!(old_node.check_error.is_none());
  }

  #[test]
  fn bulk_install_is_blocked_by_required_probe_errors_not_optional_ones() {
    let failed = probe(false, false, "", "Shim launch failed");
    let report = DoctorReport { ready: false, tools: vec![tool_status(tool_by_id("az").unwrap(), &failed)] };
    assert!(required_probe_failure(&report).is_some());
    let optional = DoctorReport { ready: true, tools: vec![tool_status(tool_by_id("gh").unwrap(), &failed)] };
    assert!(required_probe_failure(&optional).is_none());
  }

  #[cfg(windows)]
  #[tokio::test]
  async fn scoop_style_batch_shim_is_checked_without_shell_profiles_or_real_installs() {
    let dir = std::env::temp_dir().join(format!("fabricator-doctor-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let shim = dir.join("az.cmd");
    std::fs::write(&shim, "@echo off\r\nif \"%FABRICATOR_FAKE_FAILURE%\"==\"1\" (\r\n echo Simulated shim failure 1>&2\r\n exit /b 7\r\n)\r\necho {\"azure-cli\":\"2.88.0\"}\r\n").unwrap();
    for failing in [false, true] {
      let result = exec::run_program(shim.clone(), &["version"], RunOptions {
        env: vec![("FABRICATOR_FAKE_FAILURE".into(), if failing { "1" } else { "0" }.into())],
        timeout_ms: Some(5_000),
        ..Default::default()
      }).await;
      let status = tool_status(tool_by_id("az").unwrap(), &result);
      assert!(status.found);
      assert_eq!(status.satisfied, !failing);
      assert_eq!(status.check_error.is_some(), failing);
    }
    std::fs::remove_file(shim).unwrap();
    std::fs::remove_dir(dir).unwrap();
  }

  #[test]
  fn version_tuple_parses_partial_and_prerelease() {
    assert_eq!(version_tuple("1.23.0"), Some((1, 23, 0)));
    assert_eq!(version_tuple("1.32"), Some((1, 32, 0)));
    assert_eq!(version_tuple("v1.33.2"), Some((1, 33, 2)));
    assert_eq!(version_tuple("1.34.0-alpha.1"), Some((1, 34, 0)));
    assert_eq!(version_tuple("not-a-version"), None);
  }

  #[test]
  fn meets_min_version_enforces_floor() {
    // At or above the floor.
    assert!(meets_min_version(Some("1.32.0"), "1.32"));
    assert!(meets_min_version(Some("1.33.2"), "1.32"));
    assert!(meets_min_version(Some("2.0.0"), "1.32"));
    // Below the floor.
    assert!(!meets_min_version(Some("1.23.0"), "1.32"));
    assert!(!meets_min_version(Some("1.31.9"), "1.32"));
    // Absent/unparseable versions never satisfy a floor.
    assert!(!meets_min_version(None, "1.32"));
    assert!(!meets_min_version(Some("unknown"), "1.32"));
  }

  #[test]
  fn doctor_no_longer_requires_a_global_rayfin_cli() {
    // Fabric sign-in / deploys use each project's locally-installed CLI, so the
    // global Rayfin CLI is no longer an environment prerequisite.
    assert!(tool_by_id("rayfin").is_none());
    assert!(TOOLS.iter().all(|t| t.id != "rayfin"));
  }

  #[test]
  fn node_requires_20() {
    // The project-local Rayfin CLI / SDK packages require Node >=20; flag an older
    // Node so the doctor upgrades it (and relaunches) before anything else.
    let node = tool_by_id("node").expect("node tool def");
    assert_eq!(node.min_version, Some("20"));
    assert!(!meets_min_version(Some("18.20.4"), node.min_version.unwrap()));
    assert!(meets_min_version(Some("20.11.0"), node.min_version.unwrap()));
    assert!(meets_min_version(Some("22.14.0"), node.min_version.unwrap()));
  }

  #[test]
  fn gh_tool_is_optional_and_system_installable() {
    // The GitHub CLI powers the optional "Clone from GitHub" flow, so it must be
    // present as a non-required, auto-installable tool (winget/brew) and never
    // gate setup readiness.
    let gh = tool_by_id("gh").expect("gh tool def");
    assert_eq!(gh.bin, "gh");
    assert!(gh.name.contains("(gh)"));
    assert!(tool_by_id("copilot").is_none());
    assert!(!gh.required);
    assert!(is_auto_installable(gh));
    let sys = gh.system.as_ref().expect("gh system pkg");
    assert_eq!(sys.winget, Some("GitHub.cli"));
    assert_eq!(sys.brew, Some("gh"));
  }
}
