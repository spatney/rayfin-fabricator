//! Project thumbnails: a small WebP of each project's app, drawn from its
//! preview by the renderer (after the preview loads, or after a publish), kept
//! on this computer (`paths::thumbnails_dir`). Home and the app gallery show
//! them in place of a project's letters.

use std::collections::HashMap;
use std::path::Path;

use base64::Engine;

use crate::services::{paths, store};

/// The largest thumbnail kept. They're drawn at a few hundred pixels wide, so
/// they're tens of kilobytes; anything near this isn't one.
const MAX_BYTES: usize = 512 * 1024;
const DATA_URL_PREFIX: &str = "data:image/webp;base64,";

/// A WebP image's bytes: a RIFF container of the WEBP form.
fn is_webp(bytes: &[u8]) -> bool {
  bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

/// The image in a WebP `data:` URL, or why it isn't one Fabricator keeps.
fn decode(data_url: &str) -> Result<Vec<u8>, String> {
  let b64 = data_url
    .strip_prefix(DATA_URL_PREFIX)
    .ok_or_else(|| "A thumbnail must be a WebP image.".to_string())?;
  if b64.len() > MAX_BYTES * 4 / 3 + 4 {
    return Err("That thumbnail is too large.".into());
  }
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(b64.trim().as_bytes())
    .map_err(|_| "That thumbnail isn't a WebP image.".to_string())?;
  if bytes.len() > MAX_BYTES {
    return Err("That thumbnail is too large.".into());
  }
  if !is_webp(&bytes) {
    return Err("That thumbnail isn't a WebP image.".into());
  }
  Ok(bytes)
}

fn data_url(bytes: &[u8]) -> String {
  format!("{DATA_URL_PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// When a file was last written, as RFC 3339 (milliseconds, UTC).
fn modified_at(path: &Path) -> Option<String> {
  let modified = std::fs::metadata(path).ok()?.modified().ok()?;
  Some(chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Write `bytes` to `path` whole: to a sibling first, then moved over it, so a
/// reader never sees half an image.
fn write_whole(path: &Path, bytes: &[u8]) -> Result<(), String> {
  let dir = path.parent().ok_or_else(|| "No folder for thumbnails.".to_string())?;
  std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't save the thumbnail: {e}"))?;
  let partial = path.with_extension(format!("{}.partial", uuid::Uuid::new_v4().simple()));
  std::fs::write(&partial, bytes).map_err(|e| format!("Couldn't save the thumbnail: {e}"))?;
  std::fs::rename(&partial, path).map_err(|e| {
    let _ = std::fs::remove_file(&partial);
    format!("Couldn't save the thumbnail: {e}")
  })
}

fn read_at(path: &Path) -> Option<String> {
  let bytes = std::fs::read(path).ok()?;
  (bytes.len() <= MAX_BYTES && is_webp(&bytes)).then(|| data_url(&bytes))
}

/// Keep a project's thumbnail (a WebP `data:` URL). Returns when it was saved,
/// as the project's `thumbnail_at` reports it.
pub fn save(project_id: &str, image: &str) -> Result<String, String> {
  if store::find_project(project_id).is_none() {
    return Err("That project isn't in Fabricator anymore.".into());
  }
  let bytes = decode(image)?;
  let path = paths::thumbnail_file(project_id);
  write_whole(&path, &bytes)?;
  Ok(modified_at(&path).unwrap_or_else(crate::commands::util::now_iso))
}

/// When a project's thumbnail was saved, or `None` while it has none.
pub fn saved_at(project_id: &str) -> Option<String> {
  modified_at(&paths::thumbnail_file(project_id))
}

/// The projects' thumbnails as `data:` URLs, by id; projects without one are left out.
pub fn read_many(project_ids: &[String]) -> HashMap<String, String> {
  project_ids
    .iter()
    .filter_map(|id| read_at(&paths::thumbnail_file(id)).map(|url| (id.clone(), url)))
    .collect()
}

/// Drop a project's thumbnail (it was removed from Fabricator). Best-effort.
pub fn forget(project_id: &str) {
  let _ = std::fs::remove_file(paths::thumbnail_file(project_id));
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The smallest well-formed WebP header, with a few bytes of "image".
  fn webp() -> Vec<u8> {
    let mut bytes = b"RIFF\x10\x00\x00\x00WEBPVP8 ".to_vec();
    bytes.extend_from_slice(&[1, 2, 3, 4]);
    bytes
  }

  #[test]
  fn only_webp_data_urls_are_kept() {
    let image = webp();
    assert_eq!(decode(&data_url(&image)).unwrap(), image);
    let png = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n...."));
    assert!(decode(&png).is_err(), "another type");
    let lying = format!("{DATA_URL_PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(b"<svg onload=alert(1)>"));
    assert!(decode(&lying).is_err(), "a WebP label on something else");
    assert!(decode(&format!("{DATA_URL_PREFIX}not base64!")).is_err());
    let huge = data_url(&[webp(), vec![0; MAX_BYTES]].concat());
    assert!(decode(&huge).unwrap_err().contains("too large"));
  }

  #[test]
  fn a_saved_thumbnail_reads_back_whole_and_says_when() {
    let dir = std::env::temp_dir().join(format!("fab-thumbs-{}", uuid::Uuid::new_v4()));
    let path = dir.join("p1.webp");
    assert_eq!(read_at(&path), None, "none yet");
    write_whole(&path, &webp()).unwrap();
    assert_eq!(read_at(&path).unwrap(), data_url(&webp()));
    assert!(modified_at(&path).unwrap().ends_with('Z'));
    // Saving again replaces it, and leaves nothing else behind.
    let mut next = webp();
    next.push(9);
    write_whole(&path, &next).unwrap();
    assert_eq!(read_at(&path).unwrap(), data_url(&next));
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    // A file that isn't a thumbnail isn't served as one.
    std::fs::write(&path, b"not an image").unwrap();
    assert_eq!(read_at(&path), None);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
