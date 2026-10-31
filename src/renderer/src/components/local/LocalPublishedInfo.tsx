import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent
} from 'react'
import { createPortal } from 'react-dom'
import { useSuppressPreview } from '../../overlay'
import { Codicon, CloudIcon, DesktopIcon } from '../icons'
import './local.css'

/** Keep in step with `.lpi-pop`'s width in local.css. */
const POP_WIDTH = 300

/** Under the trigger, lined up with its left edge, and kept on screen. */
function placeUnder(trigger: DOMRect): CSSProperties {
  return {
    left: Math.max(8, Math.min(trigger.left - 8, window.innerWidth - POP_WIDTH - 8)),
    top: trigger.bottom + 6
  }
}

/**
 * An info button beside the preview's Local and Published switch, for anyone who
 * wants to know how the two differ: the app on this computer has its own data,
 * apart from the published app's. Selecting it opens a short note under it (the
 * native preview hides while the note covers it). For an app that was published
 * before it ran on this computer, whose local data starts empty, the button
 * stands out until it's opened.
 */
export default function LocalPublishedInfo({
  name,
  fresh = false,
  onOpen
}: {
  /** The app's name. */
  name: string
  /** The app was published before it ran here and nobody looked yet. */
  fresh?: boolean
  /** The note opened. */
  onOpen?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<CSSProperties>({})
  // Said once the note is open, so opening it (which settles `fresh`) doesn't change it.
  const [startsEmpty, setStartsEmpty] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const popId = useId()
  const titleId = useId()

  // The note draws over the preview, whose native surface paints above all HTML.
  useSuppressPreview(open)

  const close = useCallback((refocus: boolean): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [])

  // A press anywhere else closes it; so does resizing the window, which would
  // leave it behind its button.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: Event): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) close(false)
    }
    const onResize = (): void => close(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onResize)
    popRef.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, close])

  const toggle = (): void => {
    if (open) {
      close(false)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPlacement(placeUnder(rect))
    setStartsEmpty(fresh)
    setOpen(true)
    onOpen?.()
  }

  // The note has nothing to press, so Tab and Escape both put it away.
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (!open || (event.key !== 'Escape' && event.key !== 'Tab')) return
    if (event.target === triggerRef.current && event.key === 'Tab') {
      close(false)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    close(true)
  }

  return (
    <span className="lpi" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={`lpi-trigger${fresh ? ' is-fresh' : ''}${open ? ' is-open' : ''}`}
        aria-label="About Local and Published"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        title={
          fresh
            ? `${name} now runs on this computer, with its own data. Select to learn more.`
            : 'About Local and Published'
        }
        onClick={toggle}
      >
        <Codicon name="info" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={popId}
            className="lpi-pop"
            role="dialog"
            aria-labelledby={titleId}
            tabIndex={-1}
            style={placement}
          >
            <p className="lpi-title" id={titleId}>
              {name} runs in two places
            </p>
            <div className="lpi-row">
              <DesktopIcon className="lpi-ico" />
              <p className="lpi-text">
                <strong>Local</strong> is your app on this computer, with its own data, apart from
                the published app’s.{startsEmpty ? ' That data starts empty.' : ''} Copilot’s
                changes show here first.
              </p>
            </div>
            <div className="lpi-row">
              <CloudIcon className="lpi-ico" />
              <p className="lpi-text">
                <strong>Published</strong> is your app on Microsoft Fabric, with its data. Your
                changes reach it when you publish them.
              </p>
            </div>
          </div>,
          document.body
        )}
    </span>
  )
}
