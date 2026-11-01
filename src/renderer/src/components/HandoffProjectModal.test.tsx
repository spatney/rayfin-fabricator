import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type {
  HandoffPreview,
  HandoffProgressEvent,
  HandoffSaveResult,
  StudioProject
} from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import HandoffProjectModal from './HandoffProjectModal'
import { makeProject } from '../../test/harness'

const WORKSPACE_ID = 'fa67c3f6-03b2-4cc3-9403-956c4be2f38b'

const PREVIEW: HandoffPreview = {
  files: 214,
  bytes: 1_363_148,
  history: { versions: 38, bytes: 4_300_000 },
  deployment: { workspace: 'fabcon', workspaceId: WORKSPACE_ID, url: 'https://sales.example.app' },
  chatMessages: 24,
  secrets: ['OPENAI_KEY', 'STRIPE_KEY'],
  keptOut: []
}

function installApi(preview: HandoffPreview | Error = PREVIEW) {
  let listener: ((event: HandoffProgressEvent) => void) | null = null
  let finish: ((result: HandoffSaveResult) => void) | null = null
  const handoff = {
    preview: vi.fn(() =>
      preview instanceof Error ? Promise.reject(preview) : Promise.resolve(preview)
    ),
    save: vi.fn(
      () =>
        new Promise<HandoffSaveResult>((resolve) => {
          finish = resolve
        })
    ),
    stop: vi.fn(() => Promise.resolve()),
    reveal: vi.fn(() => Promise.resolve()),
    onProgress: vi.fn((cb: (event: HandoffProgressEvent) => void) => {
      listener = cb
      return () => {
        listener = null
      }
    })
  }
  const openExternal = vi.fn()
  ;(window as unknown as { api: unknown }).api = { projects: { handoff }, openExternal }
  return {
    handoff,
    openExternal,
    progress: (processed: number, total: number) =>
      act(() => listener?.({ id: 'p1', phase: 'packing', processed, total })),
    finish: (result: HandoffSaveResult) =>
      act(async () => {
        finish?.(result)
      })
  }
}

function renderModal(over: { project?: StudioProject; busy?: string } = {}): {
  onClose: ReturnType<typeof vi.fn>
} {
  const onClose = vi.fn()
  render(
    <OverlayProvider>
      <HandoffProjectModal
        project={over.project ?? makeProject('p1', { name: 'Sales' })}
        busy={over.busy}
        onClose={onClose}
      />
    </OverlayProvider>
  )
  return { onClose }
}

function box(name: string): HTMLInputElement {
  return screen.getByRole('checkbox', { name }) as HTMLInputElement
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('HandoffProjectModal', () => {
  it('includes everything the project has, saves what is chosen, then says what the recipient needs', async () => {
    const api = installApi()
    const { onClose } = renderModal()

    await screen.findByRole('checkbox', { name: 'Version history' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save .zip…' }))
    expect(box('App code').checked).toBe(true)
    expect(box('App code').disabled).toBe(true)
    expect(screen.getByText('214 files · 1.3 MB')).toBeTruthy()
    expect(box('Version history').checked).toBe(true)
    expect(screen.getByText('38 versions · 4.1 MB')).toBeTruthy()
    expect(box('Published app').checked).toBe(true)
    expect(screen.getByText('fabcon')).toBeTruthy()
    expect(screen.getByText(/Their publishes update this same app/)).toBeTruthy()
    expect(box('Chat').checked).toBe(true)
    expect(screen.getByText('24 messages')).toBeTruthy()
    expect(
      screen.getByText(/Never included: secret values \(OPENAI_KEY and STRIPE_KEY\)/)
    ).toBeTruthy()

    fireEvent.click(box('Chat'))
    fireEvent.click(screen.getByRole('button', { name: 'Save .zip…' }))
    expect(api.handoff.save).toHaveBeenCalledWith('p1', {
      history: true,
      deployment: true,
      chat: false
    })
    expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(
      true
    )

    api.progress(120, 254)
    expect(screen.getByText('120 of 254 files')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Hand-off progress' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true)

    const path = 'C:\\Users\\amy\\Downloads\\sales-handoff.zip'
    await api.finish({ ok: true, path, bytes: 1_468_006, files: 254 })
    expect(screen.getByText('Saved sales-handoff.zip')).toBeTruthy()
    expect(screen.getByText('1.4 MB · 254 files')).toBeTruthy()
    const next = within(screen.getByRole('region', { name: 'What happens next' }))
    expect(next.getByText(/they select/).textContent).toContain('Open a hand-off')
    expect(next.getByText(/give them Contributor access to/).textContent).toContain('fabcon')

    fireEvent.click(next.getByRole('button', { name: 'Open the workspace' }))
    expect(api.openExternal).toHaveBeenCalledWith(
      `https://app.fabric.microsoft.com/groups/${WORKSPACE_ID}/`
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    expect(api.handoff.reveal).toHaveBeenCalledWith(path)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('says what leaving out the published app means, and skips its step after saving', async () => {
    const api = installApi()
    renderModal()

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Published app' }))
    expect(
      screen.getByText('They’ll publish it as a new app, in a workspace they choose.')
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save .zip…' }))
    await api.finish({ ok: true, path: '/Users/amy/sales-handoff.zip', bytes: 10, files: 3 })
    expect(screen.queryByText(/Contributor access/)).toBeNull()
  })

  it('offers only the code for a project with no history, publish or chat, and names what stays out', async () => {
    installApi({
      files: 3,
      bytes: 900,
      chatMessages: 0,
      secrets: [],
      keptOut: ['.env', 'certs/dev.pem', 'server.key', 'api.key']
    })
    renderModal()

    await screen.findByText('3 files · 900 bytes')
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(
      screen.getByText(
        'Also left out in case they hold secrets: .env, certs/dev.pem, server.key and 1 more.'
      )
    ).toBeTruthy()
  })

  it('waits while Copilot works on the app', async () => {
    installApi()
    renderModal({ busy: 'Copilot is still working on Sales. Hand it off once the turn finishes.' })

    await screen.findByRole('checkbox', { name: 'Chat' })
    expect(screen.getByText(/Copilot is still working on Sales/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save .zip…' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('goes back to the choices when the save is cancelled, and shows why one failed', async () => {
    const api = installApi()
    renderModal()
    await screen.findByRole('checkbox', { name: 'Chat' })

    fireEvent.click(screen.getByRole('button', { name: 'Save .zip…' }))
    await api.finish({ ok: false, cancelled: true })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(box('Chat').disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Save .zip…' }))
    await api.finish({ ok: false, error: 'Couldn’t save D:\\sales-handoff.zip: the disk is full' })
    expect(screen.getByRole('alert').textContent).toContain('the disk is full')
    expect(box('Chat').checked).toBe(true)
  })

  it('stops packing on request', async () => {
    const api = installApi()
    renderModal()
    await screen.findByRole('checkbox', { name: 'Chat' })

    fireEvent.click(screen.getByRole('button', { name: 'Save .zip…' }))
    api.progress(3, 254)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(api.handoff.stop).toHaveBeenCalledWith('p1')
  })

  it('explains a project it can’t look at, and tries again', async () => {
    const api = installApi(new Error('Fabricator can’t find this project’s folder.'))
    renderModal()

    expect((await screen.findByRole('alert')).textContent).toContain(
      'can’t find this project’s folder'
    )
    expect((screen.getByRole('button', { name: 'Save .zip…' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(api.handoff.preview).toHaveBeenCalledTimes(2)
  })
})
