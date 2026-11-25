import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { NeedsAz, NeedsLogin, errorResult } from './fabric_auth_helper.mjs'
import { deltaColumns, oneLakeRoot, parseRequest, run } from './supporting_items_helper.mjs'

const FABRIC = 'https://api.fabric.microsoft.com/v1'
const PBI = 'https://api.powerbi.com/v1.0/myorg'
const FABRIC_RESOURCE = 'https://api.fabric.microsoft.com'
const PBI_RESOURCE = 'https://analysis.windows.net/powerbi/api'
const TOKEN = 'synthetic-test-token'
const WS = '11111111-2222-4333-8444-555555555555'
const MODEL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OP = 'cccccccc-1111-4222-8333-444444444444'
const REFRESH = 'dddddddd-1111-4222-8333-444444444444'
const OPERATION = `${FABRIC}/operations/${OP}`
const b64 = (value) => Buffer.from(value).toString('base64')
const PARTS = [
  { path: 'definition/model.tmdl', payload: b64('model Model\n') },
  { path: 'definition/tables/Sales.tmdl', payload: b64('table Sales\n') },
  { path: 'definition.pbism', payload: b64('{"version":"4.2"}') }
]
const PLATFORM = { path: '.platform', payload: b64('{"metadata":{"type":"SemanticModel"}}') }

const response = (status, body, headers = {}) =>
  new Response(
    body === undefined || status === 204
      ? null
      : typeof body === 'string'
        ? body
        : JSON.stringify(body),
    {
      status,
      headers: {
        ...(body !== undefined && typeof body !== 'string'
          ? { 'content-type': 'application/json' }
          : {}),
        ...headers
      }
    }
  )
const item = (overrides = {}) => ({
  id: MODEL,
  displayName: 'Sales',
  type: 'SemanticModel',
  description: 'Sales model',
  workspaceId: WS,
  ...overrides
})

// A scripted service: each request takes the next response (or calls `handler`).
// The clock only moves when the helper sleeps, so polling never waits.
function service(...script) {
  const calls = []
  const sleeps = []
  const tokens = []
  let clock = 0
  const handler = typeof script[0] === 'function' && script.length === 1 ? script[0] : null
  const deps = {
    fetch: async (url, init) => {
      const call = {
        url,
        method: init.method,
        init,
        body:
          init.body === undefined
            ? undefined
            : typeof init.body === 'string'
              ? JSON.parse(init.body)
              : init.body
      }
      calls.push(call)
      const next = handler ? handler(call, calls.length) : script.shift()
      if (!next) throw new Error(`Unexpected request: ${init.method} ${url}`)
      return typeof next === 'function' ? next(call) : next
    },
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    token: async (resource) => {
      tokens.push(resource)
      return TOKEN
    },
    fabric: FABRIC,
    pbi: PBI
  }
  return { deps, calls, sleeps, tokens, clock: () => clock, left: () => script.length }
}

const originalFetch = globalThis.fetch
// Nothing here may reach a real service.
beforeEach(() => {
  globalThis.fetch = async () => {
    throw new Error('Unexpected network request in offline test')
  }
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('requests are JSON text or @file references, which are read but never removed', () => {
  assert.deepEqual(parseRequest('{"mode":"getItem","workspaceId":"w"}'), {
    mode: 'getItem',
    workspaceId: 'w'
  })
  const read = []
  const file = 'C:\\Users\\someone\\AppData\\Local\\Temp\\request.json'
  const request = parseRequest(`@${file}`, (path) => {
    read.push(path)
    return '\uFEFF{"mode":"create","parts":[]}'
  })
  assert.deepEqual(request, { mode: 'create', parts: [] })
  assert.deepEqual(read, [file])
  assert.throws(
    () =>
      parseRequest('@missing.json', () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      }),
    /couldn't be read \(ENOENT\)/
  )
  assert.throws(() => parseRequest('{not json'), /isn't valid JSON/)
  assert.throws(() => parseRequest('[1]'), /must be a JSON object/)
  assert.throws(() => parseRequest(''), /usage/)
})

test('ids, names, descriptions and parts are validated before any request', async () => {
  const { deps, calls } = service()
  const cases = [
    [{ mode: 'getItem', workspaceId: 'not-a-guid', itemId: MODEL }, 'A workspace id is required.'],
    [{ mode: 'getItem', workspaceId: WS }, 'An item id is required.'],
    [
      { mode: 'getDefinition', workspaceId: WS, itemId: MODEL, format: 'json' },
      'The definition format must be TMDL or TMSL.'
    ],
    [
      { mode: 'create', workspaceId: WS, displayName: '  ', parts: PARTS },
      'A display name is required.'
    ],
    [
      { mode: 'create', workspaceId: WS, displayName: 'x'.repeat(257), parts: PARTS },
      'The display name must be 256 characters or fewer.'
    ],
    [
      {
        mode: 'create',
        workspaceId: WS,
        displayName: 'Sales',
        description: 'd'.repeat(257),
        parts: PARTS
      },
      'The description must be 256 characters or fewer.'
    ],
    [
      { mode: 'create', workspaceId: WS, displayName: 'Sales', parts: [] },
      'At least one definition part is required.'
    ],
    [
      {
        mode: 'updateDefinition',
        workspaceId: WS,
        itemId: MODEL,
        parts: [{ path: 'definition/../x.tmdl', payload: 'eA==' }]
      },
      /relative path without '\.\.' segments/
    ],
    [
      {
        mode: 'updateDefinition',
        workspaceId: WS,
        itemId: MODEL,
        parts: [{ path: '/definition/x.tmdl', payload: 'eA==' }]
      },
      /relative path/
    ],
    [
      {
        mode: 'updateDefinition',
        workspaceId: WS,
        itemId: MODEL,
        parts: [{ path: 'definition/x.tmdl', payload: 'not base64!' }]
      },
      /needs a base64 payload/
    ],
    [
      {
        mode: 'updateDefinition',
        workspaceId: WS,
        itemId: MODEL,
        parts: PARTS,
        allowPurgeData: 'yes'
      },
      /allowPurgeData must be true or false/
    ],
    [
      { mode: 'refreshStatus', workspaceId: WS, itemId: MODEL, refreshId: '42' },
      'The refresh id is invalid.'
    ],
    [{ mode: 'nope' }, 'Unknown supporting-items helper mode: nope']
  ]
  for (const [request, error] of cases) {
    const result = await run(request, deps)
    assert.equal(result.ok, false, JSON.stringify(request).slice(0, 80))
    assert.equal(result.needsLogin, false)
    assert.equal(result.needsAz, false)
    if (error instanceof RegExp) assert.match(result.error, error)
    else assert.equal(result.error, error)
  }
  assert.equal(calls.length, 0)
})

test('GUIDs are case-insensitive', async () => {
  const { deps, calls } = service(response(200, item()))
  const result = await run(
    { mode: 'getItem', workspaceId: WS.toUpperCase(), itemId: ` ${MODEL.toUpperCase()} ` },
    deps
  )
  assert.equal(result.found, true)
  assert.equal(
    calls[0].url,
    `${FABRIC}/workspaces/${WS.toUpperCase()}/items/${MODEL.toUpperCase()}`
  )
})

test('getItem returns the item, or found:false when Fabric no longer has it', async () => {
  const { deps, calls, tokens } = service(
    response(200, item({ folderId: 'ignored' })),
    response(404, { errorCode: 'ItemNotFound', message: 'The requested item was not found' }),
    response(400, { errorCode: 'EntityNotFound', message: 'Entity not found' })
  )
  const request = { mode: 'getItem', workspaceId: WS, itemId: MODEL }
  assert.deepEqual(await run(request, deps), {
    ok: true,
    found: true,
    item: { id: MODEL, displayName: 'Sales', type: 'SemanticModel', description: 'Sales model' }
  })
  assert.deepEqual(await run(request, deps), { ok: true, found: false })
  assert.deepEqual(await run(request, deps), { ok: true, found: false })
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`)
  assert.ok(calls[0].init.signal instanceof AbortSignal)
  assert.ok(tokens.every((resource) => resource === FABRIC_RESOURCE))
})

test('findItem follows continuation links and matches names case-insensitively', async () => {
  const { deps, calls } = service(
    response(200, {
      value: [item({ id: 'other', displayName: 'Sales 2' })],
      continuationUri: `${FABRIC}/workspaces/${WS}/items?type=SemanticModel&continuationToken=abc`
    }),
    response(200, {
      value: [item({ id: 'x', displayName: 'Inventory' })],
      continuationToken: 'page/+3='
    }),
    response(200, { value: [item({ displayName: '  SALES model ' })] })
  )
  const result = await run(
    { mode: 'findItem', workspaceId: WS, type: 'SemanticModel', displayName: ' sales MODEL' },
    deps
  )
  assert.deepEqual(result, {
    ok: true,
    found: true,
    item: {
      id: MODEL,
      displayName: '  SALES model ',
      type: 'SemanticModel',
      description: 'Sales model'
    }
  })
  assert.equal(calls[0].url, `${FABRIC}/workspaces/${WS}/items?type=SemanticModel`)
  assert.equal(new URL(calls[1].url).searchParams.get('continuationToken'), 'abc')
  assert.equal(new URL(calls[2].url).searchParams.get('continuationToken'), 'page/+3=')
  assert.equal(new URL(calls[2].url).searchParams.get('type'), 'SemanticModel')

  const missing = service(response(200, { value: [item({ displayName: 'Other' })] }))
  assert.deepEqual(
    await run({ mode: 'findItem', workspaceId: WS, displayName: 'Sales' }, missing.deps),
    { ok: true, found: false }
  )
})

test('listWorkspaces lists the shared workspaces the account can create items in, by name', async () => {
  const other = 'bbbbbbbb-2222-4333-8444-555555555555'
  const { deps, calls } = service(
    response(200, {
      value: [
        { id: WS, displayName: 'zeta apps', type: 'Workspace', capacityId: 'cap' },
        {
          id: 'cccccccc-2222-4333-8444-555555555555',
          displayName: 'My workspace',
          type: 'Personal'
        }
      ],
      continuationToken: 'next'
    }),
    response(200, {
      value: [{ id: other, displayName: 'Alpha', type: 'Workspace' }, { displayName: 'No id' }]
    })
  )
  assert.deepEqual(await run({ mode: 'listWorkspaces' }, deps), {
    ok: true,
    workspaces: [
      { id: other, displayName: 'Alpha' },
      { id: WS, displayName: 'zeta apps' }
    ]
  })
  assert.equal(calls[0].url, `${FABRIC}/workspaces?roles=Admin,Member,Contributor`)
  const second = new URL(calls[1].url)
  assert.equal(second.searchParams.get('continuationToken'), 'next')
  assert.equal(second.searchParams.get('roles'), 'Admin,Member,Contributor')

  const refused = service(response(403, { errorCode: 'Unauthorized', message: 'Nope.' }))
  const result = await run({ mode: 'listWorkspaces' }, refused.deps)
  assert.equal(result.ok, false)
  assert.match(result.error, /list your workspaces/)
})

test('continuation and operation links cannot take the token outside Fabric', async () => {
  const paging = service(
    response(200, { value: [], continuationUri: 'https://other.invalid/items' })
  )
  await assert.rejects(
    run({ mode: 'findItem', workspaceId: WS, displayName: 'Sales' }, paging.deps),
    /outside the authenticated service/
  )
  assert.equal(paging.calls.length, 1)
  const create = service(
    response(202, undefined, { location: 'https://other.invalid/operations/x', 'retry-after': '1' })
  )
  await assert.rejects(
    run({ mode: 'create', workspaceId: WS, displayName: 'Sales', parts: PARTS }, create.deps),
    /outside the authenticated service/
  )
  assert.equal(create.calls.length, 1)
})

test('a rejected token asks for Azure sign-in, not Fabric sign-in', async () => {
  const { deps } = service(response(401, { errorCode: 'TokenExpired' }))
  await assert.rejects(
    run({ mode: 'getItem', workspaceId: WS, itemId: MODEL }, deps),
    (error) =>
      error instanceof NeedsAz &&
      errorResult(error).needsAz === true &&
      !error.message.includes(TOKEN)
  )
  const claims = service(
    response(403, {}, { 'www-authenticate': 'Bearer error="insufficient_claims"' })
  )
  await assert.rejects(
    run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, claims.deps),
    NeedsAz
  )
})

test('a Power BI 401 is a permission miss only if the token passes a normal read', async () => {
  const denied = { error: { code: 'PowerBINotAuthorizedException', message: 'Not authorized' } }
  const allowed = service(response(401, denied), response(200, { value: [] }))
  const result = await run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, allowed.deps)
  assert.equal(result.ok, false)
  assert.equal(result.needsAz, false)
  assert.equal(result.forbidden, true)
  assert.equal(result.status, 401)
  assert.equal(allowed.calls[1].url, `${PBI}/groups?$top=1`)
  assert.equal(allowed.calls.length, 2)
  const expired = service(response(401, denied), response(401, {}))
  await assert.rejects(
    run({ mode: 'refreshStatus', workspaceId: WS, itemId: MODEL }, expired.deps),
    NeedsAz
  )
  const offline = service(response(401, denied), () => {
    throw new TypeError('fetch failed')
  })
  await assert.rejects(
    run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, offline.deps),
    NeedsAz
  )
})

// A token whose claims say who it's for; its signature is never checked here.
const jwt = (claims) => `head.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
const AUTH_MODULE = 'C:/apps/sales/node_modules/@microsoft/rayfin-cli/dist/auth/index.js'

test("with authModule, requests are made as the app's Fabric account, which signs in to Fabric again", async () => {
  const asked = []
  const { deps, calls } = service(response(200, item()), response(401, {}))
  const { token: _azure, ...withoutToken } = deps
  const overrides = {
    ...withoutToken,
    rayfinTokens: async (path) => {
      asked.push(path)
      return async (scopes) => {
        asked.push(...scopes)
        return 'fabric-account-token'
      }
    }
  }
  const request = { mode: 'getItem', workspaceId: WS, itemId: MODEL, authModule: AUTH_MODULE }
  assert.equal((await run(request, overrides)).ok, true)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fabric-account-token')
  assert.deepEqual(asked, [AUTH_MODULE, 'https://api.fabric.microsoft.com/.default'])
  await assert.rejects(run(request, overrides), NeedsLogin)

  const broken = await run(request, {
    ...withoutToken,
    rayfinTokens: async () => {
      throw new Error('Cannot find module')
    }
  })
  assert.equal(broken.ok, false)
  assert.match(broken.error, /Rayfin CLI couldn't be loaded/)
})

test('account says which account and organization the requests are made as', async () => {
  const { deps } = service()
  const token = async () => jwt({ upn: 'ada@contoso.com', tid: 'tenant-1' })
  assert.deepEqual(await run({ mode: 'account' }, { ...deps, token }), {
    ok: true,
    user: 'ada@contoso.com',
    tenant: 'tenant-1'
  })
})

test("a refresh the app's Fabric account can't start uses the Azure CLI only in the same organization", async () => {
  const own = jwt({ tid: 'tenant-1' })
  const refused = () => [response(401, ''), response(200, { value: [] })]
  const request = { mode: 'refresh', workspaceId: WS, itemId: MODEL }
  const location = { location: `${PBI}/groups/${WS}/datasets/${MODEL}/refreshes/${REFRESH}` }

  const same = service(...refused(), response(202, undefined, location))
  const azure = jwt({ tid: 'TENANT-1' })
  const started = await run(request, {
    ...same.deps,
    provider: 'rayfin',
    token: async () => own,
    azToken: async () => azure
  })
  assert.deepEqual(started, { ok: true, refreshId: REFRESH, enhanced: true })
  assert.equal(same.calls[2].init.headers.Authorization, `Bearer ${azure}`)

  const other = service(...refused())
  const notAllowed = await run(request, {
    ...other.deps,
    provider: 'rayfin',
    token: async () => own,
    azToken: async () => jwt({ tid: 'tenant-2' })
  })
  assert.equal(notAllowed.ok, false)
  assert.equal(notAllowed.refreshNotAllowed, true)
  assert.match(notAllowed.error, /isn’t signed in to the same organization/)
  assert.equal(other.calls.length, 2, 'no refresh is started as another organization')

  const signedOut = service(...refused())
  const noAzure = await run(request, {
    ...signedOut.deps,
    provider: 'rayfin',
    token: async () => own,
    azToken: async () => {
      throw new NeedsAz('Please run az login.')
    }
  })
  assert.equal(noAzure.refreshNotAllowed, true)
})

test("a refresh the app's Fabric account can't check is checked as the Azure CLI in the same organization", async () => {
  const own = jwt({ tid: 'tenant-1' })
  const azure = jwt({ tid: 'tenant-1' })
  const refused = () => [response(401, ''), response(200, { value: [] })]
  const request = { mode: 'refreshStatus', workspaceId: WS, itemId: MODEL, refreshId: REFRESH }

  const same = service(...refused(), response(200, { status: 'Completed' }))
  const status = await run(request, {
    ...same.deps,
    provider: 'rayfin',
    token: async () => own,
    azToken: async () => azure
  })
  assert.equal(status.ok, true)
  assert.equal(status.status, 'succeeded')
  assert.equal(same.calls[2].url, `${PBI}/groups/${WS}/datasets/${MODEL}/refreshes/${REFRESH}`)
  assert.equal(same.calls[2].init.headers.Authorization, `Bearer ${azure}`)

  const other = service(...refused())
  const notAllowed = await run(request, {
    ...other.deps,
    provider: 'rayfin',
    token: async () => own,
    azToken: async () => jwt({ tid: 'tenant-2' })
  })
  assert.equal(notAllowed.refreshNotAllowed, true)
  assert.match(notAllowed.error, /not check its refresh/)
})

test('throttling honors Retry-After within 1–30 s, then reports throttled', async () => {
  const { deps, sleeps } = service(
    response(429, { errorCode: 'RequestBlocked' }, { 'retry-after': '3' }),
    response(503, undefined, { 'retry-after': '120' }),
    response(200, item())
  )
  assert.equal((await run({ mode: 'getItem', workspaceId: WS, itemId: MODEL }, deps)).found, true)
  assert.deepEqual(sleeps, [3000, 30000])

  const busy = service(() =>
    response(
      429,
      { errorCode: 'RequestBlocked', message: 'Too many requests' },
      { 'retry-after': '0' }
    )
  )
  const result = await run({ mode: 'delete', workspaceId: WS, itemId: MODEL }, busy.deps)
  assert.equal(busy.calls.length, 4)
  assert.deepEqual(busy.sleeps, [5000, 5000, 5000])
  assert.equal(result.ok, false)
  assert.equal(result.throttled, true)
  assert.equal(result.status, 429)
  assert.match(result.error, /HTTP 429, RequestBlocked/)
})

test('delete succeeds, and an item that is already gone counts as deleted', async () => {
  const { deps, calls } = service(
    response(200, undefined),
    response(404, { errorCode: 'ItemNotFound', message: 'gone' })
  )
  const request = { mode: 'delete', workspaceId: WS, itemId: MODEL }
  assert.deepEqual(await run(request, deps), { ok: true })
  assert.deepEqual(await run(request, deps), { ok: true, alreadyGone: true })
  assert.equal(calls[0].method, 'DELETE')
  assert.equal(calls[0].url, `${FABRIC}/workspaces/${WS}/items/${MODEL}`)
  const denied = service(
    response(403, {
      errorCode: 'InsufficientWorkspaceRole',
      message: "User doesn't have sufficient workspace role"
    })
  )
  const result = await run(request, denied.deps)
  assert.equal(result.forbidden, true)
  assert.equal(result.errorCode, 'InsufficientWorkspaceRole')
  assert.equal(
    result.error,
    "Fabric couldn't delete the item (HTTP 403, InsufficientWorkspaceRole): User doesn't have sufficient workspace role."
  )
})

test('create sends a TMDL definition and returns a synchronously created model', async () => {
  const { deps, calls, tokens } = service(response(201, item()))
  const result = await run(
    {
      mode: 'create',
      workspaceId: WS,
      displayName: ' Sales ',
      description: 'Sales model',
      parts: PARTS
    },
    deps
  )
  assert.deepEqual(result, { ok: true, itemId: MODEL, displayName: 'Sales' })
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, `${FABRIC}/workspaces/${WS}/semanticModels`)
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.equal(calls[0].init.redirect, 'error')
  assert.deepEqual(calls[0].body, {
    displayName: 'Sales',
    description: 'Sales model',
    definition: {
      format: 'TMDL',
      parts: PARTS.map((part) => ({ ...part, payloadType: 'InlineBase64' }))
    }
  })
  assert.deepEqual(tokens, [FABRIC_RESOURCE])
})

test('create follows the operation to its result', async () => {
  const { deps, calls, sleeps } = service(
    response(202, undefined, { location: OPERATION, 'x-ms-operation-id': OP, 'retry-after': '30' }),
    response(200, { status: 'NotStarted' }, { 'retry-after': '1' }),
    response(200, { status: 'Running', percentComplete: 50 }),
    response(200, { status: 'Succeeded', percentComplete: 100 }),
    response(200, item({ displayName: 'Sales' }))
  )
  const result = await run(
    { mode: 'create', workspaceId: WS, displayName: 'Sales', parts: PARTS },
    deps
  )
  assert.deepEqual(result, { ok: true, itemId: MODEL, displayName: 'Sales' })
  assert.deepEqual(
    calls.slice(1).map((call) => `${call.method} ${call.url}`),
    [`GET ${OPERATION}`, `GET ${OPERATION}`, `GET ${OPERATION}`, `GET ${OPERATION}/result`]
  )
  assert.equal(calls[0].body.description, undefined)
  // Retry-After clamped to 10 s, then 1 s, then the 2 s default.
  assert.deepEqual(sleeps, [10000, 1000, 2000])
})

test('create follows Fabric to the regional cluster and finds the model when the result has no id', async () => {
  const cluster = `https://wabi-west-us3-a-primary-redirect.analysis.windows.net/v1/operations/${OP}/`
  const { deps, calls } = service(
    response(202, undefined, { location: cluster }),
    response(200, { status: 'Succeeded' }),
    response(404, { errorCode: 'OperationHasNoResult', message: 'No result' }),
    response(200, { value: [item({ displayName: 'sales' })] })
  )
  const result = await run(
    { mode: 'create', workspaceId: WS, displayName: 'Sales', parts: PARTS },
    deps
  )
  assert.deepEqual(result, { ok: true, itemId: MODEL, displayName: 'sales' })
  assert.equal(calls[2].url, cluster.replace(/\/$/, '') + '/result')
  assert.equal(calls[3].url, `${FABRIC}/workspaces/${WS}/items?type=SemanticModel`)
})

test('a failed create operation reports Fabric’s message, code and details', async () => {
  const { deps } = service(
    response(202, undefined, { 'x-ms-operation-id': OP }),
    response(200, {
      status: 'Failed',
      error: {
        errorCode: 'InvalidDefinition',
        message: 'The semantic model definition is invalid',
        moreDetails: [
          {
            errorCode: 'TmdlParseError',
            message: "Unexpected token 'colum' in definition/tables/Sales.tmdl at line 4"
          },
          { errorCode: 'TmdlParseError', message: 'Unknown property "formatStrin"' }
        ]
      }
    })
  )
  const result = await run(
    { mode: 'create', workspaceId: WS, displayName: 'Sales', parts: PARTS },
    deps
  )
  assert.equal(result.ok, false)
  assert.equal(result.needsLogin, false)
  assert.equal(result.needsAz, false)
  assert.equal(result.errorCode, 'InvalidDefinition')
  assert.equal(result.status, undefined)
  assert.equal(
    result.error,
    "Fabric couldn't create the semantic model (InvalidDefinition): The semantic model definition is invalid. " +
      'Details: Unexpected token \'colum\' in definition/tables/Sales.tmdl at line 4. Unknown property "formatStrin".'
  )
  assert.deepEqual(result.details, [
    {
      code: 'TmdlParseError',
      message: "Unexpected token 'colum' in definition/tables/Sales.tmdl at line 4"
    },
    { code: 'TmdlParseError', message: 'Unknown property "formatStrin"' }
  ])
  assert.equal(result.nameInUse, undefined)
})

test('a name that is already taken is reported as nameInUse without retrying', async () => {
  const { deps, calls } = service(
    response(409, {
      errorCode: 'ItemDisplayNameAlreadyInUse',
      message: 'Requested item display name is already in use',
      requestId: 'r'
    })
  )
  const result = await run(
    { mode: 'create', workspaceId: WS, displayName: 'Sales', parts: [...PARTS, PLATFORM] },
    deps
  )
  assert.equal(result.nameInUse, true)
  assert.equal(result.status, 409)
  assert.equal(
    result.error,
    "Fabric couldn't create the semantic model (HTTP 409, ItemDisplayNameAlreadyInUse): Requested item display name is already in use."
  )
  assert.equal(calls.length, 1)
})

test('create retries once without .platform when Fabric rejects that part', async () => {
  const { deps, calls } = service(
    response(400, {
      errorCode: 'InvalidDefinition',
      message: "The '.platform' part has an unsupported schema version"
    }),
    response(201, item())
  )
  const result = await run(
    { mode: 'create', workspaceId: WS, displayName: 'Sales', parts: [...PARTS, PLATFORM] },
    deps
  )
  assert.deepEqual(result, { ok: true, itemId: MODEL, displayName: 'Sales', withoutPlatform: true })
  assert.equal(calls.length, 2)
  assert.ok(calls[0].body.definition.parts.some((part) => part.path === '.platform'))
  assert.deepEqual(
    calls[1].body.definition.parts.map((part) => part.path),
    PARTS.map((part) => part.path)
  )

  // Also when a failed operation's detail points at the part; only one retry.
  const lro = service(
    response(202, undefined, { location: OPERATION }),
    response(200, {
      status: 'Failed',
      error: {
        errorCode: 'InvalidDefinition',
        message: 'Invalid definition',
        moreDetails: [
          {
            errorCode: 'InvalidPart',
            message: 'Invalid part',
            relatedResource: { resourceId: '.platform', resourceType: 'DefinitionPart' }
          }
        ]
      }
    }),
    response(400, { errorCode: 'InvalidDefinition', message: 'Still invalid: .platform' })
  )
  const failed = await run(
    { mode: 'create', workspaceId: WS, displayName: 'Sales', parts: [PLATFORM, ...PARTS] },
    lro.deps
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.status, 400)
  assert.equal(lro.calls.length, 3)

  // Without a .platform part there is nothing to drop.
  const plain = service(
    response(400, { errorCode: 'InvalidDefinition', message: 'The .platform file is missing' })
  )
  assert.equal(
    (await run({ mode: 'create', workspaceId: WS, displayName: 'Sales', parts: PARTS }, plain.deps))
      .ok,
    false
  )
  assert.equal(plain.calls.length, 1)
})

test('updateDefinition sends allowPurgeData only when asked and never updateMetadata', async () => {
  const { deps, calls } = service(response(200, undefined), response(200, undefined))
  const request = { mode: 'updateDefinition', workspaceId: WS, itemId: MODEL, parts: PARTS }
  assert.deepEqual(await run({ ...request, allowPurgeData: true }, deps), { ok: true })
  assert.deepEqual(await run({ ...request, allowPurgeData: false }, deps), { ok: true })
  for (const call of calls) {
    assert.equal(call.url, `${FABRIC}/workspaces/${WS}/semanticModels/${MODEL}/updateDefinition`)
    assert.equal(call.body.definition.format, 'TMDL')
    assert.ok(call.body.definition.parts.every((part) => part.payloadType === 'InlineBase64'))
  }
  assert.deepEqual(calls[0].body.options, { allowPurgeData: true })
  assert.equal('options' in calls[1].body, false)
})

test('updateDefinition follows its operation without asking for a result', async () => {
  const { deps, calls } = service(
    response(202, undefined, { location: OPERATION, 'retry-after': '5' }),
    response(500, { errorCode: 'InternalError', message: 'Transient' }),
    response(200, { status: 'Running' }),
    response(200, { status: 'Succeeded' })
  )
  assert.deepEqual(
    await run({ mode: 'updateDefinition', workspaceId: WS, itemId: MODEL, parts: PARTS }, deps),
    { ok: true }
  )
  assert.equal(calls.length, 4)

  const broken = service((call, index) =>
    index === 1
      ? response(202, undefined, { location: OPERATION })
      : response(500, { errorCode: 'InternalError', message: 'Operation store unavailable' })
  )
  const result = await run(
    { mode: 'updateDefinition', workspaceId: WS, itemId: MODEL, parts: PARTS },
    broken.deps
  )
  assert.equal(result.status, 500)
  assert.equal(broken.calls.length, 6)
})

test('an update that would discard loaded data is reported as purgeRequired', async () => {
  const direct = service(
    response(400, {
      errorCode: 'InvalidDefinitionUpdate',
      message:
        'This change requires existing data to be purged. Set allowPurgeData to true to apply it.'
    })
  )
  const request = { mode: 'updateDefinition', workspaceId: WS, itemId: MODEL, parts: PARTS }
  const first = await run(request, direct.deps)
  assert.equal(first.purgeRequired, true)
  assert.equal(first.status, 400)

  const lro = service(
    response(202, undefined, { location: OPERATION }),
    response(200, {
      status: 'Failed',
      error: {
        errorCode: 'Alm_InvalidRequest_PurgeRequired',
        message: 'The operation was rejected'
      }
    })
  )
  assert.equal((await run(request, lro.deps)).purgeRequired, true)

  const lost = service(
    response(400, {
      errorCode: 'UpdateRejected',
      message: 'Changing the column type means the loaded data would be dropped.'
    })
  )
  assert.equal((await run(request, lost.deps)).purgeRequired, true)

  const other = service(
    response(400, {
      errorCode: 'InvalidDefinition',
      message: "Column 'Amount' references a missing table"
    })
  )
  const unrelated = await run(request, other.deps)
  assert.equal(unrelated.ok, false)
  assert.equal(unrelated.purgeRequired, undefined)
})

test('an operation that never finishes times out on the fake clock', async () => {
  const { deps, calls, clock } = service((call, index) =>
    index === 1
      ? response(202, undefined, { location: OPERATION, 'retry-after': '10' })
      : response(200, { status: 'Running' }, { 'retry-after': '10' })
  )
  const result = await run(
    { mode: 'updateDefinition', workspaceId: WS, itemId: MODEL, parts: PARTS },
    deps
  )
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.match(result.error, /within 10 minutes/)
  assert.ok(clock() >= 10 * 60_000 && clock() < 10 * 60_000 + 10_000)
  assert.equal(calls.length, 61)

  const read = service((call, index) =>
    index === 1
      ? response(202, undefined, { location: OPERATION })
      : response(200, { status: 'Undefined' })
  )
  const definition = await run({ mode: 'getDefinition', workspaceId: WS, itemId: MODEL }, read.deps)
  assert.equal(definition.timedOut, true)
  assert.match(definition.error, /within 3 minutes/)
})

test('getDefinition returns the TMDL parts, following an operation by id when there is no Location', async () => {
  const parts = PARTS.map((part) => ({ ...part, payloadType: 'InlineBase64' }))
  const { deps, calls } = service(
    response(202, undefined, { 'x-ms-operation-id': OP, 'retry-after': '1' }),
    response(200, { status: 'Running' }),
    response(200, { status: 'Succeeded' }),
    response(
      200,
      { definition: { format: 'TMDL', parts } },
      { 'content-type': 'application/octet-stream' }
    )
  )
  const result = await run(
    { mode: 'getDefinition', workspaceId: WS, itemId: MODEL, format: 'TMDL' },
    deps
  )
  assert.deepEqual(result, { ok: true, parts: PARTS })
  assert.equal(
    calls[0].url,
    `${FABRIC}/workspaces/${WS}/semanticModels/${MODEL}/getDefinition?format=TMDL`
  )
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[1].url, OPERATION)
  assert.equal(calls[3].url, `${OPERATION}/result`)

  const direct = service(response(200, { definition: { parts } }))
  assert.deepEqual(
    await run({ mode: 'getDefinition', workspaceId: WS, itemId: MODEL }, direct.deps),
    { ok: true, parts: PARTS }
  )
  assert.equal(
    direct.calls[0].url,
    `${FABRIC}/workspaces/${WS}/semanticModels/${MODEL}/getDefinition`
  )

  // An operation poll that already carries the definition is the result.
  const inline = service(
    response(202, undefined, { location: OPERATION }),
    response(200, { definition: { parts } })
  )
  assert.deepEqual(
    await run({ mode: 'getDefinition', workspaceId: WS, itemId: MODEL }, inline.deps),
    { ok: true, parts: PARTS }
  )
  assert.equal(inline.calls.length, 2)

  const denied = service(
    response(403, {
      errorCode: 'InsufficientPrivileges',
      message: 'The caller does not have permission'
    })
  )
  const forbidden = await run(
    { mode: 'getDefinition', workspaceId: WS, itemId: MODEL },
    denied.deps
  )
  assert.equal(forbidden.forbidden, true)
  assert.match(
    forbidden.error,
    /^Fabric couldn't read the semantic model's definition \(HTTP 403, InsufficientPrivileges\)/
  )
})

test('API errors redact bearer values before they reach the result', async () => {
  const { deps } = service(
    response(400, { errorCode: 'BadRequest', message: `Header was Bearer ${TOKEN}` })
  )
  const result = await run({ mode: 'getItem', workspaceId: WS, itemId: MODEL }, deps)
  assert.equal(result.ok, false)
  assert.ok(!result.error.includes(TOKEN))
  assert.match(result.error, /Bearer \[redacted\]/)
})

test('refresh starts an enhanced refresh and returns its id from Location', async () => {
  const location = `${PBI}/groups/${WS}/datasets/${MODEL}/refreshes/${REFRESH}`
  const { deps, calls, tokens } = service(
    response(202, undefined, { location, 'x-ms-request-id': 'ignored', requestid: 'ignored' })
  )
  assert.deepEqual(await run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, deps), {
    ok: true,
    refreshId: REFRESH,
    enhanced: true
  })
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, `${PBI}/groups/${WS}/datasets/${MODEL}/refreshes`)
  assert.deepEqual(calls[0].body, { type: 'full', commitMode: 'transactional' })
  assert.deepEqual(tokens, [PBI_RESOURCE])

  const headerOnly = service(response(202, undefined, { 'x-ms-request-id': REFRESH }))
  assert.deepEqual(
    await run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, headerOnly.deps),
    { ok: true, refreshId: REFRESH, enhanced: true }
  )
  const requestId = service(response(202, undefined, { RequestId: REFRESH.toUpperCase() }))
  assert.equal(
    (await run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, requestId.deps)).refreshId,
    REFRESH.toUpperCase()
  )
})

test('a refused enhanced refresh falls back once to a standard refresh', async () => {
  for (const status of [400, 403]) {
    const { deps, calls } = service(
      response(status, {
        error: {
          code: 'InvalidRequest',
          message: 'Enhanced refresh is not supported for shared capacities'
        }
      }),
      response(202, undefined)
    )
    assert.deepEqual(await run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, deps), {
      ok: true,
      enhanced: false
    })
    assert.deepEqual(calls[1].body, { notifyOption: 'NoNotification' })
  }
  for (const [status, code] of [
    [404, 'ItemNotFound'],
    [500, 'InternalError']
  ]) {
    const { deps, calls } = service(
      response(status, { error: { code, message: 'Dataset not available' } })
    )
    const result = await run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, deps)
    assert.equal(result.ok, false)
    assert.equal(calls.length, 1)
    assert.equal(result.notFound, status === 404 ? true : undefined)
  }
  const both = service(
    response(400, {
      error: { code: 'InvalidRequest', message: 'Enhanced refresh is not supported' }
    }),
    response(403, {
      error: {
        code: 'Unauthorized',
        message: 'Not allowed',
        details: [{ code: 'Reason', message: 'Build permission required' }]
      }
    })
  )
  const denied = await run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, both.deps)
  assert.equal(denied.forbidden, true)
  assert.equal(
    denied.error,
    "Power BI couldn't start a refresh (HTTP 403, Unauthorized): Not allowed. Details: Build permission required."
  )
  assert.deepEqual(denied.details, [{ code: 'Reason', message: 'Build permission required' }])
})

test('a refresh that is already running is reported as alreadyRunning', async () => {
  const running = service(
    response(400, {
      error: { code: 'InvalidRequest', message: 'Another refresh request is already executing' }
    })
  )
  const result = await run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, running.deps)
  assert.equal(result.ok, false)
  assert.equal(result.alreadyRunning, true)
  assert.equal(running.calls.length, 1)
  const conflict = service(
    response(409, { error: { code: 'Conflict', message: 'A refresh is already in progress' } })
  )
  assert.equal(
    (await run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, conflict.deps)).alreadyRunning,
    true
  )
  const fallback = service(
    response(403, { error: { code: 'Forbidden', message: 'Enhanced refresh is not allowed' } }),
    response(400, {
      error: { code: 'InvalidRequest', message: 'Refresh is already in progress for this dataset' }
    })
  )
  assert.equal(
    (await run({ mode: 'refresh', workspaceId: WS, itemId: MODEL }, fallback.deps)).alreadyRunning,
    true
  )
})

test('refreshStatus reads an enhanced refresh by id', async () => {
  const request = { mode: 'refreshStatus', workspaceId: WS, itemId: MODEL, refreshId: REFRESH }
  const completed = service(
    response(200, {
      startTime: '2026-11-24T08:40:31.57',
      endTime: '2026-11-24T08:40:43.87',
      type: 'Full',
      status: 'Completed',
      extendedStatus: 'Completed',
      messages: [{ code: '0x1', message: 'Just a note', type: 'Warning' }]
    })
  )
  assert.deepEqual(await run(request, completed.deps), {
    ok: true,
    status: 'succeeded',
    refreshId: REFRESH,
    startTime: '2026-11-24T08:40:31.57',
    endTime: '2026-11-24T08:40:43.87',
    errors: []
  })
  assert.equal(completed.calls[0].url, `${PBI}/groups/${WS}/datasets/${MODEL}/refreshes/${REFRESH}`)

  const failed = service(
    response(200, {
      startTime: 's',
      endTime: 'e',
      status: 'Failed',
      extendedStatus: 'Failed',
      messages: [
        {
          code: '0xC112001C',
          message: 'Expression.Error: The column Amount of the table wasn’t found.',
          type: 'Error'
        },
        { code: '0x0', message: 'Some warning', type: 'Warning' }
      ],
      serviceExceptionJson: '{"errorCode":"ModelRefresh_ShortMessage_ProcessingError"}'
    })
  )
  const failure = await run(request, failed.deps)
  assert.equal(failure.status, 'failed')
  assert.deepEqual(failure.errors, [
    {
      code: '0xC112001C',
      message: 'Expression.Error: The column Amount of the table wasn’t found.'
    },
    {
      code: 'ModelRefresh_ShortMessage_ProcessingError',
      message: 'ModelRefresh_ShortMessage_ProcessingError'
    }
  ])
  assert.equal(failure.needsCredentials, undefined)

  const warningsOnly = service(
    response(200, {
      status: 'Failed',
      extendedStatus: 'TimedOut',
      messages: [{ message: 'Timed out loading Sales', type: 'Warning' }]
    })
  )
  assert.deepEqual((await run(request, warningsOnly.deps)).errors, [
    { code: null, message: 'Timed out loading Sales' }
  ])

  const states = [
    [{ status: 'InProgress' }, 'running'],
    [{ status: 'Unknown', extendedStatus: 'NotStarted' }, 'notStarted'],
    [{ status: 'Unknown', extendedStatus: 'InProgress' }, 'running'],
    [{ status: 'Unknown' }, 'running'],
    [{ status: 'Cancelled' }, 'cancelled'],
    [{ status: 'Disabled' }, 'cancelled'],
    [{ status: 'SomethingNew' }, 'unknown']
  ]
  for (const [body, status] of states) {
    const { deps } = service(response(202, { startTime: 's', ...body }))
    const result = await run(request, deps)
    assert.equal(result.status, status, JSON.stringify(body))
    assert.equal(result.endTime, undefined)
  }
})

test('refreshStatus without an id reads the latest refresh from the history', async () => {
  const request = { mode: 'refreshStatus', workspaceId: WS, itemId: MODEL }
  const running = service(
    response(200, {
      value: [{ refreshType: 'ViaApi', startTime: 's', status: 'Unknown', requestId: REFRESH }]
    })
  )
  assert.deepEqual(await run(request, running.deps), {
    ok: true,
    status: 'running',
    refreshId: REFRESH,
    startTime: 's',
    errors: []
  })
  assert.equal(running.calls[0].url, `${PBI}/groups/${WS}/datasets/${MODEL}/refreshes?$top=1`)

  const credentials = service(
    response(200, {
      value: [
        {
          refreshType: 'ViaApi',
          startTime: 's',
          endTime: 'e',
          status: 'Failed',
          requestId: REFRESH,
          serviceExceptionJson: '{"errorCode":"ModelRefreshFailed_CredentialsNotSpecified"}'
        }
      ]
    })
  )
  const missing = await run(request, credentials.deps)
  assert.equal(missing.status, 'failed')
  assert.equal(missing.needsCredentials, true)
  assert.deepEqual(missing.errors, [
    {
      code: 'ModelRefreshFailed_CredentialsNotSpecified',
      message: 'ModelRefreshFailed_CredentialsNotSpecified'
    }
  ])

  const duplicate =
    "Column 'CustomerKey' in Table 'Customer' contains a duplicate value '42' and this is not allowed for columns on the one side of a many-to-one relationship or for columns that are used as the primary key of a table."
  const duplicates = service(
    response(200, {
      value: [
        {
          status: 'Failed',
          endTime: 'e',
          serviceExceptionJson: JSON.stringify({
            errorCode: 'ModelRefresh_ShortMessage_ProcessingError',
            errorDescription: duplicate
          })
        }
      ]
    })
  )
  const processing = await run(request, duplicates.deps)
  assert.deepEqual(processing.errors, [
    { code: 'ModelRefresh_ShortMessage_ProcessingError', message: duplicate }
  ])
  assert.equal(processing.needsCredentials, undefined)

  const gateway = service(
    response(200, {
      value: [
        {
          status: 'Failed',
          refreshAttempts: [
            {
              attemptId: 1,
              serviceExceptionJson: JSON.stringify({
                error: {
                  code: 'DM_GWPipeline_Gateway_DataSourceAccessError',
                  'pbi.error': {
                    code: 'DM_GWPipeline_Gateway_DataSourceAccessError',
                    parameters: {},
                    details: [
                      {
                        code: 'DM_ErrorDetailNameCode_UnderlyingErrorCode',
                        detail: { type: 1, value: '-2147467259' }
                      },
                      {
                        code: 'DM_ErrorDetailNameCode_UnderlyingErrorMessage',
                        detail: {
                          type: 1,
                          value: 'The credentials provided for the SQL source are invalid.'
                        }
                      }
                    ]
                  }
                }
              })
            }
          ]
        }
      ]
    })
  )
  const access = await run(request, gateway.deps)
  assert.deepEqual(access.errors, [
    {
      code: 'DM_GWPipeline_Gateway_DataSourceAccessError',
      message: 'The credentials provided for the SQL source are invalid.'
    }
  ])
  assert.equal(access.needsCredentials, true)
  assert.equal(access.refreshId, undefined)

  const raw = service(
    response(200, {
      value: [{ status: 'Failed', serviceExceptionJson: 'Data source error: not JSON' }]
    })
  )
  assert.deepEqual((await run(request, raw.deps)).errors, [
    { code: null, message: 'Data source error: not JSON' }
  ])

  const empty = service(response(200, { value: [] }))
  assert.deepEqual(await run(request, empty.deps), { ok: true, status: 'unknown', errors: [] })

  const denied = service(
    response(403, { error: { code: 'ItemNotFoundOrInsufficientPermissions', message: 'Denied' } })
  )
  const forbidden = await run(request, denied.deps)
  assert.equal(forbidden.forbidden, true)
  assert.match(forbidden.error, /^Power BI couldn't read the model's refresh history \(HTTP 403/)
})

// ── Lakehouses ───────────────────────────────────────────────────────────────
const LAKE = 'bbbbbbbb-1111-4222-8333-444444444444'
const ONELAKE = 'https://msit-onelake.dfs.fabric.microsoft.com'
const LAKE_ROOT = `${ONELAKE}/${WS}/${LAKE}`

// A file to upload, in memory: what `open` gives the helper.
function memoryFile(bytes) {
  const data = Buffer.from(bytes)
  const handle = {
    closed: false,
    stat: async () => ({ size: data.length }),
    read: async (buffer, offset, length, position) => {
      const bytesRead = data.copy(buffer, offset, position, position + length)
      return { bytesRead }
    },
    close: async () => {
      handle.closed = true
    }
  }
  return handle
}

test('createLakehouse creates one as the account and follows its operation', async () => {
  const { deps, calls } = service(response(201, { id: LAKE, displayName: 'Sales' }))
  assert.deepEqual(
    await run(
      {
        mode: 'createLakehouse',
        workspaceId: WS,
        displayName: 'Sales',
        description: 'For the app'
      },
      deps
    ),
    { ok: true, itemId: LAKE }
  )
  assert.equal(calls[0].url, `${FABRIC}/workspaces/${WS}/lakehouses`)
  assert.deepEqual(calls[0].body, { displayName: 'Sales', description: 'For the app' })

  const later = service(
    response(202, undefined, { location: OPERATION, 'retry-after': '1' }),
    response(200, { status: 'Succeeded' }),
    response(200, { id: LAKE, displayName: 'Sales' })
  )
  assert.deepEqual(
    await run({ mode: 'createLakehouse', workspaceId: WS, displayName: 'Sales' }, later.deps),
    {
      ok: true,
      itemId: LAKE
    }
  )
  assert.equal(later.calls[2].url, `${OPERATION}/result`)

  const taken = service(
    response(409, { errorCode: 'ItemDisplayNameAlreadyInUse', message: 'Name in use.' })
  )
  const refused = await run(
    { mode: 'createLakehouse', workspaceId: WS, displayName: 'Sales' },
    taken.deps
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.nameInUse, true)
})

test('getLakehouse returns its OneLake paths, or found:false when it is gone', async () => {
  const { deps } = service(
    response(200, {
      id: LAKE,
      displayName: 'Sales',
      properties: {
        oneLakeFilesPath: `${LAKE_ROOT}/Files`,
        oneLakeTablesPath: `${LAKE_ROOT}/Tables`,
        sqlEndpointProperties: {
          connectionString: 'x.datawarehouse.fabric.microsoft.com',
          id: 'e1',
          provisioningStatus: 'Success'
        }
      }
    })
  )
  assert.deepEqual(await run({ mode: 'getLakehouse', workspaceId: WS, itemId: LAKE }, deps), {
    ok: true,
    found: true,
    lakehouse: {
      id: LAKE,
      displayName: 'Sales',
      oneLakeFilesPath: `${LAKE_ROOT}/Files`,
      oneLakeTablesPath: `${LAKE_ROOT}/Tables`,
      sqlEndpoint: 'x.datawarehouse.fabric.microsoft.com',
      sqlEndpointId: 'e1'
    }
  })
  const gone = service(response(404, { errorCode: 'EntityNotFound' }))
  assert.deepEqual(await run({ mode: 'getLakehouse', workspaceId: WS, itemId: LAKE }, gone.deps), {
    ok: true,
    found: false
  })
})

test('listTables follows continuation links and sorts the tables by name', async () => {
  const { deps, calls } = service(
    response(200, { data: [{ name: 'orders', format: 'delta' }], continuationToken: 'next' }),
    response(200, { data: [{ name: 'Customers', format: 'delta' }, { name: '' }] })
  )
  assert.deepEqual(await run({ mode: 'listTables', workspaceId: WS, itemId: LAKE }, deps), {
    ok: true,
    tables: [
      { name: 'Customers', format: 'delta' },
      { name: 'orders', format: 'delta' }
    ]
  })
  assert.match(calls[1].url, /continuationToken=next/)
})

test('loadTable replaces a table from a CSV or Parquet path in Files, and follows the load', async () => {
  const { deps, calls } = service(
    response(202, undefined, { location: OPERATION, 'retry-after': '1' }),
    response(200, { status: 'Succeeded' })
  )
  const request = {
    mode: 'loadTable',
    workspaceId: WS,
    itemId: LAKE,
    table: 'orders',
    relativePath: 'Files/data/orders.csv',
    delimiter: ';'
  }
  assert.deepEqual(await run(request, deps), { ok: true })
  assert.equal(calls[0].url, `${FABRIC}/workspaces/${WS}/lakehouses/${LAKE}/tables/orders/load`)
  assert.deepEqual(calls[0].body, {
    relativePath: 'Files/data/orders.csv',
    pathType: 'File',
    mode: 'Overwrite',
    recursive: false,
    formatOptions: { format: 'Csv', header: true, delimiter: ';' }
  })

  const folder = service(response(200, {}))
  await run(
    {
      ...request,
      table: 'events',
      relativePath: 'Files/data/events',
      pathType: 'Folder',
      format: 'Parquet'
    },
    folder.deps
  )
  assert.deepEqual(folder.calls[0].body.formatOptions, { format: 'Parquet' })
  assert.equal(folder.calls[0].body.recursive, true)

  const failed = service(
    response(202, undefined, { location: OPERATION, 'retry-after': '1' }),
    response(200, {
      status: 'Failed',
      error: { errorCode: 'InvalidInput', message: 'Column count mismatch.' }
    })
  )
  const outcome = await run(request, failed.deps)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /couldn't load the table orders.*Column count mismatch/)

  for (const bad of [
    { table: 'bad name' },
    { relativePath: 'data/orders.csv' },
    { relativePath: 'Files/../x.csv' }
  ]) {
    const none = service()
    const result = await run({ ...request, ...bad }, none.deps)
    assert.equal(result.ok, false)
    assert.equal(none.calls.length, 0)
  }
})

test('files go up to OneLake as the Azure CLI, in the same organization only, in chunks', async () => {
  const own = jwt({ tid: 'tenant-1', upn: 'ada@contoso.com' })
  const azure = jwt({ tid: 'TENANT-1', upn: 'ada@contoso.com' })
  const file = memoryFile('Id,Region\n1,West\n')
  const remote = `${LAKE_ROOT}/Files/data/orders%20list.csv`
  const { deps, calls } = service(response(201), response(202), response(200))
  const request = {
    mode: 'uploadFiles',
    workspaceId: WS,
    itemId: LAKE,
    oneLake: `${LAKE_ROOT}/Files`,
    files: [
      {
        local: 'C:/apps/sales/supporting-items/Sales.Lakehouse/data/orders list.csv',
        remote: 'Files/data/orders list.csv'
      }
    ]
  }
  const uploaded = await run(request, {
    ...deps,
    provider: 'rayfin',
    token: async () => own,
    azToken: async () => azure,
    open: async () => file
  })
  assert.deepEqual(uploaded, {
    ok: true,
    uploaded: [{ remote: 'Files/data/orders list.csv', bytes: 17 }]
  })
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      `PUT ${remote}?resource=file`,
      `PATCH ${remote}?action=append&position=0`,
      `PATCH ${remote}?action=flush&position=17`
    ]
  )
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${azure}`)
  assert.equal(calls[1].init.headers['Content-Type'], 'application/octet-stream')
  assert.equal(Buffer.from(calls[1].init.body).toString(), 'Id,Region\n1,West\n')
  assert.equal(calls[0].init.headers['x-ms-version'], '2023-11-03')
  assert.equal(file.closed, true)

  const other = service()
  const refused = await run(request, {
    ...other.deps,
    provider: 'rayfin',
    token: async () => own,
    azToken: async () => jwt({ tid: 'tenant-2' }),
    open: async () => memoryFile('x')
  })
  assert.equal(refused.uploadNotAllowed, true)
  assert.match(refused.error, /another organization/)
  assert.equal(other.calls.length, 0, 'nothing goes up as another organization')

  const signedOut = await run(request, {
    ...other.deps,
    provider: 'rayfin',
    token: async () => own,
    azToken: async () => {
      throw new NeedsAz('Please run az login.')
    }
  })
  assert.equal(signedOut.uploadNotAllowed, true)

  const elsewhere = await run({ ...request, oneLake: 'https://evil.example.com/x' }, deps)
  assert.equal(elsewhere.ok, false)
})

test('uploadCheck says whether files can go up, and as whom', async () => {
  const { deps } = service()
  const own = jwt({ tid: 't1', upn: 'ada@contoso.com' })
  assert.deepEqual(
    await run(
      { mode: 'uploadCheck' },
      {
        ...deps,
        provider: 'rayfin',
        token: async () => own,
        azToken: async () => jwt({ tid: 't1', upn: 'ada@contoso.com' })
      }
    ),
    { ok: true, user: 'ada@contoso.com' }
  )
  const refused = await run(
    { mode: 'uploadCheck' },
    { ...deps, provider: 'rayfin', token: async () => own, azToken: async () => jwt({ tid: 't2' }) }
  )
  assert.equal(refused.uploadNotAllowed, true)
})

test("tableSchema reads a table's columns from the latest commit with a schema", async () => {
  const schema = (fields) =>
    JSON.stringify({ metaData: { schemaString: JSON.stringify({ type: 'struct', fields }) } })
  const { deps, calls } = service(
    response(200, {
      paths: [
        { name: `${LAKE}/Tables/orders/_delta_log/00000000000000000000.json` },
        { name: `${LAKE}/Tables/orders/_delta_log/00000000000000000001.json` },
        { name: `${LAKE}/Tables/orders/_delta_log/_last_checkpoint` }
      ]
    }),
    response(200, `{"commitInfo":{}}\n{"add":{}}`, { 'content-type': 'application/octet-stream' }),
    response(
      200,
      `{"protocol":{}}\n${schema([
        { name: 'Id', type: 'long', nullable: true },
        { name: 'Region', type: 'string', nullable: true },
        { name: 'Tags', type: { type: 'array', elementType: 'string' } }
      ])}`,
      { 'content-type': 'application/octet-stream' }
    )
  )
  const result = await run(
    {
      mode: 'tableSchema',
      workspaceId: WS,
      itemId: LAKE,
      oneLake: `${LAKE_ROOT}/Tables`,
      table: 'orders'
    },
    deps
  )
  assert.deepEqual(result, {
    ok: true,
    columns: [
      { name: 'Id', type: 'long' },
      { name: 'Region', type: 'string' },
      { name: 'Tags', type: 'array' }
    ]
  })
  assert.equal(
    calls[0].url,
    `${ONELAKE}/${WS}?resource=filesystem&recursive=false&directory=${encodeURIComponent(`${LAKE}/Tables/orders/_delta_log`)}`
  )
  assert.equal(calls[1].url, `${LAKE_ROOT}/Tables/orders/_delta_log/00000000000000000001.json`)
  assert.deepEqual(
    deltaColumns({ metaData: { schemaString: '{"fields":[{"name":"A","type":"double"}]}' } }),
    [{ name: 'A', type: 'double' }]
  )
  assert.equal(deltaColumns({ _text: '{"add":{}}' }), null)
})

test('OneLake addresses stay on OneLake', () => {
  assert.equal(
    oneLakeRoot(undefined, WS, LAKE),
    `https://onelake.dfs.fabric.microsoft.com/${WS}/${LAKE}`
  )
  assert.equal(oneLakeRoot(`${LAKE_ROOT}/Files`, WS, LAKE), LAKE_ROOT)
  assert.throws(() => oneLakeRoot('https://onelake.dfs.fabric.microsoft.com.evil.com/x', WS, LAKE))
  assert.throws(() => oneLakeRoot('http://onelake.dfs.fabric.microsoft.com/x', WS, LAKE))
})
