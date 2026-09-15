import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AppUpdateInfo } from '@shared/ipc'
import { UpdateProvider, useUpdates } from './update'

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
  const { status, modalOpen, checkNow, later, install } = useUpdates()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="modal">{modalOpen ? 'open' : 'closed'}</span>
      <button onClick={() => void checkNow({ auto: true })}>check-auto</button>
      <button onClick={() => later()}>later</button>
      <button onClick={() => void install()}>install</button>
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
