// Fabric app + semantic-model sharing helper for Fabricator.
//
// Reuses the globally/locally-installed Rayfin CLI's MSAL token cache (the same
// approach as src-tauri/src/commands/fabric.rs and semantic_model_helper.mjs) to
// mint Fabric + Power BI tokens silently, and the Azure CLI (`az`) to mint a
// Microsoft Graph token used to resolve recipient emails to directory object ids.
//
// It then, for each recipient:
//   1. grants access to the deployed app by assigning a workspace role
//      (Contributor by default) on the app's hosting Fabric workspace, and
//   2. grants Build (== Power BI "ReadExplore") on every semantic model the app
//      uses that lives in a *different* workspace (same-workspace models are
//      already covered by the workspace role, so the Rust caller filters them out).
//
// argv: <authModulePath> <requestJson>
//   requestJson: {
//     "appWorkspaceId": "<guid>",
//     "role": "Contributor",
//     "recipients": ["user@contoso.com", ...],
//     "models": [{ "workspaceId": "<guid|me>", "itemId": "<datasetId>", "alias": "sales" }],
//     "modelAccessRight": "ReadExplore"
//   }
//
// Writes exactly one JSON line to stdout; all library logging is routed to stderr.

// Keep stdout clean for the JSON result; route any library logging to stderr.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.debug = console.log
console.info = console.log
console.warn = console.log

import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'

const FABRIC_BASE = 'https://api.fabric.microsoft.com/v1'
const PBI_BASE = 'https://api.powerbi.com/v1.0/myorg'
const PBI_SCOPES = ['https://analysis.windows.net/powerbi/api/.default']
const GRAPH_RESOURCE = 'https://graph.microsoft.com'
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const DEFAULT_ROLE = 'Contributor'
const DEFAULT_MODEL_RIGHT = 'ReadExplore' // Power BI "Build" permission.

// ── Auth ────────────────────────────────────────────────────────────────────
class NeedsLogin extends Error {}
class NeedsAz extends Error {}

// Mint Fabric (default scope) and Power BI tokens silently via the Rayfin MSAL
// cache. `scopes === undefined` yields the CLI's default (Fabric) token, matching
// the delete helper in commands/fabric.rs.
async function makeRayfinTokens(authPath) {
  const auth = await import(pathToFileURL(authPath).href)
  const rf = await auth.getRayfinAuth()
  const cache = {}
  return async function token(scopes) {
    const key = scopes ? scopes.join(' ') : '(default)'
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

// A Microsoft Graph token, minted via the Azure CLI (a required, signed-in
// Fabricator tool). Used only to resolve recipient emails -> object ids for the
// workspace role assignment, which requires a principal object id.
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

// ── HTTP ──────────────────────────────────────────────────────────────────--
function makeApi(token) {
  const authHeader = { Authorization: 'Bearer ' + token }
  async function req(method, url, bodyObj, extraHeaders) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let r
      try {
        r = await fetch(url, {
          method,
          headers: {
            ...authHeader,
            ...(bodyObj ? { 'Content-Type': 'application/json' } : {}),
            ...(extraHeaders || {}),
          },
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
      else {
        const t = await r.text().catch(() => '')
        body = t ? { _text: t } : null
      }
      return [r.status, body]
    }
    return [429, null]
  }
  return {
    get: (url, headers) => req('GET', url, null, headers),
    post: (url, body, headers) => req('POST', url, body, headers),
    put: (url, body, headers) => req('PUT', url, body, headers),
  }
}

// ── Pure helpers (covered by --selftest) ────────────────────────────────────
// Escape a value for an OData string literal (single quotes are doubled).
function odata(value) {
  return String(value == null ? '' : value).replace(/'/g, "''")
}

// The Power BI dataset-users endpoint: group-scoped, or the My-Workspace form
// when the model lives in "me".
function modelUsersUrl(model) {
  const ws = model && model.workspaceId ? String(model.workspaceId).trim() : ''
  return ws && ws.toLowerCase() !== 'me'
    ? `${PBI_BASE}/groups/${ws}/datasets/${model.itemId}/users`
    : `${PBI_BASE}/datasets/${model.itemId}/users`
}

// Strip double quotes so a query is safe to embed in a Graph `$search` phrase.
function stripQuotes(value) {
  return String(value == null ? '' : value).replace(/"/g, '')
}

// Build the two Graph people-search URLs for a query: a relevance `$search`
// (needs the ConsistencyLevel: eventual header) and a `startswith` `$filter`
// fallback for tenants where `$search` is unavailable.
function directorySearchUrls(query) {
  const q = String(query || '').trim()
  const term = stripQuotes(q)
  const searchVal = `"displayName:${term}" OR "mail:${term}" OR "userPrincipalName:${term}"`
  const search = `${GRAPH_BASE}/users?$search=${encodeURIComponent(searchVal)}&$select=id,displayName,mail,userPrincipalName&$top=10`
  const f = odata(q)
  const filterVal = `startswith(displayName,'${f}') or startswith(mail,'${f}') or startswith(userPrincipalName,'${f}')`
  const startswith = `${GRAPH_BASE}/users?$filter=${encodeURIComponent(filterVal)}&$select=id,displayName,mail,userPrincipalName&$top=10`
  return { search, startswith }
}

// Best-effort human text out of a REST error body (shape varies by API).
function errText(body) {
  if (!body) return ''
  if (typeof body === 'string') return body
  if (body._text) return String(body._text)
  if (body.error) {
    if (typeof body.error === 'string') return body.error
    return body.error.message || body.error.code || JSON.stringify(body.error)
  }
  if (body.message) return String(body.message)
  return JSON.stringify(body)
}

// A grant that failed because the principal already has (at least) this access
// is a success for our purposes — sharing is idempotent.
function isAlreadyAssigned(status, body) {
  if (status === 409) return true
  if (status !== 400) return false
  return /already|exists|duplicate|assigned/i.test(errText(body))
}

function apiError(label, status, body) {
  const t = errText(body)
  return `${label} failed (${status})${t ? ': ' + t.slice(0, 300) : ''}`
}

// ── Directory resolution ────────────────────────────────────────────────────
// Resolve a recipient email to a directory principal. Users take precedence over
// mail-enabled groups. Returns { objectId, principalType, identifier } or null
// when nothing matches. Throws NeedsAz when Graph rejects the token itself.
async function resolvePrincipal(graph, email) {
  const raw = String(email).trim()
  const enc = encodeURIComponent(raw)
  const filt = odata(raw)

  // 1) Direct UPN lookup — the common case where email === userPrincipalName.
  let [s, j] = await graph.get(`${GRAPH_BASE}/users/${enc}?$select=id,userPrincipalName`)
  if (s === 200 && j && j.id) return { objectId: j.id, principalType: 'User', identifier: j.userPrincipalName || raw }
  if (s === 401 || s === 403) throw new NeedsAz(`Microsoft Graph rejected the directory lookup (${s}). Run 'az login' with an account that can read the directory.`)

  // 2) By primary mail or UPN.
  ;[s, j] = await graph.get(`${GRAPH_BASE}/users?$filter=mail eq '${filt}' or userPrincipalName eq '${filt}'&$select=id,userPrincipalName`)
  if (s === 200 && j && j.value && j.value.length) {
    const u = j.value[0]
    return { objectId: u.id, principalType: 'User', identifier: u.userPrincipalName || raw }
  }
  if (s === 401 || s === 403) throw new NeedsAz(`Microsoft Graph rejected the directory lookup (${s}). Run 'az login' with an account that can read the directory.`)

  // 3) Alias / secondary address (proxyAddresses needs advanced query params).
  ;[s, j] = await graph.get(
    `${GRAPH_BASE}/users?$filter=proxyAddresses/any(x:x eq 'SMTP:${filt}')&$count=true&$select=id,userPrincipalName`,
    { ConsistencyLevel: 'eventual' },
  )
  if (s === 200 && j && j.value && j.value.length) {
    const u = j.value[0]
    return { objectId: u.id, principalType: 'User', identifier: u.userPrincipalName || raw }
  }

  // 4) Mail-enabled security / distribution group. A Group principal is
  //    identified by its object id (not an email) in the Power BI users API.
  ;[s, j] = await graph.get(`${GRAPH_BASE}/groups?$filter=mail eq '${filt}'&$select=id`)
  if (s === 200 && j && j.value && j.value.length) {
    return { objectId: j.value[0].id, principalType: 'Group', identifier: j.value[0].id }
  }

  return null
}

// Search the directory for people matching `query` (name / email), for the
// Share dialog's autocomplete. Uses only the Azure CLI Graph token — no Rayfin
// tokens — so it stays fast and independent of the project's CLI. Returns up to
// 10 people with a display name + email.
async function searchDirectory(query) {
  const q = String(query || '').trim()
  if (!q) return { ok: true, people: [] }
  const graph = makeApi(await azToken(GRAPH_RESOURCE))
  const { search, startswith } = directorySearchUrls(q)
  // Prefer relevance search; fall back to a prefix filter if it's unavailable.
  let [s, j] = await graph.get(search, { ConsistencyLevel: 'eventual' })
  if (s !== 200 || !j || !Array.isArray(j.value)) {
    ;[s, j] = await graph.get(startswith)
  }
  if (s === 401 || s === 403) {
    throw new NeedsAz(`Microsoft Graph rejected the directory search (${s}). Run 'az login'.`)
  }
  const value = s === 200 && j && Array.isArray(j.value) ? j.value : []
  const people = value
    .map((u) => ({
      id: u.id,
      displayName: u.displayName || undefined,
      email: u.mail || u.userPrincipalName || undefined,
    }))
    .filter((p) => p.email)
  return { ok: true, people }
}

// ── Grants ──────────────────────────────────────────────────────────────────
async function shareApp(fabric, appWorkspaceId, principal, role) {
  const url = `${FABRIC_BASE}/workspaces/${appWorkspaceId}/roleAssignments`
  const [s, body] = await fabric.post(url, {
    principal: { id: principal.objectId, type: principal.principalType },
    role,
  })
  if (s === 200 || s === 201) return { ok: true }
  if (isAlreadyAssigned(s, body)) return { ok: true, skipped: true }
  if (s === 401 || s === 403) {
    return { ok: false, error: `You need the Admin role on the app's workspace to share it (Fabric returned ${s}).` }
  }
  return { ok: false, error: apiError('Workspace role assignment', s, body) }
}

async function shareModel(pbi, model, principal, right) {
  const url = modelUsersUrl(model)
  const payload = {
    identifier: principal.identifier,
    principalType: principal.principalType,
    datasetUserAccessRight: right,
  }
  let [s, body] = await pbi.post(url, payload)
  if (s === 200 || s === 201) return { ok: true }
  // POST fails when the principal already has an assignment — PUT updates it
  // (idempotent), so a re-share simply confirms the access right.
  if (isAlreadyAssigned(s, body)) {
    ;[s, body] = await pbi.put(url, payload)
    if (s === 200 || s === 201) return { ok: true, skipped: true }
  }
  if (s === 401 || s === 403) {
    const name = model.alias || model.itemId
    return { ok: false, error: `You need to be an owner or admin of model '${name}' to grant Build (Power BI returned ${s}).` }
  }
  return { ok: false, error: apiError('Semantic model share', s, body) }
}

// ── Run ─────────────────────────────────────────────────────────────────────
async function run(authPath, req) {
  const recipients = (req.recipients || []).map((r) => String(r || '').trim()).filter(Boolean)
  const appWorkspaceId = String(req.appWorkspaceId || '').trim()
  const role = String(req.role || DEFAULT_ROLE)
  const models = Array.isArray(req.models) ? req.models : []
  const right = String(req.modelAccessRight || DEFAULT_MODEL_RIGHT)

  if (!appWorkspaceId) return { ok: false, error: 'This deployment has no Fabric workspace id yet — deploy it before sharing.' }
  if (!recipients.length) return { ok: false, error: 'Enter at least one email to share with.' }

  const token = await makeRayfinTokens(authPath)
  const fabric = makeApi(await token(undefined))
  const pbi = models.length ? makeApi(await token(PBI_SCOPES)) : null
  // The app grant always needs a resolved object id, so Graph (via az) is required.
  const graph = makeApi(await azToken(GRAPH_RESOURCE))

  const out = []
  for (const email of recipients) {
    let principal = null
    try {
      principal = await resolvePrincipal(graph, email)
    } catch (e) {
      if (e instanceof NeedsAz) throw e
      principal = null
    }
    if (!principal) {
      out.push({
        email,
        resolved: false,
        app: { ok: false, error: `Couldn't find '${email}' in your directory.` },
        models: models.map((m) => ({ alias: m.alias, itemId: m.itemId, workspaceId: m.workspaceId, ok: false, error: 'Recipient not resolved.' })),
      })
      continue
    }
    const app = await shareApp(fabric, appWorkspaceId, principal, role)
    const modelResults = []
    for (const m of models) {
      modelResults.push({ alias: m.alias, itemId: m.itemId, workspaceId: m.workspaceId, ...(await shareModel(pbi, m, principal, right)) })
    }
    out.push({ email, resolved: true, principalType: principal.principalType, app, models: modelResults })
  }

  const ok = out.every((r) => r.app.ok && r.models.every((m) => m.ok))
  return { ok, recipients: out }
}

// ── Entry ─────────────────────────────────────────────────────────────────--
// Pure-function self-test — no auth/network. Run with `node fabric_share_helper.mjs
// --selftest`. Exits non-zero on first failure.
function selftest() {
  let failed = 0
  const assert = (cond, msg) => { if (!cond) { failed++; process.stderr.write(`FAIL ${msg}\n`) } }

  assert(odata("a'b'c") === "a''b''c", 'odata escaping')
  assert(
    modelUsersUrl({ workspaceId: 'ws-1', itemId: 'ds-1' }) === `${PBI_BASE}/groups/ws-1/datasets/ds-1/users`,
    'group model url',
  )
  assert(
    modelUsersUrl({ workspaceId: 'me', itemId: 'ds-2' }) === `${PBI_BASE}/datasets/ds-2/users`,
    'my-workspace model url',
  )
  assert(
    modelUsersUrl({ workspaceId: '', itemId: 'ds-3' }) === `${PBI_BASE}/datasets/ds-3/users`,
    'missing-workspace model url',
  )
  assert(isAlreadyAssigned(409, null) === true, 'conflict is already-assigned')
  assert(isAlreadyAssigned(400, { error: { message: 'Principal already exists' } }) === true, 'already-exists text')
  assert(isAlreadyAssigned(400, { error: { message: 'Bad request: invalid role' } }) === false, 'unrelated 400 not already-assigned')
  assert(isAlreadyAssigned(403, { error: { message: 'already' } }) === false, '403 never already-assigned')
  assert(errText({ error: { message: 'nope' } }) === 'nope', 'errText nested message')
  assert(errText({ _text: 'raw' }) === 'raw', 'errText raw text')
  assert(apiError('X', 404, { error: { code: 'NotFound' } }) === 'X failed (404): NotFound', 'apiError formatting')

  assert(stripQuotes('a"b"c') === 'abc', 'stripQuotes')
  const urls = directorySearchUrls("O'Brien")
  assert(urls.search.includes('$search='), 'directory $search url')
  assert(urls.search.includes('displayName%3A'), 'directory search encodes term')
  assert(urls.startswith.includes("O''Brien"), 'directory filter escapes single quote')

  if (failed) { process.stderr.write(`${failed} selftest assertion(s) failed\n`); process.exit(1) }
  process.stderr.write('fabric-share selftest ok\n')
  process.exit(0)
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest()
  const [authPath, reqJson] = process.argv.slice(2)
  if (!reqJson) throw new Error('usage: <authModulePath> <requestJson>')
  const req = JSON.parse(reqJson)
  const result =
    req.mode === 'searchDirectory' ? await searchDirectory(req.query) : await run(authPath, req)
  process.stdout.write(JSON.stringify(result))
}

main().catch((err) => {
  const msg = err && err.message ? String(err.message) : String(err)
  const needsAz = err instanceof NeedsAz || /\baz\b.*(login|sign|token|account)|run 'az login'|az account/i.test(msg)
  const needsLogin = !needsAz && (err instanceof NeedsLogin || /silent|cached|account|login|token|interactive|sign/i.test(msg))
  process.stdout.write(JSON.stringify({ ok: false, recipients: [], needsLogin, needsAz, error: msg }))
})
