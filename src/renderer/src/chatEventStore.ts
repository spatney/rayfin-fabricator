import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { reduceChatMessage, type UIChatMessage } from './components/ChatPanel'
import { ChatEventBuffer, isStreamingEvent } from './components/chat/eventCoalescer'
import { writeChatMode } from './chatPlan'

export type ChatStore = Record<string, UIChatMessage[]>

const KEY_SEP = '\u0000'

/**
 * Keep chat event handling mounted at the workbench level. ChatPanel is removed
 * from the tree on Code/Model tabs, but active turns and Plan callbacks continue.
 */
export function useChatEventStore(setChats: Dispatch<SetStateAction<ChatStore>>): void {
  const buffer = useRef(new ChatEventBuffer())
  const flushTimer = useRef<number | null>(null)
  const lastFlush = useRef(0)

  useEffect(() => {
    const FLUSH_INTERVAL_MS = 90
    const buf = buffer.current

    const flush = (): void => {
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current)
        flushTimer.current = null
      }
      lastFlush.current = performance.now()
      if (buf.size === 0) return
      const pending = buf.drain()
      setChats((all) => {
        let next = all
        for (const [key, events] of pending) {
          const [projectId, turnId] = key.split(KEY_SEP)
          const messages = next[projectId]
          if (!messages) continue
          const updated = messages.map((message) =>
            message.role === 'assistant' && message.turnId === turnId
              ? events.reduce(reduceChatMessage, message)
              : message
          )
          if (updated.some((message, index) => message !== messages[index])) {
            next = { ...next, [projectId]: updated }
          }
        }
        return next
      })
    }

    const scheduleFlush = (): void => {
      if (flushTimer.current !== null) return
      const wait = Math.max(0, FLUSH_INTERVAL_MS - (performance.now() - lastFlush.current))
      flushTimer.current = window.setTimeout(flush, wait)
    }

    const off = window.api.onChatEvent((envelope) => {
      const event = envelope.event
      if (isStreamingEvent(event)) {
        buf.push(`${envelope.projectId}${KEY_SEP}${envelope.turnId}`, event)
        scheduleFlush()
        return
      }

      flush()
      setChats((all) => {
        const messages = all[envelope.projectId]
        if (!messages) return all
        if (
          event.type === 'mode-changed' &&
          !messages.some((message) => message.turnId === envelope.turnId && message.designApplyId)
        )
          writeChatMode(envelope.projectId, event.mode)
        let changed = false
        const updated = messages.map((message) => {
          if (message.role !== 'assistant' || message.turnId !== envelope.turnId) return message
          changed = true
          return reduceChatMessage(message, event)
        })
        return changed ? { ...all, [envelope.projectId]: updated } : all
      })
    })

    return () => {
      off()
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current)
        flushTimer.current = null
      }
      buf.clear()
    }
  }, [setChats])
}
