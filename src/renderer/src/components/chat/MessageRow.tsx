import { memo, useCallback, useMemo, type JSX } from 'react'
import { useTranslation } from '../../i18n'
import { SentPicks, pickShotIndexes } from '../../pick/PickTray'
import { AdvisorFixSummary } from '../advisor/AdvisorFixSummary'
import { MentionText } from '../MentionText'
import PlanCard from '../PlanCard'
import { Codicon, ImageIcon } from '../icons'
import { AgentStatus } from './AgentStatus'
import { AgentQuestionBlock, AssistantBody } from './AssistantBody'
import { CopyButton } from './CopyButton'
import { SentData, SentMigration } from './DataTray'
import { SentFiles } from './FileTray'
import { formatClock, formatFullDate } from './format'
import { ShotStrip, useImageViewer } from './ImageViewer'
import { TurnFooter } from './TurnFooter'
import type { UIChatMessage } from './types'

/** Messages the app sends for you when a plan resumes: stored (and re-sent) in
 *  English, shown in your language. */
const APP_MESSAGES = {
  'Resume the approved plan': 'messageRow.resumeApprovedPlan',
  'Revise the recovered plan': 'messageRow.reviseRecoveredPlan',
  'Resume planning': 'messageRow.resumePlanning'
} as const

function appMessage(text: string): (typeof APP_MESSAGES)[keyof typeof APP_MESSAGES] | undefined {
  return Object.prototype.hasOwnProperty.call(APP_MESSAGES, text)
    ? APP_MESSAGES[text as keyof typeof APP_MESSAGES]
    : undefined
}

/** Your message: a tinted bubble on the right, with its time and Copy on hover.
 *  An Advisor hand-off shows as its card instead of the bubble. */
function UserMessage({
  message: m,
  working,
  onOpenMention
}: {
  message: UIChatMessage
  working: boolean
  onOpenMention?: (ref: string) => void
}): JSX.Element {
  const { t } = useTranslation('chat')
  const hasText = Boolean(m.text) && m.text !== '(screenshot)'
  const appKey = appMessage(m.text)
  const text = appKey ? t(appKey) : m.text
  const thumbs = m.attachmentThumbs ?? []
  // Picked elements show their pictures in their chips; the strip keeps the rest.
  const pickShots = m.picks ? pickShotIndexes(m.picks) : null
  const shots = thumbs.flatMap((_, i) => (pickShots?.has(i) ? [] : [i]))
  // Any of the message's pictures opens large, with the rest a step away.
  const { open, viewer } = useImageViewer(m.attachmentThumbs)
  return (
    <div className="turn turn--user">
      <div className="turn-main">
        {m.picks && m.picks.length > 0 && (
          <SentPicks picks={m.picks} thumbs={m.attachmentThumbs} onOpen={open} />
        )}
        {m.advisor && <AdvisorFixSummary summary={m.advisor} prompt={m.prompt} working={working} />}
        {shots.length > 0 ? (
          <ShotStrip images={thumbs} indexes={shots} onOpen={open} />
        ) : m.attachments && !m.picks ? (
          <div className="msg-attach">
            <ImageIcon className="msg-attach-ico" />
            {t('messageRow.screenshots', { count: m.attachments })}
          </div>
        ) : null}
        {m.data && m.data.length > 0 && <SentData data={m.data} />}
        {m.files && m.files.length > 0 && <SentFiles files={m.files} />}
        {m.migration && <SentMigration migration={m.migration} />}
        {hasText && !m.advisor && (
          <div className="msg-text user-bubble">
            <MentionText text={text} onOpen={onOpenMention} />
          </div>
        )}
        {viewer}
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
              <CopyButton
                text={text}
                compact
                title={t('copyButton.copyMessage')}
                className="msg-meta-copy"
              />
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
  working = false,
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
  /** (User messages) the turn this message started is still running. */
  working?: boolean
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
  const { t } = useTranslation('chat')
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

  if (m.role === 'user') return <UserMessage message={m} working={working} onOpenMention={onOpenMention} />

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
            {canRetry && (
              <button
                type="button"
                className="btn btn--xs btn--ghost msg-error-retry"
                onClick={() => onRetry(m.id)}
                title={t('messageRow.resend')}
              >
                <Codicon name="refresh" /> {t('actions.retry')}
              </button>
            )}
          </div>
        )}
        {m.interrupted && !m.plan && !m.pending && !m.error && (
          <div className="msg-interrupted">
            <Codicon name="debug-pause" />
            <span className="msg-interrupted-text">{t('messageRow.interrupted')}</span>
            {canResume && (
              <button
                type="button"
                className="btn btn--xs btn--ghost msg-interrupted-resume"
                onClick={() => onResume(m.id)}
                title={t('messageRow.resumeTitle')}
              >
                <Codicon name="debug-continue" /> {t('messageRow.resume')}
              </button>
            )}
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
