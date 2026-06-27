// Semantic-model locator/search helper for Rayfin Fabricator.
//
// Reuses the globally-installed Rayfin CLI's MSAL token cache (the same approach
// as src-tauri/src/commands/fabric.rs) to mint Fabric + Power BI tokens silently,
// then either (a) locates the semantic model behind a Power BI report/app/dataset
// id or URL, or (b) searches the Fabric OneLake catalog by description and resolves
// matches to their semantic model(s).
//
// argv: <authModulePath> <requestJson>
//   requestJson (locate): {"mode":"locate","target":"<guid|url>","workspace"?:"<ws>","admin"?:false}
//   requestJson (search): {"mode":"search","query":"<text>","types"?:["report","model"],"limit"?:30,"noResolve"?:false}
//
// Writes exactly one JSON line to stdout; all library logging is routed to stderr.

// Keep stdout clean for the JSON result; route any library logging to stderr.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.debug = console.log
console.info = console.log
console.warn = console.log

import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'

const PBI_SCOPES = ['https://analysis.windows.net/powerbi/api/.default']
const FABRIC_RESOURCE = 'https://api.fabric.microsoft.com'
const PBI_BASE = 'https://api.powerbi.com/v1.0/myorg'
const CATALOG_SEARCH = 'https://api.fabric.microsoft.com/v1/catalog/search'
const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const GUID_RE = new RegExp(GUID)

const TYPE_ALIASES = {
  report: 'Report',
  model: 'SemanticModel', semanticmodel: 'SemanticModel', dataset: 'SemanticModel',
  lakehouse: 'Lakehouse', warehouse: 'Warehouse', notebook: 'Notebook',
}
const DEFAULT_TYPES = ['Report', 'SemanticModel']

// ── Auth ────────────────────────────────────────────────────────────────────
class NeedsLogin extends Error {}
class NeedsAz extends Error {}

async function makeTokens(authPath) {
  const auth = await import(pathToFileURL(authPath).href)
  const rf = await auth.getRayfinAuth()
  const cache = {}
  return async function token(scopes) {
    const key = scopes.join(' ')
    if (cache[key]) return cache[key]
    let res
    try {
      // silentOnly: never pop a browser — fail fast if there's no cached session.
      res = await rf.acquireToken(scopes, { silentOnly: true })
    } catch (e) {
      throw new NeedsLogin(String((e && e.message) || e))
    }
    cache[key] = res.token
    return res.token
  }
}

// The Fabric OneLake catalog search endpoint requires the delegated
// `Catalog.Read.All` scope, which the Rayfin CLI app registration is not
// preauthorized for (so MSAL cannot mint it silently). The Azure CLI's
// first-party client *is* preauthorized, and `az` is a required, signed-in tool
// in Fabricator — so the catalog token comes from `az` (or a pre-supplied
// FABRIC_CATALOG_TOKEN env var). Power BI calls still use the MSAL token.
function azToken(resource) {
  return new Promise((resolve, reject) => {
    const args = ['account', 'get-access-token', '--resource', resource, '--query', 'accessToken', '-o', 'tsv']
    // `az` is `az.cmd` on Windows; invoke through cmd.exe so we don't need
    // shell:true (which Node deprecates when args are passed as an array).
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

async function fabricCatalogToken() {
  const env = (process.env.FABRIC_CATALOG_TOKEN || '').trim()
  if (env) return env
  return azToken(FABRIC_RESOURCE)
}

// ── HTTP ──────────────────────────────────────────────────────────────────--
function makeApi(token, base = '') {
  const headers = { Authorization: 'Bearer ' + token }
  async function req(method, url, bodyObj) {
    const full = url.startsWith('http') ? url : base + url
    for (let attempt = 0; attempt < 4; attempt++) {
      let r
      try {
        r = await fetch(full, {
          method,
          headers: bodyObj ? { ...headers, 'Content-Type': 'application/json' } : headers,
          body: bodyObj ? JSON.stringify(bodyObj) : undefined,
        })
      } catch (e) {
        return [0, { error: String((e && e.message) || e) }]
      }
      if (r.status === 429 && attempt < 3) {
        const wait = Math.min(parseInt(r.headers.get('retry-after') || '5', 10) || 5, 30)
        await new Promise((res) => setTimeout(res, wait * 1000))
        continue
      }
      const ct = r.headers.get('content-type') || ''
      let body = null
      if (ct.includes('application/json')) body = await r.json().catch(() => null)
      return [r.status, body]
    }
    return [429, null]
  }
  return {
    get: (url) => req('GET', url),
    post: (url, body) => req('POST', url, body),
  }
}

// Probe a per-item endpoint across many items; resolve to the first hit. Stops
// assigning new work once a hit is found (bounded overhang of `workers` requests).
async function parallelFind(items, probe, workers = 24) {
  let idx = 0
  let found = null
  async function worker() {
    while (idx < items.length && !found) {
      const it = items[idx++]
      const hit = await probe(it)
      if (hit && !found) found = hit
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker))
  return found
}

// ── Input parsing ─────────────────────────────────────────────────────────--
function parseTarget(value) {
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

  const g = v.match(GUID_RE)
  if (g) res.id = g[0]
  return res
}

// ── Model helpers ─────────────────────────────────────────────────────────--
function modelObj(ds, wsId, wsName) {
  let web = ds.webUrl
  if (!web && ds.id) {
    const grp = wsId || 'me'
    web = `https://app.powerbi.com/groups/${grp}/datasets/${ds.id}`
  }
  const xmla = wsName && wsName !== 'My workspace'
    ? `powerbi://api.powerbi.com/v1.0/myorg/${wsName}`
    : null
  return {
    name: ds.name,
    id: ds.id,
    // A Power BI datasetId IS the Fabric semantic-model itemId — surface it so
    // callers can wire it directly with `fabric-app-data add -w <ws> -i <item>`.
    itemId: ds.id,
    workspaceId: wsId,
    workspaceName: wsName,
    owner: ds.configuredBy,
    isRefreshable: ds.isRefreshable,
    webUrl: web,
    xmlaEndpoint: xmla,
  }
}

async function workspaceIndex(pbi) {
  const [s, j] = await pbi.get('/groups?$top=5000')
  const wss = s === 200 && j ? (j.value || []) : []
  const names = {}
  for (const w of wss) names[w.id] = w.name
  return { wss, names }
}

async function resolveModel(pbi, dsId, dsWs, dsWsName, wss, names) {
  if (!dsId) return null
  const paths = []
  if (dsWs) paths.push([dsWs, dsWsName, `/groups/${dsWs}/datasets/${dsId}`])
  paths.push([null, 'My workspace', `/datasets/${dsId}`])
  for (const [wid, wname, path] of paths) {
    const [s, j] = await pbi.get(path)
    if (s === 200 && j && j.id) return modelObj(j, wid, wname)
  }
  const hit = await parallelFind(wss, async (w) => {
    const [s, j] = await pbi.get(`/groups/${w.id}/datasets/${dsId}`)
    return s === 200 && j && j.id ? { ws: w, j } : null
  })
  if (hit) return modelObj(hit.j, hit.ws.id, hit.ws.name)
  // Final fallback: admin endpoint (a harmless 401 for non-admins).
  const [s, j] = await pbi.get(`/admin/datasets?$filter=id eq '${dsId}'`)
  if (s === 200 && j && j.value && j.value.length) {
    const d = j.value[0]
    const wsid = d.workspaceId || dsWs
    return modelObj(d, wsid, names[wsid] || dsWsName)
  }
  return null
}

// ── Locators ────────────────────────────────────────────────────────────────
async function adminReport(pbi, reportId, names) {
  const [s, j] = await pbi.get(`/admin/reports?$filter=id eq '${reportId}'`)
  if (s === 200 && j && j.value && j.value.length) {
    const rep = j.value[0]
    const wsid = rep.workspaceId
    return { rep, wsid, wsname: names[wsid] }
  }
  return { rep: null, wsid: null, wsname: null }
}

async function locateReport(pbi, reportId, wss, names, wsHint, admin) {
  let rep = null
  let hostId = null
  let hostName = null
  const notes = []

  if (wsHint) {
    const [s, j] = await pbi.get(`/groups/${wsHint}/reports/${reportId}`)
    if (s === 200 && j && j.id) { rep = j; hostId = wsHint; hostName = names[wsHint] || wsHint }
  }
  if (!rep && admin) {
    const a = await adminReport(pbi, reportId, names)
    rep = a.rep; hostId = a.wsid; hostName = a.wsname
  }
  if (!rep) { // My Workspace fast path (resolves any report the user can access)
    const [s, j] = await pbi.get(`/reports/${reportId}`)
    if (s === 200 && j && j.id) { rep = j; hostId = null; hostName = 'My workspace' }
  }
  if (!rep) { // parallel scan of every workspace the caller belongs to
    const hit = await parallelFind(wss, async (w) => {
      const [s, j] = await pbi.get(`/groups/${w.id}/reports/${reportId}`)
      return s === 200 && j && j.id ? { ws: w, j } : null
    })
    if (hit) { rep = hit.j; hostId = hit.ws.id; hostName = hit.ws.name }
  }
  if (!rep && !admin) { // last resort: admin API (works only for admins)
    const a = await adminReport(pbi, reportId, names)
    rep = a.rep; hostId = a.wsid; hostName = a.wsname
  }
  if (!rep) return null

  const dsWs = rep.datasetWorkspaceId || hostId
  const model = await resolveModel(pbi, rep.datasetId, dsWs, dsWs ? names[dsWs] : null, wss, names)
  if (rep.datasetId && !model) {
    notes.push(`Report references dataset ${rep.datasetId} but it could not be read ` +
      '(no access to its workspace). Try requesting access or admin rights.')
  }
  return {
    report: { id: rep.id, name: rep.name, workspaceId: hostId, workspaceName: hostName, webUrl: rep.webUrl },
    app: null,
    models: model ? [model] : [],
    notes,
  }
}

async function locateApp(pbi, appId, wss, names, appReport) {
  const [s0, app] = await pbi.get(`/apps/${appId}`)
  if (s0 !== 200 || !app) return null
  const wsId = app.workspaceId
  const wsName = names[wsId]
  const member = wss.some((w) => w.id === wsId)
  const notes = []
  const models = []

  const [, arepsRaw] = await pbi.get(`/apps/${appId}/reports`)
  const areps = arepsRaw ? (arepsRaw.value || []) : []

  let datasets = []
  if (member) {
    const [s, j] = await pbi.get(`/groups/${wsId}/datasets`)
    datasets = s === 200 && j ? (j.value || []) : []
  } else {
    const [s, j] = await pbi.get(`/admin/groups/${wsId}/datasets`)
    if (s === 200 && j) { datasets = j.value || []; notes.push('Models resolved via admin API.') }
  }
  for (const d of datasets) models.push(modelObj(d, wsId, wsName || names[wsId]))

  if (!datasets.length) {
    notes.push(`App '${app.name}' is published from workspace ${wsId}` +
      (wsName ? ` ('${wsName}')` : '') +
      `. You are a consumer (not a workspace member), and app reports do not expose datasetId ` +
      `in consumer context, so the ${areps.length} model(s) cannot be enumerated. ` +
      'Request access to that workspace, or re-run with Fabric admin rights.')
  }

  // Pinpoint a specific in-app report when one was supplied. The report GUID in
  // an app URL (.../apps/{id}/reports/{guid}) is the source-workspace report id,
  // i.e. the app report's originalReportObjectId (not its id).
  let highlight = null
  if (appReport) {
    const match = areps.find((r) => r.originalReportObjectId === appReport || r.id === appReport)
    if (match) {
      const orig = match.originalReportObjectId
      if (member && orig) {
        const [, wrepsRaw] = await pbi.get(`/groups/${wsId}/reports`)
        const wreps = wrepsRaw ? (wrepsRaw.value || []) : []
        const wrep = wreps.find((r) => r.id === orig)
        if (wrep && wrep.datasetId) highlight = models.find((m) => m.id === wrep.datasetId) || null
      }
      if (highlight) {
        notes.unshift(`Report '${match.name}' is powered by model '${highlight.name}'.`)
      } else {
        notes.unshift(`Target report in URL: '${match.name}' (source-workspace report id ${orig}).`)
      }
    }
  }

  const ordered = highlight ? [highlight, ...models.filter((m) => m !== highlight)] : models
  return {
    report: null,
    app: { id: app.id, name: app.name, workspaceId: wsId, workspaceName: wsName, publishedBy: app.publishedBy, reportCount: areps.length },
    models: ordered,
    notes,
  }
}

async function locateDataset(pbi, dsId, wss, names, wsHint) {
  const model = await resolveModel(pbi, dsId, wsHint, wsHint ? names[wsHint] : null, wss, names)
  if (!model) return null
  return { report: null, app: null, models: [model], notes: [] }
}

async function autoDetect(pbi, gid) {
  const [sa] = await pbi.get(`/apps/${gid}`)
  if (sa === 200) return 'app'
  const [sd, jd] = await pbi.get(`/datasets/${gid}`)
  if (sd === 200 && jd && jd.id) return 'dataset'
  return 'report' // default; report locator handles fast path + full scan
}

async function runLocate(token, req) {
  const pbiToken = await token(PBI_SCOPES)
  const pbi = makeApi(pbiToken, PBI_BASE)
  const t = parseTarget(req.target)
  let kind = t.kind
  const id = t.id
  const wsHint = req.workspace || t.workspace
  const appReport = t.appReport
  if (!id) {
    return { ok: true, matched: false, error: 'Provide a report/app/dataset id or a Power BI URL.', input: { value: req.target, kind, id: null }, models: [] }
  }
  const { wss, names } = await workspaceIndex(pbi)
  if (!kind) kind = await autoDetect(pbi, id)

  let result
  if (kind === 'app') result = await locateApp(pbi, id, wss, names, appReport)
  else if (kind === 'dataset') result = await locateDataset(pbi, id, wss, names, wsHint)
  else result = await locateReport(pbi, id, wss, names, wsHint, !!req.admin)

  return { ok: true, matched: !!result, input: { value: req.target || id, kind, id }, ...(result || { report: null, app: null, models: [], notes: [] }) }
}

// ── Catalog search ────────────────────────────────────────────────────────--
function buildFilter(types) {
  if (!types || types.includes('all')) return null
  const resolved = types.map((t) => TYPE_ALIASES[String(t).toLowerCase()] || t)
  const seen = [...new Set(resolved)]
  return seen.map((t) => `Type eq '${t}'`).join(' or ')
}

async function searchCatalog(fab, query, filt, limit, pageSize) {
  const out = []
  let cont = null
  while (out.length < limit) {
    const body = { search: query, pageSize: Math.max(1, Math.min(pageSize, 1000, limit - out.length)) }
    if (filt) body.filter = filt
    if (cont) body.continuationToken = cont
    const [s, j] = await fab.post(CATALOG_SEARCH, body)
    if (s !== 200 || j === null) {
      const err = (j && (j.message || j.error)) || `HTTP ${s}`
      throw new Error(`Catalog search failed: ${err}`)
    }
    out.push(...(j.value || []))
    cont = j.continuationToken
    if (!cont) break
  }
  return out.slice(0, limit)
}

function wsOf(entry) {
  const w = (entry.hierarchy && entry.hierarchy.workspace) || {}
  return { id: w.id, name: w.displayName }
}

function makeSearchModel(mid, name, wsId, wsName, owner, via) {
  return {
    id: mid,
    name,
    itemId: mid,
    workspaceId: wsId,
    workspaceName: wsName,
    owner,
    webUrl: wsId && mid ? `https://app.powerbi.com/groups/${wsId}/datasets/${mid}` : null,
    xmlaEndpoint: wsName && wsName !== 'My workspace' ? `powerbi://api.powerbi.com/v1.0/myorg/${wsName}` : null,
    matchedVia: via,
  }
}

async function resolveReportModel(pbi, reportId, wsId) {
  let s, rep
  if (wsId) [s, rep] = await pbi.get(`/groups/${wsId}/reports/${reportId}`)
  if (!rep || s !== 200) [s, rep] = await pbi.get(`/reports/${reportId}`)
  if (s !== 200 || !rep || !rep.datasetId) return null
  const dsId = rep.datasetId
  const dsWs = rep.datasetWorkspaceId || wsId
  let name = null
  let owner = null
  let ds
  let sd
  if (dsWs) [sd, ds] = await pbi.get(`/groups/${dsWs}/datasets/${dsId}`)
  if (!ds || sd !== 200) [sd, ds] = await pbi.get(`/datasets/${dsId}`)
  if (sd === 200 && ds) { name = ds.name; owner = ds.configuredBy }
  return { id: dsId, name, workspaceId: dsWs, owner }
}

async function runSearch(token, req) {
  const query = String(req.query || '').trim()
  if (!query) return { ok: true, matched: false, error: 'Provide a description / keywords to search for.', models: [] }
  if (GUID_RE.test(query) && new RegExp('^' + GUID + '$').test(query)) {
    return { ok: true, matched: false, error: 'That looks like a GUID — use the locate tool for direct id/URL lookups.', models: [] }
  }
  const filt = buildFilter(req.types || DEFAULT_TYPES)
  const limit = req.limit || 30
  const pageSize = req.pageSize || 100

  const fab = makeApi(await fabricCatalogToken())
  const entries = await searchCatalog(fab, query, filt, limit, pageSize)

  const models = []
  const notes = []
  const seen = new Set()
  const add = (m) => { if (m.id && !seen.has(m.id)) { seen.add(m.id); models.push(m) } }

  for (const e of entries) {
    if (e.type === 'SemanticModel') {
      const w = wsOf(e)
      add(makeSearchModel(e.id, e.displayName, w.id, w.name, null, 'semantic model match'))
    }
  }

  let pbi = null
  for (const e of entries) {
    if (e.type !== 'Report') continue
    const w = wsOf(e)
    if (req.noResolve) {
      notes.push(`Report '${e.displayName}' [${e.id}] in '${w.name}' — resolve to get its model.`)
      continue
    }
    if (!pbi) pbi = makeApi(await token(PBI_SCOPES), PBI_BASE)
    const r = await resolveReportModel(pbi, e.id, w.id)
    if (r && r.id) {
      const dsWsName = r.workspaceId === w.id ? w.name : null
      add(makeSearchModel(r.id, r.name || '(semantic model)', r.workspaceId, dsWsName, r.owner, `report '${e.displayName}' [${e.id}]`))
    } else {
      notes.push(`Report '${e.displayName}' [${e.id}] matched but its semantic model could not be resolved (no access?).`)
    }
  }

  const others = entries
    .filter((e) => e.type !== 'Report' && e.type !== 'SemanticModel')
    .map((e) => { const w = wsOf(e); return { id: e.id, type: e.type, displayName: e.displayName, workspaceId: w.id, workspaceName: w.name } })

  return { ok: true, matched: models.length > 0, query, filter: filt, models, otherMatches: others, notes }
}

// ── Entry ─────────────────────────────────────────────────────────────────--
async function main() {
  const [authPath, reqJson] = process.argv.slice(2)
  if (!authPath || !reqJson) throw new Error('usage: <authModulePath> <requestJson>')
  const req = JSON.parse(reqJson)
  const token = await makeTokens(authPath)
  const result = req.mode === 'search' ? await runSearch(token, req) : await runLocate(token, req)
  process.stdout.write(JSON.stringify(result))
}

main().catch((err) => {
  const msg = err && err.message ? String(err.message) : String(err)
  const needsAz = err instanceof NeedsAz || /\baz\b.*(login|sign|token|account)|run 'az login'|az account/i.test(msg)
  const needsLogin = !needsAz && (err instanceof NeedsLogin || /silent|cached|account|login|token|interactive|sign/i.test(msg))
  process.stdout.write(JSON.stringify({ ok: false, needsLogin, needsAz, error: msg }))
})
