import type { CSSProperties } from 'react'

/** Where a menu drawn at the document root opens, beside its trigger. */
export interface MenuLayout {
  /** The side its lists open toward. */
  side: 'left' | 'right'
  /** Fixed-position offsets, plus `--mp-max-h`: the room it has to grow into. */
  style: CSSProperties
}

/**
 * The interface zoom (`zoom` on `<html>`, see `applyUiScale`). Rects come back
 * zoomed, but offsets set on an element under it are zoomed again, so they're
 * divided by it.
 */
function uiZoom(): number {
  const zoom = Number(document.documentElement.style.zoom)
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

/**
 * Place a menu that opens up from a composer or down from a toolbar, toward
 * the side with room for `need` pixels (the menu plus a list beside it).
 */
export function menuLayout(trigger: DOMRect, placement: 'up' | 'down', need: number): MenuLayout {
  const zoom = uiZoom()
  const css = (px: number): number => px / zoom
  const wide = need * zoom
  const right = window.innerWidth - trigger.left
  const left = trigger.right
  const side =
    placement === 'up'
      ? right >= wide || right >= left
        ? 'right'
        : 'left'
      : left >= wide || left >= right
        ? 'left'
        : 'right'
  const room = placement === 'up' ? trigger.top : window.innerHeight - trigger.bottom
  const vertical: CSSProperties =
    placement === 'up'
      ? { bottom: css(window.innerHeight - trigger.top + 8) }
      : { top: css(trigger.bottom + 8) }
  const horizontal: CSSProperties =
    side === 'right'
      ? { left: css(Math.max(8, trigger.left)) }
      : { right: css(Math.max(8, window.innerWidth - trigger.right)) }
  return {
    side,
    style: {
      ...vertical,
      ...horizontal,
      ...({ '--mp-max-h': `${Math.max(220, Math.floor(css(room - 16)))}px` } as CSSProperties)
    }
  }
}
