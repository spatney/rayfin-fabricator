import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  AuthStatus,
  ChatTurnResult,
  DeployResult,
  ProcLogEvent,
  ProcResult,
  StudioProject
} from '@shared/ipc'
import { ToastProvider } from '../toast'
import { OverlayProvider } from '../overlay'
import { deferred } from '../../test/deferred'
import type { DeployUiState } from '../components/PreviewPane'
import type ChatPanel from '../components/ChatPanel'
import Workbench from './Workbench'

const chatProps = vi.hoisted(() => vi.fn<(props: ComponentProps<typeof ChatPanel>) => void>())
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: vi.fn().mockResolvedValue(undefined) })
}))
vi.mock('../chatEventStore', () => ({ useChatEventStore: () => {} }))
vi.mock('../components/HomeView', () => ({ default: () => <div data-testid="home">Home</div> }))
vi.mock('../components/ModelTab', () => ({ default: () => null }))
vi.mock('../components/AdvisorView', () => ({
  default: () => null,
  categoryMeta: () => ({ title: 'Finding' })
}))
vi.mock('../components/GitControl', () => ({ default: () => null }))
vi.mock('../components/WorkspaceStatus', () => ({ default: () => null }))
vi.mock('../components/RayfinVersionControl', () => ({ default: () => null }))
vi.mock('../components/ProjectDependencyGuard', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('../components/DeploymentsControl', () => ({
  default: ({
    running,
    onRedeploy,
    onSwitch
  }: {
    running: boolean
    onRedeploy: () => void
    onSwitch: (workspace: string, byId: boolean) => Promise<DeployResult>
  }) => (
    <>
      <button disabled={running} onClick={onRedeploy}>Test deploy</button>
      <button onClick={() => void onSwitch('ws-other', true)}>Test switch</button>
    </>
  )
}))
vi.mock('../components/PreviewPane', () => ({
  default: ({ deploy }: { deploy?: DeployUiState }) => (
    <>
      <div data-testid="deploy-state">
        {deploy?.running ? 'running' : (deploy?.result?.error ?? 'idle')}
      </div>
      <output data-testid="deploy-log">{deploy?.log.join('')}</output>
    </>
  )
}))
vi.mock('../components/ChatPanel', () => ({
  default: (props: ComponentProps<typeof ChatPanel>) => {
    chatProps(props)
    return (
      <textarea
        aria-label="Chat draft"
        value={props.draft}
        onChange={(event) => props.onDraftChange?.(event.target.value)}
      />
    )
  }
}))

const auth: AuthStatus = {
  copilot: { signedIn: true, user: 'octocat' },
  rayfin: { signedIn: true, user: 'dev@example.com' },
  az: { signedIn: true }
}
const project: StudioProject = {
  id: 'p1',
  name: 'Project One',
  path: 'C:\\projects\\p1',
  addedAt: '2026-09-12T00:00:00Z',
  lastDeploy: { url: 'https://project.example.com', status: 'success' }
}

function installApi(active = false) {
  const state = {
    workspaceRoot: 'C:\\projects',
    activeProjectId: active ? project.id : null,
    projects: active ? [project] : []
  }
  const api = {
    auth: {
      loginRayfin: vi.fn().mockResolvedValue({ ok: true, exitCode: 0 }),
      refreshRayfin: vi.fn().mockResolvedValue({ ok: true, exitCode: 0 }),
      logoutRayfin: vi.fn().mockResolvedValue({ ok: true, exitCode: 0 })
    },
    projects: {
      state: vi.fn().mockResolvedValue(state),
      git: { divergence: vi.fn().mockResolvedValue({ behind: 0 }) }
    },
    deploy: {
      reconcile: vi.fn().mockResolvedValue(state),
      hasChanges: vi.fn().mockResolvedValue(false),
      run: vi.fn().mockResolvedValue({ ok: true, outcome: 'success' }),
      switch: vi.fn().mockResolvedValue({ ok: true, outcome: 'success' })
    },
    chat: {
      history: vi.fn().mockResolvedValue([]),
      saveHistory: vi.fn().mockResolvedValue(undefined)
    },
    rayfin: { versions: vi.fn().mockResolvedValue(null) },
    preview: { onAgentPreview: vi.fn(() => () => {}) },
    getVersions: vi.fn().mockResolvedValue(null),
    onProcLog: vi.fn<(callback: (event: ProcLogEvent) => void) => () => void>(() => () => {})
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

function makeProps(overrides: Partial<ComponentProps<typeof Workbench>> = {}) {
  return {
    auth,
    onSignOut: vi.fn().mockResolvedValue(undefined),
    onAuthChanged: vi.fn().mockResolvedValue(undefined),
    settings: null,
    onSettingsChange: vi.fn(),
    ...overrides
  }
}

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ToastProvider>
      <OverlayProvider>{children}</OverlayProvider>
    </ToastProvider>
  )
}

function completeTurn(
  result: ChatTurnResult = { ok: true, filesModified: [], ranDeploy: false }
): void {
  const callback = chatProps.mock.lastCall?.[0].onTurnComplete
  if (!callback) throw new Error('Chat completion handler is not mounted')
  callback(result)
}

beforeEach(() => {
  chatProps.mockClear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('Workbench authentication recovery', () => {
  it('requires confirmation before clearing shared Fabric credentials', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Fabric authentication' }))
    expect(screen.getByRole('dialog').textContent).toContain('shared across projects')
    expect(api.auth.refreshRayfin).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.auth.refreshRayfin).not.toHaveBeenCalled()
  })

  it('refreshes the selected session without leaving the workbench or replaying deployment', async () => {
    const api = installApi(true)
    const refreshed = deferred<ProcResult>()
    api.auth.refreshRayfin.mockReturnValueOnce(refreshed.promise)
    const props = makeProps({ auth: { ...auth, rayfin: { ...auth.rayfin, tenant: 'tenant-one' } } })
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    const draft = (await screen.findByLabelText('Chat draft')) as HTMLTextAreaElement
    fireEvent.change(draft, { target: { value: 'Keep this draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Fabric authentication' }))
    view.rerender(<Workbench {...props} auth={{ ...auth, rayfin: { ...auth.rayfin, tenant: 'tenant-two' } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear credentials and sign in' }))
    expect(api.auth.refreshRayfin).toHaveBeenCalledWith(project.id, 'tenant-one')
    expect((screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement).disabled).toBe(true)

    const log = 'Removed a stale token-cache lock left by an interrupted sign-in\n'
    act(() => api.onProcLog.mock.calls[0][0]({ channel: 'refresh:rayfin', stream: 'stderr', data: log }))
    expect(screen.getByLabelText('Authentication refresh log').textContent).toBe(log)
    fireEvent.click(screen.getByRole('button', { name: 'Test deploy' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Deployment paused'))
    expect(api.deploy.run).not.toHaveBeenCalled()
    await act(async () => refreshed.resolve({ ok: true, exitCode: 0 }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByLabelText('Chat draft')).toBe(draft)
    expect(draft.value).toBe('Keep this draft')
    expect(screen.getByTestId('deploy-log').textContent).toContain(log)
    expect(props.onSignOut).not.toHaveBeenCalled()
    expect(api.auth.logoutRayfin).not.toHaveBeenCalled()
    expect(api.deploy.run).not.toHaveBeenCalled()
  })

  it.each(['failed result', 'rejected IPC', 'verification'])(
    'keeps refresh failures visible and allows retry after %s',
    async (failure) => {
      const api = installApi(true)
      const props = makeProps()
      render(<Workbench {...props} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')
      await act(async () => {})
      if (failure === 'failed result') {
        api.auth.refreshRayfin.mockResolvedValueOnce({ ok: false, exitCode: 1, error: 'Credential refresh failed' })
      } else if (failure === 'rejected IPC') {
        api.auth.refreshRayfin.mockRejectedValueOnce('Credential refresh failed')
      } else {
        vi.mocked(props.onAuthChanged).mockRejectedValueOnce('Credential refresh failed')
      }
      fireEvent.click(screen.getByRole('button', { name: 'Refresh Fabric authentication' }))
      fireEvent.click(screen.getByRole('button', { name: 'Clear credentials and sign in' }))

      expect((await screen.findByRole('alert')).textContent).toContain('Credential refresh failed')
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'Clear credentials and sign in' }) as HTMLButtonElement).disabled).toBe(false)
      )
      expect(api.deploy.run).not.toHaveBeenCalled()
      expect(props.onSignOut).not.toHaveBeenCalled()
    }
  )

  it('does not replay queued deployments or automatically clear a token-cache failure', async () => {
    const api = installApi(true)
    const deploying = deferred<DeployResult>()
    api.deploy.hasChanges.mockResolvedValue(true)
    api.deploy.run.mockReturnValueOnce(deploying.promise)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    await act(async () => completeTurn())
    await act(async () => completeTurn())
    await act(async () => deploying.resolve({
      ok: false,
      outcome: 'auth-cache-error',
      error: 'Could not acquire the token-cache lock'
    }))
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
    expect(api.auth.loginRayfin).not.toHaveBeenCalled()
    expect(api.auth.refreshRayfin).not.toHaveBeenCalled()
    expect(api.auth.logoutRayfin).not.toHaveBeenCalled()
  })

  it('still retries a normal expired session once using the deploying project CLI', async () => {
    const api = installApi(true)
    api.deploy.run.mockResolvedValueOnce({ ok: false, outcome: 'not-signed-in' })
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    fireEvent.click(await screen.findByRole('button', { name: 'Test deploy' }))
    await waitFor(() => expect(api.deploy.run).toHaveBeenCalledTimes(2))
    expect(api.auth.loginRayfin).toHaveBeenCalledTimes(1)
    expect(api.auth.loginRayfin).toHaveBeenCalledWith(undefined, project.id)
    expect(api.auth.refreshRayfin).not.toHaveBeenCalled()
    expect(api.auth.logoutRayfin).not.toHaveBeenCalled()
  })

  it('clears a previous deploy failure after switching to another deployment', async () => {
    const api = installApi(true)
    api.deploy.run.mockResolvedValueOnce({ ok: false, outcome: 'error', error: 'Upload failed' })
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    fireEvent.click(await screen.findByRole('button', { name: 'Test deploy' }))
    await waitFor(() => expect(screen.getByTestId('deploy-state').textContent).toBe('Upload failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Test switch' }))
    await waitFor(() => expect(screen.getByTestId('deploy-state').textContent).toBe('idle'))
  })

  it('does not recheck or redeploy after leaving during a credential refresh', async () => {
    const api = installApi(true)
    const refreshed = deferred<ProcResult>()
    api.auth.refreshRayfin.mockReturnValueOnce(refreshed.promise)
    const props = makeProps()
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Fabric authentication' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear credentials and sign in' }))
    vi.mocked(props.onAuthChanged).mockClear()
    view.unmount()
    await act(async () => refreshed.resolve({ ok: true, exitCode: 0 }))
    expect(props.onAuthChanged).not.toHaveBeenCalled()
    expect(api.deploy.run).not.toHaveBeenCalled()
  })

  it.each(['failed result', 'rejected IPC'])(
    'keeps the workbench open after logout %s',
    async (failure) => {
      const api = installApi()
      if (failure === 'failed result') {
        api.auth.logoutRayfin.mockResolvedValueOnce({
          ok: false,
          exitCode: 1,
          error: 'Logout failed'
        })
      } else {
        api.auth.logoutRayfin.mockRejectedValueOnce('Logout failed')
      }
      const props = makeProps()
      render(<Workbench {...props} />, { wrapper: Wrapper })
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

      expect((await screen.findByRole('alert')).textContent).toContain('Logout failed')
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement).disabled
        ).toBe(false)
      )
      expect(props.onSignOut).not.toHaveBeenCalled()
      expect(props.onAuthChanged).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('home')).toBeTruthy()
    }
  )

  it('keeps the sign-out overlay until the verified screen refresh completes', async () => {
    installApi()
    const refreshed = deferred<void>()
    const props = makeProps({ onSignOut: vi.fn(() => refreshed.promise) })
    render(<Workbench {...props} />, { wrapper: Wrapper })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(props.onSignOut).toHaveBeenCalledTimes(1))
    expect(
      (screen.getByRole('button', { name: 'Signing out…' }) as HTMLButtonElement).disabled
    ).toBe(true)
    await act(async () => refreshed.resolve(undefined))
    expect((screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it.each(['login', 'verification'])(
    'reports rejected Fabric %s without leaving buttons busy',
    async (failure) => {
      const api = installApi()
      const onAuthChanged = vi.fn().mockResolvedValue(undefined)
      if (failure === 'login')
        api.auth.loginRayfin.mockRejectedValueOnce('Sign-in service unavailable')
      else onAuthChanged.mockRejectedValueOnce('Sign-in service unavailable')
      const props = makeProps({ auth: { ...auth, rayfin: { signedIn: false } }, onAuthChanged })
      render(<Workbench {...props} />, { wrapper: Wrapper })
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Fabric' }))

      expect((await screen.findByRole('alert')).textContent).toContain(
        'Sign-in service unavailable'
      )
      expect(
        (screen.getByRole('button', { name: 'Sign in to Fabric' }) as HTMLButtonElement).disabled
      ).toBe(false)
      expect(props.onSignOut).not.toHaveBeenCalled()
    }
  )

  it('does not allow sign-out to race a pending sign-in when auth props change', async () => {
    const api = installApi()
    const login = deferred<ProcResult>()
    api.auth.loginRayfin.mockReturnValueOnce(login.promise)
    const props = makeProps({ auth: { ...auth, rayfin: { signedIn: false } } })
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Fabric' }))
    view.rerender(<Workbench {...props} auth={auth} />)
    const signOut = screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement
    expect(signOut.disabled).toBe(true)
    fireEvent.click(signOut)
    expect(api.auth.logoutRayfin).not.toHaveBeenCalled()
    await act(async () => login.resolve({ ok: true, exitCode: 0 }))
  })

  it('passes live Copilot auth to chat without losing its draft on a failed check', async () => {
    installApi(true)
    const props = makeProps()
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    const input = (await screen.findByLabelText('Chat draft')) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Do not lose this draft' } })
    const failed = { ...auth, copilot: { signedIn: false, error: 'Session expired' } }
    view.rerender(<Workbench {...props} auth={failed} />)

    expect(screen.getByLabelText('Chat draft')).toBe(input)
    expect(input.value).toBe('Do not lose this draft')
    const passed = chatProps.mock.lastCall?.[0]
    expect(passed?.copilotAuth).toBe(failed.copilot)
    expect(passed?.onCopilotAuthChanged).toBe(props.onAuthChanged)
  })

  it.each(['failed login', 'rejected login', 'rejected verification'])(
    'does not retry a deployment after %s and settles its running state',
    async (failure) => {
      const api = installApi(true)
      const props = makeProps()
      render(<Workbench {...props} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')
      await act(async () => {})
      api.deploy.run.mockResolvedValueOnce({ ok: false, outcome: 'not-signed-in' })
      if (failure === 'failed login') {
        api.auth.loginRayfin.mockResolvedValueOnce({
          ok: false,
          exitCode: 1,
          error: 'Authentication denied'
        })
      } else if (failure === 'rejected login') {
        api.auth.loginRayfin.mockRejectedValueOnce('Authentication denied')
      } else {
        vi.mocked(props.onAuthChanged).mockRejectedValueOnce(new Error('Authentication denied'))
      }

      fireEvent.click(screen.getByRole('button', { name: 'Test deploy' }))

      await waitFor(() =>
        expect(screen.getByTestId('deploy-state').textContent).toBe('Authentication denied')
      )
      expect(api.deploy.run).toHaveBeenCalledTimes(1)
      expect(api.auth.loginRayfin).toHaveBeenCalledTimes(1)
      expect(props.onSignOut).not.toHaveBeenCalled()
      expect(
        (screen.getByRole('button', { name: 'Test deploy' }) as HTMLButtonElement).disabled
      ).toBe(false)
    }
  )

  it('does not retry deployment after leaving the workbench during sign-in', async () => {
    const api = installApi(true)
    const login = deferred<ProcResult>()
    const props = makeProps()
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    api.deploy.run.mockResolvedValueOnce({ ok: false, outcome: 'not-signed-in' })
    api.auth.loginRayfin.mockReturnValueOnce(login.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Test deploy' }))
    await waitFor(() => expect(api.auth.loginRayfin).toHaveBeenCalledTimes(1))
    vi.mocked(props.onAuthChanged).mockClear()
    view.unmount()
    await act(async () => login.resolve({ ok: true, exitCode: 0 }))

    expect(api.deploy.run).toHaveBeenCalledTimes(1)
    expect(props.onAuthChanged).not.toHaveBeenCalled()
  })

  it('refreshes auth instead of treating an unauthenticated deployment switch as successful', async () => {
    const api = installApi(true)
    api.deploy.switch.mockResolvedValueOnce({ ok: false, outcome: 'not-signed-in' })
    const props = makeProps()
    render(<Workbench {...props} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    await act(async () => {})
    vi.mocked(props.onAuthChanged).mockClear()
    api.projects.state.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Test switch' }))

    await waitFor(() => expect(props.onAuthChanged).toHaveBeenCalledTimes(1))
    expect(api.projects.state).not.toHaveBeenCalled()
    expect(props.onSignOut).not.toHaveBeenCalled()
  })
})

describe('Workbench after-turn deployment', () => {
  it('redeploys undeployed changes even without file-edit events from the agent', async () => {
    const api = installApi(true)
    api.deploy.hasChanges.mockResolvedValue(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())

    expect(api.deploy.hasChanges).toHaveBeenCalledWith(project.id)
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
    expect(api.deploy.run).toHaveBeenCalledWith(project.id, undefined)
    expect(api.projects.git.divergence).not.toHaveBeenCalled()
  })

  it('does not redeploy when the deployed content is unchanged', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())

    expect(api.deploy.hasChanges).toHaveBeenCalledWith(project.id)
    expect(api.deploy.run).not.toHaveBeenCalled()
  })

  it.each([undefined, 'Coding failed'])(
    'does not auto-deploy an unsuccessful turn (%s)',
    async (error) => {
      const api = installApi(true)
      api.deploy.hasChanges.mockResolvedValue(true)
      render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')

      await act(async () =>
        completeTurn({ ok: false, error, filesModified: ['app.ts'], ranDeploy: false })
      )

      expect(api.deploy.hasChanges).not.toHaveBeenCalled()
      expect(api.deploy.run).not.toHaveBeenCalled()
    }
  )

  it.each(['project refresh', 'history save', 'version check'])(
    'still redeploys and reports a failed %s',
    async (failure) => {
      const api = installApi(true)
      api.deploy.hasChanges.mockResolvedValue(true)
      render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')
      await act(async () => {})
      const operation =
        failure === 'project refresh'
          ? api.projects.state
          : failure === 'history save'
            ? api.chat.saveHistory
            : api.rayfin.versions
      operation.mockRejectedValueOnce(new Error(`${failure} unavailable`))

      await act(async () => completeTurn())

      expect(api.deploy.run).toHaveBeenCalledTimes(1)
      expect(api.deploy.run).toHaveBeenCalledWith(project.id, undefined)
      expect(screen.getByRole('alert').textContent).toContain(`${failure} unavailable`)
    }
  )

  it.each(['Git unavailable', new Error('Git unavailable')])(
    'surfaces a failed change check (%s) instead of silently skipping deployment',
    async (error) => {
      const api = installApi(true)
      api.deploy.hasChanges.mockRejectedValueOnce(error)
      render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')

      await act(async () => completeTurn())

      expect(screen.getByRole('alert').textContent).toContain('Auto-deploy check failed')
      expect(screen.getByRole('alert').textContent).toContain('Git unavailable')
      expect(screen.getByRole('alert').textContent).toContain('Use Redeploy')
      expect(api.deploy.run).not.toHaveBeenCalled()
    }
  )

  it('queues a new deployment when another turn finishes during deployment', async () => {
    const api = installApi(true)
    const deploying = deferred<DeployResult>()
    api.deploy.hasChanges.mockResolvedValue(true)
    api.deploy.run.mockReturnValueOnce(deploying.promise)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())
    await act(async () => completeTurn())
    expect(api.deploy.run).toHaveBeenCalledTimes(1)

    await act(async () => deploying.resolve({ ok: true, outcome: 'success' }))

    expect(api.deploy.run).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('deploy-state').textContent).toBe('idle')
  })

  it('does not start an auto-deploy after the workbench is unmounted', async () => {
    const api = installApi(true)
    const changed = deferred<boolean>()
    api.deploy.hasChanges.mockReturnValueOnce(changed.promise)
    const view = render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())
    expect(api.deploy.hasChanges).toHaveBeenCalledWith(project.id)
    view.unmount()
    await act(async () => changed.resolve(true))

    expect(api.deploy.run).not.toHaveBeenCalled()
  })
})
