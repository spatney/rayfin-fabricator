import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  type AdvisorFinding,
  type AppSettings,
  type AppVersions,
  type AuthStatus,
  type ChatAdvisorSummary,
  type ChatMessage,
  type ChatTurnResult,
  type DeployResult,
  type DevServerResult,
  type PortConflict,
  type ProjectsState,
  type RayfinVersionInfo,
  type StudioProject
} from '@shared/ipc'
import CreateProjectScreen from '../components/CreateProjectScreen'
import CloneFromGitHubScreen from '../components/CloneFromGitHubScreen'
import HomeView from '../components/HomeView'
import ManageProjectModal from '../components/ManageProjectModal'
import DeleteProjectModal from '../components/DeleteProjectModal'
import ConfirmModal from '../components/ConfirmModal'
import PortConflictModal, {
  hasPortChoice,
  type PortPromptContext
} from '../components/PortConflictModal'
import SettingsModal from '../components/SettingsModal'
import { applyUiScale, UI_SCALES } from '../theme'
import ChatPanel, { type UIChatMessage, type OutboundPrompt } from '../components/ChatPanel'
import { segmentsForStorage, segmentsFromStorage } from '../components/chat/storage'
import { planForStorage, planFromStorage } from '../chatPlan'
import { useChatEventStore } from '../chatEventStore'
import PreviewPane, { type DeployUiState, type PendingShot } from '../components/PreviewPane'
import DeploymentsControl from '../components/DeploymentsControl'
import GitControl from '../components/GitControl'
import TeamPublishControl from '../components/team/TeamPublishControl'
import TeamMapView from '../components/team/map/TeamMapView'
import { useTeamActivity } from '../components/team/useTeamActivity'
import { withActivity } from '../components/team/appRun'
import { useTeamWork } from '../components/team/useTeamWork'
import ProjectDependencyGuard from '../components/ProjectDependencyGuard'
import WorkspaceStatus from '../components/WorkspaceStatus'
import { SuppressPreview } from '../overlay'
import RayfinVersionControl from '../components/RayfinVersionControl'
import AdvisorView from '../components/advisor/AdvisorView'
import { AdvisorFixContext, type AdvisorFixLinks } from '../components/advisor/AdvisorFixSummary'
import { useAdvisor } from '../advisor/store'
import { fixOutcomes } from '../advisor/lifecycle'
import { fixPrompt, isVersionFinding } from '../advisor/prompts'
import BlueprintTab from '../components/blueprint/BlueprintTab'
import { writeCodeTab } from '../components/codeTab'
import { useToast } from '../toast'
import { authErrorMessage } from '../authErrors'
import { reportIssue as runReportIssue } from './reportIssue'
import { branchLabel } from './statusbar'
import { openDocs } from '../docsLinks'
import { HelpView } from '../components/help/HelpView'
import HelpUnavailableModal from '../components/help/HelpUnavailableModal'
import { setErrorProject } from '../errorReport'
import { accountFacts, workbenchFacts } from '../helpFacts'
import type { HelpAction, HelpIssueDraft } from '@shared/ipc'
import { Codicon } from '../components/icons'
import { FabricatorMark } from '../components/FabricatorMark'
import AccountMenu from '../components/AccountMenu'
import AccountsModal from '../components/AccountsModal'
import SetupAttentionBar from '../components/SetupAttentionBar'
import { tenantLabel } from '../accounts'
import type { SetupAttention } from '../startup'
import {
  BackToProject,
  ProjectSwitcher,
  ProjectTabs,
  type ProjectView
} from '../components/AppBar'
import { DeploymentQueue } from '../deploymentQueue'
import { useDesignSession, type DesignSurface } from '../design/useDesignSession'

// Monaco is heavy (~7 MB); only load the code viewer when the Code tab is opened.
const CodeViewer = lazy(() => import('../components/CodeViewer'))

/** Hydrate a persisted message into a live (non-pending) UI message. */
function toUi(m: ChatMessage): UIChatMessage {
  return {
    ...m,
    segments: segmentsFromStorage(m.segments),
    plan: planFromStorage(m.plan),
    // A standalone question left pending at persist time can't be answered on a
    // reloaded transcript (its turn/session is gone) — show it as interrupted.
    questions: m.questions?.map((q) =>
      q.state === 'pending' ? { ...q, state: 'interrupted' } : q
    ),
    pending: false
  }
}

/** Strip transient fields (turnId, pending) before persisting to disk. A turn
 *  that's still pending at persist time was interrupted (the app closed mid-turn);
 *  mark it so the next launch can offer to resume it. An already-interrupted turn
 *  keeps the marker until it's resumed (which removes the message). */
function toStored(messages: UIChatMessage[]): ChatMessage[] {
  return messages.map(
    ({
      id,
      role,
      text,
      tools,
      segments,
      error,
      attachments,
      attachmentThumbs,
      pending,
      interrupted,
      elapsedMs,
      createdAt,
      plan,
      questions,
      design,
      advisor,
      prompt
    }) => {
      const cutOff = (role === 'assistant' && pending) || interrupted
      return {
        id,
        role,
        text,
        // A turn cut off mid-command leaves a tool 'running'; settle it so the
        // reloaded transcript shows a finished (errored) tile, not a spinner.
        tools: cutOff
          ? tools.map((t) => (t.state === 'running' ? { ...t, state: 'error' } : t))
          : tools,
        segments: segmentsForStorage(segments),
        error,
        attachments,
        attachmentThumbs,
        elapsedMs,
        createdAt,
        plan: planForStorage(plan, Boolean(cutOff)),
        // Mirror plan-question handling: a question still pending when the turn
        // was cut off can never be answered, so persist it as interrupted.
        questions: cutOff
          ? questions?.map((q) => (q.state === 'pending' ? { ...q, state: 'interrupted' } : q))
          : questions,
        interrupted: cutOff ? true : undefined,
        design,
        advisor,
        prompt
      }
    }
  )
}

interface Props {
  auth: AuthStatus
  /** What the launch's background check found that setup would have caught. */
  attention?: SetupAttention | null
  /** Leave for the setup screen (to fix tools); it re-checks everything. */
  onReviewSetup: () => void
  /** Recheck live auth without leaving the workbench; reject when verification fails. */
  onAuthChanged: () => Promise<void> | void
  settings: AppSettings | null
  onSettingsChange: (patch: Partial<AppSettings>) => void
}

export default function Workbench({
  auth,
  attention = null,
  onReviewSetup,
  onAuthChanged,
  settings,
  onSettingsChange
}: Props): JSX.Element {
  const toast = useToast()
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [refreshingAuth, setRefreshingAuth] = useState(false)
  const [showAccounts, setShowAccounts] = useState(false)
  /** The attention bar was dismissed for these problems (it returns for new ones). */
  const [dismissedAttention, setDismissedAttention] = useState<string | null>(null)
  const [authRefreshTarget, setAuthRefreshTarget] = useState<{
    projectId: string
    name: string
    tenant?: string
  } | null>(null)
  const [authRefreshLog, setAuthRefreshLog] = useState<string[]>([])
  const [authRefreshError, setAuthRefreshError] = useState<string | null>(null)
  const authRefreshProjectRef = useRef<string | null>(null)
  const authActionRef = useRef(false)
  const mountedRef = useRef(false)
  const [showSettings, setShowSettings] = useState(false)
  /** The full-screen Help assistant, opened from the status bar or Ctrl/Cmd+J. */
  const [showHelp, setShowHelp] = useState(false)
  /** The static fallback shown when the assistant can't run. */
  const [showHelpOffline, setShowHelpOffline] = useState(false)
  /** Bumped to ask DeploymentsControl to open its share dialog (Help's share action). */
  const [shareRequest, setShareRequest] = useState(0)
  const [projects, setProjects] = useState<ProjectsState | null>(null)
  /** Fullscreen create/deploy flow: 'create' = new-project wizard, 'deploy' = first-deploy gate CTA. */
  const [createMode, setCreateMode] = useState<'create' | 'deploy' | null>(null)
  /** Fullscreen "Open existing… → Clone from GitHub" flow. */
  const [showClone, setShowClone] = useState(false)
  const [opening, setOpening] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** Lazy-mount the Advisor view on first visit, then keep it mounted (hidden when
   * inactive) so an in-flight review's live feed/timer/results survive tab switches. */
  const [advisorMounted, setAdvisorMounted] = useState(false)
  /** When true, the projects launcher (HomeView) is shown ON TOP of the still-active
   * project — the project stays mounted in the background so any in-flight chat turn
   * or Advisor review keeps running. Cleared when the launcher is dismissed or a
   * different project is opened. Going to the launcher never deactivates a project;
   * only opening a *different* one closes the current. */
  const [showHome, setShowHome] = useState(false)
  /** The project whose dependencies are prepared (reported by ProjectDependencyGuard),
   *  so the app bar's tabs and deploy control follow the same gate as the pane. */
  const [depsReadyId, setDepsReadyId] = useState<string | null>(null)
  const onDepsReadyChange = useCallback((projectId: string, ready: boolean): void => {
    setDepsReadyId((current) => (ready ? projectId : current === projectId ? null : current))
  }, [])
  /** Launcher project-management and local-trash confirmation state. */
  const [managingProject, setManagingProject] = useState<StudioProject | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<StudioProject | null>(null)
  /** Bumped whenever the working tree likely changed (deploy / chat turn). */
  const [gitRefresh, setGitRefresh] = useState(0)
  /** A user-initiated deploy paused by the "you have unpulled changes" warning. */
  const [confirmDeploy, setConfirmDeploy] = useState<{
    projectId: string
    workspace?: string
    behind: number
  } | null>(null)
  /** True while the deploy warning's "Get latest first" pull is running. */
  const [deployGuardBusy, setDeployGuardBusy] = useState(false)
  /** Friendly message when the warning's pull fails (keeps the modal open). */
  const [deployGuardError, setDeployGuardError] = useState<string | null>(null)
  /** Active project's local Rayfin (CLI + SDK) version + upgrade availability. */
  const [rayfinVer, setRayfinVer] = useState<RayfinVersionInfo | null>(null)
  /** A prompt queued for the chat composer (e.g. the Rayfin upgrade hand-off). */
  const [chatOutbound, setChatOutbound] = useState<(OutboundPrompt & { projectId: string }) | null>(
    null
  )
  /** Project content view: the build loop (chat + preview) or the code browser. */
  const [viewMode, setViewMode] = useState<ProjectView>('build')
  /** A pending request to open a specific file (and line) in the Code tab. */
  const [codeOpen, setCodeOpen] = useState<{ path: string; line?: number; nonce: number } | null>(null)
  /** A pending request to show a specific finding in the Advisor tab. */
  const [advisorOpen, setAdvisorOpen] = useState<{ id: string; nonce: number } | null>(null)
  /** Build-view focus: expand a single pane to fill the area (null = split). */
  const [focusPane, setFocusPane] = useState<'chat' | 'preview' | null>(null)
  /** Project-load overlay state, reported by PreviewPane, rendered centered over
   *  the whole build view (a project switch reloads chat + preview). */
  const [previewLoading, setPreviewLoading] = useState<{ name: string; fading: boolean } | null>(
    null
  )
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
  useChatEventStore(setChats)
  const [deploys, setDeploys] = useState<Record<string, DeployUiState>>({})
  /** Live local preview, retained between turns while auto-deploy is paused.
   *  Team previews also linger until the pipeline has deployed the saved change. */
  const [devServers, setDevServers] = useState<
    Record<
      string,
      {
        status: 'starting' | 'running'
        url?: string
        backend?: DevServerResult['backend']
        lingerSince?: number
      }
    >
  >({})
  const devServersRef = useRef(devServers)
  devServersRef.current = devServers
  /** Live local preview: a port conflict waiting on the user's choice. */
  const [portPrompt, setPortPrompt] = useState<{
    projectId: string
    context: PortPromptContext
    conflict: PortConflict
    busy: 'register' | 'stop' | null
    error: string | null
    log: string[]
  } | null>(null)
  const portPromptRef = useRef(portPrompt)
  portPromptRef.current = portPrompt
  /** Resolves the open port prompt with the chosen port, or null to skip. */
  const portResolveRef = useRef<((port: number | null) => void) | null>(null)
  /** Projects whose running turn goes without a live preview (skipped or unavailable). */
  const previewSkippedRef = useRef<Set<string>>(new Set())
  /** Region screenshots staged per project for the next chat message. */
  const [shots, setShots] = useState<Record<string, PendingShot[]>>({})
  /** Composer drafts staged per project — a typed-but-unsent prompt persists here
   * so it survives ChatPanel unmounting when switching tabs (Build ⇄ Code). */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** The project whose `rayfin up` is currently streaming (routes deploy:run logs). */
  const deployingIdRef = useRef<string | null>(null)
  /** Latest chats snapshot, for reading inside async callbacks / save timers. */
  const chatsRef = useRef(chats)
  chatsRef.current = chats
  /** Last transcript reference persisted per project. The debounce below compares
   *  against this so it only rewrites the (up to 1000-message) file of a project
   *  whose messages actually changed — not every hydrated project on each edit. */
  const savedChatsRef = useRef<Record<string, UIChatMessage[]>>({})
  /** Latest active project id, for guarding async (per-project) responses. */
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = projects?.activeProjectId ?? null
  /** Projects whose persisted history has been loaded this session (keyed by projectId). */
  const hydratedRef = useRef<Set<string>>(new Set())
  /** Latest projects snapshot, for reading inside async callbacks. */
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  /** The currently active project (or null). Declared early — effects depend on it. */
  const active = projects?.projects.find((p) => p.id === projects.activeProjectId) ?? null
  /** The Build chat for the active project is mid-turn. */
  const activeChatBusy = Boolean(
    active && (chats[active.id] ?? []).some((m) => m.role === 'assistant' && m.pending)
  )
  /** Advisor state for the active project — owned here so the tab badge stays current. */
  const advisor = useAdvisor(active, {
    refreshKey: gitRefresh,
    versions: rayfinVer,
    chatBusy: activeChatBusy
  })
  /** The preview surface Design can run on, reported by the PreviewPane. */
  const [designSurface, setDesignSurface] = useState<DesignSurface | null>(null)
  /** Design mode ("visual chat") for the active project. The queue is shared by
   *  the preview (where changes are made) and the chat composer (where they're sent). */
  const design = useDesignSession(active?.id ?? null, viewMode === 'build' ? designSurface : null)

  const onDevServerError = useCallback((reason: unknown): void => {
    toast.error(authErrorMessage(reason, 'The local preview could not be updated.'), {
      title: 'Local preview'
    })
  }, [toast])

  /** Stop a project's live local preview (if any) and forget it. */
  const stopDevServer = useCallback(
    (projectId: string): void => {
      if (!devServersRef.current[projectId]) return
      setDevServers((all) => {
        const next = { ...all }
        delete next[projectId]
        return next
      })
      void window.api.dev.stop(projectId).catch(onDevServerError)
    },
    [onDevServerError]
  )

  const deployQueueRef = useRef(new DeploymentQueue())
  const autoDeploy = settings?.autoDeploy !== false
  const autoDeployRef = useRef(autoDeploy)
  autoDeployRef.current = autoDeploy
  useEffect(() => {
    if (!autoDeploy) {
      deployQueueRef.current.cancelPending(
        'Automatic deployments are paused. Deploy manually when ready.',
        (request) => Boolean(request.automatic)
      )
      setDevServers((all) =>
        Object.fromEntries(Object.entries(all).map(([id, server]) => [
          id, { ...server, lingerSince: undefined }
        ]))
      )
    }
  }, [autoDeploy])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      deployQueueRef.current.cancelPending('The workbench closed before this deployment started.')
      for (const projectId of Object.keys(devServersRef.current)) {
        void window.api.dev.stop(projectId).catch(onDevServerError)
      }
    }
  }, [onDevServerError])
  /** Project ids with a deployment reconcile in flight (dedupes overlapping calls). */
  const reconcilingRef = useRef<Set<string>>(new Set())
  /** Project ids currently being reconciled — drives a brief "checking" affordance. */
  const [reconciling, setReconciling] = useState<Set<string>>(new Set())

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

  const setDraftFor = useCallback((key: string, value: string): void => {
    setDrafts((all) => ({ ...all, [key]: value }))
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

  /** Team workspaces (experimental): the backend hides them while this is off. */
  const teamEnabled = Boolean(settings?.experiments?.teamWorkspaces)
  /** A team workspace preselected for New project ("New app" in a workspace). */
  const [newAppTeamId, setNewAppTeamId] = useState<string | null>(null)
  const sendTeamPrompt = useCallback((projectId: string, display: string, prompt: string): void => {
    setViewMode('build')
    setChatOutbound({ id: `team-${Date.now()}`, projectId, display, prompt })
  }, [])
  const teamWork = useTeamWork(active, {
    enabled: teamEnabled,
    toast,
    refreshProjects,
    sendToChat: sendTeamPrompt
  })
  const teamWorkRef = useRef(teamWork)
  teamWorkRef.current = teamWork
  const isTeamProject = useCallback(
    (projectId: string): boolean =>
      Boolean(projectsRef.current?.projects.find((p) => p.id === projectId)?.team),
    []
  )
  const deployTeamPreview = useCallback(async (projectId: string, message: string): Promise<void> => {
    try {
      await teamWorkRef.current.afterTurn(projectId, message)
    } catch (reason) {
      toast.error(authErrorMessage(reason, 'Could not refresh the team app after saving.'), {
        title: 'Team refresh failed'
      })
    }
    setDevServers((all) =>
      all[projectId] ? { ...all, [projectId]: { ...all[projectId], lingerSince: Date.now() } } : all
    )
  }, [toast])
  const activeTeamWorkspace = active?.team
    ? projects?.teamWorkspaces?.find((w) => w.id === active.team?.workspaceId)
    : undefined
  /** The workspace overview, when open (over Home or the project it was opened from). */
  const [teamMap, setTeamMap] = useState<{
    workspaceId: string
    folder?: string
    from: 'home' | 'project'
    /** Open on the workspace's members and settings. */
    manage?: boolean
  } | null>(null)
  const mapWorkspace = teamMap ? projects?.teamWorkspaces?.find((w) => w.id === teamMap.workspaceId) : undefined
  // What the active team app's pipeline is doing, for the app bar's overview button.
  const teamRuns = useTeamActivity(
    teamEnabled && active?.team && !showHome && !teamMap ? active.team.workspaceId : null
  )
  const openTeamMap = useCallback(
    (workspaceId: string, from: 'home' | 'project', folder?: string, manage?: boolean): void => {
      setTeamMap({ workspaceId, folder, from, manage })
    },
    []
  )
  // The overview closes when its workspace goes away (left, deleted, or the experiment turned off).
  useEffect(() => {
    if (teamMap && projects && !mapWorkspace) setTeamMap(null)
  }, [teamMap, projects, mapWorkspace])

  // A team app's local preview stays up after its turn while the change is
  // saved and the pipeline deploys it. It ends once your preview has that
  // change (or the deploy finished with an error), when there's nothing to
  // deploy, when you leave the app, or after 20 minutes.
  useEffect(() => {
    for (const [projectId, server] of Object.entries(devServers)) {
      if (
        projectId !== active?.id &&
        !(chatsRef.current[projectId] ?? []).some((m) => m.role === 'assistant' && m.pending)
      ) {
        stopDevServer(projectId)
        continue
      }
      if (!server.lingerSince) continue
      const status = teamWork.status(projectId)
      const head = status?.pr?.headSha
      const running = Boolean(status?.run && status.run.status !== 'completed')
      const deploying = ['in_progress', 'queued', 'pending'].includes(status?.preview?.state ?? '')
      const caughtUp = Boolean(head && status?.preview?.sha === head && !deploying)
      const nothingToDeploy = Boolean(status && !status.pr && status.unpublished === 0)
      const settled = Boolean(status && !teamWork.syncing(projectId) && !status.dirty && !running) && (caughtUp || nothingToDeploy)
      const stale = Date.now() - server.lingerSince > 20 * 60_000
      if (projectId !== active?.id || settled || stale) stopDevServer(projectId)
    }
  }, [devServers, teamWork, active?.id, stopDevServer, autoDeploy])

  // Showing or hiding team workspaces changes which projects the backend lists.
  useEffect(() => {
    void refreshProjects()
  }, [teamEnabled, refreshProjects])

  /** Leaving a team app with unpublished changes: they're safe, but not live. */
  const remindUnpublished = useCallback((): void => {
    if (!active?.team) return
    const status = teamWorkRef.current.status(active.id)
    if (status && status.unpublished > 0) {
      toast.info(
        `${active.name} has unpublished changes. They're saved on GitHub; publish them when you're ready.`,
        { title: 'Not published yet' }
      )
    }
  }, [active, toast])

  const refreshAuthWithFeedback = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return
    try {
      await onAuthChanged()
    } catch (reason) {
      if (!mountedRef.current) return
      toast.error(authErrorMessage(reason, 'Could not verify sign-in. Please retry.'), {
        title: 'Sign-in check failed'
      })
    }
  }, [onAuthChanged, toast])

  /** Re-read the active project's local Rayfin versions (after deploys / chat turns). */
  const refreshRayfinVer = useCallback(async (projectId: string): Promise<void> => {
    const info = await window.api.rayfin.versions(projectId)
    // Guard against a stale response after the user switches projects.
    if (activeIdRef.current === projectId) setRayfinVer(info)
  }, [])

  // Keep sign-in/reset diagnostics alongside the failed deploy, including late log events.
  useEffect(() => {
    const off = window.api.onProcLog((event) => {
      if (event.channel === 'dev:register') {
        setPortPrompt((prompt) => prompt && { ...prompt, log: [...prompt.log, event.data] })
        return
      }
      const refreshing = event.channel === 'refresh:rayfin'
      if (refreshing) setAuthRefreshLog((log) => [...log, event.data])
      if (!refreshing && event.channel !== 'deploy:run' && event.channel !== 'login:rayfin') return
      const id = refreshing ? authRefreshProjectRef.current : deployingIdRef.current
      if (!id) return
      setDeploys((all) => {
        const cur = all[id] ?? { running: !refreshing, log: [] }
        return { ...all, [id]: { ...cur, log: [...cur.log, event.data] } }
      })
    })
    return off
  }, [])

  // A local preview that stopped serving and couldn't be started again: drop it,
  // so the preview shows the deployed app (or its placeholder), and say why.
  // (When it's started again, Fabricator reloads the preview itself.)
  useEffect(
    () =>
      window.api.dev.onState((event) => {
        if (event.state !== 'stopped' || !devServersRef.current[event.projectId]) return
        setDevServers((all) => {
          if (!all[event.projectId]) return all
          const next = { ...all }
          delete next[event.projectId]
          return next
        })
        toast.error(event.error ?? 'The local preview stopped.', { title: 'Local preview stopped' })
      }),
    [toast]
  )

  // Reconcile the active project's recorded deployment with on-disk reality
  // (`rayfin/.deployments.json`) whenever it changes. Opening an already-deployed
  // app then reflects its deployment (preview + chip) without forcing a redeploy;
  // disk is treated as the source of truth and re-synced on each open/select.
  useEffect(() => {
    const id = active?.id
    if (!id) return
    // A streaming deploy will hydrate the store itself — don't race it.
    if (deployingIdRef.current === id) return
    // Dedupe overlapping reconciles for the same project.
    if (reconcilingRef.current.has(id)) return
    reconcilingRef.current.add(id)
    setReconciling((s) => new Set(s).add(id))
    void (async () => {
      try {
        const next = await window.api.deploy.reconcile(id)
        // Apply only if the user hasn't switched projects meanwhile.
        if (activeIdRef.current === id) setProjects(next)
      } catch {
        /* best-effort: leave recorded state as-is on any failure */
      } finally {
        reconcilingRef.current.delete(id)
        setReconciling((s) => {
          const n = new Set(s)
          n.delete(id)
          return n
        })
      }
    })()
  }, [active?.id])

  const executeDeploy = useCallback(
    async (projectId: string, workspace?: string): Promise<DeployResult> => {
      if (authActionRef.current) {
        const error = 'Wait for Fabric authentication to finish, then use Redeploy.'
        toast.error(error, { title: 'Deployment paused' })
        return { ok: false, outcome: 'error', error }
      }
      deployingIdRef.current = projectId
      stopDevServer(projectId)
      setDeploys((all) => ({ ...all, [projectId]: { running: true, log: [] } }))
      let result: DeployResult = { ok: false, outcome: 'error' }
      const request = (): Promise<DeployResult> => window.api.deploy.run(projectId, workspace)
      try {
        try {
          result = await request()
          if (!mountedRef.current) return result
          // Retry once, only after sign-in and its app-level verification succeed.
          if (!result.ok && result.outcome === 'not-signed-in') {
            const login = await window.api.auth.loginRayfin(undefined, projectId)
            if (!mountedRef.current) return result
            if (!login.ok) {
              result = {
                ...result,
                error: authErrorMessage(
                  login.error,
                  'Fabric sign-in did not complete. Please try again.'
                )
              }
            } else {
              await onAuthChanged()
              if (!mountedRef.current) return result
              result = await request()
              if (!mountedRef.current) return result
            }
          }
        } catch (reason) {
          if (!mountedRef.current) return result
          result = {
            ok: false,
            outcome: result.outcome,
            error: authErrorMessage(reason, 'The deployment did not complete. Please try again.')
          }
        }
        if (
          !result.ok &&
          (result.outcome === 'not-signed-in' || result.outcome === 'auth-cache-error')
        ) {
          // Don't open more sign-in flows for deploys queued behind a failed login.
          deployQueueRef.current.cancelPending('Sign in to Fabric before retrying this deployment.')
        }
        setDeploys((all) => {
          const cur = all[projectId] ?? { running: false, log: [] }
          return { ...all, [projectId]: { ...cur, running: false, result } }
        })
        // Deploys are long and the user may be on another tab, so still surface
        // failures wherever they are. Success needs no toast — it's already
        // reflected in the preview pane and deploy status.
        if (!result.ok) {
          toast.error(result.error ?? 'The deployment did not complete.', {
            title: 'Deploy failed'
          })
        }
        try {
          await refreshProjects()
        } catch (reason) {
          toast.error(authErrorMessage(reason, 'Could not refresh the project after deploying.'), {
            title: 'Project refresh failed'
          })
        }
        // Failures can reveal an expired session; never leave the app bar's account stale.
        await refreshAuthWithFeedback()
        return result
      } finally {
        deployingIdRef.current = null
        setGitRefresh((n) => n + 1)
        if (mountedRef.current) void refreshRayfinVer(projectId)
      }
    },
    [refreshProjects, refreshRayfinVer, toast, onAuthChanged, refreshAuthWithFeedback, stopDevServer]
  )
  const runDeploy = useCallback(
    (projectId: string, workspace?: string, automatic = false): Promise<DeployResult> =>
      deployQueueRef.current.enqueue({ projectId, workspace, automatic }, executeDeploy),
    [executeDeploy]
  )

  /**
   * User-initiated deploy funnel: warn first when the remote has changes the user
   * hasn't pulled (a fast, non-fetching divergence check), otherwise deploy straight
   * away. Automatic deploys (post-turn) call runDeploy directly and skip this guard
   * so they never stall on a modal.
   */
  const requestUserDeploy = useCallback(
    async (projectId: string, workspace?: string): Promise<void> => {
      // Team apps are deployed by their pipeline: save to the working branch instead.
      if (isTeamProject(projectId)) {
        void teamWorkRef.current.afterTurn(projectId, 'Restore an earlier version')
        return
      }
      try {
        const div = await window.api.projects.git.divergence(projectId)
        if (div.behind > 0) {
          setDeployGuardError(null)
          setConfirmDeploy({ projectId, workspace, behind: div.behind })
          return
        }
      } catch {
        /* divergence is best-effort — fall through and deploy */
      }
      void runDeploy(projectId, workspace)
    },
    [runDeploy, isTeamProject]
  )

  // Switch the active Fabric deployment, then reflect the new URL/status.
  const switchDeployment = useCallback(
    async (projectId: string, workspace: string, byId: boolean): Promise<DeployResult> => {
      const result = await window.api.deploy.switch(projectId, workspace, byId)
      if (!result.ok) {
        if (result.outcome === 'not-signed-in') await refreshAuthWithFeedback()
        return result
      }
      setDeploys((all) => {
        const previous = all[projectId]
        return previous
          ? { ...all, [projectId]: { ...previous, result: undefined } }
          : all
      })
      await refreshProjects()
      setGitRefresh((n) => n + 1)
      return result
    },
    [refreshProjects, refreshAuthWithFeedback]
  )

  /** Close the port prompt, handing the chosen port (or null) to its waiter. */
  const settlePortPrompt = useCallback((port: number | null): void => {
    const resolve = portResolveRef.current
    portResolveRef.current = null
    setPortPrompt(null)
    resolve?.(port)
  }, [])

  // Settle a prompt left open when the workbench unmounts, so no turn waits forever.
  useEffect(() => () => portResolveRef.current?.(null), [])

  /**
   * Pick the live preview's port. A free port that sign-in accepts is used
   * straight away; when every one is taken the user chooses (register another
   * port, or stop the process holding one). Resolves null to go without.
   */
  const resolveLocalPort = useCallback(
    async (projectId: string, context: PortPromptContext): Promise<number | null> => {
      const plan = await window.api.dev.plan(projectId)
      if (plan.port !== undefined) return plan.port
      const conflict = plan.conflict
      if (!conflict) return null
      if (!hasPortChoice(conflict, context, !autoDeployRef.current)) {
        toast.info(
          `localhost:${conflict.port} is in use, so this turn shows your deployed app. Fabricator will ask again with your next message.`,
          { title: 'Live preview skipped' }
        )
        return null
      }
      portResolveRef.current?.(null)
      return new Promise<number | null>((resolve) => {
        portResolveRef.current = resolve
        setPortPrompt({ projectId, context, conflict, busy: null, error: null, log: [] })
      })
    },
    [toast]
  )

  /** "Use port N": use locally when paused; otherwise register it before starting. */
  const registerPromptPort = useCallback(async (): Promise<void> => {
    const prompt = portPromptRef.current
    const port = prompt?.conflict.suggestedPort
    if (!prompt || port === undefined || prompt.busy) return
    if (!autoDeployRef.current) {
      settlePortPrompt(port)
      return
    }
    setPortPrompt((p) => p && { ...p, busy: 'register', error: null, log: [] })
    const register = (): Promise<DeployResult> => window.api.dev.registerPort(prompt.projectId, port)
    let result: DeployResult
    try {
      result = await register()
      // Retry once, only after sign-in and its app-level verification succeed.
      if (!result.ok && result.outcome === 'not-signed-in') {
        const login = await window.api.auth.loginRayfin(undefined, prompt.projectId)
        if (login.ok) {
          await onAuthChanged()
          result = await register()
        } else {
          result = {
            ...result,
            error: authErrorMessage(login.error, 'Fabric sign-in did not complete. Please try again.')
          }
        }
      }
    } catch (reason) {
      result = { ok: false, outcome: 'error', error: authErrorMessage(reason, 'The port could not be registered.') }
    }
    if (!mountedRef.current) return
    setGitRefresh((n) => n + 1)
    if (!result.ok) {
      setPortPrompt((p) => p && { ...p, busy: null, error: result.error ?? 'The port could not be registered.' })
      if (result.outcome === 'not-signed-in' || result.outcome === 'auth-cache-error') {
        void refreshAuthWithFeedback()
      }
      return
    }
    settlePortPrompt(port)
  }, [onAuthChanged, refreshAuthWithFeedback, settlePortPrompt])

  /** "Stop …": end the process holding the preferred port, then use that port. */
  const stopPromptOccupant = useCallback(async (): Promise<void> => {
    const prompt = portPromptRef.current
    const pid = prompt?.conflict.occupant?.pid
    if (!prompt || pid === undefined || prompt.busy) return
    setPortPrompt((p) => p && { ...p, busy: 'stop', error: null })
    try {
      await window.api.dev.freePort(prompt.conflict.port, pid)
    } catch (reason) {
      if (!mountedRef.current) return
      setPortPrompt((p) => p && { ...p, busy: null, error: authErrorMessage(reason, 'That process could not be stopped.') })
      return
    }
    settlePortPrompt(prompt.conflict.port)
  }, [settlePortPrompt])

  // Kick off the live local preview when a turn starts: run the
  // project's Vite dev server so edits show live at localhost for the turn's
  // duration. No-op when the project has no locally installed Vite. A
  // fresh turn waits for this (ChatPanel awaits `onTurnStart`) so a port
  // conflict is settled — and any new port pushed — before Copilot starts;
  // `plan` runs mid-turn, when nothing can be pushed.
  const handleTurnStart = useCallback(
    async (projectId: string, context: PortPromptContext = 'turn'): Promise<void> => {
      if (deployingIdRef.current === projectId) return // a deploy owns the surface
      const existing = devServersRef.current[projectId]
      if (existing) {
        // Already starting / running; a team app's lingering preview carries on.
        if (existing.lingerSince) {
          setDevServers((all) =>
            all[projectId] ? { ...all, [projectId]: { ...all[projectId], lingerSince: undefined } } : all
          )
        }
        return
      }
      if (previewSkippedRef.current.has(projectId)) return // skipped for this turn
      let port: number | null
      try {
        port = await resolveLocalPort(projectId, context)
      } catch (reason) {
        onDevServerError(reason)
        return
      }
      if (port === null) {
        previewSkippedRef.current.add(projectId)
        return
      }
      if (!mountedRef.current || devServersRef.current[projectId]) return
      // A mid-turn prompt may outlast the turn; don't start a server it can't stop.
      const turnRunning = (chatsRef.current[projectId] ?? []).some((m) => m.role === 'assistant' && m.pending)
      if (context === 'plan' && !turnRunning) return
      setDevServers((all) => ({ ...all, [projectId]: { status: 'starting' } }))
      void (async () => {
        let res: DevServerResult
        try {
          res = await window.api.dev.start(projectId, port)
        } catch (err) {
          res = {
            ok: false,
            outcome: 'error',
            error: err instanceof Error ? err.message : String(err)
          }
        }
        if (!res.ok && res.outcome !== 'unsupported') {
          toast.error(res.error ?? 'The local Vite server could not be started.', {
            title: 'Local preview failed'
          })
        }
        setDevServers((all) => {
          // The turn already ended (entry cleared in handleTurnComplete) — don't
          // resurrect a preview whose server was just stopped.
          if (!all[projectId]) return all
          if (res.ok && res.url) {
            return { ...all, [projectId]: { status: 'running', url: res.url, backend: res.backend } }
          }
          const next = { ...all }
          delete next[projectId]
          return next
        })
      })()
    },
    [toast, resolveLocalPort, onDevServerError]
  )

  // After a chat turn, persist the transcript and auto-deploy when the agent left
  // undeployed changes.
  const handleTurnComplete = useCallback(
    async (projectId: string, result: ChatTurnResult): Promise<void> => {
      previewSkippedRef.current.delete(projectId)
      const prompt = portPromptRef.current
      if (prompt?.projectId === projectId && prompt.context === 'plan' && !prompt.busy) settlePortPrompt(null)
      if (autoDeployRef.current && devServersRef.current[projectId] && !(result.ok && isTeamProject(projectId))) {
        // Stop the live local preview first, so the surface returns to the
        // deployed app and the after-turn deploy can take the stage (DeployStage).
        // (A team app keeps its preview while its change is saved and deployed.)
        stopDevServer(projectId)
      }
      try {
        await refreshProjects()
      } catch (reason) {
        toast.error(authErrorMessage(reason, 'Could not refresh the project after coding.'), {
          title: 'Project refresh failed'
        })
      }
      setGitRefresh((n) => n + 1)
      void window.api.chat
        .saveHistory(projectId, toStored(chatsRef.current[projectId] ?? []))
        .catch((reason) => {
          toast.error(authErrorMessage(reason, 'Could not save the conversation.'), {
            title: 'Chat history save failed'
          })
        })
      // The agent may have changed the Rayfin deps (e.g. an upgrade) — re-check.
      void refreshRayfinVer(projectId).catch((reason) => {
        toast.error(authErrorMessage(reason, 'Could not refresh the Rayfin version.'), {
          title: 'Version check failed'
        })
      })
      if (!result.ok || !mountedRef.current) return
      if (!autoDeployRef.current) {
        if (isTeamProject(projectId)) void teamWorkRef.current.refresh(projectId, false)
        return
      }
      // Team apps: save the turn to the working branch; the pipeline deploys the preview.
      if (isTeamProject(projectId)) {
        const lastUser = [...(chatsRef.current[projectId] ?? [])].reverse().find((m) => m.role === 'user')
        void deployTeamPreview(projectId, lastUser?.text ?? '')
        return
      }
      try {
        const changed = await window.api.deploy.hasChanges(projectId)
        if (changed && mountedRef.current && autoDeployRef.current) void runDeploy(projectId, undefined, true)
      } catch (reason) {
        if (!mountedRef.current) return
        toast.error(
          `${authErrorMessage(reason, 'Could not check for undeployed changes.')} Use Redeploy to publish your changes.`,
          { title: 'Auto-deploy check failed' }
        )
      }
    },
    [refreshProjects, refreshRayfinVer, runDeploy, stopDevServer, toast, settlePortPrompt, isTeamProject, deployTeamPreview]
  )

  // Hydrate persisted chat history for the active project.
  useEffect(() => {
    if (!active) return
    const id = active.id
    if (hydratedRef.current.has(id)) return
    hydratedRef.current.add(id)
    void window.api.chat.history(id).then((stored) => {
      setChats((all) => {
        if (all[id] !== undefined) return all
        const hydrated = stored.map(toUi)
        // Seed the saved snapshot so a hydrated-but-untouched transcript isn't
        // immediately written straight back to disk by the debounce below.
        savedChatsRef.current[id] = hydrated
        return { ...all, [id]: hydrated }
      })
    })
  }, [active?.id])

  // Hand a Rayfin upgrade to the Copilot agent: build a precise "from X → to Y"
  // prompt and queue it into the chat (the agent edits package.json + installs).
  // Returns false when there's nothing to upgrade.
  const requestRayfinUpdate = useCallback((info: RayfinVersionInfo): boolean => {
    const id = activeIdRef.current
    if (!id) return false
    // Connector packages version with the CLI; npm's `latest` tag for them lags.
    const ups = info.packages.filter(
      (p) => p.upgradable && p.installed && p.latest && !/^@microsoft\/rayfin-connector/.test(p.name)
    )
    if (ups.length === 0) return false
    const lines = ups.map((p) => `- ${p.name}: ${p.installed} → ${p.latest}`).join('\n')
    const to = info.latest ?? ups[0].latest
    const prompt =
      "Please upgrade this app's Rayfin packages to the latest version.\n\n" +
      'Set these exact versions in package.json, then run `npm install`:\n' +
      `${lines}\n\n` +
      'Keep every Rayfin SDK package (`@microsoft/rayfin-core`, `-client`, `-data`, `-auth`, ' +
      '`-auth-provider-fabric`, `-lib`, `-functions`, `-local-dev`) on the same version — they ship in lockstep. ' +
      'If the app uses Rayfin connector packages (`@microsoft/rayfin-connector*`), pin them to the ' +
      "new CLI version exactly (they ship in lockstep with the CLI; npm's `latest` tag lags).\n\n" +
      'After installing, check `node_modules/@microsoft/rayfin-guide/assets/docs/deprecations.md` ' +
      'and `known-limitations.md` for changes between these versions and update the app code so it ' +
      'still builds and runs. Do not run `rayfin up` or deploy — Rayfin Fabricator redeploys automatically.'
    setViewMode('build')
    setFocusPane(null)
    setChatOutbound({
      id: `rayfin-up-${Date.now()}`,
      projectId: id,
      display: `Update Rayfin to ${to}`,
      prompt
    })
    return true
  }, [])

  // Hand Advisor findings to the Build chat so Copilot can fix them in one task.
  // Rayfin version findings on their own go through the upgrade hand-off.
  const handOffFindings = advisor.handOff
  const fixFindings = useCallback(
    (findings: AdvisorFinding[]): void => {
      const id = activeIdRef.current
      if (!id || findings.length === 0) return
      if (findings.every(isVersionFinding) && rayfinVer && requestRayfinUpdate(rayfinVer)) {
        handOffFindings(findings)
        return
      }
      const { display, prompt, summary } = fixPrompt(findings)
      setViewMode('build')
      setFocusPane(null)
      setChatOutbound({ id: `advisor-fix-${Date.now()}`, projectId: id, display, prompt, advisor: summary })
      handOffFindings(findings)
    },
    [handOffFindings, rayfinVer, requestRayfinUpdate]
  )
  // A fix card's row opens its finding in the Advisor.
  const showAdvisorFinding = useCallback((findingId: string): void => {
    setAdvisorOpen({ id: findingId, nonce: Date.now() })
    setViewMode('advisor')
  }, [])
  // Fix cards in the Build chat follow their findings through the Advisor live.
  const advisorFixLinks = useMemo<AdvisorFixLinks>(() => {
    const outcomes = fixOutcomes(advisor.derived)
    return { outcome: (findingId) => outcomes.get(findingId), show: showAdvisorFinding }
  }, [advisor.derived, showAdvisorFinding])
  // Re-running a fix hands its still-open findings to Copilot again.
  const rerunAdvisorFix = (summary: ChatAdvisorSummary): void => {
    const open = new Set(advisor.derived.open.map((item) => item.finding.id))
    const again = summary.fixes.filter((fix) => open.has(fix.id))
    if (again.length) handOffFindings(again)
  }
  // Hand a slice of git history (a commit, a file's change, or a comparison) to
  // the Build chat so Copilot can act on it. Mirrors `fixWithCopilot`'s handoff,
  // but stages the context in the composer so the user adds their own request.
  const sendHistoryToChat = useCallback((display: string, prompt: string): void => {
    const id = activeIdRef.current
    if (!id) return
    setViewMode('build')
    setFocusPane(null)
    setChatOutbound({
      id: `history-${Date.now()}`,
      projectId: id,
      display,
      prompt,
      stage: true
    })
  }, [])

  // Open a project file (optionally at a line) in the Code tab.
  const openFileInCode = useCallback((path: string, line?: number): void => {
    setCodeOpen({ path, line, nonce: Date.now() })
    setViewMode('code')
  }, [])

  // Open the Code tab on its Secrets view (from the Blueprint's Secrets part).
  const openSecretsInCode = useCallback((): void => {
    const id = activeIdRef.current
    if (!id) return
    writeCodeTab(id, 'secrets')
    // A pending file request would land the Code tab in Files instead.
    setCodeOpen(null)
    setViewMode('code')
  }, [])

  // Open a file referenced by an @-mention chip in chat (in the Code tab).
  const openMention = useCallback(
    (ref: string): void => {
      openFileInCode(ref.replace(/^@/, '').trim())
    },
    [openFileInCode]
  )

  // Hand a Model-tab prompt to the Build chat. `stage` drops the text in the
  // composer (for open-ended asks) instead of sending it immediately.
  const sendModelToChat = useCallback((display: string, prompt: string, stage = false): void => {
    const id = activeIdRef.current
    if (!id) return
    setViewMode('build')
    setFocusPane(null)
    setChatOutbound({
      id: `model-${Date.now()}`,
      projectId: id,
      display,
      prompt,
      stage
    })
  }, [])
  useEffect(() => {
    const id = projects?.activeProjectId
    if (!id) {
      setRayfinVer(null)
      return
    }
    setRayfinVer(null)
    void refreshRayfinVer(id)
  }, [projects?.activeProjectId, refreshRayfinVer])

  useEffect(() => {
    if (!active?.id) return
    void refreshAuthWithFeedback()
  }, [active?.id, refreshAuthWithFeedback])

  // Attribute recorded errors to the project the user is working in, so Help
  // can answer "why did *my* deploy fail?" without every call site passing an id.
  useEffect(() => {
    setErrorProject(active?.id)
  }, [active?.id])

  // Ctrl+J (Cmd+J on macOS) toggles Help from anywhere. Escape closing it is
  // handled by the overlay itself, which also needs to stop a running answer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const chord = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
      if (!chord || event.key.toLowerCase() !== 'j' || event.defaultPrevented) return
      event.preventDefault()
      toggleHelpRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Reflect the active project in the OS window title so users running one
  // instance per project can tell them apart in the taskbar / Alt-Tab. The
  // project name leads so it stays visible when the title is truncated.
  useEffect(() => {
    const base = 'Fabricator'
    const title = active?.name ? `${active.name} — ${base}` : base
    void getCurrentWindow().setTitle(title)
  }, [active?.name])

  // Debounce-persist chat transcripts whenever they change (after streaming settles).
  // Only projects whose message array changed reference (i.e. actually mutated) are
  // written — untouched hydrated projects keep the same reference and are skipped.
  useEffect(() => {
    const t = setTimeout(() => {
      for (const projectId of hydratedRef.current) {
        const msgs = chatsRef.current[projectId]
        if (!msgs) continue
        if (savedChatsRef.current[projectId] === msgs) continue
        savedChatsRef.current[projectId] = msgs
        void window.api.chat.saveHistory(projectId, toStored(msgs))
      }
    }, 600)
    return () => clearTimeout(t)
  }, [chats])

  useEffect(() => {
    void window.api.getVersions().then(setVersions)
    void refreshProjects()
  }, [refreshProjects])

  // When a Fabricator validation tool wants to show the running app, make sure
  // the preview pane is actually on screen AND has a deploy URL to load:
  //  • switch to the build view (the preview only mounts there) and, if chat is
  //    focused (preview collapsed to 0×0), drop the focus so it gets real bounds;
  //  • refresh project state from the store. A tool-initiated deploy updates the
  //    Rust store mid-turn but not React state, so without this the first-ever
  //    deploy+validate turn would have `lastDeploy.url` still undefined and the
  //    native webview would never be created for the agent to navigate/screenshot.
  useEffect(() => {
    return window.api.preview.onAgentPreview(() => {
      setViewMode('build')
      setFocusPane((f) => (f === 'chat' ? null : f))
      void refreshProjects()
    })
  }, [refreshProjects])

  // Lazy-mount the Advisor view the first time it's opened. After that it stays
  // mounted (hidden when another tab is active) so an in-flight review keeps its
  // live feed/timer/results instead of resetting on every tab switch.
  useEffect(() => {
    if (viewMode === 'advisor') setAdvisorMounted(true)
  }, [viewMode])

  // Re-gate per project: opening a *different* project resets to the Build view,
  // unmounts Advisor until its tab is opened again (so the opt-in stale auto-run
  // never fires for a project whose Advisor tab the user hasn't visited), and
  // dismisses the launcher overlay. Keyed on active.id, so re-opening the project
  // that's already active (no id change) preserves whatever view it was left on.
  useEffect(() => {
    setViewMode('build')
    setAdvisorMounted(false)
    setAdvisorOpen(null)
    setShowHome(false)
  }, [active?.id])

  async function selectProject(p: StudioProject): Promise<void> {
    setNotice(null)
    // Re-opening the project that's already active just closes the launcher and
    // returns to it exactly as it was left — nothing is torn down or reloaded.
    if (p.id === active?.id) {
      setShowHome(false)
      return
    }
    remindUnpublished()
    setProjects(await window.api.projects.setActive(p.id))
  }

  // Show the projects launcher over the current project WITHOUT closing it, so any
  // background work (a running chat turn, an Advisor review) keeps going. The active
  // project is only closed when a different one is opened from the launcher.
  function goHome(): void {
    setNotice(null)
    remindUnpublished()
    setShowHome(true)
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
    setProjects(await window.api.projects.remove(p.id, false))
  }

  async function renameProject(p: StudioProject, name: string): Promise<string | null> {
    try {
      const result = await window.api.projects.rename(p.id, name)
      if (!result.ok) return result.error ?? 'Could not rename the project.'
      await refreshProjects()
      return null
    } catch (error) {
      return error instanceof Error && error.message
        ? error.message
        : 'Could not rename the project. Please try again.'
    }
  }

  async function signOut(): Promise<void> {
    if (authActionRef.current || deployingIdRef.current) return
    authActionRef.current = true
    setSigningOut(true)
    try {
      const result = await window.api.auth.logoutRayfin()
      if (!mountedRef.current) return
      if (!result.ok) {
        throw new Error(
          authErrorMessage(result.error, 'Fabric sign-out did not complete. Please try again.')
        )
      }
      // Stay in the workbench (and keep unsent drafts): only Fabric changed.
      await refreshAuthWithFeedback()
    } catch (reason) {
      if (!mountedRef.current) return
      toast.error(authErrorMessage(reason, 'Fabric sign-out did not complete. Please try again.'), {
        title: 'Sign-out failed'
      })
      await refreshAuthWithFeedback()
    } finally {
      authActionRef.current = false
      if (mountedRef.current) setSigningOut(false)
    }
  }

  async function signIn(): Promise<void> {
    if (authActionRef.current || deployingIdRef.current) return
    authActionRef.current = true
    setSigningIn(true)
    try {
      const res = await window.api.auth.loginRayfin()
      if (!mountedRef.current) return
      if (!res.ok) {
        throw new Error(
          authErrorMessage(res.error, 'Fabric sign-in did not complete. Please try again.')
        )
      }
      await onAuthChanged()
    } catch (reason) {
      if (!mountedRef.current) return
      toast.error(authErrorMessage(reason, 'Fabric sign-in did not complete. Please try again.'), {
        title: 'Sign-in failed'
      })
    } finally {
      authActionRef.current = false
      if (mountedRef.current) setSigningIn(false)
    }
  }

  function openAuthRefresh(project: StudioProject): void {
    setAuthRefreshTarget({
      projectId: project.id,
      name: project.name,
      tenant: auth.rayfin.tenant
    })
    setAuthRefreshError(null)
    setAuthRefreshLog([])
  }

  async function refreshFabricAuthentication(): Promise<void> {
    const target = authRefreshTarget
    if (!target) return
    if (authActionRef.current || deployingIdRef.current) {
      setAuthRefreshError('Wait for the current deployment or sign-in to finish, then retry.')
      return
    }
    authActionRef.current = true
    authRefreshProjectRef.current = target.projectId
    setRefreshingAuth(true)
    setAuthRefreshError(null)
    try {
      const result = await window.api.auth.refreshRayfin(target.projectId, target.tenant)
      if (!mountedRef.current) return
      if (!result.ok) {
        throw new Error(
          authErrorMessage(
            result.error,
            'Fabric authentication could not be refreshed. Please retry.'
          )
        )
      }
      await onAuthChanged()
      if (!mountedRef.current) return
      setAuthRefreshTarget(null)
      toast.info('Fabric authentication is verified. Use Redeploy to retry your deployment.', {
        title: 'Fabric authentication refreshed'
      })
    } catch (reason) {
      if (!mountedRef.current) return
      setAuthRefreshError(
        authErrorMessage(reason, 'Fabric authentication could not be refreshed. Please retry.')
      )
      await refreshAuthWithFeedback()
    } finally {
      authActionRef.current = false
      if (mountedRef.current) setRefreshingAuth(false)
    }
  }

  // Open a prefilled GitHub issue (app + system info) in the browser so bug
  // reports arrive with the version/environment details already filled in. A
  // diagnostics bundle is exported first (best-effort) and referenced in the
  // body; export failures never block the report. See ./reportIssue.
  async function reportIssue(): Promise<void> {
    const bundlePath = await runReportIssue(window.api, versions)
    if (bundlePath) {
      toast.info(
        'A diagnostics file was saved and the logs folder opened — attach it to your bug report.',
        { title: 'Diagnostics exported' }
      )
    }
  }

  // Write the diagnostics file and reveal it, without opening a bug report.
  // Offered by Help when the user needs the file itself.
  async function exportDiagnostics(): Promise<void> {
    try {
      await window.api.diagnostics.export()
      toast.info('A diagnostics file was saved and the logs folder opened.', {
        title: 'Diagnostics exported'
      })
    } catch (reason) {
      toast.error(authErrorMessage(reason, 'The diagnostics file could not be written.'), {
        title: "Couldn't export diagnostics"
      })
    }
  }

  const fabricAuthBusy =
    signingIn || signingOut || refreshingAuth || Object.values(deploys).some((d) => d.running)

  // Open Help. The assistant needs Copilot, and being signed out is exactly the
  // kind of problem someone opens Help about — so instead of a dead end, show
  // the static version of the same offer. `checking` means the background check
  // hasn't finished: assume it will work rather than pre-empting with a dialog.
  function openHelp(): void {
    if (!auth.copilot.signedIn && !auth.copilot.checking) setShowHelpOffline(true)
    else setShowHelp(true)
  }

  function toggleHelp(): void {
    if (showHelp) setShowHelp(false)
    else if (showHelpOffline) setShowHelpOffline(false)
    else openHelp()
  }
  const toggleHelpRef = useRef(toggleHelp)
  toggleHelpRef.current = toggleHelp

  // Run an action the Help assistant offered. Each one maps to something the
  // user could already do from the UI, so Help is a shortcut, never a new
  // capability. Anything unrecognised is ignored rather than guessed at.
  //
  // Actions that move you somewhere in Fabricator close the overlay, because
  // that is where you need to look. Actions that open a browser or a file
  // manager leave it open, so you can come straight back and say it didn't
  // work. Either way the conversation is kept.
  function runHelpAction(action: HelpAction): void {
    switch (action.id) {
      case 'open-docs':
        if (action.url) void window.api.openExternal(action.url)
        break
      case 'open-logs':
        void window.api.openLogs()
        break
      case 'export-diagnostics':
        void exportDiagnostics()
        break
      case 'report-issue':
        void reportIssue()
        break
      case 'open-project': {
        const target = projects?.projects.find((p) => p.id === action.target)
        if (!target) break
        setShowHelp(false)
        void selectProject(target)
        break
      }
      case 'open-home':
        setShowHelp(false)
        goHome()
        break
      case 'share-app':
        setShowHelp(false)
        setShowHome(false)
        // DeploymentsControl owns the share dialog; bumping the nonce asks it
        // to open for the active project's live deployment. It is only mounted
        // for personal projects, which is why Help never offers this for a
        // team app (see PERSONAL_ONLY in the Help tools).
        setShareRequest((n) => n + 1)
        break
      case 'open-team-access': {
        // A team app has no Share: an owner grants access to the whole
        // workspace under App access in the overview.
        const workspaceId = active?.team?.workspaceId
        if (!workspaceId) break
        setShowHelp(false)
        setShowHome(false)
        openTeamMap(workspaceId, 'project', active?.team?.folder, true)
        break
      }
      case 'open-advisor':
        setShowHelp(false)
        setShowHome(false)
        setViewMode('advisor')
        break
      case 'open-code':
        setShowHelp(false)
        setShowHome(false)
        setViewMode('code')
        break
      case 'run-doctor':
        setShowHelp(false)
        onReviewSetup()
        break
      case 'refresh-fabric-auth':
      case 'sign-in-copilot':
      case 'open-accounts':
        setShowHelp(false)
        setShowAccounts(true)
        break
      case 'open-settings':
        setShowHelp(false)
        setShowSettings(true)
        break
    }
  }

  // Submit the bug report the Help assistant wrote. Nothing is sent from here:
  // GitHub opens prefilled so the user reviews and submits it themselves.
  function reportHelpIssue(issue: HelpIssueDraft): void {
    setShowHelp(false)
    void (async () => {
      const bundlePath = await runReportIssue(window.api, versions, navigator.userAgent, issue)
      if (bundlePath) {
        toast.info(
          'A diagnostics file was saved and the logs folder opened — attach it to your bug report.',
          { title: 'Diagnostics exported' }
        )
      }
    })()
  }

  /** Identifies the attention bar's problems, so dismissing it lasts until they change. */
  const attentionKey = attention
    ? JSON.stringify([attention.tools, attention.signIns, attention.error ?? ''])
    : null
  /** The active project's own screen — not the launcher or a fullscreen flow. */
  const onProjectScreen = Boolean(active) && !showHome && !createMode && !showClone && !teamMap
  // The active team app's status, with the run deploying it from the workspace
  // activity until its own status catches up (that's read right after a save).
  const activeTeamStatus = active?.team
    ? withActivity(teamWork.status(active.id), teamRuns, active.team.folder)
    : undefined
  /** Tabs and deploys unlock with the project's dependencies, like the pane below. */
  const projectToolsReady = onProjectScreen && depsReadyId === active?.id

  return (
    <div className="app-shell">
      <header className="app-bar">
        <div className="app-bar-row">
          <div className="app-bar-start">
            {teamMap && !createMode && !showClone ? (
              <BackToProject
                name={teamMap.from === 'project' && active ? active.name : 'projects'}
                title={teamMap.from === 'project' && active ? `Return to ${active.name}` : 'Return to your projects'}
                onClick={() => setTeamMap(null)}
              />
            ) : active && onProjectScreen ? (
              <ProjectSwitcher project={active} onClick={goHome} />
            ) : active && showHome && !createMode && !showClone ? (
              <BackToProject name={active.name} onClick={() => setShowHome(false)} />
            ) : null}
          </div>
          <div className="app-bar-center">
            {projectToolsReady && (
              <ProjectTabs
                view={viewMode}
                onChange={setViewMode}
                advisorBadge={advisor.derived.badge}
              />
            )}
          </div>
          <div className="app-bar-end">
            {active && projectToolsReady && !autoDeploy && (
              <>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  title="Auto-deploy is paused for all projects. Open Settings to resume."
                  onClick={() => setShowSettings(true)}
                >
                  Auto-deploy paused
                </button>
                {active.team && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={activeChatBusy || teamWork.syncing(active.id)}
                    onClick={() => void deployTeamPreview(active.id, 'Deploy local changes')}
                  >
                    Deploy preview
                  </button>
                )}
              </>
            )}
            {active && projectToolsReady && active.team && (
              <TeamPublishControl
                project={active}
                workspaceName={activeTeamWorkspace?.name}
                status={activeTeamStatus}
                runs={teamRuns}
                syncing={teamWork.syncing(active.id)}
                onPublish={() => teamWork.publish(active.id)}
                onUpdate={() => teamWork.update(active.id)}
                onCombine={() => teamWork.combineWithCopilot(active.id, [])}
                onDiscard={() => teamWork.discard(active.id)}
                onSetView={(view) => teamWork.setView(active.id, view)}
                onViewLogs={(runId) => teamWork.viewLogs(active.id, runId)}
                onDiagnose={(run) => teamWork.diagnose(active.id, run)}
                onRefresh={() => void teamWork.refresh(active.id, true)}
                onOpenMap={() => openTeamMap(active.team?.workspaceId ?? '', 'project', active.team?.folder)}
              />
            )}
            {active && projectToolsReady && !active.team && (
              <DeploymentsControl
                project={active}
                running={Boolean(deploys[active.id]?.running)}
                reconciling={reconciling.has(active.id)}
                shareRequest={shareRequest}
                onCreate={(name, workspaceId) => {
                  setViewMode('build')
                  void (async () => {
                    try {
                      await window.api.deploy.setName(active.id, workspaceId, name)
                    } catch {
                      /* naming is best-effort; deploy anyway */
                    }
                    await requestUserDeploy(active.id, workspaceId)
                  })()
                }}
                onRedeploy={() => {
                  setViewMode('build')
                  void requestUserDeploy(active.id)
                }}
                onSwitch={(workspace, byId) => switchDeployment(active.id, workspace, byId)}
                onChanged={() => void refreshProjects()}
                onSignedIn={onAuthChanged}
                account={
                  auth.rayfin.signedIn
                    ? { user: auth.rayfin.user, tenant: tenantLabel(auth.rayfin.tenant, auth.az) }
                    : undefined
                }
                onManageAccounts={() => setShowAccounts(true)}
              />
            )}
            <div className="app-bar-global">
              <button
                type="button"
                className="app-bar-icon"
                onClick={() => setShowSettings(true)}
                title="Settings"
                aria-label="Settings"
              >
                <Codicon name="settings-gear" />
              </button>
              <AccountMenu
                signedIn={auth.rayfin.signedIn}
                user={auth.rayfin.user}
                tenant={tenantLabel(auth.rayfin.tenant, auth.az)}
                checking={auth.rayfin.checking}
                busy={fabricAuthBusy}
                signingIn={signingIn}
                signingOut={signingOut}
                refreshing={refreshingAuth}
                canRefresh={Boolean(active)}
                onSignIn={() => void signIn()}
                onSignOut={() => void signOut()}
                onRefresh={() => {
                  if (active) openAuthRefresh(active)
                }}
                onManageAccounts={() => setShowAccounts(true)}
              />
            </div>
          </div>
        </div>
        {attention && attentionKey !== dismissedAttention && (
          <SetupAttentionBar
            attention={attention}
            onManageAccounts={() => setShowAccounts(true)}
            onReviewSetup={onReviewSetup}
            onDismiss={() => setDismissedAttention(attentionKey)}
          />
        )}
      </header>

      {showClone ? (
        <CloneFromGitHubScreen
          onCancel={() => setShowClone(false)}
          onCloned={() => {
            void refreshProjects()
            setShowClone(false)
          }}
        />
      ) : createMode ? (
        <CreateProjectScreen
          mode={createMode}
          projectName={active?.name}
          deploying={Boolean(active && deploys[active.id]?.running)}
          onCancel={() => {
            setCreateMode(null)
            setNewAppTeamId(null)
          }}
          onCreated={() => void refreshProjects()}
          onSignedIn={onAuthChanged}
          teamWorkspaces={teamEnabled ? projects?.teamWorkspaces : undefined}
          initialTeamWorkspaceId={newAppTeamId ?? undefined}
          onTeamCreated={(result) => {
            setCreateMode(null)
            setNewAppTeamId(null)
            setShowHome(false)
            setViewMode('build')
            void refreshProjects()
            if (result.error) toast.error(result.error, { title: 'Not on GitHub yet' })
          }}
          onDeploy={(depName, workspaceId) => {
            if (!active) {
              setCreateMode(null)
              return
            }
            const projectId = active.id
            setCreateMode(null)
            setViewMode('build')
            void (async () => {
              try {
                await window.api.deploy.setName(projectId, workspaceId, depName)
              } catch {
                /* naming is best-effort; deploy anyway */
              }
              await requestUserDeploy(projectId, workspaceId)
            })()
          }}
          onContinueWithoutDeploy={() => setCreateMode(null)}
        />
      ) : (
        <div className="workbench">
          <main className="content">
            {notice && <div className="alert alert--error content-alert">{notice}</div>}
            {active ? (
              <ProjectDependencyGuard
                project={active}
                onSwitchProjects={goHome}
                hidden={showHome || Boolean(teamMap)}
                onReadyChange={onDepsReadyChange}
              >
                <div className={`project-pane${showHome || teamMap ? ' project-pane--hidden' : ''}`}>
                  {viewMode === 'code' ? (
                    <Suspense fallback={<div className="code-empty">Loading editor…</div>}>
                      <CodeViewer
                        project={active}
                        refreshKey={gitRefresh}
                        onRequestDeploy={() => {
                          setViewMode('build')
                          void requestUserDeploy(active.id)
                        }}
                        onSendToChat={sendHistoryToChat}
                        openRequest={codeOpen ?? undefined}
                        onSkillsChanged={() => setGitRefresh((n) => n + 1)}
                        onSecretsChanged={() => setGitRefresh((n) => n + 1)}
                      />
                    </Suspense>
                  ) : viewMode === 'blueprint' ? (
                    <BlueprintTab
                      key={active.id}
                      project={active}
                      refreshKey={gitRefresh}
                      onOpenFile={openFileInCode}
                      onOpenSecrets={openSecretsInCode}
                      onSendToChat={sendModelToChat}
                      onSignedIn={onAuthChanged}
                      fabricUser={auth.rayfin.signedIn ? auth.rayfin.user : undefined}
                      teamManifest={activeTeamWorkspace?.manifest}
                    />
                  ) : viewMode === 'build' ? (
                    <div
                      className={`panes${focusPane ? ` panes--focus-${focusPane}` : ''}${
                        resizing ? ' panes--resizing' : ''
                      }`}
                      ref={panesRef}
                      style={
                        focusPane
                          ? undefined
                          : {
                              gridTemplateColumns: `minmax(0, ${chatFrac}fr) 7px minmax(0, ${1 - chatFrac}fr)`
                            }
                      }
                    >
                      <section className="pane pane--chat">
                        <AdvisorFixContext.Provider value={advisorFixLinks}>
                          <ChatPanel
                            key={active.id}
                            project={active}
                            copilotAuth={auth.copilot}
                            onCopilotAuthChanged={onAuthChanged}
                            messages={chats[active.id] ?? []}
                            onChange={(updater) => setMessagesFor(active.id, updater)}
                            onTurnComplete={(result) => void handleTurnComplete(active.id, result)}
                            onTurnStart={() => handleTurnStart(active.id)}
                            onPlanExecutionStart={() => void handleTurnStart(active.id, 'plan')}
                            attachments={shots[active.id] ?? []}
                            onAddAttachment={(shot) => addShot(active.id, shot)}
                            onRemoveAttachment={(path) => removeShot(active.id, path)}
                            onAttachmentsConsumed={() => clearShots(active.id)}
                            onClearHistory={() => void window.api.chat.saveHistory(active.id, [])}
                            onOptionsChanged={() => void refreshProjects()}
                            outbound={chatOutbound?.projectId === active.id ? chatOutbound : null}
                            onOutboundConsumed={() => setChatOutbound(null)}
                            onAdvisorRerun={rerunAdvisorFix}
                            focused={focusPane === 'chat'}
                            onToggleFocus={() => setFocusPane((f) => (f === 'chat' ? null : 'chat'))}
                            deployLock={active.awaitingFirstDeploy === true && !active.team}
                            deploying={
                              Boolean(deploys[active.id]?.running) ||
                              (Boolean(active.team) && teamWork.syncing(active.id))
                            }
                            blockSubmitWhileDeploying
                            submitBlockedTitle={
                              active.team ? 'Saving to GitHub — sending resumes in a moment' : undefined
                            }
                            onRequestDeploy={() => setCreateMode('deploy')}
                            eventsManagedExternally
                            onOpenMention={openMention}
                            draft={drafts[active.id] ?? ''}
                            onDraftChange={(value) => setDraftFor(active.id, value)}
                            designItems={design.items}
                            designSending={design.sending}
                            onDesignRemove={design.removeItem}
                            onDesignFocus={design.focusItem}
                            onDesignClear={design.clear}
                            buildDesignTurn={design.buildTurn}
                            onDesignSent={design.finishSend}
                          />
                        </AdvisorFixContext.Provider>
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
                          team={Boolean(active.team)}
                          localBackend={devServers[active.id]?.backend}
                          teamRun={activeTeamStatus?.run}
                          teamView={activeTeamStatus?.view ?? active.team?.view ?? 'preview'}
                          onOpenTeamMap={
                            active.team
                              ? () => openTeamMap(active.team?.workspaceId ?? '', 'project', active.team?.folder)
                              : undefined
                          }
                          onRefreshAuth={active.team ? undefined : () => openAuthRefresh(active)}
                          authBusy={fabricAuthBusy}
                          localPreviewUrl={
                            devServers[active.id]?.status === 'running'
                              ? (devServers[active.id]?.url ?? null)
                              : null
                          }
                          localPreviewRefreshKey={gitRefresh}
                          focused={focusPane === 'preview'}
                          onToggleFocus={() =>
                            setFocusPane((f) => (f === 'preview' ? null : 'preview'))
                          }
                          onPreviewModeChanged={() => void refreshProjects()}
                          design={design}
                          designSendBlocked={
                            activeChatBusy
                              ? 'Copilot is working — send when this turn finishes'
                              : active.awaitingFirstDeploy === true
                                ? 'Deploy your app first'
                                : deploys[active.id]?.running
                                  ? 'Deploying — send when it goes live'
                                  : null
                          }
                          onDesignSend={() => {
                            // Show the chat so the new turn is visible, then send
                            // through the composer (its text becomes the note).
                            setFocusPane((f) => (f === 'preview' ? null : f))
                            setChatOutbound({
                              id: `design-${Date.now()}`,
                              projectId: active.id,
                              display: '',
                              prompt: '',
                              design: true
                            })
                          }}
                          onDesignSurface={setDesignSurface}
                          onLoadingChange={setPreviewLoading}
                        />
                        {previewLoading && (
                          <div
                            className={`project-loading${previewLoading.fading ? ' project-loading--out' : ''}`}
                            role="status"
                            aria-label="Loading project"
                          >
                            <span className="project-loading-spinner" />
                            <span className="project-loading-label">
                              Loading {previewLoading.name}…
                            </span>
                          </div>
                        )}
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
                  ) : null}
                  {advisorMounted && (
                    <div
                      className={`advisor-host${viewMode === 'advisor' ? '' : ' advisor-host--hidden'}`}
                    >
                      <AdvisorView
                        project={active}
                        advisor={advisor}
                        chatBusy={activeChatBusy}
                        onFix={fixFindings}
                        onOpenFile={openFileInCode}
                        openRequest={advisorOpen ?? undefined}
                      />
                    </div>
                  )}
                </div>
              </ProjectDependencyGuard>
            ) : null}
            {teamMap && mapWorkspace ? (
              <TeamMapView
                key={mapWorkspace.id}
                workspace={mapWorkspace}
                focusFolder={teamMap.folder}
                manage={teamMap.manage}
                onClose={() => setTeamMap(null)}
                onOpened={() => {
                  setTeamMap(null)
                  setNotice(null)
                  setShowHome(false)
                  void refreshProjects()
                }}
                onNewApp={(workspaceId) => {
                  setTeamMap(null)
                  setNewAppTeamId(workspaceId)
                  setCreateMode('create')
                }}
                onChanged={() => void refreshProjects()}
              />
            ) : showHome || !active ? (
              <>
                {/* Project stays mounted underneath; hide the native preview (it paints
                  above all HTML) while the launcher covers it. */}
                {active && <SuppressPreview />}
                <HomeView
                  projects={projects?.projects ?? []}
                  activeId={active?.id}
                  workspaceRoot={projects?.workspaceRoot ?? ''}
                  opening={opening}
                  onSelect={(p) => void selectProject(p)}
                  onManageProject={setManagingProject}
                  onNewProject={() => setCreateMode('create')}
                  onOpenExisting={openExisting}
                  onCloneFromGitHub={() => setShowClone(true)}
                  onChangeWorkspaceRoot={changeWorkspaceRoot}
                  team={
                    teamEnabled
                      ? {
                          workspaces: projects?.teamWorkspaces ?? [],
                          onOpened: () => {
                            setNotice(null)
                            setShowHome(false)
                            void refreshProjects()
                          },
                          onNewApp: (workspaceId) => {
                            setNewAppTeamId(workspaceId)
                            setCreateMode('create')
                          },
                          onOpenMap: (workspaceId, manage) => openTeamMap(workspaceId, 'home', undefined, manage),
                          onChanged: () => void refreshProjects()
                        }
                      : undefined
                  }
                />
              </>
            ) : null}
          </main>
        </div>
      )}

      <footer className="statusbar">
        {active && (
          <>
            {active.team ? (
              <span
                className="statusbar-item team-status-item"
                title={`Team workspace${activeTeamWorkspace ? ` ${activeTeamWorkspace.repo}` : ''}. Working branch: ${active.team.branch ?? 'none'}`}
              >
                <span className="codicon codicon-organization" aria-hidden="true" />
                {activeTeamWorkspace?.name ?? 'Team'}
                {active.team.branch ? ` · ${branchLabel(active.team.branch)}` : ''}
              </span>
            ) : (
              <GitControl
                projectId={active.id}
                refreshKey={gitRefresh}
                onSynced={() => setGitRefresh((n) => n + 1)}
              />
            )}
            <span className="statusbar-sep">·</span>
            <RayfinVersionControl info={rayfinVer} onUpdate={requestRayfinUpdate} />
          </>
        )}
        {active && (active.workspaceName || active.workspace) && (
          <>
            <span className="statusbar-sep">·</span>
            <WorkspaceStatus project={active} />
          </>
        )}
        <span className="statusbar-spacer" />

        {/* Passive readouts: what the app is, not what you can do. Kept quiet
            and grouped so they don't read as actions. */}
        <span className="statusbar-readouts">
          <select
            className="statusbar-zoom"
            value={String(settings?.uiScale ?? 1)}
            onChange={(e) => {
              const uiScale = Number(e.target.value)
              applyUiScale(uiScale)
              onSettingsChange({ uiScale })
            }}
            title="Interface zoom — scales the whole UI (and the design tools)"
            aria-label="Interface zoom"
          >
            {UI_SCALES.map((s) => (
              <option key={s} value={String(s)}>
                {Math.round(s * 100)}%
              </option>
            ))}
          </select>
          <span className="statusbar-item" title="Rayfin Fabricator version">
            v{versions?.app ?? '—'}
          </span>
        </span>

        {/* One action. Help is the support surface: it answers questions,
            links the documentation, and writes a bug report when the problem
            is ours. */}
        <span className="statusbar-actions">
          <button
            className="statusbar-report statusbar-help"
            onClick={openHelp}
            title="Ask Help — debug a problem, browse the docs, or report an issue (Ctrl+J)"
          >
            <Codicon name="comment-discussion" />
            Help
          </button>
        </span>
      </footer>

      {showHelpOffline && (
        <HelpUnavailableModal
          onSignIn={() => {
            setShowHelpOffline(false)
            setShowAccounts(true)
          }}
          onDocs={() => openDocs('home')}
          onReportIssue={() => void reportIssue()}
          onClose={() => setShowHelpOffline(false)}
        />
      )}

      {showHelp && (
        <HelpView
          onClose={() => setShowHelp(false)}
          projectId={active?.id}
          projectName={active?.name}
          appVersion={versions?.app}
          facts={[
            ...accountFacts(auth),
            ...workbenchFacts(active, {
              projectCount: projects?.projects.length,
              team: Boolean(active?.team),
              onHome: showHome,
              previewUrl:
                active && devServers[active.id]?.status === 'running'
                  ? (devServers[active.id]?.url ?? null)
                  : null,
              deploying: Boolean(active && deploys[active.id]?.running)
            })
          ]}
          surface={showHome || !active ? 'home' : 'project'}
          onAction={runHelpAction}
          onReportIssue={reportHelpIssue}
        />
      )}

      {showSettings && settings && (
        <SettingsModal
          settings={settings}
          versions={versions}
          onChange={onSettingsChange}
          onClose={() => setShowSettings(false)}
          onManageAccounts={() => {
            setShowSettings(false)
            setShowAccounts(true)
          }}
          onReviewSetup={() => {
            setShowSettings(false)
            onReviewSetup()
          }}
        />
      )}

      {showAccounts && (
        <AccountsModal
          auth={auth}
          onAuthChanged={onAuthChanged}
          fabric={{
            busy: fabricAuthBusy,
            signingIn,
            signingOut,
            canRefresh: Boolean(active),
            projectId: active?.id,
            onSignIn: () => void signIn(),
            onSignOut: () => void signOut(),
            onRefresh: () => {
              setShowAccounts(false)
              if (active) openAuthRefresh(active)
            }
          }}
          onReviewSetup={() => {
            setShowAccounts(false)
            onReviewSetup()
          }}
          onClose={() => setShowAccounts(false)}
        />
      )}

      {managingProject && (
        <ManageProjectModal
          project={managingProject}
          onRename={renameProject}
          onRemoveFromList={(p) => void removeFromList(p)}
          onMoveToTrash={setConfirmDelete}
          onClose={() => setManagingProject(null)}
          teamWorkspaces={teamEnabled ? projects?.teamWorkspaces : undefined}
          onMoveToTeam={
            teamEnabled
              ? async (p, workspaceId) => {
                  const result = await window.api.team.moveProject(workspaceId, p.id)
                  if (!result.project) return result.error ?? 'Could not move the project.'
                  setShowHome(false)
                  await refreshProjects()
                  if (result.error) toast.error(result.error, { title: 'Not on GitHub yet' })
                  else toast.success(`${p.name} is now in the team workspace.`, { title: 'Moved' })
                  return null
                }
              : undefined
          }
        />
      )}

      {teamWork.overlays}

      {confirmDelete && (
        <DeleteProjectModal
          project={confirmDelete}
          onSignedIn={onAuthChanged}
          onRemoved={(next) => setProjects(next)}
          onClose={() => setConfirmDelete(null)}
        />
      )}

      {portPrompt && (
        <PortConflictModal
          conflict={portPrompt.conflict}
          context={portPrompt.context}
          localOnly={!autoDeploy}
          busy={portPrompt.busy}
          error={portPrompt.error}
          log={portPrompt.log}
          onUsePort={() => void registerPromptPort()}
          onStop={() => void stopPromptOccupant()}
          onSkip={() => settlePortPrompt(null)}
        />
      )}

      {confirmDeploy && (
        <ConfirmModal
          title="You have changes to get first"
          confirmLabel="Get latest first"
          busyLabel="Getting latest…"
          busy={deployGuardBusy}
          secondaryLabel="Deploy anyway"
          cancelLabel="Cancel"
          onConfirm={() => {
            void (async () => {
              const c = confirmDeploy
              setDeployGuardBusy(true)
              setDeployGuardError(null)
              const res = await window.api.projects.git.pull(c.projectId)
              setGitRefresh((n) => n + 1)
              setDeployGuardBusy(false)
              if (!res.ok) {
                setDeployGuardError(res.error ?? 'Could not get the latest changes.')
                return
              }
              setConfirmDeploy(null)
              void runDeploy(c.projectId, c.workspace)
            })()
          }}
          onSecondary={() => {
            const c = confirmDeploy
            setConfirmDeploy(null)
            setDeployGuardError(null)
            void runDeploy(c.projectId, c.workspace)
          }}
          onCancel={() => {
            setConfirmDeploy(null)
            setDeployGuardError(null)
          }}
          message={
            <>
              <p>
                The remote has{' '}
                <strong>
                  {confirmDeploy.behind} change{confirmDeploy.behind === 1 ? '' : 's'}
                </strong>{' '}
                you haven’t downloaded yet. Deploying now publishes your current version without
                them.
              </p>
              {deployGuardError && <p className="confirm-error">{deployGuardError}</p>}
            </>
          }
        />
      )}

      {authRefreshTarget && (
        <ConfirmModal
          title="Refresh Fabric authentication"
          confirmLabel="Clear credentials and sign in"
          busy={refreshingAuth}
          busyLabel="Refreshing authentication…"
          onConfirm={() => void refreshFabricAuthentication()}
          onCancel={() => setAuthRefreshTarget(null)}
          message={
            <>
              <p>
                Run <code>rayfin logout</code> and <code>rayfin login</code> with{' '}
                <strong>{authRefreshTarget.name}</strong>&apos;s CLI, then verify the new Fabric credential.
                This lets Rayfin recover stale token-cache locks and replace expired credentials.
              </p>
              <p>
                Rayfin CLI credentials are shared across projects. This does not sign out of
                Copilot, Azure CLI, or the preview browser, and it does not redeploy automatically.
                Update older projects to Rayfin 1.35.1 or newer using the Rayfin version control.
              </p>
              {authRefreshError && (
                <p className="confirm-error" role="alert">
                  {authRefreshError}
                </p>
              )}
              {authRefreshLog.length > 0 && (
                <pre
                  className="deploy-log deploy-log--static"
                  aria-label="Authentication refresh log"
                >
                  {authRefreshLog.join('')}
                </pre>
              )}
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
          <SuppressPreview />
          <div className="signout-card">
            <div className="signout-mark">
              <FabricatorMark />
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
