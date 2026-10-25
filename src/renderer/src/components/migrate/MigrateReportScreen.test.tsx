import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReportInspection } from '@shared/ipc'
import MigrateReportScreen, { describePick, isReportLink, pickFromInspection } from './MigrateReportScreen'

const INSPECTION: ReportInspection = {
  ok: true,
  report: { id: 'r1', name: 'Sales overview', workspaceId: 'ws-fin', workspaceName: 'Finance', personal: false, format: 'PBIRLegacy' },
  model: { id: 'ds-1', name: 'Sales model', workspaceId: 'ws-fin', workspaceName: 'Finance' },
  pages: [
    { name: 'p1', displayName: 'Overview', order: 0 },
    { name: 'p2', displayName: 'Regions', order: 1 }
  ],
  checks: {
    definition: { status: 'ok', message: 'Pages, visuals, fields and filters can be read.' },
    model: { status: 'ok', message: 'Copilot can query “Sales model” live.' },
    images: { status: 'warn', message: 'This workspace isn’t on a Fabric or Premium capacity.' }
  }
}

function installApi(over: { inspect?: ReturnType<typeof vi.fn>; workspaces?: ReturnType<typeof vi.fn> } = {}) {
  const api = {
    workspaces:
      over.workspaces ??
      vi.fn(async () => ({
        ok: true,
        account: { user: 'ada@contoso.com' },
        workspaces: [
          { id: 'ws-me', name: 'My workspace', personal: true },
          { id: 'ws-fin', name: 'Finance', personal: false, capacityId: 'cap' },
          { id: 'ws-ops', name: 'Ops', personal: false }
        ]
      })),
    reports: vi.fn(async (id: string) => ({
      ok: true,
      reports: id === 'ws-fin' ? [{ id: 'r1', name: 'Sales overview', workspaceId: 'ws-fin' }] : []
    })),
    search: vi.fn(async () => ({
      ok: true,
      reports: [{ id: 'r9', name: 'Sales by store', workspaceId: 'ws-ops', workspaceName: 'Ops' }]
    })),
    inspect: over.inspect ?? vi.fn(async () => INSPECTION)
  }
  ;(window as unknown as { api: unknown }).api = { migration: api, openExternal: vi.fn() }
  return api
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('MigrateReportScreen', () => {
  it('starts in the workspace your apps use, reads the picked report, and continues with it', async () => {
    const api = installApi()
    const onPicked = vi.fn()
    render(<MigrateReportScreen recentWorkspaces={['ws-fin']} onCancel={vi.fn()} onPicked={onPicked} />)

    expect(await screen.findByText(/as ada@contoso\.com/)).toBeTruthy()
    const workspaces = screen.getByRole('navigation', { name: 'Workspaces' })
    expect(within(workspaces).getAllByRole('button').map((b) => b.textContent)).toEqual(['Finance', 'My workspace', 'Ops'])
    fireEvent.click(await screen.findByRole('button', { name: 'Sales overview' }))
    expect(api.inspect).toHaveBeenCalledWith({ workspaceId: 'ws-fin', reportId: 'r1' })

    const about = await screen.findByRole('region', { name: 'About Sales overview' })
    expect(within(about).getByText(/data from “Sales model”/)).toBeTruthy()
    expect(within(about).getByText(/2 pages: Overview, Regions/)).toBeTruthy()
    expect(within(about).getByText(/isn’t on a Fabric or Premium capacity/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onPicked).toHaveBeenCalledWith({
      source: expect.objectContaining({ reportId: 'r1', reportName: 'Sales overview', workspaceId: 'ws-fin', modelId: 'ds-1' }),
      pages: INSPECTION.pages
    })
  })

  it('searches by name, and reads a pasted link', async () => {
    const api = installApi()
    render(<MigrateReportScreen onCancel={vi.fn()} onPicked={vi.fn()} />)
    await screen.findByRole('navigation', { name: 'Workspaces' })
    const input = screen.getByPlaceholderText('Search by name, or paste a report link')

    fireEvent.change(input, { target: { value: 'sales' } })
    fireEvent.click(await screen.findByRole('button', { name: /Sales by store/ }))
    expect(api.search).toHaveBeenCalledWith('sales')
    expect(api.inspect).toHaveBeenCalledWith({ workspaceId: 'ws-ops', reportId: 'r9' })

    const link = 'https://app.powerbi.com/groups/ws-fin/reports/26ff389c-0000-0000-0000-000000000000/ReportSection'
    fireEvent.change(input, { target: { value: link } })
    expect(screen.getByText(/Press Enter to read this report/)).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.inspect).toHaveBeenLastCalledWith({ target: link })
    expect(screen.queryByText(/Press Enter to read this report/)).toBeNull()
  })

  it('explains why a report can’t be migrated and keeps Continue off', async () => {
    installApi({
      inspect: vi.fn(async () => ({
        ...INSPECTION,
        checks: { ...INSPECTION.checks!, model: { status: 'error', message: 'You can’t query “Sales model”.' } },
        blocked: 'You can’t query “Sales model”. Ask its owner for Build permission.'
      }))
    })
    render(<MigrateReportScreen recentWorkspaces={['ws-fin']} onCancel={vi.fn()} onPicked={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sales overview' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Ask its owner for Build permission')
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('gives a blocked reason once when a check already says it', async () => {
    const reason = 'Its semantic model is in My workspace. Publish the report to a workspace first.'
    installApi({
      inspect: vi.fn(async () => ({
        ...INSPECTION,
        checks: { ...INSPECTION.checks!, model: { status: 'error', message: reason } },
        blocked: reason
      }))
    })
    render(<MigrateReportScreen recentWorkspaces={['ws-fin']} onCancel={vi.fn()} onPicked={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sales overview' }))
    expect(await screen.findAllByText(reason)).toHaveLength(1)
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('asks for an Azure CLI sign-in when it has lapsed', async () => {
    const workspaces = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, needsAz: true, error: 'AADSTS70043', workspaces: [] })
      .mockResolvedValueOnce({ ok: true, workspaces: [{ id: 'ws-fin', name: 'Finance', personal: false }] })
    installApi({ workspaces })
    render(<MigrateReportScreen onCancel={vi.fn()} onPicked={vi.fn()} />)
    expect((await screen.findByRole('alert')).textContent).toContain('az login')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(workspaces).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'Finance' })).toBeTruthy()
  })

  it('leaves on Cancel and Escape', async () => {
    installApi()
    const onCancel = vi.fn()
    render(<MigrateReportScreen onCancel={onCancel} onPicked={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
    await screen.findByRole('navigation', { name: 'Workspaces' })
  })
})

describe('report picks', () => {
  it('tells links from search words', () => {
    expect(isReportLink('https://app.powerbi.com/groups/me/reports/x')).toBe(true)
    expect(isReportLink(' 26ff389c-0000-0000-0000-000000000000 ')).toBe(true)
    expect(isReportLink('sales 2024')).toBe(false)
  })

  it('builds the source from an inspection, and only when it can be migrated', () => {
    const pick = pickFromInspection(INSPECTION)!
    expect(describePick(pick)).toBe('Sales overview · Finance · 2 pages · data from “Sales model”')
    expect(pickFromInspection({ ...INSPECTION, blocked: 'No.' })).toBeNull()
    expect(pickFromInspection({ ok: false, pages: [] })).toBeNull()
  })
})
