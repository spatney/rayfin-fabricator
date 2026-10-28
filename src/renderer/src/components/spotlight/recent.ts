// Search remembers what you pick, so the things you use most rise to the top.

const KEY = 'fabricator.search.recent'
const MAX = 40
/** The boost for the last pick; older picks get less. */
const BOOST = 0.12

export function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** Remember a pick, most recent first. */
export function rememberPick(id: string): void {
  try {
    const next = [id, ...readRecent().filter((other) => other !== id)].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Best-effort: ranking just won't know about this pick.
  }
}

/** Extra score for items picked recently, fading with age. */
export function recencyBoost(recent: readonly string[]): (item: { id: string }) => number {
  const at = new Map(recent.map((id, i) => [id, i]))
  return (item) => {
    const i = at.get(item.id)
    return i === undefined ? 0 : BOOST * (1 - i / MAX)
  }
}
