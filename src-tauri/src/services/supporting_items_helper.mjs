// Supporting-items helper for Fabricator: creates, updates, reads, refreshes and
// deletes the Power BI semantic models that Copilot defines as TMDL files in an
// app's repo, and the lakehouses their data is staged in (uploading the files and
// loading the tables), once the user approves them. With `authModule` (the app's Rayfin CLI
// auth module, `@microsoft/rayfin-cli/dist/auth/index.js`), every token comes from
// the app's Fabric account, the one it publishes with, so its items are where the
// app can read them; else from the Azure CLI. That account's Power BI token can
// read a model but not start or check its refreshes (it has no
// Dataset.ReadWrite.All), so those fall back to the Azure CLI's, when that's
// signed in to the same organization. OneLake (a lakehouse's files) takes only a
// storage token, which that account can't get, so uploads and reading a table's
// columns use the Azure CLI's on the same terms.
//
// argv: <request>, a JSON string or @<path> to a UTF-8 JSON file holding it (create
// and update requests carry base64 parts and can exceed the command-line limit;
// the caller owns the file and deletes it afterwards). Any request can carry
// "authModule":"<path>".
//   {"mode":"account"}
//   {"mode":"listWorkspaces"}
//   {"mode":"getItem","workspaceId":"<guid>","itemId":"<guid>"}
//   {"mode":"findItem","workspaceId":"<guid>","type":"SemanticModel","displayName":"<name>"}
//   {"mode":"getDefinition","workspaceId":"<guid>","itemId":"<guid>","format"?:"TMDL"|"TMSL"}
//   {"mode":"create","workspaceId":"<guid>","displayName":"<name>","description"?:"<text>","parts":[{"path","payload"}]}
//   {"mode":"updateDefinition","workspaceId":"<guid>","itemId":"<guid>","parts":[…],"allowPurgeData"?:false}
//   {"mode":"refresh","workspaceId":"<guid>","itemId":"<guid>"}
//   {"mode":"refreshStatus","workspaceId":"<guid>","itemId":"<guid>","refreshId"?:"<guid>"}
//   {"mode":"delete","workspaceId":"<guid>","itemId":"<guid>"}
//   {"mode":"createLakehouse","workspaceId":"<guid>","displayName":"<name>","description"?:"<text>"}
//   {"mode":"getLakehouse","workspaceId":"<guid>","itemId":"<guid>"}
//   {"mode":"listTables","workspaceId":"<guid>","itemId":"<guid>"}
//   {"mode":"loadTable","workspaceId":"<guid>","itemId":"<guid>","table":"<name>","relativePath":"Files/…",
//    "pathType"?:"File"|"Folder","format"?:"Csv"|"Parquet","header"?:true,"delimiter"?:","}
//   {"mode":"uploadCheck"}
//   {"mode":"uploadFiles","workspaceId":"<guid>","itemId":"<guid>","oneLake"?:"<url>","files":[{"local","remote":"Files/…"}]}
//   {"mode":"tableSchema","workspaceId":"<guid>","itemId":"<guid>","oneLake"?:"<url>","table":"<name>"}
//
// Writes exactly one JSON line to stdout; all logging goes to stderr. Failures are
// {ok:false, error, needsLogin, needsAz, …} with optional classification
// fields: status, errorCode, details, nameInUse, forbidden, notFound,
// purgeRequired, throttled, timedOut, alreadyRunning, refreshNotAllowed,
// uploadNotAllowed.

import { readFileSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import {
  NeedsAz,
  NeedsLogin,
  apiUrl,
  azToken,
  checkAuthentication,
  errorMessage,
  errorResult,
  isMain,
  makeRayfinTokens,
  runHelper
} from './fabric_auth_helper.mjs'

const FABRIC_RESOURCE = 'https://api.fabric.microsoft.com'
const PBI_RESOURCE = 'https://analysis.windows.net/powerbi/api'
const PBI = 'https://api.powerbi.com/v1.0/myorg'
const STORAGE_RESOURCE = 'https://storage.azure.com'
// OneLake's global host; Fabric gives each lakehouse's paths on its organization's own.
const ONELAKE = 'https://onelake.dfs.fabric.microsoft.com'
const ONELAKE_VERSION = '2023-11-03'
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_NAME = 256
const ATTEMPTS = 4
const REQUEST_TIMEOUT_MS = 60_000
const WRITE_DEADLINE_MS = 10 * 60_000
const READ_DEADLINE_MS = 3 * 60_000
const PAGE_LIMIT = 100
const DETAIL_LIMIT = 3

// The Fabric API root (`.../v1`), overridable for non-prod via RAYFIN_FABRIC_API_URL.
export function fabricApiBase() {
  return (process.env.RAYFIN_FABRIC_API_URL || 'https://api.fabric.microsoft.com/v1')
    .trim()
    .replace(/\/+$/, '')
}

function defaultDeps() {
  return {
    fetch: (url, init) => globalThis.fetch(url, init),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    token: (resource) => azToken(resource),
    // Whose sign-in `token` is: 'az' (the Azure CLI) or 'rayfin' (the app's Fabric account).
    provider: 'az',
    // The Azure CLI's, for a refresh the app's Fabric account isn't allowed to start.
    azToken: (resource) => azToken(resource),
    rayfinTokens: (authModule) => makeRayfinTokens(authModule),
    // Reads a file to upload: a FileHandle's stat, read and close.
    open: (path) => openFile(path, 'r'),
    fabric: fabricApiBase(),
    pbi: PBI
  }
}

// A token's claims, read locally: who and which organization it's for.
export function claimsOf(token) {
  try {
    const payload = String(token).split('.')[1]
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

// ── Request parsing and validation ──────────────────────────────────────────
export function parseRequest(arg, read = (path) => readFileSync(path, 'utf8')) {
  const value = String(arg ?? '')
  if (!value.trim()) throw new Error('usage: <requestJson | @requestFile>')
  let text = value
  if (value.startsWith('@')) {
    try {
      text = read(value.slice(1))
    } catch (error) {
      throw new Error(`The request file couldn't be read (${error?.code || errorMessage(error)}).`)
    }
  }
  let request
  try {
    request = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error("The request isn't valid JSON.")
  }
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('The request must be a JSON object.')
  return request
}

class Invalid extends Error {}

function guid(value, message) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!GUID.test(id)) throw new Invalid(message)
  return id
}

function displayName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new Invalid('A display name is required.')
  if (name.length > MAX_NAME)
    throw new Invalid(`The display name must be ${MAX_NAME} characters or fewer.`)
  return name
}

function description(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Invalid('The description must be text.')
  if (value.length > MAX_NAME)
    throw new Invalid(`The description must be ${MAX_NAME} characters or fewer.`)
  return value
}

function safePartPath(path) {
  if (typeof path !== 'string' || !path.trim() || path !== path.trim() || /[\0]/.test(path))
    return false
  if (/^[\\/]/.test(path) || /^[a-z]:/i.test(path)) return false
  return !path.split(/[\\/]/).some((segment) => segment === '..')
}

export function definitionParts(value) {
  if (!Array.isArray(value) || !value.length)
    throw new Invalid('At least one definition part is required.')
  return value.map((part, index) => {
    if (!safePartPath(part?.path)) {
      throw new Invalid(`Definition part ${index + 1} needs a relative path without '..' segments.`)
    }
    if (typeof part.payload !== 'string' || !BASE64.test(part.payload)) {
      throw new Invalid(`Definition part ${part.path} needs a base64 payload.`)
    }
    return { path: part.path, payload: part.payload, payloadType: 'InlineBase64' }
  })
}

const isPlatformPart = (part) => /^\.platform$/i.test(part.path)

// ── HTTP ─────────────────────────────────────────────────────────────────────
// Seconds to wait from a Retry-After header, within [min, max].
export function retryAfter(headers, fallback, min, max) {
  const seconds = Number.parseInt(headers?.get?.('retry-after') ?? '', 10)
  return Math.max(min, Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds : fallback, max))
}

// JSON when labelled so; an operation result may arrive as octet-stream, so JSON-
// looking text is parsed too. Anything else is kept as `{ _text }`.
async function readBody(response) {
  const raw = await response.text().catch(() => '')
  if (!raw) return null
  const type = response.headers.get('content-type') || ''
  if (type.includes('json') || /^\s*[{[]/.test(raw)) {
    try {
      return JSON.parse(raw)
    } catch {
      // Fall through and keep the text.
    }
  }
  return { _text: raw }
}

const SERVICES = {
  fabric: { name: 'Fabric', resource: FABRIC_RESOURCE, base: (deps) => deps.fabric },
  pbi: { name: 'Power BI', resource: PBI_RESOURCE, base: (deps) => deps.pbi },
  onelake: { name: 'OneLake', resource: STORAGE_RESOURCE, base: (deps) => deps.onelake || ONELAKE }
}

// One bearer token per resource and run. Every URL, including Location headers and
// continuation links, must stay on Fabric/Power BI hosts. 429/503 are retried.
function makeClient(deps) {
  const tokens = new Map()
  const token = (resource) => {
    if (!tokens.has(resource))
      tokens.set(
        resource,
        Promise.resolve().then(() => deps.token(resource))
      )
    return tokens.get(resource)
  }
  // A body of bytes goes as it is (a file's chunk, to OneLake); anything else as JSON.
  const request = async (url, method, bearer, body, headers = {}) => {
    const raw = body instanceof Uint8Array
    return deps.fetch(url, {
      method,
      headers: {
        ...(body === undefined
          ? {}
          : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }),
        ...headers,
        Authorization: 'Bearer ' + bearer
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  }
  // Power BI also answers 401 when the caller only lacks permission on the model.
  // That means signing in again only if the token fails a normal read too.
  const provider = deps.provider === 'rayfin' ? 'rayfin' : 'az'
  let verified = null
  const powerBiTokenWorks = () =>
    (verified ||= (async () => {
      const response = await request(
        apiUrl(`${deps.pbi}/groups?$top=1`, deps.pbi),
        'GET',
        await token(PBI_RESOURCE)
      )
      checkAuthentication(response, provider)
      return response.ok
    })().catch((error) => {
      if (error instanceof NeedsAz || error instanceof NeedsLogin) throw error
      return false
    }))
  async function send(service, method, url, body, headers) {
    const { name, resource, base } = SERVICES[service]
    const target = apiUrl(url, base(deps))
    const bearer = await token(resource)
    for (let attempt = 1; ; attempt++) {
      let response
      try {
        response = await request(target, method, bearer, body, headers)
      } catch (error) {
        const reason = errorMessage(error?.cause?.code || error)
        throw new Error(
          `${name} couldn't be reached (${reason}). Check your connection and try again.`
        )
      }
      const challenge = /insufficient_claims/i.test(response.headers.get('www-authenticate') || '')
      if (
        service !== 'pbi' ||
        response.status !== 401 ||
        challenge ||
        !(await powerBiTokenWorks())
      ) {
        checkAuthentication(response, provider)
      }
      const busy = response.status === 429 || response.status === 503
      if (busy && attempt < ATTEMPTS) {
        await response.text().catch(() => '')
        await deps.sleep(retryAfter(response.headers, 5, 1, 30) * 1000)
        continue
      }
      return {
        status: response.status,
        headers: response.headers,
        body: await readBody(response),
        throttled: busy
      }
    }
  }
  return {
    fabricBase: deps.fabric,
    pbiBase: deps.pbi,
    fabric: (method, url, body) => send('fabric', method, url, body),
    pbi: (method, url, body) => send('pbi', method, url, body),
    onelake: (method, url, body, headers) =>
      send('onelake', method, url, body, { 'x-ms-version': ONELAKE_VERSION, ...headers })
  }
}

// ── Failures ─────────────────────────────────────────────────────────────────
const text = (value) => (typeof value === 'string' ? value.trim() : '')
const list = (value) => (Array.isArray(value) ? value : [])
const FORBIDDEN_CODE =
  /Insufficient(?:Privileges|Permissions?|WorkspaceRole|Scopes?)|Unauthorized|PermissionDenied|Forbidden|AccessDenied/i
const NOT_FOUND_CODE = /^(?:ItemNotFound|EntityNotFound|WorkspaceNotFound|NotFound)$/i
const NAME_IN_USE_CODE = /^ItemDisplayNameAlreadyInUse$/i
// An update Fabric refuses because applying it would discard data already loaded
// into the model: its error code mentions a purge, or its text names the
// allowPurgeData option, a purge, or data that would be dropped, lost or cleared.
const PURGE_TEXT = new RegExp(
  [
    /allowPurgeData/.source,
    /\bpurg(?:e|es|ed|ing)\b/.source,
    /\bdata loss\b/.source,
    /\b(?:data|rows|values)\b[^.]{0,80}?\b(?:would|will|could|might|must|needs? to|has to|have to) be (?:dropped|lost|discarded|deleted|cleared|removed|purged)\b/
      .source,
    /\b(?:drop|dropping|lose|losing|discard|discarding|clear|clearing|delete|deleting|remove|removing)\b[^.]{0,40}?\b(?:loaded|existing|imported|cached|refreshed) data\b/
      .source
  ].join('|'),
  'i'
)

const sentence = (value) => {
  const line = errorMessage(value).replace(/\s+/g, ' ').trim().slice(0, 400)
  return /[.!?]$/.test(line) ? line : line + '.'
}

// Fabric errors are {errorCode, message, moreDetails, relatedResource} (under
// `error` in a failed operation's state); Power BI's are {error: {code, message,
// details}}, sometimes with `pbi.error` details.
export function describeApiError(body) {
  const inner =
    body?.error && typeof body.error === 'object'
      ? body.error
      : body && typeof body === 'object'
        ? body
        : {}
  const code = text(inner.errorCode) || text(inner.code) || null
  const page = text(body?._text)
  const message =
    text(inner.message) ||
    text(body?.error) ||
    text(body?.message) ||
    (/^</.test(page) ? '' : page.slice(0, 400))
  const raw = [
    ...list(inner.moreDetails),
    ...list(inner.details),
    ...list(inner['pbi.error']?.details)
  ]
  const details = raw
    .map((detail) => ({
      code: text(detail?.errorCode) || text(detail?.code) || null,
      message: text(detail?.message) || text(detail?.detail?.value),
      related: [
        detail?.relatedResource?.resourceId,
        detail?.relatedResource?.resourceType,
        detail?.target
      ]
        .filter((value) => typeof value === 'string')
        .join(' ')
    }))
    .filter((detail) => detail.code || detail.message)
  const related = [inner.relatedResource?.resourceId, inner.relatedResource?.resourceType]
    .filter((value) => typeof value === 'string')
    .join(' ')
  return { code, message, details, related }
}

function withoutUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== false)
  )
}

export function failure(message, extra = {}) {
  return { ...errorResult(new Error(message)), needsLogin: false, ...withoutUndefined(extra) }
}

// A readable one-sentence failure plus its classification. `response` is an HTTP
// response ({status, body, throttled}) or a failed operation ({body: state.error}).
export function apiFailure(service, action, response, { purge = false } = {}) {
  const { status, body, throttled } = response
  const info = describeApiError(body)
  const label = [status ? `HTTP ${status}` : null, info.code].filter(Boolean).join(', ')
  let message = `${service} couldn't ${action}${label ? ` (${label})` : ''}`
  message += info.message ? `: ${sentence(info.message)}` : '.'
  const more = info.details
    .filter((detail) => detail.message && detail.message !== info.message)
    .slice(0, DETAIL_LIMIT)
  if (more.length)
    message += ` Details: ${more.map((detail) => sentence(detail.message)).join(' ')}`
  if (throttled) message += ' The service is busy; try again in a few minutes.'
  const codes = [info.code, ...info.details.map((detail) => detail.code)].filter(Boolean)
  const all = [info.message, ...codes, ...info.details.map((detail) => detail.message)].join('\n')
  return failure(message, {
    status: status || undefined,
    errorCode: info.code || undefined,
    details: info.details.length
      ? info.details.map(({ code, message }) => ({ code, message: errorMessage(message) }))
      : undefined,
    nameInUse: codes.some((code) => NAME_IN_USE_CODE.test(code)),
    // A Power BI 401 only gets here once the token has passed a normal read.
    forbidden: status === 403 || status === 401 || codes.some((code) => FORBIDDEN_CODE.test(code)),
    notFound: status === 404 || NOT_FOUND_CODE.test(info.code || ''),
    purgeRequired: purge && (codes.some((code) => /purge/i.test(code)) || PURGE_TEXT.test(all)),
    throttled: !!throttled
  })
}

// Whether a failed create points at the `.platform` part (its message, a detail,
// or a related resource), so the create can be retried without it.
function blamesPlatformPart(body) {
  const info = describeApiError(body)
  const all = [
    info.message,
    info.related,
    ...info.details.flatMap((detail) => [detail.message, detail.related])
  ]
  return all.some((value) => /(?:^|[^\w])\.platform\b/i.test(value || ''))
}

// ── Long-running operations (Fabric) ────────────────────────────────────────
// The poll URL's result: `{operation}/result`, the Get Operation Result API.
export function operationResultUrl(pollUrl) {
  const url = new URL(pollUrl)
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (!/\/result$/i.test(url.pathname)) url.pathname += '/result'
  return url.href
}

// Follows a 202's operation (its Location, else /operations/{x-ms-operation-id})
// until it succeeds or fails, honoring Retry-After (2 s by default, within 1–10 s).
// → {ok:true, resultUrl, result?} | {ok:false, result: <failure>, errorBody?}
async function awaitOperation(client, deps, accepted, { action, deadlineMs, purge = false }) {
  const location = accepted.headers.get('location')
  const operationId = text(accepted.headers.get('x-ms-operation-id'))
  if (!location && !operationId) {
    return {
      ok: false,
      result: failure(
        `Fabric accepted the request to ${action} but returned no operation to follow.`
      )
    }
  }
  const pollUrl = location
    ? apiUrl(location, client.fabricBase)
    : apiUrl(
        `${client.fabricBase}/operations/${encodeURIComponent(operationId)}`,
        client.fabricBase
      )
  const deadline = deps.now() + deadlineMs
  let wait = retryAfter(accepted.headers, 2, 1, 10)
  let serverErrors = 0
  for (;;) {
    await deps.sleep(wait * 1000)
    const res = await client.fabric('GET', pollUrl)
    wait = retryAfter(res.headers, 2, 1, 10)
    if (res.status >= 400) {
      // A passing server error doesn't end the operation; a persistent one does.
      if (res.status < 500 || res.throttled || ++serverErrors >= 5) {
        return { ok: false, result: apiFailure('Fabric', action, res, { purge }) }
      }
    } else {
      serverErrors = 0
      const state = text(res.body?.status).toLowerCase()
      if (!state && (res.body?.definition || text(res.body?.id))) {
        return { ok: true, resultUrl: operationResultUrl(pollUrl), result: res.body }
      }
      if (state === 'succeeded') return { ok: true, resultUrl: operationResultUrl(pollUrl) }
      if (state === 'failed') {
        const errorBody = res.body?.error ?? res.body
        return {
          ok: false,
          result: apiFailure('Fabric', action, { body: errorBody }, { purge }),
          errorBody
        }
      }
    }
    if (deps.now() >= deadline) {
      const minutes = Math.round(deadlineMs / 60_000)
      return {
        ok: false,
        result: failure(
          `Fabric didn't finish trying to ${action} within ${minutes} minutes. Check the workspace in Fabric before trying again.`,
          { timedOut: true }
        )
      }
    }
  }
}

// ── Fabric items ─────────────────────────────────────────────────────────────
const ITEM_NOT_FOUND_CODE = /^(?:ItemNotFound|EntityNotFound)$/i

// The URL of a Fabric list's next page, or null after its last one.
function nextPage(body, start) {
  if (body.continuationUri) return apiUrl(body.continuationUri, start)
  if (!body.continuationToken) return null
  const next = new URL(start)
  next.searchParams.set('continuationToken', body.continuationToken)
  return next.href
}

function itemSummary(item) {
  return {
    id: String(item.id),
    displayName: String(item.displayName ?? ''),
    type: String(item.type ?? ''),
    description: String(item.description ?? '')
  }
}

const isGone = (res) =>
  res.status === 404 || ITEM_NOT_FOUND_CODE.test(describeApiError(res.body).code || '')

async function runGetItem(client, _deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const itemId = guid(req.itemId, 'An item id is required.')
  const res = await client.fabric(
    'GET',
    `${client.fabricBase}/workspaces/${workspaceId}/items/${itemId}`
  )
  if (res.status === 200 && text(res.body?.id))
    return { ok: true, found: true, item: itemSummary(res.body) }
  if (isGone(res)) return { ok: true, found: false }
  return apiFailure('Fabric', 'read the item', res)
}

// The workspace's first item of `type` named `name` (trimmed, case-insensitive),
// following Fabric's continuation links.
async function findItem(client, workspaceId, type, name) {
  const start = `${client.fabricBase}/workspaces/${workspaceId}/items?type=${encodeURIComponent(type)}`
  const wanted = name.trim().toLowerCase()
  const seen = new Set()
  let url = start
  for (let page = 0; url; page++) {
    if (page >= PAGE_LIMIT)
      return failure('Fabric returned too many pages to finish looking for the item.')
    if (seen.has(url)) return failure('Fabric returned a repeated continuation link.')
    seen.add(url)
    const res = await client.fabric('GET', url)
    if (res.status !== 200 || !Array.isArray(res.body?.value))
      return apiFailure('Fabric', "list the workspace's items", res)
    const match = res.body.value.find(
      (item) =>
        text(item?.id) &&
        text(item.displayName).toLowerCase() === wanted &&
        (!item.type || String(item.type).toLowerCase() === type.toLowerCase())
    )
    if (match) return { ok: true, found: true, item: itemSummary(match) }
    url = nextPage(res.body, start)
  }
  return { ok: true, found: false }
}

// The shared workspaces the account can create items in (Admin, Member or Contributor),
// by name. My workspace is left out: items there can't be shared through a role, so the
// app's other users couldn't read a model in it.
async function runListWorkspaces(client) {
  const start = `${client.fabricBase}/workspaces?roles=Admin,Member,Contributor`
  const seen = new Set()
  const workspaces = []
  let url = start
  for (let page = 0; url; page++) {
    if (page >= PAGE_LIMIT) return failure('Fabric returned too many pages of workspaces.')
    if (seen.has(url)) return failure('Fabric returned a repeated continuation link.')
    seen.add(url)
    const res = await client.fabric('GET', url)
    if (res.status !== 200 || !Array.isArray(res.body?.value))
      return apiFailure('Fabric', 'list your workspaces', res)
    for (const workspace of res.body.value) {
      if (!text(workspace?.id) || /^personal$/i.test(text(workspace.type))) continue
      workspaces.push({ id: text(workspace.id), displayName: text(workspace.displayName) })
    }
    url = nextPage(res.body, start)
  }
  workspaces.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
  )
  return { ok: true, workspaces }
}

async function runFindItem(client, _deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const type =
    req.type === undefined || req.type === null || req.type === '' ? 'SemanticModel' : req.type
  if (typeof type !== 'string' || !/^[A-Za-z]{1,64}$/.test(type))
    throw new Invalid('The item type is invalid.')
  return findItem(client, workspaceId, type, displayName(req.displayName))
}

async function runGetDefinition(client, deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const itemId = guid(req.itemId, 'A semantic model id is required.')
  const format =
    req.format === undefined || req.format === null || req.format === '' ? null : req.format
  if (format !== null && format !== 'TMDL' && format !== 'TMSL')
    throw new Invalid('The definition format must be TMDL or TMSL.')
  const action = "read the semantic model's definition"
  const url =
    `${client.fabricBase}/workspaces/${workspaceId}/semanticModels/${itemId}/getDefinition` +
    (format ? `?format=${format}` : '')
  let res = await client.fabric('POST', url)
  if (res.status === 202) {
    const operation = await awaitOperation(client, deps, res, {
      action,
      deadlineMs: READ_DEADLINE_MS
    })
    if (!operation.ok) return operation.result
    res = operation.result
      ? { status: 200, body: operation.result }
      : await client.fabric('GET', operation.resultUrl)
  }
  if (res.status !== 200) return apiFailure('Fabric', action, res)
  const parts = list(res.body?.definition?.parts)
    .filter((part) => typeof part?.path === 'string')
    .map((part) => ({
      path: part.path,
      payload: typeof part.payload === 'string' ? part.payload : ''
    }))
  if (!parts.length)
    return failure("Fabric returned the semantic model's definition without any parts.")
  return { ok: true, parts }
}

// One create attempt → {ok:true, result} | {ok:false, result: <failure>, errorBody?}
async function createOnce(client, deps, workspaceId, name, desc, parts) {
  const action = 'create the semantic model'
  const created = (item) => ({
    ok: true,
    result: { ok: true, itemId: String(item.id), displayName: text(item.displayName) || name }
  })
  const lookUp = async () => {
    const found = await findItem(client, workspaceId, 'SemanticModel', name)
    if (!found.ok) return { ok: false, result: found }
    if (found.found) return created(found.item)
    return {
      ok: false,
      result: failure(
        "Fabric reported the semantic model as created, but it couldn't be found in the workspace."
      )
    }
  }
  const body = {
    displayName: name,
    ...(desc === undefined ? {} : { description: desc }),
    definition: { format: 'TMDL', parts }
  }
  const res = await client.fabric(
    'POST',
    `${client.fabricBase}/workspaces/${workspaceId}/semanticModels`,
    body
  )
  if (res.status === 200 || res.status === 201)
    return text(res.body?.id) ? created(res.body) : lookUp()
  if (res.status !== 202)
    return { ok: false, result: apiFailure('Fabric', action, res), errorBody: res.body }
  const operation = await awaitOperation(client, deps, res, {
    action,
    deadlineMs: WRITE_DEADLINE_MS
  })
  if (!operation.ok) return operation
  let item = operation.result
  if (!item) {
    const result = await client.fabric('GET', operation.resultUrl)
    if (result.status === 200) item = result.body
    else if (result.status !== 404 && result.status !== 400) {
      return { ok: false, result: apiFailure('Fabric', 'read the created semantic model', result) }
    }
  }
  return text(item?.id) ? created(item) : lookUp()
}

async function runCreate(client, deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const name = displayName(req.displayName)
  const desc = description(req.description)
  const parts = definitionParts(req.parts)
  const first = await createOnce(client, deps, workspaceId, name, desc, parts)
  if (first.ok) return first.result
  // Fabric validates `.platform` strictly; the model's own parts are what matter.
  if (
    first.errorBody === undefined ||
    !parts.some(isPlatformPart) ||
    !blamesPlatformPart(first.errorBody)
  ) {
    return first.result
  }
  const retry = await createOnce(
    client,
    deps,
    workspaceId,
    name,
    desc,
    parts.filter((part) => !isPlatformPart(part))
  )
  return retry.ok ? { ...retry.result, withoutPlatform: true } : retry.result
}

async function runUpdateDefinition(client, deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const itemId = guid(req.itemId, 'A semantic model id is required.')
  const parts = definitionParts(req.parts)
  if (
    req.allowPurgeData !== undefined &&
    req.allowPurgeData !== null &&
    typeof req.allowPurgeData !== 'boolean'
  ) {
    throw new Invalid('allowPurgeData must be true or false.')
  }
  const action = "update the semantic model's definition"
  const body = {
    definition: { format: 'TMDL', parts },
    ...(req.allowPurgeData === true ? { options: { allowPurgeData: true } } : {})
  }
  const url = `${client.fabricBase}/workspaces/${workspaceId}/semanticModels/${itemId}/updateDefinition`
  const res = await client.fabric('POST', url, body)
  if (res.status === 200) return { ok: true }
  if (res.status !== 202) return apiFailure('Fabric', action, res, { purge: true })
  const operation = await awaitOperation(client, deps, res, {
    action,
    deadlineMs: WRITE_DEADLINE_MS,
    purge: true
  })
  return operation.ok ? { ok: true } : operation.result
}

async function runDelete(client, _deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const itemId = guid(req.itemId, 'An item id is required.')
  const res = await client.fabric(
    'DELETE',
    `${client.fabricBase}/workspaces/${workspaceId}/items/${itemId}`
  )
  if (res.status === 200 || res.status === 204) return { ok: true }
  if (isGone(res)) return { ok: true, alreadyGone: true }
  return apiFailure('Fabric', 'delete the item', res)
}

// ── Power BI refresh ─────────────────────────────────────────────────────────
// Enhanced refresh takes no notifyOption (Power BI rejects it alongside enhanced
// parameters); a standard refresh needs it. Only enhanced refreshes can be
// looked up by id.
const ENHANCED_REFRESH = { type: 'full', commitMode: 'transactional' }
const STANDARD_REFRESH = { notifyOption: 'NoNotification' }
const ALREADY_RUNNING =
  /\balready (?:in progress|running|executing|underway|being refreshed)\b|\banother refresh\b|\b(?:refresh|operation) (?:is )?(?:currently |still )?(?:in progress|running|executing)\b|\bonly one refresh\b/i

function alreadyRunning(res) {
  if (res.status === 409) return true
  if (res.status !== 400) return false
  const info = describeApiError(res.body)
  return ALREADY_RUNNING.test(
    [info.code, info.message, ...info.details.map((detail) => detail.message)].join('\n')
  )
}

function refreshFailure(res) {
  const result = apiFailure('Power BI', 'start a refresh', res)
  return alreadyRunning(res) ? { ...result, alreadyRunning: true } : result
}

// The refresh id from a 202's Location (…/refreshes/{id}), else its request-id header.
export function refreshIdFrom(headers) {
  const location = headers.get('location')
  if (location) {
    try {
      const match = new URL(location, PBI).pathname.match(/\/refreshes\/([^/]+)\/?$/i)
      const id = match ? decodeURIComponent(match[1]) : ''
      if (GUID.test(id)) return id
    } catch {
      // An unusable Location: fall back to the request-id headers.
    }
  }
  const id = text(headers.get('x-ms-request-id')) || text(headers.get('requestid'))
  return GUID.test(id) ? id : undefined
}

async function startRefresh(client, url) {
  const enhanced = await client.pbi('POST', url, ENHANCED_REFRESH)
  if (enhanced.status === 202 || enhanced.status === 200) {
    const refreshId = refreshIdFrom(enhanced.headers)
    return { ok: true, ...(refreshId ? { refreshId } : {}), enhanced: true }
  }
  // Shared capacities and some models refuse enhanced refresh: fall back once.
  if (
    (enhanced.status !== 400 && enhanced.status !== 403) ||
    enhanced.throttled ||
    alreadyRunning(enhanced)
  ) {
    return refreshFailure(enhanced)
  }
  const standard = await client.pbi('POST', url, STANDARD_REFRESH)
  if (standard.status === 202 || standard.status === 200) return { ok: true, enhanced: false }
  return refreshFailure(standard)
}

// A client whose Power BI calls use the Azure CLI's sign-in, when the app's Fabric
// account may not start a refresh: only when it's signed in to the same organization.
async function sameOrganizationAzure(deps) {
  if (deps.provider !== 'rayfin' || typeof deps.azToken !== 'function') return null
  let own, az
  try {
    own = await deps.token(PBI_RESOURCE)
    az = await deps.azToken(PBI_RESOURCE)
  } catch {
    return null
  }
  const tenant = (token) => text(claimsOf(token)?.tid).toLowerCase()
  if (!tenant(own) || tenant(own) !== tenant(az)) return null
  return makeClient({ ...deps, provider: 'az', token: async () => az })
}

// Power BI lets the app's Fabric account read a model but not start or check its
// refreshes. Those retry as the Azure CLI when it's signed in to the same
// organization; else the result says why, so the user can refresh in Fabric.
async function asRefresher(client, deps, attempt, action) {
  const first = await attempt(client)
  if (first.ok || !first.forbidden || first.alreadyRunning || deps.provider !== 'rayfin')
    return first
  const azure = await sameOrganizationAzure(deps)
  let retried = null
  if (azure) {
    try {
      retried = await attempt(azure)
    } catch (error) {
      if (!(error instanceof NeedsAz)) throw error
    }
  }
  if (retried && (retried.ok || !retried.forbidden)) return retried
  return {
    ...(retried ?? first),
    refreshNotAllowed: true,
    error:
      `Power BI lets your Fabric sign-in read the model but not ${action}` +
      (azure
        ? ', and turned down the Azure CLI’s sign-in too.'
        : ', and the Azure CLI isn’t signed in to the same organization.')
  }
}

async function runRefresh(client, deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const itemId = guid(req.itemId, 'A semantic model id is required.')
  const url = `${client.pbiBase}/groups/${workspaceId}/datasets/${itemId}/refreshes`
  return asRefresher(client, deps, (as) => startRefresh(as, url), 'start a refresh')
}

// Who the requests are made as: the account and organization of the Fabric token.
async function runAccount(_client, deps) {
  const claims = claimsOf(await deps.token(FABRIC_RESOURCE)) ?? {}
  const user = [claims.upn, claims.preferred_username, claims.unique_name, claims.email]
    .map(text)
    .find(Boolean)
  return {
    ok: true,
    ...(user ? { user } : {}),
    ...(text(claims.tid) ? { tenant: text(claims.tid) } : {})
  }
}

const REFRESH_STATES = new Map([
  ['notstarted', 'notStarted'],
  ['inprogress', 'running'],
  ['running', 'running'],
  // "Unknown": the completion state is unknown, or the refresh is in progress.
  ['unknown', 'running'],
  ['completed', 'succeeded'],
  ['succeeded', 'succeeded'],
  ['failed', 'failed'],
  ['timedout', 'failed'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled'],
  ['disabled', 'cancelled']
])

// notStarted | running | succeeded | failed | cancelled | unknown, preferring the
// more specific extendedStatus.
export function refreshState(status, extendedStatus) {
  const extended = text(extendedStatus).toLowerCase()
  if (extended !== 'unknown' && REFRESH_STATES.has(extended)) return REFRESH_STATES.get(extended)
  return REFRESH_STATES.get(text(status).toLowerCase()) ?? REFRESH_STATES.get(extended) ?? 'unknown'
}

function parameterMessages(parameters) {
  if (Array.isArray(parameters)) {
    return parameters.map((parameter) => ({
      code: text(parameter?.name) || null,
      message: text(parameter?.message) || text(parameter?.value)
    }))
  }
  if (!parameters || typeof parameters !== 'object') return []
  return Object.entries(parameters).map(([name, value]) => ({
    code: name,
    message: typeof value === 'string' ? value.trim() : text(value?.value) || text(value?.message)
  }))
}

// A refresh's serviceExceptionJson → [{code, message}]: its errorCode and
// errorDescription, or a nested `error` with `pbi.error` details and parameters.
// Text that isn't JSON is kept as the message.
export function serviceExceptionErrors(value) {
  if (value === undefined || value === null || value === '') return []
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return [{ code: null, message: value.trim() }]
    }
  }
  if (!parsed || typeof parsed !== 'object') return [{ code: null, message: String(value).trim() }]
  const inner = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed
  const pbiError = inner['pbi.error'] ?? inner.pbi?.error ?? parsed['pbi.error'] ?? {}
  const code =
    text(parsed.errorCode) ||
    text(inner.code) ||
    text(inner.errorCode) ||
    text(pbiError.code) ||
    null
  const main =
    text(parsed.errorDescription) ||
    text(inner.message) ||
    text(inner.errorDescription) ||
    text(pbiError.message)
  const extra = [
    ...list(pbiError.details).map((detail) => ({
      code: text(detail?.code) || null,
      message: text(detail?.detail?.value) || text(detail?.message)
    })),
    ...parameterMessages(pbiError.parameters ?? inner.parameters)
  ].filter((entry) => entry.message && !/^-?\d+$/.test(entry.message))
  const errors = []
  if (code || main || extra.length)
    errors.push({ code, message: main || extra[0]?.message || code })
  for (const entry of extra)
    if (!errors.some((error) => error.message === entry.message)) errors.push(entry)
  return errors.slice(0, 10)
}

// The data source has no usable credentials: they were never entered, expired
// (OAuth) or were rejected.
const CREDENTIAL_CODE = /credential|OAuth/i
const CREDENTIAL_TEXT =
  /\bcredentials?\b|\b(?:sign|log)[ -]?in (?:to|for) (?:the |this |your |each )?data ?sources?\b|\bdata ?sources?\b[^.]{0,60}\b(?:requires? (?:you to )?(?:sign|log)[ -]?in|authenticat\w*)\b/i
const needsCredentials = (errors) =>
  errors.some(
    (error) => CREDENTIAL_CODE.test(error.code || '') || CREDENTIAL_TEXT.test(error.message || '')
  )

// A refresh-details or refresh-history entry → the refreshStatus result.
export function refreshSummary(entry, refreshId) {
  const status = refreshState(entry?.status, entry?.extendedStatus)
  const toError = (message) => ({
    code: text(message.code) || null,
    message: text(message.message) || text(message.code)
  })
  const messages = list(entry?.messages).filter(
    (message) => text(message?.message) || text(message?.code)
  )
  const warning = (message) => /^warning$/i.test(text(message.type))
  let errors = messages.filter((message) => !warning(message)).map(toError)
  if (!errors.length && status === 'failed') errors = messages.filter(warning).map(toError)
  const attempts = status === 'failed' ? list(entry?.refreshAttempts) : []
  const exception =
    text(entry?.serviceExceptionJson) ||
    text(
      [...attempts].reverse().find((attempt) => text(attempt?.serviceExceptionJson))
        ?.serviceExceptionJson
    )
  for (const error of serviceExceptionErrors(exception)) {
    if (!errors.some((known) => known.message === error.message)) errors.push(error)
  }
  return {
    ok: true,
    status,
    ...(refreshId ? { refreshId } : {}),
    ...(text(entry?.startTime) ? { startTime: text(entry.startTime) } : {}),
    ...(text(entry?.endTime) ? { endTime: text(entry.endTime) } : {}),
    errors,
    ...(needsCredentials(errors) ? { needsCredentials: true } : {})
  }
}

async function runRefreshStatus(client, deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const itemId = guid(req.itemId, 'A semantic model id is required.')
  const refreshId =
    req.refreshId === undefined || req.refreshId === null || req.refreshId === ''
      ? null
      : guid(req.refreshId, 'The refresh id is invalid.')
  const base = `${client.pbiBase}/groups/${workspaceId}/datasets/${itemId}/refreshes`
  return asRefresher(
    client,
    deps,
    (as) => refreshStatusOf(as, base, refreshId),
    'check its refresh'
  )
}

async function refreshStatusOf(client, base, refreshId) {
  if (refreshId) {
    // 202 while the refresh runs, 200 once it has finished.
    const res = await client.pbi('GET', `${base}/${refreshId}`)
    if (res.status !== 200 && res.status !== 202)
      return apiFailure('Power BI', "check the model's refresh", res)
    return refreshSummary(res.body, refreshId)
  }
  const res = await client.pbi('GET', `${base}?$top=1`)
  if (res.status !== 200 || !Array.isArray(res.body?.value)) {
    return apiFailure('Power BI', "read the model's refresh history", res)
  }
  const latest = res.body.value[0]
  if (!latest) return { ok: true, status: 'unknown', errors: [] }
  return refreshSummary(
    latest,
    GUID.test(text(latest.requestId)) ? text(latest.requestId) : undefined
  )
}

// ── Lakehouses ───────────────────────────────────────────────────────────────
// Creating a lakehouse and loading its tables is the app's Fabric account's work.
// OneLake, where its files and tables are, takes only a storage token, which that
// account can't get: files go up, and tables' columns are read, as the Azure CLI's
// sign-in, when it's signed in to the same organization.
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const ONELAKE_HOST = /^(?:[a-z0-9-]+-)?onelake\.dfs\.fabric\.microsoft\.com$/i
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
const LOAD_DEADLINE_MS = 30 * 60_000
const DELTA_COMMITS_READ = 50

function tableName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!TABLE_NAME.test(name))
    throw new Invalid('The table name must be letters, digits and underscores.')
  return name
}

// A path in the lakehouse's Files, such as `Files/data/orders.csv`.
function filesPath(value) {
  const segments = (typeof value === 'string' ? value.trim() : '').replace(/\\/g, '/').split('/')
  const unsafe = (segment) => !segment || segment === '.' || segment === '..' || /\0/.test(segment)
  if (segments[0] !== 'Files' || segments.length < 2 || segments.some(unsafe))
    throw new Invalid("The path must be in the lakehouse's Files, such as Files/data/orders.csv.")
  return segments.join('/')
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/')

// A lakehouse's OneLake address, on the host Fabric gave for its organization
// (`value`), else OneLake's global one.
export function oneLakeRoot(value, workspaceId, itemId) {
  let origin = ONELAKE
  if (typeof value === 'string' && value.trim()) {
    let url
    try {
      url = new URL(value.trim())
    } catch {
      throw new Invalid('The OneLake address is invalid.')
    }
    if (url.protocol !== 'https:' || !ONELAKE_HOST.test(url.hostname))
      throw new Invalid("The OneLake address isn't on OneLake.")
    origin = url.origin
  }
  return `${origin}/${workspaceId}/${itemId}`
}

function lakehouseSummary(item) {
  const properties = item?.properties ?? {}
  const sql = properties.sqlEndpointProperties ?? {}
  return withoutUndefined({
    id: text(item?.id),
    displayName: text(item?.displayName),
    oneLakeFilesPath: text(properties.oneLakeFilesPath) || undefined,
    oneLakeTablesPath: text(properties.oneLakeTablesPath) || undefined,
    sqlEndpoint: text(sql.connectionString) || undefined,
    sqlEndpointId: text(sql.id) || undefined
  })
}

async function runCreateLakehouse(client, deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const name = displayName(req.displayName)
  const desc = description(req.description)
  const action = 'create the lakehouse'
  const res = await client.fabric(
    'POST',
    `${client.fabricBase}/workspaces/${workspaceId}/lakehouses`,
    { displayName: name, ...(desc === undefined ? {} : { description: desc }) }
  )
  let item = res.status === 200 || res.status === 201 ? res.body : null
  if (res.status === 202) {
    const operation = await awaitOperation(client, deps, res, {
      action,
      deadlineMs: WRITE_DEADLINE_MS
    })
    if (!operation.ok) return operation.result
    item = operation.result
    if (!item) {
      const result = await client.fabric('GET', operation.resultUrl)
      if (result.status === 200) item = result.body
    }
  } else if (!item) {
    return apiFailure('Fabric', action, res)
  }
  if (!text(item?.id)) {
    const found = await findItem(client, workspaceId, 'Lakehouse', name)
    if (!found.ok) return found
    if (!found.found)
      return failure(
        "Fabric reported the lakehouse as created, but it couldn't be found in the workspace."
      )
    item = found.item
  }
  return { ok: true, itemId: text(item.id) }
}

async function runGetLakehouse(client, _deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const itemId = guid(req.itemId, 'A lakehouse id is required.')
  const res = await client.fabric(
    'GET',
    `${client.fabricBase}/workspaces/${workspaceId}/lakehouses/${itemId}`
  )
  if (res.status === 200 && text(res.body?.id))
    return { ok: true, found: true, lakehouse: lakehouseSummary(res.body) }
  if (isGone(res)) return { ok: true, found: false }
  return apiFailure('Fabric', 'read the lakehouse', res)
}

// The lakehouse's tables, by name, following Fabric's continuation links.
async function runListTables(client, _deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const itemId = guid(req.itemId, 'A lakehouse id is required.')
  const start = `${client.fabricBase}/workspaces/${workspaceId}/lakehouses/${itemId}/tables?maxResults=100`
  const seen = new Set()
  const tables = []
  let url = start
  for (let page = 0; url; page++) {
    if (page >= PAGE_LIMIT)
      return failure("Fabric returned too many pages of the lakehouse's tables.")
    if (seen.has(url)) return failure('Fabric returned a repeated continuation link.')
    seen.add(url)
    const res = await client.fabric('GET', url)
    if (res.status !== 200 || !Array.isArray(res.body?.data))
      return apiFailure('Fabric', "list the lakehouse's tables", res)
    for (const table of res.body.data) {
      if (text(table?.name))
        tables.push({ name: text(table.name), format: text(table.format) || undefined })
    }
    url = nextPage(res.body, start)
  }
  tables.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return { ok: true, tables }
}

// Load a table from files in the lakehouse's Files, replacing what it held.
async function runLoadTable(client, deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const itemId = guid(req.itemId, 'A lakehouse id is required.')
  const table = tableName(req.table)
  const relativePath = filesPath(req.relativePath)
  const folder = req.pathType === 'Folder'
  const format = req.format === 'Parquet' ? 'Parquet' : 'Csv'
  const delimiter =
    typeof req.delimiter === 'string' && req.delimiter.length === 1 ? req.delimiter : ','
  const action = `load the table ${table}`
  const body = {
    relativePath,
    pathType: folder ? 'Folder' : 'File',
    mode: 'Overwrite',
    recursive: folder,
    formatOptions:
      format === 'Csv' ? { format, header: req.header !== false, delimiter } : { format }
  }
  const res = await client.fabric(
    'POST',
    `${client.fabricBase}/workspaces/${workspaceId}/lakehouses/${itemId}/tables/${encodeURIComponent(table)}/load`,
    body
  )
  if (res.status === 200 || res.status === 201) return { ok: true }
  if (res.status !== 202) return apiFailure('Fabric', action, res)
  const operation = await awaitOperation(client, deps, res, {
    action,
    deadlineMs: LOAD_DEADLINE_MS
  })
  return operation.ok ? { ok: true } : operation.result
}

// A client for OneLake at `root`'s host, as the Azure CLI's sign-in when the
// requests are otherwise the app's Fabric account's: only when the Azure CLI is
// signed in to the same organization. → {ok:true, client, user} | {ok:false, result}
async function oneLakeAccess(deps, root) {
  const onelake = new URL(root).origin
  const claims = (token) => claimsOf(token) ?? {}
  const userOf = (token) =>
    [claims(token).upn, claims(token).preferred_username, claims(token).unique_name]
      .map(text)
      .find(Boolean)
  if (deps.provider !== 'rayfin') {
    const own = await deps.token(STORAGE_RESOURCE)
    return { ok: true, client: makeClient({ ...deps, onelake }), user: userOf(own) }
  }
  const fabricToken = await deps.token(FABRIC_RESOURCE)
  let az
  try {
    az = await deps.azToken(STORAGE_RESOURCE)
  } catch (error) {
    if (!(error instanceof NeedsAz)) throw error
    return {
      ok: false,
      result: failure(
        "Fabricator uploads files to OneLake with your Azure CLI sign-in, and the Azure CLI isn't signed in.",
        { uploadNotAllowed: true }
      )
    }
  }
  const tenant = (token) => text(claims(token).tid).toLowerCase()
  if (!tenant(fabricToken) || tenant(fabricToken) !== tenant(az)) {
    return {
      ok: false,
      result: failure(
        "Fabricator uploads files to OneLake with your Azure CLI sign-in, which is signed in to another organization than the app's Fabric account.",
        { uploadNotAllowed: true }
      )
    }
  }
  const client = makeClient({ ...deps, provider: 'az', token: async () => az, onelake })
  return { ok: true, client, user: userOf(az) }
}

// Whether files can go up to OneLake, and as whom.
async function runUploadCheck(_client, deps) {
  const access = await oneLakeAccess(deps, `${ONELAKE}/x/y`)
  if (!access.ok) return access.result
  return { ok: true, ...(access.user ? { user: access.user } : {}) }
}

// Upload one file to `remote` in the lakehouse's Files: create it (replacing one
// that's there), append it in chunks, then flush it.
async function uploadOne(client, deps, root, { local, remote }) {
  const url = `${root}/${encodePath(remote)}`
  const action = `upload ${remote}`
  let handle
  try {
    handle = await deps.open(local)
  } catch (error) {
    return failure(`${local} couldn't be read (${error?.code || errorMessage(error)}).`)
  }
  try {
    const { size } = await handle.stat()
    let res = await client.onelake('PUT', `${url}?resource=file`, undefined, {
      'Content-Length': '0'
    })
    if (res.status !== 201 && res.status !== 200) return apiFailure('OneLake', action, res)
    const buffer = new Uint8Array(Math.max(1, Math.min(UPLOAD_CHUNK_BYTES, size)))
    let position = 0
    while (position < size) {
      const wanted = Math.min(buffer.length, size - position)
      const { bytesRead } = await handle.read(buffer, 0, wanted, position)
      if (!bytesRead) break
      res = await client.onelake(
        'PATCH',
        `${url}?action=append&position=${position}`,
        buffer.subarray(0, bytesRead)
      )
      if (res.status !== 202 && res.status !== 200) return apiFailure('OneLake', action, res)
      position += bytesRead
    }
    res = await client.onelake('PATCH', `${url}?action=flush&position=${position}`, undefined, {
      'Content-Length': '0'
    })
    if (res.status !== 200) return apiFailure('OneLake', action, res)
    return { ok: true, bytes: position }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function runUploadFiles(_client, deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const itemId = guid(req.itemId, 'A lakehouse id is required.')
  const root = oneLakeRoot(req.oneLake, workspaceId, itemId)
  const files = list(req.files)
  if (!files.length) throw new Invalid('At least one file is required.')
  const wanted = files.map((file, index) => {
    if (typeof file?.local !== 'string' || !file.local.trim())
      throw new Invalid(`File ${index + 1} needs a local path.`)
    return { local: file.local, remote: filesPath(file.remote) }
  })
  const access = await oneLakeAccess(deps, root)
  if (!access.ok) return access.result
  const uploaded = []
  for (const file of wanted) {
    const result = await uploadOne(access.client, deps, root, file)
    if (!result.ok) return result
    uploaded.push({ remote: file.remote, bytes: result.bytes })
  }
  return { ok: true, uploaded }
}

// A Delta commit's columns, from its metaData action's schema: [{name, type}], or
// null when it has none. A commit is JSON lines; one of a single line arrives parsed.
export function deltaColumns(body) {
  const raw =
    typeof body?._text === 'string'
      ? body._text
      : body && typeof body === 'object'
        ? JSON.stringify(body)
        : ''
  for (const line of raw.split('\n')) {
    if (!line.includes('"metaData"')) continue
    try {
      const schema = JSON.parse(JSON.parse(line).metaData.schemaString)
      return list(schema.fields).map((field) => ({
        name: String(field.name),
        type: typeof field.type === 'string' ? field.type : String(field.type?.type ?? 'struct')
      }))
    } catch {
      // Not a metaData action after all.
    }
  }
  return null
}

// A table's columns, as its Delta log's latest schema says.
async function runTableSchema(_client, deps, req) {
  const workspaceId = guid(req.workspaceId, 'A workspace id is required.')
  const itemId = guid(req.itemId, 'A lakehouse id is required.')
  const table = tableName(req.table)
  const root = oneLakeRoot(req.oneLake, workspaceId, itemId)
  const access = await oneLakeAccess(deps, root)
  if (!access.ok) return access.result
  const action = `read the table ${table}`
  const directory = `${itemId}/Tables/${table}/_delta_log`
  const listed = await access.client.onelake(
    'GET',
    `${new URL(root).origin}/${workspaceId}?resource=filesystem&recursive=false&directory=${encodeURIComponent(directory)}`
  )
  if (listed.status === 404)
    return failure(`The table ${table} isn't in the lakehouse.`, { notFound: true })
  if (listed.status !== 200 || !Array.isArray(listed.body?.paths))
    return apiFailure('OneLake', action, listed)
  const commits = listed.body.paths
    .map((path) => text(path?.name).split('/').pop())
    .filter((name) => /^\d{20}\.json$/.test(name))
    .sort()
    .reverse()
    .slice(0, DELTA_COMMITS_READ)
  for (const commit of commits) {
    const res = await access.client.onelake(
      'GET',
      `${root}/Tables/${encodeURIComponent(table)}/_delta_log/${commit}`
    )
    if (res.status !== 200) return apiFailure('OneLake', action, res)
    const columns = deltaColumns(res.body)
    if (columns) return { ok: true, columns }
  }
  return failure(`The columns of the table ${table} couldn't be read from its Delta log.`)
}

// ── Entry ────────────────────────────────────────────────────────────────────
const MODES = {
  account: runAccount,
  listWorkspaces: runListWorkspaces,
  getItem: runGetItem,
  findItem: runFindItem,
  getDefinition: runGetDefinition,
  create: runCreate,
  updateDefinition: runUpdateDefinition,
  refresh: runRefresh,
  refreshStatus: runRefreshStatus,
  delete: runDelete,
  createLakehouse: runCreateLakehouse,
  getLakehouse: runGetLakehouse,
  listTables: runListTables,
  loadTable: runLoadTable,
  uploadCheck: runUploadCheck,
  uploadFiles: runUploadFiles,
  tableSchema: runTableSchema
}

// `overrides` replaces the network, clock, file and token boundaries ({fetch,
// sleep, now, open, token, provider, azToken, rayfinTokens, fabric, pbi, onelake})
// so tests never reach a service, wait or read a file.
export async function run(request, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides }
  const mode = request?.mode
  const handler = typeof mode === 'string' && Object.hasOwn(MODES, mode) ? MODES[mode] : null
  if (!handler) return failure(`Unknown supporting-items helper mode: ${String(mode).slice(0, 60)}`)
  const authModule = request?.authModule
  if (typeof authModule === 'string' && authModule.trim() && !Object.hasOwn(overrides, 'token')) {
    let tokens
    try {
      tokens = await deps.rayfinTokens(authModule.trim())
    } catch (error) {
      return failure(`The app's Rayfin CLI couldn't be loaded (${errorMessage(error)}).`)
    }
    deps.token = (resource) => tokens([`${resource}/.default`])
    deps.provider = 'rayfin'
  }
  try {
    return await handler(makeClient(deps), deps, request)
  } catch (error) {
    if (error instanceof Invalid) return failure(error.message)
    throw error
  }
}

export async function main(argv = process.argv.slice(2), overrides) {
  return run(parseRequest(argv[0]), overrides)
}

if (isMain(import.meta.url)) runHelper(() => main())
