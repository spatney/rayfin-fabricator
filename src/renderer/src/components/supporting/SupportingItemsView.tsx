import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react'
import type {
  StudioProject,
  SupportingFabricState,
  SupportingItemsView as SupportingItems,
  SupportingListedItem,
  SupportingListedTable
} from '@shared/ipc'
import { useTranslation } from '../../i18n'
import { useToast } from '../../toast'
import { openDocs } from '../../docsLinks'
import { fabricWorkspaceUrl } from '../../fabric'
import { ago } from '../gallery/model'
import ConfirmModal from '../ConfirmModal'
import { Codicon } from '../icons'
import { ViewHead } from '../blueprint/ViewHead'
import SupportingModelDialog from './SupportingModelDialog'
import { countsLine, itemIcon, itemTypeLabel, problemText, storageLine, tableLine } from './text'
import './supporting.css'

type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'idle'

/** Whether a model reads its data when it's refreshed: Import, or Direct Lake reading its tables again. */
function refreshes(item: SupportingListedItem): boolean {
  return ['import', 'dual', 'mixed', 'directLake'].includes(item.summary?.storage ?? '')
}

/** The status dot's tone. */
function tone(item: SupportingListedItem, fabric?: SupportingFabricState): Tone {
  if (fabric?.exists === false || item.status === 'unreadable') return 'danger'
  if (fabric?.drift || item.status === 'changed' || item.status === 'removed') return 'warn'
  if (item.status === 'applied') return 'ok'
  return 'idle'
}

/** A dot and a word. */
function Status({ tone, children }: { tone: Tone; children: ReactNode }): JSX.Element {
  return (
    <span className={`sup-status sup-status--${tone}`}>
      <span className={`sup-dot sup-dot--${tone}`} aria-hidden="true" />
      {children}
    </span>
  )
}

/** A fact about an item in Fabric, as the Advisor shows its counts: a dot and a few words. */
function Chip({ tone, children }: { tone?: Tone; children: ReactNode }): JSX.Element {
  return <span className={`sup-chip${tone ? ` sup-chip--${tone}` : ''}`}>{children}</span>
}

/** A lakehouse's tables: each one's file, and when it was loaded. */
function TableList({ tables }: { tables: SupportingListedTable[] }): JSX.Element {
  const { t } = useTranslation('supporting')
  return (
    <ul className="sup-tables" aria-label={t('view.tables')}>
      {tables.map((table) => (
        <li key={table.name} className="sup-table">
          <Codicon name="table" className="sup-table-ico" />
          <div className="sup-table-main">
            <div className="sup-table-line">
              <span className="sup-table-name">{table.name}</span>
              <span className="sup-table-meta">{tableLine(table)}</span>
            </div>
          </div>
          <span className="sup-table-status">
            {table.changed ? (
              <Status tone="warn">{t('view.table.changed')}</Status>
            ) : table.loadedAt ? (
              <span className="sup-table-change">
                {t('view.table.loaded', { when: ago(table.loadedAt) ?? '' })}
              </span>
            ) : (
              <span className="sup-table-change">{t('view.table.notLoaded')}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Blueprint's Supporting items view: the Fabric items this app relies on that
 * aren't part of the Rayfin app (the semantic models its pages read and the
 * lakehouses their data is staged in), as `supporting-items/` defines them, and
 * where each stands in Fabric. Applying and refreshing go through the chat,
 * where the user approves each change; deleting one from Fabric happens only
 * here.
 */
export default function SupportingItemsView({
  project,
  items: view,
  usedItemIds,
  onChanged,
  onOpenFile,
  onSendToChat,
  onRefreshAuth,
  onPluginsChanged
}: {
  project: StudioProject
  items: SupportingItems
  /** The Fabric item ids the app reads from (lowercase). */
  usedItemIds: ReadonlySet<string>
  /** The view changed, as Fabricator now has it. */
  onChanged: (view: SupportingItems) => void
  onOpenFile: (path: string) => void
  onSendToChat: (display: string, prompt: string, stage?: boolean) => void
  /** Sign in to Fabric again, as the account menu does. */
  onRefreshAuth?: () => void
  /** The app's chat turned a plugin on. */
  onPluginsChanged?: () => void
}): JSX.Element {
  const { t } = useTranslation('supporting')
  const toast = useToast()
  const [fabric, setFabric] = useState<Map<string, SupportingFabricState> | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [modelOf, setModelOf] = useState<SupportingListedItem | null>(null)
  const [deleting, setDeleting] = useState<SupportingListedItem | null>(null)
  const [removeFolder, setRemoveFolder] = useState(false)
  const [busy, setBusy] = useState(false)
  const [turningOn, setTurningOn] = useState(false)

  const created = view.items.filter((i) => i.itemId).length
  const fabricKey = view.items.map((i) => `${i.key}:${i.itemId ?? ''}`).join('|')
  useEffect(() => {
    if (!created) {
      setFabric(new Map())
      return
    }
    let alive = true
    setFabric(null)
    setNeedsSignIn(false)
    window.api.supportingItems.fabric(project.id).then(
      (states) => {
        if (!alive) return
        setFabric(new Map(states.map((s) => [s.key, s])))
        setNeedsSignIn(states.some((s) => s.needsSignIn))
      },
      () => alive && setFabric(new Map())
    )
    return () => {
      alive = false
    }
  }, [project.id, created, fabricKey])

  const openDefinition = useCallback(
    (item: SupportingListedItem) =>
      onOpenFile(
        item.type === 'Lakehouse'
          ? `supporting-items/${item.folder}/tables.json`
          : `supporting-items/${item.folder}/definition/model.tmdl`
      ),
    [onOpenFile]
  )

  async function confirmDelete(): Promise<void> {
    if (!deleting?.key) return
    setBusy(true)
    try {
      const next = await window.api.supportingItems.remove(project.id, deleting.key, removeFolder)
      toast.success(t('view.delete.done', { name: deleting.name }))
      onChanged(next)
      setDeleting(null)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      toast.error(t('view.delete.failed', { name: deleting.name, error }))
    } finally {
      setBusy(false)
    }
  }

  async function turnOn(): Promise<void> {
    setTurningOn(true)
    try {
      await window.api.chat.setPlugin(project.id, 'supporting-items', true)
      onChanged(await window.api.supportingItems.list(project.id))
      onPluginsChanged?.()
    } catch (err) {
      toast.error(
        t('view.turnOnFailed', { error: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setTurningOn(false)
    }
  }

  const workspaceUrl = fabricWorkspaceUrl(view.workspace?.id)
  const intro = (
    <p className="sup-view-intro">
      <Codicon name="info" className="sup-view-intro-ico" />
      <span>
        {t('view.intro')}{' '}
        <button type="button" className="sup-link" onClick={() => openDocs('supportingItems')}>
          {t('view.learnMore')}
        </button>
      </span>
    </p>
  )

  let body: JSX.Element
  if (view.items.length === 0) {
    const off = view.available && !view.on
    body = (
      <div className="model-empty model-empty--cta sup-view-empty">
        <span className="bp-data-empty-ico">
          <Codicon name="layers" />
        </span>
        <div className="model-empty-title">{off ? t('view.offTitle') : t('view.emptyTitle')}</div>
        <p className="model-empty-sub">
          {project.team ? t('view.unavailableTeam') : off ? t('view.emptyOff') : t('view.emptyOn')}
        </p>
        <div className="sup-view-empty-actions">
          {off && (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={turningOn}
              onClick={() => void turnOn()}
            >
              {t('view.actions.turnOn')}
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => openDocs('supportingItems')}
          >
            <Codicon name="book" /> {t('view.learnMore')}
          </button>
        </div>
      </div>
    )
  } else {
    body = (
      <div className="sup-view-inner">
        {intro}
        {view.error && (
          <div className="sup-trouble" role="alert">
            <Codicon name="error" className="sup-trouble-ico" />
            <div className="sup-trouble-text">{view.error}</div>
          </div>
        )}
        {view.available && !view.on && (
          <div className="sup-banner">
            <span className="sup-dot sup-dot--warn" aria-hidden="true" />
            <span className="sup-banner-text">{t('view.offNote')}</span>
            <button
              type="button"
              className="btn btn--xs"
              disabled={turningOn}
              onClick={() => void turnOn()}
            >
              {t('view.actions.turnOn')}
            </button>
          </div>
        )}
        {needsSignIn && (
          <div className="sup-banner">
            <span className="sup-dot sup-dot--warn" aria-hidden="true" />
            <span className="sup-banner-text">{t('view.signIn')}</span>
            {onRefreshAuth && (
              <button type="button" className="btn btn--xs" onClick={onRefreshAuth}>
                <Codicon name="refresh" /> {t('view.refreshAuth')}
              </button>
            )}
          </div>
        )}

        <section className="sup-group" aria-label={t('view.workspaceLabel')}>
          <header className="sup-group-head">
            <span className="sup-group-label">{t('view.workspaceLabel')}</span>
            {view.workspace ? (
              <>
                <span className="sup-group-name">{view.workspace.name}</span>
                {workspaceUrl && (
                  <button
                    type="button"
                    className="btn btn--xs btn--ghost sup-group-open"
                    onClick={() => void window.api.openExternal(workspaceUrl)}
                  >
                    <Codicon name="link-external" /> {t('view.actions.openWorkspace')}
                  </button>
                )}
              </>
            ) : (
              <span className="sup-group-note">
                {view.target ? t('view.target', { name: view.target.name }) : t('view.noTarget')}
              </span>
            )}
          </header>

          <ul className="sup-list">
            {view.items.map((item) => {
              const state = item.key ? fabric?.get(item.key) : undefined
              const lake = item.type === 'Lakehouse'
              const status =
                state?.exists === false
                  ? t('view.status.notInFabric')
                  : state?.drift
                    ? t('view.status.drift')
                    : item.status
                      ? t(`view.status.${item.status}`)
                      : ''
              const used = item.itemId ? usedItemIds.has(item.itemId.toLowerCase()) : false
              const refreshedAt = ago(state?.refreshedAt)
              const refresh: [string, Tone] | null =
                state?.refresh === 'succeeded'
                  ? [t('view.refresh.succeeded', { when: refreshedAt ?? '' }), 'ok']
                  : state?.refresh === 'failed'
                    ? [t('view.refresh.failed', { when: refreshedAt ?? '' }), 'danger']
                    : state?.refresh === 'running'
                      ? [t('view.refresh.running'), 'accent']
                      : state?.refresh === 'cancelled'
                        ? [t('view.refresh.cancelled'), 'warn']
                        : null
              const inFabric = Boolean(item.itemId) && state?.exists !== false
              const canApply =
                view.on && (item.status === 'notCreated' || item.status === 'changed')
              const canRefresh =
                view.on && !lake && inFabric && item.status !== 'removed' && refreshes(item)
              const canConnect = view.on && !lake && inFabric && !used && item.status !== 'removed'
              const folderPath = `supporting-items/${item.folder}`
              const storage = !lake && item.summary ? storageLine(item.summary) : ''
              const tables = item.tables ?? []
              return (
                <li key={item.key ?? item.folder} className="sup-row">
                  <div className="sup-item-head">
                    <span className="sup-tile" aria-hidden="true">
                      <Codicon name={itemIcon(item.type)} />
                    </span>
                    <div className="sup-item-titles">
                      <span className="sup-item-name">{item.name}</span>
                      <span className="sup-item-sub">
                        <span className="sup-item-type">{itemTypeLabel(item.type)}</span>
                        <span className="sup-sep" aria-hidden="true">
                          ·
                        </span>
                        <code className="sup-path">{folderPath}</code>
                      </span>
                    </div>
                    {status && <Status tone={tone(item, state)}>{status}</Status>}
                  </div>

                  <div className="sup-item-body">
                    {!lake && item.summary && item.summary.tables > 0 && (
                      <div className="sup-meta">
                        <span>{countsLine(item.summary)}</span>
                        {storage && <span>{storage}</span>}
                      </div>
                    )}
                    {lake && tables.length > 0 && <TableList tables={tables} />}
                    {lake && tables.length === 0 && item.status !== 'unreadable' && (
                      <p className="sup-note">{t('view.noTables')}</p>
                    )}

                    <div className="sup-chips">
                      {item.appliedAt && (
                        <Chip>{t('view.applied', { when: ago(item.appliedAt) ?? '' })}</Chip>
                      )}
                      {item.itemId && fabric === null && (
                        <Chip tone="accent">
                          <Codicon name="loading" className="codicon-modifier-spin" />
                          {t('view.checking')}
                        </Chip>
                      )}
                      {refresh && <Chip tone={refresh[1]}>{refresh[0]}</Chip>}
                      {lake && state?.tables && (
                        <Chip>{t('view.fabricTables', { count: state.tables.length })}</Chip>
                      )}
                      {!lake && item.itemId && (
                        <Chip tone={used ? 'ok' : 'warn'}>
                          {used ? t('view.usedByApp') : t('view.notUsedByApp')}
                        </Chip>
                      )}
                    </div>

                    {(item.problems ?? []).length > 0 && (
                      <ul className="sup-checks" aria-label={t('view.problems')}>
                        {item.problems!.slice(0, 8).map((p, i) => (
                          <li key={i} className="sup-check">
                            <span className="sup-dot sup-dot--danger" aria-hidden="true" />
                            {problemText(p)}
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="sup-row-actions">
                      <div className="sup-row-actions-main">
                        {canApply && (
                          <button
                            type="button"
                            className="btn btn--xs btn--ghost"
                            onClick={() =>
                              onSendToChat(
                                t('view.prompts.applyDisplay', { name: item.name }),
                                t('view.prompts.apply', { name: item.name, folder: folderPath })
                              )
                            }
                          >
                            <Codicon name="sparkle" /> {t('view.actions.apply')}
                          </button>
                        )}
                        {canRefresh && (
                          <button
                            type="button"
                            className="btn btn--xs btn--ghost"
                            onClick={() =>
                              onSendToChat(
                                t('view.prompts.refreshDisplay', { name: item.name }),
                                t('view.prompts.refresh', { name: item.name, folder: folderPath })
                              )
                            }
                          >
                            <Codicon name="sync" /> {t('view.actions.refresh')}
                          </button>
                        )}
                        {canConnect && (
                          <button
                            type="button"
                            className="btn btn--xs btn--ghost"
                            onClick={() =>
                              onSendToChat(
                                t('view.prompts.connectDisplay', { name: item.name }),
                                t('view.prompts.connect', { name: item.name, folder: folderPath })
                              )
                            }
                          >
                            <Codicon name="plug" /> {t('view.actions.connect')}
                          </button>
                        )}
                        {!lake && item.status !== 'removed' && item.status !== 'unreadable' && (
                          <button
                            type="button"
                            className="btn btn--xs btn--ghost"
                            onClick={() => setModelOf(item)}
                          >
                            <Codicon name="type-hierarchy-sub" /> {t('view.actions.viewModel')}
                          </button>
                        )}
                        {item.status !== 'removed' && (
                          <button
                            type="button"
                            className="btn btn--xs btn--ghost"
                            onClick={() => openDefinition(item)}
                          >
                            <Codicon name="go-to-file" /> {t('view.actions.openDefinition')}
                          </button>
                        )}
                        {item.url && state?.exists !== false && (
                          <button
                            type="button"
                            className="btn btn--xs btn--ghost"
                            onClick={() => void window.api.openExternal(item.url!)}
                          >
                            <Codicon name="link-external" /> {t('view.actions.openInFabric')}
                          </button>
                        )}
                      </div>
                      {item.itemId && item.key && (
                        <button
                          type="button"
                          className="btn btn--xs btn--ghost sup-danger-btn"
                          onClick={() => {
                            setRemoveFolder(false)
                            setDeleting(item)
                          }}
                        >
                          <Codicon name="trash" /> {t('view.actions.delete')}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      </div>
    )
  }

  return (
    <div className="sup-view">
      <ViewHead
        title={t('view.title')}
        subtitle={t('view.subtitle', { count: view.items.length })}
      />
      {body}

      {modelOf && (
        <SupportingModelDialog
          projectId={project.id}
          name={modelOf.name}
          folder={modelOf.folder}
          summary={modelOf.summary}
          onClose={() => setModelOf(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={t('view.delete.title', { name: deleting.name })}
          danger
          busy={busy}
          busyLabel={t('view.delete.deleting')}
          confirmLabel={t('view.delete.confirm')}
          message={
            <>
              <p className="sup-delete-text">
                {t(
                  deleting.type === 'Lakehouse'
                    ? 'view.delete.messageLakehouse'
                    : 'view.delete.message',
                  {
                    name: deleting.name,
                    workspace: view.workspace?.name ?? ''
                  }
                )}
              </p>
              {deleting.status !== 'removed' && (
                <label className="sup-delete-folder">
                  <input
                    type="checkbox"
                    checked={removeFolder}
                    disabled={busy}
                    onChange={(e) => setRemoveFolder(e.target.checked)}
                  />
                  {t('view.delete.removeFolder', { folder: `supporting-items/${deleting.folder}` })}
                </label>
              )}
            </>
          }
          onConfirm={() => void confirmDelete()}
          onCancel={() => !busy && setDeleting(null)}
        />
      )}
    </div>
  )
}
