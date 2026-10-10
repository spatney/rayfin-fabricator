import { forwardRef, useEffect, useState } from 'react'
import { lineLabel, type MascotLine } from './lines'

/** Typing speed, per character. */
export const TYPE_MS = 24

interface Props {
  line: MascotLine
  /** Type the line out; otherwise show it whole. */
  typing: boolean
  onClick: () => void
}

/**
 * Ray's speech bubble. The untyped rest of the line is laid out but invisible,
 * so the bubble has its final size from the first frame and never jumps. Its
 * position is set from outside, every frame, through the ref.
 */
export const SpeechBubble = forwardRef<HTMLDivElement, Props>(function SpeechBubble(
  { line, typing, onClick },
  ref
) {
  const chars = Array.from(line.text)
  const [shown, setShown] = useState(typing ? 0 : chars.length)

  useEffect(() => {
    if (!typing) {
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
    // A new line is a new string, so the text alone decides when to restart.
  }, [line.text, typing])

  const label = lineLabel(line.kind)
  return (
    <div
      ref={ref}
      className={`mascot-bubble mascot-bubble--${line.kind}`}
      aria-hidden="true"
      onClick={onClick}
      title="Click for another"
    >
      {label && <span className="mascot-bubble-label">{label}</span>}
      <span className="mascot-bubble-text">
        {chars.slice(0, shown).join('')}
        <span className="mascot-bubble-ghost">{chars.slice(shown).join('')}</span>
      </span>
      <span className="mascot-bubble-tail" />
    </div>
  )
})
