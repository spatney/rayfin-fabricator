import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AuthStatus, DoctorReport } from '@shared/ipc'
import { ToastProvider } from './toast'
import { deferred } from '../test/deferred'
import App from './App'

vi.mock('./update', () => ({ useUpdates: () => ({ blocking: null }) }))
vi.mock('./theme', () => ({
  applyUiScale: vi.fn(),
  watchTheme: () => () => {}
}))
vi.mock('./components/UpdateBanner', () => ({ default: () => null }))
vi.mock('./components/UpdateModal', () => ({ default: () => null }))
vi.mock('./components/ForcedUpdateScreen', () => ({ default: () => null }))
vi.mock('./components/SplashScreen', () => ({
  default: () => <div data-testid="splash">Splash</div>
}))
vi.mock('./screens/SetupScreen', () => ({
  default: ({
    auth,
    doctor,
    error,
    refreshing,
    onRefresh,
    onEnter
  }: {
    auth: AuthStatus | null
    doctor: DoctorReport | null
    error?: string
    refreshing: boolean
    onRefresh: () => Promise<void>
    onEnter: () => void
  }) => (
    <div data-testid="setup">
      <output data-testid="copilot">{String(auth?.copilot.signedIn ?? false)}</output>
      <output data-testid="azure">{String(auth?.az.signedIn ?? false)}</output>
      <output data-testid="doctor">{String(doctor?.ready ?? false)}</output>
      <output data-testid="refreshing">{String(refreshing)}</output>
      {error && <div role="alert">{error}</div>}
      <button onClick={() => void onRefresh()}>Refresh setup</button>
      <button onClick={onEnter}>Enter</button>
    </div>
  )
}))
vi.mock('./screens/Workbench', () => ({
  default: ({ auth, onAuthChanged }: { auth: AuthStatus; onAuthChanged: () => Promise<void> }) => {
    const [draft, setDraft] = useState('')
    const [error, setError] = useState('')
    return (
      <div data-testid="workbench">
        <output data-testid="copilot">{String(auth.copilot.signedIn)}</output>
        <output data-testid="azure">{String(auth.az.signedIn)}</output>
        <textarea aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button onClick={() => void onAuthChanged().catch((e: Error) => setError(e.message))}>
          Refresh accounts
        </button>
        {error && <div role="alert">{error}</div>}
      </div>
    )
  }
}))

const readyDoctor: DoctorReport = { ready: true, tools: [] }
const signedIn: AuthStatus = {
  copilot: { signedIn: true, user: 'octocat' },
  rayfin: { signedIn: true, user: 'dev@example.com' },
  az: { signedIn: true, user: 'dev@example.com' }
}

function installApi() {
  const api = {
    doctor: { check: vi.fn().mockResolvedValue(readyDoctor) },
    auth: { status: vi.fn().mockResolvedValue(signedIn) },
    settings: { get: vi.fn().mockResolvedValue(null) }
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

async function finishSplash(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500)
  })
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
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('App authentication orchestration', () => {
  it('leaves the splash with explicit feedback when the startup auth check rejects', async () => {
    const api = installApi()
    api.auth.status.mockRejectedValueOnce('Authentication bridge unavailable')
    renderApp()
    await finishSplash()

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

    expect(screen.getByTestId('setup')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Settings unavailable on disk')
  })

  it('always waits for explicit entry, including after a successful recheck', async () => {
    installApi()
    renderApp()
    await finishSplash()
    expect(screen.queryByTestId('workbench')).toBeNull()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh setup' })))
    expect(screen.getByTestId('setup')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
    expect(screen.getByTestId('workbench')).toBeTruthy()
  })

  it('does not let an older setup success overwrite a newer failed check', async () => {
    const api = installApi()
    renderApp()
    await finishSplash()
    const older = deferred<AuthStatus>()
    api.auth.status
      .mockReturnValueOnce(older.promise)
      .mockRejectedValueOnce(new Error('Latest verification failed'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh setup' }))
      fireEvent.click(screen.getByRole('button', { name: 'Refresh setup' }))
    })
    expect(screen.getByTestId('copilot').textContent).toBe('false')
    await act(async () => older.resolve(signedIn))
    expect(screen.getByTestId('copilot').textContent).toBe('false')
    expect(screen.getByRole('alert').textContent).toContain('Latest verification failed')
  })

  it('clears stale auth on refresh failure without unmounting the workbench or its draft', async () => {
    const api = installApi()
    renderApp()
    await finishSplash()
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
    const input = screen.getByLabelText('Draft') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Keep this unsent prompt' } })
    api.auth.status.mockRejectedValueOnce('Sign-in verification disconnected')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh accounts' })))

    expect(screen.getByLabelText('Draft')).toBe(input)
    expect(input.value).toBe('Keep this unsent prompt')
    expect(screen.getByTestId('copilot').textContent).toBe('false')
    expect(screen.getByTestId('azure').textContent).toBe('false')
    expect(screen.getByRole('alert').textContent).toContain('Sign-in verification disconnected')
    expect(screen.queryByTestId('setup')).toBeNull()
    expect(api.doctor.check).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale auth-only success after a newer failed verification', async () => {
    const api = installApi()
    renderApp()
    await finishSplash()
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
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
    const older = deferred<AuthStatus>()
    api.auth.status
      .mockReturnValueOnce(older.promise)
      .mockRejectedValueOnce(new Error('Current startup failed'))
    render(
      <StrictMode>
        <ToastProvider>
          <App />
        </ToastProvider>
      </StrictMode>
    )
    await finishSplash()
    await act(async () => older.resolve(signedIn))

    expect(screen.getByTestId('copilot').textContent).toBe('false')
    expect(screen.getByRole('alert').textContent).toContain('Current startup failed')
    expect(screen.queryByTestId('workbench')).toBeNull()
  })
})
