import type { ChatToolCall } from '@shared/ipc'
import { translator } from '../../i18n'
import { displayPath, looksLikePath, type DisplayPath } from './paths'

/** Coarse classification of a Copilot tool call, used for labels and icons. */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'create'
  | 'delete'
  | 'search'
  | 'find'
  | 'run'
  | 'shell-io'
  | 'web'
  | 'web-search'
  | 'skill'
  | 'todo'
  | 'agent'
  | 'deploy'
  | 'navigate'
  | 'screenshot'
  | 'console'
  | 'scroll'
  | 'model'
  | 'local-status'
  | 'local-call'
  | 'local-seed'
  | 'fabric-iq'
  | 'work-iq'
  | 'mcp'
  | 'other'

/**
 * Tools whose UI lives elsewhere (question cards, the plan card, the status
 * line, the line under an answer). Fabricator's Fabric IQ tool asks on a
 * question card and reports in chat notices; the custom instructions a turn
 * followed show under its answer. Autopilot's `task_complete` ends the run, and
 * its summary is the answer when Copilot said nothing after its last step.
 * (The Rust side keeps the same list as `HIDDEN_STEPS` in commands/chat.rs.)
 */
const HIDDEN_TOOLS = new Set([
  'ask_user',
  'exit_plan_mode',
  'report_intent',
  'task_complete',
  'fabricator_connect_fabric_iq',
  'fabricator_followed_instruction'
])

export function isHiddenTool(name: string): boolean {
  return HIDDEN_TOOLS.has(name.toLowerCase())
}

/** A tool call's kind: a tool of an MCP server you added goes by that, whatever its name. */
export function kindOf(tool: Pick<ChatToolCall, 'name' | 'server'>): ToolKind {
  return tool.server ? 'mcp' : toolKind(tool.name)
}

export function toolKind(name: string): ToolKind {
  const n = name.toLowerCase()
  // Fabric IQ's and Work IQ's tools, named after their MCP servers
  // (FabricIQ-ValueSearch, workiq-fetch): not project searches or web reads.
  if (n.startsWith('fabriciq-')) return 'fabric-iq'
  if (n.startsWith('workiq-')) return 'work-iq'
  // Fabricator's own tools first: their names contain substrings ("cat", "read")
  // that would otherwise be misread.
  if (n.startsWith('fabricator_')) {
    if (n.includes('local_status')) return 'local-status'
    if (n.includes('local_call')) return 'local-call'
    if (n.includes('local_seed')) return 'local-seed'
    if (n.includes('screenshot')) return 'screenshot'
    if (n.includes('navigate')) return 'navigate'
    if (n.includes('deploy')) return 'deploy'
    if (n.includes('console')) return 'console'
    if (n.includes('scroll')) return 'scroll'
    if (n.includes('semantic_model')) return 'model'
    return 'other'
  }
  if (/^(read|write|stop|list)_(powershell|bash|shell)/.test(n)) return 'shell-io'
  if (n.includes('powershell') || n.includes('bash') || n.includes('shell')) return 'run'
  if (n === 'web_search' || n.includes('web_search')) return 'web-search'
  if (n === 'web_fetch' || n.includes('fetch')) return 'web'
  if (n.includes('agent') || n === 'task') return 'agent'
  if (n === 'create' || n === 'write' || n === 'write_file') return 'create'
  if (n === 'apply_patch' || n.includes('edit') || n.includes('str_replace') || n === 'insert')
    return 'edit'
  if (n === 'view' || n === 'read' || n === 'read_file' || /\bcat\b/.test(n)) return 'read'
  if (n === 'glob' || n.includes('find')) return 'find'
  if (n === 'grep' || n === 'rg' || n.includes('search')) return 'search'
  if (n === 'skill') return 'skill'
  if (n === 'sql' || n.includes('todo')) return 'todo'
  if (n.includes('delete') || n.includes('remove')) return 'delete'
  return 'other'
}

/** A verb's catalog keys (the `tools` namespace): while the step runs, and once it's done. */
type VerbKeys = readonly [running: string, done: string]

/** Whether `key` is one of `table`'s own keys (never one it inherits, like "constructor"). */
function own<T extends object>(table: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(table, key)
}

const VERBS = {
  read: ['verbs.read.running', 'verbs.read.done'],
  edit: ['verbs.edit.running', 'verbs.edit.done'],
  create: ['verbs.create.running', 'verbs.create.done'],
  delete: ['verbs.delete.running', 'verbs.delete.done'],
  search: ['verbs.search.running', 'verbs.search.done'],
  find: ['verbs.find.running', 'verbs.find.done'],
  run: ['verbs.run.running', 'verbs.run.done'],
  'shell-io': ['verbs.shellIo.running', 'verbs.shellIo.done'],
  web: ['verbs.web.running', 'verbs.web.done'],
  'web-search': ['verbs.webSearch.running', 'verbs.webSearch.done'],
  skill: ['verbs.skill.running', 'verbs.skill.done'],
  todo: ['verbs.todo.running', 'verbs.todo.done'],
  agent: ['verbs.agent.running', 'verbs.agent.done'],
  deploy: ['verbs.deploy.running', 'verbs.deploy.done'],
  navigate: ['verbs.navigate.running', 'verbs.navigate.done'],
  screenshot: ['verbs.screenshot.running', 'verbs.screenshot.done'],
  console: ['verbs.console.running', 'verbs.console.done'],
  scroll: ['verbs.scroll.running', 'verbs.scroll.done'],
  model: ['verbs.model.running', 'verbs.model.done'],
  'local-status': ['verbs.localStatus.running', 'verbs.localStatus.done'],
  'local-call': ['verbs.localCall.running', 'verbs.localCall.done'],
  'local-seed': ['verbs.localSeed.running', 'verbs.localSeed.done'],
  'fabric-iq': ['verbs.fabricIq.running', 'verbs.fabricIq.done'],
  'work-iq': ['verbs.workIq.running', 'verbs.workIq.done'],
  mcp: ['verbs.mcp.running', 'verbs.mcp.done'],
  other: ['verbs.other.running', 'verbs.other.done']
} as const satisfies Record<ToolKind, VerbKeys>

/** Phrasing for a step with nothing to point at (older transcripts saved no args). */
const BARE_VERBS = {
  read: ['bareVerbs.read.running', 'bareVerbs.read.done'],
  edit: ['bareVerbs.edit.running', 'bareVerbs.edit.done'],
  create: ['bareVerbs.create.running', 'bareVerbs.create.done'],
  delete: ['bareVerbs.delete.running', 'bareVerbs.delete.done'],
  search: ['bareVerbs.search.running', 'bareVerbs.search.done'],
  find: ['bareVerbs.find.running', 'bareVerbs.find.done'],
  run: ['bareVerbs.run.running', 'bareVerbs.run.done'],
  web: ['bareVerbs.web.running', 'bareVerbs.web.done'],
  'web-search': ['bareVerbs.webSearch.running', 'bareVerbs.webSearch.done'],
  skill: ['bareVerbs.skill.running', 'bareVerbs.skill.done'],
  agent: ['bareVerbs.agent.running', 'bareVerbs.agent.done'],
  'local-call': ['bareVerbs.localCall.running', 'bareVerbs.localCall.done']
} as const satisfies Partial<Record<ToolKind, VerbKeys>>

/** Present-tense phrase for the live status line ("Running a command"). */
const PHASES = {
  read: 'phases.read',
  edit: 'phases.edit',
  create: 'phases.create',
  delete: 'phases.delete',
  search: 'phases.search',
  find: 'phases.search',
  run: 'phases.run',
  'shell-io': 'phases.run',
  web: 'phases.web',
  'web-search': 'phases.webSearch',
  skill: 'phases.skill',
  todo: 'phases.todo',
  agent: 'phases.agent',
  deploy: 'phases.deploy',
  navigate: 'phases.navigate',
  screenshot: 'phases.screenshot',
  console: 'phases.console',
  scroll: 'phases.scroll',
  model: 'phases.model',
  'local-status': 'phases.localStatus',
  'local-call': 'phases.localCall',
  'local-seed': 'phases.localSeed',
  'fabric-iq': 'phases.fabricIq',
  'work-iq': 'phases.workIq',
  mcp: 'phases.mcp',
  other: 'phases.other'
} as const satisfies Record<ToolKind, string>

/** The tools that manage agents already started, which delegate nothing new. */
const AGENT_IO_VERBS = {
  read_agent: ['agentIoVerbs.read.running', 'agentIoVerbs.read.done'],
  write_agent: ['agentIoVerbs.write.running', 'agentIoVerbs.write.done'],
  list_agents: ['agentIoVerbs.list.running', 'agentIoVerbs.list.done']
} as const satisfies Record<string, VerbKeys>

/** Present-tense phrase for the live status line; `server` names the MCP server a tool came from. */
export function phaseLabel(name: string, server?: string): string {
  const t = translator('tools')
  if (server) return t('phases.server', { server })
  const lower = name.toLowerCase()
  if (own(AGENT_IO_VERBS, lower)) return t(AGENT_IO_VERBS[lower][0])
  return t(PHASES[toolKind(name)])
}

const SHELL_IO_VERBS = {
  write: ['shellIoVerbs.write.running', 'shellIoVerbs.write.done'],
  stop: ['shellIoVerbs.stop.running', 'shellIoVerbs.stop.done'],
  list: ['shellIoVerbs.list.running', 'shellIoVerbs.list.done']
} as const satisfies Record<string, VerbKeys>

const SEED_LOAD_VERBS = ['seedLoad.running', 'seedLoad.done'] as const satisfies VerbKeys

type StepVerbs =
  | (typeof VERBS)[keyof typeof VERBS]
  | (typeof BARE_VERBS)[keyof typeof BARE_VERBS]
  | (typeof AGENT_IO_VERBS)[keyof typeof AGENT_IO_VERBS]
  | (typeof SHELL_IO_VERBS)[keyof typeof SHELL_IO_VERBS]
  | typeof SEED_LOAD_VERBS

/** What a step's one-line target shows. */
export type StepTarget =
  | { kind: 'path'; path: DisplayPath }
  | { kind: 'quote'; text: string }
  | { kind: 'text'; text: string }

/** Everything a step row needs, derived from a tool call. */
export interface StepView {
  kind: ToolKind
  verb: string
  target?: StepTarget
  /** Additional files touched beyond the target (multi-file patches). */
  moreFiles: number
  added?: number
  removed?: number
  /** A nonzero shell exit code. */
  failedExit?: number
  durationMs?: number
}

function humanize(name: string): string {
  return name
    .replace(/^fabricator_/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
}

function webTarget(title: string): string {
  try {
    const url = new URL(title)
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
    return `${url.hostname.replace(/^www\./, '')}${path}`
  } catch {
    return title
  }
}

export function describeStep(tool: ChatToolCall, projectPath: string): StepView {
  const t = translator('tools')
  const kind = kindOf(tool)
  const running = tool.state === 'running'
  let verbs: StepVerbs = VERBS[kind]
  if (kind === 'shell-io') {
    const io = tool.name.toLowerCase().split('_')[0]
    if (own(SHELL_IO_VERBS, io)) verbs = SHELL_IO_VERBS[io]
  }
  const title = tool.title?.trim() ?? ''
  // The seed tool's title is what it did (see chat_tools.rs).
  if (kind === 'local-seed' && title === 'load') verbs = SEED_LOAD_VERBS
  const hasTitle = title !== '' && title.toLowerCase() !== tool.name.toLowerCase()
  const paths = tool.paths?.length ? tool.paths : hasTitle && looksLikePath(title) ? [title] : []
  let target: StepTarget | undefined
  let moreFiles = 0
  switch (kind) {
    case 'read':
    case 'edit':
    case 'create':
    case 'delete':
      if (paths.length) {
        target = { kind: 'path', path: displayPath(paths[0], projectPath) }
        moreFiles = Math.max(0, paths.length - 1)
      }
      break
    case 'search':
    case 'find':
    case 'web-search':
    case 'fabric-iq':
    case 'work-iq':
      if (hasTitle) target = { kind: 'quote', text: title }
      break
    case 'web':
      if (hasTitle) target = { kind: 'text', text: webTarget(title) }
      break
    case 'mcp':
      target = {
        kind: 'text',
        text: t('label.fromServer', { tool: title || humanize(tool.name), server: tool.server })
      }
      break
    case 'todo':
    case 'shell-io':
    case 'deploy':
    case 'screenshot':
    case 'console':
    case 'scroll':
    case 'local-status':
    case 'local-seed':
      break
    case 'other':
      target = { kind: 'text', text: hasTitle ? title : humanize(tool.name) }
      break
    default:
      if (hasTitle) target = { kind: 'text', text: title }
  }
  const durationMs =
    tool.startedAt != null && tool.endedAt != null && tool.endedAt >= tool.startedAt
      ? tool.endedAt - tool.startedAt
      : undefined
  if (!target && own(BARE_VERBS, kind)) verbs = BARE_VERBS[kind]
  const name = tool.name.toLowerCase()
  if (kind === 'agent' && own(AGENT_IO_VERBS, name)) verbs = AGENT_IO_VERBS[name]
  return {
    kind,
    verb: t(running ? verbs[0] : verbs[1]),
    target,
    moreFiles,
    added: tool.added,
    removed: tool.removed,
    failedExit: tool.exitCode != null && tool.exitCode !== 0 ? tool.exitCode : undefined,
    durationMs
  }
}

/** Plain-text label for a step (tooltips, aria labels, tests). */
export function stepLabel(step: StepView): string {
  const t = translator('tools')
  const at = step.target
  const target = !at
    ? ''
    : at.kind === 'path'
      ? at.path.rel || at.path.base
      : at.kind === 'quote'
        ? t('label.quoted', { text: at.text })
        : at.text
  return target ? t('label.withTarget', { verb: step.verb, target }) : step.verb
}

/** Per-kind counts shown in a work log header. */
export interface KindCount {
  kind: 'read' | 'edit' | 'create' | 'run' | 'search' | 'web'
  count: number
  label: string
}

export function summarizeKinds(tools: readonly ChatToolCall[]): KindCount[] {
  const t = translator('tools')
  const c = { read: 0, edit: 0, create: 0, run: 0, search: 0, web: 0 }
  for (const tool of tools) {
    const k = kindOf(tool)
    if (k === 'read') c.read++
    else if (k === 'edit') c.edit++
    else if (k === 'create') c.create++
    else if (k === 'run') c.run++
    else if (k === 'search' || k === 'find' || k === 'web-search') c.search++
    else if (k === 'web') c.web++
  }
  const out: KindCount[] = []
  if (c.read) out.push({ kind: 'read', count: c.read, label: t('summary.read', { count: c.read }) })
  if (c.edit) out.push({ kind: 'edit', count: c.edit, label: t('summary.edit', { count: c.edit }) })
  if (c.create)
    out.push({ kind: 'create', count: c.create, label: t('summary.create', { count: c.create }) })
  if (c.run) out.push({ kind: 'run', count: c.run, label: t('summary.run', { count: c.run }) })
  if (c.search)
    out.push({ kind: 'search', count: c.search, label: t('summary.search', { count: c.search }) })
  if (c.web) out.push({ kind: 'web', count: c.web, label: t('summary.web', { count: c.web }) })
  return out
}
