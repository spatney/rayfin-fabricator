//! Environment doctor — the Rust port of `src/main/services/doctor.ts`.
//! Detects the external prerequisites the user must provide (Node, npm, Git, and
//! the Rayfin CLI) and can auto-install them — the system ones via winget
//! (Windows) / brew (macOS) falling back to the official installer, and the
//! Rayfin CLI globally via npm. The Rayfin CLI is required because Fabric
//! sign-in and deploys shell out to the global `rayfin` command. The Copilot CLI
//! is intentionally *not* listed here — it ships bundled with the app (embedded
//! by the SDK, self-extracted on first use), so it needs no install, only a
//! one-time sign-in (tracked separately by `auth_status`).

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
  npm_package: Option<&'static str>,
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
      npm_package: None,
      system: Some(SystemPkg {
        winget: Some("OpenJS.NodeJS.LTS"),
        brew: Some("node"),
      }),
      min_version: None,
      install_hint: "Install Node.js 18+ (includes npm).",
      install_url: Some("https://nodejs.org/en/download"),
    },
    ToolDef {
      id: "npm",
      name: "npm",
      bin: "npm",
      version_args: &["--version"],
      required: true,
      npm_package: None,
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
      npm_package: None,
      system: Some(SystemPkg {
        winget: Some("Git.Git"),
        brew: Some("git"),
      }),
      min_version: None,
      install_hint: "Install Git for version control of your apps.",
      install_url: Some("https://git-scm.com/downloads"),
    },
    ToolDef {
      id: "rayfin",
      name: "Rayfin CLI",
      bin: "rayfin",
      version_args: &["--version"],
      required: true,
      npm_package: Some("@microsoft/rayfin-cli"),
      system: None,
      min_version: Some("1.32"),
      install_hint: "Required to sign in to Microsoft Fabric and deploy your apps.",
      install_url: Some("https://www.npmjs.com/package/@microsoft/rayfin-cli"),
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
  def.npm_package.is_some() || system_installable(def)
}

static VERSION_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"\d+\.\d+\.\d+(?:[-.][\w.]+)?").unwrap());

fn parse_version(raw: Option<&str>) -> Option<String> {
  let raw = raw?;
  match VERSION_RE.find(raw) {
    Some(m) => Some(m.as_str().to_string()),
    None => Some(raw.trim().to_string()),
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
  let raw = exec::try_version(def.bin, def.version_args).await;
  let found = raw.is_some();
  let version = parse_version(raw.as_deref());
  let satisfied = found
    && def
      .min_version
      .map_or(true, |min| meets_min_version(version.as_deref(), min));
  ToolStatus {
    id: def.id.to_string(),
    name: def.name.to_string(),
    found,
    satisfied,
    version,
    min_version: def.min_version.map(|s| s.to_string()),
    install_hint: def.install_hint.to_string(),
    install_url: def.install_url.map(|s| s.to_string()),
    auto_installable: is_auto_installable(def),
    required: def.required,
  }
}

pub async fn check_environment() -> DoctorReport {
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
    "rayfin" => "install:rayfin",
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

async fn install_npm_tool(def: &ToolDef, on_data: Option<OnData>) -> InstallResult {
  let pkg = def.npm_package.unwrap();
  emit(&on_data, Stream::Stdout, &format!("Installing {pkg} globally via npm…\n"));
  let res = exec::run(
    "npm",
    &["install", "-g", pkg],
    RunOptions {
      on_data: on_data.clone(),
      timeout_ms: Some(5 * 60_000),
      ..Default::default()
    },
  )
  .await;
  if res.not_found {
    emit(
      &on_data,
      Stream::Stderr,
      "\nnpm was not found. Install Node.js first, then restart.\n",
    );
    return InstallResult {
      ok: false,
      exit_code: res.exit_code,
      requires_relaunch: Some(true),
      manual: None,
    };
  }
  if res.ok {
    emit(&on_data, Stream::Stdout, &format!("\nInstalled {pkg}.\n"));
  } else {
    emit(
      &on_data,
      Stream::Stderr,
      &format!("\nInstall failed (exit {:?}).\n", res.exit_code),
    );
  }
  InstallResult {
    ok: res.ok,
    exit_code: res.exit_code,
    requires_relaunch: None,
    manual: None,
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
            &format!("\nInstalled {}. Restart Rayfin Fabricator to finish setup.\n", def.name),
          );
          return InstallResult {
            ok: true,
            exit_code: res.exit_code,
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
            &format!("\nInstalled {}. Restart Rayfin Fabricator to finish setup.\n", def.name),
          );
          return InstallResult {
            ok: true,
            exit_code: res.exit_code,
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
    let _ = app.opener().open_url(url.to_string(), None::<&str>);
    emit(
      &on_data,
      Stream::Stdout,
      &format!("\nOpened {url}. Install {}, then click \u{201c}Restart\u{201d}.\n", def.name),
    );
  }
  InstallResult {
    ok: false,
    exit_code: None,
    requires_relaunch: None,
    manual: Some(true),
  }
}

pub async fn install_tool(app: &AppHandle, id: &str, on_data: Option<OnData>) -> InstallResult {
  let Some(def) = tool_by_id(id) else {
    return InstallResult {
      ok: false,
      exit_code: None,
      requires_relaunch: None,
      manual: None,
    };
  };
  if def.npm_package.is_some() {
    return install_npm_tool(def, on_data).await;
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
    let _ = app.opener().open_url(url.to_string(), None::<&str>);
  }
  InstallResult {
    ok: false,
    exit_code: None,
    requires_relaunch: None,
    manual: Some(true),
  }
}

pub async fn install_all_missing(app: &AppHandle, on_data: Option<OnData>) -> InstallResult {
  let report = check_environment().await;
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
      requires_relaunch: None,
      manual: None,
    };
  }

  // Phase 1 — system prerequisites (Node first so npm appears, then Git).
  let system_missing: Vec<&ToolDef> = ["node", "git"]
    .iter()
    .filter_map(|id| tool_by_id(id))
    .filter(|def| missing.iter().any(|m| m == def.id) && system_installable(def))
    .collect();

  if !system_missing.is_empty() {
    let mut all_ok = true;
    for def in system_missing {
      emit(&on_data, Stream::Stdout, &format!("\n\u{203a} Installing {}\n", def.name));
      let res = install_system_tool(app, def, on_data.clone()).await;
      all_ok = all_ok && res.ok;
    }
    return InstallResult {
      ok: all_ok,
      exit_code: if all_ok { Some(0) } else { None },
      requires_relaunch: Some(true),
      manual: None,
    };
  }

  // Phase 2 — npm CLIs (Node present). Install the Rayfin CLI.
  let mut all_ok = true;
  let mut last_exit: Option<i32> = Some(0);
  for def in TOOLS
    .iter()
    .filter(|t| t.npm_package.is_some() && missing.iter().any(|m| m == t.id))
  {
    emit(&on_data, Stream::Stdout, &format!("\n\u{203a} Installing {}\n", def.name));
    let res = install_npm_tool(def, on_data.clone()).await;
    all_ok = all_ok && res.ok;
    if !res.ok {
      last_exit = res.exit_code;
    }
  }
  InstallResult {
    ok: all_ok,
    exit_code: last_exit,
    requires_relaunch: None,
    manual: None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

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
  fn rayfin_tool_has_minimum_and_is_npm_installable() {
    let rayfin = tool_by_id("rayfin").expect("rayfin tool def");
    assert_eq!(rayfin.min_version, Some("1.32"));
    assert_eq!(rayfin.npm_package, Some("@microsoft/rayfin-cli"));
    assert!(rayfin.required);
  }
}
