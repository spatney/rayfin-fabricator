import type { JSX } from 'react'
import type { ChatFileRef } from '@shared/ipc'
import { useTranslation } from '../../i18n'
import { CloseIcon, Codicon } from '../icons'
import { fileName } from './fileRefs'

/**
 * The files and folders on this computer waiting in the composer, one chip each.
 * Copilot reads them with the next message; × drops one.
 */
export function FileTray({
  files,
  onRemove
}: {
  files: readonly ChatFileRef[]
  onRemove: (path: string) => void
}): JSX.Element | null {
  const { t } = useTranslation('chat')
  if (files.length === 0) return null
  return (
    <ul className="data-tray" aria-label={t('fileTray.toSend')}>
      {files.map((f) => (
        <li key={f.path} className="data-chip" title={f.path}>
          <span className="data-chip-main data-chip-main--static">
            <Codicon name={f.dir ? 'folder' : 'file'} className="data-chip-ico" />
            <span className="data-chip-name">{fileName(f.path)}</span>
          </span>
          <button
            type="button"
            className="data-chip-x"
            onClick={() => onRemove(f.path)}
            aria-label={t('tray.removeItem', { name: fileName(f.path) })}
            title={t('actions.remove')}
          >
            <CloseIcon />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The files and folders a sent message gave Copilot to read, as chips in the transcript. */
export function SentFiles({ files }: { files: readonly ChatFileRef[] }): JSX.Element {
  const { t } = useTranslation('chat')
  return (
    <ul className="msg-data" aria-label={t('fileTray.sent')}>
      {files.map((f) => (
        <li key={f.path} className="data-chip data-chip--sent" title={f.path}>
          <Codicon name={f.dir ? 'folder' : 'file'} className="data-chip-ico" />
          <span className="data-chip-name">{fileName(f.path)}</span>
        </li>
      ))}
    </ul>
  )
}
