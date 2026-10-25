import { memo, useMemo, type JSX } from 'react'
import { highlightLines, langFromPath } from '../../syntax'

/**
 * A code excerpt with real line numbers; the flagged lines are highlighted.
 * Highlighted HTML comes from highlight.js, which escapes the source text.
 */
export const EvidenceView = memo(function EvidenceView({
  text,
  start,
  file,
  from,
  to
}: {
  text: string
  /** Line number of the excerpt's first line. */
  start: number
  file?: string
  /** First flagged line. */
  from?: number
  /** Last flagged line. */
  to?: number
}): JSX.Element {
  const lines = useMemo(() => text.replace(/\s+$/, '').split('\n'), [text])
  const html = useMemo(() => highlightLines(lines, file ? langFromPath(file) : undefined), [lines, file])
  const last = to ?? from
  return (
    <div className="adv-evidence" role="group" aria-label={file ? `Code from ${file}` : 'Code'}>
      <pre className="adv-evidence-pre">
        {lines.map((line, i) => {
          const n = start + i
          const flagged = from !== undefined && last !== undefined && n >= from && n <= last
          return (
            <div key={n} className={`adv-evidence-line${flagged ? ' is-flagged' : ''}`}>
              <span className="adv-evidence-num" aria-hidden="true">
                {n}
              </span>
              {html ? (
                <code className="hljs adv-evidence-code" dangerouslySetInnerHTML={{ __html: html[i] || ' ' }} />
              ) : (
                <code className="hljs adv-evidence-code">{line || ' '}</code>
              )}
            </div>
          )
        })}
      </pre>
    </div>
  )
})
