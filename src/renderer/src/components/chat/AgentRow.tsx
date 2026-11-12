import { memo, useState, type JSX } from 'react'
import type { ChatToolCall } from '@shared/ipc'
import { ChevronRightIcon } from '../icons'
import { CodePreview } from './CodePreview'
import { ToolKindIcon } from './icons'
import { StepRow } from './StepRow'

/** While an agent works, only its newest steps stay on screen; earlier ones are one click away. */
const LIVE_WINDOW = 4

/**
 * A step that started a subagent, such as an explore agent: the agent's name,
 * what it was asked to do, and the steps it took. While the agent works its
 * steps stay open and follow the newest ones, so its progress shows beside the
 * main agent's; once it's done they fold into the one line. The user's own
 * open/close choice wins over both.
 */
export const AgentRow = memo(function AgentRow({
  tool,
  steps,
  projectPath,
  onOpenFile
}: {
  tool: ChatToolCall
  steps: readonly ChatToolCall[]
  projectPath: string
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const state = tool.agent?.state ?? tool.state
  const working = state === 'running'
  const [choice, setChoice] = useState<boolean | null>(null)
  const [showAll, setShowAll] = useState(false)
  const open = choice ?? working
  const hidden = working && !showAll ? Math.max(0, steps.length - LIVE_WINDOW) : 0
  const shown = hidden ? steps.slice(hidden) : steps
  const name = tool.agent?.name ?? 'Agent'
  const task = tool.title?.trim() && tool.title !== tool.name ? tool.title.trim() : ''
  const count = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`
  // A background agent's step only says that it started; its result went to Copilot.
  const output = !working && !tool.agent?.background && tool.output ? tool.output : ''

  return (
    <div className={`step step--agent step--${state}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="step-line"
        aria-expanded={open}
        aria-label={[name, task, count].filter(Boolean).join(', ')}
        title={open ? 'Hide its steps' : 'Show its steps'}
        onClick={() => setChoice(!open)}
      >
        <span className="step-icon">
          {working ? (
            <span className="step-spin" aria-hidden="true" />
          ) : (
            <ToolKindIcon kind="agent" className="step-kind-ico" />
          )}
        </span>
        <span className="step-verb">{name}</span>
        {task && <span className="step-target">{task}</span>}
        <span className="step-meta">
          <span>{count}</span>
          {state === 'error' && <span className="step-failed">failed</span>}
        </span>
        <ChevronRightIcon className="step-caret" />
      </button>
      {open && (
        <div className="step-agent-body">
          {hidden > 0 && (
            <button type="button" className="worklog-earlier" onClick={() => setShowAll(true)}>
              Show {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
            </button>
          )}
          {shown.map((step) => (
            <StepRow key={step.id} tool={step} projectPath={projectPath} onOpenFile={onOpenFile} />
          ))}
          {output && (
            <div className="step-agent-output">
              <CodePreview output={output} />
            </div>
          )}
        </div>
      )}
    </div>
  )
})
