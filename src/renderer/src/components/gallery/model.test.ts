import { describe, expect, it } from 'vitest'
import type { GalleryApp } from '@shared/ipc'
import {
  ago,
  applyQuery,
  groupByWorkspace,
  initials,
  rankWorkspaces,
  score,
  splitWorkspaceName,
  terms,
  workspacesOf,
  workspaceTitle,
  type GalleryQuery
} from './model'

function app(id: string, name: string, over: Partial<GalleryApp> = {}): GalleryApp {
  return {
    id,
    name,
    workspaceId: 'ws-sales',
    workspaceName: 'Sales',
    portalUrl: `https://app.fabric.microsoft.com/groups/ws-sales/appbackends/${id}`,
    ...over
  }
}

const apps = [
  app('a', 'expense-tracker', {
    description: 'Team expenses and approvals',
    local: { projectId: 'p1', projectName: 'Expenses' }
  }),
  app('b', 'sales-dashboard'),
  app('c', 'Trip logger', {
    workspaceId: 'ws-trips',
    workspaceName: 'Travel',
    team: { workspaceId: 't1', name: 'Trips team', preview: false }
  }),
  app('d', 'dashboard-sales-old', { workspaceId: 'ws-archive', workspaceName: 'Archive' })
]
const query = (over: Partial<GalleryQuery> = {}): GalleryQuery => ({
  text: '',
  where: 'all',
  workspaceId: null,
  sort: 'name',
  pinned: [],
  ...over
})
const names = (q: GalleryQuery, statuses = {}): string[] =>
  applyQuery(apps, statuses, q).map((e) => e.app.name)

describe('gallery search', () => {
  it('needs every word somewhere in the app, its workspace, team or project', () => {
    expect(names(query({ text: 'expenses' }))).toEqual(['expense-tracker'])
    expect(names(query({ text: 'travel' }))).toEqual(['Trip logger'])
    expect(names(query({ text: 'trips team' }))).toEqual(['Trip logger'])
    expect(names(query({ text: 'sales nothing' }))).toEqual([])
    expect(score(apps[0], terms('   '))).toBe(1)
  })

  it('ranks names that start with the search first, then names with its words', () => {
    // `sales-dashboard` starts with it; `dashboard-sales-old` has both words; Sales is only Expense's workspace.
    expect(names(query({ text: 'sales dash' }))).toEqual(['sales-dashboard', 'dashboard-sales-old'])
    expect(names(query({ text: 'sales' }))).toEqual([
      'sales-dashboard',
      'dashboard-sales-old',
      'expense-tracker'
    ])
  })
})

describe('gallery filters and order', () => {
  it('shows the apps on this computer, only in Fabric, or in one workspace', () => {
    expect(names(query({ where: 'local' }))).toEqual(['expense-tracker'])
    expect(names(query({ where: 'remote' }))).toEqual([
      'dashboard-sales-old',
      'sales-dashboard',
      'Trip logger'
    ])
    expect(names(query({ workspaceId: 'ws-trips' }))).toEqual(['Trip logger'])
  })

  it('orders by most recent publish, with apps Fabric hasn’t answered for last', () => {
    const statuses = {
      b: { id: 'b', publishedAt: '2026-10-01T00:00:00Z' },
      c: { id: 'c', publishedAt: '2026-10-20T00:00:00Z' },
      d: { id: 'd', unknown: true }
    }
    expect(names(query({ sort: 'recent' }), statuses)).toEqual([
      'Trip logger',
      'sales-dashboard',
      'dashboard-sales-old',
      'expense-tracker'
    ])
  })

  it('groups by workspace A to Z, keeping relevance within each group', () => {
    const entries = applyQuery(apps, {}, query({ sort: 'workspace', text: 'sales' }))
    expect(
      groupByWorkspace(entries).map((g) => [g.name, g.entries.map((e) => e.app.name)])
    ).toEqual([
      ['Archive', ['dashboard-sales-old']],
      ['Sales', ['sales-dashboard', 'expense-tracker']]
    ])
    expect(workspacesOf(apps)).toEqual([
      { id: 'ws-archive', name: 'Archive', count: 1 },
      { id: 'ws-sales', name: 'Sales', count: 2 },
      { id: 'ws-trips', name: 'Travel', count: 1 }
    ])
  })
})

describe('gallery pins', () => {
  // `atlas` is in Travel, so A to Z and by workspace order the pinned apps differently.
  const all = [...apps, app('e', 'atlas', { workspaceId: 'ws-trips', workspaceName: 'Travel' })]
  const pinned = ['e', 'd']
  const statuses = {
    a: { id: 'a', publishedAt: '2026-10-05T00:00:00Z' },
    b: { id: 'b', publishedAt: '2026-10-25T00:00:00Z' },
    d: { id: 'd', publishedAt: '2026-10-20T00:00:00Z' },
    e: { id: 'e', publishedAt: '2026-10-01T00:00:00Z' }
  }
  const shown = (over: Partial<GalleryQuery>): string[] =>
    applyQuery(all, statuses, query({ pinned, ...over })).map((e) => e.app.name)

  it('puts pinned apps first under every order, in that order', () => {
    expect(shown({ sort: 'name' })).toEqual([
      'atlas',
      'dashboard-sales-old',
      'expense-tracker',
      'sales-dashboard',
      'Trip logger'
    ])
    expect(shown({ sort: 'recent' })).toEqual([
      'dashboard-sales-old',
      'atlas',
      'sales-dashboard',
      'expense-tracker',
      'Trip logger'
    ])
    const entries = applyQuery(all, statuses, query({ pinned, sort: 'workspace' }))
    expect(
      groupByWorkspace(entries).map((g) => [g.name, g.entries.map((e) => e.app.name)])
    ).toEqual([
      ['Pinned', ['dashboard-sales-old', 'atlas']],
      ['Sales', ['expense-tracker', 'sales-dashboard']],
      ['Travel', ['Trip logger']]
    ])
  })

  it('still searches and filters pinned apps', () => {
    // `atlas` doesn't match; the pinned match comes before a better one.
    expect(shown({ text: 'sales' })).toEqual([
      'dashboard-sales-old',
      'sales-dashboard',
      'expense-tracker'
    ])
    expect(shown({ where: 'local' })).toEqual(['expense-tracker'])
    expect(shown({ workspaceId: 'ws-trips' })).toEqual(['atlas', 'Trip logger'])
  })
})

describe('gallery covers and times', () => {
  it('takes initials from the first two words of any naming style', () => {
    expect(initials('sales-dashboard')).toBe('SD')
    expect(initials('Trip logger')).toBe('TL')
    expect(initials('leadTracker_v2')).toBe('LT')
    expect(initials('notes')).toBe('N')
    expect(initials('  ')).toBe('?')
  })

  it('says when an app was published in words', () => {
    const now = Date.parse('2026-10-31T12:00:00Z')
    expect(ago('2026-10-31T11:59:30Z', now)).toBe('just now')
    expect(ago('2026-10-31T09:00:00Z', now)).toBe('3 hours ago')
    expect(ago('2026-10-30T12:00:00Z', now)).toBe('yesterday')
    expect(ago('2026-10-24T03:34:31Z', now)).toBe('last week')
    expect(ago(undefined, now)).toBeUndefined()
    expect(ago('soon', now)).toBeUndefined()
  })
})

describe('gallery workspaces', () => {
  it('puts the workspaces your apps here use first, most recently used first', () => {
    const { recent, others } = rankWorkspaces(workspacesOf(apps), [
      { workspace: 'travel', at: 5 },
      { workspace: 'WS-ARCHIVE', at: 9 },
      { workspace: 'gone', at: 10 }
    ])
    expect(recent.map((w) => [w.name, w.usedAt])).toEqual([
      ['Archive', 9],
      ['Travel', 5]
    ])
    expect(others.map((w) => w.name)).toEqual(['Sales'])
    // Grouped by workspace, they come first too.
    expect(names(query({ sort: 'workspace', recent: recent.map((w) => w.id) }))).toEqual([
      'dashboard-sales-old',
      'Trip logger',
      'expense-tracker',
      'sales-dashboard'
    ])
  })

  it('quiets a generated tail on a workspace’s name', () => {
    expect(
      splitWorkspaceName('replit-data-dashboard-2e377200-1e4d-49e0-a744-dd9a6fa78c1e')
    ).toEqual(['replit-data-dashboard', '-2e377200-1e4d-49e0-a744-dd9a6fa78c1e'])
    expect(splitWorkspaceName('college-tracker-20261022-041214309-cd12809e')).toEqual([
      'college-tracker',
      '-20261022-041214309-cd12809e'
    ])
    expect(splitWorkspaceName('my-rayfin-app-918529')).toEqual(['my-rayfin-app-918529', ''])
    expect(splitWorkspaceName('Sample Reports / SM')).toEqual(['Sample Reports / SM', ''])
  })

  it('titles a workspace a tool named, and keeps the name as its detail', () => {
    const title = (name: string): string => workspaceTitle(name).title
    expect(title('replit-data-dashboard-2e377200-1e4d-49e0-a744-dd9a6fa78c1e')).toBe(
      'Replit data dashboard'
    )
    expect(title('college-tracker-20261022-041214309-cd12809e')).toBe('College tracker')
    expect(title('my-rayfin-app-918529')).toBe('My Rayfin app')
    expect(title('replit-fabric-dashboard-fd3ec906-06b2-4104-ace5-fcb4c07cb813')).toBe(
      'Replit Fabric dashboard'
    )
    // A year stays; it isn't a hash.
    expect(title('budget-review-2026')).toBe('Budget review 2026')
    expect(workspaceTitle('micro-fabric-analytics-spike')).toEqual({
      title: 'Micro Fabric analytics spike',
      detail: 'micro-fabric-analytics-spike'
    })
    expect(workspaceTitle('FabCON')).toEqual({ title: 'FabCON' })
    expect(workspaceTitle('Sample Reports / SM')).toEqual({ title: 'Sample Reports / SM' })
  })
})
