// Report-migration helper for Fabricator: lists and inspects Power BI reports, and
// extracts what Copilot needs to rebuild one as a Rayfin app: the report
// definition, the semantic model's schema and the pages as PDF.
//
// Every token comes from the Azure CLI (Fabric and Power BI resources), so no
// project or Rayfin CLI is needed. Power BI's group APIs reject My workspace
// ("Calling group APIs not permitted for personal workspace"), so its reports and
// models use the /myorg/reports and /myorg/datasets paths; Fabric APIs take My
// workspace's real id.
//
// argv: <requestJson>
//   {"mode":"workspaces"}
//   {"mode":"reports","workspaceId":"<guid>"}
//   {"mode":"search","query":"<text>"}
//   {"mode":"inspect","target"?:"<url|guid>","workspaceId"?:"<guid>","reportId"?:"<guid>"}
//   {"mode":"definition","workspaceId":"<guid>","reportId":"<guid>","outDir":"<abs path>"}
//   {"mode":"model","workspaceId":"<guid>","datasetId":"<guid>","personal":false,"outDir":"<abs path>","modelName"?:"<name>"}
//   {"mode":"export","workspaceId":"<guid>","reportId":"<guid>","personal":false,"pages":["<pageName>"]|null,"outDir":"<abs path>"}
//   {"mode":"readme","outDir":"<abs path>","source":{…},"pages":[…],"images":true}
//
// Writes exactly one JSON line to stdout. Export progress goes to stderr as
// {"progress":<0-100>} lines.

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import {
  NeedsAz, apiError, apiUrl, azToken, checkAuthentication, errorMessage, fetchAllPages, isMain, makeApi, runHelper,
} from './fabric_auth_helper.mjs'
import { infoViewSchema, modelMarkdown, normalizeDefinition, readmeMarkdown, visualCounts } from './report_definition.mjs'
import { fetchModelBim, normalizeTmsl, parseTarget } from './semantic_model_helper.mjs'

const FABRIC_RESOURCE = 'https://api.fabric.microsoft.com'
const FABRIC = 'https://api.fabric.microsoft.com/v1'
const PBI_RESOURCE = 'https://analysis.windows.net/powerbi/api'
const PBI = 'https://api.powerbi.com/v1.0/myorg'
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEARCH_LIMIT = 50
const EXPORT_PAGE_LIMIT = 50
const EXPORT_TIMEOUT_MS = 12 * 60_000
const DEFINITION_TIMEOUT_MS = 4 * 60_000
const PROBE_QUERY = { queries: [{ query: 'EVALUATE ROW("ok", 1)' }], serializerSettings: { includeNulls: true } }
const INFO_VIEWS = {
  tables: 'INFO.VIEW.TABLES()', columns: 'INFO.VIEW.COLUMNS()', measures: 'INFO.VIEW.MEASURES()', relationships: 'INFO.VIEW.RELATIONSHIPS()',
}
const AUTO_DATE_TABLE = /^(LocalDateTable|DateTableTemplate)_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const MESSAGES = {
  app: "This report is in an app. Open it from its workspace and paste that link, or ask the app's owner for access to the workspace.",
  paginated: "Paginated reports can't be migrated yet.",
  definitionOk: 'Pages, visuals, fields and filters can be read.',
  readOnly: "You can view this report but not edit it, so its definition can't be read. Copilot will work from the page images and text.",
  imagesOk: 'Pages can be exported to PDF for Copilot to look at.',
  noCapacity: "This workspace isn't on a Fabric or Premium capacity, so pages can't be exported. Copilot will work from the definition only.",
  neither: "Fabricator can neither read this report's definition nor export its pages.",
  definitionForbidden: 'You need edit access to this report to read its definition.',
}
const NOT_CHECKED = { status: 'warn', message: 'Not checked.' }

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const isGuid = (value) => GUID.test(String(value ?? '').trim())
const sameId = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()
const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
}

function requireGuid(value, message) {
  const id = String(value ?? '').trim()
  if (!GUID.test(id)) throw new Error(message)
  return id
}

function requireDir(value) {
  const dir = String(value ?? '').trim()
  if (!dir || !isAbsolute(dir)) throw new Error('An absolute output folder (outDir) is required.')
  return dir
}

// Seconds to wait from a Retry-After header, within [1, max].
function retryAfter(headers, fallback, max) {
  const seconds = Number.parseInt(headers?.get?.('retry-after') ?? '', 10)
  return Math.max(1, Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds : fallback, max))
}

// Power BI puts query and export errors under `pbi.error` details.
function pbiError(label, status, body) {
  const details = body?.error?.['pbi.error']?.details
  const detail = Array.isArray(details) ? details.map((d) => d?.detail?.value).filter(Boolean).join(' ') : ''
  return detail ? `${label} failed (HTTP ${status}): ${errorMessage(detail).slice(0, 300)}` : apiError(label, status, body)
}

// One request with a bearer token → [status, body, headers]. Retries 429s. A
// binary download follows a redirect only without the token (a pre-signed link).
async function send(token, base, method, path, body, { binary = false, timeout = 60_000 } = {}) {
  const url = apiUrl(/^https?:\/\//i.test(path) ? path : base + '/' + path.replace(/^\//, ''), base)
  for (let attempt = 0; ; attempt++) {
    let response
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: binary ? 'manual' : 'error',
        signal: AbortSignal.timeout(timeout),
      })
      const location = response.headers.get('location')
      if (binary && response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, url)
        if (next.protocol !== 'https:') throw new Error('The download was redirected to an insecure address.')
        response = await fetch(next, { redirect: 'error', signal: AbortSignal.timeout(timeout) })
      }
    } catch (error) {
      return [0, { error: errorMessage(error) }, new Headers()]
    }
    if (/insufficient_claims/i.test(response.headers.get('www-authenticate') || '')) checkAuthentication(response, 'az')
    if (response.status === 429 && attempt < 3) {
      await sleep(retryAfter(response.headers, 5, 30) * 1000)
      continue
    }
    const type = response.headers.get('content-type') || ''
    let result = null
    if (binary && response.ok) result = Buffer.from(await response.arrayBuffer())
    else if (type.includes('json')) result = await response.json().catch(() => null)
    else {
      const text = await response.text().catch(() => '')
      result = text ? { _text: text } : null
    }
    return [response.status, result, response.headers]
  }
}

// Power BI also answers 401 when the caller only lacks a permission (group APIs
// on My workspace, models without Build, workspaces they can't open). A 401
// means sign-in again only if the token also fails on a normal endpoint, which
// throws NeedsAz.
function powerBi(token) {
  const strict = makeApi(token, PBI, 'az')
  let verified = null
  async function call(method, path, body, options) {
    const result = await send(token, PBI, method, path, body, options)
    if (result[0] === 401) await (verified ||= strict.get('/groups?$top=1'))
    return result
  }
  return {
    get: (path, options) => call('GET', path, null, options),
    post: (path, body, options) => call('POST', path, body, options),
  }
}

const fabricApi = async () => makeApi(await azToken(FABRIC_RESOURCE), FABRIC, 'az')
const listWorkspaces = async (fabric) =>
  (await fetchAllPages(fabric, `${FABRIC}/workspaces`, { label: 'Fabric workspaces request' })).filter((w) => w?.id)

// The Azure CLI's signed-in account (best effort), to name its organization.
function azAccount(execute = execFile) {
  return new Promise((done) => {
    const args = ['account', 'show', '-o', 'json']
    const isWin = process.platform === 'win32'
    const file = isWin ? process.env.ComSpec || 'cmd.exe' : 'az'
    const argv = isWin ? ['/d', '/s', '/c', 'az', ...args] : args
    execute(file, argv, { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return done({})
      try {
        const account = JSON.parse(stdout)
        done(withoutUndefined({
          user: account?.user?.name || undefined,
          tenantId: account?.tenantId || undefined,
          domain: account?.tenantDefaultDomain || undefined,
          tenantName: account?.tenantDisplayName || undefined,
        }))
      } catch {
        done({})
      }
    })
  })
}

// ── Picker ──────────────────────────────────────────────────────────────────
async function runWorkspaces() {
  const [fabric, account] = await Promise.all([fabricApi(), azAccount()])
  const workspaces = (await listWorkspaces(fabric))
    .map((w) => {
      const personal = w.type === 'Personal'
      return withoutUndefined({
        id: w.id, name: personal ? 'My workspace' : String(w.displayName ?? w.id), personal, capacityId: w.capacityId || undefined,
      })
    })
    .sort((a, b) => Number(b.personal) - Number(a.personal) || byName(a, b))
  return { ok: true, workspaces, account }
}

async function runReports(req) {
  const workspaceId = requireGuid(req.workspaceId, 'A workspace id is required.')
  const fabric = await fabricApi()
  const items = await fetchAllPages(fabric, `${FABRIC}/workspaces/${workspaceId}/reports`, { label: 'Fabric reports request' })
  const reports = items
    .filter((r) => r?.id)
    .map((r) => withoutUndefined({
      id: r.id, name: String(r.displayName ?? r.id), description: r.description || undefined, workspaceId: r.workspaceId ?? workspaceId,
    }))
    .sort(byName)
  return { ok: true, reports }
}

async function runSearch(req) {
  const query = String(req.query ?? '').trim()
  if (!query) return { ok: true, reports: [] }
  const fabric = await fabricApi()
  const [status, body] = await fabric.post(`${FABRIC}/catalog/search`, { search: query, filter: "Type eq 'Report'", pageSize: SEARCH_LIMIT })
  if (status !== 200 || !Array.isArray(body?.value)) throw new Error(apiError('Report search', status, body))
  const reports = body.value
    .filter((e) => e?.id && (e.type ?? 'Report') === 'Report')
    .slice(0, SEARCH_LIMIT)
    .map((e) => withoutUndefined({
      id: e.id,
      name: String(e.displayName ?? e.id),
      description: e.description || undefined,
      workspaceId: e.hierarchy?.workspace?.id || undefined,
      workspaceName: e.hierarchy?.workspace?.displayName || undefined,
    }))
  return { ok: true, reports }
}

// ── Inspect ─────────────────────────────────────────────────────────────────
// Bounded parallel probe; resolves to the first hit.
async function firstMatch(items, probe, workers = 8) {
  let next = 0
  let found = null
  async function worker() {
    while (!found && next < items.length) {
      const hit = await probe(items[next++])
      if (hit && !found) found = hit
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker))
  return found
}

// The workspace holding a report or semantic model, from Fabric: My workspace
// first, then the others. Power BI's /myorg APIs answer for any item the user
// can open but always link it to /groups/me, so they can't say where it lives.
async function findHome(kind, id, { fabric, workspaces, personalId }) {
  const holds = async (w) => {
    const [status] = await fabric.get(`${FABRIC}/workspaces/${w.id}/${kind}/${id}`)
    return status === 200 ? w : null
  }
  const personal = workspaces.find((w) => sameId(w.id, personalId))
  const hit = (personal && (await holds(personal))) || (await firstMatch(workspaces.filter((w) => w !== personal), holds))
  return hit ? { workspaceId: hit.id, personal: hit === personal } : null
}

// An app link's report id is the source report's id (originalReportObjectId).
async function resolveAppReport(parsed, { pbi, workspaces }) {
  if (!parsed.appReport) throw new Error('That link opens an app. Open the report in the app and paste that link.')
  const [[appStatus, app], [, appReports]] = await Promise.all([pbi.get(`/apps/${parsed.id}`), pbi.get(`/apps/${parsed.id}/reports`)])
  if (appStatus !== 200 || !app) throw new Error(apiError('Opening the app', appStatus, app))
  const match = (Array.isArray(appReports?.value) ? appReports.value : [])
    .find((r) => sameId(r?.originalReportObjectId, parsed.appReport) || sameId(r?.id, parsed.appReport))
  const reportId = match?.originalReportObjectId ?? parsed.appReport
  const workspaceId = app.workspaceId ?? null
  const workspace = workspaces.find((w) => sameId(w.id, workspaceId))
  const report = withoutUndefined({
    id: reportId,
    name: match?.name || app.name || undefined,
    workspaceId: workspaceId || undefined,
    workspaceName: workspace?.displayName ?? null,
    personal: false,
    webUrl: match?.webUrl || undefined,
  })
  if (!workspace) return { blocked: MESSAGES.app, report }
  return { reportId, workspaceId, personal: false, fromApp: report }
}

async function resolveTarget(req, ctx) {
  let reportId = isGuid(req.reportId) ? String(req.reportId).trim() : null
  let workspaceId = isGuid(req.workspaceId) ? String(req.workspaceId).trim() : null
  if (!reportId) {
    const text = String(req.target ?? '').trim()
    if (!text) throw new Error('Paste a link to a Power BI report, or pick one.')
    const parsed = parseTarget(text)
    if (parsed.kind === 'app') return resolveAppReport(parsed, ctx)
    if (parsed.kind === 'dataset' || parsed.kind === 'dashboard') {
      throw new Error(`That link opens a ${parsed.kind === 'dataset' ? 'semantic model' : 'dashboard'}, not a report. Paste a link to a report.`)
    }
    if (!parsed.id) throw new Error("That doesn't look like a link to a Power BI report.")
    reportId = parsed.id
    // My workspace links (/groups/me/…) and bare ids name no workspace.
    workspaceId = parsed.workspace
  }
  if (workspaceId) return { reportId, workspaceId, personal: sameId(workspaceId, ctx.personalId) }
  const home = await findHome('reports', reportId, ctx)
  if (home) return { reportId, ...home }
  const [status] = await ctx.pbi.get(`/reports/${reportId}`)
  throw new Error(status === 200
    ? "This report was shared with you, but you can't open its workspace. Open it from its workspace and paste that link, or ask its owner for access to the workspace."
    : "Couldn't find that report in the workspaces you can open.")
}

async function definitionCheck(pbi, target) {
  if (target.personal) return { status: 'ok', message: MESSAGES.definitionOk }
  const [status, body] = await pbi.get(`/groups?$filter=id eq '${target.workspaceId}'`)
  if (status !== 200 || !Array.isArray(body?.value)) {
    return { status: 'warn', message: apiError('Checking your access to the workspace', status, body) }
  }
  const workspace = body.value.find((w) => sameId(w?.id, target.workspaceId))
  return workspace && workspace.isReadOnly !== true
    ? { status: 'ok', message: MESSAGES.definitionOk }
    : { status: 'warn', message: MESSAGES.readOnly }
}

async function imagesCheck(fabric, target, workspaces) {
  let capacityId = null
  if (target.workspaceId) {
    const [status, body] = await fabric.get(`${FABRIC}/workspaces/${target.workspaceId}`)
    capacityId = status === 200 ? body?.capacityId : workspaces.find((w) => sameId(w.id, target.workspaceId))?.capacityId
  }
  return capacityId ? { status: 'ok', message: MESSAGES.imagesOk } : { status: 'warn', message: MESSAGES.noCapacity }
}

function modelCheck(model, [status, body]) {
  if (!model) return { status: 'error', message: "This report isn't connected to a semantic model." }
  const label = model.name ? `“${model.name}”` : "the report's semantic model"
  if (status === 200) return { status: 'ok', message: `Copilot can query ${label} live.` }
  if (status === 401 || status === 403) return { status: 'error', message: `You can't query ${label}. Ask its owner for Build permission.` }
  return { status: 'warn', message: pbiError(`Querying ${label}`, status, body) }
}

const blockedResult = (report, blocked) => ({
  ok: true, report, model: null, pages: [], checks: { definition: NOT_CHECKED, model: NOT_CHECKED, images: NOT_CHECKED }, blocked,
})

// Users with only Build permission may not reach a model through its
// workspace's group path; the /myorg path addresses any model they can use.
async function modelCall(pbi, base, path, body) {
  const call = (prefix) => (body ? pbi.post(`${prefix}${path}`, body) : pbi.get(`${prefix}${path}`))
  const result = await call(base)
  if (!base || ![401, 403, 404].includes(result[0])) return result
  const retry = await call('')
  return retry[0] === 200 ? retry : result
}

async function runInspect(req) {
  const [fabricToken, pbiToken] = await Promise.all([azToken(FABRIC_RESOURCE), azToken(PBI_RESOURCE)])
  const fabric = makeApi(fabricToken, FABRIC, 'az')
  const pbi = powerBi(pbiToken)
  const workspaces = await listWorkspaces(fabric)
  const personalId = workspaces.find((w) => w.type === 'Personal')?.id ?? null
  const target = await resolveTarget(req, { fabric, pbi, workspaces, personalId })
  if (target.blocked) return blockedResult(target.report, target.blocked)

  const base = target.personal ? '' : `/groups/${target.workspaceId}`
  const [status, found] = await pbi.get(`${base}/reports/${target.reportId}`)
  if (status !== 200 || !found?.id) {
    if (target.fromApp) return blockedResult(target.fromApp, MESSAGES.app)
    throw new Error(`Couldn't open this report. Check the link, and that you can open the report in Power BI. (${apiError('Reading the report', status, found)})`)
  }
  const workspaceName = target.personal ? 'My workspace' : workspaces.find((w) => sameId(w.id, target.workspaceId))?.displayName ?? null
  const report = withoutUndefined({
    id: found.id,
    name: found.name || undefined,
    workspaceId: target.workspaceId,
    workspaceName,
    personal: target.personal,
    webUrl: found.webUrl || undefined,
    format: found.format || undefined,
    reportType: found.reportType || undefined,
  })
  if (found.reportType === 'PaginatedReport') return blockedResult(report, MESSAGES.paginated)

  // Group report APIs name the model's workspace; /myorg ones (My workspace) don't.
  const datasetId = found.datasetId || null
  let modelWorkspaceId = found.datasetWorkspaceId || (target.personal ? null : target.workspaceId)
  if (datasetId && !modelWorkspaceId) {
    modelWorkspaceId = (await findHome('semanticModels', datasetId, { fabric, workspaces, personalId }))?.workspaceId ?? null
  }
  const modelPersonal = sameId(modelWorkspaceId, personalId)
  const modelBase = modelPersonal || !modelWorkspaceId ? '' : `/groups/${modelWorkspaceId}`
  const [pagesResult, datasetResult, definition, images, probe] = await Promise.all([
    pbi.get(`${base}/reports/${found.id}/pages`),
    datasetId ? modelCall(pbi, modelBase, `/datasets/${datasetId}`) : [0, null],
    definitionCheck(pbi, target),
    imagesCheck(fabric, target, workspaces),
    datasetId ? modelCall(pbi, modelBase, `/datasets/${datasetId}/executeQueries`, PROBE_QUERY) : [0, null],
  ])
  const dataset = datasetResult[0] === 200 ? datasetResult[1] : null
  // An unknown workspace (a model in a workspace the user can't open) is left
  // out rather than null: Rust reads these ids as plain strings.
  const model = datasetId
    ? withoutUndefined({
      id: datasetId,
      name: dataset?.name ?? null,
      workspaceId: modelWorkspaceId || undefined,
      workspaceName: modelPersonal ? 'My workspace' : workspaces.find((w) => sameId(w.id, modelWorkspaceId))?.displayName ?? undefined,
    })
    : null
  const pages = (pagesResult[0] === 200 && Array.isArray(pagesResult[1]?.value) ? pagesResult[1].value : [])
    .filter((p) => p?.name)
    .map((p) => ({ name: p.name, displayName: p.displayName ?? p.name, order: Number.isFinite(p.order) ? p.order : 0 }))
    .sort((a, b) => a.order - b.order)
  const checks = { definition, model: modelCheck(model, probe), images }
  const blocked = checks.model.status === 'error'
    ? checks.model.message
    : definition.status === 'warn' && images.status === 'warn' ? MESSAGES.neither : null
  return { ok: true, report, model, pages, checks, blocked }
}

// ── Definition ──────────────────────────────────────────────────────────────
// POST getDefinition and follow the long-running operation to its result.
async function fetchReportDefinition(token, workspaceId, reportId) {
  const request = async (url, method = 'GET') => {
    const response = await fetch(apiUrl(url, FABRIC), {
      method, headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(60_000),
    })
    checkAuthentication(response, 'az')
    return response
  }
  const failure = async (response) => response.status === 403
    ? new Error(MESSAGES.definitionForbidden)
    : new Error(apiError('Reading the report definition', response.status, await response.json().catch(() => null)))
  let response = await request(`${FABRIC}/workspaces/${workspaceId}/reports/${reportId}/getDefinition`, 'POST')
  if (response.status === 202) {
    const location = response.headers.get('location')
    if (!location) throw new Error('Fabric accepted the definition request but returned no polling URL.')
    const poll = apiUrl(location, FABRIC)
    const deadline = Date.now() + DEFINITION_TIMEOUT_MS
    let wait = retryAfter(response.headers, 2, 5)
    for (;;) {
      if (Date.now() > deadline) throw new Error('Timed out reading the report definition.')
      await sleep(wait * 1000)
      const status = await request(poll)
      wait = retryAfter(status.headers, 2, 5)
      if (status.status === 429 || status.status >= 500) continue
      if (status.status !== 200 && status.status !== 202) throw await failure(status)
      const operation = await status.json().catch(() => ({}))
      const state = String(operation?.status ?? '').toLowerCase()
      if (state === 'failed') {
        throw new Error(`Fabric couldn't read the report definition: ${errorMessage(operation?.error?.message ?? operation?.error?.errorCode ?? 'the operation failed')}`)
      }
      if (state === 'succeeded') {
        const result = new URL(poll)
        result.pathname = result.pathname.replace(/\/$/, '') + '/result'
        response = await request(result.href)
        break
      }
    }
  }
  if (response.status !== 200) throw await failure(response)
  return response.json()
}

// `relative` inside `root`, or null for absolute, `..` or otherwise unsafe paths.
function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || isAbsolute(relative) || /^[a-z]:/i.test(relative) || /^[\\/]/.test(relative)) return null
  const segments = relative.split(/[\\/]+/).filter(Boolean)
  if (!segments.length || segments.some((s) => s === '.' || s === '..' || /[\0:]/.test(s))) return null
  const file = resolve(root, ...segments)
  return file.startsWith(resolve(root) + sep) ? file : null
}

async function writeParts(outDir, parts, warnings) {
  const root = join(outDir, 'raw')
  await rm(root, { recursive: true, force: true })
  for (const part of parts) {
    const file = safePath(root, part?.path)
    if (!file || typeof part?.payload !== 'string') {
      warnings.push(`Skipped a definition part with an unsafe or missing path: ${String(part?.path ?? '').slice(0, 200)}`)
      continue
    }
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, Buffer.from(part.payload, 'base64'))
    } catch (error) {
      warnings.push(`Couldn't save ${part.path}: ${errorMessage(error)}`)
    }
  }
}

async function writeResources(outDir, parts, resources, warnings) {
  const root = join(outDir, 'resources')
  await rm(root, { recursive: true, force: true })
  if (!resources.length) return
  await mkdir(root, { recursive: true })
  const payloads = new Map(parts.map((p) => [String(p?.path ?? '').replace(/\\/g, '/'), p?.payload]))
  for (const resource of resources) {
    const file = safePath(root, resource.name)
    const payload = payloads.get(resource.path)
    if (!file || typeof payload !== 'string') continue
    try {
      await writeFile(file, Buffer.from(payload, 'base64'))
    } catch (error) {
      warnings.push(`Couldn't save the image ${resource.name}: ${errorMessage(error)}`)
    }
  }
}

async function runDefinition(req) {
  const workspaceId = requireGuid(req.workspaceId, 'A workspace id is required.')
  const reportId = requireGuid(req.reportId, 'A report id is required.')
  const outDir = requireDir(req.outDir)
  const body = await fetchReportDefinition(await azToken(FABRIC_RESOURCE), workspaceId, reportId)
  const parts = Array.isArray(body?.definition?.parts) ? body.definition.parts : []
  if (!parts.length) throw new Error('Fabric returned an empty report definition.')
  const report = normalizeDefinition(parts)
  await mkdir(outDir, { recursive: true })
  await writeParts(outDir, parts, report.warnings)
  await writeResources(outDir, parts, report.resources, report.warnings)
  await writeFile(join(outDir, 'theme.json'), JSON.stringify(report.theme, null, 2) + '\n')
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const pages = report.pages.map((p) => ({
    name: p.name, displayName: p.displayName, order: p.order, width: p.width, height: p.height, hidden: p.hidden, kind: p.kind,
    visuals: visualCounts(p).visuals,
  }))
  return {
    ok: true,
    format: report.format,
    pages,
    visuals: pages.reduce((sum, p) => sum + p.visuals, 0),
    customVisuals: report.customVisuals.filter((c) => c.visuals > 0).map((c) => c.name),
    warnings: report.warnings,
  }
}

// ── Model ───────────────────────────────────────────────────────────────────
async function modelFromQueries(pbi, base, datasetId) {
  const rows = {}
  for (const [key, view] of Object.entries(INFO_VIEWS)) {
    const [status, body] = await modelCall(pbi, base, `/datasets/${datasetId}/executeQueries`, {
      queries: [{ query: `EVALUATE ${view}` }], serializerSettings: { includeNulls: true },
    })
    if (status === 401 || status === 403) throw new Error("You can't query this semantic model. Ask its owner for Build permission.")
    if (status !== 200) throw new Error(pbiError(`Reading the model's ${key}`, status, body))
    rows[key] = body?.results?.[0]?.tables?.[0]?.rows ?? []
  }
  return infoViewSchema(rows)
}

async function personalWorkspaceId() {
  const workspaces = await listWorkspaces(await fabricApi())
  return workspaces.find((w) => w.type === 'Personal')?.id ?? null
}

async function runModel(req) {
  const datasetId = requireGuid(req.datasetId, 'A semantic model id (datasetId) is required.')
  const outDir = requireDir(req.outDir)
  const personal = req.personal === true
  let workspaceId = isGuid(req.workspaceId) ? String(req.workspaceId).trim() : null
  if (!workspaceId && !personal) throw new Error('A workspace id is required.')
  if (!workspaceId) workspaceId = await personalWorkspaceId()
  const warnings = []
  let source = 'definition'
  let schema
  let name = typeof req.modelName === 'string' && req.modelName.trim() ? req.modelName.trim() : null
  try {
    if (!workspaceId) throw new Error('My workspace has no id to read the definition from.')
    const token = await azToken(FABRIC_RESOURCE)
    schema = normalizeTmsl(await fetchModelBim(token, workspaceId, datasetId))
    if (!name) {
      const [status, item] = await makeApi(token, FABRIC, 'az').get(`${FABRIC}/workspaces/${workspaceId}/semanticModels/${datasetId}`)
      name = status === 200 ? item?.displayName ?? null : null
    }
  } catch (error) {
    if (error instanceof NeedsAz) throw error
    source = 'queries'
    warnings.push(`The model's definition couldn't be read (${errorMessage(error)}), so model.md comes from INFO.VIEW queries, without measure DAX.`)
    const pbi = powerBi(await azToken(PBI_RESOURCE))
    const base = personal ? '' : `/groups/${workspaceId}`
    schema = await modelFromQueries(pbi, base, datasetId)
    if (!name) {
      const [status, dataset] = await modelCall(pbi, base, `/datasets/${datasetId}`)
      name = status === 200 ? dataset?.name ?? null : null
    }
  }
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'model.md'), modelMarkdown(schema, { source, name }))
  const tables = schema.tables.filter((t) => !AUTO_DATE_TABLE.test(t.name))
  const relationships = schema.relationships.filter((r) => !AUTO_DATE_TABLE.test(r.fromTable) && !AUTO_DATE_TABLE.test(r.toTable))
  return { ok: true, source, tables: tables.length, measures: schema.measures.length, relationships: relationships.length, warnings }
}

// ── Export ──────────────────────────────────────────────────────────────────
function progressReporter() {
  let last = -1
  return (value) => {
    const progress = Math.max(0, Math.min(100, Math.floor(value)))
    if (progress === last) return
    last = progress
    process.stderr.write(JSON.stringify({ progress }) + '\n')
  }
}

const pdfPageCount = (pdf) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length

// One ExportTo job: start, poll (Retry-After, at most 10 s) and download.
async function exportJob(pbi, base, pages, onProgress) {
  const config = pages ? { powerBIReportConfiguration: { pages: pages.map((pageName) => ({ pageName })) } } : {}
  const [status, job, headers] = await pbi.post(`${base}/ExportTo`, { format: 'PDF', ...config })
  if ((status !== 202 && status !== 200) || !job?.id) return { error: pbiError("Starting the report's PDF export", status, job) }
  const deadline = Date.now() + EXPORT_TIMEOUT_MS
  let wait = retryAfter(headers, 5, 10)
  for (;;) {
    if (Date.now() > deadline) return { error: 'Power BI took more than 12 minutes to export the pages to PDF.' }
    await sleep(wait * 1000)
    const [pollStatus, state, pollHeaders] = await pbi.get(`${base}/exports/${job.id}`)
    wait = retryAfter(pollHeaders, 5, 10)
    if (pollStatus === 0 || pollStatus === 429 || pollStatus >= 500) continue
    if (pollStatus !== 200 && pollStatus !== 202) return { error: pbiError("Checking the report's PDF export", pollStatus, state) }
    onProgress(Number(state?.percentComplete) || 0)
    if (state?.status === 'Failed') {
      const detail = state?.error?.message ?? state?.error?.code ?? state?.error
      return { error: `Power BI couldn't export the pages to PDF${typeof detail === 'string' && detail ? `: ${errorMessage(detail).slice(0, 300)}` : '.'}` }
    }
    if (state?.status === 'Succeeded') break
  }
  const [fileStatus, pdf] = await pbi.get(`${base}/exports/${job.id}/file`, { binary: true, timeout: 300_000 })
  if (fileStatus !== 200 || !Buffer.isBuffer(pdf)) return { error: pbiError('Downloading the exported PDF', fileStatus, pdf) }
  return { pdf }
}

async function runExport(req) {
  const reportId = requireGuid(req.reportId, 'A report id is required.')
  const outDir = requireDir(req.outDir)
  const personal = req.personal === true
  const workspaceId = personal ? null : requireGuid(req.workspaceId, 'A workspace id is required.')
  const pages = Array.isArray(req.pages) ? req.pages.map(String).filter(Boolean) : []
  const jobs = []
  for (let i = 0; i < pages.length; i += EXPORT_PAGE_LIMIT) jobs.push(pages.slice(i, i + EXPORT_PAGE_LIMIT))
  if (!jobs.length) jobs.push(null)
  const pbi = powerBi(await azToken(PBI_RESOURCE))
  const base = `${personal ? '' : `/groups/${workspaceId}`}/reports/${reportId}`
  await mkdir(outDir, { recursive: true })
  const progress = progressReporter()
  progress(0)
  const files = []
  let exported = 0
  for (const [index, jobPages] of jobs.entries()) {
    const result = await exportJob(pbi, base, jobPages, (percent) => progress(((index + Math.min(percent, 100) / 100) / jobs.length) * 99))
    if (result.error) return { ok: false, error: result.error, files }
    const file = `export-${index + 1}.pdf`
    await writeFile(join(outDir, file), result.pdf)
    files.push(file)
    exported += jobPages ? jobPages.length : pdfPageCount(result.pdf)
  }
  progress(100)
  return { ok: true, files, pages: exported }
}

// ── README ──────────────────────────────────────────────────────────────────
async function runReadme(req) {
  const outDir = requireDir(req.outDir)
  let report = null
  try {
    report = JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8'))
  } catch {
    report = null
  }
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'README.md'), readmeMarkdown({ source: req.source, pages: req.pages, images: req.images === true, report }))
  return { ok: true }
}

const MODES = {
  workspaces: runWorkspaces,
  reports: runReports,
  search: runSearch,
  inspect: runInspect,
  definition: runDefinition,
  model: runModel,
  export: runExport,
  readme: runReadme,
}

async function main() {
  const [requestJson] = process.argv.slice(2)
  if (!requestJson) throw new Error('usage: <requestJson>')
  const req = JSON.parse(requestJson)
  const run = Object.hasOwn(MODES, String(req?.mode)) ? MODES[req.mode] : null
  if (!run) throw new Error(`Unknown mode: ${String(req?.mode)}`)
  return run(req)
}

if (isMain(import.meta.url)) runHelper(main)
