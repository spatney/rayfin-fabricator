//! The Rayfin release new projects start on, and the releases the local
//! backend runs.
//!
//! Every personal project runs on the bundled rayfin-local backend, which runs
//! one line of Rayfin SDK releases: `sdk.supported` in the repo's
//! `rayfin-local.json`. A new project scaffolds with the newest stable release
//! in that range and pins its `@microsoft/rayfin-*` packages to that minor
//! (`~1.36.0`). The templates' caret ranges would otherwise pull a newer minor
//! that rayfin-local can't run. Team apps take the pin too. Upgrades stop at
//! [`newest_supported`] for the same reason.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use semver::{Version, VersionReq};
use serde::Deserialize;

use crate::services::exec::{self, RunOptions};
use crate::services::project_layout::ProjectLayout;

/// The package `npm create @microsoft/rayfin` runs.
const SCAFFOLDER: &str = "@microsoft/create-rayfin";

/// How long to wait for npm's list of releases before using the tested one.
const LOOKUP_TIMEOUT_MS: u64 = 20_000;

/// How deep a workspace glob's `**` looks.
const MAX_GLOB_DEPTH: usize = 8;

#[derive(Deserialize)]
struct PinFile {
  sdk: SdkPin,
}

#[derive(Deserialize)]
struct SdkPin {
  /// The npm range of releases rayfin-local runs, such as `>=1.36.0 <1.37.0`.
  supported: String,
  /// The release rayfin-local was tested with.
  tested: String,
}

static PIN: Lazy<SdkPin> = Lazy::new(|| {
  serde_json::from_str::<PinFile>(include_str!("../../../rayfin-local.json"))
    .expect("rayfin-local.json declares sdk.supported and sdk.tested")
    .sdk
});

/// The npm range of Rayfin releases rayfin-local runs.
pub fn supported_range() -> &'static str {
  &PIN.supported
}

fn tested_release() -> Version {
  Version::parse(&PIN.tested).expect("rayfin-local.json's sdk.tested is a version")
}

/// The Rayfin release a new project starts on.
#[derive(Debug, Clone, PartialEq)]
pub struct NewProjectSdk {
  /// What it scaffolds with: `npm create @microsoft/rayfin@<version>`.
  pub version: Version,
  /// The stable releases rayfin-local runs, oldest first. Only `version` when
  /// npm couldn't list them.
  pub supported: Vec<Version>,
}

impl NewProjectSdk {
  /// The range its `@microsoft/rayfin-*` packages are pinned to.
  pub fn pin(&self) -> String {
    format!("~{}.{}.0", self.version.major, self.version.minor)
  }

  /// Whether a declared `@microsoft/rayfin-*` spec can resolve to a release
  /// rayfin-local runs. Of the dist-tags, only `latest` is taken on trust.
  pub fn admits(&self, spec: &str) -> bool {
    let spec = spec.trim();
    spec == "latest"
      || NpmRange::parse(spec).is_some_and(|range| self.supported.iter().any(|v| range.matches(v)))
  }
}

/// The release a new project starts on: the newest stable one npm lists within
/// rayfin-local's supported range, or the tested one when npm can't be reached.
pub async fn new_project_sdk(cwd: &Path) -> NewProjectSdk {
  choose(published_versions(SCAFFOLDER, Some(cwd)).await.as_deref(), &PIN.supported, tested_release())
}

/// The newest stable release in `published` (npm's list of a package's
/// versions) that rayfin-local runs, if any.
pub fn newest_supported(published: &[String]) -> Option<Version> {
  supported_releases(published, &PIN.supported).pop()
}

/// [`new_project_sdk`] over npm's list of versions (`None` when it couldn't be read).
fn choose(published: Option<&[String]>, supported: &str, tested: Version) -> NewProjectSdk {
  let releases = published.map(|list| supported_releases(list, supported)).unwrap_or_default();
  match releases.last().cloned() {
    Some(version) => NewProjectSdk { version, supported: releases },
    None => NewProjectSdk { version: tested.clone(), supported: vec![tested] },
  }
}

/// The stable versions in `published` that the npm range `supported` allows,
/// oldest first.
fn supported_releases(published: &[String], supported: &str) -> Vec<Version> {
  let Some(range) = NpmRange::parse(supported) else {
    return vec![];
  };
  let mut releases: Vec<Version> = published
    .iter()
    .filter_map(|v| Version::parse(v.trim()).ok())
    .filter(|v| v.pre.is_empty() && range.matches(v))
    .collect();
  releases.sort();
  releases.dedup();
  releases
}

/// Every version npm lists for `package`, or `None` when npm can't say in time.
/// `cwd`: where npm runs, for the project's npm configuration.
pub async fn published_versions(package: &str, cwd: Option<&Path>) -> Option<Vec<String>> {
  let res = exec::run(
    "npm",
    &["view", package, "versions", "--json"],
    RunOptions {
      cwd: cwd.map(Path::to_path_buf).filter(|dir| dir.is_dir()),
      env: crate::services::npm_env::fresh_registry_env(),
      timeout_ms: Some(LOOKUP_TIMEOUT_MS),
      ..Default::default()
    },
  )
  .await;
  if !res.ok {
    log::warn!("couldn't list the {package} releases (exit code {:?}): {}", res.exit_code, res.stderr.trim());
    return None;
  }
  parse_version_list(&res.stdout)
}

/// `npm view <package> versions --json`: an array, or a string for a single version.
fn parse_version_list(stdout: &str) -> Option<Vec<String>> {
  match serde_json::from_str::<serde_json::Value>(stdout.trim()).ok()? {
    serde_json::Value::Array(items) => {
      Some(items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
    }
    serde_json::Value::String(one) => Some(vec![one]),
    _ => None,
  }
}

/// An npm semver range, such as `>=1.36.0 <1.37.0`, `^1.36.0-alpha`, `1.36.x`,
/// `1.2.3 - 1.4` or `^1 || ^2`, as one `semver` requirement per `||` alternative.
struct NpmRange(Vec<VersionReq>);

impl NpmRange {
  /// `None` for what isn't a range, such as a dist-tag.
  fn parse(range: &str) -> Option<Self> {
    range.split("||").map(|set| comparator_set(set.trim())).collect::<Option<Vec<_>>>().map(Self)
  }

  fn matches(&self, version: &Version) -> bool {
    self.0.iter().any(|req| req.matches(version))
  }
}

fn is_operator(c: char) -> bool {
  matches!(c, '<' | '>' | '=' | '~' | '^')
}

/// One `||` alternative of an npm range: space-separated comparators, which
/// `semver` separates with commas, or a hyphen range.
fn comparator_set(set: &str) -> Option<VersionReq> {
  if let Some((low, high)) = set.split_once(" - ") {
    return VersionReq::parse(&format!(">={}, <={}", bare(low)?, bare(high)?)).ok();
  }
  let mut comparators = Vec::new();
  let mut operator = String::new();
  for token in set.split_whitespace() {
    // npm allows a space between an operator and its version (`>= 1.2.3`).
    if token.chars().all(is_operator) {
      operator.push_str(token);
      continue;
    }
    comparators.push(comparator(&format!("{operator}{token}"))?);
    operator.clear();
  }
  if !operator.is_empty() {
    return None;
  }
  // `semver` wants a wildcard alone, and one among others adds nothing.
  comparators.retain(|c| c != "*");
  if comparators.is_empty() {
    return Some(VersionReq::STAR);
  }
  VersionReq::parse(&comparators.join(", ")).ok()
}

/// One npm comparator in `semver`'s syntax. To npm a bare version means exactly
/// that version (a partial one, any version it starts), but `^version` to
/// `semver`, so it gains `=`.
fn comparator(token: &str) -> Option<String> {
  let split = token.find(|c: char| !is_operator(c)).unwrap_or(token.len());
  let (operator, version) = token.split_at(split);
  let version = bare(version)?;
  Some(match operator {
    _ if version == "*" => version,
    "" | "=" => format!("={version}"),
    _ => format!("{operator}{version}"),
  })
}

/// A version as an npm range writes it, without a `v`, build metadata or
/// trailing wildcards: `v1.36.x` is `1.36`, and a lone wildcard `*`.
fn bare(version: &str) -> Option<String> {
  let version = version.trim().trim_start_matches(['v', 'V']);
  let version = version.split('+').next().unwrap_or_default();
  let (core, pre) = match version.split_once('-') {
    Some((core, pre)) => (core, Some(pre)),
    None => (version, None),
  };
  let mut parts = Vec::new();
  for part in core.split('.') {
    if matches!(part, "*" | "x" | "X") {
      break;
    }
    part.parse::<u64>().ok()?;
    parts.push(part);
  }
  if parts.len() > 3 {
    return None;
  }
  if parts.is_empty() {
    return Some("*".to_string());
  }
  let mut out = parts.join(".");
  if let (Some(pre), 3) = (pre, parts.len()) {
    out.push('-');
    out.push_str(pre);
  }
  Some(out)
}

/// A `"@microsoft/rayfin-<name>": "<spec>"` entry in a package.json.
static RAYFIN_SPEC: Lazy<Regex> =
  Lazy::new(|| Regex::new(r#""(@microsoft/rayfin-[^"\\]+)"(\s*:\s*)"([^"\\]*)""#).unwrap());

/// Whether a dependency spec asks the registry for a version (a range or a
/// tag), rather than naming a file, link, git or alias source.
fn from_registry(spec: &str) -> bool {
  !spec.contains(':') && !spec.contains('/')
}

/// The `@microsoft/rayfin-*` registry dependencies a package.json declares, as
/// `(name, spec)`.
fn rayfin_specs(package_json: &str) -> Vec<(String, String)> {
  RAYFIN_SPEC
    .captures_iter(package_json)
    .filter(|c| from_registry(&c[3]))
    .map(|c| (c[1].to_string(), c[3].to_string()))
    .collect()
}

/// `package_json` with every `@microsoft/rayfin-*` registry dependency set to
/// `range`, and everything else as it was. `None` when nothing changes.
fn pin_rayfin_specs(package_json: &str, range: &str) -> Option<String> {
  let pinned = RAYFIN_SPEC.replace_all(package_json, |c: &Captures| {
    if from_registry(&c[3]) { format!("\"{}\"{}\"{range}\"", &c[1], &c[2]) } else { c[0].to_string() }
  });
  (pinned != package_json).then(|| pinned.into_owned())
}

/// What pinning a new project's Rayfin packages did.
#[derive(Debug, PartialEq)]
pub enum Pinning {
  /// Its `@microsoft/rayfin-*` ranges read `range` now, after changing `files` package.json files.
  Pinned { range: String, files: usize },
  /// A declared range can't resolve to a release rayfin-local runs, so the
  /// template keeps the versions it asks for.
  Kept { name: String, spec: String },
}

/// Pin every `@microsoft/rayfin-*` registry dependency in the project's
/// package.json files to [`NewProjectSdk::pin`]. With `only_if_admitted`
/// (community templates), nothing changes unless every declared range can
/// resolve to a release rayfin-local runs.
pub fn pin_project(project: &Path, sdk: &NewProjectSdk, only_if_admitted: bool) -> Result<Pinning, String> {
  let mut manifests = Vec::new();
  for path in manifest_paths(project) {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    manifests.push((path, text));
  }
  if only_if_admitted {
    let refused = manifests.iter().flat_map(|(_, text)| rayfin_specs(text)).find(|(_, spec)| !sdk.admits(spec));
    if let Some((name, spec)) = refused {
      return Ok(Pinning::Kept { name, spec });
    }
  }
  let range = sdk.pin();
  let mut files = 0;
  for (path, text) in manifests {
    if let Some(pinned) = pin_rayfin_specs(&text, &range) {
      std::fs::write(&path, pinned).map_err(|e| format!("Couldn't update {}: {e}", path.display()))?;
      files += 1;
    }
  }
  Ok(Pinning::Pinned { range, files })
}

/// The project's package.json files: the root's, its npm workspaces', and the
/// functions folder's.
fn manifest_paths(project: &Path) -> Vec<PathBuf> {
  let mut dirs = vec![project.to_path_buf()];
  dirs.extend(workspace_dirs(project));
  dirs.push(functions_dir(project));
  let mut seen = BTreeSet::new();
  dirs
    .into_iter()
    .filter(|dir| seen.insert(dir.clone()))
    .map(|dir| dir.join("package.json"))
    .filter(|path| path.is_file())
    .collect()
}

/// The functions folder: `rayfin/functions` unless rayfin.yml names another.
fn functions_dir(project: &Path) -> PathBuf {
  ProjectLayout::read(project)
    .functions_root
    .split('/')
    .filter(|segment| !segment.is_empty())
    .fold(project.to_path_buf(), |dir, segment| dir.join(segment))
}

/// The functions folder when it has its own package.json that the root install
/// doesn't cover, because it isn't one of the root's npm workspaces.
pub fn separate_functions_dir(project: &Path) -> Option<PathBuf> {
  let dir = functions_dir(project);
  if dir == project || !dir.join("package.json").is_file() {
    return None;
  }
  (!workspace_dirs(project).contains(&dir)).then_some(dir)
}

/// The `workspaces` globs a package.json declares, in its array or its
/// `{ "packages": [...] }` form.
fn workspace_globs(package_json: &str) -> Vec<String> {
  let text = package_json.strip_prefix('\u{feff}').unwrap_or(package_json);
  let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
    return vec![];
  };
  let globs = match json.get("workspaces") {
    Some(serde_json::Value::Object(form)) => form.get("packages"),
    other => other,
  };
  globs
    .and_then(|g| g.as_array())
    .into_iter()
    .flatten()
    .filter_map(|g| g.as_str())
    .map(|g| g.trim().replace('\\', "/"))
    .filter(|g| !g.is_empty())
    .collect()
}

/// The folders, with a package.json, that the project's npm workspaces name.
pub(crate) fn workspace_dirs(project: &Path) -> Vec<PathBuf> {
  let Ok(text) = std::fs::read_to_string(project.join("package.json")) else {
    return vec![];
  };
  let mut included = BTreeSet::new();
  let mut excluded = BTreeSet::new();
  for glob in workspace_globs(&text) {
    match glob.strip_prefix('!') {
      Some(negated) => expand(project, &negated.split('/').collect::<Vec<_>>(), 0, &mut excluded),
      None => expand(project, &glob.split('/').collect::<Vec<_>>(), 0, &mut included),
    }
  }
  included.into_iter().filter(|dir| !excluded.contains(dir) && dir.join("package.json").is_file()).collect()
}

/// Add the folders under `dir` that the glob `segments` match.
fn expand(dir: &Path, segments: &[&str], depth: usize, out: &mut BTreeSet<PathBuf>) {
  let Some((first, rest)) = segments.split_first() else {
    out.insert(dir.to_path_buf());
    return;
  };
  if depth > MAX_GLOB_DEPTH {
    return;
  }
  match *first {
    "" | "." => expand(dir, rest, depth, out),
    // Workspaces outside the project aren't its own to change.
    ".." => {}
    "**" => {
      expand(dir, rest, depth, out);
      for child in subfolders(dir) {
        expand(&child, segments, depth + 1, out);
      }
    }
    pattern if pattern.contains(['*', '?']) => {
      for child in subfolders(dir) {
        if child.file_name().and_then(|n| n.to_str()).is_some_and(|name| wildcard_match(pattern, name)) {
          expand(&child, rest, depth + 1, out);
        }
      }
    }
    name => {
      let child = dir.join(name);
      if child.is_dir() {
        expand(&child, rest, depth + 1, out);
      }
    }
  }
}

/// The folders a workspace glob's wildcards can match in `dir`, which npm
/// limits to ones that aren't `node_modules` or hidden.
fn subfolders(dir: &Path) -> Vec<PathBuf> {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return vec![];
  };
  entries
    .flatten()
    .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
    .filter(|entry| {
      let name = entry.file_name();
      let name = name.to_string_lossy();
      name != "node_modules" && !name.starts_with('.')
    })
    .map(|entry| entry.path())
    .collect()
}

/// Whether a folder name matches a glob segment's `*` and `?` wildcards.
fn wildcard_match(pattern: &str, name: &str) -> bool {
  let (pattern, name): (Vec<char>, Vec<char>) = (pattern.chars().collect(), name.chars().collect());
  let (mut p, mut n) = (0, 0);
  let mut backtrack: Option<(usize, usize)> = None;
  while n < name.len() {
    if p < pattern.len() && (pattern[p] == '?' || pattern[p] == name[n]) {
      p += 1;
      n += 1;
    } else if p < pattern.len() && pattern[p] == '*' {
      backtrack = Some((p, n));
      p += 1;
    } else if let Some((star, from)) = backtrack {
      backtrack = Some((star, from + 1));
      p = star + 1;
      n = from + 1;
    } else {
      return false;
    }
  }
  pattern[p..].iter().all(|&c| c == '*')
}

#[cfg(test)]
mod tests {
  use super::*;

  fn v(version: &str) -> Version {
    Version::parse(version).unwrap()
  }

  fn list(versions: &[&str]) -> Vec<String> {
    versions.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn the_pin_files_tested_release_is_in_its_supported_range() {
    let range = NpmRange::parse(supported_range()).expect("sdk.supported is an npm range");
    assert!(range.matches(&tested_release()), "{} isn't in {}", PIN.tested, PIN.supported);
  }

  #[test]
  fn new_projects_use_the_newest_stable_supported_release() {
    let published = list(&[
      "1.35.1", "1.36.0-alpha.1917", "1.36.0-beta.0", "1.36.0", "1.36.2", "1.36.1", "1.36.3-beta.0",
      "1.37.0-alpha.2111", "1.37.0", "not-a-version",
    ]);
    let sdk = choose(Some(&published), ">=1.36.0 <1.37.0", v("1.36.0"));
    assert_eq!(sdk.version, v("1.36.2"));
    assert_eq!(sdk.supported, vec![v("1.36.0"), v("1.36.1"), v("1.36.2")]);
    assert_eq!(sdk.pin(), "~1.36.0");
    assert_eq!(parse_version_list("[\"1.36.1\", \"1.36.2\"]\n"), Some(list(&["1.36.1", "1.36.2"])));
    assert_eq!(parse_version_list("\"1.36.2\""), Some(list(&["1.36.2"])));
    assert_eq!(parse_version_list("npm error 404"), None);
  }

  #[test]
  fn without_npms_list_new_projects_use_the_tested_release() {
    let tested = v("1.36.2");
    let offline = choose(None, ">=1.36.0 <1.37.0", tested.clone());
    assert_eq!(offline, NewProjectSdk { version: tested.clone(), supported: vec![tested.clone()] });
    // A registry that lists nothing in range (a stale mirror) doesn't help either.
    assert_eq!(choose(Some(&list(&["1.35.1", "1.37.0"])), ">=1.36.0 <1.37.0", tested.clone()).version, tested);
  }

  #[test]
  fn upgrades_stop_at_the_newest_stable_release_the_local_backend_runs() {
    let tested = tested_release();
    let beta = format!("{}.{}.{}-beta.1", tested.major, tested.minor, tested.patch + 1);
    let published = vec!["0.1.0".to_string(), tested.to_string(), beta, "999.0.0".to_string()];
    assert_eq!(newest_supported(&published), Some(tested));
    assert_eq!(newest_supported(&list(&["999.0.0", "0.1.0"])), None);
    assert_eq!(newest_supported(&[]), None);
  }

  #[test]
  fn npm_ranges_keep_npms_meaning() {
    let allows = |range: &str, version: &str| NpmRange::parse(range).unwrap().matches(&v(version));
    // A bare version is exact to npm, not a caret range.
    assert!(allows("1.36.0", "1.36.0") && !allows("1.36.0", "1.36.2"));
    assert!(allows("v1.36.0", "1.36.0") && allows("=1.36.0", "1.36.0"));
    assert!(allows("1.36", "1.36.2") && !allows("1.36", "1.37.0"));
    assert!(allows("1.36.x", "1.36.2") && allows("1.x", "1.37.0") && !allows("1.36.X", "1.35.0"));
    assert!(allows(">= 1.36.0 < 1.37.0", "1.36.2") && !allows(">=1.36.0 <1.37.0", "1.37.0"));
    assert!(allows("^1.36.0-alpha", "1.37.0") && allows("~1.36.0", "1.36.9") && !allows("~1.36.0", "1.37.0"));
    assert!(allows("1.35.0 - 1.36", "1.36.2") && !allows("1.35.0 - 1.36", "1.37.0"));
    assert!(allows("^1.35.0 || ~2.0.0", "2.0.1") && !allows("~1.35.0 || ~2.0.0", "1.36.0"));
    assert!(allows("*", "1.36.2") && allows("", "1.36.2") && allows("x", "1.36.2"));
    assert!(!allows(">=1.36.0 <1.37.0", "1.37.0-alpha.2008"));
    for not_a_range in ["latest", "next", "1.36.0.1", ">=", "1.a.0"] {
      assert!(NpmRange::parse(not_a_range).is_none(), "{not_a_range}");
    }
  }

  #[test]
  fn community_templates_must_resolve_within_the_supported_range() {
    let sdk = NewProjectSdk { version: v("1.36.2"), supported: vec![v("1.36.0"), v("1.36.1"), v("1.36.2")] };
    for spec in ["^1.33.0", "^1.36.0-alpha", "~1.36.0", "1.36.0", ">=1.30", "*", "", "latest"] {
      assert!(sdk.admits(spec), "{spec}");
    }
    for spec in ["~1.35.0", "1.37.0", "^2.0.0", "next", "experimental"] {
      assert!(!sdk.admits(spec), "{spec}");
    }
  }

  #[test]
  fn pinning_rewrites_only_rayfin_registry_ranges_and_keeps_formatting() {
    let manifest = "{\r\n\t\"name\": \"@microsoft/rayfin-app\",\r\n\t\"dependencies\": {\r\n\t\t\"@microsoft/rayfin-core\"  :  \"^1.36.0-alpha\",\r\n\t\t\"@microsoft/rayfin-local\": \"file:../rayfin-local\",\r\n\t\t\"@microsoft/fabric-visuals\": \"1.3.0\",\r\n\t\t\"react\": \"^19.2.7\"\r\n\t},\r\n\t\"devDependencies\": { \"@microsoft/rayfin-cli\": \"latest\", \"@microsoft/rayfin-guide\": \"^1.36.0-alpha\" }\r\n}\r\n";
    let pinned = pin_rayfin_specs(manifest, "~1.36.0").unwrap();
    assert_eq!(
      pinned,
      manifest
        .replace("\"  :  \"^1.36.0-alpha\"", "\"  :  \"~1.36.0\"")
        .replace("\"latest\"", "\"~1.36.0\"")
        .replace("\"^1.36.0-alpha\" }", "\"~1.36.0\" }")
    );
    assert!(pinned.contains("\"name\": \"@microsoft/rayfin-app\""));
    assert!(pinned.contains("\"file:../rayfin-local\"") && pinned.contains("\"@microsoft/fabric-visuals\": \"1.3.0\""));
    assert_eq!(pin_rayfin_specs(&pinned, "~1.36.0"), None);
    assert_eq!(pin_rayfin_specs("{\"dependencies\":{\"react\":\"^19\"}}", "~1.36.0"), None);
    assert_eq!(
      rayfin_specs(manifest),
      vec![
        ("@microsoft/rayfin-core".to_string(), "^1.36.0-alpha".to_string()),
        ("@microsoft/rayfin-cli".to_string(), "latest".to_string()),
        ("@microsoft/rayfin-guide".to_string(), "^1.36.0-alpha".to_string()),
      ]
    );
  }

  #[test]
  fn workspace_globs_read_both_forms_and_match_folder_names() {
    assert_eq!(workspace_globs("\u{feff}{\"workspaces\": [\"packages/*\", \" apps\\\\web \"]}"), ["packages/*", "apps/web"]);
    assert_eq!(workspace_globs("{\"workspaces\": {\"packages\": [\"packages/*\"], \"nohoist\": []}}"), ["packages/*"]);
    assert!(workspace_globs("{\"name\": \"app\"}").is_empty() && workspace_globs("not json").is_empty());
    assert!(wildcard_match("*", "frontend") && wildcard_match("app-*", "app-web") && wildcard_match("a?c*", "abcde"));
    assert!(!wildcard_match("app-*", "web-app") && !wildcard_match("a?c", "ac"));
  }

  #[test]
  fn the_functions_folder_installs_separately_unless_it_is_a_workspace() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("rayfin-sdk-{}", uuid::Uuid::new_v4()));
    let write = |rel: &str, text: &str| {
      let path = dir.join(rel);
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      std::fs::write(path, text).unwrap();
    };
    write("package.json", "{\"workspaces\": [\"packages/*\"], \"devDependencies\": {\"@microsoft/rayfin-cli\": \"^1.36.0-alpha\"}}");
    write("packages/frontend/package.json", "{\"dependencies\": {\"@microsoft/rayfin-client\": \"^1.36.0-alpha\"}}");
    write("packages/node_modules/package.json", "{}");
    write("rayfin/functions/package.json", "{\"dependencies\": {\"@microsoft/rayfin-functions\": \"^1.36.0\"}}");
    let functions = dir.join("rayfin").join("functions");
    assert_eq!(separate_functions_dir(&dir), Some(functions.clone()));
    assert_eq!(
      manifest_paths(&dir),
      [dir.clone(), dir.join("packages").join("frontend"), functions.clone()].map(|d| d.join("package.json"))
    );

    let sdk = NewProjectSdk { version: v("1.36.2"), supported: vec![v("1.36.2")] };
    assert_eq!(pin_project(&dir, &sdk, false), Ok(Pinning::Pinned { range: "~1.36.0".into(), files: 3 }));
    assert!(std::fs::read_to_string(functions.join("package.json")).unwrap().contains("\"~1.36.0\""));

    // A functions folder the root's workspaces include installs with the root.
    write("rayfin/rayfin.yml", "services:\n  functions:\n    path: packages/functions\n");
    write("packages/functions/package.json", "{}");
    assert_eq!(separate_functions_dir(&dir), None);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
