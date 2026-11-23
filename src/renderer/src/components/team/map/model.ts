import type {
  TeamDeployRecord,
  TeamMap,
  TeamMapApp,
  TeamMapCopy,
  TeamMapJob,
  TeamMapRun,
  TeamWorkspace
} from '@shared/ipc'
import { translator } from '../../../i18n'
import { dataIds, type ResourceView } from './resources'

/** How a deployment target is doing. */
export type Health = 'live' | 'deploying' | 'failed' | 'idle'

/** A run deploying something right now (and its job, once the plan is done). */
export interface Deploying {
  run: TeamMapRun
  job?: TeamMapJob
}

const same = (a?: string, b?: string): boolean => Boolean(a && b && a.toLowerCase() === b.toLowerCase())

export function isActive(run: TeamMapRun): boolean {
  return run.status !== 'completed'
}

/** The run deploying an app's published version right now. */
export function publishing(app: TeamMapApp, runs: TeamMapRun[]): Deploying | undefined {
  for (const run of runs) {
    if (!isActive(run) || run.kind !== 'production') continue
    const job = run.jobs.find((j) => same(j.folder, app.folder))
    if (job && job.conclusion !== 'skipped') return { run, job }
  }
  return undefined
}

/** The run deploying a working copy's preview right now. */
export function previewing(app: TeamMapApp, copy: TeamMapCopy, runs: TeamMapRun[]): Deploying | undefined {
  for (const run of runs) {
    if (!isActive(run) || run.kind !== 'preview' || run.branch !== copy.branch) continue
    const job = run.jobs.find((j) => same(j.folder, app.folder))
    if (job?.conclusion === 'skipped') continue
    // Planned, but not for this app.
    if (!job && run.jobs.some((j) => j.folder)) continue
    return { run, job }
  }
  return undefined
}

export function recordHealth(record?: TeamDeployRecord): Health {
  switch (record?.state) {
    case 'success':
    case 'inactive':
      return 'live'
    case 'failure':
    case 'error':
      return 'failed'
    case 'in_progress':
    case 'queued':
    case 'pending':
      return 'deploying'
    default:
      return 'idle'
  }
}

export function publishedHealth(app: TeamMapApp, runs: TeamMapRun[]): Health {
  return publishing(app, runs) ? 'deploying' : recordHealth(app.production)
}

export function copyHealth(app: TeamMapApp, copy: TeamMapCopy, runs: TeamMapRun[]): Health {
  return previewing(app, copy, runs) ? 'deploying' : recordHealth(copy.preview)
}

/** The most notable state among an app's targets (deploying beats failed beats live). */
export function appHealth(app: TeamMapApp, runs: TeamMapRun[]): Health {
  const all: Health[] = [
    ...(app.published ? [publishedHealth(app, runs)] : []),
    ...app.copies.map((c) => copyHealth(app, c, runs))
  ]
  for (const h of ['deploying', 'failed', 'live'] as const) if (all.includes(h)) return h
  return 'idle'
}

/** The copy's preview was deployed from an earlier save than its latest. */
export function previewBehind(copy: TeamMapCopy): boolean {
  const head = copy.pr?.headSha
  return Boolean(head && copy.preview?.sha && copy.preview.sha !== head)
}

/** The first pipeline template whose draft pull requests don't deploy a
 *  preview (the Rust `templates::READY_PREVIEWS_VERSION`). */
export const READY_PREVIEWS_TEMPLATE = 6

/**
 * Whether a working copy deploys a preview now. From template v6, a draft (or
 * a copy not on GitHub yet) runs only on its author's computer: its preview
 * deploys once they publish, which marks the pull request ready.
 */
export function deploysPreview(workspace: TeamWorkspace, copy: TeamMapCopy): boolean {
  if ((workspace.manifest?.templateVersion ?? 0) < READY_PREVIEWS_TEMPLATE) return true
  return Boolean(copy.pr && !copy.pr.draft)
}

export interface MapStats {
  apps: number
  published: number
  copies: number
  live: number
  deploying: number
  failed: number
}

export function mapStats(map: TeamMap, runs: TeamMapRun[]): MapStats {
  let live = 0
  let failed = 0
  let copies = 0
  const count = (h: Health): void => {
    if (h === 'live') live += 1
    if (h === 'failed') failed += 1
  }
  for (const app of map.apps) {
    if (app.published) count(publishedHealth(app, runs))
    for (const copy of app.copies) {
      copies += 1
      count(copyHealth(app, copy, runs))
    }
  }
  return {
    apps: map.apps.length,
    published: map.apps.filter((a) => a.published).length,
    copies,
    live,
    deploying: runs.filter((r) => isActive(r) && r.kind !== 'verify').length,
    failed
  }
}

/** The app folder of a working branch (`fabricator/<login>/<folder>-<stamp>`). */
export function branchFolder(branch?: string): string | undefined {
  return /^fabricator\/[^/]+\/(.+)-\d{8}-\d{6}$/.exec(branch ?? '')?.[1]
}

/** A short description of what a run is doing (or did), for people. */
export function runLabel(run: TeamMapRun, apps: TeamMapApp[]): string {
  const folders = run.jobs.map((j) => j.folder).filter((f): f is string => Boolean(f))
  const fromBranch = run.kind === 'preview' ? branchFolder(run.branch) : undefined
  if (!folders.length && fromBranch) folders.push(fromBranch)
  const names = folders.map((f) => apps.find((a) => same(a.folder, f))?.name ?? f)
  const what = names.length ? names.join(', ') : undefined
  const done = !isActive(run)
  const t = translator('teamMap')
  switch (run.kind) {
    case 'preview':
      return what ? t('runLabel.previewOf', { what }) : t('shared.preview')
    case 'production':
      if (what)
        return done ? t('runLabel.publishedWhat', { what }) : t('runLabel.publishingWhat', { what })
      if (done && run.title)
        return t('runLabel.publishedTitle', { title: run.title.replace(/\s*\(#\d+\)$/, '') })
      return done ? t('runLabel.published') : t('runLabel.publishing')
    case 'verify':
      return t('runLabel.verify')
    default:
      return run.title ?? t('runLabel.pipelineRun')
  }
}

/** Who's changing an app, in plain words. */
export function changingLabel(app: TeamMapApp): string {
  let you = false
  const others: string[] = []
  for (const copy of app.copies) {
    if (copy.mine) you = true
    else if (copy.author && !others.some((n) => same(n, copy.author))) others.push(copy.author)
  }
  const t = translator('teamMap')
  const count = (you ? 1 : 0) + others.length
  if (!count)
    return app.copies.length
      ? t('changing.inProgress', { count: app.copies.length })
      : t('changing.nobody')
  if (count === 1) return you ? t('changing.you') : t('changing.one', { name: others[0] })
  if (count === 2) {
    return you
      ? t('changing.youAndOther', { name: others[0] })
      : t('changing.two', { first: others[0], second: others[1] })
  }
  return t('changing.many', { count })
}

/** How the deployments in one of the workspace's Fabric workspaces are doing. */
export function fabricHealth(map: TeamMap, runs: TeamMapRun[], production: boolean): Record<Health, number> {
  const counts: Record<Health, number> = { live: 0, deploying: 0, failed: 0, idle: 0 }
  for (const app of map.apps) {
    if (production) {
      if (app.published) counts[publishedHealth(app, runs)] += 1
    } else {
      for (const copy of app.copies) counts[copyHealth(app, copy, runs)] += 1
    }
  }
  return counts
}

/* --------------------------------- layout --------------------------------- */

export type NodeKind =
  | 'app'
  /** An app's published version. */
  | 'published'
  /** Someone's working copy of an app, and its preview. */
  | 'copy'
  /** Something an app has: its database, file storage, functions or a connector. */
  | 'resource'
  /** Stands in for an app's data while it's read, or when it has none. */
  | 'resource-empty'
  /** A Fabric item or service apps connect to. */
  | 'source'

export interface MapNode {
  id: string
  kind: NodeKind
  x: number
  y: number
  w: number
  h: number
  folder?: string
  branch?: string
  /** Only in working copies so far. */
  draft?: boolean
}

export interface MapEdge {
  id: string
  from: string
  to: string
  /**
   * `version`: a published version or working copy, to its app. `tree`: an app
   * to what it has. `link`: what it has, to a source.
   */
  kind: 'version' | 'tree' | 'link'
  health: Health
  /** The published app (vs. a preview). */
  production?: boolean
  /** Only in working copies so far. */
  draft?: boolean
  d: string
  /** Where it leaves `from` (its right side) and meets `to` (its left side). */
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface MapLayout {
  nodes: MapNode[]
  edges: MapEdge[]
  /** Column headings, above the nodes. */
  lanes: MapLane[]
  width: number
  height: number
}

export interface MapLane {
  label: string
  x: number
  w: number
}

export const NODE_WIDTH: Record<NodeKind, number> = {
  published: 292,
  copy: 292,
  app: 240,
  resource: 272,
  'resource-empty': 272,
  source: 232
}

/** First-render guesses; real heights are measured and fed back in. */
const ESTIMATE: Record<NodeKind, number> = {
  published: 64,
  copy: 124,
  app: 96,
  resource: 64,
  'resource-empty': 44,
  source: 76
}

/** Each app in the middle: its published version and working copies on its left, what it has on its right. */
const COLUMN: Record<NodeKind, number> = {
  published: 0,
  copy: 0,
  app: 388,
  resource: 724,
  'resource-empty': 724,
  source: 1108
}

const ROW_GAP = 14
const APP_GAP = 48
const SOURCE_GAP = 18
/** Room above the nodes for the column headings. */
const LANE_SPACE = 44
/** Ends closer to level than this get a straight line. */
const SNAP = 4

export const nodeIds = {
  hub: 'hub',
  app: (folder: string): string => `app:${folder}`,
  published: (folder: string): string => `pub:${folder}`,
  copy: (folder: string, branch: string): string => `copy:${folder}:${branch}`,
  fabricProd: 'fabric:prod',
  fabricPreview: 'fabric:preview'
}

export interface Wire {
  d: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * A smooth line from the middle of `a`'s right side to the middle of `b`'s
 * left side. Ends within a few pixels of level get a straight line instead of
 * a kink; `keep` is the end other lines share, which stays put.
 */
export function wire(a: MapNode, b: MapNode, keep: 'from' | 'to' = 'from'): Wire {
  const x1 = a.x + a.w
  const x2 = b.x
  let y1 = Math.round(a.y + a.h / 2) + 0.5
  let y2 = Math.round(b.y + b.h / 2) + 0.5
  if (Math.abs(y2 - y1) < SNAP) {
    if (keep === 'from') y2 = y1
    else y1 = y2
    return { d: `M ${x1} ${y1} L ${x2} ${y2}`, x1, y1, x2, y2 }
  }
  const k = Math.max(24, Math.round((x2 - x1) / 2))
  return { d: `M ${x1} ${y1} C ${x1 + k} ${y1} ${x2 - k} ${y2} ${x2} ${y2}`, x1, y1, x2, y2 }
}

interface Row {
  id: string
  kind: NodeKind
  branch?: string
  draft?: boolean
}

/**
 * Lay the workspace out around its apps, one band per app, top to bottom: the
 * app in the middle, its published version and everyone's working copies on
 * its left, its data and connections on its right, and beyond them the Fabric
 * items and services those connect to. A source several apps use is drawn
 * once, level with what connects to it. `heights` are measured node heights.
 */
export function layoutMap(
  map: TeamMap,
  runs: TeamMapRun[],
  view: ResourceView | null,
  heights: Record<string, number> = {}
): MapLayout {
  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  const height = (id: string, kind: NodeKind): number => heights[id] ?? ESTIMATE[kind]
  const place = (id: string, kind: NodeKind, y: number, extra: Partial<MapNode> = {}): MapNode => {
    const node: MapNode = { id, kind, x: COLUMN[kind], y, w: NODE_WIDTH[kind], h: height(id, kind), ...extra }
    nodes.push(node)
    return node
  }
  const extent = (rows: Row[]): number =>
    rows.reduce((sum, r) => sum + height(r.id, r.kind), 0) + Math.max(0, rows.length - 1) * ROW_GAP
  /** Stack rows top to bottom, centred on `middle`. */
  const stack = (rows: Row[], middle: number, folder: string): void => {
    let y = middle - extent(rows) / 2
    for (const row of rows) {
      const extra: Partial<MapNode> = { folder }
      if (row.branch) extra.branch = row.branch
      if (row.draft) extra.draft = true
      y += place(row.id, row.kind, y, extra).h + ROW_GAP
    }
  }
  const link = (from: string, to: string, kind: MapEdge['kind'], health: Health, extra: Partial<MapEdge> = {}): void => {
    edges.push({ id: `${from}->${to}`, from, to, kind, health, d: '', x1: 0, y1: 0, x2: 0, y2: 0, ...extra })
  }

  let cursor = 0
  for (const app of map.apps) {
    const appId = nodeIds.app(app.folder)
    const versions: Row[] = [
      ...(app.published ? [{ id: nodeIds.published(app.folder), kind: 'published' as const }] : []),
      ...app.copies.map((c) => ({ id: nodeIds.copy(app.folder, c.branch), kind: 'copy' as const, branch: c.branch }))
    ]
    const items = view?.apps[app.folder]?.items ?? []
    const data: Row[] = items.length
      ? items.map((item) => ({ id: item.id, kind: 'resource' as const, draft: !item.published }))
      : [{ id: dataIds.empty(app.folder), kind: 'resource-empty' as const }]
    const band = Math.max(extent(versions), extent(data), height(appId, 'app'))
    const middle = cursor + band / 2
    stack(versions, middle, app.folder)
    place(appId, 'app', middle - height(appId, 'app') / 2, { folder: app.folder })
    stack(data, middle, app.folder)
    cursor += band + APP_GAP

    if (app.published) link(nodeIds.published(app.folder), appId, 'version', publishedHealth(app, runs), { production: true })
    for (const copy of app.copies) link(nodeIds.copy(app.folder, copy.branch), appId, 'version', copyHealth(app, copy, runs))
    if (!items.length) link(appId, dataIds.empty(app.folder), 'tree', 'idle')
    for (const item of items) {
      link(appId, item.id, 'tree', 'idle', item.published ? {} : { draft: true })
      for (const target of item.links) {
        link(item.id, target.id, 'link', 'idle', target.draft || !item.published ? { draft: true } : {})
      }
    }
  }
  if (!nodes.length) return { nodes, edges: [], lanes: [], width: 0, height: 0 }

  // Each source sits level with what connects to it, pushed down to not overlap.
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const wanted = (view?.sources ?? [])
    .map((source) => {
      const users = source.users.map((id) => byId.get(id)).filter((n): n is MapNode => Boolean(n))
      return { source, centre: users.length ? users.reduce((sum, n) => sum + n.y + n.h / 2, 0) / users.length : 0 }
    })
    .sort((a, b) => a.centre - b.centre)
  let floor = -Infinity
  for (const { source, centre } of wanted) {
    const h = height(source.id, 'source')
    const y = Math.max(centre - h / 2, floor)
    place(source.id, 'source', y, source.published ? {} : { draft: true })
    floor = y + h + SOURCE_GAP
  }

  // Below the column headings, on whole pixels; then connect. An app's lines
  // share its side, and a source's lines share its side: those ends stay put.
  const top = Math.min(...nodes.map((n) => n.y))
  for (const node of nodes) node.y = Math.round(node.y - top) + LANE_SPACE
  const placed = new Map(nodes.map((n) => [n.id, n]))
  for (const edge of edges) {
    const a = placed.get(edge.from)
    const b = placed.get(edge.to)
    if (a && b) Object.assign(edge, wire(a, b, edge.kind === 'tree' ? 'from' : 'to'))
  }

  const t = translator('teamMap')
  return {
    nodes,
    edges: edges.filter((e) => e.d),
    lanes: [
      { label: t('lanes.versions'), x: COLUMN.copy, w: NODE_WIDTH.copy },
      { label: t('shared.apps'), x: COLUMN.app, w: NODE_WIDTH.app },
      { label: t('lanes.data'), x: COLUMN.resource, w: NODE_WIDTH.resource },
      ...(wanted.length
        ? [{ label: t('lanes.sources'), x: COLUMN.source, w: NODE_WIDTH.source }]
        : [])
    ],
    width: Math.max(...nodes.map((n) => n.x + n.w)),
    height: Math.max(...nodes.map((n) => n.y + n.h))
  }
}

/**
 * The nodes related to `id`, to highlight together. An app: its published
 * version, working copies, what it has and what that connects to. A version:
 * itself and its app. Something an app has: its app and what it connects to.
 * A source: what connects to it and their apps. A Fabric workspace: what's
 * deployed there (published versions, or previews) and their apps. The
 * workspace relates to everything.
 */
export function lineage(layout: MapLayout, id: string): Set<string> {
  if (id === nodeIds.hub) return new Set(layout.nodes.map((n) => n.id))
  const out = new Set<string>([id])
  const byId = new Map(layout.nodes.map((n) => [n.id, n]))
  const withApp = (node?: MapNode): void => {
    if (!node) return
    out.add(node.id)
    if (node.folder) out.add(nodeIds.app(node.folder))
  }
  const sourcesOf = (from: string): void => {
    for (const e of layout.edges) if (e.kind === 'link' && e.from === from) out.add(e.to)
  }

  if (id === nodeIds.fabricProd || id === nodeIds.fabricPreview) {
    const kind = id === nodeIds.fabricProd ? 'published' : 'copy'
    for (const node of layout.nodes) if (node.kind === kind) withApp(node)
    return out
  }
  const node = byId.get(id)
  switch (node?.kind) {
    case 'app':
      for (const e of layout.edges) {
        if (e.kind === 'version' && e.to === id) out.add(e.from)
        if (e.kind === 'tree' && e.from === id) {
          out.add(e.to)
          sourcesOf(e.to)
        }
      }
      break
    case 'published':
    case 'copy':
      withApp(node)
      break
    case 'resource':
    case 'resource-empty':
      withApp(node)
      sourcesOf(id)
      break
    case 'source':
      for (const e of layout.edges) if (e.kind === 'link' && e.to === id) withApp(byId.get(e.from))
      break
  }
  return out
}
