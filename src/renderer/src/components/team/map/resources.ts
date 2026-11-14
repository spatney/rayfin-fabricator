/**
 * Each app's data and connections, for the workspace overview: its own
 * database, file storage, functions and connectors (read from rayfin.yml, the
 * data model and the functions' source), the Fabric items and services they
 * reach, and what working copies are changing about them.
 */
import { parse as parseYaml } from 'yaml'
import type { TeamMap, TeamMapApp, TeamMapCopy, TeamResourceRequest, TeamResourceSource } from '@shared/ipc'
import { formatList, translator } from '../../../i18n'
import {
  accessText,
  maskComments,
  parseDataModel,
  type AccessLevel
} from '../../../model/parseSchema'
import { layoutOf } from '../../../model/projectLayout'

type Obj = Record<string, unknown>

const asObj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const unique = (list: string[]): string[] => [...new Set(list)]

/* ------------------------------ one app's config ------------------------------ */

export interface TableInfo {
  name: string
  fields: number
  access: AccessLevel
  /** Who can read it, e.g. "Any signed-in user". */
  accessLabel: string
  /** Its fields and access, to tell when a working copy changes the table. */
  shape: string
}

export interface ConnectorInfo {
  name: string
  /** The connector type, e.g. `fabric-semanticmodel`. */
  type: string
  workspaceId?: string
  itemId?: string
  database?: string
  operations: string[]
  /** `delegated` (as the person using the app), or the configured sign-in. */
  auth?: string
}

/** What one copy of an app's code uses. */
export interface AppConfig {
  /** rayfin.yml was there to read. */
  found: boolean
  database: { tables: TableInfo[]; relations: number } | null
  files: boolean
  functions: { names: string[]; audiences: string[] } | null
  connectors: ConnectorInfo[]
}

function parseConnectors(block: unknown): ConnectorInfo[] {
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
  return entries
    .map(([name, o]) => {
      const config = asObj(o.config) ?? {}
      const operations = (Array.isArray(o.operations) ? o.operations : []).flatMap((op) => {
        const n = typeof op === 'string' ? str(op) : str(asObj(op)?.name)
        return n ? [n] : []
      })
      return {
        name,
        type: str(o.connector) ?? str(o.type) ?? 'connector',
        workspaceId: str(config.workspaceId),
        itemId: str(config.itemId),
        database: str(config.database) ?? str(config.databaseName),
        operations,
        auth: str(asObj(o.auth)?.type) ?? str(o.auth)
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Read one copy of an app's config files (project-relative path → text). */
export async function parseAppConfig(files: Record<string, string>): Promise<AppConfig> {
  const text = files['rayfin/rayfin.yml'] ?? files['rayfin/rayfin.yaml']
  let yml: Obj
  try {
    yml = asObj(parseYaml(text ?? '')) ?? {}
  } catch {
    yml = {}
  }
  const services = asObj(yml.services) ?? {}
  const enabled = (name: string): boolean => asObj(services[name])?.enabled === true
  const layout = layoutOf(yml)

  const model = await parseDataModel(async (path) => files[path] ?? null)
  const tables: TableInfo[] = model.entities.map((e) => ({
    name: e.customName ?? e.name,
    fields: e.fields.length,
    access: e.access.level,
    accessLabel: accessText(e).label,
    shape: `${e.fields.map((f) => `${f.name}:${f.type}${f.optional ? '?' : ''}`).join(',')}|${e.access.level}`
  }))

  const under = (prefix: string): string =>
    Object.entries(files)
      .filter(([path]) => path.startsWith(prefix))
      .map(([, source]) => maskComments(source))
      .join('\n')
  const fnSource = under(`${layout.functionsRoot}/src/`)
  const names = unique([...fnSource.matchAll(/\budf\s*\.\s*func\s*\(\s*(['"`])([^'"`\n]+)\1/g)].map((m) => m[2]))
  const audiences = unique([...fnSource.matchAll(/\bAudienceType\s*\.\s*([A-Za-z]+)\b/g)].map((m) => m[1]))

  return {
    found: text !== undefined,
    database: enabled('data') || tables.length > 0 ? { tables, relations: model.relations.length } : null,
    files: enabled('storage') || /@blob\s*\(/.test(under(`${layout.dataDir}/`)),
    functions: enabled('functions') || names.length > 0 ? { names, audiences } : null,
    connectors: parseConnectors(yml.connectors)
  }
}

/* ------------------------------ labels ------------------------------ */

export interface KindLabel {
  label: string
  icon: string
}

type ConnectorKindKey =
  | 'kinds.semanticModel'
  | 'kinds.warehouse'
  | 'kinds.sqlDatabase'
  | 'kinds.lakehouse'
  | 'kinds.eventhouse'

const CONNECTOR_KINDS: Record<string, { key: ConnectorKindKey; icon: string }> = {
  'fabric-semanticmodel': { key: 'kinds.semanticModel', icon: 'graph' },
  'fabric-warehouse': { key: 'kinds.warehouse', icon: 'table' },
  'fabric-sqldatabase': { key: 'kinds.sqlDatabase', icon: 'server' },
  'fabric-sqlanalytics': { key: 'kinds.lakehouse', icon: 'folder-library' },
  kusto: { key: 'kinds.eventhouse', icon: 'pulse' }
}

/** A connector type in plain words, with its icon. */
export function connectorKind(type: string): KindLabel {
  const kind = CONNECTOR_KINDS[type]
  return kind
    ? { label: translator('teamMap')(kind.key), icon: kind.icon }
    : { label: type.replace(/^fabric-/, ''), icon: 'plug' }
}

const SERVICES: Record<string, KindLabel> = {
  Sql: { label: 'Azure SQL', icon: 'server' },
  Storage: { label: 'Azure Storage', icon: 'cloud' },
  Fabric: { label: 'Microsoft Fabric', icon: 'layers' },
  AzureAI: { label: 'Azure AI', icon: 'sparkle' },
  ADO: { label: 'Azure DevOps', icon: 'azure-devops' },
  CosmosDB: { label: 'Cosmos DB', icon: 'database' },
  KeyVault: { label: 'Key Vault', icon: 'key' },
  EventGrid: { label: 'Event Grid', icon: 'zap' },
  Kusto: { label: 'Azure Data Explorer', icon: 'pulse' },
  WorkIQ: { label: 'Work IQ', icon: 'sparkle' }
}

/** A service functions reach (an `AudienceType`), in plain words. */
export function serviceKind(audience: string): KindLabel {
  return SERVICES[audience] ?? { label: audience, icon: 'cloud' }
}

/** What a connector can do, from its operations. */
export function connectorAbility(c: ConnectorInfo): string {
  const t = translator('teamMap')
  const ops = c.operations.map((o) => o.toLowerCase())
  if (ops.some((o) => o === 'create' || o === 'update' || o === 'delete'))
    return t('abilities.readWrite')
  if (ops.includes('executequery')) return t('abilities.query')
  if (ops.includes('read')) return t('abilities.read')
  return c.operations.join(', ')
}

/** Who a connector signs in as. */
export function connectorSignIn(c: ConnectorInfo): string | undefined {
  if (!c.auth) return undefined
  return c.auth === 'delegated' ? translator('teamMap')('signIn.delegated') : c.auth
}

/** `coffee-shop-sales` → "Coffee shop sales". */
export function humanize(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : name
}

/* ------------------------------ which copies to read ------------------------------ */

/**
 * A change to what the overview shows: rayfin.yml, the data model or the
 * functions' source, under `rayfin/` or in the Rayfin CLI Universal App's
 * `packages/data` and `packages/functions`.
 */
const CONFIG_PATH =
  /^[^/]+\/(rayfin\/(rayfin\.ya?ml$|data\/|functions\/src\/)|packages\/(data|functions)\/src\/)/i

/** Whether a working copy may change what its app uses (or its file list is cut short). */
export function touchesConfig(copy: TeamMapCopy): boolean {
  return (
    (copy.mine && copy.localEdits) ||
    copy.files.length < copy.changedFiles ||
    copy.files.some((f) => CONFIG_PATH.test(f.path))
  )
}

/** Where a working copy's code is read from: yours on this computer, else its branch. */
function copyKey(app: TeamMapApp, copy: TeamMapCopy): string {
  return copy.mine && app.projectId ? `${app.folder}|local` : `${app.folder}|${copy.branch}`
}

function requestKey(r: { folder: string; branch?: string; local?: boolean }): string {
  return r.local ? `${r.folder}|local` : `${r.folder}|${r.branch ?? ''}`
}

/**
 * The app copies to read: every published app, plus the working copies that
 * change its config (all of them for apps not published yet).
 */
export function resourceRequests(map: TeamMap): TeamResourceRequest[] {
  const out = new Map<string, TeamResourceRequest>()
  for (const app of map.apps) {
    if (app.published) out.set(requestKey({ folder: app.folder }), { folder: app.folder })
    for (const copy of app.copies) {
      if (app.published && !touchesConfig(copy)) continue
      if (copy.mine && app.projectId) out.set(`${app.folder}|local`, { folder: app.folder, local: true })
      else if (copy.pr) out.set(`${app.folder}|${copy.branch}`, { folder: app.folder, branch: copy.branch })
    }
  }
  return [...out.values()]
}

/** A copy's config, read and parsed. */
export interface ParsedSource {
  folder: string
  branch?: string
  local: boolean
  ok: boolean
  error?: string
  truncated: boolean
  config?: AppConfig
}

export async function parseSources(sources: TeamResourceSource[]): Promise<ParsedSource[]> {
  return Promise.all(
    sources.map(async (s) => ({
      folder: s.folder,
      branch: s.branch,
      local: s.local,
      ok: s.ok,
      error: s.error,
      truncated: s.truncated,
      config: s.ok ? await parseAppConfig(s.files) : undefined
    }))
  )
}

/* ------------------------------ the view ------------------------------ */

export type ResourceKind = 'database' | 'files' | 'functions' | 'connector'

export interface ResourceChange {
  author: string
  mine: boolean
  avatarUrl?: string
  kind: 'add' | 'remove' | 'change'
  /** What the copy does, e.g. "adds Receipt" ("Amy's copy adds Receipt"). */
  what: string
}

export interface ResourceLink {
  /** A source's node id. */
  id: string
  /** Only in working copies so far. */
  draft: boolean
}

export interface ResourceItem {
  /** Node id: `res:<folder>:<key>`. */
  id: string
  folder: string
  key: string
  kind: ResourceKind
  title: string
  detail: string
  icon: string
  /** Part of the published app (else only in working copies so far). */
  published: boolean
  changes: ResourceChange[]
  tables?: TableInfo[]
  relations?: number
  functions?: string[]
  audiences?: string[]
  connector?: ConnectorInfo
  links: ResourceLink[]
}

export interface SourceItem {
  /** Node id: `src:<key>`. */
  id: string
  kind: 'fabric' | 'service'
  title: string
  detail: string
  icon: string
  connectorType?: string
  audience?: string
  workspaceId?: string
  itemId?: string
  /** Ids of the resources that connect to it. */
  users: string[]
  /** A published app connects to it (else only working copies). */
  published: boolean
}

export interface AppResources {
  items: ResourceItem[]
  /** Its config couldn't be read. */
  error?: string
}

export interface ResourceView {
  apps: Record<string, AppResources>
  sources: SourceItem[]
}

export const dataIds = {
  item: (folder: string, key: string): string => `res:${folder}:${key}`,
  /** The "nothing here" placeholder for an app. */
  empty: (folder: string): string => `none:${folder}`,
  source: (key: string): string => `src:${key}`
}

const ORDER: Record<ResourceKind, number> = { database: 0, files: 1, functions: 2, connector: 3 }

function list(names: string[]): string {
  if (names.length <= 2) return formatList(names)
  return translator('teamMap')('list.more', {
    first: names[0],
    second: names[1],
    count: names.length - 2
  })
}

function connectorSource(c: ConnectorInfo): string {
  return dataIds.source(c.itemId ? `item:${c.itemId.toLowerCase()}` : `connector:${c.type}:${(c.database ?? c.name).toLowerCase()}`)
}

function serviceSource(audience: string): string {
  return dataIds.source(`service:${audience}`)
}

/** The resources one copy of an app's config describes. */
function itemsOf(folder: string, config: AppConfig): ResourceItem[] {
  const t = translator('teamMap')
  const make = (item: Omit<ResourceItem, 'id' | 'folder' | 'published' | 'changes'>): ResourceItem => ({
    ...item,
    id: dataIds.item(folder, item.key),
    folder,
    published: false,
    changes: []
  })
  const items: ResourceItem[] = []
  if (config.database) {
    const n = config.database.tables.length
    items.push(
      make({
        key: 'database',
        kind: 'database',
        title: t('items.database'),
        detail: n ? t('items.tables', { count: n }) : t('items.noTables'),
        icon: 'database',
        tables: config.database.tables,
        relations: config.database.relations,
        links: []
      })
    )
  }
  if (config.files) {
    items.push(
      make({
        key: 'files',
        kind: 'files',
        title: t('items.files'),
        detail: t('items.uploadedFiles'),
        icon: 'file-media',
        links: []
      })
    )
  }
  if (config.functions) {
    const { names, audiences } = config.functions
    items.push(
      make({
        key: 'functions',
        kind: 'functions',
        title: t('items.functions'),
        detail: names.length
          ? t('items.functionCount', { count: names.length })
          : t('items.noFunctions'),
        icon: 'symbol-method',
        functions: names,
        audiences,
        links: audiences.map((a) => ({ id: serviceSource(a), draft: false }))
      })
    )
  }
  for (const c of config.connectors) {
    const kind = connectorKind(c.type)
    items.push(
      make({
        key: `connector:${c.name}`,
        kind: 'connector',
        title: c.name,
        detail: kind.label,
        icon: kind.icon,
        connector: c,
        links: [{ id: connectorSource(c), draft: false }]
      })
    )
  }
  return items
}

function addedWhat(item: ResourceItem): string {
  const t = translator('teamMap')
  switch (item.kind) {
    case 'database':
      return item.tables?.length
        ? t('what.addsDatabaseWith', { names: list(item.tables.map((table) => table.name)) })
        : t('what.addsDatabase')
    case 'files':
      return t('what.addsFiles')
    case 'functions':
      return item.functions?.length
        ? t('what.adds', { names: list(item.functions) })
        : t('what.addsFunctions')
    case 'connector':
      return t('what.connectsTo', { name: item.title })
  }
}

function removedWhat(item: ResourceItem): string {
  const t = translator('teamMap')
  switch (item.kind) {
    case 'database':
      return t('what.removesDatabase')
    case 'files':
      return t('what.removesFiles')
    case 'functions':
      return t('what.removesFunctions')
    case 'connector':
      return t('what.disconnects', { name: item.title })
  }
}

/** How a copy's version of a resource differs from the published one, if at all. */
function changedWhat(before: ResourceItem, after: ResourceItem): string | null {
  const t = translator('teamMap')
  const parts: string[] = []
  const diff = (old: string[], now: string[]): [string[], string[]] => [
    now.filter((n) => !old.includes(n)),
    old.filter((n) => !now.includes(n))
  ]
  if (after.kind === 'database') {
    const old = new Map((before.tables ?? []).map((table) => [table.name, table]))
    const now = new Map((after.tables ?? []).map((table) => [table.name, table]))
    const [added, removed] = diff([...old.keys()], [...now.keys()])
    const changed = [...now.keys()].filter((n) => old.has(n) && old.get(n)?.shape !== now.get(n)?.shape)
    if (added.length) parts.push(t('what.adds', { names: list(added) }))
    if (changed.length) parts.push(t('what.changes', { names: list(changed) }))
    if (removed.length) parts.push(t('what.removes', { names: list(removed) }))
  } else if (after.kind === 'functions') {
    const [added, removed] = diff(before.functions ?? [], after.functions ?? [])
    const [reaches] = diff(before.audiences ?? [], after.audiences ?? [])
    if (added.length) parts.push(t('what.adds', { names: list(added) }))
    if (removed.length) parts.push(t('what.removes', { names: list(removed) }))
    if (reaches.length)
      parts.push(t('what.nowReaches', { names: list(reaches.map((a) => serviceKind(a).label)) }))
  } else if (after.kind === 'connector' && before.connector && after.connector) {
    const a = before.connector
    const b = after.connector
    if (a.type !== b.type || a.itemId !== b.itemId || a.workspaceId !== b.workspaceId || a.database !== b.database) {
      parts.push(t('what.pointsElsewhere'))
    } else if (a.operations.join() !== b.operations.join()) {
      parts.push(t('what.changesAbility'))
    } else if (a.auth !== b.auth) {
      parts.push(t('what.changesSignIn'))
    }
  }
  return parts.length ? parts.join(t('what.separator')) : null
}

function sourceFor(id: string, item: ResourceItem): SourceItem {
  if (item.kind === 'connector' && item.connector) {
    const c = item.connector
    const kind = connectorKind(c.type)
    return {
      id,
      kind: 'fabric',
      title: humanize(c.name),
      detail: kind.label,
      icon: kind.icon,
      connectorType: c.type,
      workspaceId: c.workspaceId,
      itemId: c.itemId,
      users: [],
      published: false
    }
  }
  const audience = id.slice(dataIds.source('service:').length)
  const kind = serviceKind(audience)
  return {
    id,
    kind: 'service',
    title: kind.label,
    detail: translator('teamMap')('items.reachedByFunctions'),
    icon: kind.icon,
    audience,
    users: [],
    published: false
  }
}

/**
 * Every app's resources: what the published app uses, plus what working copies
 * add, change or remove (for apps not published yet, what their copies use).
 */
export function buildResourceView(map: TeamMap, parsed: ParsedSource[]): ResourceView {
  const byKey = new Map(parsed.map((p) => [requestKey(p), p]))
  const apps: Record<string, AppResources> = {}
  for (const app of map.apps) {
    const items = new Map<string, ResourceItem>()
    let error: string | undefined
    if (app.published) {
      const base = byKey.get(requestKey({ folder: app.folder }))
      if (base?.config) {
        for (const item of itemsOf(app.folder, base.config)) items.set(item.key, { ...item, published: true })
      } else if (base) {
        error = base.error ?? translator('teamMap')('items.unreadable')
      }
    }
    for (const copy of app.copies) {
      const source = byKey.get(copyKey(app, copy))
      if (!source?.config) continue
      const who = { author: copy.author, mine: copy.mine, avatarUrl: copy.avatarUrl }
      const theirs = itemsOf(app.folder, source.config)
      for (const item of theirs) {
        const existing = items.get(item.key)
        if (!existing) {
          items.set(item.key, {
            ...item,
            changes: app.published ? [{ ...who, kind: 'add', what: addedWhat(item) }] : [],
            links: item.links.map((l) => ({ ...l, draft: true }))
          })
          continue
        }
        if (!existing.published) {
          if (app.published) existing.changes.push({ ...who, kind: 'add', what: addedWhat(item) })
          continue
        }
        const what = changedWhat(existing, item)
        if (what) existing.changes.push({ ...who, kind: 'change', what })
        for (const link of item.links) {
          if (!existing.links.some((l) => l.id === link.id)) existing.links.push({ ...link, draft: true })
        }
      }
      // A copy without a resource removes it (when the copy was read in full).
      if (app.published && source.config.found && !source.truncated) {
        for (const existing of items.values()) {
          if (existing.published && !theirs.some((t) => t.key === existing.key)) {
            existing.changes.push({ ...who, kind: 'remove', what: removedWhat(existing) })
          }
        }
      }
    }
    apps[app.folder] = {
      items: [...items.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.title.localeCompare(b.title)),
      error
    }
  }

  const sources = new Map<string, SourceItem>()
  for (const app of map.apps) {
    for (const item of apps[app.folder]?.items ?? []) {
      for (const link of item.links) {
        const source = sources.get(link.id) ?? sourceFor(link.id, item)
        sources.set(link.id, source)
        if (!source.users.includes(item.id)) source.users.push(item.id)
        if (item.published && !link.draft) source.published = true
      }
    }
  }
  return { apps, sources: [...sources.values()] }
}

/** "Your copy" or "amy's copy", for change sentences. */
export function copyName(change: Pick<ResourceChange, 'author' | 'mine'>): string {
  const t = translator('teamMap')
  if (change.mine) return t('copyName.yours')
  return change.author ? t('copyName.theirs', { author: change.author }) : t('copyName.teammate')
}
