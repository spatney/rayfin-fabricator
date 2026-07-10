//! In-process Copilot tools for deployment, live-page debugging, and Fabric
//! semantic-model discovery.
//!
//! Registered on every chat session via
//! [`SessionConfig::with_tools`](github_copilot_sdk::SessionConfig::with_tools)
//! (see [`crate::services::copilot`]). Each handler runs inside the Tauri host
//! process. Headless Graphein rendering remains the fast authoring loop; these
//! live tools close the deployment/runtime loop when browser behavior, identity,
//! network calls, or Fabric integration need a real deployed page.
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
use crate::services::{preview, semantic_model, store};

/// Build the Fabricator in-process tool set for one project's chat session.
pub fn fabricator_tools(app: AppHandle, project_id: String) -> Vec<Tool> {
  vec![
    Tool::new("fabricator_deployment_status")
      .with_description(
        "Read this project's deployment state, active workspace, deployed URLs, deployed commit, \
         and whether the working tree has changed since deployment. Use this before deciding \
         whether to deploy and after a deployment failure.",
      )
      .with_parameters(empty_parameters())
      .with_skip_permission(true)
      .with_handler(Arc::new(ProjectTool::new(&app, &project_id))),
    Tool::new("fabricator_deploy")
      .with_description(
        "Deploy or redeploy this project through Fabricator's deployment engine and wait for the \
         final result. This is the supported way to drive deployment state; do not run `rayfin up` \
         directly. On success the live preview is navigated to the deployed app so console, \
         network, DOM, interaction, and screenshot tools can validate it.",
      )
      .with_parameters(empty_parameters())
      .with_handler(Arc::new(DeployTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_navigate")
      .with_description(
        "Navigate the real deployed app to a same-app absolute URL or app-relative path, wait for \
         the page to load, and return a screenshot. Navigation cannot leave the deployed app. Use \
         direct app routes for DOM inspection; a Fabric portal shell may contain a cross-origin iframe.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "target": {
            "type": "string",
            "description": "Same-app absolute http(s) URL or app-relative path such as /reports/overview. Defaults to the deployed root."
          }
        }
      }))
      .with_handler(Arc::new(PreviewNavigateTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_screenshot")
      .with_description(
        "Capture the current live deployed page as a PNG. On Windows this works silently even when \
         the preview pane is hidden or the app is minimized.",
      )
      .with_parameters(empty_parameters())
      .with_skip_permission(true)
      .with_handler(Arc::new(PreviewScreenshotTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_console")
      .with_description(
        "Read bounded console output, uncaught exceptions, and unhandled promise rejections from \
         the live deployed page. Secrets and credential-like values are redacted.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "level": {
            "type": "string",
            "enum": ["log", "info", "warn", "error", "debug"],
            "description": "Optional exact console level filter."
          },
          "limit": {
            "type": "number",
            "description": "Maximum entries to return (default 100, maximum 200)."
          },
          "clear": {
            "type": "boolean",
            "description": "Clear the console ring after reading it."
          }
        }
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(PreviewConsoleTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_network")
      .with_description(
        "Inspect live fetch/XHR traffic and resource timings captured from document start. Returns \
         method, sanitized URL, type, status, duration, transfer size/cache source, and failure \
         reason — never request/response bodies, authorization/cookie headers, or secret query values.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "errorsOnly": {
            "type": "boolean",
            "description": "Return only failed requests and HTTP 4xx/5xx responses."
          },
          "limit": {
            "type": "number",
            "description": "Maximum entries to return (default 100, maximum 300)."
          },
          "clear": {
            "type": "boolean",
            "description": "Clear the network ring after reading it."
          }
        }
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(PreviewNetworkTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_inspect")
      .with_description(
        "Inspect the live page's title, URL, readiness, viewport/document dimensions, visible text, \
         and up to 200 visible semantic/interactive DOM elements with stable selectors and bounds. \
         Input values, cookies, storage, tokens, and hidden DOM are deliberately excluded.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "selector": {
            "type": "string",
            "description": "Optional CSS selector limiting the snapshot to one subtree."
          }
        }
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(PreviewInspectTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_interact")
      .with_description(
        "Interact with the real deployed page using a previously inspected CSS selector. Supports \
         click, focus, fill, select, check, press, scroll, and reload. Returns the safe interaction \
         result plus a screenshot so you can inspect the resulting state.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "enum": ["click", "focus", "fill", "select", "check", "press", "scroll", "reload"]
          },
          "selector": {
            "type": "string",
            "description": "CSS selector from fabricator_preview_inspect. Optional only for scroll and reload."
          },
          "value": {
            "description": "Action value: text for fill/select/press, boolean for check, or pixels/top/bottom for scroll."
          }
        },
        "required": ["action"]
      }))
      .with_handler(Arc::new(PreviewInteractTool::new(&app, &project_id))),
    Tool::new("fabricator_locate_semantic_model")
      .with_description(
        "Find the Power BI / Fabric semantic model (dataset) behind a report, app, or dataset \
         when the user gives you a link or id. Pass a Power BI URL — a report, app, dataset, or \
         model-editor link (.../modeling/<id>/modelView) — or a bare GUID as `target`. Returns \
         the model's name, workspace id, and item id. \
         A Power BI dataset id IS its Fabric semantic-model item id, so you can wire the model \
         straight into this app's data with `fabric-app-data add <alias> -w <workspaceId> -i \
         <itemId>` (see the fabric-data skill), then run a build. Use this to turn a report/app \
         link the user pastes into the underlying model the app should connect to.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "target": {
            "type": "string",
            "description": "A Power BI URL (report/app/dataset or model-editor /modeling/<id>/modelView link) or a bare GUID to resolve."
          },
          "workspace": {
            "type": "string",
            "description": "Optional workspace-id hint to speed up / disambiguate the lookup."
          },
          "admin": {
            "type": "boolean",
            "description": "Optional: also try tenant-admin lookup paths (only works if you have admin rights)."
          }
        },
        "required": ["target"]
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(LocateSemanticModelTool)),
    Tool::new("fabricator_search_semantic_models")
      .with_description(
        "Search Microsoft Fabric for semantic models (datasets) by description or keywords when \
         you do NOT have a direct link or id. Pass natural-language keywords as `query` (e.g. \
         \"sales pipeline\", \"finance revenue by region\"). Returns matching models with their \
         workspace id and item id, ready to wire into this app's data with `fabric-app-data add \
         <alias> -w <workspaceId> -i <itemId>` (see the fabric-data skill). If you already have a \
         report/app link or id, use fabricator_locate_semantic_model instead. Requires Azure CLI \
         sign-in (handled by the Fabricator setup screen).",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Description or keywords to search for, e.g. \"customer churn\"."
          },
          "types": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Optional item types to match (defaults to [\"report\", \"model\"]). Accepts report, model/dataset, lakehouse, warehouse, notebook."
          },
          "limit": {
            "type": "number",
            "description": "Optional cap on the number of catalog hits to consider (default 30)."
          }
        },
        "required": ["query"]
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(SearchSemanticModelsTool)),
  ]
}

/* ----------------------------- shared helpers ----------------------------- */

fn empty_parameters() -> serde_json::Value {
  serde_json::json!({
    "type": "object",
    "properties": {}
  })
}

#[derive(Clone)]
struct ToolContext {
  app: AppHandle,
  project_id: String,
}

impl ToolContext {
  fn new(app: &AppHandle, project_id: &str) -> Self {
    Self {
      app: app.clone(),
      project_id: project_id.to_string(),
    }
  }

  fn project(&self) -> Result<crate::types::StudioProject, String> {
    store::find_project(&self.project_id)
      .ok_or_else(|| format!("Project {} no longer exists.", self.project_id))
  }

  async fn ensure_live_preview(&self) -> Result<String, String> {
    let project = self.project()?;
    let url = preview::project_live_url(&project).ok_or_else(|| {
      "This project has no deployed live URL yet. Use fabricator_deploy first.".to_string()
    })?;
    let target_matches = preview::agent_target_matches(&self.app, &self.project_id, &url);
    preview::agent_ensure_preview(&self.app, &self.project_id, &url, Duration::from_secs(5)).await;
    if !preview::is_preview_open(&self.app) {
      return Err("Fabricator could not open the live preview.".to_string());
    }
    if !target_matches {
      preview::navigate_and_wait(&self.app, &self.project_id, &url, Duration::from_secs(15))
        .await
        .map_err(|error| error.to_string())?;
    }
    Ok(url)
  }
}

fn resolve_target(base: &str, target: Option<&str>) -> Result<String, String> {
  let Some(target) = target.map(str::trim).filter(|value| !value.is_empty()) else {
    return Ok(base.to_string());
  };
  let resolved = if target.starts_with("http://") || target.starts_with("https://") {
    tauri::Url::parse(target)
      .map(|url| url.to_string())
      .map_err(|error| format!("Invalid preview URL: {error}"))?
  } else {
    let mut root =
      tauri::Url::parse(base).map_err(|error| format!("Invalid deployed URL: {error}"))?;
    root.set_query(None);
    root.set_fragment(None);
    if !root.path().ends_with('/') {
      let path = format!("{}/", root.path());
      root.set_path(&path);
    }
    root
      .join(target.trim_start_matches('/'))
      .map(|url| url.to_string())
      .map_err(|error| format!("Invalid app-relative preview path: {error}"))?
  };

  if !preview::url_is_within_app_base(&resolved, base) {
    return Err(
      "Preview navigation is restricted to the deployed app's origin and base path.".to_string(),
    );
  }
  Ok(resolved)
}

fn safe_json(value: &impl serde::Serialize) -> String {
  let json = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
  preview::redact_diagnostic_text(&json)
}

fn image_success(text: impl Into<String>, bytes: Vec<u8>) -> ToolResult {
  ToolResult::Expanded(ToolResultExpanded {
    text_result_for_llm: text.into(),
    result_type: "success".to_string(),
    binary_results_for_llm: Some(vec![ToolBinaryResult {
      data: base64::engine::general_purpose::STANDARD.encode(bytes),
      mime_type: "image/png".to_string(),
      r#type: "image".to_string(),
      description: Some("Live deployed app preview".to_string()),
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

macro_rules! context_tool {
  ($name:ident) => {
    struct $name(ToolContext);

    impl $name {
      fn new(app: &AppHandle, project_id: &str) -> Self {
        Self(ToolContext::new(app, project_id))
      }
    }
  };
}

context_tool!(ProjectTool);
context_tool!(DeployTool);
context_tool!(PreviewNavigateTool);
context_tool!(PreviewScreenshotTool);
context_tool!(PreviewConsoleTool);
context_tool!(PreviewNetworkTool);
context_tool!(PreviewInspectTool);
context_tool!(PreviewInteractTool);

#[async_trait]
impl ToolHandler for ProjectTool {
  async fn call(&self, _invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let project = match self.0.project() {
      Ok(project) => project,
      Err(error) => return Ok(failure(error)),
    };
    let status = deploy::deploy_status(self.0.project_id.clone()).await;
    let has_changes = deploy::deploy_has_changes(self.0.project_id.clone()).await;
    Ok(ToolResult::Text(safe_json(&serde_json::json!({
      "status": status,
      "hasChangesSinceDeploy": has_changes,
      "workspace": {
        "id": project.workspace,
        "name": project.workspace_name,
      },
      "liveDebugUrl": preview::project_live_url(&project),
      "lastDeploy": project.last_deploy,
    }))))
  }
}

#[async_trait]
impl ToolHandler for DeployTool {
  async fn call(&self, _invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let result = deploy::run_deploy(self.0.app.clone(), self.0.project_id.clone(), None).await;
    if !result.ok {
      let error = result
        .error
        .as_deref()
        .unwrap_or("Deployment did not complete successfully.");
      return Ok(failure(format!(
        "Deployment failed with outcome {:?}: {}",
        result.outcome,
        preview::redact_diagnostic_text(error)
      )));
    }

    let project = match self.0.project() {
      Ok(project) => project,
      Err(error) => return Ok(failure(error)),
    };
    if let Some(url) = preview::project_live_url(&project) {
      preview::agent_ensure_preview(&self.0.app, &self.0.project_id, &url, Duration::from_secs(5))
        .await;
      if let Err(error) = preview::navigate_and_wait(
        &self.0.app,
        &self.0.project_id,
        &url,
        Duration::from_secs(20),
      )
      .await
      {
        return Ok(failure(format!(
          "Deployment succeeded, but the live preview could not navigate to {url}: {error}"
        )));
      }
    }

    Ok(ToolResult::Text(safe_json(&result)))
  }
}

#[derive(Default, Deserialize)]
struct NavigateParams {
  #[serde(default, alias = "url", alias = "path")]
  target: Option<String>,
}

#[async_trait]
impl ToolHandler for PreviewNavigateTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: NavigateParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    let base = match self.0.ensure_live_preview().await {
      Ok(url) => url,
      Err(error) => return Ok(failure(error)),
    };
    let target = match resolve_target(&base, params.target.as_deref()) {
      Ok(url) => url,
      Err(error) => return Ok(failure(error)),
    };
    if let Err(error) = preview::navigate_and_wait(
      &self.0.app,
      &self.0.project_id,
      &target,
      Duration::from_secs(20),
    )
    .await
    {
      return Ok(failure(error.to_string()));
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    match preview::agent_capture(&self.0.app).await {
      Ok(bytes) => Ok(image_success(format!("Navigated the live app to {target}."), bytes)),
      Err(error) => Ok(failure(format!(
        "The page loaded at {target}, but its screenshot failed: {error}"
      ))),
    }
  }
}

#[async_trait]
impl ToolHandler for PreviewScreenshotTool {
  async fn call(&self, _invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    if let Err(error) = self.0.ensure_live_preview().await {
      return Ok(failure(error));
    }
    match preview::agent_capture(&self.0.app).await {
      Ok(bytes) => Ok(image_success("Captured the current live deployed page.", bytes)),
      Err(error) => Ok(failure(error.to_string())),
    }
  }
}

#[derive(Default, Deserialize)]
struct ConsoleParams {
  #[serde(default)]
  level: Option<String>,
  #[serde(default)]
  limit: Option<usize>,
  #[serde(default)]
  clear: Option<bool>,
}

#[async_trait]
impl ToolHandler for PreviewConsoleTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: ConsoleParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    if let Err(error) = self.0.ensure_live_preview().await {
      return Ok(failure(error));
    }
    let entries = match preview::read_console(
      &self.0.app,
      params.level.as_deref(),
      params.limit.unwrap_or(100),
      params.clear.unwrap_or(false),
    )
    .await
    {
      Ok(entries) => entries,
      Err(error) => return Ok(failure(error.to_string())),
    };
    if entries.as_array().is_some_and(Vec::is_empty) {
      return Ok(ToolResult::Text(
        "No matching console entries have been captured on the current page.".to_string(),
      ));
    }
    Ok(ToolResult::Text(safe_json(&entries)))
  }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkParams {
  #[serde(default)]
  errors_only: Option<bool>,
  #[serde(default)]
  limit: Option<usize>,
  #[serde(default)]
  clear: Option<bool>,
}

#[async_trait]
impl ToolHandler for PreviewNetworkTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: NetworkParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    if let Err(error) = self.0.ensure_live_preview().await {
      return Ok(failure(error));
    }
    let entries = match preview::read_network(
      &self.0.app,
      params.errors_only.unwrap_or(false),
      params.limit.unwrap_or(100),
      params.clear.unwrap_or(false),
    )
    .await
    {
      Ok(entries) => entries,
      Err(error) => return Ok(failure(error.to_string())),
    };
    if entries.as_array().is_some_and(Vec::is_empty) {
      return Ok(ToolResult::Text(
        "No matching network activity has been captured on the current page.".to_string(),
      ));
    }
    Ok(ToolResult::Text(safe_json(&entries)))
  }
}

#[derive(Default, Deserialize)]
struct InspectParams {
  #[serde(default)]
  selector: Option<String>,
}

#[async_trait]
impl ToolHandler for PreviewInspectTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: InspectParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    if let Err(error) = self.0.ensure_live_preview().await {
      return Ok(failure(error));
    }
    match preview::inspect_page(&self.0.app, params.selector.as_deref()).await {
      Ok(snapshot) => Ok(ToolResult::Text(safe_json(&snapshot))),
      Err(error) => Ok(failure(error.to_string())),
    }
  }
}

#[derive(Deserialize)]
struct InteractParams {
  action: String,
  #[serde(default)]
  selector: Option<String>,
  #[serde(default)]
  value: Option<serde_json::Value>,
}

#[async_trait]
impl ToolHandler for PreviewInteractTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: InteractParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    let base = match self.0.ensure_live_preview().await {
      Ok(url) => url,
      Err(error) => return Ok(failure(error)),
    };
    let result = match preview::interact(
      &self.0.app,
      params.action.trim(),
      params.selector.as_deref(),
      params.value,
      &base,
    )
    .await
    {
      Ok(result) => result,
      Err(error) => return Ok(failure(error.to_string())),
    };
    if result.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
      return Ok(failure(safe_json(&result)));
    }
    let settle = if params.action == "reload" { 900 } else { 350 };
    tokio::time::sleep(Duration::from_millis(settle)).await;
    if !preview::agent_target_matches(&self.0.app, &self.0.project_id, &base) {
      let _ = preview::navigate_and_wait(
        &self.0.app,
        &self.0.project_id,
        &base,
        Duration::from_secs(15),
      )
      .await;
      return Ok(failure(
        "The interaction navigated outside the deployed app, so Fabricator returned to the app root.",
      ));
    }
    let text = safe_json(&result);
    match preview::agent_capture(&self.0.app).await {
      Ok(bytes) => Ok(image_success(text, bytes)),
      Err(_) => Ok(ToolResult::Text(text)),
    }
  }
}

/* ------------------------ semantic-model locator -------------------------- */


struct LocateSemanticModelTool;

#[derive(Deserialize)]
struct LocateParams {
  #[serde(alias = "url", alias = "id", alias = "link", alias = "report", alias = "app")]
  target: String,
  #[serde(default)]
  workspace: Option<String>,
  #[serde(default)]
  admin: Option<bool>,
}

#[async_trait]
impl ToolHandler for LocateSemanticModelTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: LocateParams = match invocation.params() {
      Ok(p) => p,
      Err(e) => return Ok(failure(format!("Invalid arguments: {e}"))),
    };
    let target = params.target.trim();
    if target.is_empty() {
      return Ok(failure(
        "Provide a report/app/dataset id or a Power BI URL as `target`.",
      ));
    }
    let result = semantic_model::locate_semantic_model(
      target,
      params.workspace.as_deref(),
      params.admin.unwrap_or(false),
    )
    .await;
    Ok(render_semantic_model_result(&result))
  }
}

struct SearchSemanticModelsTool;

#[derive(Deserialize)]
struct SearchParams {
  #[serde(alias = "description", alias = "keywords", alias = "q", alias = "text")]
  query: String,
  #[serde(default)]
  types: Option<Vec<String>>,
  #[serde(default)]
  limit: Option<u32>,
}

#[async_trait]
impl ToolHandler for SearchSemanticModelsTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: SearchParams = match invocation.params() {
      Ok(p) => p,
      Err(e) => return Ok(failure(format!("Invalid arguments: {e}"))),
    };
    let query = params.query.trim();
    if query.is_empty() {
      return Ok(failure(
        "Provide a description or keywords to search for as `query`.",
      ));
    }
    let result = semantic_model::search_semantic_models(query, params.types.clone(), params.limit).await;
    Ok(render_semantic_model_result(&result))
  }
}

/// Render a [`semantic_model::SemanticModelResult`] (from either tool) into a
/// compact text block the agent can act on, including the `fabric-app-data add`
/// wiring command for the top match and any access/admin notes.
fn render_semantic_model_result(r: &semantic_model::SemanticModelResult) -> ToolResult {
  use std::fmt::Write as _;

  if !r.ok {
    let base = r
      .error
      .clone()
      .unwrap_or_else(|| "The semantic-model lookup failed.".to_string());
    if r.needs_az {
      return failure(format!(
        "Azure CLI isn't signed in, which is required to search the Fabric catalog. Run \
         `az login` (or use the Fabricator setup screen), then try again. ({base})"
      ));
    }
    if r.needs_login {
      return failure(format!(
        "Not signed in to Rayfin, so I couldn't query Power BI / Fabric. Sign in from the \
         Fabricator setup screen, then try again. ({base})"
      ));
    }
    return failure(base);
  }

  let mut out = String::new();

  // What the target (locate) resolved through, for context.
  if let Some(app) = &r.app {
    let name = app.name.as_deref().unwrap_or("(app)");
    let _ = write!(out, "Resolved app '{name}'");
    if let Some(ws) = app.workspace_name.as_deref().or(app.workspace_id.as_deref()) {
      let _ = write!(out, " in workspace {ws}");
    }
    out.push_str(".\n");
  } else if let Some(rep) = &r.report {
    let name = rep.name.as_deref().unwrap_or("(report)");
    let _ = write!(out, "Resolved report '{name}'");
    if let Some(ws) = rep.workspace_name.as_deref().or(rep.workspace_id.as_deref()) {
      let _ = write!(out, " in workspace {ws}");
    }
    out.push_str(".\n");
  }

  if r.models.is_empty() {
    out.push_str(if r.matched {
      "Matched the target, but its semantic model couldn't be resolved (you may not have access to it).\n"
    } else {
      "No matching semantic model was found.\n"
    });
  } else {
    let n = r.models.len();
    let _ = writeln!(out, "Found {n} semantic model{}:", if n == 1 { "" } else { "s" });
    for (i, m) in r.models.iter().enumerate() {
      let name = m.name.as_deref().unwrap_or("(unnamed model)");
      let item = m.item_id.as_deref().or(m.id.as_deref()).unwrap_or("?");
      let ws_id = m.workspace_id.as_deref().unwrap_or("?");
      let _ = writeln!(out, "{}. {name}", i + 1);
      if let Some(wn) = m.workspace_name.as_deref() {
        let _ = writeln!(out, "   workspace: {wn} ({ws_id})");
      } else {
        let _ = writeln!(out, "   workspace id: {ws_id}");
      }
      let _ = writeln!(out, "   item id (= dataset id): {item}");
      if let Some(via) = m.matched_via.as_deref() {
        let _ = writeln!(out, "   matched via: {via}");
      }
      if let Some(owner) = m.owner.as_deref() {
        let _ = writeln!(out, "   owner: {owner}");
      }
      if let Some(url) = m.web_url.as_deref() {
        let _ = writeln!(out, "   url: {url}");
      }
    }
    let first = &r.models[0];
    if let (Some(ws), Some(item)) = (
      first.workspace_id.as_deref(),
      first.item_id.as_deref().or(first.id.as_deref()),
    ) {
      let _ = write!(
        out,
        "\nTo connect this app to the first model, add it to the app's data with:\n  \
         fabric-app-data add <alias> -w {ws} -i {item}\nthen run a build (see the fabric-data skill).\n"
      );
    }
  }

  if !r.other_matches.is_empty() {
    out.push_str("\nOther catalog matches (not semantic models):\n");
    for o in &r.other_matches {
      let name = o.display_name.as_deref().unwrap_or("(item)");
      let ty = o.r#type.as_deref().unwrap_or("item");
      let ws = o
        .workspace_name
        .as_deref()
        .or(o.workspace_id.as_deref())
        .unwrap_or("?");
      let _ = writeln!(out, "- {name} [{ty}] in {ws}");
    }
  }

  if !r.notes.is_empty() {
    out.push_str("\nNotes:\n");
    for note in &r.notes {
      let _ = writeln!(out, "- {note}");
    }
  }

  // The helper sometimes returns a soft hint (ok:true) instead of a match.
  if r.models.is_empty() {
    if let Some(hint) = r.error.as_deref() {
      let _ = write!(out, "\n{hint}");
    }
  }

  ToolResult::Text(out.trim_end().to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn text_of(r: &ToolResult) -> String {
    match r {
      ToolResult::Text(s) => s.clone(),
      ToolResult::Expanded(e) => e.text_result_for_llm.clone(),
      _ => String::new(),
    }
  }

  #[test]
  fn render_sm_needs_az_points_to_az_login() {
    let r = semantic_model::SemanticModelResult {
      ok: false,
      needs_az: true,
      error: Some("az account get-access-token failed".into()),
      ..Default::default()
    };
    let t = text_of(&render_semantic_model_result(&r));
    assert!(t.contains("az login"), "got: {t}");
  }

  #[test]
  fn render_sm_lists_models_and_wiring_command() {
    let m = semantic_model::SemanticModel {
      name: Some("Sales".into()),
      id: Some("ds-1".into()),
      item_id: Some("ds-1".into()),
      workspace_id: Some("ws-1".into()),
      workspace_name: Some("Finance".into()),
      ..Default::default()
    };
    let r = semantic_model::SemanticModelResult {
      ok: true,
      matched: true,
      models: vec![m],
      ..Default::default()
    };
    let t = text_of(&render_semantic_model_result(&r));
    assert!(t.contains("Sales"), "got: {t}");
    assert!(t.contains("item id (= dataset id): ds-1"), "got: {t}");
    assert!(
      t.contains("fabric-app-data add <alias> -w ws-1 -i ds-1"),
      "got: {t}"
    );
  }

  #[test]
  fn render_sm_soft_no_match_surfaces_hint() {
    let r = semantic_model::SemanticModelResult {
      ok: true,
      matched: false,
      error: Some("That looks like a GUID — use the locate tool for direct id/URL lookups.".into()),
      ..Default::default()
    };
    let t = text_of(&render_semantic_model_result(&r));
    assert!(t.contains("No matching semantic model"), "got: {t}");
    assert!(t.contains("use the locate tool"), "got: {t}");
  }

  #[test]
  fn resolve_target_keeps_app_base_path() {
    let resolved = resolve_target(
      "https://example.test/appbackends/item-1/",
      Some("/reports/overview"),
    )
    .unwrap();
    assert_eq!(
      resolved,
      "https://example.test/appbackends/item-1/reports/overview"
    );
  }

  #[test]
  fn resolve_target_rejects_external_and_parent_navigation() {
    let base = "https://example.test/appbackends/item-1/";
    assert!(resolve_target(base, Some("https://other.test/private")).is_err());
    assert!(resolve_target(base, Some("../../private")).is_err());
  }

  #[test]
  fn safe_json_redacts_credentials() {
    let value = serde_json::json!({
      "header": "Bearer abc.def.ghi",
      "url": "https://example.test/?token=secret&view=main",
      "access_token": "very-secret",
      "message": "apiKey=also-secret",
      "clientSecret": "client-secret-value",
      "connection": "AccountKey=account-key-value",
    });
    let rendered = safe_json(&value);
    assert!(!rendered.contains("very-secret"), "got: {rendered}");
    assert!(!rendered.contains("token=secret"), "got: {rendered}");
    assert!(!rendered.contains("Bearer abc.def.ghi"), "got: {rendered}");
    assert!(!rendered.contains("also-secret"), "got: {rendered}");
    assert!(!rendered.contains("client-secret-value"), "got: {rendered}");
    assert!(!rendered.contains("account-key-value"), "got: {rendered}");
    assert!(rendered.contains("<redacted>"), "got: {rendered}");
  }
}
