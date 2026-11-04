//! Screenshot persistence for region-capture attachments. Ported from
//! `src/main/services/screenshot.ts`. Deferred for the MVP per the migration
//! plan, but the save/cleanup plumbing is implemented so chat attachments work.

use std::path::{Path, PathBuf};

use base64::Engine;

use crate::services::paths;

const PENDING: &str = "Screenshot capture is deferred in the Tauri build.";

/// The most an image read to attach may weigh.
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

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

/// An image file on this computer, dropped on or picked in the chat composer,
/// as a data URL: the renderer attaches it as it does a pasted image.
#[tauri::command]
pub async fn screenshot_read(path: String) -> Result<String, String> {
  tokio::task::spawn_blocking(move || read_image(Path::new(&path))).await.map_err(|e| e.to_string())?
}

fn read_image(path: &Path) -> Result<String, String> {
  let extension = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
  let mime = match extension.as_str() {
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "bmp" => "image/bmp",
    _ => return Err("Only PNG, JPEG, GIF, WebP and BMP images can be attached.".into()),
  };
  let size = std::fs::metadata(path).map_err(|e| format!("Couldn't read the image: {e}"))?.len();
  if size > MAX_IMAGE_BYTES {
    return Err("The image is too large to attach: the limit is 20 MB.".into());
  }
  let bytes = std::fs::read(path).map_err(|e| format!("Couldn't read the image: {e}"))?;
  Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
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

/// The canonical path of `path` when it is one of Fabricator's own temp
/// captures (a regular file directly inside the shots dir), else `None`.
pub fn owned_capture_path(path: &str) -> Option<PathBuf> {
  let shots = std::fs::canonicalize(crate::services::paths::shots_dir()).ok()?;
  owned_capture(&shots, &PathBuf::from(path))
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
  fn screenshot_cleanup_cannot_escape_into_persistent_files() {
    let dir = std::env::temp_dir().join(format!("fabricator-shots-test-{}", uuid::Uuid::new_v4()));
    let shots = dir.join("shots");
    let assets = dir.join("assets");
    std::fs::create_dir_all(&shots).unwrap();
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(shots.join("shot-1.png"), b"capture").unwrap();
    std::fs::write(assets.join("original.bin"), b"persistent").unwrap();
    let canonical = std::fs::canonicalize(&shots).unwrap();
    assert!(owned_capture(&canonical, &shots.join("shot-1.png")).is_some());
    assert!(owned_capture(&canonical, &shots.join("..").join("assets").join("original.bin")).is_none());
    assert_eq!(std::fs::read(assets.join("original.bin")).unwrap(), b"persistent");
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn only_images_are_read_to_attach() {
    let dir = std::env::temp_dir().join(format!("fabricator-read-image-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("Shot.PNG"), b"\x89PNG").unwrap();
    std::fs::write(dir.join("notes.txt"), b"secret").unwrap();
    assert_eq!(read_image(&dir.join("Shot.PNG")).unwrap(), "data:image/png;base64,iVBORw==");
    assert!(read_image(&dir.join("notes.txt")).unwrap_err().contains("Only PNG"));
    assert!(read_image(&dir.join("missing.jpg")).unwrap_err().starts_with("Couldn't read the image"));
    std::fs::remove_dir_all(dir).unwrap();
  }
}
