import { useEffect, useRef, useState } from 'react'
import { Ray, RAY_EYES, RAY_VIEWBOX, type RayMood } from '../mascot/Ray'
import { Particles, useParticles } from '../mascot/Particles'
import { useReducedMotion } from '../mascot/context'
import { HELP_WORKING } from '../mascot/lines'
import { Spinner } from './parts'

const SIZE_W = 76
const SIZE_H = (SIZE_W * RAY_VIEWBOX.h) / RAY_VIEWBOX.w
const TYPE_MS = 32
const clamp1 = (v: number): number => Math.min(1, Math.max(-1, v))

/**
 * Ray as the Help console's host: he waves when Help opens, follows the cursor
 * with his eyes (so he glances at whichever question you hover), and blushes
 * when petted.
 */
export function HelpRayAvatar(): JSX.Element {
  const reduced = useReducedMotion()
  const { particles, burst } = useParticles()
  const rayRef = useRef<HTMLButtonElement>(null)
  const squishRef = useRef<HTMLSpanElement>(null)
  const moodTimer = useRef(0)
  const [mood, setMood] = useState<RayMood>('idle')
  const [wave, setWave] = useState<number | undefined>(undefined)

  useEffect(() => {
    const timer = window.setTimeout(() => setWave(1), 350)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(moodTimer.current)
    }
  }, [])

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const el = rayRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const ex = r.left + r.width * RAY_EYES.x
      const ey = r.top + r.height * RAY_EYES.y
      el.style.setProperty('--ray-lx', clamp1((e.clientX - ex) / 260).toFixed(2))
      el.style.setProperty('--ray-ly', clamp1((e.clientY - ey) / 200).toFixed(2))
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  function pet(): void {
    setMood('love')
    window.clearTimeout(moodTimer.current)
    moodTimer.current = window.setTimeout(() => setMood('idle'), 1400)
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
    if (!reduced) burst('heart', 3, { x: SIZE_W / 2, y: 6 })
  }

  return (
    <span className="help-ray-avatar">
      <button
        type="button"
        ref={rayRef}
        className="help-ray-button"
        style={{ width: SIZE_W, height: SIZE_H }}
        onClick={pet}
        aria-label="Ray, the Fabricator stingray. Select to pet him."
      >
        <span ref={squishRef} className="help-ray-squish">
          <Ray mood={mood} wave={wave} />
        </span>
      </button>
      <Particles particles={particles} />
    </span>
  )
}

/**
 * A line Ray types out, terminal style, with a caret that rests once he's done.
 * The rest of the line is laid out but invisible, so nothing shifts while it
 * types and a screen reader hears the whole line at once.
 */
export function TypedLine({ text }: { text: string }): JSX.Element {
  const reduced = useReducedMotion()
  const chars = Array.from(text)
  const [shown, setShown] = useState(reduced ? chars.length : 0)

  useEffect(() => {
    if (reduced) {
      setShown(chars.length)
      return
    }
    setShown(0)
    const timer = window.setInterval(() => {
      setShown((n) => {
        if (n >= chars.length) {
          window.clearInterval(timer)
          return n
        }
        return n + 1
      })
    }, TYPE_MS)
    return () => window.clearInterval(timer)
    // The text alone decides when to type again.
  }, [text, reduced])

  const done = shown >= chars.length
  return (
    <>
      {chars.slice(0, shown).join('')}
      <span className={`help-typed-caret${done ? ' is-done' : ''}`} aria-hidden="true" />
      <span className="help-typed-ghost">{chars.slice(shown).join('')}</span>
    </>
  )
}

/** While Help works: Ray reading with his glasses on, and what he’s up to. */
export function HelpRayThinking(): JSX.Element {
  const [step, setStep] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setStep((n) => n + 1), 2400)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <p className="help-thinking help-thinking--ray">
      <span className="help-ray-mini" aria-hidden="true">
        <Ray mood="read" glasses blink={false} />
      </span>
      <span key={step} className="help-ray-verb">
        {HELP_WORKING[step % HELP_WORKING.length]}
      </span>
      <Spinner />
    </p>
  )
}
