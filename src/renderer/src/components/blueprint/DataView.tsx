import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react'
import type {
  LocalBackendState,
  LocalEntity,
  LocalRows,
  LocalUser,
  StudioProject
} from '@shared/ipc'
import type { DataModel } from '../../model/parseSchema'
import { reportEvent } from '../../errorReport'
import {
  backendStamp,
  localBackendStore,
  localFallbackReason,
  localStateLabel,
  refusedSchemaLosses,
  toLocalBackendError,
  useLocalBackend,
  type LocalBackend,
  type LocalBackendError
} from '../../localBackend'
import ConfirmModal from '../ConfirmModal'
import { Codicon } from '../icons'
import { describeProblem } from '../local/problems'
import {
  formatCell,
  formatDate,
  isNumberColumn,
  listNames,
  PAGE_SIZE,
  plural,
  referrersOf
} from './localData'
import { ViewHead } from './ViewHead'
import './blueprint.css'

interface Props {
  project: StudioProject
  /** Bumped when the app may have changed (e.g. after a chat turn): read the data again. */
  refreshKey: number
  /** The app's data model, to name the entities whose rows refer to others. */
  dataModel?: DataModel
}

type Selection = { kind: 'entity'; name: string } | { kind: 'users' }

interface Overview {
  entities: LocalEntity[]
  /** `null` when they couldn't be read (see `usersError`). */
  users: LocalUser[] | null
  usersError: LocalBackendError | null
}

type Confirm =
  | { kind: 'clear'; entity: string; rows: number }
  | { kind: 'reset' }
  | { kind: 'delete-user'; user: LocalUser }

const STATE_DOT: Record<LocalBackendState, string> = {
  running: 'ok',
  starting: 'warn',
  restarting: 'warn',
  error: 'danger',
  stopped: 'off'
}

const SIGN_IN_LABEL: Record<string, string> = {
  password: 'Password',
  entra: 'Microsoft Entra ID'
}

/**
 * Blueprint's Data view: the app's local data, as its local backend
 * (rayfin-local) stores it on this computer. The entities with their row
 * counts and the local users; a page of the selected entity's rows, read-only
 * and sortable; and clearing an entity's rows or every bit of local data.
 * Team apps have no local backend, so they only get a note.
 */
export default function DataView({ project, refreshKey, dataModel }: Props): JSX.Element {
  const team = Boolean(project.team)

  useEffect(() => {
    reportEvent(
      'preview',
      'local.data_view_opened',
      team
        ? 'Opened the Data view of a team app, which has no local data.'
        : 'Opened the Data view of the app’s local data.',
      { projectId: project.id }
    )
  }, [project.id, team])

  if (team) {
    return (
      <div className="bp-data">
        <ViewHead title="Data" subtitle="Local data only" />
        <Empty
          icon="cloud"
          title="Local data only"
          sub="The Data view shows data stored on this computer. This team app runs on its Fabric deployment, so its data lives in Fabric."
        />
      </div>
    )
  }
  if (!window.api?.local) {
    return (
      <div className="bp-data">
        <ViewHead title="Data" subtitle="Local data" />
        <Problem
          title="Couldn’t reach the local backend"
          error={{ message: 'This version of Fabricator can’t read local data.' }}
        />
      </div>
    )
  }
  return <LocalData project={project} refreshKey={refreshKey} dataModel={dataModel} />
}

function LocalData({ project, refreshKey, dataModel }: Props): JSX.Element {
  const projectId = project.id
  const backend = useLocalBackend(projectId)
  const { status, state } = backend
  const running = state === 'running'
  const published = Boolean(project.lastDeploy?.url)
  // A published app the local backend can't run previews on its published backend.
  const fallback = published ? localFallbackReason(status) : null
  // A data model change that would delete data waits for a decision; a reset leaves none to lose.
  const schemaWaiting = running && refusedSchemaLosses(status) !== null
  const note = published
    ? 'Local data on this computer, separate from the published app’s data.'
    : 'Local data on this computer. Publishing doesn’t copy it to Fabric.'

  // The hook reads the status too, but keeps a failure to itself.
  const [statusError, setStatusError] = useState<LocalBackendError | null>(null)
  const [statusTry, setStatusTry] = useState(0)
  useEffect(() => {
    let alive = true
    setStatusError(null)
    localBackendStore.refresh(projectId).catch((reason: unknown) => {
      if (alive) setStatusError(toLocalBackendError(reason))
    })
    return () => {
      alive = false
    }
  }, [projectId, statusTry])

  // Read everything again on Refresh, after a chat turn, and when the backend
  // rebuilds the app (a new model, schema or configuration).
  const [nonce, setNonce] = useState(0)
  const live = running ? backendStamp(status) : ''
  const reloadKey = `${refreshKey}|${live}|${nonce}`
  const reload = useCallback((): void => {
    setNonce((n) => n + 1)
    void localBackendStore.refresh(projectId).catch(() => undefined)
  }, [projectId])

  const [overview, setOverview] = useState<Overview | null>(null)
  const [overviewError, setOverviewError] = useState<LocalBackendError | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!running) {
      setOverview(null)
      setOverviewError(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    const users = window.api.local.users(projectId).then(
      (list): Pick<Overview, 'users' | 'usersError'> => ({ users: list, usersError: null }),
      (reason: unknown) => ({ users: null, usersError: toLocalBackendError(reason) })
    )
    Promise.all([window.api.local.entities(projectId), users])
      .then(
        ([entities, people]) => {
          if (!alive) return
          setOverview({ entities, ...people })
          setOverviewError(null)
        },
        (reason: unknown) => {
          if (!alive) return
          const error = toLocalBackendError(reason)
          setOverviewError(error)
          // It stopped meanwhile: its state says so.
          if (error.code === 'not-running')
            void localBackendStore.refresh(projectId).catch(() => undefined)
        }
      )
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [running, projectId, reloadKey])

  const entities = overview?.entities ?? []
  const users = overview?.users ?? null
  const showUsers = status?.ready?.features.auth.enabled !== false || (users?.length ?? 0) > 0
  const [selected, setSelected] = useState<Selection | null>(null)
  const current: Selection | null =
    selected?.kind === 'users' && showUsers
      ? selected
      : selected?.kind === 'entity' && entities.some((e) => e.name === selected.name)
        ? selected
        : entities.length > 0
          ? { kind: 'entity', name: entities[0].name }
          : showUsers
            ? { kind: 'users' }
            : null

  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [confirmError, setConfirmError] = useState<LocalBackendError | null>(null)
  const closeConfirm = useCallback((): void => {
    setConfirm(null)
    setConfirmError(null)
  }, [])

  const perform = async (work: () => Promise<void>): Promise<void> => {
    setConfirmBusy(true)
    setConfirmError(null)
    try {
      await work()
      setConfirm(null)
    } catch (reason) {
      setConfirmError(toLocalBackendError(reason))
    } finally {
      setConfirmBusy(false)
      // Part of it may have happened before it failed.
      reload()
    }
  }

  const confirmed = (): void => {
    if (!confirm) return
    if (confirm.kind === 'clear') {
      void perform(async () => {
        const deleted = await window.api.local.clearRows(projectId, confirm.entity)
        reportEvent(
          'preview',
          'local.rows_cleared',
          `Cleared ${plural(deleted, 'row')} of ${confirm.entity} from the local data.`,
          { projectId }
        )
      })
    } else if (confirm.kind === 'reset') {
      void perform(async () => {
        await window.api.local.resetData(projectId)
        // It signed every session out: the preview forgets its own, and signs in again.
        void window.api.preview.resetSiteData().catch(() => undefined)
        reportEvent('preview', 'local.data_reset', 'Reset the app’s local data.', { projectId })
        if (schemaWaiting) await window.api.local.reload(projectId, false)
      })
    } else {
      void perform(() => window.api.local.deleteUser(projectId, confirm.user.id))
    }
  }

  const totalRows = entities.reduce((sum, e) => sum + e.rows, 0)
  const head = (
    <ViewHead
      title="Data"
      subtitle={
        overview
          ? `${plural(entities.length, 'entity', 'entities')} · ${plural(totalRows, 'row')}`
          : 'Local data'
      }
      legend={
        <div className="model-legend">
          <span className="model-legend-label">Local backend</span>
          <span className="model-legend-item">
            <span className={`bp-dot bp-dot--${status ? STATE_DOT[state] : 'off'}`} />
            {status ? localStateLabel(status) : statusError ? 'Unknown' : 'Checking…'}
          </span>
        </div>
      }
    />
  )

  let body: ReactNode
  if (!status) {
    body = statusError ? (
      <Problem
        title="Couldn’t reach the local backend"
        error={statusError}
        onRetry={() => setStatusTry((n) => n + 1)}
      />
    ) : (
      <div className="model-empty">Checking the local backend…</div>
    )
  } else if (!running) {
    body = <BackendState backend={backend} />
  } else if (overviewError) {
    body = (
      <Problem
        title="Couldn’t read the local data"
        error={readable(overviewError)}
        onRetry={reload}
      />
    )
  } else if (!overview) {
    body = <div className="model-empty">Reading local data…</div>
  } else {
    const entity =
      current?.kind === 'entity' ? entities.find((e) => e.name === current.name) : undefined
    body = (
      <div className="bp-data-body">
        <nav className="bp-data-side" aria-label="Local data">
          <div className="bp-data-side-h">Entities</div>
          {entities.length === 0 && <div className="bp-data-side-empty">No entities</div>}
          {entities.map((e) => {
            const on = current?.kind === 'entity' && current.name === e.name
            return (
              <button
                key={e.name}
                type="button"
                className={`bp-data-item${on ? ' bp-data-item--on' : ''}`}
                aria-current={on ? 'true' : undefined}
                aria-label={`${e.name}, ${plural(e.rows, 'row')}`}
                onClick={() => setSelected({ kind: 'entity', name: e.name })}
              >
                <Codicon name="table" />
                <span className="bp-data-item-name">{e.name}</span>
                <span className="bp-data-item-count">{e.rows.toLocaleString('en-US')}</span>
              </button>
            )
          })}
          {showUsers && (
            <>
              <div className="bp-data-sep" />
              <button
                type="button"
                className={`bp-data-item${current?.kind === 'users' ? ' bp-data-item--on' : ''}`}
                aria-current={current?.kind === 'users' ? 'true' : undefined}
                onClick={() => setSelected({ kind: 'users' })}
              >
                <Codicon name="person" />
                <span className="bp-data-item-name">Local users</span>
                {users && (
                  <span className="bp-data-item-count">{users.length.toLocaleString('en-US')}</span>
                )}
              </button>
            </>
          )}
        </nav>
        {current?.kind === 'users' ? (
          <UsersPane
            users={users}
            error={overview.usersError}
            onRetry={reload}
            onDelete={(user) => setConfirm({ kind: 'delete-user', user })}
          />
        ) : entity ? (
          <RowsPane
            key={entity.name}
            projectId={projectId}
            entity={entity}
            reloadKey={reloadKey}
            onClear={(rows) => setConfirm({ kind: 'clear', entity: entity.name, rows })}
          />
        ) : (
          <Empty
            icon="table"
            title="No entities yet"
            sub="Once the app’s data model has entities, their rows show up here."
          />
        )}
      </div>
    )
  }

  return (
    <div className="bp-data">
      {head}
      <div className="model-toolbar">
        <span className="bp-data-note" title={note}>
          <Codicon name="info" />
          {note}
        </span>
        <div className="model-toolbar-spacer" />
        <button
          type="button"
          className="model-tool-btn"
          onClick={reload}
          disabled={!running}
          title="Read the local data again"
        >
          <Codicon name="refresh" className={loading ? 'icon-spin' : undefined} />
          Refresh
        </button>
        <button
          type="button"
          className="model-tool-btn"
          onClick={() => setConfirm({ kind: 'reset' })}
          disabled={!running || !overview}
        >
          <Codicon name="discard" />
          Reset local data
        </button>
      </div>
      {fallback && (
        <div className="bp-data-notice" role="note">
          <Codicon name="info" />
          <span>{fallback} The Data view shows local data only.</span>
        </div>
      )}
      {body}
      {confirm && (
        <ConfirmDialog
          confirm={confirm}
          overview={overview}
          storage={Boolean(status?.ready?.features.storage.enabled)}
          schemaWaiting={schemaWaiting}
          published={published}
          referrers={confirm.kind === 'clear' ? referrersOf(dataModel, confirm.entity) : []}
          busy={confirmBusy}
          error={confirmError}
          onConfirm={confirmed}
          onCancel={closeConfirm}
        />
      )}
    </div>
  )
}

/** A failure to read the data, in words for people. */
function readable(error: LocalBackendError): { message: string; hint?: string | null } {
  // Without the control API (an older rayfin-local), its routes answer 404.
  if (error.status === 404 || error.code === 'not-found') {
    return {
      message: 'This version of the local backend doesn’t share its data with Fabricator.',
      hint: 'Update Fabricator, then try again.'
    }
  }
  return error
}

/**
 * A backend that isn't running: its state, why (in the preview's words), and
 * Start. The preview offers each problem's own remedy, so the only hint here is
 * a failed Start's.
 */
function BackendState({ backend }: { backend: LocalBackend }): JSX.Element {
  const { state, status, error, actionError, busy } = backend
  const starting = state === 'starting' || state === 'restarting'
  let title = 'The local backend isn’t running'
  let message = 'Start it to see the app’s local data.'
  let hint: string | null = null
  if (starting) {
    title =
      state === 'restarting'
        ? 'The local backend is starting again'
        : 'The local backend is starting'
    message = 'The app’s local data shows here once it’s running.'
  } else if (actionError) {
    message = actionError.message
    hint = actionError.hint ?? null
  } else if (error) {
    const told = describeProblem(error)
    title = told.title
    message = told.message
  }
  return (
    <div className="model-empty model-empty--cta">
      <span className="bp-data-state">
        <span className={`bp-dot bp-dot--${STATE_DOT[state]}`} />
        {localStateLabel(status)}
      </span>
      <div className="model-empty-title">{title}</div>
      <p className="model-empty-sub">{message}</p>
      {hint && <p className="model-empty-sub bp-data-hint">{hint}</p>}
      {!starting && (
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => void backend.start()}
          disabled={busy}
        >
          <Codicon name="play" />
          {busy ? 'Starting…' : 'Start'}
        </button>
      )}
    </div>
  )
}

function Empty({ icon, title, sub }: { icon: string; title: string; sub: string }): JSX.Element {
  return (
    <div className="model-empty model-empty--cta">
      <span className="bp-data-empty-ico">
        <Codicon name={icon} />
      </span>
      <div className="model-empty-title">{title}</div>
      <p className="model-empty-sub">{sub}</p>
    </div>
  )
}

function Problem({
  title,
  error,
  onRetry,
  extra
}: {
  title: string
  error: { message: string; hint?: string | null }
  onRetry?: () => void
  /** Another way out, beside Retry. */
  extra?: { label: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className="model-empty model-empty--cta" role="alert">
      <div className="model-empty-title">{title}</div>
      <p className="model-empty-sub">{error.message}</p>
      {error.hint && <p className="model-empty-sub bp-data-hint">{error.hint}</p>}
      {(onRetry || extra) && (
        <div className="bp-data-actions">
          {onRetry && (
            <button type="button" className="btn btn--sm" onClick={onRetry}>
              <Codicon name="refresh" />
              Retry
            </button>
          )}
          {extra && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={extra.onClick}>
              {extra.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The first row of the last page of `total` rows. */
function lastPage(total: number): number {
  return total > 0 ? Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE : 0
}

function RowsPane({
  projectId,
  entity,
  reloadKey,
  onClear
}: {
  projectId: string
  entity: LocalEntity
  reloadKey: string
  onClear: (rows: number) => void
}): JSX.Element {
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<{ by: string; desc: boolean } | null>(null)
  const [page, setPage] = useState<LocalRows | null>(null)
  const [error, setError] = useState<LocalBackendError | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let alive = true
    window.api.local.rows(projectId, entity.name, offset, PAGE_SIZE, sort?.by, sort?.desc).then(
      (next) => {
        if (!alive) return
        // Rows went away meanwhile: show the last page there is.
        if (offset > 0 && next.rows.length === 0) {
          setOffset(lastPage(next.total))
          return
        }
        setPage(next)
        setError(null)
      },
      (reason: unknown) => {
        if (alive) setError(toLocalBackendError(reason))
      }
    )
    return () => {
      alive = false
    }
  }, [projectId, entity.name, offset, sort, reloadKey, retry])

  const sortBy = (column: string): void => {
    setSort((s) => (s?.by === column ? { by: column, desc: !s.desc } : { by: column, desc: false }))
    setOffset(0)
  }

  const total = page?.total ?? entity.rows
  let content: ReactNode
  if (error) {
    content = (
      <Problem
        title="Couldn’t read the rows"
        error={error}
        onRetry={() => setRetry((n) => n + 1)}
        // A sort the backend refuses would fail every retry, and hides the headers that undo it.
        extra={
          sort
            ? {
                label: 'Clear sorting',
                onClick: () => {
                  setSort(null)
                  setOffset(0)
                }
              }
            : undefined
        }
      />
    )
  } else if (!page) {
    content = <div className="model-empty">Reading rows…</div>
  } else if (page.rows.length === 0) {
    content = (
      <Empty
        icon="table"
        title="No rows yet"
        sub="The app’s own pages add data. Use the app in the preview, then refresh."
      />
    )
  } else {
    const n = (value: number): string => value.toLocaleString('en-US')
    content = (
      <>
        <div className="bp-data-scroll">
          <table className="bp-data-table">
            <thead>
              <tr>
                {page.columns.map((column) => {
                  const sorted = sort?.by === column.name ? sort : null
                  return (
                    <th
                      key={column.name}
                      scope="col"
                      className={isNumberColumn(column) ? 'bp-data-num' : undefined}
                      aria-sort={sorted ? (sorted.desc ? 'descending' : 'ascending') : undefined}
                    >
                      <button
                        type="button"
                        className="bp-data-sort"
                        title={`Sort by ${column.name}`}
                        onClick={() => sortBy(column.name)}
                      >
                        <span className="bp-data-col">
                          {column.key && <Codicon name="key" className="bp-data-key" />}
                          <span className="bp-data-col-name">{column.name}</span>
                          {sorted && <Codicon name={sorted.desc ? 'arrow-down' : 'arrow-up'} />}
                        </span>
                        <span className="bp-data-col-type">
                          {column.key ? `${column.type} · key` : column.type}
                        </span>
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row, i) => (
                <tr key={offset + i}>
                  {page.columns.map((column) => {
                    const cell = formatCell(row[column.name], column)
                    return (
                      <td
                        key={column.name}
                        className={`bp-data-td--${cell.kind}${column.key ? ' bp-data-td--key' : ''}`}
                      >
                        <span className="bp-data-cell" title={cell.title}>
                          {cell.text}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="bp-data-pager">
          <span>
            {n(offset + 1)}–{n(offset + page.rows.length)} of {n(page.total)}
          </span>
          {page.total > PAGE_SIZE && (
            <>
              <div className="model-toolbar-spacer" />
              <button
                type="button"
                className="model-tool-btn"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0}
                aria-label="Previous page"
              >
                <Codicon name="chevron-left" />
                Previous
              </button>
              <button
                type="button"
                className="model-tool-btn"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= page.total}
                aria-label="Next page"
              >
                Next
                <Codicon name="chevron-right" />
              </button>
            </>
          )}
        </div>
      </>
    )
  }

  return (
    <section className="bp-data-main" aria-label={entity.name}>
      <div className="bp-data-main-head">
        <h3 className="bp-data-title">{entity.name}</h3>
        <span className="bp-data-meta">{plural(total, 'row')}</span>
        <div className="model-toolbar-spacer" />
        <button
          type="button"
          className="model-tool-btn"
          onClick={() => onClear(total)}
          disabled={total === 0}
        >
          <Codicon name="trash" />
          Clear rows
        </button>
      </div>
      {content}
    </section>
  )
}

function UsersPane({
  users,
  error,
  onRetry,
  onDelete
}: {
  users: LocalUser[] | null
  error: LocalBackendError | null
  onRetry: () => void
  onDelete: (user: LocalUser) => void
}): JSX.Element {
  let content: ReactNode
  if (error || !users) {
    content = (
      <Problem
        title="Couldn’t read the local users"
        error={error ?? { message: 'The local backend didn’t list them.' }}
        onRetry={onRetry}
      />
    )
  } else if (users.length === 0) {
    content = (
      <Empty
        icon="person"
        title="No local users yet"
        sub="Local users show up here once someone signs in to the app on this computer."
      />
    )
  } else {
    content = (
      <div className="bp-data-scroll">
        <table className="bp-data-table">
          <thead>
            <tr>
              {['Username', 'Email', 'Signs in with', 'Created'].map((label) => (
                <th key={label} scope="col">
                  <span className="bp-data-th">{label}</span>
                </th>
              ))}
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const created = user.createdAt ? formatDate(user.createdAt) : null
              return (
                <tr key={user.id}>
                  <td>
                    <span className="bp-data-user">
                      <span className="bp-data-cell" title={user.username}>
                        {user.username}
                      </span>
                      {user.developer && <span className="bp-chip">Developer</span>}
                    </span>
                  </td>
                  <td className={user.email ? undefined : 'bp-data-td--null'}>
                    <span className="bp-data-cell" title={user.email ?? undefined}>
                      {user.email ?? '—'}
                    </span>
                  </td>
                  <td>
                    <span className="bp-data-cell">
                      {user.signIn.length > 0
                        ? user.signIn.map((way) => SIGN_IN_LABEL[way] ?? way).join(', ')
                        : 'Fabricator only'}
                    </span>
                  </td>
                  <td className={created ? 'bp-data-td--date' : 'bp-data-td--null'}>
                    <span className="bp-data-cell" title={user.createdAt ?? undefined}>
                      {created ?? '—'}
                    </span>
                  </td>
                  <td className="bp-data-td--actions">
                    <button
                      type="button"
                      className="bp-data-row-btn"
                      aria-label={`Delete ${user.username}`}
                      onClick={() => onDelete(user)}
                    >
                      <Codicon name="trash" />
                      Delete
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <section className="bp-data-main" aria-label="Local users">
      <div className="bp-data-main-head">
        <h3 className="bp-data-title">Local users</h3>
        {users && <span className="bp-data-meta">{plural(users.length, 'user')}</span>}
      </div>
      {content}
    </section>
  )
}

/** What a confirmation deletes, said exactly; and why a clear was refused. */
function ConfirmDialog({
  confirm,
  overview,
  storage,
  schemaWaiting,
  published,
  referrers,
  busy,
  error,
  onConfirm,
  onCancel
}: {
  confirm: Confirm
  overview: Overview | null
  storage: boolean
  /** A data model change waits because it would delete data: the reset applies it. */
  schemaWaiting: boolean
  published: boolean
  referrers: string[]
  busy: boolean
  error: LocalBackendError | null
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  const unaffected = published
    ? 'The published app’s data isn’t affected. This can’t be undone.'
    : 'This can’t be undone.'
  let title: string
  let message: ReactNode
  let label: string
  let busyLabel: string
  if (confirm.kind === 'clear') {
    title = `Clear all ${confirm.entity} rows?`
    label = 'Clear rows'
    busyLabel = 'Clearing…'
    message = (
      <>
        <p>
          This deletes {confirm.rows === 1 ? 'the only row' : `all ${plural(confirm.rows, 'row')}`}{' '}
          of {confirm.entity} from the app’s local data on this computer. Other entities, the local
          users and stored files stay.
        </p>
        <p>{unaffected}</p>
      </>
    )
  } else if (confirm.kind === 'reset') {
    const entities = overview?.entities ?? []
    const rows = entities.reduce((sum, e) => sum + e.rows, 0)
    const users = overview?.users
    const entityCount = plural(entities.length, 'entity', 'entities')
    title = 'Reset local data?'
    label = 'Reset local data'
    busyLabel = 'Resetting…'
    message = (
      <>
        <p>This deletes the app’s local data on this computer:</p>
        <ul className="bp-data-confirm-list">
          <li>
            {rows > 0
              ? `All ${plural(rows, 'row')} of its ${entityCount}`
              : entities.length > 0
                ? `Every row of its ${entityCount}`
                : 'Every row of every entity'}
          </li>
          <li>
            {users && users.length > 0
              ? `Its ${plural(users.length, 'local user')} and their sessions`
              : 'Its local users and their sessions'}
          </li>
          {storage && <li>The files it stored</li>}
        </ul>
        {schemaWaiting && <p>Then the data model change waiting for your decision applies.</p>}
        <p>{unaffected}</p>
      </>
    )
  } else {
    title = `Delete ${confirm.user.username}?`
    label = 'Delete user'
    busyLabel = 'Deleting…'
    message = (
      <p>
        This deletes {confirm.user.username} from the app’s local users and signs them out of the
        app on this computer.
      </p>
    )
  }

  let problem: ReactNode = null
  if (error) {
    // Clearing rows that other rows still refer to is refused (409).
    const refused = confirm.kind === 'clear' && error.status === 409
    const blocking = refused ? blockingReferrers(referrers, overview) : []
    problem = (
      <div className="bp-data-alert" role="alert">
        <Codicon name="error" />
        <div>
          {refused ? (
            <>
              <p>
                {blocking.length > 0
                  ? `Rows of ${listNames(blocking)} still refer to these rows, so they can’t be cleared on their own. Clear ${listNames(blocking)} first, or reset all local data.`
                  : 'Other rows still refer to these rows, so they can’t be cleared on their own. Clear those first, or reset all local data.'}
              </p>
              <p className="bp-data-alert-detail">{error.message}</p>
            </>
          ) : (
            <>
              <p>{error.message}</p>
              {error.hint && <p className="bp-data-alert-detail">{error.hint}</p>}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <ConfirmModal
      title={title}
      message={
        <>
          {message}
          {problem}
        </>
      }
      confirmLabel={label}
      busy={busy}
      busyLabel={busyLabel}
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}

/** The referring entities that have rows, when the counts say; else all of them. */
function blockingReferrers(referrers: string[], overview: Overview | null): string[] {
  const counts = new Map((overview?.entities ?? []).map((e) => [e.name, e.rows]))
  const withRows = referrers.filter((name) => (counts.get(name) ?? 1) > 0)
  return withRows.length > 0 ? withRows : referrers
}
