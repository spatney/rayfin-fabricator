import { useMemo, useState, type JSX } from 'react'
import type { ChatToolCall } from '@shared/ipc'
import { Codicon } from '../icons'
import { Spinner, StepIcon } from './parts'

export interface HelpWorkLogProps {
  tools: ChatToolCall[]
  /** True while the turn is still running. */
  working: boolean
}

/**
 * What the assistant looked at before answering, collapsed to one line.
 *
 * The user asked a question, not for a transcript, so this stays shut by
 * default and only summarises. It matters because it is the difference between
 * "the model made something up" and "it read your deploy log" — expanding it
 * shows exactly which files were consulted.
 */
export function HelpWorkLog({ tools, working }: HelpWorkLogProps): JSX.Element {
  const [open, setOpen] = useState(false)

  const summary = useMemo(() => {
    const failed = tools.filter((t) => t.state === 'error').length
    const done = tools.filter((t) => t.state !== 'running').length
    if (working && done < tools.length) return `looking at ${tools.length} things`
    return failed > 0
      ? `checked ${tools.length} things · ${failed} unreadable`
      : `checked ${tools.length} thing${tools.length === 1 ? '' : 's'}`
  }, [tools, working])

  return (
    <div className={`help-log ${open ? 'is-open' : ''}`}>
      <button
        className="help-log-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {working ? <Spinner /> : <Codicon name="checklist" />}
        <span className="help-log-sum">{summary}</span>
        <Codicon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>

      {open && (
        <ol className="help-log-steps">
          {tools.map((tool) => (
            <li key={tool.id} className={`help-step help-step--${tool.state}`}>
              <StepIcon name={tool.name} />
              <span className="help-step-title">{tool.title || tool.name}</span>
              {tool.state === 'running' && <span className="help-step-state">…</span>}
              {tool.state === 'error' && (
                <span className="help-step-state" title={tool.output ?? undefined}>
                  couldn&apos;t read
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
