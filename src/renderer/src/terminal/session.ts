import {
  Terminal,
  type IBufferLine,
  type ILink,
  type ILinkProvider,
  type ITerminalOptions
} from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  SearchAddon,
  type ISearchOptions,
  type ISearchResultChangeEvent
} from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { LocalLogEvent } from '@shared/ipc'
import { errorMessage } from '../errorReport'
import { translator } from '../i18n'
import { isMac, modKey } from '../platform'
import { filePaths, findFileLinks, projectRelative } from './links'
import { newOutput, OUTPUT_LINES } from './output'
import { DEFAULT_FONT_SIZE, terminalStore, type TerminalTab } from './store'
import { isLightTheme, searchColors, terminalTheme } from './theme'
import './fonts.css'

// The terminals themselves: an xterm.js terminal per tab and the shell it runs
// in a PTY (see services/terminal), and each app's read-only Output. They
// outlive the panel, which only shows them: hiding it, switching tabs or
// projects, leaves every shell running.

/** Output xterm.js hasn't drawn yet at which the shell is held, and at which it carries on. */
const HIGH_WATER = 256 * 1024
const LOW_WATER = 32 * 1024
/** Terminals that keep a WebGL renderer (each holds a GPU context); the rest draw with the DOM. */
const MAX_WEBGL = 4
/** Resizes are sent to the shell once a drag settles: ConPTY redraws on every one. */
const RESIZE_DELAY_MS = 60
/** How long a project's file list serves its links before it's read again. */
const FILES_TTL_MS = 15_000

/** Keep the system's text font, with bundled prompt symbols when no Nerd Font is installed. */
const FONT_FAMILY = [
  "'Cascadia Mono'",
  "'Cascadia Code'",
  "'CaskaydiaCove NFM'",
  "'CaskaydiaCove Nerd Font Mono'",
  "'CaskaydiaCove NF'",
  "'MesloLGS NF'",
  "'JetBrainsMono Nerd Font Mono'",
  "'FiraCode Nerd Font Mono'",
  "'Hack Nerd Font Mono'",
  "'Symbols Nerd Font Mono'",
  'Consolas',
  'ui-monospace',
  'Menlo',
  'Monaco',
  "'DejaVu Sans Mono'",
  "'Fabricator Terminal Symbols'",
  'monospace'
].join(', ')

/** What the panel does for the terminals: links, menus and the find bar. */
export interface TerminalHooks {
  openUrl(url: string): void
  openFile(path: string, line?: number): void
  find(): void
  menu(x: number, y: number): void
  /** A link is under the pointer (`hint` says how to open it), or no longer is (null). */
  linkHint(event: MouseEvent | null, hint?: string): void
}

let hooks: TerminalHooks | null = null

/** The panel that's showing gives the terminals what they hand off to it. */
export function setTerminalHooks(next: TerminalHooks | null): void {
  hooks = next
}

/** The interface zoom, which the terminal undoes (see `.terminal-surface`) and puts back in its text size. */
function uiScale(): number {
  const value = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')
  )
  return Number.isFinite(value) && value > 0 ? value : 1
}

/** Ctrl+click opens links, or ⌘-click on macOS, so a plain click still selects. */
function opensLinks(event: MouseEvent): boolean {
  return isMac() ? event.metaKey : event.ctrlKey
}

/** How to open the link under the pointer: a web link, or a project file in the Code tab. */
function openHint(inCode = false): string {
  const t = translator('code')
  if (isMac()) return inCode ? t('session.openFileMac') : t('session.openLinkMac')
  return inCode
    ? t('session.openFile', { ctrl: modKey() })
    : t('session.openLink', { ctrl: modKey() })
}

/** 1-based terminal columns of each character offset in a buffer line's text. */
function columnsOf(line: IBufferLine): number[] {
  const columns: number[] = []
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    if (cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) columns.push(x + 1)
  }
  return columns
}

interface ProjectFiles {
  paths: Set<string> | null
  readAt: number
  reading: boolean
}

const projectFiles = new Map<string, ProjectFiles>()

/** The project's files for its links, read again in the background once stale. */
function filesOf(projectId: string): Set<string> | null {
  let entry = projectFiles.get(projectId)
  if (!entry) {
    entry = { paths: null, readAt: 0, reading: false }
    projectFiles.set(projectId, entry)
  }
  const files = entry
  if (!files.reading && Date.now() - files.readAt > FILES_TTL_MS) {
    files.reading = true
    void window.api.projects.files
      .tree(projectId)
      .then((tree) => {
        files.paths = filePaths(tree)
      })
      .catch(() => undefined)
      .finally(() => {
        files.reading = false
        files.readAt = Date.now()
      })
  }
  return files.paths
}

const withWebgl: TerminalView[] = []
/** WebGL failed here once (no WebGL 2): every terminal draws with the DOM. */
let webglUnavailable = false

/**
 * An xterm.js terminal the panel shows: sized to its area, drawn in the app's
 * theme and zoom, with find, copy, and links to web pages and the project's files.
 */
export abstract class TerminalView {
  readonly key: string
  readonly projectId: string
  readonly term: Terminal
  protected readonly projectPath: string
  private readonly fitAddon = new FitAddon()
  private readonly searchAddon = new SearchAddon({ highlightLimit: 1000 })
  private webgl: WebglAddon | null = null
  /** Where xterm.js draws; moved into whichever panel shows it. */
  private readonly host: HTMLDivElement
  private opened = false
  protected disposed = false
  protected visible = false
  /** The theme it's drawn in. */
  private light: boolean

  constructor(key: string, projectId: string, projectPath: string, options: ITerminalOptions = {}) {
    this.key = key
    this.projectId = projectId
    this.projectPath = projectPath
    this.host = document.createElement('div')
    this.host.className = 'terminal-host'
    this.host.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      hooks?.menu(event.clientX, event.clientY)
    })

    const light = isLightTheme()
    this.light = light
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: FONT_FAMILY,
      fontSize: terminalStore.getState().fontSize * uiScale(),
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      scrollback: 10_000,
      theme: terminalTheme(),
      minimumContrastRatio: light ? 4.5 : 1,
      linkHandler: {
        activate: (event, uri) => {
          if (opensLinks(event)) hooks?.openUrl(uri)
        },
        hover: (event) => hooks?.linkHint(event, openHint()),
        leave: () => hooks?.linkHint(null)
      },
      ...options
    })
    this.term.loadAddon(this.fitAddon)
    this.term.loadAddon(this.searchAddon)
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'
    this.term.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          if (opensLinks(event)) hooks?.openUrl(uri)
        },
        {
          hover: (event) => hooks?.linkHint(event, openHint()),
          leave: () => hooks?.linkHint(null)
        }
      )
    )
    this.term.registerLinkProvider(this.fileLinks())
    this.term.attachCustomKeyEventHandler((event) => this.onKey(event))
  }

  /** Show the terminal in `container`, opened the first time. */
  attach(container: HTMLElement): void {
    if (this.disposed) return
    if (this.host.parentElement !== container) container.appendChild(this.host)
    if (!this.opened) {
      this.term.open(this.host)
      this.opened = true
      // Canvas renderers cache missing glyphs until their atlas is cleared.
      void document.fonts.load('14px "Fabricator Terminal Symbols"').then(
        () => {
          if (this.disposed) return
          this.term.clearTextureAtlas()
          this.fit()
          this.term.refresh(0, this.term.rows - 1)
        },
        (error: unknown) => console.warn('Could not load terminal prompt symbols', error)
      )
    }
    this.visible = true
    this.useWebgl()
    this.fit()
    this.shown()
  }

  /** Stop showing it. It keeps running. */
  detach(): void {
    this.visible = false
    this.host.remove()
  }

  focus(): void {
    this.term.focus()
  }

  /** Match the terminal to its container's size. */
  fit(): void {
    if (!this.opened || !this.host.isConnected) return
    if (this.host.clientWidth < 20 || this.host.clientHeight < 20) return
    const size = this.fitAddon.proposeDimensions()
    if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return
    if (size.cols !== this.term.cols || size.rows !== this.term.rows) this.fitAddon.fit()
  }

  /** The app's theme or zoom, or the terminal text size, changed. */
  restyle(): void {
    const light = isLightTheme()
    if (light !== this.light) {
      this.light = light
      this.term.options.theme = terminalTheme()
      this.term.options.minimumContrastRatio = light ? 4.5 : 1
    }
    const fontSize = terminalStore.getState().fontSize * uiScale()
    if (this.term.options.fontSize !== fontSize) this.term.options.fontSize = fontSize
    this.fit()
  }

  hasSelection(): boolean {
    return this.term.hasSelection()
  }

  copy(): void {
    const text = this.term.getSelection()
    if (!text) return
    void navigator.clipboard?.writeText(text).catch(() => undefined)
    this.term.clearSelection()
  }

  selectAll(): void {
    this.term.selectAll()
  }

  clear(): void {
    this.term.clear()
    this.focus()
  }

  /** All it holds, as text: a line that wraps is one line. */
  text(): string {
    const buffer = this.term.buffer.active
    const lines: string[] = []
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)
      if (!line) continue
      const text = line.translateToString(!buffer.getLine(y + 1)?.isWrapped)
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
      else lines.push(text)
    }
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
    return lines.join('\n')
  }

  findNext(query: string, options: ISearchOptions): boolean {
    return this.searchAddon.findNext(query, this.searchOptions(options))
  }

  findPrevious(query: string, options: ISearchOptions): boolean {
    return this.searchAddon.findPrevious(query, this.searchOptions(options))
  }

  clearSearch(): void {
    this.searchAddon.clearDecorations()
  }

  onSearchResults(listener: (event: ISearchResultChangeEvent) => void): () => void {
    const subscription = this.searchAddon.onDidChangeResults(listener)
    return () => subscription.dispose()
  }

  /** It's gone (its tab closed, or its project left Fabricator): let the terminal go. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ended()
    this.dropWebgl()
    this.term.dispose()
    this.host.remove()
  }

  /** It's on screen. */
  protected shown(): void {}

  /** It's being disposed: let go of what feeds it. */
  protected ended(): void {}

  private onKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true
    const key = event.key.toLowerCase()
    const mod = isMac() ? event.metaKey : event.ctrlKey
    // The app's own shortcuts reach the app: the terminal toggle and Help.
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Backquote') return false
    if (mod && !event.altKey && !event.shiftKey && key === 'j') return false
    if (mod && !event.altKey && !event.shiftKey && key === 'f') {
      event.preventDefault()
      hooks?.find()
      return false
    }
    if (mod && !event.altKey && (key === '=' || key === '+' || key === '-' || key === '0')) {
      event.preventDefault()
      const size = terminalStore.getState().fontSize
      terminalStore.setFontSize(key === '0' ? DEFAULT_FONT_SIZE : key === '-' ? size - 1 : size + 1)
      return false
    }
    if (!isMac() && event.ctrlKey && !event.altKey && !event.metaKey) {
      // Ctrl+C copies when text is selected, and is the shell's interrupt otherwise.
      if (key === 'c' && (event.shiftKey || this.term.hasSelection())) {
        event.preventDefault()
        this.copy()
        return false
      }
      // The browser pastes, and xterm.js types it from the paste event.
      if (key === 'v') return false
    }
    return true
  }

  private fileLinks(): ILinkProvider {
    const windows = /^[A-Za-z]:[\\/]/.test(this.projectPath)
    return {
      provideLinks: (y, callback) => {
        const line = this.term.buffer.active.getLine(y - 1)
        const text = line?.translateToString(true) ?? ''
        const files = line && /[./\\]/.test(text) ? filesOf(this.projectId) : null
        if (!line || !files) return callback(undefined)
        const links = findFileLinks(text, (raw) => {
          const path = projectRelative(raw, this.projectPath, windows)
          return path && files.has(path) ? path : null
        })
        if (links.length === 0) return callback(undefined)
        const columns = columnsOf(line)
        callback(
          links.map((link): ILink => ({
            text: text.slice(link.start, link.end),
            range: {
              start: { x: columns[link.start] ?? link.start + 1, y },
              end: { x: columns[link.end - 1] ?? link.end, y }
            },
            activate: (event) => {
              if (opensLinks(event)) hooks?.openFile(link.path, link.line)
            },
            hover: (event) => hooks?.linkHint(event, openHint(true)),
            leave: () => hooks?.linkHint(null)
          }))
        )
      }
    }
  }

  private searchOptions(options: ISearchOptions): ISearchOptions {
    const colors = searchColors()
    return {
      ...options,
      decorations: {
        matchBackground: colors.match,
        activeMatchBackground: colors.active,
        activeMatchBorder: colors.ruler,
        matchOverviewRuler: colors.match,
        activeMatchColorOverviewRuler: colors.ruler
      }
    }
  }

  private useWebgl(): void {
    if (webglUnavailable) return
    const at = withWebgl.indexOf(this)
    if (at >= 0) withWebgl.splice(at, 1)
    if (!this.webgl) {
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          if (this.webgl === addon) this.dropWebgl()
        })
        this.term.loadAddon(addon)
        this.webgl = addon
      } catch {
        webglUnavailable = true
        return
      }
    }
    withWebgl.push(this)
    while (withWebgl.length > MAX_WEBGL) withWebgl.shift()?.dropWebgl()
  }

  private dropWebgl(): void {
    const at = withWebgl.indexOf(this)
    if (at >= 0) withWebgl.splice(at, 1)
    this.webgl?.dispose()
    this.webgl = null
  }
}

/** A tab's shell, in a PTY in the project's folder, started once the tab is first shown. */
export class TerminalSession extends TerminalView {
  private shell: string | undefined
  /** The running shell's id, or null between shells. */
  private ptyId: string | null = null
  /** The shell it started last. One a restart replaced while it started isn't wanted. */
  private latest: string | null = null
  private status: TerminalTab['status'] = 'starting'
  private started = false
  private unread = false
  private pending = 0
  private paused = false
  private outbox = ''
  private sending = false
  private resizeTimer = 0

  constructor(projectId: string, projectPath: string, tab: TerminalTab) {
    super(tab.key, projectId, projectPath)
    this.shell = tab.shellId ?? tab.requestedShell
    this.term.onData((data) => this.input(data))
    this.term.onResize(({ cols, rows }) => this.resized(cols, rows))
    this.term.onTitleChange((title) => this.report({ title }))
  }

  get shellRunning(): boolean {
    return this.ptyId !== null
  }

  get shellId(): string | undefined {
    return this.shell
  }

  /** Paste from the clipboard, as the keyboard's paste does (bracketed for shells that ask). */
  paste(): void {
    void navigator.clipboard
      ?.readText()
      .then((text) => {
        if (text) this.term.paste(text)
      })
      .catch(() => undefined)
    this.focus()
  }

  /** Type `text` at the prompt, as a paste. */
  insert(text: string): void {
    this.term.paste(text)
    this.focus()
  }

  /** End the shell and start a new one in its place. */
  restart(): void {
    const running = this.ptyId
    this.ptyId = null
    this.outbox = ''
    if (running) void window.api.terminal.kill(running).catch(() => undefined)
    this.term.write('\r\n')
    void this.start()
    this.focus()
  }

  /** On screen: what it printed is seen, and its shell starts the first time, now it has a size. */
  protected override shown(): void {
    if (this.unread) {
      this.unread = false
      this.report({ unread: false })
    }
    if (!this.started) {
      this.started = true
      void this.start()
    }
  }

  /** The tab closed: end the shell. */
  protected override ended(): void {
    window.clearTimeout(this.resizeTimer)
    const running = this.ptyId
    this.ptyId = null
    if (running) void window.api.terminal.kill(running).catch(() => undefined)
  }

  private async start(): Promise<void> {
    const id = newId()
    this.ptyId = id
    this.latest = id
    this.pending = 0
    this.paused = false
    this.setStatus('starting', { exitCode: undefined, error: undefined })
    try {
      const info = await window.api.terminal.spawn(
        {
          id,
          projectId: this.projectId,
          shell: this.shell,
          cols: this.term.cols,
          rows: this.term.rows
        },
        (event) =>
          event.kind === 'output' ? this.output(id, event.data) : this.exited(id, event.code)
      )
      // Closed or restarted while it started: a kill sent then found nothing to end.
      if (this.disposed || this.latest !== id) {
        void window.api.terminal.kill(id).catch(() => undefined)
        return
      }
      this.shell = info.shellId
      if (info.windowsBuild) {
        this.term.options.windowsPty = { backend: 'conpty', buildNumber: info.windowsBuild }
      }
      this.report({ shellId: info.shellId, shellName: info.shellName })
      // The shell may have ended already, before its start returned.
      if (this.ptyId === id && this.status === 'starting') {
        this.setStatus('running')
        // What was typed while it started.
        void this.send()
      }
    } catch (error) {
      if (this.disposed || this.latest !== id) return
      this.ptyId = null
      this.outbox = ''
      const t = translator('code')
      const message = errorMessage(error, t('session.cantStart'))
      this.setStatus('failed', { error: message })
      this.term.write(`\x1b[31m${message}\x1b[0m\r\n\x1b[90m${t('session.pressEnter')}\x1b[0m\r\n`)
    }
  }

  private output(id: string, data: string): void {
    if (id !== this.ptyId || this.disposed) return
    const size = data.length
    this.pending += size
    this.term.write(data, () => {
      this.pending -= size
      if (this.paused && this.pending <= LOW_WATER && this.ptyId === id) {
        this.paused = false
        void window.api.terminal.pause(id, false).catch(() => undefined)
      }
    })
    if (!this.paused && this.pending > HIGH_WATER) {
      this.paused = true
      void window.api.terminal.pause(id, true).catch(() => undefined)
    }
    if (!this.visible && !this.unread) {
      this.unread = true
      this.report({ unread: true })
    }
  }

  private exited(id: string, code: number | null): void {
    if (id !== this.ptyId || this.disposed) return
    this.ptyId = null
    this.outbox = ''
    this.setStatus('exited', { exitCode: code })
    const t = translator('code')
    const how = code === null ? t('session.ended') : t('session.exited', { code })
    this.term.write(`\r\n\x1b[0m\x1b[90m${how}\x1b[0m\r\n`)
  }

  private input(data: string): void {
    if (this.disposed) return
    if (!this.ptyId) {
      // An ended shell: Enter starts another in its place.
      if (this.status !== 'starting' && data === '\r') this.restart()
      return
    }
    this.outbox += data
    void this.send()
  }

  /**
   * One write at a time, so keystrokes arrive in the order they were typed. What's
   * typed while the shell starts waits for it: until then, it has nowhere to go.
   */
  private async send(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      while (this.outbox && this.ptyId && this.status === 'running') {
        const data = this.outbox
        this.outbox = ''
        await window.api.terminal.write(this.ptyId, data).catch(() => undefined)
      }
    } finally {
      this.sending = false
    }
  }

  private resized(cols: number, rows: number): void {
    window.clearTimeout(this.resizeTimer)
    this.resizeTimer = window.setTimeout(() => {
      if (this.ptyId) void window.api.terminal.resize(this.ptyId, cols, rows).catch(() => undefined)
    }, RESIZE_DELAY_MS)
  }

  private setStatus(status: TerminalTab['status'], patch: Partial<TerminalTab> = {}): void {
    this.status = status
    this.report({ ...patch, status })
  }

  private report(patch: Partial<Omit<TerminalTab, 'key'>>): void {
    if (!this.disposed) terminalStore.update(this.projectId, this.key, patch)
  }
}

/**
 * The app's Output on this computer, read-only: what its backend, Vite and
 * functions print, from the lines the backend keeps, then as they come.
 */
export class OutputView extends TerminalView {
  /** The `seq` of the newest line printed. */
  private last = 0
  /** Lines that came while the recent ones were read; null once they're in. */
  private early: LocalLogEvent[] | null = []
  private readonly unsubscribe: () => void

  constructor(projectId: string, projectPath: string) {
    super(outputKey(projectId), projectId, projectPath, {
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: 'none'
    })
    // No cursor: nothing's typed here.
    this.term.write('\x1b[?25l')
    this.unsubscribe = window.api.local.onLog((line) => {
      if (line.projectId !== projectId) return
      if (this.early) this.early.push(line)
      else this.print([line])
    })
    window.api.local.logs(projectId, OUTPUT_LINES).then(
      (recent) => this.caughtUp(recent),
      () => this.caughtUp([])
    )
  }

  protected override ended(): void {
    this.unsubscribe()
  }

  private caughtUp(recent: LocalLogEvent[]): void {
    if (this.disposed || !this.early) return
    const lines = [...recent, ...this.early]
    this.early = null
    this.print(lines)
  }

  private print(lines: LocalLogEvent[]): void {
    const { text, last } = newOutput(lines, this.last)
    this.last = last
    if (text && !this.disposed) this.term.write(text)
  }
}

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  )
}

const sessions = new Map<string, TerminalSession>()
/** Each app's Output, by its key. */
const outputs = new Map<string, OutputView>()

/** The key of a project's Output, beside its shells' tab keys. */
export function outputKey(projectId: string): string {
  return `output:${projectId}`
}

/** The terminal for `tab`, made the first time it's shown. */
export function sessionFor(
  projectId: string,
  projectPath: string,
  tab: TerminalTab
): TerminalSession {
  let session = sessions.get(tab.key)
  if (!session) {
    session = new TerminalSession(projectId, projectPath, tab)
    sessions.set(tab.key, session)
  }
  return session
}

/** The project's Output, made the first time it's shown. */
export function outputFor(projectId: string, projectPath: string): OutputView {
  const key = outputKey(projectId)
  let output = outputs.get(key)
  if (!output) {
    output = new OutputView(projectId, projectPath)
    outputs.set(key, output)
  }
  return output
}

export function existingSession(key: string | null | undefined): TerminalSession | undefined {
  return key ? sessions.get(key) : undefined
}

/** The terminal `key` names, a shell's or an app's Output, once it's made. */
export function existingView(key: string | null | undefined): TerminalView | undefined {
  return key ? (sessions.get(key) ?? outputs.get(key)) : undefined
}

// A tab that's gone (closed, or its project left Fabricator) ends its terminal,
// and a project that left takes its Output with it.
terminalStore.subscribe(() => {
  const { projects } = terminalStore.getState()
  const open = new Set(
    Object.values(projects).flatMap((project) => project.tabs.map((tab) => tab.key))
  )
  for (const [key, session] of sessions) {
    if (!open.has(key)) {
      sessions.delete(key)
      session.dispose()
    }
  }
  for (const [key, output] of outputs) {
    if (!(output.projectId in projects)) {
      outputs.delete(key)
      output.dispose()
    }
  }
})

// The app's theme and zoom, and the terminal text size, apply to every terminal.
function restyleAll(): void {
  sessions.forEach((session) => session.restyle())
  outputs.forEach((output) => output.restyle())
}
let fontSize = terminalStore.getState().fontSize
terminalStore.subscribe(() => {
  const next = terminalStore.getState().fontSize
  if (next === fontSize) return
  fontSize = next
  restyleAll()
})
new MutationObserver(restyleAll).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme', 'style']
})
