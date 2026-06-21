/**
 * Chat engine: drives the GitHub Copilot CLI as the app's AI agent and maps its
 * JSONL event stream (`-p --output-format json`) into clean ChatEvents for the UI.
 *
 * Integration mode (validated against copilot 1.0.64):
 *  - One-shot per turn: `copilot -p <text> --output-format json --session-id <uuid>
 *    -C <projectDir> --allow-all --no-color`.
 *  - Reusing the same --session-id across turns preserves conversation context, so
 *    each project keeps one persistent session id (stored on the project).
 *  - Streaming text arrives as `assistant.message_delta.deltaContent`; tool activity
 *    as `tool.execution_start|complete`; the closing `result` event carries
 *    `usage.codeChanges.filesModified`.
 */

import { randomUUID } from 'crypto'
import { run } from './exec'
import { findProject, updateProject } from './store'
import { cleanupScreenshots } from './screenshot'
import type { ChatEvent, ChatOptions, ChatTurnResult } from '../../shared/ipc'
import { MAIN_THREAD_ID } from '../../shared/ipc'

type Emit = (event: ChatEvent) => void

/** Composite key so a project's main + side threads run independently. */
function turnKey(projectId: string, threadId: string): string {
  return `${projectId}\u0000${threadId}`
}

/** In-flight turns keyed by project+thread, so they can be cancelled. */
const inflight = new Map<string, { cancel: () => void }>()

/** Keys (project+thread) whose current turn the user explicitly cancelled. */
const cancelled = new Set<string>()

const MAX_TOOL_OUTPUT = 4000

/** Up to this many copilot invocations per turn when a transient pre-work failure occurs. */
const MAX_ATTEMPTS = 3

/** Stderr signatures that indicate a transient, safe-to-retry failure. */
const TRANSIENT_RE =
  /rate.?limit|too many requests|temporar|timeout|etimedout|econnreset|enotfound|socket hang up|network error|503|502|500|overloaded|service unavailable|try again/i

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`
}

/** Derive a one-line summary for a tool call from its arguments. */
function toolTitle(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return toolName
  const a = args as { description?: string; command?: string; path?: string }
  const raw = a.description || a.command || a.path || toolName
  return truncate(String(raw).replace(/\s+/g, ' ').trim(), 200)
}

interface TurnContext {
  filesModified: string[]
  ranDeploy: boolean
  sawResult: boolean
  /** True once any assistant text or tool call occurred (blocks unsafe retries). */
  sawActivity: boolean
  /** Characters of each assistant message already streamed as deltas (dedup). */
  streamed: Map<string, number>
}

/** Map a single parsed Copilot JSON event to ChatEvents. */
function handleEvent(raw: unknown, emit: Emit, ctx: TurnContext): void {
  const ev = raw as { type?: string; data?: Record<string, unknown> } & Record<string, unknown>
  const type = ev.type
  if (!type) return
  const data = (ev.data ?? {}) as Record<string, unknown>

  switch (type) {
    case 'assistant.message_delta': {
      const id = String(data['messageId'] ?? '')
      const text = String(data['deltaContent'] ?? '')
      if (!text) break
      ctx.sawActivity = true
      ctx.streamed.set(id, (ctx.streamed.get(id) ?? 0) + text.length)
      emit({ type: 'delta', text })
      break
    }
    case 'assistant.message': {
      const id = String(data['messageId'] ?? '')
      const content = String(data['content'] ?? '')
      const have = ctx.streamed.get(id) ?? 0
      if (content.length > have) {
        emit({ type: 'delta', text: content.slice(have) })
        ctx.streamed.set(id, content.length)
      }
      break
    }
    case 'tool.execution_start': {
      const toolName = String(data['toolName'] ?? 'tool')
      const args = data['arguments'] as Record<string, unknown> | undefined
      const title = toolTitle(toolName, args)
      const command = args && typeof args['command'] === 'string' ? (args['command'] as string) : ''
      if (/\brayfin\s+up\b/.test(command)) ctx.ranDeploy = true
      ctx.sawActivity = true
      emit({
        type: 'tool-start',
        tool: { id: String(data['toolCallId'] ?? randomUUID()), name: toolName, title, state: 'running' }
      })
      break
    }
    case 'tool.execution_complete': {
      const result = data['result'] as { content?: string } | undefined
      emit({
        type: 'tool-end',
        id: String(data['toolCallId'] ?? ''),
        state: data['success'] ? 'success' : 'error',
        output: result?.content ? truncate(String(result.content), MAX_TOOL_OUTPUT) : undefined
      })
      break
    }
    case 'result': {
      ctx.sawResult = true
      const usage = ev['usage'] as { codeChanges?: { filesModified?: string[] } } | undefined
      const files = usage?.codeChanges?.filesModified
      if (Array.isArray(files)) ctx.filesModified = files
      break
    }
    default:
      break
  }
}

interface ThreadContext {
  cwd: string
  sessionId: string
}

/**
 * Resolve the working directory + Copilot session id for a thread, creating and
 * persisting a session id on first use. Returns null when the project/thread is
 * gone. Model/effort stay project-level (shared across threads).
 */
function resolveContext(projectId: string, threadId: string): ThreadContext | null {
  const project = findProject(projectId)
  if (!project) return null

  if (threadId === MAIN_THREAD_ID) {
    let sessionId = project.copilotSessionId
    if (!sessionId) {
      sessionId = randomUUID()
      updateProject(projectId, { copilotSessionId: sessionId })
    }
    return { cwd: project.path, sessionId }
  }

  const thread = project.threads?.find((t) => t.id === threadId)
  if (!thread) return null
  let sessionId = thread.copilotSessionId
  if (!sessionId) {
    sessionId = randomUUID()
    const sid = sessionId
    const threads = (project.threads ?? []).map((t) =>
      t.id === threadId ? { ...t, copilotSessionId: sid } : t
    )
    updateProject(projectId, { threads })
  }
  return { cwd: thread.worktreePath, sessionId }
}

/** Send a message to a project thread's Copilot agent, streaming via `emit`. */
export async function sendMessage(
  projectId: string,
  threadId: string,
  text: string,
  emit: Emit,
  attachments: string[] = []
): Promise<ChatTurnResult> {
  const project = findProject(projectId)
  if (!project) {
    emit({ type: 'error', text: 'Project not found.' })
    cleanupScreenshots(attachments)
    return { ok: false, error: 'Project not found.', filesModified: [], ranDeploy: false }
  }

  const ctxInfo = resolveContext(projectId, threadId)
  if (!ctxInfo) {
    emit({ type: 'error', text: 'Side thread not found.' })
    cleanupScreenshots(attachments)
    return { ok: false, error: 'Thread not found.', filesModified: [], ranDeploy: false }
  }

  const key = turnKey(projectId, threadId)
  if (inflight.has(key)) {
    emit({ type: 'error', text: 'A message is already being processed for this thread.' })
    return { ok: false, error: 'Turn already running.', filesModified: [], ranDeploy: false }
  }

  const args = [
    '-p',
    text,
    '--output-format',
    'json',
    '--session-id',
    ctxInfo.sessionId,
    '-C',
    ctxInfo.cwd,
    ...(project.model && project.model !== 'auto' ? ['--model', project.model] : []),
    ...(project.effort ? ['--effort', project.effort] : []),
    ...attachments.flatMap((a) => ['--attachment', a]),
    '--allow-all',
    '--no-color'
  ]

  cancelled.delete(key)
  let ctx: TurnContext = newContext()
  let result = await runAttempt(key, args, ctxInfo.cwd, emit, ctx)

  // Retry only when nothing happened yet (no output, no tools, no result) and
  // the failure looks transient — re-running the same prompt is then side-effect free.
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    const retryable =
      !result.notFound &&
      !result.ok &&
      !ctx.sawResult &&
      !ctx.sawActivity &&
      !cancelled.has(key) &&
      TRANSIENT_RE.test(result.stderr || '')
    if (!retryable) break
    emit({ type: 'notice', text: `Copilot CLI hiccup — retrying (${attempt - 1}/${MAX_ATTEMPTS - 1})…` })
    await delay((attempt - 1) * 1000)
    ctx = newContext()
    result = await runAttempt(key, args, ctxInfo.cwd, emit, ctx)
  }

  cleanupScreenshots(attachments)

  if (result.notFound) {
    emit({ type: 'error', text: 'The copilot CLI was not found on PATH.' })
    return { ok: false, error: 'copilot not found', filesModified: [], ranDeploy: ctx.ranDeploy }
  }

  const ok = result.ok && ctx.sawResult
  if (!ok && !ctx.sawResult) {
    const detail = result.stderr.trim() || `copilot exited with code ${result.exitCode ?? 'unknown'}`
    emit({ type: 'error', text: detail })
  }

  emit({ type: 'result', ok, filesModified: ctx.filesModified, ranDeploy: ctx.ranDeploy })
  return {
    ok,
    error: ok ? undefined : 'Turn failed.',
    filesModified: ctx.filesModified,
    ranDeploy: ctx.ranDeploy
  }
}

function newContext(): TurnContext {
  return { filesModified: [], ranDeploy: false, sawResult: false, sawActivity: false, streamed: new Map() }
}

/** Run a single copilot invocation, parsing its JSONL stream into ChatEvents. */
async function runAttempt(
  key: string,
  args: string[],
  cwd: string,
  emit: Emit,
  ctx: TurnContext
): Promise<Awaited<ReturnType<typeof run>>> {
  let buffer = ''
  const flushLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      handleEvent(JSON.parse(trimmed), emit, ctx)
    } catch {
      /* non-JSON line (rare) — ignore */
    }
  }

  const result = await run('copilot', args, {
    cwd,
    timeout: 20 * 60_000,
    onSpawn: (handle) => inflight.set(key, handle),
    onData: (stream, chunk) => {
      if (stream === 'stdout') {
        buffer += chunk
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          flushLine(line)
        }
      }
    }
  })

  if (buffer) flushLine(buffer)
  inflight.delete(key)
  return result
}

/** Cancel the in-flight turn for a project thread, if any. */
export function cancelMessage(projectId: string, threadId: string = MAIN_THREAD_ID): void {
  const key = turnKey(projectId, threadId)
  cancelled.add(key)
  inflight.get(key)?.cancel()
  inflight.delete(key)
}

/** Persist the model / reasoning effort used for a project's chat. */
export function setChatOptions(projectId: string, options: ChatOptions): void {
  const model = options.model?.trim()
  updateProject(projectId, {
    model: model ? model : undefined,
    effort: options.effort
  })
}

/** Start a fresh conversation by dropping the persisted session id. */
export function resetSession(projectId: string, threadId: string = MAIN_THREAD_ID): void {
  cancelMessage(projectId, threadId)
  if (threadId === MAIN_THREAD_ID) {
    updateProject(projectId, { copilotSessionId: undefined })
    return
  }
  const project = findProject(projectId)
  if (!project?.threads) return
  const threads = project.threads.map((t) =>
    t.id === threadId ? { ...t, copilotSessionId: undefined } : t
  )
  updateProject(projectId, { threads })
}
