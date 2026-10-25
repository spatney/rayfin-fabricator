import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { ClockIcon, Codicon, ReloadIcon } from '../icons'
import { CopyButton } from './CopyButton'
import { DiffView } from './DiffView'
import { formatClock, formatFullDate, formatTurnDuration } from './format'
import { ToolKindIcon } from './icons'
import { basename } from './paths'
import { answerText, filesChanged, type FileChange } from './turnLayout'
import type { UIChatMessage } from './types'

/** File chips shown before "+N more". */
const CHIP_LIMIT = 4

const STATUS_ICON = { created: 'create', edited: 'edit', deleted: 'delete' } as const
const STATUS_WORD = { created: 'Created', edited: 'Edited', deleted: 'Deleted' } as const

function Stats({ added, removed }: { added?: number; removed?: number }): JSX.Element | null {
  if (!added && !removed) return null
  return (
    <span className="file-stats">
      {added ? <span className="stat-add">+{added}</span> : null}
      {removed ? <span className="stat-del">−{removed}</span> : null}
    </span>
  )
}

/**
 * The files a turn changed, as chips. A chip shows what the turn did to its
 * file below the row; one with no recorded diff opens the file in the Code tab.
 */
export function FilesChanged({
  files,
  shown,
  panelId,
  onToggle,
  onOpenFile
}: {
  files: FileChange[]
  /** The file whose changes are showing. */
  shown: string | null
  /** The id of the element showing them. */
  panelId: string
  onToggle: (path: string) => void
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const [all, setAll] = useState(false)
  const visible = all ? files : files.slice(0, CHIP_LIMIT)
  return (
    <div
      className="files-changed"
      role="group"
      aria-label={`Changed ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
    >
      <span className="files-changed-label" aria-hidden="true">
        Changed
      </span>
      {visible.map((f) => {
        const hasDiff = f.diff != null
        const open = hasDiff && shown === f.path
        const clickable = hasDiff || (Boolean(onOpenFile) && f.status !== 'deleted')
        const hint = hasDiff
          ? ` — ${open ? 'hide' : 'show'} the changes`
          : clickable
            ? ' — open in the Code tab'
            : ''
        return (
          <button
            key={f.path}
            type="button"
            className={`file-chip file-chip--${f.status}${open ? ' is-open' : ''}`}
            disabled={!clickable}
            aria-expanded={hasDiff ? open : undefined}
            aria-controls={open ? panelId : undefined}
            onClick={() => (hasDiff ? onToggle(f.path) : onOpenFile?.(f.path))}
            title={`${STATUS_WORD[f.status]} ${f.path}${hint}`}
          >
            <ToolKindIcon kind={STATUS_ICON[f.status]} className="file-chip-ico" />
            <span className="file-chip-name">{basename(f.path)}</span>
            <Stats added={f.added} removed={f.removed} />
          </button>
        )
      })}
      {!all && files.length > CHIP_LIMIT && (
        <button type="button" className="file-chip file-chip--more" onClick={() => setAll(true)}>
          +{files.length - CHIP_LIMIT} more
        </button>
      )}
    </div>
  )
}

/** What a turn did to one file, opened from its chip. */
function FileDiff({
  file,
  id,
  projectPath,
  onOpenFile
}: {
  file: FileChange
  id: string
  projectPath: string
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Opening a chip on the newest turn adds the diff below the fold.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [])
  const note = file.partial
    ? 'Some edits to this file weren’t recorded — open it to see all of them.'
    : file.stepwise
      ? 'Shown edit by edit — these edits couldn’t be combined into one diff.'
      : undefined
  return (
    <div
      ref={ref}
      id={id}
      className="file-diff"
      role="region"
      aria-label={`Changes to ${file.path}`}
    >
      {file.diff ? (
        <DiffView diff={file.diff} note={note} projectPath={projectPath} onOpenFile={onOpenFile} />
      ) : (
        <div className="file-diff-empty">
          <span>No net change — later edits undid the earlier ones.</span>
          {onOpenFile && file.status !== 'deleted' && (
            <button
              type="button"
              className="diff-open"
              onClick={() => onOpenFile(file.path)}
              title={`Open ${file.path} in the Code tab`}
            >
              <Codicon name="go-to-file" /> Open
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The foot of a finished assistant turn, in one wrapping row: the files it
 * changed, then its duration, timestamp, and actions (Copy, Try again).
 */
export const TurnFooter = memo(function TurnFooter({
  message: m,
  projectPath,
  latest,
  onOpenFile,
  onTryAgain
}: {
  message: UIChatMessage
  projectPath: string
  latest: boolean
  onOpenFile?: (path: string) => void
  onTryAgain?: () => void
}): JSX.Element | null {
  const files = useMemo(() => filesChanged(m.tools, projectPath), [m.tools, projectPath])
  const copy = useMemo(() => answerText(m), [m])
  const [shown, setShown] = useState<string | null>(null)
  const panelId = useId()
  const toggle = useCallback((path: string) => setShown((cur) => (cur === path ? null : path)), [])
  const hasActions = Boolean(copy || onTryAgain || m.elapsedMs != null || m.createdAt != null)
  if (files.length === 0 && !hasActions) return null
  const open = files.find((f) => f.path === shown && f.diff != null)
  const diff = open ? (
    <FileDiff
      key={open.path}
      file={open}
      id={panelId}
      projectPath={projectPath}
      onOpenFile={onOpenFile}
    />
  ) : null
  // Older turns reveal their actions on hover, floating in the gap below the
  // turn so they never reserve an empty row; the latest turn keeps them inline.
  const float = !latest
  const actions = hasActions ? (
    <div
      className={`turn-actions${latest ? ' turn-actions--latest' : ''}${float ? ' turn-actions--float' : ''}`}
    >
      {copy && (
        <CopyButton
          text={copy}
          title="Copy answer"
          compact
          className="turn-action turn-action--icon"
        />
      )}
      {onTryAgain && (
        <button
          type="button"
          className="turn-action"
          onClick={onTryAgain}
          title="Run your last message again for a fresh attempt"
        >
          <ReloadIcon /> Try again
        </button>
      )}
      {m.elapsedMs != null && (
        <span className="turn-meta" title="How long this took">
          <ClockIcon className="turn-meta-ico" />
          {formatTurnDuration(m.elapsedMs)}
        </span>
      )}
      {m.createdAt != null && (
        <time
          className="turn-meta"
          dateTime={new Date(m.createdAt).toISOString()}
          title={formatFullDate(m.createdAt)}
        >
          {formatClock(m.createdAt)}
        </time>
      )}
    </div>
  ) : null
  const chips = files.length > 0 && (
    <div className="turn-footer">
      <FilesChanged
        files={files}
        shown={shown}
        panelId={panelId}
        onToggle={toggle}
        onOpenFile={onOpenFile}
      />
      {!float && actions}
    </div>
  )
  if (float) {
    return (
      <>
        {chips}
        {diff}
        {actions}
      </>
    )
  }
  if (!chips) return <div className="turn-footer">{actions}</div>
  return (
    <>
      {chips}
      {diff}
    </>
  )
})
