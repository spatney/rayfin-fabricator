import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { lineLabel, type MascotLine } from './lines'

/** Typing speed, per character. */
export const TYPE_MS = 24

/* His tail, pointing down, in px: 1px of overlap inside the bubble, then the
   bubble's edge (centred at y 1.5), then the tail itself, which narrows a
   little faster than a straight wedge would. The fill covers the bubble's
   edge where they meet; the outline carries that edge on down to the tip. */
const TAIL_FILL = 'M3 0V1.5Q7.1 3.9 11 12Q14.9 3.9 19 1.5V0Z'
const TAIL_EDGE = 'M3 1.5Q7.1 3.9 11 12Q14.9 3.9 19 1.5'

/**
 * Narrows a bubble to its longest line. A balanced wrap evens the lines out
 * but leaves the box as wide as an unbalanced wrap would have made it.
 */
function hug(bubble: HTMLElement, text: HTMLElement): void {
  bubble.style.width = ''
  const range = document.createRange()
  if (typeof range.getClientRects !== 'function') return
  range.selectNodeContents(text)
  const lines = new Map<number, { left: number; right: number }>()
  for (const r of Array.from(range.getClientRects())) {
    if (!r.width) continue
    const key = Math.round(r.bottom)
    const line = lines.get(key)
    lines.set(
      key,
      line ? { left: Math.min(line.left, r.left), right: Math.max(line.right, r.right) } : r
    )
  }
  const shown = bubble.getBoundingClientRect().width
  if (!lines.size || !shown || !bubble.offsetWidth) return
  // Those are on-screen sizes: undo the scale it pops in with.
  const scale = shown / bubble.offsetWidth
  let longest = 0
  for (const { left, right } of lines.values()) longest = Math.max(longest, right - left)
  const label = bubble.querySelector<HTMLElement>('.mascot-bubble-label')
  const style = getComputedStyle(bubble)
  const frame =
    parseFloat(style.paddingLeft) +
    parseFloat(style.paddingRight) +
    parseFloat(style.borderLeftWidth) +
    parseFloat(style.borderRightWidth)
  const width = Math.ceil(Math.max(longest / scale, label?.offsetWidth ?? 0) + frame + 1)
  if (width < bubble.offsetWidth) bubble.style.width = `${width}px`
}

interface Props {
  line: MascotLine
  /** Type the line out; otherwise show it whole. */
  typing: boolean
  /** Move on to another line. Without it, the bubble is only for reading. */
  onClick?: () => void
  /** Balance the line's wrap and narrow the bubble to it. It keeps that width,
   *  so turn it off where the room around the bubble can resize under it. */
  balance?: boolean
}

/**
 * Ray's speech bubble. The untyped rest of the line is laid out but invisible,
 * so the bubble has its final size from the first frame and never jumps. Its
 * position is set from outside, every frame, through the ref.
 */
export const SpeechBubble = forwardRef<HTMLDivElement, Props>(function SpeechBubble(
  { line, typing, onClick, balance = true },
  ref
) {
  const chars = Array.from(line.text)
  const [shown, setShown] = useState(typing ? 0 : chars.length)
  const textRef = useRef<HTMLSpanElement>(null)

  // Before it paints, so whoever places the bubble measures its final size.
  useLayoutEffect(() => {
    const text = textRef.current
    if (balance && text?.parentElement) hug(text.parentElement, text)
  }, [line.text, balance])

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
      className={`mascot-bubble mascot-bubble--${line.kind}${balance ? ' is-balanced' : ''}${onClick ? ' is-clickable' : ''}`}
      aria-hidden="true"
      onClick={onClick}
      title={onClick ? 'Click for another' : undefined}
    >
      {label && <span className="mascot-bubble-label">{label}</span>}
      <span ref={textRef} className="mascot-bubble-text">
        {chars.slice(0, shown).join('')}
        <span className="mascot-bubble-ghost">{chars.slice(shown).join('')}</span>
      </span>
      <svg className="mascot-bubble-tail" viewBox="0 0 22 13">
        <path className="mascot-bubble-tail-fill" d={TAIL_FILL} />
        <path className="mascot-bubble-tail-edge" d={TAIL_EDGE} />
      </svg>
    </div>
  )
})
