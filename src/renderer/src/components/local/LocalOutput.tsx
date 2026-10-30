import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { LocalLogEvent } from '@shared/ipc'
import { useLocalBackendLogs } from '../../localBackend'
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
 * you've scrolled up to read.
 */
export default function LocalOutput({
  projectId,
  onClose
}: {
  projectId: string
  onClose: () => void
}): JSX.Element {
  const lines = useLocalBackendLogs(projectId, LINES)
  const bodyRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const [copied, setCopied] = useState(false)

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

  return (
    <section className="local-output" aria-label="Output">
      <div className="local-output-head">
        <span className="local-output-title">Output</span>
        <span className="local-output-sub">
          Your app’s backend, Vite and functions on this computer
        </span>
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
