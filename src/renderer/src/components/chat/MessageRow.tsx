import { memo, useCallback, useMemo } from 'react'
import { MentionText } from '../MentionText'
import PlanCard from '../PlanCard'
import { Codicon, ImageIcon } from '../icons'
import { AgentStatus } from './AgentStatus'
import { AgentQuestionBlock, AssistantBody } from './AssistantBody'
import { CopyButton } from './CopyButton'
import { formatClock, formatFullDate } from './format'
import { TurnFooter } from './TurnFooter'
import type { UIChatMessage } from './types'

/** Your message: a tinted bubble on the right, with its time and Copy on hover. */
function UserMessage({
  message: m,
  onOpenMention
}: {
  message: UIChatMessage
  onOpenMention?: (ref: string) => void
}): JSX.Element {
  const hasText = Boolean(m.text) && m.text !== '(screenshot)'
  return (
    <div className="turn turn--user">
      <div className="turn-main">
        {m.attachmentThumbs && m.attachmentThumbs.length > 0 ? (
          <div className="msg-shots">
            {m.attachmentThumbs.map((src, i) => (
              <img key={i} className="msg-shot" src={src} alt="Screenshot attachment" />
            ))}
          </div>
        ) : m.attachments ? (
          <div className="msg-attach">
            <ImageIcon className="msg-attach-ico" />
            {m.attachments} screenshot{m.attachments > 1 ? 's' : ''}
          </div>
        ) : null}
        {hasText && (
          <div className="msg-text user-bubble">
            <MentionText text={m.text} onOpen={onOpenMention} />
          </div>
        )}
        {(hasText || m.createdAt != null) && (
          <div className="msg-meta">
            {m.createdAt != null && (
              <time
                dateTime={new Date(m.createdAt).toISOString()}
                title={formatFullDate(m.createdAt)}
              >
                {formatClock(m.createdAt)}
              </time>
            )}
            {hasText && (
              <CopyButton text={m.text} compact title="Copy message" className="msg-meta-copy" />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One conversation row (assistant or user turn), memoized so the thousands of
 * state updates a streaming turn produces only re-render the *one* turn that
 * changed — completed turns keep their object identity (see `reduce`) and
 * therefore skip re-rendering entirely. Callbacks must be referentially stable
 * (the parent passes `useCallback`-wrapped wrappers) and the `can*` flags are
 * precomputed primitives, so memo's shallow compare holds for settled turns.
 */
export const MessageRow = memo(function MessageRow({
  message: m,
  projectName,
  projectPath,
  latest,
  canRetry,
  onRetry,
  canResume,
  onResume,
  canTryAgain,
  onTryAgain,
  planBusy,
  questionBusy,
  onChangePlanContent,
  onResolvePlan,
  onAnswerPlanQuestion,
  onResumePlan,
  onExportPlan,
  onOpenMention
}: {
  message: UIChatMessage
  projectName: string
  projectPath: string
  /** The newest assistant turn keeps its actions visible. */
  latest: boolean
  canRetry: boolean
  onRetry: (id: string) => void
  canResume: boolean
  onResume: (id: string) => void
  canTryAgain: boolean
  onTryAgain: (id: string) => void
  planBusy: boolean
  questionBusy: boolean
  onChangePlanContent: (msgId: string, content: string) => void
  onResolvePlan: (msgId: string, action: string, feedback?: string) => void
  onAnswerPlanQuestion: (
    msgId: string,
    requestId: string,
    answer: string,
    wasFreeform: boolean
  ) => void
  onResumePlan: (
    msgId: string,
    kind: 'review' | 'execute' | 'revise',
    action?: string,
    feedback?: string
  ) => void
  onExportPlan: (msgId: string, content: string) => Promise<void> | void
  onOpenMention?: (ref: string) => void
}): JSX.Element {
  const answerQuestion = useCallback(
    (requestId: string, answer: string, wasFreeform: boolean) =>
      onAnswerPlanQuestion(m.id, requestId, answer, wasFreeform),
    [onAnswerPlanQuestion, m.id]
  )
  const tryAgain = useCallback(() => onTryAgain(m.id), [onTryAgain, m.id])
  // Questions the feed already docks in place (via a `'question'` segment) are
  // rendered there; anything left over — legacy turns persisted before segment
  // anchoring — still falls back to a block at the end of the turn.
  const unanchoredQuestions = useMemo(() => {
    const all = m.questions ?? []
    if (all.length === 0) return all
    const anchored = new Set(
      (m.segments ?? []).flatMap((s) => (s.kind === 'question' ? [s.id] : []))
    )
    return anchored.size === 0 ? all : all.filter((q) => !anchored.has(q.id))
  }, [m.questions, m.segments])

  if (m.role === 'user') return <UserMessage message={m} onOpenMention={onOpenMention} />

  return (
    <div className={`turn turn--assistant${m.pending ? ' turn--live' : ''}`}>
      <div className="turn-main">
        <AssistantBody
          message={m}
          projectPath={projectPath}
          questionBusy={questionBusy}
          onAnswerQuestion={answerQuestion}
          onOpenFile={onOpenMention}
        />
        {m.plan && (
          <PlanCard
            plan={m.plan}
            projectName={projectName}
            busy={planBusy}
            onContentChange={(content) => onChangePlanContent(m.id, content)}
            onResolve={(action, feedback) => onResolvePlan(m.id, action, feedback)}
            onAnswerQuestion={(requestId, answer, wasFreeform) =>
              onAnswerPlanQuestion(m.id, requestId, answer, wasFreeform)
            }
            onResume={(kind, action, feedback) => onResumePlan(m.id, kind, action, feedback)}
            onExport={(content) => onExportPlan(m.id, content)}
          />
        )}
        {unanchoredQuestions.length > 0 && (
          <AgentQuestionBlock
            questions={unanchoredQuestions}
            busy={questionBusy}
            error={m.questionError}
            onAnswer={answerQuestion}
          />
        )}
        {m.notice && !m.pending && (
          <div className="msg-notice">
            <Codicon name="refresh" /> {m.notice}
          </div>
        )}
        {m.pending && (
          <AgentStatus
            message={m}
            notice={m.notice}
            awaitingDecision={Boolean(
              m.plan && (m.plan.phase === 'review' || m.plan.phase === 'clarifying')
            )}
            startedAt={m.startedAt}
          />
        )}
        {m.error && !m.plan && (
          <div className="msg-error" role="alert">
            <Codicon name="error" />
            <span className="msg-error-text">{m.error}</span>
            {canRetry && !m.designApplyId && (
              <button
                type="button"
                className="btn btn--xs btn--ghost msg-error-retry"
                onClick={() => onRetry(m.id)}
                title="Re-send this message"
              >
                <Codicon name="refresh" /> Retry
              </button>
            )}
          </div>
        )}
        {m.interrupted && !m.plan && !m.pending && !m.error && (
          <div className="msg-interrupted">
            <Codicon name="debug-pause" />
            <span className="msg-interrupted-text">
              This response was interrupted when the app closed.
            </span>
            {canResume && !m.designApplyId && (
              <button
                type="button"
                className="btn btn--xs btn--ghost msg-interrupted-resume"
                onClick={() => onResume(m.id)}
                title="Re-run this prompt and continue"
              >
                <Codicon name="debug-continue" /> Resume
              </button>
            )}
          </div>
        )}
        {m.designApplyId && !m.pending && (m.error || m.interrupted) && (
          <div className="msg-notice">
            Open Design Studio to review or recover this Apply. Its source changes will not be
            replayed from chat.
          </div>
        )}
        {!m.pending && (
          <TurnFooter
            message={m}
            projectPath={projectPath}
            latest={latest}
            onOpenFile={onOpenMention}
            onTryAgain={canTryAgain ? tryAgain : undefined}
          />
        )}
      </div>
    </div>
  )
})
