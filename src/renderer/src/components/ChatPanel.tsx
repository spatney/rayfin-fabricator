import {
  memo,
  useCallback,
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
  type AgentToolSettings,
  type ChatEvent,
  type ChatMessage,
  type ChatMode,
  type ChatSegment,
  type ChatToolCall,
  type ChatToolMedia,
  type ChatTurnResult,
  type FileNode,
  type ReasoningEffort,
  type StudioProject,
  type Suggestion
} from '@shared/ipc'
import { useCopilotModels } from '@renderer/copilotModels'
import type { PendingShot } from './PreviewPane'
import Markdown from './Markdown'
import { MentionText, splitMentions } from './MentionText'
import { highlightCode, langFromPath } from '../syntax'
import {
  SparkleIcon,
  EraserIcon,
  ExpandIcon,
  CollapseIcon,
  CloseIcon,
  StopIcon,
  ImageIcon,
  ChevronRightIcon,
  ClockIcon,
  Codicon
} from './icons'
import { FabricatorMark } from './FabricatorMark'

export interface UIChatMessage extends ChatMessage {
  /** Correlates streamed events to the active assistant bubble (live only). */
  turnId?: string
  /** True while the assistant turn is still streaming. */
  pending: boolean
  /**
   * Epoch ms when the assistant turn began (live only). Sourced here rather than
   * from the status component's mount time so the elapsed timer keeps counting
   * correctly after the chat unmounts/remounts (e.g. switching workbench tabs).
   */
  startedAt?: number
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
  /** Steer a running turn immediately instead of staging this prompt. */
  interrupt?: boolean
  /**
   * When true the prompt is dropped into the composer (and focused) instead of
   * being sent immediately — used to "stage" context (e.g. a slice of history)
   * so the user can append their actual request before sending.
   */
  stage?: boolean
}

interface Props {
  project: StudioProject
  messages: UIChatMessage[]
  onChange: (updater: (prev: UIChatMessage[]) => UIChatMessage[]) => void
  /** Called after a turn completes (used later to trigger deploy/preview refresh). */
  onTurnComplete?: (result: ChatTurnResult) => void
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
  /** Called once an outbound prompt has been consumed so the parent can clear it
   * (prevents the one-shot prompt from replaying when the panel remounts). */
  onOutboundConsumed?: () => void
  /** True when chat is expanded to fill the build view (preview hidden). */
  focused?: boolean
  /** Toggle chat focus (full-width chat ⇄ split with preview). */
  onToggleFocus?: () => void
  /** Hard-gate: the project has no deployment yet — disable the composer until it does. */
  deployLock?: boolean
  /** True while the project's first deploy is actively streaming (gate shows progress). */
  deploying?: boolean
  /** Open the fullscreen deploy step (the gate CTA). */
  onRequestDeploy?: () => void
  /** Experimental: show the Agent / Plan / Autopilot mode selector in the composer.
   * When false (the default), the selector is hidden and every turn runs in Agent mode. */
  modeSelectorEnabled?: boolean
  /** Open a file referenced by an @-mention chip (path without the leading @). */
  onOpenMention?: (ref: string) => void
  /** The current composer draft. Persisted by the parent (keyed by project) so a
   * typed-but-unsent prompt survives this panel unmounting — e.g. switching to the
   * Code tab and back to Build tears down ChatPanel (issue #9). */
  draft?: string
  /** Called whenever the composer draft changes so the parent can persist it. */
  onDraftChange?: (value: string) => void
}

/** Reasoning efforts shown when the engine's per-model list is unavailable
 * (offline / pre-fetch / signed-out). Also defines the canonical display order. */
const EFFORT_OPTIONS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_ORDER: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

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

/**
 * Ask Copilot for starter suggestions grounded in the project's actual code. The
 * backend caches per project (reused until the code changes), so this is cheap to
 * call whenever the empty Build chat is shown. The welcome screen shows the
 * instant heuristic suggestions right away and only swaps in this generated set
 * once it arrives, so `loading` never blocks the UI — it just drives a subtle
 * "Tailoring ideas…" hint. On any failure/timeout the heuristic fallback simply
 * stays. The in-flight request is cancelled when the empty state goes away (e.g.
 * the user sends a message) so it never competes with a real turn.
 */
function useGeneratedSuggestions(
  projectId: string,
  enabled: boolean
): { suggestions: Suggestion[] | null; loading: boolean; failed: boolean; refresh: () => void } {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null)
  // Start in the loading state when enabled so the skeletons show immediately,
  // rather than flashing the heuristic fallback for a frame before the effect runs.
  const [loading, setLoading] = useState(enabled)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    setFailed(false)
    // A forced refresh should regenerate even if the code is unchanged.
    const p =
      nonce > 0
        ? window.api.chat.cancelSuggest(projectId).catch(() => false)
        : Promise.resolve(false)
    void p.then(() =>
      window.api.chat
        .suggest(projectId)
        .then((set) => {
          if (cancelled) return
          if (set.ok && set.suggestions.length > 0) {
            setSuggestions(set.suggestions)
          } else {
            setFailed(true)
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    )
    return () => {
      cancelled = true
      // Stop any in-flight generation so it doesn't run alongside a real turn.
      void window.api.chat.cancelSuggest(projectId).catch(() => undefined)
    }
  }, [projectId, enabled, nonce])

  const refresh = (): void => {
    setSuggestions(null)
    setNonce((n) => n + 1)
  }

  return { suggestions, loading, failed, refresh }
}

/** Coarse classification of a Copilot tool call, used for both labels and icons. */
type ToolKind =
  | 'read'
  | 'edit'
  | 'create'
  | 'search'
  | 'run'
  | 'delete'
  | 'deploy'
  | 'navigate'
  | 'screenshot'
  | 'other'

function toolKind(name: string): ToolKind {
  const n = name.toLowerCase()
  // Fabricator's own tools first — their names ("fabricator_…") contain the
  // substring "cat", which would otherwise be misread as a file "cat"/read.
  if (n.includes('screenshot')) return 'screenshot'
  if (n.includes('navigate') || n.includes('interact')) return 'navigate'
  if (n.includes('deploy')) return 'deploy'
  if (n.includes('console') || n.includes('network') || n.includes('inspect')) return 'search'
  if (n.includes('semantic_model')) return 'search'
  if (n.includes('evaluate') || n.includes('cdp')) return 'run'
  if (n.includes('powershell') || n.includes('bash') || n.includes('shell')) return 'run'
  if (n.includes('create')) return 'create'
  if (n.includes('edit') || n.includes('replace') || n.includes('str_replace')) return 'edit'
  if (n.includes('view') || n.includes('read') || /\bcat\b/.test(n)) return 'read'
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
  deploy: 'Deploying the app',
  navigate: 'Opening the preview',
  screenshot: 'Taking a screenshot',
  other: 'Working'
}

/** Friendly, non-jargon label for a Copilot tool call (for non-coders). */
function friendlyTool(name: string): string {
  const label: Record<string, string> = {
    fabricator_deployment_status: 'Checking deployment',
    fabricator_deploy: 'Deploying the app',
    fabricator_preview_navigate: 'Navigating the preview',
    fabricator_preview_screenshot: 'Capturing a screenshot',
    fabricator_preview_console: 'Reading the console',
    fabricator_preview_network: 'Inspecting network traffic',
    fabricator_preview_inspect: 'Inspecting the page',
    fabricator_preview_interact: 'Operating the page',
    fabricator_preview_evaluate: 'Running page JavaScript',
    fabricator_preview_cdp: 'Using the browser debugger',
    fabricator_locate_semantic_model: 'Locating a semantic model',
    fabricator_search_semantic_models: 'Searching Fabric data'
  }
  if (label[name]) return label[name]
  return KIND_LABEL[toolKind(name)]
}

/**
 * Compact, client-side roll-up of what a finished turn did, derived from its
 * tool calls (e.g. "Edited 3 files · ran 2 commands · read 5 files"). Returns an
 * empty string when there is nothing meaningful to summarise.
 */
function summarizeToolParts(tools: ChatToolCall[]): { parts: string[]; total: number } {
  const c: Record<ToolKind, number> = {
    read: 0,
    edit: 0,
    create: 0,
    search: 0,
    run: 0,
    delete: 0,
    deploy: 0,
    navigate: 0,
    screenshot: 0,
    other: 0
  }
  for (const t of tools) c[toolKind(t.name)]++
  const n = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`
  const parts: string[] = []
  if (c.edit) parts.push(`Edited ${n(c.edit, 'file', 'files')}`)
  if (c.create) parts.push(`Created ${n(c.create, 'file', 'files')}`)
  if (c.run) parts.push(`Ran ${n(c.run, 'command', 'commands')}`)
  if (c.read) parts.push(`Read ${n(c.read, 'file', 'files')}`)
  if (c.search) parts.push(`Ran ${n(c.search, 'search', 'searches')}`)
  if (c.delete) parts.push(`Removed ${n(c.delete, 'file', 'files')}`)
  if (c.deploy) parts.push(`Deployed ${n(c.deploy, 'time', 'times')}`)
  if (c.screenshot) parts.push(`Took ${n(c.screenshot, 'screenshot', 'screenshots')}`)
  if (c.navigate) parts.push(`Opened ${n(c.navigate, 'page', 'pages')}`)
  // Total actions accounted for by the breakdown above (excludes uncategorized
  // "other" calls, which aren't shown as their own line).
  const total =
    c.edit + c.create + c.run + c.read + c.search + c.delete + c.deploy + c.screenshot + c.navigate
  return { parts, total }
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
    case 'deploy':
      return (
        <svg {...p}>
          <path d="M6 16.5A3.5 3.5 0 0 1 6.5 9.6 5 5 0 0 1 16 8.8a3.6 3.6 0 0 1 2 6.7" />
          <path d="M12 12v7" />
          <path d="M9.5 14.5 12 12l2.5 2.5" />
        </svg>
      )
    case 'navigate':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M15.5 8.5 13 13l-4.5 2.5L11 11z" />
        </svg>
      )
    case 'screenshot':
      return (
        <svg {...p}>
          <path d="M4 8.5h3l1.5-2h7L17 8.5h3v10H4z" />
          <circle cx="12" cy="13" r="3" />
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

function CheckIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      className={className ?? 'btn-ico'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
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
          <Codicon name="check" />
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

type JsonObject = Record<string, unknown>

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function parseJsonResult(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    return null
  }
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function formatBytes(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ToolImage({ media }: { media: ChatToolMedia }): JSX.Element {
  const [src, setSrc] = useState<string>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    setSrc(undefined)
    setFailed(false)
    void window.api.chat.readToolImage(media.path).then(
      (value) => {
        if (active) setSrc(value)
      },
      () => {
        if (active) setFailed(true)
      }
    )
    return () => {
      active = false
    }
  }, [media.path])

  return (
    <div className="tool-image">
      {src ? (
        <img src={src} alt={media.description ?? 'Live app screenshot'} />
      ) : (
        <div className={`tool-image-state${failed ? ' tool-image-state--error' : ''}`}>
          {failed ? 'Screenshot could not be loaded.' : 'Loading screenshot...'}
        </div>
      )}
      <div className="tool-image-caption">
        <span>{media.description ?? 'Live app screenshot'}</span>
        <span title={media.path}>{media.path.split(/[\\/]/).pop()}</span>
      </div>
    </div>
  )
}

function ArtifactResult({ value }: { value: JsonObject }): JSX.Element | null {
  const artifact = jsonObject(value.artifact)
  if (!artifact) return null
  const path = asText(artifact.path)
  if (!path) return null
  return (
    <div className="tool-artifact">
      <span className="tool-artifact-icon" aria-hidden="true">
        <Codicon name="file" />
      </span>
      <span className="tool-artifact-copy">
        <strong>{asText(value.summary) ?? 'Full result saved to the session'}</strong>
        <span title={path}>{path}</span>
        <small>
          {[formatBytes(artifact.bytes), asText(artifact.format)?.toUpperCase()]
            .filter(Boolean)
            .join(' · ')}
        </small>
      </span>
    </div>
  )
}

function ConsoleResult({ entries }: { entries: unknown[] }): JSX.Element {
  return (
    <div className="tool-friendly-result">
      <div className="tool-result-heading">
        {entries.length} console {entries.length === 1 ? 'message' : 'messages'}
      </div>
      <div className="tool-console-list">
        {entries.map((entry, index) => {
          const item = jsonObject(entry) ?? {}
          const level = asText(item.level) ?? 'log'
          return (
            <div className="tool-console-row" key={asText(item.id) ?? index}>
              <span className={`tool-console-level tool-console-level--${level}`}>{level}</span>
              <span>{asText(item.text) ?? JSON.stringify(entry)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function NetworkResult({ entries }: { entries: unknown[] }): JSX.Element {
  return (
    <div className="tool-friendly-result">
      <div className="tool-result-heading">
        {entries.length} network {entries.length === 1 ? 'request' : 'requests'}
      </div>
      <div className="tool-network-list">
        {entries.map((entry, index) => {
          const item = jsonObject(entry) ?? {}
          const status =
            typeof item.status === 'number' ? item.status : item.ok === false ? 'Failed' : '—'
          return (
            <div className="tool-network-row" key={asText(item.id) ?? index}>
              <span className="tool-network-method">
                {asText(item.method) ?? asText(item.type) ?? 'GET'}
              </span>
              <span
                className={
                  item.ok === false ? 'tool-network-status is-error' : 'tool-network-status'
                }
              >
                {status}
              </span>
              <span className="tool-network-url" title={asText(item.url)}>
                {asText(item.url) ?? 'Unknown URL'}
              </span>
              {typeof item.durationMs === 'number' && (
                <span className="tool-network-duration">{item.durationMs} ms</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function InspectResult({ value }: { value: JsonObject }): JSX.Element {
  const page = jsonObject(value.page) ?? {}
  const elements = Array.isArray(value.elements) ? value.elements : []
  return (
    <div className="tool-friendly-result">
      <div className="tool-result-heading">
        {asText(page.title) ?? 'Live page'} · {elements.length}{' '}
        {elements.length === 1 ? 'element' : 'elements'}
      </div>
      {asText(page.url) && <div className="tool-result-subtle">{asText(page.url)}</div>}
      {asText(value.bodyText) && <p className="tool-page-text">{asText(value.bodyText)}</p>}
    </div>
  )
}

function FriendlyJsonResult({
  tool,
  value
}: {
  tool: ChatToolCall
  value: unknown
}): JSX.Element | null {
  if (tool.name === 'fabricator_preview_console' && Array.isArray(value)) {
    return <ConsoleResult entries={value} />
  }
  if (tool.name === 'fabricator_preview_network' && Array.isArray(value)) {
    return <NetworkResult entries={value} />
  }
  const object = jsonObject(value)
  if (!object) return null
  if (tool.name === 'fabricator_preview_inspect' && object.page) {
    return <InspectResult value={object} />
  }
  const artifact = <ArtifactResult value={object} />
  if (object.artifact) return artifact

  if (tool.name === 'fabricator_deployment_status') {
    const status = jsonObject(object.status)
    const deployed = status?.deployed === true
    return (
      <div className="tool-friendly-result">
        <div className="tool-result-heading">
          {deployed ? 'The app is deployed' : 'The app has not been deployed'}
        </div>
        {deployed && asText(status?.url) && (
          <div className="tool-result-subtle">{asText(status?.url)}</div>
        )}
      </div>
    )
  }

  if (tool.name === 'fabricator_preview_evaluate') {
    const exception = jsonObject(object.exceptionDetails)
    const remote = jsonObject(object.result)
    const resultValue =
      asText(exception?.text) ??
      asText(remote?.description) ??
      (remote?.value === undefined ? undefined : JSON.stringify(remote.value))
    return (
      <div className="tool-friendly-result">
        <div className="tool-result-heading">
          {exception ? 'Page JavaScript threw an exception' : 'Page JavaScript completed'}
        </div>
        {resultValue && <div className="tool-result-subtle">{resultValue}</div>}
      </div>
    )
  }

  if (tool.name === 'fabricator_preview_cdp') {
    const fields = Object.keys(object)
    return (
      <div className="tool-friendly-result">
        <div className="tool-result-heading">{tool.title} completed</div>
        <div className="tool-result-subtle">
          {fields.length
            ? `${fields.length} response ${fields.length === 1 ? 'field' : 'fields'}: ${fields.join(', ')}`
            : 'The browser returned an empty response.'}
        </div>
      </div>
    )
  }

  const summary =
    asText(object.summary) ??
    (typeof object.ok === 'boolean'
      ? object.ok
        ? 'Completed successfully'
        : 'The operation failed'
      : undefined)
  if (!summary) return null
  return (
    <div className="tool-friendly-result">
      <div className="tool-result-heading">{summary}</div>
    </div>
  )
}

function ToolTechnicalDetails({
  tool,
  output,
  initiallyOpen
}: {
  tool: ChatToolCall
  output: string
  initiallyOpen: boolean
}): JSX.Element {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <details
      className="tool-technical"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Technical details</summary>
      {tool.arguments !== undefined && (
        <>
          <div className="tool-technical-label">Input</div>
          <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
        </>
      )}
      {output && (
        <>
          <div className="tool-technical-label">Result</div>
          <pre>{output}</pre>
        </>
      )}
    </details>
  )
}

/**
 * Renders a tool result for people first. Known diagnostic payloads get concise
 * cards, screenshots render as images, and exact JSON remains available under
 * "Technical details" rather than being the only UI.
 */
function ToolOutput({ tool }: { tool: ChatToolCall }): JSX.Element {
  const output = tool.output ?? ''
  const numbered = useMemo(() => parseNumbered(output), [output])
  const parsed = useMemo(() => parseJsonResult(output), [output])
  const kind = toolKind(tool.name)
  const lang =
    kind === 'read' || kind === 'edit' || kind === 'create' ? langFromPath(tool.title) : undefined
  const hl = useMemo(() => (numbered ? highlightCode(numbered.code, lang) : null), [numbered, lang])
  const friendly = parsed !== null ? <FriendlyJsonResult tool={tool} value={parsed} /> : null
  const hasTechnical = Boolean(output || tool.arguments)

  return (
    <div className="tool-result">
      {tool.media?.map((media) => (
        <ToolImage key={media.path} media={media} />
      ))}
      {friendly}
      {numbered ? (
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
      ) : (
        hasTechnical && (
          <ToolTechnicalDetails
            tool={tool}
            output={output}
            initiallyOpen={!friendly && !tool.media?.length}
          />
        )
      )}
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
  const [open, setOpen] = useState(Boolean(t.media?.length))

  useEffect(() => {
    if (t.media?.length) setOpen(true)
  }, [t.media])

  return (
    <details
      className={`tool-call tool-call--${t.state}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
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
      {(t.output || t.media?.length) && <ToolOutput tool={t} />}
    </details>
  )
}

/** Renders a turn's tool-activity list. */
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

/** Compact roll-up chip shown under a completed assistant turn. */
function TurnSummary({ tools }: { tools: ChatToolCall[] }): JSX.Element | null {
  const { parts, total } = useMemo(() => summarizeToolParts(tools), [tools])
  const [expanded, setExpanded] = useState(false)
  if (parts.length === 0) return null

  // A single line is short enough to show inline — no toggle needed.
  if (parts.length === 1) {
    return (
      <div className="turn-summary" title="What this turn did">
        <CheckIcon className="turn-summary-ico" />
        <span className="turn-summary-item">{parts[0]}</span>
      </div>
    )
  }

  // Multiple lines would stack tall and dominate the transcript, so collapse them
  // behind a one-line "Took N actions" toggle that expands to the full breakdown.
  return (
    <div className={`turn-summary turn-summary--collapsible${expanded ? ' is-open' : ''}`}>
      <button
        type="button"
        className="turn-summary-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title="What this turn did"
      >
        <CheckIcon className="turn-summary-ico" />
        <span>
          Took {total} {total === 1 ? 'action' : 'actions'}
        </span>
        <ChevronRightIcon className="turn-summary-caret" />
      </button>
      {expanded && (
        <ul className="turn-summary-list">
          {parts.map((p, i) => (
            <li key={i} className="turn-summary-item">
              {p}
            </li>
          ))}
        </ul>
      )}
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
    const lastIdx = segments.length - 1
    const last = segments[lastIdx]
    const caretAtTail = Boolean(m.pending) && last?.kind === 'text' && last.text.trim().length > 0
    return (
      <div className="turn-feed">
        {segments.map((seg, i) => {
          if (seg.kind === 'text') {
            if (!seg.text.trim()) return null
            return (
              <div key={i} className="msg-text msg-text--md">
                <Markdown>{seg.text}</Markdown>
                {caretAtTail && i === lastIdx && (
                  <span className="stream-caret" aria-hidden="true" />
                )}
              </div>
            )
          }
          if (seg.kind === 'interjection') {
            return (
              <div key={i} className="turn-interject">
                <span className="turn-interject-tag">You added</span>
                <div className="turn-interject-text">
                  <Markdown>{seg.text}</Markdown>
                  {seg.thumbs && seg.thumbs.length > 0 && (
                    <div className="msg-shots">
                      {seg.thumbs.map((src, j) => (
                        <img key={j} className="msg-shot" src={src} alt="Screenshot attachment" />
                      ))}
                    </div>
                  )}
                </div>
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
          {m.pending && m.text.trim().length > 0 && (
            <span className="stream-caret" aria-hidden="true" />
          )}
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
  awaitingDecision,
  startedAt
}: {
  tools: ChatToolCall[]
  hasText: boolean
  notice?: string
  projectPath: string
  awaitingDecision?: boolean
  startedAt?: number
}): JSX.Element {
  // Anchor the timer to the turn's real start time (persisted on the message),
  // not this component's mount time — otherwise remounting (e.g. switching away
  // from and back to the chat tab) would reset the elapsed counter to 0.
  const startRef = useRef(startedAt ?? Date.now())
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - startRef.current) / 1000))
  )
  useEffect(() => {
    if (startedAt != null) startRef.current = startedAt
    const tick = (): void =>
      setElapsed(Math.max(0, Math.floor((Date.now() - startRef.current) / 1000)))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [startedAt])

  if (awaitingDecision) {
    return (
      <div className="agent-status agent-status--await" role="status" aria-live="polite">
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
      <span className="agent-status-label" role="status" aria-live="polite">
        {notice ? (
          <>
            <Codicon name="refresh" /> {label}
          </>
        ) : (
          `${label}…`
        )}
      </span>
      <span className="agent-status-time" aria-hidden="true">
        {mm}:{ss}
      </span>
    </div>
  )
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** Compact, human-readable turn duration: "<1s", "12s", "1m 23s". */
function formatTurnDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? `${m}m ${s}s` : `${m}m`
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
            {expanded ? (
              <>
                <Codicon name="chevron-down" /> Hide full plan
              </>
            ) : (
              <>
                <Codicon name="chevron-right" /> View full plan
              </>
            )}
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

/**
 * Drop the most recent interjection segment matching `text` — used to undo an
 * optimistic steering bubble when the turn finished before it could interject.
 */
function rollbackInterjection(
  segments: ChatSegment[] | undefined,
  text: string
): ChatSegment[] | undefined {
  if (!segments) return segments
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    if (s.kind === 'interjection' && s.text === text) {
      return [...segments.slice(0, i), ...segments.slice(i + 1)]
    }
  }
  return segments
}

/**
 * Settle any tools still `running` to a terminal state. A `tool-end` can be
 * dropped when a turn is interrupted/cancelled mid-command, which would leave
 * its tile spinning forever (settled turns never re-render). Resolving them
 * when the turn ends keeps the UI honest. Returns the same array if nothing
 * was running, so memoized rows keep their identity.
 */
function settleRunningTools(tools: ChatToolCall[], to: 'success' | 'error'): ChatToolCall[] {
  if (!tools.some((t) => t.state === 'running')) return tools
  return tools.map((t) => (t.state === 'running' ? { ...t, state: to } : t))
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
          t.id === ev.id
            ? {
                ...t,
                state: ev.state,
                output: ev.output ?? t.output,
                media: ev.media ?? t.media
              }
            : t
        )
      }
    case 'notice':
      return { ...msg, notice: ev.text }
    case 'error':
      return {
        ...msg,
        error: ev.text,
        pending: false,
        notice: undefined,
        tools: settleRunningTools(msg.tools, 'error'),
        elapsedMs: msg.startedAt ? Date.now() - msg.startedAt : msg.elapsedMs
      }
    case 'result':
      return {
        ...msg,
        pending: false,
        notice: undefined,
        tools: settleRunningTools(msg.tools, ev.ok ? 'success' : 'error'),
        elapsedMs: msg.startedAt ? Date.now() - msg.startedAt : msg.elapsedMs
      }
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

function AgentToolManager({
  settings,
  saving,
  error,
  onChange
}: {
  settings?: AgentToolSettings
  saving: boolean
  error?: string
  onChange: (enabledToolIds: string[]) => void
}): JSX.Element {
  const enabled = useMemo(() => new Set(settings?.enabledToolIds ?? []), [settings])
  const total = settings?.groups.reduce((sum, group) => sum + group.tools.length, 0) ?? 0

  const toggleGroup = (ids: string[]): void => {
    const allEnabled = ids.every((id) => enabled.has(id))
    const next = new Set(enabled)
    for (const id of ids) {
      if (allEnabled) next.delete(id)
      else next.add(id)
    }
    onChange([...next])
  }

  const toggleTool = (id: string): void => {
    const next = new Set(enabled)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }

  return (
    <div className="agent-tools-pop" role="dialog" aria-label="Agent tools">
      <div className="agent-tools-head">
        <span>
          <strong>Agent tools</strong>
          <small>Choose what Fabricator can use in this project.</small>
        </span>
        <span className="agent-tools-count">
          {enabled.size}/{total}
        </span>
      </div>
      {!settings ? (
        <div className="agent-tools-empty">Loading tools...</div>
      ) : (
        <div className="agent-tools-groups">
          {settings.groups.map((group) => {
            const ids = group.tools.map((tool) => tool.id)
            const enabledCount = ids.filter((id) => enabled.has(id)).length
            const checked = enabledCount === ids.length
            const mixed = enabledCount > 0 && !checked
            return (
              <section className="agent-tool-group" key={group.id}>
                <button
                  type="button"
                  className="agent-tool-group-toggle"
                  role="checkbox"
                  aria-checked={mixed ? 'mixed' : checked}
                  disabled={saving}
                  onClick={() => toggleGroup(ids)}
                >
                  <span
                    className={`agent-tool-check${checked || mixed ? ' is-on' : ''}`}
                    aria-hidden="true"
                  >
                    <Codicon name={mixed ? 'remove' : 'check'} />
                  </span>
                  <span>
                    <strong>{group.label}</strong>
                    <small>{group.description}</small>
                  </span>
                </button>
                <div className="agent-tool-items">
                  {group.tools.map((tool) => (
                    <label className="agent-tool-item" key={tool.id}>
                      <input
                        type="checkbox"
                        checked={enabled.has(tool.id)}
                        disabled={saving}
                        onChange={() => toggleTool(tool.id)}
                      />
                      <span>
                        <strong>{tool.label}</strong>
                        <small>{tool.description}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
      {error && <div className="agent-tools-error">{error}</div>}
      <div className="agent-tools-foot">
        {saving
          ? 'Applying changes...'
          : 'Changes apply to the same resumable conversation on the next turn.'}
      </div>
    </div>
  )
}

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

/** A file the composer can reference via @-mention. */
interface MentionFile {
  name: string
  path: string
}

/** Flatten a project file tree to a flat list of files (dirs + ignored dropped). */
function flattenFiles(nodes: FileNode[], out: MentionFile[] = []): MentionFile[] {
  for (const n of nodes) {
    if (n.ignored) continue
    if (n.type === 'file') out.push({ name: n.name, path: n.path })
    else if (n.children) flattenFiles(n.children, out)
  }
  return out
}

/**
 * Rank files for an @-mention query: basename prefix beats basename-substring
 * beats path-substring; ties break toward shorter paths. Empty query lists all.
 */
function rankFiles(files: MentionFile[], query: string): MentionFile[] {
  const q = query.toLowerCase()
  if (!q) return files.slice(0, 8)
  const scored: { f: MentionFile; s: number }[] = []
  for (const f of files) {
    const name = f.name.toLowerCase()
    let s = -1
    if (name.startsWith(q)) s = 0
    else if (name.includes(q)) s = 1
    else if (f.path.toLowerCase().includes(q)) s = 2
    if (s >= 0) scored.push({ f, s })
  }
  scored.sort((a, b) => a.s - b.s || a.f.path.length - b.f.path.length)
  return scored.slice(0, 8).map((x) => x.f)
}

/**
 * One conversation row (assistant or user turn), memoized so the thousands of
 * state updates a streaming turn produces only re-render the *one* turn that
 * changed — completed turns keep their object identity (see `reduce`) and
 * therefore skip re-rendering entirely. Callbacks must be referentially stable
 * (the parent passes `useCallback`-wrapped wrappers) and `canRetry` is a
 * precomputed primitive, so memo's shallow compare holds for settled turns.
 */
const MessageRow = memo(function MessageRow({
  message: m,
  projectPath,
  canRetry,
  onRetry,
  canResume,
  onResume,
  onResolvePlan,
  onOpenMention
}: {
  message: UIChatMessage
  projectPath: string
  canRetry: boolean
  onRetry: (id: string) => void
  canResume: boolean
  onResume: (id: string) => void
  onResolvePlan: (msgId: string, requestId: string, action: string, feedback?: string) => void
  onOpenMention?: (ref: string) => void
}): JSX.Element {
  return (
    <div className={`turn turn--${m.role}`}>
      <div className="turn-head">
        <div className={`turn-avatar${m.pending ? ' turn-avatar--pending' : ''}`}>
          {m.role === 'user' ? <UserIcon /> : <FabricatorMark />}
        </div>
        <div className="turn-role">{m.role === 'user' ? 'You' : 'Fabricator'}</div>
        {m.role === 'assistant' && !m.pending && m.elapsedMs != null && (
          <span className="turn-time" title="Time this turn took">
            <ClockIcon className="turn-time-ico" />
            {formatTurnDuration(m.elapsedMs)}
          </span>
        )}
        {m.role === 'assistant' && Boolean(m.text) && !m.pending && (
          <CopyButton text={m.text} className="turn-copy" />
        )}
        {m.role === 'user' && Boolean(m.text) && m.text !== '(screenshot)' && (
          <CopyButton text={m.text} className="turn-copy" />
        )}
      </div>
      <div className="turn-main">
        {m.role === 'assistant' ? (
          <AssistantBody message={m} projectPath={projectPath} />
        ) : (
          m.text && (
            <div className="msg-text">
              <MentionText text={m.text} onOpen={onOpenMention} />
            </div>
          )
        )}
        {m.role === 'assistant' && !m.pending && !m.error && m.tools.length > 0 && (
          <TurnSummary tools={m.tools} />
        )}
        {m.plan && (
          <PlanCard
            plan={m.plan}
            onResolve={(action, feedback) =>
              onResolvePlan(m.id, m.plan!.requestId, action, feedback)
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
        {m.notice && !m.pending && (
          <div className="msg-notice">
            <Codicon name="refresh" /> {m.notice}
          </div>
        )}
        {m.pending && (
          <AgentStatus
            tools={m.tools}
            hasText={Boolean(m.text)}
            notice={m.notice}
            projectPath={projectPath}
            awaitingDecision={Boolean(m.plan && !m.plan.resolved)}
            startedAt={m.startedAt}
          />
        )}
        {m.error && (
          <div className="alert alert--error msg-error">
            <span className="msg-error-text">{m.error}</span>
            {canRetry && (
              <button
                className="btn btn--xs btn--ghost msg-error-retry"
                onClick={() => onRetry(m.id)}
                title="Re-send this message"
              >
                <Codicon name="refresh" /> Retry
              </button>
            )}
          </div>
        )}
        {m.interrupted && !m.pending && !m.error && (
          <div className="msg-interrupted">
            <span className="msg-interrupted-text">
              This response was interrupted when the app closed.
            </span>
            {canResume && (
              <button
                className="btn btn--xs btn--ghost msg-interrupted-resume"
                onClick={() => onResume(m.id)}
                title="Re-run this prompt and continue"
              >
                ⟲ Resume
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

export default function ChatPanel({
  project,
  messages,
  onChange,
  onTurnComplete,
  attachments,
  onAddAttachment,
  onRemoveAttachment,
  onAttachmentsConsumed,
  onClearHistory,
  onOptionsChanged,
  outbound,
  onOutboundConsumed,
  focused,
  onToggleFocus,
  deployLock = false,
  deploying = false,
  onRequestDeploy,
  modeSelectorEnabled = false,
  onOpenMention,
  draft,
  onDraftChange
}: Props): JSX.Element {
  // The composer draft is seeded from — and mirrored back to — the parent so a
  // typed-but-unsent prompt survives this panel unmounting. Switching to the Code
  // tab and back to Build tears down ChatPanel, and local state alone would be
  // lost (issue #9). The parent keys the draft by project, so each project keeps
  // its own pending prompt.
  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange
  const [input, setInputState] = useState(draft ?? '')
  const setInput = useCallback((next: string | ((prev: string) => string)): void => {
    setInputState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next
      onDraftChangeRef.current?.(value)
      return value
    })
  }, [])
  const [sending, setSending] = useState(false)
  // Recover the in-flight state when the panel remounts mid-turn — switching
  // workbench tabs/projects or a dev hot-reload tears down this component while
  // the backend turn keeps streaming. `messages` is owned by the parent and
  // survives the remount, so a still-pending assistant turn means a turn is
  // genuinely live; without this, `sending` reset to false and the Stop button
  // (plus the Clear / model-switch locks) silently vanished. Completed history
  // hydrates non-pending, so this never sticks after a turn settles.
  const hasLiveTurn = messages.some((m) => m.role === 'assistant' && m.pending)
  useEffect(() => {
    setSending((s) => (s === hasLiveTurn ? s : hasLiveTurn))
  }, [hasLiveTurn])
  const [mode, setMode] = useState<ChatMode>('agent')
  const [model, setModel] = useState(project.model ?? '')
  const [effort, setEffort] = useState<ReasoningEffort | ''>(project.effort ?? '')
  const [showModel, setShowModel] = useState(false)
  const [showMode, setShowMode] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [toolSettings, setToolSettings] = useState<AgentToolSettings>()
  const [toolsSaving, setToolsSaving] = useState(false)
  const [toolsError, setToolsError] = useState<string>()
  const { models, loading: modelsLoading } = useCopilotModels(showModel)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // Referentially-stable wrappers for the per-row callbacks so memoized
  // `MessageRow`s don't re-render every time `retry`/`resolvePlan` are recreated
  // (which happens on each render, e.g. every streamed-token flush). The refs
  // always point at the latest closures, preserving current `messages`/`sending`.
  const retryRef = useRef(retry)
  retryRef.current = retry
  const resumeRef = useRef(resume)
  resumeRef.current = resume
  const resolvePlanRef = useRef(resolvePlan)
  resolvePlanRef.current = resolvePlan
  const onRetry = useCallback((id: string) => void retryRef.current(id), [])
  const onResume = useCallback((id: string) => void resumeRef.current(id), [])
  const onResolvePlan = useCallback(
    (msgId: string, requestId: string, action: string, feedback?: string) =>
      void resolvePlanRef.current(msgId, requestId, action, feedback),
    []
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [jumpNew, setJumpNew] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)
  const [fileList, setFileList] = useState<MentionFile[] | null>(null)
  const [atOpen, setAtOpen] = useState(false)
  const [atStart, setAtStart] = useState(0)
  const [atQuery, setAtQuery] = useState('')
  const [atIdx, setAtIdx] = useState(0)
  const [atDismissed, setAtDismissed] = useState(false)
  const pendingCaret = useRef<number | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const sizerRef = useRef<HTMLDivElement>(null)
  const revealRaf = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [attaching, setAttaching] = useState(false)

  // Keep the caret in view inside the composer's single scrollport
  // (`.composer-input-sizer`). The textarea is sized to its full content height so
  // it never scrolls internally — that is what makes text and the highlight
  // overlay impossible to desync (issue #13). The trade-off is that the browser no
  // longer auto-reveals the caret: it only scrolls a control's own scrollport, not
  // an ancestor. So we nudge the shared scrollport ourselves. This only moves where
  // that one scrollport sits; both layers live inside it, so they always stay
  // aligned. The measurement is batched into an animation frame and gated on the
  // composer actually overflowing, so short prompts pay nothing and fast typing
  // forces at most one reflow per frame.
  const revealCaretSoon = useCallback((): void => {
    if (revealRaf.current != null) return
    revealRaf.current = requestAnimationFrame(() => {
      revealRaf.current = null
      const ta = taRef.current
      const hl = highlightRef.current
      const sizer = sizerRef.current
      if (!ta || !hl || !sizer) return
      if (sizer.scrollHeight - sizer.clientHeight <= 1) return
      const caret = ta.selectionEnd ?? ta.value.length
      // The highlight mirrors the textarea text with identical metrics; mentions
      // add <mark> children, so walk every text node in order to map the caret
      // index (into the raw value) onto a DOM position we can measure.
      const walker = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT)
      let remaining = caret
      let node = walker.nextNode()
      let target: Text | null = null
      let targetOffset = 0
      while (node) {
        const len = node.nodeValue?.length ?? 0
        if (remaining <= len) {
          target = node as Text
          targetOffset = remaining
          break
        }
        remaining -= len
        const next = walker.nextNode()
        if (!next) {
          target = node as Text
          targetOffset = len
          break
        }
        node = next
      }
      if (!target) return
      const range = document.createRange()
      range.setStart(target, targetOffset)
      range.setEnd(target, targetOffset)
      let rect = range.getBoundingClientRect()
      if (rect.height === 0) {
        // A collapsed range can report an empty rect; measure an adjacent glyph.
        const len = target.nodeValue?.length ?? 0
        if (targetOffset < len) range.setEnd(target, targetOffset + 1)
        else if (targetOffset > 0) range.setStart(target, targetOffset - 1)
        rect = range.getBoundingClientRect()
      }
      const sr = sizer.getBoundingClientRect()
      const top = rect.top - sr.top + sizer.scrollTop
      const bottom = rect.bottom - sr.top + sizer.scrollTop
      const viewTop = sizer.scrollTop
      const viewBottom = viewTop + sizer.clientHeight
      if (bottom > viewBottom) sizer.scrollTop = bottom - sizer.clientHeight
      // Snap to the true top when the caret sits on the first line so the field's
      // top padding shows rather than a sliver-scrolled first line.
      else if (top < viewTop) sizer.scrollTop = top <= 12 ? 0 : top
    })
  }, [])

  // Re-reveal after any value change (typing, paste, @-mention insert) — the
  // effect runs once the highlight DOM reflects the new text.
  useEffect(() => {
    revealCaretSoon()
  }, [input, revealCaretSoon])

  useEffect(
    () => () => {
      if (revealRaf.current != null) cancelAnimationFrame(revealRaf.current)
    },
    []
  )
  const fallbackSuggestions = useMemo(
    () => suggestionsFor(project),
    [project.id, project.name, project.template]
  )

  // Copilot-generated starter prompts grounded in the app's code. Only generated
  // while the empty state is shown; falls back to the heuristics above otherwise.
  const {
    suggestions: generatedSuggestions,
    loading: suggestionsLoading,
    refresh: refreshSuggestions
  } = useGeneratedSuggestions(project.id, messages.length === 0)
  const suggestions = generatedSuggestions ?? fallbackSuggestions

  useEffect(() => {
    let active = true
    setToolSettings(undefined)
    setToolsError(undefined)
    void window.api.chat.toolSettings(project.id).then(
      (settings) => {
        if (active) setToolSettings(settings)
      },
      (error) => {
        if (active) setToolsError(error instanceof Error ? error.message : String(error))
      }
    )
    return () => {
      active = false
    }
  }, [project.id, model])

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

  useEffect(() => {
    if (!showTools) return
    const close = (): void => setShowTools(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [showTools])

  useEffect(() => {
    if (sending) setShowTools(false)
  }, [sending])

  async function applyToolSettings(enabledToolIds: string[]): Promise<void> {
    if (!toolSettings || sending || toolsSaving) return
    const previous = toolSettings
    setToolSettings({ ...toolSettings, enabledToolIds })
    setToolsSaving(true)
    setToolsError(undefined)
    try {
      const saved = await window.api.chat.setToolSettings(project.id, enabledToolIds)
      setToolSettings(saved)
      onOptionsChanged?.()
    } catch (error) {
      setToolSettings(previous)
      setToolsError(error instanceof Error ? error.message : String(error))
    } finally {
      setToolsSaving(false)
    }
  }

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

  // Coalesce high-frequency streamed `delta` events. The SDK emits one IPC event
  // per token; applying each individually re-rendered the active turn and re-parsed
  // its markdown thousands of times per reply — the dominant cause of the
  // VM/Parallels "hang". We buffer delta text per turn and flush at most once per
  // animation frame, while structural events (tool/result/plan/error) apply
  // immediately after draining any buffered text so chronological order is kept.
  const deltaBufRef = useRef<Map<string, string>>(new Map())
  const flushRafRef = useRef<number | null>(null)

  useEffect(() => {
    const buf = deltaBufRef.current

    const flush = (): void => {
      flushRafRef.current = null
      if (buf.size === 0) return
      const pending = new Map(buf)
      buf.clear()
      onChangeRef.current((prev) =>
        prev.map((m) => {
          if (m.role !== 'assistant' || !m.turnId) return m
          const text = pending.get(m.turnId)
          return text !== undefined ? reduce(m, { type: 'delta', text }) : m
        })
      )
    }

    const scheduleFlush = (): void => {
      if (flushRafRef.current === null) {
        flushRafRef.current = requestAnimationFrame(flush)
      }
    }

    const off = window.api.onChatEvent((envelope) => {
      if (envelope.projectId !== project.id) return
      const ev = envelope.event
      if (ev.type === 'delta') {
        buf.set(envelope.turnId, (buf.get(envelope.turnId) ?? '') + ev.text)
        scheduleFlush()
        return
      }
      // Structural event: drain buffered text first so deltas land before it.
      flush()
      onChangeRef.current((prev) =>
        prev.map((m) =>
          m.turnId === envelope.turnId && m.role === 'assistant' ? reduce(m, ev) : m
        )
      )
    })

    return () => {
      off()
      if (flushRafRef.current !== null) {
        cancelAnimationFrame(flushRafRef.current)
        flushRafRef.current = null
      }
      buf.clear()
    }
  }, [project.id])

  // Keep the view pinned to the newest content — but only when the user is already
  // near the bottom, so reading earlier messages isn't interrupted. Otherwise we
  // surface a "Jump to latest" affordance instead of yanking them back down. The
  // scroll write is deferred to an animation frame so it batches with the browser's
  // layout instead of forcing a synchronous reflow on every (coalesced) update.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      // Nothing to scroll through — the empty welcome state, a freshly cleared
      // thread, or a conversation short enough to fit — means there is no
      // "latest" to jump to. Re-pin and hide the affordance so a stale
      // scrolled-up state (`stick` left false by a previous conversation, which
      // "Clear" can't reset because the panel instance survives an emptied
      // `messages`) can't strand a phantom "New messages" pill over the welcome
      // screen. The 80px slack mirrors the near-bottom test in onScrollChat.
      const scrollable = messages.length > 0 && el.scrollHeight - el.clientHeight > 80
      if (!scrollable) {
        stick.current = true
        setShowJump(false)
        setJumpNew(false)
        return
      }
      if (!stick.current) {
        setShowJump(true)
        setJumpNew(true)
        return
      }
      setShowJump(false)
      setJumpNew(false)
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [messages])

  function onScrollChat(): void {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = nearBottom
    setShowJump(!nearBottom)
    if (nearBottom) setJumpNew(false)
  }

  function jumpToLatest(): void {
    const el = scrollRef.current
    if (!el) return
    stick.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setShowJump(false)
    setJumpNew(false)
  }

  // Composer auto-grow is handled purely in CSS via `.composer-input-sizer`
  // (a hidden replica in the same grid cell). That container is also the single
  // scrollport shared by the textarea and the highlight overlay, so the two can
  // never scroll out of sync; `revealCaretSoon` (above) keeps the caret visible.

  // Stage one or more images (from the file picker, paste, or drag-drop) as chat
  // attachments — re-encoded to PNG and saved to a temp file, reusing the same
  // pending-attachment flow as annotated screenshots.
  async function stageImages(files: Iterable<File | null | undefined>): Promise<void> {
    if (!onAddAttachment) return
    const images = Array.from(files).filter((f): f is File => !!f && f.type.startsWith('image/'))
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

  function dragHasFiles(e: DragEvent<HTMLDivElement>): boolean {
    return Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === 'file')
  }

  function onComposerDragEnter(e: DragEvent<HTMLDivElement>): void {
    if (!dragHasFiles(e) || sending) return
    e.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }

  function onComposerDragOver(e: DragEvent<HTMLDivElement>): void {
    if (dragHasFiles(e) && !sending) e.preventDefault()
  }

  function onComposerDragLeave(): void {
    if (dragDepth.current === 0) return
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragOver(false)
    }
  }

  async function onComposerDrop(e: DragEvent<HTMLDivElement>): Promise<void> {
    dragDepth.current = 0
    setDragOver(false)
    const all = Array.from(e.dataTransfer?.files ?? [])
    if (all.length === 0) return
    e.preventDefault()
    const images = all.filter((f) => f.type.startsWith('image/'))
    const others = all.filter((f) => !f.type.startsWith('image/'))
    if (images.length > 0) void stageImages(images)
    if (others.length > 0) {
      // Match dropped files to project files by basename and insert references.
      const list = await ensureFiles()
      const refs: string[] = []
      for (const f of others) {
        const hits = list
          .filter((x) => x.name === f.name)
          .sort((a, b) => a.path.length - b.path.length)
        if (hits.length > 0) refs.push(`@${hits[0].path}`)
      }
      if (refs.length > 0) {
        setInput((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${refs.join(' ')} `)
        taRef.current?.focus()
      }
    }
  }

  async function send(): Promise<void> {
    if (deployLock) return
    const text = input.trim()
    const shots = attachments ?? []
    // Mid-turn: interrupt the running reply with this message (conversation
    // steering) instead of waiting for it to finish. Screenshot-only sends are
    // ignored while busy — interjections are about saying something now.
    if (sending) {
      if (!text) return
      setInput('')
      onAttachmentsConsumed?.()
      await steer(text, text, shots)
      return
    }
    if (!text && shots.length === 0) return
    const prompt = text || 'Here is a screenshot of the current preview — please take a look.'
    setInput('')
    onAttachmentsConsumed?.()
    await dispatch(text || '(screenshot)', prompt, shots)
  }

  /**
   * Interject `text` into the turn that's currently streaming. Optimistically
   * shows it inline in the live assistant feed, then asks the backend to deliver
   * it immediately. If the turn happened to finish first (`steered: false`), the
   * optimistic bubble is rolled back and the message is sent as a fresh turn.
   */
  async function steer(displayText: string, prompt: string, shots: PendingShot[]): Promise<void> {
    const liveTurnId = [...messages].reverse().find((m) => m.pending && m.turnId)?.turnId
    const thumbs = shots.length ? shots.map((s) => s.thumb) : undefined
    if (liveTurnId) {
      onChange((prev) =>
        prev.map((m) =>
          m.turnId === liveTurnId && m.pending
            ? {
                ...m,
                segments: [
                  ...(m.segments ?? []),
                  { kind: 'interjection', text: displayText, thumbs }
                ]
              }
            : m
        )
      )
    }
    let steered = true
    try {
      const res = await window.api.chat.steer(
        project.id,
        prompt,
        shots.map((s) => s.path)
      )
      steered = !!res?.steered
    } catch (err) {
      console.error('Failed to steer', err)
      steered = false
    }
    if (!steered) {
      if (liveTurnId) {
        onChange((prev) =>
          prev.map((m) =>
            m.turnId === liveTurnId
              ? { ...m, segments: rollbackInterjection(m.segments, displayText) }
              : m
          )
        )
      }
      await dispatch(displayText, prompt, shots)
    }
  }

  /** Append a fresh turn and stream its result. Shared by send + retry. */
  async function dispatch(
    displayText: string,
    prompt: string,
    shots: PendingShot[]
  ): Promise<void> {
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
      pending: true,
      startedAt: Date.now()
    }
    onChange((prev) => [...prev, userMsg, assistantMsg])
    setSending(true)
    try {
      const result = await window.api.chat.send(
        project.id,
        turnId,
        prompt,
        shots.map((s) => s.path),
        mode
      )
      onChange((prev) =>
        prev.map((m) =>
          m.turnId === turnId
            ? {
                ...m,
                pending: false,
                tools: settleRunningTools(m.tools, 'success'),
                elapsedMs: m.elapsedMs ?? (m.startedAt ? Date.now() - m.startedAt : undefined)
              }
            : m
        )
      )
      onTurnComplete?.(result)
    } finally {
      setSending(false)
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

  /**
   * Resume a turn that was interrupted by the app closing/crashing mid-stream.
   * The preceding user prompt is re-run in place: the stranded (partial)
   * assistant turn is dropped and a fresh one streams in its slot. The backend
   * resumes the same Copilot session, so the agent keeps the prior context.
   */
  async function resume(assistantId: string): Promise<void> {
    if (sending) return
    const idx = messages.findIndex((m) => m.id === assistantId)
    if (idx <= 0) return
    const user = messages[idx - 1]
    if (!user || user.role !== 'user' || user.text === '(screenshot)') return
    const turnId = uid()
    const assistantMsg: UIChatMessage = {
      id: uid(),
      turnId,
      role: 'assistant',
      text: '',
      tools: [],
      segments: [],
      pending: true,
      startedAt: Date.now()
    }
    onChange((prev) => [...prev.filter((m) => m.id !== assistantId), assistantMsg])
    setSending(true)
    try {
      const result = await window.api.chat.send(project.id, turnId, user.text, [], mode)
      onChange((prev) =>
        prev.map((m) =>
          m.turnId === turnId
            ? {
                ...m,
                pending: false,
                tools: settleRunningTools(m.tools, 'success'),
                elapsedMs: m.elapsedMs ?? (m.startedAt ? Date.now() - m.startedAt : undefined)
              }
            : m
        )
      )
      onTurnComplete?.(result)
    } finally {
      setSending(false)
    }
  }

  async function stop(): Promise<void> {
    await window.api.chat.cancel(project.id)
  }

  /** Answer a Plan-mode approval card; optimistically disables its buttons. */
  async function resolvePlan(
    msgId: string,
    requestId: string,
    action: string,
    feedback?: string
  ): Promise<void> {
    onChange((prev) =>
      prev.map((m) =>
        m.id === msgId && m.plan ? { ...m, plan: { ...m.plan, resolved: true } } : m
      )
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
    await window.api.chat.reset(project.id)
    onChange(() => [])
    setMode('agent')
    onClearHistory?.()
  }

  function applySuggestion(text: string): void {
    setInput(text)
    taRef.current?.focus()
  }

  // @-mentions: typing "@" (after whitespace/start) opens a fuzzy file picker;
  // selecting inserts an "@<relative/path>" reference the agent reads as context.
  async function ensureFiles(): Promise<MentionFile[]> {
    if (fileList) return fileList
    try {
      const tree = await window.api.projects.files.tree(project.id)
      const flat = flattenFiles(tree)
      setFileList(flat)
      return flat
    } catch (err) {
      console.error('Failed to load file tree for @-mentions', err)
      setFileList([])
      return []
    }
  }

  /** Recompute the active @-token from the caret; opens/closes the picker. */
  function evalAt(): void {
    const ta = taRef.current
    if (!ta || sending) {
      setAtOpen(false)
      return
    }
    const caret = ta.selectionStart ?? ta.value.length
    const m = /(^|\s)@([^\s@]*)$/.exec(ta.value.slice(0, caret))
    if (!m) {
      setAtOpen(false)
      return
    }
    setAtStart(caret - m[2].length - 1)
    setAtQuery(m[2])
    setAtIdx(0)
    setAtOpen(true)
    void ensureFiles()
  }

  function onComposerChange(e: ChangeEvent<HTMLTextAreaElement>): void {
    setInput(e.target.value)
    setAtDismissed(false)
    evalAt()
  }

  function onComposerSelect(): void {
    revealCaretSoon()
    if (atDismissed) return
    evalAt()
  }

  const atMatches = useMemo(() => {
    if (!atOpen) return []
    return fileList ? rankFiles(fileList, atQuery) : []
  }, [atOpen, fileList, atQuery])
  const atLoading = atOpen && fileList == null
  const atCapture = atOpen && atMatches.length > 0
  const atSel = Math.max(0, Math.min(atIdx, atMatches.length - 1))

  /** Replace the active @-token with a reference to `path`. */
  function pickFile(path: string): void {
    const caret = taRef.current?.selectionStart ?? input.length
    const before = input.slice(0, atStart)
    const after = input.slice(caret)
    const insert = `@${path} `
    setInput(before + insert + after)
    setAtOpen(false)
    setAtDismissed(false)
    pendingCaret.current = before.length + insert.length
  }

  // Restore focus + caret after an @-mention insertion (input is controlled).
  useEffect(() => {
    const c = pendingCaret.current
    if (c == null) return
    pendingCaret.current = null
    const ta = taRef.current
    if (ta) {
      ta.focus()
      ta.setSelectionRange(c, c)
    }
  }, [input])

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (atCapture) {
      const len = atMatches.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtIdx((i) => (Math.max(0, Math.min(i, len - 1)) + 1) % len)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtIdx((i) => (Math.max(0, Math.min(i, len - 1)) - 1 + len) % len)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        pickFile(atMatches[atSel].path)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtDismissed(true)
        setAtOpen(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  // Send a prompt queued from outside (e.g. the status-bar Rayfin upgrade). If a
  // turn is mid-flight we drop it into the composer instead of dropping it. We
  // notify the parent so it clears the one-shot prompt; otherwise it would
  // replay every time this panel remounts (e.g. after switching tabs).
  const handledOutbound = useRef<string | null>(null)
  useEffect(() => {
    if (!outbound || outbound.id === handledOutbound.current) return
    handledOutbound.current = outbound.id
    if (sending && outbound.interrupt) {
      void steer(outbound.display, outbound.prompt, [])
    } else if (sending || outbound.stage) {
      setInput(outbound.prompt)
      taRef.current?.focus()
    } else {
      void dispatch(outbound.display, outbound.prompt, [])
    }
    onOutboundConsumed?.()
  }, [outbound?.id])

  // Precompute the conversation rows so a keystroke in the composer (which only
  // touches local `input` state) doesn't re-run `messages.map` and re-create N
  // <MessageRow> elements. Deps are all stable while typing, so this recomputes
  // only when the conversation actually changes — keeping per-keystroke cost
  // independent of session length.
  const messageList = useMemo(
    () =>
      messages.map((m, i) => {
        const prevUser = m.role === 'assistant' && i > 0 ? messages[i - 1] : undefined
        const rerunnable =
          !sending &&
          prevUser?.role === 'user' &&
          !prevUser.attachments &&
          prevUser.text !== '(screenshot)'
        const canRetry = Boolean(m.error) && rerunnable
        const canResume = Boolean(m.interrupted) && !m.pending && rerunnable
        return (
          <MessageRow
            key={m.id}
            message={m}
            projectPath={project.path}
            canRetry={canRetry}
            onRetry={onRetry}
            canResume={canResume}
            onResume={onResume}
            onResolvePlan={onResolvePlan}
            onOpenMention={onOpenMention}
          />
        )
      }),
    [messages, sending, project.path, onRetry, onResume, onResolvePlan, onOpenMention]
  )

  return (
    <div className="chat">
      <div className="chat-toolbar">
        <div className="seg seg--toolbar">
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
          <button
            className="seg-btn"
            onClick={newChat}
            disabled={sending || messages.length === 0}
            title="Clear this conversation and start fresh"
          >
            <EraserIcon />
            Clear chat
          </button>
        </div>
        <span className="chat-toolbar-spacer" />
      </div>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScrollChat}>
        {messages.length === 0 && (
          <div className="chat-welcome">
            <div className="chat-welcome-badge">
              <FabricatorMark />
            </div>
            <h2 className="chat-welcome-title">Let’s build {project.name}</h2>
            <p className="chat-welcome-sub">
              Describe what you want in plain language — I’ll write the code and deploy it live. No
              coding required.
            </p>
            {suggestionsLoading && !generatedSuggestions && (
              <p className="chat-suggest-status">
                <SparkleIcon className="chat-suggest-status-icon" />
                Tailoring ideas to your app…
              </p>
            )}
            <div
              className="chat-suggestions"
              aria-busy={suggestionsLoading && !generatedSuggestions}
            >
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
            {generatedSuggestions && (
              <button
                className="chat-suggest-refresh"
                onClick={refreshSuggestions}
                title="Generate fresh ideas from your app's code"
              >
                <span className="chat-suggest-refresh-icon" aria-hidden="true">
                  <Codicon name="refresh" />
                </span>
                Refresh ideas
              </button>
            )}
            <p className="chat-welcome-foot">Or just type your own idea below ↓</p>
          </div>
        )}

        {messageList}
        {showJump && messages.length > 0 && (
          <button
            type="button"
            className={`chat-jump${jumpNew ? ' chat-jump--new' : ''}`}
            onClick={jumpToLatest}
            title="Jump to the latest message"
          >
            {jumpNew && <span className="chat-jump-dot" aria-hidden="true" />}
            <span className="chat-jump-label">{jumpNew ? 'New messages' : 'Jump to latest'}</span>
            <span className="chat-jump-arrow" aria-hidden="true">
              ↓
            </span>
          </button>
        )}
      </div>

      <div className={`composer${sending ? ' composer--busy' : ''}`}>
        {deployLock && (
          <div className="deploy-gate" role="status">
            {deploying ? (
              <span className="ws-spinner deploy-gate-spin" aria-hidden="true" />
            ) : (
              <span className="deploy-gate-ico" aria-hidden="true">
                🚀
              </span>
            )}
            <div className="deploy-gate-text">
              <span className="deploy-gate-title">
                {deploying ? 'Deploying your app…' : 'Deploy your app to start building'}
              </span>
              <span className="deploy-gate-sub">
                {deploying
                  ? `Chat unlocks as soon as ${project.name} is live.`
                  : `Chat is locked until ${project.name} has a deployment.`}
              </span>
            </div>
            {deploying ? (
              <button className="btn btn--sm" disabled>
                Deploying…
              </button>
            ) : (
              <button className="btn btn--sm btn--primary" onClick={onRequestDeploy}>
                Deploy now
              </button>
            )}
          </div>
        )}
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
          className={`composer-box${dragOver ? ' composer-box--drag' : ''}`}
          onDrop={onComposerDrop}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
        >
          {dragOver && (
            <div className="composer-drop" aria-hidden="true">
              <ImageIcon className="composer-drop-ico" />
              <span>Drop to attach</span>
            </div>
          )}
          {atOpen && (
            <div className="mention-menu" role="listbox" aria-label="Project files">
              <div className="mention-menu-head">Reference a file</div>
              {atLoading && <div className="mention-empty">Loading files…</div>}
              {!atLoading && atMatches.length === 0 && (
                <div className="mention-empty">No files match “{atQuery}”</div>
              )}
              {atMatches.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  role="option"
                  aria-selected={i === atSel}
                  className={`mention-opt${i === atSel ? ' mention-opt--on' : ''}`}
                  onMouseEnter={() => setAtIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickFile(f.path)
                  }}
                >
                  <span className="codicon codicon-file mention-ico" aria-hidden="true" />
                  <span className="mention-name">{f.name}</span>
                  <span className="mention-path">{f.path}</span>
                </button>
              ))}
            </div>
          )}
          <div className="composer-input-sizer" ref={sizerRef} data-replicated-value={input}>
            <div className="composer-highlight" ref={highlightRef} aria-hidden="true">
              {splitMentions(input).map((p, i) =>
                p.mention ? (
                  <mark key={i} className="composer-mention">
                    {p.text}
                  </mark>
                ) : (
                  <span key={i}>{p.text}</span>
                )
              )}{' '}
            </div>
            <textarea
              ref={taRef}
              className="composer-input"
              placeholder={
                deployLock
                  ? 'Deploy your app to start chatting…'
                  : `Message Fabricator about ${project.name}…`
              }
              value={input}
              rows={1}
              disabled={deployLock}
              onChange={onComposerChange}
              onSelect={onComposerSelect}
              onKeyDown={onKeyDown}
              onPaste={onComposerPaste}
              onFocus={revealCaretSoon}
            />
          </div>
          <div className="composer-actions">
            <div className="composer-left">
              {modeSelectorEnabled && (
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
                    onClick={() => {
                      setShowTools(false)
                      setShowModel(false)
                      setShowMode((s) => !s)
                    }}
                    disabled={sending}
                    aria-haspopup="menu"
                    aria-expanded={showMode}
                    title={currentMode.hint}
                  >
                    <ModeIcon mode={mode} className="mode-trigger-icon" />
                    <span className="mode-trigger-label">{currentMode.label}</span>
                    <span className="mode-trigger-caret">
                      <Codicon name="chevron-down" />
                    </span>
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
                              <Codicon name="check" />
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div
                className="agent-tools-menu"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setShowTools(false)
                }}
              >
                <button
                  type="button"
                  className={`agent-tools-trigger${showTools ? ' agent-tools-trigger--open' : ''}`}
                  title={
                    sending
                      ? 'Agent tools cannot be changed while the assistant is working'
                      : 'Manage agent tools'
                  }
                  aria-label="Manage agent tools"
                  aria-haspopup="dialog"
                  aria-expanded={showTools}
                  disabled={sending || toolsSaving}
                  onClick={() => {
                    setShowModel(false)
                    setShowMode(false)
                    setShowTools((value) => !value)
                  }}
                >
                  <Codicon name="tools" />
                  {toolSettings && (
                    <span className="agent-tools-trigger-count">
                      {toolSettings.enabledToolIds.length}
                    </span>
                  )}
                </button>
                {showTools && (
                  <AgentToolManager
                    settings={toolSettings}
                    saving={toolsSaving}
                    error={toolsError}
                    onChange={(ids) => void applyToolSettings(ids)}
                  />
                )}
              </div>
              <div
                className="chat-model-menu"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setShowModel(false)
                }}
              >
                <button
                  type="button"
                  className={`chat-model-btn${showModel ? ' chat-model-btn--open' : ''}`}
                  title={
                    sending
                      ? 'Model can’t be changed while the assistant is working'
                      : 'Choose the AI model and reasoning effort'
                  }
                  onClick={() => {
                    setShowTools(false)
                    setShowMode(false)
                    setShowModel((s) => !s)
                  }}
                  disabled={sending}
                  aria-haspopup="dialog"
                  aria-expanded={showModel}
                >
                  <SparkleIcon className="chat-model-btn-icon" />
                  <span className="chat-model-btn-label">
                    Model: {selectedModel?.name || model || 'Auto'}
                  </span>
                  <span className="chat-model-btn-caret">
                    <Codicon name="chevron-down" />
                  </span>
                </button>
                {showModel && (
                  <div className="chat-model-pop" role="dialog" aria-label="Model settings">
                    <label className="chat-model-field">
                      <span className="chat-model-field-label">Model</span>
                      <select
                        className="chat-model-input"
                        value={model}
                        autoFocus
                        disabled={sending}
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
                        disabled={sending}
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
              <span className="composer-hint">
                <kbd>Enter</kbd>
                <span>to send</span>
                <span className="composer-hint-sep">·</span>
                <kbd>Shift</kbd>
                <kbd>Enter</kbd>
                <span>for newline</span>
                <span className="composer-hint-sep">·</span>
                <kbd>@</kbd>
                <span>for files</span>
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
                disabled={attaching || deployLock}
                title="Attach an image (or paste / drop one here)"
                aria-label="Attach an image"
              >
                <ImageIcon />
              </button>
              {sending ? (
                <>
                  <button
                    className="composer-send composer-send--interject"
                    onClick={send}
                    disabled={!input.trim()}
                    title="Interject — send this now without waiting"
                    aria-label="Interject this message"
                  >
                    <SendIcon />
                  </button>
                  <button
                    className="composer-send composer-send--stop"
                    onClick={stop}
                    title="Stop generating"
                    aria-label="Stop generating"
                  >
                    <StopIcon />
                  </button>
                </>
              ) : (
                <button
                  className="composer-send"
                  onClick={send}
                  disabled={deployLock || (!input.trim() && (attachments?.length ?? 0) === 0)}
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
