// What Search finds, and how a result is shown.

/** The groups results come in, in their default order. */
export type SearchGroup = 'projects' | 'apps' | 'actions' | 'docs' | 'files'

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
  /** It's open right now: its hint shows as live. */
  live?: boolean
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

/** Each group's name, as its key in `spotlight`. */
export const GROUP_LABELS = {
  projects: 'groups.projects',
  apps: 'groups.apps',
  actions: 'groups.actions',
  docs: 'groups.docs',
  files: 'groups.files'
} as const satisfies Record<SearchGroup, string>

/** What each group's results are, and what Enter does with one (keys in `spotlight`). */
export const GROUP_DEFAULTS = {
  projects: { kind: 'kinds.projects', verb: 'verbs.projects' },
  apps: { kind: 'kinds.apps', verb: 'verbs.apps' },
  actions: { kind: 'kinds.actions', verb: 'verbs.actions' },
  docs: { kind: 'kinds.docs', verb: 'actions.openInBrowser' },
  files: { kind: 'kinds.files', verb: 'verbs.files' }
} as const satisfies Record<SearchGroup, { kind: string; verb: string }>

/**
 * Each view: its row and title, and what its search box asks for. Its title and
 * placeholder are keys in `spotlight`.
 */
export const VIEWS = {
  projects: {
    title: 'views.projects.title',
    icon: { kind: 'codicon', name: 'folder-library', hue: HUE.violet },
    placeholder: 'views.projects.placeholder'
  },
  apps: {
    title: 'views.apps.title',
    icon: { kind: 'codicon', name: 'library', hue: HUE.green },
    placeholder: 'views.apps.placeholder'
  },
  actions: {
    title: 'views.actions.title',
    icon: { kind: 'codicon', name: 'zap', hue: HUE.amber },
    placeholder: 'views.actions.placeholder'
  },
  docs: {
    title: 'views.docs.title',
    icon: { kind: 'codicon', name: 'book', hue: HUE.blue },
    placeholder: 'views.docs.placeholder'
  },
  files: {
    title: 'views.files.title',
    icon: { kind: 'codicon', name: 'files', hue: HUE.teal },
    placeholder: 'views.files.placeholder'
  },
  help: { title: 'views.help.title', icon: { kind: 'ray' }, placeholder: 'views.help.placeholder' }
} as const satisfies Record<SearchView, { title: string; icon: ItemIcon; placeholder: string }>

/**
 * The views in the order Ctrl+1…6 (⌘1…6) opens them. Fabric apps came later,
 * so they're last, and the others keep the keys people know.
 */
export const VIEW_ORDER: SearchView[] = ['projects', 'actions', 'docs', 'files', 'help', 'apps']
