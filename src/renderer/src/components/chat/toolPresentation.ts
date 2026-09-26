import type { ChatToolCall } from '@shared/ipc'
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
  | 'design'
  | 'other'

/** Tools whose UI lives elsewhere (question cards, the plan card, the status line). */
const HIDDEN_TOOLS = new Set(['ask_user', 'exit_plan_mode', 'report_intent'])

export function isHiddenTool(name: string): boolean {
  return HIDDEN_TOOLS.has(name.toLowerCase())
}

export function toolKind(name: string): ToolKind {
  const n = name.toLowerCase()
  // Fabricator's own tools first: their names contain substrings ("cat", "read")
  // that would otherwise be misread.
  if (n.startsWith('fabricator_')) {
    if (n.includes('screenshot')) return 'screenshot'
    if (n.includes('navigate')) return 'navigate'
    if (n.includes('deploy')) return 'deploy'
    if (n.includes('console')) return 'console'
    if (n.includes('scroll')) return 'scroll'
    if (n.includes('semantic_model')) return 'model'
    if (n.includes('design')) return 'design'
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

const VERBS: Record<ToolKind, [running: string, done: string]> = {
  read: ['Reading', 'Read'],
  edit: ['Editing', 'Edited'],
  create: ['Creating', 'Created'],
  delete: ['Removing', 'Removed'],
  search: ['Searching for', 'Searched for'],
  find: ['Finding files matching', 'Found files matching'],
  run: ['Running', 'Ran'],
  'shell-io': ['Checking on a command', 'Checked on a command'],
  web: ['Reading', 'Read'],
  'web-search': ['Searching the web for', 'Searched the web for'],
  skill: ['Loading the skill', 'Used the skill'],
  todo: ['Updating the task list', 'Updated the task list'],
  agent: ['Delegating', 'Delegated'],
  deploy: ['Deploying the app', 'Deployed the app'],
  navigate: ['Opening in the preview', 'Opened in the preview'],
  screenshot: ['Taking a screenshot', 'Took a screenshot'],
  console: ['Reading the preview console', 'Read the preview console'],
  scroll: ['Scrolling the preview', 'Scrolled the preview'],
  model: ['Looking up a semantic model', 'Looked up a semantic model'],
  design: ['Reporting design changes', 'Reported design changes'],
  other: ['Using', 'Used']
}

/** Phrasing for a step with nothing to point at (older transcripts saved no args). */
const BARE_VERBS: Partial<Record<ToolKind, [running: string, done: string]>> = {
  read: ['Reading a file', 'Read a file'],
  edit: ['Editing files', 'Edited files'],
  create: ['Creating a file', 'Created a file'],
  delete: ['Removing a file', 'Removed a file'],
  search: ['Searching the project', 'Searched the project'],
  find: ['Finding files', 'Found files'],
  run: ['Running a command', 'Ran a command'],
  web: ['Reading a web page', 'Read a web page'],
  'web-search': ['Searching the web', 'Searched the web'],
  skill: ['Loading a skill', 'Used a skill'],
  agent: ['Delegating a task', 'Delegated a task']
}

/** Present-tense phrase for the live status line ("Running a command"). */
const PHASES: Record<ToolKind, string> = {
  read: 'Reading files',
  edit: 'Editing code',
  create: 'Creating files',
  delete: 'Removing files',
  search: 'Searching the project',
  find: 'Searching the project',
  run: 'Running a command',
  'shell-io': 'Running a command',
  web: 'Reading the web',
  'web-search': 'Searching the web',
  skill: 'Loading a skill',
  todo: 'Updating the task list',
  agent: 'Delegating a task',
  deploy: 'Deploying the app',
  navigate: 'Opening the preview',
  screenshot: 'Taking a screenshot',
  console: 'Reading the preview console',
  scroll: 'Scrolling the preview',
  model: 'Looking up a semantic model',
  design: 'Reporting design changes',
  other: 'Working'
}

export function phaseLabel(name: string): string {
  return PHASES[toolKind(name)]
}

const SHELL_IO_VERBS: Record<string, [string, string]> = {
  write: ['Sending input to a command', 'Sent input to a command'],
  stop: ['Stopping a command', 'Stopped a command'],
  list: ['Listing running commands', 'Listed running commands']
}

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
  const kind = toolKind(tool.name)
  const running = tool.state === 'running'
  let [verbRunning, verbDone] = VERBS[kind]
  if (kind === 'shell-io') {
    const io = SHELL_IO_VERBS[tool.name.toLowerCase().split('_')[0]]
    if (io) [verbRunning, verbDone] = io
  }
  const title = tool.title?.trim() ?? ''
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
      if (hasTitle) target = { kind: 'quote', text: title }
      break
    case 'web':
      if (hasTitle) target = { kind: 'text', text: webTarget(title) }
      break
    case 'todo':
    case 'shell-io':
    case 'deploy':
    case 'screenshot':
    case 'console':
    case 'scroll':
    case 'design':
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
  const bare = !target ? BARE_VERBS[kind] : undefined
  if (bare) [verbRunning, verbDone] = bare
  return {
    kind,
    verb: running ? verbRunning : verbDone,
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
  const t = step.target
  const target = !t
    ? ''
    : t.kind === 'path'
      ? t.path.rel || t.path.base
      : t.kind === 'quote'
        ? `“${t.text}”`
        : t.text
  return target ? `${step.verb} ${target}` : step.verb
}

/** Per-kind counts shown in a work log header. */
export interface KindCount {
  kind: 'read' | 'edit' | 'create' | 'run' | 'search' | 'web'
  count: number
  label: string
}

const n = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

export function summarizeKinds(tools: readonly ChatToolCall[]): KindCount[] {
  const c = { read: 0, edit: 0, create: 0, run: 0, search: 0, web: 0 }
  for (const t of tools) {
    const k = toolKind(t.name)
    if (k === 'read') c.read++
    else if (k === 'edit') c.edit++
    else if (k === 'create') c.create++
    else if (k === 'run') c.run++
    else if (k === 'search' || k === 'find' || k === 'web-search') c.search++
    else if (k === 'web') c.web++
  }
  const out: KindCount[] = []
  if (c.read) out.push({ kind: 'read', count: c.read, label: `Read ${n(c.read, 'file', 'files')}` })
  if (c.edit) out.push({ kind: 'edit', count: c.edit, label: `Made ${n(c.edit, 'edit', 'edits')}` })
  if (c.create)
    out.push({ kind: 'create', count: c.create, label: `Created ${n(c.create, 'file', 'files')}` })
  if (c.run)
    out.push({ kind: 'run', count: c.run, label: `Ran ${n(c.run, 'command', 'commands')}` })
  if (c.search)
    out.push({ kind: 'search', count: c.search, label: `Ran ${n(c.search, 'search', 'searches')}` })
  if (c.web)
    out.push({ kind: 'web', count: c.web, label: `Read ${n(c.web, 'web page', 'web pages')}` })
  return out
}
