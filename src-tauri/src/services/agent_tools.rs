//! In-process Copilot tools that let the agent find and wire the Power BI /
//! Fabric semantic model behind a report, app, or dataset.
//!
//! Registered on every chat session via
//! [`SessionConfig::with_tools`](github_copilot_sdk::SessionConfig::with_tools)
//! (see [`crate::services::copilot`]). Each handler runs inside the Tauri host
//! process. Validation no longer happens through deploy + screenshot: the agent
//! renders Graphein specs headlessly against live data (`npm run preview`) and
//! Fabricator auto-deploys after the turn — so there are no preview-browser tools.
//!
//! These tools exist **only** in Fabricator-driven sessions — they are never part
//! of the project on disk, so a plain `copilot` CLI run sees none of them.

use std::sync::Arc;

use async_trait::async_trait;
use github_copilot_sdk::tool::ToolHandler;
use github_copilot_sdk::types::{ToolInvocation, ToolResultExpanded};
use github_copilot_sdk::{Error as SdkError, Tool, ToolResult};
use serde::Deserialize;
use tauri::AppHandle;

use crate::services::semantic_model;

/// Build the Fabricator in-process tool set for one project's chat session.
pub fn fabricator_tools(_app: AppHandle, _project_id: String) -> Vec<Tool> {
  vec![
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

/// A failure tool result carrying a message the agent can act on.
fn failure(message: impl Into<String>) -> ToolResult {
  let message = message.into();
  // `ToolResultExpanded` is `#[non_exhaustive]` in the SDK; build it via the
  // `new(...).with_*` chain rather than a struct literal.
  ToolResult::Expanded(ToolResultExpanded::new(message.clone(), "failure").with_error(message))
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
}
