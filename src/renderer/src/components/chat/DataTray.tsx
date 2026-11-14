import type { JSX } from 'react'
import type { ChatDataRef, ChatMigrationRef } from '@shared/ipc'
import { kindOfItem, type DataSource } from '@renderer/fabricData'
import { translator, useTranslation } from '../../i18n'
import { CloseIcon, Codicon } from '../icons'

/**
 * The Fabric data waiting in the composer: one chip per item (its kind, name and
 * workspace). Sent with the next message, which asks Copilot to connect it. A
 * chip opens the data picker to change the selection; × drops it.
 */
export function DataTray({
  sources,
  onOpen,
  onRemove
}: {
  sources: readonly DataSource[]
  onOpen: () => void
  onRemove: (itemId: string) => void
}): JSX.Element | null {
  const { t } = useTranslation('chat')
  if (sources.length === 0) return null
  return (
    <ul className="data-tray" aria-label={t('dataTray.toConnect')}>
      {sources.map((s) => {
        const kind = kindOfItem(s.item.type)
        return (
          <li key={s.item.id} className="data-chip">
            <button
              type="button"
              className="data-chip-main"
              onClick={onOpen}
              title={t('dataTray.chipTitle', {
                kind: kind?.label ?? t('dataTray.data'),
                workspace: s.workspaceName
              })}
            >
              <Codicon name={kind?.icon ?? 'database'} className="data-chip-ico" />
              <span className="data-chip-name">{s.item.name}</span>
              <span className="data-chip-ws">{s.workspaceName}</span>
            </button>
            <button
              type="button"
              className="data-chip-x"
              onClick={() => onRemove(s.item.id)}
              aria-label={t('tray.removeItem', { name: s.item.name })}
              title={t('actions.remove')}
            >
              <CloseIcon />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** The Fabric data a sent message asked Copilot to connect, as chips in the transcript. */
export function SentData({ data }: { data: readonly ChatDataRef[] }): JSX.Element {
  const { t } = useTranslation('chat')
  return (
    <ul className="msg-data" aria-label={t('dataTray.sent')}>
      {data.map((d, i) => {
        const kind = kindOfItem(d.type)
        return (
          <li
            key={i}
            className="data-chip data-chip--sent"
            title={t('dataTray.sentTitle', {
              kind: kind?.label ?? t('dataTray.data'),
              workspace: d.workspace
            })}
          >
            <Codicon name={kind?.icon ?? 'database'} className="data-chip-ico" />
            <span className="data-chip-name">{d.name}</span>
            <span className="data-chip-ws">{d.workspace}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** "Page 2 of 5: Regional sales", or "Setup and page 1 of 5: Overview" for the first turn. */
export function migrationChipLabel(migration: ChatMigrationRef): string {
  const t = translator('chat')
  const page = migration.page
  if (!page) return migration.foundation ? t('dataTray.setup') : t('dataTray.wrapUp')
  const where = { index: page.index + 1, total: page.count, name: page.name }
  return migration.foundation ? t('dataTray.setupAndPage', where) : t('dataTray.page', where)
}

/** The report-migration page a sent message asked Copilot to build, as a chip in the transcript. */
export function SentMigration({ migration }: { migration: ChatMigrationRef }): JSX.Element {
  const { t } = useTranslation('chat')
  return (
    <ul className="msg-data" aria-label={t('dataTray.migration')}>
      <li
        className="data-chip data-chip--sent"
        title={t('dataTray.migrating', { report: migration.reportName })}
      >
        <Codicon name="graph" className="data-chip-ico" />
        <span className="data-chip-name">{migration.reportName}</span>
        <span className="data-chip-ws">{migrationChipLabel(migration)}</span>
      </li>
    </ul>
  )
}
