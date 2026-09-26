import type { ChatEvent, ChatPlanQuestion, ChatSegment, ChatToolCall } from '@shared/ipc'
import { reducePlanEvent } from '../../chatPlan'
import type { UIChatMessage } from './types'

/** Longest live output kept for a running tool (the backend already sends a tail). */
const LIVE_OUTPUT_MAX = 8000

/**
 * Finish any reasoning block still streaming, stamping how long it took. Called
 * when the next kind of content starts (text, a step, a question) or the turn
 * ends. Returns the same array when nothing was open.
 */
export function closeReasoning(
  segments: ChatSegment[] | undefined,
  now = Date.now()
): ChatSegment[] | undefined {
  if (!segments?.some((s) => s.kind === 'reasoning' && s.elapsedMs == null)) return segments
  return segments.map((s) =>
    s.kind === 'reasoning' && s.elapsedMs == null
      ? { ...s, elapsedMs: s.startedAt != null ? Math.max(0, now - s.startedAt) : 0 }
      : s
  )
}

/**
 * Append streamed text to the segment list, merging into the trailing text
 * segment when possible so consecutive deltas stay one prose block (tool
 * segments in between naturally split the prose into chronological slices).
 */
export function appendText(segments: ChatSegment[] | undefined, text: string): ChatSegment[] {
  const segs = closeReasoning(segments) ?? []
  const last = segs[segs.length - 1]
  if (last && last.kind === 'text') {
    return [...segs.slice(0, -1), { kind: 'text', text: last.text + text }]
  }
  return [...segs, { kind: 'text', text }]
}

/** Append streamed reasoning, merging into the trailing block with the same id. */
export function appendReasoning(
  segments: ChatSegment[] | undefined,
  id: string,
  text: string,
  now = Date.now()
): ChatSegment[] {
  const segs = segments ?? []
  const last = segs[segs.length - 1]
  if (last && last.kind === 'reasoning' && last.elapsedMs == null && (last.id ?? '') === id) {
    return [...segs.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...(closeReasoning(segs, now) ?? []), { kind: 'reasoning', id, text, startedAt: now }]
}

/**
 * Drop the most recent interjection segment matching `text` — used to undo an
 * optimistic steering bubble when the turn finished before it could interject.
 */
export function rollbackInterjection(
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
export function settleRunningTools(tools: ChatToolCall[], to: 'success' | 'error'): ChatToolCall[] {
  if (!tools.some((t) => t.state === 'running')) return tools
  const now = Date.now()
  return tools.map((t) =>
    t.state === 'running' ? { ...t, state: to, endedAt: t.endedAt ?? now } : t
  )
}

export function reduceChatMessage(msg: UIChatMessage, ev: ChatEvent): UIChatMessage {
  let next: UIChatMessage
  switch (ev.type) {
    case 'delta':
      next = {
        ...msg,
        text: msg.text + ev.text,
        segments: appendText(msg.segments, ev.text),
        notice: undefined
      }
      break
    case 'reasoning':
      next = { ...msg, segments: appendReasoning(msg.segments, ev.id, ev.text), notice: undefined }
      break
    case 'tool-start':
      if (msg.tools.some((t) => t.id === ev.tool.id)) return msg
      next = {
        ...msg,
        tools: [...msg.tools, { ...ev.tool, startedAt: ev.tool.startedAt ?? Date.now() }],
        segments: [...(closeReasoning(msg.segments) ?? []), { kind: 'tool', id: ev.tool.id }],
        notice: undefined
      }
      break
    case 'tool-output': {
      // The backend sends the running tool's current output tail (not a chunk).
      const text = ev.text.length > LIVE_OUTPUT_MAX ? ev.text.slice(-LIVE_OUTPUT_MAX) : ev.text
      if (!msg.tools.some((t) => t.id === ev.id && t.state === 'running' && t.output !== text))
        return msg
      next = {
        ...msg,
        tools: msg.tools.map((t) =>
          t.id === ev.id && t.state === 'running' ? { ...t, output: text } : t
        )
      }
      break
    }
    case 'tool-end':
      next = {
        ...msg,
        tools: msg.tools.map((t) =>
          t.id === ev.id
            ? {
                ...t,
                state: ev.state,
                output: ev.output ?? t.output,
                diff: ev.diff ?? t.diff,
                diffTruncated: ev.diffTruncated ?? t.diffTruncated,
                added: ev.added ?? t.added,
                removed: ev.removed ?? t.removed,
                exitCode: ev.exitCode ?? t.exitCode,
                endedAt: Date.now()
              }
            : t
        )
      }
      break
    case 'notice':
      next = { ...msg, notice: ev.text }
      break
    case 'error':
      next = {
        ...msg,
        error: ev.text,
        pending: false,
        notice: undefined,
        segments: closeReasoning(msg.segments),
        tools: settleRunningTools(msg.tools, 'error'),
        elapsedMs: msg.startedAt ? Date.now() - msg.startedAt : msg.elapsedMs
      }
      break
    case 'result':
      next = {
        ...msg,
        pending: false,
        notice: undefined,
        segments: closeReasoning(msg.segments),
        tools: settleRunningTools(msg.tools, ev.ok ? 'success' : 'error'),
        elapsedMs: msg.startedAt ? Date.now() - msg.startedAt : msg.elapsedMs
      }
      break
    case 'plan-proposed':
    case 'plan-resolved':
    case 'plan-content':
    case 'plan-todos':
    case 'plan-question':
      next = { ...msg, notice: undefined }
      break
    case 'agent-question': {
      // A standalone `ask_user` question from an Agent-mode turn (no Plan card).
      const question: ChatPlanQuestion = {
        id: ev.requestId,
        question: ev.question,
        choices: ev.choices,
        allowFreeform: ev.allowFreeform,
        state: 'pending'
      }
      const existing = msg.questions ?? []
      const idx = existing.findIndex((item) => item.id === ev.requestId)
      const questions =
        idx < 0 ? [...existing, question] : existing.map((item, i) => (i === idx ? question : item))
      // Dock the card where it was asked: anchor it in the chronological feed
      // rather than letting it trail the turn body as more output streams in.
      const segments = (msg.segments ?? []).some(
        (s) => s.kind === 'question' && s.id === ev.requestId
      )
        ? msg.segments
        : [...(closeReasoning(msg.segments) ?? []), { kind: 'question' as const, id: ev.requestId }]
      next = { ...msg, questions, segments, questionError: undefined, notice: undefined }
      break
    }
    case 'plan-question-resolved': {
      // Mark a standalone (Agent-mode) question answered; a Plan-mode question
      // with the same id is handled by reducePlanEvent below.
      const questions = msg.questions?.map((item) =>
        item.id === ev.requestId
          ? { ...item, state: 'answered' as const, answer: ev.answer ?? item.answer }
          : item
      )
      next = { ...msg, questions: questions ?? msg.questions, notice: undefined }
      break
    }
    default:
      next = msg
  }
  const plan = reducePlanEvent(msg.plan, ev, `plan-${msg.id}`)
  return plan === msg.plan ? next : { ...next, plan }
}
