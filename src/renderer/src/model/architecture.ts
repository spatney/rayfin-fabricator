/**
 * The Blueprint tab's architecture view-model: what a Rayfin app is made of
 * (the services of its Fabric app item), what it connects to, and which
 * identity each connection runs as. Read statically from `rayfin/rayfin.yml`,
 * `fabric.yaml`, the data model and the functions' source.
 *
 * Identities follow Rayfin 1.36 (https://rayfin.ai/docs/auth/delegated-access):
 *
 *  - the app's own data always runs as the signed-in person (entity rules decide);
 *  - a connector runs as its `auth.type` says: `delegated` (each person) or
 *    `application` (the app). Semantic model and KQL connectors are delegated only;
 *  - function connections (`ctx.Tokens.<Audience>`) always run as the app;
 *  - other web APIs a function calls sign in with a key or token the code sends
 *    (`ctx.Secrets`, or worse, a key written into the code);
 *  - `fabric.yaml` semantic models are queried in the browser as each person.
 *
 * The app identity is the owner of the Fabric app item.
 */
import { parse as parseYaml } from 'yaml'
import type { SemanticModelRef, TeamManifest } from '@shared/ipc'
import { formatList, translator } from '../i18n'
import type { FabricConfig } from './fabricConfig'
import { accessText, maskComments, type AccessLevel, type DataModel } from './parseSchema'
import { deriveRelationEdges } from './relationships'

/** Who a connection signs in as: each signed-in person, the app itself, or a key the code sends. */
export type Identity = 'user' | 'app' | 'key'

export type ServiceKind =
  | 'website'
  | 'signin'
  | 'database'
  | 'storage'
  | 'functions'
  | 'secrets'
  | 'connectors'

export type Tone = 'ok' | 'warn' | 'danger'

export interface Issue {
  tone: 'warn' | 'danger' | 'info'
  text: string
}

/* ------------------------------ rayfin.yml ------------------------------ */

export interface ConnectorConfig {
  name: string
  /** The connector type, e.g. `fabric-warehouse`. */
  type: string
  workspaceId?: string
  itemId?: string
  database?: string
  operations: string[]
  /** `auth.type` exactly as written (absent when missing). */
  auth?: string
  version?: string
}

export interface SecretDecl {
  name: string
  description?: string
}

export interface RayfinConfig {
  id?: string
  name?: string
  auth: {
    enabled: boolean
    fabric: boolean
    externalEntraExchange: boolean
    redirectUris: string[]
  }
  data: { enabled: boolean }
  hosting: {
    enabled: boolean
    /** `protected` | `public`, as written; absent in older projects. */
    assetAccess?: string
    embeddedOnly: boolean
    folder?: string
  }
  functions: { enabled: boolean; authType?: string; path: string }
  storage: { enabled: boolean }
  connectors: ConnectorConfig[]
  secrets: SecretDecl[]
}

type Obj = Record<string, unknown>

const asObj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined
const on = (v: unknown): boolean => v === true || v === 'true'

function parseConnectors(block: unknown): ConnectorConfig[] {
  // Current CLIs write a list of `- name:` entries; older ones a map keyed by name.
  const entries: [string, Obj][] = Array.isArray(block)
    ? block.flatMap((entry) => {
        const o = asObj(entry)
        const name = str(o?.name)
        return o && name ? [[name, o] as [string, Obj]] : []
      })
    : Object.entries(asObj(block) ?? {}).flatMap(([name, value]) => {
        const o = asObj(value)
        return o ? [[name, o] as [string, Obj]] : []
      })
  return entries.map(([name, o]) => {
    const config = asObj(o.config) ?? {}
    const operations = (Array.isArray(o.operations) ? o.operations : []).flatMap((op) => {
      const n = typeof op === 'string' ? str(op) : str(asObj(op)?.name)
      return n ? [n] : []
    })
    return {
      name,
      type: str(o.type) ?? str(o.connector) ?? 'connector',
      workspaceId: str(config.workspaceId),
      itemId: str(config.itemId),
      database: str(config.database) ?? str(config.databaseName),
      operations,
      auth: str(asObj(o.auth)?.type) ?? str(o.auth),
      version: str(o.version)
    }
  })
}

/** Parse `rayfin/rayfin.yml`; `null` when it isn't valid YAML or isn't a mapping. */
export function parseRayfinConfig(text: string): RayfinConfig | null {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch {
    return null
  }
  const root = asObj(doc)
  if (!root) return null
  const services = asObj(root.services) ?? {}
  const svc = (name: string): Obj => asObj(services[name]) ?? {}
  const auth = svc('auth')
  const fabric = asObj(auth.fabric) ?? {}
  const hosting = svc('staticHosting')
  const functions = svc('functions')
  const secrets = (Array.isArray(root.secrets) ? root.secrets : []).flatMap((s) => {
    const o = asObj(s)
    const name = str(o?.name)
    return name ? [{ name, description: str(o?.description) }] : []
  })
  return {
    id: str(root.id),
    name: str(root.name),
    auth: {
      enabled: on(auth.enabled),
      fabric: on(fabric.enabled),
      externalEntraExchange: on(fabric.externalEntraExchange),
      redirectUris: (Array.isArray(auth.allowedRedirectUris) ? auth.allowedRedirectUris : []).flatMap((u) => {
        const s = str(u)
        return s ? [s] : []
      })
    },
    data: { enabled: on(svc('data').enabled) },
    hosting: {
      enabled: on(hosting.enabled),
      assetAccess: str(hosting.assetAccess),
      embeddedOnly: on(asObj(hosting.embedded)?.only),
      folder: str(hosting.folder)
    },
    functions: {
      enabled: on(functions.enabled),
      authType: str(asObj(functions.auth)?.type) ?? str(functions.auth),
      path: (str(functions.path) ?? 'rayfin/functions').replace(/\\/g, '/').replace(/\/+$/, '')
    },
    storage: { enabled: on(svc('storage').enabled) },
    connectors: parseConnectors(root.connectors),
    secrets
  }
}

/* ------------------------------ functions ------------------------------ */

export interface FunctionInfo {
  name: string
  /** Audiences its handler declares (`AudienceType.X`), e.g. `AzureAI`. */
  audiences: string[]
  file: string
}

export interface FunctionsScan {
  functions: FunctionInfo[]
  /** Every audience the functions declare, in first-seen order. */
  audiences: string[]
  /** Outside web addresses the functions call, by host. */
  calls: HostCall[]
  /** Secrets read through `ctx.Secrets.<NAME>` (or the deprecated `ctx.getSecret`). */
  secretsUsed: string[]
  /** Where each secret is read. */
  secretReads: SecretRead[]
  /** String constants that look like keys written into the code. */
  hardcoded: { file: string; name: string }[]
}

export interface SecretRead {
  name: string
  /** Functions whose handler reads it (empty when a shared helper does). */
  functions: string[]
  files: string[]
  /** Read as `ctx.Secrets.NAME`, which needs it declared in rayfin.yml. */
  typed: boolean
  /** Read with `ctx.getSecret('NAME')`, deprecated in Rayfin 1.36. */
  legacy: boolean
}

export interface HostCall {
  host: string
  file: string
  /** Functions whose handler mentions the host (empty when it's a shared constant). */
  functions: string[]
}

const FUNC_RE = /\budf\s*\.\s*func\s*\(\s*(['"`])([^'"`\n]+)\1/g
const AUDIENCE_RE = /\bAudienceType\s*\.\s*([A-Za-z]+)\b/g
const HOST_RE = /\bhttps?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi
const SECRET_USE_RE = /\bctx\s*\.\s*Secrets\s*\.\s*([A-Za-z_$][\w$]*)/g
const LEGACY_SECRET_RE = /\bctx\s*\.\s*getSecret\s*\(\s*(['"`])([A-Za-z_$][\w$]*)\1/g
/** `NAME = 'value'`, `NAME: string = "value"` or `name: 'value'`. */
const STRING_ASSIGN_RE = /\b([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?[=:]\s*(['"`])([^'"`\s]{16,})\2/g
const KEY_NAME = /(key|secret|token|passw(or)?d|pwd)$/i
const NOT_A_KEY_NAME = /(url|uri|endpoint|host|name|header|id|path|type|kind)$/i
const PLACEHOLDER = /(example|dummy|fake|placeholder|sample|xxxx|your[_-]|<|\$\{)/i
/** Example, test and generated files describe calls; they don't make them. */
const NOT_RUNTIME = /(\.example\.|\.test\.|\.spec\.|__tests__\/|\.d\.ts$)/

/** Whether a string constant looks like a real key rather than a label or a URL. */
function looksLikeKey(name: string, value: string): boolean {
  if (!KEY_NAME.test(name) || NOT_A_KEY_NAME.test(name)) return false
  if (value.includes('://') || PLACEHOLDER.test(value)) return false
  return /\d/.test(value) && /[A-Za-z]/.test(value)
}

/** Find each `udf.func('name', …)`, the audiences declared in its handler, and what else the functions reach. */
export function scanFunctions(sources: { path: string; text: string }[]): FunctionsScan {
  const functions: FunctionInfo[] = []
  const audiences: string[] = []
  const calls = new Map<string, HostCall>()
  const secretsUsed: string[] = []
  const secretReads = new Map<string, SecretRead>()
  const hardcoded: { file: string; name: string }[] = []
  const note = (list: string[], v: string): void => {
    if (!list.includes(v)) list.push(v)
  }
  for (const { path, text } of sources) {
    const src = maskComments(text)
    const runtime = !NOT_RUNTIME.test(path)
    const starts = [...src.matchAll(FUNC_RE)]
    const owners = (at: number): string[] => {
      const i = starts.findIndex((s, k) => (s.index ?? 0) <= at && at < (starts[k + 1]?.index ?? src.length))
      return i >= 0 ? [starts[i][2]] : []
    }
    for (const m of src.matchAll(AUDIENCE_RE)) note(audiences, m[1])
    const reads = [
      ...[...src.matchAll(SECRET_USE_RE)].map((m) => ({ name: m[1], at: m.index ?? 0, legacy: false })),
      ...[...src.matchAll(LEGACY_SECRET_RE)].map((m) => ({ name: m[2], at: m.index ?? 0, legacy: true }))
    ]
    for (const r of reads) {
      note(secretsUsed, r.name)
      const read = secretReads.get(r.name) ?? { name: r.name, functions: [], files: [], typed: false, legacy: false }
      for (const f of owners(r.at)) note(read.functions, f)
      note(read.files, path)
      if (r.legacy) read.legacy = true
      else read.typed = true
      secretReads.set(r.name, read)
    }
    if (runtime) {
      for (const m of src.matchAll(STRING_ASSIGN_RE)) {
        if (looksLikeKey(m[1], m[3]) && !hardcoded.some((h) => h.file === path && h.name === m[1])) {
          hardcoded.push({ file: path, name: m[1] })
        }
      }
    }
    if (runtime) {
      for (const m of src.matchAll(HOST_RE)) {
        const host = m[1].toLowerCase()
        const call = calls.get(host) ?? { host, file: path, functions: [] }
        for (const f of owners(m.index ?? 0)) note(call.functions, f)
        calls.set(host, call)
      }
    }
    starts.forEach((m, i) => {
      const from = m.index ?? 0
      const to = starts[i + 1]?.index ?? src.length
      const own = [...new Set([...src.slice(from, to).matchAll(AUDIENCE_RE)].map((a) => a[1]))]
      functions.push({ name: m[2], audiences: own, file: path })
    })
  }
  return {
    functions,
    audiences,
    calls: [...calls.values()],
    secretsUsed,
    secretReads: [...secretReads.values()],
    hardcoded
  }
}

/* ------------------------------ outside web APIs ------------------------------ */

export interface WebService {
  /** Groups hosts into one source, e.g. `web:reddit.com`. */
  key: string
  label: string
  typeLabel: string
  icon: string
  vendor: 'fabric' | 'azure' | 'web'
  /** The function-connection audience that reaches it with the app's token. */
  audience?: string
}

/** What kind of service a known host is: keys into the `blueprint` catalog. */
const HOST_TYPE = {
  'Web API': 'model.hostTypes.webApi',
  Storage: 'model.hostTypes.storage',
  SQL: 'model.hostTypes.sql',
  'AI service': 'model.hostTypes.aiService',
  Database: 'model.hostTypes.database'
} as const

const KNOWN_HOSTS: {
  suffix: string
  service: Omit<WebService, 'key' | 'typeLabel'> & { typeLabel: keyof typeof HOST_TYPE }
}[] = [
  { suffix: 'api.fabric.microsoft.com', service: { label: 'Fabric REST APIs', typeLabel: 'Web API', icon: 'layers', vendor: 'fabric', audience: 'Fabric' } },
  { suffix: 'onelake.dfs.fabric.microsoft.com', service: { label: 'OneLake', typeLabel: 'Storage', icon: 'cloud', vendor: 'fabric', audience: 'Storage' } },
  { suffix: 'onelake.blob.fabric.microsoft.com', service: { label: 'OneLake', typeLabel: 'Storage', icon: 'cloud', vendor: 'fabric', audience: 'Storage' } },
  { suffix: 'datawarehouse.fabric.microsoft.com', service: { label: 'Fabric SQL', typeLabel: 'SQL', icon: 'server', vendor: 'fabric', audience: 'Sql' } },
  { suffix: 'database.fabric.microsoft.com', service: { label: 'Fabric SQL', typeLabel: 'SQL', icon: 'server', vendor: 'fabric', audience: 'Sql' } },
  { suffix: 'database.windows.net', service: { label: 'Azure SQL', typeLabel: 'SQL', icon: 'server', vendor: 'azure', audience: 'Sql' } },
  { suffix: 'blob.core.windows.net', service: { label: 'Azure Storage', typeLabel: 'Storage', icon: 'cloud', vendor: 'azure', audience: 'Storage' } },
  { suffix: 'dfs.core.windows.net', service: { label: 'Azure Storage', typeLabel: 'Storage', icon: 'cloud', vendor: 'azure', audience: 'Storage' } },
  { suffix: 'table.core.windows.net', service: { label: 'Azure Storage', typeLabel: 'Storage', icon: 'cloud', vendor: 'azure', audience: 'Storage' } },
  { suffix: 'queue.core.windows.net', service: { label: 'Azure Storage', typeLabel: 'Storage', icon: 'cloud', vendor: 'azure', audience: 'Storage' } },
  { suffix: 'services.ai.azure.com', service: { label: 'Azure AI Foundry', typeLabel: 'AI service', icon: 'sparkle', vendor: 'azure', audience: 'AzureAI' } },
  { suffix: 'openai.azure.com', service: { label: 'Azure OpenAI', typeLabel: 'AI service', icon: 'sparkle', vendor: 'azure', audience: 'AzureAI' } },
  { suffix: 'cognitiveservices.azure.com', service: { label: 'Azure AI services', typeLabel: 'AI service', icon: 'sparkle', vendor: 'azure', audience: 'AzureAI' } },
  { suffix: 'dev.azure.com', service: { label: 'Azure DevOps', typeLabel: 'Web API', icon: 'azure-devops', vendor: 'azure', audience: 'ADO' } },
  { suffix: 'visualstudio.com', service: { label: 'Azure DevOps', typeLabel: 'Web API', icon: 'azure-devops', vendor: 'azure', audience: 'ADO' } },
  { suffix: 'graph.microsoft.com', service: { label: 'Microsoft Graph', typeLabel: 'Web API', icon: 'organization', vendor: 'azure' } },
  { suffix: 'workiq.svc.cloud.microsoft', service: { label: 'Work IQ', typeLabel: 'Web API', icon: 'cloud', vendor: 'azure', audience: 'WorkIQ' } },
  { suffix: 'kusto.windows.net', service: { label: 'Azure Data Explorer', typeLabel: 'Web API', icon: 'pulse', vendor: 'azure', audience: 'Kusto' } },
  { suffix: 'kusto.fabric.microsoft.com', service: { label: 'Fabric KQL', typeLabel: 'Web API', icon: 'pulse', vendor: 'fabric', audience: 'Kusto' } },
  { suffix: 'vault.azure.net', service: { label: 'Key Vault', typeLabel: 'Web API', icon: 'key', vendor: 'azure', audience: 'KeyVault' } },
  { suffix: 'documents.azure.com', service: { label: 'Cosmos DB', typeLabel: 'Database', icon: 'database', vendor: 'azure', audience: 'CosmosDB' } },
  { suffix: 'eventgrid.azure.net', service: { label: 'Event Grid', typeLabel: 'Web API', icon: 'zap', vendor: 'azure', audience: 'EventGrid' } },
  { suffix: 'api.openai.com', service: { label: 'OpenAI', typeLabel: 'AI service', icon: 'sparkle', vendor: 'web' } },
  { suffix: 'api.anthropic.com', service: { label: 'Anthropic', typeLabel: 'AI service', icon: 'sparkle', vendor: 'web' } },
  { suffix: 'api.github.com', service: { label: 'GitHub', typeLabel: 'Web API', icon: 'github', vendor: 'web' } }
]

/** Hosting platforms whose first host label names the service, e.g. `mem0.….azurecontainerapps.io`. */
const HOSTED_ON: Record<string, string> = {
  'azurecontainerapps.io': 'Azure Container Apps',
  'azurewebsites.net': 'Azure App Service',
  'azure-api.net': 'Azure API Management',
  'herokuapp.com': 'Heroku',
  'vercel.app': 'Vercel',
  'netlify.app': 'Netlify',
  'workers.dev': 'Cloudflare Workers'
}

/** Links, docs, sign-in and the app's own pages: mentioned in code, but not data the app reaches. */
const IGNORED_HOST =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$|(^|\.)(example\.(com|org|net)|w3\.org|schema\.org|json-schema\.org|rayfin\.ai|learn\.microsoft\.com|docs\.microsoft\.com|aka\.ms|github\.com|npmjs\.com|login\.microsoftonline\.com|login\.windows\.net|sts\.windows\.net|fabricapps\.net|fabric\.microsoft\.com|powerbi\.com)$/

const endsWith = (host: string, suffix: string): boolean => host === suffix || host.endsWith(`.${suffix}`)

/** What a host is, in plain words; null for hosts that aren't a service the app reaches. */
export function classifyHost(host: string): WebService | null {
  const h = host.toLowerCase()
  const known = KNOWN_HOSTS.find((k) => endsWith(h, k.suffix))
  if (known) {
    const typeLabel = translator('blueprint')(HOST_TYPE[known.service.typeLabel])
    return { key: `web:${known.service.label.toLowerCase()}`, ...known.service, typeLabel }
  }
  if (IGNORED_HOST.test(h)) return null
  for (const [suffix, platform] of Object.entries(HOSTED_ON)) {
    if (endsWith(h, suffix)) {
      const name = h.slice(0, -(suffix.length + 1)).split('.')[0]
      return { key: `web:${h}`, label: name, typeLabel: platform, icon: 'globe', vendor: suffix.startsWith('azure') ? 'azure' : 'web' }
    }
  }
  const labels = h.split('.')
  const twoPart = labels.length > 2 && labels[labels.length - 1].length === 2 && /^(co|com|org|net|gov|ac)$/.test(labels[labels.length - 2])
  const domain = labels.slice(twoPart ? -3 : -2).join('.')
  return { key: `web:${domain}`, label: capitalize(domain.split('.')[0]), typeLabel: domain, icon: 'globe', vendor: 'web' }
}

/* ------------------------------ catalogs ------------------------------ */

export interface ConnectorKind {
  label: string
  icon: string
  /** A: Fabric SQL sources (delegated or application). B: delegated only. */
  category: 'A' | 'B'
  allowed: Identity[]
  /** What the source does when `operations` lists none (all allowed). */
  defaultOps: string[]
  /** "Runs DAX queries" and friends, for query-only sources: a key into the `blueprint` catalog. */
  queryLabel?: 'model.abilities.daxQueries' | 'model.abilities.kqlQueries'
}

const CONNECTOR_KINDS: Record<string, ConnectorKind> = {
  'fabric-warehouse': {
    label: 'Warehouse',
    icon: 'database',
    category: 'A',
    allowed: ['user', 'app'],
    defaultOps: ['read', 'create', 'update', 'delete']
  },
  'fabric-sqldatabase': {
    label: 'SQL database',
    icon: 'server',
    category: 'A',
    allowed: ['user', 'app'],
    defaultOps: ['read', 'create', 'update', 'delete']
  },
  'fabric-sqlanalytics': {
    label: 'Lakehouse SQL endpoint',
    icon: 'folder-library',
    category: 'A',
    allowed: ['user', 'app'],
    defaultOps: ['read']
  },
  'fabric-semanticmodel': {
    label: 'Semantic model',
    icon: 'graph',
    category: 'B',
    allowed: ['user'],
    defaultOps: ['executeQuery'],
    queryLabel: 'model.abilities.daxQueries'
  },
  kusto: {
    label: 'KQL database',
    icon: 'pulse',
    category: 'B',
    allowed: ['user'],
    defaultOps: ['executeQuery', 'executeCommand'],
    queryLabel: 'model.abilities.kqlQueries'
  }
}

/**
 * A connector type in plain words; unknown types keep their name. Its `label`
 * is English, for prompts: show {@link connectorTypeLabel}.
 */
export function connectorKind(type: string): ConnectorKind {
  return (
    CONNECTOR_KINDS[type] ?? {
      label: type.replace(/^fabric-/, ''),
      icon: 'plug',
      category: 'A',
      allowed: ['user', 'app'],
      defaultOps: []
    }
  )
}

/** A known connector type's name, and how it reads inside a list, in the language shown. */
function kindNames(type: string): { label: string; inList: string } | undefined {
  const t = translator('blueprint')
  switch (type) {
    case 'fabric-warehouse':
      return { label: t('model.kinds.warehouse'), inList: t('model.kindsInList.warehouse') }
    case 'fabric-sqldatabase':
      return { label: t('model.kinds.sqlDatabase'), inList: t('model.kindsInList.sqlDatabase') }
    case 'fabric-sqlanalytics':
      return { label: t('model.kinds.sqlEndpoint'), inList: t('model.kindsInList.sqlEndpoint') }
    case 'fabric-semanticmodel':
      return { label: t('model.kinds.semanticModel'), inList: t('model.kindsInList.semanticModel') }
    case 'kusto':
      return { label: t('model.kinds.kqlDatabase'), inList: t('model.kindsInList.kqlDatabase') }
    default:
      return undefined
  }
}

/** A connector type's name to show ("Warehouse"); unknown types keep their name. */
export function connectorTypeLabel(type: string): string {
  return kindNames(type)?.label ?? connectorKind(type).label
}

/** Connector types whose tables Rayfin discovers into `rayfin/connectors/<name>/metadata.json`. */
export const SQL_CONNECTOR_TYPES: ReadonlySet<string> = new Set([
  'fabric-sqldatabase',
  'fabric-warehouse',
  'fabric-sqlanalytics'
])

/** How the Fabric connections view names a SQL connector's tables. */
export const sqlSourceKey = (connectorName: string): string => `sql:${connectorName}`

export interface AudienceKind {
  /** English, for prompts and titles: a product name. */
  label: string
  icon: string
  vendor: 'fabric' | 'azure'
  /** What reaching it means, in a short line. */
  detail: string
  /** What the app identity needs there. */
  grant: string
  /** A public `AudienceType` member in Rayfin 1.36.2. */
  supported: boolean
}

/** What reaching an audience means, and what the app identity needs there: keys into the `blueprint` catalog. */
const AUDIENCE_TEXT = {
  sql: { detail: 'model.audiences.sql.detail', grant: 'model.audiences.sql.grant' },
  storage: { detail: 'model.audiences.storage.detail', grant: 'model.audiences.storage.grant' },
  fabric: { detail: 'model.audiences.fabric.detail', grant: 'model.audiences.fabric.grant' },
  azureAi: { detail: 'model.audiences.azureAi.detail', grant: 'model.audiences.azureAi.grant' },
  ado: { detail: 'model.audiences.ado.detail', grant: 'model.audiences.ado.grant' },
  other: { detail: 'model.audiences.other.detail', grant: 'model.audiences.other.grant' }
} as const

type AudienceEntry = Pick<AudienceKind, 'label' | 'icon' | 'vendor'> & { text: keyof typeof AUDIENCE_TEXT }

const AUDIENCES: Record<string, AudienceEntry> = {
  Sql: { label: 'Fabric SQL & Azure SQL', icon: 'server', vendor: 'fabric', text: 'sql' },
  Storage: { label: 'OneLake & Azure Storage', icon: 'cloud', vendor: 'azure', text: 'storage' },
  Fabric: { label: 'Fabric REST APIs', icon: 'layers', vendor: 'fabric', text: 'fabric' },
  AzureAI: { label: 'Azure AI Foundry', icon: 'sparkle', vendor: 'azure', text: 'azureAi' },
  ADO: { label: 'Azure DevOps', icon: 'azure-devops', vendor: 'azure', text: 'ado' }
}

const UNSUPPORTED_AUDIENCES: Record<string, string> = {
  CosmosDB: 'Cosmos DB',
  KeyVault: 'Key Vault',
  EventGrid: 'Event Grid',
  Kusto: 'Azure Data Explorer',
  WorkIQ: 'Work IQ'
}

/** A function audience in plain words. */
export function audienceKind(audience: string): AudienceKind {
  const t = translator('blueprint')
  const known: AudienceEntry | undefined = AUDIENCES[audience]
  const text = AUDIENCE_TEXT[known?.text ?? 'other'] ?? AUDIENCE_TEXT.other
  return {
    label: known?.label ?? UNSUPPORTED_AUDIENCES[audience] ?? audience,
    icon: known?.icon ?? 'cloud',
    vendor: known?.vendor ?? 'azure',
    detail: t(text.detail),
    grant: t(text.grant),
    supported: text !== AUDIENCE_TEXT.other
  }
}

/* ------------------------------ the view-model ------------------------------ */

export interface ServiceNode {
  /** Node id: `svc:<kind>`. */
  id: string
  kind: ServiceKind
  title: string
  icon: string
  /** One line: what it is. */
  summary: string
  /** A setting worth seeing at a glance (when the website's pages load), with an icon or a dot. */
  status?: { tone: Tone | 'off'; text: string; icon?: string }
  /** A second, quieter line. */
  meta?: string
  tone?: Tone
  issues: Issue[]
}

export interface SourceNode {
  /** Node id: `src:<key>`. */
  id: string
  kind: 'connector' | 'audience' | 'model' | 'api'
  title: string
  /** "Warehouse", "Semantic model", "Function connection"… */
  typeLabel: string
  icon: string
  vendor: 'fabric' | 'azure' | 'web'
  identity: Identity
  /** "Reads and writes", "Runs DAX queries"… */
  ability?: string
  workspaceId?: string
  itemId?: string
  /** rayfin.yml connectors on this source (usually one). */
  connectors: ConnectorConfig[]
  /** `fabric.yaml` aliases on this source. */
  modelAliases: string[]
  audience?: string
  /** A web API Rayfin could reach as the app instead of with a key (its audience). */
  suggestedAudience?: string
  /** Web addresses the functions call on it. */
  hosts: string[]
  /** Functions that reach it. */
  functions: string[]
  /** Where it's declared, for "Open" actions. */
  files: string[]
  /** `workspaceId:itemId` (lowercase) when the Fabric connections view can draw the semantic model. */
  semanticKey?: string
  /** {@link sqlSourceKey} when the Fabric connections view can draw its tables. */
  tablesKey?: string
  issues: Issue[]
}

/** One path through the diagram: an app service reaches a source as an identity. */
export interface Route {
  service: string
  identity: Identity
  source: string
}

export interface TableInfo {
  name: string
  /** The class name, which the Data model view focuses by. */
  entity: string
  access: AccessLevel
  tone: Tone
  /** Its access badge in English, as prompts quote it. */
  label: string
  /** Its access badge in the interface's language. */
  accessLabel: string
  file: string
}

export interface AppArchitecture {
  name: string
  config: RayfinConfig
  people: {
    /** How people sign in, in plain words. */
    signIn: string
    access: 'protected' | 'public' | 'unset'
    embeddedOnly: boolean
    tone: Tone
    issues: Issue[]
  }
  services: ServiceNode[]
  sources: SourceNode[]
  routes: Route[]
  database?: {
    tables: TableInfo[]
    relationships: number
    counts: Record<Tone, number>
  }
  functions?: FunctionsScan & { files: string[] }
  /** What the functions sign other APIs in with. */
  keys: {
    /** Secrets the functions read (`ctx.Secrets.<NAME>`). */
    used: string[]
    /** Secrets declared in rayfin.yml. */
    declared: SecretDecl[]
    /** Keys that look written into the code. */
    hardcoded: { file: string; name: string }[]
    /** Every secret, declared in rayfin.yml or read by the code, by name. */
    secrets: SecretEntry[]
  }
  /** Semantic models the Fabric connections view can draw (fabric.yaml + connectors). */
  semanticModels: SemanticModelRef[]
  /** SQL connectors whose tables the Fabric connections view draws, in rayfin.yml order. */
  sqlConnectors: ConnectorConfig[]
}

/** One function secret: what rayfin.yml says about it and where the code reads it. */
export interface SecretEntry {
  name: string
  description?: string
  /** Listed under `secrets:` in rayfin.yml. */
  declared: boolean
  /** Functions whose handler reads it. */
  functions: string[]
  /** Files that read it; empty when nothing does. */
  files: string[]
  /** Read with the deprecated `ctx.getSecret()`. */
  legacy: boolean
}

export interface ArchitectureInput {
  projectName: string
  rayfinYml: string | null
  fabric: FabricConfig | null
  dataModel: DataModel | null
  functionSources: { path: string; text: string }[]
}

const TONE_OF: Record<AccessLevel, Tone> = {
  scoped: 'ok',
  authenticated: 'warn',
  default: 'warn',
  mixed: 'warn',
  public: 'danger'
}

export const ids = {
  people: 'people',
  app: 'app',
  service: (kind: ServiceKind): string => `svc:${kind}`,
  identity: (identity: Identity): string => `id:${identity}`,
  /** Where one part's connections leave as one identity, e.g. functions as the app. */
  port: (service: string, identity: Identity): string => `port:${identity}|${service}`
}

/** The part and identity a port id names. */
export function parsePort(nodeId: string): { service: string; identity: Identity } | null {
  if (!nodeId.startsWith('port:')) return null
  const [identity, service] = nodeId.slice(5).split('|')
  return identity && service ? { service, identity: identity as Identity } : null
}

const keyOf = (workspaceId: string, itemId: string): string =>
  `${workspaceId.toLowerCase()}:${itemId.toLowerCase()}`

/** What a connector does, from its operations (all allowed when none are listed). */
export function connectorAbility(c: ConnectorConfig): string {
  const t = translator('blueprint')
  const kind = connectorKind(c.type)
  const ops = (c.operations.length ? c.operations : kind.defaultOps).map((o) => o.toLowerCase())
  if (ops.some((o) => o === 'create' || o === 'update' || o === 'delete')) return t('model.abilities.readsAndWrites')
  if (ops.includes('executecommand')) return t('model.abilities.kqlCommands')
  if (ops.includes('executequery')) return t(kind.queryLabel ?? 'model.abilities.queries')
  if (ops.includes('read')) return t('model.abilities.readOnly')
  return c.operations.join(', ') || t('model.abilities.connected')
}

/** Which identity a connector runs as, and what's wrong with its `auth` block. */
export function connectorIdentity(c: ConnectorConfig): { identity: Identity; issues: Issue[] } {
  const t = translator('blueprint')
  const kind = connectorKind(c.type)
  const issues: Issue[] = []
  const raw = c.auth
  if (!raw) {
    issues.push({ tone: 'danger', text: t('model.auth.missing') })
    return { identity: 'user', issues }
  }
  const lower = raw.toLowerCase()
  if (lower !== 'delegated' && lower !== 'application') {
    issues.push({ tone: 'danger', text: t('model.auth.invalid', { value: raw }) })
    return { identity: 'user', issues }
  }
  if (raw !== lower) {
    issues.push({ tone: 'danger', text: t('model.auth.lowercase', { lower, raw }) })
  }
  const identity: Identity = lower === 'application' ? 'app' : 'user'
  if (!kind.allowed.includes(identity)) {
    issues.push({
      tone: 'danger',
      text: t('model.auth.delegatedOnly', { kind: connectorTypeLabel(c.type) })
    })
  }
  return { identity, issues }
}

/**
 * Build the architecture from a project's files. Returns `{ error }` when
 * `rayfin.yml` can't be read; everything else degrades to "not used".
 */
export function buildArchitecture(input: ArchitectureInput): AppArchitecture | { error: string } {
  const t = translator('blueprint')
  if (input.rayfinYml == null) return { error: t('model.cantRead') }
  const config = parseRayfinConfig(input.rayfinYml)
  if (!config) return { error: t('model.invalidYaml') }

  const services: ServiceNode[] = []
  const sources = new Map<string, SourceNode>()
  const routes: Route[] = []
  const route = (service: ServiceKind, identity: Identity, source: string): void => {
    const r = { service: ids.service(service), identity, source }
    if (!routes.some((x) => x.service === r.service && x.identity === r.identity && x.source === r.source)) {
      routes.push(r)
    }
  }

  /* People */
  const assetAccess = config.hosting.assetAccess?.toLowerCase()
  const access: AppArchitecture['people']['access'] =
    assetAccess === 'public' ? 'public' : assetAccess === 'protected' ? 'protected' : 'unset'
  const peopleIssues: Issue[] = []
  if (!config.auth.enabled) {
    peopleIssues.push({ tone: 'danger', text: t('model.people.signInOff') })
  }
  if (access === 'public') {
    peopleIssues.push({ tone: 'info', text: t('model.people.publicPages') })
  }
  const people: AppArchitecture['people'] = {
    signIn: config.auth.enabled
      ? config.auth.fabric
        ? t('model.people.entraThroughFabric')
        : t('model.people.entra')
      : t('model.people.noSignIn'),
    access,
    embeddedOnly: config.hosting.embeddedOnly,
    tone: config.auth.enabled ? 'ok' : 'danger',
    issues: peopleIssues
  }

  /* Website */
  if (config.hosting.enabled) {
    const issues: Issue[] = []
    if (access === 'unset') {
      issues.push({ tone: 'info', text: t('model.website.assetAccessUnset') })
    }
    services.push({
      id: ids.service('website'),
      kind: 'website',
      title: t('model.website.title'),
      icon: 'browser',
      summary: t('model.website.summary'),
      // Public pages are common: only the page files load before sign-in, not the data.
      status:
        access === 'public'
          ? { tone: 'off', icon: 'globe', text: t('model.website.public') }
          : access === 'protected'
            ? { tone: 'off', icon: 'lock', text: t('model.website.protected') }
            : { tone: 'off', icon: 'info', text: t('model.website.unset') },
      meta: config.hosting.embeddedOnly ? t('model.website.embeddedOnly') : undefined,
      issues
    })
  }

  /* Sign-in */
  services.push({
    id: ids.service('signin'),
    kind: 'signin',
    title: t('model.signin.title'),
    icon: config.auth.enabled ? 'shield' : 'unlock',
    summary: config.auth.enabled ? people.signIn : t('status.off'),
    meta: config.auth.enabled
      ? config.auth.externalEntraExchange
        ? t('model.signin.externalEntra')
        : config.auth.redirectUris.length
          ? t('model.signin.addresses', { count: config.auth.redirectUris.length })
          : undefined
      : undefined,
    tone: config.auth.enabled ? undefined : 'danger',
    issues: config.auth.enabled ? [] : [{ tone: 'danger', text: t('model.signin.off') }]
  })

  /* Database */
  let database: AppArchitecture['database']
  const entities = input.dataModel?.entities ?? []
  if (config.data.enabled || entities.length > 0) {
    const tables: TableInfo[] = entities.map((e) => ({
      name: e.customName || e.name,
      entity: e.name,
      access: e.access.level,
      tone: TONE_OF[e.access.level],
      label: e.access.label,
      accessLabel: accessText(e).label,
      file: e.file
    }))
    const counts: Record<Tone, number> = { ok: 0, warn: 0, danger: 0 }
    for (const table of tables) counts[table.tone]++
    const derived = deriveRelationEdges(input.dataModel?.relations ?? [])
    const relationships = derived.pairs.length + derived.selfs.length
    database = { tables, relationships, counts }
    const parts = [
      counts.ok && t('model.database.scoped', { count: counts.ok }),
      counts.warn && t('model.database.signedIn', { count: counts.warn }),
      counts.danger && t('model.database.public', { count: counts.danger })
    ].filter(Boolean)
    const relationshipCount = relationships
      ? ` · ${t('model.database.relationships', { count: relationships })}`
      : ''
    services.push({
      id: ids.service('database'),
      kind: 'database',
      title: t('model.database.title'),
      icon: 'database',
      summary: tables.length
        ? `${t('model.database.tables', { count: tables.length })}${relationshipCount}`
        : t('model.database.noTables'),
      meta: parts.length ? parts.join(' · ') : undefined,
      tone: counts.danger ? 'danger' : counts.warn ? 'warn' : tables.length ? 'ok' : undefined,
      issues: counts.danger
        ? [{ tone: 'warn', text: t('model.database.readable', { count: counts.danger }) }]
        : []
    })
  }

  /* File storage */
  if (config.storage.enabled) {
    services.push({
      id: ids.service('storage'),
      kind: 'storage',
      title: t('model.storage.title'),
      icon: 'file-media',
      summary: t('model.storage.summary'),
      issues: config.data.enabled
        ? []
        : [{ tone: 'warn', text: t('model.storage.needsDatabase') }]
    })
  }

  /* Functions */
  const scan = scanFunctions(input.functionSources)
  let functions: AppArchitecture['functions']
  if (config.functions.enabled || scan.functions.length > 0) {
    functions = { ...scan, files: [...new Set(input.functionSources.map((s) => s.path))] }
    const issues: Issue[] = []
    if (config.functions.enabled && config.functions.authType?.toLowerCase() !== 'application') {
      issues.push({
        tone: 'danger',
        text: config.functions.authType
          ? t('model.functions.authType', { authType: config.functions.authType })
          : t('model.functions.noAuthType')
      })
    }
    if (!config.functions.enabled && scan.functions.length > 0) {
      issues.push({ tone: 'info', text: t('model.functions.turnedOff') })
    }
    for (const h of scan.hardcoded.length ? [hardcodedSummary(scan.hardcoded)] : []) {
      issues.push({ tone: 'danger', text: h })
    }
    for (const audience of scan.audiences) {
      const kind = audienceKind(audience)
      const id = `src:aud:${audience}`
      sources.set(id, {
        id,
        kind: 'audience',
        title: kind.label,
        typeLabel: t('model.functionConnection'),
        icon: kind.icon,
        vendor: kind.vendor,
        identity: 'app',
        connectors: [],
        modelAliases: [],
        audience,
        hosts: [],
        functions: scan.functions.filter((f) => f.audiences.includes(audience)).map((f) => f.name),
        files: functions.files,
        issues: kind.supported
          ? []
          : [{ tone: 'warn', text: t('model.functions.unsupportedAudience', { audience }) }]
      })
      route('functions', 'app', id)
    }
    // Other web APIs the functions call: reached with the app's token when an
    // audience covers them, otherwise with a key or token the code sends.
    for (const call of scan.calls) {
      const service = classifyHost(call.host)
      if (!service) continue
      const viaAudience = service.audience && scan.audiences.includes(service.audience)
      const target = viaAudience ? sources.get(`src:aud:${service.audience}`) : undefined
      if (target) {
        if (!target.hosts.includes(call.host)) target.hosts.push(call.host)
        continue
      }
      const id = `src:api:${service.key.slice(4)}`
      const existing = sources.get(id)
      if (existing) {
        if (!existing.hosts.includes(call.host)) existing.hosts.push(call.host)
        for (const f of call.functions) if (!existing.functions.includes(f)) existing.functions.push(f)
        if (!existing.files.includes(call.file)) existing.files.push(call.file)
        continue
      }
      sources.set(id, {
        id,
        kind: 'api',
        title: service.label,
        typeLabel: service.typeLabel,
        icon: service.icon,
        vendor: service.vendor,
        identity: 'key',
        connectors: [],
        modelAliases: [],
        hosts: [call.host],
        functions: [...call.functions],
        files: [call.file],
        suggestedAudience: service.audience,
        issues: []
      })
      route('functions', 'key', id)
    }
    const reach = [...sources.values()].filter((s) => s.kind === 'audience' || s.kind === 'api').map((s) => s.title)
    services.push({
      id: ids.service('functions'),
      kind: 'functions',
      title: t('model.functions.title'),
      icon: 'symbol-method',
      summary: scan.functions.length
        ? t('model.functions.count', { count: scan.functions.length })
        : t('model.functions.none'),
      meta: reach.length ? t('model.functions.reaches', { list: formatList(reach) }) : undefined,
      tone: issues.some((i) => i.tone === 'danger') ? 'danger' : undefined,
      issues
    })
  }

  /* Secrets */
  const secrets: SecretEntry[] = config.secrets.map((d) => {
    const read = scan.secretReads.find((r) => r.name === d.name)
    return {
      name: d.name,
      description: d.description,
      declared: true,
      functions: read?.functions ?? [],
      files: read?.files ?? [],
      legacy: read?.legacy ?? false
    }
  })
  for (const r of scan.secretReads) {
    if (!secrets.some((s) => s.name === r.name)) {
      secrets.push({ name: r.name, declared: false, functions: r.functions, files: r.files, legacy: r.legacy })
    }
  }
  if (secrets.length) {
    const issues: Issue[] = []
    const undeclared = scan.secretReads
      .filter((r) => r.typed && !config.secrets.some((d) => d.name === r.name))
      .map((r) => `\`${r.name}\``)
    if (undeclared.length) {
      issues.push({
        tone: 'danger',
        text: t('model.secrets.undeclared', { count: undeclared.length, names: formatList(undeclared) })
      })
    }
    const legacy = secrets.filter((s) => s.legacy).map((s) => `\`${s.name}\``)
    if (legacy.length) {
      issues.push({
        tone: 'info',
        text: t('model.secrets.legacy', { count: legacy.length, names: formatList(legacy) })
      })
    }
    if (!config.functions.enabled) {
      issues.push({ tone: 'info', text: t('model.secrets.functionsOff') })
    }
    services.push({
      id: ids.service('secrets'),
      kind: 'secrets',
      title: t('model.secrets.title'),
      icon: 'lock',
      summary: t('model.secrets.summary', { count: secrets.length }),
      meta: secrets.map((s) => s.name).join(', '),
      tone: undeclared.length ? 'danger' : undefined,
      issues
    })
    // A web API called from code that reads a secret is most likely sent it:
    // the same function, or the same file when a shared helper does either.
    const sendsSecret = (src: SourceNode): boolean =>
      secrets.some(
        (s) =>
          s.files.some((f) => src.files.includes(f)) &&
          (!s.functions.length || !src.functions.length || s.functions.some((f) => src.functions.includes(f)))
      )
    for (const src of sources.values()) {
      if (src.identity === 'key' && sendsSecret(src)) route('secrets', 'key', src.id)
    }
  }

  /* Connectors */
  const semanticModels: SemanticModelRef[] = []
  const addSemantic = (alias: string, workspaceId?: string, itemId?: string): string | undefined => {
    if (!workspaceId || !itemId) return undefined
    const key = keyOf(workspaceId, itemId)
    if (!semanticModels.some((m) => keyOf(m.workspaceId, m.itemId) === key)) {
      semanticModels.push({ alias, workspaceId, itemId })
    }
    return key
  }
  const sourceIdFor = (itemId: string | undefined, fallback: string): string =>
    itemId ? `src:item:${itemId.toLowerCase()}` : `src:${fallback}`

  // fabric.yaml semantic models first, so a model declared in both keeps its alias.
  for (const m of input.fabric?.models ?? []) {
    const id = sourceIdFor(m.itemId, `model:${m.alias.toLowerCase()}`)
    const semanticKey = addSemantic(m.alias, m.workspaceId, m.itemId)
    const existing = sources.get(id)
    if (existing) {
      existing.modelAliases.push(m.alias)
    } else {
      sources.set(id, {
        id,
        kind: 'model',
        title: humanize(m.alias),
        typeLabel: connectorTypeLabel('fabric-semanticmodel'),
        icon: 'graph',
        vendor: 'fabric',
        identity: 'user',
        ability: t('model.abilities.daxQueries'),
        workspaceId: m.workspaceId,
        itemId: m.itemId,
        connectors: [],
        modelAliases: [m.alias],
        hosts: [],
        functions: [],
        files: ['fabric.yaml'],
        semanticKey,
        issues: []
      })
    }
    route('website', 'user', id)
  }

  for (const c of config.connectors) {
    const kind = connectorKind(c.type)
    const { identity, issues } = connectorIdentity(c)
    const id = sourceIdFor(c.itemId, `connector:${c.name.toLowerCase()}`)
    const semanticKey = c.type === 'fabric-semanticmodel' ? addSemantic(c.name, c.workspaceId, c.itemId) : undefined
    const tablesKey = SQL_CONNECTOR_TYPES.has(c.type) ? sqlSourceKey(c.name) : undefined
    const existing = sources.get(id)
    if (existing) {
      existing.connectors.push(c)
      existing.kind = 'connector'
      existing.typeLabel = connectorTypeLabel(c.type)
      existing.ability = connectorAbility(c)
      existing.files = [...new Set([...existing.files, 'rayfin/rayfin.yml'])]
      existing.issues.push(...issues)
      if (identity === 'app') existing.identity = 'app'
      existing.semanticKey ??= semanticKey
      existing.tablesKey ??= tablesKey
    } else {
      sources.set(id, {
        id,
        kind: 'connector',
        title: humanize(c.name),
        typeLabel: connectorTypeLabel(c.type),
        icon: kind.icon,
        vendor: 'fabric',
        identity,
        ability: connectorAbility(c),
        workspaceId: c.workspaceId,
        itemId: c.itemId,
        connectors: [c],
        modelAliases: [],
        hosts: [],
        functions: [],
        files: ['rayfin/rayfin.yml'],
        semanticKey,
        tablesKey,
        issues: [...issues]
      })
    }
    route('connectors', identity, id)
  }
  if (config.connectors.length) {
    const kinds = [
      ...new Set(
        config.connectors.map((c) => kindNames(c.type)?.inList ?? connectorKind(c.type).label.toLowerCase())
      )
    ]
    const bad = config.connectors.some((c) => connectorIdentity(c).issues.some((i) => i.tone === 'danger'))
    services.push({
      id: ids.service('connectors'),
      kind: 'connectors',
      title: t('model.connectors.title'),
      icon: 'plug',
      summary: t('model.connectors.summary', { count: config.connectors.length }),
      meta:
        kinds.length <= 2
          ? capitalize(formatList(kinds))
          : t('model.connectors.kinds', { count: kinds.length }),
      tone: bad ? 'danger' : undefined,
      issues: []
    })
  }

  // Connectors usually reach Fabric workspaces and functions reach Azure and the
  // web, so this order keeps their lines from crossing; secrets sit by functions.
  const order: ServiceKind[] = ['website', 'signin', 'database', 'storage', 'connectors', 'functions', 'secrets']
  services.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))

  const identityOrder: Identity[] = ['user', 'app', 'key']
  const sorted = [...sources.values()].sort(
    (a, b) => identityOrder.indexOf(a.identity) - identityOrder.indexOf(b.identity) || a.title.localeCompare(b.title)
  )

  return {
    name: config.name ?? input.projectName,
    config,
    people,
    services,
    sources: sorted,
    routes,
    database,
    functions,
    keys: { used: scan.secretsUsed, declared: config.secrets, hardcoded: scan.hardcoded, secrets },
    semanticModels,
    sqlConnectors: config.connectors.filter((c) => SQL_CONNECTOR_TYPES.has(c.type))
  }
}

/** One sentence about keys written into the code, grouped by file. */
export function hardcodedSummary(keys: { file: string; name: string }[]): string {
  const t = translator('blueprint')
  const byFile = new Map<string, string[]>()
  for (const k of keys) byFile.set(k.file, [...(byFile.get(k.file) ?? []), k.name])
  const where = [...byFile]
    .map(([file, names]) =>
      t('model.hardcodedIn', { names: names.map((n) => `\`${n}\``).join(', '), file: file.split('/').pop() })
    )
    .join('; ')
  return t('model.hardcoded', { count: keys.length, where })
}

/** `coffee-shop-sales` → "Coffee shop sales". */
export function humanize(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return words ? capitalize(words) : name
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/* ------------------------------ the app identity ------------------------------ */

export interface AppIdentityInfo {
  /** A team app's deploy service principal, or the Fabric account that publishes it. */
  kind: 'service-principal' | 'account' | 'unknown'
  who?: string
  clientId?: string
  /** Team previews are owned by a different service principal. */
  preview?: { who: string; clientId: string }
}

/**
 * Whose credentials "the app" uses: the owner of the Fabric app item. A team
 * app is deployed (and so owned) by its workspace's service principal; a
 * personal app by the Fabric account it's published with.
 */
export function describeAppIdentity(opts: {
  team?: Pick<TeamManifest, 'deployIdentity' | 'previewIdentity'>
  fabricUser?: string
}): AppIdentityInfo {
  const deploy = opts.team?.deployIdentity
  if (deploy?.displayName) {
    const preview = opts.team?.previewIdentity
    return {
      kind: 'service-principal',
      who: deploy.displayName,
      clientId: deploy.clientId,
      preview:
        preview?.displayName && preview.clientId !== deploy.clientId
          ? { who: preview.displayName, clientId: preview.clientId }
          : undefined
    }
  }
  if (opts.fabricUser) return { kind: 'account', who: opts.fabricUser }
  return { kind: 'unknown' }
}

/** Every route through the diagram that touches `nodeId`, or null for "all". */
export function routesThrough(arch: AppArchitecture, nodeId: string | null): Route[] | null {
  if (!nodeId || nodeId === ids.people || nodeId === ids.app) return null
  const port = parsePort(nodeId)
  if (port) return arch.routes.filter((r) => r.service === port.service && r.identity === port.identity)
  if (nodeId.startsWith('id:')) return arch.routes.filter((r) => ids.identity(r.identity) === nodeId)
  if (nodeId.startsWith('svc:')) {
    const own = arch.routes.filter((r) => r.service === nodeId)
    if (nodeId !== ids.service('secrets')) return own
    // Secrets reach nothing themselves: they travel with the functions' calls.
    return [
      ...own,
      ...arch.routes.filter(
        (r) => r.service !== nodeId && own.some((o) => o.identity === r.identity && o.source === r.source)
      )
    ]
  }
  return arch.routes.filter((r) => r.source === nodeId)
}

/**
 * Where each part's connections leave the app: one port per identity it signs
 * in as, with how many sources it reaches that way. Secrets have none; they
 * travel with the functions' calls.
 */
export function portsOf(arch: AppArchitecture): Map<string, { identity: Identity; count: number }[]> {
  const order: Identity[] = ['user', 'app', 'key']
  const ports = new Map<string, { identity: Identity; count: number }[]>()
  for (const svc of arch.services) {
    if (svc.kind === 'secrets') continue
    const list = order.flatMap((identity) => {
      const count = new Set(
        arch.routes.filter((r) => r.service === svc.id && r.identity === identity).map((r) => r.source)
      ).size
      return count ? [{ identity, count }] : []
    })
    if (list.length) ports.set(svc.id, list)
  }
  return ports
}
