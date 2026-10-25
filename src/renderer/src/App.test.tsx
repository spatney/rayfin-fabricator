import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AuthProvider, AuthStatus, DoctorReport } from '@shared/ipc'
import type { SetupAttention } from './startup'
import { ToastProvider } from './toast'
import { deferred } from '../test/deferred'
import App, { resetStartupRecordForTests } from './App'

vi.mock('./update', () => ({ useUpdates: () => ({ blocking: null }) }))
vi.mock('./theme', () => ({
  applyUiScale: vi.fn(),
  watchTheme: () => () => {}
}))
vi.mock('./components/UpdateBanner', () => ({ default: () => null }))
vi.mock('./components/UpdateModal', () => ({ default: () => null }))
vi.mock('./components/ForcedUpdateScreen', () => ({ default: () => null }))
vi.mock('./components/SplashScreen', () => ({
  default: ({
    stage,
    launch,
    opening,
    leaving
  }: {
    stage?: string
    launch?: boolean
    opening?: string | null
    leaving?: boolean
  }) => (
    <div
      data-testid="splash"
      data-stage={stage}
      data-launch={String(Boolean(launch))}
      data-opening={String(opening)}
      data-leaving={String(Boolean(leaving))}
    >
      Splash
    </div>
  )
}))
vi.mock('./screens/SetupScreen', () => ({
  default: ({
    auth,
    doctor,
    error,
    refreshing,
    onRefresh,
    onEnter,
    onBack
  }: {
    auth: AuthStatus | null
    doctor: DoctorReport | null
    error?: string
    refreshing: boolean
    onRefresh: () => Promise<void>
    onEnter: () => void
    onBack?: () => void
  }) => (
    <div data-testid="setup">
      <output data-testid="copilot">{String(auth?.copilot.signedIn ?? false)}</output>
      <output data-testid="azure">{String(auth?.az.signedIn ?? false)}</output>
      <output data-testid="doctor">{String(doctor?.ready ?? false)}</output>
      <output data-testid="refreshing">{String(refreshing)}</output>
      {error && <div role="alert">{error}</div>}
      <button onClick={() => void onRefresh()}>Refresh setup</button>
      <button onClick={onEnter}>Enter</button>
      {onBack && <button onClick={onBack}>Back</button>}
    </div>
  )
}))
vi.mock('./screens/Workbench', () => ({
  default: ({
    auth,
    attention,
    onAuthChanged,
    onReviewSetup,
    onSettled,
    onOpening
  }: {
    auth: AuthStatus
    attention?: SetupAttention | null
    onAuthChanged: () => Promise<void>
    onReviewSetup: () => void
    onSettled?: () => void
    onOpening?: (projectName: string | null) => void
  }) => {
    const [draft, setDraft] = useState('')
    const [error, setError] = useState('')
    const state = (s: { signedIn: boolean; checking?: boolean }): string =>
      s.checking ? 'checking' : String(s.signedIn)
    return (
      <div data-testid="workbench">
        <output data-testid="copilot">{state(auth.copilot)}</output>
        <output data-testid="azure">{state(auth.az)}</output>
        <output data-testid="fabric">{state(auth.rayfin)}</output>
        <output data-testid="attention">{attention ? JSON.stringify(attention) : 'none'}</output>
        <textarea aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button onClick={() => void onAuthChanged().catch((e: Error) => setError(e.message))}>
          Refresh accounts
        </button>
        <button onClick={onReviewSetup}>Review setup</button>
        <button onClick={() => onSettled?.()}>Workbench ready</button>
        <button onClick={() => onOpening?.('lead-tracker')}>Workbench opening</button>
        {error && <div role="alert">{error}</div>}
      </div>
    )
  }
}))

const SETUP_DONE = 'fabricator.setupComplete'
const readyDoctor: DoctorReport = { ready: true, tools: [] }
const missingNode: DoctorReport = {
  ready: false,
  tools: [
    {
      id: 'node',
      name: 'Node.js',
      found: false,
      satisfied: false,
      version: null,
      installHint: 'Install Node.js 20 or newer (includes npm).',
      autoInstallable: true,
      required: true
    }
  ]
}
const signedIn: AuthStatus = {
  copilot: { signedIn: true, user: 'octocat' },
  rayfin: { signedIn: true, user: 'dev@example.com' },
  az: { signedIn: true, user: 'dev@example.com' }
}

/** What `auth.check(providers)` returns for `from`. */
function pick(providers: AuthProvider[], from: AuthStatus = signedIn): Partial<AuthStatus> {
  return Object.fromEntries(providers.map((p) => [p, from[p]]))
}

type Check = (providers: AuthProvider[]) => Promise<Partial<AuthStatus>>

function installApi() {
  const api = {
    doctor: { check: vi.fn().mockResolvedValue(readyDoctor) },
    auth: {
      status: vi.fn().mockResolvedValue(signedIn),
      check: vi.fn<Check>((providers) => Promise.resolve(pick(providers)))
    },
    settings: { get: vi.fn().mockResolvedValue(null) },
    diagnostics: { record: vi.fn().mockResolvedValue(undefined) }
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

/** Answer the setup sign-ins check (Copilot + Azure CLI) with each of `answers` in turn. */
function answerSetupChecks(
  api: ReturnType<typeof installApi>,
  ...answers: Array<() => Promise<Partial<AuthStatus>>>
): void {
  api.auth.check.mockImplementation((providers) =>
    providers.includes('copilot')
      ? (answers.shift() ?? (() => Promise.resolve(pick(providers))))()
      : Promise.resolve(pick(providers))
  )
}

async function finishSplash(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500)
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** The launch screen (or first-run splash) as it covers the app: 'up', 'leaving' or 'gone'. */
function curtain(): 'up' | 'leaving' | 'gone' {
  const splash = screen.queryByTestId('splash')
  if (!splash) return 'gone'
  return splash.parentElement?.classList.contains('launch-curtain--leaving') ? 'leaving' : 'up'
}

/** Its fade-out, from the moment it starts to lift (LAUNCH_FADE_MS). */
const FADE_MS = 450

async function settle(): Promise<void> {
  await act(async () => {})
}

function renderApp(): void {
  render(
    <ToastProvider>
      <App />
    </ToastProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  resetStartupRecordForTests()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('App startup', () => {
  it('has Ray narrate the checks on the splash', async () => {
    installApi()
    renderApp()
    const splash = (): HTMLElement => screen.getByTestId('splash')
    expect(splash().dataset.stage).toBe('tools')
    await settle()
    expect(splash().dataset.stage).toBe('ready')
  })

  it('opens the app without the checklist when everything is ready at first launch', async () => {
    const api = installApi()
    renderApp()
    expect(screen.getByTestId('splash')).toBeTruthy()
    await finishSplash()

    expect(screen.getByTestId('workbench')).toBeTruthy()
    expect(localStorage.getItem(SETUP_DONE)).toBe('1')
    // Setup waits only on the sign-ins it shows; the slower Fabric check runs alongside.
    expect(api.auth.check).toHaveBeenCalledWith(['copilot', 'az'])
    expect(api.auth.check).toHaveBeenCalledWith(['rayfin'])
    expect(api.auth.status).not.toHaveBeenCalled()
  })

  it('opens straight into the app once setup has passed, verifying in the background', async () => {
    localStorage.setItem(SETUP_DONE, '1')
    const api = installApi()
    const setupSignIns = deferred<Partial<AuthStatus>>()
    answerSetupChecks(api, () => setupSignIns.promise)
    renderApp()

    // No checklist: the app loads at once, under the short launch screen.
    expect(screen.getByTestId('splash').dataset.launch).toBe('true')
    expect(screen.getByTestId('workbench')).toBeTruthy()
    expect(screen.getByTestId('copilot').textContent).toBe('checking')
    await settle()
    expect(screen.getByTestId('fabric').textContent).toBe('true')
    expect(screen.getByTestId('copilot').textContent).toBe('checking')
    expect(screen.getByTestId('attention').textContent).toBe('none')

    await act(async () => setupSignIns.resolve(pick(['copilot', 'az'])))
    expect(screen.getByTestId('copilot').textContent).toBe('true')
    expect(screen.getByTestId('azure').textContent).toBe('true')
    expect(screen.getByTestId('attention').textContent).toBe('none')
    expect(api.doctor.check).toHaveBeenCalledTimes(1)
  })

  it('raises what the background check finds without leaving the app', async () => {
    localStorage.setItem(SETUP_DONE, '1')
    const api = installApi()
    api.doctor.check.mockResolvedValue(missingNode)
    answerSetupChecks(api, () =>
      Promise.resolve(pick(['copilot', 'az'], { ...signedIn, copilot: { signedIn: false } }))
    )
    renderApp()
    await settle()

    expect(screen.getByTestId('workbench')).toBeTruthy()
    expect(JSON.parse(screen.getByTestId('attention').textContent ?? '')).toEqual({
      tools: ['Node.js'],
      signIns: ['GitHub Copilot']
    })
  })

  it('reviews setup from the app and can come back without finishing it', async () => {
    localStorage.setItem(SETUP_DONE, '1')
    const api = installApi()
    api.doctor.check.mockResolvedValue(missingNode)
    renderApp()
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Review setup' }))
    await settle()
    expect(screen.getByTestId('setup')).toBeTruthy()
    expect(api.doctor.check).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByTestId('workbench')).toBeTruthy()
  })

  it('shows setup at first launch until everything is ready, then waits for Enter', async () => {
    const api = installApi()
    answerSetupChecks(api, () =>
      Promise.resolve(pick(['copilot', 'az'], { ...signedIn, az: { signedIn: false } }))
    )
    renderApp()
    await finishSplash()
    expect(screen.getByTestId('setup')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()

    // Signing in during setup re-checks, but never leaves setup by itself.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh setup' })))
    expect(screen.getByTestId('setup')).toBeTruthy()
    expect(screen.getByTestId('azure').textContent).toBe('true')
    expect(localStorage.getItem(SETUP_DONE)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
    expect(screen.getByTestId('workbench')).toBeTruthy()
    expect(localStorage.getItem(SETUP_DONE)).toBe('1')
  })
})

describe('App authentication orchestration', () => {
  it('leaves the splash with explicit feedback when the startup auth check rejects', async () => {
    const api = installApi()
    answerSetupChecks(api, () => Promise.reject('Authentication bridge unavailable'))
    renderApp()
    await finishSplash()
    // The splash fades into setup.
    await advance(0)
    await advance(FADE_MS)

    expect(screen.queryByTestId('splash')).toBeNull()
    expect(screen.getByTestId('setup')).toBeTruthy()
    expect(screen.getByTestId('doctor').textContent).toBe('true')
    expect(screen.getByTestId('copilot').textContent).toBe('false')
    expect(screen.getByTestId('azure').textContent).toBe('false')
    expect(screen.getByTestId('refreshing').textContent).toBe('false')
    expect(screen.getByRole('alert').textContent).toContain('Authentication bridge unavailable')

    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
    expect(screen.queryByTestId('workbench')).toBeNull()
  })

  it('keeps auth results but blocks entry when the tool check fails', async () => {
    const api = installApi()
    api.doctor.check.mockRejectedValueOnce(new Error('Tool check unavailable'))
    renderApp()
    await finishSplash()

    expect(screen.getByTestId('doctor').textContent).toBe('false')
    expect(screen.getByTestId('copilot').textContent).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('Tool check unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
    expect(screen.queryByTestId('workbench')).toBeNull()
  })

  it('reports settings failures without stranding startup', async () => {
    const api = installApi()
    api.settings.get.mockRejectedValueOnce('Settings unavailable on disk')
    renderApp()
    await finishSplash()

    expect(screen.getByTestId('workbench')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Settings unavailable on disk')
  })

  it('does not let an older setup success overwrite a newer failed check', async () => {
    const api = installApi()
    api.doctor.check.mockResolvedValue(missingNode)
    renderApp()
    await finishSplash()
    const older = deferred<Partial<AuthStatus>>()
    answerSetupChecks(
      api,
      () => older.promise,
      () => Promise.reject(new Error('Latest verification failed'))
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh setup' }))
      fireEvent.click(screen.getByRole('button', { name: 'Refresh setup' }))
    })
    expect(screen.getByTestId('copilot').textContent).toBe('false')
    await act(async () => older.resolve(pick(['copilot', 'az'])))
    expect(screen.getByTestId('copilot').textContent).toBe('false')
    expect(screen.getByRole('alert').textContent).toContain('Latest verification failed')
  })

  it('clears stale auth on refresh failure without unmounting the workbench or its draft', async () => {
    const api = installApi()
    renderApp()
    await finishSplash()
    const input = screen.getByLabelText('Draft') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Keep this unsent prompt' } })
    api.auth.status.mockRejectedValueOnce('Sign-in verification disconnected')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh accounts' })))

    expect(screen.getByLabelText('Draft')).toBe(input)
    expect(input.value).toBe('Keep this unsent prompt')
    expect(screen.getByTestId('copilot').textContent).toBe('false')
    expect(screen.getByTestId('azure').textContent).toBe('false')
    expect(screen.getByTestId('fabric').textContent).toBe('false')
    expect(screen.getByRole('alert').textContent).toContain('Sign-in verification disconnected')
    expect(screen.queryByTestId('setup')).toBeNull()
    expect(api.doctor.check).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale auth-only success after a newer failed verification', async () => {
    const api = installApi()
    renderApp()
    await finishSplash()
    const older = deferred<AuthStatus>()
    api.auth.status
      .mockReturnValueOnce(older.promise)
      .mockRejectedValueOnce(new Error('New account check failed'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh accounts' }))
      fireEvent.click(screen.getByRole('button', { name: 'Refresh accounts' }))
    })
    await act(async () => older.resolve(signedIn))
    expect(screen.getByTestId('copilot').textContent).toBe('false')
    expect(screen.queryByTestId('setup')).toBeNull()
  })

  it('cancels stale startup effects under StrictMode', async () => {
    const api = installApi()
    const older = deferred<Partial<AuthStatus>>()
    answerSetupChecks(
      api,
      () => older.promise,
      () => Promise.reject(new Error('Current startup failed'))
    )
    render(
      <StrictMode>
        <ToastProvider>
          <App />
        </ToastProvider>
      </StrictMode>
    )
    await finishSplash()
    await act(async () => older.resolve(pick(['copilot', 'az'])))

    expect(screen.getByTestId('copilot').textContent).toBe('false')
    expect(screen.getByRole('alert').textContent).toContain('Current startup failed')
    expect(screen.queryByTestId('workbench')).toBeNull()
  })
})

describe('the launch screen', () => {
  it('covers the app while it loads, for at least Ray’s hello, then fades away', async () => {
    localStorage.setItem(SETUP_DONE, '1')
    installApi()
    renderApp()
    expect(curtain()).toBe('up')

    // The app underneath is ready early; Ray still gets to say hello.
    await advance(200)
    fireEvent.click(screen.getByRole('button', { name: 'Workbench ready' }))
    await advance(1299)
    expect(curtain()).toBe('up')
    await advance(1)
    expect(curtain()).toBe('leaving')
    await advance(FADE_MS)
    expect(curtain()).toBe('gone')
    expect(screen.getByTestId('workbench')).toBeTruthy()
  })

  it('says which project it’s opening, and tells Ray when to swim off', async () => {
    localStorage.setItem(SETUP_DONE, '1')
    installApi()
    renderApp()
    const splash = (): HTMLElement => screen.getByTestId('splash')
    expect(splash().dataset.opening).toBe('undefined')

    fireEvent.click(screen.getByRole('button', { name: 'Workbench opening' }))
    expect(splash().dataset.opening).toBe('lead-tracker')
    expect(splash().dataset.leaving).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Workbench ready' }))
    await advance(1500)
    expect(splash().dataset.leaving).toBe('true')
  })

  it('waits for a slow app only a grace period longer', async () => {
    localStorage.setItem(SETUP_DONE, '1')
    installApi()
    renderApp()

    await advance(2499)
    expect(curtain()).toBe('up')
    await advance(1)
    expect(curtain()).toBe('leaving')
    await advance(FADE_MS)
    expect(curtain()).toBe('gone')
  })

  it('lifts as soon as a slow app is ready after Ray’s hello', async () => {
    localStorage.setItem(SETUP_DONE, '1')
    installApi()
    renderApp()

    await advance(1800)
    expect(curtain()).toBe('up')
    fireEvent.click(screen.getByRole('button', { name: 'Workbench ready' }))
    await advance(0)
    expect(curtain()).toBe('leaving')
  })

  it('fades the first-run splash into setup once its showtime is up', async () => {
    const api = installApi()
    answerSetupChecks(api, () =>
      Promise.resolve(pick(['copilot', 'az'], { ...signedIn, az: { signedIn: false } }))
    )
    renderApp()
    expect(screen.getByTestId('splash').dataset.launch).toBe('false')
    await advance(2499)
    expect(screen.queryByTestId('setup')).toBeNull()

    await advance(1)
    expect(screen.getByTestId('setup')).toBeTruthy()
    await advance(0)
    expect(curtain()).toBe('leaving')
    await advance(FADE_MS)
    expect(curtain()).toBe('gone')
  })
})

describe('what startup puts in the activity journal', () => {
  // Help reads the journal to answer "is anything wrong?". Without a marker
  // saying everything was fine at launch, the newest entry is whatever failed
  // last — possibly days ago — and it gets reported as a live problem.
  it('records that the app started ready', async () => {
    localStorage.setItem(SETUP_DONE, '1')
    const api = installApi()
    renderApp()
    await settle()

    expect(api.diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', event: 'app.ready' })
    )
  })

  it('records a warning naming how many tools are still missing', async () => {
    localStorage.setItem(SETUP_DONE, '1')
    const api = installApi()
    api.doctor.check.mockResolvedValue(missingNode)
    renderApp()
    await settle()

    expect(api.diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        event: 'app.setup_needed',
        message: expect.stringContaining('1 tool(s)')
      })
    )
  })

  it('writes one line per launch, not one per mount', async () => {
    const api = installApi()
    renderApp()
    await finishSplash()
    cleanup()
    renderApp()
    await settle()

    const startups = api.diagnostics.record.mock.calls.filter(([r]) =>
      String(r.event).startsWith('app.')
    )
    expect(startups).toHaveLength(1)
  })
})
