// Ranking for Search: forgiving, fast, and predictable.
//
// A query is split into words; every word has to match somewhere for an item to
// show. Each word scores by how it matches, best first: the whole title, the start
// of the title, the start of a word, the initials of words ("np" for New project),
// anywhere inside, and finally letters in order ("dply" for Deploy). Titles count
// most, then other words for the item, then its subtitle, then its body text, which
// only matches at the start of words.
//
// Items are folded once (lowercase, accents removed) by `prepare`, so each key
// press only folds the query.
import type { Searchable } from './model'

export type Range = [start: number, end: number]

interface Field {
  /** Lowercase, without accents, one character for each of the original's. */
  text: string
  /** Where words start. */
  starts: number[]
}

export interface Prepared<T extends Searchable> {
  item: T
  title: Field
  keywords: Field[]
  subtitle: Field | null
  body: Field | null
}

export interface Ranked<T> {
  item: T
  score: number
  /** What matched in the title, to show in bold. */
  ranges: Range[]
}

interface Hit {
  score: number
  ranges: Range[]
}

const KEYWORD_WEIGHT = 0.86
const SUBTITLE_WEIGHT = 0.6
const BODY_WEIGHT = 0.45
/** Below this, a result is noise. */
const MIN_SCORE = 0.2

const NON_ASCII = /[^\p{ASCII}]/u
const WORD_CHAR = /[\p{L}\p{N}]/u
const UPPER = /\p{Lu}/u
const LOWER_OR_DIGIT = /[\p{Ll}\p{N}]/u

/** Lowercase without accents, one character for one, so match ranges map back. */
export function fold(text: string): string {
  if (!NON_ASCII.test(text)) return text.toLowerCase()
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const bare = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    if (bare.length === 1) out += bare
    else {
      const lower = ch.toLowerCase()
      out += lower.length === 1 ? lower : ch
    }
  }
  return out
}

/** Where words start: after a non-word character, or at a camelCase hump. */
function wordStarts(text: string): number[] {
  const starts: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!WORD_CHAR.test(ch)) continue
    const prev = text[i - 1]
    if (i === 0 || !WORD_CHAR.test(prev) || (UPPER.test(ch) && LOWER_OR_DIGIT.test(prev))) {
      starts.push(i)
    }
  }
  return starts
}

function field(text: string | undefined): Field | null {
  return text ? { text: fold(text), starts: wordStarts(text) } : null
}

/** Fold every item once, ahead of any number of queries. */
export function prepare<T extends Searchable>(items: readonly T[]): Prepared<T>[] {
  return items.map((item) => ({
    item,
    title: field(item.title) ?? { text: '', starts: [] },
    keywords: (item.keywords ?? []).map((k) => field(k)).filter((f): f is Field => f !== null),
    subtitle: field(item.subtitle),
    body: field(item.body)
  }))
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: Range[] = []
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** Each letter starts the next word, as "np" does for New project. */
function initials(f: Field, token: string): Hit | null {
  const ranges: Range[] = []
  let from = 0
  for (const ch of token) {
    let found = -1
    for (let k = from; k < f.starts.length; k++) {
      if (f.text[f.starts[k]] === ch) {
        found = k
        break
      }
    }
    if (found < 0) return null
    ranges.push([f.starts[found], f.starts[found] + 1])
    from = found + 1
  }
  return { score: 0.74, ranges }
}

/** The letters appear in order; the closer together, the better. */
function subsequence(f: Field, token: string): Hit | null {
  const at: number[] = []
  let from = 0
  for (const ch of token) {
    const i = f.text.indexOf(ch, from)
    if (i < 0) return null
    at.push(i)
    from = i + 1
  }
  const span = at[at.length - 1] - at[0] + 1
  return { score: 0.22 + 0.2 * (token.length / span), ranges: at.map((i) => [i, i + 1]) }
}

/**
 * How well one word of the query matches a field. `words` only matches whole
 * words or their starts (for long text); `inside` also matches inside words;
 * `fuzzy` adds initials and letters in order.
 */
function matchToken(f: Field, token: string, mode: 'words' | 'inside' | 'fuzzy'): Hit | null {
  const { text, starts } = f
  const n = token.length
  if (!text) return null
  if (text === token) return { score: 1, ranges: [[0, n]] }
  if (text.startsWith(token)) return { score: 0.92, ranges: [[0, n]] }
  for (const s of starts) {
    if (s > 0 && text.startsWith(token, s)) {
      return { score: 0.84 - Math.min(s, 40) * 0.001, ranges: [[s, s + n]] }
    }
  }
  if (mode === 'words' || n < 2) return null
  const acronym = mode === 'fuzzy' ? initials(f, token) : null
  const at = text.indexOf(token)
  const inside: Hit | null = at >= 0 ? { score: 0.62, ranges: [[at, at + n]] } : null
  if (acronym || inside) return (acronym?.score ?? 0) >= (inside?.score ?? 0) ? acronym : inside
  return mode === 'fuzzy' && n >= 3 ? subsequence(f, token) : null
}

/** The query as words, folded. Empty when there's nothing to search for. */
export function queryTokens(query: string): string[] {
  const folded = fold(query.trim())
  return folded ? folded.split(/\s+/) : []
}

export interface RankOptions<T> {
  /** Extra score for an item, such as for one picked recently. */
  boost?: (item: T) => number
  limit?: number
}

/** Rank prepared items for a query, best first. Items that don't match are left out. */
export function rank<T extends Searchable>(
  prepared: readonly Prepared<T>[],
  query: string,
  options: RankOptions<T> = {}
): Ranked<T>[] {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return []
  const phrase = tokens.join(' ')
  const results: Ranked<T>[] = []

  outer: for (const p of prepared) {
    let total = 0
    const ranges: Range[] = []
    for (const token of tokens) {
      const inTitle = matchToken(p.title, token, 'fuzzy')
      let best = inTitle?.score ?? 0
      for (const k of p.keywords) {
        const hit = matchToken(k, token, 'fuzzy')
        if (hit) best = Math.max(best, hit.score * KEYWORD_WEIGHT)
      }
      if (p.subtitle) {
        const hit = matchToken(p.subtitle, token, 'words')
        if (hit) best = Math.max(best, hit.score * SUBTITLE_WEIGHT)
      }
      if (p.body) {
        const hit = matchToken(p.body, token, 'words')
        if (hit) best = Math.max(best, hit.score * BODY_WEIGHT)
      }
      if (best === 0) continue outer
      total += best
      if (inTitle) ranges.push(...inTitle.ranges)
    }

    let score = total / tokens.length
    if (tokens.length > 1) {
      if (p.title.text.startsWith(phrase)) score += 0.08
      else if (p.title.text.includes(phrase)) score += 0.04
    }
    // Between equals, the shorter title is the closer match.
    score -= Math.min(p.title.text.length, 80) * 0.0006
    score += options.boost?.(p.item) ?? 0
    if (score < MIN_SCORE) continue
    results.push({ item: p.item, score, ranges: mergeRanges(ranges) })
  }

  results.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
  return options.limit === undefined ? results : results.slice(0, options.limit)
}

const QUESTION_START =
  /^(why|how|what|what['’]s|whats|when|where|who|which|can|could|should|would|does|do|did|is|are|was|will|my|help|fix)\b/i
const TROUBLE =
  /\b(won['’]?t|can['’]?t|cannot|doesn['’]?t|isn['’]?t|not working|broken|fail(s|ed|ing)?|error|stuck)\b/i

/** Reads as a question for Help rather than a name to look up. */
export function looksLikeQuestion(query: string): boolean {
  const q = query.trim()
  if (!q) return false
  if (q.endsWith('?')) return true
  const words = q.split(/\s+/).length
  if (words >= 3 && (QUESTION_START.test(q) || TROUBLE.test(q))) return true
  return words >= 6
}
