import { describe, expect, it } from 'vitest'
import { cropBox } from './capture'

describe('pick capture geometry', () => {
  const layout = { viewport: { w: 1000, h: 800, dpr: 2 }, frame: { x: 0, y: 0 }, rects: {} }
  it('maps an element rect into the captured image with context, clamped to the image', () => {
    expect(cropBox({ x: 100, y: 50, w: 200, h: 40 }, layout, 2000, 1600)).toEqual({
      sx: 184,
      sy: 84,
      sw: 432,
      sh: 112
    })
    expect(cropBox({ x: 0, y: 0, w: 50, h: 20 }, layout, 2000, 1600)).toEqual({
      sx: 0,
      sy: 0,
      sw: 116,
      sh: 56
    })
  })
  it('offsets by the app frame in the Fabric view and skips when the frame is unknown', () => {
    expect(
      cropBox({ x: 10, y: 10, w: 100, h: 50 }, { ...layout, frame: { x: 240, y: 56 } }, 1000, 800)
    ).toEqual({ sx: 242, sy: 58, sw: 116, sh: 66 })
    expect(
      cropBox({ x: 10, y: 10, w: 100, h: 50 }, { ...layout, frame: null }, 1000, 800)
    ).toBeNull()
  })
})
