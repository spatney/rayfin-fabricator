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
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

use crate::services::{exec, paths, store};
use crate::services::exec::RunOptions;
use crate::types::{
  FabricDeleteResult, FabricReportDefinitionResult, FabricReportsResult, FabricSignInResult,
  FabricWorkspacesResult,
};
use crate::types::{FabricCapacitiesResult, FabricCreateWorkspaceResult, FabricExportPdfResult};

const FABRIC_API_BASE: &str = "https://api.fabric.microsoft.com/v1";

/// Power BI REST base. The report export-to-file API (`ExportTo`) lives on the
/// Power BI surface (not the Fabric one), so it needs a Power BI-audience token.
const FABRIC_PBI_BASE: &str = "https://api.powerbi.com/v1.0/myorg";

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

/// Helper executed by the system `node` to list a workspace's Power BI reports.
/// argv: <authModulePath> <apiBase> <workspaceId>. Writes exactly one JSON line
/// to stdout; library logging is routed to stderr.
const REPORTS_HELPER_SOURCE: &str = r#"// Keep stdout clean for the JSON result; route any library logging to stderr.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.debug = console.log
console.info = console.log

import { pathToFileURL } from 'node:url'

const API_HOST = 'https://api.fabric.microsoft.com'

// Reports list endpoint pages at 100 items each, returning a continuationUri /
// continuationToken when more remain. Follow every page so nothing is lost.
async function fetchAllPages(startUrl, headers, { label = '' } = {}) {
  const out = []
  const seen = new Set()
  let url = startUrl
  for (let i = 0; i < 100 && url; i++) {
    if (seen.has(url)) break
    seen.add(url)
    const res = await fetch(url, { headers })
    if (!res.ok) {
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
  const [authPath, base, workspaceId] = process.argv.slice(2)
  const auth = await import(pathToFileURL(authPath).href)
  const rf = await auth.getRayfinAuth()
  // silentOnly: never pop a browser — fail fast if there's no cached session.
  const { token } = await rf.acquireToken(undefined, { silentOnly: true })
  const headers = { Authorization: 'Bearer ' + token }

  const value = await fetchAllPages(
    base + '/workspaces/' + encodeURIComponent(workspaceId) + '/reports',
    headers,
    { label: '/reports' }
  )
  const reports = value.map((r) => ({
    id: r.id,
    displayName: r.displayName || r.name || r.id,
    description: r.description || undefined,
    webUrl: r.webUrl || undefined
  }))
  process.stdout.write(JSON.stringify({ ok: true, reports }))
}

main().catch((err) => {
  const msg = err && err.message ? String(err.message) : String(err)
  const needsLogin = /silent|cached|account|login|token|interactive|sign/i.test(msg)
  process.stdout.write(JSON.stringify({ ok: false, needsLogin, error: msg }))
})
"#;

/// Helper executed by the system `node` to download an item's public definition
/// and write each part to disk. argv:
/// <authModulePath> <apiBase> <mode> <workspaceId> <itemId> <destDir>, where
/// `mode` is `report` (PBIR → also returns the bound `modelId`) or `model`
/// (semantic model TMDL). Follows the Fabric long-running-operation protocol and
/// base64-decodes each inline part.
const DEFINITION_HELPER_SOURCE: &str = r#"// Keep stdout clean for the JSON result; route any library logging to stderr.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.debug = console.log
console.info = console.log

import { pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// getDefinition returns editable report code, so it needs a Fabric *write* scope
// (Item.ReadWrite.All). Only this migrate flow asks for it — read-only users
// never trigger it — so we request it here rather than widening the app's
// baseline sign-in. acquireToken tries the cached session first and only opens an
// interactive consent window when this scope hasn't been granted yet.
const WRITE_SCOPES = ['https://api.fabric.microsoft.com/Item.ReadWrite.All']

// Request an item's public definition. getDefinition is a long-running
// operation: a 202 hands back a Location to poll until the operation settles,
// at which point the result carries `definition.parts` (either inline on the
// status body or at the operation's `/result` endpoint). `itemType` is the
// Fabric collection segment — `reports` or `semanticModels`.
async function requestDefinition(base, wsId, itemType, itemId, headers, format) {
  const q = format ? '?format=' + encodeURIComponent(format) : ''
  const startUrl =
    base + '/workspaces/' + encodeURIComponent(wsId) +
    '/' + itemType + '/' + encodeURIComponent(itemId) + '/getDefinition' + q
  const res = await fetch(startUrl, { method: 'POST', headers })

  if (res.status === 202) {
    const loc = res.headers.get('location')
    let retry = Number(res.headers.get('retry-after')) || 2
    if (!loc) throw new Error('getDefinition was accepted but returned no polling Location')
    for (let i = 0; i < 120; i++) {
      await sleep(retry * 1000)
      const poll = await fetch(loc, { headers })
      if (!poll.ok) {
        const t = await poll.text().catch(() => '')
        throw new Error('getDefinition polling failed (' + poll.status + ') ' + t.slice(0, 200))
      }
      const body = await poll.json().catch(() => ({}))
      retry = Number(poll.headers.get('retry-after')) || retry
      const status = String(body.status || '').toLowerCase()
      if (status === 'failed') {
        throw new Error((body.error && body.error.message) || 'getDefinition operation failed')
      }
      if (body.definition) return body.definition
      if (status === 'succeeded') {
        const resultUrl = loc.replace(/\/$/, '') + '/result'
        const r = await fetch(resultUrl, { headers })
        if (!r.ok) {
          const t = await r.text().catch(() => '')
          throw new Error('getDefinition result fetch failed (' + r.status + ') ' + t.slice(0, 200))
        }
        return (await r.json()).definition
      }
      // Otherwise still Running / NotStarted — keep polling.
    }
    throw new Error('getDefinition timed out waiting for the operation to complete')
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '')
    const err = new Error('getDefinition failed (' + res.status + ') ' + t.slice(0, 200))
    err.status = res.status
    throw err
  }
  return (await res.json()).definition
}

// Fetch an item's definition with a given bearer token, trying each format in
// order and returning the first that succeeds. `formats` is an ordered list of
// preferred → fallback formats (use `undefined` for "the item's stored format").
// A report authored in the classic format can't be converted to enhanced PBIR:
// getDefinition accepts the request (202) and then *fails the long-running
// operation* with "cannot be converted", so we must fall through to PBIR-Legacy.
// Auth/consent failures are surfaced immediately rather than masked by a retry.
async function getDefinitionWith(base, wsId, itemType, itemId, token, formats) {
  const headers = { Authorization: 'Bearer ' + token }
  let lastErr
  for (const fmt of formats) {
    try {
      return await requestDefinition(base, wsId, itemType, itemId, headers, fmt)
    } catch (e) {
      lastErr = e
      const status = e && e.status
      const msg = String((e && e.message) || '')
      const isAuth =
        status === 401 ||
        status === 403 ||
        /unauthorized|forbidden|consent|\btoken\b|sign in|\blogin\b/i.test(msg)
      if (isAuth) throw e
      // Otherwise it's a format/availability problem — try the next format.
    }
  }
  throw lastErr
}

// Base64-decode each inline part and write it under destDir, returning the list
// of relative paths written.
function writeParts(parts, destDir) {
  const files = []
  for (const p of parts || []) {
    if (!p || !p.path) continue
    const abs = join(destDir, p.path)
    mkdirSync(dirname(abs), { recursive: true })
    const buf =
      p.payloadType === 'InlineBase64' && typeof p.payload === 'string'
        ? Buffer.from(p.payload, 'base64')
        : Buffer.from(String(p.payload == null ? '' : p.payload), 'utf8')
    writeFileSync(abs, buf)
    files.push(p.path)
  }
  return files
}

// A thin report binds to its semantic model by a live connection. Both PBIR and
// PBIR-Legacy expose a `definition.pbir` whose `datasetReference` carries that
// binding; the model's dataset GUID (which equals the semantic model's Fabric
// item id) shows up as a `semanticmodelid=` param on the `byConnection`
// connection string (the modern PBIR v4 format — note its `initial catalog=` is
// the model *name*, not a GUID), as `pbiModelDatabaseName`, as an
// `Initial Catalog=<GUID>` connection string, or as a `datasetId`. Search the
// pbir first, then fall back to every part (legacy report.json, connections
// files, …) so we resolve the model that actually holds the DAX regardless of
// the report's stored format.
function decodePart(p) {
  try {
    return p && p.payloadType === 'InlineBase64' && typeof p.payload === 'string'
      ? Buffer.from(p.payload, 'base64').toString('utf8')
      : String((p && p.payload) || '')
  } catch {
    return ''
  }
}

function resolveModelId(parts) {
  const list = parts || []
  const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
  const find = (text) => {
    if (!text) return null
    const m =
      text.match(new RegExp('semanticmodelid\\s*=\\s*(' + GUID + ')', 'i')) ||
      text.match(new RegExp('"pbiModelDatabaseName"\\s*:\\s*"(' + GUID + ')"')) ||
      text.match(new RegExp('Initial Catalog=(' + GUID + ')', 'i')) ||
      text.match(new RegExp('"datasetId"\\s*:\\s*"(' + GUID + ')"', 'i'))
    return m ? m[1] : null
  }
  const pbir = list.find(
    (p) => p && typeof p.path === 'string' && /(^|\/)definition\.pbir$/i.test(p.path)
  )
  return find(pbir ? decodePart(pbir) : null) || find(list.map(decodePart).join('\n'))
}

async function main() {
  const [authPath, base, mode, workspaceId, itemId, destDir] = process.argv.slice(2)
  const auth = await import(pathToFileURL(authPath).href)
  const rf = await auth.getRayfinAuth()

  // silentOnly:false → reuse the cached session when it already carries the write
  // scope, otherwise pop an interactive consent window to request it. This download
  // is the only place the migrate flow asks for write access, so read-only users
  // never trigger a consent prompt.
  const { token } = await rf.acquireToken(WRITE_SCOPES, { silentOnly: false })

  if (mode === 'model') {
    // The semantic model holds the real DAX measures/tables/relationships. TMDL
    // is the human-readable format; fall back to the stored (TMSL) format.
    const modelDef = await getDefinitionWith(base, workspaceId, 'semanticModels', itemId, token, ['TMDL', undefined])
    const files = writeParts((modelDef && modelDef.parts) || [], destDir)
    process.stdout.write(JSON.stringify({ ok: true, files, dir: destDir }))
    return
  }

  // Default: report mode. PBIR gives pages/visuals as split files; classic
  // reports can't convert to PBIR, so fall back to PBIR-Legacy (report.json).
  // Also resolve the bound semantic model id so the caller can download the
  // model (the DAX) as a separate step.
  const definition = await getDefinitionWith(base, workspaceId, 'reports', itemId, token, ['PBIR', 'PBIR-Legacy'])
  const parts = (definition && definition.parts) || []
  const files = writeParts(parts, destDir)
  const modelId = resolveModelId(parts)
  const result = { ok: true, files, dir: destDir }
  if (modelId) result.modelId = modelId
  process.stdout.write(JSON.stringify(result))
}

main().catch((err) => {
  const msg = err && err.message ? String(err.message) : String(err)
  const needsLogin = /silent|cached|account|login|token|interactive|sign|unauthorized|forbidden|consent/i.test(msg)
  process.stdout.write(JSON.stringify({ ok: false, needsLogin, error: msg }))
})
"#;

/// Helper executed by the system `node` to export a Power BI report to a PDF via
/// the Power BI `ExportTo` REST API, then write it to disk and hand it back
/// base64-encoded (the renderer rasterizes each page to an image with pdf.js).
/// argv: <pbiBase> <workspaceId> <reportId> <destPdfPath>.
/// We always export **PDF** (a single file with every page): PNG/image export is
/// disabled at the tenant level on many tenants, whereas PDF export is broadly
/// available for capacity-backed workspaces. Writes one JSON line to stdout.
const EXPORT_PDF_HELPER_SOURCE: &str = r#"// Keep stdout clean for the JSON result; route any library logging to stderr.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.debug = console.log
console.info = console.log

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ExportTo lives on the classic Power BI surface and enforces the delegated
// `Report.Read.All` scope. The Rayfin CLI's MSAL app registration is only
// consented for Fabric scopes (Item.*/Workspace.*), so its Power BI-audience
// token is rejected by ExportTo with 401. The Azure CLI's first-party client
// *is* preauthorized for Power BI (its token carries `scp=user_impersonation`),
// and `az` is a required, signed-in tool in Fabricator — so, mirroring the
// DAX/semantic-model path (services/semantic_model_helper.mjs), we mint the
// ExportTo token via `az` rather than the MSAL Fabric token.
const PBI_RESOURCE = 'https://analysis.windows.net/powerbi/api'

class NeedsAz extends Error {}

// Acquire a Power BI-audience token from the signed-in Azure CLI. `az` is
// `az.cmd` on Windows; invoke it through cmd.exe so we don't need shell:true
// (which Node deprecates when args are passed as an array).
function azToken(resource) {
  return new Promise((resolve, reject) => {
    const args = ['account', 'get-access-token', '--resource', resource, '--query', 'accessToken', '-o', 'tsv']
    const isWin = process.platform === 'win32'
    const file = isWin ? process.env.ComSpec || 'cmd.exe' : 'az'
    const argv = isWin ? ['/d', '/s', '/c', 'az', ...args] : args
    execFile(file, argv, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const errText = (stderr || (err && err.message) || '').trim()
      if (err) return reject(new NeedsAz(errText || 'az account get-access-token failed'))
      const t = (stdout || '').trim()
      if (!t) return reject(new NeedsAz(errText || 'az returned no token'))
      resolve(t)
    })
  })
}

function tag(status, msg) {
  const e = new Error('(' + status + ') ' + msg)
  e.status = status
  return e
}

async function main() {
  const [pbiBase, workspaceId, reportId, destPath] = process.argv.slice(2)
  const token = await azToken(PBI_RESOURCE)
  const headers = { Authorization: 'Bearer ' + token }

  // 1) Kick off the export.
  const startUrl =
    pbiBase + '/groups/' + encodeURIComponent(workspaceId) +
    '/reports/' + encodeURIComponent(reportId) + '/ExportTo'
  const start = await fetch(startUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'PDF' })
  })
  if (!start.ok) {
    const t = await start.text().catch(() => '')
    throw tag(start.status, 'ExportTo start failed: ' + t.slice(0, 300))
  }
  const exportId = (await start.json()).id
  if (!exportId) throw new Error('ExportTo returned no export id')

  // 2) Poll the long-running export until it settles.
  const statusUrl =
    pbiBase + '/groups/' + encodeURIComponent(workspaceId) +
    '/reports/' + encodeURIComponent(reportId) + '/exports/' + encodeURIComponent(exportId)
  let state = 'Running'
  for (let i = 0; i < 150; i++) {
    await sleep(2000)
    const p = await fetch(statusUrl, { headers })
    if (!p.ok) {
      const t = await p.text().catch(() => '')
      throw tag(p.status, 'export polling failed: ' + t.slice(0, 200))
    }
    const body = await p.json().catch(() => ({}))
    state = String(body.status || '')
    if (state === 'Succeeded' || state === 'Failed') break
  }
  if (state !== 'Succeeded') throw new Error('report export did not succeed (status: ' + state + ')')

  // 3) Download the PDF, persist it, and return it inline for rasterization.
  const dl = await fetch(statusUrl + '/file', { headers })
  if (!dl.ok) {
    const t = await dl.text().catch(() => '')
    throw tag(dl.status, 'export download failed: ' + t.slice(0, 200))
  }
  const buf = Buffer.from(await dl.arrayBuffer())
  mkdirSync(dirname(destPath), { recursive: true })
  writeFileSync(destPath, buf)

  process.stdout.write(JSON.stringify({
    ok: true, pdfPath: destPath, bytes: buf.length, pdfBase64: buf.toString('base64')
  }))
}

main().catch((err) => {
  const msg = err && err.message ? String(err.message) : String(err)
  const needsLogin = err instanceof NeedsAz ||
    /silent|cached|account|az login|login|token|interactive|sign|unauthorized|forbidden|consent/i.test(msg)
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

/// Resolve a Fabric auth module for REST calls. Prefers the project's local CLI
/// when it's *already* installed, otherwise falls back to the globally-installed
/// `rayfin` CLI. It never triggers an `npm install`: Fabric calls only need a
/// bearer token, and the MSAL session cache is shared between the local and global
/// CLIs, so the signed-in session is always reachable via the global CLI. Forcing a
/// dependency install here previously made every Fabric command (workspace/report
/// listing, migrate downloads, sign-in) hang behind a long — and, on locked-down
/// npm feeds, failing — install whenever the active project's deps weren't restored.
async fn project_auth_module(project_dir: Option<&Path>) -> Result<PathBuf, String> {
  let local_ready = project_dir.is_some_and(exec::project_rayfin_cli_installed);
  let resolved = if local_ready { project_dir } else { None };
  exec::project_rayfin_auth_module(resolved).ok_or_else(|| {
    "Could not locate the Rayfin CLI. Open a Rayfin project to reach Fabric.".to_string()
  })
}

/// A node child that couldn't *load* its auth module — a broken or partial
/// `node_modules` (e.g. a version-mismatched `@azure/msal-node`) — rather than a
/// genuine auth/API failure. The helper catches the failed dynamic `import()`
/// into its JSON, so this signature can appear on stdout as well as stderr.
static MODULE_LOAD_FAILURE_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?i)cannot find (module|package)|err_module_not_found|err_package_path_not_exported")
    .unwrap()
});

/// True when a helper run failed because node couldn't resolve/load the auth
/// module graph (checked across stdout — the helper catches the import error into
/// its JSON — and stderr, for the uncaught case).
fn is_module_load_failure(res: &exec::RunResult) -> bool {
  MODULE_LOAD_FAILURE_RE.is_match(&res.stdout) || MODULE_LOAD_FAILURE_RE.is_match(&res.stderr)
}

/// Ordered auth-module candidates for account-level Fabric calls (workspaces,
/// reports, sign-in): the active project's local CLI first (when installed, to
/// honor its pinned version), then the global CLI as a fallback. Never installs.
/// The MSAL token cache is shared across installs, so every candidate reaches the
/// same signed-in session — retrying the global module simply routes around a
/// broken/partial project-local `node_modules` instead of surfacing a cryptic
/// "Cannot find module" to the user.
fn account_auth_modules() -> Vec<PathBuf> {
  let project_dir = store::active_project().map(|p| PathBuf::from(p.path));
  let local_ready = project_dir
    .as_deref()
    .is_some_and(exec::project_rayfin_cli_installed);
  let preferred = if local_ready { project_dir.as_deref() } else { None };

  let mut mods = Vec::new();
  if let Some(m) = exec::project_rayfin_auth_module(preferred) {
    mods.push(m);
  }
  if let Some(global) = exec::global_rayfin_auth_module() {
    if !mods.contains(&global) {
      mods.push(global);
    }
  }
  mods
}

/// Run a Fabric node helper against each candidate auth module until one loads,
/// returning that child's [`exec::RunResult`]. `base_args` are the argv *after*
/// the auth-module path. A candidate that only failed to load is skipped when a
/// later one remains; any other outcome (success, a real auth/API error, or
/// node-not-found) is returned as-is. Callers must pass a non-empty candidate list.
async fn run_fabric_helper(
  script_str: &str,
  base_args: &[&str],
  timeout_ms: u64,
  candidates: &[PathBuf],
) -> exec::RunResult {
  let n = candidates.len();
  let mut last: Option<exec::RunResult> = None;
  for (i, auth) in candidates.iter().enumerate() {
    let auth_str = auth.to_string_lossy().to_string();
    let mut argv: Vec<&str> = Vec::with_capacity(2 + base_args.len());
    argv.push(script_str);
    argv.push(&auth_str);
    argv.extend_from_slice(base_args);
    let res = exec::run("node", &argv, RunOptions::timeout(timeout_ms)).await;
    if i + 1 == n || res.not_found || !is_module_load_failure(&res) {
      return res;
    }
    last = Some(res);
  }
  last.unwrap_or(exec::RunResult {
    ok: false,
    exit_code: None,
    stdout: String::new(),
    stderr: "Could not locate the Rayfin CLI. Open a Rayfin project to reach Fabric.".to_string(),
    not_found: true,
  })
}

/// List the signed-in user's Fabric workspaces, each annotated with its
/// capacity SKU and whether that capacity is eligible to host a Rayfin app.
#[tauri::command]
pub async fn fabric_workspaces() -> FabricWorkspacesResult {
  let candidates = account_auth_modules();
  if candidates.is_empty() {
    return FabricWorkspacesResult {
      ok: false,
      workspaces: None,
      needs_login: None,
      error: Some(
        "Could not locate the Rayfin CLI. Open a Rayfin project to reach Fabric.".to_string(),
      ),
    };
  }

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

  let script_str = script_path.to_string_lossy().to_string();
  let res = run_fabric_helper(&script_str, &[FABRIC_API_BASE], 60_000, &candidates).await;

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

/// List the Power BI reports contained in a Fabric workspace so the user can
/// pick one to migrate. Mirrors `fabric_workspaces`, passing the workspace id
/// to the helper as an extra argv and sorting the result alphabetically.
#[tauri::command]
pub async fn fabric_reports(workspace_id: String) -> FabricReportsResult {
  let candidates = account_auth_modules();
  if candidates.is_empty() {
    return FabricReportsResult {
      ok: false,
      reports: None,
      needs_login: None,
      error: Some(
        "Could not locate the Rayfin CLI. Open a Rayfin project to reach Fabric.".to_string(),
      ),
    };
  }

  let script_path = match write_helper("fabric-reports.mjs", REPORTS_HELPER_SOURCE) {
    Ok(p) => p,
    Err(err) => {
      return FabricReportsResult {
        ok: false,
        reports: None,
        needs_login: None,
        error: Some(format!("Could not prepare the report lookup helper: {err}")),
      }
    }
  };

  let script_str = script_path.to_string_lossy().to_string();
  let res = run_fabric_helper(
    &script_str,
    &[FABRIC_API_BASE, &workspace_id],
    60_000,
    &candidates,
  )
  .await;

  if res.not_found {
    return FabricReportsResult {
      ok: false,
      reports: None,
      needs_login: None,
      error: Some("Node.js was not found on PATH.".to_string()),
    };
  }

  let out = res.stdout.trim();
  match serde_json::from_str::<FabricReportsResult>(out) {
    Ok(mut parsed) => {
      if parsed.ok {
        if let Some(reports) = parsed.reports.as_mut() {
          reports.sort_by(|a, b| {
            a.display_name
              .to_lowercase()
              .cmp(&b.display_name.to_lowercase())
          });
        }
      }
      parsed
    }
    Err(_) => {
      let (needs_login, err) = failure_error(&res, out);
      FabricReportsResult {
        ok: false,
        reports: None,
        needs_login: Some(needs_login),
        error: Some(err),
      }
    }
  }
}

/// Download a report's public definition (PBIR) into `<projectDir>/source-report`
/// so the agent can rebuild it, and resolve the id of the semantic model the
/// report is bound to (returned as `modelId`) so the caller can download the
/// model as a separate step. The node child follows the getDefinition LRO and
/// base64-decodes each part.
#[tauri::command]
pub async fn fabric_report_definition(
  workspace_id: String,
  report_id: String,
  project_dir: String,
) -> FabricReportDefinitionResult {
  fabric_definition_download("report", &workspace_id, &report_id, &project_dir, "source-report").await
}

/// Download a semantic model's definition (TMDL — where the DAX measures live)
/// into `<projectDir>/source-model`. `model_id` comes from a prior
/// `fabric_report_definition` call. Best-effort in the UI: a failure here (e.g. a
/// cross-workspace model) is surfaced but never blocks the report migration.
#[tauri::command]
pub async fn fabric_semantic_model_definition(
  workspace_id: String,
  model_id: String,
  project_dir: String,
) -> FabricReportDefinitionResult {
  fabric_definition_download("model", &workspace_id, &model_id, &project_dir, "source-model").await
}

/// Shared driver for the report/model getDefinition downloads. Runs the
/// mode-aware node helper, writing parts under `<projectDir>/<sub_dir>`.
async fn fabric_definition_download(
  mode: &str,
  workspace_id: &str,
  item_id: &str,
  project_dir: &str,
  sub_dir: &str,
) -> FabricReportDefinitionResult {
  let fail = |needs_login: Option<bool>, error: String| FabricReportDefinitionResult {
    ok: false,
    files: None,
    dir: None,
    model_id: None,
    needs_login,
    error: Some(error),
  };

  let project_path = PathBuf::from(project_dir);
  // Auth via the global CLI: the migrate flow only writes report/model files into
  // the project via `fs`, and the freshly-created project's deps aren't installed.
  // `project_auth_module` never installs, so this can't hang on `npm install`.
  let auth_path = match project_auth_module(None).await {
    Ok(p) => p,
    Err(error) => return fail(None, error),
  };

  let script_path = match write_helper("fabric-report-definition.mjs", DEFINITION_HELPER_SOURCE) {
    Ok(p) => p,
    Err(err) => return fail(None, format!("Could not prepare the definition helper: {err}")),
  };

  let dest_dir = project_path.join(sub_dir);
  let auth_str = auth_path.to_string_lossy().to_string();
  let script_str = script_path.to_string_lossy().to_string();
  let dest_str = dest_dir.to_string_lossy().to_string();
  let res = exec::run(
    "node",
    &[
      &script_str,
      &auth_str,
      FABRIC_API_BASE,
      mode,
      workspace_id,
      item_id,
      &dest_str,
    ],
    RunOptions::timeout(300_000),
  )
  .await;

  if res.not_found {
    return fail(None, "Node.js was not found on PATH.".to_string());
  }

  let out = res.stdout.trim();
  match serde_json::from_str::<FabricReportDefinitionResult>(out) {
    Ok(parsed) => {
      // Keep the downloaded reference definition out of git: it's a migrate-time
      // spec for the agent, not part of the app the user ships.
      if parsed.ok {
        ensure_gitignored(&project_path, &format!("{sub_dir}/"));
      }
      parsed
    }
    Err(_) => {
      let (needs_login, err) = failure_error(&res, out);
      fail(Some(needs_login), err)
    }
  }
}

/// Add `entry` to `<project_dir>/.gitignore` (creating the file if absent) unless
/// it is already ignored. The migrate flow downloads a report's PBIR into
/// `source-report/` and its model's TMDL into `source-model/` purely as a spec
/// for the rebuild agent; those folders (and the exported `report.pdf` inside
/// `source-report/`) must never be committed or bundled. Best-effort: any I/O
/// error is swallowed so a hiccup touching `.gitignore` can't fail a download.
fn ensure_gitignored(project_dir: &Path, entry: &str) {
  let path = project_dir.join(".gitignore");
  let existing = std::fs::read_to_string(&path).unwrap_or_default();
  let bare = entry.trim_end_matches('/');
  let already = existing
    .lines()
    .any(|l| l.trim() == entry || l.trim() == bare);
  if already {
    return;
  }
  const MARKER: &str = "# Fabricator migrate: downloaded source report/model (reference only)";
  let mut out = existing;
  if !out.is_empty() && !out.ends_with('\n') {
    out.push('\n');
  }
  if !out.contains(MARKER) {
    out.push('\n');
    out.push_str(MARKER);
    out.push('\n');
  }
  out.push_str(entry);
  out.push('\n');
  let _ = std::fs::write(&path, out);
}
/// REST API and write it to `<projectDir>/source-report/report.pdf`, returning it
/// base64-encoded so the renderer can rasterize each page into an image for the
/// migrate chat hand-off. Best-effort in the migrate flow: image export is
/// tenant-blocked on many tenants (so we export PDF), and PDF export needs a
/// capacity-backed workspace — a failure here is surfaced but never blocks the
/// migration. The ExportTo token comes from the signed-in Azure CLI (`az`), whose
/// first-party client is preauthorized for Power BI; the Rayfin CLI's own MSAL
/// token only carries Fabric scopes and is rejected by ExportTo with 401.
#[tauri::command]
pub async fn fabric_export_report_pdf(
  workspace_id: String,
  report_id: String,
  project_dir: String,
) -> FabricExportPdfResult {
  let fail = |needs_login: Option<bool>, error: String| FabricExportPdfResult {
    ok: false,
    pdf_path: None,
    pdf_base64: None,
    bytes: None,
    needs_login,
    error: Some(error),
  };

  let project_path = PathBuf::from(&project_dir);

  let script_path = match write_helper("fabric-export-pdf.mjs", EXPORT_PDF_HELPER_SOURCE) {
    Ok(p) => p,
    Err(err) => return fail(None, format!("Could not prepare the export helper: {err}")),
  };

  let dest = project_path.join("source-report").join("report.pdf");
  let script_str = script_path.to_string_lossy().to_string();
  let dest_str = dest.to_string_lossy().to_string();
  let res = exec::run(
    "node",
    &[
      &script_str,
      FABRIC_PBI_BASE,
      &workspace_id,
      &report_id,
      &dest_str,
    ],
    RunOptions::timeout(300_000),
  )
  .await;

  if res.not_found {
    return fail(None, "Node.js was not found on PATH.".to_string());
  }

  let out = res.stdout.trim();
  match serde_json::from_str::<FabricExportPdfResult>(out) {
    Ok(parsed) => parsed,
    Err(_) => {
      let (needs_login, err) = failure_error(&res, out);
      fail(Some(needs_login), err)
    }
  }
}

/// Node helper that opens the interactive Fabric sign-in / consent window so the
/// migrate flow can reach a signed-in session from the Home screen (where no
/// project is active and the CLI has no cached account). argv: <authModulePath>.
const SIGNIN_HELPER_SOURCE: &str = r#"// Keep stdout clean for the JSON result; route any library logging to stderr.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.debug = console.log
console.info = console.log

import { pathToFileURL } from 'node:url'

async function main() {
  const [authPath] = process.argv.slice(2)
  const auth = await import(pathToFileURL(authPath).href)
  const rf = await auth.getRayfinAuth()
  // Omit silentOnly so acquireToken falls back to an interactive browser login
  // when there's no cached account. Undefined scopes → the CLI's default Fabric
  // scope (read); the write scope is requested later, only when a report is
  // actually migrated.
  await rf.acquireToken(undefined, { silentOnly: false })
  process.stdout.write(JSON.stringify({ ok: true }))
}

main().catch((err) => {
  const msg = err && err.message ? String(err.message) : String(err)
  process.stdout.write(JSON.stringify({ ok: false, error: msg }))
})
"#;

/// Open the interactive Fabric sign-in window (silent when already signed in) so
/// the migrate-report flow can list workspaces from the Home screen. Uses the
/// active project's CLI when one is open, else the global `rayfin` install.
#[tauri::command]
pub async fn fabric_sign_in() -> FabricSignInResult {
  let candidates = account_auth_modules();
  if candidates.is_empty() {
    return FabricSignInResult {
      ok: false,
      error: Some(
        "Could not locate the Rayfin CLI. Open a Rayfin project to reach Fabric.".to_string(),
      ),
    };
  }

  let script_path = match write_helper("fabric-sign-in.mjs", SIGNIN_HELPER_SOURCE) {
    Ok(p) => p,
    Err(err) => {
      return FabricSignInResult {
        ok: false,
        error: Some(format!("Could not prepare the sign-in helper: {err}")),
      }
    }
  };

  let script_str = script_path.to_string_lossy().to_string();
  let res = run_fabric_helper(&script_str, &[], 300_000, &candidates).await;

  if res.not_found {
    return FabricSignInResult {
      ok: false,
      error: Some("Node.js was not found on PATH.".to_string()),
    };
  }

  let out = res.stdout.trim();
  match serde_json::from_str::<FabricSignInResult>(out) {
    Ok(parsed) => parsed,
    Err(_) => {
      let (_needs_login, err) = failure_error(&res, out);
      FabricSignInResult {
        ok: false,
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

  fn run_result(stdout: &str, stderr: &str) -> exec::RunResult {
    exec::RunResult {
      ok: false,
      exit_code: Some(1),
      stdout: stdout.to_string(),
      stderr: stderr.to_string(),
      not_found: false,
    }
  }

  #[test]
  fn module_load_failure_detected_on_stdout_and_stderr() {
    // The helper catches the failed dynamic import() into its JSON on stdout…
    let caught = run_result(
      r#"{"ok":false,"needsLogin":false,"error":"Cannot find module 'C:\\proj\\node_modules\\@azure\\msal-node\\dist\\index.mjs' imported from rayfin-auth.js"}"#,
      "",
    );
    assert!(is_module_load_failure(&caught));

    // …or, when uncaught, node writes ERR_MODULE_NOT_FOUND to stderr.
    let uncaught = run_result("", "node:internal/errors ... [ERR_MODULE_NOT_FOUND]: Cannot find package");
    assert!(is_module_load_failure(&uncaught));
  }

  #[test]
  fn real_auth_failure_is_not_a_module_load_failure() {
    // A genuine "no cached account" must NOT be mistaken for a broken CLI, so we
    // don't needlessly retry the global module (and hide a real login prompt).
    let login = run_result(r#"{"ok":false,"needsLogin":true,"error":"no cached account"}"#, "");
    assert!(!is_module_load_failure(&login));
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
  fn definition_helper_resolves_all_model_id_forms() {
    // resolveModelId must cover every place the bound dataset GUID can appear,
    // including the modern PBIR v4 `byConnection` connection string where the id
    // is a `semanticmodelid=` param (and `initial catalog=` is the model *name*).
    assert!(DEFINITION_HELPER_SOURCE.contains("function resolveModelId"));
    assert!(DEFINITION_HELPER_SOURCE.contains("semanticmodelid"));
    assert!(DEFINITION_HELPER_SOURCE.contains("pbiModelDatabaseName"));
    assert!(DEFINITION_HELPER_SOURCE.contains("Initial Catalog="));
    assert!(DEFINITION_HELPER_SOURCE.contains("datasetId"));
  }

  #[test]
  fn export_pdf_helper_uses_powerbi_export_to_pdf() {
    // The migrate "capture pages" sub-step exports a PDF (image export is
    // tenant-blocked on many tenants) via the Power BI ExportTo API, polls the
    // long-running op, and returns the file base64 for renderer rasterization.
    // The ExportTo token is minted via `az` (the Rayfin CLI's MSAL token only
    // carries Fabric scopes and is rejected by ExportTo with 401).
    assert!(EXPORT_PDF_HELPER_SOURCE.contains("account', 'get-access-token"));
    assert!(EXPORT_PDF_HELPER_SOURCE.contains("analysis.windows.net/powerbi/api"));
    assert!(!EXPORT_PDF_HELPER_SOURCE.contains("getRayfinAuth"));
    assert!(EXPORT_PDF_HELPER_SOURCE.contains("/ExportTo"));
    assert!(EXPORT_PDF_HELPER_SOURCE.contains("format: 'PDF'"));
    assert!(EXPORT_PDF_HELPER_SOURCE.contains("Succeeded"));
    assert!(EXPORT_PDF_HELPER_SOURCE.contains("pdfBase64"));
    // Power BI-audience base, distinct from the Fabric API base.
    assert_eq!(FABRIC_PBI_BASE, "https://api.powerbi.com/v1.0/myorg");
  }

  #[test]
  fn ensure_gitignored_appends_once_and_is_idempotent() {
    let dir = std::env::temp_dir().join(format!("fab-gi-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let gi = dir.join(".gitignore");
    std::fs::write(&gi, "node_modules\ndist\n").unwrap();

    ensure_gitignored(&dir, "source-report/");
    ensure_gitignored(&dir, "source-model/");
    // Repeat calls (and the bare form) must not duplicate entries.
    ensure_gitignored(&dir, "source-report/");
    ensure_gitignored(&dir, "source-model");

    let body = std::fs::read_to_string(&gi).unwrap();
    assert_eq!(body.matches("source-report/").count(), 1, "report ignore once");
    assert_eq!(body.matches("source-model/").count(), 1, "model ignore once");
    assert!(body.contains("node_modules"), "preserves existing entries");

    // Creates the file when absent.
    let dir2 = dir.join("nested");
    std::fs::create_dir_all(&dir2).unwrap();
    ensure_gitignored(&dir2, "source-report/");
    assert!(std::fs::read_to_string(dir2.join(".gitignore")).unwrap().contains("source-report/"));

    let _ = std::fs::remove_dir_all(&dir);
  }
}
