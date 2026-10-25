import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type JSX,
} from 'react'
import type { StudioProject, TeamMap, TeamMapApp, TeamMapCopy, TeamMapRun, TeamWorkspace } from '@shared/ipc'
import { useSuppressPreview } from '../../../overlay'
import { Codicon } from '../../icons'
import { teamError } from '../common'
import { timeAgo, useNow } from '../runProgress'
import ActivityPanel from './ActivityPanel'
import { ResourceDetails } from './DataPanels'
import { EmptyNodeBody, ResourceNodeBody, SourceNodeBody, sourceApps } from './DataNodes'
import Inspector from './Inspector'
import WorkspacePanel from './WorkspacePanel'
import {
  changingLabel,
  copyHealth,
  isActive,
  layoutMap,
  lineage,
  mapStats,
  nodeIds,
  previewBehind,
  previewing,
  publishedHealth,
  publishing,
  type MapLayout,
  type MapNode
} from './model'
import { Avatar, DiffBar, HealthPill, RunLine, changeTitle, host, hueOf } from './parts'
import { buildResourceView, parseSources, resourceRequests, type ResourceView } from './resources'
import './teamMap.css'

interface Props {
  workspace: TeamWorkspace
  /** Bring this app into view when the overview opens. */
  focusFolder?: string
  /** Open with the workspace's members and settings showing. */
  manage?: boolean
  onClose: () => void
  /** A team app was opened from the overview. */
  onOpened: (project: StudioProject) => void
  onNewApp?: (workspaceId: string) => void
  /** Members, settings or apps changed, or the workspace was left: refresh. */
  onChanged?: () => void
  /** Test seam: start from this data instead of asking GitHub. */
  initialMap?: TeamMap
}

interface View {
  scale: number
  tx: number
  ty: number
}

const PAD = 56
const MIN_SCALE = 0.25
const MAX_SCALE = 1.8
/** Below this, fitting everything makes the nodes too small to read. */
const READABLE = 0.72
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** No app's data could be read: say so beside each app. */
function unreadable(map: TeamMap, error: string): ResourceView {
  return { apps: Object.fromEntries(map.apps.map((a) => [a.folder, { items: [], error }])), sources: [] }
}

/**
 * The workspace overview, as a map around its apps: each app's published
 * version and everyone's working copies on its left, its data and connections
 * on its right, and the Fabric items and services those connect to.
 */
export default function TeamMapView({
  workspace,
  focusFolder,
  manage,
  onClose,
  onOpened,
  onNewApp,
  onChanged,
  initialMap
}: Props): JSX.Element {
  useSuppressPreview()
  const [map, setMap] = useState<TeamMap | null>(initialMap ?? null)
  const [runs, setRuns] = useState<TeamMapRun[]>(initialMap?.runs ?? [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(initialMap?.error ?? null)
  const [dataView, setDataView] = useState<ResourceView | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [selection, setSelection] = useState<string | null>(manage ? nodeIds.hub : null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [view, setView] = useState<View>({ scale: 0.85, tx: 32, ty: 24 })
  const [panning, setPanning] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLDivElement>())
  const viewRef = useRef(view)
  viewRef.current = view
  const runsRef = useRef(runs)
  runsRef.current = runs
  const aliveRef = useRef(true)
  const fitPending = useRef(true)
  /** Someone zoomed or panned: don't fit the map to the window again by itself. */
  const moved = useRef(false)
  const gesture = useRef<{
    startX: number
    startY: number
    tx0: number
    ty0: number
    /** Started on a node: a click there selects it rather than clearing the selection. */
    onNode: boolean
    dragging: boolean
  } | null>(null)
  const now = useNow(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await window.api.team.map(workspace.id)
      if (!aliveRef.current) return
      setMap(next)
      setRuns(next.runs)
      setError(next.error ?? null)
    } catch (reason) {
      if (aliveRef.current) setError(teamError(reason, 'Could not load the workspace.'))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [workspace.id])

  useEffect(() => {
    if (!initialMap) void load()
  }, [initialMap, load])

  // Follow the pipeline: quickly while something deploys, slowly otherwise. A
  // run starting or finishing means copies or deployments changed: reload.
  const ready = map !== null
  useEffect(() => {
    if (!ready || initialMap) return
    let timer: number | undefined
    let stopped = false
    const schedule = (): void => {
      if (stopped) return
      timer = window.setTimeout(() => void tick(), runsRef.current.some(isActive) ? 4_000 : 15_000)
    }
    const tick = async (): Promise<void> => {
      if (!document.hidden) {
        try {
          const activity = await window.api.team.activity(workspace.id)
          if (stopped) return
          if (activity.ok) {
            const before = runsRef.current.filter(isActive).map((r) => r.id)
            const finished = before.some((id) => !activity.runs.some((r) => r.id === id && isActive(r)))
            const started = activity.runs.some((r) => isActive(r) && !before.includes(r.id))
            setRuns(activity.runs)
            if (finished || started) void load()
          }
        } catch {
          /* keep showing what we have */
        }
      }
      schedule()
    }
    schedule()
    const full = window.setInterval(() => {
      if (!document.hidden) void load()
    }, 60_000)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      window.clearInterval(full)
    }
  }, [ready, initialMap, workspace.id, load])

  // Each app's data and connections: its config (published, and the working
  // copies that change it), read again whenever the workspace is.
  const dataSeq = useRef(0)
  const dataViewRef = useRef(dataView)
  dataViewRef.current = dataView
  useEffect(() => {
    if (!map) return
    const seq = ++dataSeq.current
    const settle = (next: ResourceView): void => {
      // The first answer changes the layout's size: fit it to the window again.
      if (!dataViewRef.current && !moved.current) fitPending.current = true
      setDataView(next)
    }
    void (async () => {
      try {
        const requests = resourceRequests(map)
        const result = requests.length
          ? await window.api.team.resources(workspace.id, requests)
          : { ok: true, error: undefined, sources: [] }
        const parsed = await parseSources(result.sources)
        if (!aliveRef.current || seq !== dataSeq.current) return
        const problem = result.ok ? null : (result.error ?? 'Could not read the apps.')
        settle(problem && !parsed.length ? unreadable(map, problem) : buildResourceView(map, parsed))
        setDataError(problem)
      } catch (reason) {
        if (!aliveRef.current || seq !== dataSeq.current) return
        const problem = teamError(reason, 'Could not read the apps.')
        if (!dataViewRef.current) settle(unreadable(map, problem))
        setDataError(problem)
      }
    })()
  }, [map, workspace.id])

  const layout: MapLayout | null = useMemo(
    () => (map ? layoutMap(map, runs, dataView, heights) : null),
    [map, runs, dataView, heights]
  )
  const stats = useMemo(() => (map ? mapStats(map, runs) : null), [map, runs])
  const itemById = useMemo(
    () => new Map(Object.values(dataView?.apps ?? {}).flatMap((a) => a.items).map((i) => [i.id, i])),
    [dataView]
  )
  const sourceById = useMemo(() => new Map((dataView?.sources ?? []).map((s) => [s.id, s])), [dataView])

  const focusSet = useMemo(() => {
    const id = hovered ?? selection
    return layout && id && id !== nodeIds.hub ? lineage(layout, id) : null
  }, [layout, hovered, selection])

  /**
   * Fit the map (or just `ids`) to the window. `readable`: when everything
   * fits only too small to read, fill the window's width and start at the top.
   */
  const fitTo = useCallback(
    (ids?: Set<string>, readable = false): void => {
      const vp = viewportRef.current
      if (!vp || !layout) return
      const nodes = layout.nodes.filter((n) => !ids || ids.has(n.id))
      if (!nodes.length || vp.clientWidth === 0) return
      const minX = Math.min(...nodes.map((n) => n.x)) + PAD
      const minY = (ids ? Math.min(...nodes.map((n) => n.y)) : 0) + PAD
      const maxX = Math.max(...nodes.map((n) => n.x + n.w)) + PAD
      const maxY = Math.max(...nodes.map((n) => n.y + n.h)) + PAD
      const margin = 40
      const across = (vp.clientWidth - margin * 2) / (maxX - minX)
      const down = (vp.clientHeight - margin * 2) / (maxY - minY)
      const fit = Math.min(across, down, 1)
      const fromTop = readable && fit < READABLE && down < across
      const scale = clamp(fromTop ? Math.min(across, 1) : fit, MIN_SCALE, MAX_SCALE)
      setView({
        scale,
        tx: vp.clientWidth / 2 - ((minX + maxX) / 2) * scale,
        ty: fromTop ? margin - minY * scale : vp.clientHeight / 2 - ((minY + maxY) / 2) * scale
      })
    },
    [layout]
  )

  // Measure the rendered nodes; lay out again when they're taller or shorter
  // than assumed, then (once) fit the map to the window.
  useLayoutEffect(() => {
    if (!layout) return
    const measured: Record<string, number> = {}
    let changed = false
    nodeRefs.current.forEach((el, id) => {
      measured[id] = el.offsetHeight
      if (Math.abs((heights[id] ?? -1) - el.offsetHeight) > 1) changed = true
    })
    if (changed) {
      setHeights(measured)
      return
    }
    if (fitPending.current) {
      fitPending.current = false
      const app = focusFolder ? map?.apps.find((a) => a.folder.toLowerCase() === focusFolder.toLowerCase()) : undefined
      fitTo(app ? lineage(layout, nodeIds.app(app.folder)) : undefined, true)
    }
  }, [layout, heights, fitTo, focusFolder, map])

  // Cursor-anchored zoom on the wheel (non-passive so the page doesn't scroll).
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      moved.current = true
      const rect = vp.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const v = viewRef.current
      const scale = clamp(v.scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE)
      const k = scale / v.scale
      setView({ scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k })
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [ready])

  const zoomBy = useCallback((k: number): void => {
    const vp = viewportRef.current
    if (!vp) return
    moved.current = true
    const cx = vp.clientWidth / 2
    const cy = vp.clientHeight / 2
    const v = viewRef.current
    const scale = clamp(v.scale * k, MIN_SCALE, MAX_SCALE)
    const kk = scale / v.scale
    setView({ scale, tx: cx - (cx - v.tx) * kk, ty: cy - (cy - v.ty) * kk })
  }, [])

  // Esc closes the details first, then the overview. Capture runs this before a
  // dialog's own Esc handler can remove it, so a dialog on top keeps its Esc.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('.modal-backdrop')) return
      if (selection) setSelection(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selection, onClose])

  // Dragging anywhere pans; the pointer is captured only once it's a drag, so
  // a click still reaches the node (or button) under it.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const v = viewRef.current
    const onNode = Boolean((e.target as HTMLElement).closest('.tmap-node'))
    gesture.current = { startX: e.clientX, startY: e.clientY, tx0: v.tx, ty0: v.ty, onNode, dragging: false }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    if (!g) return
    if (!g.dragging) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 4) return
      g.dragging = true
      viewportRef.current?.setPointerCapture?.(e.pointerId)
      setPanning(true)
    }
    moved.current = true
    setView((v) => ({ ...v, tx: g.tx0 + (e.clientX - g.startX), ty: g.ty0 + (e.clientY - g.startY) }))
  }
  const endPan = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    gesture.current = null
    if (g?.dragging) {
      setPanning(false)
      try {
        viewportRef.current?.releasePointerCapture?.(e.pointerId)
      } catch {
        /* already released */
      }
      return
    }
    // A click on empty space clears the selection.
    if (g && !g.onNode) setSelection(null)
  }

  const openApp = useCallback(
    async (folder: string): Promise<void> => {
      setOpening(folder)
      setError(null)
      try {
        const result = await window.api.team.openProject(workspace.id, folder)
        if (!aliveRef.current) return
        if (result.ok && result.project) onOpened(result.project)
        else setError(result.error ?? 'Could not open the app.')
      } catch (reason) {
        if (aliveRef.current) setError(teamError(reason, 'Could not open the app.'))
      } finally {
        if (aliveRef.current) setOpening(null)
      }
    },
    [workspace.id, onOpened]
  )

  /** Select a node and bring it into view. */
  const reveal = useCallback(
    (id: string): void => {
      setSelection(id)
      const node = layout?.nodes.find((n) => n.id === id)
      const vp = viewportRef.current
      if (!node || !vp) return
      const v = viewRef.current
      const cx = (node.x + PAD + node.w / 2) * v.scale + v.tx
      const cy = (node.y + PAD + node.h / 2) * v.scale + v.ty
      if (cx < 80 || cx > vp.clientWidth - 80 || cy < 80 || cy > vp.clientHeight - 80) {
        setView({
          ...v,
          tx: vp.clientWidth / 2 - (node.x + PAD + node.w / 2) * v.scale,
          ty: vp.clientHeight / 2 - (node.y + PAD + node.h / 2) * v.scale
        })
      }
    },
    [layout]
  )

  const setNodeRef = useCallback(
    (id: string) =>
      (el: HTMLDivElement | null): void => {
        if (el) nodeRefs.current.set(id, el)
        else nodeRefs.current.delete(id)
      },
    []
  )

  const ws = map?.workspace ?? workspace
  const appOf = (folder?: string): TeamMapApp | undefined => map?.apps.find((a) => a.folder === folder)
  const copyOf = (node: MapNode): TeamMapCopy | undefined =>
    appOf(node.folder)?.copies.find((c) => c.branch === node.branch)
  const toggleManage = (): void => setSelection(selection === nodeIds.hub ? null : nodeIds.hub)

  /** The node a pipeline run belongs to. */
  const runTarget = (run: TeamMapRun): string | undefined => {
    if (!map) return undefined
    if (run.kind === 'preview') {
      for (const app of map.apps) {
        const copy = app.copies.find((c) => c.branch === run.branch)
        if (copy) return nodeIds.copy(app.folder, copy.branch)
      }
    }
    const folder = run.jobs.find((j) => j.folder)?.folder
    const app = map.apps.find((a) => a.folder.toLowerCase() === folder?.toLowerCase())
    if (!app) return undefined
    return run.kind === 'production' && app.published ? nodeIds.published(app.folder) : nodeIds.app(app.folder)
  }

  const renderNode = (node: MapNode): JSX.Element | null => {
    if (!map) return null
    switch (node.kind) {
      case 'app': {
        const app = appOf(node.folder)
        if (!app) return null
        const health = app.published ? publishedHealth(app, runs) : 'idle'
        return (
          <>
            <div className="tmap-node-head">
              <span className="tmap-mark" style={{ '--hue': hueOf(app.folder) } as CSSProperties}>
                {(app.name.trim()[0] ?? '?').toUpperCase()}
              </span>
              <div className="tmap-titles">
                <strong>{app.name}</strong>
                <span className="tmap-dim tmap-ellipsis">{changingLabel(app)}</span>
              </div>
            </div>
            <div className="tmap-node-foot">
              {app.published ? (
                <HealthPill health={health} label={health === 'live' ? 'Published' : undefined} />
              ) : (
                <span className="tmap-health tmap-health--idle">
                  <span className="tmap-health-dot" aria-hidden="true" />
                  Not published yet
                </span>
              )}
              <button
                type="button"
                className="tmap-open"
                disabled={opening !== null}
                onClick={() => void openApp(app.folder)}
              >
                {opening === app.folder ? 'Opening…' : 'Open'}
              </button>
            </div>
          </>
        )
      }
      case 'published': {
        const app = appOf(node.folder)
        if (!app) return null
        const deploying = publishing(app, runs)
        const record = app.production
        return (
          <>
            <div className="tmap-node-head">
              <span className="tmap-icon-tile">
                <Codicon name="globe" />
              </span>
              <div className="tmap-titles">
                <strong>Published</strong>
                <span className="tmap-dim tmap-ellipsis">
                  {record?.url ? host(record.url) : 'Not deployed yet'}
                  {record?.updatedAt ? ` · ${timeAgo(record.updatedAt, now)}` : ''}
                </span>
              </div>
              <HealthPill health={publishedHealth(app, runs)} />
            </div>
            {deploying && <RunLine deploying={deploying} now={now} />}
          </>
        )
      }
      case 'copy': {
        const app = appOf(node.folder)
        const copy = copyOf(node)
        if (!app || !copy) return null
        const deploying = previewing(app, copy, runs)
        const health = copyHealth(app, copy, runs)
        const title = changeTitle(copy.pr?.title, app.name)
        const notes = [
          copy.localEdits ? 'unsaved edits' : null,
          (copy.behind ?? 0) > 0 ? `${copy.behind} behind` : null,
          copy.review === 'APPROVED' ? 'approved' : copy.review === 'CHANGES_REQUESTED' ? 'changes requested' : null,
          !deploying && health !== 'failed' && previewBehind(copy) ? 'preview is older' : null
        ].filter(Boolean)
        return (
          <>
            <div className="tmap-node-head">
              <Avatar login={copy.author || 'you'} url={copy.avatarUrl} size={28} />
              <div className="tmap-titles">
                <strong>{copy.mine ? 'You' : copy.author}</strong>
                <span className="tmap-dim">
                  {copy.pr ? `#${copy.pr.number}${copy.pr.draft ? ' · draft' : ''}` : 'Not on GitHub yet'}
                  {copy.updatedAt ? ` · ${timeAgo(copy.updatedAt, now)}` : ''}
                </span>
              </div>
              <HealthPill health={health} label={health === 'live' ? 'Preview' : undefined} />
            </div>
            {title && <div className="tmap-copy-title">{title}</div>}
            <div className="tmap-node-foot">
              <DiffBar additions={copy.additions} deletions={copy.deletions} />
              <span className="tmap-dim tmap-ellipsis">
                {copy.changedFiles} {copy.changedFiles === 1 ? 'file' : 'files'}
                {notes.length ? ` · ${notes.join(' · ')}` : ''}
              </span>
            </div>
            {deploying && <RunLine deploying={deploying} now={now} />}
          </>
        )
      }
      case 'resource': {
        const item = itemById.get(node.id)
        return item ? <ResourceNodeBody item={item} /> : null
      }
      case 'resource-empty':
        return <EmptyNodeBody loading={!dataView} error={dataView?.apps[node.folder ?? '']?.error} />
      case 'source': {
        const source = sourceById.get(node.id)
        return source && dataView ? <SourceNodeBody source={source} apps={sourceApps(map, dataView, source)} /> : null
      }
    }
  }

  return (
    <div className="tmap" role="region" aria-label={`${ws.name} overview`}>
      <header className="tmap-head">
        <div className="tmap-head-title">
          <span className="tmap-head-glyph" aria-hidden="true">
            <Codicon name="type-hierarchy-sub" />
          </span>
          <h2 className="tmap-title">{ws.name}</h2>
          <button
            type="button"
            className="tmap-repo"
            onClick={() => void window.api.openExternal(`https://github.com/${ws.repo}`)}
            title="Open on GitHub"
          >
            <Codicon name="github" /> {ws.repo}
          </button>
          {stats && (
            <div className="tmap-figures" aria-label="Summary">
              <span>
                <strong>{stats.apps}</strong> {stats.apps === 1 ? 'app' : 'apps'}
              </span>
              <span>
                <strong>{stats.copies}</strong> in progress
              </span>
              <span>
                <strong>{stats.live}</strong> live
              </span>
            </div>
          )}
          {map && map.members.length > 0 && (
            <button
              type="button"
              className={`tmap-people${selection === nodeIds.hub ? ' tmap-people--on' : ''}`}
              onClick={toggleManage}
              title="Members, app access and settings"
              aria-label={`${map.members.length} ${map.members.length === 1 ? 'member' : 'members'}`}
            >
              <span className="tmap-avatars">
                {map.members.slice(0, 5).map((m) => (
                  <Avatar key={m.login} login={m.login} url={m.avatarUrl} size={22} />
                ))}
              </span>
              {map.members.length > 5 && <span className="tmap-dim">+{map.members.length - 5}</span>}
            </button>
          )}
        </div>
        <div className="tmap-tools">
          {stats && stats.deploying > 0 && (
            <span className="tmap-health tmap-health--deploying tmap-head-status">
              <span className="tmap-health-dot" aria-hidden="true" />
              {stats.deploying} deploying
            </span>
          )}
          {onNewApp && (
            <button type="button" className="model-tool-btn" onClick={() => onNewApp(workspace.id)}>
              <Codicon name="add" /> New app
            </button>
          )}
          <button
            type="button"
            className={`model-tool-btn${selection === nodeIds.hub ? ' tmap-tool--on' : ''}`}
            onClick={toggleManage}
            aria-pressed={selection === nodeIds.hub}
            title="Members, app access and settings"
          >
            <Codicon name="gear" /> Manage
          </button>
          <button type="button" className="model-tool-btn" onClick={() => void load()} disabled={loading} title="Refresh">
            <Codicon name="refresh" className={loading ? 'tmap-spin' : undefined} />
          </button>
          <div className="model-zoom" role="group" aria-label="Zoom">
            <button type="button" className="model-zoom-btn" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
              <Codicon name="zoom-out" />
            </button>
            <button type="button" className="model-zoom-label" onClick={() => fitTo()} title="Fit to window">
              {Math.round(view.scale * 100)}%
            </button>
            <button type="button" className="model-zoom-btn" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
              <Codicon name="zoom-in" />
            </button>
          </div>
          <button type="button" className="model-tool-btn" onClick={() => fitTo()} title="Fit to window">
            <Codicon name="screen-full" />
          </button>
          <button type="button" className="model-tool-btn" onClick={onClose} aria-label="Close the overview" title="Close (Esc)">
            <Codicon name="close" />
          </button>
        </div>
      </header>

      {error && <div className="alert alert--error tmap-alert">{error}</div>}

      <div className="tmap-body">
        <div
          className="tmap-viewport"
          ref={viewportRef}
          data-panning={panning ? 'true' : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          {!layout ? (
            <div className="tmap-loading">
              <span className="tmap-spinner tmap-spinner--lg" />
              <span>Loading {workspace.name}…</span>
            </div>
          ) : (
            <div
              className="tmap-canvas"
              style={{
                width: layout.width + PAD * 2,
                height: layout.height + PAD * 2,
                transform: `translate(${Math.round(view.tx)}px, ${Math.round(view.ty)}px) scale(${view.scale})`
              }}
            >
              {layout.lanes.map((lane) => (
                <div key={lane.label} className="tmap-lane" style={{ left: lane.x + PAD, top: PAD, width: lane.w }}>
                  {lane.label}
                </div>
              ))}

              {layout.nodes.map((node) => {
                const dim = focusSet ? !focusSet.has(node.id) : false
                // The "nothing here" placeholder stands for its app.
                const target = node.kind === 'resource-empty' && node.folder ? nodeIds.app(node.folder) : node.id
                const selected = selection === node.id
                return (
                  <div
                    key={node.id}
                    ref={setNodeRef(node.id)}
                    className={`tmap-node tmap-node--${node.kind}${node.draft ? ' tmap-node--draft' : ''}${
                      dim ? ' tmap-node--dim' : ''
                    }${selected ? ' tmap-node--selected' : ''}`}
                    style={{ left: node.x + PAD, top: node.y + PAD, width: node.w }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('button, a')) return
                      setSelection(selected ? null : target)
                    }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelection(selected ? null : target)
                      }
                    }}
                    onMouseEnter={() => setHovered(node.id)}
                    onMouseLeave={() => setHovered((h) => (h === node.id ? null : h))}
                  >
                    {renderNode(node)}
                  </div>
                )
              })}

              {/* Above the nodes (lines only run between columns), so their ends sit on the nodes' sides. */}
              <svg className="tmap-edges" width={layout.width + PAD * 2} height={layout.height + PAD * 2} aria-hidden="true">
                <g transform={`translate(${PAD} ${PAD})`}>
                  {layout.edges.map((edge) => {
                    const mood = focusSet
                      ? focusSet.has(edge.from) && focusSet.has(edge.to)
                        ? ' tmap-edge--hot'
                        : ' tmap-edge--dim'
                      : ''
                    return (
                      <g
                        key={edge.id}
                        className={`tmap-edge tmap-edge--${edge.kind} tmap-edge--${edge.health}${
                          edge.production ? ' tmap-edge--prod' : ''
                        }${edge.draft ? ' tmap-edge--draft' : ''}${mood}`}
                      >
                        <path d={edge.d} className="tmap-edge-base" />
                        {edge.health === 'deploying' && edge.kind === 'version' && (
                          <path d={edge.d} className="tmap-edge-flow" />
                        )}
                        <circle cx={edge.x1} cy={edge.y1} r={3.5} className="tmap-port tmap-port--from" />
                        <circle cx={edge.x2} cy={edge.y2} r={3.5} className="tmap-port tmap-port--to" />
                      </g>
                    )
                  })}
                </g>
              </svg>
            </div>
          )}

          {map && map.apps.length === 0 && (
            <div className="tmap-empty">
              <strong>No apps yet</strong>
              <span>Create the first app in this workspace; it shows up here with everyone&apos;s work on it.</span>
              {onNewApp && (
                <button type="button" className="btn btn--sm btn--primary" onClick={() => onNewApp(workspace.id)}>
                  <Codicon name="add" /> New app
                </button>
              )}
            </div>
          )}
        </div>

        {selection === nodeIds.hub ? (
          <WorkspacePanel
            workspace={ws}
            viewer={map?.viewer}
            onClose={() => setSelection(null)}
            onChanged={() => {
              void load()
              onChanged?.()
            }}
            onGone={() => onChanged?.()}
          />
        ) : map && selection && (selection.startsWith('res:') || selection.startsWith('src:')) ? (
          dataView ? (
            <ResourceDetails
              map={map}
              view={dataView}
              selection={selection}
              opening={opening}
              onClose={() => setSelection(null)}
              onSelect={reveal}
              onOpenApp={(folder) => void openApp(folder)}
            />
          ) : null
        ) : map && selection ? (
          <Inspector
            workspace={ws}
            map={map}
            runs={runs}
            selection={selection}
            opening={opening}
            onClose={() => setSelection(null)}
            onSelect={reveal}
            onOpenApp={(folder) => void openApp(folder)}
            onRemoved={() => {
              setSelection(null)
              void load()
              onChanged?.()
            }}
          />
        ) : map ? (
          <ActivityPanel
            map={map}
            runs={runs}
            now={now}
            fabric={ws.manifest?.fabric}
            notice={dataError}
            targetOf={runTarget}
            onReveal={reveal}
            onSelect={setSelection}
          />
        ) : null}
      </div>
    </div>
  )
}
