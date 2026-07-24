import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FabricDeployment } from '@shared/ipc'
import ConnectModelModal from './ConnectModelModal'
import { makeProject } from '../../test/harness'

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

  it('prompts to sign in when the Fabric session lapsed', async () => {
    const loginRayfin = vi.fn(() => Promise.resolve({ ok: true, exitCode: 0 }))
    const listWorkspaceModels = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, models: [], needsLogin: true })
      .mockResolvedValueOnce({ ok: true, models: [{ id: 'ds-1', name: 'Sales' }] })
    installApi({ loginRayfin, listWorkspaceModels })
    render(<ConnectModelModal project={makeProject('p1')} onClose={vi.fn()} onConnect={vi.fn()} />)

    const retry = await screen.findByRole('button', { name: /Sign in/ })
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
})
