//! The environment a terminal's shell starts with.
//!
//! Fabricator's own, as the processes it runs get it: `PATH` repaired at launch
//! and the Fabric account chosen in Accounts (`RAYFIN_CONFIG_DIR`), so `rayfin`
//! signs in as Fabricator does. Less what Fabricator sets only for the processes
//! it runs itself, which go back to what Fabricator was launched with: the label
//! on the Rayfin CLI's telemetry, and npm's quiet installs. Plus what a terminal
//! sets (`TERM`, `COLORTERM`), and the project's own command-line tools first on
//! `PATH`, so `rayfin` runs the version the project pins, as in an npm script.
//! On macOS, a login shell's startup files can put other folders back in front
//! (`path_helper`, Homebrew, nvm): the project's tools are still found, after them.

use std::ffi::{OsStr, OsString};
use std::path::Path;

/// What a terminal says it is.
pub const TERM_PROGRAM: &str = "Fabricator";

/// A variable's value as the user had it (`None`: unset), restored over Fabricator's.
pub type Restore = (&'static str, Option<OsString>);

/// The shell's environment: `base` (Fabricator's) with `restore` put back, the
/// terminal's variables set, and `<project>/node_modules/.bin` first on `PATH`.
pub fn build(
  base: impl IntoIterator<Item = (OsString, OsString)>,
  project_dir: &Path,
  version: &str,
  restore: &[Restore],
) -> Vec<(OsString, OsString)> {
  let mut env = Env(base.into_iter().collect());
  for (key, value) in restore {
    match value {
      Some(value) => env.set(key, value),
      None => env.remove(key),
    }
  }
  env.set("TERM", "xterm-256color");
  env.set("COLORTERM", "truecolor");
  env.set("TERM_PROGRAM", TERM_PROGRAM);
  env.set("TERM_PROGRAM_VERSION", version);
  // macOS starts GUI apps without a locale; a shell without one mangles non-ASCII text.
  if cfg!(unix) && ["LC_ALL", "LC_CTYPE", "LANG"].iter().all(|key| env.get(key).is_none_or(OsStr::is_empty)) {
    env.set("LANG", "en_US.UTF-8");
  }
  let bin = project_dir.join("node_modules").join(".bin");
  let path = match env.get("PATH") {
    Some(path) if !path.is_empty() => prepend(bin.as_os_str(), path),
    _ => Some(bin.into_os_string()),
  };
  if let Some(path) = path {
    env.set("PATH", &path);
  }
  env.0
}

/// `dir` first on a `PATH`, unless it's already first or can't be listed there.
fn prepend(dir: &OsStr, path: &OsStr) -> Option<OsString> {
  let separator = if cfg!(windows) { ";" } else { ":" };
  if dir.to_string_lossy().contains(separator) {
    return None;
  }
  let first = path.to_string_lossy().split(separator).next().map(str::to_string);
  if first.as_deref().map(OsStr::new) == Some(dir) {
    return None;
  }
  let mut joined = dir.to_os_string();
  joined.push(separator);
  joined.push(path);
  Some(joined)
}

/// Variables, matched the way the OS matches them: case-insensitively on Windows.
struct Env(Vec<(OsString, OsString)>);

impl Env {
  fn same(a: &OsStr, b: &str) -> bool {
    if cfg!(windows) {
      a.eq_ignore_ascii_case(b)
    } else {
      a == b
    }
  }

  fn get(&self, key: &str) -> Option<&OsStr> {
    self.0.iter().find(|(k, _)| Self::same(k, key)).map(|(_, v)| v.as_os_str())
  }

  /// Replace the value, keeping the name as it's spelled (Windows' `Path`).
  fn set(&mut self, key: &str, value: impl AsRef<OsStr>) {
    let value = value.as_ref().to_os_string();
    match self.0.iter_mut().find(|(k, _)| Self::same(k, key)) {
      Some(entry) => entry.1 = value,
      None => self.0.push((key.into(), value)),
    }
  }

  fn remove(&mut self, key: &str) {
    self.0.retain(|(k, _)| !Self::same(k, key));
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
  }

  fn get<'a>(env: &'a [(OsString, OsString)], key: &str) -> Option<&'a str> {
    env.iter().find(|(k, _)| Env::same(k, key)).and_then(|(_, v)| v.to_str())
  }

  fn project() -> PathBuf {
    if cfg!(windows) {
      PathBuf::from(r"C:\apps\contoso")
    } else {
      PathBuf::from("/apps/contoso")
    }
  }

  #[test]
  fn the_projects_tools_come_first_on_path() {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let original = format!("first{sep}second");
    let env = build(vars(&[("PATH", &original)]), &project(), "1.0.0", &[]);
    let bin = project().join("node_modules").join(".bin");
    assert_eq!(get(&env, "PATH"), Some(format!("{}{sep}{original}", bin.display()).as_str()));
    // Not twice, when the base already leads with them.
    let again = build(env.clone(), &project(), "1.0.0", &[]);
    assert_eq!(get(&again, "PATH"), get(&env, "PATH"));
  }

  #[test]
  fn a_terminal_says_what_it_is() {
    let env = build(vars(&[("TERM", "dumb")]), &project(), "1.52.0", &[]);
    assert_eq!(get(&env, "TERM"), Some("xterm-256color"));
    assert_eq!(get(&env, "COLORTERM"), Some("truecolor"));
    assert_eq!(get(&env, "TERM_PROGRAM"), Some("Fabricator"));
    assert_eq!(get(&env, "TERM_PROGRAM_VERSION"), Some("1.52.0"));
  }

  #[test]
  fn what_fabricator_set_for_itself_goes_back_to_the_users() {
    let base = vars(&[
      ("RAYFIN_TELEMETRY_ENV", "fabricator"),
      ("npm_config_audit", "false"),
      ("npm_config_fund", "false"),
      ("RAYFIN_CONFIG_DIR", "/accounts/work"),
    ]);
    let restore = [
      ("RAYFIN_TELEMETRY_ENV", Some(OsString::from("contoso-lab"))),
      ("npm_config_audit", None),
      ("npm_config_fund", Some(OsString::from("true"))),
    ];
    let env = build(base, &project(), "1.0.0", &restore);
    assert_eq!(get(&env, "RAYFIN_TELEMETRY_ENV"), Some("contoso-lab"));
    assert_eq!(get(&env, "npm_config_audit"), None);
    assert_eq!(get(&env, "npm_config_fund"), Some("true"));
    // The Fabric account stays: `rayfin` signs in as Fabricator does.
    assert_eq!(get(&env, "RAYFIN_CONFIG_DIR"), Some("/accounts/work"));
  }

  #[cfg(windows)]
  #[test]
  fn windows_names_match_whatever_their_case() {
    let env = build(vars(&[("Path", r"C:\Windows"), ("term", "dumb")]), &project(), "1.0.0", &[]);
    let paths: Vec<_> = env.iter().filter(|(k, _)| k.eq_ignore_ascii_case("PATH")).collect();
    assert_eq!(paths.len(), 1);
    assert_eq!(paths[0].0, "Path");
    assert!(paths[0].1.to_string_lossy().ends_with(r";C:\Windows"));
    assert_eq!(get(&env, "TERM"), Some("xterm-256color"));
  }

  #[cfg(unix)]
  #[test]
  fn a_shell_without_a_locale_gets_utf8() {
    let env = build(vars(&[("PATH", "/usr/bin")]), &project(), "1.0.0", &[]);
    assert_eq!(get(&env, "LANG"), Some("en_US.UTF-8"));
    let chosen = build(vars(&[("LC_ALL", "de_DE.UTF-8")]), &project(), "1.0.0", &[]);
    assert_eq!(get(&chosen, "LANG"), None);
  }
}
