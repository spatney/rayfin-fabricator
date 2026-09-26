import type { ChatEvent } from '@shared/ipc'

/** High-frequency events that are buffered and applied in batches. */
export type StreamingChatEvent = Extract<ChatEvent, { type: 'delta' | 'reasoning' | 'tool-output' }>

export function isStreamingEvent(ev: ChatEvent): ev is StreamingChatEvent {
  return ev.type === 'delta' || ev.type === 'reasoning' || ev.type === 'tool-output'
}

/**
 * Buffers streamed chat events per turn so a burst of tokens re-renders once
 * per flush instead of once per token. Order is kept: consecutive text deltas
 * (or reasoning deltas of one block) merge, and a running tool's newest
 * output replaces its older snapshot.
 */
export class ChatEventBuffer {
  private queues = new Map<string, StreamingChatEvent[]>()

  get size(): number {
    return this.queues.size
  }

  push(key: string, ev: StreamingChatEvent): void {
    const queue = this.queues.get(key) ?? []
    const last = queue[queue.length - 1]
    if (ev.type === 'delta' && last?.type === 'delta') {
      queue[queue.length - 1] = { type: 'delta', text: last.text + ev.text }
    } else if (ev.type === 'reasoning' && last?.type === 'reasoning' && last.id === ev.id) {
      queue[queue.length - 1] = { ...last, text: last.text + ev.text }
    } else if (ev.type === 'tool-output') {
      const i = queue.findIndex((q) => q.type === 'tool-output' && q.id === ev.id)
      if (i >= 0) queue.splice(i, 1)
      queue.push(ev)
    } else {
      queue.push(ev)
    }
    this.queues.set(key, queue)
  }

  /** Remove and return everything buffered, per key, in arrival order. */
  drain(): Map<string, StreamingChatEvent[]> {
    const out = this.queues
    this.queues = new Map()
    return out
  }

  clear(): void {
    this.queues.clear()
  }
}
