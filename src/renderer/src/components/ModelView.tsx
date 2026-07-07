import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { StudioProject } from '@shared/ipc'
import {
  parseProjectDataModel,
  type AccessLevel,
  type DataModel,
  type ModelEntity,
  type ModelField
} from '../model/parseSchema'
import { computeLayout, type LayoutEdge, type LayoutNode } from '../model/layout'
import {
  computeEdgeGeometry,
  deriveRelationEdges,
  type AnchorFn,
  type DerivedEdges,
  type EdgeRender
} from '../model/relationships'
import { Codicon } from './icons'

interface Props {
  project: StudioProject
  /** Bumped by the parent when files may have changed (e.g. after a chat turn). */
  refreshKey: number
  /** Open a project file in the Code tab. */
  onOpenFile: (path: string) => void
  /** Hand a prompt to the Build chat (stage stages it in the composer). */
  onSendToChat: (display: string, prompt: string, stage?: boolean) => void
}

/** Short label + chip class for a field's semantic type. */
function typeChip(field: ModelField): { label: string; cls: string } {
  switch (field.type) {
    case 'uuid':
      return { label: 'uuid', cls: 'model-chip--id' }
    case 'text':
      return { label: 'text', cls: 'model-chip--text' }
    case 'email':
      return { label: 'email', cls: 'model-chip--text' }
    case 'int':
      return { label: 'int', cls: 'model-chip--num' }
    case 'decimal':
      return { label: 'decimal', cls: 'model-chip--num' }
    case 'boolean':
      return { label: 'bool', cls: 'model-chip--bool' }
    case 'date':
      return { label: 'date', cls: 'model-chip--date' }
    case 'blob':
      return { label: 'blob', cls: 'model-chip--blob' }
    case 'enum':
      return { label: 'enum', cls: 'model-chip--enum' }
    case 'relation':
      return { label: field.relationKind === 'many' ? '↦ many' : '↦ one', cls: 'model-chip--rel' }
    default:
      return { label: field.tsType ?? '—', cls: 'model-chip--unknown' }
  }
}

const ACCESS_META: Record<AccessLevel, { tone: string }> = {
  public: { tone: 'danger' },
  authenticated: { tone: 'warn' },
  default: { tone: 'warn' },
  mixed: { tone: 'warn' },
  scoped: { tone: 'ok' }
}

/** Whether an entity's access is loose enough to warrant a "Harden" action. */
function needsHardening(level: AccessLevel): boolean {
  return level === 'public' || level === 'authenticated' || level === 'default' || level === 'mixed'
}

interface XY {
  x: number
  y: number
}

interface ViewT {
  scale: number
  tx: number
  ty: number
}

const CARD_WIDTH = 264
const MIN_SCALE = 0.3
const MAX_SCALE = 2.2
const DRAG_THRESHOLD = 4
const STORAGE_PREFIX = 'rayfin.model.layout.'
const EMPTY_SET: ReadonlySet<string> = new Set()

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Rough card height for the initial auto-layout (edges use real measured rects). */
function estimateHeight(entity: ModelEntity): number {
  const head = 40
  const actions = 40
  const perms = 30
  const rows = entity.fields.length || 1
  const fieldsH = rows * 26
  return head + 8 + fieldsH + perms + actions
}

function loadStoredPositions(projectId: string): Record<string, XY> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, XY>) : {}
  } catch {
    return {}
  }
}

export default function ModelView({
  project,
  refreshKey,
  onOpenFile,
  onSendToChat
}: Props): JSX.Element {
  const [model, setModel] = useState<DataModel | null>(null)
  const [loading, setLoading] = useState(true)

  const [highlight, setHighlight] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [collapsedAll, setCollapsedAll] = useState(false)
  const [collapsed, setCollapsed] = useState<Map<string, boolean>>(new Map())

  const [positions, setPositions] = useState<Map<string, XY>>(new Map())
  const [view, setView] = useState<ViewT>({ scale: 1, tx: 0, ty: 0 })
  const [edges, setEdges] = useState<EdgeRender[]>([])
  const [canvas, setCanvas] = useState({ w: 0, h: 0 })
  const [panning, setPanning] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [redrawTick, setRedrawTick] = useState(0)

  const viewportRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())

  // Refs mirroring state for use inside imperative pointer/wheel handlers.
  const viewRef = useRef(view)
  viewRef.current = view
  const positionsRef = useRef(positions)
  positionsRef.current = positions
  const projectIdRef = useRef(project.id)
  projectIdRef.current = project.id
  const gesture = useRef<
    | { kind: 'pan'; startX: number; startY: number; tx0: number; ty0: number }
    | { kind: 'card'; name: string; startX: number; startY: number; ox: number; oy: number; moved: boolean }
    | null
  >(null)
  /** Pending fit-to-view request, consumed after the next measure. */
  const fitReq = useRef<ReadonlySet<string> | 'all' | null>(null)

  // (Re)parse the data model whenever the project or its files change.
  useEffect(() => {
    let alive = true
    setLoading(true)
    parseProjectDataModel(project.id)
      .then((m) => {
        if (alive) {
          setModel(m)
          setLoading(false)
        }
      })
      .catch(() => {
        if (alive) {
          setModel({ entities: [], relations: [], warnings: [], hasSchema: false })
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [project.id, refreshKey])

  const entityNames = useMemo(() => new Set(model?.entities.map((e) => e.name) ?? []), [model])

  // De-duplicated entity-relationship model: one edge per logical relationship
  // (the raw parse reports the fk column, the relation it backs and the inverse
  // as three separate directed links).
  const derived = useMemo<DerivedEdges>(
    () => (model ? deriveRelationEdges(model.relations) : { pairs: [], selfs: [] }),
    [model]
  )


  // Undirected neighbour map for hover highlighting + focus neighbourhoods.
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    const add = (a: string, b: string): void => {
      if (!m.has(a)) m.set(a, new Set())
      m.get(a)!.add(b)
    }
    for (const r of model?.relations ?? []) {
      if (r.from !== r.to) {
        add(r.from, r.to)
        add(r.to, r.from)
      }
    }
    return m
  }, [model])
  const neighborsOf = useCallback(
    (name: string): ReadonlySet<string> => neighbors.get(name) ?? EMPTY_SET,
    [neighbors]
  )

  // The set of entities visible right now (all, or a focused neighbourhood).
  const renderSet = useMemo(() => {
    if (!model || !focus) return null
    const s = new Set<string>([focus])
    for (const n of neighborsOf(focus)) s.add(n)
    return s
  }, [model, focus, neighborsOf])
  const isRendered = useCallback(
    (name: string): boolean => !renderSet || renderSet.has(name),
    [renderSet]
  )

  // Entities matching the search query (null when the box is empty).
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const s = new Set<string>()
    for (const e of model?.entities ?? []) {
      const hit =
        e.name.toLowerCase().includes(q) ||
        (e.customName?.toLowerCase().includes(q) ?? false) ||
        e.fields.some((f) => f.name.toLowerCase().includes(q))
      if (hit) s.add(e.name)
    }
    return s
  }, [model, query])

  const isCollapsed = useCallback(
    (name: string): boolean => (collapsed.has(name) ? collapsed.get(name)! : collapsedAll),
    [collapsed, collapsedAll]
  )

  // Build auto-layout positions, then overlay any persisted manual positions.
  const buildPositions = useCallback(
    (model: DataModel, useStored: boolean): Map<string, XY> => {
      const nodes: LayoutNode[] = model.entities.map((e) => ({
        id: e.name,
        width: CARD_WIDTH,
        height: estimateHeight(e)
      }))
      const layoutEdges: LayoutEdge[] = model.relations.map((r) => ({ from: r.from, to: r.to }))
      // Bias the layout toward the live viewport shape so a wide window gets a
      // wide diagram (and fit-to-view doesn't have to zoom way out).
      const vp = viewportRef.current
      const targetAspect =
        vp && vp.clientWidth > 0 && vp.clientHeight > 0
          ? Math.min(2.6, Math.max(1.3, vp.clientWidth / vp.clientHeight))
          : undefined
      const auto = computeLayout(nodes, layoutEdges, { targetAspect }).positions
      const stored = useStored ? loadStoredPositions(projectIdRef.current) : {}
      const merged = new Map<string, XY>()
      for (const [name, rect] of auto) {
        const s = stored[name]
        merged.set(name, {
          x: s && typeof s.x === 'number' ? s.x : rect.x,
          y: s && typeof s.y === 'number' ? s.y : rect.y
        })
      }
      return merged
    },
    []
  )

  // When the model changes, (re)seed positions and reset interaction state.
  useEffect(() => {
    if (!model) return
    setPositions(buildPositions(model, true))
    setFocus(null)
    setQuery('')
    setHighlight(null)
    setCollapsed(new Map())
    fitReq.current = 'all'
  }, [model, buildPositions])

  const persistPositions = useCallback((): void => {
    const obj: Record<string, XY> = {}
    positionsRef.current.forEach((p, name) => {
      obj[name] = { x: Math.round(p.x), y: Math.round(p.y) }
    })
    try {
      localStorage.setItem(STORAGE_PREFIX + projectIdRef.current, JSON.stringify(obj))
    } catch {
      /* storage best-effort */
    }
  }, [])

  const setCardRef = useCallback(
    (name: string) =>
      (el: HTMLDivElement | null): void => {
        if (el) cardRefs.current.set(name, el)
        else cardRefs.current.delete(name)
      },
    []
  )

  /** Fit the given cards (or all rendered cards) into the viewport. */
  const fitTo = useCallback((target?: ReadonlySet<string>): void => {
    const vp = viewportRef.current
    if (!vp) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    cardRefs.current.forEach((el, name) => {
      if (target && !target.has(name)) return
      minX = Math.min(minX, el.offsetLeft)
      minY = Math.min(minY, el.offsetTop)
      maxX = Math.max(maxX, el.offsetLeft + el.offsetWidth)
      maxY = Math.max(maxY, el.offsetTop + el.offsetHeight)
    })
    if (!Number.isFinite(minX)) return
    const pad = 56
    const cw = maxX - minX + pad * 2
    const ch = maxY - minY + pad * 2
    const vw = vp.clientWidth
    const vh = vp.clientHeight
    if (vw === 0 || vh === 0) return
    const scale = clamp(Math.min(vw / cw, vh / ch, 1.4), MIN_SCALE, MAX_SCALE)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    setView({ scale, tx: vw / 2 - cx * scale, ty: vh / 2 - cy * scale })
  }, [])

  // Measure card rects, recompute edges + canvas bounds, and honour fit requests.
  useLayoutEffect(() => {
    if (!model) return
    const rectOf = (
      name: string
    ): { left: number; top: number; width: number; height: number } | null => {
      const el = cardRefs.current.get(name)
      if (!el) return null
      return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
    }

    // Vertical anchor for an edge end: the centre of the `via` field row (else the
    // entity's primary-key row). Returns null for collapsed/absent rows so the
    // geometry falls back to the card centre. Field names are JS identifiers, so
    // interpolating into the attribute selector is safe.
    const pkOf = (entity: string): string | undefined => {
      const ent = model.entities.find((x) => x.name === entity)
      return ent?.fields.find((f) => f.primaryKey)?.name ?? ent?.fields[0]?.name
    }
    const anchorY: AnchorFn = (entity, via) => {
      const el = cardRefs.current.get(entity)
      if (!el) return null
      const field = via ?? pkOf(entity)
      if (!field) return null
      const row = el.querySelector<HTMLElement>(`[data-field="${field}"]`)
      if (!row) return null
      return el.offsetTop + row.offsetTop + row.offsetHeight / 2
    }

    setEdges(computeEdgeGeometry(derived, rectOf, anchorY))

    let maxRight = 0
    let maxBottom = 0
    cardRefs.current.forEach((el) => {
      maxRight = Math.max(maxRight, el.offsetLeft + el.offsetWidth)
      maxBottom = Math.max(maxBottom, el.offsetTop + el.offsetHeight)
    })
    const pad = 80
    setCanvas({ w: maxRight + pad, h: maxBottom + pad })

    if (fitReq.current) {
      const target = fitReq.current
      fitReq.current = null
      const run = (): void => fitTo(target === 'all' ? undefined : target)
      // Defer to next frame so the canvas size above has applied.
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
      else run()
    }
  }, [model, derived, positions, collapsed, collapsedAll, renderSet, redrawTick, fitTo])

  // Web fonts load lazily; re-measure once they're ready so edges stay aligned.
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
    if (!fonts?.ready) return
    let alive = true
    fonts.ready.then(() => {
      if (alive) setRedrawTick((n) => n + 1)
    })
    return () => {
      alive = false
    }
  }, [])

  // Native, non-passive wheel handler: cursor-anchored zoom.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const v = viewRef.current
      const factor = Math.exp(-e.deltaY * 0.0015)
      const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE)
      const k = scale / v.scale
      setView({ scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k })
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
    // Re-run once the viewport exists: on the first render the component is in
    // its loading state (no viewport in the DOM), so binding must wait until a
    // model with entities mounts the viewport.
  }, [model])

  const onBackgroundPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const v = viewRef.current
    gesture.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx0: v.tx, ty0: v.ty }
    viewportRef.current?.setPointerCapture(e.pointerId)
    setPanning(true)
  }, [])

  const onCardPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, name: string): void => {
      e.stopPropagation() // never let a card interaction start a background pan
      if (e.button !== 0) return
      const t = e.target as HTMLElement
      if (t.closest('button, input, a, [data-no-drag]')) return
      const pos = positionsRef.current.get(name) ?? { x: 0, y: 0 }
      gesture.current = {
        kind: 'card',
        name,
        startX: e.clientX,
        startY: e.clientY,
        ox: pos.x,
        oy: pos.y,
        moved: false
      }
      viewportRef.current?.setPointerCapture(e.pointerId)
    },
    []
  )

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pan') {
      setView((v) => ({ ...v, tx: g.tx0 + (e.clientX - g.startX), ty: g.ty0 + (e.clientY - g.startY) }))
      return
    }
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    if (!g.moved) {
      g.moved = true
      setDragging(g.name)
    }
    const scale = viewRef.current.scale
    const nx = g.ox + dx / scale
    const ny = g.oy + dy / scale
    setPositions((prev) => {
      const next = new Map(prev)
      next.set(g.name, { x: nx, y: ny })
      return next
    })
  }, [])

  const endGesture = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const g = gesture.current
      gesture.current = null
      setPanning(false)
      try {
        viewportRef.current?.releasePointerCapture(e.pointerId)
      } catch {
        /* capture may already be released */
      }
      if (g?.kind === 'card' && g.moved) {
        setDragging(null)
        persistPositions()
      }
    },
    [persistPositions]
  )

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

  const resetLayout = useCallback((): void => {
    if (!model) return
    try {
      localStorage.removeItem(STORAGE_PREFIX + projectIdRef.current)
    } catch {
      /* ignore */
    }
    setPositions(buildPositions(model, false))
    fitReq.current = 'all'
  }, [model, buildPositions])

  const focusOn = useCallback(
    (name: string | null): void => {
      if (name) {
        const s = new Set<string>([name])
        for (const n of neighborsOf(name)) s.add(n)
        fitReq.current = s
      } else {
        fitReq.current = 'all'
      }
      setFocus(name)
      setHighlight(null)
    },
    [neighborsOf]
  )

  const toggleCard = useCallback(
    (name: string): void => {
      setCollapsed((prev) => {
        const next = new Map(prev)
        const eff = next.has(name) ? next.get(name)! : collapsedAll
        next.set(name, !eff)
        return next
      })
    },
    [collapsedAll]
  )

  const toggleCollapseAll = useCallback((): void => {
    setCollapsedAll((v) => !v)
    setCollapsed(new Map())
  }, [])

  const hardenEntity = useCallback(
    (entity: ModelEntity): void => {
      const prompt =
        `In this Rayfin app, the \`${entity.name}\` entity (${entity.file}) currently has access ` +
        `"${entity.access.label}": ${entity.access.detail}\n\n` +
        'Please tighten its access control following Rayfin conventions: add an appropriate ' +
        '`@role`/`@authenticated` decorator with a row-level `policy` that scopes rows to their ' +
        'owner (typically by matching a `*_id` field against `claims.sub`), or keep `@anonymous` ' +
        'only if the data is genuinely public. Explain the change you make. Keep the app building ' +
        'and do not run `rayfin up` or deploy — Fabricator redeploys automatically.'
      onSendToChat(`Harden access on ${entity.name}`, prompt)
    },
    [onSendToChat]
  )

  const addModel = useCallback((): void => {
    onSendToChat(
      'Add a data model',
      'This Rayfin app has no data model yet. Please add one or more entities under ' +
        '`rayfin/data/` using the `@microsoft/rayfin-core` decorators (`@entity`, field ' +
        'decorators like `@uuid`/`@text`/`@boolean`/`@date`, and `@role`/`@authenticated` with ' +
        'a row-level `policy` for access control), and register them in `rayfin/data/schema.ts`. ',
      true
    )
  }, [onSendToChat])

  if (loading && !model) {
    return (
      <div className="model-view">
        <div className="model-empty">Reading your data model…</div>
      </div>
    )
  }

  if (!model?.hasSchema) {
    return (
      <div className="model-view">
        <div className="model-empty model-empty--cta">
          <div className="model-empty-title">No data model yet</div>
          <p className="model-empty-sub">
            Rayfin entities live under <code>rayfin/data/</code> and are listed in{' '}
            <code>schema.ts</code>. Once you add some, this tab draws them as an entity‑relationship
            diagram with per‑entity access badges.
          </p>
          <button className="btn btn--primary" onClick={addModel}>
            Add a data model with Copilot
          </button>
        </div>
      </div>
    )
  }

  if (model.entities.length === 0) {
    return (
      <div className="model-view">
        <div className="model-empty model-empty--cta">
          <div className="model-empty-title">Your schema has no entities</div>
          <p className="model-empty-sub">
            <code>rayfin/data/schema.ts</code> exists but its <code>schema</code> array is empty.
          </p>
          <button className="btn btn--primary" onClick={addModel}>
            Add an entity with Copilot
          </button>
        </div>
      </div>
    )
  }

  const entityCount = model.entities.length
  const relCount = derived.pairs.length + derived.selfs.length
  const fitTarget = matched ?? renderSet ?? undefined

  const cardDimmed = (name: string): boolean => {
    if (matched && !matched.has(name)) return true
    if (!matched && highlight && name !== highlight && !neighborsOf(highlight).has(name)) return true
    return false
  }
  const edgeMood = (from: string, to: string): 'hot' | 'dim' | '' => {
    if (highlight) return from === highlight || to === highlight ? 'hot' : 'dim'
    if (matched) return matched.has(from) && matched.has(to) ? '' : 'dim'
    return ''
  }

  return (
    <div className="model-view">
      <div className="model-head">
        <div className="model-head-titles">
          <h2 className="model-title">Data model</h2>
          <span className="model-subtitle">
            {entityCount} {entityCount === 1 ? 'entity' : 'entities'}
            {relCount > 0 && ` · ${relCount} ${relCount === 1 ? 'relationship' : 'relationships'}`}
          </span>
        </div>
        <div className="model-legend" aria-hidden="true">
          <span className="model-legend-label">Access</span>
          <span className="model-legend-item">
            <span className="model-legend-dot model-legend-dot--ok" /> Row‑scoped
          </span>
          <span className="model-legend-item">
            <span className="model-legend-dot model-legend-dot--warn" /> Any signed‑in
          </span>
          <span className="model-legend-item">
            <span className="model-legend-dot model-legend-dot--danger" /> Public
          </span>
        </div>
      </div>

      <div className="model-toolbar">
        <div className="model-search">
          <Codicon name="search" className="model-search-ico" />
          <input
            className="model-search-input"
            value={query}
            placeholder="Search entities & fields"
            aria-label="Search entities and fields"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="model-search-clear"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              <Codicon name="close" />
            </button>
          )}
        </div>

        {focus && (
          <button className="model-focus-chip" onClick={() => focusOn(null)}>
            <Codicon name="eye" /> Focusing {focus}
            <Codicon name="close" className="model-focus-chip-x" />
          </button>
        )}

        <button
          className="model-tool-btn"
          onClick={toggleCollapseAll}
          title={collapsedAll ? 'Expand all entities' : 'Collapse all entities'}
        >
          <Codicon name={collapsedAll ? 'expand-all' : 'collapse-all'} />
          {collapsedAll ? 'Expand' : 'Collapse'}
        </button>

        <div className="model-toolbar-spacer" />

        <div className="model-zoom" role="group" aria-label="Zoom">
          <button className="model-zoom-btn" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
            <Codicon name="zoom-out" />
          </button>
          <button
            className="model-zoom-label"
            onClick={() => fitTo(fitTarget)}
            title="Fit to view"
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button className="model-zoom-btn" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
            <Codicon name="zoom-in" />
          </button>
        </div>
        <button className="model-tool-btn" onClick={() => fitTo(fitTarget)} title="Fit to view">
          <Codicon name="screen-full" />
        </button>
        <button className="model-tool-btn" onClick={resetLayout} title="Reset layout">
          <Codicon name="refresh" />
        </button>
      </div>

      <div
        className="model-viewport"
        ref={viewportRef}
        data-panning={panning ? 'true' : undefined}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        <div
          className="model-canvas-inner"
          ref={innerRef}
          style={{
            width: canvas.w || undefined,
            height: canvas.h || undefined,
            transform: `translate(${Math.round(view.tx)}px, ${Math.round(view.ty)}px) scale(${view.scale})`
          }}
        >
          <svg
            className="model-edges"
            width={canvas.w}
            height={canvas.h}
            viewBox={`0 0 ${canvas.w} ${canvas.h}`}
            aria-hidden="true"
          >
            {edges.map((e) => {
              const mood = edgeMood(e.from, e.to)
              const cls = e.dashed ? 'fk' : 'rel'
              return (
                <g key={e.id} className={`model-edge-g${mood ? ` model-edge-g--${mood}` : ''}`}>
                  <path d={e.d} className={`model-edge model-edge--${cls}`} fill="none" />
                  {e.caps.map((c, i) => (
                    <circle
                      key={i}
                      cx={c.x}
                      cy={c.y}
                      r={2.75}
                      className={`model-edge-cap model-edge-cap--${cls}`}
                    />
                  ))}
                </g>
              )
            })}
          </svg>

          {model.entities.filter((e) => isRendered(e.name)).map((entity) => {
            const tone = ACCESS_META[entity.access.level].tone
            const pos = positions.get(entity.name) ?? { x: 0, y: 0 }
            const dim = cardDimmed(entity.name)
            const collapsedCard = isCollapsed(entity.name)
            const linked = neighborsOf(entity.name).size
            return (
              <div
                key={entity.name}
                ref={setCardRef(entity.name)}
                className={`model-card model-card--${tone}${dim ? ' model-card--dim' : ''}${
                  dragging === entity.name ? ' model-card--dragging' : ''
                }${highlight === entity.name ? ' model-card--active' : ''}`}
                style={{ left: pos.x, top: pos.y, width: CARD_WIDTH }}
                onPointerDown={(e) => onCardPointerDown(e, entity.name)}
                onMouseEnter={() => {
                  if (!gesture.current) setHighlight(entity.name)
                }}
                onMouseLeave={() => setHighlight(null)}
              >
                <div className="model-card-head">
                  <button
                    className="model-card-collapse"
                    aria-label={collapsedCard ? 'Expand entity' : 'Collapse entity'}
                    title={collapsedCard ? 'Expand' : 'Collapse'}
                    onClick={() => toggleCard(entity.name)}
                  >
                    <Codicon name={collapsedCard ? 'chevron-right' : 'chevron-down'} />
                  </button>
                  <button
                    className="model-card-name"
                    title={`${entity.access.detail} · Open ${entity.file}`}
                    onClick={() => onOpenFile(entity.file)}
                  >
                    {entity.customName || entity.name}
                  </button>
                  <span
                    className={`model-card-access model-card-access--${tone}`}
                    title={entity.access.detail}
                    aria-label={entity.access.label}
                  />
                </div>

                {collapsedCard ? (
                  <button className="model-card-summary" onClick={() => toggleCard(entity.name)}>
                    {entity.fields.length} {entity.fields.length === 1 ? 'field' : 'fields'}
                    {linked > 0 && ` · ${linked} linked`}
                  </button>
                ) : (
                  <>
                    <ul className="model-fields">
                      {entity.fields.map((field) => {
                        const relTarget =
                          field.relationTo && entityNames.has(field.relationTo)
                            ? field.relationTo
                            : field.fkTo && entityNames.has(field.fkTo)
                              ? field.fkTo
                              : null
                        const typeText = field.relationTo
                          ? `${field.relationTo}${field.relationKind === 'many' ? '[]' : ''}`
                          : typeChip(field).label
                        const required = !field.optional && !field.primaryKey
                        return (
                          <li
                            key={field.name}
                            data-field={field.name}
                            className={`model-field${relTarget ? ' model-field--link' : ''}`}
                            title={relTarget ? `References ${relTarget}` : undefined}
                            onClick={relTarget ? () => setHighlight(relTarget) : undefined}
                          >
                            <span className="model-field-gutter" aria-hidden="true">
                              {field.primaryKey ? (
                                <Codicon
                                  name="key"
                                  className="model-field-icon model-field-icon--pk"
                                  title="Primary key"
                                />
                              ) : relTarget ? (
                                <Codicon
                                  name="link"
                                  className="model-field-icon model-field-icon--fk"
                                  title={`References ${relTarget}`}
                                />
                              ) : (
                                <span className="model-field-icon" />
                              )}
                              <span
                                className={`model-field-req${
                                  required ? '' : ' model-field-req--opt'
                                }${field.unique ? ' model-field-req--uniq' : ''}`}
                                title={`${required ? 'Required' : 'Optional'}${
                                  field.unique ? ' · Unique' : ''
                                }`}
                              />
                            </span>
                            <span className="model-field-name">{field.name}</span>
                            <span className="model-field-type">{typeText}</span>
                          </li>
                        )
                      })}
                      {entity.fields.length === 0 && (
                        <li className="model-field model-field--empty">No fields parsed.</li>
                      )}
                    </ul>

                    <div className="model-card-perms" title="Access grants">
                      {entity.permissions.length === 0 ? (
                        <span className="model-perm model-perm--none">no explicit roles</span>
                      ) : (
                        entity.permissions.map((p, i) => (
                          <span
                            key={`${p.role}-${i}`}
                            className={`model-perm${p.hasPolicy ? ' model-perm--scoped' : ''}`}
                            title={`${p.decorator}: ${p.actions.join(', ')}${
                              p.hasPolicy ? ' (row-level policy)' : ''
                            }`}
                          >
                            {p.role}
                            <span className="model-perm-actions">{p.actions.join('/')}</span>
                            {p.hasPolicy && <span className="model-perm-policy">policy</span>}
                          </span>
                        ))
                      )}
                    </div>
                  </>
                )}

                <div className="model-card-actions">
                  <button className="btn btn--xs btn--ghost" onClick={() => onOpenFile(entity.file)}>
                    Open
                  </button>
                  {needsHardening(entity.access.level) && (
                    <button className="btn btn--xs btn--ghost" onClick={() => hardenEntity(entity)}>
                      Harden
                    </button>
                  )}
                  <button
                    className="btn btn--xs btn--ghost model-card-focus"
                    onClick={() => focusOn(focus === entity.name ? null : entity.name)}
                  >
                    {focus === entity.name ? 'Unfocus' : 'Focus'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {model.warnings.length > 0 && (
        <div className="model-warnings">
          {model.warnings.map((w, i) => (
            <div key={i} className="model-warning">
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
