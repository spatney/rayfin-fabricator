import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AppUpdateInfo } from '@shared/ipc'
import { RECHECK_MS, UpdateProvider, useUpdates } from './update'

import type { JSX } from 'react'

const updateInfo: AppUpdateInfo = {
  version: '2.0.0',
  currentVersion: '1.2.0',
  notes: 'Big new release'
}

/** Install the minimal `window.api.updates` surface the provider touches. */
function installApi(over: { download?: () => Promise<AppUpdateInfo | null> } = {}): {
  check: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
} {
  const check = vi.fn(() => Promise.resolve(updateInfo))
  const download = vi.fn(over.download ?? (() => Promise.resolve(updateInfo)))
  const install = vi.fn(() => Promise.resolve())
  ;(window as unknown as { api: unknown }).api = {
    updates: { check, download, install, onProgress: () => () => {} }
  }
  return { check, download, install }
}

// Surfaces the update context state and actions as DOM so tests can drive the
// optional startup flow without relying on the (dev-skipped) mount auto-check.
function Harness(): JSX.Element {
  const { status, modalOpen, checkNow, later, install, dismiss } = useUpdates()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="modal">{modalOpen ? 'open' : 'closed'}</span>
      <button onClick={() => void checkNow({ auto: true })}>check-auto</button>
      <button onClick={() => later()}>later</button>
      <button onClick={() => void install()}>install</button>
      <button onClick={() => dismiss()}>dismiss</button>
    </div>
  )
}

function renderHarness(): void {
  render(
    <UpdateProvider>
      <Harness />
    </UpdateProvider>
  )
}

afterEach(() => cleanup())

describe('UpdateProvider optional startup flow', () => {
  it('opens the modal once an auto check downloads a ready update', async () => {
    installApi()
    renderHarness()
    await act(async () => {
      fireEvent.click(screen.getByText('check-auto'))
    })
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))
    expect(screen.getByTestId('modal').textContent).toBe('open')
  })

  it('later() closes the modal but keeps the update ready for the banner', async () => {
    installApi()
    renderHarness()
    await act(async () => {
      fireEvent.click(screen.getByText('check-auto'))
    })
    await waitFor(() => expect(screen.getByTestId('modal').textContent).toBe('open'))
    await act(async () => {
      fireEvent.click(screen.getByText('later'))
    })
    expect(screen.getByTestId('modal').textContent).toBe('closed')
    expect(screen.getByTestId('status').textContent).toBe('ready')
  })

  it('does not auto-install a ready optional update (waits for the user)', async () => {
    const api = installApi()
    renderHarness()
    await act(async () => {
      fireEvent.click(screen.getByText('check-auto'))
    })
    await waitFor(() => expect(screen.getByTestId('modal').textContent).toBe('open'))
    expect(api.install).not.toHaveBeenCalled()
  })

  it('Update now installs the downloaded update', async () => {
    const api = installApi()
    renderHarness()
    await act(async () => {
      fireEvent.click(screen.getByText('check-auto'))
    })
    await waitFor(() => expect(screen.getByTestId('modal').textContent).toBe('open'))
    await act(async () => {
      fireEvent.click(screen.getByText('install'))
    })
    await waitFor(() => expect(api.install).toHaveBeenCalledTimes(1))
  })
})

describe('UpdateProvider while the app stays open', () => {
  const status = (): string | null => screen.getByTestId('status').textContent
  /** Let `ms` pass, and the checks and downloads it starts settle. */
  const pass = (ms = 0): Promise<void> =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  beforeEach(() => {
    vi.useFakeTimers()
    // Packaged builds check for updates; dev builds don't.
    vi.stubEnv('DEV', false)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('checks again every few hours, offering what it finds in the banner', async () => {
    const api = installApi()
    api.check.mockResolvedValueOnce(null)
    renderHarness()
    await pass()
    expect(status()).toBe('idle')

    await pass(RECHECK_MS)
    expect(api.check).toHaveBeenCalledTimes(2)
    expect(status()).toBe('ready')
    expect(screen.getByTestId('modal').textContent).toBe('closed')
  })

  it('tries again as soon as the connection comes back after a failed check', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = installApi()
    api.check.mockRejectedValueOnce(new Error('offline'))
    renderHarness()
    await pass()
    expect(status()).toBe('error')

    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await pass()
    expect(api.check).toHaveBeenCalledTimes(2)
    expect(status()).toBe('ready')
  })

  it('leaves an update alone while it waits, and once it is put off', async () => {
    const api = installApi()
    renderHarness()
    await pass()
    fireEvent.click(screen.getByText('later'))
    await pass(RECHECK_MS)
    expect(status()).toBe('ready')

    fireEvent.click(screen.getByText('dismiss'))
    await pass(RECHECK_MS)
    expect(api.check).toHaveBeenCalledTimes(1)
  })
})
