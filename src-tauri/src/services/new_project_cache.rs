//! Packages for new projects, ready ahead of time.
//!
//! Installing its packages is most of the wait when a project is created: the
//! Universal App installs about 650 packages, some 54,000 files, and npm works
//! out the whole tree against the registry each time. Yet every project created
//! from the same template on the same Rayfin release asks for the same
//! packages. So once one has installed, Fabricator keeps, per [`Key`]:
//!
//!   * a *recipe*: the files npm installed from (the package.json files and
//!     `.npmrc`) and the lockfile it wrote. The next project with the same key
//!     gets that lockfile, and npm installs those versions from its cache
//!     without working anything out, in about half the time.
//!   * for the built-in template, a *spare*: the recipe installed ahead of time,
//!     in the background, a minute after a project is created. The next project
//!     takes it by renaming its `node_modules` folders into place, which is
//!     instant on the same drive, and npm checks the result and links the
//!     workspaces in a second or two. Writing the files is the slow part on
//!     Windows, where Defender scans each one, so copying a cached
//!     `node_modules` would barely beat npm.
//!
//! Only one spare is kept, about 500 MB. A recipe is used for a week, so new
//! projects still get fixes to the packages their template doesn't pin, and
//! startup deletes it and its spare after that. Community templates get
//! recipes but no spares: their packages' install scripts may use files outside
//! their own folders, such as the project's, which a spare installed elsewhere
//! doesn't have.
//!
//! ```text
//! <cache>/new-projects/<key>/recipe/         package.json files, .npmrc, package-lock.json
//! <cache>/new-projects/<key>/spare/          the recipe, installed
//! <cache>/new-projects/<key>/building-<id>/  a spare being installed
//! <cache>/new-projects/<key>/taking-<id>/    a spare being taken
//! <cache>/new-projects/<key>/recipe-<id>/    a recipe being recorded
//! <cache>/new-projects/trash-<id>/           being deleted
//! ```

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};

use crate::services::exec::{self, OnData, RunOptions, RunResult, Stream};
use crate::services::{paths, rayfin_sdk};

/// Part of every key. Bump it when what a key stands for changes.
const KEY_VERSION: &str = "1";

/// How many hex digits name a key.
const KEY_LENGTH: usize = 20;

const LOCKFILE: &str = "package-lock.json";

/// How long a recipe is used before a new project's versions are worked out again.
const RECIPE_LIFETIME: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// How long after a project is created the next spare starts installing, so
/// it doesn't slow the new project's first start.
const SPARE_DELAY: Duration = Duration::from_secs(60);

/// How long creating a project waits for a spare that's being installed.
const SPARE_WAIT: Duration = Duration::from_secs(90);

/// How many recipes are kept.
const RECIPES_KEPT: usize = 4;

/// How long a folder must be untouched before startup deletes it as left
/// behind by an install, take or recording that stopped, or as the entry of a
/// recipe out of use. A recently changed one may be another running
/// Fabricator's (a development build's, say, next to the installed app). An
/// install stops after ten minutes.
const ABANDONED_AFTER: Duration = Duration::from_secs(15 * 60);

const FROM_REGISTRY: &str = "\nInstalling dependencies with npm…\n";

/// Held while a spare is installed or taken.
static SPARE: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/// The key whose spare is being installed, while one is.
static BUILDING: Lazy<std::sync::Mutex<Option<Key>>> = Lazy::new(|| std::sync::Mutex::new(None));

/// Install the packages of the project just scaffolded in `project` on Rayfin
/// `release`: from the spare, when `spares` (the built-in template) and there's
/// one for it, else at the versions its recipe locked, else with
/// `from_registry`, npm working the versions out, which makes the recipe. When
/// a faster way fails, `from_registry` installs. Then, with `spares`, the next
/// project's spare is installed a minute later. A project whose template
/// brought a lockfile or packages installs with `from_registry`.
pub async fn install<F, Fut>(project: &Path, release: &str, spares: bool, on: &OnData, from_registry: F) -> RunResult
where
  F: FnOnce() -> Fut,
  Fut: Future<Output = RunResult>,
{
  let cache = Cache::default();
  let key = if has_no_packages(project) { Key::of(project, release).await } else { None };
  let Some(key) = key else {
    on(Stream::Stdout, FROM_REGISTRY);
    return from_registry().await;
  };

  let faster = if spares && cache.take_spare(&key, project, on).await {
    Some("\nInstalling dependencies from the packages set aside for new projects…\n".to_string())
  } else if cache.lockfile(&key).is_some_and(|lockfile| std::fs::copy(lockfile, project.join(LOCKFILE)).is_ok()) {
    Some(format!("\nInstalling dependencies with npm, at the versions recorded for Rayfin {release}…\n"))
  } else {
    None
  };
  match faster {
    Some(how) => {
      on(Stream::Stdout, &how);
      let installed = install_locked(project, on).await;
      if installed.ok {
        if spares {
          cache.build_spare_later(key);
        }
        return installed;
      }
      let _ = std::fs::remove_file(project.join(LOCKFILE));
      on(Stream::System, "\nnpm couldn't install those versions, so it works them out again...\n");
    }
    None => on(Stream::Stdout, FROM_REGISTRY),
  }

  let installed = from_registry().await;
  if installed.ok {
    let (keeper, kept, dir) = (cache.clone(), key.clone(), project.to_path_buf());
    match tokio::task::spawn_blocking(move || keeper.remember(&kept, &dir)).await {
      Ok(Ok(())) => {
        if spares {
          cache.build_spare_later(key);
        }
      }
      Ok(Err(e)) => log::warn!("Couldn't record the package versions of {}: {e}", project.display()),
      Err(e) => log::warn!("Couldn't record the package versions of {}: {e}", project.display()),
    }
  }
  installed
}

/// Delete recipes past their week with their spares, what installs, takes
/// and recordings that stopped part way left behind, and the folders a delete
/// didn't finish. For startup.
pub fn clean_up() {
  Cache::default().clean_up(ABANDONED_AFTER);
}

/// Whether nothing is installed in `project` yet and nothing locks its
/// versions: its template brought neither packages nor a lockfile.
fn has_no_packages(project: &Path) -> bool {
  ["node_modules", LOCKFILE, "npm-shrinkwrap.json"].iter().all(|name| !project.join(name).exists())
}

/// `npm install` in `project` with a lockfile in place: npm installs the
/// versions it locks, from its cache when it has them, links the workspaces and
/// names the project in the lockfile, which came from another project.
async fn install_locked(project: &Path, on: &OnData) -> RunResult {
  exec::npm_install(
    &["install", "--prefer-offline", "--no-audit", "--no-fund"],
    RunOptions {
      cwd: Some(project.to_path_buf()),
      on_data: Some(on.clone()),
      timeout_ms: Some(600_000),
      ..Default::default()
    },
  )
  .await
}

/// What a new project's packages depend on, hashed: the Rayfin release, Node's
/// version and the files npm installs from, apart from the project's own name.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Key(String);

impl Key {
  /// `project`'s key, `None` when a file npm installs from can't be read.
  async fn of(project: &Path, release: &str) -> Option<Key> {
    // Packages with native code are built, or downloaded, for this Node.
    let node = exec::run("node", &["--version"], RunOptions::timeout(10_000)).await;
    key(project, release, if node.ok { node.stdout.trim() } else { "" })
  }
}

fn key(project: &Path, release: &str, node: &str) -> Option<Key> {
  let mut hasher = Sha256::new();
  hasher.update(format!("new-project {KEY_VERSION}\nrayfin {release}\nnode {node}\n"));
  for file in install_inputs(project) {
    let text = std::fs::read_to_string(under(project, &file)).ok()?;
    let content = if file.ends_with("package.json") { manifest(&text, file == "package.json")? } else { text };
    hasher.update(format!("{file} {}\n", content.len()));
    hasher.update(content);
  }
  Some(Key(hex::encode(&hasher.finalize()[..KEY_LENGTH / 2])))
}

/// The files npm installs a project's packages from, relative to it, with `/`:
/// the root's package.json and `.npmrc`, and its workspaces' package.json files.
fn install_inputs(project: &Path) -> Vec<String> {
  let mut files = vec!["package.json".to_string()];
  if project.join(".npmrc").is_file() {
    files.push(".npmrc".to_string());
  }
  for dir in rayfin_sdk::workspace_dirs(project) {
    if let Some(folder) = relative(project, &dir) {
      files.push(format!("{folder}/package.json"));
    }
  }
  files
}

/// A package.json's JSON without its formatting, and without the project's
/// own name when it's the root's: npm's install doesn't depend on it.
fn manifest(text: &str, root: bool) -> Option<String> {
  let mut json: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
  if root {
    json.as_object_mut()?.remove("name");
  }
  serde_json::to_string(&json).ok()
}

/// `path` relative to `base`, with `/`, when it's inside it.
fn relative(base: &Path, path: &Path) -> Option<String> {
  let parts: Vec<String> =
    path.strip_prefix(base).ok()?.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
  (!parts.is_empty()).then(|| parts.join("/"))
}

/// The path `relative` (with `/`, empty for `base` itself) names under `base`.
fn under(base: &Path, relative: &str) -> PathBuf {
  relative.split('/').filter(|part| !part.is_empty()).fold(base.to_path_buf(), |dir, part| dir.join(part))
}

/// Where the recipes and the spare are kept.
#[derive(Clone)]
struct Cache {
  root: PathBuf,
}

impl Default for Cache {
  fn default() -> Self {
    Cache { root: paths::cache_dir().join("new-projects") }
  }
}

impl Cache {
  fn entry(&self, key: &Key) -> PathBuf {
    self.root.join(&key.0)
  }

  fn recipe(&self, key: &Key) -> PathBuf {
    self.entry(key).join("recipe")
  }

  fn spare(&self, key: &Key) -> PathBuf {
    self.entry(key).join("spare")
  }

  /// The lockfile `key`'s recipe holds, while it's under [`RECIPE_LIFETIME`] old.
  fn lockfile(&self, key: &Key) -> Option<PathBuf> {
    let lockfile = self.recipe(key).join(LOCKFILE);
    let saved = std::fs::metadata(&lockfile).and_then(|meta| meta.modified()).ok()?;
    // A time in the future is a skewed clock: work the versions out again.
    let age = SystemTime::now().duration_since(saved).ok()?;
    (age < RECIPE_LIFETIME).then_some(lockfile)
  }

  /// Whether `key` has a spare installed from its recipe as it is now.
  fn spare_ready(&self, key: &Key) -> bool {
    let Some(lockfile) = self.lockfile(key) else {
      return false;
    };
    if !self.spare(key).join("node_modules").is_dir() {
      return false;
    }
    // npm ci doesn't write the lockfile, so the spare's is the one it installed.
    match (std::fs::read(lockfile), std::fs::read(self.spare(key).join(LOCKFILE))) {
      (Ok(recipe), Ok(spare)) => recipe == spare,
      _ => false,
    }
  }

  /// Keep what `project`'s install worked out as `key`'s recipe: the files npm
  /// installed from, and the lockfile it wrote.
  fn remember(&self, key: &Key, project: &Path) -> io::Result<()> {
    let staging = self.entry(key).join(format!("recipe-{}", short_id()));
    let saved = (|| {
      for file in install_inputs(project).iter().map(String::as_str).chain([LOCKFILE]) {
        let to = under(&staging, file);
        std::fs::create_dir_all(to.parent().unwrap_or(&staging))?;
        // Written, not copied, so the recipe's age is the lockfile's.
        std::fs::write(&to, std::fs::read(under(project, file))?)?;
      }
      let recipe = self.recipe(key);
      if recipe.exists() {
        std::fs::remove_dir_all(&recipe)?;
      }
      rename(&staging, &recipe)
    })();
    if saved.is_err() {
      let _ = std::fs::remove_dir_all(&staging);
    }
    self.prune(key);
    saved
  }

  /// Take `key`'s spare into `project` ([`Cache::take_spare_now`]). While
  /// `key`'s spare is being installed, waits up to [`SPARE_WAIT`] for it, and
  /// otherwise only briefly: another key's spare is no use to `project`.
  async fn take_spare(&self, key: &Key, project: &Path, on: &OnData) -> bool {
    let wait = if building(key) {
      on(Stream::Stdout, "\nWaiting for the packages Fabricator is installing for new projects…\n");
      SPARE_WAIT
    } else {
      Duration::from_secs(5)
    };
    let Ok(held) = tokio::time::timeout(wait, SPARE.lock()).await else {
      return false;
    };
    let (cache, key, project) = (self.clone(), key.clone(), project.to_path_buf());
    let taken = tokio::task::spawn_blocking(move || cache.take_spare_now(&key, &project)).await.unwrap_or(false);
    drop(held);
    taken
  }

  /// Move `key`'s spare into `project`, which has the same install inputs and
  /// no packages yet: its `node_modules` folders, without the links npm made in
  /// them to the spare's workspaces, for npm to make again, and its lockfile.
  /// False when there's no spare to take, or its folders couldn't move (to
  /// another drive, say), which leaves it for another project when it can.
  fn take_spare_now(&self, key: &Key, project: &Path) -> bool {
    if !self.spare_ready(key) {
      return false;
    }
    // Claim it first, so that a spare is never left half taken.
    let claimed = self.entry(key).join(format!("taking-{}", short_id()));
    if rename(&self.spare(key), &claimed).is_err() {
      return false;
    }
    let folders = package_folders(&claimed);
    let fits = folders.iter().any(String::is_empty)
      && folders.iter().all(|folder| {
        let dir = under(project, folder);
        dir.is_dir() && !dir.join("node_modules").exists()
      });
    let mut moved = Vec::new();
    if fits {
      for folder in &folders {
        match rename(&under(&claimed, folder).join("node_modules"), &under(project, folder).join("node_modules")) {
          Ok(()) => moved.push(folder),
          Err(e) => {
            log::info!("Couldn't move the packages set aside for new projects into {}: {e}", project.display());
            break;
          }
        }
      }
    }
    if moved.len() < folders.len() || !fits {
      // The spare goes back whole, or not at all.
      let mut whole = true;
      for folder in moved {
        let left = under(project, folder).join("node_modules");
        if rename(&left, &under(&claimed, folder).join("node_modules")).is_err() {
          whole = false;
          // npm finishes what stays in the project, and links its workspaces.
          remove_links(&left);
        }
      }
      if !whole || rename(&claimed, &self.spare(key)).is_err() {
        self.discard(&claimed);
      }
      return false;
    }
    for folder in &folders {
      remove_links(&under(project, folder).join("node_modules"));
    }
    let copied = std::fs::copy(claimed.join(LOCKFILE), project.join(LOCKFILE));
    self.discard(&claimed);
    copied.is_ok()
  }

  /// [`Cache::build_spare`] for `key`, [`SPARE_DELAY`] from now, in the background.
  fn build_spare_later(&self, key: Key) {
    let cache = self.clone();
    tauri::async_runtime::spawn(async move {
      tokio::time::sleep(SPARE_DELAY).await;
      if let Err(e) = cache.build_spare(&key).await {
        log::warn!("Couldn't set packages aside for the next new project: {e}");
      }
    });
  }

  /// Install `key`'s recipe ahead of time, as its spare, unless it has one.
  /// One spare is kept: any other goes.
  async fn build_spare(&self, key: &Key) -> Result<(), String> {
    let _held = SPARE.lock().await;
    if self.lockfile(key).is_none() || self.spare_ready(key) {
      return Ok(());
    }
    let _building = Building::start(key);
    for other in self.keys() {
      if self.spare(&other).exists() {
        self.discard(&self.spare(&other));
      }
    }
    for left in self.abandoned(ABANDONED_AFTER) {
      self.discard(&left);
    }
    let building = self.entry(key).join(format!("building-{}", short_id()));
    if let Err(e) = copy_tree(&self.recipe(key), &building) {
      self.discard(&building);
      return Err(format!("couldn't copy the recipe: {e}"));
    }
    let installed = exec::npm_install(
      &["ci", "--prefer-offline", "--no-audit", "--no-fund"],
      RunOptions { cwd: Some(building.clone()), timeout_ms: Some(600_000), ..Default::default() },
    )
    .await;
    if !installed.ok {
      self.discard(&building);
      return Err(exec::npm_install_failure(&installed, None));
    }
    let (from, to) = (building.clone(), self.spare(key));
    match tokio::task::spawn_blocking(move || rename(&from, &to)).await {
      Ok(Ok(())) => Ok(()),
      placed => {
        self.discard(&building);
        Err(format!("couldn't put the spare in place: {placed:?}"))
      }
    }
  }

  /// The keys of the recipes kept, newest first.
  fn keys(&self) -> Vec<Key> {
    let mut keys: Vec<(SystemTime, Key)> = entries(&self.root)
      .filter_map(|entry| {
        let name = entry.file_name().into_string().ok()?;
        if name.len() != KEY_LENGTH || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
          return None;
        }
        let saved = std::fs::metadata(entry.path().join("recipe").join(LOCKFILE))
          .and_then(|meta| meta.modified())
          .unwrap_or(SystemTime::UNIX_EPOCH);
        Some((saved, Key(name)))
      })
      .collect();
    keys.sort_by_key(|(saved, _)| std::cmp::Reverse(*saved));
    keys.into_iter().map(|(_, key)| key).collect()
  }

  /// Keep `key`'s recipe and the newest others, [`RECIPES_KEPT`] in all.
  fn prune(&self, key: &Key) {
    for old in self.keys().into_iter().filter(|other| other != key).skip(RECIPES_KEPT - 1) {
      self.discard(&self.entry(&old));
    }
  }

  /// Delete `dir` in the background, after moving it aside so that it's gone
  /// from where it was at once.
  fn discard(&self, dir: &Path) {
    let trash = self.root.join(format!("trash-{}", short_id()));
    let doomed = if std::fs::rename(dir, &trash).is_ok() { trash } else { dir.to_path_buf() };
    std::thread::spawn(move || {
      if let Err(e) = std::fs::remove_dir_all(&doomed) {
        log::warn!("Couldn't delete {}: {e}", doomed.display());
      }
    });
  }

  /// [`clean_up`], with folders untouched for `idle` taken as left behind or
  /// out of use. A recently changed one may be another running Fabricator's.
  fn clean_up(&self, idle: Duration) {
    for entry in entries(&self.root) {
      if entry.file_name().to_string_lossy().starts_with("trash-") {
        let _ = std::fs::remove_dir_all(entry.path());
      }
    }
    for key in self.keys() {
      // Its recipe is past its week, or was never recorded.
      if self.lockfile(&key).is_none() && untouched_for(&self.entry(&key), idle) {
        let _ = std::fs::remove_dir_all(self.entry(&key));
      }
    }
    for left in self.abandoned(idle) {
      let _ = std::fs::remove_dir_all(left);
    }
  }

  /// What installs, takes and recordings that stopped part way left in the
  /// entries, untouched for `idle`.
  fn abandoned(&self, idle: Duration) -> Vec<PathBuf> {
    entries(&self.root)
      .filter(|entry| !entry.file_name().to_string_lossy().starts_with("trash-"))
      .flat_map(|entry| entries(&entry.path()))
      .filter(|left| left.file_name() != "recipe" && left.file_name() != "spare")
      .map(|left| left.path())
      .filter(|left| untouched_for(left, idle))
      .collect()
  }
}

/// Whether `key`'s spare is being installed.
fn building(key: &Key) -> bool {
  BUILDING.lock().is_ok_and(|building| building.as_ref() == Some(key))
}

/// Marks `key`'s spare as being installed, until it's dropped.
struct Building;

impl Building {
  fn start(key: &Key) -> Self {
    if let Ok(mut building) = BUILDING.lock() {
      *building = Some(key.clone());
    }
    Building
  }
}

impl Drop for Building {
  fn drop(&mut self) {
    if let Ok(mut building) = BUILDING.lock() {
      *building = None;
    }
  }
}

/// A name for a temporary folder, kept short because npm installs deep trees
/// in some of them.
fn short_id() -> String {
  uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// Whether nothing has changed in `dir` itself for `period`.
fn untouched_for(dir: &Path, period: Duration) -> bool {
  std::fs::metadata(dir)
    .and_then(|meta| meta.modified())
    .ok()
    .and_then(|changed| SystemTime::now().duration_since(changed).ok())
    .is_some_and(|age| age >= period)
}

/// The folders in `dir`, relative, where npm installed packages: its own
/// `node_modules`, and its workspaces' when they have their own.
fn package_folders(dir: &Path) -> Vec<String> {
  std::iter::once(String::new())
    .chain(rayfin_sdk::workspace_dirs(dir).iter().filter_map(|workspace| relative(dir, workspace)))
    .filter(|folder| under(dir, folder).join("node_modules").is_dir())
    .collect()
}

/// Remove the links in a `node_modules` folder and in its scopes, which npm
/// makes to the workspaces of the project it installed in. The links go, not
/// what they lead to.
fn remove_links(node_modules: &Path) {
  for entry in entries(node_modules) {
    let Ok(kind) = entry.file_type() else {
      continue;
    };
    if kind.is_symlink() {
      remove_link(&entry.path());
    } else if kind.is_dir() && entry.file_name().to_string_lossy().starts_with('@') {
      for scoped in entries(&entry.path()) {
        if scoped.file_type().is_ok_and(|kind| kind.is_symlink()) {
          remove_link(&scoped.path());
        }
      }
    }
  }
}

/// Remove a link to a folder, which is a folder to Windows (a junction) and a
/// file elsewhere.
fn remove_link(link: &Path) {
  if std::fs::remove_file(link).is_err() {
    let _ = std::fs::remove_dir(link);
  }
}

/// `std::fs::rename`, tried again for a few seconds while Windows says a file
/// in the folder is in use, as it can while an antivirus scans files npm wrote.
fn rename(from: &Path, to: &Path) -> io::Result<()> {
  let mut pause = Duration::from_millis(50);
  loop {
    match std::fs::rename(from, to) {
      // ERROR_ACCESS_DENIED and ERROR_SHARING_VIOLATION.
      Err(e) if cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32)) && pause < Duration::from_secs(2) => {
        std::thread::sleep(pause);
        pause *= 2;
      }
      result => return result,
    }
  }
}

/// Copy the files under `from` to `to`.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
  std::fs::create_dir_all(to)?;
  for entry in std::fs::read_dir(from)? {
    let entry = entry?;
    if entry.file_type()?.is_dir() {
      copy_tree(&entry.path(), &to.join(entry.file_name()))?;
    } else {
      std::fs::copy(entry.path(), to.join(entry.file_name()))?;
    }
  }
  Ok(())
}

fn entries(dir: &Path) -> impl Iterator<Item = std::fs::DirEntry> {
  std::fs::read_dir(dir).into_iter().flatten().flatten()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fab-new-projects-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  /// Write each file, at its relative path, under `dir`.
  fn write(dir: &Path, files: &[(&str, &str)]) {
    for (file, text) in files {
      let path = under(dir, file);
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      std::fs::write(path, text).unwrap();
    }
  }

  const FRONTEND: &str = r#"{"name":"@rayfin-app/frontend","dependencies":{"react":"^19.2.7"}}"#;

  /// A Universal App named `name`, as the scaffolder leaves it: no packages yet.
  fn scaffold(dir: &Path, name: &str) {
    let root = format!(
      r#"{{"name":"{name}","private":true,"workspaces":["packages/*"],"devDependencies":{{"@microsoft/rayfin-cli":"~1.36.0"}}}}"#
    );
    write(
      dir,
      &[
        ("package.json", &root),
        ("packages/data/package.json", r#"{"name":"@rayfin-app/data","dependencies":{"@types/node":"^20.4.2"}}"#),
        ("packages/frontend/package.json", FRONTEND),
        ("README.md", "# A Rayfin app"),
      ],
    );
  }

  /// Link `link` to the folder `target` the way npm links a workspace: a
  /// junction on Windows, a symlink elsewhere.
  fn link_folder(target: &Path, link: &Path) {
    #[cfg(windows)]
    let linked = std::process::Command::new("cmd")
      .args(["/C", "mklink", "/J"])
      .arg(link)
      .arg(target)
      .output()
      .is_ok_and(|out| out.status.success());
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(target, link).is_ok();
    assert!(linked, "couldn't link {}", link.display());
  }

  /// A recipe for `project`, from a lockfile as npm would write it.
  fn recipe(cache: &Cache, project: &Path) -> Key {
    write(project, &[(LOCKFILE, r#"{"name":"notes","lockfileVersion":3}"#)]);
    let key = key(project, "1.36.2", "v24.13.0").unwrap();
    cache.remember(&key, project).unwrap();
    std::fs::remove_file(project.join(LOCKFILE)).unwrap();
    key
  }

  /// A spare for `key`, its recipe installed: packages at the root and in a
  /// workspace, and links to the spare's workspaces.
  fn set_aside(cache: &Cache, key: &Key) -> PathBuf {
    let spare = cache.spare(key);
    copy_tree(&cache.recipe(key), &spare).unwrap();
    write(
      &spare,
      &[
        ("node_modules/react/package.json", "{}"),
        ("node_modules/.package-lock.json", "{}"),
        ("packages/data/node_modules/@types/node/package.json", "{}"),
      ],
    );
    std::fs::create_dir_all(under(&spare, "node_modules/@rayfin-app")).unwrap();
    link_folder(&under(&spare, "packages/data"), &under(&spare, "node_modules/@rayfin-app/data"));
    spare
  }

  #[test]
  fn projects_that_install_the_same_packages_share_a_key() {
    let (notes, trips) = (scratch("key-notes"), scratch("key-trips"));
    scaffold(&notes, "notes");
    let shared = key(&notes, "1.36.2", "v24.13.0").unwrap();

    // Another name, formatted differently, installs the same packages.
    scaffold(&trips, "trip-logger");
    let root: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(trips.join("package.json")).unwrap()).unwrap();
    std::fs::write(trips.join("package.json"), serde_json::to_string_pretty(&root).unwrap()).unwrap();
    assert_eq!(key(&trips, "1.36.2", "v24.13.0").as_ref(), Some(&shared));

    // Another release, Node or workspace dependency doesn't.
    assert_ne!(key(&trips, "1.36.3", "v24.13.0").as_ref(), Some(&shared));
    assert_ne!(key(&trips, "1.36.2", "v22.11.0").as_ref(), Some(&shared));
    write(&trips, &[("packages/frontend/package.json", r#"{"name":"@rayfin-app/frontend","dependencies":{"react":"^19.2.8"}}"#)]);
    assert_ne!(key(&trips, "1.36.2", "v24.13.0").as_ref(), Some(&shared));

    // Nor does another workspace, or npm settings.
    write(&trips, &[("packages/frontend/package.json", FRONTEND), ("packages/api/package.json", r#"{"name":"api"}"#)]);
    assert_ne!(key(&trips, "1.36.2", "v24.13.0").as_ref(), Some(&shared));
    std::fs::remove_dir_all(under(&trips, "packages/api")).unwrap();
    assert_eq!(key(&trips, "1.36.2", "v24.13.0").as_ref(), Some(&shared));
    write(&trips, &[(".npmrc", "legacy-peer-deps=true\n")]);
    assert_ne!(key(&trips, "1.36.2", "v24.13.0").as_ref(), Some(&shared));

    let _ = std::fs::remove_dir_all(&notes);
    let _ = std::fs::remove_dir_all(&trips);
  }

  #[test]
  fn a_recipe_holds_what_npm_installs_from_for_a_week() {
    let (root, project) = (scratch("recipe-cache"), scratch("recipe-project"));
    let cache = Cache { root: root.clone() };
    scaffold(&project, "notes");
    assert_eq!(cache.lockfile(&key(&project, "1.36.2", "v24.13.0").unwrap()), None);

    let key = recipe(&cache, &project);
    let lockfile = cache.lockfile(&key).expect("a new recipe is used");
    assert_eq!(std::fs::read_to_string(&lockfile).unwrap(), r#"{"name":"notes","lockfileVersion":3}"#);
    for file in ["package.json", "packages/data/package.json", "packages/frontend/package.json"] {
      assert!(under(&cache.recipe(&key), file).is_file(), "{file}");
    }
    assert!(!cache.recipe(&key).join("README.md").exists());

    let week_ago = SystemTime::now() - RECIPE_LIFETIME - Duration::from_secs(60);
    std::fs::File::options().write(true).open(&lockfile).unwrap().set_modified(week_ago).unwrap();
    assert_eq!(cache.lockfile(&key), None);

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&project);
  }

  #[test]
  fn a_new_project_takes_the_spare_packages() {
    let (root, notes, trips, kept) = (scratch("take-cache"), scratch("take-notes"), scratch("take-trips"), scratch("take-kept"));
    let cache = Cache { root: root.clone() };
    scaffold(&notes, "notes");
    let key = recipe(&cache, &notes);
    let spare = set_aside(&cache, &key);
    write(&kept, &[("package.json", "{}")]);
    link_folder(&kept, &under(&spare, "node_modules/@rayfin-app/kept"));

    scaffold(&trips, "trip-logger");
    assert!(cache.take_spare_now(&key, &trips));
    assert!(under(&trips, "node_modules/react/package.json").is_file());
    assert!(under(&trips, "packages/data/node_modules/@types/node/package.json").is_file());
    assert_eq!(
      std::fs::read_to_string(trips.join(LOCKFILE)).unwrap(),
      r#"{"name":"notes","lockfileVersion":3}"#,
      "npm names the project in it"
    );
    // The links into the spare are gone, for npm to make again, and only the links.
    for link in ["data", "kept"] {
      assert!(std::fs::symlink_metadata(under(&trips, &format!("node_modules/@rayfin-app/{link}"))).is_err(), "{link}");
    }
    assert!(kept.join("package.json").is_file());
    assert!(under(&trips, "packages/data/package.json").is_file());

    // It's used up.
    assert!(!spare.exists());
    let other = scratch("take-other");
    scaffold(&other, "other");
    assert!(!cache.take_spare_now(&key, &other));

    for dir in [root, notes, trips, kept, other] {
      let _ = std::fs::remove_dir_all(dir);
    }
  }

  #[test]
  fn a_spare_is_taken_only_into_a_project_without_packages_and_from_the_current_recipe() {
    let (root, notes, trips) = (scratch("keep-cache"), scratch("keep-notes"), scratch("keep-trips"));
    let cache = Cache { root: root.clone() };
    scaffold(&notes, "notes");
    let key = recipe(&cache, &notes);
    let spare = set_aside(&cache, &key);

    // A workspace with packages of its own already.
    scaffold(&trips, "trip-logger");
    write(&trips, &[("packages/data/node_modules/left/package.json", "{}")]);
    assert!(!cache.take_spare_now(&key, &trips));
    assert!(under(&spare, "node_modules/react/package.json").is_file(), "the spare stays whole");
    assert!(under(&spare, "packages/data/node_modules/@types/node/package.json").is_file());
    assert!(!trips.join("node_modules").exists());
    std::fs::remove_dir_all(under(&trips, "packages/data/node_modules")).unwrap();

    // A spare that lost its packages isn't ready, so the next one replaces it.
    std::fs::rename(spare.join("node_modules"), root.join("aside")).unwrap();
    assert!(!cache.spare_ready(&key));
    assert!(!cache.take_spare_now(&key, &trips));
    std::fs::rename(root.join("aside"), spare.join("node_modules")).unwrap();

    // A recipe that changed since the spare was installed.
    write(&cache.recipe(&key), &[(LOCKFILE, r#"{"name":"notes","lockfileVersion":3,"requires":true}"#)]);
    assert!(!cache.take_spare_now(&key, &trips));
    assert!(spare.exists());

    for dir in [root, notes, trips] {
      let _ = std::fs::remove_dir_all(dir);
    }
  }

  #[test]
  fn startup_deletes_expired_recipes_and_what_stopped_part_way() {
    let (root, notes) = (scratch("clean-cache"), scratch("clean-notes"));
    let cache = Cache { root: root.clone() };
    scaffold(&notes, "notes");
    let fresh = recipe(&cache, &notes);
    set_aside(&cache, &fresh);
    // Another key's recipe, past its week, and its spare.
    let expired = Key("0123456789abcdef0123".into());
    copy_tree(&cache.recipe(&fresh), &cache.recipe(&expired)).unwrap();
    let week_ago = SystemTime::now() - RECIPE_LIFETIME - Duration::from_secs(60);
    let lockfile = cache.recipe(&expired).join(LOCKFILE);
    std::fs::File::options().write(true).open(lockfile).unwrap().set_modified(week_ago).unwrap();
    std::fs::create_dir_all(cache.spare(&expired).join("node_modules")).unwrap();
    // An install that stopped part way, and a delete that didn't finish.
    let stopped = cache.entry(&fresh).join("building-1a2b3c4d");
    std::fs::create_dir_all(stopped.join("node_modules")).unwrap();
    std::fs::create_dir_all(root.join("trash-5e6f7a8b").join("node_modules")).unwrap();

    // What changed lately may be another running Fabricator's.
    cache.clean_up(Duration::from_secs(60 * 60));
    assert!(!root.join("trash-5e6f7a8b").exists());
    assert!(stopped.exists());
    assert!(cache.entry(&expired).exists());

    cache.clean_up(Duration::ZERO);
    assert!(!stopped.exists());
    assert!(!cache.entry(&expired).exists());
    assert!(cache.spare_ready(&fresh), "a recipe in its week stays, with its spare");

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&notes);
  }

  /// Creates three projects with the Rayfin scaffolder and npm, as New project
  /// does, and checks how each one installed: the first works its versions out
  /// and has a spare set aside a minute later, the second takes the spare, and
  /// the third, before the next spare is set aside, installs the recorded
  /// versions. Opt in, with an empty scratch folder for app data, where a debug
  /// build keeps the cache:
  /// `FABRICATOR_DEV_DATA_DIR=<empty folder> cargo test --lib new_projects_install_from_the_cache -- --ignored --nocapture`
  #[tokio::test(flavor = "multi_thread")]
  #[ignore = "needs npm and the network, and installs three projects"]
  async fn new_projects_install_from_the_cache() {
    use crate::commands::projects_impl::{scaffold_project, scaffold_request};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    if std::env::var_os("FABRICATOR_DEV_DATA_DIR").is_none() {
      eprintln!("Set FABRICATOR_DEV_DATA_DIR to an empty scratch folder to run this.");
      return;
    }
    let root = scratch("live");
    let release = rayfin_sdk::new_project_sdk(&root).await.version.to_string();
    let said = Arc::new(Mutex::new(String::new()));
    let on: OnData = {
      let said = said.clone();
      Arc::new(move |_, text: &str| said.lock().unwrap().push_str(text))
    };
    let create = |name: &'static str| {
      let (root, on, said) = (root.clone(), on.clone(), said.clone());
      async move {
        said.lock().unwrap().clear();
        let input = crate::types::CreateProjectInput { name: name.into(), template: String::new(), template_name: None };
        let request = scaffold_request(&input).unwrap();
        let began = Instant::now();
        let dir = scaffold_project(&root, &request.slug, &request, &on).await.unwrap();
        eprintln!("[cache] {name}: created in {:.1} s", began.elapsed().as_secs_f32());
        let said = said.lock().unwrap().clone();
        // Installed, named, and linked to its own workspaces.
        assert!(exec::project_rayfin_cli_installed(&dir), "{said}");
        let lock: serde_json::Value =
          serde_json::from_str(&std::fs::read_to_string(dir.join(LOCKFILE)).unwrap()).unwrap();
        assert_eq!(lock["name"], request.slug.as_str());
        assert_eq!(lock["packages"][""]["name"], request.slug.as_str());
        let link = std::fs::canonicalize(under(&dir, "node_modules/@rayfin-app/frontend")).unwrap();
        assert_eq!(link, std::fs::canonicalize(under(&dir, "packages/frontend")).unwrap());
        (dir, said)
      }
    };

    let (first, said) = create("First").await;
    assert!(said.contains(FROM_REGISTRY), "{said}");
    let (cache, key) = (Cache::default(), Key::of(&first, &release).await.unwrap());
    let began = Instant::now();
    while !cache.spare_ready(&key) {
      assert!(began.elapsed() < SPARE_DELAY + Duration::from_secs(300), "no spare was set aside");
      tokio::time::sleep(Duration::from_secs(2)).await;
    }
    eprintln!("[cache] spare set aside {:.0} s after the first project", began.elapsed().as_secs_f32());

    let (_, said) = create("Second").await;
    assert!(said.contains("set aside for new projects"), "{said}");
    let (_, said) = create("Third").await;
    assert!(said.contains(&format!("at the versions recorded for Rayfin {release}")), "{said}");

    let _ = std::fs::remove_dir_all(&root);
  }
}
