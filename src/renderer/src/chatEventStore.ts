import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { reduceChatMessage, type UIChatMessage } from './components/ChatPanel'
import { writeChatMode } from './chatPlan'

export type ChatStore = Record<string, UIChatMessage[]>

/**
 * Keep chat event handling mounted at the workbench level. ChatPanel is removed
 * from the tree on Code/Model tabs, but active turns and Plan callbacks continue.
 */
export function useChatEventStore(setChats: Dispatch<SetStateAction<ChatStore>>): void {
  const deltaBuffer = useRef<
    Map<string, { projectId: string; turnId: string; text: string }>
  >(new Map())
  const flushTimer = useRef<number | null>(null)
  const lastFlush = useRef(0)

  useEffect(() => {
    const FLUSH_INTERVAL_MS = 90
    const buffer = deltaBuffer.current

    const flush = (): void => {
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current)
        flushTimer.current = null
      }
      lastFlush.current = performance.now()
      if (buffer.size === 0) return
      const pending = Array.from(buffer.values())
      buffer.clear()
      setChats((all) => {
        let next = all
        for (const item of pending) {
          const messages = next[item.projectId]
          if (!messages) continue
          const updated = messages.map((message) =>
            message.role === 'assistant' && message.turnId === item.turnId
              ? reduceChatMessage(message, { type: 'delta', text: item.text })
              : message
          )
          if (updated.some((message, index) => message !== messages[index])) {
            next = { ...next, [item.projectId]: updated }
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
      if (event.type === 'delta') {
        const key = `${envelope.projectId}\u0000${envelope.turnId}`
        const current = buffer.get(key)
        buffer.set(key, {
          projectId: envelope.projectId,
          turnId: envelope.turnId,
          text: (current?.text ?? '') + event.text
        })
        scheduleFlush()
        return
      }

      flush()
      if (event.type === 'mode-changed') writeChatMode(envelope.projectId, event.mode)
      setChats((all) => {
        const messages = all[envelope.projectId]
        if (!messages) return all
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
      buffer.clear()
    }
  }, [setChats])
}
