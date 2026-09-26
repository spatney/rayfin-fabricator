// Small formatting helpers shared by the chat components.

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** Compact, human-readable turn duration: "<1s", "12s", "1m 23s". */
export function formatTurnDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

/** A message timestamp: the time today ("10:42 PM"), else the date too ("Sep 24, 10:42 PM"). */
export function formatClock(epochMs: number, now = Date.now()): string {
  const d = new Date(epochMs)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (new Date(now).toDateString() === d.toDateString()) return time
  const sameYear = new Date(now).getFullYear() === d.getFullYear()
  const date = d.toLocaleDateString(
    undefined,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  )
  return `${date}, ${time}`
}

/** Full date and time, for tooltips. */
export function formatFullDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })
}
