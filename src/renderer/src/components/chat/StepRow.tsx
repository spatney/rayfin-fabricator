import { memo, useMemo, useState } from 'react'
import type { ChatToolCall } from '@shared/ipc'
import { langFromPath } from '../../syntax'
import { ChevronRightIcon, Codicon } from '../icons'
import { CodePreview } from './CodePreview'
import { CopyButton } from './CopyButton'
import { DiffView } from './DiffView'
import { formatTurnDuration } from './format'
import { ToolKindIcon } from './icons'
import { describeStep, stepLabel, type StepTarget, type StepView } from './toolPresentation'

/** Commands that ran at least this long show their duration. */
const SHOW_DURATION_MS = 2000

function Target({ target, more }: { target: StepTarget; more: number }): JSX.Element {
  if (target.kind === 'path') {
    const { dir, base, full } = target.path
    return (
      <span className="step-target step-target--path" title={full}>
        {dir && <span className="step-dir">{dir}</span>}
        <span className="step-base">{base}</span>
        {more > 0 && <span className="step-more"> +{more} more</span>}
      </span>
    )
  }
  if (target.kind === 'quote') {
    return (
      <span className="step-target step-target--quote" title={target.text}>
        “{target.text}”
      </span>
    )
  }
  return (
    <span className="step-target" title={target.text}>
      {target.text}
    </span>
  )
}

/** The last few lines of a running command's output. */
function tail(text: string, lines = 4): string {
  return text.replace(/\s+$/, '').split('\n').slice(-lines).join('\n')
}

function StepDetail({
  tool,
  view,
  projectPath,
  onOpenFile
}: {
  tool: ChatToolCall
  view: StepView
  projectPath: string
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const target = view.target?.kind === 'path' ? view.target.path : null
  const lang = target ? langFromPath(target.base) : undefined
  const openable = Boolean(!tool.diff && target?.rel && onOpenFile && view.kind !== 'delete')
  return (
    <div className="step-detail">
      {tool.command && (
        <div className="step-cmd">
          <span className="step-cmd-prompt" aria-hidden="true">
            $
          </span>
          <code className="step-cmd-text">{tool.command}</code>
          <CopyButton text={tool.command} title="Copy command" compact className="step-cmd-copy" />
        </div>
      )}
      {tool.diff ? (
        <DiffView
          diff={tool.diff}
          truncated={tool.diffTruncated}
          projectPath={projectPath}
          onOpenFile={onOpenFile}
        />
      ) : tool.output ? (
        <CodePreview output={tool.output} lang={lang} />
      ) : null}
      {openable && target?.rel && (
        <div className="step-detail-actions">
          <button
            type="button"
            className="step-open"
            onClick={() => onOpenFile?.(target.rel as string)}
          >
            <Codicon name="go-to-file" /> Open {target.base}
          </button>
        </div>
      )}
    </div>
  )
}

/** One agent step: a single summary line that expands to its command, diff, or output. */
export const StepRow = memo(function StepRow({
  tool,
  projectPath,
  onOpenFile
}: {
  tool: ChatToolCall
  projectPath: string
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const view = useMemo(() => describeStep(tool, projectPath), [tool, projectPath])
  const [open, setOpen] = useState(false)
  const running = tool.state === 'running'
  const expandable = !running && Boolean(tool.output || tool.diff || tool.command)
  const label = stepLabel(view)
  const line = (
    <>
      <span className="step-icon">
        {running ? (
          <span className="step-spin" aria-hidden="true" />
        ) : (
          <ToolKindIcon kind={view.kind} className="step-kind-ico" />
        )}
      </span>
      <span className="step-verb">{view.verb}</span>
      {view.target && <Target target={view.target} more={view.moreFiles} />}
      <span className="step-meta">
        {view.added ? <span className="stat-add">+{view.added}</span> : null}
        {view.removed ? <span className="stat-del">−{view.removed}</span> : null}
        {view.failedExit != null && <span className="step-exit">exit {view.failedExit}</span>}
        {tool.state === 'error' && view.failedExit == null && (
          <span className="step-failed">failed</span>
        )}
        {view.kind === 'run' && view.durationMs != null && view.durationMs >= SHOW_DURATION_MS && (
          <span className="step-time">{formatTurnDuration(view.durationMs)}</span>
        )}
      </span>
      {expandable && <ChevronRightIcon className="step-caret" />}
    </>
  )
  return (
    <div className={`step step--${tool.state}${open ? ' is-open' : ''}`}>
      {expandable ? (
        <button
          type="button"
          className="step-line"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title={label}
        >
          {line}
        </button>
      ) : (
        <div className="step-line" title={label}>
          {line}
        </div>
      )}
      {running && tool.output && <pre className="step-tail">{tail(tool.output)}</pre>}
      {open && (
        <StepDetail tool={tool} view={view} projectPath={projectPath} onOpenFile={onOpenFile} />
      )}
    </div>
  )
})
