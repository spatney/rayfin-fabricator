import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FabricWorkspacesResult, ProcResult, StudioProject } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import { ToastProvider } from '../toast'
import { deferred } from '../../test/deferred'
import DeploymentsControl from './DeploymentsControl'

function makeProject(over: Partial<StudioProject> = {}): StudioProject {
  return {
    id: 'p1',
    name: 'Project',
    path: 'C:/projects/p1',
    addedAt: '2024-01-01T00:00:00.000Z',
    ...over
  }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('DeploymentsControl chip', () => {
  it('labels the chip “Deployment:” (the workspace name now lives in the footer)', () => {
    render(
      <OverlayProvider>
        <DeploymentsControl
          project={makeProject({
            workspace: 'de0fcf1a-8c94-46cf-a029-650b2e87f172',
            workspaceName: 'Rayfin Apps'
          })}
          running={false}
          onCreate={() => {}}
          onRedeploy={() => {}}
          onSwitch={() => Promise.resolve({ ok: true, outcome: 'success' })}
          onChanged={() => {}}
        />
      </OverlayProvider>
    )
    expect(screen.getByText('Deployment:')).toBeTruthy()
    expect(screen.queryByText('Workspace:')).toBeNull()
  })

  function installApi() {
    const api = {
      fabric: { listWorkspaces: vi.fn().mockResolvedValue({ ok: true, workspaces: [] }) },
      auth: { loginRayfin: vi.fn().mockResolvedValue({ ok: true, exitCode: 0 }) },
      deploy: { list: vi.fn().mockResolvedValue([]) }
    }
    ;(window as unknown as { api: unknown }).api = api
    return api
  }

  function renderControl(
    onSignedIn = vi.fn().mockResolvedValue(undefined),
    onSwitch = vi.fn().mockResolvedValue({ ok: true, outcome: 'success' })
  ): void {
    render(
      <ToastProvider>
        <OverlayProvider>
          <DeploymentsControl
            project={makeProject()}
            running={false}
            onCreate={vi.fn()}
            onRedeploy={vi.fn()}
            onSwitch={onSwitch}
            onChanged={vi.fn()}
            onSignedIn={onSignedIn}
          />
        </OverlayProvider>
      </ToastProvider>
    )
  }

  describe('DeploymentsControl authentication checks', () => {
    it('coalesces opening the create flow into one workspace request and one login', async () => {
      const api = installApi()
      const login = deferred<ProcResult>()
      api.fabric.listWorkspaces.mockResolvedValue({ ok: false, needsLogin: true })
      api.auth.loginRayfin.mockReturnValueOnce(login.promise)
      renderControl()
      fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))

      await waitFor(() => expect(api.auth.loginRayfin).toHaveBeenCalledTimes(1))
      expect(api.fabric.listWorkspaces).toHaveBeenCalledTimes(1)
      await act(async () => login.resolve({ ok: false, exitCode: 1, error: 'Login cancelled' }))
      expect(api.fabric.listWorkspaces).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: 'Sign in to Fabric' })).toBeTruthy()
    })

    it.each(['login', 'verification'])('reports rejected %s and never retries with unverified credentials', async (failure) => {
      const api = installApi()
      api.fabric.listWorkspaces.mockResolvedValueOnce({ ok: false, needsLogin: true })
      const onSignedIn = vi.fn().mockResolvedValue(undefined)
      if (failure === 'login') api.auth.loginRayfin.mockRejectedValueOnce('Auth verification failed')
      else onSignedIn.mockRejectedValueOnce(new Error('Auth verification failed'))
      renderControl(onSignedIn)
      fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))

      await screen.findAllByText('Auth verification failed')
      expect(api.fabric.listWorkspaces).toHaveBeenCalledTimes(1)
      expect((screen.getByRole('button', { name: 'Sign in to Fabric' }) as HTMLButtonElement).disabled).toBe(false)
      expect((screen.getByRole('button', { name: 'Create & deploy' }) as HTMLButtonElement).disabled).toBe(true)
    })

    it('does not launch an automatic sign-in after the popover is dismissed', async () => {
      const api = installApi()
      const workspaces = deferred<FabricWorkspacesResult>()
      api.fabric.listWorkspaces.mockReturnValueOnce(workspaces.promise)
      renderControl()
      fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
      fireEvent.click(document.body)
      await act(async () => workspaces.resolve({ ok: false, needsLogin: true }))
      expect(api.auth.loginRayfin).not.toHaveBeenCalled()
    })

    it('rechecks workspaces on reopening instead of retaining a stale successful list', async () => {
      const api = installApi()
      api.fabric.listWorkspaces
        .mockResolvedValueOnce({
          ok: true,
          workspaces: [{ id: 'ws1', displayName: 'Old workspace', eligible: true, capacityKind: 'fabric' }]
        })
        .mockResolvedValueOnce({ ok: false, needsLogin: true })
      api.auth.loginRayfin.mockResolvedValueOnce({ ok: false, exitCode: 1, error: 'Sign in again' })
      renderControl()
      fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
      await screen.findByRole('button', { name: /Old workspace/ })
      fireEvent.click(document.body)
      fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))

      await screen.findByRole('button', { name: 'Sign in to Fabric' })
      expect(api.fabric.listWorkspaces).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('button', { name: /Old workspace/ })).toBeNull()
    })

    it.each(['failed result', 'rejected IPC'])('reports a switch %s without continuing to refresh deployments', async (failure) => {
      const api = installApi()
      api.deploy.list.mockResolvedValue([{ workspaceName: 'Other', workspaceId: 'ws-other', active: false }])
      const onSwitch = vi.fn()
      if (failure === 'failed result') {
        onSwitch.mockResolvedValue({ ok: false, outcome: 'not-signed-in', error: 'Fabric sign-in required' })
      } else {
        onSwitch.mockRejectedValue('Fabric sign-in required')
      }
      renderControl(vi.fn(), onSwitch)
      fireEvent.click(screen.getByRole('button', { name: /Deployment:/ }))
      fireEvent.click(await screen.findByRole('button', { name: 'Switch' }))

      expect((await screen.findByRole('alert')).textContent).toContain('Fabric sign-in required')
      expect(api.deploy.list).toHaveBeenCalledTimes(1)
      expect((screen.getByRole('button', { name: 'Switch' }) as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('copies the active deployment URL to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(
      <OverlayProvider>
        <DeploymentsControl
          project={makeProject({
            lastDeploy: { url: 'https://sales.example.app/', status: 'success' }
          })}
          running={false}
          onCreate={() => {}}
          onRedeploy={() => {}}
          onSwitch={() => Promise.resolve({ ok: true, outcome: 'success' })}
          onChanged={() => {}}
        />
      </OverlayProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy app URL' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('https://sales.example.app/')
    )
  })
})
