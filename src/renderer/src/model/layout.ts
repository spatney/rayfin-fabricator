/**
 * Dependency-free, deterministic auto-layout for the data-model diagram.
 *
 * The Model view used to drop entity cards into a plain CSS `auto-fill` grid in
 * schema order, so related entities landed far apart and relation edges crossed
 * at random. This module lays entities out in a relationship-aware way without
 * pulling in a graph library (matching the hand-rolled `parseSchema` scanner):
 *
 *   1. Split the entities into connected components (ignoring self-relations).
 *   2. Lay each component out in left→right layers via a BFS from its highest-
 *      degree node, ordering nodes within a layer by the barycenter of their
 *      neighbours to reduce edge crossings.
 *   3. Pack the component bounding boxes into rows.
 *
 * Everything is a pure function of the inputs (ties always broken by name), so
 * the result is stable across renders and unit-testable in isolation.
 */

export interface LayoutNode {
  id: string
  width: number
  height: number
}

export interface LayoutEdge {
  from: string
  to: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutResult {
  positions: Map<string, Rect>
  width: number
  height: number
}

export interface LayoutOptions {
  /** Horizontal gap between layers (columns). */
  layerGap?: number
  /** Vertical gap between stacked nodes within a layer. */
  nodeGap?: number
  /** Gap between packed connected components. */
  componentGap?: number
  /** Target width to wrap component rows at when packing. */
  targetWidth?: number
  /**
   * Desired width-to-height ratio for each component. Entity cards are tall, so
   * a densely-connected layer would otherwise stack into one very tall, narrow
   * column — forcing fit-to-view to zoom way out and wasting a wide viewport.
   * Tall layers are wrapped into several sub-columns to approach this ratio.
   */
  targetAspect?: number
}

const DEFAULTS = {
  layerGap: 90,
  nodeGap: 26,
  componentGap: 60,
  targetWidth: 1600,
  targetAspect: 1.9
}

/**
 * Group node ids into connected components using an undirected view of the
 * edges. Self-relations (`from === to`) don't connect anything. Components and
 * the ids within them are returned in a deterministic (name-sorted) order.
 */
export function connectedComponents(nodeIds: string[], edges: LayoutEdge[]): string[][] {
  const ids = [...nodeIds].sort()
  const adj = new Map<string, Set<string>>()
  for (const id of ids) adj.set(id, new Set())
  for (const e of edges) {
    if (e.from === e.to) continue
    if (!adj.has(e.from) || !adj.has(e.to)) continue
    adj.get(e.from)!.add(e.to)
    adj.get(e.to)!.add(e.from)
  }

  const seen = new Set<string>()
  const components: string[][] = []
  for (const start of ids) {
    if (seen.has(start)) continue
    const queue = [start]
    seen.add(start)
    const group: string[] = []
    while (queue.length) {
      const cur = queue.shift()!
      group.push(cur)
      for (const nb of [...adj.get(cur)!].sort()) {
        if (!seen.has(nb)) {
          seen.add(nb)
          queue.push(nb)
        }
      }
    }
    components.push(group.sort())
  }
  return components
}

/**
 * Assign each node in a component to a layer (BFS depth) starting from the
 * highest-degree node, so hub entities anchor the left of the diagram.
 */
function assignLayers(group: string[], adj: Map<string, Set<string>>): string[][] {
  const degree = (id: string): number => adj.get(id)?.size ?? 0
  const root = [...group].sort((a, b) => degree(b) - degree(a) || (a < b ? -1 : 1))[0]

  const depth = new Map<string, number>()
  depth.set(root, 0)
  const queue = [root]
  while (queue.length) {
    const cur = queue.shift()!
    const d = depth.get(cur)!
    for (const nb of [...(adj.get(cur) ?? [])].sort()) {
      if (!depth.has(nb)) {
        depth.set(nb, d + 1)
        queue.push(nb)
      }
    }
  }
  // Any node not reached (shouldn't happen within a component) lands in layer 0.
  for (const id of group) if (!depth.has(id)) depth.set(id, 0)

  const maxLayer = Math.max(...[...depth.values()])
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => [])
  for (const id of [...group].sort()) layers[depth.get(id)!].push(id)
  return layers
}

/**
 * Reorder nodes within each layer by the barycenter (mean neighbour index) of
 * the adjacent layer, sweeping a few times in both directions to settle on a
 * low-crossing ordering. Deterministic: ties break by name.
 */
function orderByBarycenter(layers: string[][], adj: Map<string, Set<string>>): void {
  const indexIn = (layer: string[]): Map<string, number> =>
    new Map(layer.map((id, i) => [id, i]))

  const sweep = (from: number, to: number): void => {
    const step = from < to ? 1 : -1
    for (let l = from; l !== to + step; l += step) {
      const ref = l - step
      if (ref < 0 || ref >= layers.length) continue
      const refIdx = indexIn(layers[ref])
      const bary = new Map<string, number>()
      layers[l].forEach((id, i) => {
        const neighbours = [...(adj.get(id) ?? [])].filter((n) => refIdx.has(n))
        if (neighbours.length === 0) {
          bary.set(id, i) // keep position when nothing to align to
        } else {
          const mean =
            neighbours.reduce((s, n) => s + refIdx.get(n)!, 0) / neighbours.length
          bary.set(id, mean)
        }
      })
      layers[l] = [...layers[l]].sort(
        (a, b) => bary.get(a)! - bary.get(b)! || (a < b ? -1 : 1)
      )
    }
  }

  const last = layers.length - 1
  for (let iter = 0; iter < 4; iter++) {
    sweep(1, last)
    sweep(last - 1, 0)
  }
}

/**
 * Position a single component's layers as left→right columns. Nodes stack
 * vertically within a column, but a layer whose stack would grow taller than a
 * target height (derived from `targetAspect`) wraps into several adjacent
 * sub-columns instead — so a densely-connected layer fills the wide viewport
 * horizontally rather than becoming one very tall, narrow strip.
 * Returns rects in component-local coordinates plus the component's size.
 */
function layoutComponent(
  layers: string[][],
  sizeOf: (id: string) => { width: number; height: number },
  opts: Required<LayoutOptions>
): { rects: Map<string, Rect>; width: number; height: number } {
  const ids = layers.flat()
  const n = ids.length
  const avgHeight =
    ids.reduce((sum, id) => sum + sizeOf(id).height, 0) / Math.max(1, n)
  const maxWidth = ids.reduce((max, id) => Math.max(max, sizeOf(id).width), 0)

  // Pick a column count that makes the component roughly match the target
  // aspect ratio, then bound each column's height accordingly. Tall layers wrap
  // into `⌈layerHeight / targetColHeight⌉` sub-columns.
  const cols = Math.min(
    n,
    Math.max(
      1,
      Math.round(
        Math.sqrt(
          (opts.targetAspect * n * (avgHeight + opts.nodeGap)) /
            (maxWidth + opts.layerGap)
        )
      )
    )
  )
  const rows = Math.ceil(n / Math.max(1, cols))
  const targetColHeight = rows * (avgHeight + opts.nodeGap)

  const rects = new Map<string, Rect>()
  let x = 0
  let maxBottom = 0
  for (const layer of layers) {
    let colX = x
    let y = 0
    let colWidth = 0
    let layerRight = x
    for (const id of layer) {
      const { width, height } = sizeOf(id)
      if (y > 0 && y + height > targetColHeight) {
        // Wrap into a fresh sub-column to the right within the same layer.
        colX = layerRight + opts.layerGap
        y = 0
        colWidth = 0
      }
      rects.set(id, { x: colX, y, width, height })
      y += height + opts.nodeGap
      colWidth = Math.max(colWidth, width)
      layerRight = Math.max(layerRight, colX + colWidth)
      maxBottom = Math.max(maxBottom, y - opts.nodeGap)
    }
    x = layerRight + opts.layerGap
  }

  const width = Math.max(0, x - opts.layerGap)
  return { rects, width, height: Math.max(0, maxBottom) }
}

/**
 * Compute a relationship-aware layout for the whole model. Nodes carry their
 * own measured/estimated sizes; the result is a map of absolute rects plus the
 * overall canvas size.
 */
export function computeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: LayoutOptions = {}
): LayoutResult {
  // Ignore explicitly-undefined option values so callers can pass a partial /
  // conditional options object without clobbering the defaults.
  const provided = Object.fromEntries(
    Object.entries(options).filter(([, v]) => v !== undefined)
  )
  const opts: Required<LayoutOptions> = { ...DEFAULTS, ...provided }
  const positions = new Map<string, Rect>()
  if (nodes.length === 0) return { positions, width: 0, height: 0 }

  const sizeById = new Map(nodes.map((n) => [n.id, { width: n.width, height: n.height }]))
  const sizeOf = (id: string): { width: number; height: number } =>
    sizeById.get(id) ?? { width: 0, height: 0 }

  const adj = new Map<string, Set<string>>()
  for (const n of nodes) adj.set(n.id, new Set())
  for (const e of edges) {
    if (e.from === e.to) continue
    if (!adj.has(e.from) || !adj.has(e.to)) continue
    adj.get(e.from)!.add(e.to)
    adj.get(e.to)!.add(e.from)
  }

  const components = connectedComponents(
    nodes.map((n) => n.id),
    edges
  )

  // Lay each component out locally.
  const boxes = components.map((group) => {
    const layers = assignLayers(group, adj)
    orderByBarycenter(layers, adj)
    return layoutComponent(layers, sizeOf, opts)
  })

  // Pack component bounding boxes into rows (wrap at targetWidth).
  let rowX = 0
  let rowY = 0
  let rowHeight = 0
  let canvasWidth = 0
  boxes.forEach((box) => {
    if (rowX > 0 && rowX + box.width > opts.targetWidth) {
      rowX = 0
      rowY += rowHeight + opts.componentGap
      rowHeight = 0
    }
    for (const [id, rect] of box.rects) {
      positions.set(id, { ...rect, x: rect.x + rowX, y: rect.y + rowY })
    }
    rowX += box.width + opts.componentGap
    rowHeight = Math.max(rowHeight, box.height)
    canvasWidth = Math.max(canvasWidth, rowX - opts.componentGap)
  })

  const canvasHeight = rowY + rowHeight
  return { positions, width: Math.max(0, canvasWidth), height: Math.max(0, canvasHeight) }
}
