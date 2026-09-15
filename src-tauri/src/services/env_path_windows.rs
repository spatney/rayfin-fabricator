//! Read-only, shell-free repair for GUI processes with an outdated Windows environment.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
  ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR,
};
use windows::Win32::System::Registry::{
  RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ,
  RRF_RT_REG_SZ,
};

const MAX_REGISTRY_BYTES: u32 = 65_536;
const MAX_READ_ATTEMPTS: usize = 3;
const MAX_ENV_UNITS: usize = 32_766;
const MAX_EXPANSION_DEPTH: usize = 16;
const MAX_SUBSTITUTIONS: usize = 128;
const MAX_REGISTRY_LOOKUPS: usize = 256;
const AZURE_LOCATION_VARIABLES: [&str; 2] = ["AZURE_CLI_PATH", "AzureCLIPath"];
static REPAIR_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn repair() {
  let _guard = REPAIR_LOCK
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  let mut environment = Environment::new(std::env::vars_os(), registry_value);
  let refreshed = refresh(&mut environment, Path::is_dir);

  // These installer locations can be required by shims. Never copy arbitrary
  // registry values (in particular credentials) into the process environment.
  for (name, value) in refreshed.variables {
    if std::env::var_os(name).is_none() {
      std::env::set_var(name, value);
    }
  }
  if std::env::var_os("PATH").as_ref() != Some(&refreshed.path) {
    std::env::set_var("PATH", refreshed.path);
    log::info!("Refreshed Windows CLI search paths from the persistent environment");
  }
  if refreshed.truncated {
    log::warn!("Windows PATH refresh omitted entries exceeding the environment size limit");
  }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Scope {
  Machine,
  User,
}

#[derive(Debug, Eq, PartialEq)]
enum ReadError {
  Windows(u32),
  TooLarge,
  InvalidString,
  ChangedRepeatedly,
}

fn registry_value(scope: Scope, name: &str) -> Option<String> {
  let (key, subkey) = match scope {
    Scope::Machine => (
      HKEY_LOCAL_MACHINE,
      w!("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    ),
    Scope::User => (HKEY_CURRENT_USER, w!("Environment")),
  };
  let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
  let result = read_string(|buffer, bytes| unsafe {
    RegGetValueW(
      key,
      subkey,
      PCWSTR(name.as_ptr()),
      RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND,
      None,
      buffer.map(|buffer| buffer.as_mut_ptr().cast()),
      Some(bytes),
    )
  });
  match result {
    Ok(value) => value,
    Err(error) => {
      log::warn!("Windows PATH refresh could not read {scope:?} environment: {error:?}");
      None
    }
  }
}

fn read_string(
  mut query: impl FnMut(Option<&mut [u16]>, &mut u32) -> WIN32_ERROR,
) -> Result<Option<String>, ReadError> {
  let mut bytes = 0;
  let status = query(None, &mut bytes);
  if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND {
    return Ok(None);
  }
  if status != ERROR_SUCCESS && status != ERROR_MORE_DATA {
    return Err(ReadError::Windows(status.0));
  }

  for _ in 0..MAX_READ_ATTEMPTS {
    if bytes > MAX_REGISTRY_BYTES {
      return Err(ReadError::TooLarge);
    }
    if bytes % 2 != 0 {
      return Err(ReadError::InvalidString);
    }
    // RegGetValueW may need room to terminate a registry string whose stored
    // bytes omit the NUL. Its size can also change between these two calls.
    let units = (bytes as usize / 2 + 1).min(MAX_REGISTRY_BYTES as usize / 2);
    let mut buffer = vec![0u16; units];
    bytes = (buffer.len() * 2) as u32;
    let status = query(Some(&mut buffer), &mut bytes);
    if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND {
      return Ok(None);
    }
    if status == ERROR_MORE_DATA {
      continue;
    }
    if status != ERROR_SUCCESS {
      return Err(ReadError::Windows(status.0));
    }
    if bytes % 2 != 0 || bytes == 0 || bytes as usize / 2 > buffer.len() {
      return Err(ReadError::InvalidString);
    }
    let data = &buffer[..bytes as usize / 2];
    let end = data
      .iter()
      .position(|&unit| unit == 0)
      .ok_or(ReadError::InvalidString)?;
    if data[end..].iter().any(|&unit| unit != 0) {
      return Err(ReadError::InvalidString);
    }
    return String::from_utf16(&data[..end])
      .map(Some)
      .map_err(|_| ReadError::InvalidString);
  }
  Err(ReadError::ChangedRepeatedly)
}

struct Environment<R> {
  process: HashMap<String, OsString>,
  persistent: HashMap<(Scope, String), Option<String>>,
  read: R,
}

impl<R: FnMut(Scope, &str) -> Option<String>> Environment<R> {
  fn new(process: impl IntoIterator<Item = (OsString, OsString)>, read: R) -> Self {
    Self {
      process: process
        .into_iter()
        .filter_map(|(name, value)| {
          name
            .into_string()
            .ok()
            .map(|name| (name.to_uppercase(), value))
        })
        .collect(),
      persistent: HashMap::new(),
      read,
    }
  }

  fn persistent_value(&mut self, scope: Scope, name: &str) -> Option<String> {
    let key = (scope, name.to_uppercase());
    if let Some(value) = self.persistent.get(&key) {
      return value.clone();
    }
    if self.persistent.len() >= MAX_REGISTRY_LOOKUPS {
      return None;
    }
    let value = (self.read)(scope, &key.1);
    self.persistent.insert(key, value.clone());
    value
  }

  fn variable(&mut self, name: &str) -> Option<String> {
    let name = name.to_uppercase();
    if let Some(value) = self.process.get(&name) {
      return value.to_str().map(str::to_owned);
    }
    self
      .persistent_value(Scope::User, &name)
      .or_else(|| self.persistent_value(Scope::Machine, &name))
  }

  fn expanded_variable(&mut self, name: &str) -> Option<String> {
    let value = self.variable(name)?;
    self.expand(&value)
  }

  fn expand(&mut self, value: &str) -> Option<String> {
    let mut remaining = MAX_SUBSTITUTIONS;
    self.expand_inner(value, &mut Vec::new(), &mut remaining)
  }

  fn expand_inner(
    &mut self,
    value: &str,
    visiting: &mut Vec<String>,
    remaining: &mut usize,
  ) -> Option<String> {
    if visiting.len() > MAX_EXPANSION_DEPTH
      || value.len() > MAX_ENV_UNITS * 4
      || value.contains('\0')
    {
      return None;
    }
    let mut output = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('%') {
      let tail = &rest[start + 1..];
      let Some(end) = tail.find('%') else { break };
      let name = tail[..end].to_uppercase();
      if name.is_empty() || visiting.contains(&name) || *remaining == 0 {
        return None;
      }
      *remaining -= 1;
      let replacement = self.variable(&name)?;
      if replacement.is_empty() {
        return None;
      }
      visiting.push(name);
      let expanded = self.expand_inner(&replacement, visiting, remaining);
      visiting.pop();
      output.push_str(&rest[..start]);
      output.push_str(&expanded?);
      if output.len() > MAX_ENV_UNITS * 4 {
        return None;
      }
      rest = &tail[end + 1..];
    }
    output.push_str(rest);
    if output.encode_utf16().count() > MAX_ENV_UNITS {
      return None;
    }
    Some(output)
  }
}

#[derive(Default)]
struct SearchPath {
  paths: Vec<PathBuf>,
  seen: HashSet<OsString>,
  units: usize,
  truncated: bool,
}

impl SearchPath {
  fn push(&mut self, path: PathBuf) {
    if path.as_os_str().is_empty() {
      return;
    }
    let normalized: PathBuf = path.components().collect();
    let key = match normalized.into_os_string().into_string() {
      Ok(path) => OsString::from(path.to_lowercase()),
      Err(path) => path,
    };
    if self.seen.contains(&key) {
      return;
    }
    let Ok(encoded) = std::env::join_paths([&path]) else {
      return;
    };
    let units = self.units + usize::from(!self.paths.is_empty()) + encoded.encode_wide().count();
    if units > MAX_ENV_UNITS {
      self.truncated = true;
      return;
    }
    self.units = units;
    self.seen.insert(key);
    self.paths.push(path);
  }

  fn append<R: FnMut(Scope, &str) -> Option<String>>(
    &mut self,
    value: &OsStr,
    environment: &mut Environment<R>,
  ) {
    let Some(value) = value.to_str() else {
      // Preserve inherited Windows paths containing unpaired surrogates.
      for path in std::env::split_paths(value) {
        self.push(path);
      }
      return;
    };
    let mut quoted = false;
    for entry in value.split(|ch| {
      if ch == '"' {
        quoted = !quoted;
      }
      ch == ';' && !quoted
    }) {
      // Expand entries separately so an unresolved/cyclic variable cannot hide
      // unrelated tools. Keep quotes until split_paths handles literal ';'.
      if let Some(expanded) = environment.expand(entry) {
        for path in std::env::split_paths(&expanded) {
          self.push(path);
        }
      }
    }
  }
}

struct Refresh {
  path: OsString,
  variables: Vec<(&'static str, String)>,
  truncated: bool,
}

fn refresh<R: FnMut(Scope, &str) -> Option<String>>(
  environment: &mut Environment<R>,
  mut is_dir: impl FnMut(&Path) -> bool,
) -> Refresh {
  let persistent =
    [Scope::Machine, Scope::User].map(|scope| environment.persistent_value(scope, "PATH"));
  let mut path = SearchPath::default();
  if let Some(inherited) = environment.process.get("PATH").cloned() {
    path.append(&inherited, environment);
  }
  for value in persistent.into_iter().flatten() {
    path.append(OsStr::new(&value), environment);
  }

  for (name, suffix) in [
    ("SCOOP", "shims"),
    ("SCOOP_GLOBAL", "shims"),
    ("USERPROFILE", "scoop\\shims"),
    ("PROGRAMDATA", "scoop\\shims"),
    ("PNPM_HOME", ""),
    ("PNPM_HOME", "bin"),
    ("LOCALAPPDATA", "pnpm"),
    ("LOCALAPPDATA", "pnpm\\bin"),
    ("AZURE_CLI_PATH", ""),
    ("AZURE_CLI_PATH", "wbin"),
    ("AZURE_CLI_PATH", "bin"),
    ("AzureCLIPath", ""),
    ("AzureCLIPath", "wbin"),
    ("AzureCLIPath", "bin"),
    ("ProgramFiles", "Microsoft SDKs\\Azure\\CLI2\\wbin"),
    ("ProgramFiles(x86)", "Microsoft SDKs\\Azure\\CLI2\\wbin"),
  ] {
    if let Some(root) = environment.expanded_variable(name) {
      let root = Path::new(root.trim_matches('"'));
      if root.is_absolute() {
        let candidate = if suffix.is_empty() {
          root.to_owned()
        } else {
          root.join(suffix)
        };
        if is_dir(&candidate) {
          path.push(candidate);
        }
      }
    }
  }

  let mut variables = Vec::new();
  for name in AZURE_LOCATION_VARIABLES {
    if !environment.process.contains_key(&name.to_uppercase()) {
      if let Some(value) = environment.expanded_variable(name) {
        if Path::new(value.trim_matches('"')).is_absolute() {
          variables.push((name, value));
        }
      }
    }
  }
  Refresh {
    // Each entry has already passed join_paths and the Windows length bound.
    path: std::env::join_paths(path.paths).expect("validated Windows search paths"),
    variables,
    truncated: path.truncated,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use std::os::windows::ffi::OsStringExt;

  fn environment(
    process: &[(&str, &str)],
    machine: &[(&str, &str)],
    user: &[(&str, &str)],
  ) -> Environment<impl FnMut(Scope, &str) -> Option<String>> {
    let persistent: HashMap<_, _> = [(Scope::Machine, machine), (Scope::User, user)]
      .into_iter()
      .flat_map(|(scope, entries)| {
        entries
          .iter()
          .map(move |(name, value)| ((scope, name.to_uppercase()), value.to_string()))
      })
      .collect();
    Environment::new(
      process
        .iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value))),
      move |scope, name| persistent.get(&(scope, name.to_string())).cloned(),
    )
  }

  fn entries(refresh: &Refresh) -> Vec<PathBuf> {
    std::env::split_paths(&refresh.path).collect()
  }

  fn paths(values: &[&str]) -> Vec<PathBuf> {
    values.iter().map(PathBuf::from).collect()
  }

  struct Fixture(PathBuf);

  impl Fixture {
    fn new() -> Self {
      let root = PathBuf::from("target").join(format!("env-path-fixture-{}", uuid::Uuid::new_v4()));
      fs::create_dir_all(&root).unwrap();
      Self(root)
    }

    fn directory(&self, path: &str) -> PathBuf {
      let path = self.0.join(path);
      fs::create_dir_all(&path).unwrap();
      std::env::current_dir().unwrap().join(path)
    }

    fn shim(&self, path: &str) {
      let path = self.0.join(path);
      fs::create_dir_all(path.parent().unwrap()).unwrap();
      fs::write(path, "@echo off\r\nexit /b 0\r\n").unwrap();
    }
  }

  impl Drop for Fixture {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn discovers_scoop_and_pnpm_shims_missing_from_the_gui_path() {
    let fixture = Fixture::new();
    let inherited = fixture.directory("inherited");
    let profile = fixture.directory("profile");
    let local = fixture.directory("local");
    fixture.shim("profile\\scoop\\shims\\az.cmd");
    fixture.shim("local\\pnpm\\bin\\copilot.cmd");
    let mut environment = environment(
      &[
        ("PATH", inherited.to_str().unwrap()),
        ("USERPROFILE", profile.to_str().unwrap()),
        ("LOCALAPPDATA", local.to_str().unwrap()),
      ],
      &[],
      &[],
    );

    for name in ["az.cmd", "copilot.cmd"] {
      assert!(which::which_in(name, Some(inherited.as_os_str()), &inherited).is_err());
    }
    let first = refresh(&mut environment, Path::is_dir);
    assert_eq!(
      which::which_in("az.cmd", Some(&first.path), &inherited).unwrap(),
      profile.join("scoop\\shims\\az.cmd")
    );
    assert_eq!(
      which::which_in("copilot.cmd", Some(&first.path), &inherited).unwrap(),
      local.join("pnpm\\bin\\copilot.cmd")
    );
    environment
      .process
      .insert("PATH".into(), first.path.clone());
    let second = refresh(&mut environment, Path::is_dir);
    assert_eq!(first.path, second.path);
  }

  #[test]
  fn fresh_registry_paths_find_tools_installed_after_startup() {
    let fixture = Fixture::new();
    let inherited = fixture.directory("inherited");
    let azure = fixture.directory("custom azure");
    let pnpm = fixture.directory("custom pnpm");
    let mut initial = environment(&[("PATH", inherited.to_str().unwrap())], &[], &[]);
    let before = refresh(&mut initial, Path::is_dir);
    fixture.shim("custom azure\\az.cmd");
    fixture.shim("custom pnpm\\bin\\copilot.cmd");
    for name in ["az.cmd", "copilot.cmd"] {
      assert!(which::which_in(name, Some(&before.path), &inherited).is_err());
    }

    let mut recheck = environment(
      &[("PATH", before.path.to_str().unwrap())],
      &[("PATH", azure.to_str().unwrap())],
      &[
        ("PATH", "%CUSTOM_TOOLS%\\bin"),
        ("CUSTOM_TOOLS", pnpm.to_str().unwrap()),
      ],
    );
    let after = refresh(&mut recheck, Path::is_dir);
    assert_eq!(
      which::which_in("az.cmd", Some(&after.path), &inherited).unwrap(),
      azure.join("az.cmd")
    );
    assert_eq!(
      which::which_in("copilot.cmd", Some(&after.path), &inherited).unwrap(),
      pnpm.join("bin\\copilot.cmd")
    );
  }

  #[test]
  fn merges_fresh_machine_then_user_paths_with_recursive_case_insensitive_expansion() {
    let mut environment = environment(
      &[
        ("Path", "C:\\override"),
        ("TOOLS", "C:\\process"),
        ("SystemDrive", "D:"),
      ],
      &[
        ("PATH", "%ROOT%\\bin;C:\\machine"),
        ("ROOT", "%SystemDrive%\\tools"),
      ],
      &[
        (
          "PATH",
          "%path%;%tools%\\bin;%ROOT%\\user;%MISSING%\\bin;E:\\valid",
        ),
        ("TOOLS", "C:\\stale"),
      ],
    );
    assert_eq!(
      entries(&refresh(&mut environment, |_| false)),
      paths(&[
        "C:\\override",
        "D:\\tools\\bin",
        "C:\\machine",
        "C:\\process\\bin",
        "D:\\tools\\user",
        "E:\\valid"
      ])
    );
  }

  #[test]
  fn preserves_order_and_spelling_while_removing_empty_and_equivalent_paths() {
    let mut environment = environment(
      &[(
        "PATH",
        r#"C:\First;C:\Tools\;c:/tools;"";"C:\Has Space";"C:\Semi;Colon";C:\"#,
      )],
      &[("PATH", "C:\\FIRST;;C:\\machine;C:")],
      &[("PATH", "c:\\Machine\\;C:\\USER;")],
    );
    assert_eq!(
      entries(&refresh(&mut environment, |_| false)),
      paths(&[
        "C:\\First",
        "C:\\Tools\\",
        "C:\\Has Space",
        "C:\\Semi;Colon",
        "C:\\",
        "C:\\machine",
        "C:",
        "C:\\USER"
      ])
    );
  }

  #[test]
  fn expands_path_lists_without_splitting_quoted_semicolon_directories() {
    let mut environment = environment(
      &[("ROOT", "C:\\semicolon;directory")],
      &[],
      &[
        ("PATH", "\"%ROOT%\\bin\";%TOOLS%"),
        ("TOOLS", "D:\\first;E:\\second"),
      ],
    );
    assert_eq!(
      entries(&refresh(&mut environment, |_| false)),
      paths(&["C:\\semicolon;directory\\bin", "D:\\first", "E:\\second"])
    );
  }

  #[test]
  fn preserves_non_unicode_inherited_paths() {
    let mut raw: Vec<_> = "C:\\tools".encode_utf16().collect();
    raw.extend([0xd800]);
    raw.extend(";C:\\other".encode_utf16());
    let inherited = OsString::from_wide(&raw);
    let mut environment =
      Environment::new([(OsString::from("PATH"), inherited.clone())], |_, _| None);
    assert_eq!(refresh(&mut environment, |_| false).path, inherited);
  }

  #[test]
  fn discovers_custom_roots_and_only_hydrates_missing_azure_locations() {
    let mut environment = environment(
      &[
        ("PATH", "C:\\inherited"),
        ("SCOOP", "D:\\custom-scoop"),
        ("AZURE_CLI_PATH", "D:\\azure-override"),
        ("PROGRAMDATA", "C:\\ProgramData"),
      ],
      &[
        ("SCOOP_GLOBAL", "E:\\global-scoop"),
        ("PACKAGES", "E:\\packages"),
        ("AZURE_CLI_PATH", "C:\\azure-stale"),
        ("AZURECLIPATH", "%PACKAGES%\\azure\\wbin"),
        ("AUTH_TOKEN", "must-not-be-imported"),
      ],
      &[
        ("PNPM_HOME", "%PACKAGES%\\pnpm"),
        ("SCOOP", "C:\\scoop-stale"),
      ],
    );
    let existing = paths(&[
      "D:\\custom-scoop\\shims",
      "E:\\global-scoop\\shims",
      "C:\\ProgramData\\scoop\\shims",
      "E:\\packages\\pnpm",
      "E:\\packages\\pnpm\\bin",
      "D:\\azure-override\\wbin",
      "E:\\packages\\azure\\wbin",
    ]);
    let refreshed = refresh(&mut environment, |path| {
      existing.iter().any(|entry| entry == path)
    });
    let mut expected = paths(&["C:\\inherited"]);
    expected.extend(existing);
    assert_eq!(entries(&refreshed), expected);
    assert_eq!(
      refreshed.variables,
      vec![("AzureCLIPath", "E:\\packages\\azure\\wbin".into())]
    );
    for (name, value) in &refreshed.variables {
      environment
        .process
        .insert(name.to_uppercase(), value.into());
    }
    environment
      .process
      .insert("PATH".into(), refreshed.path.clone());
    let again = refresh(&mut environment, |_| true);
    assert!(again.variables.is_empty());
  }

  #[test]
  fn discovers_azure_installer_bins_and_expands_the_shim_location() {
    let mut environment = environment(
      &[
        ("USERPROFILE", "C:\\user"),
        ("ProgramFiles", "C:\\Program Files"),
        ("ProgramFiles(x86)", "C:\\Program Files (x86)"),
      ],
      &[],
      &[("AZURE_CLI_PATH", "%USERPROFILE%\\azure")],
    );
    let expected = paths(&[
      "C:\\user\\azure\\bin",
      "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin",
      "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin",
    ]);
    let refreshed = refresh(&mut environment, |path| {
      expected.iter().any(|entry| entry == path)
    });
    assert_eq!(entries(&refreshed), expected);
    assert_eq!(
      refreshed.variables,
      vec![("AZURE_CLI_PATH", "C:\\user\\azure".into())]
    );
  }

  #[test]
  fn missing_registry_values_preserve_the_inherited_path() {
    let mut environment = environment(&[("PATH", "C:\\tools;C:\\Windows\\System32")], &[], &[]);
    let refreshed = refresh(&mut environment, |_| false);
    assert_eq!(
      refreshed.path,
      OsString::from("C:\\tools;C:\\Windows\\System32")
    );
    assert!(refreshed.variables.is_empty());
    assert!(!refreshed.truncated);
  }

  #[test]
  fn empty_root_overrides_do_not_add_relative_paths_or_get_hydrated() {
    let mut environment = environment(
      &[("SCOOP", ""), ("PNPM_HOME", ""), ("AZURE_CLI_PATH", "")],
      &[("AZURE_CLI_PATH", "C:\\azure")],
      &[
        ("SCOOP", "C:\\scoop"),
        ("PNPM_HOME", "C:\\pnpm"),
        ("AzureCLIPath", "relative"),
      ],
    );
    let refreshed = refresh(&mut environment, |_| true);
    assert!(refreshed.path.is_empty());
    assert!(refreshed.variables.is_empty());
  }

  #[test]
  fn cyclic_unresolved_and_oversized_expansions_do_not_hide_valid_entries() {
    let oversized = "x".repeat(MAX_ENV_UNITS + 1);
    let mut environment = environment(
      &[("PATH", "C:\\inherited")],
      &[("A", "%B%"), ("B", "%a%"), ("OVERSIZED", &oversized)],
      &[("PATH", "%A%\\bin;%UNDEFINED%;%OVERSIZED%;C:\\valid")],
    );
    assert_eq!(
      entries(&refresh(&mut environment, |_| false)),
      paths(&["C:\\inherited", "C:\\valid"])
    );
    assert!(environment.expand("%A%").is_none());
    assert!(environment.expand("bad\0path").is_none());
  }

  #[test]
  fn expansion_depth_work_and_registry_queries_are_bounded() {
    let mut recursive_environment = Environment::new([], |_, name: &str| {
      name
        .strip_prefix('V')
        .and_then(|number| number.parse::<usize>().ok())
        .map(|number| format!("%V{}%", number + 1))
    });
    assert!(recursive_environment.expand("%V0%").is_none());
    assert!(recursive_environment.persistent.len() <= MAX_EXPANSION_DEPTH + 1);
    for index in 0..MAX_REGISTRY_LOOKUPS * 2 {
      recursive_environment.variable(&format!("V{index}"));
    }
    assert_eq!(recursive_environment.persistent.len(), MAX_REGISTRY_LOOKUPS);

    let mut environment = environment(&[("V", "C:\\tools")], &[], &[]);
    assert!(environment
      .expand(&"%V%".repeat(MAX_SUBSTITUTIONS + 1))
      .is_none());
  }

  #[test]
  fn combined_path_is_bounded_and_inherited_entries_keep_priority() {
    let machine = (0..1500)
      .map(|n| format!("C:\\machine\\{n}"))
      .collect::<Vec<_>>()
      .join(";");
    let user = (0..1500)
      .map(|n| format!("D:\\user\\{n}"))
      .collect::<Vec<_>>()
      .join(";");
    let mut environment = environment(
      &[("PATH", "C:\\inherited")],
      &[("PATH", &machine)],
      &[("PATH", &user)],
    );
    let refreshed = refresh(&mut environment, |_| false);
    assert!(refreshed.truncated);
    assert!(refreshed.path.encode_wide().count() <= MAX_ENV_UNITS);
    assert_eq!(entries(&refreshed)[0], PathBuf::from("C:\\inherited"));
  }

  fn read_data(data: &[u16]) -> Result<Option<String>, ReadError> {
    read_string(|buffer, bytes| {
      *bytes = (data.len() * 2) as u32;
      if let Some(buffer) = buffer {
        buffer[..data.len()].copy_from_slice(data);
      }
      ERROR_SUCCESS
    })
  }

  #[test]
  fn registry_strings_are_validated_without_lossy_utf16_conversion() {
    let valid: Vec<_> = "C:\\工具".encode_utf16().chain(Some(0)).collect();
    assert_eq!(read_data(&valid), Ok(Some("C:\\工具".into())));
    assert_eq!(read_data(&[0]), Ok(Some(String::new())));
    assert_eq!(read_data(&[65, 0, 0]), Ok(Some("A".into())));
    for invalid in [&[0xd800, 0][..], &[65], &[65, 0, 66, 0], &[]] {
      assert_eq!(read_data(invalid), Err(ReadError::InvalidString));
    }
    assert_eq!(
      read_string(|_, bytes| {
        *bytes = 3;
        ERROR_SUCCESS
      }),
      Err(ReadError::InvalidString)
    );
  }

  #[test]
  fn missing_registry_sources_are_normal_and_other_errors_are_reported() {
    for status in [ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND] {
      assert_eq!(read_string(|_, _| status), Ok(None));
    }
    assert_eq!(
      read_string(|_, _| WIN32_ERROR(5)),
      Err(ReadError::Windows(5))
    );
    assert_eq!(
      read_string(|buffer, bytes| {
        *bytes = 2;
        if buffer.is_some() {
          ERROR_FILE_NOT_FOUND
        } else {
          ERROR_SUCCESS
        }
      }),
      Ok(None)
    );
  }

  #[test]
  fn registry_allocations_and_size_change_retries_are_bounded() {
    let mut calls = 0;
    assert_eq!(
      read_string(|buffer, bytes| {
        calls += 1;
        assert!(buffer.is_none());
        *bytes = MAX_REGISTRY_BYTES + 2;
        ERROR_SUCCESS
      }),
      Err(ReadError::TooLarge)
    );
    assert_eq!(calls, 1);

    calls = 0;
    assert_eq!(
      read_string(|_, bytes| {
        calls += 1;
        *bytes = 2;
        if calls == 1 {
          ERROR_SUCCESS
        } else {
          ERROR_MORE_DATA
        }
      }),
      Err(ReadError::ChangedRepeatedly)
    );
    assert_eq!(calls, MAX_READ_ATTEMPTS + 1);
  }

  #[test]
  fn registry_read_retries_when_a_value_grows() {
    let data: Vec<_> = "C:\\new\\bin".encode_utf16().chain(Some(0)).collect();
    let mut reads = 0;
    let value = read_string(|buffer, bytes| {
      if let Some(buffer) = buffer {
        reads += 1;
        *bytes = (data.len() * 2) as u32;
        if reads == 1 {
          return ERROR_MORE_DATA;
        }
        buffer[..data.len()].copy_from_slice(&data);
      } else {
        *bytes = 2;
      }
      ERROR_SUCCESS
    });
    assert_eq!(reads, 2);
    assert_eq!(value, Ok(Some("C:\\new\\bin".into())));
  }
}
