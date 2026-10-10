import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Codicon } from '../icons'
import { Ray, RAY_EYES, RAY_MOUTH, RAY_VIEWBOX, type RayMood } from './Ray'
import { SpeechBubble, TYPE_MS } from './SpeechBubble'
import { Particles, useParticles } from './Particles'
import { Wake, WAKE_LIFE } from './wake'
import { useReducedMotion } from './context'
import {
  BYE_LINE,
  DIZZY_LINES,
  DROP_LINES,
  FactDeck,
  HOVER_LINES,
  LIFT_LINE,
  PET_LINES,
  RESUME_LINE,
  RETRY_LINE,
  SLOW_LINE,
  WAKE_LINES,
  errorLine,
  firstMeeting,
  greeting,
  pickLine,
  rememberMeeting,
  successLine,
  type MascotLine,
  type Occasion
} from './lines'
import {
  blocked,
  inflate,
  pickSpot,
  placeBubble,
  readingTime,
  steer,
  type Box,
  type Motion,
  type Point
} from './motion'

export type VisitPhase = 'running' | 'success' | 'error' | 'leaving' | 'bye'

export interface MascotRoamerProps {
  occasion: Occasion
  phase: VisitPhase
  /** Changes whenever `phase` is entered again, such as a second retry. */
  phaseKey: number
  /** The area he swims in, in viewport coordinates. Null means the window. */
  getBounds: () => DOMRect | null
  /** He has swum off and can be unmounted. */
  onGone: () => void
  /** The user sent him away. */
  onDismiss: () => void
}

/** His size on screen, in CSS px. */
const W = 104
const H = (W * RAY_VIEWBOX.h) / RAY_VIEWBOX.w

/** Nobody has touched the mouse or keyboard for this long: nap time. */
const NAP_AFTER = 40_000
/** The install has taken this long: say so, once. */
const SLOW_AFTER = 75_000

type Mode = 'enter' | 'swim' | 'rest' | 'drag' | 'exit'

const chat = (text: string): MascotLine => ({ kind: 'chat', text })
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const within = (a: Box, b: Box): boolean =>
  a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h

function clip(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const w = Math.min(a.x + a.w, b.x + b.w) - x
  const h = Math.min(a.y + a.h, b.y + b.h) - y
  return w > 40 && h > 40 ? { x, y, w, h } : b
}

/** One deck for every visit, so facts don't repeat between installs. */
let deck: FactDeck | null = null
const sharedDeck = (): FactDeck => (deck ??= new FactDeck())

/**
 * Ray flying around the screen while an app installs: he picks resting spots
 * clear of the content, shares Rayfin facts in a speech bubble, follows the
 * cursor with his eyes, banks into his turns, and can be petted, picked up and
 * thrown.
 *
 * Movement runs in a frame loop that writes transforms straight to the DOM;
 * React only renders when his face or his line changes.
 */
export function MascotRoamer({
  occasion,
  phase,
  phaseKey,
  getBounds,
  onGone,
  onDismiss
}: MascotRoamerProps): JSX.Element {
  const reduced = useReducedMotion()
  const { particles, burst } = useParticles()
  const sayId = useId()

  const layerRef = useRef<HTMLDivElement>(null)
  const wakeRef = useRef<HTMLCanvasElement>(null)
  const actorRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const bobRef = useRef<HTMLDivElement>(null)
  const squishRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)

  const [line, setLine] = useState<MascotLine | null>(null)
  const [lineId, setLineId] = useState(0)
  const [talking, setTalking] = useState(false)
  const [base, setBase] = useState<RayMood>('idle')
  const [flashMood, setFlashMood] = useState<RayMood | null>(null)
  const [asleep, setAsleep] = useState(false)
  const [wave, setWave] = useState<number | undefined>(undefined)
  const [fading, setFading] = useState(false)

  const props = useRef({ occasion, getBounds, onGone, onDismiss })
  props.current = { occasion, getBounds, onGone, onDismiss }
  // Read once, so a double-mounted effect in development still introduces him.
  const firstTime = useRef(firstMeeting()).current

  // Everything the frame loop reads lives here, outside React state.
  const s = useRef({
    m: { x: -400, y: 0, vx: 0, vy: 0 } as Motion,
    mode: 'enter' as Mode,
    target: null as Point | null,
    speed: 250,
    arrive: null as null | (() => void),
    bank: 0,
    steer: 0,
    swimming: false,
    water: null as Wake | null,
    /** Drawing his wake failed once; he swims on without it. */
    calm: false,
    pointer: null as Point | null,
    lastActive: performance.now(),
    scale: 1,
    view: { x: 0, y: 0, w: 1024, h: 768 } as Box,
    bounds: { x: 0, y: 0, w: 1024, h: 768 } as Box,
    avoid: [] as Box[],
    measuredAt: -1e9,
    lastCheck: 0,
    nextBeat: Infinity,
    line: null as MascotLine | null,
    lineAfter: null as null | (() => void),
    bubble: { w: 0, h: 0 },
    started: performance.now(),
    slowSaid: false,
    asleep: false,
    phase,
    reduced,
    down: null as Point | null,
    grab: { x: 0, y: 0 },
    dragV: { x: 0, y: 0 },
    suppressClick: false,
    pets: [] as number[],
    lastHover: -1e9,
    pendingExit: false,
    gone: false
  }).current
  s.phase = phase
  s.reduced = reduced

  /* ----------------------------- timers ----------------------------- */

  const timers = useRef(new Set<number>()).current
  const lineTimers = useRef(new Set<number>()).current
  const flashTimer = useRef(0)

  const later = useCallback(
    (fn: () => void, ms: number, set: Set<number> = timers): void => {
      const timer = window.setTimeout(() => {
        set.delete(timer)
        fn()
      }, ms)
      set.add(timer)
    },
    [timers]
  )

  function clearSet(set: Set<number>): void {
    for (const timer of set) window.clearTimeout(timer)
    set.clear()
  }

  useEffect(
    () => () => {
      clearSet(timers)
      clearSet(lineTimers)
      window.clearTimeout(flashTimer.current)
    },
    // The sets are stable; this only cleans up on unmount.
    [timers, lineTimers]
  )

  /** Show a face for a moment, over whatever he was doing. */
  function flash(mood: RayMood, ms: number): void {
    window.clearTimeout(flashTimer.current)
    setFlashMood(mood)
    flashTimer.current = window.setTimeout(() => setFlashMood(null), ms)
  }

  /* ----------------------------- speech ----------------------------- */

  /**
   * Say a line. `after` runs once it closes. An interruption (`keep`) inherits
   * the pending `after`, so petting him mid-goodbye can't strand him on screen.
   */
  function say(
    next: MascotLine,
    opts: { linger?: number; after?: () => void; keep?: boolean } = {}
  ): void {
    clearSet(lineTimers)
    s.lineAfter = opts.after ?? (opts.keep ? s.lineAfter : null)
    s.line = next
    s.bubble = { w: 0, h: 0 }
    setLine(next)
    setLineId((n) => n + 1)
    const typeMs = s.reduced ? 0 : Array.from(next.text).length * TYPE_MS
    setTalking(typeMs > 0)
    if (typeMs > 0) later(() => setTalking(false), typeMs, lineTimers)
    later(hush, typeMs + (opts.linger ?? readingTime(next.text)), lineTimers)
  }

  const quip = (text: string, linger: number): void => say(chat(text), { linger, keep: true })

  /** Close the bubble, then run whatever was waiting on it. */
  function hush(): void {
    clearSet(lineTimers)
    const after = s.lineAfter
    s.line = null
    s.lineAfter = null
    setLine(null)
    setTalking(false)
    s.nextBeat = performance.now() + 1300 + Math.random() * 1700
    after?.()
  }

  /* ----------------------------- geometry ----------------------------- */

  /** Read the layout: his bounds, and the content he keeps off. */
  function measure(now: number): void {
    const layer = layerRef.current
    if (!layer) return
    const rect = layer.getBoundingClientRect()
    // UI zoom scales the page; rects come back zoomed, our transforms are not.
    s.scale = layer.offsetWidth > 0 && rect.width > 0 ? rect.width / layer.offsetWidth : 1
    const toLayer = (b: DOMRect): Box => ({
      x: (b.left - rect.left) / s.scale,
      y: (b.top - rect.top) / s.scale,
      w: b.width / s.scale,
      h: b.height / s.scale
    })
    s.view = {
      x: 0,
      y: 0,
      w: layer.offsetWidth || window.innerWidth,
      h: layer.offsetHeight || window.innerHeight
    }
    const area = props.current.getBounds()
    s.bounds = area && area.width > 0 && area.height > 0 ? clip(toLayer(area), s.view) : s.view
    s.avoid = Array.from(document.querySelectorAll('[data-mascot-avoid]'))
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0)
      .map((b) => inflate(toLayer(b), 12))
    s.measuredAt = now
    water((w) => w.fit(s.view.w, s.view.h, (window.devicePixelRatio || 1) * s.scale))
  }

  const box = (): Box => ({ x: s.m.x, y: s.m.y, w: W, h: H })
  const mouth = (): Point => ({ x: s.m.x + W * RAY_MOUTH.x, y: s.m.y + H * RAY_MOUTH.y })
  const head = (): Point => ({ x: s.m.x + W / 2, y: s.m.y + H * 0.1 })
  const middle = (): Point => ({ x: s.m.x + W / 2, y: s.m.y + H / 2 })
  /** The middle of his disc, where he stirs the water. */
  const disc = (): Point => ({ x: s.m.x + W / 2, y: s.m.y + H * 0.42 })

  /**
   * The water he swims through. None with reduced motion. It's only for looks,
   * so if drawing it ever fails he carries on without it rather than freezing.
   */
  function water(fn: (w: Wake) => void): void {
    if (s.reduced || s.calm || !wakeRef.current) return
    try {
      s.water ??= new Wake(wakeRef.current)
      fn(s.water)
    } catch (err) {
      s.calm = true
      console.error(err)
    }
  }

  function spot(near = false): Point {
    return pickSpot({
      bounds: s.bounds,
      avoid: s.avoid,
      size: { w: W, h: H },
      from: s.mode === 'enter' ? undefined : { x: s.m.x, y: s.m.y },
      near
    })
  }

  /* ----------------------------- moving ----------------------------- */

  function swimTo(p: Point, then?: () => void): void {
    if (s.reduced) {
      s.m = { x: p.x, y: p.y, vx: 0, vy: 0 }
      s.mode = 'rest'
      then?.()
      return
    }
    // Long trips are quicker, so he never spends long over the content.
    s.speed = clamp(Math.hypot(p.x - s.m.x, p.y - s.m.y) * 0.9, 230, 560)
    s.target = p
    s.arrive = then ?? null
    s.mode = 'swim'
  }

  function enter(): void {
    measure(performance.now())
    const to = spot()
    const fromLeft = to.x + W / 2 < s.bounds.x + s.bounds.w / 2
    s.m = { x: fromLeft ? -W - 30 : s.view.w + 30, y: to.y, vx: 0, vy: 0 }
    const hello = (): void => {
      setWave((n) => (n ?? 0) + 1)
      say(greeting(props.current.occasion, firstTime))
      rememberMeeting()
    }
    if (s.reduced) {
      s.m = { x: to.x, y: to.y, vx: 0, vy: 0 }
      s.mode = 'rest'
      hello()
      return
    }
    s.mode = 'enter'
    s.target = to
    s.arrive = hello
  }

  function leave(): void {
    if (s.gone) return
    if (s.mode === 'drag') {
      s.pendingExit = true
      return
    }
    setWave((n) => (n ?? 0) + 1)
    later(() => {
      if (s.reduced) {
        setFading(true)
        later(finish, 280)
        return
      }
      const left = s.m.x + W / 2 < s.view.w / 2
      s.target = { x: left ? -W - 60 : s.view.w + 60, y: s.m.y }
      // Stay until his wake has faded, so it doesn't vanish all at once.
      s.arrive = () => later(finish, WAKE_LIFE)
      s.mode = 'exit'
    }, 450)
  }

  function finish(): void {
    if (s.gone) return
    s.gone = true
    props.current.onGone()
  }

  /** What he does between lines: swim somewhere, blow bubbles, or just talk. */
  function beat(now: number): void {
    s.nextBeat = now + 12_000 // a watchdog, in case this beat gets interrupted
    const speak = (): void => {
      if (s.phase !== 'running' || s.asleep || s.mode === 'drag') return
      const slow = !s.slowSaid && performance.now() - s.started > SLOW_AFTER
      if (slow) s.slowSaid = true
      say(slow ? SLOW_LINE : sharedDeck().next())
    }
    const roll = Math.random()
    if (!s.reduced && roll < 0.5) {
      swimTo(spot(), () => later(speak, 380))
    } else if (!s.reduced && roll < 0.65) {
      flash('blow', 1300)
      burst('bubble', 3, mouth())
      later(speak, 1500)
    } else {
      speak()
    }
  }

  function nap(): void {
    if (s.asleep) return
    s.asleep = true
    setAsleep(true)
    const snore = (): void => {
      if (!s.asleep) return
      if (!s.reduced) burst('zzz', 3, head())
      later(snore, 2700)
    }
    snore()
  }

  function wake(): void {
    if (!s.asleep) return
    s.asleep = false
    setAsleep(false)
    flash('surprised', 700)
    later(() => quip(pickLine(WAKE_LINES), 2200), 600)
  }

  /* ----------------------------- touching ----------------------------- */

  function animate(el: HTMLElement | null, frames: Keyframe[], ms: number): void {
    if (el && typeof el.animate === 'function')
      el.animate(frames, { duration: ms, easing: 'ease-out' })
  }

  function pet(): void {
    const now = performance.now()
    s.lastActive = now
    if (s.asleep) {
      wake()
      return
    }
    s.pets = s.pets.filter((t) => now - t < 2600)
    s.pets.push(now)
    animate(
      squishRef.current,
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.12, 0.86)' },
        { transform: 'scale(0.95, 1.07)' },
        { transform: 'scale(1)' }
      ],
      420
    )
    if (s.pets.length >= 5) {
      // Too much love: a barrel roll, and he needs a moment.
      s.pets = []
      flash('dizzy', 2600)
      if (!s.reduced) {
        animate(bobRef.current, [{ transform: 'rotate(0)' }, { transform: 'rotate(-360deg)' }], 650)
      }
      quip(pickLine(DIZZY_LINES), 1600)
      return
    }
    flash('love', 1500)
    if (!s.reduced) burst('heart', 3, head())
    if (!s.line && Math.random() < 0.55) quip(pickLine(PET_LINES), 1100)
  }

  function hover(): void {
    const now = performance.now()
    if (s.mode !== 'rest' || s.line || s.asleep || now - s.lastHover < 30_000) return
    s.lastHover = now
    flash('happy', 900)
    if (Math.random() < 0.6) quip(pickLine(HOVER_LINES), 1300)
  }

  function startDrag(): void {
    s.mode = 'drag'
    s.arrive = null
    s.target = null
    s.dragV = { x: 0, y: 0 }
    if (s.asleep) {
      s.asleep = false
      setAsleep(false)
    }
    flash('surprised', 60_000)
    quip(LIFT_LINE, 900)
  }

  function drop(): void {
    s.lastActive = performance.now()
    flash('happy', 1000)
    const fling = s.reduced
      ? { x: 0, y: 0 }
      : { x: clamp(s.dragV.x, -700, 700), y: clamp(s.dragV.y, -700, 700) }
    // Let a throw carry him a little way, then settle on clear water nearby.
    const glide = {
      x: clamp(s.m.x + fling.x * 0.22, s.bounds.x, s.bounds.x + s.bounds.w - W),
      y: clamp(s.m.y + fling.y * 0.22, s.bounds.y, s.bounds.y + s.bounds.h - H)
    }
    const landing = { ...glide, w: W, h: H }
    const clear = within(landing, s.bounds) && blocked(landing, s.avoid) === 0
    const settle = (): void => {
      if (s.pendingExit) {
        s.pendingExit = false
        leave()
        return
      }
      if (Math.random() < 0.7) quip(pickLine(DROP_LINES), 1500)
      s.nextBeat = performance.now() + 3200
    }
    s.m.vx = fling.x
    s.m.vy = fling.y
    s.mode = 'rest'
    // Back in the water with a splash.
    water((w) => w.splash(disc(), performance.now()))
    swimTo(clear ? glide : spot(true), settle)
  }

  /* ----------------------------- the frame loop ----------------------------- */

  function tick(now: number, dt: number): void {
    if (s.gone) return
    if (now - s.measuredAt > 500) measure(now)
    const m = s.m

    if ((s.mode === 'enter' || s.mode === 'swim' || s.mode === 'exit') && s.target) {
      const left = steer(
        m,
        s.target,
        dt,
        s.mode === 'exit' ? 380 : s.mode === 'enter' ? 300 : s.speed,
        900
      )
      water((w) => w.stir(disc(), m.vx, m.vy, now))
      if (left < 1.5 && Math.hypot(m.vx, m.vy) < 14) {
        m.x = s.target.x
        m.y = s.target.y
        m.vx = 0
        m.vy = 0
        const done = s.arrive
        s.arrive = null
        s.target = null
        if (s.mode !== 'exit') s.mode = 'rest'
        done?.()
      }
    } else if (s.mode === 'drag' && s.pointer) {
      const k = s.reduced ? 1 : Math.min(1, dt * 22)
      const nx = clamp(m.x + (s.pointer.x - s.grab.x - m.x) * k, -W / 2, s.view.w - W / 2)
      const ny = clamp(m.y + (s.pointer.y - s.grab.y - m.y) * k, -H / 2, s.view.h - H / 2)
      const step = Math.max(dt, 0.001)
      s.dragV.x = s.dragV.x * 0.7 + ((nx - m.x) / step) * 0.3
      s.dragV.y = s.dragV.y * 0.7 + ((ny - m.y) / step) * 0.3
      m.x = nx
      m.y = ny
      m.vx = s.dragV.x
      m.vy = s.dragV.y
    } else if (s.mode === 'rest') {
      if (now - s.lastCheck > 900) {
        s.lastCheck = now
        // The layout moved under him (a log opened, the window shrank).
        if (!within(box(), s.bounds) || blocked(box(), s.avoid) > 0) swimTo(spot(true))
      }
      if (s.phase === 'running' && !s.line && !s.asleep) {
        if (now - s.lastActive > NAP_AFTER) nap()
        else if (now >= s.nextBeat) beat(now)
      }
    }
    water((w) => w.draw(now, s.avoid))
    paint(now, dt)
  }

  /** Write his position, bank and gaze, and place the bubble. */
  function paint(now: number, dt: number): void {
    const actor = actorRef.current
    const body = bodyRef.current
    if (!actor || !body) return
    const m = s.m
    const speed = Math.hypot(m.vx, m.vy)
    const ease = Math.min(1, dt * 6)

    // A ray turns like a glider: he banks into the turn, and his tail swings
    // out behind him.
    const bank = speed > 20 || s.mode === 'drag' ? clamp(m.vx / 1100, -0.34, 0.34) : 0
    s.bank += (bank - s.bank) * ease
    s.steer += (clamp(-m.vx / 9, -30, 30) - s.steer) * ease

    if (!s.swimming && (speed > 60 || s.mode === 'drag')) s.swimming = true
    else if (s.swimming && speed < 25 && s.mode !== 'drag') s.swimming = false
    actor.classList.toggle('is-swimming', s.swimming)
    actor.classList.toggle('is-dragging', s.mode === 'drag')

    actor.style.transform = `translate3d(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px, 0)`
    body.style.transform = `rotate(${s.bank.toFixed(3)}rad)`
    actor.style.setProperty('--ray-steer', `${s.steer.toFixed(1)}deg`)

    // He watches the cursor; with nobody around, he looks where he's going.
    let lx = 0
    let ly = 0.15
    if (s.pointer) {
      lx = clamp((s.pointer.x - (m.x + W * RAY_EYES.x)) / 220, -1, 1)
      ly = clamp((s.pointer.y - (m.y + H * RAY_EYES.y)) / 180, -1, 1)
    } else if (speed > 30) {
      lx = clamp(m.vx / 250, -1, 1)
      ly = clamp(m.vy / 250, -1, 1)
    }
    actor.style.setProperty('--ray-lx', lx.toFixed(2))
    actor.style.setProperty('--ray-ly', ly.toFixed(2))

    const bubble = bubbleRef.current
    if (bubble) {
      if (s.bubble.w === 0) s.bubble = { w: bubble.offsetWidth, h: bubble.offsetHeight }
      const place = placeBubble({
        actor: box(),
        bubble: s.bubble,
        bounds: s.view,
        avoid: s.avoid,
        aimX: m.x + W / 2
      })
      bubble.style.transform = `translate3d(${place.x.toFixed(1)}px, ${place.y.toFixed(1)}px, 0)`
      bubble.style.setProperty('--tail-x', `${place.tail.toFixed(1)}px`)
      bubble.classList.toggle('is-below', place.below)
    }
  }

  /* ----------------------------- lifecycle ----------------------------- */

  // Swim in on mount, positioned before the first paint so he never flashes
  // at the corner. Everything it needs is in refs, so it runs once.
  useLayoutEffect(() => {
    s.gone = false
    if (s.phase !== 'running') {
      finish()
      return
    }
    enter()
    paint(performance.now(), 0)
  }, [])

  const seen = useRef({ phase, phaseKey })
  useEffect(() => {
    const prev = seen.current
    if (prev.phase === phase && prev.phaseKey === phaseKey) return
    seen.current = { phase, phaseKey }
    clearSet(timers)
    s.arrive = null
    s.pendingExit = false
    if (s.asleep) {
      s.asleep = false
      setAsleep(false)
    }
    const occ = props.current.occasion
    switch (phase) {
      case 'running':
        // Back for more: a retry after an error, or another install.
        setBase('idle')
        setFading(false)
        s.started = performance.now()
        s.slowSaid = false
        if (s.mode === 'exit') {
          s.mode = 'rest'
          swimTo(spot())
        }
        say(prev.phase === 'error' ? RETRY_LINE : RESUME_LINE)
        break
      case 'success':
        setBase('happy')
        setWave((n) => (n ?? 0) + 1)
        if (!s.reduced) burst('confetti', 46, middle())
        say(successLine(occ), { linger: occ === 'prepare' ? 2200 : 4200, after: leave })
        break
      case 'error':
        setBase('worried')
        say(errorLine(occ), { linger: 9000 })
        break
      case 'leaving':
        s.lineAfter = null
        if (s.line) hush()
        leave()
        break
      case 'bye':
        setBase('happy')
        say(BYE_LINE, { linger: 1600, after: leave })
        break
    }
  }, [phase, phaseKey])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const frame = (now: number): void => {
      const dt = clamp((now - last) / 1000, 0, 0.05)
      last = now
      tick(now, dt)
      raf = window.requestAnimationFrame(frame)
    }
    raf = window.requestAnimationFrame(frame)
    return () => window.cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      s.pointer = { x: e.clientX / s.scale, y: e.clientY / s.scale }
      s.lastActive = performance.now()
      if (s.asleep && s.mode !== 'drag') wake()
    }
    const onOut = (e: PointerEvent): void => {
      if (!e.relatedTarget) s.pointer = null
    }
    const onKey = (): void => {
      s.lastActive = performance.now()
      if (s.asleep) wake()
    }
    window.addEventListener('pointermove', onMove)
    document.addEventListener('pointerout', onOut)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerout', onOut)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Size a new bubble and place it before it paints.
  useLayoutEffect(() => {
    const el = bubbleRef.current
    if (!el) return
    s.bubble = { w: el.offsetWidth, h: el.offsetHeight }
    paint(performance.now(), 0)
  }, [lineId])

  /* ----------------------------- input ----------------------------- */

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>): void {
    if (e.button !== 0 || s.mode === 'exit') return
    const p = { x: e.clientX / s.scale, y: e.clientY / s.scale }
    s.down = p
    s.pointer = p
    s.grab = { x: p.x - s.m.x, y: p.y - s.m.y }
    s.suppressClick = false
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>): void {
    if (!s.down || s.mode === 'drag' || s.mode === 'exit') return
    if (Math.hypot(e.clientX / s.scale - s.down.x, e.clientY / s.scale - s.down.y) > 5) startDrag()
  }

  function onPointerUp(): void {
    if (!s.down) return
    s.down = null
    if (s.mode === 'drag') {
      s.suppressClick = true
      drop()
    }
  }

  function onClick(): void {
    if (s.suppressClick) {
      s.suppressClick = false
      return
    }
    if (s.mode !== 'exit') pet()
  }

  const mood: RayMood = flashMood ?? (asleep ? 'sleep' : talking ? 'talk' : base)

  return (
    <div ref={layerRef} className={`mascot-stage${fading ? ' is-fading' : ''}`}>
      {/* The water he swims in: his wake is drawn under him, never over him. */}
      <canvas ref={wakeRef} className="mascot-wake" aria-hidden="true" />
      <div ref={actorRef} className="mascot-roamer" style={{ width: W, height: H }}>
        <div ref={bodyRef} className="mascot-roamer-body">
          <div ref={bobRef} className="mascot-roamer-bob">
            <div ref={squishRef} className="mascot-roamer-squish">
              <Ray mood={mood} wave={wave} />
            </div>
          </div>
        </div>
        <button
          type="button"
          className="mascot-roamer-hit"
          aria-label="Ray, the Fabricator stingray. Select to pet him."
          aria-describedby={sayId}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerEnter={hover}
          onClick={onClick}
        />
        <button
          type="button"
          className="mascot-roamer-close"
          aria-label="Send Ray away for now"
          title="Send Ray away for now"
          onClick={() => props.current.onDismiss()}
        >
          <Codicon name="close" />
        </button>
        <span id={sayId} className="sr-only">
          {line?.text ?? ''}
        </span>
      </div>
      <Particles particles={particles} />
      {line && (
        <SpeechBubble
          key={lineId}
          ref={bubbleRef}
          line={line}
          typing={!reduced}
          onClick={() => {
            hush()
            s.nextBeat = performance.now() + 450
          }}
        />
      )}
    </div>
  )
}
