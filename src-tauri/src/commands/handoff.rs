//! Handing a project off to someone else: a .zip with what they need to carry
//! on in Fabricator, and opening one.
//!
//! A hand-off holds the app's files as its version history sees them, what git
//! tracks or would add, so installed packages, build output and local settings
//! stay out. As the sender chooses, it also holds the history itself (`.git`),
//! the record of where the app is published (`rayfin/.deployments.json`, which
//! `rayfin up` reads, so the recipient's publishes update the same app) and the
//! chat. Files that may hold secrets, the app's data on this computer
//! (`.rayfin-local`) and Fabricator's working files never go in, whatever
//! `.gitignore` says, and the history loses credentials, hooks and the sender's
//! git identity on the way.
//!
//! `HANDOFF.md` at the top says what the .zip is and how to carry on, for someone
//! without Fabricator too. `.fabricator/handoff/` holds what only Fabricator
//! reads: who handed the app off, and its chat.
//!
//! Opening a hand-off unpacks it into the projects folder and opens it with its
//! chat. A folder unpacked by hand and opened with Open folder gets its chat too
//! ([`adopt`]).

use std::collections::{BTreeSet, HashMap};
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
use crate::services::{emit, git, history, store, version_history};
use crate::state::AppState;
use crate::types::{
  ChatMessage, HandoffDeployment, HandoffHistory, HandoffOpenResult, HandoffOptions, HandoffPreview,
  HandoffProgressEvent, HandoffSaveResult, StudioProject,
};

/// The guide at the top of every hand-off.
const GUIDE: &str = "HANDOFF.md";
/// What only Fabricator reads, relative to the app.
const PAYLOAD: &str = ".fabricator/handoff";
const MANIFEST: &str = "handoff.json";
const CHAT: &str = "chat.json";
/// Where `rayfin up` records where the app is published.
const REGISTRY: &str = "rayfin/.deployments.json";
/// The hand-off format this Fabricator writes.
const FORMAT: u32 = 1;
/// The progress id while a hand-off opens: it has no project yet.
const OPENING: &str = "open";
const PROGRESS_EVERY: Duration = Duration::from_millis(90);
const SITE: &str = "https://spatney.github.io/rayfin-fabricator/";
const OPEN_DOCS: &str = "https://spatney.github.io/rayfin-fabricator/docs/build/projects#open-a-hand-off";
/// Opening stops past these, so a damaged or hostile .zip can't fill the disk.
const MAX_UNPACKED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 500_000;
/// The most read of a hand-off's record or `rayfin.yml` before it's unpacked.
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;

const TEAM_APP: &str = "A team app is shared through its team workspace. Invite people to the workspace instead.";
const MISSING: &str = "Fabricator can’t find this project’s folder.";
const NOT_AN_APP: &str = "This .zip doesn’t hold a Rayfin project: there’s no rayfin/rayfin.yml in it.";
const MANY_APPS: &str =
  "This .zip holds more than one Rayfin project. Unpack it, then open the one you want with Open folder.";
const TOO_BIG: &str = "This .zip unpacks to more than 16 GB, so Fabricator didn’t open it.";
const TOO_MANY: &str = "This .zip holds more than 500,000 files, so Fabricator didn’t open it.";

/// Folders that never go in, at any depth: installed packages, git data (the
/// history goes in only as the sender chooses), and what belongs to this
/// computer: the app's local data and keys, and Rayfin's and Fabricator's
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

/// Hand-offs being packed, by project, with the flag that stops them.
static PACKING: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> = Lazy::new(Default::default);

/// What a hand-off records for Fabricator (`.fabricator/handoff/handoff.json`).
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
  #[serde(default)]
  pub format: u32,
  #[serde(default)]
  pub name: String,
  /// Who handed it off: their Fabric account.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub from: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub created_at: Option<String>,
  /// The Fabricator version that packed it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub fabricator: Option<String>,
  #[serde(default)]
  pub history: bool,
  #[serde(default)]
  pub deployment: bool,
  #[serde(default)]
  pub chat: bool,
  /// The workspace its publishes go to, when `deployment`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workspace: Option<String>,
  /// The names the sender gave its deployments.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub deployment_names: Option<HashMap<String, String>>,
}

/* ------------------------------ what goes in ------------------------------ */

/// Never in a hand-off, and not worth a mention: this computer's files, and
/// what the hand-off writes itself or adds only when chosen.
fn never(rel: &str) -> bool {
  let parts: Vec<&str> = rel.split('/').collect();
  let Some((name, folders)) = parts.split_last() else {
    return true;
  };
  folders.iter().any(|f| NEVER_FOLDERS.contains(f))
    || rel == GUIDE
    || rel == REGISTRY
    // Rayfin's environment for this computer, its secrets included, and its scratch files.
    || rel.starts_with("rayfin/.env")
    || rel.starts_with("rayfin/.temp/")
    || (folders == ["rayfin"] && name.starts_with('.') && name.ends_with(".tmp"))
    || *name == "rayfin.config.json"
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

/// What a file in the .zip is made from.
enum Source {
  Disk(PathBuf),
  Text(Vec<u8>),
}

struct Item {
  /// Its path in the .zip.
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
/// hold secrets. `skip` is the .zip being written, should it be saved in the app.
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

/// The recipient's git ignores the hand-off's own files.
fn with_handoff_exclusions(exclude: &str) -> String {
  let has = |patterns: &[&str]| exclude.lines().any(|l| patterns.contains(&l.trim()));
  let mut block = String::new();
  if !has(&["/HANDOFF.md", "HANDOFF.md"]) {
    block.push_str("/HANDOFF.md\n");
  }
  if !has(&[".fabricator/", ".fabricator", "/.fabricator/", "/.fabricator"]) {
    block.push_str(".fabricator/\n");
  }
  let mut next = exclude.to_string();
  if !block.is_empty() {
    if !next.is_empty() && !next.ends_with('\n') {
      next.push('\n');
    }
    next.push_str("\n# Added by Fabricator to a hand-off: its guide, and the files Fabricator reads when it opens the app\n");
    next.push_str(&block);
  }
  next
}

/// The version history: the app's `.git` folder, without its hooks, locks or
/// other worktrees, with sign-ins and the sender's identity taken out of its
/// settings and logs, and ignoring the hand-off's own files.
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
        rewrite(with_handoff_exclusions)
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
    items.push(Item::text(".git/info/exclude", with_handoff_exclusions("").into_bytes()));
  }
  items
}

/// Where the app is published, as `rayfin up` records it: its active
/// deployment, or the first it records.
fn published(dir: &Path) -> Option<HandoffDeployment> {
  if let Some(Some(active)) = crate::commands::deploy::registry_active(dir) {
    return Some(HandoffDeployment {
      workspace: active.workspace_name,
      workspace_id: active.workspace_id,
      url: active.hosting,
      portal_url: active.portal,
    });
  }
  let first = crate::commands::deploy::recorded_deployments(dir).into_iter().next()?;
  Some(HandoffDeployment {
    workspace: first.workspace_name,
    workspace_id: first.workspace_id,
    url: first.hosting_url,
    portal_url: None,
  })
}

/// Who's handing the app off: the Fabric account in use.
fn sender() -> Option<String> {
  crate::services::fabric_accounts::list()
    .into_iter()
    .find(|a| a.active)
    .map(|a| a.user)
    .or_else(|| crate::commands::auth::get_cached_identity().and_then(|i| i.email))
    .filter(|user| user.contains('@'))
}

/// What the guide and the record say about a hand-off.
struct Facts {
  name: String,
  from: Option<String>,
  /// When, as the guide says it.
  date: String,
  created_at: String,
  fabricator: String,
  published: Option<HandoffDeployment>,
  secrets: Vec<String>,
  deployment_names: Option<HashMap<String, String>>,
}

/// `A`, `A and B`, `A, B and C`.
fn list(names: &[String]) -> String {
  match names {
    [] => String::new(),
    [one] => one.clone(),
    [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
  }
}

/// `HANDOFF.md`: what the hand-off is and how to carry on, for someone reading
/// it with or without Fabricator.
fn guide(facts: &Facts, manifest: &Manifest) -> String {
  let mut out = format!("# {}\n\n", facts.name);
  match &facts.from {
    Some(from) => out.push_str(&format!("{from} handed this Rayfin app off to you from Fabricator on {}.\n", facts.date)),
    None => out.push_str(&format!("This Rayfin app was handed off to you from Fabricator on {}.\n", facts.date)),
  }

  out.push_str("\n## Open it in Fabricator\n\n");
  out.push_str(&format!("1. Install Fabricator if you don't have it: {SITE}\n"));
  out.push_str("2. In Fabricator, on **Your projects**, select **Open existing**, then **Open a hand-off**.\n");
  out.push_str("3. Pick this .zip file.\n\n");
  out.push_str("Fabricator unpacks the app into your projects folder, installs its packages and opens it");
  out.push_str(if manifest.chat { ", with the chat that built it.\n\n" } else { ".\n\n" });
  out.push_str("Unpacked it already? Select **Open existing**, then **Open folder**, and pick the unpacked folder.\n\n");
  out.push_str(&format!("More about hand-offs: {OPEN_DOCS}\n"));

  match (&facts.published, manifest.deployment) {
    (Some(published), true) => {
      out.push_str("\n## Where it's published\n\n");
      out.push_str(&format!("It's published in the Fabric workspace **{}**.\n\n", published.workspace));
      if let Some(url) = &published.url {
        out.push_str(&format!("- App: {url}\n"));
      }
      if let Some(url) = &published.portal_url {
        out.push_str(&format!("- In Fabric: {url}\n"));
      }
      if published.url.is_some() || published.portal_url.is_some() {
        out.push('\n');
      }
      let who = facts.from.as_deref().unwrap_or("whoever handed it off");
      out.push_str(&format!(
        "When you publish, you update this app. To publish, you need to be a Contributor, Member or Admin of the \
         workspace: ask {who} to add you in its **Manage access** in Fabric.\n"
      ));
    }
    (Some(_), false) => out.push_str(
      "\n## Publishing\n\nThis hand-off doesn't say where the app is published. When you publish it, Fabricator asks \
       which Fabric workspace to publish it to, and publishes it as a new app.\n",
    ),
    (None, _) => out.push_str(
      "\n## Publishing\n\nThe app isn't published yet. When you publish it, Fabricator asks which Fabric workspace to \
       publish it to.\n",
    ),
  }

  if !facts.secrets.is_empty() {
    let names: Vec<String> = facts.secrets.iter().map(|s| format!("`{s}`")).collect();
    let these = if names.len() == 1 { "this secret" } else { "these secrets" };
    out.push_str(&format!(
      "\n## Secrets\n\nThe app's functions use {these}: {}. Their values aren't in this hand-off.",
      list(&names)
    ));
    if manifest.deployment {
      out.push_str(" The published app keeps its values.");
    }
    out.push_str(" To run the app on your computer, set your own: in Fabricator, select **Code**, then **Secrets**.\n");
  }

  out.push_str("\n## What's in this hand-off\n\n- The app's code\n");
  if manifest.history {
    out.push_str("- Its version history, in `.git`\n");
  }
  if manifest.deployment {
    out.push_str("- Where it's published, in `rayfin/.deployments.json`\n");
  }
  if manifest.chat {
    out.push_str("- The chat that built it, which Fabricator restores when it opens the app\n");
  }
  out.push_str(
    "\nNever in a hand-off: secret values and files that may hold them (such as `.env` files), the app's data on the \
     sender's computer (`.rayfin-local`), installed packages (`node_modules`), build output, and anyone's sign-ins.\n",
  );
  out.push_str(
    "\n## Without Fabricator\n\nIn a terminal in this folder, run `npm install`, then `npx rayfin up` to publish the \
     app. Rayfin's documentation: https://rayfin.ai/docs\n",
  );
  out
}

/// Everything a hand-off holds, in the order it's written.
struct Plan {
  items: Vec<Item>,
  /// How many of the app's own files it holds.
  files: u64,
  kept_out: Vec<String>,
}

fn plan(
  dir: &Path,
  listed: &[String],
  choice: HandoffOptions,
  facts: &Facts,
  chat: &[ChatMessage],
  skip: Option<&Path>,
) -> Plan {
  let (code, kept_out) = code_items(dir, listed, skip);
  let files = code.len() as u64;
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
    chat: choice.chat && !chat.is_empty(),
    workspace: facts.published.as_ref().filter(|_| deployment).map(|p| p.workspace.clone()),
    deployment_names: facts.deployment_names.clone().filter(|names| deployment && !names.is_empty()),
  };

  let mut items = vec![Item::text(GUIDE, guide(facts, &manifest).into_bytes())];
  items.extend(code);
  if let Some(meta) = registry.filter(|_| deployment) {
    items.push(Item::disk(REGISTRY, dir.join(REGISTRY), &meta));
  }
  if manifest.history {
    items.extend(history_items(dir));
  }
  items.push(Item::text(format!("{PAYLOAD}/{MANIFEST}"), serde_json::to_vec_pretty(&manifest).unwrap_or_default()));
  if manifest.chat {
    items.push(Item::text(format!("{PAYLOAD}/{CHAT}"), serde_json::to_vec(chat).unwrap_or_default()));
  }
  Plan { items, files, kept_out }
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

/// Where the .zip is written until it's complete, so a failed or stopped
/// hand-off never leaves a broken one behind.
fn partial_path(dest: &Path) -> PathBuf {
  let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "handoff.zip".into());
  dest.with_file_name(format!("{name}.partial"))
}

/// Write `items` to the .zip at `dest`. Returns its size.
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
    let mut out = writer.finish().map_err(|e| failed(format!("Couldn’t finish the .zip: {e}")))?;
    out.flush().map_err(|e| failed(format!("Couldn’t finish the .zip: {e}")))?;
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

/// Marks a project as being packed until dropped, so Stop can find it.
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

/* -------------------------------- opening -------------------------------- */

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

/// Where the app is in the .zip: at its top, or in the one folder at its top
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

/// Left behind when a hand-off opens: installed packages (Fabricator installs
/// them again), git hooks (a hand-off never has them; they'd run on the next
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

/// A small text file from the .zip.
fn read_text<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>, index: usize) -> Option<String> {
  let entry = archive.by_index(index).ok()?;
  let mut text = String::new();
  entry.take(MAX_TEXT_BYTES).read_to_string(&mut text).ok()?;
  Some(text)
}

/// The first folder in `root` named `slug`, or `slug-2`, `slug-3`… that's free.
fn free_folder(root: &Path, slug: &str) -> Option<PathBuf> {
  (1..100)
    .map(|n| if n == 1 { root.join(slug) } else { root.join(format!("{slug}-{n}")) })
    .find(|path| !path.exists())
}

/// Unpack the app in the .zip at `source` into a new folder in `root`, named
/// after it. Anything that would land outside that folder, and links, stay
/// behind. On failure, nothing is left.
fn unpack(source: &Path, root: &Path, mut progress: impl FnMut(u64, u64)) -> Result<PathBuf, String> {
  let unreadable = |e: &dyn std::fmt::Display| format!("Couldn’t read this .zip: {e}");
  let file = File::open(source).map_err(|e| format!("Couldn’t open {}: {e}", source.display()))?;
  let mut archive = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| unreadable(&e))?;
  if archive.len() > MAX_ENTRIES {
    return Err(TOO_MANY.into());
  }

  // (index, safe path, folder)
  let mut entries: Vec<(usize, String, bool)> = Vec::new();
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
    let rel = slash_path(&path);
    if !rel.is_empty() {
      entries.push((index, rel, entry.is_dir()));
    }
  }
  let files: Vec<&str> = entries.iter().filter(|e| !e.2).map(|e| e.1.as_str()).collect();
  let prefix = app_prefix(&files)?;
  let find = |rel: &str| entries.iter().find(|e| !e.2 && e.1 == rel).map(|e| e.0);
  let manifest_at = find(&format!("{prefix}{PAYLOAD}/{MANIFEST}"));
  let yaml_at = find(&format!("{prefix}rayfin/rayfin.yml"));
  let recorded = manifest_at
    .and_then(|i| read_text(&mut archive, i))
    .and_then(|text| serde_json::from_str::<Manifest>(&text).ok())
    .map(|m| m.name.trim().to_string())
    .filter(|n| !n.is_empty());
  let name = recorded
    .or_else(|| yaml_at.and_then(|i| read_text(&mut archive, i)).and_then(|text| name_in_yaml(&text)))
    .or_else(|| source.file_stem().map(|s| s.to_string_lossy().trim_end_matches("-handoff").to_string()))
    .unwrap_or_default();
  let slug = Some(slugify(&name)).filter(|s| !s.is_empty()).unwrap_or_else(|| "app".into());

  std::fs::create_dir_all(root).map_err(|e| format!("Couldn’t create your projects folder {}: {e}", root.display()))?;
  let target = free_folder(root, &slug)
    .ok_or_else(|| format!("Your projects folder already has folders named {slug} to {slug}-99."))?;
  std::fs::create_dir(&target).map_err(|e| format!("Couldn’t create {}: {e}", target.display()))?;

  let unpacked = (|| {
    let wanted: Vec<&(usize, String, bool)> = entries
      .iter()
      .filter(|(_, rel, _)| rel.len() > prefix.len() && rel.starts_with(&prefix) && !skip_on_open(&rel[prefix.len()..]))
      .collect();
    let total = wanted.iter().filter(|e| !e.2).count() as u64;
    let (mut done, mut written) = (0u64, 0u64);
    let mut shown = Instant::now();
    progress(0, total);
    for (index, rel, folder) in wanted {
      let out = rel[prefix.len()..].split('/').fold(target.clone(), |path, part| path.join(part));
      let create = |dir: &Path| std::fs::create_dir_all(dir).map_err(|e| format!("Couldn’t create {}: {e}", dir.display()));
      if *folder {
        create(&out)?;
        continue;
      }
      if let Some(parent) = out.parent() {
        create(parent)?;
      }
      let mut entry = archive.by_index(*index).map_err(|e| unreadable(&e))?;
      let mut file = File::create(&out).map_err(|e| format!("Couldn’t create {}: {e}", out.display()))?;
      let room = MAX_UNPACKED_BYTES - written;
      let copied = std::io::copy(&mut (&mut entry).take(room + 1), &mut file)
        .map_err(|e| format!("Couldn’t unpack {}: {e}", &rel[prefix.len()..]))?;
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

/// What a hand-off left for Fabricator in a folder it was unpacked into.
struct Payload {
  manifest: Manifest,
  chat: Vec<ChatMessage>,
}

/// Take the hand-off's files for Fabricator out of `dir`, so they don't end up
/// in the app's history. `None` when the folder didn't come from a hand-off.
fn take_payload(dir: &Path) -> Option<Payload> {
  let fabricator = dir.join(".fabricator");
  let folder = fabricator.join("handoff");
  let manifest = serde_json::from_str::<Manifest>(&std::fs::read_to_string(folder.join(MANIFEST)).ok()?).ok()?;
  let chat = std::fs::read_to_string(folder.join(CHAT))
    .ok()
    .and_then(|text| serde_json::from_str::<Vec<ChatMessage>>(&text).ok())
    .unwrap_or_default();
  if let Err(e) = std::fs::remove_dir_all(&folder) {
    log::warn!("Couldn't remove {}: {e}", folder.display());
  }
  if std::fs::read_dir(&fabricator).is_ok_and(|mut rest| rest.next().is_none()) {
    let _ = std::fs::remove_dir(&fabricator);
  }
  Some(Payload { manifest, chat })
}

/// Give a project just registered from a folder a hand-off was unpacked into
/// what came with it: its chat, unless it has one, and the names its
/// deployments had. Returns the hand-off's record and the messages restored.
pub(crate) fn adopt(dir: &Path, project_id: &str) -> Option<(Manifest, u32)> {
  let payload = take_payload(dir)?;
  let mut restored = 0;
  if !payload.chat.is_empty() && history::load_history(project_id).is_empty() {
    restored = payload.chat.len() as u32;
    history::save_history(project_id, payload.chat);
  }
  if let Some(names) = payload.manifest.deployment_names.clone().filter(|n| !n.is_empty()) {
    store::mutate_project(project_id, |p| {
      if p.deployment_names.as_ref().is_none_or(|known| known.is_empty()) {
        p.deployment_names = Some(names);
      }
    });
  }
  let from = payload.manifest.from.as_deref().map(|f| format!(" from {f}")).unwrap_or_default();
  journal::entry(
    Level::Info,
    Area::Project,
    "project.handoff-opened",
    &format!("Opened the hand-off of \"{}\"{from}.", payload.manifest.name),
  )
  .project(Some(project_id.to_string()))
  .write();
  Some((payload.manifest, restored))
}

/* -------------------------------- commands -------------------------------- */

/// The project, when it can be handed off from here.
fn handoff_project(id: &str) -> Result<StudioProject, String> {
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
    emit::HANDOFF_PROGRESS,
    HandoffProgressEvent { id: id.to_string(), phase: phase.to_string(), processed, total },
  );
}

/// What a hand-off of the project would hold, for the hand-off dialog.
#[tauri::command]
pub async fn projects_handoff_preview(id: String) -> Result<HandoffPreview, String> {
  let project = handoff_project(&id)?;
  let dir = PathBuf::from(&project.path);
  let listed = app_files(&dir).await;
  let versions = if has_own_history(&dir) { Some(count_versions(&dir).await) } else { None };
  let chat_messages = history::load_history(&id).len() as u32;
  tokio::task::spawn_blocking(move || {
    let (code, kept_out) = code_items(&dir, &listed, None);
    HandoffPreview {
      files: code.len() as u64,
      bytes: code.iter().map(|i| i.size).sum(),
      history: versions.map(|versions| HandoffHistory {
        versions,
        bytes: history_items(&dir).iter().map(|i| i.size).sum(),
      }),
      deployment: published(&dir),
      chat_messages,
      secrets: crate::commands::secrets::declared_names(&dir),
      kept_out,
    }
  })
  .await
  .map_err(|e| format!("Couldn’t look at the project: {e}"))
}

/// Ask where to save a hand-off of the project, then pack it there. The
/// project's lease keeps chat turns and publishes from changing its files
/// meanwhile; progress streams on `handoff:progress`.
#[tauri::command]
pub async fn projects_handoff_save(
  app: AppHandle,
  state: State<'_, AppState>,
  id: String,
  options: HandoffOptions,
) -> Result<HandoffSaveResult, String> {
  let failed = |error: String| -> Result<HandoffSaveResult, String> {
    Ok(HandoffSaveResult { error: Some(error), ..Default::default() })
  };
  let project = match handoff_project(&id) {
    Ok(project) => project,
    Err(error) => return failed(error),
  };
  let slug = Some(slugify(&project.name)).filter(|s| !s.is_empty()).unwrap_or_else(|| "app".into());
  let Some(dest) = pick_destination(&app, &format!("{slug}-handoff.zip")).await else {
    return Ok(HandoffSaveResult { cancelled: true, ..Default::default() });
  };
  let _lease = match state.mutations.handoff(&id) {
    Ok(lease) => lease,
    Err(error) => return failed(error),
  };

  let dir = PathBuf::from(&project.path);
  let project_name = project.name.clone();
  let listed = app_files(&dir).await;
  let chat = if options.chat { history::load_history(&id) } else { Vec::new() };
  let facts_base = (sender(), app.package_info().version.to_string());
  let packing = Packing::start(&id);
  let stop = packing.stop.clone();
  let emitter = app.clone();
  let (project_id, target) = (id.clone(), dest.clone());
  let packed = tokio::task::spawn_blocking(move || {
    let facts = Facts {
      name: project.name.clone(),
      from: facts_base.0,
      date: chrono::Local::now().format("%Y-%m-%d").to_string(),
      created_at: now_iso(),
      fabricator: facts_base.1,
      published: published(&dir),
      secrets: crate::commands::secrets::declared_names(&dir),
      deployment_names: project.deployment_names.clone(),
    };
    let plan = plan(&dir, &listed, options, &facts, &chat, Some(&target));
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
        "project.handed-off",
        &format!("Saved a hand-off of \"{}\" with {own} of its files.", project_name),
      )
      .project(Some(id.clone()))
      .write();
      Ok(HandoffSaveResult {
        ok: true,
        path: Some(dest.to_string_lossy().to_string()),
        bytes: Some(bytes),
        files: Some(files),
        ..Default::default()
      })
    }
    Ok(Err(PackError::Stopped)) => Ok(HandoffSaveResult { cancelled: true, ..Default::default() }),
    Ok(Err(PackError::Failed(error))) => failed(error),
    Err(error) => failed(format!("Couldn’t pack the project: {error}")),
  }
}

/// Stop packing the project's hand-off. The half-written .zip is removed.
#[tauri::command]
pub fn projects_handoff_stop(id: String) {
  if let Some(stop) = PACKING.lock().unwrap().get(&id) {
    stop.store(true, Ordering::Relaxed);
  }
}

/// Show a saved hand-off in the file manager.
#[tauri::command]
pub fn projects_handoff_reveal(app: AppHandle, path: String) -> Result<(), String> {
  let file = PathBuf::from(&path);
  let zip = file.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"));
  if !zip || !file.is_file() {
    return Err("That hand-off isn’t there anymore.".into());
  }
  app.opener().reveal_item_in_dir(&file).map_err(|e| e.to_string())
}

/// Pick a hand-off (or any .zip of a Rayfin project), unpack it into the
/// projects folder and open it.
#[tauri::command]
pub async fn projects_handoff_open(app: AppHandle) -> HandoffOpenResult {
  let Some(zip) = pick_zip(&app).await else {
    return HandoffOpenResult { cancelled: true, ..Default::default() };
  };
  let root = PathBuf::from(store::get_state().workspace_root);
  let emitter = app.clone();
  let unpacked = tokio::task::spawn_blocking(move || {
    unpack(&zip, &root, |processed, total| emit_progress(&emitter, OPENING, "unpacking", processed, total))
  })
  .await
  .map_err(|e| e.to_string())
  .and_then(|r| r);
  let dir = match unpacked {
    Ok(dir) => normalize(&dir),
    Err(error) => {
      journal::entry(Level::Warn, Area::Project, "project.handoff-open.failed", &error).write();
      return HandoffOpenResult { error: Some(error), ..Default::default() };
    }
  };

  crate::commands::skills::ensure_project_skills(&dir.to_string_lossy());
  let project = register_project(&dir, None);
  let adopted = adopt(&dir, &project.id);
  store::set_active(Some(project.id.clone()));
  let (manifest, chat_messages) = adopted.unwrap_or_default();
  HandoffOpenResult {
    ok: true,
    project: store::find_project(&project.id).map(annotate_project),
    from: manifest.from,
    at: manifest.created_at,
    chat_messages,
    workspace: manifest.workspace.filter(|_| manifest.deployment),
    ..Default::default()
  }
}

/// Ask where to save a hand-off. `None` when the dialog is closed.
async fn pick_destination(app: &AppHandle, suggested: &str) -> Option<PathBuf> {
  let (tx, rx) = tokio::sync::oneshot::channel();
  app
    .dialog()
    .file()
    .set_title("Save hand-off")
    .add_filter("Zip archive", &["zip"])
    .set_file_name(suggested)
    .save_file(move |picked| {
      let _ = tx.send(picked);
    });
  let path = rx.await.ok().flatten()?.into_path().ok()?;
  let zip = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"));
  Some(if zip { path } else { PathBuf::from(format!("{}.zip", path.display())) })
}

/// Ask for a hand-off to open. `None` when the dialog is closed.
async fn pick_zip(app: &AppHandle) -> Option<PathBuf> {
  let (tx, rx) = tokio::sync::oneshot::channel();
  app
    .dialog()
    .file()
    .set_title("Open a hand-off")
    .add_filter("Hand-off (.zip)", &["zip"])
    .pick_file(move |picked| {
      let _ = tx.send(picked);
    });
  rx.await.ok().flatten()?.into_path().ok()
}

#[cfg(test)]
mod tests {
  use super::*;

  struct TempDir(PathBuf);

  impl TempDir {
    fn new() -> Self {
      let dir = std::env::temp_dir().join(format!("fabricator-handoff-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&dir).unwrap();
      Self(dir)
    }

    fn write(&self, rel: &str, content: &str) {
      let path = self.0.join(rel);
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      std::fs::write(path, content).unwrap();
    }

    fn git(&self, args: &[&str]) -> String {
      let out = std::process::Command::new("git").args(args).current_dir(&self.0).output().expect("git runs");
      assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
      String::from_utf8_lossy(&out.stdout).to_string()
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn facts(published: Option<HandoffDeployment>) -> Facts {
    Facts {
      name: "Toy Story".into(),
      from: Some("amy@contoso.com".into()),
      date: "2026-11-01".into(),
      created_at: "2026-11-01T19:40:00.000Z".into(),
      fabricator: "1.36.0".into(),
      published,
      secrets: vec!["OPENAI_KEY".into(), "STRIPE_KEY".into()],
      deployment_names: Some(HashMap::from([("ws-1".to_string(), "Production".to_string())])),
    }
  }

  fn fabcon() -> HandoffDeployment {
    HandoffDeployment {
      workspace: "fabcon".into(),
      workspace_id: Some("ws-1".into()),
      url: Some("https://toy.example.app".into()),
      portal_url: Some("https://app.fabric.microsoft.com/groups/ws-1/appbackends/item".into()),
    }
  }

  fn chat() -> Vec<ChatMessage> {
    serde_json::from_value(serde_json::json!([
      {"id":"u1","role":"user","text":"Build a toy catalog"},
      {"id":"a1","role":"assistant","text":"Done."}
    ]))
    .unwrap()
  }

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
      "HANDOFF.md",
      "rayfin.config.json",
    ] {
      assert!(never(left), "{left}");
    }
    for secret in [".env", "packages/web/.env.production", ".env.local", "server.key", "certs/dev.pem", "packages/functions/local.settings.json"] {
      assert!(!never(secret) && may_hold_secret(secret), "{secret}");
    }
    for kept in ["rayfin/rayfin.yml", ".env.example", "src/App.tsx", "docs/HANDOFF.md", "src/keys.ts", ".gitignore", "rayfin/.lockfile.json"] {
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

    let exclude = with_handoff_exclusions("# git ls-files --others --exclude-from=.git/info/exclude\n.fabricator/\n");
    assert!(exclude.ends_with("/HANDOFF.md\n"));
    assert_eq!(exclude.matches(".fabricator/").count(), 1);
    assert_eq!(with_handoff_exclusions(&exclude), exclude, "added once");
  }

  #[test]
  fn the_guide_says_where_it_is_published_and_what_the_recipient_needs() {
    let manifest = |deployment: bool| Manifest { deployment, history: true, chat: true, ..Default::default() };
    let text = guide(&facts(Some(fabcon())), &manifest(true));
    assert!(text.starts_with("# Toy Story\n\namy@contoso.com handed this Rayfin app off to you from Fabricator on 2026-11-01."));
    assert!(text.contains("**Open existing**, then **Open a hand-off**"));
    assert!(text.contains("with the chat that built it"));
    assert!(text.contains("It's published in the Fabric workspace **fabcon**."));
    assert!(text.contains("- App: https://toy.example.app\n"));
    assert!(text.contains("ask amy@contoso.com to add you"));
    assert!(text.contains("`OPENAI_KEY` and `STRIPE_KEY`. Their values aren't in this hand-off. The published app keeps its values."));
    assert!(text.contains("- Its version history, in `.git`\n- Where it's published, in `rayfin/.deployments.json`\n"));

    let unlinked = guide(&facts(Some(fabcon())), &manifest(false));
    assert!(unlinked.contains("doesn't say where the app is published") && !unlinked.contains("fabcon"));
    assert!(guide(&facts(None), &manifest(false)).contains("The app isn't published yet."));
  }

  #[test]
  fn an_opened_zip_finds_the_app_at_its_top_or_in_one_folder() {
    assert_eq!(app_prefix(&["rayfin/rayfin.yml", "src/a.ts"]), Ok(String::new()));
    assert_eq!(app_prefix(&["toy/rayfin/rayfin.yml", "__MACOSX/toy/rayfin/rayfin.yml"]), Ok("toy/".into()));
    assert_eq!(app_prefix(&["src/a.ts"]), Err(NOT_AN_APP.into()));
    assert_eq!(app_prefix(&["a/rayfin/rayfin.yml", "b/rayfin/rayfin.yml"]), Err(MANY_APPS.into()));
    assert_eq!(app_prefix(&["a/b/rayfin/rayfin.yml"]), Err(NOT_AN_APP.into()));
    assert!(skip_on_open("node_modules/x/index.js") && skip_on_open(".git/hooks/pre-commit") && skip_on_open(".DS_Store"));
    assert!(!skip_on_open("src/hooks/useToy.ts") && !skip_on_open(".git/config"));
  }

  #[test]
  fn a_handoff_without_git_round_trips_without_secrets() {
    let app = TempDir::new();
    app.write("rayfin/rayfin.yml", "id: toy-story\nname: Toy Story\n");
    app.write("src/App.tsx", "export default 1\n");
    app.write("public/logo.png", "png");
    app.write(".env", "SECRET=1\n");
    app.write("rayfin/.env", "RAYFIN_PUBLIC_KEY=1\n");
    app.write("rayfin/.deployments.json", r#"{"active":"fabcon","deployments":{"fabcon":{"fabricItemId":"item","fabricWorkspaceId":"ws-1","hostingUrl":"https://toy.example.app"}}}"#);
    app.write(".rayfin-local/db.sqlite", "local data");
    app.write("node_modules/react/index.js", "x");
    app.write("dist/index.html", "built");
    app.write(".fabricator/migration/page.png", "real data");
    let out = TempDir::new();
    let dest = out.0.join("toy-story-handoff.zip");

    let listed = walk(&app.0);
    let facts = Facts { published: published(&app.0), ..facts(None) };
    assert_eq!(facts.published.as_ref().map(|p| p.workspace.as_str()), Some("fabcon"));
    let choice = HandoffOptions { history: true, deployment: true, chat: true };
    let plan = plan(&app.0, &listed, choice, &facts, &chat(), Some(&dest));
    assert_eq!((plan.files, plan.kept_out.clone()), (3, vec![".env".to_string()]));
    let mut seen = Vec::new();
    write_zip(&dest, &plan.items, &AtomicBool::new(false), |done, total| seen.push((done, total)))
      .unwrap_or_else(|_| panic!("packs"));
    // The guide, three files, the publishing record, the record for Fabricator and the chat.
    assert_eq!(seen.last(), Some(&(7, 7)));
    assert!(!partial_path(&dest).exists());

    let projects = TempDir::new();
    std::fs::create_dir_all(projects.0.join("toy-story")).unwrap();
    let opened = unpack(&dest, &projects.0, |_, _| {}).unwrap();
    assert_eq!(opened, projects.0.join("toy-story-2"), "an existing folder is left alone");
    for kept in ["rayfin/rayfin.yml", "src/App.tsx", "public/logo.png", "rayfin/.deployments.json", "HANDOFF.md"] {
      assert!(opened.join(kept).is_file(), "{kept}");
    }
    for left in [".env", "rayfin/.env", ".rayfin-local", "node_modules", "dist", ".fabricator/migration", ".git"] {
      assert!(!opened.join(left).exists(), "{left}");
    }

    let payload = take_payload(&opened).expect("a hand-off");
    assert_eq!(payload.manifest.name, "Toy Story");
    assert_eq!(payload.manifest.from.as_deref(), Some("amy@contoso.com"));
    assert!(payload.manifest.deployment && payload.manifest.chat && !payload.manifest.history, "no history to send");
    assert_eq!(payload.manifest.workspace.as_deref(), Some("fabcon"));
    assert_eq!(payload.chat.len(), 2);
    assert!(!opened.join(".fabricator").exists(), "its files are taken out");
    assert!(take_payload(&opened).is_none());
  }

  #[test]
  fn leaving_out_the_publishing_record_and_chat_leaves_them_out() {
    let app = TempDir::new();
    app.write("rayfin/rayfin.yml", "name: Toy Story\n");
    app.write("rayfin/.deployments.json", r#"{"active":"fabcon","deployments":{"fabcon":{"fabricItemId":"item","fabricWorkspaceId":"ws-1"}}}"#);
    let facts = Facts { published: published(&app.0), ..facts(None) };
    let plan = plan(&app.0, &walk(&app.0), HandoffOptions::default(), &facts, &chat(), None);
    let names: Vec<&str> = plan.items.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, vec!["HANDOFF.md", "rayfin/rayfin.yml", ".fabricator/handoff/handoff.json"]);
  }

  #[test]
  fn a_stopped_handoff_leaves_nothing_behind() {
    let app = TempDir::new();
    app.write("rayfin/rayfin.yml", "name: Toy Story\n");
    let out = TempDir::new();
    let dest = out.0.join("toy.zip");
    let plan = plan(&app.0, &walk(&app.0), HandoffOptions::default(), &facts(None), &[], None);
    assert!(matches!(write_zip(&dest, &plan.items, &AtomicBool::new(true), |_, _| {}), Err(PackError::Stopped)));
    assert!(!dest.exists() && !partial_path(&dest).exists());
  }

  #[test]
  fn opening_a_zip_that_isnt_an_app_creates_nothing() {
    let out = TempDir::new();
    let dest = out.0.join("photos.zip");
    {
      let mut zip = zip::ZipWriter::new(File::create(&dest).unwrap());
      zip.start_file("../escape.txt", SimpleFileOptions::default()).unwrap();
      zip.write_all(b"evil").unwrap();
      zip.start_file("photo.jpg", SimpleFileOptions::default()).unwrap();
      zip.finish().unwrap();
    }
    let projects = TempDir::new();
    assert_eq!(unpack(&dest, &projects.0, |_, _| {}), Err(NOT_AN_APP.to_string()));
    assert_eq!(std::fs::read_dir(&projects.0).unwrap().count(), 0);
    assert!(!out.0.parent().unwrap().join("escape.txt").exists());
  }

  /// Git is installed, and the temp folder isn't inside a repository.
  fn can_test_git() -> bool {
    which::which("git").is_ok() && !version_history::is_tracked(&std::env::temp_dir())
  }

  #[tokio::test]
  async fn a_handoff_with_its_history_opens_as_a_working_repository() {
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
    let dest = out.0.join("toy.zip");
    let choice = HandoffOptions { history: true, deployment: true, chat: false };
    let plan = plan(&app.0, &listed, choice, &facts(None), &[], None);
    write_zip(&dest, &plan.items, &AtomicBool::new(false), |_, _| {}).unwrap_or_else(|_| panic!("packs"));

    let projects = TempDir::new();
    let opened = unpack(&dest, &projects.0, |_, _| {}).unwrap();
    take_payload(&opened).expect("a hand-off");
    let git = |args: &[&str]| {
      let out = std::process::Command::new("git").args(args).current_dir(&opened).output().unwrap();
      assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
      String::from_utf8_lossy(&out.stdout).to_string()
    };
    assert_eq!(git(&["log", "--format=%s"]).trim(), "First");
    let status = git(&["status", "--porcelain", "--untracked-files=all"]);
    let mut changes: Vec<&str> = status.lines().collect();
    changes.sort();
    assert_eq!(changes, vec![" M src/App.tsx", "?? src/new.ts"], "the guide is ignored, unsaved changes come along");
    let config = std::fs::read_to_string(opened.join(".git/config")).unwrap();
    assert!(!config.contains("ghp_secret") && !config.contains("amy@contoso.com"), "{config}");
    assert!(!opened.join(".git/hooks").exists());
  }
}
