import { useId, useState } from 'react'
import type { ChatPlanQuestion } from '@shared/ipc'
import { Codicon } from './icons'

export interface PlanQuestionCardProps {
  question: ChatPlanQuestion
  busy?: boolean
  onAnswer: (requestId: string, answer: string, wasFreeform: boolean) => void
}

const RECOMMENDED = /\s*\(recommended\)\s*$/i

/** Split a trailing "(Recommended)" off a choice so it can show as a badge. */
function splitRecommended(text: string): { label: string; recommended: boolean } {
  const m = RECOMMENDED.exec(text)
  return m
    ? { label: text.slice(0, m.index).trim(), recommended: true }
    : { label: text, recommended: false }
}

/**
 * One clarifying question from the agent. Pending questions offer their
 * choices (if any) plus a freeform box when allowed; answered ones collapse to
 * a compact exchange: the question, then your answer in your own bubble.
 */
export default function PlanQuestionCard({
  question,
  busy = false,
  onAnswer
}: PlanQuestionCardProps): JSX.Element {
  const fieldId = useId()
  const [freeform, setFreeform] = useState('')

  if (question.state !== 'pending') {
    const answer = question.answer ? splitRecommended(question.answer).label : ''
    return (
      <div
        className={`chat-plan-question chat-plan-question--${question.state === 'interrupted' ? 'interrupted' : 'answered'}`}
      >
        <div className="chat-plan-question-asked">
          <Codicon name="comment-discussion" className="chat-plan-question-asked-ico" />
          <span>{question.question}</span>
        </div>
        {answer ? (
          <div className="chat-plan-question-reply">{answer}</div>
        ) : question.state === 'interrupted' ? (
          <div className="chat-plan-question-missed">
            Not answered before the turn was interrupted.
          </div>
        ) : null}
      </div>
    )
  }

  const canSubmitFreeform = freeform.trim().length > 0 && !busy
  const submit = (): void => {
    if (!canSubmitFreeform) return
    onAnswer(question.id, freeform.trim(), true)
    setFreeform('')
  }
  const hasChoices = Boolean(question.choices && question.choices.length > 0)

  return (
    <div className="chat-plan-question">
      <div className="chat-plan-question-text">{question.question}</div>
      {hasChoices && (
        <div className="chat-plan-question-choices">
          {question.choices!.map((choice) => {
            const { label, recommended } = splitRecommended(choice)
            return (
              <button
                key={choice}
                type="button"
                className={`chat-plan-choice${recommended ? ' chat-plan-choice--recommended' : ''}`}
                disabled={busy}
                onClick={() => onAnswer(question.id, choice, false)}
              >
                <span className="chat-plan-choice-label">{label}</span>
                {recommended && <span className="chat-plan-choice-badge">Recommended</span>}
              </button>
            )
          })}
        </div>
      )}
      {question.allowFreeform && (
        <div className="chat-plan-question-freeform">
          <label className="chat-plan-question-freeform-label" htmlFor={fieldId}>
            {hasChoices ? 'Or answer in your own words' : 'Your answer'}
          </label>
          <div className="chat-plan-question-freeform-row">
            <textarea
              id={fieldId}
              className="chat-plan-feedback"
              rows={1}
              placeholder="Type an answer…"
              value={freeform}
              disabled={busy}
              onChange={(e) => setFreeform(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && canSubmitFreeform) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!canSubmitFreeform}
              onClick={submit}
            >
              Send answer
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
