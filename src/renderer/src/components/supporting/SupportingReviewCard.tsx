import { useEffect, useState, type JSX, type ReactNode } from 'react'
import type {
  SupportingReview,
  SupportingReviewItem,
  SupportingTableLoad,
  SupportingWorkspace,
  SupportingWorkspaceChoices
} from '@shared/ipc'
import { formatBytes } from '../blueprint/localData'
import { useTranslation } from '../../i18n'
import { Codicon } from '../icons'
import {
  changeText,
  checkText,
  countsLine,
  itemIcon,
  itemTypeLabel,
  storageLine,
  tableLine
} from './text'
import './supporting.css'

type T = (key: string, values?: Record<string, unknown>) => string

/** How long something has run, as m:ss. */
function elapsed(since: number | undefined, now: number): string | null {
  if (!since) return null
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Ticks once a second while `on`, for a running timer. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [on])
  return now
}

const isLakehouse = (item: SupportingReviewItem): boolean => item.type === 'Lakehouse'

/** What a card does to an item, in the words of its title: a lakehouse already in Fabric loads data. */
function action(item: SupportingReviewItem): 'create' | 'update' | 'load' | 'refresh' {
  if (item.change === 'update' && isLakehouse(item)) return 'load'
  return item.change
}

/**
 * The workspaces the user can pick on a card, for an app with none yet: the
 * shared ones the app's Fabric account, which Fabricator creates the items as,
 * can create items in, with the ones their apps are published to first.
 */
function WorkspacePick({
  projectId,
  value,
  disabled,
  onChange
}: {
  projectId: string
  value: SupportingWorkspace | null
  disabled: boolean
  onChange: (workspace: SupportingWorkspace | null) => void
}): JSX.Element {
  const { t } = useTranslation('supporting')
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ok'; choices: SupportingWorkspaceChoices }
    | { status: 'error'; error: string }
  >({ status: 'loading' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    window.api.supportingItems
      .workspaces(projectId)
      .then((choices) => alive && setState({ status: 'ok', choices }))
      .catch(
        (err: unknown) =>
          alive &&
          setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
      )
    return () => {
      alive = false
    }
  }, [projectId, tick])

  if (state.status === 'loading') {
    return (
      <span className="sup-pick-note">
        <Codicon name="loading" className="codicon-modifier-spin" /> {t('card.loadingWorkspaces')}
      </span>
    )
  }
  if (state.status === 'error') {
    return (
      <span className="sup-pick-note sup-pick-note--error" role="alert">
        <span>
          {t('card.workspacesFailed')} {state.error}
        </span>
        <button
          type="button"
          className="btn btn--xs btn--ghost"
          onClick={() => setTick((n) => n + 1)}
        >
          <Codicon name="refresh" /> {t('card.retry')}
        </button>
      </span>
    )
  }
  const { recent, others } = state.choices
  if (recent.length + others.length === 0) {
    return <span className="sup-pick-note">{t('card.noWorkspaces')}</span>
  }
  const option = (w: SupportingWorkspace): JSX.Element => (
    <option key={w.id} value={w.id}>
      {w.name}
    </option>
  )
  return (
    <select
      className="sup-pick"
      aria-label={t('card.pickWorkspace')}
      value={value?.id ?? ''}
      disabled={disabled}
      onChange={(e) =>
        onChange([...recent, ...others].find((w) => w.id === e.target.value) ?? null)
      }
    >
      <option value="">{t('card.pickWorkspace')}</option>
      {recent.length > 0 ? (
        <>
          <optgroup label={t('card.recentWorkspaces')}>{recent.map(option)}</optgroup>
          {others.length > 0 && (
            <optgroup label={t('card.allWorkspaces')}>{others.map(option)}</optgroup>
          )}
        </>
      ) : (
        others.map(option)
      )}
    </select>
  )
}

/** A dot and a word: how something stands. */
function Status({
  tone,
  spin,
  children
}: {
  tone: 'ok' | 'danger' | 'warn' | 'accent' | 'idle'
  spin?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <span className={`sup-status sup-status--${tone}`}>
      {spin ? (
        <Codicon name="loading" className="codicon-modifier-spin" />
      ) : (
        <span className={`sup-dot sup-dot--${tone}`} aria-hidden="true" />
      )}
      {children}
    </span>
  )
}

/** Where an item stands on the card, beside its name: what it does while
 *  the card waits (on a card of several), then how it's going. */
function ItemStatus({
  item,
  several
}: {
  item: SupportingReviewItem
  several: boolean
}): JSX.Element | null {
  const { t } = useTranslation('supporting')
  const tt = t as unknown as T
  switch (item.state) {
    case 'pending':
      return several ? <span className="sup-badge">{tt(`card.change.${action(item)}`)}</span> : null
    case 'working': {
      const loading = isLakehouse(item) && (item.tables ?? []).some((x) => x.state !== 'pending')
      const label =
        item.phase === 'refreshing'
          ? t('card.state.working.refresh')
          : loading
            ? t('card.state.working.load')
            : tt(`card.state.working.${item.change}`)
      return (
        <Status tone="accent" spin>
          {label}
        </Status>
      )
    }
    case 'done':
      return several ? <Status tone="ok">{tt(`card.state.done.${action(item)}`)}</Status> : null
    case 'failed':
      return several ? <Status tone="danger">{t('card.state.failed')}</Status> : null
    case 'skipped':
      return <Status tone="idle">{t('card.state.skipped')}</Status>
    default:
      return null
  }
}

/** A table a lakehouse loads: its file, and how its load is going. */
function TableRow({ table }: { table: SupportingTableLoad }): JSX.Element {
  const { t } = useTranslation('supporting')
  const tt = t as unknown as T
  const columns = table.columns ?? []
  let status: JSX.Element
  switch (table.state) {
    case 'working':
      status = (
        <Status tone="accent" spin>
          {tt(`card.table.${table.phase ?? 'uploading'}`)}
        </Status>
      )
      break
    case 'done':
      status = <Status tone="ok">{t('card.table.done')}</Status>
      break
    case 'failed':
      status = <Status tone="danger">{t('card.table.failed')}</Status>
      break
    case 'skipped':
      status = <Status tone="idle">{t('card.state.skipped')}</Status>
      break
    default:
      status = <span className="sup-table-change">{tt(`card.table.${table.change}`)}</span>
  }
  return (
    <li className={`sup-table sup-table--${table.state}`}>
      <Codicon name="table" className="sup-table-ico" />
      <div className="sup-table-main">
        <div className="sup-table-line">
          <span className="sup-table-name">{table.name}</span>
          <span className="sup-table-meta">{tableLine(table)}</span>
        </div>
        {columns.length > 0 && table.state === 'pending' && (
          <div className="sup-table-columns" title={columns.join(', ')}>
            {t('card.table.columns', { count: columns.length, names: columns.join(', ') })}
          </div>
        )}
        {table.error && <div className="sup-table-error">{table.error}</div>}
      </div>
      <span className="sup-table-status">{status}</span>
    </li>
  )
}

/** Something that went wrong, in a tinted box. */
function Trouble({ children, alert }: { children: ReactNode; alert?: boolean }): JSX.Element {
  return (
    <div className="sup-trouble" role={alert ? 'alert' : undefined}>
      <Codicon name="error" className="sup-trouble-ico" />
      <div className="sup-trouble-text">{children}</div>
    </div>
  )
}

/** One item on a card: what it is, what changes, and how it went. */
function ReviewItemBlock({
  item,
  review,
  several,
  onViewModel
}: {
  item: SupportingReviewItem
  review: SupportingReview
  several: boolean
  onViewModel?: (item: SupportingReviewItem) => void
}): JSX.Element {
  const { t } = useTranslation('supporting')
  const pending = review.state === 'pending'
  const lake = isLakehouse(item)
  const summary = item.summary
  const changes = item.changes ?? []
  const checks = item.checks ?? []
  const tables = item.tables ?? []
  const storage = lake ? '' : storageLine(summary)
  const bytes = tables.reduce((sum, table) => sum + table.bytes, 0)
  const open = (url?: string): void => {
    if (url) void window.api.openExternal(url)
  }
  return (
    <div className={`sup-item sup-item--${item.state}`}>
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
            <code className="sup-path">{item.folder}</code>
          </span>
        </div>
        <ItemStatus item={item} several={several} />
      </div>

      <div className="sup-item-body">
        {!lake && summary.tables > 0 && (
          <div className="sup-meta">
            <span>{countsLine(summary)}</span>
            {storage && <span>{storage}</span>}
          </div>
        )}
        {lake &&
          (tables.length > 0 ? (
            <>
              <div className="sup-meta">
                <span>
                  {t(pending ? 'card.lakeLoads' : 'card.lakeTables', {
                    count: tables.length,
                    size: formatBytes(bytes)
                  })}
                </span>
              </div>
              <ul className="sup-tables">
                {tables.map((table) => (
                  <TableRow key={table.name} table={table} />
                ))}
              </ul>
            </>
          ) : (
            pending && <p className="sup-note">{t('card.lakeEmpty')}</p>
          ))}

        {item.frames && pending && (
          <p className="sup-note">
            <Codicon name="sync" className="sup-note-ico" />
            {t('card.frames')}
          </p>
        )}
        {item.recreate && (
          <p className="sup-note">
            <Codicon name="info" className="sup-note-ico" />
            {t('card.recreate')}
          </p>
        )}
        {item.drift && (
          <p className="sup-note sup-note--warn">
            <span className="sup-dot sup-dot--warn" aria-hidden="true" />
            {t('card.drift')}
          </p>
        )}
        {item.unapplied && (
          <p className="sup-note">
            <Codicon name="info" className="sup-note-ico" />
            {t('card.unapplied')}
          </p>
        )}
        {item.change === 'update' &&
          !lake &&
          (item.changesUnknown ? (
            <p className="sup-note">{t('card.changesUnknown')}</p>
          ) : changes.length === 0 ? (
            <p className="sup-note">{t('card.noChanges')}</p>
          ) : (
            <ul className="sup-changes" aria-label={t('card.changesLabel')}>
              {changes.map((c, i) => (
                <li key={i} className={`sup-change sup-change--${c.op}`}>
                  <span className="sup-change-sign" aria-hidden="true">
                    {c.op === 'added' ? '+' : c.op === 'removed' ? '−' : '~'}
                  </span>
                  {changeText(c)}
                </li>
              ))}
              {(item.moreChanges ?? 0) > 0 && (
                <li className="sup-change sup-change--more">
                  {t('card.moreChanges', { count: item.moreChanges })}
                </li>
              )}
            </ul>
          ))}
        {pending && checks.length > 0 && (
          <ul className="sup-checks" aria-label={t('card.checksLabel')}>
            {checks.map((c, i) => (
              <li key={i} className="sup-check">
                <span className="sup-dot sup-dot--warn" aria-hidden="true" />
                {checkText(c)}
              </li>
            ))}
          </ul>
        )}
        {/* A lakehouse's tables say what didn't load. */}
        {((item.error && !tables.some((table) => table.error)) ||
          (item.errors ?? []).length > 0) && (
          <Trouble>
            {item.error && !tables.some((table) => table.error) && <p>{item.error}</p>}
            {(item.errors ?? []).length > 0 && (
              <ul className="sup-errors">
                {item.errors!.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </Trouble>
        )}
        {item.needsCredentials && (
          <p className="sup-note sup-note--warn">
            <span className="sup-dot sup-dot--warn" aria-hidden="true" />
            {t('card.credentials')}
          </p>
        )}
        {item.refreshInFabric && (
          <p className="sup-note sup-note--warn">
            <span className="sup-dot sup-dot--warn" aria-hidden="true" />
            {t('card.refreshInFabric')}
          </p>
        )}

        <div className="sup-item-actions">
          {onViewModel && !lake && item.change !== 'refresh' && (
            <button
              type="button"
              className="btn btn--xs btn--ghost"
              onClick={() => onViewModel(item)}
            >
              <Codicon name="type-hierarchy-sub" /> {t('card.viewModel')}
            </button>
          )}
          {item.url && (item.state === 'done' || item.refreshInFabric || item.itemId) && (
            <button type="button" className="btn btn--xs btn--ghost" onClick={() => open(item.url)}>
              <Codicon name="link-external" /> {t('card.openInFabric')}
            </button>
          )}
          {item.needsCredentials && item.settingsUrl && (
            <button
              type="button"
              className="btn btn--xs btn--ghost"
              onClick={() => open(item.settingsUrl)}
            >
              <Codicon name="settings-gear" /> {t('card.openSettings')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** The card's title: what it does to which item, by where it stands. */
function titleText(review: SupportingReview, t: T): string {
  const [first] = review.items
  const several = review.items.length > 1
  // A lakehouse that's in Fabric, some of whose tables didn't load.
  const loadFailed =
    review.state === 'failed' && first !== undefined && isLakehouse(first) && Boolean(first.itemId)
  const what = several ? 'apply' : loadFailed ? 'load' : first ? action(first) : 'apply'
  const values = { name: first?.name ?? '', count: review.items.length }
  switch (review.state) {
    case 'pending':
      return t(`card.title.pending.${what}`, values)
    case 'working':
      return t(`card.title.working.${what}`, values)
    case 'done':
      return t(`card.title.done.${what}`, values)
    case 'failed':
      return t(`card.title.failed.${what}`, values)
    case 'declined':
      return t(review.kind === 'refresh' ? 'card.head.declinedRefresh' : 'card.head.declined')
    default:
      // Approved, then the app closed or the turn stopped before it finished.
      return review.items.some((i) => i.state !== 'pending')
        ? t('card.head.stopped')
        : t('card.head.interrupted')
  }
}

/** The approve button's label: what approving does. */
function approveLabel(review: SupportingReview, t: T): string {
  if (review.kind === 'refresh') return t('card.approve.refresh')
  const kinds = new Set(review.items.map(action))
  if (kinds.size === 1) {
    const [only] = [...kinds]
    if (only === 'create' || only === 'update' || only === 'load') return t(`card.approve.${only}`)
  }
  return t('card.approve.apply')
}

/** The icon of a card's head, by where it stands. */
function headIcon(review: SupportingReview): { name: string; spin?: boolean } {
  switch (review.state) {
    case 'working':
      return { name: 'sync', spin: true }
    case 'done':
      return { name: 'check' }
    case 'failed':
      return { name: 'error' }
    default:
      return {
        name: review.kind === 'refresh' ? 'sync' : itemIcon(review.items[0]?.type ?? '')
      }
  }
}

/**
 * A supporting items review card in the chat: what Fabricator will create,
 * change, load or refresh in Fabric, where and as whom, waiting for the user
 * to approve; then how it went. Docked in the turn where Copilot asked. It
 * looks like the chat's plan card: a stripe and an icon in the color of where
 * it stands, and the action first.
 */
export function SupportingReviewCard({
  review,
  busy,
  error,
  onResolve,
  onViewModel
}: {
  review: SupportingReview
  /** The answer is on its way. */
  busy: boolean
  /** Why the answer didn't go through. */
  error?: string
  onResolve: (approve: boolean, workspace?: SupportingWorkspace) => void
  onViewModel?: (item: SupportingReviewItem) => void
}): JSX.Element {
  const { t } = useTranslation('supporting')
  const tt = t as unknown as T
  const [picked, setPicked] = useState<SupportingWorkspace | null>(null)
  const pending = review.state === 'pending'
  const working = review.state === 'working'
  const now = useNow(working)
  const settled = review.state === 'declined' || review.state === 'interrupted'
  const workspace = review.workspace ?? (review.pickWorkspace ? null : undefined)
  const title = titleText(review, tt)

  if (settled) {
    return (
      <div className={`sup-card sup-card--settled sup-card--${review.state}`}>
        <Codicon name="circle-slash" className="sup-card-settled-ico" />
        <span className="sup-card-settled-head">{title}</span>
        <span className="sup-card-settled-items">{review.items.map((i) => i.name).join(', ')}</span>
      </div>
    )
  }

  const icon = headIcon(review)
  const started = review.items
    .map((i) => i.startedAt)
    .filter((at): at is number => typeof at === 'number')
  const timer = working && started.length ? elapsed(Math.min(...started), now) : null
  const needsPick = pending && Boolean(review.pickWorkspace) && picked === null
  const canApprove = pending && !busy && !needsPick
  const several = review.items.length > 1
  return (
    <section
      className={`sup-card sup-card--${review.state}`}
      aria-label={title}
      aria-busy={working || undefined}
    >
      <header className="sup-card-head">
        <span className="sup-card-ico" aria-hidden="true">
          <Codicon name={icon.name} className={icon.spin ? 'codicon-modifier-spin' : undefined} />
        </span>
        <div className="sup-card-titles">
          <h3 className="sup-card-title">{title}</h3>
          {review.reason && (
            <p className="sup-card-reason">{t('card.reason', { reason: review.reason })}</p>
          )}
        </div>
        {timer && <span className="sup-card-timer">{timer}</span>}
      </header>

      <dl className="sup-facts">
        <div className="sup-fact">
          <dt>{t('card.workspace')}</dt>
          <dd>
            {workspace ? (
              workspace.name
            ) : pending && review.projectId ? (
              <WorkspacePick
                projectId={review.projectId}
                value={picked}
                disabled={busy}
                onChange={setPicked}
              />
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div className="sup-fact">
          <dt>{t('card.account')}</dt>
          <dd>{review.account || t('card.unknownAccount')}</dd>
        </div>
        {review.uploadsAs && (
          <div className="sup-fact">
            <dt>{t('card.uploadsAs')}</dt>
            <dd>{review.uploadsAs}</dd>
          </div>
        )}
      </dl>
      {pending && review.pickWorkspace && <p className="sup-hint">{t('card.pickHint')}</p>}

      <div className="sup-items">
        {review.items.map((item) => (
          <ReviewItemBlock
            key={item.key}
            item={item}
            review={review}
            several={several}
            onViewModel={onViewModel}
          />
        ))}
      </div>

      {review.error && <Trouble>{review.error}</Trouble>}
      {error && <Trouble alert>{t('card.resolveFailed', { error })}</Trouble>}
      {review.state === 'failed' && <p className="sup-hint">{t('card.copilotSees')}</p>}

      {pending && (
        <footer className="sup-card-foot">
          {review.kind === 'apply' && (
            <p className="sup-footnote">
              <Codicon name="info" className="sup-footnote-ico" />
              {t('card.footnote')}
            </p>
          )}
          <div className="sup-card-actions">
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!canApprove}
              title={needsPick ? t('card.pickFirst') : undefined}
              onClick={() => onResolve(true, picked ?? undefined)}
            >
              {approveLabel(review, tt)}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={busy}
              onClick={() => onResolve(false)}
            >
              {review.kind === 'refresh' ? t('card.declineRefresh') : t('card.decline')}
            </button>
          </div>
        </footer>
      )}
    </section>
  )
}
