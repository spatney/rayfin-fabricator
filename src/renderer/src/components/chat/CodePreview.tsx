import { memo, useMemo } from 'react'
import { highlightCode } from '../../syntax'

const NUM_LINE = /^(\s*)(\d+)\.\s?(.*)$/

/** Detect the read/view tool's `N. <code>` line format; split numbers from code. */
export function parseNumbered(text: string): { nums: (number | null)[]; code: string } | null {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const nums: (number | null)[] = []
  const codes: string[] = []
  let matched = 0
  for (const line of lines) {
    const m = NUM_LINE.exec(line)
    if (m) {
      nums.push(Number(m[2]))
      codes.push(m[3])
      matched++
    } else {
      nums.push(null)
      codes.push(line)
    }
  }
  if (matched < Math.max(3, Math.ceil(lines.length * 0.7))) return null
  return { nums, code: codes.join('\n') }
}

/**
 * A step's captured output. File reads (the `N. <code>` format) get a
 * line-number gutter and syntax highlighting; everything else stays plain.
 */
export const CodePreview = memo(function CodePreview({
  output,
  lang
}: {
  output: string
  lang?: string
}): JSX.Element {
  const numbered = useMemo(() => parseNumbered(output), [output])
  const hl = useMemo(() => (numbered ? highlightCode(numbered.code, lang) : null), [numbered, lang])
  if (!numbered) return <pre className="step-output">{output}</pre>
  return (
    <div className="code-preview">
      <div className="code-preview-gutter" aria-hidden="true">
        {numbered.nums.map((n, i) => (
          <span key={i}>{n ?? ''}</span>
        ))}
      </div>
      <pre className="code-preview-pre">
        {hl ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: hl.html }} />
        ) : (
          <code className="hljs">{numbered.code}</code>
        )}
      </pre>
    </div>
  )
})
