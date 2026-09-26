import { memo, useMemo, useState } from 'react'
import { highlightLines, langFromPath } from '../../syntax'
import { Codicon } from '../icons'
import { parseUnifiedDiff, type DiffFile, type DiffHunk, type DiffLine } from './diff'
import { displayPath } from './paths'

/** Lines shown before "Show all" when a diff is long. */
const PREVIEW_LINES = 60

const STATUS_LABEL: Record<DiffFile['status'], string | null> = {
  added: 'New file',
  deleted: 'Deleted',
  renamed: 'Renamed',
  modified: null
}

/** Per-line highlighted HTML for a hunk: the old side for removed lines, the new side otherwise. */
function useHunkHtml(hunk: DiffHunk, lang: string | undefined): (string | null)[] {
  return useMemo(() => {
    const newSide = hunk.lines.filter((l) => l.kind === 'ctx' || l.kind === 'add')
    const oldSide = hunk.lines.filter((l) => l.kind === 'del')
    const newHtml = lang
      ? highlightLines(
          newSide.map((l) => l.text),
          lang
        )
      : null
    const oldHtml = lang
      ? highlightLines(
          oldSide.map((l) => l.text),
          lang
        )
      : null
    let ni = 0
    let oi = 0
    return hunk.lines.map((l) => {
      if (l.kind === 'meta') return null
      if (l.kind === 'del') return oldHtml?.[oi++] ?? null
      return newHtml?.[ni++] ?? null
    })
  }, [hunk, lang])
}

function HunkRows({
  hunk,
  lang,
  limit
}: {
  hunk: DiffHunk
  lang?: string
  limit: number
}): JSX.Element {
  const html = useHunkHtml(hunk, lang)
  const lines = hunk.lines.slice(0, limit)
  return (
    <>
      <tr className="diff-hunk">
        <td className="diff-no" aria-hidden="true" />
        <td className="diff-no" aria-hidden="true" />
        <td className="diff-code">
          ⋯ Line {hunk.newStart}
          {hunk.section ? <span className="diff-hunk-section"> · {hunk.section}</span> : null}
        </td>
      </tr>
      {lines.map((line: DiffLine, i) =>
        line.kind === 'meta' ? (
          <tr key={i} className="diff-row diff-row--meta">
            <td className="diff-no" />
            <td className="diff-no" />
            <td className="diff-code">{line.text}</td>
          </tr>
        ) : (
          <tr key={i} className={`diff-row diff-row--${line.kind}`}>
            <td className="diff-no">{line.oldNo ?? ''}</td>
            <td className="diff-no">{line.newNo ?? ''}</td>
            <td className="diff-code">
              <span className="diff-sign" aria-hidden="true">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
              </span>
              {html[i] != null ? (
                <span className="hljs" dangerouslySetInnerHTML={{ __html: html[i] as string }} />
              ) : (
                <span>{line.text}</span>
              )}
            </td>
          </tr>
        )
      )}
    </>
  )
}

interface DiffViewProps {
  diff: string
  truncated?: boolean
  projectPath: string
  onOpenFile?: (path: string) => void
}

/** A unified diff rendered with line numbers, syntax colours and +/− gutters. */
export const DiffView = memo(function DiffView({
  diff,
  truncated,
  projectPath,
  onOpenFile
}: DiffViewProps): JSX.Element {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  const [showAll, setShowAll] = useState(false)
  const [wrap, setWrap] = useState(false)
  if (files.length === 0) return <pre className="step-output">{diff}</pre>

  const total = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0)
  let budget = showAll ? Number.POSITIVE_INFINITY : PREVIEW_LINES
  return (
    <div className={`diff${wrap ? ' diff--wrap' : ''}`}>
      {files.map((file, fi) => {
        const shown = displayPath(file.path, projectPath)
        const lang = langFromPath(file.path)
        const status = STATUS_LABEL[file.status]
        const openable = Boolean(onOpenFile && shown.rel && file.status !== 'deleted')
        return (
          <div key={fi} className="diff-file">
            <div className="diff-file-head">
              {status && (
                <span className={`diff-status diff-status--${file.status}`}>{status}</span>
              )}
              <span className="diff-path" title={shown.full}>
                {shown.dir && <span className="diff-dir">{shown.dir}</span>}
                <span className="diff-base">{shown.base}</span>
              </span>
              <span className="diff-stat">
                {file.added > 0 && <span className="stat-add">+{file.added}</span>}
                {file.removed > 0 && <span className="stat-del">−{file.removed}</span>}
              </span>
              {openable && (
                <button
                  type="button"
                  className="diff-open"
                  onClick={() => onOpenFile?.(shown.rel as string)}
                  title={`Open ${shown.rel} in the Code tab`}
                >
                  <Codicon name="go-to-file" /> Open
                </button>
              )}
            </div>
            {budget > 0 && (
              <div className="diff-scroll">
                <table className="diff-table">
                  <tbody>
                    {file.hunks.map((hunk, hi) => {
                      if (budget <= 0) return null
                      const limit = Math.min(hunk.lines.length, budget)
                      budget -= limit
                      return <HunkRows key={hi} hunk={hunk} lang={lang} limit={limit} />
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
      <div className="diff-foot">
        {!showAll && total > PREVIEW_LINES && (
          <button type="button" className="diff-more" onClick={() => setShowAll(true)}>
            Show all {total} lines
          </button>
        )}
        {truncated && (
          <span className="diff-note">Diff shortened — open the file to see everything.</span>
        )}
        <button
          type="button"
          className={`diff-wrap-toggle${wrap ? ' is-on' : ''}`}
          onClick={() => setWrap((w) => !w)}
          aria-pressed={wrap}
          title={wrap ? 'Don’t wrap long lines' : 'Wrap long lines'}
        >
          <Codicon name="word-wrap" /> Wrap
        </button>
      </div>
    </div>
  )
})
