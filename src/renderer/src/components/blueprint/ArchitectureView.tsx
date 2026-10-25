import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type JSX,
} from 'react'
import type { StudioProject } from '@shared/ipc'
import {
  ids,
  portsOf,
  routesThrough,
  type AppArchitecture,
  type AppIdentityInfo,
  type Identity,
  type Route,
  type ServiceNode,
  type SourceNode
} from '../../model/architecture'
import { Codicon } from '../icons'
import ArchitectureInspector from './ArchitectureInspector'
import { connectData, type ChatPrompt } from './prompts'
import { loadFabricInfo, type FabricInfo } from './fabricInfo'
import { appIdentityName, appWorkspaceId, deployState, FabricMark, host, hueOf, IDENTITY_ICON, PORT_LABEL } from './util'
import './blueprint.css'

interface Props {
  arch: AppArchitecture
  project: StudioProject
  /** Whose credentials "the app" uses. */
  appIdentity: AppIdentityInfo
  /** The Fabric workspace the app lives in, by name, when known. */
  workspaceName?: string
  onOpenFile: (path: string) => void
  onSendToChat: (display: string, prompt: string, stage?: boolean) => void
  /** Show an entity in the Data model view. */
  onOpenEntity: (entity: string) => void
  /** Show a semantic model (`workspaceId:itemId`) in the Semantic model view. */
  onOpenSemanticModel: (key: string) => void
  /** Open Code → Secrets. */
  onOpenSecrets?: () => void
}

interface ViewT {
  scale: number
  tx: number
  ty: number
}

interface Edge {
  id: string
  kind: 'people' | 'source' | 'ghost'
  service?: string
  identity?: Identity
  source?: string
  d: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Where a group of sources lives: a Fabric workspace, Fabric itself, Azure or the web. */
export interface Zone {
  id: string
  kind: 'workspace' | 'fabric' | 'azure' | 'web'
  title: string
  meta?: string
  sources: SourceNode[]
}

const MIN_SCALE = 0.3
const MAX_SCALE = 1.8
const FIT_MAX = 1.1
const DRAG_THRESHOLD = 4

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Every node a set of routes passes through: parts, their ports, sources, and the app identity. */
function touched(focus: string, routes: Route[]): Set<string> {
  const nodes = new Set<string>([focus])
  for (const r of routes) {
    nodes.add(r.service)
    nodes.add(ids.port(r.service, r.identity))
    nodes.add(r.source)
    if (r.identity === 'app') nodes.add(ids.identity('app'))
  }
  return nodes
}

/** An element's offset inside `root`, ignoring CSS transforms (so zoom never skews it). */
function offsetWithin(el: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0
  let y = 0
  let cur: HTMLElement | null = el
  while (cur && cur !== root) {
    x += cur.offsetLeft
    y += cur.offsetTop
    cur = cur.offsetParent as HTMLElement | null
  }
  return { x, y }
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const c = Math.max(28, (x2 - x1) * 0.5)
  return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`
}

/** Group the sources by where they live, the app's own workspace first. */
export function zonesOf(arch: AppArchitecture, info: FabricInfo | null, appWs?: string): Zone[] {
  const zones = new Map<string, Zone>()
  const add = (id: string, make: () => Omit<Zone, 'id' | 'sources'>, src: SourceNode): void => {
    const zone = zones.get(id) ?? { id, ...make(), sources: [] }
    zone.sources.push(src)
    zones.set(id, zone)
  }
  for (const src of arch.sources) {
    if (src.workspaceId) {
      const wsId = src.workspaceId.toLowerCase()
      add(
        `zone:ws:${wsId}`,
        () => {
          const ws = info?.workspaces.get(wsId)
          const kind = wsId === appWs ? 'This app’s workspace' : 'Fabric workspace'
          const where = ws?.sku ? `${ws.sku}${ws.region ? ` · ${ws.region}` : ''}` : undefined
          return ws?.displayName
            ? { kind: 'workspace', title: ws.displayName, meta: where ? `${kind} · ${where}` : kind }
            : { kind: 'workspace', title: kind, meta: `ID ${wsId.slice(0, 8)}…` }
        },
        src
      )
    } else if (src.vendor === 'fabric') {
      add('zone:fabric', () => ({ kind: 'fabric', title: 'Microsoft Fabric' }), src)
    } else if (src.vendor === 'azure') {
      add('zone:azure', () => ({ kind: 'azure', title: 'Azure' }), src)
    } else {
      add('zone:web', () => ({ kind: 'web', title: 'Web APIs' }), src)
    }
  }
  for (const zone of zones.values()) {
    if (zone.kind !== 'workspace' && zone.sources.every((s) => s.kind === 'audience' || s.kind === 'api')) {
      zone.meta = 'Called from functions'
    }
  }
  const rank = (z: Zone): number =>
    z.kind === 'workspace' ? (z.id === `zone:ws:${appWs}` ? 0 : 1) : z.kind === 'fabric' ? 2 : z.kind === 'azure' ? 3 : 4
  return [...zones.values()].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
}

export default function ArchitectureView({
  arch,
  project,
  appIdentity,
  workspaceName,
  onOpenFile,
  onSendToChat,
  onOpenEntity,
  onOpenSemanticModel,
  onOpenSecrets
}: Props): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ViewT>({ scale: 1, tx: 0, ty: 0 })
  const [edges, setEdges] = useState<Edge[]>([])
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [panning, setPanning] = useState(false)
  const [measureTick, setMeasureTick] = useState(0)
  const [info, setInfo] = useState<FabricInfo | null>(null)

  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLElement>())
  const viewRef = useRef(view)
  viewRef.current = view
  const gesture = useRef<{ startX: number; startY: number; tx0: number; ty0: number; moved: boolean } | null>(null)
  const fitPending = useRef(true)

  const deploy = deployState(project)
  const hasSources = arch.sources.length > 0
  const ports = useMemo(() => portsOf(arch), [arch])
  const usesApp = arch.routes.some((r) => r.identity === 'app')
  const appWs = appWorkspaceId(project)
  const zones = useMemo(() => zonesOf(arch, info, appWs), [arch, info, appWs])

  // A node that no longer exists (after the app changed) can't stay selected.
  const nodeIds = useMemo(() => {
    const s = new Set<string>([ids.people, ids.app])
    for (const svc of arch.services) s.add(svc.id)
    for (const [svc, list] of ports) for (const p of list) s.add(ids.port(svc, p.identity))
    if (usesApp) s.add(ids.identity('app'))
    for (const src of arch.sources) s.add(src.id)
    return s
  }, [arch, ports, usesApp])
  useEffect(() => {
    if (selected && !nodeIds.has(selected)) setSelected(null)
  }, [nodeIds, selected])

  // Refit whenever the set of nodes changes, not on every refresh.
  const shape = useMemo(() => [...nodeIds].sort().join('|'), [nodeIds])
  useEffect(() => {
    fitPending.current = true
  }, [shape])

  // Fill in workspace and model names from Fabric, quietly.
  useEffect(() => {
    let alive = true
    const workspaceIds = [...new Set(arch.sources.flatMap((s) => (s.workspaceId ? [s.workspaceId] : [])))]
    const modelWorkspaceIds = arch.sources.flatMap((s) => (s.semanticKey && s.workspaceId ? [s.workspaceId] : []))
    void loadFabricInfo({ workspaceIds, modelWorkspaceIds }).then((next) => {
      if (alive) setInfo(next)
    })
    return () => {
      alive = false
    }
  }, [arch])

  const setNodeRef = useCallback(
    (id: string) =>
      (el: HTMLElement | null): void => {
        if (el) nodeRefs.current.set(id, el)
        else nodeRefs.current.delete(id)
      },
    []
  )

  const fit = useCallback((): void => {
    const vp = viewportRef.current
    const st = stageRef.current
    if (!vp || !st) return
    const vw = vp.clientWidth
    const vh = vp.clientHeight
    const cw = st.offsetWidth
    const ch = st.offsetHeight
    if (!vw || !vh || !cw || !ch) return
    const scale = clamp(Math.min(vw / cw, vh / ch, FIT_MAX), MIN_SCALE, MAX_SCALE)
    setView({ scale, tx: (vw - cw * scale) / 2, ty: Math.max(0, (vh - ch * scale) / 2) })
  }, [])

  // Measure the laid-out nodes and route the lines between them. Every line to
  // a source leaves the part that reaches it, from the port for the identity it
  // signs in as, and ends at the source's card.
  useLayoutEffect(() => {
    const st = stageRef.current
    if (!st) return
    const rect = (id: string): { x: number; y: number; w: number; h: number } | null => {
      const el = nodeRefs.current.get(id)
      if (!el) return null
      const p = offsetWithin(el, st)
      return { x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight }
    }
    const app = rect(ids.app)
    const next: Edge[] = []
    const push = (e: Omit<Edge, 'd'>): void => {
      next.push({ ...e, d: curve(e.x1, e.y1, e.x2, e.y2) })
    }
    const people = rect(ids.people)
    if (people && app) {
      const anchor = rect(ids.service('website')) ?? rect(ids.service('signin'))
      push({
        id: 'people',
        kind: 'people',
        x1: people.x + people.w,
        y1: people.y + people.h / 2,
        x2: anchor ? anchor.x : app.x,
        y2: anchor ? anchor.y + anchor.h / 2 : app.y + 28
      })
    }
    if (app) {
      for (const r of arch.routes) {
        const part = rect(r.service)
        const port = rect(ids.port(r.service, r.identity))
        const card = rect(r.source)
        if (!part || !port || !card) continue
        push({
          id: `${r.service}|${r.identity}>${r.source}`,
          kind: 'source',
          service: r.service,
          identity: r.identity,
          source: r.source,
          x1: part.x + part.w,
          y1: port.y + port.h / 2,
          x2: card.x,
          y2: card.y + card.h / 2
        })
      }
      const ghost = rect('ghost')
      if (ghost) {
        push({ id: 'ghost', kind: 'ghost', x1: app.x + app.w, y1: app.y + app.h / 2, x2: ghost.x, y2: ghost.y + ghost.h / 2 })
      }
    }
    setEdges(next)
    setStage({ w: st.offsetWidth, h: st.offsetHeight })
    if (fitPending.current) {
      fitPending.current = false
      fit()
    }
  }, [arch, zones, ports, measureTick, fit])

  // Re-measure when a node changes size (fonts loading, names arriving from Fabric).
  useEffect(() => {
    const st = stageRef.current
    if (!st || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setMeasureTick((n) => n + 1))
    ro.observe(st)
    return () => ro.disconnect()
  }, [])

  // Cursor-anchored wheel zoom (non-passive, so the page doesn't scroll).
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = vp.getBoundingClientRect()
      const cx = e.clientX - r.left
      const cy = e.clientY - r.top
      const v = viewRef.current
      const scale = clamp(v.scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE)
      const k = scale / v.scale
      setView({ scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k })
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [])

  const zoomBy = useCallback((k: number): void => {
    const vp = viewportRef.current
    if (!vp) return
    const cx = vp.clientWidth / 2
    const cy = vp.clientHeight / 2
    const v = viewRef.current
    const scale = clamp(v.scale * k, MIN_SCALE, MAX_SCALE)
    const kk = scale / v.scale
    setView({ scale, tx: cx - (cx - v.tx) * kk, ty: cy - (cy - v.ty) * kk })
  }, [])

  // Fit a set of nodes (a selection and what it touches) into view without
  // zooming in past where the person left it; null fits everything.
  const fitTo = useCallback(
    (target: ReadonlySet<string> | null): void => {
      const vp = viewportRef.current
      const st = stageRef.current
      if (!target || !vp || !st) {
        fit()
        return
      }
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const id of target) {
        const el = nodeRefs.current.get(id)
        if (!el) continue
        const p = offsetWithin(el, st)
        x0 = Math.min(x0, p.x)
        y0 = Math.min(y0, p.y)
        x1 = Math.max(x1, p.x + el.offsetWidth)
        y1 = Math.max(y1, p.y + el.offsetHeight)
      }
      const vw = vp.clientWidth
      const vh = vp.clientHeight
      if (!Number.isFinite(x0) || !vw || !vh) return
      const pad = 40
      const scale = clamp(
        Math.min((vw - pad * 2) / (x1 - x0), (vh - pad * 2) / (y1 - y0), viewRef.current.scale, FIT_MAX),
        MIN_SCALE,
        MAX_SCALE
      )
      setView({ scale, tx: vw / 2 - ((x0 + x1) / 2) * scale, ty: vh / 2 - ((y0 + y1) / 2) * scale })
    },
    [fit]
  )

  // Opening the details panel narrows the canvas: bring the selection and what it
  // touches into view, gently. Closing it shows the whole app again.
  const [gliding, setGliding] = useState(false)
  const glideTimer = useRef<number | null>(null)
  const glide = useCallback((): void => {
    setGliding(true)
    if (glideTimer.current != null) window.clearTimeout(glideTimer.current)
    glideTimer.current = window.setTimeout(() => setGliding(false), 280)
  }, [])
  useEffect(
    () => () => {
      if (glideTimer.current != null) window.clearTimeout(glideTimer.current)
    },
    []
  )
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    const opened = wasOpen.current !== Boolean(selected)
    wasOpen.current = Boolean(selected)
    if (!selected) {
      if (opened) {
        glide()
        fit()
      }
      return
    }
    const routes = routesThrough(arch, selected)
    const near = routes ? touched(selected, routes) : null
    glide()
    fitTo(near)
    // Only the selection drives this, so a refresh of the app (a new `arch`)
    // doesn't move the canvas under the person.
  }, [selected, fit, fitTo, glide])

  // Escape closes the details panel.
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-node], button, a, input')) return
    const v = viewRef.current
    gesture.current = { startX: e.clientX, startY: e.clientY, tx0: v.tx, ty0: v.ty, moved: false }
    viewportRef.current?.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    if (!g) return
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    if (!g.moved) {
      g.moved = true
      setPanning(true)
    }
    setView((v) => ({ ...v, tx: g.tx0 + dx, ty: g.ty0 + dy }))
  }, [])

  const endPan = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    gesture.current = null
    setPanning(false)
    try {
      viewportRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    // A click on empty canvas (not a drag) clears the selection.
    if (g && !g.moved && e.type === 'pointerup') setSelected(null)
  }, [])

  const select = useCallback((id: string): void => {
    setSelected((cur) => (cur === id ? null : id))
  }, [])

  const sendPrompt = useCallback(
    (p: ChatPrompt): void => onSendToChat(p.display, p.prompt, p.stage),
    [onSendToChat]
  )

  /* ---------------------------- highlighting ---------------------------- */

  const nameOf = useCallback(
    (src: SourceNode): string => (src.itemId && info?.models.get(src.itemId.toLowerCase())?.name) || src.title,
    [info]
  )

  // Search dims what doesn't match, like the Data model view.
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const hit = (...texts: (string | undefined)[]): boolean => texts.some((t) => t?.toLowerCase().includes(q))
    const s = new Set<string>()
    for (const svc of arch.services) if (hit(svc.title, svc.summary, svc.meta)) s.add(svc.id)
    for (const src of arch.sources) {
      const ws = src.workspaceId ? info?.workspaces.get(src.workspaceId.toLowerCase())?.displayName : undefined
      if (hit(src.title, nameOf(src), src.typeLabel, src.ability, ws, ...src.hosts, ...src.functions, ...src.connectors.map((c) => c.name))) {
        s.add(src.id)
      }
    }
    return s
  }, [query, arch, info, nameOf])

  const focusId = selected ?? hovered
  // People come in through the website (or sign-in, without one): light them with it.
  const peopleAnchor = arch.services.some((s) => s.kind === 'website') ? ids.service('website') : ids.service('signin')
  const lit = useMemo(() => {
    const routes = routesThrough(arch, focusId)
    if (!routes || !focusId) return null
    const nodes = touched(focusId, routes)
    if (nodes.has(peopleAnchor)) nodes.add(ids.people)
    return { nodes, routes }
  }, [arch, focusId, peopleAnchor])

  const dim = (id: string): boolean => {
    if (id === ids.app) return false
    if (lit) return !lit.nodes.has(id)
    if (matched) return !matched.has(id)
    return false
  }
  const edgeMood = (e: Edge): '' | ' bp-edge--hot' | ' bp-edge--dim' => {
    if (e.kind === 'people' && lit?.nodes.has(ids.people)) return ''
    if (e.kind !== 'source') return lit || matched ? ' bp-edge--dim' : ''
    if (lit) {
      const hot = lit.routes.some((r) => r.service === e.service && r.identity === e.identity && r.source === e.source)
      return hot ? ' bp-edge--hot' : ' bp-edge--dim'
    }
    if (matched) return matched.has(e.source!) || matched.has(e.service!) ? '' : ' bp-edge--dim'
    return ''
  }

  const handlers = (id: string, label: string) => ({
    'data-node': id,
    role: 'button',
    tabIndex: 0,
    'aria-pressed': selected === id,
    'aria-label': label,
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation()
      select(id)
    },
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        select(id)
      }
    },
    onMouseEnter: () => {
      if (!gesture.current) setHovered(id)
    },
    onMouseLeave: () => setHovered((h) => (h === id ? null : h))
  })

  const cls = (base: string, id: string): string =>
    `${base}${selected === id ? ' bp-is-selected' : ''}${dim(id) ? ' bp-is-dim' : ''}`

  /* ------------------------------- render ------------------------------- */

  const appWho = appIdentityName(appIdentity, Boolean(project.lastDeploy?.url))
  let stagger = 0
  const enter = (): CSSProperties => (({
    '--i': stagger++
  }) as CSSProperties)

  return (
    <div className="bp-arch">
      <div className="model-toolbar">
        <div className="model-search">
          <Codicon name="search" className="model-search-ico" />
          <input
            className="model-search-input"
            value={query}
            placeholder="Search the app and its connections"
            aria-label="Search the app and its connections"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="model-search-clear" aria-label="Clear search" onClick={() => setQuery('')}>
              <Codicon name="close" />
            </button>
          )}
        </div>
        <div className="model-toolbar-spacer" />
        {deploy.url && (
          <button
            type="button"
            className="model-tool-btn"
            onClick={() => void window.api.openExternal(deploy.url!)}
            title={`Open ${host(deploy.url)}`}
          >
            <Codicon name="globe" /> Open the app
          </button>
        )}
        {deploy.portalUrl && (
          <button
            type="button"
            className="model-tool-btn"
            onClick={() => void window.api.openExternal(deploy.portalUrl!)}
            title="Open the app in the Fabric portal"
          >
            <Codicon name="link-external" /> Open in Fabric
          </button>
        )}
        <div className="model-zoom" role="group" aria-label="Zoom">
          <button className="model-zoom-btn" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
            <Codicon name="zoom-out" />
          </button>
          <button className="model-zoom-label" onClick={fit} title="Fit to view">
            {Math.round(view.scale * 100)}%
          </button>
          <button className="model-zoom-btn" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
            <Codicon name="zoom-in" />
          </button>
        </div>
        <button className="model-tool-btn" onClick={fit} title="Fit to view" aria-label="Fit to view">
          <Codicon name="screen-full" />
        </button>
      </div>

      <div className="bp-body">
        <div
          className="bp-viewport"
          ref={viewportRef}
          data-panning={panning ? 'true' : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <div
            className={`bp-canvas${gliding ? ' bp-canvas--glide' : ''}`}
            style={{
              transform: `translate(${Math.round(view.tx)}px, ${Math.round(view.ty)}px) scale(${view.scale})`
            }}
          >
            <div className="bp-stage" ref={stageRef}>
              {/* People */}
              <div className="bp-col bp-col--people">
                <div
                  className={cls('bp-node bp-people', ids.people)}
                  style={enter()}
                  ref={setNodeRef(ids.people)}
                  {...handlers(ids.people, 'People who use the app')}
                >
                  <div className="bp-people-head">
                    <div className="bp-faces" aria-hidden="true">
                      {[0, 1, 2].map((i) => (
                        <span key={i} className="bp-face">
                          <Codicon name="person" />
                        </span>
                      ))}
                    </div>
                    <div className="bp-titles">
                      <strong>People</strong>
                      <span>who use the app</span>
                    </div>
                  </div>
                  <ul className="bp-facts">
                    <li className={arch.config.auth.enabled ? '' : 'bp-fact--danger'}>
                      <Codicon name={arch.config.auth.enabled ? 'shield' : 'unlock'} />
                      <span>{arch.config.auth.enabled ? 'Sign in with Microsoft Entra ID' : 'Sign-in is off'}</span>
                    </li>
                  </ul>
                </div>
              </div>

              {/* The app: who it signs in as, and what it's made of; each piece that
                  reaches outside shows the identities its connections leave as */}
              <div className="bp-col bp-col--app">
                <div className={cls('bp-node bp-app', ids.app)} style={enter()} ref={setNodeRef(ids.app)}>
                  <div className="bp-app-top">
                    <div className="bp-app-head" {...handlers(ids.app, `${arch.name}, the Fabric app`)}>
                      <span className="bp-mark" style={{ '--hue': hueOf(arch.name) } as CSSProperties} aria-hidden="true">
                        {arch.name.trim()[0]?.toUpperCase() ?? '?'}
                      </span>
                      <div className="bp-titles">
                        <strong>{arch.name}</strong>
                        <span>{workspaceName ? `Fabric app in ${workspaceName}` : 'Fabric app'}</span>
                      </div>
                    </div>
                    {usesApp && (
                      <AppIdentityRow
                        who={appWho}
                        servicePrincipal={appIdentity.kind === 'service-principal'}
                        className={cls('bp-row bp-whois', ids.identity('app'))}
                        elRef={setNodeRef(ids.identity('app'))}
                        {...handlers(ids.identity('app'), `App identity: ${appWho}`)}
                      />
                    )}
                  </div>
                  <div className="bp-section">
                    {arch.services.map((svc) => {
                      const svcPorts = ports.get(svc.id) ?? []
                      const svcDim = dim(svc.id)
                      return (
                        <div
                          key={svc.id}
                          className={cls(`bp-row bp-svc${svcPorts.length ? ' bp-svc--ports' : ''}`, svc.id)}
                          ref={setNodeRef(svc.id)}
                        >
                          <ServiceMain
                            svc={svc}
                            hasPorts={svcPorts.length > 0}
                            counts={svc.kind === 'database' ? arch.database?.counts : undefined}
                            {...handlers(svc.id, `${svc.title}: ${svc.summary}`)}
                          />
                          {svcPorts.length > 0 && (
                            <div className="bp-ports">
                              {svcPorts.map((p) => {
                                const id = ids.port(svc.id, p.identity)
                                return (
                                  <PortRow
                                    key={id}
                                    identity={p.identity}
                                    count={p.count}
                                    className={`bp-port-row bp-port-row--${p.identity}${selected === id ? ' bp-is-selected' : ''}${
                                      !svcDim && dim(id) ? ' bp-is-dim' : ''
                                    }`}
                                    elRef={setNodeRef(id)}
                                    {...handlers(id, `${svc.title}, ${PORT_LABEL[p.identity].toLowerCase()}`)}
                                  />
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              {/* Where it reaches, grouped by where those things live */}
              <div className="bp-col bp-col--zones">
                {hasSources ? (
                  zones.map((zone) => (
                    <section key={zone.id} className={`bp-zone bp-zone--${zone.kind}`} ref={setNodeRef(zone.id)} style={enter()}>
                      <header className="bp-zone-head">
                        <span className="bp-zone-mark" aria-hidden="true">
                          {zone.kind === 'workspace' || zone.kind === 'fabric' ? (
                            <FabricMark size={22} />
                          ) : (
                            <Codicon name={zone.kind === 'azure' ? 'azure' : 'globe'} />
                          )}
                        </span>
                        <span className="bp-zone-titles">
                          <span className="bp-zone-title">{zone.title}</span>
                          {zone.meta && <span className="bp-zone-meta">{zone.meta}</span>}
                        </span>
                      </header>
                      {zone.sources.map((src) => (
                        <SourceRow
                          key={src.id}
                          src={src}
                          name={nameOf(src)}
                          className={cls('bp-row bp-src', src.id)}
                          elRef={setNodeRef(src.id)}
                          {...handlers(src.id, `${nameOf(src)}, ${src.typeLabel}`)}
                        />
                      ))}
                    </section>
                  ))
                ) : (
                  <div className="bp-node bp-ghost" data-node="ghost" ref={setNodeRef('ghost')} style={enter()}>
                    <span className="bp-ghost-ico" aria-hidden="true">
                      <Codicon name="plug" />
                    </span>
                    <strong>No outside data yet</strong>
                    <span>
                      Bring in a Fabric warehouse, SQL database, lakehouse or semantic model, or call Azure
                      services from functions.
                    </span>
                    <button type="button" className="btn btn--xs btn--ghost" onClick={() => sendPrompt(connectData())}>
                      Connect data with Copilot
                    </button>
                  </div>
                )}
              </div>

              <svg className="bp-edges" width={stage.w} height={stage.h} aria-hidden="true">
                {edges.map((e) => (
                  <g
                    key={e.id}
                    className={`bp-edge bp-edge--${e.kind}${e.identity ? ` bp-edge--${e.identity}` : ''}${edgeMood(e)}`}
                  >
                    <path d={e.d} pathLength={1} className="bp-edge-line" />
                    <path d={e.d} className="bp-edge-flow" />
                    <circle cx={e.x1} cy={e.y1} r={3} className="bp-port" />
                    <circle cx={e.x2} cy={e.y2} r={3} className="bp-port" />
                  </g>
                ))}
              </svg>
            </div>
          </div>
        </div>

        {selected && (
          <ArchitectureInspector
            key={selected}
            arch={arch}
            nodeId={selected}
            project={project}
            deploy={deploy}
            appIdentity={appIdentity}
            workspaceName={workspaceName}
            info={info}
            onClose={() => setSelected(null)}
            onSelect={(id) => setSelected(id)}
            onOpenFile={onOpenFile}
            onPrompt={sendPrompt}
            onOpenEntity={onOpenEntity}
            onOpenSemanticModel={onOpenSemanticModel}
            onOpenSecrets={onOpenSecrets}
          />
        )}
      </div>
    </div>
  )
}

/* ------------------------------- parts ------------------------------- */

type RowProps = Omit<JSX.IntrinsicElements['div'], 'ref'> & {
  /** Registers the element for line routing (function components don't get `ref`). */
  elRef: (el: HTMLElement | null) => void
}

const ACCESS_WORDS: [keyof NonNullable<AppArchitecture['database']>['counts'], string][] = [
  ['ok', 'row-scoped'],
  ['warn', 'any signed-in'],
  ['danger', 'public']
]

function ServiceMain({
  svc,
  counts,
  hasPorts,
  ...rest
}: {
  svc: ServiceNode
  counts?: { ok: number; warn: number; danger: number }
  hasPorts: boolean
} & Omit<JSX.IntrinsicElements['div'], 'ref'>): JSX.Element {
  const danger = svc.issues.find((i) => i.tone === 'danger')
  const shown = counts ? ACCESS_WORDS.filter(([t]) => counts[t] > 0) : []
  // Its lines already say where functions and connectors reach.
  const meta = hasPorts && (svc.kind === 'functions' || svc.kind === 'connectors') ? undefined : svc.meta
  return (
    <div className="bp-svc-main" {...rest}>
      <span className="bp-tile">
        <Codicon name={svc.icon} />
      </span>
      <div className="bp-row-text">
        <strong>{svc.title}</strong>
        <span>{svc.summary}</span>
        {svc.status && (
          <span className={`bp-access bp-access--${svc.status.tone}`}>
            <span className="bp-access-item">
              {svc.status.icon ? (
                <Codicon name={svc.status.icon} className="bp-access-ico" />
              ) : (
                <span className={`bp-dot bp-dot--${svc.status.tone}`} />
              )}
              {svc.status.text}
            </span>
          </span>
        )}
        {shown.length > 0 ? (
          <span className="bp-access" title={svc.meta}>
            {shown.map(([t, word]) => (
              <span key={t} className="bp-access-item">
                <span className={`bp-dot bp-dot--${t}`} />
                {counts![t]} {word}
              </span>
            ))}
          </span>
        ) : (
          meta && <span className={`bp-row-meta${svc.kind === 'secrets' ? ' bp-mono' : ''}`}>{meta}</span>
        )}
      </div>
      {danger && <Codicon name="warning" className="bp-flag bp-flag--danger" title={danger.text} />}
    </div>
  )
}

/** Where a part's connections leave with one identity; its lines start here. */
function PortRow({
  identity,
  count,
  className,
  elRef,
  ...rest
}: { identity: Identity; count: number } & RowProps): JSX.Element {
  return (
    <div className={className} ref={elRef} {...rest}>
      <span className="bp-port-ico" aria-hidden="true">
        <Codicon name={IDENTITY_ICON[identity]} />
      </span>
      <span className="bp-port-label">{PORT_LABEL[identity]}</span>
      <span className="bp-port-count" title={`${count} ${count === 1 ? 'connection' : 'connections'}`}>
        {count}
      </span>
    </div>
  )
}

/** Whose credentials "the app" signs in with: the owner of the Fabric app item. */
function AppIdentityRow({
  who,
  servicePrincipal,
  className,
  elRef,
  ...rest
}: { who: string; servicePrincipal: boolean } & RowProps): JSX.Element {
  return (
    <div className={className} ref={elRef} {...rest}>
      <span className="bp-tile bp-tile--id" aria-hidden="true">
        <Codicon name={servicePrincipal ? 'server-process' : IDENTITY_ICON.app} />
      </span>
      <div className="bp-row-text">
        <span className="bp-row-kicker">App identity</span>
        <strong title={who}>{who}</strong>
      </div>
    </div>
  )
}

function SourceRow({
  src,
  name,
  className,
  elRef,
  ...rest
}: { src: SourceNode; name: string } & RowProps): JSX.Element {
  const danger = src.issues.find((i) => i.tone === 'danger')
  const second =
    (src.kind === 'audience' || src.kind === 'api') && src.functions.length
      ? `Called by ${src.functions.join(', ')}`
      : [src.typeLabel, src.ability].filter(Boolean).join(' · ')
  return (
    <div className={className} ref={elRef} {...rest}>
      <span className="bp-tile">
        <Codicon name={src.icon} />
      </span>
      <div className="bp-row-text">
        <strong>{name}</strong>
        <span>{second}</span>
      </div>
      {danger ? (
        <Codicon name="warning" className="bp-flag bp-flag--danger" title={danger.text} />
      ) : src.issues.length > 0 ? (
        <Codicon name="info" className="bp-flag" title={src.issues[0].text} />
      ) : null}
    </div>
  )
}
