import { useState, type CSSProperties } from 'react'
import type { StudioProject, TeamWorkspace } from '@shared/ipc'
import { FabricatorMark } from './FabricatorMark'
import { AddIcon, BranchIcon, FolderIcon, GearIcon } from './icons'
import { displayPath } from './projectDisplay'
import TeamSection from './team/TeamSection'
import { hueOf } from './team/map/parts'

/** Recent projects shown before "Show all". */
const RECENT_LIMIT = 6

interface Props {
  /** All known projects, most-recently-used first. */
  projects: StudioProject[]
  /** The project currently open behind the launcher. */
  activeId?: string | null
  /** Folder under which new projects are created. */
  workspaceRoot: string
  /** True while a folder picker is in flight. */
  opening: boolean
  /** Open (make active) a recent project. */
  onSelect: (project: StudioProject) => void
  /** Open focused management for a recent project. */
  onManageProject: (project: StudioProject) => void
  onNewProject: () => void
  onOpenExisting: () => void
  /** Start the sign-in/browse/clone flow. */
  onCloneFromGitHub: () => void
  onChangeWorkspaceRoot: () => void
  /** Team workspaces (experimental); the section shows only when set. */
  team?: {
    workspaces: TeamWorkspace[]
    onOpened: (project: StudioProject) => void
    onNewApp: (workspaceId: string) => void
    /** Open a workspace's overview. */
    onOpenMap?: (workspaceId: string, manage?: boolean) => void
    onChanged: () => void
  }
}

/** The Home / projects landing shown when no project is active. */
export default function HomeView({
  projects,
  activeId,
  workspaceRoot,
  opening,
  onSelect,
  onManageProject,
  onNewProject,
  onOpenExisting,
  onCloneFromGitHub,
  onChangeWorkspaceRoot,
  team
}: Props): JSX.Element {
  const projectCount = `${projects.length} project${projects.length === 1 ? '' : 's'}`
  const teamNames = new Map((team?.workspaces ?? []).map((w) => [w.id, w.name]))
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? projects : projects.slice(0, RECENT_LIMIT)

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-head">
          <div className="home-brand">
            <FabricatorMark className="home-mark" />
            <div>
              <p className="home-eyebrow">Fabricator</p>
              <h1 className="home-title">Your projects</h1>
            </div>
          </div>
          <p className="home-sub">
            Start a new Rayfin app, open a local project, or pick up where you left off.
          </p>
          <div className="home-actions" aria-label="Project actions">
            <button
              type="button"
              className="home-action home-action--primary"
              onClick={onNewProject}
            >
              <span className="home-action-icon" aria-hidden="true">
                <AddIcon className="home-action-svg" />
              </span>
              <span className="home-action-text">
                <span className="home-action-label">New project</span>
                <span className="home-action-hint">Describe it and Copilot builds it</span>
              </span>
            </button>
            <button
              type="button"
              className="home-action"
              disabled={opening}
              onClick={onOpenExisting}
            >
              <span className="home-action-icon" aria-hidden="true">
                <FolderIcon className="home-action-svg" />
              </span>
              <span className="home-action-text">
                <span className="home-action-label">
                  {opening ? 'Opening folder...' : 'Open folder'}
                </span>
                <span className="home-action-hint">Use an existing local project</span>
              </span>
            </button>
            <button type="button" className="home-action" onClick={onCloneFromGitHub}>
              <span className="home-action-icon" aria-hidden="true">
                <BranchIcon className="home-action-svg" />
              </span>
              <span className="home-action-text">
                <span className="home-action-label">Clone from GitHub</span>
                <span className="home-action-hint">Bring a repository into Fabricator</span>
              </span>
            </button>
          </div>
        </header>

        {team && (
          <TeamSection
            workspaces={team.workspaces}
            onOpened={team.onOpened}
            onNewApp={team.onNewApp}
            onOpenMap={team.onOpenMap}
            onChanged={team.onChanged}
          />
        )}

        <section className="home-recents" aria-labelledby="recent-projects-title">
          <div className="home-section-heading">
            <h2 id="recent-projects-title">Recent projects</h2>
            <span className="home-project-count">{projectCount}</span>
          </div>

          {projects.length === 0 ? (
            <div className="home-empty">
              <div className="home-empty-mark" aria-hidden="true">
                <FabricatorMark />
              </div>
              <p className="home-empty-title">No recent projects</p>
              <p className="home-empty-sub">
                Start a new app, open one from disk, or clone a repository to see it here.
              </p>
            </div>
          ) : (
            <div className="home-project-list" role="list">
              {shown.map((project) => {
                const teamName = project.team ? (teamNames.get(project.team.workspaceId) ?? 'Team') : undefined
                return (
                  <article
                    key={project.id}
                    className={`home-project${project.id === activeId ? ' home-project--active' : ''}${
                      project.missing ? ' home-project--missing' : ''
                    }`}
                    role="listitem"
                  >
                    <button
                      type="button"
                      className="home-project-open"
                      aria-label={`Open ${project.name}`}
                      onClick={() => onSelect(project)}
                    >
                      <span
                        className="home-project-mark"
                        aria-hidden="true"
                        style={{ '--hue': hueOf(project.name) } as CSSProperties}
                      >
                        {project.name.trim()[0]?.toUpperCase() ?? '?'}
                      </span>
                      <span className="home-project-main">
                        <span className="home-project-name">
                          <span className="home-project-title">{project.name}</span>
                          {project.id === activeId && (
                            <span className="home-project-status home-project-status--active">
                              Open now
                            </span>
                          )}
                          {project.missing && (
                            <span className="home-project-status home-project-status--missing">
                              Missing
                            </span>
                          )}
                        </span>
                        <span className="home-project-path" title={project.path}>
                          {teamName ? (
                            <>
                              <span className="codicon codicon-organization" aria-hidden="true" />
                              {teamName} · saved to GitHub as you work
                            </>
                          ) : (
                            displayPath(project.path)
                          )}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="home-project-manage"
                      aria-label={`Manage ${project.name}`}
                      title="Manage"
                      onClick={() => onManageProject(project)}
                    >
                      <GearIcon className="home-project-manage-icon" />
                    </button>
                  </article>
                )
              })}
            </div>
          )}
          {projects.length > RECENT_LIMIT && (
            <button type="button" className="home-show-all" onClick={() => setShowAll((s) => !s)}>
              {showAll ? 'Show fewer' : `Show all ${projects.length} projects`}
            </button>
          )}
        </section>

        {workspaceRoot && (
          <section className="home-workspace" aria-labelledby="home-workspace-title">
            <span id="home-workspace-title" className="home-workspace-label">
              New projects are saved in
            </span>
            <code className="home-workspace-path" title={workspaceRoot}>
              {displayPath(workspaceRoot)}
            </code>
            <button type="button" className="home-workspace-change" onClick={onChangeWorkspaceRoot}>
              Change folder
            </button>
          </section>
        )}
      </div>
    </div>
  )
}
