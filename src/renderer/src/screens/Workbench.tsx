import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  AppVersions,
  AuthStatus,
  ChatMessage,
  ChatTurnResult,
  DeployResult,
  ProjectsState,
  StudioProject
} from '@shared/ipc'
import NewProjectModal from '../components/NewProjectModal'
import ConfirmModal from '../components/ConfirmModal'
import SettingsModal from '../components/SettingsModal'
import ChatPanel, { type UIChatMessage } from '../components/ChatPanel'
import PreviewPane, { type DeployUiState, type PendingShot } from '../components/PreviewPane'
import DeploymentsControl from '../components/DeploymentsControl'
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
  /** Sidebar per-project actions menu / inline-rename / delete-confirm state. */
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<StudioProject | null>(null)
  const [deleting, setDeleting] = useState(false)
  /** Bumped whenever the working tree likely changed (deploy / chat turn). */
  const [gitRefresh, setGitRefresh] = useState(0)
  /** Project content view: the build loop (chat + preview) or the code browser. */
  const [viewMode, setViewMode] = useState<'build' | 'code'>('build')
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
      }
    },
    [refreshProjects]
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
      if (!result.ok) return
      const changed = await window.api.deploy.hasChanges(projectId)
      if (changed) void runDeploy(projectId)
    },
    [refreshProjects, runDeploy]
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

  async function deleteFromDisk(): Promise<void> {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      setProjects(await window.api.projects.remove(confirmDelete.id, true))
    } finally {
      setDeleting(false)
      setConfirmDelete(null)
    }
  }

  async function signOut(): Promise<void> {
    setSigningOut(true)
    try {
      await window.api.auth.logoutRayfin()
    } finally {
      setSigningOut(false)
      await onSignOut()
    }
  }

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand">
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

      <div className="workbench">
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
                  <CodeViewer project={active} refreshKey={gitRefresh} />
                </Suspense>
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
          title="Delete project from disk?"
          danger
          busy={deleting}
          confirmLabel="Move to trash"
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
              <p>The deployed Fabric app is not affected — only the local code is removed.</p>
            </>
          }
        />
      )}
    </div>
  )
}
