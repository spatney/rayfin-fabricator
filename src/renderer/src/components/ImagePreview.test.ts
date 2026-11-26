import { describe, expect, it } from 'vitest'
import { fitScale } from './ImagePreview'

describe('fitScale', () => {
  const pane = { width: 800, height: 500 }

  it('shrinks a large image to fit, and leaves one that fits as it is', () => {
    expect(fitScale({ width: 1600, height: 1000 }, pane, false)).toBe(0.5)
    expect(fitScale({ width: 512, height: 400 }, pane, false)).toBe(1)
  })

  it('enlarges an icon to show its detail: by whole steps, smoothly for a vector, never past the pane', () => {
    expect(fitScale({ width: 48, height: 48 }, pane, false)).toBe(3)
    expect(fitScale({ width: 48, height: 48 }, pane, true)).toBeCloseTo(160 / 48)
    expect(fitScale({ width: 32, height: 32 }, { width: 100, height: 120 }, false)).toBe(3.125)
  })
})
