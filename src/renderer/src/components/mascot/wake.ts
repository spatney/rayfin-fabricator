import type { Box, Point } from './motion'

/**
 * The ripples Ray leaves on the water. Every few dozen px of swimming, a
 * ripple starts under him and spreads out behind him as it fades, so a trail of
 * them fans out in his wake, follows his turns, and settles by itself once he
 * stops. Dropped back in, he sends one out all the way round.
 *
 * Like real ripples, each is a pair of crests that drift apart as they spread,
 * strongest straight behind him and fading towards the ends, and no two are
 * quite alike.
 *
 * Drawn on a canvas rather than in the DOM, because it changes on every frame
 * he's moving.
 */

/** How long a ripple takes to spread and fade, in ms. */
export const WAKE_LIFE = 1000

/** Slower than this, in px/s, and he leaves no ripples. */
const STILL = 60
/** About how far he swims between ripples, in px. */
const SPACING = 34
/** A ripple starts this wide, hidden under him, in px. */
const START = 24
/** About how far a ripple spreads beyond its start, in px. */
const SPREAD = 70
/** About how far round a ripple reaches from straight behind him, either way, in radians. */
const REACH = (85 * Math.PI) / 180
/** How strongly a ripple shows when he's going full tilt, from 0 to 1. */
const STRENGTH = 0.5
/** How strongly each crest of a ripple shows, front first. */
const CRESTS = [1, 0.5]
/** A tapered arc is drawn in this many pieces. */
const PIECES = 14

/** One ripple on the water: an arc of a ring spreading from where he was. */
export interface Ripple {
  x: number
  y: number
  /** The middle of the arc, in radians: the way he came from. */
  back: number
  /** How far round the arc goes either side of `back`, in radians. Pi is a full ring. */
  reach: number
  /** How strongly it shows at first, from 0 to 1. */
  strength: number
  /** How far it spreads beyond its start, in px. */
  spread: number
  /** When it starts, in ms. */
  t: number
}

/** One crest of a ripple, ready to draw. */
export interface WakeArc {
  x: number
  y: number
  r: number
  start: number
  end: number
  alpha: number
  width: number
  /** Fade it out towards both ends. A full ring has no ends. */
  taper: boolean
}

/** The ripples on the water at `now`, as arcs to draw. */
export function wakeArcs(ripples: readonly Ripple[], now: number): WakeArc[] {
  const arcs: WakeArc[] = []
  for (const p of ripples) {
    const age = (now - p.t) / WAKE_LIFE
    if (age < 0 || age >= 1) continue
    const alpha = p.strength * Math.min(1, age / 0.08) * (1 - age) ** 1.5
    if (alpha < 0.01) continue
    // Quick at first, then slowing, the way a ripple runs out of energy.
    const r = START + p.spread * (1 - (1 - age) ** 2)
    CRESTS.forEach((strength, i) => {
      arcs.push({
        x: p.x,
        y: p.y,
        r: r - i * (6 + 6 * age),
        start: p.back - p.reach,
        end: p.back + p.reach,
        alpha: alpha * strength,
        width: 1.2 * (1 - 0.35 * age),
        taper: p.reach < Math.PI
      })
    })
  }
  return arcs
}

export class Wake {
  private ripples: Ripple[] = []
  private last: Point | null = null
  private travelled = 0
  private gap = SPACING
  private ctx: CanvasRenderingContext2D | null = null
  private ratio = 1
  private color = ''
  private dirty = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly random: () => number = Math.random
  ) {}

  /** Somewhere between 1 - by and 1 + by, so no two ripples are quite alike. */
  private vary(by: number): number {
    return 1 - by + 2 * by * this.random()
  }

  /** Size the canvas to the water: `w` by `h` CSS px, `ratio` device px to each. */
  fit(w: number, h: number, ratio: number): void {
    const cw = Math.max(1, Math.round(w * ratio))
    const ch = Math.max(1, Math.round(h * ratio))
    if (this.canvas.width !== cw) this.canvas.width = cw
    if (this.canvas.height !== ch) this.canvas.height = ch
    this.ratio = ratio
    // Read every time, since the theme can change while he's out.
    this.color = getComputedStyle(this.canvas).color
  }

  /** He's swimming through `at`, moving at `vx, vy` px/s. */
  stir(at: Point, vx: number, vy: number, now: number): void {
    const v = Math.hypot(vx, vy)
    if (v < STILL) {
      this.last = null
      return
    }
    if (this.last) this.travelled += Math.hypot(at.x - this.last.x, at.y - this.last.y)
    this.last = { x: at.x, y: at.y }
    if (this.travelled < this.gap) return
    this.travelled = 0
    this.gap = SPACING * this.vary(0.2)
    this.ripples.push({
      x: at.x,
      y: at.y,
      back: Math.atan2(-vy, -vx),
      reach: REACH * this.vary(0.15),
      strength: STRENGTH * Math.min(1, (v - STILL) / 220) * this.vary(0.1),
      spread: SPREAD * this.vary(0.15),
      t: now
    })
  }

  /** He's been dropped back in: a ripple spreads out all round him. */
  splash(at: Point, now: number): void {
    this.last = null
    this.ripples.push({
      x: at.x,
      y: at.y,
      back: 0,
      reach: Math.PI,
      strength: 0.55,
      spread: 64,
      t: now
    })
  }

  /** What's on the water at `now`. */
  arcs(now: number): WakeArc[] {
    return wakeArcs(this.ripples, now)
  }

  /** Redraw the water, leaving the content dry. Costs nothing once it's still. */
  draw(now: number, avoid: readonly Box[]): void {
    this.ripples = this.ripples.filter((p) => now - p.t < WAKE_LIFE)
    const busy = this.ripples.length > 0
    if (!busy && !this.dirty) return
    const ctx = (this.ctx ??= this.canvas.getContext('2d'))
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.dirty = busy
    if (!busy) return

    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0)
    ctx.strokeStyle = this.color
    for (const a of this.arcs(now)) {
      ctx.lineWidth = a.width
      const pieces = a.taper ? PIECES : 1
      const step = (a.end - a.start) / pieces
      for (let k = 0; k < pieces; k++) {
        ctx.globalAlpha = a.taper ? a.alpha * Math.sin((Math.PI * (k + 0.5)) / pieces) : a.alpha
        ctx.beginPath()
        ctx.arc(a.x, a.y, a.r, a.start + k * step, a.start + (k + 1) * step)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
    // The water is wherever the content isn't.
    for (const b of avoid) ctx.clearRect(b.x, b.y, b.w, b.h)
  }
}
