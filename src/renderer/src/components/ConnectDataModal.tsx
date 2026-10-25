import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import type { FabricWorkspace, StudioProject, WorkspaceDataItem } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { authErrorMessage } from '../authErrors'
import type { WorkspaceUse } from '../fabric'
import {
  DATA_KINDS,
  connectedFromWorkspaces,
  connectedItemIds,
  kindOfItem,
  recentDataWorkspaces,
  rememberConnectedFrom,
  type DataKind,
  type DataSource
} from '../fabricData'
import { Codicon } from './icons'
import './connectData.css'

interface Props {
  project: StudioProject
  /** The kind of data to show first; every kind when absent. */
  kind?: DataKind
  /** The workspaces your apps deploy to, and when (the picker lists recent ones first). */
  appWorkspaces?: readonly WorkspaceUse[]
  /** The data already waiting in the composer, picked to start with. */
  picked?: readonly DataSource[]
  onClose: () => void
  /** Put the picked data in the composer, as chips sent with the next message. */
  onAdd: (sources: DataSource[]) => void
  /** Refresh app auth after sign-in; rejection prevents retrying with an unverified account. */
  onSignedIn?: () => Promise<void> | void
}

type Load<T> =
  | { status: 'loading' }
  | { status: 'needs-login' }
  | { status: 'error'; error: string }
  | { status: 'ready'; value: T }

/** Lists longer than this get a search box. */
const SEARCH_FROM = 8

/**
 * Pick Fabric data for the app to read — semantic models, warehouses, SQL
 * databases and lakehouses — from any workspace you can open. The picks go to
 * the composer as chips; sending the message asks Copilot to connect each one as
 * a Rayfin connector.
 */
export default function ConnectDataModal({
  project,
  kind,
  appWorkspaces,
  picked: initialPicked,
  onClose,
  onAdd,
  onSignedIn
}: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()

  const [workspaces, setWorkspaces] = useState<Load<FabricWorkspace[]>>({ status: 'loading' })
  const [appWorkspaceId, setAppWorkspaceId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [wsQuery, setWsQuery] = useState('')
  const [items, setItems] = useState<Record<string, Load<WorkspaceDataItem[]>>>({})
  const [filter, setFilter] = useState<DataKind | 'all'>(kind ?? 'all')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Map<string, DataSource>>(
    () => new Map((initialPicked ?? []).map((s) => [s.item.id, s]))
  )
  const [connected, setConnected] = useState<Set<string>>(new Set())
  const [reloadTick, setReloadTick] = useState(0)
  const [reauthing, setReauthing] = useState(false)
  const requested = useRef(new Set<string>())
  const loginSeqRef = useRef(0)
  const loginBusyRef = useRef(false)

  // Your workspaces, the one this app deploys to, and what the app already connects to.
  useEffect(() => {
    let alive = true
    requested.current.clear()
    setItems({})
    setWorkspaces({ status: 'loading' })
    void (async () => {
      try {
        const [res, deps] = await Promise.all([
          window.api.fabric.listWorkspaces(),
          window.api.deploy.list(project.id).catch(() => [])
        ])
        if (!alive) return
        const own =
          deps.find((d) => d.active && d.workspaceId)?.workspaceId ??
          deps.find((d) => d.workspaceId)?.workspaceId ??
          null
        setAppWorkspaceId(own)
        if (res.ok && res.workspaces) {
          setWorkspaces({ status: 'ready', value: res.workspaces })
        } else if (res.needsLogin) {
          setWorkspaces({ status: 'needs-login' })
        } else {
          setWorkspaces({ status: 'error', error: res.error || 'Could not list your workspaces.' })
        }
      } catch (reason) {
        if (alive) {
          setWorkspaces({
            status: 'error',
            error: authErrorMessage(reason, 'Could not list your workspaces. Please retry.')
          })
        }
      }
    })()
    void connectedItemIds(project.id).then((ids) => {
      if (alive) setConnected(ids)
    })
    return () => {
      alive = false
      ++loginSeqRef.current
    }
  }, [project.id, reloadTick])

  // Start in the workspace this app deploys to, else the most recent one.
  useEffect(() => {
    if (workspaces.status !== 'ready' || selected) return
    const all = workspaces.value
    const own = appWorkspaceId?.toLowerCase()
    const first =
      (own ? all.find((w) => w.id.toLowerCase() === own) : undefined) ??
      recentDataWorkspaces(all, appWorkspaces ?? [], connectedFromWorkspaces(), 1)[0]
    if (first) setSelected(first.id)
  }, [workspaces, appWorkspaceId, appWorkspaces, selected])

  // The data in the chosen workspace, once per workspace.
  useEffect(() => {
    if (!selected || requested.current.has(selected)) return
    const ws = selected
    requested.current.add(ws)
    setItems((m) => ({ ...m, [ws]: { status: 'loading' } }))
    window.api.fabric.listWorkspaceData(ws).then(
      (res) => {
        const next: Load<WorkspaceDataItem[]> = res.ok
          ? { status: 'ready', value: res.items }
          : res.needsLogin
            ? { status: 'needs-login' }
            : { status: 'error', error: res.error || 'Could not list the data in this workspace.' }
        setItems((m) => (requested.current.has(ws) ? { ...m, [ws]: next } : m))
      },
      (reason) => {
        const error = authErrorMessage(reason, 'Could not list the data in this workspace. Please retry.')
        setItems((m) => (requested.current.has(ws) ? { ...m, [ws]: { status: 'error', error } } : m))
      }
    )
  }, [selected, items])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const all = workspaces.status === 'ready' ? workspaces.value : []
  const recent = useMemo(
    () => recentDataWorkspaces(all, appWorkspaces ?? [], connectedFromWorkspaces()),
    [all, appWorkspaces]
  )
  const wsq = wsQuery.trim().toLowerCase()
  const wsMatches = (w: FabricWorkspace): boolean => !wsq || w.displayName.toLowerCase().includes(wsq)
  const others = useMemo(
    () =>
      all
        .filter((w) => !recent.includes(w))
        .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase())),
    [all, recent]
  )
  const shownRecent = recent.filter(wsMatches)
  const shownOthers = others.filter(wsMatches)
  const current = all.find((w) => w.id === selected)
  const isApp = (w: FabricWorkspace): boolean =>
    Boolean(appWorkspaceId) && w.id.toLowerCase() === appWorkspaceId?.toLowerCase()

  const load = selected ? items[selected] : undefined
  const list = load?.status === 'ready' ? load.value : []
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const item of list) {
      const k = kindOfItem(item.type)?.kind
      if (k) c[k] = (c[k] ?? 0) + 1
    }
    return c
  }, [list])
  const q = query.trim().toLowerCase()
  const shown = list.filter(
    (item) =>
      (filter === 'all' || kindOfItem(item.type)?.kind === filter) &&
      (!q || item.name.toLowerCase().includes(q))
  )
  const needsLogin = workspaces.status === 'needs-login' || load?.status === 'needs-login'
  const pickedIn = (wsId: string): number => [...picked.values()].filter((s) => s.workspaceId === wsId).length

  function toggle(item: WorkspaceDataItem): void {
    if (!current) return
    setPicked((m) => {
      const next = new Map(m)
      if (next.has(item.id)) next.delete(item.id)
      else next.set(item.id, { workspaceId: current.id, workspaceName: current.displayName, item })
      return next
    })
  }

  function retryWorkspace(): void {
    if (!selected) return
    requested.current.delete(selected)
    setItems((m) => {
      const next = { ...m }
      delete next[selected]
      return next
    })
  }

  async function reauthAndReload(): Promise<void> {
    if (loginBusyRef.current) return
    loginBusyRef.current = true
    const seq = ++loginSeqRef.current
    setReauthing(true)
    try {
      const login = await window.api.auth.loginRayfin()
      if (seq !== loginSeqRef.current) return
      if (!login.ok) {
        throw new Error(authErrorMessage(login.error, 'Fabric sign-in did not complete. Please try again.'))
      }
      await onSignedIn?.()
      if (seq === loginSeqRef.current) setReloadTick((n) => n + 1)
    } catch (reason) {
      if (seq === loginSeqRef.current) {
        setWorkspaces({
          status: 'error',
          error: authErrorMessage(reason, 'Fabric sign-in did not complete. Please try again.')
        })
      }
    } finally {
      if (seq === loginSeqRef.current) {
        loginBusyRef.current = false
        setReauthing(false)
      }
    }
  }

  function addToChat(): void {
    const sources = [...picked.values()]
    if (sources.length > 0) rememberConnectedFrom([...new Set(sources.map((s) => s.workspaceId))])
    onAdd(sources)
    onClose()
  }

  const wsRow = (w: FabricWorkspace): JSX.Element => {
    const count = pickedIn(w.id)
    return (
      <button
        key={w.id}
        type="button"
        role="option"
        aria-selected={w.id === selected}
        className={`cd-ws${w.id === selected ? ' cd-ws--sel' : ''}`}
        onClick={() => {
          setSelected(w.id)
          setQuery('')
        }}
      >
        <Codicon name="folder" className="cd-ws-icon" />
        <span className="cd-ws-name">{w.displayName}</span>
        {isApp(w) && <span className="cd-tag">This app</span>}
        {count > 0 && (
          <span className="cd-count" aria-label={`${count} picked`}>
            {count}
          </span>
        )}
      </button>
    )
  }

  const filterKind = filter === 'all' ? undefined : DATA_KINDS.find((k) => k.kind === filter)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal cd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Add Fabric data</h2>
        </div>

        <p className="cd-sub">
          Pick data from any workspace you can open. It goes into your message, and when you send it,
          Copilot connects each one to this app as a Rayfin connector.
        </p>

        {needsLogin && (
          <div className="share-banner cd-banner">
            <span>Sign in to Fabric to see your workspaces and their data.</span>
            <button
              className="btn btn--sm btn--primary"
              disabled={reauthing}
              onClick={() => void reauthAndReload()}
            >
              {reauthing ? 'Signing in…' : 'Sign in & retry'}
            </button>
          </div>
        )}

        <div className="modal-body cd-body">
          <div className="cd-pane cd-pane--ws">
            {workspaces.status === 'ready' && all.length > SEARCH_FROM && (
              <label className="cd-search">
                <Codicon name="search" className="cd-search-icon" />
                <input
                  aria-label="Search workspaces"
                  placeholder="Search workspaces"
                  spellCheck={false}
                  value={wsQuery}
                  onChange={(e) => setWsQuery(e.target.value)}
                />
              </label>
            )}
            {workspaces.status === 'loading' && (
              <div className="cd-state">
                <span className="btn-spin" aria-hidden="true" /> Loading your workspaces…
              </div>
            )}
            {workspaces.status === 'error' && (
              <div className="cd-state cd-state--bad" role="alert">
                <span>{workspaces.error}</span>
                <button className="btn btn--sm" onClick={() => setReloadTick((n) => n + 1)}>
                  Retry
                </button>
              </div>
            )}
            {workspaces.status === 'ready' && all.length === 0 && (
              <div className="cd-state">You don’t have any Fabric workspaces yet.</div>
            )}
            {workspaces.status === 'ready' && all.length > 0 && (
              <div className="cd-ws-list" role="listbox" aria-label="Workspaces">
                {shownRecent.length > 0 && (
                  <>
                    <div className="cd-heading" aria-hidden="true">
                      Recent
                    </div>
                    {shownRecent.map(wsRow)}
                  </>
                )}
                {shownOthers.length > 0 && (
                  <>
                    {shownRecent.length > 0 && (
                      <div className="cd-heading" aria-hidden="true">
                        All workspaces
                      </div>
                    )}
                    {shownOthers.map(wsRow)}
                  </>
                )}
                {shownRecent.length === 0 && shownOthers.length === 0 && (
                  <div className="cd-state">No workspace matches “{wsQuery.trim()}”.</div>
                )}
              </div>
            )}
          </div>

          <div className="cd-pane cd-pane--data">
            {!current && workspaces.status === 'ready' && all.length > 0 && (
              <div className="cd-state cd-state--center">Choose a workspace to see its data.</div>
            )}
            {current && (
              <>
                <div className="cd-kinds" role="group" aria-label="Kind of data">
                  <button
                    type="button"
                    className="cd-kind"
                    aria-pressed={filter === 'all'}
                    onClick={() => setFilter('all')}
                  >
                    All{load?.status === 'ready' ? ` ${list.length}` : ''}
                  </button>
                  {DATA_KINDS.map((k) => (
                    <button
                      key={k.kind}
                      type="button"
                      className="cd-kind"
                      aria-pressed={filter === k.kind}
                      onClick={() => setFilter(k.kind)}
                    >
                      {k.plural}
                      {load?.status === 'ready' ? ` ${counts[k.kind] ?? 0}` : ''}
                    </button>
                  ))}
                </div>
                {load?.status === 'ready' && list.length > SEARCH_FROM && (
                  <label className="cd-search">
                    <Codicon name="search" className="cd-search-icon" />
                    <input
                      aria-label={`Search ${current.displayName}`}
                      placeholder={`Search ${current.displayName}`}
                      spellCheck={false}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                )}
                {(!load || load.status === 'loading') && (
                  <div className="cd-state">
                    <span className="btn-spin" aria-hidden="true" /> Loading {current.displayName}…
                  </div>
                )}
                {load?.status === 'error' && (
                  <div className="cd-state cd-state--bad" role="alert">
                    <span>{load.error}</span>
                    <button className="btn btn--sm" onClick={retryWorkspace}>
                      Retry
                    </button>
                  </div>
                )}
                {load?.status === 'ready' && list.length === 0 && (
                  <div className="cd-state">
                    {current.displayName} has no semantic models, warehouses, SQL databases or lakehouses.
                  </div>
                )}
                {load?.status === 'ready' && list.length > 0 && shown.length === 0 && (
                  <div className="cd-state">
                    {q
                      ? `Nothing matches “${query.trim()}”.`
                      : `${current.displayName} has no ${filterKind?.nouns ?? 'data'}.`}
                  </div>
                )}
                {shown.length > 0 && (
                  <ul className="cd-items" aria-label={`Data in ${current.displayName}`}>
                    {shown.map((item) => {
                      const k = kindOfItem(item.type)
                      const done = connected.has(item.id.toLowerCase())
                      return (
                        <li key={item.id}>
                          <label className={`cd-item${done ? ' cd-item--done' : ''}`} title={item.description}>
                            <input
                              type="checkbox"
                              checked={done || picked.has(item.id)}
                              disabled={done}
                              onChange={() => toggle(item)}
                            />
                            <Codicon name={k?.icon ?? 'database'} className="cd-item-icon" />
                            <span className="cd-item-name">{item.name}</span>
                            {done ? (
                              <span className="cd-done">Connected</span>
                            ) : (
                              <span className="cd-item-kind">{k?.label}</span>
                            )}
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>

        <div className="modal-footer cd-footer">
          <span className="cd-picked" aria-live="polite">
            {picked.size === 0
              ? 'Pick data from one or more workspaces.'
              : `${picked.size} picked${new Set([...picked.values()].map((s) => s.workspaceId)).size > 1 ? ' across workspaces' : ''}`}
          </span>
          {picked.size > 0 && (
            <button className="btn btn--ghost btn--sm" onClick={() => setPicked(new Map())}>
              Clear
            </button>
          )}
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn--primary"
            onClick={addToChat}
            disabled={(picked.size === 0 && !initialPicked?.length) || reauthing}
          >
            {initialPicked?.length ? 'Update' : 'Add to chat'}
          </button>
        </div>
      </div>
    </div>
  )
}
