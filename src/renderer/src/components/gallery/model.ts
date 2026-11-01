import type { GalleryApp, GalleryStatus } from '@shared/ipc'
import type { WorkspaceUse } from '../../fabric'

/** Where the apps shown live: everywhere, on this computer, or only in Fabric. */
export type GalleryWhere = 'all' | 'local' | 'remote'
export type GallerySort = 'name' | 'recent' | 'workspace'

export interface GalleryQuery {
  text: string
  where: GalleryWhere
  /** One workspace's apps, or every workspace's (`null`). */
  workspaceId: string | null
  sort: GallerySort
  /** The pinned apps' keys (`pinKey`): they come first. */
  pinned: readonly string[]
  /** The workspaces your apps on this computer use, most recent first: grouped by workspace, they come first. */
  recent?: readonly string[]
}

/** An app with what Fabric said about its latest publish, once it has, and whether it's pinned. */
export interface GalleryEntry {
  app: GalleryApp
  status?: GalleryStatus
  pinned: boolean
}

export interface GalleryWorkspace {
  id: string
  name: string
  count: number
  /** When one of your apps on this computer last used it (ms), when it's one they use. */
  usedAt?: number
}

export interface GalleryGroup {
  /** The workspace's id, or `pinned` for the pinned apps' group. */
  id: string
  name: string
  pinned: boolean
  entries: GalleryEntry[]
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
const PINNED_GROUP = 'pinned'

/**
 * What a pin remembers an app by: its Fabric item id, which stays the same when
 * the app is renamed and is unique across workspaces. Fabric's ids are GUIDs in
 * either case, so the key is lowercase.
 */
export function pinKey(app: GalleryApp): string {
  return app.id.toLowerCase()
}

/** The lowercase words of a search. */
export function terms(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Words in a name: `sales-dashboard`, `Sales dashboard` and `salesDashboard` alike. */
function words(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(/[\s\-_.]+/)
    .filter(Boolean)
}

/**
 * How well an app matches a search: 0 when it doesn't (every term must appear in
 * its name, description, workspace, team or project), higher the more of it is
 * in the name. Empty searches match everything.
 */
export function score(app: GalleryApp, query: string[]): number {
  if (query.length === 0) return 1
  const name = app.name.toLowerCase()
  const haystack = [
    name,
    app.description,
    app.workspaceName,
    app.team?.name,
    app.local?.projectName
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  if (!query.every((term) => haystack.includes(term))) return 0
  const nameWords = words(app.name).map((w) => w.toLowerCase())
  if (name.startsWith(query.join(' ')) || name.startsWith(query.join('-'))) return 4
  if (query.every((term) => nameWords.some((w) => w.startsWith(term)))) return 3
  if (query.every((term) => name.includes(term))) return 2
  return 1
}

function publishedTime(entry: GalleryEntry): number {
  const t = entry.status?.publishedAt ? Date.parse(entry.status.publishedAt) : NaN
  return Number.isFinite(t) ? t : -Infinity
}

const byName = (a: GalleryEntry, b: GalleryEntry): number =>
  collator.compare(a.app.name, b.app.name) ||
  collator.compare(a.app.workspaceName, b.app.workspaceName)

const ORDER: Record<GallerySort, (a: GalleryEntry, b: GalleryEntry) => number> = {
  name: byName,
  // Apps Fabric hasn't said anything about yet come last, by name.
  recent: (a, b) => {
    const [ta, tb] = [publishedTime(a), publishedTime(b)]
    return ta === tb ? byName(a, b) : tb > ta ? 1 : -1
  },
  workspace: (a, b) => collator.compare(a.app.workspaceName, b.app.workspaceName) || byName(a, b)
}

/** Workspaces in the order of `recent` (ids), then A to Z. */
function workspaceOrder(recent: readonly string[] = []): (a: GalleryApp, b: GalleryApp) => number {
  const rank = new Map(recent.map((id, i) => [id, i]))
  return (a, b) => {
    const [ra, rb] = [
      rank.get(a.workspaceId) ?? recent.length,
      rank.get(b.workspaceId) ?? recent.length
    ]
    return ra - rb || collator.compare(a.workspaceName, b.workspaceName)
  }
}

/**
 * The apps a query shows: pinned apps first, then the rest. Within each, best
 * matches first when searching, then in the chosen order.
 */
export function applyQuery(
  apps: readonly GalleryApp[],
  statuses: Readonly<Record<string, GalleryStatus>>,
  query: GalleryQuery
): GalleryEntry[] {
  const search = terms(query.text)
  const pins = new Set(query.pinned)
  const scored: Array<{ entry: GalleryEntry; score: number }> = []
  for (const app of apps) {
    if (query.where === 'local' && !app.local) continue
    if (query.where === 'remote' && app.local) continue
    if (query.workspaceId && app.workspaceId !== query.workspaceId) continue
    const s = score(app, search)
    if (s > 0) {
      const entry = { app, status: statuses[app.id], pinned: pins.has(pinKey(app)) }
      scored.push({ entry, score: s })
    }
  }
  // Grouped by workspace, the groups keep their order; relevance ranks within each.
  const order = ORDER[query.sort]
  const byWorkspace = workspaceOrder(query.recent)
  const relevance = search.length > 0
  scored.sort((a, b) => {
    if (a.entry.pinned !== b.entry.pinned) return a.entry.pinned ? -1 : 1
    if (query.sort === 'workspace') {
      const ws = byWorkspace(a.entry.app, b.entry.app)
      if (ws) return ws
    }
    return (relevance ? b.score - a.score : 0) || order(a.entry, b.entry)
  })
  return scored.map((s) => s.entry)
}

/** The workspaces the apps live in, A to Z, with how many each has. */
export function workspacesOf(apps: readonly GalleryApp[]): GalleryWorkspace[] {
  const all = new Map<string, GalleryWorkspace>()
  for (const app of apps) {
    const ws = all.get(app.workspaceId)
    if (ws) ws.count++
    else all.set(app.workspaceId, { id: app.workspaceId, name: app.workspaceName, count: 1 })
  }
  return [...all.values()].sort((a, b) => collator.compare(a.name, b.name))
}

/**
 * The workspaces your apps on this computer use (`uses`: by id, or briefly by
 * name), most recently used first, and the other workspaces, A to Z.
 */
export function rankWorkspaces(
  workspaces: readonly GalleryWorkspace[],
  uses: readonly WorkspaceUse[]
): { recent: GalleryWorkspace[]; others: GalleryWorkspace[] } {
  const recent: GalleryWorkspace[] = []
  for (const use of [...uses].sort((a, b) => b.at - a.at)) {
    const key = use.workspace.trim().toLowerCase()
    const w = workspaces.find((x) => x.id.toLowerCase() === key || x.name.toLowerCase() === key)
    if (w && !recent.some((r) => r.id === w.id)) recent.push({ ...w, usedAt: use.at || undefined })
  }
  const ids = new Set(recent.map((w) => w.id))
  return { recent, others: workspaces.filter((w) => !ids.has(w.id)) }
}

/** A generated tail on a workspace's name: a GUID, or a timestamp and a hash. */
const GENERATED_TAIL =
  /^(.+?)([-_](?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{8}-\d{6,}-[0-9a-f]{6,}))$/i

/**
 * A workspace's name and its generated tail, shown quieter so the name reads
 * first: `replit-data-dashboard-2e377200-…` → `replit-data-dashboard`, `-2e377200-…`.
 */
export function splitWorkspaceName(name: string): [string, string] {
  const match = GENERATED_TAIL.exec(name)
  return match ? [match[1], match[2]] : [name, '']
}

/** A name a tool made: lowercase words joined by hyphens or underscores. */
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/
/** A number or hash a tool added to a slug: `-918529`, `-cd12809e` (not a year like `-2026`). */
const SLUG_NOISE = /[-_](?:\d{6,}|(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{4,})$/
/** Words that keep their own capitals in a title. */
const PROPER: Readonly<Record<string, string>> = {
  ai: 'AI',
  api: 'API',
  azure: 'Azure',
  bi: 'BI',
  copilot: 'Copilot',
  fabric: 'Fabric',
  github: 'GitHub',
  kql: 'KQL',
  microsoft: 'Microsoft',
  onelake: 'OneLake',
  rayfin: 'Rayfin',
  sql: 'SQL'
}

/**
 * How a workspace reads in a list. A name a tool made (`replit-data-dashboard-
 * 2e377200-…`) becomes a title (`Replit data dashboard`), with the name itself
 * as its detail; any other name stays as it is.
 */
export function workspaceTitle(name: string): { title: string; detail?: string } {
  if (!SLUG.test(name)) return { title: name }
  let base = splitWorkspaceName(name)[0]
  while (SLUG_NOISE.test(base)) base = base.replace(SLUG_NOISE, '')
  const title = base
    .split(/[-_]/)
    .map((word, i) => PROPER[word] ?? (i === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ')
  return { title, detail: name }
}

/**
 * Entries in workspace groups, keeping their order within each group. Pinned
 * apps are a group of their own, first, whatever their workspace.
 */
export function groupByWorkspace(entries: readonly GalleryEntry[]): GalleryGroup[] {
  const groups = new Map<string, GalleryGroup>()
  for (const entry of entries) {
    const { app, pinned } = entry
    const id = pinned ? PINNED_GROUP : app.workspaceId
    const name = pinned ? 'Pinned' : app.workspaceName
    const group = groups.get(id)
    if (group) group.entries.push(entry)
    else groups.set(id, { id, name, pinned, entries: [entry] })
  }
  return [...groups.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned))
}

/** One or two letters for an app's cover: `sales-dashboard` → `SD`, `notes` → `N`. */
export function initials(name: string): string {
  const letters = words(name.trim())
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
  return letters.join('').toUpperCase() || '?'
}

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60]
]
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** "3 days ago", "yesterday", "just now": when something happened, in words. */
export function ago(iso: string | undefined, now = Date.now()): string | undefined {
  const then = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(then)) return undefined
  const seconds = Math.round((then - now) / 1000)
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

/** "Oct 24, 2026, 3:34 AM": an exact time, for details. */
export function fullDate(iso: string | undefined): string | undefined {
  const then = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(then)) return undefined
  return new Date(then).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })
}

/** `https://flat-oak-1a2b-westus.webapp.fabricapps.net` → `flat-oak-1a2b-westus.webapp.fabricapps.net`. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** "26 apps", "1 app". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en')} ${n === 1 ? one : many}`
}
