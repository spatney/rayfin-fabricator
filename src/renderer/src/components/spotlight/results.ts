// What Search lists. Before anything is typed: suggestions, recent projects, its own
// searches and questions for Help. Once something is: every kind of result ranked in
// one list, then other ways to use what was typed, as a launcher does.
import { looksLikeQuestion, rank, type Prepared, type Range } from './rank'
import {
  GROUP_LABELS,
  type AskSuggestion,
  type SearchGroup,
  type SearchItem,
  type SearchScope,
  type SearchView
} from './model'

export type Entry =
  | { key: string; type: 'item'; item: SearchItem; ranges: Range[] }
  /** Opens one of Search's own views, carrying what's typed. */
  | { key: string; type: 'view'; view: SearchView; count?: number }
  | { key: string; type: 'ask'; question: string; title: string; subtitle?: string; main?: boolean }
  | { key: string; type: 'continue'; title: string; subtitle: string }

export interface Section {
  key: string
  label?: string
  /** How many there are in all, beside the label. */
  count?: number
  entries: Entry[]
}

export interface Results {
  sections: Section[]
  /** How many of each kind match what's typed; empty when nothing is. */
  counts: Partial<Record<SearchGroup, number>>
}

export interface ResultsInput {
  query: string
  scope: SearchScope
  /** Each group's items, prepared for ranking. */
  groups: Record<SearchGroup, readonly Prepared<SearchItem>[]>
  /** What a view lists before anything is typed. */
  lists: Record<SearchGroup, readonly SearchItem[]>
  boost?: (item: SearchItem) => number
  recentProjects: readonly SearchItem[]
  suggestions: readonly SearchItem[]
  questions: readonly AskSuggestion[]
  /** The open project's files can be searched. */
  hasFiles: boolean
  /** The last question in the Help conversation, to offer carrying on with it. */
  lastQuestion?: string
  /** Help can answer here (Copilot is signed in). */
  helpAvailable: boolean
  /** An answer is on show instead of a list. */
  answering: boolean
}

export const GROUPS: SearchGroup[] = ['projects', 'actions', 'docs', 'files']
/** How many of each kind make the one list of results. */
const LIMITS: Record<SearchGroup, number> = { projects: 4, actions: 5, docs: 5, files: 4 }
/** How many a view lists. */
export const VIEW_LIMIT = 60
const RECENT = 5

const ASK_SIGNED_OUT = 'Sign in to GitHub Copilot to ask Help'

function itemEntry(item: SearchItem, ranges: Range[] = []): Entry {
  return { key: `item:${item.id}`, type: 'item', item, ranges }
}

/** Asking Help what's typed. */
function askEntry(query: string, input: ResultsInput): Entry {
  return {
    key: 'ask:query',
    type: 'ask',
    question: query,
    title: 'Ask Help',
    subtitle: input.helpAvailable ? `“${query}”` : ASK_SIGNED_OUT,
    main: true
  }
}

function askSection(input: ResultsInput): Section {
  const entries: Entry[] = []
  if (input.lastQuestion) {
    entries.push({
      key: 'continue',
      type: 'continue',
      title: 'Continue your Help conversation',
      subtitle: `“${input.lastQuestion}”`
    })
  }
  for (const q of input.questions) {
    entries.push({
      key: `ask:${q.id}`,
      type: 'ask',
      question: q.question,
      title: q.title ?? q.question,
      subtitle: input.helpAvailable ? q.subtitle : ASK_SIGNED_OUT
    })
  }
  return { key: 'ask', label: 'Ask Help', entries }
}

/** Before anything is typed. */
function browse(input: ResultsInput): Section[] {
  const { scope } = input
  if (scope === 'help') return [askSection(input)].filter((s) => s.entries.length)
  if (scope !== 'all') {
    const items = input.lists[scope]
    return items.length
      ? [
          {
            key: scope,
            label: GROUP_LABELS[scope],
            count: items.length,
            entries: items.slice(0, VIEW_LIMIT).map((item) => itemEntry(item))
          }
        ]
      : []
  }
  const views = GROUPS.filter((g) => g !== 'files' || input.hasFiles)
  const sections: Section[] = [
    {
      key: 'suggestions',
      label: 'Suggestions',
      entries: input.suggestions.map((item) => itemEntry(item))
    },
    {
      key: 'recent',
      label: 'Recent projects',
      entries: input.recentProjects.slice(0, RECENT).map((item) => itemEntry(item))
    },
    {
      key: 'views',
      label: 'Search',
      entries: views.map((view) => ({ key: `view:${view}`, type: 'view', view }))
    },
    askSection(input)
  ]
  return sections.filter((s) => s.entries.length)
}

export function buildResults(input: ResultsInput): Results {
  const query = input.query.trim()
  const { scope } = input
  // In Help, what's typed is a question to ask, not something to find.
  if (scope === 'help') {
    const sections: Section[] = input.answering
      ? []
      : query
        ? [{ key: 'ask', entries: [askEntry(query, input)] }]
        : browse(input)
    return { sections, counts: {} }
  }
  if (!query) return { sections: browse(input), counts: {} }

  // Every kind is ranked, so each view can say how many it holds.
  const ranked = GROUPS.map((key) => ({
    key,
    results: rank(input.groups[key], query, { boost: input.boost })
  }))
  const counts = Object.fromEntries(ranked.map((g) => [g.key, g.results.length]))

  if (scope !== 'all') {
    const { results } = ranked.find((g) => g.key === scope)!
    const sections: Section[] = results.length
      ? [
          {
            key: scope,
            label: GROUP_LABELS[scope],
            count: results.length,
            entries: results.slice(0, VIEW_LIMIT).map((r) => itemEntry(r.item, r.ranges))
          }
        ]
      : []
    return { sections, counts }
  }

  // One list, best first, with no kind crowding out the rest.
  const results = ranked
    .flatMap(({ key, results }) => results.slice(0, LIMITS[key]))
    .sort((a, b) => b.score - a.score)
  const use: Section = {
    key: 'use',
    label: `Use “${query}” with…`,
    entries: [
      askEntry(query, input),
      ...ranked
        .filter(({ results }) => results.length > 0)
        .map(({ key, results }): Entry => ({
          key: `view:${key}`,
          type: 'view',
          view: key,
          count: results.length
        }))
    ]
  }
  const found: Section = {
    key: 'results',
    label: 'Results',
    entries: results.map((r) => itemEntry(r.item, r.ranges))
  }
  // A question goes to Help first; anything else, after what was found.
  const sections = looksLikeQuestion(query) ? [use, found] : [found, use]
  return { sections: sections.filter((s) => s.entries.length), counts }
}
