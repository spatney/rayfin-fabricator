//! Fabric account helpers — enumerate the signed-in user's workspaces (with
//! capacity SKUs) and delete the Fabric items behind a project's deployments.
//! Faithful port of `src/main/services/fabric.ts`.
//!
//! There is no `rayfin workspace list` command, so we call the Fabric REST API
//! (`/workspaces` + `/capacities`) ourselves. The bearer token is acquired
//! *silently* by reusing the Rayfin CLI's own MSAL token cache: we spawn a tiny
//! Node helper that imports the globally-installed `@microsoft/rayfin-cli` auth
//! module, runs its silent-only token path, performs the fetches, and emits only
//! the resulting JSON. The access token never leaves that short-lived child
//! process. We keep this as a `node` helper (rather than a pure-Rust port)
//! because the CLI's auth stack relies on native modules — msal-node-extensions
//! / DPAPI / keytar — that own the encrypted token cache; reimplementing that in
//! Rust is neither practical nor safe. All orchestration around it is Rust.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::services::{exec, paths, store};
use crate::services::exec::RunOptions;
use crate::types::{FabricDeleteResult, FabricWorkspacesResult};
use crate::types::{FabricCapacitiesResult, FabricCreateWorkspaceResult};
use crate::types::{FabricShareResult, SemanticModelRef};
use crate::types::FabricDirectoryResult;

const FABRIC_API_BASE: &str = "https://api.fabric.microsoft.com/v1";

/// `ok:false` parse-failure paths classify the error as a login problem with
/// the same heuristic the TS used (note: no `interactive` here, matching
/// `listFabricWorkspaces`/`deleteFabricApps`).
static NEEDS_LOGIN_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)silent|cached|account|login|token|sign").unwrap());

/// Helper executed by the system `node`. argv: <authModulePath> <apiBase>.
/// Writes exactly one JSON line to stdout; library logging is routed to stderr.
const HELPER_SOURCE: &str = r#"// Keep stdout clean for the JSON result; route any library logging to stderr.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.debug = console.log
console.info = console.log

import { pathToFileURL } from 'node:url'

const API_HOST = 'https://api.fabric.microsoft.com'

// Fabric list endpoints page at 100 items each, returning a continuationUri /
// continuationToken when more remain. Follow every page so the result is
// complete — otherwise workspaces (or capacities) past the first page silently
// vanish from the picker. tolerate: degrade to what we have instead of throwing.
async function fetchAllPages(startUrl, headers, { tolerate = false, label = '' } = {}) {
  const out = []
  const seen = new Set()
  let url = startUrl
  for (let i = 0; i < 100 && url; i++) {
    if (seen.has(url)) break
    seen.add(url)
    let res
    try {
      res = await fetch(url, { headers })
    } catch (e) {
      if (tolerate) break
      throw e
    }
    if (!res.ok) {
      if (tolerate) break
      throw new Error('Fabric ' + (label || startUrl) + ' request failed (' + res.status + ')')
    }
    const json = await res.json()
    for (const v of json.value || []) out.push(v)
    if (json.continuationUri) {
      url = json.continuationUri.startsWith('http') ? json.continuationUri : API_HOST + json.continuationUri
    } else if (json.continuationToken) {
      url = startUrl + (startUrl.includes('?') ? '&' : '?') + '$continuationToken=' + encodeURIComponent(json.continuationToken)
    } else {
      url = null
    }
  }
  return out
}

async function main() {
  const [authPath, base] = process.argv.slice(2)
  const auth = await import(pathToFileURL(authPath).href)
  const rf = await auth.getRayfinAuth()
  // silentOnly: never pop a browser — fail fast if there's no cached session.
  const { token } = await rf.acquireToken(undefined, { silentOnly: true })
  const headers = { Authorization: 'Bearer ' + token }

  // Follow pagination (100/page) so no workspace past the first page is lost.
  const wsValue = await fetchAllPages(base + '/workspaces', headers, { label: '/workspaces' })

  // Capacities give us the SKU (F-SKU detection); tolerate failure (some
  // tenants restrict the endpoint) by degrading to workspaces without SKUs.
  // Paginate too — a capacity past page 1 would otherwise leave its workspace
  // SKU-less and wrongly ineligible.
  const caps = await fetchAllPages(base + '/capacities', headers, { tolerate: true, label: '/capacities' })
  // Index by lower-cased id — /workspaces and /capacities can disagree on GUID casing.
  const capById = new Map(caps.map((c) => [String(c.id).toLowerCase(), c]))

  const kindOf = (sku) => {
    const s = String(sku).toUpperCase()
    if (s.startsWith('F')) return 'fabric'
    // PPU (Premium Per User, SKU PP1/PP2/PP3) can't host Fabric items — a deploy
    // there 403s. Only dedicated Premium P-SKUs (P1/P2/P3) qualify, so exclude PP*.
    if (s.startsWith('PP')) return 'other'
    if (s.startsWith('P')) return 'premium'
    return 'other'
  }

  const workspaces = wsValue.map((w) => {
    const cap = w.capacityId ? capById.get(String(w.capacityId).toLowerCase()) : undefined
    const sku = cap && cap.sku ? String(cap.sku) : undefined
    // The SKU only resolves for capacities the signed-in user *administers*.
    // /capacities omits capacities the user merely has member access to, so a
    // workspace on someone else's F/P capacity comes back SKU-less. It still has
    // a capacityId, so classify it 'unknown' (eligible — the deploy validates)
    // rather than wrongly blocking it. 'none' = genuinely no dedicated capacity.
    const capacityKind = sku ? kindOf(sku) : w.capacityId ? 'unknown' : 'none'
    return {
      id: w.id,
      displayName: w.displayName,
      type: w.type,
      capacityId: w.capacityId,
      region: w.capacityRegion || (cap && cap.region) || undefined,
      sku,
      capacityName: cap && cap.displayName ? cap.displayName : undefined,
      capacityKind,
      // Fabric (F) / Premium (P) capacities can host a Rayfin app; 'unknown'
      // (capacity present but its SKU isn't visible to this user) is allowed too.
      eligible: capacityKind === 'fabric' || capacityKind === 'premium' || capacityKind === 'unknown'
    }
  })
  process.stdout.write(JSON.stringify({ ok: true, workspaces }))
}

main().catch((err) => {
  const msg = err && err.message ? String(err.message) : String(err)
  const needsLogin = /silent|cached|account|login|token|interactive|sign/i.test(msg)
  process.stdout.write(JSON.stringify({ ok: false, needsLogin, error: msg }))
})
"#;

/// Helper executed by the system `node` to delete Fabric items. argv:
/// <authModulePath> <apiBase> <itemsJsonPath>, where the JSON file is an array
/// of `{ workspaceId, itemId, name }`.
const DELETE_HELPER_SOURCE: &str = r#"console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.debug = console.log
console.info = console.log

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

async function main() {
  const [authPath, base, itemsPath] = process.argv.slice(2)
  const items = JSON.parse(readFileSync(itemsPath, 'utf8'))
  const auth = await import(pathToFileURL(authPath).href)
  const rf = await auth.getRayfinAuth()
  // silentOnly: never pop a browser — fail fast if there's no cached session.
  const { token } = await rf.acquireToken(undefined, { silentOnly: true })
  const headers = { Authorization: 'Bearer ' + token }

  let deleted = 0
  const failures = []
  for (const it of items) {
    const label = it.name || it.itemId
    try {
      const url = base + '/workspaces/' + it.workspaceId + '/items/' + it.itemId
      const res = await fetch(url, { method: 'DELETE', headers })
      if (res.status === 404) continue // already gone — nothing to do
      if (res.ok) { deleted++; continue }
      const body = await res.text().catch(() => '')
      failures.push({ name: label, error: 'Fabric returned ' + res.status + (body ? ': ' + body.slice(0, 200) : '') })
    } catch (e) {
      failures.push({ name: label, error: String((e && e.message) || e) })
    }
  }
  process.stdout.write(JSON.stringify({ ok: failures.length === 0, deleted, failures }))
}

main().catch((err) => {
  const msg = err && err.message ? String(err.message) : String(err)
  const needsLogin = /silent|cached|account|login|token|interactive|sign/i.test(msg)
  process.stdout.write(JSON.stringify({ ok: false, deleted: 0, failures: [], needsLogin, error: msg }))
})
"#;

/// Helper executed by the system `node` to list dedicated capacities the user
/// can create a workspace on. argv: <authModulePath> <apiBase>.
const CAPACITIES_HELPER_SOURCE: &str = r#"console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.debug = console.log
console.info = console.log

import { pathToFileURL } from 'node:url'

const API_HOST = 'https://api.fabric.microsoft.com'

async function fetchAllPages(startUrl, headers, { tolerate = false } = {}) {
  const out = []
  const seen = new Set()
  let url = startUrl
  for (let i = 0; i < 100 && url; i++) {
    if (seen.has(url)) break
    seen.add(url)
    let res
    try { res = await fetch(url, { headers }) } catch (e) { if (tolerate) break; throw e }
    if (!res.ok) { if (tolerate) break; throw new Error('Fabric request failed (' + res.status + ')') }
    const json = await res.json()
    for (const v of json.value || []) out.push(v)
    if (json.continuationUri) url = json.continuationUri.startsWith('http') ? json.continuationUri : API_HOST + json.continuationUri
    else if (json.continuationToken) url = startUrl + (startUrl.includes('?') ? '&' : '?') + '$continuationToken=' + encodeURIComponent(json.continuationToken)
    else url = null
  }
  return out
}

async function main() {
  const [authPath, base] = process.argv.slice(2)
  const auth = await import(pathToFileURL(authPath).href)
  const rf = await auth.getRayfinAuth()
  const { token } = await rf.acquireToken(undefined, { silentOnly: true })
  const headers = { Authorization: 'Bearer ' + token }
  const caps = await fetchAllPages(base + '/capacities', headers, {})
  const kindOf = (sku) => {
    const s = String(sku).toUpperCase()
    if (s.startsWith('F')) return 'fabric'
    if (s.startsWith('PP')) return 'other' // PPU can't host Fabric items
    if (s.startsWith('P')) return 'premium'
    return 'other'
  }
  const capacities = caps
    .map((c) => {
      const kind = c.sku ? kindOf(c.sku) : 'other'
      return {
        id: c.id, displayName: c.displayName, sku: c.sku || undefined,
        region: c.region || undefined, kind,
        eligible: (kind === 'fabric' || kind === 'premium') && (!c.state || c.state === 'Active')
      }
    })
    .filter((c) => c.eligible)
  process.stdout.write(JSON.stringify({ ok: true, capacities }))
}

main().catch((err) => {
  const msg = err && err.message ? String(err.message) : String(err)
  const needsLogin = /silent|cached|account|login|token|interactive|sign/i.test(msg)
  process.stdout.write(JSON.stringify({ ok: false, needsLogin, error: msg }))
})
"#;

/// Helper executed by the system `node` to create + assign a workspace. argv:
/// <authModulePath> <apiBase> <displayName> <capacityId>.
const CREATE_WS_HELPER_SOURCE: &str = r#"console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.debug = console.log
console.info = console.log

import { pathToFileURL } from 'node:url'

async function main() {
  const [authPath, base, name, capacityId] = process.argv.slice(2)
  const auth = await import(pathToFileURL(authPath).href)
  const rf = await auth.getRayfinAuth()
  const { token } = await rf.acquireToken(undefined, { silentOnly: true })
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  const body = { displayName: name }
  if (capacityId) body.capacityId = capacityId
  const res = await fetch(base + '/workspaces', { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error('Fabric create workspace failed (' + res.status + ')' + (text ? ': ' + text.slice(0, 200) : ''))
  }
  const ws = await res.json()
  process.stdout.write(JSON.stringify({ ok: true, workspaceId: ws.id }))
}

main().catch((err) => {
  const msg = err && err.message ? String(err.message) : String(err)
  const needsLogin = /silent|cached|account|login|token|interactive|sign/i.test(msg)
  process.stdout.write(JSON.stringify({ ok: false, needsLogin, error: msg }))
})
"#;

/// One item passed to the delete helper (serialized to the items JSON file).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteItem {
  workspace_id: String,
  item_id: String,
  name: String,
}

/// Write a helper script to the app data dir and return its path.
fn write_helper(name: &str, source: &str) -> std::io::Result<PathBuf> {
  let dir = paths::ensure_data_dir()?;
  let path = dir.join(name);
  std::fs::write(&path, source)?;
  Ok(path)
}

/// Classify a parse-failure error string as a login problem, falling back to a
/// generic message built from stderr/stdout/exit code.
fn failure_error(res: &exec::RunResult, out: &str) -> (bool, String) {
  let err = if !res.stderr.trim().is_empty() {
    res.stderr.trim().to_string()
  } else if !out.is_empty() {
    out.to_string()
  } else {
    let code = res
      .exit_code
      .map(|c| c.to_string())
      .unwrap_or_else(|| "unknown".to_string());
    format!("Workspace lookup failed (exit {code}).")
  };
  let needs_login = NEEDS_LOGIN_RE.is_match(&err);
  (needs_login, err)
}

/// Resolve the active project's local CLI auth module, restoring dependencies
/// first when a clone or manually opened project has no node_modules yet.
async fn project_auth_module(project_dir: Option<&Path>) -> Result<PathBuf, String> {
  if let Some(dir) = project_dir {
    exec::ensure_project_dependencies(dir, None)
      .await
      .map_err(|error| format!("Could not install this project's dependencies: {error}"))?;
  }
  exec::project_rayfin_auth_module(project_dir).ok_or_else(|| {
    "Could not locate the Rayfin CLI. Open a Rayfin project to reach Fabric.".to_string()
  })
}

/// List the signed-in user's Fabric workspaces, each annotated with its
/// capacity SKU and whether that capacity is eligible to host a Rayfin app.
#[tauri::command]
pub async fn fabric_workspaces() -> FabricWorkspacesResult {
  let project_dir = store::active_project().map(|p| PathBuf::from(p.path));
  let auth_path = match project_auth_module(project_dir.as_deref()).await {
    Ok(p) => p,
    Err(error) => {
      return FabricWorkspacesResult {
        ok: false,
        workspaces: None,
        needs_login: None,
        error: Some(error),
      }
    }
  };

  let script_path = match write_helper("fabric-workspaces.mjs", HELPER_SOURCE) {
    Ok(p) => p,
    Err(err) => {
      return FabricWorkspacesResult {
        ok: false,
        workspaces: None,
        needs_login: None,
        error: Some(format!("Could not prepare the workspace lookup helper: {err}")),
      }
    }
  };

  let auth_str = auth_path.to_string_lossy().to_string();
  let script_str = script_path.to_string_lossy().to_string();
  let res = exec::run(
    "node",
    &[&script_str, &auth_str, FABRIC_API_BASE],
    RunOptions::timeout(60_000),
  )
  .await;

  if res.not_found {
    return FabricWorkspacesResult {
      ok: false,
      workspaces: None,
      needs_login: None,
      error: Some("Node.js was not found on PATH.".to_string()),
    };
  }

  let out = res.stdout.trim();
  match serde_json::from_str::<FabricWorkspacesResult>(out) {
    Ok(mut parsed) => {
      if parsed.ok {
        if let Some(ws) = parsed.workspaces.as_mut() {
          // Eligible (Fabric / Premium) workspaces first, then alphabetically.
          ws.sort_by(|a, b| {
            if a.eligible != b.eligible {
              if a.eligible {
                Ordering::Less
              } else {
                Ordering::Greater
              }
            } else {
              a.display_name
                .to_lowercase()
                .cmp(&b.display_name.to_lowercase())
            }
          });
        }
      }
      parsed
    }
    Err(_) => {
      let (needs_login, err) = failure_error(&res, out);
      FabricWorkspacesResult {
        ok: false,
        workspaces: None,
        needs_login: Some(needs_login),
        error: Some(err),
      }
    }
  }
}

/// List dedicated capacities the signed-in user can create a workspace on
/// (eligible F-SKU / P-SKU only; PPU and non-Active excluded).
#[tauri::command]
pub async fn fabric_capacities() -> FabricCapacitiesResult {
  let project_dir = store::active_project().map(|p| PathBuf::from(p.path));
  let auth_path = match project_auth_module(project_dir.as_deref()).await {
    Ok(p) => p,
    Err(error) => {
      return FabricCapacitiesResult {
        ok: false,
        capacities: None,
        needs_login: None,
        error: Some(error),
      }
    }
  };
  let script_path = match write_helper("fabric-capacities.mjs", CAPACITIES_HELPER_SOURCE) {
    Ok(p) => p,
    Err(err) => {
      return FabricCapacitiesResult {
        ok: false,
        capacities: None,
        needs_login: None,
        error: Some(format!("Could not prepare the capacities lookup helper: {err}")),
      }
    }
  };
  let auth_str = auth_path.to_string_lossy().to_string();
  let script_str = script_path.to_string_lossy().to_string();
  let res = exec::run(
    "node",
    &[&script_str, &auth_str, FABRIC_API_BASE],
    RunOptions::timeout(60_000),
  )
  .await;
  if res.not_found {
    return FabricCapacitiesResult {
      ok: false,
      capacities: None,
      needs_login: None,
      error: Some("Node.js was not found on PATH.".to_string()),
    };
  }
  let out = res.stdout.trim();
  match serde_json::from_str::<FabricCapacitiesResult>(out) {
    Ok(parsed) => parsed,
    Err(_) => {
      let (needs_login, err) = failure_error(&res, out);
      FabricCapacitiesResult {
        ok: false,
        capacities: None,
        needs_login: Some(needs_login),
        error: Some(err),
      }
    }
  }
}

/// Create a new Fabric workspace and assign it to `capacity_id`. The region is
/// inherited from the capacity. Returns the new workspace id on success.
#[tauri::command]
pub async fn fabric_create_workspace(name: String, capacity_id: String) -> FabricCreateWorkspaceResult {
  let project_dir = store::active_project().map(|p| PathBuf::from(p.path));
  let auth_path = match project_auth_module(project_dir.as_deref()).await {
    Ok(p) => p,
    Err(error) => {
      return FabricCreateWorkspaceResult {
        ok: false,
        workspace_id: None,
        needs_login: None,
        error: Some(error),
      }
    }
  };
  let script_path = match write_helper("fabric-create-ws.mjs", CREATE_WS_HELPER_SOURCE) {
    Ok(p) => p,
    Err(err) => {
      return FabricCreateWorkspaceResult {
        ok: false,
        workspace_id: None,
        needs_login: None,
        error: Some(format!("Could not prepare the create-workspace helper: {err}")),
      }
    }
  };
  let auth_str = auth_path.to_string_lossy().to_string();
  let script_str = script_path.to_string_lossy().to_string();
  let res = exec::run(
    "node",
    &[&script_str, &auth_str, FABRIC_API_BASE, &name, &capacity_id],
    RunOptions::timeout(60_000),
  )
  .await;
  if res.not_found {
    return FabricCreateWorkspaceResult {
      ok: false,
      workspace_id: None,
      needs_login: None,
      error: Some("Node.js was not found on PATH.".to_string()),
    };
  }
  let out = res.stdout.trim();
  match serde_json::from_str::<FabricCreateWorkspaceResult>(out) {
    Ok(parsed) => parsed,
    Err(_) => {
      let (needs_login, err) = failure_error(&res, out);
      FabricCreateWorkspaceResult {
        ok: false,
        workspace_id: None,
        needs_login: Some(needs_login),
        error: Some(err),
      }
    }
  }
}

/// Delete the Fabric items behind a project's recorded deployments. Enumerates
/// the deployments (`rayfin up list --json`) for their workspace/item ids, then
/// deletes each via the Fabric REST API. Must be called *before* the project
/// folder is removed. Never throws — returns a structured summary.
#[tauri::command]
pub async fn fabric_delete_apps(project_id: String) -> FabricDeleteResult {
  if store::find_project(&project_id).is_none() {
    return FabricDeleteResult {
      ok: false,
      deleted: 0,
      failures: vec![],
      needs_login: None,
      error: Some("Project not found.".to_string()),
    };
  }

  let deployments = crate::commands::deploy::deploy_list(project_id.clone()).await;
  let items: Vec<DeleteItem> = deployments
    .iter()
    .filter_map(|d| match (&d.workspace_id, &d.item_id) {
      (Some(workspace_id), Some(item_id)) => Some(DeleteItem {
        workspace_id: workspace_id.clone(),
        item_id: item_id.clone(),
        name: d.name.clone().unwrap_or_else(|| d.workspace_name.clone()),
      }),
      _ => None,
    })
    .collect();

  // Nothing recorded in Fabric (never deployed, or list unavailable) — no-op.
  if items.is_empty() {
    return FabricDeleteResult {
      ok: true,
      deleted: 0,
      failures: vec![],
      needs_login: None,
      error: None,
    };
  }

  let project_dir = store::find_project(&project_id).map(|p| PathBuf::from(p.path));
  let auth_path = match project_auth_module(project_dir.as_deref()).await {
    Ok(p) => p,
    Err(error) => {
      return FabricDeleteResult {
        ok: false,
        deleted: 0,
        failures: vec![],
        needs_login: None,
        error: Some(error),
      }
    }
  };

  let prep = (|| -> std::io::Result<(PathBuf, PathBuf)> {
    let script_path = write_helper("fabric-delete.mjs", DELETE_HELPER_SOURCE)?;
    let items_path = paths::ensure_data_dir()?.join("fabric-delete-items.json");
    let json = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());
    std::fs::write(&items_path, json)?;
    Ok((script_path, items_path))
  })();
  let (script_path, items_path) = match prep {
    Ok(p) => p,
    Err(err) => {
      return FabricDeleteResult {
        ok: false,
        deleted: 0,
        failures: vec![],
        needs_login: None,
        error: Some(format!("Could not prepare the delete helper: {err}")),
      }
    }
  };

  let auth_str = auth_path.to_string_lossy().to_string();
  let script_str = script_path.to_string_lossy().to_string();
  let items_str = items_path.to_string_lossy().to_string();
  let res = exec::run(
    "node",
    &[&script_str, &auth_str, FABRIC_API_BASE, &items_str],
    RunOptions::timeout(120_000),
  )
  .await;

  if res.not_found {
    return FabricDeleteResult {
      ok: false,
      deleted: 0,
      failures: vec![],
      needs_login: None,
      error: Some("Node.js was not found on PATH.".to_string()),
    };
  }

  let out = res.stdout.trim();
  match serde_json::from_str::<FabricDeleteResult>(out) {
    Ok(parsed) => parsed,
    Err(_) => {
      let (needs_login, err) = failure_error(&res, out);
      FabricDeleteResult {
        ok: false,
        deleted: 0,
        failures: vec![],
        needs_login: Some(needs_login),
        error: Some(err),
      }
    }
  }
}

/// Read a semantic model's schema (tables/columns/measures/relationships) for
/// the Model tab's diagram. Delegates to [`crate::services::semantic_model`],
/// which queries the model live via DAX `INFO.VIEW.*` through the Power BI
/// `executeQueries` endpoint (reusing the silent Rayfin-CLI token). Never
/// throws — returns an `ok:false` result (with `needsLogin`) the UI can render.
#[tauri::command]
pub async fn fabric_semantic_model_schema(
  workspace_id: String,
  item_id: String,
) -> crate::services::semantic_model::SemanticSchemaResult {
  crate::services::semantic_model::schema_semantic_model(&workspace_id, &item_id).await
}

/* ------------------------------- sharing ---------------------------------- */

/// The Node helper that grants a Fabric workspace role + Power BI model access.
/// Embedded at compile time; written to the app data dir at runtime (via
/// [`write_helper`]) so the system `node` can execute it.
const SHARE_HELPER_SOURCE: &str = include_str!("../services/fabric_share_helper.mjs");

/// Sharing fans out across recipients × (app + models) with a Graph lookup each,
/// so allow a generous budget before the child is killed.
const SHARE_TIMEOUT_MS: u64 = 120_000;

/// Parse-failure classification for a missing / signed-out Azure CLI (the share
/// helper needs an `az` Graph token to resolve recipients to object ids).
static NEEDS_AZ_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"(?i)\baz\b|azure cli|az login|az account").unwrap());

/// `fabric.yaml` shape — only the fields we read (keys are camelCase).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FabricYaml {
  #[serde(default)]
  active_profile: Option<String>,
  #[serde(default)]
  profiles: HashMap<String, FabricProfile>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FabricProfile {
  #[serde(default)]
  semantic_models: HashMap<String, FabricModelConn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FabricModelConn {
  #[serde(default)]
  workspace_id: String,
  #[serde(default)]
  item_id: String,
}

/// Parse the semantic-model connections in a `fabric.yaml` document (active
/// profile, falling back to `default`). Returns an empty list when the document
/// is unparseable or declares none — the app then simply has no models to share.
fn parse_semantic_models_yaml(text: &str) -> Vec<SemanticModelRef> {
  let parsed: FabricYaml = match serde_yaml::from_str(text) {
    Ok(p) => p,
    Err(_) => return vec![],
  };
  let profile_name = parsed.active_profile.unwrap_or_else(|| "default".to_string());
  let Some(profile) = parsed
    .profiles
    .get(&profile_name)
    .or_else(|| parsed.profiles.get("default"))
  else {
    return vec![];
  };
  let mut models: Vec<SemanticModelRef> = profile
    .semantic_models
    .iter()
    .filter(|(_, c)| !c.workspace_id.trim().is_empty() && !c.item_id.trim().is_empty())
    .map(|(alias, c)| SemanticModelRef {
      alias: alias.clone(),
      workspace_id: c.workspace_id.trim().to_string(),
      item_id: c.item_id.trim().to_string(),
    })
    .collect();
  models.sort_by(|a, b| a.alias.to_lowercase().cmp(&b.alias.to_lowercase()));
  models
}

/// Read the project's `fabric.yaml` semantic-model connections. A missing file is
/// not an error (an app can use no models) — it just yields an empty list.
fn read_project_semantic_models(project_dir: &Path) -> Vec<SemanticModelRef> {
  match std::fs::read_to_string(project_dir.join("fabric.yaml")) {
    Ok(text) => parse_semantic_models_yaml(&text),
    Err(_) => vec![],
  }
}

/// Split models into `(different_workspace, same_workspace)` relative to the app's
/// hosting workspace (case-insensitive). Same-workspace models are already
/// covered by the workspace role grant, so only the different-workspace ones need
/// an explicit Build share.
fn split_models_by_workspace(
  models: Vec<SemanticModelRef>,
  app_workspace_id: &str,
) -> (Vec<SemanticModelRef>, Vec<SemanticModelRef>) {
  let app = app_workspace_id.trim().to_lowercase();
  models
    .into_iter()
    .partition(|m| m.workspace_id.trim().to_lowercase() != app)
}

/// List the semantic-model connections declared in the project's `fabric.yaml`
/// active profile — surfaced to the Share dialog so the user can see which models
/// will also be shared. Never throws.
#[tauri::command]
pub async fn fabric_project_semantic_models(project_id: String) -> Vec<SemanticModelRef> {
  match store::find_project(&project_id) {
    Some(p) => read_project_semantic_models(Path::new(&p.path)),
    None => vec![],
  }
}

/// Share a deployment's app with `recipients` (emails): grant each **Contributor**
/// on the app's hosting workspace (`workspace_id`), and **Build** on every
/// semantic model the app uses that lives in a *different* workspace. Reuses the
/// silent Rayfin-CLI tokens (Fabric + Power BI) and an Azure CLI Graph token (to
/// resolve emails to directory object ids). Never throws — returns a structured
/// [`FabricShareResult`] with per-recipient outcomes, or a global
/// `needs_login`/`needs_az`/`error`.
#[tauri::command]
pub async fn fabric_share_app(
  project_id: String,
  workspace_id: String,
  recipients: Vec<String>,
) -> FabricShareResult {
  let recipients: Vec<String> = recipients
    .into_iter()
    .map(|r| r.trim().to_string())
    .filter(|r| !r.is_empty())
    .collect();
  if recipients.is_empty() {
    return FabricShareResult::failure("Enter at least one email to share with.".to_string());
  }
  let ws = workspace_id.trim().to_string();
  if ws.is_empty() {
    return FabricShareResult::failure(
      "This deployment has no Fabric workspace id yet — deploy it before sharing.".to_string(),
    );
  }

  let Some(project) = store::find_project(&project_id) else {
    return FabricShareResult::failure("Project not found.".to_string());
  };
  let project_dir = PathBuf::from(project.path);

  let auth_path = match project_auth_module(Some(&project_dir)).await {
    Ok(p) => p,
    Err(error) => return FabricShareResult::failure(error),
  };
  let script_path = match write_helper("fabric-share.mjs", SHARE_HELPER_SOURCE) {
    Ok(p) => p,
    Err(err) => {
      return FabricShareResult::failure(format!("Could not prepare the share helper: {err}"))
    }
  };

  // Only different-workspace models need an explicit Build share; same-workspace
  // models are covered by the workspace Contributor grant.
  let all_models = read_project_semantic_models(&project_dir);
  let (different, _same) = split_models_by_workspace(all_models, &ws);

  let request = serde_json::json!({
    "appWorkspaceId": ws,
    "role": "Contributor",
    "recipients": recipients,
    "models": different,
    "modelAccessRight": "ReadExplore",
  });

  let auth_str = auth_path.to_string_lossy().to_string();
  let script_str = script_path.to_string_lossy().to_string();
  let request_str = request.to_string();
  let res = exec::run(
    "node",
    &[&script_str, &auth_str, &request_str],
    RunOptions::timeout(SHARE_TIMEOUT_MS),
  )
  .await;

  if res.not_found {
    return FabricShareResult::failure("Node.js was not found on PATH.".to_string());
  }

  let out = res.stdout.trim();
  match serde_json::from_str::<FabricShareResult>(out) {
    Ok(parsed) => parsed,
    Err(_) => {
      // The child died before emitting JSON — classify the raw error.
      let (needs_login, err) = failure_error(&res, out);
      let needs_az = NEEDS_AZ_RE.is_match(&err);
      FabricShareResult {
        ok: false,
        recipients: vec![],
        needs_login: Some(needs_login && !needs_az),
        needs_az: Some(needs_az),
        error: Some(err),
      }
    }
  }
}

/// Search the directory (Microsoft Graph, via the Azure CLI token) for people
/// matching `query` — powers the Share dialog's name/email autocomplete. Reuses
/// the embedded share helper's `searchDirectory` mode (no Rayfin auth module
/// needed, so it stays fast). Never throws — an empty query yields no people; a
/// signed-out `az` yields `needs_az` so the UI can degrade autocomplete quietly.
#[tauri::command]
pub async fn fabric_directory_search(query: String) -> FabricDirectoryResult {
  let q = query.trim().to_string();
  if q.is_empty() {
    return FabricDirectoryResult {
      ok: true,
      ..Default::default()
    };
  }
  let script_path = match write_helper("fabric-share.mjs", SHARE_HELPER_SOURCE) {
    Ok(p) => p,
    Err(err) => {
      return FabricDirectoryResult {
        ok: false,
        error: Some(format!("Could not prepare the directory helper: {err}")),
        ..Default::default()
      }
    }
  };
  let script_str = script_path.to_string_lossy().to_string();
  let request = serde_json::json!({ "mode": "searchDirectory", "query": q });
  let request_str = request.to_string();
  // The helper's search mode ignores the auth-module argv, so pass a placeholder
  // rather than resolving (and possibly installing) the project's Rayfin CLI.
  let res = exec::run(
    "node",
    &[&script_str, "-", &request_str],
    RunOptions::timeout(20_000),
  )
  .await;

  if res.not_found {
    return FabricDirectoryResult {
      ok: false,
      error: Some("Node.js was not found on PATH.".to_string()),
      ..Default::default()
    };
  }

  let out = res.stdout.trim();
  match serde_json::from_str::<FabricDirectoryResult>(out) {
    Ok(parsed) => parsed,
    Err(_) => {
      let (needs_login, err) = failure_error(&res, out);
      let needs_az = NEEDS_AZ_RE.is_match(&err);
      FabricDirectoryResult {
        ok: false,
        people: vec![],
        needs_az: Some(needs_az),
        needs_login: Some(needs_login && !needs_az),
        error: Some(err),
      }
    }
  }
}

/* ------------------------- connect semantic model ------------------------- */

/// List the semantic models in a workspace — the data behind the "connect a model
/// from your workspace" picker. Delegates to the semantic-model service (silent
/// Fabric token). Never throws.
#[tauri::command]
pub async fn fabric_list_workspace_models(
  workspace_id: String,
) -> crate::services::semantic_model::WorkspaceModelsResult {
  crate::services::semantic_model::list_workspace_models(&workspace_id).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::FabricWorkspace;

  #[test]
  fn workspaces_success_shape_deserializes() {
    let json = r#"{"ok":true,"workspaces":[
      {"id":"a","displayName":"Zeta","capacityKind":"none","eligible":false},
      {"id":"b","displayName":"alpha","capacityId":"c1","region":"westus","sku":"F2","capacityName":"Cap","capacityKind":"fabric","eligible":true}
    ]}"#;
    let parsed: FabricWorkspacesResult = serde_json::from_str(json).unwrap();
    assert!(parsed.ok);
    let ws = parsed.workspaces.unwrap();
    assert_eq!(ws.len(), 2);
    // Absent optional fields default to None.
    assert!(ws[0].sku.is_none());
    assert!(ws[0].capacity_id.is_none());
    assert_eq!(ws[1].sku.as_deref(), Some("F2"));
  }

  #[test]
  fn workspaces_error_shape_deserializes() {
    let json = r#"{"ok":false,"needsLogin":true,"error":"no cached account"}"#;
    let parsed: FabricWorkspacesResult = serde_json::from_str(json).unwrap();
    assert!(!parsed.ok);
    assert!(parsed.workspaces.is_none());
    assert_eq!(parsed.needs_login, Some(true));
    assert_eq!(parsed.error.as_deref(), Some("no cached account"));
  }

  #[test]
  fn eligible_first_then_alpha_sort() {
    let mut ws = vec![
      FabricWorkspace {
        id: "1".into(),
        display_name: "Zeta".into(),
        r#type: None,
        capacity_id: None,
        region: None,
        sku: None,
        capacity_name: None,
        capacity_kind: "none".into(),
        eligible: false,
      },
      FabricWorkspace {
        id: "2".into(),
        display_name: "beta".into(),
        r#type: None,
        capacity_id: None,
        region: None,
        sku: Some("F2".into()),
        capacity_name: None,
        capacity_kind: "fabric".into(),
        eligible: true,
      },
      FabricWorkspace {
        id: "3".into(),
        display_name: "Alpha".into(),
        r#type: None,
        capacity_id: None,
        region: None,
        sku: None,
        capacity_name: None,
        capacity_kind: "none".into(),
        eligible: false,
      },
    ];
    ws.sort_by(|a, b| {
      if a.eligible != b.eligible {
        if a.eligible {
          Ordering::Less
        } else {
          Ordering::Greater
        }
      } else {
        a.display_name
          .to_lowercase()
          .cmp(&b.display_name.to_lowercase())
      }
    });
    let ids: Vec<&str> = ws.iter().map(|w| w.id.as_str()).collect();
    // Eligible "beta" first, then non-eligible alphabetically (Alpha, Zeta).
    assert_eq!(ids, vec!["2", "3", "1"]);
  }

  #[test]
  fn delete_result_shape_deserializes() {
    let ok: FabricDeleteResult =
      serde_json::from_str(r#"{"ok":true,"deleted":2,"failures":[]}"#).unwrap();
    assert!(ok.ok);
    assert_eq!(ok.deleted, 2);
    assert!(ok.failures.is_empty());

    let bad: FabricDeleteResult = serde_json::from_str(
      r#"{"ok":false,"deleted":1,"failures":[{"name":"app","error":"Fabric returned 500"}],"needsLogin":false}"#,
    )
    .unwrap();
    assert!(!bad.ok);
    assert_eq!(bad.deleted, 1);
    assert_eq!(bad.failures.len(), 1);
    assert_eq!(bad.failures[0].name, "app");
  }

  #[test]
  fn delete_item_serializes_camel_case() {
    let item = DeleteItem {
      workspace_id: "w".into(),
      item_id: "i".into(),
      name: "n".into(),
    };
    let json = serde_json::to_string(&item).unwrap();
    assert!(json.contains("\"workspaceId\":\"w\""));
    assert!(json.contains("\"itemId\":\"i\""));
    assert!(json.contains("\"name\":\"n\""));
  }

  #[test]
  fn helper_sources_have_clean_stdout_contract() {
    assert!(HELPER_SOURCE.contains("getRayfinAuth"));
    assert!(HELPER_SOURCE.contains("silentOnly: true"));
    assert!(HELPER_SOURCE.contains("process.stdout.write(JSON.stringify({ ok: true, workspaces }))"));
    // The helper must follow Fabric's 100/page pagination for both lists.
    assert!(HELPER_SOURCE.contains("fetchAllPages"));
    assert!(HELPER_SOURCE.contains("continuationUri"));
    assert!(HELPER_SOURCE.contains("continuationToken"));
    // A workspace with a capacity but no visible SKU is 'unknown' (still eligible).
    assert!(HELPER_SOURCE.contains("'unknown'"));
    // PPU (PP* SKU) must be classified ineligible 'other', not premium.
    assert!(HELPER_SOURCE.contains("s.startsWith('PP')"));
    assert!(DELETE_HELPER_SOURCE.contains("method: 'DELETE'"));
    assert!(DELETE_HELPER_SOURCE.contains("res.status === 404"));
    // Create-workspace helper POSTs a workspace; capacities helper excludes PPU.
    assert!(CREATE_WS_HELPER_SOURCE.contains("method: 'POST'"));
    assert!(CAPACITIES_HELPER_SOURCE.contains("s.startsWith('PP')"));
  }

  #[test]
  fn parse_semantic_models_yaml_reads_active_profile() {
    let yaml = r#"
activeProfile: dev
profiles:
  dev:
    semanticModels:
      sales:
        workspaceId: "ws-1"
        itemId: "ds-1"
      churn:
        workspaceId: "me"
        itemId: "ds-2"
  production:
    semanticModels:
      sales:
        workspaceId: "ws-prod"
        itemId: "ds-prod"
"#;
    let models = parse_semantic_models_yaml(yaml);
    // Only the active (dev) profile, sorted by alias (churn, sales).
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].alias, "churn");
    assert_eq!(models[0].workspace_id, "me");
    assert_eq!(models[1].alias, "sales");
    assert_eq!(models[1].item_id, "ds-1");
  }

  #[test]
  fn parse_semantic_models_yaml_empty_and_invalid() {
    // The scaffold's empty default profile declares no models.
    assert!(parse_semantic_models_yaml("activeProfile: default\nprofiles:\n  default: {}\n").is_empty());
    // Junk / non-YAML degrades to an empty list rather than panicking.
    assert!(parse_semantic_models_yaml(":: not yaml ::").is_empty());
    // A model missing ids is skipped.
    let partial = "activeProfile: d\nprofiles:\n  d:\n    semanticModels:\n      x:\n        workspaceId: \"\"\n        itemId: \"i\"\n";
    assert!(parse_semantic_models_yaml(partial).is_empty());
  }

  #[test]
  fn split_models_by_workspace_partitions_case_insensitively() {
    let models = vec![
      SemanticModelRef { alias: "same".into(), workspace_id: "WS-A".into(), item_id: "i1".into() },
      SemanticModelRef { alias: "other".into(), workspace_id: "ws-b".into(), item_id: "i2".into() },
      SemanticModelRef { alias: "mine".into(), workspace_id: "me".into(), item_id: "i3".into() },
    ];
    let (different, same) = split_models_by_workspace(models, "ws-a");
    // Same workspace matched despite different casing.
    assert_eq!(same.len(), 1);
    assert_eq!(same[0].alias, "same");
    // "me" and the other group both count as different workspaces (need Build).
    let diff_aliases: Vec<&str> = different.iter().map(|m| m.alias.as_str()).collect();
    assert_eq!(diff_aliases, vec!["other", "mine"]);
  }

  #[test]
  fn share_result_shape_deserializes() {
    let json = r#"{
      "ok": true,
      "recipients": [
        {"email":"a@x.com","resolved":true,"principalType":"User",
         "app":{"ok":true},
         "models":[{"alias":"sales","itemId":"ds-1","workspaceId":"ws-2","ok":true,"skipped":true}]}
      ]
    }"#;
    let parsed: FabricShareResult = serde_json::from_str(json).unwrap();
    assert!(parsed.ok);
    assert_eq!(parsed.recipients.len(), 1);
    let r = &parsed.recipients[0];
    assert!(r.resolved);
    assert!(r.app.ok);
    assert_eq!(r.models.len(), 1);
    assert_eq!(r.models[0].skipped, Some(true));
    assert!(parsed.needs_az.is_none());

    let failure: FabricShareResult =
      serde_json::from_str(r#"{"ok":false,"recipients":[],"needsAz":true,"error":"az login"}"#).unwrap();
    assert!(!failure.ok);
    assert_eq!(failure.needs_az, Some(true));
    assert_eq!(failure.error.as_deref(), Some("az login"));
  }

  #[test]
  fn semantic_model_ref_serializes_camel_case() {
    let m = SemanticModelRef { alias: "sales".into(), workspace_id: "w".into(), item_id: "i".into() };
    let json = serde_json::to_string(&m).unwrap();
    assert!(json.contains("\"workspaceId\":\"w\""));
    assert!(json.contains("\"itemId\":\"i\""));
  }

  #[test]
  fn share_helper_source_contract() {
    // Silent token reuse + the two grant endpoints + Build access right, and a
    // single clean stdout write.
    assert!(SHARE_HELPER_SOURCE.contains("getRayfinAuth"));
    assert!(SHARE_HELPER_SOURCE.contains("silentOnly: true"));
    assert!(SHARE_HELPER_SOURCE.contains("roleAssignments"));
    assert!(SHARE_HELPER_SOURCE.contains("/datasets/"));
    assert!(SHARE_HELPER_SOURCE.contains("ReadExplore"));
    assert!(SHARE_HELPER_SOURCE.contains("graph.microsoft.com"));
    // The directory-search (autocomplete) mode is embedded in the same helper.
    assert!(SHARE_HELPER_SOURCE.contains("searchDirectory"));
  }

  #[test]
  fn directory_result_shape_deserializes() {
    let ok: FabricDirectoryResult = serde_json::from_str(
      r#"{"ok":true,"people":[{"id":"1","displayName":"Ada Lovelace","email":"ada@x.com"},{"email":"grace@x.com"}]}"#,
    )
    .unwrap();
    assert!(ok.ok);
    assert_eq!(ok.people.len(), 2);
    assert_eq!(ok.people[0].display_name.as_deref(), Some("Ada Lovelace"));
    assert_eq!(ok.people[1].email.as_deref(), Some("grace@x.com"));
    assert!(ok.people[1].display_name.is_none());

    let bad: FabricDirectoryResult =
      serde_json::from_str(r#"{"ok":false,"people":[],"needsAz":true,"error":"az login"}"#).unwrap();
    assert!(!bad.ok);
    assert_eq!(bad.needs_az, Some(true));
  }

  #[test]
  fn workspace_models_result_shape_deserializes() {
    use crate::services::semantic_model::WorkspaceModelsResult;
    let ok: WorkspaceModelsResult = serde_json::from_str(
      r#"{"ok":true,"models":[{"id":"d1","name":"Sales","isRefreshable":true,"configuredBy":"a@x.com"}]}"#,
    )
    .unwrap();
    assert!(ok.ok);
    assert_eq!(ok.models.len(), 1);
    assert_eq!(ok.models[0].name.as_deref(), Some("Sales"));
    assert_eq!(ok.models[0].is_refreshable, Some(true));

    let bad: WorkspaceModelsResult =
      serde_json::from_str(r#"{"ok":false,"needsLogin":true,"error":"no cached account"}"#).unwrap();
    assert!(!bad.ok);
    assert!(bad.needs_login);
  }
}
