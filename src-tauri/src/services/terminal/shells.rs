//! The shells a project terminal can run, found on this computer, the one a new
//! terminal runs first.
//!
//! Windows: PowerShell 7 (`pwsh`), Windows PowerShell, Command Prompt and Git
//! Bash, PowerShell 7 the default when it's installed. macOS: the user's login
//! shell (`$SHELL`), then the other common shells installed. Each starts as a
//! login shell where that matters (macOS gives GUI apps a bare `PATH`; a login
//! shell reads the user's profile), and PowerShell without its banner.

use std::path::{Path, PathBuf};

use crate::types::TerminalShell;

/// A shell a terminal can run: what the picker shows, and how to start it.
#[derive(Clone, Debug, PartialEq)]
pub struct Shell {
  pub id: String,
  pub name: String,
  pub program: PathBuf,
  pub args: Vec<String>,
  /// Set for this shell only, such as Git Bash's `CHERE_INVOKING`.
  pub env: Vec<(String, String)>,
}

impl Shell {
  pub fn new(id: &str, name: &str, program: PathBuf, args: &[&str]) -> Self {
    Self {
      id: id.to_string(),
      name: name.to_string(),
      program,
      args: args.iter().map(|arg| arg.to_string()).collect(),
      env: Vec::new(),
    }
  }

  pub fn describe(&self, default: bool) -> TerminalShell {
    TerminalShell {
      id: self.id.clone(),
      name: self.name.clone(),
      path: self.program.to_string_lossy().into_owned(),
      default,
    }
  }
}

/// The shells on this computer, the default first.
pub fn available() -> Vec<Shell> {
  detect()
}

/// The shell `id` names, or the default when it's not given or no longer installed.
pub fn resolve(id: Option<&str>) -> Option<Shell> {
  let shells = available();
  id.and_then(|id| shells.iter().find(|shell| shell.id == id).cloned())
    .or_else(|| shells.into_iter().next())
}

/* -------------------------------- Windows -------------------------------- */

#[cfg(windows)]
fn detect() -> Vec<Shell> {
  let system = std::env::var_os("SystemRoot")
    .map(PathBuf::from)
    .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
    .join("System32");
  let mut shells = Vec::new();
  if let Some(pwsh) = find_pwsh() {
    shells.push(Shell::new("pwsh", "PowerShell", pwsh, &["-NoLogo"]));
  }
  let powershell = system.join("WindowsPowerShell").join("v1.0").join("powershell.exe");
  if powershell.is_file() {
    shells.push(Shell::new("powershell", "Windows PowerShell", powershell, &["-NoLogo"]));
  }
  let cmd = std::env::var_os("ComSpec")
    .map(PathBuf::from)
    .filter(|path| path.is_file())
    .unwrap_or_else(|| system.join("cmd.exe"));
  if cmd.is_file() {
    shells.push(Shell::new("cmd", &t!("services.terminal.commandPrompt"), cmd, &[]));
  }
  if let Some(bash) = find_git_bash() {
    let mut shell = Shell::new("git-bash", "Git Bash", bash, &["--login", "-i"]);
    // Git Bash's profile changes to the home folder unless this is set.
    shell.env.push(("CHERE_INVOKING".into(), "1".into()));
    shells.push(shell);
  }
  shells
}

/// PowerShell 7: on `PATH`, else where its installer puts it.
#[cfg(windows)]
fn find_pwsh() -> Option<PathBuf> {
  if let Ok(path) = which::which("pwsh") {
    return Some(path);
  }
  ["ProgramFiles", "ProgramW6432"]
    .iter()
    .filter_map(std::env::var_os)
    .map(|dir| PathBuf::from(dir).join("PowerShell").join("7").join("pwsh.exe"))
    .find(|path| path.is_file())
}

/// Git for Windows' `bin\bash.exe`, beside the `git` on `PATH` or where its
/// installer puts it. Never `System32\bash.exe`, which starts WSL.
#[cfg(windows)]
fn find_git_bash() -> Option<PathBuf> {
  let git = which::which("git").ok();
  let installs = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
    .iter()
    .filter_map(std::env::var_os)
    .map(|dir| PathBuf::from(dir).join("Git"))
    .chain(std::env::var_os("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("Programs").join("Git")));
  git_roots(git.as_deref())
    .into_iter()
    .chain(installs)
    .map(|root| root.join("bin").join("bash.exe"))
    .find(|path| path.is_file())
}

/// The folders Git for Windows may be installed in, given the `git` on `PATH`:
/// it's `<root>\cmd\git.exe`, `<root>\bin\git.exe` or `<root>\mingw64\bin\git.exe`.
#[cfg_attr(not(windows), allow(dead_code))]
fn git_roots(git: Option<&Path>) -> Vec<PathBuf> {
  git.map(|git| git.ancestors().skip(1).take(3).map(Path::to_path_buf).collect()).unwrap_or_default()
}

/* ---------------------------------- Unix --------------------------------- */

/// Shells worth offering besides the login shell, in the picker's order.
#[cfg_attr(not(unix), allow(dead_code))]
const COMMON_SHELLS: [&str; 5] = ["zsh", "bash", "fish", "nu", "pwsh"];

#[cfg(unix)]
fn detect() -> Vec<Shell> {
  let listed = std::fs::read_to_string("/etc/shells").unwrap_or_default();
  let login = std::env::var_os("SHELL").map(PathBuf::from).filter(|path| path.is_file());
  unix_shells(login, &listed, |name| which::which(name).ok(), Path::is_file)
}

/// The login shell first, then the other common shells `/etc/shells` lists or
/// `PATH` has, one of each.
#[cfg_attr(not(unix), allow(dead_code))]
fn unix_shells(
  login: Option<PathBuf>,
  etc_shells: &str,
  on_path: impl Fn(&str) -> Option<PathBuf>,
  exists: impl Fn(&Path) -> bool,
) -> Vec<Shell> {
  let mut shells: Vec<Shell> = Vec::new();
  let mut add = |program: PathBuf| {
    let Some(name) = program.file_name().and_then(|name| name.to_str()).map(str::to_string) else {
      return;
    };
    if shells.iter().any(|shell| shell.id == name) {
      return;
    }
    let args: &[&str] = match name.as_str() {
      // PowerShell takes `-Login` only as its first argument.
      "pwsh" => &["-Login", "-NoLogo"],
      "nu" => &["--login"],
      _ => &["-l"],
    };
    shells.push(Shell::new(&name, &name, program, args));
  };
  let standard = ["/bin/zsh", "/bin/bash", "/bin/sh"].into_iter().map(PathBuf::from).find(|path| exists(path));
  if let Some(login) = login.or(standard) {
    add(login);
  }
  let listed: Vec<PathBuf> = etc_shells
    .lines()
    .map(str::trim)
    .filter(|line| line.starts_with('/'))
    .map(PathBuf::from)
    .filter(|path| exists(path))
    .collect();
  for name in COMMON_SHELLS {
    let found = listed
      .iter()
      .find(|path| path.file_name().is_some_and(|file| file == name))
      .cloned()
      .or_else(|| on_path(name));
    if let Some(program) = found {
      add(program);
    }
  }
  shells
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn git_bash_is_looked_for_beside_the_git_on_path() {
    let roots = |git: &str| git_roots(Some(Path::new(git)));
    let cmd = roots("/Program Files/Git/cmd/git.exe");
    assert!(cmd.contains(&PathBuf::from("/Program Files/Git")), "{cmd:?}");
    let mingw = roots("/Program Files/Git/mingw64/bin/git.exe");
    assert!(mingw.contains(&PathBuf::from("/Program Files/Git")), "{mingw:?}");
    assert!(git_roots(None).is_empty());
  }

  #[test]
  fn the_login_shell_comes_first_then_one_of_each_common_shell() {
    let etc = "# List of acceptable shells\n/bin/bash\n/bin/csh\n/bin/zsh\n/usr/local/bin/bash\n/bin/sh\n";
    let installed = ["/bin/bash", "/bin/csh", "/bin/zsh", "/usr/local/bin/bash", "/bin/sh", "/opt/homebrew/bin/fish"];
    let exists = |path: &Path| installed.iter().any(|p| Path::new(p) == path);
    let on_path = |name: &str| (name == "fish").then(|| PathBuf::from("/opt/homebrew/bin/fish"));

    let shells = unix_shells(Some(PathBuf::from("/bin/zsh")), etc, on_path, exists);
    let ids: Vec<&str> = shells.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["zsh", "bash", "fish"]);
    assert_eq!(shells[0].program, PathBuf::from("/bin/zsh"));
    // The first bash /etc/shells lists, and only one.
    assert_eq!(shells[1].program, PathBuf::from("/bin/bash"));
    assert_eq!(shells[0].args, ["-l"]);
  }

  #[test]
  fn without_a_login_shell_the_first_standard_one_leads() {
    let exists = |path: &Path| path == Path::new("/bin/bash");
    let shells = unix_shells(None, "", |_| None, exists);
    assert_eq!(shells.len(), 1);
    assert_eq!(shells[0].id, "bash");
  }

  #[test]
  fn powershell_on_unix_logs_in_first() {
    let shells = unix_shells(Some(PathBuf::from("/usr/local/bin/pwsh")), "", |_| None, |_| true);
    assert_eq!(shells[0].args, ["-Login", "-NoLogo"]);
  }

  #[test]
  fn an_unknown_shell_falls_back_to_the_default() {
    let shells = available();
    let Some(first) = shells.first() else {
      return;
    };
    assert_eq!(resolve(Some("no-such-shell")).as_ref(), Some(first));
    assert_eq!(resolve(None).as_ref(), Some(first));
    for shell in &shells {
      assert_eq!(resolve(Some(&shell.id)).as_ref(), Some(shell));
    }
  }
}
