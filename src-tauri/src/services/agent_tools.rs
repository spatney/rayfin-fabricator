//! In-process Copilot tools that let the agent deploy this Rayfin app and
//! visually validate it through Fabricator's built-in preview browser.
//!
//! Registered on every chat session via
//! [`SessionConfig::with_tools`](github_copilot_sdk::SessionConfig::with_tools)
//! (see [`crate::services::copilot`]). Each handler runs inside the Tauri host
//! process, so it can drive the native preview webview ([`crate::services::preview`])
//! and the deploy engine ([`crate::commands::deploy`]) directly. Screenshots are
//! returned to the model as `image/png` tool results, so the agent literally sees
//! the running app.
//!
//! These tools exist **only** in Fabricator-driven sessions — they are never part
//! of the project on disk, so a plain `copilot` CLI run sees none of them.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::{ToolBinaryResult, ToolInvocation, ToolResultExpanded};
use github_copilot_sdk::{Error as SdkError, Tool, ToolResult};
use serde::Deserialize;
use tauri::AppHandle;

use crate::commands::deploy;
use crate::services::{preview, store};

/// How long to wait for a navigated page to finish loading before capturing.
const NAV_TIMEOUT: Duration = Duration::from_secs(20);
/// How long to wait for the renderer to surface a not-yet-created preview.
const SHOW_TIMEOUT: Duration = Duration::from_secs(10);
/// Let a scroll settle (and any lazy/below-the-fold content paint) before the
/// follow-up screenshot.
const SCROLL_SETTLE: Duration = Duration::from_millis(450);
/// Upper bound on reading the preview's console buffer. Generous, but ensures the
/// tool returns even if the result callback never fires (e.g. the page hasn't run
/// the capture init script yet) rather than waiting indefinitely.
const CONSOLE_TIMEOUT: Duration = Duration::from_secs(6);

/// Build the Fabricator validation tool set for one project's chat session.
pub fn fabricator_tools(app: AppHandle, project_id: String) -> Vec<Tool> {
  vec![
    Tool::new("fabricator_deploy_and_wait")
      .with_description(
        "Deploy this Rayfin app to Microsoft Fabric and wait until it is live. Use this \
         instead of running `rayfin up` yourself. Returns the live URL on success, or the \
         build/deploy error to fix on failure.",
      )
      .with_parameters(serde_json::json!({ "type": "object", "properties": {} }))
      .with_skip_permission(true)
      .with_handler(Arc::new(DeployAndWaitTool {
        app: app.clone(),
        project_id: project_id.clone(),
      })),
    Tool::new("fabricator_navigate")
      .with_description(
        "Open a route or URL of the deployed app in Fabricator's built-in preview browser \
         and return a screenshot of it. Pass a route like \"/\" or \"/todos\", or a full \
         https URL. Deploy first with fabricator_deploy_and_wait if the app isn't live yet.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "path_or_url": {
            "type": "string",
            "description": "A route (e.g. \"/todos\") resolved against the live app, or a full URL."
          }
        },
        "required": ["path_or_url"]
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(NavigateTool {
        app: app.clone(),
        project_id: project_id.clone(),
      })),
    Tool::new("fabricator_screenshot")
      .with_description(
        "Take a screenshot of the app currently shown in Fabricator's built-in preview \
         browser, so you can see exactly what the user sees and validate your changes.",
      )
      .with_parameters(serde_json::json!({ "type": "object", "properties": {} }))
      .with_skip_permission(true)
      .with_handler(Arc::new(ScreenshotTool {
        app: app.clone(),
        project_id: project_id.clone(),
      })),
    Tool::new("fabricator_scroll")
      .with_description(
        "Scroll the page currently shown in Fabricator's built-in preview browser and return a \
         fresh screenshot, so you can see content below (or above) the fold — e.g. lower \
         dashboard tiles or the rest of a long table. Use this when a screenshot looks cut off \
         at the bottom. Open a page first with fabricator_navigate.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "direction": {
            "type": "string",
            "enum": ["down", "up", "top", "bottom"],
            "description": "Which way to scroll. \"down\" (default) / \"up\" move ~one viewport; \"top\"/\"bottom\" jump to the ends."
          },
          "amount": {
            "type": "number",
            "description": "Optional pixel distance for \"down\"/\"up\" (defaults to ~one viewport height)."
          }
        }
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(ScrollTool {
        app: app.clone(),
        project_id: project_id.clone(),
      })),
    Tool::new("fabricator_console")
      .with_description(
        "Read the deployed app's browser console from Fabricator's preview — recent \
         console.log/info/warn/error/debug messages plus uncaught errors and unhandled promise \
         rejections. Use this to debug a blank screen, missing data, or a runtime error you \
         can't diagnose from a screenshot alone. Open a page first with fabricator_navigate.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "level": {
            "type": "string",
            "enum": ["all", "error", "warn", "info", "log", "debug"],
            "description": "Optional filter; defaults to \"all\". Use \"error\" to see only errors and rejections."
          }
        }
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(ConsoleTool { app, project_id })),
  ]
}

/* ----------------------------- shared helpers ----------------------------- */

/// The project's current live deployment URL (the direct app URL), if deployed.
fn current_live_url(project_id: &str) -> Option<String> {
  store::find_project(project_id)
    .and_then(|p| p.last_deploy)
    .and_then(|d| d.url)
}

/// The URL the agent should treat as the app's root, honouring the user's preview
/// toggle: the Fabric-embedded portal view when that toggle is on (and a portal URL
/// exists), otherwise the direct app URL. Mirrors the renderer's `previewUrl`, so
/// the agent navigates/screenshots exactly the view the user is looking at.
fn effective_base_url(project_id: &str) -> Option<String> {
  let project = store::find_project(project_id)?;
  let fabric = project.preview_mode.as_deref() == Some("fabric");
  let deploy = project.last_deploy?;
  if fabric {
    if let Some(portal) = deploy.portal_url.filter(|s| !s.trim().is_empty()) {
      return Some(portal);
    }
  }
  deploy.url
}

/// Resolve a user/agent-supplied target into an absolute URL. Absolute URLs pass
/// through. A bare root (`""`/`"/"`) resolves to the user's selected view (the
/// Fabric portal shell when that toggle is on); a deeper route is joined onto the
/// direct app URL, since the Fabric portal shell can't deep-link app sub-routes.
fn resolve_url(project_id: &str, input: &str) -> Result<String, String> {
  let input = input.trim();
  if input.starts_with("http://") || input.starts_with("https://") {
    return Ok(input.to_string());
  }
  let not_deployed =
    || "The app hasn't been deployed yet — run fabricator_deploy_and_wait first.".to_string();
  if input.is_empty() || input == "/" {
    return effective_base_url(project_id).ok_or_else(not_deployed);
  }
  let base = current_live_url(project_id).ok_or_else(not_deployed)?;
  let base = base.trim_end_matches('/');
  let path = if input.starts_with('/') {
    input.to_string()
  } else {
    format!("/{input}")
  };
  Ok(format!("{base}{path}"))
}

/// Ensure the preview is ready for a capture. On **Windows** this is silent — the
/// surface is prepared off-screen (built if it doesn't exist yet) and the user's
/// current view is never changed, so the agent can screenshot the running app no
/// matter which tab/modal/focus state the user is in (see
/// [`preview::agent_ensure_preview`]). On other platforms it surfaces the preview
/// to the user, as before.
async fn ensure_preview(app: &AppHandle, url: &str) {
  preview::agent_ensure_preview(app, url, SHOW_TIMEOUT).await;
}

/// A successful `image/png` tool result the model can see.
fn image_result(text: String, png: Vec<u8>, description: String) -> ToolResult {
  let data = base64::engine::general_purpose::STANDARD.encode(&png);
  ToolResult::Expanded(ToolResultExpanded {
    text_result_for_llm: text,
    result_type: "success".to_string(),
    binary_results_for_llm: Some(vec![ToolBinaryResult {
      data,
      mime_type: "image/png".to_string(),
      r#type: "image".to_string(),
      description: Some(description),
    }]),
    session_log: None,
    error: None,
    tool_telemetry: None,
  })
}

/// A failure tool result carrying a message the agent can act on.
fn failure(message: impl Into<String>) -> ToolResult {
  let message = message.into();
  ToolResult::Expanded(ToolResultExpanded {
    text_result_for_llm: message.clone(),
    result_type: "failure".to_string(),
    binary_results_for_llm: None,
    session_log: None,
    error: Some(message),
    tool_telemetry: None,
  })
}

/* -------------------------------- tools ----------------------------------- */

struct DeployAndWaitTool {
  app: AppHandle,
  project_id: String,
}

#[async_trait]
impl ToolHandler for DeployAndWaitTool {
  async fn call(&self, _invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let result = deploy::run_deploy(self.app.clone(), self.project_id.clone(), None).await;
    if !result.ok {
      let err = result.error.unwrap_or_else(|| "deploy failed".to_string());
      return Ok(failure(format!("Deploy failed ({}): {err}", result.outcome)));
    }
    let url = result.url.unwrap_or_default();
    // Surface the preview and point it at the freshly-deployed app — honouring the
    // user's direct/Fabric view toggle — so a follow-up screenshot reflects the new
    // version in the same view the user is watching. The store already holds the new
    // deploy URLs (run_deploy persists them before returning), so effective_base_url
    // resolves the right target.
    if let Some(target) = effective_base_url(&self.project_id) {
      ensure_preview(&self.app, &target).await;
      let _ = preview::navigate_and_wait(&self.app, &target, NAV_TIMEOUT).await;
    }
    Ok(ToolResult::Text(format!(
      "Deploy succeeded. The app is live at {url}. Use fabricator_navigate or \
       fabricator_screenshot to visually validate it.",
    )))
  }
}

#[derive(Deserialize)]
struct NavigateParams {
  #[serde(alias = "url", alias = "path", alias = "route")]
  path_or_url: String,
}

struct NavigateTool {
  app: AppHandle,
  project_id: String,
}

#[async_trait]
impl ToolHandler for NavigateTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: NavigateParams = match invocation.params() {
      Ok(p) => p,
      Err(e) => return Ok(failure(format!("Invalid arguments: {e}"))),
    };
    let target = match resolve_url(&self.project_id, &params.path_or_url) {
      Ok(u) => u,
      Err(e) => return Ok(failure(e)),
    };

    ensure_preview(&self.app, &target).await;
    if let Err(e) = preview::navigate_and_wait(&self.app, &target, NAV_TIMEOUT).await {
      return Ok(failure(format!(
        "Couldn't open {target} in the preview browser: {e}. The preview may still be \
         starting up — wait a moment and try again, or run fabricator_deploy_and_wait if \
         the app isn't deployed yet."
      )));
    }
    // Brief settle for late SPA paints before grabbing the frame.
    tokio::time::sleep(Duration::from_millis(400)).await;

    match preview::agent_capture(&self.app).await {
      Ok(png) => Ok(image_result(
        format!("Navigated to {target} and captured the running app."),
        png,
        format!("Preview at {target}"),
      )),
      Err(e) => Ok(failure(format!(
        "Navigated to {target} but couldn't capture a screenshot: {e}"
      ))),
    }
  }
}

struct ScreenshotTool {
  app: AppHandle,
  project_id: String,
}

#[async_trait]
impl ToolHandler for ScreenshotTool {
  async fn call(&self, _invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let live = effective_base_url(&self.project_id);
    if let Some(url) = &live {
      ensure_preview(&self.app, url).await;
    }
    match preview::agent_capture(&self.app).await {
      Ok(png) => {
        let where_ = live.map(|u| format!(" (showing {u})")).unwrap_or_default();
        Ok(image_result(
          format!("Screenshot of the running app{where_}."),
          png,
          "Preview screenshot".to_string(),
        ))
      }
      Err(e) if live.is_some() => Ok(failure(format!(
        "The app is deployed but the preview browser isn't ready to capture yet ({e}). \
         Wait a moment and screenshot again, or use fabricator_navigate to open a specific \
         route."
      ))),
      Err(e) => Ok(failure(format!(
        "Couldn't capture the preview: {e}. Deploy the app first with \
         fabricator_deploy_and_wait, then try again."
      ))),
    }
  }
}

struct ScrollTool {
  app: AppHandle,
  project_id: String,
}

#[derive(Deserialize, Default)]
struct ScrollParams {
  #[serde(default)]
  direction: Option<String>,
  #[serde(default)]
  amount: Option<f64>,
}

#[async_trait]
impl ToolHandler for ScrollTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: ScrollParams = invocation.params().unwrap_or_default();
    let raw = params
      .direction
      .as_deref()
      .unwrap_or("down")
      .trim()
      .to_lowercase();
    let dir = match raw.as_str() {
      "" | "down" => "down",
      "up" => "up",
      "top" => "top",
      "bottom" => "bottom",
      other => {
        return Ok(failure(format!(
          "Invalid scroll direction {other:?}. Use \"down\", \"up\", \"top\", or \"bottom\"."
        )))
      }
    };

    if !preview::is_preview_open(&self.app) {
      return Ok(failure(
        "The preview browser isn't open yet, so there's nothing to scroll. Deploy with \
         fabricator_deploy_and_wait, then open a page with fabricator_navigate first.",
      ));
    }
    // When the preview is hidden, ensure it at least exists (Windows builds it
    // off-screen if needed); the capture below reveals it off-screen, so we scroll
    // the live page in place either way. When it's already visible we scroll the
    // exact page the user sees — re-showing could reset it to the app root.
    if !preview::is_preview_visible(&self.app) {
      if let Some(url) = effective_base_url(&self.project_id) {
        ensure_preview(&self.app, &url).await;
      }
    }

    if let Err(e) = preview::scroll(&self.app, dir, params.amount) {
      return Ok(failure(format!("Couldn't scroll the preview: {e}")));
    }
    tokio::time::sleep(SCROLL_SETTLE).await;

    match preview::agent_capture(&self.app).await {
      Ok(png) => Ok(image_result(
        format!("Scrolled {dir} and captured the preview."),
        png,
        format!("Preview after scrolling {dir}"),
      )),
      Err(e) => Ok(failure(format!(
        "Scrolled {dir} but couldn't capture a screenshot: {e}. Wait a moment and try again, \
         or open a route with fabricator_navigate first."
      ))),
    }
  }
}

struct ConsoleTool {
  app: AppHandle,
  project_id: String,
}

#[derive(Deserialize, Default)]
struct ConsoleParams {
  #[serde(default)]
  level: Option<String>,
}

#[async_trait]
impl ToolHandler for ConsoleTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: ConsoleParams = invocation.params().unwrap_or_default();
    if !preview::is_preview_open(&self.app) {
      // Nudge the agent to open the app first; effective_base_url just sharpens
      // the message when a deployment already exists.
      let hint = if effective_base_url(&self.project_id).is_some() {
        "open a page with fabricator_navigate"
      } else {
        "deploy with fabricator_deploy_and_wait, then open a page with fabricator_navigate"
      };
      return Ok(failure(format!(
        "The preview browser isn't open, so there are no console logs to read yet — {hint} first."
      )));
    }
    let json = match preview::read_console(&self.app, CONSOLE_TIMEOUT).await {
      Ok(j) => j,
      Err(e) => {
        return Ok(failure(format!(
          "Couldn't read the preview console: {e}. The page may still be loading — wait a \
           moment and try again."
        )))
      }
    };
    Ok(ToolResult::Text(format_console(&json, params.level.as_deref())))
  }
}

#[derive(Deserialize)]
struct ConsoleEntry {
  #[serde(default)]
  level: String,
  #[serde(default)]
  text: String,
}

/// Parse the JSON the page handed back into entries, tolerating both a raw JSON
/// array and a double-encoded JSON string holding the array (engines differ in
/// how `eval` serializes the result), and any unexpected shape (→ empty).
fn parse_console_entries(json: &str) -> Vec<ConsoleEntry> {
  if let Ok(v) = serde_json::from_str::<Vec<ConsoleEntry>>(json) {
    return v;
  }
  if let Ok(inner) = serde_json::from_str::<String>(json) {
    if let Ok(v) = serde_json::from_str::<Vec<ConsoleEntry>>(&inner) {
      return v;
    }
  }
  Vec::new()
}

/// Render captured console entries (oldest→newest) into a compact, readable log
/// for the model, optionally filtered to a single level. Caps the output so a
/// chatty page can't flood the turn.
fn format_console(json: &str, level_filter: Option<&str>) -> String {
  let entries = parse_console_entries(json);
  let want = level_filter
    .map(|s| s.trim().to_lowercase())
    .filter(|s| !s.is_empty() && s != "all");

  let mut filtered: Vec<&ConsoleEntry> = entries
    .iter()
    .filter(|e| match &want {
      Some(w) => e.level.eq_ignore_ascii_case(w),
      None => true,
    })
    .collect();

  if filtered.is_empty() {
    return match &want {
      Some(w) => format!(
        "No `{w}` messages have been logged to the preview console yet. (Note: only output \
         since the page last loaded is captured; navigate/reload to recapture.)"
      ),
      None => "No messages have been logged to the preview console yet. (Note: only output \
               since the page last loaded is captured; navigate/reload to recapture.)"
        .to_string(),
    };
  }

  let total = filtered.len();
  const MAX_LINES: usize = 80;
  if filtered.len() > MAX_LINES {
    filtered = filtered.split_off(filtered.len() - MAX_LINES);
  }

  let mut out = String::new();
  out.push_str("Console output from the preview page");
  if let Some(w) = &want {
    out.push_str(&format!(" (level: {w})"));
  }
  if total > filtered.len() {
    out.push_str(&format!(" — latest {} of {total} messages:\n", filtered.len()));
  } else {
    out.push_str(&format!(" — {total} message{}:\n", if total == 1 { "" } else { "s" }));
  }
  for e in &filtered {
    let lvl = if e.level.is_empty() {
      "LOG".to_string()
    } else {
      e.level.to_uppercase()
    };
    let text = e.text.replace(['\r', '\n'], " ");
    out.push_str(&format!("[{lvl}] {text}\n"));
  }
  out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn format_console_handles_empty_and_levels() {
    assert!(format_console("[]", None).contains("No messages"));
    assert!(format_console("not json", None).contains("No messages"));
    assert!(format_console("[]", Some("error")).contains("No `error`"));

    let logs = r#"[{"level":"log","text":"hello"},{"level":"error","text":"boom"}]"#;
    let all = format_console(logs, None);
    assert!(all.contains("[LOG] hello"));
    assert!(all.contains("[ERROR] boom"));
    assert!(all.contains("2 messages"));

    let errs = format_console(logs, Some("error"));
    assert!(errs.contains("[ERROR] boom"));
    assert!(!errs.contains("hello"));
  }

  #[test]
  fn format_console_accepts_double_encoded_json() {
    // Some engines return the value as a JSON string holding the array.
    let inner = r#"[{"level":"warn","text":"heads up"}]"#;
    let double = serde_json::to_string(inner).unwrap();
    let out = format_console(&double, None);
    assert!(out.contains("[WARN] heads up"), "got: {out}");
  }

  #[test]
  fn format_console_collapses_newlines_and_caps_lines() {
    let mut items = Vec::new();
    for i in 0..200 {
      items.push(serde_json::json!({ "level": "log", "text": format!("line\n{i}") }));
    }
    let json = serde_json::Value::Array(items).to_string();
    let out = format_console(&json, None);
    assert!(out.contains("latest 80 of 200 messages"));
    assert!(!out.contains("line\n"), "newlines should be collapsed");
  }
}
