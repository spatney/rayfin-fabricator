import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { LocalLogEvent } from '@shared/ipc'
import { runningProblems, useLocalBackendLogs, type LocalBackend } from '../../localBackend'
import { Codicon } from '../icons'
import './local.css'

/** Lines of output kept on screen. */
const LINES = 500

/** `HH:MM:SS` in this computer's time zone, or nothing for a time it can't read. */
function clock(time: string): string {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

function asText(lines: LocalLogEvent[]): string {
  return lines.map((line) => `${clock(line.time)} [${line.source}] ${line.line}`).join('\n')
}

/**
 * The app's output on this computer, under the preview: rayfin-local, Vite, the
 * functions and builds, newest at the bottom. It follows new lines unless
 * you've scrolled up to read. A problem the running app has (a data model
 * change it couldn't read, say) shows above the lines, and Restart starts the
 * backend again, which builds and reads everything from the start.
 */
export default function LocalOutput({
  projectId,
  local,
  onClose
}: {
  projectId: string
  local: LocalBackend
  onClose: () => void
}): JSX.Element {
  const lines = useLocalBackendLogs(projectId, LINES)
  const bodyRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const [copied, setCopied] = useState(false)
  const [restarting, setRestarting] = useState(false)
  /** Restart was asked for here, so its failure shows here. */
  const [restartAsked, setRestartAsked] = useState(false)
  const problems = runningProblems(local.status)

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body && followRef.current) body.scrollTop = body.scrollHeight
  }, [lines])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(asText(lines))
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  const restart = (): void => {
    setRestarting(true)
    setRestartAsked(true)
    void local.restart().finally(() => setRestarting(false))
  }

  return (
    <section className="local-output" aria-label="Output">
      <div className="local-output-head">
        <span className="local-output-title">Output</span>
        <span className="local-output-sub">
          Your app’s backend, Vite and functions on this computer
        </span>
        {(local.state === 'running' || restarting) && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={restart}
            disabled={restarting || local.busy}
            title="Stop your app’s backend and Vite on this computer and start them again"
          >
            <Codicon name="debug-restart" />
            {restarting ? 'Restarting…' : 'Restart'}
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={copy}
          disabled={lines.length === 0}
        >
          <Codicon name={copied ? 'check' : 'copy'} />
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          className="icon-btn local-output-close"
          aria-label="Close output"
          title="Close output"
          onClick={onClose}
        >
          <Codicon name="close" />
        </button>
      </div>
      {problems.length > 0 && (
        <ul className="local-output-problems" aria-label="Problems">
          {problems.map((problem) => (
            <li key={problem.kind} className="local-output-problem">
              <span className="local-output-problem-dot" aria-hidden="true" />
              <div className="local-output-problem-text">
                <p className="local-output-problem-summary">{problem.summary}</p>
                {problem.detail && (
                  <pre className="local-output-problem-detail" title={problem.detail}>
                    {problem.detail}
                  </pre>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {restartAsked && local.actionError && (
        <p className="local-output-failed" role="alert">
          {local.actionError.message}
        </p>
      )}
      <div
        className="local-output-body"
        ref={bodyRef}
        role="log"
        tabIndex={0}
        onScroll={(event) => {
          const body = event.currentTarget
          followRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24
        }}
      >
        {lines.length === 0 ? (
          <p className="local-output-empty">Nothing yet.</p>
        ) : (
          lines.map((line) => (
            <div key={line.seq} className={`local-output-line local-output-line--${line.level}`}>
              <span className="local-output-time">{clock(line.time)}</span>
              <span className="local-output-source">{line.source}</span>
              <span className="local-output-text">{line.line}</span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
