/** Preview sizes offered while designing, in app CSS px. */
export type DeviceId = 'desktop' | 'tablet' | 'phone'

export interface DevicePreset {
  id: DeviceId
  label: string
  /** App viewport width in CSS px; `null` fills the pane. */
  width: number | null
  /** App viewport height in CSS px, at most (a short pane shrinks it); absent fills the pane. */
  height?: number
}

export const DEVICES: DevicePreset[] = [
  { id: 'desktop', label: 'Desktop', width: null },
  { id: 'tablet', label: 'Tablet', width: 820 },
  { id: 'phone', label: 'Phone', width: 390, height: 844 }
]

export function devicePreset(id: DeviceId): DevicePreset {
  return DEVICES.find((d) => d.id === id) ?? DEVICES[0]
}

function hostPx(appPx: number, uiScale: number): number {
  const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1
  return Math.round(appPx / scale)
}

/**
 * The preview host's CSS width for a device, in renderer px. The native preview
 * follows the renderer's zoom, so an app width of `w` CSS px needs `w / uiScale`
 * renderer px. `null` means "fill the pane".
 */
export function deviceHostWidth(id: DeviceId, uiScale: number): number | null {
  const { width } = devicePreset(id)
  return width ? hostPx(width, uiScale) : null
}

/** The preview host's CSS height for a device, in renderer px, like its width. */
export function deviceHostHeight(id: DeviceId, uiScale: number): number | null {
  const { height } = devicePreset(id)
  return height ? hostPx(height, uiScale) : null
}
