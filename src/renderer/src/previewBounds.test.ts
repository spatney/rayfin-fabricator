import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measurePreviewBounds, watchPreviewPixelRatio } from './previewBounds'

function host(rect = new DOMRect(100, 80, 900, 600)): Element {
  const element = document.createElement('div')
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect)
  return element
}

beforeEach(() => {
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('visualViewport', undefined)
})

afterEach(() => {
  document.documentElement.style.removeProperty('zoom')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('native preview measurement', () => {
  it.each([1, 1.25, 1.5, 2])('includes the renderer pixel ratio at %sx scale', (ratio) => {
    vi.stubGlobal('devicePixelRatio', ratio)
    expect(measurePreviewBounds(host())).toEqual({
      x: 100,
      y: 80,
      width: 900,
      height: 600,
      pixelRatio: ratio
    })
  })

  it('accounts for pinch zoom and visual-viewport panning', () => {
    vi.stubGlobal('devicePixelRatio', 1.5)
    vi.stubGlobal('visualViewport', { scale: 1.25, offsetLeft: 40, offsetTop: 20 })
    expect(measurePreviewBounds(host())).toEqual({
      x: 60,
      y: 60,
      width: 900,
      height: 600,
      pixelRatio: 1.875
    })
  })

  it('does not apply CSS UI zoom twice to an already-scaled client rect', () => {
    document.documentElement.style.zoom = '1.5'
    vi.stubGlobal('devicePixelRatio', 2)
    expect(measurePreviewBounds(host(new DOMRect(150, 120, 1350, 900)))).toEqual({
      x: 150,
      y: 120,
      width: 1350,
      height: 900,
      pixelRatio: 2
    })
  })

  it('does not position a collapsed host', () => {
    expect(measurePreviewBounds(host(new DOMRect(100, 80, 0, 600)))).toBeNull()
  })

  it.each([0, -1, NaN, Infinity])('rejects an invalid pixel ratio %s', (ratio) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('devicePixelRatio', ratio)
    expect(measurePreviewBounds(host())).toBeNull()
    expect(error).toHaveBeenCalledOnce()
  })

  it('re-arms display-scale monitoring and cleans up its current listener', () => {
    const queries: Array<{ media: string; listeners: Set<() => void> }> = []
    vi.stubGlobal(
      'matchMedia',
      vi.fn((media: string) => {
        const listeners = new Set<() => void>()
        queries.push({ media, listeners })
        return {
          addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
          removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener)
        }
      })
    )
    const changed = vi.fn()
    const stop = watchPreviewPixelRatio(changed)
    expect(queries[0].media).toContain('1dppx')
    const listener = [...queries[0].listeners][0]
    vi.stubGlobal('devicePixelRatio', 1.25)
    listener()
    expect(queries[0].listeners.size).toBe(0)
    expect(queries[1].media).toContain('1.25dppx')
    expect(changed).toHaveBeenCalledOnce()
    stop()
    expect(queries[1].listeners.size).toBe(0)
    listener()
    expect(changed).toHaveBeenCalledOnce()
  })
})
