import { describe, expect, it } from 'vitest'
import { deviceHostHeight, deviceHostWidth } from './previewDevices'

describe('preview devices', () => {
  it('sizes the preview host so the app sees the device size at any UI zoom', () => {
    expect(deviceHostWidth('desktop', 1.25)).toBeNull()
    expect(deviceHostWidth('phone', 1)).toBe(390)
    expect(deviceHostWidth('phone', 1.25)).toBe(312)
    expect(deviceHostWidth('tablet', 0)).toBe(820)
    expect(deviceHostHeight('phone', 1)).toBe(844)
    expect(deviceHostHeight('phone', 1.25)).toBe(675)
    expect(deviceHostHeight('tablet', 1)).toBeNull()
    expect(deviceHostHeight('desktop', 1)).toBeNull()
  })
})
