import { describe, expect, it } from 'vitest'
import type { GalleryApp } from '@shared/ipc'
import {
  ago,
  applyQuery,
  groupByWorkspace,
  initials,
  score,
  terms,
  workspacesOf,
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
