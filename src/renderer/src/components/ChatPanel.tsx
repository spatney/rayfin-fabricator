import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent
} from 'react'
import {
  MAIN_THREAD_ID,
  type ChatEvent,
  type ChatMessage,
  type ChatMode,
  type ChatSegment,
  type ChatToolCall,
  type ChatTurnResult,
  type CopilotModel,
  type ReasoningEffort,
  type StudioProject
} from '@shared/ipc'
import type { PendingShot } from './PreviewPane'
import Markdown from './Markdown'
import { highlightCode, langFromPath } from '../syntax'
import {
  SparkleIcon,
  EraserIcon,
  ExpandIcon,
  CollapseIcon,
  CloseIcon,
  StopIcon,
  ImageIcon
} from './icons'
import logo from '../assets/logo.png'

export interface UIChatMessage extends ChatMessage {
  /** Correlates streamed events to the active assistant bubble (live only). */
  turnId?: string
  /** True while the assistant turn is still streaming. */
  pending: boolean
  /** Transient status note (e.g. a transient-failure retry); not persisted. */
  notice?: string
  /** A Plan-mode proposal awaiting the user's decision (live only). */
  plan?: {
    requestId: string
    summary: string
    planContent: string
    actions: string[]
    recommendedAction: string
    /** True once answered (here or elsewhere) — buttons disable. */
    resolved?: boolean
  }
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
  /** Stage an image the user added, pasted, or dropped into the composer. */
  onAddAttachment?: (shot: PendingShot) => void
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

/** Reasoning efforts shown when the engine's per-model list is unavailable
 * (offline / pre-fetch / signed-out). Also defines the canonical display order. */
const EFFORT_OPTIONS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_ORDER: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

// Module-level cache so the per-user model list is fetched once and shared across
// every ChatPanel instance (one per thread), rather than re-queried on each open.
let modelsCache: CopilotModel[] | null = null
let modelsPromise: Promise<CopilotModel[]> | null = null

function loadCopilotModels(): Promise<CopilotModel[]> {
  if (modelsCache) return Promise.resolve(modelsCache)
  if (!modelsPromise) {
    modelsPromise = window.api.chat
      .listModels()
      .then((list) => {
        modelsCache = list
        return list
      })
      .catch((err) => {
        modelsPromise = null // allow a retry on the next popover open
        throw err
      })
  }
  return modelsPromise
}

/** Fetch the available models once `enabled` (the picker is open), keeping the
 * static fallback until they arrive (or if the engine can't be reached). */
function useCopilotModels(enabled: boolean): { models: CopilotModel[]; loading: boolean } {
  const [models, setModels] = useState<CopilotModel[]>(modelsCache ?? [])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!enabled || modelsCache) return
    let cancelled = false
    setLoading(true)
    loadCopilotModels()
      .then((list) => {
        if (!cancelled) setModels(list)
      })
      .catch(() => {
        /* keep the static fallback */
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return { models, loading }
}

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

/** Coarse classification of a Copilot tool call, used for both labels and icons. */
type ToolKind = 'read' | 'edit' | 'create' | 'search' | 'run' | 'delete' | 'other'

function toolKind(name: string): ToolKind {
  const n = name.toLowerCase()
  if (n.includes('powershell') || n.includes('bash') || n.includes('shell')) return 'run'
  if (n.includes('create')) return 'create'
  if (n.includes('edit') || n.includes('replace') || n.includes('str_replace')) return 'edit'
  if (n.includes('view') || n.includes('read') || n.includes('cat')) return 'read'
  if (n.includes('grep') || n.includes('search') || n.includes('glob') || n.includes('find'))
    return 'search'
  if (n.includes('delete') || n.includes('remove')) return 'delete'
  return 'other'
}

const KIND_LABEL: Record<ToolKind, string> = {
  run: 'Running a command',
  create: 'Creating a file',
  edit: 'Editing code',
  read: 'Reading a file',
  search: 'Searching the project',
  delete: 'Removing a file',
  other: 'Working'
}

/** Friendly, non-jargon label for a Copilot tool call (for non-coders). */
function friendlyTool(name: string): string {
  return KIND_LABEL[toolKind(name)]
}

/** Cap a tool target for the single-line working bar (keep the filename for paths). */
function capTarget(s: string): string {
  const max = 44
  if (s.length <= max) return s
  if (/[\\/]/.test(s)) return '…' + s.slice(s.length - (max - 1))
  return s.slice(0, max - 1) + '…'
}

/** Distinct line icon per tool kind, so the activity feed is scannable at a glance. */
function ToolKindIcon({ kind, className }: { kind: ToolKind; className?: string }): JSX.Element {
  const p = {
    className: className ?? 'btn-ico',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  switch (kind) {
    case 'read':
      return (
        <svg {...p}>
          <path d="M7 3.5h7L18 7.5V20.5H7z" />
          <path d="M14 3.5V8h4" />
          <path d="M9.5 12.5h6M9.5 16h6" />
        </svg>
      )
    case 'edit':
      return (
        <svg {...p}>
          <path d="M4 20h4L19 9l-4-4L4 16z" />
          <path d="M13.5 6.5l4 4" />
        </svg>
      )
    case 'create':
      return (
        <svg {...p}>
          <path d="M7 3.5h7L18 7.5V20.5H7z" />
          <path d="M14 3.5V8h4" />
          <path d="M12 11.5v5M9.5 14h5" />
        </svg>
      )
    case 'search':
      return (
        <svg {...p}>
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-3.6-3.6" />
        </svg>
      )
    case 'run':
      return (
        <svg {...p}>
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <path d="M7 10l3 2.5L7 15" />
          <path d="M12.5 15h4" />
        </svg>
      )
    case 'delete':
      return (
        <svg {...p}>
          <path d="M5 7h14" />
          <path d="M9 7V4.5h6V7" />
          <path d="M6.5 7l1 12.5h9l1-12.5" />
        </svg>
      )
    default:
      return (
        <svg {...p}>
          <path d="M12 4.5l1.9 4.6 4.6 1.9-4.6 1.9L12 17.5l-1.9-4.6L5.5 11l4.6-1.9z" />
        </svg>
      )
  }
}

function CopyIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      className={className ?? 'btn-ico'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  )
}

/** Small clipboard button with brief "Copied" feedback (used on assistant turns). */
function CopyButton({ text, className }: { text: string; className?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable — ignore */
    }
  }
  return (
    <button
      type="button"
      className={`copy-btn${className ? ` ${className}` : ''}${copied ? ' copy-btn--done' : ''}`}
      onClick={copy}
      title="Copy message"
      aria-label="Copy message"
    >
      {copied ? (
        <span className="copy-btn-check" aria-hidden="true">
          ✓
        </span>
      ) : (
        <CopyIcon />
      )}
      <span className="copy-btn-label">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
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

function MergeIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="9" r="2.4" />
      <path d="M6 8.4v7.2" />
      <path d="M6 12h4a5 5 0 0 0 5-5V9" />
    </svg>
  )
}

/** Small glyph per chat mode, shown in the composer mode selector + its menu. */
function ModeIcon({ mode, className }: { mode: ChatMode; className?: string }): JSX.Element {
  const cls = className ?? 'btn-ico'
  if (mode === 'plan') {
    return (
      <svg
        className={cls}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10 6h8" />
        <path d="M10 12h8" />
        <path d="M10 18h8" />
        <path d="M4 5.4l1.2 1.3L7.6 4.3" />
        <path d="M4.2 12h2.4" />
        <path d="M4.2 18h2.4" />
      </svg>
    )
  }
  if (mode === 'autopilot') {
    return (
      <svg
        className={cls}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4.5 6.5 11 12l-6.5 5.5z" />
        <path d="M12.5 6.5 19 12l-6.5 5.5z" />
      </svg>
    )
  }
  return (
    <svg
      className={cls}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4.5" y="8" width="15" height="11" rx="3" />
      <path d="M12 4.6V8" />
      <circle cx="12" cy="4" r="1.1" />
      <circle cx="9.6" cy="13" r="1.15" />
      <circle cx="14.4" cy="13" r="1.15" />
    </svg>
  )
}

const NUM_LINE = /^(\s*)(\d+)\.\s?(.*)$/

/** Detect the read/view tool's `N. <code>` line format; split numbers from code. */
function parseNumbered(text: string): { nums: (number | null)[]; code: string } | null {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const nums: (number | null)[] = []
  const codes: string[] = []
  let matched = 0
  for (const line of lines) {
    const m = NUM_LINE.exec(line)
    if (m) {
      nums.push(Number(m[2]))
      codes.push(m[3])
      matched++
    } else {
      nums.push(null)
      codes.push(line)
    }
  }
  if (matched < Math.max(3, Math.ceil(lines.length * 0.7))) return null
  return { nums, code: codes.join('\n') }
}

/**
 * Renders a tool's output. File reads (the `N. <code>` format) get a line-number
 * gutter + syntax highlighting; everything else (commands, errors) stays plain.
 */
function ToolOutput({
  name,
  title,
  output
}: {
  name: string
  title: string
  output: string
}): JSX.Element {
  const numbered = useMemo(() => parseNumbered(output), [output])
  const kind = toolKind(name)
  const lang =
    kind === 'read' || kind === 'edit' || kind === 'create' ? langFromPath(title) : undefined
  const hl = useMemo(
    () => (numbered ? highlightCode(numbered.code, lang) : null),
    [numbered, lang]
  )

  if (!numbered) return <pre className="tool-call-output">{output}</pre>

  return (
    <div className="tool-code">
      <div className="tool-code-gutter" aria-hidden="true">
        {numbered.nums.map((n, i) => (
          <span key={i}>{n ?? ''}</span>
        ))}
      </div>
      <pre className="tool-code-pre">
        {hl ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: hl.html }} />
        ) : (
          <code className="hljs">{numbered.code}</code>
        )}
      </pre>
    </div>
  )
}

/** A single tool call row (expandable to its captured output). */
function ToolRow({
  tool: t,
  projectPath
}: {
  tool: ChatToolCall
  projectPath: string
}): JSX.Element {
  return (
    <details className={`tool-call tool-call--${t.state}`}>
      <summary title={t.title}>
        <span className="tool-call-icon">
          {t.state === 'running' ? (
            <span className="tool-spin" />
          ) : (
            <ToolKindIcon kind={toolKind(t.name)} className="tool-kind-ico" />
          )}
        </span>
        <span className="tool-call-name">{friendlyTool(t.name)}</span>
        <span className="tool-call-title">{shortDetail(t.title, projectPath)}</span>
      </summary>
      {t.output && <ToolOutput name={t.name} title={t.title} output={t.output} />}
    </details>
  )
}

/** Renders a turn's tool-activity list (used by the legacy / merge-event body). */
function ToolActivity({
  tools,
  projectPath
}: {
  tools: ChatToolCall[]
  projectPath: string
}): JSX.Element {
  return (
    <div className="tool-activity">
      {tools.map((t) => (
        <ToolRow key={t.id} tool={t} projectPath={projectPath} />
      ))}
    </div>
  )
}

/**
 * Renders an assistant turn body as a single chronological feed: prose and the
 * tool calls it ran, interleaved in the order they streamed. Falls back to the
 * legacy "all tools, then all text" grouping for turns without segment data
 * (e.g. older persisted history).
 */
function AssistantBody({
  message: m,
  projectPath
}: {
  message: UIChatMessage
  projectPath: string
}): JSX.Element {
  const segments = m.segments
  if (segments && segments.length > 0) {
    return (
      <div className="turn-feed">
        {segments.map((seg, i) => {
          if (seg.kind === 'text') {
            if (!seg.text.trim()) return null
            return (
              <div key={i} className="msg-text msg-text--md">
                <Markdown>{seg.text}</Markdown>
              </div>
            )
          }
          const tool = m.tools.find((t) => t.id === seg.id)
          if (!tool) return null
          return (
            <div key={i} className="tool-activity">
              <ToolRow tool={tool} projectPath={projectPath} />
            </div>
          )
        })}
      </div>
    )
  }
  return (
    <div className="turn-feed">
      {m.tools.length > 0 && <ToolActivity tools={m.tools} projectPath={projectPath} />}
      {m.text && (
        <div className="msg-text msg-text--md">
          <Markdown>{m.text}</Markdown>
        </div>
      )}
    </div>
  )
}

/**
 * Live "working" line shown at the bottom of an assistant turn while it streams.
 * Steps now render inline in the turn feed, so this is a slim pulse: a small orb,
 * a contextual label (what's happening right now) and a ticking timer. When the
 * turn is paused on a plan decision it switches to a calm "waiting" state with no
 * timer or work motion, so it never looks like it's still working.
 */
function AgentStatus({
  tools,
  hasText,
  notice,
  projectPath,
  awaitingDecision
}: {
  tools: ChatToolCall[]
  hasText: boolean
  notice?: string
  projectPath: string
  awaitingDecision?: boolean
}): JSX.Element {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  if (awaitingDecision) {
    return (
      <div className="agent-status agent-status--await">
        <span className="agent-status-await-dot" aria-hidden="true" />
        <span className="agent-status-await-label">Waiting for your decision</span>
      </div>
    )
  }

  const running = tools.find((t) => t.state === 'running')
  let label: string
  if (notice) label = notice
  else if (running) {
    const target = running.title ? capTarget(shortDetail(running.title, projectPath)) : ''
    label = target ? `${friendlyTool(running.name)} — ${target}` : friendlyTool(running.name)
  } else if (hasText) label = 'Writing the response'
  else if (tools.length) label = 'Working through the steps'
  else label = 'Thinking'

  const mm = Math.floor(elapsed / 60)
  const ss = String(elapsed % 60).padStart(2, '0')

  return (
    <div className={`agent-status${notice ? ' agent-status--notice' : ''}`}>
      <span className="agent-status-orb" aria-hidden="true">
        <span className="agent-status-orb-core" />
      </span>
      <span className="agent-status-label">{notice ? `↻ ${label}` : `${label}…`}</span>
      <span className="agent-status-time" aria-label="Elapsed time">
        {mm}:{ss}
      </span>
    </div>
  )
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * Plan-mode approval card: shows the proposed plan summary (with an expandable
 * full plan) and the continuation choices. Buttons disable once the plan is
 * resolved. "Keep planning" reveals an optional feedback box that sends the
 * agent back to revise.
 */
function PlanCard({
  plan,
  onResolve
}: {
  plan: NonNullable<UIChatMessage['plan']>
  onResolve: (action: string, feedback?: string) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState('')
  const resolved = Boolean(plan.resolved)
  const actions = plan.actions.filter((a) => a in PLAN_ACTION_LABELS)
  return (
    <div className={`plan-card${resolved ? ' plan-card--resolved' : ''}`}>
      <div className="plan-card-head">
        <span className="plan-card-icon" aria-hidden="true">
          <SparkleIcon />
        </span>
        <span className="plan-card-title">Plan ready for review</span>
        {resolved && <span className="plan-card-status">Resolved</span>}
      </div>
      {plan.summary && (
        <div className="plan-card-summary msg-text--md">
          <Markdown>{plan.summary}</Markdown>
        </div>
      )}
      {plan.planContent && (
        <div className="plan-card-detail">
          <button
            type="button"
            className="plan-card-toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? '▾ Hide full plan' : '▸ View full plan'}
          </button>
          {expanded && (
            <div className="plan-card-body msg-text--md">
              <Markdown>{plan.planContent}</Markdown>
            </div>
          )}
        </div>
      )}
      {!resolved && (
        <>
          <div className="plan-card-actions">
            {actions.map((a) => (
              <button
                key={a}
                type="button"
                className={`btn btn--sm${a === plan.recommendedAction ? ' btn--primary' : ' btn--ghost'}`}
                onClick={() => onResolve(a)}
              >
                {PLAN_ACTION_LABELS[a]}
              </button>
            ))}
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setRevising((v) => !v)}
            >
              Keep planning
            </button>
          </div>
          {revising && (
            <div className="plan-card-revise">
              <textarea
                className="plan-card-feedback"
                placeholder="Optional — what should change about the plan?"
                value={feedback}
                rows={2}
                onChange={(e) => setFeedback(e.target.value)}
              />
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => onResolve('keep_planning', feedback.trim() || undefined)}
              >
                Send feedback
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Largest dimension we keep when re-encoding pasted/added images (keeps temp
 *  files and the model's vision payload reasonable). */
const MAX_IMAGE_DIM = 2000

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode image'))
    img.src = src
  })
}

/** Re-encode an image data URL to a (possibly downscaled) PNG plus a small thumb. */
async function toPngAndThumb(src: string): Promise<{ png: string; thumb: string }> {
  const img = await loadImage(src)
  const fit = Math.min(1, MAX_IMAGE_DIM / Math.max(img.naturalWidth, img.naturalHeight, 1))
  const w = Math.max(1, Math.round(img.naturalWidth * fit))
  const h = Math.max(1, Math.round(img.naturalHeight * fit))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(img, 0, 0, w, h)
  const png = canvas.toDataURL('image/png')

  const tScale = Math.min(1, 176 / w)
  const tw = Math.max(1, Math.round(w * tScale))
  const th = Math.max(1, Math.round(h * tScale))
  const tCanvas = document.createElement('canvas')
  tCanvas.width = tw
  tCanvas.height = th
  const tCtx = tCanvas.getContext('2d')
  if (!tCtx) return { png, thumb: png }
  tCtx.drawImage(canvas, 0, 0, tw, th)
  return { png, thumb: tCanvas.toDataURL('image/png') }
}

/**
 * Append streamed text to the segment list, merging into the trailing text
 * segment when possible so consecutive deltas stay one prose block (tool
 * segments in between naturally split the prose into chronological slices).
 */
function appendText(segments: ChatSegment[] | undefined, text: string): ChatSegment[] {
  const segs = segments ?? []
  const last = segs[segs.length - 1]
  if (last && last.kind === 'text') {
    return [...segs.slice(0, -1), { kind: 'text', text: last.text + text }]
  }
  return [...segs, { kind: 'text', text }]
}

function reduce(msg: UIChatMessage, ev: ChatEvent): UIChatMessage {
  switch (ev.type) {
    case 'delta':
      return {
        ...msg,
        text: msg.text + ev.text,
        segments: appendText(msg.segments, ev.text),
        notice: undefined
      }
    case 'tool-start':
      if (msg.tools.some((t) => t.id === ev.tool.id)) return msg
      return {
        ...msg,
        tools: [...msg.tools, ev.tool],
        segments: [...(msg.segments ?? []), { kind: 'tool', id: ev.tool.id }],
        notice: undefined
      }
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
    case 'plan-proposed':
      return {
        ...msg,
        plan: {
          requestId: ev.requestId,
          summary: ev.summary,
          planContent: ev.planContent,
          actions: ev.actions,
          recommendedAction: ev.recommendedAction,
          resolved: false
        },
        notice: undefined
      }
    case 'plan-resolved':
      if (!msg.plan || msg.plan.requestId !== ev.requestId) return msg
      return { ...msg, plan: { ...msg.plan, resolved: true } }
    default:
      return msg
  }
}

/** Composer mode options (Agent / Plan / Autopilot) with hover hints + menu copy. */
const MODES: { id: ChatMode; label: string; hint: string; desc: string }[] = [
  {
    id: 'agent',
    label: 'Agent',
    hint: 'Agent — do the work, auto-approving tools (default).',
    desc: 'Does the work for you, auto-approving tools. The everyday default.'
  },
  {
    id: 'plan',
    label: 'Plan',
    hint: 'Plan — research first, then propose a plan for your approval before acting.',
    desc: 'Researches first, then proposes a plan for your approval before acting.'
  },
  {
    id: 'autopilot',
    label: 'Autopilot',
    hint: 'Autopilot — run autonomously end-to-end, auto-approving tools.',
    desc: 'Runs autonomously end-to-end, auto-approving tools.'
  }
]

/** Friendly labels for the SDK's plan continuation actions. */
const PLAN_ACTION_LABELS: Record<string, string> = {
  interactive: 'Approve & run',
  autopilot: 'Approve & autopilot',
  autopilot_fleet: 'Approve & autopilot fleet',
  exit_only: 'Approve (exit plan)'
}

/**
 * Which composer mode a continuation maps to, so the bar reflects the user's
 * choice after they approve a plan. `exit_only` / `keep_planning` leave it unchanged.
 */
const ACTION_TO_MODE: Record<string, ChatMode> = {
  interactive: 'agent',
  autopilot: 'autopilot',
  autopilot_fleet: 'autopilot'
}

export default function ChatPanel({
  project,
  threadId = MAIN_THREAD_ID,
  messages,
  onChange,
  onTurnComplete,
  onBusyChange,
  attachments,
  onAddAttachment,
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
  const [mode, setMode] = useState<ChatMode>('agent')
  const [model, setModel] = useState(project.model ?? '')
  const [effort, setEffort] = useState<ReasoningEffort | ''>(project.effort ?? '')
  const [showModel, setShowModel] = useState(false)
  const [showMode, setShowMode] = useState(false)
  const { models, loading: modelsLoading } = useCopilotModels(showModel)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [attaching, setAttaching] = useState(false)

  const suggestions = useMemo(
    () => suggestionsFor(project),
    [project.id, project.name, project.template]
  )

  // The currently-selected model's metadata (when a concrete, still-listed model
  // is chosen) — used to label the picker button and scope the effort options.
  const selectedModel = useMemo(() => models.find((m) => m.id === model), [models, model])

  // The active mode's copy, used to label the composer's mode pill.
  const currentMode = MODES.find((m) => m.id === mode) ?? MODES[0]

  // Reasoning efforts offered for the current selection: the chosen model's own
  // set, or — on Auto — the union across all models (an effort still rides along
  // with whatever the engine picks). Falls back to the static list when empty.
  const effortOptions = useMemo<ReasoningEffort[]>(() => {
    let efforts: ReasoningEffort[]
    if (selectedModel) {
      efforts = selectedModel.supportedReasoningEfforts
    } else {
      const set = new Set<ReasoningEffort>()
      for (const m of models) for (const e of m.supportedReasoningEfforts) set.add(e)
      efforts = [...set]
    }
    if (efforts.length === 0) efforts = EFFORT_OPTIONS
    return EFFORT_ORDER.filter((e) => efforts.includes(e))
  }, [models, selectedModel])

  // Close the model/effort popover on any outside click.
  useEffect(() => {
    if (!showModel) return
    const close = (): void => setShowModel(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [showModel])

  // Same for the composer mode menu.
  useEffect(() => {
    if (!showMode) return
    const close = (): void => setShowMode(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [showMode])

  function saveOptions(nextModel: string, nextEffort: ReasoningEffort | ''): void {
    void window.api.chat.setOptions(project.id, {
      model: nextModel.trim() || undefined,
      effort: nextEffort || undefined
    })
    onOptionsChanged?.()
  }

  // Switch model; if the in-effect effort isn't valid for the new model, drop
  // back to Auto so we never send an unsupported model/effort pair.
  function selectModel(nextModel: string): void {
    setModel(nextModel)
    const next = models.find((m) => m.id === nextModel)
    const stillValid = !effort || !next || next.supportedReasoningEfforts.includes(effort)
    const nextEffort = stillValid ? effort : ''
    if (nextEffort !== effort) setEffort(nextEffort)
    saveOptions(nextModel, nextEffort)
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

  // Keep the view pinned to the newest content — but only when the user is already
  // near the bottom, so reading earlier messages isn't interrupted. Otherwise we
  // surface a "Jump to latest" affordance instead of yanking them back down.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (stick.current) {
      el.scrollTop = el.scrollHeight
      setShowJump(false)
    } else {
      setShowJump(true)
    }
  }, [messages])

  function onScrollChat(): void {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = nearBottom
    setShowJump(!nearBottom)
  }

  function jumpToLatest(): void {
    const el = scrollRef.current
    if (!el) return
    stick.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setShowJump(false)
  }

  // Auto-grow the composer textarea with its content (capped).
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [input])

  // Stage one or more images (from the file picker, paste, or drag-drop) as chat
  // attachments — re-encoded to PNG and saved to a temp file, reusing the same
  // pending-attachment flow as annotated screenshots.
  async function stageImages(files: Iterable<File | null | undefined>): Promise<void> {
    if (!onAddAttachment) return
    const images = Array.from(files).filter(
      (f): f is File => !!f && f.type.startsWith('image/')
    )
    if (images.length === 0) return
    setAttaching(true)
    try {
      for (const file of images) {
        const src = await readAsDataUrl(file)
        const { png, thumb } = await toPngAndThumb(src)
        const path = await window.api.screenshot.save(png)
        onAddAttachment({ path, thumb })
      }
    } catch (err) {
      console.error('Failed to attach image', err)
    } finally {
      setAttaching(false)
    }
  }

  function onPickFiles(e: ChangeEvent<HTMLInputElement>): void {
    void stageImages(e.target.files ?? [])
    e.target.value = '' // allow re-selecting the same file
  }

  function onComposerPaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length > 0) {
      e.preventDefault()
      void stageImages(files)
    }
  }

  function onComposerDrop(e: DragEvent<HTMLDivElement>): void {
    const files = e.dataTransfer?.files
    if (files && Array.from(files).some((f) => f.type.startsWith('image/'))) {
      e.preventDefault()
      void stageImages(files)
    }
  }

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
      attachments: shots.length || undefined,
      attachmentThumbs: shots.length ? shots.map((s) => s.thumb) : undefined
    }
    const assistantMsg: UIChatMessage = {
      id: uid(),
      turnId,
      role: 'assistant',
      text: '',
      tools: [],
      segments: [],
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
        threadId,
        mode
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

  /** Answer a Plan-mode approval card; optimistically disables its buttons. */
  async function resolvePlan(
    msgId: string,
    requestId: string,
    action: string,
    feedback?: string
  ): Promise<void> {
    onChange((prev) =>
      prev.map((m) => (m.id === msgId && m.plan ? { ...m, plan: { ...m.plan, resolved: true } } : m))
    )
    // Reflect the approved continuation in the composer so the bar no longer reads "Plan".
    const nextMode = ACTION_TO_MODE[action]
    if (nextMode) setMode(nextMode)
    try {
      await window.api.chat.resolvePlan(requestId, action, feedback)
    } catch (err) {
      console.error('Failed to resolve plan', err)
    }
  }

  async function newChat(): Promise<void> {
    await window.api.chat.reset(project.id, threadId)
    onChange(() => [])
    setMode('agent')
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
            <SparkleIcon className="chat-model-btn-icon" />
            <span className="chat-model-btn-label">{selectedModel?.name || model || 'Auto'}</span>
            <span className="chat-model-btn-caret">▾</span>
          </button>
          {showModel && (
            <div className="chat-model-pop" role="dialog">
              <label className="chat-model-field">
                <span className="chat-model-field-label">Model</span>
                <select
                  className="chat-model-input"
                  value={model}
                  autoFocus
                  onChange={(e) => selectModel(e.target.value)}
                >
                  <option value="">Auto (recommended)</option>
                  {/* Keep a saved model selectable even if it's no longer listed. */}
                  {model && !models.some((m) => m.id === model) && (
                    <option value={model}>{model}</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
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
                  {effortOptions.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
              <p className="chat-model-hint">
                {modelsLoading && models.length === 0
                  ? 'Loading models…'
                  : 'Leave on Auto unless you know what you need.'}
              </p>
            </div>
          )}
        </div>
        <div className="seg seg--toolbar">
          <button
            className="seg-btn"
            onClick={newChat}
            disabled={sending || messages.length === 0}
            title="Clear this conversation and start fresh"
          >
            <EraserIcon />
            Clear chat
          </button>
          {onToggleFocus && (
            <button
              className={`seg-btn seg-btn--icon${focused ? ' seg-btn--on' : ''}`}
              onClick={onToggleFocus}
              title={
                focused
                  ? 'Exit focus — show the preview again'
                  : 'Focus the chat — hide the preview'
              }
              aria-label={focused ? 'Exit focus' : 'Focus the chat'}
            >
              {focused ? <CollapseIcon /> : <ExpandIcon />}
            </button>
          )}
        </div>
      </div>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScrollChat}>
        {messages.length === 0 && (
          <div className="chat-welcome">
            <div className="chat-welcome-badge">
              <img src={logo} alt="" />
            </div>
            <h2 className="chat-welcome-title">Let’s build {project.name}</h2>
            <p className="chat-welcome-sub">
              Describe what you want in plain language — I’ll write the code and deploy it live. No
              coding required.
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
          if (m.kind === 'merge') {
            const who = m.mergeName ?? 'side thread'
            const label = m.error
              ? `Couldn’t merge “${who}” into main`
              : m.pending
                ? `Merging “${who}” into main…`
                : `Merged “${who}” into main`
            const hasBody = m.tools.length > 0 || Boolean(m.text)
            return (
              <div
                key={m.id}
                className={`merge-event${m.error ? ' merge-event--error' : ''}${
                  m.pending ? ' merge-event--pending' : ''
                }`}
              >
                <div className="merge-event-head">
                  <span className="merge-event-icon">
                    {m.pending ? <span className="tool-spin" /> : m.error ? '⚠' : <MergeIcon />}
                  </span>
                  <span className="merge-event-label">{label}</span>
                </div>
                {hasBody && (
                  <div className="merge-event-body">
                    <AssistantBody message={m} projectPath={project.path} />
                  </div>
                )}
                {m.error && <div className="alert alert--error merge-event-error">{m.error}</div>}
              </div>
            )
          }
          const prevUser = m.role === 'assistant' && i > 0 ? messages[i - 1] : undefined
          const canRetry =
            Boolean(m.error) &&
            !sending &&
            prevUser?.role === 'user' &&
            !prevUser.attachments &&
            prevUser.text !== '(screenshot)'
          return (
            <div key={m.id} className={`turn turn--${m.role}`}>
              <div className="turn-head">
                <div className={`turn-avatar${m.pending ? ' turn-avatar--pending' : ''}`}>
                  {m.role === 'user' ? <UserIcon /> : <img src={logo} alt="" />}
                </div>
                <div className="turn-role">{m.role === 'user' ? 'You' : 'Fabricator'}</div>
                {m.role === 'assistant' && Boolean(m.text) && !m.pending && (
                  <CopyButton text={m.text} className="turn-copy" />
                )}
              </div>
              <div className="turn-main">
                {m.role === 'assistant' ? (
                  <AssistantBody message={m} projectPath={project.path} />
                ) : (
                  m.text && <div className="msg-text">{m.text}</div>
                )}
                {m.plan && (
                  <PlanCard
                    plan={m.plan}
                    onResolve={(action, feedback) =>
                      void resolvePlan(m.id, m.plan!.requestId, action, feedback)
                    }
                  />
                )}
                {m.attachmentThumbs && m.attachmentThumbs.length > 0 ? (
                  <div className="msg-shots">
                    {m.attachmentThumbs.map((src, i) => (
                      <img key={i} className="msg-shot" src={src} alt="Screenshot attachment" />
                    ))}
                  </div>
                ) : m.attachments ? (
                  <div className="msg-attach">
                    <ImageIcon className="msg-attach-ico" />
                    {m.attachments} screenshot{m.attachments > 1 ? 's' : ''}
                  </div>
                ) : null}
                {m.notice && !m.pending && <div className="msg-notice">↻ {m.notice}</div>}
                {m.pending && (
                  <AgentStatus
                    tools={m.tools}
                    hasText={Boolean(m.text)}
                    notice={m.notice}
                    projectPath={project.path}
                    awaitingDecision={Boolean(m.plan && !m.plan.resolved)}
                  />
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
        {showJump && (
          <button
            type="button"
            className="chat-jump"
            onClick={jumpToLatest}
            title="Jump to the latest message"
          >
            <span className="chat-jump-label">Jump to latest</span>
            <span className="chat-jump-arrow" aria-hidden="true">
              ↓
            </span>
          </button>
        )}
      </div>

      <div className={`composer${sending ? ' composer--busy' : ''}`}>
        {sending && <div className="composer-busyline" aria-hidden="true" />}
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
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className="composer-box"
          onDrop={onComposerDrop}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.items).some((it) => it.kind === 'file'))
              e.preventDefault()
          }}
        >
          <textarea
            ref={taRef}
            className="composer-input"
            placeholder={`Message Fabricator about ${project.name}…`}
            value={input}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onComposerPaste}
          />
          <div className="composer-actions">
            <div className="composer-left">
              <div
                className="mode-menu"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setShowMode(false)
                }}
              >
                <button
                  type="button"
                  className={`mode-trigger${showMode ? ' mode-trigger--open' : ''}`}
                  onClick={() => setShowMode((s) => !s)}
                  disabled={sending}
                  aria-haspopup="menu"
                  aria-expanded={showMode}
                  title={currentMode.hint}
                >
                  <ModeIcon mode={mode} className="mode-trigger-icon" />
                  <span className="mode-trigger-label">{currentMode.label}</span>
                  <span className="mode-trigger-caret">▾</span>
                </button>
                {showMode && (
                  <div className="mode-pop" role="menu">
                    {MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={mode === m.id}
                        className={`mode-opt${mode === m.id ? ' mode-opt--on' : ''}`}
                        onClick={() => {
                          setMode(m.id)
                          setShowMode(false)
                        }}
                      >
                        <ModeIcon mode={m.id} className="mode-opt-icon" />
                        <span className="mode-opt-text">
                          <span className="mode-opt-label">{m.label}</span>
                          <span className="mode-opt-desc">{m.desc}</span>
                        </span>
                        {mode === m.id && (
                          <span className="mode-opt-check" aria-hidden="true">
                            ✓
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="composer-hint">
                <kbd>Enter</kbd>
                <span>to send</span>
                <span className="composer-hint-sep">·</span>
                <kbd>Shift</kbd>
                <kbd>Enter</kbd>
                <span>for newline</span>
              </span>
            </div>
            <div className="composer-right">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={onPickFiles}
              />
              <button
                className="composer-attach"
                onClick={() => fileRef.current?.click()}
                disabled={attaching}
                title="Attach an image (or paste / drop one here)"
                aria-label="Attach an image"
              >
                <ImageIcon />
              </button>
              {sending ? (
                <button
                  className="composer-send composer-send--stop"
                  onClick={stop}
                  title="Stop generating"
                  aria-label="Stop generating"
                >
                  <StopIcon />
                </button>
              ) : (
                <button
                  className="composer-send"
                  onClick={send}
                  disabled={!input.trim() && (attachments?.length ?? 0) === 0}
                  title="Send (Enter)"
                  aria-label="Send"
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
