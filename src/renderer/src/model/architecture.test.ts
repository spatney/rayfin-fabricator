import { describe, expect, it } from 'vitest'
import {
  buildArchitecture,
  classifyHost,
  connectorAbility,
  connectorIdentity,
  describeAppIdentity,
  hardcodedSummary,
  parseRayfinConfig,
  routesThrough,
  scanFunctions,
  type AppArchitecture
} from './architecture'
import { parseDataModel } from './parseSchema'

const WS = '11111111-1111-4111-8111-111111111111'
const WAREHOUSE = '22222222-2222-4222-8222-222222222222'
const SPEND = '33333333-3333-4333-8333-333333333333'
const BUDGETS = '44444444-4444-4444-8444-444444444444'

const RAYFIN_YML = `id: contoso-expenses
name: Contoso Expenses
version: 1.0.0
services:
  auth:
    enabled: true
    fabric:
      enabled: true
    allowedRedirectUris:
      - http://localhost:5173
      - https://contoso-expenses.fabricapps.net
  data:
    enabled: true
    dialect: mssql
  staticHosting:
    enabled: true
    folder: dist
    assetAccess: protected
  functions:
    enabled: true
    auth:
      type: application
  storage:
    enabled: false
connectors:
  - name: finance-warehouse
    type: fabric-warehouse
    config:
      workspaceId: ${WS}
      itemId: ${WAREHOUSE}
    auth:
      type: application
    operations:
      - name: read
  - name: spend-model
    type: fabric-semanticmodel
    version: '1'
    config:
      workspaceId: ${WS}
      itemId: ${SPEND.toUpperCase()}
    auth:
      type: delegated
secrets:
  - name: RECEIPT_OCR_KEY
    description: Key for the receipt reader
`

const FUNCTIONS = `import { AudienceType, UserDataFunctions, type RayfinContext } from '@microsoft/fabric-user-data-functions'
const udf = new UserDataFunctions()

udf.func(
  'summarizeReport',
  async (ctx: RayfinContext<AppSchema, AudienceType.AzureAI>): Promise<string> => ctx.Tokens.AzureAI,
  []
)

udf.func('syncBudgets', async (ctx: RayfinContext<AppSchema, AudienceType.Sql | AudienceType.Fabric>) => 1, [])
// udf.func('retired', async (ctx: RayfinContext<AppSchema, AudienceType.ADO>) => 1, [])
`

const SCHEMA = `import { Expense } from './Expense.js'
import { Report } from './Report.js'
export const schema = [Expense, Report]
`
const EXPENSE = `import { entity, authenticated, uuid, text, one } from '@microsoft/rayfin-core'
@entity()
@authenticated('*', { policy: (q, claims) => q.where('owner_id', claims.sub) })
export class Expense {
  @uuid() id!: string
  @text() owner_id!: string
  @one(() => Report) report!: Report
}
`
const REPORT = `import { entity, anonymous, uuid, text } from '@microsoft/rayfin-core'
@entity()
@anonymous('read')
export class Report {
  @uuid() id!: string
  @text() title!: string
}
`

async function sample(over: Partial<Parameters<typeof buildArchitecture>[0]> = {}): Promise<AppArchitecture> {
  const files: Record<string, string> = {
    'rayfin/data/schema.ts': SCHEMA,
    'rayfin/data/Expense.ts': EXPENSE,
    'rayfin/data/Report.ts': REPORT
  }
  const dataModel = await parseDataModel(async (p) => files[p] ?? null)
  const built = buildArchitecture({
    projectName: 'contoso-expenses',
    rayfinYml: RAYFIN_YML,
    fabric: {
      activeProfile: 'default',
      models: [
        { alias: 'spend', workspaceId: WS, itemId: SPEND },
        { alias: 'budgets', workspaceId: WS, itemId: BUDGETS }
      ]
    },
    dataModel,
    functionSources: [{ path: 'rayfin/functions/src/function_app.ts', text: FUNCTIONS }],
    ...over
  })
  if ('error' in built) throw new Error(built.error)
  return built
}

describe('parseRayfinConfig', () => {
  it('reads services, connectors and secrets', () => {
    const config = parseRayfinConfig(RAYFIN_YML)!
    expect(config.name).toBe('Contoso Expenses')
    expect(config.auth).toMatchObject({ enabled: true, fabric: true, externalEntraExchange: false })
    expect(config.auth.redirectUris).toHaveLength(2)
    expect(config.hosting).toMatchObject({ enabled: true, assetAccess: 'protected', embeddedOnly: false })
    expect(config.functions).toMatchObject({ enabled: true, authType: 'application', path: 'rayfin/functions' })
    expect(config.connectors.map((c) => [c.name, c.type, c.auth, c.operations])).toEqual([
      ['finance-warehouse', 'fabric-warehouse', 'application', ['read']],
      ['spend-model', 'fabric-semanticmodel', 'delegated', []]
    ])
    expect(config.secrets).toEqual([{ name: 'RECEIPT_OCR_KEY', description: 'Key for the receipt reader' }])
  })

  it('reads the older map-shaped connectors block', () => {
    const config = parseRayfinConfig(`services: {}
connectors:
  sales:
    connector: fabric-semanticmodel
    config: { workspaceId: a, itemId: b }
    auth:
      type: delegated
`)!
    expect(config.connectors).toEqual([
      expect.objectContaining({ name: 'sales', type: 'fabric-semanticmodel', workspaceId: 'a', itemId: 'b', auth: 'delegated' })
    ])
  })

  it('returns null for text that is not a YAML mapping', () => {
    expect(parseRayfinConfig('services: [')).toBeNull()
    expect(parseRayfinConfig('- just\n- a list')).toBeNull()
  })
})

describe('scanFunctions', () => {
  it('finds each function and the audiences its handler declares, ignoring comments', () => {
    const scan = scanFunctions([{ path: 'f.ts', text: FUNCTIONS }])
    expect(scan.functions).toEqual([
      { name: 'summarizeReport', audiences: ['AzureAI'], file: 'f.ts' },
      { name: 'syncBudgets', audiences: ['Sql', 'Fabric'], file: 'f.ts' }
    ])
    expect(scan.audiences).toEqual(['AzureAI', 'Sql', 'Fabric'])
  })

  it('finds the web APIs functions call, the secrets they read and keys written into the code', () => {
    const scan = scanFunctions([
      {
        path: 'rayfin/functions/src/keys.ts',
        text: `export const OPENAI_API_KEY = 'k3yValue9a8b7c6d5e4f'
export const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token'
export const KEY_HEADER = 'Ocp-Apim-Subscription-Key'
export const BACKUP_KEY = '<your-key-here-123456>'
`
      },
      {
        path: 'rayfin/functions/src/function_app.ts',
        text: `udf.func('posts', async (ctx) => fetch('https://oauth.reddit.com/r/all', { headers: { k: ctx.Secrets.REDDIT_SECRET } }), [])
udf.func('docs', async () => 'see https://learn.microsoft.com/x', [])
`
      },
      { path: 'rayfin/functions/src/keys.example.ts', text: `export const SAMPLE_API_KEY = 'abc123abc123abc123abc'\nfetch('https://api.example.com')` }
    ])
    expect(scan.calls).toEqual([
      { host: 'www.reddit.com', file: 'rayfin/functions/src/keys.ts', functions: [] },
      { host: 'oauth.reddit.com', file: 'rayfin/functions/src/function_app.ts', functions: ['posts'] },
      { host: 'learn.microsoft.com', file: 'rayfin/functions/src/function_app.ts', functions: ['docs'] }
    ])
    expect(scan.secretsUsed).toEqual(['REDDIT_SECRET'])
    expect(scan.secretReads).toEqual([
      {
        name: 'REDDIT_SECRET',
        functions: ['posts'],
        files: ['rayfin/functions/src/function_app.ts'],
        typed: true,
        legacy: false
      }
    ])
    expect(scan.hardcoded).toEqual([{ file: 'rayfin/functions/src/keys.ts', name: 'OPENAI_API_KEY' }])
  })

  it('finds secrets read with the deprecated ctx.getSecret, and in shared helpers', () => {
    const scan = scanFunctions([
      {
        path: 'src/a.ts',
        text: `const key = (ctx) => ctx.getSecret('LEGACY_KEY')
udf.func('one', async (ctx) => ctx.Secrets.SHARED_KEY, [])
// ctx.Secrets.COMMENTED_OUT
`
      },
      { path: 'src/b.ts', text: `udf.func('two', async (ctx) => ctx.Secrets.SHARED_KEY + ctx.getSecret("SHARED_KEY"), [])` }
    ])
    expect(scan.secretReads).toEqual([
      { name: 'SHARED_KEY', functions: ['one', 'two'], files: ['src/a.ts', 'src/b.ts'], typed: true, legacy: true },
      { name: 'LEGACY_KEY', functions: [], files: ['src/a.ts'], typed: false, legacy: true }
    ])
  })
})

describe('classifyHost', () => {
  it('names well-known services, and which audience reaches them as the app', () => {
    expect(classifyHost('contoso.services.ai.azure.com')).toMatchObject({ label: 'Azure AI Foundry', audience: 'AzureAI' })
    expect(classifyHost('workiq.svc.cloud.microsoft')).toMatchObject({ label: 'Work IQ', audience: 'WorkIQ' })
    expect(classifyHost('api.github.com')).toMatchObject({ label: 'GitHub' })
    expect(classifyHost('api.openai.com')?.audience).toBeUndefined()
  })

  it('groups a site’s hosts and names services on hosting platforms', () => {
    expect(classifyHost('oauth.reddit.com')).toMatchObject({ key: 'web:reddit.com', label: 'Reddit' })
    expect(classifyHost('www.reddit.com')?.key).toBe('web:reddit.com')
    expect(classifyHost('api.contoso.co.uk')).toMatchObject({ key: 'web:contoso.co.uk', label: 'Contoso' })
    expect(classifyHost('mem0.icy-stone.eastus2.azurecontainerapps.io')).toMatchObject({
      label: 'mem0',
      typeLabel: 'Azure Container Apps',
      vendor: 'azure'
    })
  })

  it('ignores links, docs, sign-in and the app’s own pages', () => {
    for (const host of ['localhost', 'learn.microsoft.com', 'github.com', 'login.microsoftonline.com', 'app.fabric.microsoft.com', 'x.fabricapps.net']) {
      expect(classifyHost(host)).toBeNull()
    }
  })
})

describe('connectors', () => {
  it('runs each connector as its auth.type says, and flags what rayfin up rejects', () => {
    const c = (type: string, auth?: string) => ({ name: 'x', type, operations: [], auth })
    expect(connectorIdentity(c('fabric-warehouse', 'application'))).toEqual({ identity: 'app', issues: [] })
    expect(connectorIdentity(c('fabric-warehouse', 'delegated'))).toEqual({ identity: 'user', issues: [] })

    const semanticApp = connectorIdentity(c('fabric-semanticmodel', 'application'))
    expect(semanticApp.identity).toBe('app')
    expect(semanticApp.issues[0].text).toMatch(/only allow `delegated`/)

    expect(connectorIdentity(c('fabric-sqldatabase')).issues[0].text).toMatch(/no `auth.type`/)
    expect(connectorIdentity(c('fabric-sqldatabase', 'Application')).issues[0].text).toMatch(/lowercase/)
    expect(connectorIdentity(c('kusto', 'obo')).issues[0].text).toMatch(/isn’t valid/)
  })

  it('describes what a connector can do', () => {
    const c = (type: string, operations: string[]) => ({ name: 'x', type, operations })
    expect(connectorAbility(c('fabric-warehouse', []))).toBe('Reads and writes')
    expect(connectorAbility(c('fabric-warehouse', ['read']))).toBe('Read only')
    expect(connectorAbility(c('fabric-semanticmodel', []))).toBe('Runs DAX queries')
    expect(connectorAbility(c('kusto', ['executeQuery']))).toBe('Runs KQL queries')
  })
})

describe('buildArchitecture', () => {
  it('lists the app’s services in a stable order with plain summaries', async () => {
    const arch = await sample()
    expect(arch.name).toBe('Contoso Expenses')
    expect(arch.services.map((s) => [s.kind, s.summary])).toEqual([
      ['website', 'Hosted on Fabric'],
      ['signin', 'Microsoft Entra ID, through Fabric'],
      ['database', '2 tables · 1 relationship'],
      ['connectors', '2 connectors to Fabric data'],
      ['functions', '2 server-side functions'],
      ['secrets', '1 secret, stored with the app']
    ])
    const db = arch.services.find((s) => s.kind === 'database')!
    expect(db.meta).toBe('1 row-scoped · 1 public')
    expect(db.tone).toBe('danger')
    expect(arch.database?.tables.map((t) => [t.name, t.tone])).toEqual([
      ['Expense', 'ok'],
      ['Report', 'danger']
    ])
    const fn = arch.services.find((s) => s.kind === 'functions')!
    expect(fn.meta).toBe('Reaches Azure AI Foundry, Fabric SQL & Azure SQL and Fabric REST APIs')
    const secrets = arch.services.find((s) => s.kind === 'secrets')!
    expect(secrets).toMatchObject({ meta: 'RECEIPT_OCR_KEY', issues: [] })
    expect(arch.people).toMatchObject({ access: 'protected', tone: 'ok', signIn: 'Microsoft Entra ID, through Fabric' })
  })

  it('routes each connection through the identity it runs as', async () => {
    const arch = await sample()
    const byTitle = Object.fromEntries(arch.sources.map((s) => [s.title, s]))
    // Delegated first, then the app's.
    expect(arch.sources.map((s) => [s.title, s.identity])).toEqual([
      ['Budgets', 'user'],
      ['Spend', 'user'],
      ['Azure AI Foundry', 'app'],
      ['Fabric REST APIs', 'app'],
      ['Fabric SQL & Azure SQL', 'app'],
      ['Finance warehouse', 'app']
    ])
    // The model declared in fabric.yaml and as a connector is one source (ids match case-insensitively).
    const spend = byTitle.Spend
    expect(spend.kind).toBe('connector')
    expect(spend.typeLabel).toBe('Semantic model')
    expect(spend.connectors.map((c) => c.name)).toEqual(['spend-model'])
    expect(spend.modelAliases).toEqual(['spend'])
    expect(spend.files).toEqual(['fabric.yaml', 'rayfin/rayfin.yml'])
    expect(arch.routes.filter((r) => r.source === spend.id)).toEqual([
      { service: 'svc:website', identity: 'user', source: spend.id },
      { service: 'svc:connectors', identity: 'user', source: spend.id }
    ])
    expect(byTitle['Finance warehouse']).toMatchObject({ ability: 'Read only', identity: 'app' })
    expect(byTitle['Azure AI Foundry'].functions).toEqual(['summarizeReport'])
    expect(byTitle['Fabric SQL & Azure SQL'].functions).toEqual(['syncBudgets'])

    // The Fabric data view gets each model once, and the SQL connector's tables.
    expect(arch.semanticModels.map((m) => m.alias)).toEqual(['spend', 'budgets'])
    expect(arch.sqlConnectors.map((c) => c.name)).toEqual(['finance-warehouse'])
    expect(byTitle['Finance warehouse'].tablesKey).toBe('sql:finance-warehouse')
    expect(spend.tablesKey).toBeUndefined()
  })

  it('narrows the routes to what a node touches', async () => {
    const arch = await sample()
    expect(routesThrough(arch, null)).toBeNull()
    expect(routesThrough(arch, 'app')).toBeNull()
    expect(routesThrough(arch, 'id:app')!.every((r) => r.identity === 'app')).toBe(true)
    expect(routesThrough(arch, 'svc:functions')!.map((r) => r.source)).toEqual([
      'src:aud:AzureAI',
      'src:aud:Sql',
      'src:aud:Fabric'
    ])
  })

  it('flags configuration rayfin up rejects, and says when pages load before sign-in', async () => {
    const yml = RAYFIN_YML.replace('assetAccess: protected', 'assetAccess: public').replace(
      '  functions:\n    enabled: true\n    auth:\n      type: application',
      '  functions:\n    enabled: true'
    )
    const arch = await sample({ rayfinYml: yml })
    // Public pages are common: a note, not a warning, since the data still needs sign-in.
    expect(arch.people.tone).toBe('ok')
    expect(arch.people.issues.map((i) => i.tone)).toEqual(['info'])
    const website = arch.services.find((s) => s.kind === 'website')!
    expect(website.status).toEqual({ tone: 'off', icon: 'globe', text: 'Pages load before sign-in' })
    expect(website.tone).toBeUndefined()
    const fn = arch.services.find((s) => s.kind === 'functions')!
    expect(fn.tone).toBe('danger')
    expect(fn.issues[0].text).toMatch(/requires/)
  })

  it('reports an unreadable or invalid rayfin.yml', () => {
    const base = { projectName: 'x', fabric: null, dataModel: null, functionSources: [] }
    expect(buildArchitecture({ ...base, rayfinYml: null })).toEqual({ error: expect.stringContaining('couldn’t read') })
    expect(buildArchitecture({ ...base, rayfinYml: 'services: [' })).toEqual({
      error: expect.stringContaining('isn’t valid YAML')
    })
  })

  it('draws a simple app with only its own data and no connections', async () => {
    const arch = await sample({
      rayfinYml: 'name: Notes\nservices:\n  auth: { enabled: true, fabric: { enabled: true } }\n  data: { enabled: true }\n',
      fabric: null,
      functionSources: []
    })
    expect(arch.services.map((s) => s.kind)).toEqual(['signin', 'database'])
    expect(arch.sources).toEqual([])
    expect(arch.routes).toEqual([])
  })

  it('reaches other web APIs with a key, unless an audience reaches them as the app', async () => {
    const arch = await sample({
      functionSources: [
        { path: 'rayfin/functions/src/function_app.ts', text: FUNCTIONS },
        {
          path: 'rayfin/functions/src/web.ts',
          text: `export const OPENAI_API_KEY = 'k3yValue9a8b7c6d5e4f'
udf.func('ask', async (ctx) => fetch('https://contoso.services.ai.azure.com/openai/v1/responses'), [])
udf.func('reddit', async (ctx) => fetch('https://oauth.reddit.com/r/all', { headers: { a: ctx.Secrets.REDDIT_SECRET } }), [])
udf.func('openai', async () => fetch('https://api.openai.com/v1/responses'), [])
`
        }
      ]
    })
    const byTitle = Object.fromEntries(arch.sources.map((s) => [s.title, s]))
    // AzureAI is a declared audience, so its host is reached as the app.
    expect(byTitle['Azure AI Foundry']).toMatchObject({ kind: 'audience', identity: 'app', hosts: ['contoso.services.ai.azure.com'] })
    expect(byTitle.Reddit).toMatchObject({ kind: 'api', identity: 'key', hosts: ['oauth.reddit.com'], functions: ['reddit'] })
    expect(byTitle.OpenAI).toMatchObject({ kind: 'api', identity: 'key', suggestedAudience: undefined })
    expect(arch.sources.map((s) => s.identity).slice(-2)).toEqual(['key', 'key'])
    const title = (id: string): string | undefined => arch.sources.find((s) => s.id === id)?.title
    // The function that calls Reddit reads a secret; the one that calls OpenAI doesn't.
    expect(arch.routes.filter((r) => r.identity === 'key').map((r) => [r.service, title(r.source)])).toEqual([
      ['svc:functions', 'Reddit'],
      ['svc:functions', 'OpenAI'],
      ['svc:secrets', 'Reddit']
    ])
    expect(arch.keys).toEqual({
      used: ['REDDIT_SECRET'],
      declared: [{ name: 'RECEIPT_OCR_KEY', description: 'Key for the receipt reader' }],
      hardcoded: [{ file: 'rayfin/functions/src/web.ts', name: 'OPENAI_API_KEY' }],
      secrets: [
        {
          name: 'RECEIPT_OCR_KEY',
          description: 'Key for the receipt reader',
          declared: true,
          functions: [],
          files: [],
          legacy: false
        },
        {
          name: 'REDDIT_SECRET',
          declared: false,
          functions: ['reddit'],
          files: ['rayfin/functions/src/web.ts'],
          legacy: false
        }
      ]
    })
    const fn = arch.services.find((s) => s.kind === 'functions')!
    expect(fn.tone).toBe('danger')
    expect(fn.issues.map((i) => i.text)).toEqual([hardcodedSummary(arch.keys.hardcoded)])
    const secrets = arch.services.find((s) => s.kind === 'secrets')!
    expect(secrets).toMatchObject({ summary: '2 secrets, stored with the app', tone: 'danger' })
    expect(secrets.issues.map((i) => i.text)).toEqual([
      '`REDDIT_SECRET` is read as `ctx.Secrets` but not declared in rayfin.yml, which is a TypeScript error. Declare it with `rayfin secret set`.'
    ])
  })

  it('shows secrets as a part of the app, and how they’re read', async () => {
    const arch = await sample({
      rayfinYml: RAYFIN_YML.replace(
        '  functions:\n    enabled: true\n    auth:\n      type: application',
        '  functions:\n    enabled: false'
      ),
      functionSources: [{ path: 'f.ts', text: `udf.func('a', async (ctx) => ctx.getSecret('OLD_TOKEN'), [])` }]
    })
    expect(arch.keys.secrets.map((s) => [s.name, s.declared, s.legacy])).toEqual([
      ['RECEIPT_OCR_KEY', true, false],
      ['OLD_TOKEN', false, true]
    ])
    const secrets = arch.services.find((s) => s.kind === 'secrets')!
    // A name read with ctx.getSecret doesn't need declaring, so nothing is broken.
    expect(secrets.tone).toBeUndefined()
    expect(secrets.issues.map((i) => i.text)).toEqual([
      '`OLD_TOKEN` is read with `ctx.getSecret()`, deprecated in Rayfin 1.36. Read `ctx.Secrets.<NAME>` instead.',
      'Only functions read secrets, and functions are off in rayfin.yml.'
    ])
  })

  it('suggests reaching a Microsoft service as the app when it’s called with a key', async () => {
    const arch = await sample({
      functionSources: [{ path: 'f.ts', text: `udf.func('ask', async () => fetch('https://contoso.openai.azure.com/x'), [])` }]
    })
    expect(arch.sources.find((s) => s.title === 'Azure OpenAI')).toMatchObject({
      identity: 'key',
      suggestedAudience: 'AzureAI'
    })
  })
})

describe('describeAppIdentity', () => {
  it('names a team app’s deploy service principal, and a different preview one', () => {
    expect(
      describeAppIdentity({
        team: {
          deployIdentity: { clientId: 'c1', displayName: 'Fabricator deploy - Sales' },
          previewIdentity: { clientId: 'c2', displayName: 'Fabricator previews - Sales' }
        },
        fabricUser: 'me@contoso.com'
      })
    ).toEqual({
      kind: 'service-principal',
      who: 'Fabricator deploy - Sales',
      clientId: 'c1',
      preview: { who: 'Fabricator previews - Sales', clientId: 'c2' }
    })
  })

  it('names the Fabric account a personal app deploys with, when known', () => {
    expect(describeAppIdentity({ fabricUser: 'avery@contoso.com' })).toEqual({ kind: 'account', who: 'avery@contoso.com' })
    expect(describeAppIdentity({})).toEqual({ kind: 'unknown' })
  })
})
