//! Screenshot persistence for region-capture attachments. Ported from
//! `src/main/services/screenshot.ts`. Deferred for the MVP per the migration
//! plan, but the save/cleanup plumbing is implemented so chat attachments work.

use std::path::PathBuf;

use base64::Engine;

use crate::services::paths;

const PENDING: &str = "Screenshot capture is deferred in the Tauri build.";

/// Persist a PNG data URL to a temp file under Studio's shots dir; returns its path.
#[tauri::command]
pub async fn screenshot_save(data_url: String) -> Result<String, String> {
  let comma = data_url.find(',').ok_or_else(|| PENDING.to_string())?;
  let b64 = &data_url[comma + 1..];
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(b64.as_bytes())
    .map_err(|e| e.to_string())?;
  let dir = paths::shots_dir();
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let name = format!("shot-{}.png", uuid::Uuid::new_v4());
  let path = dir.join(name);
  std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
  Ok(path.to_string_lossy().to_string())
}

/// Best-effort delete of temp screenshot files (only within Studio's shots dir).
#[tauri::command]
pub async fn screenshot_cleanup(paths: Vec<String>) {
  cleanup(&paths);
}

/// Delete the given temp screenshot files, restricted to Studio's shots dir.
/// Shared by the `screenshot_cleanup` command and the chat turn engine.
pub fn cleanup(paths: &[String]) {
  let Ok(shots) = std::fs::canonicalize(crate::services::paths::shots_dir()) else { return; };
  for p in paths {
    if let Some(owned) = owned_capture(&shots, &PathBuf::from(p)) {
      let _ = std::fs::remove_file(owned);
    }
  }
}

fn owned_capture(shots: &std::path::Path, path: &std::path::Path) -> Option<PathBuf> {
  let canonical = std::fs::canonicalize(path).ok()?;
  // Lexical starts_with allowed shots/../... to delete persistent assets.
  // Captures are immediate files, never descendants or aliases outside shots.
  if canonical.parent() != Some(shots) { return None; }
  let metadata = std::fs::symlink_metadata(path).ok()?;
  (metadata.is_file() && !metadata.file_type().is_symlink()).then_some(canonical)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn design_screenshot_cleanup_cannot_escape_into_persistent_assets() {
    let dir = crate::services::design_store::test_dir();
    let shots = dir.join("shots");
    let assets = dir.join("assets");
    std::fs::create_dir(&shots).unwrap();
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(shots.join("shot-1.png"), b"capture").unwrap();
    std::fs::write(assets.join("original.bin"), b"persistent").unwrap();
    let canonical = std::fs::canonicalize(&shots).unwrap();
    assert!(owned_capture(&canonical, &shots.join("shot-1.png")).is_some());
    assert!(owned_capture(&canonical, &shots.join("..").join("assets").join("original.bin")).is_none());
    assert_eq!(std::fs::read(assets.join("original.bin")).unwrap(), b"persistent");
    std::fs::remove_dir_all(dir).unwrap();
  }
}
