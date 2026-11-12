import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { moveMenuFocus } from '../menuFocus'
import { uiZoom } from '../menuLayout'
import { useSuppressPreview } from '../overlay'
import { Codicon } from './icons'
import './models/modelPicker.css'

export interface ContextMenuItem {
  id: string
  label: string
  /** A codicon name. */
  icon?: string
  /** Shown quieter after the label, e.g. a version. */
  detail?: string
  disabled?: boolean
  run: () => void
}

/** An item, or a rule between groups of them. */
export type ContextMenuEntry = ContextMenuItem | 'separator'

const ITEMS = '[role="menuitem"]:not(:disabled)'
/** How far a menu keeps from the window's edges. */
const MARGIN = 8

/**
 * A menu at a point (a right-click, or a row for the keyboard's menu key),
 * drawn at the document root. It closes on Escape, a choice, a click
 * elsewhere, scrolling, or the window losing focus; `onClose` gives the focus
 * back to whatever opened it.
 */
export function ContextMenu({
  x,
  y,
  label,
  entries,
  onClose
}: {
  x: number
  y: number
  /** What the menu is about, for assistive technology. */
  label: string
  entries: readonly ContextMenuEntry[]
  onClose: () => void
}): JSX.Element {
  useSuppressPreview()
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: x, top: y })

  // Keep it on screen: open up or left of the point when there's no room.
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    const left = x + width + MARGIN > window.innerWidth ? Math.max(MARGIN, x - width) : x
    const top = y + height + MARGIN > window.innerHeight ? Math.max(MARGIN, y - height) : y
    setPlace({ left, top })
  }, [x, y])

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(ITEMS)?.focus()
    const outside = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const close = (): void => onClose()
    window.addEventListener('mousedown', outside, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', outside, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [onClose])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    moveMenuFocus(event, ITEMS)
  }

  return createPortal(
    <div
      ref={ref}
      className="mp-panel ctx-menu"
      role="menu"
      aria-label={label}
      // `x`, `y` and the menu's size are the window's pixels, which the interface zoom scales again.
      style={{ left: place.left / uiZoom(), top: place.top / uiZoom() }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry === 'separator' ? (
          <div key={`sep-${i}`} className="mp-sep" role="separator" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className="mp-item ctx-menu-item"
            disabled={entry.disabled}
            onClick={() => {
              onClose()
              entry.run()
            }}
          >
            {entry.icon ? (
              <Codicon name={entry.icon} className="ctx-menu-icon" />
            ) : (
              <span className="ctx-menu-icon" aria-hidden="true" />
            )}
            <span className="mp-item-label">{entry.label}</span>
            {entry.detail && <span className="ctx-menu-detail">{entry.detail}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
