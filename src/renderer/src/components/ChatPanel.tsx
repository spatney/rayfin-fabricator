import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
  type JSX,
  type ReactNode,
} from 'react'
import {
  type ChatAdvisorSummary,
  type ChatDataRef,
  type ChatFileRef,
  type ChatMigrationRef,
  type ChatMode,
  type ChatPathInfo,
  type ChatPickRef,
  type ChatPlanArtifact,
  type ChatPluginId,
  type ChatTurnResult,
  type CopilotAuthStatus,
  type DirListing,
  type ExperimentFlags,
  type StudioProject
} from '@shared/ipc'
import { isCopilotAuthError } from '../copilotAuth'
import { openDocs } from '../docsLinks'
import type { WorkspaceUse } from '../fabric'
import {
  dataTurnPrompt,
  pendingData,
  setPendingData,
  toDataRef,
  type DataKind,
  type DataSource
} from '../fabricData'
import { DataTray } from './chat/DataTray'
import { FileTray } from './chat/FileTray'
import { filesTurnPrompt, pendingFiles, setPendingFiles, withFiles } from './chat/fileRefs'
import CopilotSignInNotice from './CopilotSignInNotice'
import type { PendingShot } from './PreviewPane'
import { splitMentions } from './MentionText'
import { ExpandIcon, CollapseIcon, CloseIcon, StopIcon, ImageIcon, Codicon, PenIcon } from './icons'
import ConnectDataModal from './ConnectDataModal'
import ConfirmModal from './ConfirmModal'
import { MarkdownLinksContext, type MarkdownLinks } from './Markdown'
import {
  buildRecoveredPlanPrompt,
  createPlanArtifact,
  modeForPlanAction,
  setPlanSubmitting
} from '../chatPlan'
import type { OutboundPrompt, UIChatMessage } from './chat/types'
import { suggestionsFor, useGeneratedSuggestions } from './chat/suggestions'
import { SendIcon } from './chat/icons'
import { AddMenu, PluginsMenu } from './chat/ComposerMenus'
import { UsageMeter } from './chat/UsageMeter'
import { offeredPlugins } from './chat/plugins'
import { useMcpServers } from '../mcpServers'
import { ModelPicker } from './models/ModelPicker'
import { selectionArgs, selectionOf, type ModelSelection } from '../modelSelection'
import { useCopilotModels } from '../copilotModels'
import { Welcome } from './chat/Welcome'
import { uid } from './chat/format'
import { readAsDataUrl, stageImage, toPngAndThumb } from './chat/images'
import { ImageMarkup } from './chat/ImageMarkup'
import { ImageViewer } from './chat/ImageViewer'
import { reduceChatMessage, rollbackInterjection, settleRunningTools } from './chat/reducer'
import { ChatEventBuffer, isStreamingEvent } from './chat/eventCoalescer'
import {
  activeMention,
  flattenFiles,
  isImagePath,
  isPathQuery,
  mentionText,
  rankEntries,
  rankFiles,
  splitPathQuery,
  type MentionFile,
  type MentionOption
} from './chat/mentions'
import { createFileResolver } from './chat/paths'
import { MessageRow } from './chat/MessageRow'
import { tryAgainPrompt } from './chat/prompts'
import { PickTray } from '../pick/PickTray'
import type { PickedElement, PickTurn } from '../pick/useTouchUp'
import { useFileDrop } from '../fileDrop'
import './chat/chat.css'

export type { OutboundPrompt, UIChatMessage } from './chat/types'
export { reduceChatMessage } from './chat/reducer'

const NO_PICKS: PickedElement[] = []

/** The prompt a Retry / Try again / Resume re-sends for a user message, or null
 *  when it can't be re-run (a screenshot-only message). */
function rerunPrompt(user: UIChatMessage): string | null {
  if (user.prompt) return user.prompt
  if (!user.text || user.text === '(screenshot)') return null
  return user.text
}

/** What a user message carries beyond its text: the elements it picked in the
 *  preview, an Advisor card, the Fabric data and the files it added, the
 *  migration page it builds, and the prompt reruns re-send. */
interface TurnExtra {
  picks?: ChatPickRef[]
  advisor?: ChatAdvisorSummary
  data?: ChatDataRef[]
  files?: ChatFileRef[]
  migration?: ChatMigrationRef
  storedPrompt?: string
}

/** A message's chips, card and prompt, carried to its rerun (without the
 *  pictures: those were deleted once the original turn used them). */
function rerunExtra(user: UIChatMessage): TurnExtra | undefined {
  if (
    !user.prompt &&
    !user.picks &&
    !user.advisor &&
    !user.data &&
    !user.files &&
    !user.migration
  ) {
    return undefined
  }
  return {
    picks: user.picks?.map(({ n, label }) => ({ n, label })),
    advisor: user.advisor,
    data: user.data,
    files: user.files,
    migration: user.migration,
    storedPrompt: user.prompt
  }
}

interface Props {
  project: StudioProject
  messages: UIChatMessage[]
  onChange: (updater: (prev: UIChatMessage[]) => UIChatMessage[]) => void
  /** Called after a turn completes (used later to trigger deploy/preview refresh). */
  onTurnComplete?: (result: ChatTurnResult) => void
  /** Called when a fresh turn starts (a new send/retry/resume — not an interjection).
   *  Lets the host kick off the live local preview for the turn's duration. The
   *  turn is sent once a returned promise settles (the host may ask the user to
   *  resolve a port conflict first); a rejection never blocks the turn. */
  onTurnStart?: () => void | Promise<void>
  /** Called when a reviewed Plan begins executing within its existing turn.
   *  Lets the host ensure live local preview is running for the edit phase. */
  onPlanExecutionStart?: () => void
  /** Region screenshots staged for the next message. */
  attachments?: PendingShot[]
  /** Stage an image the user added, pasted, or dropped into the composer. */
  onAddAttachment?: (shot: PendingShot) => void
  /** Remove a staged screenshot (also deletes its temp file). */
  onRemoveAttachment?: (path: string) => void
  /** A staged picture was drawn on: `shot` takes the place of the one at `path`. */
  onReplaceAttachment?: (path: string, shot: PendingShot) => void
  /** Called once staged screenshots have been sent so the parent can clear them:
   *  the ones at `paths`, or all of them. */
  onAttachmentsConsumed?: (paths?: string[]) => void
  /** Called when the user starts a new chat (parent clears persisted history). */
  onClearHistory?: () => void
  /** Called after the model / effort options or the plugins change (parent refreshes project). */
  onOptionsChanged?: () => void
  /** Open Accounts at Model providers (your own API keys). */
  onManageKeys?: () => void
  /** A prompt to send on behalf of the user (e.g. the Rayfin upgrade hand-off). */
  outbound?: OutboundPrompt | null
  /** Called once an outbound prompt has been consumed so the parent can clear it
   * (prevents the one-shot prompt from replaying when the panel remounts). */
  onOutboundConsumed?: () => void
  /** A message that handed Advisor findings to Copilot is being re-run (Retry,
   *  Try again, Resume), so the host can record the hand-off again. */
  onAdvisorRerun?: (summary: ChatAdvisorSummary) => void
  /** True when chat is expanded to fill the build view (preview hidden). */
  focused?: boolean
  /** Toggle chat focus (full-width chat ⇄ split with preview). */
  onToggleFocus?: () => void
  /** True while the project is publishing: `blockSubmitWhileDeploying` pauses sending. */
  deploying?: boolean
  /** When true, a publish in progress pauses *submitting* a new turn (typing stays
   *  enabled). Used by the live local preview so a turn never overlaps a publish —
   *  otherwise the dev server can't start during the publish and never comes back. */
  blockSubmitWhileDeploying?: boolean
  /** Tooltip on the paused Send button (defaults to the publish wording). */
  submitBlockedTitle?: string
  /** The host owns the global chat-event subscription (keeps turns live while this panel is unmounted). */
  eventsManagedExternally?: boolean
  /** Open a file referenced by an @-mention chip (path without the leading @). */
  onOpenMention?: (ref: string) => void
  /** The current composer draft. Persisted by the parent (keyed by project) so a
   * typed-but-unsent prompt survives this panel unmounting — e.g. switching to the
   * Code tab and back to Build tears down ChatPanel (issue #9). */
  draft?: string
  /** Called whenever the composer draft changes so the parent can persist it. */
  onDraftChange?: (value: string) => void
  /** Elements picked in the preview with Touch Up, shown as chips in the
   *  composer and sent with the next message. */
  picks?: readonly PickedElement[]
  /** Picking is on in the preview: Escape in the composer finishes it. */
  pickOn?: boolean
  onPickRemove?: (id: string) => void
  /** Outline a pick in the preview while its chip is hovered (`null` stops). */
  onPickFocus?: (id: string | null) => void
  /** Finish picking (Escape in the composer). */
  onPickExit?: () => void
  /** Compose the message's picks for `note` (null when nothing is picked). */
  buildPickTurn?: (note: string) => Promise<PickTurn | null>
  /** The picks went out with a message: the parent drops them and ends picking. */
  onPicksSent?: (turn: PickTurn) => void
  /** A pick's picture was drawn on: `shot` takes its place. */
  onPickShot?: (id: string, shot: PendingShot) => void
  copilotAuth?: CopilotAuthStatus
  onCopilotAuthChanged?: () => Promise<void> | void
  /** The workspaces your apps deploy to, and when (Add Fabric data lists recent ones first). */
  recentWorkspaces?: readonly WorkspaceUse[]
  /** Shown above the composer, such as a report migration's progress card. */
  banner?: ReactNode
  /** The experiments that are on, for the plugins they add to chat (Work IQ). */
  experiments?: ExperimentFlags
  /** Open the MCP servers dialog, adding a server when `add` is set. */
  onManageMcpServers?: (add: boolean) => void
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
  onReplaceAttachment,
  onAttachmentsConsumed,
  onClearHistory,
  onOptionsChanged,
  onManageKeys,
  outbound,
  onOutboundConsumed,
  onAdvisorRerun,
  focused,
  onToggleFocus,
  deploying = false,
  blockSubmitWhileDeploying = false,
  submitBlockedTitle = 'Publishing — sending resumes when it goes live',
  eventsManagedExternally = false,
  onOpenMention,
  draft,
  onDraftChange,
  picks = NO_PICKS,
  pickOn = false,
  onPickRemove,
  onPickFocus,
  onPickExit,
  buildPickTurn,
  onPicksSent,
  onPickShot,
  copilotAuth,
  onCopilotAuthChanged,
  recentWorkspaces,
  banner,
  experiments,
  onManageMcpServers
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
  /** A message's picks are being composed (guards double sends). */
  const pickBuildRef = useRef(false)
  const [pickSending, setPickSending] = useState(false)
  /** The staged picture shown large to draw on: a screenshot, or a pick's picture. */
  const [marking, setMarking] = useState<{ path: string } | { pick: string } | null>(null)
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
  // Still being verified at launch is unknown, not signed out.
  const needsCopilotSignIn = (copilotAuth?.signedIn === false && !copilotAuth.checking) || authFailed
  useEffect(() => {
    setSending((s) => (s === hasLiveTurn ? s : hasLiveTurn))
  }, [hasLiveTurn])
  const [selection, setSelection] = useState<ModelSelection>(() => selectionOf(project))
  // A model on the user's own key that can't read images can't take attachments.
  const { models } = useCopilotModels(Boolean(selection.model))
  const chosenModel = models.find((m) => m.id === selection.model)
  const imageNote = chosenModel?.byok && !chosenModel.vision ? `${chosenModel.name} can’t read images` : undefined
  const imagesBlocked = Boolean(imageNote) && (attachments?.length ?? 0) > 0
  const [planBusyId, setPlanBusyId] = useState<string | null>(null)
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
  /** The composer box: where files and folders dragged from this computer drop. */
  const boxRef = useRef<HTMLDivElement>(null)
  const dragOver = useFileDrop(boxRef, (paths) => void addPaths(paths), !sending)
  const [fileList, setFileList] = useState<MentionFile[] | null>(null)
  const knownFiles = useMemo(() => (fileList ? new Set(fileList.map((f) => f.path)) : undefined), [fileList])
  const [atOpen, setAtOpen] = useState(false)
  const [atStart, setAtStart] = useState(0)
  const [atQuery, setAtQuery] = useState('')
  /** The @-token is quoted (`@"…`), for a path with spaces. */
  const [atQuoted, setAtQuoted] = useState(false)
  const [atIdx, setAtIdx] = useState(0)
  const [atDismissed, setAtDismissed] = useState(false)
  const atMenuRef = useRef<HTMLDivElement>(null)
  /** The arrow keys moved the @-picker's selection: scroll it into view. */
  const revealAtSel = useRef(false)
  /** The folder an @-path browses (as typed), and what's in it once listed. */
  const [listing, setListing] = useState<{ dir: string; result?: DirListing } | null>(null)
  const listingDir = useRef<string | null>(null)
  /** A folder was picked: list what's in it once the composer has its new text. */
  const browseNext = useRef(false)
  const pendingCaret = useRef<number | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const sizerRef = useRef<HTMLDivElement>(null)
  const revealRaf = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [attaching, setAttaching] = useState(false)
  /** The Add Fabric data picker, open on one kind of data or on every kind. */
  const [connect, setConnect] = useState<{ kind?: DataKind } | null>(null)
  /** Fabric data waiting to go out with the next message, shown as chips. */
  const [dataChips, setDataChipsState] = useState<DataSource[]>(() => pendingData(project.id))
  const setDataChips = (next: DataSource[]): void => {
    setPendingData(project.id, next)
    setDataChipsState(next)
  }
  /** Files and folders on this computer waiting to go out with the next message, shown as chips. */
  const [fileChips, setFileChipsState] = useState<ChatFileRef[]>(() => pendingFiles(project.id))
  const changeFileChips = (change: (files: ChatFileRef[]) => ChatFileRef[]): void =>
    setFileChipsState((files) => {
      const next = change(files)
      setPendingFiles(project.id, next)
      return next
    })
  // What waits in the composer as of the latest render: a message that waits for
  // its picks to be prepared sends what's there once they are.
  const waiting = useRef({ attachments, fileChips })
  waiting.current = { attachments, fileChips }

  // The staged picture shown large, and what it is.
  const marked = ((): { shot: PendingShot; label: string } | null => {
    if (!marking) return null
    if ('path' in marking) {
      const shot = (attachments ?? []).find((a) => a.path === marking.path)
      return shot ? { shot, label: 'Screenshot' } : null
    }
    const pick = picks.find((p) => p.id === marking.pick)
    return pick?.shot ? { shot: pick.shot, label: pick.target.label } : null
  })()
  /** Keep what was drawn on a staged picture: it takes the old one's place. */
  async function keepDrawing(
    target: { path: string } | { pick: string },
    drawn: string
  ): Promise<void> {
    try {
      const shot = await stageImage(drawn)
      if ('path' in target) onReplaceAttachment?.(target.path, shot)
      else onPickShot?.(target.pick, shot)
    } catch (err) {
      console.error('Failed to keep the drawing', err)
    }
  }

  // Something new to send, such as a pick or a screenshot made in the preview
  // (where the user just clicked), brings the keyboard here, so what they type
  // next says what to change.
  const stagedCount = picks.length + (attachments?.length ?? 0)
  const seenStaged = useRef(stagedCount)
  useEffect(() => {
    const grew = stagedCount > seenStaged.current
    seenStaged.current = stagedCount
    if (!grew) return
    const release = window.api.preview?.releaseFocus
    void (release ? release() : Promise.resolve())
      .catch(() => {})
      .finally(() => taRef.current?.focus())
  }, [stagedCount])

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

  // Persist a model choice (the picker already drops an effort or window the
  // new model can't use).
  function saveOptions(next: ModelSelection): void {
    setSelection(next)
    void window.api.chat.setOptions(project.id, selectionArgs(next))
    onOptionsChanged?.()
  }

  // The plugins on in this chat. A switch flips at once and flips back if it can't be saved.
  const [plugins, setPlugins] = useState<readonly string[]>(() => project.plugins ?? [])
  // Follow the saved list when it changes elsewhere, e.g. removing an MCP server turns it off everywhere.
  const savedPlugins = (project.plugins ?? []).join('\n')
  useEffect(() => {
    setPlugins(savedPlugins ? savedPlugins.split('\n') : [])
  }, [savedPlugins])
  const mcpServers = useMcpServers()
  function togglePlugin(plugin: ChatPluginId, on: boolean): void {
    const turn = (value: boolean) => (ids: readonly string[]) =>
      value ? [...ids.filter((id) => id !== plugin), plugin] : ids.filter((id) => id !== plugin)
    setPlugins(turn(on))
    window.api.chat.setPlugin(project.id, plugin, on).then(
      () => onOptionsChanged?.(),
      () => setPlugins(turn(!on))
    )
  }

  // Coalesce high-frequency streamed events (text / reasoning deltas and live tool
  // output). The backend already batches them (at most one per ~50 ms per turn,
  // see services/emit.rs), but applying each individually still re-rendered the
  // active turn and re-parsed its markdown many times per second — the dominant
  // cause of the VM/Parallels "hang". We buffer them per turn
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
  }, [eventsManagedExternally, project.id])

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

  // Stage one or more images (from the file picker, paste, or a drop from this
  // computer) as chat attachments — re-encoded to PNG and saved to a temp file,
  // reusing the same pending-attachment flow as annotated screenshots.
  async function stageImages(files: Iterable<File | null | undefined>): Promise<void> {
    const images = Array.from(files).filter(
      (f): f is File => !!f && f.type.startsWith('image/')
    )
    await attachImages(images.map((file) => () => readAsDataUrl(file)))
  }

  /** Attach images, each read as a data URL when its turn comes. */
  async function attachImages(reads: Array<() => Promise<string>>): Promise<void> {
    if (!onAddAttachment || reads.length === 0) return
    setAttaching(true)
    try {
      for (const read of reads) {
        const { png, thumb } = await toPngAndThumb(await read())
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

  /**
   * Add files and folders from this computer, dropped on the composer or picked
   * in the system's file dialog: images are attached, like pasted ones, and the
   * rest wait as chips for the next message, which gives Copilot each to read.
   */
  async function addPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    let found: ChatPathInfo[]
    try {
      found = await window.api.chat.inspectPaths(paths)
    } catch (err) {
      console.error('Failed to look at the files to add', err)
      return
    }
    const images = onAddAttachment ? found.filter((f) => !f.dir && isImagePath(f.path)) : []
    const files = found
      .filter((f) => !images.includes(f))
      .map((f) => ({ path: f.path, dir: f.dir }))
    if (files.length > 0) changeFileChips((chips) => withFiles(chips, files))
    await attachImages(images.map((f) => () => window.api.screenshot.read(f.path)))
  }

  /** Add files and folders picked in the system's file dialog (the "+" menu). */
  async function browse(): Promise<void> {
    try {
      await addPaths(await window.api.chat.pickPaths())
    } catch (err) {
      console.error('Failed to pick files', err)
    }
  }

  // A deploy in progress pauses *submitting* a new turn (typing stays enabled) when
  // the host asks for it (live local preview). Prevents a turn overlapping a deploy.
  const submitBlocked = deploying && blockSubmitWhileDeploying

  async function send(): Promise<void> {
    if (imagesBlocked) return
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
      const files = fileChips
      if (files.length > 0) changeFileChips(() => [])
      // Picked elements go with the interjection, so "make this bigger" says what "this" is.
      const picked = picks.length > 0 ? await composePicks(text) : null
      await steer(text, shots, files, picked)
      return
    }
    // Pause a *new* turn while a deploy runs (steering a live turn above is still
    // allowed) so the turn never overlaps the deploy and the local preview can
    // start cleanly once the deploy finishes.
    if (submitBlocked) return
    // Elements picked in the preview go out with the message; the typed text says
    // what to change, and without it Copilot touches them up.
    if (picks.length > 0 && buildPickTurn) {
      await sendPicks(text)
      return
    }
    // Fabric data and files go out with the message as chips: Copilot gets how to
    // connect the data, and a reference to each file and folder, which it reads.
    if (dataChips.length > 0 || fileChips.length > 0) {
      const sources = dataChips
      const files = fileChips
      const prompt = filesTurnPrompt(
        sources.length > 0 ? dataTurnPrompt(text, sources) : text,
        files,
        project.path
      )
      setInput('')
      setDataChips([])
      changeFileChips(() => [])
      onAttachmentsConsumed?.()
      await dispatch(text, prompt, shots, undefined, undefined, {
        data: sources.length > 0 ? sources.map(toDataRef) : undefined,
        files: files.length > 0 ? files : undefined,
        storedPrompt: prompt
      })
      return
    }
    if (!text && shots.length === 0) return
    const prompt = text || 'Here is a screenshot of the current preview — please take a look.'
    setInput('')
    onAttachmentsConsumed?.()
    await dispatch(text || '(screenshot)', prompt, shots)
  }

  /** Compose the message's picks, or null when that fails (the message then goes without them). */
  async function composePicks(note: string): Promise<PickTurn | null> {
    if (!buildPickTurn || pickBuildRef.current) return null
    pickBuildRef.current = true
    setPickSending(true)
    try {
      return await buildPickTurn(note)
    } catch (err) {
      console.error('Failed to prepare the picked elements', err)
      return null
    } finally {
      pickBuildRef.current = false
      setPickSending(false)
    }
  }

  /**
   * Send a message with the elements picked in the preview: Copilot gets what
   * the user typed, each element's details and likely source, and a picture of
   * each, and the transcript shows them as chips. The pictures, Fabric data and
   * files waiting in the composer once the picks are ready go with it: a clip
   * can land while they're being prepared, and one that lands later stays.
   */
  async function sendPicks(note: string): Promise<void> {
    if (pickBuildRef.current) return
    const turn = await composePicks(note)
    if (!turn) return
    // Keep anything typed while the picks were being composed.
    if (inputRef.current.trim() === note) setInput('')
    const shots = waiting.current.attachments ?? []
    const sources = pendingData(project.id)
    const files = waiting.current.fileChips
    if (sources.length > 0) setDataChips([])
    if (files.length > 0) {
      const sent = new Set(files.map((f) => f.path))
      changeFileChips((all) => all.filter((f) => !sent.has(f.path)))
    }
    const wrap = (prompt: string): string =>
      filesTurnPrompt(
        sources.length > 0 ? dataTurnPrompt(prompt, sources) : prompt,
        files,
        project.path
      )
    onAttachmentsConsumed?.(shots.map((s) => s.path))
    onPicksSent?.(turn)
    await dispatch(
      turn.display,
      wrap(turn.prompt),
      [...turn.shots, ...shots],
      undefined,
      undefined,
      {
        picks: turn.picks,
        data: sources.length > 0 ? sources.map(toDataRef) : undefined,
        files: files.length > 0 ? files : undefined,
        storedPrompt: wrap(turn.storedPrompt)
      }
    )
  }

  /**
   * Interject `text` into the turn that's currently streaming. Optimistically
   * shows it inline in the live assistant feed, then asks the backend to deliver
   * it immediately. If the turn happened to finish first (`steered: false`), the
   * optimistic bubble is rolled back and the message is sent as a fresh turn.
   * Copilot gets a reference to each of `files` too, and `picked` elements with
   * their pictures.
   */
  async function steer(
    text: string,
    shots: PendingShot[],
    files: ChatFileRef[] = [],
    picked: PickTurn | null = null
  ): Promise<void> {
    const prompt = filesTurnPrompt(picked ? picked.prompt : text, files, project.path)
    const sent = picked ? [...picked.shots, ...shots] : shots
    if (picked) onPicksSent?.(picked)
    const liveTurnId = [...messages].reverse().find((m) => m.pending && m.turnId)?.turnId
    const thumbs = sent.length ? sent.map((s) => s.thumb) : undefined
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
      const res = await window.api.chat.steer(
        project.id,
        prompt,
        sent.map((s) => s.path)
      )
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
      await dispatch(
        text,
        prompt,
        sent,
        undefined,
        undefined,
        picked
          ? {
              picks: picked.picks,
              files: files.length > 0 ? files : undefined,
              storedPrompt: filesTurnPrompt(picked.storedPrompt, files, project.path)
            }
          : files.length > 0
            ? { files, storedPrompt: prompt }
            : undefined
      )
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

  /**
   * Let the host prepare a fresh turn before it's sent (the live preview may need
   * the user to settle a port conflict). A failure there never blocks the turn,
   * and time spent waiting isn't counted as the turn's own work.
   */
  async function beginTurn(assistantId: string): Promise<void> {
    const started = Date.now()
    try {
      await onTurnStart?.()
    } catch (error) {
      console.error('Turn start hook failed', error)
    }
    if (Date.now() - started > 250) {
      const now = Date.now()
      onChange((prev) => prev.map((m) => (m.id === assistantId ? { ...m, startedAt: now } : m)))
    }
  }

  /** Append a fresh turn and stream its result. Shared by send + retry. `extra`
   *  carries the chips or card a message shows and the prompt reruns re-send. */
  async function dispatch(
    displayText: string,
    prompt: string,
    shots: PendingShot[],
    modeOverride?: ChatMode,
    initialPlan?: ChatPlanArtifact,
    extra?: TurnExtra
  ): Promise<void> {
    const turnId = uid()
    const assistantId = uid()
    const sendMode = modeOverride ?? 'agent'
    const now = Date.now()
    const userMsg: UIChatMessage = {
      id: uid(),
      role: 'user',
      text: displayText,
      tools: [],
      pending: false,
      createdAt: now,
      attachments: shots.length || undefined,
      attachmentThumbs: shots.length ? shots.map((s) => s.thumb) : undefined,
      picks: extra?.picks,
      advisor: extra?.advisor,
      data: extra?.data,
      files: extra?.files,
      migration: extra?.migration,
      prompt: extra?.storedPrompt
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
    await beginTurn(assistantId)
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
    const user = messages[idx - 1]
    if (!user || user.role !== 'user' || !rerunPrompt(user)) return
    if (user.advisor) onAdvisorRerun?.(user.advisor)
    await dispatch(user.text, rerunPrompt(user)!, [], undefined, undefined, rerunExtra(user))
  }

  /** Re-run the latest prompt for a fresh attempt (its context and file changes stay). */
  async function tryAgain(assistantId: string): Promise<void> {
    if (sending || submitBlocked) return
    const idx = messages.findIndex((m) => m.id === assistantId)
    if (idx <= 0 || idx !== messages.length - 1) return
    const turn = messages[idx]
    if (turn.pending || turn.plan) return
    const user = messages[idx - 1]
    const original = user?.role === 'user' ? rerunPrompt(user) : null
    if (!original) return
    if (user.advisor) onAdvisorRerun?.(user.advisor)
    await dispatch(user.text, tryAgainPrompt(original), [], undefined, undefined, rerunExtra(user))
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
    const user = messages[idx - 1]
    const original = user?.role === 'user' ? rerunPrompt(user) : null
    if (!original) return
    if (user.advisor) onAdvisorRerun?.(user.advisor)
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
    await beginTurn(assistantMsg.id)
    try {
      const result = await window.api.chat.send(project.id, turnId, original, [], 'agent')
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
    onClearHistory?.()
  }

  function applySuggestion(text: string): void {
    setInput(text)
    taRef.current?.focus()
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
    const token = activeMention(ta.value.slice(0, caret))
    if (!token) {
      setAtOpen(false)
      return
    }
    setAtStart(token.start)
    setAtQuery(token.query)
    setAtQuoted(token.quoted)
    setAtIdx(0)
    setAtOpen(true)
    // A path browses folders, in the project or outside it; anything else
    // searches the project's files. Opening the picker lists a folder afresh.
    if (isPathQuery(token.query)) void ensureListing(splitPathQuery(token.query).dir, !atOpen)
    else void ensureFiles()
  }

  /** List the folder an @-path is in: once per folder typed while the picker is open. */
  async function ensureListing(dir: string, fresh: boolean): Promise<void> {
    if (!fresh && listingDir.current === dir) return
    listingDir.current = dir
    setListing({ dir })
    let result: DirListing
    try {
      result = await window.api.projects.files.listDir(project.id, dir)
    } catch (err) {
      result = { dir, entries: [], error: err instanceof Error ? err.message : String(err) }
    }
    if (listingDir.current === dir) setListing({ dir, result })
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

  const pathParts = useMemo(
    () => (atOpen && isPathQuery(atQuery) ? splitPathQuery(atQuery) : null),
    [atOpen, atQuery]
  )
  const pathListing = pathParts && listing?.dir === pathParts.dir ? listing.result : undefined
  const atOptions = useMemo<MentionOption[]>(() => {
    if (!atOpen) return []
    if (!pathParts) {
      return (fileList ? rankFiles(fileList, atQuery) : []).map((f) => ({
        key: f.path,
        kind: 'file' as const,
        name: f.name,
        detail: f.path,
        insert: `${mentionText(f.path)} `
      }))
    }
    if (!pathListing || pathListing.error) return []
    const { dir, partial } = pathParts
    // Folders keep the separator the path was typed with.
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
    const options: MentionOption[] = rankEntries(pathListing.entries, partial).map((e) =>
      e.dir
        ? {
            key: `dir:${e.name}`,
            kind: 'dir' as const,
            name: e.name,
            detail: `${dir}${e.name}${sep}`,
            insert: mentionText(`${dir}${e.name}${sep}`, atQuoted, true),
            browse: true
          }
        : {
            key: `file:${e.name}`,
            kind: 'file' as const,
            name: e.name,
            detail: `${dir}${e.name}`,
            insert: `${mentionText(`${dir}${e.name}`, atQuoted)} `
          }
    )
    if (!partial) {
      options.unshift({
        key: 'here',
        kind: 'here',
        name: 'This folder',
        detail: dir,
        insert: `${mentionText(dir, atQuoted)} `
      })
    }
    return options
  }, [atOpen, atQuery, atQuoted, fileList, pathParts, pathListing])
  const atLoading = atOpen && (pathParts ? !pathListing : fileList == null)
  const atCapture = atOpen && atOptions.length > 0
  const atSel = Math.max(0, Math.min(atIdx, atOptions.length - 1))
  // A new query, or another folder, lists from the top.
  useEffect(() => {
    if (atMenuRef.current) atMenuRef.current.scrollTop = 0
  }, [atQuery, pathListing])
  // The arrow keys keep the selection in view; hovering leaves the list where it is.
  useEffect(() => {
    if (!revealAtSel.current) return
    revealAtSel.current = false
    const menu = atMenuRef.current
    if (!menu) return
    if (atSel === 0) menu.scrollTop = 0
    else
      menu
        .querySelector<HTMLElement>('[aria-selected="true"]')
        ?.scrollIntoView?.({ block: 'nearest' })
  }, [atSel])

  /** Replace the active @-token with `option`'s reference; a folder goes on to list what's in it. */
  function pickMention(option: MentionOption): void {
    const caret = taRef.current?.selectionStart ?? input.length
    const before = input.slice(0, atStart)
    const after = input.slice(caret)
    setInput(before + option.insert + after)
    setAtOpen(false)
    setAtDismissed(false)
    pendingCaret.current = before.length + option.insert.length
    browseNext.current = Boolean(option.browse)
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
    if (browseNext.current) {
      browseNext.current = false
      evalAt()
    }
  }, [input])

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (atCapture) {
      const len = atOptions.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        revealAtSel.current = true
        setAtIdx((i) => (Math.max(0, Math.min(i, len - 1)) + 1) % len)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        revealAtSel.current = true
        setAtIdx((i) => (Math.max(0, Math.min(i, len - 1)) - 1 + len) % len)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        pickMention(atOptions[atSel])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtDismissed(true)
        setAtOpen(false)
        return
      }
    }
    // Escape here finishes picking too: after a pick, the keyboard is here.
    if (e.key === 'Escape' && pickOn && onPickExit) {
      e.preventDefault()
      onPickExit()
      return
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
    if (!outbound || outbound.id === handledOutbound.current) return
    handledOutbound.current = outbound.id
    if (outbound.connectData) {
      setConnect({})
    } else if (sending || outbound.stage) {
      setInput(outbound.prompt)
      taRef.current?.focus()
    } else {
      // Keep the full prompt when the bubble shows a short label, so Retry,
      // Try again, and Resume re-send what Copilot actually received. A model
      // that can't read images gets the prompt alone (it names the files).
      const shots = imageNote ? [] : [...(outbound.shots ?? [])]
      void dispatch(outbound.display, outbound.prompt, shots, undefined, undefined, {
        advisor: outbound.advisor,
        migration: outbound.migration,
        storedPrompt: outbound.prompt !== outbound.display ? outbound.prompt : undefined
      })
    }
    onOutboundConsumed?.()
  }, [outbound?.id])

  // Precompute the conversation rows so a keystroke in the composer (which only
  // touches local `input` state) doesn't re-run `messages.map` and re-create N
  // <MessageRow> elements. Deps are all stable while typing, so this recomputes
  // only when the conversation actually changes — keeping per-keystroke cost
  // independent of session length.
  const messageList = useMemo(
    () =>
      messages.map((m, i) => {
        const prevUser = m.role === 'assistant' && i > 0 ? messages[i - 1] : undefined
        // A message with a stored prompt (picked elements, a hand-off) re-sends it;
        // plain screenshot-only messages can't be re-run (their images are gone).
        const rerunnable =
          !sending &&
          prevUser?.role === 'user' &&
          (Boolean(prevUser.prompt) || (!prevUser.attachments && prevUser.text !== '(screenshot)'))
        const canRetry = Boolean(m.error) && !m.plan && rerunnable
        const canResume = Boolean(m.interrupted) && !m.plan && !m.pending && rerunnable
        const latest = m.role === 'assistant' && i === messages.length - 1
        const next = messages[i + 1]
        const working = m.role === 'user' && next?.role === 'assistant' && next.pending
        const canTryAgain =
          latest && rerunnable && !m.pending && !m.error && !m.interrupted && !m.plan
        return (
          <MessageRow
            key={m.id}
            message={m}
            projectName={project.name}
            projectPath={project.path}
            latest={latest}
            working={working}
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
        <UsageMeter
          key={project.id}
          projectId={project.id}
          sending={sending}
          hidden={messages.length === 0}
          host={copilotAuth?.host}
        />
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
        {banner}
        <div ref={boxRef} className={`composer-box${dragOver ? ' composer-box--drag' : ''}`}>
          {sending && <div className="composer-busyline" aria-hidden="true" />}
          {dragOver && (
            <div className="composer-drop" aria-hidden="true">
              <ImageIcon className="composer-drop-ico" />
              <span>Drop to attach</span>
            </div>
          )}
          {atOpen && (
            <div
              ref={atMenuRef}
              className="mention-menu"
              role="listbox"
              aria-label={pathParts ? 'Files and folders' : 'Project files'}
            >
              <div className="mention-menu-head">
                {pathParts ? 'Reference a file or folder' : 'Reference a file'}
              </div>
              {pathListing?.dir && (
                <div className="mention-dir" title={pathListing.dir}>
                  {pathListing.dir}
                </div>
              )}
              {atLoading && <div className="mention-empty">Loading files…</div>}
              {!atLoading && pathListing?.error && (
                <div className="mention-empty">{pathListing.error}</div>
              )}
              {!atLoading && !pathListing?.error && atOptions.length === 0 && (
                <div className="mention-empty">
                  {pathParts ? (
                    `Nothing here matches “${pathParts.partial}”`
                  ) : (
                    <>
                      No files match “{atQuery}”
                      <span className="mention-hint">
                        To reference something outside the project, type ../ or a full path.
                      </span>
                    </>
                  )}
                </div>
              )}
              {atOptions.map((o, i) => (
                <button
                  key={o.key}
                  type="button"
                  role="option"
                  aria-selected={i === atSel}
                  className={`mention-opt${i === atSel ? ' mention-opt--on' : ''}`}
                  onMouseEnter={() => setAtIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickMention(o)
                  }}
                >
                  <span
                    className={`codicon codicon-${o.kind === 'file' ? 'file' : o.kind === 'dir' ? 'folder' : 'folder-opened'} mention-ico`}
                    aria-hidden="true"
                  />
                  <span className="mention-name">{o.name}</span>
                  <span className="mention-path">{o.detail}</span>
                </button>
              ))}
            </div>
          )}
          {onPickRemove && (
            <PickTray
              picks={picks}
              onRemove={onPickRemove}
              onFocus={onPickFocus}
              onOpen={onPickShot ? (id) => setMarking({ pick: id }) : undefined}
            />
          )}
          <DataTray
            sources={dataChips}
            onOpen={() => setConnect({})}
            onRemove={(id) => setDataChips(dataChips.filter((s) => s.item.id !== id))}
          />
          <FileTray
            files={fileChips}
            onRemove={(path) => changeFileChips((files) => files.filter((f) => f.path !== path))}
          />
          {((attachments?.length ?? 0) > 0 || attaching) && (
            <div className="chat-attachments">
              {(attachments ?? []).map((a) => (
                <div key={a.path} className="chat-attachment">
                  <button
                    type="button"
                    className="chat-attachment-open"
                    onClick={() => setMarking({ path: a.path })}
                    title={onReplaceAttachment ? 'Show it larger and draw on it' : 'Show it larger'}
                  >
                    <img src={a.thumb} alt="Screenshot to send" draggable={false} />
                    {onReplaceAttachment && (
                      <span className="chat-attachment-draw" aria-hidden="true">
                        <PenIcon />
                      </span>
                    )}
                  </button>
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
          {imageNote && (attachments?.length ?? 0) > 0 && (
            <p className="chat-attachments-note" role="note">
              <Codicon name="warning" />
              {imageNote}. Remove the images, or choose a model that can.
            </p>
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
                picks.length > 0
                  ? picks.length === 1
                    ? `Say how to change ${picks[0].target.label}, or press Enter to polish it`
                    : `Say how to change these ${picks.length}, or press Enter to polish them`
                  : dataChips.length > 0
                    ? 'Say what to build with this data, or just press Enter to connect it'
                    : fileChips.length > 0
                      ? 'Say what to do with these, or just press Enter to send them'
                      : `Message Fabricator about ${project.name}…`
              }
              value={input}
              rows={1}
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
                attaching={attaching}
                imageNote={imageNote}
                onImage={() => fileRef.current?.click()}
                onConnectData={(kind) => setConnect({ kind })}
                onBrowse={() => void browse()}
              />
              <PluginsMenu
                plugins={offeredPlugins(experiments)}
                servers={mcpServers}
                on={plugins}
                disabled={sending}
                onToggle={togglePlugin}
                onManageServers={onManageMcpServers}
                onLearnMore={() => openDocs('plugins')}
              />
              <ModelPicker
                value={selection}
                disabled={sending}
                onChange={saveOptions}
                tiers
                onManageKeys={onManageKeys}
              />
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
                    disabled={!input.trim()}
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
                  title={
                    submitBlocked
                      ? submitBlockedTitle
                      : imagesBlocked
                        ? `${imageNote}. Remove the images, or choose a model that can.`
                        : undefined
                  }
                >
                  <button
                    type="button"
                    className="composer-send"
                    onClick={send}
                    disabled={
                      submitBlocked ||
                      pickSending ||
                      imagesBlocked ||
                      (!input.trim() &&
                        (attachments?.length ?? 0) === 0 &&
                        picks.length === 0 &&
                        dataChips.length === 0 &&
                        fileChips.length === 0)
                    }
                    title={
                      submitBlocked || imagesBlocked
                        ? undefined
                        : picks.length > 0
                          ? `Send, with ${picks.length === 1 ? 'the picked element' : `the ${picks.length} picked elements`} (Enter)`
                          : dataChips.length > 0
                            ? `Send, and connect ${dataChips.length === 1 ? 'this data' : `these ${dataChips.length} data sources`} (Enter)`
                            : 'Send (Enter)'
                    }
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

      {marked &&
        (marking && ('path' in marking ? onReplaceAttachment : onPickShot) ? (
          <ImageMarkup
            src={marked.shot.thumb}
            loadFull={() => window.api.screenshot.read(marked.shot.path)}
            label={marked.label}
            onCancel={() => setMarking(null)}
            onDone={(drawn) => {
              setMarking(null)
              if (drawn && marking) void keepDrawing(marking, drawn)
            }}
          />
        ) : (
          <ImageViewer images={[marked.shot.thumb]} onClose={() => setMarking(null)} />
        ))}
      {connect && (
        <ConnectDataModal
          project={project}
          kind={connect.kind}
          appWorkspaces={recentWorkspaces}
          picked={dataChips}
          onClose={() => setConnect(null)}
          onSignedIn={onCopilotAuthChanged}
          onAdd={(sources) => {
            setDataChips(sources)
            taRef.current?.focus()
          }}
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
