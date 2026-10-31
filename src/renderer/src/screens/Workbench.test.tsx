import type { ComponentProps, ReactNode, JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import type {
  AdvisorFinding,
  AppSettings,
  AuthStatus,
  ChatToolCall,
  ChatTurnResult,
  DeployResult,
  DevServerResult,
  LocalReady,
  LocalStatus,
  PortConflict,
  ProcLogEvent,
  ProcResult,
  RayfinStudioApi,
  SavedTurn,
  StudioProject
} from '@shared/ipc'
import { ToastProvider } from '../toast'
import { OverlayProvider } from '../overlay'
import { deferred } from '../../test/deferred'
import { localBackendStore } from '../localBackend'
import { LOCAL_QUESTION } from '../components/local/problems'
import { DEPLOY_QUESTION } from '../components/help/parts'
import type PreviewPane from '../components/PreviewPane'
import type ChatPanel from '../components/ChatPanel'
import type AdvisorView from '../components/advisor/AdvisorView'
import type DeploymentsControl from '../components/DeploymentsControl'
import type MigrateReportScreen from '../components/migrate/MigrateReportScreen'
import type { HelpView } from '../components/help/HelpView'
import type Spotlight from '../components/spotlight/Spotlight'
import type { AdvisorFixLinks } from '../components/advisor/AdvisorFixSummary'
import type { DerivedAdvisor } from '../advisor/lifecycle'
import Workbench from './Workbench'

const chatProps = vi.hoisted(() => vi.fn<(props: ComponentProps<typeof ChatPanel>) => void>())
const previewProps = vi.hoisted(() => vi.fn<(props: ComponentProps<typeof PreviewPane>) => void>())
const advisorProps = vi.hoisted(() => vi.fn<(props: ComponentProps<typeof AdvisorView>) => void>())
const deploymentsProps = vi.hoisted(() =>
  vi.fn<(props: ComponentProps<typeof DeploymentsControl>) => void>()
)
const helpProps = vi.hoisted(() => vi.fn<(props: ComponentProps<typeof HelpView>) => void>())
const searchProps = vi.hoisted(() => vi.fn<(props: ComponentProps<typeof Spotlight>) => void>())
const migrateProps = vi.hoisted(() =>
  vi.fn<(props: ComponentProps<typeof MigrateReportScreen>) => void>()
)
/** The Advisor state the mocked `useAdvisor` reports, and what the chat's fix cards see. */
const advisorMock = vi.hoisted(() => ({
  derived: { badge: null, items: [], open: [], resolved: [] } as Pick<
    DerivedAdvisor,
    'badge' | 'items' | 'open' | 'resolved'
  >,
  handOff: vi.fn(),
  links: null as AdvisorFixLinks | null
}))
/** Whether the mocked dependency guard reports the project's tools as unlocked. */
const guardState = vi.hoisted(() => ({ ready: true }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: vi.fn().mockResolvedValue(undefined) })
}))
vi.mock('../chatEventStore', () => ({ useChatEventStore: () => {} }))
vi.mock('../components/HomeView', () => ({ default: () => <div data-testid="home">Home</div> }))
vi.mock('../components/ModelTab', () => ({ default: () => null }))
vi.mock('../components/advisor/AdvisorView', () => ({
  default: (props: ComponentProps<typeof AdvisorView>) => {
    advisorProps(props)
    return null
  }
}))
vi.mock('../advisor/store', () => ({
  useAdvisor: () => ({ derived: advisorMock.derived, handOff: advisorMock.handOff })
}))
vi.mock('../components/GitControl', () => ({ default: () => null }))
vi.mock('../components/WorkspaceStatus', () => ({ default: () => null }))
vi.mock('../components/RayfinVersionControl', () => ({ default: () => null }))
vi.mock('../components/ProjectDependencyGuard', async () => {
  const { useLayoutEffect } = await import('react')
  return {
    default: function GuardMock({
      children,
      project,
      onReadyChange
    }: {
      children: ReactNode
      project: StudioProject
      onReadyChange?: (projectId: string, ready: boolean) => void
    }) {
      const ready = guardState.ready
      useLayoutEffect(() => onReadyChange?.(project.id, ready), [onReadyChange, project.id, ready])
      return ready ? <>{children}</> : <div role="status">Preparing {project.name}</div>
    }
  }
})
vi.mock('../components/DeploymentsControl', () => ({
  default: (props: ComponentProps<typeof DeploymentsControl>) => {
    deploymentsProps(props)
    const { running, onRedeploy, onSwitch } = props
    return (
      <>
        <button disabled={running} onClick={onRedeploy}>Test deploy</button>
        <button onClick={() => void onSwitch('ws-other', true)}>Test switch</button>
      </>
    )
  }
}))
vi.mock('../components/help/HelpView', () => ({
  HelpView: (props: ComponentProps<typeof HelpView>) => {
    helpProps(props)
    return <div role="dialog" aria-label="Help" />
  }
}))
vi.mock('../components/spotlight/Spotlight', () => ({
  default: (props: ComponentProps<typeof Spotlight>) => {
    searchProps(props)
    return <div role="dialog" aria-label="Search" />
  }
}))
vi.mock('../components/migrate/MigrateReportScreen', () => ({
  default: (props: ComponentProps<typeof MigrateReportScreen>) => {
    migrateProps(props)
    return <div role="dialog" aria-label="Migrate a Power BI report" />
  },
  describePick: () => ''
}))
vi.mock('../components/PreviewPane', () => ({
  default: (props: ComponentProps<typeof PreviewPane>) => {
    previewProps(props)
    const { deploy } = props
    return (
      <>
        <div data-testid="deploy-state">
          {deploy?.running ? 'running' : (deploy?.result?.error ?? 'idle')}
        </div>
        <output data-testid="deploy-log">{deploy?.log.join('')}</output>
      </>
    )
  }
}))
vi.mock('../components/ChatPanel', async () => {
  const { useContext } = await import('react')
  const { AdvisorFixContext } = await import('../components/advisor/AdvisorFixSummary')
  return {
    default: function ChatPanelMock(props: ComponentProps<typeof ChatPanel>) {
      chatProps(props)
      advisorMock.links = useContext(AdvisorFixContext)
      return (
        <textarea
          aria-label="Chat draft"
          value={props.draft}
          onChange={(event) => props.onDraftChange?.(event.target.value)}
        />
      )
    }
  }
})

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
/** Settings as they start: personal apps run on their local backend, and turns don't publish. */
const defaultSettings: AppSettings = { theme: 'system' }
/** "Publish after each chat turn", turned off or on by the user. */
const manualSettings: AppSettings = { theme: 'system', deployMode: 'manual' }
const autoSettings: AppSettings = { theme: 'system', deployMode: 'auto' }

const localReady: LocalReady = {
  appUrl: 'http://localhost:5173/',
  apiUrl: 'http://localhost:7171',
  embedUrl: null,
  portalUrl: 'http://localhost:7171/.rayfin-local/portal',
  dataDir: null,
  signInAs: { kind: 'developer' },
  sdk: { version: '1.36.2', supported: true },
  features: {
    data: { enabled: true, entities: ['Note'] },
    functions: { enabled: false, names: [] },
    storage: { enabled: false, folders: [] },
    auth: { enabled: true, fabric: true, password: false },
    connectors: []
  },
  time: '2026-10-30T03:00:00.000Z'
}
/** What a published app's backend says when this computer can't run its Rayfin version. */
const tooNew: Partial<LocalStatus> = {
  analysis: {
    ok: true,
    sdk: { version: '1.40.0', supported: false },
    entities: [],
    storageFolders: [],
    message: null,
    time: '2026-10-30T03:00:00.000Z'
  }
}

/** Each project's local backend, as the fake `window.api.local` reports it. */
let localStatuses = new Map<string, LocalStatus>()
let localRevision = 0
let emitLocalState: ((status: LocalStatus) => void) | null = null

/** The project's local backend status becomes `patch` (on a stopped default). */
function nextLocal(projectId: string, patch: Partial<LocalStatus> = {}): LocalStatus {
  localRevision += 1
  const status: LocalStatus = {
    projectId,
    state: 'stopped',
    phase: null,
    pid: null,
    version: null,
    projectRoot: null,
    signInAs: null,
    ready: null,
    analysis: null,
    schema: null,
    functions: null,
    vite: null,
    config: null,
    warnings: [],
    error: null,
    stopped: null,
    crashes: 0,
    startedAt: null,
    updatedAt: null,
    ...patch,
    revision: localRevision
  }
  localStatuses.set(projectId, status)
  return status
}

/** The local backend reports a new status (`local:state`). */
function emitLocal(patch: Partial<LocalStatus>, projectId = project.id): void {
  const status = nextLocal(projectId, patch)
  act(() => emitLocalState?.(status))
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
      setActive: vi.fn<RayfinStudioApi['projects']['setActive']>(),
      git: {
        divergence: vi.fn().mockResolvedValue({ behind: 0 }),
        saveTurn: vi.fn<RayfinStudioApi['projects']['git']['saveTurn']>().mockResolvedValue({})
      }
    },
    deploy: {
      reconcile: vi.fn().mockResolvedValue(state),
      hasChanges: vi.fn().mockResolvedValue(false),
      pending: vi.fn<RayfinStudioApi['deploy']['pending']>().mockResolvedValue({ changed: false, files: 0 }),
      run: vi.fn().mockResolvedValue({ ok: true, outcome: 'success' }),
      switch: vi.fn().mockResolvedValue({ ok: true, outcome: 'success' })
    },
    chat: {
      history: vi.fn().mockResolvedValue([]),
      saveHistory: vi.fn().mockResolvedValue(undefined)
    },
    rayfin: { versions: vi.fn().mockResolvedValue(null) },
    preview: { onAgentPreview: vi.fn(() => () => {}) },
    dev: {
      plan: vi.fn<RayfinStudioApi['dev']['plan']>().mockResolvedValue({}),
      start: vi.fn<RayfinStudioApi['dev']['start']>().mockResolvedValue({
        ok: true, outcome: 'running', url: 'http://localhost:5174'
      }),
      stop: vi.fn<RayfinStudioApi['dev']['stop']>().mockResolvedValue(undefined),
      freePort: vi.fn<RayfinStudioApi['dev']['freePort']>().mockResolvedValue(undefined),
      registerPort: vi.fn<RayfinStudioApi['dev']['registerPort']>().mockResolvedValue({
        ok: true, outcome: 'success'
      }),
      onState: vi.fn<RayfinStudioApi['dev']['onState']>(() => () => {})
    },
    local: {
      status: vi.fn<RayfinStudioApi['local']['status']>(
        async (id) => localStatuses.get(id) ?? nextLocal(id)
      ),
      start: vi.fn<RayfinStudioApi['local']['start']>(async (id) =>
        nextLocal(id, { state: 'starting', phase: 'starting' })
      ),
      restart: vi.fn<RayfinStudioApi['local']['restart']>(async (id) =>
        nextLocal(id, { state: 'starting', phase: 'starting' })
      ),
      stop: vi.fn<RayfinStudioApi['local']['stop']>(async (id) =>
        nextLocal(id, { ...localStatuses.get(id), state: 'stopped', ready: null })
      ),
      reload: vi.fn<RayfinStudioApi['local']['reload']>().mockResolvedValue({
        schema: null,
        config: null
      }),
      resetData: vi.fn<RayfinStudioApi['local']['resetData']>().mockResolvedValue(undefined),
      installPackages: vi
        .fn<RayfinStudioApi['local']['installPackages']>()
        .mockResolvedValue(undefined),
      stopExternal: vi.fn<RayfinStudioApi['local']['stopExternal']>().mockResolvedValue(undefined),
      logs: vi.fn<RayfinStudioApi['local']['logs']>().mockResolvedValue([]),
      onState: vi.fn<RayfinStudioApi['local']['onState']>((callback) => {
        emitLocalState = callback
        return () => {
          if (emitLocalState === callback) emitLocalState = null
        }
      }),
      onLog: vi.fn<RayfinStudioApi['local']['onLog']>(() => () => {}),
      reportFallback: vi
        .fn<RayfinStudioApi['local']['reportFallback']>()
        .mockResolvedValue(undefined)
    },
    getVersions: vi.fn().mockResolvedValue(null),
    github: {
      accounts: vi.fn<RayfinStudioApi['github']['accounts']>().mockResolvedValue({
        ghInstalled: true,
        accounts: []
      })
    },
    accounts: {
      fabric: vi.fn<RayfinStudioApi['accounts']['fabric']>().mockResolvedValue({
        accounts: [],
        sharedTokenStore: false
      }),
      azure: vi.fn<RayfinStudioApi['accounts']['azure']>().mockResolvedValue({
        azInstalled: true,
        accounts: []
      })
    },
    // Accounts always lists Model providers (your own API keys).
    byok: {
      status: vi.fn<RayfinStudioApi['byok']['status']>().mockResolvedValue({
        supported: true,
        store: 'Windows Credential Manager',
        providers: []
      })
    },
    onProcLog: vi.fn<(callback: (event: ProcLogEvent) => void) => () => void>(() => () => {})
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

function makeProps(overrides: Partial<ComponentProps<typeof Workbench>> = {}) {
  return {
    auth,
    onReviewSetup: vi.fn(),
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

/** Start a fresh turn the way ChatPanel does. `turn` settles once it may be sent. */
async function beginTurn(): Promise<{ turn: Promise<void> }> {
  const start = chatProps.mock.lastCall?.[0].onTurnStart
  if (!start) throw new Error('Chat turn-start handler is not mounted')
  let turn!: Promise<void>
  await act(async () => {
    turn = Promise.resolve(start())
  })
  return { turn }
}

/** Opens the app bar's account menu (unless it already is) and returns an item. */
function accountAction(name: string): HTMLButtonElement {
  if (!screen.queryByRole('menu', { name: 'Fabric account' })) {
    fireEvent.click(screen.getByRole('button', { name: /^Account/ }))
  }
  return screen.getByRole('menuitem', { name }) as HTMLButtonElement
}

beforeEach(() => {
  chatProps.mockClear()
  previewProps.mockClear()
  advisorProps.mockClear()
  deploymentsProps.mockClear()
  helpProps.mockClear()
  searchProps.mockClear()
  migrateProps.mockClear()
  advisorMock.derived = { badge: null, items: [], open: [], resolved: [] }
  advisorMock.handOff.mockClear()
  advisorMock.links = null
  guardState.ready = true
  localBackendStore.clear()
  localStatuses = new Map()
  emitLocalState = null
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('Workbench authentication recovery', () => {
  it('requires confirmation before clearing shared Fabric credentials', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    fireEvent.click(accountAction('Refresh Fabric authentication'))
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
    fireEvent.click(accountAction('Refresh Fabric authentication'))
    view.rerender(<Workbench {...props} auth={{ ...auth, rayfin: { ...auth.rayfin, tenant: 'tenant-two' } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear credentials and sign in' }))
    expect(api.auth.refreshRayfin).toHaveBeenCalledWith(project.id, 'tenant-one')
    expect(accountAction('Sign out').disabled).toBe(true)

    const log = 'Removed a stale token-cache lock left by an interrupted sign-in\n'
    act(() => api.onProcLog.mock.calls[0][0]({ channel: 'refresh:rayfin', stream: 'stderr', data: log }))
    expect(screen.getByLabelText('Authentication refresh log').textContent).toBe(log)
    fireEvent.click(screen.getByRole('button', { name: 'Test deploy' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Publishing paused')
    )
    expect(api.deploy.run).not.toHaveBeenCalled()
    await act(async () => refreshed.resolve({ ok: true, exitCode: 0 }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByLabelText('Chat draft')).toBe(draft)
    expect(draft.value).toBe('Keep this draft')
    expect(screen.getByTestId('deploy-log').textContent).toContain(log)
    expect(props.onReviewSetup).not.toHaveBeenCalled()
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
      fireEvent.click(accountAction('Refresh Fabric authentication'))
      fireEvent.click(screen.getByRole('button', { name: 'Clear credentials and sign in' }))

      expect((await screen.findByRole('alert')).textContent).toContain('Credential refresh failed')
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'Clear credentials and sign in' }) as HTMLButtonElement).disabled).toBe(false)
      )
      expect(api.deploy.run).not.toHaveBeenCalled()
      expect(props.onReviewSetup).not.toHaveBeenCalled()
    }
  )

  it('does not replay queued deployments or automatically clear a token-cache failure', async () => {
    const api = installApi(true)
    const deploying = deferred<DeployResult>()
    api.deploy.hasChanges.mockResolvedValue(true)
    api.deploy.run.mockReturnValueOnce(deploying.promise)
    render(<Workbench {...makeProps({ settings: autoSettings })} />, { wrapper: Wrapper })
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
    await screen.findByLabelText('Chat draft')
    fireEvent.click(accountAction('Refresh Fabric authentication'))
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
      fireEvent.click(accountAction('Sign out'))

      expect((await screen.findByRole('alert')).textContent).toContain('Logout failed')
      await waitFor(() => expect(accountAction('Sign out').disabled).toBe(false))
      expect(props.onReviewSetup).not.toHaveBeenCalled()
      expect(props.onAuthChanged).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('home')).toBeTruthy()
    }
  )

  it('keeps the sign-out overlay until the verified account refresh completes', async () => {
    installApi(true)
    const refreshed = deferred<void>()
    const props = makeProps({ onAuthChanged: vi.fn(() => refreshed.promise) })
    render(<Workbench {...props} />, { wrapper: Wrapper })
    const draft = (await screen.findByLabelText('Chat draft')) as HTMLTextAreaElement
    fireEvent.change(draft, { target: { value: 'Still here after signing out' } })
    fireEvent.click(accountAction('Sign out'))

    await waitFor(() => expect(props.onAuthChanged).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('alertdialog', { name: 'Signing out' })).toBeTruthy()
    expect(accountAction('Signing out…').disabled).toBe(true)
    await act(async () => refreshed.resolve(undefined))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(accountAction('Sign out').disabled).toBe(false)
    // Signing out of Fabric never leaves the workbench or its drafts.
    expect(props.onReviewSetup).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Chat draft')).toBe(draft)
    expect(draft.value).toBe('Still here after signing out')
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
      expect(props.onReviewSetup).not.toHaveBeenCalled()
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
    const signOut = accountAction('Sign out')
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
      expect(props.onReviewSetup).not.toHaveBeenCalled()
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
    expect(props.onReviewSetup).not.toHaveBeenCalled()
  })
})

describe('Workbench app bar', () => {
  it('shows a neutral account control while the launch check runs', () => {
    installApi()
    const checking: AuthStatus = {
      copilot: { signedIn: false, checking: true },
      rayfin: { signedIn: false, checking: true },
      az: { signedIn: false, checking: true }
    }
    render(<Workbench {...makeProps({ auth: checking })} />, { wrapper: Wrapper })

    expect(screen.queryByRole('button', { name: 'Sign in to Fabric' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Account: checking sign-in' }))
    expect(screen.getByText('Checking your Fabric sign-in…')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Manage accounts…' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull()
  })

  it('raises what the background check found without leaving, and links to each fix', async () => {
    const api = installApi()
    const props = makeProps({ attention: { tools: ['Node.js'], signIns: ['GitHub Copilot'] } })
    render(<Workbench {...props} />, { wrapper: Wrapper })

    expect(
      screen.getByText('Not signed in to GitHub Copilot. Node.js is missing or out of date.')
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review setup' }))
    expect(props.onReviewSetup).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Manage accounts' }))
    expect(await screen.findByRole('dialog', { name: 'Accounts' })).toBeTruthy()
    await waitFor(() => expect(api.github.accounts).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog', { name: 'Accounts' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/Not signed in to GitHub Copilot/)).toBeNull()
  })

  it('opens Accounts from the account menu', async () => {
    installApi()
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    fireEvent.click(accountAction('Manage accounts…'))
    const dialog = await screen.findByRole('dialog', { name: 'Accounts' })
    expect(within(dialog).getByText('dev@example.com')).toBeTruthy()
    expect(within(dialog).getByText('octocat')).toBeTruthy()
  })
  it('puts the project, its views, deploys and the account on one bar without the brand', async () => {
    installApi(true)
    const { container } = render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    const bar = container.querySelector('header.app-bar') as HTMLElement
    expect(container.querySelectorAll('header')).toHaveLength(1)
    expect(bar.textContent).not.toContain('Fabricator')
    const inBar = within(bar)
    expect(inBar.getByRole('button', { name: 'Project One — Switch projects' })).toBeTruthy()
    expect(inBar.getByRole('tablist', { name: 'Project views' })).toBeTruthy()
    expect(inBar.getByRole('button', { name: 'Test deploy' })).toBeTruthy()
    expect(inBar.queryByRole('button', { name: 'Settings' }), 'Settings is in the account menu').toBeNull()
    expect(inBar.getByRole('button', { name: 'Account: dev@example.com' })).toBeTruthy()
    expect(accountAction('Settings')).toBeTruthy()
  })

  it('shows every project from the project menu and returns to the still-open project', async () => {
    installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    const draft = await screen.findByLabelText('Chat draft')

    fireEvent.click(screen.getByRole('button', { name: 'Project One — Switch projects' }))
    expect(screen.queryByTestId('home')).toBeNull()
    expect(screen.getByText('No other recent projects')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'All projects' }))
    expect(screen.getByTestId('home')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Test deploy' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back to Project One' }))
    expect(screen.queryByTestId('home')).toBeNull()
    expect(screen.getByRole('tablist', { name: 'Project views' })).toBeTruthy()
    expect(screen.getByLabelText('Chat draft')).toBe(draft)
  })

  it('opens Help to find out why a deploy failed, and asks straight away', async () => {
    const api = installApi(true)
    api.deploy.run.mockResolvedValueOnce({ ok: false, outcome: 'error', error: 'Runtime settings sync failed' })
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    fireEvent.click(screen.getByRole('button', { name: 'Test deploy' }))
    await waitFor(() =>
      expect(screen.getByTestId('deploy-state').textContent).toBe('Runtime settings sync failed')
    )

    act(() => previewProps.mock.lastCall![0].onDiagnoseDeploy?.())
    expect(screen.getByRole('dialog', { name: 'Help' })).toBeTruthy()
    const props = helpProps.mock.lastCall![0]
    expect(props.initialQuestion).toBe(DEPLOY_QUESTION)
    expect(props.facts?.some((f) => /most recent \w+ of "Project One" failed/.test(f))).toBe(true)
  })

  it('forgets the question once Help closes, so opening it later asks nothing', async () => {
    installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    act(() => previewProps.mock.lastCall![0].onDiagnoseDeploy?.())
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true })
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Help' }))
    expect(screen.getByRole('dialog', { name: 'Help' })).toBeTruthy()
    expect(helpProps.mock.lastCall![0].initialQuestion).toBeUndefined()
    expect(helpProps.mock.lastCall![0].facts?.some((f) => f.includes('failed'))).toBe(false)
  })

  it('opens Share once for Help, so coming back to the project does not open it again', async () => {
    installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    fireEvent.keyDown(window, { key: 'j', ctrlKey: true })
    act(() => helpProps.mock.lastCall![0].onAction({ id: 'share-app', label: 'Share Project One' }))
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull()
    const request = deploymentsProps.mock.lastCall?.[0].shareRequest
    expect(request).toMatchObject({ projectId: 'p1' })

    // The deployment control opens the dialog and says so; the request is spent.
    act(() => deploymentsProps.mock.lastCall![0].onShareRequestHandled?.(request!.nonce))
    expect(deploymentsProps.mock.lastCall?.[0].shareRequest).toBeNull()

    // Going Home and back mounts the control again, with nothing waiting for it.
    fireEvent.click(screen.getByRole('button', { name: 'Project One — Switch projects' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'All projects' }))
    expect(screen.queryByRole('button', { name: 'Test deploy' })).toBeNull()
    deploymentsProps.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Project One' }))
    expect(screen.getByRole('button', { name: 'Test deploy' })).toBeTruthy()
    expect(deploymentsProps.mock.lastCall?.[0].shareRequest).toBeNull()
  })

  it('lists the workspaces your apps use first in New deployment, most recent first', async () => {
    const api = installApi(true)
    const state = {
      workspaceRoot: 'C:\\projects',
      activeProjectId: project.id,
      projects: [
        { ...project, workspace: 'ws-a', lastDeploy: { ...project.lastDeploy, at: '2026-10-01T09:00:00Z' } },
        { ...project, id: 'p2', name: 'Project Two', path: 'C:\\projects\\p2', workspace: 'ws-b',
          lastDeploy: { status: 'success', at: '2026-10-09T09:00:00Z' } }
      ]
    }
    api.projects.state.mockResolvedValue(state)
    api.deploy.reconcile.mockResolvedValue(state)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    expect(deploymentsProps.mock.lastCall?.[0].recentWorkspaces).toEqual(['ws-b', 'ws-a'])
  })

  it('switches to a recent project from the project menu without showing Home', async () => {
    const api = installApi(true)
    const other: StudioProject = { ...project, id: 'p2', name: 'Project Two', path: 'C:\\projects\\p2' }
    let current = {
      workspaceRoot: 'C:\\projects',
      activeProjectId: project.id as string | null,
      projects: [project, other]
    }
    api.projects.state.mockImplementation(async () => current)
    api.deploy.reconcile.mockImplementation(async () => current)
    api.projects.setActive.mockImplementation(async (id) => {
      const picked = current.projects.find((p) => p.id === id)
      if (picked) {
        current = {
          ...current,
          activeProjectId: picked.id,
          projects: [picked, ...current.projects.filter((p) => p.id !== picked.id)]
        }
      }
      return current
    })
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    fireEvent.click(screen.getByRole('button', { name: 'Project One — Switch projects' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Project Two' }))

    expect(await screen.findByRole('button', { name: 'Project Two — Switch projects' })).toBeTruthy()
    expect(api.projects.setActive).toHaveBeenCalledTimes(1)
    expect(api.projects.setActive).toHaveBeenCalledWith('p2')
    expect(screen.queryByTestId('home')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Project Two — Switch projects' }))
    expect(screen.getByRole('menuitem', { name: 'Project One' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Project Two' })).toBeNull()
  })

  it('keeps tabs and deploys locked until the project dependencies are ready', async () => {
    guardState.ready = false
    installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })

    expect(await screen.findByText('Preparing Project One')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Project One — Switch projects' })).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Test deploy' })).toBeNull()
  })

  it('keeps credential refresh reachable while signed out of Fabric', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps({ auth: { ...auth, rayfin: { signedIn: false } } })} />, {
      wrapper: Wrapper
    })
    await screen.findByLabelText('Chat draft')

    expect(screen.queryByRole('button', { name: /^Account/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in to Fabric' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Settings and accounts' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh Fabric authentication' }))
    expect(screen.getByRole('dialog').textContent).toContain('shared across projects')
    expect(api.auth.refreshRayfin).not.toHaveBeenCalled()
  })
})

describe('Workbench after-turn publishing', () => {
  it.each<{ label: string; settings: AppSettings | null }>([
    { label: 'while settings load', settings: null },
    { label: 'by default', settings: defaultSettings },
    { label: 'once turned off', settings: manualSettings }
  ])('keeps every turn on this computer $label, and publishes on Publish', async ({ settings }) => {
    const api = installApi(true)
    api.deploy.hasChanges.mockResolvedValue(true)
    render(<Workbench {...makeProps({ settings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    expect(deploymentsProps.mock.lastCall?.[0].autoDeploy?.on).toBe(false)

    await act(async () => completeTurn())
    await act(async () => completeTurn())
    expect(api.chat.saveHistory).toHaveBeenCalledTimes(2)
    expect(api.deploy.hasChanges).not.toHaveBeenCalled()
    expect(api.deploy.run).not.toHaveBeenCalled()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test deploy' })))
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
    expect(api.deploy.run).toHaveBeenCalledWith(project.id, undefined)
  })

  it('turns on publishing after each turn from the published apps panel', async () => {
    const api = installApi(true)
    api.deploy.hasChanges.mockResolvedValue(true)
    const props = makeProps({ settings: defaultSettings })
    const { rerender } = render(<Workbench {...props} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    expect(screen.queryByRole('combobox', { name: /deploy/i }), 'not in the status bar').toBeNull()

    act(() => deploymentsProps.mock.lastCall?.[0].autoDeploy?.onChange(true))
    expect(props.onSettingsChange).toHaveBeenCalledWith({ deployMode: 'auto' })
    rerender(<Workbench {...props} settings={autoSettings} />)
    expect(deploymentsProps.mock.lastCall?.[0].autoDeploy?.on).toBe(true)

    await act(async () => completeTurn())
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
  })

  it('publishes after each turn while that’s on, and not once it’s turned off while changes are checked', async () => {
    const api = installApi(true)
    const changed = deferred<boolean>()
    api.deploy.hasChanges.mockReturnValueOnce(changed.promise)
    const props = makeProps({ settings: autoSettings })
    const { rerender } = render(<Workbench {...props} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    expect(deploymentsProps.mock.lastCall?.[0].autoDeploy?.on).toBe(true)

    act(() => deploymentsProps.mock.lastCall?.[0].autoDeploy?.onChange(false))
    expect(props.onSettingsChange).toHaveBeenCalledWith({ deployMode: 'manual' })

    await act(async () => completeTurn())
    rerender(<Workbench {...props} settings={manualSettings} />)
    await act(async () => changed.resolve(true))
    expect(api.deploy.run).not.toHaveBeenCalled()

    // Turning it back on publishes after the next turn, not straight away.
    rerender(<Workbench {...props} />)
    expect(api.deploy.run).not.toHaveBeenCalled()
    api.deploy.hasChanges.mockResolvedValue(true)
    await act(async () => completeTurn())
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
  })

  it('publishes unpublished changes even without file-edit events from the agent', async () => {
    const api = installApi(true)
    api.deploy.hasChanges.mockResolvedValue(true)
    render(<Workbench {...makeProps({ settings: autoSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())

    expect(api.deploy.hasChanges).toHaveBeenCalledWith(project.id)
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
    expect(api.deploy.run).toHaveBeenCalledWith(project.id, undefined)
    expect(api.projects.git.divergence).not.toHaveBeenCalled()
  })

  it('does not publish again when the published content is unchanged', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps({ settings: autoSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())

    expect(api.deploy.hasChanges).toHaveBeenCalledWith(project.id)
    expect(api.deploy.run).not.toHaveBeenCalled()
  })

  it('leaves the first publish of a new app to the user, even with publishing after each turn on', async () => {
    const api = installApi(true)
    const fresh = { ...project, lastDeploy: undefined }
    const state = { workspaceRoot: 'C:\\projects', activeProjectId: fresh.id, projects: [fresh] }
    api.projects.state.mockResolvedValue(state)
    api.deploy.reconcile.mockResolvedValue(state)
    api.deploy.hasChanges.mockResolvedValue(true)
    render(<Workbench {...makeProps({ settings: autoSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())

    expect(api.deploy.hasChanges).not.toHaveBeenCalled()
    expect(api.deploy.run).not.toHaveBeenCalled()
  })

  it.each([undefined, 'Coding failed'])(
    'does not publish after an unsuccessful turn (%s)',
    async (error) => {
      const api = installApi(true)
      api.deploy.hasChanges.mockResolvedValue(true)
      render(<Workbench {...makeProps({ settings: autoSettings })} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')

      await act(async () =>
        completeTurn({ ok: false, error, filesModified: ['app.ts'], ranDeploy: false })
      )

      expect(api.deploy.hasChanges).not.toHaveBeenCalled()
      expect(api.deploy.run).not.toHaveBeenCalled()
    }
  )

  it.each(['project refresh', 'history save', 'version check'])(
    'still publishes and reports a failed %s',
    async (failure) => {
      const api = installApi(true)
      api.deploy.hasChanges.mockResolvedValue(true)
      render(<Workbench {...makeProps({ settings: autoSettings })} />, { wrapper: Wrapper })
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
    'surfaces a failed change check (%s) instead of silently skipping the publish',
    async (error) => {
      const api = installApi(true)
      api.deploy.hasChanges.mockRejectedValueOnce(error)
      render(<Workbench {...makeProps({ settings: autoSettings })} />, { wrapper: Wrapper })
      await screen.findByLabelText('Chat draft')

      await act(async () => completeTurn())

      const alert = screen.getByRole('alert').textContent
      expect(alert).toContain('Couldn’t publish automatically')
      expect(alert).toContain('Git unavailable')
      expect(alert).toContain('Select Publish to publish your changes.')
      expect(api.deploy.run).not.toHaveBeenCalled()
    }
  )

  it('queues another publish when another turn finishes during one', async () => {
    const api = installApi(true)
    const deploying = deferred<DeployResult>()
    api.deploy.hasChanges.mockResolvedValue(true)
    api.deploy.run.mockReturnValueOnce(deploying.promise)
    render(<Workbench {...makeProps({ settings: autoSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())
    await act(async () => completeTurn())
    expect(api.deploy.run).toHaveBeenCalledTimes(1)

    await act(async () => deploying.resolve({ ok: true, outcome: 'success' }))

    expect(api.deploy.run).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('deploy-state').textContent).toBe('idle')
  })

  it('tells the deployment control what the next deploy would ship, and checks again after a turn', async () => {
    const api = installApi(true)
    api.deploy.pending.mockResolvedValueOnce({ changed: false, files: 0 }).mockResolvedValue({ changed: true, files: 2 })
    render(<Workbench {...makeProps({ settings: manualSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    await waitFor(() => expect(deploymentsProps.mock.lastCall?.[0].pending).toEqual({ changed: false, files: 0 }))

    await act(async () => completeTurn())
    await waitFor(() => expect(deploymentsProps.mock.lastCall?.[0].pending).toEqual({ changed: true, files: 2 }))
    expect(api.deploy.pending).toHaveBeenCalledWith(project.id)
  })

  it('shows a redeploy on the full deploy screen when asked, until it ends', async () => {
    const api = installApi(true)
    const deploying = deferred<DeployResult>()
    api.deploy.run.mockReturnValueOnce(deploying.promise)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    fireEvent.click(screen.getByRole('button', { name: 'Test deploy' }))
    await waitFor(() => expect(previewProps.mock.lastCall?.[0].deploy?.running).toBe(true))
    expect(previewProps.mock.lastCall?.[0].deploy?.startedAt).toEqual(expect.any(Number))
    expect(previewProps.mock.lastCall?.[0].watching).toBe(false)

    act(() => deploymentsProps.mock.lastCall?.[0].onWatch?.())
    expect(previewProps.mock.lastCall?.[0].watching).toBe(true)
    await act(async () => deploying.resolve({ ok: true, outcome: 'success' }))
    expect(previewProps.mock.lastCall?.[0].watching).toBe(false)
  })

  it('does not start a publish after the workbench is unmounted', async () => {
    const api = installApi(true)
    const changed = deferred<boolean>()
    api.deploy.hasChanges.mockReturnValueOnce(changed.promise)
    const view = render(<Workbench {...makeProps({ settings: autoSettings })} />, {
      wrapper: Wrapper
    })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())
    expect(api.deploy.hasChanges).toHaveBeenCalledWith(project.id)
    view.unmount()
    await act(async () => changed.resolve(true))

    expect(api.deploy.run).not.toHaveBeenCalled()
  })
})

/**
 * A personal app's turn that changed files becomes a version in its history, named after what was asked, so History and Restore
 * go turn by turn even while turns don't publish.
 */
describe('Workbench versions per chat turn', () => {
  /** The conversation so far: the user's message, and Copilot's answer with its steps. */
  function asked(text: string, tools: ChatToolCall[] = []): void {
    act(() => {
      chatProps.mock.lastCall?.[0].onChange(
        () =>
          [
            { id: 'u1', role: 'user', text, tools: [], pending: false },
            { id: 'a1', role: 'assistant', text: 'Done.', tools, pending: false }
          ] as never
      )
    })
  }

  it('saves a turn that changed files, named after the request, and nothing else', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps({ settings: defaultSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    asked('Add a task list')
    await act(async () =>
      completeTurn({ ok: true, filesModified: ['packages/data/src/Task.ts'], ranDeploy: false })
    )
    expect(api.projects.git.saveTurn).toHaveBeenCalledWith(project.id, 'Add a task list')

    // A turn that changed nothing, or didn't finish, saves no version.
    await act(async () => completeTurn())
    await act(async () =>
      completeTurn({
        ok: false,
        error: 'Stopped',
        filesModified: ['src/App.tsx'],
        ranDeploy: false
      })
    )
    expect(api.projects.git.saveTurn).toHaveBeenCalledTimes(1)
    expect(api.deploy.hasChanges, 'publishing waits for the user').not.toHaveBeenCalled()
  })

  it('saves a turn whose answer shows edits, without Copilot’s file events', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps({ settings: defaultSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    const app = `${project.path}\\src\\App.tsx`
    asked('make the header blue.', [
      { id: 't1', name: 'view', title: app, state: 'success' },
      { id: 't2', name: 'edit', title: app, paths: [app], state: 'success', added: 1, removed: 1 }
    ])
    await act(async () => completeTurn())
    expect(api.projects.git.saveTurn).toHaveBeenCalledWith(project.id, 'make the header blue.')
  })

  it('saves the version before a turn publishes the app', async () => {
    const api = installApi(true)
    const saving = deferred<SavedTurn>()
    api.projects.git.saveTurn.mockReturnValueOnce(saving.promise)
    api.deploy.hasChanges.mockResolvedValue(true)
    render(<Workbench {...makeProps({ settings: autoSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () =>
      completeTurn({ ok: true, filesModified: ['src/App.tsx'], ranDeploy: false })
    )
    expect(api.projects.git.saveTurn).toHaveBeenCalledWith(project.id, '')
    expect(api.deploy.hasChanges).not.toHaveBeenCalled()

    await act(async () => saving.resolve({ commit: 'abc123' }))
    expect(api.deploy.hasChanges).toHaveBeenCalledWith(project.id)
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
  })

})

/**
 * A published app this computer can't run previews on its published backend: a turn starts
 * Vite on a port the app's sign-in accepts. When every such port is taken, the
 * turn waits while the user registers another port (rayfin.yml + a settings
 * push) or stops the process.
 */
describe('Workbench live preview on the published backend, for an app this computer can’t run', () => {
  const conflict: PortConflict = {
    port: 5173,
    occupant: { pid: 4321, name: 'node.exe', commandLine: 'node C:\\other-app\\node_modules\\vite\\bin\\vite.js' },
    canStop: true,
    suggestedPort: 5174,
    needsPush: true
  }

  /** The app falls back: its Rayfin version is newer than this computer runs. */
  async function waitForFallback(): Promise<void> {
    await waitFor(() =>
      expect(previewProps.mock.lastCall?.[0].fallbackReason).toContain('Rayfin 1.40.0')
    )
    await act(async () => {})
  }

  async function mount(settings: AppSettings | null = autoSettings) {
    const api = installApi(true)
    nextLocal(project.id, tooNew)
    const dev = api.dev
    dev.plan.mockResolvedValue({ conflict })
    const view = render(<Workbench {...makeProps({ settings })} />, {
      wrapper: Wrapper
    })
    await screen.findByLabelText('Chat draft')
    await waitForFallback()
    return { api, dev, view }
  }

  it('starts straight away on a free port that sign-in accepts', async () => {
    const { dev } = await mount()
    dev.plan.mockResolvedValue({ port: 5174 })
    const { turn } = await beginTurn()
    await act(async () => turn)
    expect(dev.start).toHaveBeenCalledWith(project.id, 5174)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('holds the turn until another port is registered and pushed, then starts on it', async () => {
    const { api, dev } = await mount()
    const pushed = deferred<DeployResult>()
    dev.registerPort.mockReturnValueOnce(pushed.promise)
    let sent = false
    const { turn } = await beginTurn()
    void turn.then(() => {
      sent = true
    })
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Your live preview needs localhost:5173')
    expect(dialog.textContent).toContain('A dev server for other-app is using it.')
    expect(dialog.textContent).toContain('node.exe')
    expect(dialog.textContent).toContain('PID 4321')
    expect(dialog.textContent).toContain('vite.js')

    fireEvent.click(screen.getByRole('button', { name: 'Use localhost:5174 instead' }))
    expect(dev.registerPort).toHaveBeenCalledWith(project.id, 5174)
    act(() => api.onProcLog.mock.calls[0][0]({ channel: 'dev:register', stream: 'system', data: 'Pushing sign-in settings\n' }))
    expect(screen.getByLabelText('Port registration log').textContent).toContain('Pushing sign-in settings')
    await act(async () => {})
    expect(sent).toBe(false)
    expect(dev.start).not.toHaveBeenCalled()

    await act(async () => {
      pushed.resolve({ ok: true, outcome: 'success' })
      await turn
    })
    expect(sent).toBe(true)
    expect(dev.start).toHaveBeenCalledWith(project.id, 5174)
    expect(dev.freePort).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stops another app on this computer that holds the address, and starts on it', async () => {
    const { api, dev } = await mount()
    const holder = { projectId: 'p2', name: 'Toy Story', kind: 'backend' as const }
    dev.plan
      .mockResolvedValueOnce({
        conflict: { ...conflict, occupant: undefined, canStop: false, holder }
      })
      .mockResolvedValueOnce({ port: 5173 })
    const { turn } = await beginTurn()
    await act(async () => turn)
    // It keeps running after you leave it, so it makes way, and starts again when you open it.
    expect(api.local.stop).toHaveBeenCalledWith('p2')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dev.freePort).not.toHaveBeenCalled()
    expect(dev.start).toHaveBeenCalledWith(project.id, 5173)
  })

  it('stops the process holding the port when asked, then starts on that port', async () => {
    const { dev } = await mount()
    const { turn } = await beginTurn()
    fireEvent.click(screen.getByRole('button', { name: 'Stop the dev server' }))
    await act(async () => turn)
    expect(dev.freePort).toHaveBeenCalledWith(5173, 4321)
    expect(dev.registerPort).not.toHaveBeenCalled()
    expect(dev.start).toHaveBeenCalledWith(project.id, 5173)
  })

  it.each([
    ['stopping', 'Stop the dev server', 'Access is denied.'],
    ['pushing', 'Use localhost:5174 instead', 'Workspace not found']
  ])('keeps the prompt open with the reason when %s fails, and skipping still sends the turn', async (_, action, reason) => {
    const { dev } = await mount()
    dev.freePort.mockRejectedValueOnce(reason)
    dev.registerPort.mockResolvedValueOnce({ ok: false, outcome: 'error', error: reason })
    const { turn } = await beginTurn()
    fireEvent.click(screen.getByRole('button', { name: action }))
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain(reason))
    expect(dev.start).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Skip live preview' }))
    await act(async () => turn)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dev.start).not.toHaveBeenCalled()
  })

  it('signs in and retries once when the push finds an expired Fabric session', async () => {
    const { api, dev } = await mount()
    dev.registerPort.mockResolvedValueOnce({ ok: false, outcome: 'not-signed-in', error: 'Unauthorized' })
    const { turn } = await beginTurn()
    fireEvent.click(screen.getByRole('button', { name: 'Use localhost:5174 instead' }))
    await act(async () => turn)
    expect(api.auth.loginRayfin).toHaveBeenCalledWith(undefined, project.id)
    expect(dev.registerPort).toHaveBeenCalledTimes(2)
    expect(dev.start).toHaveBeenCalledWith(project.id, 5174)
  })

  it('does not ask again in a turn the user skipped, but does on the next turn', async () => {
    const { dev } = await mount()
    const { turn } = await beginTurn()
    fireEvent.click(screen.getByRole('button', { name: 'Skip live preview' }))
    await act(async () => turn)
    await act(async () => chatProps.mock.lastCall?.[0].onPlanExecutionStart?.())
    expect(dev.plan).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => completeTurn())
    await beginTurn()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(dev.plan).toHaveBeenCalledTimes(2)
  })

  it('offers only stopping mid-turn, since a new port would need a push', async () => {
    const { dev } = await mount()
    act(() => {
      chatProps.mock.lastCall?.[0].onChange(() => [
        { id: 'a1', role: 'assistant', text: '', tools: [], pending: true }
      ] as never)
    })
    await act(async () => chatProps.mock.lastCall?.[0].onPlanExecutionStart?.())
    const dialog = screen.getByRole('dialog')
    expect(screen.queryByRole('button', { name: 'Use localhost:5174 instead' })).toBeNull()
    expect(dialog.textContent).toContain('while Copilot is working')
    fireEvent.click(screen.getByRole('button', { name: 'Stop the dev server' }))
    await waitFor(() => expect(dev.start).toHaveBeenCalledWith(project.id, 5173))
    expect(dev.registerPort).not.toHaveBeenCalled()
  })

  it('skips with a notice when there is nothing to offer', async () => {
    const { dev } = await mount()
    dev.plan.mockResolvedValue({ conflict: { port: 5173, canStop: false, needsPush: true } })
    const { turn } = await beginTurn()
    await act(async () => turn)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByText('Live preview skipped')).toBeTruthy()
    expect(dev.start).not.toHaveBeenCalled()
  })

  it.each<{ label: string; settings: AppSettings | null }>([
    { label: 'experiments are absent', settings: autoSettings },
    { label: 'experiments are empty', settings: { ...autoSettings, experiments: {} } },
    ...[false, true].map((localDevPreview) => ({
      label: `the retired preview flag is ${localDevPreview}`,
      settings: {
        ...autoSettings,
        experiments: { localDevPreview, teamWorkspaces: false }
      }
    }))
  ])('starts live preview when $label', async ({ settings }) => {
    const { dev } = await mount(settings)
    dev.plan.mockResolvedValue({ port: 5174 })
    const { turn } = await beginTurn()
    await act(async () => turn)
    expect(dev.plan).toHaveBeenCalledWith(project.id)
    expect(dev.start).toHaveBeenCalledWith(project.id, 5174)
    expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBe('http://localhost:5174')
  })

  it('keeps the deployed preview when the project has no local Vite', async () => {
    const { dev } = await mount()
    dev.plan.mockResolvedValue({})
    const { turn } = await beginTurn()
    await act(async () => turn)
    expect(dev.start).not.toHaveBeenCalled()
    expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['port planning', 'startup result', 'startup rejection'])(
    'reports a %s failure without holding the turn or replacing the deployed preview',
    async (failure) => {
      const { dev } = await mount()
      dev.plan.mockResolvedValue({ port: 5174 })
      if (failure === 'port planning') {
        dev.plan.mockRejectedValueOnce(new Error('Preview startup failed'))
      } else if (failure === 'startup result') {
        dev.start.mockResolvedValueOnce({ ok: false, outcome: 'error', error: 'Preview startup failed' })
      } else {
        dev.start.mockRejectedValueOnce(new Error('Preview startup failed'))
      }
      const { turn } = await beginTurn()
      await act(async () => turn)
      expect(await screen.findByText('Preview startup failed')).toBeTruthy()
      expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBeNull()
    }
  )

  it('enables the chat and Design submission interlocks during deployment without a preview flag', async () => {
    const { api, dev } = await mount()
    const deploying = deferred<DeployResult>()
    api.deploy.run.mockReturnValueOnce(deploying.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Test deploy' }))
    await waitFor(() => expect(chatProps.mock.lastCall?.[0].deploying).toBe(true))
    expect(chatProps.mock.lastCall?.[0].blockSubmitWhileDeploying).toBe(true)
    expect(previewProps.mock.lastCall?.[0].designSendBlocked).toMatch(/^Publishing/)

    const { turn } = await beginTurn()
    await act(async () => turn)
    expect(dev.plan).not.toHaveBeenCalled()
    expect(dev.start).not.toHaveBeenCalled()

    await act(async () => deploying.resolve({ ok: true, outcome: 'success' }))
    await waitFor(() => expect(chatProps.mock.lastCall?.[0].deploying).toBe(false))
    expect(previewProps.mock.lastCall?.[0].designSendBlocked).toBeNull()
    dev.plan.mockResolvedValue({ port: 5174 })
    const next = await beginTurn()
    await act(async () => next.turn)
    expect(dev.start).toHaveBeenCalledWith(project.id, 5174)
  })

  it('stops the local preview at the end of an unsuccessful turn', async () => {
    const { api, dev } = await mount()
    dev.plan.mockResolvedValue({ port: 5174 })
    api.deploy.hasChanges.mockResolvedValue(true)
    const { turn } = await beginTurn()
    await act(async () => turn)
    expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBe('http://localhost:5174')

    await act(async () => completeTurn({ ok: false, filesModified: [], ranDeploy: false, error: 'Stopped' }))
    expect(dev.stop).toHaveBeenCalledWith(project.id)
    expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBeNull()
    expect(api.deploy.run).not.toHaveBeenCalled()
  })

  it('leaves the local preview to the after-turn deploy while chat turns deploy', async () => {
    const { api, dev } = await mount()
    dev.plan.mockResolvedValue({ port: 5174 })
    api.deploy.hasChanges.mockResolvedValue(true)
    const { turn } = await beginTurn()
    await act(async () => turn)

    await act(async () => completeTurn({ ok: true, filesModified: ['src/App.tsx'], ranDeploy: false }))
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
    expect(previewProps.mock.lastCall?.[0].localReload, 'the deploy reloads the app instead').toBe(0)
  })

  it('keeps the local preview on screen through the after-turn redeploy, and closes it when it ends', async () => {
    const { api, dev } = await mount()
    dev.plan.mockResolvedValue({ port: 5174 })
    api.deploy.hasChanges.mockResolvedValue(true)
    const deploying = deferred<DeployResult>()
    api.deploy.run.mockReturnValueOnce(deploying.promise)
    const { turn } = await beginTurn()
    await act(async () => turn)

    await act(async () => completeTurn())
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
    expect(dev.stop).not.toHaveBeenCalled()
    expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBe('http://localhost:5174')
    expect(previewProps.mock.lastCall?.[0].deploy?.running).toBe(true)

    await act(async () => deploying.resolve({ ok: true, outcome: 'success' }))
    expect(dev.stop).toHaveBeenCalledWith(project.id)
    const last = previewProps.mock.lastCall?.[0]
    expect(last?.localPreviewUrl).toBeNull()
    expect(last?.deploy?.running).toBe(false)
  })

  it('closes the local preview straight away when a turn leaves nothing to deploy', async () => {
    const { api, dev } = await mount()
    dev.plan.mockResolvedValue({ port: 5174 })
    const { turn } = await beginTurn()
    await act(async () => turn)

    await act(async () => completeTurn())
    expect(api.deploy.run).not.toHaveBeenCalled()
    expect(dev.stop).toHaveBeenCalledWith(project.id)
    expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBeNull()
  })

  /** Turns don't publish, with a free port, so the open app's live preview starts. */
  async function mountManual() {
    const api = installApi(true)
    nextLocal(project.id, tooNew)
    api.dev.plan.mockResolvedValue({ port: 5174 })
    const view = render(<Workbench {...makeProps({ settings: manualSettings })} />, {
      wrapper: Wrapper
    })
    await screen.findByLabelText('Chat draft')
    await waitFor(() => expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBe('http://localhost:5174'))
    return { api, dev: api.dev, view }
  }

  it.each([true, false])('keeps the live preview while turns don’t publish (%s)', async (ok) => {
    const { api, dev } = await mountManual()
    expect(dev.start).toHaveBeenCalledWith(project.id, 5174)
    expect(previewProps.mock.lastCall?.[0].manualDeploy).toBe(true)

    const { turn } = await beginTurn()
    await act(async () => turn)
    await act(async () => completeTurn({ ok, filesModified: [], ranDeploy: false }))
    expect(dev.start).toHaveBeenCalledTimes(1)
    expect(api.deploy.run).not.toHaveBeenCalled()

    // It stays through a deploy: the deploy shows its progress, then the local app returns.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test deploy' })))
    expect(api.deploy.run).toHaveBeenCalledTimes(1)
    expect(dev.stop).not.toHaveBeenCalled()
    expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBe('http://localhost:5174')
  })

  it('reloads the kept local preview after a turn that changed files, not after one that changed nothing', async () => {
    await mountManual()
    const reloads = (): number | undefined => previewProps.mock.lastCall?.[0].localReload
    expect(reloads()).toBe(0)

    let { turn } = await beginTurn()
    await act(async () => turn)
    await act(async () => completeTurn({ ok: true, filesModified: [], ranDeploy: false }))
    expect(reloads(), 'a turn that only answered').toBe(0)

    ;({ turn } = await beginTurn())
    await act(async () => turn)
    await act(async () => completeTurn({ ok: false, error: 'Stopped', filesModified: ['src/App.tsx'], ranDeploy: false }))
    expect(reloads(), 'a stopped turn that changed files').toBe(1)
  })

  it('tells the preview while a turn runs, so Design waits for it on the local preview', async () => {
    await mountManual()
    expect(previewProps.mock.lastCall?.[0].turnRunning).toBe(false)
    const setPending = (pending: boolean): void =>
      act(() => {
        chatProps.mock.lastCall?.[0].onChange(() => [
          { id: 'a1', role: 'assistant', text: '', tools: [], pending }
        ] as never)
      })
    setPending(true)
    expect(previewProps.mock.lastCall?.[0].turnRunning).toBe(true)
    setPending(false)
    expect(previewProps.mock.lastCall?.[0].turnRunning).toBe(false)
  })

  it('starts the local preview again when the app moves to another deployment', async () => {
    const { api, dev } = await mountManual()
    const moved: StudioProject = {
      ...project,
      workspace: 'ws-other',
      lastDeploy: { url: 'https://other.example.com', status: 'success' }
    }
    api.projects.state.mockResolvedValue({ workspaceRoot: 'C:\\projects', activeProjectId: project.id, projects: [moved] })

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test switch' })))

    await waitFor(() => expect(dev.start).toHaveBeenCalledTimes(2))
    expect(dev.stop).toHaveBeenCalledWith(project.id)
    expect(dev.stop.mock.invocationCallOrder[0]).toBeLessThan(dev.start.mock.invocationCallOrder[1])
  })

  it('moves the live preview to the app you switch to, once the old one has stopped', async () => {
    const api = installApi(true)
    const other: StudioProject = { ...project, id: 'p2', name: 'Project Two', path: 'C:\\projects\\p2' }
    nextLocal(project.id, tooNew)
    nextLocal(other.id, tooNew)
    let current = {
      workspaceRoot: 'C:\\projects',
      activeProjectId: project.id as string | null,
      projects: [project, other]
    }
    api.projects.state.mockImplementation(async () => current)
    api.deploy.reconcile.mockImplementation(async () => current)
    api.projects.setActive.mockImplementation(async (id) => {
      current = { ...current, activeProjectId: id }
      return current
    })
    api.dev.plan.mockResolvedValue({ port: 5174 })
    const stopped = deferred<void>()
    api.dev.stop.mockReturnValueOnce(stopped.promise)
    render(<Workbench {...makeProps({ settings: manualSettings })} />, {
      wrapper: Wrapper
    })
    await screen.findByLabelText('Chat draft')
    await waitFor(() => expect(api.dev.start).toHaveBeenCalledWith(project.id, 5174))

    fireEvent.click(screen.getByRole('button', { name: 'Project One — Switch projects' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Project Two' }))
    await screen.findByRole('button', { name: 'Project Two — Switch projects' })
    expect(api.dev.stop).toHaveBeenCalledWith(project.id)
    expect(api.dev.plan).not.toHaveBeenCalledWith('p2')

    await act(async () => stopped.resolve())
    await waitFor(() => expect(api.dev.start).toHaveBeenCalledWith('p2', 5174))
  })

  it('closes the live preview when publishing after each turn is turned on', async () => {
    const { dev, view } = await mountManual()
    view.rerender(<Workbench {...makeProps({ settings: autoSettings })} />)
    expect(dev.stop).toHaveBeenCalledWith(project.id)
    expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBeNull()
  })

  it('closes the local preview when the workbench closes', async () => {
    const { dev, view } = await mountManual()
    view.unmount()
    expect(dev.stop).toHaveBeenCalledWith(project.id)
  })

  it('does not resurrect a local preview whose startup finishes after the turn ended', async () => {
    const { dev } = await mount()
    const started = deferred<DevServerResult>()
    dev.plan.mockResolvedValue({ port: 5174 })
    dev.start.mockReturnValueOnce(started.promise)
    const { turn } = await beginTurn()
    await act(async () => turn)
    await act(async () => completeTurn({ ok: false, filesModified: [], ranDeploy: false }))
    expect(dev.stop).toHaveBeenCalledWith(project.id)

    await act(async () => started.resolve({ ok: true, outcome: 'running', url: 'http://localhost:5174' }))
    expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBeNull()
  })
})

/**
 * A personal app runs on its local backend from the moment it opens, through
 * every turn: no Vite of Fabricator's own, no port prompts, nothing published
 * unless the user asks.
 */
describe('Workbench local backend', () => {
  const setTurnRunning = (pending: boolean): void =>
    act(() => {
      chatProps.mock.lastCall?.[0].onChange(
        () => [{ id: 'a1', role: 'assistant', text: '', tools: [], pending }] as never
      )
    })
  const preview = (): ComponentProps<typeof PreviewPane> => {
    const props = previewProps.mock.lastCall?.[0]
    if (!props) throw new Error('The preview is not mounted')
    return props
  }

  async function mountLocal(settings: AppSettings | null = defaultSettings) {
    const api = installApi(true)
    const props = makeProps({ settings })
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    await waitFor(() => expect(api.local.start).toHaveBeenCalledTimes(1))
    return { api, props, view }
  }

  it('starts a personal app’s backend once its packages are ready, and keeps it through turns', async () => {
    guardState.ready = false
    const api = installApi(true)
    const props = makeProps({ settings: defaultSettings })
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    await screen.findByText('Preparing Project One')
    await act(async () => {})
    expect(api.local.start, 'not before its packages are installed').not.toHaveBeenCalled()

    guardState.ready = true
    view.rerender(<Workbench {...props} />)
    await waitFor(() => expect(api.local.start).toHaveBeenCalledWith(project.id, undefined))
    emitLocal({ state: 'running', ready: localReady })
    expect(preview().local?.ready?.appUrl).toBe('http://localhost:5173/')
    expect(preview().fallbackReason).toBeNull()

    const { turn } = await beginTurn()
    await act(async () => turn)
    await act(async () =>
      completeTurn({ ok: true, filesModified: ['src/App.tsx'], ranDeploy: false })
    )
    expect(api.dev.plan, 'its own Vite shows the turn').not.toHaveBeenCalled()
    expect(api.dev.start).not.toHaveBeenCalled()
    expect(api.local.stop).not.toHaveBeenCalled()
    expect(api.local.start).toHaveBeenCalledTimes(1)
    expect(api.deploy.hasChanges, 'publishing waits for the user').not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('starts the backend of the app you switch to, and doesn’t restart one that runs', async () => {
    const api = installApi(true)
    const other: StudioProject = {
      ...project,
      id: 'p2',
      name: 'Project Two',
      path: 'C:\\projects\\p2'
    }
    let current = {
      workspaceRoot: 'C:\\projects',
      activeProjectId: project.id as string | null,
      projects: [project, other]
    }
    api.projects.state.mockImplementation(async () => current)
    api.deploy.reconcile.mockImplementation(async () => current)
    api.projects.setActive.mockImplementation(async (id) => {
      current = { ...current, activeProjectId: id }
      return current
    })
    nextLocal(other.id, { state: 'running', ready: localReady })
    render(<Workbench {...makeProps({ settings: defaultSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    await waitFor(() => expect(api.local.start).toHaveBeenCalledWith(project.id, undefined))

    fireEvent.click(screen.getByRole('button', { name: 'Project One — Switch projects' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Project Two' }))
    await screen.findByRole('button', { name: 'Project Two — Switch projects' })
    await waitFor(() => expect(preview().local?.status?.projectId).toBe(other.id))
    await act(async () => {})
    expect(api.local.start).not.toHaveBeenCalledWith(other.id, undefined)
    expect(api.local.stop, 'the one you came from keeps running').not.toHaveBeenCalled()
  })

  it('never starts a team app’s local backend', async () => {
    const api = installApi(true)
    const teamApp: StudioProject = {
      ...project,
      lastDeploy: undefined,
      team: { workspaceId: 'w1', folder: 'team-app', worktree: 'C:\\team\\team-app', branch: 'b' }
    }
    const state = {
      workspaceRoot: 'C:\\projects',
      activeProjectId: teamApp.id,
      projects: [teamApp]
    }
    api.projects.state.mockResolvedValue(state)
    api.deploy.reconcile.mockResolvedValue(state)
    render(<Workbench {...makeProps({ settings: defaultSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    await act(async () => {})
    expect(api.local.status).not.toHaveBeenCalled()
    expect(api.local.start).not.toHaveBeenCalled()
    expect(preview().local).toBeUndefined()
  })

  it('reloads the page once the backend rebuilds what it uses, after the turn that changed it', async () => {
    await mountLocal()
    emitLocal({ state: 'running', ready: localReady })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const rebuilt = (
      time: string,
      functions: 'building' | 'ready' = 'ready'
    ): Partial<LocalStatus> => ({
      state: 'running',
      ready: localReady,
      schema: {
        result: 'applied',
        changes: ['changed Note'],
        losses: [],
        message: null,
        live: true,
        time
      },
      functions: { state: functions, names: [], errors: [], message: null, time }
    })

    setTurnRunning(true)
    emitLocal(rebuilt('2026-10-30T03:01:00.000Z'))
    act(() => vi.advanceTimersByTime(1000))
    expect(preview().localReload, 'not mid-turn').toBe(0)
    setTurnRunning(false)
    act(() => vi.advanceTimersByTime(1000))
    expect(preview().localReload).toBe(1)

    // Outside turns too, once its functions have built.
    emitLocal(rebuilt('2026-10-30T03:02:00.000Z', 'building'))
    act(() => vi.advanceTimersByTime(1000))
    expect(preview().localReload).toBe(1)
    emitLocal(rebuilt('2026-10-30T03:02:05.000Z'))
    act(() => vi.advanceTimersByTime(1000))
    expect(preview().localReload).toBe(2)
    // A status that changes nothing the page uses leaves it be.
    emitLocal({ ...rebuilt('2026-10-30T03:02:05.000Z'), warnings: [] })
    act(() => vi.advanceTimersByTime(1000))
    expect(preview().localReload).toBe(2)
  })

  it('starts the backend again after a turn when a problem in the app stopped it', async () => {
    const { api } = await mountLocal()
    emitLocal({
      state: 'error',
      error: {
        code: 'analysis-failed',
        message: 'Note.ts has an error.',
        hint: null,
        fatal: true,
        details: null,
        time: null
      }
    })
    await act(async () => completeTurn())
    expect(api.local.start).toHaveBeenCalledTimes(2)

    emitLocal({
      state: 'error',
      error: {
        code: 'already-serving',
        message: 'Another serve runs it.',
        hint: null,
        fatal: true,
        details: { pid: 42 },
        time: null
      }
    })
    await act(async () => completeTurn())
    expect(api.local.start, 'a turn can’t stop the other one').toHaveBeenCalledTimes(2)
  })

  it('asks about a data model change that would delete local data once the turn ends', async () => {
    const { api } = await mountLocal()
    const refused = (time: string): Partial<LocalStatus> => ({
      state: 'running',
      ready: localReady,
      schema: {
        result: 'refused',
        changes: ['changed Note'],
        losses: ['Note.title (3 values)'],
        message: null,
        live: true,
        time
      }
    })
    setTurnRunning(true)
    emitLocal(refused('2026-10-30T03:01:00.000Z'))
    expect(screen.queryByRole('dialog'), 'Copilot may change it again').toBeNull()
    setTurnRunning(false)
    const dialog = screen.getByRole('dialog', { name: 'This change would delete local data' })
    expect(within(dialog).getByText('Note.title (3 values)')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep the current version' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => completeTurn())
    expect(screen.queryByRole('dialog'), 'kept: not asked again for the same change').toBeNull()

    act(() => preview().onReviewSchema?.())
    fireEvent.click(screen.getByRole('button', { name: 'Delete this data and apply' }))
    await waitFor(() => expect(api.local.reload).toHaveBeenCalledWith(project.id, true))

    // Refused as it started, the app waits: resetting its data starts it from empty.
    emitLocal({
      state: 'error',
      error: {
        code: 'schema-refused',
        message: 'The change would delete data.',
        hint: null,
        fatal: true,
        details: { losses: ['Tag (2 rows)'] },
        time: '2026-10-30T03:03:00.000Z'
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reset local data' }))
    await waitFor(() => expect(api.local.restart).toHaveBeenCalledWith(project.id, { reset: true }))
    emitLocal({ state: 'starting', phase: 'starting' })
    expect(screen.queryByRole('dialog'), 'the change is no longer waiting').toBeNull()
  })

  it('falls back to the published backend when this computer can’t run the app, and says why', async () => {
    const api = installApi(true)
    api.dev.plan.mockResolvedValue({ port: 5174 })
    render(<Workbench {...makeProps({ settings: manualSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    await waitFor(() => expect(api.local.start).toHaveBeenCalledTimes(1))
    emitLocal({
      state: 'running',
      ready: {
        ...localReady,
        features: {
          ...localReady.features,
          connectors: [{ name: 'logs', type: 'kusto', supported: false }]
        }
      }
    })
    const reason =
      'The logs connector runs only on Fabric, so the preview uses your published app’s backend.'
    expect(preview().fallbackReason).toBe(reason)
    expect(preview().local, 'no local view').toBeUndefined()
    await waitFor(() => expect(api.local.stop).toHaveBeenCalledWith(project.id))
    expect(api.local.reportFallback).toHaveBeenCalledWith(
      project.id,
      'connector-unsupported',
      reason
    )
    expect(api.dev.plan, 'its ports are still taken').not.toHaveBeenCalled()

    // Stopped, it lets go of its ports, and the live preview on the published backend starts.
    emitLocal({ state: 'stopped' })
    await waitFor(() => expect(api.dev.start).toHaveBeenCalledWith(project.id, 5174))
    expect(preview().fallbackReason, 'it stays fallen back').toBe(reason)
    expect(api.local.reportFallback).toHaveBeenCalledTimes(1)
  })

  it('checks again after a turn changes the app’s packages, and runs it here once it can', async () => {
    const api = installApi(true)
    nextLocal(project.id, tooNew)
    api.dev.plan.mockResolvedValue({ port: 5174 })
    render(<Workbench {...makeProps({ settings: manualSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    await waitFor(() => expect(preview().localPreviewUrl).toBe('http://localhost:5174'))
    expect(api.local.start, 'known to fall back').not.toHaveBeenCalled()

    await act(async () =>
      completeTurn({ ok: true, filesModified: ['src/App.tsx'], ranDeploy: false })
    )
    expect(api.local.start).not.toHaveBeenCalled()
    await act(async () =>
      completeTurn({ ok: true, filesModified: ['package.json'], ranDeploy: false })
    )
    expect(api.local.start).toHaveBeenCalledWith(project.id)
    emitLocal({ state: 'starting', phase: 'analysis' })
    expect(preview().fallbackReason, 'the preview stays put while it checks').toContain(
      'Rayfin 1.40.0'
    )

    emitLocal({ state: 'running', ready: localReady })
    await waitFor(() => expect(preview().local?.state).toBe('running'))
    expect(preview().fallbackReason).toBeNull()
    expect(api.dev.stop).toHaveBeenCalledWith(project.id)
  })

  it('runs an unpublished app here even when it can’t fully, with nothing to fall back to', async () => {
    const api = installApi(true)
    const fresh = { ...project, lastDeploy: undefined }
    const state = { workspaceRoot: 'C:\\projects', activeProjectId: fresh.id, projects: [fresh] }
    api.projects.state.mockResolvedValue(state)
    api.deploy.reconcile.mockResolvedValue(state)
    nextLocal(project.id, tooNew)
    render(<Workbench {...makeProps({ settings: defaultSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    await waitFor(() => expect(api.local.start).toHaveBeenCalledTimes(1))
    expect(preview().local).toBeDefined()
    expect(preview().fallbackReason).toBeNull()
    expect(api.local.reportFallback).not.toHaveBeenCalled()
  })

  it('asks Help why the app didn’t start, opens setup, and remembers which app the preview shows', async () => {
    const { props } = await mountLocal()
    act(() => preview().onDiagnoseLocal?.())
    expect(helpProps.mock.lastCall?.[0].initialQuestion).toBe(LOCAL_QUESTION)
    act(() => helpProps.mock.lastCall?.[0].onClose())

    preview().onOpenSetup?.()
    expect(props.onReviewSetup).toHaveBeenCalledTimes(1)

    expect(preview().view).toBe('local')
    act(() => preview().onViewChange?.('published'))
    expect(preview().view).toBe('published')
  })

  it('lets the Power BI migration refresh the accounts after signing in there', async () => {
    const api = installApi(false)
    Object.assign(api, { migration: { onState: vi.fn(() => () => {}) } })
    const props = makeProps({
      settings: { theme: 'system', experiments: { reportMigration: true } }
    })
    render(<Workbench {...props} />, { wrapper: Wrapper })
    await screen.findByTestId('home')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const migrate = searchProps.mock.lastCall![0].items.find((item) => item.id === 'action:migrate')
    act(() => migrate!.run())
    expect(migrateProps.mock.lastCall?.[0].onSignedIn).toBe(props.onAuthChanged)
  })
})

describe('Workbench Advisor fixes', () => {
  const finding: AdvisorFinding = {
    id: 'quick:data-model/text-without-max',
    ruleId: 'data-model/text-without-max',
    category: 'data-model',
    severity: 'high',
    source: 'quick',
    title: 'Text field has no maximum length',
    detail: '`title` has no maximum length.',
    recommendation: 'Add `max` to the `@text` decorator.',
    file: 'rayfin/data/Todo.ts',
    line: 7
  }

  it('hands findings to the chat with a card that follows them and opens them in the Advisor', async () => {
    const api = installApi(true)
    const item = { finding, status: 'fixing' as const, isNew: false }
    advisorMock.derived = { badge: null, items: [item], open: [item], resolved: [] }
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    fireEvent.click(screen.getByRole('tab', { name: 'Advisor' }))
    await waitFor(() => expect(advisorProps).toHaveBeenCalled())
    act(() => advisorProps.mock.lastCall![0].onFix([finding]))

    const chat = chatProps.mock.lastCall![0]
    expect(chat.outbound).toMatchObject({
      display: 'Fix: Text field has no maximum length',
      advisor: { fixes: [expect.objectContaining({ id: finding.id, file: 'rayfin/data/Todo.ts', line: 7 })] }
    })
    expect(chat.outbound?.prompt).toContain('The Advisor flagged an issue in this app.')
    expect(advisorMock.handOff).toHaveBeenCalledWith([finding])
    expect(advisorMock.links?.outcome(finding.id)).toBe('fixing')

    // Re-running the message hands only the still-open findings off again.
    advisorMock.handOff.mockClear()
    const gone = { ...chat.outbound!.advisor!.fixes[0], id: 'quick:gone' }
    act(() => chat.onAdvisorRerun?.({ fixes: [...chat.outbound!.advisor!.fixes, gone] }))
    expect(advisorMock.handOff).toHaveBeenCalledWith([expect.objectContaining({ id: finding.id })])

    // The card and full prompt survive saving the transcript.
    const sentMessage = {
      id: 'u1',
      role: 'user' as const,
      text: chat.outbound!.display,
      tools: [],
      pending: false,
      advisor: chat.outbound!.advisor,
      prompt: chat.outbound!.prompt
    }
    act(() =>
      chat.onChange(() => [sentMessage, { id: 'a1', role: 'assistant', text: 'Done.', tools: [], pending: false }])
    )
    await act(async () => completeTurn())
    const saved = api.chat.saveHistory.mock.lastCall?.[1] as { advisor?: unknown; prompt?: string }[]
    expect(saved[0]).toMatchObject({ advisor: sentMessage.advisor, prompt: sentMessage.prompt })

    // A card's row opens its finding in the Advisor.
    act(() => advisorMock.links!.show(finding.id))
    expect(screen.getByRole('tab', { name: 'Advisor' }).getAttribute('aria-selected')).toBe('true')
    expect(advisorProps.mock.lastCall?.[0].openRequest).toMatchObject({ id: finding.id })
  })
})

describe('Workbench chat history', () => {
  it('keeps the Fabric data a message added when it saves the transcript', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    const data = [{ name: 'Ledger', type: 'SQLDatabase' as const, workspace: 'Finance analytics' }]
    act(() =>
      chatProps.mock.lastCall![0].onChange(() => [
        { id: 'u1', role: 'user', text: 'Chart spending', tools: [], pending: false, data, prompt: 'Chart spending + how to connect' },
        { id: 'a1', role: 'assistant', text: 'Done.', tools: [], pending: false }
      ])
    )
    await act(async () => completeTurn())
    const saved = api.chat.saveHistory.mock.lastCall?.[1] as { data?: unknown; prompt?: string }[]
    expect(saved[0]).toMatchObject({ data, prompt: 'Chart spending + how to connect' })
  })

  it('keeps the migration chip a message carried when it saves the transcript', async () => {
    const api = installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    const migration = { reportName: 'Sales', foundation: true, page: { index: 0, count: 3, name: 'Overview' } }
    act(() =>
      chatProps.mock.lastCall![0].onChange(() => [
        { id: 'u1', role: 'user', text: 'Migrate “Sales” from Power BI', tools: [], pending: false, migration, prompt: 'Migrate…' },
        { id: 'a1', role: 'assistant', text: 'Done.', tools: [], pending: false }
      ])
    )
    await act(async () => completeTurn())
    const saved = api.chat.saveHistory.mock.lastCall?.[1] as { migration?: unknown }[]
    expect(saved[0]).toMatchObject({ migration })
  })
})

describe('Workbench team workspaces', () => {
  const teamProject: StudioProject = {
    ...project,
    id: 't1',
    name: 'Team App',
    lastDeploy: undefined,
    team: {
      workspaceId: 'w1',
      folder: 'team-app',
      worktree: 'C:\\team\\team-app',
      branch: 'fabricator/octocat/team-app-20261003-120000'
    }
  }
  const teamSettings: AppSettings = { theme: 'system', experiments: { teamWorkspaces: true } }

  function installTeamApi() {
    const api = installApi(true)
    const state = {
      workspaceRoot: 'C:\\projects',
      activeProjectId: teamProject.id,
      projects: [teamProject],
      teamWorkspaces: [
        {
          id: 'w1',
          name: 'Sales team',
          repo: 'octo/sales-team',
          defaultBranch: 'main',
          dir: 'C:\\team',
          role: 'owner',
          addedAt: '2026-10-01T00:00:00Z'
        }
      ]
    }
    api.projects.state.mockResolvedValue(state)
    api.deploy.reconcile.mockResolvedValue(state)
    const team = {
      status: vi.fn().mockResolvedValue({
        ok: true,
        branch: teamProject.team?.branch,
        unpublished: 2,
        dirty: false,
        behind: 0,
        conflicted: false,
        requireReview: false,
        view: 'preview'
      }),
      sync: vi.fn().mockResolvedValue({ ok: true }),
      publish: vi.fn().mockResolvedValue({ ok: true }),
      onProgress: vi.fn(() => () => {})
    }
    ;(api as unknown as { team: typeof team }).team = team
    return { api, team }
  }

  it('saves a finished turn to the working branch instead of deploying locally', async () => {
    const { api, team } = installTeamApi()
    render(<Workbench {...makeProps({ settings: teamSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())

    expect(team.sync).toHaveBeenCalledWith('t1', '')
    expect(api.deploy.hasChanges).not.toHaveBeenCalled()
    expect(api.deploy.run).not.toHaveBeenCalled()
  })

  it('does not save an unsuccessful turn', async () => {
    const { team } = installTeamApi()
    render(<Workbench {...makeProps({ settings: teamSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn({ ok: false, error: 'Stopped', filesModified: [], ranDeploy: false }))

    expect(team.sync).not.toHaveBeenCalled()
  })

  it('saves a team app’s turns to its working branch, never as versions on this computer', async () => {
    const { api, team } = installTeamApi()
    const settings: AppSettings = {
      theme: 'system',
      experiments: { teamWorkspaces: true }
    }
    render(<Workbench {...makeProps({ settings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () =>
      completeTurn({ ok: true, filesModified: ['src/App.tsx'], ranDeploy: false })
    )

    expect(team.sync).toHaveBeenCalledWith('t1', '')
    expect(api.projects.git.saveTurn).not.toHaveBeenCalled()
  })

  it('still saves after each turn when the user deploys manually', async () => {
    const { api, team } = installTeamApi()
    const settings: AppSettings = { theme: 'system', experiments: { teamWorkspaces: true }, deployMode: 'manual' }
    render(<Workbench {...makeProps({ settings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    await act(async () => completeTurn())

    expect(team.sync).toHaveBeenCalledWith('t1', '')
    expect(api.deploy.run).not.toHaveBeenCalled()
    expect(deploymentsProps, 'team apps have no deployment panel, or its switch').not.toHaveBeenCalled()
  })

  it('keeps a team local preview while its saved turn waits for the pipeline', async () => {
    const { api, team } = installTeamApi()
    api.dev.plan.mockResolvedValue({ port: 5174 })
    render(<Workbench {...makeProps({ settings: teamSettings })} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    const { turn } = await beginTurn()
    await act(async () => turn)
    expect(api.dev.start).toHaveBeenCalledWith(teamProject.id, 5174)

    await act(async () => completeTurn())
    expect(team.sync).toHaveBeenCalledWith(teamProject.id, '')
    expect(api.dev.stop).not.toHaveBeenCalled()
    expect(previewProps.mock.lastCall?.[0].localPreviewUrl).toBe('http://localhost:5174')
    expect(api.deploy.run).not.toHaveBeenCalled()
  })

  it('replaces the deployments control with Publish', async () => {
    installTeamApi()
    const { container } = render(<Workbench {...makeProps({ settings: teamSettings })} />, {
      wrapper: Wrapper
    })
    await screen.findByLabelText('Chat draft')
    const bar = within(container.querySelector('header.app-bar') as HTMLElement)

    expect(bar.queryByRole('button', { name: 'Test deploy' })).toBeNull()
    expect(await bar.findByText('2 unpublished')).toBeTruthy()
    expect(bar.getByRole('button', { name: /^Workspace overview/ })).toBeTruthy()
  })

  it('publishes through the team pipeline', async () => {
    const { api, team } = installTeamApi()
    const { container } = render(<Workbench {...makeProps({ settings: teamSettings })} />, {
      wrapper: Wrapper
    })
    const bar = within(container.querySelector('header.app-bar') as HTMLElement)
    await bar.findByText('2 unpublished')

    await act(async () => {
      fireEvent.click(bar.getByRole('button', { name: 'Publish' }))
    })

    expect(team.publish).toHaveBeenCalledWith('t1', false)
    expect(api.deploy.run).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: 'Publish' })).toBeTruthy()
  })
})

describe('Workbench at launch', () => {
  it('is ready to be seen once its projects load, with none open', async () => {
    installApi(false)
    const onSettled = vi.fn()
    render(<Workbench {...makeProps({ onSettled })} />, { wrapper: Wrapper })
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
  })

  it('tells the launch screen which project it’s opening, once', async () => {
    const api = installApi(true)
    const onOpening = vi.fn()
    render(<Workbench {...makeProps({ onOpening })} />, { wrapper: Wrapper })
    await waitFor(() => expect(onOpening).toHaveBeenCalledWith('Project One'))
    await act(async () => previewProps.mock.lastCall?.[0].onPreviewModeChanged?.())
    expect(api.projects.state.mock.calls.length).toBeGreaterThan(1)
    expect(onOpening).toHaveBeenCalledTimes(1)
  })

  it('tells the launch screen it’s opening Home when no project is open', async () => {
    installApi(false)
    const onOpening = vi.fn()
    render(<Workbench {...makeProps({ onOpening })} />, { wrapper: Wrapper })
    await waitFor(() => expect(onOpening).toHaveBeenCalledWith(null))
  })

  it('waits for the open project’s chat and preview before it’s ready to be seen', async () => {
    const api = installApi(true)
    const history = deferred<never[]>()
    api.chat.history.mockReturnValueOnce(history.promise)
    const onSettled = vi.fn()
    render(<Workbench {...makeProps({ onSettled })} />, { wrapper: Wrapper })
    await waitFor(() => expect(previewProps).toHaveBeenCalled())
    expect(onSettled).not.toHaveBeenCalled()

    act(() => previewProps.mock.lastCall?.[0].onSettle?.())
    expect(onSettled, 'the chat is still loading').not.toHaveBeenCalled()
    await act(async () => history.resolve([]))
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('checks the accounts again when another project opens, not for the first one', async () => {
    const api = installApi(true)
    const props = makeProps()
    render(<Workbench {...props} />, { wrapper: Wrapper })
    await waitFor(() => expect(previewProps).toHaveBeenCalled())
    // The app checks every account as it starts; the first project adds nothing.
    expect(props.onAuthChanged).not.toHaveBeenCalled()

    const two: StudioProject = { ...project, id: 'p2', name: 'Project Two' }
    const switched = { workspaceRoot: 'C:\\projects', activeProjectId: two.id, projects: [project, two] }
    api.projects.state.mockResolvedValue(switched)
    api.deploy.reconcile.mockResolvedValue(switched)
    await act(async () => previewProps.mock.lastCall?.[0].onPreviewModeChanged?.())
    await waitFor(() => expect(props.onAuthChanged).toHaveBeenCalledTimes(1))
  })

  it('lists the projects once at launch, and again only when team workspaces are turned on or off', async () => {
    const api = installApi(false)
    ;(api as unknown as { team: unknown }).team = { onProgress: vi.fn(() => () => {}) }
    const props = makeProps()
    const view = render(<Workbench {...props} />, { wrapper: Wrapper })
    await waitFor(() => expect(api.projects.state).toHaveBeenCalledTimes(1))

    view.rerender(<Workbench {...props} settings={{ theme: 'system' }} />)
    await act(async () => {})
    expect(api.projects.state).toHaveBeenCalledTimes(1)

    view.rerender(
      <Workbench {...props} settings={{ theme: 'system', experiments: { teamWorkspaces: true } }} />
    )
    await waitFor(() => expect(api.projects.state).toHaveBeenCalledTimes(2))
  })
})

describe('Workbench search', () => {
  const search = (): ComponentProps<typeof Spotlight> => {
    const props = searchProps.mock.lastCall?.[0]
    if (!props) throw new Error('Search is not open')
    return props
  }

  it('opens Search with Ctrl+K or from the app bar, and leaves Ctrl+K to Search once open', async () => {
    installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeTruthy()
    // Inside Search, Ctrl+K lists the chosen result's actions; it doesn't close Search.
    const event = createEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent(window, event)
    expect(event.defaultPrevented).toBe(false)
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeTruthy()

    act(() => search().onClose())
    expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeTruthy()
  })

  it('leaves Ctrl+K alone while Help is open', async () => {
    installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')

    fireEvent.keyDown(window, { key: 'j', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.getByRole('dialog', { name: 'Help' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull()
  })

  it('runs what the app’s own controls do, such as showing every project', async () => {
    installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

    const home = search().items.find((item) => item.id === 'action:home')
    expect(search().items.some((item) => item.id === 'project:p1')).toBe(true)
    act(() => home!.run())
    expect(screen.getByTestId('home')).toBeTruthy()
  })

  it('carries a conversation started in Search on in Help', async () => {
    installApi(true)
    render(<Workbench {...makeProps()} />, { wrapper: Wrapper })
    await screen.findByLabelText('Chat draft')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(search().help.context).toMatchObject({ projectId: 'p1', surface: 'project' })

    act(() => search().help.onOpen())
    expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Help' })).toBeTruthy()
    expect(helpProps.mock.lastCall![0].continuing).toBe(true)
  })
})

describe('Workbench before the first publish', () => {
  const fresh: StudioProject = {
    id: 'p9',
    name: 'Fresh App',
    path: 'C:\\projects\\fresh-app',
    addedAt: '2026-10-01T00:00:00Z'
  }
  const opened = (project: StudioProject) => ({
    workspaceRoot: 'C:\\projects',
    activeProjectId: project.id,
    projects: [project]
  })

  /** Creates `created` from Search's New project, as the core creates it. */
  async function createApp(api: ReturnType<typeof installApi>, created: StudioProject) {
    const create = vi.fn(async () => {
      api.projects.state.mockResolvedValue(opened(created))
      api.deploy.reconcile.mockResolvedValue(opened(created))
      return { ok: true, project: created }
    })
    Object.assign(api.projects, { create, checkName: vi.fn().mockResolvedValue({ ok: true }) })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const newProject = searchProps.mock.lastCall![0].items.find(
      (item) => item.id === 'action:new-project'
    )
    act(() => newProject!.run())
    fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), {
      target: { value: created.name }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    })
    return create
  }

  it('opens a new app in the workbench as soon as it’s created', async () => {
    const api = installApi(false)
    render(<Workbench {...makeProps({ settings: defaultSettings })} />, { wrapper: Wrapper })
    await screen.findByTestId('home')
    const create = await createApp(api, fresh)

    await screen.findByLabelText('Chat draft')
    expect(create).toHaveBeenCalledTimes(1)
    expect(chatProps.mock.lastCall?.[0].project.id).toBe(fresh.id)
    expect(screen.queryByPlaceholderText('My Rayfin App')).toBeNull()
    expect(screen.queryByText('Publish your app')).toBeNull()
  })
})