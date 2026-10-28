import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import type { FileNode, HelpAction, HelpIssueDraft } from '@shared/ipc'
import type { DocsIndexPage } from 'virtual:docs-index'
import { Codicon } from '../icons'
import { FabricatorMark } from '../FabricatorMark'
import { useSuppressPreview } from '../../overlay'
import { useModalFocus } from '../../modalFocus'
import { useHelpConversation } from '../help/HelpConversation'
import type { HelpAskContext } from '../help/conversation'
import { actionIcon } from '../help/HelpExchange'
import { SpotlightAnswer } from './SpotlightAnswer'
import { ActionPanel, type PanelSection } from './ActionPanel'
import { Highlight, Icon, Keys } from './parts'
import { docItems, fileItems } from './sources'
import { prepare } from './rank'
import { readRecent, recencyBoost, rememberPick } from './recent'
import { buildResults, type Entry } from './results'
import {
  GROUP_DEFAULTS,
  GROUP_NOUNS,
  VIEWS,
  VIEW_ORDER,
  type AskSuggestion,
  type ItemAction,
  type ItemIcon,
  type SearchGroup,
  type SearchItem,
  type SearchScope
} from './model'
import './spotlight.css'

export interface SpotlightHelp {
  /** Help can answer: Copilot is signed in, or still being checked. */
  available: boolean
  /** What each question is asked with: the open project, the facts, the screen. */
  context: HelpAskContext
  /** Help can't answer: offer what can be done instead. */
  onUnavailable: () => void
  /** Carry on in the full-screen Help. */
  onOpen: () => void
  onAction: (action: HelpAction) => void
  onReportIssue: (issue: HelpIssueDraft) => void
}

export interface SpotlightProps {
  onClose: () => void
  /** Projects, team workspaces and actions. Docs and files are Search's own. */
  items: SearchItem[]
  /** Projects to offer before anything is typed, most recent first. */
  recentProjects: SearchItem[]
  /** What to suggest before anything is typed, given what's going on. */
  suggestions?: SearchItem[]
  /** Questions to offer Help before anything is typed. */
  questions: AskSuggestion[]
  /** The open project's files, which open in Code. */
  files?: {
    projectId: string
    projectName: string
    load: () => Promise<FileNode[]>
    open: (path: string) => void
  }
  /** Opens a docs page in the browser. */
  openUrl: (url: string) => void
  help: SpotlightHelp
  /** Says how an action went, once Search has closed: "Copied the link". */
  notify?: (message: string, kind?: 'success' | 'error') => void
  /** The shortcut modifier as printed on keycaps: Ctrl, or ⌘. */
  modKey: string
}

/** Between matches as good, what you're likelier to want: your projects, then actions. */
const GROUP_PRIOR: Record<SearchGroup, number> = {
  projects: 0.04,
  actions: 0.03,
  docs: 0,
  files: -0.02
}
/** How long a note in the action bar stays. */
const NOTICE_MS = 2200
/** Opened again within this long, Search is where you left it; later, it starts over. */
export const RESUME_MS = 90_000

/** Where Search was when it last closed, and when. */
const memory: { query: string; scope: SearchScope; closedAt: number } = {
  query: '',
  scope: 'all',
  closedAt: 0
}
/** Each project's files, from the last time Search listed them. */
const trees = new Map<string, FileNode[]>()
let docsLoad: Promise<DocsIndexPage[]> | null = null

function loadDocs(): Promise<DocsIndexPage[]> {
  docsLoad ??= import('virtual:docs-index').then(
    (module) => module.default.pages,
    () => {
      docsLoad = null
      return []
    }
  )
  return docsLoad
}

/** Test seam: forget where Search was. */
export function resetSpotlightMemory(): void {
  memory.query = ''
  memory.scope = 'all'
  memory.closedAt = 0
  trees.clear()
}

/** What Enter does with a result, as the action bar says it. */
function verbOf(entry: Entry): string {
  switch (entry.type) {
    case 'item':
      return entry.item.verb ?? GROUP_DEFAULTS[entry.item.group].verb
    case 'view':
      return VIEWS[entry.view].title
    case 'ask':
      return 'Ask Help'
    case 'continue':
      return 'Continue conversation'
  }
}

function iconOf(entry: Entry): ItemIcon {
  switch (entry.type) {
    case 'item':
      return entry.item.icon
    case 'view':
      return VIEWS[entry.view].icon
    default:
      return { kind: 'ray' }
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * Search: one box for finding a project, an action, a docs page or a file, and for
 * asking Help, which answers right here. Opened with Ctrl+K (⌘K).
 *
 * It works like a launcher. Everything is ranked in one list, then come other ways to
 * use what you typed. Each kind of thing also has a search of its own, which you go
 * into and come back from. The action bar says what Enter does, and Ctrl+K lists
 * everything else the result can do.
 */
export default function Spotlight({
  onClose,
  items,
  recentProjects,
  suggestions = [],
  questions,
  files,
  openUrl,
  help,
  notify,
  modKey
}: SpotlightProps): JSX.Element {
  useSuppressPreview()
  const windowRef = useModalFocus<HTMLDivElement>()
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const listId = useId()
  const hasFiles = Boolean(files)
  // Back soon, it's where you left it; after a while, it starts over at the top.
  const [resumed] = useState(() => Date.now() - memory.closedAt < RESUME_MS)
  const [query, setQuery] = useState(resumed ? memory.query : '')
  const [scope, setScope] = useState<SearchScope>(() =>
    !resumed || (memory.scope === 'files' && !hasFiles) ? 'all' : memory.scope
  )
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selectedBy = useRef<'keyboard' | 'pointer'>('keyboard')
  const [docs, setDocs] = useState<DocsIndexPage[] | null>(null)
  const [tree, setTree] = useState<FileNode[] | null>(() =>
    files ? (trees.get(files.projectId) ?? null) : null
  )
  const [recent] = useState(readRecent)
  /** A question just asked, until its exchange is in the conversation. */
  const [pending, setPending] = useState<{ question: string; after?: string } | null>(null)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const closed = useRef(false)

  const [conversation, { exchanges, busy }] = useHelpConversation()
  const last = exchanges[exchanges.length - 1]
  const waiting = pending !== null && (!last || last.id === pending.after || Boolean(last.restored))
  const answering = scope === 'help' && (waiting || Boolean(last))

  // Callbacks the results hold, kept fresh without rebuilding the results.
  const openUrlRef = useRef(openUrl)
  openUrlRef.current = openUrl
  const filesRef = useRef(files)
  filesRef.current = files

  /* ----------------------------- data ----------------------------- */

  useEffect(() => {
    let alive = true
    void loadDocs().then((pages) => {
      if (alive) setDocs(pages)
    })
    // So "Continue your Help conversation" knows there's one, after a restart too.
    void conversation.load()
    return () => {
      alive = false
    }
  }, [conversation])

  const projectId = files?.projectId
  useEffect(() => {
    if (!projectId) return
    let alive = true
    filesRef.current?.load().then(
      (nodes) => {
        trees.set(projectId, nodes)
        if (alive) setTree(nodes)
      },
      () => {
        // Files are a convenience; without them, Search still finds everything else.
      }
    )
    return () => {
      alive = false
    }
  }, [projectId])

  useEffect(() => {
    memory.query = query
    memory.scope = scope
  }, [query, scope])

  useEffect(
    () => () => {
      memory.closedAt = Date.now()
    },
    []
  )

  // A question's exchange has started: show it rather than the placeholder.
  useEffect(() => {
    if (pending && !waiting) setPending(null)
  }, [pending, waiting])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  /* ----------------------------- results ----------------------------- */

  const base = useMemo(() => prepare(items), [items])
  const docList = useMemo(
    () => (docs ? docItems(docs, (url) => openUrlRef.current(url)) : []),
    [docs]
  )
  const preparedDocs = useMemo(() => prepare(docList), [docList])
  const fileList = useMemo(
    () => (tree && hasFiles ? fileItems(tree, (path) => filesRef.current?.open(path)) : []),
    [tree, hasFiles]
  )
  const preparedFiles = useMemo(() => prepare(fileList), [fileList])
  const boost = useMemo(() => {
    const recency = recencyBoost(recent)
    return (item: SearchItem): number => recency(item) + GROUP_PRIOR[item.group] + (item.prior ?? 0)
  }, [recent])

  const { sections } = useMemo(
    () =>
      buildResults({
        query,
        scope,
        groups: {
          projects: base.filter((p) => p.item.group === 'projects'),
          actions: base.filter((p) => p.item.group === 'actions'),
          docs: preparedDocs,
          files: preparedFiles
        },
        lists: {
          projects: items.filter((i) => i.group === 'projects'),
          actions: items.filter((i) => i.group === 'actions'),
          docs: docList.filter((i) => !i.id.includes('#')),
          files: [...fileList].sort((a, b) => a.id.localeCompare(b.id))
        },
        boost,
        recentProjects,
        suggestions,
        questions,
        hasFiles,
        lastQuestion: exchanges.length > 0 ? last?.question : undefined,
        helpAvailable: help.available,
        answering
      }),
    [
      query,
      scope,
      base,
      items,
      preparedDocs,
      docList,
      preparedFiles,
      fileList,
      boost,
      recentProjects,
      suggestions,
      questions,
      hasFiles,
      exchanges.length,
      last?.question,
      help.available,
      answering
    ]
  )

  const entries = useMemo(() => sections.flatMap((s) => s.entries), [sections])
  const indexOf = useMemo(() => new Map(entries.map((e, i) => [e.key, i])), [entries])
  const selected = entries.find((e) => e.key === selectedKey) ?? entries[0] ?? null
  const optionId = (key: string): string => `${listId}-o${indexOf.get(key) ?? 0}`

  /* ----------------------------- doing ----------------------------- */

  const close = useCallback((): void => {
    if (closed.current) return
    closed.current = true
    onClose()
  }, [onClose])

  const changeScope = useCallback((next: SearchScope): void => {
    setScope(next)
    setSelectedKey(null)
    setActionsOpen(false)
    selectedBy.current = 'keyboard'
    inputRef.current?.focus()
  }, [])

  const ask = useCallback(
    (question: string): void => {
      const text = question.trim()
      if (!text) return
      if (!help.available) {
        close()
        help.onUnavailable()
        return
      }
      setPending({ question: text, after: last?.id })
      setScope('help')
      setQuery('')
      setSelectedKey(null)
      inputRef.current?.focus()
      void conversation.checkGrounding()
      void conversation.ask(text, [], help.context)
    },
    [close, conversation, help, last?.id]
  )

  const openInHelp = useCallback((): void => {
    if (!help.available) {
      close()
      help.onUnavailable()
      return
    }
    // Help takes over from here; Search closes behind it.
    closed.current = true
    help.onOpen()
  }, [close, help])

  const activate = (entry: Entry): void => {
    switch (entry.type) {
      case 'item':
        rememberPick(entry.item.id)
        close()
        entry.item.run()
        return
      case 'view':
        changeScope(entry.view)
        return
      case 'ask':
        ask(entry.question)
        return
      case 'continue':
        changeScope('help')
        return
    }
  }

  // Search closes first, as it does for Enter; the app says how it went.
  const runItemAction = (item: SearchItem, action: ItemAction): void => {
    rememberPick(item.id)
    close()
    let done: Promise<void>
    try {
      // Run now, inside the keypress or click, so the clipboard accepts a copy.
      done = Promise.resolve(action.run())
    } catch (reason) {
      done = Promise.reject(reason)
    }
    done.then(
      () => {
        if (action.notice) notify?.(action.notice)
      },
      () => notify?.(`${action.title} didn’t work. Try again.`, 'error')
    )
  }

  const select = (key: string, by: 'keyboard' | 'pointer'): void => {
    selectedBy.current = by
    setSelectedKey(key)
  }

  const move = (delta: number): void => {
    if (entries.length === 0) return
    const at = selected ? entries.indexOf(selected) : -1
    const next = at < 0 ? 0 : (at + delta + entries.length) % entries.length
    select(entries[next].key, 'keyboard')
  }

  // Reading an answer, the arrow keys scroll it: a line, or with Page Up/Down a page.
  const scrollAnswer = (direction: 1 | -1, page: boolean): void => {
    const pane = windowRef.current?.querySelector<HTMLElement>('.sl-answer')
    if (!pane) return
    const step = page ? Math.max(pane.clientHeight - 48, 48) : 56
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    pane.scrollBy?.({ top: direction * step, behavior: still ? 'auto' : 'smooth' })
  }

  /* ----------------------------- actions ----------------------------- */

  const shown = waiting ? undefined : last
  const copyAnswer = (text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => setNotice('Copied the answer'),
      () => setNotice('Couldn’t copy the answer')
    )
  }

  // Everything the result you're on can do, for the Actions panel (Ctrl+K).
  const panel = ((): { title: string; sections: PanelSection[] } | null => {
    if (answering) {
      const sections: PanelSection[] = [
        {
          actions: [
            {
              id: 'open-help',
              title: 'Open in Help',
              icon: { kind: 'ray' },
              keys: [modKey, 'J'],
              run: openInHelp
            },
            ...(shown?.answer
              ? [
                  {
                    id: 'copy-answer',
                    title: 'Copy answer',
                    icon: 'copy',
                    run: () => copyAnswer(shown.answer)
                  }
                ]
              : []),
            ...(busy
              ? [
                  {
                    id: 'stop',
                    title: 'Stop answering',
                    icon: 'debug-stop',
                    keys: ['Esc'],
                    run: () => conversation.stop()
                  }
                ]
              : [])
          ]
        }
      ]
      if (shown && shown.actions.length > 0 && shown.status !== 'thinking') {
        sections.push({
          title: 'Help suggests',
          actions: shown.actions.map((action) => ({
            id: `help:${action.id}:${action.url ?? action.target ?? ''}`,
            title: action.label,
            icon: actionIcon(action.id),
            run: () => help.onAction(action)
          }))
        })
      }
      if (shown && shown.citations.length > 0) {
        sections.push({
          title: 'Sources',
          actions: shown.citations.map((cite) => ({
            id: `cite:${cite.url}`,
            title: cite.title,
            icon: 'book',
            run: () => openUrl(cite.url)
          }))
        })
      }
      // Starting over forgets this conversation, so it comes last, on its own.
      if (!busy) {
        sections.push({
          actions: [
            {
              id: 'new',
              title: 'New conversation',
              icon: 'add',
              run: () => {
                conversation.startNew()
                setPending(null)
                changeScope('help')
              }
            }
          ]
        })
      }
      return { title: shown?.question ?? pending?.question ?? 'Help', sections }
    }
    if (!selected) return null
    const sections: PanelSection[] = [
      {
        actions: [
          {
            id: 'primary',
            title: verbOf(selected),
            icon: iconOf(selected),
            keys: ['↵'],
            run: () => activate(selected)
          },
          ...(selected.type === 'continue'
            ? [
                {
                  id: 'open-help',
                  title: 'Open in Help',
                  icon: 'comment-discussion',
                  keys: [modKey, 'J'],
                  run: openInHelp
                }
              ]
            : [])
        ]
      }
    ]
    if (selected.type === 'item' && selected.item.actions?.length) {
      const { item } = selected
      sections.push({
        actions: item.actions!.map((action) => ({
          id: action.id,
          title: action.title,
          icon: action.icon,
          run: () => runItemAction(item, action)
        }))
      })
    }
    const title =
      selected.type === 'item'
        ? selected.item.title
        : selected.type === 'view'
          ? VIEWS[selected.view].title
          : selected.title
    return { title, sections }
  })()

  const toggleActions = (): void => {
    setActionsOpen((open) => !open && panel !== null)
  }

  // Back from the Actions panel, typing goes to the search box again.
  const actionsWereOpen = useRef(false)
  const dismissing = useRef(false)
  useEffect(() => {
    if (actionsWereOpen.current && !actionsOpen) inputRef.current?.focus()
    actionsWereOpen.current = actionsOpen
  }, [actionsOpen])

  /* ----------------------------- keys ----------------------------- */

  const typed = query.trim()

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Nothing under Search reacts to keys meant for it.
    event.stopPropagation()
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey
    const typing = event.target === inputRef.current
    const handled = (): void => event.preventDefault()

    if (mod && !event.shiftKey && event.key.toLowerCase() === 'k') {
      handled()
      toggleActions()
      return
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'j') {
      handled()
      openInHelp()
      return
    }

    // As in a launcher, typing goes to the search box from anywhere in Search: after
    // a click on the answer, say, or from one of its buttons.
    const target = event.target as HTMLElement
    if (
      event.key.length === 1 &&
      !mod &&
      !event.altKey &&
      !target.matches('input, textarea') &&
      !(event.key === ' ' && target.matches('button, a[href]'))
    ) {
      const box = actionsOpen
        ? windowRef.current?.querySelector<HTMLInputElement>('.sl-actions-input')
        : inputRef.current
      box?.focus()
      return
    }

    if (actionsOpen) {
      // The panel's own box has its keys; from anywhere else, Esc puts it away.
      if (event.key === 'Escape') {
        handled()
        setActionsOpen(false)
      }
      return
    }

    if (event.key === 'Escape') {
      handled()
      if (scope === 'help' && busy) conversation.stop()
      else if (scope !== 'all') changeScope('all')
      else if (query) {
        setQuery('')
        setSelectedKey(null)
      } else close()
      return
    }
    if (mod && /^[1-5]$/.test(event.key)) {
      handled()
      const next = VIEW_ORDER[Number(event.key) - 1]
      if (next !== 'files' || files) changeScope(scope === next ? 'all' : next)
      return
    }
    if (event.nativeEvent.isComposing) return
    // Tab asks Help, as a launcher's Tab asks its AI.
    if (
      event.key === 'Tab' &&
      typing &&
      scope !== 'help' &&
      !mod &&
      !event.shiftKey &&
      !event.altKey
    ) {
      handled()
      if (typed) ask(query)
      else changeScope('help')
      return
    }
    // Enter runs the selected result; in Help, or with Ctrl (⌘), it asks. On a button,
    // Enter is the button's own.
    if (event.key === 'Enter' && (typing || mod || event.target === event.currentTarget)) {
      handled()
      if ((mod || scope === 'help') && typed) ask(query)
      else if (selected) activate(selected)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      handled()
      if (answering) scrollAnswer(event.key === 'ArrowDown' ? 1 : -1, false)
      else move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if ((event.key === 'PageDown' || event.key === 'PageUp') && answering) {
      handled()
      scrollAnswer(event.key === 'PageDown' ? 1 : -1, true)
      return
    }
    if (event.key === 'Backspace' && typing && !query && scope !== 'all') {
      handled()
      changeScope('all')
    }
  }

  /* ----------------------------- view ----------------------------- */

  // Pick up where it was: the last query, selected so typing replaces it.
  useLayoutEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Keep the result chosen with the keyboard in sight.
  useLayoutEffect(() => {
    if (!selected || selectedBy.current !== 'keyboard') return
    const el = bodyRef.current?.querySelector<HTMLElement>(
      `[data-key="${selected.key.replace(/["\\]/g, '\\$&')}"]`
    )
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  const loading =
    (scope === 'help' && busy) ||
    (docs === null && (scope === 'docs' || (scope === 'all' && Boolean(typed)))) ||
    (scope === 'files' && hasFiles && tree === null)
  const placeholder =
    scope === 'all'
      ? 'Search for projects, actions and docs…'
      : scope === 'help'
        ? last
          ? 'Ask a follow-up…'
          : VIEWS.help.placeholder
        : scope === 'files'
          ? `Search files in ${files?.projectName ?? 'this project'}…`
          : VIEWS[scope].placeholder
  const status = answering
    ? busy
      ? 'Help is answering.'
      : last?.status === 'done'
        ? 'Help answered.'
        : ''
    : typed
      ? `${plural(entries.length, 'result')}.`
      : ''

  // What Enter does, shown in the action bar.
  const primary: { title: string; keys: string[]; run: () => void } | null = answering
    ? typed
      ? { title: 'Ask follow-up', keys: ['↵'], run: () => ask(query) }
      : { title: 'Open in Help', keys: [modKey, 'J'], run: openInHelp }
    : selected
      ? { title: verbOf(selected), keys: ['↵'], run: () => activate(selected) }
      : null

  const renderEntry = (entry: Entry): JSX.Element => {
    const isSelected = selected?.key === entry.key
    let title: ReactNode
    let subtitle: string | undefined
    let end: ReactNode = null
    switch (entry.type) {
      case 'item': {
        const { item } = entry
        const live = item.hint === 'Open now'
        title = <Highlight text={item.title} ranges={entry.ranges} />
        subtitle = item.subtitle
        end = (
          <>
            {item.hint && (
              <span className={`sl-hint${live ? ' sl-hint--live' : ''}`}>
                {live && <span className="sl-dot" />}
                {item.hint}
              </span>
            )}
            {item.keys && <Keys keys={item.keys} />}
            <span className="sl-kind">{item.kind ?? GROUP_DEFAULTS[item.group].kind}</span>
          </>
        )
        break
      }
      case 'view': {
        title = VIEWS[entry.view].title
        subtitle = entry.view === 'files' ? files?.projectName : undefined
        end =
          entry.count !== undefined ? (
            <span className="sl-kind">{plural(entry.count, 'result')}</span>
          ) : (
            <Keys keys={[modKey, String(VIEW_ORDER.indexOf(entry.view) + 1)]} />
          )
        break
      }
      case 'ask':
        title = entry.title
        subtitle = entry.subtitle
        end = entry.main ? <Keys keys={['Tab']} /> : null
        break
      case 'continue':
        title = entry.title
        subtitle = entry.subtitle
        break
    }
    return (
      <div
        key={entry.key}
        id={optionId(entry.key)}
        role="option"
        aria-selected={isSelected}
        data-key={entry.key}
        className={`sl-row${isSelected ? ' is-selected' : ''}`}
        onPointerMove={() => {
          // The Actions panel stays with the result it was opened for.
          if (!isSelected && !actionsOpen) select(entry.key, 'pointer')
        }}
        onClick={() => activate(entry)}
      >
        <Icon icon={iconOf(entry)} />
        <span className="sl-row-text">
          <span className="sl-row-title">{title}</span>
          {subtitle && <span className="sl-row-sub">{subtitle}</span>}
        </span>
        {end && <span className="sl-row-end">{end}</span>}
      </div>
    )
  }

  const empty = (): JSX.Element => {
    if (scope === 'files' && !tree) return <p className="sl-empty-title">Listing the files…</p>
    if (scope === 'docs' && !docs) return <p className="sl-empty-title">Loading the docs…</p>
    const noun = scope === 'all' || scope === 'help' ? null : GROUP_NOUNS[scope]
    if (!typed || !noun) {
      return <p className="sl-empty-title">{noun ? `No ${noun} yet` : 'Nothing here yet'}</p>
    }
    return (
      <>
        <Codicon name="search" />
        <p className="sl-empty-title">
          No {noun} match “{typed}”
        </p>
        <p className="sl-empty-sub">
          Press <Keys keys={['Tab']} /> to ask Help instead
        </p>
      </>
    )
  }

  return (
    <div className="spotlight">
      <div className="sl-scrim" onPointerDown={close} />
      <div
        ref={windowRef}
        className="sl-window"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        // A click that finds nothing to focus focuses Search, not the page, so its
        // keys keep working.
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => {
          // As in a launcher, a click leaves your typing in its box. Only the answer
          // takes the click, so its text can be selected.
          const target = event.target as Element
          if (!target.closest('input, textarea, .sl-answer')) event.preventDefault()
        }}
        onPointerDownCapture={(event) => {
          // A click anywhere else puts the Actions panel away, and does only that.
          const target = event.target as Element
          dismissing.current = actionsOpen && !target.closest('.sl-actions, [data-actions-toggle]')
          if (dismissing.current) setActionsOpen(false)
        }}
        onClickCapture={(event) => {
          if (!dismissing.current) return
          dismissing.current = false
          event.stopPropagation()
          inputRef.current?.focus()
        }}
      >
        <div className="sl-bar">
          {scope !== 'all' && (
            <button
              type="button"
              className="sl-back"
              aria-label="Back"
              title="Back (Esc)"
              onClick={() => changeScope('all')}
            >
              <Codicon name="arrow-left" />
            </button>
          )}
          <input
            ref={inputRef}
            className="sl-input"
            type="text"
            role="combobox"
            aria-label={scope === 'help' ? 'Ask Help' : 'Search'}
            aria-expanded={!answering && entries.length > 0}
            aria-controls={answering ? undefined : listId}
            aria-autocomplete="list"
            aria-activedescendant={!answering && selected ? optionId(selected.key) : undefined}
            placeholder={placeholder}
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedKey(null)
              selectedBy.current = 'keyboard'
            }}
          />
          {scope === 'all' && (
            <button
              type="button"
              className="sl-askhint"
              tabIndex={-1}
              onClick={() => (typed ? ask(query) : changeScope('help'))}
            >
              <span className="sl-askhint-label">Ask Help</span>
              <Keys keys={['Tab']} />
            </button>
          )}
          {loading && <div className="sl-progress" aria-hidden="true" />}
        </div>

        <div className="sl-main">
          {answering ? (
            <SpotlightAnswer
              exchange={shown}
              pendingQuestion={waiting ? pending?.question : undefined}
              onAction={help.onAction}
              onReportIssue={help.onReportIssue}
            />
          ) : (
            <div className="sl-list" ref={bodyRef} id={listId} role="listbox" aria-label="Results">
              {sections.map((section) => (
                <div
                  key={section.key}
                  className="sl-section"
                  role="group"
                  aria-label={section.label ?? 'Ask Help'}
                >
                  {section.label && (
                    <div className="sl-label" aria-hidden="true">
                      <span className="sl-label-text">{section.label}</span>
                      {section.count !== undefined && (
                        <span className="sl-label-count">{section.count}</span>
                      )}
                    </div>
                  )}
                  {section.entries.map(renderEntry)}
                </div>
              ))}
              {sections.length === 0 && <div className="sl-empty">{empty()}</div>}
            </div>
          )}
        </div>

        {actionsOpen && panel && (
          <ActionPanel
            title={panel.title}
            sections={panel.sections}
            onClose={() => setActionsOpen(false)}
          />
        )}

        <footer className="sl-foot">
          <div className="sl-nav">
            {notice ? (
              <span className="sl-notice" role="status">
                <Codicon name="check" />
                {notice}
              </span>
            ) : scope === 'all' ? (
              <FabricatorMark className="sl-nav-mark" />
            ) : (
              <>
                <Icon icon={VIEWS[scope].icon} small />
                <span className="sl-nav-title">
                  {scope === 'files' && files
                    ? `Files in ${files.projectName}`
                    : VIEWS[scope].title}
                </span>
                {scope === 'help' && busy && <span className="sl-nav-status">Answering…</span>}
              </>
            )}
          </div>
          {primary && (
            <>
              <button type="button" className="sl-act sl-act--primary" onClick={primary.run}>
                {primary.title}
                <Keys keys={primary.keys} />
              </button>
              <span className="sl-act-sep" aria-hidden="true" />
            </>
          )}
          <button
            type="button"
            className={`sl-act${actionsOpen ? ' is-open' : ''}`}
            data-actions-toggle=""
            aria-haspopup="dialog"
            aria-expanded={actionsOpen}
            disabled={!panel}
            onClick={toggleActions}
          >
            Actions
            <Keys keys={[modKey, 'K']} />
          </button>
        </footer>

        <p className="sr-only" aria-live="polite">
          {status}
        </p>
      </div>
    </div>
  )
}
