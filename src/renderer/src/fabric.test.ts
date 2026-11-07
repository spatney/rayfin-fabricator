import { describe, expect, it } from 'vitest'
import type { StudioProject, UnsupportedWorkspace } from '@shared/ipc'
import {
  fabricItemUrl,
  fabricWorkspaceUrl,
  publishedItem,
  recentWorkspaces,
  refusalFor,
  refusedAfterPublish,
  refusedRegions
} from './fabric'

/**
 * The footer workspace link deep-links to the Fabric portal using the workspace
 * GUID recorded in the deployment file (`fabricWorkspaceId`). Guards the exact
 * `groups/{id}/` URL shape and the GUID-only guard that keeps a pre-reconcile
 * display name from producing a broken link.
 */
describe('fabricWorkspaceUrl', () => {
  it('builds a Fabric portal groups deep link from a workspace GUID', () => {
    expect(fabricWorkspaceUrl('de0fcf1a-8c94-46cf-a029-650b2e87f172')).toBe(
      'https://app.fabric.microsoft.com/groups/de0fcf1a-8c94-46cf-a029-650b2e87f172/'
    )
  })

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(fabricWorkspaceUrl('  DE0FCF1A-8C94-46CF-A029-650B2E87F172  ')).toBe(
      'https://app.fabric.microsoft.com/groups/DE0FCF1A-8C94-46CF-A029-650B2E87F172/'
    )
  })

  it('returns undefined for a non-GUID workspace (e.g. a display name)', () => {
    expect(fabricWorkspaceUrl('Rayfin Apps')).toBeUndefined()
  })

  it('returns undefined when the id is missing or empty', () => {
    expect(fabricWorkspaceUrl(undefined)).toBeUndefined()
    expect(fabricWorkspaceUrl('')).toBeUndefined()
    expect(fabricWorkspaceUrl('   ')).toBeUndefined()
  })
})

describe('Fabric items', () => {
  const WS = 'de0fcf1a-8c94-46cf-a029-650b2e87f172'
  const OTHER_WS = '11111111-1111-4111-8111-111111111111'
  const ITEM = '6a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b'
  const page = (ws: string, protocol = 'https'): string =>
    `${protocol}://app.fabric.microsoft.com/groups/${ws}/appbackends/${ITEM}`
  // How `rayfin up` records it: with the tenant to open it in.
  const link = (ws: string, protocol = 'https'): string =>
    `${page(ws, protocol)}?ctid=22222222-2222-4222-8222-222222222222`
  const published = (portalUrl?: string): StudioProject => ({
    id: 'p',
    name: 'Sales',
    path: 'C:\\apps\\sales',
    addedAt: '2026-01-01T00:00:00.000Z',
    workspace: WS,
    lastDeploy: { url: 'https://sales.example.app', portalUrl, status: 'success' }
  })

  it('links an item in its workspace the way rayfin up does, given both GUIDs', () => {
    expect(fabricItemUrl(WS, ITEM)).toBe(page(WS))
    expect(fabricItemUrl(WS, undefined)).toBeUndefined()
    expect(fabricItemUrl('Rayfin Apps', ITEM)).toBeUndefined()
    expect(fabricItemUrl(WS, 'item-1')).toBeUndefined()
  })

  it('finds the published app’s item from the link rayfin up recorded', () => {
    expect(publishedItem(published(link(WS)))).toEqual({ url: link(WS), id: ITEM })
  })

  it('finds no item in another workspace than the project’s, nor in a link that isn’t an item’s https page', () => {
    expect(publishedItem(published(link(OTHER_WS)))).toBeUndefined()
    expect(
      publishedItem(published(`https://app.fabric.microsoft.com/groups/${WS}/`))
    ).toBeUndefined()
    expect(publishedItem(published(link(WS, 'http')))).toBeUndefined()
    expect(publishedItem(published(undefined))).toBeUndefined()
  })
})

describe('recentWorkspaces', () => {
  const app = (id: string, workspace?: string, at?: string, extra: Partial<StudioProject> = {}): StudioProject => ({
    id,
    name: id,
    path: `C:\\apps\\${id}`,
    addedAt: '2026-09-01T00:00:00Z',
    workspace,
    lastDeploy: at ? { status: 'success', at } : undefined,
    ...extra
  })

  it('lists each workspace your apps use once, the most recently used first', () => {
    expect(
      recentWorkspaces([
        app('a', 'ws-1', '2026-10-01T09:00:00Z'),
        app('b', 'ws-2', '2026-10-09T09:00:00Z'),
        app('c', 'ws-1', '2026-10-10T09:00:00Z'),
        app('d', 'ws-3')
      ])
    ).toEqual(['ws-1', 'ws-2', 'ws-3'])
  })

  it('leaves out team apps and apps without a workspace', () => {
    expect(
      recentWorkspaces([
        app('a', 'ws-team', '2026-10-09T09:00:00Z', { team: {} as StudioProject['team'] }),
        app('b', undefined, '2026-10-09T09:00:00Z'),
        app('c', '  ', '2026-10-09T09:00:00Z'),
        app('d', 'ws-mine', '2026-10-01T09:00:00Z')
      ])
    ).toEqual(['ws-mine'])
  })
})

describe('workspaces Fabric turned apps down in', () => {
  const sales: UnsupportedWorkspace = {
    id: 'ws-sales',
    name: 'Sales',
    region: 'UK South',
    capacityId: 'cap-uk'
  }

  it('marks the workspace, others on its capacity, and others in its region however it is spelled', () => {
    expect(refusalFor({ id: 'WS-SALES' }, [sales])?.by).toBe('workspace')
    expect(refusalFor({ id: 'ws-2', capacityId: 'CAP-UK' }, [sales])?.by).toBe('capacity')
    expect(refusalFor({ id: 'ws-3', capacityId: 'cap-2', region: 'uksouth' }, [sales])?.by).toBe(
      'region'
    )
    expect(
      refusalFor({ id: 'ws-4', capacityId: 'cap-3', region: 'UK West' }, [sales])
    ).toBeUndefined()
    // Nothing Fabric didn't say: no region or capacity in common, nothing to mark.
    expect(refusalFor({ id: 'ws-5' }, [{ id: 'ws-sales' }])).toBeUndefined()
    expect(refusalFor({ id: 'ws-sales' }, [])).toBeUndefined()
  })

  it('names each region once', () => {
    expect(
      refusedRegions([
        sales,
        { id: 'b', region: 'uk south' },
        { id: 'c' },
        { id: 'd', region: 'Japan West' }
      ])
    ).toEqual(['UK South', 'Japan West'])
  })

  it('learns from each publish: a refusal is added once, and a workspace that took the app is dropped', () => {
    const refused = { ok: false, outcome: 'workspace-unsupported' as const, unsupported: sales }
    const once = refusedAfterPublish([], refused, 'ws-sales')
    expect(refusedAfterPublish(once, refused, 'ws-sales')).toEqual([sales])

    const other = { ok: false, outcome: 'error' as const, error: 'Build failed' }
    expect(refusedAfterPublish(once, other, 'ws-sales')).toBe(once)
    expect(refusedAfterPublish(once, { ok: true, outcome: 'success' }, 'ws-other')).toBe(once)
    expect(refusedAfterPublish(once, { ok: true, outcome: 'success' }, 'WS-SALES')).toEqual([])
  })
})
