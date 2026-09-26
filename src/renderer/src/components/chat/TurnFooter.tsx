import { memo, useMemo, useState } from 'react'
import { ClockIcon, Codicon } from '../icons'
import { CopyButton } from './CopyButton'
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

/** The files a turn changed, as chips that open the file in the Code tab. */
export function FilesChanged({
  files,
  onOpenFile
}: {
  files: FileChange[]
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const [all, setAll] = useState(false)
  const shown = all ? files : files.slice(0, CHIP_LIMIT)
  return (
    <div
      className="files-changed"
      role="group"
      aria-label={`Changed ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
    >
      <span className="files-changed-label" aria-hidden="true">
        Changed
      </span>
      {shown.map((f) => {
        const clickable = Boolean(onOpenFile) && f.status !== 'deleted'
        return (
          <button
            key={f.path}
            type="button"
            className={`file-chip file-chip--${f.status}`}
            disabled={!clickable}
            onClick={() => onOpenFile?.(f.path)}
            title={`${STATUS_WORD[f.status]} ${f.path}${clickable ? ' — open in the Code tab' : ''}`}
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
  const hasActions = Boolean(copy || onTryAgain || m.elapsedMs != null || m.createdAt != null)
  if (files.length === 0 && !hasActions) return null
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
          <Codicon name="refresh" /> Try again
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
      <FilesChanged files={files} onOpenFile={onOpenFile} />
      {!float && actions}
    </div>
  )
  if (float) {
    return (
      <>
        {chips}
        {actions}
      </>
    )
  }
  return chips || <div className="turn-footer">{actions}</div>
})
