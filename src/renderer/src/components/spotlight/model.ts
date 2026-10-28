// What Search finds, and how a result is shown.

/** The groups results come in, in their default order. */
export type SearchGroup = 'projects' | 'actions' | 'docs' | 'files'

/** Where Search is: everything, one kind of thing's own search, or asking Help. */
export type SearchScope = 'all' | SearchGroup | 'help'

/** A search of its own, opened from everything and left with Esc. */
export type SearchView = Exclude<SearchScope, 'all'>

/** Tile hues, so kinds of things tell apart at a glance. */
export const HUE = {
  blue: 208,
  violet: 262,
  green: 150,
  amber: 34,
  teal: 176,
  pink: 326
} as const

export type ItemIcon =
  /** A codicon on a small tile, tinted with its hue when it has one. */
  | { kind: 'codicon'; name: string; hue?: number }
  /** A project's initial on its own hue, as on Home. */
  | { kind: 'mark'; name: string }
  /** Ray, for asking Help. */
  | { kind: 'ray' }

/** What Search matches a query against. */
export interface Searchable {
  title: string
  subtitle?: string
  /** Other words for it, matched almost as strongly as the title. */
  keywords?: readonly string[]
  /** Longer text matched by whole words only, such as a page's description. */
  body?: string
}

/** Something more a result can do, listed under Actions (Ctrl+K). */
export interface ItemAction {
  id: string
  title: string
  /** A codicon. */
  icon: string
  /** Said once it's done, as Search closes: "Copied the link". */
  notice?: string
  run: () => void | Promise<void>
}

export interface SearchItem extends Searchable {
  /** Stable across opens, so a pick can be remembered: `project:<id>`, `action:settings`. */
  id: string
  group: SearchGroup
  icon: ItemIcon
  /** What it is, at the end of its row: Project, Workspace. Defaults by group. */
  kind?: string
  /** What Enter does with it, as the action bar says: "Open project". Defaults by group. */
  verb?: string
  /** A quiet word before its kind, such as "Open now". */
  hint?: string
  /** A shortcut that does the same thing, shown as keycaps: `['Ctrl', 'J']`. */
  keys?: string[]
  /** Nudges its rank: a docs section ranks a little below its page, say. */
  prior?: number
  /** What else it can do, under Actions. */
  actions?: ItemAction[]
  run: () => void
}

/** A question for Help, offered as a result. */
export interface AskSuggestion {
  id: string
  question: string
  /** Shown instead of the question, when it is worded for the user. */
  title?: string
  subtitle?: string
}

export const GROUP_LABELS: Record<SearchGroup, string> = {
  projects: 'Projects',
  actions: 'Actions',
  docs: 'Documentation',
  files: 'Files'
}

/** Each kind of thing, as a sentence names it: "No docs match". */
export const GROUP_NOUNS: Record<SearchGroup, string> = {
  projects: 'projects',
  actions: 'actions',
  docs: 'docs',
  files: 'files'
}

/** What each group's results are, and what Enter does with one. */
export const GROUP_DEFAULTS: Record<SearchGroup, { kind: string; verb: string }> = {
  projects: { kind: 'Project', verb: 'Open project' },
  actions: { kind: 'Action', verb: 'Run action' },
  docs: { kind: 'Docs', verb: 'Open in browser' },
  files: { kind: 'File', verb: 'Open in Code' }
}

/** Each view: its row and title, and what its search box asks for. */
export const VIEWS: Record<SearchView, { title: string; icon: ItemIcon; placeholder: string }> = {
  projects: {
    title: 'Search projects',
    icon: { kind: 'codicon', name: 'folder-library', hue: HUE.violet },
    placeholder: 'Search projects…'
  },
  actions: {
    title: 'Search actions',
    icon: { kind: 'codicon', name: 'zap', hue: HUE.amber },
    placeholder: 'Search actions…'
  },
  docs: {
    title: 'Search the docs',
    icon: { kind: 'codicon', name: 'book', hue: HUE.blue },
    placeholder: 'Search the docs…'
  },
  files: {
    title: 'Search files',
    icon: { kind: 'codicon', name: 'files', hue: HUE.teal },
    placeholder: 'Search files…'
  },
  help: { title: 'Ask Help', icon: { kind: 'ray' }, placeholder: 'Ask Help anything…' }
}

/** The views in the order Ctrl+1…5 (⌘1…5) opens them. */
export const VIEW_ORDER: SearchView[] = ['projects', 'actions', 'docs', 'files', 'help']
