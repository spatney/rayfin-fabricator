import { describe, expect, it } from 'vitest'
import type { Pt, RectLike } from './relationships'
import { inflateRect, routeOrthogonal, segmentHitsRect } from './router'

const rect = (left: number, top: number, width: number, height: number): RectLike => ({
  left,
  top,
  width,
  height
})

/** Assert no segment of `pts` cuts through the interior of any obstacle. */
function expectClear(pts: Pt[], obstacles: RectLike[]): void {
  for (let i = 1; i < pts.length; i++) {
    for (const o of obstacles) {
      expect(segmentHitsRect(pts[i - 1], pts[i], o)).toBe(false)
    }
  }
}

/** A path is orthogonal when every segment is purely horizontal or vertical. */
function expectOrthogonal(pts: Pt[]): void {
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x !== pts[i - 1].x
    const dy = pts[i].y !== pts[i - 1].y
    expect(dx && dy).toBe(false)
  }
}

describe('segmentHitsRect', () => {
  const r = rect(100, 100, 100, 100) // interior (100..200, 100..200)

  it('detects a segment crossing the interior', () => {
    expect(segmentHitsRect({ x: 50, y: 150 }, { x: 250, y: 150 }, r)).toBe(true)
  })

  it('treats a segment running along a border as clear', () => {
    expect(segmentHitsRect({ x: 50, y: 100 }, { x: 250, y: 100 }, r)).toBe(false)
    expect(segmentHitsRect({ x: 100, y: 50 }, { x: 100, y: 250 }, r)).toBe(false)
  })

  it('ignores a segment that stays outside', () => {
    expect(segmentHitsRect({ x: 50, y: 50 }, { x: 250, y: 50 }, r)).toBe(false)
  })
})

describe('routeOrthogonal', () => {
  it('returns a straight run when nothing is in the way', () => {
    const path = routeOrthogonal({
      source: { x: 0, y: 0 },
      target: { x: 300, y: 0 },
      sourceDir: 'right',
      targetDir: 'left',
      obstacles: []
    })
    expect(path).not.toBeNull()
    expect(path![0]).toEqual({ x: 0, y: 0 })
    expect(path![path!.length - 1]).toEqual({ x: 300, y: 0 })
    expectOrthogonal(path!)
  })

  it('bends around a card sitting on the straight channel', () => {
    // Obstacle straddles the y=0 line between the endpoints.
    const obstacle = inflateRect(rect(120, -50, 60, 100), 12)
    const path = routeOrthogonal({
      source: { x: 0, y: 0 },
      target: { x: 300, y: 0 },
      sourceDir: 'right',
      targetDir: 'left',
      obstacles: [obstacle]
    })
    expect(path).not.toBeNull()
    expectOrthogonal(path!)
    expectClear(path!, [obstacle])
    // It had to detour vertically off the direct y=0 line.
    expect(path!.some((p) => Math.abs(p.y) > 1)).toBe(true)
    // Endpoints are preserved exactly.
    expect(path![0]).toEqual({ x: 0, y: 0 })
    expect(path![path!.length - 1]).toEqual({ x: 300, y: 0 })
  })

  it('returns null when the target is fully boxed in', () => {
    // Four overlapping walls seal the target off with no border-slide escape.
    const walls = [
      rect(270, 15, 60, 20), // top
      rect(270, -35, 60, 20), // bottom
      rect(265, -35, 15, 70), // left
      rect(320, -35, 15, 70) // right
    ]
    const path = routeOrthogonal({
      source: { x: 0, y: 0 },
      target: { x: 300, y: 0 },
      sourceDir: 'right',
      targetDir: 'left',
      obstacles: walls
    })
    expect(path).toBeNull()
  })

  it('bails out (null) when the grid would exceed the node cap', () => {
    const obstacles = Array.from({ length: 40 }, (_, i) => rect(i * 30, i * 30, 20, 20))
    const path = routeOrthogonal({
      source: { x: 0, y: 0 },
      target: { x: 2000, y: 2000 },
      sourceDir: 'right',
      targetDir: 'left',
      obstacles,
      maxNodes: 50
    })
    expect(path).toBeNull()
  })

  it('is deterministic for identical input', () => {
    const args = {
      source: { x: 0, y: 0 },
      target: { x: 400, y: 40 },
      sourceDir: 'right' as const,
      targetDir: 'left' as const,
      obstacles: [inflateRect(rect(150, -40, 80, 120), 12)]
    }
    expect(routeOrthogonal(args)).toEqual(routeOrthogonal(args))
  })
})
