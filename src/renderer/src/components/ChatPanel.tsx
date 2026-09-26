import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent
} from 'react'
import {
  type ChatMode,
  type ChatPlanArtifact,
  type ChatTurnResult,
  type CopilotAuthStatus,
  type ReasoningEffort,
  type StudioProject
} from '@shared/ipc'
import { isCopilotAuthError } from '../copilotAuth'
import CopilotSignInNotice from './CopilotSignInNotice'
import type { PendingShot } from './PreviewPane'
import { splitMentions } from './MentionText'
import { ExpandIcon, CollapseIcon, CloseIcon, StopIcon, ImageIcon, Codicon } from './icons'
import ConnectModelModal from './ConnectModelModal'
import ConfirmModal from './ConfirmModal'
import { MarkdownLinksContext, type MarkdownLinks } from './Markdown'
import {
  buildRecoveredPlanPrompt,
  createPlanArtifact,
  modeForPlanAction,
  readChatMode,
  setPlanSubmitting,
  shouldSuggestPlanMode,
  writeChatMode
} from '../chatPlan'
import type { OutboundPrompt, UIChatMessage } from './chat/types'
import { suggestionsFor, useGeneratedSuggestions } from './chat/suggestions'
import { ModeIcon, SendIcon } from './chat/icons'
import { AddMenu, ModeMenu, ModelMenu } from './chat/ComposerMenus'
import { Welcome } from './chat/Welcome'
import { uid } from './chat/format'
import { readAsDataUrl, toPngAndThumb } from './chat/images'
import { reduceChatMessage, rollbackInterjection, settleRunningTools } from './chat/reducer'
import { ChatEventBuffer, isStreamingEvent } from './chat/eventCoalescer'
import { flattenFiles, rankFiles, type MentionFile } from './chat/mentions'
import { createFileResolver } from './chat/paths'
import { MessageRow } from './chat/MessageRow'
import { tryAgainPrompt } from './chat/prompts'
import './chat/chat.css'

export type { OutboundPrompt, UIChatMessage } from './chat/types'
export { reduceChatMessage } from './chat/reducer'

interface Props {
  project: StudioProject
  messages: UIChatMessage[]
  onChange: (updater: (prev: UIChatMessage[]) => UIChatMessage[]) => void
  /** Called after a turn completes (used later to trigger deploy/preview refresh). */
  onTurnComplete?: (result: ChatTurnResult) => void
  /** Called when a fresh turn starts (a new send/retry/resume — not an interjection).
   *  Lets the host kick off the live local preview for the turn's duration. */
  onTurnStart?: () => void
  /** Called when a reviewed Plan begins executing within its existing turn.
   *  Lets the host ensure live local preview is running for the edit phase. */
  onPlanExecutionStart?: () => void
  /** Region screenshots staged for the next message. */
  attachments?: PendingShot[]
  /** Stage an image the user added, pasted, or dropped into the composer. */
  onAddAttachment?: (shot: PendingShot) => void
  /** Remove a staged screenshot (also deletes its temp file). */
  onRemoveAttachment?: (path: string) => void
  /** Called once staged screenshots have been sent so the parent can clear them. */
  onAttachmentsConsumed?: () => void
  /** Called when the user starts a new chat (parent clears persisted history). */
  onClearHistory?: () => void
  /** Called after the model / effort options change (parent refreshes project). */
  onOptionsChanged?: () => void
  /** A prompt to send on behalf of the user (e.g. the Rayfin upgrade hand-off). */
  outbound?: OutboundPrompt | null
  /** Called once an outbound prompt has been consumed so the parent can clear it
   * (prevents the one-shot prompt from replaying when the panel remounts). */
  onOutboundConsumed?: () => void
  /** True when chat is expanded to fill the build view (preview hidden). */
  focused?: boolean
  /** Toggle chat focus (full-width chat ⇄ split with preview). */
  onToggleFocus?: () => void
  /** Hard-gate: the project has no deployment yet — disable the composer until it does. */
  deployLock?: boolean
  /** True while the project's first deploy is actively streaming (gate shows progress). */
  deploying?: boolean
  /** When true, a deploy in progress pauses *submitting* a new turn (typing stays
   *  enabled). Used by the live local preview so a turn never overlaps a deploy —
   *  otherwise the dev server can't start during the deploy and never comes back. */
  blockSubmitWhileDeploying?: boolean
  /** Open the fullscreen deploy step (the gate CTA). */
  onRequestDeploy?: () => void
  /** Experimental: show the Agent / Plan / Autopilot mode selector in the composer.
   * When false (the default), the selector is hidden and every turn runs in Agent mode. */
  modeSelectorEnabled?: boolean
  /** The host owns the global chat-event subscription (keeps turns live while this panel is unmounted). */
  eventsManagedExternally?: boolean
  /** A Design Apply owns source editing; keep the composer draft, but don't steer it. */
  externalBusy?: boolean
  /** Open a file referenced by an @-mention chip (path without the leading @). */
  onOpenMention?: (ref: string) => void
  /** The current composer draft. Persisted by the parent (keyed by project) so a
   * typed-but-unsent prompt survives this panel unmounting — e.g. switching to the
   * Code tab and back to Build tears down ChatPanel (issue #9). */
  draft?: string
  /** Called whenever the composer draft changes so the parent can persist it. */
  onDraftChange?: (value: string) => void
  copilotAuth?: CopilotAuthStatus
  onCopilotAuthChanged?: () => Promise<void> | void
}

export default function ChatPanel({
  project,
  messages,
  onChange,
  onTurnComplete,
  onTurnStart,
  onPlanExecutionStart,
  attachments,
  onAddAttachment,
  onRemoveAttachment,
  onAttachmentsConsumed,
  onClearHistory,
  onOptionsChanged,
  outbound,
  onOutboundConsumed,
  focused,
  onToggleFocus,
  deployLock = false,
  deploying = false,
  blockSubmitWhileDeploying = false,
  onRequestDeploy,
  modeSelectorEnabled = false,
  eventsManagedExternally = false,
  externalBusy = false,
  onOpenMention,
  draft,
  onDraftChange,
  copilotAuth,
  onCopilotAuthChanged
}: Props): JSX.Element {
  // The composer draft is seeded from — and mirrored back to — the parent so a
  // typed-but-unsent prompt survives this panel unmounting. Switching to the Code
  // tab and back to Build tears down ChatPanel, and local state alone would be
  // lost (issue #9). The parent keys the draft by project, so each project keeps
  // its own pending prompt.
  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange
  const [input, setInputState] = useState(draft ?? '')
  // The latest draft, so functional updates chain correctly without resolving
  // inside a state updater — the parent's `onDraftChange` must not run while
  // React is computing this component's state.
  const inputRef = useRef(input)
  const setInput = useCallback((next: string | ((prev: string) => string)): void => {
    const value = typeof next === 'function' ? next(inputRef.current) : next
    inputRef.current = value
    setInputState(value)
    onDraftChangeRef.current?.(value)
  }, [])
  const [sending, setSending] = useState(false)
  // Recover the in-flight state when the panel remounts mid-turn — switching
  // workbench tabs/projects or a dev hot-reload tears down this component while
  // the backend turn keeps streaming. `messages` is owned by the parent and
  // survives the remount, so a still-pending assistant turn means a turn is
  // genuinely live; without this, `sending` reset to false and the Stop button
  // (plus the Clear / model-switch locks) silently vanished. Completed history
  // hydrates non-pending, so this never sticks after a turn settles.
  const hasLiveTurn = messages.some((m) => m.role === 'assistant' && m.pending)
  const latestAssistant = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'assistant'),
    [messages]
  )
  const authFailed = Boolean(
    latestAssistant?.turnId && !latestAssistant.authResolved && isCopilotAuthError(latestAssistant.error)
  )
  const needsCopilotSignIn = copilotAuth?.signedIn === false || authFailed
  useEffect(() => {
    setSending((s) => (s === hasLiveTurn ? s : hasLiveTurn))
  }, [hasLiveTurn])
  const [mode, setModeState] = useState<ChatMode>(() => readChatMode(project.id))
  const setMode = useCallback(
    (next: ChatMode): void => {
      setModeState(next)
      writeChatMode(project.id, next)
    },
    [project.id]
  )
  useEffect(() => {
    setModeState(readChatMode(project.id))
  }, [project.id])
  const activeMode: ChatMode = modeSelectorEnabled ? mode : 'agent'
  const [model, setModel] = useState(project.model ?? '')
  const [effort, setEffort] = useState<ReasoningEffort | ''>(project.effort ?? '')
  const [planBusyId, setPlanBusyId] = useState<string | null>(null)
  const [dismissedPlanSuggestion, setDismissedPlanSuggestion] = useState<string | null>(null)
  const [confirmNewChat, setConfirmNewChat] = useState(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // Referentially-stable wrappers for the per-row callbacks so memoized
  // `MessageRow`s don't re-render every time `retry`/`resolvePlan` are recreated
  // (which happens on each render, e.g. every streamed-token flush). The refs
  // always point at the latest closures, preserving current `messages`/`sending`.
  const retryRef = useRef(retry)
  retryRef.current = retry
  const tryAgainRef = useRef(tryAgain)
  tryAgainRef.current = tryAgain
  const resumeRef = useRef(resume)
  resumeRef.current = resume
  const resolvePlanRef = useRef(resolvePlan)
  resolvePlanRef.current = resolvePlan
  const changePlanContentRef = useRef(changePlanContent)
  changePlanContentRef.current = changePlanContent
  const answerPlanQuestionRef = useRef(answerPlanQuestion)
  answerPlanQuestionRef.current = answerPlanQuestion
  const resumePlanRef = useRef(resumePlan)
  resumePlanRef.current = resumePlan
  const exportPlanRef = useRef(exportPlan)
  exportPlanRef.current = exportPlan
  const onRetry = useCallback((id: string) => void retryRef.current(id), [])
  const onTryAgain = useCallback((id: string) => void tryAgainRef.current(id), [])
  const onResume = useCallback((id: string) => void resumeRef.current(id), [])
  const onResolvePlan = useCallback(
    (msgId: string, action: string, feedback?: string) =>
      void resolvePlanRef.current(msgId, action, feedback),
    []
  )
  const onChangePlanContent = useCallback(
    (msgId: string, content: string) => changePlanContentRef.current(msgId, content),
    []
  )
  const onAnswerPlanQuestion = useCallback(
    (msgId: string, requestId: string, answer: string, wasFreeform: boolean) =>
      void answerPlanQuestionRef.current(msgId, requestId, answer, wasFreeform),
    []
  )
  const onResumePlan = useCallback(
    (
      msgId: string,
      kind: 'review' | 'execute' | 'revise',
      action?: string,
      feedback?: string
    ) => void resumePlanRef.current(msgId, kind, action, feedback),
    []
  )
  const onExportPlan = useCallback(
    (msgId: string, content: string) => exportPlanRef.current(msgId, content),
    []
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [jumpNew, setJumpNew] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)
  const [fileList, setFileList] = useState<MentionFile[] | null>(null)
  const knownFiles = useMemo(() => (fileList ? new Set(fileList.map((f) => f.path)) : undefined), [fileList])
  const [atOpen, setAtOpen] = useState(false)
  const [atStart, setAtStart] = useState(0)
  const [atQuery, setAtQuery] = useState('')
  const [atIdx, setAtIdx] = useState(0)
  const [atDismissed, setAtDismissed] = useState(false)
  const pendingCaret = useRef<number | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const sizerRef = useRef<HTMLDivElement>(null)
  const revealRaf = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [attaching, setAttaching] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)

  // Keep the caret in view inside the composer's single scrollport
  // (`.composer-input-sizer`). The textarea is sized to its full content height so
  // it never scrolls internally — that is what makes text and the highlight
  // overlay impossible to desync (issue #13). The trade-off is that the browser no
  // longer auto-reveals the caret: it only scrolls a control's own scrollport, not
  // an ancestor. So we nudge the shared scrollport ourselves. This only moves where
  // that one scrollport sits; both layers live inside it, so they always stay
  // aligned. The measurement is batched into an animation frame and gated on the
  // composer actually overflowing, so short prompts pay nothing and fast typing
  // forces at most one reflow per frame.
  const revealCaretSoon = useCallback((): void => {
    if (revealRaf.current != null) return
    revealRaf.current = requestAnimationFrame(() => {
      revealRaf.current = null
      const ta = taRef.current
      const hl = highlightRef.current
      const sizer = sizerRef.current
      if (!ta || !hl || !sizer) return
      if (sizer.scrollHeight - sizer.clientHeight <= 1) return
      const caret = ta.selectionEnd ?? ta.value.length
      // The highlight mirrors the textarea text with identical metrics; mentions
      // add <mark> children, so walk every text node in order to map the caret
      // index (into the raw value) onto a DOM position we can measure.
      const walker = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT)
      let remaining = caret
      let node = walker.nextNode()
      let target: Text | null = null
      let targetOffset = 0
      while (node) {
        const len = node.nodeValue?.length ?? 0
        if (remaining <= len) {
          target = node as Text
          targetOffset = remaining
          break
        }
        remaining -= len
        const next = walker.nextNode()
        if (!next) {
          target = node as Text
          targetOffset = len
          break
        }
        node = next
      }
      if (!target) return
      const range = document.createRange()
      range.setStart(target, targetOffset)
      range.setEnd(target, targetOffset)
      let rect = range.getBoundingClientRect()
      if (rect.height === 0) {
        // A collapsed range can report an empty rect; measure an adjacent glyph.
        const len = target.nodeValue?.length ?? 0
        if (targetOffset < len) range.setEnd(target, targetOffset + 1)
        else if (targetOffset > 0) range.setStart(target, targetOffset - 1)
        rect = range.getBoundingClientRect()
      }
      const sr = sizer.getBoundingClientRect()
      const top = rect.top - sr.top + sizer.scrollTop
      const bottom = rect.bottom - sr.top + sizer.scrollTop
      const viewTop = sizer.scrollTop
      const viewBottom = viewTop + sizer.clientHeight
      if (bottom > viewBottom) sizer.scrollTop = bottom - sizer.clientHeight
      // Snap to the true top when the caret sits on the first line so the field's
      // top padding shows rather than a sliver-scrolled first line.
      else if (top < viewTop) sizer.scrollTop = top <= 12 ? 0 : top
    })
  }, [])

  // Re-reveal after any value change (typing, paste, @-mention insert) — the
  // effect runs once the highlight DOM reflects the new text.
  useEffect(() => {
    revealCaretSoon()
  }, [input, revealCaretSoon])

  useEffect(
    () => () => {
      if (revealRaf.current != null) cancelAnimationFrame(revealRaf.current)
    },
    []
  )
  const fallbackSuggestions = useMemo(
    () => suggestionsFor(project),
    [project.id, project.name, project.template]
  )

  // Copilot-generated starter prompts grounded in the app's code. Only generated
  // while the empty state is shown; falls back to the heuristics above otherwise.
  const {
    suggestions: generatedSuggestions,
    loading: suggestionsLoading,
    refresh: refreshSuggestions
  } = useGeneratedSuggestions(project.id, messages.length === 0)
  const suggestions = generatedSuggestions ?? fallbackSuggestions

  const showPlanSuggestion =
    modeSelectorEnabled &&
    activeMode === 'agent' &&
    !sending &&
    shouldSuggestPlanMode(input) &&
    !(dismissedPlanSuggestion && input.startsWith(dismissedPlanSuggestion))

  // Persist a model / effort change (the picker already drops an effort the new
  // model can't use).
  function saveOptions(nextModel: string, nextEffort: ReasoningEffort | ''): void {
    setModel(nextModel)
    setEffort(nextEffort)
    void window.api.chat.setOptions(project.id, {
      model: nextModel.trim() || undefined,
      effort: nextEffort || undefined
    })
    onOptionsChanged?.()
  }

  // Coalesce high-frequency streamed events (text / reasoning deltas and live tool
  // output). The SDK emits one IPC event per token; applying each individually
  // re-rendered the active turn and re-parsed its markdown thousands of times per
  // reply — the dominant cause of the VM/Parallels "hang". We buffer them per turn
  // and flush on a fixed time budget (~FLUSH_INTERVAL_MS), not once per animation
  // frame: re-parsing the whole growing markdown bubble is the streaming hot path,
  // so flushing ~11×/s instead of ~60×/s cuts that work several-fold with no
  // visible difference. Structural events (tool/result/plan/error) still apply
  // immediately after draining the buffer so chronological order is kept, and the
  // last chunk always lands (turn-end is a structural event, and anything left
  // flushes on the pending timer).
  const eventBufRef = useRef(new ChatEventBuffer())
  const flushTimerRef = useRef<number | null>(null)
  const lastFlushRef = useRef<number>(0)

  useEffect(() => {
    if (eventsManagedExternally) return
    // Streamed events flush at most once per this interval (ms). Structural events
    // bypass it via an immediate drain, so this only throttles streaming growth.
    const FLUSH_INTERVAL_MS = 90
    const buf = eventBufRef.current

    const flush = (): void => {
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      lastFlushRef.current = performance.now()
      if (buf.size === 0) return
      const pending = buf.drain()
      onChangeRef.current((prev) =>
        prev.map((m) => {
          if (m.role !== 'assistant' || !m.turnId) return m
          const events = pending.get(m.turnId)
          return events ? events.reduce(reduceChatMessage, m) : m
        })
      )
    }

    const scheduleFlush = (): void => {
      if (flushTimerRef.current !== null) return
      const wait = Math.max(0, FLUSH_INTERVAL_MS - (performance.now() - lastFlushRef.current))
      flushTimerRef.current = window.setTimeout(flush, wait)
    }

    const off = window.api.onChatEvent((envelope) => {
      if (envelope.projectId !== project.id) return
      const ev = envelope.event
      if (isStreamingEvent(ev)) {
        buf.push(envelope.turnId, ev)
        scheduleFlush()
        return
      }
      // Structural event: drain buffered events first so they land before it.
      flush()
      if (ev.type === 'mode-changed' && modeSelectorEnabled) setMode(ev.mode)
      onChangeRef.current((prev) =>
        prev.map((m) =>
          m.turnId === envelope.turnId && m.role === 'assistant'
            ? reduceChatMessage(m, ev)
            : m
        )
      )
    })

    return () => {
      off()
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      buf.clear()
    }
  }, [eventsManagedExternally, project.id, modeSelectorEnabled, setMode])

  // Keep the view pinned to the newest content — but only when the user is already
  // near the bottom, so reading earlier messages isn't interrupted. Otherwise we
  // surface a "Jump to latest" affordance instead of yanking them back down. The
  // scroll write is deferred to an animation frame so it batches with the browser's
  // layout instead of forcing a synchronous reflow on every (coalesced) update.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      // Nothing to scroll through — the empty welcome state, a freshly cleared
      // thread, or a conversation short enough to fit — means there is no
      // "latest" to jump to. Re-pin and hide the affordance so a stale
      // scrolled-up state (`stick` left false by a previous conversation, which
      // "Clear" can't reset because the panel instance survives an emptied
      // `messages`) can't strand a phantom "New messages" pill over the welcome
      // screen. The 80px slack mirrors the near-bottom test in onScrollChat.
      const scrollable = messages.length > 0 && el.scrollHeight - el.clientHeight > 80
      if (!scrollable) {
        stick.current = true
        setShowJump(false)
        setJumpNew(false)
        return
      }
      if (!stick.current) {
        setShowJump(true)
        setJumpNew(true)
        return
      }
      setShowJump(false)
      setJumpNew(false)
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [messages])

  function onScrollChat(): void {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = nearBottom
    setShowJump(!nearBottom)
    if (nearBottom) setJumpNew(false)
  }

  function jumpToLatest(): void {
    const el = scrollRef.current
    if (!el) return
    stick.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setShowJump(false)
    setJumpNew(false)
  }

  // Composer auto-grow is handled purely in CSS via `.composer-input-sizer`
  // (a hidden replica in the same grid cell). That container is also the single
  // scrollport shared by the textarea and the highlight overlay, so the two can
  // never scroll out of sync; `revealCaretSoon` (above) keeps the caret visible.

  // Stage one or more images (from the file picker, paste, or drag-drop) as chat
  // attachments — re-encoded to PNG and saved to a temp file, reusing the same
  // pending-attachment flow as annotated screenshots.
  async function stageImages(files: Iterable<File | null | undefined>): Promise<void> {
    if (!onAddAttachment) return
    const images = Array.from(files).filter(
      (f): f is File => !!f && f.type.startsWith('image/')
    )
    if (images.length === 0) return
    setAttaching(true)
    try {
      for (const file of images) {
        const src = await readAsDataUrl(file)
        const { png, thumb } = await toPngAndThumb(src)
        const path = await window.api.screenshot.save(png)
        onAddAttachment({ path, thumb })
      }
    } catch (err) {
      console.error('Failed to attach image', err)
    } finally {
      setAttaching(false)
    }
  }

  function onPickFiles(e: ChangeEvent<HTMLInputElement>): void {
    void stageImages(e.target.files ?? [])
    e.target.value = '' // allow re-selecting the same file
  }

  function onComposerPaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length > 0) {
      e.preventDefault()
      void stageImages(files)
    }
  }

  function dragHasFiles(e: DragEvent<HTMLDivElement>): boolean {
    return Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === 'file')
  }

  function onComposerDragEnter(e: DragEvent<HTMLDivElement>): void {
    if (!dragHasFiles(e) || sending) return
    e.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }

  function onComposerDragOver(e: DragEvent<HTMLDivElement>): void {
    if (dragHasFiles(e) && !sending) e.preventDefault()
  }

  function onComposerDragLeave(): void {
    if (dragDepth.current === 0) return
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragOver(false)
    }
  }

  async function onComposerDrop(e: DragEvent<HTMLDivElement>): Promise<void> {
    dragDepth.current = 0
    setDragOver(false)
    const all = Array.from(e.dataTransfer?.files ?? [])
    if (all.length === 0) return
    e.preventDefault()
    const images = all.filter((f) => f.type.startsWith('image/'))
    const others = all.filter((f) => !f.type.startsWith('image/'))
    if (images.length > 0) void stageImages(images)
    if (others.length > 0) {
      // Match dropped files to project files by basename and insert references.
      const list = await ensureFiles()
      const refs: string[] = []
      for (const f of others) {
        const hits = list
          .filter((x) => x.name === f.name)
          .sort((a, b) => a.path.length - b.path.length)
        if (hits.length > 0) refs.push(`@${hits[0].path}`)
      }
      if (refs.length > 0) {
        setInput((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${refs.join(' ')} `)
        taRef.current?.focus()
      }
    }
  }

  // A deploy in progress pauses *submitting* a new turn (typing stays enabled) when
  // the host asks for it (live local preview). Prevents a turn overlapping a deploy.
  const submitBlocked = deploying && blockSubmitWhileDeploying

  async function send(): Promise<void> {
    if (deployLock || externalBusy) return
    const text = input.trim()
    const shots = attachments ?? []
    // Mid-turn: interrupt the running reply with this message (conversation
    // steering) instead of waiting for it to finish. Screenshot-only sends are
    // ignored while busy — interjections are about saying something now.
    if (sending) {
      if (!text) return
      const awaiting = [...messages]
        .reverse()
        .find(
          (message) =>
            message.pending &&
            (message.plan?.questions.some((question) => question.state === 'pending') ||
              message.questions?.some((question) => question.state === 'pending'))
        )
      const question =
        awaiting?.plan?.questions.find((item) => item.state === 'pending') ??
        awaiting?.questions?.find((item) => item.state === 'pending')
      if (awaiting && question) {
        if (!question.allowFreeform) {
          const errText = awaiting.plan
            ? 'Choose one of the available answers before planning can continue.'
            : 'Choose one of the available answers to continue.'
          if (awaiting.plan) {
            changePlan(awaiting.id, (plan) => ({ ...plan, error: errText }))
          } else {
            onChange((prev) =>
              prev.map((message) =>
                message.id === awaiting.id ? { ...message, questionError: errText } : message
              )
            )
          }
          return
        }
        setInput('')
        await answerPlanQuestion(awaiting.id, question.id, text, true)
        return
      }
      const reviewing = [...messages]
        .reverse()
        .find(
          (message) =>
            message.pending &&
            message.plan?.phase === 'review' &&
            Boolean(message.plan.liveRequestId)
        )
      if (reviewing) {
        setInput('')
        await resolvePlan(reviewing.id, 'keep_planning', text)
        return
      }
      setInput('')
      onAttachmentsConsumed?.()
      await steer(text, shots)
      return
    }
    // Pause a *new* turn while a deploy runs (steering a live turn above is still
    // allowed) so the turn never overlaps the deploy and the local preview can
    // start cleanly once the deploy finishes.
    if (submitBlocked) return
    if (!text && shots.length === 0) return
    const prompt = text || 'Here is a screenshot of the current preview — please take a look.'
    setInput('')
    onAttachmentsConsumed?.()
    await dispatch(text || '(screenshot)', prompt, shots)
  }

  /**
   * Interject `text` into the turn that's currently streaming. Optimistically
   * shows it inline in the live assistant feed, then asks the backend to deliver
   * it immediately. If the turn happened to finish first (`steered: false`), the
   * optimistic bubble is rolled back and the message is sent as a fresh turn.
   */
  async function steer(text: string, shots: PendingShot[]): Promise<void> {
    const liveTurnId = [...messages].reverse().find((m) => m.pending && m.turnId)?.turnId
    const thumbs = shots.length ? shots.map((s) => s.thumb) : undefined
    if (liveTurnId) {
      onChange((prev) =>
        prev.map((m) =>
          m.turnId === liveTurnId && m.pending
            ? { ...m, segments: [...(m.segments ?? []), { kind: 'interjection', text, thumbs }] }
            : m
        )
      )
    }
    let steered = true
    try {
      const res = await window.api.chat.steer(project.id, text, shots.map((s) => s.path))
      steered = !!res?.steered
    } catch (err) {
      console.error('Failed to steer', err)
    }
    if (!steered) {
      if (liveTurnId) {
        onChange((prev) =>
          prev.map((m) =>
            m.turnId === liveTurnId ? { ...m, segments: rollbackInterjection(m.segments, text) } : m
          )
        )
      }
      await dispatch(text, text, shots)
    }
  }

  function finishTurn(turnId: string, result: ChatTurnResult): void {
    onChange((previous) =>
      previous.map((message) =>
        message.turnId === turnId
          ? {
              ...message,
              pending: false,
              error: result.ok ? undefined : message.error ?? result.error,
              tools: settleRunningTools(message.tools, result.ok ? 'success' : 'error'),
              elapsedMs: message.elapsedMs ?? (message.startedAt ? Date.now() - message.startedAt : undefined)
            }
          : message
      )
    )
    onTurnComplete?.(result)
    if (filesRequested.current) void refreshFiles()
  }

  /** Append a fresh turn and stream its result. Shared by send + retry. */
  async function dispatch(
    displayText: string,
    prompt: string,
    shots: PendingShot[],
    modeOverride?: ChatMode,
    initialPlan?: ChatPlanArtifact
  ): Promise<void> {
    if (externalBusy) return
    const turnId = uid()
    const assistantId = uid()
    const sendMode = modeOverride ?? activeMode
    const now = Date.now()
    const userMsg: UIChatMessage = {
      id: uid(),
      role: 'user',
      text: displayText,
      tools: [],
      pending: false,
      createdAt: now,
      attachments: shots.length || undefined,
      attachmentThumbs: shots.length ? shots.map((s) => s.thumb) : undefined
    }
    const assistantMsg: UIChatMessage = {
      id: assistantId,
      turnId,
      role: 'assistant',
      text: '',
      tools: [],
      segments: [],
      pending: true,
      startedAt: now,
      createdAt: now,
      plan:
        initialPlan ??
        (sendMode === 'plan' ? createPlanArtifact(`plan-${assistantId}`) : undefined)
    }
    onChange((prev) => [...prev, userMsg, assistantMsg])
    setSending(true)
    onTurnStart?.()
    try {
      const result = await window.api.chat.send(
        project.id,
        turnId,
        prompt,
        shots.map((s) => s.path),
        sendMode
      )
      finishTurn(turnId, result)
    } catch (error) {
      finishTurn(turnId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        filesModified: [],
        ranDeploy: false
      })
    } finally {
      setSending(false)
    }
  }

  /** Re-send the user prompt that produced a failed assistant turn. */
  async function retry(assistantId: string): Promise<void> {
    if (sending) return
    const idx = messages.findIndex((m) => m.id === assistantId)
    if (idx <= 0) return
    if (messages[idx].designApplyId) return
    const user = messages[idx - 1]
    if (!user || user.role !== 'user' || user.text === '(screenshot)') return
    await dispatch(user.text, user.text, [])
  }

  /** Re-run the latest prompt for a fresh attempt (its context and file changes stay). */
  async function tryAgain(assistantId: string): Promise<void> {
    if (sending || externalBusy || deployLock || submitBlocked) return
    const idx = messages.findIndex((m) => m.id === assistantId)
    if (idx <= 0 || idx !== messages.length - 1) return
    const turn = messages[idx]
    if (turn.pending || turn.plan || turn.designApplyId) return
    const user = messages[idx - 1]
    if (!user || user.role !== 'user' || !user.text || user.text === '(screenshot)') return
    await dispatch(user.text, tryAgainPrompt(user.text), [])
  }

  /**
   * Resume a turn that was interrupted by the app closing/crashing mid-stream.
   * The preceding user prompt is re-run in place: the stranded (partial)
   * assistant turn is dropped and a fresh one streams in its slot. The backend
   * resumes the same Copilot session, so the agent keeps the prior context.
   */
  async function resume(assistantId: string): Promise<void> {
    if (sending) return
    const idx = messages.findIndex((m) => m.id === assistantId)
    if (idx <= 0) return
    if (messages[idx].designApplyId) return
    const user = messages[idx - 1]
    if (!user || user.role !== 'user' || user.text === '(screenshot)') return
    const turnId = uid()
    const now = Date.now()
    const assistantMsg: UIChatMessage = {
      id: uid(),
      turnId,
      role: 'assistant',
      text: '',
      tools: [],
      segments: [],
      pending: true,
      startedAt: now,
      createdAt: now
    }
    onChange((prev) => [...prev.filter((m) => m.id !== assistantId), assistantMsg])
    setSending(true)
    onTurnStart?.()
    try {
      const result = await window.api.chat.send(project.id, turnId, user.text, [], activeMode)
      finishTurn(turnId, result)
    } catch (error) {
      finishTurn(turnId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        filesModified: [],
        ranDeploy: false
      })
    } finally {
      setSending(false)
    }
  }

  async function stop(): Promise<void> {
    await window.api.chat.cancel(project.id)
  }

  function changePlan(
    msgId: string,
    update: (plan: ChatPlanArtifact) => ChatPlanArtifact
  ): void {
    onChange((prev) =>
      prev.map((message) =>
        message.id === msgId && message.plan
          ? { ...message, plan: update(message.plan) }
          : message
      )
    )
  }

  function changePlanContent(msgId: string, content: string): void {
    changePlan(msgId, (plan) => ({ ...plan, content, edited: true, error: undefined }))
  }

  /** Resolve a live SDK plan only after its edited content has been saved successfully. */
  async function resolvePlan(
    msgId: string,
    action: string,
    feedback?: string
  ): Promise<void> {
    const plan = messages.find((message) => message.id === msgId)?.plan
    if (!plan || planBusyId === plan.id) return
    if (!plan.liveRequestId) {
      await resumePlan(
        msgId,
        action === 'keep_planning' ? 'revise' : 'review',
        action === 'keep_planning' ? undefined : action,
        feedback
      )
      return
    }
    setPlanBusyId(plan.id)
    try {
      const editNote = plan.edited
        ? 'The user directly edited the saved plan. Treat that content as authoritative and reconcile the structured todos with it before continuing.'
        : undefined
      const resolutionFeedback = [feedback?.trim(), editNote].filter(Boolean).join('\n\n') || undefined
      await window.api.chat.resolvePlan(
        project.id,
        plan.liveRequestId,
        action,
        plan.content,
        resolutionFeedback
      )
      const revising = action === 'keep_planning'
      const visibleFeedback = revising ? feedback?.trim() : undefined
      onChange((prev) =>
        prev.map((message) =>
          message.id === msgId && message.plan
            ? {
                ...message,
                plan: setPlanSubmitting(message.plan, action, revising),
                segments: visibleFeedback
                  ? [
                      ...(message.segments ?? []),
                      { kind: 'interjection' as const, text: visibleFeedback }
                    ]
                  : message.segments
              }
            : message
        )
      )
      setMode(revising ? 'plan' : modeForPlanAction(action))
      if (!revising && action !== 'exit_only') onPlanExecutionStart?.()
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      changePlan(msgId, (current) => ({ ...current, phase: 'review', error }))
    } finally {
      setPlanBusyId(null)
    }
  }

  async function answerPlanQuestion(
    msgId: string,
    requestId: string,
    answer: string,
    wasFreeform: boolean
  ): Promise<void> {
    const message = messages.find((item) => item.id === msgId)
    if (!message) return
    const inPlan = message.plan?.questions.some((q) => q.id === requestId) ?? false
    const inStandalone = message.questions?.some((q) => q.id === requestId) ?? false
    if (!inPlan && !inStandalone) return
    // Plan questions track busy by the plan id; standalone questions by the
    // message id (plan ids are `plan-${msgId}`, so the two never collide).
    const busyKey = inPlan ? message.plan!.id : msgId
    if (planBusyId === busyKey) return
    setPlanBusyId(busyKey)
    try {
      await window.api.chat.resolveQuestion(requestId, answer, wasFreeform)
      onChange((prev) =>
        prev.map((item) => {
          if (item.id !== msgId) return item
          let updated = item
          if (item.plan?.questions.some((q) => q.id === requestId)) {
            updated = {
              ...updated,
              plan: {
                ...item.plan,
                phase: item.plan.content ? 'drafting' : 'researching',
                error: undefined,
                questions: item.plan.questions.map((question) =>
                  question.id === requestId
                    ? { ...question, state: 'answered', answer, wasFreeform }
                    : question
                )
              }
            }
          }
          if (item.questions?.some((q) => q.id === requestId)) {
            updated = {
              ...updated,
              questionError: undefined,
              questions: item.questions.map((question) =>
                question.id === requestId
                  ? { ...question, state: 'answered', answer, wasFreeform }
                  : question
              )
            }
          }
          return updated
        })
      )
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (inPlan) {
        changePlan(msgId, (current) => ({ ...current, error }))
      } else {
        onChange((prev) =>
          prev.map((item) => (item.id === msgId ? { ...item, questionError: error } : item))
        )
      }
    } finally {
      setPlanBusyId(null)
    }
  }

  async function resumePlan(
    msgId: string,
    kind: 'review' | 'execute' | 'revise',
    action?: string,
    feedback?: string
  ): Promise<void> {
    if (sending) return
    const idx = messages.findIndex((message) => message.id === msgId)
    const message = idx >= 0 ? messages[idx] : undefined
    const original = idx > 0 && messages[idx - 1]?.role === 'user' ? messages[idx - 1].text : ''
    const plan = message?.plan
    if (!plan) return

    const selectedAction = action ?? plan.selectedAction ?? plan.recommendedAction ?? 'interactive'
    if (kind === 'review' && selectedAction === 'exit_only' && plan.content.trim()) {
      changePlan(msgId, (current) => ({
        ...current,
        phase: 'completed',
        selectedAction,
        error: undefined
      }))
      setMode('agent')
      return
    }

    const continuePlanning = kind === 'review' && !plan.content.trim()
    const promptKind =
      kind === 'revise' ? 'revise' : continuePlanning ? 'review' : 'execute'
    const sendMode: ChatMode =
      promptKind === 'revise' || promptKind === 'review'
        ? 'plan'
        : modeForPlanAction(selectedAction)
    const phase =
      promptKind === 'execute' ? 'executing' : promptKind === 'revise' ? 'revising' : 'researching'
    const recovered: ChatPlanArtifact = {
      ...plan,
      phase,
      selectedAction: promptKind === 'execute' ? selectedAction : undefined,
      liveRequestId: undefined,
      error: undefined
    }
    const prompt = buildRecoveredPlanPrompt(recovered, original, promptKind, feedback)
    const display =
      promptKind === 'execute'
        ? 'Resume the approved plan'
        : promptKind === 'revise'
          ? feedback?.trim() || 'Revise the recovered plan'
          : 'Resume planning'

    // Move the durable artifact to the new continuation turn so future SDK
    // snapshots update one active card rather than leaving a stale duplicate.
    onChange((prev) =>
      prev.map((item) =>
        item.id === msgId ? { ...item, plan: undefined, interrupted: undefined } : item
      )
    )
    setMode(sendMode)
    await dispatch(display, prompt, [], sendMode, recovered)
  }

  async function exportPlan(msgId: string, content: string): Promise<void> {
    const plan = messages.find((message) => message.id === msgId)?.plan
    if (!plan || planBusyId === plan.id) return
    setPlanBusyId(plan.id)
    try {
      await window.api.chat.exportPlan(`${project.name}-plan`, content)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      changePlan(msgId, (current) => ({ ...current, error }))
    } finally {
      setPlanBusyId(null)
    }
  }

  async function newChat(): Promise<void> {
    setConfirmNewChat(false)
    await window.api.chat.reset(project.id)
    onChange(() => [])
    setMode('agent')
    onClearHistory?.()
  }

  function applySuggestion(text: string): void {
    setInput(text)
    taRef.current?.focus()
  }

  /** Insert an "@" at the caret and open the file picker (the "+" menu's "Reference a file"). */
  function insertMention(): void {
    const caret = taRef.current?.selectionStart ?? input.length
    const before = input.slice(0, caret)
    const lead = before && !/\s$/.test(before) ? ' ' : ''
    setInput(`${before}${lead}@${input.slice(caret)}`)
    pendingCaret.current = before.length + lead.length + 1
    setAtStart(before.length + lead.length)
    setAtQuery('')
    setAtIdx(0)
    setAtDismissed(false)
    setAtOpen(true)
    void ensureFiles()
  }

  // @-mentions: typing "@" (after whitespace/start) opens a fuzzy file picker;
  // selecting inserts an "@<relative/path>" reference the agent reads as context.
  async function ensureFiles(): Promise<MentionFile[]> {
    if (fileList) return fileList
    try {
      const tree = await window.api.projects.files.tree(project.id)
      const flat = flattenFiles(tree)
      setFileList(flat)
      return flat
    } catch (err) {
      console.error('Failed to load file tree for @-mentions', err)
      setFileList([])
      return []
    }
  }

  // Re-read the file list in the background (the agent may have added files),
  // keeping the current list until the new one arrives so links don't flicker.
  const refreshFiles = useCallback(async (): Promise<void> => {
    try {
      setFileList(flattenFiles(await window.api.projects.files.tree(project.id)))
    } catch {
      /* keep the list we have */
    }
  }, [project.id])

  // Once there's a conversation, load the file list so file paths the agent
  // mentions can link to the Code tab.
  const hasMessages = messages.length > 0
  const filesRequested = useRef(false)
  useEffect(() => {
    if (!hasMessages || filesRequested.current) return
    filesRequested.current = true
    void ensureFiles()
  }, [hasMessages])

  const markdownLinks = useMemo<MarkdownLinks | null>(() => {
    if (!onOpenMention || !fileList?.length) return null
    return {
      resolveFile: createFileResolver(
        fileList.map((f) => f.path),
        project.path
      ),
      openFile: (path) => onOpenMention(path)
    }
  }, [fileList, onOpenMention, project.path])

  /** Recompute the active @-token from the caret; opens/closes the picker. */
  function evalAt(): void {
    const ta = taRef.current
    if (!ta || sending) {
      setAtOpen(false)
      return
    }
    const caret = ta.selectionStart ?? ta.value.length
    const m = /(^|\s)@([^\s@]*)$/.exec(ta.value.slice(0, caret))
    if (!m) {
      setAtOpen(false)
      return
    }
    setAtStart(caret - m[2].length - 1)
    setAtQuery(m[2])
    setAtIdx(0)
    setAtOpen(true)
    void ensureFiles()
  }

  function onComposerChange(e: ChangeEvent<HTMLTextAreaElement>): void {
    setInput(e.target.value)
    setAtDismissed(false)
    evalAt()
  }

  function onComposerSelect(): void {
    revealCaretSoon()
    if (atDismissed) return
    evalAt()
  }

  const atMatches = useMemo(() => {
    if (!atOpen) return []
    return fileList ? rankFiles(fileList, atQuery) : []
  }, [atOpen, fileList, atQuery])
  const atLoading = atOpen && fileList == null
  const atCapture = atOpen && atMatches.length > 0
  const atSel = Math.max(0, Math.min(atIdx, atMatches.length - 1))

  /** Replace the active @-token with a reference to `path`. */
  function pickFile(path: string): void {
    const caret = taRef.current?.selectionStart ?? input.length
    const before = input.slice(0, atStart)
    const after = input.slice(caret)
    const insert = `@${path} `
    setInput(before + insert + after)
    setAtOpen(false)
    setAtDismissed(false)
    pendingCaret.current = before.length + insert.length
  }

  // Restore focus + caret after an @-mention insertion (input is controlled).
  useEffect(() => {
    const c = pendingCaret.current
    if (c == null) return
    pendingCaret.current = null
    const ta = taRef.current
    if (ta) {
      ta.focus()
      ta.setSelectionRange(c, c)
    }
  }, [input])

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (atCapture) {
      const len = atMatches.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtIdx((i) => (Math.max(0, Math.min(i, len - 1)) + 1) % len)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtIdx((i) => (Math.max(0, Math.min(i, len - 1)) - 1 + len) % len)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        pickFile(atMatches[atSel].path)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtDismissed(true)
        setAtOpen(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  // Send a prompt queued from outside (e.g. the status-bar Rayfin upgrade). If a
  // turn is mid-flight we drop it into the composer instead of dropping it. We
  // notify the parent so it clears the one-shot prompt; otherwise it would
  // replay every time this panel remounts (e.g. after switching tabs).
  const handledOutbound = useRef<string | null>(null)
  useEffect(() => {
    if (!outbound || outbound.id === handledOutbound.current || externalBusy) return
    handledOutbound.current = outbound.id
    if (sending || outbound.stage) {
      setInput(outbound.prompt)
      taRef.current?.focus()
    } else {
      void dispatch(outbound.display, outbound.prompt, [])
    }
    onOutboundConsumed?.()
  }, [outbound?.id, externalBusy])

  // Precompute the conversation rows so a keystroke in the composer (which only
  // touches local `input` state) doesn't re-run `messages.map` and re-create N
  // <MessageRow> elements. Deps are all stable while typing, so this recomputes
  // only when the conversation actually changes — keeping per-keystroke cost
  // independent of session length.
  const messageList = useMemo(
    () =>
      messages.map((m, i) => {
        const prevUser = m.role === 'assistant' && i > 0 ? messages[i - 1] : undefined
        const rerunnable =
          !sending &&
          prevUser?.role === 'user' &&
          !prevUser.attachments &&
          prevUser.text !== '(screenshot)'
        const canRetry = Boolean(m.error) && !m.plan && rerunnable
        const canResume = Boolean(m.interrupted) && !m.plan && !m.pending && rerunnable
        const latest = m.role === 'assistant' && i === messages.length - 1
        const canTryAgain =
          latest &&
          rerunnable &&
          !deployLock &&
          !externalBusy &&
          !m.pending &&
          !m.error &&
          !m.interrupted &&
          !m.plan &&
          !m.designApplyId
        return (
          <MessageRow
            key={m.id}
            message={m}
            projectName={project.name}
            projectPath={project.path}
            latest={latest}
            canRetry={canRetry}
            onRetry={onRetry}
            canResume={canResume}
            onResume={onResume}
            canTryAgain={canTryAgain}
            onTryAgain={onTryAgain}
            planBusy={m.plan?.id === planBusyId}
            questionBusy={planBusyId === m.id}
            onChangePlanContent={onChangePlanContent}
            onResolvePlan={onResolvePlan}
            onAnswerPlanQuestion={onAnswerPlanQuestion}
            onResumePlan={onResumePlan}
            onExportPlan={onExportPlan}
            onOpenMention={onOpenMention}
          />
        )
      }),
    [
      messages,
      sending,
      deployLock,
      externalBusy,
      project.name,
      project.path,
      planBusyId,
      onRetry,
      onResume,
      onTryAgain,
      onChangePlanContent,
      onResolvePlan,
      onAnswerPlanQuestion,
      onResumePlan,
      onExportPlan,
      onOpenMention
    ]
  )

  return (
    <div className="chat">
      <div className="chat-toolbar">
        {onToggleFocus && (
          <button
            type="button"
            className={`chat-tool${focused ? ' is-on' : ''}`}
            onClick={onToggleFocus}
            title={focused ? 'Exit focus — show the preview again' : 'Focus the chat — hide the preview'}
            aria-label={focused ? 'Exit focus' : 'Focus the chat'}
          >
            {focused ? <CollapseIcon /> : <ExpandIcon />}
          </button>
        )}
        <span className="chat-toolbar-spacer" />
        <button
          type="button"
          className="chat-tool chat-tool--label"
          onClick={() => setConfirmNewChat(true)}
          disabled={sending || messages.length === 0}
          title="Clear this conversation and start fresh"
        >
          <Codicon name="add" /> New chat
        </button>
      </div>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScrollChat}>
        {needsCopilotSignIn && (
          <CopilotSignInNotice
            detail={copilotAuth?.error}
            host={copilotAuth?.host}
            disabled={sending}
            onSignedIn={async () => {
              await onCopilotAuthChanged?.()
              onChange((previous) =>
                previous.map((message) =>
                  isCopilotAuthError(message.error) ? { ...message, authResolved: true } : message
                )
              )
            }}
          />
        )}
        {messages.length === 0 && (
          <Welcome
            projectName={project.name}
            suggestions={suggestions}
            tailoring={suggestionsLoading && !generatedSuggestions}
            generated={Boolean(generatedSuggestions)}
            onPick={applySuggestion}
            onRefresh={refreshSuggestions}
          />
        )}

        <MarkdownLinksContext.Provider value={markdownLinks}>{messageList}</MarkdownLinksContext.Provider>
        {showJump && messages.length > 0 && (
          <button
            type="button"
            className={`chat-jump${jumpNew ? ' chat-jump--new' : ''}`}
            onClick={jumpToLatest}
            title="Jump to the latest message"
          >
            {jumpNew && <span className="chat-jump-dot" aria-hidden="true" />}
            <span className="chat-jump-label">{jumpNew ? 'New messages' : 'Jump to latest'}</span>
            <Codicon name="arrow-down" className="chat-jump-arrow" />
          </button>
        )}
      </div>

      <div className={`composer${sending ? ' composer--busy' : ''}`}>
        {deployLock && (
          <div className="deploy-gate" role="status">
            {deploying ? (
              <span className="ws-spinner deploy-gate-spin" aria-hidden="true" />
            ) : (
              <span className="deploy-gate-ico" aria-hidden="true">
                <Codicon name="rocket" />
              </span>
            )}
            <div className="deploy-gate-text">
              <span className="deploy-gate-title">
                {deploying ? 'Deploying your app…' : 'Deploy your app to start building'}
              </span>
              <span className="deploy-gate-sub">
                {deploying
                  ? `Chat unlocks as soon as ${project.name} is live.`
                  : `Chat is locked until ${project.name} has a deployment.`}
              </span>
            </div>
            {deploying ? (
              <button className="btn btn--sm" disabled>
                Deploying…
              </button>
            ) : (
              <button className="btn btn--sm btn--primary" onClick={onRequestDeploy}>
                Deploy now
              </button>
            )}
          </div>
        )}
        {showPlanSuggestion && (
          <div className="chat-plan-suggestion" role="status">
            <span className="chat-plan-suggestion-icon" aria-hidden="true">
              <ModeIcon mode="plan" />
            </span>
            <span className="chat-plan-suggestion-copy">
              <strong>This looks multi-step.</strong> Plan it before making changes?
            </span>
            <button
              type="button"
              className="chat-plan-suggestion-action"
              onClick={() => {
                setMode('plan')
                setDismissedPlanSuggestion(input)
              }}
            >
              Use Plan
            </button>
            <button
              type="button"
              className="chat-plan-suggestion-dismiss"
              aria-label="Dismiss Plan suggestion"
              onClick={() => setDismissedPlanSuggestion(input)}
            >
              <CloseIcon />
            </button>
          </div>
        )}
        <div
          className={`composer-box${dragOver ? ' composer-box--drag' : ''}`}
          onDrop={onComposerDrop}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
        >
          {sending && <div className="composer-busyline" aria-hidden="true" />}
          {dragOver && (
            <div className="composer-drop" aria-hidden="true">
              <ImageIcon className="composer-drop-ico" />
              <span>Drop to attach</span>
            </div>
          )}
          {atOpen && (
            <div className="mention-menu" role="listbox" aria-label="Project files">
              <div className="mention-menu-head">Reference a file</div>
              {atLoading && <div className="mention-empty">Loading files…</div>}
              {!atLoading && atMatches.length === 0 && (
                <div className="mention-empty">No files match “{atQuery}”</div>
              )}
              {atMatches.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  role="option"
                  aria-selected={i === atSel}
                  className={`mention-opt${i === atSel ? ' mention-opt--on' : ''}`}
                  onMouseEnter={() => setAtIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickFile(f.path)
                  }}
                >
                  <span className="codicon codicon-file mention-ico" aria-hidden="true" />
                  <span className="mention-name">{f.name}</span>
                  <span className="mention-path">{f.path}</span>
                </button>
              ))}
            </div>
          )}
          {((attachments?.length ?? 0) > 0 || attaching) && (
            <div className="chat-attachments">
              {(attachments ?? []).map((a) => (
                <div key={a.path} className="chat-attachment" title="Screenshot to send">
                  <img src={a.thumb} alt="Screenshot to send" />
                  <button
                    type="button"
                    className="chat-attachment-x"
                    onClick={() => onRemoveAttachment?.(a.path)}
                    title="Remove"
                    aria-label="Remove screenshot"
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))}
              {attaching && (
                <div className="chat-attachment chat-attachment--loading" role="status" aria-label="Adding image">
                  <span className="step-spin" aria-hidden="true" />
                </div>
              )}
            </div>
          )}
          <div className="composer-input-sizer" ref={sizerRef} data-replicated-value={input}>
            <div className="composer-highlight" ref={highlightRef} aria-hidden="true">
              {splitMentions(input, knownFiles).map((p, i) =>
                p.mention ? (
                  <mark key={i} className="composer-mention">
                    {p.text}
                  </mark>
                ) : (
                  <span key={i}>{p.text}</span>
                )
              )}
              {' '}
            </div>
            <textarea
              ref={taRef}
              className="composer-input"
              placeholder={
                deployLock
                  ? 'Deploy your app to start chatting…'
                  : `Message Fabricator about ${project.name}…`
              }
              value={input}
              rows={1}
              disabled={deployLock}
              onChange={onComposerChange}
              onSelect={onComposerSelect}
              onKeyDown={onKeyDown}
              onPaste={onComposerPaste}
              onFocus={revealCaretSoon}
            />
          </div>
          <div className="composer-actions">
            <div className="composer-left">
              <AddMenu
                locked={deployLock}
                attaching={attaching}
                onImage={() => fileRef.current?.click()}
                onConnectModel={() => setConnectOpen(true)}
                onReferenceFile={insertMention}
              />
              {modeSelectorEnabled && <ModeMenu mode={activeMode} disabled={sending} onSelect={setMode} />}
              <ModelMenu model={model} effort={effort} disabled={sending} onChange={saveOptions} />
            </div>
            <div className="composer-right">
              <span className="composer-hint" aria-hidden="true">
                <kbd>Enter</kbd> to send
              </span>
              <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
              {sending ? (
                <>
                  <button
                    type="button"
                    className="composer-send composer-send--interject"
                    onClick={send}
                    disabled={!input.trim() || externalBusy}
                    title="Interject — send this now without waiting"
                    aria-label="Interject this message"
                  >
                    <SendIcon />
                  </button>
                  <button
                    type="button"
                    className="composer-send composer-send--stop"
                    onClick={stop}
                    title="Stop generating"
                    aria-label="Stop generating"
                  >
                    <StopIcon />
                  </button>
                </>
              ) : (
                <span
                  style={{ display: 'contents' }}
                  title={submitBlocked ? 'Deploying — sending resumes when it goes live' : undefined}
                >
                  <button
                    type="button"
                    className="composer-send"
                    onClick={send}
                    disabled={
                      deployLock ||
                      externalBusy ||
                      submitBlocked ||
                      (!input.trim() && (attachments?.length ?? 0) === 0)
                    }
                    title={submitBlocked ? undefined : 'Send (Enter)'}
                    aria-label="Send"
                  >
                    <SendIcon />
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {connectOpen && (
        <ConnectModelModal
          project={project}
          onClose={() => setConnectOpen(false)}
          onSignedIn={onCopilotAuthChanged}
          onConnect={(prompt) =>
            setInput((prev) => (prev.trim() ? `${prev}\n\n${prompt}` : prompt))
          }
        />
      )}
      {confirmNewChat && (
        <ConfirmModal
          title="Start a new chat?"
          message="This clears the conversation and starts Fabricator fresh. Your app and its files stay exactly as they are."
          confirmLabel="New chat"
          onConfirm={() => void newChat()}
          onCancel={() => setConfirmNewChat(false)}
        />
      )}
    </div>
  )
}
