import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import type { StudioProject } from '@shared/ipc'
import { isMac } from '../platform'
import { useProjectFacts } from '../projectFacts'
import { removalStatus, type ProjectRemoval } from '../projectRemovals'
import { useThumbnails } from '../thumbnails'
import { ContextMenu, type ContextMenuEntry } from './ContextMenu'
import { FabricatorMark } from './FabricatorMark'
import { Codicon, GearIcon } from './icons'
import { displayPath } from './projectDisplay'
import { ProjectTile } from './ProjectTile'
import {
  groupProjects,
  matchesProject,
  openedText,
  projectLinks,
  publishState,
  rayfinUpdate
} from './recentProjectsModel'
import { useNow } from './team/runProgress'

/** Recent projects shown before "Show all", besides the pinned ones. */
export const RECENT_LIMIT = 6

const FILE_MANAGER = isMac() ? 'Finder' : 'Explorer'

interface Props {
  /** All known projects, most-recently-used first. */
  projects: StudioProject[]
  /** The project currently open behind the launcher. */
  activeId?: string | null
  /** Team workspaces' names, by id. */
  teamNames: ReadonlyMap<string, string>
  /** Projects being removed in the background, or whose removal stopped, by id. */
  removals?: Readonly<Record<string, ProjectRemoval>>
  onRetryRemoval?: (projectId: string) => void
  onDismissRemoval?: (projectId: string) => void
  onSelect: (project: StudioProject) => void
  onManageProject: (project: StudioProject) => void
  /** Pin a project to the top of the list, or unpin it. */
  onPin?: (project: StudioProject, pinned: boolean) => void
  /** Show a project's folder in the file manager. */
  onReveal?: (project: StudioProject) => void
  /** Open an address in the browser. */
  onOpenUrl?: (url: string) => void
  /** Open the project and have Copilot update its Rayfin packages to `version`. */
  onUpdateRayfin?: (project: StudioProject, version: string) => void
  /** Projects Fabricator is publishing right now, by id. */
  publishing?: ReadonlySet<string>
}

interface MenuAt {
  project: StudioProject
  x: number
  y: number
  /** What had the focus, to give it back. */
  from: HTMLElement | null
}

const OPEN = '.home-project-open:not(:disabled)'

/** Home's list of recent projects: what each is, how it stands, and what you can do with it. */
export default function RecentProjects({
  projects,
  activeId,
  teamNames,
  removals,
  onRetryRemoval,
  onDismissRemoval,
  onSelect,
  onManageProject,
  onPin,
  onReveal,
  onOpenUrl,
  onUpdateRayfin,
  publishing
}: Props): JSX.Element {
  const headingId = useId()
  const [showAll, setShowAll] = useState(false)
  const [text, setText] = useState('')
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  // Ticks while a folder moves to trash, which reports no progress of its own.
  const now = useNow(Object.values(removals ?? {}).some((r) => r.trashingSince && !r.error))
  const facts = useProjectFacts(projects)
  const thumbnail = useThumbnails(projects)

  const filtering = text.trim().length > 0
  const teamName = useCallback(
    (project: StudioProject): string | undefined =>
      project.team ? (teamNames.get(project.team.workspaceId) ?? 'Team') : undefined,
    [teamNames]
  )
  const matches = filtering
    ? projects.filter((p) => matchesProject(p, text, teamName(p)))
    : projects
  const unpinned = matches.filter((p) => !p.pinned)
  const hidden = filtering || showAll ? 0 : Math.max(0, unpinned.length - RECENT_LIMIT)
  const kept = new Set(unpinned.slice(0, unpinned.length - hidden).map((p) => p.id))
  const shown = matches.filter((p) => p.pinned || kept.has(p.id))
  const groups = groupProjects(shown, now)
  const offerFilter = projects.length > RECENT_LIMIT

  // "/" jumps to the filter, as in the gallery.
  useEffect(() => {
    if (!offerFilter) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))
        return
      if (document.querySelector('.modal-backdrop, .spotlight')) return
      event.preventDefault()
      filterRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [offerFilter])

  const closeMenu = useCallback((): void => {
    setMenu((open) => {
      if (open?.from?.isConnected) requestAnimationFrame(() => open.from?.focus())
      return null
    })
  }, [])

  function openMenu(project: StudioProject, x: number, y: number): void {
    setMenu({ project, x, y, from: document.activeElement as HTMLElement | null })
  }

  function menuEntries(project: StudioProject): ContextMenuEntry[] {
    const links = projectLinks(project)
    const update = rayfinUpdate(project, facts.latest)
    const entries: ContextMenuEntry[] = [
      { id: 'open', label: 'Open', icon: 'go-to-file', run: () => onSelect(project) }
    ]
    if (links.app && onOpenUrl)
      entries.push({
        id: 'app',
        label: 'Open app',
        icon: 'link-external',
        run: () => onOpenUrl(links.app ?? '')
      })
    if (links.portal && onOpenUrl)
      entries.push({
        id: 'fabric',
        label: 'Open in Fabric',
        icon: 'globe',
        run: () => onOpenUrl(links.portal ?? '')
      })
    entries.push('separator')
    if (onReveal && !project.missing)
      entries.push({
        id: 'reveal',
        label: `Show in ${FILE_MANAGER}`,
        icon: 'folder-opened',
        run: () => onReveal(project)
      })
    entries.push({
      id: 'copy',
      label: 'Copy folder path',
      icon: 'copy',
      run: () => void navigator.clipboard?.writeText(project.path).catch(() => undefined)
    })
    if (onPin)
      entries.push({
        id: 'pin',
        label: project.pinned ? 'Unpin' : 'Pin to the top',
        icon: project.pinned ? 'pinned' : 'pin',
        run: () => onPin(project, !project.pinned)
      })
    if (update && onUpdateRayfin)
      entries.push({
        id: 'update',
        label: 'Update Rayfin',
        detail: update,
        icon: 'arrow-up',
        run: () => onUpdateRayfin(project, update)
      })
    entries.push('separator', {
      id: 'manage',
      label: 'Manage…',
      icon: 'gear',
      run: () => onManageProject(project)
    })
    return entries
  }

  /** Up and down move between projects; right and left between a project and its actions. */
  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement
    const row = target.closest<HTMLElement>('.home-project')
    if (!row) return
    if (
      target.matches('.home-project-open') &&
      (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
    ) {
      const project = projects.find((p) => p.id === row.dataset.projectId)
      if (!project) return
      event.preventDefault()
      const box = row.getBoundingClientRect()
      openMenu(project, box.left + 48, box.top + box.height / 2)
      return
    }
    const opens = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(OPEN))
    const rowOpen = row.querySelector<HTMLButtonElement>(OPEN)
    const index = rowOpen ? opens.indexOf(rowOpen) : -1
    const go = (i: number): void => {
      event.preventDefault()
      opens[Math.max(0, Math.min(opens.length - 1, i))]?.focus()
    }
    switch (event.key) {
      case 'ArrowDown':
        return go(index + 1)
      case 'ArrowUp':
        return go(index - 1)
      case 'Home':
        if (target.matches('.home-project-open')) go(0)
        return
      case 'End':
        if (target.matches('.home-project-open')) go(opens.length - 1)
        return
      case 'ArrowRight':
      case 'ArrowLeft': {
        const controls = [
          rowOpen,
          ...row.querySelectorAll<HTMLButtonElement>('.home-project-control:not(:disabled)')
        ].filter((c): c is HTMLButtonElement => Boolean(c))
        const at = controls.indexOf(target as HTMLButtonElement)
        if (at < 0) return
        const to = controls[at + (event.key === 'ArrowRight' ? 1 : -1)]
        if (!to) return
        event.preventDefault()
        to.focus()
        return
      }
    }
  }

  function row(project: StudioProject): JSX.Element {
    const team = teamName(project)
    const removal = removals?.[project.id]
    const removing = Boolean(removal && !removal.error)
    const stopped = Boolean(removal?.error)
    const status = removal ? removalStatus(removal, now) : ''
    const active = project.id === activeId
    const publish =
      removal || project.missing
        ? null
        : publishState(project, {
            changed: facts.changed.get(project.id),
            publishing: publishing?.has(project.id)
          })
    const update = removal ? null : rayfinUpdate(project, facts.latest)
    const links = projectLinks(project)
    // The open project says "Open now" instead.
    const opened = active ? undefined : openedText(project, Date.now())
    const running = !active && facts.running.has(project.id)
    const className = [
      'home-project',
      active && 'home-project--active',
      project.missing && 'home-project--missing',
      removing && 'home-project--removing',
      stopped && 'home-project--stopped'
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <article
        key={project.id}
        className={className}
        role="listitem"
        aria-busy={removing || undefined}
        data-project-id={project.id}
        onContextMenu={(event: MouseEvent) => {
          if (removing) return
          event.preventDefault()
          openMenu(project, event.clientX, event.clientY)
        }}
      >
        <ProjectTile
          name={project.name}
          thumbnail={thumbnail(project.id)}
          className="home-project-tile"
        />
        <div className="home-project-main">
          <span className="home-project-name">
            <button
              type="button"
              className="home-project-open"
              aria-label={`Open ${project.name}`}
              disabled={removing}
              onClick={() => onSelect(project)}
            >
              <span className="home-project-title">{project.name}</span>
            </button>
            {removing ? (
              <span className="home-project-status home-project-status--removing">Removing</span>
            ) : stopped ? (
              <span className="home-project-status home-project-status--stopped">Not removed</span>
            ) : (
              <>
                {active && (
                  <span className="home-project-status home-project-status--active">Open now</span>
                )}
                {running && (
                  <span
                    className="home-project-status home-project-status--running"
                    title="Its backend runs on this computer"
                  >
                    Running locally
                  </span>
                )}
                {project.missing && (
                  <span className="home-project-status home-project-status--missing">Missing</span>
                )}
              </>
            )}
          </span>
          {removal ? (
            <span className="home-project-removal" title={status}>
              {removing && <span className="home-project-spin" aria-hidden="true" />}
              <span className="home-project-removal-text">{status}</span>
            </span>
          ) : (
            <span className="home-project-meta">
              <span className="home-project-path" title={project.path}>
                {team ? (
                  <>
                    <span className="codicon codicon-organization" aria-hidden="true" />
                    {team} · saved to GitHub as you work
                  </>
                ) : (
                  displayPath(project.path)
                )}
              </span>
              {publish && (
                <span
                  className={`home-project-publish home-project-publish--${publish.kind}`}
                  title={publish.title}
                >
                  {publish.label}
                </span>
              )}
              {update && (
                <span className="home-project-version" title={`Rayfin ${update} is available`}>
                  Rayfin {project.rayfinVersion}
                  {onUpdateRayfin && (
                    <>
                      <span aria-hidden="true"> · </span>
                      <button
                        type="button"
                        className="home-project-update home-project-control"
                        aria-label={`Update Rayfin in ${project.name} to ${update}`}
                        title={`Open ${project.name} and have Copilot update Rayfin to ${update}`}
                        onClick={() => onUpdateRayfin(project, update)}
                      >
                        Update
                      </button>
                    </>
                  )}
                </span>
              )}
            </span>
          )}
        </div>
        {stopped ? (
          <span className="home-project-removal-actions">
            <button
              type="button"
              className="btn btn--sm home-project-control"
              aria-label={`Try again to remove ${project.name}`}
              onClick={() => onRetryRemoval?.(project.id)}
            >
              Try again
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost home-project-control"
              aria-label={`Keep ${project.name}`}
              onClick={() => onDismissRemoval?.(project.id)}
            >
              Keep
            </button>
          </span>
        ) : (
          !removing && (
            <div className="home-project-side">
              {opened && <span className="home-project-when">{opened}</span>}
              <span className="home-project-actions">
                {links.app && onOpenUrl && (
                  <button
                    type="button"
                    className="home-project-action home-project-control"
                    tabIndex={-1}
                    aria-label={`Open ${project.name}’s app`}
                    title="Open app"
                    onClick={() => onOpenUrl(links.app ?? '')}
                  >
                    <Codicon name="link-external" />
                  </button>
                )}
                {links.portal && onOpenUrl && (
                  <button
                    type="button"
                    className="home-project-action home-project-control"
                    tabIndex={-1}
                    aria-label={`Open ${project.name} in Fabric`}
                    title="Open in Fabric"
                    onClick={() => onOpenUrl(links.portal ?? '')}
                  >
                    <Codicon name="globe" />
                  </button>
                )}
                {onReveal && !project.missing && (
                  <button
                    type="button"
                    className="home-project-action home-project-control"
                    tabIndex={-1}
                    aria-label={`Show ${project.name} in ${FILE_MANAGER}`}
                    title={`Show in ${FILE_MANAGER}`}
                    onClick={() => onReveal(project)}
                  >
                    <Codicon name="folder-opened" />
                  </button>
                )}
                {onPin && (
                  <button
                    type="button"
                    className={`home-project-action home-project-control${project.pinned ? ' is-on' : ''}`}
                    tabIndex={-1}
                    aria-label={`${project.pinned ? 'Unpin' : 'Pin'} ${project.name}`}
                    aria-pressed={Boolean(project.pinned)}
                    title={project.pinned ? 'Unpin' : 'Pin to the top'}
                    onClick={() => onPin(project, !project.pinned)}
                  >
                    <Codicon name={project.pinned ? 'pinned' : 'pin'} />
                  </button>
                )}
                <button
                  type="button"
                  className="home-project-manage home-project-control"
                  aria-label={`Manage ${project.name}`}
                  title="Manage"
                  onClick={() => onManageProject(project)}
                >
                  <GearIcon className="home-project-manage-icon" />
                </button>
              </span>
            </div>
          )
        )}
      </article>
    )
  }

  const count = `${projects.length} project${projects.length === 1 ? '' : 's'}`
  const titled = groups.length > 1

  return (
    <section className="home-recents" aria-labelledby={headingId}>
      <div className="home-section-heading">
        <h2 id={headingId}>Recent projects</h2>
        <span className="home-recents-tools">
          {offerFilter && (
            <label className="home-filter">
              <Codicon name="filter" className="home-filter-ico" />
              <input
                ref={filterRef}
                className="home-filter-input"
                type="search"
                value={text}
                spellCheck={false}
                placeholder="Filter projects"
                aria-label="Filter projects"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && text) {
                    e.preventDefault()
                    e.stopPropagation()
                    setText('')
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    document.querySelector<HTMLButtonElement>(`.home-recents ${OPEN}`)?.focus()
                  }
                }}
              />
              {!text && (
                <kbd className="home-filter-key" aria-hidden="true">
                  /
                </kbd>
              )}
            </label>
          )}
          <span className="home-project-count">
            {filtering ? `${matches.length} of ${count}` : count}
          </span>
        </span>
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
      ) : matches.length === 0 ? (
        <div className="home-empty home-empty--filter">
          <p className="home-empty-title">No projects match “{text.trim()}”</p>
          <button type="button" className="btn btn--sm" onClick={() => setText('')}>
            Clear filter
          </button>
        </div>
      ) : (
        <div className="home-project-list" onKeyDown={onListKeyDown}>
          {groups.map((group) => (
            <Fragment key={group.key}>
              {titled && (
                <h3 className="home-group-head" id={`${headingId}-${group.key}`}>
                  {group.key === 'pinned' && <Codicon name="pinned" />}
                  {group.label}
                </h3>
              )}
              <div
                className="home-group"
                role="list"
                aria-labelledby={titled ? `${headingId}-${group.key}` : headingId}
              >
                {group.projects.map(row)}
              </div>
            </Fragment>
          ))}
        </div>
      )}
      {(hidden > 0 || (showAll && !filtering && unpinned.length > RECENT_LIMIT)) && (
        <button type="button" className="home-show-all" onClick={() => setShowAll((s) => !s)}>
          {showAll ? 'Show fewer' : `Show all ${projects.length} projects`}
        </button>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.project.name}
          entries={menuEntries(menu.project)}
          onClose={closeMenu}
        />
      )}
    </section>
  )
}
