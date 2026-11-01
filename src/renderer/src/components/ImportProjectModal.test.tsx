import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ImportPreview, ImportResult, ZipProgressEvent } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import ImportProjectModal from './ImportProjectModal'
import { makeProject } from '../../test/harness'

const FILE = 'C:\\Users\\sam\\Downloads\\sales.fabricator'

const PREVIEW: ImportPreview = {
  name: 'Sales',
  from: 'amy@contoso.com',
  exportedAt: '2026-11-01T19:40:00.000Z',
  files: 214,
  bytes: 1_363_148,
  history: true,
  workspace: 'fabcon',
  secrets: ['OPENAI_KEY'],
  folder: 'D:\\apps\\sales'
}

function installApi(preview: ImportPreview | Error = PREVIEW) {
  let listener: ((event: ZipProgressEvent) => void) | null = null
  let finish: ((result: ImportResult) => void) | null = null
  const projects = {
    inspectImport: vi.fn(() =>
      preview instanceof Error ? Promise.reject(preview) : Promise.resolve(preview)
    ),
    importProject: vi.fn(
      () =>
        new Promise<ImportResult>((resolve) => {
          finish = resolve
        })
    ),
    onZipProgress: vi.fn((cb: (event: ZipProgressEvent) => void) => {
      listener = cb
      return () => {
        listener = null
      }
    })
  }
  ;(window as unknown as { api: unknown }).api = { projects }
  return {
    projects,
    progress: (processed: number, total: number) =>
      act(() => listener?.({ id: 'import', phase: 'unpacking', processed, total })),
    finish: (result: ImportResult) =>
      act(async () => {
        finish?.(result)
      })
  }
}

function renderModal(): {
  onImported: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const onImported = vi.fn()
  const onClose = vi.fn()
  render(
    <OverlayProvider>
      <ImportProjectModal path={FILE} onImported={onImported} onClose={onClose} />
    </OverlayProvider>
  )
  return { onImported, onClose }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('ImportProjectModal', () => {
  it('says what a file brings in and asks before importing it', async () => {
    const api = installApi()
    const { onImported, onClose } = renderModal()

    expect(screen.getByText('Reading sales.fabricator…')).toBeTruthy()
    const facts = within(await screen.findByRole('list', { name: 'What it brings in' }))
    expect(api.projects.inspectImport).toHaveBeenCalledWith(FILE)
    expect(screen.getByText(/^Exported by amy@contoso\.com on /)).toBeTruthy()
    expect(facts.getByText('214 files · 1.3 MB')).toBeTruthy()
    expect(facts.getByText('Version history')).toBeTruthy()
    expect(facts.getByText('fabcon')).toBeTruthy()
    expect(facts.getByText(/Ask amy@contoso\.com for workspace access/)).toBeTruthy()
    expect(facts.getByText('OPENAI_KEY')).toBeTruthy()
    expect(screen.getByText('D:\\apps\\sales')).toBeTruthy()
    expect(screen.getByText(/Only import projects from people you trust/)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Import' }))
    expect(api.projects.importProject).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(api.projects.importProject).toHaveBeenCalledWith(FILE)
    api.progress(40, 254)
    expect(screen.getByRole('progressbar', { name: 'Import progress' })).toBeTruthy()
    expect(screen.getByText('40 of 254 files')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true
    )

    const project = makeProject('p9', { name: 'Sales', path: 'D:\\apps\\sales' })
    await api.finish({ ok: true, project })
    expect(onImported).toHaveBeenCalledWith(project)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('names the file when it doesn’t say who exported it, and leaves out what it doesn’t bring', async () => {
    installApi({
      ...PREVIEW,
      from: undefined,
      exportedAt: undefined,
      history: false,
      workspace: undefined,
      secrets: []
    })
    renderModal()

    const facts = within(await screen.findByRole('list', { name: 'What it brings in' }))
    expect(screen.getByText('From sales.fabricator')).toBeTruthy()
    expect(facts.getAllByRole('listitem')).toHaveLength(1)
  })

  it('shows why a file can’t be imported, and only offers to close', async () => {
    const api = installApi(
      new Error('This file doesn’t hold a Rayfin project: there’s no rayfin/rayfin.yml in it.')
    )
    const { onClose } = renderModal()

    expect((await screen.findByRole('alert')).textContent).toContain(
      'doesn’t hold a Rayfin project'
    )
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull()
    const close = screen.getAllByRole('button', { name: 'Close' })
    fireEvent.click(close[close.length - 1])
    expect(onClose).toHaveBeenCalled()
    expect(api.projects.importProject).not.toHaveBeenCalled()
  })

  it('keeps the dialog open with the reason when importing fails', async () => {
    const api = installApi()
    const { onImported, onClose } = renderModal()

    fireEvent.click(await screen.findByRole('button', { name: 'Import' }))
    await api.finish({ ok: false, error: 'Couldn’t create D:\\apps\\sales: access is denied' })
    expect(screen.getByRole('alert').textContent).toContain('access is denied')
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(
      false
    )
    expect(onImported).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
