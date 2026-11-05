import { useEffect, useRef, type JSX } from 'react'
import type { ChatToolCall } from '@shared/ipc'
import { StepRow } from '../chat/StepRow'

/** Copilot's steps in a run or a draft, newest at the bottom; follows new steps unless you scroll up. */
export function StepLog({
  tools,
  label,
  projectPath,
  onOpenFile
}: {
  tools: ChatToolCall[]
  label: string
  projectPath: string
  onOpenFile: (path: string) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [tools])
  return (
    <div
      className="adv-activity"
      ref={ref}
      role="log"
      aria-label={label}
      onScroll={(e) => {
        const el = e.currentTarget
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      <div className="worklog worklog--live is-open">
        <div className="worklog-body">
          {tools.map((tool) => (
            <StepRow key={tool.id} tool={tool} projectPath={projectPath} onOpenFile={onOpenFile} />
          ))}
        </div>
      </div>
    </div>
  )
}
