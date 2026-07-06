import { useEffect, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import type { StudioProject } from '@shared/ipc'
import { FabricatorMark } from './FabricatorMark'

/** Width used to right-align the floating actions menu to its ⋯ button. */
const MENU_WIDTH = 176

/**
 * Position the actions menu as a fixed overlay anchored to its ⋯ button. The menu
 * is portaled to <body> so it can't be clipped by the recents list's
 * `overflow-y: auto` scroll box (which also clips horizontally); it flips above
 * the button when there isn't room below.
 */
function floatingMenuStyle(rect: DOMRect): CSSProperties {
  const gap = 4
  const estHeight = 124
  const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8))
  const below = rect.bottom + gap
  const openUp = below + estHeight > window.innerHeight - 8
  const top = openUp ? Math.max(8, rect.top - gap - estHeight) : below
  return { position: 'fixed', top, left, right: 'auto' }
}

interface Props {
  /** All known projects, most-recently-used first. */
  projects: StudioProject[]
  /** The project that is currently open/active (still running in the background while
   * this launcher is shown), so it can be flagged as "current". */
  activeId?: string | null
  /** Folder under which new projects are created. */
  workspaceRoot: string
  /** True while an "Open existing…" folder pick is in flight. */
  opening: boolean
  /** Open project whose ⋯ actions menu is showing (shared with the parent's outside-click close). */
  menuOpenId: string | null
  setMenuOpenId: Dispatch<SetStateAction<string | null>>
  /** Inline-rename state for the project currently being renamed. */
  renamingId: string | null
  renameValue: string
  setRenameValue: Dispatch<SetStateAction<string>>
  /** Open (make active) a recent project. */
  onSelect: (p: StudioProject) => void
  onStartRename: (p: StudioProject) => void
  onSubmitRename: (p: StudioProject) => void
  /** Abandon an in-progress inline rename (Escape). */
  onCancelRename: () => void
  onRemoveFromList: (p: StudioProject) => void
  /** Queue a project for the "delete from disk" confirmation. */
  onDeleteFromDisk: (p: StudioProject) => void
  onNewProject: () => void
  onOpenExisting: () => void
  /** Start the "Clone from GitHub" flow (sign in + browse repos + clone). */
  onCloneFromGitHub: () => void
  onChangeWorkspaceRoot: () => void
}

/**
 * The Home / projects landing — shown when no project is active. Replaces the old
 * left sidebar: it offers the "New project" / "Open existing" actions, a Recent
 * projects list (click to open, with a ⋯ menu to rename / remove / delete and inline
 * rename), and the workspace-root control. Reuses the shared `.project-item` /
 * `.project-menu` / `.workspace-root` styles.
 */
export default function HomeView({
  projects,
  activeId,
  workspaceRoot,
  opening,
  menuOpenId,
  setMenuOpenId,
  renamingId,
  renameValue,
  setRenameValue,
  onSelect,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onRemoveFromList,
  onDeleteFromDisk,
  onNewProject,
  onOpenExisting,
  onCloneFromGitHub,
  onChangeWorkspaceRoot
}: Props): JSX.Element {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  // Anchor rect for the "Open existing…" dropdown (folder vs. GitHub). Null = closed.
  const [openMenuRect, setOpenMenuRect] = useState<DOMRect | null>(null)

  // Close the "Open existing…" dropdown on any outside click (the button and the
  // menu itself stopPropagation, so this only fires for genuine outside clicks).
  useEffect(() => {
    if (!openMenuRect) return
    const close = (): void => setOpenMenuRect(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [openMenuRect])

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-head">
          <FabricatorMark className="home-mark" />
          <h1 className="home-title">Welcome to Fabricator</h1>
          <p className="home-sub">
            Create a new Rayfin app or open an existing project to start building with chat.
          </p>
          <div className="home-actions">
            <button className="btn btn--primary" onClick={onNewProject}>
              + New project
            </button>
            <button
              className="btn btn--ghost"
              disabled={opening}
              aria-haspopup="menu"
              aria-expanded={openMenuRect ? true : false}
              onClick={(e) => {
                e.stopPropagation()
                setOpenMenuRect(openMenuRect ? null : e.currentTarget.getBoundingClientRect())
              }}
            >
              {opening ? 'Opening…' : 'Open existing…'}
            </button>
            {openMenuRect &&
              createPortal(
                <div
                  className="project-menu"
                  role="menu"
                  style={floatingMenuStyle(openMenuRect)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="project-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenuRect(null)
                      onOpenExisting()
                    }}
                  >
                    Browse folder…
                  </button>
                  <button
                    className="project-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenuRect(null)
                      onCloneFromGitHub()
                    }}
                  >
                    Clone from GitHub…
                  </button>
                </div>,
                document.body
              )}
          </div>
        </header>

        <section className="home-recents">
          <div className="home-section-title">Recent projects</div>
          {projects.length === 0 ? (
            <div className="home-empty">No projects yet. Create one to get started.</div>
          ) : (
            <div className="home-project-list">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`project-item${p.id === activeId ? ' project-item--active' : ''}${
                    menuOpenId === p.id ? ' project-item--menu-open' : ''
                  }`}
                  onClick={() => {
                    if (renamingId !== p.id) onSelect(p)
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="project-item-mark" aria-hidden="true">
                    {p.name.trim()[0]?.toUpperCase() ?? '?'}
                  </div>
                  <div className="project-item-main">
                    {renamingId === p.id ? (
                      <input
                        className="project-rename-input"
                        value={renameValue}
                        autoFocus
                        spellCheck={false}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => onSubmitRename(p)}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') onSubmitRename(p)
                          else if (e.key === 'Escape') onCancelRename()
                        }}
                      />
                    ) : (
                      <>
                        <span className="project-item-name">
                          {p.name}
                          {p.id === activeId && (
                            <span className="badge badge--accent">current</span>
                          )}
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
                        const next = menuOpenId === p.id ? null : p.id
                        if (next) setAnchorRect(e.currentTarget.getBoundingClientRect())
                        setMenuOpenId(next)
                      }}
                    >
                      ⋯
                    </button>
                    {menuOpenId === p.id &&
                      anchorRect &&
                      createPortal(
                        <div
                          className="project-menu"
                          style={floatingMenuStyle(anchorRect)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button className="project-menu-item" onClick={() => onStartRename(p)}>
                            Rename
                          </button>
                          <button
                            className="project-menu-item"
                            onClick={() => onRemoveFromList(p)}
                          >
                            Remove from list
                          </button>
                          <button
                            className="project-menu-item project-menu-item--danger"
                            onClick={() => onDeleteFromDisk(p)}
                          >
                            Delete from disk…
                          </button>
                        </div>,
                        document.body
                      )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {workspaceRoot && (
          <div className="workspace-root home-workspace">
            <span className="workspace-root-label">Workspace</span>
            <span className="workspace-root-path" title={workspaceRoot}>
              {workspaceRoot}
            </span>
            <button className="btn btn--xs btn--ghost" onClick={onChangeWorkspaceRoot}>
              Change…
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
