import type { ComponentProps } from 'react'
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
  it('names the chip “Deployment:” for screen readers and marks it with a cloud (the workspace name lives in the footer)', () => {
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
    const chip = screen.getByRole('button', { name: /^Deployment:\s*Rayfin Apps$/ })
    expect(chip.querySelector('.codicon-cloud')).toBeTruthy()
    expect(screen.getByText('Deployment:').classList.contains('sr-only')).toBe(true)
    expect(screen.queryByText('Workspace:')).toBeNull()
  })

  function installApi() {
    const api = {
      fabric: {
        listWorkspaces: vi.fn().mockResolvedValue({ ok: true, workspaces: [] }),
        projectSemanticModels: vi.fn().mockResolvedValue([])
      },
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

  it('offers no separate copy-link control', () => {
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
    expect(screen.queryByRole('button', { name: 'Copy app URL' })).toBeNull()
  })

  describe('DeploymentsControl deploy identity', () => {
    it('says which Fabric account deploys, with a way to change it', async () => {
      const api = installApi()
      api.deploy.list.mockResolvedValue([{ workspaceName: 'Sales', workspaceId: 'ws1', active: true }])
      const onManageAccounts = vi.fn()
      render(
        <ToastProvider>
          <OverlayProvider>
            <DeploymentsControl
              project={makeProject()}
              running={false}
              onCreate={vi.fn()}
              onRedeploy={vi.fn()}
              onSwitch={vi.fn()}
              onChanged={vi.fn()}
              account={{ user: 'alice@contoso.com', tenant: 'Contoso' }}
              onManageAccounts={onManageAccounts}
            />
          </OverlayProvider>
        </ToastProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: /Deployment:/ }))
      const line = await screen.findByText('alice@contoso.com')
      expect(line.closest('.dep-account')?.textContent).toBe('Deploys as alice@contoso.com · ContosoChange')
      fireEvent.click(screen.getByRole('button', { name: 'Change' }))
      expect(onManageAccounts).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog', { name: 'Deployments' })).toBeNull()
    })
  })

  describe('DeploymentsControl share', () => {
    function control(extra: Partial<ComponentProps<typeof DeploymentsControl>> = {}): JSX.Element {
      return (
        <ToastProvider>
          <OverlayProvider>
            <DeploymentsControl
              project={makeProject({
                workspace: 'ws1',
                lastDeploy: { url: 'https://sales.example.app/', status: 'success' }
              })}
              running={false}
              onCreate={vi.fn()}
              onRedeploy={vi.fn()}
              onSwitch={vi.fn()}
              onChanged={vi.fn()}
              {...extra}
            />
          </OverlayProvider>
        </ToastProvider>
      )
    }

    function renderDeployed(): HTMLElement {
      return render(control()).container
    }

    const live = [{ workspaceName: 'Sales', name: 'Production', workspaceId: 'ws1', active: true }]

    it('opens the dialog for Help once, and reports the request handled', async () => {
      const api = installApi()
      api.deploy.list.mockResolvedValue(live)
      const onShareRequestHandled = vi.fn()
      // Made before the control was on screen, as when Help is opened over Home.
      const { rerender } = render(
        control({ shareRequest: { projectId: 'p1', nonce: 7 }, onShareRequestHandled })
      )

      expect(await screen.findByRole('dialog')).toBeTruthy()
      expect(onShareRequestHandled).toHaveBeenCalledWith(7)

      // The same request again (the parent re-rendered before dropping it).
      rerender(control({ shareRequest: { projectId: 'p1', nonce: 7 }, onShareRequestHandled }))
      await act(async () => {})
      expect(onShareRequestHandled).toHaveBeenCalledTimes(1)
      expect(api.deploy.list).toHaveBeenCalledTimes(1)
      expect(screen.getAllByRole('dialog')).toHaveLength(1)
    })

    it('ignores a request for another project', async () => {
      const api = installApi()
      api.deploy.list.mockResolvedValue(live)
      const onShareRequestHandled = vi.fn()
      render(control({ shareRequest: { projectId: 'p2', nonce: 3 }, onShareRequestHandled }))
      await act(async () => {})

      expect(screen.queryByRole('dialog')).toBeNull()
      expect(api.deploy.list).not.toHaveBeenCalled()
      expect(onShareRequestHandled).not.toHaveBeenCalled()
    })

    it('shows progress while the deployment loads and opens the dialog once', async () => {
      const api = installApi()
      const list = deferred<unknown[]>()
      api.deploy.list.mockReturnValueOnce(list.promise)
      const container = renderDeployed()
      const share = screen.getByRole('button', { name: 'Share' })

      fireEvent.click(share)
      expect(share.getAttribute('aria-busy')).toBe('true')
      expect(share.querySelector('.codicon-loading')).toBeTruthy()
      fireEvent.click(share)
      expect(api.deploy.list).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog')).toBeNull()

      await act(async () =>
        list.resolve([
          { workspaceName: 'Sales', name: 'Production', workspaceId: 'ws1', active: true }
        ])
      )
      const dialogs = screen.getAllByRole('dialog')
      expect(dialogs).toHaveLength(1)
      // Rendered at the document root, outside the app bar.
      expect(container.contains(dialogs[0])).toBe(false)
      expect(share.getAttribute('aria-busy')).toBeNull()
      expect(share.querySelector('.codicon-loading')).toBeNull()
    })

    it('clears the progress when loading the deployment fails', async () => {
      const api = installApi()
      api.deploy.list.mockRejectedValueOnce(new Error('Fabric sign-in required'))
      renderDeployed()
      const share = screen.getByRole('button', { name: 'Share' })

      fireEvent.click(share)
      expect((await screen.findByRole('alert')).textContent).toContain('Fabric sign-in required')
      expect(share.getAttribute('aria-busy')).toBeNull()
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })
})
