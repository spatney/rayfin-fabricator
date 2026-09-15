/**
 * Turns the raw, redundant relation list from `parseSchema` into a clean
 * entity-relationship model and the SVG geometry the Model view draws.
 *
 * `parseSchema` reports every *directed* link it can find, which means a single
 * logical relationship shows up two or three times:
 *
 *   - the `*_id` convention foreign key (e.g. `DealTag.tag_id -> Tag`, kind `fk`),
 *   - the explicit `@one` relation that column backs (`DealTag.tag -> Tag`), and
 *   - the inverse `@many` on the other side (`Tag.dealTags -> DealTag`).
 *
 * Drawn literally that is three overlapping curves with three labels stacked on
 * top of each other. Here we collapse those into ONE undirected relationship
 * with a cardinality marker at each end (crow's-foot for "many", a bar for
 * "one"), which is what a real ER diagram shows.
 *
 * Everything in this module is pure and deterministic so it can be unit-tested
 * (and snapshot-tested) without a DOM.
 */
import type { ModelRelation } from './parseSchema'
import { inflateRect, routeOrthogonal, segmentHitsRect } from './router'

export type EndMarker = 'many' | 'one' | 'none'

/** A single de-duplicated relationship between two distinct entities. */
export interface RelEdge {
  id: string
  /** Endpoints in a stable (sorted) order so geometry is deterministic. */
  a: string
  b: string
  /** Cardinality at `a`'s end — how many `a` relate to one `b`. */
  aMarker: EndMarker
  /** Cardinality at `b`'s end — how many `b` relate to one `a`. */
  bMarker: EndMarker
  /** Field on `a` that references `b` (if any). */
  aVia?: string
  /** Field on `b` that references `a` (if any). */
  bVia?: string
  /** True when the link is only a naming-convention fk (drawn dashed). */
  dashed: boolean
  /** Compact human label, e.g. `tag · dealTags`. */
  label: string
}

/** A self-referencing relationship (an entity pointing at itself). */
export interface SelfEdge {
  id: string
  entity: string
  via: string
  many: boolean
}

export interface DerivedEdges {
  pairs: RelEdge[]
  selfs: SelfEdge[]
}

/** `tag_id` → `tag`, `ownerId` → `owner`; leaves non-fk names untouched. */
function baseName(via: string): string {
  return via.replace(/_?id$/i, '') || via
}

const PAIR_SEP = '\u0000'

/**
 * Collapse the raw directed relations into de-duplicated relationships.
 *
 * Rules:
 *  1. A convention fk (`x_id`) is dropped when an explicit relation on the same
 *     entity, in the same direction, is named after it (`x`) — the fk merely
 *     backs that relation, it isn't a separate link.
 *  2. Opposite-direction links between the same pair are merged into one
 *     undirected relationship, carrying the cardinality from each side.
 *  3. Genuinely distinct links between the same pair (e.g. `sender_id` and
 *     `recipient_id`, both → User, with no inverse) stay as separate edges.
 */
export function deriveRelationEdges(relations: readonly ModelRelation[]): DerivedEdges {
  const selfs: SelfEdge[] = []
  const directed: ModelRelation[] = []
  for (const r of relations) {
    if (r.from === r.to) {
      selfs.push({
        id: `${r.from}.${r.via}@self`,
        entity: r.from,
        via: r.via,
        many: r.kind === 'many'
      })
    } else {
      directed.push(r)
    }
  }

  // Rule 1: index explicit relation field names per direction so we can drop the
  // raw fk column that merely backs one of them.
  const explicitVias = new Map<string, Set<string>>()
  for (const r of directed) {
    if (!r.explicit) continue
    const key = `${r.from}${PAIR_SEP}${r.to}`
    let set = explicitVias.get(key)
    if (!set) explicitVias.set(key, (set = new Set()))
    set.add(r.via)
  }
  const kept = directed.filter((r) => {
    if (r.kind !== 'fk') return true
    const vias = explicitVias.get(`${r.from}${PAIR_SEP}${r.to}`)
    return !(vias && vias.has(baseName(r.via)))
  })

  // Group by unordered pair, split into the two canonical directions.
  interface Bucket {
    a: string
    b: string
    fwd: ModelRelation[] // a -> b
    bwd: ModelRelation[] // b -> a
  }
  const buckets = new Map<string, Bucket>()
  for (const r of kept) {
    const [a, b] = r.from < r.to ? [r.from, r.to] : [r.to, r.from]
    const key = `${a}${PAIR_SEP}${b}`
    let bucket = buckets.get(key)
    if (!bucket) buckets.set(key, (bucket = { a, b, fwd: [], bwd: [] }))
    if (r.from === a) bucket.fwd.push(r)
    else bucket.bwd.push(r)
  }

  const markerOf = (r?: ModelRelation): EndMarker =>
    !r ? 'none' : r.kind === 'many' ? 'many' : 'one'

  const pairs: RelEdge[] = []
  for (const key of [...buckets.keys()].sort()) {
    const bucket = buckets.get(key)!
    const { a, b } = bucket
    const fwd = [...bucket.fwd].sort((x, y) => (x.via < y.via ? -1 : x.via > y.via ? 1 : 0))
    const bwd = [...bucket.bwd].sort((x, y) => (x.via < y.via ? -1 : x.via > y.via ? 1 : 0))
    const n = Math.max(fwd.length, bwd.length)
    for (let i = 0; i < n; i++) {
      const f = fwd[i] // a -> b (field lives on a)
      const g = bwd[i] // b -> a (field lives on b)
      if (!f && !g) continue
      const aVia = f?.via
      const bVia = g?.via
      const label = [aVia, bVia].filter(Boolean).join(' · ')
      pairs.push({
        id: `${key}#${i}`,
        a,
        b,
        // `b`'s end reflects how many `b` per `a` → comes from the a→b link.
        bMarker: markerOf(f),
        // `a`'s end reflects how many `a` per `b` → comes from the b→a link.
        aMarker: markerOf(g),
        aVia,
        bVia,
        dashed: (!f || f.kind === 'fk') && (!g || g.kind === 'fk'),
        label
      })
    }
  }

  return { pairs, selfs }
}

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface Pt {
  x: number
  y: number
}

const fmt = (n: number): string => n.toFixed(1)
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

/** React Flow's `borderRadius` (corner rounding) and `offset` (handle stub). */
const CORNER = 9
const HANDLE_GAP = 20

/**
 * One rounded corner of an orthogonal ("smooth step") path — a direct port of
 * React Flow's `getBend`: run up to the corner `b`, then a quadratic through it.
 * This is the routing the Supabase schema visualizer uses: dashed right-angle
 * "elbow" lines connecting specific field rows, which reads far cleaner than
 * free-floating curves between card centres.
 */
function bend(a: Pt, b: Pt, c: Pt, radius: number): string {
  const size = Math.min(dist(a, b) / 2, dist(b, c) / 2, radius)
  const { x, y } = b
  if ((a.x === x && x === c.x) || (a.y === y && y === c.y)) return `L ${fmt(x)} ${fmt(y)}`
  if (a.y === y) {
    const xDir = a.x < c.x ? -1 : 1
    const yDir = a.y < c.y ? 1 : -1
    return `L ${fmt(x + size * xDir)} ${fmt(y)} Q ${fmt(x)} ${fmt(y)} ${fmt(x)} ${fmt(y + size * yDir)}`
  }
  const xDir = a.x < c.x ? 1 : -1
  const yDir = a.y < c.y ? -1 : 1
  return `L ${fmt(x)} ${fmt(y + size * yDir)} Q ${fmt(x)} ${fmt(y)} ${fmt(x + size * xDir)} ${fmt(y)}`
}

/** Assemble a rounded orthogonal path through `points` (first is the `M` anchor). */
function stepPath(points: Pt[], radius: number): string {
  let d = ''
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (i > 0 && i < points.length - 1) d += bend(points[i - 1], p, points[i + 1], radius) + ' '
    else d += `${i === 0 ? 'M' : 'L'} ${fmt(p.x)} ${fmt(p.y)} `
  }
  return d.trim()
}

export type Side = 'left' | 'right'

/**
 * Waypoints of a horizontal smooth-step edge between two side handles, ported
 * from React Flow's `getPoints` for the Left/Right case (the only orientation we
 * use — cards connect side to side). Produces the vertical channel when the
 * handles face each other, and the outward detour when the target sits behind
 * the source, so the line never cuts back through a card.
 */
function stepPoints(
  source: Pt,
  sourceSide: Side,
  target: Pt,
  targetSide: Side,
  offset: number
): Pt[] {
  const sd = sourceSide === 'right' ? 1 : -1
  const td = targetSide === 'right' ? 1 : -1
  const sGap = { x: source.x + sd * offset, y: source.y }
  const tGap = { x: target.x + td * offset, y: target.y }
  // React Flow anchors the bend at the midpoint of the *gapped* points.
  const centerX = (sGap.x + tGap.x) / 2
  const centerY = (sGap.y + tGap.y) / 2
  const currDir = sGap.x < tGap.x ? 1 : -1
  let mid: Pt[]
  if (sd * td === -1) {
    mid =
      sd === currDir
        ? [
            { x: centerX, y: sGap.y },
            { x: centerX, y: tGap.y }
          ]
        : [
            { x: sGap.x, y: centerY },
            { x: tGap.x, y: centerY }
          ]
  } else {
    const x = sd === 1 ? Math.max(sGap.x, tGap.x) : Math.min(sGap.x, tGap.x)
    mid = [
      { x, y: sGap.y },
      { x, y: tGap.y }
    ]
  }
  return [source, sGap, ...mid, tGap, target]
}

/** A fully positioned edge ready to render as SVG. */
export interface EdgeRender {
  id: string
  /** The orthogonal smooth-step path. */
  d: string
  /** Small connector dots at each endpoint (where the line meets a field row). */
  caps: Pt[]
  dashed: boolean
  label: string
  from: string
  to: string
  self: boolean
  /** Label anchor (unused by the renderer today; kept for tests / future use). */
  mx: number
  my: number
  /**
   * Local tangent angle (radians) of the routed path at its arc-length midpoint,
   * pointing in the direction of travel (from → to). Lets a cross-filter arrow
   * sit ON the elbow and align with it, instead of floating at the straight-line
   * midpoint with an endpoint-to-endpoint angle.
   */
  midAngle: number
}

/**
 * Arc-length midpoint of a polyline plus the local tangent angle there, in the
 * direction of travel (`points[0]` → last). Used to anchor a cross-filter arrow
 * ON the routed elbow rather than at the straight-line midpoint (which floats
 * off orthogonal / re-routed paths).
 */
function polyMid(points: Pt[]): { x: number; y: number; angle: number } {
  if (points.length === 0) return { x: 0, y: 0, angle: 0 }
  if (points.length === 1) return { x: points[0].x, y: points[0].y, angle: 0 }
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  const half = total / 2
  let acc = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const seg = Math.hypot(b.x - a.x, b.y - a.y)
    if (seg === 0) continue
    if (acc + seg >= half) {
      const t = (half - acc) / seg
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) }
    }
    acc += seg
  }
  const last = points[points.length - 1]
  const prev = points[points.length - 2]
  return { x: last.x, y: last.y, angle: Math.atan2(last.y - prev.y, last.x - prev.x) }
}

const LANE_GAP = 26

/** Default gap kept between a routed edge and any card it bends around. */
const EDGE_CLEARANCE = 14

/**
 * Resolves the absolute vertical centre of the field row an edge should attach
 * to (the `via` field, else the entity's primary-key row). Returns `null` when
 * the row can't be measured (e.g. a collapsed card) so the caller falls back to
 * the card centre.
 */
export type AnchorFn = (entity: string, via?: string) => number | null

/** Tunables for {@link computeEdgeGeometry}. */
export interface EdgeGeomOptions {
  /** Horizontal separation between genuinely-parallel edges (same pair). */
  laneGap?: number
  /**
   * Every rendered card rect. When a straight edge would cut through one of
   * these (other than its own two endpoints) it is re-routed around it. Omit to
   * disable obstacle avoidance (the plain smooth-step behaviour).
   */
  obstacles?: RectLike[]
  /** Gap kept between a re-routed edge and the cards it avoids. */
  clearance?: number
}

const sameRect = (a: RectLike, b: RectLike): boolean =>
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height

/** True when any segment of `pts` cuts through the interior of any obstacle. */
function pathHitsAny(pts: Pt[], obstacles: RectLike[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    for (const r of obstacles) {
      if (segmentHitsRect(pts[i - 1], pts[i], r)) return true
    }
  }
  return false
}

/**
 * Compute SVG geometry for every relationship given the measured card rects.
 *
 * Edges are dashed orthogonal "smooth step" elbows — a dependency-free port of
 * React Flow's `getSmoothStepPath`, the exact routing the Supabase schema
 * visualizer uses. Each end attaches to a specific field row (via `anchorY`)
 * on the card side that faces the other card, with a small connector dot where
 * the line meets the border. Genuinely-parallel edges (several links between the
 * same pair) shift their vertical channel apart so they never overlap.
 *
 * When `opts.obstacles` is supplied and the plain smooth-step channel would cut
 * through another card, the edge is re-routed around it via {@link routeOrthogonal}
 * (an obstacle-avoiding orthogonal router). Edges whose channel is already clear
 * keep the exact smooth-step geometry, so behaviour only changes where a line
 * previously ran through a box.
 *
 * Pure given `rectOf` + `anchorY`, so the geometry can be asserted in tests with
 * synthetic rects — the closest we can get to "looking at" the graph headless.
 */
export function computeEdgeGeometry(
  derived: DerivedEdges,
  rectOf: (name: string) => RectLike | null,
  anchorY?: AnchorFn,
  opts: EdgeGeomOptions = {}
): EdgeRender[] {
  const laneGap = opts.laneGap ?? LANE_GAP
  const clearance = opts.clearance ?? EDGE_CLEARANCE
  const allObstacles = opts.obstacles ?? []
  const out: EdgeRender[] = []

  const clampY = (r: RectLike, y: number): number =>
    Math.min(r.top + r.height - 6, Math.max(r.top + 6, y))

  // How many relationships share each unordered pair, so truly-parallel edges
  // (distinct links between the same two entities) can bow apart.
  const pairTotal = new Map<string, number>()
  for (const e of derived.pairs) {
    const key = `${e.a}${PAIR_SEP}${e.b}`
    pairTotal.set(key, (pairTotal.get(key) ?? 0) + 1)
  }
  const pairSeen = new Map<string, number>()

  for (const e of derived.pairs) {
    const ra = rectOf(e.a)
    const rb = rectOf(e.b)
    if (!ra || !rb) continue

    // Connect on the sides that face each other, chosen independently per card:
    // horizontally-separated cards get opposing sides (a clean vertical channel),
    // while vertically-stacked cards share a side (a tidy C-loop) instead of the
    // line wrapping all the way around.
    const caX = ra.left + ra.width / 2
    const cbX = rb.left + rb.width / 2
    const aSide: Side = cbX >= caX ? 'right' : 'left'
    const bSide: Side = caX >= cbX ? 'right' : 'left'
    const aX = aSide === 'right' ? ra.left + ra.width : ra.left
    const bX = bSide === 'right' ? rb.left + rb.width : rb.left
    const aY = clampY(ra, anchorY?.(e.a, e.aVia) ?? ra.top + ra.height / 2)
    const bY = clampY(rb, anchorY?.(e.b, e.bVia) ?? rb.top + rb.height / 2)
    const source = { x: aX, y: aY }
    const target = { x: bX, y: bY }

    const key = `${e.a}${PAIR_SEP}${e.b}`
    const lanes = pairTotal.get(key) ?? 1
    const lane = pairSeen.get(key) ?? 0
    pairSeen.set(key, lane + 1)
    const laneOff = (lane - (lanes - 1) / 2) * laneGap

    const pts = stepPoints(source, aSide, target, bSide, HANDLE_GAP)
    // Shift the interior vertical channel in X so parallel edges don't overlap
    // (endpoints/stubs at 0,1 and length-2,length-1 stay pinned to the cards).
    if (laneOff !== 0) {
      for (let i = 2; i < pts.length - 2; i++) pts[i] = { x: pts[i].x + laneOff, y: pts[i].y }
    }

    // If the plain smooth-step channel would cut through another card, re-route
    // around it. A single lane per pair is routable; genuinely-parallel edges
    // keep their offset channels (they run between the same two cards, so an
    // obstacle between them is not the case we're fixing).
    let routed = pts
    if (allObstacles.length && lanes === 1) {
      const others = allObstacles
        .filter((o) => !sameRect(o, ra) && !sameRect(o, rb))
        .map((o) => inflateRect(o, clearance))
      if (others.length && pathHitsAny(pts, others)) {
        const around = routeOrthogonal({
          source: pts[1],
          target: pts[pts.length - 2],
          sourceDir: aSide,
          targetDir: bSide,
          obstacles: others
        })
        if (around && around.length >= 2) routed = [source, ...around, target]
      }
    }
    const d = stepPath(routed, CORNER)

    const m = polyMid(routed)
    out.push({
      id: e.id,
      d,
      caps: [source, target],
      dashed: e.dashed,
      label: e.label,
      from: e.a,
      to: e.b,
      self: false,
      mx: m.x,
      my: m.y,
      midAngle: m.angle
    })
  }

  for (const s of derived.selfs) {
    const r = rectOf(s.entity)
    if (!r) continue
    const rightX = r.left + r.width
    const cy = r.top + r.height / 2
    let ya = clampY(r, anchorY?.(s.entity, s.via) ?? cy - 12)
    let yb = clampY(r, anchorY?.(s.entity) ?? cy + 12)
    // Guarantee a visible loop even when both rows resolve to the same Y.
    if (Math.abs(ya - yb) < 14) {
      ya = clampY(r, cy - 12)
      yb = clampY(r, cy + 12)
    }
    const gap = 30
    const pts = [
      { x: rightX, y: ya },
      { x: rightX + gap, y: ya },
      { x: rightX + gap, y: yb },
      { x: rightX, y: yb }
    ]
    const selfMid = polyMid(pts)
    out.push({
      id: `${s.id}@self`,
      d: stepPath(pts, CORNER),
      caps: [
        { x: rightX, y: ya },
        { x: rightX, y: yb }
      ],
      dashed: true,
      label: s.via,
      from: s.entity,
      to: s.entity,
      self: true,
      mx: selfMid.x,
      my: selfMid.y,
      midAngle: selfMid.angle
    })
  }

  return out
}

