import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TeamResourceRequest } from '@shared/ipc'
import { OverlayProvider, usePreviewSuppressed } from '../../../overlay'
import TeamMapView from './TeamMapView'
import { parseNodeId, parsePatch } from './Inspector'
import { AMYS, sampleMap, sampleResources, sampleRun, sampleWorkspace } from './fixtures'
import { nodeIds } from './model'

import type { JSX } from 'react'

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

function Probe(): JSX.Element {
  return <span data-testid="suppressed">{String(usePreviewSuppressed())}</span>
}

type Mock = ReturnType<typeof vi.fn>

function installApi(): Record<
  'diff' | 'openProject' | 'members' | 'health' | 'setRequireReview' | 'leave' | 'removeProject' | 'map' | 'resources',
  Mock
> {
  const diff = vi.fn(() =>
    Promise.resolve({
      ok: true,
      truncated: false,
      files: [
        {
          path: 'trips/src/export.ts',
          change: 'added',
          additions: 2,
          deletions: 1,
          truncated: false,
          patch: '@@ -1,2 +1,3 @@\n-old line\n+new line\n+another\n kept'
        }
      ]
    })
  )
  const openProject = vi.fn(() => Promise.resolve({ ok: true, project: { id: 'p1', name: 'Trip Logger', path: 'x', addedAt: '' } }))
  const members = vi.fn(() =>
    Promise.resolve({
      ok: true,
      canManage: true,
      members: [
        { login: 'me', role: 'owner', pending: false },
        { login: 'amy', role: 'member', pending: false },
        { login: 'bo', role: 'member', pending: true, invitationId: 7 }
      ]
    })
  )
  const health = vi.fn(() =>
    Promise.resolve({ ok: true, items: [{ id: 'pipeline', label: 'The pipeline is up to date', state: 'ok', repairable: false }] })
  )
  const setRequireReview = vi.fn(() => Promise.resolve({ ok: true }))
  const leave = vi.fn(() => Promise.resolve())
  const removeProject = vi.fn(() => Promise.resolve({ ok: true }))
  const map = vi.fn(() => Promise.resolve(sampleMap()))
  const resources = vi.fn((_workspaceId: string, requests: TeamResourceRequest[]) =>
    Promise.resolve({ ok: true, sources: sampleResources(requests) })
  )
  ;(window as unknown as { api: unknown }).api = {
    openExternal: vi.fn(),
    team: {
      diff,
      openProject,
      members,
      health,
      fabricAccess: vi.fn(() => Promise.resolve({ ok: true, people: [] })),
      setRequireReview,
      leave,
      removeProject,
      map,
      resources,
      onProgress: vi.fn(() => () => {})
    }
  }
  return { diff, openProject, members, health, setRequireReview, leave, removeProject, map, resources }
}

async function renderMap(
  onOpened = vi.fn(),
  extra: { manage?: boolean; onClose?: () => void; onChanged?: () => void } = {}
): Promise<void> {
  const map = sampleMap()
  map.runs = [sampleRun()]
  // Rendering reads every app's data too: let that settle.
  await act(async () => {
    render(
      <OverlayProvider>
        <Probe />
        <TeamMapView
          workspace={sampleWorkspace}
          initialMap={map}
          onClose={extra.onClose ?? vi.fn()}
          onOpened={onOpened}
          manage={extra.manage}
          onChanged={extra.onChanged}
        />
      </OverlayProvider>
    )
  })
}

const nodeWith = (text: string): HTMLElement => screen.getByText(text).closest('.tmap-node') as HTMLElement

describe('TeamMapView', () => {
  it('maps each app: its published app and working copies, its data, and what that connects to', async () => {
    const api = installApi()
    await renderMap()
    expect(screen.getByTestId('suppressed').textContent).toBe('true')
    const region = screen.getByRole('region', { name: 'Sales team overview' })
    for (const lane of ['Published & in progress', 'Apps', 'Data & connections', 'Connected to']) {
      expect(within(region).getByText(lane)).toBeTruthy()
    }
    expect(within(region).getByLabelText('Summary').textContent).toContain('2 apps')
    // Each app, with who's changing it.
    expect(within(nodeWith('Trip Logger')).getByText('You and amy are changing it')).toBeTruthy()
    expect(within(nodeWith('Notes')).getByText('Not published yet')).toBeTruthy()
    // Its published app and working copies, on its left.
    expect(document.querySelector('.tmap-node--published')?.textContent).toContain('trips.app')
    expect(within(region).getByText('add a map of every trip')).toBeTruthy()
    // Its data, on its right; the published app and your copy here (it has unsaved edits) are read.
    expect(api.resources).toHaveBeenCalledWith('w1', [{ folder: 'trips' }, { folder: 'trips', local: true }])
    expect(within(region).getByText('Database')).toBeTruthy()
    expect(within(region).getByText('No database or connections')).toBeTruthy()
    // Amy's preview is deploying: her copy shows the step in progress and its
    // line to the app flows; the header counts it, and the sidebar lists the run.
    expect(within(nodeWith('export trips to CSV')).getByText('Deploy with Rayfin')).toBeTruthy()
    expect(document.querySelectorAll('.tmap-edge--version.tmap-edge--deploying .tmap-edge-flow')).toHaveLength(1)
    expect(within(region).getByText('1 deploying')).toBeTruthy()
    const activity = within(region).getByRole('complementary', { name: 'Pipeline activity' })
    expect(within(activity).getByText('Preview of Trip Logger')).toBeTruthy()
    // Where the apps deploy is in the sidebar, not on the map.
    expect(within(activity).getByText('Published apps')).toBeTruthy()
    expect(within(activity).getByText('Sales team previews')).toBeTruthy()
    expect(within(region).queryByText('Deployed to Fabric')).toBeNull()
  })

  it('shows a working copy’s changes in the inspector', async () => {
    const { diff } = installApi()
    await renderMap()
    await act(async () => {
      fireEvent.click(nodeWith('export trips to CSV'))
    })
    const details = screen.getByRole('complementary', { name: 'Details' })
    expect(within(details).getByText('amy’s working copy')).toBeTruthy()
    expect(diff).toHaveBeenCalledWith('w1', 'trips', 4)
    const file = await within(details).findByRole('button', { name: /export\.ts/ })
    fireEvent.click(file)
    expect(within(details).getByText('new line')).toBeTruthy()
    expect(within(details).getByText('old line')).toBeTruthy()
  })

  it('reads your own copy from this computer, unsaved edits included', async () => {
    const { diff } = installApi()
    await renderMap()
    await act(async () => {
      fireEvent.click(nodeWith('add a map of every trip'))
    })
    expect(diff).toHaveBeenCalledWith('w1', 'trips', undefined)
    expect(await screen.findByText('Includes unsaved edits')).toBeTruthy()
  })

  it('opens an app from its node', async () => {
    const { openProject } = installApi()
    const onOpened = vi.fn()
    await renderMap(onOpened)
    const appNode = document.querySelector('.tmap-node--app') as HTMLElement
    await act(async () => {
      fireEvent.click(within(appNode).getByRole('button', { name: 'Open' }))
    })
    expect(openProject).toHaveBeenCalledWith('w1', 'trips')
    expect(onOpened).toHaveBeenCalled()
  })

  it('manages the workspace in its sidebar: members, then settings', async () => {
    const api = installApi()
    const onChanged = vi.fn()
    await renderMap(vi.fn(), { manage: true, onChanged })
    const panel = screen.getByRole('complementary', { name: 'Workspace' })
    expect(api.members).toHaveBeenCalledWith('w1')
    expect(within(panel).getByText('amy')).toBeTruthy()
    expect(within(panel).getByText('Invited')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Send invitation' })).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(panel).getByRole('tab', { name: 'Settings' }))
    })
    expect(api.health).toHaveBeenCalledWith('w1')
    expect(within(panel).getByText('The pipeline is up to date')).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(panel).getByRole('checkbox', { name: 'Require a review before publishing' }))
    })
    expect(api.setRequireReview).toHaveBeenCalledWith('w1', true)
    // A change reloads the overview and tells the caller.
    expect(api.map).toHaveBeenCalledWith('w1')
    expect(onChanged).toHaveBeenCalled()
  })

  it('keeps the sidebar open when Esc closes a confirmation on top of it', async () => {
    const api = installApi()
    const onClose = vi.fn()
    const onChanged = vi.fn()
    await renderMap(vi.fn(), { manage: true, onClose, onChanged })
    const panel = screen.getByRole('complementary', { name: 'Workspace' })
    await act(async () => {
      fireEvent.click(within(panel).getByRole('tab', { name: 'Settings' }))
    })
    fireEvent.click(within(panel).getByRole('button', { name: 'Leave on this computer' }))
    expect(screen.getByRole('dialog', { name: 'Leave Sales team?' })).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('complementary', { name: 'Workspace' })).toBeTruthy()

    fireEvent.click(within(panel).getByRole('button', { name: 'Leave on this computer' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    })
    expect(api.leave).toHaveBeenCalledWith('w1')
    expect(onChanged).toHaveBeenCalled()

    // Without a dialog, Esc closes the sidebar, then the overview.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Workspace' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('opens the workspace sidebar from its members in the header', async () => {
    installApi()
    await renderMap()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '2 members' }))
    })
    expect(screen.getByRole('complementary', { name: 'Workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Manage' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('lets an owner remove an app from its details', async () => {
    const api = installApi()
    const onChanged = vi.fn()
    await renderMap(vi.fn(), { onChanged })
    const appNode = document.querySelector('.tmap-node--app') as HTMLElement
    await act(async () => {
      fireEvent.click(appNode)
    })
    const details = screen.getByRole('complementary', { name: 'Details' })
    fireEvent.click(within(details).getByRole('button', { name: 'Remove from workspace…' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove Trip Logger?' })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })
    expect(api.removeProject).toHaveBeenCalledWith('w1', 'trips', true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull()
    expect(onChanged).toHaveBeenCalled()
  })

  it('shows what each app’s data connects to, and what your copy changes', async () => {
    installApi()
    await renderMap()
    const region = screen.getByRole('region', { name: 'Sales team overview' })
    // Your copy's additions show where they happen; what only it has is dashed.
    expect(within(region).getByText('Your copy adds Receipt')).toBeTruthy()
    expect(within(region).getByText('Your copy connects to inventory')).toBeTruthy()
    expect(nodeWith('inventory').className).toContain('tmap-node--draft')

    // Hovering the semantic model lights up what reads it, and nothing else.
    fireEvent.mouseEnter(nodeWith('Sales'))
    expect(nodeWith('sales').className).not.toContain('tmap-node--dim')
    expect(nodeWith('Trip Logger').className).not.toContain('tmap-node--dim')
    expect(nodeWith('inventory').className).toContain('tmap-node--dim')
    expect(nodeWith('Notes').className).toContain('tmap-node--dim')
    fireEvent.mouseLeave(nodeWith('Sales'))

    // A connector's details, then the semantic model it reads.
    await act(async () => {
      fireEvent.click(nodeWith('sales'))
    })
    const details = screen.getByRole('complementary', { name: 'Details' })
    expect(within(details).getByText('Semantic model connector')).toBeTruthy()
    expect(within(details).getByText('Runs queries')).toBeTruthy()
    expect(within(details).getByText('The person using the app')).toBeTruthy()
    expect(within(details).getByRole('button', { name: /Open its workspace in Fabric/ })).toBeTruthy()
    fireEvent.click(within(details).getByRole('button', { name: /^Sales/ }))
    const source = screen.getByRole('complementary', { name: 'Details' })
    expect(within(source).getByText('In Microsoft Fabric')).toBeTruthy()
    expect(within(source).getByRole('button', { name: /Trip Logger/ })).toBeTruthy()
  })

  it('shows where the apps deploy, and what is deployed there', async () => {
    installApi()
    await renderMap()
    const activity = screen.getByRole('complementary', { name: 'Pipeline activity' })
    fireEvent.click(within(activity).getByText('Previews').closest('button') as HTMLElement)
    const details = screen.getByRole('complementary', { name: 'Details' })
    expect(within(details).getByText('Microsoft Fabric workspace')).toBeTruthy()
    expect(within(details).getByText('Sales team previews')).toBeTruthy()
    // The previews stand out on the map.
    expect(nodeWith('export trips to CSV').className).not.toContain('tmap-node--dim')
    expect(document.querySelector('.tmap-node--published')?.className).toContain('tmap-node--dim')
  })
})

describe('map inspector helpers', () => {
  it('splits node ids, keeping branch names whole', () => {
    expect(parseNodeId(nodeIds.copy('trips', AMYS))).toEqual({ kind: 'copy', folder: 'trips', branch: AMYS })
    expect(parseNodeId(nodeIds.app('trips'))).toEqual({ kind: 'app', folder: 'trips', branch: undefined })
    expect(parseNodeId('fabric:prod')).toEqual({ kind: 'fabric:prod' })
  })

  it('numbers patch lines from their hunk headers', () => {
    const rows = parsePatch('@@ -10,2 +10,3 @@ section\n-a\n+b\n+c\n d\n\\ No newline at end of file')
    expect(rows.map((r) => [r.kind, r.old, r.new])).toEqual([
      ['hunk', undefined, undefined],
      ['del', 10, undefined],
      ['add', undefined, 10],
      ['add', undefined, 11],
      ['ctx', 11, 12],
      ['note', undefined, undefined]
    ])
  })
})
