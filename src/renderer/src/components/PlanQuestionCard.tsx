import { useId, useState } from 'react'
import type { ChatPlanQuestion } from '@shared/ipc'
import { Codicon } from './icons'

export interface PlanQuestionCardProps {
  question: ChatPlanQuestion
  busy?: boolean
  onAnswer: (requestId: string, answer: string, wasFreeform: boolean) => void
}

/**
 * One clarifying question the planner asked before it could draft a plan.
 * Pending questions show its choices (if any) plus a freeform box when the
 * question allows one; answered questions collapse to a compact recap so the
 * conversation stays scannable once the user has responded.
 */
export default function PlanQuestionCard({
  question,
  busy = false,
  onAnswer
}: PlanQuestionCardProps): JSX.Element {
  const fieldId = useId()
  const [freeform, setFreeform] = useState('')

  if (question.state !== 'pending') {
    const interrupted = question.state === 'interrupted'
    return (
      <div
        className={`chat-plan-question chat-plan-question--${interrupted ? 'interrupted' : 'answered'}`}
      >
        <div className="chat-plan-question-text">
          <Codicon
            name={interrupted ? 'circle-slash' : 'check'}
            className="chat-plan-question-answered-ico"
          />
          {question.question}
        </div>
        <div className="chat-plan-question-answer">
          {question.answer || 'Not answered before the planning turn was interrupted.'}
        </div>
      </div>
    )
  }

  const canSubmitFreeform = freeform.trim().length > 0 && !busy

  return (
    <div className="chat-plan-question">
      <div className="chat-plan-question-text">{question.question}</div>
      {question.choices && question.choices.length > 0 && (
        <div className="chat-plan-question-choices">
          {question.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className="chat-plan-choice"
              disabled={busy}
              onClick={() => onAnswer(question.id, choice, false)}
            >
              {choice}
            </button>
          ))}
        </div>
      )}
      {question.allowFreeform && (
        <div className="chat-plan-question-freeform">
          <label className="chat-plan-question-freeform-label" htmlFor={fieldId}>
            {question.choices && question.choices.length > 0 ? 'Or answer in your own words' : 'Your answer'}
          </label>
          <textarea
            id={fieldId}
            className="chat-plan-feedback"
            rows={2}
            placeholder="Type an answer…"
            value={freeform}
            disabled={busy}
            onChange={(e) => setFreeform(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && canSubmitFreeform) {
                e.preventDefault()
                onAnswer(question.id, freeform.trim(), true)
                setFreeform('')
              }
            }}
          />
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={!canSubmitFreeform}
            onClick={() => {
              if (!canSubmitFreeform) return
              onAnswer(question.id, freeform.trim(), true)
              setFreeform('')
            }}
          >
            Send answer
          </button>
        </div>
      )}
    </div>
  )
}
