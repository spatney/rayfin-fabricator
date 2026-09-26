import { useMemo } from 'react'
import type { ChatPlanQuestion, ChatSegment } from '@shared/ipc'
import Markdown from '../Markdown'
import PlanQuestionCard from '../PlanQuestionCard'
import { Codicon } from '../icons'
import { ThinkingRow } from './ThinkingRow'
import { layoutTurn } from './turnLayout'
import type { UIChatMessage } from './types'
import { WorkLog } from './WorkLog'

/**
 * The "Fabricator needs your input" card for a standalone Agent-mode `ask_user`
 * question. Rendered inline in the turn feed at the point the question was
 * asked (see the `'question'` segment) so it stays docked there as the rest of
 * the turn streams in below it.
 */
export function AgentQuestionBlock({
  questions,
  busy,
  error,
  onAnswer
}: {
  questions: ChatPlanQuestion[]
  busy: boolean
  error?: string
  onAnswer: (requestId: string, answer: string, wasFreeform: boolean) => void
}): JSX.Element {
  const waiting = questions.some((q) => q.state === 'pending')
  return (
    <div className={`chat-agent-questions${waiting ? '' : ' chat-agent-questions--done'}`}>
      {waiting && (
        <div className="chat-agent-questions-head">
          <Codicon name="comment-discussion" /> Fabricator needs your input
        </div>
      )}
      {questions.map((q) => (
        <PlanQuestionCard key={q.id} question={q} busy={busy} onAnswer={onAnswer} />
      ))}
      {error && (
        <div className="chat-agent-questions-error">
          <Codicon name="warning" /> {error}
        </div>
      )}
    </div>
  )
}

/** A message the user sent while the turn was running (conversation steering). */
function Interjection({
  seg
}: {
  seg: Extract<ChatSegment, { kind: 'interjection' }>
}): JSX.Element {
  return (
    <div className="turn-interject">
      <span className="turn-interject-tag">You added</span>
      <div className="turn-interject-text">
        <Markdown>{seg.text}</Markdown>
        {seg.thumbs && seg.thumbs.length > 0 && (
          <div className="msg-shots">
            {seg.thumbs.map((src, j) => (
              <img key={j} className="msg-shot" src={src} alt="Screenshot attachment" />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Renders an assistant turn: the agent's work folded into collapsible logs,
 * question cards and interjections where they happened, and the final answer
 * in full. See {@link layoutTurn} for how segments become blocks.
 */
export function AssistantBody({
  message: m,
  projectPath,
  questionBusy,
  onAnswerQuestion,
  onOpenFile
}: {
  message: UIChatMessage
  projectPath: string
  questionBusy: boolean
  onAnswerQuestion: (requestId: string, answer: string, wasFreeform: boolean) => void
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const blocks = useMemo(() => layoutTurn(m), [m])
  const workBlocks = blocks.filter((b) => b.kind === 'work').length
  return (
    <div className="turn-feed">
      {blocks.map((b) => {
        switch (b.kind) {
          case 'work':
            return (
              <WorkLog
                key={b.key}
                block={b}
                projectPath={projectPath}
                turnElapsedMs={m.elapsedMs}
                soleBlock={workBlocks === 1}
                onOpenFile={onOpenFile}
              />
            )
          case 'reasoning':
            return <ThinkingRow key={b.key} seg={b.seg} live={b.live} />
          case 'text':
            return (
              <div key={b.key} className="msg-text msg-text--md turn-note">
                <Markdown>{b.text}</Markdown>
              </div>
            )
          case 'question': {
            const q = m.questions?.find((item) => item.id === b.id)
            if (!q) return null
            return (
              <AgentQuestionBlock
                key={b.key}
                questions={[q]}
                busy={questionBusy}
                error={q.state === 'pending' ? m.questionError : undefined}
                onAnswer={onAnswerQuestion}
              />
            )
          }
          case 'interjection':
            return <Interjection key={b.key} seg={b.seg} />
          case 'answer':
            return (
              <div key={b.key} className="msg-text msg-text--md turn-answer">
                <Markdown>{b.text}</Markdown>
                {b.streaming && <span className="stream-caret" aria-hidden="true" />}
              </div>
            )
        }
      })}
    </div>
  )
}
