/**
 * Ray on a screen of his own, such as the loading screen or the deploy screen:
 * he swims up and waves, says what the screen gives him in a speech bubble,
 * keeps an eye on the pointer, and likes being petted. The screen decides what
 * he says and how he feels; this draws him and does his tricks.
 */
import { useEffect, useRef, useState, type ReactNode, type JSX } from 'react'
import { Ray, RAY_MOUTH, RAY_VIEWBOX, type RayMood } from './Ray'
import { Particles, useParticles } from './Particles'
import { SpeechBubble, TYPE_MS } from './SpeechBubble'
import { useReducedMotion } from './context'
import { useRayGaze } from './gaze'
import type { MascotLine } from './lines'

export interface RayPerchProps {
  /** What he says. A new line types out while his mouth moves; an empty one
   *  keeps him quiet for now. */
  line: MascotLine
  /** How he looks while he isn't talking or being petted. */
  mood: RayMood
  glasses?: boolean
  /** His width, in px. */
  size: number
  /** Blow a couple of bubbles every few seconds. */
  bubbling?: boolean
  /** Each new non-zero value throws confetti. */
  celebrate?: number
  confetti?: number
  /** Each new non-zero value: a happy little hop and a few bubbles. */
  hop?: number
  className?: string
  children?: ReactNode
}

export function RayPerch({
  line,
  mood,
  glasses = false,
  size,
  bubbling = false,
  celebrate = 0,
  confetti = 24,
  hop = 0,
  className,
  children
}: RayPerchProps): JSX.Element {
  const reduced = useReducedMotion()
  const height = (size * RAY_VIEWBOX.h) / RAY_VIEWBOX.w
  const { particles, burst } = useParticles()
  const rayRef = useRef<HTMLButtonElement>(null)
  const squishRef = useRef<HTMLSpanElement>(null)
  const petTimer = useRef(0)
  const [arriving, setArriving] = useState(!reduced)
  const [wave, setWave] = useState<number | undefined>(undefined)
  const [talking, setTalking] = useState(false)
  const [petted, setPetted] = useState(false)
  useRayGaze(rayRef)

  useEffect(() => {
    const swim = window.setTimeout(() => setArriving(false), 1000)
    const hello = window.setTimeout(() => setWave(1), 1050)
    return () => {
      window.clearTimeout(swim)
      window.clearTimeout(hello)
      window.clearTimeout(petTimer.current)
    }
  }, [])

  // His mouth moves while a line types out.
  useEffect(() => {
    if (reduced || !line.text) return
    setTalking(true)
    const timer = window.setTimeout(() => setTalking(false), Array.from(line.text).length * TYPE_MS)
    return () => window.clearTimeout(timer)
  }, [line.text, reduced])

  useEffect(() => {
    if (reduced || !bubbling) return
    const timer = window.setInterval(
      () => burst('bubble', 2, { x: size * RAY_MOUTH.x, y: height * RAY_MOUTH.y }),
      3200
    )
    return () => window.clearInterval(timer)
  }, [bubbling, reduced, burst, size, height])

  useEffect(() => {
    if (reduced || !celebrate) return
    burst('confetti', confetti, { x: size / 2, y: height * 0.35 })
  }, [celebrate, confetti, reduced, burst, size, height])

  useEffect(() => {
    if (reduced || !hop) return
    const el = rayRef.current
    if (el && typeof el.animate === 'function') {
      el.animate(
        [
          { transform: 'translateY(0)' },
          { transform: 'translateY(-12px)', offset: 0.4 },
          { transform: 'translateY(0)' }
        ],
        { duration: 520, easing: 'cubic-bezier(0.3, 0, 0.3, 1)' }
      )
    }
    burst('bubble', 3, { x: size * RAY_MOUTH.x, y: height * RAY_MOUTH.y })
  }, [hop, reduced, burst, size, height])

  function pet(): void {
    setPetted(true)
    window.clearTimeout(petTimer.current)
    petTimer.current = window.setTimeout(() => setPetted(false), 1400)
    const el = squishRef.current
    if (el && typeof el.animate === 'function') {
      el.animate(
        [
          { transform: 'scale(1)' },
          { transform: 'scale(1.12, 0.86)' },
          { transform: 'scale(0.95, 1.07)' },
          { transform: 'scale(1)' }
        ],
        { duration: 420, easing: 'ease-out' }
      )
    }
    if (!reduced) burst('heart', 3, { x: size / 2, y: 12 })
  }

  const shown: RayMood = petted ? 'love' : talking ? 'talk' : mood

  return (
    <div className={`ray-perch${className ? ` ${className}` : ''}`}>
      <div className="ray-perch-bubble">
        {/* Nothing to say (yet): the bubble's room stays, so nothing moves when he speaks. */}
        {line.text && <SpeechBubble key={line.text} line={line} typing={!reduced} />}
      </div>
      <div
        className={`ray-perch-ray${arriving ? ' is-arriving' : ''}`}
        style={{ width: size, height }}
      >
        <button
          type="button"
          ref={rayRef}
          className="ray-perch-hit"
          onClick={pet}
          aria-label="Ray, the Fabricator stingray. Select to pet him."
        >
          <span className="ray-perch-bob">
            <span ref={squishRef} className="ray-perch-squish">
              <Ray mood={shown} wave={wave} glasses={glasses} />
            </span>
          </span>
        </button>
        <Particles particles={particles} />
      </div>
      {children}
    </div>
  )
}
