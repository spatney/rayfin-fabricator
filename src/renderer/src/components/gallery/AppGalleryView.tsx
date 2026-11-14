import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  CommunityTemplate,
  GalleryApp,
  GalleryDescribeResult,
  GalleryResult,
  GalleryStatus,
  StudioProject
} from '@shared/ipc'
import { topLayerOpen, useSuppressPreview } from '../../overlay'
import { useAzureSignIn, type AzureSignIn } from '../../azureAuth'
import { authErrorMessage } from '../../authErrors'
import type { WorkspaceUse } from '../../fabric'
import { formatLocale, Trans, translator, useTranslation } from '../../i18n'
import { useProjectFacts } from '../../projectFacts'
import { useThumbnails } from '../../thumbnails'
import { FabricatorMark } from '../FabricatorMark'
import { Codicon } from '../icons'
import { rayfinUpdate } from '../recentProjectsModel'
import AppCard, { SkeletonCard } from './AppCard'
import AppDetails from './AppDetails'
import AppTable from './AppTable'
import ExamplesView from './ExamplesView'
import { GalleryMenu } from './GalleryMenu'
import {
  gallerySnapshot,
  noteOpened,
  openedTimes,
  resetGallerySnapshotForTests as forgetSnapshot,
  setGallerySnapshot
} from './memory'
import QuickLook from './QuickLook'
import { WorkspaceName, WorkspacePicker, workspaceIcon } from './WorkspacePicker'
import {
  ago,
  appAddress,
  appHealth,
  applyQuery,
  groupByWorkspace,
  pinKey,
  publishedThumbnail,
  rankWorkspaces,
  workspacesOf,
  type GalleryEntry,
  type GalleryGroup,
  type GalleryQuery,
  type GallerySort,
  type GalleryView,
  type GalleryWhere,
  type HealthIssue
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
  /** The workspaces your apps on this computer use, and when: the gallery lists them first. */
  recentWorkspaces?: readonly WorkspaceUse[]
  /** The projects on this computer: their pictures, and how the apps they publish stand. */
  projects?: readonly StudioProject[]
  /** Start a new project from a community example (the Examples tab offers them). */
  onUseExample?: (template: CommunityTemplate) => void
}

/** Cards shown before "Show more". */
const PAGE = 120
/** Statuses asked for at once. */
const STATUS_CHUNK = 12
/** Most apps whose statuses are read to put the most recently published first. */
const RECENT_LIMIT = 500
const PREFS_KEY = 'rayfin.gallery'

/** Test seam: forget the last apps read. */
export function resetGallerySnapshotForTests(): void {
  forgetSnapshot()
}

type Prefs = Pick<GalleryQuery, 'where' | 'sort' | 'pinned'> & {
  view: GalleryView
  attention: boolean
  editable: boolean
}
const WHERE: readonly GalleryWhere[] = ['all', 'local', 'remote']
const SORTS: readonly GallerySort[] = ['name', 'recent', 'opened', 'workspace']
const VIEWS: readonly GalleryView[] = ['grid', 'table']
/** Each order's name and description in the Sort menu (their keys in `gallery`). */
const SORT_NAMES = {
  name: { label: 'sort.name.label', desc: 'sort.name.desc' },
  recent: { label: 'sort.recent.label', desc: 'sort.recent.desc' },
  opened: { label: 'sort.opened.label', desc: 'sort.opened.desc' },
  workspace: { label: 'sort.workspace.label', desc: 'sort.workspace.desc' }
} as const satisfies Record<GallerySort, { label: string; desc: string }>

/** The saved pins: each key once, leaving out anything that isn't one. */
function savedPins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((key): key is string => typeof key === 'string' && key !== ''))]
}

const DEFAULT_PREFS: Prefs = {
  where: 'all',
  sort: 'name',
  pinned: [],
  view: 'grid',
  attention: false,
  editable: false
}

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    return {
      where: WHERE.includes(saved.where as GalleryWhere) ? (saved.where as GalleryWhere) : 'all',
      sort: SORTS.includes(saved.sort as GallerySort) ? (saved.sort as GallerySort) : 'name',
      pinned: savedPins(saved.pinned),
      view: VIEWS.includes(saved.view as GalleryView) ? (saved.view as GalleryView) : 'grid',
      attention: saved.attention === true,
      editable: saved.editable === true
    }
  } catch {
    return DEFAULT_PREFS
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
  onSignedIn,
  recentWorkspaces,
  projects,
  onUseExample
}: Props): JSX.Element {
  useSuppressPreview()
  const { t } = useTranslation('gallery')
  const [result, setResult] = useState<GalleryResult | null>(
    () => gallerySnapshot()?.result ?? null
  )
  const [statuses, setStatuses] = useState<Record<string, GalleryStatus>>(
    () => gallerySnapshot()?.statuses ?? {}
  )
  const [failure, setFailure] = useState<Failure | null>(null)
  const [checking, setChecking] = useState(true)
  const [text, setText] = useState('')
  const [prefs, setPrefs] = useState(loadPrefs)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** The app whose live page the quick look shows. */
  const [lookId, setLookId] = useState<string | null>(null)
  const [tab, setTab] = useState<'apps' | 'examples'>('apps')
  /** When each app was last opened from here (ms), by pin key. */
  const [opened, setOpened] = useState(openedTimes)
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

  const requested = useRef(new Set<string>(Object.keys(gallerySnapshot()?.statuses ?? {})))
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
      const listFailed = (): string => translator('gallery')('view.listFailed')
      let next: GalleryResult
      try {
        next = await window.api.gallery.list(refresh)
      } catch (reason) {
        next = { ok: false, apps: [], error: authErrorMessage(reason, listFailed()) }
      }
      if (seq !== readSeq.current || !mounted.current) return
      setChecking(false)
      if (!next.ok) {
        setFailure({ error: next.error || listFailed(), needsAz: next.needsAz })
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
    if (result?.ok) setGallerySnapshot({ result, statuses })
  }, [result, statuses])

  const azure = useAzureSignIn(async () => {
    await onSignedIn?.()
    await read(true)
  })

  /* ---- what's shown ---- */

  const apps = useMemo(() => result?.apps ?? [], [result])
  const workspaces = useMemo(() => workspacesOf(apps), [apps])
  const ranked = useMemo(
    () => rankWorkspaces(workspaces, recentWorkspaces ?? []),
    [workspaces, recentWorkspaces]
  )
  const recentIds = useMemo(() => ranked.recent.map((w) => w.id), [ranked])
  const usedAtOf = useMemo(() => new Map(ranked.recent.map((w) => [w.id, w.usedAt])), [ranked])
  const localCount = useMemo(() => apps.filter((a) => a.local).length, [apps])

  // The projects here that publish these apps: their pictures, and how they stand.
  const projectsById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects])
  const publishing = useMemo(
    () =>
      apps.flatMap((app) => {
        const project = app.local ? projectsById.get(app.local.projectId) : undefined
        return project ? [project] : []
      }),
    [apps, projectsById]
  )
  const facts = useProjectFacts(publishing)
  const thumbnail = useThumbnails(publishing)
  const projectOf = useCallback(
    (app: GalleryApp): StudioProject | undefined =>
      app.local ? projectsById.get(app.local.projectId) : undefined,
    [projectsById]
  )
  const updateOf = useCallback(
    (app: GalleryApp): string | null => {
      const project = projectOf(app)
      return project ? rayfinUpdate(project, facts.latest) : null
    },
    [projectOf, facts.latest]
  )
  const issuesOf = useCallback(
    (app: GalleryApp, status: GalleryStatus | undefined): HealthIssue[] => {
      const project = projectOf(app)
      return appHealth({
        status,
        publishFailed: project?.lastDeploy?.status === 'error',
        changed: project ? facts.changed.get(project.id) : undefined,
        update: updateOf(app)
      })
    },
    [projectOf, facts.changed, updateOf]
  )
  const pictureOf = (app: GalleryApp): string | undefined =>
    app.local ? thumbnail(app.local.projectId) : undefined

  // Opened here, or (for an app published from this computer) its project opened.
  const openedAt = useMemo(() => {
    const times: Record<string, number> = { ...opened }
    for (const app of apps) {
      const at = Date.parse(projectOf(app)?.lastOpenedAt ?? '')
      const key = pinKey(app)
      if (Number.isFinite(at) && at > (times[key] ?? 0)) times[key] = at
    }
    return times
  }, [opened, apps, projectOf])

  const query = useMemo<GalleryQuery>(
    () => ({ text, workspaceId, ...prefs, recent: recentIds, opened: openedAt }),
    [text, workspaceId, prefs, recentIds, openedAt]
  )
  const filtered = useMemo(
    () => applyQuery(apps, statuses, query, issuesOf),
    [apps, statuses, query, issuesOf]
  )
  const shown = filtered.slice(0, limit)
  const filteredBy =
    Boolean(text.trim()) ||
    prefs.where !== 'all' ||
    workspaceId !== null ||
    prefs.attention ||
    prefs.editable
  const selected = selectedId ? apps.find((a) => a.id === selectedId) : undefined
  const attentionCount = useMemo(
    () => apps.filter((app) => issuesOf(app, statuses[app.id]).length > 0).length,
    [apps, statuses, issuesOf]
  )
  /** Fabric said which apps the account can change. */
  const rolesKnown = apps.some((app) => app.canEdit !== undefined)
  const editableCount = useMemo(() => apps.filter((app) => app.canEdit === true).length, [apps])
  const looking = lookId ? apps.find((a) => a.id === lookId) : undefined
  const lookUrl = looking ? appAddress(looking, statuses[looking.id]) : undefined

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
  useEffect(
    () => setLimit(PAGE),
    [text, workspaceId, prefs.where, prefs.sort, prefs.attention, prefs.editable]
  )

  // Read the statuses of the cards on screen; of every app to sort by publish;
  // and of every app to find the ones that need attention.
  useEffect(() => {
    if (!result) return
    const targets = prefs.attention
      ? apps.slice(0, RECENT_LIMIT)
      : prefs.sort === 'recent'
        ? filtered.slice(0, RECENT_LIMIT).map((e) => e.app)
        : filtered.slice(0, limit).map((e) => e.app)
    want(targets)
  }, [result, apps, filtered, limit, prefs.sort, prefs.attention, want])

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
      .querySelector<HTMLElement>(`[data-pin-for="${pressed.id}"]`)
      ?.focus({ preventScroll: !pressed.keyboard })
  }, [prefs.pinned])

  /** Note that an app was opened, for the Recently opened order. */
  const markOpened = useCallback((app: GalleryApp): void => {
    noteOpened(app)
    setOpened(openedTimes())
  }, [])

  const openLook = useCallback(
    (app: GalleryApp): void => {
      setLookId(app.id)
      markOpened(app)
    },
    [markOpened]
  )

  const closeLook = useCallback((): void => {
    const id = lookId
    setLookId(null)
    // Back to the app it was opened from.
    if (id)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-app-id="${id}"]`)?.focus()
      )
  }, [lookId])

  // The app looked at is gone (a refresh, another account), or lost its address.
  useEffect(() => {
    if (lookId && (!looking || !lookUrl)) setLookId(null)
  }, [lookId, looking, lookUrl])

  /** Have Copilot write an app's description, and show it once it's saved. */
  const describe = useCallback(async (app: GalleryApp): Promise<GalleryDescribeResult> => {
    if (!app.local) return { ok: false, error: translator('gallery')('view.notLocal') }
    const answer = await window.api.gallery.describe(app.local.projectId)
    const description = answer.ok ? answer.description : undefined
    if (description && mounted.current) {
      setResult(
        (current) =>
          current && {
            ...current,
            apps: current.apps.map((a) => (a.id === app.id ? { ...a, description } : a))
          }
      )
    }
    return answer
  }, [])

  // Esc closes the quick look, then the details, then clears the search, then
  // leaves. Capture runs before a dialog's own handler can remove it, so a
  // dialog, Search or Help on top keeps its Esc, and so does an open toolbar menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (topLayerOpen() || document.querySelector('.help')) return
      if ((event.target as Element | null)?.closest?.('.mp-pop')) return
      if (lookId) closeLook()
      else if (selectedId) closeDetails()
      else if (text) setText('')
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [lookId, selectedId, text, onClose, closeDetails, closeLook])

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
    setPrefs((p) => ({ ...p, where: 'all', attention: false, editable: false }))
  }
  /** An app has a page to look at once its address is known. */
  const canLook = (entry: GalleryEntry): boolean => Boolean(appAddress(entry.app, entry.status))

  /** What every list of apps (cards or table) needs besides its entries. */
  const results = {
    selectedId,
    view: prefs.view,
    picture: pictureOf,
    updateOf,
    canLook,
    onSelect: select,
    onPin: pinCard,
    onQuickLook: openLook
  }

  const user = result?.account?.user
  const summary = result
    ? filteredBy
      ? t('summary.filtered', { shown: filtered.length, count: apps.length })
      : t('summary.total', {
          apps: t('count.apps', { count: apps.length }),
          workspaces: t('count.workspaces', { count: workspaces.length })
        })
    : ''
  const announced = result
    ? filteredBy
      ? t('announce.filtered', { shown: filtered.length, count: apps.length })
      : t('announce.all', { count: apps.length })
    : checking
      ? t('announce.loading')
      : ''

  return (
    <div className="gallery">
      <div className="gallery-main">
        <header className="gallery-head">
          <div className="gallery-wrap gallery-head-inner">
            <div className="gallery-title-row">
              <div className="gallery-titles">
                <p className="gallery-eyebrow">{t('head.eyebrow')}</p>
                <h1 className="gallery-title">{t('head.title')}</h1>
                <p className="gallery-sub">
                  {user ? (
                    <Trans
                      t={t}
                      i18nKey="head.subAs"
                      values={{ user }}
                      components={{ b: <strong /> }}
                    />
                  ) : (
                    t('head.sub')
                  )}
                </p>
              </div>
              <div className="gallery-head-tools">
                {checking && result && (
                  <span className="gallery-checking">{t('head.checking')}</span>
                )}
                {summary && <span className="gallery-count">{summary}</span>}
                {tab === 'apps' && (
                  <div className="seg gallery-view" role="group" aria-label={t('layout.label')}>
                    {(
                      [
                        ['grid', 'layout.grid'],
                        ['table', 'layout.table']
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`seg-btn${prefs.view === value ? ' seg-btn--active' : ''}`}
                        aria-pressed={prefs.view === value}
                        onClick={() => setPrefs((p) => ({ ...p, view: value }))}
                      >
                        {t(label)}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="btn btn--sm btn--icon"
                  aria-label={t('actions.refresh')}
                  title={t('actions.refresh')}
                  disabled={checking}
                  onClick={() => void read(true)}
                >
                  <Codicon name="refresh" className={checking ? 'icon-spin' : undefined} />
                </button>
              </div>
            </div>

            {onUseExample && (
              <div className="gallery-tabs" role="tablist" aria-label={t('tabs.label')}>
                {(
                  [
                    ['apps', 'tabs.apps'],
                    ['examples', 'tabs.examples']
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={tab === value}
                    className={`gallery-tab${tab === value ? ' is-on' : ''}`}
                    onClick={() => setTab(value)}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
            )}

            {tab === 'apps' && (
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
                    placeholder={t('search.placeholder')}
                    aria-label={t('search.label')}
                    onChange={(e) => setText(e.target.value)}
                  />
                  {!text && (
                    <kbd className="gallery-search-key" aria-hidden="true">
                      /
                    </kbd>
                  )}
                </label>
                <div className="seg gallery-where" role="group" aria-label={t('where.label')}>
                  {(
                    [
                      ['all', 'where.all', apps.length],
                      ['local', 'where.local', localCount],
                      ['remote', 'where.remote', apps.length - localCount]
                    ] as const
                  ).map(([value, label, n]) => (
                    <button
                      key={value}
                      type="button"
                      className={`seg-btn${prefs.where === value ? ' seg-btn--active' : ''}`}
                      aria-pressed={prefs.where === value}
                      onClick={() => setPrefs((p) => ({ ...p, where: value }))}
                    >
                      {t(label)}
                      {result && (
                        <span className="gallery-seg-count">
                          {n.toLocaleString(formatLocale())}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className={`gallery-chip${prefs.attention ? ' is-on' : ''}`}
                  aria-pressed={prefs.attention}
                  title={t('filters.attentionTitle')}
                  onClick={() => setPrefs((p) => ({ ...p, attention: !p.attention }))}
                >
                  <span className="gdot gdot--pending" aria-hidden="true" />
                  {t('filters.attention')}
                  {result && (
                    <span className="gallery-seg-count">
                      {attentionCount.toLocaleString(formatLocale())}
                    </span>
                  )}
                </button>
                {rolesKnown && (
                  <button
                    type="button"
                    className={`gallery-chip${prefs.editable ? ' is-on' : ''}`}
                    aria-pressed={prefs.editable}
                    title={t('filters.editableTitle')}
                    onClick={() => setPrefs((p) => ({ ...p, editable: !p.editable }))}
                  >
                    <Codicon name="edit" />
                    {t('filters.editable')}
                    <span className="gallery-seg-count">
                      {editableCount.toLocaleString(formatLocale())}
                    </span>
                  </button>
                )}
                <WorkspacePicker
                  recent={ranked.recent}
                  others={ranked.others}
                  total={apps.length}
                  value={workspaceId}
                  onChange={setWorkspaceId}
                />
                <GalleryMenu
                  icon="list-ordered"
                  label={t(SORT_NAMES[prefs.sort].label)}
                  value={t(SORT_NAMES[prefs.sort].label)}
                  name={t('sort.menu')}
                  width={260}
                >
                  {(close) =>
                    SORTS.map((sort) => {
                      const on = prefs.sort === sort
                      return (
                        <button
                          key={sort}
                          type="button"
                          role="menuitemradio"
                          aria-checked={on}
                          className="mp-item"
                          onClick={() => {
                            setPrefs((p) => ({ ...p, sort }))
                            close()
                          }}
                        >
                          <span className="mp-item-text">
                            <span className="mp-item-label">{t(SORT_NAMES[sort].label)}</span>
                            <span className="mp-item-desc">{t(SORT_NAMES[sort].desc)}</span>
                          </span>
                          <Codicon
                            name="check"
                            className={`mp-check${on ? '' : ' mp-check--off'}`}
                          />
                        </button>
                      )
                    })
                  }
                </GalleryMenu>
              </div>
            )}
          </div>
        </header>

        <div className="gallery-scroll">
          <div className="gallery-wrap">
            {tab === 'examples' && onUseExample ? (
              <ExamplesView onUse={onUseExample} />
            ) : (
              <>
                <p className="sr-only" role="status">
                  {announced}
                </p>
                {result && failure && (
                  <Banner failure={failure} azure={azure} onRetry={() => void read(true)} />
                )}
                {result?.truncated && (
                  <p className="gallery-note">
                    <Codicon name="info" />
                    {t('notes.truncated')}
                  </p>
                )}
                {!result ? (
                  failure ? (
                    <ErrorState failure={failure} azure={azure} onRetry={() => void read(true)} />
                  ) : (
                    <ul className="gallery-grid" aria-busy="true" aria-label={t('loadingLabel')}>
                      {Array.from({ length: 8 }, (_, i) => (
                        <SkeletonCard key={i} index={i} />
                      ))}
                    </ul>
                  )
                ) : apps.length === 0 ? (
                  <div className="gallery-state">
                    <FabricatorMark className="gallery-state-mark" />
                    <p className="gallery-state-title">{t('empty.title')}</p>
                    <p className="gallery-state-sub">{t('empty.desc')}</p>
                    <div className="gallery-state-actions">
                      <button type="button" className="btn btn--primary" onClick={onNewProject}>
                        {t('empty.newProject')}
                      </button>
                    </div>
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="gallery-state">
                    <Codicon name="search" className="gallery-state-glyph" />
                    <p className="gallery-state-title">
                      {text.trim()
                        ? t('noMatch.text', { text: text.trim() })
                        : t('noMatch.filters')}
                    </p>
                    <p className="gallery-state-sub">{t('noMatch.desc')}</p>
                    <div className="gallery-state-actions">
                      <button type="button" className="btn" onClick={showAll}>
                        {t('noMatch.showAll')}
                      </button>
                    </div>
                  </div>
                ) : prefs.sort === 'workspace' ? (
                  groupByWorkspace(shown).map((group) => {
                    const usedAt = group.pinned ? undefined : usedAtOf.get(group.id)
                    const name = group.pinned ? t('groups.pinned') : group.name
                    return (
                      <section key={group.id} className="gallery-group" aria-label={name}>
                        <h2 className="gallery-group-head">
                          <Codicon name={groupIcon(group)} />
                          <span className="gallery-group-name">
                            {group.pinned ? name : <WorkspaceName name={group.name} />}
                          </span>
                          <span className="gallery-group-count">{group.entries.length}</span>
                          {usedAt ? (
                            <span className="gallery-group-used">
                              {t('groups.used', { when: ago(new Date(usedAt).toISOString()) })}
                            </span>
                          ) : null}
                        </h2>
                        <Results
                          {...results}
                          entries={group.entries}
                          label={
                            group.pinned
                              ? t('groups.pinnedApps')
                              : t('groups.appsIn', { name: group.name })
                          }
                          grouped={!group.pinned}
                        />
                      </section>
                    )
                  })
                ) : (
                  <Results {...results} entries={shown} />
                )}
                {filtered.length > shown.length && (
                  <div className="gallery-more">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => setLimit((n) => n + PAGE)}
                    >
                      {t('more', { count: filtered.length - shown.length })}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {selected && tab === 'apps' && (
        <AppDetails
          key={selected.id}
          app={selected}
          status={statuses[selected.id]}
          pinned={prefs.pinned.includes(pinKey(selected))}
          picture={pictureOf(selected)}
          hosted={publishedThumbnail(selected, statuses[selected.id])}
          issues={issuesOf(selected, statuses[selected.id])}
          update={updateOf(selected)}
          onClose={closeDetails}
          onOpenProject={onOpenProject}
          onPin={togglePin}
          openUrl={openUrl}
          onOpened={markOpened}
          onQuickLook={openLook}
          onDescribe={describe}
        />
      )}
      {looking && lookUrl && (
        <QuickLook
          key={looking.id}
          app={looking}
          url={lookUrl}
          onClose={closeLook}
          onOpenApp={() => {
            markOpened(looking)
            openUrl(lookUrl)
          }}
          onOpenFabric={() => {
            markOpened(looking)
            openUrl(looking.portalUrl)
          }}
        />
      )}
    </div>
  )
}

function groupIcon(group: GalleryGroup): string {
  if (group.pinned) return 'pinned'
  return workspaceIcon(group.name)
}

interface ResultsProps {
  entries: readonly GalleryEntry[]
  selectedId: string | null
  label?: string
  /** Under a workspace's heading, so the apps needn't name it. */
  grouped?: boolean
  view: GalleryView
  /** An app's thumbnail from this computer. */
  picture: (app: GalleryApp) => string | undefined
  /** The Rayfin version an app's project could update to. */
  updateOf: (app: GalleryApp) => string | null
  /** Whether an app has a page to look at. */
  canLook: (entry: GalleryEntry) => boolean
  onSelect: (app: GalleryApp) => void
  onPin: (app: GalleryApp, keyboard: boolean) => void
  onQuickLook: (app: GalleryApp) => void
}

/** The apps, as cards or as a table. */
function Results({
  entries,
  selectedId,
  label,
  grouped = false,
  view,
  picture,
  updateOf,
  canLook,
  onSelect,
  onPin,
  onQuickLook
}: ResultsProps): JSX.Element {
  const { t } = useTranslation('gallery')
  const name = label ?? t('list.label')
  if (view === 'table') {
    return (
      <AppTable
        entries={entries}
        selectedId={selectedId}
        label={name}
        showWorkspace={!grouped}
        picture={picture}
        updateOf={updateOf}
        canLook={canLook}
        onSelect={onSelect}
        onPin={onPin}
        onQuickLook={onQuickLook}
      />
    )
  }
  return (
    <ul className="gallery-grid" aria-label={name}>
      {entries.map((entry) => (
        <AppCard
          key={entry.app.id}
          app={entry.app}
          status={entry.status}
          selected={entry.app.id === selectedId}
          pinned={entry.pinned}
          showWorkspace={!grouped}
          picture={picture(entry.app)}
          hosted={publishedThumbnail(entry.app, entry.status)}
          issues={entry.issues}
          update={updateOf(entry.app)}
          onSelect={onSelect}
          onPin={onPin}
          onQuickLook={canLook(entry) ? onQuickLook : undefined}
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
  const { t } = useTranslation('gallery')
  return (
    <button
      type="button"
      className={`btn btn--primary${small ? ' btn--sm' : ''}`}
      disabled={azure.signingIn}
      onClick={() => void azure.signIn()}
    >
      {azure.signingIn ? t('azure.signingIn') : t('azure.signIn')}
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
  const { t } = useTranslation('gallery')
  return (
    <div className="gallery-state" role="alert">
      <Codicon name={failure.needsAz ? 'account' : 'warning'} className="gallery-state-glyph" />
      <p className="gallery-state-title">
        {failure.needsAz ? t('azure.signIn') : t('error.title')}
      </p>
      <p className="gallery-state-sub">
        {azure.signingIn ? t('azure.finish') : (azure.error ?? failure.error)}
      </p>
      <div className="gallery-state-actions">
        {failure.needsAz && <SignInButton azure={azure} />}
        <button type="button" className="btn" disabled={azure.signingIn} onClick={onRetry}>
          {t('actions.tryAgain')}
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
  const { t } = useTranslation('gallery')
  return (
    <div className="gallery-note gallery-note--warn" role="alert">
      <span className="gdot gdot--warn" aria-hidden="true" />
      <span className="gallery-note-text">
        {failure.needsAz ? t('banner.signIn') : t('banner.failed', { error: failure.error })}
      </span>
      {failure.needsAz ? (
        <SignInButton azure={azure} small />
      ) : (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          {t('actions.tryAgain')}
        </button>
      )}
    </div>
  )
}
