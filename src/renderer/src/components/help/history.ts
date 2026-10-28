// Saving and restoring the Help conversation.
//
// Help is a troubleshooting surface, so the thread has to outlive the overlay:
// taking an action Help offered usually closes it, and "restart Fabricator" is
// a real fix. Losing the conversation at either moment would be absurd.
//
// What is persisted is deliberately narrower than what is shown. Tool *output*
// is dropped (it is bulky and only interesting live), and a turn that never
// produced an answer is dropped entirely — a question with no reply is noise
// to come back to.
import type { Exchange } from './conversation'

/** Exchanges kept on disk. Older ones fall off the top. */
const MAX_SAVED = 20

/** A restored turn can only be in a settled state; nothing is still running. */
function settledStatus(exchange: Exchange): Exchange['status'] {
  if (exchange.status === 'done' || exchange.status === 'error') return exchange.status
  // Closed or crashed mid-answer: it stopped, whatever it was doing.
  return 'stopped'
}

/** Trim a conversation down to what is worth storing. */
export function toSaved(exchanges: Exchange[]): Exchange[] {
  return exchanges
    .filter((e) => e.answer.trim() || e.status === 'error')
    .slice(-MAX_SAVED)
    .map((e) => ({
      ...e,
      status: settledStatus(e),
      // Keep the step list (so "checked 3 things" still reads) but not the
      // captured output behind it.
      tools: e.tools.map((t) => ({ ...t, output: undefined }))
    }))
}

/**
 * Coerce whatever was on disk back into exchanges, dropping anything that
 * doesn't look like one. The file is ours, but it is still user-writable data
 * on disk, and a malformed entry must not crash the overlay.
 */
export function fromSaved(data: unknown): Exchange[] {
  if (!Array.isArray(data)) return []
  const restored: Exchange[] = []
  for (const row of data) {
    if (!row || typeof row !== 'object') continue
    const e = row as Partial<Exchange>
    if (typeof e.id !== 'string' || typeof e.question !== 'string') continue
    restored.push({
      id: e.id,
      question: e.question,
      attachments: Array.isArray(e.attachments) ? e.attachments.filter((p) => typeof p === 'string') : [],
      answer: typeof e.answer === 'string' ? e.answer : '',
      tools: Array.isArray(e.tools) ? e.tools : [],
      actions: Array.isArray(e.actions) ? e.actions : [],
      citations: Array.isArray(e.citations) ? e.citations : [],
      issue: e.issue && typeof e.issue === 'object' ? e.issue : undefined,
      status: settledStatus(e as Exchange),
      error: typeof e.error === 'string' ? e.error : undefined,
      elapsedMs: typeof e.elapsedMs === 'number' ? e.elapsedMs : undefined,
      restored: true
    })
  }
  return restored.slice(-MAX_SAVED)
}

/**
 * How to describe when a resumed conversation was last touched. Vague on
 * purpose: the point is "this is older", not an audit trail.
 */
export function describeWhen(savedAt: string, now: Date = new Date()): string {
  const then = new Date(savedAt)
  if (Number.isNaN(then.getTime())) return 'earlier'
  const minutes = Math.round((now.getTime() - then.getTime()) / 60000)
  if (minutes < 2) return 'a moment ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 2) return 'an hour ago'
  // Capped at a day by the backend, so "yesterday" is as far as this goes.
  return then.toDateString() === now.toDateString() ? `${hours} hours ago` : 'yesterday'
}
