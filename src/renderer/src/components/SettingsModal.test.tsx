import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AppSettings } from '@shared/ipc'

// SettingsModal reads update status from an UpdateProvider-backed context and
// starts an auto-check on mount. Stub the module so the modal renders in
// isolation without the updater machinery (and without needing the provider).
vi.mock('../update', () => ({
  useUpdates: () => ({ status: 'idle', info: null, checkNow: vi.fn() }),
  UpdateProvider: ({ children }: { children?: unknown }) => children
}))

import SettingsModal from './SettingsModal'

/** Install the minimal `window.api` surface SettingsModal touches. */
function installApi(exportImpl?: () => Promise<string>): {
  export: ReturnType<typeof vi.fn>
  openLogs: ReturnType<typeof vi.fn>
} {
  const exportFn = vi.fn(exportImpl ?? (() => Promise.resolve('C:/logs/bundle.md')))
  const openLogs = vi.fn(() => Promise.resolve('C:/logs'))
  ;(window as unknown as { api: unknown }).api = {
    projects: {
      state: vi.fn(() =>
        Promise.resolve({ workspaceRoot: 'C:/ws', activeProjectId: null, projects: [] })
      )
    },
    diagnostics: { export: exportFn },
    openLogs
  }
  return { export: exportFn, openLogs }
}

const settings: AppSettings = { theme: 'system' }

/** The Full-diagnostics checkbox, resolved via its wrapping ToggleRow label. */
function fullDiagnosticsCheckbox(): HTMLInputElement {
  const label = screen.getByText('Full diagnostics').closest('label')
  if (!label) throw new Error('Full diagnostics label not found')
  const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null
  if (!cb) throw new Error('Full diagnostics checkbox not found')
  return cb
}

async function renderModal(over: Partial<Parameters<typeof SettingsModal>[0]> = {}): Promise<{
  onChange: ReturnType<typeof vi.fn>
}> {
  const onChange = vi.fn()
  await act(async () => {
    render(
      <SettingsModal
        settings={settings}
        versions={null}
        onChange={onChange}
        onClose={() => {}}
        {...over}
      />
    )
  })
  return { onChange }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('SettingsModal diagnostics', () => {
  it('renders the Full diagnostics toggle plus Export and Open-logs buttons', async () => {
    installApi()
    await renderModal()
    expect(screen.getByText('Full diagnostics')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export diagnostics' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open logs folder' })).toBeTruthy()
  })

  it('reflects the persisted fullDiagnostics flag', async () => {
    installApi()
    await renderModal({ settings: { theme: 'system', fullDiagnostics: true } })
    expect(fullDiagnosticsCheckbox().checked).toBe(true)
  })

  it('is off by default (metadata-only capture)', async () => {
    installApi()
    await renderModal()
    expect(fullDiagnosticsCheckbox().checked).toBe(false)
  })

  it('persists a fullDiagnostics change via onChange', async () => {
    installApi()
    const { onChange } = await renderModal()
    fireEvent.click(fullDiagnosticsCheckbox())
    expect(onChange).toHaveBeenCalledWith({ fullDiagnostics: true })
  })

  it('exports diagnostics when the Export button is clicked', async () => {
    const api = installApi()
    await renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }))
    })
    expect(api.export).toHaveBeenCalledTimes(1)
  })

  it('never surfaces an error when diagnostics export fails', async () => {
    const api = installApi(() => Promise.reject(new Error('disk full')))
    await renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }))
    })
    // The rejection is swallowed inside the handler; the button re-enables.
    expect(api.export).toHaveBeenCalledTimes(1)
    expect(
      (screen.getByRole('button', { name: 'Export diagnostics' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })
})
