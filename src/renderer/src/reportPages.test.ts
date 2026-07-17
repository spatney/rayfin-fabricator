import { describe, expect, it } from 'vitest'
import { pickVisiblePages, type PageSize } from './reportPages'

/**
 * Power BI PDF exports include the report's tooltip and hidden drill pages,
 * which are far smaller than the real report pages. `pickVisiblePages` keeps
 * only pages whose area is a meaningful fraction of the largest page, so the
 * migrate hand-off attaches the pages a viewer actually sees.
 */
describe('pickVisiblePages', () => {
  const full: PageSize = { width: 1280, height: 720 }
  const tooltip: PageSize = { width: 320, height: 240 }

  it('keeps the full-size report pages and drops tiny tooltip pages', () => {
    const sizes = [full, full, tooltip, full]
    expect(pickVisiblePages(sizes)).toEqual([1, 2, 4])
  })

  it('returns 1-based page numbers in document order', () => {
    expect(pickVisiblePages([tooltip, full, tooltip, full])).toEqual([2, 4])
  })

  it('keeps every page when they are all the same size', () => {
    expect(pickVisiblePages([full, full, full])).toEqual([1, 2, 3])
  })

  it('returns an empty list for no pages', () => {
    expect(pickVisiblePages([])).toEqual([])
  })

  it('falls back to keeping all pages when sizes are degenerate', () => {
    const zero: PageSize = { width: 0, height: 0 }
    expect(pickVisiblePages([zero, zero])).toEqual([1, 2])
  })

  it('honours a custom minimum-area ratio', () => {
    const sizes = [full, { width: 640, height: 360 }]
    // The half-width page has 1/4 the area; a 0.5 threshold drops it.
    expect(pickVisiblePages(sizes, 0.5)).toEqual([1])
    // The default 0.25 threshold keeps it (area ratio == 0.25).
    expect(pickVisiblePages(sizes)).toEqual([1, 2])
  })
})
