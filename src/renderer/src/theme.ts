import type { ThemePreference } from '@shared/ipc'

const media = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: light)')

/** Resolve a preference to a concrete theme, consulting the OS for 'system'. */
function resolve(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'system') return media().matches ? 'light' : 'dark'
  return pref
}

/** Apply a theme preference to <html data-theme>. */
export function applyTheme(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolve(pref)
}

/**
 * Apply the preference now and, when it is 'system', keep it in sync with OS
 * changes. Returns an unsubscribe function.
 */
export function watchTheme(pref: ThemePreference): () => void {
  applyTheme(pref)
  if (pref !== 'system') return () => {}
  const mq = media()
  const onChange = (): void => applyTheme('system')
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/** Available UI zoom presets, smallest to largest (1 = 100%). */
export const UI_SCALES = [1, 1.1, 1.25, 1.5] as const

/** Apply a UI zoom factor to the whole interface, clamped to a sane range. */
export function applyUiScale(scale: number | undefined): void {
  const value = Math.min(2, Math.max(0.8, scale || 1))
  document.documentElement.style.zoom = String(value)
  // `zoom` also multiplies vh units, so expose the factor for layouts that cap
  // their height to the viewport (e.g. modals) to divide it back out.
  document.documentElement.style.setProperty('--ui-scale', String(value))
}
