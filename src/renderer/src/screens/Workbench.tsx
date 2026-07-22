import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
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
  type ChatMessage,
  type ChatTurnResult,
  type DeployResult,
  type DevServerResult,
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
import SettingsModal from '../components/SettingsModal'
import { applyUiScale, UI_SCALES } from '../theme'
import ChatPanel, { type UIChatMessage, type OutboundPrompt } from '../components/ChatPanel'
import { planForStorage, planFromStorage } from '../chatPlan'
import { useChatEventStore } from '../chatEventStore'
import PreviewPane, { type DeployUiState, type PendingShot } from '../components/PreviewPane'
import DeploymentsControl from '../components/DeploymentsControl'
import GitControl from '../components/GitControl'
import ProjectDependencyGuard from '../components/ProjectDependencyGuard'
import WorkspaceStatus from '../components/WorkspaceStatus'
import { SuppressPreview } from '../overlay'
import RayfinVersionControl from '../components/RayfinVersionControl'
import AdvisorView, { categoryMeta } from '../components/AdvisorView'
import ModelTab from '../components/ModelTab'
import { useToast } from '../toast'
import { reportIssue as runReportIssue } from './reportIssue'
import { InfoIcon, GearIcon, SignOutIcon, CompareIcon } from '../components/icons'
import { FabricatorMark } from '../components/FabricatorMark'

// Monaco is heavy (~7 MB); only load the code viewer when the Code tab is opened.
const CodeViewer = lazy(() => import('../components/CodeViewer'))

/** Up-to-two-letter initials for the signed-in user's avatar, derived from their
 * email (e.g. "first.last@…" → "FL", "sapatney@…" → "SA"). */
function avatarInitials(email: string | null | undefined): string {
  if (!email) return '?'
  const local = email.split('@')[0] ?? email
  const parts = local.split(/[.\-_]+/).filter(Boolean)
  const letters = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : local.slice(0, 2)
  return letters.toUpperCase() || '?'
}

/** Hydrate a persisted message into a live (non-pending) UI message. */
function toUi(m: ChatMessage): UIChatMessage {
  return {
    ...m,
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
      plan,
      questions
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
        segments,
        error,
        attachments,
        attachmentThumbs,
        elapsedMs,
        plan: planForStorage(plan, Boolean(cutOff)),
        // Mirror plan-question handling: a question still pending when the turn
        // was cut off can never be answered, so persist it as interrupted.
        questions: cutOff
          ? questions?.map((q) => (q.state === 'pending' ? { ...q, state: 'interrupted' } : q))
          : questions,
        interrupted: cutOff ? true : undefined
      }
    }
  )
}

interface Props {
  auth: AuthStatus
  onSignOut: () => Promise<void> | void
  onAuthChanged: () => Promise<void> | void
  settings: AppSettings | null
  onSettingsChange: (patch: Partial<AppSettings>) => void
}

export default function Workbench({
  auth,
  onSignOut,
  onAuthChanged,
  settings,
  onSettingsChange
}: Props): JSX.Element {
  const toast = useToast()
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
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
  const [viewMode, setViewMode] = useState<'build' | 'code' | 'model' | 'advisor'>('build')
  /** A pending request to open a specific file in the Code tab (Model → file). */
  const [codeOpen, setCodeOpen] = useState<{ path: string; nonce: number } | null>(null)
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
  /** Live local preview (experiment): per-project Vite dev-server state. Present
   *  only while a turn runs — started at turn start, cleared/stopped at turn end. */
  const [devServers, setDevServers] = useState<
    Record<string, { status: 'starting' | 'running'; url?: string }>
  >({})
  const devServersRef = useRef(devServers)
  devServersRef.current = devServers
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

  /** Projects with a deploy queued behind the running one (coalesced). */
  const pendingDeployRef = useRef<Set<string>>(new Set())
  /** Stable handle to runDeploy for use inside its own completion path. */
  const runDeployRef = useRef<((projectId: string) => void) | null>(null)
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

  const runDeploy = useCallback(
    async (projectId: string, workspace?: string): Promise<void> => {
      if (deployingIdRef.current) {
        // A deploy is already streaming — queue this one to run right after.
        pendingDeployRef.current.add(projectId)
        return
      }
      deployingIdRef.current = projectId
      setDeploys((all) => ({ ...all, [projectId]: { running: true, log: [] } }))
      try {
        let result = await window.api.deploy.run(projectId, workspace)
        // A deploy that failed only because the Fabric/Rayfin login expired: re-sign-in
        // once and retry, so an expired token doesn't force a manual sign out / back in.
        if (!result.ok && result.outcome === 'not-signed-in') {
          const login = await window.api.auth.loginRayfin()
          if (login.ok) result = await window.api.deploy.run(projectId, workspace)
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
        await refreshProjects()
        // A completed deploy proves Fabric sign-in (and may have signed the user
        // in via the not-signed-in retry above), so refresh the titlebar auth.
        void onAuthChanged()
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
    [refreshProjects, refreshRayfinVer, toast, onAuthChanged]
  )
  runDeployRef.current = (projectId: string) => void runDeploy(projectId)

  /**
   * User-initiated deploy funnel: warn first when the remote has changes the user
   * hasn't pulled (a fast, non-fetching divergence check), otherwise deploy straight
   * away. Automatic deploys (post-turn) call runDeploy directly and skip this guard
   * so they never stall on a modal.
   */
  const requestUserDeploy = useCallback(
    async (projectId: string, workspace?: string): Promise<void> => {
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

  // Kick off the live local preview (experiment) when a turn starts: run the
  // project's Vite dev server so edits show live at localhost for the turn's
  // duration. No-op unless the experiment is on and the project supports it — the
  // backend reports `unsupported` for projects without a `dev` script.
  const handleTurnStart = useCallback(
    (projectId: string): void => {
      if (!settings?.experiments?.localDevPreview) return
      if (deployingIdRef.current === projectId) return // a deploy owns the surface
      if (devServersRef.current[projectId]) return // already starting / running
      setDevServers((all) => ({ ...all, [projectId]: { status: 'starting' } }))
      void (async () => {
        let res: DevServerResult
        try {
          res = await window.api.dev.start(projectId)
        } catch (err) {
          res = {
            ok: false,
            outcome: 'error',
            error: err instanceof Error ? err.message : String(err)
          }
        }
        if (!res.ok && res.outcome === 'error') {
          toast.error(res.error ?? 'The local Vite server could not be started.', {
            title: 'Local preview failed'
          })
        }
        setDevServers((all) => {
          // The turn already ended (entry cleared in handleTurnComplete) — don't
          // resurrect a preview whose server was just stopped.
          if (!all[projectId]) return all
          if (res.ok && res.url) {
            return { ...all, [projectId]: { status: 'running', url: res.url } }
          }
          const next = { ...all }
          delete next[projectId]
          return next
        })
      })()
    },
    [settings, toast]
  )

  // After a chat turn, persist the transcript and auto-deploy when the agent left
  // undeployed changes.
  const handleTurnComplete = useCallback(
    async (projectId: string, result: ChatTurnResult): Promise<void> => {
      // Stop the live local preview (if any) first, so the surface returns to the
      // deployed app and the after-turn deploy can take the stage (DeployStage).
      if (devServersRef.current[projectId]) {
        setDevServers((all) => {
          const next = { ...all }
          delete next[projectId]
          return next
        })
        void window.api.dev.stop(projectId)
      }
      await refreshProjects()
      setGitRefresh((n) => n + 1)
      void window.api.chat.saveHistory(projectId, toStored(chatsRef.current[projectId] ?? []))
      // The agent may have changed the Rayfin deps (e.g. an upgrade) — re-check.
      void refreshRayfinVer(projectId)
      if (!result.ok) return
      const changed = await window.api.deploy.hasChanges(projectId)
      if (changed) void runDeploy(projectId)
    },
    [refreshProjects, refreshRayfinVer, runDeploy]
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
      display: `Update Rayfin to ${to}`,
      prompt
    })
  }, [])

  // Hand an Advisor finding to the Build chat so Copilot can fix it.
  const fixWithCopilot = useCallback((finding: AdvisorFinding): void => {
    const id = activeIdRef.current
    if (!id) return
    const category = categoryMeta(finding.category).title
    const location = finding.file ? `\nLocation: ${finding.file}` : ''
    const prompt =
      'The Advisor review flagged an issue in this app. Please fix it.\n\n' +
      `Issue: ${finding.title}\n` +
      `Severity: ${finding.severity}\n` +
      `Category: ${category}${location}\n\n` +
      `Details: ${finding.detail}\n\n` +
      `Suggested fix: ${finding.recommendation}\n\n` +
      'Apply the fix in the code, keeping the app building and following Rayfin conventions. ' +
      'Do not run `rayfin up` or deploy — Fabricator redeploys automatically.'
    setViewMode('build')
    setFocusPane(null)
    setChatOutbound({
      id: `advisor-fix-${Date.now()}`,
      projectId: id,
      display: `Fix: ${finding.title}`,
      prompt
    })
  }, [])

  // Hand the whole Advisor findings list to the Build chat to fix in one task.
  const fixAllFindings = useCallback((findings: AdvisorFinding[]): void => {
    const id = activeIdRef.current
    if (!id || findings.length === 0) return
    const lines = findings
      .map((f, i) => {
        const category = categoryMeta(f.category).title
        const location = f.file ? ` (${f.file})` : ''
        return (
          `${i + 1}. [${f.severity}] ${category}: ${f.title}${location}\n` +
          `   Problem: ${f.detail}\n` +
          `   Suggested fix: ${f.recommendation}`
        )
      })
      .join('\n\n')
    const prompt =
      `The Advisor review found ${findings.length} issues in this app. Please fix all of ` +
      'them, most severe first. Keep the app building and follow Rayfin conventions. ' +
      'Do not run `rayfin up` or deploy — Fabricator redeploys automatically.\n\n' +
      `${lines}`
    setViewMode('build')
    setFocusPane(null)
    setChatOutbound({
      id: `advisor-fixall-${Date.now()}`,
      projectId: id,
      display: `Fix all ${findings.length} Advisor issues`,
      prompt
    })
  }, [])

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

  // Open a project file in the Code tab (used by the Model tab's entity cards).
  const openFileInCode = useCallback((path: string): void => {
    setCodeOpen({ path, nonce: Date.now() })
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
    void onAuthChanged()
  }, [active?.id, onAuthChanged])

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
    setProjects(await window.api.projects.setActive(p.id))
  }

  // Show the projects launcher over the current project WITHOUT closing it, so any
  // background work (a running chat turn, an Advisor review) keeps going. The active
  // project is only closed when a different one is opened from the launcher.
  function goHome(): void {
    setNotice(null)
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

  async function signIn(): Promise<void> {
    setSigningIn(true)
    try {
      const res = await window.api.auth.loginRayfin()
      if (!res.ok) {
        // Don't silently reset the button (issue #17) — tell the user why.
        toast.error(res.error ?? 'Fabric sign-in did not complete. Please try again.', {
          title: 'Sign-in failed'
        })
      }
      await onAuthChanged()
    } finally {
      setSigningIn(false)
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

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <FabricatorMark className="brand-mark" />
          <span className="brand-name">Fabricator</span>
        </div>
        <div className="titlebar-status">
          {auth.rayfin.signedIn && (
            <div
              className="who-avatar"
              title={auth.rayfin.user ?? 'Signed in'}
              aria-label={auth.rayfin.user ? `Signed in as ${auth.rayfin.user}` : 'Signed in'}
            >
              {avatarInitials(auth.rayfin.user)}
            </div>
          )}
          <div className="seg seg--toolbar">
            <button className="seg-btn" onClick={() => setShowSettings(true)} title="Settings">
              <GearIcon />
              Settings
            </button>
            {auth.rayfin.signedIn ? (
              <button className="seg-btn" disabled={signingOut} onClick={signOut} title="Sign out">
                <SignOutIcon />
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            ) : (
              <button className="seg-btn" disabled={signingIn} onClick={signIn}>
                {signingIn ? 'Signing in…' : 'Sign in to Fabric'}
              </button>
            )}
          </div>
        </div>
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
          onCancel={() => setCreateMode(null)}
          onCreated={() => void refreshProjects()}
          onSignedIn={() => void onAuthChanged()}
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
              <ProjectDependencyGuard project={active} onSwitchProjects={goHome} hidden={showHome}>
                <div className={`project-pane${showHome ? ' project-pane--hidden' : ''}`}>
                  <div className="project-header">
                    <div className="project-id">
                      <button
                        className="switch-projects-btn"
                        onClick={goHome}
                        title="Switch projects — open a recent project or create a new one (keeps this project running)"
                      >
                        <CompareIcon />
                        Switch projects
                      </button>
                      <div className="project-id-text">
                        <h1 className="project-title">{active.name}</h1>
                        <span className="project-subpath">{active.path}</span>
                      </div>
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
                        className={`project-tab${viewMode === 'model' ? ' project-tab--active' : ''}`}
                        role="tab"
                        aria-selected={viewMode === 'model'}
                        onClick={() => setViewMode('model')}
                      >
                        Model
                      </button>
                      <button
                        className={`project-tab${viewMode === 'advisor' ? ' project-tab--active' : ''}`}
                        role="tab"
                        aria-selected={viewMode === 'advisor'}
                        onClick={() => setViewMode('advisor')}
                      >
                        Advisor
                      </button>
                    </div>
                    <div className="project-meta">
                      <DeploymentsControl
                        project={active}
                        running={Boolean(deploys[active.id]?.running)}
                        reconciling={reconciling.has(active.id)}
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
                        onSignedIn={() => void onAuthChanged()}
                      />
                    </div>
                  </div>
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
                      />
                    </Suspense>
                  ) : viewMode === 'model' ? (
                    <ModelTab
                      project={active}
                      refreshKey={gitRefresh}
                      onOpenFile={openFileInCode}
                      onSendToChat={sendModelToChat}
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
                        <ChatPanel
                          key={active.id}
                          project={active}
                          messages={chats[active.id] ?? []}
                          onChange={(updater) => setMessagesFor(active.id, updater)}
                          onTurnComplete={(result) => void handleTurnComplete(active.id, result)}
                          onTurnStart={() => handleTurnStart(active.id)}
                          onPlanExecutionStart={() => handleTurnStart(active.id)}
                          attachments={shots[active.id] ?? []}
                          onAddAttachment={(shot) => addShot(active.id, shot)}
                          onRemoveAttachment={(path) => removeShot(active.id, path)}
                          onAttachmentsConsumed={() => clearShots(active.id)}
                          onClearHistory={() => void window.api.chat.saveHistory(active.id, [])}
                          onOptionsChanged={() => void refreshProjects()}
                          outbound={chatOutbound?.projectId === active.id ? chatOutbound : null}
                          onOutboundConsumed={() => setChatOutbound(null)}
                          focused={focusPane === 'chat'}
                          onToggleFocus={() => setFocusPane((f) => (f === 'chat' ? null : 'chat'))}
                          deployLock={active.awaitingFirstDeploy === true}
                          deploying={Boolean(deploys[active.id]?.running)}
                          blockSubmitWhileDeploying={Boolean(
                            settings?.experiments?.localDevPreview
                          )}
                          onRequestDeploy={() => setCreateMode('deploy')}
                          modeSelectorEnabled={Boolean(settings?.experiments?.chatModeSelector)}
                          eventsManagedExternally
                          onOpenMention={openMention}
                          draft={drafts[active.id] ?? ''}
                          onDraftChange={(value) => setDraftFor(active.id, value)}
                        />
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
                          localPreviewUrl={
                            devServers[active.id]?.status === 'running'
                              ? (devServers[active.id]?.url ?? null)
                              : null
                          }
                          focused={focusPane === 'preview'}
                          onToggleFocus={() =>
                            setFocusPane((f) => (f === 'preview' ? null : 'preview'))
                          }
                          onPreviewModeChanged={() => void refreshProjects()}
                          onDesignHandoff={(instruction, shot) => {
                            if (shot) addShot(active.id, shot)
                            // Make the composer visible (design mode may have focused
                            // the preview), then stage the instruction for review.
                            setFocusPane((f) => (f === 'preview' ? null : f))
                            setChatOutbound({
                              id: `design-${Date.now()}`,
                              projectId: active.id,
                              display: 'Design-mode tweaks',
                              prompt: instruction,
                              stage: true
                            })
                          }}
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
                        onFix={fixWithCopilot}
                        onFixAll={fixAllFindings}
                        chatBusy={(chats[active.id] ?? []).some(
                          (m) => m.role === 'assistant' && m.pending
                        )}
                      />
                    </div>
                  )}
                </div>
              </ProjectDependencyGuard>
            ) : null}
            {showHome || !active ? (
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
                />
              </>
            ) : null}
          </main>
        </div>
      )}

      <footer className="statusbar">
        {active && (
          <>
            <GitControl
              projectId={active.id}
              refreshKey={gitRefresh}
              onSynced={() => setGitRefresh((n) => n + 1)}
            />
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
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item" title="Rayfin Fabricator version">
          v{versions?.app ?? '—'}
        </span>
        <span className="statusbar-sep">·</span>
        <button
          className="statusbar-report"
          onClick={() => void reportIssue()}
          title="Report an issue on GitHub — opens a prefilled bug report with app & system info"
        >
          <InfoIcon />
          Report an issue
        </button>
      </footer>

      {showSettings && settings && (
        <SettingsModal
          settings={settings}
          versions={versions}
          onChange={onSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}

      {managingProject && (
        <ManageProjectModal
          project={managingProject}
          onRename={renameProject}
          onRemoveFromList={(p) => void removeFromList(p)}
          onMoveToTrash={setConfirmDelete}
          onClose={() => setManagingProject(null)}
        />
      )}

      {confirmDelete && (
        <DeleteProjectModal
          project={confirmDelete}
          onRemoved={(next) => setProjects(next)}
          onClose={() => setConfirmDelete(null)}
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
