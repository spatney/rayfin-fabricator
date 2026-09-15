import type { PreviewBounds } from '@shared/ipc'

export function measurePreviewBounds(host: Element): PreviewBounds | null {
  const rect = host.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  const viewport = window.visualViewport
  const bounds: PreviewBounds = {
    x: rect.left - (viewport?.offsetLeft ?? 0),
    y: rect.top - (viewport?.offsetTop ?? 0),
    width: rect.width,
    height: rect.height,
    pixelRatio: window.devicePixelRatio * (viewport?.scale ?? 1)
  }
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    !bounds.pixelRatio ||
    bounds.pixelRatio <= 0
  ) {
    console.error('Cannot position the native preview: invalid viewport geometry.')
    return null
  }
  return bounds
}

/** Moving between displays can change DPR without changing the CSS host rect. */
export function watchPreviewPixelRatio(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  let active = true
  let query: MediaQueryList
  const changed = (): void => {
    if (!active) return
    query.removeEventListener('change', changed)
    observe()
    onChange()
  }
  const observe = (): void => {
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    query.addEventListener('change', changed)
  }
  observe()
  return () => {
    active = false
    query.removeEventListener('change', changed)
  }
}
