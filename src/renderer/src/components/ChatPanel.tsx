import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  MAIN_THREAD_ID,
  type ChatEvent,
  type ChatMessage,
  type ChatToolCall,
  type ChatTurnResult,
  type ReasoningEffort,
  type StudioProject
} from '@shared/ipc'
import type { PendingShot } from './PreviewPane'
import Markdown from './Markdown'
import logo from '../assets/logo.png'

export interface UIChatMessage extends ChatMessage {
  /** Correlates streamed events to the active assistant bubble (live only). */
  turnId?: string
  /** True while the assistant turn is still streaming. */
  pending: boolean
  /** Transient status note (e.g. a transient-failure retry); not persisted. */
  notice?: string
}

/**
 * A prompt queued from outside the chat (e.g. the status-bar "Update with
 * Copilot" hand-off). When a new `id` arrives the panel sends it as a turn —
 * `display` is the user-bubble text, `prompt` is what Copilot actually receives.
 */
export interface OutboundPrompt {
  id: string
  display: string
  prompt: string
}

interface Props {
  project: StudioProject
  /** Which thread this panel drives (main thread when omitted). */
  threadId?: string
  messages: UIChatMessage[]
  onChange: (updater: (prev: UIChatMessage[]) => UIChatMessage[]) => void
  /** Called after a turn completes (used later to trigger deploy/preview refresh). */
  onTurnComplete?: (result: ChatTurnResult) => void
  /** Called when this thread starts/stops a turn (drives status dots + merge defer). */
  onBusyChange?: (busy: boolean) => void
  /** Region screenshots staged for the next message. */
  attachments?: PendingShot[]
  /** Remove a staged screenshot (also deletes its temp file). */
  onRemoveAttachment?: (path: string) => void
  /** Called once staged screenshots have been sent so the parent can clear them. */
  onAttachmentsConsumed?: () => void
  /** Called when the user starts a new chat (parent clears persisted history). */
  onClearHistory?: () => void
  /** Called after the model / effort options change (parent refreshes project). */
  onOptionsChanged?: () => void
  /** A prompt to send on behalf of the user (e.g. the Rayfin upgrade hand-off). */
  outbound?: OutboundPrompt | null
  /** True when chat is expanded to fill the build view (preview hidden). */
  focused?: boolean
  /** Toggle chat focus (full-width chat ⇄ split with preview). */
  onToggleFocus?: () => void
}

/** Suggested Copilot models (free-text still allowed via the datalist input). */
const MODEL_SUGGESTIONS = ['claude-sonnet-4.5', 'gpt-5.4', 'gpt-5-mini', 'gpt-4.1', 'o4-mini']

const EFFORT_OPTIONS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** A clickable starter prompt shown on the empty state. */
interface Suggestion {
  icon: string
  text: string
}

/** Words to drop when guessing what an app is "about" from its name. */
const STOP_WORDS = new Set([
  'app',
  'apps',
  'application',
  'my',
  'the',
  'a',
  'an',
  'rayfin',
  'fabric',
  'fabricator',
  'demo',
  'test',
  'sample',
  'project',
  'tracker',
  'manager',
  'management',
  'hub',
  'board',
  'tool',
  'studio',
  'dashboard',
  'system',
  'portal',
  'keeper',
  'book',
  'box',
  'list',
  'log',
  'mate',
  'buddy',
  'pro',
  'plus',
  'lite'
])

/** Naive English pluralization — good enough for friendly UI copy. */
function pluralize(w: string): string {
  if (!w) return w
  if (w.endsWith('s')) return w
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`
  if (/(x|z|ch|sh)$/i.test(w)) return `${w}es`
  return `${w}s`
}

/** Naive singularization paired with {@link pluralize}. */
function singularize(w: string): string {
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.endsWith('ses')) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/**
 * Guess the "thing" an app manages from its name + template, so starter prompts
 * can be tailored ("Show all your plants" for a Plant Tracker). Falls back to a
 * sensible generic noun by template.
 */
function deriveThings(project: StudioProject): { thing: string; things: string } {
  const tpl = (project.template ?? '').toLowerCase()
  const words = (project.name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((w) => !STOP_WORDS.has(w) && !/^\d+$/.test(w))
  let base = words.length ? words[words.length - 1] : ''
  if (!base || base.length < 2) {
    base = tpl.includes('todo') ? 'task' : tpl.includes('data') ? 'record' : 'item'
  }
  return { thing: singularize(base), things: pluralize(base) }
}

/**
 * Build the empty-state starter prompts. These intentionally only cover what
 * Rayfin natively provides — data (lists/forms/search/charts), authentication,
 * file storage and design — never anything needing an external service (e.g.
 * payments or email).
 */
function suggestionsFor(project: StudioProject): Suggestion[] {
  const { thing, things } = deriveThings(project)
  const cards = {
    list: { icon: '📋', text: `Show all my ${things} on a clean page` },
    create: { icon: '✏️', text: `Add a form to create and edit a ${thing}` },
    search: { icon: '🔍', text: `Add search and filters to my ${things}` },
    chart: { icon: '📊', text: `Add a dashboard that charts my ${things}` },
    auth: { icon: '🔒', text: `Require sign-in so everyone gets their own ${things}` },
    photo: { icon: '🖼️', text: `Let me attach a photo to each ${thing}` },
    design: { icon: '🎨', text: 'Give the whole app a fresh, modern look' }
  }
  const tpl = (project.template ?? '').toLowerCase()
  let order: (keyof typeof cards)[]
  if (tpl.includes('auth')) order = ['auth', 'list', 'create', 'design']
  else if (tpl.includes('todo')) order = ['list', 'create', 'auth', 'design']
  else if (tpl.includes('data')) order = ['list', 'search', 'chart', 'create']
  else order = ['list', 'create', 'chart', 'design']
  return order.map((k) => cards[k])
}

/** Friendly, non-jargon label for a Copilot tool call (for non-coders). */
function friendlyTool(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('powershell') || n.includes('bash') || n.includes('shell')) return 'Running a command'
  if (n.includes('create')) return 'Creating a file'
  if (n.includes('edit') || n.includes('replace') || n.includes('str_replace')) return 'Editing code'
  if (n.includes('view') || n.includes('read') || n.includes('cat')) return 'Reading a file'
  if (n.includes('grep') || n.includes('search') || n.includes('glob') || n.includes('find'))
    return 'Searching the project'
  if (n.includes('delete') || n.includes('remove')) return 'Removing a file'
  return 'Working'
}

/**
 * Shorten a tool's detail for display: absolute paths inside the project are
 * shown relative to the project root (e.g. `src\pages\HomePage.tsx`) so the feed
 * reads cleanly for non-coders. Commands / descriptions pass through unchanged.
 */
function shortDetail(title: string, projectPath: string): string {
  const root = projectPath.replace(/[\\/]+$/, '')
  if (root && title.toLowerCase().startsWith(root.toLowerCase())) {
    const rel = title.slice(root.length).replace(/^[\\/]+/, '')
    return rel || 'project root'
  }
  return title
}

function UserIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  )
}

function SendIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  )
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function reduce(msg: UIChatMessage, ev: ChatEvent): UIChatMessage {
  switch (ev.type) {
    case 'delta':
      return { ...msg, text: msg.text + ev.text, notice: undefined }
    case 'tool-start':
      if (msg.tools.some((t) => t.id === ev.tool.id)) return msg
      return { ...msg, tools: [...msg.tools, ev.tool], notice: undefined }
    case 'tool-end':
      return {
        ...msg,
        tools: msg.tools.map((t) =>
          t.id === ev.id ? { ...t, state: ev.state, output: ev.output ?? t.output } : t
        )
      }
    case 'notice':
      return { ...msg, notice: ev.text }
    case 'error':
      return { ...msg, error: ev.text, pending: false, notice: undefined }
    case 'result':
      return { ...msg, pending: false, notice: undefined }
    default:
      return msg
  }
}

const TOOL_ICON: Record<ChatToolCall['state'], string> = {
  running: '⏳',
  success: '✓',
  error: '✗'
}

export default function ChatPanel({
  project,
  threadId = MAIN_THREAD_ID,
  messages,
  onChange,
  onTurnComplete,
  onBusyChange,
  attachments,
  onRemoveAttachment,
  onAttachmentsConsumed,
  onClearHistory,
  onOptionsChanged,
  outbound,
  focused,
  onToggleFocus
}: Props): JSX.Element {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [model, setModel] = useState(project.model ?? '')
  const [effort, setEffort] = useState<ReasoningEffort | ''>(project.effort ?? '')
  const [showModel, setShowModel] = useState(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const suggestions = useMemo(
    () => suggestionsFor(project),
    [project.id, project.name, project.template]
  )

  // Close the model/effort popover on any outside click.
  useEffect(() => {
    if (!showModel) return
    const close = (): void => setShowModel(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [showModel])

  function saveOptions(nextModel: string, nextEffort: ReasoningEffort | ''): void {
    void window.api.chat.setOptions(project.id, {
      model: nextModel.trim() || undefined,
      effort: nextEffort || undefined
    })
    onOptionsChanged?.()
  }

  useEffect(() => {
    const off = window.api.onChatEvent((envelope) => {
      if (envelope.projectId !== project.id || envelope.threadId !== threadId) return
      onChangeRef.current((prev) =>
        prev.map((m) =>
          m.turnId === envelope.turnId && m.role === 'assistant' ? reduce(m, envelope.event) : m
        )
      )
    })
    return off
  }, [project.id, threadId])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  // Auto-grow the composer textarea with its content (capped).
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [input])

  async function send(): Promise<void> {
    const text = input.trim()
    const shots = attachments ?? []
    if ((!text && shots.length === 0) || sending) return
    const prompt = text || 'Here is a screenshot of the current preview — please take a look.'
    setInput('')
    onAttachmentsConsumed?.()
    await dispatch(text || '(screenshot)', prompt, shots)
  }

  /** Append a fresh turn and stream its result. Shared by send + retry. */
  async function dispatch(
    displayText: string,
    prompt: string,
    shots: PendingShot[]
  ): Promise<void> {
    if (sending) return
    const turnId = uid()
    const userMsg: UIChatMessage = {
      id: uid(),
      role: 'user',
      text: displayText,
      tools: [],
      pending: false,
      attachments: shots.length || undefined
    }
    const assistantMsg: UIChatMessage = {
      id: uid(),
      turnId,
      role: 'assistant',
      text: '',
      tools: [],
      pending: true
    }
    onChange((prev) => [...prev, userMsg, assistantMsg])
    setSending(true)
    onBusyChange?.(true)
    try {
      const result = await window.api.chat.send(
        project.id,
        turnId,
        prompt,
        shots.map((s) => s.path),
        threadId
      )
      onChange((prev) => prev.map((m) => (m.turnId === turnId ? { ...m, pending: false } : m)))
      onTurnComplete?.(result)
    } finally {
      setSending(false)
      onBusyChange?.(false)
    }
  }

  /** Re-send the user prompt that produced a failed assistant turn. */
  async function retry(assistantId: string): Promise<void> {
    if (sending) return
    const idx = messages.findIndex((m) => m.id === assistantId)
    if (idx <= 0) return
    const user = messages[idx - 1]
    if (!user || user.role !== 'user' || user.text === '(screenshot)') return
    await dispatch(user.text, user.text, [])
  }

  async function stop(): Promise<void> {
    await window.api.chat.cancel(project.id, threadId)
  }

  async function newChat(): Promise<void> {
    await window.api.chat.reset(project.id, threadId)
    onChange(() => [])
    onClearHistory?.()
  }

  function applySuggestion(text: string): void {
    setInput(text)
    taRef.current?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  // Send a prompt queued from outside (e.g. the status-bar Rayfin upgrade). If a
  // turn is mid-flight we drop it into the composer instead of dropping it.
  const handledOutbound = useRef<string | null>(null)
  useEffect(() => {
    if (!outbound || outbound.id === handledOutbound.current) return
    handledOutbound.current = outbound.id
    if (sending) {
      setInput(outbound.prompt)
      taRef.current?.focus()
    } else {
      void dispatch(outbound.display, outbound.prompt, [])
    }
  }, [outbound?.id])

  return (
    <div className="chat">
      <div className="chat-toolbar">
        <span className="chat-toolbar-title">Chat</span>
        <span className="chat-toolbar-spacer" />
        <div className="chat-model-menu" onClick={(e) => e.stopPropagation()}>
          <button
            className="chat-model-btn"
            title="Choose the AI model and reasoning effort"
            onClick={() => setShowModel((s) => !s)}
          >
            <span className="chat-model-btn-icon">✨</span>
            <span className="chat-model-btn-label">{model || 'Auto'}</span>
            <span className="chat-model-btn-caret">▾</span>
          </button>
          {showModel && (
            <div className="chat-model-pop" role="dialog">
              <label className="chat-model-field">
                <span className="chat-model-field-label">Model</span>
                <input
                  className="chat-model-input"
                  list="copilot-models"
                  value={model}
                  placeholder="Auto (recommended)"
                  spellCheck={false}
                  autoFocus
                  onChange={(e) => setModel(e.target.value)}
                  onBlur={() => saveOptions(model, effort)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                />
                <datalist id="copilot-models">
                  {MODEL_SUGGESTIONS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <label className="chat-model-field">
                <span className="chat-model-field-label">Reasoning effort</span>
                <select
                  className="chat-model-input"
                  value={effort}
                  onChange={(e) => {
                    const next = e.target.value as ReasoningEffort | ''
                    setEffort(next)
                    saveOptions(model, next)
                  }}
                >
                  <option value="">Auto</option>
                  {EFFORT_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
              <p className="chat-model-hint">Leave on Auto unless you know what you need.</p>
            </div>
          )}
        </div>
        <button
          className="btn btn--sm btn--ghost"
          onClick={newChat}
          disabled={sending || messages.length === 0}
          title="Start a new conversation"
        >
          ＋ New chat
        </button>
        {onToggleFocus && (
          <button
            className={`btn btn--sm ${focused ? 'btn--primary' : 'btn--ghost'}`}
            onClick={onToggleFocus}
            title={focused ? 'Exit focus — show the preview again' : 'Focus the chat — hide the preview'}
          >
            {focused ? '⤡' : '⤢'}
          </button>
        )}
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-welcome">
            <div className="chat-welcome-badge">
              <img src={logo} alt="" />
            </div>
            <h2 className="chat-welcome-title">Let’s build {project.name}</h2>
            <p className="chat-welcome-sub">
              Describe what you want in plain language — I’ll write the code and deploy it live.
              No coding required.
            </p>
            <div className="chat-suggestions">
              {suggestions.map((s) => (
                <button
                  key={s.text}
                  className="chat-suggestion"
                  onClick={() => applySuggestion(s.text)}
                >
                  <span className="chat-suggestion-icon">{s.icon}</span>
                  <span className="chat-suggestion-text">{s.text}</span>
                  <span className="chat-suggestion-arrow">→</span>
                </button>
              ))}
            </div>
            <p className="chat-welcome-foot">Or just type your own idea below ↓</p>
          </div>
        )}

        {messages.map((m, i) => {
          const prevUser = m.role === 'assistant' && i > 0 ? messages[i - 1] : undefined
          const canRetry =
            Boolean(m.error) &&
            !sending &&
            prevUser?.role === 'user' &&
            !prevUser.attachments &&
            prevUser.text !== '(screenshot)'
          return (
            <div key={m.id} className={`turn turn--${m.role}`}>
              <div className={`turn-avatar${m.pending ? ' turn-avatar--pending' : ''}`}>
                {m.role === 'user' ? <UserIcon /> : <img src={logo} alt="" />}
              </div>
              <div className="turn-main">
                <div className="turn-role">{m.role === 'user' ? 'You' : 'Fabricator'}</div>
                {m.tools.length > 0 && (
                  <div className="tool-activity">
                    {m.tools.map((t) => (
                      <details key={t.id} className={`tool-call tool-call--${t.state}`}>
                        <summary title={t.title}>
                          <span className="tool-call-icon">
                            {t.state === 'running' ? (
                              <span className="tool-spin" />
                            ) : (
                              TOOL_ICON[t.state]
                            )}
                          </span>
                          <span className="tool-call-name">{friendlyTool(t.name)}</span>
                          <span className="tool-call-title">{shortDetail(t.title, project.path)}</span>
                        </summary>
                        {t.output && <pre className="tool-call-output">{t.output}</pre>}
                      </details>
                    ))}
                  </div>
                )}
                {m.text &&
                  (m.role === 'assistant' ? (
                    <div className="msg-text msg-text--md">
                      <Markdown>{m.text}</Markdown>
                    </div>
                  ) : (
                    <div className="msg-text">{m.text}</div>
                  ))}
                {m.attachments ? (
                  <div className="msg-attach">
                    ⛶ {m.attachments} screenshot{m.attachments > 1 ? 's' : ''} attached
                  </div>
                ) : null}
                {m.notice && <div className="msg-notice">↻ {m.notice}</div>}
                {m.pending && !m.text && m.tools.length === 0 && (
                  <div className="msg-typing" aria-label="Thinking">
                    <span />
                    <span />
                    <span />
                  </div>
                )}
                {m.error && (
                  <div className="alert alert--error msg-error">
                    <span className="msg-error-text">{m.error}</span>
                    {canRetry && (
                      <button
                        className="btn btn--xs btn--ghost msg-error-retry"
                        onClick={() => void retry(m.id)}
                        title="Re-send this message"
                      >
                        ↻ Retry
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="composer">
        {(attachments?.length ?? 0) > 0 && (
          <div className="chat-attachments">
            {attachments!.map((a) => (
              <div key={a.path} className="chat-attachment" title="Screenshot to send">
                <img src={a.thumb} alt="screenshot" />
                <button
                  className="chat-attachment-x"
                  onClick={() => onRemoveAttachment?.(a.path)}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-box">
          <textarea
            ref={taRef}
            className="composer-input"
            placeholder={`Message Fabricator about ${project.name}…`}
            value={input}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="composer-actions">
            <span className="composer-hint">Enter to send · Shift+Enter for newline</span>
            {sending ? (
              <button className="btn btn--sm btn--ghost composer-stop" onClick={stop}>
                ■ Stop
              </button>
            ) : (
              <button
                className="composer-send"
                onClick={send}
                disabled={!input.trim() && (attachments?.length ?? 0) === 0}
                title="Send (Enter)"
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
