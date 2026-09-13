import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, test } from 'node:test'
import vm from 'node:vm'
import {
  NeedsLogin, NeedsAz, acquireRayfinToken, azToken, apiUrl, apiError,
  makeApi, fetchAllPages, errorResult, needsLogin,
} from './fabric_auth_helper.mjs'
import { runLocate, runListWorkspaceModels, fetchModelBim } from './semantic_model_helper.mjs'
import {
  resolvePrincipal, searchDirectory, shareApp, shareModel, shareRecipients,
} from './fabric_share_helper.mjs'

const FABRIC = 'https://api.fabric.microsoft.com/v1'
const GRAPH = 'https://graph.microsoft.com/v1.0'
const PBI = 'https://api.powerbi.com/v1.0/myorg'
const TOKEN = 'synthetic-test-token'
const originalFetch = globalThis.fetch
const response = (status, body = {}, headers = {}) => new Response(
  status === 204 ? null : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json', ...headers } },
)

// An unexpected request can only fail locally, never reach a real service.
beforeEach(() => { globalThis.fetch = async () => { throw new Error('Unexpected request in offline auth test') } })
afterEach(() => { globalThis.fetch = originalFetch })

const fabricSource = readFileSync(new URL('../commands/fabric.rs', import.meta.url), 'utf8')
async function embeddedHelper(name, { items = [], args = [] } = {}) {
  const match = fabricSource.match(new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`))
  assert.ok(match, `embedded helper ${name} exists`)
  // Execute the actual embedded logic, replacing only its auth/filesystem
  // boundaries. No fixture files, CLI processes, or real credentials are used.
  const source = match[1]
    .replace(/^import .* from .*\r?$/gm, '')
    .replace(/runHelper\(main(?:, \{.*\})?\)\s*$/, 'main')
  const main = vm.runInNewContext(source, {
    makeRayfinTokens: async () => async () => TOKEN,
    makeApi, fetchAllPages, apiError, errorResult,
    readFileSync: () => JSON.stringify(items),
    process: { argv: ['node', 'fixture', 'unused-auth-module', FABRIC, ...args] },
  })
  return JSON.parse(JSON.stringify(await main()))
}

test('Rayfin token acquisition is silent and rejects empty or malformed credentials', async () => {
  const calls = []
  const auth = { acquireToken: async (...args) => { calls.push(args); return { token: TOKEN } } }
  assert.equal(await acquireRayfinToken(auth, ['scope']), TOKEN)
  assert.deepEqual(calls, [[['scope'], { silentOnly: true }]])
  for (const token of [undefined, null, '', ' ', 'header\ninjection']) {
    await assert.rejects(acquireRayfinToken({ acquireToken: async () => ({ token }) }), NeedsLogin)
  }
})

test('revocation is a login failure; transport and syntax errors are not', async () => {
  const revoked = Object.assign(new Error('Session revoked'), { errorCode: 'invalid_grant' })
  await assert.rejects(acquireRayfinToken({ acquireToken: async () => { throw revoked } }), NeedsLogin)
  for (const text of [
    'Unexpected token in JSON', 'Workspace role assignment failed (403)',
    'Account limit exceeded', 'Token endpoint network request failed',
    'invalid_grant request timed out',
  ]) {
    assert.equal(needsLogin(new Error(text)), false, text)
  }
  const network = new Error('Token endpoint request timed out')
  await assert.rejects(acquireRayfinToken({ acquireToken: async () => { throw network } }), (error) => error === network)
})

test('Azure token failures distinguish reauthentication from outages without spawning az', async () => {
  const invoke = (error, stdout, stderr) => (_file, _args, options, callback) => {
    assert.equal(options.timeout, 20_000)
    callback(error, stdout, stderr)
  }
  assert.equal(await azToken(GRAPH, invoke(null, TOKEN, '')), TOKEN)
  await assert.rejects(azToken(GRAPH, invoke(null, '', '')), NeedsAz)
  await assert.rejects(azToken(GRAPH, invoke(new Error('failed'), '', 'AADSTS700082: refresh token expired')), NeedsAz)
  await assert.rejects(azToken(GRAPH, invoke(Object.assign(new Error('missing'), { code: 'ENOENT' }), '', '')), NeedsAz)
  await assert.rejects(
    azToken(GRAPH, invoke(new Error('failed'), '', 'Azure CLI network request failed')),
    (error) => !(error instanceof NeedsAz) && !errorResult(error).needsLogin,
  )
})

test('HTTP 401 reports the token provider and forbids automatic redirects', async () => {
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`)
    return response(401)
  }
  await assert.rejects(makeApi(TOKEN, FABRIC).get('/workspaces'), NeedsLogin)
  await assert.rejects(makeApi(TOKEN, GRAPH, 'az').get('/users'), NeedsAz)
})

test('an explicit catalog-token override cannot be repaired with Azure login', async () => {
  globalThis.fetch = async () => response(401)
  await assert.rejects(makeApi(TOKEN, FABRIC, 'catalogOverride').post('/catalog/search', {}), (error) => {
    const result = errorResult(error)
    assert.equal(result.needsLogin, false)
    assert.equal(result.needsAz, false)
    return result.error.includes('FABRIC_CATALOG_TOKEN')
  })
})

test('claims challenges require the correct provider but ordinary 403 does not', async () => {
  globalThis.fetch = async () => response(403, {}, { 'www-authenticate': 'Bearer error="insufficient_claims"' })
  await assert.rejects(makeApi(TOKEN, GRAPH, 'az').get('/users'), NeedsAz)
  globalThis.fetch = async () => response(403, { error: { message: 'Directory read permission required' } })
  const [status] = await makeApi(TOKEN, GRAPH, 'az').get('/users')
  assert.equal(status, 403)
})

test('optional capacities tolerate permissions, never rejected authentication', async () => {
  const api = makeApi(TOKEN, FABRIC)
  globalThis.fetch = async () => response(403)
  assert.deepEqual(await fetchAllPages(api, `${FABRIC}/capacities`, { tolerate: true }), [])
  globalThis.fetch = async () => response(401)
  await assert.rejects(fetchAllPages(api, `${FABRIC}/capacities`, { tolerate: true }), NeedsLogin)
})

test('pagination preserves valid pages and encodes continuation tokens', async () => {
  let calls = 0
  globalThis.fetch = async (url) => {
    if (++calls === 1) return response(200, { value: [1], continuationToken: 'page/+2=' })
    assert.equal(new URL(url).searchParams.get('continuationToken'), 'page/+2=')
    return response(200, { value: [2] })
  }
  assert.deepEqual(await fetchAllPages(makeApi(TOKEN, FABRIC), `${FABRIC}/workspaces`), [1, 2])
})

test('continuation URLs cannot send credentials to another origin', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return response(200, { value: [], continuationUri: 'https://other.invalid/workspaces' })
  }
  await assert.rejects(fetchAllPages(makeApi(TOKEN, FABRIC), `${FABRIC}/workspaces`), /outside the authenticated service/)
  assert.equal(calls, 1)
  assert.throws(() => apiUrl('https://user:synthetic@api.fabric.microsoft.com/v1', FABRIC), /outside/)
})

test('embedded workspace lookup retains unknown capacities when metadata is forbidden', async () => {
  globalThis.fetch = async (url) => url.endsWith('/workspaces')
    ? response(200, { value: [{ id: 'ws', displayName: 'Example', capacityId: 'cap' }] })
    : response(403)
  const result = await embeddedHelper('HELPER_SOURCE')
  assert.equal(result.ok, true)
  assert.equal(result.workspaces[0].capacityKind, 'unknown')
  assert.equal(result.workspaces[0].eligible, true)
})

test('the auth probe performs only one read and does not enumerate additional pages', async () => {
  let calls = 0
  globalThis.fetch = async (_url, options) => {
    calls++
    assert.equal(options.method, 'GET')
    return response(200, { value: [], continuationToken: 'not-followed' })
  }
  assert.deepEqual(await embeddedHelper('AUTH_PROBE_HELPER_SOURCE'), { ok: true })
  assert.equal(calls, 1)
})

test('the auth probe distinguishes rejected tokens from insufficient permissions', async () => {
  globalThis.fetch = async () => response(401)
  await assert.rejects(embeddedHelper('AUTH_PROBE_HELPER_SOURCE'), NeedsLogin)
  globalThis.fetch = async () => response(403)
  assert.deepEqual(await embeddedHelper('AUTH_PROBE_HELPER_SOURCE'), { ok: true })
  globalThis.fetch = async () => response(403, {}, { 'www-authenticate': 'Bearer error="insufficient_claims"' })
  await assert.rejects(embeddedHelper('AUTH_PROBE_HELPER_SOURCE'), NeedsLogin)
})

test('the auth probe cannot verify a session from an outage or malformed success response', async () => {
  for (const status of [200, 500]) {
    globalThis.fetch = async () => response(status, {})
    await assert.rejects(embeddedHelper('AUTH_PROBE_HELPER_SOURCE'), /authentication check failed/)
  }
  globalThis.fetch = async () => { throw new Error('Network request failed') }
  await assert.rejects(embeddedHelper('AUTH_PROBE_HELPER_SOURCE'), (error) => !errorResult(error).needsLogin)
})

test('embedded workspace lookup cannot succeed if the capacity request rejects the token', async () => {
  globalThis.fetch = async (url) => url.endsWith('/workspaces')
    ? response(200, { value: [] }) : response(401)
  await assert.rejects(embeddedHelper('HELPER_SOURCE'), NeedsLogin)
})

test('embedded capacities and create-workspace return authentication errors on 401', async () => {
  globalThis.fetch = async () => response(401)
  await assert.rejects(embeddedHelper('CAPACITIES_HELPER_SOURCE'), NeedsLogin)
  await assert.rejects(embeddedHelper('CREATE_WS_HELPER_SOURCE', { args: ['Example', 'cap'] }), NeedsLogin)
})

test('embedded create-workspace does not mislabel assignment permissions or accept missing ids', async () => {
  globalThis.fetch = async () => response(403, { message: 'Capacity assignment forbidden' })
  await assert.rejects(embeddedHelper('CREATE_WS_HELPER_SOURCE'), (error) => !errorResult(error).needsLogin)
  globalThis.fetch = async () => response(201, {})
  await assert.rejects(embeddedHelper('CREATE_WS_HELPER_SOURCE'), /no workspace id/)
})

test('embedded delete stops on expired auth and retains completed deletions', async () => {
  let calls = 0
  globalThis.fetch = async () => ++calls === 1 ? response(204) : response(401)
  const result = await embeddedHelper('DELETE_HELPER_SOURCE', {
    items: ['first', 'second', 'third'].map((itemId) => ({ workspaceId: 'ws', itemId })),
  })
  assert.equal(result.ok, false)
  assert.equal(result.needsLogin, true)
  assert.equal(result.deleted, 1)
  assert.equal(result.failures[0].name, 'second')
  assert.equal(calls, 2)
})

test('embedded delete still treats already-deleted items as success', async () => {
  globalThis.fetch = async () => response(404)
  const result = await embeddedHelper('DELETE_HELPER_SOURCE', { items: [{ workspaceId: 'ws', itemId: 'gone' }] })
  assert.deepEqual(result, { ok: true, deleted: 0, failures: [] })
})

test('directory lookup propagates Graph rejection on alias and group fallback requests', async () => {
  for (const deniedAt of [2, 3]) {
    let calls = 0
    globalThis.fetch = async () => {
      const index = calls++
      return index === deniedAt ? response(401)
        : index === 0 ? response(404) : response(200, { value: [] })
    }
    await assert.rejects(resolvePrincipal(makeApi(TOKEN, GRAPH, 'az'), 'user@example.invalid'), NeedsAz)
    assert.equal(calls, deniedAt + 1)
  }
})

test('directory search does not convert failures into successful empty suggestions', async () => {
  const graph = makeApi(TOKEN, GRAPH, 'az')
  globalThis.fetch = async () => response(401)
  await assert.rejects(searchDirectory('Ada', graph), NeedsAz)
  for (const status of [403, 500]) {
    globalThis.fetch = async () => response(status, { error: { message: 'Directory lookup failed' } })
    await assert.rejects(searchDirectory('Ada', graph), (error) => {
      const result = errorResult(error)
      return !result.needsLogin && !result.needsAz && result.error.includes(String(status))
    })
  }
})

test('directory search retains the prefix fallback for unsupported search', async () => {
  globalThis.fetch = async (url) => url.includes('$search=')
    ? response(400)
    : response(200, { value: [{ id: 'person', displayName: 'Ada', mail: 'ada@example.invalid' }] })
  const result = await searchDirectory('Ada', makeApi(TOKEN, GRAPH, 'az'))
  assert.equal(result.ok, true)
  assert.equal(result.people[0].id, 'person')
})

test('sharing distinguishes expired credentials from workspace/model permissions', async () => {
  const principal = { objectId: 'user', principalType: 'User', identifier: 'user@example.invalid' }
  const model = { workspaceId: 'ws', itemId: 'model' }
  globalThis.fetch = async () => response(401)
  await assert.rejects(shareApp(makeApi(TOKEN, FABRIC), 'ws', principal, 'Contributor'), NeedsLogin)
  await assert.rejects(shareModel(makeApi(TOKEN, PBI), model, principal, 'ReadExplore'), NeedsLogin)
  globalThis.fetch = async () => response(403)
  assert.match((await shareApp(makeApi(TOKEN, FABRIC), 'ws', principal, 'Contributor')).error, /Admin role/)
  assert.match((await shareModel(makeApi(TOKEN, PBI), model, principal, 'ReadExplore')).error, /owner or admin/)
})

test('sharing retains a successful app grant when the model token is rejected', async () => {
  globalThis.fetch = async (url) => url.startsWith(GRAPH)
    ? response(200, { id: 'person', userPrincipalName: 'user@example.invalid' })
    : url.startsWith(FABRIC) ? response(201) : response(401)
  const result = await shareRecipients({
    fabric: makeApi(TOKEN, FABRIC), graph: makeApi(TOKEN, GRAPH, 'az'), pbi: makeApi(TOKEN, PBI),
  }, {
    recipients: ['user@example.invalid'], appWorkspaceId: 'ws', role: 'Contributor', right: 'ReadExplore',
    models: [{ workspaceId: 'data', itemId: 'model' }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.needsLogin, true)
  assert.equal(result.recipients[0].app.ok, true)
  assert.equal(result.recipients[0].models[0].ok, false)
})

test('successful sharing does not retain placeholder model errors', async () => {
  globalThis.fetch = async (url) => url.startsWith(GRAPH)
    ? response(200, { id: 'person', userPrincipalName: 'user@example.invalid' }) : response(201)
  const result = await shareRecipients({
    fabric: makeApi(TOKEN, FABRIC), graph: makeApi(TOKEN, GRAPH, 'az'), pbi: makeApi(TOKEN, PBI),
  }, {
    recipients: ['user@example.invalid'], appWorkspaceId: 'ws', role: 'Contributor', right: 'ReadExplore',
    models: [{ workspaceId: 'data', itemId: 'model' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.recipients[0].models[0].error, undefined)
})

test('model lookup cannot label an expired Power BI token as no matches', async () => {
  globalThis.fetch = async () => response(401)
  await assert.rejects(runLocate(async () => TOKEN, {
    target: 'aaaaaaaa-1111-2222-3333-444444444444',
  }), NeedsLogin)
})

test('Power BI admin-only 401 is a permission miss only if the normal token probe succeeds', async () => {
  globalThis.fetch = async (url) => url.includes('/admin/') ? response(401) : response(200, { value: [] })
  assert.equal((await makeApi(TOKEN, PBI).get('/admin/datasets'))[0], 401)
  globalThis.fetch = async () => response(401)
  await assert.rejects(makeApi(TOKEN, PBI).get('/admin/datasets'), NeedsLogin)
})

test('workspace model pagination propagates expired Fabric credentials', async () => {
  let calls = 0
  globalThis.fetch = async () => ++calls === 1
    ? response(200, { value: [{ id: 'model' }], continuationToken: 'next' })
    : response(401)
  await assert.rejects(runListWorkspaceModels(async () => TOKEN, { workspaceId: 'ws' }), NeedsLogin)
  assert.equal(calls, 2)
})

test('schema initial and polling 401 errors request Azure rather than Fabric login', async () => {
  globalThis.fetch = async () => response(401)
  await assert.rejects(fetchModelBim(TOKEN, 'ws', 'model'), NeedsAz)
  let calls = 0
  globalThis.fetch = async () => ++calls === 1
    ? response(202, {}, { location: `${FABRIC}/operations/operation` })
    : response(401)
  await assert.rejects(fetchModelBim(TOKEN, 'ws', 'model'), NeedsAz)
  assert.equal(calls, 2)
})

test('schema polling cannot redirect credentials outside Fabric', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return response(202, {}, { location: 'https://other.invalid/operation' })
  }
  await assert.rejects(fetchModelBim(TOKEN, 'ws', 'model'), /outside the authenticated service/)
  assert.equal(calls, 1)
})

test('auth errors redact bearer values before crossing the result boundary', () => {
  assert.equal(errorResult(new NeedsLogin(`Rejected Bearer ${TOKEN}`)).error, 'Rejected Bearer [redacted]')
})
