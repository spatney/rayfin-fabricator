import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  AppActionResult,
  AppProgressEvent,
  AppWindowInfo,
  InstalledApp,
  LocalLogEvent,
  LocalStatus
} from '@shared/ipc'
import AppWindow, { PROMPT_DELAY_MS } from './AppWindow'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'app-sales-1a2b3c4d' })
}))

const KEY = 'sales-1a2b3c4d'

function status(patch: Partial<LocalStatus> = {}): LocalStatus {
  return {
    projectId: KEY,
    state: 'stopped',
    revision: 1,
    warnings: [],
    crashes: 0,
    ...patch
  } as LocalStatus
}

const INSTALLED: InstalledApp = {
  key: KEY,
  name: 'Sales',
  version: '1.2.0',
  from: 'amy@contoso.com',
  exportedAt: '2026-10-03T10:00:00.000Z',
  installedAt: '2026-10-04T10:00:00.000Z',
  updatedAt: '2026-10-04T10:00:00.000Z',
  open: true
}

const FILE = {
  path: 'C:\\Users\\ben\\Downloads\\sales.rayfin',
  key: KEY,
  name: 'Sales',
  version: '1.3.0',
  from: 'amy@contoso.com',
  exportedAt: '2026-11-01T10:00:00.000Z',
  files: 214,
  bytes: 1_363_148,
  secrets: ['OPENAI_KEY']
}

function installApi(info: AppWindowInfo, run: AppActionResult = { ok: true }) {
  const listeners: {
    progress?: (event: AppProgressEvent) => void
    state?: (status: LocalStatus) => void
    log?: (line: LocalLogEvent) => void
    window?: (label: string) => void
  } = {}
  const apps = {
    window: vi.fn(() => Promise.resolve(info)),
    install: vi.fn((): Promise<AppActionResult> => Promise.resolve({ ok: true })),
    run: vi.fn(() => Promise.resolve(run)),
    logs: vi.fn(() =>
      Promise.resolve([
        {
          projectId: KEY,
          seq: 1,
          source: 'build',
          level: 'error',
          line: 'vite build failed',
          time: ''
        }
      ])
    ),
    close: vi.fn(() => Promise.resolve()),
    onProgress: vi.fn((cb: (event: AppProgressEvent) => void) => {
      listeners.progress = cb
      return () => {}
    }),
    onState: vi.fn((cb: (status: LocalStatus) => void) => {
      listeners.state = cb
      return () => {}
    }),
    onLog: vi.fn((cb: (line: LocalLogEvent) => void) => {
      listeners.log = cb
      return () => {}
    }),
    onWindow: vi.fn((cb: (label: string) => void) => {
      listeners.window = cb
      return () => {}
    })
  }
  const doctor = { install: vi.fn(() => Promise.resolve({ ok: true, exitCode: 0 })) }
  const relaunch = vi.fn()
  ;(window as unknown as { api: unknown }).api = { apps, doctor, relaunch }
  return { apps, doctor, relaunch, listeners }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

/** Let the install prompt's buttons work: they wait a moment after it shows. */
async function armPrompt(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PROMPT_DELAY_MS)
  })
}

describe('AppWindow', () => {
  it('asks before installing an app someone sent, then installs it and starts it', async () => {
    const api = installApi({ key: KEY, mode: 'install', file: FILE, status: status() })
    render(<AppWindow />)

    expect(await screen.findByRole('heading', { name: 'Sales' })).toBeTruthy()
    expect(screen.getByText('From amy@contoso.com · Version 1.3.0')).toBeTruthy()
    expect(screen.getByText('214 files · 1.3 MB')).toBeTruthy()
    expect(screen.getByText('OPENAI_KEY')).toBeTruthy()
    expect(screen.getByText(/Only install apps from people you trust/)).toBeTruthy()
    expect(api.apps.run).not.toHaveBeenCalled()
    expect(api.apps.install).not.toHaveBeenCalled()

    await armPrompt()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    })
    expect(api.apps.install).toHaveBeenCalledTimes(1)
    expect(api.apps.run).toHaveBeenCalledTimes(1)

    act(() =>
      api.listeners.progress?.({
        key: KEY,
        phase: 'packages',
        processed: 0,
        total: 0,
        line: 'added 1021 packages'
      })
    )
    expect(screen.getByRole('status').textContent).toContain('Getting Sales ready…')
    expect(screen.getByText('added 1021 packages')).toBeTruthy()
    act(() => api.listeners.state?.(status({ state: 'starting' })))
    act(() =>
      api.listeners.log?.({
        projectId: KEY,
        seq: 2,
        source: 'build',
        level: 'info',
        line: '✓ built in 2.18s',
        time: ''
      })
    )
    expect(screen.getByRole('status').textContent).toContain('Building Sales…')
    // Another app's progress isn't this one's.
    act(() =>
      api.listeners.log?.({
        projectId: 'other-12345678',
        seq: 3,
        source: 'build',
        level: 'info',
        line: 'nope',
        time: ''
      })
    )
    expect(screen.queryByText('nope')).toBeNull()
  })

  it('won’t install from a keystroke or click meant for another window', async () => {
    const api = installApi({ key: KEY, mode: 'install', file: FILE, status: status() })
    render(<AppWindow />)

    const install = (await screen.findByRole('button', { name: 'Install' })) as HTMLButtonElement
    expect(install.disabled).toBe(true)
    expect(document.activeElement).not.toBe(install)
    fireEvent.click(install)
    expect(api.apps.install).not.toHaveBeenCalled()

    await armPrompt()
    expect(install.disabled).toBe(false)
    // Coming back to the front waits again.
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(install.disabled).toBe(true)
    await armPrompt()
    expect(install.disabled).toBe(false)
  })

  it('shows unpacking progress while it installs', async () => {
    const api = installApi({ key: KEY, mode: 'install', file: FILE, status: status() })
    api.apps.install.mockReturnValue(new Promise(() => {}))
    render(<AppWindow />)
    await screen.findByRole('button', { name: 'Install' })
    await armPrompt()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    act(() =>
      api.listeners.progress?.({ key: KEY, phase: 'unpacking', processed: 120, total: 214 })
    )
    expect(screen.getByRole('progressbar', { name: 'Install progress' })).toBeTruthy()
    expect(screen.getByText('120 of 214 files')).toBeTruthy()
  })

  it('starts an installed app at once', async () => {
    const api = installApi({ key: KEY, mode: 'run', installed: INSTALLED, status: status() })
    render(<AppWindow />)
    expect(await screen.findByText('Starting Sales…')).toBeTruthy()
    expect(api.apps.run).toHaveBeenCalledTimes(1)
  })

  it('updates an installed app, or runs the version installed', async () => {
    const api = installApi({
      key: KEY,
      mode: 'update',
      file: FILE,
      installed: INSTALLED,
      status: status()
    })
    render(<AppWindow />)
    expect((await screen.findByText(/Sales is installed/)).textContent).toContain(
      'Updating replaces the app and keeps its data.'
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open the installed one' }))
    })
    expect(api.apps.run).toHaveBeenCalledTimes(1)
    expect(api.apps.install).not.toHaveBeenCalled()
  })

  it('says why the app stopped, with its output, and tries again', async () => {
    const problem = {
      code: 'internal',
      message: 'Could not build the app for --static',
      hint: 'Check its build.',
      fatal: true,
      details: null,
      time: null
    }
    const api = installApi({
      key: KEY,
      mode: 'run',
      installed: INSTALLED,
      status: status({ state: 'error', error: problem })
    })
    render(<AppWindow />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Sales didn’t start')
    expect(alert.textContent).toContain('Could not build the app for --static')
    expect(alert.textContent).toContain('Check its build.')
    expect(api.apps.run).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    })
    expect(screen.getByLabelText('Details').textContent).toContain('vite build failed')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    })
    expect(api.apps.run).toHaveBeenCalledTimes(1)
  })

  it('installs Node.js when the app needs it, then starts the app', async () => {
    const api = installApi(
      { key: KEY, mode: 'run', installed: INSTALLED, status: status() },
      {
        ok: false,
        code: 'node-missing',
        error: 'This app runs on Node.js, which isn’t installed on this computer.'
      }
    )
    render(<AppWindow />)

    expect((await screen.findByRole('alert')).textContent).toContain('This app needs Node.js')
    api.apps.run.mockResolvedValue({ ok: true })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install Node.js' }))
    })
    expect(api.doctor.install).toHaveBeenCalledWith('node')
    expect(api.apps.run).toHaveBeenCalledTimes(2)
  })

  it('offers a restart when the installed Node.js needs one', async () => {
    const api = installApi(
      { key: KEY, mode: 'run', installed: INSTALLED, status: status() },
      { ok: false, code: 'node-missing', error: 'This app runs on Node.js.' }
    )
    api.doctor.install.mockResolvedValue({ ok: true, exitCode: 0, requiresRelaunch: true } as never)
    render(<AppWindow />)

    const install = await screen.findByRole('button', { name: 'Install Node.js' })
    await act(async () => {
      fireEvent.click(install)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(api.relaunch).toHaveBeenCalledTimes(1)
  })

  it('says why a file can’t be opened, and closes', async () => {
    const api = installApi({
      key: '',
      mode: 'error',
      error: 'This app file is damaged. Ask for it to be exported again.',
      status: status({ projectId: '' })
    })
    render(<AppWindow />)

    expect((await screen.findByRole('alert')).textContent).toContain('This app file is damaged')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(api.apps.close).toHaveBeenCalledTimes(1)
  })

  it('looks again when Fabricator asks this window to', async () => {
    const api = installApi({ key: KEY, mode: 'run', installed: INSTALLED, status: status() })
    render(<AppWindow />)
    await screen.findByText('Starting Sales…')

    api.apps.window.mockResolvedValue({
      key: KEY,
      mode: 'update',
      file: FILE,
      installed: INSTALLED,
      status: status()
    })
    await act(async () => api.listeners.window?.('app-other-12345678'))
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    await act(async () => api.listeners.window?.('app-sales-1a2b3c4d'))
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy()
  })
})
