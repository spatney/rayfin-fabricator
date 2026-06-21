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
import type { ChatEvent, ChatTurnResult } from '../../shared/ipc'

type Emit = (event: ChatEvent) => void

/** In-flight turns keyed by projectId, so they can be cancelled. */
const inflight = new Map<string, { cancel: () => void }>()

const MAX_TOOL_OUTPUT = 4000

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

/** Send a message to the project's Copilot agent, streaming events via `emit`. */
export async function sendMessage(
  projectId: string,
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
  if (inflight.has(projectId)) {
    emit({ type: 'error', text: 'A message is already being processed for this project.' })
    return { ok: false, error: 'Turn already running.', filesModified: [], ranDeploy: false }
  }

  // One persistent Copilot session per project (created on first message).
  let sessionId = project.copilotSessionId
  if (!sessionId) {
    sessionId = randomUUID()
    updateProject(projectId, { copilotSessionId: sessionId })
  }

  const ctx: TurnContext = {
    filesModified: [],
    ranDeploy: false,
    sawResult: false,
    streamed: new Map()
  }

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

  const args = [
    '-p',
    text,
    '--output-format',
    'json',
    '--session-id',
    sessionId,
    '-C',
    project.path,
    ...attachments.flatMap((a) => ['--attachment', a]),
    '--allow-all',
    '--no-color'
  ]

  const result = await run('copilot', args, {
    cwd: project.path,
    timeout: 20 * 60_000,
    onSpawn: (handle) => inflight.set(projectId, handle),
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
  inflight.delete(projectId)
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

/** Cancel the in-flight turn for a project, if any. */
export function cancelMessage(projectId: string): void {
  inflight.get(projectId)?.cancel()
  inflight.delete(projectId)
}

/** Start a fresh conversation by dropping the persisted session id. */
export function resetSession(projectId: string): void {
  cancelMessage(projectId)
  updateProject(projectId, { copilotSessionId: undefined })
}
