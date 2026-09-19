//! Private, project-scoped Design drafts, original assets and source baselines.
//! Acknowledgement means an atomic on-disk replacement completed successfully.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use base64::Engine;
use once_cell::sync::Lazy;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::design_contract::{self as contract, DesignApplyReceipt, DesignAsset, DesignDraft};
use super::{paths, store};

static IO_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
const MAX_SOURCE_FILE: usize = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES: usize = 128 * 1024 * 1024;
const MAX_SOURCE_FILES: usize = 20_000;
const MAX_STAGED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_STAGED_ASSETS: usize = 256;
const MAX_BASELINES: usize = 24;
const MAX_RETIRED_APPLIES: usize = 10_000;
const MAX_DISCARD_ARCHIVES: usize = 32;
const MAX_RESET_IDENTITIES: usize = 10_000;

pub fn lock() -> Result<MutexGuard<'static, ()>, String> {
  IO_LOCK.lock().map_err(|_| "Design storage is unavailable after an internal error. Restart Fabricator.".into())
}

pub fn digest(bytes: &[u8]) -> String {
  hex::encode(Sha256::digest(bytes))
}

fn io_error(path: &Path, error: impl std::fmt::Display) -> String {
  format!("Design storage failed for {}: {error}", path.display())
}

fn no_link(path: &Path) -> Result<(), String> {
  let metadata = fs::symlink_metadata(path).map_err(|e| io_error(path, e))?;
  #[cfg(windows)]
  let reparse = {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
  };
  #[cfg(not(windows))]
  let reparse = false;
  if metadata.file_type().is_symlink() || reparse {
    return Err(format!("Design does not follow links or reparse points: {}", path.display()));
  }
  Ok(())
}

pub fn read_bytes(path: &Path, max: usize) -> Result<Vec<u8>, String> {
  no_link(path)?;
  let file = fs::File::open(path).map_err(|e| io_error(path, e))?;
  let meta = file.metadata().map_err(|e| io_error(path, e))?;
  if !meta.is_file() || meta.len() > max as u64 {
    return Err(format!("Design file is not a regular file or exceeds its size budget: {}", path.display()));
  }
  let mut bytes = Vec::new();
  file.take(max as u64 + 1).read_to_end(&mut bytes).map_err(|e| io_error(path, e))?;
  if bytes.len() > max {
    return Err(format!("Design file grew beyond its size budget: {}", path.display()));
  }
  Ok(bytes)
}

pub fn read_json<T: DeserializeOwned>(path: &Path, max: usize) -> Result<Option<T>, String> {
  let Some(bytes) = optional_bytes(path, max)? else {
    return Ok(None);
  };
  decode_record(path, &bytes).map(Some)
}

fn optional_bytes(path: &Path, max: usize) -> Result<Option<Vec<u8>>, String> {
  match fs::symlink_metadata(path) {
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(io_error(path, e)),
    Ok(_) => {}
  }
  read_bytes(path, max).map(Some)
}

fn decode_record<T: DeserializeOwned>(path: &Path, bytes: &[u8]) -> Result<T, String> {
  serde_json::from_slice(bytes).map_err(|e| {
    format!("Design record is corrupt or has an unsupported schema; it was not discarded ({}): {e}", path.display())
  })
}

#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
  use std::os::windows::ffi::OsStrExt;
  #[link(name = "kernel32")]
  extern "system" {
    fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
  }
  let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
  let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
  // Same-directory rename with replacement; never delete the acknowledged file
  // first (std::fs::rename cannot replace an existing file on Windows).
  for attempt in 0..10 {
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } != 0 {
      return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if attempt == 9 || !matches!(error.raw_os_error(), Some(5 | 32 | 33)) {
      return Err(error);
    }
    // Indexers/antivirus briefly open newly acknowledged JSON without delete
    // sharing. Retry the atomic rename, never unlink the acknowledged file.
    std::thread::sleep(std::time::Duration::from_millis((10u64 << attempt).min(200)));
  }
  unreachable!("bounded rename retry always returns")
}

#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
  fs::rename(from, to)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
  let parent = path.parent().ok_or("Design storage path has no parent.")?;
  let name = path.file_name().ok_or("Design storage path must name a file.")?;
  fs::create_dir_all(parent).map_err(|e| io_error(parent, e))?;
  no_link(parent)?;
  // Rust's filesystem APIs accept long Windows paths, but raw MoveFileExW
  // does not unless given an extended-length (\\?\) path. Canonicalize the
  // existing parent, not the destination (which may not exist or may be a
  // link), and use that spelling for every write/rename/cleanup in the
  // transaction. This also covers relative data roots and UNC directories.
  let parent = fs::canonicalize(parent).map_err(|e| io_error(parent, e))?;
  no_link(&parent)?;
  let path = parent.join(name);
  match fs::symlink_metadata(&path) {
    Ok(_) => no_link(&path)?,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => return Err(io_error(&path, error)),
  }
  let next = parent.join(format!(".next-{}", uuid::Uuid::new_v4()));
  let result = (|| {
    let mut file = OpenOptions::new().write(true).create_new(true).open(&next).map_err(|e| io_error(&next, e))?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| io_error(&next, e))?;
    drop(file);
    replace(&next, &path).map_err(|e| io_error(&path, e))?;
    #[cfg(not(windows))]
    fs::File::open(&parent).and_then(|f| f.sync_all()).map_err(|e| io_error(&parent, e))?;
    Ok(())
  })();
  if result.is_err() {
    let _ = fs::remove_file(&next);
  }
  result
}

pub fn write_json(path: &Path, value: &impl Serialize, max: usize) -> Result<(), String> {
  let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
  if bytes.len() > max {
    return Err("Design record exceeds its disk budget.".into());
  }
  atomic_write(path, &bytes)
}

#[derive(Clone)]
pub struct ProjectDesign {
  pub project_id: String,
  pub project_path: PathBuf,
  pub dir: PathBuf,
}

pub fn project(project_id: &str) -> Result<ProjectDesign, String> {
  contract::identity(project_id)?;
  let project = store::find_project(project_id).ok_or("Project not found.")?;
  let project_path = fs::canonicalize(&project.path).map_err(|e| io_error(Path::new(&project.path), e))?;
  if !project_path.is_dir() {
    return Err("Project directory is unavailable.".into());
  }
  Ok(ProjectDesign {
    project_id: project_id.to_string(),
    project_path,
    dir: paths::data_dir().join("design").join(digest(project_id.as_bytes())),
  })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptRecord {
  pub schema_version: u32,
  pub receipt: DesignApplyReceipt,
  pub finished: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetRecord {
  schema_version: u32,
  project_id: String,
  asset: DesignAsset,
  sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetiredApplies {
  schema_version: u32,
  project_id: String,
  ids: BTreeSet<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FreshStart {
  schema_version: u32,
  project_id: String,
  draft_sessions: BTreeSet<String>,
  apply_ids: BTreeSet<String>,
  draft_hash: Option<String>,
  receipt_hash: Option<String>,
  archive_id: String,
}

pub struct SourceFile {
  pub hash: String,
  pub bytes: Vec<u8>,
}

pub struct SourceSnapshot {
  pub revision: String,
  pub files: BTreeMap<String, SourceFile>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Baseline {
  pub schema_version: u32,
  pub project_id: String,
  pub apply_id: String,
  pub draft: DesignDraft,
  pub revision: String,
  pub files: BTreeMap<String, String>,
}

impl ProjectDesign {
  fn fresh_start(&self) -> Result<Option<FreshStart>, String> {
    let reset: Option<FreshStart> = read_json(&self.dir.join("fresh-start.json"), 2 * 1024 * 1024)?;
    if let Some(reset) = &reset {
      if reset.schema_version != 1
        || reset.project_id != self.project_id
        || reset.draft_sessions.len() + reset.apply_ids.len() > MAX_RESET_IDENTITIES
      {
        return Err("The Design fresh-draft index is invalid; existing recovery files were retained.".into());
      }
      contract::identity(&reset.archive_id)?;
      for id in reset.draft_sessions.iter().chain(&reset.apply_ids) {
        contract::identity(id)?;
      }
      for hash in [&reset.draft_hash, &reset.receipt_hash].into_iter().flatten() {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
          return Err("The Design fresh-draft index contains an invalid content hash.".into());
        }
      }
    }
    Ok(reset)
  }

  fn read_current<T: DeserializeOwned>(&self, name: &str, cleared_hash: Option<&str>) -> Result<Option<T>, String> {
    let path = self.dir.join(name);
    let Some(bytes) = optional_bytes(&path, contract::MAX_DRAFT_BYTES)? else {
      return Ok(None);
    };
    if cleared_hash == Some(digest(&bytes).as_str()) {
      return Ok(None);
    }
    decode_record(&path, &bytes).map(Some)
  }

  pub fn load_draft(&self) -> Result<Option<DesignDraft>, String> {
    let reset = self.fresh_start()?;
    let Some(draft) =
      self.read_current::<DesignDraft>("draft.json", reset.as_ref().and_then(|r| r.draft_hash.as_deref()))?
    else {
      return Ok(None);
    };
    contract::draft(&draft)?;
    if draft.project_id != self.project_id {
      return Err("Design draft project identity does not match its storage.".into());
    }
    if reset.as_ref().is_some_and(|r| r.draft_sessions.contains(&draft.session_id)) {
      return Ok(None);
    }
    Ok(Some(draft))
  }

  pub fn save_draft(&self, draft: DesignDraft) -> Result<u64, String> {
    contract::draft(&draft)?;
    if draft.project_id != self.project_id {
      return Err("Design draft project mismatch.".into());
    }
    if self.fresh_start()?.is_some_and(|r| r.draft_sessions.contains(&draft.session_id)) {
      return Err(
        "This Design draft was discarded. Reconnect using the fresh draft rather than saving a stale journal.".into(),
      );
    }
    if let Some(previous) = self.load_draft()? {
      if draft.revision < previous.revision {
        return Err("A newer Design draft is already saved. Reload it before editing.".into());
      }
      if draft.revision == previous.revision && (draft.history != previous.history || draft.cursor != previous.cursor) {
        return Err("A Design revision cannot acknowledge two different journals.".into());
      }
    }
    // This is the renderer's last-accepted bookmark, not current Apply state.
    // Only the separate authoritative receipt is used to authorize native work.
    write_json(&self.dir.join("draft.json"), &draft, contract::MAX_DRAFT_BYTES)?;
    Ok(draft.revision)
  }

  pub fn clear_draft(&self) -> Result<(), String> {
    remove_owned_file(&self.dir.join("draft.json"))
  }

  /// Explicit Start fresh is a logical atomic reset of both latest records.
  /// The archive precedes a durable tombstone, so restart never resurrects one
  /// half of the discarded workspace if Windows delays physical file removal.
  pub fn archive_and_clear(&self) -> Result<(), String> {
    let draft = optional_bytes(&self.dir.join("draft.json"), contract::MAX_DRAFT_BYTES)?;
    let receipt = optional_bytes(&self.dir.join("receipt.json"), contract::MAX_DRAFT_BYTES)?;
    if draft.is_none() && receipt.is_none() {
      return Ok(());
    }
    let mut reset = self.fresh_start()?.unwrap_or_else(|| FreshStart {
      schema_version: 1,
      project_id: self.project_id.clone(),
      draft_sessions: BTreeSet::new(),
      apply_ids: BTreeSet::new(),
      draft_hash: None,
      receipt_hash: None,
      archive_id: String::new(),
    });
    if let Some(id) = draft
      .as_deref()
      .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
      .and_then(|v| v.get("sessionId").and_then(|id| id.as_str()).map(str::to_string))
    {
      if contract::identity(&id).is_ok() {
        reset.draft_sessions.insert(id);
      }
    }
    if let Some(id) = receipt
      .as_deref()
      .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
      .and_then(|v| v.get("receipt").and_then(|r| r.get("id")).and_then(|id| id.as_str()).map(str::to_string))
    {
      if contract::identity(&id).is_ok() {
        reset.apply_ids.insert(id);
      }
    }
    if reset.draft_sessions.len() + reset.apply_ids.len() > MAX_RESET_IDENTITIES {
      return Err(
        "Design's fresh-draft recovery index is full. Archive this project's recovery storage before continuing."
          .into(),
      );
    }
    let archive_id = uuid::Uuid::new_v4().to_string();
    let archive = self.dir.join("discarded").join(&archive_id);
    if let Some(bytes) = &draft {
      atomic_write(&archive.join("draft.json"), bytes)?;
    }
    if let Some(bytes) = &receipt {
      atomic_write(&archive.join("receipt.json"), bytes)?;
    }
    reset.draft_hash = draft.as_ref().map(|bytes| digest(bytes));
    reset.receipt_hash = receipt.as_ref().map(|bytes| digest(bytes));
    reset.archive_id = archive_id;
    write_json(
      &archive.join("archive.json"),
      &serde_json::json!({
        "schemaVersion":1, "projectId":self.project_id, "draftHash":reset.draft_hash, "receiptHash":reset.receipt_hash
      }),
      4096,
    )?;
    write_json(&self.dir.join("fresh-start.json"), &reset, 2 * 1024 * 1024)?;
    let cleanup = (|| {
      remove_owned_file(&self.dir.join("draft.json"))?;
      remove_owned_file(&self.dir.join("receipt.json"))?;
      self.prune_discarded(&reset.archive_id)
    })();
    cleanup.map_err(|error| {
      format!("The draft and receipt were archived and cleared, but recovery-file cleanup failed: {error}")
    })
  }

  fn prune_discarded(&self, keep: &str) -> Result<(), String> {
    let dir = self.dir.join("discarded");
    let mut archives = fs::read_dir(&dir)
      .map_err(|e| io_error(&dir, e))?
      .map(|entry| {
        let entry = entry.map_err(|e| io_error(&dir, e))?;
        let modified = entry.metadata().and_then(|m| m.modified()).map_err(|e| io_error(&entry.path(), e))?;
        Ok((modified, entry))
      })
      .collect::<Result<Vec<_>, String>>()?;
    archives.sort_by_key(|(modified, _)| *modified);
    let mut count = archives.len();
    for (_, archive) in archives {
      if count <= MAX_DISCARD_ARCHIVES {
        break;
      }
      if archive.file_name() == keep {
        continue;
      }
      let metadata: serde_json::Value =
        read_json(&archive.path().join("archive.json"), 4096)?.ok_or("Design discard archive metadata is missing.")?;
      if metadata.get("schemaVersion").and_then(|v| v.as_u64()) != Some(1)
        || metadata.get("projectId").and_then(|v| v.as_str()) != Some(&self.project_id)
      {
        return Err("Design discard archive identity mismatch.".into());
      }
      check_owned_tree(&archive.path(), 0, &mut 0)?;
      fs::remove_dir_all(archive.path()).map_err(|e| io_error(&dir, e))?;
      count -= 1;
    }
    Ok(())
  }

  pub fn load_receipt(&self) -> Result<Option<ReceiptRecord>, String> {
    let reset = self.fresh_start()?;
    let record: Option<ReceiptRecord> =
      self.read_current("receipt.json", reset.as_ref().and_then(|r| r.receipt_hash.as_deref()))?;
    if let Some(r) = &record {
      if r.schema_version != 1 || r.receipt.project_id != self.project_id {
        return Err("Unsupported or mismatched Design receipt. Nothing was replayed.".into());
      }
      contract::receipt(&r.receipt)?;
      if reset.as_ref().is_some_and(|reset| reset.apply_ids.contains(&r.receipt.id)) {
        return Ok(None);
      }
    }
    Ok(record)
  }

  pub fn save_receipt(&self, record: &ReceiptRecord) -> Result<(), String> {
    contract::receipt(&record.receipt)?;
    if record.schema_version != 1 || record.receipt.project_id != self.project_id {
      return Err("Invalid Design receipt identity.".into());
    }
    if self.fresh_start()?.is_some_and(|r| r.apply_ids.contains(&record.receipt.id)) {
      return Err(
        "This Apply receipt was archived by Start fresh. A stale completion cannot replace the new draft's state."
          .into(),
      );
    }
    let history = self.apply_dir(&record.receipt.id)?;
    if history.exists() {
      write_json(&history.join("receipt.json"), record, contract::MAX_DRAFT_BYTES)?;
    }
    write_json(&self.dir.join("receipt.json"), record, contract::MAX_DRAFT_BYTES)
  }

  pub fn apply_dir(&self, apply_id: &str) -> Result<PathBuf, String> {
    contract::identity(apply_id)?;
    Ok(self.dir.join(format!("apply-{}", digest(apply_id.as_bytes()))))
  }

  pub fn save_baseline(&self, apply_id: &str, draft: &DesignDraft, source: &SourceSnapshot) -> Result<(), String> {
    let dir = self.apply_dir(apply_id)?;
    let mut retired: RetiredApplies = read_json(&self.dir.join("retired-applies.json"), 2 * 1024 * 1024)?
      .unwrap_or_else(|| RetiredApplies {
        schema_version: 1,
        project_id: self.project_id.clone(),
        ids: BTreeSet::new(),
      });
    if retired.schema_version != 1 || retired.project_id != self.project_id || retired.ids.len() > MAX_RETIRED_APPLIES {
      return Err("The Design recovery index is invalid; no source work was started.".into());
    }
    for id in &retired.ids {
      contract::identity(id)?;
    }
    if dir.exists()
      || retired.ids.contains(apply_id)
      || self.fresh_start()?.is_some_and(|r| r.apply_ids.contains(apply_id))
    {
      return Err(
        "This Apply ID was already used. Inspect its receipt; source work is never replayed automatically.".into(),
      );
    }
    if self.dir.exists() {
      let mut archives = fs::read_dir(&self.dir)
        .map_err(|e| io_error(&self.dir, e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| io_error(&self.dir, e))?
        .into_iter()
        .filter(|e| e.file_name().to_string_lossy().starts_with("apply-"))
        .map(|e| {
          let modified = e.metadata().and_then(|m| m.modified()).map_err(|error| io_error(&e.path(), error))?;
          Ok((modified, e.path()))
        })
        .collect::<Result<Vec<_>, String>>()?;
      archives.sort_by_key(|(modified, _)| *modified);
      let mut count = archives.len();
      for (_, archive) in archives {
        if count < MAX_BASELINES {
          break;
        }
        // Retire verified archives or proven no-source-change failures only.
        // Interrupted/partial work and the separate original assets survive.
        let applied = read_json::<DesignDraft>(&archive.join("applied-draft.json"), contract::MAX_DRAFT_BYTES)?;
        if let Some(applied) = applied {
          contract::draft(&applied)?;
          if applied.project_id != self.project_id {
            return Err("Design archive project identity mismatch.".into());
          }
        } else {
          let Some(record) = read_json::<ReceiptRecord>(&archive.join("receipt.json"), contract::MAX_DRAFT_BYTES)?
          else {
            continue;
          };
          contract::receipt(&record.receipt)?;
          if record.schema_version != 1 || record.receipt.project_id != self.project_id {
            return Err("Design archive receipt identity mismatch.".into());
          }
          if record.receipt.phase != contract::ApplyPhase::Error
            || !record.receipt.files_modified.is_empty()
            || record.receipt.source_revision_after.as_ref() != Some(&record.receipt.source_revision_before)
          {
            continue;
          }
        }
        let baseline: Baseline = read_json(&archive.join("baseline.json"), 12 * 1024 * 1024)?
          .ok_or("An archived Design baseline is missing.")?;
        if baseline.project_id != self.project_id || self.apply_dir(&baseline.apply_id)? != archive {
          return Err("Design archive identity mismatch.".into());
        }
        if retired.ids.len() >= MAX_RETIRED_APPLIES && !retired.ids.contains(&baseline.apply_id) {
          return Err(
            "The Design recovery index is full. Archive this project's recovery storage before continuing.".into(),
          );
        }
        check_owned_tree(&archive, 0, &mut 0)?;
        retired.ids.insert(baseline.apply_id);
        // Keep a durable tombstone before retiring bytes so an old Apply ID
        // can never accidentally replay source work after history pruning.
        write_json(&self.dir.join("retired-applies.json"), &retired, 2 * 1024 * 1024)?;
        fs::remove_dir_all(&archive).map_err(|e| io_error(&archive, e))?;
        count -= 1;
      }
      if count >= MAX_BASELINES {
        return Err(
          "Design recovery storage contains 24 unfinished Apply baselines. Review and archive those recovery folders before another Apply."
            .into(),
        );
      }
    }
    let blobs = dir.join("baseline");
    fs::create_dir_all(&blobs).map_err(|e| io_error(&blobs, e))?;
    let mut files = BTreeMap::new();
    for (path, file) in &source.files {
      atomic_write(&blobs.join(format!("{}.bin", digest(path.as_bytes()))), &file.bytes)?;
      files.insert(path.clone(), file.hash.clone());
    }
    let baseline = Baseline {
      schema_version: 1,
      project_id: self.project_id.clone(),
      apply_id: apply_id.to_string(),
      draft: draft.clone(),
      revision: source.revision.clone(),
      files,
    };
    write_json(&dir.join("baseline.json"), &baseline, 12 * 1024 * 1024)
  }

  pub fn load_baseline(&self, apply_id: &str) -> Result<Baseline, String> {
    let record: Baseline = read_json(&self.apply_dir(apply_id)?.join("baseline.json"), 12 * 1024 * 1024)?
      .ok_or("The private pre-Apply baseline is missing. Review source before proceeding.")?;
    if record.schema_version != 1 || record.project_id != self.project_id || record.apply_id != apply_id {
      return Err("Private Design baseline identity mismatch.".into());
    }
    contract::draft(&record.draft)?;
    if record.revision != record.draft.source_revision || record.files.len() > MAX_SOURCE_FILES {
      return Err("Private Design baseline is inconsistent.".into());
    }
    for (path, hash) in &record.files {
      contract::relative_path(path)?;
      if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid baseline hash.".into());
      }
    }
    Ok(record)
  }

  pub fn baseline_bytes(&self, baseline: &Baseline, path: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(hash) = baseline.files.get(path) else {
      return Ok(None);
    };
    let bytes = read_bytes(
      &self.apply_dir(&baseline.apply_id)?.join("baseline").join(format!("{}.bin", digest(path.as_bytes()))),
      MAX_SOURCE_FILE,
    )?;
    if digest(&bytes) != *hash {
      return Err("The private pre-Apply baseline was modified; automatic deployment is blocked.".into());
    }
    Ok(Some(bytes))
  }

  pub fn archive_draft(&self, apply_id: &str, revision: u64) -> Result<(), String> {
    if let Some(draft) = self.load_draft()? {
      let baseline = self.load_baseline(apply_id)?;
      if draft.revision != revision
        || draft.session_id != baseline.draft.session_id
        || draft.history != baseline.draft.history
        || draft.cursor != baseline.draft.cursor
      {
        return Err("The draft changed while Apply was in progress; it was not cleared.".into());
      }
      write_json(&self.apply_dir(apply_id)?.join("applied-draft.json"), &draft, contract::MAX_DRAFT_BYTES)?;
      self.clear_draft()?;
    }
    Ok(())
  }

  fn staged_assets(&self) -> Result<Vec<AssetRecord>, String> {
    let dir = self.dir.join("assets");
    if !dir.exists() {
      return Ok(vec![]);
    }
    no_link(&dir)?;
    let mut records = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| io_error(&dir, e))? {
      let entry = entry.map_err(|e| io_error(&dir, e))?;
      if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
        continue;
      }
      let record: AssetRecord = read_json(&entry.path(), 8192)?.ok_or("Design asset disappeared.")?;
      if record.schema_version != 1
        || record.project_id != self.project_id
        || record.asset.project_path.is_some()
        || record.asset.id != format!("asset-{}", record.sha256)
      {
        return Err("Corrupt or mismatched Design asset record.".into());
      }
      if record.asset.size > contract::MAX_IMAGE_BYTES as u64 {
        return Err("Staged Design image exceeds its size budget.".into());
      }
      contract::identity(&record.asset.id)?;
      records.push(record);
      if records.len() > MAX_STAGED_ASSETS {
        return Err("Design asset count exceeds its budget.".into());
      }
    }
    Ok(records)
  }

  pub fn import_asset(&self, picked: &Path) -> Result<DesignAsset, String> {
    let bytes = read_bytes(picked, contract::MAX_IMAGE_BYTES)?;
    let (mime, _) = image_format(&bytes)?;
    let sha256 = digest(&bytes);
    let id = format!("asset-{sha256}");
    let records = self.staged_assets()?;
    if let Some(found) = records.iter().find(|r| r.asset.id == id) {
      self.asset_bytes(&id)?;
      return Ok(found.asset.clone());
    }
    if records.len() >= MAX_STAGED_ASSETS
      || records.iter().map(|r| r.asset.size).sum::<u64>() + bytes.len() as u64 > MAX_STAGED_BYTES
    {
      return Err("Design staged image budget exceeded (256 images / 128 MiB).".into());
    }
    let name = picked.file_name().and_then(|s| s.to_str()).ok_or("Image file name is invalid.")?.to_string();
    contract::bounded(&name, 1024, "image name")?;
    let asset = DesignAsset { id: id.clone(), name, mime: mime.into(), size: bytes.len() as u64, project_path: None };
    let dir = self.dir.join("assets");
    atomic_write(&dir.join(format!("{id}.bin")), &bytes)?;
    write_json(
      &dir.join(format!("{id}.json")),
      &AssetRecord { schema_version: 1, project_id: self.project_id.clone(), asset: asset.clone(), sha256 },
      8192,
    )?;
    Ok(asset)
  }

  pub fn assets(&self) -> Result<Vec<DesignAsset>, String> {
    let mut assets: Vec<_> = self.staged_assets()?.into_iter().map(|r| r.asset).collect();
    let source = source_snapshot(&self.project_path)?;
    for (path, file) in source.files {
      if !is_image_path(&path) {
        continue;
      }
      if file.bytes.len() > contract::MAX_IMAGE_BYTES {
        continue;
      }
      if let Ok((mime, _)) = image_format(&file.bytes) {
        let name = Path::new(&path).file_name().and_then(|s| s.to_str()).unwrap_or(&path).to_string();
        assets.push(DesignAsset {
          id: source_asset_id(&path),
          name,
          mime: mime.into(),
          size: file.bytes.len() as u64,
          project_path: Some(path),
        });
      }
      if assets.len() > 2000 {
        return Err("Project image catalogue exceeds 2000 images.".into());
      }
    }
    assets.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(assets)
  }

  pub fn asset_bytes(&self, id: &str) -> Result<(DesignAsset, Vec<u8>), String> {
    contract::identity(id)?;
    if id.starts_with("asset-") {
      let record =
        self.staged_assets()?.into_iter().find(|r| r.asset.id == id).ok_or("Staged Design asset was not found.")?;
      let bytes = read_bytes(&self.dir.join("assets").join(format!("{id}.bin")), contract::MAX_IMAGE_BYTES)?;
      let (mime, _) = image_format(&bytes)?;
      if digest(&bytes) != record.sha256 || bytes.len() as u64 != record.asset.size || mime != record.asset.mime {
        return Err("Staged Design asset bytes do not match their original record.".into());
      }
      return Ok((record.asset, bytes));
    }
    if !id.starts_with("source-") {
      return Err("Unknown Design asset ID.".into());
    }
    // The caller supplies only an opaque ID. Paths come from our own confined
    // scan, never from a frame's selector, src attribute or filesystem string.
    let asset = self.assets()?.into_iter().find(|a| a.id == id).ok_or("Project Design asset was not found.")?;
    let path = confined(&self.project_path, asset.project_path.as_deref().ok_or("Missing project asset path.")?)?;
    let bytes = read_bytes(&path, contract::MAX_IMAGE_BYTES)?;
    image_format(&bytes)?;
    Ok((asset, bytes))
  }

  pub fn asset_preview(&self, id: &str) -> Result<String, String> {
    let (asset, bytes) = self.asset_bytes(id)?;
    Ok(format!("data:{};base64,{}", asset.mime, base64::engine::general_purpose::STANDARD.encode(bytes)))
  }

  pub fn materialize_assets(&self, draft: &DesignDraft) -> Result<BTreeMap<String, String>, String> {
    let mut ids = BTreeSet::new();
    for transaction in draft.history.iter().take(draft.cursor) {
      for edit in &transaction.edits {
        if matches!(edit.kind, contract::DesignEditKind::Image | contract::DesignEditKind::Insert) {
          collect_asset_ids(&edit.after, &mut ids);
        }
      }
    }
    let mut result = BTreeMap::new();
    for id in ids {
      let (asset, bytes) = self.asset_bytes(&id)?;
      if let Some(path) = asset.project_path {
        confined(&self.project_path, &path)?;
        result.insert(id, path);
        continue;
      }
      let (_, ext) = image_format(&bytes)?;
      let rel = format!("public/design-assets/{}.{}", asset.id, ext);
      let destination = confined_for_create(&self.project_path, &rel)?;
      if destination.exists() {
        if read_bytes(&destination, contract::MAX_IMAGE_BYTES)? != bytes {
          return Err("A Design image destination already contains different bytes; it was not overwritten.".into());
        }
      } else {
        atomic_write(&destination, &bytes)?;
      }
      result.insert(id, rel);
    }
    Ok(result)
  }
}

fn collect_asset_ids(value: &serde_json::Value, ids: &mut BTreeSet<String>) {
  match value {
    serde_json::Value::Array(a) => {
      for v in a {
        collect_asset_ids(v, ids);
      }
    }
    serde_json::Value::Object(o) => {
      if let Some(id) = o.get("assetId").and_then(|v| v.as_str()) {
        ids.insert(id.to_string());
      }
      for v in o.values() {
        collect_asset_ids(v, ids);
      }
    }
    _ => {}
  }
}

fn remove_owned_file(path: &Path) -> Result<(), String> {
  if !path.exists() {
    return Ok(());
  }
  no_link(path)?;
  for attempt in 0..10 {
    match fs::remove_file(path) {
      Ok(()) => return Ok(()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
      Err(error) if cfg!(windows) && attempt < 9 && matches!(error.raw_os_error(), Some(5 | 32 | 33)) => {
        std::thread::sleep(std::time::Duration::from_millis((10u64 << attempt).min(200)));
      }
      Err(error) => return Err(io_error(path, error)),
    }
  }
  unreachable!("bounded removal retry always returns")
}

fn check_owned_tree(dir: &Path, depth: usize, entries: &mut usize) -> Result<(), String> {
  no_link(dir)?;
  if depth > 2 {
    return Err("Unexpected nested directory in a Design recovery archive.".into());
  }
  for entry in fs::read_dir(dir).map_err(|e| io_error(dir, e))? {
    let entry = entry.map_err(|e| io_error(dir, e))?;
    *entries += 1;
    if *entries > MAX_SOURCE_FILES + 100 {
      return Err("Design recovery archive entry budget exceeded.".into());
    }
    no_link(&entry.path())?;
    if entry.file_type().map_err(|e| io_error(&entry.path(), e))?.is_dir() {
      check_owned_tree(&entry.path(), depth + 1, entries)?;
    }
  }
  Ok(())
}

fn source_asset_id(path: &str) -> String {
  format!("source-{}", digest(path.as_bytes()))
}

pub fn confined(root: &Path, relative: &str) -> Result<PathBuf, String> {
  contract::relative_path(relative)?;
  let root = fs::canonicalize(root).map_err(|e| io_error(root, e))?;
  let candidate =
    crate::commands::util::safe_resolve(&root.to_string_lossy(), relative).ok_or("Design path escapes the project.")?;
  let mut current = root.clone();
  for component in Path::new(relative).components() {
    current.push(component);
    no_link(&current)?;
  }
  let canonical = fs::canonicalize(&candidate).map_err(|e| io_error(&candidate, e))?;
  if !canonical.starts_with(&root) || canonical == root {
    return Err("Design path escapes the project.".into());
  }
  Ok(canonical)
}

fn confined_for_create(root: &Path, relative: &str) -> Result<PathBuf, String> {
  contract::relative_path(relative)?;
  let root = fs::canonicalize(root).map_err(|e| io_error(root, e))?;
  let relative = Path::new(relative);
  let mut parent = root.clone();
  if let Some(ancestors) = relative.parent() {
    for component in ancestors.components() {
      parent.push(component);
      if !parent.exists() {
        fs::create_dir(&parent).map_err(|e| io_error(&parent, e))?;
      }
      no_link(&parent)?;
      if !fs::canonicalize(&parent).map_err(|e| io_error(&parent, e))?.starts_with(&root) {
        return Err("Design image directory escapes the project.".into());
      }
    }
  }
  let path = parent.join(relative.file_name().ok_or("Missing Design image name.")?);
  if path.exists() {
    no_link(&path)?;
  }
  Ok(path)
}

fn skip_dir(name: &str) -> bool {
  matches!(
    name.to_ascii_lowercase().as_str(),
    "node_modules"
      | ".git"
      | "dist"
      | "out"
      | "build"
      | "target"
      | "bin"
      | "obj"
      | ".next"
      | ".nuxt"
      | ".turbo"
      | ".cache"
      | ".vite"
      | "coverage"
      | ".rayfin"
      | ".venv"
      | "venv"
      | "__pycache__"
      | ".fabricator"
      | ".native-design-tests"
      | "generated"
      | ".copilot"
      | ".ssh"
      | "secrets"
      | "credentials"
  )
}

fn relevant_file(name: &str) -> bool {
  let lower = name.to_ascii_lowercase();
  if lower.starts_with(".env")
    || lower.starts_with(".")
    || lower.ends_with(".map")
    || matches!(
      lower.as_str(),
      "credentials.json"
        | "secrets.json"
        | "secrets.yaml"
        | "secrets.yml"
        | "access-token.json"
        | "refresh-token.json"
        | "oauth-token.json"
        | "service-account.json"
        | "auth.json"
    )
    || matches!(lower.as_str(), "package-lock.json" | "yarn.lock" | "pnpm-lock.yaml" | "bun.lock" | "bun.lockb")
  {
    return false;
  }
  matches!(
    Path::new(&lower).extension().and_then(|s| s.to_str()),
    Some(
      "ts"
        | "tsx"
        | "js"
        | "jsx"
        | "mjs"
        | "cjs"
        | "css"
        | "scss"
        | "sass"
        | "less"
        | "html"
        | "vue"
        | "svelte"
        | "astro"
        | "md"
        | "mdx"
        | "json"
        | "yaml"
        | "yml"
        | "toml"
        | "graphql"
        | "gql"
        | "sql"
        | "svg"
        | "png"
        | "jpg"
        | "jpeg"
        | "gif"
        | "webp"
        | "ico"
        | "woff"
        | "woff2"
        | "ttf"
        | "otf"
    )
  )
}

fn is_image_path(path: &str) -> bool {
  matches!(
    Path::new(path).extension().and_then(|s| s.to_str()).map(str::to_ascii_lowercase).as_deref(),
    Some("png" | "jpg" | "jpeg" | "gif" | "webp")
  )
}

pub fn source_snapshot(root: &Path) -> Result<SourceSnapshot, String> {
  fn walk(
    root: &Path,
    dir: &Path,
    depth: usize,
    budget: &mut usize,
    files: &mut BTreeMap<String, SourceFile>,
  ) -> Result<(), String> {
    if depth > 24 {
      return Err("Design source tree exceeds its depth budget.".into());
    }
    for entry in fs::read_dir(dir).map_err(|e| io_error(dir, e))? {
      let entry = entry.map_err(|e| io_error(dir, e))?;
      let name = entry.file_name().into_string().map_err(|_| "Design source file has an invalid UTF-8 name.")?;
      let ty = entry.file_type().map_err(|e| io_error(&entry.path(), e))?;
      if ty.is_symlink() && !skip_dir(&name) {
        return Err(format!("Design source does not follow symbolic links: {}", entry.path().display()));
      }
      if ty.is_dir() {
        if !skip_dir(&name) {
          no_link(&entry.path())?;
          walk(root, &entry.path(), depth + 1, budget, files)?;
        }
      } else if relevant_file(&name) {
        no_link(&entry.path())?;
        if !ty.is_file() {
          return Err("Design source contains an unsupported non-regular file.".into());
        }
        if files.len() >= MAX_SOURCE_FILES {
          return Err("Design source tree exceeds 20,000 relevant files.".into());
        }
        let relative = entry
          .path()
          .strip_prefix(root)
          .map_err(|_| "Design source escaped the project.")?
          .to_string_lossy()
          .replace('\\', "/");
        let bytes = read_bytes(&confined(root, &relative)?, MAX_SOURCE_FILE)?;
        *budget += bytes.len();
        if *budget > MAX_SOURCE_BYTES {
          return Err("Design source tree exceeds its 128 MiB content budget.".into());
        }
        files.insert(relative, SourceFile { hash: digest(&bytes), bytes });
      }
    }
    Ok(())
  }
  let root = fs::canonicalize(root).map_err(|e| io_error(root, e))?;
  let mut files = BTreeMap::new();
  walk(&root, &root, 0, &mut 0, &mut files)?;
  let mut hasher = Sha256::new();
  hasher.update(b"rayfin-design-source-v1\0");
  for (path, file) in &files {
    hasher.update((path.len() as u64).to_le_bytes());
    hasher.update(path.as_bytes());
    hasher.update((file.bytes.len() as u64).to_le_bytes());
    hasher.update(file.hash.as_bytes());
  }
  Ok(SourceSnapshot { revision: format!("sha256:{}", hex::encode(hasher.finalize())), files })
}

pub fn changed_files(baseline: &Baseline, after: &SourceSnapshot) -> Vec<String> {
  let paths: BTreeSet<&String> = baseline.files.keys().chain(after.files.keys()).collect();
  paths
    .into_iter()
    .filter(|path| baseline.files.get(*path) != after.files.get(*path).map(|f| &f.hash))
    .cloned()
    .collect()
}

pub fn image_format(bytes: &[u8]) -> Result<(&'static str, &'static str), String> {
  if bytes.is_empty() || bytes.len() > contract::MAX_IMAGE_BYTES {
    return Err("Design image is empty or exceeds 10 MiB.".into());
  }
  if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
    && bytes.len() >= 45
    && &bytes[12..16] == b"IHDR"
    && bytes.windows(4).any(|w| w == b"IEND")
  {
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width > 0 && height > 0 && u64::from(width) * u64::from(height) <= 100_000_000 {
      return Ok(("image/png", "png"));
    }
  }
  if bytes.len() >= 16 && bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9]) {
    return Ok(("image/jpeg", "jpg"));
  }
  if bytes.len() >= 14 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) && bytes.last() == Some(&0x3b)
  {
    let width = u16::from_le_bytes(bytes[6..8].try_into().unwrap()) as u64;
    let height = u16::from_le_bytes(bytes[8..10].try_into().unwrap()) as u64;
    if width > 0 && height > 0 && width * height <= 100_000_000 {
      return Ok(("image/gif", "gif"));
    }
  }
  if bytes.len() >= 30
    && bytes.starts_with(b"RIFF")
    && &bytes[8..12] == b"WEBP"
    && (u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize).checked_add(8) == Some(bytes.len())
    && matches!(&bytes[12..16], b"VP8 " | b"VP8L" | b"VP8X")
  {
    return Ok(("image/webp", "webp"));
  }
  Err("Unsupported or invalid image. Choose PNG, JPEG, GIF or WebP (up to 10 MiB); SVG is explicitly unsupported because it can contain active content.".into())
}

#[cfg(test)]
pub fn test_dir() -> PathBuf {
  let path =
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".native-design-tests").join(uuid::Uuid::new_v4().to_string());
  fs::create_dir_all(&path).unwrap();
  path
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn design_atomic_replacement_and_corrupt_storage_are_explicit() {
    let dir = test_dir();
    let file = dir.join("draft.json");
    atomic_write(&file, br#"{"revision":1}"#).unwrap();
    atomic_write(&file, br#"{"revision":2}"#).unwrap();
    assert_eq!(read_json::<serde_json::Value>(&file, 100).unwrap().unwrap()["revision"], 2);
    atomic_write(&file, b"{broken").unwrap();
    assert!(read_json::<serde_json::Value>(&file, 100).is_err());
    assert!(read_json::<serde_json::Value>(&dir.join("missing"), 100).unwrap().is_none());
    fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn design_explicit_fresh_start_preserves_corrupt_raw_records_for_recovery() {
    let dir = test_dir();
    let project = ProjectDesign { project_id: "p".into(), project_path: dir.clone(), dir: dir.join("private") };
    atomic_write(&project.dir.join("draft.json"), b"{damaged draft").unwrap();
    atomic_write(&project.dir.join("receipt.json"), b"damaged receipt").unwrap();
    assert!(project.load_draft().is_err());
    assert!(project.load_receipt().is_err());
    project.archive_and_clear().unwrap();
    assert!(project.load_draft().unwrap().is_none());
    assert!(project.load_receipt().unwrap().is_none());
    let reset = project.fresh_start().unwrap().unwrap();
    let archive = project.dir.join("discarded").join(reset.archive_id);
    assert_eq!(read_bytes(&archive.join("draft.json"), 100).unwrap(), b"{damaged draft");
    assert_eq!(read_bytes(&archive.join("receipt.json"), 100).unwrap(), b"damaged receipt");
    fs::remove_dir_all(dir).unwrap();
  }

  #[cfg(windows)]
  #[test]
  fn design_atomic_replace_waits_for_short_windows_read_locks() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = test_dir();
    let path = dir.join("draft.json");
    atomic_write(&path, b"before").unwrap();
    let read_lock = OpenOptions::new().read(true).share_mode(0x1 | 0x2).open(&path).unwrap();
    let release = std::thread::spawn(move || {
      std::thread::sleep(std::time::Duration::from_millis(75));
      drop(read_lock);
    });
    atomic_write(&path, b"after").unwrap();
    release.join().unwrap();
    assert_eq!(read_bytes(&path, 100).unwrap(), b"after");
    fs::remove_dir_all(dir).unwrap();
  }

  #[cfg(windows)]
  #[test]
  fn design_windows_long_paths_preserve_baselines_drafts_receipts_and_assets() {
    use std::os::windows::ffi::OsStrExt;

    struct Fixture(PathBuf);
    impl Drop for Fixture {
      fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
      }
    }

    let fixture = Fixture(test_dir());
    let root = fixture.0.join("project");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src").join("App.tsx"), "export const title = 'Original heading';").unwrap();
    let project_id = "long-path-project";
    let apply_id = "long-path-apply";
    let project_hash = digest(project_id.as_bytes());
    let apply_hash = digest(apply_id.as_bytes());
    let source_path = "src/App.tsx";
    let file_hash = digest(source_path.as_bytes());
    let project = ProjectDesign {
      project_id: project_id.into(),
      project_path: root.clone(),
      dir: fixture
        .0
        .join("session-state")
        .join(uuid::Uuid::new_v4().to_string())
        .join("files")
        .join("design-native-data")
        .join("design")
        .join(&project_hash),
    };
    let blob = project.apply_dir(apply_id).unwrap().join("baseline").join(format!("{file_hash}.bin"));
    assert!(project.dir.join("draft.json").as_os_str().encode_wide().count() > 260);
    assert!(blob.as_os_str().encode_wide().count() > 260);
    assert_eq!(project_hash.len(), 64);
    assert_eq!(apply_hash.len(), 64);
    assert_eq!(file_hash.len(), 64);
    assert_eq!(project.apply_dir(apply_id).unwrap().file_name().unwrap(), format!("apply-{apply_hash}").as_str());

    let source = source_snapshot(&root).unwrap();
    let mut draft: DesignDraft = serde_json::from_value(serde_json::json!({
      "schemaVersion":1,"projectId":project_id,"sessionId":"durable-draft","revision":1,"source":"local",
      "route":"/","sourceRevision":source.revision,"cursor":1,"history":[{
        "id":"text-change","label":"Edit heading","route":"/","edits":[{
          "kind":"text","target":{"id":"heading","selector":"h1","tag":"h1","label":"Heading"},
          "before":{"value":"Original heading"},"after":{"value":"Updated heading"}
        }]
      }]
    }))
    .unwrap();
    project.save_baseline(apply_id, &draft, &source).unwrap_or_else(|error| {
      panic!("long-path baseline copy failed (parent exists: {}): {error}", blob.parent().unwrap().is_dir());
    });
    let baseline = project.load_baseline(apply_id).unwrap();
    assert_eq!(read_bytes(&blob, MAX_SOURCE_FILE).unwrap(), source.files[source_path].bytes);
    assert_eq!(project.baseline_bytes(&baseline, source_path).unwrap().unwrap(), source.files[source_path].bytes);
    project.save_draft(draft.clone()).unwrap();
    draft.revision += 1;
    draft.viewport_width = Some(1024.0);
    project.save_draft(draft.clone()).unwrap();
    assert_eq!(project.load_draft().unwrap().unwrap().revision, draft.revision);

    let mut receipt = ReceiptRecord {
      schema_version: 1,
      finished: false,
      receipt: DesignApplyReceipt {
        id: apply_id.into(),
        project_id: project_id.into(),
        draft_revision: 1,
        turn_id: apply_id.into(),
        phase: contract::ApplyPhase::Editing,
        source_revision_before: source.revision.clone(),
        source_revision_after: None,
        files_modified: vec![],
        error: None,
        deployment: None,
      },
    };
    project.save_receipt(&receipt).unwrap();
    receipt.receipt.phase = contract::ApplyPhase::NeedsReview;
    receipt.receipt.error = Some("Exercise atomic receipt replacement on a long path.".into());
    project.save_receipt(&receipt).unwrap();
    assert_eq!(project.load_receipt().unwrap().unwrap().receipt.phase, contract::ApplyPhase::NeedsReview);
    let historical: ReceiptRecord =
      read_json(&project.apply_dir(apply_id).unwrap().join("receipt.json"), contract::MAX_DRAFT_BYTES)
        .unwrap()
        .unwrap();
    assert_eq!(historical.receipt.id, apply_id);

    let png = base64::engine::general_purpose::STANDARD
      .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=")
      .unwrap();
    let picked = fixture.0.join("picked.png");
    fs::write(&picked, &png).unwrap();
    let asset = project.import_asset(&picked).unwrap();
    assert_eq!(project.asset_bytes(&asset.id).unwrap().1, png);
    assert!(project.asset_preview(&asset.id).unwrap().starts_with("data:image/png;base64,"));
    assert!(confined_for_create(&root, "../outside.png").is_err());
    assert!(confined(&root, "../outside.png").is_err());
    project.archive_and_clear().unwrap();
    assert!(project.load_draft().unwrap().is_none());
    assert!(project.load_receipt().unwrap().is_none());
    assert_eq!(project.baseline_bytes(&baseline, source_path).unwrap().unwrap(), source.files[source_path].bytes);
    assert_eq!(project.asset_bytes(&asset.id).unwrap().1, png);
    assert_eq!(source_snapshot(&root).unwrap().revision, source.revision);
  }

  #[test]
  fn design_source_revision_hashes_bytes_and_excludes_secrets_and_generated() {
    let dir = test_dir();
    fs::create_dir(dir.join("src")).unwrap();
    fs::create_dir(dir.join("node_modules")).unwrap();
    fs::write(dir.join("src").join("index.ts"), "export const x = 1").unwrap();
    fs::write(dir.join(".env"), "secret=one").unwrap();
    let original_time = fs::metadata(dir.join("src").join("index.ts")).unwrap().modified().unwrap();
    let first = source_snapshot(&dir).unwrap().revision;
    fs::write(dir.join(".env"), "secret=two").unwrap();
    fs::write(dir.join("node_modules").join("x.ts"), "generated").unwrap();
    assert_eq!(first, source_snapshot(&dir).unwrap().revision);
    fs::write(dir.join("src").join("index.ts"), "export const x = 2").unwrap();
    fs::File::options()
      .write(true)
      .open(dir.join("src").join("index.ts"))
      .unwrap()
      .set_times(fs::FileTimes::new().set_modified(original_time))
      .unwrap();
    assert_ne!(first, source_snapshot(&dir).unwrap().revision);
    fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn design_theme_token_files_are_source_not_credentials() {
    assert!(relevant_file("tokens.json"));
    assert!(relevant_file("tokens.css"));
    assert!(!relevant_file("access-token.json"));
    assert!(!relevant_file(".env.local"));
    assert!(!relevant_file("secrets.json"));
  }

  #[test]
  fn design_verified_archive_retention_does_not_allow_replaying_old_apply_ids() {
    let dir = test_dir();
    let root = dir.join("project");
    fs::create_dir(&root).unwrap();
    let project = ProjectDesign { project_id: "p".into(), project_path: root.clone(), dir: dir.join("private") };
    let source = source_snapshot(&root).unwrap();
    let draft: DesignDraft = serde_json::from_value(serde_json::json!({
      "schemaVersion":1,"projectId":"p","sessionId":"s","revision":1,"source":"local",
      "route":"/","sourceRevision":source.revision,"history":[],"cursor":0
    }))
    .unwrap();
    for index in 0..MAX_BASELINES {
      let id = format!("apply-{index}");
      project.save_baseline(&id, &draft, &source).unwrap();
      write_json(&project.apply_dir(&id).unwrap().join("applied-draft.json"), &draft, contract::MAX_DRAFT_BYTES)
        .unwrap();
    }
    project.save_baseline("latest", &draft, &source).unwrap();
    let retired: RetiredApplies =
      read_json(&project.dir.join("retired-applies.json"), 2 * 1024 * 1024).unwrap().unwrap();
    assert_eq!(retired.ids.len(), 1);
    let old = retired.ids.iter().next().unwrap();
    assert!(!project.apply_dir(old).unwrap().exists());
    assert!(project.save_baseline(old, &draft, &source).unwrap_err().contains("already used"));
    assert_eq!(
      fs::read_dir(&project.dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("apply-"))
        .count(),
      MAX_BASELINES
    );
    fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn design_chart_asset_id_data_columns_are_not_import_paths() {
    let dir = test_dir();
    let project = ProjectDesign { project_id: "p".into(), project_path: dir.clone(), dir: dir.join("private") };
    let draft: DesignDraft = serde_json::from_value(serde_json::json!({
      "schemaVersion":1,"projectId":"p","sessionId":"s","revision":1,"source":"local","route":"/",
      "sourceRevision":format!("sha256:{}", "a".repeat(64)),"cursor":1,"history":[{
        "id":"chart-change","label":"Edit chart","route":"/","edits":[{
          "kind":"chart","target":{"id":"n","selector":"figure","tag":"figure","label":"Chart"},
          "before":null,"after":{"data":[{"assetId":"business-data-id"}]}
        }]
      }]
    }))
    .unwrap();
    assert!(project.materialize_assets(&draft).unwrap().is_empty());
    fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn design_assets_stage_original_bytes_and_reject_svg_and_path_escape() {
    let dir = test_dir();
    let root = dir.join("project");
    fs::create_dir(&root).unwrap();
    let store = ProjectDesign { project_id: "project-1".into(), project_path: root.clone(), dir: dir.join("private") };
    let bytes = base64::engine::general_purpose::STANDARD
      .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=")
      .unwrap();
    let picked = dir.join("cat.png");
    fs::write(&picked, &bytes).unwrap();
    let asset = store.import_asset(&picked).unwrap();
    assert!(asset.project_path.is_none());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    assert_eq!(store.asset_bytes(&asset.id).unwrap().1, bytes);
    assert!(store.asset_preview(&asset.id).unwrap().starts_with("data:image/png;base64,"));
    assert_eq!(store.import_asset(&picked).unwrap().id, asset.id);
    let draft: DesignDraft = serde_json::from_value(serde_json::json!({
      "schemaVersion":1,"projectId":"project-1","sessionId":"s","revision":1,"source":"local",
      "route":"/","sourceRevision":source_snapshot(&root).unwrap().revision,"cursor":1,
      "history":[{
        "id":"image-change","label":"Replace image","route":"/","edits":[{
          "kind":"image","target":{"id":"i","selector":"img","tag":"img","label":"Image"},
          "before":null,"after":{"assetId":asset.id,"alt":"A cat"}
        }]
      }]
    }))
    .unwrap();
    let paths = store.materialize_assets(&draft).unwrap();
    let copied = root.join(&paths[&asset.id]);
    assert_eq!(read_bytes(&copied, contract::MAX_IMAGE_BYTES).unwrap(), bytes);
    fs::remove_file(copied).unwrap();
    // Retrying copies from immutable app-data originals, not from the upload
    // or a screenshot that another workflow is allowed to clean.
    fs::remove_file(&picked).unwrap();
    store.materialize_assets(&draft).unwrap();
    assert_eq!(store.asset_bytes(&asset.id).unwrap().1, bytes);
    fs::write(&picked, b"<svg onload='alert(1)'/>").unwrap();
    assert!(store.import_asset(&picked).unwrap_err().contains("SVG"));
    assert!(store.asset_bytes("..\\secret").is_err());
    assert!(confined_for_create(&root, "../escape").is_err());
    fs::remove_dir_all(dir).unwrap();
  }
}
