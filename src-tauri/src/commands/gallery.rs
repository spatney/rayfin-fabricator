//! The app gallery: every Rayfin app the Azure CLI's account can open in
//! Fabric, including apps that aren't on this computer. See
//! [`crate::services::gallery`].

use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::services::gallery::{self, GalleryRef, GalleryResult, GalleryStatus};
use crate::services::{history, store};
use crate::state::AppState;
use crate::types::StudioProject;

/// Every Rayfin app the Azure CLI's account can open. `refresh` signs in to
/// Azure afresh and reads every status again. Never fails across IPC.
#[tauri::command]
pub async fn gallery_list(refresh: Option<bool>) -> GalleryResult {
  gallery::list(refresh.unwrap_or(false)).await
}

/// Each app's address and last publish, in the order asked.
#[tauri::command]
pub async fn gallery_status(apps: Vec<GalleryRef>) -> Vec<GalleryStatus> {
  gallery::status(apps).await
}

/// What describing a project's published app came to.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GalleryDescribeResult {
  pub ok: bool,
  /// The app's description now: the one it had, or the one just written.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  /// It had a description already, which it keeps.
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub kept: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

fn failed(error: impl Into<String>) -> GalleryDescribeResult {
  GalleryDescribeResult { ok: false, error: Some(error.into()), ..Default::default() }
}

const PROMPT: &str = "Write a one-sentence description of this app for a list of apps people can open in \
Microsoft Fabric: what it does, and for whom. Plain words, no marketing language, and don't start with the \
app's name. At most 140 characters. Reply with the sentence only.";

/// The most of each file the prompt quotes.
const README_CHARS: usize = 2000;
const CONFIG_CHARS: usize = 1500;
const REQUEST_CHARS: usize = 400;
/// The user's first requests in the app's chat: what they asked Copilot to build.
const REQUESTS: usize = 4;
const SOURCE_FILES: usize = 60;

fn head(text: &str, chars: usize) -> String {
  let mut out: String = text.chars().take(chars).collect();
  if out.len() < text.len() {
    out.push('…');
  }
  out
}

fn read_head(path: &Path, chars: usize) -> Option<String> {
  let text = std::fs::read_to_string(path).ok()?;
  let text = text.trim();
  (!text.is_empty()).then(|| head(text, chars))
}

/// The app's source files under `src/`, as relative paths, a few levels deep.
fn source_files(dir: &Path) -> Vec<String> {
  fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
      if out.len() >= SOURCE_FILES {
        return;
      }
      let path = entry.path();
      let name = entry.file_name().to_string_lossy().to_string();
      if name.starts_with('.') || name == "node_modules" {
        continue;
      }
      if path.is_dir() {
        if depth < 3 {
          walk(root, &path, depth + 1, out);
        }
      } else if let Ok(rel) = path.strip_prefix(root) {
        out.push(rel.to_string_lossy().replace('\\', "/"));
      }
    }
  }
  let mut out = Vec::new();
  walk(dir, &dir.join("src"), 0, &mut out);
  out
}

/// What Copilot reads to describe an app: its name, what the user asked for in
/// its chat, its README, its Rayfin configuration, and its source files' names.
fn describe_prompt(project: &StudioProject, requests: &[String]) -> String {
  let dir = Path::new(&project.path);
  let mut parts = vec![PROMPT.to_string(), format!("App name: {}", project.name)];
  if !requests.is_empty() {
    let asked: Vec<String> = requests.iter().map(|r| format!("- {}", head(r.trim(), REQUEST_CHARS))).collect();
    parts.push(format!("What its maker asked Copilot to build:\n{}", asked.join("\n")));
  }
  if let Some(readme) = read_head(&dir.join("README.md"), README_CHARS) {
    parts.push(format!("README.md:\n{readme}"));
  }
  if let Some(config) = read_head(&dir.join("rayfin").join("rayfin.yml"), CONFIG_CHARS) {
    parts.push(format!("rayfin/rayfin.yml:\n{config}"));
  }
  let files = source_files(dir);
  if !files.is_empty() {
    parts.push(format!("Source files:\n{}", files.join("\n")));
  }
  parts.join("\n\n")
}

/// The description in the model's reply: its first line of text, without a
/// code fence, quotes or a label, and short enough for Fabric.
fn description_line(reply: &str) -> Option<String> {
  let body = match reply.split("```").nth(1) {
    Some(fenced) => fenced.split_once('\n').map_or(fenced, |(_, rest)| rest),
    None => reply,
  };
  let line = body.lines().map(str::trim).find(|line| !line.is_empty())?;
  let unquote = |s: &str| {
    s.trim().trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '*' | '“' | '”')).trim().to_string()
  };
  let mut line = unquote(line);
  if line.get(..12).is_some_and(|label| label.eq_ignore_ascii_case("description:")) {
    line = unquote(&line[12..]);
  }
  let words = line.split_whitespace().collect::<Vec<_>>().join(" ");
  (!words.is_empty()).then(|| words.chars().take(gallery::DESCRIPTION_MAX).collect())
}

/// Write a one-line description of a project's published app with Copilot,
/// and save it in Fabric, where the gallery (and Fabric) show it to everyone
/// who can open the app. An app that has a description keeps it, unless
/// `replace`. Never fails across IPC.
#[tauri::command]
pub async fn gallery_describe(
  state: State<'_, AppState>,
  project_id: String,
  replace: Option<bool>,
) -> Result<GalleryDescribeResult, String> {
  let Some(project) = store::find_project(&project_id) else {
    return Ok(failed("That project isn't in Fabricator anymore."));
  };
  if project.team.is_some() {
    return Ok(failed("A team app is published by its team's pipeline."));
  }
  let Some((workspace, item)) = gallery::published_item(&project) else {
    return Ok(failed("This app isn't published yet."));
  };
  if !replace.unwrap_or(false) {
    match gallery::app_description(&workspace, &item).await {
      Ok(existing) if !existing.trim().is_empty() => {
        return Ok(GalleryDescribeResult { ok: true, description: Some(existing), kept: true, error: None })
      }
      Ok(_) => {}
      Err(error) => return Ok(failed(error)),
    }
  }
  let requests: Vec<String> = history::load_history(&project.id)
    .into_iter()
    .filter(|m| m.role == "user" && !m.text.trim().is_empty())
    .take(REQUESTS)
    .map(|m| m.text)
    .collect();
  let prompt = describe_prompt(&project, &requests);
  let reply =
    crate::commands::transient::run_transient(state.inner(), &project.path, None, None, prompt, &[], None).await;
  let description = match reply.map(|reply| description_line(&reply)) {
    Ok(Some(line)) => line,
    Ok(None) => return Ok(failed("Copilot didn't write a description. Try again.")),
    Err(error) => return Ok(failed(format!("Couldn't write a description: {error}"))),
  };
  Ok(match gallery::set_description(&workspace, &item, &description).await {
    Ok(()) => GalleryDescribeResult { ok: true, description: Some(description), ..Default::default() },
    Err(error) => failed(error),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_description_is_the_reply_without_its_wrapping() {
    assert_eq!(
      description_line("Tracks sales leads from first call to signed deal.").as_deref(),
      Some("Tracks sales leads from first call to signed deal.")
    );
    assert_eq!(description_line("\"Plans meals for the week.\"\n\nMore text.").as_deref(), Some("Plans meals for the week."));
    assert_eq!(description_line("```text\nLogs trips for a team.\n```").as_deref(), Some("Logs trips for a team."));
    assert_eq!(description_line("Description: `Shows open support tickets`").as_deref(), Some("Shows open support tickets"));
    assert_eq!(description_line("  \n ``` \n"), None);
    assert_eq!(description_line(&"word ".repeat(100)).map(|s| s.chars().count()), Some(gallery::DESCRIPTION_MAX));
  }

  #[test]
  fn the_prompt_quotes_what_the_app_is_made_of() {
    let dir = std::env::temp_dir().join(format!("fab-describe-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("src/pages")).unwrap();
    std::fs::create_dir_all(dir.join("src/node_modules/x")).unwrap();
    std::fs::create_dir_all(dir.join("rayfin")).unwrap();
    std::fs::write(dir.join("README.md"), "# Leads\nA place for leads.").unwrap();
    std::fs::write(dir.join("rayfin/rayfin.yml"), "id: leads\nname: Leads\n").unwrap();
    std::fs::write(dir.join("src/pages/Pipeline.tsx"), "").unwrap();
    std::fs::write(dir.join("src/node_modules/x/index.js"), "").unwrap();
    let project: StudioProject = serde_json::from_value(serde_json::json!({
      "id": "p", "name": "Leads", "path": dir.to_string_lossy(), "addedAt": "2026-01-01"
    }))
    .unwrap();
    let prompt = describe_prompt(&project, &["Build me a lead tracker for my sales team".into()]);
    assert!(prompt.starts_with(PROMPT));
    assert!(prompt.contains("App name: Leads"));
    assert!(prompt.contains("- Build me a lead tracker for my sales team"));
    assert!(prompt.contains("A place for leads."));
    assert!(prompt.contains("name: Leads"));
    assert!(prompt.contains("src/pages/Pipeline.tsx"));
    assert!(!prompt.contains("node_modules"), "dependencies aren't the app");
    let _ = std::fs::remove_dir_all(&dir);
  }
}
