import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { moveMenuFocus } from '@renderer/menuFocus'
import { menuLayout, type MenuLayout } from '@renderer/menuLayout'
import { Codicon } from '../icons'
import '../models/modelPicker.css'

const ITEMS = '[role^="menuitem"]:not(:disabled)'

/**
 * A gallery toolbar menu: a button naming the current choice, which opens a
 * list below it in the app's menu style. Arrow keys move through the list (and
 * up into its search, when it has one), and Esc closes it.
 */
export function GalleryMenu({
  icon,
  label,
  value,
  name,
  width,
  panelClassName = '',
  children
}: {
  icon: string
  /** The current choice, as the button shows it. */
  label: ReactNode
  /** The current choice, in words, for the button's name. */
  value: string
  /** What the menu chooses: "Workspace", "Sort". */
  name: string
  width: number
  /** A layout of its own for the menu's panel. */
  panelClassName?: string
  /** The menu's items. `close` closes it and gives the button the focus back. */
  children: (close: () => void) => ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<MenuLayout>({ side: 'left', style: {} })
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false)
    }
    const resize = (): void => setOpen(false)
    window.addEventListener('mousedown', outside)
    window.addEventListener('resize', resize)
    // Start in its search, else on the current choice.
    const id = requestAnimationFrame(() => {
      const panel = panelRef.current
      const start =
        panel?.querySelector<HTMLElement>('input') ??
        panel?.querySelector<HTMLElement>('[aria-checked="true"]') ??
        panel?.querySelector<HTMLElement>(ITEMS)
      start?.focus()
    })
    return () => {
      window.removeEventListener('mousedown', outside)
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(id)
    }
  }, [open])

  function toggle(): void {
    if (open) {
      setOpen(false)
      return
    }
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setLayout(menuLayout(r, 'down', width + 12))
    setOpen(true)
  }

  function close(): void {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    const search = panelRef.current?.querySelector<HTMLInputElement>('input')
    const first = panelRef.current?.querySelector<HTMLElement>(ITEMS)
    if (event.target === search) {
      if (event.key === 'ArrowDown' && first) {
        event.preventDefault()
        first.focus()
      } else if (event.key === 'Enter' && first) {
        // Enter in the search picks the first match.
        event.preventDefault()
        first.click()
      }
      return
    }
    if (event.key === 'ArrowUp' && search && document.activeElement === first) {
      event.preventDefault()
      search.focus()
      return
    }
    moveMenuFocus(event, ITEMS)
  }

  return (
    <div ref={rootRef} className="gallery-menu">
      <button
        ref={triggerRef}
        type="button"
        className={`gallery-menu-btn${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name}: ${value}`}
        title={`${name}: ${value}`}
        onClick={toggle}
      >
        <Codicon name={icon} className="gallery-menu-icon" />
        <span className="gallery-menu-label">{label}</span>
        <Codicon name="chevron-down" className="gallery-menu-chev" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className={`mp-pop mp-pop--down mp-pop--${layout.side}`}
            style={layout.style}
          >
            <div
              ref={panelRef}
              className={`mp-panel gallery-menu-panel ${panelClassName}`.trim()}
              style={{ width }}
              role="menu"
              aria-label={name}
              onKeyDown={onKeyDown}
            >
              {children(close)}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
