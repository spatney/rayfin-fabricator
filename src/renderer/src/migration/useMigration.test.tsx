import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { MigrationPage, MigrationState } from '@shared/ipc'
import { makeProject } from '../../test/harness'
import { useMigration } from './useMigration'
import type { MigrationTurn } from './turns'

vi.mock('./pdfPages', () => ({
  countPdfPages: vi.fn(async () => 2),
  drawPdfPages: vi.fn(async (_data: ArrayBuffer, onPage: (page: object, index: number, total: number) => Promise<void>) => {
    await onPage({ png: 'data:image/png;base64,AA', thumb: 'data:image/png;base64,BB', text: 'Revenue' }, 0, 2)
    await onPage({ png: 'data:image/png;base64,CC', thumb: 'data:image/png;base64,DD', text: 'Regions' }, 1, 2)
    return 2
  })
}))

const done = { status: 'done' as const }
const page = (name: string, order: number, status: MigrationPage['status'] = 'pending'): MigrationPage => ({
  name,
  displayName: name,
  order,
  kind: 'page',
  hidden: false,
  stem: `0${order + 1}-${name.toLowerCase()}`,
  status
})

function migration(over: Partial<MigrationState> = {}): MigrationState {
  return {
    version: 1,
    dir: '.fabricator/migration/sales',
    alias: 'sales',
    source: { reportId: 'r1', reportName: 'Sales', workspaceId: 'ws', personal: false, modelId: 'ds' },
    stages: { definition: done, model: done, export: done, images: done },
    pages: [page('Overview', 0), page('Regions', 1), page('Stores', 2)],
    pdfs: ['export-1.pdf'],
    warnings: [],
    startedAt: '',
    dismissed: false,
    ...over
  }
}

/** A fake migration API backed by one project's state. */
function installApi(initial: MigrationState) {
  let state = initial
  const api = {
    onState: vi.fn(() => () => {}),
    resume: vi.fn(async () => state),
    setPageStatus: vi.fn(async (_id: string, index: number, status: MigrationPage['status']) => {
      state = { ...state, pages: state.pages.map((p, i) => (i === index ? { ...p, status } : p)) }
      return state
    }),
    pdf: vi.fn(async () => new ArrayBuffer(8)),
    savePage: vi.fn(async (_id: string, index: number, _png: string, _text: string, thumb: string) => {
      state = { ...state, pages: state.pages.map((p, i) => (i === index ? { ...p, thumb, image: `${p.stem}.png` } : p)) }
      return state
    }),
    finishImages: vi.fn(async () => {
      state = { ...state, stages: { ...state.stages, images: done } }
      return state
    }),
    cancel: vi.fn(async () => true),
    dismiss: vi.fn(async () => state)
  }
  ;(window as unknown as { api: unknown }).api = { migration: api }
  return api
}

function renderMigration(canStart = true) {
  const send = vi.fn<(projectId: string, turn: MigrationTurn) => void>()
  const hook = renderHook((props: { canStart: boolean }) =>
    useMigration({ enabled: true, project: makeProject('p1'), canStart: props.canStart, send, onError: vi.fn() }),
    { initialProps: { canStart } }
  )
  return { send, ...hook }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('useMigration', () => {
  it('starts the first page by itself, once it can, and records its turn', async () => {
    const api = installApi(migration())
    const { send, result, rerender } = renderMigration(false)
    await waitFor(() => expect(result.current.state).not.toBeNull())
    expect(send).not.toHaveBeenCalled()

    rerender({ canStart: true })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][1].migration).toMatchObject({ foundation: true, page: { index: 0, name: 'Overview' } })
    expect(api.setPageStatus).toHaveBeenCalledWith('p1', 0, 'running')

    act(() => result.current.onTurnComplete('p1', true))
    await waitFor(() => expect(api.setPageStatus).toHaveBeenLastCalledWith('p1', 0, 'done'))
  })

  it('migrates the rest one page at a time, each after the last turn settles', async () => {
    const api = installApi(migration({ pages: [page('Overview', 0, 'done'), page('Regions', 1), page('Stores', 2)] }))
    const { send, result } = renderMigration()
    await waitFor(() => expect(result.current.state).not.toBeNull())

    act(() => result.current.migrateRest())
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][1].display).toBe('Migrate page 2 of 3: Regions')
    expect(result.current.chaining).toBe(true)

    act(() => {
      result.current.onTurnComplete('p1', true)
      result.current.onTurnSettled('p1')
    })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 4000 })
    expect(send.mock.calls[1][1].display).toBe('Migrate page 3 of 3: Stores')

    act(() => {
      result.current.onTurnComplete('p1', true)
      result.current.onTurnSettled('p1')
    })
    await waitFor(() => expect(api.setPageStatus).toHaveBeenLastCalledWith('p1', 2, 'done'))
    await waitFor(() => expect(result.current.chaining).toBe(false), { timeout: 4000 })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('pauses the rest when you send your own message, or a page fails', async () => {
    installApi(migration({ pages: [page('Overview', 0, 'done'), page('Regions', 1), page('Stores', 2)] }))
    const { send, result } = renderMigration()
    await waitFor(() => expect(result.current.state).not.toBeNull())
    act(() => result.current.migrateRest())
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    act(() => result.current.onTurnComplete('p1', false))
    expect(result.current.chaining).toBe(false)
    await waitFor(() => expect(result.current.state?.pages[1].status).toBe('failed'))

    act(() => result.current.migrateRest())
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1][1].display).toBe('Migrate page 2 of 3: Regions')
    act(() => result.current.onTurnComplete('p1', true))
    expect(result.current.chaining).toBe(true)
    act(() => result.current.onTurnComplete('p1', true))
    expect(result.current.chaining).toBe(false)
  })

  it('draws the exported pages and saves each with its text', async () => {
    const api = installApi(
      migration({
        stages: { definition: done, model: done, export: done, images: { status: 'pending' } },
        pages: [page('Overview', 0), page('Regions', 1)]
      })
    )
    const { result } = renderMigration(false)
    await waitFor(() => expect(api.finishImages).toHaveBeenCalledWith('p1', undefined))
    expect(api.savePage.mock.calls.map((c) => [c[1], c[3]])).toEqual([
      [0, 'Revenue'],
      [1, 'Regions']
    ])
    await waitFor(() => expect(result.current.state?.pages[1].thumb).toBe('data:image/png;base64,DD'))
  })

  it('leaves the images out when the export is missing a page, rather than mismatch them', async () => {
    const api = installApi(migration({ stages: { definition: done, model: done, export: done, images: { status: 'pending' } } }))
    renderMigration(false)
    await waitFor(() =>
      expect(api.finishImages).toHaveBeenCalledWith('p1', expect.stringContaining('has 2 of the report’s 3 pages'))
    )
    expect(api.savePage).not.toHaveBeenCalled()
  })
})
