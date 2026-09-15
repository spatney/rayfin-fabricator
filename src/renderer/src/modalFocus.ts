import { useEffect, useRef, useState, type RefObject } from 'react'

/** Elements that can receive focus inside a dialog, in DOM order. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/** Focusable descendants of `root`, in DOM order. */
function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // The selector already drops disabled / tabindex=-1; also skip explicitly
    // hidden nodes. (Layout-based visibility isn't checked — these dialogs render
    // rather than display:none their controls, and offsetParent is unavailable in
    // the test environment.)
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
  )
}

/**
 * Give a modal proper keyboard manners: focus the first control on open, keep Tab
 * / Shift+Tab cycling *within* the dialog, and restore focus to whatever opened it
 * on close. Attach the returned ref to the dialog container (the `role="dialog"`
 * element). Honors a child that React already `autoFocus`-ed — the initial focus
 * only moves when nothing inside the dialog is focused yet.
 *
 * Escape-to-close stays each modal's own concern; this only manages focus.
 */
export function useModalFocus<T extends HTMLElement = HTMLDivElement>(): RefObject<T> {
  const ref = useRef<T>(null)
  // Capture the trigger during the first render — before the dialog's own
  // `autoFocus` runs in commit — so we can hand focus back to it on close.
  const [trigger] = useState<HTMLElement | null>(
    () => (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null)
  )

  useEffect(() => {
    const node = ref.current
    if (!node) return

    // Initial focus: skip if a child is already focused (e.g. an `autoFocus`
    // button), otherwise focus the first control, falling back to the dialog.
    if (!node.contains(document.activeElement)) {
      const first = focusable(node)[0]
      ;(first ?? node).focus()
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const items = focusable(node)
      if (items.length === 0) {
        e.preventDefault()
        node.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !node.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !node.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }

    node.addEventListener('keydown', onKeyDown)
    return () => {
      node.removeEventListener('keydown', onKeyDown)
      // Hand focus back to the opener if it's still in the document.
      if (trigger && document.contains(trigger)) trigger.focus()
    }
  }, [trigger])

  return ref
}
