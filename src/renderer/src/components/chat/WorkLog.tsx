import { memo, useMemo, useState } from 'react'
import Markdown from '../Markdown'
import { ChevronRightIcon } from '../icons'
import { formatTurnDuration } from './format'
import { CheckIcon, ToolKindIcon } from './icons'
import { StepRow } from './StepRow'
import { ThinkingRow } from './ThinkingRow'
import { summarizeKinds } from './toolPresentation'
import { workDuration, type TurnBlock } from './turnLayout'

type WorkBlock = Extract<TurnBlock, { kind: 'work' }>

/** While live, only the newest items stay on screen; earlier ones are one click away. */
const LIVE_WINDOW = 6

/**
 * An agent's steps (and the narration between them) folded into one block.
 * Live it stays open and follows the newest steps; once the turn finishes it
 * collapses to a one-line "Worked for 2m 14s · 23 steps" summary. The user's
 * own open/close choice wins over both.
 */
export const WorkLog = memo(function WorkLog({
  block,
  projectPath,
  turnElapsedMs,
  soleBlock,
  onOpenFile
}: {
  block: WorkBlock
  projectPath: string
  turnElapsedMs?: number
  soleBlock: boolean
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const { items, steps, live } = block
  const [choice, setChoice] = useState<boolean | null>(null)
  const [showAll, setShowAll] = useState(false)
  const open = choice ?? live
  const kinds = useMemo(() => summarizeKinds(steps), [steps])
  const duration = live ? undefined : workDuration(steps, turnElapsedMs, soleBlock)

  const hiddenCount = live && !showAll ? Math.max(0, items.length - LIVE_WINDOW) : 0
  const shown = hiddenCount ? items.slice(hiddenCount) : items
  const hiddenSteps = hiddenCount
    ? items.slice(0, hiddenCount).filter((i) => i.kind === 'tool').length
    : 0

  const stepCount = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`
  const title = live
    ? 'Working'
    : duration != null
      ? `Worked for ${formatTurnDuration(duration)}`
      : 'Worked'
  const summary = [title, stepCount, ...kinds.map((k) => k.label)].join(', ')

  return (
    <div className={`worklog${live ? ' worklog--live' : ''}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="worklog-head"
        aria-expanded={open}
        aria-label={summary}
        title={open ? 'Hide steps' : 'Show steps'}
        onClick={() => setChoice(!open)}
      >
        <span className="worklog-icon" aria-hidden="true">
          {live ? <span className="step-spin" /> : <CheckIcon className="worklog-check" />}
        </span>
        <span className="worklog-title">{title}</span>
        <span className="worklog-count">{stepCount}</span>
        {kinds.length > 0 && (
          <span className="worklog-kinds" aria-hidden="true">
            {kinds.map((k) => (
              <span key={k.kind} className="worklog-kind" title={k.label}>
                <ToolKindIcon kind={k.kind} className="worklog-kind-ico" />
                {k.count}
              </span>
            ))}
          </span>
        )}
        <ChevronRightIcon className="worklog-caret" />
      </button>
      {open && (
        <div className="worklog-body">
          {hiddenCount > 0 && (
            <button type="button" className="worklog-earlier" onClick={() => setShowAll(true)}>
              Show{' '}
              {hiddenSteps > 0
                ? `${hiddenSteps} earlier ${hiddenSteps === 1 ? 'step' : 'steps'}`
                : 'earlier notes'}
            </button>
          )}
          {shown.map((item) =>
            item.kind === 'tool' ? (
              <StepRow
                key={item.key}
                tool={item.tool}
                projectPath={projectPath}
                onOpenFile={onOpenFile}
              />
            ) : item.kind === 'reasoning' ? (
              <ThinkingRow key={item.key} seg={item.seg} live={item.live} />
            ) : (
              <div key={item.key} className="worklog-note">
                <Markdown>{item.text}</Markdown>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
})
