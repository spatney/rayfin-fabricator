import { describe, it, expect } from 'vitest'
import { computeLayout, connectedComponents, type LayoutEdge, type LayoutNode } from './layout'

const node = (id: string, width = 200, height = 120): LayoutNode => ({ id, width, height })

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

describe('connectedComponents', () => {
  it('groups connected ids and separates disconnected ones', () => {
    const edges: LayoutEdge[] = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' }
    ]
    const comps = connectedComponents(['A', 'B', 'C', 'D'], edges)
    expect(comps).toEqual([['A', 'B', 'C'], ['D']])
  })

  it('ignores self-relations when grouping', () => {
    const comps = connectedComponents(['A', 'B'], [{ from: 'A', to: 'A' }])
    expect(comps).toEqual([['A'], ['B']])
  })

  it('is deterministic regardless of node/edge order', () => {
    const a = connectedComponents(['C', 'A', 'B'], [{ from: 'B', to: 'A' }])
    const b = connectedComponents(['A', 'B', 'C'], [{ from: 'A', to: 'B' }])
    expect(a).toEqual(b)
  })
})

describe('computeLayout', () => {
  it('returns an empty result for no nodes', () => {
    const r = computeLayout([], [])
    expect(r.positions.size).toBe(0)
    expect(r.width).toBe(0)
    expect(r.height).toBe(0)
  })

  it('places a single node at the origin sized to itself', () => {
    const r = computeLayout([node('A', 240, 160)], [])
    expect(r.positions.get('A')).toEqual({ x: 0, y: 0, width: 240, height: 160 })
    expect(r.width).toBe(240)
    expect(r.height).toBe(160)
  })

  it('puts related entities in separate layers (columns)', () => {
    const r = computeLayout([node('A'), node('B')], [{ from: 'A', to: 'B' }])
    const a = r.positions.get('A')!
    const b = r.positions.get('B')!
    expect(a.x).not.toEqual(b.x) // different columns
    expect(a.y).toEqual(b.y) // single-node columns share the same top edge
  })

  it('never overlaps cards', () => {
    const nodes = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => node(id))
    const edges: LayoutEdge[] = [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'C' },
      { from: 'B', to: 'D' },
      { from: 'E', to: 'F' }
    ]
    const r = computeLayout(nodes, edges)
    const rects = [...r.positions.values()]
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i], rects[j])).toBe(false)
      }
    }
  })

  it('is deterministic across calls', () => {
    const nodes = ['A', 'B', 'C'].map((id) => node(id))
    const edges: LayoutEdge[] = [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }]
    const first = computeLayout(nodes, edges)
    const second = computeLayout(nodes, edges)
    expect([...second.positions.entries()]).toEqual([...first.positions.entries()])
  })

  it('keeps every node within the reported canvas bounds', () => {
    const nodes = ['A', 'B', 'C', 'D'].map((id) => node(id))
    const r = computeLayout(nodes, [{ from: 'A', to: 'B' }])
    for (const rect of r.positions.values()) {
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(r.width + 0.001)
      expect(rect.y + rect.height).toBeLessThanOrEqual(r.height + 0.001)
    }
  })

  it('spreads a densely-connected hub across columns to fill a wide viewport', () => {
    // Tall cards + a hub with many spokes used to stack into one very tall,
    // narrow column, forcing fit-to-view down to ~30%. The layout should now
    // wrap the layer into several sub-columns to match the wide target aspect.
    const hub = node('Hub', 264, 360)
    const spokes = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'].map((id) =>
      node(id, 264, 360)
    )
    const edges: LayoutEdge[] = spokes.map((s) => ({ from: 'Hub', to: s.id }))

    const wide = computeLayout([hub, ...spokes], edges, { targetAspect: 2.2 })
    const distinctX = new Set(
      [...wide.positions.values()].map((r) => Math.round(r.x))
    ).size
    expect(distinctX).toBeGreaterThanOrEqual(3) // hub + wrapped spoke columns
    expect(wide.width).toBeGreaterThan(wide.height) // wide, not a tall strip

    // A tall target aspect keeps them in one narrow column, confirming the knob
    // (and the old behaviour) is what drove the wasted horizontal space.
    const tall = computeLayout([hub, ...spokes], edges, { targetAspect: 0.2 })
    expect(tall.height).toBeGreaterThan(tall.width)
  })
})
