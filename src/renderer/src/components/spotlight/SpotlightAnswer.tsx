import { useEffect, useRef, type JSX } from 'react'
import type { HelpAction, HelpIssueDraft } from '@shared/ipc'
import type { Exchange } from '../help/conversation'
import { ExchangeAnswer } from '../help/HelpExchange'
import { HelpRayThinking } from '../help/HelpRay'
import '../help/help.css'

/**
 * Help's answer, inline in Search: the question you asked, then the answer just as
 * Help shows it. It follows the answer down as it grows, unless you've scrolled up
 * to read.
 */
export function SpotlightAnswer({
  exchange,
  pendingQuestion,
  onAction,
  onReportIssue
}: {
  /** The exchange to show; absent while a question is on its way. */
  exchange?: Exchange
  /** A question just asked, shown until its exchange starts. */
  pendingQuestion?: string
  onAction: (action: HelpAction) => void
  onReportIssue: (issue: HelpIssueDraft) => void
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const question = pendingQuestion ?? exchange?.question ?? ''

  useEffect(() => {
    stick.current = true
  }, [question])

  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [exchange])

  return (
    <div
      className="sl-answer"
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current
        if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      <h2 className="sl-q">{question}</h2>
      {exchange && !pendingQuestion ? (
        <ExchangeAnswer exchange={exchange} onAction={onAction} onReportIssue={onReportIssue} />
      ) : (
        <HelpRayThinking />
      )}
    </div>
  )
}
