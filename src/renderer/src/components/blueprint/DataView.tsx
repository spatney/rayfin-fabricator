import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type {
  LocalBackendState,
  LocalEntity,
  LocalFile,
  LocalRows,
  LocalSeed,
  LocalSeedProblem,
  LocalStorageFolder,
  LocalUser,
  StudioProject
} from '@shared/ipc'
import type { DataModel } from '../../model/parseSchema'
import { reportEvent } from '../../errorReport'
import { formatList, formatLocale, Trans, translator, useTranslation } from '../../i18n'
import {
  backendStamp,
  hasFabricBackend,
  localBackendStore,
  localFallbackReason,
  localStateLabel,
  refusedSchemaLosses,
  runningProblems,
  toLocalBackendError,
  useLocalBackend,
  type LocalBackend,
  type LocalBackendError
} from '../../localBackend'
import ConfirmModal from '../ConfirmModal'
import { Codicon } from '../icons'
import { describeProblem } from '../local/problems'
import { seedFixPrompt, seedPlace } from '../local/seedData'
import { Empty, Pager, Problem } from './dataParts'
import {
  formatCell,
  formatDate,
  isNumberColumn,
  lastPage,
  listNames,
  PAGE_SIZE,
  plural,
  referrersOf
} from './localData'
import { FilesPane, folderLabel } from './StoragePane'
import { ViewHead } from './ViewHead'
import './blueprint.css'

interface Props {
  project: StudioProject
  /** Bumped when the app may have changed (e.g. after a chat turn): read the data again. */
  refreshKey: number
  /** The app's data model, to name the entities whose rows refer to others. */
  dataModel?: DataModel
  /** Hand a request to the Build chat, such as fixing the seed data's problems. */
  onSendToChat?: (display: string, prompt: string, stage?: boolean) => void
}

type Selection =
  { kind: 'entity'; name: string } | { kind: 'folder'; name: string } | { kind: 'users' }

interface Overview {
  entities: LocalEntity[]
  /** `null` when they couldn't be read (see `usersError`). */
  users: LocalUser[] | null
  usersError: LocalBackendError | null
  /** The storage folders; `null` when they couldn't be read (see `storageError`). */
  storage: LocalStorageFolder[] | null
  storageError: LocalBackendError | null
  /** The project's seed data; `null` when it couldn't be read. */
  seed: LocalSeed | null
}

type Confirm =
  | { kind: 'clear'; entity: string; rows: number }
  | { kind: 'reset' }
  | { kind: 'delete-user'; user: LocalUser }
  | { kind: 'clear-files'; folder: LocalStorageFolder; files: number }
  | { kind: 'delete-file'; folder: LocalStorageFolder; file: LocalFile }
  | { kind: 'load-seed'; seed: LocalSeed }
  | { kind: 'save-seed'; rows: number; entities: number; files: number }

/** What loading or saving the seed data did: how much, and the stored files a save skipped. */
type SeedNote =
  | { kind: 'loaded'; rows: number; entities: number; files: number }
  | { kind: 'saved'; rows: number; entities: number; files: number; skipped: string[] }

const STATE_DOT: Record<LocalBackendState, string> = {
  running: 'ok',
  starting: 'warn',
  restarting: 'warn',
  error: 'danger',
  stopped: 'off'
}

/** A way a local user signs in, in words: a password, Microsoft Entra ID, else its own name. */
function signInLabel(way: string, t: TFunction<'data'>): string {
  if (way === 'password') return t('users.password')
  if (way === 'entra') return 'Microsoft Entra ID'
  return way
}

/** The local users table's columns, by their `users` keys. */
const USER_COLUMNS = ['username', 'email', 'signsInWith', 'created'] as const

/**
 * Blueprint's Data explorer: the app's local data, as its local backend
 * (rayfin-local) stores it on this computer. The entities with their row
 * counts, the storage folders with their files, and the local users; a page of
 * the selected entity's rows, read-only and sortable, or of the selected
 * folder's files, with a preview; and clearing an entity's rows, deleting
 * files, or every bit of local data. A team app's is its own, on this
 * computer, apart from the team's deployments.
 */
export default function DataView({
  project,
  refreshKey,
  dataModel,
  onSendToChat
}: Props): JSX.Element {
  const { t } = useTranslation('data')
  useEffect(() => {
    reportEvent(
      'preview',
      'local.data_view_opened',
      'Opened the Data explorer of the app’s local data.',
      {
        projectId: project.id
      }
    )
  }, [project.id])

  if (!window.api?.local) {
    return (
      <div className="bp-data">
        <ViewHead title={t('view.title')} subtitle={t('view.localData')} />
        <Problem title={t('backend.unreachable')} error={{ message: t('backend.unsupported') }} />
      </div>
    )
  }
  return (
    <LocalData
      project={project}
      refreshKey={refreshKey}
      dataModel={dataModel}
      onSendToChat={onSendToChat}
    />
  )
}

function LocalData({ project, refreshKey, dataModel, onSendToChat }: Props): JSX.Element {
  const { t } = useTranslation('data')
  const projectId = project.id
  const backend = useLocalBackend(projectId)
  const { status, state } = backend
  const running = state === 'running'
  const published = Boolean(project.lastDeploy?.url)
  // An app the local backend can't run previews on its backend in Fabric.
  const fallback = hasFabricBackend(project)
    ? localFallbackReason(status, { team: Boolean(project.team) })
    : null
  // A data model change that would delete data waits for a decision; a reset leaves none to lose.
  const schemaWaiting = running && refusedSchemaLosses(status) !== null
  // It runs with a problem, such as a data model change it couldn't read: it
  // keeps the previous model, entities and all.
  const problems = runningProblems(status)
  const unread = problems.find((problem) => problem.kind === 'analysis')
  const note = published ? t('toolbar.notePublished') : t('toolbar.note')

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
    const storage = window.api.local.storage(projectId).then(
      (folders): Pick<Overview, 'storage' | 'storageError'> => ({
        storage: folders,
        storageError: null
      }),
      (reason: unknown) => ({ storage: null, storageError: toLocalBackendError(reason) })
    )
    // Seed data is optional: without it (or an older backend), there's nothing to load.
    const seed = window.api.local.seed(projectId).catch(() => null)
    Promise.all([window.api.local.entities(projectId), users, storage, seed])
      .then(
        ([entities, people, files, seedData]) => {
          if (!alive) return
          setOverview({ entities, ...people, ...files, seed: seedData })
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
  const folders = overview?.storage ?? []
  const storageError = overview?.storageError ?? null
  // An older local backend has no storage routes: it answers 404, and the view shows no storage.
  const storageUnknown =
    storageError !== null && (storageError.status === 404 || storageError.code === 'not-found')
  const showStorage =
    !storageUnknown &&
    (Boolean(status?.ready?.features.storage.enabled) ||
      folders.some((folder) => folder.files > 0) ||
      storageError !== null)
  const [selected, setSelected] = useState<Selection | null>(null)
  const current: Selection | null =
    selected?.kind === 'users' && showUsers
      ? selected
      : selected?.kind === 'entity' && entities.some((e) => e.name === selected.name)
        ? selected
        : selected?.kind === 'folder' &&
            showStorage &&
            folders.some((folder) => folder.name === selected.name)
          ? selected
          : entities.length > 0
            ? { kind: 'entity', name: entities[0].name }
            : showStorage && folders.length > 0
              ? { kind: 'folder', name: folders[0].name }
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
  // What loading or saving the seed data did, until the next one, and why a load was refused.
  const [seedNote, setSeedNote] = useState<SeedNote | null>(null)
  const [seedProblems, setSeedProblems] = useState<LocalSeedProblem[] | null>(null)
  useEffect(() => {
    setSeedNote(null)
    setSeedProblems(null)
  }, [projectId])

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
    } else if (confirm.kind === 'clear-files') {
      void perform(async () => {
        const deleted = await window.api.local.clearFiles(projectId, confirm.folder.name)
        reportEvent(
          'preview',
          'local.files_cleared',
          `Deleted ${plural(deleted, 'file')} of the ${confirm.folder.name} storage folder from the local data.`,
          { projectId }
        )
      })
    } else if (confirm.kind === 'delete-file') {
      void perform(async () => {
        await window.api.local.deleteFile(projectId, confirm.folder.name, confirm.file.path)
        reportEvent(
          'preview',
          'local.file_deleted',
          `Deleted a file of the ${confirm.folder.name} storage folder from the local data.`,
          { projectId }
        )
      })
    } else if (confirm.kind === 'load-seed') {
      void perform(async () => {
        setSeedNote(null)
        const loaded = await window.api.local.loadSeed(projectId)
        if (!loaded.ok) {
          setSeedProblems(loaded.problems)
          reportEvent(
            'preview',
            'local.seed_refused',
            `The seed data has ${plural(loaded.problems.length, 'problem')}, so it wasn’t loaded.`,
            { projectId }
          )
          return
        }
        const rows = loaded.entities.reduce((sum, e) => sum + e.rows, 0)
        const files = loaded.storage.reduce((sum, f) => sum + f.files, 0)
        setSeedNote({ kind: 'loaded', rows, entities: loaded.entities.length, files })
        // The app's page shows the new data once it loads again.
        void window.api.preview.reload().catch(() => undefined)
        reportEvent(
          'preview',
          'local.seed_loaded',
          `Loaded the seed data: ${seedAmount(rows, loaded.entities.length, files)}.`,
          { projectId }
        )
      })
    } else if (confirm.kind === 'save-seed') {
      void perform(async () => {
        setSeedNote(null)
        const saved = await window.api.local.saveSeed(projectId)
        setSeedNote({
          kind: 'saved',
          rows: saved.rows,
          entities: saved.entities,
          files: saved.files,
          skipped: saved.skipped
        })
        reportEvent(
          'preview',
          'local.seed_saved',
          `Saved the local data as seed data: ${seedAmount(saved.rows, saved.entities, saved.files)}.`,
          { projectId }
        )
      })
    } else {
      void perform(() => window.api.local.deleteUser(projectId, confirm.user.id))
    }
  }

  const totalRows = entities.reduce((sum, e) => sum + e.rows, 0)
  const totalFiles = folders.reduce((sum, folder) => sum + folder.files, 0)
  const head = (
    <ViewHead
      title={t('view.title')}
      subtitle={
        overview
          ? t('view.summary', {
              entities: t('counts.entities', { count: entities.length }),
              rows: t('counts.rows', { count: totalRows })
            })
          : t('view.localData')
      }
      legend={
        <div className="model-legend">
          <span className="model-legend-label">{t('view.backend')}</span>
          <span className="model-legend-item">
            <span
              className={`bp-dot bp-dot--${status ? (problems.length > 0 ? 'warn' : STATE_DOT[state]) : 'off'}`}
            />
            {status
              ? localStateLabel(status)
              : statusError
                ? t('status.unknown')
                : t('status.checking')}
          </span>
        </div>
      }
    />
  )

  let body: ReactNode
  if (!status) {
    body = statusError ? (
      <Problem
        title={t('backend.unreachable')}
        error={statusError}
        onRetry={() => setStatusTry((n) => n + 1)}
      />
    ) : (
      <div className="model-empty">{t('backend.checking')}</div>
    )
  } else if (!running) {
    body = <BackendState backend={backend} />
  } else if (overviewError) {
    body = <Problem title={t('view.readError')} error={readable(overviewError)} onRetry={reload} />
  } else if (!overview) {
    body = <div className="model-empty">{t('view.reading')}</div>
  } else {
    const entity =
      current?.kind === 'entity' ? entities.find((e) => e.name === current.name) : undefined
    const folder =
      current?.kind === 'folder' ? folders.find((f) => f.name === current.name) : undefined
    body = (
      <div className="bp-data-body">
        <nav className="bp-data-side" aria-label={t('view.localData')}>
          <div className="bp-data-side-h">{t('side.entities')}</div>
          {entities.length === 0 && (
            <div className="bp-data-side-empty">{t('side.noEntities')}</div>
          )}
          {entities.map((e) => {
            const on = current?.kind === 'entity' && current.name === e.name
            return (
              <button
                key={e.name}
                type="button"
                className={`bp-data-item${on ? ' bp-data-item--on' : ''}`}
                aria-current={on ? 'true' : undefined}
                aria-label={t('side.entityItem', { name: e.name, count: e.rows })}
                onClick={() => setSelected({ kind: 'entity', name: e.name })}
              >
                <Codicon name="table" />
                <span className="bp-data-item-name">{e.name}</span>
                <span className="bp-data-item-count">{e.rows.toLocaleString(formatLocale())}</span>
              </button>
            )
          })}
          {showStorage && (
            <>
              <div className="bp-data-side-h bp-data-side-h--next">{t('side.storage')}</div>
              {storageError && (
                <div className="bp-data-side-empty" title={storageError.message}>
                  {t('side.storageError')}
                </div>
              )}
              {!storageError && folders.length === 0 && (
                <div className="bp-data-side-empty">{t('side.noFolders')}</div>
              )}
              {folders.map((f) => {
                const on = current?.kind === 'folder' && current.name === f.name
                const label = folderLabel(f)
                return (
                  <button
                    key={f.name}
                    type="button"
                    className={`bp-data-item${on ? ' bp-data-item--on' : ''}`}
                    aria-current={on ? 'true' : undefined}
                    aria-label={t('side.folderItem', { name: label, count: f.files })}
                    title={f.displayName ? `${f.displayName} (${f.name})` : f.name}
                    onClick={() => setSelected({ kind: 'folder', name: f.name })}
                  >
                    <Codicon name={on ? 'folder-opened' : 'folder'} />
                    <span className="bp-data-item-name">{label}</span>
                    <span className="bp-data-item-count">
                      {f.files.toLocaleString(formatLocale())}
                    </span>
                  </button>
                )
              })}
            </>
          )}
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
                <span className="bp-data-item-name">{t('users.title')}</span>
                {users && (
                  <span className="bp-data-item-count">
                    {users.length.toLocaleString(formatLocale())}
                  </span>
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
        ) : folder ? (
          <FilesPane
            key={folder.name}
            projectId={projectId}
            folder={folder}
            users={users}
            reloadKey={reloadKey}
            onClear={(files) => setConfirm({ kind: 'clear-files', folder, files })}
            onDelete={(file) => setConfirm({ kind: 'delete-file', folder, file })}
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
          <Empty icon="table" title={t('view.noEntitiesTitle')} sub={t('view.noEntitiesSub')} />
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
          title={t('toolbar.refreshTitle')}
        >
          <Codicon name="refresh" className={loading ? 'icon-spin' : undefined} />
          {t('actions.refresh')}
        </button>
        <button
          type="button"
          className="model-tool-btn"
          onClick={() => {
            const seed = overview?.seed
            if (!seed) return
            // Seed data its files already get wrong can't load: say why at once.
            if (seed.problems.length > 0) setSeedProblems(seed.problems)
            else setConfirm({ kind: 'load-seed', seed })
          }}
          disabled={!running || !overview?.seed?.exists}
          title={overview?.seed?.exists ? t('toolbar.loadSeedTitle') : t('toolbar.noSeedTitle')}
        >
          <Codicon name="database" />
          {t('seed.load')}
        </button>
        <button
          type="button"
          className="model-tool-btn"
          onClick={() =>
            setConfirm({
              kind: 'save-seed',
              rows: totalRows,
              entities: entities.filter((e) => e.rows > 0).length,
              files: totalFiles
            })
          }
          disabled={!running || !overview || (totalRows === 0 && totalFiles === 0)}
          title={t('toolbar.saveSeedTitle')}
        >
          <Codicon name="save" />
          {t('seed.save')}
        </button>
        <button
          type="button"
          className="model-tool-btn"
          onClick={() => setConfirm({ kind: 'reset' })}
          disabled={!running || !overview}
        >
          <Codicon name="discard" />
          {t('toolbar.reset')}
        </button>
      </div>
      {seedNote && (
        <div className="bp-data-notice" role="status">
          <Codicon name="check" />
          <span className="bp-data-notice-text">{seedNoteText(seedNote, t)}</span>
          <button
            type="button"
            className="bp-data-notice-close"
            aria-label={t('actions.dismiss')}
            onClick={() => setSeedNote(null)}
          >
            <Codicon name="close" />
          </button>
        </div>
      )}
      {fallback && (
        <div className="bp-data-notice" role="note">
          <Codicon name="info" />
          <span>{t('notices.fallback', { reason: fallback })}</span>
        </div>
      )}
      {unread && (
        <div className="bp-data-notice" role="note" aria-label={t('notices.unreadLabel')}>
          <span className="bp-dot bp-dot--warn bp-data-notice-dot" aria-hidden="true" />
          <span className="bp-data-notice-text">
            {overview && entities.length === 0
              ? t('notices.unreadNoEntities')
              : t('notices.unread')}
            {unread.detail && (
              <code className="bp-data-notice-detail" title={unread.detail}>
                {unread.detail}
              </code>
            )}
          </span>
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
      {seedProblems && (
        <SeedProblemsDialog
          problems={seedProblems}
          onFix={
            onSendToChat
              ? () => {
                  onSendToChat(t('seedProblems.fixRequest'), seedFixPrompt(seedProblems))
                  setSeedProblems(null)
                }
              : undefined
          }
          onClose={() => setSeedProblems(null)}
        />
      )}
    </div>
  )
}

/** `12 rows in 3 entities and 2 files`, leaving out what there's none of: in English, for telemetry. */
function seedAmount(rows: number, entities: number, files: number): string {
  const parts: string[] = []
  if (rows > 0 || entities > 0) {
    parts.push(`${plural(rows, 'row')} in ${plural(entities, 'entity', 'entities')}`)
  }
  if (files > 0) parts.push(plural(files, 'file'))
  return parts.length > 0 ? parts.join(' and ') : 'no rows or files'
}

/** {@link seedAmount} in the interface's language. */
function seedAmountText(
  t: TFunction<'data'>,
  rows: number,
  entities: number,
  files: number
): string {
  const parts: string[] = []
  if (rows > 0 || entities > 0) {
    parts.push(
      t('seed.rowsIn', { count: rows, entities: t('counts.entities', { count: entities }) })
    )
  }
  if (files > 0) parts.push(t('counts.files', { count: files }))
  return parts.length > 0 ? formatList(parts) : t('seed.nothing')
}

/** What loading or saving the seed data did, in words. */
function seedNoteText(note: SeedNote, t: TFunction<'data'>): string {
  const amount = seedAmountText(t, note.rows, note.entities, note.files)
  if (note.kind === 'loaded') return t('seed.loaded', { amount })
  if (note.skipped.length === 0) return t('seed.saved', { amount })
  return t('seed.savedSkipped', {
    amount,
    count: note.skipped.length,
    files: note.skipped.join('; ')
  })
}

/** Why the seed data wasn't loaded, problem by problem. */
function SeedProblemsDialog({
  problems,
  onFix,
  onClose
}: {
  problems: LocalSeedProblem[]
  onFix?: () => void
  onClose: () => void
}): JSX.Element {
  const { t } = useTranslation('data')
  return (
    <ConfirmModal
      title={t('seedProblems.title', { count: problems.length })}
      confirmLabel={onFix ? t('seedProblems.fix') : t('actions.ok')}
      cancelLabel={t('actions.close')}
      onConfirm={onFix ?? onClose}
      onCancel={onClose}
      message={
        <>
          <p>{t('seedProblems.intro')}</p>
          <ul className="bp-data-confirm-list bp-data-seed-problems">
            {problems.map((problem, i) => (
              <li key={i}>
                <code>{seedPlace(problem)}</code> {problem.message}
              </li>
            ))}
          </ul>
        </>
      }
    />
  )
}

/** A failure to read the data, in words for people. */
function readable(error: LocalBackendError): { message: string; hint?: string | null } {
  // Without the control API (an older rayfin-local), its routes answer 404.
  if (error.status === 404 || error.code === 'not-found') {
    const t = translator('data')
    return { message: t('view.oldBackend'), hint: t('view.oldBackendHint') }
  }
  return error
}

/**
 * A backend that isn't running: its state, why (in the preview's words), and
 * Start. The preview offers each problem's own remedy, so the only hint here is
 * a failed Start's.
 */
function BackendState({ backend }: { backend: LocalBackend }): JSX.Element {
  const { t } = useTranslation('data')
  const { state, status, error, actionError, busy } = backend
  const starting = state === 'starting' || state === 'restarting'
  let title = t('backend.stoppedTitle')
  let message = t('backend.stoppedMessage')
  let hint: string | null = null
  if (starting) {
    title = state === 'restarting' ? t('backend.restarting') : t('backend.starting')
    message = t('backend.startingMessage')
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
          {busy ? t('backend.startBusy') : t('backend.start')}
        </button>
      )}
    </div>
  )
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
  const { t } = useTranslation('data')
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
        title={t('rows.readError')}
        error={error}
        onRetry={() => setRetry((n) => n + 1)}
        // A sort the backend refuses would fail every retry, and hides the headers that undo it.
        extra={
          sort
            ? {
                label: t('rows.clearSorting'),
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
    content = <div className="model-empty">{t('rows.reading')}</div>
  } else if (page.rows.length === 0) {
    content = <Empty icon="table" title={t('rows.emptyTitle')} sub={t('rows.emptySub')} />
  } else {
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
                        title={t('rows.sortBy', { column: column.name })}
                        onClick={() => sortBy(column.name)}
                      >
                        <span className="bp-data-col">
                          {column.key && <Codicon name="key" className="bp-data-key" />}
                          <span className="bp-data-col-name">{column.name}</span>
                          {sorted && <Codicon name={sorted.desc ? 'arrow-down' : 'arrow-up'} />}
                        </span>
                        <span className="bp-data-col-type">
                          {column.key ? t('rows.keyType', { type: column.type }) : column.type}
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
        <Pager offset={offset} shown={page.rows.length} total={page.total} onOffset={setOffset} />
      </>
    )
  }

  return (
    <section className="bp-data-main" aria-label={entity.name}>
      <div className="bp-data-main-head">
        <h3 className="bp-data-title">{entity.name}</h3>
        <span className="bp-data-meta">{t('counts.rows', { count: total })}</span>
        <div className="model-toolbar-spacer" />
        <button
          type="button"
          className="model-tool-btn"
          onClick={() => onClear(total)}
          disabled={total === 0}
        >
          <Codicon name="trash" />
          {t('rows.clear')}
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
  const { t } = useTranslation('data')
  let content: ReactNode
  if (error || !users) {
    content = (
      <Problem
        title={t('users.readError')}
        error={error ?? { message: t('users.notListed') }}
        onRetry={onRetry}
      />
    )
  } else if (users.length === 0) {
    content = <Empty icon="person" title={t('users.emptyTitle')} sub={t('users.emptySub')} />
  } else {
    content = (
      <div className="bp-data-scroll">
        <table className="bp-data-table">
          <thead>
            <tr>
              {USER_COLUMNS.map((column) => (
                <th key={column} scope="col">
                  <span className="bp-data-th">{t(`users.${column}`)}</span>
                </th>
              ))}
              <th scope="col">
                <span className="sr-only">{t('fields.actions')}</span>
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
                      {user.developer && <span className="bp-chip">{t('users.developer')}</span>}
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
                        ? user.signIn.map((way) => signInLabel(way, t)).join(', ')
                        : t('users.fabricatorOnly')}
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
                      aria-label={t('users.deleteLabel', { username: user.username })}
                      onClick={() => onDelete(user)}
                    >
                      <Codicon name="trash" />
                      {t('actions.delete')}
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
    <section className="bp-data-main" aria-label={t('users.title')}>
      <div className="bp-data-main-head">
        <h3 className="bp-data-title">{t('users.title')}</h3>
        {users && (
          <span className="bp-data-meta">{t('counts.users', { count: users.length })}</span>
        )}
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
  const { t } = useTranslation('data')
  const unaffected = published ? t('confirm.cantUndoPublished') : t('confirm.cantUndo')
  let title: string
  let message: ReactNode
  let label: string
  let busyLabel: string
  if (confirm.kind === 'clear') {
    title = t('confirm.clear.title', { entity: confirm.entity })
    label = t('rows.clear')
    busyLabel = t('confirm.clearing')
    message = (
      <>
        <p>{t('confirm.clear.message', { count: confirm.rows, entity: confirm.entity })}</p>
        <p>{unaffected}</p>
      </>
    )
  } else if (confirm.kind === 'reset') {
    const entities = overview?.entities ?? []
    const rows = entities.reduce((sum, e) => sum + e.rows, 0)
    const users = overview?.users
    const files = (overview?.storage ?? []).reduce((sum, folder) => sum + folder.files, 0)
    const itsEntities = t('confirm.reset.itsEntities', { count: entities.length })
    title = t('confirm.reset.title')
    label = t('toolbar.reset')
    busyLabel = t('confirm.resetting')
    message = (
      <>
        <p>{t('confirm.reset.intro')}</p>
        <ul className="bp-data-confirm-list">
          <li>
            {rows > 0
              ? t('confirm.reset.allRows', { count: rows, entities: itsEntities })
              : entities.length > 0
                ? t('confirm.reset.everyRowOf', { entities: itsEntities })
                : t('confirm.reset.everyRow')}
          </li>
          <li>
            {users && users.length > 0
              ? t('confirm.reset.users', { count: users.length })
              : t('confirm.reset.usersAny')}
          </li>
          {files > 0 ? (
            <li>{t('confirm.reset.files', { count: files })}</li>
          ) : (
            storage && <li>{t('confirm.reset.filesAny')}</li>
          )}
        </ul>
        {schemaWaiting && <p>{t('confirm.reset.schemaWaiting')}</p>}
        <p>{unaffected}</p>
      </>
    )
  } else if (confirm.kind === 'clear-files') {
    const name = folderLabel(confirm.folder)
    title = t('confirm.clearFiles.title', { folder: name })
    label = t('files.clear')
    busyLabel = t('confirm.clearing')
    message = (
      <>
        <p>{t('confirm.clearFiles.message', { count: confirm.files, folder: name })}</p>
        <p>{unaffected}</p>
      </>
    )
  } else if (confirm.kind === 'delete-file') {
    title = t('confirm.deleteFile.title', { name: confirm.file.name })
    label = t('confirm.deleteFile.action')
    busyLabel = t('status.deleting')
    message = (
      <>
        <p>
          {t('confirm.deleteFile.message', {
            path: confirm.file.path,
            folder: folderLabel(confirm.folder)
          })}
        </p>
        <p>{unaffected}</p>
      </>
    )
  } else if (confirm.kind === 'load-seed') {
    const rows = confirm.seed.entities.reduce((sum, e) => sum + e.rows, 0)
    const files = confirm.seed.storage.reduce((sum, f) => sum + f.files, 0)
    title = t('confirm.loadSeed.title')
    label = t('seed.load')
    busyLabel = t('status.loading')
    message = (
      <>
        <p>{t('confirm.loadSeed.intro')}</p>
        <ul className="bp-data-confirm-list">
          <li>
            {confirm.seed.entities.length > 0
              ? t('seed.rowsIn', {
                  count: rows,
                  entities: t('counts.entities', { count: confirm.seed.entities.length })
                })
              : t('confirm.loadSeed.noRows')}
          </li>
          {files > 0 && <li>{t('counts.storedFiles', { count: files })}</li>}
        </ul>
        <p>{storage ? t('confirm.loadSeed.deletesAll') : t('confirm.loadSeed.deletesRows')}</p>
        <p>{unaffected}</p>
      </>
    )
  } else if (confirm.kind === 'save-seed') {
    title = t('confirm.saveSeed.title')
    label = t('seed.save')
    busyLabel = t('status.saving')
    message = (
      <>
        <p>{t('confirm.saveSeed.intro')}</p>
        <ul className="bp-data-confirm-list">
          {confirm.rows > 0 && (
            <li>
              {t('confirm.saveSeed.rows', {
                count: confirm.rows,
                entities: t('counts.entities', { count: confirm.entities })
              })}
            </li>
          )}
          {confirm.files > 0 && <li>{t('confirm.saveSeed.files', { count: confirm.files })}</li>}
        </ul>
        <p>
          <Trans
            t={t}
            i18nKey="confirm.saveSeed.ids"
            values={{ developer: '$developer', user: '$user:<username>' }}
            components={{ code: <code /> }}
          />
        </p>
      </>
    )
  } else {
    title = t('confirm.deleteUser.title', { username: confirm.user.username })
    label = t('confirm.deleteUser.action')
    busyLabel = t('status.deleting')
    message = <p>{t('confirm.deleteUser.message', { username: confirm.user.username })}</p>
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
                  ? t('confirm.refusedNamed', { names: listNames(blocking) })
                  : t('confirm.refused')}
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
      danger={confirm.kind !== 'save-seed'}
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
