import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX
} from 'react'
import type { ChatFusion } from '@shared/ipc'
import { useAutoTiers, useCopilotModels } from '@renderer/copilotModels'
import { formatList, Trans, useTranslation } from '../../i18n'
import { ClockIcon, Codicon, ReloadIcon } from '../icons'
import { CopyButton } from './CopyButton'
import { DiffView } from './DiffView'
import { formatClock, formatFullDate, formatTurnDuration } from './format'
import { describeFusion } from './fusion'
import { ToolKindIcon } from './icons'
import { basename } from './paths'
import {
  answerText,
  filesChanged,
  followedInstructions,
  type FileChange,
  type FollowedInstruction
} from './turnLayout'
import type { UIChatMessage } from './types'

/** File chips shown before "+N more". */
const CHIP_LIMIT = 4

const STATUS_ICON = { created: 'create', edited: 'edit', deleted: 'delete' } as const
const STATUS_WORD = {
  created: 'turnFooter.created',
  edited: 'turnFooter.edited',
  deleted: 'turnFooter.deleted'
} as const

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
  const { t } = useTranslation('chat')
  const [all, setAll] = useState(false)
  const visible = all ? files : files.slice(0, CHIP_LIMIT)
  return (
    <div
      className="files-changed"
      role="group"
      aria-label={t('turnFooter.changedFiles', { count: files.length })}
    >
      <span className="files-changed-label" aria-hidden="true">
        {t('turnFooter.changed')}
      </span>
      {visible.map((f) => {
        const hasDiff = f.diff != null
        const open = hasDiff && shown === f.path
        const clickable = hasDiff || (Boolean(onOpenFile) && f.status !== 'deleted')
        const what = t(STATUS_WORD[f.status], { path: f.path })
        const title = hasDiff
          ? t(open ? 'turnFooter.hideChanges' : 'turnFooter.showChanges', { what })
          : clickable
            ? t('turnFooter.openInCode', { what })
            : what
        return (
          <button
            key={f.path}
            type="button"
            className={`file-chip file-chip--${f.status}${open ? ' is-open' : ''}`}
            disabled={!clickable}
            aria-expanded={hasDiff ? open : undefined}
            aria-controls={open ? panelId : undefined}
            onClick={() => (hasDiff ? onToggle(f.path) : onOpenFile?.(f.path))}
            title={title}
          >
            <ToolKindIcon kind={STATUS_ICON[f.status]} className="file-chip-ico" />
            <span className="file-chip-name">{basename(f.path)}</span>
            <Stats added={f.added} removed={f.removed} />
          </button>
        )
      })}
      {!all && files.length > CHIP_LIMIT && (
        <button type="button" className="file-chip file-chip--more" onClick={() => setAll(true)}>
          {t('format.more', { count: files.length - CHIP_LIMIT })}
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
  const { t } = useTranslation('chat')
  const ref = useRef<HTMLDivElement>(null)
  // Opening a chip on the newest turn adds the diff below the fold.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [])
  const note = file.partial
    ? t('turnFooter.partial')
    : file.stepwise
      ? t('turnFooter.stepwise')
      : undefined
  return (
    <div
      ref={ref}
      id={id}
      className="file-diff"
      role="region"
      aria-label={t('turnFooter.changesTo', { path: file.path })}
    >
      {file.diff ? (
        <DiffView diff={file.diff} note={note} projectPath={projectPath} onOpenFile={onOpenFile} />
      ) : (
        <div className="file-diff-empty">
          <span>{t('turnFooter.noNetChange')}</span>
          {onOpenFile && file.status !== 'deleted' && (
            <button
              type="button"
              className="diff-open"
              onClick={() => onOpenFile(file.path)}
              title={t('files.openInCode', { path: file.path })}
            >
              <Codicon name="go-to-file" /> {t('actions.open')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * What Copilot Fusion chose for a turn, on a line of its own so every turn shows
 * it, with Copilot's description of how it ran the request on hover.
 */
function FusionLine({ fusion }: { fusion: ChatFusion }): JSX.Element {
  const { models } = useCopilotModels(true)
  const tiers = useAutoTiers(true)
  const level = tiers?.tiers.find((t) => t.id === fusion.level)?.name
  const text = describeFusion(fusion, (id) => models.find((m) => m.id === id)?.name ?? id, level)
  return (
    <div className="turn-fusion" title={fusion.hint}>
      <Codicon name="sparkle" />
      <span>{text}</span>
    </div>
  )
}

/**
 * The user's custom instructions a turn followed, as Copilot reported them,
 * with what it did to follow each on hover.
 */
function InstructionsLine({ followed }: { followed: FollowedInstruction[] }): JSX.Element {
  const { t } = useTranslation('chat')
  // The language joins stand-ins for the instructions, so each keeps its own hover.
  const parts = formatList(followed.map((_, i) => `\u0000${i}\u0000`)).split('\u0000')
  const list = parts.map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>
    const f = followed[Number(part)]
    return (
      <span key={i} className="turn-instruction" title={f.how}>
        {t('format.quoted', { text: f.instruction })}
      </span>
    )
  })
  return (
    <div className="turn-instructions">
      <Codicon name="note" />
      <span>
        <Trans
          t={t}
          i18nKey="turnFooter.followed"
          count={followed.length}
          components={{ list: <>{list}</> }}
        />
      </span>
    </div>
  )
}

/**
 * The foot of a finished assistant turn, in one wrapping row: the files it
 * changed, then its duration, timestamp, and actions (Copy, Try again). What
 * Copilot Fusion chose, and the user's custom instructions the turn followed,
 * go on lines above it.
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
  const { t } = useTranslation('chat')
  const files = useMemo(() => filesChanged(m.tools, projectPath), [m.tools, projectPath])
  const copy = useMemo(() => answerText(m), [m])
  const [shown, setShown] = useState<string | null>(null)
  const panelId = useId()
  const toggle = useCallback((path: string) => setShown((cur) => (cur === path ? null : path)), [])
  const hasActions = Boolean(copy || onTryAgain || m.elapsedMs != null || m.createdAt != null)
  const followed = useMemo(() => followedInstructions(m.tools), [m.tools])
  const fusion = m.fusion ? <FusionLine fusion={m.fusion} /> : null
  const lines =
    fusion || followed.length > 0 ? (
      <>
        {fusion}
        {followed.length > 0 && <InstructionsLine followed={followed} />}
      </>
    ) : null
  if (files.length === 0 && !hasActions) return lines
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
          title={t('turnFooter.copyAnswer')}
          compact
          className="turn-action turn-action--icon"
        />
      )}
      {onTryAgain && (
        <button
          type="button"
          className="turn-action"
          onClick={onTryAgain}
          title={t('turnFooter.tryAgainTitle')}
        >
          <ReloadIcon /> {t('actions.tryAgain')}
        </button>
      )}
      {m.elapsedMs != null && (
        <span className="turn-meta" title={t('turnFooter.durationTitle')}>
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
        {lines}
        {chips}
        {diff}
        {actions}
      </>
    )
  }
  if (!chips)
    return (
      <>
        {lines}
        <div className="turn-footer">{actions}</div>
      </>
    )
  return (
    <>
      {lines}
      {chips}
      {diff}
    </>
  )
})
