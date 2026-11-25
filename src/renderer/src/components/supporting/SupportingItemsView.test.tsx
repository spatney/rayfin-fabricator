import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { StudioProject, SupportingFabricState, SupportingItemsView as View } from '@shared/ipc'
import SupportingItemsView from './SupportingItemsView'
import { ToastProvider } from '../../toast'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const project = { id: 'p1', name: 'Retail', path: 'C:/apps/retail' } as StudioProject
const WS = { id: '11111111-2222-4333-8444-555555555555', name: 'Contoso Apps' }
const LAKE = 'aaaaaaaa-1111-4222-8333-444444444444'
const MODEL = 'bbbbbbbb-1111-4222-8333-444444444444'

const view: View = {
  available: true,
  on: true,
  workspace: WS,
  items: [
    {
      key: 'k-lake',
      folder: 'Retail.Lakehouse',
      name: 'Retail',
      type: 'Lakehouse',
      status: 'applied',
      itemId: LAKE,
      summary: { tables: 2, columns: 0, measures: 0, relationships: 0, sources: [] },
      tables: [
        {
          name: 'orders',
          source: 'supporting-items/Retail.Lakehouse/data/orders.csv',
          bytes: 2048,
          rows: 120,
          loadedAt: new Date(Date.now() - 3_600_000).toISOString(),
          changed: false
        },
        {
          name: 'returns',
          source: 'supporting-items/Retail.Lakehouse/data/returns.csv',
          bytes: 512,
          changed: true,
          loadedAt: new Date(Date.now() - 3_600_000).toISOString()
        }
      ],
      url: `https://app.fabric.microsoft.com/groups/${WS.id}/lakehouses/${LAKE}`
    },
    {
      key: 'k-model',
      folder: 'Retail sales.SemanticModel',
      name: 'Retail sales',
      type: 'SemanticModel',
      status: 'applied',
      itemId: MODEL,
      summary: {
        tables: 2,
        columns: 9,
        measures: 4,
        relationships: 1,
        storage: 'directLake',
        sources: [
          {
            kind: 'Fabric Lakehouse',
            function: 'AzureStorage.DataLake',
            args: [`https://onelake.dfs.fabric.microsoft.com/${WS.id}/${LAKE}`],
            local: false,
            item: 'Retail'
          }
        ]
      }
    }
  ]
}

function api(fabric: SupportingFabricState[] = []): Record<string, unknown> {
  const stub = {
    openExternal: vi.fn(() => Promise.resolve()),
    chat: { setPlugin: vi.fn(() => Promise.resolve(['supporting-items'])) },
    supportingItems: {
      fabric: vi.fn(() => Promise.resolve(fabric)),
      list: vi.fn(() => Promise.resolve({ ...view, items: [] })),
      remove: vi.fn()
    }
  }
  vi.stubGlobal('api', stub)
  return stub
}

function show(
  items: View,
  props: Partial<Parameters<typeof SupportingItemsView>[0]> = {}
): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <SupportingItemsView
        project={project}
        items={items}
        usedItemIds={new Set()}
        onChanged={vi.fn()}
        onOpenFile={vi.fn()}
        onSendToChat={vi.fn()}
        {...props}
      />
    </ToastProvider>
  )
}

describe('SupportingItemsView', () => {
  it('turns supporting items on for an app that has them off', async () => {
    const stub = api()
    const onChanged = vi.fn()
    const onPluginsChanged = vi.fn()
    show({ available: true, on: false, items: [] }, { onChanged, onPluginsChanged })
    expect(screen.getByText('Supporting items are off for this app')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for this app' }))
    await waitFor(() => expect(onPluginsChanged).toHaveBeenCalled())
    expect((stub.chat as { setPlugin: unknown }).setPlugin).toHaveBeenCalledWith(
      'p1',
      'supporting-items',
      true
    )
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ on: true }))
  })

  it('says when the app’s chat has them off, and turns them on from the list', async () => {
    const stub = api()
    const onPluginsChanged = vi.fn()
    show({ ...view, on: false }, { onPluginsChanged })
    expect(
      screen.getByText(/off in this app’s chat, so Copilot can’t apply or refresh them/)
    ).toBeTruthy()
    // What needs the chat isn't offered while it's off.
    expect(screen.queryByRole('button', { name: /Connect with Copilot/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for this app' }))
    await waitFor(() => expect(onPluginsChanged).toHaveBeenCalled())
    expect((stub.chat as { setPlugin: unknown }).setPlugin).toHaveBeenCalledWith(
      'p1',
      'supporting-items',
      true
    )
  })

  it('lists a lakehouse’s tables, and warns that deleting it deletes its data', async () => {
    api([{ key: 'k-lake', exists: true, tables: ['orders', 'returns'], needsSignIn: false }])
    show(view)
    expect(screen.getByText('orders.csv · 2 KB · 120 rows')).toBeTruthy()
    expect(screen.getByText('Changed since it loaded')).toBeTruthy()
    expect(await screen.findByText('2 tables in Fabric')).toBeTruthy()
    // Its model reads it with Direct Lake.
    expect(screen.getByText('Direct Lake from the Retail lakehouse')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /Delete in Fabric/ })[0])
    expect(
      screen.getByText(/deletes the lakehouse Retail from Contoso Apps, with every file/)
    ).toBeTruthy()
  })

  it('offers to connect a model the app doesn’t read yet, through the chat', async () => {
    api()
    const onSendToChat = vi.fn()
    show(view, { onSendToChat })
    fireEvent.click(await screen.findByRole('button', { name: /Connect with Copilot/ }))
    expect(onSendToChat).toHaveBeenCalledWith(
      'Connect Retail sales',
      expect.stringContaining('rayfin connector add')
    )
    cleanup()
    api()
    show(view, { usedItemIds: new Set([MODEL]) })
    expect(screen.queryByRole('button', { name: /Connect with Copilot/ })).toBeNull()
    expect(await screen.findByText('Used by the app')).toBeTruthy()
  })

  it('asks to sign in to Fabric again, with the account menu’s action', async () => {
    api([{ key: 'k-model', needsSignIn: true }])
    const onRefreshAuth = vi.fn()
    show(view, { onRefreshAuth })
    fireEvent.click(await screen.findByRole('button', { name: /Refresh Fabric authentication/ }))
    expect(onRefreshAuth).toHaveBeenCalled()
  })
})
