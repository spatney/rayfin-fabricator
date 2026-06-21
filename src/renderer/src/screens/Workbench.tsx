import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  AppVersions,
  AuthStatus,
  ChatMessage,
  ChatTurnResult,
  DeployResult,
  ProjectsState,
  RayfinVersionInfo,
  StudioProject
} from '@shared/ipc'
import NewProjectModal from '../components/NewProjectModal'
import ConfirmModal from '../components/ConfirmModal'
import SettingsModal from '../components/SettingsModal'
import ChatPanel, { type UIChatMessage, type OutboundPrompt } from '../components/ChatPanel'
import PreviewPane, { type DeployUiState, type PendingShot } from '../components/PreviewPane'
import DeploymentsControl from '../components/DeploymentsControl'
import RayfinVersionControl from '../components/RayfinVersionControl'
import SkillsView from '../components/SkillsView'
import logo from '../assets/logo.png'

// Monaco is heavy (~7 MB); only load the code viewer when the Code tab is opened.
const CodeViewer = lazy(() => import('../components/CodeViewer'))

/** Hydrate a persisted message into a live (non-pending) UI message. */
function toUi(m: ChatMessage): UIChatMessage {
  return { ...m, pending: false }
}

/** Strip transient fields (turnId, pending) before persisting to disk. */
function toStored(messages: UIChatMessage[]): ChatMessage[] {
  return messages.map(({ id, role, text, tools, error, attachments }) => ({
    id,
    role,
    text,
    tools,
    error,
    attachments
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
    (OutboundPrompt & { projectId: string }) | null
  >(null)
  /** Project content view: the build loop (chat + preview) or the code browser. */
  const [viewMode, setViewMode] = useState<'build' | 'code' | 'skills'>('build')
  /** Build-view focus: expand a single pane to fill the area (null = split). */
  const [focusPane, setFocusPane] = useState<'chat' | 'preview' | null>(null)
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
  /** Projects whose persisted history has been loaded this session. */
  const hydratedRef = useRef<Set<string>>(new Set())

  const addShot = useCallback((projectId: string, shot: PendingShot): void => {
    setShots((all) => ({ ...all, [projectId]: [...(all[projectId] ?? []), shot] }))
  }, [])

  const removeShot = useCallback((projectId: string, path: string): void => {
    setShots((all) => ({ ...all, [projectId]: (all[projectId] ?? []).filter((s) => s.path !== path) }))
    void window.api.screenshot.cleanup([path])
  }, [])

  const clearShots = useCallback((projectId: string): void => {
    setShots((all) => ({ ...all, [projectId]: [] }))
  }, [])

  const setMessagesFor = useCallback(
    (projectId: string, updater: (prev: UIChatMessage[]) => UIChatMessage[]): void => {
      setChats((all) => ({ ...all, [projectId]: updater(all[projectId] ?? []) }))
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
      if (deployingIdRef.current) return // one deploy at a time (skeleton)
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
      }
    },
    [refreshProjects, refreshRayfinVer]
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

  // After a chat turn, persist the transcript and auto-deploy when the agent
  // left undeployed changes.
  const handleTurnComplete = useCallback(
    async (projectId: string, result: ChatTurnResult): Promise<void> => {
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

  // Hydrate a project's persisted chat history the first time it becomes active.
  useEffect(() => {
    const id = projects?.activeProjectId
    if (!id || hydratedRef.current.has(id)) return
    hydratedRef.current.add(id)
    void window.api.chat.history(id).then((stored) => {
      setChats((all) => (all[id] !== undefined ? all : { ...all, [id]: stored.map(toUi) }))
    })
  }, [projects?.activeProjectId])

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
      for (const pid of hydratedRef.current) {
        const msgs = chatsRef.current[pid]
        if (msgs) void window.api.chat.saveHistory(pid, toStored(msgs))
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

  const active = projects?.projects.find((p) => p.id === projects.activeProjectId) ?? null

  async function selectProject(p: StudioProject): Promise<void> {
    setNotice(null)
    setProjects(await window.api.projects.setActive(p.id))
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
            ⚙ Settings
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
                  className={`panes${
                    focusPane ? ` panes--focus-${focusPane}` : ''
                  }`}
                >
                  <section className="pane pane--chat">
                    <ChatPanel
                      key={active.id}
                      project={active}
                      messages={chats[active.id] ?? []}
                      onChange={(updater) => setMessagesFor(active.id, updater)}
                      onTurnComplete={(result) => void handleTurnComplete(active.id, result)}
                      attachments={shots[active.id] ?? []}
                      onRemoveAttachment={(path) => removeShot(active.id, path)}
                      onAttachmentsConsumed={() => clearShots(active.id)}
                      onClearHistory={() => void window.api.chat.saveHistory(active.id, [])}
                      onOptionsChanged={() => void refreshProjects()}
                      outbound={
                        chatOutbound?.projectId === active.id ? chatOutbound : null
                      }
                      focused={focusPane === 'chat'}
                      onToggleFocus={() =>
                        setFocusPane((f) => (f === 'chat' ? null : 'chat'))
                      }
                    />
                  </section>
                  <section className="pane pane--preview">
                    <PreviewPane
                      project={active}
                      deploy={deploys[active.id]}
                      onDeploy={(workspace, force) => void runDeploy(active.id, workspace, force)}
                      onCapture={(shot) => addShot(active.id, shot)}
                      focused={focusPane === 'preview'}
                      onToggleFocus={() =>
                        setFocusPane((f) => (f === 'preview' ? null : 'preview'))
                      }
                    />
                  </section>
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
