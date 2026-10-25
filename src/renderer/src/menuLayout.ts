import type { CSSProperties } from 'react'

/** Where a menu drawn at the document root opens, beside its trigger. */
export interface MenuLayout {
  /** The side its lists open toward. */
  side: 'left' | 'right'
  /** Fixed-position offsets, plus `--mp-max-h`: the room it has to grow into. */
  style: CSSProperties
}

/**
 * Place a menu that opens up from a composer or down from a toolbar, toward
 * the side with room for `need` pixels (the menu plus a list beside it).
 */
export function menuLayout(trigger: DOMRect, placement: 'up' | 'down', need: number): MenuLayout {
  const right = window.innerWidth - trigger.left
  const left = trigger.right
  const side =
    placement === 'up'
      ? right >= need || right >= left
        ? 'right'
        : 'left'
      : left >= need || left >= right
        ? 'left'
        : 'right'
  const room = placement === 'up' ? trigger.top : window.innerHeight - trigger.bottom
  const vertical: CSSProperties =
    placement === 'up' ? { bottom: window.innerHeight - trigger.top + 8 } : { top: trigger.bottom + 8 }
  const horizontal: CSSProperties =
    side === 'right'
      ? { left: Math.max(8, trigger.left) }
      : { right: Math.max(8, window.innerWidth - trigger.right) }
  return {
    side,
    style: {
      ...vertical,
      ...horizontal,
      ...({ '--mp-max-h': `${Math.max(220, Math.floor(room - 16))}px` } as CSSProperties)
    }
  }
}
