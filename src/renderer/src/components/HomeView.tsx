import type { StudioProject } from '@shared/ipc'
import { FabricatorMark } from './FabricatorMark'
import { AddIcon, BranchIcon, FolderIcon, GearIcon, ReportIcon } from './icons'

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
  /** Open the "pick a workspace, then a report" Power BI migration flow. */
  onMigratePowerBIReport: () => void
  onChangeWorkspaceRoot: () => void
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
  onMigratePowerBIReport,
  onChangeWorkspaceRoot
}: Props): JSX.Element {
  const projectCount = `${projects.length} project${projects.length === 1 ? '' : 's'}`

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
            Start a Rayfin app from a template, open a local project, or pick up where you left off.
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
                <span className="home-action-hint">Start with a Rayfin template</span>
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
            <button type="button" className="home-action" onClick={onMigratePowerBIReport}>
              <span className="home-action-icon" aria-hidden="true">
                <ReportIcon className="home-action-svg" />
              </span>
              <span className="home-action-text">
                <span className="home-action-label">Migrate Power BI Report</span>
                <span className="home-action-hint">Bring a Power BI report into Fabricator</span>
              </span>
            </button>
          </div>
        </header>

        <section className="home-recents" aria-labelledby="recent-projects-title">
          <div className="home-section-heading">
            <div>
              <p className="home-section-eyebrow">Workspace</p>
              <h2 id="recent-projects-title">Recent projects</h2>
            </div>
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
              {projects.map((project) => (
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
                    <span className="home-project-mark" aria-hidden="true">
                      {project.name.trim()[0]?.toUpperCase() ?? '?'}
                    </span>
                    <span className="home-project-main">
                      <span className="home-project-name">
                        {project.name}
                        {project.id === activeId && (
                          <span className="home-project-status home-project-status--active">
                            Current
                          </span>
                        )}
                        {project.missing && (
                          <span className="home-project-status home-project-status--missing">
                            Missing
                          </span>
                        )}
                      </span>
                      <span className="home-project-path" title={project.path}>
                        {project.path}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="home-project-manage"
                    aria-label={`Manage ${project.name}`}
                    onClick={() => onManageProject(project)}
                  >
                    <GearIcon className="home-project-manage-icon" />
                    Manage
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        {workspaceRoot && (
          <section className="home-workspace" aria-labelledby="home-workspace-title">
            <div className="home-workspace-details">
              <span id="home-workspace-title" className="home-workspace-label">
                New project location
              </span>
              <code className="home-workspace-path" title={workspaceRoot}>
                {workspaceRoot}
              </code>
            </div>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={onChangeWorkspaceRoot}
            >
              Change folder
            </button>
          </section>
        )}
      </div>
    </div>
  )
}
