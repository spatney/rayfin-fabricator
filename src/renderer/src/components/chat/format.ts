// Small formatting helpers shared by the chat components.

import { formatLocale, translator } from '../../i18n'

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** Compact, human-readable turn duration: "<1s", "12s", "1m 23s". */
export function formatTurnDuration(ms: number): string {
  if (ms < 1000) return translator('chat')('duration.underSecond')
  return formatSeconds(Math.round(ms / 1000))
}

/** Whole seconds, compactly: "12s", "1m 23s", "2m". */
export function formatSeconds(total: number): string {
  const t = translator('chat')
  if (total < 60) return t('duration.seconds', { s: total })
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? t('duration.minutesSeconds', { m, s }) : t('duration.minutes', { m })
}

/** A message timestamp: the time today ("10:42 PM"), else the date too ("Sep 24, 10:42 PM"). */
export function formatClock(epochMs: number, now = Date.now()): string {
  const locale = formatLocale()
  const d = new Date(epochMs)
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  if (new Date(now).toDateString() === d.toDateString()) return time
  const sameYear = new Date(now).getFullYear() === d.getFullYear()
  const date = d.toLocaleDateString(
    locale,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  )
  return translator('chat')('format.dateTime', { date, time })
}

/** Full date and time, for tooltips. */
export function formatFullDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString(formatLocale(), { dateStyle: 'full', timeStyle: 'short' })
}
