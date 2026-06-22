import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import {
  MAIN_THREAD_ID,
  type AppSettings,
  type AppVersions,
  type AuthStatus,
  type ChatMessage,
  type ChatTurnResult,
  type DeployResult,
  type ProjectsState,
  type ProjectThread,
  type RayfinVersionInfo,
  type StudioProject
} from '@shared/ipc'
import NewProjectModal from '../components/NewProjectModal'
import NewThreadModal from '../components/NewThreadModal'
import ConfirmModal from '../components/ConfirmModal'
import SettingsModal from '../components/SettingsModal'
import ChatPanel, { type UIChatMessage, type OutboundPrompt } from '../components/ChatPanel'
import PreviewPane, { type DeployUiState, type PendingShot } from '../components/PreviewPane'
import ThreadBar, { type ThreadView } from '../components/ThreadBar'
import DeploymentsControl from '../components/DeploymentsControl'
import RayfinVersionControl from '../components/RayfinVersionControl'
import SkillsView from '../components/SkillsView'
import logo from '../assets/logo.png'

// Monaco is heavy (~7 MB); only load the code viewer when the Code tab is opened.
const CodeViewer = lazy(() => import('../components/CodeViewer'))

/** Seconds the cancellable "merging to main" countdown runs before it fires. */
const MERGE_COUNTDOWN_SECONDS = 8

/** Composite key for per-thread chat/shot state (main collapses to the project id). */
function chatKey(projectId: string, threadId: string): string {
  return threadId === MAIN_THREAD_ID ? projectId : `${projectId}\u0000${threadId}`
}

/** Split a composite chat key back into its project + thread ids. */
function splitKey(key: string): { projectId: string; threadId: string } {
  const i = key.indexOf('\u0000')
  return i < 0
    ? { projectId: key, threadId: MAIN_THREAD_ID }
    : { projectId: key.slice(0, i), threadId: key.slice(i + 1) }
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * Derive a short, human display name for a side thread from its first task, so
 * the user never has to name it. Strips leading filler/imperatives ("add a…",
 * "please implement…"), keeps the first few meaningful words and title-cases.
 */
function deriveThreadName(task: string): string {
  const firstLine = (task.split('\n').find((l) => l.trim()) ?? '').trim()
  const s = firstLine
    .replace(/^(please|hey|ok|okay|so)[,\s]+/i, '')
    .replace(/^(can|could|would)\s+you\s+/i, '')
    .replace(/^(i\s+want\s+to|i\s+want|i'?d\s+like\s+to|i\s+need\s+to|let'?s|help\s+me)\s+/i, '')
    .replace(
      /^(add|implement|build|create|make|set\s+up|setup|design|introduce|enable|support|improve|fix|update|wire\s+up|refactor|redesign|rework)\s+/i,
      ''
    )
    .replace(/^(a|an|the|some)\s+/i, '')
  const words = s.split(/\s+/).filter(Boolean).slice(0, 6)
  let name = words.join(' ').replace(/[.,;:!?]+$/, '').trim()
  if (name.length > 42) name = name.slice(0, 42).replace(/\s+\S*$/, '').trim() + '…'
  if (!name) return 'Side thread'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** Hydrate a persisted message into a live (non-pending) UI message. */
function toUi(m: ChatMessage): UIChatMessage {
  return { ...m, pending: false }
}

/** Strip transient fields (turnId, pending) before persisting to disk. */
function toStored(messages: UIChatMessage[]): ChatMessage[] {
  return messages.map(({ id, role, text, tools, error, attachments, kind, mergeName }) => ({
    id,
    role,
    text,
    tools,
    error,
    attachments,
    kind,
    mergeName
  }))
}

interface Props {
  auth: AuthStatus
  onSignOut: () => Promise<void> | void
  settings: AppSettings | null
  onSettingsChange: (patch: Partial<AppSettings>) => void
}

export default function Workbench({
  auth,
  onSignOut,
  settings,
  onSettingsChange
}: Props): JSX.Element {
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [projects, setProjects] = useState<ProjectsState | null>(null)
  const [showNewProject, setShowNewProject] = useState(false)
  const [opening, setOpening] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** Left projects sidebar collapsed state (persisted across sessions). */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('rf.sidebarCollapsed') === '1'
  )
  const toggleSidebar = useCallback((): void => {
    setSidebarCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem('rf.sidebarCollapsed', next ? '1' : '0')
      } catch {
        /* ignore persistence errors */
      }
      return next
    })
  }, [])
  /** Sidebar per-project actions menu / inline-rename / delete-confirm state. */
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<StudioProject | null>(null)
  const [deleting, setDeleting] = useState(false)
  /** Whether to also delete the project's deployed app(s) from Fabric. */
  const [alsoDeleteFabric, setAlsoDeleteFabric] = useState(false)
  /** Friendly message when deleting the Fabric app fails (keeps the modal open). */
  const [deleteError, setDeleteError] = useState<string | null>(null)
  /** Bumped whenever the working tree likely changed (deploy / chat turn). */
  const [gitRefresh, setGitRefresh] = useState(0)
  /** Active project's local Rayfin (CLI + SDK) version + upgrade availability. */
  const [rayfinVer, setRayfinVer] = useState<RayfinVersionInfo | null>(null)
  /** A prompt queued for the chat composer (e.g. the Rayfin upgrade hand-off). */
  const [chatOutbound, setChatOutbound] = useState<
    (OutboundPrompt & { projectId: string; threadId: string }) | null
  >(null)
  /** Project content view: the build loop (chat + preview) or the code browser. */
  const [viewMode, setViewMode] = useState<'build' | 'code' | 'skills'>('build')
  /** Build-view focus: expand a single pane to fill the area (null = split). */
  const [focusPane, setFocusPane] = useState<'chat' | 'preview' | null>(null)
  /** Chat's share of the build split (0..1); the rest goes to the preview. */
  const [chatFrac, setChatFrac] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem('rayfin.splitFrac') ?? '')
    return Number.isFinite(v) && v >= 0.2 && v <= 0.8 ? v : 0.5
  })
  /** True while the user is dragging the chat/preview divider. */
  const [resizing, setResizing] = useState(false)
  const panesRef = useRef<HTMLDivElement>(null)

  function onDividerDown(e: ReactMouseEvent): void {
    e.preventDefault()
    setResizing(true)
  }
  function onResizeMove(e: ReactMouseEvent): void {
    const el = panesRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const frac = Math.min(0.8, Math.max(0.2, (e.clientX - rect.left) / rect.width))
    setChatFrac(frac)
  }
  function endResize(): void {
    setResizing(false)
    setChatFrac((f) => {
      localStorage.setItem('rayfin.splitFrac', String(f))
      return f
    })
  }
  function resetSplit(): void {
    setChatFrac(0.5)
    localStorage.setItem('rayfin.splitFrac', '0.5')
  }
  const [chats, setChats] = useState<Record<string, UIChatMessage[]>>({})
  const [deploys, setDeploys] = useState<Record<string, DeployUiState>>({})
  /** Region screenshots staged per project for the next chat message. */
  const [shots, setShots] = useState<Record<string, PendingShot[]>>({})
  /** The project whose `rayfin up` is currently streaming (routes deploy:run logs). */
  const deployingIdRef = useRef<string | null>(null)
  /** Latest chats snapshot, for reading inside async callbacks / save timers. */
  const chatsRef = useRef(chats)
  chatsRef.current = chats
  /** Latest active project id, for guarding async (per-project) responses. */
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = projects?.activeProjectId ?? null
  /** Projects whose persisted history has been loaded this session (keyed by chatKey). */
  const hydratedRef = useRef<Set<string>>(new Set())
  /** Latest projects snapshot, for reading inside async callbacks. */
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  /** The currently active project (or null). Declared early — effects depend on it. */
  const active = projects?.projects.find((p) => p.id === projects.activeProjectId) ?? null

  /** Per-project active thread (absent ⇒ main). Drives the chat switcher. */
  const [activeThread, setActiveThread] = useState<Record<string, string>>({})
  /** Whether each thread has a turn in flight (keyed by chatKey). */
  const [busyThreads, setBusyThreads] = useState<Record<string, boolean>>({})
  /** New-side-thread modal state. */
  const [showNewThread, setShowNewThread] = useState(false)
  const [creatingThread, setCreatingThread] = useState(false)
  const [threadError, setThreadError] = useState<string | null>(null)
  /** Side thread queued for discard confirmation. */
  const [confirmDiscard, setConfirmDiscard] = useState<ProjectThread | null>(null)
  const [discarding, setDiscarding] = useState(false)
  /** Live auto-merge countdowns (chatKey → seconds left); source of truth. */
  const countdownsRef = useRef<Map<string, number>>(new Map())
  /** Side threads whose merge is currently running (chatKey). */
  const mergingRef = useRef<Set<string>>(new Set())
  /**
   * Side threads that are done and would merge, but whose merge is held back
   * because the main thread is still working (chatKey). Drained when main goes idle.
   */
  const pendingMergeRef = useRef<Set<string>>(new Set())
  /** Latest per-thread busy state, readable synchronously inside callbacks. */
  const busyThreadsRef = useRef<Record<string, boolean>>({})
  /** Stable handle to drain main-blocked merges once the main thread goes idle. */
  const drainPendingRef = useRef<(projectId: string) => void>(() => {})
  /** Projects with a deploy queued behind the running one (coalesced). */
  const pendingDeployRef = useRef<Set<string>>(new Set())
  /** Stable handle to runDeploy for use inside its own completion path. */
  const runDeployRef = useRef<((projectId: string) => void) | null>(null)
  /** Forces a re-render when ref-backed countdown / merge state changes. */
  const [, forceTick] = useReducer((x: number) => x + 1, 0)

  const addShot = useCallback((key: string, shot: PendingShot): void => {
    setShots((all) => ({ ...all, [key]: [...(all[key] ?? []), shot] }))
  }, [])

  const removeShot = useCallback((key: string, path: string): void => {
    setShots((all) => ({ ...all, [key]: (all[key] ?? []).filter((s) => s.path !== path) }))
    void window.api.screenshot.cleanup([path])
  }, [])

  const clearShots = useCallback((key: string): void => {
    setShots((all) => ({ ...all, [key]: [] }))
  }, [])

  const setMessagesFor = useCallback(
    (key: string, updater: (prev: UIChatMessage[]) => UIChatMessage[]): void => {
      setChats((all) => ({ ...all, [key]: updater(all[key] ?? []) }))
    },
    []
  )

  const refreshProjects = useCallback(async (): Promise<void> => {
    setProjects(await window.api.projects.state())
  }, [])

  /** Re-read the active project's local Rayfin versions (after deploys / chat turns). */
  const refreshRayfinVer = useCallback(async (projectId: string): Promise<void> => {
    const info = await window.api.rayfin.versions(projectId)
    // Guard against a stale response after the user switches projects.
    if (activeIdRef.current === projectId) setRayfinVer(info)
  }, [])

  // Route streamed `rayfin up` output to the deploying project's log buffer.
  useEffect(() => {
    const off = window.api.onProcLog((event) => {
      if (event.channel !== 'deploy:run') return
      const id = deployingIdRef.current
      if (!id) return
      setDeploys((all) => {
        const cur = all[id] ?? { running: true, log: [] }
        return { ...all, [id]: { ...cur, log: [...cur.log, event.data] } }
      })
    })
    return off
  }, [])

  const runDeploy = useCallback(
    async (projectId: string, workspace?: string, force?: boolean): Promise<void> => {
      if (deployingIdRef.current) {
        // A deploy is already streaming — queue this one to run right after.
        pendingDeployRef.current.add(projectId)
        return
      }
      deployingIdRef.current = projectId
      setDeploys((all) => ({ ...all, [projectId]: { running: true, log: [] } }))
      try {
        const result = await window.api.deploy.run(projectId, workspace, force)
        setDeploys((all) => {
          const cur = all[projectId] ?? { running: false, log: [] }
          return { ...all, [projectId]: { ...cur, running: false, result } }
        })
        await refreshProjects()
      } finally {
        deployingIdRef.current = null
        setGitRefresh((n) => n + 1)
        void refreshRayfinVer(projectId)
        // Run the next coalesced deploy, if one was requested mid-flight.
        if (pendingDeployRef.current.size > 0) {
          const next = pendingDeployRef.current.values().next().value as string
          pendingDeployRef.current.delete(next)
          runDeployRef.current?.(next)
        }
      }
    },
    [refreshProjects, refreshRayfinVer]
  )
  runDeployRef.current = (projectId: string) => void runDeploy(projectId)

  /** Start (or coalesce) a full deploy of main — used after an auto-merge. */
  const requestDeploy = useCallback(
    (projectId: string): void => {
      void runDeploy(projectId)
    },
    [runDeploy]
  )

  // Switch the active Fabric deployment, then reflect the new URL/status.
  const switchDeployment = useCallback(
    async (projectId: string, workspace: string, byId: boolean): Promise<DeployResult> => {
      const result = await window.api.deploy.switch(projectId, workspace, byId)
      await refreshProjects()
      setGitRefresh((n) => n + 1)
      return result
    },
    [refreshProjects]
  )

  // After a chat turn, persist the transcript. The main thread auto-deploys when
  // the agent left undeployed changes; a side thread instead starts the
  // cancellable auto-merge countdown once it goes idle after a successful turn.
  const handleTurnComplete = useCallback(
    async (projectId: string, threadId: string, result: ChatTurnResult): Promise<void> => {
      await refreshProjects()
      setGitRefresh((n) => n + 1)
      const key = chatKey(projectId, threadId)
      void window.api.chat.saveHistory(projectId, toStored(chatsRef.current[key] ?? []), threadId)
      if (threadId !== MAIN_THREAD_ID) {
        if (result.ok) startMergeCountdown(projectId, threadId)
        return
      }
      // The agent may have changed the Rayfin deps (e.g. an upgrade) — re-check.
      void refreshRayfinVer(projectId)
      if (!result.ok) return
      const changed = await window.api.deploy.hasChanges(projectId)
      if (changed) void runDeploy(projectId)
    },
    // startMergeCountdown is stable (defined below); intentionally omitted.
    [refreshProjects, refreshRayfinVer, runDeploy]
  )

  /** Track per-thread busy state; resuming work on a thread defers its merge. */
  const handleBusyChange = useCallback(
    (projectId: string, threadId: string, busy: boolean): void => {
      const key = chatKey(projectId, threadId)
      busyThreadsRef.current = { ...busyThreadsRef.current, [key]: busy }
      setBusyThreads(busyThreadsRef.current)
      // Resuming work on a side thread cancels its queued merge (countdown or
      // main-blocked) — the user clearly isn't done with it yet.
      if (busy) {
        let changed = countdownsRef.current.delete(key)
        if (pendingMergeRef.current.delete(key)) changed = true
        if (changed) forceTick()
      }
      // When the main thread finishes its turn, run any merges that were waiting
      // on it so conflict resolution never collides with main's own work.
      if (threadId === MAIN_THREAD_ID && !busy) drainPendingRef.current(projectId)
    },
    []
  )

  const startMergeCountdown = useCallback((projectId: string, threadId: string): void => {
    countdownsRef.current.set(chatKey(projectId, threadId), MERGE_COUNTDOWN_SECONDS)
    forceTick()
  }, [])

  const cancelCountdown = useCallback((projectId: string, threadId: string): void => {
    const key = chatKey(projectId, threadId)
    let changed = countdownsRef.current.delete(key)
    if (pendingMergeRef.current.delete(key)) changed = true
    if (changed) forceTick()
  }, [])

  /** Merge a side thread into main, streaming conflict resolution into main chat. */
  const performMerge = useCallback(
    async (projectId: string, threadId: string): Promise<void> => {
      const key = chatKey(projectId, threadId)
      countdownsRef.current.delete(key)
      if (mergingRef.current.has(key)) return
      // Don't merge while the main thread is mid-turn: it would commit main's
      // half-written work and start the conflict-resolution turn on top of main's
      // running one (which is what leaves conflicts unresolved). Hold the merge and
      // let it run when main goes idle (drainPendingRef, fired from handleBusyChange).
      const mainKey = chatKey(projectId, MAIN_THREAD_ID)
      if (busyThreadsRef.current[mainKey]) {
        pendingMergeRef.current.add(key)
        forceTick()
        return
      }
      pendingMergeRef.current.delete(key)
      const project = projectsRef.current?.projects.find((p) => p.id === projectId)
      const thread = project?.threads?.find((t) => t.id === threadId)
      if (!thread || thread.status !== 'active') return

      mergingRef.current.add(key)
      forceTick()

      // Render the merge as a single, distinct system event on the main thread
      // (not a fake "You" turn) so it never looks like main's own turn finished.
      // Copilot's conflict resolution (if any) streams into this same event.
      const turnId = `merge-${threadId}`
      const mergeMsg: UIChatMessage = {
        id: uid(),
        turnId,
        role: 'assistant',
        kind: 'merge',
        mergeName: thread.name,
        text: '',
        tools: [],
        pending: true
      }
      setChats((all) => ({ ...all, [mainKey]: [...(all[mainKey] ?? []), mergeMsg] }))

      try {
        const res = await window.api.threads.merge(projectId, threadId)
        setChats((all) => ({
          ...all,
          [mainKey]: (all[mainKey] ?? []).map((m) =>
            m.turnId === turnId
              ? { ...m, pending: false, error: res.ok ? m.error : res.error ?? 'Merge failed.' }
              : m
          )
        }))
        await refreshProjects()
        // If the merged thread was the one being viewed, fall back to main.
        setActiveThread((map) =>
          map[projectId] === threadId ? { ...map, [projectId]: MAIN_THREAD_ID } : map
        )
        void window.api.chat.saveHistory(
          projectId,
          toStored(chatsRef.current[mainKey] ?? []),
          MAIN_THREAD_ID
        )
        if (res.ok) requestDeploy(projectId)
      } finally {
        mergingRef.current.delete(key)
        forceTick()
      }
    },
    [refreshProjects, requestDeploy]
  )

  // Run merges that were held back while the main thread was working. Reassigned
  // every render so it always closes over the latest performMerge.
  drainPendingRef.current = (projectId: string): void => {
    for (const key of [...pendingMergeRef.current]) {
      const { projectId: pid, threadId } = splitKey(key)
      if (pid !== projectId) continue
      pendingMergeRef.current.delete(key)
      void performMerge(pid, threadId)
    }
  }

  // One steady ticker drives every live auto-merge countdown; at zero it fires
  // the merge. Ref-backed so React StrictMode can't double-trigger a merge.
  useEffect(() => {
    const t = setInterval(() => {
      const counts = countdownsRef.current
      if (counts.size === 0) return
      const fire: string[] = []
      for (const [key, secs] of [...counts]) {
        if (secs <= 1) {
          counts.delete(key)
          fire.push(key)
        } else {
          counts.set(key, secs - 1)
        }
      }
      forceTick()
      for (const key of fire) {
        const { projectId, threadId } = splitKey(key)
        void performMerge(projectId, threadId)
      }
    }, 1000)
    return () => clearInterval(t)
  }, [performMerge])

  // Hydrate persisted chat history for the active project's main + side threads.
  useEffect(() => {
    if (!active) return
    const ids = [
      MAIN_THREAD_ID,
      ...(active.threads ?? []).filter((t) => t.status === 'active').map((t) => t.id)
    ]
    for (const tid of ids) {
      const key = chatKey(active.id, tid)
      if (hydratedRef.current.has(key)) continue
      hydratedRef.current.add(key)
      void window.api.chat.history(active.id, tid).then((stored) => {
        setChats((all) => (all[key] !== undefined ? all : { ...all, [key]: stored.map(toUi) }))
      })
    }
    // active identity is captured via id + threads; effect re-runs are guarded.
  }, [active?.id, active?.threads])

  // Hand a Rayfin upgrade to the Copilot agent: build a precise "from X → to Y"
  // prompt and queue it into the chat (the agent edits package.json + installs).
  const requestRayfinUpdate = useCallback((info: RayfinVersionInfo): void => {
    const id = activeIdRef.current
    if (!id) return
    const ups = info.packages.filter((p) => p.upgradable && p.installed && p.latest)
    if (ups.length === 0) return
    const lines = ups.map((p) => `- ${p.name}: ${p.installed} → ${p.latest}`).join('\n')
    const to = info.latest ?? ups[0].latest
    const prompt =
      "Please upgrade this app's Rayfin packages to the latest version.\n\n" +
      'Set these exact versions in package.json, then run `npm install`:\n' +
      `${lines}\n\n` +
      'After installing, check for any breaking changes between these versions and update ' +
      'the app code so it still builds and runs. Do not run `rayfin up` or deploy — Rayfin ' +
      'Fabricator redeploys automatically.'
    setViewMode('build')
    setFocusPane(null)
    setChatOutbound({
      id: `rayfin-up-${Date.now()}`,
      projectId: id,
      threadId: MAIN_THREAD_ID,
      display: `Update Rayfin to ${to}`,
      prompt
    })
  }, [])

  // Load the active project's local Rayfin version + upgrade availability.
  useEffect(() => {
    const id = projects?.activeProjectId
    if (!id) {
      setRayfinVer(null)
      return
    }
    setRayfinVer(null)
    void refreshRayfinVer(id)
  }, [projects?.activeProjectId, refreshRayfinVer])

  // Debounce-persist chat transcripts whenever they change (after streaming settles).
  useEffect(() => {
    const t = setTimeout(() => {
      for (const key of hydratedRef.current) {
        const msgs = chatsRef.current[key]
        if (!msgs) continue
        const { projectId, threadId } = splitKey(key)
        void window.api.chat.saveHistory(projectId, toStored(msgs), threadId)
      }
    }, 600)
    return () => clearTimeout(t)
  }, [chats])

  useEffect(() => {
    void window.api.getVersions().then(setVersions)
    void refreshProjects()
  }, [refreshProjects])

  // Close the open sidebar actions menu on any outside click.
  useEffect(() => {
    if (!menuOpenId) return
    const close = (): void => setMenuOpenId(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuOpenId])

  async function selectProject(p: StudioProject): Promise<void> {
    setNotice(null)
    setProjects(await window.api.projects.setActive(p.id))
  }

  // Fork a new side thread and immediately hand it its first task.
  async function createSideThread(firstTask: string): Promise<void> {
    if (!active) return
    setCreatingThread(true)
    setThreadError(null)
    try {
      const name = deriveThreadName(firstTask)
      const res = await window.api.threads.create({ projectId: active.id, name })
      if (!res.ok || !res.thread) {
        setThreadError(res.error ?? 'Could not create the side thread.')
        return
      }
      const tid = res.thread.id
      await refreshProjects()
      setActiveThread((m) => ({ ...m, [active.id]: tid }))
      setShowNewThread(false)
      setViewMode('build')
      setFocusPane(null)
      setChatOutbound({
        id: `thread-${tid}-${Date.now()}`,
        projectId: active.id,
        threadId: tid,
        display: firstTask,
        prompt: firstTask
      })
    } finally {
      setCreatingThread(false)
    }
  }

  // Discard a side thread (after confirmation): cancel it, remove its worktree.
  async function discardThread(): Promise<void> {
    if (!confirmDiscard || !active) return
    const threadId = confirmDiscard.id
    const key = chatKey(active.id, threadId)
    setDiscarding(true)
    try {
      countdownsRef.current.delete(key)
      pendingMergeRef.current.delete(key)
      await window.api.chat.cancel(active.id, threadId)
      await window.api.threads.remove(active.id, threadId)
      setActiveThread((m) =>
        m[active.id] === threadId ? { ...m, [active.id]: MAIN_THREAD_ID } : m
      )
      hydratedRef.current.delete(key)
      setChats((all) => {
        const next = { ...all }
        delete next[key]
        return next
      })
      await refreshProjects()
      setConfirmDiscard(null)
    } finally {
      setDiscarding(false)
    }
  }

  async function openExisting(): Promise<void> {
    setNotice(null)
    setOpening(true)
    try {
      const path = await window.api.projects.pickFolder()
      if (!path) return
      const result = await window.api.projects.open(path)
      if (!result.ok) {
        setNotice(result.error ?? 'Could not open that folder.')
        return
      }
      await refreshProjects()
    } finally {
      setOpening(false)
    }
  }

  async function changeWorkspaceRoot(): Promise<void> {
    setProjects(await window.api.projects.pickWorkspaceRoot())
  }

  async function removeFromList(p: StudioProject): Promise<void> {
    setMenuOpenId(null)
    setProjects(await window.api.projects.remove(p.id, false))
  }

  function startRename(p: StudioProject): void {
    setMenuOpenId(null)
    setRenameValue(p.name)
    setRenamingId(p.id)
  }

  async function submitRename(p: StudioProject): Promise<void> {
    const next = renameValue.trim()
    setRenamingId(null)
    if (!next || next === p.name) return
    const result = await window.api.projects.rename(p.id, next)
    if (!result.ok) {
      setNotice(result.error ?? 'Could not rename the project.')
      return
    }
    await refreshProjects()
  }

  // Default "also delete from Fabric" on when the project has been deployed.
  useEffect(() => {
    setDeleteError(null)
    setAlsoDeleteFabric(Boolean(confirmDelete?.lastDeploy?.url))
  }, [confirmDelete])

  async function deleteFromDisk(): Promise<void> {
    if (!confirmDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      // Delete the deployed app(s) from Fabric first (needs the project on disk
      // to enumerate). On failure, stay in the modal so the user can retry or
      // untick the option and remove locally only.
      if (alsoDeleteFabric) {
        const res = await window.api.fabric.deleteApps(confirmDelete.id)
        if (!res.ok) {
          setDeleteError(
            res.needsLogin
              ? 'You need to be signed in to Fabric to delete the app there. Sign in and try again, or untick the option to remove it from this app only.'
              : (res.failures[0]?.error ?? res.error ?? 'Could not delete the app from Fabric.')
          )
          return
        }
      }
      setProjects(await window.api.projects.remove(confirmDelete.id, true))
      setConfirmDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  async function signOut(): Promise<void> {
    setSigningOut(true)
    try {
      await window.api.auth.logoutRayfin()
    } finally {
      try {
        // Keep the overlay up through the auth re-check + screen swap; this
        // component normally unmounts when the app returns to the setup screen.
        await onSignOut()
      } finally {
        setSigningOut(false)
      }
    }
  }

  // Derived side-thread view state for the active project (experimental).
  const sideThreadsOn = Boolean(settings?.experiments?.sideThreads)
  const liveThreads = (active?.threads ?? []).filter(
    (t) => t.status === 'active' || t.status === 'error'
  )
  const panelThreadIds = active
    ? sideThreadsOn
      ? [MAIN_THREAD_ID, ...liveThreads.map((t) => t.id)]
      : [MAIN_THREAD_ID]
    : []
  const rawActiveThread = active ? activeThread[active.id] ?? MAIN_THREAD_ID : MAIN_THREAD_ID
  const activeThreadId = panelThreadIds.includes(rawActiveThread)
    ? rawActiveThread
    : MAIN_THREAD_ID
  const threadViews: ThreadView[] = active
    ? liveThreads.map((t) => {
        const key = chatKey(active.id, t.id)
        let status: ThreadView['status'] = 'idle'
        let countdown: number | undefined
        if (mergingRef.current.has(key)) status = 'merging'
        else if (pendingMergeRef.current.has(key)) status = 'waiting-main'
        else if (countdownsRef.current.has(key)) {
          status = 'countdown'
          countdown = countdownsRef.current.get(key)
        } else if (t.status === 'error') status = 'error'
        else if (busyThreads[key]) status = 'working'
        return { id: t.id, name: t.name, status, countdown, error: t.lastError }
      })
    : []

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <button
            className="sidebar-toggle"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? 'Show projects panel' : 'Hide projects panel'}
            aria-label={sidebarCollapsed ? 'Show projects panel' : 'Hide projects panel'}
            aria-pressed={!sidebarCollapsed}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect
                x="3"
                y="4.5"
                width="18"
                height="15"
                rx="2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <line
                x1="9.5"
                y1="4.5"
                x2="9.5"
                y2="19.5"
                stroke="currentColor"
                strokeWidth="1.8"
              />
            </svg>
          </button>
          <img className="brand-mark" src={logo} alt="" />
          <span className="brand-name">Rayfin Fabricator</span>
        </div>
        <div className="titlebar-status">
          <span className="who">{auth.rayfin.user ?? 'Signed in'}</span>
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            <svg
              className="btn-ico"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </button>
          <button className="btn btn--sm btn--ghost" disabled={signingOut} onClick={signOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <div className={`workbench${sidebarCollapsed ? ' workbench--sidebar-collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="sidebar-actions">
            <button className="btn btn--primary btn--block" onClick={() => setShowNewProject(true)}>
              + New project
            </button>
            <button
              className="btn btn--ghost btn--block"
              disabled={opening}
              onClick={openExisting}
            >
              {opening ? 'Opening…' : 'Open existing…'}
            </button>
          </div>

          <div className="sidebar-section-title">Projects</div>
          <div className="project-list">
            {projects && projects.projects.length === 0 && (
              <div className="sidebar-empty">
                No projects yet.
                <br />
                Create one to get started.
              </div>
            )}
            {projects?.projects.map((p) => (
              <div
                key={p.id}
                className={`project-item${p.id === projects.activeProjectId ? ' project-item--active' : ''}${menuOpenId === p.id ? ' project-item--menu-open' : ''}`}
                onClick={() => {
                  if (renamingId !== p.id) void selectProject(p)
                }}
                role="button"
                tabIndex={0}
              >
                <div className="project-item-main">
                  {renamingId === p.id ? (
                    <input
                      className="project-rename-input"
                      value={renameValue}
                      autoFocus
                      spellCheck={false}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => void submitRename(p)}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') void submitRename(p)
                        else if (e.key === 'Escape') setRenamingId(null)
                      }}
                    />
                  ) : (
                    <>
                      <span className="project-item-name">
                        {p.name}
                        {p.missing && <span className="badge badge--warn">missing</span>}
                      </span>
                      <span className="project-item-path" title={p.path}>
                        {p.path}
                      </span>
                    </>
                  )}
                </div>
                <div className="project-item-actions">
                  <button
                    className="project-item-menu-btn"
                    title="Project actions"
                    aria-label="Project actions"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpenId((cur) => (cur === p.id ? null : p.id))
                    }}
                  >
                    ⋯
                  </button>
                  {menuOpenId === p.id && (
                    <div className="project-menu" onClick={(e) => e.stopPropagation()}>
                      <button className="project-menu-item" onClick={() => startRename(p)}>
                        Rename
                      </button>
                      <button
                        className="project-menu-item"
                        onClick={() => void removeFromList(p)}
                      >
                        Remove from list
                      </button>
                      <button
                        className="project-menu-item project-menu-item--danger"
                        onClick={() => {
                          setMenuOpenId(null)
                          setConfirmDelete(p)
                        }}
                      >
                        Delete from disk…
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {projects && (
            <div className="workspace-root">
              <span className="workspace-root-label">Workspace</span>
              <span className="workspace-root-path" title={projects.workspaceRoot}>
                {projects.workspaceRoot}
              </span>
              <button className="btn btn--xs btn--ghost" onClick={changeWorkspaceRoot}>
                Change…
              </button>
            </div>
          )}
        </aside>

        <main className="content">
          {notice && <div className="alert alert--error content-alert">{notice}</div>}
          {active ? (
            <>
              <div className="project-header">
                <div>
                  <h1 className="project-title">{active.name}</h1>
                  <span className="project-subpath">{active.path}</span>
                </div>
                <div className="project-tabs" role="tablist">
                  <button
                    className={`project-tab${viewMode === 'build' ? ' project-tab--active' : ''}`}
                    role="tab"
                    aria-selected={viewMode === 'build'}
                    onClick={() => setViewMode('build')}
                  >
                    Build
                  </button>
                  <button
                    className={`project-tab${viewMode === 'code' ? ' project-tab--active' : ''}`}
                    role="tab"
                    aria-selected={viewMode === 'code'}
                    onClick={() => setViewMode('code')}
                  >
                    Code
                  </button>
                  <button
                    className={`project-tab${viewMode === 'skills' ? ' project-tab--active' : ''}`}
                    role="tab"
                    aria-selected={viewMode === 'skills'}
                    onClick={() => setViewMode('skills')}
                  >
                    Skills
                  </button>
                </div>
                <div className="project-meta">
                  <DeploymentsControl
                    project={active}
                    running={Boolean(deploys[active.id]?.running)}
                    onCreate={(name, workspaceId) => {
                      setViewMode('build')
                      void (async () => {
                        try {
                          await window.api.deploy.setName(active.id, workspaceId, name)
                        } catch {
                          /* naming is best-effort; deploy anyway */
                        }
                        await runDeploy(active.id, workspaceId)
                      })()
                    }}
                    onRedeploy={() => {
                      setViewMode('build')
                      void runDeploy(active.id)
                    }}
                    onSwitch={(workspace, byId) => switchDeployment(active.id, workspace, byId)}
                    onChanged={() => void refreshProjects()}
                  />
                  {deploys[active.id]?.running ? (
                    <span className="chip chip--busy">deploying…</span>
                  ) : active.lastDeploy?.status === 'error' ? (
                    <span className="chip chip--err">deploy failed</span>
                  ) : active.lastDeploy?.url ? (
                    <span className="chip chip--ok">deployed</span>
                  ) : (
                    <span className="chip">not deployed</span>
                  )}
                </div>
              </div>
              {viewMode === 'code' ? (
                <Suspense fallback={<div className="code-empty">Loading editor…</div>}>
                  <CodeViewer
                    project={active}
                    refreshKey={gitRefresh}
                    onRequestDeploy={() => {
                      setViewMode('build')
                      void runDeploy(active.id)
                    }}
                  />
                </Suspense>
              ) : viewMode === 'skills' ? (
                <SkillsView
                  project={active}
                  onChanged={() => setGitRefresh((n) => n + 1)}
                />
              ) : (
                <div
                  className={`panes${focusPane ? ` panes--focus-${focusPane}` : ''}${
                    resizing ? ' panes--resizing' : ''
                  }`}
                  ref={panesRef}
                  style={
                    focusPane
                      ? undefined
                      : { gridTemplateColumns: `${chatFrac}fr 7px ${1 - chatFrac}fr` }
                  }
                >
                  <section className="pane pane--chat">
                    {sideThreadsOn && (
                      <ThreadBar
                        threads={threadViews}
                        activeThreadId={activeThreadId}
                        mainBusy={Boolean(busyThreads[chatKey(active.id, MAIN_THREAD_ID)])}
                        onSelect={(tid) =>
                          setActiveThread((m) => ({ ...m, [active.id]: tid }))
                        }
                        onNew={() => {
                          setThreadError(null)
                          setShowNewThread(true)
                        }}
                        onMergeNow={(tid) => void performMerge(active.id, tid)}
                        onKeepWorking={(tid) => cancelCountdown(active.id, tid)}
                        onDiscard={(tid) => {
                          const t = liveThreads.find((x) => x.id === tid)
                          if (t) setConfirmDiscard(t)
                        }}
                      />
                    )}
                    {panelThreadIds.map((tid) => {
                      const key = chatKey(active.id, tid)
                      const isActive = tid === activeThreadId
                      return (
                        <div
                          key={key}
                          className={`thread-host${isActive ? '' : ' thread-host--hidden'}`}
                        >
                          <ChatPanel
                            project={active}
                            threadId={tid}
                            messages={chats[key] ?? []}
                            onChange={(updater) => setMessagesFor(key, updater)}
                            onTurnComplete={(result) =>
                              void handleTurnComplete(active.id, tid, result)
                            }
                            onBusyChange={(busy) => handleBusyChange(active.id, tid, busy)}
                            attachments={shots[key] ?? []}
                            onRemoveAttachment={(path) => removeShot(key, path)}
                            onAttachmentsConsumed={() => clearShots(key)}
                            onClearHistory={() =>
                              void window.api.chat.saveHistory(active.id, [], tid)
                            }
                            onOptionsChanged={() => void refreshProjects()}
                            outbound={
                              chatOutbound?.projectId === active.id &&
                              chatOutbound.threadId === tid
                                ? chatOutbound
                                : null
                            }
                            focused={focusPane === 'chat'}
                            onToggleFocus={() =>
                              setFocusPane((f) => (f === 'chat' ? null : 'chat'))
                            }
                          />
                        </div>
                      )
                    })}
                  </section>
                  {!focusPane && (
                    <div
                      className="pane-divider"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize chat and preview"
                      title="Drag to resize · double-click to reset"
                      onMouseDown={onDividerDown}
                      onDoubleClick={resetSplit}
                    >
                      <span className="pane-divider-grip" />
                    </div>
                  )}
                  <section className="pane pane--preview">
                    <PreviewPane
                      project={active}
                      deploy={deploys[active.id]}
                      onDeploy={(workspace, force) => void runDeploy(active.id, workspace, force)}
                      onCapture={(shot) => addShot(chatKey(active.id, activeThreadId), shot)}
                      focused={focusPane === 'preview'}
                      onToggleFocus={() =>
                        setFocusPane((f) => (f === 'preview' ? null : 'preview'))
                      }
                    />
                  </section>
                  {resizing && (
                    <div
                      className="pane-resize-overlay"
                      onMouseMove={onResizeMove}
                      onMouseUp={endResize}
                      onMouseLeave={endResize}
                    />
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="content-empty">
              <img className="content-empty-mark" src={logo} alt="" />
              <h1>Welcome to Rayfin Fabricator</h1>
              <p>
                Create a new Rayfin app or open an existing project to start building with chat.
              </p>
              <div className="content-empty-actions">
                <button className="btn btn--primary" onClick={() => setShowNewProject(true)}>
                  + New project
                </button>
                <button className="btn btn--ghost" disabled={opening} onClick={openExisting}>
                  Open existing…
                </button>
              </div>
            </div>
          )}
        </main>
      </div>

      <footer className="statusbar">
        <span className="statusbar-item">Rayfin Fabricator v{versions?.app ?? '—'}</span>
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item">Copilot {auth.copilot.signedIn ? '✓' : '—'}</span>
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item">Fabric {auth.rayfin.signedIn ? '✓' : '—'}</span>
        {active && (
          <>
            <span className="statusbar-sep">·</span>
            <RayfinVersionControl info={rayfinVer} onUpdate={requestRayfinUpdate} />
          </>
        )}
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item">Electron {versions?.electron ?? '—'}</span>
      </footer>

      {showSettings && settings && (
        <SettingsModal
          settings={settings}
          versions={versions}
          onChange={onSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={async () => {
            setShowNewProject(false)
            await refreshProjects()
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete project?"
          danger
          busy={deleting}
          busyLabel={alsoDeleteFabric ? 'Deleting…' : 'Moving to trash…'}
          confirmLabel={alsoDeleteFabric ? 'Delete everywhere' : 'Move to trash'}
          onCancel={() => {
            if (!deleting) setConfirmDelete(null)
          }}
          onConfirm={() => void deleteFromDisk()}
          message={
            <>
              <p>
                <strong>{confirmDelete.name}</strong> and all its files will be moved to your
                system trash:
              </p>
              <p className="confirm-path">{confirmDelete.path}</p>
              {confirmDelete.lastDeploy?.url ? (
                <label className="confirm-check">
                  <input
                    type="checkbox"
                    checked={alsoDeleteFabric}
                    disabled={deleting}
                    onChange={(e) => setAlsoDeleteFabric(e.target.checked)}
                  />
                  <span>
                    Also delete the deployed app from Fabric
                    {confirmDelete.workspaceName ? (
                      <span className="confirm-check-hint">
                        {' '}
                        — permanently removes the app and its data in{' '}
                        <strong>{confirmDelete.workspaceName}</strong>
                      </span>
                    ) : (
                      <span className="confirm-check-hint"> — permanently removes the app and its data</span>
                    )}
                  </span>
                </label>
              ) : (
                <p>The deployed Fabric app is not affected — only the local code is removed.</p>
              )}
              {deleteError && <p className="confirm-error">{deleteError}</p>}
            </>
          }
        />
      )}

      {showNewThread && (
        <NewThreadModal
          busy={creatingThread}
          error={threadError}
          onCancel={() => {
            if (!creatingThread) {
              setShowNewThread(false)
              setThreadError(null)
            }
          }}
          onCreate={(firstTask) => void createSideThread(firstTask)}
        />
      )}

      {confirmDiscard && (
        <ConfirmModal
          title="Discard side thread?"
          danger
          busy={discarding}
          busyLabel="Discarding…"
          confirmLabel="Discard"
          onCancel={() => {
            if (!discarding) setConfirmDiscard(null)
          }}
          onConfirm={() => void discardThread()}
          message={
            <>
              <p>
                <strong>{confirmDiscard.name}</strong> and all of its unmerged work will be
                permanently removed.
              </p>
              <p>This can’t be undone. The main thread is not affected.</p>
            </>
          }
        />
      )}

      {signingOut && (
        <div
          className="signout-overlay"
          role="alertdialog"
          aria-busy="true"
          aria-label="Signing out"
        >
          <div className="signout-card">
            <div className="signout-mark">
              <img src={logo} alt="" />
              <span className="signout-ring" />
            </div>
            <div className="signout-text">
              <strong>Signing you out…</strong>
              <span>Ending your Fabric session securely</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
