//! Saving the app's local data as its seed data (`rayfin/seed`, the rows and
//! files a project declares for local development). rayfin-local exports the
//! data in that form, and Fabricator writes it: rayfin-local writes nothing
//! outside `.rayfin-local`.
//!
//! The files are written to a hidden folder in `rayfin/seed` first, which
//! rayfin-local doesn't read and git ignores, then swapped in for
//! `rayfin/seed/data` and `rayfin/seed/storage` all or nothing, so a save that
//! fails part way leaves the seed data as it was.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use super::control::{error, ControlClient, SeedExport};
use crate::types::{LocalCommandError, LocalSeedSaved};

/// The folders of `rayfin/seed` a save replaces.
pub const PARTS: [&str; 2] = ["data", "storage"];

/// Write the local data to `<project>/rayfin/seed`, in place of its rows and
/// files. Other files there, such as a README, stay.
pub async fn save(control: &ControlClient, project: &Path) -> Result<LocalSeedSaved, LocalCommandError> {
  let export = control.export_seed().await?;
  if export.data.is_empty() && export.storage.is_empty() {
    return Err(error(
      "nothing-to-save",
      t!("services.localBackend.seedEmpty"),
      Some(&t!("services.localBackend.seedEmptyHint")),
    ));
  }
  let seed = project.join("rayfin").join("seed");
  let staging = seed.join(format!(".saving-{}", uuid::Uuid::new_v4().simple()));
  let written = match write_all(control, &export, &staging).await {
    Ok(written) => swap(&seed, &staging).map(|()| written),
    Err(e) => Err(e),
  };
  let _ = tokio::fs::remove_dir_all(&staging).await;
  written
}

async fn write_all(control: &ControlClient, export: &SeedExport, staging: &Path) -> Result<LocalSeedSaved, LocalCommandError> {
  let mut saved = LocalSeedSaved {
    skipped: export.skipped.iter().map(|file| format!("{}/{}: {}", file.folder, file.path, file.message)).collect(),
    ..Default::default()
  };
  // Ignores the whole folder, itself included, so that a chat turn's commit
  // can't take it in, even when a program holding one of its files open keeps
  // it from being deleted.
  write(&staging.join(".gitignore"), b"*\n".to_vec()).await?;
  for table in &export.data {
    write(&staging.join(relative(&table.file)?), pretty(&Value::Array(table.rows.clone()))).await?;
    saved.entities += 1;
    saved.rows += table.rows.len() as u64;
  }
  for folder in &export.storage {
    if let Some(manifest) = folder.manifest.as_ref().filter(|manifest| !manifest.is_null()) {
      write(&staging.join(relative(&folder.manifest_file)?), pretty(manifest)).await?;
    }
    let dir = staging.join(relative(&folder.dir)?);
    for file in &folder.files {
      let target = dir.join(relative(&file.path)?);
      let bytes = control.file(&folder.folder, &file.path).await?;
      write(&target, bytes).await?;
      saved.files += 1;
    }
  }
  Ok(saved)
}

/// Pretty JSON, as people write it, with a final newline.
fn pretty(value: &Value) -> Vec<u8> {
  let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
  text.push('\n');
  text.into_bytes()
}

async fn write(path: &Path, bytes: Vec<u8>) -> Result<(), LocalCommandError> {
  let failed = |e: std::io::Error| {
    error(
      "save-failed",
      t!("services.localBackend.seedWriteFailed", path = path.display(), error = e),
      Some(&t!("services.localBackend.seedWriteFailedHint")),
    )
  };
  if let Some(parent) = path.parent() {
    tokio::fs::create_dir_all(parent).await.map_err(failed)?;
  }
  tokio::fs::write(path, bytes).await.map_err(failed)
}

/// A `/`-separated path from rayfin-local as a relative path that stays in
/// the folder it's joined to: plain names only, none that a file system would
/// read as a drive, a parent or a separator.
fn relative(path: &str) -> Result<PathBuf, LocalCommandError> {
  let mut relative = PathBuf::new();
  for name in path.split('/') {
    let plain = !name.contains(['\\', ':'])
      && matches!(Path::new(name).components().collect::<Vec<_>>().as_slice(), [Component::Normal(_)]);
    if !plain {
      return Err(error(
        "save-failed",
        t!("services.localBackend.seedBadName", name = format!("{path:?}")),
        Some(&t!("services.localBackend.seedBadNameHint")),
      ));
    }
    relative.push(name);
  }
  Ok(relative)
}

/// Put the staged folders in place of `rayfin/seed/data` and
/// `rayfin/seed/storage`, all or nothing: the current ones move into the
/// staging folder, to be deleted with it, then the staged ones move in, and
/// when a move fails, the ones before it are undone. Moves, unlike deletes,
/// can't stop part way when a program has a file open.
fn swap(seed: &Path, staging: &Path) -> Result<(), LocalCommandError> {
  swap_with(seed, staging, |from, to| std::fs::rename(from, to))
}

fn swap_with(
  seed: &Path,
  staging: &Path,
  rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), LocalCommandError> {
  let mut moves = Vec::new();
  for part in PARTS {
    if seed.join(part).symlink_metadata().is_ok() {
      moves.push((part, seed.join(part), staging.join(format!("old-{part}"))));
    }
  }
  for part in PARTS {
    if staging.join(part).exists() {
      moves.push((part, staging.join(part), seed.join(part)));
    }
  }
  for (done, (part, from, to)) in moves.iter().enumerate() {
    if let Err(e) = rename(from, to) {
      for (_, from, to) in moves[..done].iter().rev() {
        let _ = rename(to, from);
      }
      return Err(error(
        "save-failed",
        t!("services.localBackend.seedReplaceFailed", part = part, error = e),
        Some(&t!("services.localBackend.seedReplaceFailedHint")),
      ));
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn seed_paths_stay_in_their_folder() {
    assert_eq!(relative("data/Todo.json").unwrap(), Path::new("data").join("Todo.json"));
    assert_eq!(relative("a b/c.d.png").unwrap(), Path::new("a b").join("c.d.png"));
    for bad in ["", "a//b", "../x", "a/../b", "./a", "/a", "a\\b", "C:", "c:x", "ab:c", "a/"] {
      assert_eq!(relative(bad).unwrap_err().code, "save-failed", "{bad:?}");
    }
  }

  #[test]
  fn a_swap_that_fails_part_way_leaves_the_seed_data_as_it_was() {
    let seed = std::env::temp_dir().join(format!("fab-seed-swap-{}", uuid::Uuid::new_v4().simple()));
    let staging = seed.join(".saving-test");
    for (path, text) in [
      ("data/Old.json", "old"),
      ("storage/files/a.txt", "old"),
      (".saving-test/data/New.json", "new"),
      (".saving-test/storage/files/b.txt", "new"),
    ] {
      std::fs::create_dir_all(seed.join(path).parent().unwrap()).unwrap();
      std::fs::write(seed.join(path), text).unwrap();
    }
    let read = |path: &str| std::fs::read_to_string(seed.join(path)).ok();

    // The new storage can't move in, after the new data did.
    let failing = |from: &Path, to: &Path| {
      if from == staging.join("storage") {
        Err(std::io::Error::other("in use"))
      } else {
        std::fs::rename(from, to)
      }
    };
    assert_eq!(swap_with(&seed, &staging, failing).unwrap_err().code, "save-failed");
    assert_eq!((read("data/Old.json"), read("storage/files/a.txt")), (Some("old".into()), Some("old".into())));
    assert_eq!(read("data/New.json"), None);

    swap(&seed, &staging).unwrap();
    assert_eq!((read("data/New.json"), read("storage/files/b.txt")), (Some("new".into()), Some("new".into())));
    assert_eq!((read("data/Old.json"), read("storage/files/a.txt")), (None, None));
    let _ = std::fs::remove_dir_all(&seed);
  }
}
