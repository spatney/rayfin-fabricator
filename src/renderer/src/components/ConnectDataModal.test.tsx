import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FabricWorkspace, WorkspaceDataItem } from '@shared/ipc'
import ConnectDataModal from './ConnectDataModal'
import { makeProject } from '../../test/harness'
import { connectedFromWorkspaces, type DataSource } from '../fabricData'

const ws = (id: string, displayName: string): FabricWorkspace => ({ id, displayName, capacityKind: 'fabric', eligible: true })
const WORKSPACES = [ws('ws-app', 'App WS'), ws('ws-fin', 'Finance'), ws('ws-ops', 'Ops'), ws('ws-z', 'Zeta')]

const DATA: Record<string, WorkspaceDataItem[]> = {
  'ws-app': [
    { id: 'l1', name: 'orders', type: 'Lakehouse' },
    { id: 'm1', name: 'Sales', type: 'SemanticModel' }
  ],
  'ws-fin': [{ id: 'w1', name: 'Inventory', type: 'Warehouse' }],
  'ws-ops': [],
  'ws-z': []
}

interface Over {
  listWorkspaces?: ReturnType<typeof vi.fn>
  listWorkspaceData?: ReturnType<typeof vi.fn>
  rayfinYml?: string
  loginRayfin?: ReturnType<typeof vi.fn>
}

function installApi(over: Over = {}): { listWorkspaceData: ReturnType<typeof vi.fn>; loginRayfin: ReturnType<typeof vi.fn> } {
  const listWorkspaceData =
    over.listWorkspaceData ?? vi.fn(async (id: string) => ({ ok: true, items: DATA[id] ?? [] }))
  const loginRayfin = over.loginRayfin ?? vi.fn(async () => ({ ok: true, exitCode: 0 }))
  ;(window as unknown as { api: unknown }).api = {
    deploy: { list: vi.fn(async () => [{ workspaceName: 'App WS', active: true, workspaceId: 'ws-app' }]) },
    fabric: {
      listWorkspaces: over.listWorkspaces ?? vi.fn(async () => ({ ok: true, workspaces: WORKSPACES })),
      listWorkspaceData,
      projectSemanticModels: vi.fn(async () => [])
    },
    projects: {
      files: {
        read: vi.fn(async (_id: string, path: string) =>
          over.rayfinYml && path === 'rayfin/rayfin.yml' ? { content: over.rayfinYml } : { error: 'not found' }
        )
      }
    },
    auth: { loginRayfin }
  }
  return { listWorkspaceData, loginRayfin }
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const workspaceNames = (): string[] =>
  within(screen.getByRole('listbox', { name: 'Workspaces' }))
    .getAllByRole('option')
    .map((o) => o.textContent ?? '')

describe('ConnectDataModal', () => {
  it('starts on the app’s workspace with recent ones first, and asks for data picked across workspaces', async () => {
    installApi()
    const onAdd = vi.fn()
    const onClose = vi.fn()
    render(
      <ConnectDataModal
        project={makeProject('p1')}
        appWorkspaces={[
          { workspace: 'ws-ops', at: 2_000 },
          { workspace: 'ws-app', at: 1_000 }
        ]}
        onClose={onClose}
        onAdd={onAdd}
      />
    )

    expect(await screen.findByRole('checkbox', { name: /Sales/ })).toBeTruthy()
    expect(workspaceNames()).toEqual(['Ops', 'App WSThis app', 'Finance', 'Zeta'])
    expect(screen.getByRole('option', { name: /App WS/ }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('checkbox', { name: /Sales/ }))
    fireEvent.click(screen.getByRole('option', { name: /Finance/ }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /Inventory/ }))
    expect(screen.getByText('2 picked across workspaces')).toBeTruthy()
    expect(screen.getByRole('option', { name: /App WS/ }).textContent).toContain('1')

    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
    const sources = onAdd.mock.calls[0][0] as DataSource[]
    expect(sources.map((s) => [s.workspaceId, s.workspaceName, s.item.id])).toEqual([
      ['ws-app', 'App WS', 'm1'],
      ['ws-fin', 'Finance', 'w1']
    ])
    expect(onClose).toHaveBeenCalled()
    expect(connectedFromWorkspaces().map((u) => u.id).sort()).toEqual(['ws-app', 'ws-fin'])
  })

  it('starts from the data already in the composer, and can take it all out', async () => {
    installApi()
    const onAdd = vi.fn()
    render(
      <ConnectDataModal
        project={makeProject('p1')}
        picked={[{ workspaceId: 'ws-fin', workspaceName: 'Finance', item: { id: 'w1', name: 'Inventory', type: 'Warehouse' } }]}
        onClose={vi.fn()}
        onAdd={onAdd}
      />
    )
    expect(await screen.findByText('1 picked')).toBeTruthy()
    expect(screen.getByRole('option', { name: /Finance/ }).textContent).toContain('1')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(onAdd).toHaveBeenCalledWith([])
  })

  it('opens on one kind of data and marks what the app already connects to', async () => {
    installApi({
      rayfinYml: 'connectors:\n  - name: orders\n    type: fabric-sqlanalytics\n    config:\n      workspaceId: ws-app\n      itemId: l1\n'
    })
    render(<ConnectDataModal project={makeProject('p1')} kind="lakehouse" onClose={vi.fn()} onAdd={vi.fn()} />)

    const orders = (await screen.findByRole('checkbox', { name: /orders/ })) as HTMLInputElement
    await waitFor(() => expect(orders.disabled).toBe(true))
    expect(orders.closest('label')?.textContent).toContain('Connected')
    expect(screen.queryByRole('checkbox', { name: /Sales/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Lakehouses 1' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'All 2' }))
    expect(screen.getByRole('checkbox', { name: /Sales/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: /Ops/ }))
    expect(await screen.findByText('Ops has no semantic models, warehouses, SQL databases or lakehouses.')).toBeTruthy()
  })

  it('asks to sign in when the Fabric session lapsed, then loads your workspaces', async () => {
    const listWorkspaces = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, needsLogin: true })
      .mockResolvedValue({ ok: true, workspaces: WORKSPACES })
    const { loginRayfin } = installApi({ listWorkspaces })
    const onSignedIn = vi.fn()
    render(
      <ConnectDataModal project={makeProject('p1')} onClose={vi.fn()} onAdd={vi.fn()} onSignedIn={onSignedIn} />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in & retry' }))
    expect(await screen.findByRole('checkbox', { name: /Sales/ })).toBeTruthy()
    expect(loginRayfin).toHaveBeenCalledTimes(1)
    expect(onSignedIn).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Sign in & retry' })).toBeNull()
  })

  it('retries a workspace whose data couldn’t be listed', async () => {
    const listWorkspaceData = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, items: [], error: 'Fabric is busy.' })
      .mockImplementation(async (id: string) => ({ ok: true, items: DATA[id] ?? [] }))
    installApi({ listWorkspaceData })
    render(<ConnectDataModal project={makeProject('p1')} onClose={vi.fn()} onAdd={vi.fn()} />)

    expect(await screen.findByText('Fabric is busy.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('checkbox', { name: /Sales/ })).toBeTruthy()
    expect(listWorkspaceData).toHaveBeenCalledTimes(2)
  })
})
