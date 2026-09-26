import type { ChatMessage } from '@shared/ipc'

export interface UIChatMessage extends ChatMessage {
  /** Correlates streamed events to the active assistant bubble (live only). */
  turnId?: string
  /** True while the assistant turn is still streaming. */
  pending: boolean
  /**
   * Epoch ms when the assistant turn began (live only). Sourced here rather than
   * from the status component's mount time so the elapsed timer keeps counting
   * correctly after the chat unmounts/remounts (e.g. switching workbench tabs).
   */
  startedAt?: number
  /** Transient status note (e.g. a transient-failure retry); not persisted. */
  notice?: string
  /** Transient error from answering a standalone Agent-mode question; not persisted. */
  questionError?: string
  /** This live turn's authentication error has been resolved by in-app sign-in. */
  authResolved?: boolean
}

/**
 * A prompt queued from outside the chat (e.g. the status-bar "Update with
 * Copilot" hand-off). When a new `id` arrives the panel sends it as a turn —
 * `display` is the user-bubble text, `prompt` is what Copilot actually receives.
 */
export interface OutboundPrompt {
  id: string
  display: string
  prompt: string
  /**
   * When true the prompt is dropped into the composer (and focused) instead of
   * being sent immediately — used to "stage" context (e.g. a slice of history)
   * so the user can append their actual request before sending.
   */
  stage?: boolean
}
