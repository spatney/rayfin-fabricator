//! Exporting a project as a `.fabricator` file someone else imports to carry on
//! in Fabricator, and importing one.
//!
//! An export is a .zip with an extension of its own. It holds the app's files as
//! its version history sees them, what git tracks or would add, so installed
//! packages, build output and local settings stay out. As the person exporting
//! chooses, it also holds the history itself (`.git`) and the record of where the
//! app is published (`rayfin/.deployments.json`, which `rayfin up` reads, so the
//! recipient's publishes update the same app). Files that may hold secrets, the
//! app's data on this computer (`.rayfin-local`) and Fabricator's working files
//! never go in, whatever `.gitignore` says, and the history loses credentials,
//! hooks and the sender's git identity on the way. Who exported it, and where it's
//! published, is in `.fabricator/export.json`, which only Fabricator reads.
//!
//! Importing shows what a file brings in first ([`projects_import_inspect`]), then
//! unpacks it into a new folder in the projects folder and opens it. A folder
//! unpacked by hand gets the same when Open folder first opens it ([`adopt`]).
//!
//! The installer has the system open `.fabricator` files with Fabricator
//! (`bundle > fileAssociations` in tauri.conf.json; their icon comes from
//! `Info.plist` on macOS and `windows/installer-hooks.nsh` on Windows), and
//! [`queue_opened`] holds the files it's handed until the workbench imports them.

use std::collections::{BTreeSet, HashMap};
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::commands::projects_impl::register_project;
use crate::commands::util::{annotate_project, is_rayfin_project, normalize, now_iso, same_path, slugify};
use crate::services::exec::RunOptions;
use crate::services::journal::{self, Area, Level};
use crate::services::{emit, git, store, version_history};
use crate::state::AppState;
use crate::types::{
  ExportDeployment, ExportHistory, ExportOptions, ExportPreview, ExportResult, ImportPreview, ImportResult,
  StudioProject, ZipProgressEvent,
};

/// The extension of an exported project.
pub(crate) const EXTENSION: &str = "fabricator";
/// What only Fabricator reads, relative to the app.
const MANIFEST: &str = ".fabricator/export.json";
/// Where `rayfin up` records where the app is published.
const REGISTRY: &str = "rayfin/.deployments.json";
/// The export format this Fabricator writes.
const FORMAT: u32 = 1;
/// The progress id while a file imports: it has no project yet.
const IMPORTING: &str = "import";
const PROGRESS_EVERY: Duration = Duration::from_millis(90);
/// Importing stops past these, so a damaged or hostile file can't fill the disk.
const MAX_UNPACKED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 500_000;
/// The most read of an export's record, `rayfin.yml` or publishing record before it's unpacked.
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;

const TEAM_APP: &str = "A team app is shared through its team workspace. Invite people to the workspace instead.";
const MISSING: &str = "Fabricator can’t find this project’s folder.";
const UNREADABLE: &str =
  "Fabricator can’t read this file. Import a .fabricator file someone exported, or a .zip of a Rayfin project.";
const NOT_AN_APP: &str = "This file doesn’t hold a Rayfin project: there’s no rayfin/rayfin.yml in it.";
const MANY_APPS: &str =
  "This file holds more than one Rayfin project. Unzip it, then open the one you want with Open folder.";
const TOO_BIG: &str = "This file unpacks to more than 16 GB, so Fabricator didn’t import it.";
const TOO_MANY: &str = "This file holds more than 500,000 files, so Fabricator didn’t import it.";

/// Folders that never go in, at any depth: installed packages, git data (the
/// history goes in only as the person exporting chooses), and what belongs to
/// this computer: the app's local data and keys, and Rayfin's and Fabricator's
/// working files.
const NEVER_FOLDERS: &[&str] = &["node_modules", ".git", ".rayfin-local", ".micro-fabric", ".rayfin", ".fabricator"];

/// What an app git doesn't track leaves out too, as a new version history
/// would: environments, build output and caches.
const UNTRACKED_FOLDERS: &[&str] = &[
  "bower_components",
  "jspm_packages",
  ".pnpm-store",
  ".venv",
  "__pycache__",
  "dist",
  "dist-ssr",
  ".vite",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".next",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".playwright-cli",
  ".playwright-mcp",
  ".idea",
];
/// Output only at the top of the app; deeper down they can be source folders.
const UNTRACKED_TOP_FOLDERS: &[&str] = &["coverage", "test-results", "playwright-report"];

/// Already compressed: stored as they are, which is as small and much faster.
const COMPRESSED: &[&str] = &[
  "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "mp3", "mp4", "m4a", "mov", "webm", "ogg", "woff", "woff2", "zip",
  "gz", "tgz", "bz2", "xz", "7z", "zst", "br", "jar", "docx", "xlsx", "pptx",
];

/// A sign-in in a URL: `https://user:token@host/…`.
static URL_CREDENTIALS: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)\b(https?://)[^/@\s"']+@"#).unwrap());
static YAML_NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^name:\s*(.+)$").unwrap());

/// Exports being written, by project, with the flag that stops them.
static PACKING: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> = Lazy::new(Default::default);

/// Exports the system asked Fabricator to open, waiting for the workbench to import them.
static OPENED: Lazy<Mutex<Vec<String>>> = Lazy::new(Default::default);

/// What an export records for Fabricator (`.fabricator/export.json`).
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
  #[serde(default)]
  pub format: u32,
  #[serde(default)]
  pub name: String,
  /// Who exported it: their Fabric account.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub from: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub created_at: Option<String>,
  /// The Fabricator version that exported it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub fabricator: Option<String>,
  #[serde(default)]
  pub history: bool,
  #[serde(default)]
  pub deployment: bool,
  /// The workspace its publishes go to, when `deployment`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workspace: Option<String>,
  /// The names the sender gave its deployments.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub deployment_names: Option<HashMap<String, String>>,
}

/* ------------------------------ what goes in ------------------------------ */

/// Never in an export, and not worth a mention: this computer's files, other
/// exports, and what the export adds only when chosen.
fn never(rel: &str) -> bool {
  let parts: Vec<&str> = rel.split('/').collect();
  let Some((name, folders)) = parts.split_last() else {
    return true;
  };
  let lower = name.to_ascii_lowercase();
  folders.iter().any(|f| NEVER_FOLDERS.contains(f))
    || rel == REGISTRY
    // Rayfin's environment for this computer, its secrets included, and its scratch files.
    || rel.starts_with("rayfin/.env")
    || rel.starts_with("rayfin/.temp/")
    || (folders == ["rayfin"] && name.starts_with('.') && name.ends_with(".tmp"))
    || *name == "rayfin.config.json"
    // An export saved in the app's own folder.
    || lower.ends_with(".fabricator")
    || lower.ends_with(".fabricator.partial")
}

/// May hold a secret: environment files (not their examples), local settings,
/// keys and certificates.
fn may_hold_secret(rel: &str) -> bool {
  let name = file_name(rel).to_ascii_lowercase();
  let env = name == ".env"
    || (name.starts_with(".env.") && !matches!(name.as_str(), ".env.example" | ".env.sample" | ".env.template"));
  env
    || name.ends_with(".local")
    || name == "local.settings.json"
    || [".pem", ".key", ".pfx", ".p12"].iter().any(|ext| name.ends_with(ext))
}

fn file_name(rel: &str) -> &str {
  rel.rsplit('/').next().unwrap_or(rel)
}

fn compressed(rel: &str) -> bool {
  rel.starts_with(".git/objects/")
    || rel
      .rsplit_once('.')
      .is_some_and(|(_, ext)| COMPRESSED.iter().any(|c| c.eq_ignore_ascii_case(ext)))
}

/// What a file in the export is made from.
enum Source {
  Disk(PathBuf),
  Text(Vec<u8>),
}

struct Item {
  /// Its path in the export.
  name: String,
  source: Source,
  size: u64,
  modified: Option<SystemTime>,
  /// A folder. Only `.git` lists its own: git needs `refs` even when it's empty.
  folder: bool,
}

impl Item {
  fn text(name: impl Into<String>, bytes: Vec<u8>) -> Self {
    Item { name: name.into(), size: bytes.len() as u64, source: Source::Text(bytes), modified: None, folder: false }
  }

  fn disk(name: impl Into<String>, path: PathBuf, meta: &std::fs::Metadata) -> Self {
    Item { name: name.into(), size: meta.len(), modified: meta.modified().ok(), source: Source::Disk(path), folder: false }
  }

  fn folder(name: impl Into<String>) -> Self {
    Item { name: name.into(), size: 0, modified: None, source: Source::Text(Vec::new()), folder: true }
  }
}

fn skip_untracked_folder(rel: &str, name: &str, path: &Path) -> bool {
  NEVER_FOLDERS.contains(&name)
    || UNTRACKED_FOLDERS.contains(&name)
    || (!rel.contains('/') && UNTRACKED_TOP_FOLDERS.contains(&name))
    || rel == "rayfin/.temp"
    || path.join("pyvenv.cfg").is_file()
    || path.join(".git").exists()
}

fn skip_untracked_file(name: &str) -> bool {
  let lower = name.to_ascii_lowercase();
  [".log", ".tsbuildinfo", ".pyc", ".pyo", ".pyd"].iter().any(|ext| lower.ends_with(ext))
    || matches!(lower.as_str(), ".ds_store" | "thumbs.db" | "desktop.ini")
}

/// The app's files when git doesn't track it: what a new version history would take.
fn walk(dir: &Path) -> Vec<String> {
  let mut out = Vec::new();
  let mut stack = vec![(dir.to_path_buf(), String::new())];
  while let Some((folder, prefix)) = stack.pop() {
    let Ok(entries) = std::fs::read_dir(&folder) else {
      continue;
    };
    for entry in entries.flatten() {
      let name = entry.file_name().to_string_lossy().to_string();
      let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
      let Ok(kind) = entry.file_type() else {
        continue;
      };
      if kind.is_dir() {
        if !skip_untracked_folder(&rel, &name, &entry.path()) {
          stack.push((entry.path(), rel));
        }
      } else if kind.is_file() && !skip_untracked_file(&name) {
        out.push(rel);
      }
    }
  }
  out.sort();
  out
}

/// The app's files, relative to its folder with `/` separators: what git
/// tracks or would add, or what a new version history would take when git
/// doesn't track the folder.
async fn app_files(dir: &Path) -> Vec<String> {
  if version_history::is_tracked(dir) {
    let listed = git::run(
      &["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      RunOptions { cwd: Some(dir.to_path_buf()), timeout_ms: Some(120_000), ..Default::default() },
    )
    .await;
    if listed.ok {
      // Paths with unmerged changes are listed once per side.
      let unique: BTreeSet<&str> = listed.stdout.split('\0').filter(|p| !p.is_empty() && !p.ends_with('/')).collect();
      return unique.into_iter().map(String::from).collect();
    }
    log::warn!("Couldn't list {} with git, so its folder is read instead: {}", dir.display(), listed.stderr.trim());
  }
  let dir = dir.to_path_buf();
  tokio::task::spawn_blocking(move || walk(&dir)).await.unwrap_or_default()
}

/// The project has a repository of its own (not one it shares with a folder above it).
fn has_own_history(dir: &Path) -> bool {
  dir.join(".git").is_dir()
}

async fn count_versions(dir: &Path) -> u32 {
  let res = git::run(
    &["rev-list", "--count", "HEAD"],
    RunOptions { cwd: Some(dir.to_path_buf()), timeout_ms: Some(30_000), ..Default::default() },
  )
  .await;
  res.stdout.trim().parse().unwrap_or(0)
}

/// The app's own files from `listed`, and the ones kept out because they may
/// hold secrets. `skip` is the file being written, should it be saved in the app.
fn code_items(dir: &Path, listed: &[String], skip: Option<&Path>) -> (Vec<Item>, Vec<String>) {
  let skip = skip.map(|s| s.to_string_lossy().to_string());
  let mut items = Vec::new();
  let mut kept_out = Vec::new();
  for rel in listed {
    if never(rel) {
      continue;
    }
    let path = dir.join(rel);
    if skip.as_deref().is_some_and(|s| same_path(&path.to_string_lossy(), s)) {
      continue;
    }
    if may_hold_secret(rel) || (file_name(rel) == ".npmrc" && version_history::holds_registry_token(&path)) {
      kept_out.push(rel.clone());
      continue;
    }
    // Gone since git listed it, or a link.
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
      continue;
    };
    if meta.is_file() {
      items.push(Item::disk(rel.as_str(), path, &meta));
    }
  }
  (items, kept_out)
}

/// Left out of the history: locks, and what only this computer's git uses.
fn skip_in_history(name: &str) -> bool {
  name.ends_with(".lock") || name == "FETCH_HEAD" || name.starts_with("fsmonitor--daemon") || name == "gc.pid"
}

/// `text` without the sign-ins in its URLs.
fn scrub_credentials(text: &str) -> String {
  URL_CREDENTIALS.replace_all(text, "$1").into_owned()
}

/// A repository's settings without what belongs to the sender: their identity
/// (the recipient commits as themselves), and sign-ins, in URLs or in the
/// headers a CI checkout leaves.
fn scrub_config(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  let mut in_user = false;
  for line in text.lines() {
    let trimmed = line.trim_start();
    if let Some(header) = trimmed.strip_prefix('[') {
      let section = header.trim_start().split(|c: char| c == ']' || c == '"' || c.is_whitespace()).next().unwrap_or("");
      in_user = section.eq_ignore_ascii_case("user");
      if in_user {
        continue;
      }
    } else if in_user {
      continue;
    } else {
      let key = trimmed.split('=').next().unwrap_or("").trim();
      if key.eq_ignore_ascii_case("extraheader") {
        continue;
      }
    }
    out.push_str(line);
    out.push('\n');
  }
  scrub_credentials(&out)
}

/// The recipient's git ignores the export's record of itself, should they unzip
/// it by hand.
fn with_import_exclusions(exclude: &str) -> String {
  let has = exclude.lines().any(|l| matches!(l.trim(), ".fabricator/" | ".fabricator" | "/.fabricator/" | "/.fabricator"));
  if has {
    return exclude.to_string();
  }
  let mut next = exclude.to_string();
  if !next.is_empty() && !next.ends_with('\n') {
    next.push('\n');
  }
  next.push_str("\n# Added by Fabricator to an export: the files Fabricator reads when it imports the app\n.fabricator/\n");
  next
}

/// The version history: the app's `.git` folder, without its hooks, locks or
/// other worktrees, with sign-ins and the sender's identity taken out of its
/// settings and logs, and ignoring the export's record of itself.
fn history_items(dir: &Path) -> Vec<Item> {
  let mut items = Vec::new();
  let mut has_exclude = false;
  let mut stack = vec![(dir.join(".git"), ".git".to_string())];
  while let Some((folder, prefix)) = stack.pop() {
    items.push(Item::folder(prefix.as_str()));
    let Ok(entries) = std::fs::read_dir(&folder) else {
      continue;
    };
    for entry in entries.flatten() {
      let name = entry.file_name().to_string_lossy().to_string();
      let rel = format!("{prefix}/{name}");
      let Ok(kind) = entry.file_type() else {
        continue;
      };
      if kind.is_dir() {
        if !matches!(rel.as_str(), ".git/hooks" | ".git/worktrees") {
          stack.push((entry.path(), rel));
        }
        continue;
      }
      if !kind.is_file() || skip_in_history(&name) {
        continue;
      }
      let path = entry.path();
      let Ok(meta) = entry.metadata() else {
        continue;
      };
      let rewrite = |change: fn(&str) -> String| -> Option<Vec<u8>> {
        let bytes = std::fs::read(&path).ok()?;
        String::from_utf8(bytes).ok().map(|text| change(&text).into_bytes())
      };
      let rewritten = if rel == ".git/info/exclude" {
        has_exclude = true;
        rewrite(with_import_exclusions)
      } else if name == "config" {
        rewrite(scrub_config)
      } else if rel.starts_with(".git/logs/") {
        rewrite(scrub_credentials)
      } else {
        None
      };
      items.push(match rewritten {
        Some(bytes) => Item { modified: meta.modified().ok(), ..Item::text(rel, bytes) },
        None => Item::disk(rel, path, &meta),
      });
    }
  }
  if !has_exclude {
    items.push(Item::text(".git/info/exclude", with_import_exclusions("").into_bytes()));
  }
  items
}

/// Where the app is published, as `rayfin up` records it: its active
/// deployment, or the first it records.
fn published(dir: &Path) -> Option<ExportDeployment> {
  if let Some(Some(active)) = crate::commands::deploy::registry_active(dir) {
    return Some(ExportDeployment {
      workspace: active.workspace_name,
      workspace_id: active.workspace_id,
      url: active.hosting,
      portal_url: active.portal,
    });
  }
  let first = crate::commands::deploy::recorded_deployments(dir).into_iter().next()?;
  Some(ExportDeployment {
    workspace: first.workspace_name,
    workspace_id: first.workspace_id,
    url: first.hosting_url,
    portal_url: None,
  })
}

/// Who's exporting the app: the Fabric account in use.
fn sender() -> Option<String> {
  crate::services::fabric_accounts::list()
    .into_iter()
    .find(|a| a.active)
    .map(|a| a.user)
    .or_else(|| crate::commands::auth::get_cached_identity().and_then(|i| i.email))
    .filter(|user| user.contains('@'))
}

/// What an export records about itself.
struct Facts {
  name: String,
  from: Option<String>,
  created_at: String,
  fabricator: String,
  published: Option<ExportDeployment>,
  deployment_names: Option<HashMap<String, String>>,
}

/// Everything an export holds, in the order it's written.
struct Plan {
  items: Vec<Item>,
  /// How many of the app's own files it holds.
  files: u64,
}

fn plan(dir: &Path, listed: &[String], choice: ExportOptions, facts: &Facts, skip: Option<&Path>) -> Plan {
  let (mut items, _kept_out) = code_items(dir, listed, skip);
  let files = items.len() as u64;
  let registry = std::fs::symlink_metadata(dir.join(REGISTRY)).ok().filter(|m| m.is_file());
  let deployment = choice.deployment && facts.published.is_some() && registry.is_some();
  let manifest = Manifest {
    format: FORMAT,
    name: facts.name.clone(),
    from: facts.from.clone(),
    created_at: Some(facts.created_at.clone()),
    fabricator: Some(facts.fabricator.clone()),
    history: choice.history && has_own_history(dir),
    deployment,
    workspace: facts.published.as_ref().filter(|_| deployment).map(|p| p.workspace.clone()),
    deployment_names: facts.deployment_names.clone().filter(|names| deployment && !names.is_empty()),
  };

  if let Some(meta) = registry.filter(|_| deployment) {
    items.push(Item::disk(REGISTRY, dir.join(REGISTRY), &meta));
  }
  if manifest.history {
    items.extend(history_items(dir));
  }
  items.push(Item::text(MANIFEST, serde_json::to_vec_pretty(&manifest).unwrap_or_default()));
  Plan { items, files }
}

/* -------------------------------- packing -------------------------------- */

enum PackError {
  Stopped,
  Failed(String),
}

/// A file's time as a .zip records it: local, to two seconds, from 1980.
fn zip_time(modified: Option<SystemTime>) -> zip::DateTime {
  use chrono::{Datelike, Timelike};
  let local: chrono::DateTime<chrono::Local> = modified.unwrap_or_else(SystemTime::now).into();
  u16::try_from(local.year())
    .ok()
    .and_then(|year| {
      zip::DateTime::from_date_and_time(
        year,
        local.month() as u8,
        local.day() as u8,
        local.hour() as u8,
        local.minute() as u8,
        local.second() as u8,
      )
      .ok()
    })
    .unwrap_or_default()
}

/// Where the export is written until it's complete, so a failed or stopped
/// export never leaves a broken file behind.
fn partial_path(dest: &Path) -> PathBuf {
  let name = dest
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| format!("export.{EXTENSION}"));
  dest.with_file_name(format!("{name}.partial"))
}

/// Write `items` to the export at `dest`. Returns its size.
fn write_zip(dest: &Path, items: &[Item], stop: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<u64, PackError> {
  let partial = partial_path(dest);
  let failed = |what: String| PackError::Failed(what);
  let written = (|| {
    let file = File::create(&partial).map_err(|e| failed(format!("Couldn’t save {}: {e}", dest.display())))?;
    let mut writer = zip::ZipWriter::new(BufWriter::with_capacity(1 << 20, file));
    let total = items.iter().filter(|i| !i.folder).count() as u64;
    let mut done = 0u64;
    let mut shown = Instant::now();
    progress(0, total);
    for item in items {
      if stop.load(Ordering::Relaxed) {
        return Err(PackError::Stopped);
      }
      let options = SimpleFileOptions::default()
        .compression_method(if compressed(&item.name) { CompressionMethod::Stored } else { CompressionMethod::Deflated })
        .last_modified_time(zip_time(item.modified))
        .large_file(item.size >= zip::ZIP64_BYTES_THR);
      let not_added = |e: &dyn std::fmt::Display| failed(format!("Couldn’t add {}: {e}", item.name));
      if item.folder {
        writer.add_directory(item.name.as_str(), options).map_err(|e| not_added(&e))?;
        continue;
      }
      writer.start_file(item.name.as_str(), options).map_err(|e| not_added(&e))?;
      let added = match &item.source {
        Source::Text(bytes) => writer.write_all(bytes),
        Source::Disk(path) => File::open(path).and_then(|mut f| std::io::copy(&mut f, &mut writer).map(|_| ())),
      };
      added.map_err(|e| not_added(&e))?;
      done += 1;
      if done == total || shown.elapsed() >= PROGRESS_EVERY {
        shown = Instant::now();
        progress(done, total);
      }
    }
    let mut out = writer.finish().map_err(|e| failed(format!("Couldn’t finish the file: {e}")))?;
    out.flush().map_err(|e| failed(format!("Couldn’t finish the file: {e}")))?;
    Ok(())
  })();
  if let Err(error) = written {
    let _ = std::fs::remove_file(&partial);
    return Err(error);
  }
  if let Err(e) = std::fs::rename(&partial, dest) {
    let _ = std::fs::remove_file(&partial);
    return Err(failed(format!("Couldn’t save {}: {e}", dest.display())));
  }
  Ok(std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0))
}

/// Marks a project as being exported until dropped, so Stop can find it.
struct Packing {
  id: String,
  stop: Arc<AtomicBool>,
}

impl Packing {
  fn start(id: &str) -> Self {
    let stop = Arc::new(AtomicBool::new(false));
    PACKING.lock().unwrap().insert(id.to_string(), stop.clone());
    Packing { id: id.to_string(), stop }
  }
}

impl Drop for Packing {
  fn drop(&mut self) {
    let mut packing = PACKING.lock().unwrap();
    if packing.get(&self.id).is_some_and(|stop| Arc::ptr_eq(stop, &self.stop)) {
      packing.remove(&self.id);
    }
  }
}

/* ------------------------------- importing ------------------------------- */

/// An entry's safe path, `/`-separated.
fn slash_path(path: &Path) -> String {
  path
    .components()
    .filter_map(|c| match c {
      Component::Normal(part) => Some(part.to_string_lossy().to_string()),
      _ => None,
    })
    .collect::<Vec<_>>()
    .join("/")
}

/// Where the app is in the file: at its top, or in the one folder at its top
/// that holds it, as a folder the OS zipped does.
fn app_prefix(files: &[&str]) -> Result<String, String> {
  if files.contains(&"rayfin/rayfin.yml") {
    return Ok(String::new());
  }
  let tops: Vec<&str> = files
    .iter()
    .filter_map(|name| name.strip_suffix("/rayfin/rayfin.yml"))
    .filter(|top| !top.contains('/') && *top != "__MACOSX")
    .collect();
  match tops.as_slice() {
    [one] => Ok(format!("{one}/")),
    [] => Err(NOT_AN_APP.into()),
    _ => Err(MANY_APPS.into()),
  }
}

/// Left behind when a file imports: installed packages (Fabricator installs
/// them again), git hooks (an export never has them; they'd run on the next
/// commit) and what macOS adds to the .zips it makes.
fn skip_on_open(rel: &str) -> bool {
  rel.split('/').any(|part| part == "node_modules")
    || rel == ".git/hooks"
    || rel.starts_with(".git/hooks/")
    || rel.starts_with("__MACOSX/")
    || file_name(rel) == ".DS_Store"
}

fn name_in_yaml(text: &str) -> Option<String> {
  let raw = YAML_NAME.captures(text)?.get(1)?.as_str().trim();
  Some(raw.trim_matches(['"', '\'']).trim().to_string()).filter(|n| !n.is_empty())
}

/// The workspace a publishing record says the app is published to.
fn recorded_workspace(registry: &str) -> Option<String> {
  let json: serde_json::Value = serde_json::from_str(registry).ok()?;
  let active = json.get("active")?.as_str()?.trim();
  json.get("deployments")?.get(active)?;
  Some(active.to_string()).filter(|a| !a.is_empty())
}

/// A small text file from the archive.
fn read_text<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>, index: usize) -> Option<String> {
  let entry = archive.by_index(index).ok()?;
  let mut text = String::new();
  entry.take(MAX_TEXT_BYTES).read_to_string(&mut text).ok()?;
  Some(text)
}

/// The first folder in `root` named `slug`, or `slug-2`, `slug-3`… that's free.
fn free_folder(root: &Path, slug: &str) -> Result<PathBuf, String> {
  (1..100)
    .map(|n| if n == 1 { root.join(slug) } else { root.join(format!("{slug}-{n}")) })
    .find(|path| !path.exists())
    .ok_or_else(|| format!("Your projects folder already has folders named {slug} to {slug}-99."))
}

/// One entry to unpack: where it is in the archive, its path in the app
/// (`/`-separated), whether it's a folder, and its size.
struct Entry {
  index: usize,
  path: String,
  folder: bool,
  size: u64,
}

/// What a file holds, read without unpacking it: an export, or any .zip of a
/// Rayfin project.
struct Contents {
  archive: zip::ZipArchive<BufReader<File>>,
  /// What to unpack. Links and anything that would land outside the app's
  /// folder are never among them.
  entries: Vec<Entry>,
  manifest: Option<Manifest>,
  rayfin_yml: Option<String>,
  registry: Option<String>,
}

fn read_contents(source: &Path) -> Result<Contents, String> {
  let file = File::open(source).map_err(|e| format!("Couldn’t open {}: {e}", source.display()))?;
  let mut archive = zip::ZipArchive::new(BufReader::new(file)).map_err(|_| UNREADABLE.to_string())?;
  if archive.len() > MAX_ENTRIES {
    return Err(TOO_MANY.into());
  }
  let mut all: Vec<Entry> = Vec::new();
  for index in 0..archive.len() {
    let Ok(entry) = archive.by_index_data(index) else {
      continue;
    };
    if entry.is_symlink() {
      continue;
    }
    let Some(path) = entry.enclosed_name() else {
      continue;
    };
    let path = slash_path(&path);
    if !path.is_empty() {
      all.push(Entry { index, path, folder: entry.is_dir(), size: entry.size() });
    }
  }
  let files: Vec<&str> = all.iter().filter(|e| !e.folder).map(|e| e.path.as_str()).collect();
  let prefix = app_prefix(&files)?;
  let entries: Vec<Entry> = all
    .into_iter()
    .filter_map(|entry| {
      let rel = entry.path.strip_prefix(prefix.as_str())?.to_string();
      (!rel.is_empty() && !skip_on_open(&rel)).then_some(Entry { path: rel, ..entry })
    })
    .collect();
  let find = |rel: &str| entries.iter().find(|e| !e.folder && e.path == rel).map(|e| e.index);
  let (manifest_at, yml_at, registry_at) = (find(MANIFEST), find("rayfin/rayfin.yml"), find(REGISTRY));
  let manifest = manifest_at.and_then(|i| read_text(&mut archive, i)).and_then(|text| serde_json::from_str(&text).ok());
  let rayfin_yml = yml_at.and_then(|i| read_text(&mut archive, i));
  let registry = registry_at.and_then(|i| read_text(&mut archive, i));
  Ok(Contents { archive, entries, manifest, rayfin_yml, registry })
}

impl Contents {
  /// The project's name: as the export records it, else as its `rayfin.yml`
  /// says, else the file's.
  fn name(&self, source: &Path) -> String {
    self
      .manifest
      .as_ref()
      .map(|m| m.name.trim().to_string())
      .filter(|n| !n.is_empty())
      .or_else(|| self.rayfin_yml.as_deref().and_then(name_in_yaml))
      .or_else(|| source.file_stem().map(|s| s.to_string_lossy().to_string()))
      .unwrap_or_default()
  }

  /// The folder it would be unpacked into.
  fn destination(&self, source: &Path, root: &Path) -> Result<PathBuf, String> {
    let name = self.name(source);
    let slug = Some(slugify(&name)).filter(|s| !s.is_empty()).unwrap_or_else(|| "app".into());
    free_folder(root, &slug)
  }
}

/// What importing `source` into `root` would bring in.
fn inspect(source: &Path, root: &Path) -> Result<ImportPreview, String> {
  let contents = read_contents(source)?;
  let manifest = contents.manifest.clone().unwrap_or_default();
  let own = contents.entries.iter().filter(|e| !e.folder && !e.path.starts_with(".git/") && e.path != MANIFEST);
  let (files, bytes) = own.fold((0u64, 0u64), |(n, size), e| (n + 1, size + e.size));
  Ok(ImportPreview {
    name: contents.name(source),
    from: manifest.from,
    exported_at: manifest.created_at,
    files,
    bytes,
    history: contents.entries.iter().any(|e| e.path == ".git/HEAD"),
    workspace: manifest.workspace.or_else(|| contents.registry.as_deref().and_then(recorded_workspace)),
    secrets: contents.rayfin_yml.as_deref().map(crate::commands::secrets::declared_names_in).unwrap_or_default(),
    folder: contents.destination(source, root)?.to_string_lossy().to_string(),
  })
}

/// Unpack the app in the file at `source` into a new folder in `root`, named
/// after it. On failure, nothing is left.
fn unpack(source: &Path, root: &Path, mut progress: impl FnMut(u64, u64)) -> Result<PathBuf, String> {
  let mut contents = read_contents(source)?;
  std::fs::create_dir_all(root).map_err(|e| format!("Couldn’t create your projects folder {}: {e}", root.display()))?;
  let target = contents.destination(source, root)?;
  std::fs::create_dir(&target).map_err(|e| format!("Couldn’t create {}: {e}", target.display()))?;

  let unpacked = (|| {
    let total = contents.entries.iter().filter(|e| !e.folder).count() as u64;
    let (mut done, mut written) = (0u64, 0u64);
    let mut shown = Instant::now();
    progress(0, total);
    for entry in &contents.entries {
      let out = entry.path.split('/').fold(target.clone(), |path, part| path.join(part));
      let create = |dir: &Path| std::fs::create_dir_all(dir).map_err(|e| format!("Couldn’t create {}: {e}", dir.display()));
      if entry.folder {
        create(&out)?;
        continue;
      }
      if let Some(parent) = out.parent() {
        create(parent)?;
      }
      let mut from = contents.archive.by_index(entry.index).map_err(|_| UNREADABLE.to_string())?;
      let mut file = File::create(&out).map_err(|e| format!("Couldn’t create {}: {e}", out.display()))?;
      let room = MAX_UNPACKED_BYTES - written;
      let copied = std::io::copy(&mut (&mut from).take(room + 1), &mut file)
        .map_err(|e| format!("Couldn’t unpack {}: {e}", entry.path))?;
      if copied > room {
        return Err(TOO_BIG.to_string());
      }
      written += copied;
      done += 1;
      if done == total || shown.elapsed() >= PROGRESS_EVERY {
        shown = Instant::now();
        progress(done, total);
      }
    }
    if !target.join("rayfin").join("rayfin.yml").is_file() {
      return Err(NOT_AN_APP.to_string());
    }
    Ok(())
  })();
  match unpacked {
    Ok(()) => Ok(target),
    Err(error) => {
      let _ = std::fs::remove_dir_all(&target);
      Err(error)
    }
  }
}

/// Take the export's record of itself out of `dir`, so it doesn't end up in the
/// app's history. `None` when the folder didn't come from an export.
fn take_manifest(dir: &Path) -> Option<Manifest> {
  let file = dir.join(MANIFEST);
  let manifest = serde_json::from_str::<Manifest>(&std::fs::read_to_string(&file).ok()?).ok()?;
  if let Err(e) = std::fs::remove_file(&file) {
    log::warn!("Couldn't remove {}: {e}", file.display());
  }
  let fabricator = dir.join(".fabricator");
  if std::fs::read_dir(&fabricator).is_ok_and(|mut rest| rest.next().is_none()) {
    let _ = std::fs::remove_dir(&fabricator);
  }
  Some(manifest)
}

/// Give a project just registered from a folder an export was unpacked into
/// what came with it: the names its deployments had. Returns the export's record.
pub(crate) fn adopt(dir: &Path, project_id: &str) -> Option<Manifest> {
  let manifest = take_manifest(dir)?;
  if let Some(names) = manifest.deployment_names.clone().filter(|n| !n.is_empty()) {
    store::mutate_project(project_id, |p| {
      if p.deployment_names.as_ref().is_none_or(|known| known.is_empty()) {
        p.deployment_names = Some(names);
      }
    });
  }
  let from = manifest.from.as_deref().map(|f| format!(", exported by {f}")).unwrap_or_default();
  journal::entry(Level::Info, Area::Project, "project.imported", &format!("Imported \"{}\"{from}.", manifest.name))
    .project(Some(project_id.to_string()))
    .write();
  Some(manifest)
}

/* --------------------------- opened by the system -------------------------- */

fn is_export(path: &Path) -> bool {
  path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case(EXTENSION))
}

/// The exports among a launch's arguments: `.fabricator` files that exist,
/// relative ones resolved against `cwd`.
pub(crate) fn exports_in<A: Into<OsString>>(args: impl IntoIterator<Item = A>, cwd: Option<&Path>) -> Vec<PathBuf> {
  args
    .into_iter()
    .map(|arg| PathBuf::from(arg.into()))
    .filter(|path| is_export(path))
    .map(|path| match cwd {
      Some(cwd) if path.is_relative() => cwd.join(path),
      _ => path,
    })
    .filter(|path| path.is_file())
    .collect()
}

/// Add `files` to those waiting to be imported. Returns whether any is new.
fn hold(files: Vec<PathBuf>) -> bool {
  let mut opened = OPENED.lock().unwrap();
  let before = opened.len();
  for file in files {
    let file = normalize(&file).to_string_lossy().to_string();
    if !opened.iter().any(|known| same_path(known, &file)) {
      opened.push(file);
    }
  }
  opened.len() > before
}

/// Hold exports the system asked Fabricator to open, from its command line, a
/// second launch or macOS, and tell the workbench, which imports them once it's
/// showing.
pub(crate) fn queue_opened(app: &AppHandle, files: Vec<PathBuf>) {
  if hold(files) {
    let _ = app.emit(emit::EXPORT_OPENED, ());
  }
}

/// The exports waiting to be imported. Each is returned once.
#[tauri::command]
pub fn projects_opened_exports() -> Vec<String> {
  std::mem::take(&mut *OPENED.lock().unwrap())
}

/* -------------------------------- commands -------------------------------- */

/// The project, when it can be exported from here.
fn exportable_project(id: &str) -> Result<StudioProject, String> {
  let project = store::find_project(id).ok_or("Project not found.")?;
  if project.team.is_some() {
    return Err(TEAM_APP.into());
  }
  if !is_rayfin_project(&project.path) {
    return Err(MISSING.into());
  }
  Ok(project)
}

fn emit_progress(app: &AppHandle, id: &str, phase: &str, processed: u64, total: u64) {
  let _ = app.emit(
    emit::ZIP_PROGRESS,
    ZipProgressEvent { id: id.to_string(), phase: phase.to_string(), processed, total },
  );
}

/// What exporting the project would put in its file, for the export dialog.
#[tauri::command]
pub async fn projects_export_preview(id: String) -> Result<ExportPreview, String> {
  let project = exportable_project(&id)?;
  let dir = PathBuf::from(&project.path);
  let listed = app_files(&dir).await;
  let versions = if has_own_history(&dir) { Some(count_versions(&dir).await) } else { None };
  tokio::task::spawn_blocking(move || {
    let (code, kept_out) = code_items(&dir, &listed, None);
    ExportPreview {
      files: code.len() as u64,
      bytes: code.iter().map(|i| i.size).sum(),
      history: versions.map(|versions| ExportHistory {
        versions,
        bytes: history_items(&dir).iter().map(|i| i.size).sum(),
      }),
      deployment: published(&dir),
      secrets: crate::commands::secrets::declared_names(&dir),
      kept_out,
    }
  })
  .await
  .map_err(|e| format!("Couldn’t look at the project: {e}"))
}

/// Ask where to save the project's export, then write it there. The project's
/// lease keeps chat turns and publishes from changing its files meanwhile;
/// progress streams on `zip:progress`.
#[tauri::command]
pub async fn projects_export(
  app: AppHandle,
  state: State<'_, AppState>,
  id: String,
  options: ExportOptions,
) -> Result<ExportResult, String> {
  let failed =
    |error: String| -> Result<ExportResult, String> { Ok(ExportResult { error: Some(error), ..Default::default() }) };
  let project = match exportable_project(&id) {
    Ok(project) => project,
    Err(error) => return failed(error),
  };
  let slug = Some(slugify(&project.name)).filter(|s| !s.is_empty()).unwrap_or_else(|| "app".into());
  let Some(dest) = pick_destination(&app, &format!("{slug}.{EXTENSION}")).await else {
    return Ok(ExportResult { cancelled: true, ..Default::default() });
  };
  let _lease = match state.mutations.export(&id) {
    Ok(lease) => lease,
    Err(error) => return failed(error),
  };

  let dir = PathBuf::from(&project.path);
  let project_name = project.name.clone();
  let listed = app_files(&dir).await;
  let (from, fabricator) = (sender(), app.package_info().version.to_string());
  let packing = Packing::start(&id);
  let stop = packing.stop.clone();
  let emitter = app.clone();
  let (project_id, target) = (id.clone(), dest.clone());
  let packed = tokio::task::spawn_blocking(move || {
    let facts = Facts {
      name: project.name.clone(),
      from,
      created_at: now_iso(),
      fabricator,
      published: published(&dir),
      deployment_names: project.deployment_names.clone(),
    };
    let plan = plan(&dir, &listed, options, &facts, Some(&target));
    let bytes = write_zip(&target, &plan.items, &stop, |processed, total| {
      emit_progress(&emitter, &project_id, "packing", processed, total)
    })?;
    Ok::<_, PackError>((bytes, plan.items.iter().filter(|i| !i.folder).count() as u64, plan.files))
  })
  .await;
  drop(packing);

  match packed {
    Ok(Ok((bytes, files, own))) => {
      journal::entry(
        Level::Info,
        Area::Project,
        "project.exported",
        &format!("Exported \"{project_name}\" with {own} of its files."),
      )
      .project(Some(id.clone()))
      .write();
      Ok(ExportResult {
        ok: true,
        path: Some(dest.to_string_lossy().to_string()),
        bytes: Some(bytes),
        files: Some(files),
        ..Default::default()
      })
    }
    Ok(Err(PackError::Stopped)) => Ok(ExportResult { cancelled: true, ..Default::default() }),
    Ok(Err(PackError::Failed(error))) => failed(error),
    Err(error) => failed(format!("Couldn’t export the project: {error}")),
  }
}

/// Stop exporting the project. The half-written file is removed.
#[tauri::command]
pub fn projects_export_stop(id: String) {
  if let Some(stop) = PACKING.lock().unwrap().get(&id) {
    stop.store(true, Ordering::Relaxed);
  }
}

/// Show a saved export in the file manager.
#[tauri::command]
pub fn projects_export_reveal(app: AppHandle, path: String) -> Result<(), String> {
  let file = PathBuf::from(&path);
  if !is_export(&file) || !file.is_file() {
    return Err("That file isn’t there anymore.".into());
  }
  app.opener().reveal_item_in_dir(&file).map_err(|e| e.to_string())
}

/// Ask for a file to import: a `.fabricator` file, or a .zip of a Rayfin project.
#[tauri::command]
pub async fn projects_import_pick(app: AppHandle) -> Option<String> {
  let (tx, rx) = tokio::sync::oneshot::channel();
  app
    .dialog()
    .file()
    .set_title("Import a project")
    .add_filter("Fabricator project", &[EXTENSION])
    .add_filter("Zip archive", &["zip"])
    .pick_file(move |picked| {
      let _ = tx.send(picked);
    });
  let path = rx.await.ok().flatten()?.into_path().ok()?;
  Some(path.to_string_lossy().to_string())
}

/// What importing the file would bring in, for the import dialog.
#[tauri::command]
pub async fn projects_import_inspect(path: String) -> Result<ImportPreview, String> {
  let root = PathBuf::from(store::get_state().workspace_root);
  tokio::task::spawn_blocking(move || inspect(Path::new(&path), &root))
    .await
    .map_err(|e| format!("Couldn’t read the file: {e}"))?
}

/// Unpack the file into a new folder in the projects folder, and open it.
#[tauri::command]
pub async fn projects_import(app: AppHandle, path: String) -> ImportResult {
  let source = PathBuf::from(&path);
  let root = PathBuf::from(store::get_state().workspace_root);
  let emitter = app.clone();
  let from = source.clone();
  let unpacked = tokio::task::spawn_blocking(move || {
    unpack(&from, &root, |processed, total| emit_progress(&emitter, IMPORTING, "unpacking", processed, total))
  })
  .await
  .map_err(|e| e.to_string())
  .and_then(|r| r);
  let dir = match unpacked {
    Ok(dir) => normalize(&dir),
    Err(error) => {
      journal::entry(Level::Warn, Area::Project, "project.import.failed", &error).write();
      return ImportResult { error: Some(error), ..Default::default() };
    }
  };

  crate::commands::skills::ensure_project_skills(&dir.to_string_lossy());
  let project = register_project(&dir, None);
  if adopt(&dir, &project.id).is_none() {
    let file = source.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    journal::entry(Level::Info, Area::Project, "project.imported", &format!("Imported \"{}\" from {file}.", project.name))
      .project(Some(project.id.clone()))
      .write();
  }
  store::set_active(Some(project.id.clone()));
  ImportResult { ok: true, error: None, project: store::find_project(&project.id).map(annotate_project) }
}

/// Ask where to save an export. `None` when the dialog is closed.
async fn pick_destination(app: &AppHandle, suggested: &str) -> Option<PathBuf> {
  let (tx, rx) = tokio::sync::oneshot::channel();
  app
    .dialog()
    .file()
    .set_title("Export project")
    .add_filter("Fabricator project", &[EXTENSION])
    .set_file_name(suggested)
    .save_file(move |picked| {
      let _ = tx.send(picked);
    });
  let path = rx.await.ok().flatten()?.into_path().ok()?;
  Some(if is_export(&path) { path } else { PathBuf::from(format!("{}.{EXTENSION}", path.display())) })
}

#[cfg(test)]
mod tests {
  use super::*;

  struct TempDir(PathBuf);

  impl TempDir {
    fn new() -> Self {
      let dir = std::env::temp_dir().join(format!("fabricator-export-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&dir).unwrap();
      Self(dir)
    }

    fn write(&self, rel: &str, content: &str) {
      let path = self.0.join(rel);
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      std::fs::write(path, content).unwrap();
    }

    fn git(&self, args: &[&str]) -> String {
      git_in(&self.0, args)
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn git_in(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").args(args).current_dir(dir).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).to_string()
  }

  fn facts(published: Option<ExportDeployment>) -> Facts {
    Facts {
      name: "Toy Story".into(),
      from: Some("amy@contoso.com".into()),
      created_at: "2026-11-01T19:40:00.000Z".into(),
      fabricator: "1.37.0".into(),
      published,
      deployment_names: Some(HashMap::from([("ws-1".to_string(), "Production".to_string())])),
    }
  }

  fn export(app: &Path, choice: ExportOptions, facts: &Facts, dest: &Path) -> Plan {
    let plan = plan(app, &walk(app), choice, facts, Some(dest));
    write_zip(dest, &plan.items, &AtomicBool::new(false), |_, _| {}).unwrap_or_else(|_| panic!("exports"));
    plan
  }

  /// A .zip written entry by entry, as another tool would.
  fn zip_of(dest: &Path, files: &[(&str, &str)]) {
    let mut zip = zip::ZipWriter::new(File::create(dest).unwrap());
    for (name, content) in files {
      zip.start_file(*name, SimpleFileOptions::default()).unwrap();
      zip.write_all(content.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
  }

  const BOTH: ExportOptions = ExportOptions { history: true, deployment: true };

  #[test]
  fn secrets_and_this_computers_files_never_go_in() {
    for left in [
      "node_modules/react/index.js",
      "packages/web/node_modules/x.js",
      ".rayfin-local/db.sqlite",
      ".micro-fabric/app.json",
      ".fabricator/migration/report/pages/01.png",
      "rayfin/.env",
      "rayfin/.env.secrets",
      "rayfin/.temp/build.json",
      "rayfin/.deploy.tmp",
      "rayfin/.deployments.json",
      "rayfin.config.json",
      "toy-story.fabricator",
      "exports/Toy Story.FABRICATOR",
      "toy-story.fabricator.partial",
    ] {
      assert!(never(left), "{left}");
    }
    for secret in [".env", "packages/web/.env.production", ".env.local", "server.key", "certs/dev.pem", "packages/functions/local.settings.json"] {
      assert!(!never(secret) && may_hold_secret(secret), "{secret}");
    }
    for kept in ["rayfin/rayfin.yml", ".env.example", "src/App.tsx", "HANDOFF.md", "src/keys.ts", ".gitignore", "rayfin/.lockfile.json"] {
      assert!(!never(kept) && !may_hold_secret(kept), "{kept}");
    }
  }

  #[test]
  fn the_history_loses_sign_ins_and_the_senders_identity() {
    let config = "[core]\n\tbare = false\n[user]\n\tname = Amy\n\temail = amy@contoso.com\n[remote \"origin\"]\n\turl = https://amy:ghp_secret@github.com/contoso/toy.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[http \"https://github.com/\"]\n\textraheader = AUTHORIZATION: basic c2VjcmV0\n[remote \"mirror\"]\n\turl = ssh://git@github.com/contoso/toy.git\n";
    let scrubbed = scrub_config(config);
    assert!(!scrubbed.contains("ghp_secret") && !scrubbed.contains("amy:"), "{scrubbed}");
    assert!(!scrubbed.contains("[user]") && !scrubbed.contains("amy@contoso.com"));
    assert!(!scrubbed.contains("extraheader"));
    assert!(scrubbed.contains("url = https://github.com/contoso/toy.git"));
    assert!(scrubbed.contains("url = ssh://git@github.com/contoso/toy.git"), "ssh users aren't sign-ins");
    assert!(scrubbed.contains("[core]") && scrubbed.contains("bare = false"));

    let log = "0000 1111 Amy <amy@contoso.com> 1700000000 +0000\tclone: from https://x-access-token:secret@github.com/contoso/toy.git\n";
    assert_eq!(
      scrub_credentials(log),
      "0000 1111 Amy <amy@contoso.com> 1700000000 +0000\tclone: from https://github.com/contoso/toy.git\n"
    );

    let exclude = with_import_exclusions("# git ls-files --others --exclude-from=.git/info/exclude");
    assert!(exclude.starts_with("# git ls-files --others --exclude-from=.git/info/exclude\n"));
    assert!(exclude.ends_with("\n.fabricator/\n"));
    assert_eq!(with_import_exclusions(&exclude), exclude, "added once");
  }

  #[test]
  fn an_import_finds_the_app_at_its_top_or_in_one_folder() {
    assert_eq!(app_prefix(&["rayfin/rayfin.yml", "src/a.ts"]), Ok(String::new()));
    assert_eq!(app_prefix(&["toy/rayfin/rayfin.yml", "__MACOSX/toy/rayfin/rayfin.yml"]), Ok("toy/".into()));
    assert_eq!(app_prefix(&["src/a.ts"]), Err(NOT_AN_APP.into()));
    assert_eq!(app_prefix(&["a/rayfin/rayfin.yml", "b/rayfin/rayfin.yml"]), Err(MANY_APPS.into()));
    assert_eq!(app_prefix(&["a/b/rayfin/rayfin.yml"]), Err(NOT_AN_APP.into()));
    assert!(skip_on_open("node_modules/x/index.js") && skip_on_open(".git/hooks/pre-commit") && skip_on_open(".DS_Store"));
    assert!(!skip_on_open("src/hooks/useToy.ts") && !skip_on_open(".git/config"));
  }

  #[test]
  fn an_export_without_git_imports_without_its_secrets() {
    let app = TempDir::new();
    let yml = "id: toy-story\nname: Toy Story\nsecrets:\n  - name: OPENAI_KEY\n";
    let registry = r#"{"active":"fabcon","deployments":{"fabcon":{"fabricItemId":"item","fabricWorkspaceId":"ws-1","hostingUrl":"https://toy.example.app"}}}"#;
    app.write("rayfin/rayfin.yml", yml);
    app.write("src/App.tsx", "export default 1\n");
    app.write("public/logo.png", "png");
    app.write(".env", "SECRET=1\n");
    app.write("rayfin/.env", "RAYFIN_PUBLIC_KEY=1\n");
    app.write("rayfin/.deployments.json", registry);
    app.write(".rayfin-local/db.sqlite", "local data");
    app.write("node_modules/react/index.js", "x");
    app.write("dist/index.html", "built");
    app.write(".fabricator/migration/page.png", "real data");
    app.write("old.fabricator", "an earlier export");
    let out = TempDir::new();
    let dest = out.0.join("toy-story.fabricator");

    let facts = Facts { published: published(&app.0), ..facts(None) };
    assert_eq!(facts.published.as_ref().map(|p| p.workspace.as_str()), Some("fabcon"));
    let plan = plan(&app.0, &walk(&app.0), BOTH, &facts, Some(&dest));
    assert_eq!(plan.files, 3);
    assert_eq!(code_items(&app.0, &walk(&app.0), None).1, vec![".env".to_string()], "named in the dialog");
    let mut seen = Vec::new();
    write_zip(&dest, &plan.items, &AtomicBool::new(false), |done, total| seen.push((done, total)))
      .unwrap_or_else(|_| panic!("exports"));
    // Three of the app's files, its publishing record and the export's record of itself.
    assert_eq!(seen.last(), Some(&(5, 5)));
    assert!(!partial_path(&dest).exists());

    let projects = TempDir::new();
    std::fs::create_dir_all(projects.0.join("toy-story")).unwrap();
    let preview = inspect(&dest, &projects.0).unwrap();
    let own_bytes = (yml.len() + "export default 1\n".len() + "png".len() + registry.len()) as u64;
    assert_eq!(
      preview,
      ImportPreview {
        name: "Toy Story".into(),
        from: Some("amy@contoso.com".into()),
        exported_at: Some("2026-11-01T19:40:00.000Z".into()),
        files: 4,
        bytes: own_bytes,
        history: false,
        workspace: Some("fabcon".into()),
        secrets: vec!["OPENAI_KEY".into()],
        folder: projects.0.join("toy-story-2").to_string_lossy().to_string(),
      }
    );

    let mut progress = Vec::new();
    let opened = unpack(&dest, &projects.0, |done, total| progress.push((done, total))).unwrap();
    assert_eq!(opened, projects.0.join("toy-story-2"), "an existing folder is left alone");
    assert_eq!(progress.last(), Some(&(5, 5)));
    for kept in ["rayfin/rayfin.yml", "src/App.tsx", "public/logo.png", "rayfin/.deployments.json", MANIFEST] {
      assert!(opened.join(kept).is_file(), "{kept}");
    }
    for left in [".env", "rayfin/.env", ".rayfin-local", "node_modules", "dist", ".fabricator/migration", ".git", "old.fabricator"] {
      assert!(!opened.join(left).exists(), "{left}");
    }

    let manifest = take_manifest(&opened).expect("an export");
    assert_eq!(manifest.name, "Toy Story");
    assert_eq!(manifest.from.as_deref(), Some("amy@contoso.com"));
    assert!(manifest.deployment && !manifest.history, "no history to export");
    assert_eq!(manifest.workspace.as_deref(), Some("fabcon"));
    assert_eq!(manifest.deployment_names.and_then(|n| n.get("ws-1").cloned()).as_deref(), Some("Production"));
    assert!(!opened.join(".fabricator").exists(), "its record is taken out");
    assert!(take_manifest(&opened).is_none());
  }

  #[test]
  fn leaving_out_the_publishing_record_leaves_it_out() {
    let app = TempDir::new();
    app.write("rayfin/rayfin.yml", "name: Toy Story\n");
    app.write("rayfin/.deployments.json", r#"{"active":"fabcon","deployments":{"fabcon":{"fabricItemId":"item","fabricWorkspaceId":"ws-1"}}}"#);
    let facts = Facts { published: published(&app.0), ..facts(None) };
    let plan = plan(&app.0, &walk(&app.0), ExportOptions::default(), &facts, None);
    let names: Vec<&str> = plan.items.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, vec!["rayfin/rayfin.yml", MANIFEST]);

    let out = TempDir::new();
    let dest = out.0.join("toy.fabricator");
    write_zip(&dest, &plan.items, &AtomicBool::new(false), |_, _| {}).unwrap_or_else(|_| panic!("exports"));
    assert_eq!(inspect(&dest, &out.0).unwrap().workspace, None);
  }

  #[test]
  fn a_stopped_export_leaves_nothing_behind() {
    let app = TempDir::new();
    app.write("rayfin/rayfin.yml", "name: Toy Story\n");
    let out = TempDir::new();
    let dest = out.0.join("toy.fabricator");
    let plan = plan(&app.0, &walk(&app.0), ExportOptions::default(), &facts(None), None);
    assert!(matches!(write_zip(&dest, &plan.items, &AtomicBool::new(true), |_, _| {}), Err(PackError::Stopped)));
    assert!(!dest.exists() && !partial_path(&dest).exists());
  }

  #[test]
  fn a_zip_of_a_project_imports_with_where_it_is_published() {
    let out = TempDir::new();
    let dest = out.0.join("toy.zip");
    zip_of(
      &dest,
      &[
        ("toy/rayfin/rayfin.yml", "name: Toy Story\n"),
        ("toy/rayfin/.deployments.json", r#"{"active":"fabcon","deployments":{"fabcon":{"fabricItemId":"item"}}}"#),
        ("toy/node_modules/react/index.js", "x"),
        ("__MACOSX/toy/._rayfin", "x"),
      ],
    );
    let projects = TempDir::new();
    let preview = inspect(&dest, &projects.0).unwrap();
    assert_eq!((preview.name.as_str(), preview.from.clone(), preview.files), ("Toy Story", None, 2));
    assert_eq!(preview.workspace.as_deref(), Some("fabcon"));

    let opened = unpack(&dest, &projects.0, |_, _| {}).unwrap();
    assert_eq!(opened, projects.0.join("toy-story"));
    assert!(opened.join("rayfin/.deployments.json").is_file());
    assert!(!opened.join("node_modules").exists() && !projects.0.join("__MACOSX").exists());
    assert!(take_manifest(&opened).is_none(), "not an export");
  }

  #[test]
  fn importing_a_file_that_isnt_an_app_creates_nothing() {
    let out = TempDir::new();
    let photos = out.0.join("photos.zip");
    zip_of(&photos, &[("../escape.txt", "evil"), ("photo.jpg", "jpg")]);
    let broken = out.0.join("broken.fabricator");
    std::fs::write(&broken, "not a zip").unwrap();
    let projects = TempDir::new();
    assert_eq!(inspect(&photos, &projects.0), Err(NOT_AN_APP.to_string()));
    assert_eq!(unpack(&photos, &projects.0, |_, _| {}), Err(NOT_AN_APP.to_string()));
    assert_eq!(unpack(&broken, &projects.0, |_, _| {}), Err(UNREADABLE.to_string()));
    assert_eq!(std::fs::read_dir(&projects.0).unwrap().count(), 0);
    assert!(!out.0.parent().unwrap().join("escape.txt").exists());
  }

  #[test]
  fn exports_opened_with_fabricator_are_held_until_the_workbench_takes_them() {
    let dir = TempDir::new();
    dir.write("Toy Story.fabricator", "zip");
    dir.write("other/LEADS.FABRICATOR", "zip");
    dir.write("photos.zip", "zip");
    let leads = dir.0.join("other").join("LEADS.FABRICATOR");
    let args: Vec<OsString> = vec![
      "--flag".into(),
      "Toy Story.fabricator".into(),
      leads.clone().into(),
      "missing.fabricator".into(),
      "photos.zip".into(),
    ];
    let found = exports_in(args, Some(&dir.0));
    assert_eq!(found, vec![dir.0.join("Toy Story.fabricator"), leads.clone()]);

    assert!(hold(found.clone()));
    assert!(!hold(vec![leads]), "already waiting");
    let taken = projects_opened_exports();
    assert_eq!(taken.len(), 2);
    assert!(taken[0].ends_with("Toy Story.fabricator") && taken[1].ends_with("LEADS.FABRICATOR"));
    assert!(projects_opened_exports().is_empty(), "each is handed over once");
  }

  /// Git is installed, and the temp folder isn't inside a repository.
  fn can_test_git() -> bool {
    which::which("git").is_ok() && !version_history::is_tracked(&std::env::temp_dir())
  }

  #[tokio::test]
  async fn an_export_with_its_history_imports_as_a_working_repository() {
    if !can_test_git() {
      return;
    }
    let app = TempDir::new();
    app.write("rayfin/rayfin.yml", "name: Toy Story\n");
    app.write("src/App.tsx", "export default 1\n");
    app.write(".gitignore", "node_modules\n.env\n");
    app.write(".env", "SECRET=1\n");
    app.write("node_modules/react/index.js", "x\n");
    app.git(&["init", "--quiet"]);
    app.git(&["config", "user.name", "Amy"]);
    app.git(&["config", "user.email", "amy@contoso.com"]);
    app.git(&["remote", "add", "origin", "https://amy:ghp_secret@github.com/contoso/toy.git"]);
    app.git(&["add", "-A"]);
    app.git(&["commit", "--quiet", "-m", "First"]);
    app.git(&["pack-refs", "--all"]);
    app.write("src/App.tsx", "export default 2\n");
    app.write("src/new.ts", "export {}\n");

    let listed = app_files(&app.0).await;
    assert_eq!(listed, vec![".gitignore", "rayfin/rayfin.yml", "src/App.tsx", "src/new.ts"]);
    assert_eq!(count_versions(&app.0).await, 1);
    let out = TempDir::new();
    let dest = out.0.join("toy.fabricator");
    export(&app.0, BOTH, &facts(None), &dest);

    let projects = TempDir::new();
    assert!(inspect(&dest, &projects.0).unwrap().history);
    let opened = unpack(&dest, &projects.0, |_, _| {}).unwrap();
    let changes = || {
      let status = git_in(&opened, &["status", "--porcelain", "--untracked-files=all"]);
      let mut lines: Vec<String> = status.lines().map(String::from).collect();
      lines.sort();
      lines
    };
    let unsaved = vec![" M src/App.tsx".to_string(), "?? src/new.ts".to_string()];
    assert_eq!(changes(), unsaved, "its record is ignored, unsaved changes come along");
    take_manifest(&opened).expect("an export");
    assert_eq!(changes(), unsaved);
    assert_eq!(git_in(&opened, &["log", "--format=%s"]).trim(), "First");
    let config = std::fs::read_to_string(opened.join(".git/config")).unwrap();
    assert!(!config.contains("ghp_secret") && !config.contains("amy@contoso.com"), "{config}");
    assert!(!opened.join(".git/hooks").exists());
  }
}
