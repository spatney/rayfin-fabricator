/**
 * What Home's recent projects say about each project, from what Fabricator
 * already knows: its last publish, whether its folder changed since, its
 * Rayfin version against the newest, when it was last opened, and the groups
 * and filter the list shows them in.
 */
import type { RayfinLatest, StudioProject } from '@shared/ipc'
import { newerRelease } from '../localDevelopment'
import { ago, fullDate } from './gallery/model'

export type PublishKind = 'published' | 'changes' | 'failed' | 'publishing' | 'unpublished'

/** A project's publish status: a small dot and a word. */
export interface PublishState {
  kind: PublishKind
  label: string
  /** More about it, for the tooltip. */
  title?: string
}

function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/**
 * A project's publish status: from its last publish (a team app's, from its
 * production deployment), and `changed`, whether its folder changed since
 * (when known). `publishing` while Fabricator is publishing it now.
 */
export function publishState(
  project: StudioProject,
  {
    changed,
    publishing = false,
    now = Date.now()
  }: { changed?: boolean; publishing?: boolean; now?: number } = {}
): PublishState {
  if (publishing) return { kind: 'publishing', label: 'Publishing…' }
  if (project.team) {
    const production = project.team.production
    switch (production?.state) {
      case 'success': {
        const when = ago(production.updatedAt, now)
        return {
          kind: 'published',
          label: when ? `Published ${when}` : 'Published',
          title: fullDate(production.updatedAt)
        }
      }
      case 'failure':
      case 'error':
        return {
          kind: 'failed',
          label: 'Publish failed',
          title: 'The team’s pipeline couldn’t publish it.'
        }
      case 'in_progress':
      case 'queued':
      case 'pending':
        return { kind: 'publishing', label: 'Publishing…' }
      default:
        return { kind: 'unpublished', label: 'Not published' }
    }
  }
  const deploy = project.lastDeploy
  switch (deploy?.status) {
    case 'success': {
      const when = ago(deploy.at, now)
      const published = when ? `Published ${when}` : 'Published'
      if (changed) {
        return {
          kind: 'changes',
          label: 'Changes not published',
          title: `${published}. It has changed since.`
        }
      }
      return { kind: 'published', label: published, title: fullDate(deploy.at) }
    }
    case 'error':
      return {
        kind: 'failed',
        label: 'Publish failed',
        title: deploy.error ? sentence(deploy.error) : 'The last publish didn’t finish.'
      }
    default:
      // A publish that was cancelled, or never finished, leaves the last one live.
      return deploy?.url
        ? { kind: 'published', label: 'Published' }
        : { kind: 'unpublished', label: 'Not published' }
  }
}

/** Only `https`/`http` addresses are opened. */
function webUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

/** Where a project's published app is: its own address, and its page in Fabric. */
export function projectLinks(project: StudioProject): { app?: string; portal?: string } {
  const source = project.team ? project.team.production : project.lastDeploy
  const portal = webUrl(source?.portalUrl)
  const app = webUrl(source?.url)
  // The app's own address, when it has one besides its Fabric page.
  return { app: app && app !== portal ? app : undefined, portal }
}

/**
 * The Rayfin version a project could update to, or `null`: updates stop at the
 * newest release the local backend runs, so the app keeps running on this
 * computer (a team app too). Nothing while either version isn't known.
 */
export function rayfinUpdate(
  project: StudioProject,
  latest: RayfinLatest | null | undefined
): string | null {
  if (!project.rayfinVersion || project.missing || !latest) return null
  const target = latest.latestSupportedLocally
  return target && newerRelease(target, project.rayfinVersion) ? target : null
}

/** "Opened 3 hours ago", or nothing before it's been opened since Fabricator kept track. */
export function openedText(project: StudioProject, now = Date.now()): string | undefined {
  const when = ago(project.lastOpenedAt, now)
  return when ? `Opened ${when}` : undefined
}

export type ProjectGroupKey = 'pinned' | 'today' | 'week' | 'earlier'

export interface ProjectGroup {
  key: ProjectGroupKey
  label: string
  projects: StudioProject[]
}

const GROUP_LABELS: Record<ProjectGroupKey, string> = {
  pinned: 'Pinned',
  today: 'Today',
  week: 'This week',
  earlier: 'Earlier'
}

/** Midnight at the start of `now`'s day, where the user is. */
function startOfDay(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * The projects in Home's groups, each keeping the list's order (most recently
 * used first): pinned ones, then by when they were last opened — today, in
 * the last seven days, and earlier (or before Fabricator kept track). Empty
 * groups are left out.
 */
export function groupProjects(
  projects: readonly StudioProject[],
  now = Date.now()
): ProjectGroup[] {
  const today = startOfDay(now)
  const week = today - 6 * 86_400_000
  const groups: Record<ProjectGroupKey, StudioProject[]> = {
    pinned: [],
    today: [],
    week: [],
    earlier: []
  }
  for (const project of projects) {
    const opened = project.lastOpenedAt ? Date.parse(project.lastOpenedAt) : NaN
    const key: ProjectGroupKey = project.pinned
      ? 'pinned'
      : opened >= today
        ? 'today'
        : opened >= week
          ? 'week'
          : 'earlier'
    groups[key].push(project)
  }
  return (Object.keys(groups) as ProjectGroupKey[])
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], projects: groups[key] }))
}

/**
 * Whether a project matches a filter: every word appears in its name, its
 * folder, or its team workspace's name.
 */
export function matchesProject(project: StudioProject, text: string, teamName?: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = [project.name, project.path, teamName].filter(Boolean).join('\n').toLowerCase()
  return words.every((word) => haystack.includes(word))
}
