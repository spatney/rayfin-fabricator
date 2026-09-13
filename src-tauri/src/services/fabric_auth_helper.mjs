// Shared by the short-lived Fabric helpers. Credentials stay in this process;
// only structured results and redacted errors cross the stdout/IPC boundary.
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export class NeedsLogin extends Error {}
export class NeedsAz extends Error {}

const LOGIN_ERROR = /\b(interaction_required|login_required|consent_required|invalid_grant|no_account_error|no_account_in_silent_request|no_tokens_found)\b|\bno (?:cached )?(?:account|credentials?|tokens?|session)\b|\bnot (?:signed|logged) in\b|\b(?:sign[ -]?in|log[ -]?in|interactive authentication) (?:is )?required\b|\b(?:please|must|need to) (?:sign|log)[ -]?in\b|\b(?:access|refresh) token\b[^\n]*(?:expired|revoked)|\bAADSTS(?:50058|50076|50079|50173|65001|70043|700082|700084)\b|(?:run|use)\s+[`'"]?(?:az|rayfin) login\b/i
const TRANSPORT_ERROR = /\b(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b|timed? ?out|network (?:error|request failed)|fetch failed/i

export function needsLogin(error) {
  const text = [error?.errorCode, error?.code, error?.subError, error?.message || error].filter(Boolean).join(' ')
  return !TRANSPORT_ERROR.test(text) && LOGIN_ERROR.test(text)
}

export function errorMessage(error) {
  return String(error?.message || error)
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
}

export function errorResult(error) {
  const needsAz = error instanceof NeedsAz
  return {
    ok: false,
    needsLogin: !needsAz && (error instanceof NeedsLogin || needsLogin(error)),
    needsAz,
    error: errorMessage(error),
  }
}

function checkedToken(value, provider) {
  if (typeof value !== 'string' || !value || /\s/.test(value)) {
    const ErrorType = provider === 'az' ? NeedsAz : NeedsLogin
    throw new ErrorType(provider === 'az'
      ? 'Azure CLI returned no usable access token. Sign in to Azure again.'
      : 'Rayfin returned no usable access token. Sign in to Fabric again.')
  }
  return value
}

export async function acquireRayfinToken(auth, scopes) {
  try {
    const result = await auth.acquireToken(scopes, { silentOnly: true })
    return checkedToken(result?.token, 'rayfin')
  } catch (error) {
    if (error instanceof NeedsLogin || needsLogin(error)) throw new NeedsLogin(errorMessage(error))
    throw error
  }
}

export async function makeRayfinTokens(authPath) {
  const module = await import(pathToFileURL(authPath).href)
  const auth = await module.getRayfinAuth()
  // Let MSAL own expiration/refresh; do not add another token cache.
  return (scopes) => acquireRayfinToken(auth, scopes)
}

export function azToken(resource, execute = execFile) {
  return new Promise((resolve, reject) => {
    const args = ['account', 'get-access-token', '--resource', resource, '--query', 'accessToken', '-o', 'tsv']
    const isWin = process.platform === 'win32'
    const file = isWin ? process.env.ComSpec || 'cmd.exe' : 'az'
    const argv = isWin ? ['/d', '/s', '/c', 'az', ...args] : args
    execute(file, argv, { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const detail = errorMessage((stderr || error?.message || '').trim())
      if (error) {
        const missing = error.code === 'ENOENT' || /(?:az.*not (?:recognized|found)|command not found.*az)/i.test(detail)
        const ErrorType = missing || needsLogin(detail) ? NeedsAz : Error
        return reject(new ErrorType(detail || 'Azure CLI access-token request failed.'))
      }
      try { resolve(checkedToken((stdout || '').trim(), 'az')) } catch (error) { reject(error) }
    })
  })
}

export function apiUrl(value, base) {
  const url = new URL(value, base)
  const expected = new URL(base)
  if (url.origin !== expected.origin || url.username || url.password) {
    throw new Error('The API returned a URL outside the authenticated service.')
  }
  return url.href
}

export function checkAuthentication(response, provider = 'rayfin') {
  if (response.status !== 401 && !/insufficient_claims/i.test(response.headers.get('www-authenticate') || '')) return
  if (provider === 'catalogOverride') {
    throw new Error('FABRIC_CATALOG_TOKEN was rejected. Update or remove that environment override; Azure sign-in cannot replace it.')
  }
  const ErrorType = provider === 'az' ? NeedsAz : NeedsLogin
  throw new ErrorType(provider === 'az'
    ? `Azure authentication was rejected (HTTP ${response.status}). Sign in to Azure again.`
    : `Fabric authentication was rejected (HTTP ${response.status}). Sign in to Fabric again.`)
}

export function apiError(label, status, body) {
  const error = body?.error || body
  const detail = typeof error === 'string' ? error : error?.message || error?.code || error?._text || ''
  return `${label} failed (HTTP ${status})${detail ? ': ' + errorMessage(detail).slice(0, 300) : ''}`
}

export function makeApi(token, base, provider = 'rayfin') {
  checkedToken(token, provider)
  const authHeader = { Authorization: 'Bearer ' + token }
  async function req(method, path, body, extraHeaders) {
    const full = apiUrl(/^https?:\/\//i.test(path) ? path : base.replace(/\/$/, '') + '/' + path.replace(/^\//, ''), base)
    for (let attempt = 0; attempt < 4; attempt++) {
      let response
      try {
        response = await fetch(full, {
          method,
          headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders, ...authHeader },
          body: body ? JSON.stringify(body) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        })
      } catch (error) {
        return [0, { error: errorMessage(error) }]
      }
      // Power BI's optional admin APIs also use 401 for non-admins. Confirm
      // the token on a normal endpoint before treating that as a permission miss.
      const url = new URL(full)
      if (response.status === 401 && url.origin === 'https://api.powerbi.com' && url.pathname.startsWith('/v1.0/myorg/admin/')) {
        const [status] = await req('GET', '/groups?$top=1')
        if (status !== 200) throw new Error('Could not verify Power BI authentication for the admin lookup.')
      } else {
        checkAuthentication(response, provider)
      }
      if (response.status === 429 && attempt < 3) {
        const wait = Math.max(0, Math.min(parseInt(response.headers.get('retry-after') || '5', 10) || 5, 30))
        await new Promise((resolve) => setTimeout(resolve, wait * 1000))
        continue
      }
      const ct = response.headers.get('content-type') || ''
      let result = null
      if (ct.includes('json')) result = await response.json().catch(() => null)
      else {
        const text = await response.text().catch(() => '')
        result = text ? { _text: text } : null
      }
      return [response.status, result]
    }
    return [429, null]
  }
  return {
    get: (url, headers) => req('GET', url, null, headers),
    post: (url, body, headers) => req('POST', url, body, headers),
    put: (url, body, headers) => req('PUT', url, body, headers),
    delete: (url) => req('DELETE', url),
  }
}

export async function fetchAllPages(api, start, { tolerate = false, label = 'Fabric request' } = {}) {
  const out = []
  const seen = new Set()
  let url = start
  for (let page = 0; page < 100 && url; page++) {
    if (seen.has(url)) throw new Error('Fabric returned a repeated continuation URL.')
    seen.add(url)
    // Authentication failures throw even for optional capacity metadata.
    const [status, json] = await api.get(url)
    if (status !== 200 || !Array.isArray(json?.value)) {
      if (tolerate) return out
      throw new Error(apiError(label, status, json))
    }
    out.push(...json.value)
    if (json.continuationUri) url = apiUrl(json.continuationUri, start)
    else if (json.continuationToken) {
      const next = new URL(start)
      next.searchParams.set('continuationToken', json.continuationToken)
      url = next.href
    } else url = null
  }
  if (url) throw new Error('Fabric returned too many pages to complete this lookup.')
  return out
}

export function isMain(url) {
  return !!process.argv[1] && pathToFileURL(process.argv[1]).href === url
}

export function runHelper(main, defaults = {}) {
  console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\n')
  console.debug = console.info = console.warn = console.log
  Promise.resolve().then(main).then(
    (result) => process.stdout.write(JSON.stringify(result)),
    (error) => process.stdout.write(JSON.stringify({ ...defaults, ...errorResult(error) })),
  )
}
