// The Help conversation, kept outside any one view.
//
// Help is asked from two places: the full-screen Help and Search, which answers
// inline. Both read and extend this one thread, so a question asked in Search
// carries on in Help (even mid-answer), and closing either never loses an answer
// that is still arriving.
//
// The thread outlives the overlay and the process (see ./history): it is restored
// from disk once, and saved again each time a turn settles.
import type {
  ChatToolCall,
  HelpAction,
  HelpAnswer,
  HelpCitation,
  HelpEvent,
  HelpGrounding,
  HelpIssueDraft,
  HelpTurn
} from '@shared/ipc'
import { HELP_STOPPED } from '@shared/ipc'
import { errorMessage, reportError, reportThrown } from '../../errorReport'
import { fromSaved, toSaved } from './history'

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
  /** True for a turn from earlier, picked up again, rather than asked just now. */
  restored?: boolean
}

/** Where a question is asked from: what Help is told about the user's situation. */
export interface HelpAskContext {
  /** The project the user is working in, attached for context. */
  projectId?: string
  /** What is true right now: accounts, tool readiness, the open project. */
  facts?: string[]
  /** Which screen the user is on, which decides the actions Help may offer. */
  surface?: 'setup' | 'home' | 'project'
}

export interface HelpConversationState {
  exchanges: Exchange[]
  /** A question is being answered. */
  busy: boolean
  /** The saved conversation is back, or there was none. */
  historyReady: boolean
  /** When the earlier part of the thread was last touched, once it was picked up again. */
  resumedAt: string | null
  /** What Help has cached to reason from. */
  grounding: HelpGrounding | null
  /** The docs and source are being downloaded. */
  preparing: boolean
}

export interface HelpConversation {
  getState(): HelpConversationState
  subscribe(listener: () => void): () => void
  /** Restore the saved conversation. Runs once; later calls wait on the first. */
  load(): Promise<void>
  /**
   * The thread is being picked up again in the full-screen view: what has
   * settled reads as earlier. A thread left alone for a day starts fresh, as
   * one saved on disk would.
   */
  resume(): void
  /** Ask one question, after anything restored and in place of any answer still arriving. */
  ask(question: string, attachments: string[], context: HelpAskContext): Promise<void>
  /** Stop the answer that is arriving. */
  stop(): void
  /** Forget the conversation, on disk too. */
  startNew(): void
  /** Check what Help has to reason from, and download what is missing. */
  checkGrounding(): Promise<void>
  /** Download the docs and source again. Rejects when that fails. */
  refreshGrounding(): Promise<void>
  /** Drop the event subscription and timers. The conversation itself stays. */
  dispose(): void
}

/** Settling is followed by a save; a burst of settles writes once. */
const SAVE_DELAY_MS = 400
/** A thread untouched for this long is not picked up. Matches MAX_AGE_HOURS in services/help_session.rs. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

/** True once an exchange has reached a terminal state. */
export function settled(exchange: Exchange): boolean {
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

function newId(): string {
  return `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function createHelpConversation(): HelpConversation {
  let state: HelpConversationState = {
    exchanges: [],
    busy: false,
    historyReady: false,
    resumedAt: null,
    grounding: null,
    preparing: false
  }
  const listeners = new Set<() => void>()
  let loading: Promise<void> | null = null
  let checking: Promise<void> | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  /** The answer that is arriving, if any. */
  let inflight: Promise<void> | null = null
  /**
   * The question events are routed to. Deliberately *not* cleared when a turn
   * finishes: Tauri delivers events asynchronously, so the terminal `done` can
   * land after the command's promise resolves, and clearing early would drop
   * it. A new question replaces the id instead.
   */
  let liveId: string | null = null
  /** When the thread last changed: a turn settled, or it was restored. */
  let touchedAt: string | null = null

  function set(patch: Partial<HelpConversationState>): void {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  function patchExchange(id: string, change: (prev: Exchange) => Exchange): void {
    if (!state.exchanges.some((e) => e.id === id)) return
    set({ exchanges: state.exchanges.map((e) => (e.id === id ? change(e) : e)) })
    // An event can land after its turn settled; the save then includes it.
    if (!state.busy) scheduleSave()
  }

  function save(): void {
    const saved = toSaved(state.exchanges)
    if (saved.length === 0) return
    void window.api.help.saveHistory(saved).catch(() => {
      // Losing the thread is a small harm; interrupting the user is a bigger one.
    })
  }

  /** Save once the thread is still. Writing while a turn streams would be a write per token. */
  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    if (state.busy || state.exchanges.length === 0) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      save()
    }, SAVE_DELAY_MS)
  }

  function onEvent(askId: string, event: HelpEvent): void {
    if (askId !== liveId) return
    switch (event.type) {
      case 'delta':
        // A finished exchange ignores stragglers: the resolved answer is
        // authoritative, and a late delta must not reopen it.
        patchExchange(askId, (prev) =>
          settled(prev) ? prev : { ...prev, answer: prev.answer + event.text, status: 'streaming' }
        )
        break
      case 'activity':
        patchExchange(askId, (prev) => {
          const tools = [...prev.tools]
          const at = tools.findIndex((t) => t.id === event.tool.id)
          if (at >= 0) tools[at] = event.tool
          else tools.push(event.tool)
          return { ...prev, tools }
        })
        break
      case 'action':
        patchExchange(askId, (prev) =>
          prev.actions.some((a) => a.id === event.action.id && a.url === event.action.url)
            ? prev
            : { ...prev, actions: [...prev.actions, event.action] }
        )
        break
      case 'citation':
        patchExchange(askId, (prev) =>
          prev.citations.some((c) => c.url === event.citation.url)
            ? prev
            : { ...prev, citations: [...prev.citations, event.citation] }
        )
        break
      case 'issue':
        patchExchange(askId, (prev) => (prev.issue ? prev : { ...prev, issue: event.issue }))
        break
      case 'done':
        patchExchange(askId, (prev) => applyAnswer(prev, event.answer))
        break
      case 'error':
        patchExchange(askId, (prev) =>
          settled(prev) ? prev : { ...prev, status: 'error', error: event.message }
        )
        break
    }
  }

  function subscribeToEvents(): void {
    unsubscribe ??= window.api.help.onEvent(({ askId, event }) => onEvent(askId, event))
  }

  const conversation: HelpConversation = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    load() {
      loading ??= (async () => {
        try {
          const saved = await window.api.help.loadHistory()
          if (!saved) return
          const restored = fromSaved(saved.data)
          if (restored.length === 0) return
          touchedAt = saved.savedAt
          set({ exchanges: [...restored, ...state.exchanges], resumedAt: saved.savedAt })
        } catch (reason) {
          // A conversation we can't read is not worth failing over.
          reportThrown(reason, { operation: 'help_history_load', area: 'app' })
        } finally {
          set({ historyReady: true })
        }
      })()
      return loading
    },

    resume() {
      if (!state.historyReady) return
      const last = touchedAt ? Date.parse(touchedAt) : NaN
      if (!state.busy && state.exchanges.length > 0 && Date.now() - last > MAX_AGE_MS) {
        set({ exchanges: [], resumedAt: null })
        return
      }
      // An answer still arriving stays where it is: it's now, not earlier.
      if (!state.exchanges.some((e) => settled(e) && !e.restored)) return
      set({
        exchanges: state.exchanges.map((e) => (settled(e) ? { ...e, restored: true } : e)),
        resumedAt: touchedAt
      })
    },

    async ask(question, attachments, context) {
      const text = question.trim()
      if (!text) return
      // Restored turns come first, so they're in the history replayed with it.
      await conversation.load()
      if (inflight) {
        conversation.stop()
        await inflight
      }
      subscribeToEvents()

      const id = newId()
      liveId = id
      const history: HelpTurn[] = state.exchanges
        .filter((e) => e.status === 'done' && e.answer.trim())
        .map((e) => ({ question: e.question, answer: e.answer }))
      // The thread as it stood is worth keeping, should this answer never finish.
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
        save()
      }
      set({
        busy: true,
        exchanges: [
          ...state.exchanges,
          {
            id,
            question: text,
            attachments,
            answer: '',
            tools: [],
            actions: [],
            citations: [],
            status: 'thinking'
          }
        ]
      })

      const run = (async () => {
        try {
          const answer = await window.api.help.ask({
            askId: id,
            question: text,
            projectId: context.projectId,
            attachments,
            facts: context.facts,
            surface: context.surface,
            history
          })
          patchExchange(id, (prev) => applyAnswer(prev, answer))
        } catch (reason) {
          const message = errorMessage(reason, 'Help could not answer.')
          if (message === HELP_STOPPED) {
            // The user's own doing, not a failure: don't record it, or it crowds
            // real errors out of the window the next question is primed with.
            patchExchange(id, (prev) => ({ ...prev, status: 'stopped' }))
          } else {
            reportError({ message, operation: 'help_ask', area: 'app', surface: 'inline' })
            patchExchange(id, (prev) => ({ ...prev, status: 'error', error: message }))
          }
        } finally {
          touchedAt = new Date().toISOString()
          if (liveId === id) set({ busy: false })
          scheduleSave()
        }
      })()
      inflight = run
      await run
      if (inflight === run) inflight = null
    },

    stop() {
      void window.api.help.cancel()
    },

    startNew() {
      if (state.busy) conversation.stop()
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = null
      touchedAt = null
      set({ exchanges: [], resumedAt: null })
      void window.api.help.clearHistory().catch(() => {})
    },

    checkGrounding() {
      checking ??= (async () => {
        try {
          const current = await window.api.help.grounding()
          set({ grounding: current })
          // Fetch in the background on first use, and again after an update
          // brings a version whose release notes aren't mirrored yet; Help
          // still answers from the logs while this is in flight.
          if (!current.sourceReady || !current.docsReady || !current.notesReady) {
            set({ preparing: true })
            set({ grounding: await window.api.help.prepare(false) })
          }
        } catch (reason) {
          reportThrown(reason, { operation: 'help_prepare', area: 'app' })
        } finally {
          checking = null
          if (state.preparing) set({ preparing: false })
        }
      })()
      return checking
    },

    async refreshGrounding() {
      set({ preparing: true })
      try {
        set({ grounding: await window.api.help.prepare(true) })
      } finally {
        set({ preparing: false })
      }
    },

    dispose() {
      unsubscribe?.()
      unsubscribe = null
      // A settle moments ago is still worth keeping.
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
        save()
      }
    }
  }
  return conversation
}
