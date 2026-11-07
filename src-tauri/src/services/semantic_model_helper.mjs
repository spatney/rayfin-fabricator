// Semantic-model helper for Fabricator: reads a semantic model's schema for the
// Model tab, and lists the semantic models or the data in a workspace for the
// pickers. Report migrations import its model and link helpers too.
//
// Reuses the globally-installed Rayfin CLI's MSAL token cache (the same approach
// as src-tauri/src/commands/fabric.rs) to mint Fabric tokens silently; schema
// reads use the Azure CLI's Fabric token.
//
// argv: <authModulePath> <requestJson>
//   requestJson (schema):              {"mode":"schema","workspaceId":"<ws>","itemId":"<model>"}
//   requestJson (listWorkspaceModels): {"mode":"listWorkspaceModels","workspaceId":"<ws>"}
//   requestJson (listWorkspaceData):   {"mode":"listWorkspaceData","workspaceId":"<ws>"}
//
// Writes exactly one JSON line to stdout; all library logging is routed to stderr.

import {
  makeRayfinTokens as makeTokens, azToken, makeApi, apiUrl,
  fetchAllPages, checkAuthentication, isMain, runHelper,
} from './fabric_auth_helper.mjs'

const FABRIC_RESOURCE = 'https://api.fabric.microsoft.com'
const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

// ── Input parsing ─────────────────────────────────────────────────────────--
export function parseTarget(value) {
  const v = String(value || '').trim()
  const res = { kind: null, id: null, workspace: null, appReport: null }

  const ws = v.match(new RegExp('/groups/(' + GUID + ')'))
  if (ws) res.workspace = ws[1]

  // Apps take precedence: an app-report URL contains both /apps/ and /reports/.
  const app = v.match(new RegExp('/apps/(' + GUID + ')')) || v.match(new RegExp('[?&]appId=(' + GUID + ')'))
  if (app) {
    res.kind = 'app'
    res.id = app[1]
    const rep = v.match(new RegExp('/reports/(' + GUID + ')'))
    if (rep) res.appReport = rep[1]
    return res
  }

  const pats = [
    // Semantic-model editor / modeling view: .../modeling/{model}/modelView,
    // .../me/modeling/{model}, .../datasets/{model}/details — all point at a model.
    ['dataset', '/modeling/(' + GUID + ')'],
    ['dataset', '/datasets/(' + GUID + ')'],
    ['dataset', '[?&]datasetId=(' + GUID + ')'],
    ['report', '/reports/(' + GUID + ')'],
    ['report', '[?&]reportId=(' + GUID + ')'],
    ['dashboard', '/dashboards/(' + GUID + ')'],
  ]
  for (const [kind, pat] of pats) {
    const m = v.match(new RegExp(pat))
    if (m) { res.kind = kind; res.id = m[1]; return res }
  }

  // Bare-GUID fallback: take the first GUID that isn't the workspace id, so a
  // /groups/{ws} prefix never gets mistaken for the model/report target.
  const all = v.match(new RegExp(GUID, 'g')) || []
  const id = all.find((g) => g !== res.workspace) || all[0]
  if (id) res.id = id
  return res
}

// ── Semantic-model schema (design-time model diagram) ──────────────────────--
// The model diagram is sourced from the model's *definition* — tables, columns,
// measures WITH their DAX, and relationships — returned by the Fabric
// item-definition API in TMSL (the `model.bim` JSON). We deliberately do NOT use
// the Power BI `executeQueries` INFO.VIEW.* path: that endpoint masks measure DAX
// (INFO.VIEW.MEASURES() returns Expression = null) and blocks INFO.MEASURES()
// outright, so TMSL is the only authoritative source for expressions. The call is
// authorized with the Azure CLI **Fabric** token;
// getDefinition needs read-write on the model, which an app author has.

// A TMSL string property is either a single string or an array of lines (a
// multi-line DAX expression or description). Fold it to one string; '' → null.
function tmslText(v) {
  if (v === undefined || v === null) return null
  const s = Array.isArray(v) ? v.join('\n') : String(v)
  return s === '' ? null : s
}
const tmslBool = (v) => v === true

// Fold a parsed `model.bim` `model` node into the flat friendly schema the Rust
// layer + renderer consume. Pure — exercised by `--selftest` without any network.
export function normalizeTmsl(model) {
  const tables = Array.isArray(model && model.tables) ? model.tables : []
  const outTables = []
  const outColumns = []
  const outMeasures = []
  for (const t of tables) {
    if (!t || !t.name) continue
    outTables.push({
      name: t.name,
      description: tmslText(t.description),
      isHidden: tmslBool(t.isHidden),
      storageMode: null,
    })
    for (const c of t.columns || []) {
      if (!c || !c.name) continue
      // Skip the auto-generated RowNumber system columns — pure diagram noise.
      if (String(c.type || '').toLowerCase() === 'rownumber') continue
      outColumns.push({
        table: t.name,
        name: c.name,
        dataType: c.dataType ?? null,
        isHidden: tmslBool(c.isHidden),
        isKey: tmslBool(c.isKey),
        dataCategory: c.dataCategory ?? null,
        formatString: c.formatString ?? null,
        displayFolder: c.displayFolder ?? null,
        // Present for calculated columns.
        expression: tmslText(c.expression),
      })
    }
    for (const m of t.measures || []) {
      if (!m || !m.name) continue
      outMeasures.push({
        table: t.name,
        name: m.name,
        expression: tmslText(m.expression),
        dataType: m.dataType ?? null,
        formatString: m.formatString ?? null,
        displayFolder: m.displayFolder ?? null,
        description: tmslText(m.description),
        isHidden: tmslBool(m.isHidden),
      })
    }
  }
  const outRels = []
  for (const r of (model && model.relationships) || []) {
    if (!r || !r.fromTable || !r.toTable) continue
    outRels.push({
      name: r.name ?? null,
      fromTable: r.fromTable,
      fromColumn: r.fromColumn ?? null,
      toTable: r.toTable,
      toColumn: r.toColumn ?? null,
      // TMSL omits the defaults of a strong relationship: many(from) → one(to),
      // single-direction cross-filter, active. Read explicit overrides if set.
      fromCardinality: r.fromCardinality ?? 'many',
      toCardinality: r.toCardinality ?? 'one',
      isActive: r.isActive !== false,
      crossFilter: r.crossFilteringBehavior ?? 'oneDirection',
    })
  }
  return { tables: outTables, columns: outColumns, measures: outMeasures, relationships: outRels }
}

// The Fabric API root (`.../v1`), overridable for non-prod via RAYFIN_FABRIC_API_URL.
function fabricApiBase() {
  return (process.env.RAYFIN_FABRIC_API_URL || 'https://api.fabric.microsoft.com/v1').trim().replace(/\/$/, '')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Best-effort human-readable message from a Fabric error body.
function fabricError(status, body) {
  const e = body && (body.error || body)
  const msg = e && (e.message || e.code)
  return msg ? String(msg) : `Fabric getDefinition failed (HTTP ${status}).`
}

// POST `getDefinition?format=TMSL`, follow the long-running-operation poll, and
// return the parsed `model.bim` `model` node. A 401 means the `az` token was
// rejected → NeedsAz; a 403 means the caller lacks write access to the model.
export async function fetchModelBim(token, wsId, dsId) {
  const headers = { Authorization: 'Bearer ' + token }
  const base = fabricApiBase()
  async function request(url, method = 'GET') {
    const response = await fetch(apiUrl(url, base), {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
    checkAuthentication(response, 'az')
    return response
  }
  const url = `${base}/workspaces/${wsId}/semanticModels/${dsId}/getDefinition?format=TMSL`
  let r = await request(url, 'POST')
  if (r.status === 202) {
    const loc = r.headers.get('location')
    if (!loc) throw new Error('getDefinition was accepted but returned no polling URL.')
    const pollUrl = apiUrl(loc, base)
    const deadline = Date.now() + 100000
    for (;;) {
      if (Date.now() > deadline) throw new Error('Timed out reading the semantic model definition.')
      await sleep(1500)
      const pr = await request(pollUrl)
      if (pr.status === 403) throw new Error('You need edit (write) access to this semantic model to read its definition.')
      if (pr.status >= 400 && pr.status < 500 && pr.status !== 429) {
        throw new Error(fabricError(pr.status, await pr.json().catch(() => null)))
      }
      if (pr.status !== 200) continue
      let st = {}
      try { st = await pr.json() } catch { st = {} }
      const state = String(st.status || '').toLowerCase()
      if (state === 'succeeded') {
        const resultUrl = new URL(pollUrl)
        resultUrl.pathname = resultUrl.pathname.replace(/\/$/, '') + '/result'
        r = await request(resultUrl.href)
        break
      }
      if (state === 'failed') throw new Error(fabricError(pr.status, st))
    }
  }
  if (r.status === 403) throw new Error('You need edit (write) access to this semantic model to read its definition.')
  if (r.status !== 200) {
    let body = null
    try { body = await r.json() } catch { /* non-JSON error body */ }
    throw new Error(fabricError(r.status, body))
  }
  const body = await r.json()
  const parts = (body.definition && body.definition.parts) || []
  const part =
    parts.find((p) => /(^|\/)model\.bim$/i.test(p.path || '')) ||
    parts.find((p) => /\.bim$/i.test(p.path || ''))
  if (!part || !part.payload) throw new Error('The model definition did not include a model.bim payload.')
  const parsed = JSON.parse(Buffer.from(part.payload, 'base64').toString('utf8'))
  return parsed.model || parsed
}

async function runSchema(_token, req) {
  const wsId = String(req.workspaceId || req.workspace || '').trim() || null
  const dsId = String(req.itemId || req.datasetId || req.target || '').trim()
  if (!dsId) return { ok: false, error: 'A semantic model itemId (dataset id) is required.' }
  if (!wsId) return { ok: false, error: 'A workspaceId is required to read the model definition.' }
  // getDefinition is authorized with the Azure CLI Fabric token (see the schema-
  // section note above), not the Rayfin MSAL token.
  const token = await azToken(FABRIC_RESOURCE)
  const model = await fetchModelBim(token, wsId, dsId)
  const schema = normalizeTmsl(model)
  return { ok: true, matched: schema.tables.length > 0, workspaceId: wsId, itemId: dsId, ...schema, notes: [] }
}

// The Fabric REST endpoint listing a workspace's semantic models. Pure — covered
// by --selftest.
function workspaceModelsUrl(workspaceId) {
  return `${FABRIC_RESOURCE}/v1/workspaces/${String(workspaceId || '').trim()}/semanticModels`
}

// List the semantic models in a workspace, for the "connect a model from your
// workspace" picker. Uses the Fabric REST API with the silent *Fabric* token (the
// same token the workspace picker uses) — the Rayfin app can't mint the Power BI
// scope silently, so a signed-in user was wrongly told to re-auth. Follows the
// Fabric 100/page continuation the same way the workspace list does.
export async function runListWorkspaceModels(token, req) {
  const wsId = String(req.workspaceId || req.workspace || '').trim()
  if (!wsId) return { ok: false, error: 'A workspaceId is required.' }
  const fabric = makeApi(await token(), FABRIC_RESOURCE) // default scopes → Fabric token
  const start = workspaceModelsUrl(wsId)
  const items = await fetchAllPages(fabric, start, { label: 'Fabric semantic models request' })
  const models = items
    .map((d) => ({ id: d.id, name: d.displayName || d.name }))
    .filter((m) => m.id)
  models.sort((a, b) => String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase()))
  return { ok: true, models }
}

// The Fabric item types a Rayfin connector reads (`rayfin connector types`
// lists them as each type's discoverable item type): semantic models,
// warehouses, SQL databases, and lakehouses (through their SQL analytics endpoint).
export const DATA_ITEM_TYPES = ['SemanticModel', 'Warehouse', 'SQLDatabase', 'Lakehouse']

// The Fabric REST endpoint listing a workspace's items. Pure — covered by --selftest.
function workspaceItemsUrl(workspaceId) {
  return `${FABRIC_RESOURCE}/v1/workspaces/${String(workspaceId || '').trim()}/items`
}

// The items a Rayfin connector can read, by name. Pure — covered by --selftest.
export function dataItems(items) {
  return (items || [])
    .filter((d) => d && d.id && DATA_ITEM_TYPES.includes(d.type))
    .map((d) => ({
      id: String(d.id),
      name: String(d.displayName || d.name || d.id),
      type: d.type,
      ...(d.description ? { description: String(d.description) } : {}),
    }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

// List the data in a workspace that the app can connect to, for the "Add Fabric
// data" picker: every item of a type a Rayfin connector reads. Any workspace the
// signed-in user can open works, not only the one the app deploys to.
export async function runListWorkspaceData(token, req) {
  const wsId = String(req.workspaceId || req.workspace || '').trim()
  if (!new RegExp('^' + GUID + '$').test(wsId)) return { ok: false, error: 'A workspace id is required.' }
  const fabric = makeApi(await token(), FABRIC_RESOURCE) // default scopes → Fabric token
  const items = await fetchAllPages(fabric, workspaceItemsUrl(wsId), { label: 'Fabric items request' })
  return { ok: true, items: dataItems(items) }
}

// ── Entry ─────────────────────────────────────────────────────────────────--
// Pure-function self-test for parseTarget + schema normalization — no
// auth/network. Run with `node semantic_model_helper.mjs --selftest`. Exits
// non-zero on first failure.
function selftest() {
  const cases = [
    ['https://msit.powerbi.com/groups/ea3779f7-4d16-4fbc-87ba-f501e2a6fdee/modeling/92a63060-dcef-4d6b-ac2f-cdd1bae79b43/modelView?experience=power-bi&subfolderId=228083',
      { kind: 'dataset', id: '92a63060-dcef-4d6b-ac2f-cdd1bae79b43', workspace: 'ea3779f7-4d16-4fbc-87ba-f501e2a6fdee' }],
    ['https://app.powerbi.com/groups/ea3779f7-4d16-4fbc-87ba-f501e2a6fdee/datasets/92a63060-dcef-4d6b-ac2f-cdd1bae79b43/details',
      { kind: 'dataset', id: '92a63060-dcef-4d6b-ac2f-cdd1bae79b43', workspace: 'ea3779f7-4d16-4fbc-87ba-f501e2a6fdee' }],
    ['https://app.powerbi.com/groups/ea3779f7-4d16-4fbc-87ba-f501e2a6fdee/reports/92a63060-dcef-4d6b-ac2f-cdd1bae79b43/ReportSection',
      { kind: 'report', id: '92a63060-dcef-4d6b-ac2f-cdd1bae79b43', workspace: 'ea3779f7-4d16-4fbc-87ba-f501e2a6fdee' }],
    ['https://app.powerbi.com/apps/aaaaaaaa-1111-2222-3333-444444444444/reports/bbbbbbbb-1111-2222-3333-444444444444/x',
      { kind: 'app', id: 'aaaaaaaa-1111-2222-3333-444444444444', appReport: 'bbbbbbbb-1111-2222-3333-444444444444' }],
    ['92a63060-dcef-4d6b-ac2f-cdd1bae79b43', { kind: null, id: '92a63060-dcef-4d6b-ac2f-cdd1bae79b43' }],
  ]
  let failed = 0
  for (const [input, want] of cases) {
    const got = parseTarget(input)
    for (const k of Object.keys(want)) {
      if (got[k] !== want[k]) { failed++; process.stderr.write(`FAIL ${k}: want ${want[k]} got ${got[k]}\n  ${input}\n`) }
    }
  }

  // TMSL normalization (pure) — guards the `model.bim` → friendly-schema mapping:
  // string|array expressions, RowNumber system-column skipping, and the implicit
  // relationship defaults (many→one, single cross-filter, active).
  const s = normalizeTmsl({
    tables: [
      {
        name: 'Sales',
        isHidden: false,
        columns: [
          { name: 'RowNumber-abc', type: 'rowNumber', dataType: 'int64' },
          { name: 'Amount', dataType: 'decimal', isKey: false },
          { name: 'Margin', dataType: 'double', expression: ['VAR x = 1', 'RETURN x'] },
        ],
        measures: [{ name: 'Total', expression: 'SUM ( Sales[Amount] )', formatString: '#,0' }],
      },
      { name: 'Date', isHidden: true, columns: [{ name: 'DateKey', dataType: 'int64', isKey: true }] },
    ],
    relationships: [
      { name: 'Sales_Date', fromTable: 'Sales', fromColumn: 'DateKey', toTable: 'Date', toColumn: 'DateKey' },
      {
        name: 'inactive',
        fromTable: 'Sales', fromColumn: 'X', toTable: 'Date', toColumn: 'Y',
        isActive: false, crossFilteringBehavior: 'bothDirections',
      },
    ],
  })
  const assert = (cond, msg) => { if (!cond) { failed++; process.stderr.write(`FAIL schema ${msg}\n`) } }
  assert(s.tables.length === 2 && s.tables[0].name === 'Sales' && s.tables[1].isHidden === true, 'tables')
  // RowNumber column skipped → Sales keeps Amount + Margin, Date keeps DateKey.
  assert(s.columns.length === 3 && !s.columns.some((c) => /rowNumber/i.test(c.name)), 'rowNumber skipped')
  assert(s.columns.find((c) => c.name === 'Margin')?.expression === 'VAR x = 1\nRETURN x', 'calc column expr')
  assert(s.measures.length === 1 && s.measures[0].expression === 'SUM ( Sales[Amount] )', 'measure expr')
  assert(
    s.relationships[0].fromCardinality === 'many' && s.relationships[0].toCardinality === 'one' &&
      s.relationships[0].crossFilter === 'oneDirection' && s.relationships[0].isActive === true,
    'relationship defaults',
  )
  assert(s.relationships[1].isActive === false && s.relationships[1].crossFilter === 'bothDirections', 'relationship overrides')

  // Workspace semantic-models endpoint (Fabric REST).
  assert(workspaceModelsUrl('ea3779f7-4d16-4fbc-87ba-f501e2a6fdee') === 'https://api.fabric.microsoft.com/v1/workspaces/ea3779f7-4d16-4fbc-87ba-f501e2a6fdee/semanticModels', 'workspace models url')

  // Workspace data: the items a Rayfin connector reads, by name; the rest (a
  // lakehouse's own SQL endpoint, reports, notebooks) left out.
  assert(workspaceItemsUrl('ea3779f7-4d16-4fbc-87ba-f501e2a6fdee') === 'https://api.fabric.microsoft.com/v1/workspaces/ea3779f7-4d16-4fbc-87ba-f501e2a6fdee/items', 'workspace items url')
  const data = dataItems([
    { id: 'r1', type: 'Report', displayName: 'Sales report' },
    { id: 'l1', type: 'Lakehouse', displayName: 'orders', description: 'Raw orders' },
    { id: 'e1', type: 'SQLEndpoint', displayName: 'orders' },
    { id: 'w1', type: 'Warehouse', displayName: 'Inventory' },
    { id: 'm1', type: 'SemanticModel', displayName: 'Sales' },
    { id: 'd1', type: 'SQLDatabase', displayName: 'crm' },
    { id: 'k1', type: 'KQLDatabase', displayName: 'telemetry' },
    { type: 'Warehouse', displayName: 'no id' },
  ])
  assert(JSON.stringify(data.map((d) => d.id)) === '["d1","w1","l1","m1"]', 'data items by name: ' + JSON.stringify(data))
  assert(data[2].type === 'Lakehouse' && data[2].description === 'Raw orders' && data[0].description === undefined, 'data item fields')

  if (failed) { process.stderr.write(`${failed} selftest assertion(s) failed\n`); process.exit(1) }
  process.stderr.write('semantic-model selftest ok\n')
  process.exit(0)
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest()
  const [authPath, reqJson] = process.argv.slice(2)
  if (!authPath || !reqJson) throw new Error('usage: <authModulePath> <requestJson>')
  const req = JSON.parse(reqJson)
  // Schema reads only need Azure. Do not initialize Rayfin/MSAL until a mode
  // actually requests one of its tokens.
  let tokens
  const token = async (scopes) => {
    tokens ||= makeTokens(authPath)
    return (await tokens)(scopes)
  }
  if (req.mode === 'schema') return runSchema(token, req)
  if (req.mode === 'listWorkspaceModels') return runListWorkspaceModels(token, req)
  if (req.mode === 'listWorkspaceData') return runListWorkspaceData(token, req)
  throw new Error(`Unknown semantic-model helper mode: ${req.mode}`)
}

if (isMain(import.meta.url)) runHelper(main)
