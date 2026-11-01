import { afterEach, describe, expect, it } from 'vitest'
import { menuLayout } from './menuLayout'

afterEach(() => {
  document.documentElement.style.removeProperty('zoom')
})

describe('menuLayout', () => {
  it('lines a menu up with its trigger under the interface zoom', () => {
    // Rects come back zoomed; the offsets it sets are zoomed again.
    document.documentElement.style.zoom = '1.25'
    const trigger = { left: 400, right: 550, top: 32.5, bottom: 62.5 } as DOMRect
    const { side, style } = menuLayout(trigger, 'down', 332)
    expect(side).toBe('left')
    expect(style.right).toBeCloseTo((window.innerWidth - 550) / 1.25)
    expect(style.top).toBeCloseTo((62.5 + 8) / 1.25)

    document.documentElement.style.removeProperty('zoom')
    expect(menuLayout(trigger, 'down', 332).style.right).toBe(window.innerWidth - 550)
  })
})
