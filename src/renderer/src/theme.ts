import type { ThemePreference } from '@shared/ipc'

// The last applied theme and zoom, so the first frame of a launch paints in them
// before settings load (the app opens without a splash once setup has passed).
const THEME_KEY = 'fabricator.theme'
const SCALE_KEY = 'fabricator.uiScale'

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* best-effort: only the first frame of the next launch depends on it */
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

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
  remember(THEME_KEY, pref)
  if (pref !== 'system') return () => {}
  const mq = media()
  const onChange = (): void => applyTheme('system')
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/** Available UI zoom presets, smallest to largest (1 = 100%). */
export const UI_SCALES = [0.5, 0.75, 1, 1.1, 1.25, 1.5] as const

/** Apply a UI zoom factor to the whole interface, clamped to a sane range. */
export function applyUiScale(scale: number | undefined): void {
  const value = Math.min(2, Math.max(0.5, scale || 1))
  document.documentElement.style.zoom = String(value)
  // `zoom` also multiplies vh units, so expose the factor for layouts that cap
  // their height to the viewport (e.g. modals) to divide it back out.
  document.documentElement.style.setProperty('--ui-scale', String(value))
  remember(SCALE_KEY, String(value))
}

/** Paint the last-used theme and zoom before the first render. */
export function applyRememberedAppearance(): void {
  const theme = recall(THEME_KEY)
  if (theme === 'dark' || theme === 'light' || theme === 'system') applyTheme(theme)
  const scale = Number(recall(SCALE_KEY))
  if (Number.isFinite(scale) && scale > 0) applyUiScale(scale)
}
