import { describe, expect, it } from 'vitest'
import { blocked, pickSpot, placeBubble, steer, type Box } from './motion'

function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

const bounds: Box = { x: 0, y: 0, w: 1000, h: 700 }
/** A centred column of content, like the New project screen. */
const column: Box = { x: 300, y: 0, w: 400, h: 700 }
const size = { w: 100, h: 80 }

describe('where Ray rests', () => {
  it('stays inside his area and off the content', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const p = pickSpot({ bounds, avoid: [column], size, random: seeded(seed) })
      const box = { x: p.x, y: p.y, w: size.w, h: size.h }
      expect(blocked(box, [column])).toBe(0)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.w).toBeLessThanOrEqual(bounds.w)
      expect(box.y + box.h).toBeLessThanOrEqual(bounds.h)
    }
  })

  it('takes the corner that covers least when a narrow window leaves nowhere clear', () => {
    const small: Box = { x: 0, y: 0, w: 420, h: 300 }
    const content: Box = { x: 0, y: 0, w: 420, h: 250 }
    const p = pickSpot({ bounds: small, avoid: [content], size, random: seeded(4) })
    expect(p.y).toBe(300 - size.h - 14)
  })

  it('settles close by after being dropped', () => {
    const from = { x: 120, y: 320 }
    const p = pickSpot({ bounds, avoid: [column], size, from, near: true, random: seeded(8) })
    expect(Math.hypot(p.x - from.x, p.y - from.y)).toBeLessThan(120)
  })
})

describe('his speech bubble', () => {
  const bubble = { w: 220, h: 60 }

  it('sits above him, or below when he is near the top', () => {
    const above = placeBubble({
      actor: { x: 50, y: 400, w: 100, h: 80 },
      bubble,
      bounds,
      avoid: [],
      aimX: 100
    })
    expect(above.below).toBe(false)
    expect(above.y + bubble.h).toBeLessThanOrEqual(400)

    const below = placeBubble({
      actor: { x: 50, y: 10, w: 100, h: 80 },
      bubble,
      bounds,
      avoid: [],
      aimX: 100
    })
    expect(below.below).toBe(true)
    expect(below.y).toBeGreaterThanOrEqual(90)
  })

  it('stays on screen at the edge, with its tail still pointing at him', () => {
    const p = placeBubble({
      actor: { x: 930, y: 400, w: 70, h: 56 },
      bubble,
      bounds,
      avoid: [],
      aimX: 965
    })
    expect(p.x + bubble.w).toBeLessThanOrEqual(bounds.w)
    expect(p.x + p.tail).toBeCloseTo(965)
  })

  it('leans away from content beside him', () => {
    const p = placeBubble({
      actor: { x: 200, y: 400, w: 100, h: 80 },
      bubble,
      bounds,
      avoid: [column],
      aimX: 250
    })
    expect(blocked({ x: p.x, y: p.y, w: bubble.w, h: bubble.h }, [column])).toBe(0)
  })
})

describe('swimming', () => {
  it('arrives where he was heading', () => {
    const m = { x: 0, y: 0, vx: 0, vy: 0 }
    for (let i = 0; i < 600; i++) steer(m, { x: 300, y: 120 }, 1 / 60)
    expect(Math.hypot(m.x - 300, m.y - 120)).toBeLessThan(1)
  })
})
