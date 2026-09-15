/**
 * Dependency-free, deterministic **obstacle-avoiding orthogonal router** for the
 * Model view's relationship edges.
 *
 * The base edge geometry (`relationships.ts`) is a port of React Flow's
 * `getSmoothStepPath`, which routes using only an edge's two endpoints. That
 * means its single vertical channel can run straight through any *other* entity
 * card that happens to sit between the two it connects. This module finds an
 * orthogonal (right-angle) path that goes *around* those cards instead.
 *
 * The algorithm is the classic grid form of orthogonal connector routing
 * (Wybrow/Marriott/Stuckey): build a sparse grid from the "interesting" lines
 * (obstacle borders + the endpoints), then run A* over it preferring short paths
 * with few bends. It is a pure function of its inputs — every set is sorted and
 * ties are broken deterministically — so the output is stable across renders and
 * can be unit-tested without a DOM.
 */
import type { Pt, RectLike } from './relationships'

/** Which side of a card an endpoint stub leaves from (stubs are horizontal). */
export type Dir = 'left' | 'right'

/** Half-pixel slack so a segment grazing a border is treated as *outside*. */
const EPS = 0.5

const rectRight = (r: RectLike): number => r.left + r.width
const rectBottom = (r: RectLike): number => r.top + r.height

/** Grow a rect by `pad` on every side (used to keep edges a clearance away). */
export function inflateRect(r: RectLike, pad: number): RectLike {
  return { left: r.left - pad, top: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad }
}

/**
 * True when the axis-aligned segment `a → b` passes through the OPEN interior of
 * `rect`. A segment that merely runs along a border returns false — obstacle
 * rects are pre-inflated by a clearance, so their borders are the routing lanes.
 */
export function segmentHitsRect(a: Pt, b: Pt, rect: RectLike): boolean {
  const x0 = Math.min(a.x, b.x)
  const x1 = Math.max(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const y1 = Math.max(a.y, b.y)
  return (
    x0 < rectRight(rect) - EPS &&
    x1 > rect.left + EPS &&
    y0 < rectBottom(rect) - EPS &&
    y1 > rect.top + EPS
  )
}

/** True when `p` lies strictly inside `rect` (border points are allowed). */
function pointInRect(p: Pt, rect: RectLike): boolean {
  return (
    p.x > rect.left + EPS &&
    p.x < rectRight(rect) - EPS &&
    p.y > rect.top + EPS &&
    p.y < rectBottom(rect) - EPS
  )
}

export interface RouteInput {
  /** Start of the run to route (already off the source card — a stub point). */
  source: Pt
  /** End of the run to route (the target card's stub point). */
  target: Pt
  /** Side the source stub points toward (kept for future turn-bias tuning). */
  sourceDir: Dir
  /** Side the target stub points toward. */
  targetDir: Dir
  /** Cards to route around, ALREADY inflated by the desired clearance. */
  obstacles: RectLike[]
  /** Extra cost per direction change, so fewer-bend paths win. */
  turnPenalty?: number
  /** Grid-size guard: bail out (return null) rather than route a huge grid. */
  maxNodes?: number
  /** Margin for the surrounding "escape" ring added around everything. */
  margin?: number
}

/** Minimal binary min-heap keyed by a numeric priority with stable tie-breaks. */
class MinHeap<T> {
  private items: { key: number; seq: number; value: T }[] = []
  private seq = 0
  get size(): number {
    return this.items.length
  }
  push(key: number, value: T): void {
    const node = { key, seq: this.seq++, value }
    const a = this.items
    a.push(node)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.less(a[i], a[p])) {
        ;[a[i], a[p]] = [a[p], a[i]]
        i = p
      } else break
    }
  }
  pop(): T | undefined {
    const a = this.items
    if (a.length === 0) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let m = i
        if (l < a.length && this.less(a[l], a[m])) m = l
        if (r < a.length && this.less(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top.value
  }
  // Lower key wins; equal keys fall back to insertion order for determinism.
  private less(x: { key: number; seq: number }, y: { key: number; seq: number }): boolean {
    return x.key < y.key || (x.key === y.key && x.seq < y.seq)
  }
}

/** Collapse runs of collinear / duplicate points into corner points only. */
function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of points) {
    const n = out.length
    if (n === 0) {
      out.push(p)
      continue
    }
    const prev = out[n - 1]
    if (prev.x === p.x && prev.y === p.y) continue // duplicate
    if (n >= 2) {
      const prev2 = out[n - 2]
      const collinearH = prev2.y === prev.y && prev.y === p.y
      const collinearV = prev2.x === prev.x && prev.x === p.x
      if (collinearH || collinearV) {
        out[n - 1] = p // extend the straight run
        continue
      }
    }
    out.push(p)
  }
  return out
}

/**
 * Route an orthogonal polyline from `source` to `target` that avoids every
 * obstacle interior, or `null` when no such path exists (or the grid would be
 * too large). The returned array starts at `source` and ends at `target`.
 */
export function routeOrthogonal(input: RouteInput): Pt[] | null {
  const { source, target, obstacles } = input
  const turnPenalty = input.turnPenalty ?? 40
  const maxNodes = input.maxNodes ?? 4000
  const margin = input.margin ?? 24

  if (source.x === target.x && source.y === target.y) return [source]

  // "Interesting" lines: obstacle borders + the two endpoints, plus a ring a
  // little outside everything so the path always has an outer lane to escape to.
  const xsSet = new Set<number>([source.x, target.x])
  const ysSet = new Set<number>([source.y, target.y])
  for (const r of obstacles) {
    xsSet.add(r.left)
    xsSet.add(rectRight(r))
    ysSet.add(r.top)
    ysSet.add(rectBottom(r))
  }
  const minX = Math.min(...xsSet) - margin
  const maxX = Math.max(...xsSet) + margin
  const minY = Math.min(...ysSet) - margin
  const maxY = Math.max(...ysSet) + margin
  xsSet.add(minX)
  xsSet.add(maxX)
  ysSet.add(minY)
  ysSet.add(maxY)

  const xs = [...xsSet].sort((a, b) => a - b)
  const ys = [...ysSet].sort((a, b) => a - b)
  const nx = xs.length
  const ny = ys.length
  if (nx * ny > maxNodes) return null

  const xIndex = new Map<number, number>(xs.map((v, i) => [v, i]))
  const yIndex = new Map<number, number>(ys.map((v, i) => [v, i]))

  const pointAt = (i: number, j: number): Pt => ({ x: xs[i], y: ys[j] })
  const idxOf = (i: number, j: number): number => j * nx + i

  // Nodes strictly inside any obstacle are unusable.
  const blocked = new Uint8Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const p = pointAt(i, j)
      for (const r of obstacles) {
        if (pointInRect(p, r)) {
          blocked[idxOf(i, j)] = 1
          break
        }
      }
    }
  }

  const si = xIndex.get(source.x)!
  const sj = yIndex.get(source.y)!
  const ti = xIndex.get(target.x)!
  const tj = yIndex.get(target.y)!
  const goalIdx = idxOf(ti, tj)

  // A* state = (node, incoming direction) so turns can be penalised. Direction:
  // 0 = horizontal, 1 = vertical. The stub arriving at `source` is horizontal.
  const DIR_H = 0
  const DIR_V = 1
  const stateCount = nx * ny * 2
  const gScore = new Float64Array(stateCount).fill(Infinity)
  const cameFrom = new Int32Array(stateCount).fill(-1)
  const startState = idxOf(si, sj) * 2 + DIR_H
  gScore[startState] = 0

  const heuristic = (i: number, j: number): number =>
    Math.abs(xs[i] - xs[ti]) + Math.abs(ys[j] - ys[tj])

  const heap = new MinHeap<number>() // holds A* state indices
  heap.push(heuristic(si, sj), startState)

  // Fixed neighbour order → deterministic exploration given the heap tie-break.
  const steps: [number, number, number][] = [
    [1, 0, DIR_H],
    [-1, 0, DIR_H],
    [0, 1, DIR_V],
    [0, -1, DIR_V]
  ]

  let reachedState = -1
  while (heap.size > 0) {
    const state = heap.pop()!
    const node = state >> 1
    const dir = state & 1
    const i = node % nx
    const j = (node / nx) | 0
    if (node === goalIdx) {
      reachedState = state
      break
    }
    const g = gScore[state]
    for (const [di, dj, moveDir] of steps) {
      const ni = i + di
      const nj = j + dj
      if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) continue
      const nIdx = idxOf(ni, nj)
      if (blocked[nIdx]) continue
      const from = pointAt(i, j)
      const to = pointAt(ni, nj)
      let hits = false
      for (const r of obstacles) {
        if (segmentHitsRect(from, to, r)) {
          hits = true
          break
        }
      }
      if (hits) continue
      const stepCost = Math.abs(to.x - from.x) + Math.abs(to.y - from.y)
      const turn = moveDir === dir ? 0 : turnPenalty
      const ng = g + stepCost + turn
      const nState = nIdx * 2 + moveDir
      if (ng < gScore[nState]) {
        gScore[nState] = ng
        cameFrom[nState] = state
        heap.push(ng + heuristic(ni, nj), nState)
      }
    }
  }

  if (reachedState < 0) return null

  // Walk the came-from chain back to the start, then reverse into a polyline.
  const rev: Pt[] = []
  let cur = reachedState
  while (cur >= 0) {
    const node = cur >> 1
    rev.push(pointAt(node % nx, (node / nx) | 0))
    if (cur === startState) break
    cur = cameFrom[cur]
  }
  rev.reverse()
  return simplify(rev)
}
