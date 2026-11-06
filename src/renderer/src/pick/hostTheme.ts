import type { PickHostTheme } from '@shared/pick'

/**
 * Fabricator's own theme (accent / surfaces / text / border) + UI zoom, read from
 * the renderer's CSS tokens so the highlight Touch Up draws in the preview
 * matches Fabricator's look and scale (it's Fabricator UI, not the previewed
 * app's). Falls back to the dark-teal defaults when a token is missing.
 */
export function readFabricatorTheme(): PickHostTheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string): string => cs.getPropertyValue(n).trim()
  const scale = Number(v('--ui-scale') || document.documentElement.style.zoom) || 1
  return {
    accent: v('--accent') || '#34b4ba',
    panel: v('--bg-elev') || '#12161f',
    panel2: v('--bg-elev-2') || undefined,
    border: v('--border') || undefined,
    txt: v('--text') || '#eceff5',
    txtDim: v('--text-dim') || undefined,
    scale
  }
}
