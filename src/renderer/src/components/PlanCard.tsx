import { useMemo, useState } from 'react'
import type { ChatPlanArtifact, ChatPlanPhase, ChatPlanTodo, ChatPlanTodoStatus } from '@shared/ipc'
import { completedPlanTodos, planActionLabel, planProgress } from '../chatPlan'
import Markdown from './Markdown'
import { Codicon } from './icons'
import PlanQuestionCard from './PlanQuestionCard'
import PlanReviewDialog from './PlanReviewDialog'

export interface PlanCardProps {
  plan: ChatPlanArtifact
  projectName: string
  busy?: boolean
  onContentChange: (content: string) => void
  onResolve: (action: string, feedback?: string) => void
  onAnswerQuestion: (requestId: string, answer: string, wasFreeform: boolean) => void
  onResume: (kind: 'review' | 'execute' | 'revise', action?: string, feedback?: string) => void
  onExport: (content: string) => Promise<void> | void
}

/** Continuation actions the SDK can grant, in a stable preference order. */
const KNOWN_ACTIONS = ['interactive', 'autopilot', 'autopilot_fleet', 'exit_only'] as const

/**
 * The one recommended, SDK-allowed action to show as the primary button.
 * Unknown actions are never promoted to primary: if the recommendation isn't a
 * known action allowed for this plan, prefer `interactive` when it's allowed,
 * otherwise fall back to the first known allowed action. Returns `undefined`
 * only when none of the allowed actions are recognized.
 */
export function primaryPlanAction(plan: Pick<ChatPlanArtifact, 'actions' | 'recommendedAction'>): string | undefined {
  const known = KNOWN_ACTIONS.filter((a) => plan.actions.includes(a))
  if (known.length === 0) return undefined
  if (plan.recommendedAction && (known as readonly string[]).includes(plan.recommendedAction)) {
    return plan.recommendedAction
  }
  return known.includes('interactive') ? 'interactive' : known[0]
}

/**
 * Remaining known, SDK-allowed actions besides the chosen primary. Unknown
 * action strings are excluded here too: the backend treats anything outside
 * `KNOWN_ACTIONS` as rejection/revision, so surfacing it as a selectable
 * alternate could let a user accidentally reject the plan.
 */
export function alternatePlanActions(
  plan: Pick<ChatPlanArtifact, 'actions'>,
  primary: string | undefined
): string[] {
  return KNOWN_ACTIONS.filter((a) => plan.actions.includes(a) && a !== primary)
}

const TODO_META: Record<ChatPlanTodoStatus, { icon: string; label: string }> = {
  pending: { icon: 'circle-large-outline', label: 'Pending' },
  in_progress: { icon: 'sync', label: 'In progress' },
  done: { icon: 'check', label: 'Done' },
  blocked: { icon: 'circle-slash', label: 'Blocked' }
}

const PHASE_META: Record<ChatPlanPhase, { icon: string; title: string; spin?: boolean }> = {
  researching: { icon: 'compass', title: 'Researching the codebase…', spin: true },
  clarifying: { icon: 'question', title: 'A few questions before drafting' },
  drafting: { icon: 'edit', title: 'Drafting the plan…' },
  review: { icon: 'checklist', title: 'Plan ready for review' },
  revising: { icon: 'sync', title: 'Revising the plan…', spin: true },
  executing: { icon: 'play', title: 'Executing the plan' },
  completed: { icon: 'check-all', title: 'Plan completed' },
  failed: { icon: 'error', title: 'Plan failed' },
  interruptedReview: { icon: 'circle-slash', title: 'Review was interrupted' },
  interruptedExecution: { icon: 'circle-slash', title: 'Execution was interrupted' }
}

function firstRemainingTodo(todos: ChatPlanTodo[]): ChatPlanTodo | undefined {
  return todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status !== 'done')
}

/**
 * The inline Plan-mode card rendered on an assistant turn. Shows the plan's
 * current phase, its structured todo progress, and whatever action the phase
 * calls for — answering clarifying questions, approving/revising a proposed
 * plan, resuming after an interruption, or a compact completed/failed recap.
 * "Review full plan" opens `PlanReviewDialog` for the full markdown + edit view.
 */
export default function PlanCard({
  plan,
  projectName,
  busy = false,
  onContentChange,
  onResolve,
  onAnswerQuestion,
  onResume,
  onExport
}: PlanCardProps): JSX.Element {
  const [todosExpanded, setTodosExpanded] = useState(false)
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [showFull, setShowFull] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [executionExpanded, setExecutionExpanded] = useState(false)

  const meta = PHASE_META[plan.phase]
  const displayTodos = useMemo(
    () => (plan.phase === 'completed' ? completedPlanTodos(plan.todos) : plan.todos),
    [plan.phase, plan.todos]
  )
  const displayPlan = useMemo(
    () => (displayTodos === plan.todos ? plan : { ...plan, todos: displayTodos }),
    [displayTodos, plan]
  )
  const progress = useMemo(() => planProgress(displayTodos), [displayTodos])
  const current = useMemo(() => firstRemainingTodo(displayTodos), [displayTodos])
  const primary = useMemo(() => primaryPlanAction(plan), [plan.actions, plan.recommendedAction])
  const alternates = useMemo(() => alternatePlanActions(plan, primary), [plan.actions, primary])

  const isReviewLike = plan.phase === 'review'
  const isRecoveredReview = plan.phase === 'interruptedReview'
  const hasContent = plan.content.trim().length > 0
  const hasUnansweredQuestions = plan.questions.some((q) => q.state !== 'answered')
  const canReviewRecovered = isRecoveredReview && hasContent && !hasUnansweredQuestions
  const visibleTodos = todosExpanded ? displayTodos : displayTodos.slice(0, 5)

  const approve = isRecoveredReview
    ? (action: string): void => onResume('review', action)
    : (action: string): void => onResolve(action)
  const requestChanges = isRecoveredReview
    ? (fb?: string): void => onResume('revise', undefined, fb)
    : (fb?: string): void => onResolve('keep_planning', fb)

  async function copyPlan(): Promise<void> {
    try {
      await navigator.clipboard.writeText(plan.content)
      setCopied(true)
      setCopyError(null)
      setTimeout(() => setCopied(false), 1200)
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : 'Could not copy the plan to the clipboard.')
    }
  }

  if (plan.phase === 'executing' && !executionExpanded) {
    return (
      <div className="chat-plan-card chat-plan-card--executing chat-plan-card--compact">
        <button
          type="button"
          className="chat-plan-compact-toggle"
          aria-label="Expand plan progress"
          aria-expanded={false}
          onClick={() => setExecutionExpanded(true)}
        >
          <span className="chat-plan-icon" aria-hidden="true">
            <Codicon name="sync" className="chat-plan-spin" />
          </span>
          <span className="chat-plan-compact-title">Executing plan</span>
          <span className="chat-plan-compact-current" title={current?.title}>
            {current?.title || 'Working through the approved plan'}
          </span>
          {progress.total > 0 && (
            <span className="chat-plan-compact-progress">
              {progress.done}/{progress.total}
            </span>
          )}
          <Codicon name="chevron-down" className="chat-plan-compact-chevron" />
        </button>
      </div>
    )
  }

  return (
    <div className={`chat-plan-card chat-plan-card--${plan.phase}${busy ? ' chat-plan-card--busy' : ''}`}>
      <div className="chat-plan-head">
        <span className="chat-plan-icon" aria-hidden="true">
          <Codicon name={meta.icon} className={meta.spin ? 'chat-plan-spin' : undefined} />
        </span>
        <span className="chat-plan-title">{meta.title}</span>
        {plan.revisionCount ? (
          <span className="chat-plan-phase-badge">Revision {plan.revisionCount}</span>
        ) : null}
        {plan.phase === 'executing' && (
          <button
            type="button"
            className="chat-plan-collapse"
            aria-label="Collapse plan progress"
            aria-expanded={true}
            onClick={() => setExecutionExpanded(false)}
          >
            <Codicon name="chevron-up" /> Collapse
          </button>
        )}
      </div>

      {plan.summary && (
        <div className="chat-plan-summary md">
          <Markdown>{plan.summary}</Markdown>
        </div>
      )}

      {progress.total > 0 && (
        <div className="chat-plan-progress">
          <div
            className="chat-plan-progress-bar"
            role="progressbar"
            aria-label="Plan progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            aria-valuetext={`${progress.done} of ${progress.total} steps done`}
          >
            <div className="chat-plan-progress-fill" style={{ width: `${progress.percent}%` }} />
          </div>
          <span className="chat-plan-progress-label">
            {progress.done} of {progress.total} steps done
          </span>
        </div>
      )}

      {current && (plan.phase === 'executing' || plan.phase === 'interruptedExecution' || plan.phase === 'failed') && (
        <div className="chat-plan-current">
          <span className="chat-plan-current-label">Now:</span> {current.title}
        </div>
      )}

      {displayTodos.length > 0 && (
        <div className="chat-plan-todos">
          {visibleTodos.map((todo) => {
            const todoMeta = TODO_META[todo.status]
            return (
              <div key={todo.id} className={`chat-plan-todo chat-plan-todo--${todo.status}`}>
                <Codicon
                  name={todoMeta.icon}
                  className={`chat-plan-todo-ico${todo.status === 'in_progress' ? ' chat-plan-spin' : ''}`}
                />
                <span className="chat-plan-todo-title">{todo.title}</span>
              </div>
            )
          })}
          {displayTodos.length > 5 && (
            <button
              type="button"
              className="chat-plan-toggle"
              onClick={() => setTodosExpanded((v) => !v)}
              aria-expanded={todosExpanded}
            >
              {todosExpanded ? (
                <>
                  <Codicon name="chevron-down" /> Show fewer
                </>
              ) : (
                <>
                  <Codicon name="chevron-right" /> Show all {displayTodos.length} steps
                </>
              )}
            </button>
          )}
        </div>
      )}

      {plan.error && (
        <div className="chat-plan-error">
          <Codicon name="warning" /> {plan.error}
        </div>
      )}

      {plan.questions.length > 0 && (
        <div className="chat-plan-questions">
          {plan.questions.map((q) => (
            <PlanQuestionCard key={q.id} question={q} busy={busy} onAnswer={onAnswerQuestion} />
          ))}
        </div>
      )}

      {(isReviewLike || (isRecoveredReview && hasContent)) && (
        <>
          {hasContent && (
            <div className="chat-plan-toolrow">
              <button type="button" className="chat-plan-tool-btn" onClick={() => void copyPlan()}>
                <Codicon name="copy" /> {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                className="chat-plan-tool-btn"
                disabled={busy}
                onClick={() => void onExport(plan.content)}
              >
                <Codicon name="desktop-download" /> Export
              </button>
              <button type="button" className="chat-plan-tool-btn" onClick={() => setShowFull(true)}>
                <Codicon name="diff" /> Review full plan
              </button>
            </div>
          )}
          {copyError && (
            <div className="chat-plan-error">
              <Codicon name="warning" /> {copyError}
            </div>
          )}

          {(isReviewLike || canReviewRecovered) && (
            <>
              <div className="chat-plan-actions">
                {primary && (
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={busy}
                    onClick={() => approve(primary)}
                  >
                    {planActionLabel(primary)}
                  </button>
                )}
                {alternates.length > 0 && (
                  <select
                    className="chat-plan-alt-select"
                    aria-label="Other plan actions"
                    disabled={busy}
                    value=""
                    onChange={(e) => {
                      const action = e.target.value
                      if (action) approve(action)
                      e.target.value = ''
                    }}
                  >
                    <option value="" disabled>
                      {primary ? 'More options…' : 'Choose an action…'}
                    </option>
                    {alternates.map((a) => (
                      <option key={a} value={a}>
                        {planActionLabel(a)}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  disabled={busy}
                  onClick={() => setRevising((v) => !v)}
                >
                  Request changes
                </button>
              </div>

              {revising && (
                <div className="chat-plan-revise">
                  <textarea
                    className="chat-plan-feedback"
                    placeholder="Optional — what should change about the plan?"
                    value={feedback}
                    rows={2}
                    disabled={busy}
                    onChange={(e) => setFeedback(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={busy}
                    onClick={() => {
                      requestChanges(feedback.trim() || undefined)
                      setFeedback('')
                      setRevising(false)
                    }}
                  >
                    Send feedback
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {isRecoveredReview && (!hasContent || hasUnansweredQuestions) && (
        <div className="chat-plan-actions">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={busy}
            onClick={() => onResume('review')}
          >
            Continue planning
          </button>
        </div>
      )}

      {(plan.phase === 'interruptedExecution' ||
        (plan.phase === 'failed' && plan.selectedAction)) && (
        <div className="chat-plan-actions">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={busy}
            onClick={() => onResume('execute', plan.selectedAction)}
          >
            Resume remaining work
          </button>
        </div>
      )}

      {plan.phase === 'failed' && !plan.selectedAction && (
        <div className="chat-plan-actions">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={busy}
            onClick={() => onResume('review')}
          >
            Retry planning
          </button>
        </div>
      )}

      {(plan.phase === 'completed' || plan.phase === 'executing') && hasContent && (
        <div className="chat-plan-toolrow">
          <button type="button" className="chat-plan-tool-btn" onClick={() => setShowFull(true)}>
            <Codicon name="diff" /> Review full plan
          </button>
        </div>
      )}

      {showFull && (
        <PlanReviewDialog
          plan={displayPlan}
          projectName={projectName}
          busy={busy}
          editable={isReviewLike || isRecoveredReview}
          approvable={isReviewLike || canReviewRecovered}
          primaryAction={primary}
          alternateActions={alternates}
          onClose={() => setShowFull(false)}
          onContentChange={onContentChange}
          onApprove={(action) => {
            approve(action)
            setShowFull(false)
          }}
          onRequestChanges={(fb) => {
            requestChanges(fb)
            setShowFull(false)
          }}
          onExport={onExport}
        />
      )}
    </div>
  )
}
