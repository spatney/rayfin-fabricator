/**
 * Ray, Fabricator's mascot: a small spotted stingray, seen from above with his
 * nose up, in the brand mark's blues with a green tip to his tail. Flat like
 * the rest of the app: solid shapes, no glows or shading.
 *
 * His disc is two halves that meet down his middle. Each half skews about that
 * line to beat its wing, so the middle never moves and no seam ever opens.
 *
 * This component only draws him. A parent steers him with CSS variables on
 * any ancestor, so it can do so every frame without re-rendering React:
 * `--ray-lx` / `--ray-ly` (-1…1) aim his eyes, and `--ray-steer` swings his
 * tail.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import './mascot.css'

export type RayMood =
  /** Eyes open, small smile. */
  | 'idle'
  /** Mouth moving, for while a line is typed out. */
  | 'talk'
  /** Eyes closed in a smile, mouth open. */
  | 'happy'
  /** Happy, and blushing hard. For being petted. */
  | 'love'
  /** Wide eyes, round mouth. */
  | 'surprised'
  /** Round mouth, for blowing bubbles. */
  | 'blow'
  | 'sleep'
  | 'dizzy'
  /** Raised brows and a small frown. For when something failed. */
  | 'worried'
  /** Eyes down on the page. Pairs with `glasses`. */
  | 'read'

export interface RayProps {
  mood?: RayMood
  /** Reading glasses, worn while Help works. */
  glasses?: boolean
  /** Wave a wing as a hello. Each new value waves again. */
  wave?: number
  /** Blink now and then. Off for tiny or static renders. */
  blink?: boolean
  className?: string
  style?: CSSProperties
  /** Accessible name; decorative (hidden) when omitted. */
  title?: string
}

/** The SVG's coordinate space. */
export const RAY_VIEWBOX = { w: 160, h: 128 }

/** Between his eyes and at his mouth, as fractions of the drawing. */
export const RAY_EYES = { x: 80 / 160, y: 40 / 128 }
export const RAY_MOUTH = { x: 80 / 160, y: 55 / 128 }

const OPEN_EYES: ReadonlySet<RayMood> = new Set([
  'idle',
  'talk',
  'surprised',
  'blow',
  'worried',
  'read'
])

const EYE_L = 67
const EYE_R = 93
const EYE_Y = 40

const RIGHT_RIM =
  'M79.5 15L80 15C90 15 113 29 139 48C146.5 53.5 146 61.5 139 63.5C119.5 68.5 101.5 76.5 88.5 88.5C85.5 91.5 82.5 93 80 93L79.5 93Z'
const LEFT_RIM =
  'M80.5 15L80 15C70 15 47 29 21 48C13.5 53.5 14 61.5 21 63.5C40.5 68.5 58.5 76.5 71.5 88.5C74.5 91.5 77.5 93 80 93L80.5 93Z'
// The fills cross the middle 1px further than the rims, so where the halves
// meet, light always lies over light and no dark seam shows down his middle.
const RIGHT_DISC =
  'M79 18.8L80 18.8C89 18.8 111 32 135.5 50C140.5 53.8 140.2 58.6 135.4 59.9C116.8 64.8 99.8 72.4 87.2 84C84.7 86.3 82.4 87.6 80 87.6L79 87.6Z'
const LEFT_DISC =
  'M81 18.8L80 18.8C71 18.8 49 32 24.5 50C19.5 53.8 19.8 58.6 24.6 59.9C43.2 64.8 60.2 72.4 72.8 84C75.3 86.3 77.6 87.6 80 87.6L81 87.6Z'
const TAIL =
  'M77 88C76.5 100 79 110.5 87 117C91 120 96 121.6 101.5 121C96.8 119.8 92.6 117.6 89.3 113.8C84.6 108.3 83 99.5 83 88Z'

/** Pale spots, like a spotted eagle ray's, mirrored across his middle. */
const SPOTS: ReadonlyArray<[number, number, number]> = [
  [112, 60, 3.2],
  [124, 57.5, 2.5],
  [104, 69, 2.4],
  [117, 67, 1.8]
]

/** Random gaps between blinks, with the occasional double blink. */
function useBlink(enabled: boolean): boolean {
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let timer = 0
    const schedule = (delay: number): void => {
      timer = window.setTimeout(() => {
        setClosed(true)
        timer = window.setTimeout(() => {
          setClosed(false)
          schedule(Math.random() < 0.14 ? 170 : 2200 + Math.random() * 4200)
        }, 120)
      }, delay)
    }
    schedule(1400 + Math.random() * 2600)
    return () => window.clearTimeout(timer)
  }, [enabled])
  return enabled && closed
}

/** True for a moment after `wave` changes. */
function useWave(wave: number | undefined): boolean {
  const [waving, setWaving] = useState(false)
  useEffect(() => {
    if (wave === undefined) return
    setWaving(true)
    const timer = window.setTimeout(() => setWaving(false), 1300)
    return () => window.clearTimeout(timer)
  }, [wave])
  return waving
}

export function Ray({
  mood = 'idle',
  glasses = false,
  wave,
  blink = true,
  className,
  style,
  title
}: RayProps): JSX.Element {
  const blinking = useBlink(blink && OPEN_EYES.has(mood))
  const waving = useWave(wave)

  const classes = ['ray', `ray--${mood}`]
  if (blinking) classes.push('is-blinking')
  if (waving) classes.push('is-waving')
  if (className) classes.push(className)

  return (
    <svg
      className={classes.join(' ')}
      style={style}
      viewBox={`0 0 ${RAY_VIEWBOX.w} ${RAY_VIEWBOX.h}`}
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}

      {/* The tail swings away from where he's heading, and sways on its own. */}
      <g className="ray-tail">
        <g className="ray-tail-sway">
          <path className="ray-rim" d={TAIL} />
          <rect
            className="ray-tail-tip"
            x="99"
            y="118.6"
            width="5"
            height="5"
            rx="1.4"
            transform="rotate(45 101.5 121.1)"
          />
        </g>
      </g>

      {/* Rising and sinking a little with each beat of his wings. Each half
          beats as one group, so its rim and fill can never fall out of step. */}
      <g className="ray-rig">
        <g className="ray-half ray-half--l">
          <path className="ray-rim" d={LEFT_RIM} />
          <path className="ray-disc" d={LEFT_DISC} />
          {SPOTS.map(([x, y, r]) => (
            <circle key={x} className="ray-spot" cx={160 - x} cy={y} r={r} />
          ))}
        </g>
        <g className="ray-half ray-half--r">
          <path className="ray-rim" d={RIGHT_RIM} />
          <path className="ray-disc" d={RIGHT_DISC} />
          {SPOTS.map(([x, y, r]) => (
            <circle key={x} className="ray-spot" cx={x} cy={y} r={r} />
          ))}
        </g>

        {mood !== 'worried' && mood !== 'dizzy' && (
          <g className="ray-blush">
            <ellipse cx="56.5" cy="51" rx="4.2" ry="2.5" />
            <ellipse cx="103.5" cy="51" rx="4.2" ry="2.5" />
          </g>
        )}
        <Eyes mood={mood} />
        {mood === 'worried' && (
          <path className="ray-line" d="M58.5 30.5L70.5 27M89.5 27L101.5 30.5" />
        )}
        <Mouth mood={mood} />
        {glasses && (
          <g className="ray-glasses">
            <rect x="57" y="30.5" width="20" height="19" rx="6.5" />
            <rect x="83" y="30.5" width="20" height="19" rx="6.5" />
            <path d="M77 39.5H83" />
          </g>
        )}
      </g>
    </svg>
  )
}

function OpenEye({ cx, wide }: { cx: number; wide: boolean }): JSX.Element {
  return (
    <>
      <circle className="ray-sclera" cx={cx} cy={EYE_Y} r={wide ? 9.4 : 8.6} />
      <g className="ray-pupil">
        <circle className="ray-iris" cx={cx + 1.2} cy={EYE_Y + 1.3} r={wide ? 3.2 : 5} />
        <circle className="ray-glint" cx={cx + 3.4} cy={EYE_Y - 1.4} r={wide ? 1.2 : 1.9} />
      </g>
    </>
  )
}

function Eyes({ mood }: { mood: RayMood }): JSX.Element {
  switch (mood) {
    case 'happy':
    case 'love':
      return (
        <path
          className="ray-line ray-line--eye"
          d="M59.5 42.5Q67 34 74.5 42.5M85.5 42.5Q93 34 100.5 42.5"
        />
      )
    case 'sleep':
      return (
        <path
          className="ray-line ray-line--eye"
          d="M59.5 39Q67 45.5 74.5 39M85.5 39Q93 45.5 100.5 39"
        />
      )
    case 'dizzy':
      return (
        <g>
          {[EYE_L, EYE_R].map((cx, i) => (
            <g key={cx}>
              <circle className="ray-sclera" cx={cx} cy={EYE_Y} r="8.6" />
              <path
                className={`ray-spiral ray-spiral--${i === 0 ? 'l' : 'r'}`}
                d={`M${cx} ${EYE_Y}a1.7 1.7 0 1 1 3.4 0a3.4 3.4 0 1 1-6.8 0a5.1 5.1 0 1 1 10.2 0`}
              />
            </g>
          ))}
        </g>
      )
    default:
      return (
        <g className="ray-eyes">
          <OpenEye cx={EYE_L} wide={mood === 'surprised'} />
          <OpenEye cx={EYE_R} wide={mood === 'surprised'} />
        </g>
      )
  }
}

function Mouth({ mood }: { mood: RayMood }): JSX.Element {
  switch (mood) {
    case 'happy':
    case 'love':
      return (
        <g>
          <path className="ray-mouth" d="M72.5 52Q80 64.5 87.5 52Z" />
          <path className="ray-tongue" d="M76.4 58.4Q80 62.2 83.6 58.4Q80 56.4 76.4 58.4Z" />
        </g>
      )
    case 'surprised':
    case 'blow':
      return <ellipse className="ray-mouth" cx="80" cy="55.5" rx="3.1" ry="3.8" />
    case 'talk':
      return <ellipse className="ray-mouth ray-mouth--talk" cx="80" cy="55" rx="4" ry="3.6" />
    case 'sleep':
    case 'read':
      return <path className="ray-line" d="M75.5 55Q80 57 84.5 55" />
    case 'dizzy':
      return <path className="ray-line" d="M72.5 55.5q2.5-2.8 5 0t5 0t5 0" />
    case 'worried':
      return <path className="ray-line" d="M74.5 57.5Q80 52.5 85.5 57.5" />
    default:
      return <path className="ray-line" d="M73.5 53.5Q80 59 86.5 53.5" />
  }
}

export default Ray
