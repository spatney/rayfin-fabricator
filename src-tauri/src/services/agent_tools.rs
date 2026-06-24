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
use std::time::{Duration, Instant};

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
      .with_handler(Arc::new(ScreenshotTool { app, project_id })),
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

/// Ensure the preview webview exists and is on screen. Always asks the renderer
/// to surface the preview (switch to the build view, un-collapse the pane) so the
/// user watches what the agent is validating; then waits for the child webview to
/// exist if this is the first time it is shown this session.
async fn ensure_preview(app: &AppHandle, url: &str) {
  preview::request_preview_show(app, url);
  if preview::is_preview_open(app) {
    // Already created earlier (the renderer only hides it, never destroys it) —
    // give the renderer a beat to re-show it at the host's bounds.
    tokio::time::sleep(Duration::from_millis(300)).await;
    return;
  }
  // First-ever show: wait for the renderer's positioning loop to build it.
  let start = Instant::now();
  while start.elapsed() < SHOW_TIMEOUT {
    tokio::time::sleep(Duration::from_millis(150)).await;
    if preview::is_preview_open(app) {
      // Give the first document a moment to paint before any capture.
      tokio::time::sleep(Duration::from_millis(400)).await;
      return;
    }
  }
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
    let result = deploy::run_deploy(self.app.clone(), self.project_id.clone(), None, None).await;
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

    match preview::capture_preview_bytes(&self.app).await {
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
    match preview::capture_preview_bytes(&self.app).await {
      Ok(png) => {
        let where_ = live.map(|u| format!(" (showing {u})")).unwrap_or_default();
        Ok(image_result(
          format!("Screenshot of the running app{where_}."),
          png,
          "Preview screenshot".to_string(),
        ))
      }
      Err(e) if live.is_some() => Ok(failure(format!(
        "The app is deployed but the preview browser isn't ready to capture yet ({e}). It \
         should appear in the Fabricator window momentarily — wait a moment and screenshot \
         again, or use fabricator_navigate to open a specific route."
      ))),
      Err(e) => Ok(failure(format!(
        "Couldn't capture the preview: {e}. Deploy the app first with \
         fabricator_deploy_and_wait, then try again."
      ))),
    }
  }
}
