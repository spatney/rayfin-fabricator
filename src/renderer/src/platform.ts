/** The app is running on macOS, where shortcuts use ⌘ rather than Ctrl. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    ''
  return /mac|iphone|ipad/i.test(platform) || /Macintosh/.test(navigator.userAgent)
}

/** The modifier for app shortcuts as it is printed on keycaps: `⌘` or `Ctrl`. */
export function modKey(): string {
  return isMac() ? '⌘' : 'Ctrl'
}

/** A shortcut as the app writes it in tooltips: `Ctrl+K`, or `⌘K` on macOS. */
export function shortcut(key: string): string {
  return isMac() ? `⌘${key}` : `Ctrl+${key}`
}
