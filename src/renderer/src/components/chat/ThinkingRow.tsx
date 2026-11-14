import { memo, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { ChatSegment } from '@shared/ipc'
import { translator, useTranslation } from '../../i18n'
import Markdown from '../Markdown'
import { ChevronRightIcon } from '../icons'
import { formatSeconds } from './format'

type ReasoningSegment = Extract<ChatSegment, { kind: 'reasoning' }>

function thoughtFor(ms: number | undefined): string {
  const t = translator('chat')
  if (ms == null) return t('thinking.thoughtItThrough')
  return t('thinking.thoughtFor', { duration: formatSeconds(Math.max(1, Math.round(ms / 1000))) })
}

/** The model's readable reasoning: streamed live, then folded into "Thought for Ns". */
export const ThinkingRow = memo(function ThinkingRow({
  seg,
  live
}: {
  seg: ReasoningSegment
  live: boolean
}): JSX.Element {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const liveRef = useRef<HTMLDivElement>(null)
  const text = seg.text.trim()

  // Keep the newest thought in view while it streams.
  useLayoutEffect(() => {
    const el = liveRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text, live])

  if (live) {
    return (
      <div className="thinking thinking--live" role="status" aria-live="polite">
        <div className="thinking-head">
          <span className="thinking-dot" aria-hidden="true" />
          <span className="thinking-label">{t('thinking.live')}</span>
        </div>
        <div className="thinking-live" ref={liveRef}>
          {text}
        </div>
      </div>
    )
  }
  return (
    <div className={`thinking${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="thinking-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="thinking-dot thinking-dot--done" aria-hidden="true" />
        <span className="thinking-label">{thoughtFor(seg.elapsedMs)}</span>
        <ChevronRightIcon className="thinking-caret" />
      </button>
      {open && (
        <div className="thinking-body">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  )
})
