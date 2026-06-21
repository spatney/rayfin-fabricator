import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppVersions,
  AuthStatus,
  ChatMessage,
  ChatTurnResult,
  ProjectsState,
  StudioProject
} from '@shared/ipc'
import NewProjectModal from '../components/NewProjectModal'
import ChatPanel, { type UIChatMessage } from '../components/ChatPanel'
import PreviewPane, { type DeployUiState, type PendingShot } from '../components/PreviewPane'

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
}

export default function Workbench({ auth, onSignOut }: Props): JSX.Element {
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [projects, setProjects] = useState<ProjectsState | null>(null)
  const [showNewProject, setShowNewProject] = useState(false)
  const [opening, setOpening] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
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
    async (projectId: string, workspace?: string): Promise<void> => {
      if (deployingIdRef.current) return // one deploy at a time (skeleton)
      deployingIdRef.current = projectId
      setDeploys((all) => ({ ...all, [projectId]: { running: true, log: [] } }))
      try {
        const result = await window.api.deploy.run(projectId, workspace)
        setDeploys((all) => {
          const cur = all[projectId] ?? { running: false, log: [] }
          return { ...all, [projectId]: { ...cur, running: false, result } }
        })
        await refreshProjects()
      } finally {
        deployingIdRef.current = null
      }
    },
    [refreshProjects]
  )

  // After a chat turn, persist the transcript and auto-deploy when the agent
  // left undeployed changes.
  const handleTurnComplete = useCallback(
    async (projectId: string, result: ChatTurnResult): Promise<void> => {
      await refreshProjects()
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

  async function removeProject(p: StudioProject): Promise<void> {
    setProjects(await window.api.projects.remove(p.id))
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
          <span className="brand-mark">▰</span>
          <span className="brand-name">Rayfin Studio</span>
        </div>
        <div className="titlebar-status">
          <span className="who">{auth.rayfin.user ?? 'Signed in'}</span>
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
                className={`project-item${p.id === projects.activeProjectId ? ' project-item--active' : ''}`}
                onClick={() => void selectProject(p)}
                role="button"
                tabIndex={0}
              >
                <div className="project-item-main">
                  <span className="project-item-name">
                    {p.name}
                    {p.missing && <span className="badge badge--warn">missing</span>}
                  </span>
                  <span className="project-item-path" title={p.path}>
                    {p.path}
                  </span>
                </div>
                <button
                  className="project-item-remove"
                  title="Remove from list"
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeProject(p)
                  }}
                >
                  ✕
                </button>
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
                <div className="project-meta">
                  {active.template && <span className="chip">{active.template}</span>}
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
              <div className="panes">
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
                  />
                </section>
                <section className="pane pane--preview">
                  <PreviewPane
                    project={active}
                    deploy={deploys[active.id]}
                    onDeploy={(workspace) => void runDeploy(active.id, workspace)}
                    onCapture={(shot) => addShot(active.id, shot)}
                  />
                </section>
              </div>
            </>
          ) : (
            <div className="content-empty">
              <span className="content-empty-mark">▰</span>
              <h1>Welcome to Rayfin Studio</h1>
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
        <span className="statusbar-item">Rayfin Studio v{versions?.app ?? '—'}</span>
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item">Copilot {auth.copilot.signedIn ? '✓' : '—'}</span>
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item">Fabric {auth.rayfin.signedIn ? '✓' : '—'}</span>
        <span className="statusbar-sep">·</span>
        <span className="statusbar-item">Electron {versions?.electron ?? '—'}</span>
      </footer>

      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={async () => {
            setShowNewProject(false)
            await refreshProjects()
          }}
        />
      )}
    </div>
  )
}
