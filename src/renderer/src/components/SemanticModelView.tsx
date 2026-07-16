import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { SemanticMeasure } from '@shared/ipc'
import { computeLayout, type LayoutEdge, type LayoutNode } from '../model/layout'
import {
  computeEdgeGeometry,
  type AnchorFn,
  type EdgeRender,
  type EndMarker,
  type RectLike
} from '../model/relationships'
import {
  buildSemanticModel,
  deriveSemanticEdges,
  type SemanticEdgeMeta,
  type SemanticModel
} from '../model/semanticModel'
import type { SemanticModelRef } from '../model/fabricConfig'
import { tokenizeDax } from '../model/daxHighlight'
import { getCachedSchema, schemaCacheKey, setCachedSchema } from '../model/schemaCache'
import { useSuppressPreview } from '../overlay'
import { useToast } from '../toast'
import { Codicon } from './icons'

interface Props {
  /** Project id — used to persist manual card positions per project. */
  projectId: string
  /** The active profile's semantic model(s); at least one. */
  models: SemanticModelRef[]
  /** Bumped by the parent when the model may have changed (e.g. after a deploy). */
  refreshKey: number
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

/** A rendered relationship edge plus the markers the geometry engine doesn't keep. */
interface EndMark {
  /** Cap position where the edge meets the card. */
  x: number
  y: number
  /** +1 if the line extends to the right of the cap, -1 if to the left. */
  outX: number
  kind: 'one' | 'many'
}
interface Arrow {
  x: number
  y: number
  angle: number
  both: boolean
}
interface SemEdgeRender extends EdgeRender {
  fromMark?: EndMark
  toMark?: EndMark
  arrow?: Arrow
  active: boolean
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ok'; model: SemanticModel }
  | { status: 'needs-login' }
  | { status: 'needs-az' }
  | { status: 'error'; error: string }

const CARD_WIDTH = 260
const MEASURE_PREVIEW = 10
const MIN_SCALE = 0.3
const MAX_SCALE = 2.2
const DRAG_THRESHOLD = 4
const ROW_H = 26
const STORAGE_PREFIX = 'rayfin.semantic.layout.'
const CROW_LEN = 12
const CROW_SPREAD = 6
const ONE_OFF = 8
const ONE_HALF = 6

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** A compact type chip for a semantic column's data type. */
function columnChip(dataType?: string): { label: string; cls: string } {
  const t = (dataType ?? '').toLowerCase()
  if (!t) return { label: '—', cls: 'semantic-chip--unknown' }
  if (/bool/.test(t)) return { label: 'bool', cls: 'semantic-chip--bool' }
  if (/(date|time)/.test(t)) return { label: 'date', cls: 'semantic-chip--date' }
  if (/int/.test(t)) return { label: 'int', cls: 'semantic-chip--num' }
  if (/(dec|doub|curr|number|money|float)/.test(t))
    return { label: 'decimal', cls: 'semantic-chip--num' }
  if (/(string|text|char)/.test(t)) return { label: 'text', cls: 'semantic-chip--text' }
  if (/binary/.test(t)) return { label: 'binary', cls: 'semantic-chip--blob' }
  return { label: dataType ?? '—', cls: 'semantic-chip--unknown' }
}

function markerKind(m: EndMarker): 'one' | 'many' | null {
  if (m === 'many') return 'many'
  if (m === 'one') return 'one'
  return null
}

/** Rough card height for the initial auto-layout (edges use real measured rects). */
function estimateHeight(table: SemanticModel['tables'][number]): number {
  const head = 40
  const cols = (table.columns.length || 1) * ROW_H
  const shown = Math.min(table.measures.length, MEASURE_PREVIEW)
  const more = table.measures.length > MEASURE_PREVIEW ? ROW_H : 0
  const measures = table.measures.length ? 22 + shown * ROW_H + more : 0
  const foot = table.storageMode || table.description ? 30 : 0
  return head + cols + measures + foot + 10
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

export default function SemanticModelView({ projectId, models, refreshKey }: Props): JSX.Element {
  const [selectedIdx, setSelectedIdx] = useState(0)
  const selected = models[Math.min(selectedIdx, models.length - 1)] ?? models[0]

  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [reauthing, setReauthing] = useState(false)
  const toast = useToast()

  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [measurePopover, setMeasurePopover] = useState<{
    table: string
    measure: SemanticMeasure
  } | null>(null)

  const [positions, setPositions] = useState<Map<string, XY>>(new Map())
  const [view, setView] = useState<ViewT>({ scale: 1, tx: 0, ty: 0 })
  const [edges, setEdges] = useState<SemEdgeRender[]>([])
  const [canvas, setCanvas] = useState({ w: 0, h: 0 })
  const [panning, setPanning] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [redrawTick, setRedrawTick] = useState(0)
  const [collapsedAll, setCollapsedAll] = useState(false)
  const [collapsed, setCollapsed] = useState<Map<string, boolean>>(new Map())
  const [expandedMeasures, setExpandedMeasures] = useState<Set<string>>(new Set())

  const viewportRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())

  const viewRef = useRef(view)
  viewRef.current = view
  const positionsRef = useRef(positions)
  positionsRef.current = positions
  const gesture = useRef<
    | { kind: 'pan'; startX: number; startY: number; tx0: number; ty0: number }
    | {
        kind: 'card'
        name: string
        startX: number
        startY: number
        ox: number
        oy: number
        moved: boolean
      }
    | null
  >(null)
  const fitReq = useRef(false)
  /** Skip one measure pass after replacing positions so cards commit before fitting them. */
  const pendingPositionCommit = useRef(false)
  // Tracks the refresh/reload counters seen by the load effect so it can tell a
  // genuine "fetch fresh" (Refresh button / parent refreshKey bump) apart from a
  // mere remount or selection change, which may be served from the schema cache.
  const loadTicks = useRef({ refreshKey, reloadTick })

  const model = state.status === 'ok' ? state.model : null

  // Load the live schema whenever the selected model, refresh key or an explicit
  // reload changes. Served from a session cache on mount / selection change so
  // toggling Data <-> Semantic (which remounts this view) doesn't re-query Fabric;
  // Refresh and a parent refreshKey bump always fetch fresh and update the cache.
  useEffect(() => {
    if (!selected) return
    const prev = loadTicks.current
    const isRefresh = prev.refreshKey !== refreshKey || prev.reloadTick !== reloadTick
    loadTicks.current = { refreshKey, reloadTick }

    const key = schemaCacheKey(selected.workspaceId, selected.itemId)
    if (!isRefresh) {
      const cached = getCachedSchema(key)
      if (cached) {
        setState({ status: 'ok', model: cached })
        return
      }
    }

    let alive = true
    setState({ status: 'loading' })
    window.api.fabric
      .semanticModelSchema(selected.workspaceId, selected.itemId)
      .then((res) => {
        if (!alive) return
        if (res.ok) {
          const built = buildSemanticModel(res)
          setCachedSchema(key, built)
          setState({ status: 'ok', model: built })
        } else if (res.needsAz) setState({ status: 'needs-az' })
        else if (res.needsLogin) setState({ status: 'needs-login' })
        else setState({ status: 'error', error: res.error || 'Could not read the semantic model.' })
      })
      .catch((err) => {
        if (alive) setState({ status: 'error', error: String(err) })
      })
    return () => {
      alive = false
    }
  }, [selected, refreshKey, reloadTick])

  const { derived, meta } = useMemo(
    () =>
      model
        ? deriveSemanticEdges(model.relationships)
        : { derived: { pairs: [], selfs: [] }, meta: new Map<string, SemanticEdgeMeta>() },
    [model]
  )
  const metaRef = useRef(meta)
  metaRef.current = meta

  // Undirected neighbour map for hover highlighting.
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    const add = (a: string, b: string): void => {
      if (!m.has(a)) m.set(a, new Set())
      m.get(a)!.add(b)
    }
    for (const r of model?.relationships ?? []) {
      if (r.fromTable && r.toTable && r.fromTable !== r.toTable) {
        add(r.fromTable, r.toTable)
        add(r.toTable, r.fromTable)
      }
    }
    return m
  }, [model])

  // Sticky click-to-focus: isolate a table and its direct relationships. When set,
  // only the focus table and its neighbours render (others are removed from the DOM,
  // like the Rayfin data-model view), and the layout refits to that neighbourhood.
  const renderSet = useMemo<ReadonlySet<string> | null>(() => {
    if (!model || !focus) return null
    const s = new Set<string>([focus])
    for (const n of neighbors.get(focus) ?? []) s.add(n)
    return s
  }, [model, focus, neighbors])
  const isRendered = useCallback(
    (name: string): boolean => !renderSet || renderSet.has(name),
    [renderSet]
  )
  const focusOn = useCallback((name: string | null): void => {
    setFocus(name)
    setHighlight(null)
    fitReq.current = true
  }, [])

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const s = new Set<string>()
    for (const t of model?.tables ?? []) {
      const hit =
        t.name.toLowerCase().includes(q) ||
        t.columns.some((c) => (c.name ?? '').toLowerCase().includes(q)) ||
        t.measures.some((mm) => (mm.name ?? '').toLowerCase().includes(q))
      if (hit) s.add(t.name)
    }
    return s
  }, [model, query])

  const buildPositions = useCallback(
    (m: SemanticModel, useStored: boolean): Map<string, XY> => {
      const nodes: LayoutNode[] = m.tables.map((t) => ({
        id: t.name,
        width: CARD_WIDTH,
        height: estimateHeight(t)
      }))
      const layoutEdges: LayoutEdge[] = m.relationships
        .filter((r) => r.fromTable && r.toTable)
        .map((r) => ({ from: r.fromTable!, to: r.toTable! }))
      const vp = viewportRef.current
      const targetAspect =
        vp && vp.clientWidth > 0 && vp.clientHeight > 0
          ? Math.min(2.6, Math.max(1.3, vp.clientWidth / vp.clientHeight))
          : undefined
      const auto = computeLayout(nodes, layoutEdges, { targetAspect }).positions
      const stored = useStored ? loadStoredPositions(projectId) : {}
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
    [projectId]
  )

  useLayoutEffect(() => {
    if (!model) return
    pendingPositionCommit.current = true
    setPositions(buildPositions(model, true))
    setQuery('')
    setHighlight(null)
    setFocus(null)
    setCollapsed(new Map())
    setCollapsedAll(false)
    setExpandedMeasures(new Set())
    fitReq.current = true
  }, [model, buildPositions])

  const persistPositions = useCallback((): void => {
    const obj: Record<string, XY> = {}
    positionsRef.current.forEach((p, name) => {
      obj[name] = { x: Math.round(p.x), y: Math.round(p.y) }
    })
    try {
      localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(obj))
    } catch {
      /* best-effort */
    }
  }, [projectId])

  const isCollapsed = useCallback(
    (name: string): boolean => (collapsed.has(name) ? collapsed.get(name)! : collapsedAll),
    [collapsed, collapsedAll]
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

  const toggleMeasures = useCallback((name: string): void => {
    setExpandedMeasures((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const setCardRef = useCallback(
    (name: string) =>
      (el: HTMLDivElement | null): void => {
        if (el) cardRefs.current.set(name, el)
        else cardRefs.current.delete(name)
      },
    []
  )

  const fitTo = useCallback((): void => {
    const vp = viewportRef.current
    if (!vp) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    cardRefs.current.forEach((el) => {
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

  // Measure card rects, recompute edges (+ their glyphs) and canvas bounds.
  useLayoutEffect(() => {
    if (!model) return
    if (pendingPositionCommit.current) {
      pendingPositionCommit.current = false
      return
    }
    const rectOf = (name: string): RectLike | null => {
      const el = cardRefs.current.get(name)
      if (!el) return null
      return {
        left: el.offsetLeft,
        top: el.offsetTop,
        width: el.offsetWidth,
        height: el.offsetHeight
      }
    }
    const firstKey = (table: string): string | undefined => {
      const t = model.tables.find((x) => x.name === table)
      return t?.columns.find((c) => c.isKey)?.name ?? t?.columns[0]?.name
    }
    // Column names can contain spaces/punctuation, so match by dataset value
    // rather than interpolating into a CSS attribute selector.
    const anchorY: AnchorFn = (entity, via) => {
      const el = cardRefs.current.get(entity)
      if (!el) return null
      const field = via ?? firstKey(entity)
      if (!field) return null
      const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-field]'))
      const row = rows.find((r) => r.dataset.field === field)
      if (!row) return null
      return el.offsetTop + row.offsetTop + row.offsetHeight / 2
    }

    const obstacles: RectLike[] = []
    cardRefs.current.forEach((el) => {
      obstacles.push({
        left: el.offsetLeft,
        top: el.offsetTop,
        width: el.offsetWidth,
        height: el.offsetHeight
      })
    })

    const raw = computeEdgeGeometry(derived, rectOf, anchorY, { obstacles })
    const augmented: SemEdgeRender[] = raw.map((e) => {
      const m = metaRef.current.get(e.id)
      const c0 = e.caps[0]
      const cN = e.caps[e.caps.length - 1]
      const rFrom = rectOf(e.from)
      const rTo = rectOf(e.to)
      const sideOf = (cap: { x: number }, r: RectLike | null): 'left' | 'right' =>
        r && cap.x >= r.left + r.width / 2 ? 'right' : 'left'
      const mark = (
        cap: { x: number; y: number },
        side: 'left' | 'right',
        mk?: EndMarker
      ): EndMark | undefined => {
        const kind = markerKind(mk ?? 'none')
        if (!kind) return undefined
        return { x: cap.x, y: cap.y, outX: side === 'right' ? 1 : -1, kind }
      }
      const fromMark = c0 ? mark(c0, sideOf(c0, rFrom), m?.fromMarker) : undefined
      const toMark = cN ? mark(cN, sideOf(cN, rTo), m?.toMarker) : undefined

      let arrow: Arrow | undefined
      if (m && m.crossFilter !== 'none' && c0 && cN) {
        const manyCap = m.fromMarker === 'many' ? c0 : m.toMarker === 'many' ? cN : cN
        // The routed midAngle points from → to (c0 → cN). The cross-filter arrow
        // points one → many, so keep it when the many end is the `to` cap (cN)
        // and flip it by π when the many end is the `from` cap (c0).
        const angle = manyCap === cN ? e.midAngle : e.midAngle + Math.PI
        arrow = {
          x: e.mx,
          y: e.my,
          angle,
          both: m.crossFilter === 'both'
        }
      }
      return { ...e, fromMark, toMark, arrow, active: m?.active ?? true }
    })
    setEdges(augmented)

    let maxRight = 0
    let maxBottom = 0
    cardRefs.current.forEach((el) => {
      maxRight = Math.max(maxRight, el.offsetLeft + el.offsetWidth)
      maxBottom = Math.max(maxBottom, el.offsetTop + el.offsetHeight)
    })
    setCanvas({ w: maxRight + 80, h: maxBottom + 80 })

    if (fitReq.current) {
      fitReq.current = false
      fitTo()
    }
  }, [
    model,
    derived,
    positions,
    collapsed,
    collapsedAll,
    expandedMeasures,
    renderSet,
    redrawTick,
    fitTo
  ])

  // Web fonts load lazily; re-measure once ready so edges stay aligned.
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

  // Cursor-anchored wheel zoom (non-passive).
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
  }, [model])

  const onBackgroundPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    setMeasurePopover(null)
    const v = viewRef.current
    gesture.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx0: v.tx, ty0: v.ty }
    viewportRef.current?.setPointerCapture(e.pointerId)
    setPanning(true)
  }, [])

  const onCardPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, name: string): void => {
      e.stopPropagation()
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
      setView((v) => ({
        ...v,
        tx: g.tx0 + (e.clientX - g.startX),
        ty: g.ty0 + (e.clientY - g.startY)
      }))
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
        /* already released */
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

  const signInAndReload = useCallback(async (): Promise<void> => {
    setReauthing(true)
    try {
      const res = await window.api.auth.loginRayfin()
      if (res.ok) setReloadTick((n) => n + 1)
      else
        toast.error(res.error ?? 'Fabric sign-in did not complete. Please try again.', {
          title: 'Sign-in failed'
        })
    } finally {
      setReauthing(false)
    }
  }, [toast])

  const signInAzAndReload = useCallback(async (): Promise<void> => {
    setReauthing(true)
    try {
      const res = await window.api.auth.loginAz()
      if (res.ok) setReloadTick((n) => n + 1)
      else
        toast.error(res.error ?? 'Azure sign-in did not complete. Please try again.', {
          title: 'Sign-in failed'
        })
    } finally {
      setReauthing(false)
    }
  }, [toast])

  const openMeasure = useCallback(
    (_e: ReactMouseEvent<HTMLButtonElement>, table: string, measure: SemanticMeasure): void => {
      setMeasurePopover({ table, measure })
    },
    []
  )

  useSuppressPreview(!!measurePopover)

  // Close the DAX dialog on Escape.
  useEffect(() => {
    if (!measurePopover) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMeasurePopover(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [measurePopover])

  // -- Render states ---------------------------------------------------------

  const picker =
    models.length > 1 ? (
      <div className="semantic-model-picker" role="group" aria-label="Semantic model">
        {models.map((m, i) => (
          <button
            key={`${m.workspaceId}:${m.itemId}`}
            className={`seg-btn${i === selectedIdx ? ' seg-btn--active' : ''}`}
            onClick={() => setSelectedIdx(i)}
          >
            {m.alias}
          </button>
        ))}
      </div>
    ) : null

  if (state.status === 'loading') {
    return (
      <div className="semantic-view">
        <div className="semantic-empty">Reading your semantic model…</div>
      </div>
    )
  }

  if (state.status === 'needs-login') {
    return (
      <div className="semantic-view">
        <div className="semantic-empty semantic-empty--cta">
          <div className="semantic-empty-title">Sign in to view the semantic model</div>
          <p className="semantic-empty-sub">
            The semantic model is read live from Fabric, so you need an active Fabric session.
          </p>
          <button
            className="btn btn--primary"
            disabled={reauthing}
            onClick={() => void signInAndReload()}
          >
            {reauthing ? 'Signing in…' : 'Sign in to Fabric'}
          </button>
        </div>
      </div>
    )
  }

  if (state.status === 'needs-az') {
    return (
      <div className="semantic-view">
        <div className="semantic-empty semantic-empty--cta">
          <div className="semantic-empty-title">Sign in to Azure to view the semantic model</div>
          <p className="semantic-empty-sub">
            The semantic model’s schema is read live from Fabric using your Azure CLI session. Sign
            in with <code>az login</code> to continue.
          </p>
          <button
            className="btn btn--primary"
            disabled={reauthing}
            onClick={() => void signInAzAndReload()}
          >
            {reauthing ? 'Signing in…' : 'Sign in to Azure'}
          </button>
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="semantic-view">
        <div className="semantic-empty semantic-empty--cta">
          <div className="semantic-empty-title">Couldn’t read the semantic model</div>
          <p className="semantic-empty-sub">{state.error}</p>
          <button className="btn btn--primary" onClick={() => setReloadTick((n) => n + 1)}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (!model || !model.hasModel) {
    return (
      <div className="semantic-view">
        <div className="semantic-empty semantic-empty--cta">
          <div className="semantic-empty-title">This semantic model has no tables</div>
          <p className="semantic-empty-sub">
            The connected model returned no tables. It may still be loading data in Fabric.
          </p>
          <button className="btn btn--primary" onClick={() => setReloadTick((n) => n + 1)}>
            Refresh
          </button>
        </div>
      </div>
    )
  }

  const tableCount = model.tables.length
  const relCount = derived.pairs.length + derived.selfs.length

  const cardDimmed = (name: string): boolean => {
    if (matched && !matched.has(name)) return true
    if (
      !matched &&
      highlight &&
      name !== highlight &&
      !(neighbors.get(highlight)?.has(name) ?? false)
    )
      return true
    return false
  }
  const edgeMood = (from: string, to: string): 'hot' | 'dim' | '' => {
    if (highlight) return from === highlight || to === highlight ? 'hot' : 'dim'
    if (matched) return matched.has(from) && matched.has(to) ? '' : 'dim'
    return ''
  }

  return (
    <div className="semantic-view">
      <div className="model-head">
        <div className="model-head-titles">
          <h2 className="model-title">Semantic model</h2>
          <span className="model-subtitle">
            {tableCount} {tableCount === 1 ? 'table' : 'tables'}
            {relCount > 0 && ` · ${relCount} ${relCount === 1 ? 'relationship' : 'relationships'}`}
          </span>
        </div>
        <div className="model-legend" aria-hidden="true">
          <span className="model-legend-item">
            <svg className="semantic-legend-mark" viewBox="0 0 24 14" width="24" height="14">
              <path d="M2,7 H22 M7,2 V12" />
            </svg>
            one
          </span>
          <span className="model-legend-item">
            <svg className="semantic-legend-mark" viewBox="0 0 24 14" width="24" height="14">
              <path d="M2,7 H22 M22,7 L10,2 M22,7 L10,12" />
            </svg>
            many
          </span>
          <span className="model-legend-item">
            <span className="semantic-legend-dash" /> inactive
          </span>
        </div>
      </div>

      <div className="model-toolbar">
        <div className="model-search">
          <Codicon name="search" className="model-search-ico" />
          <input
            className="model-search-input"
            value={query}
            placeholder="Search tables, columns & measures"
            aria-label="Search tables, columns and measures"
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
          <button className="model-focus-chip" onClick={() => focusOn(null)} title="Clear focus">
            <Codicon name="eye" /> Focusing {focus}
            <Codicon name="close" className="model-focus-chip-x" />
          </button>
        )}

        {picker}

        <button
          className="model-tool-btn"
          onClick={toggleCollapseAll}
          title={collapsedAll ? 'Expand all tables' : 'Collapse all tables'}
        >
          <Codicon name={collapsedAll ? 'expand-all' : 'collapse-all'} />
          {collapsedAll ? 'Expand' : 'Collapse'}
        </button>

        <div className="model-toolbar-spacer" />

        <div className="model-zoom" role="group" aria-label="Zoom">
          <button className="model-zoom-btn" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
            <Codicon name="zoom-out" />
          </button>
          <button className="model-zoom-label" onClick={() => fitTo()} title="Fit to view">
            {Math.round(view.scale * 100)}%
          </button>
          <button className="model-zoom-btn" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
            <Codicon name="zoom-in" />
          </button>
        </div>
        <button className="model-tool-btn" onClick={() => fitTo()} title="Fit to view">
          <Codicon name="screen-full" />
        </button>
        <button
          className="model-tool-btn"
          onClick={() => setReloadTick((n) => n + 1)}
          title="Refresh from Fabric"
        >
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
              const cls = e.active ? 'rel' : 'fk'
              return (
                <g key={e.id} className={`model-edge-g${mood ? ` model-edge-g--${mood}` : ''}`}>
                  <path d={e.d} className={`model-edge model-edge--${cls}`} fill="none" />
                  {e.caps.map((c, i) => {
                    const isFrom = i === 0
                    const isTo = i === e.caps.length - 1
                    // The crow's-foot / one-bar marker already anchors these ends.
                    if ((isFrom && e.fromMark) || (isTo && e.toMark)) return null
                    return (
                      <circle
                        key={i}
                        cx={c.x}
                        cy={c.y}
                        r={2.75}
                        className={`model-edge-cap model-edge-cap--${cls}`}
                      />
                    )
                  })}
                  {e.arrow && (
                    <g
                      className="semantic-edge-arrow"
                      transform={`translate(${e.arrow.x} ${e.arrow.y}) rotate(${(e.arrow.angle * 180) / Math.PI})`}
                    >
                      <path d="M7,0 L-6,-5 L-6,5 Z" />
                      {e.arrow.both && <path d="M-7,0 L6,-5 L6,5 Z" />}
                    </g>
                  )}
                  {e.fromMark && <CrowMark m={e.fromMark} />}
                  {e.toMark && <CrowMark m={e.toMark} />}
                </g>
              )
            })}
          </svg>

          {model.tables
            .filter((table) => isRendered(table.name))
            .map((table) => {
              const pos = positions.get(table.name) ?? { x: 0, y: 0 }
              const dim = cardDimmed(table.name)
              const collapsedCard = isCollapsed(table.name)
              const measuresExpanded = expandedMeasures.has(table.name)
              const shownMeasures = measuresExpanded
                ? table.measures
                : table.measures.slice(0, MEASURE_PREVIEW)
              return (
                <div
                  key={table.name}
                  ref={setCardRef(table.name)}
                  className={`semantic-card${dim ? ' semantic-card--dim' : ''}${
                    dragging === table.name ? ' semantic-card--dragging' : ''
                  }${highlight === table.name ? ' semantic-card--active' : ''}${
                    table.isHidden ? ' semantic-card--hidden' : ''
                  }`}
                  style={{ left: pos.x, top: pos.y, width: CARD_WIDTH }}
                  onPointerDown={(e) => onCardPointerDown(e, table.name)}
                  onMouseEnter={() => {
                    if (!gesture.current) setHighlight(table.name)
                  }}
                  onMouseLeave={() => setHighlight(null)}
                >
                  <div className="semantic-card-head" title={table.description}>
                    <button
                      className="semantic-card-collapse"
                      aria-label={collapsedCard ? 'Expand table' : 'Collapse table'}
                      title={collapsedCard ? 'Expand' : 'Collapse'}
                      onClick={() => toggleCard(table.name)}
                    >
                      <Codicon name={collapsedCard ? 'chevron-right' : 'chevron-down'} />
                    </button>
                    <Codicon name="table" className="semantic-card-ico" />
                    <span className="semantic-card-name">{table.name}</span>
                    {table.isHidden && <span className="semantic-card-badge">hidden</span>}
                    <button
                      className="semantic-card-focus"
                      data-no-drag
                      aria-label={focus === table.name ? 'Clear focus' : 'Focus this table'}
                      title={focus === table.name ? 'Clear focus' : 'Focus neighbourhood'}
                      onClick={(e) => {
                        e.stopPropagation()
                        focusOn(focus === table.name ? null : table.name)
                      }}
                    >
                      <Codicon name={focus === table.name ? 'eye-closed' : 'eye'} />
                    </button>
                  </div>

                  {collapsedCard ? (
                    <button
                      className="semantic-card-summary"
                      onClick={() => toggleCard(table.name)}
                    >
                      {table.columns.length} {table.columns.length === 1 ? 'column' : 'columns'}
                      {table.measures.length > 0 &&
                        ` · ${table.measures.length} ${
                          table.measures.length === 1 ? 'measure' : 'measures'
                        }`}
                    </button>
                  ) : (
                    <>
                      <ul className="semantic-fields">
                        {table.columns.map((col) => {
                          const chip = columnChip(col.dataType)
                          return (
                            <li
                              key={col.name}
                              data-field={col.name}
                              className={`semantic-field${col.isHidden ? ' semantic-field--hidden' : ''}`}
                              title={
                                col.expression ? `Calculated: ${col.expression}` : col.dataType
                              }
                            >
                              <span className="semantic-field-gutter" aria-hidden="true">
                                {col.isKey ? (
                                  <Codicon
                                    name="key"
                                    className="semantic-field-ico semantic-field-ico--pk"
                                  />
                                ) : (
                                  <span className="semantic-field-ico" />
                                )}
                              </span>
                              <span className="semantic-field-name">{col.name}</span>
                              <span className={`semantic-chip ${chip.cls}`}>{chip.label}</span>
                            </li>
                          )
                        })}
                        {table.columns.length === 0 && (
                          <li className="semantic-field semantic-field--empty">No columns.</li>
                        )}
                      </ul>

                      {table.measures.length > 0 && (
                        <div className="semantic-measures">
                          <div className="semantic-measures-head">
                            Measures{' '}
                            <span className="semantic-measures-count">{table.measures.length}</span>
                          </div>
                          {shownMeasures.map((m) => (
                            <button
                              key={m.name}
                              className="semantic-measure"
                              data-no-drag
                              title="Show DAX"
                              onClick={(e) => openMeasure(e, table.name, m)}
                            >
                              <span className="semantic-measure-fx" aria-hidden="true">
                                fx
                              </span>
                              <span className="semantic-measure-name">{m.name}</span>
                            </button>
                          ))}
                          {table.measures.length > MEASURE_PREVIEW && (
                            <button
                              className="semantic-measure-more"
                              data-no-drag
                              onClick={() => toggleMeasures(table.name)}
                            >
                              {measuresExpanded
                                ? 'Show fewer'
                                : `Show all ${table.measures.length}`}
                            </button>
                          )}
                        </div>
                      )}

                      {(table.storageMode || table.description) && (
                        <div className="semantic-card-foot">
                          {table.storageMode && (
                            <span
                              className="semantic-foot-mode"
                              title={`Storage mode: ${table.storageMode}`}
                            >
                              {table.storageMode}
                            </span>
                          )}
                          {table.description && (
                            <span className="semantic-foot-desc" title={table.description}>
                              {table.description}
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )
            })}
        </div>
      </div>

      {measurePopover && (
        <div className="semantic-popover-scrim" onClick={() => setMeasurePopover(null)}>
          <div
            className="semantic-popover"
            role="dialog"
            aria-modal="true"
            aria-label={`DAX for ${measurePopover.measure.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="semantic-popover-head">
              <span className="semantic-measure-fx" aria-hidden="true">
                fx
              </span>
              <span className="semantic-popover-title">{measurePopover.measure.name}</span>
              <button
                className="semantic-popover-close"
                aria-label="Close"
                onClick={() => setMeasurePopover(null)}
              >
                <Codicon name="close" />
              </button>
            </div>
            <div className="semantic-popover-body">
              {(measurePopover.measure.displayFolder || measurePopover.measure.formatString) && (
                <div className="semantic-popover-meta">
                  {measurePopover.measure.formatString && (
                    <span
                      className="semantic-meta-chip"
                      title="Format string — how this measure's value is displayed"
                    >
                      <span className="semantic-meta-key">Format</span>
                      <code>{measurePopover.measure.formatString}</code>
                    </span>
                  )}
                  {measurePopover.measure.displayFolder && (
                    <span className="semantic-meta-chip" title="Display folder in the model">
                      <span className="semantic-meta-key">Folder</span>
                      {measurePopover.measure.displayFolder}
                    </span>
                  )}
                </div>
              )}
              {measurePopover.measure.description && (
                <div className="semantic-popover-section">
                  <div className="semantic-popover-caption">Description</div>
                  <p className="semantic-popover-desc">{measurePopover.measure.description}</p>
                </div>
              )}
              <div className="semantic-popover-section">
                <div className="semantic-popover-caption">DAX</div>
                <pre className="semantic-popover-dax">
                  <DaxCode source={measurePopover.measure.expression} />
                </pre>
              </div>
            </div>
            {measurePopover.measure.expression && (
              <div className="semantic-popover-actions">
                <button
                  className="btn btn--xs btn--ghost"
                  onClick={() =>
                    void navigator.clipboard?.writeText(measurePopover.measure.expression ?? '')
                  }
                >
                  Copy DAX
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Draw a crow's-foot (many) or single-bar (one) cardinality marker at an edge end. */
function CrowMark({ m }: { m: EndMark }): JSX.Element {
  if (m.kind === 'many') {
    const apexX = m.x + m.outX * CROW_LEN
    return (
      <path
        className="semantic-crow"
        d={`M${m.x},${m.y - CROW_SPREAD} L${apexX},${m.y} L${m.x},${m.y + CROW_SPREAD}`}
      />
    )
  }
  const bx = m.x + m.outX * ONE_OFF
  return <line className="semantic-one" x1={bx} y1={m.y - ONE_HALF} x2={bx} y2={m.y + ONE_HALF} />
}

/** Render a DAX expression with lightweight syntax highlighting. */
function DaxCode({ source }: { source?: string }): JSX.Element {
  const src = source?.trim()
  if (!src) return <span className="dax-text">No DAX expression available.</span>
  const tokens = tokenizeDax(src)
  return (
    <>
      {tokens.map((t, i) =>
        t.kind === 'text' ? (
          <span key={i}>{t.text}</span>
        ) : (
          <span key={i} className={`dax-${t.kind}`}>
            {t.text}
          </span>
        )
      )}
    </>
  )
}
