import { useSyncExternalStore } from 'react'

// What the terminal panel shows, kept apart from the terminals themselves (see
// session.ts, loaded with the panel) so the status bar and the shortcuts don't
// load xterm.js. Each project has its own terminals, and its own panel open or
// closed; the panel's size, text size and the shell new terminals run are the
// same for every project, and remembered.

export type TerminalStatus = 'starting' | 'running' | 'exited' | 'failed'

export interface TerminalTab {
  key: string
  /** The shell it runs, once it has started (a `terminal.shells` id). */
  shellId?: string
  shellName?: string
  /** What a new terminal was asked to run; the default when absent. */
  requestedShell?: string
  status: TerminalStatus
  exitCode?: number | null
  /** Why it couldn't start. */
  error?: string
  /** What the shell last set the terminal's title to. */
  title?: string
  /** It printed something while another terminal was showing. */
  unread: boolean
}

export interface ProjectTerminals {
  open: boolean
  tabs: TerminalTab[]
  /** The shell tab in front, or that comes back to the front when Output gives way. */
  active: string | null
  /** The app's Output is showing rather than a shell (see `showOutput`). */
  output: boolean
}

export interface TerminalState {
  projects: Readonly<Record<string, ProjectTerminals>>
  /** The panel's height in CSS pixels, when it isn't maximized. */
  height: number
  /** The panel fills the project's area. */
  maximized: boolean
  fontSize: number
  /** The shell new terminals run: the last one picked; the computer's default when null. */
  shell: string | null
  /** Bumped to move the keyboard into the open project's terminal. */
  focusRequest: number
}

export const DEFAULT_HEIGHT = 300
export const MIN_HEIGHT = 120
export const DEFAULT_FONT_SIZE = 13
export const MIN_FONT_SIZE = 9
export const MAX_FONT_SIZE = 28

const STORAGE_KEY = 'fabricator.terminal'
const NO_TABS: ProjectTerminals = { open: false, tabs: [], active: null, output: false }

interface Remembered {
  height?: number
  fontSize?: number
  shell?: string | null
}

function recall(): Remembered {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return value && typeof value === 'object' ? (value as Remembered) : {}
  } catch {
    return {}
  }
}

function remember(next: TerminalState): void {
  try {
    const value: Remembered = { height: next.height, fontSize: next.fontSize, shell: next.shell }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    /* best-effort: the next launch starts from the defaults */
  }
}

function clampFont(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
}

function initialState(): TerminalState {
  const saved = recall()
  return {
    projects: {},
    height:
      typeof saved.height === 'number' && saved.height >= MIN_HEIGHT
        ? saved.height
        : DEFAULT_HEIGHT,
    maximized: false,
    fontSize: typeof saved.fontSize === 'number' ? clampFont(saved.fontSize) : DEFAULT_FONT_SIZE,
    shell: typeof saved.shell === 'string' ? saved.shell : null,
    focusRequest: 0
  }
}

let state = initialState()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getState(): TerminalState {
  return state
}

function set(next: TerminalState): void {
  if (next === state) return
  const persisted =
    next.height !== state.height || next.fontSize !== state.fontSize || next.shell !== state.shell
  state = next
  if (persisted) remember(state)
  listeners.forEach((listener) => listener())
}

function withProject(
  projectId: string,
  change: (project: ProjectTerminals) => ProjectTerminals
): TerminalState {
  const project = state.projects[projectId] ?? NO_TABS
  const next = change(project)
  if (next === project) return state
  return { ...state, projects: { ...state.projects, [projectId]: next } }
}

function newKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

/** A new terminal tab, in front. */
function addTab(project: ProjectTerminals, shell: string | undefined): ProjectTerminals {
  const tab: TerminalTab = {
    key: newKey(),
    requestedShell: shell,
    status: 'starting',
    unread: false
  }
  return { open: true, tabs: [...project.tabs, tab], active: tab.key, output: false }
}

export const terminalStore = {
  subscribe,
  getState,

  /** Show the project's shells, starting one when it has none. */
  open(projectId: string, focus = true): void {
    set(
      withProject(projectId, (project) =>
        project.tabs.length === 0
          ? addTab(project, state.shell ?? undefined)
          : project.open && !project.output
            ? project
            : { ...project, open: true, output: false }
      )
    )
    if (focus) terminalStore.focus()
  },

  /**
   * Show the app's Output: its backend, Vite and functions on this computer, in a
   * read-only tab before the shells. Only for an app that runs on this computer.
   */
  showOutput(projectId: string, focus = true): void {
    set(
      withProject(projectId, (project) =>
        project.open && project.output ? project : { ...project, open: true, output: true }
      )
    )
    if (focus) terminalStore.focus()
  },

  /** The app no longer runs on this computer: its Output goes, and the panel with it unless shells run. */
  hideOutput(projectId: string): void {
    set(
      withProject(projectId, (project) =>
        project.output
          ? { ...project, output: false, open: project.open && project.tabs.length > 0 }
          : project
      )
    )
  },

  /** Put the panel away. Its terminals keep running. */
  close(projectId: string): void {
    set(withProject(projectId, (project) => (project.open ? { ...project, open: false } : project)))
  },

  /** Start another terminal in the project: `shell`, or the one new terminals run. */
  add(projectId: string, shell?: string): void {
    if (shell && shell !== state.shell) set({ ...state, shell })
    set(withProject(projectId, (project) => addTab(project, shell ?? state.shell ?? undefined)))
    terminalStore.focus()
  },

  /** Take a terminal away (its session ends it). The panel closes with the last one, unless Output shows. */
  remove(projectId: string, key: string): void {
    set(
      withProject(projectId, (project) => {
        const at = project.tabs.findIndex((tab) => tab.key === key)
        if (at < 0) return project
        const tabs = project.tabs.filter((tab) => tab.key !== key)
        const active =
          project.active === key
            ? (tabs[Math.min(at, tabs.length - 1)]?.key ?? null)
            : project.active
        return {
          ...project,
          open: project.open && (tabs.length > 0 || project.output),
          tabs,
          active
        }
      })
    )
  },

  /** Bring a shell to the front, in Output's place too. */
  activate(projectId: string, key: string): void {
    set(
      withProject(projectId, (project) =>
        (project.active === key && !project.output) || !project.tabs.some((tab) => tab.key === key)
          ? project
          : {
              ...project,
              active: key,
              output: false,
              tabs: project.tabs.map((tab) => (tab.key === key ? { ...tab, unread: false } : tab))
            }
      )
    )
  },

  /** Record what a terminal's session learned: it started, ended, printed, or got a title. */
  update(projectId: string, key: string, patch: Partial<Omit<TerminalTab, 'key'>>): void {
    set(
      withProject(projectId, (project) => {
        const tab = project.tabs.find((t) => t.key === key)
        const same = (k: string, v: unknown): boolean => tab?.[k as keyof TerminalTab] === v
        if (!tab || Object.entries(patch).every(([k, v]) => same(k, v))) return project
        return { ...project, tabs: project.tabs.map((t) => (t === tab ? { ...t, ...patch } : t)) }
      })
    )
  },

  /** A project left Fabricator: forget its terminals (their sessions end them). */
  forget(projectId: string): void {
    if (!(projectId in state.projects)) return
    const projects = { ...state.projects }
    delete projects[projectId]
    set({ ...state, projects })
  },

  setHeight(height: number): void {
    set({ ...state, height: Math.max(MIN_HEIGHT, Math.round(height)) })
  },

  setMaximized(maximized: boolean): void {
    if (maximized !== state.maximized) set({ ...state, maximized })
  },

  setFontSize(size: number): void {
    const fontSize = clampFont(size)
    if (fontSize !== state.fontSize) set({ ...state, fontSize })
  },

  /** Move the keyboard into the open project's terminal. */
  focus(): void {
    set({ ...state, focusRequest: state.focusRequest + 1 })
  }
}

export function useTerminalState(): TerminalState {
  return useSyncExternalStore(subscribe, getState)
}

/** The project's Output is showing: re-renders only when that changes. */
export function useOutputShowing(projectId: string): boolean {
  return useSyncExternalStore(subscribe, () => {
    const project = projectTerminals(state, projectId)
    return project.open && project.output
  })
}

/** The project's terminals: none until one is opened. */
export function projectTerminals(
  current: TerminalState,
  projectId: string | undefined
): ProjectTerminals {
  return (projectId && current.projects[projectId]) || NO_TABS
}

/** Terminals whose shell is still running, or starting. */
export function liveCount(project: ProjectTerminals): number {
  return project.tabs.filter((tab) => tab.status === 'running' || tab.status === 'starting').length
}

const SHORT_NAMES: Record<string, string> = { 'git-bash': 'bash' }

/** Each tab's name: its shell's short name, numbered from the second of a kind. */
export function tabLabels(tabs: readonly TerminalTab[]): Map<string, string> {
  const seen = new Map<string, number>()
  const labels = new Map<string, string>()
  for (const tab of tabs) {
    const id = tab.shellId ?? tab.requestedShell
    const base = id ? (SHORT_NAMES[id] ?? id) : 'terminal'
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    labels.set(tab.key, count === 1 ? base : `${base} ${count}`)
  }
  return labels
}

/** True while the keyboard is in a terminal. */
export function terminalFocused(): boolean {
  return Boolean(document.activeElement?.closest('.terminal-panel'))
}
