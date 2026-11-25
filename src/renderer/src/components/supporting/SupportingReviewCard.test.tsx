import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SupportingReview, SupportingReviewItem } from '@shared/ipc'
import { SupportingReviewCard } from './SupportingReviewCard'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const item = (over: Partial<SupportingReviewItem> = {}): SupportingReviewItem => ({
  key: 'k1',
  name: 'Sales',
  type: 'SemanticModel',
  folder: 'supporting-items/Sales.SemanticModel',
  change: 'create',
  summary: {
    tables: 4,
    columns: 23,
    measures: 12,
    relationships: 3,
    storage: 'import',
    sources: [
      {
        kind: 'Snowflake',
        function: 'Snowflake.Databases',
        args: ['xy.snowflakecomputing.com', 'COMPUTE_WH'],
        local: false
      }
    ]
  },
  state: 'pending',
  ...over
})

const review = (over: Partial<SupportingReview> = {}): SupportingReview => ({
  id: 'r1',
  kind: 'apply',
  state: 'pending',
  reason: 'the monthly revenue dashboard',
  workspace: { id: 'w1', name: 'Finance analytics' },
  account: 'ana@contoso.com',
  items: [item()],
  ...over
})

describe('SupportingReviewCard', () => {
  it('shows where, as whom and what before anything changes, and approves on the button', () => {
    const onResolve = vi.fn()
    const onViewModel = vi.fn()
    render(
      <SupportingReviewCard
        review={review()}
        busy={false}
        onResolve={onResolve}
        onViewModel={onViewModel}
      />
    )
    expect(screen.getByRole('heading', { name: 'Create Sales in Fabric?' })).toBeTruthy()
    expect(screen.getByText('Purpose: the monthly revenue dashboard')).toBeTruthy()
    expect(screen.getByText('Finance analytics')).toBeTruthy()
    expect(screen.getByText('ana@contoso.com')).toBeTruthy()
    expect(screen.getByText('4 tables · 23 columns · 12 measures · 3 relationships')).toBeTruthy()
    expect(
      screen.getByText('Import from Snowflake (xy.snowflakecomputing.com · COMPUTE_WH)')
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Supporting items aren’t part of the Rayfin app. Publish doesn’t change them.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /View model/ }))
    expect(onViewModel).toHaveBeenCalledWith(expect.objectContaining({ key: 'k1' }))
    // The action comes first, as on the chat's plan card.
    const [approve, decline] = screen
      .getAllByRole('button')
      .filter((b) => ['Create in Fabric', 'Don’t apply'].includes(b.textContent ?? ''))
    expect([approve.textContent, decline.textContent]).toEqual(['Create in Fabric', 'Don’t apply'])
    fireEvent.click(approve)
    expect(onResolve).toHaveBeenLastCalledWith(true, undefined)
    fireEvent.click(decline)
    expect(onResolve).toHaveBeenLastCalledWith(false)
  })

  it('shows the tables a new lakehouse loads, from which files, and who uploads them', () => {
    render(
      <SupportingReviewCard
        review={review({
          uploadsAs: 'ana@contoso.onmicrosoft.com',
          items: [
            item({
              name: 'Retail',
              type: 'Lakehouse',
              folder: 'supporting-items/Retail.Lakehouse',
              summary: { tables: 2, columns: 6, measures: 0, relationships: 0, sources: [] },
              tables: [
                {
                  name: 'orders',
                  source: 'supporting-items/Retail.Lakehouse/data/orders.csv',
                  format: 'csv',
                  files: 1,
                  bytes: 2_310_000,
                  rows: 48_213,
                  columns: ['OrderId', 'Amount'],
                  change: 'load',
                  state: 'pending'
                },
                {
                  name: 'events',
                  source: 'supporting-items/Retail.Lakehouse/data/events',
                  format: 'parquet',
                  files: 3,
                  bytes: 900_000,
                  change: 'load',
                  state: 'pending'
                }
              ]
            })
          ]
        })}
        busy={false}
        onResolve={vi.fn()}
        onViewModel={vi.fn()}
      />
    )
    expect(screen.getByRole('heading', { name: 'Create Retail in Fabric?' })).toBeTruthy()
    expect(screen.getByText('ana@contoso.onmicrosoft.com')).toBeTruthy()
    expect(screen.getByText('2 tables to load · 3.1 MB')).toBeTruthy()
    expect(screen.getByText('orders.csv · 2.2 MB · 48,213 rows')).toBeTruthy()
    expect(screen.getByText('events (3 files) · 879 KB')).toBeTruthy()
    expect(screen.getByText('2 columns: OrderId, Amount')).toBeTruthy()
    expect(screen.getAllByText('New table')).toHaveLength(2)
    // A lakehouse has no model to view.
    expect(screen.queryByRole('button', { name: /View model/ })).toBeNull()
  })

  it('follows each table as it uploads and loads, and says which didn’t load and why', () => {
    const table = {
      source: 'supporting-items/Retail.Lakehouse/data/orders.csv',
      format: 'csv' as const,
      files: 1,
      bytes: 1000,
      change: 'load' as const
    }
    const lake = (over: Partial<SupportingReviewItem>): SupportingReviewItem =>
      item({
        name: 'Retail',
        type: 'Lakehouse',
        folder: 'supporting-items/Retail.Lakehouse',
        ...over
      })
    render(
      <SupportingReviewCard
        review={review({
          state: 'working',
          items: [
            lake({
              state: 'working',
              itemId: 'l1',
              tables: [
                { ...table, name: 'orders', state: 'done' },
                { ...table, name: 'returns', state: 'working', phase: 'uploading' },
                { ...table, name: 'stores', state: 'pending' }
              ]
            })
          ]
        })}
        busy={false}
        onResolve={vi.fn()}
      />
    )
    expect(screen.getByRole('heading', { name: 'Creating Retail in Fabric…' })).toBeTruthy()
    expect(screen.getByText('Loaded')).toBeTruthy()
    expect(screen.getByText('Uploading…')).toBeTruthy()
    expect(screen.getByText('Loading data…')).toBeTruthy()
    cleanup()
    render(
      <SupportingReviewCard
        review={review({
          state: 'failed',
          items: [
            lake({
              state: 'failed',
              itemId: 'l1',
              error: 'One of its tables didn’t load.',
              tables: [
                { ...table, name: 'orders', state: 'done' },
                { ...table, name: 'returns', state: 'failed', error: 'Column count mismatch.' }
              ]
            })
          ]
        })}
        busy={false}
        onResolve={vi.fn()}
      />
    )
    // It's in Fabric: only some of its data didn't load.
    expect(screen.getByRole('heading', { name: 'Not all of Retail’s data loaded' })).toBeTruthy()
    expect(screen.getByText('Column count mismatch.')).toBeTruthy()
    expect(screen.getByText('Didn’t load')).toBeTruthy()
    expect(screen.queryByText('One of its tables didn’t load.')).toBeNull()
    expect(screen.getByText(/Copilot sees what went wrong too/)).toBeTruthy()
  })

  it('says a Direct Lake model reads the app’s lakehouse, and is refreshed once it’s applied', () => {
    render(
      <SupportingReviewCard
        review={review({
          items: [
            item({
              frames: true,
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
                    args: ['https://onelake.dfs.fabric.microsoft.com/w/l'],
                    local: false,
                    item: 'Retail'
                  }
                ]
              }
            })
          ]
        })}
        busy={false}
        onResolve={vi.fn()}
      />
    )
    expect(screen.getByText('Direct Lake from the Retail lakehouse')).toBeTruthy()
    expect(screen.getByText(/once it’s applied, Fabricator refreshes it/)).toBeTruthy()
  })

  it('lists what an update changes, warns about edits made in Fabric, and the checks it found', () => {
    render(
      <SupportingReviewCard
        review={review({
          items: [
            item({
              change: 'update',
              drift: true,
              changes: [
                { op: 'added', kind: 'table', name: 'Returns', fields: [] },
                {
                  op: 'changed',
                  kind: 'measure',
                  table: 'Sales',
                  name: 'Total Revenue',
                  fields: ['expression']
                }
              ],
              moreChanges: 2,
              checks: [
                {
                  code: 'one-side-key',
                  table: 'Customer',
                  column: 'CustomerKey',
                  detail: 'Sales[CustomerKey]'
                }
              ]
            })
          ]
        })}
        busy={false}
        onResolve={vi.fn()}
      />
    )
    expect(screen.getByText('Adds the table Returns')).toBeTruthy()
    expect(screen.getByText('Changes the measure Sales[Total Revenue] (expression)')).toBeTruthy()
    expect(screen.getByText('…and 2 more changes')).toBeTruthy()
    expect(screen.getByText(/Someone changed it in Fabric/)).toBeTruthy()
    expect(
      screen.getByText(
        'Customer[CustomerKey] has to be unique and never blank, or the refresh fails: Sales[CustomerKey] relies on it.'
      )
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update in Fabric' })).toBeTruthy()
  })

  it('asks for a workspace when the app has none, and approves with the one picked', async () => {
    vi.stubGlobal('api', {
      supportingItems: {
        workspaces: vi.fn(() =>
          Promise.resolve({
            recent: [{ id: 'w1', name: 'Apps' }],
            others: [{ id: 'w2', name: 'Sales team' }]
          })
        )
      }
    })
    const onResolve = vi.fn()
    render(
      <SupportingReviewCard
        review={review({ workspace: undefined, pickWorkspace: true, projectId: 'p1' })}
        busy={false}
        onResolve={onResolve}
      />
    )
    const approve = screen.getByRole('button', { name: 'Create in Fabric' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    expect(approve.title).toBe('Choose a workspace first')
    const pick = (await screen.findByRole('combobox', {
      name: 'Choose a workspace'
    })) as HTMLSelectElement
    // The workspaces the user's apps are published to come first.
    expect([...pick.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([
      'Recent',
      'All workspaces'
    ])
    expect([...pick.options].map((o) => o.textContent)).toEqual([
      'Choose a workspace',
      'Apps',
      'Sales team'
    ])
    fireEvent.change(pick, { target: { value: 'w2' } })
    await waitFor(() => expect(approve.disabled).toBe(false))
    fireEvent.click(approve)
    expect(onResolve).toHaveBeenLastCalledWith(true, { id: 'w2', name: 'Sales team' })
  })

  it('says why the workspaces could not be listed, and lists them again on request', async () => {
    const workspaces = vi
      .fn()
      .mockRejectedValueOnce(new Error('Sign in to Fabric again, then try again.'))
      .mockResolvedValueOnce({ recent: [], others: [{ id: 'w2', name: 'Sales team' }] })
    vi.stubGlobal('api', { supportingItems: { workspaces } })
    render(
      <SupportingReviewCard
        review={review({ workspace: undefined, pickWorkspace: true, projectId: 'p1' })}
        busy={false}
        onResolve={vi.fn()}
      />
    )
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(
      'Couldn’t list your workspaces. Sign in to Fabric again, then try again.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    const pick = (await screen.findByRole('combobox', {
      name: 'Choose a workspace'
    })) as HTMLSelectElement
    expect(pick.querySelector('optgroup')).toBeNull()
    // As the app's Fabric account, which creates its supporting items.
    expect(workspaces.mock.calls).toEqual([['p1'], ['p1']])
  })

  it('links to the model in Fabric when Fabricator can’t start its refresh', () => {
    const open = vi.fn(() => Promise.resolve())
    vi.stubGlobal('api', { openExternal: open })
    render(
      <SupportingReviewCard
        review={review({
          kind: 'refresh',
          state: 'failed',
          items: [
            item({
              change: 'refresh',
              state: 'failed',
              refreshInFabric: true,
              url: 'https://app.powerbi.com/groups/w/datasets/m/details'
            })
          ]
        })}
        busy={false}
        onResolve={vi.fn()}
      />
    )
    expect(screen.getByText(/Open the model in Fabric, select Refresh now/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Fabric' }))
    expect(open).toHaveBeenCalledWith('https://app.powerbi.com/groups/w/datasets/m/details')
  })

  it('says how a refresh went, with where to set credentials', () => {
    const open = vi.fn(() => Promise.resolve())
    vi.stubGlobal('api', { openExternal: open })
    render(
      <SupportingReviewCard
        review={review({
          kind: 'refresh',
          state: 'failed',
          items: [
            item({
              change: 'refresh',
              state: 'failed',
              errors: ['The credentials for Snowflake are missing.'],
              needsCredentials: true,
              settingsUrl: 'https://app.powerbi.com/groups/w1/settings/datasets/i1'
            })
          ]
        })}
        busy={false}
        onResolve={vi.fn()}
      />
    )
    expect(screen.getByRole('heading', { name: 'Sales didn’t refresh' })).toBeTruthy()
    expect(screen.getByText('The credentials for Snowflake are missing.')).toBeTruthy()
    // Publish has nothing to do with a refresh.
    expect(screen.queryByText(/Publish doesn’t change them/)).toBeNull()
    expect(screen.getByText(/Its data source needs credentials/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Open its settings/ }))
    expect(open).toHaveBeenCalledWith('https://app.powerbi.com/groups/w1/settings/datasets/i1')
  })

  it('folds a card the user turned down, or that was never answered, to one line', () => {
    render(
      <SupportingReviewCard
        review={review({ state: 'declined' })}
        busy={false}
        onResolve={vi.fn()}
      />
    )
    expect(screen.getByText('You didn’t apply this')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    render(
      <SupportingReviewCard
        review={review({ state: 'interrupted', items: [item({ state: 'working' })] })}
        busy={false}
        onResolve={vi.fn()}
      />
    )
    expect(screen.getByText(/Stopped before it finished/)).toBeTruthy()
  })
})
