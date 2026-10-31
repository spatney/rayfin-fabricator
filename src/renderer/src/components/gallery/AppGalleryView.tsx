import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { GalleryApp, GalleryResult, GalleryStatus } from '@shared/ipc'
import { topLayerOpen, useSuppressPreview } from '../../overlay'
import { useAzureSignIn, type AzureSignIn } from '../../azureAuth'
import { authErrorMessage } from '../../authErrors'
import { FabricatorMark } from '../FabricatorMark'
import { Codicon } from '../icons'
import AppCard, { SkeletonCard } from './AppCard'
import AppDetails from './AppDetails'
import {
  applyQuery,
  count,
  groupByWorkspace,
  pinKey,
  workspacesOf,
  type GalleryEntry,
  type GalleryGroup,
  type GalleryQuery,
  type GallerySort,
  type GalleryWhere
} from './model'
import './gallery.css'

interface Props {
  /** Leave the gallery. */
  onClose: () => void
  /** Open a project on this computer in Fabricator. */
  onOpenProject: (projectId: string) => void
  /** Start a new project (the empty gallery offers it). */
  onNewProject: () => void
  /** Refresh the app's accounts after signing in to Azure here. */
  onSignedIn?: () => Promise<void> | void
}

/** Cards shown before "Show more". */
const PAGE = 120
/** Statuses asked for at once. */
const STATUS_CHUNK = 12
/** Most apps whose statuses are read to put the most recently published first. */
const RECENT_LIMIT = 500
const PREFS_KEY = 'rayfin.gallery'
const LIST_FAILED = 'Couldn’t list your Fabric apps. Try again.'

/** The last apps read, so the gallery opens on them at once while it checks Fabric again. */
let snapshot: { result: GalleryResult; statuses: Record<string, GalleryStatus> } | null = null

/** Test seam: forget the last apps read. */
export function resetGallerySnapshotForTests(): void {
  snapshot = null
}

type Prefs = Pick<GalleryQuery, 'where' | 'sort' | 'pinned'>
const WHERE: readonly GalleryWhere[] = ['all', 'local', 'remote']
const SORTS: readonly GallerySort[] = ['name', 'recent', 'workspace']

/** The saved pins: each key once, leaving out anything that isn't one. */
function savedPins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((key): key is string => typeof key === 'string' && key !== ''))]
}

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    return {
      where: WHERE.includes(saved.where as GalleryWhere) ? (saved.where as GalleryWhere) : 'all',
      sort: SORTS.includes(saved.sort as GallerySort) ? (saved.sort as GallerySort) : 'name',
      pinned: savedPins(saved.pinned)
    }
  } catch {
    return { where: 'all', sort: 'name', pinned: [] }
  }
}

interface Failure {
  error: string
  needsAz?: boolean
}

/**
 * The app gallery: every Rayfin app the Azure CLI's account can open in Fabric,
 * including apps that aren't on this computer. Search, filter and sort them,
 * and open one in the browser, in Fabric, or (when it's here) in Fabricator.
 */
export default function AppGalleryView({
  onClose,
  onOpenProject,
  onNewProject,
  onSignedIn
}: Props): JSX.Element {
  useSuppressPreview()
  const [result, setResult] = useState<GalleryResult | null>(() => snapshot?.result ?? null)
  const [statuses, setStatuses] = useState<Record<string, GalleryStatus>>(
    () => snapshot?.statuses ?? {}
  )
  const [failure, setFailure] = useState<Failure | null>(null)
  const [checking, setChecking] = useState(true)
  const [text, setText] = useState('')
  const [prefs, setPrefs] = useState(loadPrefs)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const readSeq = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /* ---- statuses: each app's address and last publish, read as cards show ---- */

  const requested = useRef(new Set<string>(Object.keys(snapshot?.statuses ?? {})))
  const queue = useRef<GalleryApp[]>([])
  const pumping = useRef(false)
  const statusGen = useRef(0)

  const pump = useCallback(async (): Promise<void> => {
    if (pumping.current) return
    pumping.current = true
    const gen = statusGen.current
    try {
      while (queue.current.length > 0 && gen === statusGen.current && mounted.current) {
        const batch = queue.current.splice(0, STATUS_CHUNK)
        let answers: GalleryStatus[]
        try {
          answers = await window.api.gallery.status(
            batch.map((a) => ({ workspaceId: a.workspaceId, id: a.id }))
          )
        } catch {
          answers = batch.map((a) => ({ id: a.id, unknown: true }))
        }
        if (gen !== statusGen.current || !mounted.current) break
        setStatuses((prev) => {
          const next = { ...prev }
          for (const s of answers) next[s.id] = s
          return next
        })
      }
    } finally {
      pumping.current = false
    }
    // Work queued after a refresh started while this was still running.
    if (queue.current.length > 0 && mounted.current) void pump()
  }, [])

  const want = useCallback(
    (apps: readonly GalleryApp[]): void => {
      let added = false
      for (const app of apps) {
        if (requested.current.has(app.id)) continue
        requested.current.add(app.id)
        queue.current.push(app)
        added = true
      }
      if (added) void pump()
    },
    [pump]
  )

  const forgetStatuses = useCallback((): void => {
    statusGen.current++
    queue.current = []
    requested.current = new Set()
    setStatuses({})
  }, [])

  /* ---- the apps ---- */

  const read = useCallback(
    async (refresh: boolean): Promise<void> => {
      const seq = ++readSeq.current
      setChecking(true)
      let next: GalleryResult
      try {
        next = await window.api.gallery.list(refresh)
      } catch (reason) {
        next = { ok: false, apps: [], error: authErrorMessage(reason, LIST_FAILED) }
      }
      if (seq !== readSeq.current || !mounted.current) return
      setChecking(false)
      if (!next.ok) {
        setFailure({ error: next.error || LIST_FAILED, needsAz: next.needsAz })
        return
      }
      setFailure(null)
      if (refresh) forgetStatuses()
      setResult(next)
    },
    [forgetStatuses]
  )

  useEffect(() => {
    void read(false)
  }, [read])

  useEffect(() => {
    if (result?.ok) snapshot = { result, statuses }
  }, [result, statuses])

  const azure = useAzureSignIn(async () => {
    await onSignedIn?.()
    await read(true)
  })

  /* ---- what's shown ---- */

  const apps = useMemo(() => result?.apps ?? [], [result])
  const workspaces = useMemo(() => workspacesOf(apps), [apps])
  const localCount = useMemo(() => apps.filter((a) => a.local).length, [apps])
  const query = useMemo<GalleryQuery>(
    () => ({ text, workspaceId, ...prefs }),
    [text, workspaceId, prefs]
  )
  const filtered = useMemo(() => applyQuery(apps, statuses, query), [apps, statuses, query])
  const shown = filtered.slice(0, limit)
  const filteredBy = Boolean(text.trim()) || prefs.where !== 'all' || workspaceId !== null
  const selected = selectedId ? apps.find((a) => a.id === selectedId) : undefined

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  }, [prefs])

  // A workspace that's gone after a refresh (or another account) stops filtering.
  useEffect(() => {
    if (workspaceId && result && !workspaces.some((w) => w.id === workspaceId)) setWorkspaceId(null)
  }, [workspaceId, workspaces, result])

  // So does an app that's gone: its details close.
  useEffect(() => {
    if (selectedId && result && !apps.some((a) => a.id === selectedId)) setSelectedId(null)
  }, [selectedId, apps, result])

  // A new search, filter or order shows the first page again; pinning doesn't.
  useEffect(() => setLimit(PAGE), [text, workspaceId, prefs.where, prefs.sort])

  // Read the statuses of the cards on screen, or of every app to sort by publish.
  useEffect(() => {
    if (!result) return
    const targets =
      prefs.sort === 'recent' ? filtered.slice(0, RECENT_LIMIT) : filtered.slice(0, limit)
    want(targets.map((e) => e.app))
  }, [result, filtered, limit, prefs.sort, want])

  const select = useCallback(
    (app: GalleryApp): void => {
      setSelectedId((current) => (current === app.id ? null : app.id))
      want([app])
    },
    [want]
  )

  const closeDetails = useCallback((): void => {
    const id = selectedId
    setSelectedId(null)
    // The card stays put while its details close: give it back the focus.
    if (id) document.querySelector<HTMLElement>(`[data-app-id="${id}"]`)?.focus()
  }, [selectedId])

  const togglePin = useCallback((app: GalleryApp): void => {
    const key = pinKey(app)
    setPrefs((p) => ({
      ...p,
      pinned: p.pinned.includes(key) ? p.pinned.filter((k) => k !== key) : [...p.pinned, key]
    }))
  }, [])

  /** The card whose pin was just pressed, and whether the keyboard pressed it. */
  const pinPressed = useRef<{ id: string; keyboard: boolean } | null>(null)

  const pinCard = useCallback(
    (app: GalleryApp, keyboard: boolean): void => {
      pinPressed.current = { id: app.id, keyboard }
      togglePin(app)
    },
    [togglePin]
  )

  // Pinning moves the card, which takes the focus off its pin: give it back,
  // scrolled to when the keyboard pressed it.
  useEffect(() => {
    const pressed = pinPressed.current
    pinPressed.current = null
    const focusLost = !document.activeElement || document.activeElement === document.body
    if (!pressed || !focusLost) return
    document
      .querySelector<HTMLElement>(`[data-app-id="${pressed.id}"] ~ .gcard-pin`)
      ?.focus({ preventScroll: !pressed.keyboard })
  }, [prefs.pinned])

  // Esc closes the details, then clears the search, then leaves. Capture runs
  // before a dialog's own handler can remove it, so a dialog, Search or Help on
  // top keeps its Esc.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (topLayerOpen() || document.querySelector('.help')) return
      if (selectedId) closeDetails()
      else if (text) setText('')
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selectedId, text, onClose, closeDetails])

  // "/" jumps to the search, as on the web.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]') || topLayerOpen())
        return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openUrl = useCallback((url: string): void => void window.api.openExternal(url), [])
  const showAll = (): void => {
    setText('')
    setWorkspaceId(null)
    setPrefs((p) => ({ ...p, where: 'all' }))
  }

  const user = result?.account?.user
  const summary = result
    ? filteredBy
      ? `Showing ${filtered.length.toLocaleString('en')} of ${count(apps.length, 'app')}`
      : `${count(apps.length, 'app')} · ${count(workspaces.length, 'workspace')}`
    : ''
  const announced = result
    ? filteredBy
      ? `${filtered.length.toLocaleString('en')} of ${count(apps.length, 'app')} shown`
      : `${count(apps.length, 'app')} shown`
    : checking
      ? 'Loading your Fabric apps'
      : ''

  return (
    <div className="gallery">
      <div className="gallery-main">
        <header className="gallery-head">
          <div className="gallery-wrap gallery-head-inner">
            <div className="gallery-title-row">
              <div className="gallery-titles">
                <p className="gallery-eyebrow">Microsoft Fabric</p>
                <h1 className="gallery-title">App gallery</h1>
                <p className="gallery-sub">
                  Every Rayfin app you can open in Fabric
                  {user ? (
                    <>
                      , as <strong>{user}</strong>
                    </>
                  ) : (
                    ''
                  )}
                  .
                </p>
              </div>
              <div className="gallery-head-tools">
                {checking && result && <span className="gallery-checking">Checking Fabric…</span>}
                {summary && <span className="gallery-count">{summary}</span>}
                <button
                  type="button"
                  className="btn btn--sm btn--icon"
                  aria-label="Refresh"
                  title="Refresh"
                  disabled={checking}
                  onClick={() => void read(true)}
                >
                  <Codicon name="refresh" className={checking ? 'icon-spin' : undefined} />
                </button>
              </div>
            </div>

            <div className="gallery-toolbar" role="search">
              <label className="gallery-search">
                <Codicon name="search" className="gallery-search-ico" />
                <input
                  ref={searchRef}
                  className="field-input gallery-search-input"
                  type="search"
                  value={text}
                  autoFocus
                  spellCheck={false}
                  placeholder="Search apps, workspaces and descriptions"
                  aria-label="Search apps"
                  onChange={(e) => setText(e.target.value)}
                />
                {!text && (
                  <kbd className="gallery-search-key" aria-hidden="true">
                    /
                  </kbd>
                )}
              </label>
              <div className="seg gallery-where" role="group" aria-label="Where the apps are">
                {(
                  [
                    ['all', 'All', apps.length],
                    ['local', 'On this computer', localCount],
                    ['remote', 'In Fabric only', apps.length - localCount]
                  ] as const
                ).map(([value, label, n]) => (
                  <button
                    key={value}
                    type="button"
                    className={`seg-btn${prefs.where === value ? ' seg-btn--active' : ''}`}
                    aria-pressed={prefs.where === value}
                    onClick={() => setPrefs((p) => ({ ...p, where: value }))}
                  >
                    {label}
                    {result && <span className="gallery-seg-count">{n.toLocaleString('en')}</span>}
                  </button>
                ))}
              </div>
              <select
                className="field-input gallery-select"
                aria-label="Workspace"
                value={workspaceId ?? ''}
                onChange={(e) => setWorkspaceId(e.target.value || null)}
              >
                <option value="">All workspaces</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.count})
                  </option>
                ))}
              </select>
              <select
                className="field-input gallery-select"
                aria-label="Sort"
                value={prefs.sort}
                onChange={(e) => setPrefs((p) => ({ ...p, sort: e.target.value as GallerySort }))}
              >
                <option value="name">Name</option>
                <option value="recent">Recently published</option>
                <option value="workspace">Workspace</option>
              </select>
            </div>
          </div>
        </header>

        <div className="gallery-scroll">
          <div className="gallery-wrap">
            <p className="sr-only" role="status">
              {announced}
            </p>
            {result && failure && (
              <Banner failure={failure} azure={azure} onRetry={() => void read(true)} />
            )}
            {result?.truncated && (
              <p className="gallery-note">
                <Codicon name="info" />
                Fabric has more apps than Fabricator reads at once, so some apps you can open aren’t
                shown.
              </p>
            )}
            {!result ? (
              failure ? (
                <ErrorState failure={failure} azure={azure} onRetry={() => void read(true)} />
              ) : (
                <ul className="gallery-grid" aria-busy="true" aria-label="Loading apps">
                  {Array.from({ length: 8 }, (_, i) => (
                    <SkeletonCard key={i} index={i} />
                  ))}
                </ul>
              )
            ) : apps.length === 0 ? (
              <div className="gallery-state">
                <FabricatorMark className="gallery-state-mark" />
                <p className="gallery-state-title">No Rayfin apps yet</p>
                <p className="gallery-state-sub">
                  Apps you publish to Fabric, and apps others share with you, show up here.
                </p>
                <div className="gallery-state-actions">
                  <button type="button" className="btn btn--primary" onClick={onNewProject}>
                    New project
                  </button>
                </div>
              </div>
            ) : filtered.length === 0 ? (
              <div className="gallery-state">
                <Codicon name="search" className="gallery-state-glyph" />
                <p className="gallery-state-title">
                  {text.trim() ? `No apps match “${text.trim()}”` : 'No apps match these filters'}
                </p>
                <p className="gallery-state-sub">Try other words, or look in every workspace.</p>
                <div className="gallery-state-actions">
                  <button type="button" className="btn" onClick={showAll}>
                    Show all apps
                  </button>
                </div>
              </div>
            ) : prefs.sort === 'workspace' ? (
              groupByWorkspace(shown).map((group) => (
                <section key={group.id} className="gallery-group" aria-label={group.name}>
                  <h2 className="gallery-group-head">
                    <Codicon name={groupIcon(group)} />
                    {group.name}
                    <span className="gallery-group-count">{group.entries.length}</span>
                  </h2>
                  <Grid
                    entries={group.entries}
                    selectedId={selectedId}
                    label={group.pinned ? 'Pinned apps' : `Apps in ${group.name}`}
                    grouped={!group.pinned}
                    onSelect={select}
                    onPin={pinCard}
                  />
                </section>
              ))
            ) : (
              <Grid entries={shown} selectedId={selectedId} onSelect={select} onPin={pinCard} />
            )}
            {filtered.length > shown.length && (
              <div className="gallery-more">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setLimit((n) => n + PAGE)}
                >
                  Show more ({(filtered.length - shown.length).toLocaleString('en')} left)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {selected && (
        <AppDetails
          key={selected.id}
          app={selected}
          status={statuses[selected.id]}
          pinned={prefs.pinned.includes(pinKey(selected))}
          onClose={closeDetails}
          onOpenProject={onOpenProject}
          onPin={togglePin}
          openUrl={openUrl}
        />
      )}
    </div>
  )
}

function groupIcon(group: GalleryGroup): string {
  if (group.pinned) return 'pinned'
  return group.name === 'My workspace' ? 'account' : 'folder'
}

function Grid({
  entries,
  selectedId,
  label = 'Apps',
  grouped = false,
  onSelect,
  onPin
}: {
  entries: readonly GalleryEntry[]
  selectedId: string | null
  label?: string
  /** Under a workspace's heading, so the cards needn't name it. */
  grouped?: boolean
  onSelect: (app: GalleryApp) => void
  onPin: (app: GalleryApp, keyboard: boolean) => void
}): JSX.Element {
  return (
    <ul className="gallery-grid" aria-label={label}>
      {entries.map(({ app, status, pinned }) => (
        <AppCard
          key={app.id}
          app={app}
          status={status}
          selected={app.id === selectedId}
          pinned={pinned}
          showWorkspace={!grouped}
          onSelect={onSelect}
          onPin={onPin}
        />
      ))}
    </ul>
  )
}

function SignInButton({
  azure,
  small = false
}: {
  azure: AzureSignIn
  small?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      className={`btn btn--primary${small ? ' btn--sm' : ''}`}
      disabled={azure.signingIn}
      onClick={() => void azure.signIn()}
    >
      {azure.signingIn ? 'Signing in…' : 'Sign in to Azure'}
    </button>
  )
}

/** Nothing to show yet: ask for the Azure sign-in, or say what went wrong. */
function ErrorState({
  failure,
  azure,
  onRetry
}: {
  failure: Failure
  azure: AzureSignIn
  onRetry: () => void
}): JSX.Element {
  return (
    <div className="gallery-state" role="alert">
      <Codicon name={failure.needsAz ? 'account' : 'warning'} className="gallery-state-glyph" />
      <p className="gallery-state-title">
        {failure.needsAz ? 'Sign in to Azure' : 'Couldn’t list your apps'}
      </p>
      <p className="gallery-state-sub">
        {azure.signingIn
          ? 'Finish signing in to Azure in your browser.'
          : (azure.error ?? failure.error)}
      </p>
      <div className="gallery-state-actions">
        {failure.needsAz && <SignInButton azure={azure} />}
        <button type="button" className="btn" disabled={azure.signingIn} onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  )
}

/** The apps shown are from earlier: checking Fabric again didn't work. */
function Banner({
  failure,
  azure,
  onRetry
}: {
  failure: Failure
  azure: AzureSignIn
  onRetry: () => void
}): JSX.Element {
  return (
    <div className="gallery-note gallery-note--warn" role="alert">
      <span className="gdot gdot--warn" aria-hidden="true" />
      <span className="gallery-note-text">
        {failure.needsAz
          ? 'Sign in to Azure to see your latest apps. These are from earlier.'
          : `Couldn’t check Fabric for changes: ${failure.error}`}
      </span>
      {failure.needsAz ? (
        <SignInButton azure={azure} small />
      ) : (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}
