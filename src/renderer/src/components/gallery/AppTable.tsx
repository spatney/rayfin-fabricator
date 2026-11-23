import type { JSX } from 'react'
import type { GalleryApp } from '@shared/ipc'
import { translator, useTranslation } from '../../i18n'
import { Codicon } from '../icons'
import { ProjectTile } from '../ProjectTile'
import { AppTags, HealthTag, quickLookKeys } from './AppCard'
import { ago, fullDate, type GalleryEntry } from './model'
import { WorkspaceName } from './WorkspacePicker'

/** "3 days ago", "Last week", "Not yet", or a placeholder while Fabric hasn't said. */
function publishedCell(entry: GalleryEntry): string {
  const { status } = entry
  if (!status) return '…'
  if (status.unknown) return '—'
  const when = ago(status.publishedAt)
  return when ? when[0].toUpperCase() + when.slice(1) : translator('gallery')('published.notYet')
}

/**
 * The apps as a table: one row each, denser than the cards, for workspaces
 * with many apps. A row selects its app (its details open beside the table);
 * Space looks at the live app.
 */
export default function AppTable({
  entries,
  selectedId,
  label,
  showWorkspace = true,
  picture,
  updateOf,
  canLook,
  onSelect,
  onPin,
  onQuickLook
}: {
  entries: readonly GalleryEntry[]
  selectedId: string | null
  label: string
  /** Off under a workspace's own heading. */
  showWorkspace?: boolean
  /** An app's thumbnail from this computer. */
  picture: (app: GalleryApp) => string | undefined
  /** The Rayfin version an app's project could update to. */
  updateOf: (app: GalleryApp) => string | null
  /** Whether an app has a page to look at. */
  canLook: (entry: GalleryEntry) => boolean
  onSelect: (app: GalleryApp) => void
  onPin: (app: GalleryApp, keyboard: boolean) => void
  onQuickLook: (app: GalleryApp) => void
}): JSX.Element {
  const { t } = useTranslation('gallery')
  return (
    <table className="gtable" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">{t('table.name')}</th>
          {showWorkspace && <th scope="col">{t('table.workspace')}</th>}
          <th scope="col">{t('table.published')}</th>
          <th scope="col">{t('table.status')}</th>
          <th scope="col">{t('table.where')}</th>
          <th scope="col">
            <span className="sr-only">{t('table.pin')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const { app, status, pinned, issues } = entry
          const selected = app.id === selectedId
          const shown = issues.filter((issue) => issue !== 'unpublished')
          return (
            <tr key={app.id} className={`gtable-row${selected ? ' is-selected' : ''}`}>
              <td className="gtable-name">
                <span className="gtable-name-cell">
                  <ProjectTile name={app.name} thumbnail={picture(app)} className="gtable-tile" />
                  <span className="gtable-name-text">
                    <button
                      type="button"
                      className="gtable-open"
                      data-app-id={app.id}
                      aria-label={t('app.label', { name: app.name, workspace: app.workspaceName })}
                      aria-pressed={selected}
                      aria-keyshortcuts={canLook(entry) ? 'Space' : undefined}
                      onClick={() => onSelect(app)}
                      {...quickLookKeys(canLook(entry) ? () => onQuickLook(app) : undefined)}
                    >
                      {app.name}
                    </button>
                    {app.description && <span className="gtable-desc">{app.description}</span>}
                  </span>
                </span>
              </td>
              {showWorkspace && (
                <td className="gtable-ws" title={app.workspaceName}>
                  <WorkspaceName name={app.workspaceName} />
                </td>
              )}
              <td className="gtable-time" title={fullDate(status?.publishedAt)}>
                {publishedCell(entry)}
              </td>
              <td className="gtable-status">
                {shown.length > 0 ? (
                  shown.map((issue) => (
                    <HealthTag key={issue} issue={issue} update={updateOf(app)} />
                  ))
                ) : (
                  <span className="gtable-none">—</span>
                )}
              </td>
              <td className="gtable-where">
                <AppTags app={app} />
              </td>
              <td className="gtable-pin-cell">
                <button
                  type="button"
                  className="icon-btn gtable-pin"
                  data-pin-for={app.id}
                  aria-label={t('app.pin', { name: app.name })}
                  aria-pressed={pinned}
                  title={pinned ? t('app.unpin') : t('app.pinToTop')}
                  onClick={(event) => onPin(app, event.detail === 0)}
                >
                  <Codicon name={pinned ? 'pinned' : 'pin'} />
                </button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
