import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { StudioProject, TeamWorkspace } from '@shared/ipc'
import type { DerivedAdvisor } from '../advisor/lifecycle'
import { useSuppressPreview } from '../overlay'
import { moveMenuFocus } from '../menuFocus'
import { Codicon } from './icons'
import { displayPath } from './projectDisplay'
import { hueOf } from './team/map/parts'

/** The active project's content views, switched from the app bar's tabs. */
export type ProjectView = 'build' | 'code' | 'blueprint' | 'advisor'

const TABS: { id: ProjectView; label: string }[] = [
  { id: 'build', label: 'Build' },
  { id: 'code', label: 'Code' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'advisor', label: 'Advisor' }
]

/** Other projects the switcher lists; Home lists every one. */
const SWITCH_LIMIT = 6

const ITEM = '[role="menuitem"]'

/** A project's initial on its own hue, the same as on Home's project list. */
function ProjectMark({ name, className }: { name: string; className: string }): JSX.Element {
  return (
    <span className={className} aria-hidden="true" style={{ '--hue': hueOf(name) } as CSSProperties}>
      {name.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  )
}

/**
 * The project's identity doubles as the way to switch: it opens a menu of the
 * most recently used projects, and All projects shows Home over the
 * still-running project. A project whose folder is missing can't be opened, so
 * it's left to Home, where it can be managed. The path lives in the tooltip
 * (the OS title bar shows the name).
 */
export function ProjectSwitcher({
  project,
  projects,
  teamWorkspaces,
  onSelect,
  onShowAll
}: {
  project: StudioProject
  /** Every known project, most recently used first. */
  projects: StudioProject[]
  /** Names a team app by its workspace instead of its folder. */
  teamWorkspaces?: TeamWorkspace[]
  onSelect: (project: StudioProject) => void
  /** Show every project on Home. */
  onShowAll: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  // The menu drops over the preview, whose native surface paints above all HTML.
  useSuppressPreview(open)

  // A press anywhere else closes the menu, including another bar menu's trigger.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: Event): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLButtonElement>(ITEM)?.focus()
    )
    return () => cancelAnimationFrame(id)
  }, [open])

  const recent = projects
    .filter((p) => p.id !== project.id && !p.missing)
    .slice(0, SWITCH_LIMIT)
  const teamNames = new Map((teamWorkspaces ?? []).map((w) => [w.id, w.name]))

  const pick = (action: () => void): void => {
    triggerRef.current?.focus()
    setOpen(false)
    action()
  }

  return (
    <div
      className="project-switch"
      ref={rootRef}
      onKeyDown={(e) => {
        if (!open) return
        if (e.key === 'Escape') {
          e.preventDefault()
          setOpen(false)
          triggerRef.current?.focus()
          return
        }
        if (e.key === 'Tab') {
          setOpen(false)
          return
        }
        moveMenuFocus(e, ITEM)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`project-switcher${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${project.name} — Switch projects`}
        title={`${project.path}\nSwitch projects`}
        onClick={() => setOpen((o) => !o)}
      >
        <ProjectMark name={project.name} className="project-switcher-mark" />
        <span className="project-switcher-name">{project.name}</span>
        <Codicon name="chevron-down" className="project-switcher-caret" />
      </button>

      {open && (
        <div className="project-menu">
          <div className={`project-menu-label${recent.length ? '' : ' project-menu-label--empty'}`}>
            {recent.length ? 'Recent projects' : 'No other recent projects'}
          </div>
          <div className="project-menu-items" role="menu" id={menuId} aria-label="Switch projects">
            {recent.map((p) => {
              const team = p.team ? (teamNames.get(p.team.workspaceId) ?? 'Team') : undefined
              return (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className="project-menu-item"
                  aria-label={p.name}
                  title={p.path}
                  onClick={() => pick(() => onSelect(p))}
                >
                  <ProjectMark name={p.name} className="project-menu-mark" />
                  <span className="project-menu-text">
                    <span className="project-menu-name">{p.name}</span>
                    <span className="project-menu-detail">
                      {team ? (
                        <>
                          <Codicon name="organization" />
                          {team}
                        </>
                      ) : (
                        displayPath(p.path)
                      )}
                    </span>
                  </span>
                </button>
              )
            })}
            {recent.length > 0 && <div className="project-menu-sep" role="separator" />}
            <button
              type="button"
              role="menuitem"
              className="project-menu-item"
              onClick={() => pick(onShowAll)}
            >
              <span className="project-menu-icon" aria-hidden="true">
                <Codicon name="home" />
              </span>
              All projects
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Shown on the launcher while a project stays open behind it. */
export function BackToProject({
  name,
  title,
  onClick
}: {
  name: string
  /** Tooltip; defaults to explaining the project kept running. */
  title?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="app-bar-back"
      onClick={onClick}
      title={title ?? `Return to ${name} — it kept running while you browsed projects`}
    >
      <Codicon name="arrow-left" />
      <span className="app-bar-back-label">Back to {name}</span>
    </button>
  )
}

export function ProjectTabs({
  view,
  onChange,
  advisorBadge
}: {
  view: ProjectView
  onChange: (view: ProjectView) => void
  /** Open high/medium Advisor issues, counted on the Advisor tab. */
  advisorBadge: DerivedAdvisor['badge']
}): JSX.Element {
  return (
    <div className="project-tabs" role="tablist" aria-label="Project views">
      {TABS.map((tab) => {
        const badge = tab.id === 'advisor' ? advisorBadge : null
        return (
          <button
            key={tab.id}
            className={`project-tab${view === tab.id ? ' project-tab--active' : ''}`}
            role="tab"
            aria-selected={view === tab.id}
            onClick={() => onChange(tab.id)}
            title={
              tab.id !== 'advisor'
                ? undefined
                : badge
                  ? `Advisor — ${badge.count} open high or medium issue${badge.count === 1 ? '' : 's'}`
                  : 'Advisor'
            }
          >
            {tab.label}
            {badge && (
              <span
                className={`project-tab-badge project-tab-badge--${badge.severity}`}
                aria-label={`${badge.count} open ${badge.count === 1 ? 'issue' : 'issues'}`}
              >
                {badge.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
