import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  LocalColumn,
  LocalEntity,
  LocalFile,
  LocalReady,
  LocalRows,
  LocalStatus,
  LocalStorageFolder,
  LocalUser,
  StudioProject
} from '@shared/ipc'
import { makeProject } from '../../../test/harness'
import { emptyDataModel, type DataModel } from '../../model/parseSchema'
import { LocalBackendError, localBackendStore } from '../../localBackend'
import DataView from './DataView'

/**
 * The Data view shows an app's local data through `window.api.local`: its
 * entities and rows, typed and paged, and its local users; it clears and resets
 * that data only after saying what goes; and it says why it can't show any when
 * the backend isn't running, can't be read, or the app's data lives in Fabric.
 */

function status(patch: Partial<LocalStatus> = {}): LocalStatus {
  return {
    projectId: 'p1',
    state: 'stopped',
    revision: 1,
    phase: null,
    pid: null,
    version: '0.2.0',
    projectRoot: null,
    signInAs: 'developer',
    ready: null,
    analysis: null,
    schema: null,
    functions: null,
    vite: null,
    config: null,
    warnings: [],
    error: null,
    stopped: null,
    crashes: 0,
    startedAt: null,
    updatedAt: null,
    ...patch
  }
}

const READY: LocalReady = {
  appUrl: 'http://localhost:5173/',
  apiUrl: 'http://localhost:7171',
  embedUrl: null,
  portalUrl: null,
  dataDir: null,
  signInAs: { kind: 'developer' },
  sdk: { version: '1.36.2', supported: true },
  features: {
    data: { enabled: true, entities: ['Expense', 'Receipt', 'Tag'] },
    functions: { enabled: false, names: [] },
    storage: { enabled: true, folders: ['receipts'] },
    auth: { enabled: true, fabric: true, password: false },
    connectors: []
  },
  time: '2026-10-30T04:00:00Z'
}

const EXPENSE_COLUMNS: LocalColumn[] = [
  { name: 'id', type: 'UUID', key: true },
  { name: 'title', type: 'String', key: false },
  { name: 'amount', type: 'Decimal', key: false },
  { name: 'approved', type: 'Boolean', key: false },
  { name: 'submitted_at', type: 'DateTime', key: false },
  { name: 'details', type: 'String', key: false },
  { name: 'note', type: 'String', key: false }
]

const LONG_TITLE = `Team offsite dinner, ${'with a long explanation of who came and why '.repeat(12)}`

function expense(i: number): Record<string, unknown> {
  return {
    id: `0b5f6c1e-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title: i === 0 ? LONG_TITLE : `Expense ${i}`,
    amount: 1250.5,
    approved: i % 2 === 0,
    submitted_at: '2026-10-29T16:05:00Z',
    details: { source: 'ocr', pages: 2 },
    note: null
  }
}

/** Receipt rows refer to Expense rows. */
const MODEL: DataModel = {
  ...emptyDataModel(),
  hasSchema: true,
  relations: [{ from: 'Receipt', to: 'Expense', kind: 'fk', via: 'expense_id', explicit: false }]
}

let current: LocalStatus
let entities: LocalEntity[]
let users: LocalUser[]
let folders: LocalStorageFolder[]
let stored: Record<string, LocalFile[]>
let local: Record<string, Mock>
let preview: { resetSiteData: Mock }
let record: Mock
let emitState: (status: LocalStatus) => void

function storedFile(
  path: string,
  contentType: string,
  size: number,
  ownerId: string | null
): LocalFile {
  return {
    id: path,
    path,
    name: path.split('/').pop()!,
    size,
    contentType,
    ownerId,
    createdAt: '2026-10-29T10:30:00Z',
    updatedAt: '2026-10-29T10:30:00Z',
    fields: {}
  }
}

/** The bytes of the stored files the previews read. */
const CONTENT: Record<string, string> = {
  'notes.json': '{"total":12.5,"items":["taxi"]}',
  'scans/2026/oct.png': 'png!'
}

function page(entity: string, offset: number, limit: number): LocalRows {
  const total = entities.find((e) => e.name === entity)?.rows ?? 0
  const count = Math.max(0, Math.min(limit, total - offset))
  if (entity === 'Expense') {
    return {
      columns: EXPENSE_COLUMNS,
      rows: Array.from({ length: count }, (_, i) => expense(offset + i)),
      total
    }
  }
  return {
    columns: [
      { name: 'id', type: 'UUID', key: true },
      { name: 'expense_id', type: 'UUID', key: false }
    ],
    rows: Array.from({ length: count }, (_, i) => ({ id: `r${offset + i}`, expense_id: 'e1' })),
    total
  }
}

beforeEach(() => {
  localBackendStore.clear()
  current = status({ state: 'running', ready: READY })
  entities = [
    { name: 'Expense', rows: 120 },
    { name: 'Receipt', rows: 2 },
    { name: 'Tag', rows: 0 }
  ]
  users = [
    {
      id: 'u1',
      username: 'avery.chen@contoso.com',
      email: 'avery.chen@contoso.com',
      createdAt: '2026-10-28T09:00:00Z',
      signIn: ['entra'],
      developer: true
    },
    {
      id: 'u2',
      username: 'ana@example.com',
      email: 'ana@example.com',
      createdAt: '2026-10-29T10:30:00Z',
      signIn: [],
      developer: false
    }
  ]
  record = vi.fn(async () => {})
  folders = [{ name: 'receipts', displayName: 'Receipts', files: 2, bytes: 2079 }]
  stored = {
    receipts: [
      storedFile('notes.json', 'application/json', 31, null),
      { ...storedFile('scans/2026/oct.png', 'image/png', 2048, 'u2'), fields: { expense_id: 'e1' } }
    ]
  }
  const forget = (folder: string, gone: (file: LocalFile) => boolean): number => {
    const before = stored[folder].length
    stored[folder] = stored[folder].filter((file) => !gone(file))
    folders = folders.map((f) => (f.name === folder ? { ...f, files: stored[folder].length } : f))
    return before - stored[folder].length
  }
  local = {
    status: vi.fn(async () => current),
    start: vi.fn(async () => {
      current = status({ state: 'starting', revision: current.revision + 1 })
      return current
    }),
    onState: vi.fn((cb: (status: LocalStatus) => void) => {
      emitState = cb
      return () => {}
    }),
    entities: vi.fn(async () => entities),
    users: vi.fn(async () => users),
    rows: vi.fn(async (_id: string, entity: string, offset: number, limit: number) =>
      page(entity, offset, limit)
    ),
    clearRows: vi.fn(async (_id: string, entity: string) => {
      const deleted = entities.find((e) => e.name === entity)?.rows ?? 0
      entities = entities.map((e) => (e.name === entity ? { ...e, rows: 0 } : e))
      return deleted
    }),
    resetData: vi.fn(async () => {
      entities = entities.map((e) => ({ ...e, rows: 0 }))
      users = []
    }),
    deleteUser: vi.fn(async (_id: string, user: string) => {
      users = users.filter((u) => u.id !== user)
    }),
    storage: vi.fn(async () => folders),
    files: vi.fn(async (_id: string, folder: string, offset: number, limit: number) => ({
      files: (stored[folder] ?? []).slice(offset, offset + limit),
      total: (stored[folder] ?? []).length
    })),
    file: vi.fn(
      async (_id: string, _folder: string, path: string) =>
        new TextEncoder().encode(CONTENT[path] ?? '').buffer
    ),
    saveFile: vi.fn(async () => 'C:\\Users\\avery\\Downloads\\oct.png'),
    deleteFile: vi.fn(async (_id: string, folder: string, path: string) => {
      forget(folder, (file) => file.path === path)
    }),
    clearFiles: vi.fn(async (_id: string, folder: string) => forget(folder, () => true)),
    reload: vi.fn(async () => ({ schema: null, config: null }))
  }
  preview = { resetSiteData: vi.fn(async () => true) }
  ;(window as unknown as { api: unknown }).api = { local, preview, diagnostics: { record } }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

function renderView(project: StudioProject = makeProject('p1')): ReturnType<typeof render> {
  return render(<DataView project={project} refreshKey={0} dataModel={MODEL} />)
}

describe('DataView', () => {
  it('lists the entities with their row counts and shows a page of rows, formatted by type', async () => {
    renderView()
    const list = await screen.findByRole('navigation', { name: 'Local data' })
    expect(
      within(list).getByRole('button', { name: 'Expense, 120 rows' }).getAttribute('aria-current')
    ).toBe('true')
    expect(within(list).getByRole('button', { name: 'Tag, 0 rows' })).toBeTruthy()
    expect(within(list).getByRole('button', { name: /Local users/ }).textContent).toContain('2')
    expect(screen.getByText('3 entities · 122 rows')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    expect(
      screen.getByText('Local data on this computer, separate from the published app’s data.')
    ).toBeTruthy()
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ area: 'preview', event: 'local.data_view_opened', projectId: 'p1' })
    )

    const table = await screen.findByRole('table')
    expect(local.rows).toHaveBeenCalledWith('p1', 'Expense', 0, 50, undefined, undefined)
    expect(within(table).getByRole('columnheader', { name: /^id/ }).textContent).toContain(
      'UUID · key'
    )
    const cells = within(within(table).getAllByRole('row')[1]).getAllByRole('cell')
    const [id, title, amount, approved, submitted, details, note] = cells
    const hover = (cell: HTMLElement): string | null =>
      cell.querySelector('[title]')?.getAttribute('title') ?? null
    expect(id.className).toContain('key')
    // Long text is cut short, with all of it on hover.
    expect(title.textContent!.length).toBeLessThan(LONG_TITLE.length)
    expect(hover(title)).toBe(LONG_TITLE)
    expect(amount.textContent).toBe('1250.5')
    expect(amount.className).toContain('number')
    expect(approved.textContent).toBe('true')
    expect(submitted.textContent).toContain('2026')
    expect(submitted.textContent).not.toBe('2026-10-29T16:05:00Z')
    expect(hover(submitted)).toBe('2026-10-29T16:05:00Z')
    expect(details.textContent).toBe('{"source":"ocr","pages":2}')
    expect(hover(details)).toContain('"pages": 2')
    expect(note.textContent).toBe('null')
    expect(note.className).toContain('null')
  })

  it('sorts by a column and pages through the rows', async () => {
    renderView()
    const table = await screen.findByRole('table')
    fireEvent.click(within(table).getByRole('button', { name: /^amount/ }))
    await waitFor(() =>
      expect(local.rows).toHaveBeenLastCalledWith('p1', 'Expense', 0, 50, 'amount', false)
    )
    expect(screen.getByRole('columnheader', { name: /^amount/ }).getAttribute('aria-sort')).toBe(
      'ascending'
    )
    fireEvent.click(screen.getByRole('button', { name: /^amount/ }))
    await waitFor(() =>
      expect(local.rows).toHaveBeenLastCalledWith('p1', 'Expense', 0, 50, 'amount', true)
    )
    expect(await screen.findByText('1–50 of 120')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('51–100 of 120')).toBeTruthy()
    expect(local.rows).toHaveBeenLastCalledWith('p1', 'Expense', 50, 50, 'amount', true)
    expect(screen.getByRole('button', { name: 'Previous page' })).toHaveProperty('disabled', false)
  })

  it('offers to clear a sort the local backend can’t apply', async () => {
    renderView()
    const table = await screen.findByRole('table')
    local.rows.mockRejectedValueOnce(
      new LocalBackendError({
        code: 'invalid-order',
        message: 'Rows can’t be sorted by details.',
        status: 400
      })
    )
    fireEvent.click(within(table).getByRole('button', { name: /^details/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t read the rows')
    expect(alert.textContent).toContain('Rows can’t be sorted by details.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Clear sorting' }))
    expect(await screen.findByRole('table')).toBeTruthy()
    expect(local.rows).toHaveBeenLastCalledWith('p1', 'Expense', 0, 50, undefined, undefined)
  })

  it('clears an entity’s rows after saying what goes, and explains rows that still refer to them', async () => {
    local.clearRows.mockRejectedValueOnce(
      new LocalBackendError({
        code: 'rows-referenced',
        message: 'Receipt rows refer to Expense rows.',
        status: 409
      })
    )
    renderView()
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: 'Clear rows' }))
    let dialog = screen.getByRole('dialog', { name: 'Clear all Expense rows?' })
    expect(dialog.textContent).toContain(
      'This deletes all 120 rows of Expense from the app’s local data on this computer.'
    )
    expect(dialog.textContent).toContain('The published app’s data isn’t affected.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear rows' }))
    const refused = await within(dialog).findByRole('alert')
    expect(refused.textContent).toContain(
      'Rows of Receipt still refer to these rows, so they can’t be cleared on their own. Clear Receipt first, or reset all local data.'
    )
    expect(refused.textContent).toContain('Receipt rows refer to Expense rows.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Receipt, 2 rows' }))
    await screen.findByText('1–2 of 2')
    fireEvent.click(screen.getByRole('button', { name: 'Clear rows' }))
    dialog = screen.getByRole('dialog', { name: 'Clear all Receipt rows?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear rows' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(local.clearRows).toHaveBeenLastCalledWith('p1', 'Receipt')
    expect(await screen.findByText('No rows yet')).toBeTruthy()
    expect(
      screen.getByText('The app’s own pages add data. Use the app in the preview, then refresh.')
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Receipt, 0 rows' })).toBeTruthy()
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: 'local.rows_cleared' }))
  })

  it('resets the local data after listing everything it deletes', async () => {
    renderView()
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: 'Reset local data' }))
    const dialog = screen.getByRole('dialog', { name: 'Reset local data?' })
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      'All 122 rows of its 3 entities',
      'Its 2 local users and their sessions',
      'Its 2 stored files'
    ])
    expect(dialog.textContent).not.toContain('data model change')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset local data' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(local.resetData).toHaveBeenCalledWith('p1')
    expect(local.reload).not.toHaveBeenCalled()
    // The reset signed the preview's session out: it signs in again from scratch.
    expect(preview.resetSiteData).toHaveBeenCalledTimes(1)
    expect(local.resetData.mock.invocationCallOrder[0]).toBeLessThan(
      preview.resetSiteData.mock.invocationCallOrder[0]
    )
    expect(await screen.findByText('3 entities · 0 rows')).toBeTruthy()
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: 'local.data_reset' }))
  })

  it('applies a data model change that waits for a decision once a reset leaves no data to lose', async () => {
    current = status({
      state: 'running',
      ready: READY,
      schema: {
        result: 'refused',
        changes: ['Drop Expense.note'],
        losses: ['Expense.note (120 values)'],
        message: null,
        live: true,
        time: '2026-10-30T04:05:00Z'
      }
    })
    renderView()
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: 'Reset local data' }))
    const dialog = screen.getByRole('dialog', { name: 'Reset local data?' })
    expect(dialog.textContent).toContain(
      'Then the data model change waiting for your decision applies.'
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset local data' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(local.resetData).toHaveBeenCalledWith('p1')
    expect(local.reload).toHaveBeenCalledWith('p1', false)
    expect(local.resetData.mock.invocationCallOrder[0]).toBeLessThan(
      local.reload.mock.invocationCallOrder[0]
    )
  })

  it('lists the local users and deletes one after confirming', async () => {
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: /Local users/ }))
    const pane = screen.getByRole('region', { name: 'Local users' })
    expect(within(pane).getByText('Developer')).toBeTruthy()
    expect(within(pane).getByText('Microsoft Entra ID')).toBeTruthy()
    expect(within(pane).getByText('Fabricator only')).toBeTruthy()
    fireEvent.click(within(pane).getByRole('button', { name: 'Delete ana@example.com' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete ana@example.com?' })
    expect(dialog.textContent).toContain(
      'This deletes ana@example.com from the app’s local users and signs them out of the app on this computer.'
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete user' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(local.deleteUser).toHaveBeenCalledWith('p1', 'u2')
    await waitFor(() => expect(within(pane).queryByText('ana@example.com')).toBeNull())
  })

  it('lists the storage folders and a folder’s files with their type, size and owner', async () => {
    renderView()
    const list = await screen.findByRole('navigation', { name: 'Local data' })
    expect(within(list).getByText('Storage')).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: 'Receipts, 2 files' }))
    const pane = await screen.findByRole('region', { name: 'Receipts files' })
    // The @blob class names the folder; its own name is beside it.
    expect(within(pane).getByText('receipts')).toBeTruthy()
    expect(within(pane).getByText('2 files · 2 KB')).toBeTruthy()
    const table = await within(pane).findByRole('table')
    expect(local.files).toHaveBeenCalledWith('p1', 'receipts', 0, 50)
    const cells = (row: HTMLElement): string[] =>
      within(row)
        .getAllByRole('cell')
        .slice(0, 4)
        .map((cell) => cell.textContent ?? '')
    const [notes, scan] = within(table).getAllByRole('row').slice(1)
    expect(cells(notes)).toEqual(['notes.json', 'application/json', '31 bytes', 'Anonymous'])
    // Owners show by username.
    expect(cells(scan)).toEqual(['scans/2026/oct.png', 'image/png', '2 KB', 'ana@example.com'])
  })

  it('previews a stored file with its details, and saves a copy', async () => {
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL })
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: 'Receipts, 2 files' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Preview notes.json' }))
    const json = await screen.findByRole('complementary', { name: 'Preview of notes.json' })
    // JSON shows indented, read no further than a text preview shows.
    expect(await within(json).findByText(/"items": \[/)).toBeTruthy()
    expect(local.file).toHaveBeenCalledWith('p1', 'receipts', 'notes.json', 256 * 1024)

    fireEvent.click(screen.getByRole('button', { name: 'Preview scans/2026/oct.png' }))
    const image = await screen.findByRole('complementary', {
      name: 'Preview of scans/2026/oct.png'
    })
    const shown = await within(image).findByRole('img', { name: 'oct.png' })
    expect(shown.getAttribute('src')).toBe('blob:preview')
    // The app's own fields of the file, and its owner.
    expect(within(image).getByText('expense_id')).toBeTruthy()
    expect(within(image).getByText('ana@example.com')).toBeTruthy()

    fireEvent.click(within(image).getByRole('button', { name: 'Save a copy' }))
    await waitFor(() =>
      expect(local.saveFile).toHaveBeenCalledWith('p1', 'receipts', 'scans/2026/oct.png')
    )
    fireEvent.click(within(image).getByRole('button', { name: 'Close the preview' }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  })

  it('deletes a stored file and clears a folder after saying what goes', async () => {
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: 'Receipts, 2 files' }))
    const pane = await screen.findByRole('region', { name: 'Receipts files' })
    fireEvent.click(await within(pane).findByRole('button', { name: 'Delete scans/2026/oct.png' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete oct.png?' })
    expect(dialog.textContent).toContain(
      'This deletes scans/2026/oct.png from the Receipts storage folder of the app’s local data on this computer.'
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(local.deleteFile).toHaveBeenCalledWith('p1', 'receipts', 'scans/2026/oct.png')
    expect(await screen.findByRole('button', { name: 'Receipts, 1 file' })).toBeTruthy()
    await waitFor(() =>
      expect(within(pane).queryByRole('button', { name: 'Preview scans/2026/oct.png' })).toBeNull()
    )
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: 'local.file_deleted' }))

    fireEvent.click(within(pane).getByRole('button', { name: 'Clear files' }))
    const clear = screen.getByRole('dialog', { name: 'Delete all Receipts files?' })
    expect(clear.textContent).toContain('This deletes the only file in the Receipts storage folder')
    fireEvent.click(within(clear).getByRole('button', { name: 'Clear files' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(local.clearFiles).toHaveBeenCalledWith('p1', 'receipts')
    expect(await within(pane).findByText('No files yet')).toBeTruthy()
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: 'local.files_cleared' }))
  })

  it('shows no storage when the local backend can’t list stored files', async () => {
    local.storage.mockRejectedValueOnce(
      new LocalBackendError({
        code: 'not-found',
        message: 'The local backend doesn’t know that.',
        status: 404
      })
    )
    renderView()
    const list = await screen.findByRole('navigation', { name: 'Local data' })
    expect(within(list).getByRole('button', { name: 'Expense, 120 rows' })).toBeTruthy()
    expect(within(list).queryByText('Storage')).toBeNull()
  })

  it('offers to start a backend that isn’t running, and says why it stopped', async () => {
    current = status({ state: 'stopped' })
    renderView()
    expect(await screen.findByText('The local backend isn’t running')).toBeTruthy()
    expect(screen.getAllByText('Stopped')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Reset local data' })).toHaveProperty(
      'disabled',
      true
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByText('The local backend is starting')).toBeTruthy()
    expect(local.start.mock.calls[0][0]).toBe('p1')
    expect(local.entities).not.toHaveBeenCalled()

    act(() =>
      emitState(
        status({
          state: 'error',
          revision: 9,
          error: {
            code: 'vite-failed',
            message: 'Vite exited before it was ready.',
            hint: null,
            fatal: true,
            details: null,
            time: null
          }
        })
      )
    )
    expect(screen.getByText('Vite exited before it was ready.')).toBeTruthy()
    expect(screen.getAllByText('Error')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy()
  })

  it('explains when the local backend or its data can’t be read, and tries again', async () => {
    local.status.mockRejectedValue(
      new LocalBackendError({ code: 'unreachable', message: 'Fabricator couldn’t reach it.' })
    )
    local.entities.mockRejectedValueOnce(
      new LocalBackendError({
        code: 'not-found',
        message: 'The local backend doesn’t know that.',
        status: 404
      })
    )
    renderView()
    let alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t reach the local backend')
    expect(alert.textContent).toContain('Fabricator couldn’t reach it.')
    expect(screen.getByText('Unknown')).toBeTruthy()

    local.status.mockImplementation(async () => current)
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await screen.findByText('Couldn’t read the local data')
    alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(
      'This version of the local backend doesn’t share its data with Fabricator.'
    )
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Expense, 120 rows' })).toBeTruthy()
  })

  it('says it shows local data only for a team app', () => {
    renderView(
      makeProject('p1', { team: { workspaceId: 'w1', folder: 'expenses', worktree: 'x' } })
    )
    expect(screen.getByText('Local data only', { selector: '.model-empty-title' })).toBeTruthy()
    expect(
      screen.getByText(
        'The Data view shows data stored on this computer. This team app runs on its Fabric deployment, so its data lives in Fabric.'
      )
    ).toBeTruthy()
    expect(local.status).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'local.data_view_opened' })
    )
  })

  it('says it shows local data only while the preview uses the published app’s backend', async () => {
    current = status({
      state: 'running',
      ready: {
        ...READY,
        features: {
          ...READY.features,
          connectors: [{ name: 'telemetry', type: 'kusto', supported: false }]
        }
      }
    })
    const { rerender } = renderView()
    const note = await screen.findByRole('note')
    expect(note.textContent).toContain('telemetry')
    expect(note.textContent).toMatch(/The Data view shows local data only\.$/)
    // Without a published app there's nothing to fall back to.
    rerender(
      <DataView
        project={makeProject('p1', { lastDeploy: undefined })}
        refreshKey={0}
        dataModel={MODEL}
      />
    )
    expect(screen.queryByRole('note')).toBeNull()
    expect(
      screen.getByText('Local data on this computer. Publishing doesn’t copy it to Fabric.')
    ).toBeTruthy()
  })

  it('says why no entities show while the backend keeps a data model change it couldn’t read', async () => {
    entities = []
    current = status({
      state: 'running',
      ready: { ...READY, features: { ...READY.features, data: { enabled: false, entities: [] } } },
      analysis: {
        ok: false,
        sdk: null,
        entities: [],
        storageFolders: [],
        message: 'The data package packages/data has not been built.',
        time: '2026-10-30T17:18:08Z'
      }
    })
    renderView()
    expect(await screen.findByText('0 entities · 0 rows')).toBeTruthy()
    const note = screen.getByRole('note', { name: 'Data model change not read' })
    expect(note.textContent).toContain(
      'No entities show because the app’s latest data model change couldn’t be read. Its local backend still uses the previous data model, which has none.'
    )
    expect(note.textContent).toContain('The data package packages/data has not been built.')
    expect(screen.getByText('Running · problem')).toBeTruthy()

    // Read at last: the note goes.
    entities = [{ name: 'Task', rows: 0 }]
    await act(async () =>
      emitState(
        status({
          state: 'running',
          revision: 2,
          ready: READY,
          analysis: { ...current.analysis!, ok: true, message: null, time: '2026-10-30T17:19:05Z' }
        })
      )
    )
    expect(await screen.findByText('1 entity · 0 rows')).toBeTruthy()
    expect(screen.queryByRole('note', { name: 'Data model change not read' })).toBeNull()
    expect(screen.getByText('Running')).toBeTruthy()
  })
})
