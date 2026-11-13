import { describe, expect, it } from 'vitest'
import { makeProject } from '../../test/harness'
import {
  groupProjects,
  matchesProject,
  projectLinks,
  publishState,
  rayfinUpdate
} from './recentProjectsModel'

const NOON = new Date('2026-11-03T12:00:00').getTime()
const DAY = 86_400_000

describe('a recent project’s publish status', () => {
  it('reads a team app’s from its production deployment', () => {
    const team = (state?: string) =>
      makeProject('t', {
        lastDeploy: undefined,
        team: {
          workspaceId: 'w',
          folder: 'trips',
          worktree: 'C:/t',
          production: state
            ? {
                environment: 'production/trips',
                state,
                updatedAt: new Date(NOON - DAY).toISOString()
              }
            : undefined
        }
      })
    expect(publishState(team('success'), { now: NOON }).label).toBe('Published yesterday')
    expect(publishState(team('failure'), { now: NOON }).kind).toBe('failed')
    expect(publishState(team('queued'), { now: NOON }).label).toBe('Publishing…')
    expect(publishState(team(), { now: NOON }).label).toBe('Not published')
  })

  it('keeps a published app published when a later publish was cancelled', () => {
    const cancelled = makeProject('p', {
      lastDeploy: { status: 'cancelled', url: 'https://p.example.app' }
    })
    expect(publishState(cancelled).label).toBe('Published')
    expect(publishState(cancelled, { publishing: true }).kind).toBe('publishing')
  })
})

describe('a recent project’s links and updates', () => {
  it('opens the app’s own address, but not when it’s only its Fabric page', () => {
    const portal = 'https://app.fabric.microsoft.com/groups/w/appbackends/i'
    expect(
      projectLinks(
        makeProject('p', { lastDeploy: { url: 'https://p.example.app', portalUrl: portal } })
      )
    ).toEqual({
      app: 'https://p.example.app',
      portal
    })
    expect(
      projectLinks(makeProject('p', { lastDeploy: { url: portal, portalUrl: portal } }))
    ).toEqual({ portal })
    expect(projectLinks(makeProject('p', { lastDeploy: { url: 'javascript:alert(1)' } }))).toEqual(
      {}
    )
  })

  it('offers no update while either version isn’t known', () => {
    const project = makeProject('p', { rayfinVersion: '1.35.1' })
    expect(rayfinUpdate(project, null)).toBeNull()
    expect(rayfinUpdate(project, { latest: '1.37.0' })).toBeNull()
    expect(rayfinUpdate(makeProject('p'), { recommended: '1.36.2' })).toBeNull()
    expect(rayfinUpdate({ ...project, missing: true }, { recommended: '1.36.2' })).toBeNull()
  })
})

describe('recent projects’ groups and filter', () => {
  it('splits by the day they were last opened, where the user is', () => {
    const at = (offset: number) => new Date(NOON + offset).toISOString()
    const projects = [
      makeProject('a', { lastOpenedAt: at(-11 * 3_600_000) }),
      makeProject('b', { lastOpenedAt: at(-13 * 3_600_000) }),
      makeProject('c', { lastOpenedAt: at(-6 * DAY) }),
      makeProject('d', { lastOpenedAt: at(-7 * DAY) }),
      makeProject('e')
    ]
    expect(
      groupProjects(projects, NOON).map((g) => [g.label, g.projects.map((p) => p.id)])
    ).toEqual([
      ['Today', ['a']],
      ['This week', ['b', 'c']],
      ['Earlier', ['d', 'e']]
    ])
  })

  it('needs every word in the name, the folder or the team', () => {
    const project = makeProject('p', { name: 'Care Operations', path: 'C:/apps/local-todo' })
    expect(matchesProject(project, 'care local')).toBe(true)
    expect(matchesProject(project, 'ops team', 'Ops team')).toBe(true)
    expect(matchesProject(project, 'care nothing')).toBe(false)
    expect(matchesProject(project, '  ')).toBe(true)
  })
})
