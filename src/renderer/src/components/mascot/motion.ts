/**
 * Geometry and steering for Ray's swimming. Pure functions, so the roaming
 * rules can be tested without a browser.
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  w: number
  h: number
}

export function inflate(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, w: box.w + by * 2, h: box.h + by * 2 }
}

/** The area two boxes share, in px². */
export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** How much of `box` covers something Ray should keep off. */
export function blocked(box: Box, avoid: readonly Box[]): number {
  let total = 0
  for (const a of avoid) total += overlap(box, a)
  return total
}

const at = (p: Point, size: Size): Box => ({ x: p.x, y: p.y, w: size.w, h: size.h })

/**
 * A place for Ray to rest: inside `bounds` and clear of `avoid`. With `from`,
 * prefers a proper swim away (or, with `near`, the closest clear place). When
 * nowhere is clear, as in a narrow window, he takes the corner that covers the
 * least.
 */
export function pickSpot(opts: {
  bounds: Box
  avoid: readonly Box[]
  size: Size
  from?: Point
  near?: boolean
  pad?: number
  random?: () => number
}): Point {
  const { bounds, avoid, size, from, near = false, pad = 14, random = Math.random } = opts
  const minX = bounds.x + pad
  const minY = bounds.y + pad
  const maxX = bounds.x + bounds.w - size.w - pad
  const maxY = bounds.y + bounds.h - size.h - pad
  if (maxX < minX || maxY < minY) {
    return { x: Math.max(bounds.x, maxX), y: Math.max(bounds.y, maxY) }
  }

  const clear: Array<{ p: Point; d: number }> = []
  for (let i = 0; i < 64; i++) {
    const p = { x: minX + random() * (maxX - minX), y: minY + random() * (maxY - minY) }
    if (blocked(at(p, size), avoid) === 0) {
      clear.push({ p, d: from ? Math.hypot(p.x - from.x, p.y - from.y) : 0 })
    }
  }
  if (clear.length) {
    if (!from) return clear[0].p
    if (near) return clear.reduce((a, b) => (b.d < a.d ? b : a)).p
    // A proper swim, but mostly a short one: crossing the screen is a treat.
    const short = clear.filter((c) => c.d > 150 && c.d <= 520)
    const long = clear.filter((c) => c.d > 520)
    const pool =
      short.length && (random() < 0.75 || !long.length) ? short : long.length ? long : clear
    return pool[Math.floor(random() * pool.length)].p
  }

  const corners = [
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
    { x: maxX, y: minY },
    { x: minX, y: minY }
  ]
  let best = corners[0]
  let least = Infinity
  for (const c of corners) {
    const cover = blocked(at(c, size), avoid)
    if (cover < least) {
      best = c
      least = cover
    }
  }
  return best
}

export interface BubblePlacement {
  x: number
  y: number
  /** Where the tail meets the bubble, from its left edge. */
  tail: number
  below: boolean
}

/**
 * Where his speech bubble goes: above him when it fits, otherwise below, slid
 * sideways to stay inside `bounds` and to cover as little content as it can.
 */
export function placeBubble(opts: {
  actor: Box
  bubble: Size
  bounds: Box
  avoid: readonly Box[]
  /** Horizontal point the tail aims at, such as his mouth. */
  aimX: number
  gap?: number
}): BubblePlacement {
  const { actor, bubble, bounds, avoid, aimX, gap = 8 } = opts
  const clampX = (x: number): number =>
    Math.min(Math.max(x, bounds.x + 6), bounds.x + bounds.w - bubble.w - 6)
  const above = actor.y - bubble.h - gap
  const below = actor.y + actor.h + gap
  const fitsAbove = above >= bounds.y + 4
  const fitsBelow = below + bubble.h <= bounds.y + bounds.h - 4

  let best: BubblePlacement | null = null
  let bestScore = Infinity
  for (const isBelow of [false, true]) {
    const y = isBelow ? below : above
    const fits = isBelow ? fitsBelow : fitsAbove
    for (const x of [aimX - bubble.w / 2, aimX - 26, aimX - bubble.w + 26]) {
      const bx = clampX(x)
      const score =
        blocked({ x: bx, y, w: bubble.w, h: bubble.h }, avoid) +
        (fits ? 0 : 1e7) +
        (isBelow ? 900 : 0) +
        Math.abs(bx + bubble.w / 2 - aimX)
      if (score < bestScore) {
        bestScore = score
        best = {
          x: bx,
          y: Math.min(Math.max(y, bounds.y + 4), bounds.y + bounds.h - bubble.h - 4),
          tail: Math.min(Math.max(aimX - bx, 16), bubble.w - 16),
          below: isBelow
        }
      }
    }
  }
  return best as BubblePlacement
}

export interface Motion {
  x: number
  y: number
  vx: number
  vy: number
}

/**
 * One step of "arrive" steering: speed up toward `target`, ease off as he gets
 * close. Mutates `m` and returns the distance left.
 */
export function steer(m: Motion, target: Point, dt: number, maxSpeed = 250, accel = 560): number {
  const dx = target.x - m.x
  const dy = target.y - m.y
  const dist = Math.hypot(dx, dy)
  const slowRadius = 110
  const speed = dist < slowRadius ? maxSpeed * (dist / slowRadius) : maxSpeed
  const wantX = dist > 0.01 ? (dx / dist) * speed : 0
  const wantY = dist > 0.01 ? (dy / dist) * speed : 0
  const dvx = wantX - m.vx
  const dvy = wantY - m.vy
  const dv = Math.hypot(dvx, dvy)
  const limit = accel * dt
  const k = dv > limit ? limit / dv : 1
  m.vx += dvx * k
  m.vy += dvy * k
  m.x += m.vx * dt
  m.y += m.vy * dt
  return dist
}

/** How long a line stays up: enough to read it, never forever. */
export function readingTime(text: string): number {
  return Math.min(9000, Math.max(3600, 2000 + text.length * 58))
}
