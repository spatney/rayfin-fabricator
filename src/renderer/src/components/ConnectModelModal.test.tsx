import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FabricDeployment, ProcResult } from '@shared/ipc'
import ConnectModelModal from './ConnectModelModal'
import { makeProject } from '../../test/harness'
import { deferred } from '../../test/deferred'
import { ToastProvider } from '../toast'

interface Over {
  list?: ReturnType<typeof vi.fn>
  projectSemanticModels?: ReturnType<typeof vi.fn>
  listWorkspaceModels?: ReturnType<typeof vi.fn>
  loginRayfin?: ReturnType<typeof vi.fn>
}

const deployed: FabricDeployment[] = [
  { workspaceName: 'App WS', active: true, workspaceId: 'ws-app', itemId: 'app-item' }
]

function installApi(over: Over = {}): void {
  const api = {
    list: over.list ?? vi.fn(() => Promise.resolve(deployed)),
    projectSemanticModels: over.projectSemanticModels ?? vi.fn(() => Promise.resolve([])),
    listWorkspaceModels:
      over.listWorkspaceModels ??
      vi.fn(() => Promise.resolve({ ok: true, models: [{ id: 'ds-1', name: 'Sales' }] })),
    loginRayfin: over.loginRayfin ?? vi.fn(() => Promise.resolve({ ok: true, exitCode: 0 }))
  }
  ;(window as unknown as { api: unknown }).api = {
    deploy: { list: api.list },
    fabric: {
      projectSemanticModels: api.projectSemanticModels,
      listWorkspaceModels: api.listWorkspaceModels
    },
    auth: { loginRayfin: api.loginRayfin }
  }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('ConnectModelModal', () => {
  beforeEach(() => {
    installApi()
  })

  it('hands the agent a connect-prompt with the model + workspace ids', async () => {
    const onConnect = vi.fn()
    const onClose = vi.fn()
    render(<ConnectModelModal project={makeProject('p1')} onClose={onClose} onConnect={onConnect} />)

    expect(await screen.findByText('Sales')).toBeTruthy()
    expect(screen.getByText('App WS')).toBeTruthy()

    fireEvent.click(screen.getByRole('option', { name: /Sales/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))

    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
    const prompt = onConnect.mock.calls[0][0] as string
    expect(prompt).toContain('Sales')
    expect(prompt).toContain('ws-app')
    expect(prompt).toContain('ds-1')
    expect(onClose).toHaveBeenCalled()
  })

  it('badges an already-connected model and disables it', async () => {
    installApi({
      projectSemanticModels: vi.fn(() =>
        Promise.resolve([{ alias: 'sales', workspaceId: 'ws-app', itemId: 'ds-1' }])
      )
    })
    render(<ConnectModelModal project={makeProject('p1')} onClose={vi.fn()} onConnect={vi.fn()} />)

    expect(await screen.findByText('Connected')).toBeTruthy()
    expect((screen.getByRole('option', { name: /Sales/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers in-dialog sign-in when silent token acquisition requires interaction', async () => {
    const loginRayfin = vi.fn(() => Promise.resolve({ ok: true, exitCode: 0 }))
    const listWorkspaceModels = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false, models: [], needsLogin: true,
        error: 'Silent token acquisition failed and interactive login was not allowed'
      })
      .mockResolvedValueOnce({ ok: true, models: [{ id: 'ds-1', name: 'Sales' }] })
    installApi({ loginRayfin, listWorkspaceModels })
    render(<ConnectModelModal project={makeProject('p1')} onClose={vi.fn()} onConnect={vi.fn()} />)

    const retry = await screen.findByRole('button', { name: /Sign in/ })
    expect(screen.getByText(/preview uses a separate sign-in/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(retry)

    await waitFor(() => expect(loginRayfin).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listWorkspaceModels).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Sales')).toBeTruthy()
  })

  it('tells the user to deploy first when there is no workspace', async () => {
    installApi({ list: vi.fn(() => Promise.resolve([])) })
    render(<ConnectModelModal project={makeProject('p1')} onClose={vi.fn()} onConnect={vi.fn()} />)
    expect(await screen.findByText(/Deploy this app to a Fabric workspace first/)).toBeTruthy()
  })

  it.each(['deployment', 'models'])('makes a rejected %s check retryable instead of spinning forever', async (check) => {
    installApi({
      ...(check === 'deployment'
        ? { list: vi.fn().mockRejectedValue('Fabric lookup disconnected') }
        : { listWorkspaceModels: vi.fn().mockRejectedValue('Fabric lookup disconnected') })
    })
    render(
      <ToastProvider>
        <ConnectModelModal project={makeProject('p1')} onClose={vi.fn()} onConnect={vi.fn()} />
      </ToastProvider>
    )
    expect((await screen.findByRole('alert')).textContent).toContain('Fabric lookup disconnected')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByText('Finding your deployment…')).toBeNull()
    expect((screen.getByRole('button', { name: 'Add to chat' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it.each(['failed login', 'rejected login', 'rejected verification'])(
    'does not reload models after %s',
    async (failure) => {
      const listWorkspaceModels = vi.fn().mockResolvedValue({ ok: false, models: [], needsLogin: true })
      const loginRayfin = vi.fn().mockResolvedValue({ ok: true, exitCode: 0 })
      const onSignedIn = vi.fn().mockResolvedValue(undefined)
      if (failure === 'failed login') {
        loginRayfin.mockResolvedValueOnce({ ok: false, exitCode: 1, error: 'Sign-in rejected' })
      } else if (failure === 'rejected login') {
        loginRayfin.mockRejectedValueOnce('Sign-in rejected')
      } else {
        onSignedIn.mockRejectedValueOnce(new Error('Sign-in rejected'))
      }
      installApi({ listWorkspaceModels, loginRayfin })
      render(
        <ToastProvider>
          <ConnectModelModal
            project={makeProject('p1')}
            onClose={vi.fn()}
            onConnect={vi.fn()}
            onSignedIn={onSignedIn}
          />
        </ToastProvider>
      )
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in & retry' }))

      expect((await screen.findByRole('alert')).textContent).toContain('Sign-in rejected')
      expect(listWorkspaceModels).toHaveBeenCalledTimes(1)
      expect((screen.getByRole('button', { name: 'Sign in & retry' }) as HTMLButtonElement).disabled).toBe(false)
    }
  )

  it('disables duplicate sign-in attempts and ignores completion after dismissal', async () => {
    const login = deferred<ProcResult>()
    const loginRayfin = vi.fn(() => login.promise)
    const listWorkspaceModels = vi.fn().mockResolvedValue({ ok: false, models: [], needsLogin: true })
    const onSignedIn = vi.fn()
    installApi({ listWorkspaceModels, loginRayfin })
    const view = render(
      <ToastProvider>
        <ConnectModelModal
          project={makeProject('p1')}
          onClose={vi.fn()}
          onConnect={vi.fn()}
          onSignedIn={onSignedIn}
        />
      </ToastProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in & retry' }))
    const pending = screen.getByRole('button', { name: 'Signing in…' }) as HTMLButtonElement
    expect(pending.disabled).toBe(true)
    fireEvent.click(pending)
    expect(loginRayfin).toHaveBeenCalledTimes(1)
    view.unmount()
    await act(async () => login.resolve({ ok: true, exitCode: 0 }))
    expect(onSignedIn).not.toHaveBeenCalled()
    expect(listWorkspaceModels).toHaveBeenCalledTimes(1)
  })
})
