import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { AppActionResult, InstalledApp, StudioProject, TeamWorkspace } from '@shared/ipc'
import { useTranslation } from '../i18n'
import { moveMenuFocus } from '../menuFocus'
import type { ProjectRemoval } from '../projectRemovals'
import { FabricatorMark } from './FabricatorMark'
import { AddIcon, BranchIcon, Codicon, FolderIcon, PackageIcon } from './icons'
import InstalledApps from './InstalledApps'
import { displayPath } from './projectDisplay'
import RecentProjects from './RecentProjects'
import TeamSection from './team/TeamSection'
import './models/modelPicker.css'

const MENU_ITEMS = '[role="menuitem"]:not(:disabled)'

/**
 * One Home action for a project that already exists, as a folder on this
 * computer, a repository on GitHub, or a file someone exported: it opens a menu
 * of the three.
 */
function OpenExisting({
  opening,
  onOpenFolder,
  onClone,
  onImportProject
}: {
  opening: boolean
  onOpenFolder: () => void
  onClone: () => void
  onImportProject?: () => void
}): JSX.Element {
  const { t } = useTranslation('home')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', outside)
    const id = requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLElement>(MENU_ITEMS)?.focus()
    )
    return () => {
      window.removeEventListener('mousedown', outside)
      cancelAnimationFrame(id)
    }
  }, [open])

  function close(): void {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function choose(action: () => void): void {
    setOpen(false)
    action()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    moveMenuFocus(event, MENU_ITEMS)
  }

  return (
    <div ref={rootRef} className="home-open">
      <button
        ref={triggerRef}
        type="button"
        className={`home-action${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={opening}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="home-action-icon" aria-hidden="true">
          <FolderIcon className="home-action-svg" />
        </span>
        <span className="home-action-text">
          <span className="home-action-label">
            {opening ? t('openExisting.opening') : t('openExisting.label')}
          </span>
          <span className="home-action-hint">
            {onImportProject ? t('openExisting.hintWithFile') : t('openExisting.hint')}
          </span>
        </span>
        <Codicon name="chevron-down" className="home-action-caret" />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="mp-panel home-open-menu"
          role="menu"
          aria-label={t('openExisting.label')}
          onKeyDown={onKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            className="mp-item"
            onClick={() => choose(onOpenFolder)}
          >
            <FolderIcon className="home-open-icon" />
            <span className="mp-item-text">
              <span className="mp-item-label">{t('openExisting.folder')}</span>
              <span className="mp-item-desc">{t('openExisting.folderDesc')}</span>
            </span>
          </button>
          <button type="button" role="menuitem" className="mp-item" onClick={() => choose(onClone)}>
            <BranchIcon className="home-open-icon" />
            <span className="mp-item-text">
              <span className="mp-item-label">{t('openExisting.clone')}</span>
              <span className="mp-item-desc">{t('openExisting.cloneDesc')}</span>
            </span>
          </button>
          {onImportProject && (
            <button
              type="button"
              role="menuitem"
              className="mp-item"
              onClick={() => choose(onImportProject)}
            >
              <PackageIcon className="home-open-icon" />
              <span className="mp-item-text">
                <span className="mp-item-label">{t('openExisting.import')}</span>
                <span className="mp-item-desc">{t('openExisting.importDesc')}</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

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
  /** Projects being removed in the background, or whose removal stopped, by id. */
  removals?: Readonly<Record<string, ProjectRemoval>>
  /** Run a stopped removal again. */
  onRetryRemoval?: (projectId: string) => void
  /** Forget a stopped removal; the project stays. */
  onDismissRemoval?: (projectId: string) => void
  /** Pin a recent project to the top of the list, or unpin it. */
  onPinProject?: (project: StudioProject, pinned: boolean) => void
  /** Show a project's folder in the file manager. */
  onRevealProject?: (project: StudioProject) => void
  /** Open an address (a published app, its Fabric page) in the browser. */
  onOpenUrl?: (url: string) => void
  /** Open a project and have Copilot update its Rayfin packages to `version`. */
  onUpdateRayfin?: (project: StudioProject, version: string) => void
  /** Projects Fabricator is publishing right now, by id. */
  publishing?: ReadonlySet<string>
  onNewProject: () => void
  onOpenExisting: () => void
  /** Start the sign-in/browse/clone flow. */
  onCloneFromGitHub: () => void
  /** Pick a `.fabricator` file someone exported, and import it. */
  onImportProject?: () => void
  /** Migrate a Power BI report into a new app (experimental); the action shows only when set. */
  onMigrateReport?: () => void
  /** Browse every Rayfin app you can open in Fabric. */
  onOpenGallery: () => void
  onChangeWorkspaceRoot: () => void
  /** Apps installed from `.rayfin` files; the section shows once there's one. */
  installedApps?: {
    apps: InstalledApp[]
    onOpen: (key: string) => void
    onRemove: (key: string) => Promise<AppActionResult>
  }
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
  removals,
  onRetryRemoval,
  onDismissRemoval,
  onPinProject,
  onRevealProject,
  onOpenUrl,
  onUpdateRayfin,
  publishing,
  onNewProject,
  onOpenExisting,
  onCloneFromGitHub,
  onImportProject,
  onMigrateReport,
  onOpenGallery,
  onChangeWorkspaceRoot,
  installedApps,
  team
}: Props): JSX.Element {
  const { t } = useTranslation('home')
  const teamNames = new Map((team?.workspaces ?? []).map((w) => [w.id, w.name]))

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-head">
          <div className="home-brand">
            <FabricatorMark className="home-mark" />
            <div className="home-brand-text">
              <h1 className="home-title">{t('homeView.title')}</h1>
              <p className="home-sub">{t('homeView.sub')}</p>
            </div>
          </div>
          <div className="home-actions" role="group" aria-label={t('homeView.projectActions')}>
            <button
              type="button"
              className="home-action home-action--primary"
              onClick={onNewProject}
            >
              <span className="home-action-icon" aria-hidden="true">
                <AddIcon className="home-action-svg" />
              </span>
              <span className="home-action-text">
                <span className="home-action-label">{t('homeView.newProject')}</span>
                <span className="home-action-hint">{t('homeView.newProjectHint')}</span>
              </span>
            </button>
            <OpenExisting
              opening={opening}
              onOpenFolder={onOpenExisting}
              onClone={onCloneFromGitHub}
              onImportProject={onImportProject}
            />
            <button type="button" className="home-action" onClick={onOpenGallery}>
              <span className="home-action-icon" aria-hidden="true">
                <Codicon name="library" className="home-action-svg" />
              </span>
              <span className="home-action-text">
                <span className="home-action-label">{t('homeView.gallery')}</span>
                <span className="home-action-hint">{t('homeView.galleryHint')}</span>
              </span>
            </button>
            {onMigrateReport && (
              <button type="button" className="home-action" onClick={onMigrateReport}>
                <span className="home-action-icon" aria-hidden="true">
                  <Codicon name="graph" className="home-action-svg" />
                </span>
                <span className="home-action-text">
                  <span className="home-action-label">{t('homeView.migrate')}</span>
                  <span className="home-action-hint">{t('homeView.migrateHint')}</span>
                </span>
              </button>
            )}
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

        <RecentProjects
          projects={projects}
          activeId={activeId}
          teamNames={teamNames}
          removals={removals}
          onRetryRemoval={onRetryRemoval}
          onDismissRemoval={onDismissRemoval}
          onSelect={onSelect}
          onManageProject={onManageProject}
          onPin={onPinProject}
          onReveal={onRevealProject}
          onOpenUrl={onOpenUrl}
          onUpdateRayfin={onUpdateRayfin}
          publishing={publishing}
        />

        {installedApps && (
          <InstalledApps
            apps={installedApps.apps}
            onOpen={installedApps.onOpen}
            onRemove={installedApps.onRemove}
          />
        )}

        {workspaceRoot && (
          <section className="home-workspace" aria-labelledby="home-workspace-title">
            <span id="home-workspace-title" className="home-workspace-label">
              {t('homeView.savedIn')}
            </span>
            <code className="home-workspace-path" title={workspaceRoot}>
              {displayPath(workspaceRoot)}
            </code>
            <button type="button" className="home-workspace-change" onClick={onChangeWorkspaceRoot}>
              {t('homeView.changeFolder')}
            </button>
          </section>
        )}
      </div>
    </div>
  )
}
