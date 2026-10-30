import type { ComponentProps, JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  it('names the chip “Published app:” for screen readers and shows its state as a dot', () => {
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
    const chip = screen.getByRole('button', { name: /^Published app:\s*Rayfin Apps$/ })
    expect(chip.querySelector('.dep-dot--ok')).toBeTruthy()
    expect(screen.getByText('Published app:').classList.contains('sr-only')).toBe(true)
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
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))

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
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))

      await screen.findAllByText('Auth verification failed')
      expect(api.fabric.listWorkspaces).toHaveBeenCalledTimes(1)
      expect((screen.getByRole('button', { name: 'Sign in to Fabric' }) as HTMLButtonElement).disabled).toBe(false)
      const form = screen.getByRole('dialog', { name: 'Publish to a Fabric workspace' })
      const submit = within(form).getByRole('button', { name: 'Publish' }) as HTMLButtonElement
      expect(submit.disabled).toBe(true)
    })

    it('does not launch an automatic sign-in after the popover is dismissed', async () => {
      const api = installApi()
      const workspaces = deferred<FabricWorkspacesResult>()
      api.fabric.listWorkspaces.mockReturnValueOnce(workspaces.promise)
      renderControl()
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
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
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
      await screen.findByRole('button', { name: /Old workspace/ })
      fireEvent.click(document.body)
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))

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
      fireEvent.click(screen.getByRole('button', { name: /Published app:/ }))
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
      fireEvent.click(screen.getByRole('button', { name: /Published app:/ }))
      const account = await screen.findByText('alice@contoso.com')
      expect(account.textContent).toBe('alice@contoso.com · Contoso')
      expect(account.closest('dd')?.previousElementSibling?.textContent).toBe('Account')
      fireEvent.click(screen.getByRole('button', { name: 'Change' }))
      expect(onManageAccounts).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog', { name: 'Published apps' })).toBeNull()
    })

    it('opens its details without starting a sign-in, and offers one when signed out', async () => {
      const api = installApi()
      api.deploy.list.mockResolvedValue([{ workspaceName: 'Sales', workspaceId: 'ws1', active: true }])
      api.fabric.listWorkspaces.mockResolvedValue({ ok: false, needsLogin: true })
      const onSignIn = vi.fn()
      const props = {
        project: makeProject({ workspace: 'ws1', lastDeploy: { url: 'https://sales.example.app/', status: 'success' } }),
        running: false,
        onCreate: vi.fn(),
        onRedeploy: vi.fn(),
        onSwitch: vi.fn(),
        onChanged: vi.fn(),
        onSignIn
      }
      const { rerender } = render(
        <ToastProvider>
          <OverlayProvider>
            <DeploymentsControl {...props} account={{ user: 'alice@contoso.com' }} />
          </OverlayProvider>
        </ToastProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: /Published app:/ }))
      await screen.findByText('alice@contoso.com')
      await act(async () => {})
      expect(api.fabric.listWorkspaces).toHaveBeenCalledTimes(1)
      expect(api.auth.loginRayfin).not.toHaveBeenCalled()

      fireEvent.click(document.body)
      rerender(
        <ToastProvider>
          <OverlayProvider>
            <DeploymentsControl {...props} />
          </OverlayProvider>
        </ToastProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: /Published app:/ }))
      expect(screen.getByText('Not signed in to Fabric')).toBeTruthy()
      await act(async () => {})
      expect(api.fabric.listWorkspaces).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      expect(onSignIn).toHaveBeenCalledTimes(1)
      expect(api.auth.loginRayfin).not.toHaveBeenCalled()
    })
  })

  describe('DeploymentsControl state and action', () => {
    const deployed = makeProject({
      workspace: 'ws1',
      workspaceName: 'Sales',
      deploymentNames: { ws1: 'Production' },
      lastDeploy: { url: 'https://sales.example.app/', status: 'success' }
    })

    function control(extra: Partial<ComponentProps<typeof DeploymentsControl>> = {}): JSX.Element {
      return (
        <ToastProvider>
          <OverlayProvider>
            <DeploymentsControl
              project={deployed}
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

    it('keeps Publish quiet while everything is published, and lights it up for changes', () => {
      const onRedeploy = vi.fn()
      const { rerender } = render(control({ onRedeploy, pending: { changed: false, files: 0 } }))
      const quiet = screen.getByRole('button', { name: 'Publish' })
      expect(quiet.classList.contains('seg-btn--primary')).toBe(false)

      rerender(control({ onRedeploy, pending: { changed: true, files: 3 } }))
      const lit = screen.getByRole('button', { name: 'Publish 3 changes' })
      expect(lit.classList.contains('seg-btn--primary')).toBe(true)
      expect(lit.title).toBe('3 files changed since Production was published')
      fireEvent.click(lit)
      expect(onRedeploy).toHaveBeenCalledTimes(1)

      rerender(control({ onRedeploy, pending: { changed: true, files: 1 } }))
      expect(screen.getByRole('button', { name: 'Publish 1 change' })).toBeTruthy()
      // Without a known published version, how much would ship isn't known.
      rerender(control({ onRedeploy, pending: { changed: true } }))
      expect(screen.getByRole('button', { name: 'Publish changes' })).toBeTruthy()
    })

    it('holds every publish while Copilot is working on the app', () => {
      const onRedeploy = vi.fn()
      const held = 'Copilot is working on this app. Publishing waits until the turn finishes.'
      const { rerender } = render(control({ onRedeploy, chatBusy: true, pending: { changed: true, files: 2 } }))
      const changes = screen.getByRole('button', { name: 'Publish 2 changes' }) as HTMLButtonElement
      expect(changes.disabled).toBe(true)
      expect(changes.title).toBe(held)
      fireEvent.click(changes)

      const failed = { running: false, log: [], result: { ok: false, outcome: 'error' as const, error: 'Busy' } }
      rerender(control({ onRedeploy, chatBusy: true, deploy: failed }))
      expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(true)
      expect(onRedeploy).not.toHaveBeenCalled()

      rerender(control({ onRedeploy, chatBusy: false, deploy: failed }))
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      expect(onRedeploy).toHaveBeenCalledTimes(1)
    })

    it('says publishing failed on the chip and offers to try again and find out why', async () => {
      const api = installApi()
      api.deploy.list.mockResolvedValue([{ workspaceName: 'Sales', name: 'Production', workspaceId: 'ws1', active: true }])
      const onRedeploy = vi.fn()
      const onDiagnose = vi.fn()
      render(
        control({
          onRedeploy,
          onDiagnose,
          deploy: { running: false, log: [], result: { ok: false, outcome: 'error', error: 'Runtime settings sync failed' } }
        })
      )
      const chip = screen.getByRole('button', { name: /^Published app:\s*Production\s*· Failed$/ })
      expect(chip.querySelector('.dep-dot--err')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      expect(onRedeploy).toHaveBeenCalledTimes(1)

      fireEvent.click(chip)
      expect(await screen.findByText('Runtime settings sync failed')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Find out why' }))
      expect(onDiagnose).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog', { name: 'Published apps' })).toBeNull()
    })

    it('shows publishing in progress on the control and offers to watch it', async () => {
      const api = installApi()
      api.deploy.list.mockResolvedValue([{ workspaceName: 'Sales', name: 'Production', workspaceId: 'ws1', active: true }])
      const onWatch = vi.fn()
      const { container } = render(
        control({
          running: true,
          onWatch,
          deploy: {
            running: true,
            log: [
              'Publishing Sales to Fabric…\n',
              '[rayfin] settings: Applying runtime settings\n'
            ],
            startedAt: Date.now()
          }
        })
      )
      const progress = screen.getByRole('button', { name: /^Publishing… \d+%$/ })
      expect(progress.classList.contains('seg-btn--primary')).toBe(false)
      expect(container.querySelector('.dep-progress')).toBeTruthy()

      fireEvent.click(progress)
      expect(screen.getByText('Applying settings')).toBeTruthy()
      expect(screen.getByRole('progressbar', { name: 'Publish progress' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Watch' }))
      expect(onWatch).toHaveBeenCalledTimes(1)
    })

    it('opens the details from what it knows, then lists the other published apps', async () => {
      const api = installApi()
      const list = deferred<unknown[]>()
      api.deploy.list.mockReturnValueOnce(list.promise)
      const onShowChanges = vi.fn()
      render(control({ pending: { changed: true, files: 2 }, onShowChanges }))
      fireEvent.click(screen.getByRole('button', { name: /Published app:/ }))

      // Straight away, before the recorded published apps are read.
      const panel = screen.getByRole('dialog', { name: 'Published apps' })
      expect(panel.querySelector('.dep-title')?.textContent).toBe('Production')
      expect(screen.getByText('sales.example.app')).toBeTruthy()
      expect(panel.textContent).toContain('2 files changed since Production was published.')

      await act(async () =>
        list.resolve([
          { workspaceName: 'Sales', name: 'Production', workspaceId: 'ws1', active: true, deployedAt: new Date().toISOString() },
          { workspaceName: 'Sales dev', name: 'Staging', workspaceId: 'ws2', active: false }
        ])
      )
      expect(panel.textContent).toContain('Published just now')
      expect(panel.textContent).not.toContain('Live')
      expect(screen.getByText('Staging')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Switch' })).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'See what changed' }))
      expect(onShowChanges).toHaveBeenCalledTimes(1)
    })

    it('turns publishing after each chat turn on and off, and says so on the control only when it is on', () => {
      installApi()
      const onChange = vi.fn()
      const { rerender } = render(control({ autoDeploy: { on: false, onChange } }))
      // Off is the default with Local development, so the chip doesn't call it out.
      const chip = screen.getByRole('button', { name: /^Published app:\s*Production$/ })
      expect(chip.title).toContain('Publish after each chat turn is off')
      fireEvent.click(chip)
      const toggle = screen.getByRole<HTMLInputElement>('checkbox', {
        name: /Publish after each chat turn/
      })
      expect(toggle.checked).toBe(false)
      expect(screen.getByText(/until you publish them/)).toBeTruthy()
      fireEvent.click(toggle)
      expect(onChange).toHaveBeenCalledWith(true)

      rerender(control({ autoDeploy: { on: true, onChange } }))
      expect(
        screen.getByRole<HTMLInputElement>('checkbox', { name: /Publish after each chat turn/ })
          .checked
      ).toBe(true)
      const auto = screen.getByRole('button', { name: /^Published app:\s*Production\s*· Auto$/ })
      expect(auto.title).toContain('Publish after each chat turn is on')

      // A failed publish says so instead.
      rerender(
        control({
          autoDeploy: { on: true, onChange },
          deploy: { running: false, log: [], result: { ok: false, outcome: 'error', error: 'Broke' } }
        })
      )
      expect(
        screen.getByRole('button', { name: /^Published app:\s*Production\s*· Failed$/ })
      ).toBeTruthy()
    })

    it('says nothing about publishing after each turn without the switch', () => {
      render(control())
      const chip = screen.getByRole('button', { name: /^Published app:\s*Production$/ })
      expect(chip.title).not.toContain('after each chat turn')
    })

    it('calls out Manual when turns publish by default and the user turned it off', () => {
      const onChange = vi.fn()
      const { rerender } = render(control({ autoDeploy: { on: true, defaultOn: true, onChange } }))
      // Without Local development, publishing after each turn is the default: unsaid.
      expect(screen.getByRole('button', { name: /^Published app:\s*Production$/ })).toBeTruthy()

      rerender(control({ autoDeploy: { on: false, defaultOn: true, onChange } }))
      const manual = screen.getByRole('button', {
        name: /^Published app:\s*Production\s*· Manual$/
      })
      expect(manual.title).toContain('Publish after each chat turn is off')
    })

    it('has no Share until there is something to share', () => {
      render(control({ project: makeProject() }))
      expect(
        screen.getByRole('button', { name: 'Publish' }).classList.contains('seg-btn--primary')
      ).toBe(true)
      expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
    })

    it('names publishing to a new workspace for it, not for the active one', async () => {
      const api = installApi()
      api.deploy.list.mockResolvedValue([{ workspaceName: 'Sales', name: 'Production', workspaceId: 'ws1', active: true }])
      render(
        control({
          running: true,
          deployingTo: 'Staging',
          deploy: { running: true, log: [], startedAt: Date.now(), workspace: 'ws2' }
        })
      )
      expect(screen.getByRole('button', { name: /^Published app:\s*Staging$/ })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: /Published app:/ }))
      const panel = screen.getByRole('dialog', { name: 'Published apps' })
      await act(async () => {})
      expect(panel.querySelector('.dep-title')?.textContent).toBe('Staging')
      // Production's address and workspace aren't the new published app's.
      expect(screen.queryByText('sales.example.app')).toBeNull()
      expect(within(panel).queryByText('Workspace')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Rename this published app' })).toBeNull()
    })

    it('reads the published apps again when publishing changes which one is active', async () => {
      const api = installApi()
      api.deploy.list.mockResolvedValue([{ workspaceName: 'Sales', name: 'Production', workspaceId: 'ws1', active: true }])
      const { rerender } = render(control())
      fireEvent.click(screen.getByRole('button', { name: /Published app:/ }))
      await act(async () => {})
      expect(api.deploy.list).toHaveBeenCalledTimes(1)
      fireEvent.click(document.body)

      api.deploy.list.mockResolvedValue([
        { workspaceName: 'Sales', name: 'Production', workspaceId: 'ws1', active: false },
        { workspaceName: 'Sales dev', name: 'Staging', workspaceId: 'ws2', active: true }
      ])
      const moved = { ...deployed, workspace: 'ws2', lastDeploy: { url: 'https://staging.example.app/', status: 'success' } }
      await act(async () => {
        rerender(control({ project: moved }))
      })
      expect(api.deploy.list).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('button', { name: /^Published app:\s*Staging$/ })).toBeTruthy()
    })
  })

  describe('DeploymentsControl publishing to a workspace', () => {
    it('leaves only the new-workspace form on Escape, not the panel', async () => {
      const api = installApi()
      ;(api.fabric as Record<string, unknown>).listCapacities = vi.fn().mockResolvedValue({ ok: true, capacities: [] })
      renderControl()
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
      const add = await screen.findByRole('button', { name: '+ New workspace' })
      await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(add)
      const input = await screen.findByPlaceholderText('New workspace name')
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByPlaceholderText('New workspace name')).toBeNull()
      expect(screen.getByRole('dialog', { name: 'Publish to a Fabric workspace' })).toBeTruthy()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: 'Publish to a Fabric workspace' })).toBeNull()
    })

    it.each([
      ['an app that was never published', makeProject(), 'Publish to a Fabric workspace'],
      [
        'a published app',
        makeProject({
          workspace: 'ws1',
          lastDeploy: { url: 'https://sales.example.app/', status: 'success' }
        }),
        'Publish to another workspace'
      ]
    ])('offers %s a workspace to publish to', async (_, project, title) => {
      const api = installApi()
      if (project.workspace) {
        api.deploy.list.mockResolvedValue([
          { workspaceName: 'Sales', name: 'Production', workspaceId: 'ws1', active: true }
        ])
      }
      render(
        <ToastProvider>
          <OverlayProvider>
            <DeploymentsControl
              project={project}
              running={false}
              onCreate={vi.fn()}
              onRedeploy={vi.fn()}
              onSwitch={vi.fn()}
              onChanged={vi.fn()}
            />
          </OverlayProvider>
        </ToastProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: /Published app:/ }))
      fireEvent.click(screen.getByRole('button', { name: `${title}…` }))
      expect(screen.getByRole('dialog', { name: title })).toBeTruthy()
      await act(async () => {})
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
