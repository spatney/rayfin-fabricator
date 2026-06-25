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
use std::path::PathBuf;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

use crate::services::{exec, paths, store};
use crate::services::exec::RunOptions;
use crate::types::{FabricDeleteResult, FabricWorkspacesResult};

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

/// List the signed-in user's Fabric workspaces, each annotated with its
/// capacity SKU and whether that capacity is eligible to host a Rayfin app.
#[tauri::command]
pub async fn fabric_workspaces() -> FabricWorkspacesResult {
  let auth_path = match exec::global_rayfin_auth_module() {
    Some(p) => p,
    None => {
      return FabricWorkspacesResult {
        ok: false,
        workspaces: None,
        needs_login: None,
        error: Some(
          "Could not locate the Rayfin CLI to list Fabric workspaces. Make sure the rayfin CLI is installed."
            .to_string(),
        ),
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

  let auth_path = match exec::global_rayfin_auth_module() {
    Some(p) => p,
    None => {
      return FabricDeleteResult {
        ok: false,
        deleted: 0,
        failures: vec![],
        needs_login: None,
        error: Some(
          "Could not locate the Rayfin CLI to reach Fabric. Make sure the rayfin CLI is installed."
            .to_string(),
        ),
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
    assert!(DELETE_HELPER_SOURCE.contains("method: 'DELETE'"));
    assert!(DELETE_HELPER_SOURCE.contains("res.status === 404"));
  }
}
