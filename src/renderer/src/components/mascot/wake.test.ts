import { describe, expect, it } from 'vitest'
import { Wake, WAKE_LIFE, wakeArcs, type Ripple } from './wake'

const ripple = (over: Partial<Ripple> = {}): Ripple => ({
  x: 0,
  y: 0,
  back: Math.PI,
  reach: 1.4,
  strength: 0.4,
  spread: 74,
  t: 0,
  ...over
})

/** Swim him right along y = 0 at `speed` px/s for `px` px, a frame at a time. */
function swim(wake: Wake, speed: number, px: number): number {
  let t = 0
  for (let x = 0; x <= px; x += speed / 60) {
    wake.stir({ x, y: 0 }, speed, 0, t)
    t += 1000 / 60
  }
  return t
}

describe("Ray's wake", () => {
  it('leaves a ripple every few dozen px he swims, spreading back the way he came', () => {
    const wake = new Wake(document.createElement('canvas'), () => 0.5)
    const arcs = wake.arcs(swim(wake, 300, 240))
    const ripples = new Set(arcs.map((a) => a.x)).size
    expect(ripples).toBeGreaterThanOrEqual(5)
    expect(ripples).toBeLessThanOrEqual(8)
    for (const a of arcs) expect(Math.cos((a.start + a.end) / 2)).toBeCloseTo(-1)
  })

  it('leaves none while he drifts slowly', () => {
    const wake = new Wake(document.createElement('canvas'))
    expect(wake.arcs(swim(wake, 40, 240))).toEqual([])
  })

  it('spreads each ripple out and fades it until it is gone', () => {
    const [young] = wakeArcs([ripple()], 150)
    const [old] = wakeArcs([ripple()], 700)
    expect(old.r).toBeGreaterThan(young.r)
    expect(old.alpha).toBeLessThan(young.alpha)
    expect(wakeArcs([ripple()], WAKE_LIFE)).toEqual([])
  })
})
