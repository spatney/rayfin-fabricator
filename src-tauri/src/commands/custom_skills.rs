//! The global, reusable **custom-skill library**.
//!
//! Unlike the built-in catalog (compiled into [`crate::commands::skills`]) or the
//! project-local `.agents/skills/` folders, library skills live once under the app
//! data dir (`<data_dir>/custom-skills/<id>/`) and can be toggled into *any*
//! project. Each library folder holds:
//!
//! ```text
//! <data_dir>/custom-skills/<id>/
//!   SKILL.md          # YAML frontmatter (name, description) + markdown body
//!   meta.json         # { title, description, icon } — card presentation only
//!   references/*.md   # optional supporting docs (copied into projects too)
//! ```
//!
//! Users add a skill by authoring one in-app or importing a folder / `.zip`, then
//! toggle it into a project from the Skills tab. Toggling copies `SKILL.md` (+
//! `references/`) into the project's `.agents/skills/<id>/` via
//! [`crate::commands::skills::skills_set`], which commits it so a plain `copilot`
//! CLI (and History) picks it up. `meta.json` stays library-only.
//!
//! Most functions take an explicit library `root: &Path` so they can be exercised
//! against a temp dir in tests; thin public wrappers pass the real
//! `<data_dir>/custom-skills`.

use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::services::{paths, store};
use crate::types::{CustomSkillActionResult, CustomSkillInfo, CustomSkillPreview, SkillSource};

/// Card-presentation sidecar stored next to each library `SKILL.md`.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Meta {
  title: String,
  description: String,
  icon: String,
}

/// Author/edit payload from the renderer. `id` is present when editing an
/// existing library skill; absent when creating a new one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSkillSaveInput {
  #[serde(default)]
  pub id: Option<String>,
  pub title: String,
  #[serde(default)]
  pub description: String,
  #[serde(default)]
  pub icon: Option<String>,
  /// The full SKILL.md the user authored/edited.
  pub content: String,
}

// ── Paths ────────────────────────────────────────────────────────────────────

/// Root of the custom-skill library under the app data dir.
fn library_root() -> PathBuf {
  paths::data_dir().join("custom-skills")
}

fn skill_dir(root: &Path, id: &str) -> PathBuf {
  root.join(id)
}

/// Reject ids that could escape the library root or aren't a plain slug.
fn is_safe_id(id: &str) -> bool {
  !id.is_empty()
    && id.len() <= 128
    && id
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/// Turn a human title/name into a filesystem-safe slug (`My Skill!` → `my-skill`).
fn slugify(input: &str) -> String {
  let mut out = String::new();
  let mut prev_dash = false;
  for ch in input.trim().chars() {
    if ch.is_ascii_alphanumeric() {
      out.push(ch.to_ascii_lowercase());
      prev_dash = false;
    } else if !out.is_empty() && !prev_dash {
      out.push('-');
      prev_dash = true;
    }
  }
  while out.ends_with('-') {
    out.pop();
  }
  out
}

/// Extract the YAML block between the leading `---` fences (BOM-tolerant).
fn extract_frontmatter(raw: &str) -> Option<String> {
  static FM_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---").unwrap());
  let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
  FM_RE
    .captures(text)
    .and_then(|c| c.get(1))
    .map(|m| m.as_str().to_string())
}

#[derive(Deserialize)]
struct Frontmatter {
  name: Option<String>,
  description: Option<String>,
}

/// Validate a SKILL.md: it must have a frontmatter block with a non-empty `name`
/// and `description`. Returns `(name, description)` on success.
fn parse_and_validate(content: &str) -> Result<(String, String), String> {
  let fm = extract_frontmatter(content)
    .ok_or("A skill must start with a YAML frontmatter block (--- … ---).")?;
  let parsed: Frontmatter =
    serde_yaml::from_str(&fm).map_err(|e| format!("Invalid skill frontmatter: {e}"))?;
  let name = parsed
    .name
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .ok_or("The skill's frontmatter needs a non-empty `name`.")?;
  let description = parsed
    .description
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .ok_or("The skill's frontmatter needs a non-empty `description`.")?;
  Ok((name, description))
}

/// Rewrite the frontmatter `name:` value to `id` so the on-disk folder, skill
/// name and library id all agree (matching the built-in catalog convention).
fn set_frontmatter_name(content: &str, id: &str) -> String {
  static BLOCK: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)^(---\r?\n)(.*?)(\r?\n---)").unwrap());
  static NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^([ \t]*name:[ \t]*)[^\r\n]*").unwrap());
  let (bom, body) = match content.strip_prefix('\u{feff}') {
    Some(b) => ("\u{feff}", b),
    None => ("", content),
  };
  if let Some(caps) = BLOCK.captures(body) {
    let open = caps.get(1).unwrap().as_str();
    let inner = caps.get(2).unwrap().as_str();
    let close = caps.get(3).unwrap().as_str();
    let after = &body[caps.get(3).unwrap().end()..];
    if NAME.is_match(inner) {
      let new_inner = NAME
        .replace(inner, |c: &regex::Captures| format!("{}{}", &c[1], id))
        .into_owned();
      return format!("{bom}{open}{new_inner}{close}{after}");
    }
  }
  content.to_string()
}

/// A friendly card title for an imported skill: keep a human `name`, else
/// title-case the slug id.
fn derive_title(name: &str, id: &str) -> String {
  let n = name.trim();
  if n.chars().any(|c| c == ' ' || c.is_uppercase()) {
    n.to_string()
  } else {
    crate::commands::skills::title_case(id)
  }
}

/// Trim `s` to at most `max` characters, adding an ellipsis when clipped.
fn truncate(s: &str, max: usize) -> String {
  let s = s.trim();
  if s.chars().count() <= max {
    return s.to_string();
  }
  let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
  out.push('…');
  out
}

fn ioerr(e: std::io::Error) -> String {
  format!("File error: {e}")
}

// ── Filesystem: meta + listing ───────────────────────────────────────────────

/// A skill's own folder (holds `SKILL.md`, `meta.json`, `references/`).
fn project_skill_folder(project_dir: &str, id: &str) -> PathBuf {
  Path::new(project_dir)
    .join(".agents")
    .join("skills")
    .join(id)
}

fn read_meta_file(folder: &Path) -> Option<Meta> {
  let raw = std::fs::read_to_string(folder.join("meta.json")).ok()?;
  serde_json::from_str(&raw).ok()
}

fn read_meta(root: &Path, id: &str) -> Option<Meta> {
  read_meta_file(&skill_dir(root, id))
}

/// Card presentation (title, description, icon) built from the authoring form,
/// with the frontmatter description as the fallback card text.
fn build_meta(title: &str, description: &str, icon: Option<&str>, fm_desc: &str) -> Meta {
  let description = if description.trim().is_empty() {
    truncate(fm_desc, 140)
  } else {
    description.trim().to_string()
  };
  let icon = icon
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "🧩".to_string());
  Meta {
    title: title.trim().to_string(),
    description,
    icon,
  }
}

/// Write a complete skill folder: `SKILL.md` (with its frontmatter `name`
/// normalized to `id`), the `meta.json` sidecar, and any `references/*.md`.
/// Used for both library folders and a project's `.agents/skills/<id>/`.
fn write_skill_folder(
  folder: &Path,
  id: &str,
  content: &str,
  meta: &Meta,
  refs_src: Option<&Path>,
) -> std::io::Result<()> {
  std::fs::create_dir_all(folder)?;
  std::fs::write(folder.join("SKILL.md"), set_frontmatter_name(content, id))?;
  let raw = serde_json::to_string_pretty(meta).unwrap_or_default();
  std::fs::write(folder.join("meta.json"), raw)?;
  if let Some(src) = refs_src {
    if src.is_dir() {
      copy_references(src, &folder.join("references")).map_err(std::io::Error::other)?;
    }
  }
  Ok(())
}

fn has_references(dir: &Path) -> bool {
  let refs = dir.join("references");
  refs.is_dir()
    && std::fs::read_dir(&refs)
      .map(|mut r| r.next().is_some())
      .unwrap_or(false)
}

fn library_skill_exists_at(root: &Path, id: &str) -> bool {
  is_safe_id(id) && skill_dir(root, id).join("SKILL.md").is_file()
}

/// One library entry, preferring `meta.json` and falling back to the SKILL.md
/// frontmatter for presentation.
fn read_entry(root: &Path, id: &str) -> Option<CustomSkillInfo> {
  let dir = skill_dir(root, id);
  if !dir.join("SKILL.md").is_file() {
    return None;
  }
  let (title, description, icon) = match read_meta(root, id) {
    Some(m) => (m.title, m.description, m.icon),
    None => {
      let raw = std::fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default();
      let desc = extract_frontmatter(&raw)
        .and_then(|fm| serde_yaml::from_str::<Frontmatter>(&fm).ok())
        .and_then(|p| p.description)
        .map(|s| truncate(&s, 140))
        .unwrap_or_else(|| "A custom skill.".to_string());
      (
        crate::commands::skills::title_case(id),
        desc,
        "🧩".to_string(),
      )
    }
  };
  Some(CustomSkillInfo {
    id: id.to_string(),
    title,
    description,
    icon,
    has_references: has_references(&dir),
  })
}

fn list_library_at(root: &Path) -> Vec<CustomSkillInfo> {
  let mut out = Vec::new();
  let entries = match std::fs::read_dir(root) {
    Ok(e) => e,
    Err(_) => return out,
  };
  for entry in entries.flatten() {
    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
      continue;
    }
    let id = entry.file_name().to_string_lossy().to_string();
    if !is_safe_id(&id) {
      continue;
    }
    if let Some(info) = read_entry(root, &id) {
      out.push(info);
    }
  }
  out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
  out
}

fn read_source_at(root: &Path, id: &str) -> Option<String> {
  if !is_safe_id(id) {
    return None;
  }
  std::fs::read_to_string(skill_dir(root, id).join("SKILL.md")).ok()
}

// ── Write: save / import / remove / install ──────────────────────────────────

/// A composed new skill ready to write into a project (and optionally the library).
#[derive(Debug)]
struct Composed {
  id: String,
  content: String,
  meta: Meta,
}

/// Validate + derive a new authored skill from the form. `project_dir` / `root`
/// are used to reject ids that already exist in this app or (when saving to the
/// library) the library.
fn compose_new(
  root: &Path,
  project_dir: &str,
  input: &CustomSkillSaveInput,
  to_library: bool,
) -> Result<Composed, String> {
  let (_name, fm_desc) = parse_and_validate(&input.content)?;
  let title = input.title.trim().to_string();
  if title.is_empty() {
    return Err("Give the skill a title.".into());
  }
  let id = slugify(&title);
  if id.is_empty() {
    return Err("Couldn't make an id from that title — use letters or numbers.".into());
  }
  if crate::commands::skills::is_reserved_id(&id) {
    return Err(format!(
      "“{id}” is a built-in skill id — pick a different title."
    ));
  }
  if project_skill_folder(project_dir, &id)
    .join("SKILL.md")
    .is_file()
  {
    return Err(format!("A skill “{id}” already exists in this app."));
  }
  if to_library && library_skill_exists_at(root, &id) {
    return Err(format!("A custom skill “{id}” is already in your library."));
  }
  let meta = build_meta(&title, &input.description, input.icon.as_deref(), &fm_desc);
  Ok(Composed {
    id,
    content: input.content.clone(),
    meta,
  })
}

/// Update an existing library skill in place (the Edit flow, offered only on
/// library skills).
fn save_library_edit(root: &Path, input: &CustomSkillSaveInput) -> Result<String, String> {
  let (_name, fm_desc) = parse_and_validate(&input.content)?;
  let id = input.id.as_deref().unwrap_or_default().trim().to_string();
  if !is_safe_id(&id) || !library_skill_exists_at(root, &id) {
    return Err("That custom skill no longer exists.".into());
  }
  let title = input.title.trim().to_string();
  if title.is_empty() {
    return Err("Give the skill a title.".into());
  }
  let meta = build_meta(&title, &input.description, input.icon.as_deref(), &fm_desc);
  write_skill_folder(&skill_dir(root, &id), &id, &input.content, &meta, None).map_err(ioerr)?;
  Ok(id)
}

/// Copy `references/*.md` from `src` into `dst` (flat, markdown-only).
fn copy_references(src: &Path, dst: &Path) -> Result<(), String> {
  if !src.is_dir() {
    return Ok(());
  }
  std::fs::create_dir_all(dst).map_err(ioerr)?;
  for entry in std::fs::read_dir(src).map_err(ioerr)?.flatten() {
    let p = entry.path();
    let is_md = p
      .extension()
      .map(|e| e.eq_ignore_ascii_case("md"))
      .unwrap_or(false);
    if p.is_file() && is_md {
      if let Some(f) = p.file_name() {
        std::fs::copy(&p, dst.join(f)).map_err(ioerr)?;
      }
    }
  }
  Ok(())
}

/// Install an imported skill (`content` + optional `refs_src`) into a project, and
/// optionally into the library too. Returns `(id, title)`.
fn install_import(
  root: &Path,
  project_dir: &str,
  content: &str,
  refs_src: Option<&Path>,
  to_library: bool,
) -> Result<(String, String), String> {
  let (name, fm_desc) = parse_and_validate(content)?;
  let id = slugify(&name);
  if id.is_empty() {
    return Err("Couldn't derive an id from the skill name — it needs letters or numbers.".into());
  }
  if crate::commands::skills::is_reserved_id(&id) {
    return Err(format!(
      "“{id}” is a built-in skill id — rename the skill before adding it."
    ));
  }
  if project_skill_folder(project_dir, &id)
    .join("SKILL.md")
    .is_file()
  {
    return Err(format!("A skill “{id}” already exists in this app."));
  }
  if to_library && library_skill_exists_at(root, &id) {
    return Err(format!("A custom skill “{id}” is already in your library."));
  }
  let meta = Meta {
    title: derive_title(&name, &id),
    description: truncate(&fm_desc, 140),
    icon: "🧩".to_string(),
  };
  write_skill_folder(
    &project_skill_folder(project_dir, &id),
    &id,
    content,
    &meta,
    refs_src,
  )
  .map_err(ioerr)?;
  if to_library {
    write_skill_folder(&skill_dir(root, &id), &id, content, &meta, refs_src).map_err(ioerr)?;
  }
  Ok((id, meta.title))
}

/// Locate the folder that holds `SKILL.md`: the dir itself, or a single
/// top-level subfolder that contains it. `None` if absent or ambiguous.
fn locate_skill_root(dir: &Path) -> Option<PathBuf> {
  if dir.join("SKILL.md").is_file() {
    return Some(dir.to_path_buf());
  }
  let mut candidate = None;
  for entry in std::fs::read_dir(dir).ok()?.flatten() {
    let p = entry.path();
    if p.is_dir() && p.join("SKILL.md").is_file() {
      if candidate.is_some() {
        return None;
      }
      candidate = Some(p);
    }
  }
  candidate
}

/// Extract a zip into `dest`, using `enclosed_name()` to guard against zip-slip
/// (entries that would escape `dest` are skipped).
fn extract_zip(zip_path: &Path, dest: &Path) -> std::io::Result<()> {
  let file = std::fs::File::open(zip_path)?;
  let mut archive = zip::ZipArchive::new(file)
    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
  for i in 0..archive.len() {
    let mut entry = archive
      .by_index(i)
      .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let rel = match entry.enclosed_name() {
      Some(p) => p.to_path_buf(),
      None => continue,
    };
    let out = dest.join(rel);
    if entry.is_dir() {
      std::fs::create_dir_all(&out)?;
    } else {
      if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
      }
      let mut f = std::fs::File::create(&out)?;
      std::io::copy(&mut entry, &mut f)?;
    }
  }
  Ok(())
}

/// Read + validate the SKILL.md that a picked folder / `.md` / `.zip` points at,
/// then install it into the project (and, when `to_library`, the library too).
/// Handles temp-dir extraction + cleanup for zips.
fn import_picked(
  root: &Path,
  project_dir: &str,
  picked: &Path,
  to_library: bool,
) -> Result<(String, String), String> {
  let is_zip = picked
    .extension()
    .map(|e| e.eq_ignore_ascii_case("zip"))
    .unwrap_or(false);
  if is_zip {
    let temp = paths::temp_dir().join(format!("rayfin-skill-import-{}", uuid::Uuid::new_v4()));
    let result = (|| {
      extract_zip(picked, &temp).map_err(|e| format!("Couldn't read that .zip: {e}"))?;
      let skill_root = locate_skill_root(&temp)
        .ok_or_else(|| "The .zip doesn't contain a SKILL.md.".to_string())?;
      let content = std::fs::read_to_string(skill_root.join("SKILL.md")).map_err(ioerr)?;
      install_import(
        root,
        project_dir,
        &content,
        Some(&skill_root.join("references")),
        to_library,
      )
    })();
    let _ = std::fs::remove_dir_all(&temp);
    result
  } else if picked.is_dir() {
    let content = std::fs::read_to_string(picked.join("SKILL.md"))
      .map_err(|_| "That folder has no SKILL.md at its top level.".to_string())?;
    install_import(
      root,
      project_dir,
      &content,
      Some(&picked.join("references")),
      to_library,
    )
  } else {
    let content = std::fs::read_to_string(picked).map_err(ioerr)?;
    install_import(root, project_dir, &content, None, to_library)
  }
}

/// Count `references/*.md` files a skill folder would bring along.
fn count_references(refs: &Path) -> u32 {
  if !refs.is_dir() {
    return 0;
  }
  std::fs::read_dir(refs)
    .map(|rd| {
      rd.flatten()
        .filter(|e| {
          let p = e.path();
          p.is_file()
            && p
              .extension()
              .map(|x| x.eq_ignore_ascii_case("md"))
              .unwrap_or(false)
        })
        .count() as u32
    })
    .unwrap_or(0)
}

/// Read + validate the SKILL.md a picked folder / `.md` / `.zip` points at WITHOUT
/// installing it, returning its content and how many `references/*.md` come along.
/// Used to preview an upload before adding it.
fn read_picked(picked: &Path) -> Result<(String, u32), String> {
  let is_zip = picked
    .extension()
    .map(|e| e.eq_ignore_ascii_case("zip"))
    .unwrap_or(false);
  if is_zip {
    let temp = paths::temp_dir().join(format!("rayfin-skill-preview-{}", uuid::Uuid::new_v4()));
    let result = (|| {
      extract_zip(picked, &temp).map_err(|e| format!("Couldn't read that .zip: {e}"))?;
      let skill_root = locate_skill_root(&temp)
        .ok_or_else(|| "The .zip doesn't contain a SKILL.md.".to_string())?;
      let content = std::fs::read_to_string(skill_root.join("SKILL.md")).map_err(ioerr)?;
      parse_and_validate(&content)?;
      Ok((content, count_references(&skill_root.join("references"))))
    })();
    let _ = std::fs::remove_dir_all(&temp);
    result
  } else if picked.is_dir() {
    let content = std::fs::read_to_string(picked.join("SKILL.md"))
      .map_err(|_| "That folder has no SKILL.md at its top level.".to_string())?;
    parse_and_validate(&content)?;
    Ok((content, count_references(&picked.join("references"))))
  } else {
    let content = std::fs::read_to_string(picked).map_err(ioerr)?;
    parse_and_validate(&content)?;
    Ok((content, 0))
  }
}

/// Build a read-only preview (card fields + SKILL.md + source path) for a picked
/// skill, so the user can review it before adding.
fn build_preview(picked: &Path) -> Result<CustomSkillPreview, String> {
  let (content, reference_count) = read_picked(picked)?;
  let (name, fm_desc) = parse_and_validate(&content)?;
  let id = slugify(&name);
  Ok(CustomSkillPreview {
    ok: true,
    cancelled: false,
    error: None,
    source_path: Some(picked.to_string_lossy().to_string()),
    content: Some(content),
    title: Some(derive_title(&name, &id)),
    description: Some(truncate(&fm_desc, 140)),
    icon: Some("🧩".to_string()),
    reference_count,
  })
}

fn remove_at(root: &Path, id: &str) -> Result<(), String> {
  if !is_safe_id(id) {
    return Err("Unknown custom skill.".into());
  }
  let dir = skill_dir(root, id);
  if dir.exists() {
    std::fs::remove_dir_all(&dir).map_err(|e| format!("Couldn't remove the skill: {e}"))?;
  }
  Ok(())
}

/// Copy a library skill's folder (`SKILL.md` + `meta.json` + `references/*.md`)
/// into a project's `.agents/skills/<id>/`.
fn install_from(root: &Path, id: &str, project_dir: &str) -> std::io::Result<()> {
  let src = skill_dir(root, id);
  let dst = project_skill_folder(project_dir, id);
  std::fs::create_dir_all(&dst)?;
  std::fs::copy(src.join("SKILL.md"), dst.join("SKILL.md"))?;
  if src.join("meta.json").is_file() {
    std::fs::copy(src.join("meta.json"), dst.join("meta.json"))?;
  }
  if src.join("references").is_dir() {
    copy_references(&src.join("references"), &dst.join("references"))
      .map_err(std::io::Error::other)?;
  }
  Ok(())
}

/// Promote a project-local skill into the reusable library (copy SKILL.md +
/// meta + references from the project into the library).
fn promote_at(root: &Path, project_dir: &str, id: &str) -> Result<String, String> {
  if !is_safe_id(id) {
    return Err("Unknown skill.".into());
  }
  if crate::commands::skills::is_reserved_id(id) {
    return Err("That is a built-in skill id.".into());
  }
  if library_skill_exists_at(root, id) {
    return Err("That skill is already in your library.".into());
  }
  let src = project_skill_folder(project_dir, id);
  let content = std::fs::read_to_string(src.join("SKILL.md"))
    .map_err(|_| "That skill isn't in this app.".to_string())?;
  let meta = read_meta_file(&src).unwrap_or_else(|| {
    let fm_desc = extract_frontmatter(&content)
      .and_then(|fm| serde_yaml::from_str::<Frontmatter>(&fm).ok())
      .and_then(|p| p.description)
      .unwrap_or_default();
    Meta {
      title: crate::commands::skills::title_case(id),
      description: truncate(&fm_desc, 140),
      icon: "🧩".to_string(),
    }
  });
  write_skill_folder(
    &skill_dir(root, id),
    id,
    &content,
    &meta,
    Some(&src.join("references")),
  )
  .map_err(ioerr)?;
  Ok(id.to_string())
}

// ── Public wrappers (used by `crate::commands::skills`) ───────────────────────

/// The current library (used by the Skills tab and merged into a project's list).
pub fn list_library() -> Vec<CustomSkillInfo> {
  list_library_at(&library_root())
}

/// True when `id` names a skill in the library.
pub fn library_skill_exists(id: &str) -> bool {
  library_skill_exists_at(&library_root(), id)
}

/// The library skill's card title, if present.
pub fn library_title(id: &str) -> Option<String> {
  read_meta(&library_root(), id).map(|m| m.title)
}

/// Copy a library skill into a project's `.agents/skills/<id>/`.
pub fn install_into_project(id: &str, project_dir: &str) -> std::io::Result<()> {
  install_from(&library_root(), id, project_dir)
}

/// The raw library `SKILL.md`, for previewing/editing the library copy.
pub fn read_library_source(id: &str) -> Option<String> {
  read_source_at(&library_root(), id)
}

/// Presentation (title, description, icon) for a project-local skill from its
/// `.agents/skills/<id>/meta.json`, if present. Lets skills added to just this
/// app keep the title/description/icon the user gave them.
pub fn project_skill_presentation(project_dir: &str, id: &str) -> Option<(String, String, String)> {
  read_meta_file(&project_skill_folder(project_dir, id)).map(|m| (m.title, m.description, m.icon))
}

// ── Dialog pickers ───────────────────────────────────────────────────────────

async fn pick_folder(app: &AppHandle) -> Option<PathBuf> {
  let (tx, rx) = tokio::sync::oneshot::channel();
  app.dialog().file().pick_folder(move |picked| {
    let _ = tx.send(picked);
  });
  rx.await.ok().flatten()?.into_path().ok()
}

async fn pick_skill_file(app: &AppHandle) -> Option<PathBuf> {
  let (tx, rx) = tokio::sync::oneshot::channel();
  app
    .dialog()
    .file()
    .add_filter("Skill (SKILL.md or .zip)", &["md", "zip"])
    .pick_file(move |picked| {
      let _ = tx.send(picked);
    });
  rx.await.ok().flatten()?.into_path().ok()
}

fn ok_result(id: String) -> CustomSkillActionResult {
  CustomSkillActionResult {
    ok: true,
    id: Some(id),
    library: list_library(),
    error: None,
  }
}

fn err_result(error: String) -> CustomSkillActionResult {
  CustomSkillActionResult {
    ok: false,
    id: None,
    library: list_library(),
    error: Some(error),
  }
}

fn finish(result: Result<String, String>) -> CustomSkillActionResult {
  match result {
    Ok(id) => ok_result(id),
    Err(e) => err_result(e),
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// The global custom-skill library.
#[tauri::command]
pub fn custom_skills_list() -> Vec<CustomSkillInfo> {
  list_library()
}

/// The raw SKILL.md of a library skill, for the authoring/preview editor.
#[tauri::command]
pub fn custom_skills_source(id: String) -> SkillSource {
  match read_library_source(&id) {
    Some(content) => SkillSource {
      ok: true,
      installed: true,
      content: Some(content),
      error: None,
    },
    None => SkillSource {
      ok: false,
      installed: false,
      content: None,
      error: Some("That custom skill has no SKILL.md.".to_string()),
    },
  }
}

/// Add a custom skill to `project_id` (its `.agents/skills/`), and — when
/// `to_library` — also save it to the reusable library. When `input.id` is set
/// this instead edits that existing library skill in place.
#[tauri::command]
pub async fn custom_skills_save(
  project_id: String,
  input: CustomSkillSaveInput,
  to_library: bool,
) -> CustomSkillActionResult {
  let root = library_root();
  // Edit an existing library skill (Edit is only offered on library skills).
  if input.id.is_some() {
    return finish(save_library_edit(&root, &input));
  }
  // Create: install into the project, optionally saving to the library too.
  let dir = match store::find_project(&project_id) {
    Some(p) => p.path,
    None => return err_result("Project not found.".into()),
  };
  let composed = match compose_new(&root, &dir, &input, to_library) {
    Ok(c) => c,
    Err(e) => return err_result(e),
  };
  if let Err(e) = write_skill_folder(
    &project_skill_folder(&dir, &composed.id),
    &composed.id,
    &composed.content,
    &composed.meta,
    None,
  )
  .map_err(ioerr)
  {
    return err_result(e);
  }
  if to_library {
    if let Err(e) = write_skill_folder(
      &skill_dir(&root, &composed.id),
      &composed.id,
      &composed.content,
      &composed.meta,
      None,
    )
    .map_err(ioerr)
    {
      return err_result(e);
    }
  }
  crate::commands::skills::commit_skill_change(
    &dir,
    &composed.id,
    &format!("Add skill: {}", composed.meta.title),
  )
  .await;
  ok_result(composed.id)
}

/// Shared import path: resolve the project, install the picked skill, commit.
async fn import_and_commit(
  project_id: &str,
  picked: &Path,
  to_library: bool,
) -> CustomSkillActionResult {
  let dir = match store::find_project(project_id) {
    Some(p) => p.path,
    None => return err_result("Project not found.".into()),
  };
  match import_picked(&library_root(), &dir, picked, to_library) {
    Ok((id, title)) => {
      crate::commands::skills::commit_skill_change(&dir, &id, &format!("Add skill: {title}")).await;
      ok_result(id)
    }
    Err(e) => err_result(e),
  }
}

fn preview_cancelled() -> CustomSkillPreview {
  CustomSkillPreview {
    ok: false,
    cancelled: true,
    error: None,
    source_path: None,
    content: None,
    title: None,
    description: None,
    icon: None,
    reference_count: 0,
  }
}

fn preview_err(error: String) -> CustomSkillPreview {
  CustomSkillPreview {
    ok: false,
    cancelled: false,
    error: Some(error),
    source_path: None,
    content: None,
    title: None,
    description: None,
    icon: None,
    reference_count: 0,
  }
}

/// Pick a skill folder and return a read-only preview (no install yet).
#[tauri::command]
pub async fn custom_skills_pick_folder_preview(app: AppHandle) -> CustomSkillPreview {
  match pick_folder(&app).await {
    Some(picked) => match build_preview(&picked) {
      Ok(p) => p,
      Err(e) => preview_err(e),
    },
    None => preview_cancelled(),
  }
}

/// Pick a `SKILL.md` or `.zip` bundle and return a read-only preview (no install yet).
#[tauri::command]
pub async fn custom_skills_pick_file_preview(app: AppHandle) -> CustomSkillPreview {
  match pick_skill_file(&app).await {
    Some(picked) => match build_preview(&picked) {
      Ok(p) => p,
      Err(e) => preview_err(e),
    },
    None => preview_cancelled(),
  }
}

/// Confirm a previewed upload: install the skill at `source_path` into the project
/// (and, when `to_library`, the library too).
#[tauri::command]
pub async fn custom_skills_add_from_path(
  project_id: String,
  source_path: String,
  to_library: bool,
) -> CustomSkillActionResult {
  import_and_commit(&project_id, Path::new(&source_path), to_library).await
}

/// Save a project-local skill into the reusable library so it can be used in
/// other apps.
#[tauri::command]
pub fn custom_skills_promote(project_id: String, id: String) -> CustomSkillActionResult {
  let dir = match store::find_project(&project_id) {
    Some(p) => p.path,
    None => return err_result("Project not found.".into()),
  };
  finish(promote_at(&library_root(), &dir, &id))
}

/// Remove a skill from the library. Apps that already installed a copy keep it.
#[tauri::command]
pub fn custom_skills_remove(id: String) -> CustomSkillActionResult {
  match remove_at(&library_root(), &id) {
    Ok(()) => ok_result(id),
    Err(e) => err_result(e),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const SAMPLE: &str =
    "---\nname: whatever\ndescription: \"Use when testing.\"\n---\n# Sample\n\nBody text.\n";

  fn tmp() -> PathBuf {
    let p = std::env::temp_dir().join(format!("rayfin-cskill-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&p).unwrap();
    p
  }

  #[test]
  fn slugify_makes_safe_slugs() {
    assert_eq!(slugify("My Cool Skill!"), "my-cool-skill");
    assert_eq!(slugify("  spaced  out  "), "spaced-out");
    assert_eq!(slugify("Already-slug_ok"), "already-slug-ok");
    assert_eq!(slugify("###"), "");
  }

  #[test]
  fn is_safe_id_blocks_traversal() {
    assert!(is_safe_id("my-skill"));
    assert!(!is_safe_id("../evil"));
    assert!(!is_safe_id("a/b"));
    assert!(!is_safe_id("a\\b"));
    assert!(!is_safe_id(""));
  }

  #[test]
  fn parse_and_validate_requires_name_and_description() {
    assert!(parse_and_validate(SAMPLE).is_ok());
    assert!(parse_and_validate("no frontmatter here").is_err());
    assert!(parse_and_validate("---\nname: x\n---\n# Body").is_err());
    assert!(parse_and_validate("---\ndescription: y\n---\n# Body").is_err());
  }

  #[test]
  fn set_frontmatter_name_rewrites_only_the_name_line() {
    let out = set_frontmatter_name(SAMPLE, "my-id");
    assert!(out.contains("name: my-id"));
    assert!(!out.contains("name: whatever"));
    // Body + description are untouched.
    assert!(out.contains("description: \"Use when testing.\""));
    assert!(out.contains("Body text."));
    // CRLF frontmatter keeps its line endings.
    let crlf = "---\r\nname: old\r\ndescription: d\r\n---\r\n# T\r\n";
    let fixed = set_frontmatter_name(crlf, "new-id");
    assert!(fixed.contains("name: new-id\r\n"));
  }

  #[test]
  fn library_write_list_edit_remove_round_trip() {
    let root = tmp();
    let id = "my-cool-skill";
    write_skill_folder(
      &skill_dir(&root, id),
      id,
      SAMPLE,
      &build_meta("My Cool Skill", "Short card text.", Some("🚀"), "fallback"),
      None,
    )
    .unwrap();

    let list = list_library_at(&root);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, id);
    assert_eq!(list[0].title, "My Cool Skill");
    assert_eq!(list[0].description, "Short card text.");
    assert_eq!(list[0].icon, "🚀");
    assert!(!list[0].has_references);

    // The on-disk SKILL.md's name was normalized to the id.
    assert!(read_source_at(&root, id)
      .unwrap()
      .contains("name: my-cool-skill"));

    // Editing keeps the id but updates the card title.
    let edited = save_library_edit(
      &root,
      &CustomSkillSaveInput {
        id: Some(id.into()),
        title: "Renamed".into(),
        description: "New text.".into(),
        icon: None,
        content: SAMPLE.into(),
      },
    )
    .unwrap();
    assert_eq!(edited, id);
    assert_eq!(list_library_at(&root)[0].title, "Renamed");

    // Editing a missing skill fails.
    assert!(save_library_edit(
      &root,
      &CustomSkillSaveInput {
        id: Some("ghost".into()),
        title: "x".into(),
        description: String::new(),
        icon: None,
        content: SAMPLE.into(),
      },
    )
    .is_err());

    remove_at(&root, id).unwrap();
    assert!(!library_skill_exists_at(&root, id));
    assert!(list_library_at(&root).is_empty());
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn compose_new_derives_id_and_rejects_dupes_and_reserved() {
    let root = tmp();
    let project = tmp();
    let pstr = project.to_str().unwrap();

    let composed = compose_new(
      &root,
      pstr,
      &CustomSkillSaveInput {
        id: None,
        title: "My Cool Skill".into(),
        description: "Short card text.".into(),
        icon: Some("🚀".into()),
        content: SAMPLE.into(),
      },
      false,
    )
    .unwrap();
    assert_eq!(composed.id, "my-cool-skill");
    assert_eq!(composed.meta.title, "My Cool Skill");
    assert_eq!(composed.meta.icon, "🚀");

    // Reserved catalog id (slug of "Polished UI").
    let reserved = compose_new(
      &root,
      pstr,
      &CustomSkillSaveInput {
        id: None,
        title: "Polished UI".into(),
        description: String::new(),
        icon: None,
        content: SAMPLE.into(),
      },
      false,
    )
    .unwrap_err();
    assert!(reserved.contains("built-in"));

    // Already present in this app.
    write_skill_folder(
      &project_skill_folder(pstr, "my-cool-skill"),
      "my-cool-skill",
      SAMPLE,
      &composed.meta,
      None,
    )
    .unwrap();
    let dup_app = compose_new(
      &root,
      pstr,
      &CustomSkillSaveInput {
        id: None,
        title: "My Cool Skill".into(),
        description: String::new(),
        icon: None,
        content: SAMPLE.into(),
      },
      false,
    )
    .unwrap_err();
    assert!(dup_app.contains("already exists in this app"));

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&project);
  }

  #[test]
  fn install_import_adds_to_project_and_optionally_library() {
    let root = tmp();
    let src = tmp();
    std::fs::write(src.join("SKILL.md"), SAMPLE).unwrap();
    std::fs::create_dir_all(src.join("references")).unwrap();
    std::fs::write(src.join("references").join("extra.md"), "# Extra").unwrap();
    std::fs::write(src.join("references").join("skip.txt"), "nope").unwrap();
    let refs = src.join("references");

    // Default: added to the app only, not the library.
    let project1 = tmp();
    let (id, _title) = install_import(
      &root,
      project1.to_str().unwrap(),
      SAMPLE,
      Some(&refs),
      false,
    )
    .unwrap();
    assert_eq!(id, "whatever");
    let app1 = project_skill_folder(project1.to_str().unwrap(), &id);
    assert!(app1.join("SKILL.md").is_file());
    assert!(app1.join("references").join("extra.md").is_file());
    assert!(!app1.join("references").join("skip.txt").exists());
    assert!(app1.join("meta.json").is_file());
    assert!(!library_skill_exists_at(&root, &id));

    // With the flag: added to the app AND saved to the library.
    let project2 = tmp();
    install_import(&root, project2.to_str().unwrap(), SAMPLE, Some(&refs), true).unwrap();
    assert!(library_skill_exists_at(&root, &id));
    assert!(skill_dir(&root, &id)
      .join("references")
      .join("extra.md")
      .is_file());

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&src);
    let _ = std::fs::remove_dir_all(&project1);
    let _ = std::fs::remove_dir_all(&project2);
  }

  #[test]
  fn import_picked_zip_extracts_and_guards_slip() {
    let root = tmp();
    let work = tmp();
    let project = tmp();
    let zip_path = work.join("skill.zip");
    {
      let file = std::fs::File::create(&zip_path).unwrap();
      let mut zip = zip::ZipWriter::new(file);
      let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
      zip.start_file("my-skill/SKILL.md", opts).unwrap();
      use std::io::Write;
      zip.write_all(SAMPLE.as_bytes()).unwrap();
      zip.start_file("my-skill/references/ref.md", opts).unwrap();
      zip.write_all(b"# Ref").unwrap();
      // A zip-slip entry that must be ignored by extraction.
      zip.start_file("../escape.md", opts).unwrap();
      zip.write_all(b"evil").unwrap();
      zip.finish().unwrap();
    }
    let (id, _title) = import_picked(&root, project.to_str().unwrap(), &zip_path, false).unwrap();
    assert_eq!(id, "whatever");
    let app = project_skill_folder(project.to_str().unwrap(), &id);
    assert!(app.join("references").join("ref.md").is_file());
    // The traversal entry never escaped into a sibling of the work dir.
    assert!(!work.parent().unwrap().join("escape.md").exists());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&work);
    let _ = std::fs::remove_dir_all(&project);
  }

  #[test]
  fn preview_reads_without_installing() {
    let src = tmp();
    std::fs::write(src.join("SKILL.md"), SAMPLE).unwrap();
    std::fs::create_dir_all(src.join("references")).unwrap();
    std::fs::write(src.join("references").join("a.md"), "# A").unwrap();
    std::fs::write(src.join("references").join("b.md"), "# B").unwrap();
    std::fs::write(src.join("references").join("skip.txt"), "x").unwrap();

    let preview = build_preview(&src).unwrap();
    assert!(preview.ok);
    assert_eq!(preview.reference_count, 2);
    assert_eq!(preview.title.as_deref(), Some("Whatever"));
    assert_eq!(preview.source_path.as_deref(), Some(src.to_str().unwrap()));
    assert!(preview
      .content
      .as_deref()
      .unwrap()
      .contains("name: whatever"));

    // A folder without a SKILL.md previews as an error, not a panic.
    let empty = tmp();
    assert!(build_preview(&empty).is_err());
    let _ = std::fs::remove_dir_all(&src);
    let _ = std::fs::remove_dir_all(&empty);
  }

  #[test]
  fn install_from_copies_skill_meta_and_references() {
    let root = tmp();
    let src = tmp();
    std::fs::write(src.join("SKILL.md"), SAMPLE).unwrap();
    std::fs::create_dir_all(src.join("references")).unwrap();
    std::fs::write(src.join("references").join("r.md"), "# R").unwrap();
    // Seed a library skill (with references + meta).
    let (id, _t) = install_import(
      &root,
      tmp().to_str().unwrap(),
      SAMPLE,
      Some(&src.join("references")),
      true,
    )
    .unwrap();

    let project = tmp();
    install_from(&root, &id, project.to_str().unwrap()).unwrap();
    let installed = project_skill_folder(project.to_str().unwrap(), &id);
    assert!(installed.join("SKILL.md").is_file());
    assert!(installed.join("meta.json").is_file());
    assert!(installed.join("references").join("r.md").is_file());
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&src);
    let _ = std::fs::remove_dir_all(&project);
  }

  #[test]
  fn promote_copies_project_skill_into_library() {
    let root = tmp();
    let project = tmp();
    let pstr = project.to_str().unwrap();
    // A skill added to just this app (with a meta.json + references).
    let src_refs = tmp();
    std::fs::create_dir_all(&src_refs).unwrap();
    std::fs::write(src_refs.join("r.md"), "# R").unwrap();
    write_skill_folder(
      &project_skill_folder(pstr, "whatever"),
      "whatever",
      SAMPLE,
      &build_meta("Whatever", "app-only desc", Some("🧩"), "fm"),
      Some(&src_refs),
    )
    .unwrap();

    let id = promote_at(&root, pstr, "whatever").unwrap();
    assert_eq!(id, "whatever");
    assert!(library_skill_exists_at(&root, "whatever"));
    assert_eq!(list_library_at(&root)[0].title, "Whatever");
    assert!(skill_dir(&root, "whatever")
      .join("references")
      .join("r.md")
      .is_file());

    // Promoting again fails (already in the library).
    assert!(promote_at(&root, pstr, "whatever").is_err());

    // And project-local presentation reads the project meta.json.
    let pres = project_skill_presentation(pstr, "whatever").unwrap();
    assert_eq!(pres.0, "Whatever");
    assert_eq!(pres.1, "app-only desc");

    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&project);
    let _ = std::fs::remove_dir_all(&src_refs);
  }
}
