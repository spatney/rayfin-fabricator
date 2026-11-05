import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LocalEntity, LocalSeed, LocalSeedLoad, LocalStorageFolder } from '@shared/ipc'
import SeedOffer from './SeedOffer'

/**
 * The preview offers an app's seed data while its local data is empty, as when
 * the project is opened on this computer for the first time; loading it then
 * loses nothing, so it doesn't ask first.
 */

let seed: LocalSeed
let entities: LocalEntity[]
let folders: LocalStorageFolder[]
let loaded: LocalSeedLoad
let local: Record<string, Mock>
let record: Mock

beforeEach(() => {
  localStorage.clear()
  seed = {
    exists: true,
    entities: [{ name: 'Todo', file: 'rayfin/seed/data/Todo.json', rows: 12 }],
    storage: [{ folder: 'todo-attachments', files: 2, bytes: 2048 }],
    users: ['$developer'],
    problems: []
  }
  entities = [{ name: 'Todo', rows: 0 }]
  folders = [{ name: 'todo-attachments', displayName: 'Attachments', files: 0, bytes: 0 }]
  loaded = {
    ok: true,
    dryRun: false,
    entities: [{ name: 'Todo', rows: 12 }],
    storage: [{ folder: 'todo-attachments', files: 2 }],
    problems: []
  }
  local = {
    seed: vi.fn(async () => seed),
    entities: vi.fn(async () => entities),
    storage: vi.fn(async () => folders),
    loadSeed: vi.fn(async () => {
      entities = [{ name: 'Todo', rows: 12 }]
      return loaded
    })
  }
  record = vi.fn(async () => {})
  ;(window as unknown as { api: unknown }).api = { local, diagnostics: { record } }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

function renderOffer(props: Partial<Parameters<typeof SeedOffer>[0]> = {}) {
  const onLoaded = vi.fn()
  const onSendToChat = vi.fn()
  const view = render(
    <SeedOffer
      projectId="p1"
      stamp="s1"
      onLoaded={onLoaded}
      onSendToChat={onSendToChat}
      {...props}
    />
  )
  return { ...view, onLoaded, onSendToChat }
}

describe('SeedOffer', () => {
  it('loads the seed data into empty local data, and shows the app again', async () => {
    const { onLoaded } = renderOffer()
    const note = await screen.findByRole('region', { name: 'Seed data' })
    expect(note.textContent).toContain('This app comes with seed data (12 rows and 2 files)')
    fireEvent.click(screen.getByRole('button', { name: 'Load seed data' }))
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1))
    expect(local.loadSeed).toHaveBeenCalledWith('p1')
    expect(screen.queryByRole('region', { name: 'Seed data' })).toBeNull()
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: 'local.seed_loaded' }))
  })

  it('isn’t offered while the local data holds rows or files, or without seed data', async () => {
    entities = [{ name: 'Todo', rows: 1 }]
    const { rerender, onLoaded } = renderOffer()
    await waitFor(() => expect(local.entities).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Seed data' })).toBeNull()

    entities = [{ name: 'Todo', rows: 0 }]
    folders = [{ name: 'todo-attachments', displayName: 'Attachments', files: 1, bytes: 9 }]
    rerender(<SeedOffer projectId="p1" stamp="s2" onLoaded={onLoaded} />)
    await waitFor(() => expect(local.entities).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('region', { name: 'Seed data' })).toBeNull()

    seed = { ...seed, exists: false }
    folders = []
    rerender(<SeedOffer projectId="p1" stamp="s3" onLoaded={onLoaded} />)
    await waitFor(() => expect(local.seed).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('region', { name: 'Seed data' })).toBeNull()
  })

  it('doesn’t replace data added since it was offered', async () => {
    const { onLoaded } = renderOffer()
    await screen.findByRole('region', { name: 'Seed data' })
    entities = [{ name: 'Todo', rows: 1 }]
    fireEvent.click(screen.getByRole('button', { name: 'Load seed data' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Seed data' })).toBeNull())
    expect(local.loadSeed).not.toHaveBeenCalled()
    expect(onLoaded).not.toHaveBeenCalled()
  })

  it('says what keeps the seed data from loading, and hands it to Copilot', async () => {
    loaded = {
      ...loaded,
      ok: false,
      entities: [],
      storage: [],
      problems: [
        {
          file: 'rayfin/seed/data/Todo.json',
          row: 3,
          field: 'status',
          message: '`status` must be one of: open, done.'
        }
      ]
    }
    const { onLoaded, onSendToChat } = renderOffer()
    await screen.findByRole('region', { name: 'Seed data' })
    fireEvent.click(screen.getByRole('button', { name: 'Load seed data' }))
    const note = await screen.findByText(/The seed data has 1 problem/)
    expect(note.closest('section')!.textContent).toContain(
      'rayfin/seed/data/Todo.json, row 3, `status`: `status` must be one of: open, done.'
    )
    expect(onLoaded).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Fix with Copilot' }))
    expect(onSendToChat).toHaveBeenCalledWith(
      'Fix the seed data’s problems',
      expect.stringContaining('`status` must be one of: open, done.')
    )
  })

  it('stays away once dismissed, for that project', async () => {
    const { unmount, onLoaded } = renderOffer()
    await screen.findByRole('region', { name: 'Seed data' })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('region', { name: 'Seed data' })).toBeNull()
    unmount()
    render(<SeedOffer projectId="p1" stamp="s2" onLoaded={onLoaded} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('region', { name: 'Seed data' })).toBeNull()
    expect(local.seed).toHaveBeenCalledTimes(1)
  })
})
