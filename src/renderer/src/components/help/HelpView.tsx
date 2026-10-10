import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatToolCall,
  HelpAction,
  HelpAnswer,
  HelpCitation,
  HelpGrounding,
  HelpIssueDraft,
  HelpTurn
} from '@shared/ipc'
import { HELP_STOPPED } from '@shared/ipc'
import Markdown from '../Markdown'
import { Codicon } from '../icons'
import { FabricatorMark } from '../FabricatorMark'
import { useSuppressPreview } from '../../overlay'
import { useToast } from '../../toast'
import { openDocs } from '../../docsLinks'
import { errorMessage, reportError, reportThrown } from '../../errorReport'
import { HelpComposer } from './HelpComposer'
import { HelpWorkLog } from './HelpWorkLog'
import { HelpRayAvatar, HelpRayThinking, TypedLine } from './HelpRay'
import { PROMPTS, Spinner } from './parts'
import { describeWhen, fromSaved, toSaved } from './history'
import { useMascot } from '../mascot/context'
import { helpGreeting } from '../mascot/lines'
import './help.css'

/** One exchange in the transcript. */
export interface Exchange {
  id: string
  question: string
  attachments: string[]
  /** Answer text so far; grows as deltas arrive. */
  answer: string
  tools: ChatToolCall[]
  actions: HelpAction[]
  citations: HelpCitation[]
  issue?: HelpIssueDraft
  status: 'thinking' | 'streaming' | 'done' | 'error' | 'stopped'
  error?: string
  elapsedMs?: number
  /** True for a turn restored from an earlier session, not asked just now. */
  restored?: boolean
}

export interface HelpViewProps {
  onClose: () => void
  /** The project the user is working in, attached automatically for context. */
  projectId?: string
  projectName?: string
  /** Runs one of the assistant's offered actions. */
  onAction: (action: HelpAction) => void
  /** Opens a prefilled GitHub bug report from the assistant's draft. */
  onReportIssue: (issue: HelpIssueDraft) => void
  /**
   * What is true right now — accounts, tool readiness, the open project. The
   * journal records what happened over time; these say where things stand, so
   * the assistant can tell a problem the user already fixed from a live one.
   */
  facts?: string[]
  /**
   * Which screen Help was opened from. Sent so the assistant never offers a
   * button that can't do anything from there — "Open my projects" while the
   * project list is already on screen, or any of them during setup.
   */
  surface?: 'setup' | 'home' | 'project'
  appVersion?: string
}

function newId(): string {
  return `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The Help assistant: a full-screen, terminal-style overlay that debugs the
 * user's problem from the activity journal, the docs and Fabricator's own source.
 *
 * Deliberately spare — one column, one prompt, monospace chrome — so it reads as
 * a tool rather than a second chat. Motion is limited to the caret, the working
 * spinner and a short entrance; everything else is flat per the app's design.
 */
export function HelpView({
  onClose,
  projectId,
  projectName,
  onAction,
  onReportIssue,
  facts,
  surface,
  appVersion
}: HelpViewProps): JSX.Element {
  const toast = useToast()
  useSuppressPreview()

  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [grounding, setGrounding] = useState<HelpGrounding | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [busy, setBusy] = useState(false)
  /** When the restored part of the conversation was last saved, if any. */
  const [resumedAt, setResumedAt] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** Latest `stop`, so history effects can use it before it is declared. */
  const stopRef = useRef<() => void>(() => {})
  /**
   * The question events are currently routed to. Deliberately *not* cleared when
   * a turn finishes: Tauri delivers events asynchronously, so the terminal
   * `done` can land after the command's promise resolves, and clearing early
   * would drop it. A new question replaces the id instead.
   */
  const liveId = useRef<string | null>(null)
  /** Pinned to the bottom unless the user scrolled up to read. */
  const stick = useRef(true)

  /* ----------------------------- history ----------------------------- */

  // Restore the conversation on open. Help is where you come back to after
  // trying a fix — including after restarting the app, which is itself a fix —
  // so the thread outlives both the overlay and the process.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const saved = await window.api.help.loadHistory()
        if (cancelled || !saved) return
        const restored = fromSaved(saved.data)
        if (restored.length === 0) return
        setExchanges(restored)
        setResumedAt(saved.savedAt)
      } catch (reason) {
        // A conversation we can't read is not worth failing over.
        reportThrown(reason, { operation: 'help_history_load', area: 'app' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Persist after every settled change. Writing while a turn streams would be
  // a file write per token, so saving waits for the turn to finish.
  useEffect(() => {
    if (busy) return
    if (exchanges.length === 0) return
    const saved = toSaved(exchanges)
    if (saved.length === 0) return
    const timer = setTimeout(() => {
      void window.api.help.saveHistory(saved).catch(() => {
        // Losing the thread is a small harm; interrupting the user is a bigger one.
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [exchanges, busy])

  /** Drop the conversation and start over. */
  const startNew = useCallback((): void => {
    if (busy) stopRef.current()
    setExchanges([])
    setResumedAt(null)
    void window.api.help.clearHistory().catch(() => {})
  }, [busy])

  /* ----------------------------- grounding ----------------------------- */

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const current = await window.api.help.grounding()
        if (cancelled) return
        setGrounding(current)
        // Fetch in the background on first open; the assistant still answers
        // from the logs while this is in flight.
        if (!current.sourceReady || !current.docsReady) {
          setPreparing(true)
          const ready = await window.api.help.prepare(false)
          if (!cancelled) setGrounding(ready)
        }
      } catch (reason) {
        if (!cancelled) reportThrown(reason, { operation: 'help_prepare', area: 'app' })
      } finally {
        if (!cancelled) setPreparing(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshGrounding = useCallback(async (): Promise<void> => {
    setPreparing(true)
    try {
      setGrounding(await window.api.help.prepare(true))
      toast.success('Help refreshed its copy of the docs and source.')
    } catch (reason) {
      toast.error(reportThrown(reason, { operation: 'help_prepare', area: 'app' }), {
        title: "Couldn't refresh",
        record: false
      })
    } finally {
      setPreparing(false)
    }
  }, [toast])

  /* ----------------------------- streaming ----------------------------- */

  const patch = useCallback((id: string, change: (prev: Exchange) => Exchange): void => {
    setExchanges((list) => list.map((item) => (item.id === id ? change(item) : item)))
  }, [])

  useEffect(() => {
    return window.api.help.onEvent(({ askId, event }) => {
      if (askId !== liveId.current) return
      switch (event.type) {
        case 'delta':
          patch(askId, (prev) =>
            // A finished exchange ignores stragglers: the resolved answer is
            // authoritative, and a late delta must not reopen it.
            settled(prev)
              ? prev
              : { ...prev, answer: prev.answer + event.text, status: 'streaming' }
          )
          break
        case 'activity':
          patch(askId, (prev) => {
            const tools = [...prev.tools]
            const at = tools.findIndex((t) => t.id === event.tool.id)
            if (at >= 0) tools[at] = event.tool
            else tools.push(event.tool)
            return { ...prev, tools }
          })
          break
        case 'action':
          patch(askId, (prev) =>
            prev.actions.some((a) => a.id === event.action.id && a.url === event.action.url)
              ? prev
              : { ...prev, actions: [...prev.actions, event.action] }
          )
          break
        case 'citation':
          patch(askId, (prev) =>
            prev.citations.some((c) => c.url === event.citation.url)
              ? prev
              : { ...prev, citations: [...prev.citations, event.citation] }
          )
          break
        case 'issue':
          patch(askId, (prev) => (prev.issue ? prev : { ...prev, issue: event.issue }))
          break
        case 'done':
          patch(askId, (prev) => applyAnswer(prev, event.answer))
          break
        case 'error':
          patch(askId, (prev) =>
            settled(prev) ? prev : { ...prev, status: 'error', error: event.message }
          )
          break
      }
    })
  }, [patch])

  /* ----------------------------- asking ----------------------------- */

  const history = useMemo<HelpTurn[]>(
    () =>
      exchanges
        .filter((e) => e.status === 'done' && e.answer.trim())
        .map((e) => ({ question: e.question, answer: e.answer })),
    [exchanges]
  )

  const ask = useCallback(
    async (question: string, attachments: string[]): Promise<void> => {
      const id = newId()
      liveId.current = id
      stick.current = true
      setBusy(true)
      setExchanges((list) => [
        ...list,
        {
          id,
          question,
          attachments,
          answer: '',
          tools: [],
          actions: [],
          citations: [],
          status: 'thinking'
        }
      ])

      try {
        const answer = await window.api.help.ask({
          askId: id,
          question,
          projectId,
          attachments,
          facts,
          surface,
          history
        })
        patch(id, (prev) => applyAnswer(prev, answer))
      } catch (reason) {
        const message = errorMessage(reason, 'Help could not answer.')
        if (message === HELP_STOPPED) {
          // The user's own doing, not a failure: don't record it, or it crowds
          // real errors out of the window the next question is primed with.
          patch(id, (prev) => ({ ...prev, status: 'stopped' }))
        } else {
          reportError({ message, operation: 'help_ask', area: 'app', surface: 'inline' })
          patch(id, (prev) => ({ ...prev, status: 'error', error: message }))
        }
      } finally {
        setBusy(false)
      }
    },
    [facts, history, patch, projectId, surface]
  )

  const stop = useCallback((): void => {
    void window.api.help.cancel()
  }, [])
  stopRef.current = stop

  /* ----------------------------- chrome ----------------------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Another dialog on top owns Escape first.
      if (document.querySelector('.modal-backdrop')) return
      if (busy) stop()
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose, stop])

  // Follow the stream, but yield to a user who has scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [exchanges])

  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  const empty = exchanges.length === 0

  return (
    <div className="help" role="dialog" aria-modal="true" aria-label="Help">
      <header className="help-bar">
        <span className="help-bar-id">
          <Codicon name="terminal" />
          fabricator&nbsp;help
        </span>
        <GroundingBadge grounding={grounding} preparing={preparing} onRefresh={refreshGrounding} />
        <span className="help-bar-spacer" />
        {projectName && (
          <span className="help-bar-ctx" title={`Questions are answered about ${projectName}`}>
            <Codicon name="folder" />
            {projectName}
          </span>
        )}
        {!empty && (
          <button
            className="help-bar-new"
            onClick={startNew}
            title="Start a new conversation and forget this one"
          >
            <Codicon name="add" />
            New
          </button>
        )}
        {/* The escape hatch for someone who wants to read rather than ask.
            Kept in the bar, not just the welcome screen, so it stays reachable
            mid-conversation. */}
        <button
          className="help-bar-new"
          onClick={() => openDocs('home')}
          title="Open the Fabricator documentation in your browser"
        >
          <Codicon name="book" />
          Docs
        </button>
        <button className="help-bar-close" onClick={onClose} title="Close Help (Esc)">
          <Codicon name="close" />
        </button>
      </header>

      <div className="help-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="help-col">
          {empty ? (
            <Welcome appVersion={appVersion} onPick={(text) => void ask(text, [])} />
          ) : (
            exchanges.map((item, i) => (
              <Fragment key={item.id}>
                {/* The point where an older conversation was picked up. */}
                {resumedAt && item.restored && i === 0 && (
                  <p className="help-resumed">
                    <Codicon name="history" />
                    Picking up where you left off, {describeWhen(resumedAt)}
                  </p>
                )}
                {resumedAt && !item.restored && exchanges[i - 1]?.restored && (
                  <p className="help-resumed help-resumed--now">
                    <Codicon name="arrow-down" />
                    Now
                  </p>
                )}
                <ExchangeView
                  exchange={item}
                  onAction={onAction}
                  onReportIssue={onReportIssue}
                />
              </Fragment>
            ))
          )}
        </div>
      </div>

      <HelpComposer busy={busy} onAsk={ask} onStop={stop} />
    </div>
  )
}

/** True once an exchange has reached a terminal state. */
function settled(exchange: Exchange): boolean {
  return exchange.status === 'done' || exchange.status === 'error' || exchange.status === 'stopped'
}

/** Fold a finished answer into its exchange. */
function applyAnswer(prev: Exchange, answer: HelpAnswer): Exchange {
  return {
    ...prev,
    // The streamed text is authoritative when it already matches; the final
    // answer fills in anything the stream missed.
    answer: answer.text || prev.answer,
    actions: answer.actions.length ? answer.actions : prev.actions,
    citations: answer.citations.length ? answer.citations : prev.citations,
    issue: answer.issue ?? prev.issue,
    elapsedMs: answer.elapsedMs,
    status: 'done'
  }
}

/* ----------------------------- pieces ----------------------------- */

function GroundingBadge({
  grounding,
  preparing,
  onRefresh
}: {
  grounding: HelpGrounding | null
  preparing: boolean
  onRefresh: () => Promise<void>
}): JSX.Element | null {
  if (preparing) {
    return (
      <span className="help-ground help-ground--busy">
        <Spinner />
        reading docs
      </span>
    )
  }
  if (!grounding) return null

  const both = grounding.sourceReady && grounding.docsReady
  const label = both
    ? grounding.pinned && grounding.reference
      ? grounding.reference
      : 'ready'
    : grounding.docsReady
      ? 'docs only'
      : 'logs only'
  const title = both
    ? grounding.pinned
      ? `Help is reading the documentation and the source for ${grounding.reference}, which matches this build.`
      : 'Help is reading the documentation and the latest source.'
    : grounding.docsReady
      ? "Help has the documentation but not the source, so it can't trace an error to its cause."
      : 'Help is working from this machine\u2019s logs only. Select to download the documentation.'

  return (
    <button
      className={`help-ground ${both ? 'help-ground--ok' : 'help-ground--partial'}`}
      title={title}
      onClick={() => void onRefresh()}
    >
      <span className="help-dot" aria-hidden="true" />
      {label}
    </button>
  )
}

/**
 * The empty state. Its host — Ray, or the Fabricator mark when he's turned
 * off — sits on the left; the greeting, the starter questions and the version
 * all share one text edge on the right.
 */
function Welcome({
  appVersion,
  onPick
}: {
  appVersion?: string
  onPick: (text: string) => void
}): JSX.Element {
  const mascot = useMascot()
  const greeting = useMemo(() => helpGreeting(), [])
  return (
    <div className={`help-welcome${mascot ? ' help-welcome--ray' : ''}`}>
      <div className="help-hello-host">
        {mascot ? <HelpRayAvatar /> : <FabricatorMark className="brand-mark" />}
      </div>
      <div className="help-hello-text">
        <h2 className="help-hello-title">
          {mascot ? <TypedLine text={greeting} /> : 'fabricator help'}
        </h2>
        <p className="help-hello-lead">
          Ask about anything that isn&apos;t working. I can read what this machine has been
          doing, the documentation, and your project.
        </p>
        <ul className="help-prompts">
          {PROMPTS.map((text, i) => (
            <li key={text} style={{ animationDelay: `${90 + i * 55}ms` }}>
              <button onClick={() => onPick(text)}>
                <Codicon name="chevron-right" />
                {text}
              </button>
            </li>
          ))}
        </ul>
        <p className="help-hello-meta">v{appVersion ?? '\u2014'} · read-only</p>
      </div>
    </div>
  )
}

function ExchangeView({
  exchange,
  onAction,
  onReportIssue
}: {
  exchange: Exchange
  onAction: (action: HelpAction) => void
  onReportIssue: (issue: HelpIssueDraft) => void
}): JSX.Element {
  const { status } = exchange
  const working = status === 'thinking' || status === 'streaming'
  const mascot = useMascot()

  return (
    <article className="help-x">
      <div className="help-q">
        <span className="help-q-caret" aria-hidden="true">
          &gt;
        </span>
        <div className="help-q-body">
          <p>{exchange.question}</p>
          {exchange.attachments.length > 0 && (
            <ul className="help-q-files">
              {exchange.attachments.map((path) => (
                <li key={path} title={path}>
                  <Codicon name="file" />
                  {path.split(/[\\/]/).pop()}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {exchange.tools.length > 0 && <HelpWorkLog tools={exchange.tools} working={working} />}

      {status === 'thinking' &&
        !exchange.answer &&
        (mascot ? (
          <HelpRayThinking />
        ) : (
          <p className="help-thinking">
            <Spinner />
            <span>looking through your logs</span>
          </p>
        ))}

      {exchange.answer && (
        <div className={`help-a ${status === 'streaming' ? 'is-streaming' : ''}`}>
          <Markdown>{exchange.answer}</Markdown>
        </div>
      )}

      {exchange.actions.length > 0 && status !== 'thinking' && (
        <div className="help-actions">
          {exchange.actions.map((action, i) => (
            <button
              key={`${action.id}:${action.url ?? action.target ?? ''}`}
              // One suggested step per answer, so the recommended move is
              // unambiguous; the rest are offered as alternatives.
              className={`help-action ${i === 0 ? 'is-primary' : ''}`}
              onClick={() => onAction(action)}
            >
              <Codicon name={actionIcon(action.id)} className="help-action-icon" />
              <span className="help-action-label">{action.label}</span>
              <Codicon name="arrow-right" className="help-action-go" />
            </button>
          ))}
        </div>
      )}

      {exchange.issue && status !== 'thinking' && (
        <IssueDraftCard issue={exchange.issue} onReport={() => onReportIssue(exchange.issue!)} />
      )}

      {exchange.citations.length > 0 && (
        <ul className="help-cites">
          {exchange.citations.map((cite) => (
            <li key={cite.url}>
              <button onClick={() => void window.api.openExternal(cite.url)}>
                <Codicon name="book" />
                {cite.title}
              </button>
            </li>
          ))}
        </ul>
      )}

      {status === 'error' && (
        <p className="help-err">
          <Codicon name="error" />
          {exchange.error}
        </p>
      )}
      {status === 'stopped' && <p className="help-stopped">Stopped.</p>}
      {status === 'done' && exchange.elapsedMs !== undefined && (
        <p className="help-meta">{formatElapsed(exchange.elapsedMs)}</p>
      )}
    </article>
  )
}

/** The glyph for each offered action, so a button reads before it is read. */
function actionIcon(id: HelpAction['id']): string {
  switch (id) {
    case 'open-docs':
      return 'book'
    case 'open-project':
      return 'rocket'
    case 'open-home':
      return 'list-unordered'
    case 'share-app':
      return 'link'
    case 'open-team-access':
      return 'organization'
    case 'open-advisor':
      return 'shield'
    case 'open-code':
      return 'code'
    case 'run-doctor':
      return 'checklist'
    case 'refresh-fabric-auth':
    case 'sign-in-copilot':
      return 'key'
    case 'export-diagnostics':
      return 'save'
    case 'open-logs':
      return 'folder-opened'
    case 'report-issue':
      return 'bug'
    case 'open-settings':
      return 'settings-gear'
    case 'open-accounts':
      return 'account'
    default:
      return 'arrow-right'
  }
}

/**
 * A bug report the assistant wrote. Shown collapsed with the title visible, so
 * the user can see it exists without the answer turning into a wall of text,
 * and can read the whole thing before anything is sent anywhere.
 */
function IssueDraftCard({
  issue,
  onReport
}: {
  issue: HelpIssueDraft
  onReport: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const feature = issue.kind === 'feature'
  return (
    <div className={`help-issue ${open ? 'is-open' : ''}`}>
      <div className="help-issue-head">
        <Codicon
          name={feature ? 'lightbulb' : 'bug'}
          className={`help-issue-icon ${feature ? 'is-feature' : ''}`}
        />
        <div className="help-issue-id">
          <span className="help-issue-kind">
            {feature ? 'Feature request ready' : 'Bug report ready'}
          </span>
          <span className="help-issue-title">{issue.title}</span>
        </div>
      </div>
      {open && (
        <div className="help-issue-body">
          <Markdown>{issue.body}</Markdown>
          <p className="help-issue-note">
            {feature
              ? 'Review it on GitHub before you submit.'
              : 'Your Fabricator version, system details and a diagnostics file are added when you report it. Review everything on GitHub before you submit.'}
          </p>
        </div>
      )}
      <div className="help-issue-actions">
        <button className="help-action is-primary" onClick={onReport}>
          <Codicon name="github" className="help-action-icon" />
          <span className="help-action-label">
            {feature ? 'Suggest this on GitHub' : 'Report this on GitHub'}
          </span>
          <Codicon name="link-external" className="help-action-go" />
        </button>
        <button className="help-issue-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Review it first'}
        </button>
      </div>
    </div>
  )
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}
