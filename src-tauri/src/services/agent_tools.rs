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

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::{ToolBinaryResult, ToolInvocation, ToolResultExpanded};
use github_copilot_sdk::{Error as SdkError, Tool, ToolResult};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::deploy;
use crate::services::{paths, preview, semantic_model, store};
use crate::types::{AgentToolCatalogGroup, AgentToolCatalogItem, AgentToolSettings};

const DEFAULT_INLINE_CHARS: usize = 8_000;
const STRUCTURED_INLINE_CEILING: usize = 16_000;
const RAW_INLINE_CEILING: usize = 64_000;
const MIN_INLINE_CHARS: usize = 256;
const DIAGNOSTIC_ARTIFACT_DIR: &str = "fabricator-diagnostics";

fn catalog_item(id: &str, label: &str, description: &str) -> AgentToolCatalogItem {
  AgentToolCatalogItem {
    id: id.to_string(),
    label: label.to_string(),
    description: description.to_string(),
  }
}

/// Canonical user-facing catalog for Fabricator's in-process agent capabilities.
pub fn tool_catalog() -> Vec<AgentToolCatalogGroup> {
  vec![
    AgentToolCatalogGroup {
      id: "deployment".into(),
      label: "Deployment".into(),
      description: "Read and drive the app's Fabric deployment state.".into(),
      tools: vec![
        catalog_item(
          "fabricator_deployment_status",
          "Deployment status",
          "Read the active deployment, workspace, URLs, and pending code changes.",
        ),
        catalog_item(
          "fabricator_deploy",
          "Deploy app",
          "Deploy or redeploy through Fabricator and wait for the final result.",
        ),
      ],
    },
    AgentToolCatalogGroup {
      id: "diagnostics".into(),
      label: "Diagnostics".into(),
      description: "Inspect what the deployed app rendered and reported.".into(),
      tools: vec![
        catalog_item(
          "fabricator_preview_console",
          "Console",
          "Read filtered console messages and page errors.",
        ),
        catalog_item(
          "fabricator_preview_network",
          "Network traffic",
          "Inspect filtered fetch, XHR, and resource activity.",
        ),
        catalog_item(
          "fabricator_preview_inspect",
          "Page inspection",
          "Read a safe, filtered semantic snapshot of the live page.",
        ),
        catalog_item(
          "fabricator_preview_screenshot",
          "Screenshot",
          "Capture the real deployed page as a persistent PNG.",
        ),
      ],
    },
    AgentToolCatalogGroup {
      id: "page-control".into(),
      label: "Page control".into(),
      description: "Navigate and operate the deployed app like a user.".into(),
      tools: vec![
        catalog_item(
          "fabricator_preview_navigate",
          "Navigate",
          "Open a route inside the deployed app.",
        ),
        catalog_item(
          "fabricator_preview_interact",
          "Interact",
          "Click, focus, fill, select, check, press, scroll, or reload.",
        ),
      ],
    },
    AgentToolCatalogGroup {
      id: "advanced-browser".into(),
      label: "Advanced browser / CDP".into(),
      description: "Unrestricted live-page debugging and browser protocol access.".into(),
      tools: vec![
        catalog_item(
          "fabricator_preview_evaluate",
          "Run page JavaScript",
          "Execute arbitrary JavaScript in the deployed page.",
        ),
        catalog_item(
          "fabricator_preview_cdp",
          "Chrome DevTools Protocol",
          "Call raw Runtime, DOM, CSS, Network, Page, Debugger, and other CDP methods.",
        ),
      ],
    },
    AgentToolCatalogGroup {
      id: "fabric-data".into(),
      label: "Fabric data".into(),
      description: "Find semantic models to connect to the app.".into(),
      tools: vec![
        catalog_item(
          "fabricator_locate_semantic_model",
          "Locate semantic model",
          "Resolve a report, app, model URL, or item ID to its semantic model.",
        ),
        catalog_item(
          "fabricator_search_semantic_models",
          "Search semantic models",
          "Search the Fabric catalog for relevant semantic models.",
        ),
      ],
    },
  ]
}

pub fn tool_settings(
  project_id: &str,
  groups: Vec<AgentToolCatalogGroup>,
) -> Result<AgentToolSettings, String> {
  let project =
    store::find_project(project_id).ok_or_else(|| format!("Project {project_id} no longer exists."))?;
  let disabled: HashSet<&str> = project
    .disabled_agent_tools
    .as_deref()
    .unwrap_or_default()
    .iter()
    .map(String::as_str)
    .collect();
  let enabled_tool_ids = groups
    .iter()
    .flat_map(|group| group.tools.iter())
    .filter(|tool| !disabled.contains(tool.id.as_str()))
    .map(|tool| tool.id.clone())
    .collect();
  Ok(AgentToolSettings { groups, enabled_tool_ids })
}

/// Build the Fabricator in-process tool set for one project's chat session.
pub fn fabricator_tools(app: AppHandle, project_id: String) -> Vec<Tool> {
  let disabled: HashSet<String> = store::find_project(&project_id)
    .and_then(|project| project.disabled_agent_tools)
    .unwrap_or_default()
    .into_iter()
    .collect();
  let mut tools = vec![
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
         network, DOM, interaction, and screenshot tools can validate it. For a Data App in \
         Fabric preview mode, these tools automatically target the embedded app frame.",
      )
      .with_parameters(empty_parameters())
      .with_handler(Arc::new(DeployTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_navigate")
      .with_description(
        "Navigate the real deployed app to a same-app absolute URL or app-relative path and wait for \
         the page to load. Navigation cannot leave the deployed app. A screenshot is opt-in to keep \
         results compact. A Data App in Fabric preview mode navigates inside its embedded frame \
         without leaving the Fabric portal.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "target": {
            "type": "string",
            "description": "Same-app absolute http(s) URL or app-relative path such as /reports/overview. Defaults to the deployed root."
          },
          "screenshot": {
            "type": "boolean",
            "description": "Also capture the resulting page (default false)."
          }
        }
      }))
      .with_handler(Arc::new(PreviewNavigateTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_screenshot")
      .with_description(
        "Capture the current live deployed page as a PNG. On Windows this works silently even when \
         the preview pane is hidden or the app is minimized. The PNG always persists with the \
         resumable Copilot session; choose whether it is also sent inline to the model. Embedded \
         Data Apps are captured from their app frame when WebView2 exposes it.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "delivery": {
            "type": "string",
            "enum": ["inline", "file"],
            "description": "inline (default) sends the image to the model and shows it in the timeline; file returns only the persistent artifact path."
          }
        }
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(PreviewScreenshotTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_console")
      .with_description(
        "Read bounded console output, uncaught exceptions, and unhandled promise rejections from \
         the live deployed page. Secrets and credential-like values are redacted. Embedded Data \
         Apps are read from the app frame rather than the Fabric shell.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "level": {
            "type": "string",
            "enum": ["log", "info", "warn", "error", "debug"],
            "description": "Optional exact console level filter."
          },
          "query": {
            "type": "string",
            "description": "Optional case-insensitive substring matched against message text, kind, and URL."
          },
          "since": {
            "type": "number",
            "description": "Only include entries at or after this epoch timestamp in milliseconds."
          },
          "limit": {
            "type": "number",
            "description": "Maximum matching entries to return (default 50, maximum 200)."
          },
          "clear": {
            "type": "boolean",
            "description": "Clear the console ring after reading it."
          },
          "maxInlineChars": {
            "type": "number",
            "description": "Inline text budget (default 8000, hard maximum 16000)."
          },
          "overflow": {
            "type": "string",
            "enum": ["file", "truncate", "error"],
            "description": "What to do above the inline budget (default file). Session files persist for resume."
          }
        }
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(PreviewConsoleTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_network")
      .with_description(
        "Inspect live fetch/XHR traffic and resource timings captured from document start. Returns \
         method, sanitized URL, type, status, duration, transfer size/cache source, and failure \
         reason — never request/response bodies, authorization/cookie headers, or secret query values. \
         Embedded Data Apps are read from the app frame rather than the Fabric shell.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "errorsOnly": {
            "type": "boolean",
            "description": "Return only failed requests and HTTP 4xx/5xx responses."
          },
          "query": {
            "type": "string",
            "description": "Optional case-insensitive substring matched across URL, method, type, and failure reason."
          },
          "urlIncludes": {
            "type": "string",
            "description": "Optional case-insensitive substring matched only against the sanitized URL."
          },
          "method": {
            "type": "string",
            "description": "Optional exact HTTP method such as GET or POST."
          },
          "resourceType": {
            "type": "string",
            "description": "Optional exact type such as fetch, xhr, script, css, or image."
          },
          "statusMin": {
            "type": "number",
            "description": "Optional minimum HTTP status (entries without status are excluded)."
          },
          "statusMax": {
            "type": "number",
            "description": "Optional maximum HTTP status (entries without status are excluded)."
          },
          "since": {
            "type": "number",
            "description": "Only include entries at or after this epoch timestamp in milliseconds."
          },
          "limit": {
            "type": "number",
            "description": "Maximum matching entries to return (default 50, maximum 300)."
          },
          "clear": {
            "type": "boolean",
            "description": "Clear the network ring after reading it."
          },
          "maxInlineChars": {
            "type": "number",
            "description": "Inline text budget (default 8000, hard maximum 16000)."
          },
          "overflow": {
            "type": "string",
            "enum": ["file", "truncate", "error"],
            "description": "What to do above the inline budget (default file). Session files persist for resume."
          }
        }
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(PreviewNetworkTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_inspect")
      .with_description(
        "Inspect the live page's title, URL, readiness, viewport/document dimensions, visible text, \
         and up to 200 visible semantic/interactive DOM elements with stable selectors and bounds. \
         Input values, cookies, storage, tokens, and hidden DOM are deliberately excluded. Embedded \
         Data Apps are inspected inside their cross-origin app frame.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "selector": {
            "type": "string",
            "description": "Optional CSS selector limiting the snapshot to one subtree."
          },
          "query": {
            "type": "string",
            "description": "Optional case-insensitive substring matched against each element's text, label, role, tag, selector, and href."
          },
          "limit": {
            "type": "number",
            "description": "Maximum matching elements (default 100, maximum 200)."
          },
          "includeBodyText": {
            "type": "boolean",
            "description": "Include up to 4000 characters of visible body text (default true)."
          },
          "maxInlineChars": {
            "type": "number",
            "description": "Inline text budget (default 8000, hard maximum 16000)."
          },
          "overflow": {
            "type": "string",
            "enum": ["file", "truncate", "error"],
            "description": "What to do above the inline budget (default file). Session files persist for resume."
          }
        }
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(PreviewInspectTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_interact")
      .with_description(
        "Interact with the real deployed page using a previously inspected CSS selector. Supports \
         click, focus, fill, select, check, press, scroll, and reload. Returns a compact result; \
         request a screenshot only when visual confirmation is useful. Embedded Data Apps are \
         operated inside their app frame.",
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
          },
          "screenshot": {
            "type": "boolean",
            "description": "Also capture the resulting page (default false)."
          }
        },
        "required": ["action"]
      }))
      .with_handler(Arc::new(PreviewInteractTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_evaluate")
      .with_description(
        "Execute arbitrary JavaScript in the real deployed page through CDP Runtime.evaluate. \
         Supports promises and returns the raw protocol result, including exceptions. This is the \
         unrestricted escape hatch when inspect/interact tools are not enough: it can read or \
         mutate any page state, DOM, browser storage, cookies visible to JavaScript, and issue \
         page-context requests. Embedded Data Apps execute in the app frame, not the Fabric shell.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "expression": {
            "type": "string",
            "description": "JavaScript expression to execute. Use an async IIFE for multi-step asynchronous work."
          },
          "awaitPromise": {
            "type": "boolean",
            "description": "Await a returned promise (default true)."
          },
          "returnByValue": {
            "type": "boolean",
            "description": "Serialize the result value (default true). Set false to retain a CDP objectId."
          },
          "timeoutMs": {
            "type": "number",
            "description": "Evaluation timeout in milliseconds (default 10000, maximum 30000)."
          },
          "maxInlineChars": {
            "type": "number",
            "description": "Inline text budget (default 8000, hard maximum 64000)."
          },
          "overflow": {
            "type": "string",
            "enum": ["file", "truncate", "error"],
            "description": "What to do above the inline budget (default file). Raw artifact content is unredacted."
          }
        },
        "required": ["expression"]
      }))
      .with_handler(Arc::new(PreviewEvaluateTool::new(&app, &project_id))),
    Tool::new("fabricator_preview_cdp")
      .with_description(
        "Call any Chrome DevTools Protocol method against the live preview page and return the raw \
         JSON response. Use this advanced escape hatch for Runtime, DOM, CSS, Network, Page, Log, \
         Performance, Debugger, Emulation, Storage, or other protocol capabilities not covered by \
         Fabricator's higher-level tools. For an embedded Data App, Fabricator attaches a persistent \
         CDP session to its iframe target. Available on Windows WebView2.",
      )
      .with_parameters(serde_json::json!({
        "type": "object",
        "properties": {
          "method": {
            "type": "string",
            "description": "CDP method name, for example Runtime.evaluate, DOM.getDocument, Page.reload, or Network.enable."
          },
          "params": {
            "type": "object",
            "description": "Raw CDP parameters object. Defaults to {}."
          },
          "timeoutMs": {
            "type": "number",
            "description": "Host wait timeout in milliseconds (default 10000, maximum 30000)."
          },
          "maxInlineChars": {
            "type": "number",
            "description": "Inline text budget (default 8000, hard maximum 64000)."
          },
          "overflow": {
            "type": "string",
            "enum": ["file", "truncate", "error"],
            "description": "What to do above the inline budget (default file). Raw artifact content is unredacted."
          }
        },
        "required": ["method"]
      }))
      .with_handler(Arc::new(PreviewCdpTool::new(&app, &project_id))),
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
          },
          "maxInlineChars": {
            "type": "number",
            "description": "Inline text budget (default 8000, hard maximum 16000)."
          },
          "overflow": {
            "type": "string",
            "enum": ["file", "truncate", "error"],
            "description": "What to do above the inline budget (default file)."
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
          },
          "maxInlineChars": {
            "type": "number",
            "description": "Inline text budget (default 8000, hard maximum 16000)."
          },
          "overflow": {
            "type": "string",
            "enum": ["file", "truncate", "error"],
            "description": "What to do above the inline budget (default file)."
          }
        },
        "required": ["query"]
      }))
      .with_skip_permission(true)
      .with_handler(Arc::new(SearchSemanticModelsTool)),
  ];
  tools.retain(|tool| !disabled.contains(&tool.name));
  tools
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

  async fn ensure_live_preview(&self) -> Result<preview::AgentPreviewTarget, String> {
    let local =
      crate::services::dev_server::ensure(self.app.clone(), self.project_id.clone()).await;
    if !local.ok {
      return Err(local
        .error
        .unwrap_or_else(|| "The local preview could not be started.".to_string()));
    }
    let project = self.project()?;
    let target = preview::project_agent_target(&project).ok_or_else(|| {
      "This project has no local preview URL yet. Use fabricator_deploy first.".to_string()
    })?;
    let target_matches = preview::agent_target_matches(&self.app, &self.project_id, &target);
    preview::agent_ensure_preview(
      &self.app,
      &self.project_id,
      &target.surface_url,
      Duration::from_secs(5),
    )
    .await;
    if !preview::is_preview_open(&self.app) {
      return Err("Fabricator could not open the live preview.".to_string());
    }
    if !target_matches {
      preview::navigate_and_wait(
        &self.app,
        &self.project_id,
        &target.surface_url,
        Duration::from_secs(20),
      )
      .await
      .map_err(|error| error.to_string())?;
    }
    if let Some(frame_origin) = target.frame_origin.as_deref() {
      let initial_wait = if target_matches {
        Duration::from_secs(5)
      } else {
        Duration::from_secs(20)
      };
      match preview::wait_for_diagnostics_frame(&self.app, frame_origin, initial_wait).await {
        Ok(_) => {}
        Err(error) if !target_matches => return Err(error.to_string()),
        Err(_) => {
          preview::navigate_and_wait(
            &self.app,
            &self.project_id,
            &target.surface_url,
            Duration::from_secs(20),
          )
          .await
          .map_err(|error| error.to_string())?;
          preview::wait_for_diagnostics_frame(&self.app, frame_origin, Duration::from_secs(20))
            .await
            .map_err(|error| error.to_string())?;
        }
      }
    }
    Ok(target)
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

fn raw_json(value: &impl serde::Serialize) -> String {
  serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string())
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum OverflowMode {
  #[default]
  File,
  Truncate,
  Error,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputOptions {
  #[serde(default)]
  max_inline_chars: Option<usize>,
  #[serde(default)]
  overflow: Option<OverflowMode>,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ImageDelivery {
  #[default]
  Inline,
  File,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactMeta {
  path: String,
  session_path: String,
  bytes: usize,
  format: String,
  mime_type: String,
  hint: String,
}

fn safe_file_component(value: &str) -> String {
  let safe: String = value
    .chars()
    .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') { ch } else { '-' })
    .take(80)
    .collect();
  if safe.is_empty() { "artifact".into() } else { safe }
}

fn artifact_path(invocation: &ToolInvocation, extension: &str) -> (PathBuf, String) {
  let session_id = safe_file_component(invocation.session_id.as_str());
  let file_name = format!(
    "{}-{}-{}.{}",
    chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
    safe_file_component(&invocation.tool_name),
    safe_file_component(&invocation.tool_call_id),
    extension
  );
  let session_path = format!("files/{DIAGNOSTIC_ARTIFACT_DIR}/{file_name}");
  (
    paths::home_dir()
      .join(".copilot")
      .join("session-state")
      .join(session_id)
      .join("files")
      .join(DIAGNOSTIC_ARTIFACT_DIR)
      .join(file_name),
    session_path,
  )
}

fn write_artifact(
  invocation: &ToolInvocation,
  bytes: &[u8],
  extension: &str,
  format: &str,
  mime_type: &str,
) -> Result<ArtifactMeta, String> {
  let (path, session_path) = artifact_path(invocation, extension);
  let parent = path
    .parent()
    .ok_or_else(|| "Could not resolve the session artifact directory.".to_string())?;
  fs::create_dir_all(parent)
    .map_err(|error| format!("Could not create the session artifact directory: {error}"))?;
  fs::write(&path, bytes)
    .map_err(|error| format!("Could not write the session diagnostic artifact: {error}"))?;
  Ok(ArtifactMeta {
    path: path.to_string_lossy().into_owned(),
    session_path,
    bytes: bytes.len(),
    format: format.to_string(),
    mime_type: mime_type.to_string(),
    hint: if format == "json" {
      "Read this persistent session file with a targeted JSON script or query.".into()
    } else {
      "Read this persistent session file only when its full detail is needed.".into()
    },
  })
}

fn bounded_text_result(
  invocation: &ToolInvocation,
  content: String,
  options: &OutputOptions,
  ceiling: usize,
  format: &str,
  total_items: Option<usize>,
) -> ToolResult {
  let budget = options
    .max_inline_chars
    .unwrap_or(DEFAULT_INLINE_CHARS)
    .clamp(MIN_INLINE_CHARS, ceiling);
  let total_chars = content.chars().count();
  if total_chars <= budget {
    return ToolResult::Text(content);
  }

  let preview_chars = budget.saturating_sub(700).clamp(128, 2_000);
  let preview: String = content.chars().take(preview_chars).collect();
  let mode = options.overflow.unwrap_or_default();
  if matches!(mode, OverflowMode::Error) {
    return failure(format!(
      "The result contains {total_chars} characters, above maxInlineChars={budget}. \
       Request narrower filters, raise the budget (up to {ceiling}), or set overflow to file."
    ));
  }

  let artifact = if matches!(mode, OverflowMode::File) {
    let extension = if format == "json" { "json" } else { "txt" };
    match write_artifact(
      invocation,
      content.as_bytes(),
      extension,
      format,
      if format == "json" { "application/json" } else { "text/plain" },
    ) {
      Ok(artifact) => Some(artifact),
      Err(error) => return failure(error),
    }
  } else {
    None
  };

  ToolResult::Text(
    serde_json::to_string_pretty(&serde_json::json!({
      "summary": if artifact.is_some() {
        "The complete result was written to the resumable session's files directory."
      } else {
        "The result was truncated at the requested inline budget."
      },
      "preview": preview,
      "totalChars": total_chars,
      "inlineBudget": budget,
      "totalItems": total_items,
      "truncated": artifact.is_none(),
      "artifact": artifact,
    }))
    .unwrap_or_else(|_| preview),
  )
}

fn bounded_existing_result(
  invocation: &ToolInvocation,
  result: ToolResult,
  options: &OutputOptions,
) -> ToolResult {
  match result {
    ToolResult::Text(content) => bounded_text_result(
      invocation,
      content,
      options,
      STRUCTURED_INLINE_CEILING,
      "text",
      None,
    ),
    other => other,
  }
}

fn image_success(
  invocation: &ToolInvocation,
  summary: impl Into<String>,
  bytes: Vec<u8>,
  delivery: ImageDelivery,
) -> ToolResult {
  let artifact = match write_artifact(invocation, &bytes, "png", "png", "image/png") {
    Ok(artifact) => artifact,
    Err(error) => return failure(error),
  };
  let summary = summary.into();
  let content = serde_json::to_string_pretty(&serde_json::json!({
    "ok": true,
    "summary": summary,
    "delivery": delivery,
    "artifact": artifact,
  }))
  .unwrap_or(summary);
  ToolResult::Expanded(ToolResultExpanded {
    text_result_for_llm: content,
    result_type: "success".to_string(),
    binary_results_for_llm: matches!(delivery, ImageDelivery::Inline).then(|| {
      vec![ToolBinaryResult {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type: "image/png".to_string(),
        r#type: "image".to_string(),
        description: Some("Live deployed app preview".to_string()),
      }]
    }),
    session_log: None,
    error: None,
    tool_telemetry: None,
  })
}

/// A failure tool result carrying a message the agent can act on.
fn failure(message: impl Into<String>) -> ToolResult {
  let mut message = message.into();
  let count = message.chars().count();
  if count > STRUCTURED_INLINE_CEILING {
    message = format!(
      "{}\n... error truncated ({} more characters) ...",
      message.chars().take(STRUCTURED_INLINE_CEILING).collect::<String>(),
      count - STRUCTURED_INLINE_CEILING
    );
  }
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
context_tool!(PreviewEvaluateTool);
context_tool!(PreviewCdpTool);

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
      "liveDebugSurface": preview::project_agent_target(&project).map(|target| target.surface_url),
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

    if let Err(error) = self.0.ensure_live_preview().await {
      return Ok(failure(format!(
        "Deployment succeeded, but the live preview could not open: {error}"
      )));
    }

    Ok(ToolResult::Text(safe_json(&result)))
  }
}

#[derive(Default, Deserialize)]
struct NavigateParams {
  #[serde(default, alias = "url", alias = "path")]
  target: Option<String>,
  #[serde(default)]
  screenshot: Option<bool>,
}

#[async_trait]
impl ToolHandler for PreviewNavigateTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: NavigateParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    let preview_target = match self.0.ensure_live_preview().await {
      Ok(target) => target,
      Err(error) => return Ok(failure(error)),
    };
    let target = match resolve_target(&preview_target.app_url, params.target.as_deref()) {
      Ok(url) => url,
      Err(error) => return Ok(failure(error)),
    };
    let navigation = match preview_target.frame_origin.as_deref() {
      Some(frame_origin) => {
        preview::navigate_embedded_frame(
          &self.0.app,
          frame_origin,
          &target,
          &preview_target.app_url,
          Duration::from_secs(20),
        )
        .await
      }
      None => {
        preview::navigate_and_wait(
          &self.0.app,
          &self.0.project_id,
          &target,
          Duration::from_secs(20),
        )
        .await
      }
    };
    if let Err(error) = navigation {
      return Ok(failure(error.to_string()));
    }
    if !params.screenshot.unwrap_or(false) {
      return Ok(ToolResult::Text(format!("Navigated the live app to {target}.")));
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    match preview::agent_capture_target(&self.0.app, preview_target.frame_origin.as_deref()).await {
      Ok(bytes) => Ok(image_success(
        &invocation,
        format!("Navigated the live app to {target}."),
        bytes,
        ImageDelivery::Inline,
      )),
      Err(error) => Ok(failure(format!(
        "The page loaded at {target}, but its requested screenshot failed: {error}"
      ))),
    }
  }
}

#[derive(Default, Deserialize)]
struct ScreenshotParams {
  #[serde(default)]
  delivery: Option<ImageDelivery>,
}

#[async_trait]
impl ToolHandler for PreviewScreenshotTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: ScreenshotParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    let target = match self.0.ensure_live_preview().await {
      Ok(target) => target,
      Err(error) => return Ok(failure(error)),
    };
    match preview::agent_capture_target(&self.0.app, target.frame_origin.as_deref()).await {
      Ok(bytes) => Ok(image_success(
        &invocation,
        "Captured the current live deployed page.",
        bytes,
        params.delivery.unwrap_or_default(),
      )),
      Err(error) => Ok(failure(error.to_string())),
    }
  }
}

#[derive(Default, Deserialize)]
struct ConsoleParams {
  #[serde(default)]
  level: Option<String>,
  #[serde(default)]
  query: Option<String>,
  #[serde(default)]
  since: Option<u64>,
  #[serde(default)]
  limit: Option<usize>,
  #[serde(default)]
  clear: Option<bool>,
  #[serde(flatten)]
  output: OutputOptions,
}

#[async_trait]
impl ToolHandler for PreviewConsoleTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: ConsoleParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    let target = match self.0.ensure_live_preview().await {
      Ok(target) => target,
      Err(error) => return Ok(failure(error)),
    };
    let entries = match preview::read_console(
      &self.0.app,
      target.frame_origin.as_deref(),
      params.level.as_deref(),
      params.query.as_deref(),
      params.since,
      params.limit.unwrap_or(50),
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
    let total_items = entries.as_array().map(Vec::len);
    Ok(bounded_text_result(
      &invocation,
      safe_json(&entries),
      &params.output,
      STRUCTURED_INLINE_CEILING,
      "json",
      total_items,
    ))
  }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkParams {
  #[serde(default)]
  errors_only: Option<bool>,
  #[serde(default)]
  query: Option<String>,
  #[serde(default)]
  url_includes: Option<String>,
  #[serde(default)]
  method: Option<String>,
  #[serde(default)]
  resource_type: Option<String>,
  #[serde(default)]
  status_min: Option<u16>,
  #[serde(default)]
  status_max: Option<u16>,
  #[serde(default)]
  since: Option<u64>,
  #[serde(default)]
  limit: Option<usize>,
  #[serde(default)]
  clear: Option<bool>,
  #[serde(flatten)]
  output: OutputOptions,
}

#[async_trait]
impl ToolHandler for PreviewNetworkTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: NetworkParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    let target = match self.0.ensure_live_preview().await {
      Ok(target) => target,
      Err(error) => return Ok(failure(error)),
    };
    let entries = match preview::read_network(
      &self.0.app,
      target.frame_origin.as_deref(),
      params.errors_only.unwrap_or(false),
      params.query.as_deref(),
      params.url_includes.as_deref(),
      params.method.as_deref(),
      params.resource_type.as_deref(),
      params.status_min,
      params.status_max,
      params.since,
      params.limit.unwrap_or(50),
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
    let total_items = entries.as_array().map(Vec::len);
    Ok(bounded_text_result(
      &invocation,
      safe_json(&entries),
      &params.output,
      STRUCTURED_INLINE_CEILING,
      "json",
      total_items,
    ))
  }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectParams {
  #[serde(default)]
  selector: Option<String>,
  #[serde(default)]
  query: Option<String>,
  #[serde(default)]
  limit: Option<usize>,
  #[serde(default)]
  include_body_text: Option<bool>,
  #[serde(flatten)]
  output: OutputOptions,
}

#[async_trait]
impl ToolHandler for PreviewInspectTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: InspectParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    let target = match self.0.ensure_live_preview().await {
      Ok(target) => target,
      Err(error) => return Ok(failure(error)),
    };
    match preview::inspect_page(
      &self.0.app,
      target.frame_origin.as_deref(),
      params.selector.as_deref(),
      params.query.as_deref(),
      params.limit.unwrap_or(100),
      params.include_body_text.unwrap_or(true),
    )
    .await
    {
      Ok(snapshot) => {
        let total_items = snapshot
          .get("elements")
          .and_then(serde_json::Value::as_array)
          .map(Vec::len);
        Ok(bounded_text_result(
          &invocation,
          safe_json(&snapshot),
          &params.output,
          STRUCTURED_INLINE_CEILING,
          "json",
          total_items,
        ))
      }
      Err(error) => Ok(failure(error.to_string())),
    }
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InteractParams {
  action: String,
  #[serde(default)]
  selector: Option<String>,
  #[serde(default)]
  value: Option<serde_json::Value>,
  #[serde(default)]
  screenshot: Option<bool>,
}

#[async_trait]
impl ToolHandler for PreviewInteractTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: InteractParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    let target = match self.0.ensure_live_preview().await {
      Ok(target) => target,
      Err(error) => return Ok(failure(error)),
    };
    let result = match preview::interact(
      &self.0.app,
      target.frame_origin.as_deref(),
      params.action.trim(),
      params.selector.as_deref(),
      params.value,
      &target.app_url,
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
    let remained_in_app = match target.frame_origin.as_deref() {
      Some(frame_origin) => {
        preview::embedded_frame_matches(&self.0.app, frame_origin, &target.app_url).await
      }
      None => preview::agent_target_matches(&self.0.app, &self.0.project_id, &target),
    };
    if !remained_in_app {
      let _ = preview::navigate_and_wait(
        &self.0.app,
        &self.0.project_id,
        &target.surface_url,
        Duration::from_secs(15),
      )
      .await;
      return Ok(failure(
        "The interaction navigated outside the deployed app, so Fabricator returned to the app root.",
      ));
    }
    let text = safe_json(&result);
    if !params.screenshot.unwrap_or(false) {
      return Ok(ToolResult::Text(text));
    }
    match preview::agent_capture_target(&self.0.app, target.frame_origin.as_deref()).await {
      Ok(bytes) => Ok(image_success(
        &invocation,
        text,
        bytes,
        ImageDelivery::Inline,
      )),
      Err(_) => Ok(ToolResult::Text(text)),
    }
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvaluateParams {
  expression: String,
  #[serde(default)]
  await_promise: Option<bool>,
  #[serde(default)]
  return_by_value: Option<bool>,
  #[serde(default)]
  timeout_ms: Option<u64>,
  #[serde(flatten)]
  output: OutputOptions,
}

#[async_trait]
impl ToolHandler for PreviewEvaluateTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: EvaluateParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    let expression = params.expression.trim();
    if expression.is_empty() {
      return Ok(failure("JavaScript `expression` cannot be empty."));
    }
    let target = match self.0.ensure_live_preview().await {
      Ok(target) => target,
      Err(error) => return Ok(failure(error)),
    };
    let timeout_ms = params.timeout_ms.unwrap_or(10_000).clamp(250, 30_000);
    match preview::evaluate_page(
      &self.0.app,
      target.frame_origin.as_deref(),
      expression,
      params.await_promise.unwrap_or(true),
      params.return_by_value.unwrap_or(true),
      Duration::from_millis(timeout_ms),
    )
    .await
    {
      Ok(result) => Ok(bounded_text_result(
        &invocation,
        raw_json(&result),
        &params.output,
        RAW_INLINE_CEILING,
        "json",
        None,
      )),
      Err(error) => Ok(failure(error.to_string())),
    }
  }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CdpParams {
  method: String,
  #[serde(default)]
  params: Option<serde_json::Value>,
  #[serde(default)]
  timeout_ms: Option<u64>,
  #[serde(flatten)]
  output: OutputOptions,
}

#[async_trait]
impl ToolHandler for PreviewCdpTool {
  async fn call(&self, invocation: ToolInvocation) -> Result<ToolResult, SdkError> {
    let params: CdpParams = match invocation.params() {
      Ok(params) => params,
      Err(error) => return Ok(failure(format!("Invalid arguments: {error}"))),
    };
    let method = params.method.trim();
    if method.is_empty() {
      return Ok(failure("CDP `method` cannot be empty."));
    }
    let cdp_params = params.params.unwrap_or_else(|| serde_json::json!({}));
    if !cdp_params.is_object() {
      return Ok(failure("CDP `params` must be a JSON object."));
    }
    let target = match self.0.ensure_live_preview().await {
      Ok(target) => target,
      Err(error) => return Ok(failure(error)),
    };
    let timeout_ms = params.timeout_ms.unwrap_or(10_000).clamp(250, 30_000);
    match preview::call_cdp_target(
      &self.0.app,
      target.frame_origin.as_deref(),
      method,
      &cdp_params,
      Duration::from_millis(timeout_ms),
    )
    .await
    {
      Ok(result) => Ok(bounded_text_result(
        &invocation,
        raw_json(&result),
        &params.output,
        RAW_INLINE_CEILING,
        "json",
        None,
      )),
      Err(error) => Ok(failure(error.to_string())),
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
  #[serde(flatten)]
  output: OutputOptions,
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
    Ok(bounded_existing_result(
      &invocation,
      render_semantic_model_result(&result),
      &params.output,
    ))
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
  #[serde(flatten)]
  output: OutputOptions,
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
    Ok(bounded_existing_result(
      &invocation,
      render_semantic_model_result(&result),
      &params.output,
    ))
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
  use github_copilot_sdk::types::ToolInvocation;
  use serde_json::json;

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

  fn invocation(session_id: &str, tool_name: &str) -> ToolInvocation {
    serde_json::from_value(json!({
      "sessionId": session_id,
      "toolCallId": uuid::Uuid::new_v4().to_string(),
      "toolName": tool_name,
      "arguments": {},
    }))
    .unwrap()
  }

  #[test]
  fn catalog_has_unique_tools_in_expected_groups() {
    let groups = tool_catalog();
    assert_eq!(
      groups.iter().map(|group| group.id.as_str()).collect::<Vec<_>>(),
      vec!["deployment", "diagnostics", "page-control", "advanced-browser", "fabric-data"]
    );
    let ids: Vec<&str> = groups
      .iter()
      .flat_map(|group| group.tools.iter().map(|tool| tool.id.as_str()))
      .collect();
    let unique: HashSet<&str> = ids.iter().copied().collect();
    assert_eq!(ids.len(), 12);
    assert_eq!(unique.len(), ids.len());
  }

  #[test]
  fn large_results_can_truncate_without_writing_a_file() {
    let inv = invocation("truncate-test", "fabricator_preview_console");
    let options = OutputOptions {
      max_inline_chars: Some(256),
      overflow: Some(OverflowMode::Truncate),
    };
    let result = bounded_text_result(&inv, "x".repeat(2_000), &options, 16_000, "json", Some(20));
    let rendered = text_of(&result);
    let envelope: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    assert_eq!(envelope["truncated"], true);
    assert!(envelope["artifact"].is_null());
    assert_eq!(envelope["totalChars"], 2_000);
    assert_eq!(envelope["totalItems"], 20);
  }

  #[test]
  fn large_results_spill_to_the_owning_session_files() {
    let session_id = format!("fabricator-output-test-{}", uuid::Uuid::new_v4());
    let inv = invocation(&session_id, "fabricator_preview_cdp");
    let options = OutputOptions {
      max_inline_chars: Some(256),
      overflow: Some(OverflowMode::File),
    };
    let full = json!({"nodes": vec!["large-value"; 200]});
    let content = serde_json::to_string_pretty(&full).unwrap();
    let result = bounded_text_result(&inv, content.clone(), &options, 64_000, "json", None);
    let envelope: serde_json::Value = serde_json::from_str(&text_of(&result)).unwrap();
    let path = PathBuf::from(envelope["artifact"]["path"].as_str().unwrap());
    assert!(path.exists(), "expected artifact at {}", path.display());
    assert_eq!(fs::read_to_string(&path).unwrap(), content);
    assert!(envelope["artifact"]["sessionPath"]
      .as_str()
      .unwrap()
      .starts_with("files/fabricator-diagnostics/"));
    let session_root = paths::home_dir()
      .join(".copilot")
      .join("session-state")
      .join(session_id);
    fs::remove_dir_all(session_root).unwrap();
  }
}
