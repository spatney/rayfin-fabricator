import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatEvent, ChatToolCall, ChatTurnResult, StudioProject } from '@shared/ipc'
import type { PendingShot } from './PreviewPane'

export interface UIChatMessage {
  id: string
  turnId?: string
  role: 'user' | 'assistant'
  text: string
  tools: ChatToolCall[]
  pending: boolean
  error?: string
  /** Number of screenshots attached to this (user) message. */
  attachments?: number
}

interface Props {
  project: StudioProject
  messages: UIChatMessage[]
  onChange: (updater: (prev: UIChatMessage[]) => UIChatMessage[]) => void
  /** Called after a turn completes (used later to trigger deploy/preview refresh). */
  onTurnComplete?: (result: ChatTurnResult) => void
  /** Region screenshots staged for the next message. */
  attachments?: PendingShot[]
  /** Remove a staged screenshot (also deletes its temp file). */
  onRemoveAttachment?: (path: string) => void
  /** Called once staged screenshots have been sent so the parent can clear them. */
  onAttachmentsConsumed?: () => void
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function reduce(msg: UIChatMessage, ev: ChatEvent): UIChatMessage {
  switch (ev.type) {
    case 'delta':
      return { ...msg, text: msg.text + ev.text }
    case 'tool-start':
      if (msg.tools.some((t) => t.id === ev.tool.id)) return msg
      return { ...msg, tools: [...msg.tools, ev.tool] }
    case 'tool-end':
      return {
        ...msg,
        tools: msg.tools.map((t) =>
          t.id === ev.id ? { ...t, state: ev.state, output: ev.output ?? t.output } : t
        )
      }
    case 'error':
      return { ...msg, error: ev.text, pending: false }
    case 'result':
      return { ...msg, pending: false }
    default:
      return msg
  }
}

const TOOL_ICON: Record<ChatToolCall['state'], string> = {
  running: '⏳',
  success: '✓',
  error: '✗'
}

export default function ChatPanel({
  project,
  messages,
  onChange,
  onTurnComplete,
  attachments,
  onRemoveAttachment,
  onAttachmentsConsumed
}: Props): JSX.Element {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const off = window.api.onChatEvent((envelope) => {
      if (envelope.projectId !== project.id) return
      onChangeRef.current((prev) =>
        prev.map((m) =>
          m.turnId === envelope.turnId && m.role === 'assistant' ? reduce(m, envelope.event) : m
        )
      )
    })
    return off
  }, [project.id])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  async function send(): Promise<void> {
    const text = input.trim()
    const shots = attachments ?? []
    if ((!text && shots.length === 0) || sending) return
    const prompt = text || 'Here is a screenshot of the current preview — please take a look.'
    const turnId = uid()
    const userMsg: UIChatMessage = {
      id: uid(),
      role: 'user',
      text: text || '(screenshot)',
      tools: [],
      pending: false,
      attachments: shots.length || undefined
    }
    const assistantMsg: UIChatMessage = {
      id: uid(),
      turnId,
      role: 'assistant',
      text: '',
      tools: [],
      pending: true
    }
    onChange((prev) => [...prev, userMsg, assistantMsg])
    setInput('')
    setSending(true)
    onAttachmentsConsumed?.()
    try {
      const result = await window.api.chat.send(
        project.id,
        turnId,
        prompt,
        shots.map((s) => s.path)
      )
      onChange((prev) => prev.map((m) => (m.turnId === turnId ? { ...m, pending: false } : m)))
      onTurnComplete?.(result)
    } finally {
      setSending(false)
    }
  }

  async function stop(): Promise<void> {
    await window.api.chat.cancel(project.id)
  }

  async function newChat(): Promise<void> {
    await window.api.chat.reset(project.id)
    onChange(() => [])
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="chat">
      <div className="chat-toolbar">
        <span className="chat-toolbar-title">Chat</span>
        <button
          className="btn btn--xs btn--ghost"
          onClick={newChat}
          disabled={sending || messages.length === 0}
          title="Start a new conversation"
        >
          New chat
        </button>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>
              Ask Copilot to build or change <strong>{project.name}</strong>. It will edit the code
              and run <code>rayfin up</code> to deploy.
            </p>
            <p className="chat-empty-hint">
              e.g. “Add a page that lists tasks from a new <code>tasks</code> table, then deploy.”
            </p>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role}`}>
            <div className="msg-role">{m.role === 'user' ? 'You' : 'Copilot'}</div>
            {m.tools.length > 0 && (
              <div className="tool-activity">
                {m.tools.map((t) => (
                  <details key={t.id} className={`tool-call tool-call--${t.state}`}>
                    <summary>
                      <span className="tool-call-icon">{TOOL_ICON[t.state]}</span>
                      <span className="tool-call-name">{t.name}</span>
                      <span className="tool-call-title">{t.title}</span>
                    </summary>
                    {t.output && <pre className="tool-call-output">{t.output}</pre>}
                  </details>
                ))}
              </div>
            )}
            {m.text && <div className="msg-text">{m.text}</div>}
            {m.attachments ? (
              <div className="msg-attach">
                ⛶ {m.attachments} screenshot{m.attachments > 1 ? 's' : ''} attached
              </div>
            ) : null}
            {m.pending && !m.text && m.tools.length === 0 && (
              <div className="msg-thinking">Thinking…</div>
            )}
            {m.error && <div className="alert alert--error msg-error">{m.error}</div>}
          </div>
        ))}
      </div>

      <div className="chat-input">
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
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          className="chat-textarea"
          placeholder={`Message Copilot about ${project.name}…`}
          value={input}
          rows={3}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="chat-input-actions">
          <span className="chat-hint">Enter to send · Shift+Enter for newline</span>
          {sending ? (
            <button className="btn btn--sm btn--ghost" onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              className="btn btn--primary btn--sm"
              onClick={send}
              disabled={!input.trim() && (attachments?.length ?? 0) === 0}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
