import type { ChatDataRef, FabricDataItemType, FabricWorkspace, WorkspaceDataItem } from '@shared/ipc'
import type { WorkspaceUse } from './fabric'
import { parseRayfinConfig } from './model/architecture'

/** A kind of Fabric data that a Rayfin connector reads. */
export type DataKind = 'semanticmodel' | 'warehouse' | 'sqldatabase' | 'lakehouse'

export interface DataKindInfo {
  kind: DataKind
  /** Fabric's item type. */
  itemType: FabricDataItemType
  /** The Rayfin connector type that reads it. */
  connector: string
  label: string
  plural: string
  /** The plural inside a sentence. */
  nouns: string
  /** Codicon name. */
  icon: string
  /** What the app can do with it. */
  hint: string
}

/** The data the Add menu offers, as `rayfin connector types` lists it in Rayfin 1.36
 *  (KQL databases can't be added in 1.36, so they aren't offered). */
export const DATA_KINDS: readonly DataKindInfo[] = [
  {
    kind: 'semanticmodel',
    itemType: 'SemanticModel',
    connector: 'fabric-semanticmodel',
    label: 'Semantic model',
    plural: 'Semantic models',
    nouns: 'semantic models',
    icon: 'graph',
    hint: 'Query Power BI data with DAX'
  },
  {
    kind: 'warehouse',
    itemType: 'Warehouse',
    connector: 'fabric-warehouse',
    label: 'Warehouse',
    plural: 'Warehouses',
    nouns: 'warehouses',
    icon: 'server',
    hint: 'Read and write its tables'
  },
  {
    kind: 'sqldatabase',
    itemType: 'SQLDatabase',
    connector: 'fabric-sqldatabase',
    label: 'SQL database',
    plural: 'SQL databases',
    nouns: 'SQL databases',
    icon: 'database',
    hint: 'Read and write its tables'
  },
  {
    kind: 'lakehouse',
    itemType: 'Lakehouse',
    connector: 'fabric-sqlanalytics',
    label: 'Lakehouse',
    plural: 'Lakehouses',
    nouns: 'lakehouses',
    icon: 'layers',
    hint: 'Read its tables'
  }
]

export function kindOfItem(itemType: string): DataKindInfo | undefined {
  return DATA_KINDS.find((k) => k.itemType === itemType)
}

/** One piece of data picked in the data picker. */
export interface DataSource {
  workspaceId: string
  workspaceName: string
  item: WorkspaceDataItem
}

/** A name as one line of prose. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The `rayfin connector add` command for a source (the CLI derives its name). */
export function connectorAddCommand(source: DataSource): string {
  const kind = kindOfItem(source.item.type)
  return `npx rayfin connector add --type ${kind?.connector ?? 'fabric-semanticmodel'} --workspace-id ${source.workspaceId} --item-id ${source.item.id}`
}

/** "Semantic model "Sales" from the "Finance" workspace". */
function describe(source: DataSource): string {
  const kind = kindOfItem(source.item.type)
  const readOnly = kind?.kind === 'lakehouse' ? ' (read-only)' : ''
  return `${kind?.label ?? 'Item'} "${oneLine(source.item.name)}" from the "${oneLine(source.workspaceName)}" workspace${readOnly}`
}

/** What Copilot is told about the Fabric data a message carries: connect each one, and how. */
export function connectDataContext(sources: readonly DataSource[]): string {
  if (sources.length === 0) return ''
  const kinds = new Set(sources.map((s) => kindOfItem(s.item.type)?.kind))
  const sql = ['warehouse', 'sqldatabase', 'lakehouse'].some((k) => kinds.has(k as DataKind))
  const lines = [
    `[Fabricator: the user added ${sources.length === 1 ? 'this Fabric data' : 'these Fabric data sources'} to the message. Connect ${sources.length === 1 ? 'it' : 'each one'} to the app as a Rayfin connector, then use ${sources.length === 1 ? 'it' : 'them'} for the request above.]`
  ]
  for (const source of sources) lines.push(`- ${describe(source)}:`, `  ${connectorAddCommand(source)}`)
  const steps = [`After ${sources.length === 1 ? 'the add' : 'each add'}, run the version-pinned npm install command it prints.`]
  if (sql) {
    steps.push(
      'For warehouse, SQL database and lakehouse connectors, generate the entity files from the connector’s metadata.json and replace its placeholder schema.ts (https://rayfin.ai/docs/connectors/entity-generation.md).'
    )
  }
  steps.push('Wire the connectors into the app (https://rayfin.ai/docs/connectors/client-setup.md).')
  if (kinds.has('semanticmodel')) {
    steps.push('In an app with a fabric.yaml, add semantic models with fabric-app-data instead (see the fabric-data skill).')
  }
  lines.push(steps.join(' '))
  return lines.join('\n')
}

/** What Copilot receives for a message sent with Fabric data: the message (or, with none,
 *  a request to connect the data), then how to connect it. */
export function dataTurnPrompt(text: string, sources: readonly DataSource[]): string {
  const ask = text.trim() || `Connect ${sources.length === 1 ? 'this data' : 'these data sources'} to the app, and tell me what I could build with ${sources.length === 1 ? 'it' : 'them'}.`
  return `${ask}\n\n${connectDataContext(sources)}`
}

/** How a sent message remembers a piece of data (its chip in the transcript). */
export function toDataRef(source: DataSource): ChatDataRef {
  return { name: source.item.name, type: source.item.type, workspace: source.workspaceName }
}

/* --------------------------- data waiting to send --------------------------- */

/** Data picked for each project's next message. Kept here so the chips survive the chat
 *  panel unmounting (switching tabs), like the draft. */
const pending = new Map<string, DataSource[]>()

export function pendingData(projectId: string): DataSource[] {
  return pending.get(projectId) ?? []
}

export function setPendingData(projectId: string, sources: readonly DataSource[]): void {
  if (sources.length > 0) pending.set(projectId, [...sources])
  else pending.delete(projectId)
}

/* --------------------------- recent workspaces --------------------------- */

const RECENT_KEY = 'fabricator.data.workspaces'
const RECENT_KEPT = 10

/** A workspace data was connected from, and when. */
export interface DataWorkspaceUse {
  id: string
  at: number
}

/** The workspaces data was last connected from, newest first. */
export function connectedFromWorkspaces(): DataWorkspaceUse[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (u): u is DataWorkspaceUse =>
        Boolean(u) && typeof u.id === 'string' && typeof u.at === 'number'
    )
  } catch {
    return []
  }
}

/** Remember that data was just connected from these workspaces. */
export function rememberConnectedFrom(workspaceIds: readonly string[], now = Date.now()): void {
  const ids = new Set(workspaceIds.map((id) => id.toLowerCase()))
  const kept = connectedFromWorkspaces().filter((u) => !ids.has(u.id.toLowerCase()))
  const next = [...[...ids].map((id) => ({ id, at: now })), ...kept].slice(0, RECENT_KEPT)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Storage full or unavailable: recents are a convenience.
  }
}

/**
 * The data picker's recent workspaces: the ones your apps deploy to and the ones
 * you connected data from, most recently used first, among the workspaces you
 * can open.
 */
export function recentDataWorkspaces(
  workspaces: readonly FabricWorkspace[],
  appUses: readonly WorkspaceUse[],
  connectedFrom: readonly DataWorkspaceUse[],
  limit = 5
): FabricWorkspace[] {
  const uses = [
    ...connectedFrom.map((u) => ({ key: u.id.toLowerCase(), at: u.at })),
    ...appUses.map((u) => ({ key: u.workspace.toLowerCase(), at: u.at }))
  ].sort((a, b) => b.at - a.at)
  const out: FabricWorkspace[] = []
  for (const { key } of uses) {
    if (out.length === limit) break
    const w = workspaces.find((x) => x.id.toLowerCase() === key || x.displayName.toLowerCase() === key)
    if (w && !out.includes(w)) out.push(w)
  }
  return out
}

/* --------------------------- existing connections --------------------------- */

async function readText(projectId: string, path: string): Promise<string | null> {
  try {
    const file = await window.api.projects.files.read(projectId, path)
    return file.error || file.binary || file.tooLarge ? null : (file.content ?? null)
  } catch {
    return null
  }
}

/**
 * The item ids (lowercase) of the Fabric data the project already connects to:
 * its Rayfin connectors in `rayfin/rayfin.yml`, and the semantic models in its
 * `fabric.yaml`.
 */
export async function connectedItemIds(projectId: string): Promise<Set<string>> {
  const yml =
    (await readText(projectId, 'rayfin/rayfin.yml')) ?? (await readText(projectId, 'rayfin/rayfin.yaml'))
  const fromRayfin = (yml ? (parseRayfinConfig(yml)?.connectors ?? []) : []).flatMap((c) =>
    c.itemId ? [c.itemId] : []
  )
  let fromFabricYaml: string[] = []
  try {
    fromFabricYaml = (await window.api.fabric.projectSemanticModels(projectId)).map((m) => m.itemId)
  } catch {
    // Unreadable: the Rayfin connectors still count.
  }
  return new Set([...fromRayfin, ...fromFabricYaml].map((id) => id.toLowerCase()))
}
