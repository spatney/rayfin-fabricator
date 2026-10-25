// The startup screen. One lockup in every form: Ray, the "Fabricator" wordmark
// building itself (the mark's tiles glide in to make its F, then the letters
// rise), and a plain line under it saying what's happening.
//
// The first time Fabricator starts, the screen is Ray's: he swims up, says hello
// and, in his own words, tells you how the startup checks are going. Once setup
// has passed, launches get a shorter version that covers the app while it loads:
// Ray swims in, leaving ripples on the water, says welcome back, and darts off as
// the screen fades into your project.
//
// Flat like the rest of the app: solid canvas, hairline ripples, no glows.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX
} from 'react'
import type { StartupStage } from '../startup'
import { MARK_TILE_RX, MARK_TILES, MarkGradient } from './FabricatorMark'
import { ProjectMark } from './AppBar'
import { type RayMood } from './mascot/Ray'
import { RayPerch } from './mascot/RayPerch'
import { useReducedMotion } from './mascot/context'
import { Wake } from './mascot/wake'
import { firstMeeting, launchGreeting, rememberMeeting, SPLASH_LINES, splashGreeting } from './mascot/lines'

/** Each line stays up at least this long, so none flashes by unread. */
const LINE_MS = 1700
/** When a step takes a while, Ray moves on to its next line this often. */
const ROTATE_MS = 3600
const RAY_W = 184

/** The mark's tiles, cropped to their bounds so the F can sit on a baseline. */
const F_BOUNDS = MARK_TILES.reduce(
  (b, t) => ({
    x1: Math.min(b.x1, t.x),
    y1: Math.min(b.y1, t.y),
    x2: Math.max(b.x2, t.x + t.w),
    y2: Math.max(b.y2, t.y + t.h)
  }),
  { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
)
const F_VIEWBOX = `${F_BOUNDS.x1} ${F_BOUNDS.y1} ${F_BOUNDS.x2 - F_BOUNDS.x1} ${F_BOUNDS.y2 - F_BOUNDS.y1}`

/**
 * Where each of the F's tiles glides in from, in the mark's units, and when: the
 * same moves as the self-building mark, at word size.
 */
const F_TILE_IN: Record<string, { x: number; y: number; order: number }> = {
  'tile--stem': { x: -120, y: 0, order: 0 },
  'tile--topbar': { x: 0, y: -110, order: 1 },
  'tile--mid': { x: 120, y: 0, order: 2 },
  'tile--botleft': { x: 0, y: 110, order: 3 },
  'tile--square': { x: 0, y: 70, order: 4 }
}
/** When the word starts to build, and the beat between its pieces (seconds). */
const WORD_AT = 0.45
const TILE_BEAT = 0.07
const LETTER_AT = WORD_AT + 0.32
const LETTER_BEAT = 0.035

/**
 * "Fabricator" with the mark as its F, cap-height and on the baseline like any
 * letter. It builds itself: the F's tiles glide into place, then the letters
 * rise in one after another. Only the tiles: at text size the mark's thin corner
 * brackets would blur. `start` is when the build begins, in seconds.
 */
function Wordmark({ start = WORD_AT }: { start?: number }): JSX.Element {
  const gid = 'splash-f-' + useId().replace(/:/g, '')
  const lettersAt = start + (LETTER_AT - WORD_AT)
  return (
    <span className="splash-word splash-word--mark">
      <span className="sr-only">Fabricator</span>
      <span aria-hidden="true">
        <svg className="splash-word-f" viewBox={F_VIEWBOX} xmlns="http://www.w3.org/2000/svg">
          <defs>
            <MarkGradient id={gid} />
          </defs>
          {MARK_TILES.map((t) => {
            const from = F_TILE_IN[t.cls] ?? { x: 0, y: 0, order: 0 }
            const style = {
              '--fx': `${from.x}px`,
              '--fy': `${from.y}px`,
              animationDelay: `${start + from.order * TILE_BEAT}s`
            } as CSSProperties
            return (
              <rect
                key={t.cls}
                x={t.x}
                y={t.y}
                width={t.w}
                height={t.h}
                rx={MARK_TILE_RX}
                fill={`url(#${gid})`}
                style={style}
              />
            )
          })}
        </svg>
        {Array.from('abricator').map((letter, i) => (
          <span
            key={i}
            className="splash-word-letter"
            style={{ animationDelay: `${lettersAt + i * LETTER_BEAT}s` }}
          >
            {letter}
          </span>
        ))}
      </span>
    </span>
  )
}

/** The stage a line belongs to; none for his hello. */
function stageOf(text: string): StartupStage | undefined {
  return (Object.keys(SPLASH_LINES) as StartupStage[]).find((s) => SPLASH_LINES[s].includes(text))
}

/**
 * What Ray says: his hello, then a line for each stage of the startup checks.
 * Every line stays up for LINE_MS at least, and a stage that's over by then is
 * skipped, so he never talks faster than you can read.
 */
function useNarration(stage: StartupStage, greeting: string): string {
  const [beat, setBeat] = useState(0)
  useEffect(() => {
    setBeat(0)
    if (SPLASH_LINES[stage].length < 2) return
    const timer = window.setInterval(() => setBeat((n) => n + 1), ROTATE_MS)
    return () => window.clearInterval(timer)
  }, [stage])
  const lines = SPLASH_LINES[stage]
  const wanted = lines[beat % lines.length]

  const [shown, setShown] = useState(greeting)
  const shownAt = useRef(Date.now())
  useEffect(() => {
    if (wanted === shown) return
    const timer = window.setTimeout(
      () => {
        shownAt.current = Date.now()
        setShown(wanted)
      },
      Math.max(0, shownAt.current + LINE_MS - Date.now())
    )
    return () => window.clearTimeout(timer)
  }, [wanted, shown])
  return shown
}

/**
 * Ray swims up, waves, and talks you through startup. His eyes follow the
 * pointer, he blows the odd bubble while he waits, celebrates when everything
 * checks out, and likes being petted.
 */
function SplashRay({ stage }: { stage: StartupStage }): JSX.Element {
  const [firstTime] = useState(firstMeeting)
  const text = useNarration(stage, splashGreeting(firstTime))
  const said = stageOf(text)

  // Introduced now, so his hellos elsewhere won't introduce him again.
  useEffect(() => {
    if (firstTime) rememberMeeting()
  }, [firstTime])

  const mood: RayMood = said === 'ready' ? 'happy' : said === 'error' ? 'worried' : 'idle'

  return (
    <RayPerch
      line={{ kind: 'chat', text }}
      mood={mood}
      size={RAY_W}
      bubbling={said !== 'ready' && said !== 'setup' && said !== 'error'}
      celebrate={said === 'ready' ? 1 : 0}
    >
      <span className="sr-only" role="status">
        {text}
      </span>
    </RayPerch>
  )
}

type Point2 = readonly [number, number]
/** A cubic Bézier curve: where it starts, two control points, where it ends. */
type Curve = readonly [Point2, Point2, Point2, Point2]

/**
 * Where Ray is `t` (0…1) along `curve`, as an offset from where he rests, and
 * how far round he's turned: his nose points up at rest, so facing the way he
 * swims is the curve's direction turned a quarter.
 */
export function swimPoint(curve: Curve, t: number): { x: number; y: number; angle: number } {
  const [a, b, c, d] = curve
  const u = 1 - t
  const at = (i: 0 | 1): number =>
    u * u * u * a[i] + 3 * u * u * t * b[i] + 3 * u * t * t * c[i] + t * t * t * d[i]
  const slope = (i: 0 | 1): number =>
    3 * (u * u * (b[i] - a[i]) + 2 * u * t * (c[i] - b[i]) + t * t * (d[i] - c[i]))
  return { x: at(0), y: at(1), angle: (Math.atan2(slope(1), slope(0)) * 180) / Math.PI + 90 }
}

/** In from the left, low and level, curving up into his spot nose first. It
 *  stays clear of the wordmark, which builds under him as he arrives. */
export const SWIM_IN: Curve = [[-330, 55], [-170, 70], [0, 80], [0, 0]]
/** Out, once the app is ready: up and away to the right. */
export const SWIM_OUT: Curve = [[0, 0], [0, -90], [70, -200], [240, -330]]
const SWIM_IN_MS = 950
const SWIM_OUT_MS = 420
/** He starts talking as he settles. */
export const SPEAK_AT_MS = 700
/** How long his ripples take to settle once he stops, in ms (as in the wake). */
const WATER_SETTLE_MS = 1100

const easeOut = (s: number): number => 1 - (1 - s) ** 3
const easeIn = (s: number): number => s ** 2.2

interface Swim {
  curve: Curve
  ms: number
  ease: (s: number) => number
  out: boolean
  start: number | null
  last: { x: number; y: number; at: number } | null
}

/**
 * Ray on the launch screen. He swims in from low on the left, leaving ripples
 * on the water, settles with a ring of them, waves and says welcome back. When
 * the screen lifts (`leaving`), he darts up and away. The swim is driven a frame
 * at a time so his wake can follow him; with reduced motion he's simply there.
 */
function LaunchRay({ leaving }: { leaving: boolean }): JSX.Element {
  const reduced = useReducedMotion()
  const [firstTime] = useState(firstMeeting)
  const [text] = useState(() => (firstTime ? 'Hi, I’m Ray! Welcome back.' : launchGreeting()))
  const [speaking, setSpeaking] = useState(reduced)
  const hostRef = useRef<HTMLDivElement>(null)
  const waterRef = useRef<HTMLCanvasElement>(null)
  const swimRef = useRef<((swim: Omit<Swim, 'start' | 'last'>) => void) | null>(null)

  useEffect(() => {
    if (firstTime) rememberMeeting()
  }, [firstTime])

  useEffect(() => {
    if (reduced) return
    const timer = window.setTimeout(() => setSpeaking(true), SPEAK_AT_MS)
    return () => window.clearTimeout(timer)
  }, [reduced])

  // Before the first paint, so he never shows in his spot before swimming in.
  useLayoutEffect(() => {
    const ray = hostRef.current?.querySelector<HTMLElement>('.ray-perch-ray')
    const canvas = waterRef.current
    if (reduced || !ray || !canvas) return

    const room = canvas.getBoundingClientRect()
    const rest = ray.getBoundingClientRect()
    // The middle of his disc, where he stirs the water, as he rests.
    const home = {
      x: rest.left - room.left + rest.width / 2,
      y: rest.top - room.top + rest.height * 0.45
    }
    // The water is only for looks: if it can't be drawn, he swims without it.
    let water: Wake | null = null
    try {
      if (canvas.getContext('2d')) {
        water = new Wake(canvas)
        water.fit(room.width, room.height, window.devicePixelRatio || 1)
      }
    } catch {
      water = null
    }

    let swim: Swim | null = null
    let stillUntil = 0
    let frame = 0

    const place = (s: Swim, now: number): boolean => {
      s.start ??= now
      const k = Math.min(1, (now - s.start) / s.ms)
      const p = swimPoint(s.curve, s.ease(k))
      const scale = s.out ? 1 - 0.12 * k : 0.86 + 0.14 * s.ease(k)
      const opacity = s.out ? Math.min(1, (1 - k) / 0.4) : Math.min(1, k / 0.15)
      ray.style.transform = `translate(${p.x}px, ${p.y}px) rotate(${p.angle}deg) scale(${scale})`
      ray.style.opacity = String(opacity)
      if (water && s.last && now > s.last.at) {
        const dt = (now - s.last.at) / 1000
        water.stir(
          { x: home.x + p.x, y: home.y + p.y },
          (p.x - s.last.x) / dt,
          (p.y - s.last.y) / dt,
          now
        )
        stillUntil = now + WATER_SETTLE_MS
      }
      s.last = { x: p.x, y: p.y, at: now }
      return k >= 1
    }

    const tick = (now: number): void => {
      frame = 0
      if (swim && place(swim, now)) {
        if (!swim.out) {
          // Settled: back to his own spot, with a ring of ripples round him.
          ray.style.transform = ''
          ray.style.opacity = ''
          water?.splash(home, now)
          stillUntil = now + WATER_SETTLE_MS
        }
        swim = null
      }
      water?.draw(now, [])
      if (swim || now < stillUntil) frame = requestAnimationFrame(tick)
    }

    swimRef.current = (next) => {
      swim = { ...next, start: null, last: null }
      if (!frame) frame = requestAnimationFrame(tick)
    }
    // Start him off at the beginning of his way in.
    swimRef.current({ curve: SWIM_IN, ms: SWIM_IN_MS, ease: easeOut, out: false })
    place({ curve: SWIM_IN, ms: SWIM_IN_MS, ease: easeOut, out: false, start: 0, last: null }, 0)

    return () => {
      swimRef.current = null
      if (frame) cancelAnimationFrame(frame)
      ray.style.transform = ''
      ray.style.opacity = ''
    }
  }, [reduced])

  useEffect(() => {
    if (leaving) swimRef.current?.({ curve: SWIM_OUT, ms: SWIM_OUT_MS, ease: easeIn, out: true })
  }, [leaving])

  return (
    <>
      <canvas ref={waterRef} className="mascot-wake splash-water" aria-hidden="true" />
      <div ref={hostRef} className="launch-ray">
        <RayPerch
          line={{ kind: 'chat', text: speaking ? text : '' }}
          mood={speaking ? 'happy' : 'idle'}
          size={RAY_W}
        >
          <span className="sr-only" role="status">
            {text}
          </span>
        </RayPerch>
      </div>
    </>
  )
}

/** The line under the wordmark at a first launch, by how far the checks have got. */
const STAGE_STATUS: Record<StartupStage, { text: string; ongoing: boolean }> = {
  tools: { text: 'Checking your tools', ongoing: true },
  accounts: { text: 'Checking your sign-ins', ongoing: true },
  ready: { text: 'All set', ongoing: false },
  setup: { text: 'A few things to set up first', ongoing: false },
  error: { text: 'Something needs a look', ongoing: false }
}

/**
 * The plain line under the wordmark: where the app is headed once that's known
 * (`opening` is the open project's name, or null for Home), and otherwise, at a
 * first launch, how the checks are going. The project shows with its initial
 * on its own hue, as it then appears in the app bar.
 */
function SplashStatus({
  launch,
  stage,
  opening
}: {
  launch: boolean
  stage: StartupStage
  opening?: string | null
}): JSX.Element {
  const heading = opening !== undefined && (launch || stage === 'ready')
  const plain = heading || launch ? null : STAGE_STATUS[stage]
  const key = heading ? `open:${opening ?? ''}` : plain ? stage : ''
  return (
    <span className="splash-status" aria-live="polite">
      {(heading || plain) && (
        <span key={key} className="splash-status-line">
          {heading && opening ? (
            <>
              <ProjectMark name={opening} className="project-switcher-mark splash-status-mark" />
              <span>
                Opening <b>{opening}</b>
              </span>
            </>
          ) : (
            <span>{heading ? 'Opening your projects' : plain?.text}</span>
          )}
          {(heading || plain?.ongoing) && (
            <span className="splash-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
        </span>
      )}
    </span>
  )
}

/** When the wordmark starts building at a later launch (seconds): as Ray arrives. */
const LAUNCH_WORD_AT = 0.5

/**
 * The startup screen. `stage`: how far the startup checks have got, for Ray to
 * narrate. `launch`: setup passed here before, so this only covers the app while
 * it loads; the checks run in the background. `opening`: the project the app is
 * opening (null for Home) once it's known. `leaving`: the screen is fading away
 * into the app.
 */
export default function SplashScreen({
  stage = 'tools',
  launch = false,
  opening,
  leaving = false
}: {
  stage?: StartupStage
  launch?: boolean
  opening?: string | null
  leaving?: boolean
}): JSX.Element {
  return (
    <div className={`splash${launch ? ' splash--launch' : ''}`}>
      {launch ? <LaunchRay leaving={leaving} /> : <SplashRay stage={stage} />}
      <div className="splash-brand">
        <Wordmark start={launch ? LAUNCH_WORD_AT : WORD_AT} />
        <SplashStatus launch={launch} stage={stage} opening={opening} />
      </div>
    </div>
  )
}
